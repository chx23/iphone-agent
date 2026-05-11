import { describe, expect, it } from "vitest";
import { parseEnvFile } from "./env";

describe("local env loader", () => {
  it("parses local private env files without requiring dotenv", () => {
    expect(parseEnvFile([
      "# local secrets",
      "AI_API_URL=https://llmapi.paratera.com/v1/chat/completions",
      "LANGUAGE_MODEL=\"GLM-5-Turbo\"",
      "VISION_MODEL='Qwen3-VL-235B-A22B-Instruct'",
      "PHONE_AGENT_AUTO_CONFIRM=1 # comment"
    ].join("\n"))).toEqual([
      { key: "AI_API_URL", value: "https://llmapi.paratera.com/v1/chat/completions" },
      { key: "LANGUAGE_MODEL", value: "GLM-5-Turbo" },
      { key: "VISION_MODEL", value: "Qwen3-VL-235B-A22B-Instruct" },
      { key: "PHONE_AGENT_AUTO_CONFIRM", value: "1" }
    ]);
  });
});
