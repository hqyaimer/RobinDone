/* eslint-disable max-lines -- RobinDone task wrapper service 接口集中承载 app/runtime API，拆散会让替换阶段更难追踪。 */
import type { Event } from "@robindone/rpc";
import { ServiceChannels } from "@robindone/shared";
import type { CommandPayloadMap } from "@robindone/shared/robindone-protocol-v4";
import { createServiceDescriptor } from "#src/descriptors.js";
import type {
  RobinDoneImportSessionsResult,
  RobinDoneImportableSessionCandidate,
  RobinDoneSessionCompactResult,
  RobinDoneSessionGoalAction,
  RobinDoneSessionGoalResult,
  RobinDoneCodexConnectivityCheckResult,
  RobinDoneSwitchAgentResult,
  RobinDoneSyncTaskSessionBindingResult,
  RobinDoneTaskCreateResult,
  RobinDoneTaskMeta,
  RobinDoneStreamEvent,
  RobinDoneTaskMode,
  RobinDoneConfigOption,
  RobinDoneError,
  RobinDoneAssistantMessageFeedback,
  RobinDonePromptAttachment,
  RobinDoneProvider,
  RobinDoneWorkspaceEvent,
  TraceId,
  RobinDoneSessionFile,
  RobinDoneAgentMcpServer,
  RobinDoneTaskSnapshot,
  RobinDoneTaskSnapshotBody,
  RobinDoneTaskSnapshotToolCallsSlice,
  RobinDoneTaskSnapshotRefContent,
  RobinDoneEnqueueTaskCommandResult,
  RobinDoneCancelTaskCommandResult,
  RobinDoneTaskClientMode,
  RobinDoneTaskTokenUsageResult,
  RobinDonePermissionResponse,
  ModelSelection,
  RobinDoneBackgroundTurnAttribution,
  RobinDoneAutomationBotDeliveryTarget,
} from "@robindone/shared";
import type {
  SessionMessageDeliveryResult,
  SessionMessageSendRequested,
} from "#src/session/sessionMailbox.js";
import type {
  RobinDoneTaskListQuery,
  RobinDoneTaskListResult,
  RobinDoneTaskListSortBy,
  RobinDoneTaskListWorkspaceScope,
  RobinDoneWorkspaceEventSubscriptionParams,
} from "#src/session/robindoneTaskListTypes.js";

export interface RobinDoneTaskSnapshotWithEtagResult {
  snapshot: RobinDoneTaskSnapshot | null;
  etag?: string;
  notModified?: boolean;
}

/** 同一 workspace 的固定归档删除集合；每个去重后的目标恰好属于一种结果。 */
export interface RobinDoneArchivedTaskDeletionResult {
  deletedTaskIds: string[];
  skippedTaskIds: string[];
  failedTaskIds: string[];
}

/** 一次模型请求里出现的消息内容片段（文本 / 工具调用 / 工具结果 / 其他原始结构）。 */
export type RobinDoneModelTrajectoryContentPart =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool-call"; toolCallId?: string; toolName: string; input?: unknown }
  | { kind: "tool-result"; toolCallId?: string; toolName?: string; output?: unknown }
  | { kind: "image"; mediaType?: string }
  | { kind: "unknown"; raw: unknown };

/** 单条对话消息（system / user / assistant / tool）。 */
export interface RobinDoneModelTrajectoryMessage {
  role: string;
  parts: RobinDoneModelTrajectoryContentPart[];
}

/** model_io 记录里归一化出来的 token 用量。 */
export interface RobinDoneModelTrajectoryUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
}

export type RobinDoneModelTrajectoryCallSourceKind =
  | "main"
  | "sidecar"
  | "subagent"
  | "compact"
  | "unknown";

export interface RobinDoneModelTrajectoryCallSource {
  kind: RobinDoneModelTrajectoryCallSourceKind;
  querySource?: string;
}

/**
 * 一次模型调用（一条 model_io 记录）。轨迹按时间顺序由多条调用组成。
 * request.messages 是该次请求发送给模型的完整上下文（随轮次增长），
 * response 是这次调用模型产出的新内容。
 */
export interface RobinDoneModelTrajectoryRecord {
  requestId: string;
  attempt: number;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  turnId?: string;
  traceId?: string;
  callSource?: RobinDoneModelTrajectoryCallSource;
  model: {
    modelId?: string;
    providerId?: string;
    role?: string;
    source?: string;
  };
  request: {
    messages: RobinDoneModelTrajectoryMessage[];
    toolNames: string[];
  };
  response?: {
    finishReason?: string;
    text?: string;
    reasoningText?: string;
    toolCalls: RobinDoneModelTrajectoryContentPart[];
    usage?: RobinDoneModelTrajectoryUsage;
    responseId?: string;
    modelId?: string;
  };
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

/** 某个 task/session 的完整模型调用轨迹。 */
export interface RobinDoneModelTrajectory {
  taskId: string;
  /** runtime 是否支持读取 model-io 轨迹（仅 RobinDone Agent 落盘 model-io）。 */
  available: boolean;
  records: RobinDoneModelTrajectoryRecord[];
  /** 命中的源文件绝对路径，便于排查。 */
  sourceFiles: string[];
  /** 是否因为超出上限而截断（只保留最近 N 条）。 */
  truncated: boolean;
}

export type {
  RobinDoneTaskListKind,
  RobinDoneTaskListQuery,
  RobinDoneTaskListResult,
  RobinDoneTaskListSortBy,
  RobinDoneTaskListWorkspaceScope,
  RobinDoneWorkspaceEventSubscriptionParams,
} from "#src/session/robindoneTaskListTypes.js";

/** 一个 task 输入轮次的终态结果，供后台派发（定时任务）回写运行结果。 */
export interface RobinDoneTaskTerminalOutcome {
  taskId: string;
  /** 对应的输入轮次 id（= sendPrompt 的 traceId/inputId），用于精确匹配某次派发。 */
  inputId?: string;
  outcome: "succeeded" | "failed" | "stopped";
  /** 失败时的错误信息。 */
  error?: string;
}

/** 一次输入轮次已经真正收口，session 可以安全接受下一条输入。 */
export interface RobinDoneTaskReadyOutcome {
  taskId: string;
  reason: "prompt_completed" | "prompt_failed";
}

/**
 * IRobinDoneTaskService — RobinDone task wrapper API 服务接口
 *
 * UI、remote controller 通过这层访问 task wrapper 状态；核心 session 状态由
 * RobinDone Agent server 维护，新功能应优先走 IRobinDoneSessionService。
 */
export interface IRobinDoneTaskService {
  // ---- 生命周期 ----

  /** 检查 agent runtime 是否可用 */
  initialize(params: { workspacePath: string }): Promise<{ available: boolean; version?: string }>;

  /** 释放仅用于预热的空闲 workspace 会话，避免切走 tab 后继续空转 */
  releaseWorkspacePreparation(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: RobinDoneProvider;
  }): Promise<void>;

  /** Codex 草稿态预热前的网络检查，用于提前提醒 chatgpt.com 不可达 */
  checkCodexConnectivity(): Promise<RobinDoneCodexConnectivityCheckResult>;

  // ---- Task/Session 管理 ----

  /** 创建 RobinDone session 并同步 task 索引。 */
  createTask(params: {
    projectId?: string | null;
    additionalDirectories?: string[];
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: RobinDoneProvider;
    mode?: RobinDoneTaskMode;
    /** 正式模型选择；产品提交边界固定后不再拆成 model/thoughtLevel。 */
    modelSelection?: ModelSelection;
    /** @deprecated 仅供尚未迁移的旧调用边界读取。 */
    model?: string;
    /** @deprecated 仅供尚未迁移的旧调用边界读取。 */
    thoughtLevel?: string;
    forkedFromTaskId?: string;
    mcpServers?: RobinDoneAgentMcpServer[];
    /** 定时任务派发时标记所属 automation，落 tasks-index 的 cron_automation_id 并归入 cron 分组。 */
    automationId?: string;
    /** 闲时任务派发时标记所属 off-peak 任务，落 tasks-index 的 off_peak_task_id。 */
    offPeakTaskId?: string;
    /**
     * agent 会话身份（2026-11-20 worker 会话同构化，docs/worker-session-model.md）：
     * 触发器/ContactAgent 按订阅者寻址创建 worker 会话时下发 wkr-id；CLI 按名册解析
     * 校验显示名并落 worker_identity。缺席 = master 会话。
     */
    agentIdentity?: { kind: "worker"; workerId: string };
    /**
     * 无界面派发会先创建空 session，再立即发送首条 V4 输入。此时使用 deferred，
     * 让输入 admission 在写 session_input 外键账本前先统一持久化 session 主记录。
     */
    deferPersistenceUntilFirstPrompt?: boolean;
    /** Bot/host 使用 v4 原生 createSession 建立 draft，再配置并发送。 */
    v4Create?: boolean;
    permissionScope?: "session";
  }): Promise<RobinDoneTaskCreateResult>;

  readBotTopicSummaries?(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  }): Promise<Array<{ checkpoint: string; text: string }>>;

  invalidateBotTopicInputs?(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  }): Promise<void>;
  readBotTopicExecution?(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  }): Promise<{ executionId: string; sourceCommandId?: string } | undefined>;
  stopBotTopicExecution?(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    executionId: string;
  }): Promise<void>;

  /** 从 CLI 权威快照读取群任务切换的阻塞原因；空闲时返回 null。 */
  getBotGroupTaskBlockReason?(params: {
    taskId: string;
    remoteSessionId?: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<"running" | "queued" | "interaction" | null>;
  cancelBotGroupInput?(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    taskId: string;
    remoteSessionId?: string;
    commandId: string;
    sourceCommandId: string;
    actorId: string;
    ownerId: string;
    botId: string;
    chatId: string;
  }): Promise<import("@robindone/shared/robindone-protocol-v4").CommandAck>;
  submitBotGroupInput?(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    taskId: string;
    remoteSessionId?: string;
    commandId: string;
    content: string;
    conversationQuotes?: import("@robindone/shared").ConversationSelectionText[];
    attachments?: RobinDonePromptAttachment[];
    source: import("@robindone/shared").BotGroupInputSource;
  }): Promise<import("@robindone/shared/robindone-protocol-v4").CommandAck>;

  /** 发送 prompt 到指定 task */
  sendPrompt(
    params: {
      taskId: string;
      remoteSessionId?: string;
      traceId: TraceId;
      queryId?: string;
      messageId?: string;
      content: string;
      attachments?: RobinDonePromptAttachment[];
      clientId?: string;
      clientLabel?: string;
      clientMode?: RobinDoneTaskClientMode;
      /** 当前 turn 额外隐藏的工具；与 session/automation 自带的工具隔离规则合并。 */
      toolDenylist?: string[];
      /** Bot 来源 turn 的稳定回推地址；由 BotsService 注入，模型不可控。 */
      botDeliveryTarget?: RobinDoneAutomationBotDeliveryTarget;
      /** 标准模型选择；闲时任务同样经 Registry / ModelFactory 创建 Model。 */
      modelSelection?: CommandPayloadMap["sendText"]["modelSelection"];
      /** 单次执行约束与动态鉴权；仅 idle start-now 接受，不进入普通队列。 */
      modelExecution?: CommandPayloadMap["sendText"]["modelExecution"];
      /**
       * P3 触发器投递（2026-11-19 验收）：结构化来源身份（sender=trigger + triggerName/
       * sessionKey）。随命令进 entry metadata.systemStatus——渲染层据此归 mailbox 投影、
       * runtime 动态注入 <system-status> 区块；投递内容本身不再内嵌区块文本。
       */
      systemStatus?: CommandPayloadMap["sendText"]["systemStatus"];
    } & RobinDoneBackgroundTurnAttribution,
  ): Promise<void>;

  /**
   * 会话是否正在运行一个输入轮次（忙）。触发器投递的忙感知用（裁决 7：存在且忙 →
   * 引擎侧聚合桶继续累积，当前轮结束后合并为一条输入投递）。判定 = 本 adapter 的
   * active prompt/runtime command 簿记（sendPrompt 起、轮终态/ready 边界收）。
   */
  isTaskBusy(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<boolean>;

  deliverSessionMessage(
    request: SessionMessageSendRequested,
  ): Promise<SessionMessageDeliveryResult>;

  sendSessionMessageDeliveryResult(result: SessionMessageDeliveryResult): Promise<void>;

  /** 把 task runtime command 提交给 host；返回后代表 owner host 已接收。 */
  enqueueTaskCommand(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    commandId: string;
    traceId: TraceId;
    queryId?: string;
    type: "send_prompt";
    content: string;
    attachments?: RobinDonePromptAttachment[];
    clientId?: string;
    clientLabel?: string;
    /** 定时任务派发经 host command queue 延后执行时也必须保留 automation 上下文。 */
    automationId?: string;
    ownerRunId?: TraceId;
  }): Promise<RobinDoneEnqueueTaskCommandResult>;

  promoteTaskCommand(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    commandId: string;
    ownerRunId: TraceId;
    clientMode: RobinDoneTaskClientMode;
  }): Promise<RobinDoneEnqueueTaskCommandResult>;

  cancelTaskCommand(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    commandId: string;
    ownerRunId?: TraceId;
    clientMode: RobinDoneTaskClientMode;
  }): Promise<RobinDoneCancelTaskCommandResult>;

  /** 停止当前正在进行的生成 */
  stopGeneration(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    runId?: TraceId;
    /** CLI activeWorks 中观察到的执行身份，防止迟到停止误杀新轮。 */
    expectedForegroundExecutionId?: string;
  }): Promise<void>;

  /** 执行 agent 内建 /compact 命令；手机 replayable 仍经 shared host 路由。 */
  compactSession(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    inputId?: string;
    instructions?: string;
    expectedRevision?: number;
  }): Promise<RobinDoneSessionCompactResult>;

  /** 执行 agent 内建 /goal 命令；不要把 /goal 当普通正文 prompt 发送。 */
  goalSession(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    inputId?: string;
    action: RobinDoneSessionGoalAction;
    objective?: string;
    expectedRevision?: number;
  }): Promise<RobinDoneSessionGoalResult>;

  /** 响应权限请求 */
  respondPermission(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    runId?: TraceId;
    requestId: string;
    optionId: string;
    response: RobinDonePermissionResponse;
  }): Promise<boolean>;

  /** 响应用户问答请求（Elicitation） */
  respondElicitation(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    runId?: TraceId;
    requestId: string;
    action: "accept" | "decline" | "cancel";
    content?: Record<string, unknown>;
    clientMode?: RobinDoneTaskClientMode;
  }): Promise<boolean>;

  /** 恢复已有 task（复用 workspace 级 agent 进程，如无则创建，再执行 session/load） */
  resumeTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    additionalDirectories?: string[];
    mode?: RobinDoneTaskMode;
    model?: string;
    thoughtLevel?: string;
    /** 定时任务派发时恢复已有 targetTaskId，沿用 automation 工具面隔离。 */
    automationId?: string;
    /** 闲时续跑恢复 pre-会话时补写 off-peak 标记（新会话在 createTask 已盖章）。 */
    offPeakTaskId?: string;
    mcpServers?: RobinDoneAgentMcpServer[];
  }): Promise<RobinDoneTaskMeta>;

  /** 列出 workspace 下所有已持久化的 task */
  listTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<RobinDoneTaskMeta[]>;

  /** 读取全局 pinned task id 列表，真相源为 tasks-index.sqlite */
  listPinnedTaskIds(): Promise<string[]>;

  /** 按 tasks-index.sqlite 中的 pinned 状态列出当前 workspace 下所有 pinned task */
  listPinnedTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<RobinDoneTaskMeta[]>;

  /** 读取 workspace 下已删除 task id；供闲时绑定会话与 Bots tombstone 判断 session 是否已删除 */
  listDeletedTaskIds(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<string[]>;

  /**
   * 读取 workspace 下仍在运行（sessions-index phase 非终态）的 task id。
   * tasks-index 只镜像 CLI 的 last_outcome，行上的 status 永远不会是 running，
   * 运行中判断必须来自 syncer 的实时活动集合。
   */
  listActiveTaskIds(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<string[]>;

  /**
   * 按显式 workspace scopes 查询 tasks-index，供全局搜索与 Controller 查询使用。
   * 项目侧栏的行集合来自 ProjectService；旧远端列表缓存及 Group/bootstrap 已退役。
   */
  listTaskList(params: RobinDoneTaskListQuery): Promise<RobinDoneTaskListResult>;

  /** 列出 workspace 下所有已归档 task */
  listArchivedTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<RobinDoneTaskMeta[]>;

  /** 读取单个 task 的本地持久化快照，用于历史任务首屏展示 */
  getTaskSnapshot(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    messageLimit?: number;
    byteBudget?: number;
    toolLimit?: number;
    clientMode?: RobinDoneTaskClientMode;
    resumeModelPolicy?: "task-index" | "ui-resolved-only";
    model?: string;
    thoughtLevel?: string;
  }): Promise<RobinDoneTaskSnapshot | null>;

  /** 读取 task 快照并携带 ETag，支持 if-none-match 语义减少重复大包传输。 */
  getTaskSnapshotWithEtag(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    messageLimit?: number;
    ifNoneMatch?: string;
    byteBudget?: number;
    toolLimit?: number;
    clientMode?: RobinDoneTaskClientMode;
    resumeModelPolicy?: "task-index" | "ui-resolved-only";
    model?: string;
    thoughtLevel?: string;
  }): Promise<RobinDoneTaskSnapshotWithEtagResult>;

  /** 按 bodyRef 读取被首屏预算裁剪的大消息完整正文。 */
  getTaskSnapshotBody(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    refId: string;
  }): Promise<RobinDoneTaskSnapshotBody | null>;

  /** 按 ref 读取被首屏预算裁剪的工具或文件变更完整字段。 */
  getTaskSnapshotRef(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    refId: string;
  }): Promise<RobinDoneTaskSnapshotRefContent | null>;

  /** 按 message + 下标范围补拉 tools 切片，用于远控首屏按条数裁剪后的增量加载。 */
  getTaskSnapshotToolCallsSlice(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    messageIndex: number;
    startToolIndex: number;
    limit: number;
  }): Promise<RobinDoneTaskSnapshotToolCallsSlice | null>;

  /** 读取单个 task 的轻量 meta（不包含 messages/fileChanges），用于标题/provider 等展示兜底 */
  getTaskMeta(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<RobinDoneTaskMeta | null>;

  /** 读取当前 active task 内存态的配置选项，不做 workspace 预热兜底 */
  getTaskConfigOptions(params: { taskId: string }): Promise<RobinDoneConfigOption[]>;

  /** 读取绑定 Session 的原模型选择；不从候选菜单反推，不做有效解析或写入。 */
  getTaskModelSelection(params: { taskId: string }): Promise<ModelSelection | null>;

  /** 持久化用户对 assistant 回复的本地反馈；不会注入 provider 上下文。 */
  setAssistantMessageFeedback(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    turnIndex: number;
    feedback: RobinDoneAssistantMessageFeedback | null;
  }): Promise<RobinDoneSessionFile>;

  /**
   * 补齐 task 已存在的 provider session，使其覆盖当前 canonical task 的完整对话边界。
   * 这里只负责补齐原生日志，不负责切换当前 active provider。
   */
  syncTaskSessionBinding(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    provider: RobinDoneProvider;
    validate?: boolean;
  }): Promise<RobinDoneSyncTaskSessionBindingResult>;

  /**
   * 在同一个 task 内切换当前 active provider。
   * 当前支持 `claude` / `codex` / `gemini` 作为切换目标。
   */
  switchAgent(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    provider: RobinDoneProvider;
  }): Promise<RobinDoneSwitchAgentResult>;

  /** 扫描可导入的 Claude 原生 session；可选按 workspace 过滤。 */
  scanImportableClaudeSessions(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    modifiedSince?: number;
    limit?: number;
  }): Promise<RobinDoneImportableSessionCandidate[]>;

  /** 导入选中的 Claude 原生 session，并反向生成最小 task snapshot；不传 workspacePath 时按原始 workspace 导入。 */
  importClaudeSessions(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    sessionIds: string[];
  }): Promise<RobinDoneImportSessionsResult>;

  /** 切换 task 模式 */
  setMode(params: { taskId: string; mode: RobinDoneTaskMode }): Promise<void>;

  /** 切换 configOption（模型、思考级别等），返回更新后的完整 configOptions 列表 */
  setConfigOption(params: {
    taskId: string;
    traceId: TraceId;
    configId: string;
    value: string;
  }): Promise<RobinDoneConfigOption[]>;

  /** 切换模型，返回服务端 authoritative configOptions */
  setModel(params: {
    taskId: string;
    traceId: TraceId;
    modelSelection: ModelSelection;
  }): Promise<RobinDoneConfigOption[]>;

  /** 定时任务派发专用：收敛模型、Think 和权限模式，并让 V4 conversation 投影同步更新。 */
  setAutomationSessionConfig(params: {
    taskId: string;
    traceId: TraceId;
    modelSelection: ModelSelection;
    thoughtLevel?: string;
    mode?: RobinDoneTaskMode;
  }): Promise<RobinDoneConfigOption[]>;

  /** 获取 workspace + provider 对应的主配置文件路径 */
  getWorkspaceProviderConfigFile(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: RobinDoneProvider;
  }): Promise<{
    provider: RobinDoneProvider;
    path: string;
    exists: boolean;
  }>;

  /** 获取 task 对应的原生会话日志文件路径（如 Claude 的 session jsonl） */
  getTaskNativeSessionLogFile(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{
    provider: RobinDoneProvider | null;
    path: string | null;
    exists: boolean;
  }>;

  /**
   * 读取 task 对应的模型调用轨迹（来自 ~/.robindone/cli/{debug,rollout} 的 model-io JSONL）。
   * taskId 即 RobinDone Agent 的 sessionId，按 sessionId 匹配 model-io 记录。
   */
  getModelTrajectory(params: {
    taskId: string;
    /** 最多返回的调用条数（按时间倒序保留最近 N 条），默认 200。 */
    limit?: number;
  }): Promise<RobinDoneModelTrajectory>;

  /** 从 agent usage 数据库读取某个 task/session 的累计模型 token 用量。 */
  getTaskTokenUsage(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<RobinDoneTaskTokenUsageResult>;

  /** 获取 task 持久化快照文件路径（统一为 {taskId}.json，软删除例外为 .deleted.json） */
  getTaskSessionFilePath(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{
    path: string;
    exists: boolean;
  }>;

  /**
   * 重启指定 workspace 的 RobinDone Agent 共享进程。
   * 配置变更需要重新读取进程环境时使用。
   * 可选传入 resumeTaskId 在重启后立即续接当前聊天会话。
   */
  restartWorkspaceProcess(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: RobinDoneProvider;
    resumeTaskId?: string;
    bumpRuntimeEpoch?: boolean;
  }): Promise<void>;

  /** 将已持久化 task 标记为列表不可见；CLI session 内容继续保留 */
  deleteTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void>;

  /**
   * 清空任务会话的全部消息（2026-11-20 触发器会话清空）：会话与标题保留、触发器绑定
   * 不动；workerIdentityTo 同时重置持久化身份（触发器当前订阅者）——旧会话身份纠偏
   * 的正道（只清消息不改身份，冷恢复仍按旧身份装配）。运行中的会话拒绝并抛错。
   */
  clearTaskMessages(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    workerIdentityTo?: { workerId: string; workerName?: string } | null;
  }): Promise<void>;

  /** 仅删除写入时仍归档的任务；已恢复、已删除或不存在时返回 false，不清理 CLI 会话。 */
  deleteArchivedTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<boolean>;

  /** 逐项执行归档条件删除，批次结束后统一通知列表；不清理 CLI 会话。 */
  deleteArchivedTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskIds: string[];
  }): Promise<RobinDoneArchivedTaskDeletionResult>;

  /** 重命名已持久化的 task */
  renameTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    title: string;
  }): Promise<RobinDoneTaskMeta>;

  /** 更新 task 置顶状态 */
  setTaskPinned(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    pinned: boolean;
  }): Promise<RobinDoneTaskMeta>;

  /** 更新 task 未读状态 */
  setTaskUnread(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    unread: boolean;
    /** 仅用于已读 compare-and-clear；缺省时保持既有无条件写入语义。 */
    expectedUnreadAt?: number;
  }): Promise<RobinDoneTaskMeta>;

  /** 归档 task，使其从默认任务列表中隐藏 */
  archiveTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<RobinDoneTaskMeta>;

  /** 取消归档 task，使其重新回到默认任务列表 */
  unarchiveTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<RobinDoneTaskMeta>;

  /** 基于 source task 的会话配置新建一个空白分支，用于重新编辑某条用户输入。 */
  branchTaskFromPrompt(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sourceTaskId: string;
  }): Promise<RobinDoneTaskCreateResult>;

  // ---- 流式事件 ----

  /** 订阅指定 task 的流式更新（ProxyChannel 动态事件） */
  onDynamicStreamEvent(taskId: string): Event<RobinDoneStreamEvent>;

  /**
   * 订阅指定 task 的终态结果（succeeded / failed / stopped）。
   * 基于 task index 的常开 session 订阅，不依赖 renderer 是否正在观看该 task，
   * 因此后台派发（如定时任务）也能可靠拿到终态。用于回写 automation_runs.outcome。
   */
  onDynamicTaskTerminalOutcome(taskId: string): Event<RobinDoneTaskTerminalOutcome>;

  /**
   * 订阅指定 task 的输入就绪边界。sendPrompt 只返回远端 ACK，不能用它判断 Agent 已空闲；
   * Host runtime 回收必须等本事件，避免关闭 workspace 时中断仍在运行的 Agent。
   */
  onDynamicTaskReady(taskId: string): Event<RobinDoneTaskReadyOutcome>;

  /** 订阅指定 workspace + task 的流式更新，用于避免同 taskId 跨 workspace 串流。 */
  onDynamicTaskEvent(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    clientId?: string;
    deliveryKind?: "continuous" | "bot-channel-continuous" | "replayable" | "mixed";
  }): Event<RobinDoneStreamEvent>;

  /**
   * 订阅 workspace 级别的异步通知（如预热阶段 Agent 推送的 slash commands、configOptions）。
   * 覆盖 task 创建前的空档期，UI 收到后可实时更新草稿态的工具栏和命令列表。
   * 命名遵循 ProxyChannel 的 onDynamic 前缀约定，使 RPC 代理自动识别为动态事件。
   */
  onDynamicWorkspaceEvent(
    workspace: string | RobinDoneWorkspaceEventSubscriptionParams,
  ): Event<RobinDoneWorkspaceEvent>;

  /** 全局错误事件 */
  onError: Event<RobinDoneError>;
}

export const IRobinDoneTaskService = createServiceDescriptor<IRobinDoneTaskService>(
  ServiceChannels.RobinDoneTask,
);
