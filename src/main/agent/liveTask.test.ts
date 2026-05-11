import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppSettings, DeviceRecord, DiagnosticEvent, AgentSnapshot } from "../../shared/types";
import { ControlRouter } from "../controlRouter";
import { DiagnosticsLogger } from "../diagnosticsLogger";
import { KuaijsClient } from "../kuaijsClient";
import { KuaiProjectRuntime } from "../kuaijsProjectRuntime";
import { LlmClient } from "../llmClient";
import { AgentRuntime } from "./runtime";

const runLive = process.env.LIVE_PHONE_AGENT === "1";
const liveIt = runLive ? it : it.skip;

describe("live phone agent task", () => {
  liveIt("reads the latest 机器之心 article and sends the summary to 陈弘轩", async () => {
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
    const control = new ControlRouter(projectRuntime, diagnosticSink);
    const kuaijs = new KuaijsClient(
      () => devices,
      projectRuntime,
      {
        buildInfo: { version: "live-test", buildTime: new Date().toISOString() },
        executablePath: process.execPath
      }
    );
    const useSummaryLlm = process.env.LIVE_PHONE_AGENT_USE_LLM === "1" && Boolean(process.env.AI_API_KEY);
    const settings: AppSettings = {
      selectedDeviceId: device.id,
      aiApiUrl: process.env.AI_API_URL ?? "",
      aiModel: process.env.LANGUAGE_MODEL ?? "disabled-live-fallback",
      hasAiApiKey: useSummaryLlm,
      visionApiUrl: "",
      visionModel: "disabled-live-fallback",
      hasVisionApiKey: false,
      parateraBaseUrl: "",
      parateraModel: "disabled-live-fallback",
      hasApiKey: false,
      whitelist: [{ id: "contact_chen_hongxuan", label: "陈弘轩", kind: "contact", autoSend: true }],
      advancedAutoMode: true
    };
    const summaryLlm = useSummaryLlm
      ? new LlmClient(
          () => settings.aiApiUrl,
          () => process.env.AI_API_KEY,
          () => settings.aiModel,
          diagnosticSink
        )
      : undefined;
    const llm = {
      completeJson: async <T,>(system: string, user: string) => {
        if (summaryLlm && system.includes("公众号文章总结器")) {
          return summaryLlm.completeJson<T>(system, user);
        }
        throw new Error("LLM disabled for deterministic live fallback test.");
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

    await clearStaleWechatDraft(kuaijs, control, device);

    let printedTimeline = 0;
    agent.on("changed", (snapshot) => {
      for (const event of snapshot.timeline.slice(printedTimeline)) {
        console.log(`[${snapshot.state}] ${event.title} - ${event.detail}`);
      }
      printedTimeline = snapshot.timeline.length;
      if (snapshot.pendingConfirmation) {
        console.log(`[confirm] ${snapshot.pendingConfirmation.title} - ${snapshot.pendingConfirmation.message}`);
      }
    });

    const initial = await agent.start({
      instruction: "打开“机械之心”公众号，阅读最新的一篇文章，然后将总结发给陈弘轩",
      deviceId: device.id,
      autonomy: "task_scoped",
      sensitivePolicy: "confirm_final"
    });
    console.log(`[task] started ${initial.taskId}`);

    const finalSnapshot = await waitForTerminalSnapshot(agent, 900_000);
    console.log(`[task] final state=${finalSnapshot.state} timeline=${finalSnapshot.timeline.length}`);
    console.log(`[task] diagnostics events=${logged.length} logDir=${diagnostics.logDir}`);
    if (finalSnapshot.pendingConfirmation) {
      console.log(`[task] pending=${finalSnapshot.pendingConfirmation.title}: ${finalSnapshot.pendingConfirmation.message}`);
    }

    expect(finalSnapshot.state).toBe("finished");
  }, 920_000);
});

async function waitForTerminalSnapshot(agent: AgentRuntime, timeoutMs: number): Promise<AgentSnapshot> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const snapshot = agent.getSnapshot();
    if (snapshot.state === "finished" || snapshot.state === "stuck" || snapshot.state === "waiting_confirmation") {
      return snapshot;
    }
    await sleep(1000);
  }
  await agent.stop();
  return agent.getSnapshot();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clearStaleWechatDraft(kuaijs: KuaijsClient, control: ControlRouter, device: DeviceRecord): Promise<void> {
  const source = await kuaijs.source(device).catch(() => "");
  if (!/<XCUIElementTypeTextView\b[^>]*\bvalue="[^"]{2,}"/.test(source)) return;
  console.log("[task] clearing stale WeChat draft before live task");
  await control.execute(device, { type: "input", text: "" }).catch((error) => {
    console.log(`[task] stale draft clear reported: ${error instanceof Error ? error.message : String(error)}`);
  });
  await sleep(1200);
}
