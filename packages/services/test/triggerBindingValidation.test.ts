// 触发器绑定会话身份校验回归（2026-11-22 第十一批）：worker 订阅者的陈旧绑定
// （归属修正/清绑后引擎未重启，旧 master 材料会话仍在绑定表）必须被识别为陈旧，
// 事件改投新建的订阅者身份会话；master 订阅者不校验；判定失败 fail-open 在调用侧。
import { describe, expect, it } from "vitest";
import { isStaleWorkerTriggerBinding } from "#src/trigger-engine/binding-validation.js";

describe("isStaleWorkerTriggerBinding", () => {
  it("worker 订阅者 + 绑定行无 workerId（旧 master 材料会话）→ 陈旧", () => {
    expect(isStaleWorkerTriggerBinding("wkr-5a67dec7", null)).toBe(true);
    expect(isStaleWorkerTriggerBinding("wkr-5a67dec7", undefined)).toBe(true);
  });

  it("worker 订阅者 + 绑定行属于其他 worker → 陈旧", () => {
    expect(isStaleWorkerTriggerBinding("wkr-5a67dec7", "wkr-d50c0cfa")).toBe(true);
  });

  it("worker 订阅者 + 绑定行身份一致 → 有效", () => {
    expect(isStaleWorkerTriggerBinding("wkr-5a67dec7", "wkr-5a67dec7")).toBe(false);
  });

  it("master 订阅者不校验（绑定会话无 workerId 属正常形态）", () => {
    expect(isStaleWorkerTriggerBinding(undefined, null)).toBe(false);
    expect(isStaleWorkerTriggerBinding(undefined, "wkr-5a67dec7")).toBe(false);
  });
});
