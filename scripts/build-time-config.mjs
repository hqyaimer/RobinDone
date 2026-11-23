import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * 桌面构建期可选能力的唯一解析入口：ARMS RUM 上报、事件上报、自动更新。
 * 优先级：构建进程环境变量 > config/private/build-defaults.json（仅内部仓库存在）> 关闭。
 * 规则见 docs/desktop/build-time-optional-capabilities.md。
 *
 * 2026-11-23 发布工程扩展（RobinRun 自有发布链，见 docs/desktop/robinrun-release-updates.md）：
 * - ROBINRUN_UPDATE_FEED_BASE：静态更新源 base（如 GitHub raw 的 updates 分支目录）。
 *   非空时打包态更新器改走 "{base}/{releasePlatform}/latest.yml" 静态清单，不再请求上游
 *   manifest API（该 API 是上游 SaaS，会把 ZCode 官方安装包推给 RobinRun 用户）；
 *   为空时保持既有 manifest API 行为，历史流程不受影响。
 * - ROBINRUN_MAC_AUTO_UPDATE：macOS 自动更新准入开关。macOS 的更新安装（Squirrel.Mac）
 *   强制要求应用持有 Developer ID 签名；未签名构建必须关闭自动更新（点击安装必然失败），
 *   新版本走"提示 + 手动下载"。
 */
export const PRIVATE_BUILD_DEFAULTS_PATH = resolve(
  import.meta.dirname,
  "../config/private/build-defaults.json",
);

const ENABLED_VALUES = new Set(["1", "true", "yes"]);

async function readPrivateDefaults(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`构建期私有默认配置必须是 JSON 对象：${path}`);
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function pickValue(env, defaults, key) {
  // 环境变量显式设置（包括空字符串）时优先，空字符串表示关闭该项能力
  if (typeof env[key] === "string") return env[key].trim();
  const value = defaults[key];
  return typeof value === "string" ? value.trim() : "";
}

export async function resolveBuildTimeConfig(
  env = process.env,
  { defaultsPath = PRIVATE_BUILD_DEFAULTS_PATH } = {},
) {
  const defaults = await readPrivateDefaults(defaultsPath);
  return {
    armsRumEndpoint: pickValue(env, defaults, "ROBINRUN_ARMS_RUM_ENDPOINT"),
    telemetryReportEndpoint: pickValue(env, defaults, "ROBINRUN_TELEMETRY_REPORT_ENDPOINT"),
    autoUpdateEnabled: ENABLED_VALUES.has(
      pickValue(env, defaults, "ROBINRUN_AUTO_UPDATE").toLowerCase(),
    ),
    updateFeedBase: pickValue(env, defaults, "ROBINRUN_UPDATE_FEED_BASE"),
    macAutoUpdateReady: ENABLED_VALUES.has(
      pickValue(env, defaults, "ROBINRUN_MAC_AUTO_UPDATE").toLowerCase(),
    ),
  };
}

export function createBuildTimeConfigDefines(config) {
  return {
    __ROBINRUN_ARMS_RUM_ENDPOINT__: JSON.stringify(config.armsRumEndpoint),
    __ROBINRUN_TELEMETRY_REPORT_ENDPOINT__: JSON.stringify(config.telemetryReportEndpoint),
    __ROBINRUN_AUTO_UPDATE_ENABLED__: JSON.stringify(config.autoUpdateEnabled),
    __ROBINRUN_UPDATE_FEED_BASE__: JSON.stringify(config.updateFeedBase),
    __ROBINRUN_MAC_AUTO_UPDATE_READY__: JSON.stringify(config.macAutoUpdateReady),
  };
}
