// 触发器专属会话说明回归（2026-11-22 第十一批）：订阅者=本会话本人 + 禁止向订阅者
// 自己的 wkr-id 自我派发（实测：worker 触发器会话把事件 ContactAgent 派回订阅者本人，
// 寻址零耦合下新建其普通会话，表现为"触发器 contact 自己"）。
import { describe, expect, it } from "vitest";
import { buildTriggerSessionSection } from "../src/context/dynamic-sections.js";

describe("buildTriggerSessionSection 防自我派发", () => {
  it("说明段包含订阅者=本人与禁止自我派发约束，且 README 全文随行", () => {
    const section = buildTriggerSessionSection("# Trigger: inbox-watch\n\npurpose body");
    expect(section.source).toBe("trigger_session_context");
    expect(section.content).toContain("This session IS the subscriber agent's own dedicated session");
    expect(section.content).toContain("Never ContactAgent the subscriber's own worker id");
    expect(section.content).toContain("opens a NEW plain session");
    // README 正文原样随行（压缩后仍注入的既有契约）。
    expect(section.content).toContain("# Trigger: inbox-watch");
    expect(section.content).toContain("purpose body");
  });
});
