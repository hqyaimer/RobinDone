// ============================================================
// Subagent exports
// ============================================================

export * from "./explore.js";
export * from "./context-builder.js";
export * from "./system-prompt.js";
export * from "./general-purpose.js";
export * from "./profile.js";
export * from "./explore-tools.js";
export * from "./runner.js";
export * from "./runtime-task-registry.js";

export type { AgentDefinitionsSnapshot, GetAgentDefinitions } from "./definitions.js";
// agent 消息（worker 会话同构化）：进程共享登记表由协议宿主注入各会话 runtime。
// 2026-11-22：持久化钩子与恢复解约类型随共享登记表一并导出（bootstrap 落盘实现消费）。
export { AgentContactRegistry } from "./agent-contact.js";
export type {
  AgentContactEntryView,
  AgentContactPersistedEntry,
  AgentContactPersistencePort,
  AgentContactRecoveredSettlement,
  AgentContactResolvedReply,
} from "./agent-contact.js";
