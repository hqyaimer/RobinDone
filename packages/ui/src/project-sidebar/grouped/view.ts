import type { ProjectTask as RobinDoneTaskMeta } from "@/project-sidebar/contract.js";
import type {
  RobinDoneGroupedTaskView,
  RobinDoneGroupedTaskViewNode,
  GroupedDraftTaskPlacement,
} from "@/project-sidebar/grouped/types.js";

import { UNGROUPED_AGENT_ID } from "@/project-sidebar/grouped/ids.js";
import { taskKey } from "@/project-sidebar/grouped/ids.js";

function cloneView(view: RobinDoneGroupedTaskView): RobinDoneGroupedTaskView {
  return {
    nodes: view.nodes.map((node) =>
      node.type === "task" ? { ...node } : { ...node, tasks: [...node.tasks] },
    ),
  };
}

function cloneNodes(view: RobinDoneGroupedTaskView): RobinDoneGroupedTaskViewNode[] {
  return [...view.nodes];
}

function cloneGroupNode(
  node: Extract<RobinDoneGroupedTaskViewNode, { type: "group" }>,
): Extract<RobinDoneGroupedTaskViewNode, { type: "group" }> {
  return { ...node, tasks: [...node.tasks] };
}

function removeTaskFromView(
  view: RobinDoneGroupedTaskView,
  targetTaskKey: string,
): {
  nextView: RobinDoneGroupedTaskView;
  task: RobinDoneTaskMeta | null;
} {
  const nodes = cloneNodes(view);
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node) {
      continue;
    }
    if (node.type === "task" && taskKey(node.task) === targetTaskKey) {
      nodes.splice(index, 1);
      return { nextView: { nodes }, task: node.task };
    }
    if (node.type === "group") {
      const taskIndex = node.tasks.findIndex((task) => taskKey(task) === targetTaskKey);
      if (taskIndex >= 0) {
        const nextGroupNode = cloneGroupNode(node);
        const [task] = nextGroupNode.tasks.splice(taskIndex, 1);
        nodes[index] = nextGroupNode;
        return { nextView: { nodes }, task: task ?? null };
      }
    }
  }
  return { nextView: { nodes }, task: null };
}

function insertTaskIntoGroup(
  view: RobinDoneGroupedTaskView,
  task: RobinDoneTaskMeta,
  groupId: string,
  beforeTaskKey: string | null,
): RobinDoneGroupedTaskView {
  const nodes = cloneNodes(view);
  const groupIndex = nodes.findIndex((node) => node.type === "group" && node.group.id === groupId);
  const groupNode = nodes[groupIndex];
  if (!groupNode || groupNode.type !== "group") {
    return { nodes };
  }
  const nextGroupNode = cloneGroupNode(groupNode);
  const insertIndex =
    beforeTaskKey === null
      ? nextGroupNode.tasks.length
      : nextGroupNode.tasks.findIndex((item) => taskKey(item) === beforeTaskKey);
  nextGroupNode.tasks.splice(insertIndex < 0 ? nextGroupNode.tasks.length : insertIndex, 0, task);
  nodes[groupIndex] = nextGroupNode;
  return { nodes };
}

function removeTaskFromGroupedView(
  view: RobinDoneGroupedTaskView,
  targetTaskKey: string,
): RobinDoneGroupedTaskView {
  const nextView = cloneView(view);
  for (const node of nextView.nodes) {
    if (node.type !== "group") {
      continue;
    }
    const taskIndex = node.tasks.findIndex((task) => taskKey(task) === targetTaskKey);
    if (taskIndex >= 0) {
      node.tasks.splice(taskIndex, 1);
      return nextView;
    }
  }

  const nodeIndex = nextView.nodes.findIndex(
    (node) => node.type === "task" && taskKey(node.task) === targetTaskKey,
  );
  if (nodeIndex >= 0) {
    nextView.nodes.splice(nodeIndex, 1);
  }
  return nextView;
}

function filterGroupedViewByTaskKeys(
  view: RobinDoneGroupedTaskView,
  hiddenTaskKeys: ReadonlySet<string>,
): RobinDoneGroupedTaskView {
  if (hiddenTaskKeys.size === 0) {
    return view;
  }

  let changed = false;
  const nodes: RobinDoneGroupedTaskView["nodes"] = [];
  for (const node of view.nodes) {
    if (node.type === "task") {
      if (!hiddenTaskKeys.has(taskKey(node.task))) {
        nodes.push(node);
      } else {
        changed = true;
      }
      continue;
    }

    const tasks = node.tasks.filter((task) => !hiddenTaskKeys.has(taskKey(task)));
    if (tasks.length === node.tasks.length) {
      nodes.push(node);
      continue;
    }
    changed = true;
    nodes.push({ ...node, tasks });
  }

  return changed ? { nodes } : view;
}

function findTaskInGroupedView(
  view: RobinDoneGroupedTaskView,
  targetTaskKey: string,
): RobinDoneTaskMeta | null {
  for (const node of view.nodes) {
    if (node.type === "task" && taskKey(node.task) === targetTaskKey) {
      return node.task;
    }
    if (node.type === "group") {
      const task = node.tasks.find((item) => taskKey(item) === targetTaskKey);
      if (task) {
        return task;
      }
    }
  }
  return null;
}

function replaceTaskInGroupedView(
  view: RobinDoneGroupedTaskView,
  nextTask: RobinDoneTaskMeta,
): RobinDoneGroupedTaskView {
  const targetTaskKey = taskKey(nextTask);
  return {
    nodes: view.nodes.map((node) => {
      if (node.type === "task") {
        return taskKey(node.task) === targetTaskKey ? { ...node, task: nextTask } : node;
      }
      return {
        ...node,
        tasks: node.tasks.map((task) => (taskKey(task) === targetTaskKey ? nextTask : task)),
      };
    }),
  };
}

function getGroupedTaskGroupIds(view: RobinDoneGroupedTaskView): string[] {
  return view.nodes.flatMap((node) => (node.type === "group" ? [node.group.id] : []));
}

function areAllGroupedTaskGroupsExpanded(
  groupIds: readonly string[],
  collapsedGroupIds: ReadonlySet<string>,
): boolean {
  return groupIds.length > 0 && groupIds.every((groupId) => !collapsedGroupIds.has(groupId));
}

function pruneCollapsedGroupedTaskGroupIds(
  collapsedGroupIds: ReadonlySet<string>,
  groupIds: readonly string[],
): Set<string> {
  const knownGroupIds = new Set(groupIds);
  return new Set([...collapsedGroupIds].filter((groupId) => knownGroupIds.has(groupId)));
}

function getTaskGroupIdInView(
  view: RobinDoneGroupedTaskView,
  targetTaskKey: string,
): string | null {
  for (const node of view.nodes) {
    if (node.type !== "group") {
      continue;
    }
    if (node.tasks.some((task) => taskKey(task) === targetTaskKey)) {
      return node.group.id;
    }
  }
  return null;
}

type GroupedTaskLocation =
  | {
      parent: "root";
      nodeIndex: number;
      task: RobinDoneTaskMeta;
    }
  | {
      parent: "group";
      groupId: string;
      nodeIndex: number;
      taskIndex: number;
      task: RobinDoneTaskMeta;
    };

type GroupedTaskInsertPosition = "before" | "after";

function findTopLevelTaskIndex(view: RobinDoneGroupedTaskView, targetTaskKey: string): number {
  return view.nodes.findIndex(
    (node) => node.type === "task" && taskKey(node.task) === targetTaskKey,
  );
}

function findGroupIndex(view: RobinDoneGroupedTaskView, groupId: string): number {
  return view.nodes.findIndex((node) => node.type === "group" && node.group.id === groupId);
}

function findGroupIdByTaskKey(
  view: RobinDoneGroupedTaskView,
  targetTaskKey: string,
): string | null {
  for (const node of view.nodes) {
    if (node.type !== "group") {
      continue;
    }
    if (node.tasks.some((task) => taskKey(task) === targetTaskKey)) {
      return node.group.id;
    }
  }
  return null;
}

function findTaskLocation(
  view: RobinDoneGroupedTaskView,
  targetTaskKey: string,
): GroupedTaskLocation | null {
  for (let nodeIndex = 0; nodeIndex < view.nodes.length; nodeIndex += 1) {
    const node = view.nodes[nodeIndex];
    if (!node) {
      continue;
    }
    if (node.type === "task" && taskKey(node.task) === targetTaskKey) {
      return { parent: "root", nodeIndex, task: node.task };
    }
    if (node.type === "group") {
      const taskIndex = node.tasks.findIndex((task) => taskKey(task) === targetTaskKey);
      if (taskIndex >= 0) {
        const task = node.tasks[taskIndex];
        if (!task) {
          return null;
        }
        return {
          parent: "group",
          groupId: node.group.id,
          nodeIndex,
          taskIndex,
          task,
        };
      }
    }
  }
  return null;
}

function resolveGroupedDraftTaskPlacementForTask(
  view: RobinDoneGroupedTaskView,
  targetTaskKey: string | null | undefined,
): GroupedDraftTaskPlacement {
  if (!targetTaskKey) {
    return { type: "top" };
  }
  const location = findTaskLocation(view, targetTaskKey);
  return location?.parent === "group"
    ? { type: "group", groupId: location.groupId }
    : { type: "top" };
}

function insertTaskNearTask(
  view: RobinDoneGroupedTaskView,
  task: RobinDoneTaskMeta,
  overTaskKey: string,
  position: GroupedTaskInsertPosition,
): RobinDoneGroupedTaskView {
  const nodes = cloneNodes(view);
  const overLocation = findTaskLocation({ nodes }, overTaskKey);
  if (!overLocation) {
    return { nodes };
  }

  if (overLocation.parent === "root") {
    const insertIndex = overLocation.nodeIndex + (position === "after" ? 1 : 0);
    nodes.splice(insertIndex, 0, { type: "task", task });
    return { nodes };
  }

  const groupNode = nodes[overLocation.nodeIndex];
  if (!groupNode || groupNode.type !== "group") {
    return { nodes };
  }
  const nextGroupNode = cloneGroupNode(groupNode);
  const insertIndex = overLocation.taskIndex + (position === "after" ? 1 : 0);
  nextGroupNode.tasks.splice(insertIndex, 0, task);
  nodes[overLocation.nodeIndex] = nextGroupNode;
  return { nodes };
}

function moveTaskOverTask(
  view: RobinDoneGroupedTaskView,
  params: {
    activeTaskKey: string;
    overTaskKey: string;
    position: GroupedTaskInsertPosition;
  },
): RobinDoneGroupedTaskView {
  if (params.activeTaskKey === params.overTaskKey) {
    return view;
  }
  const activeLocation = findTaskLocation(view, params.activeTaskKey);
  const overLocation = findTaskLocation(view, params.overTaskKey);
  if (!activeLocation || !overLocation) {
    return view;
  }

  const { nextView, task } = removeTaskFromView(view, params.activeTaskKey);
  if (!task) {
    return view;
  }

  // task over task 的目标父级由 over task 所在层级决定。
  // 先移除 active 再按 over task 重新定位，避免同组向下移动时旧 index 把插入点推后一格。
  return insertTaskNearTask(nextView, task, params.overTaskKey, params.position);
}

function moveTaskToGroupStart(
  view: RobinDoneGroupedTaskView,
  params: {
    activeTaskKey: string;
    groupId: string;
  },
): RobinDoneGroupedTaskView {
  const { nextView, task } = removeTaskFromView(view, params.activeTaskKey);
  if (!task) {
    return view;
  }
  const groupNode = nextView.nodes.find(
    (node) => node.type === "group" && node.group.id === params.groupId,
  );
  if (!groupNode || groupNode.type !== "group") {
    return view;
  }
  const firstTaskKey = groupNode.tasks[0] ? taskKey(groupNode.tasks[0]) : null;
  return insertTaskIntoGroup(nextView, task, params.groupId, firstTaskKey);
}

function moveTaskToGroupEnd(
  view: RobinDoneGroupedTaskView,
  params: {
    activeTaskKey: string;
    groupId: string;
  },
): RobinDoneGroupedTaskView {
  const { nextView, task } = removeTaskFromView(view, params.activeTaskKey);
  if (!task) {
    return view;
  }
  const groupIndex = findGroupIndex(nextView, params.groupId);
  const groupNode = nextView.nodes[groupIndex];
  if (!groupNode || groupNode.type !== "group") {
    return view;
  }
  const nextGroupNode = cloneGroupNode(groupNode);
  nextGroupNode.tasks.push(task);
  const nodes = cloneNodes(nextView);
  nodes[groupIndex] = nextGroupNode;
  return { nodes };
}

function moveGroupAroundTopLevelNode(
  view: RobinDoneGroupedTaskView,
  params: {
    activeGroupId: string;
    over:
      | {
          type: "group";
          groupId: string;
        }
      | {
          type: "task";
          taskKey: string;
        };
    position: GroupedTaskInsertPosition;
  },
): RobinDoneGroupedTaskView {
  if (params.over.type === "group" && params.activeGroupId === params.over.groupId) {
    return view;
  }
  // group 拖到另一个 group 的 content 上时，collision 可能返回组内 task；
  // 这里把组内 task 归一化为所属 group，避免 content 区域不触发 group over group。
  const overGroupId =
    params.over.type === "task" ? findGroupIdByTaskKey(view, params.over.taskKey) : null;
  if (overGroupId === params.activeGroupId) {
    return view;
  }
  const nodes = cloneNodes(view);
  const activeIndex = nodes.findIndex(
    (node) => node.type === "group" && node.group.id === params.activeGroupId,
  );
  if (activeIndex < 0) {
    return view;
  }
  const [activeNode] = nodes.splice(activeIndex, 1);
  if (!activeNode || activeNode.type !== "group") {
    return view;
  }
  const nextView = { nodes };
  const overIndex =
    params.over.type === "group"
      ? findGroupIndex(nextView, params.over.groupId)
      : overGroupId
        ? findGroupIndex(nextView, overGroupId)
        : findTopLevelTaskIndex(nextView, params.over.taskKey);
  if (overIndex < 0) {
    return view;
  }
  nodes.splice(overIndex + (params.position === "after" ? 1 : 0), 0, activeNode);
  return { nodes };
}

function moveTaskByMenu(
  view: RobinDoneGroupedTaskView,
  targetTask: RobinDoneTaskMeta,
  targetGroupId: string | null,
): RobinDoneGroupedTaskView {
  const targetTaskKey = taskKey(targetTask);
  const currentGroupId = getTaskGroupIdInView(view, targetTaskKey);
  if (currentGroupId === targetGroupId) {
    return view;
  }

  const { nextView, task } = removeTaskFromView(view, targetTaskKey);
  if (!task) {
    return view;
  }
  if (targetGroupId) {
    return insertTaskIntoGroup(nextView, task, targetGroupId, null);
  }

  // 菜单"移出智能体"= 进入固定"未分组"伪组（平面末尾）；顶层独立会话行已取消。
  return insertTaskIntoGroup(nextView, task, UNGROUPED_AGENT_ID, null);
}

function moveTaskToTopByMenu(
  view: RobinDoneGroupedTaskView,
  targetTask: RobinDoneTaskMeta,
): RobinDoneGroupedTaskView {
  const targetTaskKey = taskKey(targetTask);
  const location = findTaskLocation(view, targetTaskKey);
  if (
    !location ||
    (location.parent === "root" && location.nodeIndex === 0) ||
    (location.parent === "group" && location.taskIndex === 0)
  ) {
    return view;
  }

  const { nextView, task } = removeTaskFromView(view, targetTaskKey);
  if (!task) {
    return view;
  }

  if (location.parent === "group") {
    const groupNode = nextView.nodes.find(
      (node) => node.type === "group" && node.group.id === location.groupId,
    );
    if (!groupNode || groupNode.type !== "group") {
      return view;
    }
    const firstTaskKey = groupNode.tasks[0] ? taskKey(groupNode.tasks[0]) : null;
    return insertTaskIntoGroup(nextView, task, location.groupId, firstTaskKey);
  }

  // 顶层独立会话行已取消；防御分支保持视图不变，等待结构刷新收敛。
  return view;
}

export {
  areAllGroupedTaskGroupsExpanded,
  cloneView,
  filterGroupedViewByTaskKeys,
  findTaskInGroupedView,
  getGroupedTaskGroupIds,
  moveTaskByMenu,
  moveGroupAroundTopLevelNode,
  moveTaskToTopByMenu,
  moveTaskToGroupEnd,
  moveTaskToGroupStart,
  moveTaskOverTask,
  pruneCollapsedGroupedTaskGroupIds,
  removeTaskFromGroupedView,
  replaceTaskInGroupedView,
  resolveGroupedDraftTaskPlacementForTask,
};
export type { GroupedTaskInsertPosition };
