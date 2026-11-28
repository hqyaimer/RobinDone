import type {
  OpsPanelRuntimePort,
  OpsPanelListEntriesRequest,
  OpsPanelGetEntryRequest,
  OpsPanelCreateEntryRequest,
  OpsPanelDecideRequirementRequest,
  OpsPanelResolveFeedbackRequest,
  OpsPanelAcknowledgeApprovalRequest,
  OpsPanelAppendProgressRequest,
  OpsPanelUpdateProgressRequest,
  OpsPanelDeleteProgressRequest,
  OpsPanelPortView,
  OpsPanelPortEntryResult,
  OpsPanelPortProgressView,
  OpsPanelPortProgressEntryResult,
  OpsPanelPortProgressDeleteResult,
} from "@robindone/contracts";
import {
  robindoneProtocolMethods,
  robindoneOpsPanelListEntriesParamsSchema,
  robindoneOpsPanelGetEntryParamsSchema,
  robindoneOpsPanelCreateEntryParamsSchema,
  robindoneOpsPanelDecideRequirementParamsSchema,
  robindoneOpsPanelResolveFeedbackParamsSchema,
  robindoneOpsPanelAcknowledgeApprovalParamsSchema,
  robindoneOpsPanelAppendProgressParamsSchema,
  robindoneOpsPanelUpdateProgressParamsSchema,
  robindoneOpsPanelDeleteProgressParamsSchema,
  robindoneOpsPanelGetProgressViewParamsSchema,
  robindoneOpsPanelViewResultSchema,
  robindoneOpsPanelEntryResultSchema,
  robindoneOpsPanelProgressViewResultSchema,
  robindoneOpsPanelProgressEntryResultSchema,
  robindoneOpsPanelProgressDeleteResultSchema,
} from "@robindone/shared";
import {
  protocolTraceFromTraceContext,
  requireSession,
  type RobinDoneProtocolAgentServerContext,
  type RobinDoneProtocolClientRequestOptions,
} from "./server-types.js";

/**
 * ProtocolOpsPanelPort —— OpsPanelRuntimePort 的 CLI 侧实现（2026-11-24 需求/审批/反馈
 * 面板 MVP）：ManageOpsPanel 每个动作转成 opsPanel/* 反向请求，由 Host 落到面板服务
 * （IOpsPanelService，权限矩阵 + worker 可见性在服务层强制）。actor 由 handler 按会话
 * 身份机制层派生后随请求携带；请求在途直至完成/失败（面板动作是本地 SQLite + 可能的
 * 会话唤醒投递，协议逐请求超时不适用）；独立 CLI（无 Host）时 requestClient 失败 →
 * handler 报错引导（诚实拒绝）。triggerRuntimePort 同款机制（server-types 的
 * requestClient 信封路由）。
 */
export function createProtocolOpsPanelPort(
  context: RobinDoneProtocolAgentServerContext,
): OpsPanelRuntimePort {
  // 会话锚点 + 工作区信封 + trace 选项（trigger-runtime-port 同构）：requireSession
  // 顺带校验会话在册；workspace 信封只在有身份/远端标记时携带（与 installPackages 一致）。
  const envelope = (
    request: OpsPanelListEntriesRequest,
  ): { workspaceEnvelope: Record<string, unknown>; requestOptions: RobinDoneProtocolClientRequestOptions } => {
    const record = requireSession(context, request.sessionId);
    const workspaceIdentity = record.workspace.workspaceIdentity?.trim() || undefined;
    const remoteSessionId = record.workspace.remoteSessionId?.trim() || undefined;
    return {
      workspaceEnvelope:
        workspaceIdentity || remoteSessionId
          ? {
              workspacePath: record.workspace.workspacePath,
              ...(workspaceIdentity ? { workspaceIdentity } : {}),
              ...(remoteSessionId ? { remoteSessionId } : {}),
            }
          : {},
      requestOptions: request.trace
        ? { trace: protocolTraceFromTraceContext(request.trace) }
        : {},
    };
  };
  return {
    async listEntries(request: OpsPanelListEntriesRequest): Promise<OpsPanelPortView> {
      const { workspaceEnvelope, requestOptions } = envelope(request);
      return await context.requestClient(
        robindoneProtocolMethods.opsPanelListEntries,
        robindoneOpsPanelListEntriesParamsSchema.parse({
          sessionId: request.sessionId,
          ...workspaceEnvelope,
          actor: request.actor,
        }),
        robindoneOpsPanelViewResultSchema,
        requestOptions,
      );
    },
    async getEntry(request: OpsPanelGetEntryRequest): Promise<OpsPanelPortEntryResult> {
      const { workspaceEnvelope, requestOptions } = envelope(request);
      return await context.requestClient(
        robindoneProtocolMethods.opsPanelGetEntry,
        robindoneOpsPanelGetEntryParamsSchema.parse({
          sessionId: request.sessionId,
          ...workspaceEnvelope,
          actor: request.actor,
          entryId: request.entryId,
        }),
        robindoneOpsPanelEntryResultSchema,
        requestOptions,
      );
    },
    async createEntry(request: OpsPanelCreateEntryRequest): Promise<OpsPanelPortEntryResult> {
      const { workspaceEnvelope, requestOptions } = envelope(request);
      return await context.requestClient(
        robindoneProtocolMethods.opsPanelCreateEntry,
        robindoneOpsPanelCreateEntryParamsSchema.parse({
          sessionId: request.sessionId,
          ...workspaceEnvelope,
          actor: request.actor,
          kind: request.kind,
          title: request.title,
          body: request.body,
          // 来源标记（2026-11-24 录入与来源拆分）：master 代录反馈必传 user|master。
          // 2026-11-25 实测缺陷（P1-2）：此处漏转发 author，工具链六段唯独这一段断——
          // 服务层按"缺 author"误报，master 的 create_feedback 完全不可用。
          ...(request.author !== undefined ? { author: request.author } : {}),
        }),
        robindoneOpsPanelEntryResultSchema,
        requestOptions,
      );
    },
    async decideRequirement(
      request: OpsPanelDecideRequirementRequest,
    ): Promise<OpsPanelPortEntryResult> {
      const { workspaceEnvelope, requestOptions } = envelope(request);
      return await context.requestClient(
        robindoneProtocolMethods.opsPanelDecideRequirement,
        robindoneOpsPanelDecideRequirementParamsSchema.parse({
          sessionId: request.sessionId,
          ...workspaceEnvelope,
          actor: request.actor,
          entryId: request.entryId,
          outcome: request.outcome,
          ...(request.note !== undefined ? { note: request.note } : {}),
        }),
        robindoneOpsPanelEntryResultSchema,
        requestOptions,
      );
    },
    async resolveFeedback(
      request: OpsPanelResolveFeedbackRequest,
    ): Promise<OpsPanelPortEntryResult> {
      const { workspaceEnvelope, requestOptions } = envelope(request);
      return await context.requestClient(
        robindoneProtocolMethods.opsPanelResolveFeedback,
        robindoneOpsPanelResolveFeedbackParamsSchema.parse({
          sessionId: request.sessionId,
          ...workspaceEnvelope,
          actor: request.actor,
          entryId: request.entryId,
          ...(request.note !== undefined ? { note: request.note } : {}),
        }),
        robindoneOpsPanelEntryResultSchema,
        requestOptions,
      );
    },
    async acknowledgeApproval(
      request: OpsPanelAcknowledgeApprovalRequest,
    ): Promise<OpsPanelPortEntryResult> {
      const { workspaceEnvelope, requestOptions } = envelope(request);
      return await context.requestClient(
        robindoneProtocolMethods.opsPanelAcknowledgeApproval,
        robindoneOpsPanelAcknowledgeApprovalParamsSchema.parse({
          sessionId: request.sessionId,
          ...workspaceEnvelope,
          actor: request.actor,
          entryId: request.entryId,
          ...(request.note !== undefined ? { note: request.note } : {}),
        }),
        robindoneOpsPanelEntryResultSchema,
        requestOptions,
      );
    },
    // ---- 进度账本（2026-11-25，specs/progress-ledger.md）：master 独占维护 ----
    async getProgressView(request: OpsPanelListEntriesRequest): Promise<OpsPanelPortProgressView> {
      const { workspaceEnvelope, requestOptions } = envelope(request);
      return await context.requestClient(
        robindoneProtocolMethods.opsPanelGetProgressView,
        robindoneOpsPanelGetProgressViewParamsSchema.parse({
          sessionId: request.sessionId,
          ...workspaceEnvelope,
          actor: request.actor,
        }),
        robindoneOpsPanelProgressViewResultSchema,
        requestOptions,
      );
    },
    async appendProgress(
      request: OpsPanelAppendProgressRequest,
    ): Promise<OpsPanelPortProgressEntryResult> {
      const { workspaceEnvelope, requestOptions } = envelope(request);
      return await context.requestClient(
        robindoneProtocolMethods.opsPanelAppendProgress,
        robindoneOpsPanelAppendProgressParamsSchema.parse({
          sessionId: request.sessionId,
          ...workspaceEnvelope,
          actor: request.actor,
          title: request.title,
          ...(request.body !== undefined ? { body: request.body } : {}),
          ...(request.links !== undefined ? { links: request.links } : {}),
        }),
        robindoneOpsPanelProgressEntryResultSchema,
        requestOptions,
      );
    },
    async updateProgress(
      request: OpsPanelUpdateProgressRequest,
    ): Promise<OpsPanelPortProgressEntryResult> {
      const { workspaceEnvelope, requestOptions } = envelope(request);
      return await context.requestClient(
        robindoneProtocolMethods.opsPanelUpdateProgress,
        robindoneOpsPanelUpdateProgressParamsSchema.parse({
          sessionId: request.sessionId,
          ...workspaceEnvelope,
          actor: request.actor,
          entryId: request.entryId,
          ...(request.title !== undefined ? { title: request.title } : {}),
          ...(request.body !== undefined ? { body: request.body } : {}),
          ...(request.links !== undefined ? { links: request.links } : {}),
        }),
        robindoneOpsPanelProgressEntryResultSchema,
        requestOptions,
      );
    },
    async deleteProgress(
      request: OpsPanelDeleteProgressRequest,
    ): Promise<OpsPanelPortProgressDeleteResult> {
      const { workspaceEnvelope, requestOptions } = envelope(request);
      return await context.requestClient(
        robindoneProtocolMethods.opsPanelDeleteProgress,
        robindoneOpsPanelDeleteProgressParamsSchema.parse({
          sessionId: request.sessionId,
          ...workspaceEnvelope,
          actor: request.actor,
          entryId: request.entryId,
        }),
        robindoneOpsPanelProgressDeleteResultSchema,
        requestOptions,
      );
    },
  };
}

// ---- context 级单例（triggerRuntimeState 同款）：createWorkspaceRobinDoneApp 每个 app
// 都会取一次端口；端口无状态，单例只为减少对象 churn 并对齐既有模式。 ----

interface ProtocolOpsPanelState {
  port: OpsPanelRuntimePort;
}

const stateByContext = new WeakMap<RobinDoneProtocolAgentServerContext, ProtocolOpsPanelState>();

export function opsPanelState(context: RobinDoneProtocolAgentServerContext): ProtocolOpsPanelState {
  let state = stateByContext.get(context);
  if (!state) {
    state = { port: createProtocolOpsPanelPort(context) };
    stateByContext.set(context, state);
  }
  return state;
}
