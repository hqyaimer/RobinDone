/**
 * python 主运行时资产单一来源（2026-11-26 打包内置改造时从 python-runtime.ts 抽出）：
 * 版本、六平台 python-build-standalone install_only 资产名与 sha256 在此钉死，
 * 运行时（python-runtime.ts）与构建期打包脚本（packages/desktop/scripts/prepare-python-runtime.mjs）
 * 共用本模块，改一处两端同步。docs/trigger-python-runtime.md §3.1。
 *
 * 钉死而非运行时拉 SHA256SUMS：确定性、可审计（与原 python-runtime.ts 内联表同决策）。
 */

export const PYTHON_RELEASE_TAG = "20261110";
export const PYTHON_VERSION = "3.12.16";
/** 版本标识 = 缓存目录名；升版即换目录。 */
export const PYTHON_RUNTIME_ID = `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}`;
export const PYTHON_RELEASE_BASE_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE_TAG}`;

/** 六平台 install_only 资产与 sha256（release 20261110 的 SHA256SUMS 逐字预置）。 */
export const PYTHON_RUNTIME_ASSETS = {
  "x86_64-pc-windows-msvc": {
    archive: `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}-x86_64-pc-windows-msvc-install_only.tar.gz`,
    sha256: "e23fe5b16926de1d81661b1a97352e89fb167549c55a6825796ccd0f32ec7f1b",
  },
  "aarch64-pc-windows-msvc": {
    archive: `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}-aarch64-pc-windows-msvc-install_only.tar.gz`,
    sha256: "7122bf62a0cf601527ba62e19ca715d64db86b269765da23937e9ac7f968f39c",
  },
  "x86_64-unknown-linux-gnu": {
    archive: `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}-x86_64-unknown-linux-gnu-install_only.tar.gz`,
    sha256: "c2f87d4b4e8db3abddb0f116c6ccfc503d0cbdbb9ee8faacddad1b679ec12e99",
  },
  "aarch64-unknown-linux-gnu": {
    archive: `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}-aarch64-unknown-linux-gnu-install_only.tar.gz`,
    sha256: "4792f81750282597fb2a3389fe18b945ed2ba6aad5e45ad406d122c58cb33081",
  },
  "x86_64-apple-darwin": {
    archive: `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}-x86_64-apple-darwin-install_only.tar.gz`,
    sha256: "83f2922437e6d546d0fcdb8c11f150a8e52787e8d9ea8651b1974e20908eb1bc",
  },
  "aarch64-apple-darwin": {
    archive: `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}-aarch64-apple-darwin-install_only.tar.gz`,
    sha256: "e956e60bc9465d577ef8062059aa05cd3a2665b4b8678a2ed24e432368330b8f",
  },
};

/** 纯函数平台映射（win32/linux/darwin × x64/arm64 → python-build-standalone triple）。 */
export function resolvePythonHostTriple(platform, arch) {
  if (platform === "win32") {
    if (arch === "x64") return "x86_64-pc-windows-msvc";
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
    return undefined;
  }
  if (platform === "linux") {
    if (arch === "x64") return "x86_64-unknown-linux-gnu";
    if (arch === "arm64") return "aarch64-unknown-linux-gnu";
    return undefined;
  }
  if (platform === "darwin") {
    if (arch === "x64") return "x86_64-apple-darwin";
    if (arch === "arm64") return "aarch64-apple-darwin";
    return undefined;
  }
  return undefined;
}
