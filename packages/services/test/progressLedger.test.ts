// 项目进度账本服务回归（2026-11-25，specs/progress-ledger.md）：系统锚幂等播种
// （验收 #1，createdAt 取项目真实创建时间）、master 独占双层强制（验收 #5/#6）、
// 原位维护制 update/delete（2026-11-25 用户裁决修订，验收 #4/#5）、软删不复活且
// 编号不复用、锚不可删（幂等播种会复活）、重启持久化（验收 #7）。无事件面：写
// 动作只广播 panelChanged，不产生唤醒。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpsPanelRepo } from "../src/ops-panel/opsPanelRepo.js";
import { OpsPanelService } from "../src/ops-panel/opsPanelService.js";
import type {
  OpsPanelDispatchPort,
  OpsPanelProjectMetaPort,
  OpsPanelSystemSubscriptionPort,
} from "../src/ops-panel/contract.js";

const WORKSPACE = join("E:", "mock", "progress-workspace");
const PROJECT_CREATED_AT_MS = 1_700_000_000_000;

const USER = { role: "user" } as const;
const MASTER = { role: "agent", agentId: "master" } as const;
const worker = (id: string) => ({ role: "agent", agentId: `worker:${id}` }) as const;

interface Harness {
  service: OpsPanelService;
  repo: OpsPanelRepo;
  notify: ReturnType<typeof vi.fn>;
  dbPath: string;
}

async function buildHarness(dbPath?: string): Promise<Harness> {
  const resolvedDbPath =
    dbPath ?? join(await mkdtemp(join(tmpdir(), "robinrun-progress-ledger-")), "tasks-index.sqlite");
  const repo = new OpsPanelRepo(resolvedDbPath);
  const notify = vi.fn();
  const service = new OpsPanelService({
    repo,
    dispatch: {
      dispatchOpsPanelWakeup: vi.fn(async () => ({ taskId: "t" })),
    } as unknown as OpsPanelDispatchPort,
    ensureSystemSubscription: {
      ensureSystemSubscription: vi.fn(async () => ({})),
    } as unknown as OpsPanelSystemSubscriptionPort,
    progressProjectMeta: {
      resolveProjectCreatedAtMs: vi.fn(async () => PROJECT_CREATED_AT_MS),
    } as OpsPanelProjectMetaPort,
    notify: { panelChanged: (params) => notify(params) },
    log: () => {},
  });
  return { service, repo, notify, dbPath: resolvedDbPath };
}

let cleanup: Array<Promise<void>> = [];

describe("progress ledger service", () => {
  beforeEach(() => {
    cleanup = [];
  });

  afterEach(async () => {
    await Promise.allSettled(cleanup);
  });

  it("系统锚条目（验收 #1）：首触幂等播种 PRG-0001「项目初始化」，createdAt 取项目真实创建时间；反复触达不重复播种", async () => {
    const h = await buildHarness();
    cleanup.push(rm(h.dbPath, { recursive: true, force: true }).catch(() => {}));
    const first = await h.service.getProgressView({ workspacePath: WORKSPACE, actor: MASTER });
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]?.id).toBe("PRG-0001");
    expect(first.entries[0]?.title).toBe("项目初始化");
    expect(first.entries[0]?.createdBy).toBe("system");
    expect(first.entries[0]?.createdAt).toBe(new Date(PROJECT_CREATED_AT_MS).toISOString());
    // 幂等：读取/追加触达都补不进第二条 system 锚；锚恒在时间正序首位。
    await h.service.getProgressView({ workspacePath: WORKSPACE, actor: USER });
    await h.service.appendProgress({ workspacePath: WORKSPACE, title: "里程碑", actor: MASTER });
    const view = await h.service.getProgressView({ workspacePath: WORKSPACE, actor: MASTER });
    expect(view.entries.filter((entry) => entry.createdBy === "system")).toHaveLength(1);
    expect(view.entries[0]?.createdBy).toBe("system");
  });

  it("master 追加（验收 #2）：编号递增、时间正序追加到底部；无事件面——只广播不唤醒", async () => {
    const h = await buildHarness();
    cleanup.push(rm(h.dbPath, { recursive: true, force: true }).catch(() => {}));
    const e1 = await h.service.appendProgress({
      workspacePath: WORKSPACE,
      title: "冷启动完成",
      body: "首批内容上线",
      links: ["docs/plan.md"],
      actor: MASTER,
    });
    // PRG-0001 是系统锚，master 首条从 PRG-0002 起。
    expect(e1.id).toBe("PRG-0002");
    await h.service.appendProgress({ workspacePath: WORKSPACE, title: "第二条", actor: MASTER });
    const view = await h.service.getProgressView({ workspacePath: WORKSPACE, actor: MASTER });
    expect(view.entries.map((entry) => entry.id)).toEqual(["PRG-0001", "PRG-0002", "PRG-0003"]);
    expect(view.entries[1]?.body).toBe("首批内容上线");
    expect(view.entries[1]?.links).toEqual(["docs/plan.md"]);
    // 无事件面（spec §4）：写动作只有 panelChanged 广播，无任何唤醒投递。
    expect(h.notify).toHaveBeenCalled();
  });

  it("权限矩阵（验收 #5/#6）：worker 不读不写；user 只读不可写；系统锚删除拒绝", async () => {
    const h = await buildHarness();
    cleanup.push(rm(h.dbPath, { recursive: true, force: true }).catch(() => {}));
    await expect(
      h.service.getProgressView({ workspacePath: WORKSPACE, actor: worker("wkr-dev") }),
    ).rejects.toThrow(/Workers cannot read/);
    await expect(
      h.service.appendProgress({ workspacePath: WORKSPACE, title: "t", actor: worker("wkr-dev") }),
    ).rejects.toThrow(/Only master/);
    await h.service.appendProgress({ workspacePath: WORKSPACE, title: "m1", actor: MASTER });
    await expect(
      h.service.updateProgress({
        workspacePath: WORKSPACE,
        entryId: "PRG-0002",
        title: "x",
        actor: worker("wkr-dev"),
      }),
    ).rejects.toThrow(/Only master/);
    await expect(
      h.service.deleteProgress({
        workspacePath: WORKSPACE,
        entryId: "PRG-0002",
        actor: worker("wkr-dev"),
      }),
    ).rejects.toThrow(/Only master/);
    await expect(
      h.service.appendProgress({ workspacePath: WORKSPACE, title: "t", actor: USER }),
    ).rejects.toThrow(/Only master/);
    await expect(
      h.service.deleteProgress({ workspacePath: WORKSPACE, entryId: "PRG-0001", actor: MASTER }),
    ).rejects.toThrow(/system anchor/);
    // user 可读（UI 进度 tab 的读取面）。
    const userView = await h.service.getProgressView({ workspacePath: WORKSPACE, actor: USER });
    expect(userView.entries).toHaveLength(2);
  });

  it("原位维护制（验收 #4/#5）：update 只改传入字段且 createdAt 不变；空串/空数组清空；软删后消失且编号不复用", async () => {
    const h = await buildHarness();
    cleanup.push(rm(h.dbPath, { recursive: true, force: true }).catch(() => {}));
    const created = await h.service.appendProgress({
      workspacePath: WORKSPACE,
      title: "原始标题",
      body: "原始详情",
      links: ["a.md"],
      actor: MASTER,
    });
    expect(created.id).toBe("PRG-0002");
    // 只更显式传入字段（账本只呈现最终态，无修订史）。
    const updated = await h.service.updateProgress({
      workspacePath: WORKSPACE,
      entryId: "PRG-0002",
      title: "修正标题",
      actor: MASTER,
    });
    expect(updated.title).toBe("修正标题");
    expect(updated.body).toBe("原始详情");
    expect(updated.links).toEqual(["a.md"]);
    expect(updated.createdAt).toBe(created.createdAt);
    // body 空串清空详情、links 空数组清空链接（COALESCE 只回退 null，空值语义直达）。
    const cleared = await h.service.updateProgress({
      workspacePath: WORKSPACE,
      entryId: "PRG-0002",
      body: "",
      links: [],
      actor: MASTER,
    });
    expect(cleared.body).toBeUndefined();
    expect(cleared.links).toBeUndefined();
    // 软删：列表消失（UI 无痕）；重复删与改已删目标都拒绝。
    await h.service.deleteProgress({ workspacePath: WORKSPACE, entryId: "PRG-0002", actor: MASTER });
    const view = await h.service.getProgressView({ workspacePath: WORKSPACE, actor: MASTER });
    expect(view.entries.map((entry) => entry.id)).toEqual(["PRG-0001"]);
    await expect(
      h.service.deleteProgress({ workspacePath: WORKSPACE, entryId: "PRG-0002", actor: MASTER }),
    ).rejects.toThrow(/not found/);
    await expect(
      h.service.updateProgress({
        workspacePath: WORKSPACE,
        entryId: "PRG-0002",
        title: "x",
        actor: MASTER,
      }),
    ).rejects.toThrow(/not found/);
    // 编号不复用（spec §2）：软删不释放编号，追加跳到 PRG-0003。
    const next = await h.service.appendProgress({ workspacePath: WORKSPACE, title: "新条目", actor: MASTER });
    expect(next.id).toBe("PRG-0003");
    // 锚可编辑（spec §3，用户确认的不对称设计：可改不可删——delete 拒绝已在本用例前段验证）。
    const anchorEdit = await h.service.updateProgress({
      workspacePath: WORKSPACE,
      entryId: "PRG-0001",
      title: "项目初始化（已充实）",
      actor: MASTER,
    });
    expect(anchorEdit.title).toBe("项目初始化（已充实）");
  });

  it("重启持久化（验收 #7）：重开库后现存条目不丢、软删不复活、锚不重播种", async () => {
    const dbPath = join(await mkdtemp(join(tmpdir(), "robinrun-progress-ledger-")), "tasks-index.sqlite");
    cleanup.push(rm(dbPath, { recursive: true, force: true }).catch(() => {}));
    const first = await buildHarness(dbPath);
    await first.service.appendProgress({ workspacePath: WORKSPACE, title: "保留条目", actor: MASTER });
    await first.service.appendProgress({ workspacePath: WORKSPACE, title: "删掉条目", actor: MASTER });
    await first.service.deleteProgress({ workspacePath: WORKSPACE, entryId: "PRG-0003", actor: MASTER });
    await first.repo.close();

    // 新服务实例（模拟进程重启）：现存条目保持、软删行不可见、system 锚不重复播种。
    const second = await buildHarness(dbPath);
    const view = await second.service.getProgressView({ workspacePath: WORKSPACE, actor: MASTER });
    expect(view.entries.map((entry) => entry.id)).toEqual(["PRG-0001", "PRG-0002"]);
    expect(view.entries[1]?.title).toBe("保留条目");
    expect(view.entries.filter((entry) => entry.createdBy === "system")).toHaveLength(1);
    await second.repo.close();
  });
});
