import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("headless architecture boundary", () => {
  it("does not depend on desktop-only packages or scripts", async () => {
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {})
    ]);

    for (const name of ["electron", "electron-builder", "electron-vite", "electron-store", "react", "react-dom", "lucide-react", "@vitejs/plugin-react", "zod"]) {
      expect(names.has(name), `${name} should not be a project dependency`).toBe(false);
    }

    const scripts = Object.values(pkg.scripts ?? {}).join("\n");
    expect(scripts).not.toMatch(/electron|builder|register-phone-agent-task|ScheduledTask/i);
  });

  it("keeps source free of desktop and Windows scheduler imports", async () => {
    const files = await sourceFiles(join(repoRoot, "src"));
    for (const file of files) {
      const text = await readFile(file, "utf8");
      const label = relative(repoRoot, file);
      expect(text, `${label} imports desktop-only APIs`).not.toMatch(/from\s+["'](?:electron|react|react-dom|lucide-react|electron-store)(?:\/[^"']*)?["']/);
      expect(text, `${label} references Windows scheduled-task APIs`).not.toMatch(/Register-ScheduledTask|New-ScheduledTask|EveryMinutes|Task Scheduler/i);
    }
  });
});

async function sourceFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(root)) {
    const path = join(root, entry);
    const info = await stat(path);
    if (info.isDirectory()) {
      output.push(...await sourceFiles(path));
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry) && entry !== "architecture.test.ts") {
      output.push(path);
    }
  }
  return output;
}
