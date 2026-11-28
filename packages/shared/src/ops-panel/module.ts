/**
 * ops-panel 模块清单（architecture-governance managed 模块）。
 * 层：domain（跨包单模块的 shared 协议层；services/contracts/core/UI 各包本体
 * 由 ops-panel 总模块统一登记，见 architecture-policy.yaml）。
 * 修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const opsPanelModule = {
  id: "ops-panel",
  requires: ["shared", "services", "session", "robindone-cli", "ui"],
  provides: ["ops-panel"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
