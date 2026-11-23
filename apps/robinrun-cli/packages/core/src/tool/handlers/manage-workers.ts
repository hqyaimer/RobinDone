// ============================================================
// ManageWorkers Tool Handler - main-agent-only worker roster
// ============================================================
// RobinRun worker 编制系统（2026-11-15 裁决）：编制唯一事实源是
// `<workspace>/.robinrun/agents/workers.json`，只经本工具（程序侧）写入——模型不得用
// Write/Edit 直接改注册表（无校验、可绕过唯一性、可篡改停用状态）。
// worker 双规则文件（裁决 10，2026-11-20）：`<id>/define.md`（职责定义，create 的 prompt
// 即正文，master 独占维护；worker 仅受提示词约束不得修改）+ `<id>/agents.md`（worker
// 自维护骨架，只做索引起点）。define.md 修改走 Write/Edit，不经本工具。
// 写入后由 Host 的配置监听（workers.json depth-0 + 双文件 depth-1）自动发布新名册；派发
// 解析 miss 时会重载名册快照，因此同轮即可派发（名册 reminder 清单下一轮才注入）。

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  MANAGE_WORKERS_TOOL_NAME,
  ManageWorkersInputJsonSchema,
  ManageWorkersInputSchema,
  ManageWorkersOutputJsonSchema,
  ManageWorkersOutputSchema,
  CoreErrorType,
  createCoreError,
  isFileSystemPortError,
  type FileSystemPort,
  type ManageWorkersInput,
  type ManageWorkersOutput,
  type TraceContext,
} from "@robinrun/contracts";
import {
  workerAgentsMdFileName,
  workerDefineMdFileName,
  workerDirectoryConvention,
  workerRegistryFileName,
  workerRegistrySchema,
  WORKER_REGISTRY_VERSION,
  type WorkerEntry,
  type WorkerRegistry,
} from "@robinrun/shared";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

/** create 时写入 define.md 的职责定义正文：prompt 即正文，只加标题行（master 独占维护）。 */
function buildDefineMdContent(name: string, prompt: string): string {
  return [`# Duty definition — ${name}`, "", prompt.trim()].join("\n");
}

/**
 * create 时写入 agents.md 的固定骨架：只做索引起点，正文与索引由 worker 自行维护。
 * 职责定义不在此文件（只在 define.md，由 master 维护）——明确写出这条边界，防止 worker
 * 把职责复制进自维护文件造成双头定义。工作约定（plan/knowledge/tmp 用法）已上移到
 * worker 预定义提示词（core 的 worker-prompt.ts），骨架不再重复。
 */
function buildAgentsMdSkeleton(name: string): string {
  return [
    `# ${name} — self-maintained notes`,
    "",
    "This file is maintained by the worker itself: its findings, working conventions, accumulated rules, and the index of its files. Duty definitions do NOT live here — they are in define.md, maintained exclusively by the master agent.",
    "",
    "## Index",
    "",
    "- (no files yet)",
  ].join("\n");
}

function nowIso(): string {
  return new Date().toISOString();
}

function generateWorkerId(existing: ReadonlySet<string>): string {
  // 8 位随机 id，冲突时重试；id 是路径锚点，生成后永不复用，改名只动注册表。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = `wkr-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    if (!existing.has(id)) return id;
  }
  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    "Failed to generate a unique worker id",
    { context: { toolName: MANAGE_WORKERS_TOOL_NAME }, recoverable: true },
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
  // 与 Write 的 createWriteTrace 同款：span/session 字段在 TraceContext 里可选，用结构收敛。
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}

function createRegistryInvalidError(registryPath: string, error: unknown): never {
  // 注册表损坏时拒绝一切写入：按空表覆盖会把既有编制清掉，这不是可自动恢复的故障。
  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    `Worker registry at ${registryPath} is invalid; fix it manually before roster changes (refusing to overwrite). Detail: ${formatErrorDetail(error)}`,
    {
      context: { toolName: MANAGE_WORKERS_TOOL_NAME, path: registryPath },
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
    // 注册表缺失 = 空编制（首个 create 前的合法状态）。
    if (isFileSystemPortError(error) && error.code === "not_found") {
      return undefined;
    }
    throw error;
  }
}

function parseRegistryContent(
  content: string | undefined,
  registryPath: string,
): WorkerRegistry {
  if (content === undefined) {
    return { version: WORKER_REGISTRY_VERSION, workers: [] };
  }
  const parsed = workerRegistrySchema.safeParse(safeJsonParse(content));
  if (!parsed.success) {
    createRegistryInvalidError(registryPath, parsed.error);
  }
  return parsed.data;
}

/**
 * 写前冲突检测（2026-11-23，用户裁决 D5）：read-modify-write 无跨调用互斥，两个
 * master 形态会话并发改动时后写覆盖前写（丢新建 worker 条目、目录残留孤儿）。与
 * 文件编辑工具的脏检查同思路——写前重读注册表原文，与本次动作开始时的快照比对，
 * 不一致即拒绝写入（recoverable），让 master 重读当前配置后再重试。
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
      `Worker registry changed concurrently since this action started (another session modified workers.json). Nothing was written; review the current roster and repeat this action against the fresh state.`,
      {
        context: { toolName: MANAGE_WORKERS_TOOL_NAME, path: registryPath },
        recoverable: true,
      },
    );
  }
}

/** 空白校验（2026-11-23，修复"workers.json 变砖"）：contracts schema 的 name 无 min
 * 约束、description 的 min(1) 挡不住空白串；此前 handler trim 后直接落库空串，下次
 * readRegistry 的 min(1) 校验必然失败且 recoverable:false 拒绝覆写——该项目全部编制
 * 操作被永久拒绝，只能手工修 JSON。trim 后非空是落库前置条件。 */
function requireNonEmpty(value: string, field: "name" | "description"): string {
  if (value.length === 0) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      `Worker \`${field}\` cannot be blank (whitespace-only input is rejected; it would corrupt workers.json).`,
      { context: { toolName: MANAGE_WORKERS_TOOL_NAME }, recoverable: true },
    );
  }
  return value;
}

async function writeRegistry(
  fileSystemPort: FileSystemPort,
  registryPath: string,
  workers: readonly WorkerEntry[],
  context: ToolExecutionContext,
): Promise<void> {
  const registry: WorkerRegistry = { version: WORKER_REGISTRY_VERSION, workers: [...workers] };
  await fileSystemPort.writeTextFile(
    {
      path: registryPath,
      content: `${JSON.stringify(registry, null, 2)}\n`,
      atomic: true,
      createParents: true,
      trace: createTrace(context),
    },
    { signal: context.abortSignal },
  );
}

function findNameConflict(
  workers: readonly WorkerEntry[],
  name: string,
  excludeId?: string,
): WorkerEntry | undefined {
  const normalized = name.toLowerCase();
  return workers.find(
    (worker) => worker.name.toLowerCase() === normalized && worker.id !== excludeId,
  );
}

export const manageWorkersHandler: ToolHandler = async (input, context) => {
  const parsed = ManageWorkersInputSchema.parse(input) as ManageWorkersInput;
  const fileSystemPort = context.fileSystemPort;

  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for ManageWorkers tool",
      {
        context: { toolCallId: context.toolCallId, toolName: MANAGE_WORKERS_TOOL_NAME },
        recoverable: false,
      },
    );
  }

  // workers.json 锚定 workspaceRoot（项目独占工作区语义），不是会话 cwd。
  const workersRoot = join(context.workspaceRoot, ".robinrun", "agents");
  const registryPath = join(workersRoot, workerRegistryFileName);
  // 读一次原文作冲突基线（写前 ensureRegistryUnchanged 与之比对）；解析出的注册表为
  // 本次动作的工作副本。
  const baselineRaw = await readRegistryRaw(fileSystemPort, registryPath, context);
  const registry = parseRegistryContent(baselineRaw, registryPath);
  const workers = [...registry.workers];

  let entry: WorkerEntry;
  let defineMdPath: string;
  let agentsMdPath: string;
  // key/name 裁决（2026-11-17）：name 只是显示名，重名允许（不推荐）——不再硬拒绝，
  // 冲突时附 warning 让模型知情（派发句柄是 id，重名不会引起路由歧义）。
  const warnings: string[] = [];

  if (parsed.action === "create") {
    const name = requireNonEmpty(parsed.name!.trim(), "name");
    const nameConflict = findNameConflict(workers, name);
    if (nameConflict) {
      warnings.push(
        `Display name "${name}" is also used by worker ${nameConflict.id} (${nameConflict.status}). Names are display labels and duplicates are allowed but discouraged; dispatch uses the immutable id.`,
      );
    }
    const id = generateWorkerId(new Set(workers.map((worker) => worker.id)));
    const timestamp = nowIso();
    entry = {
      id,
      name,
      description: requireNonEmpty(parsed.description!.trim(), "description"),
      ...(parsed.tools ? { tools: parsed.tools } : {}),
      ...(parsed.modelSelection ? { modelSelection: parsed.modelSelection } : {}),
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    workers.push(entry);

    // 冲突检测放全部文件写入之前：并发修改先失败，不残留孤儿 define.md/agents.md 目录。
    await ensureRegistryUnchanged(fileSystemPort, registryPath, context, baselineRaw);

    // 先落文件后写注册表：注册表在场的瞬间双规则文件必须已就绪，加载器才不会跳过该 worker。
    // createDirectory 递归建父目录；plan/knowledge/tmp 一并落地，让目录约定对 worker 可见。
    defineMdPath = join(workersRoot, id, workerDefineMdFileName);
    agentsMdPath = join(workersRoot, id, workerAgentsMdFileName);
    for (const directory of Object.values(workerDirectoryConvention)) {
      await fileSystemPort.createDirectory(
        { path: join(workersRoot, id, directory), trace: createTrace(context) },
        { signal: context.abortSignal },
      );
    }
    // 裁决 10：define.md（prompt 即职责定义正文）与 agents.md（worker 自维护骨架）同批落地。
    await fileSystemPort.writeTextFile(
      {
        path: defineMdPath,
        content: buildDefineMdContent(name, parsed.prompt!),
        atomic: true,
        createParents: true,
        trace: createTrace(context),
      },
      { signal: context.abortSignal },
    );
    await fileSystemPort.writeTextFile(
      {
        path: agentsMdPath,
        content: buildAgentsMdSkeleton(name),
        atomic: true,
        createParents: true,
        trace: createTrace(context),
      },
      { signal: context.abortSignal },
    );
    await writeRegistry(fileSystemPort, registryPath, workers, context);
  } else {
    const id = parsed.id!.trim();
    const existing = workers.find((worker) => worker.id === id);
    if (!existing) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        `No worker with id ${id}. Ids are stable; use the id returned by create.`,
        { context: { toolName: MANAGE_WORKERS_TOOL_NAME, id }, recoverable: true },
      );
    }
    if (parsed.action === "update") {
      if (parsed.name !== undefined) {
        const name = requireNonEmpty(parsed.name.trim(), "name");
        const nameConflict = findNameConflict(workers, name, id);
        if (nameConflict) {
          warnings.push(
            `Display name "${name}" is also used by worker ${nameConflict.id} (${nameConflict.status}). Names are display labels and duplicates are allowed but discouraged; dispatch uses the immutable id.`,
          );
        }
        existing.name = name;
      }
      if (parsed.description !== undefined) {
        existing.description = requireNonEmpty(parsed.description.trim(), "description");
      }
      if (parsed.tools !== undefined) existing.tools = parsed.tools;
      if (parsed.modelSelection !== undefined) existing.modelSelection = parsed.modelSelection;
    } else {
      existing.status = parsed.status!;
    }
    existing.updatedAt = nowIso();
    entry = existing;
    defineMdPath = join(workersRoot, id, workerDefineMdFileName);
    agentsMdPath = join(workersRoot, id, workerAgentsMdFileName);
    await ensureRegistryUnchanged(fileSystemPort, registryPath, context, baselineRaw);
    await writeRegistry(fileSystemPort, registryPath, workers, context);
  }

  const output = ManageWorkersOutputSchema.parse({
    action: parsed.action,
    worker: { ...entry },
    defineMdPath,
    agentsMdPath,
    rosterSize: workers.length,
    ...(warnings.length > 0 ? { warnings } : {}),
  } satisfies ManageWorkersOutput);
  return output;
};

function formatManageWorkersModelContent(output: unknown): string {
  const parsed = ManageWorkersOutputSchema.safeParse(output);
  if (!parsed.success) {
    return typeof output === "string" ? output : (JSON.stringify(output) ?? String(output));
  }
  const data = parsed.data;
  const statusLine =
    data.action === "create"
      ? `Worker "${data.worker.name}" created (id: ${data.worker.id}). Hand tasks to it via ContactAgent (target: "${data.worker.id}").`
      : data.action === "update"
        ? `Worker "${data.worker.name}" (id: ${data.worker.id}) updated.`
        : `Worker "${data.worker.name}" (id: ${data.worker.id}) is now ${data.worker.status}.`;
  return [
    statusLine,
    `Duty definition: ${data.defineMdPath} — you maintain it with Write/Edit (the worker is not allowed to modify it). Update it whenever the worker's duties or boundaries change.`,
    `Self-maintained file: ${data.agentsMdPath} — the worker's own territory; its content is maintained by the worker, not by you.`,
    // 同轮派发已打通（2026-11-18 验收修复：派发解析 miss 时重载名册快照），建队即可派工；
    // 只有 system-reminder 的名册清单要等下一轮注入，避免模型误以为要等到下一轮才能派发。
    `Roster: ${data.rosterSize} worker(s). You can hand tasks to the worker via ContactAgent right away (its id is above). The <system-reminder> roster listing catches up from your next turn.`,
    ...(data.warnings ?? []),
  ].join("\n");
}

export const manageWorkersToolEntry: ToolEntry = {
  capability: "Manage the project worker roster (create, update metadata, activate/deactivate)",
  metadata: {
    name: MANAGE_WORKERS_TOOL_NAME,
    description: [
      "Manage this project's worker roster — the persistent team members listed as agent types in the system reminder. Only the main agent manages the roster; users cannot create or edit workers directly, so route any such request through this tool.",
      "",
      "Actions:",
      "- create: register a new worker. The prompt becomes the worker's duty definition (define.md) — the file that says who the worker is, maintained by you; the worker is not allowed to modify it. Write it as a duty statement: what the worker IS responsible for, what it is NOT responsible for, and that anything outside its duties goes back to you. The tool also scaffolds the worker's own agents.md (a skeleton the worker maintains itself) plus plan/, knowledge/, and tmp/ directories. Keep the roster minimal — create a worker only for a duty that will recur.",
      "- update: rename a worker or change description, tools, or model selection. Ids are stable, so renames never break file paths.",
      "- set_status: activate or deactivate a worker. Deactivation keeps the worker's files and history; it just leaves the roster.",
      "",
      "Identity model (key/name split): the id (wkr-…) is the stable key AND the addressing handle — ContactAgent takes the id exactly as listed in the system reminder. The name is only a display label; duplicates are allowed but discouraged (this tool warns instead of failing), so you never need to rename an old worker just to reuse its name.",
      "",
      "Files: a worker's duty definition lives in its define.md — edit it with Write/Edit when its duties change, never through this tool. Its agents.md is the worker's own territory (its findings, rules, and knowledge index); do not maintain it for the worker. Never edit workers.json directly.",
    ].join("\n"),
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: manageWorkersHandler,
  formatModelContent: formatManageWorkersModelContent,
  inputSchema: ManageWorkersInputJsonSchema,
  outputSchema: ManageWorkersOutputJsonSchema,
  runtimeInputSchema: ManageWorkersInputSchema,
  runtimeOutputSchema: ManageWorkersOutputSchema,
  permission: {
    permission: "edit",
    reason: "ManageWorkers changes the project worker roster under .robinrun/agents",
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
    userVisibleMessage: "ManageWorkers was cancelled; the roster is unchanged",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
