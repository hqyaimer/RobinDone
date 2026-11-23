import {
  CONTACT_AGENT_DEFAULT_TIMEOUT_MS,
  WAIT_REPLY_TOOL_NAME,
  WaitReplyInputJsonSchema,
  WaitReplyInputSchema,
  WaitReplyOutputSchema,
  CoreErrorType,
  createCoreError,
  type WaitReplyInput,
  type WaitReplyOutput,
} from "@robinrun/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_WAIT_REPLY_MODEL_BYTES = 32_768;

const WAIT_REPLY_PROVIDER_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    status: { type: "string", enum: ["replied", "timeout", "already_settled"] },
    requestId: { type: "string" },
    message: { type: "string" },
  },
  required: ["status", "requestId"],
  additionalProperties: false,
};

// agent 消息（2026-11-19）：WaitReply = 主动等待，支持「先异步发出、稍后等待」
// （exec 式）。同一 requestId 可多次等待；超时不销毁请求——期间回复到达会注入
// 会话并唤醒，此后再等待得 unknown_request（回复已入会话历史）。
const waitReplyHandler: ToolHandler = async (input, context) => {
  const parsed = WaitReplyInputSchema.parse(input) as WaitReplyInput;

  if (!context.agentContactPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "WaitReply is only available to the main agent and roster workers (agentContactPort missing)",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: WAIT_REPLY_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  const waited = await context.agentContactPort.wait(
    parsed.requestId,
    parsed.timeoutMs ?? CONTACT_AGENT_DEFAULT_TIMEOUT_MS,
    context.abortSignal,
  );
  // 修复（2026-11-23，用户裁决 C4）：unknown_request 是登记表内部命名且此前的指引让
  // 模型找不存在的 "ContactAgentReply" 标签——工具面映射为 already_settled（良性状态：
  // 回复早已送达），指明按 <system-status> 来信识别，不再落"失败"语义诱导重发。
  const settledGuidance =
    "The reply was already delivered into this session's history; find it by its <system-status> block (the incoming message from the counterpart) instead of waiting again.";
  return {
    status: waited.status === "unknown_request" ? "already_settled" : waited.status,
    requestId: waited.requestId,
    ...(waited.text !== undefined ? { text: waited.text } : {}),
    ...(waited.sessionId !== undefined ? { sessionId: waited.sessionId } : {}),
    ...(waited.synthesized === true ? { synthesized: true } : {}),
    ...(waited.status === "unknown_request"
      ? { message: waited.message ?? settledGuidance }
      : waited.message !== undefined
        ? { message: waited.message }
        : {}),
  } satisfies WaitReplyOutput;
};

export const waitReplyToolEntry: ToolEntry = {
  capability: "Wait for the reply to a previously submitted ContactAgent request",
  metadata: {
    shouldDefer: true,
    name: WAIT_REPLY_TOOL_NAME,
    description: [
      "Wait for the reply to a ContactAgent request you submitted without waiting (the async-then-wait pattern).",
      "",
      "## Semantics",
      "",
      "- Pass the requestId returned by ContactAgent; timeoutMs caps the wait (default 120000 ms).",
      "- On timeout the request stays open: call WaitReply again to keep waiting, or end your turn and the reply will be injected into this session when it arrives.",
      "- A reply that arrived while nobody was waiting was already injected into your session; waiting again returns already_settled.",
      "- Replies with synthesized: true are system notices (for example, the counterpart was taken over by the user), not the counterpart's own output.",
    ].join("\n"),
    modelInstructions: [
      "Use WaitReply when you submitted a needReply=true ContactAgent request without waitFor and need the answer in this turn.",
      "already_settled is a good outcome, not a failure: the reply was delivered into this session's history earlier — find the incoming message carrying the counterpart's <system-status> block instead of waiting or resending.",
    ],
    allowedInPlanMode: true,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 600_000,
    maxOutputBytes: MAX_WAIT_REPLY_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: waitReplyHandler,
  formatModelContent: formatWaitReplyModelContent,
  inputSchema: WaitReplyInputJsonSchema,
  outputSchema: WAIT_REPLY_PROVIDER_OUTPUT_SCHEMA,
  runtimeInputSchema: WaitReplyInputSchema,
  runtimeOutputSchema: WaitReplyOutputSchema,
  permission: {
    permission: "agent.message.wait",
    reason: "WaitReply blocks on an in-flight agent contact request",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_WAIT_REPLY_MODEL_BYTES,
    maxModelBytes: MAX_WAIT_REPLY_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_WAIT_REPLY_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    // 等待上限即 timeoutMs 上限 600s；executor 兜底取消。
    defaultMs: 600_000,
    maxMs: 600_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "WaitReply was cancelled while waiting for the counterpart's reply",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatWaitReplyModelContent(output: unknown): string {
  const result = WaitReplyOutputSchema.parse(output);
  switch (result.status) {
    case "replied":
      return `Reply for request ${result.requestId}${result.synthesized === true ? " (system notice, not the counterpart's own output)" : ""}:\n\n${result.text ?? ""}`;
    case "timeout":
      return `Request ${result.requestId} has no reply yet. ${result.message ?? ""}`.trim();
    case "already_settled":
      return `Request ${result.requestId} was already settled. ${result.message ?? ""}`.trim();
  }
}
