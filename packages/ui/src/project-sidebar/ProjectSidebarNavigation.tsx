import { Blocks, ClipboardList } from "lucide-react";
import { TID_OPS_PANEL_OPEN } from "@robindone/shared/test-ids";
import type { ProjectSidebarProps } from "@/project-sidebar/contract.js";
import { Button } from "@/components/ui/button.js";
import { useRobinDoneIntl } from "@/i18n/IntlProvider.js";
import { WebRemoteControlDeviceHeader } from "@/web-remote-control/WebRemoteControlDeviceHeader.js";

/**
 * 顶部功能列表按页面区分（2026-11-24 用户裁决）：
 * - 项目列表页（未进入项目）：只显示插件市场——市场是全局的，与单个项目无关；
 * - 项目智能体页：只显示运营面板——面板展示的是当前项目的需求/审批/反馈，
 *   本来就与项目绑定，不该出现在项目列表外层；
 * - 自动化入口删除（触发器系统已承载其能力；自动化主视图路由保留给闲时任务组
 *   "+"等深链使用，此处不再提供顶级入口）。
 */
export function ProjectSidebarNavigation({
  props,
  agentPageMode,
}: {
  props: Pick<
    ProjectSidebarProps,
    | "isWebRemoteControl"
    | "onOpenPluginStore"
    | "pluginStoreActive"
    | "onOpenOpsPanel"
    | "opsPanelActive"
    | "webRemoteControlWorkspaceSwitcher"
  >;
  /** 项目智能体页（已点开项目）= true；项目列表页 = false。 */
  agentPageMode: boolean;
}) {
  const { intl } = useRobinDoneIntl();
  const deviceNavigation = props.webRemoteControlWorkspaceSwitcher?.deviceNavigation;
  return (
    <div
      data-testid="sidebar-primary-navigation"
      className={`flex flex-col gap-1 px-2 py-3 ${props.isWebRemoteControl && !deviceNavigation ? "max-md:pt-11" : ""}`}
    >
      {/* Relay V2 远控：当前电脑是项目与任务的上一级，放在导航首行；手机端占用原顶部留白。 */}
      {deviceNavigation ? <WebRemoteControlDeviceHeader navigation={deviceNavigation} /> : null}
      {/* 远控主视图会把整页主视图重置为聊天；入口必须一同隐藏，避免点击无效。 */}
      {!props.isWebRemoteControl && agentPageMode && props.onOpenOpsPanel ? (
        <Button
          variant="ghost"
          size="lg"
          className={`w-full justify-start gap-2 ${props.opsPanelActive ? "bg-selected text-foreground" : ""}`}
          aria-pressed={props.opsPanelActive ?? false}
          data-testid={TID_OPS_PANEL_OPEN}
          onClick={() => props.onOpenOpsPanel?.()}
        >
          <ClipboardList className="size-4" />
          {intl.formatMessage({ id: "workspace.openOpsPanel" })}
        </Button>
      ) : null}
      {!props.isWebRemoteControl && !agentPageMode ? (
        <Button
          variant="ghost"
          size="lg"
          className={`w-full justify-start gap-2 ${props.pluginStoreActive ? "bg-selected text-foreground" : ""}`}
          aria-pressed={props.pluginStoreActive ?? false}
          data-testid="plugin-store-sidebar-open"
          onClick={() => props.onOpenPluginStore?.()}
        >
          <Blocks className="size-4" />
          {intl.formatMessage({ id: "workspace.openPluginsSettings" })}
        </Button>
      ) : null}
    </div>
  );
}
