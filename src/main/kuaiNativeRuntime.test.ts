import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceRecord } from "../shared/types";
import { buildNativeProbeScript, buildNativeRuntimeScript, KuaiNativeRuntime, parseNativeResult } from "./kuaiNativeRuntime";

const device: DeviceRecord = {
  id: "dev",
  name: "iPhone",
  host: "127.0.0.1",
  port: 58128,
  source: "bridge",
  connectionMode: "bridge",
  runtimeTargetHost: "127.0.0.1",
  runtimeTargetPort: 58128
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("KuaiJS native runtime", () => {
  it("parses PHONE_AGENT_NATIVE_RESULT from raw and nested logs", () => {
    const result = parseNativeResult([
      "noise",
      'PHONE_AGENT_NATIVE_RESULT {"commandId":"native_1","ok":true,"backend":"kuaijs-native","nativeFastPath":"runScript","message":"done"}'
    ].join("\n"));

    expect(result?.commandId).toBe("native_1");
    expect(result?.ok).toBe(true);
    expect(result?.backend).toBe("kuaijs-native");
    expect(result?.nativeFastPath).toBe("runScript");

    const nested = parseNativeResult(JSON.stringify({
      success: true,
      data: {
        logs: [
          'PHONE_AGENT_NATIVE_RESULT {"commandId":"native_2","ok":true,"backend":"kuaijs-native","message":"nested"}'
        ]
      }
    }));
    expect(nested?.commandId).toBe("native_2");
  });

  it("generates parseable native scripts for probe and compound actions", () => {
    const scripts = [
      buildNativeProbeScript(),
      buildNativeRuntimeScript("cmd_home", { type: "home" }),
      buildNativeRuntimeScript("cmd_tap_text", { type: "tap_text", text: "公众号" }),
      buildNativeRuntimeScript("cmd_input", { type: "input_atomic", text: "一整条长消息\n也应该作为草稿输入" }),
      buildNativeRuntimeScript("cmd_stable", { type: "scroll_until_stable", direction: "down", maxScrolls: 6, stableThreshold: 3 }),
      buildNativeRuntimeScript("cmd_article", { type: "read_wechat_article_native", account: "机械之心", maxScrolls: 18, stableThreshold: 3 })
    ];

    for (const script of scripts) {
      expect(() => new Function(script)).not.toThrow();
    }
  });

  it("chooses runScript fast path when the bridge accepts scripts", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response([
      "log",
      'PHONE_AGENT_NATIVE_RESULT {"commandId":"native_probe","ok":true,"backend":"kuaijs-native","message":"probe ok","data":{"capabilities":{"nodeSelector":true,"hidUsb":true,"ime":true,"appleOcr":true,"image":true,"system":true}}}'
    ].join("\n")));
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new KuaiNativeRuntime();
    const result = await runtime.probe(device, true, true);

    expect(result.ok).toBe(true);
    expect(result.fastPath).toBe("runScript");
    expect(result.capabilities.runScript).toBe(true);
    expect(result.capabilities.nodeSelector).toBe(true);
    expect(result.capabilities.hidUsb).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/runScript");
  });

  it("falls back to project runtime when runScript is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404, statusText: "Not Found" })));

    const runtime = new KuaiNativeRuntime();
    const result = await runtime.probe(device, true, true);

    expect(result.ok).toBe(true);
    expect(result.fastPath).toBe("project");
    expect(result.capabilities.runScript).toBe(false);
    expect(result.capabilities.projectRuntime).toBe(true);
    expect(result.message).toContain("project runtime fallback");
  });

  it("executes a native action through runScript and records timing", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { script?: string };
      if (body.script?.includes("native probe ok")) {
        return new Response('PHONE_AGENT_NATIVE_RESULT {"commandId":"native_probe","ok":true,"backend":"kuaijs-native","message":"probe ok","data":{"capabilities":{"nodeSelector":true}}}');
      }
      return new Response('PHONE_AGENT_NATIVE_RESULT {"commandId":"native_cmd","ok":true,"backend":"kuaijs-native","nativeFastPath":"runScript","message":"tap ok","timing":{"scriptMs":12}}');
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new KuaiNativeRuntime();
    const result = await runtime.execute(device, { type: "tap_xy", x: 100, y: 200, coordinateSpace: "screen" });

    expect(result.ok).toBe(true);
    expect(result.backend).toBe("kuaijs-native");
    expect(result.nativeFastPath).toBe("runScript");
    expect(result.message).toBe("tap ok");
    expect(result.timing?.totalMs).toBeGreaterThanOrEqual(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
