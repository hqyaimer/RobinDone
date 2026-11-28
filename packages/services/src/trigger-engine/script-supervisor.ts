/* oxlint-disable eslint(max-lines) -- 常驻脚本监督器共享单一 RunningScript 状态机（生命周期/
 * 崩溃熔断/定时执行/托管浏览器/暂停收口五条路径读写同一状态），机械拆分会切断状态所有者；
 * 拆分计划已登记 progress.md 已知待改（P3 第二十三批：拆事件校验与退出收口两块），拆完移除本条。 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import {
  DEFAULT_TRIGGER_SCRIPT_RESIDENT_GLOBAL_MAX,
  DEFAULT_TRIGGER_SCRIPT_RESIDENT_PER_WORKSPACE,
  triggerDirectoryConvention,
  type TriggerEntry,
} from "@robindone/shared";
import type { TriggerEvent } from "./contract.js";
import type { ScriptEmitResult } from "./local-webhook-server.js";
import { TRIGGER_EMIT_ROUTE_PREFIX } from "./local-webhook-server.js";
import { assertContract, clipScriptOutput, resolveRuntimeCommand } from "./script-runner.js";
import { TRIGGER_PAUSE_ROUTE_PREFIX } from "./local-webhook-server.js";
// 桥接模块源码（P3 第二十三批拆出，文件行数上限；纯常量零依赖）。
import { BRIDGE_SOURCE, PYTHON_BRIDGE_SOURCE } from "./script-bridges.js";

/**
 * 常驻脚本触发器的进程托管（ScriptSupervisor，2026-11-21 常驻模型裁决，
 * docs/trigger-system.md「触发器类型 → 脚本」节修订；2026-11-22 python 主运行时改造）。
 *
 * 模型：脚本触发器 = 常驻事件源进程，**不是**按周期 spawn 的批处理。引擎托管生命周期：
 * - 触发器 active 即应运行（挂载/客户端启动/5s 轮询/注册表变化都会 reconcile）；
 * - 双运行时（2026-11-22 python 主 + node 备选）：python 走供给链（托管解释器自动下载
 *   + 按项目 venv，经 resolvePythonRuntime 回调注入 venv 解释器），事件协议 = **HTTP
 *   emit 端点**（`__robindone/emit/<trg-id>`，注入 robindone.py 桥接 + PYTHONPATH，同步
 *   ack——并发安全，stdout 退役为纯日志）；node 备选保留 IPC 桥接
 *   （`robindone.emit`/`onShutdown`）。
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
 * 拉起——单一驱动源，无 timer 泄漏面。并发配额可配置（2026-11-25：AppSettings
 * triggerScriptResidentPerWorkspace / triggerScriptResidentGlobalMax，默认 20/60）。
 */

/** 每进程日志环形上限（退出时一次性进审计）。 */
const MAX_LOG_LINES = 200;
const MAX_LOG_LINE_CHARS = 4_000;
/** 崩溃退避序列（按 consecutiveFailures 取索引，越界取末位）。 */
const RESTART_BACKOFF_MS = [5_000, 15_000, 60_000];
/** 优雅停止宽限（shutdown 消息后等脚本自行退出）。 */
const SHUTDOWN_GRACE_MS = 10_000;
/**
 * 常驻脚本并发配额缺省值（2026-11-25 可配置化裁决，docs/trigger-system.md「资源与重入控制」）：
 * 实际值经 resolveScriptQuotas 回调从 AppSettings 读取（triggerScriptResidentPerWorkspace /
 * triggerScriptResidentGlobalMax，默认 20/60——接近不设限先看实际情况），每轮 reconcile 起点
 * 读取一次，设置改动 ≤5s 生效无需重启。定时执行模式（runMode="scheduled"）的运行不占此配额。
 * 超限本轮跳过，下轮 poll 重试；回调缺席/失败/非法值回退这里的缺省。
 */
const SCRIPTS_PER_WORKSPACE = DEFAULT_TRIGGER_SCRIPT_RESIDENT_PER_WORKSPACE;
const SCRIPTS_GLOBAL_MAX = DEFAULT_TRIGGER_SCRIPT_RESIDENT_GLOBAL_MAX;
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
  resolvePythonRuntime?(
    workspacePath: string,
  ): Promise<{ ok: true; interpreterPath: string; venvDir: string } | { ok: false; error: string }>;
  /**
   * 常驻脚本并发配额解析（2026-11-25 可配置化；引擎注入：读 AppSettings
   * triggerScriptResidentPerWorkspace / triggerScriptResidentGlobalMax）。每轮 reconcile
   * 起点调用一次；缺席/抛错/非法值回退内置缺省（20/60），配额兜底不因设置读取失败停摆。
   */
  resolveScriptQuotas?(): Promise<{ perWorkspace: number; globalMax: number }>;
  /**
   * 引擎托管浏览器实例（2026-11-25，specs/trigger-browser-hosting.md）：声明 profile 的
   * 脚本在 spawn 前 acquire（CDP endpoint 注入 env）、退出后 release（storageState 回写
   * 档案）。缺席 = 旧行为（脚本自管 playwright；测试形态）。
   */
  acquireBrowser?(
    workspacePath: string,
    profile: string,
    headed: boolean,
  ): Promise<{ ok: true; cdpEndpoint: string } | { ok: false; error: string }>;
  releaseBrowser?(workspacePath: string, profile: string): Promise<void>;
}

export interface ScriptWorkspaceSnapshot {
  workspacePath: string;
  /** 该工作区注册表的全部触发器条目（supervisor 自行过滤 script 型）。 */
  triggers: TriggerEntry[];
  /** 本地 webhook 服务基址（脚本 env 透传 ROBINDONE_WEBHOOK_BASE_URL）。 */
  webhookBaseUrl?: string;
}

/**
 * 脚本运行模式（2026-11-25 定时执行模式裁决）：resident=常驻事件源进程（active 即拉起，
 * exit 0 → completed 终态）；oneshot=定时执行的一趟（引擎调度器到点 spawn，采集 → emit →
 * exit 0 后状态保持 active 等 next fire，exit 0 不置 completed）。运行中的 oneshot 不占
 * 常驻并发配额（用户裁决），配置/脚本内容变更不打断在途趟。
 */
export type ScriptRunMode = "resident" | "oneshot";

interface RunningScript {
  workspacePath: string;
  triggerId: string;
  triggerName: string;
  sessionKey: string;
  /** 脚本运行时（停止分层按它选软信号：node=IPC shutdown；python=POSIX SIGTERM）。 */
  runtime: "node" | "python";
  /** 运行模式（见 ScriptRunMode；决定 exit 0 语义与配额计入）。 */
  mode: ScriptRunMode;
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
  /**
   * 引擎托管浏览器档案（2026-11-25）：声明 profile 且 acquire 成功时在场。停止/退出路径
   * 据此 release（storageState 回写档案）；幂等 release，重复调用安全。
   */
  browserProfile?: string;
  /**
   * 退出收口已执行标志（2026-11-25 幽灵计数防御）：handleExit 开头置位。exit 事件在真实
   * 环境下存在丢失/未达的可能（Windows 进程收割/杀软竞态），丢失时条目以"child 已死仍在
   * map"的僵尸态占住常驻配额（2026-11-25 RobinDoneOps 真机缺陷：配额 1/1 下 scheduled 趟
   * 后 A+B 永久 deferred）——reconcile 的 sweepZombieEntries 按本标志幂等补收口。
   */
  exitedHandled?: boolean;
}

/** 脚本主文件内容戳：mtimeMs:size；文件不存在/不可 stat 返回 "missing"（不抛）。 */
async function contentStampOf(
  snapshot: ScriptWorkspaceSnapshot,
  entry: TriggerEntry,
): Promise<string> {
  if (entry.config.kind !== "script") return "";
  const scriptPath = join(
    snapshot.workspacePath,
    ".robindone",
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
      // 与 ROBINDONE_TRIGGER_SESSION_KEY 继续指向旧组会话（新组永远收不到事件）、契约校验
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

  /** 常驻模式运行中的进程数（含 stopping 中的，防超卖）。oneshot 定时执行趟不占配额（2026-11-25 用户裁决）。 */
  private get runningCount(): number {
    let count = 0;
    for (const running of this.processes.values()) {
      if (running.mode === "resident") count += 1;
    }
    return count;
  }

  private runningCountFor(workspacePath: string): number {
    let count = 0;
    for (const running of this.processes.values()) {
      if (running.workspacePath === workspacePath && running.mode === "resident") count += 1;
    }
    return count;
  }

  /**
   * 解析当前生效的常驻并发配额（2026-11-25 可配置化）：回调缺席/抛错/返回非法值一律回退
   * 内置缺省。配额是资源兜底而非业务主链路，宿主设置读取失败不能导致脚本永不拉起。
   */
  private async resolveQuotas(): Promise<{ perWorkspace: number; globalMax: number }> {
    const fallback = (): { perWorkspace: number; globalMax: number } => ({
      perWorkspace: SCRIPTS_PER_WORKSPACE,
      globalMax: SCRIPTS_GLOBAL_MAX,
    });
    if (this.callbacks.resolveScriptQuotas === undefined) return fallback();
    try {
      const resolved = await this.callbacks.resolveScriptQuotas();
      const sanitize = (value: number, fallbackValue: number): number =>
        Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallbackValue;
      return {
        perWorkspace: sanitize(resolved.perWorkspace, SCRIPTS_PER_WORKSPACE),
        globalMax: sanitize(resolved.globalMax, SCRIPTS_GLOBAL_MAX),
      };
    } catch (error) {
      this.callbacks.log(
        `script quota resolution failed, falling back to defaults: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return fallback();
    }
  }

  /**
   * 僵尸条目清扫（2026-11-25 幽灵计数防御，RobinDoneOps 真机缺陷回归）：不变量 =
   * processes map 里的条目必须是活进程（child.exitCode/signalCode === null）。真实环境
   * （杀软/Windows 进程收割/python）下 exit 事件存在丢失/未达的可能，丢失时条目以
   * "child 已死仍在 map"的僵尸态**占住常驻配额**——真机形态即配额 1/1 下 scheduled 趟后
   * 全部常驻永久 deferred（handleExit/registerCrash 两条正常删除路径都带日志+审计，而
   * 现场两者皆无，即此形态）。每轮 reconcile 开头按 exitedHandled 幂等补收口：
   * 补收口 = 删条目 + 浏览器档案释放 + 审计 zombie-swept（**不写** completed/崩溃——
   * 真实退出码已不可考，不污染触发器状态机；resident 随下一轮 reconcile 按期望状态
   * 正常拉起）。exit 事件正常到达时 handleExit 先置 exitedHandled，清扫跳过（不双跑）。
   */
  private sweepZombieEntries(): void {
    for (const [key, running] of this.processes) {
      if (running.exitedHandled === true) continue;
      if (running.child.exitCode === null && running.child.signalCode === null) continue;
      this.callbacks.log(
        `zombie entry swept: ${running.triggerId} (mode ${running.mode}, exit code ${
          running.child.exitCode ?? "null"
        }, key ${key}) — exit event was lost`,
      );
      this.processes.delete(key);
      if (running.browserProfile !== undefined) {
        void this.callbacks
          .releaseBrowser?.(running.workspacePath, running.browserProfile)
          .catch(() => undefined);
      }
      void this.callbacks
        .audit(running.workspacePath, running.triggerId, {
          action: "zombie-swept",
          mode: running.mode,
          exitCode: running.child.exitCode,
        })
        .catch(() => undefined);
    }
  }

  /** 常驻条目概要（deferred 日志附带，幽灵占位的现场可观测形态）。 */
  private describeResidentEntries(): string {
    const parts: string[] = [];
    for (const [key, running] of this.processes) {
      if (running.mode !== "resident") continue;
      parts.push(
        `${key}(pid=${running.child.pid ?? "?"},alive=${running.child.exitCode === null})`,
      );
    }
    return parts.length > 0 ? parts.join(", ") : "none";
  }

  /**
   * 对齐全部工作区的常驻脚本进程与注册表期望状态（引擎 5s 轮询/挂载/注册表变化时调用）。
   * 幂等：已在运行且签名一致 → 不动；期望停 → 优雅停；期望跑且不在退避窗口 → 拉起。
   */
  async reconcile(snapshots: ScriptWorkspaceSnapshot[]): Promise<void> {
    if (this.disposed) return;
    // 配额每轮 reconcile 起点读取一次（2026-11-25 可配置化）：设置改动 ≤5s 生效，无需重启。
    const quotas = await this.resolveQuotas();
    this.sweepZombieEntries();
    const desired = new Map<string, { snapshot: ScriptWorkspaceSnapshot; entry: TriggerEntry }>();
    for (const snapshot of snapshots) {
      for (const trigger of snapshot.triggers) {
        if (trigger.config.kind !== "script") continue;
        desired.set(keyOf(snapshot.workspacePath, trigger.id), { snapshot, entry: trigger });
      }
    }

    // 1. 期望停止 / 条目消失 / 签名或脚本内容变更 → 停止（变更标记 restart，停止后下轮拉起）。
    //    oneshot 在跑趟例外（2026-11-25 定时执行模式）：配置/内容变更不打断在途运行——本趟
    //    按 spawn 时代码跑完即退，下次到点自然用新值；只有期望停止/条目消失才终止。
    // Map 迭代中删除当前项是安全的（JS 规范保证，oxlint iteral 规则）：await 让出期间
    // exit 事件删除的条目不再被访问——已死进程本就无需 initiateStop。
    for (const [key, running] of this.processes) {
      const want = desired.get(key);
      const stillActive =
        want !== undefined && want.entry.status === "active" && want.entry.config.kind === "script";
      let changeReason: "config-changed" | "script-changed" | undefined;
      if (stillActive && want !== undefined && running.mode === "resident") {
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

    // 2. 期望运行且无进程 → 拉起（配额内；退避窗口内跳过）。scheduled 模式不在此拉起——
    //    到点由引擎调度器驱动 spawnScheduledRun（2026-11-25 定时执行模式）。
    for (const [key, want] of desired) {
      if (this.processes.has(key)) continue;
      if (want.entry.status !== "active") continue;
      if (want.entry.config.kind === "script" && want.entry.config.runMode === "scheduled")
        continue;
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
      if (this.runningCount >= quotas.globalMax) {
        // deferred 附带当前占用数 + 常驻条目概要（2026-11-25 真机复核：quota 后附占用数，
        // 防止上限值被误读为"卡死的计数"——全局配额跨项目共享，占用者常在别的项目工作区，
        // 只看本项目侧栏会得出"没人占位却 defer"的错误结论）。
        this.callbacks.log(
          `script start deferred (global quota ${quotas.globalMax}, resident running ${this.runningCount}): ${key} — resident in map: ${this.describeResidentEntries()}`,
        );
        continue;
      }
      if (this.runningCountFor(want.snapshot.workspacePath) >= quotas.perWorkspace) {
        this.callbacks.log(
          `script start deferred (workspace quota ${quotas.perWorkspace}, resident running ${this.runningCountFor(want.snapshot.workspacePath)}): ${key} — resident in map: ${this.describeResidentEntries()}`,
        );
        continue;
      }
      await this.startProcess(want.snapshot, want.entry);
    }
  }

  /**
   * 定时执行模式到点拉起（2026-11-25；engine.onScheduleFire 驱动）：spawn 一趟 oneshot
   * 运行（采集 → emit → exit 0）。与 resident 的差异：
   * - 不占常驻并发配额（用户裁决——定时趟是短命瞬发进程，重入跳过已防堆积）；
   * - 重入默认跳过记审计（对齐 docs/trigger-system.md「重入控制：同一触发器上一次执行
   *   未结束时，定时到点默认跳过并记审计」）；
   * - 崩溃退避/熔断与 resident 共用同一状态机（backoffUntil / consecutiveFailures 落注册表），
   *   熔断后触发器 error-paused 离开调度，re-enable 清零即恢复。
   */
  async spawnScheduledRun(snapshot: ScriptWorkspaceSnapshot, entry: TriggerEntry): Promise<void> {
    if (this.disposed) return;
    if (entry.config.kind !== "script") return;
    const key = keyOf(snapshot.workspacePath, entry.id);
    // 重入：上一趟未结束 → 跳过记审计（不延后，下个周期自然再跑）。
    if (this.processes.has(key)) {
      this.callbacks.log(`scheduled run skipped (previous run still active): ${key}`);
      void this.callbacks
        .audit(snapshot.workspacePath, entry.id, {
          action: "scheduled-run-skipped",
          reason: "overlap",
        })
        .catch(() => undefined);
      return;
    }
    // 崩溃退避窗口内跳过（与 resident 同一状态机；re-enable 清零计数即作废退避）。
    const backoff = this.backoffUntil.get(key);
    if (backoff !== undefined) {
      if (entry.consecutiveFailures === 0) {
        this.backoffUntil.delete(key);
      } else if (Date.now() < backoff) {
        this.callbacks.log(`scheduled run skipped (crash backoff): ${key}`);
        void this.callbacks
          .audit(snapshot.workspacePath, entry.id, {
            action: "scheduled-run-skipped",
            reason: "backoff",
          })
          .catch(() => undefined);
        return;
      } else {
        this.backoffUntil.delete(key);
      }
    }
    await this.startProcess(snapshot, entry, "oneshot");
  }

  /** 应用退出：全部停止并等待退出（宽限兜底后强杀）。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    const stops: Promise<void>[] = [];
    // Map 迭代中删除当前项是安全的（JS 规范保证），无需快照数组（oxlint iteral 检查）。
    for (const [key, running] of this.processes) {
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
    mode: ScriptRunMode = "resident",
  ): Promise<void> {
    if (entry.config.kind !== "script") return;
    const key = keyOf(snapshot.workspacePath, entry.id);
    const triggerDir = join(snapshot.workspacePath, ".robindone", "triggers", entry.id);
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

    // 启动日志按 mode 分变体（2026-11-25 真机反馈：scheduled 走本路径时打"resident"
    // 误导排查——报告疑点 1 即由此起）。
    this.callbacks.log(
      mode === "oneshot"
        ? `starting scheduled run ${entry.id} (${entry.config.runtime})`
        : `starting resident script ${entry.id} (${entry.config.runtime})`,
    );
    // 引擎托管浏览器（2026-11-25）：声明 profile 且端口在场 → spawn 前 acquire（同档案
    // 串行；失败按一次崩溃收口，退避重试）。CDP endpoint 注入 env（buildSpawnPlan 之后
    // 补写 plan.env——profile 相关 env 不属于通用 spawn 计划）。
    let browserProfile: string | undefined;
    const wantsBrowser =
      mode === "resident" || mode === "oneshot"
        ? entry.config.profile !== undefined && this.callbacks.acquireBrowser !== undefined
        : false;
    if (wantsBrowser && entry.config.profile !== undefined) {
      const acquisition = await this.callbacks.acquireBrowser!(
        snapshot.workspacePath,
        entry.config.profile,
        entry.config.headed === true,
      );
      if (!acquisition.ok) {
        await this.registerCrash(
          snapshot,
          entry,
          `browser acquire failed for profile ${entry.config.profile}: ${acquisition.error}`,
          undefined,
        );
        return;
      }
      browserProfile = entry.config.profile;
      plan.env.ROBINDONE_CDP_ENDPOINT = acquisition.cdpEndpoint;
      plan.env.ROBINDONE_TRIGGER_PROFILE = entry.config.profile;
    }
    // 内容戳在 spawn 前取（2026-11-25 修复）：spawn 与 error/exit 处理器挂载之间不允许有
    // await——spawn 失败（如 cwd 已被外部删除 → ENOENT）的 'error' 事件在下一 tick 即到，
    // 若中间让出事件循环，处理器未挂载即成 uncaught exception 崩掉 host 常驻服务。
    const stamp = await contentStampOf(snapshot, entry);
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
      if (browserProfile !== undefined) {
        await this.callbacks.releaseBrowser?.(snapshot.workspacePath, browserProfile);
      }
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
      mode,
      entry,
      child,
      signature: signatureOf(entry),
      contentStamp: stamp,
      stdoutTail: [],
      stderrTail: [],
      stdoutLineBuffer: new LineBuffer(),
      stderrLineBuffer: new LineBuffer(),
      stopping: false,
      ...(browserProfile !== undefined ? { browserProfile } : {}),
    };
    this.processes.set(key, running);
    // 修复（2026-11-23）：以下 fire-and-forget 回调统一补 .catch——handleIpcMessage/
    // registerCrash/handleExit/audit 内部含注册表落盘等 fs 操作，磁盘满/杀软锁文件等
    // 错误一旦 reject 即 unhandledRejection，Node 默认崩溃进程（host 常驻服务被带崩）。
    this.callbacks
      .audit(snapshot.workspacePath, entry.id, {
        action: "start",
        runtime: entry.config.runtime,
        mode,
        ...(pythonRuntime !== undefined ? { venv: pythonRuntime.venvDir } : {}),
        entry: entry.config.entry,
      })
      .catch((error: unknown) =>
        this.callbacks.log(
          `audit write failed for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );

    // 事件通道（Node 桥接 IPC）：{type:"robindone-event", id, event} → 校验/投递/ack。
    // python 走 HTTP emit 端点（LocalWebhookServer __robindone/emit → handleEmitRequest），
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
    env.ROBINDONE_TRIGGER_ID = entry.id;
    env.ROBINDONE_TRIGGER_DIR = join(snapshot.workspacePath, ".robindone", "triggers", entry.id);
    env.ROBINDONE_TRIGGER_SESSION_KEY =
      entry.groupId === null ? `trigger:${entry.id}` : `trigger-group:${entry.groupId}`;
    if (snapshot.webhookBaseUrl !== undefined) {
      env.ROBINDONE_WEBHOOK_BASE_URL = snapshot.webhookBaseUrl;
    }
    if (entry.config.runtime === "node") {
      // 桥接模块每次拉起都重写（内容常量，幂等且保证最新契约）。
      const bridgePath = await this.ensureBridgeFile(snapshot.workspacePath);
      if (snapshot.webhookBaseUrl !== undefined) {
        // 登录闭环暂停端点（2026-11-25）：node 桥接的 loginFailed 同走 HTTP。
        env.ROBINDONE_PAUSE_URL = `${snapshot.webhookBaseUrl}/${TRIGGER_PAUSE_ROUTE_PREFIX}${entry.id}`;
      }
      return {
        command: runtimeCommand,
        args: [...runtimeArgs, "--require", bridgePath, entry.config.entry],
        cwd: scriptDir,
        env,
        ipc: true,
      };
    }
    // python 主运行时（2026-11-22 HTTP emit 协议）：注入 robindone.py 桥接（PYTHONPATH）+
    // emit 端点 URL；PYTHONUNBUFFERED/PYTHONUTF8 保留（stdout 专职日志的时效与编码）；
    // venv 在场时追加 VIRTUAL_ENV（子进程工具链约定）与 ROBINDONE_PYTHON（脚本/调试）。
    env.PYTHONUNBUFFERED = "1";
    env.PYTHONUTF8 = "1";
    if (params.pythonRuntime !== undefined) {
      env.VIRTUAL_ENV = params.pythonRuntime.venvDir;
      env.ROBINDONE_PYTHON = params.pythonRuntime.interpreterPath;
    }
    const stateDir = join(snapshot.workspacePath, ".robindone", "triggers", "state");
    await this.ensurePythonBridgeFile(stateDir);
    env.PYTHONPATH = env.PYTHONPATH ? `${stateDir}${delimiter}${env.PYTHONPATH}` : stateDir;
    if (snapshot.webhookBaseUrl !== undefined) {
      env.ROBINDONE_EMIT_URL = `${snapshot.webhookBaseUrl}/${TRIGGER_EMIT_ROUTE_PREFIX}${entry.id}`;
      // 登录闭环暂停端点（2026-11-25）：与 emit 同基址同信任面。
      env.ROBINDONE_PAUSE_URL = `${snapshot.webhookBaseUrl}/${TRIGGER_PAUSE_ROUTE_PREFIX}${entry.id}`;
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
    const dir = join(workspacePath, ".robindone", "triggers", "state", "bridge");
    const file = join(dir, "robindone-bridge.cjs");
    await mkdir(dir, { recursive: true });
    await writeFile(file, BRIDGE_SOURCE, "utf8");
    return file;
  }

  /** python 桥接模块（state/robindone.py）：每次拉起重写（内容常量，幂等且保证最新契约）。 */
  private async ensurePythonBridgeFile(stateDir: string): Promise<void> {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "robindone.py"), PYTHON_BRIDGE_SOURCE, "utf8");
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
    if (message.type !== "robindone-event") return; // 脚本自用 process.send 一律忽略
    const id = typeof message.id === "number" ? message.id : -1;
    const result = await this.validateAndDeliver(snapshot, entry, message.event);
    try {
      running.child.send?.({
        type: "robindone-ack",
        id,
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
      });
    } catch {
      // 通道已断（脚本退出中）：ack 失败不影响投递。
    }
  }

  /**
   * python 脚本 emit 端点处理（2026-11-22 HTTP emit 协议；LocalWebhookServer 的
   * `__robindone/emit/<trg-id>` 注入此处）：按触发器 id 找**正在运行**的脚本（跨工作区扫
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
   * 脚本暂停上报处理（2026-11-25 登录闭环，specs/trigger-browser-hosting.md §3.4；
   * LocalWebhookServer `__robindone/pause/<trg-id>` 注入此处）：脚本自含的登录检测失败时
   * 调用。语义：这不是崩溃（consecutiveFailures 不动），是登录态过期——audit 记
   * login-failed → 投 script-error 事件（带诊断，唤醒订阅者修复）→ 触发器置 error-paused
   * （异常且停用，用户裁决）→ 复用熔断通知通道（reason=login-failed）→ 停脚本。
   * 返回与 emit 同构的 {ok}（脚本侧 raise 与否不敏感——脚本随后即被停止）。
   */
  async handlePauseRequest(
    triggerId: string,
    reason: string,
  ): Promise<ScriptEmitResult | undefined> {
    for (const running of this.processes.values()) {
      if (running.triggerId !== triggerId) continue;
      const snapshot: ScriptWorkspaceSnapshot = {
        workspacePath: running.workspacePath,
        triggers: [running.entry],
      };
      const entry = running.entry;
      const clipped = clipScriptOutput(reason || "login check failed", 500);
      await this.callbacks.audit(snapshot.workspacePath, entry.id, {
        action: "login-failed",
        reason: clipped,
      });
      this.callbacks.onEvent(sessionKeyOf(entry), {
        kind: "script-error",
        at: new Date().toISOString(),
        summary: `${entry.name} login check failed: ${clipScriptOutput(clipped, 200)} — trigger paused; run ManageTriggers open_login to refresh the login profile, then set_status back to active`,
        error: clipped,
      });
      await this.callbacks.updateRuntimeState({
        workspacePath: snapshot.workspacePath,
        triggerId: entry.id,
        apply: (target) => {
          target.lastResult = "error";
          target.updatedAt = new Date().toISOString();
          if (target.status === "active") target.status = "error-paused";
        },
      });
      this.callbacks.notifyCircuitBreak({
        workspacePath: snapshot.workspacePath,
        triggerId: entry.id,
        triggerName: entry.name,
        consecutiveFailures: entry.consecutiveFailures,
        lastError: `login-failed: ${clipped}`,
      });
      // 停脚本（登录态已失效，继续跑没有意义；不算崩溃）。
      this.initiateStop(keyOf(snapshot.workspacePath, entry.id), running, "login-failed");
      return { ok: true };
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
    // scheduled 模式（2026-11-25）：lastFireAt 保持为调度器 fire 时刻（onScheduleFire 写入）
    // ——emit 时不再前推，否则 interval 锚点会随每趟运行时长漂移（周期越跑越晚）。
    const isScheduledRun = entry.config.kind === "script" && entry.config.runMode === "scheduled";
    await this.callbacks.updateRuntimeState({
      workspacePath: snapshot.workspacePath,
      triggerId: entry.id,
      apply: (target) => {
        if (!isScheduledRun) target.lastFireAt = at;
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
    // 幂等标志先置位（2026-11-25 幽灵计数防御）：sweepZombieEntries 按它识别"exit 事件
    // 已正常处理"——本函数与清扫二选一收口，绝不双跑（completed/stop 审计不能重复写）。
    running.exitedHandled = true;
    const key = keyOf(running.workspacePath, entry.id);
    this.processes.delete(key);
    this.drainPartialLines(running);
    // 托管浏览器释放（2026-11-25）：storageState 回写档案 → 关浏览器（幂等；尽力而为，
    // 失败不改变退出语义）。
    if (running.browserProfile !== undefined) {
      await this.callbacks
        .releaseBrowser?.(snapshot.workspacePath, running.browserProfile)
        .catch(() => undefined);
    }
    await this.flushLogs(snapshot, entry, running, code, signal);
    if (code === 0 && !running.stopping) {
      // 定时执行趟干净退出（2026-11-25）：exit 0 = 本趟成功，状态保持 active 等下一次到点
      // ——completed 终态语义只属于 resident 模式的一次性脚本。
      if (running.mode === "oneshot") {
        const at = new Date().toISOString();
        await this.callbacks.updateRuntimeState({
          workspacePath: snapshot.workspacePath,
          triggerId: entry.id,
          apply: (target) => {
            target.lastResult = "ok";
            target.consecutiveFailures = 0;
            target.updatedAt = at;
          },
        });
        void this.callbacks.audit(snapshot.workspacePath, entry.id, {
          action: "exit",
          code: 0,
          mode: "oneshot",
        });
        this.callbacks.log(`scheduled run ${entry.id} finished cleanly`);
        return;
      }
      // 干净退出 = 完成（resident 一次性脚本的自然终点）：completed 终态。
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
      // 托管浏览器释放（同 handleExit 语义；崩溃路径也不能漏——否则同档案队列悬挂）。
      if (running.browserProfile !== undefined) {
        await this.callbacks
          .releaseBrowser?.(snapshot.workspacePath, running.browserProfile)
          .catch(() => undefined);
      }
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
        running.child.send?.({ type: "robindone-shutdown" });
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
