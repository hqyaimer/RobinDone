import { ServiceChannels, type RobinRunTaskMeta } from "@robinrun/shared";
import { createServiceDescriptor } from "#src/descriptors.js";

export type TaskGroupColor = "gray" | "red" | "orange" | "yellow" | "green" | "blue" | "purple";
export interface TaskGroup {
  id: string;
  title: string;
  color: TaskGroupColor;
  createdAt: number;
  updatedAt: number;
  /**
   * 所属项目（RobinRun 产品模型：项目 → 智能体 → 会话 三级组织）。
   * NULL 表示未绑定：系统全局组（cron/闲时）、旧数据回填歧义的组。主智能体组由自举写入，永为绑定态。
   */
  projectId: string | null;
}
export interface GroupTaskRef {
  hostId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}
export type GroupNode = { type: "group"; groupId: string } | { type: "task"; task: GroupTaskRef };
export interface TaskGroupStructure {
  groups: TaskGroup[];
  members: Array<{ groupId: string; workspaceKey: string; taskId: string; sortOrder: number }>;
  order: Array<{ type: "group" | "task"; key: string; sortOrder: number }>;
}
export interface MoveGroupNode {
  node: GroupNode;
  /** 来源不匹配表示另一客户端已整理，不能用旧 UI 覆盖。 */
  sourceGroupId: string | null;
  groupId: string | null;
  anchor?: { node: GroupNode; side: "before" | "after" };
}
export type GroupTaskFact = GroupTaskRef &
  Pick<RobinRunTaskMeta, "cronAutomationId" | "offPeakTaskId"> & {
    createdAt?: number;
    archived?: boolean;
    deleted?: boolean;
  };
export interface ITaskGroupService {
  read(): Promise<TaskGroupStructure>;
  save(input: {
    id?: string;
    title?: string;
    color?: TaskGroupColor;
    /** 创建/移动时声明所属项目；主智能体组的绑定不可改写。 */
    projectId?: string | null;
  }): Promise<TaskGroup>;
  ungroup(id: string): Promise<void>;
  move(input: MoveGroupNode): Promise<void>;
  /** Host 验证存在性和类型后首次登记；读取结构本身不写数据。 */
  admit(input: {
    tasks: GroupTaskRef[];
    placement?: { task: GroupTaskRef; groupId: string | null; creationId: string };
  }): Promise<void>;
  /**
   * 项目标配主智能体：确定性 id（robinrun-main-agent-<projectId>）幂等自举，已存在直接返回。
   * saveProject（含 reuseExistingRoot 重开）都会调用，旧项目打开时自动补齐。
   */
  ensureMainAgentGroup(input: { projectId: string }): Promise<TaskGroup>;
}
export const ITaskGroupService = createServiceDescriptor<ITaskGroupService>(
  ServiceChannels.TaskGroups,
);
