import { describe, expect, it } from "vitest";
import type { ElementRef, ParsedIntent, ScreenGraph } from "../../shared/types";
import { buildPerceptionFrame, modelUsePolicy } from "./perception";

const wechatArticleIntent: ParsedIntent = {
  kind: "wechat_article_summary",
  targetApp: "wechat",
  source: { app: "wechat", kind: "official_account", name: "机械之心" },
  delivery: { app: "wechat", kind: "contact", name: "陈弘轩" },
  output: "message",
  rawInstruction: "打开机械之心公众号，阅读最新文章并发给陈弘轩"
};

describe("perception and model use policy", () => {
  it("does not call vision for a clear deterministic WeChat screen", () => {
    const frame = buildPerceptionFrame(wechatArticleIntent, screen(["微信", "通讯录", "新的朋友", "群聊", "标签", "公众号"]));

    expect(frame.pageType).toBe("wechat_contacts");
    expect(modelUsePolicy(wechatArticleIntent, frame).useVision).toBe(false);
    expect(modelUsePolicy(wechatArticleIntent, frame).useLlm).toBe(false);
  });

  it("calls vision and recovery LLM after repeated no-progress loops", () => {
    const frame = buildPerceptionFrame(wechatArticleIntent, screen(["微信", "通讯录", "新的朋友", "群聊", "标签", "公众号"]));
    const policy = modelUsePolicy(wechatArticleIntent, frame, { noProgressCount: 2, phase: "locate_source" });

    expect(policy.useVision).toBe(true);
    expect(policy.useLlm).toBe(true);
    expect(policy.modelRole).toBe("recovery");
  });

  it("uses both models for an unknown generic screen task", () => {
    const generic: ParsedIntent = {
      kind: "generic",
      targetApp: "unknown",
      output: "summary",
      rawInstruction: "看看当前屏幕"
    };
    const frame = buildPerceptionFrame(generic, screen(["设置", "无线局域网"], "com.apple.Preferences"));
    const policy = modelUsePolicy(generic, frame);

    expect(policy.useVision).toBe(true);
    expect(policy.useLlm).toBe(true);
    expect(policy.modelRole).toBe("route_rank");
  });
});

function screen(labels: string[], app = "com.tencent.xin"): ScreenGraph {
  return {
    app,
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
