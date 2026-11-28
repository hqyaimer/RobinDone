// Bootstrap public API surface.

export * from "./app/create-app.js";
export type {
  ListRobinDoneSessionsOptions,
  PromptInput,
  ResolveLatestSessionOptions,
  ResumeOptions,
  RunRobinDoneProtocolAgentOptions,
  SendInputOptions,
  SendInputResult,
  SetLocaleResult,
  SteerTurnOptions,
  SubmitPromptOptions,
  UserPromptInput,
  RobinDoneApp,
  RobinDoneAppOptions,
  RobinDoneModelOption,
} from "./app/types.js";
export * from "./auth-login.js";
export {
  inspectRobinDoneCustomCommand,
  listRobinDoneCustomCommands,
  loadRobinDoneCustomCommand,
} from "./custom-commands.js";
export type {
  InspectRobinDoneCustomCommandOptions,
  ListRobinDoneCustomCommandsOptions,
  RobinDoneCustomCommandInspection,
} from "./custom-commands.js";
export { createModelAdapter } from "./model-factory.js";
export type { CreateModelAdapterOptions } from "./model-factory.js";
export {
  createDefaultProviderEndpointRoutingPort,
  resolveProcessProviderEndpointRoutingPort,
} from "./provider-endpoint-routing.js";
export type {
  CreateDefaultProviderEndpointRoutingPortOptions,
  ResolveProcessProviderEndpointRoutingPortOptions,
} from "./provider-endpoint-routing.js";
export { startProcessProviderRegistryRuntime } from "./app/process-provider-registry-runtime.js";
export type { ProcessProviderRegistryRuntimeOptions } from "./app/process-provider-registry-runtime.js";
export {
  addRobinDonePluginMarketplace,
  getRobinDonePluginsOverview,
  installRobinDoneMarketplacePlugin,
  listRobinDonePlugins,
  removeRobinDonePluginMarketplace,
  resolveRobinDonePlugins,
  setRobinDonePluginEnabled,
  uninstallRobinDoneMarketplacePlugin,
  updateRobinDoneMarketplacePlugin,
  updateRobinDonePluginMarketplace,
  validateRobinDonePluginPath,
} from "./plugins.js";
export type {
  AddRobinDoneMarketplaceOptions,
  InstallRobinDoneMarketplacePluginOptions,
  ListRobinDonePluginsOptions,
  RemoveRobinDoneMarketplaceOptions,
  ResolveRobinDonePluginsOptions,
  SetRobinDonePluginEnabledOptions,
  SetRobinDonePluginEnabledResult,
  UninstallRobinDoneMarketplacePluginOptions,
  UpdateRobinDoneMarketplaceOptions,
  UpdateRobinDoneMarketplacePluginOptions,
  ValidateRobinDonePluginPathOptions,
  RobinDoneAvailablePluginData,
  RobinDoneInstalledPluginData,
  RobinDoneMarketplaceSummaryData,
  RobinDoneMarketplaceUpdateData,
  RobinDonePluginInstallData,
  RobinDonePluginUpdateData,
  RobinDonePluginsOverviewData,
} from "./plugins.js";
export { runRobinDoneProtocolAgent } from "./robindone-protocol-entrypoint.js";
// Exposed for the CLI's --output-format stream-json: it needs the same event
// shape the protocol server emits, rather than inventing a second one.
export { mapSessionEvent } from "./robindone-protocol/session-mapper.js";
export { prepareRobinDoneTelemetryEnv, shutdownRobinDoneTelemetry } from "./telemetry-bootstrap.js";
export type { SessionTranscriptMessage, SessionTranscriptPart } from "./session-transcript.js";
export { listRobinDoneSessions, resolveLatestSession } from "./sessions.js";
export { inspectRobinDoneSkill, listRobinDoneSkills } from "./skills.js";
export type {
  InspectRobinDoneSkillOptions,
  ListRobinDoneSkillsOptions,
  RobinDoneSkillInspection,
} from "./skills.js";
// Exposed for the CLI's headless slash routing: it must decide "is this a real
// custom command?" with the *same* reserved-name gate the app facade's
// customCommandPromptResolver applies, or the two disagree and a reserved name
// reaches the model as literal prompt text. See prompt-command.ts.
export { isReservedRobinDoneSlashCommandName } from "./slash-command-surface.js";
export {
  grantWorkspaceHookTrust,
  inspectWorkspaceHookTrust,
  revokeWorkspaceHookTrustCli,
} from "./workspace-hook-trust-cli.js";
export type {
  WorkspaceHookTrustCliItem,
  WorkspaceHookTrustCliStatus,
  WorkspaceHookTrustCliTarget,
} from "./workspace-hook-trust-cli.js";

// 嵌入式调用复用产品请求装配，避免来源头与网络配置漂移。
export { createRuntimeAiSdkModelExecutionConfig } from "./model-config.js";
