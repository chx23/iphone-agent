import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentAction, DeviceRecord, ProjectRuntimeState, RuntimeActionResult, RuntimeMode } from "../shared/types";
import { redactSecrets, safeError, sleep, truncate } from "./utils";

const execFileAsync = promisify(execFile);
const RESULT_PREFIX = "PHONE_AGENT_RESULT ";
const DEFAULT_WS_PORT = 31111;

export interface ProjectRuntimeHealth {
  nodeReady: boolean;
  npmReady: boolean;
  msCliReady: boolean;
  projectRuntimeReady: boolean;
  state: ProjectRuntimeState;
  message: string;
  projectDir: string;
  lastError?: string;
  runtimeSmokeOk?: boolean;
}

export interface CommandRunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export type CommandRunner = (
  file: string,
  args: string[],
  options: CommandRunOptions
) => Promise<{ stdout: string; stderr: string }>;

export interface KuaiProjectRuntimeOptions {
  rootDir: string;
  wsPort?: number;
  commandRunner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
}

export class KuaiProjectRuntimeError extends Error {
  constructor(
    message: string,
    readonly backend: "kuaijs-project" = "kuaijs-project",
    readonly rawLog?: string
  ) {
    super(message);
    this.name = "KuaiProjectRuntimeError";
  }
}

export class KuaiProjectRuntime {
  private ensurePromise?: Promise<ProjectRuntimeHealth>;
  private state: ProjectRuntimeState = "not_started";
  private lastHealth?: ProjectRuntimeHealth;
  private lastError?: string;
  private lastSmokeOk?: boolean;
  private readonly wsPort: number;
  private readonly commandRunner: CommandRunner;

  constructor(private readonly options: KuaiProjectRuntimeOptions) {
    this.wsPort = options.wsPort ?? DEFAULT_WS_PORT;
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
  }

  get projectDir(): string {
    return this.options.rootDir;
  }

  ensure(): Promise<ProjectRuntimeHealth> {
    if (this.state === "ready" && this.lastHealth?.projectRuntimeReady) {
      return Promise.resolve(this.lastHealth);
    }
    this.ensurePromise ??= this.ensureInternal().then((health) => {
      this.lastHealth = health;
      this.state = health.state;
      this.lastError = health.lastError;
      this.ensurePromise = undefined;
      return health;
    }).catch((error) => {
      this.state = "failed";
      this.lastError = redactSecrets(safeError(error));
      this.lastHealth = this.currentHealth(false, false, false, "KuaiJS project runtime check failed.", this.lastError);
      this.ensurePromise = undefined;
      throw error;
    });
    return this.ensurePromise;
  }

  async healthCheck(): Promise<ProjectRuntimeHealth> {
    if (!this.ensurePromise && this.state !== "ready" && this.state !== "scaffolding" && this.state !== "installing") {
      void this.ensure().catch(() => undefined);
    }
    return this.lastHealth ?? this.currentHealth(false, false, false, "KuaiJS project runtime check has started.");
  }

  recheck(): Promise<ProjectRuntimeHealth> {
    this.ensurePromise = undefined;
    this.state = "not_started";
    this.lastHealth = undefined;
    this.lastError = undefined;
    return this.ensure();
  }

  ensureScaffold(): Promise<void> {
    return this.writeProjectScaffold();
  }

  async execute(device: DeviceRecord, action: AgentAction): Promise<RuntimeActionResult> {
    if (!isProjectRuntimeAction(action)) {
      throw new KuaiProjectRuntimeError(`Unsupported project runtime action: ${action.type}`);
    }

    const health = await this.ensure();
    if (!health.projectRuntimeReady) {
      throw new KuaiProjectRuntimeError(health.message);
    }

    const commandId = `cmd_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await this.writeActionScript(commandId, action);

    const preferred = device.preferredRunTransport ?? "http";
    const maxAttempts = shouldRetryProjectRun(action) ? 2 : 1;
    let lastFailure: { message: string; rawLog: string } | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const first = await this.runProject(device, action, preferred, lastFailure?.rawLog);
      if (first.ok) return first.result;

      let failure = first;
      if (preferred !== "ws" && shouldFallbackToWs(action, first.message, first.rawLog)) {
        const fallback = await this.runProject(device, action, "ws", first.rawLog);
        if (fallback.ok) return fallback.result;
        failure = fallback;
      }

      lastFailure = failure;
      if (attempt < maxAttempts - 1 && isRetryableRuntimeFailure(failure.message, failure.rawLog)) {
        await sleep(1400);
        continue;
      }
      break;
    }

    throw new KuaiProjectRuntimeError(lastFailure?.message ?? "KuaiJS project runtime failed.", "kuaijs-project", lastFailure?.rawLog);
  }

  async smokeTest(device: DeviceRecord): Promise<RuntimeActionResult> {
    const health = await this.ensure();
    if (!health.projectRuntimeReady) {
      throw new KuaiProjectRuntimeError(health.message);
    }

    const commandId = `smoke_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await this.writeNoopScript(commandId);

    const preferred = device.runtimeTransport ?? device.preferredRunTransport ?? "http";
    const first = await this.runProject(device, { type: "wait", ms: 0, reason: "runtime smoke" }, preferred);
    if (first.ok) {
      this.lastSmokeOk = true;
      this.lastHealth = { ...health, runtimeSmokeOk: true };
      return first.result;
    }

    if (preferred !== "ws") {
      const fallback = await this.runProject(device, { type: "wait", ms: 0, reason: "runtime smoke" }, "ws", first.rawLog);
      if (fallback.ok) {
        this.lastSmokeOk = true;
        this.lastHealth = { ...health, runtimeSmokeOk: true };
        return fallback.result;
      }
      this.lastSmokeOk = false;
      this.lastHealth = { ...health, runtimeSmokeOk: false, lastError: fallback.message };
      throw new KuaiProjectRuntimeError(fallback.message, "kuaijs-project", fallback.rawLog);
    }

    this.lastSmokeOk = false;
    this.lastHealth = { ...health, runtimeSmokeOk: false, lastError: first.message };
    throw new KuaiProjectRuntimeError(first.message, "kuaijs-project", first.rawLog);
  }

  private async ensureInternal(): Promise<ProjectRuntimeHealth> {
    this.state = "scaffolding";
    this.lastHealth = this.currentHealth(false, false, false, "Creating KuaiJS project runtime scaffold.");
    const nodeReady = await commandExists("node", ["--version"], this.commandRunner, this.options.env);
    const npmReady = await commandExists(npmCommand(), ["--version"], this.commandRunner, this.options.env);

    await this.writeProjectScaffold();

    if (!nodeReady || !npmReady) {
      return this.currentHealth(
        nodeReady,
        npmReady,
        false,
        "Node.js or npm is not available. Install Node.js, then recheck the KuaiJS project runtime.",
        "Node.js or npm is not available.",
        "failed"
      );
    }

    const depsReady = await this.dependenciesReady();
    if (!depsReady) {
      this.state = "installing";
      this.lastHealth = this.currentHealth(nodeReady, npmReady, false, "Installing KuaiJS project runtime dependencies.");
      await this.commandRunner(npmCommand(), ["install", "--silent", "--no-audit", "--no-fund"], {
        cwd: this.projectDir,
        timeoutMs: 120000,
        env: this.options.env
      });
    }

    const msCliReady = await fileExists(this.msBinPath());
    return this.currentHealth(
      nodeReady,
      npmReady,
      msCliReady,
      msCliReady
        ? "KuaiJS project runtime is ready."
        : "KuaiJS ms CLI was not found after installing runtime dependencies.",
      msCliReady ? undefined : "KuaiJS ms CLI was not found after installing runtime dependencies.",
      msCliReady ? "ready" : "failed"
    );
  }

  private async writeProjectScaffold(): Promise<void> {
    await mkdir(join(this.projectDir, "scripts"), { recursive: true });
    await mkdir(join(this.projectDir, "ui"), { recursive: true });
    await mkdir(join(this.projectDir, "res"), { recursive: true });

    await writeFile(join(this.projectDir, "package.json"), JSON.stringify(runtimePackageJson(), null, 2) + "\n", "utf8");
    await writeFile(join(this.projectDir, "tsconfig.json"), JSON.stringify(runtimeTsConfig(), null, 2) + "\n", "utf8");
    await writeFile(join(this.projectDir, "env.d.ts"), '/// <reference path="./node_modules/ms-types/types/index.d.ts" />\n', "utf8");
    await writeFile(join(this.projectDir, "obfuscator.json"), JSON.stringify(runtimeObfuscatorConfig(), null, 2) + "\n", "utf8");
    await writeFile(join(this.projectDir, ".npmrc"), "registry=https://registry.npmmirror.com\n", "utf8");
    await writeFile(join(this.projectDir, "ui", "main.html"), runtimeHtml(), "utf8");

    const mainPath = join(this.projectDir, "scripts", "main.js");
    if (!(await fileExists(mainPath))) {
      await writeFile(mainPath, buildNoopScript("bootstrap"), "utf8");
    }
  }

  private async dependenciesReady(): Promise<boolean> {
    return (await packageVersion(join(this.projectDir, "node_modules", "ms-vite-plugin", "package.json"))) === "1.1.18"
      && (await packageVersion(join(this.projectDir, "node_modules", "ms-types", "package.json"))) === "0.7.3";
  }

  private async writeActionScript(commandId: string, action: AgentAction): Promise<void> {
    const script = buildRuntimeScript(commandId, action);
    await writeFile(join(this.projectDir, "scripts", "main.js"), script, "utf8");
  }

  private async writeNoopScript(commandId: string): Promise<void> {
    await writeFile(join(this.projectDir, "scripts", "main.js"), buildNoopScript(commandId), "utf8");
  }

  private async runProject(
    device: DeviceRecord,
    action: AgentAction,
    transport: "http" | "ws",
    previousRawLog?: string
  ): Promise<{ ok: true; result: RuntimeActionResult } | { ok: false; message: string; rawLog: string }> {
    const host = device.runtimeTargetHost ?? device.host;
    const port = device.runtimeTargetPort ?? device.port;
    const runtimeMode = runtimeModeFor(host, transport);
    const args = transport === "http"
      ? ["run", "-i", host, "--port", String(port), "-t", "http"]
      : ["run", "-t", "ws", "--ws-port", String(device.wsPort ?? this.wsPort), "--ws-wait-ms", "30000"];

    let sourceBefore: string | undefined;
    try {
      sourceBefore = shouldVerifyBySourceChange(action) ? await readDeviceSource(device).catch(() => undefined) : undefined;
      const watcher = transport === "http" ? watchDeviceLogsForResult(host, port, 12000) : undefined;
      if (watcher) await sleep(120);
      const output = await this.commandRunner(this.msBinPath(), args, {
        cwd: this.projectDir,
        timeoutMs: 90000,
        env: this.options.env
      });
      const watchedLog = watcher ? await watcher.catch((error) => `SSE log watch failed: ${safeError(error)}`) : undefined;
      const rawLog = redactAndLimit([previousRawLog, output.stdout, output.stderr, watchedLog].filter(Boolean).join("\n"));
      const parsed = parsePhoneAgentResult(rawLog);
      if (!parsed) {
        const verified = await this.verifyActionAfterRun(device, action, runtimeMode, rawLog, sourceBefore);
        if (verified) {
          return verified.ok
            ? { ok: true, result: verified }
            : { ok: false, message: verified.message, rawLog };
        }
        return {
          ok: false,
          message: "ms run request was sent, but PHONE_AGENT_RESULT was not captured and the action could not be verified.",
          rawLog
        };
      }
      const result: RuntimeActionResult = parsed;
      result.runtimeMode = result.runtimeMode ?? runtimeMode;
      if (!result.rawLog) result.rawLog = rawLog;
      if (!result.ok) return { ok: false, message: result.message, rawLog };
      const verifiedFailure = await this.verifyPositiveResult(device, action, result, rawLog);
      if (verifiedFailure) return { ok: false, message: verifiedFailure, rawLog };
      return { ok: true, result };
    } catch (error) {
      const rawLog = redactAndLimit([previousRawLog, errorOutput(error)].filter(Boolean).join("\n"));
      if (shouldVerifyAfterRuntimeError(action, rawLog)) {
        const verified = await this.verifyActionAfterRun(device, action, runtimeMode, rawLog, sourceBefore);
        if (verified) {
          return verified.ok
            ? { ok: true, result: verified }
            : { ok: false, message: verified.message, rawLog };
        }
      }
      const message = `KuaiJS project runtime failed over ${runtimeMode}: ${redactSecrets(safeError(error))}`;
      return { ok: false, message, rawLog };
    }
  }

  private msBinPath(): string {
    return process.platform === "win32"
      ? join(this.projectDir, "node_modules", ".bin", "ms.cmd")
      : join(this.projectDir, "node_modules", ".bin", "ms");
  }

  private async verifyActionAfterRun(
    device: DeviceRecord,
    action: AgentAction,
    runtimeMode: RuntimeMode,
    rawLog: string,
    sourceBefore?: string
  ): Promise<RuntimeActionResult | undefined> {
    if (action.type === "wait" && /运行请求已发送|request was sent/i.test(rawLog)) {
      return {
        commandId: "verified",
        ok: true,
        backend: "kuaijs-project",
        message: "ms run request was sent; no-op runtime smoke accepted.",
        runtimeMode,
        rawLog
      };
    }
    if (action.type === "open_app") {
      const activeBundleId = await waitForActiveBundle(device, action.bundleId);
      if (activeBundleId === action.bundleId) {
        return {
          commandId: "verified",
          ok: true,
          backend: "kuaijs-project",
          message: `ms run request was sent; ${action.displayName ?? action.bundleId} is now in front.`,
          runtimeMode,
          rawLog,
          observedAfter: activeBundleId
        };
      }
    }
    if (action.type === "home") {
      const activeBundleId = await waitForActiveBundle(device, "com.apple.springboard");
      if (activeBundleId === "com.apple.springboard") {
        return {
          commandId: "verified",
          ok: true,
          backend: "kuaijs-project",
          message: "ms run request was sent; Home screen is now visible.",
          runtimeMode,
          rawLog,
          observedAfter: activeBundleId
        };
      }
    }
    if (action.type === "input" && action.text.trim()) {
      const observedSource = await waitForSourceText(device, action.text);
      if (observedSource) {
        const duplicateMessage = inputVerificationError(observedSource, action.text);
        if (duplicateMessage) {
          return {
            commandId: "verified",
            ok: false,
            backend: "kuaijs-project",
            message: duplicateMessage,
            runtimeMode,
            rawLog,
            observedAfter: truncate(action.text, 80)
          };
        }
        return {
          commandId: "verified",
          ok: true,
          backend: "kuaijs-project",
          message: "ms run request was sent; input text is visible in the current UI.",
          runtimeMode,
          rawLog,
          observedAfter: truncate(action.text, 80)
        };
      }
    }
    if (sourceBefore && shouldVerifyBySourceChange(action)) {
      const changedSource = await waitForSourceChange(device, sourceBefore);
      if (changedSource) {
        return {
          commandId: "verified",
          ok: true,
          backend: "kuaijs-project",
          message: "ms run request was sent; source tree changed after the action.",
          runtimeMode,
          rawLog,
          observedAfter: truncate(changedSource, 120)
        };
      }
    }
    return undefined;
  }

  private async verifyPositiveResult(
    device: DeviceRecord,
    action: AgentAction,
    result: RuntimeActionResult,
    rawLog: string
  ): Promise<string | undefined> {
    if (action.type === "input" && action.text.trim()) {
      const source = await waitForSourceText(device, action.text);
      return source ? inputVerificationError(source, action.text) : undefined;
    }
    if (action.type !== "open_app") return undefined;
    const activeBundleId = await waitForActiveBundle(device, action.bundleId);
    if (activeBundleId === action.bundleId) return undefined;
    result.rawLog = rawLog;
    result.observedAfter = activeBundleId;
    return `Runtime reported success, but ${action.displayName ?? action.bundleId} is not in front. Current app: ${activeBundleId || "unknown"}.`;
  }

  private currentHealth(
    nodeReady: boolean,
    npmReady: boolean,
    msCliReady: boolean,
    message: string,
    lastError = this.lastError,
    state = this.state
  ): ProjectRuntimeHealth {
    const projectRuntimeReady = state === "ready" && msCliReady;
    const health: ProjectRuntimeHealth = {
      nodeReady,
      npmReady,
      msCliReady,
      projectRuntimeReady,
      state,
      message,
      projectDir: this.projectDir,
      lastError,
      runtimeSmokeOk: this.lastSmokeOk
    };
    this.state = state;
    this.lastHealth = health;
    this.lastError = lastError;
    return health;
  }
}

export function parsePhoneAgentResult(rawLog: string): RuntimeActionResult | undefined {
  const matches = [...rawLog.matchAll(/PHONE_AGENT_RESULT\s+({[^\r\n]+})/g)];
  const last = matches.at(-1)?.[1];
  if (!last) return undefined;
  try {
    const parsed = JSON.parse(last) as Partial<RuntimeActionResult>;
    if (typeof parsed.commandId === "string" && typeof parsed.ok === "boolean") {
      return {
        commandId: parsed.commandId,
        ok: parsed.ok,
        backend: "kuaijs-project",
        message: typeof parsed.message === "string" ? parsed.message : "",
        runtimeMode: isRuntimeMode(parsed.runtimeMode) ? parsed.runtimeMode : undefined,
        rawLog: redactAndLimit(rawLog),
        observedAfter: typeof parsed.observedAfter === "string" ? parsed.observedAfter : undefined
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function buildRuntimeScript(commandId: string, action: AgentAction): string {
  if (!isProjectRuntimeAction(action)) return buildNoopScript(commandId);
  const payload = JSON.stringify({ commandId, action });
  return `const PHONE_AGENT_COMMAND = ${payload};

function phoneAgentLog(line) {
  try {
    if (typeof logi === "function") {
      logi(line);
      return;
    }
  } catch (error) {}
  try {
    console.log(line);
  } catch (error) {}
}

function phoneAgentError(error) {
  if (!error) return "unknown error";
  if (typeof error === "string") return error;
  if (error.message) return String(error.message);
  try { return JSON.stringify(error); } catch (jsonError) { return String(error); }
}

function emitPhoneAgentResult(result) {
  phoneAgentLog("${RESULT_PREFIX}" + JSON.stringify({
    commandId: PHONE_AGENT_COMMAND.commandId,
    ok: Boolean(result.ok),
    backend: "kuaijs-project",
    message: String(result.message || ""),
    observedAfter: result.observedAfter ? String(result.observedAfter) : undefined
  }));
}

function globalModule(name) {
  try {
    return typeof globalThis !== "undefined" ? globalThis[name] : undefined;
  } catch (error) {
    return undefined;
  }
}

function tryCall(label, fn) {
  try {
    const value = fn();
    const ok = value !== false && value !== null && value !== undefined && value !== "";
    return { ok, message: ok ? label : label + " returned " + String(value) };
  } catch (error) {
    return { ok: false, message: label + " failed: " + phoneAgentError(error) };
  }
}

function firstSuccessful(calls) {
  let last = { ok: false, message: "no runtime method was available" };
  for (let i = 0; i < calls.length; i += 1) {
    const result = calls[i]();
    last = result;
    if (result.ok) return result;
  }
  return last;
}

function anySuccessful(calls) {
  let ok = false;
  const messages = [];
  for (let i = 0; i < calls.length; i += 1) {
    const result = calls[i]();
    messages.push(result.message);
    ok = ok || result.ok;
    delay(120);
  }
  return { ok, message: messages.filter(Boolean).join("; ") || "no runtime method was available" };
}

function delay(ms) {
  try {
    if (typeof sleep === "function") sleep(ms);
  } catch (error) {}
}

function clearFocusedTextBeforeInput() {
  const messages = [];
  try {
    if (typeof ime !== "undefined" && ime.clearText) {
      messages.push("ime.clearText=" + String(ime.clearText()));
      delay(120);
    }
  } catch (error) {
    messages.push("ime.clearText failed: " + phoneAgentError(error));
  }
  try {
    if (typeof hid !== "undefined" && hid.sendKey && typeof hidKey !== "undefined" && hidKey.COMMAND) {
      messages.push("hid.commandA=" + String(hid.sendKey([hidKey.COMMAND, "a"])));
      delay(160);
      if (hid.backspace) {
        messages.push("hid.backspaceSelected=" + String(hid.backspace()));
        delay(160);
      }
    }
  } catch (error) {
    messages.push("hid.commandA/backspace failed: " + phoneAgentError(error));
  }
  try {
    if (typeof action !== "undefined" && action.backspace) {
      messages.push("action.backspace=" + String(action.backspace(80)));
      delay(160);
    }
  } catch (error) {
    messages.push("action.backspace failed: " + phoneAgentError(error));
  }
  try {
    if (typeof hid !== "undefined" && hid.backspace) {
      messages.push("hid.backspace=" + String(hid.backspace(80)));
      delay(160);
    }
  } catch (error) {
    messages.push("hid.backspace failed: " + phoneAgentError(error));
  }
  return messages.join("; ");
}

function currentAppBundleId() {
  try {
    if (typeof system !== "undefined" && system.activateAppInfo) {
      const info = system.activateAppInfo();
      if (info) return String(info.bundleId || info.bundleIdentifier || info.name || "");
    }
  } catch (error) {}
  try {
    if (typeof hid !== "undefined" && hid.currentAppInfo) {
      const info = hid.currentAppInfo();
      if (info) return String(info.bundleId || info.bundleIdentifier || info.name || "");
    }
  } catch (error) {}
  return "";
}

function performAction(actionSpec) {
  const a = actionSpec;
  if (a.type === "home") {
    return anySuccessful([
      () => typeof system !== "undefined" && system.activateApp ? tryCall("system.activateApp(springboard)", () => system.activateApp("com.apple.springboard")) : { ok: false, message: "system.activateApp(springboard) unavailable" },
      () => typeof system !== "undefined" && system.startApp ? tryCall("system.startApp(springboard)", () => system.startApp("com.apple.springboard")) : { ok: false, message: "system.startApp(springboard) unavailable" },
      () => typeof hid !== "undefined" && hid.openApp ? tryCall("hid.openApp(springboard)", () => hid.openApp("com.apple.springboard")) : { ok: false, message: "hid.openApp(springboard) unavailable" },
      () => typeof hid !== "undefined" && hid.pressButton ? tryCall("hid.pressButton(home)", () => hid.pressButton("home")) : { ok: false, message: "hid.pressButton(home) unavailable" },
      () => typeof action !== "undefined" && action.pressButton ? tryCall("action.pressButton(home)", () => action.pressButton("home")) : { ok: false, message: "action.pressButton(home) unavailable" },
      () => typeof hid !== "undefined" && hid.homeScreen ? tryCall("hid.homeScreen", () => hid.homeScreen()) : { ok: false, message: "hid.homeScreen unavailable" },
      () => typeof action !== "undefined" && action.homeScreen ? tryCall("action.homeScreen", () => action.homeScreen()) : { ok: false, message: "action.homeScreen unavailable" }
    ]);
  }
  if (a.type === "back") {
    return firstSuccessful([
      () => typeof hid !== "undefined" && hid.back ? tryCall("hid.back", () => hid.back()) : { ok: false, message: "hid.back unavailable" }
    ]);
  }
  if (a.type === "tap_xy") {
    const x = Math.round(Number(a.x));
    const y = Math.round(Number(a.y));
    return firstSuccessful([
      () => typeof action !== "undefined" && action.click ? tryCall("action.click", () => action.click(x, y, 30, true)) : { ok: false, message: "action.click unavailable" },
      () => typeof hid !== "undefined" && hid.click ? tryCall("hid.click", () => hid.click(x, y, 30, true)) : { ok: false, message: "hid.click unavailable" }
    ]);
  }
  if (a.type === "swipe") {
    const sx = Math.round(Number(a.startX));
    const sy = Math.round(Number(a.startY));
    const ex = Math.round(Number(a.endX));
    const ey = Math.round(Number(a.endY));
    const duration = Math.round(Number(a.duration || 350));
    return firstSuccessful([
      () => typeof action !== "undefined" && action.swipe ? tryCall("action.swipe", () => action.swipe(sx, sy, ex, ey, duration, true, 8)) : { ok: false, message: "action.swipe unavailable" },
      () => typeof hid !== "undefined" && hid.swipe ? tryCall("hid.swipe", () => hid.swipe(sx, sy, ex, ey, true, 8)) : { ok: false, message: "hid.swipe unavailable" }
    ]);
  }
  if (a.type === "input") {
    const text = String(a.text || "");
    const clipboardPaste = () => typeof hid !== "undefined" && hid.setClipboard && hid.pasteText ? tryCall("hid.clipboardPaste", () => {
      clearFocusedTextBeforeInput();
      return hid.setClipboard(text) && hid.pasteText();
    }) : { ok: false, message: "hid clipboard unavailable" };
    const imeInput = () => typeof ime !== "undefined" && ime.autoSwitchApiKeyboard && ime.input ? tryCall("ime.input", () => {
      ime.autoSwitchApiKeyboard();
      clearFocusedTextBeforeInput();
      return ime.input(text);
    }) : { ok: false, message: "ime.input unavailable" };
    const actionInput = () => typeof action !== "undefined" && action.input ? tryCall("action.input", () => {
      clearFocusedTextBeforeInput();
      return action.input(text);
    }) : { ok: false, message: "action.input unavailable" };
    const hidInput = () => typeof hid !== "undefined" && hid.input ? tryCall("hid.input", () => {
      clearFocusedTextBeforeInput();
      return hid.input(text);
    }) : { ok: false, message: "hid.input unavailable" };
    const calls = text.length >= 40
      ? [clipboardPaste, imeInput, actionInput, hidInput]
      : [imeInput, actionInput, hidInput, clipboardPaste];
    return firstSuccessful(calls);
  }
  if (a.type === "open_app") {
    const bundleId = String(a.bundleId || "");
    const displayName = String(a.displayName || "");
    return firstSuccessful([
      () => typeof system !== "undefined" && system.activateApp && bundleId ? tryCall("system.activateApp", () => system.activateApp(bundleId)) : { ok: false, message: "system.activateApp unavailable" },
      () => typeof system !== "undefined" && system.startApp && bundleId ? tryCall("system.startApp", () => system.startApp(bundleId)) : { ok: false, message: "system.startApp unavailable" },
      () => typeof hid !== "undefined" && hid.openApp && displayName ? tryCall("hid.openApp(displayName)", () => hid.openApp(displayName)) : { ok: false, message: "hid.openApp(displayName) unavailable" },
      () => typeof hid !== "undefined" && hid.openApp && bundleId ? tryCall("hid.openApp(bundleId)", () => hid.openApp(bundleId)) : { ok: false, message: "hid.openApp(bundleId) unavailable" }
    ]);
  }
  if (a.type === "open_url") {
    return firstSuccessful([
      () => typeof hid !== "undefined" && hid.openURL ? tryCall("hid.openURL", () => hid.openURL(String(a.url || ""))) : { ok: false, message: "hid.openURL unavailable" }
    ]);
  }
  if (a.type === "collect_scroll") {
    const count = Math.max(1, Math.min(20, Number(a.maxScrolls || 1)));
    const down = a.direction !== "up";
    let ok = true;
    let message = "collect_scroll completed";
    for (let i = 0; i < count; i += 1) {
      const result = down
        ? performAction({ type: "swipe", startX: 500, startY: 820, endX: 500, endY: 260, duration: 420 })
        : performAction({ type: "swipe", startX: 500, startY: 260, endX: 500, endY: 820, duration: 420 });
      ok = ok && result.ok;
      message = result.message;
      delay(600);
      if (!result.ok) break;
    }
    return { ok, message };
  }
  return { ok: false, message: "unsupported action " + String(a.type) };
}

try {
  const result = performAction(PHONE_AGENT_COMMAND.action);
  delay(result.ok ? 800 : 100);
  result.observedAfter = currentAppBundleId();
  emitPhoneAgentResult(result);
} catch (error) {
  emitPhoneAgentResult({ ok: false, message: phoneAgentError(error) });
}
`;
}

function buildNoopScript(commandId: string): string {
  return `function phoneAgentLog(line) {
  try {
    if (typeof logi === "function") logi(line);
    else console.log(line);
  } catch (error) {}
}
phoneAgentLog("${RESULT_PREFIX}" + JSON.stringify({
  commandId: ${JSON.stringify(commandId)},
  ok: true,
  backend: "kuaijs-project",
  message: "runtime bootstrap"
}));
`;
}

function isProjectRuntimeAction(action: AgentAction): action is Extract<
  AgentAction,
  { type: "tap_xy" | "swipe" | "input" | "open_app" | "open_url" | "back" | "home" | "collect_scroll" }
> {
  return ["tap_xy", "swipe", "input", "open_app", "open_url", "back", "home", "collect_scroll"].includes(action.type);
}

function shouldRetryProjectRun(action: AgentAction): boolean {
  return action.type === "swipe"
    || action.type === "collect_scroll"
    || action.type === "tap_xy"
    || action.type === "back"
    || action.type === "home"
    || action.type === "open_app";
}

function shouldFallbackToWs(action: AgentAction, message = "", rawLog = ""): boolean {
  if (action.type === "input") return false;
  if (/运行请求已发送|request was sent|could not be verified|PHONE_AGENT_RESULT was not captured/i.test(`${message}\n${rawLog}`)) {
    return false;
  }
  return true;
}

function shouldVerifyAfterRuntimeError(action: AgentAction, rawLog: string): boolean {
  if (action.type === "open_app") return true;
  return action.type === "input" && /运行请求已发送|request was sent|script executed|PHONE_AGENT_RESULT/i.test(rawLog);
}

function shouldVerifyBySourceChange(action: AgentAction): boolean {
  return ["tap_xy", "swipe", "back", "collect_scroll", "open_url"].includes(action.type);
}

function isRetryableRuntimeFailure(message: string, rawLog = ""): boolean {
  return /timeout|timed out|等待设备连接超时|ECONNRESET|ECONNREFUSED|fetch failed|aborted|could not be verified|PHONE_AGENT_RESULT was not captured|运行请求已发送|request was sent/i.test(`${message}\n${rawLog}`);
}

function runtimePackageJson(): Record<string, unknown> {
  return {
    name: "phone-agent-kuai-runtime",
    private: true,
    appId: "phone-agent-kuai-runtime",
    appVersion: 1,
    ui: {
      tabs: [
        {
          name: "phone-agent",
          file: "main.html"
        }
      ]
    },
    scripts: {
      dev: "ms build -d",
      build: "ms build",
      package: "ms package"
    },
    devDependencies: {
      "ms-types": "0.7.3",
      "ms-vite-plugin": "1.1.18",
      "typescript": "^6.0.3"
    }
  };
}

function runtimeTsConfig(): Record<string, unknown> {
  return {
    compilerOptions: {
      target: "ES2020",
      module: "nodenext",
      moduleResolution: "nodenext",
      allowJs: true,
      checkJs: false,
      declaration: false,
      noEmit: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      strict: false,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      typeRoots: ["./node_modules/@types", "./node_modules/ms-types"]
    },
    include: ["env.d.ts", "scripts/**/*", "**/*.js", "**/*.ts"],
    exclude: ["node_modules", "dist", "msbundle"]
  };
}

function runtimeObfuscatorConfig(): Record<string, unknown> {
  return {
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
  };
}

function runtimeHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>phone-agent</title>
  </head>
  <body>
    <main>phone-agent runtime</main>
  </body>
</html>
`;
}

async function watchDeviceLogsForResult(host: string, port: number, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const logs: string[] = [];
  try {
    const response = await fetch(`http://${host}:${port}/logger/sse`, {
      method: "GET",
      headers: { accept: "text/event-stream" },
      signal: controller.signal
    });
    if (!response.ok || !response.body) {
      return `SSE log watch unavailable: ${response.status} ${response.statusText}`;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    while (logs.join("\n").length < 16000) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let splitIndex = buffer.search(/\r?\n\r?\n/);
      while (splitIndex >= 0) {
        const rawBlock = buffer.slice(0, splitIndex);
        buffer = buffer.slice(splitIndex + (buffer[splitIndex] === "\r" ? 4 : 2));
        const line = parseSseLogBlock(rawBlock);
        if (line) {
          logs.push(line);
          if (line.includes(RESULT_PREFIX)) {
            controller.abort();
            return logs.join("\n");
          }
        }
        splitIndex = buffer.search(/\r?\n\r?\n/);
      }
    }
  } catch (error) {
    if (!isAbortError(error)) logs.push(`SSE log watch failed: ${safeError(error)}`);
  } finally {
    clearTimeout(timeout);
  }
  return logs.join("\n");
}

function parseSseLogBlock(rawBlock: string): string | undefined {
  const data = rawBlock.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (!data) return undefined;
  try {
    const parsed = JSON.parse(data) as { message?: unknown; level?: unknown; timestamp?: unknown };
    const message = typeof parsed.message === "string" ? parsed.message : JSON.stringify(parsed);
    return [parsed.timestamp, parsed.level, message].filter(Boolean).map(String).join(" ");
  } catch {
    return data;
  }
}

async function waitForActiveBundle(device: DeviceRecord, expectedBundleId: string, timeoutMs = 5000): Promise<string | undefined> {
  const started = Date.now();
  let lastBundleId: string | undefined;
  while (Date.now() - started < timeoutMs) {
    lastBundleId = await getActiveBundle(device);
    if (lastBundleId === expectedBundleId) return lastBundleId;
    await sleep(450);
  }
  return lastBundleId;
}

const INPUT_TEXT_WAIT_TIMEOUT_MS = 20000;
const INPUT_BAD_STATE_SETTLE_MS = 1000;

async function waitForSourceText(device: DeviceRecord, text: string, timeoutMs = INPUT_TEXT_WAIT_TIMEOUT_MS): Promise<string | undefined> {
  const started = Date.now();
  const needle = text.trim();
  if (!needle) return undefined;
  let lastSourceWithNeedle: string | undefined;
  let badStateStartedAt: number | undefined;
  let badStateSignature = "";
  let failedReads = 0;
  while (Date.now() - started < timeoutMs) {
    try {
      const host = device.runtimeTargetHost ?? device.host;
      const port = device.runtimeTargetPort ?? device.port;
      const response = await fetch(`http://${host}:${port}/api/source`, { signal: AbortSignal.timeout(900) });
      if (!response.ok) {
        failedReads += 1;
        if (failedReads >= 3) return lastSourceWithNeedle;
        await sleep(350);
        continue;
      }
      failedReads = 0;
      const source = await response.text();
      const state = classifyInputSource(source, text);
      if (state === "exact" || state === "duplicate") return source;
      if (state === "short-visible") return source;
      if (state === "partial") {
        const signature = extractTextViewValues(source).join("\u0000");
        if (signature !== badStateSignature) {
          badStateSignature = signature;
          badStateStartedAt = Date.now();
        } else if (badStateStartedAt && Date.now() - badStateStartedAt >= INPUT_BAD_STATE_SETTLE_MS) {
          return source;
        }
      }
      if (state === "outside") {
        lastSourceWithNeedle = source;
      }
    } catch {
      // Keep polling: the bridge can briefly reject /api/source while the UI is updating.
      failedReads += 1;
      if (failedReads >= 3) return lastSourceWithNeedle;
    }
    await sleep(350);
  }
  return lastSourceWithNeedle;
}

function classifyInputSource(source: string, text: string): "absent" | "exact" | "duplicate" | "partial" | "outside" | "short-visible" {
  const normalizedText = normalizeForInputVerification(text);
  if (!normalizedText) return "absent";
  if (normalizedText.length < 50) return source.includes(text.trim()) ? "short-visible" : "absent";

  const values = extractTextViewValues(source).map(normalizeForInputVerification).filter(Boolean);
  const matchingValue = values.find((value) => value.includes(normalizedText));
  if (matchingValue) {
    return countOccurrences(matchingValue, normalizedText) > 1 ? "duplicate" : "exact";
  }
  if (values.some((value) => isLikelyAbbreviatedInputValue(value, normalizedText))) return "exact";

  const head = normalizedText.slice(0, Math.min(24, normalizedText.length));
  if (head && values.some((value) => value.includes(head) || (value.length >= 8 && normalizedText.includes(value)))) return "partial";
  return source.includes(text) ? "outside" : "absent";
}

function inputVerificationError(source: string, text: string): string | undefined {
  const normalizedText = normalizeForInputVerification(text);
  if (normalizedText.length < 50) return undefined;
  const values = extractTextViewValues(source).map(normalizeForInputVerification).filter(Boolean);
  const matchingValue = values.find((value) => value.includes(normalizedText));
  if (!matchingValue) {
    if (values.some((value) => isLikelyAbbreviatedInputValue(value, normalizedText))) return undefined;
    const head = normalizedText.slice(0, Math.min(24, normalizedText.length));
    if (head && values.some((value) => value.includes(head))) {
      return "Input verification failed: only a partial draft is visible in the active input field.";
    }
    if (source.includes(text)) {
      return "Input verification failed: expected text was found outside the active input field.";
    }
    return undefined;
  }
  if (countOccurrences(matchingValue, normalizedText) > 1) {
    return "Input verification failed: duplicate long draft detected after input; refusing to continue appending text.";
  }
  return undefined;
}

function extractTextViewValues(source: string): string[] {
  return [...source.matchAll(/<XCUIElementTypeTextView\b[^>]*\bvalue="([^"]*)"/g)]
    .map((match) => decodeXmlAttribute(match[1]));
}

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function normalizeForInputVerification(value: string): string {
  return value.replace(/\s+/g, "");
}

function isLikelyAbbreviatedInputValue(value: string, expected: string): boolean {
  if (expected.length < 120 || value.length < 80) return false;
  const compactValue = value.replace(/[.。…]{2,}/g, "");
  const positions = [0, 0.25, 0.5, 0.75, 1];
  const anchors = positions
    .map((position) => {
      if (position === 1) return expected.slice(Math.max(0, expected.length - 24));
      const start = Math.floor(expected.length * position);
      return expected.slice(start, start + (position === 0 ? 28 : 18));
    })
    .filter((anchor) => anchor.length >= 8);
  const hits = anchors.filter((anchor) => compactValue.includes(anchor)).length;
  const hasHead = anchors[0] ? compactValue.includes(anchors[0]) : false;
  const tail = anchors[anchors.length - 1];
  const hasTail = tail ? compactValue.includes(tail) : false;
  return hits >= 4 || (hits >= 3 && hasHead && hasTail);
}

function countOccurrences(value: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (index < value.length) {
    const found = value.indexOf(needle, index);
    if (found < 0) break;
    count += 1;
    index = found + needle.length;
  }
  return count;
}

async function waitForSourceChange(device: DeviceRecord, sourceBefore: string, timeoutMs = 3500): Promise<string | undefined> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = await readDeviceSource(device).catch(() => undefined);
    if (current && current !== sourceBefore) return current;
    await sleep(350);
  }
  return undefined;
}

async function readDeviceSource(device: DeviceRecord, timeoutMs = 1800): Promise<string | undefined> {
  const host = device.runtimeTargetHost ?? device.host;
  const port = device.runtimeTargetPort ?? device.port;
  const response = await fetch(`http://${host}:${port}/api/source`, { signal: AbortSignal.timeout(timeoutMs) });
  return response.ok ? response.text() : undefined;
}

async function getActiveBundle(device: DeviceRecord): Promise<string | undefined> {
  const activeBundle = await getActiveBundleFromEndpoint(device).catch(() => undefined);
  if (activeBundle) return activeBundle;
  return getSourceRootBundle(device).catch(() => undefined);
}

async function getActiveBundleFromEndpoint(device: DeviceRecord): Promise<string | undefined> {
  try {
    const host = device.runtimeTargetHost ?? device.host;
    const port = device.runtimeTargetPort ?? device.port;
    const response = await fetch(`http://${host}:${port}/api/activeAppInfo`, { signal: AbortSignal.timeout(1800) });
    if (!response.ok) return undefined;
    const payload = await response.json() as { data?: { bundleId?: unknown; name?: unknown }; bundleId?: unknown; name?: unknown };
    const data = payload.data ?? payload;
    const bundleId = data.bundleId ?? data.name;
    return typeof bundleId === "string" ? bundleId : undefined;
  } catch {
    return undefined;
  }
}

async function getSourceRootBundle(device: DeviceRecord): Promise<string | undefined> {
  const source = await readDeviceSource(device, 1800);
  const rootTag = source?.match(/<XCUIElementTypeApplication\b[^>]*>/)?.[0];
  const bundleId = rootTag?.match(/\bbundleId="([^"]+)"/)?.[1]
    ?? rootTag?.match(/\bidentifier="([^"]+)"/)?.[1];
  return bundleId || undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|abort/i.test(error.message));
}

async function commandExists(
  file: string,
  args: string[],
  runner: CommandRunner,
  env?: NodeJS.ProcessEnv
): Promise<boolean> {
  try {
    await runner(file, args, { timeoutMs: 10000, env });
    return true;
  } catch {
    return false;
  }
}

async function packageVersion(packageJsonPath: string): Promise<string | undefined> {
  try {
    const text = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(text) as { version?: string };
    return parsed.version;
  } catch {
    return undefined;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function defaultCommandRunner(
  file: string,
  args: string[],
  options: CommandRunOptions
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(file, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    timeout: options.timeoutMs,
    windowsHide: true,
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(file),
    maxBuffer: 4 * 1024 * 1024
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function errorOutput(error: unknown): string {
  if (error && typeof error === "object") {
    const candidate = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    return [candidate.stdout, candidate.stderr, candidate.message].filter(Boolean).map(String).join("\n");
  }
  return safeError(error);
}

function redactAndLimit(rawLog: string): string {
  return truncate(redactSecrets(rawLog), 8000);
}

function runtimeModeFor(host: string, transport: "http" | "ws"): RuntimeMode {
  if (transport === "ws") return "ws-server";
  return host === "127.0.0.1" || host === "localhost" || host === "::1" ? "bridge-http" : "lan-http";
}

function isRuntimeMode(value: unknown): value is RuntimeMode {
  return value === "bridge-http" || value === "lan-http" || value === "ws-server";
}
