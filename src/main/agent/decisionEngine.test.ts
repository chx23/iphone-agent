import { describe, expect, it } from "vitest";
import type { ElementRef, ParsedIntent, ScreenGraph } from "../../shared/types";
import { buildPerceptionFrame } from "./perception";
import { DecisionEngine, decisionSystemPrompt } from "./decisionEngine";

const engine = new DecisionEngine();

describe("DecisionEngine", () => {
  it("keeps the local WeChat skill plan when it is clear and not stuck", () => {
    const intent: ParsedIntent = {
      kind: "wechat_article_summary",
      targetApp: "wechat",
      source: { app: "wechat", kind: "official_account", name: "机械之心" },
      output: "message",
      rawInstruction: "打开机械之心公众号"
    };
    const frame = buildPerceptionFrame(intent, screen(["微信", "通讯录", "新的朋友", "群聊", "标签", "公众号"]));

    const decision = engine.decide({
      intent,
      frame,
      context: { phase: "locate_source", noProgressCount: 0 },
      stepIndex: 1,
      modelRole: undefined
    });

    expect(decision.trace.selectedSource).toBe("skill");
    expect(decision.action.type).toBe("tap_element");
    expect(decision.trace.modelUsed).toBe(false);
  });

  it("uses a recovery model suggestion after no progress", () => {
    const intent: ParsedIntent = {
      kind: "wechat_article_summary",
      targetApp: "wechat",
      source: { app: "wechat", kind: "official_account", name: "机械之心" },
      output: "message",
      rawInstruction: "打开机械之心公众号"
    };
    const frame = buildPerceptionFrame(intent, screen(["微信", "通讯录", "新的朋友", "群聊", "标签"]));

    const decision = engine.decide({
      intent,
      frame,
      context: { phase: "locate_source", noProgressCount: 2 },
      stepIndex: 3,
      modelRole: "recovery",
      modelDecision: {
        phase: "locate_source",
        selectedRoute: "wechat:recover_back",
        reasoningSummary: "当前通讯录入口没有继续变化，先返回稳定页面再重新找入口。",
        nextActionIntent: { kind: "back" },
        expectedScreenChange: "回到微信首页或上一级页面。",
        confidence: 0.72
      }
    });

    expect(decision.trace.selectedSource).toBe("recovery");
    expect(decision.action).toEqual({ type: "back" });
    expect(decision.trace.modelUsed).toBe(true);
  });

  it("accepts compact model decision JSON", () => {
    const intent: ParsedIntent = {
      kind: "generic",
      targetApp: "unknown",
      output: "summary",
      rawInstruction: "继续当前任务"
    };
    const frame = buildPerceptionFrame(intent, screen(["未知页面", "搜索", "键盘已弹出"]));

    const decision = engine.decide({
      intent,
      frame,
      context: { phase: "locate_source", noProgressCount: 2 },
      stepIndex: 3,
      modelRole: "recovery",
      modelDecision: {
        p: "locate_source",
        r: "generic:recover_back",
        why: "搜索栏卡住，先返回稳定页面。",
        a: { k: "back" },
        e: "回到上一级页面。",
        c: 0.74
      }
    });

    expect(decision.trace.selectedSource).toBe("recovery");
    expect(decision.action).toEqual({ type: "back" });
    expect(decision.route).toBe("generic:recover_back");
  });

  it("keeps the structured LLM prompt away from raw coordinate instructions", () => {
    const prompt = decisionSystemPrompt();

    expect(prompt).toContain("JSON only");
    expect(prompt).toContain("No raw coordinates");
    expect(prompt).toContain("\"a\"");
  });
});

function screen(labels: string[]): ScreenGraph {
  return {
    app: "com.tencent.xin",
    screenSize: { width: 1170, height: 2532 },
    orientation: "portrait",
    nodes: labels.map((label, index): ElementRef => ({
      id: `el_${index + 1}`,
      source: "node",
      label,
      role: "XCUIElementTypeStaticText",
      bounds: { x: 40, y: 100 + index * 120, width: 600, height: 80 },
      confidence: 0.86
    })),
    ocrBlocks: [],
    dialogs: [],
    keyboardVisible: false,
    observedAt: Date.now()
  };
}
