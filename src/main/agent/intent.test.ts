import { describe, expect, it } from "vitest";
import { parseIntent } from "./intent";

describe("parseIntent", () => {
  it("detects WeChat article summary tasks", () => {
    const intent = parseIntent("阅读公众号最新文章，总结后发给张三");
    expect(intent.kind).toBe("wechat_article_summary");
    expect(intent.targetApp).toBe("wechat");
    expect(intent.contact).toBe("张三");
  });

  it("detects Dianping food search tasks", () => {
    const intent = parseIntent("上大众点评搜索静安寺附近适合两个人吃的川菜");
    expect(intent.kind).toBe("dianping_food_search");
    expect(intent.targetApp).toBe("dianping");
  });

  it("detects direct WeChat message tasks", () => {
    const intent = parseIntent("打开微信，问问陈弘轩晚上吃什么");
    expect(intent.kind).toBe("wechat_message");
    expect(intent.targetApp).toBe("wechat");
    expect(intent.contact).toBe("陈弘轩");
    expect(intent.query).toBe("晚上吃什么");
  });

  it("detects simple WeChat open tasks without turning them into message sends", () => {
    const intent = parseIntent("打开微信");
    expect(intent.kind).toBe("generic");
    expect(intent.targetApp).toBe("wechat");
  });

  it("extracts WeChat article account aliases", () => {
    const intent = parseIntent("打开‘机械之心’公众号，阅读最新的一篇文章，然后将总结发给陈弘轩");
    expect(intent.kind).toBe("wechat_article_summary");
    expect(intent.targetApp).toBe("wechat");
    expect(intent.topic).toBe("机器之心");
    expect(intent.contact).toBe("陈弘轩");
    expect(intent.source).toEqual({ app: "wechat", kind: "official_account", name: "机器之心" });
    expect(intent.delivery).toEqual({ app: "wechat", kind: "contact", name: "陈弘轩" });
  });

  it("strips demonstratives around official account names", () => {
    const intent = parseIntent("现在查看量子位这个公众号的第一篇文章，总结后发给陈弘轩");

    expect(intent.kind).toBe("wechat_article_summary");
    expect(intent.topic).toBe("量子位");
    expect(intent.contact).toBe("陈弘轩");
  });

  it("keeps long WeChat article-and-send instructions as article tasks", () => {
    const intent = parseIntent("从当前未知界面开始，打开微信，找到‘机械之心’公众号，打开最新一篇文章，形成总结，然后作为一整条消息发送给陈弘轩。");

    expect(intent.kind).toBe("wechat_article_summary");
    expect(intent.topic).toBe("机器之心");
    expect(intent.contact).toBe("陈弘轩");
    expect(intent.source).toEqual({ app: "wechat", kind: "official_account", name: "机器之心" });
    expect(intent.delivery).toEqual({ app: "wechat", kind: "contact", name: "陈弘轩" });
  });

  it("ignores route descriptions such as WeChat Contacts when extracting the official account", () => {
    const intent = parseIntent("从当前微信首页开始，打开微信通讯录里的“公众号”，进入“机械之心”公众号，打开最新一篇文章，形成总结，然后发给陈弘轩。");

    expect(intent.kind).toBe("wechat_article_summary");
    expect(intent.topic).toBe("机器之心");
    expect(intent.source).toEqual({ app: "wechat", kind: "official_account", name: "机器之心" });
  });

  it("detects 48-hour multi-article digest tasks", () => {
    const intent = parseIntent("在机器之心公众号主页翻找近48小时内发布的所有文章，分别总结后发给陈弘轩");

    expect(intent.kind).toBe("wechat_multi_article_digest");
    expect(intent.multiArticle).toBe(true);
    expect(intent.articleWindowHours).toBe(48);
    expect(intent.topic).toBe("机器之心");
    expect(intent.delivery).toEqual({ app: "wechat", kind: "contact", name: "陈弘轩" });
  });

  it("detects group delivery for multi-article digests", () => {
    const intent = parseIntent("阅读机器之心公众号近48小时所有文章，总结后发送给AI同学群");

    expect(intent.kind).toBe("wechat_multi_article_digest");
    expect(intent.delivery).toEqual({ app: "wechat", kind: "group", name: "AI同学群" });
  });
});
