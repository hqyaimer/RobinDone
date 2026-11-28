import type { ProjectTask as RobinDoneTaskMeta } from "@/project-sidebar/contract.js";
import { memo } from "react";
import type { UniqueIdentifier } from "@dnd-kit/core";

import { cn } from "@/components/lib/utils.js";
import { GroupedTaskRow } from "@/project-sidebar/grouped/task-row.js";
import type { TaskGroupMenuItem } from "@/project-sidebar/grouped/shared.js";

function GroupedTaskItemComponent({
  task,
  groupId,
  groups,
  remoteSessionId,
  isActive,
  isMobileActive,
  workspaceLabel,
  onSelectTask,
  onCloseTask,
  onMoveTaskToGroup,
  onMoveTaskToTop,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  dragId,
  dragging,
  dragOverlay,
  tooltipsDisabled,
}: {
  task: RobinDoneTaskMeta;
  groupId?: string;
  groups: TaskGroupMenuItem[];
  remoteSessionId?: string;
  isActive: boolean;
  isMobileActive: boolean;
  workspaceLabel: string;
  onSelectTask: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
  onCloseTask: (task: RobinDoneTaskMeta) => void;
  onMoveTaskToGroup: (task: RobinDoneTaskMeta, groupId: string | null) => void;
  onMoveTaskToTop: (task: RobinDoneTaskMeta) => void;
  onStartRenameTask: (task: RobinDoneTaskMeta) => void;
  onArchiveTask: (task: RobinDoneTaskMeta) => void;
  onMarkTaskAsUnread: (task: RobinDoneTaskMeta) => void;
  dragId?: UniqueIdentifier;
  dragging?: boolean;
  dragOverlay?: boolean;
  tooltipsDisabled?: boolean;
}) {
  return (
    <div className={cn("rounded-lg border border-transparent py-px")}>
      <GroupedTaskRow
        task={task}
        currentGroupId={groupId}
        groups={groups}
        remoteSessionId={remoteSessionId}
        isActive={isActive}
        isMobileActive={isMobileActive}
        workspaceLabel={workspaceLabel}
        onSelectTask={onSelectTask}
        onCloseTask={onCloseTask}
        onMoveTaskToGroup={onMoveTaskToGroup}
        onMoveTaskToTop={onMoveTaskToTop}
        onStartRenameTask={onStartRenameTask}
        onArchiveTask={onArchiveTask}
        onMarkTaskAsUnread={onMarkTaskAsUnread}
        dragId={dragId}
        dragging={dragging}
        dragOverlay={dragOverlay}
        tooltipsDisabled={tooltipsDisabled}
      />
    </div>
  );
}

export const GroupedTaskItem = memo(GroupedTaskItemComponent);
