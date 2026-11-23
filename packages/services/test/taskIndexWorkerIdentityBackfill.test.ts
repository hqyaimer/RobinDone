// worker 会话身份进 tasks-index 行事实的回归（2026-11-22 实测修复）：
// deferred 派发路径（ContactAgent/触发器投递）先经 createTask 草稿流预建任务行
// （meta_json 不含身份），此后 applyCliFacts 的 UPDATE 分支从不重写 meta_json——
// summary 携带的 workerId 永远进不了行事实，admitTaskGroup 投影的 GroupTaskFact
// 不带 workerId，任务组仓储的 worker 分支与主智能体首次发现分支的排除条件双双
// 失明，worker 会话被误归主智能体组。修复后 CLI meta 携带身份且行上缺失时合并
// 回 meta_json；身份缺失的 reconcile 镜像写不反向清除既有事实。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

const WORKSPACE = "E:\\ws\\backfill";

function meta(overrides: Record<string, unknown>) {
  return {
    taskId: "sess-backfill-1",
    traceId: "robinrun-sess-backfill-1",
    title: "first input title",
    workspacePath: WORKSPACE,
    createdAt: 100,
    updatedAt: 100,
    mode: "yolo" as const,
    provider: "glm" as const,
    ...overrides,
  };
}

describe("TaskIndexRepo.applyCliFacts worker 身份补写", () => {
  const dir = mkdtempSync(join(tmpdir(), "robinrun-task-index-"));
  const repo = new TaskIndexRepo(undefined, "local", join(dir, "tasks-index.sqlite"));
  afterAll(() => {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("草稿预建行在携带身份的 CLI 事实到达后补写 workerId，且不被后续无身份写清除", async () => {
    await repo.ensureReady();
    // 1. createTask 草稿流预建：meta 不含身份（deferred 派发的既有行为）。
    await repo.applyCliFacts({ meta: meta({}) });
    const before = await repo.getTaskMeta({ workspacePath: WORKSPACE, taskId: "sess-backfill-1" });
    expect(before?.workerId).toBeUndefined();

    // 2. 首条 summary 摄入：meta 携带 worker 身份（taskFacts.ingest 从 summary.worker 镜像）。
    await repo.applyCliFacts({
      meta: meta({
        updatedAt: 200,
        workerId: "wkr-7530065b",
        workerName: "开发工程师",
      }),
      titleSource: "first_input",
    });
    const after = await repo.getTaskMeta({ workspacePath: WORKSPACE, taskId: "sess-backfill-1" });
    expect(after?.workerId).toBe("wkr-7530065b");
    expect(after?.workerName).toBe("开发工程师");

    // 3. reconcile 镜像写（meta 构造从不携带身份）不得反向清除既有身份事实。
    await repo.applyCliFacts({
      meta: meta({ updatedAt: 300 }),
      titleSource: "default",
    });
    const reconciled = await repo.getTaskMeta({
      workspacePath: WORKSPACE,
      taskId: "sess-backfill-1",
    });
    expect(reconciled?.workerId).toBe("wkr-7530065b");
    expect(reconciled?.workerName).toBe("开发工程师");
    expect(reconciled?.updatedAt).toBe(300);
  });

  it("身份变化时覆盖行事实（workerId 不同的新事实赢）", async () => {
    await repo.ensureReady();
    await repo.applyCliFacts({
      meta: meta({ taskId: "sess-backfill-2", workerId: "wkr-old", workerName: "旧显示名" }),
    });
    await repo.applyCliFacts({
      meta: meta({
        taskId: "sess-backfill-2",
        updatedAt: 200,
        workerId: "wkr-new",
        workerName: "新显示名",
      }),
    });
    const changed = await repo.getTaskMeta({ workspacePath: WORKSPACE, taskId: "sess-backfill-2" });
    expect(changed?.workerId).toBe("wkr-new");
    expect(changed?.workerName).toBe("新显示名");
  });
});
