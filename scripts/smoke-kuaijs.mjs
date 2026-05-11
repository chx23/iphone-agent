#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const explicitUrl = getArgValue("--url") ?? process.env.PHONE_AGENT_DEVICE_URL;
const timeoutMs = Number(getArgValue("--timeout") ?? process.env.PHONE_AGENT_TIMEOUT_MS ?? 8000);
const results = [];

async function main() {
  const baseUrl = explicitUrl ? trimSlash(explicitUrl) : await discoverBridgeUrl();
  if (!baseUrl) {
    record("fail", "bridge discovery", "No KuaiJS bridge was discovered. Keep KuaiJS group-control running.");
    finish(1);
    return;
  }

  record("info", "target", baseUrl);
  const statusPayload = await step("status", () => getJson(`${baseUrl}/api/status`, timeoutMs));
  const status = statusPayload?.data ?? statusPayload;
  const agentConnected = status?.agentConnected === true;

  expect("agent connected", agentConnected, `agentConnected=${String(status?.agentConnected)}`);
  record("info", "device", `${status?.deviceName ?? "unknown"} ${status?.deviceModel ?? ""}`.trim());
  record("info", "diagnostic status", `isLogin=${String(status?.isLogin)} isAuth=${String(status?.isAuth)} (HTTP control is not used by phone-agent)`);

  const screenshot = await step("screenshot", () => getText(`${baseUrl}/api/screenshotBase64`, timeoutMs));
  const screenshotBase64 = extractBase64(screenshot);
  expect("screenshot readable", screenshotBase64.length > 1000, `base64 length=${screenshotBase64.length}`);

  const source = await step("source tree", () => getText(`${baseUrl}/api/source?max_depth=2&timeout=120`, timeoutMs));
  expect("source readable", source.length > 100, `source length=${source.length}`);

  await checkIme(baseUrl);

  record("pass", "control backend", "HTTP /api/control checks are intentionally removed; use npm run test:smoke:runtime for control.");
  finish(hasFailures() ? 1 : 0);
}

async function checkIme(baseUrl) {
  const result = await getMaybe(`${baseUrl}/api/ime/isOk`, Math.min(timeoutMs, 5000));
  if (result.ok) {
    record("pass", "IME status", "IME endpoint is reachable.");
  } else if (result.status === 401 || result.status === 403) {
    record("pass", "IME unauthorized", "IME returned 401/403 and did not fail observation checks.");
  } else {
    record("warn", "IME status", result.message);
  }
}

async function discoverBridgeUrl() {
  const ports = await localCandidatePorts();
  for (const port of ports) {
    const url = `http://127.0.0.1:${port}`;
    const result = await getMaybe(`${url}/api/status`, 650);
    if (!result.ok) continue;
    try {
      const payload = JSON.parse(result.body);
      const data = payload.data ?? payload;
      if (data?.agentConnected || data?.serverDeviceId || data?.deviceName) return url;
    } catch {
      // Ignore non-KuaiJS services.
    }
  }
  return undefined;
}

async function localCandidatePorts() {
  const fallback = [...range(58120, 58140), ...range(60090, 60120), 34116, 58128];
  if (process.platform !== "win32") return unique(fallback);

  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$kuaiPids = @(Get-Process | Where-Object { $_.ProcessName -like '*Kuai*' -or $_.ProcessName -like '*kuaijs*' -or $_.ProcessName -like '*快点*' } | Select-Object -ExpandProperty Id)",
    "$ports = @()",
    "if ($kuaiPids.Count -gt 0) { $ports += @(Get-NetTCPConnection -State Listen | Where-Object { $kuaiPids -contains $_.OwningProcess } | Select-Object -ExpandProperty LocalPort) }",
    "$ports += @(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalAddress -in @('127.0.0.1','::1','::','0.0.0.0') -and $_.LocalPort -ge 30000 -and $_.LocalPort -le 65000 } | Select-Object -ExpandProperty LocalPort)",
    "$ports | Sort-Object -Unique | ConvertTo-Json -Compress"
  ].join("; ");

  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout: 4500 });
    const parsed = stdout.trim() ? JSON.parse(stdout.trim()) : [];
    return unique([...(Array.isArray(parsed) ? parsed : [parsed]), ...fallback]);
  } catch {
    return unique(fallback);
  }
}

async function step(name, fn) {
  try {
    const value = await fn();
    record("pass", name, "ok");
    return value;
  } catch (error) {
    record("fail", name, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function expect(name, condition, detail) {
  record(condition ? "pass" : "fail", name, detail);
}

async function getJson(url, timeout) {
  const text = await getText(url, timeout);
  return JSON.parse(text);
}

async function getText(url, timeout) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} at ${url}`);
  return response.text();
}

async function getMaybe(url, timeout) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    const body = await response.text().catch(() => "");
    return { ok: response.ok, status: response.status, body, message: response.ok ? "ok" : `${response.status} ${response.statusText}` };
  } catch (error) {
    return { ok: false, status: 0, body: "", message: error instanceof Error ? error.message : String(error) };
  }
}

function extractBase64(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const payload = JSON.parse(trimmed);
      return String(payload.data ?? payload.result ?? payload.base64 ?? payload.image ?? "");
    } catch {
      return "";
    }
  }
  const comma = trimmed.indexOf(",");
  return trimmed.startsWith("data:image") && comma >= 0 ? trimmed.slice(comma + 1) : trimmed;
}

function getArgValue(name) {
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function record(level, name, detail) {
  results.push({ level, name, detail });
  const marker = level === "pass" ? "PASS" : level === "fail" ? "FAIL" : level === "warn" ? "WARN" : "INFO";
  console.log(`[${marker}] ${name}: ${detail}`);
}

function finish(code) {
  const passCount = results.filter((item) => item.level === "pass").length;
  const failCount = results.filter((item) => item.level === "fail").length;
  const warnCount = results.filter((item) => item.level === "warn").length;
  console.log(`\nSmoke summary: ${passCount} passed, ${warnCount} warnings, ${failCount} failed.`);
  process.exitCode = code;
}

function hasFailures() {
  return results.some((item) => item.level === "fail");
}

function trimSlash(value) {
  return value.replace(/\/+$/, "");
}

function range(start, end) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function unique(values) {
  return [...new Set(values.map(Number).filter((port) => Number.isInteger(port) && port > 0 && port < 65536))];
}

await main();
