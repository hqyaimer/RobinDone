// 自动创建会话的权限缺省解析（2026-11-22，P3 第十三批）：解析规则锁死——项目确认
// 完全访问 > 全局显式选择（edit/guarded）；全局 yolo 未经项目确认不自动升级（门控）；
// build/缺席 → undefined = CLI 缺省 build。解析链依据见 contract.ts 文件头。
import { describe, expect, it } from "vitest";
import { resolveAutoSessionDefaultMode } from "#src/robinrun-agent/auto-session-default-mode/contract.js";

const WORKSPACE = "E:\\ws\\proj";

function settings(overrides?: {
  globalComposerMode?: "build" | "edit" | "guarded" | "yolo";
  confirmedPaths?: string[];
}) {
  return {
    ...(overrides?.globalComposerMode ? { globalComposerMode: overrides.globalComposerMode } : {}),
    ...(overrides?.confirmedPaths
      ? {
          robinrunProjects: overrides.confirmedPaths.map((path) => ({
            id: "p-" + path,
            name: "p",
            path,
            createdAt: 0,
            lastOpenedAt: 0,
            fullAccessConfirmedAt: 1,
          })),
        }
      : {}),
  };
}

describe("resolveAutoSessionDefaultMode（自动会话权限继承）", () => {
  it("项目确认过完全访问 → yolo（项目默认优先，全局值不覆盖）", () => {
    expect(
      resolveAutoSessionDefaultMode({
        settings: settings({ globalComposerMode: "edit", confirmedPaths: [WORKSPACE] }),
        workspacePath: WORKSPACE,
      }),
    ).toBe("yolo");
  });

  it("全局显式选择 edit / guarded → 照用（无需项目确认）", () => {
    expect(
      resolveAutoSessionDefaultMode({
        settings: settings({ globalComposerMode: "edit" }),
        workspacePath: WORKSPACE,
      }),
    ).toBe("edit");
    expect(
      resolveAutoSessionDefaultMode({
        settings: settings({ globalComposerMode: "guarded" }),
        workspacePath: WORKSPACE,
      }),
    ).toBe("guarded");
  });

  it("全局 yolo 但项目未确认 → undefined（门控：不静默升级到完全访问）", () => {
    expect(
      resolveAutoSessionDefaultMode({
        settings: settings({ globalComposerMode: "yolo" }),
        workspacePath: WORKSPACE,
      }),
    ).toBeUndefined();
  });

  it("全局 yolo 且项目已确认 → yolo（确认弹窗背书）", () => {
    expect(
      resolveAutoSessionDefaultMode({
        settings: settings({ globalComposerMode: "yolo", confirmedPaths: [WORKSPACE] }),
        workspacePath: WORKSPACE,
      }),
    ).toBe("yolo");
  });

  it("项目确认按工作区路径匹配，其他项目的确认不串扰", () => {
    expect(
      resolveAutoSessionDefaultMode({
        settings: settings({ confirmedPaths: ["E:\\ws\\other"] }),
        workspacePath: WORKSPACE,
      }),
    ).toBeUndefined();
  });

  it("全局 build / 设置缺席 → undefined（CLI 缺省 build，语义保持无显式 mode）", () => {
    expect(
      resolveAutoSessionDefaultMode({
        settings: settings({ globalComposerMode: "build" }),
        workspacePath: WORKSPACE,
      }),
    ).toBeUndefined();
    expect(resolveAutoSessionDefaultMode({ workspacePath: WORKSPACE })).toBeUndefined();
    expect(
      resolveAutoSessionDefaultMode({ settings: null, workspacePath: WORKSPACE }),
    ).toBeUndefined();
  });
});
