import { memo } from "react";
import { shallow } from "zustand/shallow";
import { Plug } from "lucide-react";
import { mainAgentGroupId } from "@robinrun/shared";
import type {
  IProjectService,
  IRemoteProjectService,
  ProjectRowAction,
  ProjectSidebarProps,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import { buildRemoteHostWorkspaceIdentity } from "@/project-sidebar/contract.js";
import { ProjectNode } from "@/project-sidebar/ProjectNode.js";
import {
  ProjectRowActionButtons,
  useProjectRowActionLists,
} from "@/project-sidebar/ProjectNodeContent.js";
import type { ProjectNodeProps } from "@/project-sidebar/ProjectNodeContent.js";
import { projectSourceServerId } from "@/project-sidebar/view.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useRobinRunIntl } from "@/i18n/IntlProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import { useRobinRunStoreWithDefault } from "@/store/StoreProvider.js";

export function runProjectAction(body: () => Promise<void>) {
  void body().catch((cause) => {
    logger.error("[project-sidebar] 操作失败", cause);
    toast(String(cause));
  });
}

type Props = Pick<
  ProjectNodeProps,
  | "project"
  | "remoteHost"
  | "deviceLabel"
  | "diagnostics"
  | "expanded"
  | "hasUnread"
  | "availability"
  | "tasks"
  | "children"
  | "navigation"
  | "onSelect"
  | "refresh"
> &
  Pick<
    ProjectSidebarProps,
    "isDesktop" | "isWebRemoteControl" | "onCreateTask" | "onReconnectRemoteWorkspace"
  > & {
    service?: IProjectService;
    remoteService?: IRemoteProjectService;
    onExpandedChange(project: VirtualProject, expanded: boolean): void;
    onEdit(value: { project: VirtualProject }): void;
    onViewFiles(project: VirtualProject, rootPath: string): Promise<void>;
    remoteActions(project: VirtualProject): ProjectRowAction[];
  };

/**
 * 项目行与智能体页头部共用的操作接线（2026-11-15 裁决：项目行移除后按钮上移到列表头，
 * 两处必须复用同一份 handler，避免菜单行为分叉）。行内专属的排序/拖放接线不在这里。
 */
type ProjectRowWiringProps = Pick<
  Props,
  | "project"
  | "remoteHost"
  | "service"
  | "remoteService"
  | "isDesktop"
  | "isWebRemoteControl"
  | "onCreateTask"
  | "onReconnectRemoteWorkspace"
  | "onEdit"
  | "onViewFiles"
  | "remoteActions"
  | "navigation"
  | "refresh"
  | "availability"
>;

function useProjectRowWiring({
  project,
  remoteHost,
  service,
  remoteService,
  isDesktop,
  isWebRemoteControl,
  onCreateTask,
  onReconnectRemoteWorkspace,
  onEdit,
  onViewFiles,
  remoteActions,
  navigation,
  refresh,
  availability,
}: ProjectRowWiringProps) {
  const { intl } = useRobinRunIntl();
  const confirm = useConfirmDialog();
  const tabStore = useTabStoreApi();
  const msg = (id: string) => intl.formatMessage({ id: `project.${id}` });
  const sourceServerId = projectSourceServerId(project);
  const additionalActions: ProjectRowAction[] = [
    ...remoteActions(project),
    ...(remoteHost && remoteHost.connectionStatus !== "online"
      ? [
          {
            id: "connect",
            label: msg("connect"),
            icon: Plug,
            run: () =>
              runProjectAction(async () => {
                // 远端连接仍经现有意图分派，保留缺凭据、安装和升级流程。
                if (isDesktop && project.roots[0]) {
                  await onReconnectRemoteWorkspace(
                    buildRemoteHostWorkspaceIdentity(project.hostId, project.roots[0].rootPath),
                  );
                } else {
                  await remoteService!.connectHost(project.hostId);
                }
                await refresh();
              }),
          },
        ]
      : []),
  ];
  return {
    additionalActions,
    onOpenDeviceSettings:
      isDesktop && sourceServerId
        ? () => {
            setPendingSettingsSectionIntent("remoteDevices", { sourceServerId });
            tabStore.getState().openSettingsTab();
          }
        : undefined,
    onManageProjects: isDesktop
      ? () => {
          setPendingSettingsSectionIntent("projects");
          tabStore.getState().openSettingsTab();
        }
      : undefined,
    onRemoveEntry: () =>
      runProjectAction(async () => {
        const entryId = availability?.entryId;
        if (!entryId || !remoteService) throw new Error("remote-project.entry-not-found");
        await remoteService.removeEntry(entryId);
        await refresh();
      }),
    onCreate: () =>
      runProjectAction(async () => {
        // 项目行的新建会话落在主智能体下（主智能体由 saveProject 幂等自举，本地项目
        // 打开即存在；远程项目没有本地主智能体，保持未归属）。导航列表页创建时同时
        // 进入该项目，让草稿立刻可见。
        navigation?.onOpen();
        onCreateTask({
          projectId: project.id,
          taskGroupId: project.hostId === "local" ? mainAgentGroupId(project.id) : null,
          ...(isWebRemoteControl || remoteHost ? { hostId: project.hostId } : {}),
        });
      }),
    onEditProject: () => onEdit({ project }),
    onViewFilesRoot: (rootPath: string) => runProjectAction(() => onViewFiles(project, rootPath)),
    onDelete: () =>
      runProjectAction(async () => {
        await service!.deleteProject(project.id, project.hostId);
        await refresh();
      }),
    onPin: () =>
      runProjectAction(async () => {
        await service!.saveProject({
          id: project.id,
          hostId: project.hostId,
          pinned: !project.pinned,
        });
        await refresh();
      }),
    /** 行内专属：workbench 会话拖放接纳（头部动作不含拖放目标）。 */
    onMove: (task: { workspacePath: string; workspaceIdentity?: string; taskId: string }) =>
      runProjectAction(async () => {
        if (!service) return;
        try {
          await service.moveTask({ task, projectId: project.id, hostId: project.hostId });
        } catch (cause) {
          if (
            project.hostId !== "local" ||
            !String(cause).includes("project.root-confirmation-required")
          )
            throw cause;
          if (!(await confirm({ title: msg("addFolder"), description: task.workspacePath })))
            return;
          await service.moveTask({
            task,
            projectId: project.id,
            hostId: project.hostId,
            addMissingRoot: true,
          });
        }
        await refresh();
      }),
  };
}

// Bug 根因：任务活动每秒更新目录，父组件随之重建所有项目的菜单与回调，穿透内容层 memo。
// 按项目隔离装配；数组只比较元素与顺序，其余属性完整比较，真实状态和回调变化仍需更新。
export const ProjectSidebarNode = memo(
  function ProjectSidebarNode(props: Props) {
    // onEdit/onViewFiles 的外层签名带 project 参数，不能透传给 ProjectNode；经 wiring
    // 转换后以转换名显式传入，解构排除是为了把它们从 rest 剔除（下划线前缀标记有意不用）。
    const {
      project,
      remoteHost,
      expanded,
      onExpandedChange,
      onSelect,
      tasks,
      children,
      onEdit: _onEditEntry,
      onViewFiles: _onViewFilesEntry,
      ...rest
    } = props;
    const wiring = useProjectRowWiring(props);
    const hideDeviceName = useHideDeviceName(props.isDesktop);
    return (
      <ProjectNode
        {...rest}
        project={project}
        remoteHost={remoteHost}
        hideDeviceName={hideDeviceName}
        expanded={expanded}
        onExpandedChange={(value) => onExpandedChange(project, value)}
        onSelect={onSelect}
        tasks={tasks}
        hasUnread={props.hasUnread}
        availability={props.availability}
        onEdit={wiring.onEditProject}
        onViewFiles={wiring.onViewFilesRoot}
        {...wiring}
      >
        {children}
      </ProjectNode>
    );
  },
  (previous, next) => {
    const { tasks: previousTasks, ...previousProps } = previous;
    const { tasks: nextTasks, ...nextProps } = next;
    return shallow(previousProps, nextProps) && shallow(previousTasks, nextTasks);
  },
);

function useHideDeviceName(isDesktop?: boolean) {
  // 本机偏好只控制桌面行内标签，手机与完整身份详情仍保留设备名。
  return useRobinRunStoreWithDefault(
    (state) => Boolean(isDesktop) && state.hideProjectDeviceNames,
    false,
  );
}

/** 智能体页头部动作（2026-11-15 裁决）：项目文件夹行移除后，行尾按钮原样上移到列表头。 */
export function ProjectHeaderActions({
  project,
  remoteHost,
  service,
  remoteService,
  isDesktop,
  isWebRemoteControl,
  onCreateTask,
  onReconnectRemoteWorkspace,
  onEdit,
  onViewFiles,
  remoteActions,
  refresh,
  availability,
}: Omit<
  Props,
  | "expanded"
  | "onExpandedChange"
  | "tasks"
  | "children"
  | "navigation"
  | "onSelect"
  | "hasUnread"
  | "diagnostics"
  | "deviceLabel"
>) {
  const wiring = useProjectRowWiring({
    project,
    remoteHost,
    service,
    remoteService,
    isDesktop,
    isWebRemoteControl,
    onCreateTask,
    onReconnectRemoteWorkspace,
    onEdit,
    onViewFiles,
    remoteActions,
    navigation: undefined,
    refresh,
    availability,
  });
  const editable = (availability?.online ?? true) && !project.legacySingleRoot;
  const lists = useProjectRowActionLists({
    project,
    availability: availability ?? { online: true },
    editable,
    additionalActions: wiring.additionalActions,
    onOpenDeviceSettings: wiring.onOpenDeviceSettings,
    onManageProjects: wiring.onManageProjects,
    onRemoveEntry: wiring.onRemoveEntry,
    onCreate: wiring.onCreate,
    onViewFiles: wiring.onViewFilesRoot,
    onEdit: wiring.onEditProject,
    onDelete: wiring.onDelete,
    onPin: wiring.onPin,
  });
  return (
    <div className="flex items-center gap-1">
      <ProjectRowActionButtons
        management={lists.management}
        files={lists.files}
        primaryRootDisabledReason={lists.primaryRootDisabledReason}
        showFiles={lists.showFiles}
        more={lists.more}
        online={availability?.online ?? true}
        onCreate={wiring.onCreate}
      />
    </div>
  );
}
