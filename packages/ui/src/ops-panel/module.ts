/**
 * ops-panel UI 模块清单（architecture-governance managed 模块）。
 * 层：ui（依赖本模块 contract 语义 + shared 协议 + accessor 可选服务；服务实例
 * 由 WorkspaceShellLayout 装配传入，UI 不 import services 实现）。
 * 修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const opsPanelUiModule = {
  id: "ops-panel-ui",
  requires: ["ui"],
  provides: ["ops-panel-ui"],
  publicEntrypoints: ["index.ts", "OpsPanelPage.tsx"],
} as const;
