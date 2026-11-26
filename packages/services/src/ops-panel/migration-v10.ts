// 冻结 0010 的只增 SQL；后续结构调整必须追加迁移，不能跟随运行 Repo 修改 checksum。
// （同 migration-v8.ts 惯例：迁移 SQL 是历史事实，Repo 运行时 schema 不回写这里。）

/**
 * 项目进度账本条目表（2026-11-25，specs/progress-ledger.md）：运营面板进度 tab 的
 * 追加式项目里程碑台账。与 ops_panel_entries 的本质区别：无状态机、无唤醒队列——
 * master 原位维护（update/delete），账本只呈现有效记录（最终态），不是审计账本。
 * - 编号 = PRG 前缀 + 序号（PRG-0001），workspace 内递增不复用（软删不释放编号，
 *   seq 取 MAX 时扫全部行含软删）；
 * - deleted 软删标记：读路径过滤，UI 无痕；行保留作误删恢复安全网（对齐触发器
 *   伪删除先例），不构成可查修订史；
 * - links 为 JSON 数组（关联文件路径，≤8 条），进度与知识/状态文件的融合点；
 * - created_by：master | system（系统锚条目"项目初始化"由服务幂等播种，
 *   可编辑不可删——否则幂等播种会复活）。
 */
export const PROGRESS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS progress_entries (
  workspace_key TEXT NOT NULL,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  links TEXT,
  created_by TEXT NOT NULL CHECK (created_by IN ('master','system')),
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_key, id)
);
CREATE INDEX IF NOT EXISTS idx_progress_entries_listing
  ON progress_entries (workspace_key, deleted, created_at ASC);
`;
