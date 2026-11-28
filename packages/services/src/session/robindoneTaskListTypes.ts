import type { WorkspacePurpose, RobinDoneTaskMeta } from "@robindone/shared";

export type RobinDoneTaskListKind = "pinned" | "archived" | "timeline" | "active";
export type RobinDoneTaskListSortBy = "created" | "updated";

export interface RobinDoneTaskListWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface RobinDoneTaskListQuery {
  kind: RobinDoneTaskListKind | "all";
  /** host 由存储 owner 确定全部范围，不接受 UI 已打开工作区作为历史目录。 */
  workspaceScopes: RobinDoneTaskListWorkspaceScope[] | "host";
  sortBy: RobinDoneTaskListSortBy;
  search?: string;
  limit?: number;
}

export type RobinDoneTaskListItem = RobinDoneTaskMeta & {
  searchSnippet?: string;
  searchSnippets?: string[];
};

export interface RobinDoneTaskListResult {
  items: RobinDoneTaskListItem[];
  total: number;
  hasMore: boolean;
}

export interface RobinDoneWorkspaceEventSubscriptionParams {
  workspacePath: string;
  workspaceIdentity?: string;
}
