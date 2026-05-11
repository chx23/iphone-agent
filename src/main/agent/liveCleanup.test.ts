import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DeviceRecord } from "../../shared/types";
import { ControlRouter } from "../controlRouter";
import { KuaijsClient } from "../kuaijsClient";
import { KuaiProjectRuntime } from "../kuaijsProjectRuntime";

const runLive = process.env.LIVE_PHONE_AGENT_CLEAR === "1";
const liveIt = runLive ? it : it.skip;

describe("live phone cleanup", () => {
  liveIt("clears the focused WeChat draft without sending it", async () => {
    const port = Number(process.env.PHONE_AGENT_DEVICE_PORT ?? "59844");
    const userDataDir = process.env.PHONE_AGENT_USER_DATA
      ?? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "phone-agent");
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
    await projectRuntime.ensure();
    const control = new ControlRouter(projectRuntime);
    const kuaijs = new KuaijsClient(() => [device], projectRuntime);
    await control.execute(device, { type: "input", text: "" }).catch(() => undefined);
    await sleep(3000);
    const source = await kuaijs.source(device);
    const values = [...source.matchAll(/<XCUIElementTypeTextView\b[^>]*\bvalue="([^"]*)"/g)].map((match) => match[1]);
    expect(values.filter(Boolean)).toHaveLength(0);
  }, 120_000);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
