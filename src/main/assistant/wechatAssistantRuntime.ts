import type {
  AgentSnapshot,
  AgentAction,
  AppSettings,
  AssistantJob,
  AssistantMonitorState,
  ChatCommand,
  ChatMessage,
  DeviceRecord,
  DiagnosticEvent,
  ElementRef,
  ScreenGraph,
  WhitelistEntry
} from "../../shared/types";
import { AgentRuntime } from "../agent/runtime";
import { ControlRouter } from "../controlRouter";
import { KuaijsClient } from "../kuaijsClient";
import { LlmClient } from "../llmClient";
import { buildScreenGraph, findElement } from "../screenGraph";
import { safeError, sleep, truncate } from "../utils";
import { VisionClient } from "../visionClient";
import { parseIntent } from "../agent/intent";
import { AssistantJobQueue, jobStatusFromError } from "./assistantJobQueue";
import {
  AssistantStateStore,
  PersistedAssistantState,
  rememberJob,
  rememberOutgoing,
  rememberProcessed
} from "./assistantStateStore";
import { ChatCommandClassifier } from "./chatCommandClassifier";
import {
  extractWechatChatMessages,
  isMonitorChatScreen,
} from "./wechatChatExtractor";
import { WebResearchClient, formatResearchResultForWechat } from "./webResearchClient";

type DiagnosticSink = (event: Omit<DiagnosticEvent, "id" | "timestamp">) => void;

export interface WechatAssistantRuntimeDeps {
  userDataDir: string;
  device: DeviceRecord;
  getSettings: () => AppSettings;
  kuaijs: KuaijsClient;
  control: ControlRouter;
  llm: LlmClient;
  vision?: VisionClient;
  diagnostics?: DiagnosticSink;
}

export interface WechatAssistantRunOptions {
  monitorContact: string;
  pollMs: number;
  monitorOnce: boolean;
}

interface RuntimeConfirmation {
  jobId: string;
  agent: AgentRuntime;
  confirmationId: string;
}

export class WechatAssistantRuntime {
  private readonly queue = new AssistantJobQueue();
  private readonly store: AssistantStateStore;
  private readonly classifier: ChatCommandClassifier;
  private readonly webResearch: WebResearchClient;
  private persisted: PersistedAssistantState = {
    processedMessageSignatures: [],
    outgoingMessageSignatures: [],
    jobs: [],
    updatedAt: Date.now()
  };
  private stopped = false;
  private currentAgent?: AgentRuntime;
  private pendingApprovalJob?: AssistantJob;
  private pendingRuntimeConfirmation?: RuntimeConfirmation;
  private approvedRecipientsByJob = new Map<string, string>();
  private lastReply?: string;
  private monitorContact = "";
  private bootstrapExistingMessages = false;

  constructor(private readonly deps: WechatAssistantRuntimeDeps) {
    this.store = new AssistantStateStore(deps.userDataDir);
    this.classifier = new ChatCommandClassifier(deps.llm);
    this.webResearch = new WebResearchClient(deps.llm, deps.diagnostics);
  }

  async start(options: WechatAssistantRunOptions): Promise<AssistantMonitorState> {
    this.monitorContact = options.monitorContact;
    this.persisted = await this.store.load();
    this.bootstrapExistingMessages = this.persisted.monitorContact !== options.monitorContact
      || this.persisted.processedMessageSignatures.length === 0;
    this.persisted.monitorContact = options.monitorContact;
    await this.saveState();
    this.log("start", "ok", `开始监听微信聊天：${options.monitorContact}`);

    if (options.monitorOnce) {
      return this.tick();
    }

    while (!this.stopped) {
      await this.tick();
      await sleep(options.pollMs);
    }
    return this.state("stopped");
  }

  stop(): void {
    this.stopped = true;
    void this.currentAgent?.stop();
  }

  async tick(): Promise<AssistantMonitorState> {
    const screen = await this.ensureMonitorChat();
    const messages = extractWechatChatMessages(screen, this.monitorContact);
    this.log("observed", "ok", `读取到 ${messages.length} 条聊天消息。`, {
      latest: messages.at(-1)?.text,
      incoming: messages.filter((message) => message.direction === "incoming").length
    });

    if (this.bootstrapExistingMessages) {
      for (const message of messages.filter((item) => item.direction === "incoming")) {
        this.persisted = rememberProcessed(this.persisted, message.signature);
      }
      this.bootstrapExistingMessages = false;
      await this.saveState();
      this.log("bootstrap", "ok", "首次监听已记录当前聊天历史，等待后续新消息。", {
        incomingCount: messages.filter((message) => message.direction === "incoming").length
      });
      return this.state("idle", messages.at(-1)?.signature);
    }

    for (const message of messages.filter((item) => item.direction === "incoming")) {
      if (this.persisted.processedMessageSignatures.includes(message.signature)) continue;
      await this.handleIncomingMessage(message);
    }

    await this.processNextJob();
    return this.state(this.queue.hasActiveJob() ? "processing" : "idle", messages.at(-1)?.signature);
  }

  private async handleIncomingMessage(message: ChatMessage): Promise<void> {
    this.persisted = rememberProcessed(this.persisted, message.signature);
    await this.saveState();
    const command = await this.classifier.classify(message, {
      monitorContact: this.monitorContact,
      hasRunningJob: this.queue.hasActiveJob(),
      hasPendingConfirmation: Boolean(this.pendingApprovalJob || this.pendingRuntimeConfirmation)
    });
    this.log("classified", "ok", `消息分类：${command.kind}`, {
      confidence: command.confidence,
      instruction: command.instruction,
      needsConfirmation: command.needsConfirmation
    });
    await this.handleCommand(command, message);
  }

  private async handleCommand(command: ChatCommand, message: ChatMessage): Promise<void> {
    if (command.kind === "chat") {
      if (command.reply && command.confidence >= 0.85) await this.sendReply(command.reply);
      return;
    }
    if (command.kind === "clarify" || (command.kind === "task" && command.confidence < 0.62)) {
      await this.sendReply(command.reply ?? "这条指令我还不够确定，你可以再明确一下要我做什么。");
      return;
    }
    if (command.kind === "status") {
      await this.sendReply(this.statusText());
      return;
    }
    if (command.kind === "cancel") {
      await this.cancelActiveJob();
      return;
    }
    if (command.kind === "pause") {
      await this.currentAgent?.pause();
      await this.sendReply("已暂停当前任务。");
      return;
    }
    if (command.kind === "resume") {
      await this.currentAgent?.resume();
      await this.sendReply("已继续当前任务。");
      return;
    }
    if (command.kind === "confirm") {
      await this.handleConfirmation(command.approved !== false);
      return;
    }
    if (command.kind === "task") {
      const instruction = normalizeTaskInstruction(command.instruction ?? message.text, this.monitorContact);
      if (isBlockedSensitiveInstruction(instruction)) {
        await this.sendReply("这类涉及支付、转账、删除、账号或公开发布的操作我不会自动提交，需要你亲自处理。");
        return;
      }
      const job = this.queue.enqueue({
        instruction,
        sourceMessageSignature: message.signature,
        type: chooseJobType(instruction)
      });
      this.persisted = rememberJob(this.persisted, job);
      await this.saveState();
      await this.sendReply(command.reply ?? "收到，我开始处理。");
      this.log("job_enqueued", "ok", `任务已入队：${truncate(instruction, 80)}`, { job });
    }
  }

  private async processNextJob(): Promise<void> {
    if (this.queue.current()?.status === "running" || this.queue.current()?.status === "waiting_confirmation") return;
    const job = this.queue.nextPending();
    if (!job) return;

    const recipient = deliveryRecipient(job.instruction);
    if (job.type === "phone" && recipient && recipient !== this.monitorContact && !isTrustedRecipient(recipient, this.deps.getSettings().whitelist) && !this.approvedRecipientsByJob.has(job.id)) {
      const prompt = `任务需要向“${recipient}”发送或转发内容。请回复“确认”继续，或回复“取消”放弃。`;
      const waiting = this.queue.update(job.id, { status: "waiting_confirmation", confirmationPrompt: prompt });
      this.pendingApprovalJob = waiting;
      if (waiting) this.persisted = rememberJob(this.persisted, waiting);
      await this.saveState();
      await this.sendReply(prompt);
      return;
    }

    const running = this.queue.update(job.id, { status: "running" });
    if (running) this.persisted = rememberJob(this.persisted, running);
    await this.saveState();
    this.log("job_started", "ok", `开始执行任务：${truncate(job.instruction, 80)}`, { job });

    if (job.type === "backend") {
      await this.runBackendJob(job);
    } else {
      await this.runPhoneJob(job);
    }
  }

  private async runBackendJob(job: AssistantJob): Promise<void> {
    try {
      const result = await this.webResearch.research(job.instruction);
      const message = formatResearchResultForWechat(result);
      const finished = this.queue.update(job.id, { status: "finished", resultMessage: message });
      if (finished) this.persisted = rememberJob(this.persisted, finished);
      await this.saveState();
      await this.sendReply(message);
    } catch (error) {
      const failed = this.queue.update(job.id, jobStatusFromError(error));
      if (failed) this.persisted = rememberJob(this.persisted, failed);
      await this.saveState();
      await this.sendReply(`联网查阅失败：${safeError(error)}`);
    }
  }

  private async runPhoneJob(job: AssistantJob): Promise<void> {
    const agent = this.createAgentRuntime(job);
    this.currentAgent = agent;
    try {
      await agent.start({
        instruction: job.instruction,
        deviceId: this.deps.device.id,
        autonomy: "task_scoped",
        sensitivePolicy: "confirm_final"
      });
      const snapshot = await waitForTerminalSnapshot(agent, 900000);
      if (snapshot.state === "waiting_confirmation" && snapshot.pendingConfirmation) {
        this.pendingRuntimeConfirmation = { jobId: job.id, agent, confirmationId: snapshot.pendingConfirmation.id };
        const waiting = this.queue.update(job.id, {
          status: "waiting_confirmation",
          confirmationPrompt: snapshot.pendingConfirmation.message
        });
        if (waiting) this.persisted = rememberJob(this.persisted, waiting);
        await this.saveState();
        await this.ensureMonitorChat();
        await this.sendReply(`任务需要确认：${snapshot.pendingConfirmation.message} 请回复“确认”或“取消”。`);
        return;
      }
      await this.finishPhoneJob(job, snapshot);
    } catch (error) {
      const failed = this.queue.update(job.id, jobStatusFromError(error));
      if (failed) this.persisted = rememberJob(this.persisted, failed);
      await this.saveState();
      await this.ensureMonitorChat();
      await this.sendReply(`任务失败：${safeError(error)}`);
    } finally {
      if (!this.pendingRuntimeConfirmation) this.currentAgent = undefined;
    }
  }

  private async finishPhoneJob(job: AssistantJob, snapshot: AgentSnapshot): Promise<void> {
    const ok = snapshot.state === "finished";
    const lastDetail = snapshot.timeline.at(-1)?.detail ?? (ok ? "任务完成。" : "任务未完成。");
    const updated = this.queue.update(job.id, ok ? { status: "finished", resultMessage: lastDetail } : { status: "failed", error: lastDetail });
    if (updated) this.persisted = rememberJob(this.persisted, updated);
    await this.saveState();
    await this.ensureMonitorChat();
    await this.sendReply(ok ? `完成了：${truncate(lastDetail, 180)}` : `任务没有完成：${truncate(lastDetail, 180)}`);
  }

  private async handleConfirmation(approved: boolean): Promise<void> {
    if (this.pendingRuntimeConfirmation) {
      const pending = this.pendingRuntimeConfirmation;
      this.pendingRuntimeConfirmation = undefined;
      if (!approved) {
        await pending.agent.stop();
        const cancelled = this.queue.update(pending.jobId, { status: "cancelled", error: "控制者取消确认。" });
        if (cancelled) this.persisted = rememberJob(this.persisted, cancelled);
        await this.saveState();
        await this.sendReply("已取消这一步。");
        return;
      }
      await pending.agent.confirm({ confirmationId: pending.confirmationId, approved: true });
      const snapshot = await waitForTerminalSnapshot(pending.agent, 900000);
      const job = this.queue.all().find((item) => item.id === pending.jobId);
      if (job) await this.finishPhoneJob(job, snapshot);
      return;
    }

    if (!this.pendingApprovalJob) {
      await this.sendReply("当前没有等待确认的任务。");
      return;
    }
    const job = this.pendingApprovalJob;
    this.pendingApprovalJob = undefined;
    if (!approved) {
      const cancelled = this.queue.update(job.id, { status: "cancelled", error: "控制者取消确认。" });
      if (cancelled) this.persisted = rememberJob(this.persisted, cancelled);
      await this.saveState();
      await this.sendReply("已取消这个任务。");
      return;
    }
    const recipient = deliveryRecipient(job.instruction);
    if (recipient) this.approvedRecipientsByJob.set(job.id, recipient);
    const pending = this.queue.update(job.id, { status: "pending" });
    if (pending) this.persisted = rememberJob(this.persisted, pending);
    await this.saveState();
    await this.sendReply("确认收到，我继续执行。");
    await this.processNextJob();
  }

  private async cancelActiveJob(): Promise<void> {
    await this.currentAgent?.stop();
    this.pendingRuntimeConfirmation = undefined;
    this.pendingApprovalJob = undefined;
    const cancelled = this.queue.cancelRunning("控制者取消。");
    if (cancelled) this.persisted = rememberJob(this.persisted, cancelled);
    await this.saveState();
    await this.sendReply(cancelled ? "已取消当前任务。" : "当前没有正在执行的任务。");
  }

  private createAgentRuntime(job: AssistantJob): AgentRuntime {
    const recipient = this.approvedRecipientsByJob.get(job.id);
    return new AgentRuntime({
      getSettings: () => recipient ? settingsWithTemporaryTrust(this.deps.getSettings(), recipient) : this.deps.getSettings(),
      getDevice: (deviceId) => deviceId === this.deps.device.id ? this.deps.device : undefined,
      kuaijs: this.deps.kuaijs,
      control: this.deps.control,
      llm: this.deps.llm,
      vision: this.deps.vision,
      diagnostics: this.deps.diagnostics
    });
  }

  private async ensureMonitorChat(): Promise<ScreenGraph> {
    let screen = await this.observe();
    if (isMonitorChatScreen(screen, this.monitorContact)) return screen;

    await this.executeControl({ type: "open_app", bundleId: "com.tencent.xin", displayName: "微信" });
    await sleep(1200);
    screen = await this.observe();
    if (isMonitorChatScreen(screen, this.monitorContact)) return screen;

    if (findElement(screen, "返回")) {
      await this.tapElement(screen, "返回");
      await sleep(700);
      screen = await this.observe();
      if (isMonitorChatScreen(screen, this.monitorContact)) return screen;
    }

    const bottomWechat = [...screen.nodes, ...screen.ocrBlocks]
      .filter((element) => element.label === "微信" && (element.bounds?.y ?? 0) > 2100)
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
    if (bottomWechat) {
      await this.tapElementRef(bottomWechat);
      await sleep(700);
      screen = await this.observe();
    }

    const contactElement = findElement(screen, this.monitorContact);
    if (contactElement && contactElement.bounds) {
      await this.tapElementRef(contactElement);
      await sleep(1200);
      screen = await this.observe();
      if (isMonitorChatScreen(screen, this.monitorContact)) return screen;
    }

    const searchElement = findElement(screen, "搜索");
    if (searchElement?.bounds) {
      await this.tapElementRef(searchElement);
      await sleep(600);
      await this.executeControl({ type: "input", text: this.monitorContact });
      await sleep(1200);
      screen = await this.observe();
      const result = findElement(screen, this.monitorContact);
      if (result?.bounds) {
        await this.tapElementRef(result);
        await sleep(1200);
        screen = await this.observe();
      }
    }

    return screen;
  }

  private async sendReply(text: string): Promise<void> {
    const message = sanitizeOutgoingMessage(text);
    const screen = await this.ensureMonitorChat();
    const input = findChatInput(screen);
    if (input?.bounds) {
      await this.tapElementRef(input);
      await sleep(500);
    }
    await this.executeControl({ type: "input", text: message });
    await sleep(800);
    const afterInput = await this.observe();
    const send = findElement(afterInput, "发送");
    if (send?.bounds) {
      await this.tapElementRef(send);
    } else if (afterInput.screenSize) {
      await this.executeControl({
        type: "tap_xy",
        x: afterInput.screenSize.width - 140,
        y: afterInput.screenSize.height - 300,
        coordinateSpace: "screen"
      });
    }
    this.lastReply = message;
    await sleep(700);
    const sentScreen = await this.observe();
    const latestOutgoing = extractWechatChatMessages(sentScreen, this.monitorContact)
      .filter((item) => item.direction === "outgoing")
      .at(-1);
    if (latestOutgoing) this.persisted = rememberOutgoing(this.persisted, latestOutgoing.signature);
    await this.saveState();
    this.log("reply_sent", "ok", "已向监控聊天发送回复。", { textChars: message.length });
  }

  private async tapElement(screen: ScreenGraph, label: string): Promise<void> {
    const element = findElement(screen, label);
    if (!element) throw new Error(`没有找到可点击元素：${label}`);
    await this.tapElementRef(element);
  }

  private async tapElementRef(element: ElementRef): Promise<void> {
    if (!element.bounds) throw new Error("目标元素没有坐标。");
    const center = {
      x: element.bounds.x + element.bounds.width / 2,
      y: element.bounds.y + element.bounds.height / 2
    };
    await this.executeControl({ type: "tap_xy", x: center.x, y: center.y, coordinateSpace: "screen" });
  }

  private async executeControl(action: AgentAction): Promise<void> {
    try {
      await this.deps.control.execute(this.deps.device, action);
    } catch (error) {
      if (/request was sent|PHONE_AGENT_RESULT was not captured|could not be verified/i.test(safeError(error))) {
        this.log("control_unverified", "ok", "快点JS已发出动作请求，但没有捕获脚本结果；继续通过观察校验。", { action: action.type });
        return;
      }
      throw error;
    }
  }

  private async observe(): Promise<ScreenGraph> {
    const [screenshot, source, activeApp] = await Promise.allSettled([
      this.deps.kuaijs.screenshotBase64(this.deps.device),
      this.deps.kuaijs.source(this.deps.device),
      this.deps.kuaijs.activeAppInfo(this.deps.device)
    ]);
    return buildScreenGraph({
      screenshotBase64: screenshot.status === "fulfilled" ? screenshot.value : undefined,
      source: source.status === "fulfilled" ? source.value : undefined,
      activeApp: activeApp.status === "fulfilled" ? activeApp.value : undefined
    });
  }

  private state(status: AssistantMonitorState["status"], lastMessageSignature?: string): AssistantMonitorState {
    return {
      monitorContact: this.monitorContact,
      status,
      lastObservedAt: Date.now(),
      lastMessageSignature,
      processedCount: this.persisted.processedMessageSignatures.length,
      queuedJobs: this.queue.queuedCount(),
      currentJob: this.queue.current(),
      lastReply: this.lastReply
    };
  }

  private statusText(): string {
    const current = this.queue.current();
    if (!current) return "我在，当前空闲。";
    return `我在，当前任务状态：${current.status}，任务：${truncate(current.instruction, 80)}`;
  }

  private async saveState(): Promise<void> {
    await this.store.save({
      ...this.persisted,
      monitorContact: this.monitorContact,
      jobs: this.queue.all().map((job) => ({
        id: job.id,
        instruction: job.instruction.slice(0, 200),
        status: job.status,
        type: job.type,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt
      }))
    });
  }

  private log(action: string, status: "running" | "ok" | "failed", message: string, payload?: unknown): void {
    const category = action.startsWith("job_") ? "assistant_job" : "chat_monitor";
    this.deps.diagnostics?.({
      source: "assistant",
      category,
      action,
      status,
      message,
      payload
    });
  }
}

async function waitForTerminalSnapshot(agent: AgentRuntime, timeoutMs: number): Promise<AgentSnapshot> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const snapshot = agent.getSnapshot();
    if (snapshot.state === "finished" || snapshot.state === "stuck" || snapshot.state === "waiting_confirmation") {
      return snapshot;
    }
    await sleep(1000);
  }
  await agent.stop();
  return agent.getSnapshot();
}

function chooseJobType(instruction: string): AssistantJob["type"] {
  if (/(微信|公众号|大众点评|点评|美食|餐厅|发给|发送给|转发给|问问|打开|浏览|手机|App|app)/i.test(instruction)) return "phone";
  if (/(查|搜索|搜一下|联网|新闻|资料|是什么|为什么|怎么|http:\/\/|https:\/\/)/i.test(instruction)) return "backend";
  return "phone";
}

function normalizeTaskInstruction(instruction: string, monitorContact: string): string {
  let normalized = instruction.trim()
    .replace(/发给我|发我|给我/g, `发给${monitorContact}`)
    .replace(/告诉我/g, `发给${monitorContact}`);
  if (/公众号|文章/.test(normalized) && !/(发给|发送给|转发给)/.test(normalized)) {
    normalized = `${normalized}，总结后发给${monitorContact}`;
  }
  return normalized;
}

function deliveryRecipient(instruction: string): string | undefined {
  const intent = parseIntent(instruction);
  const parsed = intent.delivery?.name ?? intent.contact;
  if (parsed) return parsed;
  const match = instruction.match(/(?:发给|发送给|转发给|问问)\s*([^，。,.\s：:]+(?:群聊|群)?)/);
  return match?.[1]?.trim();
}

function isTrustedRecipient(recipient: string, whitelist: WhitelistEntry[]): boolean {
  return whitelist.some((entry) => entry.autoSend && entry.label === recipient);
}

function settingsWithTemporaryTrust(settings: AppSettings, recipient: string): AppSettings {
  return {
    ...settings,
    whitelist: [
      ...settings.whitelist,
      {
        id: `assistant_approved_${recipient}`,
        label: recipient,
        kind: /群/.test(recipient) ? "group" : "contact",
        autoSend: true
      }
    ]
  };
}

function isBlockedSensitiveInstruction(instruction: string): boolean {
  return /(支付|付款|转账|红包|收款|提现|银行卡|验证码|删除|注销|退出登录|改密码|修改密码|账号修改|隐私设置|公开发布|朋友圈发布|下单|确认订单)/.test(instruction);
}

function findChatInput(screen: ScreenGraph) {
  return [...screen.nodes, ...screen.ocrBlocks]
    .filter((element) => /TextView|输入|语音输入|全屏输入|按住说话/i.test(`${element.role ?? ""} ${element.label}`))
    .sort((a, b) => (b.bounds?.y ?? 0) - (a.bounds?.y ?? 0))[0];
}

function sanitizeOutgoingMessage(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 1800);
}
