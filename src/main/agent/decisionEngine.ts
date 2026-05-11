import type {
  AgentAction,
  CandidateDecision,
  DecisionTrace,
  ModelRole,
  ParsedIntent,
  PerceptionFrame,
  PlannerActionIntent,
  TaskMemory,
  TaskPhase
} from "../../shared/types";
import type { PlannerContext, PlannerOutput } from "./planner";
import { fallbackPlan } from "./planner";

export interface ModelDecisionOutput {
  goal?: string;
  g?: string;
  phase?: TaskPhase;
  p?: TaskPhase;
  reasoningSummary?: string;
  why?: string;
  selectedRoute?: string;
  r?: string;
  nextActionIntent?: PlannerActionIntent;
  a?: CompactActionIntent;
  expectedScreenChange?: string;
  e?: string;
  confidence?: number;
  c?: number;
}

interface CompactActionIntent {
  k?: PlannerActionIntent["kind"];
  kind?: PlannerActionIntent["kind"];
  text?: string;
  t?: string;
  app?: "wechat" | "dianping";
  ms?: number;
  reason?: string;
  why?: string;
}

export interface DecisionInput {
  intent: ParsedIntent;
  frame: PerceptionFrame;
  context: PlannerContext;
  stepIndex: number;
  modelDecision?: ModelDecisionOutput;
  modelRole?: ModelRole;
}

export interface DecisionResult extends PlannerOutput {
  trace: DecisionTrace;
}

export class DecisionEngine {
  decide(input: DecisionInput): DecisionResult {
    const skillPlan = fallbackPlan(input.intent, input.frame.screen, input.stepIndex, input.context);
    const candidates: CandidateDecision[] = [
      toCandidate("skill.primary", skillPlan, "skill")
    ];

    const modelCandidate = this.resolveModelCandidate(input);
    if (modelCandidate) candidates.push(modelCandidate);

    const selected = selectCandidate(candidates, input.context);
    return {
      action: selected.action,
      description: selected.description,
      expectedResult: selected.expectedResult,
      confidence: selected.confidence,
      phase: selected.phase,
      route: selected.route,
      guardReason: selected.guardReason,
      progressKey: selected.progressKey,
      trace: {
        selectedId: selected.id,
        selectedSource: selected.source,
        reason: decisionReason(selected, input),
        candidates,
        modelRole: input.modelRole,
        modelUsed: Boolean(input.modelDecision)
      }
    };
  }

  private resolveModelCandidate(input: DecisionInput): CandidateDecision | undefined {
    const decision = normalizeModelDecisionOutput(input.modelDecision);
    const actionIntent = decision?.nextActionIntent;
    if (!actionIntent || decision.confidence === undefined || decision.confidence < 0.55) return undefined;
    const action = resolveActionIntent(actionIntent, input.frame);
    if (!action) return undefined;
    return {
      id: "llm.route",
      action,
      description: decision.reasoningSummary || "模型建议执行下一步。",
      expectedResult: decision.expectedScreenChange || "屏幕状态应发生可验证变化。",
      confidence: clamp(decision.confidence),
      phase: decision.phase,
      route: decision.selectedRoute,
      source: input.modelRole === "recovery" ? "recovery" : "llm",
      progressKey: `model:${actionIntent.kind}:${decision.selectedRoute ?? ""}`
    };
  }
}

export function createTaskMemory(): TaskMemory {
  return {
    attemptedRoutes: {},
    recentActions: [],
    recentFailures: [],
    confirmedPages: []
  };
}

export function rememberDecision(memory: TaskMemory, plan: PlannerOutput, actionKey: string, screenSignature: string): void {
  const route = plan.route ?? "unknown";
  memory.attemptedRoutes[route] = (memory.attemptedRoutes[route] ?? 0) + 1;
  memory.recentActions = [...memory.recentActions, actionKey].slice(-10);
  memory.lastActionKey = actionKey;
  memory.lastScreenSignature = screenSignature;
}

export function decisionSystemPrompt(): string {
  return [
    "JSON only. You rank one safe next step for a phone GUI agent.",
    "Think like a careful human: one small step, then verify. No raw coordinates.",
    "Never submit payment/transfer/delete/account-change/public-post/unknown-recipient send.",
    "Compact schema: {\"p\":\"phase\",\"r\":\"route\",\"why\":\"short reason\",\"a\":{\"k\":\"use_deterministic|tap_text|input_text|back|wait|open_app|ask_user\",\"text\":\"...\",\"app\":\"wechat|dianping\",\"ms\":800},\"e\":\"expected screen change\",\"c\":0.0}"
  ].join("\n");
}

export function decisionUserPrompt(input: {
  intent: ParsedIntent;
  frame: PerceptionFrame;
  context: PlannerContext;
  skillPlan: PlannerOutput;
}): string {
  return JSON.stringify({
    task: compactIntent(input.intent),
    phase: input.context.phase,
    route: input.context.route,
    stuck: input.context.noProgressCount ?? 0,
    screen: {
      page: input.frame.pageType,
      app: input.frame.app,
      conf: input.frame.confidence,
      keyboard: input.frame.hasKeyboard,
      quality: input.frame.sourceQuality,
      visual: input.frame.visualSummary,
      observe: input.frame.visualObservation,
      click: input.frame.clickableTexts.slice(0, 12),
      input: input.frame.inputTexts.slice(0, 8),
      dialog: input.frame.dialogTexts.slice(0, 6),
      risk: input.frame.riskTexts.slice(0, 8)
    },
    local: {
      action: input.skillPlan.action,
      desc: input.skillPlan.description,
      expect: input.skillPlan.expectedResult,
      conf: input.skillPlan.confidence,
      phase: input.skillPlan.phase,
      route: input.skillPlan.route
    },
    rule: "If local is safe/sensible, return a.k='use_deterministic'. If stuck/unknown, choose one recovery step."
  });
}

export function normalizeModelDecisionOutput(decision: ModelDecisionOutput | undefined): ModelDecisionOutput | undefined {
  if (!decision) return undefined;
  const action = decision.nextActionIntent ?? compactAction(decision.a);
  return {
    goal: decision.goal ?? decision.g,
    phase: decision.phase ?? decision.p,
    reasoningSummary: decision.reasoningSummary ?? decision.why,
    selectedRoute: decision.selectedRoute ?? decision.r,
    nextActionIntent: action,
    expectedScreenChange: decision.expectedScreenChange ?? decision.e,
    confidence: decision.confidence ?? decision.c
  };
}

function compactAction(action: CompactActionIntent | undefined): PlannerActionIntent | undefined {
  const kind = action?.kind ?? action?.k;
  if (!kind) return undefined;
  const text = action?.text ?? action?.t;
  const reason = action?.reason ?? action?.why;
  switch (kind) {
    case "use_deterministic":
    case "back":
    case "ask_user":
      return { kind, reason } as PlannerActionIntent;
    case "tap_text":
    case "input_text":
      return text ? { kind, text, reason } : undefined;
    case "wait":
      return { kind, ms: action?.ms, reason };
    case "open_app":
      return action?.app ? { kind, app: action.app, reason } : undefined;
  }
}

function compactIntent(intent: ParsedIntent): Record<string, unknown> {
  return {
    kind: intent.kind,
    app: intent.targetApp,
    source: intent.source,
    delivery: intent.delivery,
    contact: intent.contact,
    query: intent.query,
    output: intent.output,
    raw: intent.rawInstruction
  };
}

function toCandidate(id: string, plan: PlannerOutput, source: CandidateDecision["source"]): CandidateDecision {
  return {
    id,
    action: plan.action,
    description: plan.description,
    expectedResult: plan.expectedResult,
    confidence: plan.confidence,
    phase: plan.phase,
    route: plan.route,
    source,
    guardReason: plan.guardReason,
    progressKey: plan.progressKey
  };
}

function selectCandidate(candidates: CandidateDecision[], context: PlannerContext): CandidateDecision {
  const skill = candidates[0];
  const model = candidates.find((candidate) => candidate.source === "llm" || candidate.source === "recovery");
  if (!model) return skill;
  if (model.action.type === "ask_user") return model;
  if ((context.noProgressCount ?? 0) >= 2 && model.confidence >= 0.58) return model;
  if (skill.confidence < 0.5 && model.confidence >= skill.confidence + 0.12) return model;
  if (skill.action.type === "ask_user" && model.confidence >= 0.62) return model;
  return skill;
}

function decisionReason(selected: CandidateDecision, input: DecisionInput): string {
  if (selected.source === "skill") return "本地技能路径清晰，按规则安全底座执行。";
  if (input.modelRole === "recovery") return "连续无进展，采用模型恢复建议。";
  return "当前任务需要模型辅助路线选择。";
}

function resolveActionIntent(intent: PlannerActionIntent, frame: PerceptionFrame): AgentAction | undefined {
  switch (intent.kind) {
    case "use_deterministic":
      return undefined;
    case "tap_text":
      return intent.text ? { type: "tap_text", text: intent.text } : undefined;
    case "input_text":
      return intent.text ? { type: "input", text: intent.text } : undefined;
    case "back":
      return { type: "back" };
    case "wait":
      return { type: "wait", ms: clampMs(intent.ms), reason: intent.reason ?? "等待页面加载" };
    case "open_app":
      if (intent.app === "wechat") return { type: "open_app", bundleId: "com.tencent.xin", displayName: "微信" };
      if (intent.app === "dianping") return { type: "open_app", bundleId: "com.dianping.dpscope", displayName: "大众点评" };
      return undefined;
    case "ask_user":
      return { type: "ask_user", prompt: intent.reason ?? `当前页面为 ${frame.pageType}，需要用户确认下一步。` };
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5));
}

function clampMs(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return 900;
  return Math.max(300, Math.min(5000, Math.round(value)));
}
