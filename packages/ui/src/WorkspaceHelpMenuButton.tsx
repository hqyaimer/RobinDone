import { useState } from "react";
import { DesktopCommandIds } from "@robinrun/shared";
import {
  TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER,
  TID_WORKSPACE_HELP_MENU_TRIGGER,
} from "@robinrun/shared/test-ids";
import {
  ActivityIcon,
  // RobinRun(2026-11-22): [hide-upstream-account] 隐藏「帮助菜单上游外链项」的图标——恢复时取消本段注释
  // BookOpenIcon,
  // LightbulbIcon,
  // MessageSquareIcon,
  // ShieldAlertIcon,
  // UsersIcon,
  // RobinRun(2026-11-22): [hide-upstream-account] 隐藏结束
  CircleHelpIcon,
  CopyIcon,
  DownloadIcon,
  InfoIcon,
  RefreshCwIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { useDesktopUpdateMenu } from "@/hooks/useDesktopUpdateMenu.js";
import { usePlatform } from "@/hooks/usePlatform.js";
// RobinRun(2026-11-22): [hide-upstream-account] 隐藏「漏洞上报远程 URL」——URL 由上游远程下发，恢复时取消本段注释
// import { useVulnerabilityReportUrl } from "@/hooks/useVulnerabilityReportUrl.js";
// RobinRun(2026-11-22): [hide-upstream-account] 隐藏结束
import { useRobinRunIntl } from "@/i18n/IntlProvider.js";
import { createHelpMenuActionHandlers } from "@/lib/helpMenuActions.js";
import { toast } from "@/components/ui/toast.js";

export function WorkspaceHelpMenuButton({
  className,
  isDesktop = false,
}: {
  className?: string;
  /**
   * 是否桌面端。由挂载处注入而不是在组件内嗅探：Web 的 IPlatformService 桩同样实现了
   * executeDesktopCommand（no-op），拿它判定会让 Web 端出现一个点了没反应的「资源管理器」。
   */
  isDesktop?: boolean;
}) {
  const { intl } = useRobinRunIntl();
  const platform = usePlatform();
  const [open, setOpen] = useState(false);
  // RobinRun(2026-11-22): [hide-upstream-account] 隐藏「漏洞上报 URL / 产品建议入口」——恢复时取消本段注释
  // const { url: vulnerabilityReportUrl, loading: vulnerabilityReportLoading } =
  //   useVulnerabilityReportUrl(open);
  // RobinRun(2026-11-22): [hide-upstream-account] 隐藏结束
  const updateMenu = useDesktopUpdateMenu(isDesktop);
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  // RobinRun(2026-11-22): [hide-upstream-account] 隐藏「产品建议入口」——恢复时取消本行注释
  // const openFeatureRequest = useFeedbackStore((state) => state.openFeatureRequest);
  // RobinRun(2026-11-22): [hide-upstream-account] 隐藏结束
  const helpMenuLabel = intl.formatMessage({ id: "workspaceHeader.help.menu" });
  const helpMenuActions = createHelpMenuActionHandlers({
    platform,
    intl,
    openSubmit: openFeedbackSubmit,
  });
  // RobinRun(2026-11-22): [hide-upstream-account] 隐藏「用户社群入口」——恢复时取消本段注释
  // const handleOpenCommunity = () => {
  //   void platform.openCommunity();
  // };
  // RobinRun(2026-11-22): [hide-upstream-account] 隐藏结束
  const handleOpenResourceManager = () => {
    void platform.executeDesktopCommand(DesktopCommandIds.OpenResourceManager);
  };

  const handleShowAbout = () => {
    void platform.executeDesktopCommand(DesktopCommandIds.ShowAbout);
  };

  const handleCopyDeviceMid = async () => {
    try {
      const deviceMid = platform.getDeviceId();
      if (!deviceMid || typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(deviceMid);
      toast(intl.formatMessage({ id: "workspaceHeader.help.deviceMidCopied" }));
    } catch {
      toast(intl.formatMessage({ id: "workspaceHeader.help.deviceMidCopyFailed" }));
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <ControlHintTooltip title={helpMenuLabel} side="bottom">
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            // Settings 页会把帮助按钮绝对定位在 Electron 顶部拖拽区上方。
            // 只依赖外层容器 no-drag 时，真实 trigger 仍可能被标题栏 drag 区吞掉点击。
            className={cn(
              "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
              className,
            )}
            aria-label={helpMenuLabel}
            data-testid={TID_WORKSPACE_HELP_MENU_TRIGGER}
          >
            <CircleHelpIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent
        align="end"
        className="min-w-0 w-max [&_[data-slot=dropdown-menu-item]]:pr-6"
      >
        {/* RobinRun(2026-11-22): [hide-upstream-account] 隐藏「产品文档 / 用户社群 / 问题上报 / 漏洞上报 / 产品建议」
            五个上游触达菜单项（内容均为 ZCode 官方），恢复时取消本段注释 */}
        {/* <DropdownMenuItem onSelect={helpMenuActions.openProductDocs}>
          <BookOpenIcon className="size-4" />
          {intl.formatMessage({ id: "workspaceHeader.help.docs" })}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleOpenCommunity}>
          <UsersIcon className="size-4" />
          {intl.formatMessage({ id: "workspaceHeader.help.community" })}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={helpMenuActions.openIssueReport}>
          <MessageSquareIcon className="size-4" />
          {intl.formatMessage({ id: "workspaceHeader.help.issueReport" })}
        </DropdownMenuItem>
        {vulnerabilityReportLoading || vulnerabilityReportUrl ? (
          <DropdownMenuItem
            disabled={vulnerabilityReportLoading}
            aria-busy={vulnerabilityReportLoading}
            onSelect={
              vulnerabilityReportUrl
                ? () => platform.openExternal(vulnerabilityReportUrl)
                : undefined
            }
          >
            <ShieldAlertIcon className="size-4" />
            {intl.formatMessage({ id: "workspaceHeader.help.reportVulnerability" })}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={openFeatureRequest}>
          <LightbulbIcon className="size-4" />
          {intl.formatMessage({ id: "workspaceHeader.help.productRequest" })}
        </DropdownMenuItem>
        */}
        {/* RobinRun(2026-11-22): [hide-upstream-account] 隐藏结束 */}
        {/* Windows/Linux 没有原生菜单栏，自绘标题栏箭头菜单也已下线，
            资源管理器只能从这里进；Web 端没有该窗口，不渲染。 */}
        {isDesktop ? (
          <>
            <DropdownMenuSeparator />
            {/* 独立导出入口曾被移除；复用原菜单动作，保持打包、系统定位与提示一致。 */}
            <DropdownMenuItem onSelect={helpMenuActions.exportLogs}>
              <DownloadIcon className="size-4" />
              {intl.formatMessage({ id: "titleBar.menu.help.exportLogs" })}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleCopyDeviceMid}>
              <CopyIcon className="size-4" />
              {intl.formatMessage({ id: "workspaceHeader.help.copyDeviceMid" })}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid={TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER}
              onSelect={handleOpenResourceManager}
            >
              <ActivityIcon className="size-4" />
              {intl.formatMessage({ id: "titleBar.menu.help.resourceManager" })}
            </DropdownMenuItem>
            {updateMenu.visible ? (
              <DropdownMenuItem
                disabled={updateMenu.disabled}
                onSelect={updateMenu.checkForUpdates}
              >
                <RefreshCwIcon className="size-4" />
                {updateMenu.labelId === "desktopMenu.help.restartToUpdate" ? (
                  <>
                    <span className="whitespace-nowrap">
                      {intl.formatMessage({ id: "desktopMenu.help.restartUpdateAction" })}
                    </span>
                    <Badge
                      variant="secondary"
                      className="h-4 px-1.5 py-0 bg-success/10 text-success"
                    >
                      {updateMenu.labelValues?.version}
                    </Badge>
                  </>
                ) : (
                  intl.formatMessage({ id: updateMenu.labelId }, updateMenu.labelValues)
                )}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={handleShowAbout}>
              <InfoIcon className="size-4" />
              {intl.formatMessage({ id: "titleBar.menu.help.about" })}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
