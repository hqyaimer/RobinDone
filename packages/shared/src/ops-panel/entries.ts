import { z } from "zod";

/**
 * 需求/审批/反馈面板（ops-panel）的协议层定义。
 *
 * 需求正身：RobinRunOps dev/specs/2026-11-24-需求审批反馈面板-需求说明.md（MVP=A 刀 +
 * worker 可见性控制）。三类管理原语从"对话"升级为"状态机"：
 * - REQ（requirement）：用户 → master 的工作单，用户已拍板无需审批；
 * - APP（approval）：master → 用户的非阻塞决策门；
 * - FBK（feedback）：任何人 → 系统的观察记录，经 master 分诊。
 *
 * 边界：本模块只是数据词汇表（条目/状态/事件/编号/作者），不依赖 trigger-system；
 * 系统特权订阅的播种与保护在 trigger-system（引擎）与装配层完成（见引擎
 * ensureSystemSubscription 与 docs/trigger-system.md）。
 */

/** 系统特权订阅（master 对三类面板事件的强制订阅）的触发器 id，固定值便于幂等播种与保护判定。 */
export const OPS_PANEL_SYSTEM_TRIGGER_ID = "trg-ops-panel" as const;
// 2026-11-25 用户裁决：侧栏显示名去掉"订阅"后缀（"运营面板"），订阅语义由条目类型
// （system 标记）与 README 说明承载；存量工作区靠 ensureSystemSubscriptionEntry 的
// name 幂等比对自动重播种改名（见 system-subscription.ts）。
export const OPS_PANEL_SYSTEM_TRIGGER_NAME = "运营面板" as const;

// ---------------------------------------------------------------------------
// 编号：类型前缀 + 序号（REQ-0001 / APP-0001 / FBK-0001），前缀由 kind 决定。
// ---------------------------------------------------------------------------

export const OPS_PANEL_ENTRY_ID_PATTERN = /^(REQ|APP|FBK)-(\d{3,})$/;

const OPS_ENTRY_ID_PREFIX: Record<OpsEntryKind, "REQ" | "APP" | "FBK"> = {
  requirement: "REQ",
  approval: "APP",
  feedback: "FBK",
};

/** kind → id 前缀（编号格式裁决：类型前缀 + 4 位零填充序号，超 9999 自然进位）。 */
export function opsEntryIdPrefix(kind: OpsEntryKind): "REQ" | "APP" | "FBK" {
  return OPS_ENTRY_ID_PREFIX[kind];
}

/** kind + 序号 → 条目编号（如 `REQ-0001`）。 */
export function formatOpsEntryId(kind: OpsEntryKind, seq: number): string {
  return `${opsEntryIdPrefix(kind)}-${String(seq).padStart(4, "0")}`;
}

/** 条目编号 → 所属 kind；非面板编号返回 null。 */
export function parseOpsEntryKind(id: string): OpsEntryKind | null {
  const match = OPS_PANEL_ENTRY_ID_PATTERN.exec(id);
  if (match === null) return null;
  const prefix = match[1];
  const kind = (Object.keys(OPS_ENTRY_ID_PREFIX) as OpsEntryKind[]).find(
    (candidate) => OPS_ENTRY_ID_PREFIX[candidate] === prefix,
  );
  return kind ?? null;
}

// ---------------------------------------------------------------------------
// kind / 作者
// ---------------------------------------------------------------------------

/** 三类原语（需求 §1）。 */
export const opsEntryKindSchema = z.enum(["requirement", "approval", "feedback"]);
export type OpsEntryKind = z.infer<typeof opsEntryKindSchema>;

/**
 * 作者（需求 §5）：`user` / `master` / `worker:<workerId>`。
 * 智能体侧作者由调用会话身份机制层派生（不采信模型传值），UI 侧恒为 user。
 */
export const opsAuthorSchema = z
  .string()
  .regex(
    /^(user|master|worker:[A-Za-z0-9][A-Za-z0-9._-]*)$/,
    "Author must be user|master|worker:<id>",
  );
export type OpsAuthor = z.infer<typeof opsAuthorSchema>;

/** 调用会话身份 → 作者标记：worker 会话带 wkr-id，master/用户侧无。 */
export function opsAuthorForAgent(workerId?: string): OpsAuthor {
  return workerId === undefined || workerId.length === 0 ? "master" : `worker:${workerId}`;
}

/** 作者 → 智能体标识：user 返回 null，master 返回 "master"，worker 返回 wkr-id。 */
export function opsAgentIdOfAuthor(author: OpsAuthor): string | null {
  if (author === "user") return null;
  if (author === "master") return "master";
  return author.slice("worker:".length);
}

/** 面板事件名（需求 §3，三类唤醒事件）。 */
export const opsPanelEventNameSchema = z.enum([
  "requirement.created",
  "approval.decided",
  "feedback.created",
]);
export type OpsPanelEventName = z.infer<typeof opsPanelEventNameSchema>;

/** kind → 事件名（事件与唤醒语义一一对应；approval.created 不是唤醒事件，无映射）。 */
export const OPS_PANEL_EVENT_BY_KIND: Record<OpsEntryKind, OpsPanelEventName> = {
  requirement: "requirement.created",
  approval: "approval.decided",
  feedback: "feedback.created",
};

/**
 * kind → 创建事件名（2026-11-24 用户裁决：需求/反馈由 master 对话代录后不再自唤醒，
 * requirement.created 退出订阅面——创建事件的唤醒与否由订阅配置 wakeRules 决定；
 * approval 创建无事件（其唤醒走 approval.decided）。缺席 = 创建永不唤醒。
 */
export const OPS_PANEL_CREATION_EVENT_BY_KIND: Record<OpsEntryKind, OpsPanelEventName | undefined> =
  {
    requirement: "requirement.created",
    approval: undefined,
    feedback: "feedback.created",
  };

// ---------------------------------------------------------------------------
// 状态机（需求 §2，MVP 最小集）
// ---------------------------------------------------------------------------

/** REQ：已提交 → 处理中 → 已处置（处置 = 四选一结果 + 备注）。 */
export const requirementStatusSchema = z.enum(["submitted", "in_progress", "disposed"]);
export type RequirementStatus = z.infer<typeof requirementStatusSchema>;

/** REQ 处置结果四选一（受理/拒绝/挂起/转审批）；受理后的开发排期不占唤醒队列。 */
export const requirementOutcomeSchema = z.enum([
  "accepted",
  "rejected",
  "suspended",
  "converted_to_approval",
]);
export type RequirementOutcome = z.infer<typeof requirementOutcomeSchema>;

/** APP：待审 → 已批准 / 已驳回（执行确认走 ack 标记，不新增用户可见状态）。 */
export const approvalStatusSchema = z.enum(["pending_review", "approved", "rejected"]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

/** FBK：已提交 → 已处理（MVP 的"处理"= master 改状态 + 可选备注）。 */
export const feedbackStatusSchema = z.enum(["submitted", "processed"]);
export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;

/** 串行唤醒队列状态：none=不入队；pending=待唤醒；in_flight=已唤醒待处置；released=处置完成。 */
export const opsWakeupStateSchema = z.enum(["none", "pending", "in_flight", "released"]);
export type OpsWakeupState = z.infer<typeof opsWakeupStateSchema>;

// ---------------------------------------------------------------------------
// 条目（per-kind discriminated union）
// ---------------------------------------------------------------------------

const isoTimestampSchema = z.string().min(1);

/** 关联追溯预留字段（需求 §2/§8：MVP 不做升格/链接逻辑与 UI，仅存取）。 */
const opsLinksSchema = z.record(z.string().min(1).max(64), z.string().min(1).max(128));

const opsEntryBaseShape = {
  /** 条目编号（如 `REQ-0001`），workspace 内唯一（与 kind 前缀联动）。 */
  id: z.string().regex(OPS_PANEL_ENTRY_ID_PATTERN, "Entry id must look like REQ-0001"),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
  /**
   * 作者（需求 §5）：`user` / `master` / `worker:<workerId>`。
   * 智能体侧作者由调用会话身份机制层派生（不采信模型传值），UI 侧恒为 user。
   */
  author: opsAuthorSchema,
  /**
   * 录入者（2026-11-24 用户裁决：录入与来源拆分）——谁把这条记录写进台账：
   * user=用户亲手（UI）；master=master 代录（author=user 的需求/反馈由用户对话转述，
   * master 落账）；worker:<id>=worker 自录。作者=来源，录入者=经手人，代录条目
   * （author=user && recordedBy=master）面板显示代录角标。
   */
  recordedBy: opsAuthorSchema,
  /** 处置/处理备注（REQ 四选一附注、FBK 分诊备注、APP 驳回理由/执行备注共用）。 */
  note: z.string().max(4_000).optional(),
  links: opsLinksSchema.optional(),
  /** 处置/决定时间（REQ 处置、APP 批准/驳回、FBK 分诊）。 */
  decidedAt: isoTimestampSchema.optional(),
  /** APP 执行确认时间（master ack 后置位；队列释放点，非用户可见状态）。 */
  acknowledgedAt: isoTimestampSchema.optional(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
} as const;

/** 面板条目（三 kind 同表存储，传输层按 kind 判别）。 */
export const opsPanelEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...opsEntryBaseShape,
      kind: z.literal("requirement"),
      status: requirementStatusSchema,
      /** 已处置时必填四选一结果。 */
      outcome: requirementOutcomeSchema.optional(),
    })
    .strict()
    .superRefine((entry, ctx) => {
      if (entry.status === "disposed" && entry.outcome === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outcome"],
          message: "disposed requirement requires an outcome",
        });
      }
    }),
  z
    .object({
      ...opsEntryBaseShape,
      kind: z.literal("approval"),
      status: approvalStatusSchema,
    })
    .strict(),
  z
    .object({
      ...opsEntryBaseShape,
      kind: z.literal("feedback"),
      status: feedbackStatusSchema,
    })
    .strict(),
]);
export type OpsPanelEntry = z.infer<typeof opsPanelEntrySchema>;

// ---------------------------------------------------------------------------
// 视图投影（面板/工具读取的返回形状）
// ---------------------------------------------------------------------------

/** 待处理队列投影：in_flight 至多一条（串行），pending 按入队先后排序。 */
export const opsPanelQueueViewSchema = z
  .object({
    inFlightId: z.string().nullable(),
    pendingIds: z.array(z.string()),
  })
  .strict();
export type OpsPanelQueueView = z.infer<typeof opsPanelQueueViewSchema>;

/** 面板整体视图（UI getPanelView / 工具 list 的返回本体）。 */
export const opsPanelViewSchema = z
  .object({
    entries: z.array(opsPanelEntrySchema),
    queue: opsPanelQueueViewSchema,
  })
  .strict();
export type OpsPanelView = z.infer<typeof opsPanelViewSchema>;

/** 一次串行唤醒投递的载荷（面板服务 → host 投递端口；host 据此寻址 master 主会话）。 */
export interface OpsPanelWakeupRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  projectId?: string;
  /** 系统订阅触发器 id（systemStatus 来源区块 + 审计溯源用）。 */
  triggerId: string;
  triggerName: string;
  eventName: string;
  /** 本次唤醒的唯一在途条目（串行：一次一条）。 */
  entry: OpsPanelEntry;
}

/**
 * 调用者身份（权限矩阵的载体）：user=UI 侧用户；agent=智能体（master 或 worker:<id>）。
 * 智能体身份由 CLI 机制层从会话派生后随反向端口请求携带；服务层据此做权限矩阵与
 * worker 可见性过滤（需求 §4：数据/接口层过滤，不是 UI 隐藏）。
 */
export const opsPanelActorSchema = z.union([
  z.object({ role: z.literal("user") }).strict(),
  z.object({ role: z.literal("agent"), agentId: opsAuthorSchema }).strict(),
]);
export type OpsPanelActor = z.infer<typeof opsPanelActorSchema>;

/** agent actor 的 agentId → 作者标记（两者共用词表：master / worker:<id>）。 */
export function opsAuthorOfActor(actor: OpsPanelActor): OpsAuthor {
  return actor.role === "user" ? "user" : actor.agentId;
}
