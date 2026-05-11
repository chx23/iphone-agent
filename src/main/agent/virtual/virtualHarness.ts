import type { AgentAction, AgentSnapshot, AppSettings, DeviceRecord, DiagnosticEvent, HealthCheck } from "../../../shared/types";
import type { LocalOcrProvider } from "../../localOcr";
import { AgentRuntime } from "../runtime";
import type { ModelDecisionOutput } from "../decisionEngine";
import { loadVirtualImageBase64, virtualFrameToScreenGraph, virtualFrameToSource } from "./scenarioLoader";
import type {
  VirtualActionExpectation,
  VirtualControlResult,
  VirtualHarnessSettings,
  VirtualRunResult,
  VirtualScenario,
  VirtualScreenFrame
} from "./types";

const VIRTUAL_DEVICE: DeviceRecord = {
  id: "virtual-phone",
  name: "Virtual iPhone",
  host: "127.0.0.1",
  port: 9800,
  source: "bridge",
  connectionMode: "bridge",
  preferredRunTransport: "http",
  runtimeTargetHost: "127.0.0.1",
  runtimeTargetPort: 9800,
  runtimeTransport: "http"
};

export class VirtualKuaijsClient {
  constructor(private readonly session: VirtualScenarioSession) {}

  async healthCheck(): Promise<HealthCheck> {
    return {
      deviceOnline: true,
      kuaijsReachable: true,
      mirrorReachable: true,
      screenshotOk: true,
      sourceOk: true,
      imeOk: true,
      observationOk: true,
      controlAuthorized: true,
      nodeReady: true,
      npmReady: true,
      msCliReady: true,
      projectRuntimeReady: true,
      projectRuntimeState: "ready",
      controlBackend: "kuaijs-project",
      llmConfigured: true,
      visionConfigured: true,
      agentConnected: true,
      isLogin: true,
      isAuth: true,
      message: "Virtual KuaiJS device is ready.",
      checkedAt: Date.now()
    };
  }

  async screenshotBase64(): Promise<string> {
    return this.session.currentImageBase64();
  }

  async source(): Promise<string> {
    return virtualFrameToSource(this.session.currentFrame());
  }

  async activeAppInfo(): Promise<unknown> {
    return { bundleId: this.session.currentFrame().app };
  }
}

export class VirtualControlRouter {
  readonly actions: AgentAction[] = [];

  constructor(private readonly session: VirtualScenarioSession) {}

  async execute(_device: DeviceRecord, action: AgentAction): Promise<string> {
    const result = await this.executeDetailed(_device, action);
    return result.message;
  }

  async executeDetailed(_device: DeviceRecord, action: AgentAction): Promise<VirtualControlResult> {
    this.actions.push(action);
    const frame = this.session.currentFrame();
    const matched = findMatchingTransition(frame, action) ?? this.session.fallbackTransition(action);
    if (!matched) {
      throw new Error(`Virtual action did not match frame=${frame.id}: ${describeAction(action)}`);
    }
    if (matched.nextFrame) this.session.goto(matched.nextFrame);
    return {
      commandId: `virtual_${this.actions.length}`,
      ok: true,
      backend: "kuaijs-project",
      message: matched.message ?? `virtual ${action.type} accepted`,
      matchedLabel: matched.match.label,
      observedAfter: matched.nextFrame
    };
  }
}

export class VirtualScenarioSession {
  private frameId: string;
  private readonly history: string[] = [];

  constructor(readonly scenario: VirtualScenario) {
    this.frameId = scenario.initialFrame;
  }

  currentFrame(): VirtualScreenFrame {
    const frame = this.scenario.frames[this.frameId];
    if (!frame) throw new Error(`Virtual frame not found: ${this.frameId}`);
    return frame;
  }

  currentFrameId(): string {
    return this.frameId;
  }

  currentImageBase64(): string {
    return loadVirtualImageBase64(this.currentFrame());
  }

  goto(frameId: string): void {
    if (!this.scenario.frames[frameId]) throw new Error(`Virtual transition points to missing frame: ${frameId}`);
    this.history.push(this.frameId);
    this.frameId = frameId;
  }

  fallbackTransition(action: AgentAction): VirtualActionExpectation | undefined {
    if (action.type !== "collect_scroll") return undefined;
    const current = this.currentFrame();
    if (!isVirtualArticleFrame(current)) return undefined;
    if (action.direction === "down") {
      return {
        match: { type: "collect_scroll", direction: "down" },
        nextFrame: current.id,
        message: "virtual forward-scroll reached stable article bottom"
      };
    }
    if (action.direction !== "up") return undefined;
    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const candidateId = this.history[index];
      const candidate = this.scenario.frames[candidateId];
      if (candidate && isVirtualArticleFrame(candidate)) {
        this.history.splice(index, 1);
        return {
          match: { type: "collect_scroll", direction: "up" },
          nextFrame: candidateId,
          message: `virtual reverse-scroll to ${candidateId}`
        };
      }
    }
    return {
      match: { type: "collect_scroll", direction: "up" },
      nextFrame: current.id,
      message: "virtual reverse-scroll reached stable article top"
    };
  }
}

function isVirtualArticleFrame(frame: VirtualScreenFrame): boolean {
  return frame.vision?.pageType === "wechat_article" || /article/i.test(frame.id);
}

export class VirtualModelHarness {
  constructor(private readonly session: VirtualScenarioSession) {}

  readonly llm = {
    completeJson: async <T,>(system: string): Promise<T | undefined> => {
      await applyModelStress(this.session.scenario.modelStress, "llm");
      if (system.includes("公众号文章总结器")) {
        return {
          title: "具身智能来时路",
          summary: "文章梳理了具身智能从语言理解走向真实动作控制的路线，强调数据、评测和工程稳定性仍是落地关键。"
        } as T;
      }
      const decision: ModelDecisionOutput = {
        phase: "locate_source",
        selectedRoute: "virtual:recover_back",
        reasoningSummary: "当前页面连续没有进展，先返回稳定入口再重新观察。",
        nextActionIntent: { kind: "back" },
        expectedScreenChange: "退出当前搜索或异常页面。",
        confidence: 0.72
      };
      return decision as T;
    }
  };

  readonly vision = {
    describeScreen: async () => {
      await applyModelStress(this.session.scenario.modelStress, "vision");
      return this.session.currentFrame().vision;
    }
  };
}

class VirtualLocalOcrProvider implements LocalOcrProvider {
  constructor(private readonly session: VirtualScenarioSession) {}

  async isAvailable(): Promise<{ ok: boolean; provider: string; language?: string; message?: string }> {
    return { ok: true, provider: "virtual-local-ocr", language: "zh-Hans-CN", message: "Virtual local OCR is available." };
  }

  async recognizeImages(paths: string[]) {
    const lines = Object.values(this.session.scenario.frames)
      .filter((frame) => isVirtualArticleFrame(frame))
      .flatMap((frame) => frame.nodes)
      .map((node) => node.label.trim())
      .filter((label) => label.length >= 8)
      .filter((label, index, array) => array.indexOf(label) === index)
      .map((text) => ({ text }));
    return {
      ok: true,
      provider: "virtual-local-ocr",
      language: "zh-Hans-CN",
      images: paths.map((path) => ({
        path,
        lines,
        text: lines.map((line) => line.text).join("\n")
      })),
      message: "Virtual local OCR completed."
    };
  }
}

async function applyModelStress(stress: VirtualScenario["modelStress"], source: "llm" | "vision"): Promise<void> {
  if (stress === "slow") await new Promise((resolve) => setTimeout(resolve, 80));
  if (stress === "timeout") throw new Error(`${source} virtual timeout`);
  if (stress === "bad_json" && source === "llm") throw new Error("llm virtual invalid JSON");
}

export async function runVirtualScenario(
  scenario: VirtualScenario,
  options: VirtualHarnessSettings = {}
): Promise<VirtualRunResult> {
  const session = new VirtualScenarioSession(scenario);
  const kuaijs = new VirtualKuaijsClient(session);
  const control = new VirtualControlRouter(session);
  const models = new VirtualModelHarness(session);
  const localOcr = new VirtualLocalOcrProvider(session);
  const diagnostics: Array<Omit<DiagnosticEvent, "id" | "timestamp">> = [];
  const settings = virtualSettings(scenario, options.settings);
  const device = { ...VIRTUAL_DEVICE, ...options.device };
  const agent = new AgentRuntime({
    getSettings: () => settings,
    getDevice: () => device,
    kuaijs,
    control,
    llm: models.llm,
    vision: models.vision,
    localOcr,
    diagnostics: (event: Omit<DiagnosticEvent, "id" | "timestamp">) => diagnostics.push(event)
  } as never);

  await agent.start({
    instruction: scenario.instruction,
    deviceId: device.id,
    autonomy: "task_scoped",
    sensitivePolicy: "confirm_final"
  });

  const finalSnapshot = await waitForTerminalSnapshot(agent, options.timeoutMs ?? 45_000, Boolean(options.autoConfirm));
  return {
    state: finalSnapshot.state,
    phases: diagnosticPhases(diagnostics),
    actions: control.actions,
    diagnostics,
    finalFrameId: session.currentFrameId(),
    timelineTitles: finalSnapshot.timeline.map((event) => event.title)
  };
}

export function virtualScreenFor(scenario: VirtualScenario, frameId: string) {
  const frame = scenario.frames[frameId];
  if (!frame) throw new Error(`Virtual frame not found: ${frameId}`);
  return virtualFrameToScreenGraph(frame);
}

function findMatchingTransition(frame: VirtualScreenFrame, action: AgentAction): VirtualActionExpectation | undefined {
  return frame.transitions?.find((transition) => matchesAction(frame, transition, action));
}

function matchesAction(frame: VirtualScreenFrame, expectation: VirtualActionExpectation, action: AgentAction): boolean {
  if (expectation.match.type !== action.type) return false;
  if (action.type === "open_app") {
    return !expectation.match.bundleId || action.bundleId === expectation.match.bundleId;
  }
  if (action.type === "input" || action.type === "input_atomic") {
    return !expectation.match.textIncludes || action.text.includes(expectation.match.textIncludes);
  }
  if (action.type === "collect_scroll" || action.type === "scroll_until_stable") {
    return !expectation.match.direction || action.direction === expectation.match.direction;
  }
  if (action.type === "tap_xy") {
    if (!expectation.match.label) return true;
    return Boolean(labelAtPoint(frame, action.x, action.y)?.includes(expectation.match.label));
  }
  if (action.type === "tap_text") {
    return !expectation.match.label || action.text.includes(expectation.match.label);
  }
  return true;
}

function labelAtPoint(frame: VirtualScreenFrame, x: number, y: number): string | undefined {
  return frame.nodes
    .filter((node) => {
      const bounds = node.bounds;
      if (!bounds) return false;
      return x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;
    })
    .sort((a, b) => {
      const areaA = (a.bounds?.width ?? 0) * (a.bounds?.height ?? 0);
      const areaB = (b.bounds?.width ?? 0) * (b.bounds?.height ?? 0);
      return areaA - areaB;
    })[0]?.label;
}

function virtualSettings(scenario: VirtualScenario, overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    selectedDeviceId: VIRTUAL_DEVICE.id,
    aiApiUrl: "virtual://llm",
    aiModel: "virtual-llm",
    hasAiApiKey: true,
    visionApiUrl: "virtual://vision",
    visionModel: "virtual-vlm",
    hasVisionApiKey: true,
    parateraBaseUrl: "virtual://llm",
    parateraModel: "virtual-llm",
    hasApiKey: true,
    whitelist: [
      ...(scenario.trustedContacts ?? []).map((label) => ({ id: `trusted_contact_${label}`, label, kind: "contact" as const, autoSend: true })),
      ...(scenario.trustedGroups ?? []).map((label) => ({ id: `trusted_group_${label}`, label, kind: "group" as const, autoSend: true }))
    ],
    advancedAutoMode: true,
    ...overrides
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
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await agent.stop();
  return agent.getSnapshot();
}

function diagnosticPhases(diagnostics: Array<Omit<DiagnosticEvent, "id" | "timestamp">>) {
  const phases = diagnostics
    .map((event) => (event.payload && typeof event.payload === "object" && "phase" in event.payload)
      ? (event.payload as { phase?: AgentSnapshot["phase"] }).phase
      : undefined)
    .filter(Boolean);
  return [...new Set(phases)] as NonNullable<AgentSnapshot["phase"]>[];
}

function describeAction(action: AgentAction): string {
  return JSON.stringify(action);
}
