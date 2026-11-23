import type {
  TaskGroup,
  TaskGroupColor as RobinRunTaskGroupColor,
  ProjectTask,
} from "@/project-sidebar/contract.js";

interface TaskGroupMenuItem {
  id: string;
  title: string;
  color: RobinRunTaskGroupColor;
}
const TASK_GROUP_COLORS = [
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
] satisfies RobinRunTaskGroupColor[];
const TASK_GROUP_COLOR_CLASS: Record<RobinRunTaskGroupColor, string> = {
  gray: "bg-zinc-300 text-zinc-800 dark:bg-zinc-400/32 dark:text-zinc-100",
  red: "bg-rose-300 text-rose-900 dark:bg-rose-400/32 dark:text-rose-50",
  orange: "bg-orange-300 text-orange-900 dark:bg-orange-400/32 dark:text-orange-50",
  yellow: "bg-amber-300 text-amber-900 dark:bg-amber-300/32 dark:text-amber-50",
  green: "bg-emerald-300 text-emerald-900 dark:bg-emerald-400/32 dark:text-emerald-50",
  blue: "bg-sky-300 text-sky-900 dark:bg-sky-400/32 dark:text-sky-50",
  purple: "bg-violet-300 text-violet-900 dark:bg-violet-400/32 dark:text-violet-50",
};
// RobinRun 智能体列表（2026-11-15 裁决）：组间不留纵向间距，行高节奏由 header/行自身决定；
// 悬停背景已足够区分相邻智能体（2026-11-20 起内容区不再画左边线，状态改由会话行前置槽表达）。
const TASK_GROUP_CONTAINER_CLASS =
  "relative pb-0 transition-[width,max-width] duration-200 ease-out";
const TASK_GROUP_HEADER_CLASS =
  "mb-0.5 flex h-8 items-center gap-1 rounded-lg border border-transparent pl-1.5 pr-1 text-ui-base text-foreground transition-[background-color,border-color,box-shadow] hover:bg-surface-hover";
const TASK_GROUP_TITLE_CLASS =
  "min-w-0 max-w-full cursor-pointer truncate rounded-sm px-1 text-left text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused";
const TASK_GROUP_COUNT_BADGE_CLASS =
  "inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-tag/50 px-1.5 py-0.5 text-ui-sm font-medium leading-none text-foreground-subtle";
// 2026-11-20 裁决（二次修订）：内容区不缩进——曾用 ml-4 pl-2 + border-l 表达从属层级，
// 用户反馈空间利用率差；会话行改为与组头行贴同一左缘，层级感由前置状态槽与头部色点列
// 的对齐表达（行 pl-1.5 让状态槽正对头部色点、标题正对头部标题）。
const TASK_GROUP_CONTENT_CLASS = "py-px";
// 行是纵向列：首行（标题 + 右侧元信息）固定 28px，其下可挂工作流运行行，所以外层只定 min-h。
// pl-1.5：px-2 容器 + 6px 后状态槽（size-4）起始于 14px，与组头 pl-1.5 后的色点列对齐；
// 槽 + gap-2 共 24px，标题起始 38px，与组头标题对齐。
const TASK_GROUP_ROW_CLASS =
  "flex min-h-7 w-full min-w-0 flex-col justify-center rounded-lg border border-transparent pl-1.5 pr-1 text-left text-ui-base transition-[background-color,border-color,color,opacity]";
const TASK_GROUP_ROW_LINE_CLASS = "flex h-7 w-full min-w-0 items-center gap-2";
export {
  TASK_GROUP_ROW_LINE_CLASS,
  TASK_GROUP_COLOR_CLASS,
  TASK_GROUP_COLORS,
  TASK_GROUP_CONTAINER_CLASS,
  TASK_GROUP_CONTENT_CLASS,
  TASK_GROUP_COUNT_BADGE_CLASS,
  TASK_GROUP_HEADER_CLASS,
  TASK_GROUP_ROW_CLASS,
  TASK_GROUP_TITLE_CLASS,
};

export type { TaskGroupMenuItem };

// 删除前分组组件的展示契约；行集合只从当前目录投影，不恢复旧事实缓存。
export type { RobinRunTaskGroupColor };
export type RobinRunTaskGroup = TaskGroup;
export type RobinRunGroupedTaskViewNode =
  | { type: "group"; group: TaskGroup; tasks: ProjectTask[] }
  | { type: "task"; task: ProjectTask };
export interface RobinRunGroupedTaskView {
  nodes: RobinRunGroupedTaskViewNode[];
}
export type GroupedDraftTaskPlacement = { type: "top" } | { type: "group"; groupId: string };
