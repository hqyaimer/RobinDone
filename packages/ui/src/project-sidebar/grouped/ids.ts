import type { ProjectTask as RobinRunTaskMeta } from "@/project-sidebar/contract.js";

import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

function taskKey(
  task: Pick<RobinRunTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">,
): string {
  return `${buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity)}\u0000${task.taskId}`;
}

export { taskKey };

/**
 * 固定"未分组"伪组的展示 id：收纳未归属任何智能体的会话，渲染在智能体列表末尾。
 * 只存在于 UI 投影，不落库（对应 move 命令的 groupId=null）；仓库/服务不感知该 id。
 */
export const UNGROUPED_AGENT_ID = "robinrun-ungrouped-agent";
