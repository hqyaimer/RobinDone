import type { RobinDoneSessionStateSnapshot } from "@robindone/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { repairImportedClaudeSessionSnapshot } from "#src/session/claude-native/importedClaudeHistoryRepair.js";
import type { IRobinDoneAgentService } from "#src/robindone-agent/robindoneAgent.js";
import type {
  RobinDoneSessionReadParams,
  RobinDoneSessionResumeParams,
} from "#src/robindone-session/robindoneSession.js";

const logger = createServiceLogger("robindone-session-service");

export async function repairEmptyImportedClaudeSessionSnapshot(params: {
  agentService: IRobinDoneAgentService;
  snapshot: RobinDoneSessionStateSnapshot;
  target: RobinDoneSessionResumeParams | RobinDoneSessionReadParams;
}): Promise<RobinDoneSessionStateSnapshot> {
  const repaired = await repairImportedClaudeSessionSnapshot({
    snapshot: params.snapshot,
    target: {
      workspacePath: params.target.workspacePath,
      workspaceIdentity: params.target.workspaceIdentity,
      taskId: params.target.sessionId,
      ...("mcpServers" in params.target && params.target.mcpServers
        ? { mcpServers: params.target.mcpServers }
        : {}),
    },
    createSession: (input) => params.agentService.createSession(input),
    onRepair: (history) => {
      logger.warn(
        undefined,
        `[robindone-session-service] Claude 导入 session 历史异常，按 ${history.source} 回填 taskId=${params.target.sessionId}`,
      );
    },
  });
  return repaired ?? params.snapshot;
}
