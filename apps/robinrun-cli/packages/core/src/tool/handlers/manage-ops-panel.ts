import {
  MANAGE_OPS_PANEL_TOOL_NAME,
  ManageOpsPanelInputJsonSchema,
  ManageOpsPanelInputSchema,
  ManageOpsPanelOutputSchema,
  CoreErrorType,
  WorkerManageOpsPanelInputJsonSchema,
  WorkerManageOpsPanelInputSchema,
  WorkerManageOpsPanelOutputSchema,
  createCoreError,
  type ManageOpsPanelInput,
  type ManageOpsPanelOutput,
  type TraceContext,
  type WorkerManageOpsPanelInput,
  type WorkerManageOpsPanelOutput,
} from "@robinrun/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_OPS_PANEL_MODEL_BYTES = 32_768;

const OPS_PANEL_PROVIDER_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    entries: { type: "array" },
    queue: {
      type: "object",
      properties: {
        inFlightId: { type: ["string", "null"] },
        pendingIds: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    entry: { type: "object" },
    progressEntries: { type: "array" },
    progressEntry: { type: "object" },
    deletedProgressId: { type: "string" },
    message: { type: "string" },
    error: { type: "string" },
  },
  additionalProperties: false,
};

// 需求/审批/反馈面板（2026-11-24 MVP，RobinRunOps dev/specs）：智能体操作面板的唯一
// 工具面。所有动作经 OpsPanelRuntimePort 反向请求落到 host 面板服务（权限矩阵 +
// worker 可见性过滤在服务层强制，本 handler 只做身份派生与投递）。作者身份机制层
// 派生（context.workerIdentity），不采信模型传值——manage-triggers resolveOwnerAgentId
// 同款原则。同名双变体（C1 裁决同构）：master 会话注册 master 变体（12 动作，
// 2026-11-25 起含进度账本四动作），worker 会话注册 worker 变体（3 动作，无进度面——
// 进度是 master 的叙事），模型只见得到自己用得了的动作。
function resolveOpsPanelActor(context: Parameters<ToolHandler>[1]): "master" | `worker:${string}` {
  const workerId = (context.workerIdentity?.workerId ?? "").trim();
  return workerId.length > 0 ? `worker:${workerId}` : "master";
}

export const manageOpsPanelHandler: ToolHandler = async (input, context) => {
  const parsed = ManageOpsPanelInputSchema.parse(input) as ManageOpsPanelInput;

  if (!context.opsPanelRuntimePort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "ManageOpsPanel is only available in sessions connected to a host with the ops panel service (opsPanelRuntimePort missing)",
      {
        context: { toolCallId: context.toolCallId, toolName: MANAGE_OPS_PANEL_TOOL_NAME },
        recoverable: false,
      },
    );
  }

  const actor = { role: "agent", agentId: resolveOpsPanelActor(context) } as const;
  const trace = resolveOpsPanelTraceContext(context);
  switch (parsed.action) {
    case "list":
      return await context.opsPanelRuntimePort.listEntries({ sessionId: context.sessionId, actor, trace });
    case "get":
      return await context.opsPanelRuntimePort.getEntry({
        sessionId: context.sessionId,
        actor,
        entryId: parsed.entryId!,
        trace,
      });
    case "create_requirement":
    case "create_approval":
    case "create_feedback":
      return await context.opsPanelRuntimePort.createEntry({
        sessionId: context.sessionId,
        actor,
        kind:
          parsed.action === "create_requirement"
            ? "requirement"
            : parsed.action === "create_approval"
              ? "approval"
              : "feedback",
        title: parsed.title!,
        body: parsed.body!,
        // 来源标记（2026-11-24 录入与来源拆分）：create_feedback 显式 user|master；
        // create_requirement 恒 user（服务层强制，用户对话转述）、create_approval 恒
        // master（服务层派生，均不传）。
        ...(parsed.action === "create_feedback" && parsed.author !== undefined
          ? { author: parsed.author }
          : {}),
        trace,
      });
    case "decide_requirement":
      return await context.opsPanelRuntimePort.decideRequirement({
        sessionId: context.sessionId,
        actor,
        entryId: parsed.entryId!,
        outcome: parsed.outcome!,
        ...(parsed.note !== undefined ? { note: parsed.note } : {}),
        trace,
      });
    case "resolve_feedback":
      return await context.opsPanelRuntimePort.resolveFeedback({
        sessionId: context.sessionId,
        actor,
        entryId: parsed.entryId!,
        ...(parsed.note !== undefined ? { note: parsed.note } : {}),
        trace,
      });
    case "acknowledge_approval":
      return await context.opsPanelRuntimePort.acknowledgeApproval({
        sessionId: context.sessionId,
        actor,
        entryId: parsed.entryId!,
        ...(parsed.note !== undefined ? { note: parsed.note } : {}),
        trace,
      });
    // ---- 进度账本（2026-11-25，specs/progress-ledger.md）：master 独占，worker 变体不含 ----
    // 端口返回是协议形状（{entries}/{entry}/{id}，承载进度条目），必须在此重映射到
    // 工具输出 schema 的专用字段（progressEntries/progressEntry/deletedProgressId）：
    // 输出的 entries/entry 字段是工作项判别 union（strict），进度条目原样挂上去会被
    // runtimeOutputSchema 拒收（2026-11-25 实测缺陷 P1-1：变更已生效但响应损坏）。
    case "list_progress": {
      const view = await context.opsPanelRuntimePort.getProgressView({
        sessionId: context.sessionId,
        actor,
        trace,
      });
      return { progressEntries: view.entries };
    }
    case "append_progress": {
      const result = await context.opsPanelRuntimePort.appendProgress({
        sessionId: context.sessionId,
        actor,
        title: parsed.title!,
        ...(parsed.body !== undefined ? { body: parsed.body } : {}),
        ...(parsed.links !== undefined ? { links: parsed.links } : {}),
        trace,
      });
      return { progressEntry: result.entry };
    }
    case "update_progress": {
      const result = await context.opsPanelRuntimePort.updateProgress({
        sessionId: context.sessionId,
        actor,
        entryId: parsed.entryId!,
        ...(parsed.title !== undefined ? { title: parsed.title } : {}),
        ...(parsed.body !== undefined ? { body: parsed.body } : {}),
        ...(parsed.links !== undefined ? { links: parsed.links } : {}),
        trace,
      });
      return { progressEntry: result.entry };
    }
    case "delete_progress": {
      const result = await context.opsPanelRuntimePort.deleteProgress({
        sessionId: context.sessionId,
        actor,
        entryId: parsed.entryId!,
        trace,
      });
      return { deletedProgressId: result.id };
    }
  }
};

export const manageOpsPanelToolEntry: ToolEntry = {
  capability: "Operate the requirements/approvals/feedback panel (read, draft, dispose, triage)",
  metadata: {
    shouldDefer: false,
    name: MANAGE_OPS_PANEL_TOOL_NAME,
    description: [
      "Operate the project's ops panel (requirements / approvals / feedback) - the shared work-order board between the user and the agents. The user tells you requirements and feedback in conversation and YOU record them (author=user, recordedBy=master); approvals are decision items YOU draft for the user; worker escalations arrive as feedback that you triage.",
      "",
      "## Semantics",
      "",
      "- Recording for the user: create_requirement / create_feedback(author=user) transcribe what the user told you into the ledger - recording NEVER wakes you (you are already present in the conversation). Keep the ledger faithful to what the user said; dispose requirements (decide_requirement) as you accept/reject/suspend/convert them.",
      "- Waking: when the user decides (approves/rejects) one of your drafted approvals, or a worker submits feedback, you are woken in the subscription's bound session with exactly one queued item - handle it, then dispose/acknowledge it to release the queue for the next item. Anything you record yourself NEVER wakes you.",
      "- decide_requirement disposes a requirement (accepted / rejected / suspended / converted_to_approval). Disposal is your status decision only - accepted items then enter normal development planning, which does NOT occupy this wakeup queue.",
      "- acknowledge_approval confirms you have EXECUTED an approval decision; it is what releases the queue slot for approvals.",
      "- resolve_feedback marks feedback processed (optionally with a triage note) and releases its queue slot.",
      "- You cannot decide approvals (only the user approves/rejects). If a worker needs something from the user, ask the user or draft an approval, never a requirement of your own invention.",
      "",
      "## Progress ledger",
      "",
      "- The progress tab is the project's milestone timeline maintained ONLY by you (master): the user reads it, workers cannot access it. It exists so anyone can grasp the project's thread at a glance - it shows effective final states only; it is NOT an audit log and keeps no revision history.",
      "- append_progress records a milestone ONLY when it becomes fact: phase completions, direction changes, major decisions landed, major risks, notable external events. Do NOT record plans, back-and-forth, or per-task/per-action details (those live in task checklists and panel entries). Keep the title one line; put depth into files and attach them via links.",
      "- list_progress before appending to avoid duplicates; keep the ledger short and current.",
      "- update_progress fixes a wrong entry in place; delete_progress removes an entry that turned out ineffective or was recorded by mistake (the system anchor cannot be deleted). Neither leaves any visible trace - recording \"previously said X, later changed to Y\" has no value here; just keep the final state.",
    ].join("\n"),
    modelInstructions: [
      "On an ops-panel wakeup, handle the single delivered item first; after your status decision the next queued item wakes you in a new turn.",
      "Draft approvals for direction changes or optimization attempts that need user sign-off; use feedback to record observations that need master triage.",
      "Prefer resolving panel items promptly: the wakeup queue is serial, so a disposed item unblocks the next one.",
      "Record progress milestones the moment they become fact, with links to the files that carry the detail; maintain them in place (update/delete) so the ledger always reads as the project's clean thread.",
    ],
    allowedInPlanMode: true,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 120_000,
    maxOutputBytes: MAX_OPS_PANEL_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: false,
  },
  handler: manageOpsPanelHandler,
  formatModelContent: formatManageOpsPanelModelContent,
  inputSchema: ManageOpsPanelInputJsonSchema,
  outputSchema: OPS_PANEL_PROVIDER_OUTPUT_SCHEMA,
  runtimeInputSchema: ManageOpsPanelInputSchema,
  runtimeOutputSchema: ManageOpsPanelOutputSchema,
  permission: {
    permission: "edit",
    reason: "ManageOpsPanel changes the shared ops panel entries (requirements/approvals/feedback)",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["input"],
    alwaysAllowPatternSources: ["input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_OPS_PANEL_MODEL_BYTES,
    maxModelBytes: MAX_OPS_PANEL_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_OPS_PANEL_MODEL_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: 120_000,
    maxMs: 120_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ManageOpsPanel was cancelled before the request completed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

// ---- worker 变体入口（权限矩阵 §4，同名双变体）----
// worker 只能 list/get 自己提交的条目（完整生命周期可见；过滤在 host 服务数据层）与
// create_feedback。提需求/提审批/处置/分诊/确认执行不在 worker 工具面——层级纪律：
// worker 的一切诉求经"反馈"入口向上走，由 master 分诊。
export const workerManageOpsPanelHandler: ToolHandler = async (input, context) => {
  const parsed = WorkerManageOpsPanelInputSchema.parse(input) as WorkerManageOpsPanelInput;

  if (!context.opsPanelRuntimePort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "ManageOpsPanel is only available in sessions connected to a host with the ops panel service (opsPanelRuntimePort missing)",
      {
        context: { toolCallId: context.toolCallId, toolName: MANAGE_OPS_PANEL_TOOL_NAME },
        recoverable: false,
      },
    );
  }

  const workerId = (context.workerIdentity?.workerId ?? "").trim();
  if (workerId.length === 0) {
    // 误注册防御（正常路径不可达：worker 变体只进 worker 会话，runtime-tools 门按
    // workerIdentity 二选一）。
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "The worker ManageOpsPanel variant requires a worker session identity",
      { context: { toolName: MANAGE_OPS_PANEL_TOOL_NAME }, recoverable: false },
    );
  }
  const actor = { role: "agent", agentId: `worker:${workerId}` } as const;
  const trace = resolveOpsPanelTraceContext(context);
  switch (parsed.action) {
    case "list":
      return await context.opsPanelRuntimePort.listEntries({ sessionId: context.sessionId, actor, trace });
    case "get":
      return await context.opsPanelRuntimePort.getEntry({
        sessionId: context.sessionId,
        actor,
        entryId: parsed.entryId!,
        trace,
      });
    case "create_feedback":
      return await context.opsPanelRuntimePort.createEntry({
        sessionId: context.sessionId,
        actor,
        kind: "feedback",
        title: parsed.title!,
        body: parsed.body!,
        trace,
      });
  }
};

export const workerManageOpsPanelToolEntry: ToolEntry = {
  capability: "Read your own ops panel entries and submit feedback (worker variant of ManageOpsPanel)",
  metadata: {
    shouldDefer: false,
    name: MANAGE_OPS_PANEL_TOOL_NAME,
    description: [
      "Operate the project's ops panel from a worker session: read YOUR OWN submitted entries and submit feedback. This is the upward channel for everything a worker needs - problems, blockers, observations - reviewed and triaged by the master.",
      "",
      "## Semantics",
      "",
      "- You can only see entries YOU submitted (full lifecycle visible); other agents' items are invisible to you - this filter is enforced by the host, not a UI hint.",
      "- create_feedback records an observation for master triage. Submitting does not wake you; the master decides what happens next and communicates through your session or a task.",
      "- There is no requirement or approval action for workers: requirements come from the user, approvals are drafted by the master. Route every need upward as feedback.",
    ].join("\n"),
    modelInstructions: [
      "Use create_feedback for any problem, blocker, or improvement observation instead of messaging the user directly; the master triages it.",
      "Check list/get to recall the status and triage notes of your own submissions.",
    ],
    allowedInPlanMode: true,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 120_000,
    maxOutputBytes: MAX_OPS_PANEL_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: false,
  },
  handler: workerManageOpsPanelHandler,
  formatModelContent: formatManageOpsPanelModelContent,
  inputSchema: WorkerManageOpsPanelInputJsonSchema,
  outputSchema: OPS_PANEL_PROVIDER_OUTPUT_SCHEMA,
  runtimeInputSchema: WorkerManageOpsPanelInputSchema,
  runtimeOutputSchema: WorkerManageOpsPanelOutputSchema,
  permission: {
    permission: "edit",
    reason: "ManageOpsPanel submits feedback entries to the shared ops panel",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["input"],
    alwaysAllowPatternSources: ["input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_OPS_PANEL_MODEL_BYTES,
    maxModelBytes: MAX_OPS_PANEL_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_OPS_PANEL_MODEL_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: 120_000,
    maxMs: 120_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ManageOpsPanel was cancelled before the request completed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatEntryLine(entry: {
  id: string;
  kind: string;
  title: string;
  status: string;
  author: string;
  outcome?: string;
  note?: string;
}): string {
  const head = `${entry.id} [${entry.kind}/${entry.status}${entry.outcome ? `:${entry.outcome}` : ""}] "${entry.title}" (by ${entry.author})`;
  return entry.note !== undefined ? `${head} - note: ${entry.note}` : head;
}

function formatManageOpsPanelModelContent(output: unknown): string {
  const parsed = ManageOpsPanelOutputSchema.safeParse(output);
  if (!parsed.success) {
    return typeof output === "string" ? output : (JSON.stringify(output) ?? String(output));
  }
  const data = parsed.data as ManageOpsPanelOutput & WorkerManageOpsPanelOutput;
  const lines: string[] = [];
  if (data.queue !== undefined) {
    lines.push(
      `Wakeup queue: in-flight=${data.queue.inFlightId ?? "none"}; pending=[${data.queue.pendingIds.join(", ")}]`,
    );
  }
  if (data.entries !== undefined) {
    lines.push(
      data.entries.length === 0
        ? "No visible entries."
        : `Entries (${data.entries.length}):`,
      ...data.entries.map(formatEntryLine),
    );
  }
  if (data.entry !== undefined) {
    lines.push("Entry:", formatEntryLine(data.entry));
  }
  if (data.progressEntries !== undefined) {
    lines.push(
      data.progressEntries.length === 0
        ? "No progress entries."
        : `Progress entries (${data.progressEntries.length}, chronological):`,
      ...data.progressEntries.map(formatProgressLine),
    );
  }
  if (data.progressEntry !== undefined) {
    lines.push("Progress entry:", formatProgressLine(data.progressEntry));
  }
  if (data.deletedProgressId !== undefined) {
    lines.push(`Deleted progress entry: ${data.deletedProgressId}`);
  }
  if (data.message !== undefined) lines.push(data.message);
  if (data.error !== undefined) lines.push(`error: ${data.error}`);
  return lines.join("\n");
}

function formatProgressLine(entry: {
  id: string;
  title: string;
  createdBy: string;
  links?: string[];
}): string {
  const links =
    entry.links !== undefined && entry.links.length > 0 ? ` (links: ${entry.links.join(", ")})` : "";
  return `${entry.id} [${entry.createdBy}] "${entry.title}"${links}`;
}

function resolveOpsPanelTraceContext(context: Parameters<ToolHandler>[1]): TraceContext {
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
