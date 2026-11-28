// ============================================================
// RouteEvents Tool Handler - dispatcher topic routing
// ============================================================
// 2026-11-25 分发器裁决（specs/trigger-dispatcher-routing.md）：dispatcher 档触发器会话
// 的引用式路由标记工具。本 handler 是薄通道：标记经 TriggerRuntimePort 反向请求落到
// 引擎 routeEvents（会话 key 反查 + routing 门控 + RouteMarkQueue 兑现）——机制层路由
// 边界（只有 dispatcher 档的绑定分发器会话可用）在引擎侧强制，handler 不做本地判断
// （独立 CLI 无引擎时诚实报错，ManageTriggers install_packages 同款）。
// unknown 事件不是失败：事件已另有去向（漏标降级直投或非本分发器批次），以 warnings
// 回显提示模型，不阻塞已接受标记的兑现。

import {
  ROUTE_EVENTS_TOOL_NAME,
  RouteEventsInputJsonSchema,
  RouteEventsInputSchema,
  RouteEventsOutputJsonSchema,
  RouteEventsOutputSchema,
  CoreErrorType,
  createCoreError,
  type RouteEventsInput,
  type RouteEventsOutput,
} from "@robindone/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

export const routeEventsHandler: ToolHandler = async (input, context) => {
  const parsed = RouteEventsInputSchema.parse(input) as RouteEventsInput;
  const triggerRuntimePort = context.triggerRuntimePort;
  if (triggerRuntimePort === undefined) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "RouteEvents requires the desktop trigger engine (TriggerRuntimePort is not wired in this host) — dispatcher routing only runs in the desktop app",
      {
        context: { toolCallId: context.toolCallId, toolName: ROUTE_EVENTS_TOOL_NAME },
        recoverable: false,
      },
    );
  }
  const result = await triggerRuntimePort.routeEvents({
    workspacePath: context.workspaceRoot,
    sessionId: context.sessionId,
    routes: parsed.routes,
  });
  // 引擎侧错误（非分发器会话/routing 门控拒绝）走 ok=false + warnings 承载（输出 schema
  // 无 error 字段——strict 面保持最小），模型从 formatModelContent 的首行读到原因。
  return {
    ok: result.ok,
    acceptedEventIds: result.acceptedEventIds,
    unknownEventIds: result.unknownEventIds,
    ...(result.error !== undefined || !result.ok
      ? { warnings: [result.error ?? "routing was not accepted by the engine"] }
      : {}),
  } satisfies RouteEventsOutput;
};

function formatRouteEventsModelContent(output: unknown): string {
  const parsed = RouteEventsOutputSchema.safeParse(output);
  if (!parsed.success) {
    return typeof output === "string" ? output : (JSON.stringify(output) ?? String(output));
  }
  const data = parsed.data;
  const lines: string[] = [];
  if (data.ok) {
    lines.push(
      `Routing recorded for ${data.acceptedEventIds.length} event(s); marks are delivered after this turn ends.`,
    );
  } else {
    lines.push(`RouteEvents failed: ${data.warnings?.[0] ?? "unknown error"}`);
  }
  if (data.unknownEventIds.length > 0) {
    lines.push(
      `Not accepted (already auto-routed to new sessions, or not from this dispatcher's batch — no action needed): ${data.unknownEventIds.join(", ")}`,
    );
  }
  return lines.join("\n");
}

export const routeEventsToolEntry: ToolEntry = {
  capability: "Mark topic routing for events delivered to this dispatcher session",
  metadata: {
    name: ROUTE_EVENTS_TOOL_NAME,
    description: [
      "Route the events delivered to this dispatcher session (dispatcher-routing triggers only): decide per event whether it continues an existing topic session or starts a new one, and mark the decision with REFERENCE IDS — the system forwards the original event payloads verbatim to the target sessions, so never restate or copy event content into this call.",
      "",
      "Rules:",
      "- Only valid in the dispatcher session of a dispatcher-routing trigger; the engine rejects calls from any other session.",
      "- Route targets are always your own sessions: { kind: \"new\" } starts a new session owned by you; { kind: \"existing\", taskId } continues a session you previously routed to (use the taskId from this conversation).",
      "- MARK GRANULARITY: each { kind: \"new\" } mark creates ONE new session with exactly the events listed in that mark — separate topics go in SEPARATE marks; to start one session holding several same-topic events, list all their ids in a single mark.",
      "- Target sessions are created/continued by the system AFTER your turn ends; you do not create sessions or wait for ids yourself. Each new/continued session's id is echoed back to this conversation in the next delivery's routing-outcome note — use those ids for later { kind: \"existing\" } continuation.",
      "- Be conservative: when unsure whether an event belongs to an existing topic, route it to a NEW session (mixing topics pollutes context; extra sessions are cheap).",
      "- Unmarked events are auto-routed to new sessions after a grace period; unknown ids in the result are informational, not failures.",
      "- After marking, end your turn — no reply or report back is expected.",
    ].join("\n"),
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    sideEffectScope: "workspace",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: routeEventsHandler,
  formatModelContent: formatRouteEventsModelContent,
  inputSchema: RouteEventsInputJsonSchema,
  outputSchema: RouteEventsOutputJsonSchema,
  runtimeInputSchema: RouteEventsInputSchema,
  runtimeOutputSchema: RouteEventsOutputSchema,
  permission: {
    permission: "trigger.route",
    reason: "RouteEvents marks topic routing for dispatcher-delivered trigger events",
    riskLevel: "low",
    sideEffectScope: "workspace",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 4_000,
    maxModelBytes: 4_000,
    strategy: "inline",
  },
  timeout: { kind: "none" },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage: "RouteEvents was cancelled; no routing marks were recorded",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
