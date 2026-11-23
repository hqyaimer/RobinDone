import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  agentContactRestartInterruptedBatchReply,
  type AgentSessionDispatchPort,
  type AgentSessionDispatchRequest,
  type AgentSessionDispatchResult,
  type TraceContext,
} from "@robinrun/contracts";
import type {
  AgentContactPersistedEntry,
  AgentContactPersistencePort,
  AgentContactRecoveredSettlement,
} from "@robinrun/core";
import { AgentContactRegistry } from "@robinrun/core";
import {
  robinrunAgentContactDispatchParamsSchema,
  robinrunAgentContactDispatchResultSchema,
  robinrunProtocolMethods,
} from "@robinrun/shared";
import { projectIdFromDirectory } from "../app/paths.js";
import {
  protocolTraceFromTraceContext,
  requireSession,
  type RobinRunProtocolAgentServerContext,
  type RobinRunProtocolClientRequestOptions,
} from "./server-types.js";

/**
 * agent 消息进程共享状态（2026-11-20 worker 会话同构化，docs/worker-session-model.md §2/§3）：
 * 同一 server context（= 同 workspace 的全部会话共用一个 CLI 进程）持有一个 AgentContactRegistry
 * 与一个 dispatch port——任一会话的轮终态捕获按接收方 sessionId 结算在途请求，ContactAgent
 * 投递统一经 Host 任务服务寻址创建/唤醒目标会话（机制同触发器投递 dispatchTriggerRun）。
 *
 * 与 browser broker 同款的 context 级共享模式：createWorkspaceRobinRunApp 每个 app 都会
 * 取一次端口，状态必须共享（否则 worker 会话的登记与 master 会话的捕获互不可见）。
 *
 * 2026-11-22 needReply 回复静默丢失修复（docs/trigger-system.md 实施修订节）：
 * - 共享登记表补 logger——register/settle/inject/dispose 事件落 CLI 日志（事故不再零痕迹）；
 * - 在途请求持久化（`<cliStorageRoot>/agent-contact/<projectId>.json`，只存未结算条目，
 *   变更后原子重写）+ 进程重启恢复：恢复条目逐条"重启中断"合成解除并唤醒发送方
 *   （重启 = 显式解约，不做跨重启真回复重放）。cliStorageRoot/cwd 缺席 → 纯内存。
 */
interface ProtocolAgentContactState {
  registry: AgentContactRegistry;
  dispatch: AgentSessionDispatchPort;
}

const stateByContext = new WeakMap<RobinRunProtocolAgentServerContext, ProtocolAgentContactState>();

const AGENT_CONTACT_PERSIST_DIR = "agent-contact";
const AGENT_CONTACT_PERSIST_VERSION = 1;

/** 恢复通知的延迟：等触发本次装配的首个会话完成构造（record 进入 context.sessions）。 */
const RECOVERY_NOTICE_DEFER_MS = 300;

export function agentContactState(
  context: RobinRunProtocolAgentServerContext,
): ProtocolAgentContactState {
  let state = stateByContext.get(context);
  if (!state) {
    const registry = new AgentContactRegistry(context.logger);
    const persistenceFile = resolveAgentContactPersistFile(context);
    // 修复（2026-11-23，C5）：恢复条目的落盘生命周期改为"确认送达后才清除"——此前
    // attachPersistence 的首次全量重写立即把盘上旧条目清成 []，通知投递失败（Host 未
    // 就绪/发送方会话已删除/300ms 猜测偏短）即永久丢失，发送方无感知（恰是 P3-15 契约
    // 要消灭的语义）。现在：恢复条目先入 pendingRecovered（不进活地图），持久化端口的
    // save 把它组合进盘上内容；通知确认送达一条删一条并重写，失败留盘下次重启重试。
    const pendingRecovered: AgentContactPersistedEntry[] = [];
    if (persistenceFile) {
      const recovered = loadPersistedEntries(persistenceFile, context);
      pendingRecovered.push(...recovered);
      // 恢复解约（重启 = 显式解约）：条目不进活地图；restoreRecovered 仅生成结算元数据，
      // 通知正文改用按发送方聚合的批量文案（C6，见 scheduleRestartInterruptedNotices）。
      const settlements = registry.restoreRecovered(recovered);
      registry.attachPersistence(
        createAgentContactPersistencePort(persistenceFile, context, pendingRecovered),
      );
      scheduleRestartInterruptedNotices(
        context,
        registry,
        persistenceFile,
        settlements,
        pendingRecovered,
      );
    }
    state = {
      registry,
      dispatch: createProtocolAgentContactDispatchPort(context),
    };
    stateByContext.set(context, state);
  }
  return state;
}

// ---- 持久化（fail-safe：读盘/落盘失败只记日志，不阻塞消息管线） ----

function resolveAgentContactPersistFile(
  context: RobinRunProtocolAgentServerContext,
): string | undefined {
  const cliStorageRoot = context.deps.cliStorageRoot?.trim();
  const workspacePath = context.deps.cwd?.trim();
  if (!cliStorageRoot || !workspacePath) return undefined;
  // 按项目目录键（同 projectIdFromDirectory 的清洗规则）；进程级瞬态状态放 CLI 存储
  // 根而非项目 `.robinrun/`——这是引擎簿记不是 agent 编写内容，也不污染非项目目录。
  return join(
    cliStorageRoot,
    AGENT_CONTACT_PERSIST_DIR,
    `${projectIdFromDirectory(workspacePath)}.json`,
  );
}

interface AgentContactPersistFileShape {
  version: number;
  entries: AgentContactPersistedEntry[];
}

function loadPersistedEntries(
  file: string,
  context: RobinRunProtocolAgentServerContext,
): AgentContactPersistedEntry[] {
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<AgentContactPersistFileShape>;
    if (parsed.version !== AGENT_CONTACT_PERSIST_VERSION || !Array.isArray(parsed.entries)) {
      context.logger?.warn("AgentContact persistence file shape unknown; ignoring", {
        event: "agent_contact.persist_shape_unknown",
        module: "bootstrap.robinrun_protocol",
        file,
      });
      return [];
    }
    return parsed.entries.filter(
      (entry): entry is AgentContactPersistedEntry =>
        Boolean(entry) &&
        typeof entry.requestId === "string" &&
        typeof entry.createdAt === "number" &&
        Boolean(entry.sender) &&
        Boolean(entry.receiver),
    );
  } catch (error) {
    // ENOENT = 首次运行（无在途条目），正常路径不算告警。
    if (isNodeError(error) && error.code === "ENOENT") return [];
    context.logger?.warn("AgentContact persistence load failed; starting empty", {
      event: "agent_contact.persist_load_failed",
      module: "bootstrap.robinrun_protocol",
      file,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function createAgentContactPersistencePort(
  file: string,
  context: RobinRunProtocolAgentServerContext,
  pendingRecovered: AgentContactPersistedEntry[],
): AgentContactPersistencePort {
  return {
    load: () => loadPersistedEntries(file, context),
    // 组合写入（2026-11-23，C5）：注册表 save 只携带活条目；待通知恢复条目随每次写入
    // 一并落盘（确认送达一条删一条）。最坏情形是与确认路径的并发写交错时，已确认条目
    // 以旧快照短暂回到盘上 → 下次重启重复通知一次（良性：宁重复不丢失）。
    save: (entries) => {
      const composed = [...entries, ...pendingRecovered];
      return atomicWriteJson(file, {
        version: AGENT_CONTACT_PERSIST_VERSION,
        entries: composed,
      }).catch((error: unknown) => {
        context.logger?.warn("AgentContact persistence save failed (in-memory state unaffected)", {
          event: "agent_contact.persist_save_failed",
          module: "bootstrap.robinrun_protocol",
          file,
          pendingCount: composed.length,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });
    },
  };
}

async function atomicWriteJson(
  file: string,
  payload: AgentContactPersistFileShape,
): Promise<void> {
  // 原子写（同触发器引擎惯例：tmp + rename），tmp 带 pid 防并发写互踩。
  const temp = `${file}.tmp.${process.pid}`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(temp, JSON.stringify(payload, null, 2), "utf8");
  await rename(temp, file);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

// ---- 恢复解约通知（发送方显式知情，经 CLI→Host 反向请求投进其会话） ----

/**
 * 恢复通知调度（2026-11-23 重写，C5+C6）：
 * - C6 按发送方会话聚合——此前逐条投递，N 条在途 = 发送方 N 个唤醒轮（同触发器
 *   P3-12 忙时合并投递的成本教训）；同会话合并为一条批量文案（逐列 requestId 与
 *   接收方），一次投递。
 * - C5 送达确认后才清盘——组内全部投递成功才把对应条目移出 pendingRecovered 并
   组合重写盘上内容；任一失败整组留盘，下次重启重试（宁重复不丢失）。
 */
function scheduleRestartInterruptedNotices(
  context: RobinRunProtocolAgentServerContext,
  registry: AgentContactRegistry,
  persistenceFile: string,
  settlements: AgentContactRecoveredSettlement[],
  pendingRecovered: AgentContactPersistedEntry[],
): void {
  if (settlements.length === 0) return;
  // 分组：key = 发起方 kind+sessionId（同会话必同 kind——会话身份二选一）。
  const groups = new Map<string, AgentContactRecoveredSettlement[]>();
  for (const settlement of settlements) {
    const key = `${settlement.entry.sender.kind}:${settlement.entry.sender.sessionId}`;
    const group = groups.get(key);
    if (group) group.push(settlement);
    else groups.set(key, [settlement]);
  }
  for (const group of groups.values()) {
    // 延迟投递：恢复点位于首个会话 createRecord 途中，等构造完成后再唤醒会话
    // （若首个会话恰为发送方本人，避免与其自身 resume 竞态）。
    setTimeout(() => {
      dispatchRestartInterruptedNotice(context, group)
        .then(() => {
          // 整组确认送达：从待通知集合移除并组合重写（活条目 + 剩余待通知）。
          const deliveredIds = new Set(group.map((settlement) => settlement.entry.requestId));
          for (let index = pendingRecovered.length - 1; index >= 0; index--) {
            if (deliveredIds.has(pendingRecovered[index]?.requestId)) {
              pendingRecovered.splice(index, 1);
            }
          }
          return atomicWriteJson(persistenceFile, {
            version: AGENT_CONTACT_PERSIST_VERSION,
            entries: [...registry.unsettledEntries(), ...pendingRecovered],
          }).catch((error: unknown) => {
            context.logger?.warn("AgentContact post-confirmation persistence rewrite failed", {
              event: "agent_contact.recovery_persist_failed",
              module: "bootstrap.robinrun_protocol",
              remaining: pendingRecovered.length,
              errorMessage: error instanceof Error ? error.message : String(error),
            });
          });
        })
        .catch((error: unknown) => {
          context.logger?.warn("AgentContact restart-interruption notice delivery failed", {
            event: "agent_contact.recovery_notice_failed",
            module: "bootstrap.robinrun_protocol",
            requestIds: group.map((settlement) => settlement.entry.requestId),
            senderSessionId: group[0]?.entry.sender.sessionId,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        });
    }, RECOVERY_NOTICE_DEFER_MS).unref();
  }
}

async function dispatchRestartInterruptedNotice(
  context: RobinRunProtocolAgentServerContext,
  group: AgentContactRecoveredSettlement[],
): Promise<void> {
  const first = group[0];
  if (!first) return;
  const { sender } = first.entry;
  // 无等待者注入同款方向语义：通知以"对端"身份出现（master 发起 → worker 口吻；
  // worker 发起 → master 口吻），fromSessionId = 对端会话（续聊地址）。聚合组的消息
  // 身份取组内首个条目的对端；其余对端在批量文案里逐行具名（<system-status> 只能
  // 承载一个 senderName，徽章以首个为准，正文保证全部可读）。
  const params = robinrunAgentContactDispatchParamsSchema.parse({
    sessionId: sender.sessionId,
    targetAgentId: sender.kind === "master" ? "master" : sender.agentId,
    targetSessionId: sender.sessionId,
    fromSessionId: first.entry.receiver.sessionId,
    senderKind: first.entry.receiver.kind === "worker" ? "worker" : "master",
    ...(first.entry.receiver.kind === "worker" ? { senderId: first.entry.receiver.agentId } : {}),
    senderDisplayName: first.entry.receiver.displayName,
    message: agentContactRestartInterruptedBatchReply(
      group.map((settlement) => ({
        requestId: settlement.entry.requestId,
        receiverDisplayName: settlement.entry.receiver.displayName,
      })),
    ),
    needReply: false,
  });
  const result = await context.requestClient(
    robinrunProtocolMethods.agentContactDispatch,
    params,
    robinrunAgentContactDispatchResultSchema,
  );
  if (result.status !== "delivered") {
    throw new Error(result.error ?? "restart-interruption notice dispatch failed");
  }
  context.logger?.info("AgentContact restart-interruption notice delivered", {
    event: "agent_contact.recovery_notice_delivered",
    module: "bootstrap.robinrun_protocol",
    requestIds: group.map((settlement) => settlement.entry.requestId),
    senderSessionId: sender.sessionId,
  });
}

/**
 * ProtocolAgentContactDispatchPort —— AgentSessionDispatchPort 的 CLI 侧实现：
 * 每次投递转成 agentContact/dispatch 反向请求，由 Host（桌面任务服务）解析目标智能体的
 * 会话（续聊指定会话；缺省 = 一定新建，无"最新会话"回退——寻址零耦合裁决）并 sendPrompt 投递。
 */
export function createProtocolAgentContactDispatchPort(
  context: RobinRunProtocolAgentServerContext,
): AgentSessionDispatchPort {
  return {
    async dispatch(request: AgentSessionDispatchRequest): Promise<AgentSessionDispatchResult> {
      const record = requireSession(context, request.fromSessionId);
      const workspaceIdentity = record.workspace.workspaceIdentity?.trim() || undefined;
      const remoteSessionId = record.workspace.remoteSessionId?.trim() || undefined;
      const result = await context.requestClient(
        robinrunProtocolMethods.agentContactDispatch,
        robinrunAgentContactDispatchParamsSchema.parse({
          sessionId: request.fromSessionId,
          ...(workspaceIdentity || remoteSessionId
            ? {
                workspace: {
                  workspacePath: record.workspace.workspacePath,
                  ...(workspaceIdentity ? { workspaceIdentity } : {}),
                  ...(remoteSessionId ? { remoteSessionId } : {}),
                },
              }
            : {}),
          targetAgentId: request.targetAgentId,
          ...(request.targetSessionId ? { targetSessionId: request.targetSessionId } : {}),
          fromSessionId: request.fromSessionId,
          senderKind: request.senderKind,
          ...(request.senderId ? { senderId: request.senderId } : {}),
          senderDisplayName: request.senderDisplayName,
          message: request.message,
          needReply: request.needReply,
        }),
        robinrunAgentContactDispatchResultSchema,
        buildRequestOptions(request.trace),
      );
      if (result.status !== "delivered") {
        return { status: "failed", error: result.error ?? "Agent session dispatch failed." };
      }
      return { status: "delivered", ...(result.sessionId ? { sessionId: result.sessionId } : {}) };
    },
  };
}

function buildRequestOptions(
  traceContext: TraceContext | undefined,
): RobinRunProtocolClientRequestOptions {
  return traceContext ? { trace: protocolTraceFromTraceContext(traceContext) } : {};
}
