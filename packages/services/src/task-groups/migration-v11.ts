import type { DatabaseSync } from "node:sqlite";

// 冻结 0011 的只增语义（2026-11-27 RobinRun→RobinDone 改名，specs/rename-robindone-migration.md §3.2）；
// 后续结构调整必须追加迁移，不能跟随运行仓库修改 checksum。
//
// 确定性分组 id 前缀改写：`robinrun-main-agent-`/`robinrun-worker-`（派生前缀，常量已随 sweep
// 换新名）与两个系统组常量 id（cron/off-peak）。纯 UPDATE，改写后不再命中 LIKE，天然幂等；
// 同一迁移事务内执行，失败由迁移框架回滚并走 backup 恢复。
// 范围说明：task_group_admissions 无 group_id 列，不在范围；task_group_view_node_orders 只改
// group 型节点 key（task 型 key 是 JSON([workspaceKey,taskId])，首字符 '[' 不会被前缀 LIKE 命中）。
// 数据回填不放这里：迁移应用时部分表可能尚未建立（0007 同教训），自举对账在 TaskIndexRepo
// initialize 中进行——迁移先跑、自举后跑，新前缀自举 INSERT OR IGNORE 命中已改写行。
export const BRAND_GROUP_PREFIX_RENAME_CHECKSUM_INPUT = "brand-group-prefix-rename-v1";

const LEGACY_PREFIX = "robinrun-";
const NEW_PREFIX = "robindone-";

export function renameBrandGroupPrefixes(db: DatabaseSync): void {
  const statements = [
    // 主智能体组 / worker 组 / cron、off-peak 系统组常量 id
    "UPDATE task_groups SET group_id = ? || substr(group_id, ?) WHERE group_id LIKE ?",
    // 成员表的外键引用同步
    "UPDATE task_group_members SET group_id = ? || substr(group_id, ?) WHERE group_id LIKE ?",
    // 侧栏视图节点排序：仅 group 型节点 key 是分组 id
    "UPDATE task_group_view_node_orders SET node_key = ? || substr(node_key, ?) WHERE node_type = 'group' AND node_key LIKE ?",
  ];
  const own = !db.isTransaction;
  if (own) db.exec("BEGIN IMMEDIATE");
  // task_group_members 对 task_groups 有真实 FK（node:sqlite 默认 foreign_keys=ON），父子表
  // 无论谁先改，逐条 UPDATE 都会短暂违反引用；defer 到 COMMIT 统一检查（事务内有效）。
  db.exec("PRAGMA defer_foreign_keys = ON");
  try {
    for (const sql of statements) {
      db.prepare(sql).run(NEW_PREFIX, LEGACY_PREFIX.length + 1, `${LEGACY_PREFIX}%`);
    }
  } catch (error) {
    if (own) db.exec("ROLLBACK");
    throw error;
  }
  if (own) db.exec("COMMIT");
}
