import type { DatabaseSync } from "node:sqlite";
import {
  CRON_DEFAULT_GROUP_ID,
  OFF_PEAK_DEFAULT_GROUP_ID,
  MAIN_AGENT_GROUP_PREFIX,
} from "@robindone/shared";

// 冻结 0007 的只增 SQL；后续结构调整必须追加迁移，不能跟随运行仓库修改 checksum。
// project_id 可空、无默认值：降级兼容（旧代码不认识该列，SELECT * 不受影响）。
// 数据回填不放这里：迁移应用时 projects/project_roots 可能尚未建表（初始化顺序见
// TaskIndexRepo.initialize），回填走启动期幂等对账 backfillTaskGroupProjectBinding。
export const TASK_GROUP_PROJECT_BINDING_SQL = `
ALTER TABLE task_groups ADD COLUMN project_id TEXT;`;

/**
 * 0007 数据回填（幂等启动对账，TaskIndexRepo.initialize 在项目 schema 之后调用）：
 * 智能体（task_groups）绑定其所属项目。
 *
 * 推导规则（只增不覆盖，匹配不上的保持 NULL，渲染时归入根层"未绑定"区域）：
 * - 组内成员的 workspace_path 在未删除项目的 project_roots 中全部命中同一个项目 → 绑定该项目；
 * - 系统分组（cron / 闲时）与主智能体组（前缀识别）是跨项目全局组，永不回填；
 * - 无成员、跨项目、或同一目录属于多个项目的组存在歧义 → 保持 NULL，不做猜测。
 */
export function backfillTaskGroupProjectBinding(db: DatabaseSync): void {
  const hasProjectSchema =
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_roots'").get() &&
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get();
  if (!hasProjectSchema) return;
  const groups = db.prepare("SELECT group_id FROM task_groups WHERE project_id IS NULL").all() as {
    group_id: string;
  }[];
  const resolve = db.prepare(`
    SELECT DISTINCT r.project_id AS projectId
    FROM task_group_members m
    JOIN project_roots r ON r.root_path = m.workspace_path
    JOIN projects p ON p.project_id = r.project_id AND p.deleted = 0
    WHERE m.group_id = ?
  `);
  const update = db.prepare("UPDATE task_groups SET project_id=? WHERE group_id=?");
  for (const { group_id: groupId } of groups) {
    // 系统组是全局组织态；主智能体组由自举写入，回填不碰。
    if (
      groupId === CRON_DEFAULT_GROUP_ID ||
      groupId === OFF_PEAK_DEFAULT_GROUP_ID ||
      groupId.startsWith(MAIN_AGENT_GROUP_PREFIX)
    )
      continue;
    const projects = resolve.all(groupId) as { projectId: string }[];
    const [only] = projects;
    if (only && projects.length === 1) update.run(only.projectId, groupId);
  }
}
