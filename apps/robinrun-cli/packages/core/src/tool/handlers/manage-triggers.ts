// ============================================================
// ManageTriggers Tool Handler - trigger registry (any agent)
// ============================================================
// RobinRun 触发器系统（2026-11-19 设计定稿，docs/trigger-system.md）：注册表唯一事实源是
// `<workspace>/.robinrun/triggers/triggers.json`，只经本工具（程序侧）写入——模型不得用
// Write/Edit 直接改注册表（无校验、可绕过订阅互斥与熔断状态机）。触发器说明是
// `<id>/README.md`（触发器自己的 AGENTS.md），说明与脚本本体走 Write/Edit，不经本工具。
// 与 ManageWorkers 的差异：触发器允许任意智能体（master/worker）创建（订阅者=创建者），
// 因此本工具不设主会话专属门，也不进子 runtime 强制禁用名单。
// 2026-11-22 python 主运行时改造（docs/trigger-python-runtime.md §4a）：create/update 的
// script config 按引擎状态文件 `state/python-runtime.json` 门控（python 可用 → 必须 python；
// 不可用/probing/缺失 → node 备选），README 模板与结果文本按 runtime 双变体；install_packages
// 经 TriggerRuntimePort 反向请求到引擎执行。

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  MANAGE_TRIGGERS_TOOL_NAME,
  ManageTriggersInputJsonSchema,
  ManageTriggersInputSchema,
  ManageTriggersOutputJsonSchema,
  ManageTriggersOutputSchema,
  type TriggerConfigInput,
  CoreErrorType,
  createCoreError,
  isFileSystemPortError,
  type FileSystemPort,
  type ManageTriggersInput,
  type ManageTriggersOutput,
  type TraceContext,
} from "@robinrun/contracts";
import {
  pythonRuntimeStateSchema,
  sessionKeyForTrigger,
  triggerAuditFileName,
  triggerDirectoryConvention,
  triggerProfilesDirectoryName,
  triggerPythonRuntimeStateFileName,
  triggerReadmeFileName,
  triggerRegistryFileName,
  triggerRegistrySchema,
  TRIGGER_GROUP_ID_PREFIX,
  TRIGGER_GROUP_SESSION_KEY_PREFIX,
  TRIGGER_ID_PREFIX,
  TRIGGER_REGISTRY_VERSION,
  type TriggerEntry,
  type TriggerGroupEntry,
  type TriggerProfileEntry,
  type PythonRuntimeStateFile,
  type TriggerRegistry,
} from "@robinrun/shared";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

function nowIso(): string {
  return new Date().toISOString();
}

/** create 时写入 README.md 的固定脚手架：模型只补说明正文，系统参考段由程序钉住。 */
function buildReadmeContent(input: {
  name: string;
  ownerAgentId: string;
  readme: string;
  entry: TriggerEntry;
  scriptDirPath: string;
}): string {
  const { name, ownerAgentId, readme, entry, scriptDirPath } = input;
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
    `- session: all events of this trigger are delivered into ONE dedicated session (key: ${sessionKeyForTrigger(entry)}); different triggers/groups get different sessions.`,
  ];
  if (entry.config.kind === "script") {
    // 双变体（2026-11-22 python 主 + node 备选）：README 脚手架按触发器自己的 runtime
    // 钉协议——python 可用时的触发器只暴露 python 协议，node 字样不出现；node 备选
    // 触发器则钉 IPC 桥接协议并注明降级原因与迁移路径。
    const isPython = entry.config.runtime === "python";
    lines.push(
      `- script dir: ${scriptDirPath} (entry: ${entry.config.entry}, runtime: ${entry.config.runtime})`,
      // 常驻模型（2026-11-21）：脚本引擎托管生命周期，事件协议必须钉进脚手架
      // （v1 批处理模型的"stdout 最后一行 JSON"契约已退役，写错协议脚本会永不投递）。
      "- resident event-source process: the engine starts it automatically whenever the trigger is active (including at app launch), restarts it with backoff when it crashes, and stops it on disable. Implement any timing or subscription inside the script itself (timers, websockets, self-hosted webhooks).",
      isPython
        ? '- event protocol (engine-enforced): the engine injects a helper module — `import robinrun` then call `robinrun.emit("short summary", data)` for each event (data optional; must satisfy the registry `contract` assertions against `data`). The call blocks until the engine validates and accepts the event and raises RuntimeError on contract violation (a failing assertion counts as a script failure). NEVER print events to stdout — stdout/stderr go to audit logs only, so subprocess and library output cannot corrupt your events. Third-party packages: request ManageTriggers install_packages — do not assume anything beyond the standard library. Shutdown: the engine stops the process tree after a grace window; on POSIX a SIGTERM arrives first (catch signal.SIGTERM / signal.SIGINT for cleanup — closing browsers, flushing state), on Windows the tree is killed outright, so keep state flushed continuously rather than only at exit.'
        : "- event protocol (engine-enforced): report events with the injected global robinrun.emit({ summary, data }) — AWAIT it (it resolves when the engine accepts the event; the payload must satisfy the registry `contract` assertions against `data`), and register robinrun.onShutdown(fn) for graceful cleanup (closing browsers etc.). This is the node fallback runtime (python is unavailable in this environment): standard library only, no third-party packages. When python becomes available, migrate via ManageTriggers update with runtime \"python\".",
      "- lifecycle: exit code 0 = done (the trigger turns completed; rerun via re-enable). exit non-zero = crash (auto-restart with backoff; after 3 consecutive crashes it circuit-breaks to error-paused and the user is notified — fix the script and re-enable). stdout/stderr are logs (audit only, never delivered).",
    );
  }
  if (entry.config.kind === "webhook") {
    lines.push(
      `- webhook path: ${entry.config.path} (POST events to the engine's local loopback URL with this path; the full URL with port and token is returned by ManageTriggers create/update — the port is engine-assigned and may change after the desktop app restarts).`,
    );
  }
  return lines.join("\n");
}

function generateId(
  prefix: string,
  existing: ReadonlySet<string>,
): string {
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

function formatErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeJsonParse(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

function createTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}

function createRegistryInvalidError(registryPath: string, error: unknown): never {
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
async function readRegistryRaw(
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

function parseRegistryContent(
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
async function ensureRegistryUnchanged(
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

async function writeRegistry(
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

function formatModelWarnings(warnings: readonly string[]): { warnings: string[] } | undefined {
  return warnings.length > 0 ? { warnings: [...warnings] } : undefined;
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
function resolveOwnerAgentId(
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
async function readWebhookBaseUrl(
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
async function readPythonRuntimeState(
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
type ScriptRuntimeGate = { pythonAvailable: true } | { pythonAvailable: false; note: string };

async function resolveScriptRuntimeGate(
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

function assertScriptRuntimeAllowed(gate: ScriptRuntimeGate, runtime: "node" | "python"): void {
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
 * - script：常驻模型（2026-11-21）不接受 schedule/timeoutMs；update 遇遗留条目自然清除
 *   旧字段（引擎本就忽略）。
 */
function normalizeConfig(
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
  return {
    kind: "script",
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

export const manageTriggersHandler: ToolHandler = async (input, context) => {
  const parsed = ManageTriggersInputSchema.parse(input) as ManageTriggersInput;
  const fileSystemPort = context.fileSystemPort;

  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for ManageTriggers tool",
      {
        context: { toolCallId: context.toolCallId, toolName: MANAGE_TRIGGERS_TOOL_NAME },
        recoverable: false,
      },
    );
  }

  // triggers.json 锚定 workspaceRoot（项目独占工作区语义），不是会话 cwd。
  const triggersRoot = join(context.workspaceRoot, ".robinrun", "triggers");
  const registryPath = join(triggersRoot, triggerRegistryFileName);
  // 读一次原文作冲突基线（写前 ensureRegistryUnchanged 比对；install_packages 不回写）。
  const baselineRaw = await readRegistryRaw(fileSystemPort, registryPath, context);
  const registry = parseRegistryContent(baselineRaw, registryPath);
  const triggers = [...registry.triggers];
  const groups = [...registry.groups];
  const profiles = [...registry.profiles];
  const warnings: string[] = [];

  let trigger: TriggerEntry | undefined;
  let group: TriggerGroupEntry | undefined;
  let profile: Pick<TriggerProfileEntry, "name" | "note" | "sites"> | undefined;
  let readmePath: string | undefined;
  let scriptDirPath: string | undefined;
  let webhookPath: string | undefined;
  let installResult: ManageTriggersOutput["installResult"];
  const timestamp = nowIso();

  const findTrigger = (id: string): TriggerEntry => {
    const found = triggers.find((candidate) => candidate.id === id);
    if (!found) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        `No trigger with id ${id}. Ids are stable; use the id returned by create.`,
        { context: { toolName: MANAGE_TRIGGERS_TOOL_NAME, id }, recoverable: true },
      );
    }
    return found;
  };

  const assertProfileExists = (profileName: string): void => {
    if (!profiles.some((candidate) => candidate.name === profileName)) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        `Profile "${profileName}" does not exist. Create it first with the create_profile action.`,
        {
          context: { toolName: MANAGE_TRIGGERS_TOOL_NAME, profile: profileName },
          recoverable: true,
        },
      );
    }
  };

  switch (parsed.action) {
    case "create": {
      const name = parsed.name!.trim();
      // 订阅者=创建者机制层钉死：归属按调用会话身份派生，不取模型传入值（见
      // resolveOwnerAgentId 注释；传入值被忽略并在输出 warnings 里告知）。
      const ownership = resolveOwnerAgentId(context, parsed.ownerAgentId);
      const ownerAgentId = ownership.ownerAgentId;
      if (ownership.ignoredSupplied) {
        warnings.push(
          `ownerAgentId was ignored; the trigger is owned by the calling agent (${ownerAgentId}) — ownership always follows the creator, it cannot be assigned.`,
        );
      }
      const id = generateId(TRIGGER_ID_PREFIX, new Set(triggers.map((item) => item.id)));
      const config = normalizeConfig(parsed.config!, id, undefined);
      if (config.kind === "script") {
        // 运行时门控（2026-11-22）：python 可用必须 python、不可用才允许 node 备选。
        const gate = await resolveScriptRuntimeGate(fileSystemPort, triggersRoot, context);
        assertScriptRuntimeAllowed(gate, config.runtime);
        if (config.profile !== undefined) {
          assertProfileExists(config.profile);
        }
      }
      if (config.kind !== "script" && parsed.contract !== undefined) {
        warnings.push(
          "contract applies to script triggers only; it is stored but ignored for this trigger type.",
        );
      }
      const entry: TriggerEntry = {
        id,
        name,
        ownerAgentId,
        groupId: null,
        config,
        ...(parsed.contract !== undefined ? { contract: parsed.contract } : {}),
        status: "active",
        consecutiveFailures: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      triggers.push(entry);

      // 先落文件后写注册表：注册表在场的瞬间说明/目录必须已就绪。
      scriptDirPath = join(triggersRoot, id, triggerDirectoryConvention.script);
      readmePath = join(triggersRoot, id, triggerReadmeFileName);
      for (const directory of Object.values(triggerDirectoryConvention)) {
        await fileSystemPort.createDirectory(
          { path: join(triggersRoot, id, directory), trace: createTrace(context) },
          { signal: context.abortSignal },
        );
      }
      await fileSystemPort.writeTextFile(
        {
          path: readmePath,
          content: buildReadmeContent({
            name,
            ownerAgentId,
            readme: parsed.readme!,
            entry,
            scriptDirPath,
          }),
          atomic: true,
          createParents: true,
          trace: createTrace(context),
        },
        { signal: context.abortSignal },
      );
      if (config.kind === "webhook") webhookPath = config.path;
      trigger = entry;
      break;
    }
    case "update": {
      const existing = findTrigger(parsed.id!.trim());
      if (parsed.name !== undefined) existing.name = parsed.name.trim();
      if (parsed.config !== undefined) {
        existing.config = normalizeConfig(parsed.config, existing.id, existing);
        if (existing.config.kind === "script") {
          // 运行时门控（2026-11-22，同 create）：config 是全量替换，改 runtime 也在此校验
          // （node→python 迁移要求 python 可用；python 可用时 update 传 node config 一并拒绝）。
          const gate = await resolveScriptRuntimeGate(fileSystemPort, triggersRoot, context);
          assertScriptRuntimeAllowed(gate, existing.config.runtime);
          if (existing.config.profile !== undefined) {
            assertProfileExists(existing.config.profile);
          }
        }
        // 换成非 script 型时契约失去意义，一并清除（契约属于脚本语义）。
        if (existing.config.kind !== "script") {
          delete existing.contract;
        }
      }
      if (parsed.contract !== undefined) {
        if (existing.config.kind !== "script") {
          warnings.push("contract applies to script triggers only; it will be ignored.");
        }
        existing.contract = parsed.contract;
      }
      existing.updatedAt = timestamp;
      trigger = existing;
      readmePath = join(triggersRoot, existing.id, triggerReadmeFileName);
      break;
    }
    case "set_status": {
      const existing = findTrigger(parsed.id!.trim());
      existing.status = parsed.status!;
      // 重新启用（含从 error-paused 恢复）即修复确认：清零连续异常计数（裁决 5）。
      if (existing.status === "active") existing.consecutiveFailures = 0;
      existing.updatedAt = timestamp;
      trigger = existing;
      readmePath = join(triggersRoot, existing.id, triggerReadmeFileName);
      break;
    }
    case "delete": {
      const existing = findTrigger(parsed.id!.trim());
      if (existing.deleted === true) {
        throw createCoreError(
          CoreErrorType.ToolExecutionFailed,
          `Trigger ${existing.id} is already deleted. Deleted triggers are kept in the registry for audit only and invisible everywhere; create a new trigger if you need the same semantics.`,
          { context: { toolName: MANAGE_TRIGGERS_TOOL_NAME, id: existing.id }, recoverable: true },
        );
      }
      // 伪删除（2026-11-21 实测裁决，与会话/智能体的伪删除一致）：条目与文件保留（审计
      // 可追溯），所有消费面不可见——引擎轮询拾取后停调度/停常驻脚本/断 webhook/断投递，
      // 列表与侧栏不再渲染。不可逆（重建请走 create）。
      existing.deleted = true;
      // 状态一并停用：任何未感知 deleted 的读者（旧版本/缓存投影）也不会再执行它。
      existing.status = "deactivated";
      // 组订阅解除（保持 groupId ↔ memberTriggerIds 双向闭合的注册表不变量）。
      if (existing.groupId !== null) {
        const group = groups.find((candidate) => candidate.id === existing.groupId);
        if (group) {
          group.memberTriggerIds = group.memberTriggerIds.filter(
            (candidate) => candidate !== existing.id,
          );
          group.updatedAt = timestamp;
        }
        existing.groupId = null;
      }
      existing.updatedAt = timestamp;
      trigger = existing;
      break;
    }
    case "create_group": {
      const name = parsed.name!.trim();
      // 组订阅者同 create：按调用会话身份派生（订阅者=创建者，机制层钉死）。
      const ownership = resolveOwnerAgentId(context, parsed.ownerAgentId);
      const subscriberAgentId = ownership.ownerAgentId;
      if (ownership.ignoredSupplied) {
        warnings.push(
          `ownerAgentId was ignored; the group is subscribed by the calling agent (${subscriberAgentId}) — ownership always follows the creator, it cannot be assigned.`,
        );
      }
      const id = generateId(TRIGGER_GROUP_ID_PREFIX, new Set(groups.map((item) => item.id)));
      const memberIds = parsed.memberTriggerIds ?? [];
      for (const memberId of memberIds) {
        findTrigger(memberId).groupId = id;
      }
      group = {
        id,
        name,
        memberTriggerIds: [...memberIds],
        subscriberAgentId,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      groups.push(group);
      break;
    }
    case "update_group": {
      const groupId = (parsed.groupId ?? parsed.id!).trim();
      const existingGroup = groups.find((candidate) => candidate.id === groupId);
      if (!existingGroup) {
        throw createCoreError(
          CoreErrorType.ToolExecutionFailed,
          `No trigger group with id ${groupId}. Ids are stable; use the id returned by create_group.`,
          { context: { toolName: MANAGE_TRIGGERS_TOOL_NAME, id: groupId }, recoverable: true },
        );
      }
      if (parsed.name !== undefined) existingGroup.name = parsed.name.trim();
      for (const memberId of parsed.addMemberIds ?? []) {
        const member = findTrigger(memberId);
        // 归属校验（2026-11-23，用户裁决 B6）：组不许混别的智能体的触发器——一个触发器
        // （或组）只有一个订阅者，组成员必须与组订阅者同主。此前无校验，A 可把 B 的
        // 触发器拉进自己的组（事件唤醒 B、清空会话却按组订阅者 A 重置，两套口径错乱）。
        if (member.ownerAgentId !== existingGroup.subscriberAgentId) {
          throw createCoreError(
            CoreErrorType.ToolExecutionFailed,
            `Trigger ${memberId} belongs to agent ${member.ownerAgentId}, but group ${existingGroup.id} is subscribed by ${existingGroup.subscriberAgentId}; a group and its members must share one subscriber. ${member.ownerAgentId} must create their own group.`,
            {
              context: { toolName: MANAGE_TRIGGERS_TOOL_NAME, id: memberId },
              recoverable: true,
            },
          );
        }
        if (member.groupId !== null && member.groupId !== existingGroup.id) {
          // 订阅上下文互斥（裁决 1）：先从旧组移除再入新组由调用方分两步做，这里硬拒绝防止静默改绑。
          throw createCoreError(
            CoreErrorType.ToolExecutionFailed,
            `Trigger ${memberId} already belongs to group ${member.groupId}; remove it from that group first (a trigger can belong to at most one group).`,
            {
              context: { toolName: MANAGE_TRIGGERS_TOOL_NAME, id: memberId },
              recoverable: true,
            },
          );
        }
        member.groupId = existingGroup.id;
        if (!existingGroup.memberTriggerIds.includes(memberId)) {
          existingGroup.memberTriggerIds.push(memberId);
        }
      }
      for (const memberId of parsed.removeMemberIds ?? []) {
        const member = findTrigger(memberId);
        if (member.groupId === existingGroup.id) {
          member.groupId = null;
        }
        existingGroup.memberTriggerIds = existingGroup.memberTriggerIds.filter(
          (candidate) => candidate !== memberId,
        );
      }
      existingGroup.updatedAt = timestamp;
      group = existingGroup;
      break;
    }
    case "create_profile": {
      const profileName = parsed.profileName!.trim();
      if (profiles.some((candidate) => candidate.name === profileName)) {
        throw createCoreError(
          CoreErrorType.ToolExecutionFailed,
          `Profile "${profileName}" already exists. Profiles are referenced by name from script configs.`,
          {
            context: { toolName: MANAGE_TRIGGERS_TOOL_NAME, profile: profileName },
            recoverable: true,
          },
        );
      }
      const entry: TriggerProfileEntry = {
        name: profileName,
        ...(parsed.profileNote !== undefined ? { note: parsed.profileNote } : {}),
        ...(parsed.profileSites !== undefined ? { sites: parsed.profileSites } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      profiles.push(entry);
      profile = { name: entry.name, note: entry.note, sites: entry.sites };
      break;
    }
    case "install_packages": {
      // 反向请求到宿主引擎执行（2026-11-22）：引擎持解释器/venv 生命周期，CLI 只转发。
      // 端口缺席（独立 CLI / 桌面端未运行）= 诚实拒绝，不静默。
      const triggerRuntimePort = context.triggerRuntimePort;
      if (triggerRuntimePort === undefined) {
        throw createCoreError(
          CoreErrorType.ConfigurationError,
          "install_packages requires the desktop trigger engine (TriggerRuntimePort is not wired in this host) — start the desktop app and retry",
          {
            context: { toolCallId: context.toolCallId, toolName: MANAGE_TRIGGERS_TOOL_NAME },
            recoverable: false,
          },
        );
      }
      const install = await triggerRuntimePort.installPackages({
        workspacePath: context.workspaceRoot,
        sessionId: context.sessionId,
        packages: parsed.packages!,
        trace: createTrace(context),
      });
      installResult = install;
      break;
    }
  }

  // webhook 触发器（create/update/set_status 命中时）：读引擎基址拼完整回调 URL。
  // 引擎未运行（CLI headless / 桌面端未启动）时 URL 缺席，文案指引稍后再查。
  let webhookUrl: string | undefined;
  if (trigger !== undefined && trigger.config.kind === "webhook") {
    const baseUrl = await readWebhookBaseUrl(fileSystemPort, triggersRoot, context);
    if (baseUrl !== undefined) {
      webhookUrl = `${baseUrl.replace(/\/$/, "")}/${trigger.config.path}?token=${trigger.config.token}`;
    } else {
      warnings.push(
        "Webhook endpoint URL is unavailable because the trigger engine (desktop app) is not running yet; the URL is delivered by ManageTriggers once the engine is up.",
      );
    }
  }

  const output = ManageTriggersOutputSchema.parse({
    action: parsed.action,
    ...(trigger !== undefined ? { trigger: serializeTrigger(trigger) } : {}),
    ...(group !== undefined ? { group } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(readmePath !== undefined ? { readmePath } : {}),
    ...(scriptDirPath !== undefined ? { scriptDirPath } : {}),
    ...(webhookPath !== undefined ? { webhookPath } : {}),
    ...(webhookUrl !== undefined ? { webhookUrl } : {}),
    ...(installResult !== undefined ? { installResult } : {}),
    triggerCount: triggers.length,
    groupCount: groups.length,
    ...formatModelWarnings(warnings),
  } satisfies ManageTriggersOutput);
  // install_packages 只跑 pip、不改注册表（引擎侧写计数/状态），跳过回写——否则分钟级
  // pip 窗口内引擎的写入会被本动作的陈旧快照整体回滚（见 ensureRegistryUnchanged 注释）。
  if (parsed.action !== "install_packages") {
    await ensureRegistryUnchanged(fileSystemPort, registryPath, context, baselineRaw);
    await writeRegistry(fileSystemPort, registryPath, { ...registry, triggers, groups, profiles }, context);
  }
  return output;
}

/** 注册表条目 → 输出镜像（strict 输出 schema 只认 contracts 侧的 config 形状）。 */
function serializeTrigger(entry: TriggerEntry): ManageTriggersOutput["trigger"] {
  return {
    id: entry.id,
    name: entry.name,
    ownerAgentId: entry.ownerAgentId,
    groupId: entry.groupId,
    config: entry.config,
    ...(entry.contract !== undefined ? { contract: entry.contract } : {}),
    status: entry.status,
    ...(entry.deleted !== undefined ? { deleted: entry.deleted } : {}),
    ...(entry.lastFireAt !== undefined ? { lastFireAt: entry.lastFireAt } : {}),
    ...(entry.lastResult !== undefined ? { lastResult: entry.lastResult } : {}),
    consecutiveFailures: entry.consecutiveFailures,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function formatManageTriggersModelContent(output: unknown): string {
  const parsed = ManageTriggersOutputSchema.safeParse(output);
  if (!parsed.success) {
    return typeof output === "string" ? output : (JSON.stringify(output) ?? String(output));
  }
  const data = parsed.data;
  const lines: string[] = [];
  switch (data.action) {
    case "create":
      lines.push(
        `Trigger "${data.trigger?.name}" created (id: ${data.trigger?.id}). Its events will be delivered into one dedicated session of the subscriber.`,
      );
      if (data.scriptDirPath && data.trigger?.config.kind === "script") {
        lines.push(
          `Write the script to ${data.scriptDirPath} (entry path as configured) with Write/Edit.`,
        );
        // 出口契约在工具输出同样钉死（与 README 脚手架双保险，2026-11-19 验收 bug），
        // 文案按 runtime 双变体（2026-11-22 python 主 + node 备选；旧版"stdout 最后
        // 一行 JSON"批处理契约文案已随常驻模型退役）。
        if (data.trigger.config.runtime === "python") {
          lines.push(
            'Script runtime: python (managed interpreter, per-project venv). Output contract: the engine injects a helper module — `import robinrun` then call `robinrun.emit("short summary", data)` for each event. The call blocks until the engine accepts it and raises on contract violation (the assertions run against data; 3 consecutive failures circuit-break the trigger). Do NOT print events to stdout — stdout/stderr are audit logs only, so subprocess/library output cannot corrupt events.',
            "Third-party packages: request ManageTriggers install_packages — the project venv is shared by all python script triggers, and active python scripts restart automatically after an install.",
          );
        } else {
          lines.push(
            'Script runtime: node (fallback — python is currently unavailable). Output contract: report events with the injected global robinrun.emit({summary, data}) — AWAIT it (it resolves when the engine accepts the event); register robinrun.onShutdown(fn) for graceful cleanup. Standard library only — no third-party packages. Once python becomes available, migrate via the update action with runtime "python".',
          );
        }
      }
      if (data.readmePath) {
        lines.push(`Description file: ${data.readmePath} (edit with Write/Edit).`);
      }
      if (data.webhookUrl) {
        lines.push(
          `Webhook endpoint: POST events to ${data.webhookUrl} (Content-Type: application/json; or send the token via the x-robinrun-token header). The port is engine-assigned and may change after the desktop app restarts — re-run the change action to refresh it.`,
        );
      }
      break;
    case "update":
      lines.push(`Trigger ${data.trigger?.id} updated.`);
      if (data.webhookUrl) {
        lines.push(`Webhook endpoint: ${data.webhookUrl}`);
      }
      break;
    case "set_status":
      lines.push(
        `Trigger ${data.trigger?.id} is now ${data.trigger?.status}${data.trigger?.status === "active" ? " (failure count reset to 0)" : ""}.`,
      );
      break;
    case "create_group":
      lines.push(
        `Trigger group "${data.group?.name}" created (id: ${data.group?.id}). Member events share the group session (key: ${TRIGGER_GROUP_SESSION_KEY_PREFIX}${data.group?.id}).`,
      );
      break;
    case "update_group":
      lines.push(`Trigger group ${data.group?.id} updated (members: ${data.group?.memberTriggerIds.length ?? 0}).`);
      break;
    case "create_profile":
      lines.push(
        `Login-state profile "${data.profile?.name}" registered. The storageState file is created on the script's first logged-in run.`,
      );
      break;
    case "install_packages": {
      const install = data.installResult;
      if (install === undefined) break;
      if (install.ok) {
        lines.push(
          `Installed ${install.packages?.join(", ") ?? "packages"} into the project's python venv.`,
        );
        if (install.restartedTriggerIds !== undefined && install.restartedTriggerIds.length > 0) {
          lines.push(
            `Active python script triggers restart automatically so the new packages take effect: ${install.restartedTriggerIds.join(", ")}.`,
          );
        }
        if (install.replayFailures !== undefined && install.replayFailures.length > 0) {
          lines.push(
            `Note: the venv was rebuilt before this install and replaying previously installed packages failed for: ${install.replayFailures.join(" | ")}`,
          );
        }
        if (install.outputTail !== undefined && install.outputTail.trim().length > 0) {
          lines.push(`pip output tail:\n${install.outputTail.slice(-1_500)}`);
        }
      } else {
        lines.push(`install_packages failed: ${install.error ?? "unknown error"}`);
        if (install.outputTail !== undefined && install.outputTail.trim().length > 0) {
          lines.push(`pip output tail:\n${install.outputTail.slice(-1_500)}`);
        }
        lines.push(
          "The engine re-probes python at app start and on every install_packages; if the network path is the problem, ask the user to check ROBINRUN_PYTHON_RUNTIME_MIRROR (interpreter download) or ROBINRUN_PIP_INDEX_URL (pip index) configuration.",
        );
      }
      break;
    }
  }
  if (data.webhookPath) {
    lines.push(
      `Webhook endpoint path: ${data.webhookPath} — POST events to the engine's local loopback URL (full URL with port is shown in the app trigger detail); token is stored in the registry.`,
    );
  }
  lines.push(`Registry: ${data.triggerCount} trigger(s), ${data.groupCount} group(s).`);
  lines.push(
    `Engine note: the desktop trigger engine picks up registry changes automatically (session keys trigger:<id> / ${TRIGGER_GROUP_SESSION_KEY_PREFIX}<gid>); ${triggerAuditFileName} under the trigger's log/ dir records every fire.`,
    `Profiles dir: .robinrun/triggers/${triggerProfilesDirectoryName} (credential-level sensitive; never log its contents).`,
  );
  return [...lines, ...(data.warnings ?? [])].join("\n");
}

export const manageTriggersToolEntry: ToolEntry = {
  capability: "Manage the project trigger registry (create/update triggers, groups, login profiles)",
  metadata: {
    name: MANAGE_TRIGGERS_TOOL_NAME,
    description: [
      "Manage this project's trigger registry — scheduled checks (cron/interval), local webhooks, and resident script processes that wake agents with events. Any agent (main or worker) can create triggers; ownership always follows the creator and is derived by the system from the calling session (a worker session owns the trigger with its wkr-id; a main session owns it as master) — you cannot create a trigger or group for another agent, and an ownerAgentId input is ignored. A trigger's events are delivered into ONE dedicated session keyed by the trigger (or its group). Boundary: only create and manage triggers that are yours or that you were explicitly instructed to handle — never touch or report on unrelated triggers.",
      "",
      "Actions:",
      "- create: register a trigger. Requires name, config (cron | interval | webhook | script), and readme (purpose, data source, output contract, failure handling) — every trigger MUST have a description. For script triggers, write the script into the returned script/ directory afterwards with Write/Edit.",
      "- update: change name, config (full replacement), or contract of an existing trigger.",
      "- set_status: active (enable; resets the failure count; restarting a resident script or rerunning a completed one), deactivated (disable; files kept), error-paused (normally set by the engine after 3 consecutive script crashes; re-enable after fixing). completed is an engine-written terminal state — re-enable from it to rerun.",
      "- create_group / update_group: bundle triggers into a subscription group so their events share one session (dedup context by design). A trigger belongs to at most one group.",
      "- create_profile: register a login-state profile name that script configs can reference (storageState is captured on first logged-in run).",
      "- install_packages: pip-install third-party packages into this project's python venv for python script triggers (requires the desktop engine; active python scripts restart automatically on success).",
      "",
      "Rules: never edit triggers.json directly; descriptions and scripts are edited via Write/Edit on README.md / script files, not through this tool. Script runtimes are gated by the engine: python is the primary script runtime (third-party packages via install_packages), and the node fallback (standard library only) is accepted only while python is unavailable — create/update enforce this, and the create result plus the README scaffold tell you which event protocol to write. Script triggers are resident event-source processes that run unattended — keep them read-only where possible and declare sanity assertions in the contract so failures are detected instead of silently returning wrong data.",
    ].join("\n"),
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: manageTriggersHandler,
  formatModelContent: formatManageTriggersModelContent,
  inputSchema: ManageTriggersInputJsonSchema,
  outputSchema: ManageTriggersOutputJsonSchema,
  runtimeInputSchema: ManageTriggersInputSchema,
  runtimeOutputSchema: ManageTriggersOutputSchema,
  permission: {
    permission: "edit",
    reason: "ManageTriggers changes the project trigger registry under .robinrun/triggers",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["input"],
    alwaysAllowPatternSources: ["input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 16_000,
    maxModelBytes: 16_000,
    strategy: "inline",
  },
  timeout: { kind: "none" },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage: "ManageTriggers was cancelled; the trigger registry is unchanged",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
