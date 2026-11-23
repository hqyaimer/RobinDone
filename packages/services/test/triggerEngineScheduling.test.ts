// 触发器引擎调度回归（2026-11-19 实测 bug）：到点守卫曾用 computeNextFireMs 重算判定
// 是否到点，而 interval 的锚点推进公式在到点时刻重算恒返回下一个整锚点（整整一个周期
// 之后），守卫误判为「未真正到点」→ 无限重排，interval/cron 触发器永不投递。
// 本用例用伪定时器精确越过边界，锁定「到点必须投递 + 周期持续推进」两个不变量。
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTriggerEngineService,
  type TriggerEngineOptions,
} from "../src/trigger-engine/engine.js";

const T0 = new Date("2026-11-19T08:00:00.000Z");
const TRIGGER_ID = "trg-aaa11111";

let workspace = "";

async function writeRegistry(): Promise<string> {
  const triggersRoot = join(workspace, ".robinrun", "triggers");
  await mkdir(triggersRoot, { recursive: true });
  const registryPath = join(triggersRoot, "triggers.json");
  await writeFile(
    registryPath,
    `${JSON.stringify(
      {
        version: 1,
        triggers: [
          {
            id: TRIGGER_ID,
            name: "interval-regression",
            ownerAgentId: "master",
            groupId: null,
            config: { kind: "interval", intervalMinutes: 2 },
            status: "active",
            consecutiveFailures: 0,
            createdAt: T0.toISOString(),
            updatedAt: T0.toISOString(),
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
  return registryPath;
}

/**
 * 伪定时器只走 vitest 的虚拟时间轴；引擎回调里发起的真实 fs 操作依赖真实事件循环轮转。
 * toFake 刻意不含 setImmediate——用它泵真实事件循环，让 fs promise 得以完成。
 */
async function pump(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.resolve();
  }
}

/** 反复小幅推进虚拟时间 + 泵真实循环，直到条件满足；总推进量保持在下一个边界之前。 */
async function until(
  cond: () => boolean | Promise<boolean>,
  label: string,
  dump?: () => string[],
): Promise<void> {
  const check = async (): Promise<boolean> => Boolean(await cond());
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await vi.advanceTimersByTimeAsync(20);
    await pump(5);
  }
  if (!(await check())) {
    // 诊断输出：引擎日志尾部，失败时随断言一起打印，便于定位事件丢失层级。
    console.error(`[engine logs] ${label}\n${(dump?.() ?? []).slice(-20).join("\n")}`);
  }
  expect(await check(), label).toBe(true);
}

describe("trigger engine scheduling", () => {
  let engine: ReturnType<typeof createTriggerEngineService> | undefined;
  let onRejection: ((reason: unknown) => void) | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "robinrun-trg-eng-"));
  });

  afterEach(async () => {
    if (onRejection !== undefined) process.off("unhandledRejection", onRejection);
    onRejection = undefined;
    await engine?.dispose();
    engine = undefined;
    vi.useRealTimers();
    await rm(workspace, { recursive: true, force: true });
  });

  it("interval 触发器到点必须投递，且周期持续推进不无限重排", async () => {
    vi.useFakeTimers({
      now: T0.getTime(),
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const registryPath = await writeRegistry();

    // dispatch 端口形状：TriggerDispatchPort = { dispatchTriggerEvent(batch) }。
    const dispatchTriggerEvent = vi.fn(async () => ({ taskId: "sess-bound" }));
    const logs: string[] = [];
    const options: TriggerEngineOptions = {
      listWorkspaces: async () => [{ workspacePath: workspace }],
      dispatch: { dispatchTriggerEvent },
      pollIntervalMs: 15_000,
      debounceMs: 50,
      log: (message) => logs.push(message),
    };
    engine = createTriggerEngineService(options);

    // 首轮 pollTick 完成挂载并 arm 调度（fs 操作真实完成后再越过边界）。
    await until(
      () => logs.some((message) => message.includes("mounted workspace")),
      "engine should mount the workspace on the initial poll",
    );
    // 「mounted」日志先于 rebuildSchedules（同一异步链的后续段）：这里必须泵足真实
    // 事件循环让 arm 完成后再大步推进，否则定时器落在推进窗口之外（抖动根因）。
    await pump(50);

    // 引擎侧 void 调用会吞掉异步异常：挂到进程级钩子转记到 logs 供诊断。
    onRejection = (reason: unknown): void => {
      logs.push(`UNHANDLED REJECTION: ${String(reason)}`);
    };
    process.on("unhandledRejection", onRejection);

    // 越过第一个 2 分钟边界：必须投递（修复前这里被守卫无限重排，永不投递）。
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 500);
    await until(
      () => dispatchTriggerEvent.mock.calls.length >= 1,
      "first scheduled fire should dispatch",
      () => logs,
    );

    const firstBatch = dispatchTriggerEvent.mock.calls[0]?.[0] as {
      sessionKey: string;
      triggerId: string;
      subscriberAgentId: string;
      events: Array<{ kind: string; summary: string }>;
    };
    expect(firstBatch.sessionKey).toBe(`trigger:${TRIGGER_ID}`);
    expect(firstBatch.triggerId).toBe(TRIGGER_ID);
    expect(firstBatch.subscriberAgentId).toBe("master");
    expect(firstBatch.events[0]?.kind).toBe("schedule");
    expect(firstBatch.events[0]?.summary).toContain("every 2 min");

    // 引擎侧 lastFireAt 落盘（读盘-改-原子写链路）。
    await until(async () => {
      const raw = JSON.parse(await readFile(registryPath, "utf8")) as {
        triggers: Array<{ lastFireAt?: string }>;
      };
      return raw.triggers[0]?.lastFireAt !== undefined;
    }, "engine should persist lastFireAt after the fire");

    // 第二个周期继续投递：锚点推进到 lastFireAt + 2min，不得停摆。
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 500);
    await until(
      () => dispatchTriggerEvent.mock.calls.length >= 2,
      "second scheduled fire should dispatch",
      () => logs,
    );
  });

  // 伪删除（2026-11-21 实测裁决，与会话/智能体一致）：deleteTrigger 写 deleted=true +
  // 停用 + 解除组订阅，调度计时器立即清除；到点不再投递；快照与 webhook 同源排除
  // （webhook 路由回归由 resolveRoute 的 deleted 守卫覆盖，这里锁调度/快照/注册表面）。
  it("deleteTrigger 软删除：调度停摆、快照排除、注册表条目保留", async () => {
    vi.useFakeTimers({
      now: T0.getTime(),
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const registryPath = await writeRegistry();
    const dispatchTriggerEvent = vi.fn(async () => ({ taskId: "sess-bound" }));
    const logs: string[] = [];
    engine = createTriggerEngineService({
      listWorkspaces: async () => [{ workspacePath: workspace }],
      dispatch: { dispatchTriggerEvent },
      pollIntervalMs: 15_000,
      debounceMs: 50,
      log: (message) => logs.push(message),
    });
    await until(
      () => logs.some((message) => message.includes("mounted workspace")),
      "engine should mount the workspace on the initial poll",
    );
    await pump(50);

    const deleted = await engine.deleteTrigger({ workspacePath: workspace, triggerId: TRIGGER_ID });
    expect(deleted.deleted).toBe(true);
    expect(deleted.status).toBe("deactivated");
    expect(deleted.groupId).toBeNull();

    // 快照立即排除（UI 触发器文件夹不再渲染该条目）。
    const snapshot = await engine.getSnapshot({ workspacePath: workspace });
    expect(snapshot.triggers).toHaveLength(0);

    // 注册表条目保留（伪删除语义：审计与历史可追溯）。
    const raw = JSON.parse(await readFile(registryPath, "utf8")) as {
      triggers: Array<{ id: string; deleted?: boolean; status: string }>;
    };
    expect(raw.triggers[0]).toMatchObject({ id: TRIGGER_ID, deleted: true, status: "deactivated" });

    // 推进远超一个调度周期：不再投递（删除前 armed 的计时器已被 rebuild 清除）。
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await pump(20);
    expect(dispatchTriggerEvent).not.toHaveBeenCalled();

    // 重复删除幂等（按首次结果收口）。
    const again = await engine.deleteTrigger({ workspacePath: workspace, triggerId: TRIGGER_ID });
    expect(again.deleted).toBe(true);
  });

  // UI"清空会话"（2026-11-20）：会话保留、消息归零、身份按当前订阅者重置。
  // 锁四个不变量：绑定不动（清空不是删除）、tasks 端口收到原 taskId + 注册表订阅者、
  // 无绑定时幂等空转。
  it("resetTriggerSession 清空绑定会话并携带订阅者身份，绑定保持不动", async () => {
    const clearTask = vi.fn(async () => undefined);
    const logs: string[] = [];
    const options: TriggerEngineOptions = {
      // 不挂载工作区（reset 经 ensureWorkspace 按需加载），轮询间隔拉长避免并发干扰。
      listWorkspaces: async () => [],
      dispatch: { dispatchTriggerEvent: async () => ({ taskId: "unused" }) },
      tasks: { clearTask },
      pollIntervalMs: 60_000,
      debounceMs: 50,
      log: (message) => logs.push(message),
    };
    engine = createTriggerEngineService(options);

    // 注册表提供订阅者（ownerAgentId），绑定文件提供原 taskId。
    await writeRegistry();
    const stateDir = join(workspace, ".robinrun", "triggers", "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "sessions.json"),
      `${JSON.stringify({ version: 1, bindings: { [`trigger:${TRIGGER_ID}`]: "sess-old" } })}\n`,
    );

    const result = await engine.resetTriggerSession({
      workspacePath: workspace,
      sessionKey: `trigger:${TRIGGER_ID}`,
    });
    expect(result).toEqual({ reset: true, taskId: "sess-old" });
    expect(clearTask).toHaveBeenCalledOnce();
    expect(clearTask.mock.calls[0]?.[0]).toMatchObject({
      taskId: "sess-old",
      workspacePath: workspace,
      subscriberAgentId: "master",
    });
    // 绑定不动：清空是「会话保留」，sessions.json 原样。
    const persisted = JSON.parse(await readFile(join(stateDir, "sessions.json"), "utf8")) as {
      bindings: Record<string, string>;
    };
    expect(persisted.bindings[`trigger:${TRIGGER_ID}`]).toBe("sess-old");
    const snapshot = await engine.getSnapshot({ workspacePath: workspace });
    expect(snapshot.sessionBindings[`trigger:${TRIGGER_ID}`]).toBe("sess-old");

    // 无绑定 key：幂等空转。
    const second = await engine.resetTriggerSession({
      workspacePath: workspace,
      sessionKey: `trigger:${TRIGGER_ID}-missing`,
    });
    expect(second).toEqual({ reset: false });
    expect(clearTask).toHaveBeenCalledOnce();
  });

  // 忙感知接线回归（2026-11-22 二次实测）：isTaskBusy 曾被误接进 dispatch 端口对象
  // 而非引擎选项顶层（TS 对 spread 属性不做多余属性检查，typecheck 拦不住），引擎
  // 静默拿不到忙查询、聚合器退化为逐批投递。本用例走真实 webhook 路径 + 真实定时器
  // （绕开本文件伪定时器用例的 fs 抖动），锁「引擎选项 isTaskBusy → 聚合器」端到端。
  it("engine options.isTaskBusy wiring: busy session holds webhook events, idle merges one batch", async () => {
    const triggersRoot = join(workspace, ".robinrun", "triggers");
    await mkdir(join(triggersRoot, "state"), { recursive: true });
    const registryPath = join(triggersRoot, "triggers.json");
    const WEBHOOK_PATH = "hooks/busy-test";
    const TOKEN = "a".repeat(32);
    await writeFile(
      registryPath,
      `${JSON.stringify(
        {
          version: 1,
          triggers: [
            {
              id: TRIGGER_ID,
              name: "webhook-busy",
              ownerAgentId: "master",
              groupId: null,
              config: { kind: "webhook", path: WEBHOOK_PATH, token: TOKEN },
              status: "active",
              consecutiveFailures: 0,
              createdAt: T0.toISOString(),
              updatedAt: T0.toISOString(),
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
    // 预置绑定：让事件走忙感知路径（无绑定时按新会话直投，无需忙检测）。
    await writeFile(
      join(triggersRoot, "state", "sessions.json"),
      `${JSON.stringify({ version: 1, bindings: { [`trigger:${TRIGGER_ID}`]: "sess-busy" } })}\n`,
      "utf8",
    );

    const dispatchTriggerEvent = vi.fn(async () => ({ taskId: "sess-busy" }));
    const logs: string[] = [];
    let busy = true;
    engine = createTriggerEngineService({
      listWorkspaces: async () => [{ workspacePath: workspace }],
      dispatch: { dispatchTriggerEvent },
      isTaskBusy: async () => busy,
      pollIntervalMs: 60_000,
      debounceMs: 30,
      log: (message) => logs.push(message),
    });

    // 真实定时器轮询等待：不用伪定时器，fs/webhook 全走真实事件循环。
    const waitFor = async (
      cond: () => boolean | Promise<boolean>,
      label: string,
    ): Promise<void> => {
      for (let i = 0; i < 200; i++) {
        if (await cond()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(await cond(), label).toBe(true);
    };

    let baseUrl: string | undefined;
    await waitFor(async () => {
      const snapshot = await engine!.getSnapshot({ workspacePath: workspace });
      baseUrl = snapshot.webhookBaseUrl;
      return baseUrl !== undefined;
    }, "webhook base url should be available after mount");

    const post = async (): Promise<number> =>
      (
        await fetch(`${baseUrl}/${WEBHOOK_PATH}?token=${TOKEN}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ n: Math.random() }),
        })
      ).status;

    // 忙：两个 webhook 事件都留在聚合桶，零投递（hold 日志只报一次）。
    expect(await post()).toBe(202);
    expect(await post()).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(dispatchTriggerEvent).not.toHaveBeenCalled();
    expect(logs.some((message) => message.includes("hold trigger:"))).toBe(true);

    // 空闲：重试轮合并为一条投递（2 事件），此后无追加投递。
    busy = false;
    await waitFor(
      () => dispatchTriggerEvent.mock.calls.length >= 1,
      "merged delivery should arrive after the session goes idle",
    );
    const batch = dispatchTriggerEvent.mock.calls[0]?.[0] as {
      existingTaskId?: string;
      events: Array<{ summary: string }>;
    };
    expect(batch.existingTaskId).toBe("sess-busy");
    expect(batch.events).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(dispatchTriggerEvent).toHaveBeenCalledTimes(1);
  });
});
