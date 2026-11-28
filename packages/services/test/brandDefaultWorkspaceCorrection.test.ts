// 0006_default_workspace_tasks 语义回归（2026-11-28，specs/rename-robindone-migration.md 事故追记）：
// 改名 sweep 曾把候选 SQL 的 GLOB 模式改成 .robindone，导致 0.0.3 时代数据里指向
// .robinrun\workspace\default 的自动项目永远不会被纠正（静默失效）。本测试锁定：
// 旧路径自动项目被解绑任务归属 + 容器软删；新路径/用户改名的项目不受影响。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { PROJECT_SCHEMA_SQL, TASK_PROJECT_COLUMNS } from "#src/project-storage/schema.js";
import {
  DEFAULT_WORKSPACE_CANDIDATES_SQL,
  migrateDefaultWorkspaceTasks,
} from "#src/project-storage/default-workspace/migration.js";
import { TASK_INDEX_SCHEMA } from "#src/session/tasksDatabase/schema-v1.js";

const HOST = "local";

function newDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(TASK_INDEX_SCHEMA);
  db.exec(PROJECT_SCHEMA_SQL);
  // tasks 的项目归属列由 0005 加（TASK_PROJECT_COLUMNS ADD COLUMN）；fixture 模拟 0005 后状态
  for (const [column, definition] of Object.entries(TASK_PROJECT_COLUMNS))
    db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
  // 0006 候选 SQL 引用 schema_migration 的 0005_projects applied_at（0005 已应用的时间下界）
  db.exec(
    "CREATE TABLE schema_migration (id text primary key, checksum text not null, app_version text, applied_at integer not null)",
  );
  db.prepare(
    "INSERT INTO schema_migration (id, checksum, app_version, applied_at) VALUES ('0005_projects', 'x', '3.12.0', 100)",
  ).run();
  // projects.host_id 外键引用 hosts
  db.prepare("INSERT INTO hosts (host_id, kind) VALUES (?, 'local')").run(HOST);
  const insertProject = db.prepare(
    "INSERT INTO projects (project_id, host_id, name, name_overridden, position, created_at, updated_at, deleted) VALUES (?, ?, ?, 0, 0, ?, ?, 0)",
  );
  const insertRoot = db.prepare(
    "INSERT INTO project_roots (project_id, root_path, position, is_primary) VALUES (?, ?, 0, 1)",
  );
  const insertTask = db.prepare(
    "INSERT INTO tasks (workspace_key, workspace_path, task_id, title, project_id, host_id, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?, 1, 1)",
  );
  // 场景 A：0.0.3 时代被误迁成项目的旧 default 工作区（未编辑：updated_at=created_at）
  insertProject.run("p-legacy", HOST, "workspace", 50, 50);
  insertRoot.run("p-legacy", "C:\\Users\\dev\\.robinrun\\workspace\\default");
  insertTask.run("C:\\Users\\dev\\.robinrun\\workspace\\default", "C:\\Users\\dev\\.robinrun\\workspace\\default", "task-a", "p-legacy", HOST);
  // 场景 B：用户编辑过的项目（updated_at > created_at）即使路径匹配也不纠正
  insertProject.run("p-edited", HOST, "workspace (2)", 60, 61);
  insertRoot.run("p-edited", "C:\\Users\\dev\\.robinrun\\workspace\\default");
  insertTask.run("C:\\Users\\dev\\.robinrun\\workspace\\default", "C:\\Users\\dev\\.robinrun\\workspace\\default", "task-b", "p-edited", HOST);
  // 场景 C：新路径项目（0.0.4 全新对话工作区）不受影响
  insertProject.run("p-current", HOST, "workspace (3)", 70, 70);
  insertRoot.run("p-current", "C:\\Users\\dev\\.robindone\\workspace\\default");
  insertTask.run("C:\\Users\\dev\\.robindone\\workspace\\default", "C:\\Users\\dev\\.robindone\\workspace\\default", "task-c", "p-current", HOST);
  return db;
}

describe("migrateDefaultWorkspaceTasks (0006) brand-path correction", () => {
  it("纠正指向旧 .robinrun default 工作区的未编辑自动项目；编辑过/新路径项目不动", () => {
    const db = newDb();
    // 候选 SQL 本身必须仍匹配旧品牌路径（锁定 checksum 输入不被再 sweep）
    expect(DEFAULT_WORKSPACE_CANDIDATES_SQL).toContain("*/.robinrun/workspace/default");
    migrateDefaultWorkspaceTasks(db, { hostId: HOST, now: () => 999 });
    const project = (id: string) =>
      db.prepare("SELECT deleted, deleted_at FROM projects WHERE project_id=?").get(id) as {
        deleted: number;
        deleted_at: number | null;
      };
    const taskOwner = (id: string) =>
      (db.prepare("SELECT project_id FROM tasks WHERE task_id=?").get(id) as { project_id: string | null })
        .project_id;
    // A：纠正——任务解绑 + 容器软删
    expect(taskOwner("task-a")).toBeNull();
    expect(project("p-legacy").deleted).toBe(1);
    expect(project("p-legacy").deleted_at).toBe(999);
    // B：用户编辑过的项目保留
    expect(taskOwner("task-b")).toBe("p-edited");
    expect(project("p-edited").deleted).toBe(0);
    // C：新路径项目保留
    expect(taskOwner("task-c")).toBe("p-current");
    expect(project("p-current").deleted).toBe(0);
  });
});
