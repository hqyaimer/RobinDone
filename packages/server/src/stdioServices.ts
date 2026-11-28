import { createLocalServices, type RobinDoneAgentCommandResolver } from "@robindone/services/node";
import type { IChannel } from "@robindone/rpc";
import {
  parseServiceAuthorityMode,
  ROBINDONE_REMOTE_HTTP_PROXY_ENV_KEY,
  ROBINDONE_REMOTE_NO_PROXY_ENV_KEY,
  ROBINDONE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
} from "@robindone/shared";

export interface CreateStdioServicesOptions {
  topicResourceRelayChannel?: () => IChannel;
  env?: Record<string, string | undefined>;
  robindoneBuiltinProviderConfigFilePath: string;
  robindoneAgentCommandResolver?: RobinDoneAgentCommandResolver;
}

export interface RemoteAgentNetworkOptions {
  httpProxy?: string;
  noProxy?: string;
}

export function resolveRemoteAgentNetworkFromEnv(
  env: Record<string, string | undefined>,
): RemoteAgentNetworkOptions | undefined {
  if (env[ROBINDONE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY]?.trim() !== "1") {
    return undefined;
  }
  return {
    httpProxy: env[ROBINDONE_REMOTE_HTTP_PROXY_ENV_KEY]?.trim() || undefined,
    noProxy: env[ROBINDONE_REMOTE_NO_PROXY_ENV_KEY]?.trim() || undefined,
  };
}

export function createStdioServices(options: CreateStdioServicesOptions) {
  const env = options.env ?? process.env;
  const authorityModeParseResult = parseServiceAuthorityMode(env);
  const remoteAgentNetwork = resolveRemoteAgentNetworkFromEnv(env);
  // 远程 Desktop 的呈现能力必须从 stdio 入口收到的 authority mode 进入 Services 推导链。
  // 测试注入 resolver 只用于在 spawn 前观察最终命令，不改变生产默认 resolver。
  const services = createLocalServices({
    robindoneBuiltinProviderConfigFilePath: options.robindoneBuiltinProviderConfigFilePath,
    topicResourceRelayChannel: options.topicResourceRelayChannel,
    serviceAuthorityMode: authorityModeParseResult.mode,
    robindoneAgentCommandResolver: options.robindoneAgentCommandResolver,
    remoteAgentNetwork,
  });

  return {
    authorityModeParseResult,
    services,
  };
}
