import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import { readComposerWorkspaceScope } from "@/v4/composer/composerDraftStore.js";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type Dispatch,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { DndContext, DragOverlay, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { FolderPlus, Hash, Maximize2, Minimize2 } from "lucide-react";
import { OFF_PEAK_DEFAULT_GROUP_ID } from "@robinrun/shared";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { TaskRenameDialog } from "@/TaskRenameDialog.js";
import { useProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";
import type {
  ProjectTask,
  ProjectSidebarProps,
  MoveGroupNode,
  TaskGroupColor,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import { groupTaskRef, taskGroupKey } from "@/project-sidebar/grouped-view.js";
import {
  readGroupedTaskCollapsedGroupIds,
  persistGroupedTaskCollapsedGroupIds,
} from "@/project-sidebar/grouped-expansion.js";
import {
  buildAgentTreeLayout,
  buildGroupedTaskView,
  groupedMoveCommand,
  type AgentGroupNode,
} from "@/project-sidebar/grouped/model.js";
import { GroupItem } from "@/project-sidebar/grouped/group-item.js";
import { GroupedTaskItem } from "@/project-sidebar/grouped/task-item.js";
import { GroupDragOverlay } from "@/project-sidebar/grouped/group-drag-overlay.js";
import { StickyGroupHeader } from "@/project-sidebar/grouped/sticky-group-header.js";
import { StickyGroupHeaderSlot } from "@/project-sidebar/grouped/sticky-group-header-slot.js";
import { useGroupedDrag } from "@/project-sidebar/grouped/useGroupedDrag.js";
import {
  GROUPED_TASK_DROP_ANIMATION,
  findNearestScrollableAncestor,
  getGroupedTaskDragType,
  resolveStickyGroupedTaskGroupId,
} from "@/project-sidebar/grouped/drag.js";
import { taskKey } from "@/project-sidebar/grouped/ids.js";
import { projectKey } from "@/project-sidebar/view.js";
import {
  findTaskInGroupedView,
  moveTaskByMenu,
  moveTaskToTopByMenu,
} from "@/project-sidebar/grouped/view.js";
import { mutateProjectTask, type ProjectTaskMutation } from "@/project-sidebar/task-mutation.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { resolveRemoteWorkspaceSessionIdForTarget } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useRobinRunSessionStore } from "@/store/robinrunSessionStore.js";
import {
  clearV4ComposerDraftTaskGroup,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";
import { useRobinRunIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";

/**
 * 智能体列表（一级=项目文件夹、二级=智能体、三级=会话）。
 * 智能体平面本身保持扁平（拖拽/预览/命令数学不变），项目文件夹是纯展示投影：
 * 组上的 projectId 决定它落在哪个文件夹；未绑定项目/系统的组与"未分组"伪组渲染在文件夹区之后。
 */

/** 恢复删除前的组件与手势（fd2f4f38a4a^1）；仅将旧事实缓存/applyOrder 改接当前 owner。 */
export function TaskGroupedView({
  tasks,
  onSelect,
  refresh,
  onCreate,
  workspacePath,
  workspaceIdentity,
  onOpenAutomations,
  toolbarTarget,
  stickyTarget,
  scrollRef,
  projects,
  renderProject,
  onReorderProjects,
  onAddProject,
  newAgentProject = null,
}: {
  tasks: ProjectTask[];
  onSelect: ProjectSidebarProps["onSelectTask"];
  refresh(): Promise<void>;
  onCreate(groupId: string | null): void;
  workspacePath: string;
  workspaceIdentity?: string;
  onOpenAutomations?: () => void;
  toolbarTarget: HTMLElement | null;
  stickyTarget: HTMLElement | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** 项目展示顺序（置顶在前，沿用现有项目排序偏好）。 */
  projects: VirtualProject[];
  /** 项目文件夹行复用项目视图的 ProjectSidebarNode；children 为该项目的智能体列表。 */
  renderProject(project: VirtualProject, children: ReactNode): ReactNode;
  onReorderProjects(active: string, over: string): void;
  onAddProject?: () => void;
  /**
   * RobinRun 项目列表导航（2026-11-15 裁决）：智能体页只渲染进入的项目，
   * 新建智能体落点随之取进入的项目（可为远程项目），不再按 workspacePath 反推。
   */
  newAgentProject?: VirtualProject | null;
}) {
  const { groups: organization, loading } = useProjectDirectory();
  const { intl } = useRobinRunIntl();
  const presentation = useContext(ProjectTaskListContext);
  const { robinrunTaskService: service, windowControllerService: controller } =
    useBaseWorkspaceServices();
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const composerClientNamespace = useComposerClientNamespace();
  const draftScope = readComposerWorkspaceScope(
    workspacePath,
    workspaceIdentity,
    composerClientNamespace,
  );
  const activeTaskId = useRobinRunSessionStore(
    (state) => state.workspaces[workspaceKey]?.activeTaskId ?? null,
  );
  // 空正文不再持久化；分组行订阅现有内存草稿，不能靠 localStorage 或手动重绘维持归属。
  const currentDraftGroupId = useRobinRunSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftTaskGroupId,
  );
  // 查看会话时仅显示尚未提交的文字草稿；首发已移除保存记录，不能复活旧的内存 placement。
  const draftGroupId = activeTaskId
    ? readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, draftScope)
        ?.taskGroupId
    : currentDraftGroupId;
  const [collapsed, setCollapsed] = useState(readGroupedTaskCollapsedGroupIds);
  const changeCollapsed = useCallback<Dispatch<SetStateAction<Set<string>>>>((update) => {
    setCollapsed((current) => (typeof update === "function" ? update(current) : update));
  }, []);
  useEffect(() => {
    persistGroupedTaskCollapsedGroupIds(collapsed);
  }, [collapsed]);
  const [newAgentSetupId, setNewAgentSetupId] = useState<string | null>(null);
  const [renamingTask, setRenamingTask] = useState<ProjectTask | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!renamingTask) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingTask]);
  const remoteState = useRemoteWorkspaceSessionStore(
    useShallow((state) => ({
      sessionsById: state.sessionsById,
      sessionIdByWorkspaceIdentity: state.sessionIdByWorkspaceIdentity,
      sessionIdByWorkspacePath: state.sessionIdByWorkspacePath,
    })),
  );
  const getTaskRemoteSessionId = useCallback(
    (task: ProjectTask) => {
      // 只解析既有 attachment；完整 identity 阻止同路径的另一远端串线。
      return (
        resolveRemoteWorkspaceSessionIdForTarget({
          ...task,
          state: remoteState,
        }) ?? undefined
      );
    },
    [remoteState],
  );
  const authoritativeView = useMemo(
    () => buildGroupedTaskView(tasks, organization.structure),
    [tasks, organization.structure],
  );
  const report = (error: unknown, messageId = "taskGroup.updateFailed") => {
    logger.error("[task-groups] 分组操作失败", error);
    toast(intl.formatMessage({ id: messageId }));
  };
  const action = (work: () => Promise<unknown>, messageId?: string) => {
    void work().catch((error) => report(error, messageId));
  };
  // 跨项目规则（产品裁决）：会话只能进入同项目的智能体或"未分组"伪组；
  // 智能体不能拖越项目文件夹。scope 缺席（未归类 workspace/系统组/伪组）按宽松处理。
  const taskProjectByTaskKey = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const task of tasks) map.set(taskGroupKey(task), task.projectId ?? null);
    return map;
  }, [tasks]);
  const move = async (command: MoveGroupNode) => {
    try {
      const scopeByGroup = new Map(
        organization.structure.groups.map((group) => [group.id, group.projectId]),
      );
      const agentScope = (groupId: string | null) =>
        groupId ? (scopeByGroup.get(groupId) ?? null) : null;
      if (command.node.type === "task") {
        const taskScope = taskProjectByTaskKey.get(taskGroupKey(command.node.task)) ?? null;
        const targetScope = agentScope(command.groupId);
        if (taskScope && targetScope && targetScope !== taskScope) {
          report(new Error("task-group.cross-project-task"), "taskGroup.crossProjectTask");
          return;
        }
      } else {
        const activeScope = agentScope(command.node.groupId);
        const anchorScope =
          command.anchor?.node.type === "group" ? agentScope(command.anchor.node.groupId) : null;
        if (activeScope && anchorScope && activeScope !== anchorScope) {
          report(new Error("task-group.cross-project-agent"), "taskGroup.crossProjectAgent");
          return;
        }
      }
      await organization.move(command);
    } catch (error) {
      report(error);
      await organization.refresh();
    }
  };
  const drag = useGroupedDrag({
    authoritativeView,
    collapsedGroupIds: collapsed,
    onCollapsedGroupIdsChange: changeCollapsed,
    onMove: move,
  });
  const layout = useMemo(
    () => buildAgentTreeLayout(drag.view, projects),
    [drag.view, projects],
  );
  const selectGroups = useShallow((nodes: typeof drag.view.nodes) =>
    nodes.flatMap((node) => (node.type === "group" ? [node.group] : [])),
  );
  const groups = selectGroups(drag.view.nodes);
  const allExpanded = groups.every((group) => !collapsed.has(group.id));
  const toggleCollapsed = (id: string) =>
    changeCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const createTask = (groupId: string | null) => {
    if (groupId === OFF_PEAK_DEFAULT_GROUP_ID) {
      onOpenAutomations?.();
      return;
    }
    if (groupId)
      changeCollapsed((current) => {
        const next = new Set(current);
        next.delete(groupId);
        return next;
      });
    onCreate(groupId);
  };
  const closeDraft = () => {
    clearV4ComposerDraftTaskGroup(workspacePath, workspaceIdentity, draftScope);
    useRobinRunSessionStore.getState().clearDraftTaskGroup(workspacePath, workspaceIdentity);
  };
  const mutate = async (task: ProjectTask, mutation: ProjectTaskMutation) => {
    const result = await mutateProjectTask(
      { service, controller },
      task,
      mutation,
      getTaskRemoteSessionId(task),
    );
    if (mutation.kind === "archive" && mutation.archived)
      useRobinRunSessionStore
        .getState()
        .removeTaskState(task.workspacePath, task.taskId, task.workspaceIdentity);
    await refresh();
    return result;
  };
  const moveTask = (task: ProjectTask, groupId?: string | null) => {
    const next =
      groupId === undefined
        ? moveTaskToTopByMenu(authoritativeView, task)
        : moveTaskByMenu(authoritativeView, task, groupId);
    const command = groupedMoveCommand(authoritativeView, next, {
      type: "task",
      task: groupTaskRef(task),
    });
    if (command) void move(command);
  };
  const updateColor = (id: string, color: TaskGroupColor) =>
    action(() => organization.save({ id, color }));
  const ungroup = (id: string) => action(() => organization.ungroup(id));
  const getWorkspaceLabel = (task: Pick<ProjectTask, "workspacePath" | "workspacePurpose">) =>
    task.workspacePurpose === "conversation"
      ? intl.formatMessage({ id: "workspaceSidebar.conversationsSection" })
      : task.workspacePath.split(/[\\/]/).filter(Boolean).at(-1) || task.workspacePath;
  const rowActions = {
    onSelectTask: (path: string, id: string, identity?: string) => {
      const task = findTaskInGroupedView(
        authoritativeView,
        taskKey({ workspacePath: path, taskId: id, workspaceIdentity: identity }),
      );
      onSelect(path, id, identity, task ? getTaskRemoteSessionId(task) : undefined, task?.unreadAt);
    },
    onCloseTask: (task: ProjectTask) =>
      action(() => mutate(task, { kind: "archive", archived: true }), "taskList.archiveFailed"),
    onArchiveTask: (task: ProjectTask) =>
      action(() => mutate(task, { kind: "archive", archived: true }), "taskList.archiveFailed"),
    onOpenFileTree: presentation.onOpenTaskFiles
      ? (task: ProjectTask) =>
          action(() => presentation.onOpenTaskFiles!(task, getTaskRemoteSessionId(task)))
      : undefined,
    onMoveTaskToGroup: (task: ProjectTask, id: string | null) => moveTask(task, id),
    onMoveTaskToTop: (task: ProjectTask) => moveTask(task),
    onStartRenameTask: (task: ProjectTask) => {
      setRenamingTask(task);
      setRenameDraft(task.title ?? "");
    },
    onMarkTaskAsUnread: (task: ProjectTask) =>
      action(() => mutate(task, { kind: "mark-unread" }), "taskList.markAsUnreadFailed"),
  };
  // Bug 根因：一条任务活动会重建整组行回调，击穿所有未变任务的 memo。
  // 行事件只转发到最近已提交的实现，既稳定引用，也不捕获过期的任务/分组和远端地址。
  const rowActionsRef = useRef(rowActions);
  useLayoutEffect(() => {
    rowActionsRef.current = rowActions;
  });
  const stableRowActions = useMemo(
    () => ({
      onSelectTask: (...args: Parameters<typeof rowActions.onSelectTask>) =>
        rowActionsRef.current.onSelectTask(...args),
      onCloseTask: (task: ProjectTask) => rowActionsRef.current.onCloseTask(task),
      onArchiveTask: (task: ProjectTask) => rowActionsRef.current.onArchiveTask(task),
      onOpenFileTree: (task: ProjectTask) => rowActionsRef.current.onOpenFileTree?.(task),
      onMoveTaskToGroup: (task: ProjectTask, id: string | null) =>
        rowActionsRef.current.onMoveTaskToGroup(task, id),
      onMoveTaskToTop: (task: ProjectTask) => rowActionsRef.current.onMoveTaskToTop(task),
      onStartRenameTask: (task: ProjectTask) => rowActionsRef.current.onStartRenameTask(task),
      onMarkTaskAsUnread: (task: ProjectTask) => rowActionsRef.current.onMarkTaskAsUnread(task),
    }),
    [],
  );
  const rowCallbacks = {
    ...stableRowActions,
    onOpenFileTree: presentation.onOpenTaskFiles ? stableRowActions.onOpenFileTree : undefined,
    groups,
    tooltipsDisabled: drag.dragging,
  };
  // Bug 根因：首发接纳改变全局 activeTaskId，传到每行会连未选中行的外层一起刷新。
  // 在列表装配时派生行自身选中状态，保持整条无关行的 memo 输入不变。
  const rowSelection = (task: ProjectTask) => {
    const key = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
    return {
      isActive:
        buildTaskWorkspaceKey(workspacePath, workspaceIdentity) === key &&
        activeTaskId === task.taskId,
      isMobileActive: presentation.mobileActiveTaskKey === `${key}:${task.taskId}`,
    };
  };
  const [stickyId, setStickyId] = useState<string | null>(null);
  useEffect(() => {
    const root = drag.root.current;
    if (!root || drag.dragging) {
      setStickyId(null);
      return;
    }
    // 展开动画首帧尚无 overflow，不能因此漏订阅后续滚动；当前滚动 owner 由侧栏直接提供。
    const scroll = scrollRef.current;
    if (!scroll) {
      setStickyId(null);
      return;
    }
    let frame: number | null = null;
    const update = () => {
      frame = null;
      setStickyId(resolveStickyGroupedTaskGroupId(root));
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(update);
    };
    update();
    scroll.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      scroll.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, [scrollRef, drag.root, drag.dragging, drag.view.nodes, collapsed, newAgentSetupId]);
  const sticky = drag.view.nodes.find(
    (node) => node.type === "group" && node.group.id === stickyId,
  );
  const activeTask = drag.activeTaskKey
    ? findTaskInGroupedView(drag.view, drag.activeTaskKey)
    : null;
  const activeGroup = drag.view.nodes.find(
    (node) => node.type === "group" && node.group.id === drag.activeGroupId,
  );
  const overlayStyle = drag.width ? { width: `${drag.width}px` } : undefined;
  const toggleLabel = intl.formatMessage({
    id: allExpanded ? "taskGroup.collapseAll" : "taskGroup.expandAll",
  });
  // 新建智能体落点：智能体页（项目列表导航）显式指定进入的项目；树模式（导航未启用）
  // 仍按当前工作区所属项目反推，找不到时禁用，避免造出无主智能体。
  const activeProject = useMemo(
    () =>
      newAgentProject ??
      projects.find(
        (project) =>
          project.hostId === "local" &&
          project.roots.some((root) => root.rootPath === workspacePath),
      ) ??
      null,
    [newAgentProject, projects, workspacePath],
  );
  const createAgent = () => {
    if (!activeProject) return;
    action(async () => {
      const group = await organization.save({
        title: intl.formatMessage({ id: "taskGroup.defaultTitle" }),
        projectId: activeProject.id,
      });
      setNewAgentSetupId(group.id);
    }, "taskGroup.createFailed");
  };
  // 项目行拖拽（type=grouped-project，ProjectNode 的 sortable data）路由到项目排序；
  // 其余（智能体/会话）交回既有手势收口，提交单节点移动命令。
  const handleDragEnd = (event: DragEndEvent) => {
    if (getGroupedTaskDragType(event.active.data.current) === "grouped-project") {
      const overId = event.over?.id;
      if (overId && event.active.id !== overId)
        onReorderProjects(String(event.active.id), String(overId));
      return;
    }
    drag.dnd.onDragEnd(event);
  };
  const renderAgent = (agent: AgentGroupNode) => (
    <div key={agent.group.id} data-grouped-layout-key={`group:${agent.group.id}`}>
      <GroupItem
        {...rowCallbacks}
        activeWorkspacePath={workspacePath}
        activeWorkspaceIdentity={workspaceIdentity}
        activeTaskId={activeTaskId}
        mobileActiveTaskKey={presentation.mobileActiveTaskKey}
        node={agent}
        getTaskRemoteSessionId={getTaskRemoteSessionId}
        getTaskWorkspaceLabel={getWorkspaceLabel}
        onCreateTask={() => createTask(agent.group.id)}
        hasDraftTask={draftGroupId === agent.group.id}
        draftTaskActive={!activeTaskId}
        draftWorkspaceLabel={getWorkspaceLabel({ workspacePath })}
        onSelectDraftTask={() => createTask(agent.group.id)}
        onCloseDraftTask={closeDraft}
        onRenameGroup={(id, title) =>
          action(() => organization.save({ id, title }), "taskGroup.renameFailed")
        }
        onUpdateGroupColor={updateColor}
        onUngroupGroup={ungroup}
        newGroupSetup={newAgentSetupId === agent.group.id}
        onNewGroupSetupStarted={(id) =>
          setNewAgentSetupId((current) => (current === id ? null : current))
        }
        collapsed={collapsed.has(agent.group.id)}
        onToggleCollapsed={toggleCollapsed}
        activeDragTaskKey={drag.activeTaskKey}
        activeDragGroupId={drag.activeGroupId}
        tooltipsDisabled={drag.dragging}
      />
    </div>
  );
  // 智能体容器已不带纵向间距（TASK_GROUP_CONTAINER_CLASS 去除 pt-2.5），列表首尾与
  // 组间都贴紧项目行；缩进保留 pl-2 表达从属关系。
  const renderAgentList = (agents: AgentGroupNode[]): ReactNode =>
    agents.length > 0 ? <div className="pl-2">{agents.map(renderAgent)}</div> : null;
  const emptyAgents =
    layout.sections.length === 0 && layout.unbound.length === 0 && !loading;
  return (
    <>
      {toolbarTarget &&
        createPortal(
          <>
            <ControlHintTooltip title={toggleLabel}>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-foreground-subtle hover:text-foreground"
                aria-label={toggleLabel}
                data-testid="task-group-toggle-all"
                disabled={!groups.length}
                onClick={() =>
                  changeCollapsed(
                    allExpanded ? new Set(groups.map((group) => group.id)) : new Set(),
                  )
                }
              >
                {allExpanded ? (
                  <Minimize2 className="size-3.5" />
                ) : (
                  <Maximize2 className="size-3.5" />
                )}
              </Button>
            </ControlHintTooltip>
            {onAddProject ? (
              <ControlHintTooltip title={intl.formatMessage({ id: "project.new" })}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-foreground-subtle hover:text-foreground"
                  data-testid="agent-tree-add-project"
                  aria-label={intl.formatMessage({ id: "project.new" })}
                  onClick={onAddProject}
                >
                  <FolderPlus className="size-3.5" />
                </Button>
              </ControlHintTooltip>
            ) : null}
            <ControlHintTooltip title={intl.formatMessage({ id: "taskGroup.newGroup" })}>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-foreground-subtle hover:text-foreground"
                data-testid="task-group-add"
                aria-label={intl.formatMessage({ id: "taskGroup.newGroup" })}
                disabled={!organization.available || !activeProject}
                onClick={createAgent}
              >
                <Hash className="size-3.5" />
              </Button>
            </ControlHintTooltip>
          </>,
          toolbarTarget,
        )}
      {stickyTarget &&
        createPortal(
          <StickyGroupHeaderSlot
            header={
              sticky?.type === "group" ? (
                <StickyGroupHeader
                  node={sticky}
                  collapsed={collapsed.has(sticky.group.id)}
                  tooltipsDisabled={drag.dragging}
                  onCreateTask={() => createTask(sticky.group.id)}
                  onToggleCollapsed={toggleCollapsed}
                  onUpdateGroupColor={updateColor}
                  onUngroupGroup={ungroup}
                />
              ) : null
            }
          />,
          stickyTarget,
        )}
      <TaskRenameDialog
        open={renamingTask !== null}
        value={renameDraft}
        inputRef={renameInputRef}
        intl={intl}
        onOpenChange={(open) => {
          if (!open) setRenamingTask(null);
        }}
        onChange={setRenameDraft}
        onCancel={() => setRenamingTask(null)}
        onConfirm={() =>
          action(async () => {
            if (!renamingTask) return;
            await mutate(renamingTask, { kind: "rename", title: renameDraft.trim() });
            setRenamingTask(null);
          }, "taskList.renameFailed")
        }
      />
      {/* 单一 DndContext 承载三类拖拽（项目行/智能体/会话），碰撞检测按 active.data.type 分流；
          项目行是独立的 SortableContext（verticalListSortingStrategy），智能体/会话沿用既有手势。
          不嵌套第二个 DndContext：嵌套时文件夹内的 GroupItem 会绑到最近的项目排序上下文而失效。 */}
      <DndContext {...drag.dnd} onDragEnd={handleDragEnd}>
        <div ref={drag.root} className="px-2 pb-4" data-testid="task-grouped-view">
          {/* 一级：项目文件夹（复用项目视图的行组件与排序）；二级：文件夹内的智能体。 */}
          <SortableContext
            items={layout.sections.map((section) => projectKey(section.project))}
            strategy={verticalListSortingStrategy}
          >
            {layout.sections.map((section) =>
              renderProject(section.project, renderAgentList(section.agents)),
            )}
          </SortableContext>
          {/* 未绑定项目/系统全局的智能体（cron、闲时、旧数据）。 */}
          {layout.unbound.length > 0 ? (
            <div className="mt-3">{layout.unbound.map(renderAgent)}</div>
          ) : null}
          {/* 固定"未分组"伪组：收纳未归属任何智能体的会话，永远在最末。 */}
          {layout.ungrouped && layout.ungrouped.tasks.length > 0
            ? renderAgent(layout.ungrouped)
            : null}
          {emptyAgents ? (
            <div className="px-3 py-2 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "taskGroup.noGroups" })}
            </div>
          ) : null}
          {organization.error && (
            <p role="alert" className="px-3 text-ui-sm text-destructive">
              {organization.error}
            </p>
          )}
        </div>
        {createPortal(
          <DragOverlay dropAnimation={GROUPED_TASK_DROP_ANIMATION}>
            {activeTask ? (
              <div
                className="transition-[width,max-width] duration-150 ease-out motion-reduce:transition-none"
                style={overlayStyle}
              >
                <GroupedTaskItem
                  {...rowCallbacks}
                  {...rowSelection(activeTask)}
                  task={activeTask}
                  remoteSessionId={getTaskRemoteSessionId(activeTask)}
                  workspaceLabel={getWorkspaceLabel(activeTask)}
                  dragId={drag.activeTaskKey ?? undefined}
                  dragOverlay
                />
              </div>
            ) : activeGroup?.type === "group" ? (
              <GroupDragOverlay
                node={activeGroup}
                style={overlayStyle}
                className="transition-[width,max-width] duration-150 ease-out motion-reduce:transition-none"
              />
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
    </>
  );
}
