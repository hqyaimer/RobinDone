import { useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  AlertTriangle,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderClosed,
  FolderOpen,
  Zap,
} from "lucide-react";
import type { TriggerStatus } from "@robinrun/shared";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { useRobinRunIntl } from "@/i18n/IntlProvider.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import type { TriggerSidebarEntry } from "@/project-sidebar/useTriggerSnapshots.js";
import {
  TASK_GROUP_COUNT_BADGE_CLASS,
  TASK_GROUP_ROW_CLASS,
  TASK_GROUP_ROW_LINE_CLASS,
} from "@/project-sidebar/grouped/types.js";

/**
 * 智能体节点内的固定"触发器"文件夹（2026-11-19 触发器系统 UI 裁决，
 * docs/trigger-system.md「UI 规格」节）。
 *
 * 渲染位置是智能体组内容区会话列表之后的静态 section：不注册 dnd-kit 的
 * draggable/droppable，也不进顶层虚拟化条目联合——触发器文件夹不参与拖拽，
 * 现有拖拽/虚拟化行为零回归。
 */

interface TriggerStatusAction {
  labelId: string;
  /** completed 是引擎写入的终态，不在可写集合——"重新启用"对 completed 发 active。 */
  status: Exclude<TriggerStatus, "completed">;
  triggerIds: string[];
}

/** 熔断徽章（2026-11-20 起唯一保留的文字状态：启用/停用由闪电图标色承载）。 */
function TriggerErrorPausedBadge() {
  const { intl } = useRobinRunIntl();
  return (
    <Badge className="border-transparent bg-destructive-surface text-destructive-surface-foreground">
      <AlertTriangle aria-hidden="true" data-icon="inline-start" />
      {intl.formatMessage({ id: "triggerSidebar.status.errorPaused" })}
    </Badge>
  );
}

/** 本地 webhook 完整地址：base 去尾斜杠 + 路由 path + token（token 双重校验的另一半）。 */
function buildWebhookTriggerUrl(baseUrl: string, path: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path}?token=${token}`;
}

function TriggerEntryRow({
  entry,
  boundTaskId,
  isActive,
  tooltipsDisabled,
  webhookBaseUrl,
  onCopyWebhookUrl,
  onSelect,
  onStatusAction,
  onResetSession,
  onDeleteTrigger,
}: {
  entry: TriggerSidebarEntry;
  boundTaskId: string | undefined;
  isActive: boolean;
  tooltipsDisabled?: boolean;
  webhookBaseUrl?: string;
  onCopyWebhookUrl?: (url: string) => void;
  onSelect: () => void;
  onStatusAction: (action: TriggerStatusAction) => void;
  onResetSession: (sessionKey: string) => void;
  onDeleteTrigger: () => void;
}) {
  const { intl } = useRobinRunIntl();
  // 完整 webhook 地址先算成局部常量：闭包里的 entry.webhook 窄化会被 TS 丢弃。
  const webhookUrl =
    entry.webhook !== undefined && webhookBaseUrl !== undefined
      ? buildWebhookTriggerUrl(webhookBaseUrl, entry.webhook.path, entry.webhook.token)
      : null;
  const actions = useMemo<TriggerStatusAction[]>(() => {
    // 组条目按成员各自状态精确作用（只动该状态的成员），直连条目退化为单触发器。
    const statuses = entry.memberStatuses ?? [entry.status];
    const idsWith = (status: TriggerStatus) =>
      entry.kind === "group"
        ? (entry.memberTriggerIds ?? []).filter((id, index) => statuses[index] === status)
        : entry.status === status
          ? [entry.id]
          : [];
    const actions: TriggerStatusAction[] = [];
    const disableIds = idsWith("active");
    if (disableIds.length > 0)
      actions.push({
        labelId: "triggerSidebar.action.disable",
        status: "deactivated",
        triggerIds: disableIds,
      });
    const enableIds = idsWith("deactivated");
    if (enableIds.length > 0)
      actions.push({
        labelId: "triggerSidebar.action.enable",
        status: "active",
        triggerIds: enableIds,
      });
    // completed（2026-11-21 常驻脚本 exit 0 终态）与 error-paused 同走"重新启用"
    // （= set_status active）：前者是一次性脚本的重跑入口，后者是熔断恢复。
    const reEnableIds = [...idsWith("error-paused"), ...idsWith("completed")];
    if (reEnableIds.length > 0)
      actions.push({
        labelId: "triggerSidebar.action.reEnable",
        status: "active",
        triggerIds: reEnableIds,
      });
    return actions;
  }, [entry]);
  const lastFireMs = entry.lastFireAt ? Date.parse(entry.lastFireAt) : Number.NaN;
  const timeLabel = Number.isFinite(lastFireMs) ? formatTaskRelativeTime(lastFireMs, intl) : null;
  const handleClick = () => {
    // 未触发过的条目没有可切换的会话（懒创建，首次触发才建），点击无效果。
    if (!boundTaskId) return;
    onSelect();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handleClick();
  };
  const row = (
    <div
      role={boundTaskId ? "button" : undefined}
      tabIndex={boundTaskId ? 0 : undefined}
      aria-disabled={boundTaskId ? undefined : "true"}
      data-testid={`agent-trigger-entry-${entry.id}`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        TASK_GROUP_ROW_CLASS,
        boundTaskId
          ? cn("cursor-pointer", isActive ? "bg-selected" : "hover:bg-surface-hover")
          : // 从未触发：不可点击样式，弱化为占位信息行。
            "cursor-default text-foreground-subtle",
      )}
    >
      <span className={TASK_GROUP_ROW_LINE_CLASS}>
        {/* 2026-11-20 列表密度裁决：与会话行前置状态槽同规格（size-4）占位，
            保证触发器条目标题与所在组的会话标题同一列对齐。
            状态改由闪电图标色承载（启用=绿/停用=灰/熔断=红），行尾不再放
            启用/停用 tag（占空间）；熔断保留文字徽章（需要解释的异常态）。 */}
        <span className="flex size-4 shrink-0 items-center justify-center">
          <Zap
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0",
              entry.status === "active"
                ? "text-success"
                : entry.status === "error-paused"
                  ? "text-destructive"
                  : "text-foreground-subtlest",
            )}
          />
        </span>
        <span className="min-w-0 truncate">{entry.name}</span>
        {entry.memberCount !== undefined ? (
          <span className="shrink-0 text-ui-xs text-foreground-subtlest">
            {intl.formatMessage(
              { id: "triggerSidebar.groupMemberCount" },
              { count: String(entry.memberCount) },
            )}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
          {entry.status === "error-paused" ? <TriggerErrorPausedBadge /> : null}
          {timeLabel ? <span className="mr-1">{timeLabel}</span> : null}
        </span>
      </span>
    </div>
  );
  return (
    <ContextMenu>
      {tooltipsDisabled || boundTaskId ? (
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="right" align="center" sideOffset={6}>
            <span className="text-ui-sm">
              {intl.formatMessage({ id: "triggerSidebar.notTriggered" })}
            </span>
          </TooltipContent>
        </Tooltip>
      )}
      <ContextMenuContent className="w-44">
        {actions.map((action) => (
          <ContextMenuItem key={action.labelId} onSelect={() => onStatusAction(action)}>
            {intl.formatMessage({ id: action.labelId })}
          </ContextMenuItem>
        ))}
        {/* 菜单风格（2026-11-21 用户裁决）：与普通会话右键菜单同风格，选项间不放
            分割线；触发器/组 id 不再展示（用户不需要知道内部 id）；删除属破坏性
            操作，固定放菜单最后。 */}
        {boundTaskId !== undefined ? (
          // 清空会话（2026-11-20）：清空消息 + 身份按当前订阅者重置，会话与绑定
          // 保留，下次 fire 在同一会话继续。仅在已有绑定时出现。
          <ContextMenuItem onSelect={() => onResetSession(entry.sessionKey)}>
            {intl.formatMessage({ id: "triggerSidebar.action.resetSession" })}
          </ContextMenuItem>
        ) : null}
        {webhookUrl !== null && onCopyWebhookUrl ? (
          // 本地 webhook 地址复制（2026-11-20 用户裁决：端口固定后跨重启稳定，
          // 服务重启后无从得知实际端口，需保留复制入口；2026-11-21 起不再展示
          // 地址文本——用户不需要读完整地址，复制后自行粘贴即可）。
          <ContextMenuItem onSelect={() => onCopyWebhookUrl(webhookUrl)}>
            {intl.formatMessage({ id: "triggerSidebar.action.copyWebhookUrl" })}
          </ContextMenuItem>
        ) : null}
        {entry.kind === "trigger" ? (
          // 伪删除（2026-11-21 实测裁决，与会话/智能体一致）：条目与文件保留、
          // 所有入口不可见；不可逆。确认流在 TaskGroupedView（破坏性操作先确认）。
          <ContextMenuItem variant="destructive" onSelect={() => onDeleteTrigger()}>
            {intl.formatMessage({ id: "triggerSidebar.action.delete" })}
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function AgentTriggerSection({
  ownerId,
  entries,
  sessionBindings,
  workspacePath,
  workspaceIdentity,
  activeTaskId,
  tooltipsDisabled,
  webhookBaseUrl,
  onCopyWebhookUrl,
  onSelectTask,
  onStatusAction,
  onResetSession,
  onDeleteTrigger,
}: {
  /** 订阅者身份（归属判定）：主智能体为 "master"，worker 为 wkr-id。 */
  ownerId: string;
  entries: TriggerSidebarEntry[];
  /** 会话 key → 绑定 taskId（引擎懒创建会话后回填；无绑定 = 尚未触发过）。 */
  sessionBindings: Record<string, string>;
  workspacePath: string;
  workspaceIdentity?: string;
  activeTaskId: string | null;
  tooltipsDisabled?: boolean;
  /** 本地 webhook 服务基址（引擎快照；缺席 = webhook 服务未起，地址菜单不出现）。 */
  webhookBaseUrl?: string;
  /** 复制 webhook 地址（TaskGroupedView 统一 clipboard + toast）。 */
  onCopyWebhookUrl?: (url: string) => void;
  /** 与会话行同一导航机制（rowActions.onSelectTask → 现有任务点击链路）。 */
  onSelectTask: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
  onStatusAction: (action: TriggerStatusAction) => void;
  /** 清空该条目绑定会话（UI 确认后调用；ownerId 供关闭视图后切订阅者草稿态）。 */
  onResetSession: (ownerId: string, sessionKey: string) => void;
  /** 伪删除直连触发器（组条目不出现删除项；UI 确认后调用）。 */
  onDeleteTrigger: (triggerId: string) => void;
}) {
  const { intl } = useRobinRunIntl();
  const [expanded, setExpanded] = useState(false);
  const boundTaskIdOf = useMemo(
    () => new Map(entries.map((entry) => [entry.id, sessionBindings[entry.sessionKey]])),
    [entries, sessionBindings],
  );
  if (entries.length === 0) return null;
  const folderMenu = (
    <ContextMenuContent className="w-56">
      {webhookBaseUrl !== undefined && onCopyWebhookUrl ? (
        <>
          <ContextMenuItem onSelect={() => onCopyWebhookUrl(webhookBaseUrl)}>
            {intl.formatMessage({ id: "triggerSidebar.action.copyWebhookBase" })}
          </ContextMenuItem>
          <ContextMenuItem disabled className="text-ui-xs text-foreground-subtlest">
            <span className="block truncate" title={webhookBaseUrl}>
              {webhookBaseUrl}
            </span>
          </ContextMenuItem>
        </>
      ) : null}
      <ContextMenuItem disabled className="text-ui-xs text-foreground-subtlest">
        {intl.formatMessage({ id: "triggerSidebar.ownerIdLabel" }, { id: ownerId })}
      </ContextMenuItem>
    </ContextMenuContent>
  );
  return (
    <div className="mt-0.5" data-testid={`agent-triggers-folder-${ownerId}`}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            data-testid="agent-triggers-folder"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
            className={cn(
              TASK_GROUP_ROW_CLASS,
              "cursor-pointer hover:bg-surface-hover",
              !expanded && "mb-0.5",
            )}
          >
            <span className={TASK_GROUP_ROW_LINE_CLASS}>
              {expanded ? (
                <ChevronDownIcon
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-foreground-subtlest"
                />
              ) : (
                <ChevronRightIcon
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-foreground-subtlest"
                />
              )}
              {expanded ? (
                <FolderOpen
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-foreground-subtle"
                />
              ) : (
                <FolderClosed
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-foreground-subtle"
                />
              )}
              <span className="min-w-0 truncate font-medium">
                {intl.formatMessage({ id: "triggerSidebar.folder" })}
              </span>
              <span className={cn(TASK_GROUP_COUNT_BADGE_CLASS, "ml-auto")}>{entries.length}</span>
            </span>
          </button>
        </ContextMenuTrigger>
        {folderMenu}
      </ContextMenu>
      {expanded ? (
        <div>
          {entries.map((entry) => {
            const boundTaskId = boundTaskIdOf.get(entry.id);
            return (
              <TriggerEntryRow
                key={`${entry.kind}:${entry.id}`}
                entry={entry}
                boundTaskId={boundTaskId}
                isActive={boundTaskId !== undefined && activeTaskId === boundTaskId}
                tooltipsDisabled={tooltipsDisabled}
                onSelect={() => {
                  if (boundTaskId === undefined) return;
                  onSelectTask(workspacePath, boundTaskId, workspaceIdentity);
                }}
                onStatusAction={onStatusAction}
                onResetSession={(sessionKey) => onResetSession(ownerId, sessionKey)}
                onDeleteTrigger={() => onDeleteTrigger(entry.id)}
                webhookBaseUrl={webhookBaseUrl}
                onCopyWebhookUrl={onCopyWebhookUrl}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export type { TriggerStatusAction };
