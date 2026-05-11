import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAction, AgentSnapshot, AppSettings, DeviceRecord, DiagnosticEvent } from "../shared/types";
import { AgentRuntime } from "./agent/runtime";
import { ControlRouter } from "./controlRouter";
import { DiagnosticsLogger } from "./diagnosticsLogger";
import { loadLocalEnv } from "./env";
import { KuaijsClient } from "./kuaijsClient";
import { KuaiProjectRuntime } from "./kuaijsProjectRuntime";
import { LlmClient } from "./llmClient";
import { redactSecrets, safeError, sleep } from "./utils";
import { VisionClient } from "./visionClient";

const DEFAULT_AI_API_URL = "https://llmapi.paratera.com/v1/chat/completions";
const DEFAULT_AI_MODEL = "GLM-5-Turbo";
const DEFAULT_VISION_API_URL = "https://llmapi.paratera.com/v1/chat/completions";
const DEFAULT_VISION_MODEL = "Qwen3-VL-235B-A22B-Instruct";

interface CliOptions {
  task?: string;
  actionJson?: string;
  directAction?: AgentAction;
  deviceUrl?: string;
  timeoutMs: number;
  json: boolean;
  autoConfirm: boolean;
  health: boolean;
  smoke: boolean;
  trustedContacts: string[];
}

async function main(): Promise<void> {
  loadLocalEnv();
  const options = parseArgs(process.argv.slice(2));
  const userDataDir = process.env.PHONE_AGENT_USER_DATA
    ?? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "phone-agent");
  await mkdir(userDataDir, { recursive: true });

  const diagnostics = new DiagnosticsLogger(userDataDir);
  const diagnosticSink = (event: Omit<DiagnosticEvent, "id" | "timestamp">): void => {
    void diagnostics.log(event);
  };
  const projectRuntime = new KuaiProjectRuntime({
    rootDir: join(userDataDir, "phone-agent-kuai-runtime")
  });
  const control = new ControlRouter(projectRuntime, diagnosticSink);
  await projectRuntime.ensure();

  const devices: DeviceRecord[] = [];
  const kuaijs = new KuaijsClient(
    () => devices,
    projectRuntime,
    {
      buildInfo: { version: process.env.npm_package_version ?? "headless", buildTime: new Date().toISOString() },
      executablePath: process.execPath
    }
  );
  const device = await resolveDevice(kuaijs, devices, options.deviceUrl);
  const settings = buildSettings(device.id, options);
  const llm = new LlmClient(
    () => settings.aiApiUrl,
    () => process.env.AI_API_KEY,
    () => settings.aiModel,
    diagnosticSink
  );
  const vision = new VisionClient(
    () => settings.visionApiUrl,
    () => process.env.VISION_API_KEY,
    () => settings.visionModel,
    diagnosticSink
  );

  if (options.health) {
    const health = await kuaijs.healthCheck(device, settings.hasAiApiKey, settings.hasVisionApiKey);
    printResult(options, health);
    return;
  }

  if (options.smoke) {
    const result = await control.runtimeSmokeTest(device);
    printResult(options, result);
    if (!result.ok) process.exitCode = 2;
    return;
  }

  if (options.actionJson || options.directAction) {
    const action = options.directAction ?? JSON.parse(options.actionJson ?? "{}") as AgentAction;
    const message = await control.execute(device, action);
    printResult(options, { ok: true, message });
    return;
  }

  if (!options.task) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const agent = new AgentRuntime({
    getSettings: () => settings,
    getDevice: (deviceId) => devices.find((item) => item.id === deviceId),
    kuaijs,
    control,
    llm,
    vision,
    diagnostics: diagnosticSink
  });

  let printedTimeline = 0;
  if (!options.json) {
    agent.on("changed", (snapshot) => {
      for (const event of snapshot.timeline.slice(printedTimeline)) {
        console.log(`[${snapshot.state}] ${event.title} - ${event.detail}`);
      }
      printedTimeline = snapshot.timeline.length;
      if (snapshot.pendingConfirmation) {
        console.log(`[confirm] ${snapshot.pendingConfirmation.title} - ${snapshot.pendingConfirmation.message}`);
      }
    });
  }

  const initial = await agent.start({
    instruction: options.task,
    deviceId: device.id,
    autonomy: "task_scoped",
    sensitivePolicy: "confirm_final"
  });
  if (!options.json) console.log(`[task] started ${initial.taskId ?? ""} on ${device.name}`);

  const finalSnapshot = await waitForTerminalSnapshot(agent, options.timeoutMs, options.autoConfirm);
  printResult(options, {
    ok: finalSnapshot.state === "finished",
    state: finalSnapshot.state,
    taskId: finalSnapshot.taskId,
    timeline: sanitizeTimeline(finalSnapshot.timeline),
    pendingConfirmation: finalSnapshot.pendingConfirmation,
    logDir: diagnostics.logDir
  });
  if (finalSnapshot.state !== "finished") process.exitCode = 2;
}

function parseArgs(args: string[]): CliOptions {
  const taskFromFlag = optionValue(args, "--task");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const trusted = [
    ...multiOptionValues(args, "--trusted-contact"),
    ...(process.env.PHONE_AGENT_TRUSTED_CONTACTS ?? "").split(",")
  ].map((item) => item.trim()).filter(Boolean);
  return {
    task: taskFromFlag ?? (positional.join(" ").trim() || undefined),
    actionJson: optionValue(args, "--action-json"),
    directAction: parseDirectAction(args),
    deviceUrl: optionValue(args, "--device-url") ?? process.env.PHONE_AGENT_DEVICE_URL,
    timeoutMs: Number(optionValue(args, "--timeout-ms") ?? process.env.PHONE_AGENT_TIMEOUT_MS ?? 900000),
    json: args.includes("--json"),
    autoConfirm: args.includes("--auto-confirm") || process.env.PHONE_AGENT_AUTO_CONFIRM === "1",
    health: args.includes("--health"),
    smoke: args.includes("--smoke"),
    trustedContacts: trusted
  };
}

function parseDirectAction(args: string[]): AgentAction | undefined {
  if (args.includes("--home")) return { type: "home" };
  if (args.includes("--back")) return { type: "back" };
  const openApp = optionValue(args, "--open-app");
  if (openApp) {
    const knownBundles: Record<string, string> = {
      "微信": "com.tencent.xin",
      "WeChat": "com.tencent.xin",
      "大众点评": "com.dianping.dpscope"
    };
    return { type: "open_app", bundleId: knownBundles[openApp] ?? openApp, displayName: knownBundles[openApp] ? openApp : undefined };
  }
  const tap = optionValue(args, "--tap");
  if (tap) {
    const [x, y] = tap.split(",").map((value) => Number(value.trim()));
    if (Number.isFinite(x) && Number.isFinite(y)) return { type: "tap_xy", x, y, coordinateSpace: "screen" };
  }
  const tapText = optionValue(args, "--tap-text");
  if (tapText) return { type: "tap_text", text: tapText };
  const input = optionValue(args, "--input");
  if (input) return { type: "input", text: input };
  return undefined;
}

function optionValue(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function multiOptionValues(args: string[], name: string): string[] {
  const prefix = `${name}=`;
  const values: string[] = [];
  args.forEach((arg, index) => {
    if (arg.startsWith(prefix)) values.push(arg.slice(prefix.length));
    if (arg === name && args[index + 1]) values.push(args[index + 1]);
  });
  return values;
}

async function resolveDevice(kuaijs: KuaijsClient, devices: DeviceRecord[], explicitUrl?: string): Promise<DeviceRecord> {
  if (explicitUrl) {
    const url = new URL(explicitUrl);
    const device = deviceFromHostPort(url.hostname, Number(url.port || "9800"), "manual");
    devices.push(device);
    return device;
  }
  const discovered = await kuaijs.discoverBridge();
  if (!discovered[0]) throw new Error("No local KuaiJS bridge was discovered. Keep KuaiJS group-control running or pass --device-url=http://127.0.0.1:<port>.");
  devices.push(discovered[0]);
  return discovered[0];
}

function deviceFromHostPort(host: string, port: number, source: DeviceRecord["source"]): DeviceRecord {
  return {
    id: `${source}_${host.replace(/\W/g, "_")}_${port}`,
    name: `${host}:${port}`,
    host,
    port,
    source,
    connectionMode: host === "127.0.0.1" || host === "localhost" ? "bridge" : "lan",
    preferredRunTransport: "http",
    runtimeTargetHost: host,
    runtimeTargetPort: port,
    runtimeTransport: "http",
    lastSeenAt: Date.now()
  };
}

function buildSettings(deviceId: string, options: CliOptions): AppSettings {
  const hasAiApiKey = Boolean(process.env.AI_API_KEY);
  const hasVisionApiKey = Boolean(process.env.VISION_API_KEY);
  return {
    selectedDeviceId: deviceId,
    aiApiUrl: process.env.AI_API_URL ?? DEFAULT_AI_API_URL,
    aiModel: process.env.LANGUAGE_MODEL ?? DEFAULT_AI_MODEL,
    hasAiApiKey,
    visionApiUrl: process.env.VISION_API_URL ?? DEFAULT_VISION_API_URL,
    visionModel: process.env.VISION_MODEL ?? DEFAULT_VISION_MODEL,
    hasVisionApiKey,
    parateraBaseUrl: process.env.AI_API_URL ?? DEFAULT_AI_API_URL,
    parateraModel: process.env.LANGUAGE_MODEL ?? DEFAULT_AI_MODEL,
    hasApiKey: hasAiApiKey,
    whitelist: options.trustedContacts.map((label) => ({ id: `trusted_${label}`, label, kind: "contact", autoSend: true })),
    advancedAutoMode: process.env.PHONE_AGENT_ADVANCED_AUTO_MODE !== "0"
  };
}

async function waitForTerminalSnapshot(agent: AgentRuntime, timeoutMs: number, autoConfirm: boolean): Promise<AgentSnapshot> {
  const started = Date.now();
  const confirmed = new Set<string>();
  while (Date.now() - started < timeoutMs) {
    const snapshot = agent.getSnapshot();
    if (snapshot.state === "waiting_confirmation" && snapshot.pendingConfirmation && autoConfirm && !confirmed.has(snapshot.pendingConfirmation.id)) {
      confirmed.add(snapshot.pendingConfirmation.id);
      await agent.confirm({ confirmationId: snapshot.pendingConfirmation.id, approved: true });
    }
    if (snapshot.state === "finished" || snapshot.state === "stuck" || snapshot.state === "waiting_confirmation") {
      return agent.getSnapshot();
    }
    await sleep(1000);
  }
  await agent.stop();
  return agent.getSnapshot();
}

function printResult(options: CliOptions, value: unknown): void {
  if (options.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(redactSecrets(JSON.stringify(value, null, 2)));
}

function sanitizeTimeline(timeline: AgentSnapshot["timeline"]): AgentSnapshot["timeline"] {
  return timeline.map((event) => ({
    ...event,
    screenshotBase64: event.screenshotBase64 ? `[base64:${event.screenshotBase64.length}]` : undefined
  }));
}

function printUsage(): void {
  console.log([
    "Usage:",
    "  npm run agent:run -- --task=\"打开微信\"",
    "  npm run agent:run -- \"打开机械之心公众号，阅读最新文章并总结\"",
    "  npm run agent:run -- --health",
    "  npm run agent:run -- --smoke",
    "  npm run agent:run -- --home",
    "  npm run agent:run -- --open-app 微信",
    "  npm run agent:run -- --tap-text 公众号",
    "  npm run agent:run -- --action-json='{\"type\":\"home\"}'",
    "",
    "Useful env:",
    "  PHONE_AGENT_DEVICE_URL=http://127.0.0.1:59844",
    "  AI_API_URL, AI_API_KEY, LANGUAGE_MODEL",
    "  VISION_API_URL, VISION_API_KEY, VISION_MODEL",
    "  PHONE_AGENT_TRUSTED_CONTACTS=陈弘轩",
    "  PHONE_AGENT_AUTO_CONFIRM=1"
  ].join("\n"));
}

main().catch((error) => {
  console.error(redactSecrets(safeError(error)));
  process.exitCode = 1;
});
