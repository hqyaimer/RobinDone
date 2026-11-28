import { z } from "zod";

/**
 * RobinDone agent 提供方的单一真源。
 *
 * 类型 RobinDoneProvider、运行时 schema robindoneProviderSchema 都从这里派生,
 * 避免各处内联 z.enum([...]) 副本随新增/删除 provider 漂移。
 * 本模块只依赖 zod(叶子),可被 validation / robindone-protocol 等无环引用。
 */
export const ROBINDONE_PROVIDERS = ["glm"] as const;

export const robindoneProviderSchema = z.enum(ROBINDONE_PROVIDERS);

export type RobinDoneProvider = (typeof ROBINDONE_PROVIDERS)[number];
