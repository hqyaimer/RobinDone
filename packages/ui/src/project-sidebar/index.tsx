import { SidebarTooltipProvider } from "@/ControlHintTooltip.js";
export { ArchiveManagement } from "@/project-sidebar/ArchiveManagement.js";
export { useWebRemoteControlRendererActions } from "@/project-sidebar/useWebRemoteControlRendererActions.js";
export { ProjectManagement } from "@/project-sidebar/ProjectManagement.js";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import { TID_SIDEBAR } from "@robindone/shared/test-ids";
import { remoteHostIdFromWorkspaceIdentity } from "@/project-sidebar/contract.js";
import type {
  ProjectSidebarProps,
  ProjectTask,
  VirtualProject,
  Locale,
  Theme,
  RemoteProjectHost,
} from "@/project-sidebar/contract.js";
import { useProjectPinIntent } from "@/project-sidebar/useProjectPinIntent.js";
import { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";
import { useWebRemoteControlStatus } from "@/hooks/useWebRemoteControlStatus.js";
import { useProjectRemoteSync } from "@/project-sidebar/useProjectRemoteSync.js";
import { useProjectConnectionDiagnostics } from "@/project-sidebar/useProjectConnectionDiagnostics.js";
import { useWebRemoteControlFeatureEnabled } from "@/WebRemoteControlFeatureProvider.js";
import { useProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
export {
  ProjectDirectoryProvider,
  useOptionalProjectDirectory,
  useOptionalProjectDirectoryActions,
} from "@/project-sidebar/ProjectDirectoryProvider.js";
export { ProjectComposerMenu } from "@/project-sidebar/ProjectComposerMenu.js";
import { useProjectTaskNavigation } from "@/project-sidebar/useProjectTaskNavigation.js";
import { useProjectFileTree } from "@/project-sidebar/useProjectFileTree.js";
import {
  selectSortedProjects,
  projectKey,
  projectHasUnread,
  projectSourceServerId,
} from "@/project-sidebar/view.js";
import { TaskGroupedView } from "@/project-sidebar/TaskGroupedView.js";
import { ProjectList } from "@/project-sidebar/ProjectList.js";
import { taskGroupKey } from "@/project-sidebar/grouped-view.js";
import {
  ProjectHeaderActions,
  ProjectSidebarNode,
  runProjectAction as action,
} from "@/project-sidebar/ProjectSidebarNode.js";
import { ProjectCreation } from "@/project-sidebar/ProjectCreation.js";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import { RemoteProjectPicker } from "@/project-sidebar/RemoteProjectPicker.js";
import { ProjectSidebarListHeader } from "@/project-sidebar/ProjectSidebarListHeader.js";
import { ProjectSidebarNavigation } from "@/project-sidebar/ProjectSidebarNavigation.js";
import { HomeOnlyWorkspaceRows } from "@/project-sidebar/HomeOnlyWorkspaceRows.js";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import { SidebarBottomActivity } from "@/sidebar-activity/SidebarBottomActivity.js";
import { useRobinDoneIntl } from "@/i18n/IntlProvider.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useRobinDoneSessionStore } from "@/store/robindoneSessionStore.js";
import { useRobinDoneStore } from "@/store/StoreProvider.js";
// RobinDone(2026-11-22): [hide-upstream-account] 隐藏「侧栏升级入口」——Root 已摘除 CodingPlanUpgradeDialogProvider，
// 非可选 hook 无 Provider 会 throw，恢复时随 Root Provider 一并取消注释
// import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
// RobinDone(2026-11-22): [hide-upstream-account] 隐藏结束
export { attachRemoteProjectWorkspace } from "@/project-sidebar/remote-navigation.js";
export { resolveEntryProject } from "@/project-sidebar/view.js";
export type {
  SidebarFileTreeOpenRequest,
  ProjectSidebarProps,
} from "@/project-sidebar/contract.js";

// 项目文件夹行在智能体树中不再平铺项目会话（children 插槽渲染智能体列表）；行组件仍要求 tasks prop。
const NO_PROJECT_TASKS: ProjectTask[] = [];

// 右侧面板显隐曾让所有项目的菜单和 Tooltip 重渲染；只隔离无关父更新，保留目录/context 订阅。
export const ProjectSidebar = memo(function ProjectSidebar(props: ProjectSidebarProps) {
  const {
    tree: authoritativeTree,
    directory,
    service,
    remoteService,
    availability,
    hostReadErrors,
    refresh,
    error,
    loading,
    preferences,
    groups,
    deviceNames,
  } = useProjectDirectory();
  const { tree, pin } = useProjectPinIntent(authoritativeTree);
  const remoteSync = useProjectRemoteSync(directory);
  const diagnostics = useProjectConnectionDiagnostics(directory, props, hostReadErrors);
  const onSelectTask = useProjectTaskNavigation(props, tree, remoteService);
  const { intl, localePreference, setLocalePreference } = useRobinDoneIntl();
  const tabStore = useTabStoreApi();
  const setTheme = useRobinDoneStore((state) => state.setTheme);
  // RobinDone(2026-11-22): [hide-upstream-account] 隐藏「侧栏升级 hook」——恢复时取消本行注释
  // const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  // RobinDone(2026-11-22): [hide-upstream-account] 隐藏结束
  const scrollRef = useRef<HTMLDivElement>(null);
  const [groupedToolbar, setGroupedToolbar] = useState<HTMLDivElement | null>(null);
  const [groupedSticky, setGroupedSticky] = useState<HTMLDivElement | null>(null);
  const [editor, setEditor] = useState<{ project: VirtualProject | null } | null>(null);
  const [creating, setCreating] = useState(false);
  // 当前任务只影响远端“创建项目”的默认设备；分组继承在点击时读，
  // 避免本地会话/草稿切换让全部项目的菜单与 Tooltip 重渲染。
  const hasActiveRemoteTask = useRobinDoneSessionStore((state) =>
    Boolean(
      props.workspaceIdentity &&
      state.workspaces[props.workspaceIdentity.trim() || props.workspacePath]?.activeTaskId,
    ),
  );
  const [remotePicker, setRemotePicker] = useState<RemoteProjectHost | null>(null);
  const { openFiles, openTaskFiles } = useProjectFileTree(props, directory, remoteService);
  const remoteControlEnabled = useWebRemoteControlFeatureEnabled();
  const mobileStatus = useWebRemoteControlStatus({
    enabled: Boolean(props.isDesktop && remoteControlEnabled),
  });
  const mobileView = mobileStatus.mobileConnected ? mobileStatus.mobileViewState : null;
  const mobileActiveTaskKey =
    mobileView?.activeWorkspaceKey && mobileView.activeTaskId
      ? `${mobileView.activeWorkspaceKey}:${mobileView.activeTaskId}`
      : null;
  const taskPresentation = useMemo(
    () => ({
      isWebRemoteControl: props.isWebRemoteControl,
      activeWorkspaceKey: props.workspaceIdentity?.trim() || props.workspacePath,
      mobileActiveTaskKey,
      onPin: pin,
      onOpenTaskFiles: openTaskFiles,
    }),
    [
      props.isWebRemoteControl,
      props.workspacePath,
      props.workspaceIdentity,
      mobileActiveTaskKey,
      pin,
      openTaskFiles,
    ],
  );
  const start = async (projectId?: string, hostId?: string, taskGroupId?: string | null) => {
    const workspaceState = useRobinDoneSessionStore
      .getState()
      .getWorkspaceState(props.workspacePath, props.workspaceIdentity);
    // 侧栏已固定为智能体列表：未显式指定归属时继承活动任务的智能体，否则继承草稿意图。
    const inheritedGroup = !projectId
      ? workspaceState.activeTaskId
        ? (groups.parents.get(
            taskGroupKey({
              taskId: workspaceState.activeTaskId,
              workspacePath: props.workspacePath,
              workspaceIdentity: props.workspaceIdentity,
            }),
          ) ?? null)
        : (workspaceState.draftTaskGroupId ?? null)
      : null;
    props.onCreateTask({
      projectId: projectId ?? null,
      taskGroupId: taskGroupId === undefined ? inheritedGroup : taskGroupId,
      ...(hostId ? { hostId } : {}),
    });
  };
  // 智能体树不再有独立置顶区；置顶项目以稳定排序浮到最前（reorder 守卫仍限制同层内移动）。
  const projects = useMemo(() => {
    const sorted = preferences.sort(selectSortedProjects(tree));
    return [...sorted].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  }, [preferences, tree]);
  const reorder = (active: string, over: string) => {
    const source = projects.find((item) => projectKey(item) === active);
    const target = projects.find((item) => projectKey(item) === over);
    if (!source || !target || source.pinned !== target.pinned) return;
    preferences.reorder(
      projects.filter((item) => item.pinned === source.pinned),
      active,
      over,
    );
  };
  // RobinDone 项目列表导航（2026-11-15 裁决）：桌面端侧栏一级平铺所有项目（不显示智能体
  // 和会话），点击项目进入该项目的智能体页；返回按钮回到项目列表。导航未启用（web 远控）
  // 保持 P2 的“所有项目一棵树”渲染。null = 项目列表页。
  const navigationEnabled = props.isDesktop === true && Boolean(props.onOpenProject);
  const [enteredProjectKey, setEnteredProjectKey] = useState<string | null>(null);
  const enteredProject = useMemo(
    () =>
      enteredProjectKey
        ? (projects.find((project) => projectKey(project) === enteredProjectKey) ?? null)
        : null,
    [enteredProjectKey, projects],
  );
  useEffect(() => {
    // 进入的项目被删除/不再可见：回落项目列表页。
    if (enteredProjectKey !== null && enteredProject === null) {
      setEnteredProjectKey(null);
    }
  }, [enteredProject, enteredProjectKey]);
  const enteredProjectKeyRef = useRef<string | null>(null);
  enteredProjectKeyRef.current = enteredProjectKey;
  const activeProjectKey = useMemo(() => {
    if (!navigationEnabled) return null;
    const match = projects.find(
      (project) =>
        project.hostId === "local" &&
        project.roots.some((root) => root.rootPath === props.workspacePath),
    );
    return match ? projectKey(match) : null;
  }, [navigationEnabled, projects, props.workspacePath]);
  const lastWorkspacePathRef = useRef(props.workspacePath);
  useEffect(() => {
    const previous = lastWorkspacePathRef.current;
    if (previous === props.workspacePath) return;
    lastWorkspacePathRef.current = props.workspacePath;
    // 工作区被外部切换（深链/跨工作区任务导航）且已进入智能体页：跟随新工作区所属项目。
    // 远程项目进入不切换工作区（previous === now 提前返回），不会被这里覆盖回本地项目。
    if (!navigationEnabled || enteredProjectKeyRef.current === null) return;
    if (activeProjectKey !== null && activeProjectKey !== enteredProjectKeyRef.current) {
      setEnteredProjectKey(activeProjectKey);
    }
  }, [activeProjectKey, navigationEnabled, props.workspacePath]);
  const openProjectRow = (project: VirtualProject) => {
    setEnteredProjectKey(projectKey(project));
    // 仅本地项目切换工作区（进入 = 打开）；远程项目只进入其智能体页，
    // 会话点击仍走既有跨工作区导航/远端连接流程。
    if (project.hostId === "local") {
      const rootPath = project.roots[0]?.rootPath;
      if (rootPath) props.onOpenProject?.(rootPath);
    }
  };
  // 项目文件夹行复用项目视图的完整行组件；children 是该文件夹下的智能体列表（由智能体树装配）。
  // 导航列表页改为“进入项目”入口：expanded 固定收起、无子内容，点击交给 navigation.onOpen。
  const agentPageMode = navigationEnabled && enteredProject !== null;
  const openProjectLabel = intl.formatMessage({ id: "project.open" });
  const renderProject = (project: VirtualProject, children?: ReactNode) => (
    <ProjectSidebarNode
      key={projectKey(project)}
      project={project}
      deviceLabel={deviceNames.get(projectSourceServerId(project) ?? "")}
      remoteHost={directory.hosts.find((host) => host.id === project.hostId)}
      diagnostics={diagnostics.get(project.hostId)}
      expanded={agentPageMode ? true : navigationEnabled ? false : preferences.isExpanded(project)}
      onExpandedChange={preferences.setExpanded}
      hasUnread={projectHasUnread(authoritativeTree, project)}
      availability={availability.get(projectKey(project))}
      navigation={
        navigationEnabled && !agentPageMode
          ? { onOpen: () => openProjectRow(project), openLabel: openProjectLabel }
          : undefined
      }
      tasks={NO_PROJECT_TASKS}
      onSelect={onSelectTask}
      refresh={refresh}
      service={service}
      remoteService={remoteService}
      isDesktop={props.isDesktop}
      isWebRemoteControl={props.isWebRemoteControl}
      onCreateTask={props.onCreateTask}
      onReconnectRemoteWorkspace={props.onReconnectRemoteWorkspace}
      onEdit={setEditor}
      onViewFiles={openFiles}
      remoteActions={remoteSync.actions}
    >
      {children}
    </ProjectSidebarNode>
  );
  const openSettings = useCallback(() => {
    tabStore.getState().openSettingsTab();
  }, [tabStore]);
  const changeLocale = useCallback(
    (value: string) => setLocalePreference(value as Locale | "system"),
    [setLocalePreference],
  );
  const changeTheme = useCallback((value: string) => setTheme(value as Theme), [setTheme]);
  // RobinDone(2026-11-22): [hide-upstream-account] 隐藏「升级回调」——footer onUpgradeClick prop 已注释移除，
  // 恢复时取消本段注释
  // const upgrade = useCallback<
  //   NonNullable<Parameters<typeof WorkspaceSidebarFooter>[0]["onUpgradeClick"]>
  // >(
  //   (providerId, funnelContext) => openCodingPlanUpgrade({ providerId, funnelContext }),
  //   [openCodingPlanUpgrade],
  // );
  // RobinDone(2026-11-22): [hide-upstream-account] 隐藏结束
  const banner = useMemo(() => <SidebarBottomActivity />, []);
  // 手机远控 home-only 没有 base attachment，也就没有项目契约；改用 relay 层工作区列表与重连入口。
  const homeOnlySwitcher = service ? undefined : props.webRemoteControlWorkspaceSwitcher;
  return (
    <ProjectTaskListContext.Provider value={taskPresentation}>
      <SidebarTooltipProvider>
        <aside data-testid={TID_SIDEBAR} className="flex h-full min-h-0 flex-col overflow-hidden">
          <div
            className={`h-12 shrink-0 [app-region:drag] ${props.isWebRemoteControl ? "max-md:hidden" : ""}`}
          />
          {/* 内联改名聚焦曾把 hidden 容器横向滚动，导致手机整栏左移；滑动面板只裁切，不允许焦点滚动。 */}
          <div className="relative min-h-0 flex-1 overflow-clip">
            <div
              data-project-sidebar-panel="navigation"
              className="absolute inset-0 flex min-h-0 flex-col"
            >
              <ProjectSidebarNavigation props={props} agentPageMode={agentPageMode} />
              <div
                data-testid="sidebar-task-list-region"
                className="flex min-h-0 flex-1 flex-col border-t border-border/50 pt-3 [anchor-name:--sidebar-task-list-divider]"
              >
                <ProjectSidebarListHeader
                  onOpenCommandCenter={props.onOpenCommandCenter}
                  groupedActionsRef={setGroupedToolbar}
                  title={
                    enteredProject
                      ? enteredProject.name
                      : navigationEnabled
                        ? intl.formatMessage({ id: "project.listTitle" })
                        : intl.formatMessage({ id: "taskList.title" })
                  }
                  onBack={agentPageMode ? () => setEnteredProjectKey(null) : undefined}
                  backLabel={intl.formatMessage({ id: "project.back" })}
                  /* 智能体页（2026-11-15 裁决）：项目文件夹行移除，行尾按钮原样上移到标题行。 */
                  projectActions={
                    agentPageMode && enteredProject ? (
                      <ProjectHeaderActions
                        project={enteredProject}
                        remoteHost={directory.hosts.find(
                          (host) => host.id === enteredProject.hostId,
                        )}
                        service={service}
                        remoteService={remoteService}
                        isDesktop={props.isDesktop}
                        isWebRemoteControl={props.isWebRemoteControl}
                        onCreateTask={props.onCreateTask}
                        onReconnectRemoteWorkspace={props.onReconnectRemoteWorkspace}
                        onEdit={setEditor}
                        onViewFiles={openFiles}
                        remoteActions={remoteSync.actions}
                        refresh={refresh}
                        availability={availability.get(projectKey(enteredProject))}
                      />
                    ) : undefined
                  }
                />
                {/* 原因：仅设 overflow-y:auto 会让拖拽位移打开水平滚动；列表始终只允许纵向滚动。 */}
                {/* 原因：项目侧栏迁移后普通滚动容器遗漏边缘渐隐；复用统一 mask，随实际滚动边界更新。 */}
                <div className="relative flex min-h-0 flex-1 flex-col">
                  <div ref={setGroupedSticky} />
                  <ScrollFadeViewport ref={scrollRef} className="overflow-x-hidden">
                    {/* 项目列表页的项目行是本容器的直接 flex 子节点（ProjectList 的
                          DndContext/SortableContext 不产生 DOM），原 gap-3 会在行与行之间
                          多出 12px 空隙（2026-11-20 用户裁决：与 ZCode 一致，行贴行排列）。 */}
                    <div className="flex flex-col pb-3">
                      {homeOnlySwitcher ? (
                        <HomeOnlyWorkspaceRows switcher={homeOnlySwitcher} />
                      ) : navigationEnabled && !agentPageMode ? (
                        <ProjectList
                          projects={projects}
                          renderProject={renderProject}
                          onReorderProjects={reorder}
                          onAddProject={
                            service && remoteService ? () => setCreating(true) : undefined
                          }
                          addProjectLabel={intl.formatMessage({ id: "project.new" })}
                          emptyLabel={intl.formatMessage({ id: "project.listEmpty" })}
                          loading={loading}
                          toolbarTarget={groupedToolbar}
                        />
                      ) : (
                        <TaskGroupedView
                          tasks={tree.tasks}
                          onSelect={onSelectTask}
                          refresh={refresh}
                          scrollRef={scrollRef}
                          toolbarTarget={groupedToolbar}
                          stickyTarget={groupedSticky}
                          workspacePath={props.workspacePath}
                          workspaceIdentity={props.workspaceIdentity}
                          onOpenAutomations={props.onOpenAutomations}
                          // 智能体行"+"新建（2026-11-16 验收修复）：携带组归属项目（远程项目带 hostId），
                          // 草稿预选该项目与该智能体，而不是把项目显式清空。
                          onCreate={(groupId, projectId, hostId) =>
                            action(() => start(projectId ?? undefined, hostId, groupId))
                          }
                          projects={agentPageMode && enteredProject ? [enteredProject] : projects}
                          renderProject={renderProject}
                          onReorderProjects={reorder}
                          onAddProject={
                            agentPageMode
                              ? undefined
                              : service && remoteService
                                ? () => setCreating(true)
                                : undefined
                          }
                          // 智能体页数据范围（2026-11-15 裁决）：进入的项目非空即页面模式，
                          // 驱动 worker 投影与按项目收敛（树模式恒为 null，全量渲染）。
                          enteredProject={agentPageMode ? enteredProject : null}
                          // worker 组"查看文件"：复用文件面板打开 worker 的 .robindone/agents/<id>/ 目录
                          // （远程项目带当前工作区 remoteSessionId，文件树服务按完整 attachment 解析）。
                          onOpenWorkerFolder={props.onOpenFileManager}
                          workspaceRemoteSessionId={props.workspaceRemoteSessionId}
                        />
                      )}
                      {loading && !homeOnlySwitcher ? (
                        <p className="mt-2 px-4 text-ui-sm text-foreground-subtle">
                          {intl.formatMessage({ id: "common.loading" })}
                        </p>
                      ) : null}
                      {error && !homeOnlySwitcher ? (
                        <p role="alert" className="mt-2 px-4 text-ui-sm text-destructive">
                          {error}
                        </p>
                      ) : null}
                    </div>
                  </ScrollFadeViewport>
                </div>
              </div>
              <WorkspaceSidebarFooter
                className="pr-3"
                theme={props.theme}
                localeMenuValue={localePreference}
                onLocaleChange={changeLocale}
                onThemeChange={changeTheme}
                onSettingsButtonClick={openSettings}
                // RobinDone(2026-11-22): [hide-upstream-account] 隐藏「footer usage/upgrade/登录/登出传参」——
                // footer 侧对应 props 已注释移除，恢复时取消以下注释
                // onUsageClick={openSettings}
                // onUpgradeClick={upgrade}
                // onLogin={props.onLogin}
                // onLogout={props.onLogout}
                // RobinDone(2026-11-22): [hide-upstream-account] 隐藏结束
                user={props.user}
                workspacePath={props.workspacePath}
                // 项目侧栏不再从 tab 反推身份；远控入口必须沿用当前 attachment 的精确 scope。
                workspaceIdentity={props.workspaceIdentity}
                workspaceRemoteSessionId={props.workspaceRemoteSessionId}
                isDesktop={props.isDesktop}
                banner={banner}
              />
            </div>
          </div>
          {creating && service && remoteService ? (
            <ProjectCreation
              workspacePath={props.workspacePath}
              workspaceIdentity={props.workspaceIdentity}
              onCreateTask={props.onCreateTask}
              directory={directory}
              defaultDeviceId={
                hasActiveRemoteTask && props.workspaceIdentity
                  ? (remoteHostIdFromWorkspaceIdentity(props.workspaceIdentity) ?? "local")
                  : "local"
              }
              allowDeviceManagement={props.isDesktop === true}
              projects={tree.projects}
              service={service}
              remoteService={remoteService}
              onOpenRemoteWorkspace={props.onOpenRemoteWorkspace}
              onClose={() => setCreating(false)}
              onSaved={refresh}
            />
          ) : null}
          {remotePicker && service && remoteService ? (
            <RemoteProjectPicker
              key={remotePicker.membershipId}
              host={remotePicker}
              service={service}
              remoteService={remoteService}
              onClose={() => setRemotePicker(null)}
              onSaved={refresh}
            />
          ) : null}
          {editor && service ? (
            <ProjectEditor
              key={editor.project?.id ?? "new"}
              project={editor.project}
              host={directory.hosts.find((host) => host.id === editor.project?.hostId)}
              projects={tree.projects.filter(
                (project) => !availability.get(projectKey(project))?.entryId,
              )}
              service={service}
              onClose={() => setEditor(null)}
              onSaved={refresh}
              onDeleted={refresh}
            />
          ) : null}
          {remoteSync.dialog}
        </aside>
      </SidebarTooltipProvider>
    </ProjectTaskListContext.Provider>
  );
});

export { ComposerSubmissionPendingContext } from "@/project-sidebar/ComposerSubmissionPendingContext.js";
