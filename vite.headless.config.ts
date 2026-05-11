import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    target: "node20",
    ssr: true,
    outDir: "out/headless",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "phone-agent": resolve(__dirname, "src/main/headless.ts")
      },
      output: {
        entryFileNames: "[name].js",
        format: "es"
      }
    }
  }
});
