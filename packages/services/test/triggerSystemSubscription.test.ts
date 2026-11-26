// 系统特权订阅（2026-11-24 需求/审批/反馈面板引入的平台能力）引擎级回归：
// ensureSystemSubscription 幂等播种 + 不可停用/不可删除（引擎侧双层保护的一半，
// 工具侧见 manage-triggers handler 用例）。docs/trigger-system.md「系统特权订阅」。
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTriggerEngineService,
  type TriggerEngineOptions,
} from "../src/trigger-engine/engine.js";

const SUBSCRIPTION = {
  id: "trg-ops-panel",
  name: "运营面板订阅",
  events: ["requirement.created", "approval.decided", "feedback.created"],
  readme: "# 运营面板订阅\n\n系统特权订阅：不可停用、不可删除。",
} as const;

describe("trigger engine system subscription", () => {
  let workspace = "";
  let engine: ReturnType<typeof createTriggerEngineService> | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "robinrun-trg-sys-"));
  });

  afterEach(async () => {
    await engine?.dispose();
    engine = undefined;
    await rm(workspace, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function buildEngine(): ReturnType<typeof createTriggerEngineService> {
    const options: TriggerEngineOptions = {
      listWorkspaces: async () => [{ workspacePath: workspace }],
      dispatch: { dispatchTriggerEvent: async () => ({ taskId: "sess-x" }) },
      pollIntervalMs: 60_000,
      debounceMs: 50,
      log: () => {},
    };
    return createTriggerEngineService(options);
  }

  function registryPath(): string {
    return join(workspace, ".robinrun", "triggers", "triggers.json");
  }

  it("播种：写入 system 条目 + README，事件与状态正确", async () => {
    engine = buildEngine();
    const entry = await engine.ensureSystemSubscription({
      workspacePath: workspace,
      subscription: SUBSCRIPTION,
    });
    expect(entry.system).toBe(true);
    expect(entry.status).toBe("active");
    expect(entry.ownerAgentId).toBe("master");
    expect(entry.groupId).toBeNull();
    expect(entry.config).toEqual({ kind: "system", events: [...SUBSCRIPTION.events] });

    const registry = JSON.parse(await readFile(registryPath(), "utf8")) as {
      triggers: Array<{ id: string; system?: boolean }>;
    };
    expect(registry.triggers.filter((candidate) => candidate.system === true)).toHaveLength(1);

    const readme = await readFile(
      join(workspace, ".robinrun", "triggers", SUBSCRIPTION.id, "README.md"),
      "utf8",
    );
    expect(readme).toContain("不可停用");
  });

  it("幂等：重复播种不扰动注册表（updatedAt 不变）", async () => {
    engine = buildEngine();
    const first = await engine.ensureSystemSubscription({
      workspacePath: workspace,
      subscription: SUBSCRIPTION,
    });
    const second = await engine.ensureSystemSubscription({
      workspacePath: workspace,
      subscription: SUBSCRIPTION,
    });
    expect(second.updatedAt).toBe(first.updatedAt);
    const registry = JSON.parse(await readFile(registryPath(), "utf8")) as {
      triggers: unknown[];
    };
    expect(registry.triggers).toHaveLength(1);
  });

  it("平台改名：订阅 name 漂移经幂等比对自动重播种（2026-11-25 改名裁决）", async () => {
    engine = buildEngine();
    const first = await engine.ensureSystemSubscription({
      workspacePath: workspace,
      subscription: SUBSCRIPTION,
    });
    // name 是平台维护字段（模型不可改，ManageTriggers/引擎双层拒绝）——平台侧改名后
    // 存量工作区靠 name 比对失配自动重播种，不该停留在旧名（修复前只比事件/wakeRules，
    // 改常量对已播种工作区无效）。
    const renamed = {
      ...SUBSCRIPTION,
      name: "运营面板",
      readme: "# 运营面板\n\n系统特权订阅：不可停用、不可删除。",
    };
    const renamedEntry = await engine.ensureSystemSubscription({
      workspacePath: workspace,
      subscription: renamed,
    });
    expect(renamedEntry.name).toBe("运营面板");
    expect(renamedEntry.createdAt).toBe(first.createdAt);
    const registry = JSON.parse(await readFile(registryPath(), "utf8")) as {
      triggers: Array<{ id: string; name: string; status: string; system?: boolean }>;
    };
    expect(registry.triggers).toHaveLength(1);
    expect(registry.triggers[0]?.name).toBe("运营面板");
    expect(registry.triggers[0]?.status).toBe("active");
    expect(registry.triggers[0]?.system).toBe(true);
    // README 随重播种覆盖为新文案（幂等命中时不重写，重播种路径写）。
    const readme = await readFile(
      join(workspace, ".robinrun", "triggers", SUBSCRIPTION.id, "README.md"),
      "utf8",
    );
    expect(readme).toContain("# 运营面板\n");
  });

  it("保护：setTriggerStatus / deleteTrigger 对 system 条目拒绝", async () => {
    engine = buildEngine();
    await engine.ensureSystemSubscription({
      workspacePath: workspace,
      subscription: SUBSCRIPTION,
    });
    await expect(
      engine.setTriggerStatus({
        workspacePath: workspace,
        triggerId: SUBSCRIPTION.id,
        status: "deactivated",
      }),
    ).rejects.toThrow(/system subscription/);
    await expect(
      engine.deleteTrigger({ workspacePath: workspace, triggerId: SUBSCRIPTION.id }),
    ).rejects.toThrow(/system subscription/);
    // 注册表未被破坏：条目仍 active 且未删除。
    const registry = JSON.parse(await readFile(registryPath(), "utf8")) as {
      triggers: Array<{ id: string; status: string; deleted?: boolean }>;
    };
    expect(registry.triggers[0]?.status).toBe("active");
    expect(registry.triggers[0]?.deleted).toBeUndefined();
  });

  it("破坏重建：外部把条目改坏（伪删除/非 system）后播种恢复完好形态", async () => {
    engine = buildEngine();
    await engine.ensureSystemSubscription({
      workspacePath: workspace,
      subscription: SUBSCRIPTION,
    });
    const triggersRoot = join(workspace, ".robinrun", "triggers");
    await writeFile(
      registryPath(),
      `${JSON.stringify(
        {
          version: 1,
          triggers: [
            {
              id: SUBSCRIPTION.id,
              name: "运营面板订阅",
              ownerAgentId: "master",
              groupId: null,
              config: { kind: "system", events: [...SUBSCRIPTION.events] },
              status: "deactivated",
              consecutiveFailures: 0,
              deleted: true,
              createdAt: "2026-11-24T00:00:00.000Z",
              updatedAt: "2026-11-24T00:00:00.000Z",
            },
          ],
          groups: [],
          profiles: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const restored = await engine.ensureSystemSubscription({
      workspacePath: workspace,
      subscription: SUBSCRIPTION,
    });
    expect(restored.status).toBe("active");
    expect(restored.system).toBe(true);
    expect(restored.deleted).toBeUndefined();
    // createdAt 保留首播时间（连续性），updatedAt 推进。
    expect(restored.createdAt).toBe("2026-11-24T00:00:00.000Z");
    expect(stat(join(triggersRoot, SUBSCRIPTION.id))).toBeDefined();
  });
});

// 系统订阅唤醒投递（2026-11-24 用户裁决：面板 = 数据面，主智能体 = 处理方，订阅是
// 唯一通道）：面板事件的唤醒按标准触发器会话模型投进 `trigger:<id>` 绑定会话——绑定
// 解析/写回/sessions.json 持久化与聚合器投递链同一套，但不经聚合器（串行/不合并由
// 面板服务唤醒队列保证），正文按条目渲染后经 promptOverride 直通。
describe("trigger engine system subscription wakeup dispatch", () => {
  let workspace = "";
  let engine: ReturnType<typeof createTriggerEngineService> | undefined;
  let dispatched: Array<Parameters<TriggerEngineOptions["dispatch"]["dispatchTriggerEvent"]>[0]> =
    [];

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "robinrun-trg-wkup-"));
    dispatched = [];
  });

  afterEach(async () => {
    await engine?.dispose();
    engine = undefined;
    await rm(workspace, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function buildEngine(): ReturnType<typeof createTriggerEngineService> {
    const options: TriggerEngineOptions = {
      // 轮询不参与挂载（[]）：排除 pollTick 旧盘读回退内存注册表的竞态干扰，本组用例
      // 只验证播种 → 唤醒投递的确定性链路（挂载全部按需发生）。
      listWorkspaces: async () => [],
      dispatch: {
        dispatchTriggerEvent: async (batch) => {
          dispatched.push(batch);
          return { taskId: batch.existingTaskId ?? "sess-wakeup-bound" };
        },
      },
      pollIntervalMs: 60_000,
      debounceMs: 50,
      log: () => {},
    };
    return createTriggerEngineService(options);
  }

  it("首投：新建绑定（无 existingTaskId）、promptOverride 直通、绑定落 sessions.json + 快照", async () => {
    engine = buildEngine();
    await engine.ensureSystemSubscription({ workspacePath: workspace, subscription: SUBSCRIPTION });
    const { taskId } = await engine.dispatchSystemSubscriptionWakeup({
      workspacePath: workspace,
      triggerId: SUBSCRIPTION.id,
      prompt: "Ops panel wakeup: REQ-0001 awaiting decision.",
    });
    expect(taskId).toBe("sess-wakeup-bound");
    expect(dispatched).toHaveLength(1);
    const batch = dispatched[0]!;
    expect(batch.sessionKey).toBe(`trigger:${SUBSCRIPTION.id}`);
    expect(batch.triggerId).toBe(SUBSCRIPTION.id);
    expect(batch.triggerName).toBe(SUBSCRIPTION.name);
    expect(batch.subscriberAgentId).toBe("master");
    expect(batch.existingTaskId).toBeUndefined();
    expect(batch.events).toEqual([]);
    expect(batch.promptOverride).toBe("Ops panel wakeup: REQ-0001 awaiting decision.");

    const snapshot = await engine.getSnapshot({ workspacePath: workspace });
    expect(snapshot.sessionBindings[`trigger:${SUBSCRIPTION.id}`]).toBe("sess-wakeup-bound");
    const persisted = JSON.parse(
      await readFile(join(workspace, ".robinrun", "triggers", "state", "sessions.json"), "utf8"),
    ) as { bindings: Record<string, string> };
    expect(persisted.bindings[`trigger:${SUBSCRIPTION.id}`]).toBe("sess-wakeup-bound");
  });

  it("续投：已绑定的会话按 existingTaskId 续用（一 key 一绑定会话）", async () => {
    engine = buildEngine();
    await engine.ensureSystemSubscription({ workspacePath: workspace, subscription: SUBSCRIPTION });
    await engine.dispatchSystemSubscriptionWakeup({
      workspacePath: workspace,
      triggerId: SUBSCRIPTION.id,
      prompt: "first",
    });
    await engine.dispatchSystemSubscriptionWakeup({
      workspacePath: workspace,
      triggerId: SUBSCRIPTION.id,
      prompt: "second",
    });
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1]!.existingTaskId).toBe("sess-wakeup-bound");
    expect(dispatched[1]!.promptOverride).toBe("second");
  });

  it("订阅缺失：未播种（或注册表被破坏）时拒绝投递，不凭空造会话", async () => {
    engine = buildEngine();
    await expect(
      engine.dispatchSystemSubscriptionWakeup({
        workspacePath: workspace,
        triggerId: SUBSCRIPTION.id,
        prompt: "orphan",
      }),
    ).rejects.toThrow(/not present in the registry/);
    expect(dispatched).toHaveLength(0);
  });
});
