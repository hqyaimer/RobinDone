/**
 * trigger-system 模块清单（architecture-governance managed 模块）。
 * 层：app（跨包单模块：shared 协议 + contracts/core 工具面 + services/host 引擎）。
 * 修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const triggerSystemModule = {
  id: "trigger-system",
  requires: ["shared", "services", "session", "robinrun-cli"],
  provides: ["trigger-system"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
