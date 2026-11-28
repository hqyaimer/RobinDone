import { ComposerSubmissionPendingContext } from "@/project-sidebar/ComposerSubmissionPendingContext.js";
import { ChatRemoteFolderSelection } from "@/project-sidebar/ChatRemoteFolderSelection.js";
import { useWorkers } from "@/project-sidebar/useWorkers.js";
import { RemoteIdentityHoverCard } from "@/project-sidebar/RemoteIdentityHoverCard.js";
import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import type { ReactNode } from "react";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group.js";
import {
  Bot,
  ChevronDownIcon,
  Cloud,
  FolderPlus,
  MessageCircle,
  Plus,
  SearchIcon,
  X,
} from "lucide-react";
import { useRobinDoneIntl } from "@/i18n/IntlProvider.js";
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import { useRemoteConnectionEntryVisibility } from "@/hooks/useRemoteConnectionEntryVisibility.js";
import { cn } from "@/components/lib/utils.js";
import { logger } from "@/logger.js";
import {
  buildServerRemoteWorkspaceIdentity,
  isMainAgentGroupId,
  isWorkerGroupId,
  workerGroupId,
} from "@robindone/shared";
import {
  TID_COMPOSER_AGENT_TRIGGER,
  TID_COMPOSER_PROJECT_DETACH,
  TID_COMPOSER_REMOTE_CONNECTION,
  TID_COMPOSER_WORK_OUTSIDE_PROJECT,
  TID_COMPOSER_WORKSPACE_TRIGGER,
} from "@robindone/shared/test-ids";
import { runUserAction, runUserActionAsync } from "@/lib/userActionTelemetry.js";

import type {
  ProjectSidebarProps,
  RemoteProjectHost,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import { remoteHostIdFromWorkspaceIdentity } from "@/project-sidebar/contract.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import { ProjectCreation } from "@/project-sidebar/ProjectCreation.js";
import { ProjectFolderIcon } from "@/project-sidebar/ProjectFolderIcon.js";
import { projectKey, projectSourceServerId } from "@/project-sidebar/view.js";
import {
  useProjectDirectory,
  useProjectSelectionDirectory,
} from "@/project-sidebar/ProjectDirectoryProvider.js";
import { getTaskGroupDisplayTitle } from "@/project-sidebar/grouped/group-title.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  resolveComposerScope,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";
import { useRobinDoneSessionStore } from "@/store/robindoneSessionStore.js";

export function ProjectComposerMenu({
  workspacePath,
  workspaceIdentity,
  compactForRemoteControl = false,
  allowConversationWorkspaceSelection = true,
  allowConversationWorkspaceDetach = allowConversationWorkspaceSelection,
  onCreateTask,
  onSelectConversationWorkspace,
  allowRemoteWorkspace = true,
  onOpenRemoteWorkspace,
  containerClassName,
  triggerClassName,
  triggerIndicator,
  showEditProject = false,
  children,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  compactForRemoteControl?: boolean;
  allowConversationWorkspaceSelection?: boolean;
  /** 是否显示项目 chip 的快捷脱离按钮；默认跟随非项目工作区选择能力。 */
  allowConversationWorkspaceDetach?: boolean;
  onCreateTask: ProjectSidebarProps["onCreateTask"];
  onSelectConversationWorkspace: () => void | Promise<void>;
  allowRemoteWorkspace?: boolean;
  onOpenRemoteWorkspace?: ProjectSidebarProps["onOpenRemoteWorkspace"];
  onConnectRemote?: ProjectSidebarProps["onConnectRemote"];
  onCancelRemote?: ProjectSidebarProps["onCancelRemoteProject"];
  /** 调用方局部调整 workspace chip 外层视觉，不改变普通会话默认样式。 */
  containerClassName?: string;
  /** 调用方局部调整 workspace trigger 视觉，不改变普通会话默认样式。 */
  triggerClassName?: string;
  /** 调用方局部替换尾部 indicator；普通会话继续使用默认 Lucide chevron。 */
  triggerIndicator?: ReactNode;
  /** 聊天头部启用当前项目编辑，其他项目选择器保持原有入口。 */
  showEditProject?: boolean;
  /** 分支等控件位于项目选择器与编辑按钮之间。 */
  children?: ReactNode;
}) {
  const { intl } = useRobinDoneIntl();
  const [workspaceSearchQuery, setWorkspaceSearchQuery] = useState("");
  const showRemoteConnectionEntry = useRemoteConnectionEntryVisibility();
  // Bugfix: Web 普通模式没有完整远程 workspace 会话链路，不能只依赖全局 feature visibility。
  // 这里叠加壳层能力开关，确保本地 Web 模式的空态菜单不会露出必然失败的远程连接入口。
  const canUseRemoteWorkspace =
    allowRemoteWorkspace && showRemoteConnectionEntry && Boolean(onOpenRemoteWorkspace);
  const {
    allProjects,
    projects,
    availability,
    directory,
    deviceNames,
    error,
    service,
    remoteService,
    refresh,
  } = useProjectSelectionDirectory();
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const projectId = useRobinDoneSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftProjectId,
  );
  const activeTaskId = useRobinDoneSessionStore(
    (state) => state.workspaces[workspaceKey]?.activeTaskId,
  );
  const createProjectTask: ProjectSidebarProps["onCreateTask"] = (request) =>
    onCreateTask(
      typeof request === "object"
        ? {
            ...request,
            // 远程目录确认曾遗漏草稿分组；两个项目入口必须从同一草稿 owner 读取组织意图。
            taskGroupId: !activeTaskId
              ? useRobinDoneSessionStore
                  .getState()
                  .getWorkspaceState(workspacePath, workspaceIdentity).draftTaskGroupId
              : null,
          }
        : request,
    );
  const draftVersion = useRobinDoneSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftFocusVersion,
  );
  // 草稿重建和聊天切换都会使旧返回意图失效，即使后来又回到同一路径也不能复活旧操作。
  const chatKey = JSON.stringify([workspaceKey, activeTaskId, projectId, draftVersion]);
  const currentChat = useRef({ key: chatKey });
  if (currentChat.current.key !== chatKey) currentChat.current = { key: chatKey };
  const chat = currentChat.current;
  const mounted = useRef(true);
  const operation = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const [connectedDevice, setConnectedDevice] = useState<{
    sourceServerId: string;
    host?: RemoteProjectHost;
    isCurrent(): boolean;
  } | null>(null);
  const setSubmissionPending = useContext(ComposerSubmissionPendingContext);
  const [pending, setPending] = useState(false);
  const [restoredChat, setRestoredChat] = useState<typeof chat | null>(null);
  useEffect(() => {
    setSubmissionPending?.(pending);
    return () => setSubmissionPending?.(false);
  }, [pending, chatKey, setSubmissionPending]);
  useEffect(() => {
    setPending(false);
  }, [chatKey]);
  const cancelSelection = () => {
    setRestoredChat(chat);
    operation.current++;
    setConnectedDevice(null);
    setPending(false);
    setSubmissionPending?.(false);
    setReturnFocus((version) => version + 1);
  };
  const [creating, setCreating] = useState(false);
  const [editingChat, setEditingChat] = useState<typeof chat | null>(null);
  const [returnFocus, setReturnFocus] = useState(0);
  // 旧连接弹窗在被动 effect 中释放焦点锁；layout 阶段聚焦会被拉回即将卸载的按钮。
  // 同轮清理结束后恢复原菜单焦点，不依赖延时，也不移动聊天草稿。
  useEffect(() => {
    if (returnFocus) {
      trigger.current?.focus();
      logger.debug("[ProjectComposerMenu] 返回聊天焦点", {
        restored: document.activeElement === trigger.current,
        inert: Boolean(trigger.current?.closest("[inert]")),
      });
    }
  }, [returnFocus]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const addDevice = () => {
    setRestoredChat(null);
    const request = ++operation.current;
    const originalHosts = directory.hosts;
    let validatedHost: RemoteProjectHost | undefined;
    setConnectedDevice(null);
    setPending(true);
    setSubmissionPending?.(true);
    const isCurrent = () => {
      const draft = useRobinDoneSessionStore.getState().workspaces[workspaceKey];
      // Store 先提交、React 后渲染；迟到结果不能利用这一间隙复活旧草稿意图。
      return (
        mounted.current &&
        currentChat.current === chat &&
        operation.current === request &&
        draft?.activeTaskId === activeTaskId &&
        draft?.draftProjectId === projectId &&
        draft?.draftFocusVersion === draftVersion
      );
    };
    const accepted = onOpenRemoteWorkspace?.({
      completion: "device-management",
      returnTarget: {
        kind: "add-device",
        isCurrent,
        async canFinish(result) {
          if (!isCurrent()) return false;
          if (result.kind !== "connected" || !result.sourceServerId) return true;
          const hostId = remoteHostIdFromWorkspaceIdentity(
            buildServerRemoteWorkspaceIdentity({
              serverId: result.sourceServerId,
              workspacePath: "/",
            }),
          );
          const original = originalHosts.find((host) => host.id === hostId);
          // 后台等待期间已移除/换代的成员不能借显式继续重新登记；首次设备仍在确认目录时登记。
          if (!original) return true;
          const latest = await remoteService?.readDirectory();
          if (
            !isCurrent() ||
            !latest?.hosts.some(
              (host) => host.id === original.id && host.membershipId === original.membershipId,
            )
          )
            return false;
          validatedHost = original;
          return true;
        },
        onVisibilityChange(visible) {
          if (!isCurrent()) return;
          // 后台连接只保留返回意图；曾因门禁未随收起解除，原草稿无法继续本地工作。
          setPending(visible);
          setSubmissionPending?.(visible);
        },
        finish(result) {
          if (!isCurrent()) return;
          // 连接只证明设备可用；目录与项目仍未确定，不能提前解除原草稿的提交门禁。
          if (result.kind === "connected" && result.sourceServerId) {
            setPending(true);
            setSubmissionPending?.(true);
            setConnectedDevice({
              sourceServerId: result.sourceServerId,
              host: validatedHost,
              isCurrent,
            });
          } else {
            if (result.kind === "cancelled" && !result.background) setRestoredChat(chat);
            setPending(false);
            setSubmissionPending?.(false);
          }
          if (result.kind === "cancelled" && !result.background)
            setReturnFocus((version) => version + 1);
        },
      },
    });
    if (accepted === false) cancelSelection();
  };
  const currentDevice = connectedDevice?.isCurrent() ? connectedDevice : null;
  const hostId = workspaceIdentity ? remoteHostIdFromWorkspaceIdentity(workspaceIdentity) : null;
  // 原因：目录可以属于多个项目，tab/cwd 不能决定归属；只读草稿的项目身份。
  const currentProject = projects.find(
    (project) =>
      project.id === projectId &&
      (hostId ? project.hostId === hostId : !availability.get(projectKey(project))?.entryId),
  );
  const canEditProject =
    showEditProject &&
    currentProject &&
    !currentProject.legacySingleRoot &&
    (availability.get(projectKey(currentProject))?.online ?? true) &&
    Boolean(service);
  const isConversationWorkspace = !currentProject;
  const canDetachProject =
    !hostId &&
    allowConversationWorkspaceSelection &&
    allowConversationWorkspaceDetach &&
    !isConversationWorkspace;
  const visibleProjects = useMemo(() => {
    const query = workspaceSearchQuery.trim().toLowerCase();
    return projects.filter((project) =>
      [
        project.name,
        deviceNames?.get(projectSourceServerId(project) ?? "") ||
          (() => {
            const host = directory.hosts.find((host) => host.id === project.hostId);
            return host ? remoteHostLabel(host) : "";
          })(),
        ...project.roots.map((root) => root.rootPath),
      ].some((text) => text.toLowerCase().includes(query)),
    );
  }, [projects, workspaceSearchQuery, deviceNames, directory.hosts]);
  const currentWorkspaceTitle =
    currentProject?.name ?? intl.formatMessage({ id: "chat.empty.selectProject" });
  const currentWorkspaceIconClassName = cn(
    "size-4 text-foreground-subtle transition-opacity",
    // Bugfix: 关闭按钮和项目图标占用同一位置。只有允许脱离项目时才隐藏底层图标，
    // 否则 X 会直接叠在图标上；定时任务禁用该能力时则让项目图标保持可见。
    canDetachProject &&
      "group-hover/workspace-chip:opacity-0 group-focus-within/workspace-chip:opacity-0",
  );

  const menu = (
    <DropdownMenu>
      <div
        className={cn(
          "group/workspace-chip relative flex min-w-0 items-center rounded-full hover:bg-surface-hover focus-within:bg-surface-hover",
          containerClassName,
        )}
      >
        {canDetachProject ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="pointer-events-none absolute left-1.5 z-10 rounded-full text-foreground-subtle opacity-0 transition-opacity group-hover/workspace-chip:pointer-events-auto group-hover/workspace-chip:opacity-100 group-focus-within/workspace-chip:pointer-events-auto group-focus-within/workspace-chip:opacity-100"
            aria-label={intl.formatMessage({ id: "chat.empty.detachProject" })}
            data-testid={TID_COMPOSER_PROJECT_DETACH}
            onClick={(event) => {
              event.stopPropagation();
              void runUserActionAsync({
                input: {
                  featureId: "workspace.project_binding",
                  action: "detach",
                  trigger: "button",
                },
                operation: () => Promise.resolve(onSelectConversationWorkspace()),
                completed: { resultSource: "optimistic_projection" },
                failureStage: "project_detach",
              });
            }}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="default"
            className={cn(
              "min-w-0 rounded-full bg-transparent text-ui-base/relaxed hover:bg-transparent",
              // Bugfix: 远程控制页面空态文案区域更窄，workspacePath 过长会把同一行挤坏。
              // 这里在远控模式收紧菜单触发按钮宽度，让超长路径在按钮内走省略号。
              compactForRemoteControl ? "max-w-44 pl-3 pr-2" : "max-w-[15rem] pl-3 pr-2",
              triggerClassName,
            )}
            ref={trigger}
            aria-label={intl.formatMessage({ id: "chat.empty.workspaceMenu" })}
            data-testid={TID_COMPOSER_WORKSPACE_TRIGGER}
          >
            {hostId ? (
              <Cloud className={currentWorkspaceIconClassName} />
            ) : (
              <ProjectFolderIcon
                rootCount={currentProject?.roots.length ?? 0}
                className={currentWorkspaceIconClassName}
              />
            )}
            <span className="block max-w-full truncate">{currentWorkspaceTitle}</span>
            {triggerIndicator ?? <ChevronDownIcon className="size-3.5 text-foreground-subtle" />}
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent
        data-testid="composer-project-menu"
        align="start"
        side="top"
        className="flex w-72 max-w-[calc(100vw-2rem)] flex-col p-0"
      >
        <div
          data-slot="command-input-wrapper"
          className="shrink-0 p-1 border-b border-border"
          onKeyDown={(event) => event.stopPropagation()}
        >
          <InputGroup className="h-8 border-0 !bg-transparent hover:border-input-border-hover ">
            <input
              data-slot="command-input"
              value={workspaceSearchQuery}
              placeholder={intl.formatMessage({
                id: "chat.empty.workspaceSearchPlaceholder",
              })}
              onChange={(event) => setWorkspaceSearchQuery(event.target.value)}
              className="w-full text-ui-base/relaxed text-foreground outline-hidden placeholder:text-foreground-subtlest disabled:cursor-not-allowed disabled:opacity-50"
            />
            <InputGroupAddon>
              <SearchIcon className="size-4 shrink-0 text-foreground-subtlest" />
            </InputGroupAddon>
          </InputGroup>
        </div>
        <div className="flex min-h-0 flex-col p-1">
          {error ? (
            <div role="alert" className="px-2 py-2 text-ui-base text-destructive">
              {error}
            </div>
          ) : null}
          <div className="min-h-0 max-h-60 overflow-y-auto">
            {visibleProjects.map((project) => {
              const state = availability.get(projectKey(project));
              const isRemoteWorkspace =
                Boolean(state?.entryId) || Boolean(hostId && hostId === project.hostId);
              const disabled = state?.online === false;
              const remoteHost = directory.hosts.find((host) => host.id === project.hostId);
              const deviceName =
                deviceNames?.get(projectSourceServerId(project) ?? "") ||
                (remoteHost ? remoteHostLabel(remoteHost) : undefined);
              return (
                <RemoteIdentityHoverCard
                  key={projectKey(project)}
                  host={remoteHost}
                  title={project.name}
                  projectName={project.name}
                  deviceName={deviceName}
                  paths={project.roots.map((root) => root.rootPath)}
                  anchorToMenu
                  contentClassName="z-[60] max-w-(--radix-hover-card-content-available-width)"
                >
                  <span className="block min-w-0">
                    <DropdownMenuCheckboxItem
                      data-project-id={project.id}
                      data-project-host={project.hostId}
                      data-project-name={project.name}
                      checked={currentProject === project}
                      disabled={disabled}
                      onSelect={() => {
                        logger.info("[ProjectComposerMenu] 选择项目", {
                          projectId: project.id,
                          hostId: project.hostId,
                        });
                        runUserAction({
                          input: {
                            featureId: "workspace.project_binding",
                            action: isConversationWorkspace ? "attach" : "switch",
                            trigger: "menu",
                            workspaceKind: isRemoteWorkspace ? "remote" : "local",
                          },
                          // 同侧栏项目新建入口：由 Root/Host 解析主要目录及远程 attachment。
                          operation: () =>
                            createProjectTask({
                              projectId: project.id,
                              ...(compactForRemoteControl ||
                              directory.hosts.some((host) => host.id === project.hostId)
                                ? { hostId: project.hostId }
                                : {}),
                            }),
                          completed: { resultSource: "local_commit" },
                          failureStage: "project_switch",
                        });
                      }}
                    >
                      {isRemoteWorkspace ? (
                        <Cloud className="size-4 text-foreground-subtle" />
                      ) : (
                        <ProjectFolderIcon
                          rootCount={project.roots.length}
                          className="size-4 text-foreground-subtle"
                        />
                      )}
                      {/* 不同字号按框居中会让设备名基线上浮；文字单独对齐基线，外层图标仍居中。 */}
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate">{project.name}</span>
                        {deviceName ? (
                          <span
                            data-testid="composer-project-device"
                            className="max-w-36 truncate text-ui-sm text-remote-foreground-muted"
                          >
                            {deviceName}
                          </span>
                        ) : null}
                      </span>
                      {disabled ? (
                        <span className="text-ui-xs text-foreground-subtlest">
                          {intl.formatMessage({ id: "project.offline" })}
                        </span>
                      ) : null}
                    </DropdownMenuCheckboxItem>
                  </span>
                </RemoteIdentityHoverCard>
              );
            })}
            {visibleProjects.length === 0 && !error ? (
              <div className="px-2 py-2 text-ui-base text-foreground-subtlest">
                {intl.formatMessage({ id: "chat.empty.workspaceSearchEmpty" })}
              </div>
            ) : null}
          </div>

          <div className="shrink-0">
            <DropdownMenuSeparator />
            {/* 项目创建依赖共享服务，不能受本机原生打开文件夹的能力开关限制。 */}
            <DropdownMenuItem
              data-testid="composer-create-project"
              disabled={!service || !remoteService}
              onSelect={() => setCreating(true)}
            >
              <FolderPlus className="size-4 text-foreground-subtle" />
              <span>{intl.formatMessage({ id: "project.create" })}</span>
            </DropdownMenuItem>
            {canUseRemoteWorkspace ? (
              <DropdownMenuItem
                data-testid={TID_COMPOSER_REMOTE_CONNECTION}
                onSelect={() => {
                  // Bugfix: 打开远程弹窗时必须让 DropdownMenu 执行默认关闭流程。
                  // 阻止默认 select 会让父菜单与 modal 同时保持打开，浮层层级调整后父菜单会覆盖弹窗。
                  logger.info(
                    `[ProjectComposerMenu] open remote dialog from workspace menu workspace=${workspacePath}`,
                  );
                  // 连接流程由 Root 唯一持有；聊天只提供有效性检查与完成结果接缝。
                  runUserAction({
                    input: {
                      featureId: "workspace.remote.lifecycle",
                      action: "open_dialog",
                      trigger: "menu",
                      workspaceKind: "remote",
                    },
                    operation: addDevice,
                    completed: { resultSource: "local_commit" },
                    failureStage: "dialog_open",
                  });
                }}
              >
                <Cloud className="size-4 text-foreground-subtle" />
                <span>{intl.formatMessage({ id: "chat.empty.newRemoteConnection" })}</span>
              </DropdownMenuItem>
            ) : null}
            {allowConversationWorkspaceSelection && !hostId ? (
              <DropdownMenuCheckboxItem
                data-testid={TID_COMPOSER_WORK_OUTSIDE_PROJECT}
                checked={isConversationWorkspace}
                onSelect={() =>
                  void runUserActionAsync({
                    input: {
                      featureId: "workspace.project_binding",
                      action: "work_outside_project",
                      trigger: "menu",
                    },
                    operation: () => Promise.resolve(onSelectConversationWorkspace()),
                    completed: { resultSource: "optimistic_projection" },
                    failureStage: "project_detach",
                  })
                }
              >
                <MessageCircle className="size-4 text-foreground-subtle" />
                <span>{intl.formatMessage({ id: "chat.empty.workOutsideProject" })}</span>
              </DropdownMenuCheckboxItem>
            ) : null}
          </div>
        </div>
      </DropdownMenuContent>
      {restoredChat === chat ? (
        <span
          role="status"
          data-testid="chat-restored-target"
          className="max-w-full break-words px-2 text-ui-sm text-foreground-subtle"
        >
          {intl.formatMessage(
            { id: "chat.remoteFolder.restored" },
            {
              device: hostId
                ? (deviceNames?.get(
                    currentProject ? (projectSourceServerId(currentProject) ?? "") : "",
                  ) ?? hostId)
                : intl.formatMessage({ id: "project.thisComputer" }),
              project:
                currentProject?.name ?? intl.formatMessage({ id: "chat.empty.workOutsideProject" }),
            },
          )}
        </span>
      ) : null}
      {currentDevice && service && remoteService ? (
        <ChatRemoteFolderSelection
          request={currentDevice}
          service={service}
          remoteService={remoteService}
          onCreateTask={createProjectTask}
          onClose={cancelSelection}
        />
      ) : null}
      {/* 连接成功仍由目录流程交付聊天；普通创建在同一草稿中选中保存后的项目。 */}
      {creating && service && remoteService ? (
        <ProjectCreation
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          onCreateTask={createProjectTask}
          projects={allProjects}
          directory={directory}
          service={service}
          remoteService={remoteService}
          defaultDeviceId={activeTaskId && hostId ? hostId : "local"}
          allowDeviceManagement={canUseRemoteWorkspace}
          onOpenRemoteWorkspace={onOpenRemoteWorkspace}
          onClose={() => setCreating(false)}
          onSaved={refresh}
        />
      ) : null}
    </DropdownMenu>
  );
  return (
    <>
      {menu}
      {/* 智能体下拉只在已选项目的草稿里出现；非项目工作区没有对话对象可选。 */}
      {currentProject ? (
        <ComposerAgentMenu
          project={currentProject}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
        />
      ) : null}
      {children}
      {canEditProject ? (
        <ControlHintTooltip title={intl.formatMessage({ id: "project.edit" })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-full text-foreground-subtle"
            aria-label={intl.formatMessage({ id: "project.edit" })}
            data-testid="composer-edit-project"
            onClick={() => setEditingChat(chat)}
          >
            <Plus className="size-4" />
          </Button>
        </ControlHintTooltip>
      ) : null}
      {/* 项目身份沿用菜单；聊天切换使旧编辑器失效，避免同 cwd 的项目被误编辑。 */}
      {editingChat === chat && canEditProject && currentProject && service ? (
        <ProjectEditor
          key={projectKey(currentProject)}
          project={currentProject}
          host={directory.hosts.find((host) => host.id === currentProject.hostId)}
          projects={allProjects.filter(
            (project) => !availability.get(projectKey(project))?.entryId,
          )}
          service={service}
          onClose={() => setEditingChat(null)}
          onSaved={refresh}
          onDeleted={refresh}
        />
      ) : null}
    </>
  );
}

/**
 * Composer 项目 chip 右侧的智能体（任务组）选择器（2026-11-15 裁决）：草稿态选取本次
 * 对话的智能体，选中即改草稿组织意图（显式意图在发送冻结与 admit 链路中优先级最高）。
 * 单独成组件：智能体名册读全量目录 Context（任务活动会高频穿透广播），隔离重渲染
 * 范围，避免 ProjectComposerMenu 的项目 chip 与菜单跟着目录每秒重绘。
 */
function ComposerAgentMenu({
  project,
  workspacePath,
  workspaceIdentity,
}: {
  project: VirtualProject;
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useRobinDoneIntl();
  const composerClientNamespace = useComposerClientNamespace();
  const {
    groups: { structure },
  } = useProjectDirectory();
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const draftTaskGroupId = useRobinDoneSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftTaskGroupId,
  );
  // 停用即隐藏（2026-11-17 裁决）：下拉与侧栏同一投影口径，只列 active worker 的组。
  const { workers } = useWorkers(workspacePath);
  const agents = useMemo(() => {
    const activeWorkerGroupIds = new Set(workers.map((worker) => workerGroupId(worker.id)));
    const own = structure.groups.filter(
      (group) =>
        group.projectId === project.id &&
        (!isWorkerGroupId(group.id) || activeWorkerGroupIds.has(group.id)),
    );
    // 排序同 buildAgentTreeLayout：主智能体置顶，worker 组（编制物化）次之，其余智能体保持用户顺序。
    return [...own].sort(
      (a, b) =>
        Number(isMainAgentGroupId(b.id)) - Number(isMainAgentGroupId(a.id)) ||
        Number(isWorkerGroupId(a.id)) - Number(isWorkerGroupId(b.id)),
    );
  }, [structure.groups, project.id, workers]);
  const localizedSystemTitles = useMemo(
    () => ({
      cron: intl.formatMessage({ id: "taskGroup.cronGroupName" }),
      offPeak: intl.formatMessage({ id: "offPeak.sidebar.groupTitle" }),
      mainAgent: intl.formatMessage({ id: "taskGroup.mainAgent" }),
    }),
    [intl],
  );
  const selected = agents.find((agent) => agent.id === draftTaskGroupId) ?? null;
  const selectAgent = (taskGroupId: string) => {
    // 草稿组织意图双写：store 字段是发送时 SessionPane 冻结的事实源；持久草稿立即
    // 跟进一次，覆盖"改完即刷新"的窗口。不 bump draftFocusVersion——正文与预热保持，
    // 且 useDraftConfigControl 的 placement 读到最新 store 值后随键入继续回写。
    const scope = resolveComposerScope(project.id, workspaceIdentity, composerClientNamespace);
    const saved = readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, scope);
    persistV4ComposerDraft(
      workspacePath,
      workspaceIdentity,
      V4_DRAFT_SCOPE_ROOT,
      { ...(saved ?? { text: "" }), projectId: project.id, taskGroupId },
      scope,
    );
    useRobinDoneSessionStore
      .getState()
      .setDraftTaskGroup(workspacePath, taskGroupId, workspaceIdentity);
    logger.info("[ProjectComposerMenu] 选择对话智能体", { projectId: project.id, taskGroupId });
  };
  // 项目还没自举出任何智能体（主智能体由 saveProject 幂等创建）时无对象可选，不渲染。
  if (agents.length === 0) return null;
  const selectedTitle = selected
    ? getTaskGroupDisplayTitle(selected, localizedSystemTitles)
    : intl.formatMessage({ id: "chat.empty.agentMenu" });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="default"
          className="min-w-0 rounded-full bg-transparent px-2 text-ui-base/relaxed hover:bg-surface-hover"
          aria-label={intl.formatMessage({ id: "chat.empty.agentMenu" })}
          data-testid={TID_COMPOSER_AGENT_TRIGGER}
        >
          <Bot className="size-4 shrink-0 text-foreground-subtle" />
          <span className="block max-w-[10rem] truncate">{selectedTitle}</span>
          <ChevronDownIcon className="size-3.5 text-foreground-subtle" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-testid="composer-agent-menu"
        align="start"
        side="top"
        className="flex w-60 flex-col p-1"
      >
        {agents.map((agent) => {
          const title = getTaskGroupDisplayTitle(agent, localizedSystemTitles);
          return (
            <DropdownMenuCheckboxItem
              key={agent.id}
              data-task-group-id={agent.id}
              data-agent-name={title}
              checked={selected?.id === agent.id}
              onSelect={() => selectAgent(agent.id)}
            >
              <Bot className="size-4 shrink-0 text-foreground-subtle" />
              <span className="min-w-0 flex-1 truncate">{title}</span>
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
