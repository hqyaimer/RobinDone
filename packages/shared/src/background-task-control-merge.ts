import type { RobinDoneBackgroundTaskControlItem } from "./background-task-controls.js";

export function mergeRobinDoneBackgroundTaskControlItems(
  current: readonly RobinDoneBackgroundTaskControlItem[],
  updates: readonly RobinDoneBackgroundTaskControlItem[],
): RobinDoneBackgroundTaskControlItem[] {
  const jobsById = new Map(current.map((job) => [job.jobId, job] as const));
  for (const job of updates) {
    jobsById.set(job.jobId, job);
  }
  return Array.from(jobsById.values());
}
