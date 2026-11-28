import {
  isSystemTriggerEntry,
  parseTriggerSessionKey,
  type TriggerEntry,
  type TriggerStatus,
} from "@robindone/shared";
import type { TriggerTaskPort } from "./contract.js";
import { appendAudit, mutateRegistry, type RegistryWritableState } from "./registry-io.js";

/**
 * 触发器生命周期服务面（2026-11-25 分发器裁决批次从 engine.ts 拆出，文件行数上限；
 * system-subscription / system-wakeup 同拆分模式）：UI/服务端的启停、伪删除与清空会话。
 * 对引擎状态的访问经 resolveState 回调（engine 闭包：workspaces.get ?? ensureWorkspace）；
 * 状态写回后的调度重建由 rebuildSchedules 回调承担。
 */

/** 引擎工作区状态最小投影（WorkspaceState 结构兼容 + 身份归属）。 */
export type LifecycleWorkspaceState = RegistryWritableState & {
  workspaceIdentity?: string;
};

export interface TriggerLifecycleDeps {
  log(message: string): void;
  resolveState(workspacePath: string): Promise<LifecycleWorkspaceState>;
  /** 状态机变更后的调度重建（engine 闭包：clearSchedules + 逐工作区 re-arm）。 */
  rebuildSchedules(): void;
  /** 清空会话端口（UI"清空会话"用；缺席时大声失败）。 */
  tasks?: TriggerTaskPort;
}

export async function setTriggerStatusForEngine(
  deps: TriggerLifecycleDeps,
  params: {
    workspacePath: string;
    triggerId: string;
    status: Exclude<TriggerStatus, "completed">;
  },
): Promise<TriggerEntry> {
  const state = await deps.resolveState(params.workspacePath);
  let result: TriggerEntry | undefined;
  await mutateRegistry(state, (registry) => {
    const entry = registry.triggers.find((candidate) => candidate.id === params.triggerId);
    if (entry === undefined) {
      throw new Error(`No trigger with id ${params.triggerId}`);
    }
    // 系统特权订阅（2026-11-24 平台级保证）：任何路径（UI/工具）都不可停用。
    if (isSystemTriggerEntry(entry)) {
      throw new Error(
        `Trigger ${params.triggerId} is a system subscription; it cannot be disabled`,
      );
    }
    entry.status = params.status;
    // 重新启用即修复确认：清零连续异常计数（与 ManageTriggers set_status 同一状态机）。
    if (params.status === "active") entry.consecutiveFailures = 0;
    entry.updatedAt = new Date().toISOString();
    result = entry;
  });
  if (result === undefined) {
    throw new Error(
      state.corrupt
        ? "Trigger registry is corrupt; fix it before changing trigger status"
        : `Failed to update trigger ${params.triggerId}`,
    );
  }
  void appendAudit(params.workspacePath, params.triggerId, {
    action: "set_status",
    status: params.status,
    actor: "ui",
  });
  deps.rebuildSchedules();
  return result;
}

export async function deleteTriggerForEngine(
  deps: TriggerLifecycleDeps,
  params: { workspacePath: string; triggerId: string },
): Promise<TriggerEntry> {
  const state = await deps.resolveState(params.workspacePath);
  let result: TriggerEntry | undefined;
  await mutateRegistry(state, (registry) => {
    const entry = registry.triggers.find((candidate) => candidate.id === params.triggerId);
    if (entry === undefined) {
      throw new Error(`No trigger with id ${params.triggerId}`);
    }
    // 系统特权订阅（2026-11-24 平台级保证）：任何路径（UI/工具）都不可删除；
    // 外部手改 deleted 的破坏由 ensureSystemSubscription 幂等重建兜底。
    if (isSystemTriggerEntry(entry)) {
      throw new Error(`Trigger ${params.triggerId} is a system subscription; it cannot be deleted`);
    }
    if (entry.deleted === true) {
      // 幂等：重复删除按首次结果收口。
      result = entry;
      return;
    }
    // 伪删除（2026-11-21 实测裁决，与会话/智能体一致）：条目保留、消费面全不可见。
    // 状态一并停用（未感知 deleted 的读者也不会再执行它）；组订阅解除保持
    // groupId ↔ memberTriggerIds 双向闭合。调度/常驻脚本随本方法触发的
    // rebuildSchedules 与下一次 pollTick reconcile 收敛。
    entry.deleted = true;
    entry.status = "deactivated";
    if (entry.groupId !== null) {
      const group = registry.groups.find((candidate) => candidate.id === entry.groupId);
      if (group !== undefined) {
        group.memberTriggerIds = group.memberTriggerIds.filter(
          (candidate) => candidate !== entry.id,
        );
        group.updatedAt = new Date().toISOString();
      }
      entry.groupId = null;
    }
    entry.updatedAt = new Date().toISOString();
    result = entry;
  });
  if (result === undefined) {
    throw new Error(
      state.corrupt
        ? "Trigger registry is corrupt; fix it before deleting triggers"
        : `Failed to delete trigger ${params.triggerId}`,
    );
  }
  void appendAudit(params.workspacePath, params.triggerId, {
    action: "delete",
    actor: "ui",
  });
  deps.log(`trigger ${params.triggerId} soft-deleted (registry entry retained)`);
  deps.rebuildSchedules();
  return result;
}

export async function resetTriggerSessionForEngine(
  deps: TriggerLifecycleDeps,
  params: { workspacePath: string; sessionKey: string },
): Promise<{ reset: boolean; taskId?: string }> {
  const state = await deps.resolveState(params.workspacePath);
  const taskId = state.sessionBindings[params.sessionKey];
  if (taskId === undefined) {
    // 无绑定 = 尚未触发过，幂等空转（UI 项也只在有绑定时出现，防御并发竞态）。
    return { reset: false };
  }
  const tasks = deps.tasks;
  if (!tasks) {
    throw new Error("trigger task port is not wired in this host");
  }
  // 清空 = 会话保留、内容归零、身份按当前订阅者重置；绑定不动，下次 fire 在
  // 同一会话继续。订阅者取注册表当前值（直连 = ownerAgentId；组 = subscriberAgentId），
  // 注册表条目缺席（极端时序）按 master 收口。
  const parsed = parseTriggerSessionKey(params.sessionKey);
  const subscriberAgentId =
    parsed?.kind === "trigger"
      ? (state.registry?.triggers.find((candidate) => candidate.id === parsed.triggerId)
          ?.ownerAgentId ?? "master")
      : parsed?.kind === "group"
        ? (state.registry?.groups.find((candidate) => candidate.id === parsed.groupId)
            ?.subscriberAgentId ?? "master")
        : "master";
  await tasks.clearTask({
    taskId,
    workspacePath: state.workspacePath,
    ...(state.workspaceIdentity !== undefined
      ? { workspaceIdentity: state.workspaceIdentity }
      : {}),
    subscriberAgentId,
  });
  // 审计只记直连触发器（组 key 无单一触发器目录）；组清空留引擎日志即可。
  if (parsed?.kind === "trigger") {
    void appendAudit(params.workspacePath, parsed.triggerId, {
      action: "reset_session",
      actor: "ui",
      taskId,
      subscriberAgentId,
    });
  }
  deps.log(
    `reset trigger session ${params.sessionKey} (cleared task ${taskId}, identity → ${subscriberAgentId})`,
  );
  return { reset: true, taskId };
}
