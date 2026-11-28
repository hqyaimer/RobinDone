import type { TuiReadClipboardImage, TuiWriteClipboardText } from "@robindone/tui";
import type { UiLocale } from "@robindone/i18n";
import type { Logger } from "@robindone/contracts";
import type {
  createManagedCdpBrowserRuntime,
  ManagedCdpBrowserRuntimeOptions,
} from "@robindone/adapters/browser";
import type {
  createDefaultProviderEndpointRoutingPort,
  createModelAdapter,
  createRobinDoneApp,
  CreateDefaultProviderEndpointRoutingPortOptions,
  CreateModelAdapterOptions,
  configureCodingPlanApiKey,
  ConfigureCodingPlanApiKeyOptions,
  inspectRobinDoneSkill,
  inspectWorkspaceHookTrust,
  grantWorkspaceHookTrust,
  revokeWorkspaceHookTrustCli,
  inspectRobinDoneCustomCommand,
  InspectRobinDoneCustomCommandOptions,
  InspectRobinDoneSkillOptions,
  loginRobinDoneCli,
  loginBigmodelCodingPlan,
  LoginBigmodelCodingPlanOptions,
  LoginRobinDoneCliOptions,
  listRobinDoneCustomCommands,
  ListRobinDoneCustomCommandsOptions,
  loadRobinDoneCustomCommand,
  listRobinDoneSessions,
  listRobinDoneSkills,
  ListRobinDoneSessionsOptions,
  ListRobinDoneSkillsOptions,
  logoutRobinDoneCli,
  LogoutRobinDoneCliOptions,
  resolveLatestSession,
  ResolveLatestSessionOptions,
  RunRobinDoneProtocolAgentOptions,
  prepareRobinDoneTelemetryEnv,
  startProcessProviderRegistryRuntime,
  shutdownRobinDoneTelemetry,
  RobinDoneAppOptions,
} from "@robindone/bootstrap";
import type { CliEnv, DotenvLoadResult, LoadCliDotenvOptions } from "./env.js";
import type { PluginsCommandOverrides } from "./plugins-command.js";
import type { CliShutdownProcess } from "./shutdown.js";
import type { resolveWorkspaceGitBranch } from "./tui-workspace-git.js";

export type BootstrapModule = typeof import("@robindone/bootstrap");

export interface RunDependencies extends PluginsCommandOverrides {
  migrateStorage?: () => Promise<import("@robindone/shared/sqlite-migrations").MigrationResult>;
  protocolLifecycle?: RunRobinDoneProtocolAgentOptions["lifecycle"];
  protocolInput?: NodeJS.ReadableStream;
  createManagedCdpBrowserRuntime?: (
    options?: ManagedCdpBrowserRuntimeOptions,
  ) => ReturnType<typeof createManagedCdpBrowserRuntime>;
  createModelAdapter?: (
    options?: CreateModelAdapterOptions,
  ) => ReturnType<typeof createModelAdapter>;
  createProviderEndpointRoutingPort?: (
    options: CreateDefaultProviderEndpointRoutingPortOptions,
  ) => ReturnType<typeof createDefaultProviderEndpointRoutingPort>;
  createRobinDoneApp?: (
    options?: RobinDoneAppOptions,
  ) => Awaited<ReturnType<typeof createRobinDoneApp>> | ReturnType<typeof createRobinDoneApp>;
  /**
   * Session-event shaper for --output-format stream-json. Defaults to the
   * bootstrap module's, which is also what the protocol server uses; injectable
   * so a caller that supplies its own `createRobinDoneApp` (tests, embedders) can
   * still stream, since the bootstrap module is not loaded on that path.
   */
  mapSessionEvent?: BootstrapModule["mapSessionEvent"];
  cwd?: () => string;
  env?: CliEnv;
  inspectSkill?: (options: InspectRobinDoneSkillOptions) => ReturnType<typeof inspectRobinDoneSkill>;
  inspectWorkspaceHookTrust?: typeof inspectWorkspaceHookTrust;
  grantWorkspaceHookTrust?: typeof grantWorkspaceHookTrust;
  revokeWorkspaceHookTrustCli?: typeof revokeWorkspaceHookTrustCli;
  inspectCustomCommand?: (
    options: InspectRobinDoneCustomCommandOptions,
  ) => ReturnType<typeof inspectRobinDoneCustomCommand>;
  loginRobinDoneCli?: (options?: LoginRobinDoneCliOptions) => ReturnType<typeof loginRobinDoneCli>;
  loginBigmodelCodingPlan?: (
    options?: LoginBigmodelCodingPlanOptions,
  ) => ReturnType<typeof loginBigmodelCodingPlan>;
  configureCodingPlanApiKey?: (
    options: ConfigureCodingPlanApiKeyOptions,
  ) => ReturnType<typeof configureCodingPlanApiKey>;
  loadDotenv?: (options?: LoadCliDotenvOptions) => DotenvLoadResult;
  prepareRobinDoneTelemetryEnv?: typeof prepareRobinDoneTelemetryEnv;
  projectConfigPath?: string;
  listSessions?: (options: ListRobinDoneSessionsOptions) => ReturnType<typeof listRobinDoneSessions>;
  listCustomCommands?: (
    options: ListRobinDoneCustomCommandsOptions,
  ) => ReturnType<typeof listRobinDoneCustomCommands>;
  loadCustomCommand?: (
    options: InspectRobinDoneCustomCommandOptions,
  ) => ReturnType<typeof loadRobinDoneCustomCommand>;
  // headless slash 路由要和 app facade 的保留名 gate 用同一个判据；默认取 bootstrap 的，
  // 注入点只为让单测不必拉起整个 bootstrap 模块。见 prompt-command.ts。
  isReservedSlashCommandName?: BootstrapModule["isReservedRobinDoneSlashCommandName"];
  listSkills?: (options: ListRobinDoneSkillsOptions) => ReturnType<typeof listRobinDoneSkills>;
  logger?: Logger;
  readClipboardImage?: TuiReadClipboardImage;
  writeClipboardText?: TuiWriteClipboardText;
  resolveLatestSession?: (
    options: ResolveLatestSessionOptions,
  ) => ReturnType<typeof resolveLatestSession>;
  resolveWorkspaceGitBranch?: typeof resolveWorkspaceGitBranch;
  logoutRobinDoneCli?: (options?: LogoutRobinDoneCliOptions) => ReturnType<typeof logoutRobinDoneCli>;
  runRobinDoneProtocolAgent?: (options?: RunRobinDoneProtocolAgentOptions) => Promise<void>;
  runTui?: typeof import("@robindone/tui").runTui;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  exitProcess?: (code: number) => void;
  shutdownCleanupTimeoutMs?: number;
  shutdownProcess?: CliShutdownProcess;
  startProcessProviderRegistryRuntime?: typeof startProcessProviderRegistryRuntime;
  shutdownRobinDoneTelemetry?: typeof shutdownRobinDoneTelemetry;
}

export type CliPermissionMode = "build" | "plan" | "edit" | "yolo" | "guarded";
export type CliRuntimeMode = CliPermissionMode | "auto";

export interface CliModeState {
  current?: CliRuntimeMode;
  override?: CliPermissionMode;
}

export interface CliTargetRequest {
  objective: string;
  replaceExisting: boolean;
}

export type ModeCapableApp = Awaited<ReturnType<typeof createRobinDoneApp>> & {
  getMode?: () => CliRuntimeMode;
  setLocale?: (locale: UiLocale) => Promise<{ locale: "en-US" | "zh-CN" }>;
  setMode?: (mode: CliRuntimeMode) => Promise<{ mode: CliRuntimeMode }>;
};

export interface CliResumeRequest {
  continueSession: boolean;
  resumeSessionId?: string;
}
