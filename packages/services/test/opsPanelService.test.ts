// 需求/审批/反馈面板服务回归（2026-11-24 MVP；同日用户裁决"对话代录"修订）：
// 对话代录（author/recordedBy 拆分）、串行唤醒队列（验收 #2）、录入豁免（验收 #4 修订，
// 规则读订阅配置 wakeRules）、worker 可见性（验收 #6）、权限矩阵、重启持久化与挂载
// 恢复（验收 #8）、处置即释放语义。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpsPanelEntry } from "@robinrun/shared";
import { OpsPanelRepo } from "../src/ops-panel/opsPanelRepo.js";
import { OpsPanelService } from "../src/ops-panel/opsPanelService.js";
import type {
  OpsPanelDispatchPort,
  OpsPanelSystemSubscriptionPort,
} from "../src/ops-panel/contract.js";

const WORKSPACE = join("E:", "mock", "ops-workspace");

const USER = { role: "user" } as const;
const MASTER = { role: "agent", agentId: "master" } as const;
const worker = (id: string) => ({ role: "agent", agentId: `worker:${id}` }) as const;

interface Harness {
  service: OpsPanelService;
  repo: OpsPanelRepo;
  dispatch: ReturnType<typeof vi.fn>;
  seeds: ReturnType<typeof vi.fn>;
  dbPath: string;
}

async function buildHarness(dbPath?: string): Promise<Harness> {
  const resolvedDbPath =
    dbPath ?? join(await mkdtemp(join(tmpdir(), "robinrun-ops-panel-")), "tasks-index.sqlite");
  const repo = new OpsPanelRepo(resolvedDbPath);
  const dispatch = vi.fn(async () => ({ taskId: "sess-master-main" }));
  const seeds = vi.fn(async () => ({}));
  const service = new OpsPanelService({
    repo,
    dispatch: { dispatchOpsPanelWakeup: dispatch } as unknown as OpsPanelDispatchPort,
    ensureSystemSubscription: {
      ensureSystemSubscription: seeds,
    } as unknown as OpsPanelSystemSubscriptionPort,
    log: () => {},
  });
  return { service, repo, dispatch, seeds, dbPath: resolvedDbPath };
}

async function flushDispatch(): Promise<void> {
  // dispatchQueueHead 是异步 fire（getEntry → dispatch 两跳 await）；多轮泵尽微任务。
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

let cleanup: Array<Promise<void>> = [];

describe("ops panel service", () => {
  beforeEach(() => {
    cleanup = [];
  });

  afterEach(async () => {
    await Promise.allSettled(cleanup);
  });

  it("master 代录用户需求（2026-11-24 对话代录裁决）：author=user、recordedBy=master、免自唤醒；订阅播种带 wakeRules", async () => {
    const h = await buildHarness();
    cleanup.push(rm(h.dbPath, { recursive: true, force: true }).catch(() => {}));
    const entry = await h.service.createEntry({
      workspacePath: WORKSPACE,
      kind: "requirement",
      title: "面板加导出",
      body: "用户在对话里提出：希望支持快照导出",
      actor: MASTER,
    });
    // 录入与来源拆分：author=来源（用户转述），recordedBy=经手（master 代录）。
    expect(entry.id).toBe("REQ-0001");
    expect(entry.author).toBe("user");
    expect(entry.recordedBy).toBe("master");
    // requirement.created 退出订阅面（录入方在场）：创建不唤醒，状态停在 submitted。
    expect(entry.status).toBe("submitted");
    await flushDispatch();
    expect(h.dispatch).toHaveBeenCalledTimes(0);
    // 订阅播种恰好一次（幂等 memo），且带修订后的订阅面与豁免规则（通用机制随配置播种）。
    expect(h.seeds).toHaveBeenCalledTimes(1);
    const seeded = h.seeds.mock.calls[0]?.[0] as {
      subscription: { events: string[]; wakeRules: Record<string, { exemptRecordedBy: string[] }> };
    };
    expect(seeded.subscription.events).toEqual(["approval.decided", "feedback.created"]);
    expect(seeded.subscription.wakeRules).toEqual({
      "feedback.created": { exemptRecordedBy: ["master"] },
    });
  });

  it("串行性（验收 #2）：第 1 条处置完成前第 2 条不唤醒；处置即释放后队头投递（worker 反馈为队列项）", async () => {
    const h = await buildHarness();
    cleanup.push(rm(h.dbPath, { recursive: true, force: true }).catch(() => {}));
    await h.service.createEntry({
      workspacePath: WORKSPACE,
      kind: "feedback",
      title: "第一条",
      body: "a",
      actor: worker("wkr-dev"),
    });
    await h.service.createEntry({
      workspacePath: WORKSPACE,
      kind: "feedback",
      title: "第二条",
      body: "b",
      actor: worker("wkr-ops"),
    });
    await flushDispatch();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    let view = await h.service.getPanelView({ workspacePath: WORKSPACE, actor: MASTER });
    expect(view.queue.inFlightId).toBe("FBK-0001");
    expect(view.queue.pendingIds).toEqual(["FBK-0002"]);

    // 未处置期间反复读面板不产生额外唤醒。
    await h.service.getPanelView({ workspacePath: WORKSPACE, actor: MASTER });
    await flushDispatch();
    expect(h.dispatch).toHaveBeenCalledTimes(1);

    // 分诊（≠ 处理闭环）：处理完第 1 条 → 释放 → 第二条唤醒。
    await h.service.resolveFeedback({
      workspacePath: WORKSPACE,
      entryId: "FBK-0001",
      note: "已安排修复",
      actor: MASTER,
    });
    await flushDispatch();
    expect(h.dispatch).toHaveBeenCalledTimes(2);
    const secondDispatch = h.dispatch.mock.calls[1]?.[0] as { entry: OpsPanelEntry } | undefined;
    expect(secondDispatch?.entry.id).toBe("FBK-0002");
    view = await h.service.getPanelView({ workspacePath: WORKSPACE, actor: MASTER });
    expect(view.queue.inFlightId).toBe("FBK-0002");
    const resolved = await h.service.getEntry({
      workspacePath: WORKSPACE,
      entryId: "FBK-0001",
      actor: MASTER,
    });
    expect(resolved?.status).toBe("processed");
    expect(resolved?.note).toBe("已安排修复");
  });

  it("录入豁免（验收 #4 修订）：master 录入的一切（起草审批/代录用户反馈/自录反馈）不唤醒；worker 反馈唤醒", async () => {
    const h = await buildHarness();
    cleanup.push(rm(h.dbPath, { recursive: true, force: true }).catch(() => {}));
    const approval = await h.service.createEntry({
      workspacePath: WORKSPACE,
      kind: "approval",
      title: "尝试新方向",
      body: "优化建议",
      actor: MASTER,
    });
    expect(approval.id).toBe("APP-0001");
    const onBehalf = await h.service.createEntry({
      workspacePath: WORKSPACE,
      kind: "feedback",
      title: "用户说文档滞后",
      body: "触发器文档与实现不一致",
      author: "user",
      actor: MASTER,
    });
    const ownNote = await h.service.createEntry({
      workspacePath: WORKSPACE,
      kind: "feedback",
      title: "自观察",
      body: "x",
      author: "master",
      actor: MASTER,
    });
    // 代录角标数据：author=user 的反馈 recordedBy=master；自录的两者一致。
    expect(onBehalf.author).toBe("user");
    expect(onBehalf.recordedBy).toBe("master");
    expect(ownNote.author).toBe("master");
    expect(ownNote.recordedBy).toBe("master");
    await flushDispatch();
    expect(h.dispatch).toHaveBeenCalledTimes(0);

    const feedback = await h.service.createEntry({
      workspacePath: WORKSPACE,
      kind: "feedback",
      title: "文档滞后",
      body: "触发器文档与实现不一致",
      actor: worker("wkr-dev"),
    });
    // master 的两条自录反馈占 FBK-0001/0002（豁免唤醒但仍计数），worker 的这条是 FBK-0003。
    expect(feedback.id).toBe("FBK-0003");
    await flushDispatch();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const feedbackDispatch = h.dispatch.mock.calls[0]?.[0] as { eventName: string } | undefined;
    expect(feedbackDispatch?.eventName).toBe("feedback.created");
  });

  it("审批决定 → 唤醒 master；ack 释放后继续（验收 #3 的服务层语义）", async () => {
    const h = await buildHarness();
    cleanup.push(rm(h.dbPath, { recursive: true, force: true }).catch(() => {}));
    await h.service.createEntry({
      workspacePath: WORKSPACE,
      kind: "approval",
      title: "方向A",
      body: "b",
      actor: MASTER,
    });
    await flushDispatch();
    expect(h.dispatch).toHaveBeenCalledTimes(0);
    await h.service.decideApproval({
      workspacePath: WORKSPACE,
      entryId: "APP-0001",
      decision: "approved",
      actor: USER,
    });
    await flushDispatch();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const decidedDispatch = h.dispatch.mock.calls[0]?.[0] as { eventName: string } | undefined;
    expect(decidedDispatch?.eventName).toBe("approval.decided");
    // master 确认执行 → 释放（不改用户可见状态）。
    await h.service.acknowledgeApproval({
      workspacePath: WORKSPACE,
      entryId: "APP-0001",
      note: "已开工",
      actor: MASTER,
    });
    await flushDispatch();
    const entry = await h.service.getEntry({
      workspacePath: WORKSPACE,
      entryId: "APP-0001",
      actor: MASTER,
    });
    expect(entry?.status).toBe("approved");
    expect(entry?.acknowledgedAt).toBeDefined();
    const view = await h.service.getPanelView({ workspacePath: WORKSPACE, actor: MASTER });
    expect(view.queue.inFlightId).toBeNull();
    // 重复 ack 拒绝。
    await expect(
      h.service.acknowledgeApproval({
        workspacePath: WORKSPACE,
        entryId: "APP-0001",
        actor: MASTER,
      }),
    ).rejects.toThrow(/acknowledgment/);
  });

  it("worker 可见性（验收 #6）：读取接口只见自己提交的条目，队列投影同步收窄", async () => {
    const h = await buildHarness();
    cleanup.push(rm(h.dbPath, { recursive: true, force: true }).catch(() => {}));
    await h.service.createEntry({
      workspacePath: WORKSPACE,
      kind: "requirement",
      title: "代录需求",
      body: "b",
      actor: MASTER,
    });
    await h.service.createEntry({
      workspacePath: WORKSPACE,
      kind: "feedback",
      title: "我的反馈",
      body: "b",
      actor: worker("wkr-dev"),
    });
    await h.service.createEntry({
      workspacePath: WORKSPACE,
      kind: "feedback",
      title: "他人反馈",
      body: "b",
      actor: worker("wkr-ops"),
    });
    await flushDispatch();

    const mine = await h.service.getPanelView({
      workspacePath: WORKSPACE,
      actor: worker("wkr-dev"),
    });
    expect(mine.entries.map((entry) => entry.id)).toEqual(["FBK-0001"]);
    expect(mine.entries[0]?.author).toBe("worker:wkr-dev");

    const master = await h.service.getPanelView({ workspacePath: WORKSPACE, actor: MASTER });
    expect(master.entries).toHaveLength(3);
    const user = await h.service.getPanelView({ workspacePath: WORKSPACE, actor: USER });
    expect(user.entries).toHaveLength(3);

    // 单条读取同样过滤（数据层，不是 UI 隐藏）。
    const visible = await h.service.getEntry({
      workspacePath: WORKSPACE,
      entryId: "FBK-0001",
      actor: worker("wkr-dev"),
    });
    expect(visible?.id).toBe("FBK-0001");
    const hidden = await h.service.getEntry({
      workspacePath: WORKSPACE,
      entryId: "REQ-0001",
      actor: worker("wkr-dev"),
    });
    expect(hidden).toBeNull();
    const others = await h.service.getEntry({
      workspacePath: WORKSPACE,
      entryId: "FBK-0002",
      actor: worker("wkr-dev"),
    });
    expect(others).toBeNull();
  });

  it("权限矩阵（对话代录修订）：user 不再直接创建；worker 不能代录需求/起草审批；master 反馈缺 author 拒；处置/决定身份不变", async () => {
    const h = await buildHarness();
    cleanup.push(rm(h.dbPath, { recursive: true, force: true }).catch(() => {}));
    // UI 表单退役：user actor 创建一律拒（需求/反馈都经 master 对话代录）。
    await expect(
      h.service.createEntry({
        workspacePath: WORKSPACE,
        kind: "requirement",
        title: "t",
        body: "b",
        actor: USER,
      }),
    ).rejects.toThrow(/recorded by master/);
    await expect(
      h.service.createEntry({
        workspacePath: WORKSPACE,
        kind: "feedback",
        title: "t",
        body: "b",
        actor: USER,
      }),
    ).rejects.toThrow(/recorded by master/);
    // worker 不能代录需求 / 起草审批。
    await expect(
      h.service.createEntry({
        workspacePath: WORKSPACE,
        kind: "requirement",
        title: "t",
        body: "b",
        actor: worker("wkr-dev"),
      }),
    ).rejects.toThrow(/Only master can record requirements/);
    await expect(
      h.service.createEntry({
        workspacePath: WORKSPACE,
        kind: "approval",
        title: "t",
        body: "b",
        actor: worker("wkr-dev"),
      }),
    ).rejects.toThrow(/Only master/);
    // master 代录反馈缺来源标记拒（服务层与工具 schema 双层守一致）。
    await expect(
      h.service.createEntry({
        workspacePath: WORKSPACE,
        kind: "feedback",
        title: "t",
        body: "b",
        actor: MASTER,
      }),
    ).rejects.toThrow(/author is required/);
    // 处置/决定身份不变。
    await h.service.createEntry({
      workspacePath: WORKSPACE,
      kind: "approval",
      title: "方向",
      body: "b",
      actor: MASTER,
    });
    await expect(
      h.service.decideApproval({
        workspacePath: WORKSPACE,
        entryId: "APP-0001",
        decision: "approved",
        actor: MASTER,
      }),
    ).rejects.toThrow(/Only the user/);
    await h.service.createEntry({
      workspacePath: WORKSPACE,
      kind: "feedback",
      title: "f",
      body: "b",
      author: "user",
      actor: MASTER,
    });
    await expect(
      h.service.decideRequirement({
        workspacePath: WORKSPACE,
        entryId: "REQ-0001",
        outcome: "accepted",
        actor: USER,
      }),
    ).rejects.toThrow(/Only master/);
    await expect(
      h.service.resolveFeedback({
        workspacePath: WORKSPACE,
        entryId: "FBK-0001",
        actor: worker("wkr-dev"),
      }),
    ).rejects.toThrow(/Only master/);
    await flushDispatch();
  });

  it("处置未在途条目：静默出队不触发级联；在途条目继续占用队列", async () => {
    const h = await buildHarness();
    cleanup.push(rm(h.dbPath, { recursive: true, force: true }).catch(() => {}));
    await h.service.createEntry({
      workspacePath: WORKSPACE,
      kind: "feedback",
      title: "f1",
      body: "b",
      actor: worker("wkr-dev"),
    });
    await h.service.createEntry({
      workspacePath: WORKSPACE,
      kind: "feedback",
      title: "f2",
      body: "b",
      actor: worker("wkr-ops"),
    });
    await flushDispatch();
    expect(h.dispatch).toHaveBeenCalledTimes(1); // f1 在途
    // master 提前分诊排队的 f2（如经面板巡检）：出队但不唤醒任何新条目。
    await h.service.resolveFeedback({
      workspacePath: WORKSPACE,
      entryId: "FBK-0002",
      note: "重复",
      actor: MASTER,
    });
    await flushDispatch();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const view = await h.service.getPanelView({ workspacePath: WORKSPACE, actor: MASTER });
    expect(view.queue.inFlightId).toBe("FBK-0001");
    expect(view.queue.pendingIds).toEqual([]);
  });

  it("投递失败回退 pending，下一次处置重试", async () => {
    const h = await buildHarness();
    cleanup.push(rm(h.dbPath, { recursive: true, force: true }).catch(() => {}));
    h.dispatch.mockRejectedValueOnce(new Error("task service unavailable"));
    await h.service.createEntry({
      workspacePath: WORKSPACE,
      kind: "feedback",
      title: "f1",
      body: "b",
      actor: worker("wkr-dev"),
    });
    await flushDispatch();
    let view = await h.service.getPanelView({ workspacePath: WORKSPACE, actor: MASTER });
    expect(view.queue.inFlightId).toBeNull();
    expect(view.queue.pendingIds).toEqual(["FBK-0001"]);
    // 下一次处置（释放路径的 pump）会重试队头。
    await h.service.createEntry({
      workspacePath: WORKSPACE,
      kind: "feedback",
      title: "f2",
      body: "b",
      actor: worker("wkr-ops"),
    });
    await flushDispatch();
    view = await h.service.getPanelView({ workspacePath: WORKSPACE, actor: MASTER });
    expect(view.queue.inFlightId).toBe("FBK-0001");
    expect(view.queue.pendingIds).toEqual(["FBK-0002"]);
  });

  it("重启持久化（验收 #8）：重开库后条目与队列状态不丢；挂载恢复重派发在途条目", async () => {
    const dbPath = join(await mkdtemp(join(tmpdir(), "robinrun-ops-panel-")), "tasks-index.sqlite");
    cleanup.push(rm(dbPath, { recursive: true, force: true }).catch(() => {}));
    const first = await buildHarness(dbPath);
    await first.service.createEntry({
      workspacePath: WORKSPACE,
      kind: "feedback",
      title: "f1",
      body: "b",
      actor: worker("wkr-dev"),
    });
    await first.service.createEntry({
      workspacePath: WORKSPACE,
      kind: "requirement",
      title: "r1",
      body: "b",
      actor: MASTER,
    });
    await flushDispatch();
    expect(first.dispatch).toHaveBeenCalledTimes(1);
    await first.repo.close();
    (first.service as unknown as { seededWorkspaces: Set<string> }).seededWorkspaces.clear();

    // 新服务实例（模拟进程重启）：队列与条目保持；原在途条目回 pending 并重派发。
    const second = await buildHarness(dbPath);
    const view = await second.service.getPanelView({ workspacePath: WORKSPACE, actor: MASTER });
    expect(view.entries.map((entry) => entry.id)).toEqual(["FBK-0001", "REQ-0001"]);
    await flushDispatch();
    expect(second.dispatch).toHaveBeenCalledTimes(1);
    const resumedDispatch = second.dispatch.mock.calls[0]?.[0] as
      | { entry: OpsPanelEntry }
      | undefined;
    expect(resumedDispatch?.entry.id).toBe("FBK-0001");
    await second.repo.close();
  });

  it("编号按 kind 独立递增；REQ 处置四选一（含转审批）状态正确", async () => {
    const h = await buildHarness();
    cleanup.push(rm(h.dbPath, { recursive: true, force: true }).catch(() => {}));
    await h.service.createEntry({
      workspacePath: WORKSPACE,
      kind: "requirement",
      title: "r1",
      body: "b",
      actor: MASTER,
    });
    await h.service.createEntry({
      workspacePath: WORKSPACE,
      kind: "feedback",
      title: "f1",
      body: "b",
      author: "user",
      actor: MASTER,
    });
    const r2 = await h.service.createEntry({
      workspacePath: WORKSPACE,
      kind: "requirement",
      title: "r2",
      body: "b",
      actor: MASTER,
    });
    expect(r2.id).toBe("REQ-0002");
    await flushDispatch();
    await h.service.decideRequirement({
      workspacePath: WORKSPACE,
      entryId: "REQ-0001",
      outcome: "converted_to_approval",
      actor: MASTER,
    });
    await h.service.decideRequirement({
      workspacePath: WORKSPACE,
      entryId: "REQ-0002",
      outcome: "suspended",
      note: "待上游",
      actor: MASTER,
    });
    const r1 = await h.service.getEntry({
      workspacePath: WORKSPACE,
      entryId: "REQ-0001",
      actor: USER,
    });
    expect(r1?.outcome).toBe("converted_to_approval");
    const r2After = await h.service.getEntry({
      workspacePath: WORKSPACE,
      entryId: "REQ-0002",
      actor: USER,
    });
    expect(r2After?.outcome).toBe("suspended");
  });
});
