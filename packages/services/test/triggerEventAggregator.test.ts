// 事件聚合器忙感知回归（2026-11-22 实测修复，裁决 7「存在且忙：入 per-session 队列，
// 当前轮结束后合并为一条输入投递」）：修复前聚合器只按 debounce 窗口无条件 flush，
// 绑定会话正在跑轮次时每批各自排队 → 一事件一轮 LLM（贵且慢）。本用例锁三个不变量：
// 忙时零投递只累积、空闲后恰好一次投递且一批承载全部累积事件、无绑定会话（新建路径）
// 不受忙感知影响。聚合器「对引擎状态的全部访问经 deps 回调、聚合/去抖/合并逻辑自足
// 可测」（event-aggregator.ts 头注），故在聚合器层单测——引擎级的伪定时器 + 真实 fs
// 集成用例在这台开发机上本身有抖动（triggerEngineScheduling 头注同款问题），不再叠加。
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TriggerEntry } from "@robindone/shared";

import {
  TriggerEventAggregator,
  type TriggerDeliveryTarget,
} from "../src/trigger-engine/event-aggregator.js";

const KEY = "trigger:trg-aaa11111";
const TASK_ID = "sess-busy";

const trigger = {
  id: "trg-aaa11111",
  name: "inbox-watch",
  ownerAgentId: "master",
  groupId: null,
  config: { kind: "script", runtime: "node", entry: "watch.js" },
  status: "active",
  consecutiveFailures: 0,
  createdAt: "2026-11-22T00:00:00.000Z",
  updatedAt: "2026-11-22T00:00:00.000Z",
} as unknown as TriggerEntry;

function event(summary: string) {
  return { kind: "script-result" as const, at: new Date().toISOString(), summary };
}

interface Harness {
  aggregator: TriggerEventAggregator;
  dispatch: ReturnType<typeof vi.fn>;
  logs: string[];
}

function createAggregator(params: {
  bindings: Record<string, string>;
  isTaskBusy?: (task: { taskId: string; workspacePath: string }) => Promise<boolean> | boolean;
}): Harness {
  const logs: string[] = [];
  const dispatch = vi.fn(async () => ({ taskId: TASK_ID }));
  const aggregator = new TriggerEventAggregator({
    debounceMs: 50,
    log: (message) => logs.push(message),
    resolveDeliveryTarget: (): TriggerDeliveryTarget => ({
      workspacePath: "/ws",
      sessionBindings: params.bindings,
      trigger,
    }),
    dispatch,
    persistBindings: async () => undefined,
    ...(params.isTaskBusy !== undefined ? { isTaskBusy: params.isTaskBusy } : {}),
  });
  return { aggregator, dispatch, logs };
}

describe("trigger event aggregator busy coalescing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds events while the bound session is busy; idle retry dispatches ONE merged batch", async () => {
    vi.useFakeTimers();
    let busy = true;
    const bindings: Record<string, string> = { [KEY]: TASK_ID };
    const harness = createAggregator({
      bindings,
      isTaskBusy: async () => busy,
    });

    // 第一个事件：debounce 到点 → 会话忙 → hold（零投递，事件留桶）。
    harness.aggregator.enqueue(KEY, event("first"));
    await vi.advanceTimersByTimeAsync(60);
    expect(harness.dispatch).not.toHaveBeenCalled();
    expect(harness.logs.some((message) => message.includes("hold trigger:"))).toBe(true);

    // 忙期间第二个事件：重试轮仍 hold，继续累积（hold 日志只报一次，不刷屏）。
    harness.aggregator.enqueue(KEY, event("second"));
    await vi.advanceTimersByTimeAsync(120);
    expect(harness.dispatch).not.toHaveBeenCalled();
    const holdLogs = harness.logs.filter((message) => message.includes("hold trigger:"));
    expect(holdLogs).toHaveLength(1);

    // 会话空闲：重试轮合并全部累积事件，恰好一次投递；此后无追加投递。
    busy = false;
    await vi.advanceTimersByTimeAsync(120);
    expect(harness.dispatch).toHaveBeenCalledTimes(1);
    const batch = harness.dispatch.mock.calls[0]?.[0] as {
      sessionKey: string;
      existingTaskId?: string;
      events: Array<{ summary: string }>;
    };
    expect(batch.sessionKey).toBe(KEY);
    expect(batch.existingTaskId).toBe(TASK_ID);
    expect(batch.events.map((item) => item.summary)).toEqual(["first", "second"]);
    await vi.advanceTimersByTimeAsync(200);
    expect(harness.dispatch).toHaveBeenCalledTimes(1);
  });

  it("dispatches immediately for an unbound session without consulting busy state", async () => {
    vi.useFakeTimers();
    const isTaskBusy = vi.fn(async () => true);
    const harness = createAggregator({ bindings: {}, isTaskBusy });

    // 无绑定 = 新会话路径（首次触发懒创建）：无忙可查，直接投递。
    harness.aggregator.enqueue(KEY, event("first"));
    await vi.advanceTimersByTimeAsync(60);
    expect(isTaskBusy).not.toHaveBeenCalled();
    expect(harness.dispatch).toHaveBeenCalledTimes(1);
    const batch = harness.dispatch.mock.calls[0]?.[0] as { existingTaskId?: string };
    expect(batch.existingTaskId).toBeUndefined();
  });

  it("fails open (dispatches anyway) when the busy probe throws", async () => {
    vi.useFakeTimers();
    const harness = createAggregator({
      bindings: { [KEY]: TASK_ID },
      isTaskBusy: async () => {
        throw new Error("probe unavailable");
      },
    });

    // 忙检测故障 fail-open：按空闲投递（不比无忙感知的旧行为差），事件不滞留。
    harness.aggregator.enqueue(KEY, event("first"));
    await vi.advanceTimersByTimeAsync(60);
    expect(harness.dispatch).toHaveBeenCalledTimes(1);
    expect(harness.logs.some((message) => message.includes("busy check failed"))).toBe(true);
  });
});
