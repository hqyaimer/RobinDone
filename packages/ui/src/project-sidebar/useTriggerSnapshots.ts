import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  makeTriggerGroupSessionKey,
  makeTriggerSessionKey,
  type TriggerEntry,
  type TriggerGroupEntry,
  type TriggerProfileEntry,
  type TriggerStatus,
} from "@robinrun/shared";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

/**
 * 触发器快照的本地结构镜像（ui-implementation-import 纪律：UI 不 import services
 * 实现包，形状对齐 packages/services/src/trigger-engine/contract.ts 的
 * TriggerRuntimeView；服务实例经 accessor 的可选属性取，类型由 accessor 推断）。
 */
interface TriggerRuntimeView {
  triggers: TriggerEntry[];
  groups: TriggerGroupEntry[];
  profiles: TriggerProfileEntry[];
  sessionBindings: Record<string, string>;
  webhookBaseUrl?: string;
}

/**
 * 主智能体的订阅者身份（shared 词表裁决：ownerAgentId/subscriberAgentId 用
 * "master"；worker 用 wkr-id）。触发器系统各侧（工具/引擎/UI）一致使用该字面量。
 */
export const TRIGGER_MASTER_OWNER_ID = "master";

/** 快照兜底空态：服务缺席或读取失败时整段触发器 UI 不渲染。 */
const EMPTY_VIEW: TriggerRuntimeView = {
  triggers: [],
  groups: [],
  profiles: [],
  sessionBindings: {},
};

/**
 * 轮询兜底间隔：引擎事件（fire/熔断）本应经 `state:triggers` 广播实时到达，
 * 轮询只覆盖广播丢失与冷启动时序（先挂 UI 后注册服务）场景。
 */
const TRIGGERS_POLL_INTERVAL_MS = 30_000;

export interface TriggerSidebarEntry {
  kind: "trigger" | "group";
  /** 直连触发器 id 或组 id（同 trg-/trggrp- 纪律）。 */
  id: string;
  name: string;
  /** 组条目为成员数（副标），直连触发器为 undefined。 */
  memberCount?: number;
  status: TriggerStatus;
  /** 最近触发时间（ISO）；组取成员最大值，从未触发为 undefined。 */
  lastFireAt?: string;
  /** 该条目绑定的会话 key（shared 路由规则：trigger:<id> / trigger-group:<gid>）。 */
  sessionKey: string;
  /** 组条目的成员触发器 id 列表（组级启停批量作用），直连为 undefined。 */
  memberTriggerIds?: string[];
  /**
   * 组条目：成员状态列表（组级启停按成员各自状态精确作用），直连为 undefined。
   * 与 memberTriggerIds 按下标一一对应；缺席成员（伪删除残留的悬挂 id）为 undefined。
   */
  memberStatuses?: Array<TriggerStatus | undefined>;
  /**
   * 直连 webhook 触发器的路由配置（2026-11-20 地址展示）：完整地址 =
   * `${webhookBaseUrl}/${path}?token=${token}`。组条目不带（成员各自拼）。
   */
  webhook?: { path: string; token: string };
}

/**
 * 触发器运行时快照（2026-11-19 触发器系统 UI 裁决，docs/trigger-system.md「UI 规格」节）。
 *
 * 数据源是 host 常驻触发器引擎的只读投影（getSnapshot）；刷新走三路合并：
 * 挂载/工作区切换主动拉取、`state:triggers` 广播（熔断等引擎事件）即时刷新、
 * 30s 轮询兜底。启停经 setTriggerStatus（与 ManageTriggers set_status 同一状态机）。
 */
export function useTriggerSnapshots(workspacePath: string | null): {
  snapshot: TriggerRuntimeView;
  error: string | null;
  available: boolean;
  refresh: () => Promise<void>;
  setTriggerStatus: (
    triggerId: string,
    status: Exclude<TriggerStatus, "completed">,
  ) => Promise<void>;
  deleteTrigger: (triggerId: string) => Promise<void>;
  resetTriggerSession: (sessionKey: string) => Promise<void>;
} {
  const services = useBaseWorkspaceServices();
  // accessor 已声明可选的 triggerEngineService（desktop host 注册；远端/旧 wire 缺席），
  // 属性缺席时 available=false，触发器文件夹整体隐藏，不视为错误。
  const service = useMemo(() => services.triggerEngineService, [services]);
  const [snapshot, setSnapshot] = useState<TriggerRuntimeView>(EMPTY_VIEW);
  const [error, setError] = useState<string | null>(null);
  const serial = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++serial.current;
    if (!service || !workspacePath) {
      setSnapshot(EMPTY_VIEW);
      return;
    }
    try {
      const next = await service.getSnapshot({ workspacePath });
      if (request === serial.current) {
        setSnapshot(next);
        setError(null);
      }
    } catch (cause) {
      if (request === serial.current) {
        setError(String(cause));
        logger.error("[triggers] 读取触发器快照失败", cause);
      }
    }
  }, [service, workspacePath]);
  useEffect(() => {
    void refresh();
    const subscription = services.broadcastService.onMessage((event) => {
      if (event.channel === "state:triggers") void refresh();
    });
    const poll = window.setInterval(() => {
      void refresh();
    }, TRIGGERS_POLL_INTERVAL_MS);
    return () => {
      serial.current++;
      subscription.dispose();
      window.clearInterval(poll);
    };
  }, [services.broadcastService, refresh]);
  const setTriggerStatus = useCallback(
    // completed 是引擎写入的终态，UI 启停只发 active/deactivated/error-paused
    // （completed 条目的"重新启用"也是发 active，见 agent-trigger-section）。
    async (triggerId: string, status: Exclude<TriggerStatus, "completed">) => {
      if (!service || !workspacePath) throw new Error("trigger-engine.service-unavailable");
      // 写注册表后引擎轮询拾取；UI 不等引擎确认，快照以注册表回包刷新（同 ManageWorkers 模式）。
      await service.setTriggerStatus({ workspacePath, triggerId, status });
      await refresh();
    },
    [service, workspacePath, refresh],
  );
  // 伪删除（2026-11-21 实测裁决，与会话/智能体一致）：引擎写注册表 deleted=true 并解除
  // 组订阅，快照刷新后条目从触发器文件夹消失（数据保留，不可逆）；删除的是当前打开
  // 会话时由调用方负责收口（同清空会话的视图关闭逻辑）。
  const deleteTrigger = useCallback(
    async (triggerId: string) => {
      if (!service || !workspacePath) throw new Error("trigger-engine.service-unavailable");
      await service.deleteTrigger({ workspacePath, triggerId });
      await refresh();
    },
    [service, workspacePath, refresh],
  );
  // 清空会话（2026-11-20）：删绑定会话 + 解绑，快照刷新后触发器行回到"未触发过"态；
  // 下次 fire 由引擎按当前订阅者身份重建新会话（旧会话的历史/身份不沾染）。
  const resetTriggerSession = useCallback(
    async (sessionKey: string) => {
      if (!service || !workspacePath) throw new Error("trigger-engine.service-unavailable");
      await service.resetTriggerSession({ workspacePath, sessionKey });
      await refresh();
    },
    [service, workspacePath, refresh],
  );
  return useMemo(
    () => ({
      snapshot,
      error,
      available: Boolean(service),
      refresh,
      setTriggerStatus,
      deleteTrigger,
      resetTriggerSession,
    }),
    [snapshot, error, service, refresh, setTriggerStatus, deleteTrigger, resetTriggerSession],
  );
}

/**
 * 按订阅智能体归组触发器条目（归属裁决：直连看 ownerAgentId，组看 subscriberAgentId）。
 * 返回 ownerAgentId（master 或 wkr-id）→ 条目列表；无订阅条目的智能体不出现在 Map 中，
 * 侧栏据此隐藏其触发器文件夹。
 */
export function groupTriggerEntriesByOwner(
  snapshot: TriggerRuntimeView,
): Map<string, TriggerSidebarEntry[]> {
  const byOwner = new Map<string, TriggerSidebarEntry[]>();
  const push = (owner: string, entry: TriggerSidebarEntry) => {
    const list = byOwner.get(owner) ?? [];
    list.push(entry);
    byOwner.set(owner, list);
  };
  const lastFireMax = (memberIds: string[]): string | undefined => {
    let max: string | undefined;
    for (const id of memberIds) {
      const fireAt = snapshot.triggers.find((trigger) => trigger.id === id)?.lastFireAt;
      if (fireAt && (max === undefined || fireAt > max)) max = fireAt;
    }
    return max;
  };
  for (const trigger of snapshot.triggers) {
    // 订阅上下文互斥（裁决 1）：groupId=null 才是直连订阅；组成员行由组条目承载，不重复出现。
    if (trigger.groupId !== null) continue;
    push(trigger.ownerAgentId, {
      kind: "trigger",
      id: trigger.id,
      name: trigger.name,
      status: trigger.status,
      ...(trigger.lastFireAt !== undefined ? { lastFireAt: trigger.lastFireAt } : {}),
      sessionKey: makeTriggerSessionKey(trigger.id),
      ...(trigger.config.kind === "webhook"
        ? { webhook: { path: trigger.config.path, token: trigger.config.token } }
        : {}),
    });
  }
  // 修复（2026-11-23）：成员状态改为按 id 查表构造——此前 memberStatuses 来自
  // snapshot.triggers 按 groupId 过滤的数组序，与 memberTriggerIds（组注册表序）仅在
  // 不曾增删成员时天然一致；update_group 移除再回添成员（或调整顺序）后两序错位，
  // 组级启停的 idsWith 按下标配对会把状态作用到错误的触发器上。按 id 查表让对齐由
  // 构造保证；缺席成员（伪删除后投影剔除的悬挂 id）状态为 undefined，聚合与启停跳过。
  const statusById = new Map(snapshot.triggers.map((trigger) => [trigger.id, trigger.status]));
  for (const group of snapshot.groups) {
    const memberStatuses = group.memberTriggerIds.map((id) => statusById.get(id));
    const lastFireAt = lastFireMax(group.memberTriggerIds);
    push(group.subscriberAgentId, {
      kind: "group",
      id: group.id,
      name: group.name,
      memberCount: group.memberTriggerIds.length,
      status: aggregateTriggerStatus(memberStatuses),
      ...(lastFireAt !== undefined ? { lastFireAt } : {}),
      sessionKey: makeTriggerGroupSessionKey(group.id),
      memberTriggerIds: group.memberTriggerIds,
      memberStatuses,
    });
  }
  return byOwner;
}

/** 组条目状态投影：任一成员熔断即最醒目；仍有 active 成员则视为启用；completed 次之；全停用才显示停用。undefined（缺席成员）跳过。 */
function aggregateTriggerStatus(statuses: Array<TriggerStatus | undefined>): TriggerStatus {
  const live = statuses.filter((status) => status !== undefined);
  if (live.includes("error-paused")) return "error-paused";
  if (live.includes("active")) return "active";
  // completed（2026-11-21 常驻脚本终态）在组里投影为 completed，行操作给"重新启用"。
  if (live.length > 0 && live.every((status) => status === "completed")) {
    return "completed";
  }
  return "deactivated";
}
