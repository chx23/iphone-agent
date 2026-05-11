import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlRouter } from "./controlRouter";
import { buildControlMessage, extractStatusData, fallbackBridgePorts, isUsableBridgeStatus, KuaijsClient, KuaijsRequestError } from "./kuaijsClient";
import type { KuaiProjectRuntime } from "./kuaijsProjectRuntime";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("kuaijs status helpers", () => {
  it("extracts nested status data", () => {
    const data = extractStatusData({
      success: true,
      data: {
        agentConnected: true,
        deviceName: "iPhone",
        serverDeviceId: "device-1"
      }
    });

    expect(data?.agentConnected).toBe(true);
    expect(data?.deviceName).toBe("iPhone");
  });

  it("accepts usable local bridge status", () => {
    expect(isUsableBridgeStatus({ agentConnected: true })).toBe(true);
    expect(isUsableBridgeStatus({ serverDeviceId: "device-1" })).toBe(true);
    expect(isUsableBridgeStatus(undefined)).toBe(false);
  });

  it("includes common USB bridge port ranges in fallback discovery", () => {
    expect(fallbackBridgePorts()).toContain(59844);
    expect(fallbackBridgePorts()).toContain(58128);
    expect(fallbackBridgePorts()).toContain(34116);
  });

  it("uses project runtime as the only automatic control backend", () => {
    expect(buildControlMessage({ agentConnected: true, isAuth: false }, true, true)).toContain("快点JS项目运行时");
    expect(buildControlMessage({ agentConnected: true, isAuth: true }, true, true)).toContain("仅作为诊断信息");
    expect(buildControlMessage({ agentConnected: true, isAuth: false }, true, false)).toContain("项目运行时暂不可用");
  });

  it("keeps endpoint and status on request errors", () => {
    const error = new KuaijsRequestError("Denied", "/api/status", 401, "Unauthorized", "bridge");
    expect(error.endpoint).toBe("/api/status");
    expect(error.status).toBe(401);
    expect(error.connectionMode).toBe("bridge");
  });

  it("always uses project runtime for control actions", async () => {
    const runtime = {
      execute: vi.fn().mockResolvedValue({
        commandId: "cmd_1",
        ok: true,
        backend: "kuaijs-project",
        message: "runtime ok"
      })
    } as unknown as KuaiProjectRuntime;
    vi.stubGlobal("fetch", vi.fn());

    const control = new ControlRouter(runtime);
    const result = await control.execute(
      { id: "dev", name: "iPhone", host: "127.0.0.1", port: 58128, source: "bridge", connectionMode: "bridge" },
      { type: "home" }
    );

    expect(result).toContain("快点JS项目运行时");
    expect(runtime.execute).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports project runtime as the control backend regardless of HTTP auth", async () => {
    const runtime = {
      healthCheck: vi.fn().mockResolvedValue({
        nodeReady: true,
        npmReady: true,
        msCliReady: true,
        projectRuntimeReady: true,
        state: "ready",
        projectDir: "C:/runtime",
        message: "ready"
      })
    } as unknown as KuaiProjectRuntime;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/api/status")) {
        return new Response(JSON.stringify({
          success: true,
          data: { agentConnected: true, isAuth: false, isLogin: true }
        }));
      }
      if (url.includes("/api/screenshotBase64")) return new Response("x".repeat(120));
      if (url.includes("/api/source")) return new Response("<App/>");
      if (url.includes("/api/ime/isOk")) return new Response("", { status: 401, statusText: "Unauthorized" });
      return new Response("{}");
    }));

    const client = new KuaijsClient(() => [], runtime);
    const health = await client.healthCheck(
      { id: "dev", name: "iPhone", host: "127.0.0.1", port: 58128, source: "bridge", connectionMode: "bridge" },
      true
    );

    expect(health.controlAuthorized).toBe(true);
    expect(health.controlBackend).toBe("kuaijs-project");
    expect(health.projectRuntimeState).toBe("ready");
    expect(health.controlMessage).toContain("isAuth 仅作为诊断信息");
  });
});
