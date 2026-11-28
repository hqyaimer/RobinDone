import { createMcpTransportFetch } from "@robindone/adapters";
import { createConfig, resolvePath } from "@robindone/adapters/config";
import type { McpElicitationPort, McpNotificationPort } from "@robindone/contracts";
import { createNodeModelSelectionFacade } from "@robindone/provider-node";
import { createNodeLoggerFactory } from "@robindone/adapters/logging";
import {
  createMcpAdapterConnectionPool,
  createMcpTelemetryTracker,
  type McpConnectionPool,
  type McpTelemetryTracker,
} from "@robindone/adapters/mcp";
import {
  robindoneProtocolNotifications,
  type RobinDoneMcpResourceSample,
  type RobinDoneMcpTelemetryEvent,
} from "@robindone/shared";
import { createNodeSessionDataFiles, type SqliteSessionStore } from "@robindone/adapters/storage";
import { traceContextToLogContext, createRootTraceContext } from "@robindone/contracts";
import type { McpPort, ModelSelection } from "@robindone/contracts";
import type { PresentationSurface } from "@robindone/core";
import type { RunRobinDoneProtocolAgentOptions, RobinDoneAppOptions } from "./app/types.js";
import { createRobinDoneApp } from "./app/create-app.js";
import {
  createNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "./app/node-repl-browser-broker.js";
import {
  openProtocolStartupStorage,
  prepareProtocolStartupStorage,
} from "./robindone-protocol/storage-startup.js";
import { closeSessionStore, getSessionDbPath } from "./app/session-store.js";
import { resolveMcpNodeFallbackProvider } from "./app/mcp-node-fallback.js";
import { getCliStorageRoot, getProjectMemoryRoot } from "./app/paths.js";
import { startProcessProviderRegistryRuntime } from "./app/process-provider-registry-runtime.js";
import { scheduleStartupLogRetentionCleanup } from "./log-retention.js";
import { resolveProcessProviderEndpointRoutingPort } from "./provider-endpoint-routing.js";
import { StartupTimer, startupNow } from "./startup-logging.js";
import { installRobinDoneProtocolAiSdkWarningLogger } from "./robindone-protocol/ai-sdk-warning-logger.js";
import {
  createOfficialCommandAuthHeadersPort,
  createOfficialMcpAuthHeadersPort,
  type OfficialMcpAuthRequestContext,
} from "./robindone-protocol/official-mcp-auth-port.js";
// RobinDone(2026-11-22): [hide-upstream-account] 隐藏「official-command-endpoint（Sites 命令代理端点）」——
// 唯一消费者 robindone-site 插件已退役（无登录态必 401）；模块目录与单测保留。恢复时取消各接线段注释
// import {
//   createOfficialCommandEndpoint,
//   type OfficialCommandEndpoint,
// } from "./official-command-endpoint/index.js";
import {
  createOfficialMcpTrustedOriginRegistry,
  OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV,
  ROBINDONE_WORKSPACE_IDENTITY_ENV,
  resolveRuntimeRobinDoneEndpointOrigin,
} from "@robindone/shared";
import { RobinDoneProtocolAgentServer } from "./robindone-protocol/server.js";
import { RobinDoneProtocolNdjsonConnection } from "./robindone-protocol/transport.js";
import { cleanupProtocolRuntime } from "./robindone-protocol/runtime-cleanup.js";
import { startProtocolResourceSampler } from "./robindone-protocol/resource-sampler.js";
import { acquireProtocolStartupResource } from "./robindone-protocol/startup-resource.js";
import { prepareRobinDoneTelemetryEnv, shutdownRobinDoneTelemetry } from "./telemetry-bootstrap.js";
import type { RobinDoneProcessResourceSampler } from "./process-resource-sampler.js";

export function applyProtocolPresentationSurface(
  options: Omit<RobinDoneAppOptions, "providerRegistry">,
  presentationSurface: PresentationSurface,
): Omit<RobinDoneAppOptions, "providerRegistry"> {
  return {
    ...options,
    runtimeConfig: {
      ...options.runtimeConfig,
      presentationSurface,
    },
  };
}

/**
 * 进程级 Registry 已就绪后，它就是当前 Environment 的模型事实源。
 *
 * 旧 workspace snapshot 不再参与 Provider 和 Model 执行。
 */
export function applyProtocolProviderRegistry(
  options: Omit<RobinDoneAppOptions, "providerRegistry">,
  providerRegistry: RobinDoneAppOptions["providerRegistry"],
  configuredDefaultModelSelection?: ModelSelection,
): RobinDoneAppOptions {
  return {
    ...options,
    providerRegistry,
    ...(configuredDefaultModelSelection ? { configuredDefaultModelSelection } : {}),
  };
}

export async function runRobinDoneProtocolAgent(
  options: RunRobinDoneProtocolAgentOptions = {},
): Promise<void> {
  if (options.prepareStorageOnly) {
    const config = createConfig({ env: options.env });
    await prepareProtocolStartupStorage({
      dbPath: getSessionDbPath(config, options.cwd),
      input: options.input ?? process.stdin,
      output: options.output ?? process.stdout,
    });
    return;
  }
  const startupStartedAt = startupNow();
  const presentationSurface = options.presentationSurface ?? "terminal";
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const loggerFactory = createNodeLoggerFactory({ env: options.env });
  const traceContext = createRootTraceContext({
    attributes: {
      entrypoint: "robindone_protocol",
    },
  });
  const logger = loggerFactory.createLogger("robindone").child({
    ...traceContextToLogContext(traceContext),
    module: "bootstrap.robindone_protocol",
  });
  installRobinDoneProtocolAiSdkWarningLogger(logger);
  const startupTimer = new StartupTimer(
    logger,
    {
      ...traceContextToLogContext(traceContext),
      module: "bootstrap.robindone_protocol",
      startupKind: "robindone_protocol_agent",
    },
    startupStartedAt,
  );
  startupTimer.start("RobinDone Protocol agent startup started", {
    context: { version: options.version },
    event: "robindone_protocol.startup.started",
    stage: "start",
  });

  let sessionStore: SqliteSessionStore | undefined;
  let serverForCleanup: RobinDoneProtocolAgentServer | undefined;
  let nodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  // RobinDone(2026-11-22): [hide-upstream-account] official-command-endpoint 已隐藏——恢复时取消本行
  // let officialCommandEndpoint: OfficialCommandEndpoint | undefined;
  let mcpConnectionPool: McpConnectionPool | undefined;
  let mcpPort: McpPort | undefined;
  let mcpTelemetryTracker: McpTelemetryTracker | undefined;
  let mcpResourceSink: ((samples: RobinDoneMcpResourceSample[]) => void) | undefined;
  let mcpTelemetrySink: ((event: RobinDoneMcpTelemetryEvent) => void) | undefined;
  let processResourceSampler: RobinDoneProcessResourceSampler | undefined;
  let providerRegistryRuntime:
    | Awaited<ReturnType<typeof startProcessProviderRegistryRuntime>>
    | undefined;
  try {
    // 数据库准备先于账号、Registry 和遥测，不把远端材料等待混进迁移门禁。
    const configResult = createConfig({ env: options.env });
    sessionStore = await acquireProtocolStartupResource({
      signal: options.lifecycle?.signal,
      logger,
      disposeLate: (store) => closeSessionStore(store),
      create: () =>
        openProtocolStartupStorage({
          dbPath: getSessionDbPath(configResult),
          output,
          onProgress: (progress) =>
            logger.info("SQLite startup state", {
              event: "robindone_protocol.startup.storage_state",
              ...progress,
            }),
        }),
    });
    const runtimeEnv = options.env ?? process.env;
    options.lifecycle?.signal.throwIfAborted();
    providerRegistryRuntime = await acquireProtocolStartupResource({
      signal: options.lifecycle?.signal,
      logger,
      create: () => startProcessProviderRegistryRuntime(runtimeEnv),
      disposeLate: (runtime) => runtime.dispose(),
    });
    options.lifecycle?.signal.throwIfAborted();
    logger.info("Worker Provider Registry 已就绪", {
      accountRevision: providerRegistryRuntime.snapshot.sourceRevisions.account,
      configRevision: providerRegistryRuntime.snapshot.sourceRevisions.config,
      event: "robindone_protocol.provider_registry.ready",
      module: "bootstrap.robindone_protocol",
      providerCount: providerRegistryRuntime.snapshot.registry.providers.length,
    });
    const runtimeSurface = resolveProtocolRuntimeSurface(runtimeEnv);
    const telemetryEnv = await acquireProtocolStartupResource({
      signal: options.lifecycle?.signal,
      logger,
      disposeLate: () => shutdownRobinDoneTelemetry(),
      create: () =>
        prepareRobinDoneTelemetryEnv(runtimeEnv, {
          cliVersion: options.version,
          productVersion: options.env?.ROBINDONE_APP_VERSION,
          runtimeSurface,
        }),
    });
    const telemetryDeviceMid = telemetryEnv.ROBINDONE_TELEMETRY_DEVICE_MID;
    mcpTelemetryTracker =
      configResult.config.features.mcp === false
        ? undefined
        : createMcpTelemetryTracker({
            idSalt: telemetryDeviceMid ?? traceContext.traceId,
            onEvent: (event) => mcpTelemetrySink?.(event),
            onResourceSamples: (samples) => mcpResourceSink?.(samples),
          });
    const providerEndpointRoutingPort =
      options.providerEndpointRoutingPort ??
      resolveProcessProviderEndpointRoutingPort({
        appVersion: options.version,
        env: options.env,
        logger,
        network: configResult.config.network,
        sourceTitle: "electron",
      });
    // 官方 MCP 身份头端口（spec §7.1/§7.2）：连接池构造早于 server，故用惰性 holder 回填。
    // server 就绪前该端口返回 official_auth_unavailable；HTTP tools/call 会匿名交给服务端
    // 返回结构化权限错误，stdio 则把 reason 下发给插件。连接与工具发现都不受影响。
    let officialMcpAuthContext: OfficialMcpAuthRequestContext | undefined;
    // stdio 官方 MCP 没有 url 可供校验，targetOrigin 只能由宿主给出。
    // 与下面 trustedOrigins 的 resolveRobinDoneApiOrigin 必须是同一个表达式，否则两侧判定分叉。
    const resolveRobinDoneApiOrigin = (): string =>
      resolveRuntimeRobinDoneEndpointOrigin(options.env ?? process.env);
    const workspaceIdentity = (options.env ?? process.env)[ROBINDONE_WORKSPACE_IDENTITY_ENV]?.trim();
    const officialMcpAuth = {
      authHeadersPort: createOfficialMcpAuthHeadersPort({
        resolveContext: () => officialMcpAuthContext,
        // workspaceKey 必须遵守仓库约定 `workspaceIdentity?.trim() || workspacePath`，
        // 否则同路径不同 identity 的远端 workspace 在审计上下文里无法区分。
        // 注意：agent 进程当前没有 identity 来源，因此实际多为 undefined，key 退化为 path；
        // 详见 official-mcp-auth-port.ts 的"剩余缺口"说明。
        resolveWorkspace: ({ workspaceIdentity, workspacePath }) => {
          const path = workspacePath ?? options.cwd;
          if (!path) return undefined;
          const identity = workspaceIdentity?.trim();
          return {
            ...(identity ? { workspaceIdentity: identity } : {}),
            workspaceKey: identity || path,
            workspacePath: path,
          };
        },
      }),
      resolveRobinDoneApiOrigin,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      // 信任判定只看一条：目标 origin 等于当前 RobinDone API origin（https）。pluginId 不参与。
      // origin 运行时解析（跟随 production/test 与自建环境），不硬编码域名。
      trustedOrigins: createOfficialMcpTrustedOriginRegistry({
        devTrustedOriginsRaw: (options.env ?? process.env)[OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV],
        resolveRobinDoneApiOrigin,
      }),
    };
    // RobinDone(2026-11-22): [hide-upstream-account] 隐藏「official-command-endpoint 创建」——恢复时取消本段注释
    // 官方插件命令进程的代理端点（技术方案 5.8）：CLI 不持有凭证，端点每个请求向 host 现取
    // 身份头后转发给 robindone-server。和官方 MCP 用同一个 origin 表达式与网络配置。
    // const endpointEnv = options.env ?? process.env;
    // officialCommandEndpoint = createOfficialCommandEndpoint({
    //   resolveHeaders: createOfficialCommandAuthHeadersPort({
    //     resolveContext: () => officialMcpAuthContext,
    //     logger,
    //   }).resolveHeaders,
    //   resolveRobinDoneApiOrigin,
    //   appVersion: endpointEnv.ROBINDONE_APP_VERSION?.trim() || options.version,
    //   fetch: createMcpTransportFetch({ env: endpointEnv, network: configResult.config.network }),
    //   logger,
    // });
    // const activeOfficialCommandEndpoint = officialCommandEndpoint;
    // RobinDone(2026-11-22): [hide-upstream-account] 隐藏结束
    // MCP elicitation 归属到协议 server 的会话；pool 先于 server 创建，端口延迟绑定。
    let elicitationServer: {
      requestMcpElicitation: McpElicitationPort["requestElicitation"];
      handleMcpNotification: McpNotificationPort["onNotification"];
    } | null = null;
    mcpConnectionPool =
      configResult.config.features.mcp === false
        ? undefined
        : createMcpAdapterConnectionPool({
            elicitation: {
              requestElicitation: (request, elicitationOptions) =>
                elicitationServer
                  ? elicitationServer.requestMcpElicitation(request, elicitationOptions)
                  : Promise.resolve({ action: "decline" as const }),
            },
            // server 通知同样延迟绑定到协议 server。
            notifications: {
              onNotification: (notification) =>
                elicitationServer?.handleMcpNotification(notification),
            },
            clientVersion: options.version ?? "0.0.0",
            env: options.env,
            logger,
            network: {
              httpProxy: configResult.config.network.httpProxy,
              noProxy: configResult.config.network.noProxy,
              caCertFile: configResult.config.network.caCertFile,
            },
            nodeFallback: resolveMcpNodeFallbackProvider({
              cliStorageRoot: getCliStorageRoot(resolvePath(configResult.config.storage.dir)),
              logger,
            }),
            officialMcpAuth,
            telemetry: mcpTelemetryTracker,
            workingDirectory: options.cwd,
          });
    mcpPort = mcpConnectionPool?.acquireLease({ leaseId: "protocol-settings" });
    const activeProviderRegistryRuntime = providerRegistryRuntime;
    const protocolCliStorageRoot = getCliStorageRoot(resolvePath(configResult.config.storage.dir));
    const modelSelectionFacade = createNodeModelSelectionFacade(
      activeProviderRegistryRuntime.runtime.registryService,
    );
    options.lifecycle?.signal.throwIfAborted();
    const server = (serverForCleanup = new RobinDoneProtocolAgentServer({
      createRobinDoneApp: (appOptions = {}) =>
        createRobinDoneApp({
          ...applyProtocolProviderRegistry(
            applyProtocolPresentationSurface(appOptions, presentationSurface),
            activeProviderRegistryRuntime.runtime.registryService,
            activeProviderRegistryRuntime.configuredDefaultModelSelection,
          ),
          // 只读同进程已应用快照；不为子任务另发 Host RPC，也不在 ModelFactory 偷换模型。
          resolveEffectiveModelSelection: (selection) => {
            const view = modelSelectionFacade.getView(undefined, undefined, { selection });
            return {
              effectiveSelection: view.effectiveSelection ?? null,
              selectionIssue: view.selectionIssue,
            };
          },
          env: {
            ...telemetryEnv,
            ...appOptions.env,
            ...(telemetryDeviceMid ? { ROBINDONE_TELEMETRY_DEVICE_MID: telemetryDeviceMid } : {}),
          },
          ...(nodeReplBrowserBroker ? { nodeReplBrowserBroker } : {}),
          ...(mcpConnectionPool
            ? {
                mcpPortFactory: () =>
                  mcpConnectionPool!.acquireLease({
                    leaseId: appOptions.sessionId,
                    sessionId: appOptions.sessionId,
                  }),
              }
            : {}),
          providerEndpointRoutingPort,
          // RobinDone(2026-11-22): [hide-upstream-account] official-command-endpoint 已隐藏——恢复时取消本段注释
          // officialCommandEnv: (sessionId, workspace) =>
          //   activeOfficialCommandEndpoint.envForSession(sessionId, workspace),
          // RobinDone(2026-11-22): [hide-upstream-account] 隐藏结束
          sourceTitle: "electron",
          onToolExecResource: (params) =>
            connection.send({ method: robindoneProtocolNotifications.toolExecResource, params }),
        }),
      cwd: options.cwd,
      // agent 消息在途请求的持久化落盘位置（2026-11-22）：CLI 存储根缺席（测试/嵌入
      // 形态）时登记表退化为纯内存，不落盘不恢复。
      cliStorageRoot: protocolCliStorageRoot,
      env: options.env,
      loggerFactory,
      mcpPort,
      mcpTelemetry: mcpTelemetryTracker,
      sessionStore,
      sessionDataFiles: createNodeSessionDataFiles({
        cliStorageRoot: protocolCliStorageRoot,
        // 与会话运行时的记忆解析同一函数，删除的正是 CLI 读写的那个目录。
        memoryRoot: ({ workspacePath, workspaceIdentity }) =>
          getProjectMemoryRoot(protocolCliStorageRoot, workspacePath, workspaceIdentity),
      }),
      syncAccountProviderConfig: activeProviderRegistryRuntime.syncAccountProviderConfig,
      refreshProviderRegistry: async (reason) => {
        await activeProviderRegistryRuntime.runtime.registryService.refresh(reason);
      },
      version: options.version,
    }));
    officialMcpAuthContext = server.officialMcpAuthRequestContext;
    elicitationServer = server;
    if (configResult.config.features.mcp !== false) {
      nodeReplBrowserBroker = createNodeReplBrowserBroker({
        browserControlPort: server.browserControlPort,
        logger,
        platform: process.platform,
      });
      const broker = nodeReplBrowserBroker;
      await acquireProtocolStartupResource({
        signal: options.lifecycle?.signal,
        logger,
        create: () => broker.ready,
      });
    }
    const connection = new RobinDoneProtocolNdjsonConnection({
      signal: options.lifecycle?.signal,
      clearPostResponseMessages: () => server.clearPostResponseMessages(),
      handleMessage: (message) => server.handleMessage(message),
      input,
      logger,
      onTransportClosed: (error) => server.disconnectClient(error),
      output,
      takePostResponseBatch: (requestId) => server.takePostResponseBatch(requestId),
    });
    server.setNotificationSink((notification) => connection.send(notification));
    mcpResourceSink = (samples) =>
      connection.send({
        method: robindoneProtocolNotifications.mcpResourceSamples,
        params: samples,
      });
    mcpTelemetrySink = (event) => {
      // 五分钟资源通知取代旧内存通知；tracker 内部孤儿事实仍保留原判据。
      if (event.kind === "memory") return;
      connection.send({
        method: robindoneProtocolNotifications.mcpTelemetry,
        params: event,
      });
    };
    connection.start();
    mcpTelemetryTracker?.start();
    processResourceSampler = startProtocolResourceSampler(
      server,
      (message) => connection.send(message),
      logger,
    );
    startupTimer.complete("RobinDone Protocol agent startup completed", {
      event: "robindone_protocol.startup.completed",
      stage: "total",
    });
    scheduleStartupLogRetentionCleanup(loggerFactory, logger);
    await connection.waitForClose();
  } catch (error) {
    options.lifecycle?.requestShutdown(
      error instanceof Error ? error : new Error("Protocol runtime failed", { cause: error }),
    );
    startupTimer.fail("RobinDone Protocol agent startup failed", error, {
      event: "robindone_protocol.startup.failed",
      stage: "total",
    });
    throw error;
  } finally {
    options.lifecycle?.requestShutdown();
    // RobinDone(2026-11-22): [hide-upstream-account] official-command-endpoint 已隐藏——恢复时取消本段注释
    // await officialCommandEndpoint?.close().catch((error: unknown) => {
    //   logger.warn("Official command endpoint close failed", {
    //     error: error instanceof Error ? error.message : String(error),
    //     event: "robindone_protocol.official_command_endpoint.close_failed",
    //   });
    // });
    // RobinDone(2026-11-22): [hide-upstream-account] 隐藏结束
    await cleanupProtocolRuntime({
      logger,
      deadlineAt: options.lifecycle?.deadlineAt,
      server: serverForCleanup,
      processResourceSampler,
      mcpTelemetryTracker,
      nodeReplBrowserBroker,
      mcpPort,
      mcpConnectionPool,
      sessionStore,
      providerRegistryRuntime,
    });
    logger.info("RobinDone Protocol agent shutdown completed", {
      ...traceContextToLogContext(traceContext),
      event: "robindone_protocol.shutdown.completed",
      module: "bootstrap.robindone_protocol",
      status: "completed",
    });
  }
}

function resolveProtocolRuntimeSurface(
  env: NodeJS.ProcessEnv,
): "desktop_local_host" | "remote_workspace_host" {
  // Bug 根因：入口曾无条件覆盖 Host 注入值，远程 SSH/WSL/容器 Trace 被归入本地 Desktop。
  return env.ROBINDONE_TELEMETRY_RUNTIME_SURFACE?.trim() === "remote_workspace_host"
    ? "remote_workspace_host"
    : "desktop_local_host";
}
