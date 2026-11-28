import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  triggerBrowserRuntimeStateFileName,
  triggerBrowserRuntimeStateSchema,
  type TriggerBrowserRuntimeStateFile,
} from "@robindone/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";

/**
 * 引擎托管浏览器供给层（2026-11-25 引擎托管浏览器裁决，specs/trigger-browser-hosting.md §3.1；
 * 镜像 python-runtime.ts 的"钉死版本 + 缓存 + 镜像 env + 状态文件 + 系统回退"模式）。
 *
 * 与 python 运行时的差异：
 * - 下载源用 @puppeteer/browsers（desktop 已有同款依赖）而非手动 tar 解压——它负责
 *   buildId 解析、平台 triple、解压与可执行位；我们只提供缓存目录与回退探测。
 * - 系统 Chrome 回退探测顺序对齐 CLI adapters executable.ts（显式 env → 常见安装路径）。
 *
 * 本文件只做"可执行文件解析 + 可用性状态落盘"；实例生命周期（spawn/CDP/队列）在
 * browser-host.ts。网络下载失败不抛——落 unavailable 状态文件并返回 {ok:false}，调用方
 * （浏览器实例 acquire、ManageTriggers 门控）按它降级。
 */

const logger = createServiceLogger("trigger-engine-browser-runtime");

/**
 * 钉死的 chromium 版本（@puppeteer/browsers 的 buildId 解析基准）。
 * 升级 = 换常量 + 缓存目录自然切换（旧目录不自动删，同 python-runtime 惯例）。
 */
export const BROWSER_BUILD_ID = "chrome.143.0.7490.0" as const;

/** 缓存根（~/.robindone/runtimes/browsers/；ROBINDONE_DESKTOP_HOME_DIR 惯例对齐 python-runtime）。 */
export function browserRuntimeCacheRoot(): string {
  const home = process.env.ROBINDONE_DESKTOP_HOME_DIR ?? homedir();
  return join(home, ".robindone", "runtimes", "browsers");
}

/** 镜像 base URL（占位替换下载路径）；默认官方源 googleapis——国内直连大文件常龟速/停滞。 */
export const BROWSER_DOWNLOAD_BASEURL_ENV = "ROBINDONE_BROWSER_DOWNLOAD_BASEURL";
/** 国内镜像（npmmirror 的 chrome-for-testing，路径布局与官方一致，2026-11-25 实测 200 OK）。 */
export const BROWSER_DOWNLOAD_MIRROR_HINT = "https://cdn.npmmirror.com/binaries/chrome-for-testing";
/** 下载总超时：超时按失败收口回退系统 Chrome，不让 open_login 无限悬挂（2026-11-25
 * 真机教训：默认源龟速下载 170MB，无超时则窗口永不弹出且日志一片死寂）。 */
const DOWNLOAD_TOTAL_TIMEOUT_MS = 10 * 60_000;
/** 下载进度日志步长（每 ~16MB 一条，避免刷屏）。 */
const DOWNLOAD_PROGRESS_LOG_STEP_BYTES = 16 * 1024 * 1024;

interface BrowserResolution {
  ok: true;
  executablePath: string;
  source: "managed" | "system";
}

export interface BrowserRuntimePortOptions {
  log?(message: string): void;
  /**
   * 测试钩子：注入 @puppeteer/browsers 的 install（下载+解压）实现。缺省 = 动态 import
   * 真实包（services 未硬依赖它——桌面安装包裁剪场景下载失败落 unavailable，不阻塞引擎）。
   */
  installBrowser?(params: {
    buildId: string;
    cacheDir: string;
    baseUrl?: string;
    onProgress?: (downloadedBytes: number, totalBytes: number) => void;
  }): Promise<{ executablePath: string }>;
}

/** 系统 Chrome 探测（对齐 CLI adapters executable.ts 的常见安装路径顺序）。 */
function systemChromeCandidates(): string[] {
  if (process.platform === "win32") {
    const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"] ?? "";
    return [
      process.env.ROBINDONE_CHROME_EXECUTABLE ?? "",
      join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    ].filter((candidate) => candidate.length > 0);
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  return [
    process.env.ROBINDONE_CHROME_EXECUTABLE ?? "",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((candidate) => candidate.length > 0);
}

function firstExisting(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // 探测失败继续下一个（权限/路径异常不阻塞回退链）。
    }
  }
  return undefined;
}

async function defaultInstallBrowser(params: {
  buildId: string;
  cacheDir: string;
  baseUrl?: string;
  onProgress?: (downloadedBytes: number, totalBytes: number) => void;
}): Promise<{ executablePath: string }> {
  // 动态 import：@puppeteer/browsers 在 services 是可选能力（未装/裁剪 = 走系统回退）。
  // 经 unknown 中转收敛宽类型（InstallOptions 联合签名与 Record 不重叠）。
  const browsers = (await import("@puppeteer/browsers")) as unknown as {
    install: (options: {
      browser: string;
      buildId: string;
      cacheDir: string;
      baseUrl?: string;
      downloadProgressCallback?: (downloadedBytes: number, totalBytes: number) => void;
    }) => Promise<{ executablePath: string }>;
    Browser: { CHROME: string };
    detectBrowserPlatform: () => string;
    resolveBuildId: (browser: string, platform: string, tag: string) => Promise<string>;
  };
  const platform = browsers.detectBrowserPlatform();
  // buildId 常量是"版本号"形态（chrome.<semver>）；resolveBuildId 把它折算成真实下载 buildId。
  const buildId = await browsers.resolveBuildId(
    browsers.Browser.CHROME,
    platform,
    BROWSER_BUILD_ID.replace(/^chrome\./, ""),
  );
  const result = await browsers.install({
    browser: browsers.Browser.CHROME,
    buildId,
    cacheDir: params.cacheDir,
    ...(params.baseUrl !== undefined ? { baseUrl: params.baseUrl } : {}),
    ...(params.onProgress !== undefined ? { downloadProgressCallback: params.onProgress } : {}),
  });
  return { executablePath: result.executablePath };
}

export interface TriggerBrowserRuntimePort {
  /**
   * 解析可用浏览器可执行文件并落状态文件。缓存命中/系统回退/下载三段式：
   * 1) 缓存目录已有完成标记 → 直接复用；2) 下载失败/不可用 → 系统 Chrome 探测；
   * 3) 全失败 → {ok:false} + unavailable 状态落盘。每次调用都重写状态文件（挂载即
   * fire-and-forget 预热 + spawn 前按需，与 python-runtime 同款调用约定）。
   */
  ensureBrowser(workspacePath: string): Promise<BrowserResolution | { ok: false; error: string }>;
}

export function createTriggerBrowserRuntimePort(
  options: BrowserRuntimePortOptions = {},
): TriggerBrowserRuntimePort {
  const log = options.log ?? ((message: string) => void logger.info(message));
  const install = options.installBrowser ?? defaultInstallBrowser;
  /** 进程级缓存：本进程内解析成功即不再重复下载（缓存目录以文件系统为准，机器全局）。 */
  let cached: BrowserResolution | undefined;
  /** 在途下载（跨工作区去重）：多项目挂载预热并发触发时共享同一份下载。 */
  let inflight: Promise<BrowserResolution | { ok: false; error: string }> | undefined;

  // 下载（含超时 race / 系统回退 / 半截清理）。只在无缓存且无在途时触发一次，
  // 结果给所有并发等待者共用；每工作区的状态文件由 ensureBrowser 调用方各自补写。
  const downloadOnce = async (): Promise<BrowserResolution | { ok: false; error: string }> => {
    const cacheDir = join(browserRuntimeCacheRoot(), BROWSER_BUILD_ID);
    try {
      log(
        `managed browser download started (chromium ${BROWSER_BUILD_ID}, ~170MB). If slow or stuck, set ${BROWSER_DOWNLOAD_BASEURL_ENV}=${BROWSER_DOWNLOAD_MIRROR_HINT}`,
      );
      let lastLoggedBytes = 0;
      const installPromise = install({
        buildId: BROWSER_BUILD_ID.replace(/^chrome\./, ""),
        cacheDir,
        baseUrl: process.env[BROWSER_DOWNLOAD_BASEURL_ENV],
        onProgress: (downloadedBytes, totalBytes) => {
          if (downloadedBytes - lastLoggedBytes >= DOWNLOAD_PROGRESS_LOG_STEP_BYTES) {
            lastLoggedBytes = downloadedBytes;
            log(
              `managed browser download progress: ${Math.round(downloadedBytes / 1e6)}MB / ${Math.round(totalBytes / 1e6)}MB`,
            );
          }
        },
      });
      // 总超时 race：@puppeteer/browsers 2.13.0 的 install 无内置 timeout，慢源下载可
      // 无限悬挂。超时按失败收口（回退系统 Chrome，窗口照弹）；输掉 race 的下载继续在
      // 后台跑——必须挂 catch 吞掉迟到 rejection（否则 unhandled rejection 会崩掉 host），
      // 若它最终完成，下次引擎启动 install() 会按缓存直接命中。
      const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `download exceeded ${Math.round(DOWNLOAD_TOTAL_TIMEOUT_MS / 60_000)} min total timeout`,
            ),
          );
        }, DOWNLOAD_TOTAL_TIMEOUT_MS);
        timer.unref?.();
      });
      const installed = await Promise.race([installPromise, timeout]);
      void installPromise.catch(() => undefined); // 输掉 race 的迟到 rejection 不上抛
      log(`managed browser ready: ${BROWSER_BUILD_ID}`);
      return { ok: true, executablePath: installed.executablePath, source: "managed" };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // 半截下载清理（部分 zip/解压残留会让下次 install 的缓存判定混乱）；成功路径不清理
      // ——cacheDir 里是装好的浏览器本体。
      await rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
      const systemPath = firstExisting(systemChromeCandidates());
      if (systemPath !== undefined) {
        log(
          `managed browser download failed, falling back to system Chrome: ${reason}. For the pinned chromium set ${BROWSER_DOWNLOAD_BASEURL_ENV}=${BROWSER_DOWNLOAD_MIRROR_HINT}`,
        );
        return { ok: true, executablePath: systemPath, source: "system" };
      }
      log(`browser runtime unavailable: ${reason}`);
      return {
        ok: false,
        error: `managed browser download failed (${reason}) and no system Chrome found`,
      };
    }
  };

  return {
    async ensureBrowser(workspacePath) {
      if (cached !== undefined) {
        await writeBrowserRuntimeState(workspacePath, {
          state: "available",
          executablePath: cached.executablePath,
          source: cached.source,
        });
        return cached;
      }
      // 并发去重（2026-11-25 真机缺口）：引擎挂载全部项目、每工作区预热一次
      // ensureBrowser——不去重则首次下载被并发触发 N 次，同一 zip 拉 N 遍且并发写
      // 同一路径可能互踩。后来者 await 同一份在途 promise，状态文件各自补写。
      if (inflight === undefined) {
        inflight = downloadOnce();
      }
      const resolution = await inflight;
      if (resolution.ok) {
        cached = resolution;
        await writeBrowserRuntimeState(workspacePath, {
          state: "available",
          executablePath: resolution.executablePath,
          source: resolution.source,
        });
        return resolution;
      }
      await writeBrowserRuntimeState(workspacePath, {
        state: "unavailable",
        error: resolution.error,
      }).catch(() => undefined);
      return resolution;
    },
  };
}

// ---------------------------------------------------------------------------
// 可用性状态文件（引擎写、CLI 读；ManageTriggers 门控 profile 字段的事实源）
// ---------------------------------------------------------------------------

/** 引擎侧读状态（解析失败/缺失 → undefined）。 */
export async function readBrowserRuntimeState(
  workspacePath: string,
): Promise<TriggerBrowserRuntimeStateFile | undefined> {
  try {
    const raw = await readFile(browserRuntimeStatePath(workspacePath), "utf8");
    const parsed = triggerBrowserRuntimeStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function writeBrowserRuntimeState(
  workspacePath: string,
  state: Omit<TriggerBrowserRuntimeStateFile, "version" | "updatedAt">,
): Promise<void> {
  const file = browserRuntimeStatePath(workspacePath);
  const payload = {
    version: 1 as const,
    updatedAt: new Date().toISOString(),
    ...state,
  } satisfies TriggerBrowserRuntimeStateFile;
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp.${process.pid}`;
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

function browserRuntimeStatePath(workspacePath: string): string {
  return join(workspacePath, ".robindone", "triggers", "state", triggerBrowserRuntimeStateFileName);
}
