import type { ModelUsePolicy, ParsedIntent, PerceptionFrame, ScreenGraph, TaskMemory, TaskPhase } from "../../shared/types";
import { truncate } from "../utils";
import { detectWechatArticleSurface } from "./wechatArticleSurface";

interface PerceptionContext {
  phase?: TaskPhase;
  noProgressCount?: number;
  memory?: TaskMemory;
  allowArticleContinuation?: boolean;
}

const UNKNOWN_PAGE_CONFIDENCE = 0.38;

export function buildPerceptionFrame(
  intent: ParsedIntent | undefined,
  screen: ScreenGraph,
  context: PerceptionContext = {}
): PerceptionFrame {
  const elements = [...screen.nodes, ...screen.ocrBlocks];
  const visibleTexts = uniqueTexts(elements.map((item) => item.label)).slice(0, 80);
  const clickableTexts = uniqueTexts(elements.filter((item) => item.clickable !== false && item.bounds).map((item) => item.label)).slice(0, 60);
  const inputTexts = uniqueTexts(
    elements
      .filter((item) => /input|text\s*field|textview|search|搜索|输入|XCUIElementTypeTextField|XCUIElementTypeTextView|XCUIElementTypeSearchField/i.test(`${item.role ?? ""} ${item.label}`))
      .map((item) => item.label)
  ).slice(0, 20);
  const dialogTexts = uniqueTexts(screen.dialogs.map((item) => item.label));
  const riskTexts = visibleTexts.filter((text) => /支付|付款|转账|删除|注销|公开发布|发布|确认订单|提交订单|同意|授权|允许/.test(text));
  const pageType = classifyPage(intent, screen, visibleTexts, context);
  const confidence = estimateConfidence(pageType, screen, visibleTexts, inputTexts);

  return {
    screen,
    pageType,
    app: screen.app,
    confidence,
    visibleTexts,
    clickableTexts,
    inputTexts,
    dialogTexts,
    riskTexts,
    hasKeyboard: screen.keyboardVisible,
    sourceQuality: screen.nodes.length >= 18 ? "rich" : screen.nodes.length >= 6 ? "sparse" : "empty",
    visualSummary: undefined,
    visualObservation: undefined
  };
}

export function mergeVisionIntoPerception(frame: PerceptionFrame, vision: { summary?: string; pageType?: string; recommendedObservation?: string }): PerceptionFrame {
  const visualPageType = normalizePageType(vision.pageType);
  return {
    ...frame,
    pageType: visualPageType && frame.pageType === "unknown" ? visualPageType : frame.pageType,
    confidence: visualPageType && frame.pageType === "unknown" ? Math.max(frame.confidence, 0.58) : frame.confidence,
    visualSummary: vision.summary ? truncate(vision.summary, 300) : frame.visualSummary,
    visualObservation: vision.recommendedObservation ? truncate(vision.recommendedObservation, 300) : frame.visualObservation
  };
}

export function modelUsePolicy(
  intent: ParsedIntent | undefined,
  frame: PerceptionFrame,
  context: PerceptionContext = {}
): ModelUsePolicy {
  const noProgressCount = context.noProgressCount ?? 0;
  const isDeterministicWechat = intent?.kind === "wechat_article_summary" || intent?.kind === "wechat_message";
  const unknownOrSparse = frame.pageType === "unknown" || frame.sourceQuality === "empty" || frame.confidence < 0.45;
  const articleUncertain = intent?.kind === "wechat_article_summary"
    && (context.phase === "open_article" || context.phase === "read_article")
    && frame.pageType !== "wechat_article";

  if (!intent || (intent.kind === "generic" && (!intent.targetApp || intent.targetApp === "unknown"))) {
    return {
      useVision: true,
      useLlm: true,
      modelRole: noProgressCount >= 2 ? "recovery" : "route_rank",
      reason: noProgressCount >= 2
        ? "通用任务连续无进展，需要视觉补充和模型恢复建议。"
        : "通用未知任务需要视觉模型补充屏幕理解，并由语言模型选择路线。"
    };
  }

  if (unknownOrSparse || noProgressCount >= 2 || articleUncertain) {
    return {
      useVision: true,
      useLlm: !isDeterministicWechat || noProgressCount >= 2,
      modelRole: noProgressCount >= 2 ? "recovery" : "vision_perception",
      reason: noProgressCount >= 2
        ? "连续无进展，需要视觉补充和模型恢复建议。"
        : "当前屏幕信息不足或页面不确定，需要视觉模型补充结构化感知。"
    };
  }

  if (intent.kind === "generic" || intent.kind === "dianping_food_search") {
    return {
      useVision: false,
      useLlm: true,
      modelRole: "route_rank",
      reason: "通用或大众点评任务需要语言模型辅助路线选择。"
    };
  }

  return {
    useVision: false,
    useLlm: false,
    reason: "当前微信技能路径清晰，使用本地规则执行。"
  };
}

export function perceptionSummary(frame: PerceptionFrame): Record<string, unknown> {
  return {
    pageType: frame.pageType,
    app: frame.app,
    confidence: frame.confidence,
    sourceQuality: frame.sourceQuality,
    hasKeyboard: frame.hasKeyboard,
    visibleTexts: frame.visibleTexts.slice(0, 24),
    clickableTexts: frame.clickableTexts.slice(0, 20),
    inputTexts: frame.inputTexts.slice(0, 8),
    dialogTexts: frame.dialogTexts,
    riskTexts: frame.riskTexts,
    visualSummary: frame.visualSummary,
    visualObservation: frame.visualObservation
  };
}

function classifyPage(intent: ParsedIntent | undefined, screen: ScreenGraph, labels: string[], context: PerceptionContext): string {
  const text = labels.join(" ");
  const app = screen.app ?? "";
  const isWechat = app.includes("com.tencent.xin") || labels.includes("微信") || text.includes("微信");
  if (isWechat) {
    const account = intent?.source?.name ?? intent?.topic ?? "";
    if (account && detectWechatArticleSurface(screen, account, Boolean(context.allowArticleContinuation)).ok) return "wechat_article";
    if (/标签页栏/.test(text) && /微信/.test(text) && /通讯录/.test(text) && /发现/.test(text)) return "wechat_home";
    if (/通讯录/.test(text) && /新的朋友|群聊|标签|公众号/.test(text)) return "wechat_contacts";
    if (/公众号/.test(text) && /公众号列表|新的公众号|服务号|订阅号/.test(text)) return "wechat_official_accounts";
    if (/搜索/.test(text) && (screen.keyboardVisible || /网络结果|最近在搜|大家都在搜|相关搜索/.test(text))) return "wechat_search";
    if (/按住说话|语音输入|表情|发送|XCUIElementTypeTextView/.test(text) && !/标签页栏/.test(text)) return "wechat_chat";
    if (account && text.includes(account) && /发消息|私信|关注|服务|全部文章|视频号/.test(text)) return "wechat_account_home";
    return "wechat_unknown";
  }

  if (app.includes("com.dianping") || /大众点评|点评|美食|附近|餐厅|搜索/.test(text)) {
    if (/搜索|请输入|想吃什么|找商户/.test(text)) return "dianping_search";
    if (/人均|评分|地址|推荐|团购|榜单/.test(text)) return "dianping_results";
    return "dianping_home";
  }

  if (/主屏幕|搜索|设置|App资源库/.test(text)) return "phone_home";
  return "unknown";
}

function estimateConfidence(pageType: string, screen: ScreenGraph, labels: string[], inputTexts: string[]): number {
  if (pageType === "unknown") return UNKNOWN_PAGE_CONFIDENCE;
  let score = 0.5;
  if (screen.nodes.length >= 18) score += 0.18;
  if (screen.ocrBlocks.length > 0) score += 0.08;
  if (labels.length >= 8) score += 0.08;
  if (inputTexts.length > 0) score += 0.04;
  if (pageType.endsWith("_unknown")) score -= 0.12;
  return Math.max(0.35, Math.min(0.92, score));
}

function uniqueTexts(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = value.replace(/\s+/g, " ").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function normalizePageType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
  if (!normalized || normalized === "unknown") return undefined;
  return normalized.slice(0, 60);
}
