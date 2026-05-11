import { describe, expect, it } from "vitest";
import {
  composeMultiArticleDigestMessage,
  createArticleListScanState,
  extractWechatArticleListItems,
  isArticleListScanComplete,
  parseWechatArticlePublishTime,
  updateArticleListScanState
} from "./multiArticleDigest";
import { loadVirtualScenario, virtualScreenFor } from "./virtual/scenarioLoader";

describe("multi-article WeChat digest helpers", () => {
  const now = new Date(2026, 4, 11, 20, 0, 0);

  it("parses common WeChat publish time labels", () => {
    expect(parseWechatArticlePublishTime("今天 09:30", now)?.getDate()).toBe(11);
    expect(parseWechatArticlePublishTime("昨天 21:20", now)?.getDate()).toBe(10);
    expect(parseWechatArticlePublishTime("48小时前", now)?.getTime()).toBe(now.getTime() - 48 * 60 * 60 * 1000);
    expect(parseWechatArticlePublishTime("5月10日 22:30", now)?.getMonth()).toBe(4);
  });

  it("extracts visible article cards and marks the 48-hour window", () => {
    const scenario = loadVirtualScenario("wechat-multi-article-digest-48h");
    const screen = virtualScreenFor(scenario, "list_yesterday");
    const items = extractWechatArticleListItems(screen, "机器之心", now, 48);

    expect(items.some((item) => item.title.includes("AI开源项目周报") && item.withinWindow)).toBe(true);
    expect(items.some((item) => item.title.includes("旧文") && !item.withinWindow)).toBe(true);
  });

  it("requires one extra confirmation screen after seeing old articles", () => {
    const scenario = loadVirtualScenario("wechat-multi-article-digest-48h");
    const state = createArticleListScanState("机器之心", now, 48);

    updateArticleListScanState(state, virtualScreenFor(scenario, "list_today"));
    expect(isArticleListScanComplete(state)).toBe(false);
    updateArticleListScanState(state, virtualScreenFor(scenario, "list_yesterday"));
    expect(state.sawOldBoundary).toBe(true);
    expect(isArticleListScanComplete(state)).toBe(false);
    updateArticleListScanState(state, virtualScreenFor(scenario, "list_confirm"));

    expect(isArticleListScanComplete(state)).toBe(true);
    expect(state.items.map((item) => item.title)).toEqual([
      "大模型评测进入下一阶段",
      "具身智能来时路：从语言理解到真实动作控制",
      "AI开源项目周报：多模态与端侧部署继续升温"
    ]);
  });

  it("scans heavy lists across multiple screens before the old boundary confirmation", () => {
    const scenario = loadVirtualScenario("wechat-multi-article-heavy-48h");
    const state = createArticleListScanState("机器之心", now, 48);
    for (const frameId of ["heavy_list_1", "heavy_list_2", "heavy_list_3", "heavy_list_4", "heavy_list_5"]) {
      updateArticleListScanState(state, virtualScreenFor(scenario, frameId));
      expect(isArticleListScanComplete(state)).toBe(false);
    }
    updateArticleListScanState(state, virtualScreenFor(scenario, "heavy_list_confirm"));

    expect(isArticleListScanComplete(state)).toBe(true);
    expect(state.items.length).toBe(9);
    expect(state.skippedOldItems.length).toBeGreaterThanOrEqual(2);
  });

  it("composes one segmented outbound message", () => {
    const message = composeMultiArticleDigestMessage("机器之心", [
      { title: "具身智能来时路", summary: "文章梳理了具身智能从语言理解走向真实动作控制的路线。", sourceLines: [] },
      { title: "大模型评测进入下一阶段", summary: "文章认为评测正在从榜单分数转向真实任务稳定性。", sourceLines: [] }
    ], "陈弘轩");

    expect(message).toContain("我整理了机器之心近48小时的更新，共2篇。");
    expect(message).toContain("1.《具身智能来时路》");
    expect(message).toContain("2.《大模型评测进入下一阶段》");
    expect(message).not.toMatch(/[\r\n]/);
  });
});
