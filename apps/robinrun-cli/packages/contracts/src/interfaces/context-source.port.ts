// ============================================================
// Context Source Port - host/workspace context boundary
// ============================================================

import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

export interface EnvInfo {
  cwd: string;
  platform: string;
  shell: string;
  osVersion: string;
  nodeVersion: string;
  // 执行模型不是环境事实；只能由当前 model step 的 Model 在 Prompt 渲染时提供。
  isGitRepository?: boolean;
  gitBranch?: string;
  gitMainBranch?: string;
  gitUser?: string;
  gitStatus?: "clean" | "dirty" | "not_repo";
  gitStatusLines?: string[];
  recentCommits?: string[];
}

/**
 * 会话上下文用的 Git 事实；不含 cwd、shell 等宿主环境。
 * isGitRepository 由目录的真实路径（解析链接，与 git 一致）向上查找 `.git` 得到，总是确定的结论，不启动 git 进程。
 */
export type GitContext = Pick<
  EnvInfo,
  | "isGitRepository"
  | "gitBranch"
  | "gitMainBranch"
  | "gitUser"
  | "gitStatus"
  | "gitStatusLines"
  | "recentCommits"
>;

export interface UserInstructionsOptions {
  workingDirectory: string;
  projectRoot?: string;
  priorityFiles?: string[];
  maxBytes?: number;
}

export type UserInstructionSourceScope = "user" | "workspace";

export interface ResolvedUserInstructionSource {
  scope: UserInstructionSourceScope;
  filePath: string;
  fileName: string;
  content: string;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
}

export interface ResolvedUserInstructions {
  filePath: string;
  fileName: string;
  content: string;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
  sources?: ResolvedUserInstructionSource[];
}

export type ProjectType = "node" | "python" | "rust" | "go" | "java" | "unknown";
export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

export interface ProjectContext {
  type: ProjectType;
  packageManager?: PackageManager;
  scripts?: Record<string, string>;
  buildFiles?: string[];
}

export interface ContextSourceRequest {
  workingDirectory: string;
  currentDate?: string;
  effectiveShellDisplayName?: string;
  envInfo?: EnvInfo;
  userInstructions?: UserInstructionsOptions;
  projectContext?: ProjectContext;
  trace?: TraceContext;
}

export interface ContextSourceDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface ContextSourceSnapshot {
  workingDirectory: string;
  /**
   * 项目根：从打开路径向上最近的含 .git 目录；不在仓库时缺省。
   * 2026-11-19 /init 裁决（docs/init-flow.md）：master 个人规则（.robinrun/agents/master/）
   * 等项目级文件的解析锚点——workingDirectory 保留用户打开的写法（可能是嵌套子目录），
   * 不能当项目根用。
   */
  projectRoot?: string;
  envInfo: EnvInfo;
  currentDate?: string;
  userInstructions?: ResolvedUserInstructions;
  projectContext?: ProjectContext;
  diagnostics: ContextSourceDiagnostic[];
}

export interface ContextSourceResolveOptions {
  signal?: AbortSignal;
  context?: ExecutionContext;
}

export interface ContextSourcePort {
  // 只读当前宿主环境，不重新加载指令、Skills 或会话起始 Git 详情。
  resolveEnvironment(
    request: Pick<ContextSourceRequest, "workingDirectory" | "effectiveShellDisplayName" | "trace">,
    options?: ContextSourceResolveOptions,
  ): Promise<EnvInfo>;
  // 只读当前目录的 Git 会话上下文。每个上下文窗口只决定一次：请求前历史中既没有 session_context
  // 也没有 date 时，或 compaction 的保留段没有 session_context 时调用。
  resolveGitContext(
    request: Pick<ContextSourceRequest, "workingDirectory" | "trace">,
    options?: ContextSourceResolveOptions,
  ): Promise<GitContext>;
  resolveContextSources(
    request: ContextSourceRequest,
    options?: ContextSourceResolveOptions,
  ): Promise<ContextSourceSnapshot>;
}
