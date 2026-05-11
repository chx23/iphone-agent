import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/main/agent/virtual/**/*.live.ts"],
    testTimeout: 240_000
  }
});
