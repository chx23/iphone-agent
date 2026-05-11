import type { AgentAction, DeviceRecord, DiagnosticEvent, RuntimeActionResult } from "../shared/types";
import { KuaiProjectRuntime } from "./kuaijsProjectRuntime";
import { safeError, sleep } from "./utils";

type DiagnosticSink = (event: Omit<DiagnosticEvent, "id" | "timestamp">) => void;

export class ControlRouter {
  constructor(
    private readonly projectRuntime?: KuaiProjectRuntime,
    private readonly diagnosticLog?: DiagnosticSink
  ) {}

  async runtimeSmokeTest(device: DeviceRecord): Promise<RuntimeActionResult> {
    if (!this.projectRuntime) {
      throw new Error("KuaiJS project runtime is not configured.");
    }
    return this.projectRuntime.smokeTest(device);
  }

  async execute(device: DeviceRecord, action: AgentAction): Promise<string> {
    const result = await this.executeDetailed(device, action);
    return `快点JS项目运行时：${result.message}`;
  }

  async executeDetailed(device: DeviceRecord, action: AgentAction): Promise<RuntimeActionResult> {
    if (action.type === "wait") {
      await sleep(action.ms);
      return {
        commandId: "wait",
        ok: true,
        backend: "kuaijs-project",
        message: action.reason ?? "wait completed"
      };
    }

    if (!canProjectRuntimeExecute(action)) {
      return {
        commandId: "agent-runtime",
        ok: true,
        backend: "kuaijs-project",
        message: "Action is handled by Agent Runtime."
      };
    }
    if (!this.projectRuntime) {
      throw new Error("KuaiJS project runtime is not configured.");
    }

    this.logDeviceAction(device, action, "running", "kuaijs-project");
    try {
      const result = await this.projectRuntime.execute(device, action);
      this.logDeviceAction(device, action, result.ok ? "ok" : "failed", "kuaijs-project", result);
      return result;
    } catch (error) {
      this.logDeviceAction(device, action, "failed", "kuaijs-project", undefined, error);
      throw error;
    }
  }

  private logDeviceAction(
    device: DeviceRecord,
    action: AgentAction,
    status: "running" | "ok" | "failed",
    backend: "kuaijs-project",
    result?: unknown,
    error?: unknown
  ): void {
    this.diagnosticLog?.({
      source: "kuaijs",
      category: "device_action",
      action: action.type,
      deviceId: device.id,
      status,
      message: `${backend} ${action.type}`,
      payload: {
        backend,
        action: summarizeAction(action),
        result
      },
      error: error ? safeError(error) : undefined
    });
  }
}

function canProjectRuntimeExecute(action: AgentAction): boolean {
  return ["tap_xy", "swipe", "input", "open_app", "open_url", "back", "home", "collect_scroll"].includes(action.type);
}

function summarizeAction(action: AgentAction): Record<string, unknown> {
  switch (action.type) {
    case "tap_xy":
      return { type: action.type, x: Math.round(action.x), y: Math.round(action.y), coordinateSpace: action.coordinateSpace };
    case "swipe":
      return {
        type: action.type,
        startX: Math.round(action.startX),
        startY: Math.round(action.startY),
        endX: Math.round(action.endX),
        endY: Math.round(action.endY),
        coordinateSpace: action.coordinateSpace,
        duration: action.duration
      };
    case "input":
    case "input_atomic":
      return { type: action.type, textChars: action.text.length };
    case "open_app":
      return { type: action.type, bundleId: action.bundleId, displayName: action.displayName };
    case "open_url":
      return { type: action.type, url: action.url };
    case "tap_text":
      return { type: action.type, text: action.text };
    case "tap_element":
      return { type: action.type, elementId: action.elementId };
    case "wait":
      return { type: action.type, ms: action.ms, reason: action.reason };
    case "collect_scroll":
      return { type: action.type, direction: action.direction, maxScrolls: action.maxScrolls };
    case "scroll_until_stable":
      return { type: action.type, direction: action.direction, maxScrolls: action.maxScrolls, stableThreshold: action.stableThreshold };
    case "read_wechat_article_native":
      return { type: action.type, account: action.account, direction: action.direction, maxScrolls: action.maxScrolls };
    case "ask_user":
      return { type: action.type, prompt: action.prompt };
    case "finish":
      return { type: action.type, summary: action.summary };
    case "back":
    case "home":
      return { type: action.type };
  }
}
