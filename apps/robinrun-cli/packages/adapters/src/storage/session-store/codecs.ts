import {
  SESSION_TASK_TYPES,
  SESSION_ENTRY_MODEL_SELECTION,
  SESSION_TITLE_SOURCES,
  parseModelSelectionValue,
  type CollaborationMode,
  type FileDiff,
  type MessageId,
  type MessageInfo,
  type MessagePart,
  type PartId,
  type PermissionRuleset,
  type ProjectId,
  type SessionEntryInfo,
  type SessionId,
  type SessionInfo,
  type SessionRevert,
  type SessionTitleSource,
  type SessionEntryType,
  type TodoItem,
  type TraceId,
  type WorkspaceId,
  type SessionTaskType,
} from "@robinrun/contracts";
import { decodeJson } from "./json.js";
import type { MessageRow, PartRow, SessionEntryRow, SessionRow, TodoRow } from "./rows.js";

export function isCollaborationMode(value: unknown): value is CollaborationMode {
  return (
    value === "plan" ||
    value === "build" ||
    value === "edit" ||
    value === "yolo" ||
    value === "guarded" ||
    value === "auto"
  );
}

function decodeSessionTaskType(value: string | null | undefined): SessionTaskType {
  return SESSION_TASK_TYPES.includes(value as SessionTaskType)
    ? (value as SessionTaskType)
    : "interactive";
}

function decodeSessionTitleSource(value: string | null | undefined): SessionTitleSource {
  return SESSION_TITLE_SOURCES.includes(value as SessionTitleSource)
    ? (value as SessionTitleSource)
    : "first_input";
}

// 创建来源列是 JSON 文本；损坏/缺失按缺席处理（读侧旧数据默认 user），不阻断会话读取。
const CREATION_ORIGIN_KINDS = new Set(["user", "agent", "trigger", "system"]);

function decodeSessionCreationOrigin(value: string | null | undefined):
  | {
      kind: "user" | "agent" | "trigger" | "system";
      ref?: string;
    }
  | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.kind !== "string" || !CREATION_ORIGIN_KINDS.has(record.kind)) return undefined;
  return {
    kind: record.kind as "user" | "agent" | "trigger" | "system",
    ...(typeof record.ref === "string" && record.ref.length > 0 ? { ref: record.ref } : {}),
  };
}

// worker 会话身份列是自由 JSON 文本（可被外部 sqlite 工具触碰）；修复（2026-11-23）：
// 此前经 decodeJson 直接 JSON.parse，损坏即抛错炸整行读取（该会话 listing/冷恢复全断），
// 与相邻 creation_origin 的容错口径不一致。改为损坏/形状不符按缺席（master）处理 + 告警。
function decodeSessionWorkerIdentity(
  value: string | null | undefined,
): SessionInfo["workerIdentity"] {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    process.emitWarning(
      `corrupt session.worker_identity dropped (treated as master): ${error instanceof Error ? error.message : String(error)}`,
      { code: "ROBINRUN_WORKER_IDENTITY_CORRUPT" },
    );
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).workerId !== "string"
  ) {
    process.emitWarning("malformed session.worker_identity dropped (treated as master)", {
      code: "ROBINRUN_WORKER_IDENTITY_CORRUPT",
    });
    return undefined;
  }
  return parsed as SessionInfo["workerIdentity"];
}

export function decodeSessionRow(row: SessionRow): SessionInfo {
  return {
    id: row.id as SessionId,
    projectID: row.project_id as ProjectId,
    workspaceID: row.workspace_id ? (row.workspace_id as WorkspaceId) : undefined,
    parentID: row.parent_id ? (row.parent_id as SessionId) : undefined,
    traceID: row.trace_id ? (row.trace_id as TraceId) : undefined,
    taskType: decodeSessionTaskType(row.task_type),
    creationOrigin: decodeSessionCreationOrigin(row.creation_origin),
    // worker 会话身份（2026-11-20 同构化补漏，migration 0026）：冷恢复据此回填
    // runtime config 重建注入段；NULL/旧行缺席按 master 处理，损坏列容错不阻断读取。
    workerIdentity: decodeSessionWorkerIdentity(row.worker_identity),
    slug: row.slug,
    directory: row.directory,
    path: row.path ?? undefined,
    title: row.title,
    lastOutcome: row.last_outcome ?? undefined,
    titleSource: decodeSessionTitleSource(row.title_source),
    titleMessageID: row.title_message_id ? (row.title_message_id as MessageId) : undefined,
    version: row.version,
    shareURL: row.share_url ?? undefined,
    summaryAdditions: row.summary_additions ?? undefined,
    summaryDeletions: row.summary_deletions ?? undefined,
    summaryFiles: row.summary_files ?? undefined,
    summaryDiffs: decodeJson<FileDiff[]>(row.summary_diffs),
    revert: decodeJson<SessionRevert>(row.revert),
    permission: decodeJson<PermissionRuleset>(row.permission),
    time: {
      created: row.time_created,
      updated: row.time_updated,
      titleUpdated: row.time_title_updated ?? undefined,
      compacting: row.time_compacting ?? undefined,
      deleted: row.time_deleted ?? undefined,
    },
  };
}

export function decodeMessageRow(row: MessageRow): MessageInfo {
  return {
    ...decodeStoredMessage(JSON.parse(row.data) as unknown),
    id: row.id as MessageId,
    sessionID: row.session_id as SessionId,
  } as MessageInfo;
}

function decodeStoredMessage(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  if (value.role === "user") {
    const { model: _legacyModel, modelSelection: rawSelection, ...message } = value;
    // 迁移无法确定身份时可能留下 null；回滚后也可能缺字段。不能让配置残缺阻断整条消息的协议读取。
    // 这里只校验新结构，不查执行资格、不回读旧快照，磁盘内容保持不变。
    const modelSelection = parseModelSelectionValue(rawSelection);
    return { ...message, ...(modelSelection ? { modelSelection } : {}) };
  }
  if (value.role === "assistant") {
    const {
      providerID: _legacyProviderId,
      modelID: _legacyModelId,
      variant: _legacyReasoningLevel,
      ...message
    } = value;
    return message;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodePartRow(row: PartRow): MessagePart {
  return {
    ...decodeStoredPart(JSON.parse(row.data) as unknown),
    id: row.id as PartId,
    sessionID: row.session_id as SessionId,
    messageID: row.message_id as MessageId,
  } as MessagePart;
}

function decodeStoredPart(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  if (value.type === "timeline" && value.timelineType === "model_change") {
    const {
      fromModel: _oldFrom,
      toModel: _oldTo,
      fromModelSelection,
      toModelSelection,
      ...part
    } = value;
    const fromModel = decodeTimelineSelection(fromModelSelection);
    const toModel = decodeTimelineSelection(toModelSelection);
    return {
      ...part,
      ...(fromModel ? { fromModel } : {}),
      ...(toModel ? { toModel } : {}),
    };
  }
  if (value.type === "subtask") {
    const { model: _oldModel, modelSelection, ...part } = value;
    const model = parseModelSelectionValue(modelSelection);
    return { ...part, ...(model ? { model } : {}) };
  }
  return value;
}

function decodeTimelineSelection(value: unknown) {
  if (!isRecord(value)) return undefined;
  // label 仅是 Timeline 展示信息，不属于严格的 Selection；不能误删合法的带标签历史。
  const { label, ...rawSelection } = value;
  const selection = parseModelSelectionValue(rawSelection);
  return selection ? { ...selection, ...(typeof label === "string" ? { label } : {}) } : undefined;
}

export function decodeSessionEntryRow(row: SessionEntryRow): SessionEntryInfo {
  const rawData = JSON.parse(row.data) as unknown;
  return {
    id: row.id,
    sessionID: row.session_id as SessionId,
    type: row.type as SessionEntryType | string,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
    data:
      row.type === SESSION_ENTRY_MODEL_SELECTION
        ? decodeStoredSessionModelSelection(rawData)
        : rawData,
  };
}

function decodeStoredSessionModelSelection(value: unknown): unknown {
  // 旧平铺字段只属于升级入口。新成员即使为空/非法也不能借旧快照补值。
  // 解包在存储边界完成，core/bootstrap/fork 只消费 port 的当前逻辑 Selection。
  if (!isRecord(value)) return undefined;
  return parseModelSelectionValue(value.modelSelection) ?? value.modelSelection;
}

export function decodeTodoRow(row: TodoRow): TodoItem {
  return {
    content: row.content,
    status: row.status as TodoItem["status"],
    priority: row.priority as TodoItem["priority"],
  };
}

export function partCreatedAt(part: MessagePart, fallback: number): number {
  if (part.type === "text" || part.type === "reasoning") return part.time?.start ?? fallback;
  if (part.type === "compaction") return part.time?.start ?? fallback;
  if (part.type === "timeline") return part.time?.start ?? fallback;
  if (part.type === "tool") {
    if (part.state.status === "running") return part.state.time.start;
    if (part.state.status === "completed" || part.state.status === "error") {
      return part.state.time.start;
    }
  }
  if (part.type === "retry") return part.time.created;
  return fallback;
}
