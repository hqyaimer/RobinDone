import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OpsPanelEntry, OpsPanelView, ProgressEntry } from "@robindone/shared";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

/**
 * 运营面板（2026-11-24 需求/审批/反馈 + 2026-11-25 进度账本）的数据 hook。数据源是
 * host 面板服务的只读投影（getPanelView + getProgressView，可见性过滤在服务层）；
 * 刷新走三路合并：挂载/工作区切换主动拉取、`state:ops-panel` 广播（条目/队列/进度
 * 变更）即时刷新、30s 轮询兜底（useTriggerSnapshots 模板）。写动作（批审批）直连
 * 服务；刷新以广播回包为准。进度对用户纯只读（master 经工具维护，spec §5）。
 */

const OPS_PANEL_POLL_INTERVAL_MS = 30_000;

const EMPTY_VIEW: OpsPanelView = {
  entries: [],
  queue: { inFlightId: null, pendingIds: [] },
};

const EMPTY_PROGRESS: ProgressEntry[] = [];

export interface OpsPanelActions {
  /** 用户批准/驳回审批（决定后经串行队列唤醒 master 执行）。 */
  decideApproval: (
    entryId: string,
    decision: "approved" | "rejected",
    note?: string,
  ) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useOpsPanelView(workspacePath: string | null): {
  view: OpsPanelView;
  progress: ProgressEntry[];
  error: string | null;
  available: boolean;
  refresh: () => Promise<void>;
  actions: OpsPanelActions;
} {
  const services = useBaseWorkspaceServices();
  const service = useMemo(() => services.opsPanelService, [services]);
  const [view, setView] = useState<OpsPanelView>(EMPTY_VIEW);
  const [progress, setProgress] = useState<ProgressEntry[]>(EMPTY_PROGRESS);
  const [error, setError] = useState<string | null>(null);
  const serial = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++serial.current;
    if (!service || !workspacePath) {
      setView(EMPTY_VIEW);
      setProgress(EMPTY_PROGRESS);
      return;
    }
    try {
      const [nextView, nextProgress] = await Promise.all([
        service.getPanelView({ workspacePath, actor: { role: "user" } }),
        service.getProgressView({ workspacePath, actor: { role: "user" } }),
      ]);
      if (request === serial.current) {
        setView(nextView);
        setProgress(nextProgress.entries);
        setError(null);
      }
    } catch (cause) {
      if (request === serial.current) {
        setError(String(cause));
        logger.error("[ops-panel] 读取面板视图失败", cause);
      }
    }
  }, [service, workspacePath]);
  useEffect(() => {
    void refresh();
    const subscription = services.broadcastService.onMessage((event) => {
      if (event.channel === "state:ops-panel") void refresh();
    });
    const poll = window.setInterval(() => {
      void refresh();
    }, OPS_PANEL_POLL_INTERVAL_MS);
    return () => {
      serial.current++;
      subscription.dispose();
      window.clearInterval(poll);
    };
  }, [services.broadcastService, refresh]);
  // 创建入口已退役（2026-11-24 用户裁决"对话代录"）：用户经对话向 master 转述需求/
  // 反馈，由 master 落账；面板只剩读（三路合并刷新）与审批决策两个用户动作。
  const actions = useMemo<OpsPanelActions>(
    () => ({
      decideApproval: async (entryId, decision, note) => {
        if (!service || !workspacePath) throw new Error("ops-panel.service-unavailable");
        await service.decideApproval({
          workspacePath,
          entryId,
          decision,
          ...(note !== undefined && note.length > 0 ? { note } : {}),
          actor: { role: "user" },
        });
        await refresh();
      },
      refresh,
    }),
    [service, workspacePath, refresh],
  );
  return useMemo(
    () => ({ view, progress, error, available: Boolean(service), refresh, actions }),
    [view, progress, error, service, refresh, actions],
  );
}

/** 待处理队列计数（in-flight + pending），面板顶部队列条展示用。 */
export function opsPanelQueueCount(view: OpsPanelView): number {
  return (view.queue.inFlightId !== null ? 1 : 0) + view.queue.pendingIds.length;
}

/** 按 kind 分组条目（三个列表 tab 的数据源）。 */
export function groupOpsPanelEntries(
  entries: OpsPanelEntry[],
): Record<"requirement" | "approval" | "feedback", OpsPanelEntry[]> {
  const grouped: Record<"requirement" | "approval" | "feedback", OpsPanelEntry[]> = {
    requirement: [],
    approval: [],
    feedback: [],
  };
  for (const entry of entries) {
    grouped[entry.kind].push(entry);
  }
  return grouped;
}
