export const ROBINDONE_BUILTIN_PROVIDER_CONFIG_FILE_ENV = "ROBINDONE_BUILTIN_PROVIDER_CONFIG_FILE";
export const ROBINDONE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV =
  "ROBINDONE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE";
export const ROBINDONE_PERSONAL_PROVIDER_CONFIG_FILE_ENV =
  "ROBINDONE_PERSONAL_PROVIDER_CONFIG_FILE";
export const PERSONAL_PROVIDER_CONFIG_FILE_NAME = "provider_config.json";

export interface NodeProviderRuntimePaths {
  readonly robindoneBuiltinFilePath: string;
  readonly personalFilePath: string;
}

export function createNodeProviderRuntimePathEnv(
  paths: NodeProviderRuntimePaths,
): Record<string, string> {
  return {
    [ROBINDONE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: paths.robindoneBuiltinFilePath,
    [ROBINDONE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: paths.personalFilePath,
  };
}

export function resolveNodeProviderRuntimePaths(
  env: Readonly<Record<string, string | undefined>>,
): NodeProviderRuntimePaths | null {
  const robindoneBuiltinFilePath = env[ROBINDONE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const personalFilePath = env[ROBINDONE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (!robindoneBuiltinFilePath && !personalFilePath) return null;
  if (!robindoneBuiltinFilePath || !personalFilePath) {
    throw new Error("RobinDone Built-in 与 Personal Provider Config 路径必须同时提供");
  }
  return Object.freeze({ robindoneBuiltinFilePath, personalFilePath });
}
