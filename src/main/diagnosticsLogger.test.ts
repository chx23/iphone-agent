import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiagnosticsLogger, sanitizeEvent } from "./diagnosticsLogger";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("DiagnosticsLogger", () => {
  it("redacts API keys and bearer tokens", () => {
    const event = sanitizeEvent({
      id: "diag_1",
      timestamp: 1,
      source: "renderer",
      category: "ui_prompt",
      action: "save",
      message: "AI_API_KEY=sk-secret123456789 VISION_API_KEY=sk--vision123456789 Bearer abcdefghijk",
      payload: {
        apiKey: "sk-secret123456789",
        authorization: "Bearer abcdefghijk",
        instruction: "x".repeat(500)
      }
    });

    const text = JSON.stringify(event);
    expect(text).not.toContain("secret123456789");
    expect(text).not.toContain("vision123456789");
    expect(text).not.toContain("abcdefghijk");
    expect(text).toContain("[REDACTED]");
  });

  it("redacts private recipients and long screen text", () => {
    const event = sanitizeEvent({
      id: "diag_2",
      timestamp: 1,
      source: "agent",
      category: "agent_timeline",
      action: "manual_test_snapshot",
      status: "ok",
      payload: {
        pendingConfirmation: {
          recipient: "陈弘轩",
          editableText: "晚上吃什么",
          action: { type: "input", text: "晚上吃什么" }
        },
        lastScreen: {
          sampleLabels: [
            "陈弘轩",
            "我,这是一段很长的微信历史消息，包含正文内容，应该被日志脱敏处理，避免泄露聊天记录。"
          ]
        }
      }
    });

    const text = JSON.stringify(event);
    expect(text).not.toContain("晚上吃什么");
    expect(text).not.toContain("这是一段很长的微信历史消息");
    expect(text).toContain("[SCREEN_TEXT");
    expect(text).toContain("[TEXT 5 chars]");
  });

  it("writes and lists jsonl diagnostics", async () => {
    const dir = await tempDir();
    const logger = new DiagnosticsLogger(dir);
    await logger.log({
      source: "agent",
      category: "agent_timeline",
      action: "observing",
      taskId: "task_1",
      status: "ok",
      message: "done"
    });

    const records = await logger.list({ taskId: "task_1" });
    expect(records).toHaveLength(1);
    expect(records[0].message).toBe("done");
    expect(await readFile(logger.logPath, "utf8")).toContain("agent_timeline");
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "phone-agent-diagnostics-"));
  tempDirs.push(dir);
  return dir;
}
