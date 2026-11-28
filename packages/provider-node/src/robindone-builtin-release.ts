import { z } from "zod";
import {
  parseRobinDoneBuiltinModelConfigRules,
  parseRobinDoneBuiltinProviderConfigRules,
  type ModelConfigRules,
  type ProviderConfigMap,
  type ProviderTemplateMap,
} from "@robindone/provider";

export const ROBINDONE_BUILTIN_RELEASE_SCHEMA_VERSION = 1 as const;
const RETIRED_ZAPI_PROVIDER_ID = "builtin:zapi";

export interface RobinDoneBuiltinConfigContent {
  readonly providers: ProviderConfigMap;
  readonly providerTemplates: ProviderTemplateMap;
  readonly modelConfigRules: ModelConfigRules;
}

export interface RobinDoneBuiltinRelease {
  readonly schemaVersion: typeof ROBINDONE_BUILTIN_RELEASE_SCHEMA_VERSION;
  readonly revision: number;
  readonly config: RobinDoneBuiltinConfigContent;
}

const releaseSchema = z
  .object({
    schemaVersion: z.literal(ROBINDONE_BUILTIN_RELEASE_SCHEMA_VERSION),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    config: z
      .object({
        providerConfigRules: z.unknown(),
        modelConfigRules: z.unknown(),
      })
      .strict(),
  })
  .strict();

export function decodeRobinDoneBuiltinRelease(input: unknown): RobinDoneBuiltinRelease {
  const parsed = releaseSchema.parse(input);
  const { providers, providerTemplates } = parseRobinDoneBuiltinProviderConfigRules(
    parsed.config.providerConfigRules,
  );
  // ZAPI 已退出产品，旧 Remote Release 或 LKG 不能在 Renderer 静态入口删除后
  // 又通过目标 Host Registry 将它重新发布。拒绝整份不兼容 Release，让 Source 回落到兼容候选。
  if (providers.has(RETIRED_ZAPI_PROVIDER_ID)) {
    throw new Error(
      `RobinDone Built-in Release 包含已退出的 Provider: ${RETIRED_ZAPI_PROVIDER_ID}`,
    );
  }
  return Object.freeze({
    schemaVersion: ROBINDONE_BUILTIN_RELEASE_SCHEMA_VERSION,
    revision: parsed.revision,
    config: Object.freeze({
      providers,
      providerTemplates,
      modelConfigRules: parseRobinDoneBuiltinModelConfigRules(parsed.config.modelConfigRules),
    }),
  });
}

export function encodeRobinDoneBuiltinRelease(release: RobinDoneBuiltinRelease): object {
  return {
    schemaVersion: ROBINDONE_BUILTIN_RELEASE_SCHEMA_VERSION,
    revision: release.revision,
    config: {
      providerConfigRules: {
        templateRules: release.config.providerTemplates.toJSON(),
        providerRules: release.config.providers.toJSON(),
      },
      modelConfigRules: release.config.modelConfigRules.toRobinDoneBuiltinJSON(),
    },
  };
}

export function serializeRobinDoneBuiltinRelease(release: RobinDoneBuiltinRelease): string {
  return JSON.stringify(encodeRobinDoneBuiltinRelease(release));
}
