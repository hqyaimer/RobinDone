import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

// ============================================================
// ManageOpsPanel Tool - 需求/审批/反馈面板的智能体工具面
// ============================================================
// 2026-11-24 MVP（RobinRunOps dev/specs 需求说明）：三类管理原语（REQ/APP/FBK）
// 的状态机 + master 串行唤醒队列。智能体不直连面板服务，经 OpsPanelRuntimePort
// 反向请求落到 host 的 IOpsPanelService（权限矩阵在服务层强制，本文件只是形状）。
// 同名双变体先例 = ContactAgent（2026-11-23 C1）：master/worker 两个输入 schema
// 同名注册，按会话身份二选一——模型只见到自己用得了的动作（权限矩阵 §4）。
// 条目形状与 @robinrun/shared opsPanelEntrySchema 同构；contracts 不组合另一份
// zod 实例的 schema（manage-triggers 输出镜像同款约定），形状漂移由契约测试守。

export const MANAGE_OPS_PANEL_TOOL_NAME = "ManageOpsPanel";

/** master 变体动作面（12）：读全部/单读/代录需求/起草审批/代录或自录反馈/处置需求/分诊反馈/确认执行 + 进度账本读/追加/原位改/删除（2026-11-25，specs/progress-ledger.md）。 */
export const MANAGE_OPS_PANEL_MASTER_ACTIONS = [
  "list",
  "get",
  "create_requirement",
  "create_approval",
  "create_feedback",
  "decide_requirement",
  "resolve_feedback",
  "acknowledge_approval",
  "list_progress",
  "append_progress",
  "update_progress",
  "delete_progress",
] as const;
/** worker 变体动作面（3，权限矩阵 §4）：只读自己提交的条目 + 提反馈。 */
export const MANAGE_OPS_PANEL_WORKER_ACTIONS = ["list", "get", "create_feedback"] as const;

const entryIdSchema = z
  .string()
  .regex(/^(REQ|APP|FBK|PRG)-(\d{3,})$/, "Entry id must look like REQ-0001 / PRG-0001");

/** 条目输出镜像（strict，形状对齐 @robinrun/shared opsPanelEntrySchema）。 */
const opsPanelEntryOutputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("requirement"),
      id: entryIdSchema,
      title: z.string(),
      body: z.string(),
      author: z.string(),
      recordedBy: z.string(),
      status: z.enum(["submitted", "in_progress", "disposed"]),
      outcome: z.enum(["accepted", "rejected", "suspended", "converted_to_approval"]).optional(),
      note: z.string().optional(),
      decidedAt: z.string().optional(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("approval"),
      id: entryIdSchema,
      title: z.string(),
      body: z.string(),
      author: z.string(),
      recordedBy: z.string(),
      status: z.enum(["pending_review", "approved", "rejected"]),
      note: z.string().optional(),
      decidedAt: z.string().optional(),
      acknowledgedAt: z.string().optional(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("feedback"),
      id: entryIdSchema,
      title: z.string(),
      body: z.string(),
      author: z.string(),
      recordedBy: z.string(),
      status: z.enum(["submitted", "processed"]),
      note: z.string().optional(),
      decidedAt: z.string().optional(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .strict(),
]);

const opsPanelQueueOutputSchema = z
  .object({
    inFlightId: z.string().nullable(),
    pendingIds: z.array(z.string()),
  })
  .strict();

/** 进度条目输出镜像（strict，形状对齐 @robinrun/shared progressEntrySchema；2026-11-25 进度账本）。 */
const progressEntryOutputSchema = z
  .object({
    id: z.string().regex(/^PRG-(\d{3,})$/, "Progress entry id must look like PRG-0001"),
    title: z.string(),
    body: z.string().optional(),
    links: z.array(z.string()).optional(),
    createdBy: z.enum(["master", "system"]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

const opsPanelOutputBase = {
  /** list 返回全部可见条目（worker 只见自己提交的；过滤在 host 服务层）。 */
  entries: z.array(opsPanelEntryOutputSchema).optional(),
  /** master 待处理唤醒队列（串行：inFlight 至多一条）。仅 list 返回。 */
  queue: opsPanelQueueOutputSchema.optional(),
  /** get / 写动作返回受影响条目本体。 */
  entry: opsPanelEntryOutputSchema.optional(),
  /** list_progress 返回现存进度条目（时间正序，软删已过滤）。 */
  progressEntries: z.array(progressEntryOutputSchema).optional(),
  /** append_progress / update_progress 返回受影响进度条目本体。 */
  progressEntry: progressEntryOutputSchema.optional(),
  /** delete_progress 返回被删条目编号（软删：读路径过滤，UI 无痕）。 */
  deletedProgressId: z.string().optional(),
  message: z.string().optional(),
  error: z.string().optional(),
} as const;

/** master 变体输出。 */
export const ManageOpsPanelOutputSchema = z.object(opsPanelOutputBase).strict();
export type ManageOpsPanelOutput = z.infer<typeof ManageOpsPanelOutputSchema>;
export const ManageOpsPanelOutputJsonSchema = toToolJsonSchema(ManageOpsPanelOutputSchema);

// ---- master 变体（主会话）：读全部 + 起草审批/反馈 + 处置/分诊/确认执行 ----

export const ManageOpsPanelInputSchema = z
  .object({
    action: z
      .enum(MANAGE_OPS_PANEL_MASTER_ACTIONS)
      .describe(
        "list: all panel entries plus the pending wakeup queue; get: one entry by id; create_requirement: record a user requirement on their behalf (the user told you in conversation; author is always \"user\", recording does not wake anyone); create_approval: draft a decision item for the user (you cannot decide approvals; state the background in the body - what is being proposed and why, and what approving vs rejecting means - the user decides from that text alone and the executing session acts on that context); create_feedback: record feedback - author \"user\" when the user reported it in conversation, \"master\" for your own observation (recording never wakes you); decide_requirement: dispose a requirement (accepted / rejected / suspended / converted_to_approval, disposal releases the wakeup queue); resolve_feedback: mark feedback processed (releases the queue); acknowledge_approval: confirm an approval decision has been executed (releases the queue); list_progress: read the project progress ledger (milestone timeline, chronological); append_progress: record a project milestone (final states only); update_progress: fix a milestone entry in place (no edit history is kept); delete_progress: remove an ineffective or mistaken entry (the system anchor cannot be deleted).",
      ),
    entryId: entryIdSchema
      .optional()
      .describe("Target entry id (required by get / decide_requirement / resolve_feedback / acknowledge_approval / update_progress / delete_progress); PRG-prefixed for progress actions, REQ/APP/FBK for panel entries."),
    title: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Short title (required by create_requirement / create_approval / create_feedback / append_progress; optional replacement by update_progress)."),
    body: z
      .string()
      .max(20_000)
      .optional()
      .describe("Full content (required by create_requirement / create_approval / create_feedback; optional detail for append_progress, optional replacement for update_progress - empty string clears it)."),
    links: z
      .array(z.string().min(1).max(512))
      .max(8)
      .optional()
      .describe("Related file paths, max 8 (append_progress / update_progress): the ledger stays one line per milestone and depth lives in these files; clickable in the panel. Empty array clears links."),
    author: z
      .enum(["user", "master"])
      .optional()
      .describe('Source attribution (required by create_feedback): "user" when the user reported it in conversation, "master" for your own observation.'),
    outcome: z
      .enum(["accepted", "rejected", "suspended", "converted_to_approval"])
      .optional()
      .describe(
        "Requirement disposal result (required by decide_requirement). accepted items enter normal development planning afterwards; that planning does NOT occupy this wakeup queue.",
      ),
    note: z
      .string()
      .max(4_000)
      .optional()
      .describe("Optional note: disposal rationale, triage remark, rejection reason, or execution summary."),
  })
  .strict()
  .superRefine((input, ctx) => {
    const needsEntry =
      input.action === "get" ||
      input.action === "decide_requirement" ||
      input.action === "resolve_feedback" ||
      input.action === "acknowledge_approval" ||
      input.action === "update_progress" ||
      input.action === "delete_progress";
    if (needsEntry && input.entryId === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entryId"], message: `${input.action} requires entryId.` });
    }
    const needsContent =
      input.action === "create_requirement" ||
      input.action === "create_approval" ||
      input.action === "create_feedback";
    if (
      needsContent &&
      (input.title === undefined || input.body === undefined || input.body.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["title"],
        message: `${input.action} requires title and body.`,
      });
    }
    if (input.action === "decide_requirement" && input.outcome === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: "decide_requirement requires outcome." });
    }
    // author 只在 create_feedback 出现（create_requirement 恒 user、create_approval 恒
    // master 由服务层派生，模型不传）——传了即违约，防语义漂移。
    if (input.author !== undefined && input.action !== "create_feedback") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["author"],
        message: "author is only valid for create_feedback.",
      });
    }
    // master 代录反馈必须声明来源（服务层同样拒绝缺席——双层守一致）。
    if (input.action === "create_feedback" && input.author === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["author"],
        message:
          'create_feedback requires author ("user" when the user reported it in conversation, "master" for your own observation).',
      });
    }
    // 进度动作（2026-11-25 进度账本）：append_progress 必带 title；面板专属字段
    // （author/outcome/note）不得混入进度动作——防语义漂移（同上方 author 纪律）。
    if (input.action === "append_progress" && input.title === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["title"],
        message: "append_progress requires title.",
      });
    }
    // body 放宽为可空串只为 update_progress 的"清空详情"语义（2026-11-25 实测缺陷
    // P2-5：文档承诺空串清空、输入层却 min(1) 拒收）；其余动作 body 出现时必须
    // 非空——append_progress 空详情无意义，省略字段即可。
    if (
      input.action !== "update_progress" &&
      input.body !== undefined &&
      input.body.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body"],
        message: `${input.action} requires a non-empty body (omit the field instead).`,
      });
    }
    if (
      (input.action === "list_progress" ||
        input.action === "append_progress" ||
        input.action === "update_progress" ||
        input.action === "delete_progress") &&
      (input.author !== undefined || input.outcome !== undefined || input.note !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["action"],
        message: "Progress actions accept title/body/links only (no author/outcome/note).",
      });
    }
    // 编号前缀互斥：进度动作只吃 PRG-，面板条目动作只吃 REQ/APP/FBK-（schema 放宽
    // 是为了共用 entryId 字段，语义边界在这里锁死）。
    if (
      input.entryId !== undefined &&
      (input.action === "update_progress" || input.action === "delete_progress") &&
      !input.entryId.startsWith("PRG-")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entryId"],
        message: "Progress actions require a PRG-prefixed entry id.",
      });
    }
    if (
      input.entryId !== undefined &&
      (input.action === "get" ||
        input.action === "decide_requirement" ||
        input.action === "resolve_feedback" ||
        input.action === "acknowledge_approval") &&
      input.entryId.startsWith("PRG-")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entryId"],
        message: "Panel entry actions require a REQ/APP/FBK entry id.",
      });
    }
  });

export type ManageOpsPanelInput = z.infer<typeof ManageOpsPanelInputSchema>;
export const ManageOpsPanelInputJsonSchema = toToolJsonSchema(ManageOpsPanelInputSchema);

// ---- worker 变体（worker 会话，同名）：只读自己提交的条目 + 仅提反馈 ----

/**
 * worker 变体输入（权限矩阵 §4）：worker 只能 list/get 自己提交的条目（完整生命
 * 周期可见，过滤在 host 服务数据层）与提交反馈；提需求/提审批/处置/分诊/确认执行
 * 均不在 worker 工具面——诉求一律经"反馈"入口向上走。
 */
export const WorkerManageOpsPanelInputSchema = z
  .object({
    action: z
      .enum(MANAGE_OPS_PANEL_WORKER_ACTIONS)
      .describe(
        "list: YOUR OWN submitted entries only (you cannot see other agents' items); get: one of your entries by id; create_feedback: record an observation for master triage (submitting does not wake you).",
      ),
    entryId: entryIdSchema.optional().describe("Target entry id (required by get); must be one you submitted."),
    title: z.string().min(1).max(200).optional().describe("Short title (required by create_feedback)."),
    body: z.string().min(1).max(20_000).optional().describe("Full content (required by create_feedback)."),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.action === "get" && input.entryId === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entryId"], message: "get requires entryId." });
    }
    if (input.action === "create_feedback" && (input.title === undefined || input.body === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["title"],
        message: "create_feedback requires title and body.",
      });
    }
  });

export type WorkerManageOpsPanelInput = z.infer<typeof WorkerManageOpsPanelInputSchema>;
export const WorkerManageOpsPanelInputJsonSchema = toToolJsonSchema(WorkerManageOpsPanelInputSchema);

/** worker 变体输出（形状与 master 一致，数据范围由服务层过滤）。 */
export const WorkerManageOpsPanelOutputSchema = z.object(opsPanelOutputBase).strict();
export type WorkerManageOpsPanelOutput = z.infer<typeof WorkerManageOpsPanelOutputSchema>;
export const WorkerManageOpsPanelOutputJsonSchema = toToolJsonSchema(WorkerManageOpsPanelOutputSchema);
