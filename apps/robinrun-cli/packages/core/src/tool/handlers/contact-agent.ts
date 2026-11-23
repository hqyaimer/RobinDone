import {
  CONTACT_AGENT_DEFAULT_TIMEOUT_MS,
  CONTACT_AGENT_TOOL_NAME,
  ContactAgentInputJsonSchema,
  ContactAgentInputSchema,
  ContactAgentOutputSchema,
  CoreErrorType,
  WorkerContactAgentInputJsonSchema,
  WorkerContactAgentInputSchema,
  WorkerContactAgentOutputSchema,
  createCoreError,
  type ContactAgentInput,
  type ContactAgentOutput,
  type TraceContext,
  type WorkerContactAgentInput,
  type WorkerContactAgentOutput,
} from "@robinrun/contracts";
import { createContactRequestId } from "../../subagent/agent-contact.js";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_CONTACT_AGENT_MODEL_BYTES = 32_768;

const CONTACT_AGENT_PROVIDER_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["replied", "delivered", "timeout", "already_settled", "failed"],
    },
    requestId: { type: "string" },
    sessionId: { type: "string" },
    message: { type: "string" },
  },
  required: ["status", "requestId"],
  additionalProperties: false,
};

// agent 消息（2026-11-19，docs/trigger-system.md「agent 消息与会话感知系统」）：
// ContactAgent = 唯一请求入口。回复 = 接收端轮终态最终输出，系统自动捕获回投——
// handler 只做投递 + （waitFor 时）等待。2026-11-20 worker 会话同构化：本端口升格为
// master↔worker 的唯一通道（投递 = Host 任务服务寻址创建/唤醒目标会话），master 主
// 会话与 worker 会话各建一份（子代理不建，天然无此工具面）。
const contactAgentHandler: ToolHandler = async (input, context) => {
  const parsed = ContactAgentInputSchema.parse(input) as ContactAgentInput;

  if (!context.agentContactPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "ContactAgent is only available to master and worker sessions with a host delivery channel (agentContactPort missing)",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: CONTACT_AGENT_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  const requestId = createContactRequestId();
  // C1 裁决（2026-11-23，用户拍板）：只有 master 可以要求必答。worker 会话注册的是
  // 同名的 worker 变体入口（无 needReply/waitFor/timeoutMs，见 workerContactAgentToolEntry），
  // 本入口只进 master 会话；此处守卫仅作误注册防御（正常路径不可达）。
  const isWorkerSession = (context.workerIdentity?.workerId ?? "").trim().length > 0;
  if (isWorkerSession && (parsed.needReply ?? true)) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "Workers cannot require a reply (needReply=true is master-only): deliver your result or report, and the master decides whether to follow up. Resend with needReply=false.",
      { context: { toolName: CONTACT_AGENT_TOOL_NAME }, recoverable: true },
    );
  }
  const needReply = parsed.needReply ?? true;
  const submitted = await context.agentContactPort.submit({
    requestId,
    target: parsed.target,
    message: parsed.message,
    ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
    needReply,
    trace: resolveToolTraceContext(context),
  });

  if (submitted.status === "failed") {
    return {
      status: "failed",
      requestId,
      error: submitted.error,
    } satisfies ContactAgentOutput;
  }

  if (needReply && parsed.waitFor === true) {
    const waited = await context.agentContactPort.wait(
      requestId,
      parsed.timeoutMs ?? CONTACT_AGENT_DEFAULT_TIMEOUT_MS,
      context.abortSignal,
    );
    if (waited.status === "replied") {
      const sessionId = waited.sessionId ?? submitted.sessionId;
      return {
        status: "replied",
        requestId,
        ...(sessionId ? { sessionId } : {}),
        reply: {
          text: waited.text ?? "",
          ...(waited.sessionId ? { sessionId: waited.sessionId } : {}),
          ...(waited.synthesized === true ? { synthesized: true } : {}),
        },
      } satisfies ContactAgentOutput;
    }
    if (waited.status === "timeout") {
      return {
        status: "timeout",
        requestId,
        ...(submitted.sessionId ? { sessionId: submitted.sessionId } : {}),
        message: waited.message,
      } satisfies ContactAgentOutput;
    }
    // 修复（2026-11-23，用户裁决 C4）：unknown_request（回复在等待开始前已结算送达）
    // 是良性状态，此前被映射成 failed——模型会误以为请求丢了而重发（重复投递）。
    // 独立状态 already_settled + 指明回复已在会话历史（<system-status> 来信）。
    return {
      status: "already_settled",
      requestId,
      ...(submitted.sessionId ? { sessionId: submitted.sessionId } : {}),
      message:
        waited.message ??
        "The reply was already settled and delivered into this session's history (look for the incoming message carrying the counterpart's <system-status> block); no need to wait or resend.",
    } satisfies ContactAgentOutput;
  }

  return {
    status: "delivered",
    requestId,
    ...(submitted.sessionId ? { sessionId: submitted.sessionId } : {}),
    message: needReply
      ? "Request delivered. The reply arrives as a WaitReply result; if your turn ends first, it is injected into this session when it arrives."
      : "Notification delivered; no reply will be sent.",
  } satisfies ContactAgentOutput;
};

export const contactAgentToolEntry: ToolEntry = {
  capability: "Send a request to another agent (main agent or roster worker) with reply semantics",
  metadata: {
    shouldDefer: true,
    name: CONTACT_AGENT_TOOL_NAME,
    description: [
      "Send a message to another agent in this project - the main agent (`master`) or a roster worker (its wkr-* id) - as a request. This is also how tasks are handed between master and workers: deliver the task, its checklist reference and what to do now as the message.",
      "",
      "## Semantics",
      "",
      "- The message body arrives in the counterpart's session verbatim (bare text, no wrapping); who sent it and whether a reply is expected are told by the <system-status> block that accompanies it (sender, senderName, fromSessionId, replyExpected).",
      "- Addressing is explicit: pass `sessionId` (returned by an earlier ContactAgent to this counterpart, or the `fromSessionId` in a <system-status> they sent you) to continue that exact conversation; omit it and a NEW session is created for the counterpart - delivery never lands in their latest session implicitly.",
      "- needReply defaults to true for the master session only; worker sessions cannot require a reply (hierarchy: a subordinate never compels a reply from its superior). Workers deliver results notification-only and the master decides whether to follow up. For whoever receives a needReply=true request: the counterpart does NOT call any reply tool - their final output for the turn that processes your request is returned to you automatically as the reply.",
      "- If several of your needReply=true requests to the same counterpart are in flight, one turn of theirs answers all of them at once (single output, multiple returns) - do not expect a separate reply per request.",
      "- When YOU receive a request with replyExpected=true, your final output for that turn IS the reply - deliver it once and never also send the same content as a follow-up ContactAgent (that double-delivers). A follow-up request is only for new matters or later updates; replyExpected=false messages are notification-only.",
      "- waitFor=true blocks this tool call until the reply arrives or timeoutMs expires (default 120000 ms). Otherwise call WaitReply later with the returned requestId; if your turn ends without waiting, the reply is injected into this session when it arrives.",
      "- needReply=false sends a notification-only request (202-style): nothing will be sent back automatically.",
      "- Workers can only target `master`; worker-to-worker communication must be relayed by the main agent.",
      "- If the counterpart's session is taken over by the user before replying, you receive a synthesized notice instead of a reply; re-contact later with a new request.",
    ].join("\n"),
    modelInstructions: [
      "Use ContactAgent for all master-to-worker and worker-to-master messaging, including task handoff and completion replies; SendMessage only steers a session mid-turn.",
      "When you need the answer before continuing, pass waitFor: true.",
      "When sending a request with needReply: true and ending your turn without waiting, expect the reply to be injected into this session later.",
      "Treat a reply with synthesized: true as a system notice, not the counterpart's own words.",
      "When you receive a ContactAgent request with replyExpected=true in its <system-status>, your final output this turn is returned verbatim to the requester as the reply - close the turn facing the requester and do not repeat it via a follow-up ContactAgent.",
    ],
    allowedInPlanMode: true,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 600_000,
    maxOutputBytes: MAX_CONTACT_AGENT_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: contactAgentHandler,
  formatModelContent: formatContactAgentModelContent,
  inputSchema: ContactAgentInputJsonSchema,
  outputSchema: CONTACT_AGENT_PROVIDER_OUTPUT_SCHEMA,
  runtimeInputSchema: ContactAgentInputSchema,
  runtimeOutputSchema: ContactAgentOutputSchema,
  permission: {
    permission: "agent.message.contact",
    reason: "ContactAgent delivers a message into another agent's session",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_CONTACT_AGENT_MODEL_BYTES,
    maxModelBytes: MAX_CONTACT_AGENT_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_CONTACT_AGENT_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    // 阻塞等待（waitFor=true）上限即 timeoutMs 上限 600s；executor 兜底取消。
    defaultMs: 600_000,
    maxMs: 600_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ContactAgent was cancelled before the request completed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatContactAgentModelContent(output: unknown): string {
  const result = ContactAgentOutputSchema.parse(output);
  switch (result.status) {
    case "replied":
      return `Reply for request ${result.requestId}${result.reply?.synthesized === true ? " (system notice, not the counterpart's own output)" : ""}:\n\n${result.reply?.text ?? ""}`;
    case "delivered":
      return `Request ${result.requestId} delivered${result.sessionId ? ` to session ${result.sessionId}` : ""}. ${result.message ?? ""}`.trim();
    case "timeout":
      return `Request ${result.requestId} has no reply yet. ${result.message ?? ""}`.trim();
    case "already_settled":
      return `Request ${result.requestId} was already settled; the reply was delivered into this session's history (the incoming message with the counterpart's <system-status> block). ${result.message ?? ""}`.trim();
    case "failed":
      return `ContactAgent request ${result.requestId} failed. ${result.error ?? ""}`.trim();
  }
}

// ---- worker 变体入口（2026-11-23 C1 裁决，用户裁决"两套工具"）----
// 与 master 变体同名（`ContactAgent`）同功能（跨会话投递、寻址零耦合），但输入面
// 没有 needReply/waitFor/timeoutMs——天生 notification-only、天生异步。注册按会话
// 身份二选一（runtime-tools agentContactVariant）：模型只见到自己用得了的参数形态，
// 不存在"传 true 被拒绝再重发"的试错浪费；WaitReply 亦只注册给 master（worker 名下
// 无可等待的在途请求）。
const WORKER_CONTACT_AGENT_PROVIDER_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    status: { type: "string", enum: ["delivered", "failed"] },
    requestId: { type: "string" },
    sessionId: { type: "string" },
    message: { type: "string" },
  },
  required: ["status", "requestId"],
  additionalProperties: false,
};

const workerContactAgentHandler: ToolHandler = async (input, context) => {
  const parsed = WorkerContactAgentInputSchema.parse(input) as WorkerContactAgentInput;

  if (!context.agentContactPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "ContactAgent is only available to master and worker sessions with a host delivery channel (agentContactPort missing)",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: CONTACT_AGENT_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  const requestId = createContactRequestId();
  const submitted = await context.agentContactPort.submit({
    requestId,
    target: parsed.target,
    message: parsed.message,
    ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
    needReply: false,
    trace: resolveToolTraceContext(context),
  });

  if (submitted.status === "failed") {
    return {
      status: "failed",
      requestId,
      error: submitted.error,
    } satisfies WorkerContactAgentOutput;
  }

  return {
    status: "delivered",
    requestId,
    ...(submitted.sessionId ? { sessionId: submitted.sessionId } : {}),
    message:
      "Delivered (notification-only). Nothing is returned automatically - the master reads your message and follows up via ContactAgent when needed.",
  } satisfies WorkerContactAgentOutput;
};

export const workerContactAgentToolEntry: ToolEntry = {
  capability: "Send a notification-only message to another agent (worker variant of ContactAgent)",
  metadata: {
    shouldDefer: true,
    name: CONTACT_AGENT_TOOL_NAME,
    description: [
      "Send a message to another agent in this project - the main agent (`master`) or a roster worker (its wkr-* id). This is how you report progress, deliver results, and escalate to the master.",
      "",
      "## Semantics",
      "",
      "- This tool is notification-only by design - there is no reply option. A worker never requires a reply (the hierarchy is that the master can require YOUR reply, not the other way around); the master reads your message and follows up via ContactAgent when needed. There is nothing to wait for.",
      "- The message body arrives in the counterpart's session verbatim (bare text, no wrapping); who sent it is told by the <system-status> block that accompanies it (sender, senderName, fromSessionId).",
      "- Addressing is explicit: pass `sessionId` (returned by an earlier ContactAgent to this counterpart, or the `fromSessionId` in a <system-status> they sent you) to continue that exact conversation; omit it and a NEW session is created for the counterpart - delivery never lands in their latest session implicitly.",
      "- You can only target `master`; worker-to-worker communication must be relayed by the main agent.",
      "- When the master replies or hands you a task, its message arrives in your session with replyExpected=true in <system-status>: your final output for that turn IS the reply - deliver it once and never repeat it via a follow-up ContactAgent.",
    ].join("\n"),
    modelInstructions: [
      "Use ContactAgent for all worker-to-master messaging (progress reports, results, escalations); it is notification-only - send the message and continue your turn, there is no reply to wait for.",
      "Deliver a result as one complete message rather than many fragments; the master reads what you sent.",
      "When the master sends you a request with replyExpected=true in its <system-status>, your final output this turn is returned to the master as the reply - close the turn facing the master and do not repeat it via a follow-up ContactAgent.",
    ],
    allowedInPlanMode: true,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 120_000,
    maxOutputBytes: MAX_CONTACT_AGENT_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: workerContactAgentHandler,
  formatModelContent: formatWorkerContactAgentModelContent,
  inputSchema: WorkerContactAgentInputJsonSchema,
  outputSchema: WORKER_CONTACT_AGENT_PROVIDER_OUTPUT_SCHEMA,
  runtimeInputSchema: WorkerContactAgentInputSchema,
  runtimeOutputSchema: WorkerContactAgentOutputSchema,
  permission: {
    permission: "agent.message.contact",
    reason: "ContactAgent delivers a message into another agent's session",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_CONTACT_AGENT_MODEL_BYTES,
    maxModelBytes: MAX_CONTACT_AGENT_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_CONTACT_AGENT_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    // 纯投递（无等待）：Host 往返 + 冷启动建会话的余量即可。
    defaultMs: 120_000,
    maxMs: 120_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ContactAgent was cancelled before the request completed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatWorkerContactAgentModelContent(output: unknown): string {
  const result = WorkerContactAgentOutputSchema.parse(output);
  switch (result.status) {
    case "delivered":
      return `Message ${result.requestId} delivered${result.sessionId ? ` to session ${result.sessionId}` : ""} (notification-only). ${result.message ?? ""}`.trim();
    case "failed":
      return `ContactAgent request ${result.requestId} failed. ${result.error ?? ""}`.trim();
  }
}

function resolveToolTraceContext(context: Parameters<ToolHandler>[1]): TraceContext {
  return (
    context.traceContext ?? {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    }
  );
}
