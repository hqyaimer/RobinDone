import type { RobinDoneRuntimeEnv } from "./runtimeEnv.js";

export type RobinDoneEnv = "test" | "production";
/** 安装包身份：决定应用名、app id、Electron 数据目录与更新策略；与后端环境 `RobinDoneEnv` 是两个轴。 */
export type RobinDoneProductFlavor = "production" | "preview";
export type ArmsRumEnv = "local" | "prod";

// 非构建环境（如 e2e 测试的 mocha）下 define 不存在，用 typeof 检查 + fallback 避免 ReferenceError
declare const __ROBINDONE_ENV__: string;
declare const __ROBINDONE_PRODUCT_FLAVOR__: string;
declare const __ROBINDONE_ARMS_RUM_ENDPOINT__: string;
declare const __ROBINDONE_TELEMETRY_REPORT_ENDPOINT__: string;
declare const __ROBINDONE_AUTO_UPDATE_ENABLED__: boolean;
declare const __ROBINDONE_UPDATE_FEED_BASE__: string;
declare const __ROBINDONE_MAC_AUTO_UPDATE_READY__: boolean;

export function normalizeRobinDoneEnv(value: string | undefined): RobinDoneEnv {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

export const ROBINDONE_ENV = normalizeRobinDoneEnv(
  typeof __ROBINDONE_ENV__ !== "undefined" ? __ROBINDONE_ENV__ : undefined,
);

/**
 * 身份缺省跟随后端环境（test → preview，production → production）。
 * 桌面构建通过 `ROBINDONE_PREVIEW_IDENTITY=1` 显式注入 preview，得到连接生产后端的 Preview 包；
 * 未注入 define 的 bundle（web、CLI、测试）沿用旧的单轴语义。
 */
export function normalizeRobinDoneProductFlavor(
  value: string | undefined,
  robindoneEnv: RobinDoneEnv,
): RobinDoneProductFlavor {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "production" || normalized === "preview") {
    return normalized;
  }
  return robindoneEnv === "production" ? "production" : "preview";
}

export const ROBINDONE_PRODUCT_FLAVOR = normalizeRobinDoneProductFlavor(
  typeof __ROBINDONE_PRODUCT_FLAVOR__ !== "undefined" ? __ROBINDONE_PRODUCT_FLAVOR__ : undefined,
  ROBINDONE_ENV,
);
export const ROBINDONE_APP_VERSION_ENV = "ROBINDONE_APP_VERSION" as const;
export const ROBINDONE_BUILD_COMMIT_ID_ENV = "ROBINDONE_BUILD_COMMIT_ID" as const;

// ── 运行时环境变量（不经过编译打包，启动时从 process.env 读取） ──
// 启用调试模式，值为 inspect-brk 的端口号，如 ROBINDONE_DEBUG=9230
export const RUNTIME_ROBINDONE_DEBUG =
  typeof process !== "undefined" ? process.env.ROBINDONE_DEBUG : undefined;

// ── 构建期可选能力（见 docs/desktop/build-time-optional-capabilities.md），未注入时一律关闭 ──
/** ARMS RUM 上报地址；为空时 SDK 以 enable=false 初始化，不产生上报。 */
export const ROBINDONE_ARMS_RUM_ENDPOINT: string =
  typeof __ROBINDONE_ARMS_RUM_ENDPOINT__ !== "undefined" ? __ROBINDONE_ARMS_RUM_ENDPOINT__ : "";
/** 事件上报（数仓）地址；为空时不上报。 */
export const ROBINDONE_TELEMETRY_REPORT_ENDPOINT: string =
  typeof __ROBINDONE_TELEMETRY_REPORT_ENDPOINT__ !== "undefined"
    ? __ROBINDONE_TELEMETRY_REPORT_ENDPOINT__
    : "";
/** 桌面自动更新是否启用。 */
export const ROBINDONE_AUTO_UPDATE_ENABLED: boolean =
  typeof __ROBINDONE_AUTO_UPDATE_ENABLED__ !== "undefined"
    ? __ROBINDONE_AUTO_UPDATE_ENABLED__
    : false;
/**
 * 静态更新源 base（RobinDone 发布工程，见 docs/desktop/robindone-release-updates.md）。
 * 非空时打包态更新器请求 "{base}/{releasePlatform}/latest.yml" 静态清单；
 * 为空时保持既有服务端 manifest API 行为。这是构建期钉死的信任源：
 * 与调试态 --update-feed-url 不同，它随安装包发布，不受启动参数/环境变量接管。
 */
export const ROBINDONE_UPDATE_FEED_BASE: string =
  typeof __ROBINDONE_UPDATE_FEED_BASE__ !== "undefined" ? __ROBINDONE_UPDATE_FEED_BASE__ : "";
/**
 * macOS 自动更新准入（构建期开关）。macOS 更新安装（Squirrel.Mac）强制要求 Developer ID
 * 签名；未签名 mac 构建必须置 false 关闭自动更新，否则用户点击安装必然失败。
 */
export const ROBINDONE_MAC_AUTO_UPDATE_READY: boolean =
  typeof __ROBINDONE_MAC_AUTO_UPDATE_READY__ !== "undefined"
    ? __ROBINDONE_MAC_AUTO_UPDATE_READY__
    : false;

/** 将本地运行态与编译期 ROBINDONE_ENV 映射为 ARMS 控制台识别的上报环境标签 */
export function mapRobinDoneEnvToArmsRumEnv(runtimeEnv: RobinDoneRuntimeEnv): ArmsRumEnv {
  return runtimeEnv !== "development" && ROBINDONE_ENV === "production" ? "prod" : "local";
}
