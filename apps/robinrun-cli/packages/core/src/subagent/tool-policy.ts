import {
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  MANAGE_WORKERS_TOOL_NAME,
} from "@robinrun/contracts";
import { filterDisallowedToolNames } from "../tool/tool-visibility.js";

export const SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS = [
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  // worker 编制只归主智能体管理（2026-11-15 裁决）：worker/subagent 的 `tools: ["*"]`
  // 也拿不到 ManageWorkers，否则被派生的 runtime 可以自行改编制，绕过主智能体。
  // 2026-11-20 worker 会话同构化：worker 会话的禁用由注册面 includeManageWorkers 门
  // 承载（worker 会话是主会话形态，不走本名单）；DispatchWorker 已随同构化退役。
  MANAGE_WORKERS_TOOL_NAME,
] as const;

export function buildSubagentChildDisallowRules(
  disallowedTools: readonly string[] | undefined,
): readonly string[] {
  return [
    ...SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS,
    ...(disallowedTools ?? []),
  ];
}

export function filterSubagentChildToolNames(
  toolNames: readonly string[],
  disallowedTools: readonly string[] | undefined,
): readonly string[] {
  // 子 agent 没有独立的 plan approval 恢复面，暴露 plan tools 会让
  // ExitPlanMode 等待用户确认并卡住父 turn，因此所有子 agent 工具面统一剔除。
  return filterDisallowedToolNames(
    toolNames,
    buildSubagentChildDisallowRules(disallowedTools),
  );
}
