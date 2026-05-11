import type { ParsedIntent, TaskKind } from "../../shared/types";

export function parseIntent(instruction: string): ParsedIntent {
  const text = instruction.trim();
  const readableIntent = parseReadableChineseIntent(text);
  if (readableIntent) return readableIntent;
  const kind = inferKind(text);
  const askMessage = parseAskMessage(text);
  const contact = askMessage?.contact
    ?? matchAfter(text, /(?:发给|发送给|转发给|给)([^，。,.\s]+(?:群|群聊|同事|朋友|老师|老板|妈妈|爸爸|先生|女士|[A-Za-z0-9_\-\u4e00-\u9fa5]+)?)/);
  const location = matchAfter(text, /(?:在|搜|搜索|找|附近|上)([^，。,.\s]{2,12})(?:附近|周边|的)?(?:美食|餐厅|吃|川菜|火锅|日料|咖啡)?/);
  const query = askMessage?.message ?? matchAfter(text, /(?:搜索|搜|找|推荐|看看)([^，。,.\n]+)/);
  const topic = parseArticleAccount(text) ?? matchAfter(text, /(?:公众号|文章|阅读|读一下|总结)([^，。,.\n]*)/);
  const cleanedTopic = cleanup(topic);
  const cleanedContact = cleanup(contact);
  const multiArticle = kind === "wechat_multi_article_digest";
  const deliveryKind = cleanedContact && /群|群聊/.test(cleanedContact) ? "group" : "contact";

  return {
    kind,
    targetApp: inferTargetApp(kind, text),
    source: (kind === "wechat_article_summary" || kind === "wechat_multi_article_digest") && cleanedTopic
      ? { app: "wechat", kind: "official_account", name: cleanedTopic }
      : undefined,
    delivery: (kind === "wechat_article_summary" || kind === "wechat_multi_article_digest" || kind === "wechat_message") && cleanedContact
      ? { app: "wechat", kind: deliveryKind, name: cleanedContact }
      : undefined,
    contact: cleanedContact,
    topic: cleanedTopic,
    location: kind === "dianping_food_search" ? cleanup(location) : undefined,
    query: cleanup(query),
    output: kind === "dianping_food_search" ? "recommendation" : kind === "wechat_article_summary" || kind === "wechat_multi_article_digest" || kind === "wechat_message" ? "message" : "summary",
    multiArticle: multiArticle || undefined,
    articleWindowHours: multiArticle ? 48 : undefined,
    rawInstruction: text
  };
}

function parseReadableChineseIntent(text: string): ParsedIntent | undefined {
  const wechat = "\u5fae\u4fe1";
  const officialAccount = "\u516c\u4f17\u53f7";
  const summaryWords = /(\u603b\u7ed3|\u6574\u7406|\u6458\u8981)/;
  const deliveryMatch = text.match(new RegExp(`(?:\\u53d1\\u7ed9|\\u53d1\\u9001\\u7ed9|\\u8f6c\\u53d1\\u7ed9)\\s*([^\\u3002\\uff0c,\\.\\s]+(?:\\u7fa4\\u804a|\\u7fa4)?)`));
  const contact = cleanup(deliveryMatch?.[1]);
  const account = parseReadableArticleAccount(text);
  const isMultiArticle = text.includes(officialAccount)
    && /(48\s*\u5c0f\u65f6|48h|\u8fd1\s*48|\u8fd1\u4e24\u5929|\u6700\u8fd1\u4e24\u5929|\u4eca\u5929|\u6628\u5929|\u6240\u6709\u6587\u7ae0|\u5168\u90e8\u6587\u7ae0|\u591a\u7bc7|\u6bcf\u7bc7|\u5206\u522b)/i.test(text)
    && (summaryWords.test(text) || Boolean(contact));
  if (isMultiArticle) {
    const kind = contact && /(\u7fa4\u804a|\u7fa4)/.test(contact) ? "group" : "contact";
    return {
      kind: "wechat_multi_article_digest",
      targetApp: "wechat",
      source: account ? { app: "wechat", kind: "official_account", name: account } : undefined,
      delivery: contact ? { app: "wechat", kind, name: contact } : undefined,
      contact,
      topic: account,
      output: "message",
      multiArticle: true,
      articleWindowHours: 48,
      rawInstruction: text
    };
  }

  if (text.includes(officialAccount) && account && summaryWords.test(text)) {
    const kind = contact && /(\u7fa4\u804a|\u7fa4)/.test(contact) ? "group" : "contact";
    return {
      kind: "wechat_article_summary",
      targetApp: "wechat",
      source: { app: "wechat", kind: "official_account", name: account },
      delivery: contact ? { app: "wechat", kind, name: contact } : undefined,
      contact,
      topic: account,
      output: "message",
      rawInstruction: text
    };
  }

  if (new RegExp(`^(?:\\u6253\\u5f00|\\u542f\\u52a8|\\u8fdb\\u5165)\\s*${wechat}\\s*[\\u3002\\uff01!\\?\\uff1f]?$`).test(text)) {
    return {
      kind: "generic",
      targetApp: "wechat",
      output: "summary",
      rawInstruction: text
    };
  }
  return undefined;
}

function parseReadableArticleAccount(text: string): string | undefined {
  const quoted = [...text.matchAll(/["'\u2018\u2019\u201c\u201d\u300c\u300e]([\u4e00-\u9fa5A-Za-z0-9_-]{2,24})["'\u2018\u2019\u201c\u201d\u300d\u300f]\s*\u516c\u4f17\u53f7/gu)]
    .reverse()
    .map((match) => normalizeReadableArticleAccountCandidate(match[1]))
    .find(Boolean);
  if (quoted) return quoted;

  const general = [...text.matchAll(/(?:^|[\s\u3002\uff0c,.])(?:\u5728|\u73b0\u5728|\u6253\u5f00|\u67e5\u770b|\u627e\u5230|\u641c|\u9605\u8bfb|\u8bfb|\u770b\u770b|\u8fdb\u5165)?\s*["'\u2018\u2019\u201c\u201d\u300c\u300e]?([\u4e00-\u9fa5A-Za-z0-9_-]{2,32}?)(?:\u8fd9\u4e2a|\u8be5|\u7684)?["'\u2018\u2019\u201c\u201d\u300d\u300f]?\s*\u516c\u4f17\u53f7/gu)]
    .reverse()
    .map((match) => normalizeReadableArticleAccountCandidate(match[1]))
    .find(Boolean);
  return general;
}

function normalizeReadableArticleAccountCandidate(value: string | undefined): string | undefined {
  const account = cleanup(value
    ?.replace(/^(?:\u4ece.*?\u5f00\u59cb|\u5f53\u524d|\u73b0\u5728|\u5728|\u6253\u5f00|\u67e5\u770b|\u627e\u5230|\u641c|\u9605\u8bfb|\u8bfb|\u770b\u770b|\u8fdb\u5165)+/u, "")
    .replace(/(?:\u8fd9\u4e2a|\u8be5|\u7684)$/u, ""));
  if (!account || /^(?:\u5fae\u4fe1|\u901a\u8baf\u5f55|\u5fae\u4fe1\u901a\u8baf\u5f55|\u5fae\u4fe1\u901a\u8baf\u5f55\u91cc|\u901a\u8baf\u5f55\u91cc|\u516c\u4f17\u53f7|\u6587\u7ae0|\u6700\u65b0\u6587\u7ae0|\u7b2c\u4e00\u7bc7\u6587\u7ae0)$/.test(account)) {
    return undefined;
  }
  return account === "\u673a\u68b0\u4e4b\u5fc3" ? "\u673a\u5668\u4e4b\u5fc3" : account;
}

function inferTargetApp(kind: TaskKind, text: string): ParsedIntent["targetApp"] {
  if (kind === "wechat_article_summary" || kind === "wechat_multi_article_digest" || kind === "wechat_message") return "wechat";
  if (kind === "dianping_food_search") return "dianping";
  if (/微信/.test(text)) return "wechat";
  if (/大众点评|点评/.test(text)) return "dianping";
  return "unknown";
}

function inferKind(text: string): TaskKind {
  if (isSimpleOpenAppInstruction(text)) return "generic";
  if (/公众号/.test(text) && /(48\s*小时|48h|近\s*48|近两天|最近两天|今天|昨天|所有文章|全部文章|多篇|每篇|分别)/i.test(text) && /(总结|整理|发给|发送给|群聊|群)/.test(text)) return "wechat_multi_article_digest";
  if (/公众号|文章|总结.*发给|阅读.*发/.test(text)) return "wechat_article_summary";
  if (/微信.*(?:问问|问一下|告诉|发给|发送给)|(?:问问|问一下)[A-Za-z0-9_\-\u4e00-\u9fa5]{2,8}/.test(text)) return "wechat_message";
  if (/大众点评|点评|美食|餐厅|吃什么|附近.*吃|探店/.test(text)) return "dianping_food_search";
  return "generic";
}

function isSimpleOpenAppInstruction(text: string): boolean {
  return /^(打开|启动|进入|去|上)\s*(微信|大众点评|点评)\s*[。.!！?？]?$/.test(text);
}

function parseAskMessage(text: string): { contact: string; message: string } | undefined {
  const rest = cleanup(text.match(/(?:问问|问一下)([^，。,.\n]+)/)?.[1]);
  if (!rest) return undefined;
  const boundary = findMessageBoundary(rest);
  const contact = cleanup(rest.slice(0, boundary));
  const message = cleanup(rest.slice(boundary));
  return contact && message ? { contact, message } : undefined;
}

function parseArticleAccount(text: string): string | undefined {
  const patterns = [
    /(?:打开|查看|找到|找|阅读|读一下|读|看看|进入|去|上)\s*[“"'\u2018\u2019\u201c\u201d‘’「『《]([A-Za-z0-9_\-\u4e00-\u9fa5]{2,24}?)[”"'\u2018\u2019\u201c\u201d‘’」』》]\s*公众号/u,
    /(?:打开|查看|找到|找|阅读|读一下|读|看看|进入|去|上)[“"'\u2018\u2019\u201c\u201d‘’「『《]?([A-Za-z0-9_\-\u4e00-\u9fa5]{2,24}?)(?:这个|這個|该|該|此|的)?[”"'\u2018\u2019\u201c\u201d‘’」』》]?公众号/u,
    /(?:^|[，。,.\s])[“"'\u2018\u2019\u201c\u201d‘’「『《]?([A-Za-z0-9_\-\u4e00-\u9fa5]{2,24}?)(?:这个|這個|该|該|此|的)?[”"'\u2018\u2019\u201c\u201d‘’」』》]?公众号/u
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const account = normalizeArticleAccount(cleanup(match?.[1]));
    if (account) return account === "机械之心" ? "机器之心" : account;
  }
  return undefined;
}

function normalizeArticleAccount(value?: string): string | undefined {
  const cleaned = cleanup(value
    ?.replace(/(?:这个|這個|该|該|此|的)$/u, "")
    .replace(/(?:这个|這個|该|該|此|的)(?=公众号$)/u, ""));
  if (!cleaned || /^(?:微信|通讯录|微信通讯录|微信通讯录里|通讯录里|公众号|文章|最新文章|首页)$/u.test(cleaned)) return undefined;
  return cleaned;
}

function findMessageBoundary(value: string): number {
  const markers = ["今晚", "晚上", "中午", "早上", "明天", "今天", "吃", "喝", "去", "在", "有没有", "是否", "能不能", "可以", "什么时候", "怎么"];
  const indexes = markers
    .map((marker) => value.indexOf(marker))
    .filter((index) => index >= 2);
  if (indexes.length) return Math.min(...indexes);
  return Math.min(3, value.length);
}

function matchAfter(text: string, regex: RegExp): string | undefined {
  const match = text.match(regex);
  return cleanup(match?.[1]);
}

function cleanup(value?: string): string | undefined {
  const cleaned = value?.replace(/[，。,.;；:：]/g, "").trim();
  return cleaned || undefined;
}
