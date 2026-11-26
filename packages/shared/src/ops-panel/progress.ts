import { z } from "zod";

/**
 * 项目进度账本（运营面板·进度 tab）的协议层定义。
 *
 * 需求正身：specs/progress-ledger.md（2026-11-25）。追加式项目里程碑台账，只呈现
 * 有效记录（最终态）：master 独占维护（原位 update/delete，无修订史无角标），用户
 * 纯只读，worker 不读不写；无状态机、无事件面（不唤醒不通知）——与 entries.ts 的
 * REQ/APP/FBK 工作项体系刻意分离（不进 kind 判别、不共用状态机）。
 *
 * 边界：本模块只是数据词汇表；写入权限（机制层 actor 派生 + 服务层 assert master）
 * 与系统锚条目的幂等播种在 services ops-panel 完成。
 */

// ---------------------------------------------------------------------------
// 编号：PRG 前缀 + 序号（PRG-0001），workspace 内递增不复用（软删不释放编号）。
// ---------------------------------------------------------------------------

export const PROGRESS_ENTRY_ID_PATTERN = /^PRG-(\d{3,})$/;

/** 序号 → 条目编号（如 `PRG-0001`）。 */
export function formatProgressEntryId(seq: number): string {
  return `PRG-${String(seq).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// 条目
// ---------------------------------------------------------------------------

const isoTimestampSchema = z.string().min(1);

/** 关联文件路径（≤8 条）：进度与知识/状态文件的融合点，UI 可点击打开右栏预览。 */
export const progressLinksSchema = z.array(z.string().min(1).max(512)).max(8);

/** 记录者词表：master=master 落账；system=系统锚条目（播种，可编辑不可删）。 */
export const progressCreatedBySchema = z.enum(["master", "system"]);
export type ProgressCreatedBy = z.infer<typeof progressCreatedBySchema>;

/**
 * 进度条目：无状态机的事件事实（发生了什么），原位维护制（update/delete 直改，
 * 不产生任何可见痕迹）。body 可空——一行标题即完整条目；深度内容进 links 指向的
 * 文件（账本不堆料）。
 */
export const progressEntrySchema = z
  .object({
    /** 条目编号（如 `PRG-0001`），workspace 内唯一。 */
    id: z.string().regex(PROGRESS_ENTRY_ID_PATTERN, "Progress entry id must look like PRG-0001"),
    title: z.string().min(1).max(200),
    body: z.string().max(20_000).optional(),
    links: progressLinksSchema.optional(),
    createdBy: progressCreatedBySchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type ProgressEntry = z.infer<typeof progressEntrySchema>;

// ---------------------------------------------------------------------------
// 视图投影（进度 tab / list_progress 的返回形状）
// ---------------------------------------------------------------------------

/** 进度视图：现存条目（软删已过滤）时间正序（rowid 序 = 插入序）。 */
export const progressViewSchema = z
  .object({
    entries: z.array(progressEntrySchema),
  })
  .strict();
export type ProgressView = z.infer<typeof progressViewSchema>;

// ---------------------------------------------------------------------------
// 系统锚条目（每个 workspace 首次触达进度时幂等播种；master 可编辑、不可删）
// ---------------------------------------------------------------------------

/** 锚条目固定词（播种文案单一收口）。 */
export const PROGRESS_ANCHOR_TITLE = "项目初始化";
export const PROGRESS_ANCHOR_BODY = "项目工作空间已创建，运营进度由此开始记录。";
