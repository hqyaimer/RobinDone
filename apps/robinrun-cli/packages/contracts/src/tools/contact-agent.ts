import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

// ============================================================
// ContactAgent Tool - the single request entry of agent messaging
// ============================================================
// 2026-11-19 定稿（docs/trigger-system.md「agent 消息与会话感知系统」）：HTTP 请求/
// 响应模型。发起方投递请求；回复 = 接收端被请求触发轮次的最终输出，系统在轮终态
// 自动捕获回投（无回复工具）。层级边界：仅相邻层级（master↔worker）；worker↔worker
// 仍禁止。工具面注册门 = agentContactPort 在场（master 主会话 + worker 会话各自自建
// 端口，2026-11-20 同构化；已退役的 worker_child 派发类型仅存于历史会话投影）。

export const CONTACT_AGENT_TOOL_NAME = "ContactAgent";
export const CONTACT_AGENT_MAX_MESSAGE_CHARS = 20_000;
export const CONTACT_AGENT_DEFAULT_TIMEOUT_MS = 120_000;
export const CONTACT_AGENT_MIN_TIMEOUT_MS = 1_000;
export const CONTACT_AGENT_MAX_TIMEOUT_MS = 600_000;

export const ContactAgentInputSchema = z
  .object({
    target: z
      .string()
      .min(1)
      .max(200)
      .describe(
        'Counterpart: the main agent ("master") or a roster worker by its immutable wkr-* id.',
      ),
    message: z
      .string()
      .min(1)
      .max(CONTACT_AGENT_MAX_MESSAGE_CHARS)
      .describe("Plain text message content of the request."),
    sessionId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Session id to continue an exact prior conversation: the sessionId an earlier ContactAgent to this counterpart returned, or the fromSessionId in the <system-status> of a message they sent you. Omit it to start a NEW session - delivery never lands in an existing session implicitly.",
      ),
    needReply: z
      .boolean()
      .optional()
      .describe(
        "Whether you expect a reply (default true). The counterpart's turn-final output is returned to you as the reply. Pass false for notification-only requests - no reply will be delivered.",
      ),
    waitFor: z
      .boolean()
      .optional()
      .describe(
        "Block this tool call until the reply arrives or timeoutMs expires (requires needReply=true, default false). With false, use WaitReply later with the returned requestId; if your turn ends without waiting, the reply is injected into this session when it arrives.",
      ),
    timeoutMs: z
      .number()
      .int()
      .min(CONTACT_AGENT_MIN_TIMEOUT_MS)
      .max(CONTACT_AGENT_MAX_TIMEOUT_MS)
      .optional()
      .describe(
        `Max wait in milliseconds for this request's reply (used by waitFor and WaitReply). Default ${CONTACT_AGENT_DEFAULT_TIMEOUT_MS}.`,
      ),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.waitFor === true && input.needReply === false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["waitFor"],
        message: "waitFor requires needReply=true; notification-only requests have no reply to wait for.",
      });
    }
  });

export type ContactAgentInput = z.infer<typeof ContactAgentInputSchema>;

export const ContactAgentInputJsonSchema = toToolJsonSchema(ContactAgentInputSchema);

export const ContactAgentReplySchema = z
  .object({
    /** 接收端轮终态最终输出原样回投；synthesized=true 时为系统合成说明。 */
    text: z.string(),
    /** 回复来源会话地址（后续 ContactAgent 的 sessionId 续接地址）。 */
    sessionId: z.string().optional(),
    /** 合成回复（用户接管/轮次失败），非接收端原文。 */
    synthesized: z.boolean().optional(),
  })
  .strict();

export type ContactAgentReply = z.infer<typeof ContactAgentReplySchema>;

export const ContactAgentOutputSchema = z
  .object({
    /**
     * replied：回复随本工具结果返回；delivered：已投递待回复；timeout：尚未回复
     * （可再次 WaitReply）；already_settled：回复在本轮等待前已送达发送方会话历史
     * （2026-11-23 取代 return_scheduled——ReturnToDispatcher 已随脱钩语义退役，
     * 该状态无生产路径；unknown_request 是登记表内部命名，工具面统一映射为本值）；
     * failed：目标不可达。
     */
    status: z.enum(["replied", "delivered", "timeout", "already_settled", "failed"]),
    requestId: z.string(),
    /** 接收端会话地址（回话地址，后续 sessionId 参数用）。 */
    sessionId: z.string().optional(),
    reply: ContactAgentReplySchema.optional(),
    message: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();

export type ContactAgentOutput = z.infer<typeof ContactAgentOutputSchema>;

export const ContactAgentOutputJsonSchema = toToolJsonSchema(ContactAgentOutputSchema);

// ---- worker 变体（2026-11-23 C1 裁决）：同名工具、去必答参数 ----

/**
 * worker 会话的 ContactAgent 变体输入（2026-11-23 C1 裁决）：与 master 变体同名
 * （`ContactAgent`）同功能（跨会话投递），但**没有 needReply/waitFor/timeoutMs**——
 * worker 不允许要求必答（下级不强制上级应答），本变体天生 notification-only。
 * 注册时按会话身份二选一（runtime-tools），模型只见到自己用得了的参数形态，
 * 不再有"传 true 被拒绝重发"的试错浪费。寻址语义与 master 变体逐字一致。
 */
export const WorkerContactAgentInputSchema = z
  .object({
    target: z
      .string()
      .min(1)
      .max(200)
      .describe(
        'Counterpart: the main agent ("master") or a roster worker by its immutable wkr-* id.',
      ),
    message: z
      .string()
      .min(1)
      .max(CONTACT_AGENT_MAX_MESSAGE_CHARS)
      .describe("Plain text message content of the request."),
    sessionId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Session id to continue an exact prior conversation: the sessionId an earlier ContactAgent to this counterpart returned, or the fromSessionId in the <system-status> of a message they sent you. Omit it to start a NEW session - delivery never lands in an existing session implicitly.",
      ),
  })
  .strict();

export type WorkerContactAgentInput = z.infer<typeof WorkerContactAgentInputSchema>;

export const WorkerContactAgentInputJsonSchema = toToolJsonSchema(WorkerContactAgentInputSchema);

export const WorkerContactAgentOutputSchema = z
  .object({
    /** delivered：已投进对方会话（notification-only，无回复返回）；failed：目标不可达。 */
    status: z.enum(["delivered", "failed"]),
    requestId: z.string(),
    /** 接收端会话地址（后续 sessionId 续聊地址）。 */
    sessionId: z.string().optional(),
    message: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();

export type WorkerContactAgentOutput = z.infer<typeof WorkerContactAgentOutputSchema>;

export const WorkerContactAgentOutputJsonSchema = toToolJsonSchema(WorkerContactAgentOutputSchema);
