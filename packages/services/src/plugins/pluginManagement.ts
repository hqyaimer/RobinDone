// 平台能力面收敛：设置页「插件管理」的薄服务接口。
//
// 背景：pluginManagementStore / usePluginUninstall 过去直接注入 IRobinDoneAgentService，
// UI 层因此散布 13 个 plugins/* 旧协议词的消费点。收敛为独立薄 service 后，UI 只依赖
// 本接口；plugins/* 词表的 host 侧消费点收拢到 pluginManagementService 一处（插件的
// 事实源在 robindone-cli 进程，服务实现仍经 agent 协议往返——plugins 词表的收口归属
// 插件能力面自身的协议演进，不在会话 v4 词表范围内）。
// 注意与既有 IPluginsService（已 retired 的 marketplace pluginStore 通道）区分：
// 那套接口按 pluginName+marketplace 寻址且方法语义过时，不复用避免签名冲突。
import type { Event } from "@robindone/rpc";
import type {
  RobinDonePluginOperationProgressNotification,
  RobinDonePluginsConfigureResult,
  RobinDonePluginsCancelOperationResult,
  RobinDonePluginsDescribeResult,
  RobinDonePluginsInstallResult,
  RobinDonePluginsListResult,
  RobinDonePluginsMarketplaceMutationResult,
  RobinDonePluginsOverviewResult,
  RobinDonePluginsReferenceCatalogResult,
  RobinDonePluginsRestoreBuiltinResult,
  RobinDonePluginsSetEnabledResult,
  RobinDonePluginsUninstallResult,
  RobinDonePluginsValidateResult,
} from "@robindone/shared";
import { ServiceChannels } from "@robindone/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  RobinDoneAgentAddPluginMarketplaceParams,
  RobinDoneAgentConfigurePluginParams,
  RobinDoneAgentCancelPluginOperationParams,
  RobinDoneAgentDescribePluginParams,
  RobinDoneAgentInstallPluginParams,
  RobinDoneAgentPluginReferenceCatalogParams,
  RobinDoneAgentResolveSuggestedPluginReferenceParams,
  RobinDoneAgentResetPluginConfigParams,
  RobinDoneAgentPluginViewParams,
  RobinDoneAgentRemovePluginMarketplaceParams,
  RobinDoneAgentRestoreBuiltinPluginParams,
  RobinDoneAgentSetPluginEnabledParams,
  RobinDoneAgentUninstallPluginParams,
  RobinDoneAgentUpdatePluginMarketplaceParams,
  RobinDoneAgentUpdatePluginParams,
  RobinDoneAgentValidatePluginParams,
} from "../robindone-agent/robindoneAgentPluginParams.js";

export interface IPluginManagementService {
  listPlugins(params: RobinDoneAgentPluginViewParams): Promise<RobinDonePluginsListResult>;
  /**
   * Plugin 对话引用 catalog：
   * 带 sessionId → session-owned 冻结 catalog；不带 → workspace 当前 catalog。
   * 实现路由到 workspace 级 agent client，不走插件管理独立进程。
   */
  getPluginReferenceCatalog(
    params: RobinDoneAgentPluginReferenceCatalogParams,
  ): Promise<RobinDonePluginsReferenceCatalogResult>;
  resolveSuggestedPluginReference(
    params: RobinDoneAgentResolveSuggestedPluginReferenceParams,
  ): Promise<import("@robindone/shared").RobinDonePluginsResolveSuggestedReferenceResult>;
  onDynamicPluginOperationProgress(
    operationId: string,
  ): Event<RobinDonePluginOperationProgressNotification>;
  getPluginsOverview(
    params: RobinDoneAgentPluginViewParams,
  ): Promise<RobinDonePluginsOverviewResult>;
  addPluginMarketplace(
    params: RobinDoneAgentAddPluginMarketplaceParams,
  ): Promise<RobinDonePluginsMarketplaceMutationResult>;
  removePluginMarketplace(
    params: RobinDoneAgentRemovePluginMarketplaceParams,
  ): Promise<RobinDonePluginsMarketplaceMutationResult>;
  updatePluginMarketplace(
    params: RobinDoneAgentUpdatePluginMarketplaceParams,
  ): Promise<RobinDonePluginsMarketplaceMutationResult>;
  installPlugin(params: RobinDoneAgentInstallPluginParams): Promise<RobinDonePluginsInstallResult>;
  cancelPluginOperation(
    params: RobinDoneAgentCancelPluginOperationParams,
  ): Promise<RobinDonePluginsCancelOperationResult>;
  uninstallPlugin(
    params: RobinDoneAgentUninstallPluginParams,
  ): Promise<RobinDonePluginsUninstallResult>;
  updatePlugin(params: RobinDoneAgentUpdatePluginParams): Promise<RobinDonePluginsInstallResult>;
  restoreBuiltinPlugin(
    params: RobinDoneAgentRestoreBuiltinPluginParams,
  ): Promise<RobinDonePluginsRestoreBuiltinResult>;
  configurePlugin(
    params: RobinDoneAgentConfigurePluginParams,
  ): Promise<RobinDonePluginsConfigureResult>;
  resetPluginConfig(
    params: RobinDoneAgentResetPluginConfigParams,
  ): Promise<RobinDonePluginsConfigureResult>;
  validatePlugin(
    params: RobinDoneAgentValidatePluginParams,
  ): Promise<RobinDonePluginsValidateResult>;
  describePlugin(
    params: RobinDoneAgentDescribePluginParams,
  ): Promise<RobinDonePluginsDescribeResult>;
  setPluginEnabled(
    params: RobinDoneAgentSetPluginEnabledParams,
  ): Promise<RobinDonePluginsSetEnabledResult>;
}

export const IPluginManagementService = createServiceDescriptor<IPluginManagementService>(
  ServiceChannels.PluginManagement,
);

/** 入口只附加观测上下文；RPC 方法由 Proxy 动态提供，不能通过对象展开复制。 */
export function withPluginTelemetry(
  service: IPluginManagementService,
  telemetry: NonNullable<RobinDoneAgentInstallPluginParams["telemetry"]>,
): IPluginManagementService {
  const mutations = new Set<PropertyKey>([
    "addPluginMarketplace",
    "removePluginMarketplace",
    "updatePluginMarketplace",
    "installPlugin",
    "uninstallPlugin",
    "updatePlugin",
    "restoreBuiltinPlugin",
    "configurePlugin",
    "resetPluginConfig",
    "setPluginEnabled",
  ]);
  return new Proxy(service, {
    get(target, property) {
      const method = Reflect.get(target, property, target);
      if (typeof method !== "function") return method;
      if (!mutations.has(property)) return method.bind(target);
      return (params: RobinDoneAgentInstallPluginParams) =>
        method.call(target, { ...params, telemetry });
    },
  });
}
