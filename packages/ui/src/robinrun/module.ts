/**
 * robinrun-launcher 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const robinrunLauncherModule = {
  id: "robinrun-launcher",
  requires: ["shared", "ui"],
  provides: ["robinrun-launcher"],
  publicEntrypoints: ["RobinRunLauncher.tsx", "projectRegistry.ts", "contract.ts"],
} as const;
