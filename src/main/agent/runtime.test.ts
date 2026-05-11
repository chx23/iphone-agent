import { describe, expect, it } from "vitest";
import { KuaijsRequestError } from "../kuaijsClient";
import { LlmRequestError } from "../llmClient";
import { buildScreenGraph } from "../screenGraph";
import type { ElementRef, ScreenGraph } from "../../shared/types";
import {
  buildWechatArticleSummaryMessageFromModel,
  buildWechatArticleSummaryMessage,
  extractWechatArticleText,
  humanizeFailure,
  isArticleReadComplete,
  preprocessWechatArticleForSummary,
  shouldUseDeterministicPlanner,
  shouldUseVisionForIntent,
  type ArticleReadState
} from "./runtime";

describe("agent runtime failure messages", () => {
  it("separates LLM authorization failures", () => {
    expect(humanizeFailure(new LlmRequestError("Nope", 401, "Unauthorized"))).toContain("模型 API Key");
  });

  it("separates IME authorization failures", () => {
    expect(humanizeFailure(new KuaijsRequestError("Denied", "/api/ime/input", 401, "Unauthorized", "bridge"))).toContain("API键盘");
  });

  it("formats WeChat article summaries as one send-safe message", () => {
    const message = buildWechatArticleSummaryMessage("机器之心", {
      title: "一篇机器学习文章",
      lines: [
        "2026年5月10日 10:00",
        "这篇文章讨论了新一代 AI 基础设施如何提升推理效率。",
        "团队同时公布了开源路线和商业化计划。"
      ]
    });

    expect(message).not.toMatch(/[\r\n]/);
    expect(message).toContain("简要总结");
    expect(message).toContain("AI 基础设施");
    expect(message).not.toContain("2026年5月10日");
  });

  it("uses model summaries as a concise readable paragraph", () => {
    const message = buildWechatArticleSummaryMessageFromModel("机器之心", {
      title: "具身智能来时路",
      lines: ["正文线索"]
    }, {
      summary: "文章回顾了机器人学习从语言理解走向真实动作控制的路线，核心是把大模型的语义能力和真实世界数据结合起来。它也提醒，当前演示进步很快，但稳定落地仍需要更可靠的数据、评测和工程化能力。"
    });

    expect(message).toBeDefined();
    expect(message).toContain("具身智能来时路");
    expect(message).toContain("真实动作控制");
    expect(message!.length).toBeLessThan(260);
    expect(message).not.toMatch(/[\r\n#*]/);
  });

  it("falls back to readable prose instead of raw clipped fragments", () => {
    const message = buildWechatArticleSummaryMessage("机器之心", {
      title: "具身智能来时路：谷歌RT1、2，SayCan作者Ted Xiao复盘机器人学习",
      lines: [
        "你可能觉得今年人形机器人的 demo 已经看麻了。但 Ted Xiao 说，哪怕是最粗糙的那一条，放在两年前都能让全场研究者惊掉下巴。",
        "曾任 Google DeepMind 的 Ted Xiao 回顾了 SayCan、RT-1 和 RT-2 背后的机器人学习路线。",
        "文章强调，具身智能要真正落地，还需要更大规模的数据、更稳定的评测和能在真实环境里泛化的系统。"
      ]
    });

    expect(message).toContain("机器人学习路线");
    expect(message.length).toBeLessThan(320);
    expect(message).not.toContain("1.");
    expect(message).not.toMatch(/[\r\n]/);
  });

  it("preprocesses local OCR and node text before summarization", () => {
    const prepared = preprocessWechatArticleForSummary("机器之心", {
      title: "具身智能来时路",
      lines: [
        "返回",
        "机器之心",
        "作者：机器之心编辑部",
        "第一段解释具身智能为什么不能只停留在语言理解",
        "而要能把目标拆成真实世界里的连续动作。",
        "第一段解释具身智能为什么不能只停留在语言理解而要能把目标拆成真实世界里的连续动作。",
        "点击阅读原文查看更多",
        ...Array.from({ length: 80 }, (_, index) => `第${index + 1}个有效观点说明数据、模型、评测和失败恢复如何共同影响机器人落地。`)
      ]
    });

    expect(prepared.originalLineCount).toBeGreaterThan(prepared.promptLineCount);
    expect(prepared.promptLineCount).toBeLessThanOrEqual(56);
    expect(prepared.promptCharCount).toBeLessThanOrEqual(5200);
    expect(prepared.lines.join(" ")).not.toContain("点击阅读原文");
    expect(prepared.lines.join("")).toContain("语言理解而要能把目标拆成真实世界里的连续动作");
  });

  it("does not treat a top navigation 阅读原文 label as article completion", () => {
    const article = extractWechatArticleText(articleScreen([
      articleNode("机器之心", 80),
      articleNode("2026年5月10日 10:00", 150),
      articleNode("专业的人工智能媒体和产业服务平台", 230),
      articleNode("这篇文章讨论了新一代 AI 基础设施如何提升推理效率。", 330),
      articleNode("团队同时公布了开源路线和商业化计划。", 430),
      articleNode("阅读原文", 90)
    ]), "机器之心");

    expect(article?.reachedEnd).toBe(false);
  });

  it("does not extract an article summary from the official account profile page", () => {
    const article = extractWechatArticleText(articleScreen([
      articleNode("机器之心", 80),
      articleNode("私信", 150),
      articleNode("已关注公众号", 220),
      articleNode("专业的人工智能媒体和产业服务平台", 300),
      articleNode("2991篇原创内容", 380),
      articleNode("视频号: 机器之心", 460),
      articleNode("活久见，时代少年团给大模型上了一课", 980)
    ]), "机器之心");

    expect(article).toBeUndefined();
  });

  it("keeps article detection when an article webview contains video or play labels", () => {
    const article = extractWechatArticleText(articleScreen([
      articleNode("XCUIElementTypeWebView", 0),
      articleNode("Suno不再是唯一答案，企业开始选择这个国产AI音乐", 80),
      articleNode("机器之心", 150),
      articleNode("2026年5月11日 12:09", 210),
      articleNode("机器之心发布", 270),
      articleNode("视频号: 机器之心", 330),
      articleNode("播放", 390),
      articleNode("在 AI 音乐行业，有一个正在悄悄发生的迁移，企业开始把工具链从通用生成转向更可控的音乐模型。", 460),
      articleNode("文章继续解释 Mureka 在段落控制、混音质量和人声表达上的升级，以及它为什么适合企业工作流。", 560),
      articleNode("赞 46", 1600),
      articleNode("分享 420", 1660),
      articleNode("在看 21", 1720),
      articleNode("留言 1", 1780)
    ]), "机器之心", true);

    expect(article).toBeDefined();
    expect(article?.title).toContain("Suno");
  });

  it("keeps article detection at the article end when the top back label says Contacts", () => {
    const article = extractWechatArticleText(articleScreen([
      articleNode("XCUIElementTypeWebView", 0),
      articleNode("通讯录", 150),
      articleNode("关闭", 150),
      articleNode("更多", 150),
      articleNode("Suno不再是唯一答案，企业开始选择这个国产AI音乐", 260),
      articleNode("机器之心", 340),
      articleNode("2026年5月11日 12:09", 410),
      articleNode("机器之心发布", 470),
      articleNode("在 AI 音乐行业，有一个正在悄悄发生的迁移，企业用户开始从通用生成转向更可控的音乐模型。", 620),
      articleNode("从能生成到能发布，再到让创作意图被真正听见，文章总结了国产 AI 音乐工具在企业场景中的变化。", 760),
      articleNode("© THE END", 1460),
      articleNode("已无更多数据", 1530),
      articleNode("阅读1.0万", 1640),
      articleNode("留言 1", 1720),
      articleNode("赞 48", 1800),
      articleNode("分享 435", 1880),
      articleNode("在看 22", 1960)
    ]), "机器之心", false);

    expect(article).toBeDefined();
    expect(article?.reachedEnd).toBe(true);
  });

  it("marks the article as read only when end evidence is visible near the reading area", () => {
    const article = extractWechatArticleText(articleScreen([
      articleNode("机器之心", 80),
      articleNode("2026年5月10日 10:00", 150),
      articleNode("专业的人工智能媒体和产业服务平台", 230),
      articleNode("这篇文章讨论了新一代 AI 基础设施如何提升推理效率。", 330),
      articleNode("团队同时公布了开源路线和商业化计划。", 430),
      articleNode("阅读原文", 1600)
    ]), "机器之心");

    expect(article?.reachedEnd).toBe(true);
  });

  it("does not treat hidden or offscreen article end markers as completion", () => {
    const article = extractWechatArticleText(articleScreen([
      articleNode("机器之心", 80),
      articleNode("2026年5月10日 10:00", 150),
      articleNode("这篇文章讨论了新一代 AI 基础设施如何提升推理效率。", 330),
      articleNode("团队同时公布了开源路线和商业化计划。", 430),
      { ...articleNode("阅读原文", 3200), clickable: false }
    ]), "机器之心");

    expect(article?.reachedEnd).toBe(false);
  });

  it("extracts an article when it opens near the end so reverse reading can begin", () => {
    const article = extractWechatArticleText(articleScreen([
      articleNode("这部分内容已经接近文章结尾，但仍然包含关键观点。", 360),
      articleNode("作者总结了机器人学习从早期尝试到基础模型路线的变化。", 460),
      articleNode("阅读原文", 1600),
      articleNode("写留言", 1720)
    ]), "机器之心");

    expect(article?.reachedEnd).toBe(true);
    expect(article?.reachedStart).toBe(false);
  });

  it("does not keep article continuation active on the WeChat recent chats list", () => {
    const recentChats = articleScreen([
      articleNode("微信", 160),
      articleNode("快捷操作", 170),
      articleNode("搜索", 220),
      articleNode("陈弘轩,我读了机器之心最新文章《具身智能来时路》,23:31", 560),
      articleNode("公众号,未读,[3条],新智元: 最新文章", 820),
      articleNode("标签页栏", 2250),
      articleNode("微信", 2300),
      articleNode("通讯录", 2300),
      articleNode("发现", 2300),
      articleNode("我", 2300)
    ]);
    const article = extractWechatArticleText(recentChats, "机器之心", true);

    expect(article).toBeUndefined();
  });

  it("rejects a real WeChat recent-chats node tree even when a previous summary mentions the account", () => {
    const screen = buildScreenGraph({
      source: `
        <XCUIElementTypeApplication label="微信" type="XCUIElementTypeApplication" x="0" y="0" width="1170" height="2532" visible="true" enabled="true" bundleId="com.tencent.xin">
          <XCUIElementTypeOther label="微信" x="524" y="153" width="123" height="108" visible="true" enabled="true" />
          <XCUIElementTypeButton label="快捷操作" x="989" y="141" width="132" height="132" visible="true" enabled="true" />
          <XCUIElementTypeSearchField label="搜索" x="0" y="59" width="1170" height="214" visible="true" enabled="true" />
          <XCUIElementTypeStaticText label="陈弘轩,我读了机器之心最新文章《RT-1 的意义不仅是性能》，23:31" x="0" y="520" width="1170" height="180" visible="true" enabled="true" />
          <XCUIElementTypeStaticText label="公众号,未读,[3条],新智元: 最新文章,22:23" x="0" y="760" width="1170" height="180" visible="true" enabled="true" />
          <XCUIElementTypeTabBar label="标签页栏" x="0" y="2212" width="1170" height="319" visible="true" enabled="true">
            <XCUIElementTypeButton label="微信" x="-3" y="2212" width="294" height="319" visible="true" enabled="true" />
            <XCUIElementTypeButton label="通讯录" x="291" y="2212" width="294" height="319" visible="true" enabled="true" />
            <XCUIElementTypeButton label="发现" x="585" y="2212" width="294" height="319" visible="true" enabled="true" />
            <XCUIElementTypeButton label="我" x="879" y="2212" width="294" height="319" visible="true" enabled="true" />
          </XCUIElementTypeTabBar>
        </XCUIElementTypeApplication>
      `
    });

    expect(extractWechatArticleText(screen, "机器之心", true)).toBeUndefined();
  });

  it("does not allow continuation mode on WeChat navigation surfaces", () => {
    const surfaces = [
      ["微信", "通讯录", "新的朋友", "群聊", "标签", "公众号", "陈弘轩"],
      ["微信", "公众号", "搜索", "新的公众号", "订阅号", "机器之心"],
      ["微信", "搜索本地或网络结果", "最近在搜", "机器之心"],
      ["微信", "WCFinder", "播放", "喜欢:12", "评论3"]
    ];

    for (const labels of surfaces) {
      expect(extractWechatArticleText(articleScreen(labels.map((label, index) => articleNode(label, 120 + index * 100))), "机器之心", true)).toBeUndefined();
    }
  });

  it("keeps reading content-heavy article screens until real end evidence appears", () => {
    const state: ArticleReadState = {
      account: "机器之心",
      title: "专业的人工智能媒体和产业服务平台",
      lines: Array.from({ length: 20 }, (_, index) => `正文线索 ${index}`),
      seenLines: new Set(),
      screenCount: 2,
      stableCount: 1,
      unchangedScrollCount: 1,
      reachedEnd: false,
      reachedStart: true,
      direction: "down",
      reverseAttempted: false
    };

    expect(isArticleReadComplete(state)).toBe(false);
  });

  it("keeps reverse-reading when an article opens at the end until the start is reached", () => {
    const state: ArticleReadState = {
      account: "机器之心",
      title: "最新文章",
      lines: Array.from({ length: 12 }, (_, index) => `倒读正文线索 ${index}`),
      seenLines: new Set(),
      screenCount: 3,
      stableCount: 0,
      unchangedScrollCount: 0,
      reachedEnd: true,
      reachedStart: false,
      direction: "up",
      reverseAttempted: true
    };

    expect(isArticleReadComplete(state)).toBe(false);
    expect(isArticleReadComplete({ ...state, reachedStart: true })).toBe(false);
    expect(isArticleReadComplete({ ...state, reachedStart: true, stableCount: 3, unchangedScrollCount: 3 })).toBe(true);
  });

  it("uses deterministic planning for WeChat reading and sending flows", () => {
    expect(shouldUseDeterministicPlanner({ kind: "wechat_article_summary", targetApp: "wechat", output: "message", rawInstruction: "读公众号" })).toBe(true);
    expect(shouldUseDeterministicPlanner({ kind: "wechat_message", targetApp: "wechat", output: "message", rawInstruction: "发微信" })).toBe(true);
    expect(shouldUseDeterministicPlanner({ kind: "dianping_food_search", targetApp: "dianping", output: "recommendation", rawInstruction: "搜美食" })).toBe(false);
  });

  it("skips vision for deterministic WeChat flows when the node tree is useful", () => {
    const graph = articleScreen([
      articleNode("微信", 80),
      articleNode("通讯录", 160),
      articleNode("新的朋友", 240),
      articleNode("群聊", 320),
      articleNode("标签", 400),
      articleNode("公众号", 480)
    ]);
    graph.rawSource = "<AppiumAUT><XCUIElementTypeStaticText name=\"微信\" /></AppiumAUT>";

    expect(shouldUseVisionForIntent({ kind: "wechat_article_summary", targetApp: "wechat", output: "message", rawInstruction: "读公众号" }, graph)).toBe(false);
    expect(shouldUseVisionForIntent({ kind: "generic", targetApp: "unknown", output: "summary", rawInstruction: "看看屏幕" }, graph)).toBe(true);
  });

  it("does not finish on an end marker before enough forward screens are sampled", () => {
    const state: ArticleReadState = {
      account: "machine-heart",
      title: "latest article",
      lines: Array.from({ length: 12 }, (_, index) => `article line ${index}`),
      seenLines: new Set(),
      screenCount: 5,
      stableCount: 0,
      unchangedScrollCount: 0,
      reachedEnd: true,
      reachedStart: true,
      direction: "down",
      reverseAttempted: false
    };

    expect(isArticleReadComplete(state)).toBe(false);
    expect(isArticleReadComplete({ ...state, stableCount: 3, unchangedScrollCount: 3 })).toBe(false);
    expect(isArticleReadComplete({ ...state, screenCount: 6 })).toBe(true);
  });

  it("treats repeated unchanged forward screens as the article bottom after enough reading", () => {
    const state: ArticleReadState = {
      account: "machine-heart",
      title: "latest article",
      lines: Array.from({ length: 16 }, (_, index) => `article line ${index}`),
      seenLines: new Set(),
      screenCount: 8,
      stableCount: 3,
      unchangedScrollCount: 3,
      reachedEnd: false,
      reachedStart: true,
      direction: "down",
      reverseAttempted: false
    };

    expect(isArticleReadComplete(state)).toBe(true);
  });
});

function articleScreen(nodes: ElementRef[]): ScreenGraph {
  return {
    app: "com.tencent.xin",
    screenSize: { width: 1179, height: 2556 },
    orientation: "portrait",
    nodes,
    ocrBlocks: [],
    dialogs: [],
    keyboardVisible: false,
    observedAt: Date.now()
  };
}

function articleNode(label: string, y: number): ElementRef {
  return {
    id: `el_${label}_${y}`,
    source: "node",
    label,
    bounds: { x: 60, y, width: 900, height: 48 },
    confidence: 0.86
  };
}
