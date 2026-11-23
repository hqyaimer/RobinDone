/**
 * auto-session-default-mode 模块清单（architecture-governance managed 模块）。
 * 范围：自动创建会话（触发器/ContactAgent 派发等宿主路径）的权限模式缺省解析。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const autoSessionDefaultModeModule = {
  id: "auto-session-default-mode",
  // services：缺省解析复用同包 setting 模块的 AppSettings 注册表（contract.example.ts
  // 引用 globalComposerMode 的项目确认语义作示例输入）。
  requires: ["shared", "services"],
  provides: ["auto-session-default-mode"],
  publicEntrypoints: ["contract.ts"],
} as const;
