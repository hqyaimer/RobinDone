import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
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
import { FolderPlus, Maximize2, Minimize2 } from "lucide-react";
import {
  OFF_PEAK_DEFAULT_GROUP_ID,
  isMainAgentGroupId,
  isWorkerGroupId,
  workerGroupId,
  workerIdFromWorkerGroupId,
} from "@robindone/shared";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { TaskRenameDialog } from "@/TaskRenameDialog.js";
import { useProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";
import type {
  ProjectTask,
  ProjectSidebarProps,
  MoveGroupNode,
  SidebarFileTreeTarget,
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
import { AgentTriggerSection } from "@/project-sidebar/grouped/agent-trigger-section.js";
import type { TriggerStatusAction } from "@/project-sidebar/grouped/agent-trigger-section.js";
import { useTriggerEntryActions } from "@/project-sidebar/grouped/useTriggerEntryActions.js";
import {
  groupTriggerEntriesByOwner,
  TRIGGER_MASTER_OWNER_ID,
  useTriggerSnapshots,
} from "@/project-sidebar/useTriggerSnapshots.js";
import { GroupedTaskItem } from "@/project-sidebar/grouped/task-item.js";
import { useWorkers } from "@/project-sidebar/useWorkers.js";
import { GroupDragOverlay } from "@/project-sidebar/grouped/group-drag-overlay.js";
import { StickyGroupHeader } from "@/project-sidebar/grouped/sticky-group-header.js";
import { StickyGroupHeaderSlot } from "@/project-sidebar/grouped/sticky-group-header-slot.js";
import { useGroupedDrag } from "@/project-sidebar/grouped/useGroupedDrag.js";
import {
  GROUPED_TASK_DROP_ANIMATION,
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
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { resolveRemoteWorkspaceSessionIdForTarget } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useRobinDoneSessionStore } from "@/store/robindoneSessionStore.js";
import { useRobinDoneIntl } from "@/i18n/IntlProvider.js";
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
  enteredProject = null,
  onOpenWorkerFolder,
  workspaceRemoteSessionId,
}: {
  tasks: ProjectTask[];
  onSelect: ProjectSidebarProps["onSelectTask"];
  refresh(): Promise<void>;
  // projectId/hostId 由组归属解析后回传（智能体行"+"新建时预选项目和该智能体；hostId 仅远程项目需要）。
  onCreate(groupId: string | null, projectId?: string | null, hostId?: string): void;
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
   * 智能体页进入的项目（2026-11-15 数据范围裁决）：驱动 worker 名册读取与会话组织组
   * 物化（2026-11-16：active worker 各物化为 robindone-worker-<workerId> 任务组），并把
   * 页面收敛到本项目——其他项目（含已软删除项目）的智能体与会话不进本页。
   * null（树模式/web 远控回退）= 全量渲染、不读名册。worker 身份仍只读：新建/改名/
   * 停用全部由主智能体经 ManageWorkers 维护，UI 只做组投影同步（标题随注册表）。
   */
  enteredProject?: VirtualProject | null;
  /** worker 组的"查看文件"入口：打开该 worker 的 `.robindone/agents/<id>/` 工作目录。 */
  onOpenWorkerFolder?: (target: SidebarFileTreeTarget) => void;
  /** 当前工作区的远程会话 id（远程项目文件树服务解析需要；本地为 undefined）。 */
  workspaceRemoteSessionId?: string;
}) {
  const { groups: organization, loading } = useProjectDirectory();
  const { intl } = useRobinDoneIntl();
  const presentation = useContext(ProjectTaskListContext);
  const { robindoneTaskService: service, windowControllerService: controller } =
    useBaseWorkspaceServices();
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const activeTaskId = useRobinDoneSessionStore(
    (state) => state.workspaces[workspaceKey]?.activeTaskId ?? null,
  );
  const [collapsed, setCollapsed] = useState(readGroupedTaskCollapsedGroupIds);
  const changeCollapsed = useCallback<Dispatch<SetStateAction<Set<string>>>>((update) => {
    setCollapsed((current) => (typeof update === "function" ? update(current) : update));
  }, []);
  useEffect(() => {
    persistGroupedTaskCollapsedGroupIds(collapsed);
  }, [collapsed]);
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
  // 智能体页按项目收敛（2026-11-15 数据范围裁决）：会话只显示进入项目的——projectId
  // 归属本项目，或未归属但 cwd 在项目目录内（未归属会话保持可见；新会话 projectId
  // 回填前的首帧也靠 cwd 兜住）。已删除项目的会话随项目隐藏，撤销删除后回到其页面。
  const scopedTasks = useMemo(() => {
    if (!enteredProject) return tasks;
    const roots = new Set(enteredProject.roots.map((root) => root.rootPath));
    return tasks.filter(
      (task) =>
        task.projectId === enteredProject.id || (!task.projectId && roots.has(task.workspacePath)),
    );
  }, [tasks, enteredProject]);
  // 触发器运行时快照（2026-11-19 UI 裁决）：整页共享一份（广播 + 30s 轮询刷新），
  // 按订阅者归组后投影到各智能体节点的"触发器"文件夹。引擎服务缺席时为空快照，
  // 所有文件夹自动隐藏（后端装配里程碑接通后点亮）。提前声明（2026-11-25 分发器
  // 裁决的绑定会话值集在上方 authoritativeView 投影里消费）。
  const triggers = useTriggerSnapshots(workspacePath);
  // 触发器绑定会话值集（2026-11-25 分发器裁决）：侧栏过滤收窄的依据——只有绑定会话
  // 由触发器文件夹独占承载（隐藏），dispatcher/fixed 的处理会话不写绑定表，回归
  // 订阅者名下的会话列表（快照 30s 轮询，绑定表落后时按旧全量隐藏 fail-safe）。
  const triggerBoundTaskIds = useMemo(
    () => new Set(Object.values(triggers.snapshot.sessionBindings)),
    [triggers.snapshot.sessionBindings],
  );
  const authoritativeView = useMemo(
    () => buildGroupedTaskView(scopedTasks, organization.structure, triggerBoundTaskIds),
    [scopedTasks, organization.structure, triggerBoundTaskIds],
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
  // worker 名册投影提前到布局计算之前（2026-11-17 停用即隐藏裁决需要它参与 layout）。
  const workersRootPath = enteredProject?.roots[0]?.rootPath ?? null;
  const { workers } = useWorkers(workersRootPath);
  const layout = useMemo(() => {
    // 停用即隐藏（2026-11-17 裁决）：worker 组是编制投影，只显示 active worker 的组；
    // workers（useWorkers）已按 status 过滤，停用 worker 的组连同其历史会话整段隐藏。
    const activeWorkerGroupIds = new Set(workers.map((worker) => workerGroupId(worker.id)));
    return buildAgentTreeLayout(drag.view, projects, enteredProject, { activeWorkerGroupIds });
  }, [drag.view, projects, enteredProject, workers]);
  const triggerEntriesByOwner = useMemo(
    () => groupTriggerEntriesByOwner(triggers.snapshot),
    [triggers.snapshot],
  );
  const handleTriggerStatusAction = (statusAction: TriggerStatusAction) =>
    action(async () => {
      // 组条目按成员各自状态批量作用（见 groupTriggerEntriesByOwner 的 memberStatuses）。
      for (const triggerId of statusAction.triggerIds)
        await triggers.setTriggerStatus(triggerId, statusAction.status);
    }, "triggerSidebar.setStatusFailed");
  const confirmDialog = useConfirmDialog();
  // 本地 webhook 地址复制（引擎快照的 webhookBaseUrl；完整地址 = base/path?token）。
  const handleTriggerWebhookCopy = (url: string) => {
    void navigator.clipboard
      ?.writeText(url)
      .then(() => toast(intl.formatMessage({ id: "triggerSidebar.webhookUrlCopied" })))
      .catch((error: unknown) => {
        logger.error("[triggers] 复制 webhook 地址失败", error);
        toast(intl.formatMessage({ id: "triggerSidebar.webhookUrlCopyFailed" }));
      });
  };
  const selectGroups = useShallow((nodes: typeof drag.view.nodes) =>
    nodes.flatMap((node) => (node.type === "group" ? [node.group] : [])),
  );
  const groups = selectGroups(drag.view.nodes);
  // 清空会话 + 伪删除（2026-11-21 提取至 useTriggerEntryActions，文件行数上限拆分）：
  // 两者共用"命中当前打开会话 → 关闭失效视图、切订阅者草稿态"的收口（依赖 groups）。
  const { handleTriggerSessionReset, handleTriggerDelete } = useTriggerEntryActions({
    confirm: confirmDialog,
    action,
    triggers,
    activeTaskId,
    enteredProjectId: enteredProject?.id,
    groups,
    projects,
    onCreate,
  });
  const allExpanded = groups.every((group) => !collapsed.has(group.id));
  // 会话菜单"移到智能体"的目标与本页渲染一致（2026-11-15 数据范围裁决）：智能体页只列
  // 本页可见的智能体与未分组伪组；树模式（enteredProject=null）保持平面全量。
  const menuGroups = useMemo(() => {
    if (!enteredProject) return groups;
    return [
      ...layout.sections.flatMap((section) => section.agents),
      ...layout.unbound,
      ...(layout.ungrouped ? [layout.ungrouped] : []),
    ].map((node) => node.group);
  }, [enteredProject, layout, groups]);
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
    // 智能体行"+"新建（2026-11-16 验收修复）：显式带上智能体所属项目，composer 草稿
    // 预选"该项目 + 该智能体"。不传 projectId 时 onCreateTask 会显式清空项目（hasExplicitProject），
    // 项目与智能体选择器双双落空；未绑定项目/系统组维持旧的未归属行为。hostId 仅远程项目需要。
    const ownerProject = groupId
      ? (groups.find((group) => group.id === groupId)?.projectId ?? null)
      : null;
    const owner = ownerProject
      ? projects.find((project) => project.id === ownerProject)
      : undefined;
    onCreate(groupId, ownerProject, owner && owner.hostId !== "local" ? owner.hostId : undefined);
  };
  const mutate = async (task: ProjectTask, mutation: ProjectTaskMutation) => {
    const result = await mutateProjectTask(
      { service, controller },
      task,
      mutation,
      getTaskRemoteSessionId(task),
    );
    if (mutation.kind === "archive" && mutation.archived)
      useRobinDoneSessionStore
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
    groups: menuGroups,
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
  }, [scrollRef, drag.root, drag.dragging, drag.view.nodes, collapsed]);
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
  // worker 名册 → 会话组织组物化（2026-11-16 裁决）：active worker 各拥有确定性任务组
  // （robindone-worker-<workerId>），经既有任务组管线渲染——worker 与主智能体平级、可展开、
  // 会话可访问可继续，composer 智能体下拉也自动纳入。组行只是投影：workers.json 仍是
  // 身份事实源，标题随名册同步（注册表赢），颜色/顺序存组行（用户可改，禁止改名/解散）。
  // structure 已有同 id 且标题一致的组时跳过写，防止 ensure→广播→refresh 的写放大回环。
  // （workersRootPath/workers 声明已上移到 layout 计算之前，见 2026-11-17 停用即隐藏裁决。）
  useEffect(() => {
    if (!enteredProject || workers.length === 0) return;
    const existing = new Map(organization.structure.groups.map((group) => [group.id, group.title]));
    for (const worker of workers) {
      if (existing.get(workerGroupId(worker.id)) === worker.name) continue;
      organization
        .ensureWorkerGroup({
          projectId: enteredProject.id,
          workerId: worker.id,
          title: worker.name,
        })
        // Error 对象直接序列化是 {}，转成字符串才能在日志里看到（如 host 未重启时的
        // "Method not found: ensureWorkerGroup"）。
        .catch((cause) =>
          logger.warn("[workers] worker 会话组织组同步失败", { error: String(cause) }),
        );
    }
  }, [enteredProject, workers, organization]);
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
  const renderAgent = (agent: AgentGroupNode) => {
    // 触发器文件夹归属（2026-11-19 UI 裁决）：主智能体组 = ownerAgentId "master" 的触发器
    // （及订阅组），worker 组 = ownerAgentId 为该 wkr-id 的触发器；其余组（系统组/未分组/
    // 用户组）不承载订阅，无文件夹。无订阅条目的智能体不显示文件夹。
    const triggerOwnerId = isMainAgentGroupId(agent.group.id)
      ? TRIGGER_MASTER_OWNER_ID
      : isWorkerGroupId(agent.group.id)
        ? workerIdFromWorkerGroupId(agent.group.id)
        : null;
    const triggerEntries = triggerOwnerId ? triggerEntriesByOwner.get(triggerOwnerId) : undefined;
    return (
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
          onRenameGroup={(id, title) =>
            action(() => organization.save({ id, title }), "taskGroup.renameFailed")
          }
          onUpdateGroupColor={updateColor}
          onUngroupGroup={ungroup}
          collapsed={collapsed.has(agent.group.id)}
          onToggleCollapsed={toggleCollapsed}
          activeDragTaskKey={drag.activeTaskKey}
          activeDragGroupId={drag.activeGroupId}
          tooltipsDisabled={drag.dragging}
          // worker 组才有自己的工作目录（.robindone/agents/<id>/）；主智能体与用户组不提供该入口。
          onOpenFolder={
            isWorkerGroupId(agent.group.id) && onOpenWorkerFolder && workersRootPath
              ? () => {
                  // 分隔符跟随项目根本身（Windows 反斜杠/POSIX 斜杠），保证 revealPath
                  // 与文件树行路径、祖先目录推导用同一形状，避免混合分隔符展开失败。
                  const base = workersRootPath.replace(/[\\/]+$/, "");
                  const separator = base.includes("\\") ? "\\" : "/";
                  const folder = `${base}${separator}.robindone${separator}agents${separator}${workerIdFromWorkerGroupId(agent.group.id)}`;
                  // Bug 原因：曾把 worker 目录本身当作 workspacePath 传给文件面板入口，
                  // handleOpenFileManager 按"目标工作区 ≠ 当前工作区"走跨工作区分支
                  // （requestFileManager → addTab 激活新 workspace tab），当前会话被
                  // 切走（中间回到未发起会话），随后草稿 owner 变更又把刚开的文件面板
                  // scope 判空收起（弹出几秒后自动消失）。正确语义与 markdown 文件链
                  // 的 reveal 一致：workspacePath 保持项目根（identity 同当前工作区，
                  // 本地即命中就地打开分支），worker 目录经 revealPath 定位展开。
                  onOpenWorkerFolder({
                    workspacePath: workersRootPath,
                    workspaceName: enteredProject?.name ?? agent.group.title,
                    ...(workspaceIdentity ? { workspaceIdentity } : {}),
                    ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
                    revealPath: folder,
                  });
                }
              : undefined
          }
          triggerSection={
            triggerEntries && triggerEntries.length > 0 ? (
              <AgentTriggerSection
                ownerId={triggerOwnerId ?? ""}
                entries={triggerEntries}
                sessionBindings={triggers.snapshot.sessionBindings}
                workspacePath={workspacePath}
                workspaceIdentity={workspaceIdentity}
                activeTaskId={activeTaskId}
                tooltipsDisabled={drag.dragging}
                // 与会话行同一导航链路（rowActions.onSelectTask → onSelect），绑定 taskId
                // 缺失（尚未触发）时条目本身不可点击，不会走到这里。
                onSelectTask={(path, taskId, identity) =>
                  stableRowActions.onSelectTask(path, taskId, identity)
                }
                onStatusAction={handleTriggerStatusAction}
                onResetSession={handleTriggerSessionReset}
                onDeleteTrigger={handleTriggerDelete}
                webhookBaseUrl={triggers.snapshot.webhookBaseUrl}
                onCopyWebhookUrl={handleTriggerWebhookCopy}
              />
            ) : null
          }
        />
      </div>
    );
  };
  // 智能体容器已不带纵向间距（TASK_GROUP_CONTAINER_CLASS 去除 pt-2.5），列表首尾与
  // 组间贴紧；树模式缩进 pl-2 表达对项目行的从属，智能体页（项目行已移除）一级平铺。
  const renderAgentList = (agents: AgentGroupNode[]): ReactNode =>
    agents.length > 0 ? (
      <div className={enteredProject ? undefined : "pl-2"}>{agents.map(renderAgent)}</div>
    ) : null;
  const emptyAgents = layout.sections.length === 0 && layout.unbound.length === 0 && !loading;
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
          {/* 一级：树模式=项目文件夹（复用项目视图的行组件与排序）+ 文件夹内智能体；
              智能体页（2026-11-15 裁决）：项目文件夹行移除，一级直接展示智能体，
              项目操作上移到列表头。 */}
          <SortableContext
            items={layout.sections.map((section) => projectKey(section.project))}
            strategy={verticalListSortingStrategy}
          >
            {layout.sections.map((section) => {
              // worker 组已物化为任务组，随 section.agents 一起渲染（主智能体置顶、
              // worker 组次之、用户组殿后），不再有独立的 worker 行区块。
              const agents = <>{renderAgentList(section.agents)}</>;
              return enteredProject ? (
                <div key={projectKey(section.project)}>{agents}</div>
              ) : (
                renderProject(section.project, agents)
              );
            })}
          </SortableContext>
          {/* 未绑定项目/系统全局的智能体（cron、闲时、旧数据）；进入项目的智能体页里
              绑定其他项目（含已删除项目）的组已由 buildAgentTreeLayout 按 scope 收敛掉。 */}
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
