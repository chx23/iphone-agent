import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { safeError } from "./utils";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120000;

export interface LocalOcrLine {
  text: string;
  confidence?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface LocalOcrImageResult {
  path: string;
  lines: LocalOcrLine[];
  text: string;
  error?: string;
}

export interface LocalOcrBatchResult {
  ok: boolean;
  provider: string;
  language?: string;
  images: LocalOcrImageResult[];
  message?: string;
}

export interface LocalOcrProvider {
  isAvailable(): Promise<{ ok: boolean; provider: string; language?: string; message?: string }>;
  recognizeImages(paths: string[]): Promise<LocalOcrBatchResult>;
}

export class WindowsLocalOcrProvider implements LocalOcrProvider {
  constructor(private readonly language = "zh-Hans-CN") {}

  async isAvailable(): Promise<{ ok: boolean; provider: string; language?: string; message?: string }> {
    if (process.platform !== "win32") {
      return { ok: false, provider: "windows-ocr", message: "Windows OCR is only available on Windows." };
    }
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        WINDOWS_OCR_AVAILABILITY_SCRIPT
      ], {
        timeout: 10000,
        windowsHide: true,
        env: {
          ...process.env,
          PHONE_AGENT_OCR_LANGUAGE: this.language
        }
      });
      const parsed = JSON.parse(stdout.trim()) as { ok?: boolean; language?: string; message?: string };
      return {
        ok: Boolean(parsed.ok),
        provider: "windows-ocr",
        language: parsed.language,
        message: parsed.message
      };
    } catch (error) {
      return { ok: false, provider: "windows-ocr", language: this.language, message: safeError(error) };
    }
  }

  async recognizeImages(paths: string[]): Promise<LocalOcrBatchResult> {
    if (process.platform !== "win32") {
      throw new Error("Local OCR is unavailable: Windows OCR only runs on Windows.");
    }
    if (!paths.length) {
      return { ok: true, provider: "windows-ocr", language: this.language, images: [] };
    }
    const payload = Buffer.from(JSON.stringify(paths), "utf8").toString("base64");
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOWS_OCR_BATCH_SCRIPT
    ], {
      timeout: DEFAULT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 24 * 1024 * 1024,
      env: {
        ...process.env,
        PHONE_AGENT_OCR_LANGUAGE: this.language,
        PHONE_AGENT_OCR_PATHS_B64: payload
      }
    });
    const parsed = JSON.parse(stdout.trim()) as LocalOcrBatchResult;
    return {
      ok: Boolean(parsed.ok),
      provider: parsed.provider || "windows-ocr",
      language: parsed.language || this.language,
      images: Array.isArray(parsed.images) ? parsed.images : [],
      message: parsed.message
    };
  }
}

const POWERSHELL_UTF8_PREAMBLE = `
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
`;

const WINDOWS_OCR_AVAILABILITY_SCRIPT = `${POWERSHELL_UTF8_PREAMBLE}
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]
  $languageTag = $env:PHONE_AGENT_OCR_LANGUAGE
  if ([string]::IsNullOrWhiteSpace($languageTag)) { $languageTag = "zh-Hans-CN" }
  $language = [Windows.Globalization.Language]::new($languageTag)
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  if ($null -eq $engine) {
    [pscustomobject]@{ ok = $false; language = $languageTag; message = "Windows OCR engine is not available for this language." } | ConvertTo-Json -Compress
  } else {
    [pscustomobject]@{ ok = $true; language = $languageTag; message = "Windows OCR is available." } | ConvertTo-Json -Compress
  }
} catch {
  [pscustomobject]@{ ok = $false; language = $env:PHONE_AGENT_OCR_LANGUAGE; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

const WINDOWS_OCR_BATCH_SCRIPT = `${POWERSHELL_UTF8_PREAMBLE}
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime]

function AwaitWinRt($operation, $resultType) {
  $method = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq "AsTask" -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation\`1"
  })[0]
  $task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))
  return $task.GetAwaiter().GetResult()
}

function OcrImage($path, $engine) {
  try {
    $file = AwaitWinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $stream = AwaitWinRt ($file.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    $decoder = AwaitWinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = AwaitWinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = AwaitWinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = @()
    foreach ($line in $result.Lines) {
      $words = @($line.Words)
      $text = [string]$line.Text
      if ([string]::IsNullOrWhiteSpace($text)) { continue }
      $first = $null
      if ($words.Count -gt 0) { $first = $words[0] }
      $bounds = $null
      if ($null -ne $first) { $bounds = $first.BoundingRect }
      $lines += [pscustomobject]@{
        text = $text
        confidence = $null
        x = if ($null -ne $bounds) { [math]::Round($bounds.X, 2) } else { $null }
        y = if ($null -ne $bounds) { [math]::Round($bounds.Y, 2) } else { $null }
        width = if ($null -ne $bounds) { [math]::Round($bounds.Width, 2) } else { $null }
        height = if ($null -ne $bounds) { [math]::Round($bounds.Height, 2) } else { $null }
      }
    }
    return [pscustomobject]@{ path = $path; lines = $lines; text = $result.Text; error = $null }
  } catch {
    return [pscustomobject]@{ path = $path; lines = @(); text = ""; error = $_.Exception.Message }
  }
}

$languageTag = $env:PHONE_AGENT_OCR_LANGUAGE
if ([string]::IsNullOrWhiteSpace($languageTag)) { $languageTag = "zh-Hans-CN" }
$language = [Windows.Globalization.Language]::new($languageTag)
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
if ($null -eq $engine) {
  [pscustomobject]@{
    ok = $false
    provider = "windows-ocr"
    language = $languageTag
    images = @()
    message = "Windows OCR engine is not available for this language."
  } | ConvertTo-Json -Compress -Depth 8
  exit 0
}

$pathsJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PHONE_AGENT_OCR_PATHS_B64))
$paths = @($pathsJson | ConvertFrom-Json)
$images = @()
foreach ($path in $paths) {
  $images += OcrImage ([string]$path) $engine
}
[pscustomobject]@{
  ok = $true
  provider = "windows-ocr"
  language = $languageTag
  images = $images
  message = "Windows OCR completed."
} | ConvertTo-Json -Compress -Depth 8
`;
