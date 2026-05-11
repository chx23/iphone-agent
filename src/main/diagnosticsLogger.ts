import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiagnosticEvent, DiagnosticQuery } from "../shared/types";
import { createId, now, redactSecrets, safeError, truncate } from "./utils";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TASKS = 20;
const MAX_RECORDS_AFTER_TRIM = 2500;

export class DiagnosticsLogger {
  readonly logDir: string;
  readonly logPath: string;

  constructor(rootDir: string) {
    this.logDir = join(rootDir, "logs");
    this.logPath = join(this.logDir, "diagnostics.jsonl");
  }

  async log(input: Omit<DiagnosticEvent, "id" | "timestamp">): Promise<void> {
    try {
      await mkdir(this.logDir, { recursive: true });
      const event = sanitizeEvent({ ...input, id: createId("diag"), timestamp: now() });
      await writeFile(this.logPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
      await this.trimIfNeeded();
    } catch (error) {
      console.warn("diagnostics log failed:", safeError(error));
    }
  }

  async list(query: DiagnosticQuery = {}): Promise<DiagnosticEvent[]> {
    const records = await this.readAll();
    const filtered = records
      .filter((event) => !query.taskId || event.taskId === query.taskId)
      .filter((event) => !query.category || event.category === query.category)
      .sort((a, b) => b.timestamp - a.timestamp);
    return filtered.slice(0, query.limit ?? 200);
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.logPath);
    } catch {
      // Already empty.
    }
  }

  private async trimIfNeeded(): Promise<void> {
    try {
      const info = await stat(this.logPath);
      if (info.size < MAX_FILE_BYTES) return;
      const records = await this.readAll();
      const kept = keepRecentTasks(records).slice(-MAX_RECORDS_AFTER_TRIM);
      const rotated = join(this.logDir, `diagnostics.${Date.now()}.jsonl`);
      await rename(this.logPath, rotated).catch(() => undefined);
      await writeFile(this.logPath, kept.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
    } catch {
      // Trimming is best effort.
    }
  }

  private async readAll(): Promise<DiagnosticEvent[]> {
    try {
      const text = await readFile(this.logPath, "utf8");
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => safeParse(line))
        .filter((event): event is DiagnosticEvent => Boolean(event));
    } catch {
      return [];
    }
  }
}

export function sanitizeEvent(event: DiagnosticEvent): DiagnosticEvent {
  return sanitizeValue(event, 0) as DiagnosticEvent;
}

export function sanitizeValue(value: unknown, depth = 0, keyHint = ""): unknown {
  if (depth > 6) return "[MaxDepth]";
  if (typeof value === "string") {
    if (isPrivateTextKey(keyHint)) return "[REDACTED]";
    if (isScreenTextKey(keyHint)) return sanitizeScreenText(value);
    if (isTextBodyKey(keyHint)) return `[TEXT ${value.length} chars]`;
    return sanitizeString(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === undefined || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => sanitizeValue(item, depth + 1, keyHint));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        output[key] = "[REDACTED]";
        continue;
      }
      if (isPrivateTextKey(key)) {
        output[key] = "[REDACTED]";
        continue;
      }
      if (isLongTextKey(key) && typeof nested === "string") {
        output[key] = sanitizeString(truncate(nested, 200));
        continue;
      }
      output[key] = sanitizeValue(nested, depth + 1, key);
    }
    return output;
  }
  return String(value);
}

function sanitizeString(value: string): string {
  return redactSecrets(truncate(value, 1200))
    .replace(/(AI_API_KEY|VISION_API_KEY|apiKey|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

function isSensitiveKey(key: string): boolean {
  return /api[-_]?key|token|authorization|bearer|secret|password/i.test(key);
}

function isPrivateTextKey(key: string): boolean {
  return /recipient|contact|editableText/i.test(key);
}

function isScreenTextKey(key: string): boolean {
  return /sampleLabels|labels|ocrBlocks|nodes/i.test(key);
}

function isTextBodyKey(key: string): boolean {
  return /^text$|body|rawText|screenText|transcript/i.test(key);
}

function isLongTextKey(key: string): boolean {
  return /instruction|prompt|message|content/i.test(key);
}

function sanitizeScreenText(value: string): string {
  const clean = sanitizeString(value);
  if (clean.length > 80 || /^我[,，]/.test(clean) || /[。；;].*[。；;]/.test(clean)) {
    return `[SCREEN_TEXT ${value.length} chars]`;
  }
  return clean;
}

function safeParse(line: string): DiagnosticEvent | undefined {
  try {
    return JSON.parse(line) as DiagnosticEvent;
  } catch {
    return undefined;
  }
}

function keepRecentTasks(records: DiagnosticEvent[]): DiagnosticEvent[] {
  const taskIds = [...new Set(records.map((event) => event.taskId).filter((id): id is string => Boolean(id)))].slice(-MAX_TASKS);
  const taskSet = new Set(taskIds);
  return records.filter((event) => !event.taskId || taskSet.has(event.taskId));
}
