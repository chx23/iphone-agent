import { describe, expect, it } from "vitest";
import { classifyByHeuristic } from "./chatCommandClassifier";

describe("chat command heuristic classifier", () => {
  it("recognizes status and cancellation control messages", () => {
    expect(classifyByHeuristic("状态", { hasRunningJob: false, hasPendingConfirmation: false }).kind).toBe("status");
    expect(classifyByHeuristic("取消", { hasRunningJob: true, hasPendingConfirmation: false }).kind).toBe("cancel");
  });

  it("recognizes task-like messages", () => {
    const command = classifyByHeuristic("帮我读机械之心公众号最新文章，总结发给我", {
      hasRunningJob: false,
      hasPendingConfirmation: false
    });

    expect(command.kind).toBe("task");
    expect(command.instruction).toContain("机械之心");
  });

  it("keeps ordinary chat out of the task queue", () => {
    const command = classifyByHeuristic("哈哈哈好的", {
      hasRunningJob: false,
      hasPendingConfirmation: false
    });

    expect(command.kind).toBe("chat");
  });
});
