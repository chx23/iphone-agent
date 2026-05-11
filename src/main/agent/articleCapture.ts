import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ScreenGraph } from "../../shared/types";

const execFileAsync = promisify(execFile);

export const ARTICLE_PIXEL_DIFF_THRESHOLD = 0.01;
export const ARTICLE_STABLE_DIFF_COUNT = 3;
export const ARTICLE_REVERSE_TRIGGER_SCROLLS = 10;
export const ARTICLE_MAX_FORWARD_FRAMES = 80;
export const ARTICLE_MAX_REVERSE_FRAMES = 80;

export type ArticleCaptureDirection = "down" | "up";
export type ArticleCaptureStopReason = "bottom_stable" | "top_stable_after_reverse" | "max_frames";

export interface ArticleCaptureFrame {
  index: number;
  path: string;
  format: "jpg" | "png" | "bin";
  direction: ArticleCaptureDirection;
  capturedAt: number;
  diffRatio?: number;
  lowDiff: boolean;
  sourceSignature?: string;
  nodeTextLines: string[];
}

export interface ArticleCaptureState {
  account: string;
  title: string;
  articleId: string;
  captureDir: string;
  frames: ArticleCaptureFrame[];
  direction: ArticleCaptureDirection;
  forwardSwipeCount: number;
  reverseSwipeCount: number;
  stableCount: number;
  reverseAttempted: boolean;
  completed: boolean;
  stopReason?: ArticleCaptureStopReason;
}

export interface ArticleCaptureUpdate {
  state: ArticleCaptureState;
  frame: ArticleCaptureFrame;
  event: "captured" | "reverse_started" | "completed" | "max_frames";
}

export interface CreateArticleCaptureOptions {
  rootDir?: string;
  taskId: string;
  account: string;
  title: string;
}

export async function createArticleCaptureState(options: CreateArticleCaptureOptions): Promise<ArticleCaptureState> {
  const rootDir = options.rootDir ?? defaultArticleCaptureRoot();
  const articleId = `${Date.now()}-${randomUUID().replace(/-/g, "").slice(0, 8)}-${safePathPart(options.title || "article")}`;
  const captureDir = join(rootDir, safePathPart(options.taskId || "task"), articleId);
  await mkdir(captureDir, { recursive: true });
  return {
    account: options.account,
    title: options.title || "latest article",
    articleId,
    captureDir,
    frames: [],
    direction: "down",
    forwardSwipeCount: 0,
    reverseSwipeCount: 0,
    stableCount: 0,
    reverseAttempted: false,
    completed: false
  };
}

export async function appendArticleCaptureFrame(
  state: ArticleCaptureState,
  screen: ScreenGraph,
  nodeTextLines: string[]
): Promise<ArticleCaptureUpdate> {
  if (!screen.screenshotBase64) {
    throw new Error("Cannot capture article frame: screenshot is unavailable.");
  }
  const previous = state.frames.at(-1);
  const direction = state.direction;
  const saved = await saveScreenshotBase64(state.captureDir, state.frames.length, screen.screenshotBase64);
  const diffRatio = previous ? await compareImagePixelDiff(previous.path, saved.path) : undefined;
  const lowDiff = typeof diffRatio === "number" ? diffRatio < ARTICLE_PIXEL_DIFF_THRESHOLD : false;
  const frame: ArticleCaptureFrame = {
    index: state.frames.length,
    path: saved.path,
    format: saved.format,
    direction,
    capturedAt: Date.now(),
    diffRatio,
    lowDiff,
    sourceSignature: sourceSignature(screen),
    nodeTextLines
  };
  state.frames.push(frame);

  if (typeof diffRatio === "number") {
    if (direction === "down") state.forwardSwipeCount += 1;
    else state.reverseSwipeCount += 1;
    state.stableCount = lowDiff ? state.stableCount + 1 : 0;
  }

  if (
    direction === "down"
    && lowDiff
    && !state.reverseAttempted
    && state.forwardSwipeCount > 0
    && state.forwardSwipeCount <= ARTICLE_REVERSE_TRIGGER_SCROLLS
  ) {
    state.direction = "up";
    state.reverseAttempted = true;
    state.stableCount = 0;
    return { state, frame, event: "reverse_started" };
  }

  if (shouldCompleteArticleCapture(state.stableCount)) {
    state.completed = true;
    state.stopReason = direction === "up" ? "top_stable_after_reverse" : "bottom_stable";
    return { state, frame, event: "completed" };
  }

  if (isArticleCaptureExhausted(state)) {
    state.completed = true;
    state.stopReason = "max_frames";
    return { state, frame, event: "max_frames" };
  }

  return { state, frame, event: "captured" };
}

export function orderedArticleCaptureFrames(state: ArticleCaptureState): ArticleCaptureFrame[] {
  if (!state.reverseAttempted) return state.frames;
  const upFrames = state.frames.filter((frame) => frame.direction === "up");
  const downFrames = state.frames.filter((frame) => frame.direction === "down");
  return dedupeFramesByPath([...upFrames.reverse(), ...downFrames]);
}

export function isArticleCaptureExhausted(state: ArticleCaptureState): boolean {
  return state.forwardSwipeCount >= ARTICLE_MAX_FORWARD_FRAMES || state.reverseSwipeCount >= ARTICLE_MAX_REVERSE_FRAMES;
}

export function defaultArticleCaptureRoot(): string {
  const appData = process.env.APPDATA || process.cwd();
  return join(appData, "phone-agent", "article-captures");
}

export function shouldUseReverseReading(forwardSwipeCount: number, diffRatio: number, reverseAttempted: boolean): boolean {
  return !reverseAttempted
    && forwardSwipeCount > 0
    && forwardSwipeCount <= ARTICLE_REVERSE_TRIGGER_SCROLLS
    && diffRatio < ARTICLE_PIXEL_DIFF_THRESHOLD;
}

export function shouldCompleteArticleCapture(stableCount: number): boolean {
  return stableCount >= ARTICLE_STABLE_DIFF_COUNT;
}

export async function compareImagePixelDiff(pathA: string, pathB: string): Promise<number> {
  if (process.platform !== "win32") return fallbackFileByteDiff(pathA, pathB);
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    PIXEL_DIFF_SCRIPT
  ], {
    timeout: 15000,
    windowsHide: true,
    env: {
      ...process.env,
      PHONE_AGENT_DIFF_A: pathA,
      PHONE_AGENT_DIFF_B: pathB
    }
  });
  const parsed = JSON.parse(stdout.trim()) as { diffRatio?: number };
  return clampRatio(parsed.diffRatio);
}

async function saveScreenshotBase64(
  captureDir: string,
  index: number,
  screenshotBase64: string
): Promise<{ path: string; format: "jpg" | "png" | "bin" }> {
  const buffer = Buffer.from(stripDataPrefix(screenshotBase64), "base64");
  const format = detectImageFormat(buffer);
  const path = join(captureDir, `frame-${String(index).padStart(3, "0")}.${format}`);
  await writeFile(path, buffer);
  return { path, format };
}

function detectImageFormat(buffer: Buffer): "jpg" | "png" | "bin" {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "png";
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) return "jpg";
  return "bin";
}

function stripDataPrefix(value: string): string {
  const comma = value.indexOf(",");
  return value.startsWith("data:") && comma >= 0 ? value.slice(comma + 1) : value;
}

function sourceSignature(screen: ScreenGraph): string | undefined {
  const text = screen.rawSource || screen.nodes.map((node) => node.label).join("|");
  if (!text) return undefined;
  return text
    .replace(/\s+/g, "")
    .slice(0, 12000);
}

function safePathPart(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 60) || "article";
}

function dedupeFramesByPath(frames: ArticleCaptureFrame[]): ArticleCaptureFrame[] {
  const seen = new Set<string>();
  const result: ArticleCaptureFrame[] = [];
  for (const frame of frames) {
    if (seen.has(frame.path)) continue;
    seen.add(frame.path);
    result.push(frame);
  }
  return result;
}

async function fallbackFileByteDiff(pathA: string, pathB: string): Promise<number> {
  const { readFile } = await import("node:fs/promises");
  const [a, b] = await Promise.all([readFile(pathA), readFile(pathB)]);
  const length = Math.min(a.length, b.length);
  if (length <= 0) return 1;
  let changed = Math.abs(a.length - b.length);
  const step = Math.max(1, Math.floor(length / 4096));
  let samples = 0;
  for (let index = 0; index < length; index += step) {
    if (Math.abs(a[index] - b[index]) > 8) changed += 1;
    samples += 1;
  }
  return clampRatio(changed / Math.max(1, samples + Math.abs(a.length - b.length)));
}

function clampRatio(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : 1;
  return Math.min(1, Math.max(0, numeric));
}

const PIXEL_DIFF_SCRIPT = `
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Drawing
$pathA = $env:PHONE_AGENT_DIFF_A
$pathB = $env:PHONE_AGENT_DIFF_B
$bitmapA = [System.Drawing.Bitmap]::new($pathA)
$bitmapB = [System.Drawing.Bitmap]::new($pathB)
try {
  $samplesX = 32
  $samplesY = 64
  $changed = 0
  $total = 0
  for ($iy = 0; $iy -lt $samplesY; $iy += 1) {
    for ($ix = 0; $ix -lt $samplesX; $ix += 1) {
      $ax = [Math]::Min($bitmapA.Width - 1, [Math]::Max(0, [int](($ix + 0.5) * $bitmapA.Width / $samplesX)))
      $ay = [Math]::Min($bitmapA.Height - 1, [Math]::Max(0, [int](($iy + 0.5) * $bitmapA.Height / $samplesY)))
      $bx = [Math]::Min($bitmapB.Width - 1, [Math]::Max(0, [int](($ix + 0.5) * $bitmapB.Width / $samplesX)))
      $by = [Math]::Min($bitmapB.Height - 1, [Math]::Max(0, [int](($iy + 0.5) * $bitmapB.Height / $samplesY)))
      $pa = $bitmapA.GetPixel($ax, $ay)
      $pb = $bitmapB.GetPixel($bx, $by)
      $delta = ([Math]::Abs($pa.R - $pb.R) + [Math]::Abs($pa.G - $pb.G) + [Math]::Abs($pa.B - $pb.B)) / 3.0
      if ($delta -gt 18) { $changed += 1 }
      $total += 1
    }
  }
  $ratio = if ($total -gt 0) { $changed / $total } else { 1 }
  [pscustomobject]@{ diffRatio = $ratio } | ConvertTo-Json -Compress
} finally {
  $bitmapA.Dispose()
  $bitmapB.Dispose()
}
`;
