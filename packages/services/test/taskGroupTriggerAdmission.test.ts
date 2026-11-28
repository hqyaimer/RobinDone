// 触发器会话归组回归（2026-11-19 验收 bug）：触发器投递复用 automationId 参数位，
// 会话曾被误判为 cron automation 归入系统"定时任务"组（与触发器文件夹双重呈现）；
// 修正后归订阅智能体组（v1=主智能体组），cron automation（automation-<uuid>）不受影响；
// 旧版本误归 cron 组的存量行在读取路径自愈（cronAutomationId 列可能被清，判定以
// creationOrigin{kind:"trigger",ref} 兜底）。
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { TASK_GROUP_ADMISSIONS_SQL } from "#src/task-groups/migration-v6.js";
import { TASK_GROUP_PROJECT_BINDING_SQL } from "#src/task-groups/migration-v7.js";
import { TASK_INDEX_SCHEMA } from "#src/session/tasksDatabase/schema-v1.js";
import { TaskGroupRepository } from "#src/task-groups/repository.js";
import { mainAgentGroupId } from "@robindone/shared";

const WORKSPACE = "E:\\ws\\proj";
const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const OWNER_GROUP = mainAgentGroupId(PROJECT_ID);

function newDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(TASK_INDEX_SCHEMA);
  db.exec(TASK_GROUP_ADMISSIONS_SQL);
  db.exec(TASK_GROUP_PROJECT_BINDING_SQL);
  // 主智能体组（生产由 ensureMainAgentGroup 自举）与 cron 系统组（生产由 systemKind
  // 首写分支自建；repository 归组只要求组行在场，members 表有 FK）。
  const insertGroup = db.prepare(
    "INSERT INTO task_groups(group_id,title,color,project_id,created_at,updated_at) VALUES(?,?,?,?,?,?)",
  );
  insertGroup.run(OWNER_GROUP, "main-agent", "blue", PROJECT_ID, 1, 1);
  insertGroup.run("robindone-default-group-cron", "cron", "blue", null, 1, 1);
  return db;
}

function fact(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    hostId: "local",
    workspacePath: WORKSPACE,
    taskId: "sess-replace-me",
    createdAt: 1,
    projectId: PROJECT_ID,
    ...overrides,
  };
}

describe("task group admission of trigger sessions", () => {
  let db: DatabaseSync;
  let repo: TaskGroupRepository;

  beforeEach(() => {
    db = newDb();
    repo = new TaskGroupRepository(db, () => 1);
  });

  const parentOf = (taskId: string): string | null => {
    const row = db
      .prepare("SELECT group_id FROM task_group_members WHERE workspace_key=? AND task_id=?")
      .get(WORKSPACE, taskId) as { group_id: string } | undefined;
    return row?.group_id ?? null;
  };

  it("真 cron automation 仍归定时任务组", () => {
    repo.admit([fact({ taskId: "sess-cron", cronAutomationId: `automation-abc` }) as never]);
    expect(parentOf("sess-cron")).toBe("robindone-default-group-cron");
  });

  it("触发器会话归订阅智能体组而非定时任务组", () => {
    repo.admit([fact({ taskId: "sess-trg", cronAutomationId: "trg-aaa" }) as never]);
    expect(parentOf("sess-trg")).toBe(OWNER_GROUP);
    const admission = db
      .prepare("SELECT system_kind FROM task_group_admissions WHERE workspace_key=? AND task_id=?")
      .get(WORKSPACE, "sess-trg") as { system_kind: string };
    expect(admission.system_kind).toBe("trigger");
  });

  it("存量误归 cron 组的触发器会话自愈（cronAutomationId 已被清，creationOrigin 兜底）", () => {
    // 预置旧状态：admission=cron + cron 组成员；任务行的 cron_automation_id 列已被清。
    db.prepare(
      "INSERT INTO task_group_admissions(workspace_key,task_id,system_kind,user_organized) VALUES(?,?,?,0)",
    ).run(WORKSPACE, "sess-legacy", "cron");
    db.prepare(
      "INSERT INTO task_group_members(group_id,workspace_key,workspace_path,task_id,sort_order,added_at,created_at,updated_at) VALUES(?,?,?,?,0,1,1,1)",
    ).run("robindone-default-group-cron", WORKSPACE, WORKSPACE, "sess-legacy");
    db.prepare(
      "INSERT INTO task_group_view_node_orders(node_type,node_key,sort_order,created_at,updated_at) VALUES('group',?,1,1,1)",
    ).run("robindone-default-group-cron");

    repo.admit([
      fact({
        taskId: "sess-legacy",
        cronAutomationId: undefined,
        creationOrigin: { kind: "trigger", ref: "trg-bbb" },
      }) as never,
    ]);
    expect(parentOf("sess-legacy")).toBe(OWNER_GROUP);
    const admission = db
      .prepare("SELECT system_kind FROM task_group_admissions WHERE workspace_key=? AND task_id=?")
      .get(WORKSPACE, "sess-legacy") as { system_kind: string };
    expect(admission.system_kind).toBe("trigger");
  });

  it("用户手工整理过的触发器会话不被自愈触碰", () => {
    db.prepare(
      "INSERT INTO task_group_admissions(workspace_key,task_id,system_kind,user_organized) VALUES(?,?,?,1)",
    ).run(WORKSPACE, "sess-user", "cron");
    db.prepare(
      "INSERT INTO task_group_members(group_id,workspace_key,workspace_path,task_id,sort_order,added_at,created_at,updated_at) VALUES(?,?,?,?,0,1,1,1)",
    ).run("robindone-default-group-cron", WORKSPACE, WORKSPACE, "sess-user");

    repo.admit([fact({ taskId: "sess-user", cronAutomationId: "trg-ccc" }) as never]);
    expect(parentOf("sess-user")).toBe("robindone-default-group-cron");
  });
});

// 普通 master 会话首次发现归组（2026-11-21 实测修复）：ContactAgent 等 host 派发路径
// 没有 placement，此前首次发现只写顶层 order → 渲染进"未分组"伪组。现按事实上的
// projectId 归入项目主智能体组（与触发器分支同模式：用户整理过/已有父组不碰）。
describe("task group admission of plain master sessions", () => {
  let db: DatabaseSync;
  let repo: TaskGroupRepository;

  beforeEach(() => {
    db = newDb();
    repo = new TaskGroupRepository(db, () => 1);
  });

  const parentOf = (taskId: string): string | null => {
    const row = db
      .prepare("SELECT group_id FROM task_group_members WHERE workspace_key=? AND task_id=?")
      .get(WORKSPACE, taskId) as { group_id: string } | undefined;
    return row?.group_id ?? null;
  };

  it("host 派发的 master 会话首次发现归入项目主智能体组", () => {
    repo.admit([fact({ taskId: "sess-master-1", projectId: PROJECT_ID }) as never]);
    expect(parentOf("sess-master-1")).toBe(OWNER_GROUP);
  });

  it("缺 projectId 不归组（保持顶层 = 未分组）", () => {
    repo.admit([fact({ taskId: "sess-noproj", projectId: null }) as never]);
    expect(parentOf("sess-noproj")).toBeNull();
  });

  it("worker 身份事实不归主智能体组（worker 组准入走 syncer ensureWorkerGroup 专属路径）", () => {
    repo.admit([fact({ taskId: "sess-wkr", projectId: PROJECT_ID, workerId: "wkr-ops" }) as never]);
    expect(parentOf("sess-wkr")).toBeNull();
  });

  it("主智能体组未自举时跳过（不机器建组，下次准入重试）", () => {
    repo.admit([
      fact({ taskId: "sess-noone", projectId: "22222222-2222-2222-2222-222222222222" }) as never,
    ]);
    expect(parentOf("sess-noone")).toBeNull();
  });

  it("用户移出（user_organized）后不回吸", () => {
    db.prepare(
      "INSERT INTO task_group_admissions(workspace_key,task_id,user_organized) VALUES(?,?,1)",
    ).run(WORKSPACE, "sess-out");
    repo.admit([fact({ taskId: "sess-out", projectId: PROJECT_ID }) as never]);
    expect(parentOf("sess-out")).toBeNull();
  });
});
