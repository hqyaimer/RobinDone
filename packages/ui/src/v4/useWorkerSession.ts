// worker 会话判定（2026-11-16 会话通道隔离裁决的 UI 端，P2.5 改版）：
// 主智能体派发 worker 产生的 worker_child 会话对用户**可交互**（P2.5 用户协同：可打断/
// 输入，延迟返回由 CLI 路由层处理）。hook 现在只提供两个事实：
// - isWorkerSession：worker_child 判定（live summary 带 worker 身份，冷种子/resume 带
//   workerChild kind 标记，两者任一命中）。用于禁用 retry/fork/行内编辑（这些动作会
//   绕过父 port 路由，v1 不开放）。
// - running：sessions-index phase 的运行态（实时 spinner 同源），供 Stop 按钮在外部
//   运行（父 runtime 驱动）时也可用——子会话自己的 control.canStop 看不到那类运行。
// 订阅复用 sessionsIndexRegistry 的引用计数共享 store（effect 内 acquire/release，
// 不在渲染期取）；重渲染范围 = 调用方组件（帧到达低频：conflated 列表事件，不含逐
// token 流式），布尔结果稳定不放大。
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import {
  acquireSessionsIndex,
  releaseSessionsIndex,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";
import type { SessionsIndexStore } from "@/v4/sessionsIndexStore.js";

export interface WorkerSessionFacts {
  /** 当前会话是否为 worker 会话（worker_child）。 */
  isWorkerSession: boolean;
  /** sessions-index 判定的运行态（含父 runtime 驱动的外部运行）。 */
  running: boolean;
  /**
   * P2.6 群聊渲染：worker 显示名（sessions-index summary.worker.workerName）。
   * turn 组发送者标签「工作者-<名>」用；非 worker 会话为 null。
   */
  workerDisplayName: string | null;
  /**
   * P2.6 验收修复第四轮（2026-11-18）：worker 会话本体 agent 的 wkr-id。
   * 会话区 agent 块据它走 workerGroupId → 任务组色取块底/头像色；非 worker 会话为 null。
   */
  workerId: string | null;
}

export function useWorkerSession(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  /** CLI session id；null = 草稿（必非 worker 会话）。 */
  sessionId: string | null;
}): WorkerSessionFacts {
  const { workspacePath, workspaceIdentity, sessionId } = params;
  const baseServices = useBaseWorkspaceServices();
  const agentService = baseServices.robindoneAgentService;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;

  // acquire/release 与 useWorkspaceSessionsIndexItems 同款引用计数生命周期；
  // scope/agentService 变化（远程换代）走 registry 的换代语义，cleanup 先于下一次 acquire。
  const [store, setStore] = useState<SessionsIndexStore | null>(null);
  useEffect(() => {
    if (!agentService) {
      setStore(null);
      return;
    }
    const scope: SessionsIndexScope = {
      workspaceKey,
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    };
    const acquired = acquireSessionsIndex(scope, agentService);
    setStore(acquired);
    return () => releaseSessionsIndex(scope, acquired);
  }, [workspaceKey, workspacePath, workspaceIdentity, agentService]);

  const subscribe = useMemo(
    () => (listener: () => void) => store?.subscribe(listener) ?? (() => {}),
    [store],
  );
  const getSnapshot = useMemo(() => {
    if (!store || !sessionId) return () => "none" as const;
    return () => {
      const summary = store.getState().sessions.get(sessionId);
      if (!summary || !(summary.workerChild || summary.worker)) return "none" as const;
      return summary.phase === "running" ? ("running" as const) : ("idle" as const);
    };
  }, [store, sessionId]);
  const verdict = useSyncExternalStore(subscribe, getSnapshot, () => "none" as const);

  // 显示名单独订阅：workerName 变化不影响 isWorkerSession/running，但 turn 组标签要跟着换。
  const displayNameSnapshot = useMemo(() => {
    if (!store || !sessionId) return () => null;
    return () => {
      const summary = store.getState().sessions.get(sessionId);
      const name = summary?.worker?.workerName?.trim();
      return name && name.length > 0 ? name : null;
    };
  }, [store, sessionId]);
  const workerDisplayName = useSyncExternalStore(
    subscribe,
    displayNameSnapshot,
    () => null as string | null,
  );

  // wkr-id 与显示名同源（summary.worker）；agent 块取组色用，缺席（非 worker 会话）为 null。
  const workerIdSnapshot = useMemo(() => {
    if (!store || !sessionId) return () => null;
    return () => store.getState().sessions.get(sessionId)?.worker?.workerId ?? null;
  }, [store, sessionId]);
  const workerId = useSyncExternalStore(subscribe, workerIdSnapshot, () => null as string | null);

  return {
    isWorkerSession: verdict !== "none",
    running: verdict === "running",
    workerDisplayName,
    workerId,
  };
}
