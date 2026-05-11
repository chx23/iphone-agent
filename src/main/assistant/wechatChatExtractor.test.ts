import { describe, expect, it } from "vitest";
import type { ElementRef, ScreenGraph } from "../../shared/types";
import { extractWechatChatMessages, isMonitorChatScreen, latestIncomingMessage } from "./wechatChatExtractor";

describe("wechat chat extractor", () => {
  it("extracts incoming messages and ignores outgoing messages as commands", () => {
    const screen = chatScreen([
      node("返回", 48, 141),
      node("陈弘轩", 491, 153),
      node("更多", 1038, 141),
      node("我,收到，我开始处理。", 620, 880),
      node("帮我读机械之心最新文章，总结发给我", 120, 1120),
      node("XCUIElementTypeTextView", 260, 2300, "XCUIElementTypeTextView")
    ]);

    expect(isMonitorChatScreen(screen, "陈弘轩")).toBe(true);
    const messages = extractWechatChatMessages(screen, "陈弘轩");
    expect(messages.map((message) => message.direction)).toEqual(["outgoing", "incoming"]);
    expect(latestIncomingMessage(screen, "陈弘轩")?.text).toBe("帮我读机械之心最新文章，总结发给我");
  });

  it("does not extract messages outside the monitored chat", () => {
    const screen = chatScreen([
      node("返回", 48, 141),
      node("张三", 491, 153),
      node("更多", 1038, 141),
      node("帮我查资料", 120, 1120)
    ]);

    expect(isMonitorChatScreen(screen, "陈弘轩")).toBe(false);
    expect(extractWechatChatMessages(screen, "陈弘轩")).toEqual([]);
  });
});

function chatScreen(nodes: ElementRef[]): ScreenGraph {
  return {
    app: "com.tencent.xin",
    screenSize: { width: 1170, height: 2532 },
    orientation: "portrait",
    nodes,
    ocrBlocks: [],
    dialogs: [],
    keyboardVisible: false,
    observedAt: Date.now()
  };
}

function node(label: string, x: number, y: number, role = "XCUIElementTypeStaticText"): ElementRef {
  return {
    id: label,
    source: "node",
    label,
    role,
    bounds: { x, y, width: 260, height: 60 },
    confidence: 0.86,
    clickable: true
  };
}
