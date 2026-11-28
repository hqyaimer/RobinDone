// ============================================================
// 自动创建会话的权限模式缺省解析（2026-11-22，P3 第十三批）
// ============================================================
// 触发器投递 / ContactAgent 派发 / cron 兜底 / off-peak 等宿主侧自动创建的会话不经过
// UI 草稿，params.mode 缺席时此前直接落 CLI 缺省 build——用户在任意会话显式选择的
// 全局权限（P3 第六批裁决"全局统一继承"）只存在于渲染进程 localStorage，宿主读不到。
// 2026-11-22 全局键升格为 AppSettings.globalComposerMode（宿主可读），本模块是它在
// 任务门面（createTask）的缺省解析规则；解析链与 UI 草稿链对齐（去掉 Recent 层）：
//
//   项目确认过完全访问（robindoneProjects[].fullAccessConfirmedAt）
//     → yolo（项目默认优先，与 UI 链 projectDefaultMode 先于 globalMode 同序）
//   否则全局显式选择 edit / guarded → 照用
//   否则（全局 build、全局 yolo 未过项目确认、缺席）→ undefined = CLI 缺省 build
//
// yolo 门控（2026-11-22 用户裁决）：全局选了完全访问但本项目从未确认过风险提示时，
// 自动会话不得静默升级到完全访问——确认弹窗只在 UI 手动切档时出现，项目未确认 =
// 无背书。显式传入的 mode（如 cron 配置、调用方指定）不经过本解析。

import type { AppSettings } from "@robindone/shared";

/** 自动创建会话可继承的权限模式值域（与 AppSettings["globalComposerMode"] 同域）。 */
export type AutoSessionDefaultMode = NonNullable<AppSettings["globalComposerMode"]>;

/** 解析所需的最小设置形状（结构化：测试与调用方无需依赖完整 AppSettings）。 */
export type AutoSessionModeSettings = Pick<AppSettings, "globalComposerMode" | "robindoneProjects">;

export function resolveAutoSessionDefaultMode(input: {
  settings?: AutoSessionModeSettings | null;
  workspacePath: string;
}): AutoSessionDefaultMode | undefined {
  // 项目条目按工作区根路径匹配（RobinDoneProjectEntry.path 即本地项目根）；
  // 远端/未登记工作区解析不到项目确认，仍可吃全局非 yolo 选择。
  const projectConfirmed = (input.settings?.robindoneProjects ?? []).some(
    (entry) => entry.path === input.workspacePath && entry.fullAccessConfirmedAt !== undefined,
  );
  if (projectConfirmed) return "yolo";
  const global = input.settings?.globalComposerMode;
  // build → undefined（CLI 缺省同值，保持"无显式 mode"语义）；yolo → undefined（门控，
  // 见文件头裁决）；plan 不在值域（写入侧已归一 build，zod 校验兜底）。
  return global === "edit" || global === "guarded" ? global : undefined;
}
