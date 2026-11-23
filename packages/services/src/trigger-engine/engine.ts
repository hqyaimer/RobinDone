import { Cron } from "croner";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseTriggerSessionKey, sessionKeyForTrigger, type TriggerEntry } from "@robinrun/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  appendAudit,
  loadSessionBindings,
  mutateRegistry,
  parseRegistry,
  readRawRegistry,
  saveSessionBindings,
  type RegistryWritableState,
} from "./registry-io.js";
import {
  ITriggerEngineService,
  type PythonPackageInstallResult,
  type TriggerDispatchPort,
  type TriggerNotificationPort,
  type TriggerPythonRuntimePort,
  type TriggerRuntimeView,
  type TriggerTaskPort,
} from "./contract.js";
import { TriggerEventAggregator, resolveBatchTriggerFromRegistry } from "./event-aggregator.js";
import { LocalWebhookServer } from "./local-webhook-server.js";
import { TriggerScriptSupervisor, type ScriptWorkspaceSnapshot } from "./script-supervisor.js";

/**
 * 触发器引擎主体（2026-11-19 设计定稿，docs/trigger-system.md；2026-11-21 常驻脚本修订）。
 *
 * 职责：轮询各项目 `.robinrun/triggers/triggers.json`（5s，避免 fs.watch 的 inode 换名
 * 问题——workers.json 的原子写换 inode 会永久关闭旧 watcher，轮询没有这类生命周期 bug），
 * 调度 cron/interval 到点 fire；script 型 = 常驻事件源进程（ScriptSupervisor 托管生命
 * 周期，随轮询 reconcile）；事件按会话 key 聚合去抖后经 dispatch 端口投递（忙时合并，
 * 见 TriggerEventAggregator）；脚本崩溃达阈值熔断（error-paused + 通知端口）；本地
 * webhook 路由解析。
 *
 * 引擎对注册表只写运行时字段（lastFireAt/lastResult/consecutiveFailures/status 熔断与
 * completed），每次写都重新读盘-改-原子写（与 ManageTriggers 的并发窗口最小化，
 * v1 接受 last-writer-wins）。
 */

const POLL_INTERVAL_MS = 5_000;
const DEBOUNCE_MS = 3_000;
// setTimeout 单次上限约 24.8 天（2^31-1 ms）；长周期 cron 分片等待。
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface TriggerEngineOptions {
  /** 全部已注册项目工作区（host 项目树投影；引擎逐个挂载/卸载）。 */
  listWorkspaces(): Promise<
    Array<{ workspacePath: string; workspaceIdentity?: string; projectId?: string }>
  >;
  /** 会话投递端口（host 装配：克隆 dispatchCronRun 链）。 */
  dispatch: TriggerDispatchPort;
  /**
   * 会话忙查询（host 装配：task facade 的 active input 簿记）。裁决 7"存在且忙：
   * 入 per-session 队列，当前轮结束后合并为一条输入投递"的忙感知来源；缺席 = 逐批
   * 投递的退化行为。
   */
  isTaskBusy?(task: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<boolean> | boolean;
  /** 熔断通知端口（应用内通知 + 徽章；可选）。 */
  notify?: TriggerNotificationPort;
  /** 清空会话端口（host 装配：agent 服务清空消息 + 身份重置；缺席时大声失败）。 */
  tasks?: TriggerTaskPort;
  /**
   * python 主运行时端口（2026-11-22；host 装配：解释器供给 + venv + pip 安装）。缺席 =
   * python 主运行时未接线（测试/headless）：python 触发器退化为系统 PATH 探测旧行为、
   * installPackages 大声失败。接线后挂载即后台 ensure 可用性（状态落
   * `state/python-runtime.json` 供 CLI 门控与提示词双模式）。
   */
  pythonRuntime?: TriggerPythonRuntimePort;
  /** 引擎日志（缺省 createServiceLogger）。 */
  log?(message: string): void;
  /** 测试钩子：覆盖轮询/去抖间隔。 */
  pollIntervalMs?: number;
  debounceMs?: number;
}

interface WorkspaceState extends RegistryWritableState {
  workspaceIdentity?: string;
  projectId?: string;
  /** 挂载时刻（冷恢复不回补的基准）。 */
  mountedAt: number;
}

interface ScheduleHandle {
  timer: NodeJS.Timeout;
  /**
   * arm 时算定的目标时刻（未截断的 nextMs）。到点判定以它为准——不能用
   * computeNextFireMs 重算判定，见 onScheduleFire 内注释（2026-11-19 实测 bug）。
   */
  intendedMs: number;
}

export interface TriggerEngineHandle {
  dispose(): Promise<void>;
}

/**
 * cron 下一次触发（毫秒，本地时区；严格晚于 fromMs）。
 * 与 session/automationCron.computeNextRunAt 同款 croner 惯用法——在本模块内复制薄包装，
 * 避免 trigger-system 对 session 模块的跨模块深引（architecture:check 纪律）。
 */
function computeNextCronRunMs(expr: string, fromMs: number): number | null {
  // 修复（2026-11-23）：croner 对数值越界的表达式（如 99 99 99 99 99）直接 throw，而
  // shared/contracts 的 schema 只校验"5 段 + 字符集"不校验数值——语义非法的表达式可以
  // 入库。此前 rebuildSchedules 先清空全部已 armed 定时器再逐个重排，迭代到这里抛错会把
  // 本轮重排中断：本轮已被清空的定时器不恢复、坏触发器之后的全部 cron/interval 永不
  // re-arm，且 pollTick 的 changed 检测（注册表未变即不重建）使停摆永久化——一个坏表达式
  // 瘫痪全项目调度。此处捕获并跳过该触发器，坏表达式经 emitWarning 留痕。
  try {
    const next = new Cron(expr).nextRun(new Date(fromMs));
    return next ? next.getTime() : null;
  } catch (error) {
    process.emitWarning(
      `trigger cron expression invalid, schedule skipped: "${expr}" — ${error instanceof Error ? error.message : String(error)}`,
      { code: "ROBINRUN_TRIGGER_CRON_INVALID" },
    );
    return null;
  }
}

function triggersRoot(workspacePath: string): string {
  return join(workspacePath, ".robinrun", "triggers");
}

export function createTriggerEngineService(
  options: TriggerEngineOptions,
): ITriggerEngineService & TriggerEngineHandle {
  const serviceLogger = createServiceLogger("trigger-engine");
  const log = options.log ?? ((message: string) => void serviceLogger.info(message));
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;

  const workspaces = new Map<string, WorkspaceState>();
  const schedules = new Map<string, ScheduleHandle>();
  let disposed = false;
  /** 挂载/卸载发生但本轮未走完 change 检测时置位（首次挂载必须 arm 调度）。 */
  let rebuildNeeded = false;

  // 注册表读盘-改-原子写/会话绑定持久化/审计追加在 registry-io.ts（2026-11-21 拆分，
  // 文件行数上限）；此处经导入使用，fail-safe 纪律见其头注。

  // ---------------------------------------------------------------------------
  // 事件聚合（会话 key 维度：忙时排队、去抖合并投递——裁决 7 路由规则）。
  // 聚合器抽到 event-aggregator.ts（文件行数上限拆分）；对引擎状态的访问经回调。
  // ---------------------------------------------------------------------------

  const aggregator = new TriggerEventAggregator({
    debounceMs,
    log,
    resolveDeliveryTarget: (key) => {
      const state = resolveWorkspaceForSessionKey(key);
      if (state === undefined || state.registry === null) {
        log(`drop events for ${key}: workspace/registry unavailable`);
        return undefined;
      }
      // 组 key：任取组内一个 active 触发器做溯源；直连 key：触发器本身。
      const trigger = resolveBatchTrigger(state, key);
      if (trigger === undefined) {
        log(`drop events for ${key}: trigger unavailable`);
        return undefined;
      }
      return {
        workspacePath: state.workspacePath,
        ...(state.workspaceIdentity !== undefined
          ? { workspaceIdentity: state.workspaceIdentity }
          : {}),
        ...(state.projectId !== undefined ? { projectId: state.projectId } : {}),
        sessionBindings: state.sessionBindings,
        trigger,
      };
    },
    dispatch: (batch) => options.dispatch.dispatchTriggerEvent(batch),
    ...(options.isTaskBusy !== undefined ? { isTaskBusy: options.isTaskBusy } : {}),
    persistBindings: async (target) => {
      const state = workspaces.get(target.workspacePath);
      if (state !== undefined) await saveSessionBindings(state);
    },
  });

  /**
   * 解析会话 key 所属工作区：直连 key 按触发器 id 反查；组 key 按组 id 反查。
   * （2026-11-21 修正：旧实现组 key 恒解析失败 → 组订阅事件被静默丢弃——design 裁决 7
   * 的"同组事件共用该组会话"由此真正可用。）
   */
  function resolveWorkspaceForSessionKey(key: string): WorkspaceState | undefined {
    const parsed = parseTriggerSessionKey(key);
    if (parsed === null) return undefined;
    for (const state of workspaces.values()) {
      if (state.registry === null) continue;
      const present =
        parsed.kind === "trigger"
          ? // 伪删除（2026-11-21）条目不再解析投递目标（组 key 由成员 active 过滤兜底）。
            state.registry.triggers.some(
              (trigger) => trigger.id === parsed.triggerId && trigger.deleted !== true,
            )
          : state.registry.groups.some((group) => group.id === parsed.groupId);
      if (present) return state;
    }
    return undefined;
  }

  /** 组 key：任取组内一个 active 触发器做溯源；直连 key：触发器本身（组内全停 → undefined）。 */
  function resolveBatchTrigger(state: WorkspaceState, key: string): TriggerEntry | undefined {
    if (state.registry === null) return undefined;
    return resolveBatchTriggerFromRegistry(state.registry, key);
  }

  // ---------------------------------------------------------------------------
  // 调度：cron/interval 到点 fire
  // ---------------------------------------------------------------------------

  function scheduleOf(
    config: TriggerEntry["config"],
  ):
    | { kind: "cron"; schedule: string }
    | { kind: "interval"; intervalMinutes: number }
    | undefined {
    if (config.kind === "cron") return { kind: "cron", schedule: config.schedule };
    if (config.kind === "interval")
      return { kind: "interval", intervalMinutes: config.intervalMinutes };
    // script 型不再进调度（2026-11-21 常驻模型）：ScriptSupervisor 随轮询 reconcile 托管。
    return undefined;
  }

  function computeNextFireMs(
    config: TriggerEntry["config"],
    state: WorkspaceState,
    entry: TriggerEntry,
  ): number | null {
    const schedule = scheduleOf(config);
    if (schedule === undefined) return null;
    const now = Date.now();
    if (schedule.kind === "interval") {
      // 锚点推进（同上游 minute scheduleRule 语义）：anchor = lastFireAt ?? createdAt；
      // 冷恢复不回补——下界取挂载时刻。
      const anchorIso = entry.lastFireAt ?? entry.createdAt;
      const anchor = Date.parse(anchorIso);
      const base = Number.isNaN(anchor) ? state.mountedAt : anchor;
      const step = schedule.intervalMinutes * 60_000;
      const elapsed = Math.max(0, now - Math.max(base, state.mountedAt));
      return now + Math.max(step - (elapsed % step), 1_000);
    }
    const from = Math.max(Date.parse(entry.lastFireAt ?? "") || 0, state.mountedAt, now);
    return computeNextCronRunMs(schedule.schedule, from);
  }

  function clearSchedules(): void {
    for (const handle of schedules.values()) clearTimeout(handle.timer);
    schedules.clear();
  }

  function rebuildSchedules(): void {
    clearSchedules();
    for (const state of workspaces.values()) {
      if (state.registry === null) continue;
      for (const trigger of state.registry.triggers) {
        // 伪删除（2026-11-21）条目不进调度（status 已随 delete 一并停用，双保险）。
        if (trigger.status !== "active" || trigger.deleted === true) continue;
        const nextMs = computeNextFireMs(trigger.config, state, trigger);
        if (nextMs === null) continue;
        armSchedule(state, trigger, nextMs);
      }
    }
  }

  function armSchedule(state: WorkspaceState, trigger: TriggerEntry, nextMs: number): void {
    const key = `${state.workspacePath}::${trigger.id}`;
    const delay = Math.min(Math.max(nextMs - Date.now(), 1_000), MAX_TIMER_MS);
    const timer = setTimeout(() => {
      schedules.delete(key);
      // 修复（2026-11-23）：fire-and-forget 无兜底——onScheduleFire 内部 mutateRegistry
      // 落盘可抛（磁盘满/杀软锁文件），unhandledRejection 会崩掉 host 常驻进程。
      onScheduleFire(state.workspacePath, trigger.id, nextMs).catch((error: unknown) =>
        log(
          `schedule fire failed for ${trigger.id}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }, delay);
    timer.unref?.();
    schedules.set(key, { timer, intendedMs: nextMs });
  }

  async function onScheduleFire(
    workspacePath: string,
    triggerId: string,
    intendedMs: number,
  ): Promise<void> {
    if (disposed) return;
    const state = workspaces.get(workspacePath);
    if (state === undefined || state.registry === null) {
      log(`schedule fire skipped for ${triggerId}: workspace not mounted`);
      return;
    }
    // 写前重读（与 ManageTriggers 并发窗口最小化）；状态已变的触发器直接跳过。
    const fresh = parseRegistry(await readRawRegistry(workspacePath));
    if (fresh === null) {
      log(`schedule fire skipped for ${triggerId}: registry unreadable`);
      return;
    }
    const trigger = fresh.triggers.find((candidate) => candidate.id === triggerId);
    if (trigger === undefined || trigger.status !== "active" || trigger.deleted === true) {
      log(
        `schedule fire skipped for ${triggerId}: ${
          trigger === undefined
            ? "missing"
            : trigger.deleted === true
              ? "deleted"
              : `status=${trigger.status}`
        }`,
      );
      rebuildSchedules();
      return;
    }
    // 到点判定用 arm 时记录的目标时刻（setTimeout 只会迟到不会早到），不能用
    // computeNextFireMs 重算判定：锚点推进公式在到点时刻重算恒返回下一个整锚点
    // （interval 即整整一个周期之后），会被误判为「未真正到点」而无限重排，导致
    // interval/cron 触发器永不投递（2026-11-19 实测 bug，回归见 triggerEngineScheduling）。
    // 本守卫只负责 MAX_TIMER_MS（约 24.8 天）分片唤醒的情形：唤醒时刻仍早于目标
    // 1.5s 以上时，按真实下一次到点重算续排。
    const nowMs = Date.now();
    if (intendedMs - nowMs > 1_500) {
      const dueAt = computeNextFireMs(trigger.config, state, trigger);
      if (dueAt !== null && dueAt > nowMs) armSchedule(state, trigger, dueAt);
      log(
        `schedule fire deferred for ${triggerId}: woken ${Math.round((intendedMs - nowMs) / 1000)}s early (timer fragment)`,
      );
      return;
    }
    log(`scheduled fire ${triggerId} (${trigger.config.kind})`);

    // cron/interval：直接投递调度事件（script 型走 ScriptSupervisor，不进本路径）。
    const firedAt = new Date().toISOString();
    await mutateRegistry(state, (registry) => {
      const entry = registry.triggers.find((candidate) => candidate.id === triggerId);
      if (entry !== undefined) {
        entry.lastFireAt = firedAt;
        entry.updatedAt = firedAt;
      }
    });
    void appendAudit(workspacePath, triggerId, { action: "fire", kind: trigger.config.kind });
    aggregator.enqueue(sessionKeyForTrigger(trigger), {
      kind: "schedule",
      at: firedAt,
      summary:
        trigger.config.kind === "cron"
          ? `Scheduled fire (cron: ${trigger.config.schedule})`
          : trigger.config.kind === "interval"
            ? `Scheduled fire (every ${trigger.config.intervalMinutes} min)`
            : `Scheduled fire (${trigger.config.kind})`,
    });
    rebuildSchedules();
  }

  // ---------------------------------------------------------------------------
  // 常驻脚本托管（2026-11-21 常驻模型：script 型不再进 cron/interval 调度）
  // ---------------------------------------------------------------------------

  // ScriptSupervisor 托管常驻脚本进程生命周期（active 即拉起、崩溃退避重启、exit 0 →
  // completed 终态、连续 3 次崩溃熔断）。事件经聚合器投递（与 cron/webhook 同一条管线，
  // 触发器说明仍由 CLI runtime 读盘进系统提示词，batch 只承载事件内容）。
  const scriptSupervisor = new TriggerScriptSupervisor({
    log,
    onEvent: (sessionKey, event) => aggregator.enqueue(sessionKey, event),
    updateRuntimeState: async ({ workspacePath, triggerId, apply }) => {
      const target = workspaces.get(workspacePath);
      if (target === undefined) return;
      await mutateRegistry(target, (registry) => {
        const entry = registry.triggers.find((candidate) => candidate.id === triggerId);
        if (entry === undefined) return;
        apply(entry);
      });
    },
    audit: (workspacePath, triggerId, record) => appendAudit(workspacePath, triggerId, record),
    notifyCircuitBreak: (params) => {
      log(
        `circuit break: ${params.triggerId} after ${params.consecutiveFailures} consecutive crashes`,
      );
      options.notify?.notifyCircuitBreak(params);
    },
    ...(options.pythonRuntime !== undefined
      ? {
          resolvePythonRuntime: async (workspacePath: string) => {
            const port = options.pythonRuntime;
            if (port === undefined) return { ok: false as const, error: "python runtime port missing" };
            const venv = await port.ensureVenv(workspacePath);
            return venv.ok
              ? {
                  ok: true as const,
                  interpreterPath: venv.interpreterPath,
                  venvDir: venv.venvDir,
                }
              : { ok: false as const, error: venv.error };
          },
        }
      : {}),
  });

  /** 轮询快照：全部挂载工作区的注册表条目（script 型 reconcile 的输入）。伪删除条目
   * 不进快照——supervisor 对"条目消失"按停止处理，脚本随下一次 reconcile 退出。 */
  function scriptSnapshots(): ScriptWorkspaceSnapshot[] {
    const snapshots: ScriptWorkspaceSnapshot[] = [];
    for (const state of workspaces.values()) {
      if (state.registry === null) continue;
      snapshots.push({
        workspacePath: state.workspacePath,
        triggers: state.registry.triggers.filter((trigger) => trigger.deleted !== true),
        ...(webhookServer.baseUrl !== undefined ? { webhookBaseUrl: webhookServer.baseUrl } : {}),
      });
    }
    return snapshots;
  }

  // ---------------------------------------------------------------------------
  // 工作区轮询挂载（5s；注册表内容变化即重建调度）
  // ---------------------------------------------------------------------------

  /**
   * 把 webhook 服务的 loopback 基址持久化到工作区 `state/webhook.json`（2026-11-19
   * 验收补充）：端口由 host 进程动态分配，CLI 进程的 ManageTriggers 无法从内存得知，
   * agent 建触发器时拿不到可回调的完整 URL。工具侧读这份文件拼 URL；引擎重启换端口
   * 后下次挂载自动覆盖为新值。写失败只记日志（投递不受影响，URL 可后补查询）。
   */
  async function persistWebhookBaseUrl(workspacePath: string): Promise<void> {
    const baseUrl = webhookServer.baseUrl;
    if (baseUrl === undefined) return;
    try {
      const target = join(triggersRoot(workspacePath), "state", "webhook.json");
      await mkdir(dirname(target), { recursive: true });
      const payload = `${JSON.stringify({ version: 1, baseUrl, updatedAt: new Date().toISOString() }, null, 2)}\n`;
      const temp = `${target}.tmp.${process.pid}`;
      await writeFile(temp, payload, "utf8");
      await rename(temp, target);
    } catch (error) {
      log(
        `failed to persist webhook base url for ${workspacePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function ensureWorkspace(
    workspacePath: string,
    workspaceIdentity: string | undefined,
    projectId?: string,
  ): Promise<WorkspaceState> {
    const existing = workspaces.get(workspacePath);
    if (existing !== undefined) {
      // 修复（2026-11-23）：服务面方法（getSnapshot/setTriggerStatus 等）以无身份兜底挂载，
      // 若先于 pollTick 的带身份挂载获胜，工作区的 workspaceIdentity/projectId 将终生为
      // undefined——dispatch batch 缺项目归属，触发器会话脱项目（归组/权限继承/globalComposerMode
      // 解析全失效），isTaskBusy 也缺身份参数。这里对已存在工作区补写身份（pollTick 传来的
      // listWorkspaces 结果是权威值），幂等字段变化才写。
      if (workspaceIdentity !== undefined && existing.workspaceIdentity !== workspaceIdentity) {
        existing.workspaceIdentity = workspaceIdentity;
        log(`workspace identity refreshed for ${workspacePath}`);
      }
      if (projectId !== undefined && existing.projectId !== projectId) {
        existing.projectId = projectId;
        log(`workspace projectId refreshed for ${workspacePath}`);
      }
      return existing;
    }
    const raw = await readRawRegistry(workspacePath);
    const registry = parseRegistry(raw);
    const state: WorkspaceState = {
      workspacePath,
      workspaceIdentity,
      projectId,
      mountedAt: Date.now(),
      raw,
      registry,
      corrupt: raw.trim().length > 0 && registry === null,
      sessionBindings: await loadSessionBindings(workspacePath),
      writeChain: Promise.resolve(),
    };
    workspaces.set(workspacePath, state);
    await persistWebhookBaseUrl(workspacePath);
    // python 主运行时：挂载即后台 ensure 可用性（托管解释器缓存命中即复用；下载失败落
    // unavailable 状态文件——CLI 门控按它把创建引导到 node 备选）。fire-and-forget：
    // 挂载不等待分钟级下载；spawn/install 路径会按需再次 ensure（单飞合并）。
    if (options.pythonRuntime !== undefined) {
      void options.pythonRuntime.ensureInterpreter(workspacePath).then(
        (resolution) => {
          if (!resolution.ok) {
            log(`python runtime unavailable for ${workspacePath}: ${resolution.error}`);
          }
        },
        (error: unknown) => {
          log(
            `python runtime ensure failed for ${workspacePath}: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
    }
    log(
      `mounted workspace ${workspacePath} (${registry?.triggers.length ?? 0} triggers${
        state.corrupt ? ", CORRUPT registry" : ""
      })`,
    );
    return state;
  }

  let polling = false;
  async function pollTick(): Promise<void> {
    if (disposed || polling) return;
    polling = true;
    try {
      const current = await options.listWorkspaces();
      const wanted = new Set(current.map((workspace) => workspace.workspacePath));
      // Map 迭代中删除当前项是安全的（JS 规范保证），无需快照数组。
      for (const known of workspaces.keys()) {
        if (!wanted.has(known)) {
          workspaces.delete(known);
          log(`unmounted workspace ${known}`);
          rebuildNeeded = true;
        }
      }
      let changed = rebuildNeeded;
      for (const workspace of current) {
        const knownBefore = workspaces.has(workspace.workspacePath);
        const state = await ensureWorkspace(
          workspace.workspacePath,
          workspace.workspaceIdentity,
          workspace.projectId,
        );
        // 首次挂载（含挂载时解析失败）也必须重建调度，否则新项目的触发器永不 armed。
        if (!knownBefore) changed = true;
        const raw = await readRawRegistry(workspace.workspacePath);
        if (raw !== state.raw) {
          const registry = parseRegistry(raw);
          state.raw = raw;
          state.registry = registry;
          state.corrupt = raw.trim().length > 0 && registry === null;
          changed = true;
          log(
            `registry changed for ${workspace.workspacePath} (${registry?.triggers.length ?? 0} triggers${
              state.corrupt ? ", CORRUPT" : ""
            })`,
          );
        }
      }
      if (changed) {
        rebuildNeeded = false;
        rebuildSchedules();
      }
      // 常驻脚本 reconcile 每轮执行（幂等）：挂载即拉起、崩溃退避到点重启、
      // 停用/completed 即杀进程。注册表未变的轮次同样要跑（退避窗口到期）。
      await scriptSupervisor.reconcile(scriptSnapshots());
    } catch (error) {
      log(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      polling = false;
    }
  }

  // ---------------------------------------------------------------------------
  // 本地 webhook（loopback；路由 = 全部挂载工作区的 webhook 触发器）
  // ---------------------------------------------------------------------------

  const webhookServer = new LocalWebhookServer({
    resolveRoute(path, token) {
      if (token === undefined) return undefined;
      for (const state of workspaces.values()) {
        if (state.registry === null) continue;
        for (const trigger of state.registry.triggers) {
          if (
            trigger.status === "active" &&
            trigger.deleted !== true &&
            trigger.config.kind === "webhook" &&
            trigger.config.path === path &&
            trigger.config.token === token
          ) {
            return {
              workspacePath: state.workspacePath,
              triggerId: trigger.id,
            };
          }
        }
      }
      return undefined;
    },
    // python 脚本 emit 端点（2026-11-22 HTTP emit 协议）：转发给 supervisor（运行注册表
    // 解析 + 与 node IPC 共享的校验/投递路径）；无 token 信任面 = 仅运行中脚本可达。
    onScriptEmit: async (triggerId, event) => scriptSupervisor.handleEmitRequest(triggerId, event),
    onEvent(resolution, body) {
      void (async () => {
        if (disposed) return;
        const state = workspaces.get(resolution.workspacePath);
        const trigger = state?.registry?.triggers.find(
          (candidate) => candidate.id === resolution.triggerId,
        );
        if (state === undefined || trigger === undefined) return;
        const at = new Date().toISOString();
        await mutateRegistry(state, (registry) => {
          const entry = registry.triggers.find((candidate) => candidate.id === trigger.id);
          if (entry !== undefined) {
            entry.lastFireAt = at;
            entry.updatedAt = at;
          }
        });
        void appendAudit(state.workspacePath, trigger.id, { action: "fire", kind: "webhook" });
        aggregator.enqueue(sessionKeyForTrigger(trigger), {
          kind: "webhook",
          at,
          summary: `Webhook event received on ${trigger.config.kind === "webhook" ? trigger.config.path : trigger.id}`,
          data: body,
        });
      })().catch(() => undefined);
    },
    log,
  });

  // ---------------------------------------------------------------------------
  // 公开服务面
  // ---------------------------------------------------------------------------

  const service = {
    async getSnapshot(params: { workspacePath: string }): Promise<TriggerRuntimeView> {
      const state =
        workspaces.get(params.workspacePath) ??
        (await ensureWorkspace(params.workspacePath, undefined));
      if (state.registry === null && !state.corrupt) {
        // 尚未轮询到的项目：同步读一次。
        const raw = await readRawRegistry(params.workspacePath);
        state.raw = raw;
        state.registry = parseRegistry(raw);
        state.corrupt = raw.trim().length > 0 && state.registry === null;
      }
      return {
        // 伪删除（2026-11-21）条目不进 UI 投影：触发器文件夹不渲染、清空/启停无落点。
        triggers: (state.registry?.triggers ?? []).filter((trigger) => trigger.deleted !== true),
        // 组成员同步剔除伪删除 id（防御注册表被旧版本工具改出的悬挂成员）。
        groups: (state.registry?.groups ?? []).map((group) => {
          const liveIds = new Set(
            (state.registry?.triggers ?? [])
              .filter((trigger) => trigger.deleted !== true)
              .map((trigger) => trigger.id),
          );
          const memberTriggerIds = group.memberTriggerIds.filter((id) => liveIds.has(id));
          return memberTriggerIds.length === group.memberTriggerIds.length
            ? group
            : { ...group, memberTriggerIds };
        }),
        profiles: state.registry?.profiles ?? [],
        sessionBindings: { ...state.sessionBindings },
        ...(webhookServer.baseUrl !== undefined ? { webhookBaseUrl: webhookServer.baseUrl } : {}),
      };
    },

    async setTriggerStatus(params: {
      workspacePath: string;
      triggerId: string;
      status: "active" | "deactivated" | "error-paused";
    }): Promise<TriggerEntry> {
      const state =
        workspaces.get(params.workspacePath) ??
        (await ensureWorkspace(params.workspacePath, undefined));
      let result: TriggerEntry | undefined;
      await mutateRegistry(state, (registry) => {
        const entry = registry.triggers.find((candidate) => candidate.id === params.triggerId);
        if (entry === undefined) {
          throw new Error(`No trigger with id ${params.triggerId}`);
        }
        entry.status = params.status;
        // 重新启用即修复确认：清零连续异常计数（与 ManageTriggers set_status 同一状态机）。
        if (params.status === "active") entry.consecutiveFailures = 0;
        entry.updatedAt = new Date().toISOString();
        result = entry;
      });
      if (result === undefined) {
        throw new Error(
          state.corrupt
            ? "Trigger registry is corrupt; fix it before changing trigger status"
            : `Failed to update trigger ${params.triggerId}`,
        );
      }
      void appendAudit(params.workspacePath, params.triggerId, {
        action: "set_status",
        status: params.status,
        actor: "ui",
      });
      rebuildSchedules();
      return result;
    },

    async deleteTrigger(params: {
      workspacePath: string;
      triggerId: string;
    }): Promise<TriggerEntry> {
      const state =
        workspaces.get(params.workspacePath) ??
        (await ensureWorkspace(params.workspacePath, undefined));
      let result: TriggerEntry | undefined;
      await mutateRegistry(state, (registry) => {
        const entry = registry.triggers.find((candidate) => candidate.id === params.triggerId);
        if (entry === undefined) {
          throw new Error(`No trigger with id ${params.triggerId}`);
        }
        if (entry.deleted === true) {
          // 幂等：重复删除按首次结果收口。
          result = entry;
          return;
        }
        // 伪删除（2026-11-21 实测裁决，与会话/智能体一致）：条目保留、消费面全不可见。
        // 状态一并停用（未感知 deleted 的读者也不会再执行它）；组订阅解除保持
        // groupId ↔ memberTriggerIds 双向闭合。调度/常驻脚本随本方法触发的
        // rebuildSchedules 与下一次 pollTick reconcile 收敛。
        entry.deleted = true;
        entry.status = "deactivated";
        if (entry.groupId !== null) {
          const group = registry.groups.find((candidate) => candidate.id === entry.groupId);
          if (group !== undefined) {
            group.memberTriggerIds = group.memberTriggerIds.filter(
              (candidate) => candidate !== entry.id,
            );
            group.updatedAt = new Date().toISOString();
          }
          entry.groupId = null;
        }
        entry.updatedAt = new Date().toISOString();
        result = entry;
      });
      if (result === undefined) {
        throw new Error(
          state.corrupt
            ? "Trigger registry is corrupt; fix it before deleting triggers"
            : `Failed to delete trigger ${params.triggerId}`,
        );
      }
      void appendAudit(params.workspacePath, params.triggerId, {
        action: "delete",
        actor: "ui",
      });
      log(`trigger ${params.triggerId} soft-deleted (registry entry retained)`);
      rebuildSchedules();
      return result;
    },

    async resetTriggerSession(params: {
      workspacePath: string;
      sessionKey: string;
    }): Promise<{ reset: boolean; taskId?: string }> {
      const state =
        workspaces.get(params.workspacePath) ??
        (await ensureWorkspace(params.workspacePath, undefined));
      const taskId = state.sessionBindings[params.sessionKey];
      if (taskId === undefined) {
        // 无绑定 = 尚未触发过，幂等空转（UI 项也只在有绑定时出现，防御并发竞态）。
        return { reset: false };
      }
      const tasks = options.tasks;
      if (!tasks) {
        throw new Error("trigger task port is not wired in this host");
      }
      // 清空 = 会话保留、内容归零、身份按当前订阅者重置；绑定不动，下次 fire 在
      // 同一会话继续。订阅者取注册表当前值（直连 = ownerAgentId；组 = subscriberAgentId），
      // 注册表条目缺席（极端时序）按 master 收口。
      const parsed = parseTriggerSessionKey(params.sessionKey);
      const subscriberAgentId =
        parsed?.kind === "trigger"
          ? (state.registry?.triggers.find((candidate) => candidate.id === parsed.triggerId)
              ?.ownerAgentId ?? "master")
          : parsed?.kind === "group"
            ? (state.registry?.groups.find((candidate) => candidate.id === parsed.groupId)
                ?.subscriberAgentId ?? "master")
            : "master";
      await tasks.clearTask({
        taskId,
        workspacePath: state.workspacePath,
        ...(state.workspaceIdentity !== undefined
          ? { workspaceIdentity: state.workspaceIdentity }
          : {}),
        subscriberAgentId,
      });
      // 审计只记直连触发器（组 key 无单一触发器目录）；组清空留引擎日志即可。
      if (parsed?.kind === "trigger") {
        void appendAudit(params.workspacePath, parsed.triggerId, {
          action: "reset_session",
          actor: "ui",
          taskId,
          subscriberAgentId,
        });
      }
      log(
        `reset trigger session ${params.sessionKey} (cleared task ${taskId}, identity → ${subscriberAgentId})`,
      );
      return { reset: true, taskId };
    },

    async installPackages(params: {
      workspacePath: string;
      packages: string[];
    }): Promise<PythonPackageInstallResult> {
      const port = options.pythonRuntime;
      if (port === undefined) {
        throw new Error(
          "python runtime support is not wired in this host (install_packages requires the desktop engine)",
        );
      }
      const state =
        workspaces.get(params.workspacePath) ??
        (await ensureWorkspace(params.workspacePath, undefined));
      const result = await port.installPackages(params.workspacePath, params.packages);
      if (!result.ok) return result;
      // 生效时机（2026-11-22 裁决选项：装完即重启本项目活跃 python 脚本——简单直接，
      // 避免"装了包旧进程用不上"的困惑；脚本走优雅停止，reconcile 下轮自动重拉）。
      const restartedTriggerIds = (state.registry?.triggers ?? [])
        .filter(
          (trigger) =>
            trigger.deleted !== true &&
            trigger.status === "active" &&
            trigger.config.kind === "script" &&
            trigger.config.runtime === "python",
        )
        .map((trigger) => trigger.id);
      for (const triggerId of restartedTriggerIds) {
        scriptSupervisor.requestRestartFor(params.workspacePath, triggerId);
      }
      log(
        `install_packages ok for ${params.workspacePath}: ${params.packages.join(", ")}` +
          (restartedTriggerIds.length > 0
            ? ` (restarting ${restartedTriggerIds.join(", ")})`
            : ""),
      );
      return restartedTriggerIds.length > 0 ? { ...result, restartedTriggerIds } : result;
    },
  } as ITriggerEngineService;

  // 启动：webhook server + 轮询循环。start 不 await（不阻塞服务注册），但端口绑定
  // 完成后要对已挂载工作区补写 webhook.json——首次 pollTick 可能先于 listen 回调，
  // ensureWorkspace 里的写入会因 baseUrl 未就绪而跳过（竞态补写）。
  void webhookServer
    .start()
    .then(async () => {
      for (const state of workspaces.values()) {
        await persistWebhookBaseUrl(state.workspacePath);
      }
    })
    .catch((error) => {
      log(
        `webhook server failed to start: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  const pollTimer = setInterval(() => void pollTick(), pollIntervalMs);
  pollTimer.unref?.();
  void pollTick();

  return {
    ...service,
    async dispose(): Promise<void> {
      disposed = true;
      clearInterval(pollTimer);
      clearSchedules();
      aggregator.dispose();
      await scriptSupervisor.dispose();
      await webhookServer.stop();
    },
  } as ITriggerEngineService & TriggerEngineHandle;
}
