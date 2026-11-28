export const AGENT_TOOL_NAME = "Agent";
export const TASK_TOOL_NAME = "Task";
// DispatchWorker 已退役（2026-11-20 worker 会话同构化，docs/worker-session-model.md §2）：
// master↔worker 的任务传递收敛进 ContactAgent，派发工具只服务一次性 subagent（Agent）。
// 本文件不再承载该名字；历史 transcript 的渲染兼容由 UI/投影侧的字面量名单保留。

const subagentDispatchToolNames = new Set<string>([
  AGENT_TOOL_NAME,
  TASK_TOOL_NAME,
]);

const hookMatcherAliasesByToolName = new Map<string, readonly string[]>([
  [AGENT_TOOL_NAME, [TASK_TOOL_NAME]],
  [TASK_TOOL_NAME, [AGENT_TOOL_NAME]],
  ["ApplyPatch", ["Write", "Edit"]],
]);

export function isSubagentDispatchToolName(toolName: string | undefined): boolean {
  return toolName ? subagentDispatchToolNames.has(toolName) : false;
}

export function hookMatcherToolNamesForTool(toolName: string): readonly string[] {
  const aliases = hookMatcherAliasesByToolName.get(toolName) ?? [];
  if (aliases.length === 0) return [toolName];

  const values = new Set<string>([toolName]);
  for (const alias of aliases) values.add(alias);
  return [...values];
}
