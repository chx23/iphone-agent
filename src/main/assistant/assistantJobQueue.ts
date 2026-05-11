import type { AssistantJob, AssistantJobStatus } from "../../shared/types";
import { createId, now, safeError, truncate } from "../utils";

export class AssistantJobQueue {
  private readonly jobs: AssistantJob[] = [];

  all(): AssistantJob[] {
    return this.jobs.map((job) => ({ ...job }));
  }

  enqueue(input: { instruction: string; sourceMessageSignature: string; type: AssistantJob["type"] }): AssistantJob {
    const job: AssistantJob = {
      id: createId("job"),
      instruction: truncate(input.instruction, 1000),
      sourceMessageSignature: input.sourceMessageSignature,
      status: "pending",
      type: input.type,
      createdAt: now(),
      updatedAt: now()
    };
    this.jobs.push(job);
    return { ...job };
  }

  current(): AssistantJob | undefined {
    const job = this.jobs.find((item) => item.status === "running" || item.status === "waiting_confirmation")
      ?? this.jobs.find((item) => item.status === "pending");
    return job ? { ...job } : undefined;
  }

  nextPending(): AssistantJob | undefined {
    const job = this.jobs.find((item) => item.status === "pending");
    return job ? { ...job } : undefined;
  }

  update(id: string, patch: Partial<Pick<AssistantJob, "status" | "resultMessage" | "error" | "confirmationPrompt">>): AssistantJob | undefined {
    const job = this.jobs.find((item) => item.id === id);
    if (!job) return undefined;
    Object.assign(job, patch, { updatedAt: now() });
    return { ...job };
  }

  cancelRunning(reason = "已取消"): AssistantJob | undefined {
    const job = this.jobs.find((item) => item.status === "running" || item.status === "pending" || item.status === "waiting_confirmation");
    if (!job) return undefined;
    job.status = "cancelled";
    job.error = reason;
    job.updatedAt = now();
    return { ...job };
  }

  hasActiveJob(): boolean {
    return this.jobs.some((job) => job.status === "pending" || job.status === "running" || job.status === "waiting_confirmation");
  }

  queuedCount(): number {
    return this.jobs.filter((job) => job.status === "pending").length;
  }
}

export function jobStatusFromError(error: unknown): Pick<AssistantJob, "status" | "error"> {
  return {
    status: "failed" satisfies AssistantJobStatus,
    error: safeError(error)
  };
}
