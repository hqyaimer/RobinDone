import type {
  TriggerRuntimeInstallRequest,
  TriggerRuntimeInstallResult,
  TriggerRuntimeOpenLoginRequest,
  TriggerRuntimeOpenLoginResult,
  TriggerRuntimePort,
  TriggerRuntimeRouteEventsRequest,
  TriggerRuntimeRouteEventsResult,
} from "@robindone/contracts";
import {
  robindoneProtocolMethods,
  robindoneTriggerRuntimeInstallParamsSchema,
  robindoneTriggerRuntimeInstallResultSchema,
  robindoneTriggerRuntimeOpenLoginParamsSchema,
  robindoneTriggerRuntimeOpenLoginResultSchema,
  robindoneTriggerRuntimeRouteEventsParamsSchema,
  robindoneTriggerRuntimeRouteEventsResultSchema,
} from "@robindone/shared";
import {
  protocolTraceFromTraceContext,
  requireSession,
  type RobinDoneProtocolAgentServerContext,
  type RobinDoneProtocolClientRequestOptions,
} from "./server-types.js";

/**
 * ProtocolTriggerRuntimePort —— TriggerRuntimePort 的 CLI 侧实现（2026-11-22 python 主
 * 运行时改造，docs/trigger-python-runtime.md §3.3）：ManageTriggers install_packages 每次
 * 转成 triggerRuntime/installPackages 反向请求，由 Host 落到触发器引擎（解释器/venv
 * ensure + pip + 依赖台账 + 重启活跃 python 脚本）。请求在途直至完成/失败（分钟级 pip，
 * 协议逐请求超时不适用）；独立 CLI（无 Host）时 requestClient 失败 → handler 报错引导
 * （诚实拒绝）。agentContactDispatch 同款机制（server-types 的 requestClient 信封路由）。
 * 2026-11-25 分发器裁决：routeEvents 同机制——RouteEvents 标记转 triggerRuntime/routeEvents
 * 反向请求，宿主落到引擎 routeEvents（会话 key 反查 + routing 门控 + RouteMarkQueue 兑现）。
 */
export function createProtocolTriggerRuntimePort(
  context: RobinDoneProtocolAgentServerContext,
): TriggerRuntimePort {
  return {
    async installPackages(
      request: TriggerRuntimeInstallRequest,
    ): Promise<TriggerRuntimeInstallResult> {
      const record = requireSession(context, request.sessionId);
      const workspaceIdentity = record.workspace.workspaceIdentity?.trim() || undefined;
      const remoteSessionId = record.workspace.remoteSessionId?.trim() || undefined;
      return await context.requestClient(
        robindoneProtocolMethods.triggerRuntimeInstallPackages,
        robindoneTriggerRuntimeInstallParamsSchema.parse({
          sessionId: request.sessionId,
          ...(workspaceIdentity || remoteSessionId
            ? {
                workspace: {
                  workspacePath: record.workspace.workspacePath,
                  ...(workspaceIdentity ? { workspaceIdentity } : {}),
                  ...(remoteSessionId ? { remoteSessionId } : {}),
                },
              }
            : {}),
          packages: request.packages,
        }),
        robindoneTriggerRuntimeInstallResultSchema,
        buildRequestOptions(request.trace),
      );
    },
    async routeEvents(
      request: TriggerRuntimeRouteEventsRequest,
    ): Promise<TriggerRuntimeRouteEventsResult> {
      const record = requireSession(context, request.sessionId);
      const workspaceIdentity = record.workspace.workspaceIdentity?.trim() || undefined;
      const remoteSessionId = record.workspace.remoteSessionId?.trim() || undefined;
      return await context.requestClient(
        robindoneProtocolMethods.triggerRuntimeRouteEvents,
        robindoneTriggerRuntimeRouteEventsParamsSchema.parse({
          sessionId: request.sessionId,
          ...(workspaceIdentity || remoteSessionId
            ? {
                workspace: {
                  workspacePath: record.workspace.workspacePath,
                  ...(workspaceIdentity ? { workspaceIdentity } : {}),
                  ...(remoteSessionId ? { remoteSessionId } : {}),
                },
              }
            : {}),
          routes: request.routes,
        }),
        robindoneTriggerRuntimeRouteEventsResultSchema,
        buildRequestOptions(request.trace),
      );
    },
    async openLogin(
      request: TriggerRuntimeOpenLoginRequest,
    ): Promise<TriggerRuntimeOpenLoginResult> {
      const record = requireSession(context, request.sessionId);
      const workspaceIdentity = record.workspace.workspaceIdentity?.trim() || undefined;
      const remoteSessionId = record.workspace.remoteSessionId?.trim() || undefined;
      return await context.requestClient(
        robindoneProtocolMethods.triggerRuntimeOpenLogin,
        robindoneTriggerRuntimeOpenLoginParamsSchema.parse({
          sessionId: request.sessionId,
          ...(workspaceIdentity || remoteSessionId
            ? {
                workspace: {
                  workspacePath: record.workspace.workspacePath,
                  ...(workspaceIdentity ? { workspaceIdentity } : {}),
                  ...(remoteSessionId ? { remoteSessionId } : {}),
                },
              }
            : {}),
          triggerId: request.triggerId,
          ...(request.url !== undefined ? { url: request.url } : {}),
        }),
        robindoneTriggerRuntimeOpenLoginResultSchema,
        buildRequestOptions(request.trace),
      );
    },
  };
}

// ---- context 级单例（agentContactState 同款）：createWorkspaceRobinDoneApp 每个 app
// 都会取一次端口；端口无状态，单例只为减少对象 churn 并对齐既有模式。 ----

interface ProtocolTriggerRuntimeState {
  port: TriggerRuntimePort;
}

const stateByContext = new WeakMap<RobinDoneProtocolAgentServerContext, ProtocolTriggerRuntimeState>();

export function triggerRuntimeState(
  context: RobinDoneProtocolAgentServerContext,
): ProtocolTriggerRuntimeState {
  let state = stateByContext.get(context);
  if (!state) {
    state = { port: createProtocolTriggerRuntimePort(context) };
    stateByContext.set(context, state);
  }
  return state;
}

function buildRequestOptions(
  traceContext: TriggerRuntimeInstallRequest["trace"],
): RobinDoneProtocolClientRequestOptions {
  return traceContext ? { trace: protocolTraceFromTraceContext(traceContext) } : {};
}
