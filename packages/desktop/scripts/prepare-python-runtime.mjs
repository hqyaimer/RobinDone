#!/usr/bin/env node

/**
 * 构建期预置 python 主运行时（2026-11-26 打包内置改造，docs/trigger-python-runtime.md §3.1）：
 * 下载当前构建平台的 python-build-standalone install_only → sha256 校验 → 解压 →
 * 放入 `bundled-tools/<platformKey>/python/<PYTHON_RUNTIME_ID>/`，由 electron-builder
 * extraResources 打进安装包 `resources/runtimes/python/`。运行时（python-runtime.ts）
 * 优先解析随包目录，缺失才走网络下载兜底——用户开箱即得 python，不再首启联网拉取。
 *
 * - 资产名/sha256 与运行时共用 `services/src/trigger-engine/python-runtime-assets.mjs`
 *   单一来源（钉死表，两端同步）。
 * - 失败大声失败（非零退出）：出无 python 的包等于静默退化成联网下载，发布不许。
 * - 幂等：staging 目录已带完成标记时跳过下载（CI 重跑/本地重复构建直接复用）。
 * - 国内本地构建可用 ROBINDONE_PYTHON_RUNTIME_MIRROR（与运行时同模板语义）。
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  PYTHON_RELEASE_TAG,
  PYTHON_RUNTIME_ASSETS,
  PYTHON_RUNTIME_ID,
  resolvePythonHostTriple,
} from "../../services/src/trigger-engine/python-runtime-assets.mjs";
import { getTargetPlatform } from "./target-platform.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const DOWNLOAD_MAX_REDIRECTS = 5;
const DOWNLOAD_ATTEMPTS_PER_URL = 3;
const EXTRACT_TIMEOUT_MS = 10 * 60_000;
const COMPLETE_MARKER_FILE = ".robindone-complete";
const MIRROR_ENV = "ROBINDONE_PYTHON_RUNTIME_MIRROR";

const target = getTargetPlatform();
const triple = resolvePythonHostTriple(target.os, target.arch);
if (triple === undefined) {
  // 与运行时同口径：不支持的平台没有资产，prepare 直接跳过（由 electron-builder
  // 侧按同名判定决定是否需要随包 python；CI 矩阵内平台均受支持）。
  console.log(
    `[prepare-python-runtime] no managed python asset for ${target.os}/${target.arch}; skipping`,
  );
  process.exit(0);
}
const asset = PYTHON_RUNTIME_ASSETS[triple];
const stagingRoot = join(desktopRoot, "bundled-tools", target.key, "python");
const finalDir = join(stagingRoot, PYTHON_RUNTIME_ID);

if (existsSync(join(finalDir, COMPLETE_MARKER_FILE))) {
  console.log(`[prepare-python-runtime] already staged: ${finalDir}; skipping download`);
  process.exit(0);
}

function buildDownloadUrls() {
  const official = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE_TAG}/${asset.archive}`;
  const mirror = process.env[MIRROR_ENV]?.trim();
  if (!mirror) return [official];
  // 与运行时 buildDownloadUrls 同语义：{asset} 占位符或 <mirror>/<tag>/<archive>。
  const templated = mirror.includes("{asset}")
    ? mirror.replace("{asset}", asset.archive)
    : `${mirror.replace(/\/+$/, "")}/${PYTHON_RELEASE_TAG}/${asset.archive}`;
  return [templated, official];
}

function downloadToFile(url, destPath) {
  return new Promise((resolvePromise, reject) => {
    const handleResponse = (targetUrl, response, redirectsLeft) => {
      const location = response.headers.location;
      if (response.statusCode >= 300 && response.statusCode < 400 && typeof location === "string") {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`too many redirects downloading ${targetUrl}`));
          return;
        }
        attempt(new URL(location, targetUrl).toString(), redirectsLeft - 1);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode} for ${targetUrl}`));
        return;
      }
      let downloadedBytes = 0;
      let lastLoggedStep = 0;
      const totalBytes = Number(response.headers["content-length"] ?? 0) || null;
      response.on("data", (chunk) => {
        downloadedBytes += chunk.length;
        if (downloadedBytes - lastLoggedStep >= 16 * 1024 * 1024) {
          lastLoggedStep = downloadedBytes;
          console.log(
            `[prepare-python-runtime] progress ${Math.round(downloadedBytes / 1e6)}MB` +
              (totalBytes ? ` / ${Math.round(totalBytes / 1e6)}MB` : ""),
          );
        }
      });
      const file = createWriteStream(destPath);
      response.pipe(file);
      file.on("error", reject);
      file.on("close", () => {
        if (response.complete) resolvePromise();
        else reject(new Error(`download incomplete for ${targetUrl}`));
      });
    };
    const attempt = (targetUrl, redirectsLeft) => {
      const transport = targetUrl.startsWith("http:") ? httpGet : httpsGet;
      const request = transport(
        targetUrl,
        { headers: { "user-agent": "RobinDone" } },
        (response) => {
          handleResponse(targetUrl, response, redirectsLeft);
        },
      );
      request.on("error", reject);
      const timer = setTimeout(() => {
        request.destroy(new Error(`download timed out after ${DOWNLOAD_TIMEOUT_MS / 60_000} min`));
      }, DOWNLOAD_TIMEOUT_MS);
      request.on("close", () => clearTimeout(timer));
    };
    attempt(url, DOWNLOAD_MAX_REDIRECTS);
  });
}

async function verifySha256(path, expected) {
  const hash = createHash("sha256");
  const handle = createReadStream(path);
  await new Promise((resolvePromise, reject) => {
    handle.on("data", (chunk) => hash.update(chunk));
    handle.on("error", reject);
    handle.on("close", resolvePromise);
  });
  const actual = hash.digest("hex");
  if (actual !== expected) {
    throw new Error(`sha256 mismatch for ${path}: expected ${expected}, got ${actual}`);
  }
}

function runTar(args) {
  return new Promise((resolvePromise, reject) => {
    const command =
      process.platform === "win32"
        ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
        : "tar";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderrTail = "";
    child.stderr?.on("data", (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-2000);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`tar extract timed out after ${EXTRACT_TIMEOUT_MS / 60_000} min`));
    }, EXTRACT_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else
        reject(new Error(`tar extract failed (code ${code}): ${stderrTail.trim() || "no output"}`));
    });
  });
}

const urls = buildDownloadUrls();
const staging = await mkdtemp(join(tmpdir(), "robindone-py-bundle-"));
try {
  const archivePath = join(staging, asset.archive);
  let lastError;
  let downloaded = false;
  for (const url of urls) {
    for (let attemptIndex = 1; attemptIndex <= DOWNLOAD_ATTEMPTS_PER_URL; attemptIndex += 1) {
      try {
        console.log(
          `[prepare-python-runtime] downloading ${triple} from ${new URL(url).host}` +
            (attemptIndex > 1 ? ` (attempt ${attemptIndex}/${DOWNLOAD_ATTEMPTS_PER_URL})` : ""),
        );
        await downloadToFile(url, archivePath);
        downloaded = true;
        break;
      } catch (error) {
        lastError = error;
        console.warn(`[prepare-python-runtime] download failed from ${url}: ${error.message}`);
      }
    }
    if (downloaded) break;
  }
  if (!downloaded) {
    throw new Error(
      `failed to download ${asset.archive} from ${urls.length} source(s): ${lastError?.message ?? "unknown"}` +
        ` — set ${MIRROR_ENV} (URL template with optional {asset} placeholder) if GitHub is unreachable`,
    );
  }
  await verifySha256(archivePath, asset.sha256);
  const extractDir = join(staging, "extracted");
  await mkdir(extractDir, { recursive: true });
  await runTar(["-xzf", archivePath, "-C", extractDir]);
  const sourceDir = join(extractDir, "python");
  await stat(sourceDir); // install_only 布局断言（缺顶层 python/ 即资产异常）
  // 原子落位：staging 完整就绪后才清旧目录、拷入、写完成标记。
  // dereference（2026-11-26 v0.0.3 首跑 CI 实测）：POSIX 发行版 bin/ 里是符号链接
  // （python3→python3.12 等），electron-builder 的 extraResources 拷贝会弄丢部分链接
  // 目标（打包产物 bin/2to3 stat ENOENT——afterPack sourcemap 清理因此崩溃，且运行时
  // 也真缺文件）。staging 一律落实体文件，下游打包/venv 不再依赖链接保真。
  await rm(finalDir, { recursive: true, force: true });
  await mkdir(dirname(finalDir), { recursive: true });
  await cp(sourceDir, finalDir, { recursive: true, dereference: true });
  await writeFile(join(finalDir, COMPLETE_MARKER_FILE), `${PYTHON_RUNTIME_ID}\n`, "utf8");
  const interpreterRel = process.platform === "win32" ? "python.exe" : join("bin", "python3");
  if (!existsSync(join(finalDir, interpreterRel))) {
    throw new Error(
      `staged python runtime is missing interpreter: ${join(finalDir, interpreterRel)}`,
    );
  }
  console.log(`[prepare-python-runtime] staged ${PYTHON_RUNTIME_ID} (${triple}) at ${finalDir}`);
} finally {
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);
}
