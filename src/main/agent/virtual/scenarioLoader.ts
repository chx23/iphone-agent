import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ElementRef, ScreenGraph } from "../../../shared/types";
import type { VirtualLiveModelCase, VirtualScenario, VirtualScreenFrame, VirtualScreenNode } from "./types";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../__fixtures__/virtual");

export function virtualFixturePath(...parts: string[]): string {
  return join(fixtureDir, ...parts);
}

export function loadVirtualScenario(id: string): VirtualScenario {
  const text = readFileSync(virtualFixturePath(`${id}.json`), "utf8");
  return JSON.parse(text) as VirtualScenario;
}

export function listVirtualScenarioIds(): string[] {
  return readdirSync(fixtureDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, ""))
    .sort();
}

export function loadVirtualImageBase64(frame: VirtualScreenFrame): string {
  return readFileSync(virtualFixturePath(frame.image)).toString("base64");
}

export function virtualFrameToScreenGraph(frame: VirtualScreenFrame): ScreenGraph {
  return {
    app: frame.app,
    screenSize: { width: 1170, height: 2532 },
    orientation: "portrait",
    nodes: frame.nodes.map(toElementRef),
    ocrBlocks: [],
    dialogs: (frame.dialogs ?? []).map(toElementRef),
    keyboardVisible: Boolean(frame.keyboardVisible),
    rawSource: virtualFrameToSource(frame),
    screenshotBase64: loadVirtualImageBase64(frame),
    observedAt: Date.now()
  };
}

export function virtualScreenFor(scenario: VirtualScenario, frameId: string): ScreenGraph {
  const frame = scenario.frames[frameId];
  if (!frame) throw new Error(`Virtual frame not found: ${frameId}`);
  return virtualFrameToScreenGraph(frame);
}

export function virtualFrameToSource(frame: VirtualScreenFrame): string {
  const nodes = [...frame.nodes, ...(frame.dialogs ?? [])].map((node, index) => xmlNode(toElementRef(node, index))).join("\n");
  return [
    `<XCUIElementTypeApplication label="${xmlEscape(appLabel(frame.app))}" type="XCUIElementTypeApplication" x="0" y="0" width="1170" height="2532" visible="true" enabled="true" bundleId="${xmlEscape(frame.app ?? "virtual.app")}">`,
    nodes,
    "</XCUIElementTypeApplication>"
  ].join("\n");
}

export function virtualLiveModelCases(scenarios: VirtualScenario[]): VirtualLiveModelCase[] {
  return scenarios.flatMap((scenario) => Object.values(scenario.frames)
    .filter((frame) => frame.vision?.pageType)
    .map((frame) => ({
      scenarioId: scenario.id,
      frameId: frame.id,
      imageBase64: loadVirtualImageBase64(frame),
      expectedPageType: frame.vision!.pageType!
    })));
}

function toElementRef(node: VirtualScreenNode, index = 0): ElementRef {
  const role = node.role ?? "XCUIElementTypeStaticText";
  const disabledContainer = node.clickable === false && /TabBar|Keyboard|WebView/.test(`${role} ${node.label}`);
  return {
    id: node.id ?? `el_${index + 1}`,
    source: "node",
    label: node.label,
    role,
    bounds: node.bounds,
    confidence: node.confidence ?? 0.86,
    clickable: disabledContainer ? false : Boolean(node.bounds)
  };
}

function xmlNode(node: ElementRef): string {
  const bounds = node.bounds ?? { x: 0, y: 0, width: 1, height: 1 };
  const type = node.role ?? "XCUIElementTypeStaticText";
  return `  <${xmlEscape(type)} label="${xmlEscape(node.label)}" name="${xmlEscape(node.label)}" type="${xmlEscape(type)}" x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" visible="true" enabled="${node.clickable === false ? "false" : "true"}" />`;
}

function appLabel(app?: string): string {
  if (app?.includes("com.tencent.xin")) return "微信";
  if (app?.includes("com.dianping")) return "大众点评";
  if (app?.includes("springboard")) return "主屏幕";
  return "虚拟屏幕";
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
