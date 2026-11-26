import { Cron } from "croner";
import type { TriggerEntry } from "@robinrun/shared";

/**
 * 触发器调度纯函数（2026-11-25 分发器裁决批次从 engine.ts 拆出，文件行数上限）：
 * cron/interval 的到点计算与调度形状归一。引擎侧（arm/rebuild/fire 的闭包逻辑）留在
 * engine.ts；本文件不持有任何引擎状态。
 */

// setTimeout 单次上限约 24.8 天（2^31-1 ms）；长周期 cron 分片等待。
export const MAX_TIMER_MS = 2 ** 31 - 1;

export interface ScheduleHandle {
  timer: NodeJS.Timeout;
  /**
   * arm 时算定的目标时刻（未截断的 nextMs）。到点判定以它为准——不能用
   * computeNextFireMs 重算判定，见 engine.onScheduleFire 内注释（2026-11-19 实测 bug）。
   */
  intendedMs: number;
}

/**
 * cron 下一次触发（毫秒，本地时区；严格晚于 fromMs）。
 * 与 session/automationCron.computeNextRunAt 同款 croner 惯用法——在本模块内复制薄包装，
 * 避免 trigger-system 对 session 模块的跨模块深引（architecture:check 纪律）。
 */
export function computeNextCronRunMs(expr: string, fromMs: number): number | null {
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

export function scheduleOf(
  config: TriggerEntry["config"],
): { kind: "cron"; schedule: string } | { kind: "interval"; intervalMinutes: number } | undefined {
  if (config.kind === "cron") return { kind: "cron", schedule: config.schedule };
  if (config.kind === "interval")
    return { kind: "interval", intervalMinutes: config.intervalMinutes };
  // script 型：scheduled 模式进调度（2026-11-25 定时执行模式裁决——到点 spawn 一趟，
  // fire 路径走 ScriptSupervisor.spawnScheduledRun 而非事件投递）；resident 模式不进调度
  // （2026-11-21 常驻模型）：ScriptSupervisor 随轮询 reconcile 托管。
  // system 型（2026-11-24 系统订阅）由播种方服务直接驱动，不经调度器。
  if (config.kind === "script" && config.runMode === "scheduled") {
    const schedule = config.schedule;
    if (schedule === undefined) return undefined; // schema superRefine 已拦；运行时防御
    return schedule.kind === "cron"
      ? { kind: "cron", schedule: schedule.schedule }
      : { kind: "interval", intervalMinutes: schedule.intervalMinutes };
  }
  return undefined;
}

/** 冷恢复锚点输入（engine.WorkspaceState 的窄投影）。 */
export interface ScheduleAnchorState {
  mountedAt: number;
}

/** cron/interval 下一次到点（毫秒）；不可调度的类型返回 null。 */
export function computeNextFireMs(
  config: TriggerEntry["config"],
  state: ScheduleAnchorState,
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
