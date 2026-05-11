import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_ENV_FILES = [
  resolve(process.cwd(), ".env.local"),
  join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "phone-agent", "local.env")
];

export function loadLocalEnv(files = DEFAULT_ENV_FILES): string[] {
  const loaded: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const entry of parseEnvFile(text)) {
      if (process.env[entry.key] === undefined) process.env[entry.key] = entry.value;
    }
    loaded.push(file);
  }
  return loaded;
}

export function parseEnvFile(text: string): Array<{ key: string; value: string }> {
  const entries: Array<{ key: string; value: string }> = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    entries.push({ key, value: unquoteEnvValue(rawValue.trim()) });
  }
  return entries;
}

function unquoteEnvValue(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  const commentIndex = value.search(/\s+#/);
  return commentIndex >= 0 ? value.slice(0, commentIndex).trimEnd() : value;
}
