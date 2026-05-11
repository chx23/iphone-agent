import type { DiagnosticEvent, LlmModelInfo } from "../shared/types";
import { now, safeError, truncate } from "./utils";

type DiagnosticSink = (event: Omit<DiagnosticEvent, "id" | "timestamp">) => void;

interface CompleteJsonOptions {
  timeoutMs?: number;
  temperature?: number;
  mode?: "route" | "recovery" | "summary";
  maxPromptChars?: number;
}

export class LlmRequestError extends Error {
  constructor(message: string, readonly status?: number, readonly statusText?: string, readonly provider: "llm" | "vision" = "llm") {
    super(message);
    this.name = "LlmRequestError";
  }
}

export class LlmClient {
  constructor(
    private readonly getApiUrl: () => string,
    private readonly getApiKey: () => string | undefined,
    private readonly getModel: () => string,
    private readonly diagnostics?: DiagnosticSink
  ) {}

  async probeModels(): Promise<{ ok: boolean; models: string[]; message: string }> {
    const apiKey = this.getApiKey();
    if (!apiKey) return { ok: false, models: [], message: "Language model API key is not configured." };
    const startedAt = now();
    try {
      const response = await fetch(modelsUrl(this.getApiUrl()), {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000)
      });
      this.log("probe", response.ok ? "ok" : "failed", `Language model probe ${response.status}`, { status: response.status, elapsedMs: now() - startedAt });
      if (!response.ok) {
        return { ok: false, models: [], message: `Language model probe failed: ${response.status} ${response.statusText}` };
      }
      const payload = (await response.json()) as { data?: LlmModelInfo[] };
      const models = payload.data?.map((model) => model.id).filter(Boolean) ?? [];
      return {
        ok: models.length > 0,
        models,
        message: models.length > 0 ? `Found ${models.length} models.` : "Model endpoint is reachable but returned no model list."
      };
    } catch (error) {
      const message = `Language model probe failed: ${safeError(error)}`;
      this.log("probe", "failed", message, { elapsedMs: now() - startedAt });
      return { ok: false, models: [], message };
    }
  }

  async completeJson<T>(system: string, user: string, options: CompleteJsonOptions = {}): Promise<T | undefined> {
    const apiKey = this.getApiKey();
    if (!apiKey) return undefined;
    const model = this.getModel();
    const chosenModel = model === "auto" ? (await this.probeModels()).models[0] : model;
    if (!chosenModel) return undefined;

    const startedAt = now();
    const timeoutMs = options.timeoutMs ?? 30000;
    const packedPrompt = packPrompt(system, user, options.maxPromptChars);
    this.log("chat_json", "running", "Language model request started.", {
      model: chosenModel,
      mode: options.mode ?? "route",
      promptChars: packedPrompt.system.length + packedPrompt.user.length,
      originalPromptChars: system.length + user.length,
      timeoutMs
    });
    let response: Response;
    try {
      response = await fetch(chatCompletionsUrl(this.getApiUrl()), {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: chosenModel,
          temperature: options.temperature ?? 0.1,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: packedPrompt.system },
            { role: "user", content: packedPrompt.user }
          ]
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const message = `Language model request failed: ${safeError(error)}`;
      this.log("chat_json", "failed", message, {
        model: chosenModel,
        mode: options.mode ?? "route",
        elapsedMs: now() - startedAt
      });
      throw new LlmRequestError(message, undefined, safeError(error), "llm");
    }

    this.log("chat_json", response.ok ? "ok" : "failed", `Language model request ${response.status}`, {
      model: chosenModel,
      mode: options.mode ?? "route",
      status: response.status,
      elapsedMs: now() - startedAt
    });
    if (!response.ok) {
      throw new LlmRequestError(`Language model request failed: ${response.status} ${response.statusText}`, response.status, response.statusText, "llm");
    }
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) return undefined;
    try {
      const result = JSON.parse(extractJson(content) ?? content) as T;
      this.log("chat_json_parse", "ok", "Language model JSON parsed.", {
        model: chosenModel,
        mode: options.mode ?? "route",
        responseChars: content.length,
        elapsedMs: now() - startedAt
      });
      return result;
    } catch (error) {
      const message = `Language model returned invalid JSON: ${safeError(error)}`;
      this.log("chat_json_parse", "failed", message, {
        model: chosenModel,
        mode: options.mode ?? "route",
        responseChars: content.length,
        elapsedMs: now() - startedAt
      });
      throw new LlmRequestError(message, undefined, "invalid_json", "llm");
    }
  }

  private log(action: string, status: "running" | "ok" | "failed", message: string, payload?: unknown): void {
    this.diagnostics?.({
      source: "llm",
      category: "llm",
      action,
      status,
      message: truncate(message, 240),
      payload
    });
  }
}

function packPrompt(system: string, user: string, maxPromptChars: number | undefined): { system: string; user: string } {
  if (!maxPromptChars || system.length + user.length <= maxPromptChars) return { system, user };
  const userBudget = Math.max(400, maxPromptChars - system.length);
  if (user.length <= userBudget) return { system, user };
  const head = Math.floor(userBudget * 0.62);
  const tail = Math.max(120, userBudget - head - 80);
  return {
    system,
    user: `${user.slice(0, head)}\n... [prompt compacted] ...\n${user.slice(-tail)}`
  };
}

function extractJson(content: string): string | undefined {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : undefined;
}

export function chatCompletionsUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`;
}

export function modelsUrl(value: string): string {
  const chatUrl = chatCompletionsUrl(value);
  return `${chatUrl.slice(0, -"/chat/completions".length)}/models`;
}
