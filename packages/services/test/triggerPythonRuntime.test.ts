import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTriggerPythonRuntimePort,
  ensureManagedPythonRuntime,
  PYTHON_RUNTIME_ID,
  type HostAsset,
  type TriggerPythonRuntimePortOptions,
} from "../src/trigger-engine/python-runtime.js";
import { defaultCommandRunner, venvInterpreterPath } from "../src/trigger-engine/python-env.js";

/**
 * python 主运行时供给与按项目 venv（2026-11-22 改造，docs/trigger-python-runtime.md）。
 *
 * 全链真实化策略（同 triggerScriptSupervisor 的真实子进程风格）：
 * - 下载：本地 http server 当镜像（ROBINDONE_PYTHON_RUNTIME_MIRROR 指过去，走生产代码
 *   的镜像模板解析路径），archive 由系统 tar 现场打包（python/ 顶层目录 + 平台解释器
 *   占位文件），sha256 由 fixture 现算——钉死资产表不可变，测试经 assetOverride 注入。
 * - venv/pip：CommandRunner 注入 fake（-m veng 建解释器占位、-m pip 返回成功），
 *   不依赖真 python；tar 解压仍走真实命令。
 */

let tmpRoot: string;
let mirrorServer: ReturnType<typeof createFixtureServer> | undefined;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "robindone-py-runtime-"));
});

afterEach(async () => {
  mirrorServer?.close();
  mirrorServer = undefined;
  delete process.env.ROBINDONE_PYTHON_RUNTIME_MIRROR;
  delete process.env.ROBINDONE_PYTHON_FALLBACK_SYSTEM;
  await rm(tmpRoot, { recursive: true, force: true });
});

/** 本地"镜像"HTTP server：任意 GET 都回当前 fixture 字节；支持单次失败注入（重试覆盖）。 */
function createFixtureServer() {
  let payload = Buffer.alloc(0);
  let requestCount = 0;
  let lastUrl = "";
  let failNextOnceError: Error | undefined;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requestCount += 1;
    lastUrl = req.url ?? "";
    if (failNextOnceError !== undefined) {
      const error = failNextOnceError;
      failNextOnceError = undefined;
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(error.message);
      return;
    }
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(payload.length),
    });
    res.end(payload);
  });
  return {
    listen(): Promise<number> {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          resolve((server.address() as { port: number }).port);
        });
      });
    },
    close(): void {
      server.close();
    },
    setPayload(next: Buffer): void {
      payload = next;
    },
    /** 注入一次 HTTP 500（下一请求失败一次后自动恢复），驱动单 URL 重试路径。 */
    setFailNextOnce(error: Error): void {
      failNextOnceError = error;
    },
    get requestCountValue(): number {
      return requestCount;
    },
    get lastRequestUrl(): string {
      return lastUrl;
    },
  };
}

/** 现场 tar 一个 install_only 布局的 fixture：顶层 python/ + 平台解释器占位文件。 */
async function buildPythonFixture(sourceDir: string): Promise<{ archive: string; sha256: string }> {
  const pyRoot = join(sourceDir, "python");
  const interpreterRel =
    process.platform === "win32" ? join("python", "python.exe") : join("python", "bin", "python3");
  const interpreterPath = join(sourceDir, interpreterRel);
  await mkdir(join(interpreterPath, ".."), { recursive: true });
  await writeFile(interpreterPath, "#!/bin/sh\nexit 0\n", "utf8");
  if (process.platform !== "win32") await chmod(interpreterPath, 0o755);
  await writeFile(join(pyRoot, "VERSION"), "3.12.16-test\n", "utf8");
  const archive = join(sourceDir, "install_only.tar.gz");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-czf", archive, "python"], {
      cwd: sourceDir,
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar -czf failed: ${code}`)),
    );
  });
  const bytes = await readFile(archive);
  return { archive, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function assetOverrideFor(sourceDir: string): Promise<HostAsset> {
  const { archive, sha256 } = await buildPythonFixture(sourceDir);
  return {
    triple: "x86_64-unknown-linux-gnu",
    archive: archive.split(/[\\/]/).pop() ?? archive,
    sha256,
  };
}

/** 镜像 env 指向本地 server 的临时目录树（mirror 需按 `<base>/<tag>/<archive>` 拼接可达）。 */
async function startMirrorWith(asset: HostAsset, bytes: Buffer): Promise<string> {
  mirrorServer = createFixtureServer();
  mirrorServer.setPayload(bytes);
  const port = await mirrorServer.listen();
  // 模板含 {asset} 占位符路径：本地 server 忽略路径，只要请求到达即可。
  return `http://127.0.0.1:${port}/mirror/{asset}`;
}

describe("ensureManagedPythonRuntime", () => {
  it("downloads via mirror, verifies sha256, extracts, and reuses the cache marker", async () => {
    const fixtureDir = join(tmpRoot, "fixture");
    await mkdir(fixtureDir, { recursive: true });
    const asset = await assetOverrideFor(fixtureDir);
    const { readFile: read } = await import("node:fs/promises");
    const bytes = await read(join(fixtureDir, asset.archive));
    const mirror = await startMirrorWith(asset, bytes);
    process.env.ROBINDONE_PYTHON_RUNTIME_MIRROR = mirror;
    const cacheRoot = join(tmpRoot, "cache");
    const logs: string[] = [];

    const first = await ensureManagedPythonRuntime({
      cacheRoot,
      log: (m) => logs.push(m),
      assetOverride: asset,
    });
    expect(await exists(first.interpreterPath)).toBe(true);
    // 二次调用：完成标记在场 → 复用，不发第二次 HTTP 请求。
    const requestsAfterFirst = mirrorServer!.requestCountValue;
    const second = await ensureManagedPythonRuntime({
      cacheRoot,
      log: (m) => logs.push(m),
      assetOverride: asset,
    });
    expect(second.interpreterPath).toBe(first.interpreterPath);
    expect(mirrorServer!.requestCountValue).toBe(requestsAfterFirst);
    // 镜像模板解析：请求路径携带资产文件名（{asset} 占位符替换生效）。
    expect(mirrorServer!.lastRequestUrl).toContain(asset.archive);
    expect(logs.some((m) => m.includes("managed python runtime ready"))).toBe(true);
  });

  it("rejects archives whose sha256 does not match the pinned digest", async () => {
    const fixtureDir = join(tmpRoot, "fixture-bad");
    await mkdir(fixtureDir, { recursive: true });
    const asset = await assetOverrideFor(fixtureDir);
    const { readFile: read } = await import("node:fs/promises");
    const bytes = await read(join(fixtureDir, asset.archive));
    mirrorServer = createFixtureServer();
    mirrorServer.setPayload(Buffer.concat([bytes, Buffer.from("tampered")]));
    const port = await mirrorServer.listen();
    process.env.ROBINDONE_PYTHON_RUNTIME_MIRROR = `http://127.0.0.1:${port}/mirror/{asset}`;

    await expect(
      ensureManagedPythonRuntime({
        cacheRoot: join(tmpRoot, "cache-bad"),
        log: () => undefined,
        assetOverride: asset,
      }),
    ).rejects.toThrow(/sha256 mismatch/);
  });

  it("reuses a complete bundled dir without any download, and skips it when incomplete", async () => {
    const fixtureDir = join(tmpRoot, "fixture-bundled");
    await mkdir(fixtureDir, { recursive: true });
    const asset = await assetOverrideFor(fixtureDir);
    const bytes = await readFile(join(fixtureDir, asset.archive));
    const mirror = await startMirrorWith(asset, bytes);
    process.env.ROBINDONE_PYTHON_RUNTIME_MIRROR = mirror;

    // bundled staging：解压布局 + 完成标记（prepare:python-runtime 的产出形态）。
    const bundledDir = join(tmpRoot, "bundled", PYTHON_RUNTIME_ID);
    const interpreterRel =
      process.platform === "win32" ? join("python.exe") : join("bin", "python3");
    const interpreterPath = join(bundledDir, interpreterRel);
    await mkdir(join(interpreterPath, ".."), { recursive: true });
    await writeFile(interpreterPath, "#!/bin/sh\nexit 0\n", "utf8");
    if (process.platform !== "win32") await chmod(interpreterPath, 0o755);
    await writeFile(join(bundledDir, ".robindone-complete"), `${PYTHON_RUNTIME_ID}\n`, "utf8");

    const logs: string[] = [];
    const bundled = await ensureManagedPythonRuntime({
      cacheRoot: join(tmpRoot, "cache-bundled"),
      log: (m) => logs.push(m),
      assetOverride: asset,
      bundledDir,
    });
    expect(bundled.interpreterPath).toBe(interpreterPath);
    expect(bundled.cacheDir).toBe(bundledDir);
    expect(logs.some((m) => m.includes("using bundled python runtime"))).toBe(true);
    // bundled 命中：零下载（mirror 请求计数不变）、缓存目录不落盘。
    expect(mirrorServer!.requestCountValue).toBe(0);
    await expect(stat(join(tmpRoot, "cache-bundled"))).rejects.toThrow();

    // bundled 缺解释器（只有标记）→ 不可用，回退缓存/下载路径正常供给。
    const brokenBundledDir = join(tmpRoot, "bundled-broken", PYTHON_RUNTIME_ID);
    await mkdir(brokenBundledDir, { recursive: true });
    await writeFile(
      join(brokenBundledDir, ".robindone-complete"),
      `${PYTHON_RUNTIME_ID}\n`,
      "utf8",
    );
    const fallback = await ensureManagedPythonRuntime({
      cacheRoot: join(tmpRoot, "cache-bundled-fallback"),
      log: () => undefined,
      assetOverride: asset,
      bundledDir: brokenBundledDir,
    });
    expect(await exists(fallback.interpreterPath)).toBe(true);
    expect(fallback.interpreterPath).not.toContain("bundled-broken");
    expect(fallback.interpreterPath).toContain("cache-bundled-fallback");
  });

  it("emits byte-level download progress and retries a failed mirror before official fallback", async () => {
    const fixtureDir = join(tmpRoot, "fixture-progress");
    await mkdir(fixtureDir, { recursive: true });
    const asset = await assetOverrideFor(fixtureDir);
    const bytes = await readFile(join(fixtureDir, asset.archive));
    mirrorServer = createFixtureServer();
    // 首次请求返回半截数据（模拟断连）→ 第二次成功：单 URL 重试生效。
    mirrorServer.setFailNextOnce(new Error("connection reset"));
    mirrorServer.setPayload(bytes);
    const port = await mirrorServer.listen();
    process.env.ROBINDONE_PYTHON_RUNTIME_MIRROR = `http://127.0.0.1:${port}/mirror/{asset}`;

    const progress: { downloadedBytes: number; totalBytes: number | null }[] = [];
    const logs: string[] = [];
    const info = await ensureManagedPythonRuntime({
      cacheRoot: join(tmpRoot, "cache-progress"),
      log: (m) => logs.push(m),
      assetOverride: asset,
      onDownloadProgress: (event) => {
        progress.push({ downloadedBytes: event.downloadedBytes, totalBytes: event.totalBytes });
      },
    });
    expect(await exists(info.interpreterPath)).toBe(true);
    // 字节进度：至少一帧、帧值单调不降、终帧 = archive 实际字节数（无 content-length 时 totalBytes 为 null）。
    expect(progress.length).toBeGreaterThan(0);
    for (let index = 1; index < progress.length; index += 1) {
      expect(progress[index]!.downloadedBytes).toBeGreaterThanOrEqual(
        progress[index - 1]!.downloadedBytes,
      );
    }
    expect(progress[progress.length - 1]!.downloadedBytes).toBe(bytes.length);
    expect(progress[progress.length - 1]!.totalBytes).toBe(bytes.length);
    // 重试：首帧失败日志在场，且成功供给（异常不被静默吞掉）。
    expect(logs.some((m) => m.includes("download failed from"))).toBe(true);
    expect(logs.some((m) => m.includes("managed python runtime ready"))).toBe(true);
  });
});

describe("trigger python runtime port", () => {
  function portOptions(cacheRoot: string, asset: HostAsset): TriggerPythonRuntimePortOptions {
    return {
      log: () => undefined,
      cacheRoot,
      assetOverride: asset,
      runCommand: fakePythonCommandRunner,
    };
  }

  it("writes unavailable state when provisioning fails, and recovers on a later ensure", async () => {
    const workspace = join(tmpRoot, "ws-unavailable");
    const fixtureDir = join(tmpRoot, "fixture-unavailable");
    await mkdir(fixtureDir, { recursive: true });
    const asset = await assetOverrideFor(fixtureDir);
    const { readFile: read } = await import("node:fs/promises");
    const bytes = await read(join(fixtureDir, asset.archive));
    mirrorServer = createFixtureServer();
    // 内容加盐 → sha256 校验失败 → 走 unavailable（ROBINDONE_PYTHON_FALLBACK_SYSTEM 未设）。
    mirrorServer.setPayload(Buffer.concat([bytes, Buffer.from("x")]));
    const port = await mirrorServer.listen();
    process.env.ROBINDONE_PYTHON_RUNTIME_MIRROR = `http://127.0.0.1:${port}/mirror/{asset}`;

    const runtime = createTriggerPythonRuntimePort(
      portOptions(join(tmpRoot, "cache-unavailable"), asset),
    );
    const resolution = await runtime.ensureInterpreter(workspace);
    expect(resolution.ok).toBe(false);
    expect(resolution.error).toMatch(/sha256 mismatch/);

    const stateFile = join(workspace, ".robindone", "triggers", "state", "python-runtime.json");
    const state = JSON.parse(await readFile(stateFile, "utf8")) as {
      state: string;
      error?: string;
    };
    expect(state.state).toBe("unavailable");
    expect(state.error).toContain("sha256 mismatch");

    // 恢复：修好镜像内容后重试（ensureInterpreter 对 unavailable 不做进程内缓存命中）。
    mirrorServer.setPayload(bytes);
    const recovered = await runtime.ensureInterpreter(workspace);
    expect(recovered.ok).toBe(true);
    const recoveredState = JSON.parse(await readFile(stateFile, "utf8")) as { state: string };
    expect(recoveredState.state).toBe("available");
  });

  it("provisions interpreter + venv, replays the ledger, and records installs", async () => {
    const workspace = join(tmpRoot, "ws-ok");
    const fixtureDir = join(tmpRoot, "fixture-ok");
    await mkdir(fixtureDir, { recursive: true });
    const asset = await assetOverrideFor(fixtureDir);
    const { readFile: read } = await import("node:fs/promises");
    const bytes = await read(join(fixtureDir, asset.archive));
    const mirror = await startMirrorWith(asset, bytes);
    process.env.ROBINDONE_PYTHON_RUNTIME_MIRROR = mirror;

    const runtime = createTriggerPythonRuntimePort(portOptions(join(tmpRoot, "cache-ok"), asset));
    const venv = await runtime.ensureVenv(workspace);
    expect(venv.ok).toBe(true);
    if (!venv.ok) return;
    expect(venv.interpreterPath).toBe(venvInterpreterPath(venv.venvDir));
    expect(await exists(venv.interpreterPath)).toBe(true);

    // 安装：pip fake 返回成功 → 台账落盘（venv 目录外，重建可重放）。
    const install = await runtime.installPackages(workspace, ["requests"]);
    expect(install.ok).toBe(true);
    const ledgerPath = join(workspace, ".robindone", "triggers", "state", "python-packages.json");
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
      packages: { spec: string }[];
    };
    expect(ledger.packages.map((entry) => entry.spec)).toContain("requests");

    // 第二次 ensureVenv：指纹一致 → 复用（不重建），台账已在场。
    const again = await runtime.ensureVenv(workspace);
    expect(again.ok).toBe(true);
  });

  it("rejects concurrent install_packages for the same workspace", async () => {
    const workspace = join(tmpRoot, "ws-concurrent");
    const fixtureDir = join(tmpRoot, "fixture-concurrent");
    await mkdir(fixtureDir, { recursive: true });
    const asset = await assetOverrideFor(fixtureDir);
    const { readFile: read } = await import("node:fs/promises");
    const bytes = await read(join(fixtureDir, asset.archive));
    const mirror = await startMirrorWith(asset, bytes);
    process.env.ROBINDONE_PYTHON_RUNTIME_MIRROR = mirror;

    // 慢速 pip fake：第一个安装挂在途，第二个请求必须被拒。
    let releaseFirst: (() => void) | undefined;
    const slowRunner = async (params: {
      command: string;
      args: string[];
    }): Promise<{ code: number | null; stdoutTail: string; stderrTail: string }> => {
      if (params.args[1] === "pip") {
        if (releaseFirst === undefined) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return { code: 0, stdoutTail: "ok", stderrTail: "" };
      }
      return fakePythonCommandRunner(params);
    };
    const runtime = createTriggerPythonRuntimePort({
      log: () => undefined,
      cacheRoot: join(tmpRoot, "cache-concurrent"),
      assetOverride: asset,
      runCommand: slowRunner,
    });
    const first = runtime.installPackages(workspace, ["a"]);
    const second = await runtime.installPackages(workspace, ["b"]);
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/another install_packages/);
    // 等首个安装进入 pip 阶段再放行（下载/venv 是异步前奏，过早放行会让首个安装永远挂起）。
    const deadline = Date.now() + 15_000;
    while (releaseFirst === undefined && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    releaseFirst?.();
    expect((await first).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fake python 命令执行器：tar 解压走真实命令；-m venv 建解释器占位；-m pip 返回成功。
// ---------------------------------------------------------------------------

async function fakePythonCommandRunner(params: {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
}): Promise<{ code: number | null; stdoutTail: string; stderrTail: string }> {
  if (params.args[0] === "-xzf") {
    return defaultCommandRunner(params);
  }
  if (params.args[0] === "-m" && params.args[1] === "venv") {
    const venvDir = params.args[2]!;
    const interpreterPath = venvInterpreterPath(venvDir);
    await mkdir(join(interpreterPath, ".."), { recursive: true });
    await writeFile(interpreterPath, "# fake venv interpreter\n", "utf8");
    if (process.platform !== "win32") await chmod(interpreterPath, 0o755);
    await writeFile(join(venvDir, "pyvenv.cfg"), "home = fake\n", "utf8");
    return { code: 0, stdoutTail: "", stderrTail: "" };
  }
  if (params.args[0] === "-m" && params.args[1] === "pip") {
    return { code: 0, stdoutTail: "Successfully installed", stderrTail: "" };
  }
  return {
    code: 1,
    stdoutTail: "",
    stderrTail: `unsupported fake command: ${params.args.join(" ")}`,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
