import {
  parseTriggerSessionKey,
  resolveRoutingForSessionKey,
  type TriggerRegistry,
} from "@robinrun/shared";
import type { TriggerDispatchPort, TriggerEvent, RoutedEventBatch } from "./contract.js";

/**
 * 分发器路由标记队列（2026-11-25 分发器裁决，specs/trigger-dispatcher-routing.md §6）。
 *
 * dispatcher 档下事件先投进分发器会话做话题聚类，模型以 RouteEvents 按事件 id 标记
 * 路由（引用式标记：事件原文不经分发器的手转述）。本队列承载裁决的两条机制契约：
 *
 * 1. **分发器事件池**：dispatcher 档批次投递成功后，本批事件按会话 key 暂存（引擎的
 *    onDispatcherBatchDelivered 钩子转入）；RouteEvents 标记按 evt id 从池取事件原文。
 * 2. **标记兑现**：标记登记后不即时投递——等分发器会话空闲（轮次结束）统一兑现，
 *    按 target 拆批（new 合并一批、每个续用会话各一批）经 dispatchRoutedEvent 投递。
 *    漏标事件的保守降级（开新会话直投 + route.fallback 审计）同样挂在兑现检查：
 *    仅当分发器空闲且池龄超过 grace（轮次确已结束而模型未标记）才降级，避免把
 *    "模型还没来得及标记"误判为"漏标"。
 *
 * 降级（target 会话不存在/越权 → host 侧降级新建并回 degraded）不是错误而是"话题
 * 静默淘汰"语义的运行时另一半（压缩事前淘汰、降级事后兜残址）；引擎只负责把
 * degraded 如实记入审计（route.degraded）。投递失败重试与止损沿用聚合器 B4 裁决
 * 模式（留桶保序短间隔重试，连续 3 次放弃并大声记日志）。
 */

/** 标记登记后的兑现去抖（等模型在同一轮次内的后续标记调用，合并兑现）。 */
const MARK_FLUSH_DEBOUNCE_MS = 2_000;
/** 分发器会话忙时的兑现重试间隔（轮次结束后下一次 tick 兑现）。 */
const BUSY_RETRY_MS = 1_000;
/** 漏标降级的池龄门槛：分发器空闲 + 池龄超此值才按漏标降级（轮次通常秒级~几十秒）。 */
const UNMARKED_GRACE_MS = 60_000;
/** 单批投递失败重试上限（同聚合器 MAX_DISPATCH_FAILURES 的止损语义）。 */
const MAX_DISPATCH_FAILURES = 3;
/** 单 key 事件池上限（防御分发器长期不标记的堆积），超限丢最老事件并大声记日志。 */
const MAX_POOL_EVENTS = 500;

/** 分发器事件池条目（per 会话 key；同 key 批次 merge——分发器忙时聚合器 hold，实际同时只有一批在池）。 */
export interface DispatcherEventPool {
  workspacePath: string;
  workspaceIdentity?: string;
  projectId?: string;
  sessionKey: string;
  triggerId: string;
  triggerName: string;
  subscriberAgentId: string;
  /** 分发器会话 taskId（处理会话 <system-status>.viaDispatcherSessionId 溯源用）。 */
  dispatcherTaskId: string;
  /** evt id → 事件原文。 */
  events: Map<string, TriggerEvent>;
  /** 最近一批入池时刻（漏标降级的池龄基准）。 */
  receivedAt: number;
}

/** 已通过池校验的路由标记（登记即承诺兑现；unknown 事件不进队列，直接返回给模型）。 */
interface PendingRouteMark {
  eventIds: string[];
  target: { kind: "new" } | { kind: "existing"; taskId: string };
}

export interface RouteMarkQueueDeps {
  log(message: string): void;
  /** 会话 key 的分发器会话是否正在跑轮次（引擎经 sessionBindings + isTaskBusy 解析；无绑定 = 不忙）。 */
  isDispatcherBusy(sessionKey: string): Promise<boolean> | boolean;
  /** 路由投递端口（host 装配；target=existing 的存在/归属校验与降级在 host 侧）。 */
  dispatchRoutedEvent(batch: RoutedEventBatch): Promise<{ taskId: string; degraded: boolean }>;
  /** 路由审计（引擎注入：直连 key 记触发器 JSONL，组 key 记引擎日志——同 reset_session 先例）。 */
  auditRoute(params: {
    workspacePath: string;
    sessionKey: string;
    triggerId: string;
    record: Record<string, unknown>;
  }): void;
}

export class RouteMarkQueue {
  private readonly pools = new Map<string, DispatcherEventPool>();
  private readonly marks = new Map<string, PendingRouteMark[]>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly flushing = new Set<string>();
  private readonly deliveryFailures = new Map<string, number>();
  /** 兑现结果行（per key，增量；聚合器构造下一批分发正文时经 takeRouteOutcomeSummary 取走）——taskId 回显给分发器的唯一通路。 */
  private readonly outcomeNotes = new Map<string, string[]>();

  constructor(private readonly deps: RouteMarkQueueDeps) {}

  // ---------------------------------------------------------------------------
  // 事件池（引擎 onDispatcherBatchDelivered 钩子转入）
  // ---------------------------------------------------------------------------

  /** dispatcher 档批次投递成功后暂存事件（幂等合并；池超限丢最老并大声记日志）。 */
  stashBatch(
    pool: Omit<DispatcherEventPool, "events" | "receivedAt"> & { events: TriggerEvent[] },
  ): void {
    let entry = this.pools.get(pool.sessionKey);
    if (entry === undefined) {
      entry = { ...pool, events: new Map(), receivedAt: Date.now() };
      this.pools.set(pool.sessionKey, entry);
    } else {
      // 同 key 后续批次（罕见——分发器忙时聚合器 hold）：merge 事件、刷新上下文与池龄。
      Object.assign(entry, { ...pool, receivedAt: Date.now() });
    }
    for (const event of pool.events) {
      if (event.id === undefined) continue; // 无 id 的事件不可被标记（正常不会发生：聚合器兜底生成）
      entry.events.set(event.id, event);
    }
    // 防御：分发器长期不标记时池会堆积；超限丢最老（Map 迭代序 = 插入序）。
    if (entry.events.size > MAX_POOL_EVENTS) {
      const excess = entry.events.size - MAX_POOL_EVENTS;
      let dropped = 0;
      for (const eventId of entry.events.keys()) {
        if (dropped >= excess) break;
        entry.events.delete(eventId);
        dropped += 1;
      }
      this.deps.log(
        `dispatcher event pool for ${pool.sessionKey} exceeded ${MAX_POOL_EVENTS} events; dropped ${dropped} oldest`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 标记登记（ITriggerEngineService.routeEvents 的实现落点）
  // ---------------------------------------------------------------------------

  /**
   * 登记路由标记：按事件池校验 evt id（在池 = accepted 并入队；不在池 = unknown，
   * 可能已按漏标降级直投或本就不是本分发器的批次事件）。登记后重置兑现去抖定时器。
   */
  enqueueMarks(
    sessionKey: string,
    routes: Array<{
      eventIds: string[];
      target: { kind: "new" } | { kind: "existing"; taskId: string };
    }>,
  ): { acceptedEventIds: string[]; unknownEventIds: string[] } {
    const pool = this.pools.get(sessionKey);
    const acceptedEventIds: string[] = [];
    const unknownEventIds: string[] = [];
    const pending: PendingRouteMark[] = [];
    for (const route of routes) {
      const known = route.eventIds.filter((id) => pool?.events.has(id) === true);
      for (const id of route.eventIds) {
        if (known.includes(id)) acceptedEventIds.push(id);
        else unknownEventIds.push(id);
      }
      if (known.length > 0) pending.push({ eventIds: known, target: route.target });
    }
    if (pending.length > 0) {
      const existing = this.marks.get(sessionKey) ?? [];
      this.marks.set(sessionKey, [...existing, ...pending]);
      this.scheduleFlush(sessionKey);
    }
    return { acceptedEventIds, unknownEventIds };
  }

  /** 分发器事件池当前快照（诊断/测试用）。 */
  poolSize(sessionKey: string): number {
    return this.pools.get(sessionKey)?.events.size ?? 0;
  }

  /**
   * 取走（增量清空）自上批以来的路由结果行，供聚合器构造下一批分发正文的附录
   * （taskId 回显闭环）。无新结果返回 undefined。
   */
  takeRouteOutcomeSummary(sessionKey: string): string | undefined {
    const notes = this.outcomeNotes.get(sessionKey);
    if (notes === undefined || notes.length === 0) return undefined;
    this.outcomeNotes.delete(sessionKey);
    return notes.join("; ");
  }

  // ---------------------------------------------------------------------------
  // 兑现
  // ---------------------------------------------------------------------------

  private scheduleFlush(sessionKey: string, delayMs = MARK_FLUSH_DEBOUNCE_MS): void {
    const existing = this.timers.get(sessionKey);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => void this.tryFlush(sessionKey), delayMs);
    timer.unref?.();
    this.timers.set(sessionKey, timer);
  }

  private async tryFlush(sessionKey: string): Promise<void> {
    this.timers.delete(sessionKey);
    if (this.flushing.has(sessionKey)) return;
    const pool = this.pools.get(sessionKey);
    const marks = this.marks.get(sessionKey) ?? [];
    if (pool === undefined || (marks.length === 0 && pool.events.size === 0)) {
      this.marks.delete(sessionKey);
      return;
    }
    this.flushing.add(sessionKey);
    try {
      // 兑现时机 = 分发器轮次结束（空闲）。忙 → 短间隔重试（事件与标记原位不动）。
      let busy: boolean;
      try {
        busy = await this.deps.isDispatcherBusy(sessionKey);
      } catch (error) {
        this.deps.log(
          `dispatcher busy check failed for ${sessionKey}, will retry: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        busy = true; // fail-closed：查不清就不兑现（兑现是优化，晚兑现不丢事件）
      }
      if (busy) {
        this.scheduleFlush(sessionKey, BUSY_RETRY_MS);
        return;
      }

      // 标记兑现（2026-11-25 实测修正 new 拆分语义）：**每个 `{kind:"new"}` 标记各自
      // 开一个新会话**——分发器对两个话题分别标记 new（首轮没有可续会话时的常态），
      // 表达的是"各开各的"；此前把全部 new 标记合并成一个新会话，违背分发器决策
      // （实测：快讯/巡检两个话题被并进同一处理会话）。分发器要把多个事件放进同一个
      // 新会话，应在一条标记里列全部 eventIds（标记粒度 = 会话粒度）。
      // 续用会话（existing）仍按 target 合并——同一轮次多段标记对同 target 自动合并，
      // 避免同话题被拆成多次唤醒（合并的是"去同一个已有会话"，无拆分歧义）。
      const newMarks = marks.filter((mark) => mark.target.kind === "new");
      const byTarget = new Map<string, string[]>();
      for (const mark of marks) {
        if (mark.target.kind === "existing") {
          const list = byTarget.get(mark.target.taskId) ?? [];
          list.push(...mark.eventIds);
          byTarget.set(mark.target.taskId, list);
        }
      }
      let failed = false;
      const deliveredNewEventIds: string[] = [];
      for (const mark of newMarks) {
        const ok = await this.deliver(sessionKey, pool, { kind: "new" }, mark.eventIds);
        if (ok) deliveredNewEventIds.push(...mark.eventIds);
        failed = !ok || failed;
      }
      for (const [taskId, eventIds] of byTarget) {
        failed =
          !(await this.deliver(sessionKey, pool, { kind: "existing", taskId }, eventIds)) || failed;
      }

      // 漏标降级（保守倾向的运行时收口）：分发器空闲 + 池龄超 grace 仍未被任何标记
      // 引用的事件 → 开新会话直投 + route.fallback 审计。未到 grace 的留池等下一轮。
      // 降级批按事件逐条拆会话（保守倾向：宁多开不混流，与漏标场景语义一致）。
      const markedIds = new Set([...deliveredNewEventIds, ...[...byTarget.values()].flat()]);
      const unmarked = [...pool.events.entries()].filter(([eventId]) => !markedIds.has(eventId));
      const dueUnmarked = Date.now() - pool.receivedAt > UNMARKED_GRACE_MS ? unmarked : [];
      if (dueUnmarked.length > 0) {
        // 逐事件拆投（每个事件各开新会话）：漏标 = 无分发器决策，保守倾向下宁可
        // 多开不可把可能异话题的事件合并混流。
        for (const [eventId] of dueUnmarked) {
          const delivered = await this.deliver(sessionKey, pool, { kind: "new" }, [eventId], {
            fallback: true,
          });
          failed = !delivered || failed;
        }
      }

      if (failed) {
        // 失败止损（同聚合器 B4）：标记保留、事件留池，短间隔重试；连续 3 次放弃
        // （清标记与池，大声记日志——宿主持续不可用时避免无限重试）。
        const failures = (this.deliveryFailures.get(sessionKey) ?? 0) + 1;
        this.deliveryFailures.set(sessionKey, failures);
        if (failures >= MAX_DISPATCH_FAILURES) {
          this.deps.log(
            `DROP routed events for ${sessionKey}: dispatch failed ${failures} times consecutively`,
          );
          this.marks.delete(sessionKey);
          this.pools.delete(sessionKey);
          this.deliveryFailures.delete(sessionKey);
        } else {
          this.scheduleFlush(sessionKey, BUSY_RETRY_MS);
        }
        return;
      }
      // 全部成功：清本轮已兑现标记与已投事件；池空则删条目（未到 grace 的漏标事件
      // 留池——下一批到达刷新池龄，或由后续 flush 到期降级）。
      this.deliveryFailures.delete(sessionKey);
      const remainingMarks = (this.marks.get(sessionKey) ?? []).filter((mark) =>
        mark.eventIds.some((eventId) => pool.events.has(eventId)),
      );
      if (remainingMarks.length > 0) this.marks.set(sessionKey, remainingMarks);
      else this.marks.delete(sessionKey);
      if (pool.events.size === 0) this.pools.delete(sessionKey);
    } finally {
      this.flushing.delete(sessionKey);
    }
  }

  /** 兑现一批：构造 RoutedEventBatch 投递；成功清除已投事件并记审计，返回是否成功。 */
  private async deliver(
    sessionKey: string,
    pool: DispatcherEventPool,
    target: { kind: "new" } | { kind: "existing"; taskId: string },
    eventIds: string[],
    options: { fallback?: boolean } = {},
  ): Promise<boolean> {
    const events = eventIds
      .map((eventId) => pool.events.get(eventId))
      .filter((event): event is TriggerEvent => event !== undefined);
    if (events.length === 0) return true;
    try {
      const { taskId: resolvedTaskId, degraded } = await this.deps.dispatchRoutedEvent({
        workspacePath: pool.workspacePath,
        ...(pool.workspaceIdentity !== undefined
          ? { workspaceIdentity: pool.workspaceIdentity }
          : {}),
        ...(pool.projectId !== undefined ? { projectId: pool.projectId } : {}),
        dispatcherSessionKey: sessionKey,
        triggerId: pool.triggerId,
        triggerName: pool.triggerName,
        subscriberAgentId: pool.subscriberAgentId,
        target,
        events,
        ...(target.kind === "new" && pool.dispatcherTaskId
          ? { dispatcherTaskId: pool.dispatcherTaskId }
          : {}),
      });
      for (const eventId of eventIds) pool.events.delete(eventId);
      // taskId 回显行（2026-11-25 实测补闭环）：分发器拿不到新建/续用会话的真实 id
      // 就无法构造 existing 续用标记（只能永远保守新建）。结果行经
      // takeRouteOutcomeSummary 附进下一批分发正文（增量、不新增轮次）。
      const outcomeLine =
        target.kind === "new"
          ? `${eventIds.join(", ")} → new session ${resolvedTaskId}${degraded ? " (degraded)" : ""}`
          : `${eventIds.join(", ")} → continued session ${resolvedTaskId}`;
      const notes = this.outcomeNotes.get(sessionKey) ?? [];
      notes.push(outcomeLine);
      this.outcomeNotes.set(sessionKey, notes);
      this.deps.auditRoute({
        workspacePath: pool.workspacePath,
        sessionKey,
        triggerId: pool.triggerId,
        record: {
          action: options.fallback ? "route_fallback" : "route_marked",
          actor: "dispatcher",
          target: target.kind === "new" ? "new" : target.taskId,
          degraded,
          eventIds,
          count: events.length,
        },
      });
      if (degraded) {
        // 降级（残址/越权 → 新建）不是错误：如实记审计供追溯（见类头注）。
        this.deps.auditRoute({
          workspacePath: pool.workspacePath,
          sessionKey,
          triggerId: pool.triggerId,
          record: {
            action: "route_degraded",
            actor: "engine",
            requestedTarget: target.kind === "existing" ? target.taskId : "new",
            resolvedTarget: "new",
            eventIds,
          },
        });
      }
      return true;
    } catch (error) {
      this.deps.log(
        `routed dispatch failed for ${sessionKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pools.clear();
    this.marks.clear();
    this.flushing.clear();
    this.deliveryFailures.clear();
  }
}

// ---------------------------------------------------------------------------
// 引擎接线（从 engine.ts 拆出，2026-11-25，文件行数上限）：RouteMarkQueue 实例化与
// routeEvents 服务面逻辑。对引擎状态的访问全部经回调（resolveSession 工作区投影），
// 与 system-subscription / system-wakeup 拆分同模式。
// ---------------------------------------------------------------------------

/** 引擎接线所需的工作区最小投影（engine.WorkspaceState 结构兼容）。 */
export interface RouteMarkWorkspaceView {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 注册表（key 反查与 routing 门控；null = 损坏/未挂载）。 */
  registry: Pick<TriggerRegistry, "triggers" | "groups"> | null;
  /** 会话 key → 绑定 taskId（分发器会话 = dispatcher 档 key 的绑定）。 */
  sessionBindings: Record<string, string>;
  corrupt: boolean;
}

export interface EngineRouteMarkQueueInput {
  log(message: string): void;
  /** 按会话 key 解析工作区投影（engine 闭包：workspaces.get 的注册表投影）。 */
  resolveWorkspace(sessionKey: string): RouteMarkWorkspaceView | undefined;
  /** 按工作区取（或创建）投影；routeEvents 服务面的 ensureWorkspace 缺席语义。 */
  resolveWorkspaceByPath(workspacePath: string): Promise<RouteMarkWorkspaceView>;
  isTaskBusy?(task: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<boolean> | boolean;
  dispatch: TriggerDispatchPort;
  /** 触发器 JSONL 审计追加（引擎 appendAudit；组 key 由本工厂降级为引擎日志）。 */
  appendAudit(workspacePath: string, triggerId: string, record: Record<string, unknown>): void;
  /** dispatcher 档批次投递成功后的池暂存（聚合器钩子的落点）。 */
}

export function createEngineRouteMarkQueue(input: EngineRouteMarkQueueInput): RouteMarkQueue {
  return new RouteMarkQueue({
    log: input.log,
    isDispatcherBusy: (sessionKey) => {
      const state = input.resolveWorkspace(sessionKey);
      const taskId = state?.sessionBindings[sessionKey];
      if (state === undefined || taskId === undefined || input.isTaskBusy === undefined) {
        return false;
      }
      return input.isTaskBusy({
        taskId,
        workspacePath: state.workspacePath,
        ...(state.workspaceIdentity !== undefined
          ? { workspaceIdentity: state.workspaceIdentity }
          : {}),
      });
    },
    dispatchRoutedEvent: (batch) => input.dispatch.dispatchRoutedEvent(batch),
    auditRoute: ({ workspacePath, sessionKey, triggerId, record }) => {
      // 审计归属沿 reset_session 先例：直连 key 记触发器 JSONL，组 key 无单一触发器
      // 目录，降级为引擎日志。
      const parsed = parseTriggerSessionKey(sessionKey);
      if (parsed?.kind === "trigger") {
        input.appendAudit(workspacePath, triggerId, record);
      } else {
        input.log(`route audit (${sessionKey}): ${JSON.stringify(record)}`);
      }
    },
  });
}

/**
 * routeEvents 服务面（ITriggerEngineService.routeEvents 的实现落点）：会话 key 反查
 * → routing 门控 → 标记登记。机制层路由边界的执行点（裁决 1）。
 */
export async function routeEventsForEngine(
  queue: RouteMarkQueue,
  state: RouteMarkWorkspaceView,
  params: {
    sessionId: string;
    routes: Array<{
      eventIds: string[];
      target: { kind: "new" } | { kind: "existing"; taskId: string };
    }>;
  },
): Promise<{ ok: boolean; acceptedEventIds: string[]; unknownEventIds: string[] }> {
  if (state.registry === null) {
    throw new Error(
      state.corrupt
        ? "Trigger registry is corrupt; cannot resolve dispatcher session"
        : "No trigger registry for this workspace",
    );
  }
  // 反查会话 key：RouteEvents 由分发器会话发起（sessionId = 分发器会话 id），绑定表
  // 是 key → taskId，反向索引定位。查不到 = 非绑定会话调用（越权或陈旧）。
  const sessionKey = Object.entries(state.sessionBindings).find(
    ([, taskId]) => taskId === params.sessionId,
  )?.[0];
  if (sessionKey === undefined) {
    throw new Error(
      "RouteEvents is only available in the dispatcher session of a dispatcher-routing trigger (this session is not a trigger-bound session)",
    );
  }
  // 机制层路由边界（2026-11-25 裁决 1）：非 dispatcher 档的绑定会话一律拒绝——与
  // "模型传入 owner 一律忽略"同一哲学，路由资格由会话身份与注册表配置决定。
  if (resolveRoutingForSessionKey(state.registry, sessionKey) !== "dispatcher") {
    throw new Error(
      "RouteEvents is only available to dispatcher-routing triggers; this trigger/group uses direct routing and handles events in its own session",
    );
  }
  const { acceptedEventIds, unknownEventIds } = queue.enqueueMarks(sessionKey, params.routes);
  return { ok: true, acceptedEventIds, unknownEventIds };
}
