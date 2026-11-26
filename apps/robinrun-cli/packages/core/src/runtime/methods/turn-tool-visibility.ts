import { TRIGGER_ID_PREFIX } from "@robinrun/shared";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  AUTOMATION_MUTATION_TOOL_NAMES,
  AUTOMATION_SELF_PAUSE_TOOL_NAME,
  OFF_PEAK_MUTATION_TOOL_NAMES,
  isAutomationMutationRestrictedTurn,
  isOffPeakCreateRestrictedTurn,
  type RegularTurnLoopState,
} from "./turn-loop-state.js";

/**
 * 分发器投递轮的工具面白名单（2026-11-25 分发器裁决，specs/trigger-dispatcher-routing.md
 * 裁决 9）：分发器无业务职能，触发器投递轮只保留路由标记与只读工具——收窄既是防误用
 * 也是安全边界。其余轮次（用户插话等）不收窄（用户在场时的自由度优先）。
 */
const DISPATCHER_TURN_ALLOWED_TOOLS: ReadonlySet<string> = new Set(["RouteEvents", "Read"]);

export function getTurnTools(runtime: AgentRuntimeInternal, state: RegularTurnLoopState) {
  const disallowed = buildTurnDisallowedTools(state);
  if (state.automationCreateLimitReached) return [];
  let tools = runtime.getTools(state.model);
  if (disallowed) tools = tools.filter((tool) => !disallowed.has(tool.name));
  // dispatcher 投递轮收窄（sticky 判据 triggerSessionRouting 在 ensureTriggerSessionReadme
  // 读注册表缓存）：白名单外交织的任何业务工具在本轮不可见。
  if (
    runtime.triggerSessionRouting === "dispatcher" &&
    state.automationId?.startsWith(TRIGGER_ID_PREFIX)
  ) {
    tools = tools.filter((tool) => DISPATCHER_TURN_ALLOWED_TOOLS.has(tool.name));
  }
  return tools;
}

function buildTurnDisallowedTools(state: RegularTurnLoopState): Set<string> | null {
  const tools = new Set(state.toolDisallowlist ?? []);
  if (isAutomationMutationRestrictedTurn(state)) {
    // 修复原因：定时任务执行轮只应运行任务 prompt，不能反过来管理自己的定义。
    // 保留 CronList 供只读查询；所有 mutation 在 provider 请求边界统一隐藏。
    for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  if (!state.automationId?.trim()) {
    // CronPauseSelf 的唯一目标是 Host 准入注入的本轮 automationId；普通用户轮、
    // 只有 denylist / queryId 兜底信号的轮都没有可暂停的任务，必须在 provider 边界隐藏。
    // 不并入 AUTOMATION_MUTATION_TOOL_NAMES：那组是“执行轮隐藏”，这里是“非执行轮隐藏”。
    tools.add(AUTOMATION_SELF_PAUSE_TOOL_NAME);
  }
  if (isOffPeakCreateRestrictedTurn(state)) {
    // D49：闲时执行轮禁止再创建闲时任务（免费池自我放大）；OffPeakList 只读保留。
    // 注意 automation 执行轮不进此分支——cron turn 按 D49-3 放行 OffPeakCreate。
    for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  return tools.size > 0 ? tools : null;
}
