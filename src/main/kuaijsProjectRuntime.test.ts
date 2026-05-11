import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "./kuaijsProjectRuntime";
import { buildRuntimeScript, KuaiProjectRuntime, parsePhoneAgentResult } from "./kuaijsProjectRuntime";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("KuaiJS project runtime", () => {
  it("parses PHONE_AGENT_RESULT from runtime logs", () => {
    const result = parsePhoneAgentResult([
      "noise",
      'PHONE_AGENT_RESULT {"commandId":"cmd_1","ok":true,"backend":"kuaijs-project","message":"done"}'
    ].join("\n"));

    expect(result?.commandId).toBe("cmd_1");
    expect(result?.ok).toBe(true);
    expect(result?.backend).toBe("kuaijs-project");
    expect(result?.message).toBe("done");
  });

  it("generates runtime project scaffold and package versions", async () => {
    const rootDir = await tempRuntimeDir();
    const runner: CommandRunner = async (file, args) => {
      if (file === "node" || file.startsWith("npm") && args[0] === "--version") return { stdout: "ok", stderr: "" };
      if (file.startsWith("npm") && args[0] === "install") {
        await writePackage(join(rootDir, "node_modules", "ms-vite-plugin", "package.json"), "1.1.18");
        await writePackage(join(rootDir, "node_modules", "ms-types", "package.json"), "0.7.3");
        await writeRuntimeBin(rootDir);
        return { stdout: "installed", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const runtime = new KuaiProjectRuntime({ rootDir, commandRunner: runner });
    const health = await runtime.ensure();
    const pkg = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };

    expect(health.projectRuntimeReady).toBe(true);
    expect(health.state).toBe("ready");
    expect(pkg.devDependencies["ms-vite-plugin"]).toBe("1.1.18");
    expect(pkg.devDependencies["ms-types"]).toBe("0.7.3");
    expect(await readFile(join(rootDir, "obfuscator.json"), "utf8")).toContain("high-obfuscation");
    expect(await readFile(join(rootDir, "scripts", "main.js"), "utf8")).toContain("PHONE_AGENT_RESULT");
  });

  it("maps core actions to script-side APIs", () => {
    const homeScript = buildRuntimeScript("cmd_home", { type: "home" });
    expect(homeScript).toContain("system.activateApp(springboard)");
    expect(homeScript).toContain("action.homeScreen");
    expect(homeScript).toContain("hid.pressButton");
    expect(buildRuntimeScript("cmd_tap", { type: "tap_xy", x: 10, y: 20, coordinateSpace: "screen" })).toContain("action.click");
    expect(buildRuntimeScript("cmd_swipe", { type: "swipe", startX: 1, startY: 2, endX: 3, endY: 4, coordinateSpace: "screen" })).toContain("action.swipe");
    expect(buildRuntimeScript("cmd_input", { type: "input", text: "hello" })).toContain("ime.input");
    const openAppScript = buildRuntimeScript("cmd_app", { type: "open_app", bundleId: "com.tencent.xin", displayName: "微信" });
    expect(openAppScript).toContain("system.activateApp");
    expect(openAppScript).toContain("hid.openApp(displayName)");
    expect(openAppScript).toContain("hid.openApp(bundleId)");
    expect(openAppScript).not.toContain("$系统");
    expect(openAppScript).not.toContain("$HID");
    expect(buildRuntimeScript("cmd_url", { type: "open_url", url: "https://example.com" })).toContain("hid.openURL");
  });

  it("generates parseable runtime scripts", () => {
    const scripts = [
      buildRuntimeScript("cmd_home", { type: "home" }),
      buildRuntimeScript("cmd_app", { type: "open_app", bundleId: "com.tencent.xin", displayName: "微信" }),
      buildRuntimeScript("cmd_input", { type: "input", text: "hello" }),
      buildRuntimeScript("cmd_scroll", { type: "collect_scroll", direction: "down", maxScrolls: 1 })
    ];

    for (const script of scripts) {
      expect(() => new Function(script)).not.toThrow();
    }
  });

  it("falls back from HTTP run to WS run", async () => {
    const rootDir = await tempRuntimeDir();
    await writePackage(join(rootDir, "node_modules", "ms-vite-plugin", "package.json"), "1.1.18");
    await writePackage(join(rootDir, "node_modules", "ms-types", "package.json"), "0.7.3");
    await writeRuntimeBin(rootDir);

    const seenArgs: string[][] = [];
    const runner: CommandRunner = async (file, args) => {
      if (file === "node" || file.startsWith("npm")) return { stdout: "ok", stderr: "" };
      seenArgs.push(args);
      if (args.includes("http")) throw new Error("401 Unauthorized");
      return {
        stdout: 'PHONE_AGENT_RESULT {"commandId":"cmd_1","ok":true,"backend":"kuaijs-project","message":"ws ok"}',
        stderr: ""
      };
    };

    const runtime = new KuaiProjectRuntime({ rootDir, commandRunner: runner });
    const result = await runtime.execute(
      { id: "dev", name: "iPhone", host: "127.0.0.1", port: 58128, source: "bridge", connectionMode: "bridge" },
      { type: "home" }
    );

    expect(result.ok).toBe(true);
    expect(result.message).toBe("ws ok");
    expect(seenArgs.some((args) => args.includes("http"))).toBe(true);
    expect(seenArgs.some((args) => args.includes("ws"))).toBe(true);
  });

  it("retries transient scroll runtime failures", async () => {
    const rootDir = await tempRuntimeDir();
    await writePackage(join(rootDir, "node_modules", "ms-vite-plugin", "package.json"), "1.1.18");
    await writePackage(join(rootDir, "node_modules", "ms-types", "package.json"), "0.7.3");
    await writeRuntimeBin(rootDir);

    const seenArgs: string[][] = [];
    const runner: CommandRunner = async (file, args) => {
      if (file === "node" || file.startsWith("npm")) return { stdout: "ok", stderr: "" };
      seenArgs.push(args);
      if (seenArgs.length <= 2) throw new Error("等待设备连接超时");
      return {
        stdout: 'PHONE_AGENT_RESULT {"commandId":"cmd_scroll","ok":true,"backend":"kuaijs-project","message":"scroll ok"}',
        stderr: ""
      };
    };

    const runtime = new KuaiProjectRuntime({ rootDir, commandRunner: runner });
    const result = await runtime.execute(
      { id: "dev", name: "iPhone", host: "127.0.0.1", port: 58128, source: "bridge", connectionMode: "bridge" },
      { type: "collect_scroll", direction: "down", maxScrolls: 1 }
    );

    expect(result.ok).toBe(true);
    expect(result.message).toBe("scroll ok");
    expect(seenArgs.length).toBeGreaterThan(2);
  });

  it("retries HTTP open-app verification failures instead of falling back to WS immediately", async () => {
    const rootDir = await tempRuntimeDir();
    await writePackage(join(rootDir, "node_modules", "ms-vite-plugin", "package.json"), "1.1.18");
    await writePackage(join(rootDir, "node_modules", "ms-types", "package.json"), "0.7.3");
    await writeRuntimeBin(rootDir);
    vi.stubGlobal("fetch", vi.fn((url: string | URL) => {
      const value = String(url);
      if (value.includes("/logger/sse")) return Promise.resolve(new Response("not found", { status: 404 }));
      if (value.includes("/api/activeAppInfo")) {
        const bundleId = httpRuns >= 2 ? "com.tencent.xin" : "com.apple.springboard";
        return Promise.resolve(Response.json({ success: true, data: { bundleId, name: bundleId } }));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }));

    let httpRuns = 0;
    const seenArgs: string[][] = [];
    const runner: CommandRunner = async (file, args) => {
      if (file === "node" || file.startsWith("npm")) return { stdout: "ok", stderr: "" };
      seenArgs.push(args);
      if (args.includes("http")) httpRuns += 1;
      return { stdout: "运行请求已发送", stderr: "" };
    };

    const runtime = new KuaiProjectRuntime({ rootDir, commandRunner: runner });
    const result = await runtime.execute(
      { id: "dev", name: "iPhone", host: "127.0.0.1", port: 58128, source: "bridge", connectionMode: "bridge" },
      { type: "open_app", bundleId: "com.tencent.xin", displayName: "微信" }
    );

    expect(result.ok).toBe(true);
    expect(httpRuns).toBe(2);
    expect(seenArgs.some((args) => args.includes("ws"))).toBe(false);
  }, 12000);

  it("does not retry input actions after transient CLI failures", async () => {
    const rootDir = await tempRuntimeDir();
    await writePackage(join(rootDir, "node_modules", "ms-vite-plugin", "package.json"), "1.1.18");
    await writePackage(join(rootDir, "node_modules", "ms-types", "package.json"), "0.7.3");
    await writeRuntimeBin(rootDir);

    let runCount = 0;
    const runner: CommandRunner = async (file) => {
      if (file === "node" || file.startsWith("npm")) return { stdout: "ok", stderr: "" };
      runCount += 1;
      throw new Error("等待设备连接超时");
    };

    const runtime = new KuaiProjectRuntime({ rootDir, commandRunner: runner });
    await expect(runtime.execute(
      { id: "dev", name: "iPhone", host: "127.0.0.1", port: 58128, source: "bridge", connectionMode: "bridge" },
      { type: "input", text: "hello" }
    )).rejects.toThrow("等待设备连接超时");
    expect(runCount).toBe(1);
  });

  it("fails low-level actions when runtime result logs are unavailable", async () => {
    const rootDir = await tempRuntimeDir();
    await writePackage(join(rootDir, "node_modules", "ms-vite-plugin", "package.json"), "1.1.18");
    await writePackage(join(rootDir, "node_modules", "ms-types", "package.json"), "0.7.3");
    await writeRuntimeBin(rootDir);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404, statusText: "Not Found" })));

    const seenArgs: string[][] = [];
    const runner: CommandRunner = async (file, args) => {
      if (file === "node" || file.startsWith("npm")) return { stdout: "ok", stderr: "" };
      seenArgs.push(args);
      return { stdout: "✅ 运行请求已发送", stderr: "" };
    };

    const runtime = new KuaiProjectRuntime({ rootDir, commandRunner: runner });
    await expect(runtime.execute(
      { id: "dev", name: "iPhone", host: "127.0.0.1", port: 58128, source: "bridge", connectionMode: "bridge" },
      { type: "tap_xy", x: 10, y: 20, coordinateSpace: "screen" }
    )).rejects.toThrow("PHONE_AGENT_RESULT");

    expect(seenArgs).toHaveLength(2);
    expect(seenArgs[0]).toContain("http");
    expect(seenArgs[1]).toContain("http");
  });

  it("accepts runtime smoke when HTTP run is sent but logs are unavailable", async () => {
    const rootDir = await tempRuntimeDir();
    await writePackage(join(rootDir, "node_modules", "ms-vite-plugin", "package.json"), "1.1.18");
    await writePackage(join(rootDir, "node_modules", "ms-types", "package.json"), "0.7.3");
    await writeRuntimeBin(rootDir);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404, statusText: "Not Found" })));

    const seenArgs: string[][] = [];
    const runner: CommandRunner = async (file, args) => {
      if (file === "node" || file.startsWith("npm")) return { stdout: "ok", stderr: "" };
      seenArgs.push(args);
      return { stdout: "运行请求已发送", stderr: "" };
    };

    const runtime = new KuaiProjectRuntime({ rootDir, commandRunner: runner });
    const result = await runtime.smokeTest(
      { id: "dev", name: "iPhone", host: "127.0.0.1", port: 58128, source: "bridge", connectionMode: "bridge" }
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("no-op runtime smoke accepted");
    expect(seenArgs).toHaveLength(1);
    expect(seenArgs[0]).toContain("http");
  });

  it("verifies low-level actions through a changed source tree when runtime logs are unavailable", async () => {
    const rootDir = await tempRuntimeDir();
    await writePackage(join(rootDir, "node_modules", "ms-vite-plugin", "package.json"), "1.1.18");
    await writePackage(join(rootDir, "node_modules", "ms-types", "package.json"), "0.7.3");
    await writeRuntimeBin(rootDir);

    let sourceReads = 0;
    vi.stubGlobal("fetch", vi.fn((url: string | URL) => {
      const value = String(url);
      if (value.includes("/logger/sse")) return Promise.resolve(new Response("not found", { status: 404, statusText: "Not Found" }));
      if (value.includes("/api/source")) {
        sourceReads += 1;
        return Promise.resolve(new Response(sourceReads === 1 ? "<App><Text label=\"before\" /></App>" : "<App><Text label=\"after\" /></App>"));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }));

    const seenArgs: string[][] = [];
    const runner: CommandRunner = async (file, args) => {
      if (file === "node" || file.startsWith("npm")) return { stdout: "ok", stderr: "" };
      seenArgs.push(args);
      return { stdout: "运行请求已发送", stderr: "" };
    };

    const runtime = new KuaiProjectRuntime({ rootDir, commandRunner: runner });
    const result = await runtime.execute(
      { id: "dev", name: "iPhone", host: "127.0.0.1", port: 58128, source: "bridge", connectionMode: "bridge" },
      { type: "tap_xy", x: 10, y: 20, coordinateSpace: "screen" }
    );

    expect(result.ok).toBe(true);
    expect(result.commandId).toBe("verified");
    expect(result.message).toContain("source tree changed");
    expect(seenArgs).toHaveLength(1);
  });

  it("verifies input actions through the observed source tree", async () => {
    const rootDir = await tempRuntimeDir();
    await writePackage(join(rootDir, "node_modules", "ms-vite-plugin", "package.json"), "1.1.18");
    await writePackage(join(rootDir, "node_modules", "ms-types", "package.json"), "0.7.3");
    await writeRuntimeBin(rootDir);
    vi.stubGlobal("fetch", vi.fn((url: string | URL) => {
      const value = String(url);
      if (value.includes("/logger/sse")) return Promise.resolve(new Response("not found", { status: 404 }));
      if (value.includes("/api/source")) return Promise.resolve(new Response('<App><Text label="陈弘轩" /></App>'));
      return Promise.resolve(new Response("{}", { status: 404 }));
    }));

    const seenArgs: string[][] = [];
    const runner: CommandRunner = async (file, args) => {
      if (file === "node" || file.startsWith("npm")) return { stdout: "ok", stderr: "" };
      seenArgs.push(args);
      return { stdout: "✅ 运行请求已发送", stderr: "" };
    };

    const runtime = new KuaiProjectRuntime({ rootDir, commandRunner: runner });
    const result = await runtime.execute(
      { id: "dev", name: "iPhone", host: "127.0.0.1", port: 58128, source: "bridge", connectionMode: "bridge" },
      { type: "input", text: "陈弘轩" }
    );

    expect(result.ok).toBe(true);
    expect(result.commandId).toBe("verified");
    expect(result.message).toContain("input text is visible");
    expect(seenArgs).toHaveLength(1);
  });

  it("waits for long input to appear in the active text view instead of trusting old chat history", async () => {
    const rootDir = await tempRuntimeDir();
    await writePackage(join(rootDir, "node_modules", "ms-vite-plugin", "package.json"), "1.1.18");
    await writePackage(join(rootDir, "node_modules", "ms-types", "package.json"), "0.7.3");
    await writeRuntimeBin(rootDir);
    const message = "我读了机器之心最新文章《专业的人工智能媒体和产业服务平台》，摘要：1. 第一条摘要 2. 第二条摘要（phone-agent 自动整理）";
    let sourceReads = 0;
    vi.stubGlobal("fetch", vi.fn((url: string | URL) => {
      const value = String(url);
      if (value.includes("/logger/sse")) return Promise.resolve(new Response("not found", { status: 404 }));
      if (value.includes("/api/source")) {
        sourceReads += 1;
        const source = sourceReads < 3
          ? `<App><Text label="${message}" /><XCUIElementTypeTextView value="" /></App>`
          : `<App><Text label="${message}" /><XCUIElementTypeTextView value="${message}" /></App>`;
        return Promise.resolve(new Response(source));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }));

    const seenArgs: string[][] = [];
    const runner: CommandRunner = async (file, args) => {
      if (file === "node" || file.startsWith("npm")) return { stdout: "ok", stderr: "" };
      seenArgs.push(args);
      return { stdout: "运行请求已发送", stderr: "" };
    };

    const runtime = new KuaiProjectRuntime({ rootDir, commandRunner: runner });
    const result = await runtime.execute(
      { id: "dev", name: "iPhone", host: "127.0.0.1", port: 58128, source: "bridge", connectionMode: "bridge" },
      { type: "input", text: message }
    );

    expect(result.ok).toBe(true);
    expect(result.commandId).toBe("verified");
    expect(sourceReads).toBeGreaterThanOrEqual(3);
    expect(seenArgs).toHaveLength(1);
  });

  it("rejects duplicated long input drafts after runtime input", async () => {
    const rootDir = await tempRuntimeDir();
    await writePackage(join(rootDir, "node_modules", "ms-vite-plugin", "package.json"), "1.1.18");
    await writePackage(join(rootDir, "node_modules", "ms-types", "package.json"), "0.7.3");
    await writeRuntimeBin(rootDir);
    const message = "我读了机器之心最新文章《专业的人工智能媒体和产业服务平台》，摘要：1. 第一条摘要 2. 第二条摘要（phone-agent 自动整理）";
    vi.stubGlobal("fetch", vi.fn((url: string | URL) => {
      const value = String(url);
      if (value.includes("/logger/sse")) return Promise.resolve(new Response("not found", { status: 404 }));
      if (value.includes("/api/source")) {
        return Promise.resolve(new Response(`<App><XCUIElementTypeTextView value="${message}${message}" /></App>`));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }));

    const runner: CommandRunner = async (file) => {
      if (file === "node" || file.startsWith("npm")) return { stdout: "ok", stderr: "" };
      return { stdout: "运行请求已发送", stderr: "" };
    };

    const runtime = new KuaiProjectRuntime({ rootDir, commandRunner: runner });
    await expect(runtime.execute(
      { id: "dev", name: "iPhone", host: "127.0.0.1", port: 58128, source: "bridge", connectionMode: "bridge" },
      { type: "input", text: message }
    )).rejects.toThrow("duplicate long draft");
  });

  it("accepts long input when iOS exposes an abbreviated active text view value", async () => {
    const rootDir = await tempRuntimeDir();
    await writePackage(join(rootDir, "node_modules", "ms-vite-plugin", "package.json"), "1.1.18");
    await writePackage(join(rootDir, "node_modules", "ms-types", "package.json"), "0.7.3");
    await writeRuntimeBin(rootDir);
    const message = "我读了机器之心最新文章《具身智能来时路：谷歌RT1、2，SayCan作者Ted Xiao复盘机器人学习》。 简要总结：文章围绕“具身智能来时路：谷歌RT1、2，SayCan作者Ted X...”展开。在最近的一次访谈中，Ted Xiao 以亲历者视角系统回顾了过去近十年来具身智能领域的变革，复盘了每个关键决策背后的思考过程。但 Ted Xiao 说，哪怕是最粗糙的那一条，放在两年前都能让全场研究者惊掉下巴。如今，他已加入 Project Prometheus，致力于突破具身智能在大规模环境下的推理与控制。（phone-agent 自动整理）";
    const abbreviated = `${message.slice(0, 70)}...${message.slice(150, 210)}...${message.slice(-70)}`;
    vi.stubGlobal("fetch", vi.fn((url: string | URL) => {
      const value = String(url);
      if (value.includes("/logger/sse")) return Promise.resolve(new Response("not found", { status: 404 }));
      if (value.includes("/api/source")) {
        return Promise.resolve(new Response(`<App><XCUIElementTypeTextView value="${abbreviated}" /></App>`));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }));

    const runner: CommandRunner = async (file) => {
      if (file === "node" || file.startsWith("npm")) return { stdout: "ok", stderr: "" };
      return { stdout: "运行请求已发送", stderr: "" };
    };

    const runtime = new KuaiProjectRuntime({ rootDir, commandRunner: runner });
    const result = await runtime.execute(
      { id: "dev", name: "iPhone", host: "127.0.0.1", port: 58128, source: "bridge", connectionMode: "bridge" },
      { type: "input", text: message }
    );

    expect(result.ok).toBe(true);
  });

  it("rejects long input when only a partial draft is visible in the active text view", async () => {
    const rootDir = await tempRuntimeDir();
    await writePackage(join(rootDir, "node_modules", "ms-vite-plugin", "package.json"), "1.1.18");
    await writePackage(join(rootDir, "node_modules", "ms-types", "package.json"), "0.7.3");
    await writeRuntimeBin(rootDir);
    const message = "我读了机器之心最新文章《专业的人工智能媒体和产业服务平台》，摘要：1. 第一条摘要 2. 第二条摘要（phone-agent 自动整理）";
    vi.stubGlobal("fetch", vi.fn((url: string | URL) => {
      const value = String(url);
      if (value.includes("/logger/sse")) return Promise.resolve(new Response("not found", { status: 404 }));
      if (value.includes("/api/source")) {
        return Promise.resolve(new Response(`<App><XCUIElementTypeTextView value="我读了机器之心最新文章《专业的人工智能媒体" /><Text label="${message}" /></App>`));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }));

    const runner: CommandRunner = async (file) => {
      if (file === "node" || file.startsWith("npm")) return { stdout: "ok", stderr: "" };
      return { stdout: "运行请求已发送", stderr: "" };
    };

    const runtime = new KuaiProjectRuntime({ rootDir, commandRunner: runner });
    await expect(runtime.execute(
      { id: "dev", name: "iPhone", host: "127.0.0.1", port: 58128, source: "bridge", connectionMode: "bridge" },
      { type: "input", text: message }
    )).rejects.toThrow("active input field");
  });
});

async function tempRuntimeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "phone-agent-runtime-"));
  tempDirs.push(dir);
  return dir;
}

async function writePackage(path: string, version: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({ version }), "utf8");
}

async function writeRuntimeBin(rootDir: string): Promise<void> {
  const binDir = join(rootDir, "node_modules", ".bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, process.platform === "win32" ? "ms.cmd" : "ms"), "", "utf8");
}
