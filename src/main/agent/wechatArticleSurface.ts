import type { ElementRef, ScreenGraph } from "../../shared/types";

export interface WechatArticleText {
  title: string;
  lines: string[];
  screenSignature: string;
  contentSignature: string;
  visualSignature?: string;
  reachedEnd: boolean;
  reachedStart: boolean;
}

export interface WechatArticleSurfaceDetection {
  ok: boolean;
  reason: string;
  articleText?: WechatArticleText;
}

export function extractWechatArticleText(screen: ScreenGraph, account: string, allowContinuation = false): WechatArticleText | undefined {
  return detectWechatArticleSurface(screen, account, allowContinuation).articleText;
}

export function detectWechatArticleSurface(screen: ScreenGraph, account: string, allowContinuation = false): WechatArticleSurfaceDetection {
  if (!isWechatScreen(screen)) return { ok: false, reason: "not_wechat" };

  const elements = [...screen.nodes, ...screen.ocrBlocks];
  const visibleElements = visibleArticleElements(screen, elements);
  const labels = visibleElements
    .map((node) => node.label.trim())
    .filter(Boolean);
  const text = labels.join(" ");
  const rawText = `${screen.rawSource ?? ""} ${text}`;

  const blockedReason = classifyNonArticleWechatSurface(screen, labels, text);
  if (blockedReason) return { ok: false, reason: blockedReason };

  const reachedEnd = hasWechatArticleEndEvidence(screen, visibleElements);
  const reachedStart = hasWechatArticleStartEvidence(visibleElements, account);
  const screenSignature = articleScreenSignature(visibleElements);
  const contentSignature = articleContentSignature(visibleElements);
  const visualSignature = screen.screenshotBase64 ? sampledStringHash(screen.screenshotBase64) : undefined;
  const hasAccount = labels.some((label) => label.includes(account));
  const articleMarkerCount = [
    "阅读原文",
    "写留言",
    "喜欢作者",
    "在看",
    "原创",
    "作者",
    "发布",
    "发布于",
    "收录于合集",
    "微信扫一扫"
  ].filter((marker) => text.includes(marker)).length;
  const hasArticleDate = labels.some((label) => /\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}日/.test(label));
  const hasPublisherLine = labels.some((label) => label.includes(account) && label.includes("发布"));
  const contentLines = extractArticleContentLines(labels, account);
  const longTextCount = contentLines.filter((label) => label.length >= 24).length;
  const webViewLike = /XCUIElementTypeWebView|MMWebView|WeixinJSBridge|js_article/.test(rawText);
  const hasArticleChrome = /阅读原文|写留言|喜欢作者|在看|赞|留言|作者|原创|发布于|分享|更多/.test(text);
  const hasArticleIdentity = (hasAccount && (hasArticleDate || hasPublisherLine || articleMarkerCount >= 1))
    || articleMarkerCount >= 2
    || reachedEnd;
  const continuationLooksLikeArticle = allowContinuation
    && webViewLike
    && contentLines.length >= 2
    && longTextCount >= 2;
  const initialLooksLikeArticle = webViewLike
    && contentLines.length >= 2
    && longTextCount >= 2
    && (hasArticleChrome || hasArticleDate || hasAccount);

  if (!hasArticleIdentity && !continuationLooksLikeArticle && !initialLooksLikeArticle) {
    return { ok: false, reason: "missing_article_identity" };
  }
  if (!allowContinuation && !hasArticleIdentity && !initialLooksLikeArticle) {
    return { ok: false, reason: "weak_initial_article_signal" };
  }
  if (!contentLines.length) return { ok: false, reason: "no_article_content" };

  const title = contentLines.find((label) => label.length >= 8 && label.length <= 80 && !label.includes(account)) ?? "最新文章";
  const lines = dedupe(contentLines.filter((line) => line !== title)).slice(0, 40);
  return {
    ok: true,
    reason: reachedEnd ? "article_end_visible" : allowContinuation ? "article_continuation" : "article_detail",
    articleText: {
      title,
      lines,
      screenSignature,
      contentSignature,
      visualSignature,
      reachedEnd,
      reachedStart
    }
  };
}

function classifyNonArticleWechatSurface(screen: ScreenGraph, labels: string[], text: string): string | undefined {
  const rawSource = screen.rawSource ?? "";
  const compactText = normalizeText(text);
  const articleLikeWebView = hasWechatArticleLikeWebView(rawSource, labels, text);
  if (hasWechatBottomTabBar(labels, text) || /XCUIElementTypeTabBar\b[^>]*label="标签页栏"/.test(rawSource)) return "wechat_bottom_tab_bar";
  if (/快捷操作/.test(text) && /搜索/.test(text) && /置顶聊天|消息免打扰|未读|公众号|\d{1,2}:\d{2}|\d{1,2}月\d{1,2}日/.test(text)) return "wechat_recent_chats";
  if (/通讯录/.test(text) && /新的朋友|群聊|标签|公众号|企业微信联系人/.test(text)) return "wechat_contacts";
  if (/公众号/.test(text) && /搜索|新的公众号|公众号列表|订阅号/.test(text) && !/阅读原文|写留言|发布于/.test(text)) return "wechat_official_accounts_list";
  if (/搜索本地|网络结果|最近在搜|大家都在搜|相关搜索|问元宝|图片搜索|文件搜索/.test(text) || screen.keyboardVisible) return "wechat_search";
  if (/内容由AI生成|问 AI|继续提问|切换模型|AI搜索/.test(text)) return "wechat_ai_search";
  if (!articleLikeWebView && /私信|不再关注|已关注公众号|篇原创内容|商品橱窗|视频号:|全部预告|账号描述/.test(text)) return "wechat_account_home";
  if (isLikelyWechatChatConversation(labels, text)) return "wechat_chat";
  if (!articleLikeWebView && (/WCFinder|弹幕|播放|轻触重试|推荐给朋友/.test(text) || labels.some((label) => /^喜欢[:：]\d+|^评论\d+|^赞过\d+|^分享\d+/.test(label)))) return "wechat_video_feed";
  if (!articleLikeWebView && /视频号直播|微信扫码预约|分享给朋友|预约/.test(text) && /直播|预告|开发者大会|Create/.test(text) && !/阅读原文|写留言|喜欢作者|在看/.test(text)) return "wechat_live_preview";
  if (/公众号未读|公众号\[?\d+条\]?/.test(compactText)) return "wechat_recent_chats";
  return undefined;
}

function hasWechatArticleLikeWebView(rawSource: string, labels: string[], text: string): boolean {
  const webViewLike = /XCUIElementTypeWebView|MMWebView|WeixinJSBridge|js_article/.test(rawSource)
    || labels.some((label) => /XCUIElementTypeWebView|MMWebView|WeixinJSBridge|js_article/.test(label));
  if (!webViewLike) return false;
  const longTextCount = labels.filter((label) => label.trim().length >= 24 && !/^XCUIElementType/.test(label)).length;
  const hasArticleChrome = /阅读原文|写留言|喜欢作者|在看|赞\s*\d+|分享\s*\d+|留言\s*\d+|作者|原创|发布|更多/.test(text);
  const hasArticleDate = /\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}日/.test(text);
  return longTextCount >= 2 && (hasArticleChrome || hasArticleDate);
}

function isWechatScreen(screen: ScreenGraph): boolean {
  return Boolean(screen.app?.includes("com.tencent.xin"))
    || [...screen.nodes, ...screen.ocrBlocks].some((node) => node.label === "微信");
}

function hasWechatBottomTabBar(labels: string[], text: string): boolean {
  const labelSet = new Set(labels);
  return /标签页栏/.test(text)
    && ((labelSet.has("微信") && labelSet.has("通讯录") && labelSet.has("发现") && labelSet.has("我"))
      || (/微信/.test(text) && /通讯录/.test(text) && /发现/.test(text) && /我/.test(text)));
}

function extractArticleContentLines(labels: string[], account: string): string[] {
  return labels
    .filter((label) => label.length >= 12)
    .filter((label) => !/返回|更多|分享|收藏|复制|搜索|发送|留言|赞|在看|阅读原文|投诉|广告|微信扫一扫|语音|表情|按住说话|输入/.test(label))
    .filter((label) => !isArticleMetadataLine(label, account))
    .filter((label) => !isLikelyChatTranscriptLine(label))
    .filter((label) => !/^XCUIElementType/.test(label));
}

function visibleArticleElements(screen: ScreenGraph, elements: ElementRef[]): ElementRef[] {
  return elements.filter((element) => {
    if (!element.label.trim()) return false;
    return isProbablyVisibleOnScreen(screen, element);
  });
}

function articleScreenSignature(elements: ElementRef[]): string {
  return elements
    .map((element) => {
      const label = normalizeText(element.label).slice(0, 80);
      if (!label) return "";
      const y = element.bounds ? Math.round(element.bounds.y / 40) * 40 : 0;
      const height = element.bounds ? Math.round(element.bounds.height / 20) * 20 : 0;
      return `${y}:${height}:${label}`;
    })
    .filter(Boolean)
    .slice(0, 80)
    .join("|");
}

function articleContentSignature(elements: ElementRef[]): string {
  return elements
    .map((element) => normalizeText(element.label).slice(0, 120))
    .filter(Boolean)
    .slice(0, 60)
    .join("|");
}

function hasWechatArticleEndEvidence(screen: ScreenGraph, elements: ElementRef[]): boolean {
  const height = screen.screenSize?.height ?? inferContentHeight(elements);
  return elements
    .filter((element) => isWechatArticleEndMarker(element.label))
    .some((element) => {
      const bounds = element.bounds;
      if (!bounds || !height) return false;
      const centerY = bounds.y + bounds.height / 2;
      return centerY >= height * 0.45 && isProbablyVisibleOnScreen(screen, element);
    });
}

function hasWechatArticleStartEvidence(elements: ElementRef[], account: string): boolean {
  const labels = elements.map((element) => element.label.trim()).filter(Boolean);
  const text = labels.join(" ");
  return labels.some((label) => label.includes(account))
    && (
      labels.some((label) => /\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}日/.test(label))
      || new RegExp(`${escapeRegExp(account)}\\s*发布`).test(text)
      || /原创|作者|发布于/.test(text)
    );
}

function isProbablyVisibleOnScreen(screen: ScreenGraph, element: ElementRef): boolean {
  const bounds = element.bounds;
  if (!bounds) return element.clickable !== false;
  if (element.clickable === false) return false;
  const viewport = screen.screenSize;
  if (!viewport) return bounds.y + bounds.height > 0;
  const visibleWidth = Math.min(bounds.x + bounds.width, viewport.width) - Math.max(bounds.x, 0);
  const visibleHeight = Math.min(bounds.y + bounds.height, viewport.height) - Math.max(bounds.y, 0);
  return visibleWidth > 8 && visibleHeight > 8;
}

function isWechatArticleEndMarker(label: string): boolean {
  const normalized = label.trim();
  return normalized === "阅读原文"
    || normalized === "写留言"
    || normalized === "喜欢作者"
    || normalized === "在看"
    || normalized === "赞"
    || normalized.includes("微信扫一扫");
}

function inferContentHeight(elements: ElementRef[]): number | undefined {
  const bottoms = elements
    .map((element) => element.bounds ? element.bounds.y + element.bounds.height : undefined)
    .filter((value): value is number => typeof value === "number");
  return bottoms.length ? Math.max(...bottoms) : undefined;
}

function isArticleMetadataLine(label: string, account: string): boolean {
  const normalized = label.replace(/\s+/g, " ").trim();
  return normalized === account
    || normalized === "原创"
    || normalized === "置顶"
    || /^发布于：?/.test(normalized)
    || /^\d{4}年\d{1,2}月\d{1,2}日\s*\d{0,2}:?\d{0,2}$/.test(normalized)
    || new RegExp(`^${escapeRegExp(account)}\\s*发布`).test(normalized)
    || /^(作者|编辑|机器之心编辑部)[:：]/.test(normalized);
}

function isLikelyWechatChatConversation(labels: string[], text: string): boolean {
  const chatTranscriptLines = labels.filter(isLikelyChatTranscriptLine).length;
  const hasChatComposer = /语音输入|按住说话|表情|发送/.test(text) && /切换到键盘|输入框|加号|更多功能|XCUIElementTypeTextView/.test(text);
  const hasContactHeader = labels.some((label) => /^返回.*\d+条消息$/.test(label) || /^.+\(.*\)$/.test(label));
  return chatTranscriptLines >= 2 || hasChatComposer || hasContactHeader;
}

function isLikelyChatTranscriptLine(label: string): boolean {
  return /^(我|你|对方|微信用户)[，,]\s*/.test(label) || /^\d{1,2}:\d{2}$/.test(label);
}

function sampledStringHash(value: string): string {
  let hash = 2166136261;
  const step = Math.max(1, Math.floor(value.length / 4096));
  for (let index = 0; index < value.length; index += step) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${hash >>> 0}`;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
