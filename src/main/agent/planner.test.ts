import { describe, expect, it } from "vitest";
import type { ParsedIntent, ScreenGraph } from "../../shared/types";
import { planNextAction } from "./planner";

const baseIntent: ParsedIntent = {
  kind: "wechat_message",
  targetApp: "wechat",
  contact: "陈弘轩",
  query: "晚上吃什么",
  output: "message",
  rawInstruction: "打开微信，问问陈弘轩晚上吃什么"
};

const articleIntent: ParsedIntent = {
  kind: "wechat_article_summary",
  targetApp: "wechat",
  contact: "陈弘轩",
  topic: "机器之心",
  output: "message",
  rawInstruction: "打开机器之心公众号，阅读最新文章，总结后发给陈弘轩"
};

const openWechatIntent: ParsedIntent = {
  kind: "generic",
  targetApp: "wechat",
  output: "summary",
  rawInstruction: "打开微信"
};

function screen(labels: string[], app = "com.tencent.xin"): ScreenGraph {
  return {
    app,
    orientation: "portrait",
    nodes: labels.map((label, index) => ({
      id: `el_${index + 1}`,
      source: "node" as const,
      label,
      role: label.includes("搜索") ? "XCUIElementTypeTextView" : "XCUIElementTypeStaticText",
      bounds: { x: 10, y: 20 + index * 40, width: 200, height: 30 },
      confidence: 0.86
    })),
    ocrBlocks: [],
    dialogs: [],
    keyboardVisible: false,
    observedAt: Date.now()
  };
}

function chatScreen(labels: string[], keyboardVisible = false): ScreenGraph {
  return {
    app: "com.tencent.xin",
    screenSize: { width: 1170, height: 2532 },
    orientation: "portrait",
    nodes: labels.map((label, index) => ({
      id: `el_${index + 1}`,
      source: "node" as const,
      label,
      role: label === "晚上吃什么" || label === "XCUIElementTypeTextView" ? "XCUIElementTypeTextView" : "XCUIElementTypeStaticText",
      bounds: label === "XCUIElementTypeTextView"
        ? { x: 162, y: 2261, width: 735, height: 117 }
        : { x: 10, y: 20 + index * 40, width: 200, height: 30 },
      confidence: 0.86
    })),
    ocrBlocks: [],
    dialogs: [],
    keyboardVisible,
    observedAt: Date.now()
  };
}

function searchScreenWithQuery(query: string): ScreenGraph {
  return {
    app: "com.tencent.xin",
    orientation: "portrait",
    nodes: [
      { id: "el_1", source: "node", label: "微信", role: "XCUIElementTypeStaticText", bounds: { x: 0, y: 0, width: 100, height: 40 }, confidence: 0.86 },
      { id: "el_2", source: "node", label: query, role: "XCUIElementTypeTextView", bounds: { x: 240, y: 232, width: 760, height: 77 }, confidence: 0.86 },
      { id: "el_3", source: "node", label: "清除文本", role: "XCUIElementTypeButton", bounds: { x: 1024, y: 232, width: 74, height: 74 }, confidence: 0.86 },
      { id: "el_4", source: "node", label: "最近在搜", role: "XCUIElementTypeStaticText", bounds: { x: 48, y: 678, width: 238, height: 78 }, confidence: 0.86 }
    ],
    ocrBlocks: [],
    dialogs: [],
    keyboardVisible: true,
    observedAt: Date.now()
  };
}

function officialAccountSearchResultScreen(account = "机器之心"): ScreenGraph {
  return {
    app: "com.tencent.xin",
    orientation: "portrait",
    nodes: [
      { id: "el_1", source: "node", label: "微信", role: "XCUIElementTypeStaticText", bounds: { x: 0, y: 0, width: 100, height: 40 }, confidence: 0.86 },
      { id: "el_2", source: "node", label: account, role: "XCUIElementTypeSearchField", bounds: { x: 156, y: 207, width: 506, height: 85 }, confidence: 0.86 },
      { id: "el_3", source: "node", label: "搜索本地或网络结果", role: "XCUIElementTypeStaticText", bounds: { x: 40, y: 420, width: 400, height: 48 }, confidence: 0.86 },
      { id: "el_4", source: "node", label: "公众号", role: "XCUIElementTypeStaticText", bounds: { x: 48, y: 520, width: 160, height: 60 }, confidence: 0.86 },
      { id: "el_5", source: "node", label: account, role: "XCUIElementTypeStaticText", bounds: { x: 260, y: 650, width: 260, height: 72 }, confidence: 0.86 }
    ],
    ocrBlocks: [],
    dialogs: [],
    keyboardVisible: false,
    observedAt: Date.now()
  };
}

function searchNoResultScreen(query: string): ScreenGraph {
  return {
    app: "com.tencent.xin",
    orientation: "portrait",
    nodes: [
      { id: "el_1", source: "node", label: "微信", role: "XCUIElementTypeStaticText", bounds: { x: 0, y: 0, width: 100, height: 40 }, confidence: 0.86 },
      { id: "el_2", source: "node", label: query, role: "XCUIElementTypeSearchField", bounds: { x: 156, y: 207, width: 506, height: 85 }, confidence: 0.86 },
      { id: "el_3", source: "node", label: "清除文本", role: "XCUIElementTypeButton", bounds: { x: 662, y: 213, width: 73, height: 73 }, confidence: 0.86 },
      { id: "el_4", source: "node", label: "搜索", role: "XCUIElementTypeButton", bounds: { x: 760, y: 173, width: 190, height: 152 }, confidence: 0.86 },
      { id: "el_5", source: "node", label: "暂无朋友圈相关结果", role: "XCUIElementTypeStaticText", bounds: { x: 300, y: 900, width: 560, height: 80 }, confidence: 0.86 },
      { id: "el_6", source: "node", label: "取消", role: "XCUIElementTypeButton", bounds: { x: 987, y: 172, width: 135, height: 154 }, confidence: 0.86 }
    ],
    ocrBlocks: [],
    dialogs: [],
    keyboardVisible: false,
    observedAt: Date.now()
  };
}

function draftChatScreen(contact: string, message: string, rawValue = message): ScreenGraph {
  return {
    app: "com.tencent.xin",
    screenSize: { width: 1170, height: 2532 },
    orientation: "portrait",
    nodes: [
      { id: "el_1", source: "node", label: "\u5fae\u4fe1", role: "XCUIElementTypeStaticText", bounds: { x: 0, y: 0, width: 100, height: 40 }, confidence: 0.86 },
      { id: "el_2", source: "node", label: contact, role: "XCUIElementTypeStaticText", bounds: { x: 491, y: 153, width: 186, height: 108 }, confidence: 0.86 },
      { id: "el_3", source: "node", label: message.slice(0, 100), role: "XCUIElementTypeTextView", bounds: { x: 162, y: 897, width: 735, height: 574 }, confidence: 0.86 },
      { id: "el_4", source: "node", label: "\u53d1\u9001", role: "XCUIElementTypeButton", bounds: { x: 877, y: 2166, width: 291, height: 138 }, confidence: 0.86 }
    ],
    ocrBlocks: [],
    dialogs: [],
    keyboardVisible: true,
    rawSource: `<XCUIElementTypeTextView type="XCUIElementTypeTextView" value="${rawValue}" x="162" y="897" width="735" height="574"></XCUIElementTypeTextView>`,
    observedAt: Date.now()
  };
}

describe("planNextAction", () => {
  it("finishes a simple open WeChat task once WeChat is active", () => {
    const plan = planNextAction(openWechatIntent, screen(["微信"], "com.tencent.xin"), 1);

    expect(plan.action).toEqual({ type: "finish", summary: "已打开微信。" });
  });

  it("exits an accidental WeChat search page instead of typing a contact", () => {
    const search = screen(["微信", "搜索本地或网络结果", "最近在搜"]);
    search.nodes[1].bounds = { x: 120, y: 180, width: 780, height: 90 };
    const plan = planNextAction(baseIntent, search, 2);

    expect(plan.action).toEqual({ type: "back" });
    expect(plan.description).toContain("退出当前微信搜索页");
  });

  it("does not keep typing the contact when a search field is focused", () => {
    const focused = screen(["微信", "搜索本地或网络结果", "最近在搜"]);
    focused.keyboardVisible = true;
    const plan = planNextAction(baseIntent, focused, 3);

    expect(plan.action).toEqual({ type: "back" });
    expect(plan.description).toContain("近期聊天列表");
  });

  it("taps the contact result instead of treating search results as a chat", () => {
    const labels = ["微信", "搜索本地或网络结果", "联系人", "填充1", "填充2", "填充3", "填充4", "填充5", "填充6", "陈弘轩", "搜索网络结果"];
    const plan = planNextAction(baseIntent, screen(labels), 4);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_10" });
    expect(plan.description).toContain("搜索结果");
  });

  it("backs out when the exact contact is only in the search field", () => {
    const exactContact = "\u9648\u5f18\u8f69";
    const searchScreen: ScreenGraph = {
      app: "com.tencent.xin",
      orientation: "portrait",
      nodes: [
        { id: "el_1", source: "node", label: "\u5fae\u4fe1", role: "XCUIElementTypeStaticText", bounds: { x: 0, y: 0, width: 100, height: 40 }, confidence: 0.86 },
        { id: "el_2", source: "node", label: exactContact, role: "XCUIElementTypeSearchField", bounds: { x: 156, y: 207, width: 652, height: 85 }, confidence: 0.86 },
        { id: "el_3", source: "node", label: "\u641c\u7d22", role: "XCUIElementTypeButton", bounds: { x: 877, y: 2166, width: 291, height: 138 }, confidence: 0.86 },
        { id: "el_4", source: "node", label: "\u9648 \u8001\u5e08", role: "XCUIElementTypeStaticText", bounds: { x: 156, y: 579, width: 837, height: 96 }, confidence: 0.86 }
      ],
      ocrBlocks: [],
      dialogs: [],
      keyboardVisible: true,
      observedAt: Date.now()
    };
    const plan = planNextAction({ ...baseIntent, contact: exactContact }, searchScreen, 10);

    expect(plan.action).toEqual({ type: "back" });
    expect(plan.description).toContain("近期聊天列表");
  });

  it("opens the recipient from the recent chats page", () => {
    const exactContact = "\u9648\u5f18\u8f69";
    const recentChats: ScreenGraph = {
      app: "com.tencent.xin",
      screenSize: { width: 1170, height: 2532 },
      orientation: "portrait",
      nodes: [
        { id: "el_1", source: "node", label: "\u5fae\u4fe1", role: "XCUIElementTypeStaticText", bounds: { x: 48, y: 150, width: 160, height: 80 }, confidence: 0.86 },
        { id: "el_2", source: "node", label: exactContact, role: "XCUIElementTypeStaticText", bounds: { x: 180, y: 520, width: 240, height: 72 }, confidence: 0.86 },
        { id: "el_3", source: "node", label: "\u665a\u4e0a\u5403\u4ec0\u4e48", role: "XCUIElementTypeStaticText", bounds: { x: 180, y: 610, width: 420, height: 60 }, confidence: 0.86 },
        { id: "el_4", source: "node", label: "\u6807\u7b7e\u9875\u680f", role: "XCUIElementTypeStaticText", bounds: { x: 0, y: 2180, width: 1170, height: 200 }, confidence: 0.86 },
        { id: "el_5", source: "node", label: "\u5fae\u4fe1", role: "XCUIElementTypeButton", bounds: { x: 0, y: 2200, width: 292, height: 160 }, confidence: 0.86 },
        { id: "el_6", source: "node", label: "\u901a\u8baf\u5f55", role: "XCUIElementTypeButton", bounds: { x: 292, y: 2200, width: 292, height: 160 }, confidence: 0.86 },
        { id: "el_7", source: "node", label: "\u53d1\u73b0", role: "XCUIElementTypeButton", bounds: { x: 584, y: 2200, width: 292, height: 160 }, confidence: 0.86 },
        { id: "el_8", source: "node", label: "\u6211", role: "XCUIElementTypeButton", bounds: { x: 876, y: 2200, width: 292, height: 160 }, confidence: 0.86 }
      ],
      ocrBlocks: [],
      dialogs: [],
      keyboardVisible: false,
      observedAt: Date.now()
    };
    const plan = planNextAction({ ...baseIntent, contact: exactContact }, recentChats, 8);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_2" });
    expect(plan.description).toContain("\u8fd1\u671f\u804a\u5929");
  });

  it("switches from Contacts to the bottom-left WeChat tab before looking for the recipient", () => {
    const exactContact = "\u9648\u5f18\u8f69";
    const contactsPage: ScreenGraph = {
      app: "com.tencent.xin",
      screenSize: { width: 1170, height: 2532 },
      orientation: "portrait",
      nodes: [
        { id: "el_1", source: "node", label: "\u901a\u8baf\u5f55", role: "XCUIElementTypeStaticText", bounds: { x: 48, y: 150, width: 180, height: 80 }, confidence: 0.86 },
        { id: "el_2", source: "node", label: "\u65b0\u7684\u670b\u53cb", role: "XCUIElementTypeStaticText", bounds: { x: 160, y: 430, width: 240, height: 80 }, confidence: 0.86 },
        { id: "el_3", source: "node", label: "\u516c\u4f17\u53f7", role: "XCUIElementTypeStaticText", bounds: { x: 160, y: 620, width: 240, height: 80 }, confidence: 0.86 },
        { id: "el_4", source: "node", label: exactContact, role: "XCUIElementTypeStaticText", bounds: { x: 160, y: 900, width: 240, height: 80 }, confidence: 0.86 },
        { id: "el_5", source: "node", label: "\u6807\u7b7e\u9875\u680f", role: "XCUIElementTypeStaticText", bounds: { x: 0, y: 2180, width: 1170, height: 200 }, confidence: 0.86 },
        { id: "el_6", source: "node", label: "\u5fae\u4fe1", role: "XCUIElementTypeButton", bounds: { x: 0, y: 2200, width: 292, height: 160 }, confidence: 0.86 },
        { id: "el_7", source: "node", label: "\u901a\u8baf\u5f55", role: "XCUIElementTypeButton", bounds: { x: 292, y: 2200, width: 292, height: 160 }, confidence: 0.86 },
        { id: "el_8", source: "node", label: "\u53d1\u73b0", role: "XCUIElementTypeButton", bounds: { x: 584, y: 2200, width: 292, height: 160 }, confidence: 0.86 },
        { id: "el_9", source: "node", label: "\u6211", role: "XCUIElementTypeButton", bounds: { x: 876, y: 2200, width: 292, height: 160 }, confidence: 0.86 }
      ],
      ocrBlocks: [],
      dialogs: [],
      keyboardVisible: false,
      observedAt: Date.now()
    };
    const plan = planNextAction({ ...baseIntent, contact: exactContact }, contactsPage, 8);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_6" });
    expect(plan.description).toContain("\u5de6\u4e0b\u89d2");
  });

  it("switches from Contacts to recent chats even after finishing an article task", () => {
    const exactContact = "\u9648\u5f18\u8f69";
    const messageIntent: ParsedIntent = {
      ...baseIntent,
      contact: exactContact,
      topic: "\u673a\u5668\u4e4b\u5fc3",
      source: { app: "wechat", kind: "official_account", name: "\u673a\u5668\u4e4b\u5fc3" },
      delivery: { app: "wechat", kind: "contact", name: exactContact }
    };
    const contactsPage: ScreenGraph = {
      app: "com.tencent.xin",
      screenSize: { width: 1170, height: 2532 },
      orientation: "portrait",
      nodes: [
        { id: "el_1", source: "node", label: "\u901a\u8baf\u5f55", role: "XCUIElementTypeStaticText", bounds: { x: 48, y: 150, width: 180, height: 80 }, confidence: 0.86 },
        { id: "el_2", source: "node", label: "\u641c\u7d22", role: "XCUIElementTypeButton", bounds: { x: 900, y: 150, width: 120, height: 80 }, confidence: 0.86 },
        { id: "el_3", source: "node", label: "\u65b0\u7684\u670b\u53cb", role: "XCUIElementTypeStaticText", bounds: { x: 160, y: 430, width: 240, height: 80 }, confidence: 0.86 },
        { id: "el_4", source: "node", label: "\u516c\u4f17\u53f7 ,", role: "XCUIElementTypeStaticText", bounds: { x: 160, y: 620, width: 240, height: 80 }, confidence: 0.86 },
        { id: "el_5", source: "node", label: exactContact, role: "XCUIElementTypeStaticText", bounds: { x: 160, y: 900, width: 240, height: 80 }, confidence: 0.86 },
        { id: "el_6", source: "node", label: "\u6807\u7b7e\u9875\u680f", role: "XCUIElementTypeStaticText", bounds: { x: 0, y: 2180, width: 1170, height: 200 }, confidence: 0.86 },
        { id: "el_7", source: "node", label: "\u5fae\u4fe1", role: "XCUIElementTypeButton", bounds: { x: 0, y: 2200, width: 292, height: 160 }, confidence: 0.86 },
        { id: "el_8", source: "node", label: "\u901a\u8baf\u5f55", role: "XCUIElementTypeButton", bounds: { x: 292, y: 2200, width: 292, height: 160 }, confidence: 0.86 },
        { id: "el_9", source: "node", label: "\u53d1\u73b0", role: "XCUIElementTypeButton", bounds: { x: 584, y: 2200, width: 292, height: 160 }, confidence: 0.86 },
        { id: "el_10", source: "node", label: "\u6211", role: "XCUIElementTypeButton", bounds: { x: 876, y: 2200, width: 292, height: 160 }, confidence: 0.86 }
      ],
      ocrBlocks: [],
      dialogs: [],
      keyboardVisible: false,
      observedAt: Date.now()
    };
    const plan = planNextAction(messageIntent, contactsPage, 8);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_7" });
    expect(plan.description).toContain("\u5de6\u4e0b\u89d2");
  });

  it("opens the contact from Contacts even when the message intent still has an article topic", () => {
    const exactContact = "\u9648\u5f18\u8f69";
    const labels = ["\u5fae\u4fe1", "\u901a\u8baf\u5f55", "\u516c\u4f17\u53f7", "A", "B", "C", "D", "E", exactContact, "\u5fae\u4fe1\u56e2\u961f"];
    const plan = planNextAction(
      { ...baseIntent, contact: exactContact, topic: "\u673a\u5668\u4e4b\u5fc3" },
      screen(labels),
      12
    );

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_9" });
    expect(plan.description).toContain("\u9648\u5f18\u8f69");
  });

  it("opens chat from the WeChat contact profile page", () => {
    const exactContact = "\u9648\u5f18\u8f69";
    const labels = ["\u5fae\u4fe1", "\u8fd4\u56de", exactContact, "\u670b\u53cb\u8d44\u6599", "\u5fae\u4fe1\u53f7\uff1a", "\u670b\u53cb\u5708", "\u53d1\u6d88\u606f", "\u97f3\u89c6\u9891\u901a\u8bdd"];
    const plan = planNextAction({ ...baseIntent, contact: exactContact }, screen(labels), 14);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_7" });
    expect(plan.description).toContain("\u53d1\u6d88\u606f");
  });

  it("opens chat from a contact profile before applying stale article exit logic", () => {
    const exactContact = "\u9648\u5f18\u8f69";
    const labels = ["\u5fae\u4fe1", "\u8fd4\u56de", exactContact, "\u673a\u5668\u4e4b\u5fc3", "\u670b\u53cb\u8d44\u6599", "\u5fae\u4fe1\u53f7\uff1a", "\u53d1\u6d88\u606f"];
    const plan = planNextAction(
      { ...baseIntent, contact: exactContact, topic: "\u673a\u5668\u4e4b\u5fc3" },
      screen(labels),
      18
    );

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_7" });
    expect(plan.description).toContain("\u53d1\u6d88\u606f");
  });

  it("keeps chatting when a message intent still carries the article topic", () => {
    const exactContact = "\u9648\u5f18\u8f69";
    const plan = planNextAction(
      { ...baseIntent, contact: exactContact, topic: "\u673a\u5668\u4e4b\u5fc3" },
      chatScreen(["\u5fae\u4fe1", exactContact, "\u673a\u5668\u4e4b\u5fc3", "\u6309\u4f4f\u8bf4\u8bdd", "XCUIElementTypeTextView"]),
      18
    );

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_5" });
    expect(plan.description).toContain("\u804a\u5929\u8f93\u5165\u6846");
  });

  it("focuses the chat input before typing the message", () => {
    const plan = planNextAction(baseIntent, chatScreen(["微信", "陈弘轩", "按住说话", "XCUIElementTypeTextView"]), 3);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_4" });
    expect(plan.description).toContain("聊天输入框");
  });

  it("inputs the message after the chat input is focused", () => {
    const plan = planNextAction(baseIntent, chatScreen(["微信", "陈弘轩", "按住说话", "XCUIElementTypeTextView"], true), 4);

    expect(plan.action).toEqual({ type: "input", text: "晚上吃什么" });
  });

  it("sends the draft when the message is already in the chat input", () => {
    const plan = planNextAction(baseIntent, chatScreen(["微信", "陈弘轩", "晚上吃什么", "发送"]), 4);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_4" });
    expect(plan.description).toContain("点击发送");
  });

  it("finishes after the message appears in chat history", () => {
    const plan = planNextAction(baseIntent, chatScreen(["微信", "陈弘轩", "XCUIElementTypeTextView", "我,晚上吃什么"]), 5);

    expect(plan.action.type).toBe("finish");
  });

  it("does not finish from old chat history when a fresh send is required", () => {
    const plan = planNextAction(
      { ...baseIntent, freshSendRequired: true },
      chatScreen(["微信", "陈弘轩", "XCUIElementTypeTextView", "我,晚上吃什么"]),
      5
    );

    expect(plan.action.type).toBe("tap_element");
    expect(plan.description).toContain("聊天输入框");
  });

  it("finishes a fresh generated summary when sent evidence is visible", () => {
    const message = "我读了机器之心最新文章《具身智能来时路：谷歌RT1、2，SayCan作者Ted Xiao复盘机器人学习》。 简要总结：文章回顾了机器人学习三大阶段，以及数据和基础模型如何推动具身智能演进。 （phone-agent 自动整理）";
    const plan = planNextAction(
      { ...baseIntent, query: message, freshSendRequired: true },
      chatScreen([
        "微信",
        "陈弘轩",
        "XCUIElementTypeTextView",
        "我,我读了机器之心最新文章《具身智能来时路：谷歌RT1、2，SayCan作者Ted Xiao复盘机...》。 简要总结：文章围绕机器人学习三大阶段展开。 （phone-agent 自动整理）"
      ], true),
      7
    );

    expect(plan.action.type).toBe("finish");
  });

  it("does not treat several split chat bubbles as one sent message", () => {
    const message = "我读了机器之心最新文章《拿下1亿美元种子轮》，摘要：1. 第一条摘要 2. 第二条摘要（phone-agent 自动整理）";
    const intent = { ...baseIntent, query: message };
    const plan = planNextAction(
      intent,
      chatScreen([
        "微信",
        "陈弘轩",
        "XCUIElementTypeTextView",
        "我,我读了机器之心最新文章《拿下1亿美元种子轮》，摘要：1.",
        "我,第一条摘要",
        "我,2. 第二条摘要",
        "我,（phone-agent 自动整理）"
      ], true),
      7
    );

    expect(plan.action.type).toBe("input");
  });

  it("sends a long draft when the full TextView value matches even if node labels are truncated", () => {
    const exactContact = "\u9648\u5f18\u8f69";
    const message = "我读了机器之心最新文章《专业的人工智能媒体和产业服务平台》，摘要： 1. 直播预告, 5月13日09:30直播Create百度AI开发者大会 2. 5月13日09:30直播 （phone-agent 自动整理）";
    const plan = planNextAction({ ...baseIntent, contact: exactContact, query: message }, draftChatScreen(exactContact, message), 18);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_4" });
    expect(plan.description).toContain("\u70b9\u51fb\u53d1\u9001");
  });

  it("sends a long draft when the active TextView value is abbreviated by iOS", () => {
    const exactContact = "\u9648\u5f18\u8f69";
    const message = "我读了机器之心最新文章《具身智能来时路：谷歌RT1、2，SayCan作者Ted Xiao复盘机器人学习》。 简要总结：前谷歌DeepMind资深科学家Ted Xiao在访谈中系统复盘了具身智能领域的三大时代，揭示了人形机器人浪潮背后的真实演进历程。他详细讲述了团队如何通过构建机械臂农场和研发QT-Opt算法，克服连续动作空间难题，首次在真实世界证明端到端机器人学习的可行性。文章还分享了从单任务抓取走向多任务语言条件化模仿学习的关键决策，以及那些论文里看不到的犹豫与转折，非常值得关心AI和机器人发展的人细读。 （phone-agent 自动整理）";
    const abbreviated = `${message.slice(0, 70)}...${message.slice(150, 220)}...${message.slice(-70)}`;
    const plan = planNextAction({ ...baseIntent, contact: exactContact, query: message }, draftChatScreen(exactContact, message, abbreviated), 18);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_4" });
    expect(plan.description).toContain("\u70b9\u51fb\u53d1\u9001");
  });

  it("rewrites a duplicated long draft instead of sending it", () => {
    const exactContact = "\u9648\u5f18\u8f69";
    const message = "我读了机器之心最新文章《专业的人工智能媒体和产业服务平台》，摘要： 1. 直播预告, 5月13日09:30直播Create百度AI开发者大会 2. 5月13日09:30直播 （phone-agent 自动整理）";
    const plan = planNextAction(
      { ...baseIntent, contact: exactContact, query: message },
      draftChatScreen(exactContact, message, `${message}${message}`),
      18
    );

    expect(plan.action.type).toBe("ask_user");
    expect(plan.description).toContain("\u91cd\u590d\u8349\u7a3f");
  });

  it("stops when the current draft is only a truncated prefix of the long message", () => {
    const exactContact = "\u9648\u5f18\u8f69";
    const message = "我读了机器之心最新文章《专业的人工智能媒体和产业服务平台》，摘要： 1. 直播预告, 5月13日09:30直播Create百度AI开发者大会 2. 5月13日09:30直播 （phone-agent 自动整理）";
    const plan = planNextAction(
      { ...baseIntent, contact: exactContact, query: message },
      draftChatScreen(exactContact, message, "我读了机器之心最新文章《专业的人工智能媒体和产业服"),
      18
    );

    expect(plan.action.type).toBe("ask_user");
    expect(plan.description).toContain("\u4e0d\u5b8c\u6574\u8349\u7a3f");
  });

  it("finishes when the complete long message appears in one chat bubble", () => {
    const message = "我读了机器之心最新文章《拿下1亿美元种子轮》，摘要：1. 第一条摘要 2. 第二条摘要（phone-agent 自动整理）";
    const intent = { ...baseIntent, query: message };
    const plan = planNextAction(intent, chatScreen(["微信", "陈弘轩", "XCUIElementTypeTextView", `我,${message}`], true), 7);

    expect(plan.action.type).toBe("finish");
  });

  it("uses WeChat search for the official account when already on a search page", () => {
    const search = screen(["微信", "搜索本地或网络结果", "最近在搜"]);
    search.nodes[1].bounds = { x: 120, y: 180, width: 780, height: 90 };
    const plan = planNextAction(articleIntent, search, 3);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_2" });
    expect(plan.description).toContain("公众号");
  });

  it("types the official account name into search only during the source-locating phase", () => {
    const focused = screen(["微信", "搜索本地或网络结果", "最近在搜"]);
    focused.keyboardVisible = true;
    const plan = planNextAction(articleIntent, focused, 4);

    expect(plan.action).toEqual({ type: "input", text: "机器之心" });
    expect(plan.phase).toBe("locate_source");
  });

  it("exits stale WeChat search text instead of searching a contact", () => {
    const plan = planNextAction(baseIntent, searchScreenWithQuery("机器之心"), 8);

    expect(plan.action).toEqual({ type: "back" });
    expect(plan.description).toContain("近期聊天列表");
  });

  it("opens the official account from WeChat search results during article tasks", () => {
    const plan = planNextAction(articleIntent, officialAccountSearchResultScreen(), 4);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_5" });
    expect(["wechat:search_official_account", "wechat:official_accounts_list"]).toContain(plan.route);
  });

  it("does not tap the article category tab when searching an official account", () => {
    const labels = ["微信", "搜索本地或网络结果", "机器之心", "全部,按钮", "文章,按钮", "已选定,文章,按钮", "账号,按钮", "视频,按钮"];
    const plan = planNextAction(articleIntent, screen(labels), 5);

    expect(plan.action).not.toEqual({ type: "tap_element", elementId: "el_5" });
  });

  it("exits irrelevant Moments no-result pages instead of repeating official account taps", () => {
    const plan = planNextAction(articleIntent, searchNoResultScreen("机器之心"), 5);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_6" });
    expect(plan.route).toBe("wechat:contacts_official_accounts");
  });

  it("exits no-result contact search instead of re-submitting the same query", () => {
    const plan = planNextAction(baseIntent, searchNoResultScreen("陈弘轩"), 8);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_6" });
    expect(plan.route).toBe("wechat:exit_contact_search");
  });

  it("uses Contacts as the preferred route for WeChat official accounts", () => {
    const tabScreen: ScreenGraph = {
      app: "com.tencent.xin",
      screenSize: { width: 1170, height: 2532 },
      orientation: "portrait",
      nodes: [
        { id: "el_1", source: "node", label: "\u5fae\u4fe1", role: "XCUIElementTypeStaticText", bounds: { x: 0, y: 0, width: 100, height: 40 }, confidence: 0.86 },
        { id: "el_2", source: "node", label: "\u641c\u7d22", role: "XCUIElementTypeButton", bounds: { x: 1000, y: 120, width: 80, height: 80 }, confidence: 0.86 },
        { id: "el_3", source: "node", label: "\u804a\u5929", role: "XCUIElementTypeButton", bounds: { x: 0, y: 2212, width: 294, height: 319 }, confidence: 0.86 },
        { id: "el_4", source: "node", label: "\u901a\u8baf\u5f55", role: "XCUIElementTypeButton", bounds: { x: 291, y: 2212, width: 294, height: 319 }, confidence: 0.86 },
        { id: "el_5", source: "node", label: "\u53d1\u73b0", role: "XCUIElementTypeButton", bounds: { x: 585, y: 2212, width: 294, height: 319 }, confidence: 0.86 },
        { id: "el_6", source: "node", label: "\u6211", role: "XCUIElementTypeButton", bounds: { x: 879, y: 2212, width: 294, height: 319 }, confidence: 0.86 }
      ],
      ocrBlocks: [],
      dialogs: [],
      keyboardVisible: false,
      observedAt: Date.now()
    };
    const plan = planNextAction(articleIntent, tabScreen, 3);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_4" });
    expect(plan.description).toContain("\u901a\u8baf\u5f55");
  });

  it("does not treat the WeChat conversation list as an open chat", () => {
    const homeScreen: ScreenGraph = {
      app: "com.tencent.xin",
      screenSize: { width: 1170, height: 2532 },
      orientation: "portrait",
      nodes: [
        { id: "el_1", source: "node", label: "微信", role: "XCUIElementTypeStaticText", bounds: { x: 500, y: 180, width: 160, height: 70 }, confidence: 0.86 },
        { id: "el_2", source: "node", label: "陈弘轩,到‘机械之心’公众号,22:20", role: "XCUIElementTypeStaticText", bounds: { x: 260, y: 900, width: 600, height: 120 }, confidence: 0.86 },
        { id: "el_3", source: "node", label: "22:23", role: "XCUIElementTypeStaticText", bounds: { x: 1000, y: 600, width: 120, height: 60 }, confidence: 0.86 },
        { id: "el_4", source: "node", label: "22:20", role: "XCUIElementTypeStaticText", bounds: { x: 1000, y: 900, width: 120, height: 60 }, confidence: 0.86 },
        { id: "el_5", source: "node", label: "标签页栏", role: "XCUIElementTypeOther", bounds: { x: 0, y: 2200, width: 1170, height: 300 }, confidence: 0.86 },
        { id: "el_6", source: "node", label: "微信", role: "XCUIElementTypeButton", bounds: { x: 90, y: 2240, width: 160, height: 220 }, confidence: 0.86 },
        { id: "el_7", source: "node", label: "通讯录", role: "XCUIElementTypeButton", bounds: { x: 380, y: 2240, width: 190, height: 220 }, confidence: 0.86 },
        { id: "el_8", source: "node", label: "发现", role: "XCUIElementTypeButton", bounds: { x: 680, y: 2240, width: 160, height: 220 }, confidence: 0.86 },
        { id: "el_9", source: "node", label: "我", role: "XCUIElementTypeButton", bounds: { x: 980, y: 2240, width: 120, height: 220 }, confidence: 0.86 }
      ],
      ocrBlocks: [],
      dialogs: [],
      keyboardVisible: false,
      observedAt: Date.now()
    };
    const plan = planNextAction(articleIntent, homeScreen, 2);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_7" });
    expect(plan.description).toContain("通讯录");
  });

  it("does not enter reading mode from recent chats just because an old summary mentions the article", () => {
    const homeScreen: ScreenGraph = {
      app: "com.tencent.xin",
      screenSize: { width: 1170, height: 2532 },
      orientation: "portrait",
      nodes: [
        { id: "el_1", source: "node", label: "微信", role: "XCUIElementTypeStaticText", bounds: { x: 524, y: 153, width: 123, height: 108 }, confidence: 0.86 },
        { id: "el_2", source: "node", label: "快捷操作", role: "XCUIElementTypeButton", bounds: { x: 989, y: 141, width: 132, height: 132 }, confidence: 0.86 },
        { id: "el_3", source: "node", label: "搜索", role: "XCUIElementTypeSearchField", bounds: { x: 0, y: 59, width: 1170, height: 214 }, confidence: 0.86 },
        { id: "el_4", source: "node", label: "陈弘轩,我读了机器之心最新文章《RT-1 的意义不仅是性能》，作者复盘了机器人学习路线,23:31", role: "XCUIElementTypeStaticText", bounds: { x: 0, y: 520, width: 1170, height: 180 }, confidence: 0.86 },
        { id: "el_5", source: "node", label: "公众号,未读,[3条],新智元: 最新文章,22:23", role: "XCUIElementTypeStaticText", bounds: { x: 0, y: 760, width: 1170, height: 180 }, confidence: 0.86 },
        { id: "el_6", source: "node", label: "标签页栏", role: "XCUIElementTypeTabBar", bounds: { x: 0, y: 2212, width: 1170, height: 319 }, confidence: 0.86 },
        { id: "el_7", source: "node", label: "微信", role: "XCUIElementTypeButton", bounds: { x: -3, y: 2212, width: 294, height: 319 }, confidence: 0.86 },
        { id: "el_8", source: "node", label: "通讯录", role: "XCUIElementTypeButton", bounds: { x: 291, y: 2212, width: 294, height: 319 }, confidence: 0.86 },
        { id: "el_9", source: "node", label: "发现", role: "XCUIElementTypeButton", bounds: { x: 585, y: 2212, width: 294, height: 319 }, confidence: 0.86 },
        { id: "el_10", source: "node", label: "我", role: "XCUIElementTypeButton", bounds: { x: 879, y: 2212, width: 294, height: 319 }, confidence: 0.86 }
      ],
      ocrBlocks: [],
      dialogs: [],
      keyboardVisible: false,
      observedAt: Date.now()
    };
    const plan = planNextAction(articleIntent, homeScreen, 2);

    expect(plan.action).not.toEqual({ type: "collect_scroll", direction: "down", maxScrolls: 1 });
    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_8" });
    expect(plan.description).toContain("通讯录");
  });

  it("opens a recipient recent chat even when the preview mentions an official account", () => {
    const homeScreen: ScreenGraph = {
      app: "com.tencent.xin",
      screenSize: { width: 1170, height: 2532 },
      orientation: "portrait",
      nodes: [
        { id: "el_1", source: "node", label: "微信", role: "XCUIElementTypeStaticText", bounds: { x: 500, y: 180, width: 160, height: 70 }, confidence: 0.86 },
        { id: "el_2", source: "node", label: "陈弘轩,到‘机械之心’公众号,22:20", role: "XCUIElementTypeStaticText", bounds: { x: 260, y: 900, width: 600, height: 120 }, confidence: 0.86 },
        { id: "el_3", source: "node", label: "标签页栏", role: "XCUIElementTypeOther", bounds: { x: 0, y: 2200, width: 1170, height: 300 }, confidence: 0.86 },
        { id: "el_4", source: "node", label: "微信", role: "XCUIElementTypeButton", bounds: { x: 90, y: 2240, width: 160, height: 220 }, confidence: 0.86 },
        { id: "el_5", source: "node", label: "通讯录", role: "XCUIElementTypeButton", bounds: { x: 380, y: 2240, width: 190, height: 220 }, confidence: 0.86 },
        { id: "el_6", source: "node", label: "发现", role: "XCUIElementTypeButton", bounds: { x: 680, y: 2240, width: 160, height: 220 }, confidence: 0.86 },
        { id: "el_7", source: "node", label: "我", role: "XCUIElementTypeButton", bounds: { x: 980, y: 2240, width: 120, height: 220 }, confidence: 0.86 }
      ],
      ocrBlocks: [],
      dialogs: [],
      keyboardVisible: false,
      observedAt: Date.now()
    };
    const plan = planNextAction(baseIntent, homeScreen, 2);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_2" });
    expect(plan.description).toContain("近期聊天");
  });

  it("opens Official Accounts from the Contacts page", () => {
    const labels = ["微信", "通讯录", "新的朋友", "群聊", "标签", "公众号"];
    const plan = planNextAction(articleIntent, screen(labels), 4);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_6" });
    expect(plan.description).toContain("公众号列表");
  });

  it("taps the Official Accounts card on Contacts before treating the page as an account list", () => {
    const labels = ["\u5fae\u4fe1", "\u6dfb\u52a0\u670b\u53cb", "\u901a\u8baf\u5f55", "\u6807\u7b7e", "\u516c\u4f17\u53f7 ,", "\u641c\u7d22", "\u9648\u5f18\u8f69", "\u6587\u4ef6\u4f20\u8f93\u52a9\u624b"];
    const plan = planNextAction(
      {
        ...articleIntent,
        contact: "\u9648\u5f18\u8f69",
        topic: "\u673a\u5668\u4e4b\u5fc3",
        rawInstruction: "\u6253\u5f00\u673a\u5668\u4e4b\u5fc3\u516c\u4f17\u53f7"
      },
      screen(labels),
      8
    );

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_5" });
    expect(plan.description).toContain("\u4ece\u901a\u8baf\u5f55\u8fdb\u5165\u516c\u4f17\u53f7\u5217\u8868");
  });

  it("returns to the top of Contacts instead of scrolling deeper when the Official Accounts card is not visible", () => {
    const labels = ["\u5fae\u4fe1", "\u901a\u8baf\u5f55", "\u4f01\u4e1a\u5fae\u4fe1\u8054\u7cfb\u4eba", "A", "\u9648\u5f18\u8f69", "\u6587\u4ef6\u4f20\u8f93\u52a9\u624b"];
    const plan = planNextAction(articleIntent, screen(labels), 7);

    expect(plan.action).toEqual({ type: "collect_scroll", direction: "up", maxScrolls: 1 });
    expect(plan.description).toContain("\u9876\u90e8");
  });

  it("opens the target account from the Official Accounts list", () => {
    const labels = ["微信", "公众号", "搜索", "机器之心"];
    const list = screen(labels);
    list.nodes[3].bounds = { x: 240, y: 520, width: 267, height: 78 };
    const plan = planNextAction(articleIntent, list, 5);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_4" });
    expect(plan.description).toContain("公众号列表");
  });

  it("scrolls the Official Accounts list instead of tapping its search box", () => {
    const labels = ["微信", "公众号", "搜索", "新的公众号", "订阅号", "不相关账号"];
    const plan = planNextAction(articleIntent, screen(labels), 5);

    expect(plan.action).toEqual({ type: "collect_scroll", direction: "down", maxScrolls: 1 });
    expect(plan.description).toContain("公众号列表");
  });

  it("keeps scanning the Official Accounts list after repeated scans", () => {
    const labels = ["微信", "公众号", "搜索", "新的公众号", "订阅号", "不相关账号"];
    const plan = planNextAction(articleIntent, screen(labels), 5, { noProgressCount: 1 });

    expect(plan.action).toEqual({ type: "collect_scroll", direction: "down", maxScrolls: 1 });
    expect(plan.route).toBe("wechat:official_accounts_list");
  });

  it("reveals a target account clipped under the Official Accounts header before tapping it", () => {
    const labels = ["微信", "公众号", "搜索", "机器之心", "量子位", "新智元"];
    const list = screen(labels);
    list.nodes[3].bounds = { x: 240, y: 106, width: 267, height: 78 };
    const plan = planNextAction(articleIntent, list, 5);

    expect(plan.action).toEqual({ type: "collect_scroll", direction: "up", maxScrolls: 1 });
    expect(plan.description).toContain("完全露出");
  });

  it("opens the first article from an official account page", () => {
    const labels = ["微信", "机器之心", "发消息", "公众号", "a", "b", "c", "d", "e", "这是一篇最新文章标题"];
    const plan = planNextAction(articleIntent, screen(labels), 5);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_10" });
    expect(plan.description).toContain("最新文章");
  });

  it("leaves an official account page before searching for a message recipient", () => {
    const messageIntent: ParsedIntent = {
      ...baseIntent,
      topic: "机器之心",
      source: { app: "wechat", kind: "official_account", name: "机器之心" },
      delivery: { app: "wechat", kind: "contact", name: "陈弘轩" }
    };
    const labels = ["微信", "返回", "搜索", "更多", "机器之心", "已关注公众号", "文章", "具身智能来时路"];
    const plan = planNextAction(messageIntent, screen(labels), 6);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_2" });
    expect(plan.description).toContain("离开公众号页面");
  });

  it("does not treat the official account profile as an opened article", () => {
    const labels = [
      "微信",
      "返回",
      "机器之心",
      "私信",
      "不再关注",
      "已关注公众号",
      "专业的人工智能媒体和产业服务平台",
      "2991篇原创内容",
      "视频号: 机器之心",
      "商品橱窗",
      "通讯录",
      "标签",
      "全部",
      "文章",
      "活久见，时代少年团给大模型上了一课"
    ];
    const plan = planNextAction(articleIntent, screen(labels), 8);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_15" });
    expect(plan.description).toContain("最新文章");
  });

  it("backs out of live preview pages instead of treating them as article pages", () => {
    const labels = [
      "微信",
      "返回",
      "机器之心",
      "Create百度AI开发者大会",
      "5月13日至14日，Create2026百度AI开发者大会将在北京举办。",
      "视频号直播·预告",
      "微信扫码预约",
      "预约",
      "分享给朋友"
    ];
    const plan = planNextAction(articleIntent, screen(labels), 10);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_2" });
    expect(plan.description).toContain("直播预告");
  });

  it("skips live appointment cards when choosing the first article", () => {
    const labels = [
      "微信",
      "返回",
      "机器之心",
      "私信",
      "已关注公众号",
      "专业的人工智能媒体和产业服务平台",
      "直播预告, 5月13日09:30直播Create百度AI开发者大会",
      "CreateAI",
      "直播预约 | 数据引擎：具身智能的下一个决胜局",
      "今天",
      "活久见，时代少年团给大模型上了一课",
      "活久见，时代少年团给大模型上了一课,阅读 6.9万 赞 1487"
    ];
    const plan = planNextAction(articleIntent, screen(labels), 8);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_11" });
  });

  it("skips the live banner before the article date group", () => {
    const labels = [
      "微信",
      "返回",
      "机器之心",
      "私信",
      "已关注公众号",
      "专业的人工智能媒体和产业服务平台",
      "直播预告, 5月13日09:30直播Create百度AI开发者大会",
      "CreateAI",
      "5月13日09:30直播",
      "今天",
      "活久见，时代少年团给大模型上了一课"
    ];
    const plan = planNextAction(articleIntent, screen(labels), 8);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_11" });
  });

  it("uses an already open target official account page instead of restarting from Contacts", () => {
    const labels = ["微信", "机器之心", "发消息", "公众号", "a", "b", "c", "d", "e", "这是一篇最新文章标题"];
    const plan = planNextAction(articleIntent, screen(labels), 1);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_10" });
    expect(plan.description).toContain("最新文章");
  });

  it("keeps scrolling an opened article before summarizing", () => {
    const labels = [
      "微信",
      "返回",
      "机器之心",
      "拿下1亿美元种子轮！SGLang团队创立RadixArk",
      "机器之心发布 2026年5月10日 10:00",
      "这是一段足够长的正文内容，用来模拟公众号文章的第一屏内容。",
      "另一段足够长的正文内容，说明文章仍需要继续阅读后再总结。",
      "作者"
    ];
    const plan = planNextAction(articleIntent, screen(labels), 6);

    expect(plan.action).toEqual({ type: "collect_scroll", direction: "down", maxScrolls: 1 });
    expect(plan.description).toContain("阅读全文");
  });

  it("continues reading an already open article instead of restarting from Contacts", () => {
    const labels = [
      "微信",
      "返回",
      "机器之心",
      "拿下1亿美元种子轮，SGLang团队创立RadixArk",
      "机器之心发布 2026年5月10日 10:00",
      "这是一段足够长的正文内容，用来模拟公众号文章的第一屏内容。",
      "另一段足够长的正文内容，说明文章仍需要继续阅读后再总结。",
      "作者"
    ];
    const plan = planNextAction(articleIntent, screen(labels), 1);

    expect(plan.action).toEqual({ type: "collect_scroll", direction: "down", maxScrolls: 1 });
    expect(plan.description).toContain("阅读全文");
  });

  it("does not treat a top navigation Contacts label as the bottom Contacts tab", () => {
    const profileLike: ScreenGraph = {
      app: "com.tencent.xin",
      orientation: "portrait",
      nodes: [
        { id: "el_1", source: "node", label: "\u5fae\u4fe1", role: "XCUIElementTypeStaticText", bounds: { x: 0, y: 0, width: 100, height: 40 }, confidence: 0.86 },
        { id: "el_2", source: "node", label: "\u8fd4\u56de", role: "XCUIElementTypeButton", bounds: { x: 48, y: 141, width: 42, height: 132 }, confidence: 0.86 },
        { id: "el_3", source: "node", label: "\u901a\u8baf\u5f55", role: "XCUIElementTypeStaticText", bounds: { x: 490, y: 180, width: 180, height: 70 }, confidence: 0.86 },
        { id: "el_4", source: "node", label: "\u9648\u5f18\u8f69", role: "XCUIElementTypeStaticText", bounds: { x: 330, y: 345, width: 258, height: 102 }, confidence: 0.86 }
      ],
      ocrBlocks: [],
      dialogs: [],
      keyboardVisible: false,
      observedAt: Date.now()
    };
    const plan = planNextAction(articleIntent, profileLike, 6);

    expect(plan.action).toEqual({ type: "tap_element", elementId: "el_2" });
  });

  it("does not tap cached article entries outside the current screen", () => {
    const accountHome: ScreenGraph = {
      app: "com.tencent.xin",
      screenSize: { width: 1170, height: 2532 },
      orientation: "portrait",
      nodes: [
        { id: "el_1", source: "node", label: "\u5fae\u4fe1", role: "XCUIElementTypeStaticText", bounds: { x: 0, y: 0, width: 100, height: 40 }, confidence: 0.86 },
        { id: "el_2", source: "node", label: "\u673a\u5668\u4e4b\u5fc3", role: "XCUIElementTypeStaticText", bounds: { x: 420, y: 160, width: 300, height: 80 }, confidence: 0.86 },
        { id: "el_3", source: "node", label: "\u53d1\u6d88\u606f", role: "XCUIElementTypeButton", bounds: { x: 300, y: 560, width: 260, height: 90 }, confidence: 0.86 },
        { id: "el_4", source: "node", label: "\u4eca\u5929", role: "XCUIElementTypeStaticText", bounds: { x: 48, y: 2700, width: 120, height: 60 }, confidence: 0.86, clickable: false },
        { id: "el_5", source: "node", label: "\u5177\u8eab\u667a\u80fd\u6765\u65f6\u8def\uff1a\u8c37\u6b4cRT1\u30012\uff0cSayCan\u4f5c\u8005Ted Xiao\u590d\u76d8\u673a\u5668\u4eba\u5b66\u4e60", role: "XCUIElementTypeStaticText", bounds: { x: 48, y: 2886, width: 980, height: 180 }, confidence: 0.86 }
      ],
      ocrBlocks: [],
      dialogs: [],
      keyboardVisible: false,
      observedAt: Date.now()
    };
    const plan = planNextAction(articleIntent, accountHome, 6);

    expect(plan.action).toEqual({ type: "collect_scroll", direction: "down", maxScrolls: 1 });
  });
});
