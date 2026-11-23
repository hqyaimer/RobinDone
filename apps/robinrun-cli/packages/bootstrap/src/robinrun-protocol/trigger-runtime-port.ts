import type {
  TriggerRuntimeInstallRequest,
  TriggerRuntimeInstallResult,
  TriggerRuntimePort,
} from "@robinrun/contracts";
import {
  robinrunProtocolMethods,
  robinrunTriggerRuntimeInstallParamsSchema,
  robinrunTriggerRuntimeInstallResultSchema,
} from "@robinrun/shared";
import {
  protocolTraceFromTraceContext,
  requireSession,
  type RobinRunProtocolAgentServerContext,
  type RobinRunProtocolClientRequestOptions,
} from "./server-types.js";

/**
 * ProtocolTriggerRuntimePort —— TriggerRuntimePort 的 CLI 侧实现（2026-11-22 python 主
 * 运行时改造，docs/trigger-python-runtime.md §3.3）：ManageTriggers install_packages 每次
 * 转成 triggerRuntime/installPackages 反向请求，由 Host 落到触发器引擎（解释器/venv
 * ensure + pip + 依赖台账 + 重启活跃 python 脚本）。请求在途直至完成/失败（分钟级 pip，
 * 协议逐请求超时不适用）；独立 CLI（无 Host）时 requestClient 失败 → handler 报错引导
 * （诚实拒绝）。agentContactDispatch 同款机制（server-types 的 requestClient 信封路由）。
 */
export function createProtocolTriggerRuntimePort(
  context: RobinRunProtocolAgentServerContext,
): TriggerRuntimePort {
  return {
    async installPackages(
      request: TriggerRuntimeInstallRequest,
    ): Promise<TriggerRuntimeInstallResult> {
      const record = requireSession(context, request.sessionId);
      const workspaceIdentity = record.workspace.workspaceIdentity?.trim() || undefined;
      const remoteSessionId = record.workspace.remoteSessionId?.trim() || undefined;
      return await context.requestClient(
        robinrunProtocolMethods.triggerRuntimeInstallPackages,
        robinrunTriggerRuntimeInstallParamsSchema.parse({
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
        robinrunTriggerRuntimeInstallResultSchema,
        buildRequestOptions(request.trace),
      );
    },
  };
}

// ---- context 级单例（agentContactState 同款）：createWorkspaceRobinRunApp 每个 app
// 都会取一次端口；端口无状态，单例只为减少对象 churn 并对齐既有模式。 ----

interface ProtocolTriggerRuntimeState {
  port: TriggerRuntimePort;
}

const stateByContext = new WeakMap<RobinRunProtocolAgentServerContext, ProtocolTriggerRuntimeState>();

export function triggerRuntimeState(
  context: RobinRunProtocolAgentServerContext,
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
): RobinRunProtocolClientRequestOptions {
  return traceContext ? { trace: protocolTraceFromTraceContext(traceContext) } : {};
}
