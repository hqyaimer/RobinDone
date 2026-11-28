/**
 * worker-roster 模块清单（architecture-governance managed 模块）。
 * 层：app（跨包单模块：shared 协议 + services 加载器 + contracts/core 工具面）。
 * 修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const workerRosterModule = {
  id: "worker-roster",
  requires: ["shared", "services", "robindone-cli"],
  provides: ["worker-roster"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
