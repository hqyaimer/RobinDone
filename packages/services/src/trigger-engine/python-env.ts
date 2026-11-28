import { spawn } from "node:child_process";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  pythonPackagesLedgerSchema,
  triggerPythonEnvDirectoryName,
  triggerPythonPackagesFileName,
  type PythonPackagesLedger,
} from "@robindone/shared";

/**
 * 按项目 python venv 与三方包安装（2026-11-22 python 主运行时改造，
 * docs/trigger-python-runtime.md §3.2/§3.3）。
 *
 * - 一个项目一个 venv（`state/python-env/`，项目内所有 python 触发器脚本共用）；
 *   venv 是纯标准库产物（`python -m venv`），整目录删除重建安全。
 * - 复用判定：`runtime.json` 记录解释器指纹（来源|版本标识），缺失或不匹配
 *   （解释器升级/托管↔系统回退切换）→ 删旧建新，重建后按 `state/python-packages.json`
 *   台账重放安装（清单放 venv 目录外，重建不丢）。
 * - pip 安装是唯一的三方包入口（ManageTriggers install_packages → 引擎 → 本模块）；
 *   引擎不做任何隐式安装。index 用 ROBINDONE_PIP_INDEX_URL（默认官方 PyPI）。
 * - 命令执行器可注入（runCommand）：单测用假执行器验证编排逻辑，不必依赖真 python。
 */

/** pip 单次安装超时（分钟级网络操作；超时按进程树强杀）。 */
export const PIP_INSTALL_TIMEOUT_MS = 10 * 60_000;
/** venv 创建超时。 */
export const VENV_CREATE_TIMEOUT_MS = 5 * 60_000;

/** 台账容量上限（超出丢最旧条目；防失控增长，重放成本同步受限）。 */
const PACKAGES_LEDGER_MAX = 256;
/** 命令输出尾部截取（错误文案直出工具结果，不整段回灌）。 */
const OUTPUT_TAIL_CHARS = 8_000;

/** 跨进程树强杀（超时收口用）：Windows taskkill /T /F（连孙子进程）；POSIX 进程组 SIGKILL
 * → 单进程兜底。与 script-supervisor 的分层软停（SIGTERM→宽限→SIGKILL）不同，这里是
 * 一次性硬收口——pip/venv 命令没有优雅收尾语义。 */
export function killProcessTreeHard(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL"); // detached 负 pid = 进程组
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 进程已退出。
    }
  }
}

export interface CommandRunResult {
  code: number | null;
  stdoutTail: string;
  stderrTail: string;
  timedOut?: boolean;
}

/** 命令执行器（可注入；默认实现 = spawn + 超时树杀 + 输出尾部截取）。 */
export type CommandRunner = (params: {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}) => Promise<CommandRunResult>;

export const defaultCommandRunner: CommandRunner = (params) =>
  new Promise((resolve) => {
    let stdoutTail = "";
    let stderrTail = "";
    let settled = false;
    let child;
    try {
      child = spawn(params.command, params.args, {
        cwd: params.cwd,
        env: { ...process.env, ...params.env },
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        code: null,
        stdoutTail: "",
        stderrTail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const timer = setTimeout(() => {
      if (child.pid !== undefined) killProcessTreeHard(child.pid);
      settled = true;
      resolve({ code: null, stdoutTail, stderrTail, timedOut: true });
    }, params.timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutTail = appendTail(stdoutTail, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = appendTail(stderrTail, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdoutTail, stderrTail: `${stderrTail}\n${error.message}`.trim() });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdoutTail, stderrTail });
    });
  });

/** 尾部滚动截取：超限丢头部，保证常驻期间内存有界。 */
function appendTail(current: string, chunk: Buffer): string {
  const next = `${current}${chunk.toString("utf8")}`;
  return next.length > OUTPUT_TAIL_CHARS * 2 ? next.slice(-OUTPUT_TAIL_CHARS) : next;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// venv
// ---------------------------------------------------------------------------

/** 项目 venv 目录（`<workspace>/.robindone/triggers/state/python-env/`）。 */
export function pythonEnvDirFor(workspacePath: string): string {
  return join(workspacePath, ".robindone", "triggers", "state", triggerPythonEnvDirectoryName);
}

/** venv 解释器：Windows `Scripts/python.exe`，POSIX `bin/python`（node:path 拼接，禁 shell 拼接）。 */
export function venvInterpreterPath(venvDir: string): string {
  return process.platform === "win32"
    ? join(venvDir, "Scripts", "python.exe")
    : join(venvDir, "bin", "python");
}

export interface VenvEnsureResult {
  venvDir: string;
  /** venv 解释器绝对路径（python 触发器脚本的执行体）。 */
  pythonPath: string;
  /** true = 本次实际创建/重建（冷创建或指纹失配）；false = 复用现有 venv。 */
  rebuilt: boolean;
  /** 重建后按台账重放安装的失败清单（空 = 全部成功；复用路径恒空）。 */
  replayFailures: string[];
}

/**
 * 确保 venv 就绪：指纹一致且解释器在场 → 复用；否则删旧建新（`<解释器> -m venv`）+
 * 写指纹 + 按台账重放安装。重放失败不抛错（结果带回，由调用方决定文案/熔断）。
 */
export async function ensureProjectVenv(params: {
  workspacePath: string;
  /** 供给层解释器绝对路径（托管或系统回退）。 */
  interpreterPath: string;
  /** 解释器指纹标签（如 `managed|cpython-3.12.16+20261110` / `system|python3`），失配即重建。 */
  interpreterFingerprint: string;
  log(message: string): void;
  runCommand?: CommandRunner;
  timeoutMs?: number;
}): Promise<VenvEnsureResult> {
  const venvDir = pythonEnvDirFor(params.workspacePath);
  const pythonPath = venvInterpreterPath(venvDir);
  const run = params.runCommand ?? defaultCommandRunner;
  const runtimeFile = join(venvDir, "runtime.json");
  const fingerprint = await readVenvFingerprint(runtimeFile);
  if (fingerprint === params.interpreterFingerprint && (await fileExists(pythonPath))) {
    return { venvDir, pythonPath, rebuilt: false, replayFailures: [] };
  }

  params.log(
    `python venv (re)creating for ${params.workspacePath} (fingerprint ${params.interpreterFingerprint})`,
  );
  // 删旧建新：venv 是纯标准库产物，整目录删除安全；packages 台账在目录外（state/ 一级），不受影响。
  await rm(venvDir, { recursive: true, force: true });
  await mkdir(dirname(venvDir), { recursive: true });
  const created = await run({
    command: params.interpreterPath,
    args: ["-m", "venv", venvDir],
    timeoutMs: params.timeoutMs ?? VENV_CREATE_TIMEOUT_MS,
  });
  if (created.code !== 0) {
    const detail = created.stderrTail.trim() || created.stdoutTail.trim() || "no output";
    const suffix = created.timedOut
      ? " (timed out)"
      : params.interpreterFingerprint.startsWith("system|")
        ? // Debian/Ubuntu 系统解释器缺 python3-venv/ensurepip 的经典坑：文案给指引。
          " — if this is a system Python on Debian/Ubuntu, install python3-venv (e.g. `apt install python3-venv`), or unset ROBINDONE_PYTHON_FALLBACK_SYSTEM to use the managed runtime"
        : "";
    throw new Error(`python -m venv failed (code ${created.code})${suffix}: ${detail}`);
  }
  if (!(await fileExists(pythonPath))) {
    throw new Error(`python -m venv reported success but interpreter is missing: ${pythonPath}`);
  }
  await mkdir(venvDir, { recursive: true });
  const payload = `${JSON.stringify(
    { version: 1, fingerprint: params.interpreterFingerprint, createdAt: new Date().toISOString() },
    null,
    2,
  )}\n`;
  const temp = `${runtimeFile}.tmp.${process.pid}`;
  await writeFile(temp, payload, "utf8");
  await rename(temp, runtimeFile);

  // 重建后按台账重放（设计 §3.2）：失败不阻断——venv 本身已可用，缺包在结果里带回。
  const ledger = await readPythonPackagesLedger(params.workspacePath);
  const replayFailures: string[] = [];
  for (const entry of ledger?.packages ?? []) {
    params.log(`python venv replaying package install: ${entry.spec}`);
    const result = await runPipInstall({
      workspacePath: params.workspacePath,
      interpreterPath: pythonPath,
      packages: [entry.spec],
      runCommand: run,
    });
    if (!result.ok) {
      replayFailures.push(`${entry.spec}: ${result.error ?? "unknown error"}`);
    }
  }
  return { venvDir, pythonPath, rebuilt: true, replayFailures };
}

async function readVenvFingerprint(runtimeFile: string): Promise<string | undefined> {
  try {
    const raw = await readFile(runtimeFile, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      const fingerprint = (parsed as { fingerprint?: unknown }).fingerprint;
      if (typeof fingerprint === "string" && fingerprint.length > 0) return fingerprint;
    }
  } catch {
    // 缺失/损坏 = 视为不匹配（重建路径）。
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// pip 安装
// ---------------------------------------------------------------------------

export interface PipInstallResult {
  ok: boolean;
  outputTail: string;
  error?: string;
  timedOut?: boolean;
}

/**
 * `<venv-python> -m pip install --upgrade <pkgs...>`。index：`ROBINDONE_PIP_INDEX_URL`
 * （国内镜像等）映射为 pip 的 PIP_INDEX_URL；缺省官方 PyPI。
 */
export async function runPipInstall(params: {
  workspacePath: string;
  interpreterPath: string;
  packages: string[];
  runCommand?: CommandRunner;
  timeoutMs?: number;
}): Promise<PipInstallResult> {
  const env: NodeJS.ProcessEnv = {};
  const indexUrl = process.env.ROBINDONE_PIP_INDEX_URL;
  if (indexUrl !== undefined && indexUrl.length > 0) env.PIP_INDEX_URL = indexUrl;
  const run = params.runCommand ?? defaultCommandRunner;
  const result = await run({
    command: params.interpreterPath,
    args: ["-m", "pip", "install", "--upgrade", "--disable-pip-version-check", ...params.packages],
    cwd: params.workspacePath,
    timeoutMs: params.timeoutMs ?? PIP_INSTALL_TIMEOUT_MS,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  });
  const outputTail = `${result.stdoutTail}\n${result.stderrTail}`.trim();
  if (result.timedOut === true) {
    return {
      ok: false,
      outputTail,
      error: `pip install timed out (${Math.round((params.timeoutMs ?? PIP_INSTALL_TIMEOUT_MS) / 60_000)} min)`,
      timedOut: true,
    };
  }
  if (result.code !== 0) {
    return {
      ok: false,
      outputTail,
      error: `pip install failed (code ${result.code}): ${result.stderrTail.trim() || outputTail || "no output"}`,
    };
  }
  return { ok: true, outputTail };
}

// ---------------------------------------------------------------------------
// 依赖台账（`state/python-packages.json`，venv 重建重放 + 审计）
// ---------------------------------------------------------------------------

export async function readPythonPackagesLedger(
  workspacePath: string,
): Promise<PythonPackagesLedger | undefined> {
  const file = pythonPackagesLedgerPath(workspacePath);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = pythonPackagesLedgerSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 台账追加（动作台账原则）：语义是「当前 venv 应装什么」的重放清单而非历史日志
 * （历史由各触发器 audit.jsonl 承担），故同 spec 幂等更新时间戳、不堆重复条目；
 * 超容量丢最旧。
 */
export async function appendPythonPackages(
  workspacePath: string,
  specs: string[],
): Promise<PythonPackagesLedger> {
  const file = pythonPackagesLedgerPath(workspacePath);
  const existing = await readPythonPackagesLedger(workspacePath);
  const bySpec = new Map((existing?.packages ?? []).map((entry) => [entry.spec, entry]));
  const installedAt = new Date().toISOString();
  for (const spec of specs) {
    bySpec.set(spec, { spec, installedAt });
  }
  const packages = [...bySpec.values()].slice(-PACKAGES_LEDGER_MAX);
  const ledger: PythonPackagesLedger = { version: 1, packages };
  await mkdir(dirname(file), { recursive: true });
  const payload = `${JSON.stringify(ledger, null, 2)}\n`;
  const temp = `${file}.tmp.${process.pid}`;
  await writeFile(temp, payload, "utf8");
  await rename(temp, file);
  return ledger;
}

function pythonPackagesLedgerPath(workspacePath: string): string {
  return join(workspacePath, ".robindone", "triggers", "state", triggerPythonPackagesFileName);
}
