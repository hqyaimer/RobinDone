import type {
  ModelSelection,
  RobinDoneAgentMcpServer,
  RobinDoneAutomationScheduleRule,
  RobinDoneMcpListMode,
} from "@robindone/shared";
import type {
  McpAppsAppToolCallResult,
  McpAppsAppToolDescriptor,
} from "@robindone/shared/mcp-apps";

export interface RobinDoneAgentWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 远程 workspace 的运行时会话身份；只用于隔离/路由，不能替代 workspacePath。 */
  remoteSessionId?: string;
}

export interface RobinDoneAgentPluginMutationTarget extends RobinDoneAgentWorkspaceTarget {
  /** 仅 Host 观测使用；不会传给 CLI。 */
  telemetry?: {
    entry?:
      | "store_list"
      | "store_detail"
      | "side_pane_market"
      | "recommended_prompt"
      | "recommended_ui"
      | "component_settings";
    client_kind?: "desktop" | "mobile";
    trigger?: "user" | "automatic" | "dependency" | "restore" | "sync";
  };
}

export interface RobinDoneAgentPluginViewParams extends RobinDoneAgentWorkspaceTarget {
  configScope?: "user" | "workspace";
}

export interface RobinDoneAgentListMcpServerStatusesParams extends RobinDoneAgentWorkspaceTarget {
  mcpServers?: RobinDoneAgentMcpServer[];
  mode?: RobinDoneMcpListMode;
}

export interface RobinDoneAgentAddPluginMarketplaceParams extends RobinDoneAgentPluginMutationTarget {
  dryRun?: boolean;
  operationId?: string;
  source: string;
}

export interface RobinDoneAgentRemovePluginMarketplaceParams extends RobinDoneAgentPluginMutationTarget {
  marketplace: string;
}

export interface RobinDoneAgentUpdatePluginMarketplaceParams extends RobinDoneAgentPluginMutationTarget {
  marketplace?: string;
  operationId?: string;
}

export interface RobinDoneAgentInstallPluginParams extends RobinDoneAgentPluginMutationTarget {
  dryRun?: boolean;
  marketplace: string;
  operationId?: string;
  pluginName: string;
  scope?: "user" | "workspace";
}

export interface RobinDoneAgentCancelPluginOperationParams {
  operationId: string;
}

export interface RobinDoneAgentUninstallPluginParams extends RobinDoneAgentPluginMutationTarget {
  marketplace?: string;
  pluginId?: string;
  pluginName?: string;
  removeCache?: boolean;
}

export interface RobinDoneAgentUpdatePluginParams extends RobinDoneAgentPluginMutationTarget {
  pluginId?: string;
  marketplace?: string;
}

export interface RobinDoneAgentRestoreBuiltinPluginParams extends RobinDoneAgentPluginMutationTarget {
  pluginId: string;
}

export interface RobinDoneAgentConfigurePluginParams extends RobinDoneAgentPluginMutationTarget {
  clearOptionKeys?: string[];
  dryRun?: boolean;
  options: Record<string, unknown>;
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface RobinDoneAgentResetPluginConfigParams extends RobinDoneAgentPluginMutationTarget {
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface RobinDoneAgentValidatePluginParams extends RobinDoneAgentWorkspaceTarget {
  marketplace?: string;
  pluginName?: string;
  source?: string;
}

export interface RobinDoneAgentDescribePluginParams extends RobinDoneAgentWorkspaceTarget {
  marketplace: string;
  pluginName: string;
}

export interface RobinDoneAgentSetPluginEnabledParams extends RobinDoneAgentPluginMutationTarget {
  enabled: boolean;
  operationId?: string;
  pluginId: string;
  scope?: "user" | "workspace";
}

// Plugin 对话引用 catalog：
// 带 sessionId → session-owned 冻结 catalog（必须路由到持有该 session 的 workspace client）；
// 不带 → workspace 当前 catalog（新建草稿 Picker）。
export interface RobinDoneAgentPluginReferenceCatalogParams extends RobinDoneAgentWorkspaceTarget {
  sessionId?: string;
}

// Composer Skill catalog：与 Plugin 引用相同，以 sessionId 区分 workspace 当前目录和
// resident Session runtime 快照；不参与 Settings 管理目录。
export interface RobinDoneAgentSkillReferenceCatalogParams extends RobinDoneAgentWorkspaceTarget {
  sessionId?: string;
}

/** 插件 UI：UI 发起的 `ui://` 资源读取。 */
export interface RobinDoneAgentReadMcpResourceParams extends RobinDoneAgentWorkspaceTarget {
  instance: import("@robindone/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  uri: string;
}

/** 插件 UI 页面发起的 `resources/read`；参数与 readMcpResource 同形，结果受 8 MiB 与 mimeType 白名单约束。 */
export type RobinDoneAgentReadMcpResourceForUiParams = RobinDoneAgentReadMcpResourceParams;

/** 插件 UI：UI 回调本插件工具；不进审批流，归属由 agent 侧 catalog fail closed。 */
export interface RobinDoneAgentCallMcpToolForUiParams extends RobinDoneAgentWorkspaceTarget {
  instance: import("@robindone/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  /** 宿主生成的调用 id，配合 cancelMcpToolCallForUi。 */
  callId: string;
}
/** 插件 UI 页面发起的 resources/list、resources/templates/list、subscribe、unsubscribe。 */
export interface RobinDoneAgentListMcpResourcesForUiParams extends RobinDoneAgentWorkspaceTarget {
  instance: import("@robindone/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  cursor?: string;
}
/** App-Provided Tools：实例身份 = 会话 + 沙箱作用域 + 代际。 */
export interface RobinDoneAgentAppToolInstanceForUiParams extends RobinDoneAgentWorkspaceTarget {
  instance: import("@robindone/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  scopeId: string;
  generation: number;
}
export interface RobinDoneAgentRegisterAppToolsForUiParams extends RobinDoneAgentAppToolInstanceForUiParams {
  tools: McpAppsAppToolDescriptor[];
}
export interface RobinDoneAgentAppToolCallForUiParams extends RobinDoneAgentAppToolInstanceForUiParams {
  callId: string;
}
export interface RobinDoneAgentResolveAppToolCallForUiParams extends RobinDoneAgentAppToolCallForUiParams {
  result?: McpAppsAppToolCallResult;
  error?: { message: string };
}
export interface RobinDoneAgentMcpResourceSubscriptionForUiParams extends RobinDoneAgentWorkspaceTarget {
  instance: import("@robindone/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  scopeId: string;
  generation: number;
  uri: string;
}
export interface RobinDoneAgentCancelMcpToolCallForUiParams extends RobinDoneAgentWorkspaceTarget {
  instance: import("@robindone/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  callId: string;
}
export interface RobinDoneAgentResolveSuggestedPluginReferenceParams extends RobinDoneAgentWorkspaceTarget {
  stableId: string;
  operationId: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  deliveryKind: "desktop-continuous" | "web-remote-replayable";
}

// ---- 定时任务(automation)管理参数 ----

export interface RobinDoneAgentCreateAutomationParams extends RobinDoneAgentWorkspaceTarget {
  projectId?: string | null;
  title: string;
  cronExpr: string;
  relativeDelayMinutes?: number;
  prompt: string;
  modelSelection?: ModelSelection;
  mode?: string;
  recurring?: boolean;
  maxRuns?: number;
  endAt?: number;
  scheduleRule?: RobinDoneAutomationScheduleRule;
}

export interface RobinDoneAgentUpdateAutomationParams extends RobinDoneAgentWorkspaceTarget {
  automationId: string;
  title?: string;
  cronExpr?: string;
  prompt?: string;
  modelSelection?: ModelSelection | null;
  mode?: string | null;
  recurring?: boolean;
  maxRuns?: number | null;
  endAt?: number | null;
  scheduleRule?: RobinDoneAutomationScheduleRule | null;
  scheduleEditedByUser?: boolean;
}

export interface RobinDoneAgentAutomationIdParams extends RobinDoneAgentWorkspaceTarget {
  automationId: string;
}

export interface RobinDoneAgentSetAutomationEnabledParams extends RobinDoneAgentWorkspaceTarget {
  automationId: string;
  enabled: boolean;
}

export interface RobinDoneAgentDeleteAutomationRunParams extends RobinDoneAgentWorkspaceTarget {
  runId: string;
}
