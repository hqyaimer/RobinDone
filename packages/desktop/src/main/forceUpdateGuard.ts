import {
  ROBINDONE_VERSION,
  resolveForceUpdateRequirement,
  type ForceUpdateRequirement,
  type Locale,
} from "@robindone/shared";
import { requestForceAutoUpdate, type ForceAutoUpdateState } from "./autoUpdater.js";
import { resolveStaticManifestBase } from "./manifestUpdateProvider.js";
import { showForceUpdatePrompt } from "./forceUpdatePrompt.js";

const FORCE_UPDATE_CONFIG_REQUEST_TIMEOUT_MS = 10_000;
const FORCE_UPDATE_CONFIG_MAX_RESPONSE_BYTES = 1024 * 1024;

export interface ForceUpdateDialogText {
  title: string;
  message: string;
  detail: string;
  autoUpdateButton: string;
  manualUpdateButton: string;
  quitButton: string;
}

export interface ForceUpdateGuardLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface ForceUpdateGuardResult {
  blocked: boolean;
  requirement?: ForceUpdateRequirement;
}

export interface ForceUpdateGuardOptions {
  locale: Locale;
  logger: ForceUpdateGuardLogger;
  /**
   * 静态更新源 base（构建期钉死，与更新 feed 同源）。强制升级检查改走自有静态配置
   * `"{base}/min-version.json"`（2026-11-24 裁决：上游 SaaS 的 client-configs API 会把
   * ZCode 的最低可用版本（v3.5.3）套到 RobinDone 头上，0.0.1 启动即被强更拦截——
   * RobinDone 不再请求上游 API；未配置静态源时整体跳过远端强更检查）。
   */
  staticFeedBase?: string;
  fetchRemoteConfig?: () => Promise<unknown>;
  requestAutoUpdate?: (
    onStateChange?: (state: ForceAutoUpdateState) => void,
  ) => (() => void) | void;
  onBlocked?: (requirement: ForceUpdateRequirement) => void;
}

/** 静态强更配置契约（updates 分支根目录 min-version.json）。 */
interface ForceUpdateStaticConfig {
  /** 最低可用版本；缺省表示当前不强制升级。 */
  minimalVersion?: string;
  /** 手动升级跳转地址；缺省时手动升级按钮不可用。 */
  downloadUrl?: string;
}

export function resolveForceUpdateMinVersionConfigUrl(staticFeedBase: string): string {
  return new URL("min-version.json", resolveStaticManifestBase(staticFeedBase)).toString();
}

function getForceUpdateStaticConfig(config: unknown): ForceUpdateStaticConfig {
  if (typeof config !== "object" || config === null) {
    return {};
  }
  const record = config as ForceUpdateStaticConfig;
  return {
    ...(typeof record.minimalVersion === "string" ? { minimalVersion: record.minimalVersion } : {}),
    ...(typeof record.downloadUrl === "string" ? { downloadUrl: record.downloadUrl } : {}),
  };
}

/** 404 与其他错误分开：清单未发布 = 无最低版本要求，属正常状态而非故障。 */
class ForceUpdateConfigNotFoundError extends Error {
  constructor() {
    super("force update config not found (404)");
  }
}

async function fetchRemoteForceUpdateConfig(
  url: string,
  fetchRemoteConfig?: () => Promise<unknown>,
): Promise<unknown> {
  if (fetchRemoteConfig) {
    return fetchRemoteConfig();
  }

  const { net } = await import("electron");
  return new Promise<unknown>((resolve, reject) => {
    let request: ReturnType<typeof net.request>;
    let timer: ReturnType<typeof setTimeout>;
    let data = "";
    let receivedBytes = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      request?.abort();
      reject(error);
    };

    const finish = (value: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    timer = setTimeout(() => {
      fail(new Error("force update config request timeout"));
    }, FORCE_UPDATE_CONFIG_REQUEST_TIMEOUT_MS);
    timer.unref?.();

    request = net.request(url);
    request.on("response", (response) => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode === 404) {
        fail(new ForceUpdateConfigNotFoundError());
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        // 启动前强更 gate 不能把 4xx/5xx/HTML 错页当正常配置解析，统一走离线降级路径。
        fail(new Error(`force update config request failed with status ${statusCode}`));
        return;
      }

      response.on("data", (chunk) => {
        receivedBytes += Buffer.byteLength(chunk);
        if (receivedBytes > FORCE_UPDATE_CONFIG_MAX_RESPONSE_BYTES) {
          // 远端配置在主窗口创建前读取，必须限制响应体，避免异常响应撑爆 main 进程内存。
          fail(new Error("force update config response too large"));
          return;
        }
        data += chunk.toString();
      });
      response.on("end", () => {
        try {
          finish(JSON.parse(data));
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      response.on("error", (error) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    });
    request.on("error", (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
    request.end();
  });
}

export async function resolveDesktopForceUpdateRequirement(options: {
  logger: ForceUpdateGuardLogger;
  staticFeedBase?: string;
  fetchRemoteConfig?: () => Promise<unknown>;
}): Promise<ForceUpdateRequirement | null> {
  const staticFeedBase = options.staticFeedBase?.trim();
  if (!staticFeedBase) {
    // 未配置静态更新源 = RobinDone 没有可用的强更决策来源（上游 SaaS 的 client-configs
    // 已退役，见 ForceUpdateGuardOptions 注释），整体跳过，绝不退回上游 API。
    options.logger.warn(
      "[force-update] 未配置静态更新源（ROBINDONE_UPDATE_FEED_BASE），跳过远端强制升级检查",
    );
    return null;
  }

  let config: ForceUpdateStaticConfig;
  try {
    const remoteConfig = await fetchRemoteForceUpdateConfig(
      resolveForceUpdateMinVersionConfigUrl(staticFeedBase),
      options.fetchRemoteConfig,
    );
    config = getForceUpdateStaticConfig(remoteConfig);
  } catch (error) {
    if (error instanceof ForceUpdateConfigNotFoundError) {
      options.logger.info(
        "[force-update] 未发布 min-version.json，视为无最低版本要求，跳过强制升级校验",
      );
      return null;
    }
    // 预留离线跳过接口：完全离线时先不拉闸，后续可在这里接入显式 offline bypass 策略。
    options.logger.warn("[force-update] 读取远端强制升级配置失败，跳过强制升级校验", { error });
    return null;
  }

  const requirement = resolveForceUpdateRequirement({
    currentVersion: ROBINDONE_VERSION,
    forceUpdate: { minimalVersion: config.minimalVersion ?? "" },
  });
  if (!requirement) {
    return null;
  }
  return { ...requirement, ...(config.downloadUrl ? { downloadUrl: config.downloadUrl } : {}) };
}

export function formatForceUpdateDialogText(
  requirement: ForceUpdateRequirement,
  locale: Locale,
): ForceUpdateDialogText {
  if (locale === "zh-CN") {
    return {
      title: "需要升级 RobinDone",
      message: "当前版本无法继续使用",
      detail: `当前版本：v${requirement.currentVersion}\n最低可用版本：v${requirement.minimalVersion}`,
      autoUpdateButton: "自动升级",
      manualUpdateButton: "手动升级",
      quitButton: "退出",
    };
  }

  return {
    title: "Update RobinDone",
    message: "The current version can no longer be used",
    detail: `Current version: v${requirement.currentVersion}\nMinimum supported version: v${requirement.minimalVersion}`,
    autoUpdateButton: "Auto update",
    manualUpdateButton: "Manual update",
    quitButton: "Quit",
  };
}

export async function maybeBlockStartupForForceUpdate(
  options: ForceUpdateGuardOptions,
): Promise<ForceUpdateGuardResult> {
  const requirement = await resolveDesktopForceUpdateRequirement(options);
  if (!requirement) {
    return { blocked: false };
  }

  options.logger.warn("[force-update] 远端配置要求强制升级，阻止创建主窗口", requirement);
  options.onBlocked?.(requirement);
  const { app, shell } = await import("electron");
  const action = await showForceUpdatePrompt(
    formatForceUpdateDialogText(requirement, options.locale),
    options.locale,
    options.logger,
    {
      startAutoUpdate: (onStateChange) =>
        options.requestAutoUpdate?.(onStateChange) ??
        requestForceAutoUpdate(onStateChange, "force-update", requirement.minimalVersion),
    },
  );
  if (action === "auto") {
    return { blocked: true, requirement };
  }

  if (action === "manual") {
    if (!requirement.downloadUrl) {
      // 静态强更配置未下发下载页地址时手动升级不可用；守卫语义不变（阻止进入主界面）。
      options.logger.warn(
        "[force-update] 用户选择手动升级，但强更配置未提供 downloadUrl，跳过跳转",
      );
    } else {
      options.logger.info(`[force-update] 用户选择手动升级：${requirement.downloadUrl}`);
      await shell.openExternal(requirement.downloadUrl);
    }
  }

  // 强制升级命中后不能进入主界面；非自动升级路径处理完弹窗后退出，避免露出旧客户端功能。
  app.quit();
  return { blocked: true, requirement };
}
