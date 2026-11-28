import type { Ref, ReactNode } from "react";
import { ArrowLeft, Search } from "lucide-react";
import type { ProjectSidebarProps } from "@/project-sidebar/contract.js";
import { Button } from "@/components/ui/button.js";
import { useRobinDoneIntl } from "@/i18n/IntlProvider.js";
import { formatCommandShortcutLabel } from "@/lib/keyboardShortcuts.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";

/**
 * 列表头部独立于导航和滚动内容。2026-11-15 项目列表导航裁决后头部有两种形态：
 * - 项目列表页（onBack 缺省）：标题=项目列表；
 * - 智能体页（onBack 存在）：返回箭头 + 进入的项目名。
 * 导航未启用的回退（web 远控树视图）沿用“智能体列表”标题。groupedActionsRef
 * 槽位仍承载折叠/新建等工具按钮（列表页由 ProjectList portal，智能体页由 TaskGroupedView portal）。
 * projectActions（2026-11-15 裁决）：智能体页移除项目文件夹行后，行尾按钮上移到标题行。
 */
export function ProjectSidebarListHeader({
  onOpenCommandCenter,
  groupedActionsRef,
  title,
  onBack,
  backLabel,
  projectActions,
}: {
  onOpenCommandCenter: ProjectSidebarProps["onOpenCommandCenter"];
  groupedActionsRef?: Ref<HTMLDivElement>;
  title: string;
  onBack?: () => void;
  backLabel?: string;
  projectActions?: ReactNode;
}) {
  const { intl } = useRobinDoneIntl();
  return (
    <div
      className="flex min-w-0 shrink-0 items-center gap-1 px-2 pb-2"
      data-testid="sidebar-search-toolbar"
    >
      {onBack ? (
        <ControlHintTooltip title={backLabel}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-foreground-subtle hover:text-foreground"
            data-testid="sidebar-project-back"
            aria-label={backLabel}
            onClick={onBack}
          >
            <ArrowLeft className="size-3.5" />
          </Button>
        </ControlHintTooltip>
      ) : null}
      <span
        data-testid="sidebar-list-title"
        className="min-w-0 flex-1 truncate px-2.5 text-ui-base font-medium text-foreground-subtle"
      >
        {title}
      </span>
      {projectActions}
      <div ref={groupedActionsRef} className="flex items-center gap-1" />
      <ControlHintTooltip
        // 原因：快捷键拼入标题会继承标题样式；用独立 shortcut 复用标准键帽。
        title={intl.formatMessage({ id: "commandCenter.open" })}
        shortcut={formatCommandShortcutLabel("k")}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-foreground-subtle hover:text-foreground"
          data-testid="sidebar-search-open"
          aria-label={intl.formatMessage({ id: "commandCenter.open" })}
          onClick={onOpenCommandCenter}
        >
          <Search className="size-3.5" />
        </Button>
      </ControlHintTooltip>
    </div>
  );
}
