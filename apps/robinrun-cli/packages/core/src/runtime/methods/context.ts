import { join } from "node:path";

import {
  traceContextToLogContext,
  createContextBuilder,
  createSubagentContextBuilder,
} from "../deps.js";
import type {
  Model,
  ModelToolCall,
  SkillLoadOutcome,
  TraceContext,
  ContextSourceSnapshot,
  ContextBuilder,
  ContextBuilderConfig,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { ensureMemoryDirectoryExists } from "../../memory/directory.js";
import {
  formatProjectMemoryIndexContent,
  MEMORY_INDEX_FILE_NAME,
} from "../../memory/index-content.js";
import {
  ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
  type ProjectMemoryRetrievalBranch,
} from "../../memory/project-memory-retrieval-branch.js";
import {
  normalizeReadFileStateMtimeMs,
  setReadFileStateEntry,
} from "../../tool/read-file-state.js";
import { resolveEnabledProjectMemoryRoot } from "../helpers/project-memory.js";
import { shouldUseMidConversationSystem } from "../helpers/runtime-provider-request-messages.js";
import {
  pythonRuntimeStateSchema,
  triggerPythonRuntimeStateFileName,
} from "@robinrun/shared";
import { buildContextHistoryEntries } from "./context-history-entries.js";
import { resolveRuntimeEmbeddedSearchEnabled } from "./embedded-search-branch.js";
import { composeWorkerAgentPrompt } from "../../subagent/worker-prompt.js";
import { getContextSourceShellDisplayName } from "./session-shell-environment.js";
import {
  ensureGenUiOutputDirectory,
  resolveGenUiOutputDirectory,
} from "../helpers/gen-ui-output.js";

export { buildContextHistoryEntries };

export async function ensureContextInitialized(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
  model?: Model,
): Promise<void> {
  if (this.contextInitialized) return;

  const shellDisplayName = getContextSourceShellDisplayName(this);
  // child 的快照只由父级传下的配置组成（envInfo、日期、指令快照），端口只留给 cd 之后的环境探测。
  // 修复原因：child 持有父级端口后在这里走完整解析，会重新查找 project root、探测 Project Context，
  // 而 child 的 context builder 不使用这些结果，每次启动都白读一次磁盘。
  const contextSourcePort = this.config.subagentContext ? undefined : this.contextSourcePort;
  const snapshot = contextSourcePort
    ? await contextSourcePort.resolveContextSources(
        {
          workingDirectory: this.workingDirectory,
          currentDate: this.config.currentDate,
          effectiveShellDisplayName: shellDisplayName,
          envInfo: this.config.envInfo,
          userInstructions: this.config.userInstructions
            ? {
                ...this.config.userInstructions,
                workingDirectory:
                  this.config.userInstructions.workingDirectory ?? this.workingDirectory,
              }
            : undefined,
          projectContext: this.config.projectContext,
          trace: traceContext,
        },
        { signal: undefined },
      )
    : this.createConfigOnlyContextSnapshot(this.workingDirectory);

  this.workingDirectory = snapshot.workingDirectory;
  // Bash cd 之后 workingDirectory 会变化，但 workspaceRoot 仍表示会话初始工作区边界。
  this.workspaceRoot = snapshot.workingDirectory;
  this.contextSourceSnapshot = snapshot;
  // 脚本触发器运行时提示（2026-11-22 python 主 + node 备选）：先解析（worker 注入段
  // 的 bullet 需要它），一次性 subagent 不注入。
  this.scriptRuntimeHint = this.config.subagentContext
    ? undefined
    : await resolveScriptRuntimeHint(this, snapshot.projectRoot ?? snapshot.workingDirectory);
  // 注入分流（2026-11-20 worker 会话模型同构化，docs/worker-session-model.md §3）：
  // master 会话读 master agents.md；worker 会话按身份从名册解析 profile 并拼接 worker
  // 注入段（define.md → agents.md → 预定义段）；一次性 subagent（subagentContext）两者
  // 皆不注入。随快照缓存一次，会话级 sticky，压缩后仍在。
  if (this.config.workerIdentity) {
    this.masterInstructions = undefined;
    this.workerInstructions = resolveWorkerInstructions(
      this,
      snapshot.projectRoot ?? snapshot.workingDirectory,
      this.scriptRuntimeHint,
    );
  } else {
    // 主智能体个人规则（2026-11-19 /init 裁决，docs/init-flow.md §4）：随快照读盘缓存一次，
    // 会话级 sticky；只属 master 会话，文件不存在（未跑 /init）时不注入。
    // 路径锚定项目根（快照 projectRoot，回退 workingDirectory）——workingDirectory 保留打开
    // 写法（可能是嵌套子目录），/init 把文件写在项目根。
    this.masterInstructions = this.config.subagentContext
      ? undefined
      : await loadMasterInstructions(this, snapshot.projectRoot ?? snapshot.workingDirectory);
    this.workerInstructions = undefined;
  }
  this.sessionStartGitPrefetch = true;
  this.startMcpStartup(traceContext);
  this.skillLoadOutcome = await this.discoverSkillsForContext(traceContext);
  this.memoryRoot = await this.loadProjectMemoryRoot(traceContext);
  this.memoryIndexContent = await loadProjectMemoryIndexContent(
    this,
    this.memoryRoot,
    ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
  );
  await ensureGenUiOutputDirectory(this);
  this.contextBuilder = this.createContextBuilderFromSnapshot(snapshot, this.memoryRoot, {
    memoryIndexContent: this.memoryIndexContent,
    model,
  });
  // Bug 根因：模型创建失败轮会在 Context 首次可初始化前接纳并持久化用户输入。
  // init 会替换全部内存历史，因此先保留这些权威运行条目，再接到新建的 Context 前缀之后。
  const preContextEntries = [...this.messageHistory.borrowReadOnlyRuntimeEntries()];
  this.initializeMessageHistoryFromContext(this.contextBuilder, traceContext);
  this.messageHistory.addEntries(preContextEntries);
  this.contextInitialized = true;
}

export async function getSkillCatalog(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<SkillLoadOutcome> {
  // Composer 曾独立扫描磁盘，所以运行中的 Session 会看到 AgentRuntime
  // 尚未加载的新 Skill。先经过 runtime 唯一的 context 初始化门，再返回防御性副本，
  // 让 UI 与本 Session 实际可用的 Skill 保持同一快照；新 runtime 会自然重新发现。
  await this.ensureContextInitialized(traceContext);
  const outcome = this.skillLoadOutcome ?? {
    skills: [],
    diagnostics: [],
    totalDiscovered: 0,
  };
  return {
    skills: outcome.skills.map((skill) => ({ ...skill })),
    diagnostics: outcome.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    totalDiscovered: outcome.totalDiscovered,
  };
}

/**
 * worker 注入段解析（2026-11-20 worker 会话模型同构化，docs/worker-session-model.md §3）：
 * 按 config.workerIdentity.workerId 从名册（config.subagents.profiles，bootstrap 随快照
 * 提供并逐父轮刷新）找到该 worker 的 profile，用 worker-prompt.ts 拼接 define.md →
 * agents.md → 预定义段（第④段项目 AGENTS.md 由 builder 通用 project instructions 承载）。
 * profile 缺失（worker 被删除/停用后冷恢复）时降级为不注入并留 warn——会话仍以主会话
 * 面貌工作，身份以会话记录为准，不做硬失败。
 */
function resolveWorkerInstructions(
  runtime: AgentRuntimeInternal,
  workingDirectory: string,
  scriptRuntimeHint: "python" | "node" | undefined,
): { workerId: string; content: string } | undefined {
  const identity = runtime.config.workerIdentity;
  if (!identity) return undefined;
  const profile = runtime.config.subagents?.profiles?.find(
    (candidate) => candidate.worker?.workerId === identity.workerId,
  );
  if (!profile?.worker) {
    runtime.logger?.warn("Worker roster profile unavailable for worker session", {
      event: "context.worker_instructions.missing_profile",
      module: "core.runtime",
      workerId: identity.workerId,
      workingDirectory,
    });
    return undefined;
  }
  return {
    workerId: identity.workerId,
    content: composeWorkerAgentPrompt({
      worker: profile.worker,
      agentsMd: profile.systemPrompt ?? "",
      ...(scriptRuntimeHint !== undefined ? { scriptRuntimeHint } : {}),
    }),
  };
}

/**
 * 脚本触发器运行时提示（2026-11-22 python 主 + node 备选）：读引擎可用性状态文件
 * `<projectRoot>/.robinrun/triggers/state/python-runtime.json` 投影为 "python"|"node"。
 * available → "python"（提示词只暴露 python 协议）；unavailable/probing/缺失/损坏 →
 * "node"（降级说明 + node 桥接文案，与 ManageTriggers 门控同口径）。会话级 sticky——
 * 探测中的会话拿到 node 文案，下一会话自然跟上引擎侧状态翻转。
 */
async function resolveScriptRuntimeHint(
  runtime: AgentRuntimeInternal,
  projectRoot: string,
): Promise<"python" | "node" | undefined> {
  const fileSystemPort = runtime.fileSystemPort;
  if (!fileSystemPort) return undefined;
  const statePath = join(
    projectRoot,
    ".robinrun",
    "triggers",
    "state",
    triggerPythonRuntimeStateFileName,
  );
  try {
    const read = await fileSystemPort.readTextFile({ path: statePath });
    const parsed = pythonRuntimeStateSchema.safeParse(JSON.parse(read.content));
    if (parsed.success && parsed.data.state === "available") return "python";
  } catch {
    // 缺失/损坏 = 引擎未探测或文件异常 → node 备选口径。
  }
  return "node";
}

export function createContextBuilderFromSnapshot(
  this: AgentRuntimeInternal,
  snapshot: ContextSourceSnapshot,
  memoryRoot?: string,
  options: { memoryIndexContent?: string; model?: Model; persistEnvInfo?: boolean } = {},
): ContextBuilder {
  const envInfo = snapshot.envInfo;
  // 同步 preview / config-only fallback 会构造 unknown envInfo。
  // 这类临时值不能写回 config，否则首轮真实 context source 会把它当作显式 envInfo，
  // 从而跳过 Node env/git 探测。
  if (options.persistEnvInfo !== false) {
    // 执行模型属于 model step，不写回可复用的 Context Source。
    this.config.envInfo = envInfo;
  }
  if (this.config.subagentContext) {
    return createSubagentContextBuilder({
      agentPrompt: this.config.subagentContext.agentPrompt,
      currentDate: snapshot.currentDate,
      envInfo,
      model: options.model,
      skillMetadataBudget: this.config.skillMetadataBudget,
      skills: this.skillLoadOutcome,
      userInstructions: this.config.subagentContext.userInstructions,
      // workerNotes/triggerSessionReadme 过渡补丁已退役（2026-11-20 worker 会话同构化）：
      // worker 注入面迁主 builder（workerInstructions），触发器会话（master 与 worker）
      // 都走主 builder 的 Trigger session section。
    });
  }

  const contextConfig: ContextBuilderConfig = {
    workingDirectory: snapshot.workingDirectory,
    additionalDirectories: this.config.additionalDirectories,
    envInfo,
    model: options.model,
    ...(options.model
      ? { midConversationSystem: shouldUseMidConversationSystem(this.config, options.model) }
      : {}),
    presentationSurface: this.config.presentationSurface,
    genUiOutputDirectory: resolveGenUiOutputDirectory(this),
    currentDate: snapshot.currentDate,
    userInstructions: snapshot.userInstructions,
    masterInstructions: this.masterInstructions,
    workerInstructions: this.workerInstructions,
    projectContext: snapshot.projectContext,
    memoryIndexContent: options.memoryIndexContent,
    memoryRoot,
    skills: this.skillLoadOutcome,
    agentProfiles: this.config.subagents?.profiles,
    embeddedSearchEnabled: resolveRuntimeEmbeddedSearchEnabled(this),
    skillMetadataBudget: this.config.skillMetadataBudget,
    customSystemPrompt: this.config.systemPrompt,
    workflowActor: this.config.workflowActor,
    language: this.config.language,
    outputStyle: this.config.outputStyle,
    compact: this.config.compact,
    guidanceToolNames: this.getTools(options.model).map((tool) => tool.name),
    // 触发器专属会话说明（runtime 在首个触发器投递轮读盘缓存；普通会话恒为 undefined）。
    ...(this.triggerSessionReadme !== undefined
      ? { triggerSessionReadme: this.triggerSessionReadme }
      : {}),
    // 有效路由策略（2026-11-25 分发器裁决）：trigger session section 按它追加分发职责段。
    ...(this.triggerSessionRouting !== undefined
      ? { triggerSessionRouting: this.triggerSessionRouting }
      : {}),
    // 脚本触发器运行时提示（2026-11-22 python 主 + node 备选）：master 会话的 section
    // 输入；worker 会话的对应语义在 worker 注入段内（不重复 section）。
    ...(this.scriptRuntimeHint !== undefined ? { scriptRuntimeHint: this.scriptRuntimeHint } : {}),
  };

  return createContextBuilder(contextConfig).setToolRegistry(this.registry);
}

async function loadMasterInstructions(
  runtime: AgentRuntimeInternal,
  workingDirectory: string,
): Promise<{ filePath: string; content: string } | undefined> {
  const fileSystemPort = runtime.fileSystemPort;
  if (!fileSystemPort) return undefined;
  // 裁决 10（2026-11-20）：master 单文件回小写 agents.md（不为拆而拆；与 plan/knowledge/tmp
  // 目录风格一致），裁决 9 的大写候选回退一并回退。开发期项目删除重建，不做迁移；
  // 文件不存在（未跑 /init）→ 不注入。
  const filePath = join(workingDirectory, ".robinrun", "agents", "master", "agents.md");
  try {
    const read = await fileSystemPort.readTextFile({ path: filePath });
    const content = read.content.trim();
    if (!content) return undefined;
    return { filePath, content };
  } catch {
    // 文件不存在（未跑 /init）或读取失败 → 不注入。
    return undefined;
  }
}

export async function loadProjectMemoryRoot(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<string | undefined> {
  const memoryRoot = resolveEnabledProjectMemoryRoot(this.config, this.workspaceRoot);
  if (!memoryRoot) {
    this.logMemorySkipped(traceContext, "disabled_or_excluded", {
      taskType: this.config.taskType,
    });
    return undefined;
  }
  if (!this.fileSystemPort) {
    this.logMemorySkipped(traceContext, "missing_file_system_port", {
      memoryRoot,
    });
    return undefined;
  }
  await ensureMemoryDirectoryExists(this.fileSystemPort, memoryRoot, traceContext, this.logger);
  return memoryRoot;
}

export async function loadProjectMemoryIndexContent(
  runtime: AgentRuntimeInternal,
  memoryRoot: string | undefined,
  retrievalBranch: ProjectMemoryRetrievalBranch,
): Promise<string | undefined> {
  if (retrievalBranch !== "default-index") return undefined;
  const fileSystemPort = runtime.fileSystemPort;
  if (!fileSystemPort || !memoryRoot) return undefined;
  const indexPath = join(memoryRoot, MEMORY_INDEX_FILE_NAME);
  try {
    const read = await fileSystemPort.readTextFile({ path: indexPath });
    const formattedContent = formatProjectMemoryIndexContent(read.content);
    if (!formattedContent) return undefined;
    setReadFileStateEntry(runtime.readFileState, {
      content: read.content,
      isPartialView: formattedContent !== read.content,
      limit: undefined,
      mtimeMs: normalizeReadFileStateMtimeMs(read.revision?.mtimeMs),
      offset: undefined,
      path: indexPath,
      readAt: runtime.now(),
      revisionId: read.revision?.id,
      seededFromContext: true,
      sizeBytes: read.sizeBytes,
    });
    return read.content;
  } catch {
    // 默认 Memory 分支将缺失或不可读的 index 视为没有该 context source。
    return undefined;
  }
}

export function logMemorySkipped(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
  reason: string,
  context: Record<string, unknown> = {},
): void {
  this.logger?.debug("Memory read skipped", {
    ...traceContextToLogContext(traceContext),
    event: "memory.read.skipped",
    module: "core.runtime",
    reason,
    status: "completed",
    ...context,
  });
}

export async function discoverSkillsForContext(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<SkillLoadOutcome | undefined> {
  if (!this.skillPort) {
    return undefined;
  }

  try {
    const outcome = await this.skillPort.discoverSkills({
      workingDirectory: this.workingDirectory,
      trace: traceContext,
    });
    this.logger?.debug("Skills discovered", {
      ...traceContextToLogContext(traceContext),
      diagnosticCount: outcome.diagnostics.length,
      module: "core.runtime",
      skillCount: outcome.skills.length,
      totalDiscovered: outcome.totalDiscovered,
    });
    return outcome;
  } catch (error) {
    this.logger?.warn("Skill discovery failed", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      module: "core.runtime",
    });
    return {
      skills: [],
      diagnostics: [
        {
          code: "skill_scan_failed",
          severity: "warning",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      totalDiscovered: 0,
    };
  }
}

export function createConfigOnlyContextSnapshot(
  this: AgentRuntimeInternal,
  workingDirectory: string,
): ContextSourceSnapshot {
  return {
    workingDirectory,
    envInfo: this.config.envInfo ?? {
      cwd: workingDirectory,
      platform: "unknown",
      shell: "unknown",
      osVersion: "unknown",
      nodeVersion: "unknown",
    },
    currentDate: this.config.currentDate,
    projectContext: this.config.projectContext,
    diagnostics: [],
  };
}

export function initializeMessageHistoryFromContext(
  this: AgentRuntimeInternal,
  contextBuilder: ContextBuilder,
  traceContext: TraceContext,
): void {
  const contextResult = contextBuilder.build();
  this.latestContextBuildResult = contextResult;
  this.messageHistory.init(buildContextHistoryEntries(contextResult));

  this.logger?.debug("Context built", {
    ...traceContextToLogContext(traceContext),
    event: "context.built",
    module: "core.runtime",
    sectionCount: contextResult.sections.length,
    status: "completed",
    tokenMethod: "estimated",
    tokenizer: "robinrun.estimateTokens.v1",
    totalChars: contextResult.totalChars,
    totalTokens: contextResult.totalTokens,
    sections: contextResult.sections.map((s) => ({
      name: s.name,
      source: s.source,
      chars: s.chars,
      tokens: s.tokens,
      tokenMethod: "estimated",
      confidence: "medium",
      tokenizer: "robinrun.estimateTokens.v1",
      preview: s.preview,
      content: s.content,
    })),
  });
}

export function extractToolCallsFromResult(
  this: AgentRuntimeInternal,
  result: any,
): ModelToolCall[] {
  const toolCalls: ModelToolCall[] = [];

  // Try different result formats
  const responses = result.responses ?? result.finishReasons ?? [];

  for (const response of responses) {
    if (response.toolCalls && Array.isArray(response.toolCalls)) {
      for (const tc of response.toolCalls) {
        toolCalls.push({
          id: tc.id,
          name: tc.name ?? tc.toolName,
          input: tc.input,
          providerExecuted: tc.providerExecuted,
        });
      }
    }
  }

  // Also check for flat tool_calls array
  if (result.toolCalls && Array.isArray(result.toolCalls)) {
    for (const tc of result.toolCalls) {
      if (!toolCalls.find((c) => c.id === tc.id)) {
        toolCalls.push({
          id: tc.id,
          name: tc.name ?? tc.toolName,
          input: tc.input,
          providerExecuted: tc.providerExecuted,
        });
      }
    }
  }

  return toolCalls;
}

export function shouldStreamModelText(this: AgentRuntimeInternal): boolean {
  return this.config.modelStreaming === "on";
}
