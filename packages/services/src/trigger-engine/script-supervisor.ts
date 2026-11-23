import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { triggerDirectoryConvention, type TriggerEntry } from "@robinrun/shared";
import type { TriggerEvent } from "./contract.js";
import type { ScriptEmitResult } from "./local-webhook-server.js";
import { TRIGGER_EMIT_ROUTE_PREFIX } from "./local-webhook-server.js";
import { assertContract, clipScriptOutput, resolveRuntimeCommand } from "./script-runner.js";

/**
 * 常驻脚本触发器的进程托管（ScriptSupervisor，2026-11-21 常驻模型裁决，
 * docs/trigger-system.md「触发器类型 → 脚本」节修订；2026-11-22 python 主运行时改造）。
 *
 * 模型：脚本触发器 = 常驻事件源进程，**不是**按周期 spawn 的批处理。引擎托管生命周期：
 * - 触发器 active 即应运行（挂载/客户端启动/5s 轮询/注册表变化都会 reconcile）；
 * - 双运行时（2026-11-22 python 主 + node 备选）：python 走供给链（托管解释器自动下载
 *   + 按项目 venv，经 resolvePythonRuntime 回调注入 venv 解释器），事件协议 = **HTTP
 *   emit 端点**（`__robinrun/emit/<trg-id>`，注入 robinrun.py 桥接 + PYTHONPATH，同步
 *   ack——并发安全，stdout 退役为纯日志）；node 备选保留 IPC 桥接
 *   （`robinrun.emit`/`onShutdown`）。
 * - stdout/stderr = 日志（双运行时一致）：字节级行缓冲（修复多字节被 chunk 边界切坏），
 *   尾部环形缓冲，退出/停止时一次性进审计，不投递。
 * - 退出语义：exit 0 = `completed` 终态（一次性脚本的自然完成）；exit 非 0 / spawn 失败 =
 *   崩溃，按注册表 consecutiveFailures 退避重启（5s→15s→60s），连续 3 次 → error-paused
 *   + 熔断通知；期间任何一次成功事件上报清零计数。
 * - 停止（分层）：t0 软信号（node=shutdown IPC；python=POSIX 进程组 SIGTERM，可捕获
 *   收尾）→ 10s 宽限 → 强杀进程树（win32 taskkill /T /F；POSIX 进程组 SIGKILL——
 *   2026-11-22 修复：原实现只发一轮 SIGTERM 且无升级，忽略 SIGTERM 的脚本永久悬挂），
 *   覆盖 playwright 子进程。
 *
 * 重启不设独立定时器：崩溃时记 `backoffUntil`，reconcile（引擎 5s 轮询驱动）到点自动
 * 拉起——单一驱动源，无 timer 泄漏面。并发配额沿用（每项目 2 / 全局 4）。
 */

/** 每进程日志环形上限（退出时一次性进审计）。 */
const MAX_LOG_LINES = 200;
const MAX_LOG_LINE_CHARS = 4_000;
/** 崩溃退避序列（按 consecutiveFailures 取索引，越界取末位）。 */
const RESTART_BACKOFF_MS = [5_000, 15_000, 60_000];
/** 优雅停止宽限（shutdown 消息后等脚本自行退出）。 */
const SHUTDOWN_GRACE_MS = 10_000;
/** 常驻脚本并发配额（资源兜底；超限本轮跳过，下轮 poll 重试）。 */
const SCRIPTS_PER_WORKSPACE = 2;
const SCRIPTS_GLOBAL_MAX = 4;
/** 熔断阈值（与引擎 CIRCUIT_BREAK_THRESHOLD 一致；supervisor 侧独立计数落注册表）。 */
export const SCRIPT_CIRCUIT_BREAK_THRESHOLD = 3;

export interface ScriptSupervisorCallbacks {
  log(message: string): void;
  /** 事件投递（引擎回调：入聚合器按会话 key 去抖合并）。 */
  onEvent(sessionKey: string, event: TriggerEvent): void;
  /** 注册表运行时状态写（引擎 mutateRegistry 包装：读盘-改-原子写、写链串行）。 */
  updateRuntimeState(params: {
    workspacePath: string;
    triggerId: string;
    apply: (entry: TriggerEntry) => void;
  }): Promise<void>;
  /** 审计追加（append-only JSONL）。 */
  audit(workspacePath: string, triggerId: string, record: Record<string, unknown>): Promise<void>;
  /** 熔断通知（应用内通知 + 徽章）。 */
  notifyCircuitBreak(params: {
    workspacePath: string;
    triggerId: string;
    triggerName: string;
    consecutiveFailures: number;
    lastError?: string;
  }): void;
  /**
   * python 运行时解析（2026-11-22 python 主运行时改造；引擎注入：托管解释器 ensure +
   * 项目 venv ensure）。缺席 = 旧行为（系统 PATH 探测 python/python3）；解析失败返回
   * {ok:false, error}，supervisor 按崩溃收口（信息进注册表 lastResult 与审计）。
   */
  resolvePythonRuntime?(workspacePath: string): Promise<
    { ok: true; interpreterPath: string; venvDir: string } | { ok: false; error: string }
  >;
}

export interface ScriptWorkspaceSnapshot {
  workspacePath: string;
  /** 该工作区注册表的全部触发器条目（supervisor 自行过滤 script 型）。 */
  triggers: TriggerEntry[];
  /** 本地 webhook 服务基址（脚本 env 透传 ROBINRUN_WEBHOOK_BASE_URL）。 */
  webhookBaseUrl?: string;
}

interface RunningScript {
  workspacePath: string;
  triggerId: string;
  triggerName: string;
  sessionKey: string;
  /** 脚本运行时（停止分层按它选软信号：node=IPC shutdown；python=POSIX SIGTERM）。 */
  runtime: "node" | "python";
  child: ChildProcess;
  /**
   * 启动时的注册表条目引用（emit 端点的契约校验与事件投递需要 config/contract；config
   * 整体替换时签名变更 → 重启换新引用，这里读到的契约始终是当次 spawn 的版本）。
   */
  readonly entry: TriggerEntry;
  /** spawn 签名（runtime|entry|profile|headed）；config 变更 → reconcile 重启。 */
  signature: string;
  stdoutTail: string[];
  stderrTail: string[];
  readonly stdoutLineBuffer: LineBuffer;
  readonly stderrLineBuffer: LineBuffer;
  /** 停止流程已启动（软信号已发/强杀已排程），reconcile 不再对齐。 */
  stopping: boolean;
  /**
   * 崩溃已计数标记（2026-11-23 修复）：子进程异常时 'error' 与 'exit' 可能先后都发
   * （Node 文档明示 may or may not），两路都进 registerCrash 会把一次崩溃计成两次——
   * 3 次熔断实际 ~1.5 次真崩溃就触发。首个到达者置位，后来者跳过。
   */
  crashCounted?: boolean;
  /**
   * 启动时的脚本内容戳（mtimeMs:size，2026-11-23 脚本内容热重载）：agent 修改脚本文件
   * 后 reconcile 检测到戳变化即重启（新进程读新文件）——不再需要停用/启用或等崩溃重启
   * 才生效。只监控主 entry 文件，import 的本地模块变更不触发（重启即全量重读，边界可接受）。
   */
  contentStamp: string;
}

/** 脚本主文件内容戳：mtimeMs:size；文件不存在/不可 stat 返回 "missing"（不抛）。 */
async function contentStampOf(snapshot: ScriptWorkspaceSnapshot, entry: TriggerEntry): Promise<string> {
  if (entry.config.kind !== "script") return "";
  const scriptPath = join(
    snapshot.workspacePath,
    ".robinrun",
    "triggers",
    entry.id,
    triggerDirectoryConvention.script,
    entry.config.entry,
  );
  try {
    const stats = await stat(scriptPath);
    return `${Math.round(stats.mtimeMs)}:${stats.size}`;
  } catch {
    return "missing";
  }
}

/**
 * 字节级行缓冲（2026-11-22 修复）：原实现把每个 chunk 直接 `toString("utf8")` 再按
 * `\r?\n` 分割——多字节 UTF-8 字符恰好被 chunk 边界切开即乱码（中文/emoji 事件必踩）。
 * 改为字节累积、只在完整 `\n` 处分割后再转 utf8；超长行（如 >64KB 单条事件跨多 chunk）
 * 同样只在行界处理，不丢不裂。
 */
export class LineBuffer {
  private pending: Buffer = Buffer.alloc(0);

  /** 送入一个 chunk，返回其中全部完整行（utf8，不含行尾换行；`\r\n` 尾去除）。 */
  push(chunk: Buffer): string[] {
    const data = Buffer.concat([this.pending, chunk]);
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const index = data.indexOf(0x0a, start);
      if (index === -1) break;
      let end = index;
      if (end > start && data[end - 1] === 0x0d) end -= 1;
      lines.push(data.subarray(start, end).toString("utf8"));
      start = index + 1;
    }
    this.pending = data.subarray(start);
    return lines;
  }

  /** 流收口时取剩余不完整行（无换行即流结束：按日志收口，不投递）。 */
  drain(): string | undefined {
    if (this.pending.length === 0) return undefined;
    const text = this.pending.toString("utf8");
    this.pending = Buffer.alloc(0);
    return text;
  }
}

const keyOf = (workspacePath: string, triggerId: string): string =>
  `${workspacePath}::${triggerId}`;

const signatureOf = (entry: TriggerEntry): string =>
  entry.config.kind === "script"
    ? // 修复（2026-11-23）：groupId/contract 入签名——此前 update_group 移组（或直连↔组互转）
      // 与 contract 变更都不改变签名，常驻脚本不重启，running.entry 冻结旧值：sessionKeyOf
      // 与 ROBINRUN_TRIGGER_SESSION_KEY 继续指向旧组会话（新组永远收不到事件）、契约校验
      // 沿用旧 contract。name 只影响事件摘要文案，不必重启，不入签名。
      `${entry.config.runtime}|${entry.config.entry}|${entry.config.profile ?? ""}|${
        entry.config.headed === true ? "headed" : "headless"
      }|${entry.groupId ?? ""}|${JSON.stringify(entry.contract ?? null)}`
    : "";

/** spawn 参数（供测试断言进程树清理与桥接注入）。 */
export interface ResolvedSpawnPlan {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  ipc: boolean;
}

/**
 * 引擎生成的桥接模块源码（纯 Node 内置、零 npm 依赖）：`--require` 预加载后向脚本注入
 * `globalThis.robinrun = { emit(event) → Promise(ack), onShutdown(fn) }`。ack 语义见
 * 「事件上报协议」：emit 在引擎接受事件后 resolve（契约违例 reject），一次性脚本
 * `await emit()` 后退出即无投递竞态。
 */
const BRIDGE_SOURCE = `/* RobinRun trigger bridge (generated by the engine; do not edit). */
"use strict";
(function () {
  if (typeof process.send !== "function") return;
  var seq = 0;
  var pending = new Map();
  var shutdownHandlers = [];
  process.on("message", function (msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "robinrun-ack") {
      var waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.ok) waiter.resolve();
      else waiter.reject(new Error(msg.error || "event rejected by the engine"));
      return;
    }
    if (msg.type === "robinrun-shutdown") {
      var handlers = shutdownHandlers.splice(0);
      for (var i = 0; i < handlers.length; i++) {
        try { handlers[i](); } catch (error) { /* 收尾钩子互不影响 */ }
      }
    }
  });
  Object.defineProperty(globalThis, "robinrun", {
    value: {
      emit: function (event) {
        return new Promise(function (resolve, reject) {
          seq += 1;
          var id = seq;
          pending.set(id, { resolve: resolve, reject: reject });
          process.send({ type: "robinrun-event", id: id, event: event });
        });
      },
      onShutdown: function (handler) {
        if (typeof handler === "function") shutdownHandlers.push(handler);
      },
    },
    writable: false,
    enumerable: false,
    configurable: false,
  });
})();
`;

/**
 * python 桥接模块源码（2026-11-22 HTTP emit 协议，对齐 node 的 `robinrun.emit` 注入模式）：
 * 引擎 spawn python 前写进 `state/robinrun.py`，经 `PYTHONPATH` 注入——脚本 `import robinrun`
 * 即得 `emit(summary, data=None)`。stdlib-only（urllib）；HTTP/URL/JSON 全部封装在库内，
 * agent 不构建请求；引擎契约校验同步完成后才响应，违例 raise（同 node IPC 的 reject 语义）。
 * stdout 专职日志（事件协议已退役），print 不会污染事件通道。
 */
const PYTHON_BRIDGE_SOURCE = `"""RobinRun trigger bridge (generated by the engine; do not edit)."""
import json
import os
import urllib.error
import urllib.request

def emit(summary, data=None):
    """Report one event to the engine and wait for its acknowledgement.

    Raises RuntimeError when the engine rejects the event (contract violation)
    or the endpoint is unreachable; returns the engine's response dict on
    success. Events must satisfy the trigger's registry \`contract\` assertions
    against \`data\`.
    """
    url = os.environ.get("ROBINRUN_EMIT_URL")
    if not url:
        raise RuntimeError(
            "ROBINRUN_EMIT_URL is not set; this script must be started by the RobinRun engine"
        )
    body = json.dumps({"summary": summary, "data": data}).encode("utf-8")
    request = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            result = json.loads(error.read().decode("utf-8"))
        except Exception:
            raise RuntimeError("robinrun.emit failed: HTTP %d" % error.code) from error
    except OSError as error:
        raise RuntimeError("robinrun.emit failed: %s" % error) from error
    if not result.get("ok"):
        raise RuntimeError(result.get("error") or "event rejected by the engine")
    return result
`;

export class TriggerScriptSupervisor {
  private readonly processes = new Map<string, RunningScript>();
  /** 崩溃退避：key → 最早允许重启时刻（re-enable 清零计数后忽略）。 */
  private readonly backoffUntil = new Map<string, number>();
  private disposed = false;

  constructor(
    private readonly callbacks: ScriptSupervisorCallbacks,
    /** 测试钩子：覆盖崩溃退避序列（毫秒），让熔断状态机在单测里快速走完。 */
    private readonly overrides?: { backoffScheduleMs?: number[] },
  ) {}

  private get backoffSchedule(): number[] {
    return this.overrides?.backoffScheduleMs ?? RESTART_BACKOFF_MS;
  }

  /** 注册表中处于运行中的进程数（含 stopping 中的，防超卖）。 */
  private get runningCount(): number {
    return this.processes.size;
  }

  private runningCountFor(workspacePath: string): number {
    let count = 0;
    for (const running of this.processes.values()) {
      if (running.workspacePath === workspacePath) count += 1;
    }
    return count;
  }

  /**
   * 对齐全部工作区的常驻脚本进程与注册表期望状态（引擎 5s 轮询/挂载/注册表变化时调用）。
   * 幂等：已在运行且签名一致 → 不动；期望停 → 优雅停；期望跑且不在退避窗口 → 拉起。
   */
  async reconcile(snapshots: ScriptWorkspaceSnapshot[]): Promise<void> {
    if (this.disposed) return;
    const desired = new Map<string, { snapshot: ScriptWorkspaceSnapshot; entry: TriggerEntry }>();
    for (const snapshot of snapshots) {
      for (const trigger of snapshot.triggers) {
        if (trigger.config.kind !== "script") continue;
        desired.set(keyOf(snapshot.workspacePath, trigger.id), { snapshot, entry: trigger });
      }
    }

    // 1. 期望停止 / 条目消失 / 签名或脚本内容变更 → 停止（变更标记 restart，停止后下轮拉起）。
    for (const [key, running] of [...this.processes]) {
      const want = desired.get(key);
      const stillActive =
        want !== undefined && want.entry.status === "active" && want.entry.config.kind === "script";
      let changeReason: "config-changed" | "script-changed" | undefined;
      if (stillActive && want !== undefined) {
        if (running.signature !== signatureOf(want.entry)) {
          changeReason = "config-changed";
        } else {
          // 脚本内容热重载（2026-11-23）：主 entry 文件 mtime/size 变化 → 重启读新代码。
          const stamp = await contentStampOf(want.snapshot, want.entry);
          if (running.contentStamp !== stamp) changeReason = "script-changed";
        }
      }
      if (!stillActive || changeReason !== undefined) {
        this.initiateStop(key, running, changeReason ?? "not-active");
      }
    }

    // 2. 期望运行且无进程 → 拉起（配额内；退避窗口内跳过）。
    for (const [key, want] of desired) {
      if (this.processes.has(key)) continue;
      if (want.entry.status !== "active") continue;
      const backoff = this.backoffUntil.get(key);
      if (backoff !== undefined) {
        if (want.entry.consecutiveFailures === 0) {
          // re-enable 清零计数 → 退避作废（立即重跑）。
          this.backoffUntil.delete(key);
        } else if (Date.now() < backoff) {
          continue;
        } else {
          this.backoffUntil.delete(key);
        }
      }
      if (this.runningCount >= SCRIPTS_GLOBAL_MAX) {
        this.callbacks.log(`script start deferred (global quota ${SCRIPTS_GLOBAL_MAX}): ${key}`);
        continue;
      }
      if (this.runningCountFor(want.snapshot.workspacePath) >= SCRIPTS_PER_WORKSPACE) {
        this.callbacks.log(
          `script start deferred (workspace quota ${SCRIPTS_PER_WORKSPACE}): ${key}`,
        );
        continue;
      }
      await this.startProcess(want.snapshot, want.entry);
    }
  }

  /** 应用退出：全部停止并等待退出（宽限兜底后强杀）。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    const stops: Promise<void>[] = [];
    for (const [key, running] of [...this.processes]) {
      stops.push(this.waitForStop(key, running));
      this.initiateStop(key, running, "dispose");
    }
    await Promise.allSettled(stops);
  }

  /**
   * 已运行脚本的请求式重启（2026-11-22：install_packages 成功后让新包装进旧进程——
   * 简单直接的生效时机裁决，避免"装了包旧进程用不上"的困惑）。优雅停止后 reconcile
   * 下轮（≤5s）因 active+无进程自动重拉（主动停止不计崩溃、不动退避）。幂等：未运行空转。
   */
  requestRestartFor(workspacePath: string, triggerId: string): void {
    const key = keyOf(workspacePath, triggerId);
    const running = this.processes.get(key);
    if (running === undefined) return;
    this.initiateStop(key, running, "packages-updated");
  }

  // ---------------------------------------------------------------------------
  // 拉起
  // ---------------------------------------------------------------------------

  private async startProcess(
    snapshot: ScriptWorkspaceSnapshot,
    entry: TriggerEntry,
  ): Promise<void> {
    if (entry.config.kind !== "script") return;
    const key = keyOf(snapshot.workspacePath, entry.id);
    const triggerDir = join(snapshot.workspacePath, ".robinrun", "triggers", entry.id);
    const scriptDir = join(triggerDir, triggerDirectoryConvention.script);
    // 运行时解析（2026-11-22 python 主 + node 备选）：python 优先走供给链（托管解释器
    // + 项目 venv，经 resolvePythonRuntime 回调）；回调缺席（测试/未接线宿主）退回系统
    // PATH 探测旧行为。node 备选路径原样保留。
    let runtime: { command: string; args: string[]; electronAsNode: boolean };
    let pythonRuntime: { interpreterPath: string; venvDir: string } | undefined;
    if (entry.config.runtime === "python" && this.callbacks.resolvePythonRuntime !== undefined) {
      const resolution = await this.callbacks.resolvePythonRuntime(snapshot.workspacePath);
      if (!resolution.ok) {
        // 运行时缺失按一次崩溃收口（计数落注册表，退避后重试；3 次熔断叫人）。
        await this.registerCrash(
          snapshot,
          entry,
          `python runtime unavailable: ${resolution.error} (the engine retries automatically on restart/install; while python stays unavailable you can switch this trigger to the node runtime via ManageTriggers update)`,
          undefined,
        );
        return;
      }
      pythonRuntime = { interpreterPath: resolution.interpreterPath, venvDir: resolution.venvDir };
      runtime = { command: resolution.interpreterPath, args: [], electronAsNode: false };
    } else {
      const resolved = await resolveRuntimeCommand(entry.config.runtime);
      if (resolved === undefined) {
        const error =
          entry.config.runtime === "python"
            ? "No usable system Python (tried python / python3 on PATH). Install Python, or switch this trigger to the node runtime."
            : "Node runtime unavailable.";
        await this.registerCrash(snapshot, entry, error, undefined);
        return;
      }
      runtime = resolved;
    }

    let plan: ResolvedSpawnPlan;
    try {
      plan = await this.buildSpawnPlan({
        snapshot,
        entry,
        scriptDir,
        runtimeCommand: runtime.command,
        runtimeArgs: runtime.args,
        electronAsNode: runtime.electronAsNode,
        ...(pythonRuntime !== undefined ? { pythonRuntime } : {}),
      });
    } catch (error) {
      await this.registerCrash(
        snapshot,
        entry,
        `spawn plan failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
      );
      return;
    }

    this.callbacks.log(`starting resident script ${entry.id} (${entry.config.runtime})`);
    let child: ChildProcess;
    try {
      child = spawn(plan.command, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        // detached 仅 POSIX 需要（进程组负 pid 信号）；Windows 必须不用——MSDN 明确
        // CREATE_NO_WINDOW（windowsHide）与 DETACHED_PROCESS 同用时前者被忽略，且
        // DETACHED 下 python 自身无控制台，脚本再 spawn 的控制台孙进程会拿到全新可见
        // 窗口。windowsHide（无 detached）= 分配隐藏控制台供整棵脚本树继承，树杀仍走
        // taskkill /T（按 PID 树，不依赖进程组）。
        detached: process.platform !== "win32",
        windowsHide: true,
        shell: false,
        stdio: plan.ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      await this.registerCrash(
        snapshot,
        entry,
        `spawn failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
      );
      return;
    }

    const running: RunningScript = {
      workspacePath: snapshot.workspacePath,
      triggerId: entry.id,
      triggerName: entry.name,
      sessionKey: entry.groupId === null ? `trigger:${entry.id}` : `trigger-group:${entry.groupId}`,
      runtime: entry.config.runtime,
      entry,
      child,
      signature: signatureOf(entry),
      contentStamp: await contentStampOf(snapshot, entry),
      stdoutTail: [],
      stderrTail: [],
      stdoutLineBuffer: new LineBuffer(),
      stderrLineBuffer: new LineBuffer(),
      stopping: false,
    };
    this.processes.set(key, running);
    // 修复（2026-11-23）：以下 fire-and-forget 回调统一补 .catch——handleIpcMessage/
    // registerCrash/handleExit/audit 内部含注册表落盘等 fs 操作，磁盘满/杀软锁文件等
    // 错误一旦 reject 即 unhandledRejection，Node 默认崩溃进程（host 常驻服务被带崩）。
    this.callbacks
      .audit(snapshot.workspacePath, entry.id, {
        action: "start",
        runtime: entry.config.runtime,
        ...(pythonRuntime !== undefined ? { venv: pythonRuntime.venvDir } : {}),
        entry: entry.config.entry,
      })
      .catch((error: unknown) =>
        this.callbacks.log(
          `audit write failed for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );

    // 事件通道（Node 桥接 IPC）：{type:"robinrun-event", id, event} → 校验/投递/ack。
    // python 走 HTTP emit 端点（LocalWebhookServer __robinrun/emit → handleEmitRequest），
    // stdout/stderr 双运行时统一专职日志（字节级行缓冲）。
    if (plan.ipc) {
      child.on("message", (raw: unknown) => {
        this.handleIpcMessage(snapshot, entry, running, raw).catch((error: unknown) =>
          this.callbacks.log(
            `ipc message handling failed for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      });
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      this.consumeOutput(running, "stdout", chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.consumeOutput(running, "stderr", chunk);
    });
    child.on("error", (error) => {
      // spawn 后的运行时错误（如 exec 缺失）：按崩溃收口（exit 可能不再触发）。
      // 主动停止期间的错误不算崩溃（同 handleExit 的 stopping 守卫语义）。
      if (running.stopping) return;
      running.stderrTail.push(error.message);
      this.registerCrash(snapshot, entry, `process error: ${error.message}`, running).catch(
        (crashError: unknown) =>
          this.callbacks.log(
            `crash registration failed for ${entry.id}: ${crashError instanceof Error ? crashError.message : String(crashError)}`,
          ),
      );
    });
    child.on("exit", (code, signal) => {
      this.handleExit(snapshot, entry, running, code, signal).catch((error: unknown) =>
        this.callbacks.log(
          `exit handling failed for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });
  }

  /** 组装 spawn 计划（node 备选：注入桥接 + IPC fd；python 主：venv 解释器 + 纯管道；
   * env 透传触发器身份）。 */
  private async buildSpawnPlan(params: {
    snapshot: ScriptWorkspaceSnapshot;
    entry: TriggerEntry;
    scriptDir: string;
    runtimeCommand: string;
    runtimeArgs: string[];
    electronAsNode: boolean;
    pythonRuntime?: { interpreterPath: string; venvDir: string };
  }): Promise<ResolvedSpawnPlan> {
    const { snapshot, entry, scriptDir, runtimeCommand, runtimeArgs, electronAsNode } = params;
    if (entry.config.kind !== "script") throw new Error("non-script config");
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (electronAsNode) env.ELECTRON_RUN_AS_NODE = "1";
    env.ROBINRUN_TRIGGER_ID = entry.id;
    env.ROBINRUN_TRIGGER_DIR = join(snapshot.workspacePath, ".robinrun", "triggers", entry.id);
    env.ROBINRUN_TRIGGER_SESSION_KEY =
      entry.groupId === null ? `trigger:${entry.id}` : `trigger-group:${entry.groupId}`;
    if (snapshot.webhookBaseUrl !== undefined) {
      env.ROBINRUN_WEBHOOK_BASE_URL = snapshot.webhookBaseUrl;
    }
    if (entry.config.runtime === "node") {
      // 桥接模块每次拉起都重写（内容常量，幂等且保证最新契约）。
      const bridgePath = await this.ensureBridgeFile(snapshot.workspacePath);
      return {
        command: runtimeCommand,
        args: [...runtimeArgs, "--require", bridgePath, entry.config.entry],
        cwd: scriptDir,
        env,
        ipc: true,
      };
    }
    // python 主运行时（2026-11-22 HTTP emit 协议）：注入 robinrun.py 桥接（PYTHONPATH）+
    // emit 端点 URL；PYTHONUNBUFFERED/PYTHONUTF8 保留（stdout 专职日志的时效与编码）；
    // venv 在场时追加 VIRTUAL_ENV（子进程工具链约定）与 ROBINRUN_PYTHON（脚本/调试）。
    env.PYTHONUNBUFFERED = "1";
    env.PYTHONUTF8 = "1";
    if (params.pythonRuntime !== undefined) {
      env.VIRTUAL_ENV = params.pythonRuntime.venvDir;
      env.ROBINRUN_PYTHON = params.pythonRuntime.interpreterPath;
    }
    const stateDir = join(snapshot.workspacePath, ".robinrun", "triggers", "state");
    await this.ensurePythonBridgeFile(stateDir);
    env.PYTHONPATH = env.PYTHONPATH ? `${stateDir}${delimiter}${env.PYTHONPATH}` : stateDir;
    if (snapshot.webhookBaseUrl !== undefined) {
      env.ROBINRUN_EMIT_URL = `${snapshot.webhookBaseUrl}/${TRIGGER_EMIT_ROUTE_PREFIX}${entry.id}`;
    }
    return {
      command: runtimeCommand,
      args: [...runtimeArgs, entry.config.entry],
      cwd: scriptDir,
      env,
      ipc: false,
    };
  }

  private async ensureBridgeFile(workspacePath: string): Promise<string> {
    const dir = join(workspacePath, ".robinrun", "triggers", "state", "bridge");
    const file = join(dir, "robinrun-bridge.cjs");
    await mkdir(dir, { recursive: true });
    await writeFile(file, BRIDGE_SOURCE, "utf8");
    return file;
  }

  /** python 桥接模块（state/robinrun.py）：每次拉起重写（内容常量，幂等且保证最新契约）。 */
  private async ensurePythonBridgeFile(stateDir: string): Promise<void> {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "robinrun.py"), PYTHON_BRIDGE_SOURCE, "utf8");
  }

  // ---------------------------------------------------------------------------
  // 事件与输出
  // ---------------------------------------------------------------------------

  private async handleIpcMessage(
    snapshot: ScriptWorkspaceSnapshot,
    entry: TriggerEntry,
    running: RunningScript,
    raw: unknown,
  ): Promise<void> {
    if (raw === null || typeof raw !== "object") return;
    const message = raw as { type?: unknown; id?: unknown; event?: unknown };
    if (message.type !== "robinrun-event") return; // 脚本自用 process.send 一律忽略
    const id = typeof message.id === "number" ? message.id : -1;
    const result = await this.validateAndDeliver(snapshot, entry, message.event);
    try {
      running.child.send?.({ type: "robinrun-ack", id, ok: result.ok, ...(result.error ? { error: result.error } : {}) });
    } catch {
      // 通道已断（脚本退出中）：ack 失败不影响投递。
    }
  }

  /**
   * python 脚本 emit 端点处理（2026-11-22 HTTP emit 协议；LocalWebhookServer 的
   * `__robinrun/emit/<trg-id>` 注入此处）：按触发器 id 找**正在运行**的脚本（跨工作区扫
   * 运行注册表——id 为随机 8hex，同刻双活碰撞概率可忽略，取先见者），走与 node IPC 相同
   * 的校验/投递路径并同步返回 ack（契约违例脚本侧 raise）。未运行/不存在 = undefined
   * （服务层 404）——这也是无 token 信任面的关键一半：只有引擎拉起的活脚本可达。
   */
  async handleEmitRequest(
    triggerId: string,
    event: unknown,
  ): Promise<ScriptEmitResult | undefined> {
    for (const running of this.processes.values()) {
      if (running.triggerId !== triggerId) continue;
      const snapshot: ScriptWorkspaceSnapshot = {
        workspacePath: running.workspacePath,
        triggers: [running.entry],
      };
      return await this.validateAndDeliver(snapshot, running.entry, event);
    }
    return undefined;
  }

  /**
   * 事件校验 + 投递（node IPC 与 python HTTP emit 的共享路径）：形状/契约校验、正常事件
   * 与脚本异常事件分流。返回 {ok, error?} 供两种通道各自的 ack/HTTP 响应——python 由此
   * 获得与 node IPC 对等的 ack 语义（契约违例脚本当场可感知）。
   */
  private async validateAndDeliver(
    snapshot: ScriptWorkspaceSnapshot,
    entry: TriggerEntry,
    event: unknown,
  ): Promise<ScriptEmitResult> {
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      const error = "event must be an object like { summary, data }";
      await this.deliverScriptError(snapshot, entry, error);
      return { ok: false, error };
    }
    const record = event as { summary?: unknown; data?: unknown };
    const summary =
      typeof record.summary === "string" && record.summary.trim().length > 0
        ? clipScriptOutput(record.summary, 200)
        : "script event";
    const assertion = assertContract(record.data, entry.contract);
    if (!assertion.ok) {
      const error = `sanity assertion failed: ${assertion.reason}`;
      await this.deliverScriptError(snapshot, entry, error);
      return { ok: false, error };
    }
    await this.deliverScriptEvent(snapshot, entry, summary, record.data);
    return { ok: true };
  }

  /** stdout/stderr 日志消费（双运行时一致：事件经 IPC/HTTP emit 通道，输出专职日志）。 */
  private consumeOutput(running: RunningScript, stream: "stdout" | "stderr", chunk: Buffer): void {
    const tail = stream === "stdout" ? running.stdoutTail : running.stderrTail;
    const buffer = stream === "stdout" ? running.stdoutLineBuffer : running.stderrLineBuffer;
    // 字节级行缓冲：完整行才处理（多字节/超长行跨 chunk 安全）；无换行的残余留在缓冲，
    // 由进程退出的 drainPartialLines 收口。
    for (const rawLine of buffer.push(chunk)) {
      const line = rawLine.trimEnd();
      if (line.length === 0) continue;
      tail.push(line.slice(0, MAX_LOG_LINE_CHARS));
      if (tail.length > MAX_LOG_LINES) tail.shift();
    }
  }

  /** 进程退出收口：把两个流里残余的无换行行落入日志尾部（不投递）。 */
  private drainPartialLines(running: RunningScript): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const text = (
        stream === "stdout" ? running.stdoutLineBuffer : running.stderrLineBuffer
      ).drain();
      if (text === undefined) continue;
      const line = text.trimEnd();
      if (line.length === 0) continue;
      const tail = stream === "stdout" ? running.stdoutTail : running.stderrTail;
      tail.push(line.slice(0, MAX_LOG_LINE_CHARS));
      if (tail.length > MAX_LOG_LINES) tail.shift();
    }
  }

  private async deliverScriptEvent(
    snapshot: ScriptWorkspaceSnapshot,
    entry: TriggerEntry,
    summary: string,
    data: unknown,
  ): Promise<void> {
    const at = new Date().toISOString();
    await this.callbacks.updateRuntimeState({
      workspacePath: snapshot.workspacePath,
      triggerId: entry.id,
      apply: (target) => {
        target.lastFireAt = at;
        target.lastResult = "ok";
        target.consecutiveFailures = 0;
        target.updatedAt = at;
      },
    });
    void this.callbacks.audit(snapshot.workspacePath, entry.id, {
      action: "event",
      ok: true,
      summary,
    });
    this.callbacks.onEvent(sessionKeyOf(entry), {
      kind: "script-result",
      at,
      summary: `${entry.name}: ${summary}`,
      ...(data !== undefined ? { data } : {}),
    });
  }

  private async deliverScriptError(
    snapshot: ScriptWorkspaceSnapshot,
    entry: TriggerEntry,
    error: string,
  ): Promise<void> {
    const at = new Date().toISOString();
    void this.callbacks.audit(snapshot.workspacePath, entry.id, {
      action: "event",
      ok: false,
      error: clipScriptOutput(error, 2_000),
    });
    this.callbacks.onEvent(sessionKeyOf(entry), {
      kind: "script-error",
      at,
      summary: `${entry.name} FAILED: ${clipScriptOutput(error, 200)}`,
      error: clipScriptOutput(error),
    });
  }

  // ---------------------------------------------------------------------------
  // 退出与崩溃
  // ---------------------------------------------------------------------------

  private async handleExit(
    snapshot: ScriptWorkspaceSnapshot,
    entry: TriggerEntry,
    running: RunningScript,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    const key = keyOf(running.workspacePath, entry.id);
    this.processes.delete(key);
    this.drainPartialLines(running);
    await this.flushLogs(snapshot, entry, running, code, signal);
    if (code === 0 && !running.stopping) {
      // 干净退出 = 完成（一次性脚本的自然终点）：completed 终态。
      const at = new Date().toISOString();
      await this.callbacks.updateRuntimeState({
        workspacePath: snapshot.workspacePath,
        triggerId: entry.id,
        apply: (target) => {
          target.status = "completed";
          target.lastResult = "ok";
          target.consecutiveFailures = 0;
          target.updatedAt = at;
        },
      });
      void this.callbacks.audit(snapshot.workspacePath, entry.id, { action: "exit", code: 0 });
      this.callbacks.log(`resident script ${entry.id} exited cleanly → completed`);
      return;
    }
    if (running.stopping) {
      // 主动停止（停用/配置变更/dispose）：不算崩溃、不改状态。
      void this.callbacks.audit(snapshot.workspacePath, entry.id, {
        action: "stop",
        ...(code !== null ? { code } : {}),
      });
      return;
    }
    const error = `Script exited with code ${code ?? "null"}${
      signal !== null ? ` (signal ${signal})` : ""
    }${running.stderrTail.length > 0 ? `. stderr tail: ${running.stderrTail.slice(-8).join(" | ")}` : ""}`;
    // 修复（2026-11-23）：传 running（原先传 undefined）——崩溃幂等标记挂在本进程的
    // running 上，error+exit 双发时后来者才能识别并跳过。
    await this.registerCrash(snapshot, entry, error, running);
  }

  /** 崩溃登记：计数落注册表、退避排程、达阈值熔断 + 通知。 */
  private async registerCrash(
    snapshot: ScriptWorkspaceSnapshot,
    entry: TriggerEntry,
    error: string,
    running: RunningScript | undefined,
  ): Promise<void> {
    if (running !== undefined) {
      // 修复（2026-11-23）：'error' 与 'exit' 双发只计一次（见 RunningScript.crashCounted）。
      if (running.crashCounted) return;
      running.crashCounted = true;
      const key = keyOf(running.workspacePath, entry.id);
      this.processes.delete(key);
      await this.flushLogs(snapshot, entry, running, null, null);
    }
    let circuitBroke = false;
    let failNow = 1;
    await this.callbacks.updateRuntimeState({
      workspacePath: snapshot.workspacePath,
      triggerId: entry.id,
      apply: (target) => {
        target.lastResult = "error";
        target.consecutiveFailures += 1;
        failNow = target.consecutiveFailures;
        if (
          target.status === "active" &&
          target.consecutiveFailures >= SCRIPT_CIRCUIT_BREAK_THRESHOLD
        ) {
          target.status = "error-paused";
          circuitBroke = true;
        }
        target.updatedAt = new Date().toISOString();
      },
    });
    void this.callbacks.audit(snapshot.workspacePath, entry.id, {
      action: "crash",
      error: clipScriptOutput(error, 2_000),
    });
    this.callbacks.log(`resident script ${entry.id} crashed: ${clipScriptOutput(error, 200)}`);
    if (circuitBroke) {
      this.callbacks.notifyCircuitBreak({
        workspacePath: snapshot.workspacePath,
        triggerId: entry.id,
        triggerName: entry.name,
        consecutiveFailures: SCRIPT_CIRCUIT_BREAK_THRESHOLD,
        lastError: clipScriptOutput(error, 500),
      });
      // 熔断唤醒订阅者（2026-11-23，用户需求回补）：此前熔断只发应用内通知（给用户），
      // 订阅者智能体不被唤醒——"脚本报异常或反复崩溃自动唤醒创建它的智能体修复"只有
      // 契约违例路径（deliverScriptError）成立，进程崩溃熔断路径缺失。这里补投
      // script-error 事件（带诊断信息）进订阅者会话，修复闭环与契约违例一致；
      // 应用内通知保留（用户知情权不收回）。
      this.callbacks.onEvent(sessionKeyOf(entry), {
        kind: "script-error",
        at: new Date().toISOString(),
        summary: `${entry.name} circuit-breaker opened after ${SCRIPT_CIRCUIT_BREAK_THRESHOLD} consecutive crashes: ${clipScriptOutput(error, 200)}`,
        error: clipScriptOutput(error),
      });
      return;
    }
    // 退避重启（单一驱动源：reconcile 到点拉起；计数被 re-enable 清零则立即作废）。
    const schedule = this.backoffSchedule;
    const backoff = schedule[Math.min(Math.max(failNow - 1, 0), schedule.length - 1)] ?? 60_000;
    this.backoffUntil.set(keyOf(snapshot.workspacePath, entry.id), Date.now() + backoff);
  }

  // ---------------------------------------------------------------------------
  // 停止与日志
  // ---------------------------------------------------------------------------

  private initiateStop(key: string, running: RunningScript, reason: string): void {
    if (running.stopping) return;
    running.stopping = true;
    this.callbacks.log(`stopping resident script ${running.triggerId} (${reason})`);
    // 分层软停止（t0，2026-11-22 修订）：node = IPC shutdown 消息（脚本走 onShutdown
    // 收尾）；python 无注入通道，POSIX 直接对进程组 SIGTERM（脚本可捕获做优雅收尾），
    // Windows 无对等软信号——脚本仍有宽限窗口把在途 stdout 行冲完。宽限到点由
    // killProcessTree 硬终止兜底。
    if (running.runtime === "node") {
      try {
        running.child.send?.({ type: "robinrun-shutdown" });
      } catch {
        // 通道已断：直接强杀路径。
      }
    } else if (process.platform !== "win32") {
      const pid = running.child.pid;
      if (pid !== undefined) {
        try {
          process.kill(-pid, "SIGTERM"); // detached 负 pid = 进程组
        } catch {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // 进程已退出。
          }
        }
      }
    }
    const graceTimer = setTimeout(() => {
      const pid = running.child.pid;
      if (pid === undefined) return;
      this.callbacks.log(`killing resident script process tree ${running.triggerId} (pid ${pid})`);
      killProcessTree(pid);
    }, SHUTDOWN_GRACE_MS);
    graceTimer.unref?.();
  }

  private waitForStop(key: string, running: RunningScript): Promise<void> {
    return new Promise((resolve) => {
      const child = running.child;
      if (child.exitCode !== null || child.killed) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS + 2_000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async flushLogs(
    snapshot: ScriptWorkspaceSnapshot,
    entry: TriggerEntry,
    running: RunningScript,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (running.stdoutTail.length === 0 && running.stderrTail.length === 0) return;
    const payload: Record<string, unknown> = {
      action: "logs",
      ...(code !== null ? { exitCode: code } : {}),
      ...(signal !== null ? { signal } : {}),
      ...(running.stdoutTail.length > 0
        ? { stdoutTail: running.stdoutTail.join("\n").slice(-MAX_LOG_LINE_CHARS * 4) }
        : {}),
      ...(running.stderrTail.length > 0
        ? { stderrTail: running.stderrTail.join("\n").slice(-MAX_LOG_LINE_CHARS * 4) }
        : {}),
    };
    await this.callbacks.audit(snapshot.workspacePath, entry.id, payload);
  }
}

function sessionKeyOf(entry: TriggerEntry): string {
  return entry.groupId === null ? `trigger:${entry.id}` : `trigger-group:${entry.groupId}`;
}

/**
 * 进程树硬终止（停止分层的最后一层，宽限到点无条件执行）：Windows taskkill /T /F
 * （detached + /T：连 playwright 等孙子进程一并终止，child.kill 只杀直接进程）；POSIX
 * 进程组 SIGKILL → 单进程兜底。2026-11-22 修复：原 POSIX 分支在此处只发一轮 SIGTERM
 * 且无升级，忽略 SIGTERM 的脚本会永久悬挂（旧注释"SIGTERM→SIGKILL 由宽限定时器分层"
 * 与实现不符）——软 SIGTERM 已前移到 initiateStop 的 t0，本函数即无条件的 SIGKILL 层。
 */
function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL"); // detached 负 pid = 进程组
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 进程已退出。
    }
  }
}
