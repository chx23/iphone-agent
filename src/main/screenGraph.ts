import { XMLParser } from "fast-xml-parser";
import type { Bounds, ElementRef, ScreenGraph } from "../shared/types";
import { createId, now, truncate } from "./utils";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  allowBooleanAttributes: true
});

interface BuildScreenGraphInput {
  source?: string;
  screenshotBase64?: string;
  activeApp?: unknown;
  ocrBlocks?: ElementRef[];
}

export function buildScreenGraph(input: BuildScreenGraphInput): ScreenGraph {
  const app = parseAppName(input.activeApp);
  const activeBundle = parseActiveAppBundle(input.activeApp);
  const sourceBundle = input.source ? parseSourceRootBundle(input.source) : undefined;
  const sourceForNodes = activeBundle && sourceBundle && activeBundle !== sourceBundle ? undefined : input.source;
  const nodes = sourceForNodes ? parseSourceNodes(sourceForNodes) : [];
  const dialogs = nodes.filter((node) => /alert|dialog|弹窗|允许|不允许|确定|取消/i.test(`${node.role ?? ""} ${node.label}`));
  const keyboardVisible = nodes.some((node) => /keyboard|键盘|return|space|delete/i.test(`${node.role ?? ""} ${node.label}`));
  const screenSize = inferScreenSize(nodes);

  return {
    app,
    screenSize,
    orientation: screenSize ? (screenSize.width > screenSize.height ? "landscape" : "portrait") : "unknown",
    nodes,
    ocrBlocks: input.ocrBlocks ?? [],
    dialogs,
    keyboardVisible,
    rawSource: sourceForNodes,
    screenshotBase64: input.screenshotBase64,
    observedAt: now()
  };
}

export function findElement(screen: ScreenGraph, query: string): ElementRef | undefined {
  const normalized = query.toLowerCase();
  return [...screen.nodes, ...screen.ocrBlocks]
    .filter((element) => element.label.toLowerCase().includes(normalized))
    .sort((a, b) => b.confidence - a.confidence)[0];
}

export function elementCenter(element: ElementRef): { x: number; y: number } | undefined {
  const bounds = element.bounds;
  if (!bounds) return undefined;
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2
  };
}

function parseSourceNodes(source: string): ElementRef[] {
  try {
    const parsed = parser.parse(source) as unknown;
    const rawNodes: unknown[] = [];
    collectXmlNodes(parsed, rawNodes);
    return rawNodes.map(toElementRef).filter((node): node is ElementRef => Boolean(node));
  } catch {
    return parseNodesWithFallback(source);
  }
}

function collectXmlNodes(value: unknown, output: unknown[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectXmlNodes(item, output));
    return;
  }
  if (!value || typeof value !== "object") return;

  const object = value as Record<string, unknown>;
  const hasNodeShape = ["label", "title", "name", "value", "identifier", "type", "x", "y", "width", "height", "bounds"].some((key) => key in object);
  if (hasNodeShape) output.push(object);
  for (const nested of Object.values(object)) {
    collectXmlNodes(nested, output);
  }
}

function toElementRef(raw: unknown, index: number): ElementRef | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const object = raw as Record<string, unknown>;
  const label = firstString(object.label, object.title, object.name, object.value, object.identifier);
  const role = firstString(object.type, object.class, object.role);
  const bounds = parseBounds(object);
  if (!label && !role && !bounds) return undefined;
  return {
    id: `el_${index + 1}`,
    source: "node",
    label: truncate(label || role || `元素 ${index + 1}`, 100),
    role,
    bounds,
    normalizedBounds: undefined,
    confidence: label ? 0.86 : 0.58,
    clickable: parseBoolean(object.enabled) !== false && parseBoolean(object.visible) !== false
  };
}

function parseBounds(object: Record<string, unknown>): Bounds | undefined {
  const boundsText = firstString(object.bounds, object.frame);
  if (boundsText) {
    const numbers = [...boundsText.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
    if (numbers.length >= 4) {
      const [x, y, third, fourth] = numbers;
      return {
        x,
        y,
        width: Math.max(0, third > x ? third - x : third),
        height: Math.max(0, fourth > y ? fourth - y : fourth)
      };
    }
  }

  const x = numberValue(object.x);
  const y = numberValue(object.y);
  const width = numberValue(object.width);
  const height = numberValue(object.height);
  if ([x, y, width, height].every((value) => value !== undefined)) {
    return { x: x!, y: y!, width: width!, height: height! };
  }
  return undefined;
}

function parseNodesWithFallback(source: string): ElementRef[] {
  const matches = [...source.matchAll(/<[^>]+>/g)];
  const elements: Array<ElementRef | undefined> = matches.map((match, index) => {
      const tag = match[0];
      const label = firstMatch(tag, /\b(?:label|title|name|value|identifier)="([^"]+)"/i);
      const role = firstMatch(tag, /\b(?:type|class)="([^"]+)"/i);
      const boundsText = firstMatch(tag, /\b(?:bounds|frame)="([^"]+)"/i);
      const bounds = boundsText ? parseBounds({ bounds: boundsText }) : undefined;
      if (!label && !role && !bounds) return undefined;
      return {
        id: `el_${index + 1}`,
        source: "node" as const,
        label: truncate(label || role || `元素 ${index + 1}`, 100),
        role,
        bounds,
        confidence: label ? 0.8 : 0.5,
        clickable: true
      };
    });
  return elements.filter((element): element is ElementRef => element !== undefined);
}

function inferScreenSize(nodes: ElementRef[]): { width: number; height: number } | undefined {
  const edges = nodes
    .map((node) => node.bounds)
    .filter((bounds): bounds is Bounds => Boolean(bounds));
  if (!edges.length) return undefined;

  const rootViewport = edges
    .filter((bounds) => {
      return bounds.x <= 1
        && bounds.y <= 1
        && bounds.width >= 200
        && bounds.height >= 400
        && bounds.width <= 5000
        && bounds.height <= 5000;
    })
    .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
  if (rootViewport) {
    return {
      width: Math.ceil(rootViewport.width),
      height: Math.ceil(rootViewport.height)
    };
  }

  return {
    width: Math.ceil(Math.max(...edges.map((bounds) => bounds.x + bounds.width))),
    height: Math.ceil(Math.max(...edges.map((bounds) => bounds.y + bounds.height)))
  };
}

function parseAppName(activeApp: unknown): string | undefined {
  const data = unwrapActiveApp(activeApp);
  if (data !== activeApp) return parseAppName(data);
  if (!activeApp || typeof activeApp !== "object") return undefined;
  const object = activeApp as Record<string, unknown>;
  return firstString(object.bundleId, object.bundleIdentifier, object.identifier, object.name, object.appName);
}

function parseActiveAppBundle(activeApp: unknown): string | undefined {
  const data = unwrapActiveApp(activeApp);
  if (!data || typeof data !== "object") return undefined;
  const object = data as Record<string, unknown>;
  return firstString(object.bundleId, object.bundleIdentifier, object.identifier, object.name);
}

function unwrapActiveApp(activeApp: unknown): unknown {
  if (!activeApp || typeof activeApp !== "object") return activeApp;
  const object = activeApp as Record<string, unknown>;
  return object.data && typeof object.data === "object" ? object.data : activeApp;
}

function parseSourceRootBundle(source: string): string | undefined {
  const rootTag = source.match(/<XCUIElementTypeApplication\b[^>]*>/)?.[0]
    ?? source.match(/<App\b[^>]*>/)?.[0];
  return rootTag
    ? firstMatch(rootTag, /\bbundleId="([^"]+)"/i) ?? firstMatch(rootTag, /\bidentifier="([^"]+)"/i)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function firstMatch(input: string, regex: RegExp): string | undefined {
  const match = input.match(regex);
  return match?.[1];
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true" || value === "1";
  return undefined;
}

export function syntheticElement(label: string, bounds?: Bounds): ElementRef {
  return {
    id: createId("synthetic"),
    source: "synthetic",
    label,
    bounds,
    confidence: 0.7,
    clickable: Boolean(bounds)
  };
}
