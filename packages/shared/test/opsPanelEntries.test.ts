import { describe, expect, it } from "vitest";
import {
  formatOpsEntryId,
  OPS_PANEL_EVENT_BY_KIND,
  opsAgentIdOfAuthor,
  opsAuthorForAgent,
  opsAuthorOfActor,
  opsPanelActorSchema,
  opsPanelEntrySchema,
  opsPanelQueueViewSchema,
  parseOpsEntryKind,
  type OpsPanelEntry,
} from "../src/ops-panel/entries.js";

function requirementEntry(overrides: Partial<OpsPanelEntry> = {}): OpsPanelEntry {
  return {
    kind: "requirement",
    id: "REQ-0001",
    title: "给面板加导出",
    body: "希望面板支持导出快照",
    author: "user",
    // 2026-11-24 录入与来源拆分：代录条目 author=user、recordedBy=master。
    recordedBy: "master",
    status: "submitted",
    createdAt: "2026-11-24T00:00:00.000Z",
    updatedAt: "2026-11-24T00:00:00.000Z",
    ...overrides,
  } as OpsPanelEntry;
}

describe("ops-panel entries", () => {
  it("编号编解码互逆且带 kind 前缀", () => {
    expect(formatOpsEntryId("requirement", 1)).toBe("REQ-0001");
    expect(formatOpsEntryId("approval", 12)).toBe("APP-0012");
    expect(formatOpsEntryId("feedback", 9999)).toBe("FBK-9999");
    expect(formatOpsEntryId("feedback", 10000)).toBe("FBK-10000");
    expect(parseOpsEntryKind("REQ-0001")).toBe("requirement");
    expect(parseOpsEntryKind("APP-0002")).toBe("approval");
    expect(parseOpsEntryKind("FBK-0003")).toBe("feedback");
    expect(parseOpsEntryKind("trg-ops-panel")).toBeNull();
    expect(parseOpsEntryKind("REQ-1")).toBeNull();
  });

  it("作者派生：worker 会话带 wkr-id，master/用户侧为 master；user 不映射智能体", () => {
    expect(opsAuthorForAgent()).toBe("master");
    expect(opsAuthorForAgent("wkr-3854d87a")).toBe("worker:wkr-3854d87a");
    expect(opsAgentIdOfAuthor("user")).toBeNull();
    expect(opsAgentIdOfAuthor("master")).toBe("master");
    expect(opsAgentIdOfAuthor("worker:wkr-3854d87a")).toBe("wkr-3854d87a");
  });

  it("kind → 唤醒事件名映射覆盖三类；approval.created 不是唤醒事件", () => {
    expect(OPS_PANEL_EVENT_BY_KIND.requirement).toBe("requirement.created");
    expect(OPS_PANEL_EVENT_BY_KIND.approval).toBe("approval.decided");
    expect(OPS_PANEL_EVENT_BY_KIND.feedback).toBe("feedback.created");
    expect(Object.values(OPS_PANEL_EVENT_BY_KIND)).not.toContain("approval.created");
  });

  it("requirement 条目：submitted 合法；disposed 缺 outcome 被拒", () => {
    expect(opsPanelEntrySchema.safeParse(requirementEntry()).success).toBe(true);
    const disposed = opsPanelEntrySchema.safeParse(
      requirementEntry({ status: "disposed", decidedAt: "2026-11-24T01:00:00.000Z" }),
    );
    expect(disposed.success).toBe(false);
    expect(
      opsPanelEntrySchema.safeParse(
        requirementEntry({
          status: "disposed",
          outcome: "accepted",
          note: "进入排期",
          decidedAt: "2026-11-24T01:00:00.000Z",
        }),
      ).success,
    ).toBe(true);
  });

  it("三种 kind 判别解析；作者格式非法被拒", () => {
    const approval = opsPanelEntrySchema.safeParse({
      kind: "approval",
      id: "APP-0001",
      title: "尝试新的队列实现",
      body: "方向：批量合并唤醒",
      author: "master",
      recordedBy: "master",
      status: "pending_review",
      createdAt: "2026-11-24T00:00:00.000Z",
      updatedAt: "2026-11-24T00:00:00.000Z",
    });
    expect(approval.success).toBe(true);
    const feedback = opsPanelEntrySchema.safeParse({
      kind: "feedback",
      id: "FBK-0001",
      title: "文档有点滞后",
      body: "触发器文档与实现不一致",
      author: "worker:wkr-3854d87a",
      recordedBy: "worker:wkr-3854d87a",
      status: "submitted",
      createdAt: "2026-11-24T00:00:00.000Z",
      updatedAt: "2026-11-24T00:00:00.000Z",
    });
    expect(feedback.success).toBe(true);
    const badAuthor = opsPanelEntrySchema.safeParse(requirementEntry({ author: "nobody" }));
    expect(badAuthor.success).toBe(false);
    // recordedBy 同词表校验。
    expect(opsPanelEntrySchema.safeParse(requirementEntry({ recordedBy: "nobody" })).success).toBe(
      false,
    );
  });

  it("strict 拒绝未知字段与错位状态（requirement 不能用 approval 状态）", () => {
    expect(
      opsPanelEntrySchema.safeParse(requirementEntry({ status: "approved" as never })).success,
    ).toBe(false);
    const extra = requirementEntry() as Record<string, unknown>;
    extra.mystery = true;
    expect(opsPanelEntrySchema.safeParse(extra).success).toBe(false);
  });

  it("actor 词表：user 与 agent 两种形态；作者投影正确", () => {
    expect(opsPanelActorSchema.safeParse({ role: "user" }).success).toBe(true);
    expect(opsPanelActorSchema.safeParse({ role: "agent", agentId: "master" }).success).toBe(true);
    expect(
      opsPanelActorSchema.safeParse({
        role: "agent",
        agentId: "worker:wkr-3854d87a",
      }).success,
    ).toBe(true);
    expect(opsPanelActorSchema.safeParse({ role: "agent", agentId: "nobody" }).success).toBe(false);
    expect(opsAuthorOfActor({ role: "user" })).toBe("user");
    expect(opsAuthorOfActor({ role: "agent", agentId: "master" })).toBe("master");
  });

  it("队列投影：inFlight 可空、pending 有序", () => {
    const queue = opsPanelQueueViewSchema.safeParse({
      inFlightId: "REQ-0001",
      pendingIds: ["REQ-0002", "FBK-0001"],
    });
    expect(queue.success).toBe(true);
    expect(opsPanelQueueViewSchema.safeParse({ inFlightId: null, pendingIds: [] }).success).toBe(
      true,
    );
  });
});
