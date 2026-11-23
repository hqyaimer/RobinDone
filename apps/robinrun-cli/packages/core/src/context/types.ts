// ============================================================
// Context Builder Types
// ============================================================

import type {
  EnvInfo,
  Model,
  ModelInputMessage,
  ProjectContext,
  ResolvedUserInstructions,
  SkillLoadOutcome,
  UserInstructionsOptions,
} from "@robinrun/contracts";
import type { AutoCompactPolicyConfig } from "../compact/index.js";
import type { AgentProfile } from "../subagent/profile.js";

export type {
  EnvInfo,
  PackageManager,
  ProjectContext,
  ProjectType,
  ResolvedUserInstructionSource,
  ResolvedUserInstructions,
  UserInstructionsOptions,
} from "@robinrun/contracts";

// -----------------------------------------------
// Context Source
// -----------------------------------------------

export type ContextSource =
  | "cli_prefix" // CLI / 产品身份前缀
  | "identity" // Agent 基础描述
  | "env_info" // 环境信息 (cwd, platform, git repo boolean)
  | "session_context" // git snapshot context
  | "model" // 当前执行模型身份
  | "skills" // 可用 skills
  | "tools" // 工具定义
  | "request_user_context" // request-level user context provider-visible 组合块
  | "memory" // 长期 memory read path
  | "current_date" // 当前日期
  | "custom_system_prompt" // 自定义 stable system body
  | "workflow_actor_identity" // 动态工作流子代理身份：契约 + persona 叠加
  | "subagent_agent_prompt" // 子 agent 专属身份/任务 prompt
  | "subagent_notes" // 子 agent 通用操作提醒
  | "dynamic_behavior" // 动态行为边界
  | "session_guidance" // 当前可用内置能力指导
  | "context_management" // 长上下文管理提示
  | "multi_agent_collaboration" // RobinRun 主智能体分流与常驻子智能体协作约定
  | "trigger_session_context" // 触发器专属会话的触发器说明（README 注入）
  | "script_runtime_context" // 脚本触发器运行时提示（python 主/node 备选，2026-11-22）
  | "master_instructions" // 主智能体个人规则（.robinrun/agents/master/agents.md 注入，裁决 10 回小写）
  | "worker_instructions" // worker 注入段（define.md → agents.md → 预定义段，worker 会话同构化）
  | "project_instructions" // 项目说明文件（AGENTS.md 注入 system；meta_user 只剩 user scope）
  | "desktop_context"; // RobinRun Desktop 渲染与交互协议

export type ContextInjectionTarget = "system" | "meta_user";

export type ContextCacheHint = "stable" | "dynamic";

export type PresentationSurface = "terminal" | "robinrun_desktop";

// -----------------------------------------------
// Context Section
// -----------------------------------------------

export interface ContextSection {
  name: string; // 人类可读的 section 名称
  source: ContextSource; // 来源标识
  injectionTarget: ContextInjectionTarget; // 注入位置
  cacheHint: ContextCacheHint; // 缓存稳定性提示
  chars: number; // 字符数
  tokens: number; // 估算 token 数
  content: string; // 完整内容
  preview: string; // 前 100 字符预览
}

export type ContextMetaUserAttachmentSource =
  | "skills_listing"
  | "context_prefix"
  | "session_context";

export interface ContextMetaUserAttachment {
  source: ContextMetaUserAttachmentSource;
  content: string;
}

// -----------------------------------------------
// Context Build Result
// -----------------------------------------------

export interface ContextBuildResult {
  sections: ContextSection[];
  totalChars: number;
  totalTokens: number;
  systemMessages: ModelInputMessage[]; // ContextBuilder 只组装 system messages
  metaUserAttachments: ContextMetaUserAttachment[]; // 未包裹 <system-reminder> 的 meta user body
}

export interface OutputStylePromptConfig {
  name: string;
  prompt: string;
  keepCodingInstructions?: boolean;
}

// -----------------------------------------------
// Context Builder Config
// -----------------------------------------------

export interface ContextBuilderConfig {
  workingDirectory: string;
  additionalDirectories?: readonly string[];
  envInfo: EnvInfo;
  /** 当前步骤的执行对象，不进入 Context Source 或持久化环境快照。 */
  model?: Model;
  /** 执行模型是否走 MCS；false 时 Harness 改述 `<system-reminder>` 通道。缺省按 MCS。 */
  midConversationSystem?: boolean;
  presentationSurface?: PresentationSurface;
  genUiOutputDirectory?: string;
  currentDate?: string;
  userInstructions?: ResolvedUserInstructions;
  projectContext?: ProjectContext;
  memoryRoot?: string;
  memoryIndexContent?: string;
  skills?: SkillLoadOutcome;
  agentProfiles?: readonly AgentProfile[];
  embeddedSearchEnabled?: boolean;
  skillMetadataBudget?: number;
  customSystemPrompt?: string;
  /**
   * 动态工作流子代理（workflow child）的身份输入。在场即走 builder 的第三条路径：
   * 基座段（CLI prefix、安全行、Harness、memory）+ 工作流子代理契约 + persona 叠加，
   * 而不是像 `customSystemPrompt` 那样整段替换。与 `customSystemPrompt` 互斥。
   */
  workflowActor?: WorkflowActorContext;
  language?: string;
  outputStyle?: OutputStylePromptConfig;
  compact?: AutoCompactPolicyConfig;
  guidanceToolNames?: readonly string[];
  /**
   * 触发器专属会话的说明正文（README.md，2026-11-19 验收裁决）：触发器投递轮到达时由
   * runtime 读盘缓存（会话级 sticky），进系统提示词 section——压缩后仍在，投递消息正文
   * 不再内嵌说明（重复冗余）。
   */
  triggerSessionReadme?: string;
  /**
   * 脚本触发器的运行时提示（2026-11-22 python 主 + node 备选改造）：引擎可用性状态文件
   * `state/python-runtime.json` 的投影（context 初始化读盘缓存，会话级 sticky）。
   * "python" = python 可用（提示词只暴露 python 协议与 install_packages，不出现 node
   * 字样）；"node" = 不可用/未探测（注入 node 桥接协议文案）。仅 master 会话注入
   * （worker 会话在 worker 注入段携带对应 bullet）；缺席不注入。
   */
  scriptRuntimeHint?: "python" | "node";
  /**
   * 主智能体的个人规则正文（`.robinrun/agents/master/agents.md`，2026-11-19 /init 裁决；
   * 裁决 10 起 master 单文件回小写，不拆分）：runtime 在 context 初始化时读盘缓存（会话级
   * sticky），进系统提示词 section——个体在前、项目 AGENTS.md 在后，同处 system（压缩后
   * 仍在）。缺席（文件不存在，未跑 /init）时不注入。
   */
  masterInstructions?: { filePath: string; content: string };
  /**
   * worker 注入段（2026-11-20 worker 会话模型同构化，docs/worker-session-model.md §3）：
   * define.md → agents.md → 预定义段 的拼接正文（worker-prompt.ts 组装；第④段项目
   * AGENTS.md 与 master 同源同位，不在此）。仅 worker 会话（config.workerIdentity 在场）
   * 注入，与 masterInstructions 互斥，同一 section 槽位（个体在前、项目说明在后）。
   * runtime 在 context 初始化时随快照解析缓存（会话级 sticky，压缩后仍在）。
   */
  workerInstructions?: { workerId: string; content: string };
}

/**
 * 工作流子代理的身份输入：有效名（匿名缺席）、作者写的 persona system prompt（可缺席）。
 * 没有工具档位：每个子代理都有完整工作工具集，契约只有一份文本。
 */
export interface WorkflowActorContext {
  name?: string;
  persona?: string;
}

export type ContextUserInstructionsRequest = UserInstructionsOptions;
