import {
  ProviderConfigService,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
} from "@robindone/provider";
import { NodeRobinDoneBuiltinProviderConfigSource } from "./robindone-builtin-provider-config-source.js";
import {
  EndpointScopedRobinDoneBuiltinSource,
  type EndpointScopedRobinDoneBuiltinSourceOptions,
} from "./endpoint-scoped-robindone-builtin-source.js";
import {
  RobinDoneBuiltinRemoteSynchronizer,
  type RobinDoneBuiltinRemoteSynchronizerOptions,
  type RobinDoneBuiltinRefreshResult,
} from "./robindone-builtin-remote-synchronizer.js";
import {
  NodePersonalProviderConfigRepository,
  type PersonalProviderConfigRecoveryEvent,
} from "./personal-provider-config-repository.js";

export interface NodeProviderConfigRuntimeOptions {
  readonly robindoneBuiltinFilePath: string;
  readonly robindoneBuiltinActiveFilePath?: string;
  readonly robindoneBuiltinRemote?: Omit<RobinDoneBuiltinRemoteSynchronizerOptions, "source">;
  readonly robindoneBuiltinEnvironment?: Omit<
    EndpointScopedRobinDoneBuiltinSourceOptions,
    "bundledFilePath"
  >;
  readonly onRobinDoneBuiltinRefreshError?: (error: unknown) => void;
  readonly onPersonalConfigRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly onPersonalConfigPollingError?: (error: unknown) => void;
  readonly personalFilePath: string;
  readonly personalPollingIntervalMs?: number | false;
  readonly importLegacy?: (
    robindoneBuiltin: ProviderConfigLayerSnapshot,
  ) => Promise<ProviderConfigLayerUpdate | null>;
  readonly watch?: boolean;
}

/** 组装一个 Node.js 进程内共享的 RobinDone Built-in/Personal Config 运行边界。 */
export class NodeProviderConfigRuntime {
  readonly configService: ProviderConfigService;
  readonly #robindoneBuiltinSource:
    | NodeRobinDoneBuiltinProviderConfigSource
    | EndpointScopedRobinDoneBuiltinSource;
  readonly #personalRepository: NodePersonalProviderConfigRepository;
  readonly #remoteSynchronizer?: RobinDoneBuiltinRemoteSynchronizer;
  readonly #onRemoteRefreshError?: (error: unknown) => void;
  #startPromise: Promise<void> | null = null;
  #disposed = false;
  readonly #checkListeners = new Set<() => Promise<void>>();
  #checkTimer: ReturnType<typeof setInterval> | null = null;
  #checkInFlight: Promise<void> | null = null;

  constructor(options: NodeProviderConfigRuntimeOptions) {
    this.#robindoneBuiltinSource = options.robindoneBuiltinEnvironment
      ? new EndpointScopedRobinDoneBuiltinSource({
          bundledFilePath: options.robindoneBuiltinFilePath,
          ...options.robindoneBuiltinEnvironment,
        })
      : new NodeRobinDoneBuiltinProviderConfigSource({
          bundledFilePath: options.robindoneBuiltinFilePath,
          activeFilePath: options.robindoneBuiltinActiveFilePath,
          watch: options.watch,
        });
    this.#remoteSynchronizer =
      options.robindoneBuiltinRemote &&
      this.#robindoneBuiltinSource instanceof NodeRobinDoneBuiltinProviderConfigSource
        ? new RobinDoneBuiltinRemoteSynchronizer({
            source: this.#robindoneBuiltinSource,
            ...options.robindoneBuiltinRemote,
          })
        : undefined;
    this.#onRemoteRefreshError = options.onRobinDoneBuiltinRefreshError;
    this.#personalRepository = new NodePersonalProviderConfigRepository({
      filePath: options.personalFilePath,
      onRecovery: options.onPersonalConfigRecovery,
      onPollingError: options.onPersonalConfigPollingError,
      pollingIntervalMs: options.personalPollingIntervalMs,
      ...(options.importLegacy
        ? {
            importLegacy: async () =>
              options.importLegacy!(await this.#robindoneBuiltinSource.read()),
          }
        : {}),
    });
    this.configService = new ProviderConfigService({
      robindoneBuiltinSource: this.#robindoneBuiltinSource,
      personalRepository: this.#personalRepository,
    });
  }

  resolveRobinDoneBuiltinActiveFilePath(): Promise<string> {
    return this.#robindoneBuiltinSource instanceof NodeRobinDoneBuiltinProviderConfigSource
      ? Promise.resolve(this.#robindoneBuiltinSource.activeFilePath)
      : this.#robindoneBuiltinSource.resolveActiveFilePath();
  }

  get personalRepository(): import("@robindone/provider").PersonalProviderConfigRepository {
    return this.#personalRepository;
  }

  /** Environment 同一周期检查中恢复未对齐依赖，不被下载 TTL 或失败挡住。 */
  onDidCheckRobinDoneBuiltin(listener: () => Promise<void>): () => void {
    this.#checkListeners.add(listener);
    return () => this.#checkListeners.delete(listener);
  }

  start(): Promise<void> {
    if (this.#disposed) throw new Error("NodeProviderConfigRuntime 已 dispose");
    if (this.#startPromise) return this.#startPromise;
    const startPromise = this.configService.read().then(() => {
      if (this.#disposed) return;
      void this.#checkBackground();
      // Managed Worker 无下载配置也无恢复 owner，不建立周期任务。
      if (
        this.#remoteSynchronizer ||
        this.#robindoneBuiltinSource instanceof EndpointScopedRobinDoneBuiltinSource ||
        this.#checkListeners.size > 0
      ) {
        this.#checkTimer = setInterval(() => {
          void this.#checkBackground();
        }, 60_000);
        this.#checkTimer.unref?.();
      }
    });
    this.#startPromise = startPromise;
    void startPromise.catch(() => {
      if (this.#startPromise === startPromise) this.#startPromise = null;
    });
    return startPromise;
  }

  refreshRobinDoneBuiltin(options?: {
    readonly force?: boolean;
  }): Promise<RobinDoneBuiltinRefreshResult> {
    if (this.#disposed) return Promise.resolve("disposed");
    if (this.#robindoneBuiltinSource instanceof EndpointScopedRobinDoneBuiltinSource) {
      return this.#robindoneBuiltinSource.refresh(options);
    }
    return this.#remoteSynchronizer?.refresh(options) ?? Promise.resolve("skipped");
  }

  #checkBackground(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#checkInFlight) return this.#checkInFlight;
    const check = Promise.allSettled([
      this.refreshRobinDoneBuiltin(),
      ...[...this.#checkListeners].map((listener) => Promise.resolve().then(listener)),
    ])
      .then((results) => {
        if (this.#disposed) return;
        for (const result of results)
          if (result.status === "rejected") this.#onRemoteRefreshError?.(result.reason);
      })
      .finally(() => {
        if (this.#checkInFlight === check) this.#checkInFlight = null;
      });
    this.#checkInFlight = check;
    return check;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#checkTimer) clearInterval(this.#checkTimer);
    this.#checkTimer = null;
    this.#checkListeners.clear();
    this.#remoteSynchronizer?.dispose();
    this.configService.dispose();
    this.#personalRepository.dispose();
    this.#robindoneBuiltinSource.dispose();
  }
}

export function createNodeProviderConfigRuntime(
  options: NodeProviderConfigRuntimeOptions,
): NodeProviderConfigRuntime {
  return new NodeProviderConfigRuntime(options);
}
