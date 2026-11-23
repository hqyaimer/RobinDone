// ============================================================
// Subagent Port - child agent execution boundary
// ============================================================

import type { AgentBackgroundedOutput, AgentOutput } from "../tools/agent.js";
import type { Model, ModelSelection } from "../model/index.js";
import type { ModelRequestDependencies } from "../model/invocation-context.js";
import type { SessionId, ToolCallId, TurnId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";

export interface SubagentRunRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  parentToolCallId: ToolCallId | string;
  agentType: string;
  description: string;
  prompt: string;
  callerCanReadOutputFile?: boolean;
  workingDirectory: string;
  workspaceRoot: string;
  trace: TraceContext;
  /**
   * 谁在驱动这一轮（P2.5）：缺省 coordinator（Agent 工具/SendMessage）。
   * "user" 表示用户在 worker 会话里直接输入的恢复轮——子 runtime 按真实用户输入
   * 记账展示（real_user），并参与脱钩（detached）生命周期。
   */
  initiator?: "coordinator" | "user";
  /**
   * ContactAgent 管线标记（2026-11-19）：本次轮次由 ContactAgent 请求触发（恢复轮）。
   * 终态收尾据此抑制任务完成通知——回复捕获已取代完成通知作为回投路径。
   */
  contactRequestId?: string;
  /**
   * P2.6 工具分离：调用方声明的预期角色（历史上 DispatchWorker → "worker"，现仅 Agent → "subagent"；worker 派发已退役）。
   * runner 解析 profile 后校验：预期 worker 而解析结果非 worker → NOT_A_WORKER；
   * 预期 subagent 而解析结果是 worker → WORKER_DISPATCH_FORBIDDEN（提示改用 ContactAgent）。
   * 缺省不校验（兼容历史调用方）。
   */
  expectedKind?: "worker" | "subagent";
}

export interface SubagentRunOptions {
  signal?: AbortSignal;
  /** 未显式选模的 child 从父 Agent Loop 继承的不可变 Model。 */
  model?: Model;
  /** Core Server 对前台 child 的最高优先级 Selection；每个 child 仍自行创建 Model。 */
  modelOverride?: {
    selection: ModelSelection;
    requestDependencies?: ModelRequestDependencies;
    background: "deny" | "allow";
  };
}

export interface SubagentLaunchRequest extends SubagentRunRequest {
  runInBackground?: boolean;
}

export type SubagentLaunchOptions = SubagentRunOptions;

export type SubagentStartRequest = SubagentRunRequest;

export type SubagentStartOptions = SubagentRunOptions;

export interface SubagentWaitOptions {
  signal?: AbortSignal;
}

export interface SubagentStopOptions {
  /**
   * 谁在停：TaskStop 传 "model"，App 停止传 "user"，系统路径（rewind、闲时任务收尾）不传。
   * 后台 agent 的 killed 通知据此写 "was stopped by RobinRun" / "by user" / "was stopped"。
   */
  initiator?: "user" | "model";
  signal?: AbortSignal;
}

export interface SubagentSendMessageRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  parentToolCallId: ToolCallId | string;
  to: string;
  /** 可选：只用于 UI 预览，缺省时用 message 的第一行；交付给 child 的只有 message。 */
  summary?: string;
  message: string;
  workingDirectory: string;
  workspaceRoot: string;
  trace: TraceContext;
  /**
   * 谁在发消息（P2.5）：缺省 coordinator（主智能体 SendMessage）。"user" = 用户在
   * worker 会话里直接输入——先武装脱钩（detached）再交付，输入按真实用户记账展示。
   */
  initiator?: "coordinator" | "user";
  /**
   * ContactAgent 管线标记（2026-11-19，docs/trigger-system.md）：本次投递来自
   * ContactAgent 请求（requestId 对应进程内等待登记表的一行）。用于恢复轮的
   * 完成通知抑制（回复捕获取代任务完成通知）与注入回执。
   */
  contact?: {
    requestId: string;
    needReply: boolean;
  };
  /**
   * P2.5 注册表未命中兜底：CLI 重启后 registry 为空时，路由层凭派发时持久化的
   * worker 身份（runtime/worker-identity entry）合成快照恢复。to 在该路径下无意义。
   */
  identity?: {
    childSessionId: SessionId;
    agentType: string;
    workerId?: string;
    workerName?: string;
  };
}

export type SubagentSendMessageOptions = SubagentRunOptions;

export type SubagentSendMessageDelivery = "queued" | "steered" | "resumed_background";

export interface SubagentSendMessageResult {
  status: "success" | "failed";
  messageId: string;
  delivery?: SubagentSendMessageDelivery;
  message?: string;
  error?: string;
  agentId?: string;
  taskId?: string;
  outputFile?: string;
}

export type SubagentTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "killed"
  | "stopped"
  | "lost";

export interface SubagentTaskSnapshot {
  taskId: string;
  agentId: string;
  agentType: string;
  description: string;
  status: SubagentTaskStatus;
  startedAt: Date;
  completedAt?: Date;
  childSessionId?: SessionId;
  parentToolCallId?: ToolCallId | string;
  pid?: number;
  error?: string;
  output?: AgentOutput;
  outputFile?: string;
  notified?: boolean;
  /** P2.5：名册 worker 派生的任务（worker_child 会话），脱钩/返回生命周期只作用于它。 */
  workerChild?: boolean;
  /** P2.6：worker 显示名（注册表），任务通知的来源区块（senderName）用。 */
  workerName?: string;
  /** P2.5 脱钩：用户介入后为 true——终态通知暂缓投递给派发者，直到返回工具触发。 */
  detached?: boolean;
  /** P2.5 延迟返回：worker 已调用 ReturnToDispatcher，本轮终态时投递积压通知并解除脱钩。 */
  returnRequested?: boolean;
  /** worker 调用返回工具时留下的交接摘要，随积压通知一起投递。 */
  returnSummary?: string;
}

export interface SubagentPort {
  /** 关闭准入，取消所属执行并等待真实执行和资源清理；不删除历史。 */
  close?(): Promise<void>;
  launch(request: SubagentLaunchRequest, options?: SubagentLaunchOptions): Promise<AgentOutput>;
  run(request: SubagentRunRequest, options?: SubagentRunOptions): Promise<AgentOutput>;
  start?(
    request: SubagentStartRequest,
    options?: SubagentStartOptions,
  ): Promise<AgentBackgroundedOutput>;
  backgroundTask?(taskId: string): Promise<SubagentTaskSnapshot | undefined>;
  getTask?(taskId: string): Promise<SubagentTaskSnapshot | undefined>;
  /** 按 child session 反查任务（P2.5 路由：用户在 worker 会话里 stop/输入时定位任务）。 */
  getTaskByChildSessionId?(childSessionId: SessionId): Promise<SubagentTaskSnapshot | undefined>;
  waitForTask?(
    taskId: string,
    options?: SubagentWaitOptions,
  ): Promise<SubagentTaskSnapshot | undefined>;
  stopTask?(
    taskId: string,
    options?: SubagentStopOptions,
  ): Promise<SubagentTaskSnapshot | undefined>;
  /** P2.5：按 child session 停任务（用户在 worker 会话里打断，路由层用它）。 */
  stopTaskForChildSession?(
    childSessionId: SessionId,
    options?: SubagentStopOptions,
  ): Promise<SubagentTaskSnapshot | undefined>;
  sendMessage?(
    request: SubagentSendMessageRequest,
    options?: SubagentSendMessageOptions,
  ): Promise<SubagentSendMessageResult>;
  /**
   * 项目权限全量同步（2026-11-18）：按 childSessionId 找到仍在运行的子 runtime 并切换
   * 协作模式。配置类命令对 worker_child 会话不能落在物化 shell runtime 上（那是冷恢复
   * 的空壳，不是持有执行态的活 runtime），必须路由到派发者端口由父 runtime 找到真正的
   * 子 runtime 生效。
   */
  setChildSessionMode?(input: {
    childSessionId: SessionId;
    mode: string;
    traceContext?: TraceContext;
  }): Promise<{ ok: boolean; error?: string }>;
}
