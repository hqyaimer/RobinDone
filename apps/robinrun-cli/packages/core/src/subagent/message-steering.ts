import type { TraceContext, TurnSteerInput, TurnSteerResult } from "@robinrun/contracts";
import type { SystemStatusPayload } from "@robinrun/shared";
import type { RuntimeTaskMessageSink } from "../runtime-task/registry.js";

interface SteerableRuntime {
  steerTurn(input: string | TurnSteerInput): Promise<TurnSteerResult>;
}

/**
 * P2.6 词表（docs/message-origin.md）：master = 主智能体（每项目唯一，fromSessionId 即回话地址）；
 * 用户消息不带 fromSessionId（用户不是会话，回话=当前会话直接输出）。
 */
function systemStatusForInitiator(
  initiator: "coordinator" | "user",
  masterSessionId: string | undefined,
): SystemStatusPayload {
  return initiator === "user"
    ? { sender: "user" }
    : masterSessionId
      ? { sender: "master", fromSessionId: masterSessionId }
      : { sender: "master" };
}

export function createSubagentMessageSink(
  runtime: SteerableRuntime,
  request: {
    traceContext: TraceContextLike;
    sessionId?: string;
    initiator?: "coordinator" | "user";
  },
): RuntimeTaskMessageSink {
  return {
    async send(message) {
      const result = await steerSubagentMessage(runtime, request, message);
      if (result.kind === "rejected") {
        throw new Error(`Subagent message rejected: ${result.reason}`);
      }
      return "steered";
    },
  };
}

type TraceContextLike = TraceContext;

async function steerSubagentMessage(
  runtime: SteerableRuntime,
  request: {
    traceContext: TraceContextLike;
    sessionId?: string;
    initiator?: "coordinator" | "user";
  },
  message: {
    id: string;
    message: string;
    traceContext?: TraceContextLike;
    /** P2.6：按消息覆盖发起者（用户在 worker 跑主智能体轮次时插话，不得误标 coordinator）。 */
    initiator?: "coordinator" | "user";
  },
): Promise<TurnSteerResult> {
  // 只交付 message，summary 只用于 UI 预览。
  // 修复原因：summary 拼在 message 前面时，子 agent 会多收到一行只为预览写的摘要。
  // P2.5：用户在 worker 会话里直接输入的插话按真实用户（user_steer → real_user）记账。
  // P2.6 修复：发起者改为按消息判定——sink 注册时的 request.initiator 只作缺省；
  // 否则用户在 worker 正跑主智能体轮次时插话会被误标成 coordinator（模型被告知是主智能体说的）。
  const initiator = message.initiator ?? request.initiator ?? "coordinator";
  const inputPresentation = initiator === "user" ? "user_steer" : "coordinator_steer";
  const input = message.message;
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await runtime.steerTurn({
      delivery: "guide",
      inputPresentation,
      input,
      // P2.6 消息来源区块：每条插话显式标注发送者（master 带 fromSessionId 回话地址）。
      systemStatus: systemStatusForInitiator(initiator, request.sessionId),
      inputId: message.id,
      traceContext: message.traceContext ?? request.traceContext,
    });
    if (result.kind !== "rejected" || result.reason !== "no_active_turn") {
      return result;
    }
    await sleep(10);
  }
  return runtime.steerTurn({
    delivery: "guide",
    inputPresentation,
    input,
    systemStatus: systemStatusForInitiator(initiator, request.sessionId),
    inputId: message.id,
    traceContext: message.traceContext ?? request.traceContext,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
