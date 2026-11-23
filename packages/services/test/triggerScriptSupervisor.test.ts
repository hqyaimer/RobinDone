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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    await rm(workspace, { recursive: true, force: true });
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
});
