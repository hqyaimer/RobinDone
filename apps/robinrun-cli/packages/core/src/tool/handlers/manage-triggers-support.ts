// ============================================================
// ManageTriggers Tool Handler - support helpers (registry IO / config normalize / gates)
// ============================================================
// 2026-11-25 分发器路由批次从 manage-triggers.ts 拆出（架构检查 max-file-lines ≤800，
// 同 trigger-engine 拆分模式）：注册表读写/冲突检测、id 生成、归属派生、webhook 与
// python 运行时状态文件耦合、config 归一与 README 脚手架——全部纯辅助，handler 主流程
// 留在 manage-triggers.ts。分发器路由的 routing 入参处理（create 缺省 dispatcher /
// update 显式切换 / 组值覆盖成员）语义见 manage-triggers.ts 的对应 case 注释。

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  MANAGE_TRIGGERS_TOOL_NAME,
  CoreErrorType,
  createCoreError,
  isFileSystemPortError,
  type FileSystemPort,
  type TriggerConfigInput,
  type TraceContext,
} from "@robinrun/contracts";
import {
  pythonRuntimeStateSchema,
  sessionKeyForTrigger,
  triggerPythonRuntimeStateFileName,
  triggerRegistryFileName,
  triggerRegistrySchema,
  TRIGGER_GROUP_ID_PREFIX,
  TRIGGER_ID_PREFIX,
  TRIGGER_REGISTRY_VERSION,
  type PythonRuntimeStateFile,
  type TriggerEntry,
  type TriggerRegistry,
} from "@robinrun/shared";
import type { ToolExecutionContext } from "../types.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function formatErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function safeJsonParse(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

export function createTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}

export function createRegistryInvalidError(registryPath: string, error: unknown): never {
  // 注册表损坏时拒绝一切写入：按空表覆盖会把既有触发器清掉，这不是可自动恢复的故障。
  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    `Trigger registry at ${registryPath} is invalid; fix it manually before trigger changes (refusing to overwrite). Detail: ${formatErrorDetail(error)}`,
    {
      context: { toolName: MANAGE_TRIGGERS_TOOL_NAME, path: registryPath },
      recoverable: false,
    },
  );
}

/** 读注册表原文；缺失返回 undefined（首个 create 前的合法状态）。 */
export async function readRegistryRaw(
  fileSystemPort: FileSystemPort,
  registryPath: string,
  context: ToolExecutionContext,
): Promise<string | undefined> {
  try {
    const read = await fileSystemPort.readTextFile(
      { path: registryPath, trace: createTrace(context) },
      { signal: context.abortSignal },
    );
    return read.content;
  } catch (error) {
    // 注册表缺失 = 空注册表（首个 create 前的合法状态）。
    if (isFileSystemPortError(error) && error.code === "not_found") {
      return undefined;
    }
    throw error;
  }
}

export function parseRegistryContent(
  content: string | undefined,
  registryPath: string,
): TriggerRegistry {
  if (content === undefined) {
    return { version: TRIGGER_REGISTRY_VERSION, triggers: [], groups: [], profiles: [] };
  }
  const parsed = triggerRegistrySchema.safeParse(safeJsonParse(content));
  if (!parsed.success) {
    createRegistryInvalidError(registryPath, parsed.error);
  }
  return parsed.data;
}

/**
 * 写前冲突检测（2026-11-23，用户裁决 B5）：handler 全程持动作开始时的注册表快照、结尾
 * 回写。install_packages 经反向请求到引擎跑 pip（分钟级窗口），窗口内引擎会写入
 * lastFireAt/熔断计数/伪删除标记——陈旧快照回写会把它们整体回滚（伪删除的触发器复活、
 * 熔断状态丢失）。与 ManageWorkers 的脏检查同思路：写前重读比对，不一致即拒绝写入，
 * 让模型基于新状态重试；install_packages 未改动注册表则整段跳过回写。
 */
export async function ensureRegistryUnchanged(
  fileSystemPort: FileSystemPort,
  registryPath: string,
  context: ToolExecutionContext,
  baselineRaw: string | undefined,
): Promise<void> {
  const currentRaw = await readRegistryRaw(fileSystemPort, registryPath, context);
  if (currentRaw !== baselineRaw) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      `Trigger registry changed concurrently since this action started (the engine recorded fires/crashes, or another session modified triggers.json). Nothing was written; review the current state and repeat this action against the fresh registry.`,
      {
        context: { toolName: MANAGE_TRIGGERS_TOOL_NAME, path: registryPath },
        recoverable: true,
      },
    );
  }
}

export async function writeRegistry(
  fileSystemPort: FileSystemPort,
  registryPath: string,
  registry: TriggerRegistry,
  context: ToolExecutionContext,
): Promise<void> {
  // 写前整表校验：订阅互斥等交叉不变量在这里兜底（单条目构造出的中间态必须满足全局一致）。
  const validated = triggerRegistrySchema.safeParse(registry);
  if (!validated.success) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      `Resulting trigger registry would be invalid; change rejected. Detail: ${formatErrorDetail(validated.error)}`,
      { context: { toolName: MANAGE_TRIGGERS_TOOL_NAME }, recoverable: true },
    );
  }
  await fileSystemPort.writeTextFile(
    {
      path: registryPath,
      content: `${JSON.stringify(validated.data, null, 2)}\n`,
      atomic: true,
      createParents: true,
      trace: createTrace(context),
    },
    { signal: context.abortSignal },
  );
}

export function generateId(prefix: string, existing: ReadonlySet<string>): string {
  // 8 位随机 id，冲突时重试；id 是路径锚点，生成后永不复用。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = `${prefix}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    if (!existing.has(id)) return id;
  }
  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    "Failed to generate a unique trigger id",
    { context: { toolName: MANAGE_TRIGGERS_TOOL_NAME }, recoverable: true },
  );
}

/**
 * 订阅者=创建者（docs/trigger-system.md 裁决）的机制层钉死（2026-11-22 实测修复）：
 * 归属一律按**调用会话身份**派生（context.workerIdentity 在场 = worker 会话 → 该 worker
 * 的 wkr-id；缺席 = master 会话 → "master"），模型传入的 ownerAgentId 一律忽略。
 *
 * 根因：worker 会话的模型不知道自己的 wkr-id（名册投影只进 master 会话），此前"worker
 * 应传自己的 wkr-id"的契约必然失真——实测 worker 创建的触发器全部落 master 名下（事件
 * 唤醒 master 而非 worker，侧栏也挂错组）。下游投递链/会话物化/侧栏归组本就支持 worker
 * 订阅者，只断在创建入口。返回派生值与是否发生了忽略（供输出 warnings）。
 */
export function resolveOwnerAgentId(
  context: ToolExecutionContext,
  parsedOwnerAgentId: string | undefined,
): { ownerAgentId: string; ignoredSupplied: boolean } {
  const derived = (context.workerIdentity?.workerId ?? "").trim() || "master";
  const supplied = parsedOwnerAgentId?.trim();
  return { ownerAgentId: derived, ignoredSupplied: supplied !== undefined && supplied !== derived };
}

/**
 * 读引擎持久化的 webhook 服务基址（`state/webhook.json`，desktop host 引擎挂载
 * 工作区时写入）。CLI 进程无法从内存得知动态端口，只能经这份文件得知引擎是否在
 * 运行及其基址。缺失 = 引擎未运行/未分配端口，webhookUrl 输出缺席并在文案里指引。
 */
export async function readWebhookBaseUrl(
  fileSystemPort: FileSystemPort,
  triggersRoot: string,
  context: ToolExecutionContext,
): Promise<string | undefined> {
  let content: string;
  try {
    const read = await fileSystemPort.readTextFile(
      { path: join(triggersRoot, "state", "webhook.json"), trace: createTrace(context) },
      { signal: context.abortSignal },
    );
    content = read.content;
  } catch {
    // 文件缺失/不可读 = 引擎未运行（CLI headless、桌面端未启动）→ URL 不可用。
    return undefined;
  }
  try {
    const parsed = safeJsonParse(content) as { baseUrl?: unknown } | null;
    if (parsed && typeof parsed.baseUrl === "string" && parsed.baseUrl.length > 0) {
      return parsed.baseUrl;
    }
  } catch {
    // 损坏文件视为不可用，不影响工具主流程。
  }
  return undefined;
}

/**
 * 读引擎持久化的 python 运行时可用性状态（`state/python-runtime.json`，2026-11-22
 * python 主运行时改造：引擎挂载/安装时写，本 handler 只读）。缺失/损坏 = 引擎未运行
 * 或尚未探测，门控按「python 不可用」处理（node 备选），与 readWebhookBaseUrl 同款
 * 文件耦合语义。
 */
export async function readPythonRuntimeState(
  fileSystemPort: FileSystemPort,
  triggersRoot: string,
  context: ToolExecutionContext,
): Promise<PythonRuntimeStateFile | undefined> {
  let content: string;
  try {
    const read = await fileSystemPort.readTextFile(
      {
        path: join(triggersRoot, "state", triggerPythonRuntimeStateFileName),
        trace: createTrace(context),
      },
      { signal: context.abortSignal },
    );
    content = read.content;
  } catch {
    return undefined;
  }
  const parsed = pythonRuntimeStateSchema.safeParse(safeJsonParse(content));
  return parsed.success ? parsed.data : undefined;
}

/**
 * script config 的运行时门控（2026-11-22 裁决）：python 运行时可用 → 必须 python
 * （三方包经 install_packages）；不可用/probing/状态缺失 → node 备选（仅标准库）。
 * 门控只约束**新建与修改**：存量条目不迁移、照常运行（迁移 = update 切 runtime）。
 */
export type ScriptRuntimeGate = { pythonAvailable: true } | { pythonAvailable: false; note: string };

export async function resolveScriptRuntimeGate(
  fileSystemPort: FileSystemPort,
  triggersRoot: string,
  context: ToolExecutionContext,
): Promise<ScriptRuntimeGate> {
  const state = await readPythonRuntimeState(fileSystemPort, triggersRoot, context);
  if (state === undefined) {
    return {
      pythonAvailable: false,
      note:
        "no python runtime state yet — the desktop engine has not probed this project; python may become available shortly",
    };
  }
  if (state.state === "available") return { pythonAvailable: true };
  if (state.state === "probing") {
    return {
      pythonAvailable: false,
      note: "the python runtime is still being provisioned (interpreter download/probe in progress) — retry shortly",
    };
  }
  return {
    pythonAvailable: false,
    note: `python runtime is unavailable: ${state.error ?? "unknown reason"}`,
  };
}

export function assertScriptRuntimeAllowed(gate: ScriptRuntimeGate, runtime: "node" | "python"): void {
  if (runtime === "python" && !gate.pythonAvailable) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      `python is not available right now (${gate.note}). Create this script trigger with runtime "node" instead (standard library only, no third-party packages), or retry later — the engine re-probes python at app start and on install_packages.`,
      { context: { toolName: MANAGE_TRIGGERS_TOOL_NAME }, recoverable: true },
    );
  }
  if (runtime === "node" && gate.pythonAvailable) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      'python is available, so script triggers must use the python runtime (managed interpreter; third-party packages via install_packages). Existing node triggers keep running; to migrate one, use the update action with runtime "python".',
      { context: { toolName: MANAGE_TRIGGERS_TOOL_NAME }, recoverable: true },
    );
  }
}

/**
 * 归一化输入 config 为注册表 config：
 * - webhook：path 缺省 `hooks/<id>`、token 缺省随机 32hex；同类型 update 缺省沿用旧值（不换 token）。
 * - script：runMode/schedule 按 2026-11-25 定时执行模式落库（契约 superRefine 已保证
 *   scheduled⇒schedule、resident 禁 schedule）；update 未显式给 runMode 时沿用旧值
 *   （缺省 resident，零迁移）；timeoutMs 遗留字段在 update 时自然清除（引擎本就忽略）。
 */
export function normalizeConfig(
  input: TriggerConfigInput,
  triggerId: string,
  existing: TriggerEntry | undefined,
): TriggerEntry["config"] {
  if (input.kind === "cron" || input.kind === "interval") return input;
  const sameKindExisting =
    existing && existing.config.kind === input.kind ? existing.config : undefined;
  if (input.kind === "webhook") {
    // TS 无法把 input.kind 与 existing.config.kind 的关联跨变量收窄，分支内再收一次。
    const previous = sameKindExisting?.kind === "webhook" ? sameKindExisting : undefined;
    return {
      kind: "webhook",
      path: input.path ?? previous?.path ?? `hooks/${triggerId}`,
      token: input.token ?? previous?.token ?? randomUUID().replace(/-/g, ""),
    };
  }
  const previous = sameKindExisting?.kind === "script" ? sameKindExisting : undefined;
  const runMode = input.runMode ?? previous?.runMode ?? "resident";
  // scheduled 模式才有 schedule（契约 superRefine 保证在场：新建必传、沿用旧值必有）。
  const schedule = runMode === "scheduled" ? (input.schedule ?? previous?.schedule) : undefined;
  return {
    kind: "script",
    runMode,
    ...(schedule !== undefined ? { schedule } : {}),
    runtime: input.runtime,
    entry: input.entry,
    ...(input.profile !== undefined
      ? { profile: input.profile }
      : previous?.profile !== undefined
        ? { profile: previous.profile }
        : {}),
    ...(input.headed !== undefined
      ? { headed: input.headed }
      : previous?.headed !== undefined
        ? { headed: previous.headed }
        : {}),
  };
}

/** scheduled 模式 README 行内计划描述（cron/interval 的人类可读形态；schema superRefine
 * 保证 scheduled 必带 schedule，undefined 仅 defensive）。 */
function describeScheduleInline(
  schedule: { kind: "cron"; schedule: string } | { kind: "interval"; intervalMinutes: number } | undefined,
): string {
  if (schedule === undefined) return "its schedule";
  return schedule.kind === "cron"
    ? `cron: ${schedule.schedule}`
    : `every ${schedule.intervalMinutes} min`;
}

/** create 时写入 README.md 的固定脚手架：模型只补说明正文，系统参考段由程序钉住。 */
export function buildReadmeContent(input: {
  name: string;
  ownerAgentId: string;
  readme: string;
  entry: TriggerEntry;
  scriptDirPath: string;
}): string {
  const { name, ownerAgentId, readme, entry, scriptDirPath } = input;
  // 会话行按路由策略分变体（2026-11-25 分发器裁决）：dispatcher 档的绑定会话是分发器
  // （只路由不处理），语义与 direct/fixed 的"就地处理"不同，脚手架必须钉对。
  const sessionLine =
    entry.routing === "dispatcher"
      ? `- session (dispatcher): this trigger's dedicated session (key: ${sessionKeyForTrigger(entry)}) is a DISPATCHER — it only classifies delivered events into topics and routes them via RouteEvents to per-topic sessions it creates/continues (all owned by you, the subscriber); it must not handle events itself.`
      : entry.routing === "fixed"
        ? `- session: each delivery of this trigger starts a NEW session owned by you (no persistent session; key ${sessionKeyForTrigger(entry)} is not bound) — handle events on delivery.`
        : `- session: all events of this trigger are delivered into ONE dedicated session (key: ${sessionKeyForTrigger(entry)}); different triggers/groups get different sessions.`;
  const lines = [
    `# Trigger: ${name}`,
    "",
    readme.trim(),
    "",
    "## System reference (maintained by the system; do not edit this section)",
    "",
    `- id: ${entry.id}`,
    `- type: ${entry.config.kind}`,
    `- owner/subscriber: ${ownerAgentId}`,
    sessionLine,
  ];
  if (entry.config.kind === "script") {
    // 双变体（2026-11-22 python 主 + node 备选）：README 脚手架按触发器自己的 runtime
    // 钉协议——python 可用时的触发器只暴露 python 协议，node 字样不出现；node 备选
    // 触发器则钉 IPC 桥接协议并注明降级原因与迁移路径。
    const isPython = entry.config.runtime === "python";
    // 运行模式行按 runMode 分变体（2026-11-25 定时执行模式）：
    // resident = 常驻事件源进程；scheduled = 到点跑一趟（exit 0 不结束触发器）。
    const runModeLine =
      entry.config.runMode === "scheduled"
        ? `- scheduled execution mode: the engine runs the script ONCE per scheduled fire (${describeScheduleInline(entry.config.schedule)}) — each run does one pass: collect data, emit event(s) via robinrun.emit, then exit 0. Do NOT loop, sleep, or wait for anything inside the script. exit 0 does NOT complete the trigger (it stays active for the next fire); exit non-zero = crash (retried with backoff on the next fires; after 3 consecutive crashes it circuit-breaks to error-paused and you are notified — fix and re-enable). If the previous run is still going at the next fire, that fire is skipped and audited. Scheduled runs do not occupy the resident-script concurrency quota.`
        : "- resident event-source process: the engine starts it automatically whenever the trigger is active (including at app launch), restarts it with backoff when it crashes, and stops it on disable. Implement any timing or subscription inside the script itself (timers, websockets, self-hosted webhooks).";
    lines.push(
      `- script dir: ${scriptDirPath} (entry: ${entry.config.entry}, runtime: ${entry.config.runtime})`,
      // 生命周期/事件协议必须钉进脚手架（v1 批处理模型的"stdout 最后一行 JSON"契约
      // 已退役，写错协议脚本会永不投递）。
      runModeLine,
      isPython
        ? '- event protocol (engine-enforced): the engine injects a helper module — `import robinrun` then call `robinrun.emit("short summary", data)` for each event (data optional; must satisfy the registry `contract` assertions against `data`). The call blocks until the engine validates and accepts the event and raises RuntimeError on contract violation (a failing assertion counts as a script failure). NEVER print events to stdout — stdout/stderr go to audit logs only, so subprocess and library output cannot corrupt your events. Third-party packages: request ManageTriggers install_packages — do not assume anything beyond the standard library. Shutdown: the engine stops the process tree after a grace window; on POSIX a SIGTERM arrives first (catch signal.SIGTERM / signal.SIGINT for cleanup — closing browsers, flushing state), on Windows the tree is killed outright, so keep state flushed continuously rather than only at exit.'
        : "- event protocol (engine-enforced): report events with the injected global robinrun.emit({ summary, data }) — AWAIT it (it resolves when the engine accepts the event; the payload must satisfy the registry `contract` assertions against `data`), and register robinrun.onShutdown(fn) for graceful cleanup (closing browsers etc.). This is the node fallback runtime (python is unavailable in this environment): standard library only, no third-party packages. When python becomes available, migrate via ManageTriggers update with runtime \"python\".",
      entry.config.runMode === "scheduled"
        ? "- stdout/stderr are logs (audit only, never delivered)."
        : "- lifecycle: exit code 0 = done (the trigger turns completed; rerun via re-enable). exit non-zero = crash (auto-restart with backoff; after 3 consecutive crashes it circuit-breaks to error-paused and the user is notified — fix the script and re-enable). stdout/stderr are logs (audit only, never delivered).",
      // 职责分界引导（2026-11-25 用户裁决："不为分而分、不为合而合"）——resident/scheduled
      // 通用的聚合原则，钉进每个脚本触发器的脚手架。
      "- sizing principle: this script covers ONE responsibility domain. If it emits several event types of that domain (e.g. comments, traffic, operations metrics of one platform), emit them all here and keep routing \"dispatcher\" so the bound session classifies them into per-topic sessions. Do not merge unrelated domains into this script, and do not split this domain into more scripts.",
    );
  }
  if (entry.config.kind === "webhook") {
    lines.push(
      `- webhook path: ${entry.config.path} (POST events to the engine's local loopback URL with this path; the full URL with port and token is returned by ManageTriggers create/update — the port is engine-assigned and may change after the desktop app restarts).`,
    );
  }
  return lines.join("\n");
}

// 组 id 前缀在此文件仅被 generateId 的调用方使用；导入占位防止误删共用常量。
export { TRIGGER_GROUP_ID_PREFIX, TRIGGER_ID_PREFIX };
