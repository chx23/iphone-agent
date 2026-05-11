import { describe, expect, it } from "vitest";
import { AssistantJobQueue } from "./assistantJobQueue";

describe("AssistantJobQueue", () => {
  it("runs one job at a time and tracks queue counts", () => {
    const queue = new AssistantJobQueue();
    const first = queue.enqueue({ instruction: "查一下今天 AI 新闻", sourceMessageSignature: "m1", type: "backend" });
    queue.enqueue({ instruction: "打开微信", sourceMessageSignature: "m2", type: "phone" });

    expect(queue.queuedCount()).toBe(2);
    expect(queue.nextPending()?.id).toBe(first.id);
    queue.update(first.id, { status: "running" });
    expect(queue.current()?.id).toBe(first.id);
    expect(queue.queuedCount()).toBe(1);
  });

  it("cancels the active job", () => {
    const queue = new AssistantJobQueue();
    const job = queue.enqueue({ instruction: "打开微信", sourceMessageSignature: "m1", type: "phone" });
    queue.update(job.id, { status: "running" });

    expect(queue.cancelRunning("用户取消")?.status).toBe("cancelled");
    expect(queue.hasActiveJob()).toBe(false);
  });
});
