// import { replyToChannelToolEntry } from "./reply-to-channel.js";
// ============================================================
// Built-in Tool Handlers
// ============================================================

import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
  GET_WORKFLOW_RUN_TOOL_NAME,
  LIST_MODELS_TOOL_NAME,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
  SUBMIT_RESULT_TOOL_NAME,
  type JsonSchema,
} from "@robindone/contracts";
import type { ToolEntry } from "../types.js";
import { deferredToolCallEntry } from "./deferred-tool-call.js";
import { toolSearchToolEntry } from "./tool-search.js";
import { readToolEntry } from "./read.js";
import { writeToolEntry } from "./write.js";
import { editToolEntry } from "./edit.js";
import { bashToolEntry, createBashToolEntry } from "./bash.js";
import type { BashTimeoutPolicy } from "../bash-timeout-policy.js";
import { createJsToolEntry, jsToolEntry } from "./node-repl.js";
import { globToolEntry } from "./glob.js";
import { grepToolEntry } from "./grep.js";
import { webFetchToolEntry } from "./webfetch.js";
import { webSearchToolEntry } from "./websearch.js";
import {
  agentToolEntry,
  createAgentToolEntry,
  createTaskToolEntry,
  taskToolEntry,
} from "./agent.js";
import { isSubagentDispatchToolName } from "../compat.js";
import { manageWorkersToolEntry } from "./manage-workers.js";
// P2.6 工具分离（裁决 13）：worker 派发专名工具，与 Agent（一次性 subagent）分开注册。
// 触发器注册表管理（2026-11-19 设计定稿，docs/trigger-system.md）：任意智能体可创建
// 触发器（订阅者=创建者），不设 includeAgent 门、不进子 runtime 强制禁用名单。
import { manageTriggersToolEntry } from "./manage-triggers.js";
// 分发器路由标记（2026-11-25 分发器裁决，specs/trigger-dispatcher-routing.md）：dispatcher
// 档触发器会话的话题聚类工具——includeRouteEvents 门（引擎端口在场）+ 轮级工具面收窄
// （非 dispatcher 会话轮次由 buildTurnDisallowedTools 隐藏，见 turn-tool-visibility.ts）。
import { routeEventsToolEntry } from "./route-events.js";
// 需求/审批/反馈面板（2026-11-24 MVP）：同名双变体（master 7 动作 / worker 3 动作），
// 按 opsPanelVariant 二选一（contactAgent 变体门同款）。
import {
  manageOpsPanelToolEntry,
  workerManageOpsPanelToolEntry,
} from "./manage-ops-panel.js";
import { skillToolEntry } from "./skill.js";
import { todoReadToolEntry, todoWriteToolEntry } from "./todo.js";
import {
  cronCreateToolEntry,
  cronDeleteToolEntry,
  cronListToolEntry,
  cronPauseSelfToolEntry,
  cronUpdateToolEntry,
} from "./cron.js";
import { offPeakCreateToolEntry, offPeakListToolEntry } from "./off-peak.js";
import {
  createEnterPlanModeToolEntry,
  enterPlanModeToolEntry,
  exitPlanModeToolEntry,
} from "./plan-mode.js";
import { askUserQuestionToolEntry } from "./ask-user-question.js";
import { sendMessageToolEntry } from "./send-message.js";
import { respondToCoordinatorToolEntry } from "./respond-to-coordinator.js";
// agent 消息与会话感知（2026-11-19，docs/trigger-system.md）：ContactAgent 唯一请求入口
// + WaitReply 主动等待；ReturnToDispatcher 已移除（退出路径并入 ContactAgent needReply=false）。
import { contactAgentToolEntry } from "./contact-agent.js";
import { workerContactAgentToolEntry } from "./contact-agent.js";
import { waitReplyToolEntry } from "./wait-reply.js";
import { createSubmitResultToolEntry, submitResultToolEntry } from "./submit-result.js";
import { escalateToolEntry } from "./escalate.js";
import { resolveWorkflowQuestionToolEntry } from "./resolve-workflow-question.js";
import { fillWorkflowHoleToolEntry } from "./fill-workflow-hole.js";
import { taskOutputToolEntry } from "./task-output.js";
import { taskStopToolEntry } from "./task-stop.js";
import { readSessionContextToolEntry } from "./read-session-context.js";
import { amendWorkflowToolEntry } from "./amend-workflow.js";
import { createWorkflowToolEntry } from "./create-workflow.js";
import { saveWorkflowToolEntry } from "./save-workflow.js";
import { listSavedWorkflowsToolEntry } from "./list-saved-workflows.js";
import { listModelsToolEntry } from "./list-models.js";
import { evalWorkflowSnippetToolEntry } from "./eval-workflow-snippet.js";
import { listWorkflowRunsToolEntry } from "./list-workflow-runs.js";
import { getWorkflowRunToolEntry } from "./get-workflow-run.js";
import { resumeWorkflowRunToolEntry } from "./resume-workflow-run.js";
// import { workflowToolEntry } from "./workflow.js";
import { createToolRuleNameSet } from "../tool-visibility.js";

// direct 分支保留 Glob/Grep 工具实现；embedded search 分支由 registerBuiltInTools
// 统一隐藏 Glob/Grep，并通过 Bash find/grep 接管搜索。

export const builtInTools: ToolEntry[] = [
  toolSearchToolEntry,
  deferredToolCallEntry,
  readToolEntry,
  writeToolEntry,
  editToolEntry,
  // applyPatchToolEntry,
  bashToolEntry,
  globToolEntry,
  grepToolEntry,
  webFetchToolEntry,
  webSearchToolEntry,
  todoReadToolEntry,
  todoWriteToolEntry,
  cronCreateToolEntry,
  cronListToolEntry,
  cronUpdateToolEntry,
  cronDeleteToolEntry,
  cronPauseSelfToolEntry,
  offPeakCreateToolEntry,
  offPeakListToolEntry,
  enterPlanModeToolEntry,
  exitPlanModeToolEntry,
  askUserQuestionToolEntry,
  sendMessageToolEntry,
  respondToCoordinatorToolEntry,
  // agent 消息（2026-11-19）：ContactAgent/WaitReply 与 RespondToCoordinator 同构——
  // agentContactPort 在场才注册（master 主会话自建端口；worker_child 由装配注入），
  // 注入门在 runtime-tools.ts；subagent_child 不注入端口即天然无此工具。
  // 2026-11-23 C1 裁决：ContactAgent 拆 master/worker 双变体（同名不同 schema），
  // 按 agentContactVariant 二选一；WaitReply 收敛 master 专属。
  contactAgentToolEntry,
  workerContactAgentToolEntry,
  waitReplyToolEntry,
  submitResultToolEntry,
  // actor 的升级通道。与 submit_result 完全同构：
  // 端口在场即注册（includeEscalate），`tools:"none"` 下由 workflow_child 的 allowlist
  // 补回逻辑救回来。不入 actor 的默认 disallow——最可能撞上未预见之墙的 actor 恰是
  // 作者没标记的那一个。
  escalateToolEntry,
  taskOutputToolEntry,
  taskStopToolEntry,
  readSessionContextToolEntry,
  // 渠道回复等待插件入口接入；仅注释默认注册，保留完整实现。
  // replyToChannelToolEntry,
  agentToolEntry,
  taskToolEntry,
  // worker 编制管理（2026-11-15 裁决）：与 Agent 同门（includeAgent），只在持有 subagent
  // 能力的主会话注册；子 runtime 由 tool-policy 的强制禁用名单再兜一层。
  manageWorkersToolEntry,
  // worker 派发（P2.6 裁决 13）：与 Agent 同门（includeAgent，经 subagentDispatchToolNames
  // 判定同一道门）；子 runtime 由 tool-policy 强制禁用（派发权只归主智能体）。
  // 触发器注册表管理（2026-11-19，docs/trigger-system.md）：任意智能体可创建触发器
  // （订阅者=创建者），worker 会话同样需要；不在 includeAgent 门与强制禁用名单内。
  manageTriggersToolEntry,
  // 分发器路由标记（2026-11-25 分发器裁决）：includeRouteEvents 门（triggerRuntimePort
  // 在场 = desktop 有引擎）；越权调用（非分发器会话）由引擎 routeEvents 机制层拒绝。
  routeEventsToolEntry,
  // 需求/审批/反馈面板（2026-11-24 MVP）：master/worker 同名双变体，opsPanelVariant
  // 二选一（见下方注册门）；端口缺席时 handler 诚实报错（ManageTriggers 同款）。
  manageOpsPanelToolEntry,
  workerManageOpsPanelToolEntry,
  skillToolEntry,
  jsToolEntry,
  createWorkflowToolEntry,
  amendWorkflowToolEntry,
  // 保存的定义：写侧 gate 与 CreateWorkflow 同档（alwaysAsk），读侧无 gate。
  saveWorkflowToolEntry,
  // workflow 创作的实验通道：同步、只读（v1）、完全瞬态。
  evalWorkflowSnippetToolEntry,
  // run 内省的两个只读工具：主会话 always-on、无 gate。它们不进 WORKFLOW_CHILD_DISALLOWED_TOOLS——
  // 那条禁令的理由是 CreateWorkflow 的 alwaysAsk 在子 runtime 里无窗可弹，只读查询不适用；但子
  // runtime 不持有 run 端口，它们在那里必然失败，所以按另一条规则从子 runtime 移除
  // （runtime/helpers/tool-allowlist.ts 的 RUN_INTROSPECTION_TOOLS）。
  listWorkflowRunsToolEntry,
  getWorkflowRunToolEntry,
  // run 的恢复入口：与上面两个只读内省工具同族（run_id 键、端口探测失败同款），但它是
  // 执行语义——alwaysAsk 非 yolo 不可（cancelled 是用户的显式停止决定，复活必须先问），
  // 因此须进 WORKFLOW_CHILD_DISALLOWED_TOOLS（child yolo 无窗可弹）。插在 GetWorkflowRun 之后：run 工具簇 list/get/resume 相邻。
  resumeWorkflowRunToolEntry,
  // 升级问答的主代理侧：与上面三个 run 工具同族——
  // 同一个 dwf run 端口、同款 typeof 探测失败。与它们的不同点在下游：它进 actor 会话的
  // 禁用名单（bootstrap 的 workflowActorToolPolicy），子代理不许替主代理作答。
  resolveWorkflowQuestionToolEntry,
  // 留白补全的主代理侧（docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」）：与
  // ResolveWorkflowQuestion 同族（run 端口、typeof 探测失败同款），但它在写脚本——与 AmendWorkflow
  // 同一道 alwaysAsk 门、同一条 owner 免确认规则，也同它一起进 workflow child 的禁用名单。
  fillWorkflowHoleToolEntry,
  // 定义清单（与上面两个 run 工具是两件事：那是历史，这是可跑的东西）。同为只读、无 gate。
  listSavedWorkflowsToolEntry,
  // 模型目录：同为只读、无 gate 的发现面，服务于 CreateWorkflow / AmendWorkflow 的
  // `subagent_model`。不进 WORKFLOW_CHILD_DISALLOWED_TOOLS
  // ——那条禁令的理由是 alwaysAsk 在 child 里无窗可弹，只读查询不适用。
  listModelsToolEntry,
  // workflowToolEntry,
];

/**
 * 动态工作流灰度门关闭时不注册的十一个工具
 * （2026-09-28 起含 FillWorkflowHole：关闭态下没有 run 会到达留白）。
 * 灰度关的语义是「没有任何办法开始一条工作流」，所以创建、修订、保存、快照实验与四个
 * run 面工具一起下架；只读的 run 内省工具也在列，因为关闭态下它们只会指向用户无法再操作的历史。
 * `ListModels` 也在列：它唯一的用途是给一次 run 挑 `subagent_model`，没有 CreateWorkflow 可填时留着它只会把模型引向不存在的工具。
 * 旧的 `Workflow` 工具（`/expert` 脚本通道）是另一个功能，**不在**这份名单里。
 */
const DYNAMIC_WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set([
  CREATE_WORKFLOW_TOOL_NAME,
  AMEND_WORKFLOW_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  LIST_MODELS_TOOL_NAME,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  GET_WORKFLOW_RUN_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
]);

/** 十个受灰度门管的工作流工具之一？冷恢复按历史判定激活时用（launch.md「On demand: activation」）。 */
export function isDynamicWorkflowToolName(toolName: string): boolean {
  return DYNAMIC_WORKFLOW_TOOL_NAMES.has(toolName);
}

interface RegisterBuiltInToolsOptions {
  bashTimeoutPolicy?: BashTimeoutPolicy;
  includeSkill?: boolean;
  includeAgent?: boolean;
  includeSendMessage?: boolean;
  includeRespondToCoordinator?: boolean;
  /**
   * agent 消息门（2026-11-19）：ContactAgent/WaitReply 端口在场才注册——master 主会话
   * 自建端口、worker_child 由装配注入；subagent_child 不注入即天然无此工具。
   */
  includeAgentContact?: boolean;
  /**
   * ContactAgent 变体选择（2026-11-23 C1 裁决）：master = 带 needReply/waitFor 的完整
   * 变体；worker = 无必答参数的 notification-only 变体（同名工具）。缺席按 master 处理。
   */
  agentContactVariant?: "master" | "worker";
  /**
   * ManageOpsPanel 变体选择（2026-11-24 MVP）：master = 7 动作完整变体（读全部/起草/
   * 处置/分诊/确认执行）；worker = 3 动作受限变体（只读自己提交的 + 提反馈，过滤在
   * host 服务层）。缺席按 master 处理。判据与 agentContactVariant 同源（workerIdentity）。
   */
  opsPanelVariant?: "master" | "worker";
  /**
   * WaitReply 门（2026-11-23 C1 裁决）：master 会话专属——worker 不允许要求必答后，
   * worker 名下无可等待的在途请求。与 includeAgentContact 同为端口在场，附加 workerIdentity
   * 缺席条件（runtime-tools 计算）。
   */
  includeWaitReply?: boolean;
  includeSubmitResult?: boolean;
  /**
   * 在场时 submit_result 以 typed 声明注册（`{ result: <schema> }`，strict 资格），供 dwf mono
   * 子代理；缺席即通用声明。只在 includeSubmitResult 为真时有意义。
   */
  submitResultSchema?: JsonSchema;
  /** actor 的升级通道；门与 includeSubmitResult 同款（注入了 WorkflowEscalatePort 才注册）。 */
  includeEscalate?: boolean;
  includeWorkflow?: boolean;
  includeAutomation?: boolean;
  /** worker 会话置 false：编制管理独占于 master 会话（docs/worker-session-model.md §5）。 */
  includeManageWorkers?: boolean;
  /**
   * 分发器路由标记门（2026-11-25 分发器裁决）：triggerRuntimePort 在场才注册 RouteEvents
   * （desktop 有引擎；独立 CLI 无 RouteMarkQueue 语义，诚实缺席）。非分发器会话的越权
   * 调用由引擎 routeEvents 机制层拒绝；工具面噪音由轮级收窄（turn-tool-visibility）处理。
   */
  includeRouteEvents?: boolean;
  /** Off-Peak 会话内创建工具面；由 host 的 offPeakToolEnabled flag（灰度/远程门）驱动。 */
  includeOffPeak?: boolean;
  /**
   * 动态工作流灰度门。**只有显式 false
   * 才下架** DYNAMIC_WORKFLOW_TOOL_NAMES：缺席代表调用方不参与灰度（TUI、headless、
   * workflow_child），它们必须保留全部工具面；fail-closed 的缺省值落在协议服务端的
   * appRuntimePreferences，不在这一层。
   */
  includeDynamicWorkflow?: boolean;
  /** node_repl（js）默认关闭，由官方 browser-use 插件启用。 */
  includeNodeRepl?: boolean;
  /** browser-use 说明和 agent.browsers 注入由官方 browser-use 插件 + 宿主 browser bridge 共同启用。 */
  includeBrowserUse?: boolean;
  embeddedSearchEnabled?: boolean;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  silentDuplicateWarnings?: boolean;
}

export function registerBuiltInTools(
  registry: {
    register(entry: ToolEntry, options?: { silentDuplicateWarning?: boolean }): void;
  },
  options: RegisterBuiltInToolsOptions = {},
): void {
  const allowedTools = options.allowedTools ? new Set(options.allowedTools) : undefined;
  const disallowedTools = createToolRuleNameSet(options.disallowedTools);

  for (const entry of builtInTools) {
    if (
      options.embeddedSearchEnabled === true &&
      (entry.metadata.name === "Glob" || entry.metadata.name === "Grep")
    ) {
      continue;
    }
    if (allowedTools && !allowedTools.has(entry.metadata.name)) {
      continue;
    }
    if (disallowedTools?.has(entry.metadata.name)) {
      continue;
    }
    if (isSubagentDispatchToolName(entry.metadata.name) && options.includeAgent !== true) {
      continue;
    }
    // worker 编制管理与 Agent 同源：名册（subagent 类型）存在时才有意义；worker 会话
    // 不可触碰（编制管理独占于 master，docs/worker-session-model.md §5）。缺省（undefined）
    // 保持旧行为——只有 worker 会话装配显式传 false 才下架。
    if (
      entry.metadata.name === "ManageWorkers" &&
      (options.includeAgent !== true || options.includeManageWorkers === false)
    ) {
      continue;
    }
    if (entry.metadata.name === "Skill" && options.includeSkill === false) {
      continue;
    }
    if (entry.metadata.name === "SendMessage" && options.includeSendMessage !== true) {
      continue;
    }
    if (
      entry.metadata.name === "RespondToCoordinator" &&
      options.includeRespondToCoordinator !== true
    ) {
      continue;
    }
    if (
      (entry.metadata.name === "ContactAgent" || entry.metadata.name === "WaitReply") &&
      options.includeAgentContact !== true
    ) {
      continue;
    }
    // C1 裁决（2026-11-23）：ContactAgent 同名双变体按会话身份二选一——master 会话
    // 注册带 needReply/waitFor 的 master 变体；worker 会话注册无必答参数的 worker
    // 变体（天生 notification-only，模型见不到用不了的参数）。两个条目对象引用不同、
    // metadata.name 相同，按引用区分。
    if (entry === contactAgentToolEntry && options.agentContactVariant === "worker") {
      continue;
    }
    if (entry === workerContactAgentToolEntry && options.agentContactVariant !== "worker") {
      continue;
    }
    // 需求/审批/反馈面板（2026-11-24 MVP）：同名双变体按会话身份二选一——master 会话
    // 注册 7 动作变体；worker 会话注册 3 动作受限变体（权限矩阵的可见面）。两个条目
    // 对象引用不同、metadata.name 相同，按引用区分（contactAgent 变体门同款）。
    if (entry === manageOpsPanelToolEntry && options.opsPanelVariant === "worker") {
      continue;
    }
    if (entry === workerManageOpsPanelToolEntry && options.opsPanelVariant !== "worker") {
      continue;
    }
    // C1 裁决（2026-11-23）：WaitReply 收敛为 master 专属——worker 不允许要求必答
    // 后，worker 名下永远没有可等待的在途请求，工具面对 worker 隐藏以免误用。
    // 门由 runtime-tools 按 workerIdentity 缺席计算。
    if (entry.metadata.name === "WaitReply" && options.includeWaitReply !== true) {
      continue;
    }
    if (entry.metadata.name === "submit_result" && options.includeSubmitResult !== true) {
      continue;
    }
    if (entry.metadata.name === "escalate" && options.includeEscalate !== true) {
      continue;
    }
    if (entry.metadata.name === "Workflow" && options.includeWorkflow !== true) {
      continue;
    }
    if (
      (entry.metadata.name === "CronCreate" ||
        entry.metadata.name === "CronList" ||
        entry.metadata.name === "CronUpdate" ||
        entry.metadata.name === "CronDelete" ||
        entry.metadata.name === "CronPauseSelf") &&
      options.includeAutomation !== true
    ) {
      continue;
    }
    if (
      (entry.metadata.name === "OffPeakCreate" || entry.metadata.name === "OffPeakList") &&
      options.includeOffPeak !== true
    ) {
      continue;
    }
    // 分发器路由标记（2026-11-25 分发器裁决）：门 = 引擎端口在场（desktop 装配）；独立
    // CLI 无引擎时诚实缺席（RouteEvents 语义依赖引擎 RouteMarkQueue）。
    if (entry.metadata.name === "RouteEvents" && options.includeRouteEvents !== true) {
      continue;
    }
    if (
      options.includeDynamicWorkflow === false &&
      DYNAMIC_WORKFLOW_TOOL_NAMES.has(entry.metadata.name)
    ) {
      continue;
    }
    if (entry.metadata.name === "js" && options.includeNodeRepl !== true) {
      continue;
    }
    registry.register(resolveBuiltInToolEntryForBranch(entry, options), {
      silentDuplicateWarning: options.silentDuplicateWarnings,
    });
  }
}

function resolveBuiltInToolEntryForBranch(
  entry: ToolEntry,
  options: RegisterBuiltInToolsOptions,
): ToolEntry {
  if (entry.metadata.name === "Bash") {
    return createBashToolEntry({
      bashTimeoutPolicy: options.bashTimeoutPolicy,
      embeddedSearchEnabled: options.embeddedSearchEnabled,
    });
  }
  if (entry.metadata.name === SUBMIT_RESULT_TOOL_NAME && options.submitResultSchema !== undefined) {
    return createSubmitResultToolEntry(options.submitResultSchema);
  }
  // 灰度门同时管工具面和**描述**：Agent / Task 的描述里有一条「工作流请求必须改用
  // CreateWorkflow」，关闭时那个工具不存在，留着只会把模型指向不存在的工具。用的是与注册过滤同一个
  // options.includeDynamicWorkflow，所以首次装配与分支刷新产出的描述必然一致。
  if (entry.metadata.name === "Agent") {
    return createAgentToolEntry({
      dynamicWorkflowEnabled: options.includeDynamicWorkflow !== false,
    });
  }
  if (entry.metadata.name === "Task") {
    return createTaskToolEntry({
      dynamicWorkflowEnabled: options.includeDynamicWorkflow !== false,
    });
  }
  if (entry.metadata.name === "EnterPlanMode") {
    return createEnterPlanModeToolEntry({
      embeddedSearchEnabled: options.embeddedSearchEnabled,
    });
  }
  if (entry.metadata.name === "js") {
    return createJsToolEntry({
      browserUseEnabled: options.includeBrowserUse === true,
    });
  }
  return entry;
}
