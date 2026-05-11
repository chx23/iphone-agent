import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BuildInfo, DeviceRecord, HealthCheck } from "../shared/types";
import { KuaiProjectRuntime } from "./kuaijsProjectRuntime";
import { normalizeBaseUrl, now, safeError } from "./utils";

const execFileAsync = promisify(execFile);

interface RequestOptions {
  timeoutMs?: number;
  method?: "GET" | "POST";
  body?: unknown;
}

interface KuaijsStatusResponse {
  success?: boolean;
  data?: KuaijsStatusData;
  [key: string]: unknown;
}

interface KuaijsStatusData {
  isLogin?: boolean;
  isDebugMode?: boolean;
  orientation?: string;
  isShowUI?: boolean;
  serverDeviceId?: string;
  deviceName?: string;
  agentConnected?: boolean;
  isAuth?: boolean;
  serverType?: string;
  isHidConnected?: boolean;
  isRun?: boolean;
  [key: string]: unknown;
}

interface ImeStatus {
  ok: boolean;
  message: string;
}

export class KuaijsRequestError extends Error {
  constructor(
    message: string,
    readonly endpoint: string,
    readonly status?: number,
    readonly statusText?: string,
    readonly connectionMode?: "lan" | "bridge"
  ) {
    super(message);
    this.name = "KuaijsRequestError";
  }
}

interface AppDiagnostics {
  buildInfo: BuildInfo;
  executablePath: string;
  releaseDir?: string;
}

export class KuaijsClient {
  constructor(
    private readonly getDevices: () => DeviceRecord[],
    private readonly projectRuntime?: KuaiProjectRuntime,
    private readonly diagnostics?: AppDiagnostics
  ) {}

  baseUrl(device: DeviceRecord): string {
    return `http://${device.host}:${device.port}`;
  }

  mirrorUrl(device: DeviceRecord): string {
    return `${this.baseUrl(device)}/mirror/image?fps=10&quality=0.8`;
  }

  findDevice(deviceId?: string): DeviceRecord | undefined {
    const devices = this.getDevices();
    return deviceId ? devices.find((device) => device.id === deviceId) : devices[0];
  }

  async requestText(device: DeviceRecord, path: string, options: RequestOptions = {}): Promise<string> {
    const timeoutMs = options.timeoutMs ?? 5000;
    const url = `${this.baseUrl(device)}${path}`;
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.body ? { "content-type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      throw new KuaijsRequestError(
        `KuaiJS ${path} failed: ${response.status} ${response.statusText}`,
        path,
        response.status,
        response.statusText,
        device.connectionMode ?? (isLoopbackHost(device.host) ? "bridge" : "lan")
      );
    }
    return response.text();
  }

  async requestJson<T = unknown>(device: DeviceRecord, path: string, options: RequestOptions = {}): Promise<T> {
    const text = await this.requestText(device, path, options);
    if (!text.trim()) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return { raw: text } as T;
    }
  }

  async status(device: DeviceRecord): Promise<unknown> {
    return this.requestJson(device, "/api/status", { timeoutMs: 1600 });
  }

  async statusData(device: DeviceRecord, timeoutMs = 1600): Promise<KuaijsStatusData | undefined> {
    const status = await this.requestJson<KuaijsStatusResponse>(device, "/api/status", { timeoutMs });
    return extractStatusData(status);
  }

  async screenshotBase64(device: DeviceRecord): Promise<string> {
    const text = await this.requestText(device, "/api/screenshotBase64", { timeoutMs: 8000 });
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const candidate = parsed.data ?? parsed.result ?? parsed.base64 ?? parsed.image ?? parsed.raw;
      if (typeof candidate === "string") return stripDataPrefix(candidate);
    }
    return stripDataPrefix(trimmed);
  }

  async source(device: DeviceRecord, maxDepth = 80): Promise<string> {
    return this.requestText(device, `/api/source?max_depth=${maxDepth}&timeout=120`, { timeoutMs: 8000 });
  }

  async activeAppInfo(device: DeviceRecord): Promise<unknown> {
    return this.requestJson(device, "/api/activeAppInfo", { timeoutMs: 3000 });
  }

  async imeIsOk(device: DeviceRecord): Promise<boolean> {
    return (await this.imeStatus(device)).ok;
  }

  async imeStatus(device: DeviceRecord): Promise<ImeStatus> {
    try {
      const result = await this.requestJson<Record<string, unknown>>(device, "/api/ime/isOk", { timeoutMs: 2500 });
      const ok = Boolean(result.data ?? result.result ?? result.ok ?? result.raw);
      return { ok, message: ok ? "IME is ready." : "IME is not ready." };
    } catch (error) {
      const message = safeError(error);
      if (/401|Unauthorized/i.test(message)) {
        return { ok: false, message: "IME endpoint is unauthorized or API keyboard is not enabled." };
      }
      return { ok: false, message };
    }
  }

  async healthCheck(device: DeviceRecord | undefined, llmConfigured: boolean, visionConfigured = false): Promise<HealthCheck> {
    const checkedAt = now();
    const oldProcessWarning = await detectOldPortableProcess(this.diagnostics);
    if (!device) {
      const projectRuntimeHealth = await this.projectRuntime?.healthCheck();
      return {
        deviceOnline: false,
        kuaijsReachable: false,
        mirrorReachable: false,
        screenshotOk: false,
        sourceOk: false,
        imeOk: false,
        observationOk: false,
        controlAuthorized: false,
        nodeReady: projectRuntimeHealth?.nodeReady ?? false,
        npmReady: projectRuntimeHealth?.npmReady ?? false,
        msCliReady: projectRuntimeHealth?.msCliReady ?? false,
        projectRuntimeReady: projectRuntimeHealth?.projectRuntimeReady ?? false,
        projectRuntimeState: projectRuntimeHealth?.state ?? "not_started",
        controlBackend: "none",
        llmConfigured,
        visionConfigured,
        buildInfo: this.diagnostics?.buildInfo,
        executablePath: this.diagnostics?.executablePath,
        oldProcessWarning,
        checkedAt,
        controlMessage: "还没有选择手机。",
        projectRuntimeDir: projectRuntimeHealth?.projectDir ?? this.projectRuntime?.projectDir,
        projectRuntimeMessage: projectRuntimeHealth?.message,
        projectRuntimeLastError: projectRuntimeHealth?.lastError,
        runtimeSmokeOk: projectRuntimeHealth?.runtimeSmokeOk,
        message: "还没有选择手机。"
      };
    }

    const [status, screenshot, source, ime, projectRuntime] = await Promise.allSettled([
      this.statusData(device),
      this.screenshotBase64(device),
      this.source(device, 30),
      this.imeStatus(device),
      this.projectRuntime?.healthCheck()
    ]);

    const kuaijsReachable = status.status === "fulfilled";
    const statusData = status.status === "fulfilled" ? status.value : undefined;
    const screenshotOk = screenshot.status === "fulfilled" && screenshot.value.length > 100;
    const sourceOk = source.status === "fulfilled" && source.value.length > 0;
    const imeOk = ime.status === "fulfilled" && ime.value.ok;
    const observationOk = screenshotOk && sourceOk;
    const mirrorReachable = kuaijsReachable;
    const deviceOnline = kuaijsReachable || screenshotOk || sourceOk;
    const projectRuntimeHealth = projectRuntime.status === "fulfilled" ? projectRuntime.value : undefined;
    const projectRuntimeReady = projectRuntimeHealth?.projectRuntimeReady ?? false;
    const controlBackend = projectRuntimeReady ? "kuaijs-project" : "none";
    const controlMessage = buildControlMessage(statusData, deviceOnline, projectRuntimeReady);
    const suggestedBridge = !deviceOnline && device.connectionMode !== "bridge"
      ? (await this.discoverBridge())[0]
      : undefined;

    return {
      deviceOnline,
      kuaijsReachable,
      mirrorReachable,
      screenshotOk,
      sourceOk,
      imeOk,
      observationOk,
      controlAuthorized: projectRuntimeReady,
      nodeReady: projectRuntimeHealth?.nodeReady ?? false,
      npmReady: projectRuntimeHealth?.npmReady ?? false,
      msCliReady: projectRuntimeHealth?.msCliReady ?? false,
      projectRuntimeReady,
      projectRuntimeState: projectRuntimeHealth?.state ?? "not_started",
      controlBackend,
      llmConfigured,
      visionConfigured,
      buildInfo: this.diagnostics?.buildInfo,
      executablePath: this.diagnostics?.executablePath,
      oldProcessWarning,
      connectionMode: device.connectionMode ?? (isLoopbackHost(device.host) ? "bridge" : "lan"),
      agentConnected: statusData?.agentConnected,
      isLogin: statusData?.isLogin,
      isAuth: statusData?.isAuth,
      deviceName: statusData?.deviceName ?? device.deviceName,
      serverDeviceId: statusData?.serverDeviceId ?? device.serverDeviceId,
      imeMessage: ime.status === "fulfilled" ? ime.value.message : safeError(ime.reason),
      controlMessage,
      projectRuntimeDir: projectRuntimeHealth?.projectDir ?? this.projectRuntime?.projectDir,
      projectRuntimeMessage: projectRuntimeHealth?.message ?? "KuaiJS project runtime is not configured.",
      projectRuntimeLastError: projectRuntimeHealth?.lastError,
      runtimeSmokeOk: projectRuntimeHealth?.runtimeSmokeOk,
      suggestedBridge: suggestedBridge && `${suggestedBridge.host}:${suggestedBridge.port}` !== `${device.host}:${device.port}` ? suggestedBridge : undefined,
      checkedAt,
      message: buildHealthMessage(device, deviceOnline, statusData, suggestedBridge, controlMessage, projectRuntimeHealth?.message)
    };
  }

  async recheckProjectRuntime(): Promise<void> {
    await this.projectRuntime?.recheck();
  }

  async discover(port = 9800): Promise<DeviceRecord[]> {
    const [bridgeDevices, lanDevices] = await Promise.all([
      this.discoverBridge(),
      this.discoverLan(port)
    ]);
    return dedupeDevices([...bridgeDevices, ...lanDevices]);
  }

  async discoverBridge(): Promise<DeviceRecord[]> {
    const ports = await getLocalListeningPorts();
    const found: DeviceRecord[] = [];
    let cursor = 0;
    const workerCount = Math.min(32, ports.length);

    const worker = async (): Promise<void> => {
      while (cursor < ports.length) {
        const port = ports[cursor];
        cursor += 1;
        const device: DeviceRecord = {
          id: `bridge_127_0_0_1_${port}`,
          name: `Local KuaiJS Bridge ${port}`,
          host: "127.0.0.1",
          port,
          source: "bridge",
          connectionMode: "bridge",
          lastSeenAt: now()
        };
        try {
          const status = await this.statusData(device, 550);
          if (isUsableBridgeStatus(status)) {
            found.push({
              ...device,
              name: `本机群控 ${status?.deviceName ?? "iPhone"}`,
              deviceName: status?.deviceName,
              serverDeviceId: status?.serverDeviceId
            });
          }
        } catch {
          // Most local services are unrelated; ignore them quietly.
        }
      }
    };

    if (workerCount > 0) await Promise.all(Array.from({ length: workerCount }, worker));
    return dedupeDevices(found);
  }

  private async discoverLan(port = 9800): Promise<DeviceRecord[]> {
    const candidates = localSubnetHosts(port);
    const found: DeviceRecord[] = [];
    let cursor = 0;
    const workerCount = Math.min(48, candidates.length);

    const worker = async (): Promise<void> => {
      while (cursor < candidates.length) {
        const candidate = candidates[cursor];
        cursor += 1;
        try {
          const url = `${normalizeBaseUrl(candidate.url)}/api/status`;
          const response = await fetch(url, { signal: AbortSignal.timeout(650) });
          if (response.ok) {
            const status = await response.json().catch(() => undefined) as KuaijsStatusResponse | undefined;
            const statusData = extractStatusData(status);
            found.push({
              id: `dev_${candidate.host.replace(/\./g, "_")}_${port}`,
              name: `快点JS ${statusData?.deviceName ?? candidate.host}`,
              host: candidate.host,
              port,
              source: "discovered",
              connectionMode: "lan",
              deviceName: statusData?.deviceName,
              serverDeviceId: statusData?.serverDeviceId,
              lastSeenAt: now()
            });
          }
        } catch {
          // Discovery is intentionally quiet; most LAN addresses will not answer.
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, worker));
    return dedupeDevices(found);
  }
}

function stripDataPrefix(input: string): string {
  const comma = input.indexOf(",");
  return input.startsWith("data:image") && comma >= 0 ? input.slice(comma + 1) : input;
}

export function extractStatusData(status: unknown): KuaijsStatusData | undefined {
  if (!status || typeof status !== "object") return undefined;
  const object = status as KuaijsStatusResponse;
  const data = object.data && typeof object.data === "object" ? object.data : object;
  return data as KuaijsStatusData;
}

export function isUsableBridgeStatus(status: KuaijsStatusData | undefined): boolean {
  return Boolean(status?.agentConnected || status?.serverDeviceId || status?.deviceName);
}

function buildHealthMessage(
  device: DeviceRecord,
  deviceOnline: boolean,
  status: KuaijsStatusData | undefined,
  suggestedBridge: DeviceRecord | undefined,
  controlMessage: string,
  projectRuntimeMessage?: string
): string {
  const mode = device.connectionMode === "bridge" || isLoopbackHost(device.host) ? "Local KuaiJS Bridge" : "LAN HTTP";
  if (deviceOnline) {
    const agent = status?.agentConnected === false ? " Agent is not connected." : "";
    const runtime = projectRuntimeMessage ? ` ${projectRuntimeMessage}` : "";
    return `${mode} connected to ${status?.deviceName ?? device.deviceName ?? device.host}.${agent} ${controlMessage}${runtime}`;
  }
  if (suggestedBridge) {
    return `Cannot reach ${device.host}:${device.port}. A local KuaiJS bridge is available at ${suggestedBridge.host}:${suggestedBridge.port}.`;
  }
  return `Cannot reach ${device.host}:${device.port}. Check KuaiJS activation, USB bridge, or LAN routing.`;
}

export function buildControlMessage(status: KuaijsStatusData | undefined, deviceOnline: boolean, projectRuntimeReady = false): string {
  if (!deviceOnline) return "设备离线，当前只能等待重新连接。";
  if (!status) return "状态接口不可用，当前只能观察已读取到的画面。";
  if (status.agentConnected === false) return "快点JS Agent 未连接，当前不能自动控制手机。";
  if (projectRuntimeReady) return "自动控制使用快点JS项目运行时；isAuth 仅作为诊断信息保留。";
  return "快点JS项目运行时暂不可用，当前只能观察手机。";
}

export function isEndpointUnauthorized(error: unknown, endpointPrefix?: string): boolean {
  if (!(error instanceof KuaijsRequestError)) return false;
  const endpointMatches = endpointPrefix ? error.endpoint.startsWith(endpointPrefix) : true;
  return endpointMatches && (error.status === 401 || error.status === 403);
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

async function detectOldPortableProcess(diagnostics?: AppDiagnostics): Promise<string | undefined> {
  if (process.platform !== "win32" || !diagnostics?.releaseDir) return undefined;

  const releaseDir = diagnostics.releaseDir.replace(/'/g, "''");
  const currentExe = diagnostics.executablePath.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$releaseDir='${releaseDir}'`,
    `$currentExe='${currentExe}'`,
    "$legacyExe = Join-Path $releaseDir 'phone-agent 0.1.0.exe'",
    "$matches = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ne $currentExe -and $_.ExecutablePath -like $legacyExe } | Select-Object -First 3 -Property ProcessId,ExecutablePath)",
    "if ($matches.Count -gt 0) { $matches | ConvertTo-Json -Compress }"
  ].join("; ");

  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout: 1800 });
    if (!stdout.trim()) return undefined;
    return "旧版 portable 仍在运行：release\\phone-agent 0.1.0.exe。请关闭它后再测试新版 0.1.1。";
  } catch {
    return undefined;
  }
}

async function getLocalListeningPorts(): Promise<number[]> {
  if (process.platform === "win32") {
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
      const trimmed = stdout.trim();
      if (!trimmed) return fallbackBridgePorts();
      const parsed = JSON.parse(trimmed) as number | number[];
      const ports = Array.isArray(parsed) ? parsed : [parsed];
      return normalizePorts([...ports, ...fallbackBridgePorts()]);
    } catch {
      return fallbackBridgePorts();
    }
  }

  return fallbackBridgePorts();
}

export function fallbackBridgePorts(): number[] {
  return [
    ...range(58120, 58140),
    ...range(59840, 59860),
    ...range(60090, 60120),
    34116,
    58128
  ];
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function normalizePorts(ports: number[]): number[] {
  return [...new Set(ports.filter((port) => Number.isInteger(port) && port > 0 && port < 65536))];
}

function localSubnetHosts(port: number): Array<{ host: string; url: string }> {
  const networks = os.networkInterfaces();
  const prefixes = new Set<string>();
  for (const details of Object.values(networks)) {
    for (const detail of details ?? []) {
      if (detail.family === "IPv4" && !detail.internal) {
        const parts = detail.address.split(".");
        if (parts.length === 4) {
          prefixes.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
        }
      }
    }
  }

  return [...prefixes].flatMap((prefix) =>
    Array.from({ length: 254 }, (_, index) => {
      const host = `${prefix}.${index + 1}`;
      return { host, url: `http://${host}:${port}` };
    })
  );
}

function dedupeDevices(devices: DeviceRecord[]): DeviceRecord[] {
  const byAddress = new Map<string, DeviceRecord>();
  for (const device of devices) {
    byAddress.set(`${device.host}:${device.port}`, device);
  }
  return [...byAddress.values()];
}
