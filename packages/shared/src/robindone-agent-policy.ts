import { z } from "zod";
import type { CommandAgentSource } from "./command-types.js";
import type { RobinDoneProvider } from "./robindone-task-types-core.js";

export const ROBINDONE_AGENT_PROVIDER = "glm" satisfies RobinDoneProvider;
export const ROBINDONE_AGENT_PROVIDER_LABEL = "RobinDone Agent";
export const ROBINDONE_COMMAND_AGENT_SOURCE = "robindoneAgent" satisfies CommandAgentSource;

/**
 * 解析持久化/relay 数据时的 provider 归一 schema：
 * 已移除的第三方 provider 历史值仅作为归一化输入保留，统一收敛为 glm；
 * 其它非法值保持拒绝，与收窄前的校验边界一致。
 */
export const legacyRobinDoneProviderSchema = z
  .enum(["claude", "opencode", "gemini", "codex", "glm"])
  .transform((): typeof ROBINDONE_AGENT_PROVIDER => ROBINDONE_AGENT_PROVIDER);

export const ROBINDONE_ENABLED_AGENT_PROVIDERS = [
  ROBINDONE_AGENT_PROVIDER,
] as const satisfies readonly RobinDoneProvider[];

export const ROBINDONE_COMMAND_AGENT_SOURCES = [
  ROBINDONE_COMMAND_AGENT_SOURCE,
] as const satisfies readonly CommandAgentSource[];

export function normalizeAgentProviderToRobinDoneAgent(
  _provider?: RobinDoneProvider | null,
): RobinDoneProvider {
  return ROBINDONE_AGENT_PROVIDER;
}

export function normalizeAgentProvidersToRobinDoneAgent(
  _providers?: ReadonlyArray<RobinDoneProvider> | null,
): RobinDoneProvider[] {
  return [...ROBINDONE_ENABLED_AGENT_PROVIDERS];
}

export function normalizeCommandAgentSourceToRobinDoneAgent(
  _agentSource?: CommandAgentSource | null,
): CommandAgentSource {
  return ROBINDONE_COMMAND_AGENT_SOURCE;
}

export function isRobinDoneAgentProvider(
  provider: RobinDoneProvider | null | undefined,
): provider is typeof ROBINDONE_AGENT_PROVIDER {
  return provider === ROBINDONE_AGENT_PROVIDER;
}
