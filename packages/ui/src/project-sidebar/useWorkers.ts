import { useCallback, useEffect, useState } from "react";
import { workerRegistryFileName, workerRegistrySchema } from "@robindone/shared";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

// 订阅句柄只用到 dispose；不引入 @robindone/rpc 的类型（project-sidebar 模块未声明 rpc 依赖）。
interface WorkerWatchSubscription {
  dispose(): void;
}

/** 编制目录缺失时的兜底重试间隔（2026-11-21 起目录由项目保存/恢复时预创建，正常路径不再用到）。 */
const WORKERS_WATCH_RETRY_MS = 3000;

export interface WorkerRosterEntry {
  id: string;
  name: string;
  description: string;
}

/**
 * worker 编制只读投影（2026-11-15 裁决）：读取项目工作区的
 * `.robindone/agents/workers.json`（编制唯一事实源，由主智能体经 ManageWorkers 维护）。
 * 侧栏只渲染；新建/改名/停用的入口全部收敛到主智能体，UI 无写路径。
 *
 * remote 项目当前宿主读不到其工作区文件（P2.1：进入智能体页不切工作区），读取失败
 * 按空编制处理，不报错——worker 区块整体不渲染。
 */
export function useWorkers(projectRootPath: string | null): {
  workers: WorkerRosterEntry[];
  /** 注册表可读（含"项目还没有 worker"的空表）。false = 当前宿主读不到该工作区。 */
  available: boolean;
} {
  const { fileService, fileWatcherService } = useBaseWorkspaceServices();
  const [workers, setWorkers] = useState<WorkerRosterEntry[]>([]);
  const [available, setAvailable] = useState(false);

  const registryPath = projectRootPath
    ? `${projectRootPath.replace(/[\\/]+$/, "")}/.robindone/agents/${workerRegistryFileName}`
    : null;
  const agentsDirPath = projectRootPath
    ? `${projectRootPath.replace(/[\\/]+$/, "")}/.robindone/agents`
    : null;

  const load = useCallback(async () => {
    if (!registryPath) return;
    try {
      const read = await fileService.readTextFile({ path: registryPath });
      const parsed = workerRegistrySchema.safeParse(JSON.parse(read.content) as unknown);
      if (!parsed.success) {
        logger.warn("[workers] 注册表校验失败，按空编制渲染", {
          path: registryPath,
          issues: parsed.error.issues.map((issue) => issue.message),
        });
        setWorkers([]);
        setAvailable(false);
        return;
      }
      setWorkers(
        parsed.data.workers
          .filter((worker) => worker.status === "active")
          .map((worker) => ({
            id: worker.id,
            name: worker.name,
            description: worker.description,
          })),
      );
      setAvailable(true);
    } catch (error) {
      // 缺失 = 项目还没有编制（合法空态）；其他读失败（如 remote 工作区）同样静默为空。
      logger.debug("[workers] 读取 worker 注册表失败，按空编制渲染", {
        path: registryPath,
        error: String(error),
      });
      setWorkers([]);
      setAvailable(false);
    }
  }, [fileService, registryPath]);

  useEffect(() => {
    void load();
  }, [load]);

  // 编制由主智能体在会话里维护（ManageWorkers 写 workers.json），监听变化实时投影。
  // Bug 根因（2026-11-16）：此前监听 workers.json 文件本身——ManageWorkers 走 tmp+rename
  // 原子写（换 inode），fileWatcherService 在 rename 后检测到 identity 失配会发一次事件
  // 然后【永久关闭】watcher；首次创建时文件不存在，watch 直接 reject 且从不重试。两侧
  // 叠加导致名册变化只有重进项目页（重挂载）才可见。改为监听 `.robindone/agents` 目录：
  // 目录 inode 稳定，注册表原子换名只触发事件不毁 watcher；非递归监听下 worker 自己往
  // <id>/tmp、knowledge 深处写文件不会触发（只有直接子项增删触发），噪音天然受限。
  // 目录尚未创建（项目还没有编制）时 watch 会 reject，用定时重试覆盖首次创建场景。
  // 2026-11-21 起 `.robindone/agents` 改由项目保存/恢复时预创建（packages/services project
  // 的 ensureWorkerRosterDirectories），新建项目挂载即成功、不再产生失败 watch；此重试
  // 保留为兜底，仅覆盖早于该修复注册、尚未重新触碰（重开/置顶/改根）的存量项目。
  // 首建竞态修复（2026-11-18 验收）：watch 只报告 attach 之后的变化，不回放已存在的
  // 文件——重试 attach 若落在 ManageWorkers 写完目录与注册表之后（约 1-2s 写入窗口，
  // 3s 重试周期下约半概率），此后再无事件，load() 永远不再执行，名册停在挂载时的空态；
  // 空名册让"停用即隐藏"过滤器把已准入会话的 worker 组整段藏掉（侧栏看不到任何 worker）。
  // attach 成功即补读一次：正常路径与初始 load() 幂等重复（同一文件读两次，状态相同
  // 不触发重渲染），竞态路径则把错过首建的名册取回。
  useEffect(() => {
    if (!agentsDirPath) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let watcherId: string | null = null;
    const disposables: WorkerWatchSubscription[] = [];
    const watch = () => {
      if (cancelled) return;
      fileWatcherService
        .watch({ path: agentsDirPath })
        .then(({ id }) => {
          if (cancelled) {
            void fileWatcherService.unwatch({ id });
            return;
          }
          watcherId = id;
          const sub = fileWatcherService.onDynamicChange(id)(() => {
            void load();
          });
          disposables.push(sub);
          void load();
        })
        .catch((error) => {
          if (cancelled) return;
          logger.debug("[workers] 监听编制目录失败，稍后重试（不影响读取）", {
            path: agentsDirPath,
            error: String(error),
          });
          retryTimer = setTimeout(watch, WORKERS_WATCH_RETRY_MS);
        });
    };
    watch();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      for (const disposable of disposables) disposable.dispose();
      if (watcherId) void fileWatcherService.unwatch({ id: watcherId });
    };
  }, [fileWatcherService, agentsDirPath, load]);

  return { workers, available };
}
