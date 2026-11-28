/**
 * message-origin 模块清单（architecture-governance managed 模块）。
 * 层：app（跨包单模块：shared 协议 schema + core provider 渲染注入）。
 * 修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const messageOriginModule = {
  id: "message-origin",
  requires: ["shared", "robindone-cli"],
  provides: ["message-origin"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
