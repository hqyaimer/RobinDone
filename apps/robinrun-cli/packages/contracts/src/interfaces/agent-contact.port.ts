import type { TraceContext } from "../tracing/tracer.js";

// ============================================================
// Agent Contact Port - agent-to-agent messaging with reply semantics
// ============================================================
// 2026-11-19 定稿（docs/trigger-system.md「agent 消息与会话感知系统」）：HTTP 请求/
// 响应模型。ContactAgent 是唯一的请求入口；回复 = 接收端被请求触发轮次的最终输出，
// 由系统在轮终态自动捕获回投（无回复工具、无 nudge）。
// 2026-11-20 worker 会话模型同构化（docs/worker-session-model.md §2）：master↔worker
// 通道收敛为本端口——投递经 AgentSessionDispatchPort 落到 Host 任务服务（机制同触发器
// 投递：寻址创建/唤醒目标会话，进其 runtime command queue）；登记表升格为进程共享
// （同 workspace 全部会话的轮终态捕获共用一个事实源）。

export interface AgentContactSubmitRequest {
  /** 发起方 handler 生成的全局唯一请求 id（contact_*）。 */
  requestId: string;
  /** 接收方：master 侧为 wkr-id；worker 侧仅接受 "master"。 */
  target: string;
  message: string;
  /**
   * 续接地址（对方会话 id）。寻址零耦合（2026-11-21 裁决）：缺省 = 一定新建对方会话，
   * 无"目标最新会话"隐式回退；续聊必须显式传地址（此前被联系过的 fromSessionId 或
   * 上次投递回填的 sessionId）。
   */
  sessionId?: string;
  needReply: boolean;
  trace: TraceContext;
}

export interface AgentContactSubmitResult {
  /** delivered：已投进接收端会话；failed：目标不可达（未注册 worker / 无 Host 通道等）。 */
  status: "delivered" | "failed";
  requestId: string;
  /** 接收端会话地址（回话用）。 */
  sessionId?: string;
  error?: string;
}

export interface AgentContactWaitResult {
  /** unknown_request 为登记表内部命名（请求不在未结算集合）；工具层映射为 already_settled。 */
  status: "replied" | "timeout" | "unknown_request";
  requestId: string;
  /** replied：接收端轮终态最终输出（原样回投）。 */
  text?: string;
  /** 回复来源会话地址（与 sessionId 呼应）。 */
  sessionId?: string;
  /** 合成回复（用户接管 / 轮次失败），非接收端原文。 */
  synthesized?: boolean;
  /** timeout / unknown_request 的模型可读说明（后续等待或注入行为的指引）。 */
  message?: string;
}

export interface AgentContactPort {
  submit(request: AgentContactSubmitRequest): Promise<AgentContactSubmitResult>;
  /**
   * 等待一个已投递请求的回复。超时不销毁请求（回到 open 态，可再次 WaitReply）；
   * 期间回复到达则立即随本结果返回；无等待者时回复异步注入发送端会话并唤醒。
   */
  wait(requestId: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentContactWaitResult>;
}

// ---- 跨会话投递端口（worker 会话同构化，2026-11-20） ----

/**
 * agent 会话跨会话投递请求：bootstrap 经 CLI→Host 反向请求落到桌面任务服务，
 * 机制与触发器投递同构（dispatchTriggerRun 模板）——寻址创建/唤醒目标智能体的会话，
 * 消息作为 prompt 进目标会话的 runtime command queue，<system-status> 标注来源。
 */
export interface AgentSessionDispatchRequest {
  /** 目标智能体 id："master" 或 wkr-*。 */
  targetAgentId: string;
  /**
   * 续聊目标会话 id。寻址零耦合（2026-11-21 裁决）：缺席 = 一定新建目标会话
   * （不存在"目标最新会话"回退）；Host 侧创建/唤醒后经 result.sessionId 回填实际地址。
   */
  targetSessionId?: string;
  /** 发起方会话 id（<system-status> fromSessionId，接收端回复的语义寻址）。 */
  fromSessionId: string;
  /** 发起方身份（<system-status> sender）。 */
  senderKind: "master" | "worker";
  /** 发起方身份 id（worker = wkr-id，<system-status> senderId）；master 缺省。 */
  senderId?: string;
  /** 发起方显示名（<system-status> senderName）。 */
  senderDisplayName: string;
  /**
   * 裸消息正文（2026-11-21 裸投递裁决：原文原样进接收方会话，零包装零转义）；
   * 来源与回复语义由 systemStatus 承载。
   */
  message: string;
  needReply: boolean;
  trace?: TraceContext;
}

export interface AgentSessionDispatchResult {
  status: "delivered" | "failed";
  /** 目标会话 id（创建/唤醒后的实际地址，供续聊与登记回填）。 */
  sessionId?: string;
  error?: string;
}

/** Host 侧投递通道；bootstrap 以 CLI→Host 反向请求实现，独立 CLI（无 Host）缺席。 */
export interface AgentSessionDispatchPort {
  dispatch(request: AgentSessionDispatchRequest): Promise<AgentSessionDispatchResult>;
}

// ---- 提示词契约（2026-11-21 裸投递修订） ----

// per-message 的 <instruction> 样板已移除（AGENT_CONTACT_REPLY_INSTRUCTION /
// AGENT_CONTACT_NOTIFICATION_INSTRUCTION 退役）：消息正文裸传，回复语义由
// <system-status>.replyExpected 承载，契约文案改由常驻系统提示词一次性说明
// （master 协作段 / worker 协作契约 / ContactAgent 工具描述，
// 见 core/src/context/dynamic-sections.ts 与 core/src/subagent/worker-prompt.ts）。

/**
 * 用户接管合成回复（定死英文）：接收方会话被用户打断/插话的瞬间，其在途全部
 * needReply 请求以此解除（同步=工具结果 / 异步=注入+唤醒），该轮输出不再捕获。
 */
export function agentContactTakeoverReply(receiverDisplayName: string): string {
  return `The counterpart (${receiverDisplayName}) has been taken over by the user; this request will not receive an automatic reply. They will reach out again once the user is done; if this matter is time-sensitive, follow up with a new ContactAgent request later.`;
}

/** 接收端轮次异常终止的合成回复（无静默路径：失败同样要解除在途请求）。 */
export function agentContactTurnFailedReply(receiverDisplayName: string): string {
  return `The counterpart (${receiverDisplayName}) ended their turn with an error; no reply was produced. Follow up with a new ContactAgent request if this matter is still relevant.`;
}

/**
 * 接收端会话关闭的合成回复（2026-11-22，登记表归属修订）：接收方会话关闭时，以其为
 * 接收方的在途 needReply 请求以此解除——应答方已随会话消失，回复不会再产生，发送方
 * 必须显式知情而非干等。发送方会话自身关闭不解除其发出的条目（Host 可冷恢复持久化
 * 会话，回复仍可送达）。
 */
export function agentContactSessionClosedReply(receiverDisplayName: string): string {
  return `The counterpart's session (${receiverDisplayName}) was closed before it could reply; no reply was produced. Follow up with a new ContactAgent request if this matter is still relevant.`;
}

/**
 * 进程重启中断的合成通知（2026-11-22，持久化冷恢复）：在途 needReply 条目随进程存活，
 * 重启后恢复落盘条目时逐条以此合成解除并唤醒发送方——重启 = 显式解约，不做跨重启的
 * 真回复重放（接收端轮次已被打断，其输出无法可靠归属到原请求）。
 */
export function agentContactRestartInterruptedReply(receiverDisplayName: string): string {
  return `The application restarted while (${receiverDisplayName}) was handling your request; the in-flight reply was interrupted and will not arrive. Follow up with a new ContactAgent request if this matter is still relevant.`;
}

/**
 * 重启中断合成通知·按发送方会话聚合变体（2026-11-23）：同一发送方会话的多条在途请求
 * 合并为一条通知投递（逐条投递 = 每条各唤醒一轮 LLM，成本翻倍；触发器侧 P3-12 已有
 * 同款忙时合并投递先例）。逐行列出 requestId 与接收方，发送方据此逐项决定是否重发。
 */
export function agentContactRestartInterruptedBatchReply(
  items: Array<{ requestId: string; receiverDisplayName: string }>,
): string {
  const lines = items
    .map((item, index) => `  ${index + 1}. ${item.requestId} (handled by ${item.receiverDisplayName})`)
    .join("\n");
  return `The application restarted while ${items.length} in-flight request${items.length === 1 ? " was" : "s were"} being handled; their replies were interrupted and will not arrive:\n${lines}\nFollow up with a new ContactAgent request for any matter that is still relevant.`;
}
