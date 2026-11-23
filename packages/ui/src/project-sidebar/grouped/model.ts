import type {
  GroupNode,
  MoveGroupNode,
  ProjectTask,
  TaskGroupStructure,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import { groupTaskRef, projectGroupedNodes } from "@/project-sidebar/grouped-view.js";
import { UNGROUPED_AGENT_ID } from "@/project-sidebar/grouped/ids.js";
import type {
  RobinRunGroupedTaskView,
  RobinRunGroupedTaskViewNode,
} from "@/project-sidebar/grouped/types.js";
import { isMainAgentGroupId, isWorkerGroupId } from "@robinrun/shared";
import { taskKey } from "@/project-sidebar/grouped/ids.js";

/** 旧组件只消费展示树；任务事实与组织结构仍来自当前唯一 owner。 */
export function buildGroupedTaskView(
  tasks: ProjectTask[],
  structure: TaskGroupStructure,
): RobinRunGroupedTaskView {
  const nodes: RobinRunGroupedTaskViewNode[] = [];
  const groups = new Map<string, Extract<RobinRunGroupedTaskViewNode, { type: "group" }>>();
  for (const row of projectGroupedNodes(tasks, structure, new Set())) {
    if (row.type === "group") {
      const node = { type: "group" as const, group: row.group, tasks: [] as ProjectTask[] };
      groups.set(row.group.id, node);
      nodes.push(node);
    } else if (row.type === "task") {
      if (row.groupId) groups.get(row.groupId)?.tasks.push(row.task);
      else nodes.push({ type: "task", task: row.task });
    }
  }
  return { nodes };
}

export type AgentGroupNode = Extract<RobinRunGroupedTaskViewNode, { type: "group" }>;

export interface AgentTreeLayout {
  /** 项目文件夹段落：按项目展示顺序排列，agents 为主智能体置顶的该项目智能体节点。 */
  sections: Array<{ project: VirtualProject; agents: AgentGroupNode[] }>;
  /** 未绑定项目/系统全局的智能体（cron、闲时、旧数据与未匹配组），保持平面顺序。 */
  unbound: AgentGroupNode[];
  /** 固定"未分组"伪组（有未归属会话时才存在）。 */
  ungrouped: AgentGroupNode | null;
}

/**
 * 项目分层是纯展示投影：智能体平面保持扁平（拖拽/预览/命令数学不变），
 * 由组上的 projectId 决定它渲染在哪个项目文件夹下；projectId 为空或指向
 * 已删除/不存在项目的组回退到未绑定区，项目恢复后自动回到文件夹内。
 *
 * scopeProject（2026-11-15 智能体页数据范围裁决）：进入某项目的智能体页时传入该项目。
 * 页面只承载本项目的内容——绑定到其他项目的组（含已软删除项目的组）整段隐藏，不落
 * 未绑定区，避免删除项目后其智能体泄漏进其他项目的页面；未绑定组（cron/闲时系统组与
 * 遗留数据）按 P2.1 约定继续在本页渲染。树模式（web 远控回退）传 null 保持全量。
 *
 * activeWorkerGroupIds（2026-11-17 停用即隐藏裁决）：worker 组是编制投影，只显示
 * active worker 的组；注册表里已停用 worker 的组（含其历史会话）整段隐藏——数据
 * 保留，重新启用后名册同步效果会恢复显示并同步标题。缺省（未传）保持全量。
 */
export function buildAgentTreeLayout(
  view: RobinRunGroupedTaskView,
  projects: VirtualProject[],
  scopeProject?: VirtualProject | null,
  options?: { activeWorkerGroupIds?: ReadonlySet<string> },
): AgentTreeLayout {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const bucketAgents = new Map<string, AgentGroupNode[]>();
  const unbound: AgentGroupNode[] = [];
  let ungrouped: AgentGroupNode | null = null;
  for (const node of view.nodes) {
    if (node.type !== "group") continue;
    if (node.group.id === UNGROUPED_AGENT_ID) {
      ungrouped = node;
      continue;
    }
    if (
      isWorkerGroupId(node.group.id) &&
      options?.activeWorkerGroupIds !== undefined &&
      !options.activeWorkerGroupIds.has(node.group.id)
    )
      continue;
    const project = node.group.projectId ? projectById.get(node.group.projectId) : undefined;
    if (!project) {
      // 智能体页按项目收敛：绑定到其他项目（含已删除项目）的组不属于本页，直接不渲染；
      // 组数据保留，项目恢复（撤销删除）后自动回到其文件夹。
      if (scopeProject && node.group.projectId) continue;
      unbound.push(node);
      continue;
    }
    const bucket = bucketAgents.get(project.id) ?? [];
    bucket.push(node);
    bucketAgents.set(project.id, bucket);
  }
  // 主智能体是项目标配且置顶展示；worker 组（编制物化）紧随其后；其余智能体保持平面（用户）顺序。
  const orderAgents = (agents: AgentGroupNode[]) =>
    [...agents].sort(
      (a, b) =>
        Number(isMainAgentGroupId(b.group.id)) - Number(isMainAgentGroupId(a.group.id)) ||
        Number(isWorkerGroupId(a.group.id)) - Number(isWorkerGroupId(b.group.id)),
    );
  const sections: AgentTreeLayout["sections"] = [];
  for (const project of projects) {
    // 还未打开过的项目没有智能体（自举在首次打开时补主智能体）；空文件夹不渲染，避免噪音。
    const agents = bucketAgents.get(project.id);
    if (!agents || agents.length === 0) continue;
    sections.push({ project, agents: orderAgents(agents) });
  }
  return { sections, unbound, ungrouped };
}

function locate(view: RobinRunGroupedTaskView, source: GroupNode) {
  for (const [index, node] of view.nodes.entries()) {
    if (source.type === "group" && node.type === "group" && node.group.id === source.groupId)
      return { groupId: null, index, siblings: view.nodes };
    if (source.type !== "task") continue;
    if (node.type === "task" && taskKey(node.task) === taskKey(source.task))
      return { groupId: null, index, siblings: view.nodes };
    if (node.type === "group") {
      const taskIndex = node.tasks.findIndex((task) => taskKey(task) === taskKey(source.task));
      if (taskIndex >= 0)
        return {
          groupId: node.group.id,
          index: taskIndex,
          siblings: node.tasks.map((task) => ({ type: "task" as const, task })),
        };
    }
  }
  return null;
}
const ref = (node: RobinRunGroupedTaskViewNode): GroupNode =>
  node.type === "group"
    ? { type: "group", groupId: node.group.id }
    : { type: "task", task: groupTaskRef(node.task) };

/** 旧版整表 applyOrder 会覆盖不可见成员；恢复交互时只提交被拖动节点和相邻锚点。 */
export function groupedMoveCommand(
  origin: RobinRunGroupedTaskView,
  preview: RobinRunGroupedTaskView,
  source: GroupNode,
): MoveGroupNode | null {
  const before = locate(origin, source),
    after = locate(preview, source);
  if (!before || !after || (before.groupId === after.groupId && before.index === after.index))
    return null;
  const next = after.siblings[after.index + 1],
    previous = after.siblings[after.index - 1];
  return {
    node: source,
    sourceGroupId: before.groupId,
    groupId: after.groupId,
    ...(next
      ? { anchor: { node: ref(next), side: "before" as const } }
      : previous
        ? { anchor: { node: ref(previous), side: "after" as const } }
        : {}),
  };
}
