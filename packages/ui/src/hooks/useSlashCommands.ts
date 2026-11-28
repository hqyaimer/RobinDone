/**
 * RobinDone Agent Slash Commands 便捷 hook
 *
 * 返回当前 workspace 下 Agent 广播的可用 slash commands 列表。
 */
import {
  useRobinDoneSessionStore,
  selectWorkspaceRobinDoneState,
} from "../store/robindoneSessionStore.js";

export function useSlashCommands(workspacePath: string, workspaceIdentity?: string) {
  return useRobinDoneSessionStore(
    (state) => selectWorkspaceRobinDoneState(state, workspacePath, workspaceIdentity).slashCommands,
  );
}
