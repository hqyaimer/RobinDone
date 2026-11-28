import {
  collectVisibleRobinDoneBackgroundTaskControlItems,
  getRobinDoneBackgroundTaskControlItemElapsedMs,
  isActiveRobinDoneBackgroundTaskControlItem,
  parseRobinDoneBackgroundTaskControlItems,
  type RobinDoneBackgroundTaskControlItem,
  type RobinDoneBackgroundTaskControlStatus,
} from "./background-task-controls.js";

export type RobinDoneBackgroundBashJobStatus = RobinDoneBackgroundTaskControlStatus;
export type RobinDoneBackgroundBashJob = RobinDoneBackgroundTaskControlItem & {
  taskKind: "bash";
};

export function parseRobinDoneBackgroundBashJobs(value: unknown): RobinDoneBackgroundBashJob[] {
  return parseRobinDoneBackgroundTaskControlItems(value).filter(isBackgroundBashJob);
}

export function isActiveRobinDoneBackgroundBashJob(job: RobinDoneBackgroundBashJob): boolean {
  return isActiveRobinDoneBackgroundTaskControlItem(job);
}

export function getRobinDoneBackgroundBashJobElapsedMs(
  job: RobinDoneBackgroundBashJob,
  now = Date.now(),
): number {
  return getRobinDoneBackgroundTaskControlItemElapsedMs(job, now);
}

export function collectVisibleRobinDoneBackgroundBashJobs(
  jobs: readonly RobinDoneBackgroundBashJob[],
  now = Date.now(),
  thresholdMs = 30_000,
): Array<RobinDoneBackgroundBashJob & { elapsedMs: number }> {
  return collectVisibleRobinDoneBackgroundTaskControlItems(jobs, now, thresholdMs) as Array<
    RobinDoneBackgroundBashJob & { elapsedMs: number }
  >;
}

function isBackgroundBashJob(
  job: RobinDoneBackgroundTaskControlItem,
): job is RobinDoneBackgroundBashJob {
  return job.taskKind === "bash";
}
