import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppSettings, DeviceRecord, DiagnosticEvent } from "../../shared/types";
import { ControlRouter } from "../controlRouter";
import { DiagnosticsLogger } from "../diagnosticsLogger";
import { KuaijsClient } from "../kuaijsClient";
import { KuaiProjectRuntime } from "../kuaijsProjectRuntime";
import { AgentRuntime } from "./runtime";

const runLive = process.env.LIVE_PHONE_AGENT_OPEN_APP === "1";
const liveIt = runLive ? it : it.skip;

describe("live phone agent open app", () => {
  liveIt("opens WeChat through the Agent runtime and stops after the app is active", async () => {
    const port = Number(process.env.PHONE_AGENT_DEVICE_PORT ?? "59844");
    const userDataDir = process.env.PHONE_AGENT_USER_DATA
      ?? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "phone-agent");
    await mkdir(userDataDir, { recursive: true });

    const device: DeviceRecord = {
      id: `bridge_127_0_0_1_${port}`,
      name: `Local KuaiJS Bridge ${port}`,
      host: "127.0.0.1",
      port,
      source: "bridge",
      connectionMode: "bridge",
      preferredRunTransport: "http",
      runtimeTargetHost: "127.0.0.1",
      runtimeTargetPort: port,
      runtimeTransport: "http"
    };
    const devices = [device];
    const diagnostics = new DiagnosticsLogger(userDataDir);
    const logged: Array<Omit<DiagnosticEvent, "id" | "timestamp">> = [];
    const diagnosticSink = (event: Omit<DiagnosticEvent, "id" | "timestamp">): void => {
      logged.push(event);
      void diagnostics.log(event);
    };

    const projectRuntime = new KuaiProjectRuntime({
      rootDir: join(userDataDir, "phone-agent-kuai-runtime")
    });
    await projectRuntime.ensure();
    const control = new ControlRouter(projectRuntime, undefined, diagnosticSink);
    const kuaijs = new KuaijsClient(
      () => devices,
      projectRuntime,
      {
        buildInfo: { version: "live-open-app-test", buildTime: new Date().toISOString() },
        executablePath: process.execPath
      }
    );

    const settings: AppSettings = {
      selectedDeviceId: device.id,
      aiApiUrl: "",
      aiModel: "disabled-live-fallback",
      hasAiApiKey: false,
      visionApiUrl: "",
      visionModel: "disabled-live-fallback",
      hasVisionApiKey: false,
      parateraBaseUrl: "",
      parateraModel: "disabled-live-fallback",
      hasApiKey: false,
      whitelist: [],
      advancedAutoMode: true
    };
    const llm = {
      completeJson: async () => {
        throw new Error("LLM disabled for deterministic live open-app test.");
      }
    };
    const agent = new AgentRuntime({
      getSettings: () => settings,
      getDevice: (deviceId: string) => devices.find((item) => item.id === deviceId),
      kuaijs,
      control,
      llm,
      diagnostics: diagnosticSink
    } as never);

    await control.execute(device, { type: "home" });
    await sleep(1200);
    await agent.start({
      instruction: "打开微信",
      deviceId: device.id,
      autonomy: "task_scoped",
      sensitivePolicy: "confirm_final"
    });

    const opened = await waitForActiveBundle(kuaijs, device, "com.tencent.xin", 90_000);
    await agent.stop();
    console.log(`[live-open-app] opened=${opened} diagnostics=${logged.length} logDir=${diagnostics.logDir}`);

    expect(opened).toBe(true);
    expect(logged.some((event) => event.category === "device_action" && event.action === "open_app" && event.status === "ok")).toBe(true);
  }, 120_000);
});

async function waitForActiveBundle(kuaijs: KuaijsClient, device: DeviceRecord, bundleId: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const active = await kuaijs.activeAppInfo(device).catch(() => undefined);
    if (activeAppBundleId(active) === bundleId) return true;
    await sleep(1000);
  }
  return false;
}

function activeAppBundleId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as { bundleId?: unknown; data?: { bundleId?: unknown } };
  const bundleId = object.bundleId ?? object.data?.bundleId;
  return typeof bundleId === "string" ? bundleId : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
