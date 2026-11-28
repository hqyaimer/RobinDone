import { materializeRobinDoneBuiltinProviderConfig } from "@robindone/services/node";

declare const __ROBINDONE_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

export interface MaterializeBundledRobinDoneBuiltinProviderConfigOptions {
  readonly environmentConfigRoot: string;
  readonly content: string;
}

/** 返回构建时嵌入远端 Server 的 RobinDone Built-in Provider Config。 */
export function readBundledRobinDoneBuiltinProviderConfig(): string {
  if (typeof __ROBINDONE_BUILTIN_PROVIDER_CONFIG_JSON__ !== "string") {
    throw new Error("当前构建未嵌入 RobinDone Built-in Provider Config");
  }
  return __ROBINDONE_BUILTIN_PROVIDER_CONFIG_JSON__;
}

/**
 * 将 RobinDone Built-in Config 原子物化到所属环境的固定资源副本。
 * 升级前退出旧进程；不保留按内容 hash 增长的历史文件。
 */
export async function materializeBundledRobinDoneBuiltinProviderConfig(
  options: MaterializeBundledRobinDoneBuiltinProviderConfigOptions,
): Promise<string> {
  return materializeRobinDoneBuiltinProviderConfig(options);
}
