import { useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { FolderPlus } from "lucide-react";
import type { VirtualProject } from "@/project-sidebar/contract.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  getGroupedTaskDragType,
  groupedTaskCollisionDetection,
} from "@/project-sidebar/grouped/drag.js";
import { projectKey } from "@/project-sidebar/view.js";

// 修复原因：必须与 useGroupedDrag 的手势配置一致——不带 activationConstraint 的默认
// PointerSensor 会在 pointerdown 立即激活，行点击会被当作拖拽起点吞掉（项目行“点不动”
// 的根因）；distance:6 让无位移的点击照常触发 onClick。模块级常量沿用 SortableProjects
// 的教训：内联 options 会让 useSensor 每次渲染都重建 activators/listeners。
const pointerOptions = { activationConstraint: { distance: 6 } };

export interface ProjectListProps {
  /** 已按置顶优先 + 本地偏好排序的完整项目列表（空项目也要渲染成可进入的行）。 */
  projects: VirtualProject[];
  /** 行装配回调（与智能体树共用 ProjectSidebarNode 装配，导航外壳由其注入）。 */
  renderProject(project: VirtualProject): ReactNode;
  onReorderProjects(active: string, over: string): void;
  onAddProject?: () => void;
  addProjectLabel: string;
  emptyLabel: string;
  loading?: boolean;
  /** 头部工具槽锚点（与 TaskGroupedView 的 portal 目标一致）。 */
  toolbarTarget?: HTMLElement | null;
}

/**
 * RobinRun 项目列表页（2026-11-15 项目列表导航裁决）：
 * 一级平铺所有项目（不含智能体/会话），行点击进入该项目；拖拽仅承担项目排序。
 * 与智能体页（TaskGroupedView）互斥渲染，各自持有独立的 DndContext——
 * 列表页的 sortable 全部是 grouped-project 类型，碰撞检测按类型分流后天然只落项目行。
 */
export function ProjectList({
  projects,
  renderProject,
  onReorderProjects,
  onAddProject,
  addProjectLabel,
  emptyLabel,
  loading = false,
  toolbarTarget,
}: ProjectListProps) {
  const projectKeys = useMemo(() => projects.map((project) => projectKey(project)), [projects]);
  const sensors = useSensors(useSensor(PointerSensor, pointerOptions));
  const handleDragEnd = (event: DragEndEvent) => {
    if (getGroupedTaskDragType(event.active.data.current) !== "grouped-project") return;
    const overId = event.over?.id;
    if (overId && event.active.id !== overId) {
      onReorderProjects(String(event.active.id), String(overId));
    }
  };
  return (
    <>
      {toolbarTarget && onAddProject
        ? createPortal(
            <ControlHintTooltip title={addProjectLabel}>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-foreground-subtle hover:text-foreground"
                data-testid="agent-tree-add-project"
                aria-label={addProjectLabel}
                onClick={onAddProject}
              >
                <FolderPlus className="size-3.5" />
              </Button>
            </ControlHintTooltip>,
            toolbarTarget,
          )
        : null}
      {projects.length === 0 && !loading ? (
        <p className="px-4 text-ui-sm text-foreground-subtle">{emptyLabel}</p>
      ) : null}
      <DndContext
        sensors={sensors}
        collisionDetection={groupedTaskCollisionDetection}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={projectKeys} strategy={verticalListSortingStrategy}>
          {projects.map((project) => renderProject(project))}
        </SortableContext>
      </DndContext>
    </>
  );
}
