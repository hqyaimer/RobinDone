// ============================================================
// Agent Contact - shared wait registry + master/worker port factories
// ============================================================
// 2026-11-19 定稿（docs/trigger-system.md「agent 消息与会话感知系统」）：HTTP 请求/
// 响应模型。ContactAgent 发起请求，回复 = 接收端被请求触发轮次的最终输出，系统在
// 轮终态自动捕获回投（无回复工具、无 nudge，活性是结构保证）。
//
// 2026-11-20 worker 会话模型同构化（docs/worker-session-model.md §2/§3）：worker 会话
// = 主会话路径物化的并行会话（同 workspace 全部会话共用一个 CLI 进程）→ 等待登记表
// 升格为进程共享事实源（bootstrap 注入；各会话轮终态捕获按接收方 sessionId 结算），
// master↔worker 投递统一经 AgentSessionDispatchPort 落到 Host 任务服务（机制同触发器
// 投递）。捕获点（全部按接收方 sessionId 匹配，worker/master 会话同构生效）：
// - 各主会话轮终态：runtime turn.ts（成功取 modelResponse，取消/失败走合成）；
// - 真实用户 prompt 起跑：runtime-command-queue.ts 合成解除（用户接管话语权裁决）。
// 交付：有等待者 → 工具结果；无等待者 → 注入发送端会话 + 唤醒（回复交付矩阵）。

import { randomUUID } from "node:crypto";
import type {
  AgentContactPort,
  AgentContactSubmitRequest,
  AgentContactSubmitResult,
  AgentContactWaitResult,
  AgentSessionDispatchPort,
  SessionId,
  TraceContext,
} from "@robindone/contracts";
import { agentContactRestartInterruptedReply } from "@robindone/contracts";
// 合成回复文案的契约正身在 contracts（提示词契约英文定死）；core 侧消费方统一从本模块取。
// （2026-11-21 裸投递：per-message instruction 常量已退役，回复语义改常驻系统提示词 +
// <system-status>.replyExpected，见 docs/message-origin.md「ContactAgent 裸投递」。）
// 2026-11-22 登记表归属修订：会话关闭/进程重启是第三、四条终止路径，文案同走 contracts。
export {
  agentContactRestartInterruptedReply,
  agentContactSessionClosedReply,
  agentContactTakeoverReply,
  agentContactTurnFailedReply,
} from "@robindone/contracts";

/** 结构化 logger（避免与 runtime/deps 的具名类型产生模块环）。 */
export interface AgentContactLogger {
  debug?(message: string, context?: Record<string, unknown>): void;
  info?(message: string, context?: Record<string, unknown>): void;
  warn?(message: string, context?: Record<string, unknown>): void;
}

interface AgentContactWaiterHandle {
  resolve(result: AgentContactWaitResult): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

interface AgentContactSide {
  kind: "master" | "worker";
  /** worker = 任务 agentId；master = master 会话 id（两侧 id 空间不相交）。 */
  agentId: string;
  /** 会话地址：发送方=异步回复注入地址；接收方=轮终态捕获匹配键。 */
  sessionId: string;
  agentType: string;
  displayName: string;
}

interface AgentContactEntry {
  requestId: string;
  sender: AgentContactSide;
  receiver: AgentContactSide;
  createdAt: number;
  settled: boolean;
  /** pending waiters（WaitReply 可并发多次）。 */
  waiters: AgentContactWaiterHandle[];
}

/** 注入回调可见的条目切片（不含等待者簿记）。 */
export interface AgentContactEntryView {
  requestId: string;
  sender: AgentContactSide;
  receiver: AgentContactSide;
}

// ---- 持久化（2026-11-22 needReply 回复静默丢失修复，docs/trigger-system.md 实施修订节） ----
// 登记表随进程存活；共享实例挂持久化钩子后，未结算条目落盘，进程重启恢复时逐条
// 合成解除并通知发送方（重启 = 显式解约，不做跨重启真回复重放）。core 保持 IO 无关：
// 读写由 bootstrap 注入（fail-safe：落盘/读盘失败只记日志，不阻塞消息管线）。

/** 落盘条目形状（未结算条目的持久快照；waiters 等内存簿记不落盘）。 */
export interface AgentContactPersistedEntry {
  requestId: string;
  createdAt: number;
  sender: AgentContactSide;
  receiver: AgentContactSide;
}

export interface AgentContactPersistencePort {
  /** 进程启动恢复点调用（bootstrap 用同步读，保证恢复先于任何新登记）。 */
  load(): AgentContactPersistedEntry[] | undefined;
  /** 每次登记/结算变更后的全量重写（未结算条目快照）。 */
  save(entries: AgentContactPersistedEntry[]): void;
}

/** 恢复解约的单条结算结果（bootstrap 据此向发送方投递通知）。 */
export interface AgentContactRecoveredSettlement {
  entry: AgentContactEntryView;
  /** 合成通知正文（agentContactRestartInterruptedReply，synthesized=true 语义）。 */
  text: string;
}

export interface AgentContactResolvedReply {
  /** 接收端轮终态最终输出（原样回投）。 */
  text: string;
  /** 回复来源会话地址（接收端会话）。 */
  sourceSessionId?: string;
}

export interface AgentContactSyntheticInput extends AgentContactResolvedReply {
  receiverDisplayName: string;
}

/** 登记表容量护栏：进程内 Map 只增不减会泄漏，超限淘汰最老的已结算条目。 */
const MAX_AGENT_CONTACT_ENTRIES = 512;

export class AgentContactRegistry {
  private readonly entries = new Map<string, AgentContactEntry>();
  private readonly logger?: AgentContactLogger;
  /** 持久化钩子（bootstrap 注入共享实例；私有实例不挂，缺席 = 纯内存）。 */
  private persistence?: AgentContactPersistencePort;
  /** 落盘串行链：register/settle 高频并发，重叠写会造成 tmp 竞态与旧新颠倒。 */
  private saveChain: Promise<void> = Promise.resolve();

  constructor(logger?: AgentContactLogger) {
    this.logger = logger;
  }

  /**
   * 登记 needReply=true 的在途请求。两个端口的实际顺序都是投递先行、应答确认后登记
   * （master port 见 submit 的注释；投递失败即不登记，不产生无接收方的孤儿条目），
   * 回复竞态由"LLM 轮长 ≫ 进程内投递延迟"论证兜底；本方法只管登记本身。
   */
  register(input: {
    requestId: string;
    sender: AgentContactSide;
    receiver: AgentContactSide;
  }): void {
    this.evictIfNeeded();
    this.entries.set(input.requestId, {
      requestId: input.requestId,
      sender: input.sender,
      receiver: input.receiver,
      createdAt: Date.now(),
      settled: false,
      waiters: [],
    });
    this.persistUnsettled();
  }

  get(requestId: string): AgentContactEntry | undefined {
    return this.entries.get(requestId);
  }

  /**
   * 等待一个在途请求的回复（ContactAgent waitFor=true 与 WaitReply 共用）。
   * 超时把请求放回 open 态（waiters 清空即可，不销毁条目，可再次等待）；
   * abort 直接 rejecting（工具取消）。
   */
  wait(requestId: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentContactWaitResult> {
    const entry = this.entries.get(requestId);
    if (!entry || entry.settled) {
      return Promise.resolve({
        status: "unknown_request",
        requestId,
        ...(entry?.settled
          ? { message: "This request was already settled; the reply (if any) was delivered into your session history." }
          : { message: `No pending ContactAgent request found for ${requestId}.` }),
      } satisfies AgentContactWaitResult);
    }
    return new Promise<AgentContactWaitResult>((resolve, reject) => {
      const detach = () => {
        signal?.removeEventListener("abort", onAbort);
        const index = entry.waiters.indexOf(waiter);
        if (index >= 0) entry.waiters.splice(index, 1);
      };
      const onAbort = () => {
        detach();
        reject(signal?.reason ?? new Error(`ContactAgent wait aborted for ${requestId}`));
      };
      const timer = setTimeout(() => {
        detach();
        this.logDebug("ContactAgent wait timed out (request stays open)", {
          event: "agent_contact.wait_timeout",
          module: "core.subagent",
          requestId,
        });
        resolve({
          status: "timeout",
          requestId,
          message: `No reply within ${timeoutMs} ms; the request stays open - call WaitReply again or end your turn and the reply will be injected here when it arrives.`,
        });
      }, timeoutMs);
      const waiter: AgentContactWaiterHandle = {
        resolve: (result) => {
          clearTimeout(timer);
          detach();
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          detach();
          reject(error);
        },
        timer,
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      entry.waiters.push(waiter);
      if (typeof timer === "object" && "unref" in timer) {
        (timer as { unref(): void }).unref();
      }
    });
  }

  /** 投递失败时撤销登记（无回复会到来，条目删除；此后 wait 得 unknown_request）。 */
  disposeEntry(requestId: string): void {
    const entry = this.entries.get(requestId);
    if (!entry) return;
    for (const waiter of [...entry.waiters]) {
      clearTimeout(waiter.timer);
      waiter.resolve({
        status: "unknown_request",
        requestId,
        message: "This request failed before delivery; no reply will arrive.",
      });
    }
    this.entries.delete(requestId);
    this.persistUnsettled();
  }

  // ---- 持久化钩子（2026-11-22）：共享登记表跨重启的显式解约契约 ----

  /**
   * 挂载持久化（bootstrap 注入共享实例；core 不做 IO）。挂载即全量重写一次未结算
   * 快照——恢复点之后盘上旧条目立即清账（活表为空 → 落盘为空），避免无新登记时
   * 下次重启对同批旧条目重复解约通知。
   */
  attachPersistence(port: AgentContactPersistencePort): void {
    this.persistence = port;
    this.persistUnsettled();
  }

  /**
   * 未结算条目快照（落盘内容；已结算条目不重放）。
   * 2026-11-23 改公开：bootstrap 恢复通知未确认送达前，盘上需同时保留活条目与待通知
   * 恢复条目（确认一条删一条，失败留盘下轮重试）——持久化端口的 save 只收到活条目，
   * 组合写入需要读这份快照（persistUnsettled 的串行链不经过它，此处为纯读快照）。
   */
  unsettledEntries(): AgentContactPersistedEntry[] {
    const snapshot: AgentContactPersistedEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.settled) continue;
      snapshot.push({
        requestId: entry.requestId,
        createdAt: entry.createdAt,
        sender: entry.sender,
        receiver: entry.receiver,
      });
    }
    return snapshot;
  }

  /** 变更后落盘（串行链防重叠写；失败只记日志，不阻塞消息管线——fail-safe）。 */
  private persistUnsettled(): void {
    const port = this.persistence;
    if (!port) return;
    const snapshot = this.unsettledEntries();
    this.saveChain = this.saveChain
      .then(() => port.save(snapshot))
      .catch((error: unknown) => {
        this.logWarn("AgentContact persistence save failed (in-memory state unaffected)", {
          event: "agent_contact.persist_failed",
          module: "core.subagent",
          pendingCount: snapshot.length,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /**
   * 进程重启恢复（bootstrap 在首个会话装配点调用）：对每条落盘的在途请求生成
   * "重启中断"合成解约（agentContactRestartInterruptedReply）并返回给调用方去通知
   * 发送方——条目**不进**活地图（重启即解约，此后任何轮终态捕获不得再结算它们、
   * 也不得把新轮输出误当旧请求回复）。等待者恒为空（新进程无人等待旧请求）。
   */
  restoreRecovered(entries: AgentContactPersistedEntry[]): AgentContactRecoveredSettlement[] {
    if (entries.length === 0) return [];
    this.logInfo("AgentContact entries recovered from disk (restart-interruption settlement)", {
      event: "agent_contact.recovered",
      module: "core.subagent",
      count: entries.length,
    });
    return entries.map((persisted) => ({
      entry: { requestId: persisted.requestId, sender: persisted.sender, receiver: persisted.receiver },
      text: agentContactRestartInterruptedReply(persisted.receiver.displayName),
    }));
  }

  /**
   * 轮终态捕获：按接收端身份（任务 agentId 或会话 id）结算全部在途 needReply 请求。
   * 返回结算条数（调用方据此抑制任务完成通知——回复捕获取代之）。
   */
  resolveReceiverReplies(input: {
    receiverAgentId?: string;
    receiverSessionId?: string;
    reply: AgentContactResolvedReply;
  }): number {
    return this.settleMatching(input.receiverAgentId, input.receiverSessionId, (entry) => ({
      status: "replied" as const,
      requestId: entry.requestId,
      text: input.reply.text,
      ...(input.reply.sourceSessionId ? { sessionId: input.reply.sourceSessionId } : {}),
    }));
  }

  /**
   * 合成回复解除（用户接管 / 轮次失败）：与捕获同路径，text 换成定死英文说明，
   * synthesized=true 标注非接收端原文。
   */
  resolveReceiverSynthetic(input: {
    receiverAgentId?: string;
    receiverSessionId?: string;
    synthetic: AgentContactSyntheticInput;
  }): number {
    return this.settleMatching(input.receiverAgentId, input.receiverSessionId, (entry) => ({
      status: "replied" as const,
      requestId: entry.requestId,
      text: input.synthetic.text,
      synthesized: true,
      ...(input.receiverSessionId ? { sessionId: input.receiverSessionId } : {}),
    }));
  }

  /**
   * 无等待者的回复注入订阅（进程共享登记表下可能有多个端口订阅：master port 处理全部
   * 方向——master 发起方注入本会话、worker 发起方经投递端口回投 worker 会话；worker port
   * 兜底无 master 会话在场的进程。订阅者返回 true 表示已处理，停止传播。
   */
  addUnwaitedReplySubscriber(
    subscriber: (
      entry: AgentContactEntryView,
      reply: AgentContactResolvedReply,
      synthesized: boolean,
    ) => boolean,
  ): void {
    this.unwaitedReplySubscribers.push(subscriber);
  }

  private readonly unwaitedReplySubscribers: Array<
    (
      entry: AgentContactEntryView,
      reply: AgentContactResolvedReply,
      synthesized: boolean,
    ) => boolean
  > = [];

  private settleMatching(
    receiverAgentId: string | undefined,
    receiverSessionId: string | undefined,
    buildResult: (entry: AgentContactEntry) => AgentContactWaitResult,
  ): number {
    let settledCount = 0;
    for (const entry of this.entries.values()) {
      if (entry.settled) continue;
      const matchesAgent = receiverAgentId !== undefined && entry.receiver.agentId === receiverAgentId;
      const matchesSession =
        receiverSessionId !== undefined && entry.receiver.sessionId === receiverSessionId;
      if (!matchesAgent && !matchesSession) continue;
      entry.settled = true;
      settledCount++;
      const result = buildResult(entry);
      if (entry.waiters.length > 0) {
        for (const waiter of [...entry.waiters]) {
          clearTimeout(waiter.timer);
          waiter.resolve(result);
        }
        entry.waiters = [];
        this.logDebug("ContactAgent reply settled active waiters", {
          event: "agent_contact.settled_waiters",
          module: "core.subagent",
          requestId: entry.requestId,
        });
      } else {
        // 无等待者（发送方未等待即结束）→ 异步注入发送端会话 + 唤醒（交付矩阵第 3 行）。
        this.logDebug("ContactAgent reply injected into sender session (no active waiter)", {
          event: "agent_contact.inject_unwaited",
          module: "core.subagent",
          requestId: entry.requestId,
          senderKind: entry.sender.kind,
        });
        const resolvedReply = {
          text: result.text ?? "",
          ...(result.sessionId ? { sourceSessionId: result.sessionId } : {}),
        };
        for (const subscriber of this.unwaitedReplySubscribers) {
          if (
            subscriber(
              entry,
              resolvedReply,
              result.synthesized === true,
            )
          ) {
            break;
          }
        }
      }
    }
    if (settledCount > 0) this.persistUnsettled();
    return settledCount;
  }

  private evictIfNeeded(): void {
    if (this.entries.size < MAX_AGENT_CONTACT_ENTRIES) return;
    for (const [id, entry] of this.entries) {
      if (this.entries.size < MAX_AGENT_CONTACT_ENTRIES * 0.9) break;
      if (entry.settled) this.entries.delete(id);
    }
  }

  // logger 方法是可选签名（TS2722：`a?.b()` 对可选方法仍报 possibly undefined），
  // 统一收口到三个 helper 用双重可选链，调用侧保持整洁。
  private logDebug(message: string, context?: Record<string, unknown>): void {
    this.logger?.debug?.(message, context);
  }

  private logInfo(message: string, context?: Record<string, unknown>): void {
    this.logger?.info?.(message, context);
  }

  private logWarn(message: string, context?: Record<string, unknown>): void {
    this.logger?.warn?.(message, context);
  }

  /** runtime 关闭时拒绝全部在途等待（工具结果按取消收口，不悬挂）。 */
  dispose(reason: string): void {
    for (const entry of this.entries.values()) {
      for (const waiter of [...entry.waiters]) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(reason));
      }
      entry.waiters = [];
      entry.settled = true;
    }
    this.entries.clear();
    this.persistUnsettled();
  }
}

// ---- 消息投递（2026-11-21 裸投递裁决）：正文一律原文原样，零包装零转义 ----
// 来源身份与回复语义由 <system-status> 承载（sender/senderId/senderName/fromSessionId/
// replyExpected），host 侧 agentContactDispatch 在 sendPrompt 时随行；历史 XML 信封
// （formatContactRequestMessage/formatContactReplyMessage/escapeXml）连同 per-message
// instruction 样板一并移除——接收端只看到裸消息（&quot; 伪影与样板噪音由此消灭）。

export function createContactRequestId(): string {
  return `contact_${randomUUID()}`;
}

/**
 * master 侧自建端口的 runtime 形态判定（2026-11-19 定形，2026-11-20 同构化后核实）：
 * ContactAgent 层级边界 = master↔worker，只有主会话形态（interactive 及 fork/
 * workflow_parent 等主代理变体）自建 master 端口。一次性 subagent（subagent_child/
 * workflow_child 系）不建任何 contact 端口；worker 会话（主会话形态 + workerIdentity）
 * 在 runtime 构造内自建 worker 端口（见 worker-session-routing），与已退役的
 * worker_child 派发类型无关（该类型仅存于历史会话投影）。
 */
export function isAgentContactMainRuntime(
  taskType: string | undefined,
): boolean {
  return (
    taskType === undefined ||
    taskType === "interactive" ||
    taskType === "fork" ||
    taskType === "selection_side_chat" ||
    taskType === "workflow_parent"
  );
}

// ============================================================
// Master-side port（master 主会话自建）：target=wkr-id → Host 投递（寻址创建/唤醒）
// ============================================================

export interface MasterAgentContactPortOptions {
  /** master 会话 id（发起方地址；回复注入本会话的寻址键）。 */
  sessionId: SessionId;
  rootTraceContext: TraceContext;
  /** Host 投递通道（bootstrap 经 CLI→Host 反向请求落桌面任务服务）；缺席 = 无 Host 的独立 CLI。 */
  dispatch: AgentSessionDispatchPort;
  contacts: AgentContactRegistry;
  logger?: AgentContactLogger;
  /**
   * 名册显示名解析（2026-11-22 实测修复）：needReply 登记的 receiver.displayName 用
   * 名册显示名而非裸 wkr-id——否则 worker 回复注入 master 会话时
   * <system-status>.senderName = wkr-id，UI 徽章渲染成「工作者-wkr-xxxx」（用户不可读）。
   * 快照内查不到返回 undefined。
   */
  resolveWorkerDisplayName?: (workerId: string) => string | undefined;
  /**
   * 名册 miss 时刷新快照重试（建队即派工：同轮 ManageWorkers 建队后立即 ContactAgent，
   * 快照按 turn 冻结——与 Agent 工具解析的 reloadAgentDefinitions 同机制）。缺席不重试。
   */
  reloadAgentDefinitions?: (input: {
    signal: AbortSignal;
    traceContext: TraceContext;
  }) => Promise<void>;
}

/**
 * 接收方显示名解析（2026-11-22 实测修复）：优先名册快照；miss 时刷新一次快照重试，
 * 仍 miss 回退 wkr-id——显示名缺席只降级徽章可读性，不阻断投递与回复捕获。
 * 2026-11-23 增补 timeoutMs 上限：解析在 master port submit 中位于投递之前（见调用处
 * 修复注记），Host 往返一旦挂起会拖死整个 submit——超时按未解析处理（回退 wkr-id）。
 */
async function resolveReceiverWorkerDisplayName(
  options: MasterAgentContactPortOptions,
  workerId: string,
  traceContext: TraceContext,
  timeoutMs: number,
): Promise<string> {
  const direct = options.resolveWorkerDisplayName?.(workerId);
  if (direct) return direct;
  if (options.reloadAgentDefinitions) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const refreshed = await Promise.race([
        (async () => {
          await options.reloadAgentDefinitions!({
            signal: new AbortController().signal,
            traceContext,
          });
          return options.resolveWorkerDisplayName?.(workerId);
        })(),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), timeoutMs);
        }),
      ]);
      if (refreshed) return refreshed;
    } catch {
      // 快照刷新失败不阻断投递（显示名是展示层事实，wkr-id 兜底）。
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return workerId;
}

export function createMasterAgentContactPort(
  options: MasterAgentContactPortOptions,
): AgentContactPort {
  // 无等待者回复注入（进程共享登记表订阅）：统一走 Host 投递通道（2026-11-21 裸投递，
  // 不再经 subagent-message 信封二次包装转义）——master 发起方 → 投回 master 自己的
  // 会话（sender 携带 worker 身份、fromSessionId = worker 会话即回复来源）；worker
  // 发起方 → 投回 worker 会话（sender=master）。正文一律裸回复原文。
  options.contacts.addUnwaitedReplySubscriber((entry, reply) => {
    if (entry.sender.kind === "master") {
      void options.dispatch
        .dispatch({
          targetAgentId: "master",
          ...(entry.sender.sessionId ? { targetSessionId: entry.sender.sessionId } : {}),
          fromSessionId: entry.receiver.sessionId,
          senderKind: "worker",
          senderId: entry.receiver.agentId,
          senderDisplayName: entry.receiver.displayName,
          message: reply.text,
          needReply: false,
          trace: options.rootTraceContext,
        })
        .catch((error: unknown) => {
          options.logger?.warn?.("ContactAgent reply injection into master session failed", {
            event: "agent_contact.inject_failed",
            module: "core.subagent",
            requestId: entry.requestId,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        });
      return true;
    }
    void options.dispatch
      .dispatch({
        targetAgentId: entry.sender.agentId,
        ...(entry.sender.sessionId ? { targetSessionId: entry.sender.sessionId } : {}),
        fromSessionId: options.sessionId,
        senderKind: "master",
        senderDisplayName: "master",
        message: reply.text,
        needReply: false,
        trace: options.rootTraceContext,
      })
      .catch((error: unknown) => {
        options.logger?.warn?.("ContactAgent reply injection into worker session failed", {
          event: "agent_contact.inject_failed",
          module: "core.subagent",
          requestId: entry.requestId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  });

  return {
    async submit(request: AgentContactSubmitRequest): Promise<AgentContactSubmitResult> {
      if (request.target === "master" || request.target === options.sessionId) {
        return {
          status: "failed",
          requestId: request.requestId,
          error: "The main agent cannot contact itself; target a roster worker id instead.",
        };
      }
      // 投递先行：Host 寻址创建/唤醒目标 worker 会话并回填实际会话 id；投递失败（未注册
      // worker / 无 Host 通道）直接 failed，无需登记清理。回复捕获按接收方 sessionId 结算，
      // 修复（2026-11-23）：显示名解析提到投递之前——它只依赖 target（wkr-id），无须等
      // 投递结果。此前顺序是 投递 → await 解析（含名册刷新的 Host 往返）→ 登记：窗口内
      // 接收端轮次快速失败/用户接管/会话关闭的合成解除按 sessionId 找不到条目 → 孤儿条目
      // 永无结算机会 → 发送方干等到超时且全程无感知（P3-15 要消灭的"静默丢失"类残留窗口）。
      // 提前解析（带上限）+ 投递应答后同步登记（无额外 await），窗口收缩回进程内同步段，
      // "LLM 轮长 ≫ 登记延迟"的竞态论证重新成立。
      // 2026-11-22 实测修复保留：receiver.displayName 按名册解析（原为裸 wkr-id），回投链
      // （senderDisplayName → <system-status>.senderName → UI 徽章）全程可读。
      const receiverDisplayName: string | undefined = request.needReply
        ? await resolveReceiverWorkerDisplayName(options, request.target, request.trace, 5_000)
        : undefined;
      // 登记晚于投递应答不早于接收端轮终态（LLM 轮长 ≫ 进程内 IPC 延迟，无回复竞态）。
      let delivered: Awaited<ReturnType<AgentSessionDispatchPort["dispatch"]>>;
      try {
        delivered = await options.dispatch.dispatch({
          targetAgentId: request.target,
          ...(request.sessionId ? { targetSessionId: request.sessionId } : {}),
          fromSessionId: options.sessionId,
          senderKind: "master",
          senderDisplayName: "master",
          message: request.message,
          needReply: request.needReply,
          trace: request.trace,
        });
      } catch (error) {
        return {
          status: "failed",
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (delivered.status !== "delivered") {
        return {
          status: "failed",
          requestId: request.requestId,
          error: delivered.error ?? "Contact delivery failed.",
        };
      }
      options.logger?.info?.("ContactAgent request delivered to worker", {
        event: "agent_contact.delivered",
        module: "core.subagent",
        requestId: request.requestId,
        workerId: request.target,
        workerSessionId: delivered.sessionId,
        needReply: request.needReply,
      });
      if (request.needReply) {
        options.contacts.register({
          requestId: request.requestId,
          sender: {
            kind: "master",
            agentId: options.sessionId,
            sessionId: options.sessionId,
            agentType: "master",
            displayName: "master",
          },
          receiver: {
            kind: "worker",
            agentId: request.target,
            sessionId: delivered.sessionId ?? "",
            agentType: request.target,
            displayName: receiverDisplayName ?? request.target,
          },
        });
      }
      return {
        status: "delivered",
        requestId: request.requestId,
        ...(delivered.sessionId ? { sessionId: delivered.sessionId } : {}),
      };
    },
    async wait(requestId, timeoutMs, signal) {
      return options.contacts.wait(requestId, timeoutMs, signal);
    },
  };
}

// ============================================================
// Worker-side port（worker 会话自建，workerIdentity 在场）：target=master → Host 投递
// ============================================================

export interface WorkerAgentContactPortOptions {
  /** worker 自己的会话 id（发起方地址；接收方回投的寻址键）。 */
  sessionId: SessionId;
  /** worker 身份（config.workerIdentity；senderId/senderName 进 <system-status>）。 */
  workerId: string;
  workerName: string;
  /** Host 投递通道；缺席 = 无 Host 的独立 CLI（worker 无法回联 master）。 */
  dispatch: AgentSessionDispatchPort;
  contacts: AgentContactRegistry;
  logger?: AgentContactLogger;
}

export function createWorkerAgentContactPort(
  options: WorkerAgentContactPortOptions,
): AgentContactPort {
  // 兜底订阅：进程内没有 master 会话在场时（master 冷闲置），worker 发起方的
  // 无等待者回复经本订阅注入其会话；master port 在场时其订阅先行处理（返回 true 停止
  // 传播）。正文裸回复原文（2026-11-21 裸投递）。
  options.contacts.addUnwaitedReplySubscriber((entry, reply) => {
    if (entry.sender.kind !== "worker") return false;
    void options.dispatch
      .dispatch({
        targetAgentId: entry.sender.agentId,
        ...(entry.sender.sessionId ? { targetSessionId: entry.sender.sessionId } : {}),
        fromSessionId: entry.receiver.sessionId,
        senderKind: "master",
        senderDisplayName: "master",
        message: reply.text,
        needReply: false,
      })
      .catch((error: unknown) => {
        options.logger?.warn?.("ContactAgent reply injection into worker session failed", {
          event: "agent_contact.inject_failed",
          module: "core.subagent",
          requestId: entry.requestId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  });

  return {
    async submit(request: AgentContactSubmitRequest): Promise<AgentContactSubmitResult> {
      if (request.target !== "master") {
        return {
          status: "failed",
          requestId: request.requestId,
          error: `Workers can only contact "master" (worker-to-worker messaging must be relayed by the main agent); got ${request.target}.`,
        };
      }
      // 投递先行（同 master port）：Host 按 targetAgentId 解析 master 会话（指定 sessionId
      // 则续聊该会话，缺省 = 一定新建 master 会话，无"最新会话"回退），回填实际会话 id 后登记接收方。
      let delivered: Awaited<ReturnType<AgentSessionDispatchPort["dispatch"]>>;
      try {
        delivered = await options.dispatch.dispatch({
          targetAgentId: "master",
          ...(request.sessionId ? { targetSessionId: request.sessionId } : {}),
          fromSessionId: options.sessionId,
          senderKind: "worker",
          senderId: options.workerId,
          senderDisplayName: options.workerName,
          message: request.message,
          needReply: request.needReply,
        });
      } catch (error) {
        return {
          status: "failed",
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (delivered.status !== "delivered") {
        return {
          status: "failed",
          requestId: request.requestId,
          error: delivered.error ?? "Contact delivery failed.",
        };
      }
      options.logger?.info?.("ContactAgent request delivered to master", {
        event: "agent_contact.delivered",
        module: "core.subagent",
        requestId: request.requestId,
        senderWorkerId: options.workerId,
        masterSessionId: delivered.sessionId,
        needReply: request.needReply,
      });
      if (request.needReply) {
        options.contacts.register({
          requestId: request.requestId,
          sender: {
            kind: "worker",
            agentId: options.workerId,
            sessionId: options.sessionId,
            agentType: options.workerId,
            displayName: options.workerName,
          },
          receiver: {
            kind: "master",
            agentId: delivered.sessionId ?? "master",
            sessionId: delivered.sessionId ?? "",
            agentType: "master",
            displayName: "master",
          },
        });
      }
      return {
        status: "delivered",
        requestId: request.requestId,
        ...(delivered.sessionId ? { sessionId: delivered.sessionId } : {}),
      };
    },
    async wait(requestId, timeoutMs, signal) {
      return options.contacts.wait(requestId, timeoutMs, signal);
    },
  };
}
