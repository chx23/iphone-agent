import { createHash } from "node:crypto";
import type { Bounds, ChatMessage, ElementRef, ScreenGraph } from "../../shared/types";

const UI_TEXT = new Set([
  "微信",
  "返回",
  "更多",
  "搜索",
  "快捷操作",
  "语音",
  "语音输入",
  "表情",
  "全屏输入",
  "发送",
  "按住说话",
  "XCUIElementTypeWindow",
  "XCUIElementTypeOther",
  "XCUIElementTypeImage",
  "XCUIElementTypeTable",
  "XCUIElementTypeCell",
  "XCUIElementTypeTextView",
  "XCUIElementTypeStaticText",
  "SystemInputAssistantView",
  "CenterPageView",
  "XCUIElementTypeScrollView",
  "XCUIElementTypeCollectionView"
]);

export function isMonitorChatScreen(screen: ScreenGraph, contact: string): boolean {
  if (!screen.app?.includes("com.tencent.xin")) return false;
  const labels = visibleLabels(screen);
  const hasContactTitle = labels.some((label) => normalize(label) === normalize(contact));
  const hasChatInput = labels.some((label) => /按住说话|语音输入|XCUIElementTypeTextView|全屏输入/.test(label));
  const hasChatChrome = labels.some((label) => label === "返回") && labels.some((label) => label === "更多");
  return hasContactTitle && (hasChatInput || hasChatChrome);
}

export function extractWechatChatMessages(screen: ScreenGraph, contact: string): ChatMessage[] {
  if (!isMonitorChatScreen(screen, contact)) return [];
  const candidates = [...screen.nodes, ...screen.ocrBlocks]
    .filter((node) => isVisibleMessageCandidate(node, contact))
    .map((node) => toChatMessage(node, contact, screen.observedAt))
    .filter((message): message is ChatMessage => Boolean(message));
  return dedupeMessages(candidates)
    .sort((a, b) => (a.bounds?.y ?? 0) - (b.bounds?.y ?? 0));
}

export function latestIncomingMessage(screen: ScreenGraph, contact: string): ChatMessage | undefined {
  return extractWechatChatMessages(screen, contact)
    .filter((message) => message.direction === "incoming")
    .at(-1);
}

function visibleLabels(screen: ScreenGraph): string[] {
  return [...screen.nodes, ...screen.ocrBlocks]
    .map((node) => node.label.trim())
    .filter(Boolean);
}

function isVisibleMessageCandidate(node: ElementRef, contact: string): boolean {
  const label = node.label.trim();
  if (!label) return false;
  if (UI_TEXT.has(label)) return false;
  if (normalize(label) === normalize(contact)) return false;
  if (/^\d{1,2}:\d{2}$/.test(label)) return false;
  if (/^(昨天|今天|星期|周|上午|下午|晚上|\d{1,2}月\d{1,2}日)/.test(label) && label.length <= 16) return false;
  if (/^(头像|图片|视频|语音消息|表情消息)$/.test(label)) return false;
  if (/微信, 微弱的微|我们的我/.test(label)) return false;
  if (!node.bounds) return label.startsWith("我,") || label.length >= 2;
  if (node.bounds.y < 260) return false;
  if (node.bounds.y > 2260 && !label.startsWith("我,")) return false;
  return label.length >= 2;
}

function toChatMessage(node: ElementRef, contact: string, observedAt: number): ChatMessage | undefined {
  const parsed = parseMessageLabel(node.label);
  if (!parsed.text) return undefined;
  const signature = messageSignature(contact, parsed.direction, parsed.text, node.bounds);
  return {
    id: signature,
    signature,
    contact,
    direction: parsed.direction,
    text: parsed.text,
    timestampLabel: parsed.timestampLabel,
    bounds: node.bounds,
    observedAt
  };
}

function parseMessageLabel(label: string): { direction: "incoming" | "outgoing"; text: string; timestampLabel?: string } {
  const compact = label.replace(/\s+/g, " ").trim();
  if (compact.startsWith("我,")) {
    return { direction: "outgoing", text: cleanupMessageText(compact.slice(2)) };
  }
  const timestampMatch = compact.match(/^(.*?),(昨天|今天|\d{1,2}:\d{2}|\d{1,2}月\d{1,2}日)$/);
  if (timestampMatch) {
    return { direction: "incoming", text: cleanupMessageText(timestampMatch[1]), timestampLabel: timestampMatch[2] };
  }
  return { direction: "incoming", text: cleanupMessageText(compact) };
}

function cleanupMessageText(text: string): string {
  return text
    .replace(/^\s*(?:头像|昵称)\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeMessages(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  const output: ChatMessage[] = [];
  for (const message of messages) {
    if (seen.has(message.signature)) continue;
    seen.add(message.signature);
    output.push(message);
  }
  return output;
}

function messageSignature(contact: string, direction: string, text: string, bounds?: Bounds): string {
  const rounded = bounds
    ? `${Math.round(bounds.x / 8)}:${Math.round(bounds.y / 8)}:${Math.round(bounds.width / 8)}:${Math.round(bounds.height / 8)}`
    : "no-bounds";
  return createHash("sha1")
    .update(`${normalize(contact)}|${direction}|${normalize(text)}|${rounded}`)
    .digest("hex")
    .slice(0, 20);
}

function normalize(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}
