import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AssistantJob } from "../../shared/types";

const MAX_SIGNATURES = 240;
const MAX_JOB_SUMMARIES = 40;

export interface PersistedAssistantState {
  monitorContact?: string;
  processedMessageSignatures: string[];
  outgoingMessageSignatures: string[];
  jobs: Array<Pick<AssistantJob, "id" | "instruction" | "status" | "type" | "createdAt" | "updatedAt">>;
  updatedAt: number;
}

export class AssistantStateStore {
  readonly path: string;

  constructor(rootDir: string) {
    this.path = join(rootDir, "assistant-state.json");
  }

  async load(): Promise<PersistedAssistantState> {
    try {
      const text = await readFile(this.path, "utf8");
      const parsed = JSON.parse(text) as Partial<PersistedAssistantState>;
      return normalizeState(parsed);
    } catch {
      return emptyState();
    }
  }

  async save(state: PersistedAssistantState): Promise<void> {
    const normalized = normalizeState(state);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(normalized, null, 2), "utf8");
  }
}

export function rememberProcessed(state: PersistedAssistantState, signature: string): PersistedAssistantState {
  return {
    ...state,
    processedMessageSignatures: pushUnique(state.processedMessageSignatures, signature),
    updatedAt: Date.now()
  };
}

export function rememberOutgoing(state: PersistedAssistantState, signature: string): PersistedAssistantState {
  return {
    ...state,
    outgoingMessageSignatures: pushUnique(state.outgoingMessageSignatures, signature),
    updatedAt: Date.now()
  };
}

export function rememberJob(state: PersistedAssistantState, job: AssistantJob): PersistedAssistantState {
  const summary = {
    id: job.id,
    instruction: job.instruction.slice(0, 200),
    status: job.status,
    type: job.type,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
  const jobs = [summary, ...state.jobs.filter((item) => item.id !== job.id)].slice(0, MAX_JOB_SUMMARIES);
  return { ...state, jobs, updatedAt: Date.now() };
}

function emptyState(): PersistedAssistantState {
  return {
    processedMessageSignatures: [],
    outgoingMessageSignatures: [],
    jobs: [],
    updatedAt: Date.now()
  };
}

function normalizeState(value: Partial<PersistedAssistantState>): PersistedAssistantState {
  return {
    monitorContact: typeof value.monitorContact === "string" ? value.monitorContact : undefined,
    processedMessageSignatures: Array.isArray(value.processedMessageSignatures) ? value.processedMessageSignatures.slice(-MAX_SIGNATURES) : [],
    outgoingMessageSignatures: Array.isArray(value.outgoingMessageSignatures) ? value.outgoingMessageSignatures.slice(-MAX_SIGNATURES) : [],
    jobs: Array.isArray(value.jobs) ? value.jobs.slice(0, MAX_JOB_SUMMARIES) : [],
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now()
  };
}

function pushUnique(values: string[], value: string): string[] {
  return [...values.filter((item) => item !== value), value].slice(-MAX_SIGNATURES);
}
