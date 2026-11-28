import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { get as httpGet, type IncomingMessage } from "node:http";
import { get as httpsGet } from "node:https";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  pythonRuntimeStateSchema,
  triggerPythonRuntimeStateFileName,
  TRIGGER_PYTHON_RUNTIME_STATE_VERSION,
  type PythonRuntimeSource,
  type PythonRuntimeStateFile,
} from "@robindone/shared";
import { getRobinDoneDataRootDir } from "#src/paths.js";
import { probeCommand } from "./script-runner.js";
import {
  PYTHON_RELEASE_BASE_URL,
  PYTHON_RELEASE_TAG,
  PYTHON_RUNTIME_ASSETS,
  PYTHON_RUNTIME_ID,
  resolvePythonHostTriple,
} from "./python-runtime-assets.mjs";
import {
  appendPythonPackages,
  defaultCommandRunner,
  ensureProjectVenv,
  runPipInstall,
  type CommandRunner,
  type VenvEnsureResult,
} from "./python-env.js";

/**
 * python 主运行时供给（2026-11-22 python 主 + node 备选改造，docs/trigger-python-runtime.md
 * §3.1/§4a）。
 *
 * - 解释器供给三级优先（2026-11-26 打包内置改造）：
 *   1) **随包内置**（打包桌面端 `resources/runtimes/python/<版本标识>/`，构建期由
 *      prepare:python-runtime 按 sha256 预置；开发态对应 bundled-tools staging 目录）；
 *   2) **缓存复用/自动下载**（python-build-standalone install_only，零预装）：版本与
 *      六平台下载 URL + sha256 **钉死在代码**（python-runtime-assets.mjs 单一来源；
 *      确定性、可审计；不从运行时拉 SHA256SUMS）。
 * - 缓存 `~/.robindone/runtimes/python/<版本标识>/`（全局共享跨项目）；下载 → 校验 →
 *   解压（系统 tar，Windows 走 System32 bsdtar 绝对路径）→ 原子 rename → 完成标记，
 *   标记在场即复用（不重复下载）。
 * - 镜像：`ROBINDONE_PYTHON_RUNTIME_MIRROR`（URL 模板，`{asset}` 占位符或基址前缀），
 *   配置时镜像优先、官方 GitHub 兜底；每源重试 `DOWNLOAD_ATTEMPTS_PER_URL` 次。
 *   下载失败按「python 不可用」收口（node 备选），由引擎写 `state/python-runtime.json`
 *   供 CLI 门控与提示词双模式。下载字节进度经 onDownloadProgress 回调上抛
 *   （desktop host 接 broadcastService 推 UI）。
 * - 系统回退：`ROBINDONE_PYTHON_FALLBACK_SYSTEM=1` 时托管获取失败可回退系统 PATH
 *   python3/python（服务离线自救；venv 模块缺失的报错带指引，见 python-env.ts）。
 * - 不支持 HTTPS_PROXY 代理隧道（镜像是有意提供的过墙通道；需要代理时用镜像 env）。
 */

// ---------------------------------------------------------------------------
// 版本与资产（单一来源 = python-runtime-assets.mjs；升版 = 换常量，缓存目录随版本标识切换，旧目录不自动删）
// ---------------------------------------------------------------------------

/** 版本标识 = 缓存目录名；升版即换目录（单一来源见 python-runtime-assets.mjs）。 */
export { PYTHON_RUNTIME_ID };
/** 环境变量：镜像 URL 模板（`{asset}` 占位符替换资产文件名；无占位符则按 `<base>/<tag>/<archive>` 拼接）。 */
export const PYTHON_RUNTIME_MIRROR_ENV = "ROBINDONE_PYTHON_RUNTIME_MIRROR";
/** 环境变量：托管获取失败时回退系统 PATH python（默认关闭，确定性优先）。 */
export const PYTHON_FALLBACK_SYSTEM_ENV = "ROBINDONE_PYTHON_FALLBACK_SYSTEM";

type HostTriple = keyof typeof PYTHON_RUNTIME_ASSETS;

export interface HostAsset {
  triple: HostTriple;
  archive: string;
  sha256: string;
}

function resolveHostAsset(): HostAsset | undefined {
  const triple = resolvePythonHostTriple(process.platform, process.arch);
  if (triple === undefined) return undefined;
  const asset = PYTHON_RUNTIME_ASSETS[triple];
  return { triple, archive: asset.archive, sha256: asset.sha256 };
}

/** 托管解释器缓存根（`~/.robindone/runtimes/python/`；数据根同风格，测试可注入覆盖）。 */
export function pythonRuntimeCacheRoot(): string {
  return join(getRobinDoneDataRootDir(), "runtimes", "python");
}

// ---------------------------------------------------------------------------
// 下载 / 校验 / 解压
// ---------------------------------------------------------------------------

const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const DOWNLOAD_MAX_REDIRECTS = 5;
/** 每个下载源的尝试次数（2026-11-26 补：弱网断连从「整包失败」降为「换源/重试前先重试」）。 */
const DOWNLOAD_ATTEMPTS_PER_URL = 2;
const EXTRACT_TIMEOUT_MS = 10 * 60_000;
const COMPLETE_MARKER_FILE = ".robindone-complete";

export interface PythonDownloadProgress {
  url: string;
  downloadedBytes: number;
  /** 响应未带 content-length（chunked 等）时为 null。 */
  totalBytes: number | null;
}

/** 镜像 env 模板解析：含 `{asset}` 占位符则替换；否则按 `<mirror>/<tag>/<archive>` 拼。 */
function buildDownloadUrls(asset: HostAsset): string[] {
  const official = `${PYTHON_RELEASE_BASE_URL}/${asset.archive}`;
  const mirror = process.env[PYTHON_RUNTIME_MIRROR_ENV]?.trim();
  if (mirror === undefined || mirror.length === 0) return [official];
  const templated = mirror.includes("{asset}")
    ? mirror.replace("{asset}", asset.archive)
    : `${mirror.replace(/\/+$/, "")}/${PYTHON_RELEASE_TAG}/${asset.archive}`;
  // 镜像优先（国内过墙主通道），官方兜底。
  return [templated, official];
}

/**
 * 下载到本地文件（重定向跟随、整体超时、字节进度回调）。注意：node https 不走
 * HTTPS_PROXY 环境变量，本模块有意不实现代理隧道——过墙场景用镜像 env。
 */
function downloadToFile(
  url: string,
  destPath: string,
  onProgress?: (progress: PythonDownloadProgress) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleResponse = (target: string, response: IncomingMessage, redirectsLeft: number) => {
      const location = response.headers.location;
      if (
        response.statusCode !== undefined &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        typeof location === "string"
      ) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`too many redirects downloading ${target}`));
          return;
        }
        attempt(new URL(location, target).toString(), redirectsLeft - 1);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode} for ${target}`));
        return;
      }
      const contentLengthHeader = response.headers["content-length"];
      const totalBytes =
        typeof contentLengthHeader === "string" && Number.isFinite(Number(contentLengthHeader))
          ? Number(contentLengthHeader)
          : null;
      let downloadedBytes = 0;
      const file = createWriteStream(destPath);
      // 字节进度：chunk 累加后上抛；节流由调用方负责（端口层按步长截流）。
      response.on("data", (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        onProgress?.({ url: target, downloadedBytes, totalBytes });
      });
      response.pipe(file);
      file.on("error", reject);
      file.on("close", () => {
        if (response.complete) resolve();
        else reject(new Error(`download incomplete for ${target}`));
      });
    };
    const attempt = (target: string, redirectsLeft: number): void => {
      // 按协议选传输层：官方与公网镜像是 https；内网/本地镜像（测试 fixture）可能是 http。
      const transport = target.startsWith("http:") ? httpGet : httpsGet;
      const request = transport(target, { headers: { "user-agent": "RobinDone" } }, (response) => {
        handleResponse(target, response, redirectsLeft);
      });
      request.on("error", reject);
      const timer = setTimeout(() => {
        request.destroy(new Error(`download timed out after ${DOWNLOAD_TIMEOUT_MS / 60_000} min`));
      }, DOWNLOAD_TIMEOUT_MS);
      timer.unref?.();
      request.on("close", () => clearTimeout(timer));
    };
    attempt(url, DOWNLOAD_MAX_REDIRECTS);
  });
}

async function verifySha256(path: string, expected: string): Promise<void> {
  const hash = createHash("sha256");
  const handle = createReadStream(path);
  await new Promise<void>((resolve, reject) => {
    handle.on("data", (chunk: Buffer) => hash.update(chunk));
    handle.on("error", reject);
    handle.on("close", resolve);
  });
  const actual = hash.digest("hex");
  if (actual !== expected) {
    throw new Error(`sha256 mismatch for ${path}: expected ${expected}, got ${actual}`);
  }
}

/** 解 tar.gz：Windows 用 System32 bsdtar 绝对路径（PATH 里的 GNU tar 会把 `E:/...` 当远程主机，
 * AGENTS.md 实测坑；Win10 1803+ 自带 bsdtar），POSIX 用 tar。 */
async function extractTarGz(
  archivePath: string,
  destDir: string,
  run: CommandRunner,
): Promise<void> {
  const command = await resolveTarCommand();
  const result = await run({
    command,
    args: ["-xzf", archivePath, "-C", destDir],
    timeoutMs: EXTRACT_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    throw new Error(
      `tar extract failed (code ${result.code}): ${(result.stderrTail || result.stdoutTail).trim() || "no output"}`,
    );
  }
}

async function resolveTarCommand(): Promise<string> {
  if (process.platform === "win32") {
    const systemTar = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe`;
    try {
      await stat(systemTar);
      return systemTar;
    } catch {
      return "tar";
    }
  }
  return "tar";
}

// ---------------------------------------------------------------------------
// 随包内置解释器（2026-11-26 打包内置）：packaged = resources/runtimes/python/<id>，
// dev = desktop bundled-tools staging。缺失（未跑 prepare / 绿色裁剪 / 非 Electron 宿主）
// 返回 undefined，自然落到缓存/下载路径。
// ---------------------------------------------------------------------------

function bundledPythonRuntimeCandidates(): string[] {
  const platformKey = `${process.platform}-${process.arch}`;
  const candidates: string[] = [];
  // Electron（含 utility host）进程独有；web server / CLI 宿主没有该字段。
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (typeof resourcesPath === "string" && resourcesPath.length > 0) {
    candidates.push(join(resourcesPath, "runtimes", "python", PYTHON_RUNTIME_ID));
  }
  // dev：desktop 打包 staging（dev 启动 cwd 可能是仓库根或 packages/desktop，
  // 多候选对齐 desktopRuntimeEnv 的 bundled-agents 解析，避免入口不同解析漂移）。
  candidates.push(join(process.cwd(), "bundled-tools", platformKey, "python", PYTHON_RUNTIME_ID));
  candidates.push(
    join(
      process.cwd(),
      "packages",
      "desktop",
      "bundled-tools",
      platformKey,
      "python",
      PYTHON_RUNTIME_ID,
    ),
  );
  return candidates;
}

function resolveBundledPythonRuntimeDir(): string | undefined {
  for (const candidate of bundledPythonRuntimeCandidates()) {
    try {
      if (existsSync(join(candidate, COMPLETE_MARKER_FILE))) return candidate;
    } catch {
      // 探测失败继续下一个（权限/路径异常不阻塞回退链）。
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// ensureManagedPythonRuntime（bundled 优先 / 缓存命中复用 / 下载解压原子落位）
// ---------------------------------------------------------------------------

export interface ManagedRuntimeInfo {
  interpreterPath: string;
  cacheDir: string;
}

function managedInterpreterPath(cacheDir: string): string {
  // python-build-standalone install_only 布局：tar 顶层 `python/` 目录被整体 rename 到
  // 缓存目录（cacheDir 即 python 根）——Windows 根有 python.exe，POSIX 为 bin/python3。
  return process.platform === "win32"
    ? join(cacheDir, "python.exe")
    : join(cacheDir, "bin", "python3");
}

/** 跨调用单飞：并发 ensure 共享同一次下载（引擎挂载与 spawn 路径可能同时触发）。 */
const inflightManaged = new Map<string, Promise<ManagedRuntimeInfo>>();

export async function ensureManagedPythonRuntime(params: {
  cacheRoot?: string;
  log(message: string): void;
  runCommand?: CommandRunner;
  /** 测试注入：覆盖平台资产（本地 HTTP fixture 的 archive/sha256；生产路径恒用钉死表）。 */
  assetOverride?: HostAsset;
  /** 测试注入：随包内置解释器目录（生产路径按 resourcesPath / dev staging 自解析）。 */
  bundledDir?: string;
  /** 下载字节进度回调（原始步频；节流由调用方负责）。 */
  onDownloadProgress?: (progress: PythonDownloadProgress) => void;
}): Promise<ManagedRuntimeInfo> {
  const cacheRoot = params.cacheRoot ?? pythonRuntimeCacheRoot();
  const asset = params.assetOverride ?? resolveHostAsset();
  if (asset === undefined) {
    throw new Error(
      `No managed python runtime asset for ${process.platform}/${process.arch} (${PYTHON_RUNTIME_ID})`,
    );
  }
  const finalDir = join(cacheRoot, PYTHON_RUNTIME_ID);
  const interpreterPath = managedInterpreterPath(finalDir);
  // 随包内置优先（开箱即用，免联网）：packaged/staging 目录标记 + 解释器齐备即整体
  // 复用，不复制进缓存目录（避免 ~100MB 双份磁盘占用）。venv 指纹只看 PYTHON_RUNTIME_ID、
  // 来源语义同为 managed，缓存版与内置版之间切换不触发 venv 重建。
  const bundledDir = params.bundledDir ?? resolveBundledPythonRuntimeDir();
  const bundledInterpreterPath =
    bundledDir === undefined ? undefined : managedInterpreterPath(bundledDir);
  const bundledReady =
    bundledDir !== undefined &&
    bundledInterpreterPath !== undefined &&
    (await isComplete(bundledDir, bundledInterpreterPath));
  const inflightKey = bundledReady && bundledDir !== undefined ? bundledDir : finalDir;
  const existing = inflightManaged.get(inflightKey);
  if (existing !== undefined) return existing;

  const task = (async (): Promise<ManagedRuntimeInfo> => {
    if (bundledReady && bundledDir !== undefined && bundledInterpreterPath !== undefined) {
      params.log(`using bundled python runtime: ${bundledDir}`);
      return { interpreterPath: bundledInterpreterPath, cacheDir: bundledDir };
    }
    if (await isComplete(finalDir, interpreterPath)) {
      return { interpreterPath, cacheDir: finalDir };
    }
    await mkdir(cacheRoot, { recursive: true });
    const staging = await mkdtemp(join(cacheRoot, ".staging-"));
    try {
      const archivePath = join(staging, asset.archive);
      const urls = buildDownloadUrls(asset);
      let lastError: Error | undefined;
      let downloaded = false;
      // 镜像优先、官方兜底；每源重试 DOWNLOAD_ATTEMPTS_PER_URL 次（弱网断连先重试
      // 再换源，避免镜像偶发抖动直接落到墙内更慢的官方源）。
      downloadUrls: for (const url of urls) {
        for (let attemptIndex = 1; attemptIndex <= DOWNLOAD_ATTEMPTS_PER_URL; attemptIndex += 1) {
          try {
            params.log(
              `downloading ${PYTHON_RUNTIME_ID} (${asset.triple}) from ${new URL(url).host}` +
                (attemptIndex > 1 ? ` (attempt ${attemptIndex}/${DOWNLOAD_ATTEMPTS_PER_URL})` : ""),
            );
            await downloadToFile(url, archivePath, params.onDownloadProgress);
            downloaded = true;
            break downloadUrls;
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            params.log(`download failed from ${url}: ${lastError.message}`);
          }
        }
      }
      if (!downloaded) {
        throw new Error(
          `failed to download ${PYTHON_RUNTIME_ID} from ${urls.length} source(s): ${lastError?.message ?? "unknown"}` +
            ` — set ${PYTHON_RUNTIME_MIRROR_ENV} (URL template with optional {asset} placeholder) if GitHub is unreachable`,
        );
      }
      await verifySha256(archivePath, asset.sha256);
      const extractDir = join(staging, "extracted");
      await mkdir(extractDir, { recursive: true });
      await extractTarGz(archivePath, extractDir, params.runCommand ?? defaultCommandRunner);
      const sourceDir = join(extractDir, "python");
      try {
        await stat(sourceDir);
      } catch {
        throw new Error(`unexpected archive layout: ${PYTHON_RUNTIME_ID} has no python/ top dir`);
      }
      // 原子落位：rename 同卷瞬时；残缺旧目录（有目录无标记）先清再落。
      await rm(finalDir, { recursive: true, force: true });
      await rename(sourceDir, finalDir);
      await writeFile(join(finalDir, COMPLETE_MARKER_FILE), `${PYTHON_RUNTIME_ID}\n`, "utf8");
      params.log(`managed python runtime ready: ${interpreterPath}`);
      return { interpreterPath, cacheDir: finalDir };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  })();
  inflightManaged.set(inflightKey, task);
  try {
    return await task;
  } finally {
    inflightManaged.delete(inflightKey);
  }
}

async function isComplete(cacheDir: string, interpreterPath: string): Promise<boolean> {
  try {
    await stat(join(cacheDir, COMPLETE_MARKER_FILE));
    await stat(interpreterPath);
    return true;
  } catch {
    return false;
  }
}

/** 系统 PATH 回退探测（python3 → python；复用 script-runner 的 spawn 探测）。 */
async function probeSystemPython(): Promise<string | undefined> {
  for (const candidate of ["python3", "python"] as const) {
    if (await probeCommand(candidate)) return candidate;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 可用性状态文件（引擎写、CLI 读；门控与提示词双模式的唯一事实源）
// ---------------------------------------------------------------------------

/** 引擎侧读状态（解析失败/缺失 → undefined；CLI 侧同款语义在 core handler）。 */
export async function readPythonRuntimeState(
  workspacePath: string,
): Promise<PythonRuntimeStateFile | undefined> {
  const file = pythonRuntimeStatePath(workspacePath);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = pythonRuntimeStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function writePythonRuntimeState(
  workspacePath: string,
  state: Omit<PythonRuntimeStateFile, "version">,
): Promise<PythonRuntimeStateFile> {
  const file = pythonRuntimeStatePath(workspacePath);
  const payload: PythonRuntimeStateFile = {
    version: TRIGGER_PYTHON_RUNTIME_STATE_VERSION,
    ...state,
  };
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp.${process.pid}`;
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(temp, file);
  return payload;
}

function pythonRuntimeStatePath(workspacePath: string): string {
  return join(workspacePath, ".robindone", "triggers", "state", triggerPythonRuntimeStateFileName);
}

// ---------------------------------------------------------------------------
// 引擎端口（可用性 ensure + venv ensure + install_packages；实现收敛在此，
// 引擎只依赖 contract.ts 的 TriggerPythonRuntimePort 接口）
// ---------------------------------------------------------------------------

export interface PythonInterpreterResolution {
  ok: true;
  interpreterPath: string;
  source: PythonRuntimeSource;
}

export interface PythonVenvResolution {
  ok: true;
  /** venv 解释器绝对路径（脚本执行体）。 */
  interpreterPath: string;
  venvDir: string;
  /** venv 重建重放的失败清单（空 = 正常）。 */
  replayFailures: string[];
}

export type PythonRuntimeResolution = PythonInterpreterResolution | { ok: false; error: string };

export interface PythonPackageInstallResult {
  ok: boolean;
  /** 成功时回显已安装的包 spec。 */
  packages?: string[];
  error?: string;
  /** pip 输出尾部（成功摘要/失败诊断）。 */
  outputTail?: string;
  /** venv 重建重放失败（安装本身成功但历史包缺失）。 */
  replayFailures?: string[];
}

export interface TriggerPythonRuntimePort {
  /** 解析生效解释器并落状态文件（挂载时 fire-and-forget / spawn 与安装前按需）。 */
  ensureInterpreter(workspacePath: string): Promise<PythonRuntimeResolution>;
  /** venv 就绪（含解释器 ensure；指纹失配自动重建 + 台账重放）。 */
  ensureVenv(workspacePath: string): Promise<PythonVenvResolution | { ok: false; error: string }>;
  /** pip 安装（含完整 ensure 链；引擎侧按工作区串行）。 */
  installPackages(workspacePath: string, packages: string[]): Promise<PythonPackageInstallResult>;
}

/**
 * python 运行时供给进度事件（2026-11-26）：host 侧接 broadcastService 推 UI
 * （设置页触发器分区状态卡）。payload 纯 JSON、可跨 IPC。
 */
export type PythonRuntimeProgressEvent =
  | { kind: "probing"; workspacePath: string }
  | {
      kind: "downloading";
      workspacePath: string;
      downloadedBytes: number;
      totalBytes: number | null;
    }
  | { kind: "available"; workspacePath: string; source: PythonRuntimeSource }
  | { kind: "unavailable"; workspacePath: string; error: string };

/** 下载进度事件上抛步长（1MiB）：原始 chunk 回调频率不可控，端口层统一截流。 */
const DOWNLOAD_PROGRESS_EMIT_STEP_BYTES = 1024 * 1024;

export interface TriggerPythonRuntimePortOptions {
  log(message: string): void;
  /** 测试注入：托管解释器缓存根（缺省 `~/.robindone/runtimes/python`）。 */
  cacheRoot?: string;
  /** 测试注入：命令执行器（venv/pip/tar 共用）。 */
  runCommand?: CommandRunner;
  /** 测试注入：覆盖平台资产（配合本地 HTTP fixture；生产路径恒用钉死表）。 */
  assetOverride?: HostAsset;
  /** 供给进度上抛（挂载预热/spawn 按需共用；事件节流在端口层完成）。 */
  onProgress?: (event: PythonRuntimeProgressEvent) => void;
}

export function createTriggerPythonRuntimePort(
  options: TriggerPythonRuntimePortOptions,
): TriggerPythonRuntimePort {
  const log = options.log;
  const emitProgress = (event: PythonRuntimeProgressEvent) => {
    try {
      options.onProgress?.(event);
    } catch {
      // 进度上抛失败不影响供给主链（订阅方异常不该打断下载/venv）。
    }
  };
  /** 工作区 → 已就绪解释器（成功后进程内缓存，避免重复读盘/探测）。 */
  const ready = new Map<string, PythonInterpreterResolution>();
  /** ensure 单飞（挂载与 spawn 同时触发的并发窗口）。 */
  const ensureChains = new Map<string, Promise<PythonRuntimeResolution>>();
  /** 安装按工作区串行（并发 pip 竞争同一 venv 会损坏状态）。 */
  const installChains = new Map<string, Promise<PythonPackageInstallResult>>();

  async function attemptEnsure(workspacePath: string): Promise<PythonRuntimeResolution> {
    // probing 落盘（CLI 门控把 probing 按「不可用」处理并区分文案）。
    await writePythonRuntimeState(workspacePath, {
      state: "probing",
      updatedAt: new Date().toISOString(),
    });
    emitProgress({ kind: "probing", workspacePath });
    // 下载字节进度按 1MiB 步长上抛（ensureManagedPythonRuntime 的回调是原始 chunk 频率）。
    let lastEmittedProgressBytes = 0;
    try {
      const managed = await ensureManagedPythonRuntime({
        ...(options.cacheRoot !== undefined ? { cacheRoot: options.cacheRoot } : {}),
        ...(options.assetOverride !== undefined ? { assetOverride: options.assetOverride } : {}),
        log,
        ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
        onDownloadProgress: (progress) => {
          if (
            progress.downloadedBytes - lastEmittedProgressBytes <
            DOWNLOAD_PROGRESS_EMIT_STEP_BYTES
          ) {
            return;
          }
          lastEmittedProgressBytes = progress.downloadedBytes;
          emitProgress({
            kind: "downloading",
            workspacePath,
            downloadedBytes: progress.downloadedBytes,
            totalBytes: progress.totalBytes,
          });
        },
      });
      const result: PythonInterpreterResolution = {
        ok: true,
        interpreterPath: managed.interpreterPath,
        source: "managed",
      };
      ready.set(workspacePath, result);
      await writePythonRuntimeState(workspacePath, {
        state: "available",
        interpreterPath: managed.interpreterPath,
        source: "managed",
        updatedAt: new Date().toISOString(),
      });
      emitProgress({ kind: "available", workspacePath, source: "managed" });
      return result;
    } catch (managedError) {
      const managedMessage =
        managedError instanceof Error ? managedError.message : String(managedError);
      if (process.env[PYTHON_FALLBACK_SYSTEM_ENV] === "1") {
        const system = await probeSystemPython();
        if (system !== undefined) {
          log(`managed python runtime failed; using system fallback: ${system}`);
          const result: PythonInterpreterResolution = {
            ok: true,
            interpreterPath: system,
            source: "system",
          };
          ready.set(workspacePath, result);
          await writePythonRuntimeState(workspacePath, {
            state: "available",
            interpreterPath: system,
            source: "system",
            updatedAt: new Date().toISOString(),
          });
          emitProgress({ kind: "available", workspacePath, source: "system" });
          return result;
        }
      }
      const fallbackHint =
        process.env[PYTHON_FALLBACK_SYSTEM_ENV] === "1"
          ? ""
          : ` Set ${PYTHON_FALLBACK_SYSTEM_ENV}=1 to try the system Python as a fallback.`;
      const errorMessage = managedMessage.slice(0, 1_000) + fallbackHint;
      await writePythonRuntimeState(workspacePath, {
        state: "unavailable",
        error: errorMessage,
        updatedAt: new Date().toISOString(),
      });
      emitProgress({ kind: "unavailable", workspacePath, error: errorMessage });
      return { ok: false, error: errorMessage };
    }
  }

  const ensureInterpreter = (workspacePath: string): Promise<PythonRuntimeResolution> => {
    const cached = ready.get(workspacePath);
    if (cached !== undefined) return Promise.resolve(cached);
    const inflight = ensureChains.get(workspacePath);
    if (inflight !== undefined) return inflight;
    const task = attemptEnsure(workspacePath).finally(() => {
      ensureChains.delete(workspacePath);
    });
    ensureChains.set(workspacePath, task);
    return task;
  };

  const ensureVenv = async (
    workspacePath: string,
  ): Promise<PythonVenvResolution | { ok: false; error: string }> => {
    const interpreter = await ensureInterpreter(workspacePath);
    if (!interpreter.ok) return { ok: false, error: interpreter.error };
    // 指纹 = 来源|解释器标识（版本在 PYTHON_RUNTIME_ID 内；系统回退用候选名）。
    const fingerprint =
      interpreter.source === "managed"
        ? `managed|${PYTHON_RUNTIME_ID}`
        : `system|${interpreter.interpreterPath}`;
    try {
      const venv: VenvEnsureResult = await ensureProjectVenv({
        workspacePath,
        interpreterPath: interpreter.interpreterPath,
        interpreterFingerprint: fingerprint,
        log,
        ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
      });
      return {
        ok: true,
        interpreterPath: venv.pythonPath,
        venvDir: venv.venvDir,
        replayFailures: venv.replayFailures,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const installPackages = (
    workspacePath: string,
    packages: string[],
  ): Promise<PythonPackageInstallResult> => {
    const inflight = installChains.get(workspacePath);
    if (inflight !== undefined) {
      // 同工作区并发安装请求：拒绝而非排队（pip 竞争同一 venv 会损坏状态；稍后重试）。
      return Promise.resolve({
        ok: false,
        error: "another install_packages is already running for this project; retry shortly",
      });
    }
    // 先落串行占位再建 promise：async 体内（首个 await 前）不能触碰 task 自身绑定
    // （const TDZ，2026-11-22 修复首版的 use-before-assign）。
    const task: Promise<PythonPackageInstallResult> = (async () => {
      try {
        const venv = await ensureVenv(workspacePath);
        if (!venv.ok) return { ok: false, error: venv.error };
        const pip = await runPipInstall({
          workspacePath,
          interpreterPath: venv.interpreterPath,
          packages,
          ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
        });
        if (!pip.ok) {
          return { ok: false, error: pip.error, outputTail: pip.outputTail };
        }
        await appendPythonPackages(workspacePath, packages);
        const result: PythonPackageInstallResult = {
          ok: true,
          packages,
          outputTail: pip.outputTail,
        };
        if (venv.replayFailures.length > 0) result.replayFailures = venv.replayFailures;
        return result;
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        installChains.delete(workspacePath);
      }
    })();
    installChains.set(workspacePath, task);
    return task;
  };

  return { ensureInterpreter, ensureVenv, installPackages };
}
