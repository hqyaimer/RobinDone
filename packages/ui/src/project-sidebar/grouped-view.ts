import {
  CRON_DEFAULT_GROUP_ID,
  MAIN_AGENT_GROUP_TITLE,
  OFF_PEAK_DEFAULT_GROUP_ID,
  isMainAgentGroupId,
} from "@robinrun/shared";
import type {
  GroupTaskRef,
  ProjectTask,
  TaskGroup,
  TaskGroupStructure,
} from "@/project-sidebar/contract.js";
import { UNGROUPED_AGENT_ID } from "@/project-sidebar/grouped/ids.js";

export function taskGroupKey(
  task: Pick<GroupTaskRef, "workspacePath" | "workspaceIdentity" | "taskId">,
): string {
  return JSON.stringify([task.workspaceIdentity?.trim() || task.workspacePath, task.taskId]);
}
export function groupTaskRef(task: ProjectTask): GroupTaskRef {
  return {
    hostId: task.hostId,
    taskId: task.taskId,
    workspacePath: task.workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
  };
}
export type GroupedRow =
  | { type: "group"; key: string; group: TaskGroup }
  | { type: "task"; key: string; task: ProjectTask; groupId: string | null }
  | { type: "empty"; key: string; groupId: string };

/**
 * 未分组伪组的展示节点：收纳未归属任何智能体的会话。只在确实有未归属会话时出现，
 * 永远排在智能体平面末尾；id 是 UI 约定（UNGROUPED_AGENT_ID），move 命令里对应 groupId=null。
 */
function ungroupedGroupNode(tasks: ProjectTask[]): TaskGroup {
  return {
    id: UNGROUPED_AGENT_ID,
    title: "ungrouped",
    color: "gray",
    projectId: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * 智能体平面投影：一级=智能体、二级=会话；顶层不再渲染独立会话行。
 * - 未归属任何智能体的会话收入固定"未分组"伪组（仅在有这类会话时出现，排在平面末尾）；
 * - 置顶会话在所属智能体内置顶（全局置顶区已取消）；
 * - 会话存在性只来自 Host 树；分组结构保留不可见成员，投影不能反向删写。
 */
export function projectGroupedNodes(
  tasks: ProjectTask[],
  structure: TaskGroupStructure,
  collapsed: ReadonlySet<string>,
): GroupedRow[] {
  const visible = new Map(
    tasks.filter((task) => !task.archived).map((task) => [taskGroupKey(task), task]),
  );
  const groups = new Map(structure.groups.map((group) => [group.id, group]));
  const memberKeys = new Set<string>();
  const members = new Map<string, ProjectTask[]>();
  for (const member of [...structure.members].sort((a, b) => a.sortOrder - b.sortOrder)) {
    if (!groups.has(member.groupId)) continue;
    const key = JSON.stringify([member.workspaceKey, member.taskId]);
    memberKeys.add(key);
    const task = visible.get(key);
    if (task) {
      const rows = members.get(member.groupId) ?? [];
      rows.push(task);
      members.set(member.groupId, rows);
    }
  }
  // 置顶会话在智能体内置顶；同批内保持成员顺序（Array.sort 同位稳定）。
  for (const [groupId, rows] of members)
    members.set(
      groupId,
      [...rows].sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false)),
    );
  // 未归属会话沿用顶层 task 顺序登记（未登记的排后），收入固定"未分组"伪组。
  const root = [...structure.order].sort((a, b) => a.sortOrder - b.sortOrder);
  const ordered = new Set(root.map((row) => `${row.type}:${row.key}`));
  const ungroupedTasks: ProjectTask[] = [];
  for (const node of root) {
    if (node.type !== "task") continue;
    const task = visible.get(node.key);
    if (task && !memberKeys.has(node.key)) ungroupedTasks.push(task);
  }
  for (const [key, task] of visible)
    if (!ordered.has(`task:${key}`) && !memberKeys.has(key)) ungroupedTasks.push(task);
  const rows: GroupedRow[] = [];
  const groupOrder = root.filter((node) => node.type === "group");
  const orderedGroups = new Set(groupOrder.map((node) => node.key));
  for (const node of structure.groups)
    if (!orderedGroups.has(node.id)) groupOrder.push({ type: "group", key: node.id, sortOrder: 0 });
  for (const node of groupOrder) {
    const group = groups.get(node.key);
    if (!group) continue;
    rows.push({ type: "group", key: `group:${group.id}`, group });
    if (collapsed.has(group.id)) continue;
    const children = members.get(group.id) ?? [];
    rows.push(
      ...(children.length
        ? children.map(
            (task): GroupedRow => ({
              type: "task",
              key: `task:${taskGroupKey(task)}`,
              task,
              groupId: group.id,
            }),
          )
        : [{ type: "empty" as const, key: `empty:${group.id}`, groupId: group.id }]),
    );
  }
  // 伪组必须始终在平面里（"移出智能体"菜单/拖出预览要能计算落点），是否渲染由布局层按
  // 未归属会话数决定；伪组不产生 empty 行（空态下不渲染头部，也没有新建会话入口）。
  const ungrouped = ungroupedGroupNode(ungroupedTasks);
  rows.push({ type: "group", key: `group:${UNGROUPED_AGENT_ID}`, group: ungrouped });
  if (!collapsed.has(UNGROUPED_AGENT_ID))
    rows.push(
      ...ungroupedTasks.map(
        (task): GroupedRow => ({
          type: "task",
          key: `task:${taskGroupKey(task)}`,
          task,
          groupId: UNGROUPED_AGENT_ID,
        }),
      ),
    );
  return rows;
}

/**
 * 侧栏智能体行的本地化标题；仅系统/伪组与主智能体规范名覆盖 DB 标题，
 * 用户重命名后的智能体永远显示自定义名（title_source 原则与会话标题一致）。
 */
export function taskGroupTitleMessageId(
  group: Pick<TaskGroup, "id" | "title">,
): string | undefined {
  if (group.id === CRON_DEFAULT_GROUP_ID && group.title === "cron") return "taskGroup.cron";
  if (group.id === OFF_PEAK_DEFAULT_GROUP_ID && group.title === "off-peak")
    return "taskGroup.offPeak";
  // 主智能体：前缀 + 规范 title 双条件，避免用户手建的同名普通组被误本地化。
  if (isMainAgentGroupId(group.id) && group.title === MAIN_AGENT_GROUP_TITLE)
    return "taskGroup.mainAgent";
  if (group.id === UNGROUPED_AGENT_ID) return "taskGroup.ungrouped";
  return undefined;
}
