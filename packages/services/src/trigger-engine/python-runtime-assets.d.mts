/**
 * python-runtime-assets.mjs 的手写声明（同 desktop-product-identity.d.mts 约定）：
 * 仓库未开启 allowJs，缺本文件时 TS 把实现当隐式 any。改 .mjs 导出时必须同步本文件。
 */

export type PythonHostTriple =
  | "x86_64-pc-windows-msvc"
  | "aarch64-pc-windows-msvc"
  | "x86_64-unknown-linux-gnu"
  | "aarch64-unknown-linux-gnu"
  | "x86_64-apple-darwin"
  | "aarch64-apple-darwin";

export interface PythonHostAsset {
  readonly archive: string;
  readonly sha256: string;
}

export declare const PYTHON_RELEASE_TAG: "20261110";
export declare const PYTHON_VERSION: "3.12.16";
export declare const PYTHON_RUNTIME_ID: `cpython-${string}+${string}`;
export declare const PYTHON_RELEASE_BASE_URL: string;
export declare const PYTHON_RUNTIME_ASSETS: Readonly<
  Record<PythonHostTriple, PythonHostAsset>
>;
export declare function resolvePythonHostTriple(
  platform: NodeJS.Platform,
  arch: string,
): PythonHostTriple | undefined;
