import { createMessageId, traceContextToLogContext } from "../deps.js";
import type { MessageId } from "../deps.js";
import { createRuntimeCommandId, type SubagentMessageRuntimeCommand } from "../command-queue.js";
import type { SystemStatusPayload } from "@robinrun/shared";
import { systemStatusNameValue } from "@robinrun/shared";
import type { AgentRuntimeInternal } from "../internal.js";
import type { EnqueueSubagentMessageInput } from "../types.js";
import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import { legacySyntheticRuntimeMetadata } from "../../agent/message-history.js";
import { escapeXml } from "../../runtime-task/notification.js";

export function formatSubagentMessage(input: {
  agentId: string;
  agentType: string;
  summary: string;
  message: string;
}): string {
  return [
    "<subagent-message>",
    `<agent-id>${escapeXml(input.agentId)}</agent-id>`,
    `<agent-type>${escapeXml(input.agentType)}</agent-type>`,
    `<summary>${escapeXml(input.summary)}</summary>`,
    `<message>${escapeXml(input.message)}</message>`,
    "</subagent-message>",
  ].join("\n");
}

export function enqueueSubagentMessage(
  this: AgentRuntimeInternal,
  input: EnqueueSubagentMessageInput,
): undefined {
  const branchGeneration =
    this.runtimeTaskRegistry.get(input.agentId)?.branchGeneration ?? this.branchGeneration;
  if (branchGeneration !== this.branchGeneration) {
    this.logger?.debug("Dropped stale-branch subagent response", {
      ...traceContextToLogContext(input.traceContext),
      agentId: input.agentId,
      branchGeneration,
      currentBranchGeneration: this.branchGeneration,
      event: "subagent.response.stale_branch_dropped",
      module: "core.runtime",
      responseId: input.responseId,
    });
    return undefined;
  }
  const command = {
    branchGeneration,
    responseId: input.responseId,
    agentId: input.agentId,
    agentType: input.agentType,
    childSessionId: input.childSessionId,
    childToolCallId: input.childToolCallId,
    ...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}),
    summary: input.summary,
    messageLength: input.message.length,
    traceContext: input.traceContext,
    createdAt: new Date(),
    id: createRuntimeCommandId(),
    mode: "subagent-message" as const,
    priority: "next" as const,
    source: "subagent_message" as const,
    text: formatSubagentMessage(input),
  } satisfies SubagentMessageRuntimeCommand;

  this.logger?.debug("Subagent response enqueued into runtime command queue", {
    ...traceContextToLogContext(command.traceContext),
    agentId: command.agentId,
    commandId: command.id,
    event: "subagent.response.runtime_enqueued",
    messageLength: command.messageLength,
    module: "core.runtime",
    queueSize: this.runtimeCommandQueue.size() + 1,
    responseId: command.responseId,
    summary: command.summary.slice(0, 200),
  });
  this.enqueueRuntimeCommand(command);
  return undefined;
}

export async function persistSubagentMessageCommand(
  this: AgentRuntimeInternal,
  command: SubagentMessageRuntimeCommand,
  midTurn = false,
): Promise<MessageId> {
  await this.ensureContextInitialized(command.traceContext);
  const messageID = createMessageId();
  const inputPresentation = midTurn ? "subagent_reply_steer" : "subagent_reply";
  // P2.6 消息来源区块（docs/message-origin.md）：子会话回复显式标注发送方身份——
  // 名册 worker（agentType 为 wkr-id）按 worker 标注并带显示名，一次性 subagent 按类型名；
  // fromSessionId = 子会话 id（master 的可回话地址）。
  const workerIdentity = this.runtimeTaskRegistry.get(command.agentId)?.workerChild
    ? this.runtimeTaskRegistry.get(command.agentId)?.workerName
    : undefined;
  const senderName = systemStatusNameValue(workerIdentity);
  const systemStatus: SystemStatusPayload = this.runtimeTaskRegistry.get(command.agentId)
    ?.workerChild
    ? {
        sender: "worker",
        senderId: command.agentType,
        ...(senderName ? { senderName } : {}),
        fromSessionId: command.childSessionId,
      }
    : {
        sender: "subagent",
        senderId: command.agentType,
        fromSessionId: command.childSessionId,
      };
  this.messageHistory.addUser(
    command.text,
    systemStatus
      ? {
          ...(runtimeInputMetadata(inputPresentation) ?? legacySyntheticRuntimeMetadata()),
          systemStatus,
        }
      : runtimeInputMetadata(inputPresentation),
  );
  await this.persistSyntheticUserNoticeForSession({
    messageID,
    sessionId: this.sessionId,
    source: "subagent_message",
    text: command.text,
    traceContext: command.traceContext,
    visibility: "model-only",
    metadata: {
      inputPresentation,
      systemStatus,
      subagentMessage: {
        responseId: command.responseId,
        agentId: command.agentId,
        agentType: command.agentType,
        childSessionId: command.childSessionId,
        childToolCallId: command.childToolCallId,
        ...(command.parentToolCallId ? { parentToolCallId: command.parentToolCallId } : {}),
      },
    },
  });
  return messageID;
}
