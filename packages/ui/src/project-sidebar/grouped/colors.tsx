import type { RobinRunTaskGroupColor } from "@/project-sidebar/grouped/types.js";

import { Hash, type LucideIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { TASK_GROUP_COLOR_CLASS } from "@/project-sidebar/grouped/types.js";

/**
 * 组色标：彩色圆 + 组图标。默认 "#"（用户组）；主智能体与 worker 组传 icon=Bot
 * （2026-11-16 裁决：编制内智能体统一机器人图标，颜色圈兼做改色入口保持不变）。
 */
function TaskGroupColorMark({
  color,
  icon: Icon = Hash,
}: {
  color: RobinRunTaskGroupColor;
  icon?: LucideIcon;
}) {
  return (
    <span
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full",
        TASK_GROUP_COLOR_CLASS[color],
      )}
    >
      <Icon className="size-3" />
    </span>
  );
}

function TaskGroupColorDot({ color }: { color: RobinRunTaskGroupColor }) {
  return <span className={cn("size-2.5 shrink-0 rounded-full", TASK_GROUP_COLOR_CLASS[color])} />;
}

export { TaskGroupColorDot, TaskGroupColorMark };
