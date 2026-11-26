import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  resolveRoutingForSessionKey,
  sessionKeyForTrigger,
  triggerRegistrySchema,
  TRIGGER_ID_PREFIX,
  uuidv7,
  type TriggerRouting,
} from "@robinrun/shared";
import {
  backgroundBatchTelemetryAttributes,
  telemetryInputOrigin,
  TELEMETRY_INPUT_ORIGIN_ATTRIBUTE,
} from "./input-intent-persistence.js";
import { traceContextToLogContext } from "../deps.js";
import { refreshOffPeakWork } from "../off-peak/runtime.js";
import type {
  PromptRuntimeCommand,
  RuntimeCommand,
  TaskNotificationRuntimeCommand,
} from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  persistBackgroundTaskNotificationBatch,
  shouldSuppressTaskNotificationRuntimeCommand,
} from "./background-notifications.js";
import { persistSubagentMessageCommand } from "./subagent-messages.js";
import { agentContactTakeoverReply } from "../../subagent/agent-contact.js";
import { runControlOnlyTurnCommand } from "./control-only-turn.js";
import { createTurnCancelledError } from "../helpers/index.js";
import { executeTargetContinuationCommand } from "./target.js";
import { runActiveTargetContinuationLoop } from "./target-continuation-loop.js";
import { isStaleBranchRuntimeCommand } from "./runtime-command-generation.js";
import { noteWorkflowReminderCommandStarted } from "./dynamic-workflow-blocked-reminder.js";
import type {
  AcquireForegroundPromotionLeaseResult,
  ActiveForegroundExecutionState,
  ForegroundPromotionLeaseMode,
  StopActiveForegroundExecutionOptions,
  StopActiveForegroundExecutionResult,
} from "../types.js";

export function enqueueRuntimeCommand(this: AgentRuntimeInternal, command: RuntimeCommand): void {
  const sourceTaskId =
    command.mode === "task-notification"
      ? command.taskId
      : command.mode === "subagent-message"
        ? command.agentId
        : undefined;
  // 任务卡取消封住该执行的迟到通知；聊天 Stop 不设置此标记，保持原有唤起行为。
  if (sourceTaskId && this.runtimeTaskRegistry.get(sourceTaskId)?.offPeakCancelled) return;
  const offPeakExecutionId =
    sourceTaskId && this.runtimeTaskRegistry.get(sourceTaskId)?.offPeakExecutionId;
  if (offPeakExecutionId) command = { ...command, offPeakExecutionId };
  this.runtimeCommandQueue.enqueue(command);
  if (command.mode === "task-notification") {
    this.logger?.info?.("Background task notification enqueued into runtime command queue", {
      ...traceContextToLogContext(command.traceContext),
      commandId: command.id,
      event: "background_task.notification.runtime_enqueued",
      module: "core.runtime",
      queueSize: this.runtimeCommandQueue.size(),
    });
  }
  void this.drainRuntimeCommandQueue();
}

export async function drainRuntimeCommandQueue(this: AgentRuntimeInternal): Promise<void> {
  if (this.runtimeCommandDrainActive) return;

  this.runtimeCommandDrainActive = true;
  try {
    let commands: readonly RuntimeCommand[];
    // 将同批后台通知合并到一个模型轮，避免每条通知都单独发起请求。
    while ((commands = dequeueNextRunnableBatch.call(this)).length > 0) {
      const firstCommand = commands[0];
      if (!firstCommand) continue;
      noteWorkflowReminderCommandStarted(this, firstCommand);
      if (firstCommand.mode === "task-notification") {
        const notificationCommands = commands.filter(
          (command): command is TaskNotificationRuntimeCommand =>
            command.mode === "task-notification",
        );
        if (notificationCommands.length !== commands.length) {
          throw new Error("Runtime command queue returned a mixed task-notification batch");
        }
        await runTaskNotificationBatch.call(this, notificationCommands);
        continue;
      }
      if (commands.length !== 1) {
        throw new Error(`Runtime command queue returned an unsupported ${firstCommand.mode} batch`);
      }
      await runRuntimeCommand.call(this, firstCommand);
    }
  } finally {
    this.runtimeCommandDrainActive = false;
    refreshOffPeakWork(this);
  }

  if (this.runtimeCommandQueue.hasPending() && this.foregroundPromotionLease === undefined) {
    await this.drainRuntimeCommandQueue();
    return;
  }
  // 空闲沿：队列排空，且没有任何在跑 / 排着 / 预留的回合（持着晋升租约、或 prompt 已预留未入队时不算，
  // 那一轮自己排空时会再走到这里）。「run 还欠着决定」的提醒钟从这里起算。
  if (!hasActiveOrQueuedTurnWork.call(this)) this.workflowBlockedReminder?.sessionIdle();
}

function dequeueNextRunnableBatch(this: AgentRuntimeInternal): readonly RuntimeCommand[] {
  const lease = this.foregroundPromotionLease;
  if (!lease) return this.runtimeCommandQueue.dequeueNextBatch();

  const promotedCommand = this.runtimeCommandQueue
    .snapshot()
    .find((command) => runtimeCommandInputId(command) === lease.promotedInputId);
  if (!promotedCommand) return Object.freeze([]);
  const removedPromotedCommand = this.runtimeCommandQueue.removeById(promotedCommand.id);
  if (!removedPromotedCommand) return Object.freeze([]);

  // sendQueuedNow 过去在 Stop A 与 promoted command 入队之间没有 Core
  // 调度所有权，notification B 会抢先出队。匹配 command 出队与 lease 消费必须同一同步步。
  this.foregroundPromotionLease = undefined;
  return Object.freeze([removedPromotedCommand]);
}

function runtimeCommandInputId(command: RuntimeCommand): string | undefined {
  if (
    command.mode === "prompt" ||
    command.mode === "target-continuation" ||
    command.mode === "target-continuation-loop"
  ) {
    return command.options?.inputId;
  }
  return undefined;
}

export function hasActiveOrQueuedTurnWork(this: AgentRuntimeInternal): boolean {
  return (
    this.foregroundPromotionLease !== undefined ||
    this.activeForegroundExecution !== undefined ||
    this.runtimeCommandDrainActive ||
    this.runtimeCommandQueue.hasPending() ||
    this.activeTurn !== undefined ||
    this.activeTurnStartReservation !== undefined
  );
}

export function acquireForegroundPromotionLease(
  this: AgentRuntimeInternal,
  options: {
    leaseId: string;
    mode: ForegroundPromotionLeaseMode;
    promotedInputId: string;
  },
): AcquireForegroundPromotionLeaseResult {
  const existing = this.foregroundPromotionLease;
  if (existing) {
    return existing.leaseId === options.leaseId
      ? { kind: "acquired", leaseId: existing.leaseId }
      : { kind: "conflict", leaseId: existing.leaseId };
  }
  if (
    options.mode === "idle-only" &&
    (this.activeForegroundExecution !== undefined ||
      this.runtimeCommandDrainActive ||
      this.runtimeCommandQueue.hasPending() ||
      this.activeTurn !== undefined ||
      this.activeTurnStartReservation !== undefined)
  ) {
    return { kind: "busy" };
  }
  this.foregroundPromotionLease = {
    leaseId: options.leaseId,
    promotedInputId: options.promotedInputId,
  };
  return { kind: "acquired", leaseId: options.leaseId };
}

export function releaseForegroundPromotionLease(
  this: AgentRuntimeInternal,
  leaseId: string,
): boolean {
  if (this.foregroundPromotionLease?.leaseId !== leaseId) return false;
  this.foregroundPromotionLease = undefined;
  // 启动前失败时 B 可能已在 lease 后等待；释放必须主动恢复 drain，不能等下一条 enqueue。
  void this.drainRuntimeCommandQueue();
  return true;
}

async function runPostCommandActiveTargetLoop(
  this: AgentRuntimeInternal,
  command: RuntimeCommand,
  abortSignal: AbortSignal,
): Promise<Awaited<ReturnType<AgentRuntimeInternal["continueActiveTargetLoop"]>> | null> {
  if (command.mode === "prompt" && command.options?.continueActiveTargetAfterTurn === true) {
    const originalTrace = command.options.traceContext ?? command.traceContext;
    const inputOrigin = telemetryInputOrigin(command.options.intent, originalTrace.attributes);
    return await runActiveTargetContinuationLoop.call(this, {
      abortSignal,
      inputId: command.options.inputId,
      traceContext: inputOrigin
        ? {
            ...originalTrace,
            attributes: {
              ...originalTrace.attributes,
              [TELEMETRY_INPUT_ORIGIN_ATTRIBUTE]: inputOrigin,
            },
          }
        : originalTrace,
      trigger: "user-prompt",
      verifyBeforeFirstContinue: true,
    });
  }
  if (command.mode === "task-notification") {
    try {
      return await runActiveTargetContinuationLoop.call(this, {
        abortSignal,
        traceContext: command.traceContext,
        trigger: "task-notification",
        verifyBeforeFirstContinue: true,
      });
    } catch (error) {
      this.logger?.warn("Post-command goal continuation failed", {
        ...traceContextToLogContext(command.traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "target.continuation.after_command_failed",
        module: "core.runtime",
      });
    }
  }
  return null;
}

async function runRuntimeCommand(
  this: AgentRuntimeInternal,
  command: RuntimeCommand,
): Promise<void> {
  if (command.mode === "task-notification") {
    await runTaskNotificationBatch.call(this, [command]);
    return;
  }
  if (isStaleBranchRuntimeCommand(this, command)) return;
  const foregroundExecution = beginForegroundExecution.call(this, command);
  try {
    if (command.mode === "prompt") {
      if (this.runtimeCommandQueue.consumeCancelPending(command.id)) {
        if (command.startReservation) this.releaseTurnStart(command.startReservation.turnId);
        command.reject(createTurnCancelledError(command.options?.abortSignal?.reason));
        return;
      }
      // agent 消息（2026-11-19 话语权裁决）：真实用户 prompt 起跑 = 用户介入接收方会话，
      // 其在途 ContactAgent 请求在轮起跑前以合成回复解除（介入瞬间切换的落地时刻——
      // 排队输入必然晚于被介入轮的终态捕获或随取消路径解除，这里只结算仍存活的条目）。
      // 真实用户判据与 turn.ts 的 real_user 规则一致：无来源标注的普通可见输入。
      // worker 会话同构化后本解除点对 master/worker 会话同构生效（进程共享登记表）。
      if (isRealUserPromptCommand(command)) {
        const contactDisplayName =
          this.config.workerIdentity?.workerName ?? "the main agent (master)";
        this.agentContactRegistry?.resolveReceiverSynthetic({
          receiverSessionId: this.sessionId,
          synthetic: {
            text: agentContactTakeoverReply(contactDisplayName),
            receiverDisplayName: contactDisplayName,
          },
        });
      }
      // 触发器专属会话（2026-11-19 验收裁决）：触发器投递轮（automationId=trg-*）首次
      // 到达时读盘缓存触发器 README——之后每轮系统提示词都携带（压缩后仍在），投递
      // 消息正文只承载事件内容。读取失败只标记已加载（防重复 IO），不阻断投递。
      // viaDispatcherSessionId 区分分发器会话与它的处理会话（2026-11-25 实测修正）。
      await ensureTriggerSessionReadme.call(
        this,
        command.options?.automationId,
        command.options?.systemStatus?.viaDispatcherSessionId,
      );
      try {
        const result = await this.executeTurnCommand(
          command.input,
          command.attachments,
          {
            ...command.options,
            abortSignal: foregroundExecution.controller.signal,
          },
          command.startReservation,
        );
        const continuationResult = await runPostCommandActiveTargetLoop.call(
          this,
          command,
          foregroundExecution.controller.signal,
        );
        command.resolve(continuationResult ?? result);
      } finally {
        this.runtimeCommandQueue.clearCancelPending(command.id);
      }
      return;
    }
    if (command.mode === "target-continuation") {
      if (this.runtimeCommandQueue.consumeCancelPending(command.id)) {
        command.reject(createTurnCancelledError(command.options.abortSignal?.reason));
        return;
      }
      try {
        const result = await executeTargetContinuationCommand.call(this, {
          ...command.options,
          abortSignal: foregroundExecution.controller.signal,
        });
        command.resolve(result);
      } finally {
        this.runtimeCommandQueue.clearCancelPending(command.id);
      }
      return;
    }
    if (command.mode === "target-continuation-loop") {
      if (this.runtimeCommandQueue.consumeCancelPending(command.id)) {
        command.reject(createTurnCancelledError(command.options.abortSignal?.reason));
        return;
      }
      try {
        const result = await runActiveTargetContinuationLoop.call(this, {
          ...command.options,
          abortSignal: foregroundExecution.controller.signal,
          yieldBeforeFirstContinue: false,
        });
        command.resolve(result);
      } finally {
        this.runtimeCommandQueue.clearCancelPending(command.id);
      }
      return;
    }
    if (command.mode === "subagent-message") {
      this.logger?.debug("Subagent response command started", {
        ...traceContextToLogContext(command.traceContext),
        agentId: command.agentId,
        commandId: command.id,
        event: "subagent.response.command_started",
        messageLength: command.messageLength,
        module: "core.runtime",
        queueSize: this.runtimeCommandQueue.size(),
        responseId: command.responseId,
        summary: command.summary.slice(0, 200),
      });
      const messageId = await persistSubagentMessageCommand.call(this, command);
      await this.executeTurnCommand(command.text, undefined, {
        offPeakExecutionId: command.offPeakExecutionId,
        abortSignal: foregroundExecution.controller.signal,
        inputSource: "subagent_message",
        inputVisibility: "model-only",
        recordedInputMessageId: messageId,
        skipInputRecord: true,
        skipUserPromptSubmitHooks: true,
        traceContext: command.traceContext,
      });
      this.logger?.debug("Subagent response command completed", {
        ...traceContextToLogContext(command.traceContext),
        agentId: command.agentId,
        commandId: command.id,
        event: "subagent.response.command_completed",
        messageId,
        module: "core.runtime",
        queueSize: this.runtimeCommandQueue.size(),
        responseId: command.responseId,
      });
      return;
    }
    if (command.mode === "control-only-turn") {
      await runControlOnlyTurnCommand.call(this, command);
      return;
    }
  } catch (error) {
    if (
      command.mode === "prompt" ||
      command.mode === "target-continuation" ||
      command.mode === "target-continuation-loop"
    ) {
      command.reject(error);
      return;
    }
    this.logger?.warn("Runtime command failed", {
      ...traceContextToLogContext(command.traceContext),
      commandMode: command.mode,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "runtime_command.failed",
      module: "core.runtime",
    });
  } finally {
    finishForegroundExecution.call(this, foregroundExecution);
  }
}

async function runTaskNotificationBatch(
  this: AgentRuntimeInternal,
  commands: readonly TaskNotificationRuntimeCommand[],
): Promise<void> {
  const eligibleCommands = commands.filter(
    (command) =>
      !isStaleBranchRuntimeCommand(this, command) &&
      !shouldSuppressTaskNotificationRuntimeCommand.call(this, command),
  );
  const firstCommand = eligibleCommands[0];
  if (!firstCommand) return;

  // 合批轮和 goal 自动续跑属于同一因果链，不能在续跑时回退到首条通知的来源。
  const batchTraceContext = {
    ...firstCommand.traceContext,
    attributes: backgroundBatchTelemetryAttributes(
      eligibleCommands.map((command) => command.traceContext),
    ),
  };
  const foregroundExecution = beginForegroundExecution.call(this, firstCommand);
  const commandIds = eligibleCommands.map((command) => command.id);
  try {
    const persisted = await persistBackgroundTaskNotificationBatch.call(
      this,
      eligibleCommands as [TaskNotificationRuntimeCommand, ...TaskNotificationRuntimeCommand[]],
    );
    this.logger?.info?.("Background task notification batch started", {
      ...traceContextToLogContext(firstCommand.traceContext),
      batchSize: eligibleCommands.length,
      commandId: firstCommand.id,
      commandIds,
      event: "background_task.notification.batch_started",
      messageId: persisted.messageId,
      module: "core.runtime",
    });
    await this.executeTurnCommand(persisted.text, undefined, {
      offPeakExecutionId: firstCommand.offPeakExecutionId,
      // wake 缺 inputId，telemetry 借用了持久化 msg_*，与普通 main turn 分叉。
      // 每个独立 batch 使用同一 UUID v7 规则；持久化消息仍使用 recordedInputMessageId。
      inputId: uuidv7(),
      abortSignal: foregroundExecution.controller.signal,
      // 批次展示 metadata 只保留代表任务，composition 必须检查整批，不能被首个 Bash 任务遮蔽。
      backgroundSubagentResultConsumed: eligibleCommands.some(
        (command) => command.originMeta?.backgroundSource === "subagent",
      ),
      // 同一规则的 workflow 维度：run 的完成 / 提问通知在批里。
      workflowResultConsumed: eligibleCommands.some(
        (command) => command.originMeta?.backgroundSource === "workflow",
      ),
      ...(persisted.backgroundSource ? { backgroundSource: persisted.backgroundSource } : {}),
      inputSource: "background_task",
      inputVisibility: "model-only",
      // P2.6 验收修复第二轮（2026-11-18）：worker/subagent 通知轮带上发送方身份，
      // TurnStarted 据此下发 inputSender/Label/SessionId，投影落可见 mailbox 行；
      // bash/workflow 批没有 systemStatus（混合批不标），保持既有标题行渲染。
      ...(persisted.systemStatus ? { systemStatus: persisted.systemStatus } : {}),
      ...(persisted.originMeta ? { originMeta: persisted.originMeta } : {}),
      recordedInputMessageId: persisted.messageId,
      skipInputRecord: true,
      skipUserPromptSubmitHooks: true,
      traceContext: batchTraceContext,
    });
    await runPostCommandActiveTargetLoop.call(
      this,
      { ...firstCommand, traceContext: batchTraceContext },
      foregroundExecution.controller.signal,
    );
    this.logger?.info?.("Background task notification batch completed", {
      ...traceContextToLogContext(firstCommand.traceContext),
      batchSize: eligibleCommands.length,
      commandId: firstCommand.id,
      commandIds,
      event: "background_task.notification.batch_completed",
      messageId: persisted.messageId,
      module: "core.runtime",
    });
  } catch (error) {
    this.logger?.warn("Background task notification batch failed", {
      ...traceContextToLogContext(firstCommand.traceContext),
      batchSize: eligibleCommands.length,
      commandId: firstCommand.id,
      commandIds,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "background_task.notification.batch_failed",
      module: "core.runtime",
    });
  } finally {
    finishForegroundExecution.call(this, foregroundExecution);
  }
}

function beginForegroundExecution(
  this: AgentRuntimeInternal,
  command: RuntimeCommand,
): ActiveForegroundExecutionState {
  const controller = new AbortController();
  const parentAbortSignal = runtimeCommandAbortSignal(command);
  const abortFromParent = (): void => {
    controller.abort(parentAbortSignal?.reason);
  };
  if (parentAbortSignal?.aborted) {
    abortFromParent();
  } else {
    parentAbortSignal?.addEventListener("abort", abortFromParent, { once: true });
  }
  const state: ActiveForegroundExecutionState = {
    controller,
    disposeParentAbort: () => {
      parentAbortSignal?.removeEventListener("abort", abortFromParent);
    },
    foregroundExecutionId: String(command.id),
    preserveQueueAutoDrainOnCancel: false,
  };
  // 旧 Stop 只持有 bootstrap 外层 controller，而 goal verifier/continuation
  // 已经越过普通 turn 生命周期。取消域必须覆盖整条 runtime command，才能在两个阶段
  // 的交界处仍命中同一次前台执行。
  this.activeForegroundExecution = state;
  return state;
}

function finishForegroundExecution(
  this: AgentRuntimeInternal,
  state: ActiveForegroundExecutionState,
): void {
  state.disposeParentAbort();
  if (this.activeForegroundExecution === state) {
    this.activeForegroundExecution = undefined;
  }
}

function runtimeCommandAbortSignal(command: RuntimeCommand): AbortSignal | undefined {
  if (
    command.mode === "prompt" ||
    command.mode === "target-continuation" ||
    command.mode === "target-continuation-loop"
  ) {
    return command.options?.abortSignal;
  }
  return undefined;
}

export function stopActiveForegroundExecution(
  this: AgentRuntimeInternal,
  options: StopActiveForegroundExecutionOptions = {},
): StopActiveForegroundExecutionResult {
  const active = this.activeForegroundExecution;
  if (!active || active.controller.signal.aborted) {
    return { kind: "idle" };
  }
  if (
    options.expectedForegroundExecutionId !== undefined &&
    options.expectedForegroundExecutionId !== active.foregroundExecutionId
  ) {
    return {
      kind: "mismatch",
      activeForegroundExecutionId: active.foregroundExecutionId,
    };
  }
  // sendQueuedNow 的内部抢占过去与用户手动 Stop 共用同一种 cancelled，
  // turn catch 因而把 queueAutoDrain 关闭。把调用意图固定在当前 foreground
  // execution 上，保证超时后迟到的 TurnComplete 仍能保留原队列授权。
  active.preserveQueueAutoDrainOnCancel = options.preserveQueueAutoDrainOnCancel === true;
  active.controller.abort(new Error(options.reason ?? "foreground execution stopped"));
  return {
    kind: "stopped",
    foregroundExecutionId: active.foregroundExecutionId,
  };
}

export function getActiveForegroundExecutionId(this: AgentRuntimeInternal): string | undefined {
  return this.activeForegroundExecution?.foregroundExecutionId;
}

/**
 * 触发器 README 读盘缓存（2026-11-19 验收裁决，仅触发器投递轮调用）：
 * automationId 为 trg- 前缀（TRIGGER_ID_PREFIX，与上游 cron automation 的
 * automation-<uuid> 互斥）且尚未加载时，读工作区 `.robinrun/triggers/<id>/README.md`
 * 缓存到 runtime 级状态。README 缺失/读失败同样标记已加载——系统提示词 section 缺席
 * 即可，不能反复 IO，更不能阻断投递轮。
 *
 * 2026-11-25 分发器裁决：同一读盘时机顺带读注册表解析本会话 key 的有效路由策略，
 * 缓存 `triggerSessionRouting`（sticky，压缩后重建与后续轮共用）——分发职责段注入、
 * 分发器压缩提示词变体、轮级工具面收窄共用这一个判据。注册表缺失/损坏/条目缺席按
 * direct 收口（fail-safe 旧行为；伪删除条目的 active 过滤在引擎，此处只读策略）。
 *
 * **分发器会话 vs 处理会话的区分（2026-11-25 实测修正）**：dispatcher 触发器的处理
 * 会话与分发器会话同为 `trg-*` automationId，仅凭 automationId 无法区分——实测处理
 * 会话被误注入分发职责段并收窄工具面，模型自以为是分发器去调 RouteEvents（被引擎
 * 门控拒绝，"not a trigger-bound session"）。判据用投递来源区块：处理会话的
 * `<system-status>` 带 `viaDispatcherSessionId`（分发器路由投递专属，机制层溯源字段，
 * 分发器自己的投递不带）——带它 = 处理会话，**不设** dispatcher 语义（README 照常
 * 注入供背景理解，routing 保持 undefined 走普通处理路径）。fixed 档投递不带该字段，
 * fixed 说明段照常。
 */
async function ensureTriggerSessionReadme(
  this: AgentRuntimeInternal,
  automationId: string | undefined,
  viaDispatcherSessionId: string | undefined,
): Promise<void> {
  if (this.triggerSessionReadmeLoaded) return;
  if (automationId === undefined || !automationId.startsWith(TRIGGER_ID_PREFIX)) return;
  this.triggerSessionReadmeLoaded = true;
  try {
    const readme = await readFile(
      join(this.workspaceRoot, ".robinrun", "triggers", automationId, "README.md"),
      "utf8",
    );
    if (readme.trim().length > 0) this.triggerSessionReadme = readme;
  } catch {
    // README 缺失（创建时未写/被删）：无说明也可运行，事件自带 summary 语义。
  }
  // 处理会话（经分发器路由投递，`<system-status>` 带 viaDispatcherSessionId）：
  // routing 保持 undefined——它是订阅者的普通处理会话，分发职责段/压缩变体/工具面
  // 收窄全部不适用（README 已注入供背景理解）。
  if (viaDispatcherSessionId !== undefined) return;
  // 有效路由策略（sticky）：直连 key 取条目 routing，组 key 取组 routing。解析失败按
  // direct 收口——所有 dispatcher 行为（注入段/压缩变体/工具面收窄）都以该值为准，
  // direct/undefined 完全走旧路径，零行为漂移。
  try {
    const registryRaw = await readFile(
      join(this.workspaceRoot, ".robinrun", "triggers", "triggers.json"),
      "utf8",
    );
    const registry = triggerRegistrySchema.safeParse(JSON.parse(registryRaw));
    if (registry.success) {
      const entry = registry.data.triggers.find((trigger) => trigger.id === automationId);
      const routing: TriggerRouting = resolveRoutingForSessionKey(
        registry.data,
        sessionKeyForTrigger({ id: automationId, groupId: entry?.groupId ?? null }),
      );
      if (routing !== "direct") this.triggerSessionRouting = routing;
    }
  } catch {
    // 注册表缺失/损坏/校验失败：按 direct 收口（旧行为）。
  }
}

/**
 * 真实用户 prompt 判据（与 turn.ts 的 real_user 落章规则同源）：无来源标注、无
 * automation/off-peak 身份、非 model-only 的可见普通输入才算用户亲手介入。
 * coordinator（含 ContactAgent 管线）、trigger、goal 续跑等系统轮都不触发话语权切换。
 */
function isRealUserPromptCommand(command: PromptRuntimeCommand): boolean {
  const options = command.options;
  return (
    options?.systemStatus === undefined &&
    options?.inputSource === undefined &&
    options?.inputVisibility !== "model-only" &&
    options?.skipInputRecord !== true &&
    options?.automationId === undefined &&
    options?.offPeakTaskId === undefined
  );
}
