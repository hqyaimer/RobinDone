export const ROBINDONE_KNOWN_TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "ApplyPatch",
  "Bash",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "web_search",
  "TodoRead",
  "TodoWrite",
  "GoalRead",
  "ReadSessionContext",
  "AskUserQuestion",
  "SendMessage",
  "RespondToCoordinator",
  "TaskOutput",
  "TaskStop",
  "js",
  "js_reset",
  "js_add_node_module_dir",
  "mcp__node_repl__js",
  "mcp__node_repl__js_reset",
  "mcp__node_repl__js_add_node_module_dir",
  "Agent",
  "Task",
  // P2.6 工具分离（裁决 13）：worker 派发专名工具，与 Agent（一次性 subagent）同属
  // agent family —— 行渲染共用 AgentToolCallBlock，按输入字段（worker）读取派发身份。
  "DispatchWorker",
  "Skill",
  "CreateWorkflow",
  // 修订入口：登记进 workflow family 让确认窗
  // 按 family 选中运行确认块；工具行侧则按名先分流（resolveRenderer.ts），family 兜底不会吞掉它。
  "AmendWorkflow",
  // 留白补全（docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」）：同 AmendWorkflow 登记进
  // workflow family——确认窗按 family 选运行确认块；工具行侧按名先分流到 CreateWorkflow 渲染器换留白词汇。
  "FillWorkflowHole",
  // wire 名就是 snake_case 的 submit_result（仓库里唯一一个），下划线必须字面在场：
  // 未登记时 UI identity 退回 unknown，动态工作流 actor 的提交会落到 raw fallback renderer。
  "submit_result",
] as const;

export type RobinDoneKnownToolName = (typeof ROBINDONE_KNOWN_TOOL_NAMES)[number];

export type RobinDoneToolFamily =
  | "file-read"
  | "file-write"
  | "shell"
  | "search"
  | "web-fetch"
  | "todo"
  | "ask-user-question"
  | "agent"
  | "skill"
  | "goal"
  | "session-context"
  | "message"
  | "task-control"
  | "node-repl"
  | "workflow";

const TOOL_FAMILY_BY_NAME: Record<RobinDoneKnownToolName, RobinDoneToolFamily> = {
  Read: "file-read",
  Write: "file-write",
  Edit: "file-write",
  ApplyPatch: "file-write",
  Bash: "shell",
  Glob: "search",
  Grep: "search",
  WebFetch: "web-fetch",
  WebSearch: "search",
  web_search: "search",
  TodoRead: "todo",
  TodoWrite: "todo",
  GoalRead: "goal",
  ReadSessionContext: "session-context",
  AskUserQuestion: "ask-user-question",
  SendMessage: "message",
  RespondToCoordinator: "message",
  TaskOutput: "task-control",
  // TaskStop 未登记时 UI identity 会退回 unknown，最终落到 raw fallback renderer。
  TaskStop: "task-control",
  js: "node-repl",
  js_reset: "node-repl",
  js_add_node_module_dir: "node-repl",
  // node_repl 由 MCP 暴露，进入 UI 的工具名因此带 MCP 前缀。
  // 若这里只登记旧 built-in 名称，专用 REPL renderer 会退回 unknown fallback。
  mcp__node_repl__js: "node-repl",
  mcp__node_repl__js_reset: "node-repl",
  mcp__node_repl__js_add_node_module_dir: "node-repl",
  Agent: "agent",
  Task: "agent",
  DispatchWorker: "agent",
  Skill: "skill",
  CreateWorkflow: "workflow",
  AmendWorkflow: "workflow",
  FillWorkflowHole: "workflow",
  submit_result: "workflow",
};

const TOOL_NAME_BY_LOWER = new Map<string, RobinDoneKnownToolName>(
  ROBINDONE_KNOWN_TOOL_NAMES.map((toolName) => [toolName.toLowerCase(), toolName]),
);

export function normalizeRobinDoneToolName(
  value: string | null | undefined,
): RobinDoneKnownToolName | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  return TOOL_NAME_BY_LOWER.get(normalized.toLowerCase()) ?? null;
}

export function getRobinDoneToolFamilyForName(
  value: string | null | undefined,
): RobinDoneToolFamily | null {
  const toolName = normalizeRobinDoneToolName(value);
  return toolName ? TOOL_FAMILY_BY_NAME[toolName] : null;
}

export function isRobinDoneToolFamily(
  value: string | null | undefined,
  family: RobinDoneToolFamily,
): boolean {
  return getRobinDoneToolFamilyForName(value) === family;
}

export function isRobinDoneFileContentWriteToolName(value: string | null | undefined): boolean {
  return normalizeRobinDoneToolName(value) === "Write";
}
