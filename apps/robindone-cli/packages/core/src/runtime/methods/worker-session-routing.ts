import { SESSION_ENTRY_WORKER_IDENTITY } from "@robindone/contracts";
import type { SessionId, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * worker 会话通道（P2.5，2026-11-16）：用户在 worker_child 会话里直接打断/输入的
 * 路由入口。bootstrap 协议层拦截 sendText/stop 后调用这里——一律经**父 runtime 的
 * subagentPort** 交付（运行中→插话 steer / 已结束→后台恢复 resume），绝不驱动
 * worker 会话自己物化的 runtime 起轮：那会丢掉 roster profile（define.md 职责定义 +
 * agents.md 规则、worker 工具面），等于把 worker 降级成普通助手。
 */

export interface WorkerSessionRouteResult {
  ok: boolean;
  delivery?: "steered" | "queued" | "resumed_background";
  error?: string;
}

interface WorkerIdentityEntryData {
  agentType?: string;
  workerId?: string;
  workerName?: string;
}

/** 用户在 worker 会话里发送输入：先按 childSessionId 定位任务，miss 时凭身份 entry 兜底。 */
export async function sendChildSessionUserMessage(
  this: AgentRuntimeInternal,
  input: {
    childSessionId: SessionId;
    text: string;
    traceContext?: TraceContext;
  },
): Promise<WorkerSessionRouteResult> {
  const port = this.subagentPort;
  if (!port?.sendMessage || !port.getTaskByChildSessionId) {
    return { ok: false, error: "subagent_unavailable" };
  }
  const baseRequest = {
    sessionId: this.sessionId,
    parentToolCallId: `user-direct-${Date.now().toString(36)}`,
    message: input.text,
    workingDirectory: this.workingDirectory,
    workspaceRoot: this.workspaceRoot,
    trace: input.traceContext ?? this.rootTraceContext,
    initiator: "user" as const,
  };
  const task = await port.getTaskByChildSessionId(input.childSessionId);
  if (task) {
    const result = await port.sendMessage({
      ...baseRequest,
      to: task.taskId,
    });
    return toRouteResult(result);
  }
  // CLI 重启后内存 registry 为空：按权威身份源合成恢复。修复（2026-11-23）：兜底链
  // 第一级此前读 SESSION_ENTRY_WORKER_IDENTITY entry——其写入方随派发体制退役
  // （2026-11-20 同构化），全仓库无写入点、恒取 undefined；而 0026 落的
  // session.worker_identity 列（worker 会话创建时写入的权威值）却没接进兜底链，
  // 同构化会话只剩 legacy 消息反解兜底——它只能恢复 agentType，workerId/workerName
  // 永远缺席（注入段退化为 master 装配，正是 0026 要消灭的事故类别）。现在：
  // ① 会话行 worker_identity（权威）；② 历史 identity entry（P2.5~0026 间派发遗留）；
  // ③ legacy 消息反解（升级前 worker 会话）。
  const rowIdentity = (await this.sessionStore?.getSession(input.childSessionId))?.workerIdentity;
  const entries = await this.sessionStore?.sessionEntries?.({
    sessionID: input.childSessionId,
    type: SESSION_ENTRY_WORKER_IDENTITY,
  });
  const entryIdentity = entries?.at(-1)?.data as WorkerIdentityEntryData | undefined;
  // P2.5 之后的 roster profile.name = wkr-id（key/name 裁决），故 agentType 位放
  // workerId 即可完成 roster 重解析；workerName 补描述与注入段。P2.5 之前的派发不写
  // 身份 entry；子会话消息行以 agent: robindone-<agentType> 持久化（子 runtime
  // agentName 固定前缀），借最近一条消息反解身份兜底升级前遗留的 worker 会话。
  const workerId = rowIdentity?.workerId ?? entryIdentity?.workerId;
  const workerName = rowIdentity?.workerName ?? entryIdentity?.workerName;
  const agentType =
    workerId ??
    entryIdentity?.agentType ??
    (await deriveLegacyChildAgentType(this.sessionStore, input.childSessionId));
  if (!agentType) {
    return { ok: false, error: "worker_identity_unavailable" };
  }
  const result = await port.sendMessage({
    ...baseRequest,
    to: agentType,
    identity: {
      childSessionId: input.childSessionId,
      agentType,
      ...(workerId ? { workerId } : {}),
      ...(workerName ? { workerName } : {}),
    },
  });
  return toRouteResult(result);
}

/** 升级前遗留 worker 会话的身份反解：最后一条消息的 agent 字段（robindone-<agentType>）。 */
async function deriveLegacyChildAgentType(
  store: AgentRuntimeInternal["sessionStore"],
  childSessionId: SessionId,
): Promise<string | undefined> {
  const last = (await store?.messages?.({ sessionID: childSessionId }))?.at(-1);
  const agent = last?.info?.agent;
  if (typeof agent !== "string" || !agent.startsWith("robindone-")) return undefined;
  const agentType = agent.slice("robindone-".length);
  // robindone-agent 是主会话缺省名而非 roster 名；空串同理，都不作为身份使用。
  return agentType && agentType !== "agent" ? agentType : undefined;
}

/** 用户在 worker 会话里打断：按 childSessionId 停任务（user 发起 → 武装脱钩）。 */
export async function stopWorkerSessionTask(
  this: AgentRuntimeInternal,
  input: { childSessionId: SessionId; traceContext?: TraceContext },
): Promise<WorkerSessionRouteResult> {
  const port = this.subagentPort;
  if (!port?.stopTaskForChildSession) {
    return { ok: false, error: "subagent_unavailable" };
  }
  const stopped = await port.stopTaskForChildSession(input.childSessionId, {
    initiator: "user",
  });
  if (!stopped) return { ok: false, error: "worker_task_not_found" };
  return { ok: true };
}

/**
 * 项目权限全量同步（2026-11-18）：把协作模式切换路由到 childSessionId 对应的活子
 * runtime。与输入/打断同一条路由纪律——配置不能落在 worker 会话物化的 shell runtime
 * 上（那是冷恢复的空壳），必须由派发者的 subagentPort 找到执行本体生效。
 */
export async function setChildSessionExecutionMode(
  this: AgentRuntimeInternal,
  input: { childSessionId: SessionId; mode: string; traceContext?: TraceContext },
): Promise<{ ok: boolean; error?: string }> {
  const port = this.subagentPort;
  if (!port?.setChildSessionMode) {
    return { ok: false, error: "subagent_unavailable" };
  }
  return port.setChildSessionMode(input);
}

function toRouteResult(result: {
  status: "success" | "failed";
  delivery?: string;
  error?: string;
}): WorkerSessionRouteResult {
  return result.status === "success"
    ? {
        ok: true,
        ...(result.delivery === "steered" ||
        result.delivery === "queued" ||
        result.delivery === "resumed_background"
          ? { delivery: result.delivery }
          : {}),
      }
    : { ok: false, error: result.error ?? "send_failed" };
}
