import type { RobinDoneSessionStateSnapshot } from "@robindone/shared";
import type {
  RobinDoneSessionWorkspaceTarget,
  RobinDoneTaskTarget,
} from "#src/robindone-session/robindoneSession.js";

function getWorkspaceKey(target: RobinDoneSessionWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

function getSessionScopedKey(target: RobinDoneTaskTarget): string {
  return `${getWorkspaceKey(target)}\0${target.sessionId}`;
}

export function createRobinDoneDeferredDraftRegistry() {
  const sessionKeys = new Set<string>();

  return {
    remember(
      params: RobinDoneSessionWorkspaceTarget,
      snapshot: RobinDoneSessionStateSnapshot,
    ): void {
      sessionKeys.add(
        getSessionScopedKey({
          workspacePath: snapshot.session.workspace.workspacePath,
          workspaceIdentity:
            snapshot.session.workspace.workspaceIdentity ?? params.workspaceIdentity,
          sessionId: snapshot.session.sessionId,
        }),
      );
    },

    has(target: RobinDoneTaskTarget): boolean {
      return sessionKeys.has(getSessionScopedKey(target));
    },

    forget(target: RobinDoneTaskTarget): void {
      sessionKeys.delete(getSessionScopedKey(target));
    },
  };
}
