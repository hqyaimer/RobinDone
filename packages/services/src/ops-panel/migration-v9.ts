// 冻结 0009 的只增 SQL；后续结构调整必须追加迁移，不能跟随运行 Repo 修改 checksum。
// （同 migration-v8.ts 惯例：迁移 SQL 是历史事实，Repo 运行时 schema 不回写这里。）

/**
 * 0009（2026-11-24 用户裁决"录入与来源拆分"）：ops_panel_entries 增加 recorded_by 列。
 * author=来源（user / master / worker:<id>），recorded_by=经手录入者——master 代录的
 * 需求/反馈（author=user、recorded_by=master）面板显示代录角标，worker 可见性过滤仍按
 * author。存量行回填 recorded_by = author（0008 时代作者即录入者，语义等价）。
 */
export const OPS_PANEL_RECORDED_BY_SQL = `
ALTER TABLE ops_panel_entries ADD COLUMN recorded_by TEXT NOT NULL DEFAULT '';
UPDATE ops_panel_entries SET recorded_by = author WHERE recorded_by = '';
`;
