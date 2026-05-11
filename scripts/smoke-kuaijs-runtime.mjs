#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

process.noDeprecation = true;

const execFileAsync = promisify(execFile);
const RESULT_PREFIX = "PHONE_AGENT_RESULT ";
const timeoutMs = Number(arg("--timeout") ?? process.env.PHONE_AGENT_TIMEOUT_MS ?? 90000);
const explicitUrl = arg("--url") ?? process.env.PHONE_AGENT_DEVICE_URL;
const runtimeDir = arg("--runtime-dir") ?? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "phone-agent", "phone-agent-kuai-runtime");

const target = explicitUrl ? trimSlash(explicitUrl) : await discoverBridgeUrl();
if (!target) fail("No KuaiJS bridge was discovered. Keep KuaiJS group-control running.");

const url = new URL(target);
console.log(`[INFO] target: ${target}`);
console.log(`[INFO] runtime: ${runtimeDir}`);

await writeRuntimeProject(runtimeDir);
await ensureDependencies(runtimeDir);
await writeFile(join(runtimeDir, "scripts", "main.js"), noopScript(), "utf8");

const http = await runMs(runtimeDir, ["run", "-i", url.hostname, "--port", url.port, "-t", "http"]);
if (http.ok) pass(http.raw);

const ws = await runMs(runtimeDir, ["run", "-t", "ws", "--ws-port", "31111", "--ws-wait-ms", "30000"], http.raw);
if (ws.ok) pass(ws.raw);

fail(`Runtime no-op failed.\n${ws.raw || http.raw}`);

async function writeRuntimeProject(dir) {
  await mkdir(join(dir, "scripts"), { recursive: true });
  await mkdir(join(dir, "ui"), { recursive: true });
  await mkdir(join(dir, "res"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({
    name: "phone-agent-kuai-runtime",
    private: true,
    appId: "phone-agent-kuai-runtime",
    appVersion: 1,
    ui: { tabs: [{ name: "phone-agent", file: "main.html" }] },
    scripts: { dev: "ms build -d", build: "ms build", package: "ms package" },
    devDependencies: {
      "ms-types": "0.7.3",
      "ms-vite-plugin": "1.1.18",
      "typescript": "^6.0.3"
    }
  }, null, 2) + "\n", "utf8");
  await writeFile(join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2020",
      module: "nodenext",
      moduleResolution: "nodenext",
      allowJs: true,
      checkJs: false,
      noEmit: true,
      strict: false,
      skipLibCheck: true,
      typeRoots: ["./node_modules/@types", "./node_modules/ms-types"]
    },
    include: ["env.d.ts", "scripts/**/*", "**/*.js", "**/*.ts"],
    exclude: ["node_modules", "dist", "msbundle"]
  }, null, 2) + "\n", "utf8");
  await writeFile(join(dir, "obfuscator.json"), JSON.stringify({
    target: "node",
    compact: false,
    log: true,
    optionsPreset: "high-obfuscation",
    deadCodeInjection: false,
    debugProtection: false,
    simplify: false,
    seed: 10,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 1,
    unicodeEscapeSequence: false,
    stringArray: true,
    stringArrayRotate: false,
    stringArrayShuffle: false,
    stringArrayThreshold: 1,
    stringArrayWrappersCount: 5,
    stringArrayEncoding: ["rc4"],
    stringArrayCallsTransform: false,
    selfDefending: false,
    splitStrings: false,
    splitStringsChunkLength: 1
  }, null, 2) + "\n", "utf8");
  await writeFile(join(dir, "env.d.ts"), '/// <reference path="./node_modules/ms-types/types/index.d.ts" />\n', "utf8");
  await writeFile(join(dir, ".npmrc"), "registry=https://registry.npmmirror.com\n", "utf8");
  await writeFile(join(dir, "ui", "main.html"), "<!doctype html><html><body>phone-agent runtime</body></html>\n", "utf8");
}

async function ensureDependencies(dir) {
  const msVersion = await packageVersion(join(dir, "node_modules", "ms-vite-plugin", "package.json"));
  const typesVersion = await packageVersion(join(dir, "node_modules", "ms-types", "package.json"));
  const msBin = join(dir, "node_modules", ".bin", process.platform === "win32" ? "ms.cmd" : "ms");
  if (msVersion === "1.1.18" && typesVersion === "0.7.3" && await exists(msBin)) return;
  await execFileAsync(npmCommand(), ["install", "--silent", "--no-audit", "--no-fund"], {
    cwd: dir,
    timeout: 120000,
    windowsHide: true,
    shell: process.platform === "win32"
  });
}

async function runMs(dir, args, previous = "") {
  const msBin = join(dir, "node_modules", ".bin", process.platform === "win32" ? "ms.cmd" : "ms");
  try {
    const { stdout, stderr } = await execFileAsync(msBin, args, {
      cwd: dir,
      timeout: timeoutMs,
      windowsHide: true,
      shell: process.platform === "win32",
      maxBuffer: 4 * 1024 * 1024
    });
    const raw = redact([previous, stdout, stderr].filter(Boolean).join("\n"));
    return { ok: true, raw };
  } catch (error) {
    return { ok: false, raw: redact([previous, error.stdout, error.stderr, error.message].filter(Boolean).join("\n")) };
  }
}

function noopScript() {
  return `function phoneAgentLog(line) {
  try {
    if (typeof logi === "function") logi(line);
    else console.log(line);
  } catch (error) {}
}
phoneAgentLog("${RESULT_PREFIX}" + JSON.stringify({
  commandId: "smoke_runtime",
  ok: true,
  backend: "kuaijs-project",
  message: "runtime no-op ok"
}));
`;
}

async function discoverBridgeUrl() {
  const ports = await candidatePorts();
  for (const port of ports) {
    const url = `http://127.0.0.1:${port}`;
    try {
      const response = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(650) });
      if (!response.ok) continue;
      const payload = await response.json();
      const data = payload.data ?? payload;
      if (data.agentConnected || data.serverDeviceId || data.deviceName) return url;
    } catch {
      // Ignore unrelated services.
    }
  }
  return undefined;
}

async function candidatePorts() {
  const fallback = [...range(58120, 58140), ...range(60090, 60120), 34116, 58128];
  if (process.platform !== "win32") return unique(fallback);
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$ports = @(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalAddress -in @('127.0.0.1','::1','::','0.0.0.0') -and $_.LocalPort -ge 30000 -and $_.LocalPort -le 65000 } | Select-Object -ExpandProperty LocalPort)",
    "$ports | Sort-Object -Unique | ConvertTo-Json -Compress"
  ].join("; ");
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout: 4500, windowsHide: true });
    const parsed = stdout.trim() ? JSON.parse(stdout.trim()) : [];
    return unique([...(Array.isArray(parsed) ? parsed : [parsed]), ...fallback]);
  } catch {
    return unique(fallback);
  }
}

async function packageVersion(path) {
  try {
    return JSON.parse(await readFile(path, "utf8")).version;
  } catch {
    return undefined;
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function pass(raw) {
  console.log("[PASS] KuaiJS project runtime no-op completed.");
  console.log(raw.split(/\r?\n/).filter((line) => line.includes(RESULT_PREFIX)).at(-1) ?? "");
  process.exit(0);
}

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exit(1);
}

function arg(name) {
  const prefix = `${name}=`;
  return process.argv.slice(2).find((item) => item.startsWith(prefix))?.slice(prefix.length);
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

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function redact(value) {
  return String(value).replace(/sk-[A-Za-z0-9_-]+/g, "sk-***").slice(-8000);
}
