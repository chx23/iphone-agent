import type { ElementRef, ScreenGraph } from "../../shared/types";
import { truncate } from "../utils";

export interface ArticleListItem {
  title: string;
  publishedAt?: string;
  relativeTimeLabel?: string;
  elementId: string;
  signature: string;
  withinWindow: boolean;
  positionText: string;
}

export interface ArticleListScanState {
  account: string;
  nowIso: string;
  windowHours: number;
  screenCount: number;
  maxScreens: number;
  items: ArticleListItem[];
  skippedOldItems: ArticleListItem[];
  lastScreenSignature?: string;
  stableNoNewCount: number;
  boundaryConfirmScreens: number;
  sawOldBoundary: boolean;
  exhausted: boolean;
}

export interface ArticleDigest {
  title: string;
  publishedAt?: string;
  summary: string;
  sourceLines: string[];
}

export interface MultiArticleDigestState {
  account: string;
  deliveryName: string;
  windowHours: number;
  scan: ArticleListScanState;
  readSignatures: Set<string>;
  digests: ArticleDigest[];
  currentArticle?: ArticleListItem;
  finalDigestMessage?: string;
}

const CN = {
  ago: "\u524d",
  article: "\u6587\u7ae0",
  autoByAgent: "\uff08phone-agent \u81ea\u52a8\u6574\u7406\uff09",
  day: "\u65e5",
  digestPrefixA: "\u6211\u6574\u7406\u4e86",
  digestPrefixB: "\u8fd148\u5c0f\u65f6\u7684\u66f4\u65b0\uff0c\u5171",
  digestPrefixC: "\u7bc7\u3002",
  hour: "\u5c0f\u65f6",
  minute: "\u5206\u949f",
  month: "\u6708",
  today: "\u4eca\u5929",
  yesterday: "\u6628\u5929",
  year: "\u5e74"
} as const;

export function createArticleListScanState(account: string, now: Date, windowHours: number): ArticleListScanState {
  return {
    account,
    nowIso: now.toISOString(),
    windowHours,
    screenCount: 0,
    maxScreens: 80,
    items: [],
    skippedOldItems: [],
    stableNoNewCount: 0,
    boundaryConfirmScreens: 0,
    sawOldBoundary: false,
    exhausted: false
  };
}

export function updateArticleListScanState(state: ArticleListScanState, screen: ScreenGraph): { added: ArticleListItem[]; skippedOld: ArticleListItem[]; screenSignature: string } {
  const now = new Date(state.nowIso);
  const screenSignature = articleListScreenSignature(screen);
  const beforeKeys = new Set(state.items.map(articleDedupeKey));
  const beforeSkipped = new Set(state.skippedOldItems.map(articleDedupeKey));
  const hadOldBoundary = state.sawOldBoundary;
  const extracted = extractWechatArticleListItems(screen, state.account, now, state.windowHours);
  const added: ArticleListItem[] = [];
  const skippedOld: ArticleListItem[] = [];

  for (const item of extracted) {
    if (item.withinWindow) {
      const key = articleDedupeKey(item);
      if (beforeKeys.has(key)) continue;
      beforeKeys.add(key);
      state.items.push(item);
      added.push(item);
    } else {
      state.sawOldBoundary = true;
      const key = articleDedupeKey(item);
      if (beforeSkipped.has(key)) continue;
      beforeSkipped.add(key);
      state.skippedOldItems.push(item);
      skippedOld.push(item);
    }
  }

  const sameScreen = state.lastScreenSignature === screenSignature;
  if (added.length === 0 && sameScreen) {
    state.stableNoNewCount += 1;
  } else if (added.length > 0) {
    state.stableNoNewCount = 0;
  }

  if (hadOldBoundary && added.length === 0) state.boundaryConfirmScreens += 1;
  state.screenCount += 1;
  state.lastScreenSignature = screenSignature;
  state.exhausted = state.screenCount >= state.maxScreens;
  state.items.sort(compareArticleListItems);
  return { added, skippedOld, screenSignature };
}

export function isArticleListScanComplete(state: ArticleListScanState): boolean {
  if (state.exhausted) return false;
  if (state.sawOldBoundary && state.boundaryConfirmScreens >= 1) return true;
  return state.stableNoNewCount >= 3;
}

export function parseWechatArticlePublishTime(label: string, now: Date): Date | undefined {
  const text = label.replace(/\s+/g, " ").trim();
  if (new RegExp(`^${CN.minute}?${CN.ago}?$`).test(text) || text === "\u521a\u521a") return new Date(now);

  const relativeHours = text.match(new RegExp(`(\\d{1,3})\\s*(?:${CN.hour}|h|H)\\s*${CN.ago}?`));
  if (relativeHours) return new Date(now.getTime() - Number(relativeHours[1]) * 60 * 60 * 1000);
  const relativeMinutes = text.match(new RegExp(`(\\d{1,3})\\s*${CN.minute}\\s*${CN.ago}?`));
  if (relativeMinutes) return new Date(now.getTime() - Number(relativeMinutes[1]) * 60 * 1000);

  const today = text.match(new RegExp(`${CN.today}\\s*(\\d{1,2}):(\\d{2})?`));
  if (today) return atLocalTime(now, 0, Number(today[1]), Number(today[2] ?? 0));
  const yesterday = text.match(new RegExp(`${CN.yesterday}\\s*(\\d{1,2}):(\\d{2})?`));
  if (yesterday) return atLocalTime(now, -1, Number(yesterday[1]), Number(yesterday[2] ?? 0));

  const full = text.match(new RegExp(`(20\\d{2})\\s*${CN.year}\\s*(\\d{1,2})\\s*${CN.month}\\s*(\\d{1,2})\\s*${CN.day}(?:\\s*(\\d{1,2}):(\\d{2}))?`));
  if (full) return new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]), Number(full[4] ?? 0), Number(full[5] ?? 0));

  const monthDay = text.match(new RegExp(`(\\d{1,2})\\s*${CN.month}\\s*(\\d{1,2})\\s*${CN.day}(?:\\s*(\\d{1,2}):(\\d{2}))?`));
  if (monthDay) return new Date(now.getFullYear(), Number(monthDay[1]) - 1, Number(monthDay[2]), Number(monthDay[3] ?? 0), Number(monthDay[4] ?? 0));

  const slash = text.match(/(\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (slash) return new Date(now.getFullYear(), Number(slash[1]) - 1, Number(slash[2]), Number(slash[3] ?? 0), Number(slash[4] ?? 0));
  return undefined;
}

export function extractWechatArticleListItems(screen: ScreenGraph, account: string, now: Date, windowHours: number): ArticleListItem[] {
  const elements = [...screen.nodes, ...screen.ocrBlocks].filter((node) => node.bounds && isProbablyVisible(screen, node));
  const result: ArticleListItem[] = [];

  for (const element of elements) {
    const label = compactLabel(element.label);
    if (!label || isBlockedArticleListLabel(label, account)) continue;

    const publishedAt = parseWechatArticlePublishTime(label, now);
    if (publishedAt) {
      const title = cleanTitleFromTimeLabel(label);
      const titleNode = title.length >= 6 ? element : nearbyTitleNode(elements, element, account, now);
      const finalTitle = title.length >= 6 ? title : titleNode?.label.trim();
      if (finalTitle && finalTitle.length >= 6 && !isBlockedArticleListLabel(finalTitle, account)) {
        result.push(toArticleListItem(titleNode ?? element, finalTitle, label, publishedAt, now, windowHours, screen));
      }
      continue;
    }

    const nearbyTime = nearbyTimeNode(elements, element, now);
    if (nearbyTime?.publishedAt && label.length >= 8 && !isBlockedArticleListLabel(label, account)) {
      result.push(toArticleListItem(element, label, nearbyTime.label, nearbyTime.publishedAt, now, windowHours, screen));
    }
  }

  return dedupeItems(result);
}

export function composeMultiArticleDigestMessage(account: string, digests: ArticleDigest[], _deliveryName?: string): string {
  const safeDigests = digests.filter((digest) => digest.title.trim() && digest.summary.trim());
  const prefix = `${CN.digestPrefixA}${account}${CN.digestPrefixB}${safeDigests.length}${CN.digestPrefixC}`;
  const body = safeDigests.map((digest, index) => {
    const title = truncate(sanitizeInline(digest.title), 36);
    const summary = truncate(sanitizeInline(digest.summary), 170);
    return `${index + 1}.\u300a${title}\u300b\uff1a${summary}`;
  }).join(" ");
  return sanitizeInline(`${prefix} ${body} ${CN.autoByAgent}`);
}

function toArticleListItem(
  element: ElementRef,
  title: string,
  relativeTimeLabel: string,
  publishedAt: Date,
  now: Date,
  windowHours: number,
  screen: ScreenGraph
): ArticleListItem {
  const positionText = `${screen.app ?? "unknown"}:${Math.round((element.bounds?.y ?? 0) / 80)}`;
  const withinWindow = now.getTime() - publishedAt.getTime() <= windowHours * 60 * 60 * 1000;
  const cleanedTitle = cleanArticleTitle(title);
  return {
    title: cleanedTitle,
    publishedAt: publishedAt.toISOString(),
    relativeTimeLabel,
    elementId: element.id,
    positionText,
    withinWindow,
    signature: articleSignature(cleanedTitle, publishedAt.toISOString(), positionText)
  };
}

function compareArticleListItems(a: ArticleListItem, b: ArticleListItem): number {
  const timeA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
  const timeB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
  return timeB - timeA;
}

function cleanTitleFromTimeLabel(label: string): string {
  return cleanArticleTitle(label
    .replace(new RegExp(`${CN.today}\\s*\\d{1,2}:\\d{2}`, "g"), "")
    .replace(new RegExp(`${CN.yesterday}\\s*\\d{1,2}:\\d{2}`, "g"), "")
    .replace(new RegExp(`\\d{1,3}\\s*(?:${CN.hour}|h|H)\\s*${CN.ago}?`, "g"), "")
    .replace(new RegExp(`\\d{1,3}\\s*${CN.minute}\\s*${CN.ago}?`, "g"), "")
    .replace(new RegExp(`20\\d{2}\\s*${CN.year}\\s*\\d{1,2}\\s*${CN.month}\\s*\\d{1,2}\\s*${CN.day}(?:\\s*\\d{1,2}:\\d{2})?`, "g"), "")
    .replace(new RegExp(`\\d{1,2}\\s*${CN.month}\\s*\\d{1,2}\\s*${CN.day}(?:\\s*\\d{1,2}:\\d{2})?`, "g"), "")
    .replace(/[-~|,，。；：:]/g, " "));
}

function cleanArticleTitle(title: string): string {
  return title.replace(/\s+/g, " ").replace(/^[-\s]+/, "").trim();
}

function nearbyTitleNode(elements: ElementRef[], timeNode: ElementRef, account: string, now: Date): ElementRef | undefined {
  const y = timeNode.bounds?.y ?? 0;
  return elements
    .filter((node) => {
      const bounds = node.bounds;
      const label = compactLabel(node.label);
      return Boolean(bounds
        && bounds.y >= y
        && bounds.y <= y + 320
        && label.length >= 8
        && !isBlockedArticleListLabel(label, account)
        && !parseWechatArticlePublishTime(label, now));
    })
    .sort((a, b) => (a.bounds?.y ?? 0) - (b.bounds?.y ?? 0))[0];
}

function nearbyTimeNode(elements: ElementRef[], titleNode: ElementRef, now: Date): { label: string; publishedAt: Date } | undefined {
  const y = titleNode.bounds?.y ?? 0;
  const candidates = elements
    .map((node) => ({ node, publishedAt: parseWechatArticlePublishTime(node.label, now) }))
    .filter((item): item is { node: ElementRef; publishedAt: Date } => Boolean(item.publishedAt && item.node.bounds))
    .filter((item) => {
      const timeY = item.node.bounds?.y ?? 0;
      return timeY >= y - 220 && timeY <= y + 180;
    })
    .sort((a, b) => Math.abs((a.node.bounds?.y ?? 0) - y) - Math.abs((b.node.bounds?.y ?? 0) - y));
  const best = candidates[0];
  return best ? { label: best.node.label, publishedAt: best.publishedAt } : undefined;
}

function dedupeItems(items: ArticleListItem[]): ArticleListItem[] {
  const seen = new Map<string, ArticleListItem>();
  for (const item of items) {
    const key = articleDedupeKey(item);
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()].sort(compareArticleListItems);
}

function articleDedupeKey(item: Pick<ArticleListItem, "title" | "publishedAt">): string {
  return `${normalizeText(item.title)}:${item.publishedAt ?? ""}`;
}

function articleSignature(title: string, publishedAt: string, positionText: string): string {
  return `${normalizeText(title)}:${publishedAt}:${positionText}`;
}

function articleListScreenSignature(screen: ScreenGraph): string {
  return [...screen.nodes, ...screen.ocrBlocks]
    .filter((node) => node.bounds && isProbablyVisible(screen, node))
    .map((node) => `${Math.round((node.bounds?.y ?? 0) / 80)}:${normalizeText(node.label).slice(0, 60)}`)
    .slice(0, 50)
    .join("|");
}

function isBlockedArticleListLabel(label: string, account: string): boolean {
  if (!label || label === account) return true;
  const blocked = [
    "\u53d1\u6d88\u606f",
    "\u79c1\u4fe1",
    "\u5173\u6ce8",
    "\u5df2\u5173\u6ce8",
    "\u516c\u4f17\u53f7",
    "\u641c\u7d22",
    "\u8fd4\u56de",
    "\u66f4\u591a",
    "\u89c6\u9891\u53f7",
    "\u5546\u54c1\u6a71\u7a97",
    "\u76f4\u64ad",
    "\u9884\u7ea6",
    "\u5e7f\u544a",
    "\u8d5e",
    "\u5728\u770b",
    "\u7559\u8a00",
    "\u9605\u8bfb\u539f\u6587",
    "\u5168\u90e8\u6587\u7ae0",
    "\u4e3b\u9875",
    "\u7f6e\u9876",
    "\u8d44\u6599\u5361"
  ];
  if (blocked.some((token) => label.includes(token))) return true;
  return /\b(live|ad|video)\b/i.test(label);
}

function atLocalTime(now: Date, dayOffset: number, hour: number, minute: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minute);
}

function compactLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, "").replace(/[\p{P}\p{S}]/gu, "").toLowerCase();
}

function sanitizeInline(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function isProbablyVisible(screen: ScreenGraph, element: ElementRef): boolean {
  const bounds = element.bounds;
  if (!bounds) return false;
  const height = screen.screenSize?.height ?? 2532;
  const width = screen.screenSize?.width ?? 1170;
  return bounds.x + bounds.width > 0 && bounds.x < width && bounds.y + bounds.height > 0 && bounds.y < height;
}
