// 触发器会话投影过滤回归（2026-11-19 验收裁决）：触发器投递的会话由触发器文件夹独占
// 承载，任务组视图（智能体平面）不渲染其会话行——不归智能体组 children、不落"未分组"
// 伪组、不因顶层 order 残留而出现游离行。真 cron automation（automation-<uuid>）不受影响。
import { describe, expect, it } from "vitest";
import { projectGroupedNodes } from "@/project-sidebar/grouped-view.js";
import { UNGROUPED_AGENT_ID } from "@/project-sidebar/grouped/ids.js";
import type { ProjectTask, TaskGroup, TaskGroupStructure } from "@/project-sidebar/contract.js";

const WORKSPACE = "E:\\ws\\proj";

function task(overrides: Partial<ProjectTask> & { taskId: string }): ProjectTask {
  return {
    hostId: "local",
    workspacePath: WORKSPACE,
    title: "t",
    pinned: false,
    archived: false,
    ...overrides,
  } as ProjectTask;
}

function structure(overrides?: Partial<TaskGroupStructure>): TaskGroupStructure {
  return {
    groups: [],
    members: [],
    order: [],
    ...overrides,
  };
}

describe("projectGroupedNodes trigger session filtering", () => {
  it("触发器会话不渲染在任何分组（含未分组伪组），cron automation 不受影响", () => {
    const tasks: ProjectTask[] = [
      task({ taskId: "sess-user", title: "你好" }),
      task({
        taskId: "sess-trg",
        title: "工作区体检",
        cronAutomationId: "trg-93288a72",
      }),
      task({
        taskId: "sess-trg-legacy",
        title: "手动唤醒铃",
        creationOrigin: { kind: "trigger", ref: "trg-21a268bf" },
      }),
      task({
        taskId: "sess-cron",
        title: "定时巡检",
        cronAutomationId: "automation-1c2d3e4f",
      }),
    ];
    const structureWith = structure({
      groups: [
        {
          id: "agent-1",
          title: "主智能体",
          color: "blue",
          projectId: "p1",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "robindone-default-group-cron",
          title: "cron",
          color: "blue",
          projectId: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      members: [
        { groupId: "agent-1", workspaceKey: WORKSPACE, taskId: "sess-user", sortOrder: 0 },
        { groupId: "agent-1", workspaceKey: WORKSPACE, taskId: "sess-trg", sortOrder: 1 },
        // 真 cron automation 会话由数据层 systemKind 准入挂进 cron 系统组。
        {
          groupId: "robindone-default-group-cron",
          workspaceKey: WORKSPACE,
          taskId: "sess-cron",
          sortOrder: 0,
        },
      ],
      order: [
        { type: "group", key: "agent-1", sortOrder: 0 },
        { type: "group", key: "robindone-default-group-cron", sortOrder: 1 },
        { type: "task", key: JSON.stringify([WORKSPACE, "sess-trg-legacy"]), sortOrder: 2 },
      ],
    });

    const rows = projectGroupedNodes(tasks, structureWith, new Set());
    const renderedTaskIds = rows
      .filter((row) => row.type === "task")
      .map((row) => (row.type === "task" ? row.task.taskId : ""));
    expect(renderedTaskIds).toContain("sess-user");
    expect(renderedTaskIds).toContain("sess-cron");
    expect(renderedTaskIds).not.toContain("sess-trg");
    expect(renderedTaskIds).not.toContain("sess-trg-legacy");

    // 触发器会话不得把"未分组"伪组带出来（伪组行本身始终存在，但其下不应有触发器会话行）。
    const ungroupedTasks = rows.filter(
      (row) => row.type === "task" && row.groupId === UNGROUPED_AGENT_ID,
    );
    expect(ungroupedTasks).toHaveLength(0);
  });
});
