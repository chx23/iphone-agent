import { describe, expect, it } from "vitest";
import { LlmClient } from "../../llmClient";
import { VisionClient } from "../../visionClient";
import { loadLocalEnv } from "../../env";
import { decisionSystemPrompt, decisionUserPrompt, normalizeModelDecisionOutput, type ModelDecisionOutput } from "../decisionEngine";
import { buildPerceptionFrame } from "../perception";
import { fallbackPlan } from "../planner";
import { listVirtualScenarioIds, loadVirtualScenario, virtualLiveModelCases, virtualScreenFor } from "./scenarioLoader";
import type { VirtualLiveModelCase } from "./types";

loadLocalEnv();

const aiUrl = process.env.AI_API_URL ?? "https://llmapi.paratera.com/v1/chat/completions";
const aiModel = process.env.LANGUAGE_MODEL ?? "GLM-5-Turbo";
const visionUrl = process.env.VISION_API_URL ?? "https://llmapi.paratera.com/v1/chat/completions";
const visionModel = process.env.VISION_MODEL ?? "Qwen3-VL-235B-A22B-Instruct";

describe("virtual live model checks", () => {
  it("asks the real VLM to describe fixed synthetic phone screenshots", async () => {
    requireEnv("VISION_API_KEY");
    const scenarios = listVirtualScenarioIds().map(loadVirtualScenario);
    const cases = selectVisionSmokeCases(
      virtualLiveModelCases(scenarios),
      Number(process.env.PHONE_AGENT_VIRTUAL_LIVE_VISION_LIMIT ?? 4)
    );
    expect(cases.length).toBeGreaterThan(0);
    const client = new VisionClient(
      () => visionUrl,
      () => process.env.VISION_API_KEY,
      () => visionModel
    );

    for (const testCase of cases) {
      const mode = testCase.expectedPageType === "wechat_article" ? "full" : testCase.expectedPageType === "dialog" ? "elements" : "classify";
      const result = await client.describeScreen(testCase.imageBase64, {
        mode,
        maxBlocks: mode === "classify" ? 0 : 16,
        pageHints: [testCase.expectedPageType, "dialog", "login", "unknown"],
        timeoutMs: mode === "classify" ? 22000 : 35000
      });
      expect(result, `${testCase.scenarioId}/${testCase.frameId}`).toBeDefined();
      expect(result?.pageType, `${testCase.scenarioId}/${testCase.frameId}`).toBeTruthy();
      expect(result?.summary, `${testCase.scenarioId}/${testCase.frameId}`).toBeTruthy();
      expect(Array.isArray(result?.ocrBlocks), `${testCase.scenarioId}/${testCase.frameId}`).toBe(true);
    }
  }, 240_000);

  it("asks the real LLM for structured route recovery JSON", async () => {
    requireEnv("AI_API_KEY");
    const scenario = loadVirtualScenario("recovery-and-safety");
    const intent = {
      kind: "generic" as const,
      targetApp: "unknown" as const,
      output: "summary" as const,
      rawInstruction: "继续当前任务"
    };
    const screen = virtualScreenFor(scenario, "wechat_unknown_search");
    const frame = buildPerceptionFrame(intent, screen, { noProgressCount: 2 });
    const skillPlan = fallbackPlan(intent, screen, 3, { noProgressCount: 2, phase: "locate_source" });
    const client = new LlmClient(
      () => aiUrl,
      () => process.env.AI_API_KEY,
      () => aiModel
    );

    const raw = await client.completeJson<ModelDecisionOutput>(
      decisionSystemPrompt(),
      decisionUserPrompt({ intent, frame, context: { noProgressCount: 2, phase: "locate_source" }, skillPlan }),
      { mode: "recovery", timeoutMs: 60000, maxPromptChars: 4600 }
    );
    const result = normalizeModelDecisionOutput(raw);

    expect(result?.phase).toBeTruthy();
    expect(result?.selectedRoute).toBeTruthy();
    expect(result?.nextActionIntent?.kind).toBeTruthy();
    expect(typeof result?.confidence).toBe("number");
  }, 90_000);

  it("asks the real LLM for a concise single-message article summary", async () => {
    requireEnv("AI_API_KEY");
    const client = new LlmClient(
      () => aiUrl,
      () => process.env.AI_API_KEY,
      () => aiModel
    );
    const result = await client.completeJson<{ title?: string; summary?: string }>(
      virtualSummarySystemPrompt(),
      virtualSummaryUserPrompt("机器之心", {
        title: "具身智能来时路：从语言理解到真实动作控制",
        lines: [
          "作者指出，具身智能的核心不只是让模型会说话，而是让系统能在真实环境里理解目标并完成动作。",
          "文章回顾了从 SayCan、RT-1 到多模态机器人基础模型的发展路线。",
          "下一阶段的竞争重点会从单次 demo 转向持续评测、失败恢复和可维护的数据闭环。",
          "文章判断具身智能会先在封闭场景形成可复制能力，再逐步走向开放家庭和公共空间。"
        ]
      }),
      { timeoutMs: 90000 }
    );

    expect(result?.summary).toBeTruthy();
    expect(result!.summary!.length).toBeLessThanOrEqual(180);
    expect(result!.summary).not.toMatch(/[\r\n#*]/);
  }, 90_000);
});

function selectVisionSmokeCases(cases: VirtualLiveModelCase[], limit: number): VirtualLiveModelCase[] {
  const priority = ["phone_home", "wechat_article", "wechat_search", "dianping_results", "dialog", "login"];
  const selected: VirtualLiveModelCase[] = [];
  for (const pageType of priority) {
    const match = cases.find((testCase) => testCase.expectedPageType === pageType);
    if (match && !selected.includes(match)) selected.push(match);
    if (selected.length >= limit) return selected;
  }
  for (const testCase of cases) {
    if (!selected.includes(testCase)) selected.push(testCase);
    if (selected.length >= limit) return selected;
  }
  return selected;
}

function requireEnv(name: string): void {
  if (!process.env[name]) {
    throw new Error(`${name} is required for npm run test:virtual:live.`);
  }
}

function virtualSummarySystemPrompt(): string {
  return [
    "你是 phone-agent 的公众号文章总结器。",
    "根据已经读取到的正文，生成适合微信发送给朋友的一段中文总结。",
    "只输出 JSON；summary 必须基于正文，不编造；1-2 句，简明、通顺、不要换行、不要 Markdown。",
    "JSON 格式：{\"title\":\"文章标题\",\"summary\":\"80-150字总结\"}"
  ].join("\n");
}

function virtualSummaryUserPrompt(account: string, article: { title: string; lines: string[] }): string {
  return [
    `公众号：${account}`,
    `文章标题：${article.title}`,
    "已读取正文线索：",
    article.lines.map((line, index) => `${index + 1}. ${line}`).join("\n")
  ].join("\n");
}
