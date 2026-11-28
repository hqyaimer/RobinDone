/* 系统订阅唤醒投递（2026-11-24 需求/审批/反馈面板；用户裁决：面板 = 数据面，主智能体 =
   处理方，订阅是两者唯一通道）。从 engine.ts 拆出（文件行数上限）：面板事件的唤醒按
   标准触发器会话模型投进 `trigger:<id>` 绑定会话——绑定解析/写回/sessions.json 持久化
   复用聚合器投递链同一套机制（触发器文件夹即面板事件的处理台账）；不经聚合器——串行
   与不合并由面板服务的唤醒队列保证（验收 #2），这里按来即投。绑定会话忙时依赖
   sendPrompt 的 automation 输入排队（同触发器忙语义），不做 hold。 */
import { makeTriggerSessionKey } from "@robindone/shared";
import type { TriggerDispatchPort } from "./contract.js";
import { resolveBatchTriggerFromRegistry } from "./event-aggregator.js";
import {
  parseRegistry,
  readRawRegistry,
  saveSessionBindings,
  type RegistryWritableState,
} from "./registry-io.js";

/** 唤醒投递所需的引擎工作区状态最小投影（engine.WorkspaceState 结构兼容 + 身份/项目归属）。 */
export type WakeupWorkspaceState = RegistryWritableState & {
  workspaceIdentity?: string;
  projectId?: string;
};

export interface SystemSubscriptionWakeupDeps {
  /** 按需取工作区状态（引擎闭包：workspaces.get ?? ensureWorkspace）。 */
  resolveState(
    workspacePath: string,
    workspaceIdentity: string | undefined,
  ): Promise<WakeupWorkspaceState>;
  dispatch: TriggerDispatchPort;
  log(message: string): void;
}

export async function dispatchSystemSubscriptionWakeup(
  deps: SystemSubscriptionWakeupDeps,
  params: {
    workspacePath: string;
    workspaceIdentity?: string;
    triggerId: string;
    prompt: string;
  },
): Promise<{ taskId: string }> {
  const state = await deps.resolveState(params.workspacePath, params.workspaceIdentity);
  // 系统订阅恒为直连条目（播种强制 groupId=null），key 即 trigger:<id>。
  const key = makeTriggerSessionKey(params.triggerId);
  let trigger =
    state.registry === null ? undefined : resolveBatchTriggerFromRegistry(state.registry, key);
  if (trigger === undefined) {
    // 内存注册表可能正被轮询的旧盘读回退（播种与 pollTick 的竞态窗口，2026-11-24
    // 实测：播种后首轮 poll 把空注册表覆盖回内存）。磁盘是权威——重读一次再判，
    // 仍缺失才拒绝（真被外部破坏且播种失败，不凭空造会话）。
    const raw = await readRawRegistry(state.workspacePath);
    if (raw !== state.raw) {
      const registry = parseRegistry(raw);
      state.raw = raw;
      state.registry = registry;
      state.corrupt = raw.trim().length > 0 && registry === null;
      trigger =
        state.registry === null ? undefined : resolveBatchTriggerFromRegistry(state.registry, key);
    }
  }
  if (trigger === undefined) {
    // 播种先行（面板服务 ensureWorkspacePanel 先 ensureSystemSubscription 再泵队列，
    // mutateRegistry 即时更新内存注册表）；走到这里说明订阅缺失，拒绝投递而不是
    // 凭空造会话。
    throw new Error(
      `System subscription ${params.triggerId} is not present in the registry; cannot dispatch wakeup`,
    );
  }
  const boundTaskId = state.sessionBindings[key];
  const { taskId } = await deps.dispatch.dispatchTriggerEvent({
    workspacePath: state.workspacePath,
    ...(state.workspaceIdentity !== undefined
      ? { workspaceIdentity: state.workspaceIdentity }
      : {}),
    ...(state.projectId !== undefined ? { projectId: state.projectId } : {}),
    sessionKey: key,
    triggerId: trigger.id,
    triggerName: trigger.name,
    subscriberAgentId: trigger.ownerAgentId,
    // 系统订阅恒走 direct（面板裁决：面板 = 数据面，主智能体 = 处理方，不经分发器）。
    routing: "direct",
    ...(boundTaskId !== undefined ? { existingTaskId: boundTaskId } : {}),
    events: [],
    promptOverride: params.prompt,
  });
  if (state.sessionBindings[key] !== taskId) {
    state.sessionBindings[key] = taskId;
    await saveSessionBindings(state);
  }
  return { taskId };
}
