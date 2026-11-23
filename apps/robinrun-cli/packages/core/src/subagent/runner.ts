/* eslint-disable max-lines -- subagent runner 集中维护前台/后台生命周期、registry 与 notification 顺序，拆分前需要先稳定生命周期边界。 */
// ============================================================
// Subagent Runner
// ============================================================

import type { GetAgentDefinitions } from "./definitions.js";
import {
  AgentErrorCode,
  CoreErrorType,
  DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
  SessionEventType,
  createChildTraceContext,
  createCoreError,
  createSessionEvent,
  createSessionId,
  createTraceId,
  getModelUsageTotalTokens,
  hasModelUsage,
  isCoreError,
  traceContextToLogContext,
  type AgentBackgroundedOutput,
  type BackgroundResultOriginMeta,
  type AgentCompletedOutput,
  type AgentOutput,
  type Logger,
  type ModelUsage,
  type SessionEvent,
  type SessionId,
  type SubagentLaunchOptions,
  type SubagentLaunchRequest,
  type SubagentPort,
  type SubagentRunOptions,
  type SubagentRunRequest,
  type SubagentSendMessageOptions,
  type SubagentSendMessageRequest,
  type SubagentSendMessageResult,
  type SubagentStartOptions,
  type SubagentStartRequest,
  type SubagentStopOptions,
  type SubagentTaskSnapshot,
  type SubagentWaitOptions,
  type TraceContext,
} from "@robinrun/contracts";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  isBuiltInExploreAgentProfile,
  normalizeAgentProfiles,
  type AgentProfile,
} from "./profile.js";
import { EXPLORE_AGENT_ALLOWED_TOOLS } from "./explore-tools.js";
import {
  formatLocalAgentTaskNotification,
  localAgentSubagentResult,
  type LocalAgentTaskNotificationInput,
} from "./completion-notification.js";
import { filterSubagentChildToolNames } from "./tool-policy.js";
import {
  ErrorPayloadRole,
  selectExecutionErrorMessage,
  withErrorPayloadRole,
} from "../errors/error-payload.js";
import {
  InMemoryRuntimeTaskRegistry,
  isTerminalRuntimeTask,
  type RuntimeTaskMessageSink,
  type RuntimeTaskPendingMessage,
  type RuntimeTaskRegistry,
  type RuntimeTaskSnapshot,
} from "../runtime-task/registry.js";
import {
  agentContactTakeoverReply,
  agentContactTurnFailedReply,
  AgentContactRegistry,
} from "./agent-contact.js";

export interface ExploreSubagentRuntimeRequest {
  agentId: string;
  agentType: string;
  allowedTools: readonly string[];
  /** 每次读取都返回 runtime task registry 的当前 foreground/background 状态。 */
  background: boolean;
  disallowedTools?: readonly string[];
  sessionId: SessionId;
  description: string;
  maxTurns?: number;
  /** child session 已持久化且可被 projection/query 读取后、首次模型执行前调用。 */
  onSessionReady?: () => Promise<void>;
  permissionMode?: AgentProfile["permissionMode"];
  prompt: string;
  profile: AgentProfile;
  /** P2.5：用户在 worker 会话直接输入的恢复轮——子 runtime 按真实用户输入记账展示。 */
  initiator?: "coordinator" | "user";
  registerMessageSink?: (sink: RuntimeTaskMessageSink) => void;
  reportActivity?: () => void;
  resumeFromStore?: boolean;
  systemPrompt?: string;
  workingDirectory: string;
  workspaceRoot: string;
  traceContext: TraceContext;
}

export interface ExploreSubagentRuntimeResult {
  response: string;
  traceId: TraceContext["traceId"];
  events: SessionEvent[];
  /**
   * 本轮 turnId（2026-11-18 mailbox 跳转）：生产实现返回 childRuntime.executeTurn 的完整
   * TurnResult，turnId 随行；完成通知把它经 originMeta.sourceTurnId 透传给 master 会话的
   * mailbox 行，作为跳回子会话汇报轮的精确滚动锚点。测试桩/旧实现缺席时锚点降级为滚到底。
   */
  turnId?: string;
}

export interface ParentTaskNotificationCommand {
  originMeta: BackgroundResultOriginMeta;
  text: string;
  traceContext: TraceContext;
  taskId: string;
}

/**
 * 项目权限全量同步（2026-11-18）：按 childSessionId 定位仍在运行的子 runtime 并切换
 * 协作模式。由 createDefaultSubagentPort 用 ownedRuntimes 实装——只有它拿得到活子
 * runtime 集合；配置类命令不能落在物化 shell runtime 上（那不是持有执行态的 runtime）。
 */
export interface SetChildSessionModeInput {
  childSessionId: SessionId;
  mode: string;
  traceContext?: TraceContext;
}

export type EnqueueParentTaskNotification = (
  notification: ParentTaskNotificationCommand,
) => undefined;

export interface ExploreSubagentPortOptions {
  /** runtime 工厂保留的子实例（含 turn 已结束但仍有辅助工作）由同一 owner 释放。 */
  closeOwnedRuntimes?: () => Promise<void>;
  runExploreAgent: (
    request: ExploreSubagentRuntimeRequest,
    options?: SubagentRunOptions,
  ) => Promise<ExploreSubagentRuntimeResult>;
  emitParentEvent: (event: SessionEvent, traceContext: TraceContext) => Promise<void>;
  // background completion 必须同步写入父 runtime command queue；
  // 返回 undefined 可让 TypeScript 拒绝 async enqueue，避免 fake-notified。
  enqueueParentTaskNotification?: EnqueueParentTaskNotification;
  /**
   * 项目权限全量同步（2026-11-18）：按 childSessionId 找活子 runtime 切协作模式。
   * 由 createDefaultSubagentPort 提供（ownedRuntimes 在它手里）；缺席时端口方法
   * 返回 unavailable，上层同步循环按失败跳过。
   */
  setChildSessionMode?: (input: SetChildSessionModeInput) => Promise<{
    ok: boolean;
    error?: string;
  }>;
  outputRootDir?: string;
  profiles?: readonly AgentProfile[];
  getAgentDefinitions?: GetAgentDefinitions;
  /**
   * 名册快照按 turn 冻结（turn 开始时 prepare 一次），同轮新建的 worker 不在当前快照里，
   * "建队即派工"会以 unknown agent type 失败——主智能体组建团队后立即派工是自然流程，
   * 不能要求它等到下一轮。解析 miss 时经本钩子重新加载一次定义（Host 的配置监听早已
   * 刷新共享快照，这次调用只是把新快照取回 runtime 内存）再重试解析。缺席保持旧行为。
   */
  reloadAgentDefinitions?: (input: {
    signal: AbortSignal;
    traceContext: TraceContext;
  }) => Promise<void>;
  builtInModelSelectionOverrides?: Partial<
    Record<"general-purpose" | "Explore", import("@robinrun/shared").ModelSelection>
  >;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  createAgentId?: () => string;
  getAllowedTools?: (profile: AgentProfile) => readonly string[];
  inactivityTimeoutMs?: number;
  autoBackgroundMs?: number;
  logger?: Logger;
  /**
   * P2.5 用户介入脱钩状态（延迟返回）的持久化钩子：写/删 child session 的
   * `runtime/worker-detach-state` entry。内存 registry 会随 CLI 重启丢失，这个 entry
   * 是跨重启的持久事实；runner 在武装/解除脱钩时调用。缺席只丢跨重启语义，不影响单进程。
   */
  persistWorkerDetachState?(
    childSessionId: SessionId | undefined,
    detached: boolean,
  ): Promise<void> | void;
  /**
   * agent 消息登记表（2026-11-19，docs/trigger-system.md）：master 侧进程内在途
   * needReply 请求。轮终态捕获（resolveReceiverReplies）与用户介入合成回复
   * （resolveReceiverSynthetic）都落在 master 的登记表上；缺席即无消息功能。
   */
  agentContactRegistry?: AgentContactRegistry;
}

export function createExploreSubagentPort(options: ExploreSubagentPortOptions): SubagentPort {
  const pending = new Set<Promise<unknown>>();
  const cleanupErrors: unknown[] = [];
  const shutdown = new AbortController();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const track = <T>(work: Promise<T>, critical = false): Promise<T> => {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      (error: unknown) => {
        pending.delete(work);
        if (critical) cleanupErrors.push(error);
      },
    );
    return work;
  };
  const runExploreAgent = options.runExploreAgent;
  options = {
    ...options,
    runExploreAgent: (request, runOptions) =>
      track(
        runExploreAgent(request, {
          ...runOptions,
          signal: runOptions?.signal
            ? AbortSignal.any([runOptions.signal, shutdown.signal])
            : shutdown.signal,
        }),
      ),
  };
  const registry = options.runtimeTaskRegistry ?? new InMemoryRuntimeTaskRegistry();
  const abortControllers = new Map<string, AbortController>();
  const borrowedForegroundAgentIds = new Set<string>();
  const initialProfiles = normalizeAgentProfiles(options.profiles ?? [], {
    builtInModelSelectionOverrides: options.builtInModelSelectionOverrides,
  });
  const getProfiles = () => options.getAgentDefinitions?.().activeAgents ?? initialProfiles;
  const autoBackgroundMs = normalizeAutoBackgroundMs(options.autoBackgroundMs);

  const port: SubagentPort & { start: NonNullable<SubagentPort["start"]> } = {
    async launch(
      rawRequest: SubagentLaunchRequest,
      launchOptions?: SubagentLaunchOptions,
    ): Promise<AgentOutput> {
      const { profile, request } = await resolveAgentProfileWithRosterRefresh(
        getProfiles,
        rawRequest,
        options,
        launchOptions?.signal,
      );
      const executionRequest = toSubagentExecutionRequest(request);
      // worker 会话通道（2026-11-16 裁决 + 等待模式扩展）：worker 派发默认异步——主智能体
      // 不阻塞等待，会话实时落侧栏 worker 名下；完成经 task-notification 唤醒，插话/打断走
      // SendMessage/TaskStop。显式 run_in_background: false 时改走前台阻塞等待，语义与
      // subagent 前台调用一致（worker_child 会话仍落侧栏，结果直接随工具结果返回）。
      const workerDispatch = !!profile.worker;
      const backgroundRequested = workerDispatch
        ? rawRequest.runInBackground !== false
        : rawRequest.runInBackground === true || profile.background === true;
      if (backgroundRequested) {
        if (launchOptions?.modelOverride?.background === "deny") {
          // 单次执行的模型与动态鉴权不能脱离父 loop 生命周期进入后台。
          throw createCoreError(
            CoreErrorType.ToolExecutionFailed,
            "Idle-time tasks do not support background agents. Run this agent in the foreground.",
            {
              context: {
                code: AgentErrorCode.BACKGROUND_UNAVAILABLE,
                agentType: rawRequest.agentType,
                parentToolCallId: rawRequest.parentToolCallId,
              },
              recoverable: true,
            },
          );
        }
        return port.start(executionRequest, {
          signal: launchOptions?.signal,
          ...(launchOptions?.model ? { model: launchOptions.model } : {}),
          ...(launchOptions?.modelOverride ? { modelOverride: launchOptions.modelOverride } : {}),
        });
      }
      return port.run(executionRequest, launchOptions);
    },

    async run(
      rawRequest: SubagentRunRequest,
      runOptions?: SubagentRunOptions,
    ): Promise<AgentOutput> {
      const { profile, request } = await resolveAgentProfileWithRosterRefresh(
        getProfiles,
        rawRequest,
        options,
        runOptions?.signal,
      );
      const lifecycle = createSubagentLifecycle(options, request, profile);
      const startedAt = new Date(lifecycle.startedAt);

      registry.register(
        createRuntimeTaskSnapshot({
          isBackgrounded: false,
          lifecycle,
          request,
          startedAt,
          status: "running",
        }),
      );
      try {
        await writeAgentMetadataFile(lifecycle, request, "running");
      } catch (error) {
        // 启动元数据写入失败时，child runtime 还没有开始执行；
        // 保留 running task 会让父 runtime 误以为仍有后台任务并持续 defer。
        registry.remove(lifecycle.agentId);
        throw error;
      }

      const taskAbort = createSubagentTaskAbortController(
        abortControllers,
        lifecycle.agentId,
        runOptions?.signal,
      );
      const hasForegroundModelOverride = runOptions?.modelOverride?.background === "deny";
      if (hasForegroundModelOverride) {
        borrowedForegroundAgentIds.add(lifecycle.agentId);
      }
      const activityWatchdog = createSubagentActivityWatchdog({
        abort: taskAbort.abort,
        lifecycle,
        logger: options.logger,
        request,
        signal: taskAbort.signal,
        timeoutMs: options.inactivityTimeoutMs ?? DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
      });
      const readyGate = createSubagentSessionReadyGate();
      // child persistence/resume 可能在 onSessionReady 前永久挂起；watchdog 和
      // abort guard 必须覆盖完整 setup，而不能把 Ready 当成取消能力的安装边界。
      activityWatchdog.start();
      const completionPromise = runAgentToCompletion(
        options,
        request,
        lifecycle,
        registry,
        {
          signal: taskAbort.signal,
          ...(runOptions?.model ? { model: runOptions.model } : {}),
          ...(runOptions?.modelOverride ? { modelOverride: runOptions.modelOverride } : {}),
        },
        {
          reportActivity: activityWatchdog.reportActivity,
        },
        {
          onSessionReady: async () => {
            await emitSubagentEvent(
              options,
              SessionEventType.SubagentSpawned,
              request,
              lifecycle.runTraceContext,
              {
                agentId: lifecycle.agentId,
                agentType: request.agentType,
                childSessionId: lifecycle.childSessionId,
                description: request.description,
                prompt: request.prompt,
                parentToolCallId: request.parentToolCallId,
                status: "running",
                allowedTools: [...resolveAllowedTools(profile, options)],
                model: profile.modelSelection
                  ? `${profile.modelSelection.providerId}/${profile.modelSelection.modelId}`
                  : undefined,
                // worker 会话通道：worker_child 派发携带名册身份，bootstrap 据此注册进
                // worker 注册表并投影 SessionSummary.worker（gateway→syncer→侧栏 worker 组）。
                ...(profile.worker ? { worker: profile.worker } : {}),
              },
            );
            readyGate.resolve();
          },
        },
      );
      void completionPromise.catch((error: unknown) => readyGate.reject(error));
      try {
        await guardSubagentPromiseWithAbort(
          readyGate.promise,
          request,
          lifecycle,
          taskAbort.signal,
        );
      } catch (error) {
        activityWatchdog.stop();
        taskAbort.abort(error);
        taskAbort.dispose();
        borrowedForegroundAgentIds.delete(lifecycle.agentId);
        registry.remove(lifecycle.agentId);
        throw error;
      }

      options.logger?.info("Explore subagent spawned", {
        ...traceContextToLogContext(lifecycle.runTraceContext),
        agentId: lifecycle.agentId,
        agentType: request.agentType,
        event: "subagent.spawned",
        module: "core.subagent",
        parentToolCallId: request.parentToolCallId,
        status: "started",
      });
      const guardedCompletionPromise = guardSubagentPromiseWithAbort(
        completionPromise,
        request,
        lifecycle,
        taskAbort.signal,
      );

      let autoBackgroundTimer: AutoBackgroundTimer | undefined;
      try {
        autoBackgroundTimer =
          !hasForegroundModelOverride && autoBackgroundMs !== undefined
            ? createAutoBackgroundTimer(
                registry,
                lifecycle.agentId,
                autoBackgroundMs,
                taskAbort.signal,
              )
            : undefined;
        const backgroundRequestPromise = !hasForegroundModelOverride
          ? registry
              .waitForBackgroundRequest(lifecycle.agentId, { signal: taskAbort.signal })
              .then((task) => ({
                kind: task ? ("backgrounded" as const) : ("ignored" as const),
              }))
          : undefined;
        const winner = await Promise.race([
          guardedCompletionPromise.then((completed) => ({
            completed,
            kind: "completed" as const,
          })),
          ...(backgroundRequestPromise ? [backgroundRequestPromise] : []),
          ...(autoBackgroundTimer ? [autoBackgroundTimer.promise] : []),
        ]);

        if (winner.kind === "backgrounded") {
          taskAbort.detachParent();
          activityWatchdog.stop();
          void track(
            completionPromise
              .then((completed) =>
                finalizeBackgroundCompletion(options, request, lifecycle, registry, completed),
              )
              .catch((error) =>
                finalizeBackgroundFailure(options, request, lifecycle, registry, error),
              )
              .finally(taskAbort.dispose),
            true,
          );
          return createAgentBackgroundedOutput(request, lifecycle);
        }

        const completed =
          winner.kind === "completed" ? winner.completed : await guardedCompletionPromise;
        autoBackgroundTimer?.cancel();
        activityWatchdog.stop();
        taskAbort.dispose();
        borrowedForegroundAgentIds.delete(lifecycle.agentId);

        await writeCompletedAgentArtifacts(lifecycle, request, completed.output);
        registry.update(lifecycle.agentId, (task) => ({
          ...withoutRuntimeMessageState(task),
          status: "completed",
          completedAt: new Date(),
          output: completed.output,
          usage: {
            durationMs: completed.output.totalDurationMs,
            modelUsage: completed.output.usage,
            toolUseCount: completed.output.totalToolUseCount,
            totalTokens: completed.output.totalTokens,
          },
        }));

        await emitSubagentEvent(
          options,
          SessionEventType.SubagentStopped,
          request,
          lifecycle.runTraceContext,
          {
            agentId: lifecycle.agentId,
            agentType: request.agentType,
            childSessionId: lifecycle.childSessionId,
            parentToolCallId: request.parentToolCallId,
            status: "completed",
            totalDurationMs: completed.output.totalDurationMs,
            totalToolUseCount: completed.output.totalToolUseCount,
            totalTokens: completed.output.totalTokens,
          },
        );

        options.logger?.info("Explore subagent completed", {
          ...traceContextToLogContext(lifecycle.runTraceContext),
          agentId: lifecycle.agentId,
          durationMs: completed.output.totalDurationMs,
          event: "subagent.completed",
          module: "core.subagent",
          status: "completed",
          totalToolUseCount: completed.output.totalToolUseCount,
          totalTokens: completed.output.totalTokens,
        });

        return completed.output;
      } catch (error) {
        activityWatchdog.stop();
        taskAbort.dispose();
        borrowedForegroundAgentIds.delete(lifecycle.agentId);
        const totalDurationMs = Date.now() - lifecycle.startedAt;
        const errorMessage = error instanceof Error ? error.message : String(error);
        await writeFailedAgentArtifacts(lifecycle, request, errorMessage);
        registry.update(lifecycle.agentId, (task) => ({
          ...withoutRuntimeMessageState(task),
          status: "failed",
          completedAt: new Date(),
          error: errorMessage,
          usage: {
            durationMs: totalDurationMs,
          },
        }));
        await emitSubagentEvent(
          options,
          SessionEventType.SubagentStopped,
          request,
          lifecycle.runTraceContext,
          {
            agentId: lifecycle.agentId,
            agentType: request.agentType,
            childSessionId: lifecycle.childSessionId,
            parentToolCallId: request.parentToolCallId,
            status: "failed",
            totalDurationMs,
            error: errorMessage,
          },
        );

        if (isCoreError(error)) {
          throw error;
        }

        throw createCoreError(CoreErrorType.ToolExecutionFailed, "Explore subagent failed", {
          cause: error instanceof Error ? error : undefined,
          // 这层只描述父 Agent toolcall 的生命周期失败；真实 provider/model
          // 错误在 cause 链里，应作为 UI hover 与父模型 tool result 的主摘要。
          context: withErrorPayloadRole(
            {
              code: AgentErrorCode.CHILD_RUNTIME_FAILED,
              agentId: lifecycle.agentId,
              agentType: request.agentType,
              parentToolCallId: request.parentToolCallId,
            },
            ErrorPayloadRole.Wrapper,
          ),
          recoverable: true,
        });
      } finally {
        activityWatchdog.stop();
        autoBackgroundTimer?.cancel();
      }
    },

    async start(
      rawRequest: SubagentStartRequest,
      startOptions?: SubagentStartOptions,
    ): Promise<AgentBackgroundedOutput> {
      const { profile, request } = await resolveAgentProfileWithRosterRefresh(
        getProfiles,
        rawRequest,
        options,
        startOptions?.signal,
      );
      const lifecycle = createSubagentLifecycle(options, request, profile);
      const startedAt = new Date(lifecycle.startedAt);
      const output = createAgentBackgroundedOutput(request, lifecycle);

      registry.register(
        createRuntimeTaskSnapshot({
          isBackgrounded: true,
          lifecycle,
          request,
          startedAt,
          status: "running",
        }),
      );
      try {
        await writeAgentMetadataFile(lifecycle, request, "running");
      } catch (error) {
        // setup 失败时移除 registry 记录，避免 fake running background task。
        registry.remove(lifecycle.agentId);
        throw error;
      }

      const taskAbort = createSubagentTaskAbortController(abortControllers, lifecycle.agentId);
      if (startOptions?.signal?.aborted) {
        taskAbort.abort(startOptions.signal.reason);
      }
      const readyGate = createSubagentSessionReadyGate();
      void track(
        runBackgroundAgent(
          options,
          request,
          lifecycle,
          registry,
          {
            signal: taskAbort.signal,
            ...(startOptions?.model ? { model: startOptions.model } : {}),
            ...(startOptions?.modelOverride ? { modelOverride: startOptions.modelOverride } : {}),
          },
          {
            onSessionReady: async () => {
              await emitSubagentEvent(
                options,
                SessionEventType.SubagentSpawned,
                request,
                lifecycle.runTraceContext,
                {
                  agentId: lifecycle.agentId,
                  agentType: request.agentType,
                  background: true,
                  childSessionId: lifecycle.childSessionId,
                  description: request.description,
                  prompt: request.prompt,
                  parentToolCallId: request.parentToolCallId,
                  status: "running",
                  allowedTools: [...resolveAllowedTools(profile, options)],
                  outputFile: lifecycle.outputFile,
                  model: profile.modelSelection
                    ? `${profile.modelSelection.providerId}/${profile.modelSelection.modelId}`
                    : undefined,
                  // worker 会话通道：worker_child 派发携带名册身份（同 run 路径）。
                  ...(profile.worker ? { worker: profile.worker } : {}),
                },
              );
              readyGate.resolve();
            },
            onSessionStartFailed: readyGate.reject,
          },
          taskAbort.dispose,
        ),
        true,
      );
      try {
        await readyGate.promise;
      } catch (error) {
        taskAbort.abort(error);
        registry.remove(lifecycle.agentId);
        throw error;
      }

      options.logger?.info("Explore subagent background task started", {
        ...traceContextToLogContext(lifecycle.runTraceContext),
        agentId: lifecycle.agentId,
        agentType: request.agentType,
        event: "subagent.background.started",
        module: "core.subagent",
        parentToolCallId: request.parentToolCallId,
        status: "started",
      });
      return output;
    },

    async getTask(taskId: string): Promise<SubagentTaskSnapshot | undefined> {
      return registry.get(taskId);
    },

    async backgroundTask(taskId: string): Promise<SubagentTaskSnapshot | undefined> {
      if (borrowedForegroundAgentIds.has(taskId)) {
        return registry.get(taskId);
      }
      registry.requestBackground(taskId);
      return registry.get(taskId);
    },

    async waitForTask(
      taskId: string,
      waitOptions?: SubagentWaitOptions,
    ): Promise<SubagentTaskSnapshot | undefined> {
      return registry.waitForTerminal(taskId, { signal: waitOptions?.signal });
    },

    async stopTask(
      taskId: string,
      stopOptions?: SubagentStopOptions,
    ): Promise<SubagentTaskSnapshot | undefined> {
      if (stopOptions?.signal?.aborted) {
        throw stopOptions.signal.reason ?? new Error("Subagent stop aborted");
      }
      const task = registry.get(taskId);
      if (!task || task.type !== "local_agent") return task;
      if (isTerminalRuntimeTask(task)) return task;

      // P2.5 用户介入脱钩：用户在 worker 会话里打断 → 置 detached + 持久化，
      // 终态通知改为暂缓（finalizeBackgroundStopped 判定），直到 worker 调返回工具。
      // 一次性 subagent 与模型发起的 TaskStop 不脱钩，通知照旧。
      if (stopOptions?.initiator === "user" && task.workerChild === true) {
        registry.update(taskId, (current) => ({ ...current, detached: true }));
        await options.persistWorkerDetachState?.(task.childSessionId, true);
        // 介入瞬间话语权切换（2026-11-19 话语权裁决）：其在途 ContactAgent 请求立即
        // 以合成回复解除；本轮（被停轮）输出不再捕获为回复。
        resolveAgentContactSynthetic(options, task, "takeover");
      }

      const stopped = createBackgroundStoppedTask(registry, task, stopOptions?.initiator);
      if (!stopped) return undefined;
      return finalizeBackgroundStopped(options, registry, stopped, () => {
        abortControllers
          .get(taskId)
          ?.abort(new Error(`${BACKGROUND_AGENT_STOPPED_STATE.message}: ${taskId}`));
        abortControllers.delete(taskId);
      });
    },

    async sendMessage(
      request: SubagentSendMessageRequest,
      sendOptions?: SubagentSendMessageOptions,
    ): Promise<SubagentSendMessageResult> {
      return sendMessageToLocalAgent(
        options,
        getProfiles,
        registry,
        abortControllers,
        request,
        sendOptions,
        track,
      );
    },

    // ---- P2.5 用户协同 worker 会话（路由层入口） ----

    async getTaskByChildSessionId(
      childSessionId: SessionId,
    ): Promise<SubagentTaskSnapshot | undefined> {
      return findTaskByChildSessionId(registry, childSessionId);
    },

    async stopTaskForChildSession(
      childSessionId: SessionId,
      stopOptions?: SubagentStopOptions,
    ): Promise<SubagentTaskSnapshot | undefined> {
      const task = findTaskByChildSessionId(registry, childSessionId);
      if (!task) return undefined;
      return port.stopTask!(task.taskId, stopOptions);
    },

    async setChildSessionMode(
      input: SetChildSessionModeInput,
    ): Promise<{ ok: boolean; error?: string }> {
      if (!options.setChildSessionMode) {
        return { ok: false, error: "child_mode_unavailable" };
      }
      return options.setChildSessionMode(input);
    },

    // requestReturnToDispatcher 已移除（2026-11-19）：ReturnToDispatcher 工具退役，
    // 脱钩退出路径并入 ContactAgent（subagent/agent-contact.ts 的 worker 端口 submit
    // 交还话语权分支；detached/returnRequested 状态机与 finalize 投递保持不变）。
  };

  // 后台只脱离父 turn；owner 始终持有真实执行和收尾链，不能把 abort guard 返回当作关闭完成。
  const admit =
    <A extends unknown[], R>(operation: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      if (closed) return Promise.reject(new Error("Subagent owner is closed"));
      return track(operation(...args));
    };
  return {
    ...port,
    launch: admit(port.launch),
    run: admit(port.run),
    start: admit(port.start),
    sendMessage: admit(port.sendMessage!),
    close: () => {
      closed = true;
      closePromise ??= (async () => {
        // 沿单任务停止链先提交终态再取消，避免 abort guard 与停止入口竞争发布终态。
        // 全部 stop 并行发起；某个终态写入失败也必须继续广播 owner 取消。
        const stopped = await Promise.allSettled(
          Object.values(registry.all())
            .filter((task) => task.type === "local_agent" && !isTerminalRuntimeTask(task))
            .map((task) => port.stopTask!(task.taskId)),
        );
        shutdown.abort(new Error("Session runtime closed"));
        for (const controller of abortControllers.values())
          controller.abort(shutdown.signal.reason);
        while (pending.size > 0) await Promise.allSettled(pending);
        // 释放失败属于本次尝试；不能把它写入永久事件错误账，否则重试成功也无法关闭。
        const errors = [...cleanupErrors];
        try {
          await options.closeOwnedRuntimes?.();
        } catch (error) {
          errors.push(error);
        }
        for (const result of stopped) if (result.status === "rejected") errors.push(result.reason);
        if (errors.length > 0) throw new AggregateError(errors, "Subagent cleanup failed");
      })().catch((error) => {
        closePromise = undefined;
        throw error;
      });
      return closePromise;
    },
  };
}

interface SubagentLifecycle {
  agentId: string;
  childSessionId: SessionId;
  metadataFile: string;
  outputFile: string;
  taskOutputFile: string;
  profile: AgentProfile;
  startedAt: number;
  runTraceContext: TraceContext;
  childTraceContext: TraceContext;
}

type AgentProfileResolution =
  | { kind: "matched"; profile: AgentProfile }
  | { availableAgentTypes: readonly string[]; kind: "not_found" }
  | {
      availableAgentTypes: readonly string[];
      kind: "ambiguous";
      matches: readonly string[];
    };

interface AutoBackgroundTimer {
  cancel(): void;
  promise: Promise<{ kind: "backgrounded" | "ignored" }>;
}

interface SubagentTaskAbortHandle {
  abort(reason?: unknown): void;
  detachParent(): void;
  dispose(): void;
  signal: AbortSignal;
}

function createSubagentTaskAbortController(
  abortControllers: Map<string, AbortController>,
  agentId: string,
  parentSignal?: AbortSignal,
): SubagentTaskAbortHandle {
  const controller = new AbortController();
  abortControllers.set(agentId, controller);
  const onParentAbort = (): void => {
    controller.abort(parentSignal?.reason ?? new Error(`Subagent task aborted: ${agentId}`));
  };
  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  const detachParent = (): void => {
    parentSignal?.removeEventListener("abort", onParentAbort);
  };
  const dispose = (): void => {
    detachParent();
    if (abortControllers.get(agentId) === controller) {
      abortControllers.delete(agentId);
    }
  };

  return {
    abort: (reason?: unknown) => controller.abort(reason),
    detachParent,
    dispose,
    signal: controller.signal,
  };
}

function normalizeAutoBackgroundMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.trunc(value);
}

function createAutoBackgroundTimer(
  registry: RuntimeTaskRegistry,
  agentId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): AutoBackgroundTimer {
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolvePromise!: (value: { kind: "backgrounded" | "ignored" }) => void;

  const complete = (value: { kind: "backgrounded" | "ignored" }): void => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    resolvePromise(value);
  };
  const onAbort = (): void => {
    complete({ kind: "ignored" });
  };
  const promise = new Promise<{ kind: "backgrounded" | "ignored" }>((resolve) => {
    resolvePromise = resolve;
    if (signal?.aborted) {
      complete({ kind: "ignored" });
      return;
    }

    timer = setTimeout(() => {
      complete({
        kind: registry.requestBackground(agentId) ? "backgrounded" : "ignored",
      });
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

  return {
    cancel: () => complete({ kind: "ignored" }),
    promise,
  };
}

/**
 * 解析派发 profile；miss（unknown/ambiguous agent type）时刷新一次名册快照再重试。
 *
 * 根因（2026-11-18 验收）：名册快照在 turn 开始时 prepare 一次后冻结，ManageWorkers
 * 同轮新建的 worker 不在其中——主智能体"创建团队 → 立即派工"必然失败并退化成一次性
 * subagent。Host 端 workers.json 监听在写入后约 1.5s 就刷新了共享快照，这里 miss 时
 * 经 reloadAgentDefinitions 把新快照取回再解析一次即可打通同轮派发。
 * 只对 unknown-type miss 重载（expectedKind 角色错位是策略错误，重载不会改变判定）；
 * 每次调用至多重载一次，重载本身失败时抛出原始 miss 错误（对模型更有诊断价值）。
 */
async function resolveAgentProfileWithRosterRefresh(
  getProfiles: () => readonly AgentProfile[],
  request: SubagentRunRequest,
  options: Pick<ExploreSubagentPortOptions, "reloadAgentDefinitions">,
  signal: AbortSignal | undefined,
): Promise<{ profile: AgentProfile; request: SubagentRunRequest }> {
  try {
    return resolveAgentProfileForRequest(getProfiles(), request);
  } catch (error) {
    const reload = options.reloadAgentDefinitions;
    const isUnknownTypeMiss =
      isCoreError(error) && error.context?.code === AgentErrorCode.UNKNOWN_AGENT_TYPE;
    if (!reload || !isUnknownTypeMiss || signal?.aborted) throw error;
    try {
      await reload({
        signal: signal ?? new AbortController().signal,
        traceContext: request.trace,
      });
    } catch {
      throw error;
    }
    return resolveAgentProfileForRequest(getProfiles(), request);
  }
}

function resolveAgentProfileForRequest(
  profiles: readonly AgentProfile[],
  request: SubagentRunRequest,
): { profile: AgentProfile; request: SubagentRunRequest } {
  const resolution = resolveAgentProfileByType(profiles, request.agentType);
  if (resolution.kind === "matched") {
    const { profile } = resolution;
    // P2.6 工具分离（裁决 13）：名册 worker 与一次性 subagent 解析互斥。DispatchWorker 已退役（2026-11-20 同构化），本校验仅剩 legacy worker_child 会话的 resume 链路使用。
    // 即使两者底层能力同构，语义角色也必须在入口校验，避免编排与认知混乱。
    if (request.expectedKind === "worker" && !profile.worker) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        `'${request.agentType}' is not a roster worker. The legacy worker dispatch channel only accepts workers listed in the roster (wkr-* ids); use the Agent tool for one-off subagent types.`,
        {
          context: {
            code: "dispatch_worker_not_a_worker",
            agentType: request.agentType,
            parentToolCallId: request.parentToolCallId,
          },
          recoverable: true,
        },
      );
    }
    if (request.expectedKind === "subagent" && profile.worker) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        `'${request.agentType}' is a roster worker (wkr-*). One-off subagent dispatch (Agent tool) must not target workers — hand tasks to the worker via the ContactAgent tool with its immutable id.`,
        {
          context: {
            code: AgentErrorCode.WORKER_DISPATCH_FORBIDDEN,
            agentType: request.agentType,
            parentToolCallId: request.parentToolCallId,
          },
          recoverable: true,
        },
      );
    }
    return {
      profile,
      request:
        profile.name === request.agentType
          ? request
          : {
              ...request,
              // 模型可能按大小写/分隔符近似写 subagent_type；后续
              // toolset、事件和 metadata 都依赖 canonical agentType，必须在入口统一收敛。
              agentType: profile.name,
            },
    };
  }

  if (resolution.kind === "ambiguous") {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      [
        `Agent type '${request.agentType}' is ambiguous`,
        `matches ${resolution.matches.join(", ")}`,
        `Use the exact name: ${resolution.matches.join(" or ")}`,
      ].join(" — "),
      {
        context: {
          code: AgentErrorCode.UNKNOWN_AGENT_TYPE,
          agentType: request.agentType,
          matches: resolution.matches,
          parentToolCallId: request.parentToolCallId,
        },
        recoverable: true,
      },
    );
  }

  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    `Agent type '${request.agentType}' not found. Available agents: ${resolution.availableAgentTypes.join(", ")}`,
    {
      context: {
        code: AgentErrorCode.UNKNOWN_AGENT_TYPE,
        agentType: request.agentType,
        availableAgentTypes: resolution.availableAgentTypes,
        parentToolCallId: request.parentToolCallId,
      },
      recoverable: true,
    },
  );
}

function resolveAgentProfileByType(
  profiles: readonly AgentProfile[],
  requestedAgentType: string,
): AgentProfileResolution {
  const exact = profiles.find((candidate) => candidate.name === requestedAgentType);
  if (exact) return { kind: "matched", profile: exact };

  // key/name 裁决（2026-11-17）：worker 的派发句柄是 id（profile.name 位即 id），名字匹配
  // 只作兜底——升级前派发的会话（身份 entry / 消息 agent 字段）记录的是旧显示名，且
  // 显示名允许重名，重名时按歧义处理让模型改用 id。
  const workerIdMatches = profiles.filter(
    (candidate) =>
      candidate.worker?.workerId === requestedAgentType ||
      candidate.worker?.workerName === requestedAgentType,
  );
  if (workerIdMatches.length === 1) {
    return { kind: "matched", profile: workerIdMatches[0]! };
  }

  const availableAgentTypes = profiles.map((profile) => profile.name);

  const requestedNormalized = normalizeAgentTypeForMatch(requestedAgentType);
  if (!requestedNormalized) {
    if (workerIdMatches.length > 1) {
      return {
        availableAgentTypes,
        kind: "ambiguous",
        matches: workerIdMatches.map((profile) => profile.name),
      };
    }
    return { availableAgentTypes, kind: "not_found" };
  }

  const normalizedMatches = profiles.filter(
    (candidate) =>
      normalizeAgentTypeForMatch(candidate.name) === requestedNormalized ||
      normalizeAgentTypeForMatch(candidate.worker?.workerName ?? "") === requestedNormalized,
  );
  if (normalizedMatches.length === 1) {
    return { kind: "matched", profile: normalizedMatches[0]! };
  }
  if (normalizedMatches.length > 1) {
    return {
      availableAgentTypes,
      kind: "ambiguous",
      matches: normalizedMatches.map((profile) => profile.name),
    };
  }

  return { availableAgentTypes, kind: "not_found" };
}

function normalizeAgentTypeForMatch(agentType: string): string | undefined {
  const normalized = agentType
    .trim()
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{White_Space}\p{Pd}_]+/gu, "");
  return normalized.length > 0 ? normalized : undefined;
}

function toSubagentExecutionRequest(request: SubagentLaunchRequest): SubagentRunRequest {
  const { runInBackground: _runInBackground, ...executionRequest } = request;
  return executionRequest;
}

function createSubagentLifecycle(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  profile: AgentProfile,
): SubagentLifecycle {
  const agentId = options.createAgentId?.() ?? `agent_${crypto.randomUUID()}`;
  const childSessionId = createSessionId(`subagent_${agentId}`);
  const startedAt = Date.now();
  const agentOutputDir = join(
    options.outputRootDir ?? join(tmpdir(), "robinrun-agents"),
    request.sessionId,
    agentId,
  );
  const metadataFile = join(agentOutputDir, "metadata.json");
  const outputFile = join(agentOutputDir, "output.txt");
  const taskOutputFile = join(agentOutputDir, "task.output");
  const runTraceContext = createChildTraceContext(request.trace, {
    sessionId: request.sessionId,
    turnId: request.turnId,
    attributes: {
      agentId,
      agentType: request.agentType,
      parentToolCallId: request.parentToolCallId,
    },
  });
  const childTraceContext = createChildTraceContext(runTraceContext, {
    sessionId: childSessionId,
    rootSessionId: runTraceContext.rootSessionId ?? request.sessionId,
    turnId: request.turnId,
    attributes: {
      agentId,
      agentType: request.agentType,
      parentSessionId: request.sessionId,
      parentToolCallId: request.parentToolCallId,
    },
  });

  return {
    agentId,
    childSessionId,
    metadataFile,
    outputFile,
    taskOutputFile,
    profile,
    startedAt,
    runTraceContext,
    childTraceContext,
  };
}

function createSubagentLifecycleFromTask(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  profile: AgentProfile,
  task: RuntimeTaskSnapshot,
): SubagentLifecycle | undefined {
  if (!task.childSessionId) return undefined;
  const agentId = task.agentId;
  const childSessionId = task.childSessionId;
  const startedAt = Date.now();
  const agentOutputDir = task.outputFile
    ? dirname(task.outputFile)
    : join(options.outputRootDir ?? join(tmpdir(), "robinrun-agents"), request.sessionId, agentId);
  const metadataFile = join(agentOutputDir, "metadata.json");
  const outputFile = join(agentOutputDir, "output.txt");
  const taskOutputFile = join(agentOutputDir, "task.output");
  const runTraceContext = createChildTraceContext(request.trace, {
    sessionId: request.sessionId,
    turnId: request.turnId,
    attributes: {
      agentId,
      agentType: request.agentType,
      parentToolCallId: request.parentToolCallId,
      resumed: true,
    },
  });
  const childTraceContext = createChildTraceContext(runTraceContext, {
    sessionId: childSessionId,
    rootSessionId: runTraceContext.rootSessionId ?? request.sessionId,
    turnId: request.turnId,
    attributes: {
      agentId,
      agentType: request.agentType,
      parentSessionId: request.sessionId,
      parentToolCallId: request.parentToolCallId,
      resumed: true,
    },
  });

  return {
    agentId,
    childSessionId,
    metadataFile,
    outputFile,
    taskOutputFile,
    profile,
    startedAt,
    runTraceContext,
    childTraceContext,
  };
}

async function sendMessageToLocalAgent(
  options: ExploreSubagentPortOptions,
  getProfiles: () => readonly AgentProfile[],
  registry: RuntimeTaskRegistry,
  abortControllers: Map<string, AbortController>,
  request: SubagentSendMessageRequest,
  sendOptions: SubagentSendMessageOptions | undefined,
  track: <T>(work: Promise<T>, critical?: boolean) => Promise<T>,
): Promise<SubagentSendMessageResult> {
  if (sendOptions?.signal?.aborted) {
    return createSendMessageFailure(request, `SendMessage was aborted for ${request.to}.`);
  }

  let task = registry.get(request.to);
  if ((!task || task.type !== "local_agent") && request.identity) {
    // P2.5 注册表未命中兜底：CLI 重启后 registry 为空，路由层凭持久化 worker 身份
    // 合成终态快照走既有 resume 链（profile 按 agentType 从 roster 重解析）。
    task = createSyntheticWorkerTaskSnapshot(options, request);
  }
  if (!task || task.type !== "local_agent") {
    return createSendMessageFailure(
      request,
      `No active local_agent task found for target ${request.to}.`,
    );
  }

  // P2.5 用户介入脱钩：用户在 worker 会话里直接输入（无论打断后的恢复轮还是运行中
  // 插话）→ 先武装 detached + 持久化。该 worker 的终态通知从此暂缓，直到它调返回工具；
  // 一次性 subagent 与主智能体 SendMessage 不受影响。
  let currentTask = task;
  if (request.initiator === "user" && task.workerChild === true) {
    currentTask =
      registry.update(task.taskId, (current) => ({ ...current, detached: true })) ?? task;
    await options.persistWorkerDetachState?.(task.childSessionId, true);
    // 介入瞬间话语权切换（2026-11-19 话语权裁决）：其在途 ContactAgent 请求立即以
    // 合成回复解除；本轮输出不再捕获为回复（收尾是说给用户听的）。
    resolveAgentContactSynthetic(options, currentTask, "takeover");
  }

  const message = createRuntimeTaskPendingMessage(request);
  if (!isTerminalRuntimeTask(currentTask)) {
    return deliverMessageToRunningAgent(registry, currentTask, message);
  }

  return resumeTerminalAgentInBackground(
    options,
    getProfiles(),
    registry,
    abortControllers,
    currentTask,
    request,
    message,
    sendOptions,
    track,
  );
}

async function deliverMessageToRunningAgent(
  registry: RuntimeTaskRegistry,
  task: RuntimeTaskSnapshot,
  message: RuntimeTaskPendingMessage,
): Promise<SubagentSendMessageResult> {
  if (task.messageSink) {
    try {
      const delivery = await task.messageSink.send(message);
      return createSendMessageSuccess(task, message, delivery);
    } catch {
      registry.queueMessage(task.taskId, message);
      return createSendMessageSuccess(task, message, "queued");
    }
  }

  registry.queueMessage(task.taskId, message);
  return createSendMessageSuccess(task, message, "queued");
}

async function resumeTerminalAgentInBackground(
  options: ExploreSubagentPortOptions,
  profiles: readonly AgentProfile[],
  registry: RuntimeTaskRegistry,
  abortControllers: Map<string, AbortController>,
  task: RuntimeTaskSnapshot,
  request: SubagentSendMessageRequest,
  message: RuntimeTaskPendingMessage,
  sendOptions: SubagentSendMessageOptions | undefined,
  track: <T>(work: Promise<T>, critical?: boolean) => Promise<T>,
): Promise<SubagentSendMessageResult> {
  // 恢复解析（key/name 裁决 2026-11-17）：新派发的 task.agentType 是 id（= profile.name）；
  // 升级前的任务记录的是旧显示名，按 worker 身份标记兜底（重名歧义取首个，恢复场景可接受）。
  const profile =
    profiles.find((candidate) => candidate.name === task.agentType) ??
    profiles.find(
      (candidate) =>
        candidate.worker?.workerId === task.agentType ||
        candidate.worker?.workerName === task.agentType,
    );
  if (!profile) {
    return createSendMessageFailure(
      request,
      `Cannot resume local agent ${task.agentId}: profile ${task.agentType} is unavailable.`,
    );
  }

  const resumeRequest: SubagentRunRequest = {
    sessionId: request.sessionId,
    turnId: request.turnId,
    parentToolCallId: request.parentToolCallId,
    agentType: task.agentType,
    // summary 只用于预览，不改任务描述。
    // 修复原因：恢复时用 summary 作描述，完成通知和卡片标题都会变成这次消息的摘要。
    description: task.description,
    prompt: request.message,
    workingDirectory: request.workingDirectory,
    workspaceRoot: request.workspaceRoot,
    trace: request.trace,
    // P2.5：用户在 worker 会话里直接输入的恢复轮按真实用户记账；插话链路不变。
    ...(request.initiator === "user" ? { initiator: "user" as const } : {}),
    // ContactAgent 管线轮（2026-11-19）：恢复轮继承管线标记，终态通知被回复捕获取代。
    ...(request.contact ? { contactRequestId: request.contact.requestId } : {}),
  };
  const lifecycle = createSubagentLifecycleFromTask(options, resumeRequest, profile, task);
  if (!lifecycle) {
    return createSendMessageFailure(
      request,
      `Cannot resume local agent ${task.agentId}: missing child session id.`,
    );
  }
  const startedAt = new Date(lifecycle.startedAt);
  const previousTask = task;
  registry.register(
    createRuntimeTaskSnapshot({
      isBackgrounded: true,
      lifecycle,
      request: resumeRequest,
      startedAt,
      status: "running",
      // 恢复重臂不得清空用户介入状态：脱钩期跨恢复轮保持，直到返回工具触发。
      carryDetachStateFrom: task,
    }),
  );
  try {
    await writeAgentMetadataFile(lifecycle, resumeRequest, "running", {
      resumedAt: new Date().toISOString(),
      resumedFromMessageId: message.id,
    });
  } catch (error) {
    // SendMessage resume setup 失败不能覆盖原 terminal task；
    // 还原旧 snapshot，避免一个未启动的新 turn 卡成 running。
    registry.register(previousTask);
    throw error;
  }

  const taskAbort = createSubagentTaskAbortController(abortControllers, lifecycle.agentId);
  const readyGate = createSubagentSessionReadyGate();
  void track(
    runBackgroundAgent(
      options,
      resumeRequest,
      lifecycle,
      registry,
      {
        signal: taskAbort.signal,
        model: sendOptions?.model,
        modelOverride: sendOptions?.modelOverride,
      },
      {
        resumeFromStore: true,
        onSessionReady: async () => {
          await emitSubagentEvent(
            options,
            SessionEventType.SubagentSpawned,
            resumeRequest,
            lifecycle.runTraceContext,
            {
              agentId: lifecycle.agentId,
              agentType: resumeRequest.agentType,
              background: true,
              childSessionId: lifecycle.childSessionId,
              description: resumeRequest.description,
              outputFile: lifecycle.outputFile,
              parentToolCallId: resumeRequest.parentToolCallId,
              prompt: resumeRequest.prompt,
              resumed: true,
              status: "running",
              // worker 会话通道：resume 按 agentType 重解析 profile，worker 身份随之恢复。
              ...(profile.worker ? { worker: profile.worker } : {}),
            },
          );
          readyGate.resolve();
        },
        onSessionStartFailed: readyGate.reject,
      },
      taskAbort.dispose,
    ),
    true,
  );
  try {
    await readyGate.promise;
  } catch (error) {
    taskAbort.abort(error);
    registry.register(previousTask);
    throw error;
  }
  // terminal 状态属于旧 snapshot，但 resume 输出路径属于新 lifecycle；
  // 旧 snapshot 的可选 outputFile 不能用于本次 provider-visible 结果。
  return createSendMessageSuccess(
    { ...task, outputFile: lifecycle.outputFile },
    message,
    "resumed_background",
  );
}

function createRuntimeTaskPendingMessage(
  request: SubagentSendMessageRequest,
): RuntimeTaskPendingMessage {
  return {
    id: `msg_${crypto.randomUUID()}`,
    isMeta: true,
    message: request.message,
    origin: {
      kind: "coordinator",
      toolCallId: String(request.parentToolCallId),
    },
    // P2.6：发起者随消息走（修复 sink 固定 initiator——用户插话不得误标 coordinator）。
    ...(request.initiator ? { initiator: request.initiator } : {}),
    queuedAt: new Date(),
    summary: request.summary,
    traceContext: request.trace,
  };
}

function createSendMessageSuccess(
  task: Pick<RuntimeTaskSnapshot, "agentId" | "outputFile" | "status" | "taskId">,
  message: RuntimeTaskPendingMessage,
  delivery: NonNullable<SubagentSendMessageResult["delivery"]>,
): SubagentSendMessageResult {
  const providerMessage =
    delivery === "queued"
      ? `Message queued for delivery to ${task.agentId} at its next tool round.`
      : delivery === "resumed_background"
        ? `Agent "${task.agentId}" was stopped (${task.status}); resumed it in the background with your message. You'll be notified when it finishes. Output: ${task.outputFile}`
        : `Message ${message.id} was sent to its active turn for local agent ${task.agentId}.`;
  return {
    status: "success",
    messageId: message.id,
    delivery,
    agentId: task.agentId,
    taskId: task.taskId,
    outputFile: task.outputFile,
    message: providerMessage,
  };
}

function createSendMessageFailure(
  request: SubagentSendMessageRequest,
  error: string,
): SubagentSendMessageResult {
  return {
    status: "failed",
    messageId: `msg_${crypto.randomUUID()}`,
    agentId: request.to,
    error,
    message: error,
  };
}

async function runAgentToCompletion(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
  runOptions?: SubagentRunOptions,
  monitorOptions: { reportActivity?: () => void } = {},
  executionOptions: SubagentExecutionOptions = {},
): Promise<{ events: SessionEvent[]; output: AgentCompletedOutput }> {
  let sessionReady = false;
  const notifySessionReady = async () => {
    if (sessionReady) return;
    await executionOptions.onSessionReady?.();
    sessionReady = true;
  };
  const childResult = await options.runExploreAgent(
    {
      agentId: lifecycle.agentId,
      agentType: request.agentType,
      allowedTools: resolveAllowedTools(lifecycle.profile, options),
      // 显式 background Agent 的 child tool 会被镜像到父会话；
      // 过去丢失这个来源会让父 turn 把仍在运行的 child tool 误当前台孤儿收口。这里必须
      // 保留 getter，foreground 后续转后台时，每条 mirror event 才会读取 registry 当前值，
      // 而不是继续携带 child 启动时的 false 快照。
      get background() {
        return registry.get(lifecycle.agentId)?.isBackgrounded === true;
      },
      disallowedTools: lifecycle.profile.disallowedTools,
      sessionId: lifecycle.childSessionId,
      description: request.description,
      maxTurns: lifecycle.profile.maxTurns,
      onSessionReady: notifySessionReady,
      permissionMode: lifecycle.profile.permissionMode,
      prompt: request.prompt,
      profile: lifecycle.profile,
      // P2.5：用户驱动的恢复轮标记随行——子 runtime 据此按真实用户输入记账展示。
      ...(request.initiator === "user" ? { initiator: "user" as const } : {}),
      registerMessageSink: createMessageSinkRegistration(options, lifecycle, registry),
      reportActivity: monitorOptions.reportActivity,
      resumeFromStore: executionOptions.resumeFromStore,
      systemPrompt: lifecycle.profile.systemPrompt,
      workingDirectory: request.workingDirectory,
      workspaceRoot: request.workspaceRoot,
      traceContext: lifecycle.childTraceContext,
    },
    runOptions,
  );
  // 测试桩和旧注入实现可能尚未主动调用 readiness hook；真实 AgentRuntime 会在
  // persist 后调用。回落只保证兼容，不改变生产链路的 persist-before-spawn 顺序。
  await notifySessionReady();

  const usage = aggregateModelUsage(childResult.events);
  const totalTokens = usage?.totalTokens;
  const totalToolUseCount = resolveSubagentToolUseCount(childResult.events);
  const totalDurationMs = Date.now() - lifecycle.startedAt;

  const output: AgentCompletedOutput = {
    status: "completed",
    agentId: lifecycle.agentId,
    agentType: request.agentType,
    description: request.description,
    prompt: request.prompt,
    content: [
      {
        type: "text",
        text: childResult.response,
      },
    ],
    totalToolUseCount,
    totalDurationMs,
    // key/name 裁决（2026-11-17）：worker 派发带用户可读显示名，UI 用它替代 id 展示。
    ...(lifecycle.profile.worker
      ? { workerName: lifecycle.profile.worker.workerName }
      : {}),
    // mailbox 跳转锚点：子会话汇报轮 turnId，随完成通知经 originMeta 透传到 master 会话。
    ...(childResult.turnId ? { sourceTurnId: childResult.turnId } : {}),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(usage === undefined ? {} : { usage }),
  };

  return { events: childResult.events, output };
}

function createSubagentActivityWatchdog(options: {
  abort: (reason?: unknown) => void;
  lifecycle: SubagentLifecycle;
  logger?: Logger;
  request: SubagentRunRequest;
  signal: AbortSignal;
  timeoutMs: number;
}): {
  reportActivity: () => void;
  start: () => void;
  stop: () => void;
} {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return {
      reportActivity: () => {},
      start: () => {},
      stop: () => {},
    };
  }

  let lastActivityAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const schedule = () => {
    stop();
    if (options.signal.aborted) return;
    timer = setTimeout(() => {
      const idleMs = Date.now() - lastActivityAt;
      const error = createCoreError(
        CoreErrorType.ToolTimeout,
        `Subagent was inactive for ${options.timeoutMs}ms`,
        {
          context: {
            code: AgentErrorCode.CHILD_RUNTIME_FAILED,
            agentId: options.lifecycle.agentId,
            agentType: options.request.agentType,
            idleMs,
            parentToolCallId: options.request.parentToolCallId,
            timeoutMs: options.timeoutMs,
          },
          recoverable: true,
          retryable: true,
        },
      );
      options.logger?.warn("Explore subagent activity watchdog fired", {
        ...traceContextToLogContext(options.lifecycle.runTraceContext),
        agentId: options.lifecycle.agentId,
        agentType: options.request.agentType,
        event: "subagent.activity_timeout",
        idleMs,
        module: "core.subagent",
        parentToolCallId: options.request.parentToolCallId,
        status: "failed",
        timeoutMs: options.timeoutMs,
      });
      options.abort(error);
    }, options.timeoutMs);
  };

  const reportActivity = () => {
    lastActivityAt = Date.now();
    schedule();
  };

  return {
    reportActivity,
    start: reportActivity,
    stop,
  };
}

function guardSubagentPromiseWithAbort<T>(
  promise: Promise<T>,
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;

  // 子运行时或模型适配器在 abort 后可能永不 settle；外层 Agent 必须自己监听
  // 父 signal，否则 `Agent` 工具会一直停在 running，直到用户手动 Stop。
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abortHandler);
      callback();
    };

    const abortHandler = () => {
      if (isCoreError(signal.reason)) {
        settle(() => reject(signal.reason));
        return;
      }
      settle(() =>
        reject(
          createCoreError(
            CoreErrorType.ToolCancelled,
            "Agent was cancelled before the subagent returned findings or background launch completed",
            {
              cause: signal.reason instanceof Error ? signal.reason : undefined,
              context: {
                code: AgentErrorCode.CHILD_RUNTIME_FAILED,
                agentId: lifecycle.agentId,
                agentType: request.agentType,
                parentToolCallId: request.parentToolCallId,
              },
              recoverable: true,
            },
          ),
        ),
      );
    };

    promise.then(
      (completed) => settle(() => resolve(completed)),
      (error: unknown) => settle(() => reject(error)),
    );

    if (signal.aborted) {
      abortHandler();
      return;
    }
    signal.addEventListener("abort", abortHandler, { once: true });
  });
}

async function runBackgroundAgent(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
  runOptions?: SubagentRunOptions,
  executionOptions: SubagentExecutionOptions = {},
  onSettled?: () => void,
): Promise<void> {
  let sessionReady = false;
  try {
    if (isTerminalRuntimeTask(registry.get(lifecycle.agentId) ?? { status: "lost" })) {
      executionOptions.onSessionStartFailed?.(new Error("Subagent stopped during startup"));
      return;
    }
    runOptions?.signal?.throwIfAborted();
    const completed = await runAgentToCompletion(
      options,
      request,
      lifecycle,
      registry,
      runOptions,
      {},
      {
        ...executionOptions,
        onSessionReady: async () => {
          await executionOptions.onSessionReady?.();
          sessionReady = true;
        },
      },
    );
    await finalizeBackgroundCompletion(options, request, lifecycle, registry, completed);
  } catch (error) {
    if (!sessionReady) {
      executionOptions.onSessionStartFailed?.(error);
      return;
    }
    await finalizeBackgroundFailure(options, request, lifecycle, registry, error);
  } finally {
    onSettled?.();
  }
}

interface SubagentExecutionOptions {
  resumeFromStore?: boolean;
  onSessionReady?: () => Promise<void>;
  onSessionStartFailed?: (error: unknown) => void;
}

function createSubagentSessionReadyGate(): {
  promise: Promise<void>;
  reject(error: unknown): void;
  resolve(): void;
} {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  let settled = false;
  return {
    promise,
    reject: (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
    resolve: () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
  };
}

function createMessageSinkRegistration(
  options: ExploreSubagentPortOptions,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
): (sink: RuntimeTaskMessageSink) => void {
  return (sink) => {
    registry.update(lifecycle.agentId, (task) => ({
      ...task,
      messageSink: sink,
    }));
    void flushPendingMessages(options, lifecycle, registry, sink);
  };
}

async function flushPendingMessages(
  options: ExploreSubagentPortOptions,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
  sink: RuntimeTaskMessageSink,
): Promise<void> {
  const pending = registry.drainMessages(lifecycle.agentId);
  for (let index = 0; index < pending.length; index++) {
    const message = pending[index];
    if (!message) continue;
    try {
      await sink.send(message);
    } catch (error) {
      for (const undelivered of pending.slice(index)) {
        registry.queueMessage(lifecycle.agentId, undelivered);
      }
      options.logger?.warn("Failed to flush pending subagent message", {
        ...traceContextToLogContext(lifecycle.runTraceContext),
        agentId: lifecycle.agentId,
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "subagent.message.flush.failed",
        module: "core.subagent",
        status: "failed",
      });
      return;
    }
  }
}

/**
 * P2.5 注册表未命中兜底：凭路由层传入的持久化 worker 身份合成一个终态快照，
 * 复用 resumeTerminalAgentInBackground 的既有链（历史校验、profile 重解析、通知生命周期）。
 * 合成条目只进 registry（TaskStop/TaskOutput/通知去重都按它工作），不落 worker-identity 之外的盘。
 */
function createSyntheticWorkerTaskSnapshot(
  options: ExploreSubagentPortOptions,
  request: SubagentSendMessageRequest,
): RuntimeTaskSnapshot | undefined {
  const identity = request.identity;
  if (!identity?.agentType || !identity.childSessionId) return undefined;
  const agentId = options.createAgentId?.() ?? `agent_worker_resume_${Date.now().toString(36)}`;
  const startedAt = new Date(Date.now() - 1);
  return {
    taskId: agentId,
    agentId,
    agentType: identity.agentType,
    childSessionId: identity.childSessionId,
    description: identity.workerName ?? identity.agentType,
    status: "completed",
    startedAt,
    completedAt: new Date(),
    parentSessionId: request.sessionId,
    parentToolCallId: request.parentToolCallId,
    taskType: "local_agent",
    type: "local_agent",
    workerChild: true,
    ...(identity.workerName ? { workerName: identity.workerName } : {}),
    detached: true,
  };
}

/**
 * P2.5 路由辅助：按 child session 反查任务。同一 agentId 的旧终态与新运行并存时
 * 优先非终态（用户打断/输入针对的是此刻的运行）。
 */
function findTaskByChildSessionId(
  registry: RuntimeTaskRegistry,
  childSessionId: SessionId,
): RuntimeTaskSnapshot | undefined {
  let fallback: RuntimeTaskSnapshot | undefined;
  for (const task of Object.values(registry.all())) {
    if (task.type !== "local_agent" || task.childSessionId !== childSessionId) continue;
    if (!isTerminalRuntimeTask(task)) return task;
    fallback ??= task;
  }
  return fallback;
}

function createRuntimeTaskSnapshot(input: {
  isBackgrounded: boolean;
  lifecycle: SubagentLifecycle;
  request: SubagentRunRequest;
  startedAt: Date;
  status: RuntimeTaskSnapshot["status"];
  /** P2.5：恢复/重臂时透传旧任务的用户介入状态（脱钩/返回意图），否则会被重置。 */
  carryDetachStateFrom?: RuntimeTaskSnapshot;
}): RuntimeTaskSnapshot {
  const carried = input.carryDetachStateFrom;
  return {
    taskId: input.lifecycle.agentId,
    agentId: input.lifecycle.agentId,
    agentType: input.request.agentType,
    childSessionId: input.lifecycle.childSessionId,
    description: input.request.description,
    isBackgrounded: input.isBackgrounded,
    outputFile: input.lifecycle.outputFile,
    parentToolCallId: input.request.parentToolCallId,
    parentSessionId: input.request.sessionId,
    prompt: input.request.prompt,
    startedAt: input.startedAt,
    status: input.status,
    taskType: "local_agent",
    traceContext: input.lifecycle.runTraceContext,
    type: "local_agent",
    turnId: input.request.turnId,
    // worker 会话通道（P2.5）：脱钩/返回生命周期只作用于名册 worker 派生的任务。
    workerChild: input.lifecycle.profile.worker !== undefined,
    // ContactAgent 管线轮（2026-11-19）：终态通知抑制的判定键（stopped 路径无 request 可读）。
    ...(input.request.contactRequestId ? { contactRequestId: input.request.contactRequestId } : {}),
    // P2.6：显示名随任务留存，完成通知的来源区块（senderName）用它。
    ...(input.lifecycle.profile.worker
      ? { workerName: input.lifecycle.profile.worker.workerName }
      : {}),
    ...(carried?.detached ? { detached: true } : {}),
    ...(carried?.returnRequested
      ? {
          returnRequested: true,
          ...(carried.returnSummary ? { returnSummary: carried.returnSummary } : {}),
        }
      : {}),
  };
}

function withoutRuntimeMessageState(task: RuntimeTaskSnapshot): RuntimeTaskSnapshot {
  const { messageSink: _messageSink, pendingMessages: _pendingMessages, ...snapshot } = task;
  return snapshot;
}

/** P2.5：返回投递后解除脱钩（内存侧；持久 entry 由 persistWorkerDetachState 删除）。 */
function clearWorkerDetachState(): Partial<RuntimeTaskSnapshot> {
  return { detached: false, returnRequested: false, returnSummary: undefined };
}

/** 延迟返回通知：worker 轮结果在前，用户在场期间的交接摘要随后（缺席段省略）。 */
function joinNotificationResult(result: string | undefined, handoff: string | undefined): string {
  const sections = [result?.trim(), handoff?.trim()].filter((section): section is string =>
    Boolean(section),
  );
  if (sections.length <= 1) return sections[0] ?? "";
  return `${sections.join("\n\n")}`;
}

function createAgentBackgroundedOutput(
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
): AgentBackgroundedOutput {
  return {
    status: "async_launched",
    isAsync: true,
    agentId: lifecycle.agentId,
    agentType: request.agentType,
    description: request.description,
    prompt: request.prompt,
    childSessionId: lifecycle.childSessionId,
    backgroundTaskId: lifecycle.agentId,
    outputFile: lifecycle.outputFile,
    // key/name 裁决（2026-11-17）：worker 派发带用户可读显示名，UI 用它替代 id 展示。
    ...(lifecycle.profile.worker
      ? { workerName: lifecycle.profile.worker.workerName }
      : {}),
    canReadOutputFile: request.callerCanReadOutputFile === true,
  };
}

/**
 * agent 消息（2026-11-19，docs/trigger-system.md）：轮终态把该 worker 的最终输出回投给
 * 在途 ContactAgent 请求（回复捕获取代任务完成通知）。返回结算条数——>0 即抑制本次
 * 完成通知，避免同一段输出以「任务完成通知」重复到达 master。
 */
function resolveAgentContactReplies(
  options: ExploreSubagentPortOptions,
  task: { agentId: string; childSessionId?: SessionId },
  text: string,
): number {
  return (
    options.agentContactRegistry?.resolveReceiverReplies({
      receiverAgentId: task.agentId,
      ...(task.childSessionId ? { receiverSessionId: task.childSessionId } : {}),
      reply: {
        text,
        ...(task.childSessionId ? { sourceSessionId: task.childSessionId } : {}),
      },
    }) ?? 0
  );
}

/**
 * 合成回复解除（无静默路径）：用户接管（takeover，介入瞬间话语权切换，本轮输出不再
 * 捕获）与轮次失败（turn_failed）都立即解除该 worker 的全部在途 needReply 请求。
 */
function resolveAgentContactSynthetic(
  options: ExploreSubagentPortOptions,
  task: { agentId: string; childSessionId?: SessionId; workerName?: string },
  kind: "takeover" | "turn_failed",
): number {
  const contacts = options.agentContactRegistry;
  if (!contacts) return 0;
  const displayName = task.workerName ?? task.agentId;
  return contacts.resolveReceiverSynthetic({
    receiverAgentId: task.agentId,
    ...(task.childSessionId ? { receiverSessionId: task.childSessionId } : {}),
    synthetic: {
      text:
        kind === "takeover"
          ? agentContactTakeoverReply(displayName)
          : agentContactTurnFailedReply(displayName),
      receiverDisplayName: displayName,
    },
  });
}

async function finalizeBackgroundCompletion(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
  completed: { output: AgentCompletedOutput },
): Promise<void> {
  const current = registry.get(lifecycle.agentId);
  if (current && isTerminalRuntimeTask(current)) return;
  // P2.5 延迟返回判定：detached = 用户介入过，通知暂缓；returnRequested = worker 已
  // 调返回工具，本轮终态真正投递（附交接摘要）并解除脱钩。
  const returning = current?.detached === true && current.returnRequested === true;
  // agent 消息（2026-11-19）：先捕获回复再决定通知——捕获结算数 >0 时完成通知被抑制。
  const contactCaptured = resolveAgentContactReplies(
    options,
    lifecycle,
    completed.output.content
      .map((block) => block.text)
      .join("\n\n"),
  );

  await writeCompletedAgentArtifacts(lifecycle, request, completed.output);
  const notification: LocalAgentTaskNotificationInput = {
    agentId: completed.output.agentId,
    description: completed.output.description,
    outputFile: lifecycle.outputFile,
    parentToolCallId: String(request.parentToolCallId),
    result: joinNotificationResult(
      completed.output.content.map((block) => block.text).join("\n\n"),
      returning ? current?.returnSummary : undefined,
    ),
    status: "completed",
    totalDurationMs: completed.output.totalDurationMs,
    totalTokens: completed.output.totalTokens,
    totalToolUseCount: completed.output.totalToolUseCount,
    usage: completed.output.usage,
    ...(completed.output.sourceTurnId ? { sourceTurnId: completed.output.sourceTurnId } : {}),
  };
  const completedAt = new Date();
  const task = registry.update(lifecycle.agentId, (current) => ({
    ...withoutRuntimeMessageState(current),
    status: "completed",
    completedAt,
    output: completed.output,
    ...(returning ? clearWorkerDetachState() : {}),
    usage: {
      durationMs: completed.output.totalDurationMs,
      modelUsage: completed.output.usage,
      toolUseCount: completed.output.totalToolUseCount,
      totalTokens: completed.output.totalTokens,
    },
  }));
  if (current?.detached === true && !returning) {
    options.logger?.info("Subagent completion notification deferred (detached by user)", {
      ...traceContextToLogContext(lifecycle.runTraceContext),
      agentId: lifecycle.agentId,
      event: "subagent.background.notification_deferred",
      module: "core.subagent",
    });
  } else if (returning) {
    // 延迟返回：积压通知 + 交接摘要投递并解除脱钩（优先级高于 ContactAgent 抑制）。
    enqueueBackgroundNotification(
      options,
      registry,
      lifecycle.agentId,
      notification,
      lifecycle.runTraceContext,
    );
  } else if (contactCaptured > 0 || request.contactRequestId !== undefined) {
    // ContactAgent 管线轮：回复捕获（或 needReply=false 的投递轮）取代任务完成通知。
    options.logger?.info("Subagent completion notification suppressed (ContactAgent reply path)", {
      ...traceContextToLogContext(lifecycle.runTraceContext),
      agentId: lifecycle.agentId,
      contactCaptured,
      contactRequestId: request.contactRequestId,
      event: "subagent.background.notification_suppressed_contact",
      module: "core.subagent",
    });
  } else {
    enqueueBackgroundNotification(
      options,
      registry,
      lifecycle.agentId,
      notification,
      lifecycle.runTraceContext,
    );
  }
  if (returning) void options.persistWorkerDetachState?.(lifecycle.childSessionId, false);
  if (task) {
    await emitBackgroundTaskCompletedEvent(options, request, lifecycle.runTraceContext, task);
  }

  await emitSubagentEvent(
    options,
    SessionEventType.SubagentStopped,
    request,
    lifecycle.runTraceContext,
    {
      agentId: lifecycle.agentId,
      agentType: request.agentType,
      background: true,
      childSessionId: lifecycle.childSessionId,
      parentToolCallId: request.parentToolCallId,
      status: "completed",
      outputFile: lifecycle.outputFile,
      totalDurationMs: completed.output.totalDurationMs,
      totalToolUseCount: completed.output.totalToolUseCount,
      totalTokens: completed.output.totalTokens,
    },
  );

  options.logger?.info("Subagent background task completed", {
    ...traceContextToLogContext(lifecycle.runTraceContext),
    agentId: lifecycle.agentId,
    durationMs: completed.output.totalDurationMs,
    event: "subagent.background.completed",
    module: "core.subagent",
    status: "completed",
    totalToolUseCount: completed.output.totalToolUseCount,
    totalTokens: completed.output.totalTokens,
  });
}

async function finalizeBackgroundFailure(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
  error: unknown,
): Promise<void> {
  const current = registry.get(lifecycle.agentId);
  if (current && isTerminalRuntimeTask(current)) return;
  // P2.5 延迟返回判定（与 completion 同规则）。
  const returning = current?.detached === true && current.returnRequested === true;

  // background runner 收到的通常是 Turn failure wrapper，直接读 message
  // 会把 provider 的 429 原文替换成通用的 “Turn execution failed”；这里只选择
  // wrapper 下的根因 message，不压缩空白或截断 provider 原文。
  const errorMessage = error instanceof Error ? selectExecutionErrorMessage(error) : String(error);
  const completedAt = new Date();
  const totalDurationMs = Date.now() - lifecycle.startedAt;
  await writeFailedAgentArtifacts(lifecycle, request, errorMessage);
  const notification: LocalAgentTaskNotificationInput = {
    agentId: lifecycle.agentId,
    description: request.description,
    error: errorMessage,
    outputFile: lifecycle.outputFile,
    parentToolCallId: String(request.parentToolCallId),
    status: "failed",
    totalDurationMs,
    // 延迟返回：失败轮若已登记返回，把 worker 的交接摘要随通知带给派发者。
    ...(returning && current?.returnSummary ? { result: current.returnSummary } : {}),
  };
  const task = registry.update(lifecycle.agentId, (current) => ({
    ...withoutRuntimeMessageState(current),
    status: "failed",
    completedAt,
    error: errorMessage,
    ...(returning ? clearWorkerDetachState() : {}),
    usage: {
      durationMs: totalDurationMs,
    },
  }));
  if (current?.detached === true && !returning) {
    options.logger?.info("Subagent failure notification deferred (detached by user)", {
      ...traceContextToLogContext(lifecycle.runTraceContext),
      agentId: lifecycle.agentId,
      event: "subagent.background.notification_deferred",
      module: "core.subagent",
    });
  } else if (returning || request.contactRequestId === undefined) {
    // 延迟返回照常投递；非 ContactAgent 管线轮维持失败通知原语义。
    enqueueBackgroundNotification(
      options,
      registry,
      lifecycle.agentId,
      notification,
      lifecycle.runTraceContext,
    );
  } else {
    // ContactAgent 管线轮失败：失败通知被合成回复路径取代（无静默路径）。
    options.logger?.info("Subagent failure notification suppressed (ContactAgent reply path)", {
      ...traceContextToLogContext(lifecycle.runTraceContext),
      agentId: lifecycle.agentId,
      contactRequestId: request.contactRequestId,
      event: "subagent.background.notification_suppressed_contact",
      module: "core.subagent",
    });
  }
  // 失败轮没有最终输出：在途请求以合成回复解除（登记已结算，与用户接管互不重复触发）。
  resolveAgentContactSynthetic(options, lifecycle, "turn_failed");
  if (returning) void options.persistWorkerDetachState?.(lifecycle.childSessionId, false);
  if (task) {
    await emitBackgroundTaskCompletedEvent(options, request, lifecycle.runTraceContext, task);
  }

  await emitSubagentEvent(
    options,
    SessionEventType.SubagentStopped,
    request,
    lifecycle.runTraceContext,
    {
      agentId: lifecycle.agentId,
      agentType: request.agentType,
      background: true,
      childSessionId: lifecycle.childSessionId,
      parentToolCallId: request.parentToolCallId,
      status: "failed",
      outputFile: lifecycle.outputFile,
      totalDurationMs,
      error: errorMessage,
    },
  );

  options.logger?.warn("Subagent background task failed", {
    ...traceContextToLogContext(lifecycle.runTraceContext),
    agentId: lifecycle.agentId,
    errorMessage,
    event: "subagent.background.failed",
    module: "core.subagent",
    status: "failed",
  });
}

interface StoppedBackgroundAgentTask {
  initiator: SubagentStopOptions["initiator"];
  previousTask: RuntimeTaskSnapshot;
  task: RuntimeTaskSnapshot;
  totalDurationMs: number;
  traceContext: TraceContext;
}

const BACKGROUND_AGENT_STOPPED_STATE = {
  backgroundEventStatus: "cancelled",
  message: "Background agent task stopped.",
  notificationStatus: "killed",
  registryStatus: "killed",
  subagentEventStatus: "stopped",
} as const;

function createBackgroundStoppedTask(
  registry: RuntimeTaskRegistry,
  task: RuntimeTaskSnapshot,
  initiator: SubagentStopOptions["initiator"],
): StoppedBackgroundAgentTask | undefined {
  const current = registry.get(task.taskId);
  if (!current || isTerminalRuntimeTask(current)) return undefined;

  const completedAt = new Date();
  const totalDurationMs = Math.max(0, completedAt.getTime() - current.startedAt.getTime());
  const stopped: RuntimeTaskSnapshot = {
    ...withoutRuntimeMessageState(current),
    status: BACKGROUND_AGENT_STOPPED_STATE.registryStatus,
    completedAt,
    error: BACKGROUND_AGENT_STOPPED_STATE.message,
    usage: {
      durationMs: totalDurationMs,
    },
  };

  const traceContext = traceContextFromRuntimeTask(stopped);
  return { initiator, previousTask: current, task: stopped, totalDurationMs, traceContext };
}

async function finalizeBackgroundStopped(
  options: ExploreSubagentPortOptions,
  registry: RuntimeTaskRegistry,
  stopped: StoppedBackgroundAgentTask,
  onCommitted?: () => void,
): Promise<RuntimeTaskSnapshot | undefined> {
  // P2.5 延迟返回判定：用户打断（脱钩已武装在 detached 上）暂缓 killed 通知；
  // 脱钩期间 worker 轮被停止且已请求返回 → 本轮终态投递（附交接摘要）并解除脱钩。
  const returning = stopped.task.detached === true && stopped.task.returnRequested === true;
  const notification: LocalAgentTaskNotificationInput = {
    agentId: stopped.task.agentId,
    description: stopped.task.description,
    outputFile: stopped.task.outputFile ?? "",
    parentToolCallId: String(stopped.task.parentToolCallId ?? stopped.task.taskId),
    status: BACKGROUND_AGENT_STOPPED_STATE.notificationStatus,
    stoppedBy: stopped.initiator,
    totalDurationMs: stopped.totalDurationMs,
    ...(returning && stopped.task.returnSummary ? { result: stopped.task.returnSummary } : {}),
  };
  await writeStoppedAgentArtifacts(stopped.task);
  registry.update(stopped.task.taskId, (current) => ({
    ...stopped.task,
    notified: current.notified,
  }));
  const deferred = stopped.task.detached === true && !returning;
  if (deferred) {
    options.logger?.info("Subagent stop notification deferred (detached by user)", {
      ...traceContextToLogContext(stopped.traceContext),
      agentId: stopped.task.agentId,
      event: "subagent.background.notification_deferred",
      module: "core.subagent",
      registryStatus: BACKGROUND_AGENT_STOPPED_STATE.registryStatus,
    });
  } else if (
    !returning &&
    stopped.initiator === "model" &&
    stopped.task.contactRequestId !== undefined
  ) {
    // ContactAgent 管线轮被模型侧停止：终止通知被合成回复取代（普通派发的 TaskStop
    // 通知语义不变；用户停走 deferred 分支，stopTask 已在介入瞬间做过合成解除）。
    options.logger?.info("Subagent stop notification suppressed (ContactAgent reply path)", {
      ...traceContextToLogContext(stopped.traceContext),
      agentId: stopped.task.agentId,
      event: "subagent.background.notification_suppressed_contact",
      module: "core.subagent",
    });
  } else {
    const enqueued = enqueueBackgroundNotification(
      options,
      registry,
      stopped.task.taskId,
      notification,
      stopped.traceContext,
    );
    if (!enqueued) {
      registry.register(stopped.previousTask);
      throw new Error(
        `Background agent task stopped notification was not enqueued: ${stopped.task.taskId}`,
      );
    }
  }
  if (returning) {
    registry.update(stopped.task.taskId, (current) => ({
      ...current,
      ...clearWorkerDetachState(),
    }));
    void options.persistWorkerDetachState?.(stopped.task.childSessionId, false);
  }
  // 停止轮没有最终输出：在途请求以合成回复解除（用户停 → 接管文案；模型停 → 失败文案）。
  resolveAgentContactSynthetic(
    options,
    stopped.task,
    stopped.initiator === "user" ? "takeover" : "turn_failed",
  );

  const committed = registry.get(stopped.task.taskId);
  if (!committed) return undefined;
  onCommitted?.();

  await emitRuntimeTaskBackgroundCompletedEvent(options, committed, stopped.traceContext);
  await emitRuntimeTaskSubagentStoppedEvent(
    options,
    committed,
    stopped.traceContext,
    stopped.totalDurationMs,
  );
  options.logger?.info("Subagent background task stopped", {
    ...traceContextToLogContext(stopped.traceContext),
    agentId: stopped.task.agentId,
    event: "subagent.background.stopped",
    module: "core.subagent",
    status: BACKGROUND_AGENT_STOPPED_STATE.backgroundEventStatus,
  });
  return committed;
}

async function emitBackgroundTaskCompletedEvent(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  traceContext: TraceContext,
  task: RuntimeTaskSnapshot,
): Promise<void> {
  if (!isTerminalRuntimeTask(task)) return;
  await emitSubagentEvent(
    options,
    SessionEventType.BackgroundTaskCompleted,
    request,
    traceContext,
    {
      taskId: task.taskId,
      toolCallId: String(request.parentToolCallId),
      toolName: "Agent",
      taskKind: "subagent",
      childSessionId: task.childSessionId,
      cancellable: false,
      description: task.description,
      status: task.status,
      startedAt: task.startedAt,
      completedAt: task.completedAt ?? new Date(),
      outputPath: task.outputFile,
      terminalId: task.taskId,
    },
  );
}

async function emitRuntimeTaskBackgroundCompletedEvent(
  options: ExploreSubagentPortOptions,
  task: RuntimeTaskSnapshot,
  traceContext: TraceContext,
): Promise<void> {
  if (!task.parentSessionId) return;
  const event = createSessionEvent(
    SessionEventType.BackgroundTaskCompleted,
    task.parentSessionId,
    {
      taskId: task.taskId,
      toolCallId: String(task.parentToolCallId ?? task.taskId),
      toolName: "Agent",
      taskKind: "subagent",
      childSessionId: task.childSessionId,
      cancellable: false,
      description: task.description,
      status: BACKGROUND_AGENT_STOPPED_STATE.backgroundEventStatus,
      startedAt: task.startedAt,
      completedAt: task.completedAt ?? new Date(),
      outputPath: task.outputFile,
      terminalId: task.taskId,
    },
    {
      turnId: task.turnId,
      traceId: traceContext.traceId,
    },
  );
  await options.emitParentEvent(event, traceContext);
}

async function emitRuntimeTaskSubagentStoppedEvent(
  options: ExploreSubagentPortOptions,
  task: RuntimeTaskSnapshot,
  traceContext: TraceContext,
  totalDurationMs: number,
): Promise<void> {
  if (!task.parentSessionId) return;
  const event = createSessionEvent(
    SessionEventType.SubagentStopped,
    task.parentSessionId,
    {
      agentId: task.agentId,
      agentType: task.agentType,
      background: true,
      childSessionId: task.childSessionId,
      parentToolCallId: task.parentToolCallId,
      status: BACKGROUND_AGENT_STOPPED_STATE.subagentEventStatus,
      outputFile: task.outputFile,
      totalDurationMs,
      error: task.error,
    },
    {
      turnId: task.turnId,
      traceId: traceContext.traceId,
    },
  );
  await options.emitParentEvent(event, traceContext);
}

function enqueueBackgroundNotification(
  options: ExploreSubagentPortOptions,
  registry: RuntimeTaskRegistry,
  taskId: string,
  notification: LocalAgentTaskNotificationInput,
  traceContext: TraceContext,
): boolean {
  if (!options.enqueueParentTaskNotification) {
    options.logger?.warn("Skipped subagent background notification without parent queue", {
      ...traceContextToLogContext(traceContext),
      event: "subagent.background.notification.skipped",
      module: "core.subagent",
      taskId,
    });
    return false;
  }

  const task = registry.get(taskId);
  if (!task || task.notified) {
    options.logger?.debug("Skipped duplicate subagent background notification", {
      ...traceContextToLogContext(traceContext),
      event: "subagent.background.notification.duplicate",
      module: "core.subagent",
      reason: task ? "already_notified" : "task_missing",
      taskId,
    });
    return false;
  }

  try {
    options.enqueueParentTaskNotification({
      originMeta: {
        backgroundSource: "subagent",
        title: task.description.trim() || taskId,
        workId: taskId,
        // 通知文本与结构化终态出自同一份输入，App 不解析文本。
        subagentResult: localAgentSubagentResult(notification),
        // mailbox 跳转锚点：子会话汇报轮 turnId，master 会话的 mailbox 行据此精确滚动。
        ...(notification.sourceTurnId ? { sourceTurnId: notification.sourceTurnId } : {}),
      },
      taskId,
      text: formatLocalAgentTaskNotification(notification),
      traceContext,
    });
  } catch (error) {
    options.logger?.warn("Failed to enqueue subagent background notification", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "subagent.background.notification.failed",
      module: "core.subagent",
      taskId,
    });
    return false;
  }

  registry.update(taskId, (current) =>
    current.notified
      ? current
      : {
          ...current,
          notified: true,
        },
  );
  options.logger?.info?.("Subagent background notification enqueued", {
    ...traceContextToLogContext(traceContext),
    event: "subagent.background.notification.enqueued",
    module: "core.subagent",
    taskId,
  });
  return true;
}

function traceContextFromRuntimeTask(task: RuntimeTaskSnapshot): TraceContext {
  return (
    task.traceContext ?? {
      traceId: createTraceId(),
      spanId: `span_${task.taskId}`,
      sessionId: task.parentSessionId,
      turnId: task.turnId,
    }
  );
}

async function emitSubagentEvent(
  options: ExploreSubagentPortOptions,
  type: SessionEventType,
  request: SubagentRunRequest,
  traceContext: TraceContext,
  payload: Record<string, unknown>,
): Promise<void> {
  const event = createSessionEvent(type, request.sessionId, payload, {
    turnId: request.turnId,
    traceId: traceContext.traceId,
  });
  await options.emitParentEvent(event, traceContext);
}

async function writeCompletedAgentArtifacts(
  lifecycle: SubagentLifecycle,
  request: SubagentRunRequest,
  output: AgentCompletedOutput,
): Promise<void> {
  const text = output.content.map((block) => block.text).join("\n\n");
  await writeAgentOutputFiles(lifecycle, text);
  // 子 agent 事件已由 session event store 持久化，不再重复写入 transcript sidecar。
  await writeAgentMetadataFile(lifecycle, request, "completed", {
    completedAt: new Date().toISOString(),
    totalDurationMs: output.totalDurationMs,
    totalTokens: output.totalTokens,
    totalToolUseCount: output.totalToolUseCount,
    usage: output.usage,
  });
}

async function writeFailedAgentArtifacts(
  lifecycle: SubagentLifecycle,
  request: SubagentRunRequest,
  errorMessage: string,
): Promise<void> {
  await writeAgentOutputFiles(lifecycle, errorMessage);
  await writeAgentMetadataFile(lifecycle, request, "failed", {
    completedAt: new Date().toISOString(),
    error: errorMessage,
  });
}

async function writeStoppedAgentArtifacts(task: RuntimeTaskSnapshot): Promise<void> {
  if (!task.outputFile) return;
  const outputDir = dirname(task.outputFile);
  const content = `${BACKGROUND_AGENT_STOPPED_STATE.message}\n`;
  await writeTextFile(task.outputFile, content);
  await writeTextFile(join(outputDir, "task.output"), content);
  await writeTextFile(
    join(outputDir, "metadata.json"),
    `${JSON.stringify(
      {
        agentId: task.agentId,
        childSessionId: task.childSessionId,
        completedAt: new Date().toISOString(),
        description: task.description,
        outputFile: task.outputFile,
        parentSessionId: task.parentSessionId,
        parentToolUseId: task.parentToolCallId,
        profileId: task.agentType,
        prompt: task.prompt,
        status: BACKGROUND_AGENT_STOPPED_STATE.subagentEventStatus,
        taskOutputFile: join(outputDir, "task.output"),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

async function writeAgentOutputFiles(
  lifecycle: Pick<SubagentLifecycle, "outputFile" | "taskOutputFile">,
  content: string,
): Promise<void> {
  await writeTextFile(lifecycle.outputFile, content);
  await writeTextFile(lifecycle.taskOutputFile, content);
}

async function writeAgentMetadataFile(
  lifecycle: SubagentLifecycle,
  request: SubagentRunRequest,
  status: "running" | "completed" | "failed" | "stopped",
  extra: Record<string, unknown> = {},
): Promise<void> {
  await writeTextFile(
    lifecycle.metadataFile,
    `${JSON.stringify(
      {
        agentId: lifecycle.agentId,
        childSessionId: lifecycle.childSessionId,
        createdAt: new Date(lifecycle.startedAt).toISOString(),
        cwd: request.workingDirectory,
        description: request.description,
        metadataFile: lifecycle.metadataFile,
        outputFile: lifecycle.outputFile,
        parentSessionId: request.sessionId,
        parentToolUseId: request.parentToolCallId,
        profileId: request.agentType,
        profileSnapshot: lifecycle.profile,
        prompt: request.prompt,
        status,
        taskOutputFile: lifecycle.taskOutputFile,
        updatedAt: new Date().toISOString(),
        workspaceRoot: request.workspaceRoot,
        ...extra,
      },
      null,
      2,
    )}\n`,
  );
}

function aggregateModelUsage(events: SessionEvent[]): ModelUsage | undefined {
  let usage: ModelUsage | undefined;

  for (const event of events) {
    const payload = event.payload;
    // 与主 turn 共用失败事件的用量事实，不增加独立汇总状态。
    if (
      event.type !== SessionEventType.ModelComplete &&
      !(
        event.type === SessionEventType.ModelNetworkStatus &&
        isRecord(payload) &&
        payload.type === "model_request_failed"
      )
    )
      continue;
    if (!isRecord(payload) || !isRecord(payload.usage)) {
      continue;
    }

    const modelUsage = payload.usage as ModelUsage;
    if (!hasModelUsage(modelUsage)) continue;
    usage ??= {};
    addUsage(usage, modelUsage);
  }

  return usage;
}

function resolveSubagentToolUseCount(events: SessionEvent[]): number {
  let turnCompleteToolCallCount = 0;
  let sawTurnCompleteToolCallCount = false;

  for (const event of events) {
    if (event.type !== SessionEventType.TurnComplete || !isRecord(event.payload)) {
      continue;
    }
    const toolCallCount = event.payload.toolCallCount;
    if (typeof toolCallCount !== "number" || !Number.isFinite(toolCallCount)) {
      continue;
    }
    sawTurnCompleteToolCallCount = true;
    turnCompleteToolCallCount += toolCallCount;
  }

  if (sawTurnCompleteToolCallCount) {
    return turnCompleteToolCallCount;
  }

  // ToolCallResult/ToolCallError 会直接 append 到 event store，
  // 不一定回填进 child TurnResult.events；child TurnComplete 里的 toolCallCount
  // 才是运行时 loopState 累计出的权威子 agent 工具调用数。
  return events.filter(
    (event) =>
      event.type === SessionEventType.ToolCallResult ||
      event.type === SessionEventType.ToolCallError,
  ).length;
}

function addUsage(target: ModelUsage, next: ModelUsage): void {
  addOptionalUsageNumber(target, "inputTokens", next.inputTokens);
  addOptionalUsageNumber(target, "outputTokens", next.outputTokens);
  addOptionalUsageNumber(target, "totalTokens", resolveTotalTokens(next));
  addOptionalUsageNumber(target, "cacheReadTokens", next.cacheReadTokens);
  addOptionalUsageNumber(target, "cacheWriteTokens", next.cacheWriteTokens);
  addOptionalUsageNumber(target, "reasoningTokens", next.reasoningTokens);
  const webSearchRequests = next.serverToolUse?.webSearchRequests ?? 0;
  const webFetchRequests = next.serverToolUse?.webFetchRequests ?? 0;
  if (webSearchRequests > 0 || webFetchRequests > 0) {
    target.serverToolUse ??= {};
    target.serverToolUse.webSearchRequests =
      (target.serverToolUse.webSearchRequests ?? 0) + webSearchRequests;
    target.serverToolUse.webFetchRequests =
      (target.serverToolUse.webFetchRequests ?? 0) + webFetchRequests;
  }
}

function addOptionalUsageNumber(
  target: ModelUsage,
  key: keyof Pick<
    ModelUsage,
    | "inputTokens"
    | "outputTokens"
    | "totalTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "reasoningTokens"
  >,
  value: number | undefined,
): void {
  if (value === undefined) return;
  target[key] = (target[key] ?? 0) + value;
}

function resolveTotalTokens(usage: ModelUsage): number | undefined {
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  if (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.cacheReadTokens === undefined &&
    usage.cacheWriteTokens === undefined
  ) {
    return undefined;
  }
  return getModelUsageTotalTokens(usage);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveAllowedTools(
  profile: AgentProfile,
  options: ExploreSubagentPortOptions,
): readonly string[] {
  const profileTools = isBuiltInExploreAgentProfile(profile)
    ? (options.getAllowedTools?.(profile) ?? EXPLORE_AGENT_ALLOWED_TOOLS)
    : profile.tools;
  const baseTools = [...(profileTools ?? [])];
  const disallowed = new Set(profile.disallowedTools ?? []);
  if (profile.skills && profile.skills.length > 0 && !disallowed.has("Skill")) {
    baseTools.push("Skill");
  }
  return filterSubagentChildToolNames(baseTools, profile.disallowedTools);
}

async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
