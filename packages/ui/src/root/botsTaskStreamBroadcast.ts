import {
  BOT_TASK_STREAM_BROADCAST_CHANNEL,
  type RobinDoneStreamEvent,
  type BotTaskStreamBroadcastPayload,
} from "@robindone/shared";
import type { BroadcastMessage } from "@robindone/services";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import type { WindowTabState } from "@/store/tabStore.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

function isRobinDoneStreamEvent(value: unknown): value is RobinDoneStreamEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const event = value as Partial<RobinDoneStreamEvent>;
  return typeof event.type === "string" && typeof event.taskId === "string";
}

function isBotTaskStreamBroadcastPayload(
  payload: unknown,
): payload is BotTaskStreamBroadcastPayload {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const value = payload as Partial<BotTaskStreamBroadcastPayload>;
  return (
    typeof value.workspacePath === "string" &&
    typeof value.taskId === "string" &&
    typeof value.updatedAt === "number" &&
    (value.workspaceIdentity === undefined || typeof value.workspaceIdentity === "string") &&
    isRobinDoneStreamEvent(value.event) &&
    value.event.taskId === value.taskId
  );
}

export function resolveBotTaskStreamBroadcast(
  message: BroadcastMessage,
  tabs: WindowTabState[],
): BotTaskStreamBroadcastPayload | null {
  if (message.channel !== BOT_TASK_STREAM_BROADCAST_CHANNEL) {
    return null;
  }
  if (!isBotTaskStreamBroadcastPayload(message.payload)) {
    return null;
  }
  const targetWorkspaceKey = buildTaskWorkspaceKey(
    message.payload.workspacePath,
    message.payload.workspaceIdentity,
  );
  const hasOpenWorkspace = tabs.some(
    (tab) =>
      isWorkspaceTab(tab) &&
      buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity) === targetWorkspaceKey,
  );
  return hasOpenWorkspace ? message.payload : null;
}
