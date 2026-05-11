import { describe, expect, it, vi } from "vitest";
import { chatCompletionsUrl, LlmClient, LlmRequestError, modelsUrl } from "./llmClient";

describe("LLM endpoint helpers", () => {
  it("keeps full chat completions URLs unchanged", () => {
    expect(chatCompletionsUrl("https://llmapi.paratera.com/v1/chat/completions")).toBe("https://llmapi.paratera.com/v1/chat/completions");
  });

  it("appends chat completions to legacy base URLs", () => {
    expect(chatCompletionsUrl("https://llmapi.paratera.com/v1")).toBe("https://llmapi.paratera.com/v1/chat/completions");
  });

  it("derives the models endpoint from either shape", () => {
    expect(modelsUrl("https://llmapi.paratera.com/v1/chat/completions")).toBe("https://llmapi.paratera.com/v1/models");
    expect(modelsUrl("https://llmapi.paratera.com/v1")).toBe("https://llmapi.paratera.com/v1/models");
  });

  it("wraps chat transport failures as language model errors", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network timeout"))));
    const client = new LlmClient(
      () => "https://example.com/v1/chat/completions",
      () => "sk-test",
      () => "test-model"
    );

    await expect(client.completeJson("system", "user")).rejects.toBeInstanceOf(LlmRequestError);
  });
});
