import type { DiagnosticEvent, ElementRef, VisionScreenResult } from "../shared/types";
import { chatCompletionsUrl, LlmRequestError, modelsUrl } from "./llmClient";
import { createId, now, safeError, truncate } from "./utils";

type DiagnosticSink = (event: Omit<DiagnosticEvent, "id" | "timestamp">) => void;

export type VisionMode = "classify" | "elements" | "full";

export interface VisionDescribeOptions {
  mode?: VisionMode;
  maxBlocks?: number;
  pageHints?: string[];
  timeoutMs?: number;
  app?: string;
  phase?: string;
}

interface VisionRawBlock {
  text?: string;
  t?: string;
  label?: string;
  l?: string;
  role?: string;
  r?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  width?: number;
  height?: number;
  conf?: number;
  confidence?: number;
  clickable?: boolean;
  c?: boolean;
}

interface VisionRawResult {
  page?: unknown;
  sum?: unknown;
  regions?: unknown;
  inputs?: unknown;
  risks?: unknown;
  observe?: unknown;
  els?: VisionRawBlock[];
  summary?: unknown;
  pageType?: unknown;
  page_type?: unknown;
  mainRegions?: unknown;
  main_regions?: unknown;
  inputHints?: unknown;
  input_hints?: unknown;
  riskHints?: unknown;
  risk_hints?: unknown;
  recommendedObservation?: unknown;
  recommended_observation?: unknown;
  ocrBlocks?: VisionRawBlock[];
  elements?: VisionRawBlock[];
}

export class VisionClient {
  constructor(
    private readonly getApiUrl: () => string,
    private readonly getApiKey: () => string | undefined,
    private readonly getModel: () => string,
    private readonly diagnostics?: DiagnosticSink
  ) {}

  async probeModels(): Promise<{ ok: boolean; models: string[]; message: string }> {
    const apiKey = this.getApiKey();
    if (!apiKey) return { ok: false, models: [], message: "Vision model API key is not configured." };
    const startedAt = now();
    try {
      const response = await fetch(modelsUrl(this.getApiUrl()), {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000)
      });
      this.log("probe", response.ok ? "ok" : "failed", `Vision model probe ${response.status}`, { status: response.status, elapsedMs: now() - startedAt });
      if (!response.ok) {
        return { ok: false, models: [], message: `Vision model probe failed: ${response.status} ${response.statusText}` };
      }
      const payload = (await response.json()) as { data?: Array<{ id?: string }> };
      const models = payload.data?.map((model) => model.id).filter(Boolean) as string[] | undefined;
      return {
        ok: Boolean(models?.length),
        models: models ?? [],
        message: models?.length ? `Found ${models.length} vision models.` : "Vision endpoint is reachable but returned no model list."
      };
    } catch (error) {
      const message = `Vision model probe failed: ${safeError(error)}`;
      this.log("probe", "failed", message, { elapsedMs: now() - startedAt });
      return { ok: false, models: [], message };
    }
  }

  async describeScreen(screenshotBase64: string, options: VisionDescribeOptions = {}): Promise<VisionScreenResult | undefined> {
    const apiKey = this.getApiKey();
    if (!apiKey || !screenshotBase64) return undefined;
    const model = this.getModel();
    if (!model) return undefined;

    const mode = options.mode ?? "full";
    const maxBlocks = options.maxBlocks ?? (mode === "classify" ? 0 : mode === "elements" ? 24 : 60);
    const prompt = visionPrompt(options, mode, maxBlocks);
    const startedAt = now();
    this.log("screen_ocr", "running", "Vision screen request started.", {
      model,
      mode,
      imageBytes: Math.round(screenshotBase64.length * 0.75),
      promptChars: prompt.system.length + prompt.user.length,
      maxBlocks
    });
    const response = await fetch(chatCompletionsUrl(this.getApiUrl()), {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: prompt.system
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: prompt.user
              },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${screenshotBase64}` }
              }
            ]
          }
        ]
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? (mode === "classify" ? 22000 : mode === "elements" ? 35000 : 45000))
    });

    let content = "";
    this.log("screen_ocr", response.ok ? "ok" : "failed", `Vision screen request ${response.status}`, {
      model,
      mode,
      status: response.status,
      elapsedMs: now() - startedAt
    });
    if (!response.ok) {
      throw new LlmRequestError(`Vision model request failed: ${response.status} ${response.statusText}`, response.status, response.statusText, "vision");
    }
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    content = payload.choices?.[0]?.message?.content ?? "";
    if (!content) return undefined;
    const parsed = parseVisionResult(content, { maxBlocks });
    this.log("screen_ocr_parse", parsed ? "ok" : "failed", parsed ? "Vision JSON parsed." : "Vision JSON missing.", {
      model,
      mode,
      responseChars: content.length,
      elapsedMs: now() - startedAt,
      blockCount: parsed?.ocrBlocks.length ?? 0
    });
    return parsed;
  }

  private log(action: string, status: "running" | "ok" | "failed", message: string, payload?: unknown): void {
    this.diagnostics?.({
      source: "vision",
      category: "vision",
      action,
      status,
      message: truncate(message, 240),
      payload
    });
  }
}

export function parseVisionResult(content: string, options: { maxBlocks?: number } = {}): VisionScreenResult | undefined {
  const jsonText = extractJson(content);
  if (!jsonText) return undefined;
  const parsed = JSON.parse(jsonText) as VisionRawResult;
  const maxBlocks = options.maxBlocks ?? 80;
  const blocks = Array.isArray(parsed.ocrBlocks)
    ? parsed.ocrBlocks
    : Array.isArray(parsed.elements)
      ? parsed.elements
      : Array.isArray(parsed.els)
        ? parsed.els
        : [];
  return {
    summary: stringValue(parsed.summary ?? parsed.sum, 300),
    pageType: stringValue(parsed.pageType ?? parsed.page_type ?? parsed.page, 80),
    mainRegions: stringArray(parsed.mainRegions ?? parsed.main_regions ?? parsed.regions, 12),
    inputHints: stringArray(parsed.inputHints ?? parsed.input_hints ?? parsed.inputs, 12),
    riskHints: stringArray(parsed.riskHints ?? parsed.risk_hints ?? parsed.risks, 12),
    recommendedObservation: stringValue(parsed.recommendedObservation ?? parsed.recommended_observation ?? parsed.observe, 300),
    ocrBlocks: blocks.map(toElementRef).filter((block): block is ElementRef => Boolean(block)).slice(0, maxBlocks)
  };
}

function toElementRef(block: VisionRawBlock, index: number): ElementRef | undefined {
  const label = String(block.text ?? block.t ?? block.label ?? block.l ?? "").trim();
  if (!label) return undefined;
  const x = numberValue(block.x);
  const y = numberValue(block.y);
  const width = numberValue(block.width ?? block.w);
  const height = numberValue(block.height ?? block.h);
  return {
    id: createId(`ocr_${index + 1}`),
    source: "ocr",
    label: truncate(label, 100),
    role: typeof (block.role ?? block.r) === "string" ? truncate(String(block.role ?? block.r), 40) : undefined,
    bounds: [x, y, width, height].every((value) => value !== undefined) ? { x: x!, y: y!, width: width!, height: height! } : undefined,
    confidence: clamp(numberValue(block.confidence ?? block.conf) ?? 0.62),
    clickable: typeof (block.clickable ?? block.c) === "boolean" ? Boolean(block.clickable ?? block.c) : undefined
  };
}

function visionPrompt(options: VisionDescribeOptions, mode: VisionMode, maxBlocks: number): { system: string; user: string } {
  const pageList = (options.pageHints?.length ? options.pageHints : [
    "wechat_home",
    "wechat_search",
    "wechat_chat",
    "wechat_article",
    "wechat_account_home",
    "dianping_home",
    "dianping_search",
    "dianping_results",
    "phone_home",
    "login",
    "dialog",
    "unknown"
  ]).join("|");
  const schema = mode === "classify"
    ? "{\"page\":\"type\",\"sum\":\"一句话\",\"regions\":[\"主区域\"],\"inputs\":[\"输入框\"],\"risks\":[\"危险按钮\"],\"observe\":\"下一步应校验什么\"}"
    : "{\"page\":\"type\",\"sum\":\"一句话\",\"regions\":[],\"inputs\":[],\"risks\":[],\"observe\":\"校验点\",\"els\":[{\"t\":\"可见文字\",\"r\":\"button|text|input|tab|icon|unknown\",\"x\":0,\"y\":0,\"w\":0,\"h\":0,\"conf\":0.8,\"c\":true}]}";
  return {
    system: [
      "JSON only. Phone GUI perception, not planning.",
      "Never tell the agent to click/send/pay/delete/confirm.",
      `Use compact keys. Page must be one of: ${pageList}.`
    ].join("\n"),
    user: [
      `mode=${mode}; app=${options.app ?? "unknown"}; phase=${options.phase ?? "unknown"}; maxEls=${maxBlocks}`,
      `Return ${schema}`,
      "Visible text only. No hidden UI. Pixel coordinates if elements requested."
    ].join("\n")
  };
}

function extractJson(content: string): string | undefined {
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringValue(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.trim() ? truncate(value.trim(), maxLength) : undefined;
}

function stringArray(value: unknown, maxItems: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => stringValue(item, 120))
    .filter((item): item is string => Boolean(item));
  return items.length ? items.slice(0, maxItems) : undefined;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
