import type {
  AgentAction,
  AppSettings,
  Bounds,
  DeviceRecord,
  DiagnosticEvent,
  RuntimeActionResult,
  ScreenGraph,
  TaskPhase,
  VisionScreenResult
} from "../../../shared/types";

export type VirtualModelMode = "mock" | "live";

export interface VirtualScreenNode {
  id?: string;
  label: string;
  role?: string;
  bounds?: Bounds;
  clickable?: boolean;
  confidence?: number;
}

export interface VirtualActionMatch {
  type: AgentAction["type"];
  bundleId?: string;
  label?: string;
  textIncludes?: string;
  direction?: "up" | "down";
}

export interface VirtualActionExpectation {
  match: VirtualActionMatch;
  nextFrame?: string;
  message?: string;
}

export interface VirtualScreenFrame {
  id: string;
  app?: string;
  image: string;
  keyboardVisible?: boolean;
  nodes: VirtualScreenNode[];
  dialogs?: VirtualScreenNode[];
  vision?: VisionScreenResult;
  transitions?: VirtualActionExpectation[];
}

export interface VirtualScenario {
  id: string;
  title: string;
  instruction: string;
  tags?: string[];
  modelStress?: "timeout" | "bad_json" | "slow" | "normal";
  initialFrame: string;
  expectedTerminalState?: "finished" | "waiting_confirmation" | "stuck";
  expectedPhases?: TaskPhase[];
  trustedContacts?: string[];
  trustedGroups?: string[];
  frames: Record<string, VirtualScreenFrame>;
}

export interface VirtualRunResult {
  state: string;
  phases: TaskPhase[];
  actions: AgentAction[];
  diagnostics: Array<Omit<DiagnosticEvent, "id" | "timestamp">>;
  finalFrameId: string;
  timelineTitles: string[];
}

export interface VirtualHarnessSettings {
  settings?: Partial<AppSettings>;
  device?: Partial<DeviceRecord>;
  modelMode?: VirtualModelMode;
  autoConfirm?: boolean;
  timeoutMs?: number;
}

export interface VirtualControlResult extends RuntimeActionResult {
  matchedLabel?: string;
}

export interface VirtualFrameObservation {
  frame: VirtualScreenFrame;
  screen: ScreenGraph;
  imageBase64: string;
}

export interface VirtualLiveModelCase {
  scenarioId: string;
  frameId: string;
  imageBase64: string;
  expectedPageType: string;
}
