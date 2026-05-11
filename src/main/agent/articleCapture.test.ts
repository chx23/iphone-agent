import { describe, expect, it } from "vitest";
import {
  ARTICLE_PIXEL_DIFF_THRESHOLD,
  ARTICLE_REVERSE_TRIGGER_SCROLLS,
  ARTICLE_STABLE_DIFF_COUNT,
  orderedArticleCaptureFrames,
  shouldCompleteArticleCapture,
  shouldUseReverseReading,
  type ArticleCaptureState
} from "./articleCapture";
import { normalizeCapturedOcrLines } from "./runtime";

describe("article capture pixel-diff reading policy", () => {
  it("treats three consecutive low-diff frames as a boundary", () => {
    expect(shouldCompleteArticleCapture(ARTICLE_STABLE_DIFF_COUNT - 1)).toBe(false);
    expect(shouldCompleteArticleCapture(ARTICLE_STABLE_DIFF_COUNT)).toBe(true);
  });

  it("starts reverse reading only when low diff appears in the first ten forward scrolls", () => {
    expect(shouldUseReverseReading(1, ARTICLE_PIXEL_DIFF_THRESHOLD - 0.001, false)).toBe(true);
    expect(shouldUseReverseReading(ARTICLE_REVERSE_TRIGGER_SCROLLS, 0, false)).toBe(true);
    expect(shouldUseReverseReading(ARTICLE_REVERSE_TRIGGER_SCROLLS + 1, 0, false)).toBe(false);
    expect(shouldUseReverseReading(3, ARTICLE_PIXEL_DIFF_THRESHOLD + 0.001, false)).toBe(false);
    expect(shouldUseReverseReading(3, 0, true)).toBe(false);
  });

  it("orders reverse-read screenshots from article top to bottom", () => {
    const state: ArticleCaptureState = {
      account: "machine-heart",
      title: "article",
      articleId: "article-1",
      captureDir: "capture",
      direction: "up",
      forwardSwipeCount: 2,
      reverseSwipeCount: 3,
      stableCount: 3,
      reverseAttempted: true,
      completed: true,
      stopReason: "top_stable_after_reverse",
      frames: [
        frame(0, "bottom-a.jpg", "down"),
        frame(1, "bottom-b.jpg", "down"),
        frame(2, "middle.jpg", "up"),
        frame(3, "top.jpg", "up")
      ]
    };

    expect(orderedArticleCaptureFrames(state).map((item) => item.path)).toEqual([
      "top.jpg",
      "middle.jpg",
      "bottom-a.jpg",
      "bottom-b.jpg"
    ]);
  });

  it("normalizes local OCR lines and removes navigation noise", () => {
    const lines = normalizeCapturedOcrLines([
      "返 回",
      "测 试 O C R 正 文 第 一 段 介 绍 AI 音 乐 平 台 的 企 业 应 用",
      "测 试 O C R 正 文 第 一 段 介 绍 AI 音 乐 平 台 的 企 业 应 用",
      "阅读原文",
      "第 二 段 说 明 模 型 、 数 据 和 产 品 化 流 程 的 变 化"
    ]);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("测试OCR正文第一段介绍AI音乐平台的企业应用");
    expect(lines.join(" ")).not.toContain("阅读原文");
  });
});

function frame(index: number, path: string, direction: "down" | "up") {
  return {
    index,
    path,
    format: "jpg" as const,
    direction,
    capturedAt: Date.now(),
    lowDiff: false,
    nodeTextLines: []
  };
}
