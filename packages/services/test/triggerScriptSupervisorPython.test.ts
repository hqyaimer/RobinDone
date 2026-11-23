// 常驻脚本触发器 python 主运行时回归（2026-11-22 python 主 + node 备选改造 + HTTP emit
// 协议修订，docs/trigger-python-runtime.md §3.4）：
//  - python 触发器经 resolvePythonRuntime 走供给链（venv 解释器 spawn + env 注入）；
//  - 事件协议 = HTTP emit 端点（`__robinrun/emit/<trg-id>`）：真 LocalWebhookServer +
//    脚本内 fetch POST → 同步 ack → 事件投递；契约违例 ack.ok=false 且 script-error 进会话；
//  - stdout 退役为纯日志（子进程/三方库输出不再影响事件通道）；
//  - robinrun.py 桥接模块随 spawn 预写进 state/（PYTHONPATH 注入）；
//  - 供给解析失败按崩溃收口（信息进审计，走既有熔断计数）；
//  - LineBuffer：多字节跨 chunk 不乱码、>64KB 单行不丢不裂、残余行收口（stdout 日志面）；
//  - POSIX 停止分层：忽略 SIGTERM 的脚本在宽限后被 SIGKILL 升级终止（win 跳过）。
// 真实子进程：以 process.execPath 冒充 venv 解释器执行 JS 脚本（协议层与解释器无关——
// node 的 fetch 直发 emit 端点，覆盖与 robinrun.py 相同的 HTTP 面）。
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TriggerEntry } from "@robinrun/shared";
import {
  LineBuffer,
  TriggerScriptSupervisor,
  type ScriptSupervisorCallbacks,
  type ScriptWorkspaceSnapshot,
} from "../src/trigger-engine/script-supervisor.js";
import { LocalWebhookServer } from "../src/trigger-engine/local-webhook-server.js";
import type { TriggerEvent } from "../src/trigger-engine/contract.js";

const T0 = new Date("2026-11-22T08:00:00.000Z");
const TRIGGER_ID = "trg-cccc3333";

let workspace = "";
let fakeVenvDir = "";

async function writeScriptEntry(source: string): Promise<void> {
  const scriptDir = join(workspace, ".robinrun", "triggers", TRIGGER_ID, "script");
  await mkdir(scriptDir, { recursive: true });
  await writeFile(join(scriptDir, "index.mjs"), source, "utf8");
}

function makeEntry(overrides: Partial<TriggerEntry> = {}): TriggerEntry {
  return {
    id: TRIGGER_ID,
    name: "py-resident-test",
    ownerAgentId: "master",
    groupId: null,
    config: { kind: "script", runtime: "python", entry: "index.mjs" },
    status: "active",
    consecutiveFailures: 0,
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
    ...overrides,
  };
}

interface PythonFixture {
  supervisor: TriggerScriptSupervisor;
  webhookServer: LocalWebhookServer;
  entry: TriggerEntry;
  events: TriggerEvent[];
  audits: Array<Record<string, unknown>>;
  circuitBreaks: Array<{ triggerId: string; consecutiveFailures: number }>;
  resolveCalls: string[];
  snapshot(): ScriptWorkspaceSnapshot;
  reconcile(): Promise<void>;
}

async function makePythonFixture(
  resolution: { ok: true; interpreterPath: string; venvDir: string } | { ok: false; error: string },
  entryOverrides: Partial<TriggerEntry> = {},
): Promise<PythonFixture> {
  const entry = makeEntry(entryOverrides);
  const events: TriggerEvent[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const circuitBreaks: Array<{ triggerId: string; consecutiveFailures: number }> = [];
  const resolveCalls: string[] = [];
  const resolvePythonRuntime: NonNullable<ScriptSupervisorCallbacks["resolvePythonRuntime"]> =
    async (workspacePath) => {
      resolveCalls.push(workspacePath);
      return resolution;
    };
  const supervisor = new TriggerScriptSupervisor({
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
    resolvePythonRuntime,
  });
  // 真 LocalWebhookServer 承载 emit 端点（与生产同一 HTTP 面），路由直通 supervisor。
  const webhookServer = new LocalWebhookServer({
    resolveRoute: () => undefined,
    onEvent: () => undefined,
    onScriptEmit: async (triggerId, event) => supervisor.handleEmitRequest(triggerId, event),
    log: () => undefined,
  });
  await webhookServer.start();
  const snapshot = (): ScriptWorkspaceSnapshot => ({
    workspacePath: workspace,
    triggers: [entry],
    ...(webhookServer.baseUrl !== undefined ? { webhookBaseUrl: webhookServer.baseUrl } : {}),
  });
  const reconcile = (): Promise<void> => supervisor.reconcile([snapshot()]);
  return {
    supervisor,
    webhookServer,
    entry,
    events,
    audits,
    circuitBreaks,
    resolveCalls,
    snapshot,
    reconcile,
  };
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

describe("TriggerScriptSupervisor python 主运行时（HTTP emit 协议）", () => {
  let fixture: PythonFixture | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "robinrun-trg-py-"));
    fakeVenvDir = join(workspace, ".robinrun", "triggers", "state", "python-env");
  });

  afterEach(async () => {
    await fixture?.supervisor.dispose();
    await fixture?.webhookServer.stop();
    fixture = undefined;
    await rm(workspace, { recursive: true, force: true });
  });

  it("venv spawn + env 注入：脚本 fetch emit 端点 → 同步 ack → 事件投递；robinrun.py 预写进 state/", async () => {
    fixture = await makePythonFixture({
      ok: true,
      interpreterPath: process.execPath,
      venvDir: fakeVenvDir,
    });
    await writeScriptEntry(
      `const response = await fetch(process.env.ROBINRUN_EMIT_URL, {
         method: "POST",
         headers: { "content-type": "application/json" },
         body: JSON.stringify({
           summary: "py-event",
           data: {
             unbuffered: process.env.PYTHONUNBUFFERED ?? null,
             utf8: process.env.PYTHONUTF8 ?? null,
             venv: process.env.VIRTUAL_ENV ?? null,
             py: process.env.ROBINRUN_PYTHON ?? null,
             pythonPath: (process.env.PYTHONPATH ?? "").split(";")[0] ?? null,
             emitUrl: process.env.ROBINRUN_EMIT_URL ?? null,
           },
         }),
       });
       const ack = await response.json();
       if (!response.ok || ack.ok !== true) process.exit(3);
       process.exit(0);`,
    );
    await fixture.reconcile();

    await waitFor(
      () => fixture!.events.some((event) => event.kind === "script-result"),
      "emit endpoint event delivered",
    );
    const event = fixture.events.find((candidate) => candidate.kind === "script-result");
    expect(event?.summary).toContain("py-event");
    const stateDir = join(workspace, ".robinrun", "triggers", "state");
    expect(event?.data).toEqual({
      unbuffered: "1",
      utf8: "1",
      venv: fakeVenvDir,
      py: process.execPath,
      pythonPath: stateDir,
      emitUrl: `${fixture.webhookServer.baseUrl}/__robinrun/emit/${TRIGGER_ID}`,
    });
    // robinrun.py 桥接随 spawn 预写；start 审计带 venv 目录；干净退出 → completed。
    const bridge = await readFile(join(stateDir, "robinrun.py"), "utf8");
    expect(bridge).toContain("def emit(summary, data=None):");
    expect(fixture.resolveCalls).toEqual([workspace]);
    expect(
      fixture.audits.some((record) => record.action === "start" && record.venv === fakeVenvDir),
    ).toBe(true);
    await waitFor(() => fixture!.entry.status === "completed", "clean exit turns completed");
  });

  it("契约违例：emit ack ok=false + script-error 事件进会话（脚本可感知被拒）", async () => {
    fixture = await makePythonFixture(
      {
        ok: true,
        interpreterPath: process.execPath,
        venvDir: fakeVenvDir,
      },
      { contract: { requiredFields: ["mustExist"] } },
    );
    await writeScriptEntry(
      `const response = await fetch(process.env.ROBINRUN_EMIT_URL, {
         method: "POST",
         headers: { "content-type": "application/json" },
         body: JSON.stringify({ summary: "bad payload", data: { other: 1 } }),
       });
       const ack = await response.json();
       // 引擎契约校验同步响应：ack.ok=false 且带原因（脚本侧 robinrun.emit 会 raise）。
       process.exit(ack.ok === false && typeof ack.error === "string" && ack.error.length > 0 ? 0 : 3);`,
    );
    await fixture.reconcile();

    await waitFor(
      () => fixture!.events.some((event) => event.kind === "script-error"),
      "contract violation delivered as script-error",
    );
    expect(fixture.events[0]?.summary).toContain("sanity assertion failed");
    // 脚本观察到拒绝后干净退出 → completed（与 node nack 语义一致：进程不因此终止）。
    await waitFor(() => fixture!.entry.status === "completed", "script exits cleanly after ack rejection");
  });

  it("emit 端点信任面：未运行/不存在的触发器 POST → 404", async () => {
    fixture = await makePythonFixture({
      ok: true,
      interpreterPath: process.execPath,
      venvDir: fakeVenvDir,
    });
    await writeScriptEntry(
      `const url = process.env.ROBINRUN_EMIT_URL.replace(/trg-[0-9a-f]+$/, "trg-00000000");
       const response = await fetch(url, {
         method: "POST",
         headers: { "content-type": "application/json" },
         body: JSON.stringify({ summary: "forged" }),
       });
       // 无 token 信任面：未运行触发器不可达（404）。
       process.exit(response.status === 404 ? 0 : 3);`,
    );
    await fixture.reconcile();
    await waitFor(() => fixture!.entry.status === "completed", "404 probe script finished");
    // 被伪造的事件没有进会话。
    expect(fixture.events).toEqual([]);
  });

  it("stdout 退役为纯日志：print 内容只进审计，不再投递", async () => {
    fixture = await makePythonFixture({
      ok: true,
      interpreterPath: process.execPath,
      venvDir: fakeVenvDir,
    });
    await writeScriptEntry(
      `process.stdout.write(JSON.stringify({ summary: "NOT-AN-EVENT", data: { via: "stdout" } }) + "\\n");
       process.exit(0);`,
    );
    await fixture.reconcile();
    await waitFor(() => fixture!.entry.status === "completed", "log-only script finished");
    // stdout 上的事件形状 JSON 不再投递。
    expect(fixture.events).toEqual([]);
    // 但进了审计日志尾部（flushLogs 在 exit 后异步落）。
    await waitFor(
      () => fixture!.audits.some((record) => record.action === "logs"),
      "stdout captured into audit logs",
    );
    const logs = fixture.audits.find((record) => record.action === "logs");
    expect(String(logs?.stdoutTail ?? "")).toContain("NOT-AN-EVENT");
  });

  it("供给解析失败按崩溃收口：错误信息进审计，计数递增走熔断", async () => {
    fixture = await makePythonFixture({
      ok: false,
      error: "failed to download cpython (mirror unreachable)",
    });
    await writeScriptEntry(`process.exit(0);`);
    await fixture.reconcile();

    await waitFor(
      () => fixture!.audits.some((record) => record.action === "crash"),
      "crash recorded on python runtime failure",
    );
    const crash = fixture.audits.find((record) => record.action === "crash");
    expect(String(crash?.error)).toContain("python runtime unavailable");
    expect(String(crash?.error)).toContain("mirror unreachable");
    expect(fixture.entry.consecutiveFailures).toBe(1);
    expect(fixture.entry.lastResult).toBe("error");
    expect(fixture.circuitBreaks).toEqual([]);
  });
});

describe("LineBuffer（字节级行缓冲，stdout/stderr 日志面）", () => {
  it("多字节 UTF-8 被 chunk 边界切开不乱码", () => {
    const buffer = new LineBuffer();
    const line = JSON.stringify({ summary: "中文摘要🎉", data: { 标题: "表情🚀" } });
    const bytes = Buffer.from(`${line}\n`, "utf8");
    const lines: string[] = [];
    for (const byte of bytes) {
      lines.push(...buffer.push(Buffer.from([byte])));
    }
    expect(lines).toEqual([line]);
    expect(buffer.drain()).toBeUndefined();
  });

  it("单条 >64KB 输出跨多 chunk 不丢不裂", () => {
    const buffer = new LineBuffer();
    const big = "x".repeat(80_000);
    const line = JSON.stringify({ summary: "big", data: { blob: big } });
    const bytes = Buffer.from(`${line}\nsecond line\n`, "utf8");
    const chunkSize = 7_777;
    const lines: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      lines.push(...buffer.push(bytes.subarray(offset, offset + chunkSize)));
    }
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(line);
    expect(lines[1]).toBe("second line");
  });

  it("无换行的残余在 drain 收口（不吞行）", () => {
    const buffer = new LineBuffer();
    expect(buffer.push(Buffer.from("partial-line-no-newline", "utf8"))).toEqual([]);
    expect(buffer.drain()).toBe("partial-line-no-newline");
    expect(buffer.drain()).toBeUndefined();
  });
});

describe("停止分层：POSIX SIGKILL 升级（win 跳过）", () => {
  it("忽略 SIGTERM 的脚本在宽限后被强杀终止", async () => {
    if (process.platform === "win32") {
      // Windows 路径 = taskkill /T /F（本就无条件硬杀），升级语义只在 POSIX 有意义。
      return;
    }
    workspace = await mkdtemp(join(tmpdir(), "robinrun-trg-py-sigkill-"));
    fakeVenvDir = join(workspace, ".robinrun", "triggers", "state", "python-env");
    const fixtureKill = await makePythonFixture({
      ok: true,
      interpreterPath: process.execPath,
      venvDir: fakeVenvDir,
    });
    // 注册 SIGTERM 忽略并驻留：旧行为（无 SIGKILL 升级）会永久悬挂。
    const scriptDir = join(workspace, ".robinrun", "triggers", TRIGGER_ID, "script");
    await mkdir(scriptDir, { recursive: true });
    await writeFile(
      join(scriptDir, "index.mjs"),
      `process.on("SIGTERM", () => { /* ignore */ });
       setInterval(() => {}, 10_000);`,
      "utf8",
    );
    await fixtureKill.reconcile();
    await waitFor(() => fixtureKill.audits.some((record) => record.action === "start"), "resident started");
    expect(fixtureKill.entry.status).toBe("active");

    fixtureKill.entry.status = "deactivated";
    await fixtureKill.reconcile();
    // 宽限 10s + SIGKILL 升级 + 退出审计：上限 15s（升级语义生效的直接证据）。
    await waitFor(
      () => fixtureKill.audits.some((record) => record.action === "stop"),
      "SIGKILL escalation terminated the ignorable script",
      15_000,
    );
    expect(fixtureKill.entry.consecutiveFailures).toBe(0);
    await fixtureKill.supervisor.dispose();
    await fixtureKill.webhookServer.stop();
    await rm(workspace, { recursive: true, force: true });
  }, 20_000);
});
