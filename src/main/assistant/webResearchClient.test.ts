import { afterEach, describe, expect, it, vi } from "vitest";
import { WebResearchClient, formatResearchResultForWechat } from "./webResearchClient";

describe("WebResearchClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches direct URLs and builds a compact result without an LLM", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "<html><head><title>AI News</title></head><body><p>Today AI systems are being used in agents and robotics.</p></body></html>"
    })));
    const client = new WebResearchClient();

    const result = await client.research("看看 https://example.com/ai-news");

    expect(result.sources[0].title).toBe("AI News");
    expect(result.summary).toContain("AI News");
    expect(formatResearchResultForWechat(result)).toContain("来源");
  });
});
