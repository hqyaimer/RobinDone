import { join } from "node:path";
import {
  parseTriggerSessionKey,
  resolveRoutingForSessionKey,
  sessionKeyForTrigger,
  type TriggerEntry,
} from "@robindone/shared";
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
import type { TriggerBrowserHost } from "./browser-host.js";
import { openTriggerLoginForEngine } from "./trigger-login.js";
import { createEngineRouteMarkQueue, routeEventsForEngine } from "./route-marks.js";
import {
  deleteTriggerForEngine,
  resetTriggerSessionForEngine,
  setTriggerStatusForEngine,
} from "./trigger-lifecycle.js";
import { computeNextFireMs, MAX_TIMER_MS, type ScheduleHandle } from "./trigger-scheduling.js";
import { ensureSystemSubscriptionEntry } from "./system-subscription.js";
import { dispatchSystemSubscriptionWakeup } from "./system-wakeup.js";
import { LocalWebhookServer, persistWebhookBaseUrlFile } from "./local-webhook-server.js";
import { TriggerScriptSupervisor, type ScriptWorkspaceSnapshot } from "./script-supervisor.js";

/**
 * 触发器引擎主体（2026-11-19 设计定稿，docs/trigger-system.md；2026-11-21 常驻脚本修订）。
 *
 * 职责：轮询各项目 `.robindone/triggers/triggers.json`（5s，避免 fs.watch 的 inode 换名
 * 问题——workers.json 的原子写换 inode 会永久关闭旧 watcher，轮询没有这类生命周期 bug），
 * 调度 cron/interval 到点 fire；script 型 = 常驻事件源进程（ScriptSupervisor 托管生命
 * 周期，随轮询 reconcile）；事件按会话 key 聚合去抖后经 dispatch 端口投递（忙时合并，
 * 见 TriggerEventAggregator）；脚本崩溃达阈值熔断（error-paused + 通知端口）；本地
 * webhook 路由解析。
 *
 * 引擎对注册表只写运行时字段（lastFireAt/lastResult/consecutiveFailures/status 熔断与
 * completed），每次写都重新读盘-改-原子写（与 ManageTriggers 的并发窗口最小化，
 * v1 接受 last-writer-wins）。
 * 2026-11-25 分发器裁决（specs/trigger-dispatcher-routing.md）：聚合器按 key 有效路由
 * 策略分流（direct/fixed/dispatcher）；dispatcher 档的事件池与 RouteEvents 标记兑现由
 * route-marks.ts 的 RouteMarkQueue 承接。
 */

const POLL_INTERVAL_MS = 5_000;
const DEBOUNCE_MS = 3_000;

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
  /**
   * 引擎托管浏览器（2026-11-25，specs/trigger-browser-hosting.md）：实例托管端口
   * （browser-host.ts）。缺席 = 旧行为（脚本自管 playwright）；在场时声明 profile 的
   * 脚本触发器经 CDP endpoint 接入引擎持有的实例，`open_login` 登录会话同端口。
   */
  browserHost?: TriggerBrowserHost;
  /**
   * 常驻脚本并发配额解析（2026-11-25 可配置化；host 装配：读 AppSettings
   * triggerScriptResidentPerWorkspace / triggerScriptResidentGlobalMax）。每轮 reconcile
   * 起点调用一次，设置改动 ≤5s 生效；缺席时 supervisor 用内置缺省（20/60）。
   */
  resolveScriptQuotas?(): Promise<{ perWorkspace: number; globalMax: number }>;
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

export interface TriggerEngineHandle {
  dispose(): Promise<void>;
}

function triggersRoot(workspacePath: string): string {
  return join(workspacePath, ".robindone", "triggers");
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
  // 分发器路由标记队列（2026-11-25 分发器裁决，specs/trigger-dispatcher-routing.md §6）：
  // dispatcher 档的事件池 + RouteEvents 标记兑现（分发器空闲后按 target 拆批投递）。
  // 实例化与 routeEvents 服务面逻辑在 route-marks.ts（文件行数上限拆分，system-wakeup
  // 同模式）；auditRoute 沿 reset_session 先例（直连记 JSONL、组记引擎日志）在其内部。
  // ---------------------------------------------------------------------------

  const routeMarkQueue = createEngineRouteMarkQueue({
    log,
    resolveWorkspace: (sessionKey) => resolveWorkspaceForSessionKey(sessionKey),
    resolveWorkspaceByPath: async (workspacePath) =>
      workspaces.get(workspacePath) ?? (await ensureWorkspace(workspacePath, undefined)),
    ...(options.isTaskBusy !== undefined ? { isTaskBusy: options.isTaskBusy } : {}),
    dispatch: options.dispatch,
    appendAudit: (workspacePath, triggerId, record) =>
      void appendAudit(workspacePath, triggerId, record),
  });

  // ---------------------------------------------------------------------------
  // 事件聚合（会话 key 维度：忙时排队、去抖合并投递——裁决 7 路由规则）。
  // 聚合器抽到 event-aggregator.ts（文件行数上限拆分）；对引擎状态的访问经回调。
  // ---------------------------------------------------------------------------

  // 生命周期服务面（启停/伪删除/清空会话）的引擎闭包投影（trigger-lifecycle.ts 消费）。
  const lifecycleDeps = {
    log,
    resolveState: async (workspacePath: string) =>
      workspaces.get(workspacePath) ?? (await ensureWorkspace(workspacePath, undefined)),
    rebuildSchedules: () => rebuildSchedules(),
    ...(options.tasks !== undefined ? { tasks: options.tasks } : {}),
  };

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
        // 有效路由策略（2026-11-25 分发器裁决）：直连取条目 routing、组取组条目 routing。
        routing: resolveRoutingForSessionKey(state.registry, key),
      };
    },
    dispatch: (batch) => options.dispatch.dispatchTriggerEvent(batch),
    ...(options.isTaskBusy !== undefined ? { isTaskBusy: options.isTaskBusy } : {}),
    persistBindings: async (target) => {
      const state = workspaces.get(target.workspacePath);
      if (state !== undefined) await saveSessionBindings(state);
    },
    // dispatcher 档批次投递成功 → 事件暂存分发器池（RouteEvents 标记按 evt id 引用）。
    onDispatcherBatchDelivered: (delivery) => {
      routeMarkQueue.stashBatch({
        workspacePath: delivery.workspacePath,
        ...(delivery.workspaceIdentity !== undefined
          ? { workspaceIdentity: delivery.workspaceIdentity }
          : {}),
        ...(delivery.projectId !== undefined ? { projectId: delivery.projectId } : {}),
        sessionKey: delivery.sessionKey,
        triggerId: delivery.trigger.id,
        triggerName: delivery.trigger.name,
        subscriberAgentId: delivery.trigger.ownerAgentId,
        dispatcherTaskId: delivery.taskId,
        events: delivery.events,
      });
    },
    // 上一轮路由结果摘要（taskId 回显闭环）：随下一批分发正文附录进分发器上下文。
    routeOutcomeSummary: (sessionKey) => routeMarkQueue.takeRouteOutcomeSummary(sessionKey),
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
  // 调度：cron/interval 到点 fire（到点计算在 trigger-scheduling.ts 纯函数）
  // ---------------------------------------------------------------------------

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

    const firedAt = new Date().toISOString();
    await mutateRegistry(state, (registry) => {
      const entry = registry.triggers.find((candidate) => candidate.id === triggerId);
      if (entry !== undefined) {
        entry.lastFireAt = firedAt;
        entry.updatedAt = firedAt;
      }
    });
    void appendAudit(workspacePath, triggerId, { action: "fire", kind: trigger.config.kind });

    // script+scheduled（2026-11-25 定时执行模式裁决）：到点 spawn 一趟（采集 → emit →
    // exit 0），不投递 schedule 事件——脚本运行本身就是这次"触发"的执行体，其 emit 走
    // 常规 script-result/script-error 管线进订阅者会话。
    if (trigger.config.kind === "script") {
      void scriptSupervisor
        .spawnScheduledRun(
          {
            workspacePath,
            triggers: [trigger],
            ...(webhookServer.baseUrl !== undefined
              ? { webhookBaseUrl: webhookServer.baseUrl }
              : {}),
          },
          trigger,
        )
        .catch((error: unknown) =>
          log(
            `scheduled run spawn failed for ${triggerId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      rebuildSchedules();
      return;
    }

    // cron/interval：直接投递调度事件（resident script 型走 ScriptSupervisor reconcile，
    // 不进本路径）。
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
            if (port === undefined)
              return { ok: false as const, error: "python runtime port missing" };
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
    ...(options.resolveScriptQuotas !== undefined
      ? { resolveScriptQuotas: () => options.resolveScriptQuotas!() }
      : {}),
    ...(options.browserHost !== undefined
      ? {
          acquireBrowser: async (workspacePath: string, profile: string, headed: boolean) => {
            const acquisition = await options.browserHost!.acquire(workspacePath, profile, headed);
            return acquisition.ok
              ? { ok: true as const, cdpEndpoint: acquisition.handle.cdpEndpoint }
              : { ok: false as const, error: acquisition.error };
          },
          releaseBrowser: (workspacePath: string, profile: string) =>
            options.browserHost!.release(workspacePath, profile),
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

  /** webhook 基址落盘（2026-11-19 验收补充；实现挪 local-webhook-server.ts，行数上限）。 */
  async function persistWebhookBaseUrl(workspacePath: string): Promise<void> {
    await persistWebhookBaseUrlFile(triggersRoot(workspacePath), webhookServer.baseUrl, log);
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
    // 脚本暂停上报（2026-11-25 登录闭环）：同款信任面，转发 supervisor 的 login-failed
    // 收口（error-paused + 唤醒订阅者 + 停脚本）。
    onScriptPause: async (triggerId, reason) =>
      scriptSupervisor.handlePauseRequest(triggerId, reason),
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
      // 逻辑在 trigger-lifecycle.ts（文件行数上限拆分；system-wakeup 同模式）。
      return setTriggerStatusForEngine(lifecycleDeps, params);
    },

    async deleteTrigger(params: {
      workspacePath: string;
      triggerId: string;
    }): Promise<TriggerEntry> {
      return deleteTriggerForEngine(lifecycleDeps, params);
    },

    async resetTriggerSession(params: {
      workspacePath: string;
      sessionKey: string;
    }): Promise<{ reset: boolean; taskId?: string }> {
      return resetTriggerSessionForEngine(lifecycleDeps, params);
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
          (restartedTriggerIds.length > 0 ? ` (restarting ${restartedTriggerIds.join(", ")})` : ""),
      );
      return restartedTriggerIds.length > 0 ? { ...result, restartedTriggerIds } : result;
    },

    async openTriggerLogin(params: {
      workspacePath: string;
      triggerId: string;
      /** 登录会话落点（http/https URL）；透传给有头窗口作为启动导航页。 */
      url?: string;
    }): Promise<{ ok: boolean; profile?: string; error?: string; guidance?: string[] }> {
      // 实现在 trigger-login.ts（文件行数上限拆分，P3 第二十三批）：条目形状校验 + 浏览器
      // 端口委托 + open-login 审计；语义见 specs/trigger-browser-hosting.md §3.4。
      return openTriggerLoginForEngine(
        {
          resolveState: async (workspacePath) =>
            workspaces.get(workspacePath) ?? (await ensureWorkspace(workspacePath, undefined)),
          ...(options.browserHost !== undefined ? { browserHost: options.browserHost } : {}),
          log,
        },
        params,
      );
    },
    async ensureSystemSubscription(params: {
      workspacePath: string;
      subscription: {
        id: string;
        name: string;
        events: string[];
        /** 每事件唤醒豁免规则（2026-11-24 通用机制；随配置播种，幂等比对含本字段）。 */
        wakeRules?: Record<string, { exemptRecordedBy: string[] }>;
        readme: string;
      };
    }): Promise<TriggerEntry> {
      // 实现在 system-subscription.ts（文件行数上限拆分）：幂等播种 + 不可停用/删除的
      // 平台保证语义见其头注（保护本体在 setTriggerStatus/deleteTrigger 与 ManageTriggers）。
      return ensureSystemSubscriptionEntry(
        {
          resolveState: async (workspacePath) =>
            workspaces.get(workspacePath) ?? (await ensureWorkspace(workspacePath, undefined)),
          log,
        },
        params,
      );
    },

    async dispatchSystemSubscriptionWakeup(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      triggerId: string;
      prompt: string;
    }): Promise<{ taskId: string }> {
      // 实现在 system-wakeup.ts（文件行数上限拆分）：标准触发器会话模型（绑定解析/
      // 写回/sessions.json 持久化同聚合器投递链），不经聚合器；语义见其头注。
      return dispatchSystemSubscriptionWakeup(
        {
          resolveState: async (workspacePath, workspaceIdentity) =>
            workspaces.get(workspacePath) ??
            (await ensureWorkspace(workspacePath, workspaceIdentity)),
          dispatch: options.dispatch,
          log,
        },
        params,
      );
    },

    async routeEvents(params: {
      workspacePath: string;
      sessionId: string;
      routes: Array<{
        eventIds: string[];
        target: { kind: "new" } | { kind: "existing"; taskId: string };
      }>;
    }): Promise<{ ok: boolean; acceptedEventIds: string[]; unknownEventIds: string[] }> {
      // 逻辑在 route-marks.ts 的 routeEventsForEngine（key 反查 + routing 门控 + 登记）。
      const state =
        workspaces.get(params.workspacePath) ??
        (await ensureWorkspace(params.workspacePath, undefined));
      return routeEventsForEngine(routeMarkQueue, state, {
        sessionId: params.sessionId,
        routes: params.routes,
      });
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
      routeMarkQueue.dispose();
      await scriptSupervisor.dispose();
      // 托管浏览器实例收尾（2026-11-25）：全部 chromium 进程树终止 + storageState 回写，
      // 无孤儿进程（specs/trigger-browser-hosting.md 验收场景 7）。
      await options.browserHost?.dispose().catch(() => undefined);
      await webhookServer.stop();
    },
  } as ITriggerEngineService & TriggerEngineHandle;
}
