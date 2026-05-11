import { EventEmitter } from "node:events";
import type { LocalOcrProvider } from "../localOcr";
import { WindowsLocalOcrProvider } from "../localOcr";
import type {
  ActionPreview,
  AgentAction,
  AgentSnapshot,
  AppSettings,
  ConfirmationRequest,
  DeviceRecord,
  DiagnosticEvent,
  DecisionTrace,
  ElementRef,
  ExperienceState,
  ModelUsePolicy,
  ParsedIntent,
  ScreenGraph,
  TaskMemory,
  TaskPhase,
  TaskRequest,
  VerificationResult,
  VisionScreenResult,
  TimelineEvent
} from "../../shared/types";
import { KuaijsClient, KuaijsRequestError } from "../kuaijsClient";
import { KuaiProjectRuntimeError } from "../kuaijsProjectRuntime";
import { LlmClient, LlmRequestError } from "../llmClient";
import { VisionClient, type VisionMode } from "../visionClient";
import { buildScreenGraph, elementCenter, findElement } from "../screenGraph";
import { createId, now, safeError, sleep, truncate } from "../utils";
import { parseIntent } from "./intent";
import { fallbackPlan, PlannerOutput } from "./planner";
import { assessRisk } from "./riskPolicy";
import {
  detectWechatArticleSurface,
  type WechatArticleText
} from "./wechatArticleSurface";
import {
  composeMultiArticleDigestMessage,
  createArticleListScanState,
  isArticleListScanComplete,
  updateArticleListScanState,
  type ArticleDigest,
  type ArticleListItem,
  type MultiArticleDigestState
} from "./multiArticleDigest";
import { ControlRouter } from "../controlRouter";
import {
  DecisionEngine,
  ModelDecisionOutput,
  createTaskMemory,
  decisionSystemPrompt,
  decisionUserPrompt,
  rememberDecision
} from "./decisionEngine";
import {
  buildPerceptionFrame,
  mergeVisionIntoPerception,
  modelUsePolicy,
  perceptionSummary
} from "./perception";
import {
  appendArticleCaptureFrame,
  createArticleCaptureState,
  orderedArticleCaptureFrames,
  type ArticleCaptureState,
  type ArticleCaptureUpdate
} from "./articleCapture";

export { detectWechatArticleSurface, extractWechatArticleText } from "./wechatArticleSurface";

interface RuntimeDeps {
  getSettings: () => AppSettings;
  getDevice: (deviceId: string) => DeviceRecord | undefined;
  kuaijs: KuaijsClient;
  control: ControlRouter;
  llm: LlmClient;
  vision?: VisionClient;
  localOcr?: LocalOcrProvider;
  diagnostics?: (event: Omit<DiagnosticEvent, "id" | "timestamp">) => void;
}

export interface ArticleReadState {
  account: string;
  title: string;
  lines: string[];
  seenLines: Set<string>;
  screenCount: number;
  stableCount: number;
  lastScreenSignature?: string;
  lastContentSignature?: string;
  lastVisualSignature?: string;
  unchangedScrollCount: number;
  reachedEnd: boolean;
  reachedStart: boolean;
  direction: "down" | "up";
  reverseAttempted: boolean;
}

export interface ArticleSummaryModelOutput {
  title?: string;
  summary?: string;
  keyPoints?: string[];
  message?: string;
}

export interface ArticleForSummary {
  title: string;
  lines: string[];
}

export interface PreprocessedArticleForSummary extends ArticleForSummary {
  originalLineCount: number;
  normalizedLineCount: number;
  promptLineCount: number;
  droppedLineCount: number;
  promptCharCount: number;
}

type RuntimeEventMap = {
  changed: [AgentSnapshot];
};

const ARTICLE_MIN_LINES_FOR_SUMMARY = 6;
const ARTICLE_SUMMARY_PROMPT_LINE_BUDGET = 56;
const ARTICLE_SUMMARY_PROMPT_CHAR_BUDGET = 5200;
const ARTICLE_MIN_SCREENS_BEFORE_SUMMARY = 6;
const ARTICLE_STABLE_SCREENS_TO_ASSUME_END = 3;
const ARTICLE_MAX_SCREENS = 22;
const ARTICLE_MAX_REVERSE_SCREENS = 16;
const DEFAULT_MAX_AGENT_STEPS = 28;
const WECHAT_ARTICLE_MAX_AGENT_STEPS = 56;
const DIANPING_MAX_AGENT_STEPS = 36;
const MAX_VISION_CALLS_PER_TASK = 4;

export class AgentRuntime extends EventEmitter<RuntimeEventMap> {
  private snapshot: AgentSnapshot = {
    state: "idle",
    timeline: []
  };

  private currentIntent?: ParsedIntent;
  private currentRequest?: TaskRequest;
  private stopped = false;
  private paused = false;
  private takeover = false;
  private running = false;
  private articleReadState?: ArticleReadState;
  private articleCaptureState?: ArticleCaptureState;
  private multiArticleDigestState?: MultiArticleDigestState;
  private currentPhase?: TaskPhase;
  private currentRoute?: string;
  private noProgressCount = 0;
  private lastProgressKey?: string;
  private lastLoopScreenSignature?: string;
  private taskMemory: TaskMemory = createTaskMemory();
  private visionRequestsThisTask = 0;
  private lastVisionSignature?: string;
  private lastVisionResult?: VisionScreenResult;
  private readonly decisionEngine = new DecisionEngine();
  private readonly localOcr: LocalOcrProvider;

  constructor(private readonly deps: RuntimeDeps) {
    super();
    this.localOcr = deps.localOcr ?? new WindowsLocalOcrProvider();
  }

  getSnapshot(): AgentSnapshot {
    return structuredClone(this.snapshot);
  }

  async start(request: TaskRequest): Promise<AgentSnapshot> {
    if (this.running) {
      await this.stop();
    }
    this.stopped = false;
    this.paused = false;
    this.takeover = false;
    this.running = true;
    this.articleReadState = undefined;
    this.articleCaptureState = undefined;
    this.multiArticleDigestState = undefined;
    this.currentRequest = request;
    this.currentIntent = parseIntent(request.instruction);
    this.currentPhase = initialPhaseForIntent(this.currentIntent);
    this.currentRoute = undefined;
    this.noProgressCount = 0;
    this.lastProgressKey = undefined;
    this.lastLoopScreenSignature = undefined;
    this.taskMemory = createTaskMemory();
    this.visionRequestsThisTask = 0;
    this.lastVisionSignature = undefined;
    this.lastVisionResult = undefined;
    this.snapshot = {
      taskId: createId("task"),
      state: "observing",
      phase: this.currentPhase,
      noProgressCount: this.noProgressCount,
      instruction: request.instruction,
      timeline: []
    };
    this.addEvent("observing", "开始理解任务", `收到指令：${request.instruction}`, "running");
    void this.runLoop();
    return this.getSnapshot();
  }

  async pause(): Promise<AgentSnapshot> {
    this.paused = true;
    this.setState("stuck");
    this.addEvent("stuck", "已暂停", "任务暂停中，点击继续可恢复。", "blocked");
    return this.getSnapshot();
  }

  async resume(): Promise<AgentSnapshot> {
    this.paused = false;
    this.takeover = false;
    this.addEvent("observing", "继续任务", "我会重新观察当前手机界面。", "running");
    if (!this.running && this.currentRequest) {
      this.running = true;
      void this.runLoop();
    }
    this.emitChanged();
    return this.getSnapshot();
  }

  async stop(): Promise<AgentSnapshot> {
    this.stopped = true;
    this.paused = false;
    this.takeover = false;
    this.running = false;
    this.setState("idle");
    this.addEvent("idle", "已急停", "所有自动动作已停止。", "blocked");
    return this.getSnapshot();
  }

  async takeoverMode(): Promise<AgentSnapshot> {
    this.takeover = true;
    this.paused = true;
    this.setState("user_takeover");
    this.addEvent("user_takeover", "用户接管", "你可以直接操作手机；继续后我会重新观察。", "blocked");
    return this.getSnapshot();
  }

  async continueFromTakeover(): Promise<AgentSnapshot> {
    this.takeover = false;
    this.paused = false;
    this.addEvent("observing", "接管结束", "我会从当前界面继续。", "running");
    if (!this.running && this.currentRequest) {
      this.running = true;
      void this.runLoop();
    }
    this.emitChanged();
    return this.getSnapshot();
  }

  async confirm(input: { confirmationId: string; approved: boolean; editedText?: string }): Promise<AgentSnapshot> {
    const confirmation = this.snapshot.pendingConfirmation;
    if (!confirmation || confirmation.id !== input.confirmationId) return this.getSnapshot();
    this.snapshot.pendingConfirmation = undefined;

    if (!input.approved) {
      this.setState("stuck");
      this.addEvent("stuck", "已取消敏感动作", "我没有执行这一步。", "blocked");
      return this.getSnapshot();
    }

    const action = input.editedText && confirmation.action.type === "input"
      ? { ...confirmation.action, text: input.editedText }
      : confirmation.action;
    await this.executeAction(action);
    this.addEvent("verifying", "已执行确认动作", "我会重新观察结果。", "running");
    if (!this.running && this.currentRequest) {
      this.running = true;
      void this.runLoop();
    }
    return this.getSnapshot();
  }

  private async runLoop(): Promise<void> {
    const request = this.currentRequest;
    if (!request || !this.currentIntent) return;
    const device = this.deps.getDevice(request.deviceId);
    if (!device) {
      this.fail("没有找到目标手机", "请重新选择设备。");
      return;
    }

    try {
      const ready = await this.preflight(device);
      if (!ready) return;
      if (this.currentIntent?.kind === "wechat_multi_article_digest") {
        await this.runMultiArticleDigest(device);
        return;
      }

      let stepIndex = 0;
      let budgetIntentKind: ParsedIntent["kind"] = this.currentIntent.kind;
      while (true) {
        const currentIntent = this.currentIntent;
        if (!currentIntent) return;
        if (currentIntent.kind !== budgetIntentKind) {
          budgetIntentKind = currentIntent.kind;
          stepIndex = 0;
        }
        const captureOwnsLoopBudget = this.isArticleCaptureInProgress(currentIntent);
        const maxSteps = maxStepsForIntent(currentIntent);
        if (!captureOwnsLoopBudget && stepIndex >= maxSteps) {
          this.fail("任务步数过多", `我已经尝试了 ${maxSteps} 步，先停下来避免误操作。`);
          return;
        }

        if (this.stopped) return;
        if (this.paused || this.takeover) {
          this.running = false;
          return;
        }

        const screen = await this.observe(device);
        if (this.stopped || this.paused || this.takeover) return;

        await this.captureArticleSummaryIfReady(screen);
        if (this.snapshot.state === "stuck" || this.snapshot.state === "finished" || this.snapshot.state === "waiting_confirmation") {
          return;
        }
        const intent = this.currentIntent;
        if (!intent) return;
        if (intent.kind !== budgetIntentKind) {
          budgetIntentKind = intent.kind;
          stepIndex = 0;
        }
        const plan = await this.plan(intent, screen, stepIndex);
        const grounded = this.groundAction(plan.action, screen);
        this.updatePlannerProgress(plan, grounded, screen);
        const preview = this.toPreview(plan, grounded, screen);
        this.snapshot.lastPreview = preview;
        this.addEvent("planning", "准备下一步", preview.description, "running", preview);

        if (this.shouldStopRepeatedAction(grounded)) {
          this.waitForConfirmation(
            { type: "ask_user", prompt: "同一个点击或输入连续没有让页面变化。我先停住，避免继续误点或重复输入；你可以接管一下，或让我从当前界面重新观察后继续。" },
            "连续无进展",
            "同一个点击或输入连续没有让页面变化，已暂停自动操作。"
          );
          this.running = false;
          return;
        }

        const risk = assessRisk({
          action: grounded,
          intent,
          whitelist: this.deps.getSettings().whitelist,
          advancedAutoMode: this.deps.getSettings().advancedAutoMode
        });

        if (risk.decision === "block") {
          this.fail("动作被阻止", risk.reason);
          return;
        }
        if (risk.decision === "confirm" || grounded.type === "ask_user") {
          this.waitForConfirmation(grounded, preview.description, risk.reason);
          this.running = false;
          return;
        }

        const shouldMarkFreshSend = isSendMessagePlan(plan, screen, intent);
        const done = await this.executeAction(grounded);
        if (shouldMarkFreshSend && this.currentIntent?.kind === "wechat_message") {
          this.currentIntent = { ...this.currentIntent, freshSendRequired: false };
          const contact = this.currentIntent.delivery?.name ?? this.currentIntent.contact ?? "目标联系人";
          this.setState("finished");
          this.addEvent("finished", "任务完成", `已向 ${contact} 发送消息。`, "done");
          this.running = false;
          return;
        }
        if (done) return;
        await this.verify(device, grounded, preview.expectedResult, screen);
        stepIndex += 1;
      }

    } catch (error) {
      this.fail("任务遇到问题", humanizeFailure(error));
    } finally {
      if (this.snapshot.state !== "waiting_confirmation" && this.snapshot.state !== "user_takeover") {
        this.running = false;
      }
      this.emitChanged();
    }
  }

  private async preflight(device: DeviceRecord): Promise<boolean> {
    this.setState("observing");
    this.addEvent("observing", "任务前检查", "正在检查桥接、观察能力和控制授权。", "running");
    const settings = this.deps.getSettings();
    const health = await this.deps.kuaijs.healthCheck(device, settings.hasAiApiKey, settings.hasVisionApiKey);

    if (!health.agentConnected) {
      this.fail("快点JS Agent 未连接", "请确认手机端快点JS在前台、群控工具已连接，并重新检测桥接。");
      return false;
    }

    if (!health.screenshotOk || !health.sourceOk) {
      this.fail("观察能力不可用", "截图或节点树读取失败，Agent 无法判断当前手机界面。");
      return false;
    }

    if (health.controlBackend === "none") {
      this.fail("观察可用，控制后端不可用", health.controlMessage ?? "快点JS项目运行时暂不可用。");
      return false;
    }

    const backendMessage = "观察可用；自动控制将使用快点JS项目运行时执行。";
    this.addEvent("observing", "任务前检查通过", health.imeOk ? backendMessage : `${backendMessage} 输入法接口不可用时会尝试运行时输入兜底。`, "done");
    return true;
  }

  private async observe(device: DeviceRecord): Promise<ScreenGraph> {
    this.setState("observing");
    this.addEvent("observing", "观察手机界面", "正在读取截图、节点树和当前 App。", "running");
    const [screenshot, source, activeApp] = await Promise.allSettled([
      this.deps.kuaijs.screenshotBase64(device),
      this.deps.kuaijs.source(device),
      this.deps.kuaijs.activeAppInfo(device)
    ]);
    const screenshotBase64 = screenshot.status === "fulfilled" ? screenshot.value : undefined;
    const sourceText = source.status === "fulfilled" ? source.value : undefined;
    const activeAppInfo = activeApp.status === "fulfilled" ? activeApp.value : undefined;
    const sourceScreen = buildScreenGraph({
      screenshotBase64,
      source: sourceText,
      activeApp: activeAppInfo,
      ocrBlocks: []
    });
    let perceptionFrame = buildPerceptionFrame(this.currentIntent, sourceScreen, this.perceptionContext());
    const policy = modelUsePolicy(this.currentIntent, perceptionFrame, this.perceptionContext());
    let ocrBlocks: ElementRef[] = [];
    let visionResult: Awaited<ReturnType<VisionClient["describeScreen"]>> | undefined;
    let visualSummary: string | undefined;
    let visualObservation: string | undefined;
    const skipVisionForArticleCapture = this.currentPhase === "read_article"
      && (this.currentIntent?.kind === "wechat_article_summary" || this.currentIntent?.kind === "wechat_multi_article_digest");
    if (this.deps.vision && screenshotBase64 && this.deps.getSettings().hasVisionApiKey && policy.useVision && !skipVisionForArticleCapture) {
      const visionSignature = visionObservationSignature(sourceScreen);
      const visionMode = selectVisionMode(perceptionFrame, policy, this.perceptionContext());
      const maxBlocks = visionMode === "classify" ? 0 : visionMode === "elements" ? 24 : 56;
      const cachedVision = this.lastVisionSignature === visionSignature ? this.lastVisionResult : undefined;
      if (cachedVision) {
        visionResult = cachedVision;
        ocrBlocks = cachedVision.ocrBlocks ?? [];
        visualSummary = cachedVision.summary;
        visualObservation = cachedVision.recommendedObservation;
        this.deps.diagnostics?.({
          source: "vision",
          category: "vision",
          action: "vision_perception_cache",
          taskId: this.snapshot.taskId,
          deviceId: this.currentRequest?.deviceId,
          status: "ok",
          modelRole: "vision_perception",
          message: "同一屏幕复用上一次视觉识别结果，避免重复调用 VLM。",
          payload: { pageType: cachedVision.pageType, ocrBlocks: ocrBlocks.length, mode: visionMode, cacheHit: true }
        });
      } else if (this.visionRequestsThisTask >= MAX_VISION_CALLS_PER_TASK) {
        this.deps.diagnostics?.({
          source: "vision",
          category: "vision",
          action: "vision_perception_skipped",
          taskId: this.snapshot.taskId,
          deviceId: this.currentRequest?.deviceId,
          status: "ok",
          modelRole: "vision_perception",
          message: "本任务视觉模型调用已达到预算，继续使用节点树和本地规则。",
          payload: { maxCalls: MAX_VISION_CALLS_PER_TASK, reason: policy.reason, mode: visionMode, cacheHit: false }
        });
      } else {
        try {
          this.visionRequestsThisTask += 1;
          const vision = await this.deps.vision.describeScreen(screenshotBase64, {
            mode: visionMode,
            maxBlocks,
            app: sourceScreen.app,
            phase: this.currentPhase,
            pageHints: visionPageHints(this.currentIntent),
            timeoutMs: visionMode === "classify" ? 22000 : visionMode === "elements" ? 35000 : 45000
          });
          visionResult = vision;
          ocrBlocks = vision?.ocrBlocks ?? [];
          if (vision) {
            this.lastVisionSignature = visionSignature;
            this.lastVisionResult = vision;
            visualSummary = vision.summary;
            visualObservation = vision.recommendedObservation;
            this.deps.diagnostics?.({
              source: "vision",
              category: "vision",
              action: "vision_perception",
              taskId: this.snapshot.taskId,
              deviceId: this.currentRequest?.deviceId,
              status: "ok",
              modelRole: "vision_perception",
              message: policy.reason,
              payload: {
                pageType: vision.pageType,
                mainRegions: vision.mainRegions,
                inputHints: vision.inputHints,
                riskHints: vision.riskHints,
                recommendedObservation: vision.recommendedObservation,
                requestIndex: this.visionRequestsThisTask,
                mode: visionMode,
                cacheHit: false
              }
            });
          }
          if (ocrBlocks.length) {
            this.addEvent("observing", "视觉识别完成", `视觉模型补充了 ${ocrBlocks.length} 个屏幕文本/区域。`, "done");
          }
        } catch (error) {
          this.addEvent("observing", "视觉识别失败", humanizeFailure(error), "failed");
        }
      }
    }
    const screen = ocrBlocks.length
      ? buildScreenGraph({
          screenshotBase64,
          source: sourceText,
          activeApp: activeAppInfo,
          ocrBlocks
        })
      : sourceScreen;
    const finalFrame = {
      ...(visionResult
        ? mergeVisionIntoPerception(buildPerceptionFrame(this.currentIntent, screen, this.perceptionContext()), visionResult)
        : buildPerceptionFrame(this.currentIntent, screen, this.perceptionContext())),
      visualSummary,
      visualObservation
    };
    this.snapshot.lastScreen = screen;
    this.deps.diagnostics?.({
      source: "agent",
      category: "agent_timeline",
      action: "orient",
      taskId: this.snapshot.taskId,
      deviceId: this.currentRequest?.deviceId,
      status: "ok",
      message: `pageType=${finalFrame.pageType}; confidence=${finalFrame.confidence}`,
      payload: perceptionSummary(finalFrame)
    });
    this.addEvent("observing", "观察完成", `识别到 ${screen.nodes.length} 个界面元素，当前像是 ${finalFrame.pageType}。`, "done");
    return screen;
  }

  private async plan(intent: ParsedIntent, screen: ScreenGraph, stepIndex: number): Promise<PlannerOutput> {
    this.setState("planning");
    if (intent.kind === "wechat_article_summary" && this.articleCaptureState && !this.articleCaptureState.completed) {
      const direction = this.articleCaptureState.direction;
      return {
        action: { type: "collect_scroll", direction, maxScrolls: 1 },
        description: direction === "up" ? "当前像是从文章末尾打开，向上倒读补齐前文再总结。" : "继续滑动阅读全文，采集后续正文再生成摘要。",
        expectedResult: direction === "up" ? "采集到上一屏正文，直到回到文章开头、界面不再变化或达到安全阅读上限。" : "文章下一屏正文被读取，直到到达文末、界面不再变化或达到安全阅读上限。",
        confidence: 0.82,
        phase: "read_article",
        route: "wechat:current_article",
        guardReason: "article_capture_pixel_diff_only",
        progressKey: `article:read:${direction}`
      };
    }
    const context = this.plannerContext();
    const frame = buildPerceptionFrame(intent, screen, this.perceptionContext());
    const policy = modelUsePolicy(intent, frame, this.perceptionContext());
    const skillPlan = fallbackPlan(intent, screen, stepIndex, context);
    let modelDecision: ModelDecisionOutput | undefined;
    try {
      if (policy.useLlm && this.deps.getSettings().hasAiApiKey) {
        modelDecision = await this.deps.llm.completeJson<ModelDecisionOutput>(
          decisionSystemPrompt(),
          decisionUserPrompt({ intent, frame, context, skillPlan }),
          {
            mode: policy.modelRole === "recovery" ? "recovery" : "route",
            maxPromptChars: policy.modelRole === "recovery" ? 4600 : 3400,
            timeoutMs: policy.modelRole === "recovery" ? 45000 : 30000
          }
        );
      }
    } catch (error) {
      this.addEvent("planning", policy.modelRole === "recovery" ? "模型恢复建议失败" : "模型路线判断失败", humanizeFailure(error), "failed");
    }
    const decision = this.decisionEngine.decide({
      intent,
      frame,
      context,
      stepIndex,
      modelDecision,
      modelRole: policy.modelRole
    });
    this.logDecisionTrace(decision.trace, policy);
    return decision;
  }

  private isArticleCaptureInProgress(intent: ParsedIntent | undefined): boolean {
    return Boolean(
      this.articleCaptureState
      && !this.articleCaptureState.completed
      && (intent?.kind === "wechat_article_summary" || intent?.kind === "wechat_multi_article_digest")
    );
  }

  private async captureArticleSummaryIfReady(screen: ScreenGraph): Promise<void> {
    const intent = this.currentIntent;
    const contact = intent?.delivery?.name ?? intent?.contact;
    if (!intent || intent.kind !== "wechat_article_summary" || !contact) return;
    const account = intent.source?.name ?? intent.topic ?? "机器之心";
    await this.captureArticleSummaryWithLocalOcr(screen, intent, contact, account);
    return;
    const surface = detectWechatArticleSurface(screen, account, Boolean(this.articleReadState));
    this.deps.diagnostics?.({
      source: "agent",
      category: "agent_timeline",
      action: "article_surface_check",
      taskId: this.snapshot.taskId,
      deviceId: this.currentRequest?.deviceId,
      status: surface.ok ? "ok" : "failed",
      message: `article_surface_reason=${surface.reason}`,
      payload: {
        account,
        phase: this.currentPhase,
        route: this.currentRoute,
        articleSurfaceReason: surface.reason
      }
    });
    if (!surface.ok || !surface.articleText) {
      if (this.articleReadState) {
        this.articleReadState = undefined;
        this.setTaskProgress("locate_source", "wechat:recover_article");
      }
      return;
    }
    const article = surface.articleText as WechatArticleText;

    const progress = this.mergeArticleReadState(account, article);
    this.deps.diagnostics?.({
      source: "agent",
      category: "agent_timeline",
      action: "article_read_progress",
      taskId: this.snapshot.taskId,
      deviceId: this.currentRequest?.deviceId,
      status: "ok",
      message: `article_read_progress screen=${progress.screenCount} lines=${progress.lines.length} unchanged=${progress.unchangedScrollCount}`,
      payload: {
        account,
        title: progress.title,
        direction: progress.direction,
        screenCount: progress.screenCount,
        lineCount: progress.lines.length,
        stableCount: progress.stableCount,
        unchangedScrollCount: progress.unchangedScrollCount,
        reachedEnd: progress.reachedEnd,
        reachedStart: progress.reachedStart,
        hasVisualSignature: Boolean(progress.lastVisualSignature),
        articleSurfaceReason: surface.reason,
        contentSignature: progress.lastContentSignature
      }
    });
    if (!isArticleReadComplete(progress)) {
      this.addEvent(
        "observing",
        "正在阅读全文",
        progress.direction === "up"
          ? `已采集 ${progress.screenCount} 屏、${progress.lines.length} 条正文线索，检测到可能从文末打开，正在向上倒读。`
          : `已采集 ${progress.screenCount} 屏、${progress.lines.length} 条正文线索，继续下滑阅读。`,
        "done"
      );
      return;
    }
    if (progress.lines.length < ARTICLE_MIN_LINES_FOR_SUMMARY) {
      this.articleReadState = undefined;
      this.fail("正文采集不足", "已经滑动到文章边界，但可用正文太少。请确认当前确实在文章详情页，或手动把文章正文区域定位到可读位置后重试。");
      return;
    }

    const articleForSummary = {
      title: progress.title,
      lines: progress.lines
    };
    this.setTaskProgress("compose_result", "wechat:compose_summary");
    const message = await this.composeWechatArticleSummaryMessage(account, articleForSummary);
    this.articleReadState = undefined;
    this.currentIntent = {
      ...intent,
      kind: "wechat_message",
      targetApp: "wechat",
      delivery: { app: "wechat", kind: "contact", name: contact ?? "" },
      query: message,
      output: "message",
      freshSendRequired: true,
      rawInstruction: intent?.rawInstruction ?? ""
    };
    this.setTaskProgress("deliver_message", "wechat:deliver_message");
    this.addEvent("planning", "文章摘要已生成", `已提取《${truncate(article.title, 40)}》，接下来发送给 ${contact}。`, "done");
  }

  private async captureArticleSummaryWithLocalOcr(
    screen: ScreenGraph,
    intent: ParsedIntent,
    contact: string,
    account: string
  ): Promise<void> {
    const captureInProgress = Boolean(this.articleCaptureState);
    const surface = captureInProgress
      ? { ok: true, reason: "article_capture_pixel_diff_only", articleText: this.articleFromCaptureScreen(screen) }
      : detectWechatArticleSurface(screen, account, false);
    this.logArticleSurfaceCheck(account, surface.reason, surface.ok);
    if (!surface.ok || !surface.articleText) return;

    const update = await this.captureArticleFrame(account, surface.articleText, screen);
    this.logArticleCapture(update, surface.reason);
    if (!update.state.completed) {
      this.addEvent(
        "observing",
        "Capturing article screenshots",
        update.event === "reverse_started"
          ? `Pixel diff was below 1% within the first 10 forward scrolls; reverse capture started. Frames: ${update.state.frames.length}.`
          : `Saved ${update.state.frames.length} article screenshots; latest diff=${formatDiff(update.frame.diffRatio)}; stable=${update.state.stableCount}/3.`,
        "done"
      );
      return;
    }

    if (update.state.stopReason === "max_frames") {
      this.articleCaptureState = undefined;
      this.fail("Article reading did not reach a stable boundary", `Captured ${update.state.frames.length} screenshots but did not confirm the article bottom by pixel diff.`);
      return;
    }

    let articleForSummary: ArticleForSummary;
    try {
      articleForSummary = await this.extractCapturedArticleWithLocalOcr(account, update.state);
    } catch (error) {
      this.articleCaptureState = undefined;
      this.fail("Local OCR is unavailable", safeError(error));
      return;
    }
    if (articleForSummary.lines.length < ARTICLE_MIN_LINES_FOR_SUMMARY) {
      this.articleCaptureState = undefined;
      this.fail("Article OCR text is insufficient", `Local OCR produced only ${articleForSummary.lines.length} usable lines after capturing ${update.state.frames.length} screenshots.`);
      return;
    }

    this.setTaskProgress("compose_result", "wechat:compose_summary");
    const message = await this.composeWechatArticleSummaryMessage(account, articleForSummary);
    this.articleCaptureState = undefined;
    this.currentIntent = {
      ...intent,
      kind: "wechat_message",
      targetApp: "wechat",
      delivery: { app: "wechat", kind: "contact", name: contact },
      query: message,
      output: "message",
      freshSendRequired: true
    };
    this.setTaskProgress("deliver_message", "wechat:deliver_message");
    this.noProgressCount = 0;
    this.lastProgressKey = undefined;
    this.lastLoopScreenSignature = undefined;
    this.addEvent("planning", "Article summary generated", `Captured ${update.state.frames.length} screenshots, OCR extracted ${articleForSummary.lines.length} lines, then generated a message for ${contact}.`, "done");
  }

  private async captureArticleFrame(account: string, article: WechatArticleText, screen: ScreenGraph): Promise<ArticleCaptureUpdate> {
    this.setTaskProgress("read_article", "wechat:current_article_capture");
    if (!this.articleCaptureState || this.articleCaptureState.account !== account) {
      this.articleCaptureState = await createArticleCaptureState({
        taskId: this.snapshot.taskId ?? createId("task"),
        account,
        title: article.title
      });
    } else if (article.title && this.articleCaptureState.title === "latest article") {
      this.articleCaptureState.title = article.title;
    }
    return appendArticleCaptureFrame(this.articleCaptureState, screen, article.lines);
  }

  private articleFromCaptureScreen(screen: ScreenGraph): WechatArticleText {
    const labels = [...screen.nodes, ...screen.ocrBlocks]
      .map((node) => node.label.trim())
      .filter(Boolean)
      .filter((label) => !/^XCUIElementType/.test(label))
      .slice(0, 80);
    const textSignature = labels.join("|");
    const title = this.articleCaptureState?.title ?? "latest article";
    return {
      title,
      lines: labels,
      screenSignature: textSignature.slice(0, 12000),
      contentSignature: textSignature.slice(0, 4000),
      visualSignature: screen.screenshotBase64 ? `${screen.screenshotBase64.length}` : undefined,
      reachedEnd: false,
      reachedStart: false
    };
  }

  private async extractCapturedArticleWithLocalOcr(account: string, state: ArticleCaptureState): Promise<ArticleForSummary> {
    const availability = await this.localOcr.isAvailable();
    if (!availability.ok) {
      this.deps.diagnostics?.({
        source: "agent",
        category: "agent_timeline",
        action: "article_local_ocr",
        taskId: this.snapshot.taskId,
        deviceId: this.currentRequest?.deviceId,
        status: "failed",
        message: availability.message ?? "Local OCR is unavailable.",
        payload: { account, provider: availability.provider, language: availability.language }
      });
      throw new Error(`Local OCR is unavailable: ${availability.message ?? availability.provider}`);
    }

    const frames = orderedArticleCaptureFrames(state);
    const ocr = await this.localOcr.recognizeImages(frames.map((frame) => frame.path));
    const lines = normalizeCapturedOcrLines(ocr.images.flatMap((image) => image.lines.map((line) => line.text)));
    this.deps.diagnostics?.({
      source: "agent",
      category: "agent_timeline",
      action: "article_local_ocr",
      taskId: this.snapshot.taskId,
      deviceId: this.currentRequest?.deviceId,
      status: lines.length ? "ok" : "failed",
      modelRole: "summarize",
      message: `Local OCR ${ocr.provider} processed ${frames.length} frames and produced ${lines.length} normalized lines.`,
      payload: {
        provider: ocr.provider,
        account,
        language: ocr.language,
        frameCount: frames.length,
        imageCount: ocr.images.length,
        lineCount: lines.length,
        captureDir: state.captureDir,
        stopReason: state.stopReason,
        ocrErrors: ocr.images.filter((image) => image.error).map((image) => ({ path: image.path, error: image.error })).slice(0, 8)
      }
    });
    return {
      title: state.title,
      lines
    };
  }

  private logArticleSurfaceCheck(account: string, reason: string, ok: boolean): void {
    this.deps.diagnostics?.({
      source: "agent",
      category: "agent_timeline",
      action: "article_surface_check",
      taskId: this.snapshot.taskId,
      deviceId: this.currentRequest?.deviceId,
      status: ok ? "ok" : "failed",
      message: `article_surface_reason=${reason}`,
      payload: {
        account,
        phase: this.currentPhase,
        route: this.currentRoute,
        articleSurfaceReason: reason
      }
    });
  }

  private logArticleCapture(update: ArticleCaptureUpdate, articleSurfaceReason: string): void {
    this.deps.diagnostics?.({
      source: "agent",
      category: "agent_timeline",
      action: "article_capture_frame",
      taskId: this.snapshot.taskId,
      deviceId: this.currentRequest?.deviceId,
      status: "ok",
      message: `article_capture frame=${update.frame.index} diff=${formatDiff(update.frame.diffRatio)} stable=${update.state.stableCount}`,
      payload: {
        account: update.state.account,
        title: update.state.title,
        direction: update.frame.direction,
        frameIndex: update.frame.index,
        capturePath: update.frame.path,
        diffRatio: update.frame.diffRatio,
        lowDiff: update.frame.lowDiff,
        stableCount: update.state.stableCount,
        forwardSwipeCount: update.state.forwardSwipeCount,
        reverseSwipeCount: update.state.reverseSwipeCount,
        reverseAttempted: update.state.reverseAttempted,
        event: update.event,
        stopReason: update.state.stopReason,
        articleSurfaceReason,
        sourceSignature: update.frame.sourceSignature
      }
    });
  }

  private async runMultiArticleDigest(device: DeviceRecord): Promise<void> {
    const intent = this.currentIntent;
    if (!intent || intent.kind !== "wechat_multi_article_digest") return;
    const account = intent.source?.name ?? intent.topic ?? "\u673a\u5668\u4e4b\u5fc3";
    const deliveryName = intent.delivery?.name ?? intent.contact;
    if (!deliveryName) {
      this.fail("Missing delivery target", "The multi-article digest needs a contact or group chat target.");
      return;
    }

    const windowHours = intent.articleWindowHours ?? 48;
    const state: MultiArticleDigestState = {
      account,
      deliveryName,
      windowHours,
      scan: createArticleListScanState(account, virtualNow(), windowHours),
      readSignatures: new Set<string>(),
      digests: []
    };
    this.multiArticleDigestState = state;
    const activeState = this.multiArticleDigestState;
    if (!activeState) return;
    this.setTaskProgress("collect_article_list", "wechat:multi_article_scan");

    await this.scanArticleList(device, activeState);
    if (this.snapshot.state === "stuck" || this.stopped || this.paused || this.takeover) return;

    const queue = activeState.scan.items.filter((item) => item.withinWindow);
    if (!queue.length) {
      this.fail("No recent articles found", `Scanned ${activeState.scan.screenCount} screens but found no articles within ${windowHours} hours.`);
      return;
    }

    for (const [index, item] of queue.entries()) {
      if (this.stopped || this.paused || this.takeover) return;
      if (activeState.readSignatures.has(item.signature)) continue;
      activeState.currentArticle = item;
      this.setTaskProgress("select_next_article", "wechat:multi_article_open");
      this.addEvent("planning", "Open article", `${index + 1}/${queue.length}: ${item.title}`, "running");
      await this.executeAction({ type: "tap_text", text: item.title });
      const digest = await this.readMultiArticleDigest(device, item, account);
      if (!digest) return;
      activeState.digests.push(digest);
      activeState.readSignatures.add(item.signature);
      this.deps.diagnostics?.({
        source: "agent",
        category: "agent_timeline",
        action: "multi_article_digest",
        taskId: this.snapshot.taskId,
        deviceId: this.currentRequest?.deviceId,
        status: "ok",
        modelRole: "summarize",
        message: `Read ${activeState.digests.length}/${queue.length}: ${item.title}`,
        payload: { title: item.title, publishedAt: item.publishedAt, summary: digest.summary, lineCount: digest.sourceLines.length }
      });
      await this.executeAction({ type: "back" });
    }

    const finalDigestMessage = composeMultiArticleDigestMessage(account, activeState.digests, deliveryName);
    activeState.finalDigestMessage = finalDigestMessage;
    this.deps.diagnostics?.({
      source: "agent",
      category: "agent_timeline",
      action: "finalDigestMessage",
      taskId: this.snapshot.taskId,
      deviceId: this.currentRequest?.deviceId,
      status: "ok",
      modelRole: "summarize",
      message: finalDigestMessage,
      payload: {
        account,
        deliveryName,
        articleCount: activeState.digests.length,
        scanScreens: activeState.scan.screenCount,
        skippedOldCount: activeState.scan.skippedOldItems.length,
        finalDigestMessage
      }
    });

    this.currentIntent = {
      ...intent,
      kind: "wechat_message",
      targetApp: "wechat",
      delivery: intent.delivery ?? { app: "wechat", kind: "contact", name: deliveryName },
      contact: deliveryName,
      query: finalDigestMessage,
      output: "message",
      freshSendRequired: true
    };
    this.setTaskProgress("deliver_message", "wechat:deliver_message");
    await this.runDeliveryLoop(device, 32);
  }

  private async scanArticleList(device: DeviceRecord, state: MultiArticleDigestState): Promise<void> {
    while (!isArticleListScanComplete(state.scan)) {
      if (this.stopped || this.paused || this.takeover) return;
      const screen = await this.observe(device);
      const update = updateArticleListScanState(state.scan, screen);
      this.deps.diagnostics?.({
        source: "agent",
        category: "agent_timeline",
        action: "article_list_scan",
        taskId: this.snapshot.taskId,
        deviceId: this.currentRequest?.deviceId,
        status: "ok",
        message: `scan=${state.scan.screenCount} found=${state.scan.items.length} added=${update.added.length} old=${state.scan.skippedOldItems.length}`,
        payload: {
          phase: "collect_article_list",
          route: "wechat:multi_article_scan",
          screenCount: state.scan.screenCount,
          foundCount: state.scan.items.length,
          added: update.added.map((item) => item.title),
          skippedOld: update.skippedOld.map((item) => item.title),
          skippedOldCount: state.scan.skippedOldItems.length,
          stableNoNewCount: state.scan.stableNoNewCount,
          boundaryConfirmScreens: state.scan.boundaryConfirmScreens,
          sawOldBoundary: state.scan.sawOldBoundary,
          screenSignature: update.screenSignature
        }
      });
      this.addEvent("observing", "Scan article list", `Found ${state.scan.items.length} recent articles; skipped ${state.scan.skippedOldItems.length} old items.`, "done");
      if (isArticleListScanComplete(state.scan)) return;
      if (state.scan.exhausted) {
        this.fail("Article list scan not confirmed", `Reached ${state.scan.maxScreens} list screens without confirming the 48-hour boundary.`);
        return;
      }
      await this.executeAction({ type: "collect_scroll", direction: "down", maxScrolls: 1 });
    }
  }

  private async readMultiArticleDigest(device: DeviceRecord, item: ArticleListItem, account: string): Promise<ArticleDigest | undefined> {
    this.articleReadState = undefined;
    this.articleCaptureState = undefined;
    this.setTaskProgress("read_article", "wechat:multi_article_read");
    for (let screenIndex = 0; screenIndex < 160; screenIndex += 1) {
      const screen = await this.observe(device);
      const captureInProgress = Boolean(this.articleCaptureState);
      const article = captureInProgress
        ? this.articleFromCaptureScreen(screen)
        : extractMultiArticleText(screen, account, item.title, false) ?? forceExtractMultiArticleText(screen, item.title);
      this.deps.diagnostics?.({
        source: "agent",
        category: "agent_timeline",
        action: "multi_article_surface_check",
        taskId: this.snapshot.taskId,
        deviceId: this.currentRequest?.deviceId,
        status: article ? "ok" : "failed",
        message: article
          ? `article_screen title=${article.title}; reason=${captureInProgress ? "article_capture_pixel_diff_only" : "initial_article_gate"}`
          : "not_article_screen",
        payload: {
          title: item.title,
          phase: "read_article",
          route: "wechat:multi_article_read",
          screenIndex,
          articleSurfaceReason: captureInProgress ? "article_capture_pixel_diff_only" : "initial_article_gate"
        }
      });
      if (!article) {
        this.fail("Article page not detected", `After opening "${item.title}", the current screen did not look like a WeChat article detail page.`);
        return undefined;
      }

      const update = await this.captureArticleFrame(account, { ...article, title: item.title || article.title }, screen);
      this.logArticleCapture(update, "multi_article");
      this.addEvent("observing", "Capture article", `${item.title}: ${update.state.frames.length} screenshots, diff=${formatDiff(update.frame.diffRatio)}, stable=${update.state.stableCount}/3.`, "done");
      if (update.state.completed) {
        if (update.state.stopReason === "max_frames") {
          this.articleCaptureState = undefined;
          this.fail("Article reading did not reach a stable boundary", `Captured ${update.state.frames.length} screenshots for "${item.title}" but did not confirm the article boundary.`);
          return undefined;
        }
        let articleText: ArticleForSummary;
        try {
          articleText = await this.extractCapturedArticleWithLocalOcr(account, update.state);
        } catch (error) {
          this.articleCaptureState = undefined;
          this.fail("Local OCR is unavailable", safeError(error));
          return undefined;
        }
        if (articleText.lines.length < ARTICLE_MIN_LINES_FOR_SUMMARY) {
          this.articleCaptureState = undefined;
          this.fail("Article OCR text is insufficient", `Local OCR produced only ${articleText.lines.length} usable lines for "${item.title}".`);
          return undefined;
        }
        const summary = composeDigestSummary(articleText.lines);
        this.articleCaptureState = undefined;
        return {
          title: item.title || articleText.title,
          publishedAt: item.publishedAt,
          summary,
          sourceLines: articleText.lines
        };
      }
      await this.executeAction({ type: "collect_scroll", direction: update.state.direction, maxScrolls: 1 });
    }

    this.fail("Article reading did not finish", `Reached the reading safety limit for "${item.title}" without reaching article end or stable screen boundary.`);
    return undefined;
  }

  private async runDeliveryLoop(device: DeviceRecord, maxSteps: number): Promise<void> {
    let stepIndex = 0;
    while (stepIndex < maxSteps) {
      const intent = this.currentIntent;
      if (!intent) return;
      if (this.stopped || this.paused || this.takeover) return;
      const screen = await this.observe(device);
      const plan = await this.plan(intent, screen, stepIndex);
      const grounded = this.groundAction(plan.action, screen);
      this.updatePlannerProgress(plan, grounded, screen);
      const preview = this.toPreview(plan, grounded, screen);
      this.snapshot.lastPreview = preview;
      this.addEvent("planning", "Prepare delivery step", preview.description, "running", preview);

      const risk = assessRisk({
        action: grounded,
        intent,
        whitelist: this.deps.getSettings().whitelist,
        advancedAutoMode: this.deps.getSettings().advancedAutoMode
      });
      if (risk.decision === "block") {
        this.fail("Action blocked", risk.reason);
        return;
      }
      if (risk.decision === "confirm" || grounded.type === "ask_user") {
        this.waitForConfirmation(grounded, preview.description, risk.reason);
        this.running = false;
        return;
      }

      const shouldMarkFreshSend = isSendMessagePlan(plan, screen, intent);
      const done = await this.executeAction(grounded);
      if (shouldMarkFreshSend && this.currentIntent?.kind === "wechat_message") {
        this.currentIntent = { ...this.currentIntent, freshSendRequired: false };
        const contact = this.currentIntent.delivery?.name ?? this.currentIntent.contact ?? "target";
        this.setState("finished");
        this.addEvent("finished", "Task finished", `Sent digest message to ${contact}.`, "done");
        this.running = false;
        return;
      }
      if (done) return;
      await this.verify(device, grounded, preview.expectedResult, screen);
      stepIndex += 1;
    }
    this.fail("Delivery took too many steps", `Tried ${maxSteps} delivery steps after composing the multi-article digest.`);
  }

  private async composeWechatArticleSummaryMessage(account: string, article: ArticleForSummary): Promise<string> {
    const prepared = preprocessWechatArticleForSummary(account, article);
    this.deps.diagnostics?.({
      source: "agent",
      category: "agent_timeline",
      action: "article_preprocess",
      taskId: this.snapshot.taskId,
      deviceId: this.currentRequest?.deviceId,
      status: "ok",
      modelRole: "summarize",
      message: `Prepared article text for LLM: ${prepared.promptLineCount}/${prepared.originalLineCount} lines, ${prepared.promptCharCount} chars.`,
      payload: {
        title: prepared.title,
        originalLineCount: prepared.originalLineCount,
        normalizedLineCount: prepared.normalizedLineCount,
        promptLineCount: prepared.promptLineCount,
        droppedLineCount: prepared.droppedLineCount,
        promptCharCount: prepared.promptCharCount
      }
    });
    if (this.deps.getSettings().hasAiApiKey) {
      try {
        this.addEvent("planning", "正在生成摘要", "正在根据已读取正文整理一段简洁易读的总结。", "running");
        this.deps.diagnostics?.({
          source: "llm",
          category: "llm",
          action: "summarize",
          taskId: this.snapshot.taskId,
          deviceId: this.currentRequest?.deviceId,
          status: "running",
          modelRole: "summarize",
          message: `Summarizing ${prepared.promptLineCount} preprocessed article lines from ${account}.`
        });
        const modelSummary = await this.deps.llm.completeJson<ArticleSummaryModelOutput>(
          articleSummarySystemPrompt(),
          articleSummaryUserPrompt(account, prepared),
          { mode: "summary", timeoutMs: 90000, maxPromptChars: 6800 }
        );
        const message = buildWechatArticleSummaryMessageFromModel(account, prepared, modelSummary);
        if (message) {
          this.addEvent("planning", "模型摘要完成", `已生成 ${message.length} 字的发送草稿。`, "done");
          return message;
        }
      } catch (error) {
        this.addEvent("planning", "模型摘要失败", `${humanizeFailure(error)} 已改用本地摘要兜底。`, "failed");
      }
    }
    return buildWechatArticleSummaryMessage(account, prepared);
  }

  private mergeArticleReadState(account: string, article: WechatArticleText): ArticleReadState {
    const state = this.articleReadState && this.articleReadState.account === account
      ? this.articleReadState
      : {
          account,
          title: article.title,
          lines: [],
          seenLines: new Set<string>(),
          screenCount: 0,
          stableCount: 0,
          unchangedScrollCount: 0,
          reachedEnd: false,
          reachedStart: false,
          direction: article.reachedEnd && !article.reachedStart ? "up" as const : "down" as const,
          reverseAttempted: article.reachedEnd && !article.reachedStart
        };

    const contentStable = state.lastContentSignature
      ? state.lastContentSignature === article.contentSignature
      : false;
    const visualStable = state.lastVisualSignature && article.visualSignature
      ? state.lastVisualSignature === article.visualSignature
      : false;
    const screenStable = article.visualSignature && state.lastVisualSignature
      ? contentStable && visualStable
      : contentStable;
    for (const line of article.lines) {
      const normalized = normalizeText(line);
      if (!normalized || state.seenLines.has(normalized)) continue;
      state.seenLines.add(normalized);
      state.lines.push(line);
    }
    if (!state.title || state.title === "最新文章") state.title = article.title;
    state.screenCount += 1;
    state.reachedEnd = state.reachedEnd || article.reachedEnd;
    state.reachedStart = state.reachedStart || article.reachedStart;
    state.unchangedScrollCount = screenStable ? state.unchangedScrollCount + 1 : 0;
    state.stableCount = state.unchangedScrollCount;
    state.lastScreenSignature = article.screenSignature;
    state.lastContentSignature = article.contentSignature;
    state.lastVisualSignature = article.visualSignature ?? state.lastVisualSignature;
    if (
      state.direction === "down"
      && (state.reachedEnd || state.unchangedScrollCount >= ARTICLE_STABLE_SCREENS_TO_ASSUME_END)
      && (state.screenCount < ARTICLE_MIN_SCREENS_BEFORE_SUMMARY || state.lines.length < ARTICLE_MIN_LINES_FOR_SUMMARY)
      && !state.reverseAttempted
    ) {
      state.direction = "up";
      state.reverseAttempted = true;
      state.stableCount = 0;
      state.unchangedScrollCount = 0;
    }
    this.articleReadState = state;
    return state;
  }

  private groundAction(action: AgentAction, screen: ScreenGraph): AgentAction {
    if (action.type === "tap_element") {
      const element = [...screen.nodes, ...screen.ocrBlocks].find((item) => item.id === action.elementId);
      const center = element ? elementCenter(element) : undefined;
      if (center) return { type: "tap_xy", x: center.x, y: center.y, coordinateSpace: "screen" };
      return { type: "ask_user", prompt: "我想点击的元素已经不在当前页面上，请接管或重试。" };
    }
    if (action.type === "tap_text") {
      const element = findElement(screen, action.text);
      const center = element ? elementCenter(element) : undefined;
      if (center) return { type: "tap_xy", x: center.x, y: center.y, coordinateSpace: "screen" };
      return { type: "ask_user", prompt: `我没有找到“${action.text}”。` };
    }
    if (action.type === "tap_xy" && action.coordinateSpace === "normalized" && screen.screenSize) {
      return {
        ...action,
        x: (action.x / 1000) * screen.screenSize.width,
        y: (action.y / 1000) * screen.screenSize.height,
        coordinateSpace: "screen"
      };
    }
    if (action.type === "swipe" && action.coordinateSpace === "normalized" && screen.screenSize) {
      return {
        ...action,
        startX: (action.startX / 1000) * screen.screenSize.width,
        startY: (action.startY / 1000) * screen.screenSize.height,
        endX: (action.endX / 1000) * screen.screenSize.width,
        endY: (action.endY / 1000) * screen.screenSize.height,
        coordinateSpace: "screen"
      };
    }
    return action;
  }

  private toPreview(plan: PlannerOutput, action: AgentAction, screen: ScreenGraph): ActionPreview {
    const targetBounds = action.type === "tap_element"
      ? [...screen.nodes, ...screen.ocrBlocks].find((item) => item.id === action.elementId)?.bounds
      : action.type === "tap_xy"
        ? { x: action.x - 16, y: action.y - 16, width: 32, height: 32 }
        : undefined;
    return {
      id: createId("preview"),
      action,
      description: plan.description,
      expectedResult: plan.expectedResult,
      riskLevel: plan.confidence < 0.5 ? "medium" : "low",
      targetBounds,
      confidence: plan.confidence
    };
  }

  private async executeAction(action: AgentAction): Promise<boolean> {
    const request = this.currentRequest;
    if (!request) return true;
    const device = this.deps.getDevice(request.deviceId);
    if (!device) {
      this.fail("没有找到目标手机", "请重新选择设备。");
      return true;
    }

    if (action.type === "finish") {
      this.setState("finished");
      this.addEvent("finished", "任务完成", action.summary, "done");
      this.running = false;
      return true;
    }

    if (action.type === "ask_user") {
      this.waitForConfirmation(action, "需要你确认下一步", action.prompt);
      return true;
    }

    if (action.type === "wait") {
      this.setState("acting");
      this.addEvent("acting", "正在等待", describeAction(action), "running");
      await sleep(action.ms);
      this.addEvent("acting", "等待完成", action.reason ?? "继续观察。", "done");
      return false;
    }

    this.setState("acting");
    this.addEvent("acting", "正在操作手机", describeAction(action), "running");
    try {
      const message = await this.deps.control.execute(device, action);
      this.addEvent("acting", "动作完成", message, "done");
    } catch (error) {
      if (action.type === "input" && isInputAuthorizationFailure(error)) {
        this.waitForConfirmation(
          action,
          "需要你接管输入",
          "快点JS API键盘和控制输入都未授权。请在手机上启用快点JS API键盘，或接管后手动输入。"
        );
        return true;
      }
      if (isRuntimeRequestSentButUnverified(error)) {
        this.addEvent("acting", "动作已发出", "快点JS没有返回脚本结果，我会继续观察手机画面来校验是否生效。", "done");
        return false;
      }
      throw error;
    }
    return false;
  }

  private async verify(device: DeviceRecord, action: AgentAction, expected: string, before: ScreenGraph): Promise<void> {
    this.setState("verifying");
    await sleep(700);
    try {
      const screen = await this.observe(device);
      const result = verifyActionResult(action, expected, before, screen);
      this.deps.diagnostics?.({
        source: "agent",
        category: "agent_timeline",
        action: "verify",
        taskId: this.snapshot.taskId,
        deviceId: this.currentRequest?.deviceId,
        status: result.ok ? "ok" : "failed",
        verification: result,
        message: `${result.actual}; expected=${result.expected}`
      });
      if (!result.ok) {
        this.taskMemory.recentFailures = [...this.taskMemory.recentFailures, result.actual].slice(-8);
      }
      this.addEvent("verifying", result.ok ? "校验完成" : "校验未完全确认", result.actual, result.ok ? "done" : "failed", undefined, screen.screenshotBase64);
    } catch (error) {
      this.addEvent("verifying", "校验失败", humanizeFailure(error), "failed");
    }
  }

  private waitForConfirmation(action: AgentAction, title: string, message: string): void {
    this.setState("waiting_confirmation");
    const confirmation: ConfirmationRequest = {
      id: createId("confirm"),
      title,
      message,
      editableText: action.type === "input" ? action.text : undefined,
      recipient: this.currentIntent?.contact,
      action,
      createdAt: now()
    };
    this.snapshot.pendingConfirmation = confirmation;
    this.addEvent("waiting_confirmation", title, message, "blocked");
    this.emitChanged();
  }

  private fail(title: string, detail: string): void {
    this.setState("stuck");
    this.addEvent("stuck", title, detail, "failed");
    this.running = false;
    this.emitChanged();
  }

  private setState(state: ExperienceState): void {
    this.snapshot.state = state;
    this.emitChanged();
  }

  private addEvent(
    state: ExperienceState,
    title: string,
    detail: string,
    status: TimelineEvent["status"],
    preview?: ActionPreview,
    screenshotBase64?: string
  ): void {
    this.snapshot.timeline = [
      ...this.snapshot.timeline,
      {
        id: createId("evt"),
        state,
        title,
        detail,
        timestamp: now(),
        status,
        riskLevel: preview?.riskLevel,
        preview,
        screenshotBase64
      }
    ].slice(-120);
    this.deps.diagnostics?.({
      source: "agent",
      category: "agent_timeline",
      action: state,
      taskId: this.snapshot.taskId,
      deviceId: this.currentRequest?.deviceId,
      status: status === "done" ? "ok" : status,
      message: `${title}: ${detail}`,
      payload: {
        state,
        phase: this.currentPhase,
        route: this.currentRoute,
        noProgressCount: this.noProgressCount,
        lastScreenSignature: this.lastLoopScreenSignature,
        title,
        detail,
        riskLevel: preview?.riskLevel,
        action: preview?.action
      }
    });
    this.emitChanged();
  }

  private emitChanged(): void {
    this.emit("changed", this.getSnapshot());
  }

  private perceptionContext() {
    return {
      phase: this.currentPhase,
      noProgressCount: this.noProgressCount,
      memory: this.taskMemory,
      allowArticleContinuation: Boolean(this.articleCaptureState || this.articleReadState)
    };
  }

  private logDecisionTrace(trace: DecisionTrace, policy: ModelUsePolicy): void {
    this.deps.diagnostics?.({
      source: "agent",
      category: "agent_timeline",
      action: "decide",
      taskId: this.snapshot.taskId,
      deviceId: this.currentRequest?.deviceId,
      status: "ok",
      modelRole: trace.modelRole,
      decisionTrace: trace,
      message: `${trace.reason} ${policy.reason}`,
      payload: {
        selectedId: trace.selectedId,
        selectedSource: trace.selectedSource,
        modelUsed: trace.modelUsed,
        policy
      }
    });
  }

  private plannerContext() {
    return {
      phase: this.currentPhase,
      route: this.currentRoute,
      noProgressCount: this.noProgressCount,
      lastScreenSignature: this.lastLoopScreenSignature
    };
  }

  private updatePlannerProgress(plan: PlannerOutput, action: AgentAction, screen: ScreenGraph): void {
    const screenSignature = screenProgressSignature(screen);
    const progressKey = plan.progressKey ?? actionProgressKey(action);
    const repeated = this.lastProgressKey === progressKey && this.lastLoopScreenSignature === screenSignature;
    this.noProgressCount = repeated ? this.noProgressCount + 1 : 0;
    this.lastProgressKey = progressKey;
    this.lastLoopScreenSignature = screenSignature;
    rememberDecision(this.taskMemory, plan, progressKey, screenSignature);
    this.setTaskProgress(plan.phase ?? this.currentPhase ?? initialPhaseForIntent(this.currentIntent), plan.route ?? this.currentRoute, screenSignature);
  }

  private setTaskProgress(phase?: TaskPhase, route?: string, screenSignature = this.lastLoopScreenSignature): void {
    this.currentPhase = phase;
    this.currentRoute = route;
    this.snapshot.phase = phase;
    this.snapshot.route = route;
    this.snapshot.noProgressCount = this.noProgressCount;
    this.snapshot.lastScreenSignature = screenSignature;
  }

  private shouldStopRepeatedAction(action: AgentAction): boolean {
    if (this.noProgressCount < 4) return false;
    if (action.type === "collect_scroll" && this.currentPhase === "read_article") return false;
    return action.type === "tap_xy" || action.type === "input" || action.type === "collect_scroll";
  }
}

function virtualNow(): Date {
  const value = process.env.PHONE_AGENT_TEST_NOW;
  return value ? new Date(value) : new Date();
}

function formatDiff(value: number | undefined): string {
  return typeof value === "number" ? value.toFixed(4) : "n/a";
}

export function normalizeCapturedOcrLines(lines: string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of lines) {
    const line = cleanCapturedOcrLine(raw);
    if (line.length < 8) continue;
    if (isCapturedOcrNoise(line)) continue;
    const key = normalizeArticleLineForDedupe(line);
    if (!key) continue;
    const existing = seen.get(key);
    if (!existing || line.length > existing.length) seen.set(key, line);
  }
  const result: string[] = [];
  for (const line of seen.values()) {
    const key = normalizeArticleLineForDedupe(line);
    const duplicateIndex = result.findIndex((item) => {
      const other = normalizeArticleLineForDedupe(item);
      return key.includes(other) || other.includes(key);
    });
    if (duplicateIndex >= 0) {
      if (line.length > result[duplicateIndex].length) result[duplicateIndex] = line;
      continue;
    }
    result.push(line);
  }
  return result;
}

function cleanCapturedOcrLine(value: string): string {
  return value
    .replace(/\s*([\u4e00-\u9fff])\s*/gu, "$1")
    .replace(/\b([A-Za-z])\s+([A-Za-z])\s+([A-Za-z])\b/g, "$1$2$3")
    .replace(/\b([A-Za-z])\s+([A-Za-z])\b/g, "$1$2")
    .replace(/([A-Za-z0-9])\s+([A-Za-z0-9])/g, "$1 $2")
    .replace(/\s+([,.;:!?，。；：！？、）】》])/g, "$1")
    .replace(/([（【《])\s+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function isCapturedOcrNoise(line: string): boolean {
  return /^(返回|更多|分享|收藏|复制|搜索|发送|留言|赞|在看|写留言|阅读原文)$/.test(line)
    || /^(微信|通讯录|发现|我)$/.test(line)
    || /点击|扫码|二维码|关注公众号|设为星标|投诉|广告|推荐阅读|相关阅读/.test(line)
    || /^(阅读|点赞|分享|收藏)\s*\d*$/.test(line);
}

function extractMultiArticleText(screen: ScreenGraph, account: string, fallbackTitle: string, allowContinuation: boolean): WechatArticleText | undefined {
  const officialSurface = detectWechatArticleSurface(screen, account, allowContinuation);
  if (
    officialSurface.ok
    && officialSurface.articleText
    && officialSurface.articleText.lines.length >= 2
  ) {
    return {
      ...officialSurface.articleText,
      title: fallbackTitle || officialSurface.articleText.title
    };
  }

  if (!screen.app?.includes("com.tencent.xin")) return undefined;
  const elements = [...screen.nodes, ...screen.ocrBlocks].filter((node) => node.label.trim() && isVisibleForMultiArticle(screen, node));
  const labels = elements.map((node) => node.label.trim()).filter(Boolean);
  const text = labels.join(" ");
  const webViewLike = /XCUIElementTypeWebView|MMWebView|WeixinJSBridge|js_article/.test(`${screen.rawSource ?? ""} ${text}`);
  const articleLike = webViewLike || allowContinuation || containsAny(text, [
    "\u53d1\u5e03",
    "\u9605\u8bfb\u539f\u6587",
    "\u5199\u7559\u8a00",
    "\u539f\u521b",
    "\u4f5c\u8005"
  ]);
  if (!articleLike) return undefined;

  const lines = labels
    .filter((label) => label.length >= 12)
    .filter((label) => !containsAny(label, [
      "\u8fd4\u56de",
      "\u66f4\u591a",
      "\u5206\u4eab",
      "\u6536\u85cf",
      "\u590d\u5236",
      "\u641c\u7d22",
      "\u53d1\u9001",
      "\u7559\u8a00",
      "\u9605\u8bfb\u539f\u6587",
      "\u5728\u770b",
      "\u8d5e",
      "\u8868\u60c5",
      "\u8f93\u5165"
    ]))
    .filter((label) => label !== account && label !== fallbackTitle)
    .filter((label) => !isReadableArticleMetadata(label, account))
    .filter((label, index, array) => array.indexOf(label) === index)
    .slice(0, 60);

  if (lines.length < 2 && !allowContinuation) return undefined;
  const reachedEnd = containsAny(text, [
    "\u9605\u8bfb\u539f\u6587",
    "\u5199\u7559\u8a00",
    "\u559c\u6b22\u4f5c\u8005",
    "\u5728\u770b",
    "\u5fae\u4fe1\u626b\u4e00\u626b"
  ]);
  const reachedStart = text.includes(account) || /\d{1,2}\s*\u6708\s*\d{1,2}\s*\u65e5/.test(text) || /\d{4}\s*\u5e74/.test(text);
  const screenSignature = multiArticleScreenSignature(elements);
  const contentSignature = lines.map((line) => normalizeText(line).slice(0, 120)).join("|");
  return {
    title: fallbackTitle,
    lines,
    screenSignature,
    contentSignature,
    visualSignature: screen.screenshotBase64 ? sampleBase64(screen.screenshotBase64) : undefined,
    reachedEnd,
    reachedStart
  };
}

function forceExtractMultiArticleText(screen: ScreenGraph, fallbackTitle: string): WechatArticleText | undefined {
  if (!screen.app?.includes("com.tencent.xin")) return undefined;
  const elements = [...screen.nodes, ...screen.ocrBlocks].filter((node) => node.label.trim() && isVisibleForMultiArticle(screen, node));
  const labels = elements.map((node) => node.label.trim()).filter(Boolean);
  const text = labels.join(" ");
  if (!text.includes(fallbackTitle) || !containsAny(text, ["\u53d1\u5e03", "\u9605\u8bfb\u539f\u6587", "\u5199\u7559\u8a00"])) return undefined;
  const lines = labels
    .filter((label) => label.length >= 12)
    .filter((label) => label !== fallbackTitle)
    .filter((label) => !containsAny(label, ["\u8fd4\u56de", "\u641c\u7d22", "\u9605\u8bfb\u539f\u6587", "\u5199\u7559\u8a00", "\u5728\u770b", "\u8f93\u5165"]))
    .filter((label) => !/\s*\u53d1\u5e03(?:\u4e8e)?\s*/.test(label))
    .filter((label, index, array) => array.indexOf(label) === index);
  if (lines.length < 2) return undefined;
  return {
    title: fallbackTitle,
    lines,
    screenSignature: multiArticleScreenSignature(elements),
    contentSignature: lines.map((line) => normalizeText(line).slice(0, 120)).join("|"),
    visualSignature: screen.screenshotBase64 ? sampleBase64(screen.screenshotBase64) : undefined,
    reachedEnd: containsAny(text, ["\u9605\u8bfb\u539f\u6587", "\u5199\u7559\u8a00", "\u5728\u770b"]),
    reachedStart: true
  };
}

function isVisibleForMultiArticle(screen: ScreenGraph, element: ElementRef): boolean {
  const bounds = element.bounds;
  if (!bounds) return true;
  const width = screen.screenSize?.width ?? 1170;
  const height = screen.screenSize?.height ?? 2532;
  return bounds.x + bounds.width > 0 && bounds.x < width && bounds.y + bounds.height > 0 && bounds.y < height;
}

function isReadableArticleMetadata(label: string, account: string): boolean {
  const normalized = label.replace(/\s+/g, " ").trim();
  return normalized === account
    || normalized === "\u539f\u521b"
    || normalized === "\u7f6e\u9876"
    || normalized.startsWith("\u53d1\u5e03\u4e8e")
    || new RegExp(`^${escapeRegExp(account)}\\s*\\u53d1\\u5e03`).test(normalized)
    || /^(?:\u4f5c\u8005|\u7f16\u8f91)/.test(normalized)
    || /\d{4}\s*\u5e74\s*\d{1,2}\s*\u6708\s*\d{1,2}\s*\u65e5/.test(normalized)
    || /\d{1,2}\s*\u6708\s*\d{1,2}\s*\u65e5/.test(normalized);
}

function multiArticleScreenSignature(elements: ElementRef[]): string {
  return elements
    .map((element) => `${Math.round((element.bounds?.y ?? 0) / 40)}:${normalizeText(element.label).slice(0, 80)}`)
    .slice(0, 80)
    .join("|");
}

function composeDigestSummary(lines: string[]): string {
  const candidates = lines
    .flatMap((line) => line.split(/(?<=[。！？.!?])\s*/u))
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 18)
    .filter((line, index, array) => array.indexOf(line) === index)
    .slice(0, 3);
  const summary = candidates.slice(0, 2).join("");
  return truncate(summary || lines.slice(0, 2).join(" "), 170);
}

function containsAny(value: string, tokens: string[]): boolean {
  return tokens.some((token) => value.includes(token));
}

function initialPhaseForIntent(intent: ParsedIntent | undefined): TaskPhase {
  if (!intent) return "open_app";
  if (intent.kind === "wechat_article_summary" || intent.kind === "wechat_multi_article_digest") return "open_app";
  if (intent.kind === "wechat_message") return "deliver_message";
  return "open_app";
}

function screenProgressSignature(screen: ScreenGraph): string {
  const labels = [...screen.nodes, ...screen.ocrBlocks]
    .filter((node) => {
      const bounds = node.bounds;
      if (!bounds) return true;
      return bounds.y >= 0 && (!screen.screenSize || bounds.y <= screen.screenSize.height);
    })
    .slice(0, 36)
    .map((node) => `${node.label}:${Math.round(node.bounds?.x ?? 0)},${Math.round(node.bounds?.y ?? 0)}`)
    .join("|");
  return truncate(`${screen.app ?? "unknown"}:${screen.keyboardVisible ? "keyboard" : "plain"}:${labels}`, 480);
}

function visionObservationSignature(screen: ScreenGraph): string {
  return truncate(`${screenProgressSignature(screen)}:${sampleBase64(screen.screenshotBase64 ?? "")}`, 720);
}

function sampleBase64(value: string): string {
  if (!value) return "";
  if (value.length <= 240) return value;
  const step = Math.max(1, Math.floor(value.length / 96));
  let sample = "";
  for (let index = 0; index < value.length && sample.length < 144; index += step) {
    sample += value[index];
  }
  return `${value.length}:${sample}`;
}

function actionProgressKey(action: AgentAction): string {
  switch (action.type) {
    case "tap_xy":
      return `tap:${Math.round(action.x)},${Math.round(action.y)}`;
    case "input":
      return `input:${action.text}`;
    case "input_atomic":
      return `input_atomic:${action.text}`;
    case "swipe":
      return `swipe:${Math.round(action.startX)},${Math.round(action.startY)}:${Math.round(action.endX)},${Math.round(action.endY)}`;
    case "collect_scroll":
      return `collect_scroll:${action.direction}`;
    case "scroll_until_stable":
      return `scroll_until_stable:${action.direction}:${action.maxScrolls ?? ""}:${action.stableThreshold ?? ""}`;
    case "read_wechat_article_native":
      return `read_wechat_article_native:${action.account}:${action.direction ?? "down"}`;
    case "tap_element":
      return `tap_element:${action.elementId}`;
    case "tap_text":
      return `tap_text:${action.text}`;
    case "open_app":
      return `open_app:${action.bundleId}`;
    case "open_url":
      return `open_url:${action.url}`;
    case "wait":
      return `wait:${action.reason ?? action.ms}`;
    case "back":
    case "home":
    case "ask_user":
    case "finish":
      return action.type;
  }
}

function verifyActionResult(action: AgentAction, expected: string, before: ScreenGraph, after: ScreenGraph): VerificationResult {
  const beforeSignature = screenProgressSignature(before);
  const afterSignature = screenProgressSignature(after);
  const changed = beforeSignature !== afterSignature;
  const afterText = [...after.nodes, ...after.ocrBlocks].map((node) => node.label).join(" ");
  let ok = changed;
  let actual = changed ? "屏幕内容已发生变化。" : "屏幕内容暂未出现明显变化。";
  let confidence = changed ? 0.72 : 0.42;

  if (action.type === "open_app") {
    const active = after.app ?? "";
    ok = active.includes(action.bundleId) || (action.displayName ? afterText.includes(action.displayName) : changed);
    actual = ok ? `已观察到目标 App：${action.displayName ?? action.bundleId}。` : `尚未确认目标 App 已在前台，当前 app=${active || "unknown"}。`;
    confidence = ok ? 0.86 : 0.36;
  } else if (action.type === "input" || action.type === "input_atomic") {
    const head = action.text.slice(0, Math.min(24, action.text.length));
    ok = Boolean(head && afterText.includes(head));
    actual = ok ? "已在屏幕内容中看到输入文本的一部分。" : "尚未从节点树/OCR 确认输入文本出现。";
    confidence = ok ? 0.78 : 0.45;
  } else if (action.type === "tap_text" || action.type === "tap_element" || action.type === "tap_xy") {
    ok = changed;
    actual = changed ? "点击后页面出现变化。" : "点击后页面暂未变化，后续可能需要等待或换策略。";
  } else if (action.type === "swipe" || action.type === "collect_scroll" || action.type === "scroll_until_stable") {
    ok = changed;
    actual = changed ? "滑动后页面内容发生变化。" : "滑动后画面稳定，可能已经到达边界。";
    confidence = changed ? 0.76 : 0.62;
  } else if (action.type === "back" || action.type === "home") {
    ok = changed;
    actual = changed ? "返回/主页动作后页面发生变化。" : "返回/主页动作后页面暂未变化。";
  } else if (action.type === "wait") {
    ok = true;
    actual = "等待完成，已重新观察当前页面。";
    confidence = 0.7;
  }

  return { ok, expected, actual, changed, confidence };
}

function maxStepsForIntent(intent: ParsedIntent | undefined): number {
  if (!intent) return DEFAULT_MAX_AGENT_STEPS;
  if (intent.kind === "wechat_article_summary" || intent.kind === "wechat_multi_article_digest") return WECHAT_ARTICLE_MAX_AGENT_STEPS * 2;
  if (intent.kind === "dianping_food_search") return DIANPING_MAX_AGENT_STEPS;
  return DEFAULT_MAX_AGENT_STEPS;
}

export function shouldUseDeterministicPlanner(intent: ParsedIntent): boolean {
  return intent.kind === "wechat_article_summary" || intent.kind === "wechat_multi_article_digest" || intent.kind === "wechat_message";
}

export function shouldUseVisionForIntent(
  intent: ParsedIntent | undefined,
  screen: ScreenGraph,
  context: { phase?: TaskPhase; noProgressCount?: number; memory?: TaskMemory } = {}
): boolean {
  const frame = buildPerceptionFrame(intent, screen, context);
  return modelUsePolicy(intent, frame, context).useVision;
}

function selectVisionMode(frame: ReturnType<typeof buildPerceptionFrame>, policy: ModelUsePolicy, context: { phase?: TaskPhase; noProgressCount?: number }): VisionMode {
  if (!policy.useVision) return "classify";
  if ((context.noProgressCount ?? 0) >= 2) return "elements";
  if (context.phase === "open_article" || context.phase === "read_article") return "full";
  if (frame.sourceQuality === "empty" || frame.confidence < 0.42) return "elements";
  return "classify";
}

function visionPageHints(intent: ParsedIntent | undefined): string[] {
  if (intent?.targetApp === "wechat") {
    return ["wechat_home", "wechat_search", "wechat_chat", "wechat_article", "wechat_account_home", "dialog", "login", "unknown"];
  }
  if (intent?.targetApp === "dianping") {
    return ["dianping_home", "dianping_search", "dianping_results", "dialog", "login", "unknown"];
  }
  return ["phone_home", "wechat_home", "dianping_home", "login", "dialog", "unknown"];
}

function describeAction(action: AgentAction): string {
  switch (action.type) {
    case "tap_xy":
      return `点击 (${Math.round(action.x)}, ${Math.round(action.y)})`;
    case "swipe":
      return "滑动屏幕";
    case "input":
      return `输入：${truncate(action.text, 40)}`;
    case "input_atomic":
      return `原子输入：${truncate(action.text, 40)}`;
    case "open_app":
      return `打开 ${action.displayName ?? action.bundleId}`;
    case "open_url":
      return `打开链接 ${truncate(action.url, 50)}`;
    case "home":
      return "回到主页";
    case "back":
      return "返回";
    case "wait":
      return `等待 ${action.ms}ms`;
    case "collect_scroll":
      return "滚动采集页面内容";
    case "scroll_until_stable":
      return "连续滚动直到画面稳定";
    case "read_wechat_article_native":
      return `原生阅读公众号文章：${action.account}`;
    case "tap_element":
    case "tap_text":
    case "ask_user":
    case "finish":
      return action.type;
  }
}

function isSendMessagePlan(plan: PlannerOutput, screen: ScreenGraph, intent: ParsedIntent): boolean {
  if (intent.kind !== "wechat_message") return false;
  if (/点击发送|发给/.test(plan.description) && /发送/.test(plan.expectedResult)) return true;
  if (plan.action.type === "tap_element") {
    const elementId = plan.action.elementId;
    const element = [...screen.nodes, ...screen.ocrBlocks].find((item) => item.id === elementId);
    return element?.label.trim() === "发送";
  }
  if (plan.action.type === "tap_text") return plan.action.text.trim() === "发送";
  return false;
}

export function buildWechatArticleSummaryMessage(account: string, article: ArticleForSummary): string {
  const prepared = isPreprocessedArticle(article) ? article : preprocessWechatArticleForSummary(account, article);
  const title = cleanArticleTitle(prepared.title);
  const body = composeLocalArticleSummaryBody(account, prepared);
  return sanitizeWechatOutboundMessage([
    `我读了${account}最新文章《${truncate(title, 36)}》。`,
    `简要总结：${body}`,
    "（phone-agent 自动整理）"
  ].join(" "));
}

export function buildWechatArticleSummaryMessageFromModel(
  account: string,
  article: ArticleForSummary,
  modelSummary: ArticleSummaryModelOutput | undefined
): string | undefined {
  const prepared = isPreprocessedArticle(article) ? article : preprocessWechatArticleForSummary(account, article);
  const rawSummary = modelSummary?.message ?? [
    modelSummary?.summary,
    ...(Array.isArray(modelSummary?.keyPoints) ? modelSummary.keyPoints : [])
  ].filter((item): item is string => typeof item === "string" && item.trim().length > 0).join(" ");
  const summary = sanitizeSummaryBody(rawSummary);
  if (!summary || summary.length < 24) return undefined;

  const title = cleanArticleTitle(modelSummary?.title ?? prepared.title);
  return sanitizeWechatOutboundMessage([
    `我读了${account}最新文章《${truncate(title, 36)}》。`,
    `简要总结：${truncate(summary, 190)}`,
    "（phone-agent 自动整理）"
  ].join(" "));
}

export function preprocessWechatArticleForSummary(account: string, article: ArticleForSummary): PreprocessedArticleForSummary {
  const title = cleanArticleTitle(article.title);
  const normalized = cleanArticleLines(account, { ...article, title });
  const merged = mergeWrappedArticleLines(normalized);
  const selected = selectArticleLinesForPrompt(merged);
  return {
    title,
    lines: selected,
    originalLineCount: article.lines.length,
    normalizedLineCount: merged.length,
    promptLineCount: selected.length,
    droppedLineCount: Math.max(0, article.lines.length - selected.length),
    promptCharCount: selected.join("").length
  };
}

function articleSummarySystemPrompt(): string {
  return [
    "你是 phone-agent 的公众号文章总结器。",
    "根据用户已经读取到的公众号正文生成适合微信发送给朋友的一段中文总结；正文已经在本地完成节点文本/OCR 合并、去重、排序、分段和噪声过滤。",
    "要求：只输出 JSON；summary 必须基于正文，不编造；用 1-2 句自然中文，简明扼要、通顺易读；不要写成原文摘抄或碎片拼接；不要换行；不要包含 Markdown；不要称呼收件人。",
    "JSON 格式：{\"title\":\"文章标题\",\"summary\":\"一段 80-150 字的总结\"}"
  ].join("\n");
}

function articleSummaryUserPrompt(account: string, article: ArticleForSummary): string {
  const prepared = isPreprocessedArticle(article) ? article : preprocessWechatArticleForSummary(account, article);
  const cleanedLines = prepared.lines
    .map((line, index) => `${index + 1}. ${line}`)
    .join("\n");
  return [
    `公众号：${account}`,
    `文章标题：${cleanArticleTitle(prepared.title)}`,
    isPreprocessedArticle(prepared)
      ? `本地预处理：原始 ${prepared.originalLineCount} 条，合并后 ${prepared.normalizedLineCount} 段，发送给模型 ${prepared.promptLineCount} 段。`
      : "本地预处理：已过滤导航、按钮、聊天和重复 OCR 文本。",
    "已读取正文线索（按原文顺序）：",
    cleanedLines || "当前正文线索较少。"
  ].join("\n");
}

function composeLocalArticleSummaryBody(account: string, article: ArticleForSummary): string {
  const sentences = extractSummarySentences(account, article);
  if (!sentences.length) {
    return "当前可读正文线索较少，我只能根据已读取到的内容确认文章主题，建议打开原文查看更多细节。";
  }

  return truncateSummaryAtBoundary(sentences.slice(0, 2).join(" "), 150);
}

function buildSummaryLead(sentence: string): string {
  return sentence
    .replace(/^(这篇文章|本文|文章)\s*(主要)?\s*(讨论|介绍|回顾|复盘|指出|认为|提到|梳理)[了：:]?\s*/u, "")
    .replace(/^(作者|文中)\s*(指出|认为|提到|表示)[，,:：]?\s*/u, "")
    .trim();
}

function extractSummarySentences(account: string, article: ArticleForSummary): string[] {
  const title = cleanArticleTitle(article.title);
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const line of cleanArticleLines(account, article)) {
    const parts = splitChineseSentences(line);
    for (const part of parts) {
      const sentence = normalizeSummarySentence(part);
      if (!isUsefulSummarySentence(sentence, title)) continue;
      const normalized = normalizeText(sentence);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      candidates.push(sentence);
    }
  }

  return candidates
    .sort((a, b) => scoreSummarySentence(b, title) - scoreSummarySentence(a, title))
    .slice(0, 5)
    .sort((a, b) => candidates.indexOf(a) - candidates.indexOf(b))
    .map((sentence, index) => index === 0 ? ensureSentence(buildSummaryLead(sentence)) : ensureSentence(sentence));
}

function cleanArticleLines(account: string, article: ArticleForSummary): string[] {
  const title = cleanArticleTitle(article.title);
  const seen = new Map<string, string>();
  for (const rawLine of article.lines) {
    const line = cleanArticleLine(rawLine);
    if (line.length < 10) continue;
    if (line === title || isArticleMetadataLine(line, account)) continue;
    if (/返回|更多|分享|收藏|复制|搜索|发送|留言|赞|在看|阅读原文|投诉|广告|微信扫一扫|语音|表情|按住说话|输入/.test(line)) continue;
    if (/点击|扫码|二维码|关注公众号|星标|设为星标|转载|授权|免责声明/.test(line)) continue;
    const key = normalizeArticleLineForDedupe(line);
    if (!key) continue;
    const existing = seen.get(key);
    if (!existing || line.length > existing.length) seen.set(key, line);
  }

  const result: string[] = [];
  for (const line of seen.values()) {
    const normalized = normalizeArticleLineForDedupe(line);
    const duplicateIndex = result.findIndex((item) => {
      const other = normalizeArticleLineForDedupe(item);
      return normalized.includes(other) || other.includes(normalized);
    });
    if (duplicateIndex >= 0) {
      if (line.length > result[duplicateIndex].length) result[duplicateIndex] = line;
      continue;
    }
    result.push(line);
  }
  return result;
}

function isPreprocessedArticle(article: ArticleForSummary): article is PreprocessedArticleForSummary {
  return typeof (article as Partial<PreprocessedArticleForSummary>).promptLineCount === "number";
}

function mergeWrappedArticleLines(lines: string[]): string[] {
  const result: string[] = [];
  let buffer = "";
  for (const line of lines) {
    if (!buffer) {
      buffer = line;
      continue;
    }
    if (shouldMergeWrappedLine(buffer, line)) {
      buffer = `${buffer}${needsAsciiSpace(buffer, line) ? " " : ""}${line}`.trim();
      continue;
    }
    result.push(buffer);
    buffer = line;
  }
  if (buffer) result.push(buffer);
  return result;
}

function shouldMergeWrappedLine(previous: string, next: string): boolean {
  if (previous.length >= 110 || next.length >= 90) return false;
  if (/[。！？；;.!?]$/.test(previous)) return false;
  if (/^(第[一二三四五六七八九十\d]+|[一二三四五六七八九十\d]+[、.])/.test(next)) return false;
  if (/^[#●•\-—]/.test(next)) return false;
  return previous.length + next.length <= 150;
}

function selectArticleLinesForPrompt(lines: string[]): string[] {
  if (lines.length <= ARTICLE_SUMMARY_PROMPT_LINE_BUDGET && lines.join("").length <= ARTICLE_SUMMARY_PROMPT_CHAR_BUDGET) return lines;
  const selected = new Set<number>();
  const headCount = Math.min(18, lines.length);
  const tailCount = Math.min(18, Math.max(0, lines.length - headCount));
  for (let index = 0; index < headCount; index += 1) selected.add(index);
  for (let index = Math.max(headCount, lines.length - tailCount); index < lines.length; index += 1) selected.add(index);

  const middleStart = headCount;
  const middleEnd = Math.max(middleStart, lines.length - tailCount);
  const remainingSlots = Math.max(0, ARTICLE_SUMMARY_PROMPT_LINE_BUDGET - selected.size);
  if (remainingSlots > 0 && middleEnd > middleStart) {
    const step = Math.max(1, Math.ceil((middleEnd - middleStart) / remainingSlots));
    for (let index = middleStart; index < middleEnd && selected.size < ARTICLE_SUMMARY_PROMPT_LINE_BUDGET; index += step) {
      selected.add(index);
    }
  }

  const result: string[] = [];
  let charCount = 0;
  for (const index of [...selected].sort((a, b) => a - b)) {
    const line = lines[index];
    if (!line) continue;
    if (result.length >= ARTICLE_SUMMARY_PROMPT_LINE_BUDGET) break;
    if (charCount + line.length > ARTICLE_SUMMARY_PROMPT_CHAR_BUDGET && result.length >= 12) continue;
    result.push(line);
    charCount += line.length;
  }
  return result;
}

function normalizeArticleLineForDedupe(line: string): string {
  return normalizeText(line)
    .replace(/[\p{P}\p{S}]/gu, "")
    .toLowerCase();
}

function needsAsciiSpace(left: string, right: string): boolean {
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
}

function cleanArticleTitle(title: string): string {
  const cleaned = cleanArticleLine(title);
  if (!cleaned || /专业的人工智能媒体|产业服务平台|最新文章|公众号主页/.test(cleaned)) return "最新文章";
  return cleaned;
}

function cleanArticleLine(line: string): string {
  return line
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .replace(/^[,，。；：:\s]+/, "")
    .replace(/^(我|你|对方|微信用户)[，,]\s*/u, "")
    .replace(/[（(]\s*phone-agent 自动整理\s*[）)]/g, "")
    .trim();
}

function splitChineseSentences(line: string): string[] {
  const segments = line
    .split(/(?<=[。！？；;!?])\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);
  return segments.length ? segments : [line];
}

function normalizeSummarySentence(sentence: string): string {
  return sentence
    .replace(/\s+([，。；：！？、）])/g, "$1")
    .replace(/([（])\s+/g, "$1")
    .trim();
}

function isUsefulSummarySentence(sentence: string, title: string): boolean {
  if (sentence.length < 18 || sentence.length > 140) return false;
  if (title !== "最新文章" && sentence === title) return false;
  if (/^\d{4}年|\d{1,2}月\d{1,2}日|^(作者|编辑|来源|发布于)/.test(sentence)) return false;
  if (/点击|扫码|二维码|关注|星标|阅读原文|留言|赞|分享|投诉|广告/.test(sentence)) return false;
  return /[\u4e00-\u9fa5A-Za-z]/.test(sentence);
}

function scoreSummarySentence(sentence: string, title: string): number {
  let score = Math.min(sentence.length, 80) / 10;
  if (/核心|关键|主要|重点|路线|方法|框架|系统|模型|数据|训练|能力|挑战|未来|落地|开源|研究|机器人|具身|智能|AI|DeepMind|Google|RT|SayCan/i.test(sentence)) score += 8;
  if (/指出|认为|显示|意味着|提出|复盘|回顾|解释|强调/.test(sentence)) score += 4;
  for (const token of titleKeywords(title)) {
    if (sentence.includes(token)) score += 2;
  }
  if (/你可能|我们先|首先|最后|结尾/.test(sentence)) score -= 1.5;
  return score;
}

function titleKeywords(title: string): string[] {
  if (title === "最新文章") return [];
  return [...title.matchAll(/[A-Za-z0-9-]{2,}|[\u4e00-\u9fa5]{2,}/g)]
    .map((match) => match[0])
    .filter((token) => token.length >= 2)
    .slice(0, 8);
}

function ensureSentence(sentence: string): string {
  const trimmed = sentence.trim();
  if (!trimmed) return trimmed;
  return /[。！？.!?]$/.test(trimmed) ? trimmed : `${trimmed}。`;
}

function sanitizeSummaryBody(value: string | undefined): string {
  if (!value) return "";
  return ensureSentence(sanitizeWechatOutboundMessage(value)
    .replace(/^简要总结[:：]\s*/u, "")
    .replace(/^摘要[:：]\s*/u, "")
    .trim());
}

function truncateSummaryAtBoundary(value: string, maxLength: number): string {
  const cleaned = sanitizeSummaryBody(value);
  if (cleaned.length <= maxLength) return cleaned;
  const head = cleaned.slice(0, maxLength);
  const lastBoundary = Math.max(head.lastIndexOf("。"), head.lastIndexOf("！"), head.lastIndexOf("？"), head.lastIndexOf("；"));
  if (lastBoundary >= Math.floor(maxLength * 0.55)) return head.slice(0, lastBoundary + 1);
  return ensureSentence(truncate(head, maxLength - 1));
}

export function isArticleReadComplete(state: ArticleReadState): boolean {
  if (state.direction === "up") {
    if (state.screenCount >= ARTICLE_MAX_REVERSE_SCREENS) return true;
    if (state.lines.length < ARTICLE_MIN_LINES_FOR_SUMMARY) {
      return state.unchangedScrollCount >= ARTICLE_STABLE_SCREENS_TO_ASSUME_END;
    }
    if (!state.reachedStart) return state.unchangedScrollCount >= ARTICLE_STABLE_SCREENS_TO_ASSUME_END;
    return state.unchangedScrollCount >= ARTICLE_STABLE_SCREENS_TO_ASSUME_END;
  }
  if (state.screenCount >= ARTICLE_MAX_SCREENS) return true;
  if (state.lines.length < ARTICLE_MIN_LINES_FOR_SUMMARY) {
    return state.reverseAttempted && state.unchangedScrollCount >= ARTICLE_STABLE_SCREENS_TO_ASSUME_END;
  }
  if (state.screenCount < ARTICLE_MIN_SCREENS_BEFORE_SUMMARY) return false;
  return state.reachedEnd || state.unchangedScrollCount >= ARTICLE_STABLE_SCREENS_TO_ASSUME_END;
}

function sanitizeWechatOutboundMessage(message: string): string {
  return message
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([，。；：！？、）])/g, "$1")
    .trim();
}

function isArticleMetadataLine(label: string, account: string): boolean {
  const normalized = label.replace(/\s+/g, " ").trim();
  return normalized === account
    || normalized === "原创"
    || normalized === "置顶"
    || /^发布于：?/.test(normalized)
    || /^\d{4}年\d{1,2}月\d{1,2}日\s*\d{0,2}:?\d{0,2}$/.test(normalized)
    || new RegExp(`^${escapeRegExp(account)}\\s*发布`).test(normalized)
    || /^(作者|编辑|机器之心编辑部)[:：]/.test(normalized);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function humanizeFailure(error: unknown): string {
  if (error instanceof LlmRequestError) {
    if (error.provider === "vision") {
      if (error.status === 401 || error.status === 403) return "视觉模型 API Key 无效或没有权限；已降级为节点树观察。";
      return `视觉模型请求失败：${error.status ?? ""} ${error.statusText ?? ""}`.trim();
    }
    if (error.status === 401 || error.status === 403) return "模型 API Key 无效或没有权限；已停用模型规划，可检查密钥后重试。";
    return `模型请求失败：${error.status ?? ""} ${error.statusText ?? ""}`.trim();
  }

  if (error instanceof KuaijsRequestError) {
    if (isEndpointUnauthorizedLike(error, "/api/ime/")) return "快点JS API键盘未授权或未启用，请在手机输入法中启用快点JS API键盘。";
    if (error.status === 401 || error.status === 403) return `快点JS接口被拒绝：${error.endpoint}`;
  }

  if (error instanceof KuaiProjectRuntimeError) {
    return `快点JS项目运行时不可用：${error.message}`;
  }

  const message = safeError(error);
  if (/fetch failed|ECONNREFUSED|timeout|aborted/i.test(message)) {
    return "手机连接不稳定或快点JS暂时没有响应，请确认手机和电脑在同一局域网。";
  }
  if (/LLM.*(401|403)|模型.*(401|403)/i.test(message)) {
    return "模型 API Key 无效或没有权限；请重新保存 API Key 或切换可用模型。";
  }
  if (/\/api\/ime\/.*(401|403)|IME.*(401|403)/i.test(message)) {
    return "快点JS API键盘未授权或未启用。";
  }
  if (/\/api\/control\/.*(401|403)|control.*(401|403)/i.test(message)) {
    return "控制接口被拒绝，请在快点JS/群控工具完成授权。";
  }
  if (/401|403/.test(message)) {
    return "接口拒绝访问，但来源不明确；请分别检查模型 Key 与快点JS授权。";
  }
  return message;
}

function isInputAuthorizationFailure(error: unknown): boolean {
  if (error instanceof KuaijsRequestError) return isEndpointUnauthorizedLike(error, "/api/ime/");
  return /ime|input|keyboard|API键盘/i.test(safeError(error)) && /401|403|Unauthorized|Forbidden|未授权/i.test(safeError(error));
}

function isRuntimeRequestSentButUnverified(error: unknown): boolean {
  const message = safeError(error);
  return /request was sent|运行请求已发送|PHONE_AGENT_RESULT was not captured|could not be verified/i.test(message);
}

function isEndpointUnauthorizedLike(error: KuaijsRequestError, endpointPrefix?: string): boolean {
  const endpointMatches = endpointPrefix ? error.endpoint.startsWith(endpointPrefix) : true;
  return endpointMatches && (error.status === 401 || error.status === 403);
}
