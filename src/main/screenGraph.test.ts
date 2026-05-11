import { describe, expect, it } from "vitest";
import { buildScreenGraph, findElement } from "./screenGraph";

describe("screen graph", () => {
  it("builds element refs from source XML", () => {
    const graph = buildScreenGraph({
      source: '<App><Button label="搜索" type="XCUIElementTypeButton" x="10" y="20" width="100" height="40" /></App>',
      activeApp: { name: "微信" }
    });

    expect(graph.app).toBe("微信");
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(findElement(graph, "搜索")?.bounds).toEqual({ x: 10, y: 20, width: 100, height: 40 });
  });

  it("prefers the root viewport over cached offscreen nodes", () => {
    const graph = buildScreenGraph({
      source: `
        <XCUIElementTypeApplication label="微信" type="XCUIElementTypeApplication" x="0" y="0" width="1170" height="2532">
          <XCUIElementTypeCell label="缓存文章标题" type="XCUIElementTypeCell" x="0" y="2886" width="1170" height="320" visible="true" />
        </XCUIElementTypeApplication>
      `
    });

    expect(graph.screenSize).toEqual({ width: 1170, height: 2532 });
  });

  it("drops stale source nodes when active app and source bundle disagree", () => {
    const graph = buildScreenGraph({
      activeApp: { data: { name: "com.apple.springboard", bundleId: "com.apple.springboard" } },
      source: `
        <XCUIElementTypeApplication bundleId="com.tencent.xin" label="微信" type="XCUIElementTypeApplication" x="0" y="0" width="1170" height="2532">
          <XCUIElementTypeButton label="通讯录" type="XCUIElementTypeButton" x="0" y="2300" width="200" height="180" />
        </XCUIElementTypeApplication>
      `
    });

    expect(graph.app).toBe("com.apple.springboard");
    expect(graph.rawSource).toBeUndefined();
    expect(graph.nodes).toHaveLength(0);
  });
});
