import type { RobinDoneSessionFile, RobinDoneTaskMeta } from "@robindone/shared";
import {
  robindoneSessionFileSchema,
  robindoneTaskMetaSchema,
  robindoneTaskModeSchema,
} from "@robindone/shared";

export type LegacyTaskSessionFile = Omit<RobinDoneSessionFile, "meta"> & {
  meta: Omit<RobinDoneTaskMeta, "mode"> & { mode?: RobinDoneTaskMeta["mode"] };
};

const legacyTaskSessionFileSchema = robindoneSessionFileSchema.extend({
  // Claude 原生迁移会按清洗路径删除 meta.mode。
  // legacy snapshot 读取/写入仍要校验其它必需字段，但不能再强制把被过滤字段补回文件。
  meta: robindoneTaskMetaSchema.extend({
    mode: robindoneTaskModeSchema.optional(),
  }),
});

export function parseLegacyTaskSessionFile(input: unknown): LegacyTaskSessionFile {
  return legacyTaskSessionFileSchema.parse(input);
}

export function safeParseLegacyTaskSessionFile(input: unknown) {
  return legacyTaskSessionFileSchema.safeParse(input);
}
