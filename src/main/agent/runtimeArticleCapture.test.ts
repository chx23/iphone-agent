import { describe, expect, it } from "vitest";
import type { ParsedIntent, ScreenGraph } from "../../shared/types";
import { AgentRuntime } from "./runtime";
import type { ArticleCaptureState } from "./articleCapture";

function createRuntime(): AgentRuntime {
  return new AgentRuntime({
    getSettings: () => ({}) as never,
    getDevice: () => undefined,
    kuaijs: {} as never,
    control: {} as never,
    llm: {} as never
  });
}

function recentChatsScreen(): ScreenGraph {
  return {
    app: "com.tencent.xin",
    screenSize: { width: 1170, height: 2532 },
    orientation: "portrait",
    nodes: [
      { id: "title", source: "node", label: "微信", role: "XCUIElementTypeStaticText", bounds: { x: 48, y: 150, width: 160, height: 80 }, confidence: 0.9 },
      { id: "search", source: "node", label: "搜索", role: "XCUIElementTypeSearchField", bounds: { x: 48, y: 300, width: 1000, height: 96 }, confidence: 0.9 },
      { id: "chat", source: "node", label: "陈弘轩 我整理了机器之心最新文章摘要", role: "XCUIElementTypeStaticText", bounds: { x: 180, y: 520, width: 820, height: 90 }, confidence: 0.9 },
      { id: "tabbar", source: "node", label: "标签页栏", role: "XCUIElementTypeTabBar", bounds: { x: 0, y: 2200, width: 1170, height: 260 }, confidence: 0.9 },
      { id: "wechat", source: "node", label: "微信", role: "XCUIElementTypeButton", bounds: { x: 0, y: 2200, width: 292, height: 180 }, confidence: 0.9 },
      { id: "contacts", source: "node", label: "通讯录", role: "XCUIElementTypeButton", bounds: { x: 292, y: 2200, width: 292, height: 180 }, confidence: 0.9 }
    ],
    ocrBlocks: [],
    dialogs: [],
    keyboardVisible: false,
    observedAt: Date.now()
  };
}

const articleIntent: ParsedIntent = {
  kind: "wechat_article_summary",
  targetApp: "wechat",
  output: "message",
  contact: "陈弘轩",
  topic: "机械之心",
  source: { app: "wechat", kind: "official_account", name: "机械之心" },
  delivery: { app: "wechat", kind: "contact", name: "陈弘轩" },
  rawInstruction: "打开机械之心公众号，阅读最新文章，总结后发给陈弘轩"
};

describe("AgentRuntime article capture planning", () => {
  it("keeps scrolling by pixel diff once article capture has started, even if semantic surface detection would reject the screen", async () => {
    const runtime = createRuntime() as unknown as {
      articleCaptureState: ArticleCaptureState;
      plan: (intent: ParsedIntent, screen: ScreenGraph, stepIndex: number) => Promise<{ action: unknown; guardReason?: string }>;
    };
    runtime.articleCaptureState = {
      account: "机械之心",
      title: "Suno不再是唯一答案，企业开始选择这个国产AI音乐",
      articleId: "test-article",
      captureDir: "test-capture",
      frames: [],
      direction: "down",
      forwardSwipeCount: 12,
      reverseSwipeCount: 0,
      stableCount: 0,
      reverseAttempted: false,
      completed: false
    };

    const plan = await runtime.plan(articleIntent, recentChatsScreen(), 18);

    expect(plan.action).toEqual({ type: "collect_scroll", direction: "down", maxScrolls: 1 });
    expect(plan.guardReason).toBe("article_capture_pixel_diff_only");
  });
});
