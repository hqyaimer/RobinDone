import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  materializeRobinDoneBuiltinProviderConfig,
  NodeRobinDoneBuiltinProviderConfigSource,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  resolveRobinDoneBuiltinCachePaths,
  resolveRobinDoneBuiltinClientPlatform,
  ROBINDONE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV,
  ROBINDONE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ROBINDONE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
  type RobinDoneBuiltinRefreshEvent,
} from "@robindone/provider-node";
import { resolveRuntimeRobinDoneEndpointOrigin, ROBINDONE_VERSION } from "@robindone/shared";
import type { CliEnv } from "./env.js";

export const SEA_ROBINDONE_BUILTIN_PROVIDER_CONFIG_ASSET_KEY = "robindone-provider/robindone-builtin.json";

export function createCliProviderRefreshReporter(
  stderr: Pick<NodeJS.WriteStream, "write"> = process.stderr,
) {
  return {
    onBuiltinRefreshError(error: unknown) {
      stderr.write(
        `RobinDone Built-in 刷新失败: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
    },
    onBuiltinRefreshResult(event: RobinDoneBuiltinRefreshEvent) {
      // TTL 检查不是生产事件；成功更新才默认留痕，不能输出 CDN URL 查询参数或内容。
      if (event.result === "updated" || process.env.NODE_ENV !== "production") {
        stderr.write(
          `RobinDone Built-in ${event.result}${event.reason ? ` (${event.reason})` : ""}${event.revision === undefined ? "" : ` revision=${event.revision} source=CDN`}\n`,
        );
      }
    },
  };
}

type SeaProviderConfigAssets = Pick<typeof import("node:sea"), "getAsset" | "isSea">;

interface PrepareCliProviderRuntimeEnvOptions {
  readonly argv: readonly string[];
  readonly env: CliEnv;
  readonly dataBaseDir?: string;
  readonly entrypoint?: string;
  readonly sea?: SeaProviderConfigAssets;
  readonly appVersion?: string;
  readonly platform?: string;
}

/** 为运行 Core 或写入模型选择的 CLI Entry 定位同一 Environment 的 Provider Config。 */
export async function prepareCliProviderRuntimeEnv(
  options: PrepareCliProviderRuntimeEnvOptions,
): Promise<Record<string, string>> {
  if (!requiresProviderRuntime(options.argv)) return {};

  const explicitRobinDoneBuiltin = options.env[ROBINDONE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const explicitPersonal = options.env[ROBINDONE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const dataBaseDir = options.dataBaseDir ?? options.env.ROBINDONE_DATA_BASE_DIR?.trim() ?? homedir();
  if (explicitRobinDoneBuiltin && explicitPersonal) {
    return {
      [ROBINDONE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: explicitRobinDoneBuiltin,
      [ROBINDONE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: explicitPersonal,
    };
  }

  const robindoneBuiltinFilePath =
    explicitRobinDoneBuiltin ??
    (await resolveBundledRobinDoneBuiltinProviderConfig({
      dataBaseDir,
      entrypoint: options.entrypoint ?? process.argv[1],
      sea: options.sea ?? getSeaProviderConfigAssets(),
    }));
  const personalFilePath =
    explicitPersonal ?? join(dataBaseDir, ".robindone", "v2", PERSONAL_PROVIDER_CONFIG_FILE_NAME);
  const appVersion = options.appVersion ?? ROBINDONE_VERSION;
  const platform = options.platform ?? resolveRobinDoneBuiltinClientPlatform();
  const robindoneEndpointOrigin = resolveRuntimeRobinDoneEndpointOrigin(options.env);
  const cachePaths = resolveRobinDoneBuiltinCachePaths({
    environmentConfigRoot: join(dataBaseDir, ".robindone", "v2"),
    platform,
    appVersion,
    robindoneEndpointOrigin,
  });
  const source = new NodeRobinDoneBuiltinProviderConfigSource({
    bundledFilePath: robindoneBuiltinFilePath,
    activeFilePath: cachePaths.activeFilePath,
    watch: false,
  });
  // 入口只准备资源和路径；下载由 Prompt/TUI 长生命周期 Runtime 持有并取消。
  try {
    await source.read();
  } finally {
    source.dispose();
  }

  return {
    [ROBINDONE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: cachePaths.activeFilePath,
    [ROBINDONE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV]: robindoneBuiltinFilePath,
    [ROBINDONE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personalFilePath,
  };
}

function requiresProviderRuntime(argv: readonly string[]): boolean {
  if (argv.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v")) {
    return false;
  }
  if (
    argv.some(
      (arg) =>
        arg === "--prompt" ||
        arg.startsWith("--prompt=") ||
        arg === "--target" ||
        arg.startsWith("--target="),
    )
  ) {
    return true;
  }

  const command = argv[0];
  if (command === undefined || command.startsWith("-")) return true;
  return (
    command === "tui" ||
    command === "app-server" ||
    command === "agent-server" ||
    command === "login" ||
    command === "logout"
  );
}

async function resolveBundledRobinDoneBuiltinProviderConfig(input: {
  readonly dataBaseDir: string;
  readonly entrypoint: string | undefined;
  readonly sea: SeaProviderConfigAssets | undefined;
}): Promise<string> {
  if (input.sea?.isSea()) {
    const content = input.sea.getAsset(SEA_ROBINDONE_BUILTIN_PROVIDER_CONFIG_ASSET_KEY, "utf8");
    return materializeRobinDoneBuiltinProviderConfig({
      environmentConfigRoot: join(input.dataBaseDir, ".robindone", "v2"),
      content,
    });
  }

  const entrypoint = input.entrypoint?.trim();
  if (!entrypoint) throw new Error("无法定位 CLI RobinDone Built-in Provider Config：缺少入口路径");
  // 全局 bin 可以是软链接，随包配置必须相对真实入口定位。
  const entryDirectory = dirname(realpathSync(resolve(entrypoint)));
  const candidates = [
    join(entryDirectory, "provider", "robindone-builtin.json"),
    resolve(entryDirectory, "../../../../../config/provider/robindone-builtin.json"),
  ];
  const candidate = candidates.find((filePath) => existsSync(filePath));
  if (candidate) return candidate;
  throw new Error(`无法定位 CLI RobinDone Built-in Provider Config：${candidates.join(", ")}`);
}

function getSeaProviderConfigAssets(): SeaProviderConfigAssets | undefined {
  const getBuiltinModule = process.getBuiltinModule as
    | ((id: "node:sea") => typeof import("node:sea"))
    | undefined;
  return getBuiltinModule?.("node:sea");
}
