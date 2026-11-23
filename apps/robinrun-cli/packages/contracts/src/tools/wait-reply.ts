import { z } from "zod";
import {
  CONTACT_AGENT_MAX_TIMEOUT_MS,
  CONTACT_AGENT_MIN_TIMEOUT_MS,
} from "./contact-agent.js";
import { toToolJsonSchema } from "./json-schema.js";

// ============================================================
// WaitReply Tool - explicit wait for a previously submitted request
// ============================================================
// 2026-11-19 定稿（docs/trigger-system.md）：支持「先异步发出、稍后等待」（exec 式）。
// 同一 requestId 可多次调用；超时不销毁请求——期间回复到达则注入会话并唤醒，
// 之后再次 WaitReply 会得到 already_settled（回复已入会话历史；登记表内部命名
// unknown_request 由 handler 映射，模型不见该词）。

export const WAIT_REPLY_TOOL_NAME = "WaitReply";

export const WaitReplyInputSchema = z
  .object({
    requestId: z
      .string()
      .min(1)
      .max(200)
      .describe("The requestId returned by the ContactAgent call to wait on."),
    timeoutMs: z
      .number()
      .int()
      .min(CONTACT_AGENT_MIN_TIMEOUT_MS)
      .max(CONTACT_AGENT_MAX_TIMEOUT_MS)
      .optional()
      .describe("Max wait in milliseconds. Default 120000."),
  })
  .strict();

export type WaitReplyInput = z.infer<typeof WaitReplyInputSchema>;

export const WaitReplyInputJsonSchema = toToolJsonSchema(WaitReplyInputSchema);

export const WaitReplyOutputSchema = z
  .object({
    /**
     * replied：回复随本结果返回；timeout：超时未回（请求保持 open，可再次等待）；
     * already_settled：回复早已送达本会话历史（2026-11-23 修订：unknown_request 是
     * 登记表内部命名且易误读为故障，工具面映射为本值并指明去哪找回复；
     * no_reply_expected 从无生产路径，随死枚举清理移除）。
     */
    status: z.enum(["replied", "timeout", "already_settled"]),
    requestId: z.string(),
    text: z.string().optional(),
    sessionId: z.string().optional(),
    synthesized: z.boolean().optional(),
    message: z.string().optional(),
  })
  .strict();

export type WaitReplyOutput = z.infer<typeof WaitReplyOutputSchema>;

export const WaitReplyOutputJsonSchema = toToolJsonSchema(WaitReplyOutputSchema);
