// 常驻脚本触发器托管回归（2026-11-21 常驻模型裁决，docs/trigger-system.md
// 「触发器类型 → 脚本」修订节）：
//  - active 即拉起（真实 spawn node + 引擎生成桥接模块注入 robinrun.emit）；
//  - 事件上报：emit → 引擎契约校验 → ack → script-result 事件投递（计数清零）；
//  - 契约违例：nack + script-error 事件（进程不因此终止）；
//  - exit 0 → completed 终态（一次性脚本的自然完成）；
//  - 崩溃（exit 1）→ 计数递增 + 退避重启，连续 3 次 → error-paused + 熔断通知；
//  - 停用 → 优雅停止（shutdown 消息 → 宽限强杀），不计崩溃。
// 真实子进程（vitest 跑在 node 上，process.execPath 即 node）；退避序列用测试钩子压缩。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TriggerEntry } from "@robinrun/shared";
import {
  TriggerScriptSupervisor,
  type ScriptSupervisorCallbacks,
  type ScriptWorkspaceSnapshot,
} from "../src/trigger-engine/script-supervisor.js";
import type { TriggerEvent } from "../src/trigger-engine/contract.js";

const T0 = new Date("2026-11-21T08:00:00.000Z");
const TRIGGER_ID = "trg-bbb22222";

let workspace = "";

async function writeScriptEntry(source: string): Promise<void> {
  const scriptDir = join(workspace, ".robinrun", "triggers", TRIGGER_ID, "script");
  await mkdir(scriptDir, { recursive: true });
  await writeFile(join(scriptDir, "index.mjs"), source, "utf8");
}

function makeEntry(overrides: Partial<TriggerEntry> = {}): TriggerEntry {
  return {
    id: TRIGGER_ID,
    name: "resident-test",
    ownerAgentId: "master",
    groupId: null,
    config: { kind: "script", runtime: "node", entry: "index.mjs" },
    status: "active",
    consecutiveFailures: 0,
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
    ...overrides,
  };
}

interface Fixture {
  supervisor: TriggerScriptSupervisor;
  entry: TriggerEntry;
  events: TriggerEvent[];
  audits: Array<Record<string, unknown>>;
  circuitBreaks: Array<{ triggerId: string; consecutiveFailures: number }>;
  snapshot(): ScriptWorkspaceSnapshot;
  reconcile(): Promise<void>;
}

function makeFixture(entryOverrides: Partial<TriggerEntry> = {}): Fixture {
  const entry = makeEntry(entryOverrides);
  const events: TriggerEvent[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const circuitBreaks: Array<{ triggerId: string; consecutiveFailures: number }> = [];
  const callbacks: ScriptSupervisorCallbacks = {
    log: () => undefined,
    onEvent: (sessionKey, event) => {
      events.push({ ...event, summary: `${sessionKey}::${event.summary}` });
    },
    updateRuntimeState: async ({ triggerId, apply }) => {
      if (triggerId !== entry.id) return;
      apply(entry);
    },
    audit: async (_workspacePath, _triggerId, record) => {
      audits.push(record);
    },
    notifyCircuitBreak: (params) => {
      circuitBreaks.push({
        triggerId: params.triggerId,
        consecutiveFailures: params.consecutiveFailures,
      });
    },
  };
  const supervisor = new TriggerScriptSupervisor(callbacks, { backoffScheduleMs: [30, 30] });
  const snapshot = (): ScriptWorkspaceSnapshot => ({ workspacePath: workspace, triggers: [entry] });
  const reconcile = (): Promise<void> => supervisor.reconcile([snapshot()]);
  return { supervisor, entry, events, audits, circuitBreaks, snapshot, reconcile };
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timeout waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("TriggerScriptSupervisor（常驻脚本托管）", () => {
  let fixture: Fixture | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "robinrun-trg-script-"));
  });

  afterEach(async () => {
    await fixture?.supervisor.dispose();
    fixture = undefined;
    // Windows：进程刚退出/杀软扫描对"刚写入并执行过"的脚本文件有短暂句柄/扫描锁
    //（fast 节奏的用例总时长 <1s 也会撞上）——rm 重试兜底，锁释放后再清。
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await rm(workspace, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  });

  it("拉起 active 脚本：emit → ack → script-result 投递，exit 0 → completed 终态", async () => {
    fixture = makeFixture();
    await writeScriptEntry(
      `const seen = await globalThis.robinrun.emit({ summary: "hello", data: { hello: true } });
       process.exit(0);`,
    );
    await fixture.reconcile();

    await waitFor(
      () => fixture!.events.some((event) => event.kind === "script-result"),
      "script-result event delivered",
    );
    const event = fixture.events.find((candidate) => candidate.kind === "script-result");
    expect(event?.summary).toContain("trigger:trg-bbb22222::resident-test: hello");
    expect(event?.data).toEqual({ hello: true });
    // 成功事件清零计数 + lastFireAt 落盘。
    expect(fixture.entry.consecutiveFailures).toBe(0);
    expect(fixture.entry.lastFireAt).toBeDefined();
    expect(fixture.entry.lastResult).toBe("ok");

    await waitFor(() => fixture!.entry.status === "completed", "clean exit turns completed");
    expect(fixture.entry.consecutiveFailures).toBe(0);
    // 审计：start + event + exit。
    expect(fixture.audits.some((record) => record.action === "start")).toBe(true);
    expect(fixture.audits.some((record) => record.action === "exit" && record.code === 0)).toBe(
      true,
    );
  });

  it("契约违例：nack + script-error 事件，进程不因此终止", async () => {
    fixture = makeFixture({
      contract: { requiredFields: ["mustExist"] },
    });
    await writeScriptEntry(
      `try {
         await globalThis.robinrun.emit({ summary: "bad payload", data: { other: 1 } });
       } catch (error) {
         globalThis.__violation = String(error && error.message || error);
       }
       process.exit(globalThis.__violation ? 0 : 1);`,
    );
    await fixture.reconcile();

    await waitFor(
      () => fixture!.events.some((event) => event.kind === "script-error"),
      "script-error event delivered on contract violation",
    );
    expect(fixture.events[0]?.summary).toContain("sanity assertion failed");
    // completed：脚本捕获 nack 后按干净退出收口（进程未因违例被引擎终止）。
    await waitFor(() => fixture!.entry.status === "completed", "script exits cleanly after nack");
  });

  it("崩溃退避重启，连续 3 次熔断 error-paused + 通知", async () => {
    fixture = makeFixture();
    await writeScriptEntry(`process.exit(1);`);
    // 退避序列压缩为 30ms：reconcile 轮询驱动重启（与引擎 5s 轮询同语义）。
    for (let round = 0; round < 6; round += 1) {
      await fixture.reconcile();
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (fixture.entry.status === "error-paused") break;
    }
    await waitFor(() => fixture!.entry.status === "error-paused", "circuit break after 3 crashes");
    expect(fixture.entry.consecutiveFailures).toBe(3);
    expect(fixture.circuitBreaks).toEqual([{ triggerId: TRIGGER_ID, consecutiveFailures: 3 }]);
    expect(fixture.audits.filter((record) => record.action === "crash")).toHaveLength(3);
  });

  it("停用即优雅停止：shutdown → 进程树终止，不计崩溃", async () => {
    fixture = makeFixture();
    // 常驻型脚本：先上报一条事件，然后驻留不退出（等待引擎的 shutdown 通知）。
    await writeScriptEntry(
      `await globalThis.robinrun.emit({ summary: "resident", data: { live: true } });
       await new Promise((resolve) => setTimeout(resolve, 30_000));`,
    );
    await fixture.reconcile();
    await waitFor(
      () => fixture!.events.some((event) => event.kind === "script-result"),
      "resident script emitted its first event",
    );

    fixture.entry.status = "deactivated";
    await fixture.reconcile();
    await waitFor(
      () => fixture!.audits.some((record) => record.action === "stop"),
      "graceful stop audited",
      15_000,
    );
    // 停止不算崩溃：计数不变、状态保持 deactivated、无熔断。
    expect(fixture.entry.consecutiveFailures).toBe(0);
    expect(fixture.entry.status).toBe("deactivated");
    expect(fixture.circuitBreaks).toEqual([]);
  });

  // 2026-11-25 常驻配额可配置化（AppSettings triggerScriptResidentPerWorkspace /
  // triggerScriptResidentGlobalMax，默认 20/60）：resolveScriptQuotas 回调注入宿主设置，
  // 每轮 reconcile 起点读取——占满即 defer、放宽即拉起；回调抛错回退缺省不停摆。
  it("配额可配置：占满即 defer，放宽后下轮拉起；回调抛错回退缺省", async () => {
    const quotas = { perWorkspace: 1, globalMax: 10 };
    const logs: string[] = [];
    const entries = [makeEntry({ id: "trg-aaaaaaaa" }), makeEntry({ id: "trg-bbbbbbbb" })];
    const longRunningSource = `setInterval(() => {}, 1_000);`;
    for (const entry of entries) {
      const scriptDir = join(workspace, ".robinrun", "triggers", entry.id, "script");
      await mkdir(scriptDir, { recursive: true });
      await writeFile(join(scriptDir, "index.mjs"), longRunningSource, "utf8");
    }
    const supervisor = new TriggerScriptSupervisor(
      {
        log: (message) => logs.push(message),
        onEvent: () => undefined,
        updateRuntimeState: async () => undefined,
        audit: async () => undefined,
        notifyCircuitBreak: () => undefined,
        resolveScriptQuotas: async () => quotas,
      },
      { backoffScheduleMs: [30, 30] },
    );
    fixture = {
      supervisor,
      entry: entries[0]!,
      events: [],
      audits: [],
      circuitBreaks: [],
      snapshot: () => ({ workspacePath: workspace, triggers: entries }),
      reconcile: () => supervisor.reconcile([{ workspacePath: workspace, triggers: entries }]),
    };

    await fixture.reconcile();
    // perWorkspace=1：第一个拉起、第二个 defer。
    await waitFor(
      () => logs.some((line) => line.includes("starting resident script trg-aaaaaaaa")),
      "first script started",
    );
    await waitFor(
      // 消息附当前占用数（2026-11-25 真机复核防误读：上限值≠卡死计数），断言只锁前缀。
      () => logs.some((line) => line.includes("script start deferred (workspace quota 1,")),
      "second script deferred by workspace quota",
    );

    // 放宽配额：下一轮 reconcile 即拉起（无需重启）。
    quotas.perWorkspace = 5;
    await fixture.reconcile();
    await waitFor(
      () => logs.some((line) => line.includes("starting resident script trg-bbbbbbbb")),
      "second script started after quota raise",
    );

    // 全局配额同样生效：收窄到 1 → defer。
    quotas.perWorkspace = 5;
    quotas.globalMax = 1;
    const third = makeEntry({ id: "trg-cccccccc" });
    entries.push(third);
    const scriptDir = join(workspace, ".robinrun", "triggers", third.id, "script");
    await mkdir(scriptDir, { recursive: true });
    await writeFile(join(scriptDir, "index.mjs"), longRunningSource, "utf8");
    await fixture.reconcile();
    await waitFor(
      () => logs.some((line) => line.includes("script start deferred (global quota 1,")),
      "third script deferred by global quota",
    );

    // 回调抛错：回退缺省（20/60），不阻塞拉起。
    quotas.perWorkspace = 1;
    quotas.globalMax = 1;
    const fourth = makeEntry({ id: "trg-dddddddd" });
    entries.push(fourth);
    const fourthScriptDir = join(workspace, ".robinrun", "triggers", fourth.id, "script");
    await mkdir(fourthScriptDir, { recursive: true });
    await writeFile(join(fourthScriptDir, "index.mjs"), longRunningSource, "utf8");
    const failingSupervisor = new TriggerScriptSupervisor(
      {
        log: (message) => logs.push(message),
        onEvent: () => undefined,
        updateRuntimeState: async () => undefined,
        audit: async () => undefined,
        notifyCircuitBreak: () => undefined,
        resolveScriptQuotas: async () => {
          throw new Error("settings unavailable");
        },
      },
      { backoffScheduleMs: [30, 30] },
    );
    await failingSupervisor.reconcile([{ workspacePath: workspace, triggers: [fourth] }]);
    await waitFor(
      () => logs.some((line) => line.includes("starting resident script trg-dddddddd")),
      "script started despite quota callback failure (defaults apply)",
    );
    await failingSupervisor.dispose();
  });

  // 2026-11-25 spawn 竞态回归：脚本目录缺失时 spawn 的异步 'error' 事件（Windows ENOENT，
  // cwd 不存在）必须被 startProcess 挂载的处理器按崩溃收口——修复前 spawn 与处理器挂载之间
  // 被 await contentStampOf 让出事件循环，错误逃逸成 uncaught exception（vitest 报
  // Unhandled Errors，生产形态即 host 常驻服务崩溃）。
  it("脚本目录缺失：spawn 异步 error 按崩溃收口，无 uncaught exception", async () => {
    fixture = makeFixture();
    // 故意不写脚本文件/目录。
    await fixture.reconcile();
    await waitFor(
      () => fixture!.entry.consecutiveFailures === 1,
      "async spawn error counted as one crash",
    );
    expect(fixture.entry.lastResult).toBe("error");
    // 退避窗口内不重复拉起：计数停在 1。
    await fixture.reconcile();
    expect(fixture.entry.consecutiveFailures).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 幽灵计数回归（2026-11-25 真机缺陷报告复现：RobinRunOps 目验，配额 1/1 下 scheduled
  // 趟结束后 A+B 同时永久 deferred，而实际常驻进程数为 0）。设计不变量：oneshot 趟不占
  // 常驻配额（runningCount 只数 resident），趟结束（exit 0 → handleExit 删条目）后配额
  // 占用回到 fire 前状态——A 仍占位在跑、B 继续 defer，不出现"幽灵占位"。
  // ---------------------------------------------------------------------------

  it("幽灵计数回归：配额满载下 scheduled 一趟后，A 仍占位、B 继续 defer，无幽灵", async () => {
    const quotas = { perWorkspace: 1, globalMax: 1 };
    const logs: string[] = [];
    const makeResidentEntry = (id: string): TriggerEntry =>
      makeEntry({ id, config: { kind: "script", runtime: "node", entry: "index.mjs" } });
    const residentA = makeResidentEntry("trg-aaaaaaaa");
    const residentB = makeResidentEntry("trg-bbbbbbbb");
    const scheduledC = makeEntry({
      id: "trg-cccccccc",
      config: {
        kind: "script",
        runMode: "scheduled",
        schedule: { kind: "interval", intervalMinutes: 1 },
        runtime: "node",
        entry: "index.mjs",
      },
    });
    const longRunningSource = `setInterval(() => {}, 1_000);`;
    const oneshotSource = `await globalThis.robinrun.emit({ summary: "one pass", data: {} });
       process.exit(0);`;
    for (const entry of [residentA, residentB, scheduledC]) {
      const scriptDir = join(workspace, ".robinrun", "triggers", entry.id, "script");
      await mkdir(scriptDir, { recursive: true });
      await writeFile(
        join(scriptDir, "index.mjs"),
        entry === scheduledC ? oneshotSource : longRunningSource,
        "utf8",
      );
    }
    const supervisor = new TriggerScriptSupervisor(
      {
        log: (message) => logs.push(message),
        onEvent: () => undefined,
        updateRuntimeState: async ({ triggerId, apply }) => {
          const target = [residentA, residentB, scheduledC].find((e) => e.id === triggerId);
          if (target !== undefined) apply(target);
        },
        audit: async () => undefined,
        notifyCircuitBreak: () => undefined,
        resolveScriptQuotas: async () => quotas,
      },
      { backoffScheduleMs: [30, 30] },
    );
    const entries = [residentA, residentB, scheduledC];
    const snapshot = (): ScriptWorkspaceSnapshot => ({
      workspacePath: workspace,
      triggers: entries,
    });
    const reconcile = (): Promise<void> => supervisor.reconcile([snapshot()]);

    // 复现步骤 1-3：A 拉起占满配额，B 永久 defer。
    // deferred 行的主体 key 抽取（2026-11-25 日志增强后行尾带 resident-in-map 概要，
    // includes 全行匹配会把占位者误判为被 defer 者——必须按主体 key 精确判定）。
    const deferredKeyOf = (line: string): string | undefined =>
      /script start deferred \([^)]*\): .*::(trg-[0-9a-f]{8}) /.exec(line)?.[1];
    await reconcile();
    await waitFor(
      () => logs.some((line) => line.includes("starting resident script trg-aaaaaaaa")),
      "A started",
    );
    await reconcile();
    await waitFor(
      () =>
        logs.some((line) => deferredKeyOf(line) === "trg-bbbbbbbb") &&
        logs.every((line) => !line.includes("deferred") || deferredKeyOf(line) === "trg-bbbbbbbb"),
      "only B deferred while A occupies the single slot",
    );

    // 复现步骤 4：scheduled 趟 fire → emit → exit 0。
    await supervisor.spawnScheduledRun(snapshot(), scheduledC);
    await waitFor(
      () => logs.some((line) => line.includes("scheduled run trg-cccccccc finished cleanly")),
      "scheduled run finished cleanly",
    );

    // 复现步骤 5：趟结束后 reconcile ×2——A 必须仍在位（无 deferred 日志）、B 继续 defer。
    const deferredBefore = logs.filter((line) => line.includes("deferred")).length;
    await reconcile();
    await reconcile();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await reconcile();
    const deferredAfter = logs.filter((line) => line.includes("deferred"));
    const deferredKeysAfter = deferredAfter
      .map((line) => deferredKeyOf(line))
      .filter((key) => key !== undefined);
    expect(
      deferredKeysAfter.includes("trg-aaaaaaaa"),
      "A must NOT be deferred after the scheduled run (ghost slot regression)",
    ).toBe(false);
    expect(deferredKeysAfter.length - deferredBefore).toBeGreaterThanOrEqual(1);
    expect(deferredKeysAfter.every((key) => key === "trg-bbbbbbbb")).toBe(true);
    // A 的进程条目仍在 map（resident 占位）——间接验证：dispose 时 A 有进程可停。
    await supervisor.dispose();
  });

  // 幽灵计数防御（2026-11-25）：exit 事件丢失（真实环境杀软/进程收割竞态）时条目以
  // "child 已死仍在 map"的僵尸态占住配额。reconcile 开头的 sweepZombieEntries 按
  // exitedHandled 幂等补收口——僵尸被清、配额归还、期望态 active 的 A 正常重启。
  // 构造用纯假条目注入（不 spawn 真实 A）——真实子进程在本测试环境 kill 后句柄释放
  // 不确定，会让 afterEach rm 撞 EBUSY；清扫逻辑只依赖 child.exitCode/signalCode 字段。
  it("僵尸条目清扫：child 已死但 exit 未处理的条目在 reconcile 时被补收口并归还配额", async () => {
    const quotas = { perWorkspace: 1, globalMax: 1 };
    const logs: string[] = [];
    const audits: Array<Record<string, unknown>> = [];
    const residentA = makeEntry({ id: "trg-aaaaaaaa" });
    const residentB = makeEntry({ id: "trg-bbbbbbbb" });
    const longRunningSource = `setInterval(() => {}, 1_000);`;
    for (const entry of [residentA, residentB]) {
      const scriptDir = join(workspace, ".robinrun", "triggers", entry.id, "script");
      await mkdir(scriptDir, { recursive: true });
      await writeFile(join(scriptDir, "index.mjs"), longRunningSource, "utf8");
    }
    const supervisor = new TriggerScriptSupervisor({
      log: (message) => logs.push(message),
      onEvent: () => undefined,
      updateRuntimeState: async () => undefined,
      audit: async (_w, _t, record) => audits.push(record),
      notifyCircuitBreak: () => undefined,
      resolveScriptQuotas: async () => quotas,
    });
    const entries = [residentA, residentB];
    const reconcile = (): Promise<void> =>
      supervisor.reconcile([{ workspacePath: workspace, triggers: entries }]);

    // 构造僵尸：直接注入"child 已退出（exitCode=0）但 handleExit 从未跑"的条目——
    // 真实环境形态（exit 事件丢失），清扫只依赖 child.exitCode/signalCode 字段。
    const map = (
      supervisor as unknown as {
        processes: Map<string, Record<string, unknown>>;
      }
    ).processes;
    map.set(`${workspace}::trg-aaaaaaaa`, {
      workspacePath: workspace,
      triggerId: "trg-aaaaaaaa",
      triggerName: "zombie",
      sessionKey: "trigger:trg-aaaaaaaa",
      runtime: "node",
      mode: "resident",
      entry: residentA,
      signature: "",
      contentStamp: "",
      stdoutTail: [],
      stderrTail: [],
      stdoutLineBuffer: { push: () => [], drain: () => undefined },
      stderrLineBuffer: { push: () => [], drain: () => undefined },
      stopping: false,
      exitedHandled: false,
      child: {
        pid: 999_999,
        exitCode: 0,
        signalCode: null,
        kill: () => true,
        once: () => undefined,
      },
    });

    // reconcile：清扫补收口（僵尸移除 + 配额归还）→ 期望态 active 的 A 正常重启；
    // 重启后 A 占满配额 → B 继续 defer。
    await reconcile();
    await waitFor(
      () => logs.some((line) => line.includes("zombie entry swept: trg-aaaaaaaa")),
      "zombie swept with log",
    );
    await waitFor(
      () => logs.some((line) => line.includes("starting resident script trg-aaaaaaaa")),
      "A restarted after ghost slot returned (expected-state recovery)",
    );
    expect(audits.some((record) => record.action === "zombie-swept")).toBe(true);
    expect(
      logs.some((line) => line.includes("deferred") && line.includes("::trg-bbbbbbbb —")),
    ).toBe(true);
    await supervisor.dispose();
  });

  // ---------------------------------------------------------------------------
  // 定时执行模式（2026-11-25 runMode="scheduled" 裁决）：spawnScheduledRun 到点拉起一趟
  // oneshot 运行（采集 → emit → exit 0）——exit 0 不置 completed（状态保持 active 等
  // 下一次到点）；重入跳过记审计；不占常驻配额（配额回调缺席/抛错也不影响）。
  // ---------------------------------------------------------------------------

  it("scheduled 一趟运行：emit → exit 0 → 状态保持 active，不置 completed", async () => {
    fixture = makeFixture();
    await writeScriptEntry(
      `await globalThis.robinrun.emit({ summary: "one pass", data: { pass: true } });
       process.exit(0);`,
    );
    await fixture.supervisor.spawnScheduledRun(fixture.snapshot(), fixture.entry);

    await waitFor(
      () => fixture!.events.some((event) => event.kind === "script-result"),
      "script-result event delivered",
    );
    // 退出收口：oneshot 的 exit 0 = 本趟成功，completed 终态只属于 resident。
    await waitFor(() => fixture!.audits.some((record) => record.action === "exit"), "exit audited");
    expect(fixture.entry.status).toBe("active");
    expect(fixture.entry.lastResult).toBe("ok");
    expect(fixture.entry.consecutiveFailures).toBe(0);
    expect(
      fixture.audits.some((record) => record.action === "start" && record.mode === "oneshot"),
    ).toBe(true);
    expect(
      fixture.audits.some((record) => record.action === "exit" && record.mode === "oneshot"),
    ).toBe(true);
  });

  it("scheduled 重入跳过：上一趟未结束时到点记审计跳过", async () => {
    fixture = makeFixture();
    await writeScriptEntry(`await new Promise((resolve) => setTimeout(resolve, 30_000));`);
    await fixture.supervisor.spawnScheduledRun(fixture.snapshot(), fixture.entry);
    await waitFor(
      () => fixture!.audits.some((record) => record.action === "start"),
      "first run started",
    );

    // 第二次到点：上一趟仍在跑 → 跳过记审计（不堆积、不延后）。
    await fixture.supervisor.spawnScheduledRun(fixture.snapshot(), fixture.entry);
    await waitFor(
      () => fixture!.audits.some((record) => record.action === "scheduled-run-skipped"),
      "overlap skip audited",
    );
    expect(fixture.entry.consecutiveFailures).toBe(0);
  });

  it("scheduled 崩溃：计数递增保持 active（跨趟退避），熔断阈值语义与 resident 一致", async () => {
    fixture = makeFixture();
    await writeScriptEntry(`process.exit(3);`);
    await fixture.supervisor.spawnScheduledRun(fixture.snapshot(), fixture.entry);
    await waitFor(
      () => fixture!.entry.consecutiveFailures === 1,
      "crash counted once for the failed run",
    );
    expect(fixture.entry.status).toBe("active");
    expect(fixture.entry.lastResult).toBe("error");
  });

  it("scheduled 不占常驻配额：配额回调抛错仍照常拉起", async () => {
    const entry = makeEntry();
    await writeScriptEntry(`process.exit(0);`);
    const supervisor = new TriggerScriptSupervisor(
      {
        log: () => undefined,
        onEvent: () => undefined,
        updateRuntimeState: async () => undefined,
        audit: async () => undefined,
        notifyCircuitBreak: () => undefined,
        resolveScriptQuotas: async () => {
          throw new Error("quota source down");
        },
      },
      { backoffScheduleMs: [30, 30] },
    );
    fixture = {
      supervisor,
      entry,
      events: [],
      audits: [],
      circuitBreaks: [],
      snapshot: () => ({ workspacePath: workspace, triggers: [entry] }),
      reconcile: () => supervisor.reconcile([{ workspacePath: workspace, triggers: [entry] }]),
    };
    // 不抛即通过（配额路径完全不经由 spawnScheduledRun）。
    await supervisor.spawnScheduledRun(fixture.snapshot(), entry);
  });

  // ---------------------------------------------------------------------------
  // 引擎托管浏览器（2026-11-25，specs/trigger-browser-hosting.md）：声明 profile 且
  // acquireBrowser 在场 → spawn 前 acquire、CDP endpoint 注入 env、退出后 release；
  // acquire 失败按一次崩溃收口；无 profile 或端口缺席 = 旧行为。
  // ---------------------------------------------------------------------------

  it("browser 托管：profile 脚本 CDP endpoint 注入 env，退出后 release；缺 env 即崩（可观测）", async () => {
    const entry = makeEntry({
      config: { kind: "script", runtime: "node", entry: "index.mjs", profile: "shop-main" },
    });
    // env 注入的可观测断言：脚本校验 ROBINRUN_CDP_ENDPOINT / ROBINRUN_TRIGGER_PROFILE，
    // 缺任一即 exit 7（可从崩溃计数观测）；注入成功则 emit 事件后正常退出。
    await writeScriptEntry(
      `const cdp = process.env.ROBINRUN_CDP_ENDPOINT;
       const profile = process.env.ROBINRUN_TRIGGER_PROFILE;
       if (!cdp || cdp.indexOf("ws://") !== 0 || profile !== "shop-main") process.exit(7);
       await globalThis.robinrun.emit({ summary: "cdp ok", data: { via: cdp } });
       process.exit(0);`,
    );
    const released: string[] = [];
    const supervisor = new TriggerScriptSupervisor({
      log: () => undefined,
      onEvent: (sessionKey, event) => {
        fixture?.events.push({ ...event, summary: `${sessionKey}::${event.summary}` });
      },
      updateRuntimeState: async ({ apply }) => apply(entry),
      audit: async () => undefined,
      notifyCircuitBreak: () => undefined,
      acquireBrowser: async (_w, profile, headed) => {
        expect(profile).toBe("shop-main");
        expect(headed).toBe(false);
        return { ok: true, cdpEndpoint: "ws://127.0.0.1:9999/devtools" };
      },
      releaseBrowser: async (_w, profile) => {
        released.push(profile);
      },
    });
    fixture = {
      supervisor,
      entry,
      events: [],
      audits: [],
      circuitBreaks: [],
      snapshot: () => ({ workspacePath: workspace, triggers: [entry] }),
      reconcile: () => supervisor.reconcile([{ workspacePath: workspace, triggers: [entry] }]),
    };
    // resident 拉起（reconcile 路径）→ env 注入成功 → emit → exit 0 → release 在退出路径。
    await fixture.reconcile();
    await waitFor(() => released.includes("shop-main"), "browser released after script exit");
    // env 注入成功的证据：事件正常上报（缺 env 时脚本 exit 7 崩溃、无事件）。
    await waitFor(
      () => fixture!.events.some((event) => event.summary.includes("cdp ok")),
      "script emitted with injected CDP env",
    );
    expect(entry.status).toBe("completed");
    await fixture.supervisor.dispose();
  });

  it("browser acquire 失败：按一次崩溃收口（计数落注册表 + 退避），无进程残留", async () => {
    const entry = makeEntry({
      config: { kind: "script", runtime: "node", entry: "index.mjs", profile: "shop-main" },
    });
    await writeScriptEntry(`process.exit(0);`);
    const supervisor = new TriggerScriptSupervisor(
      {
        log: () => undefined,
        onEvent: () => undefined,
        updateRuntimeState: async ({ apply }) => apply(entry),
        audit: async () => undefined,
        notifyCircuitBreak: () => undefined,
        acquireBrowser: async () => ({ ok: false, error: "no display available" }),
        releaseBrowser: async () => undefined,
      },
      { backoffScheduleMs: [30, 30] },
    );
    fixture = {
      supervisor,
      entry,
      events: [],
      audits: [],
      circuitBreaks: [],
      snapshot: () => ({ workspacePath: workspace, triggers: [entry] }),
      reconcile: () => supervisor.reconcile([{ workspacePath: workspace, triggers: [entry] }]),
    };
    await fixture.reconcile();
    await waitFor(
      () => fixture!.entry.consecutiveFailures === 1,
      "acquire failure counted as one crash",
    );
    expect(fixture.entry.lastResult).toBe("error");
    await fixture.supervisor.dispose();
  });
});
