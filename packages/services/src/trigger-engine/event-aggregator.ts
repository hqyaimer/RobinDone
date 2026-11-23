import { parseTriggerSessionKey } from "@robinrun/shared";
import type { TriggerEntry } from "@robinrun/shared";
import type { TriggerEvent, TriggerEventBatch } from "./contract.js";

/**
 * 事件聚合器（会话 key 维度：忙时排队、去抖合并投递——裁决 7 路由规则）。
 *
 * 从 engine.ts 抽出（2026-11-21，文件行数上限拆分）：对引擎状态的全部访问经 deps
 * 回调（resolveDeliveryTarget / persistBindings），聚合/去抖/合并逻辑自足可测。
 */

/** 单批投递上限，超出部分补一条合并说明（多事件合并不丢）。 */
const MAX_EVENTS_PER_BATCH = 50;

/**
 * 单批投递失败重试上限（2026-11-23，用户裁决 B4）：此前事件先清桶后投递、失败只记
 * 日志——Host 忙/服务未就绪等瞬时故障即永久丢事件，无感知。修复：失败把本批事件放回
 * 桶头（保序）短间隔重试；连续 MAX_DISPATCH_FAILURES 次仍失败才放弃（宿主持续不可用
 * 时避免无限重试刷日志），放弃时大声记日志。
 */
const MAX_DISPATCH_FAILURES = 3;

/** flush 时交付目标的投影（引擎 resolveDeliveryTarget 提供；触发器缺失等情形返回 undefined = 丢弃）。 */
export interface TriggerDeliveryTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  projectId?: string;
  /** 引擎工作区的绑定表（flush 写回 taskId 后经 persistBindings 落盘）。 */
  sessionBindings: Record<string, string>;
  /** 本批溯源触发器（直连 key = 触发器本身；组 key = 组内任一 active 成员）。 */
  trigger: TriggerEntry;
}

export interface TriggerEventAggregatorDeps {
  debounceMs: number;
  log(message: string): void;
  resolveDeliveryTarget(sessionKey: string): TriggerDeliveryTarget | undefined;
  dispatch(batch: TriggerEventBatch): Promise<{ taskId: string }>;
  persistBindings(target: TriggerDeliveryTarget): Promise<void>;
  /**
   * 绑定会话是否正在运行输入轮次（忙）。裁决 7 的"存在且忙：入 per-session 队列，
   * 当前轮结束后合并为一条输入投递"由此落地：忙时事件留在聚合桶内继续累积（桶本身
   * 就是 per-session 队列），短间隔重试；空闲后一次性合并投递。缺席 = 无忙感知
   * （远端/旧 wire），退化为逐批投递的旧行为。查询失败按空闲处理（fail-open，
   * 不比无忙感知的旧行为差）。
   */
  isTaskBusy?(task: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<boolean> | boolean;
}

export class TriggerEventAggregator {
  private readonly pending = new Map<
    string,
    {
      events: TriggerEvent[];
      timer: NodeJS.Timeout | undefined;
      flushing: boolean;
      holdLogged: boolean;
      deliveryFailures: number;
    }
  >();

  constructor(private readonly deps: TriggerEventAggregatorDeps) {}

  enqueue(key: string, event: TriggerEvent): void {
    let bucket = this.pending.get(key);
    if (bucket === undefined) {
      bucket = {
        events: [],
        timer: undefined,
        flushing: false,
        holdLogged: false,
        deliveryFailures: 0,
      };
      this.pending.set(key, bucket);
    }
    bucket.events.push(event);
    if (bucket.timer === undefined && !bucket.flushing) {
      bucket.timer = setTimeout(() => void this.flush(key), this.deps.debounceMs);
    }
  }

  private async flush(key: string): Promise<void> {
    const bucket = this.pending.get(key);
    if (bucket === undefined) return;
    if (bucket.flushing) return; // 正在投递/hold 中；新事件由 enqueue 的下一轮定时器兜住
    if (bucket.events.length === 0) {
      if (bucket.timer !== undefined) clearTimeout(bucket.timer);
      this.pending.delete(key);
      return;
    }
    bucket.flushing = true;
    if (bucket.timer !== undefined) {
      clearTimeout(bucket.timer);
      bucket.timer = undefined;
    }
    // 本轮待投批次（catch 的失败回桶重试需要引用；undefined = 尚未构造出来即失败）。
    let batch: TriggerEventBatch | undefined;
    try {
      const target = this.deps.resolveDeliveryTarget(key);
      if (target === undefined) {
        this.deps.log(`drop events for ${key}: workspace/trigger unavailable`);
        bucket.events = []; // 与旧语义一致：解析不到投递目标的事件整批丢弃
        return;
      }
      // 忙感知（2026-11-22 实测修复）：绑定会话正在跑轮次时，此前每 3s 就 flush 一批，
      // 忙会话把每批各自排队 → 一事件一轮 LLM（贵且慢）。正确语义是事件留在桶内累积，
      // 空闲后合并为一条投递；hold 期间的日志只报一次（每 3s 刷屏无意义）。
      const boundTaskId = target.sessionBindings[key];
      if (boundTaskId !== undefined && this.deps.isTaskBusy !== undefined) {
        let busy: boolean;
        try {
          busy = await this.deps.isTaskBusy({
            taskId: boundTaskId,
            workspacePath: target.workspacePath,
            ...(target.workspaceIdentity !== undefined
              ? { workspaceIdentity: target.workspaceIdentity }
              : {}),
          });
        } catch (error) {
          this.deps.log(
            `busy check failed for ${boundTaskId}, dispatching anyway: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          busy = false;
        }
        if (busy) {
          if (!bucket.holdLogged) {
            this.deps.log(
              `hold ${key}: bound session ${boundTaskId} busy, coalescing ${bucket.events.length} event(s)`,
            );
            bucket.holdLogged = true;
          }
          return;
        }
        bucket.holdLogged = false;
      }
      this.deps.log(`flush ${key}: delivering ${bucket.events.length} event(s)`);
      const events = bucket.events.slice(0, MAX_EVENTS_PER_BATCH);
      const dropped = bucket.events.length - events.length;
      bucket.events = [];
      batch = {
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity !== undefined
          ? { workspaceIdentity: target.workspaceIdentity }
          : {}),
        ...(target.projectId !== undefined ? { projectId: target.projectId } : {}),
        sessionKey: key,
        triggerId: target.trigger.id,
        triggerName: target.trigger.name,
        subscriberAgentId: target.trigger.ownerAgentId,
        ...(boundTaskId !== undefined ? { existingTaskId: boundTaskId } : {}),
        events: [
          ...events,
          ...(dropped > 0
            ? [
                {
                  kind: "schedule" as const,
                  at: new Date().toISOString(),
                  summary: `…and ${dropped} more events coalesced (batch size cap)`,
                },
              ]
            : []),
        ],
      };
      const { taskId } = await this.deps.dispatch(batch);
      bucket.deliveryFailures = 0;
      this.deps.log(`flush ${key}: dispatched to ${taskId}`);
      if (target.sessionBindings[key] !== taskId) {
        target.sessionBindings[key] = taskId;
        await this.deps.persistBindings(target);
      }
    } catch (error) {
      // 修复（2026-11-23，用户裁决 B4）：dispatch 失败不再静默丢批——把本批事件放回
      // 桶头（保序；投递期间新到的事件仍在桶尾），由 finally 的残留重试定时器短间隔
      // 重试。连续 MAX_DISPATCH_FAILURES 次失败才放弃（宿主持续不可用时止损），放弃
      // 记大声日志。忙时 hold 的"事件留桶"与失败重试自此语义一致：桶即 per-session 队列。
      const bucket = this.pending.get(key);
      if (bucket !== undefined && batch !== undefined) {
        bucket.deliveryFailures += 1;
        if (bucket.deliveryFailures >= MAX_DISPATCH_FAILURES) {
          this.deps.log(
            `DROP ${batch.events.length} event(s) for ${key}: dispatch failed ${bucket.deliveryFailures} times consecutively — ${error instanceof Error ? error.message : String(error)}`,
          );
          bucket.events = [];
          bucket.deliveryFailures = 0;
        } else {
          bucket.events = [...batch.events, ...bucket.events];
          this.deps.log(
            `dispatch failed for ${key} (attempt ${bucket.deliveryFailures}/${MAX_DISPATCH_FAILURES}), retrying: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else {
        this.deps.log(
          `dispatch failed for ${key}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      bucket.flushing = false;
      if (this.pending.get(key) === bucket) {
        if (bucket.events.length > 0) {
          // 事件残留（忙时 hold 或投递期间新到）：短间隔重试，空闲后的下一轮合并投递。
          bucket.timer = setTimeout(() => void this.flush(key), this.deps.debounceMs);
        } else if (bucket.timer === undefined) {
          this.pending.delete(key);
        }
      }
    }
  }

  dispose(): void {
    for (const bucket of this.pending.values()) {
      if (bucket.timer !== undefined) clearTimeout(bucket.timer);
    }
    this.pending.clear();
  }
}

/** 组 key 溯源：任取组内一个 active 成员触发器（投递消息里组批仍需单一触发器身份）。
 * 伪删除（2026-11-21）条目不参与溯源：直连 key 解析不到、组成员成员过滤，事件整批丢弃。 */
export function resolveBatchTriggerFromRegistry(
  registry: TriggerRegistryLike,
  key: string,
): TriggerEntry | undefined {
  const parsed = parseTriggerSessionKey(key);
  if (parsed === null) return undefined;
  if (parsed.kind === "trigger") {
    // 修复（2026-11-23，用户裁决 B10）：直连分支此前只滤伪删除不查 active——去抖/忙时
    // hold 期间触发器被停用，空闲 flush 照常投递（组分支本就查 active，两分支口径不一）。
    // 对齐组分支：停用的触发器事件整批丢弃（用户已明确喊停，投递会越过用户的决定）。
    return registry.triggers.find(
      (trigger) =>
        trigger.id === parsed.triggerId &&
        trigger.status === "active" &&
        trigger.deleted !== true,
    );
  }
  const group = registry.groups.find((candidate) => candidate.id === parsed.groupId);
  const memberId = group?.memberTriggerIds.find((id) =>
    registry.triggers.some(
      (trigger) => trigger.id === id && trigger.status === "active" && trigger.deleted !== true,
    ),
  );
  return registry.triggers.find((trigger) => trigger.id === memberId && trigger.deleted !== true);
}

interface TriggerRegistryLike {
  triggers: TriggerEntry[];
  groups: Array<{ id: string; memberTriggerIds: string[] }>;
}
