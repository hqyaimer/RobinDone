import { ServiceChannels } from "@robindone/shared";
import type {
  TraceId,
  RobinDoneAgentMcpServer,
  RobinDoneDeliveryKind,
  RobinDoneMessageWithParts,
  ModelSelection,
  RobinDonePermissionRequestParams,
  RobinDoneProviderRuntimeHeadersRequestParams,
  RobinDoneUserInputRequestParams,
  RobinDoneUserInputResponse,
  RobinDoneSessionInfo,
  RobinDoneSessionImportHistory,
  RobinDoneSessionEvent,
  RobinDoneSessionMode,
  RobinDoneSessionPersistence,
  RobinDoneSessionStateSnapshot,
  RobinDoneStateUpdatedNotification,
  RobinDoneWorkspacePresentation,
} from "@robindone/shared";
import { createServiceDescriptor } from "#src/descriptors.js";
import type { ProviderRuntimeHeadersUiResponse } from "#src/robindone-agent/robindoneAgent.js";

export interface RobinDoneSessionWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export type RobinDoneSessionReadWorkspacePresentationParams = RobinDoneSessionWorkspaceTarget;

export interface RobinDoneTaskTarget extends RobinDoneSessionWorkspaceTarget {
  sessionId: string;
}

export interface RobinDoneSessionCreateParams extends RobinDoneSessionWorkspaceTarget {
  /** 仅导入事务使用的预分配 ID；普通新会话继续由 Agent 分配。 */
  sessionId?: string;
  sessionTraceId?: TraceId;
  parentSessionId?: string;
  mode?: RobinDoneSessionMode;
  model?: ModelSelection;
  persistence?: RobinDoneSessionPersistence;
  thoughtLevel?: string;
  mcpServers?: RobinDoneAgentMcpServer[];
  importedHistory?: RobinDoneSessionImportHistory;
}

export interface RobinDoneSessionResumeParams extends RobinDoneTaskTarget {
  model?: ModelSelection;
  thoughtLevel?: string;
  mcpServers?: RobinDoneAgentMcpServer[];
  /**
   * 默认广播 resume 得到的历史快照，并让 shadow 订阅请求初始 snapshot。
   * 续聊发送前的 runtime 预恢复会关闭它，避免旧终态快照覆盖本地已开始的新输入运行态。
   */
  broadcastSnapshot?: boolean;
}

export interface RobinDoneSessionListParams extends RobinDoneSessionWorkspaceTarget {
  limit?: number;
}

export interface RobinDoneSessionReadParams extends RobinDoneTaskTarget {
  deliveryKind?: RobinDoneDeliveryKind;
  messageLimit?: number;
  afterSeq?: number;
}

export interface RobinDoneSessionMessagesParams extends RobinDoneTaskTarget {
  afterMessageId?: string;
  limit?: number;
}

export interface RobinDoneSessionEventsParams extends RobinDoneTaskTarget {
  afterSeq?: number;
  limit?: number;
}

export interface RobinDoneSessionSetModelParams extends RobinDoneTaskTarget {
  model: ModelSelection;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface RobinDoneSessionSetThoughtLevelParams extends RobinDoneTaskTarget {
  thoughtLevel?: string;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface RobinDoneSessionSetModeParams extends RobinDoneTaskTarget {
  mode: RobinDoneSessionMode;
  expectedRevision?: number;
}

export interface RobinDoneSessionRespondProviderRuntimeHeadersParams extends RobinDoneTaskTarget {
  requestId: string;
  response: ProviderRuntimeHeadersUiResponse;
}

export interface RobinDoneSessionSubscribeParams extends RobinDoneTaskTarget {
  deliveryKind: RobinDoneDeliveryKind;
  afterSeq?: number;
  includeSnapshot?: boolean;
  eventCoalescing?: {
    mode: "background-summary";
    intervalMs?: number;
  };
}

export type RobinDoneSessionServiceEvent =
  | { type: "session.event"; event: RobinDoneSessionEvent }
  | { type: "state.updated"; notification: RobinDoneStateUpdatedNotification }
  | { type: "permission.request"; request: RobinDonePermissionRequestParams }
  | { type: "userInput.request"; request: RobinDoneUserInputRequestParams }
  | {
      type: "userInput.response";
      requestId: string;
      response: RobinDoneUserInputResponse;
    }
  | {
      type: "providerRuntimeHeaders.request";
      request: RobinDoneProviderRuntimeHeadersRequestParams;
    }
  | { type: "snapshot"; snapshot: RobinDoneSessionStateSnapshot };

export interface RobinDoneSessionInitializeResult {
  available: boolean;
  workspaceKey: string;
  protocolName?: string;
  protocolVersion?: number;
  transportKind?: "stdio" | "websocket";
  reason?: string;
  reasonCode?: "provider_not_ready";
}

export interface RobinDoneSessionWorkspaceRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
}

export interface IRobinDoneSessionService {
  initializeWorkspace(
    params: RobinDoneSessionWorkspaceTarget,
  ): Promise<RobinDoneSessionInitializeResult>;
  getWorkspaceRuntimeIdentity(
    params: RobinDoneSessionWorkspaceTarget,
  ): Promise<RobinDoneSessionWorkspaceRuntimeIdentity>;
  readWorkspacePresentation(
    params: RobinDoneSessionReadWorkspacePresentationParams,
  ): Promise<RobinDoneWorkspacePresentation>;
  createSession(params: RobinDoneSessionCreateParams): Promise<RobinDoneSessionStateSnapshot>;
  resumeSession(params: RobinDoneSessionResumeParams): Promise<RobinDoneSessionStateSnapshot>;
  listSessions(params: RobinDoneSessionListParams): Promise<RobinDoneSessionInfo[]>;
  readSession(params: RobinDoneSessionReadParams): Promise<RobinDoneSessionStateSnapshot>;
  readSessionMessages(params: RobinDoneSessionMessagesParams): Promise<RobinDoneMessageWithParts[]>;
  readSessionEvents(params: RobinDoneSessionEventsParams): Promise<RobinDoneSessionEvent[]>;
  promoteDeferredDraftSession(params: RobinDoneTaskTarget): Promise<void>;
  closeSession(params: RobinDoneTaskTarget): Promise<void>;
  closeDeferredDraftSession(params: RobinDoneTaskTarget): Promise<boolean>;
  setModel(params: RobinDoneSessionSetModelParams): Promise<RobinDoneSessionStateSnapshot>;
  setThoughtLevel(
    params: RobinDoneSessionSetThoughtLevelParams,
  ): Promise<RobinDoneSessionStateSnapshot>;
  setMode(params: RobinDoneSessionSetModeParams): Promise<RobinDoneSessionStateSnapshot>;
  respondProviderRuntimeHeaders(
    params: RobinDoneSessionRespondProviderRuntimeHeadersParams,
  ): Promise<void>;
  // M5 删波次 2：onDynamicSessionEvent（旧 session/subscribe 词表的 renderer 订阅面）
  // 已删除——v4 UI 走 agentService 的 conversation/sessions-index 帧通道，
  // 该方法在 renderer 侧已无任何调用者（grep packages/ui packages/desktop 为零）。
}

export const IRobinDoneSessionService = createServiceDescriptor<IRobinDoneSessionService>(
  ServiceChannels.RobinDoneSession,
);
