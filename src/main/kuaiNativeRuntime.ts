import { randomUUID } from "node:crypto";
import type { AgentAction, DeviceRecord, NativeCapabilities, NativeFastPath, RuntimeActionResult } from "../shared/types";
import { now, redactSecrets, safeError, truncate } from "./utils";

const RESULT_PREFIX = "PHONE_AGENT_NATIVE_RESULT ";

export interface NativeProbeResult {
  ok: boolean;
  fastPath: NativeFastPath;
  capabilities: NativeCapabilities;
  message: string;
  rawLog?: string;
}

export class KuaiNativeRuntimeError extends Error {
  constructor(
    message: string,
    readonly rawLog?: string
  ) {
    super(message);
    this.name = "KuaiNativeRuntimeError";
  }
}

export class KuaiNativeRuntime {
  private probeCache = new Map<string, Promise<NativeProbeResult>>();

  async probe(device: DeviceRecord, projectRuntimeReady = false, force = false): Promise<NativeProbeResult> {
    const key = `${device.host}:${device.port}:${projectRuntimeReady}`;
    if (!force && this.probeCache.has(key)) return this.probeCache.get(key)!;
    const promise = this.probeInternal(device, projectRuntimeReady).catch((error) => {
      this.probeCache.delete(key);
      throw error;
    });
    this.probeCache.set(key, promise);
    return promise;
  }

  async execute(device: DeviceRecord, action: AgentAction): Promise<RuntimeActionResult> {
    if (!canNativeExecute(action)) {
      throw new KuaiNativeRuntimeError(`Unsupported native action: ${action.type}`);
    }

    const probe = await this.probe(device);
    if (probe.fastPath !== "runScript") {
      throw new KuaiNativeRuntimeError(probe.message, probe.rawLog);
    }

    const commandId = `native_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const script = buildNativeRuntimeScript(commandId, normalizeNativeAction(action));
    const startedAt = Date.now();
    const raw = await this.requestRunScript(device, script, timeoutForAction(action));
    const totalMs = Date.now() - startedAt;
    const result = parseNativeResult(raw);
    if (!result) {
      throw new KuaiNativeRuntimeError("KuaiJS native runScript completed without PHONE_AGENT_NATIVE_RESULT.", raw);
    }
    result.backend = "kuaijs-native";
    result.nativeFastPath = "runScript";
    result.rawLog = redactAndLimit(raw);
    result.timing = { ...(result.timing ?? {}), totalMs };
    if (!result.ok) {
      throw new KuaiNativeRuntimeError(result.message || "KuaiJS native action failed.", result.rawLog);
    }
    return result;
  }

  private async probeInternal(device: DeviceRecord, projectRuntimeReady: boolean): Promise<NativeProbeResult> {
    const fallback = emptyCapabilities(projectRuntimeReady, "runScript probe has not run.");
    try {
      const raw = await this.requestRunScript(device, buildNativeProbeScript(), 5000);
      const parsed = parseNativeResult(raw);
      const data = parsed?.data && typeof parsed.data === "object" ? parsed.data as Record<string, unknown> : undefined;
      const capabilityData = data?.capabilities && typeof data.capabilities === "object"
        ? data.capabilities as Record<string, unknown>
        : {};
      const capabilities: NativeCapabilities = {
        ...fallback,
        runScript: Boolean(parsed?.ok),
        worker: false,
        projectRuntime: projectRuntimeReady,
        wsServer: false,
        nodeSelector: Boolean(capabilityData.nodeSelector),
        hidUsb: Boolean(capabilityData.hidUsb),
        hidBle: Boolean(capabilityData.hidBle),
        ime: Boolean(capabilityData.ime),
        appleOcr: Boolean(capabilityData.appleOcr),
        paddleOcr: Boolean(capabilityData.paddleOcr),
        image: Boolean(capabilityData.image),
        system: Boolean(capabilityData.system),
        checkedAt: now(),
        message: parsed?.message ?? "runScript native probe completed."
      };
      return {
        ok: capabilities.runScript,
        fastPath: capabilities.runScript ? "runScript" : projectRuntimeReady ? "project" : "none",
        capabilities,
        message: capabilities.runScript
          ? "KuaiJS runScript native fast path is available."
          : projectRuntimeReady
            ? "runScript is unavailable; project runtime fallback is available."
            : "runScript and project runtime are unavailable.",
        rawLog: redactAndLimit(raw)
      };
    } catch (error) {
      const message = `runScript native probe failed: ${safeError(error)}`;
      return {
        ok: projectRuntimeReady,
        fastPath: projectRuntimeReady ? "project" : "none",
        capabilities: emptyCapabilities(projectRuntimeReady, message),
        message: projectRuntimeReady
          ? `${message}; using project runtime fallback.`
          : message,
        rawLog: error instanceof KuaiNativeRuntimeError ? error.rawLog : undefined
      };
    }
  }

  private async requestRunScript(device: DeviceRecord, script: string, timeoutMs: number): Promise<string> {
    const host = device.runtimeTargetHost ?? device.host;
    const port = device.runtimeTargetPort ?? device.port;
    const response = await fetch(`http://${host}:${port}/api/runScript`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ script }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      throw new KuaiNativeRuntimeError(`runScript failed: ${response.status} ${response.statusText}`, text);
    }
    return text;
  }
}

export function parseNativeResult(rawLog: string): RuntimeActionResult | undefined {
  const candidates = collectCandidateStrings(rawLog);
  for (const candidate of candidates.reverse()) {
    const match = candidate.match(/PHONE_AGENT_NATIVE_RESULT\s+({[^\r\n]+})/);
    if (!match) continue;
    const parsed = parseJsonObject(match[1]);
    if (parsed) return normalizeNativeResult(parsed, rawLog);
  }
  const parsed = parseJsonObject(rawLog);
  const embedded = findEmbeddedResult(parsed);
  return embedded ? normalizeNativeResult(embedded, rawLog) : undefined;
}

export function buildNativeProbeScript(): string {
  return `(${nativeScriptShared()}
function main() {
  const caps = {
    nodeSelector: typeof createNodeSelector === "function",
    hidUsb: boolCall(function () { return typeof hid !== "undefined" && hid.isUSBConnected && hid.isUSBConnected(); }),
    hidBle: boolCall(function () { return typeof hid !== "undefined" && hid.isBLEConnected && hid.isBLEConnected(); }),
    ime: boolCall(function () { return typeof ime !== "undefined" && ime.isOk && ime.isOk(); }),
    appleOcr: typeof appleOcr !== "undefined" && !!appleOcr.recognize,
    paddleOcr: typeof paddleOcr !== "undefined" && !!paddleOcr.recognize,
    image: typeof image !== "undefined" && !!image.captureScreen,
    system: typeof system !== "undefined" && !!system.activateApp
  };
  return emitNativeResult({ ok: true, message: "native probe ok", data: { capabilities: caps, activeApp: currentAppBundleId() } });
}
return main();
})()`;
}

export function buildNativeRuntimeScript(commandId: string, action: AgentAction): string {
  const payload = JSON.stringify({ commandId, action });
  return `(${nativeScriptShared()}
const PHONE_AGENT_NATIVE_COMMAND = ${payload};

function performAction(actionSpec) {
  const a = actionSpec || {};
  if (a.type === "home") return homeScreen();
  if (a.type === "back") return back();
  if (a.type === "tap_xy") return tapXY(Number(a.x), Number(a.y));
  if (a.type === "tap_text") return tapText(String(a.text || ""));
  if (a.type === "swipe") return swipeXY(Number(a.startX), Number(a.startY), Number(a.endX), Number(a.endY), Number(a.duration || 350));
  if (a.type === "input" || a.type === "input_atomic") return inputAtomic(String(a.text || ""));
  if (a.type === "open_app") return openAppAndWait(String(a.bundleId || ""), String(a.displayName || ""));
  if (a.type === "open_url") return openUrl(String(a.url || ""));
  if (a.type === "collect_scroll") return scrollUntilStable(String(a.direction || "down"), Number(a.maxScrolls || 1), Number(a.stableThreshold || 99), false);
  if (a.type === "scroll_until_stable") return scrollUntilStable(String(a.direction || "down"), Number(a.maxScrolls || 8), Number(a.stableThreshold || 3), false);
  if (a.type === "read_wechat_article_native") return readWechatArticle(String(a.account || ""), String(a.direction || "down"), Number(a.maxScrolls || 18), Number(a.stableThreshold || 3));
  return { ok: false, message: "unsupported native action " + String(a.type) };
}

function main() {
  const startedAt = Date.now();
  try {
    const result = performAction(PHONE_AGENT_NATIVE_COMMAND.action);
    result.observedAfter = currentAppBundleId();
    result.timing = Object.assign({}, result.timing || {}, { scriptMs: Date.now() - startedAt });
    return emitNativeResult(result);
  } catch (error) {
    return emitNativeResult({ ok: false, message: nativeError(error), timing: { scriptMs: Date.now() - startedAt } });
  }
}
return main();
})()`;
}

function nativeScriptShared(): string {
  return `function () {
const RESULT_PREFIX = ${JSON.stringify(RESULT_PREFIX)};

function nativeLog(line) {
  try { if (typeof logi === "function") { logi(line); return; } } catch (error) {}
  try { console.log(line); } catch (error) {}
}

function nativeError(error) {
  if (!error) return "unknown error";
  if (typeof error === "string") return error;
  if (error.message) return String(error.message);
  try { return JSON.stringify(error); } catch (jsonError) { return String(error); }
}

function emitNativeResult(result) {
  const payload = {
    commandId: typeof PHONE_AGENT_NATIVE_COMMAND !== "undefined" ? PHONE_AGENT_NATIVE_COMMAND.commandId : "native_probe",
    ok: Boolean(result.ok),
    backend: "kuaijs-native",
    nativeFastPath: "runScript",
    message: String(result.message || ""),
    observedAfter: result.observedAfter ? String(result.observedAfter) : undefined,
    data: result.data,
    timing: result.timing
  };
  const line = RESULT_PREFIX + JSON.stringify(payload);
  nativeLog(line);
  return line;
}

function boolCall(fn) {
  try { return Boolean(fn()); } catch (error) { return false; }
}

function delay(ms) {
  try { if (typeof sleep === "function") sleep(ms); } catch (error) {}
}

function tryCall(label, fn) {
  try {
    const value = fn();
    const ok = value !== false && value !== null && value !== undefined && value !== "";
    return { ok: ok, message: ok ? label : label + " returned " + String(value), value: value };
  } catch (error) {
    return { ok: false, message: label + " failed: " + nativeError(error) };
  }
}

function firstSuccessful(calls) {
  let last = { ok: false, message: "no native method was available" };
  for (let i = 0; i < calls.length; i += 1) {
    last = calls[i]();
    if (last.ok) return last;
  }
  return last;
}

function anySuccessful(calls) {
  let ok = false;
  const messages = [];
  for (let i = 0; i < calls.length; i += 1) {
    const result = calls[i]();
    messages.push(result.message);
    ok = ok || result.ok;
    delay(80);
  }
  return { ok: ok, message: messages.filter(Boolean).join("; ") || "no native method was available" };
}

function currentAppBundleId() {
  try {
    if (typeof system !== "undefined" && system.activateAppInfo) {
      const info = system.activateAppInfo();
      if (info) return String(info.bundleId || info.bundleIdentifier || info.name || "");
    }
  } catch (error) {}
  try {
    if (typeof hid !== "undefined" && hid.currentAppInfo) {
      const info = hid.currentAppInfo();
      if (info) return String(info.bundleId || info.bundleIdentifier || info.name || "");
    }
  } catch (error) {}
  return "";
}

function homeScreen() {
  return anySuccessful([
    function () { return typeof system !== "undefined" && system.activateApp ? tryCall("system.activateApp(springboard)", function () { return system.activateApp("com.apple.springboard"); }) : { ok: false, message: "system.activateApp unavailable" }; },
    function () { return typeof hid !== "undefined" && hid.homeScreen ? tryCall("hid.homeScreen", function () { return hid.homeScreen(); }) : { ok: false, message: "hid.homeScreen unavailable" }; },
    function () { return typeof action !== "undefined" && action.homeScreen ? tryCall("action.homeScreen", function () { return action.homeScreen(); }) : { ok: false, message: "action.homeScreen unavailable" }; },
    function () { return typeof hid !== "undefined" && hid.pressButton ? tryCall("hid.pressButton(home)", function () { return hid.pressButton("home"); }) : { ok: false, message: "hid.pressButton unavailable" }; }
  ]);
}

function back() {
  return firstSuccessful([
    function () { return typeof hid !== "undefined" && hid.back ? tryCall("hid.back", function () { return hid.back(); }) : { ok: false, message: "hid.back unavailable" }; }
  ]);
}

function tapXY(x, y) {
  x = Math.round(x);
  y = Math.round(y);
  return firstSuccessful([
    function () { return typeof action !== "undefined" && action.click ? tryCall("action.click", function () { return action.click(x, y, 30, true); }) : { ok: false, message: "action.click unavailable" }; },
    function () { return typeof hid !== "undefined" && hid.click ? tryCall("hid.click", function () { return hid.click(x, y, 30, true); }) : { ok: false, message: "hid.click unavailable" }; }
  ]);
}

function swipeXY(startX, startY, endX, endY, duration) {
  const sx = Math.round(startX);
  const sy = Math.round(startY);
  const ex = Math.round(endX);
  const ey = Math.round(endY);
  const ms = Math.round(duration || 350);
  return firstSuccessful([
    function () { return typeof action !== "undefined" && action.swipe ? tryCall("action.swipe", function () { return action.swipe(sx, sy, ex, ey, ms, true, 8); }) : { ok: false, message: "action.swipe unavailable" }; },
    function () { return typeof hid !== "undefined" && hid.swipe ? tryCall("hid.swipe", function () { return hid.swipe(sx, sy, ex, ey, true, 8); }) : { ok: false, message: "hid.swipe unavailable" }; }
  ]);
}

function openAppAndWait(bundleId, displayName) {
  const result = firstSuccessful([
    function () { return typeof system !== "undefined" && system.activateApp && bundleId ? tryCall("system.activateApp", function () { return system.activateApp(bundleId); }) : { ok: false, message: "system.activateApp unavailable" }; },
    function () { return typeof system !== "undefined" && system.startApp && bundleId ? tryCall("system.startApp", function () { return system.startApp(bundleId); }) : { ok: false, message: "system.startApp unavailable" }; },
    function () { return typeof hid !== "undefined" && hid.openApp && displayName ? tryCall("hid.openApp(displayName)", function () { return hid.openApp(displayName); }) : { ok: false, message: "hid.openApp(displayName) unavailable" }; },
    function () { return typeof hid !== "undefined" && hid.openApp && bundleId ? tryCall("hid.openApp(bundleId)", function () { return hid.openApp(bundleId); }) : { ok: false, message: "hid.openApp(bundleId) unavailable" }; }
  ]);
  if (!result.ok || !bundleId) return result;
  let active = currentAppBundleId();
  for (let i = 0; i < 12 && active !== bundleId; i += 1) {
    delay(400);
    active = currentAppBundleId();
  }
  return { ok: active === bundleId || result.ok, message: result.message + "; active=" + active, observedAfter: active };
}

function openUrl(url) {
  return firstSuccessful([
    function () { return typeof system !== "undefined" && system.openURL ? tryCall("system.openURL", function () { return system.openURL(url); }) : { ok: false, message: "system.openURL unavailable" }; },
    function () { return typeof hid !== "undefined" && hid.openURL ? tryCall("hid.openURL", function () { return hid.openURL(url); }) : { ok: false, message: "hid.openURL unavailable" }; }
  ]);
}

function clearFocusedText() {
  try { if (typeof ime !== "undefined" && ime.clearText) { ime.clearText(); delay(120); } } catch (error) {}
  try {
    if (typeof hid !== "undefined" && hid.sendKey && typeof hidKey !== "undefined" && hidKey.COMMAND) {
      hid.sendKey([hidKey.COMMAND, "a"]);
      delay(120);
      if (hid.backspace) hid.backspace();
      delay(120);
    }
  } catch (error) {}
}

function inputAtomic(text) {
  const imePaste = function () {
    if (typeof ime === "undefined" || !ime.paste) return { ok: false, message: "ime.paste unavailable" };
    return tryCall("ime.paste", function () {
      if (ime.autoSwitchApiKeyboard) ime.autoSwitchApiKeyboard();
      clearFocusedText();
      const pasted = ime.paste(text);
      const current = ime.getText ? ime.getText() : pasted;
      return String(current || pasted || "").indexOf(text) >= 0 ? current || pasted : false;
    });
  };
  const hidPaste = function () {
    if (typeof hid === "undefined" || !hid.setClipboard || !hid.pasteText) return { ok: false, message: "hid clipboard unavailable" };
    return tryCall("hid.clipboardPaste", function () {
      clearFocusedText();
      return hid.setClipboard(text) && hid.pasteText();
    });
  };
  const imeInput = function () {
    if (typeof ime === "undefined" || !ime.input) return { ok: false, message: "ime.input unavailable" };
    return tryCall("ime.input", function () {
      if (ime.autoSwitchApiKeyboard) ime.autoSwitchApiKeyboard();
      clearFocusedText();
      const current = ime.input(text);
      return String(current || "").indexOf(text) >= 0 ? current : false;
    });
  };
  const actionInput = function () {
    if (typeof action === "undefined" || !action.input) return { ok: false, message: "action.input unavailable" };
    return tryCall("action.input", function () { clearFocusedText(); return action.input(text); });
  };
  const hidInput = function () {
    if (typeof hid === "undefined" || !hid.input) return { ok: false, message: "hid.input unavailable" };
    return tryCall("hid.input", function () { clearFocusedText(); return hid.input(text); });
  };
  return firstSuccessful(text.length >= 40 ? [imePaste, hidPaste, imeInput, actionInput, hidInput] : [imeInput, imePaste, actionInput, hidInput, hidPaste]);
}

function regexEscape(text) {
  const specials = "\\\\^$.*+?()[]{}|";
  return String(text).split("").map(function (char) {
    return specials.indexOf(char) >= 0 ? "\\\\" + char : char;
  }).join("");
}

function nodeText(node) {
  if (!node) return "";
  return [node.label, node.title, node.value, node.placeholderValue, node.identifier].filter(Boolean).map(String).join(" ");
}

function queryOne(method, value, timeout) {
  if (typeof createNodeSelector !== "function") return null;
  const selector = createNodeSelector({ maxDepth: 30 });
  try {
    if (!selector || !selector[method]) return null;
    return selector[method](value).visible(true).enabled(true).getOneNodeInfo(timeout || 900);
  } catch (error) {
    return null;
  } finally {
    try { if (selector && selector.releaseNode) selector.releaseNode(); } catch (error) {}
  }
}

function findNodeByText(text) {
  const exactMethods = ["label", "title", "value", "placeholderValue"];
  for (let i = 0; i < exactMethods.length; i += 1) {
    const node = queryOne(exactMethods[i], text, 700);
    if (node) return node;
  }
  const pattern = ".*" + regexEscape(text) + ".*";
  const matchMethods = ["labelMatch", "titleMatch", "valueMatch", "placeholderValueMatch"];
  for (let i = 0; i < matchMethods.length; i += 1) {
    const node = queryOne(matchMethods[i], pattern, 900);
    if (node) return node;
  }
  return null;
}

function tapText(text) {
  const node = findNodeByText(text);
  if (node) {
    const clicked = firstSuccessful([
      function () { return node.clickCenter ? tryCall("node.clickCenter", function () { return node.clickCenter(); }) : { ok: false, message: "node.clickCenter unavailable" }; },
      function () { return node.clickRandom ? tryCall("node.clickRandom", function () { return node.clickRandom(); }) : { ok: false, message: "node.clickRandom unavailable" }; },
      function () { return node.bounds ? tapXY(node.bounds.centerX || (node.bounds.x + node.bounds.width / 2), node.bounds.centerY || (node.bounds.y + node.bounds.height / 2)) : { ok: false, message: "node bounds unavailable" }; }
    ]);
    clicked.data = { matchedText: nodeText(node).slice(0, 120), method: "node" };
    return clicked;
  }
  const ocrPoint = findOcrTextPoint(text);
  if (ocrPoint) {
    const result = tapXY(ocrPoint.x, ocrPoint.y);
    result.data = { matchedText: text, method: "ocr" };
    return result;
  }
  return { ok: false, message: "text not found: " + text };
}

function findOcrTextPoint(text) {
  try {
    if (typeof appleOcr !== "undefined" && appleOcr.findText) {
      const found = appleOcr.findText("screen", [text], 0, 0, 0, 0, ["zh-Hans", "en-US"]);
      if (found && found[0]) return { x: found[0].centerX, y: found[0].centerY };
    }
  } catch (error) {}
  try {
    if (typeof paddleOcr !== "undefined" && paddleOcr.findText) {
      const found = paddleOcr.findText("screen", [text], 0, 0, 0, 0, 0.6);
      if (found && found[0]) return { x: found[0].centerX, y: found[0].centerY };
    }
  } catch (error) {}
  return null;
}

function getXml(maxDepth) {
  if (typeof createNodeSelector !== "function") return "";
  const selector = createNodeSelector({ maxDepth: maxDepth || 30 });
  try {
    return String(selector.xml ? selector.xml(1200) || "" : "");
  } catch (error) {
    return "";
  } finally {
    try { if (selector && selector.releaseNode) selector.releaseNode(); } catch (error) {}
  }
}

function hashString(input) {
  let hash = 2166136261;
  const text = String(input || "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function visualSignature() {
  if (typeof image === "undefined" || !image.captureScreen || !image.pixel) return "";
  let img = null;
  try {
    img = image.captureScreen();
    if (!img) return "";
    const size = image.getSize ? image.getSize(img) : null;
    const w = size && size.width ? size.width : 1170;
    const h = size && size.height ? size.height : 2532;
    const samples = [];
    for (let y = 0; y < 6; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        const px = Math.max(1, Math.round((x + 0.5) * w / 4));
        const py = Math.max(1, Math.round((y + 0.5) * h / 6));
        samples.push(String(image.pixel(img, px, py)));
      }
    }
    return hashString(samples.join("|"));
  } catch (error) {
    return "";
  } finally {
    try { if (img && image.release) image.release(img); } catch (error) {}
  }
}

function pageSignature() {
  return hashString(getXml(30)) + ":" + visualSignature();
}

function scrollOnce(direction) {
  const down = direction !== "up";
  return down
    ? swipeXY(500, 820, 500, 260, 420)
    : swipeXY(500, 260, 500, 820, 420);
}

function scrollUntilStable(direction, maxScrolls, stableThreshold, collectLines) {
  const limit = Math.max(1, Math.min(40, maxScrolls || 8));
  const threshold = Math.max(1, Math.min(8, stableThreshold || 3));
  let unchanged = 0;
  let previous = pageSignature();
  const lines = collectLines ? extractReadableLines() : [];
  let ok = true;
  let message = "scroll completed";
  let scrolls = 0;
  for (let i = 0; i < limit; i += 1) {
    const result = scrollOnce(direction);
    ok = ok && result.ok;
    message = result.message;
    scrolls += 1;
    delay(650);
    if (collectLines) appendUnique(lines, extractReadableLines());
    const current = pageSignature();
    unchanged = current === previous ? unchanged + 1 : 0;
    previous = current;
    if (!result.ok || unchanged >= threshold) break;
  }
  return { ok: ok, message: message + "; scrolls=" + scrolls + "; unchanged=" + unchanged, data: { scrolls: scrolls, unchangedScrollCount: unchanged, stableThreshold: threshold, lines: lines } };
}

function decodeXmlText(text) {
  return String(text || "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function extractReadableLines() {
  const xml = getXml(80);
  const lines = [];
  const regex = /\\b(?:label|value|title)="([^"]{4,})"/g;
  let match;
  while ((match = regex.exec(xml))) {
    const line = decodeXmlText(match[1]).replace(/\\s+/g, " ").trim();
    if (isReadableArticleLine(line)) appendUnique(lines, [line]);
  }
  try {
    if (typeof appleOcr !== "undefined" && appleOcr.recognize) {
      const blocks = appleOcr.recognize("screen", 0, 0, 0, 0, ["zh-Hans", "en-US"]) || [];
      for (let i = 0; i < blocks.length; i += 1) {
        const line = String(blocks[i].text || "").replace(/\\s+/g, " ").trim();
        if (isReadableArticleLine(line)) appendUnique(lines, [line]);
      }
    }
  } catch (error) {}
  return lines;
}

function isReadableArticleLine(line) {
  if (!line || line.length < 6) return false;
  if (/^(返回|关闭|更多|发送消息|发消息|关注|已关注|取消|搜索|微信|通讯录|发现|我|赞|在看|留言|阅读原文)$/.test(line)) return false;
  if (/^(\\d{1,2}:\\d{2}|\\d+分钟前|\\d+小时前)$/.test(line)) return false;
  return /[\\u4e00-\\u9fffA-Za-z]/.test(line);
}

function appendUnique(target, lines) {
  for (let i = 0; i < lines.length; i += 1) {
    if (target.indexOf(lines[i]) < 0) target.push(lines[i]);
  }
}

function readWechatArticle(account, direction, maxScrolls, stableThreshold) {
  const startedAt = Date.now();
  const firstLines = extractReadableLines();
  const scroll = scrollUntilStable(direction || "down", maxScrolls || 18, stableThreshold || 3, true);
  const lines = firstLines.slice();
  appendUnique(lines, scroll.data && scroll.data.lines ? scroll.data.lines : []);
  if (lines.length < 6 && direction !== "up") {
    const reverse = scrollUntilStable("up", Math.min(8, maxScrolls || 8), stableThreshold || 3, true);
    appendUnique(lines, reverse.data && reverse.data.lines ? reverse.data.lines : []);
  }
  const title = guessArticleTitle(lines, account);
  return {
    ok: lines.length > 0,
    message: "native article read collected " + lines.length + " lines",
    data: {
      account: account,
      title: title,
      lines: lines.slice(0, 220),
      direction: direction,
      screenCount: scroll.data ? scroll.data.scrolls + 1 : 1,
      unchangedScrollCount: scroll.data ? scroll.data.unchangedScrollCount : 0
    },
    timing: { readMs: Date.now() - startedAt }
  };
}

function guessArticleTitle(lines, account) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line !== account && line.length >= 8 && line.length <= 80) return line;
  }
  return lines[0] || "最新文章";
}
`;
}

function collectCandidateStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") {
    output.push(value);
    const parsed = parseJsonObject(value);
    if (parsed) collectCandidateStrings(parsed, output);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCandidateStrings(item, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectCandidateStrings(item, output);
  }
  return output;
}

function findEmbeddedResult(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  if (typeof object.commandId === "string" && typeof object.ok === "boolean") return object;
  for (const item of Object.values(object)) {
    const found = findEmbeddedResult(item);
    if (found) return found;
  }
  return undefined;
}

function normalizeNativeResult(parsed: Record<string, unknown>, rawLog: string): RuntimeActionResult | undefined {
  if (typeof parsed.commandId !== "string" || typeof parsed.ok !== "boolean") return undefined;
  return {
    commandId: parsed.commandId,
    ok: parsed.ok,
    backend: "kuaijs-native",
    message: typeof parsed.message === "string" ? parsed.message : "",
    nativeFastPath: parsed.nativeFastPath === "runScript" ? "runScript" : undefined,
    rawLog: redactAndLimit(rawLog),
    observedAfter: typeof parsed.observedAfter === "string" ? parsed.observedAfter : undefined,
    data: parsed.data,
    timing: parsed.timing && typeof parsed.timing === "object" ? parsed.timing as Record<string, number> : undefined
  };
}

function parseJsonObject(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "string") return undefined;
  const trimmed = input.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function emptyCapabilities(projectRuntimeReady: boolean, message: string): NativeCapabilities {
  return {
    runScript: false,
    worker: false,
    projectRuntime: projectRuntimeReady,
    wsServer: false,
    nodeSelector: false,
    hidUsb: false,
    hidBle: false,
    ime: false,
    appleOcr: false,
    paddleOcr: false,
    image: false,
    system: false,
    checkedAt: now(),
    message
  };
}

function canNativeExecute(action: AgentAction): boolean {
  return [
    "tap_xy",
    "tap_text",
    "swipe",
    "input",
    "input_atomic",
    "open_app",
    "open_url",
    "back",
    "home",
    "collect_scroll",
    "scroll_until_stable",
    "read_wechat_article_native"
  ].includes(action.type);
}

function normalizeNativeAction(action: AgentAction): AgentAction {
  if (action.type === "input") return { type: "input_atomic", text: action.text };
  return action;
}

function timeoutForAction(action: AgentAction): number {
  if (action.type === "read_wechat_article_native") return 90000;
  if (action.type === "scroll_until_stable") return 45000;
  if (action.type === "collect_scroll") return Math.max(12000, action.maxScrolls * 3000);
  if (action.type === "input" || action.type === "input_atomic") return 25000;
  return 14000;
}

function redactAndLimit(raw: string, max = 16000): string {
  return truncate(redactSecrets(raw), max);
}
