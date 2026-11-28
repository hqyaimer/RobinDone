import type { RobinDoneStreamingToolInputState } from "./streaming-tool-input-preview.js";

export interface RobinDoneToolProjectionMemory {
  completeToolInputById?: Map<string, unknown>;
  streamingToolInputById?: Map<string, RobinDoneStreamingToolInputState>;
  toolNameById?: Map<string, string>;
}

export interface RobinDoneToolProjectionMetadata {
  hasInput: boolean;
  input?: unknown;
  toolName?: string;
}

export function createRobinDoneToolProjectionMemory(): RobinDoneToolProjectionMemory {
  return {
    completeToolInputById: new Map<string, unknown>(),
    streamingToolInputById: new Map<string, RobinDoneStreamingToolInputState>(),
    toolNameById: new Map<string, string>(),
  };
}

export function ensureRobinDoneToolProjectionMemory(
  memory: RobinDoneToolProjectionMemory,
): RobinDoneToolProjectionMemory {
  memory.completeToolInputById ??= new Map<string, unknown>();
  memory.streamingToolInputById ??= new Map<string, RobinDoneStreamingToolInputState>();
  memory.toolNameById ??= new Map<string, string>();
  return memory;
}

export function resolveRobinDoneToolProjectionMetadata(
  payload: Record<string, unknown>,
  toolId: string,
  memory: RobinDoneToolProjectionMemory,
): RobinDoneToolProjectionMetadata {
  const toolName = readNonEmptyString(payload.toolName) ?? memory.toolNameById?.get(toolId);
  if (toolName) {
    memory.toolNameById?.set(toolId, toolName);
  }

  if ("input" in payload) {
    return {
      hasInput: payload.input !== undefined,
      input: payload.input,
      toolName,
    };
  }

  if (memory.completeToolInputById?.has(toolId)) {
    return {
      hasInput: true,
      input: memory.completeToolInputById.get(toolId),
      toolName,
    };
  }

  return {
    hasInput: false,
    toolName,
  };
}

export function finalizeRobinDoneToolProjectionInput(
  toolId: string,
  input: unknown,
  memory: RobinDoneToolProjectionMemory,
): void {
  memory.completeToolInputById ??= new Map<string, unknown>();
  memory.completeToolInputById.set(toolId, input);
  const streamingState = memory.streamingToolInputById?.get(toolId);
  if (streamingState) {
    streamingState.lastPreviewRawInputLength = streamingState.rawInput.length;
    streamingState.rawInput = "";
  }
}

export function forgetRobinDoneToolProjectionMetadata(
  toolId: string,
  memory: RobinDoneToolProjectionMemory,
): void {
  memory.completeToolInputById?.delete(toolId);
  memory.streamingToolInputById?.delete(toolId);
  memory.toolNameById?.delete(toolId);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
