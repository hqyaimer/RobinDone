// 冻结 0008 的只增 SQL；后续结构调整必须追加迁移，不能跟随运行 Repo 修改 checksum。
// （同 task-groups/migration-v6.ts 惯例：迁移 SQL 是历史事实，Repo 运行时 schema 不回写这里。）

/**
 * 需求/审批/反馈面板条目表（2026-11-24 MVP）：
 * - 三 kind（requirement/approval/feedback）同表 + 判别列，队列语义同构
 *   （"取串行唤醒队头"是简单查询）；状态约束在应用层按 kind 校验（shared
 *   ops-panel schema），SQL 只锁 kind/wakeup_state 词表。
 * - 编号 = 类型前缀 + 序号（REQ-0001），workspace 内按 kind 递增：
 *   seq 列显式存储 + UNIQUE(workspace_key, kind, seq) 防并发重号。
 * - links 为 JSON 预留字段（MVP 不做升格/链接逻辑与 UI）。
 * - wakeup_state：none（不入队）/ pending（待唤醒）/ in_flight（已唤醒待处置，
 *   同 workspace 至多一条）/ released（处置完成释放）。
 */
export const OPS_PANEL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ops_panel_entries (
  workspace_key TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('requirement','approval','feedback')),
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  status TEXT NOT NULL,
  outcome TEXT,
  note TEXT,
  wakeup_state TEXT NOT NULL DEFAULT 'none' CHECK (wakeup_state IN ('none','pending','in_flight','released')),
  links TEXT,
  acknowledged_at INTEGER,
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_key, id)
);
CREATE INDEX IF NOT EXISTS idx_ops_panel_entries_listing
  ON ops_panel_entries (workspace_key, kind, created_at ASC);
`;
