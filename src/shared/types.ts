export type ExperienceState =
  | "idle"
  | "observing"
  | "planning"
  | "acting"
  | "verifying"
  | "waiting_confirmation"
  | "stuck"
  | "user_takeover"
  | "finished";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type RiskDecision = "allow" | "confirm" | "block";

export type TaskKind = "wechat_article_summary" | "wechat_multi_article_digest" | "wechat_message" | "dianping_food_search" | "generic";

export type TaskPhase =
  | "open_app"
  | "locate_source"
  | "collect_article_list"
  | "select_next_article"
  | "open_article"
  | "read_article"
  | "compose_result"
  | "deliver_message"
  | "verify_done";

export interface IntentSource {
  app: "wechat";
  kind: "official_account";
  name: string;
}

export interface IntentDelivery {
  app: "wechat";
  kind: "contact" | "group";
  name: string;
}

export interface BuildInfo {
  version: string;
  buildTime: string;
}

export type ProjectRuntimeState = "not_started" | "scaffolding" | "installing" | "ready" | "failed";

export type RuntimeMode = "bridge-http" | "lan-http" | "ws-server";

export interface DeviceRecord {
  id: string;
  name: string;
  host: string;
  port: number;
  lastSeenAt?: number;
  source: "manual" | "discovered" | "bridge";
  connectionMode?: "lan" | "bridge";
  deviceName?: string;
  serverDeviceId?: string;
  preferredRunTransport?: "http" | "ws";
  wsPort?: number;
  runtimeTargetHost?: string;
  runtimeTargetPort?: number;
  runtimeTransport?: "http" | "ws";
  lastRuntimeMode?: RuntimeMode;
}

export interface AppSettings {
  selectedDeviceId?: string;
  aiApiUrl: string;
  aiModel: string;
  hasAiApiKey: boolean;
  visionApiUrl: string;
  visionModel: string;
  hasVisionApiKey: boolean;
  whitelist: WhitelistEntry[];
  advancedAutoMode: boolean;
}

export interface WhitelistEntry {
  id: string;
  label: string;
  kind: "contact" | "group";
  autoSend: boolean;
}

export interface HealthCheck {
  deviceOnline: boolean;
  kuaijsReachable: boolean;
  mirrorReachable: boolean;
  screenshotOk: boolean;
  sourceOk: boolean;
  imeOk: boolean;
  observationOk: boolean;
  controlAuthorized: boolean;
  nodeReady: boolean;
  npmReady: boolean;
  msCliReady: boolean;
  projectRuntimeReady: boolean;
  projectRuntimeState: ProjectRuntimeState;
  controlBackend: "kuaijs-project" | "none";
  llmConfigured: boolean;
  visionConfigured?: boolean;
  buildInfo?: BuildInfo;
  executablePath?: string;
  connectionMode?: "lan" | "bridge";
  agentConnected?: boolean;
  isLogin?: boolean;
  isAuth?: boolean;
  deviceName?: string;
  serverDeviceId?: string;
  imeMessage?: string;
  controlMessage?: string;
  projectRuntimeDir?: string;
  projectRuntimeMessage?: string;
  projectRuntimeLastError?: string;
  runtimeSmokeOk?: boolean;
  suggestedBridge?: DeviceRecord;
  message: string;
  checkedAt: number;
}

export interface RuntimeActionResult {
  commandId: string;
  ok: boolean;
  backend: "kuaijs-project";
  message: string;
  runtimeMode?: RuntimeMode;
  rawLog?: string;
  observedAfter?: string;
  data?: unknown;
  timing?: Record<string, number>;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NormalizedBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementRef {
  id: string;
  source: "node" | "ocr" | "visual" | "synthetic";
  label: string;
  role?: string;
  bounds?: Bounds;
  normalizedBounds?: NormalizedBounds;
  confidence: number;
  clickable?: boolean;
}

export interface VisionScreenResult {
  summary?: string;
  pageType?: string;
  mainRegions?: string[];
  inputHints?: string[];
  riskHints?: string[];
  recommendedObservation?: string;
  ocrBlocks: ElementRef[];
}

export interface ScreenGraph {
  app?: string;
  screenSize?: { width: number; height: number };
  orientation?: "portrait" | "landscape" | "unknown";
  nodes: ElementRef[];
  ocrBlocks: ElementRef[];
  dialogs: ElementRef[];
  keyboardVisible: boolean;
  rawSource?: string;
  screenshotBase64?: string;
  observedAt: number;
}

export type AgentAction =
  | { type: "tap_element"; elementId: string }
  | { type: "tap_text"; text: string }
  | { type: "tap_xy"; x: number; y: number; coordinateSpace: "screen" | "normalized" }
  | { type: "swipe"; startX: number; startY: number; endX: number; endY: number; coordinateSpace: "screen" | "normalized"; duration?: number }
  | { type: "input"; text: string }
  | { type: "open_app"; bundleId: string; displayName?: string }
  | { type: "open_url"; url: string }
  | { type: "back" }
  | { type: "home" }
  | { type: "wait"; ms: number; reason?: string }
  | { type: "collect_scroll"; direction: "up" | "down"; maxScrolls: number }
  | { type: "ask_user"; prompt: string }
  | { type: "finish"; summary: string };

export interface ActionPreview {
  id: string;
  action: AgentAction;
  description: string;
  expectedResult: string;
  riskLevel: RiskLevel;
  targetBounds?: Bounds;
  confidence: number;
}

export interface TimelineEvent {
  id: string;
  state: ExperienceState;
  title: string;
  detail: string;
  timestamp: number;
  riskLevel?: RiskLevel;
  screenshotBase64?: string;
  preview?: ActionPreview;
  status: "pending" | "running" | "done" | "failed" | "blocked";
}

export interface TaskRequest {
  instruction: string;
  deviceId: string;
  autonomy: "task_scoped";
  sensitivePolicy: "confirm_final";
}

export interface ParsedIntent {
  kind: TaskKind;
  targetApp?: "wechat" | "dianping" | "unknown";
  source?: IntentSource;
  delivery?: IntentDelivery;
  contact?: string;
  topic?: string;
  location?: string;
  query?: string;
  output?: "summary" | "recommendation" | "message";
  freshSendRequired?: boolean;
  multiArticle?: boolean;
  articleWindowHours?: number;
  rawInstruction: string;
}

export interface AgentSnapshot {
  taskId?: string;
  state: ExperienceState;
  phase?: TaskPhase;
  route?: string;
  noProgressCount?: number;
  lastScreenSignature?: string;
  instruction?: string;
  timeline: TimelineEvent[];
  pendingConfirmation?: ConfirmationRequest;
  lastScreen?: ScreenGraph;
  lastPreview?: ActionPreview;
}

export type ModelRole =
  | "intent_parse"
  | "route_rank"
  | "recovery"
  | "summarize"
  | "vision_perception";

export interface PerceptionFrame {
  screen: ScreenGraph;
  pageType: string;
  app?: string;
  confidence: number;
  visibleTexts: string[];
  clickableTexts: string[];
  inputTexts: string[];
  dialogTexts: string[];
  riskTexts: string[];
  hasKeyboard: boolean;
  sourceQuality: "rich" | "sparse" | "empty";
  visualSummary?: string;
  visualObservation?: string;
}

export interface CandidateDecision {
  id: string;
  action: AgentAction;
  description: string;
  expectedResult: string;
  confidence: number;
  phase?: TaskPhase;
  route?: string;
  source: "skill" | "llm" | "recovery";
  rejectedReason?: string;
  guardReason?: string;
  progressKey?: string;
}

export interface DecisionTrace {
  selectedId: string;
  selectedSource: CandidateDecision["source"];
  reason: string;
  candidates: CandidateDecision[];
  modelRole?: ModelRole;
  modelUsed: boolean;
}

export interface ModelUsePolicy {
  useVision: boolean;
  useLlm: boolean;
  modelRole?: ModelRole;
  reason: string;
}

export interface VerificationResult {
  ok: boolean;
  expected: string;
  actual: string;
  changed: boolean;
  confidence: number;
}

export type PlannerActionIntent =
  | { kind: "use_deterministic"; reason?: string }
  | { kind: "tap_text"; text: string; reason?: string }
  | { kind: "input_text"; text: string; reason?: string }
  | { kind: "back"; reason?: string }
  | { kind: "wait"; ms?: number; reason?: string }
  | { kind: "open_app"; app: "wechat" | "dianping"; reason?: string }
  | { kind: "ask_user"; reason?: string };

export interface TaskMemory {
  attemptedRoutes: Record<string, number>;
  recentActions: string[];
  recentFailures: string[];
  confirmedPages: string[];
  lastScreenSignature?: string;
  lastActionKey?: string;
}

export interface ConfirmationRequest {
  id: string;
  title: string;
  message: string;
  editableText?: string;
  recipient?: string;
  action: AgentAction;
  createdAt: number;
}

export interface LlmModelInfo {
  id: string;
  ownedBy?: string;
}

export type DiagnosticCategory =
  | "agent_timeline"
  | "device_action"
  | "runtime"
  | "llm"
  | "vision"
  | "chat_monitor"
  | "assistant_job"
  | "backend_tool"
  | "error";

export interface DiagnosticEvent {
  id: string;
  timestamp: number;
  source: "agent" | "kuaijs" | "runtime" | "llm" | "vision" | "assistant" | "backend";
  category: DiagnosticCategory;
  action: string;
  modelRole?: ModelRole;
  decisionTrace?: DecisionTrace;
  verification?: VerificationResult;
  taskId?: string;
  deviceId?: string;
  status?: "pending" | "running" | "ok" | "failed" | "blocked";
  message?: string;
  payload?: unknown;
  error?: string;
}

export interface DiagnosticQuery {
  limit?: number;
  taskId?: string;
  category?: DiagnosticCategory;
}

export interface ChatMessage {
  id: string;
  signature: string;
  contact: string;
  direction: "incoming" | "outgoing";
  text: string;
  timestampLabel?: string;
  bounds?: Bounds;
  observedAt: number;
}

export type ChatCommandKind =
  | "chat"
  | "task"
  | "status"
  | "cancel"
  | "pause"
  | "resume"
  | "confirm"
  | "clarify";

export interface ChatCommand {
  kind: ChatCommandKind;
  confidence: number;
  instruction?: string;
  reply?: string;
  needsConfirmation?: boolean;
  approved?: boolean;
  reason?: string;
}

export type AssistantJobStatus =
  | "pending"
  | "running"
  | "waiting_confirmation"
  | "finished"
  | "failed"
  | "cancelled";

export interface AssistantJob {
  id: string;
  instruction: string;
  sourceMessageSignature: string;
  status: AssistantJobStatus;
  type: "phone" | "backend";
  createdAt: number;
  updatedAt: number;
  resultMessage?: string;
  error?: string;
  confirmationPrompt?: string;
}

export interface AssistantMonitorState {
  monitorContact: string;
  status: "idle" | "observing" | "processing" | "waiting_confirmation" | "stopped";
  lastObservedAt?: number;
  lastMessageSignature?: string;
  processedCount: number;
  queuedJobs: number;
  currentJob?: AssistantJob;
  lastReply?: string;
}

export interface BackendResearchResult {
  query: string;
  summary: string;
  sources: Array<{
    title: string;
    url: string;
    snippet?: string;
  }>;
  fetchedAt: number;
}
