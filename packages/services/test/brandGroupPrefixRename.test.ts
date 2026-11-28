// 0011 改名迁移回归（2026-11-27 RobinRun→RobinDone，specs/rename-robindone-migration.md §3.2）：
// 确定性分组 id 前缀（robinrun-main-agent-/robinrun-worker-）与系统组常量 id（cron/off-peak）
// 在 task_groups、task_group_members、task_group_view_node_orders 三表全量改写；中立 id 与
// task 型节点 key（JSON([workspaceKey,taskId])）不受影响；纯 UPDATE 语义天然幂等。
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CRON_DEFAULT_GROUP_ID,
  OFF_PEAK_DEFAULT_GROUP_ID,
  mainAgentGroupId,
  workerGroupId,
} from "@robindone/shared";
import { TASK_GROUP_ADMISSIONS_SQL } from "#src/task-groups/migration-v6.js";
import { TASK_GROUP_PROJECT_BINDING_SQL } from "#src/task-groups/migration-v7.js";
import { renameBrandGroupPrefixes } from "#src/task-groups/migration-v11.js";
import { TASK_INDEX_SCHEMA } from "#src/session/tasksDatabase/schema-v1.js";

const WORKSPACE = "E:\\ws\\proj";
const PROJECT_ID = "22222222-2222-2222-2222-222222222222";
const WORKER_ID = "wkr-abc12345";
// RobinRun 时代的确定性 id（旧前缀字面量——当前常量已换新名，这里必须硬编码旧值）
const LEGACY_MAIN_GROUP = `robinrun-main-agent-${PROJECT_ID}`;
const LEGACY_WORKER_GROUP = `robinrun-worker-${WORKER_ID}`;
const NEUTRAL_GROUP = "user-made-group";

function newDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(TASK_INDEX_SCHEMA);
  db.exec(TASK_GROUP_ADMISSIONS_SQL);
  db.exec(TASK_GROUP_PROJECT_BINDING_SQL);
  const insertGroup = db.prepare(
    "INSERT INTO task_groups(group_id,title,color,project_id,created_at,updated_at) VALUES(?,?,?,?,?,?)",
  );
  insertGroup.run(LEGACY_MAIN_GROUP, "main", "blue", PROJECT_ID, 1, 1);
  insertGroup.run(LEGACY_WORKER_GROUP, "worker", "red", PROJECT_ID, 2, 2);
  insertGroup.run(`robinrun-default-group-cron`, "cron", "blue", null, 3, 3);
  insertGroup.run(`robinrun-default-group-off-peak`, "off-peak", "blue", null, 4, 4);
  insertGroup.run(NEUTRAL_GROUP, "neutral", "gray", PROJECT_ID, 5, 5);
  const insertMember = db.prepare(
    "INSERT INTO task_group_members(group_id,workspace_key,workspace_path,task_id,added_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
  );
  insertMember.run(LEGACY_MAIN_GROUP, WORKSPACE, WORKSPACE, "task-1", 1, 1, 1);
  insertMember.run(LEGACY_WORKER_GROUP, WORKSPACE, WORKSPACE, "task-2", 1, 1, 1);
  const insertOrder = db.prepare(
    "INSERT INTO task_group_view_node_orders(node_type,node_key,sort_order,created_at,updated_at) VALUES(?,?,?,?,?)",
  );
  insertOrder.run("group", LEGACY_MAIN_GROUP, 1, 1, 1);
  insertOrder.run("group", LEGACY_WORKER_GROUP, 2, 1, 1);
  insertOrder.run("task", JSON.stringify([WORKSPACE, "task-1"]), 3, 1, 1);
  return db;
}

describe("renameBrandGroupPrefixes (0011)", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = newDb();
  });

  it("改写三表中的旧前缀 id，派生函数新值命中改写结果", () => {
    renameBrandGroupPrefixes(db);
    const groupIds = (
      db.prepare("SELECT group_id FROM task_groups ORDER BY created_at").all() as {
        group_id: string;
      }[]
    ).map((row) => row.group_id);
    expect(groupIds).toEqual([
      mainAgentGroupId(PROJECT_ID),
      workerGroupId(WORKER_ID),
      CRON_DEFAULT_GROUP_ID,
      OFF_PEAK_DEFAULT_GROUP_ID,
      NEUTRAL_GROUP,
    ]);
    const memberGroups = (
      db.prepare("SELECT group_id FROM task_group_members ORDER BY rowid").all() as {
        group_id: string;
      }[]
    ).map((row) => row.group_id);
    expect(memberGroups).toEqual([mainAgentGroupId(PROJECT_ID), workerGroupId(WORKER_ID)]);
    const orderKeys = (
      db
        .prepare("SELECT node_type, node_key FROM task_group_view_node_orders ORDER BY sort_order")
        .all() as { node_type: string; node_key: string }[]
    ).map((row) => [row.node_type, row.node_key]);
    expect(orderKeys).toEqual([
      ["group", mainAgentGroupId(PROJECT_ID)],
      ["group", workerGroupId(WORKER_ID)],
      // task 型 key（JSON 数组）即使路径含 robinrun 字样也不改写
      ["task", JSON.stringify([WORKSPACE, "task-1"])],
    ]);
    expect(
      db.prepare("SELECT 1 FROM task_groups WHERE group_id LIKE 'robinrun-%'").all().length,
    ).toBe(0);
  });

  it("幂等：重复执行不再变化", () => {
    renameBrandGroupPrefixes(db);
    const snapshot = db.prepare("SELECT group_id FROM task_groups ORDER BY group_id").all();
    renameBrandGroupPrefixes(db);
    expect(db.prepare("SELECT group_id FROM task_groups ORDER BY group_id").all()).toEqual(
      snapshot,
    );
    expect(
      db.prepare("SELECT 1 FROM task_groups WHERE group_id LIKE 'robinrun-%'").all().length,
    ).toBe(0);
  });
});
