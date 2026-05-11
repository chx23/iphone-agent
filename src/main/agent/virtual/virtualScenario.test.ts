import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assessRisk } from "../riskPolicy";
import { planNextAction } from "../planner";
import { detectWechatArticleSurface } from "../wechatArticleSurface";
import { buildPerceptionFrame, modelUsePolicy } from "../perception";
import { listVirtualScenarioIds, loadVirtualScenario, virtualFixturePath, virtualScreenFor } from "./scenarioLoader";
import { runVirtualScenario, VirtualModelHarness, VirtualScenarioSession } from "./virtualHarness";

describe("virtual phone scenarios", () => {
  it("opens WeChat from the synthetic phone desktop", async () => {
    const scenario = loadVirtualScenario("open-wechat");
    const result = await runVirtualScenario(scenario);

    expect(result.state).toBe("finished");
    expect(result.finalFrameId).toBe("wechat_recent");
    expect(result.actions).toContainEqual(expect.objectContaining({ type: "open_app", bundleId: "com.tencent.xin" }));
    expect(result.diagnostics.some((event) => event.action === "decide" && event.decisionTrace)).toBe(true);
    expect(result.diagnostics.some((event) => event.action === "verify" && event.verification?.ok)).toBe(true);
  });

  it("reads a WeChat article fixture and sends the summary as one message", async () => {
    const scenario = loadVirtualScenario("wechat-article-summary-send");
    const result = await runVirtualScenario(scenario);

    expect(result.state).toBe("finished");
    expect(result.finalFrameId).toBe("wechat_chat_sent");
    expect(result.actions.some((action) => action.type === "collect_scroll")).toBe(true);
    expect(result.actions.some((action) => action.type === "input" && !/[\r\n]/.test(action.text))).toBe(true);
    expect(result.actions.some((action) => action.type === "tap_xy")).toBe(true);
    expect(result.diagnostics.some((event) => event.modelRole === "summarize")).toBe(true);
    expect(result.diagnostics.some((event) => event.decisionTrace?.candidates.some((candidate) => candidate.route === "wechat:contacts"))).toBe(true);
  }, 60_000);

  it("scans all WeChat account articles within 48 hours and sends one segmented digest", async () => {
    const scenario = loadVirtualScenario("wechat-multi-article-digest-48h");
    const result = await runVirtualScenario(scenario, { timeoutMs: 80_000 });
    const finalDigest = result.diagnostics.find((event) => event.action === "finalDigestMessage");

    expect(result.state).toBe("finished");
    expect(result.finalFrameId).toBe("wechat_chat_sent");
    expect(result.actions.filter((action) => action.type === "collect_scroll").length).toBeGreaterThanOrEqual(5);
    expect(result.actions.filter((action) => action.type === "tap_text")).toHaveLength(3);
    expect(result.actions.some((action) => action.type === "input" && action.text.includes("我整理了机器之心近48小时的更新"))).toBe(true);
    expect(finalDigest?.payload).toMatchObject({ articleCount: 3, skippedOldCount: 1 });
    expect((finalDigest?.payload as { finalDigestMessage?: string } | undefined)?.finalDigestMessage).toContain("共3篇");
  }, 90_000);

  it("runs the generated official-account screenshot set through another 48-hour scan", async () => {
    const scenario = loadVirtualScenario("wechat-multi-article-generated-48h");
    const result = await runVirtualScenario(scenario, { timeoutMs: 80_000 });
    const finalDigest = result.diagnostics.find((event) => event.action === "finalDigestMessage");

    expect(result.state).toBe("finished");
    expect(result.finalFrameId).toBe("wechat_chat_sent");
    expect(result.actions.filter((action) => action.type === "collect_scroll").length).toBeGreaterThanOrEqual(4);
    expect(result.actions.filter((action) => action.type === "tap_text")).toHaveLength(4);
    expect(finalDigest?.payload).toMatchObject({ articleCount: 4, skippedOldCount: 2 });
    expect((finalDigest?.payload as { finalDigestMessage?: string } | undefined)?.finalDigestMessage).toContain("共4篇");
  }, 90_000);

  it("does not enter article reading from a recent-chat list that mentions old summaries", () => {
    const scenario = loadVirtualScenario("wechat-article-summary-send");
    const screen = virtualScreenFor(scenario, "wechat_recent");
    const plan = planNextAction({
      kind: "wechat_article_summary",
      targetApp: "wechat",
      source: { app: "wechat", kind: "official_account", name: "机器之心" },
      delivery: { app: "wechat", kind: "contact", name: "陈弘轩" },
      output: "message",
      rawInstruction: scenario.instruction
    }, screen, 1);

    expect(plan.action.type).toBe("tap_element");
    expect(plan.phase).toBe("locate_source");
    expect(plan.route).toBe("wechat:contacts_preferred");
  });

  it("keeps reading article middle screens and only finishes at the bottom", () => {
    const scenario = loadVirtualScenario("wechat-article-summary-send");
    const intent = {
      kind: "wechat_article_summary" as const,
      targetApp: "wechat" as const,
      source: { app: "wechat" as const, kind: "official_account" as const, name: "机器之心" },
      delivery: { app: "wechat" as const, kind: "contact" as const, name: "陈弘轩" },
      output: "message" as const,
      rawInstruction: scenario.instruction
    };

    const middle = detectWechatArticleSurface(virtualScreenFor(scenario, "article_mid_2"), intent.source.name, true);
    const bottom = detectWechatArticleSurface(virtualScreenFor(scenario, "article_bottom"), intent.source.name, true);

    expect(middle.ok).toBe(true);
    expect(middle.articleText?.reachedEnd).toBe(false);
    expect(bottom.ok).toBe(true);
    expect(bottom.articleText?.reachedEnd).toBe(true);
  });

  it("uses virtual Dianping screens to go from home search to result draft", async () => {
    const scenario = loadVirtualScenario("dianping-food-search");
    const result = await runVirtualScenario(scenario);

    expect(result.state).toBe("finished");
    expect(result.finalFrameId).toBe("dianping_results");
    expect(result.actions).toContainEqual(expect.objectContaining({ type: "open_app", bundleId: "com.dianping.dpscope" }));
    expect(result.actions.some((action) => action.type === "input" && action.text.includes("附近美食"))).toBe(true);
  });

  it("triggers VLM and recovery LLM for an unknown stuck search surface", () => {
    const scenario = loadVirtualScenario("recovery-and-safety");
    const screen = virtualScreenFor(scenario, "wechat_unknown_search");
    const frame = buildPerceptionFrame({
      kind: "generic",
      targetApp: "unknown",
      output: "summary",
      rawInstruction: "继续当前任务"
    }, screen, { noProgressCount: 2 });

    const policy = modelUsePolicy(undefined, frame, { noProgressCount: 2 });

    expect(frame.pageType).toBe("wechat_search");
    expect(policy.useVision).toBe(true);
    expect(policy.useLlm).toBe(true);
    expect(policy.modelRole).toBe("recovery");
  });

  it("blocks risky payment-style actions and confirms non-whitelisted message sending", () => {
    const risky = assessRisk({
      action: { type: "tap_text", text: "立即支付" },
      intent: { kind: "generic", targetApp: "wechat", output: "summary", rawInstruction: "帮我付款" },
      whitelist: [],
      advancedAutoMode: false
    });
    const nonWhitelist = assessRisk({
      action: { type: "input", text: "晚上吃什么" },
      intent: {
        kind: "wechat_message",
        targetApp: "wechat",
        delivery: { app: "wechat", kind: "contact", name: "陌生人" },
        contact: "陌生人",
        query: "晚上吃什么",
        output: "message",
        rawInstruction: "问问陌生人晚上吃什么"
      },
      whitelist: [],
      advancedAutoMode: false
    });

    expect(risky.decision).toBe("confirm");
    expect(nonWhitelist.decision).toBe("confirm");
  });

  it("loads expanded virtual fixtures for recovery, safety, permissions, and generic apps", () => {
    const ids = listVirtualScenarioIds();
    expect(ids.length).toBeGreaterThanOrEqual(12);
    expect(ids).toEqual(expect.arrayContaining([
      "wechat-recovery-expanded",
      "wechat-article-edge-cases",
      "wechat-send-draft",
      "permissions-login-network",
      "dianping-expanded",
      "generic-app-recovery",
      "safety-risk-surfaces",
      "model-stress-surfaces"
    ]));

    const tags = new Set(ids.flatMap((id) => loadVirtualScenario(id).tags ?? []));
    expect([...tags]).toEqual(expect.arrayContaining(["recovery", "safety", "dialog", "generic", "reverse_read"]));
  });

  it("uses article surface gates for account home and reverse-read article frames", () => {
    const scenario = loadVirtualScenario("wechat-article-edge-cases");
    const accountHome = detectWechatArticleSurface(virtualScreenFor(scenario, "wechat_account_empty_top"), "机械之心", false);
    const endOpen = detectWechatArticleSurface(virtualScreenFor(scenario, "wechat_article_end_open"), "机械之心", true);

    expect(accountHome.ok).toBe(false);
    expect(accountHome.reason).toBe("wechat_account_home");
    expect(endOpen.ok).toBe(true);
    expect(endOpen.articleText?.reachedEnd).toBe(true);
    expect(endOpen.articleText?.reachedStart).toBe(false);
  });

  it("models virtual slow and invalid model behavior without touching the real phone", async () => {
    const slow = new VirtualModelHarness(new VirtualScenarioSession(loadVirtualScenario("permissions-login-network")));
    await expect(slow.vision.describeScreen()).resolves.toBeDefined();

    const badJson = new VirtualModelHarness(new VirtualScenarioSession(loadVirtualScenario("generic-app-recovery")));
    await expect(badJson.llm.completeJson("route")).rejects.toThrow(/invalid JSON/);

    const timeout = new VirtualModelHarness(new VirtualScenarioSession(loadVirtualScenario("model-stress-surfaces")));
    await expect(timeout.vision.describeScreen()).rejects.toThrow(/timeout/);
  });
});

describe("virtual fixture quality", () => {
  it("keeps committed screenshots small PNG files", () => {
    const imageDir = virtualFixturePath("images");
    const images = readdirSync(imageDir).filter((name) => name.endsWith(".png"));

    expect(images.length).toBeGreaterThanOrEqual(45);
    const totalBytes = images.reduce((sum, image) => sum + statSync(join(imageDir, image)).size, 0);
    expect(totalBytes).toBeLessThan(2_500_000);
    for (const image of images) {
      const fullPath = join(imageDir, image);
      const header = readFileSync(fullPath).subarray(0, 8).toString("hex");
      expect(header).toBe("89504e470d0a1a0a");
      expect(statSync(fullPath).size).toBeLessThan(350_000);
    }
  });

  it("keeps virtual Chinese text readable instead of mojibake", () => {
    const fixtureDir = virtualFixturePath();
    const texts = readdirSync(fixtureDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readFileSync(join(fixtureDir, name), "utf8"))
      .join("\n");
    const sourceTexts = [
      readFileSync("src/main/headless.ts", "utf8"),
      readFileSync("src/main/agent/intent.ts", "utf8"),
      readFileSync("src/main/agent/planner.ts", "utf8"),
      readFileSync("src/main/agent/runtime.ts", "utf8")
    ].join("\n");

    expect(texts).toContain("微信");
    expect(texts).toContain("机械之心");
    expect(texts).toContain("大众点评");
    expect(sourceTexts).toContain("Usage:");
    expect(sourceTexts).toContain("打开微信");
    expect(`${texts}\n${sourceTexts}`).not.toMatch(/[\uE000-\uF8FF\uFFFD]/u);
  });
});
