import { z } from "zod";
import { modelSelectionSchema, type ModelSelection } from "./model-selection.js";
import type { AgentPermissionMode } from "./subagents-types.js";

export type AgentProfileSource = "built-in" | "project" | "user";
export type AgentMemoryScope = "user" | "project" | "local";

export interface AgentProfile {
  background?: boolean;
  color?: "red" | "blue" | "green" | "yellow" | "purple" | "orange" | "pink" | "cyan";
  description: string;
  disallowedTools?: readonly string[];
  injectAgentsMd?: boolean;
  maxTurns?: number;
  mcpServers?: readonly string[];
  memory?: AgentMemoryScope;
  modelSelection?: ModelSelection;
  name: string;
  path?: string;
  permissionMode?: AgentPermissionMode;
  /**
   * permissionMode 只能收紧父会话模式。插件 loader 在 CLI 进程内设置；
   * 不进入下方跨进程 schema，若被跨边界发送，strict schema 会直接拒绝。
   */
  permissionModeRestrictOnly?: boolean;
  skills?: readonly string[];
  source: AgentProfileSource;
  systemPrompt: string;
  tools?: readonly string[];
  /**
   * worker 身份标记（2026-11-16 会话通道隔离裁决）：由名册 profile（buildWorkerProfile）
   * 设置，派发链据此走 worker 专属通道——taskType=worker_child、异步派发、会话投影带
   * worker 字段。与一次性 subagent 通道完全隔离，未来 worker 针对性开发只扩展此标记。
   */
  worker?: WorkerProfileIdentity;
}

/**
 * worker 派发会话的身份事实：id 是路径锚点，name 是用户可读显示名（改名不影响 id）；
 * defineMd 是职责定义正文（`<id>/define.md`，裁决 10，2026-11-20）——由 master 独占维护，
 * worker 仅受提示词约束不得修改；随 profile 透传给 core 的 worker-prompt.ts 拼接。
 */
export interface WorkerProfileIdentity {
  workerId: string;
  workerName: string;
  defineMd?: string;
}

export interface AgentProfileParseDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface AgentProfileLoadResult {
  diagnostics: AgentProfileParseDiagnostic[];
  profiles: AgentProfile[];
}

/** 跨进程 worker 身份 schema：id 是路径锚点，name 是用户可读显示名，defineMd 是职责定义正文。 */
export const workerProfileIdentitySchema = z
  .object({
    workerId: z.string().min(1),
    workerName: z.string().min(1),
    defineMd: z.string().optional(),
  })
  .strict();

/** 完整运行时 profile 的跨进程边界，不使用 Settings 摘要代替。 */
export const agentProfileSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    source: z.enum(["built-in", "project", "user"]),
    systemPrompt: z.string(),
    path: z.string().optional(),
    modelSelection: modelSelectionSchema.optional(),
    background: z.boolean().optional(),
    injectAgentsMd: z.boolean().optional(),
    color: z
      .enum(["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"])
      .optional(),
    permissionMode: z
      .enum(["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"])
      .optional(),
    memory: z.enum(["user", "project", "local"]).optional(),
    maxTurns: z.number().int().positive().optional(),
    tools: z.array(z.string()).readonly().optional(),
    disallowedTools: z.array(z.string()).readonly().optional(),
    skills: z.array(z.string()).readonly().optional(),
    mcpServers: z.array(z.string()).readonly().optional(),
    // worker 身份标记与接口同步（strict schema 是 Host→CLI 跨进程边界，漏镜像会拒绝快照）。
    worker: workerProfileIdentitySchema.optional(),
  })
  .strict();
