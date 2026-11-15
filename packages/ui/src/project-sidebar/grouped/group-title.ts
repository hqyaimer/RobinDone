import {
  CRON_DEFAULT_GROUP_ID,
  MAIN_AGENT_GROUP_TITLE,
  OFF_PEAK_DEFAULT_GROUP_ID,
  isMainAgentGroupId,
} from "@robinrun/shared";
import { UNGROUPED_AGENT_ID } from "@/project-sidebar/grouped/ids.js";

/**
 * 固定组标题按语言环境本地化展示，忽略 DB 里存的占位标题：
 * cron / 闲时是系统全局组；主智能体是项目标配（前缀 + 规范 title 双条件，
 * 用户重命名后以自定义名为准）；未分组是 UI 伪组。
 */
function getTaskGroupDisplayTitle(
  group: { id: string; title: string },
  localizedSystemTitles: {
    cron: string;
    offPeak: string;
    mainAgent?: string;
    ungrouped?: string;
  },
): string {
  if (group.id === CRON_DEFAULT_GROUP_ID) return localizedSystemTitles.cron;
  if (group.id === OFF_PEAK_DEFAULT_GROUP_ID) return localizedSystemTitles.offPeak;
  if (group.id === UNGROUPED_AGENT_ID) return localizedSystemTitles.ungrouped ?? group.title;
  if (isMainAgentGroupId(group.id) && group.title === MAIN_AGENT_GROUP_TITLE)
    return localizedSystemTitles.mainAgent ?? group.title;
  return group.title;
}

export { getTaskGroupDisplayTitle };
