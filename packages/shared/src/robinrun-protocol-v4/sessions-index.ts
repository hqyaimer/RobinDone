// sessions-index topic：列表活性数据源；conflated 最新态，永不溢出。
import { z } from "zod";
import { timestampSchema } from "./core.js";
import { sessionWorkflowActivitySchema } from "./sessions-index-workflow-activity.js";
import {
  goalStateSchema,
  interactionAutoResolutionSchema,
  sessionMetaStateSchema,
  sessionPhaseSchema,
} from "./snapshot.js";

export const sessionPendingInteractionSummarySchema = z.object({
  interactionId: z.string(),
  kind: z.enum(["permission", "userInput"]),
  // 只下发轻量工具身份，侧栏据此区分 AskUserQuestion 与其他阻塞确认；不携带问题或答案。
  toolName: z.string().optional(),
  autoResolution: interactionAutoResolutionSchema.optional(),
});
export type SessionPendingInteractionSummary = z.infer<
  typeof sessionPendingInteractionSummarySchema
>;

export const pendingInteractionSummarySchema = z.object({
  permissionCount: z.number().int().nonnegative(),
  userInputCount: z.number().int().nonnegative(),
});
export type PendingInteractionSummary = z.infer<typeof pendingInteractionSummarySchema>;

// worker 会话身份（2026-11-16 隔离裁决的投影接缝）：host syncer 据此首见准入
// robinrun-worker-<workerId> 组，UI 据此判定只读。own seam——未来 worker 针对性
// 开发（状态机、审批、常驻唤醒）只扩展此对象，不碰 subagent 通道的字段。
export const sessionWorkerIdentitySchema = z
  .object({
    workerId: z.string().min(1),
    workerName: z.string().min(1),
  })
  .strict();
export type SessionWorkerIdentity = z.infer<typeof sessionWorkerIdentitySchema>;

// 会话创建来源（P2.5，2026-11-16）：内部处理机制，UI 不消费。kind 取值与
// RobinRunSessionCreationOrigin 一致；ref = 来源会话 id / automationId / offPeakTaskId。
export const sessionCreationOriginSchema = z
  .object({
    kind: z.enum(["user", "agent", "trigger", "system"]),
    ref: z.string().min(1).optional(),
  })
  .strict();
export type SessionCreationOrigin = z.infer<typeof sessionCreationOriginSchema>;

export const sessionSummarySchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  // fork 树。
  parentSessionId: z.string().optional(),
  // 创建来源（P2.5）：live 投影与冷种子都从 session 记录推导；缺席 = 旧数据按 user 处理。
  creationOrigin: sessionCreationOriginSchema.optional(),
  title: z.string(),
  // custom = 用户显式重命名；default/generated 都不是产品语义上的手动标题。
  // optional 是为了兼容旧 sessions-index frame / 旧持久化摘要。
  titleSource: sessionMetaStateSchema.shape.titleSource.optional(),
  lastOutcome: z.enum(["completed", "error", "interrupted"]).optional(),
  phase: sessionPhaseSchema,
  sessionEnded: z.boolean(),
  // 列表小圆点用（此处保留布尔，避免为侧栏订阅整个 backgroundWorks）。
  hasBackgroundWork: z.boolean(),
  // 侧栏工作流运行行：有界的 run 摘要，
  // 只装画迷你轨道要的字段；会话没有任何 run 时缺席。optional 兼容旧 frame / 旧 CLI。
  workflowActivity: sessionWorkflowActivitySchema.optional(),
  pendingInteraction: sessionPendingInteractionSummarySchema.optional(),
  // 侧栏只需要 kind/count，不下发问题、命令或答案等敏感 payload。
  // optional 兼容旧 sessions-index frame / stored summary。
  pendingInteractionSummary: pendingInteractionSummarySchema.optional(),
  goalStatus: goalStateSchema.shape.status.optional(),
  // worker 会话身份：worker_child 会话携带（live 投影填充）；缺席 = 非 worker 会话。
  worker: sessionWorkerIdentitySchema.optional(),
  // worker_child 类型标记（kind 事实）：live 与冷种子都能推导（taskType），跨 CLI 重启
  // 有效。UI 只读判定以本标记为准；worker 身份（上）只在 live 期存在，供 host 准入。
  workerChild: z.literal(true).optional(),
  // 未读推导：客户端本地记 lastSeenActivityAt 比较（不用 seq，epoch 会重置）。
  lastActivityAt: timestampSchema,
  // ≤120 字符。
  lastAssistantPreview: z.string().optional(),
  createdAt: timestampSchema,
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const sessionsIndexSnapshotSchema = z.object({
  protocolVersion: z.literal(1),
  workspaceId: z.string(),
  // host 级列表日志代际（与各 session 的 logEpoch 无关）。
  logEpoch: z.string(),
  // 无序；排序是客户端展示逻辑。
  sessions: z.array(sessionSummarySchema),
});
export type SessionsIndexSnapshot = z.infer<typeof sessionsIndexSnapshotSchema>;

export const sessionsIndexDeltaSchema = z.discriminatedUnion("op", [
  // conflation key = sessionId。
  z.object({ op: z.literal("session.upserted"), session: sessionSummarySchema }),
  z.object({ op: z.literal("session.removed"), sessionId: z.string() }),
]);
export type SessionsIndexDelta = z.infer<typeof sessionsIndexDeltaSchema>;

/** snapshot 缺席不是删除；按明确 ID 查询持久事实，不会创建或恢复运行实例。 */
export const sessionsIndexReconcileParamsSchema = z
  .object({
    workspaceId: z.string().min(1),
    sessionIds: z.array(z.string().min(1)).max(256),
  })
  .strict();
export type SessionsIndexReconcileParams = z.infer<typeof sessionsIndexReconcileParamsSchema>;
export const sessionsIndexReconcileResultSchema = z
  .object({
    sessions: z
      .array(
        z.discriminatedUnion("exists", [
          z
            .object({ sessionId: z.string(), exists: z.literal(false), deleted: z.literal(false) })
            .strict(),
          z
            .object({
              sessionId: z.string(),
              exists: z.literal(true),
              deleted: z.boolean(),
              title: z.string(),
              titleSource: sessionMetaStateSchema.shape.titleSource,
              createdAt: timestampSchema,
              updatedAt: timestampSchema,
              lastOutcome: z.enum(["completed", "error", "interrupted"]).optional(),
            })
            .strict(),
        ]),
      )
      .max(256),
  })
  .strict();
export type SessionsIndexReconcileResult = z.infer<typeof sessionsIndexReconcileResultSchema>;

/** sessions-index topic key 构造（与 parseSessionsIndexTopic 对偶）。 */
export function sessionsIndexTopic(workspaceId: string): string {
  return `sessions-index/${workspaceId}`;
}

/** sessions-index topic key 解析（"sessions-index/<workspaceId>"）。 */
export function parseSessionsIndexTopic(topic: string): string | null {
  if (!topic.startsWith("sessions-index/")) return null;
  const workspaceId = topic.slice("sessions-index/".length);
  return workspaceId.length > 0 ? workspaceId : null;
}
