import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DeviceRecord } from "../../shared/types";
import { ControlRouter } from "../controlRouter";
import { KuaijsClient } from "../kuaijsClient";
import { KuaiProjectRuntime } from "../kuaijsProjectRuntime";

const runLive = process.env.LIVE_PHONE_AGENT_SEND_DRAFT === "1";
const liveIt = runLive ? it : it.skip;

describe("live phone agent draft sending", () => {
  liveIt("sends the currently visible WeChat draft", async () => {
    const port = Number(process.env.PHONE_AGENT_DEVICE_PORT ?? "59844");
    const userDataDir = process.env.PHONE_AGENT_USER_DATA
      ?? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "phone-agent");
    await mkdir(userDataDir, { recursive: true });

    const device: DeviceRecord = {
      id: `bridge_127_0_0_1_${port}`,
      name: `Local KuaiJS Bridge ${port}`,
      host: "127.0.0.1",
      port,
      source: "bridge",
      connectionMode: "bridge",
      preferredRunTransport: "http",
      runtimeTargetHost: "127.0.0.1",
      runtimeTargetPort: port,
      runtimeTransport: "http"
    };
    const projectRuntime = new KuaiProjectRuntime({
      rootDir: join(userDataDir, "phone-agent-kuai-runtime")
    });
    const control = new ControlRouter(projectRuntime);
    const kuaijs = new KuaijsClient(() => [device], projectRuntime);

    const before = await kuaijs.source(device);
    const send = findVisibleSendButtonCenter(before);
    expect(send).toBeTruthy();

    await control.execute(device, { type: "tap_xy", x: send!.x, y: send!.y, coordinateSpace: "screen" })
      .catch(() => undefined);
    await sleep(1800);

    const after = await kuaijs.source(device);
    expect(hasActiveDraft(after)).toBe(false);
  }, 90_000);
});

function findVisibleSendButtonCenter(source: string): { x: number; y: number } | undefined {
  const matches = [...source.matchAll(/<XCUIElementTypeButton\b[^>]*(?:identifier="Send"|label="发送")[^>]*visible="true"[^>]*>/g)];
  for (const match of matches) {
    const tag = match[0];
    if (/enabled="false"/.test(tag)) continue;
    const x = numberAttribute(tag, "x");
    const y = numberAttribute(tag, "y");
    const width = numberAttribute(tag, "width");
    const height = numberAttribute(tag, "height");
    if ([x, y, width, height].every((value) => value !== undefined)) {
      return { x: x! + width! / 2, y: y! + height! / 2 };
    }
  }
  return undefined;
}

function hasActiveDraft(source: string): boolean {
  return /<XCUIElementTypeTextView\b[^>]*\bvisible="true"[^>]*\bvalue="[^"]{2,}"/.test(source)
    && /<XCUIElementTypeButton\b[^>]*(?:identifier="Send"|label="发送")[^>]*enabled="true"[^>]*visible="true"/.test(source);
}

function numberAttribute(tag: string, name: string): number | undefined {
  const match = tag.match(new RegExp(`\\b${name}="(-?\\d+(?:\\.\\d+)?)"`));
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
