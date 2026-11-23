import { useEffect, useState } from "react";
import { workerRegistryFileName, workerRegistrySchema } from "@robinrun/shared";
import type { useRobinRunIntl } from "@/i18n/IntlProvider.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { isSubagentColor } from "@/lib/subagentColors.js";

type AgentIntl = ReturnType<typeof useRobinRunIntl>["intl"];
type AgentToolCall = ToolCallBlockRenderContext["toolCallNode"]["toolCall"];
const DEFAULT_AGENT_TYPE_LABEL = "general-purpose";

export function formatAgentMessage(intl: AgentIntl, id: string, fallback: string) {
  const message = intl.formatMessage({ id });
  // agent 工具块的语言包一旦漏配，SSR/静态渲染会把内部 i18n key 原样打到 UI 上，
  // 不但测试断言会失败，真实界面也会直接暴露实现细节。这里统一回退到稳定术语。
  return message === id ? fallback : message;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate !== "string") {
      continue;
    }

    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

function readTextFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  if (Array.isArray(value)) {
    const text = value
      .map((item) => readTextFromUnknown(item))
      .filter((item): item is string => typeof item === "string" && item.length > 0)
      .join("\n");
    return text || undefined;
  }

  if (!isPlainRecord(value)) {
    return undefined;
  }

  const text = readStringField(value, ["text"]);
  if (text) {
    return text;
  }

  return readTextFromUnknown(value.content);
}

function readStringFromNestedRecord(value: unknown, path: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isPlainRecord(current)) {
      return undefined;
    }
    current = current[key];
  }

  return typeof current === "string" && current.trim().length > 0 ? current.trim() : undefined;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readRecordFromUnknown(value: unknown): Record<string, unknown> | null {
  if (isPlainRecord(value)) {
    return value;
  }

  const text = readTextFromUnknown(value);
  return text ? parseJsonObject(text) : null;
}

function readCodexSubagentNickname(toolCall: AgentToolCall): string | undefined {
  const rawNickname =
    readStringFromNestedRecord(toolCall.raw, ["_meta", "robinrun", "nickname"]) ??
    readStringFromNestedRecord(toolCall.raw, ["nickname"]);
  if (rawNickname) {
    return rawNickname;
  }

  if (isPlainRecord(toolCall.input)) {
    const inputNickname = readStringField(toolCall.input, ["nickname"]);
    if (inputNickname) {
      return inputNickname;
    }
  }

  const outputText = readTextFromUnknown(toolCall.output);
  if (!outputText) {
    return undefined;
  }

  const parsedOutput = parseJsonObject(outputText);
  if (!parsedOutput) {
    return undefined;
  }

  return readStringField(parsedOutput, ["nickname"]);
}

function isImplementationToolTitle(title: string): boolean {
  const normalized = title
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return normalized === "agent" || normalized === "task" || normalized === "spawn_agent";
}

function readAgentNameFromRecord(value: Record<string, unknown> | null): string | undefined {
  return value
    ? readStringField(value, [
        "agentType",
        "agent_type",
        "subagentType",
        "subagent_type",
        // P2.6 工具分离：DispatchWorker 的寻址字段是 worker（wkr-id）。
        "worker",
        "name",
        "nickname",
      ])
    : undefined;
}

function readAgentPrimaryDescription(value: Record<string, unknown> | null): string | undefined {
  return value ? readStringField(value, ["description", "summary", "message"]) : undefined;
}

export function getAgentKindLabel(
  toolCall: AgentToolCall,
  fallbackLabel: string,
  authoritativeAgentType?: string,
) {
  const outputRecord = readRecordFromUnknown(toolCall.output);
  const inputRecord = isPlainRecord(toolCall.input) ? toolCall.input : null;
  const rawRecord = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const rawName =
    readStringFromNestedRecord(toolCall.raw, ["_meta", "robinrun", "agentType"]) ??
    readStringFromNestedRecord(toolCall.raw, ["_meta", "robinrun", "agent_type"]) ??
    readStringFromNestedRecord(toolCall.raw, ["_meta", "robinrun", "subagent_type"]);

  // 流式 input 的半截 JSON 暂时读不到 subagent_type，若一读不到就按“模型省略字段”
  // 回退 general-purpose，首帧会误报、之后再跳成真实类型。只有 inputPreviewComplete 明确为 true
  // 才能确认字段确实省略；已投影的 subagentRow 类型则作为 runtime 权威结果优先展示。
  const explicitName =
    (authoritativeAgentType?.trim() || undefined) ??
    readAgentNameFromRecord(outputRecord) ??
    readCodexSubagentNickname(toolCall) ??
    readAgentNameFromRecord(inputRecord) ??
    rawName;
  if (explicitName) {
    return explicitName;
  }

  return rawRecord?.inputPreviewComplete === true ? fallbackLabel || DEFAULT_AGENT_TYPE_LABEL : "";
}

export function getAgentColor(toolCall: AgentToolCall) {
  const outputRecord = readRecordFromUnknown(toolCall.output);
  const inputRecord = isPlainRecord(toolCall.input) ? toolCall.input : null;
  const rawColor =
    readStringFromNestedRecord(toolCall.raw, ["_meta", "robinrun", "color"]) ??
    readStringFromNestedRecord(toolCall.raw, ["color"]) ??
    readAgentColorFromRecord(inputRecord) ??
    readAgentColorFromRecord(outputRecord);

  return rawColor && isSubagentColor(rawColor) ? rawColor : undefined;
}

function readAgentColorFromRecord(value: Record<string, unknown> | null): string | undefined {
  return value ? readStringField(value, ["color", "agentColor", "agent_color"]) : undefined;
}

/** P2.6 工具分离：DispatchWorker 是 worker 派发的专名工具；Agent 派一次性 subagent。 */
export function isWorkerDispatchToolCall(toolCall: AgentToolCall): boolean {
  return toolCall.toolName?.trim().toLowerCase() === "dispatchworker";
}

/**
 * worker 派发的寻址 id：输入 worker 字段（wkr-id）。输出/元数据缺 workerName 时
 * （失败行、流式未完成、历史快照），UI 用它经名册回退查显示名。
 */
export function getWorkerDispatchId(toolCall: AgentToolCall): string | undefined {
  const inputRecord = isPlainRecord(toolCall.input) ? toolCall.input : null;
  const outputRecord = readRecordFromUnknown(toolCall.output);
  return (
    readStringField(outputRecord ?? {}, ["workerId", "worker_id"]) ??
    (inputRecord ? readStringField(inputRecord, ["worker"]) : undefined)
  );
}

/**
 * key/name 裁决（2026-11-17）：worker 派发的输出带用户可读显示名（agentType 是寻址 id，
 * 一次性 subagent 无此字段）——有值即 worker 派发，行标签与名称芯片都用它。
 */
export function getWorkerDisplayName(toolCall: AgentToolCall): string | undefined {
  const outputRecord = readRecordFromUnknown(toolCall.output);
  return outputRecord ? readStringField(outputRecord, ["workerName", "worker_name"]) : undefined;
}

export function readBackgroundAgentInfo(toolCall: AgentToolCall) {
  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const meta = raw && isPlainRecord(raw._meta) ? raw._meta : null;
  const robinrun = meta && isPlainRecord(meta.robinrun) ? meta.robinrun : null;
  const robinrunBackgroundAgent =
    robinrun && isPlainRecord(robinrun.backgroundAgent) ? robinrun.backgroundAgent : null;
  const taskNotification =
    robinrun && isPlainRecord(robinrun.taskNotification) ? robinrun.taskNotification : null;
  const backgroundAgent = robinrunBackgroundAgent;
  const input = isPlainRecord(toolCall.input) ? toolCall.input : null;
  const outputText = readTextFromUnknown(toolCall.output);
  const outputFile =
    (taskNotification && readStringField(taskNotification, ["outputFile", "output_file"])) ??
    (backgroundAgent && readStringField(backgroundAgent, ["outputFile", "output_file"])) ??
    outputText?.match(/output_file:\s*([^\s]+)/i)?.[1];

  if (input?.run_in_background !== true && input?.runInBackground !== true && !outputFile) {
    return null;
  }

  return { outputFile };
}

export function getAgentActivityContent(toolCall: AgentToolCall) {
  const taskNotificationResult =
    readStringFromNestedRecord(toolCall.raw, ["_meta", "robinrun", "taskNotification", "result"]) ??
    readStringFromNestedRecord(toolCall.raw, ["_meta", "robinrun", "taskNotification", "summary"]);
  if (taskNotificationResult) {
    // background Agent 的 output_file 是完整 sidechain transcript，
    // task-notification result 才是适合用户阅读的完成摘要。优先展示摘要，避免展开后被 JSONL 淹没。
    return taskNotificationResult;
  }

  return toolCall.content?.trim();
}

export function getAgentPrimaryText(toolCall: AgentToolCall, fallbackLabel: string) {
  const nickname = readCodexSubagentNickname(toolCall);
  if (nickname) {
    return nickname;
  }

  if (typeof toolCall.title === "string" && toolCall.title.trim().length > 0) {
    const title = toolCall.title.trim();
    if (!isImplementationToolTitle(title)) {
      return title;
    }
  }

  if (isPlainRecord(toolCall.input)) {
    const description = readStringField(toolCall.input, ["description"]);
    if (description) {
      return description;
    }

    const subagentType = readStringField(toolCall.input, ["subagent_type", "worker"]);
    if (subagentType) {
      return subagentType;
    }

    const agentType = readStringField(toolCall.input, ["agent_type"]);
    if (agentType) {
      return agentType;
    }
  }

  const outputRecord = readRecordFromUnknown(toolCall.output);
  const outputDescription = readAgentPrimaryDescription(outputRecord);
  if (outputDescription) {
    return outputDescription;
  }

  const outputAgentName = readAgentNameFromRecord(outputRecord);
  if (outputAgentName) {
    return outputAgentName;
  }

  return fallbackLabel;
}

export function getAgentPrompt(toolCall: AgentToolCall) {
  if (isPlainRecord(toolCall.input)) {
    const prompt = readStringField(toolCall.input, ["prompt", "message", "description"]);
    if (prompt) {
      return prompt;
    }
  }

  if (typeof toolCall.input === "string" && toolCall.input.trim().length > 0) {
    return toolCall.input.trim();
  }

  return undefined;
}

// ---- worker 派发行的 id → 显示名回退（2026-11-18 验收修复） ----

interface RosterNameCache {
  names: Map<string, string>;
  loadedAt: number;
}

const ROSTER_TTL_MS = 10_000;
const rosterCache = new Map<string, RosterNameCache>();
const rosterInflight = new Map<string, Promise<Map<string, string>>>();

function registryPathFor(workspacePath: string): string {
  return `${workspacePath.replace(/[\\/]+$/, "")}/.robinrun/agents/${workerRegistryFileName}`;
}

function parseRosterNames(content: string): Map<string, string> {
  const parsed = workerRegistrySchema.safeParse(JSON.parse(content) as unknown);
  if (!parsed.success) return new Map();
  // 名称字典包含全部状态（deactivated 也在内）：这里做的是历史行的显示名回退，
  // 不是可派发名册——停用 worker 的旧派发行同样要显示人读名。
  return new Map(parsed.data.workers.map((worker) => [worker.id, worker.name]));
}

async function loadRosterNames(
  workspacePath: string,
  fileService: ReturnType<typeof useBaseWorkspaceServices>["fileService"],
): Promise<Map<string, string>> {
  const path = registryPathFor(workspacePath);
  try {
    const read = await fileService.readTextFile({ path });
    return parseRosterNames(read.content);
  } catch {
    // 注册表缺失 = 项目还没有编制（合法空态）；remote 工作区读不到同样静默为空。
    return new Map();
  }
}

async function resolveNames(
  workspacePath: string,
  fileService: ReturnType<typeof useBaseWorkspaceServices>["fileService"],
): Promise<Map<string, string>> {
  const cached = rosterCache.get(workspacePath);
  if (cached && Date.now() - cached.loadedAt < ROSTER_TTL_MS) return cached.names;
  const inflight = rosterInflight.get(workspacePath);
  if (inflight) return inflight;
  const pending = loadRosterNames(workspacePath, fileService)
    .then((names) => {
      rosterCache.set(workspacePath, { names, loadedAt: Date.now() });
      return names;
    })
    .finally(() => {
      rosterInflight.delete(workspacePath);
    });
  rosterInflight.set(workspacePath, pending);
  return pending;
}

/**
 * worker 派发行名称芯片的 id → 显示名回退。DispatchWorker 成功时输出带 workerName，
 * 行标签/名称芯片直接用它；但失败行（如派发被拦）、流式未完成行、历史快照行的输出里
 * 没有 workerName，只有输入的 wkr-id——对用户不可读（key/name 裁决：id 是寻址句柄，
 * 显示名才是人读的）。按工作区读 `.robinrun/agents/workers.json`（编制唯一事实源）；
 * 渲染器逐行调用，用模块级缓存收敛文件读取：TTL 内复用，miss/过期才重读。
 */
export function useWorkerRosterName(
  workspacePath: string | undefined,
  workerId: string | undefined,
): string | undefined {
  const { fileService } = useBaseWorkspaceServices();
  const [name, setName] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!workspacePath || !workerId) {
      setName(undefined);
      return;
    }
    let cancelled = false;
    void resolveNames(workspacePath, fileService).then((names) => {
      if (cancelled) return;
      const resolved = names.get(workerId);
      setName(resolved && resolved.trim().length > 0 ? resolved : undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [fileService, workspacePath, workerId]);

  return name;
}
