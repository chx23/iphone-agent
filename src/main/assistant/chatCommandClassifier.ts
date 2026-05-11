import type { ChatCommand, ChatMessage } from "../../shared/types";
import { safeError, truncate } from "../utils";
import type { LlmClient } from "../llmClient";

interface ModelCommandOutput {
  kind?: string;
  k?: string;
  confidence?: number;
  c?: number;
  instruction?: string;
  i?: string;
  reply?: string;
  r?: string;
  needsConfirmation?: boolean;
  confirm?: boolean;
  approved?: boolean;
  reason?: string;
}

export class ChatCommandClassifier {
  constructor(private readonly llm?: LlmClient) {}

  async classify(message: ChatMessage, context: { monitorContact: string; hasRunningJob: boolean; hasPendingConfirmation: boolean }): Promise<ChatCommand> {
    const heuristic = classifyByHeuristic(message.text, context);
    if (!this.llm) return heuristic;
    try {
      const model = await this.llm.completeJson<ModelCommandOutput>(
        classifierSystemPrompt(),
        classifierUserPrompt(message, context, heuristic),
        { mode: "route", timeoutMs: 15000, maxPromptChars: 2200 }
      );
      return normalizeModelCommand(model, heuristic);
    } catch (error) {
      return {
        ...heuristic,
        reason: `LLM 分类失败，使用本地规则：${safeError(error)}`
      };
    }
  }
}

export function classifyByHeuristic(text: string, context: { hasRunningJob: boolean; hasPendingConfirmation: boolean }): ChatCommand {
  const value = text.trim();
  if (!value) return { kind: "chat", confidence: 0.4 };
  if (/^(取消|别做了|停止|停一下|算了|cancel)$/i.test(value)) {
    return { kind: "cancel", confidence: 0.92, reply: context.hasRunningJob ? "收到，我会停止当前任务。" : "当前没有正在执行的任务。" };
  }
  if (/^(暂停|pause)$/i.test(value)) return { kind: "pause", confidence: 0.9, reply: "收到，先暂停。" };
  if (/^(继续|resume)$/i.test(value)) return { kind: "resume", confidence: 0.9, reply: "收到，继续处理。" };
  if (/^(状态|进度|现在到哪了|status)$/i.test(value)) return { kind: "status", confidence: 0.92 };
  if (/^(确认|可以|同意|执行|发吧|发送|ok|yes)$/i.test(value)) {
    return { kind: "confirm", confidence: context.hasPendingConfirmation ? 0.96 : 0.72, approved: true };
  }
  if (/^(取消确认|不确认|不要|否|no)$/i.test(value)) {
    return { kind: "confirm", confidence: context.hasPendingConfirmation ? 0.96 : 0.72, approved: false };
  }
  if (looksLikeTask(value)) {
    return {
      kind: "task",
      confidence: 0.78,
      instruction: value,
      reply: "收到，我开始处理。"
    };
  }
  return { kind: "chat", confidence: 0.72, reply: undefined };
}

function classifierSystemPrompt(): string {
  return [
    "你是 phone-agent 的微信消息分类器，只返回 JSON。",
    "把控制者发来的消息分类为 chat/task/status/cancel/pause/resume/confirm/clarify。",
    "task 表示要操作手机、查网页、读公众号、发消息、浏览 App、总结信息等。",
    "普通寒暄、无明确行动要求的消息是 chat。",
    "如果是 task，instruction 字段保留可直接执行的中文任务。",
    "如果信息不够执行，kind=clarify 并在 reply 中提出一个简短问题。",
    "紧凑格式：{\"kind\":\"task\",\"confidence\":0.9,\"instruction\":\"...\",\"reply\":\"...\",\"needsConfirmation\":false}"
  ].join("\n");
}

function classifierUserPrompt(
  message: ChatMessage,
  context: { monitorContact: string; hasRunningJob: boolean; hasPendingConfirmation: boolean },
  heuristic: ChatCommand
): string {
  return JSON.stringify({
    from: context.monitorContact,
    text: message.text,
    hasRunningJob: context.hasRunningJob,
    hasPendingConfirmation: context.hasPendingConfirmation,
    localGuess: heuristic
  });
}

function normalizeModelCommand(model: ModelCommandOutput | undefined, fallback: ChatCommand): ChatCommand {
  if (!model) return fallback;
  const kind = normalizeKind(model.kind ?? model.k);
  const confidence = clampConfidence(model.confidence ?? model.c ?? fallback.confidence);
  if (!kind) return fallback;
  return {
    kind,
    confidence,
    instruction: truncate((model.instruction ?? model.i ?? fallback.instruction ?? "").trim(), 800) || undefined,
    reply: truncate((model.reply ?? model.r ?? fallback.reply ?? "").trim(), 240) || undefined,
    needsConfirmation: Boolean(model.needsConfirmation ?? model.confirm ?? fallback.needsConfirmation),
    approved: typeof model.approved === "boolean" ? model.approved : fallback.approved,
    reason: truncate((model.reason ?? fallback.reason ?? "").trim(), 240) || undefined
  };
}

function normalizeKind(value: string | undefined): ChatCommand["kind"] | undefined {
  if (!value) return undefined;
  if (["chat", "task", "status", "cancel", "pause", "resume", "confirm", "clarify"].includes(value)) {
    return value as ChatCommand["kind"];
  }
  return undefined;
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5));
}

function looksLikeTask(value: string): boolean {
  return /(帮我|麻烦|请|查|搜索|搜一下|联网|新闻|资料|打开|浏览|阅读|读|总结|公众号|大众点评|美食|餐厅|发给|发送给|转发给|问问|告诉|收集|整理|执行|任务|http:\/\/|https:\/\/)/i.test(value);
}
