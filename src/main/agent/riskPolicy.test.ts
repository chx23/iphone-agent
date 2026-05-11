import { describe, expect, it } from "vitest";
import { assessRisk } from "./riskPolicy";
import type { ParsedIntent } from "../../shared/types";

const baseIntent: ParsedIntent = {
  kind: "wechat_article_summary",
  targetApp: "wechat",
  contact: "张三",
  rawInstruction: "总结公众号后发给张三",
  output: "message"
};

describe("risk policy", () => {
  it("requires confirmation for non-whitelisted message recipients", () => {
    const result = assessRisk({
      action: { type: "input", text: "摘要内容" },
      intent: baseIntent,
      whitelist: [],
      advancedAutoMode: false
    });

    expect(result.decision).toBe("confirm");
    expect(result.level).toBe("high");
  });

  it("allows whitelisted message recipients", () => {
    const result = assessRisk({
      action: { type: "input", text: "摘要内容" },
      intent: baseIntent,
      whitelist: [{ id: "wl_1", label: "张三", kind: "contact", autoSend: true }],
      advancedAutoMode: false
    });

    expect(result.decision).toBe("allow");
  });

  it("requires confirmation for direct WeChat messages to non-whitelisted contacts", () => {
    const result = assessRisk({
      action: { type: "input", text: "晚上吃什么" },
      intent: { ...baseIntent, kind: "wechat_message", rawInstruction: "打开微信，问问陈弘轩晚上吃什么", contact: "陈弘轩", query: "晚上吃什么" },
      whitelist: [],
      advancedAutoMode: false
    });

    expect(result.decision).toBe("confirm");
    expect(result.level).toBe("high");
  });

  it("allows typing the contact name into WeChat search", () => {
    const result = assessRisk({
      action: { type: "input", text: "陈弘轩" },
      intent: { ...baseIntent, kind: "wechat_message", rawInstruction: "打开微信，问问陈弘轩晚上吃什么", contact: "陈弘轩", query: "晚上吃什么" },
      whitelist: [],
      advancedAutoMode: false
    });

    expect(result.decision).toBe("allow");
    expect(result.level).toBe("low");
  });

  it("always confirms sensitive financial tasks", () => {
    const result = assessRisk({
      action: { type: "tap_text", text: "确认支付" },
      intent: { ...baseIntent, rawInstruction: "帮我确认支付" },
      whitelist: [{ id: "wl_1", label: "张三", kind: "contact", autoSend: true }],
      advancedAutoMode: true
    });

    expect(result.decision).toBe("confirm");
    expect(result.level).toBe("critical");
  });
});
