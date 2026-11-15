import type { RobinRunProjectEntry } from "@robinrun/shared";

/**
 * RobinRun 项目注册表（AppSettings.robinrunProjects）的纯函数操作集。
 *
 * 注册表职责（2026-11-15 项目列表导航裁决）：只服务启动编排——冷启动自动打开
 * 最近使用的项目、零项目首建页（RobinRunLauncher）。侧栏项目列表的权威数据
 * 仍是 Host 项目树（projectService.readTree），两者不互相推导。
 */

export function basenameOf(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/);
  return segments[segments.length - 1] || normalized;
}

export function sortRobinrunProjectsByRecency(
  list: RobinRunProjectEntry[],
): RobinRunProjectEntry[] {
  return [...list].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

/** 按 path 幂等 upsert：已注册则 bump lastOpenedAt（可选改名），否则追加新条目。 */
export function upsertRobinrunProjectEntry(
  list: RobinRunProjectEntry[],
  path: string,
  name?: string,
): RobinRunProjectEntry[] {
  const existing = list.find((entry) => entry.path === path);
  const now = Date.now();
  if (existing) {
    return list.map((entry) =>
      entry.id === existing.id
        ? { ...entry, lastOpenedAt: now, ...(name ? { name } : {}) }
        : entry,
    );
  }
  return [
    ...list,
    {
      id: crypto.randomUUID(),
      name: name ?? basenameOf(path),
      path,
      createdAt: now,
      lastOpenedAt: now,
    },
  ];
}
