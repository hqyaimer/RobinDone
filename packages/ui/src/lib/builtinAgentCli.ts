import {
  normalizeAgentProviderToRobinDoneAgent,
  normalizeAgentProvidersToRobinDoneAgent,
  type RobinDoneProvider,
  type AppSettings,
} from "@robindone/shared";
const INSTALLABLE_AGENT_CLI_PROVIDERS: RobinDoneProvider[] = [];

export type BuiltinAgentCliStatus = "enabled" | "enabling" | "disabling" | "disabled";

function normalizeEnabledBuiltinAgentCliProviders(
  providers?: ReadonlyArray<RobinDoneProvider>,
): RobinDoneProvider[] {
  return normalizeAgentProvidersToRobinDoneAgent(providers);
}

export function getEnabledBuiltinAgentCliProviders(
  settings: Pick<AppSettings, "enabledBuiltinAgentCliProviders"> | null | undefined,
): RobinDoneProvider[] {
  return normalizeEnabledBuiltinAgentCliProviders(settings?.enabledBuiltinAgentCliProviders);
}

export function requiresBuiltinAgentCliInstall(provider: RobinDoneProvider): boolean {
  return INSTALLABLE_AGENT_CLI_PROVIDERS.includes(provider);
}

export function resolveBuiltinAgentCliStatus(params: {
  provider: RobinDoneProvider;
  enabledProviders: readonly RobinDoneProvider[];
  enablingProvider: RobinDoneProvider | null;
  disablingProvider: RobinDoneProvider | null;
}): BuiltinAgentCliStatus {
  // Bugfix: 非安装型内置 agent provider 已经由当前运行时提供，不依赖 settings.enabledBuiltinAgentCliProviders。
  // 这里统一返回 enabled，避免设置缺省、热更新或旧配置把 glm 误判成 disabled 并锁住发送入口。
  if (!requiresBuiltinAgentCliInstall(params.provider)) {
    return "enabled";
  }

  if (params.enablingProvider === params.provider) {
    return "enabling";
  }

  if (params.disablingProvider === params.provider) {
    return "disabling";
  }

  return params.enabledProviders.includes(params.provider) ? "enabled" : "disabled";
}

export function getEffectiveBuiltinAgentCliProvider(
  _settings: Pick<AppSettings, "enabledBuiltinAgentCliProviders"> | null | undefined,
  provider: RobinDoneProvider,
): RobinDoneProvider {
  // Bugfix: workspace/store 里的 selectedProvider 可能残留旧三方 provider。
  // 如果 UI 继续直接消费这个值，菜单和任务创建会把旧 agent 当作可用状态。
  // 这里统一回退到始终可用的 glm，避免 UI 状态和 agent server 单一事实源分叉。
  return normalizeAgentProviderToRobinDoneAgent(provider);
}
