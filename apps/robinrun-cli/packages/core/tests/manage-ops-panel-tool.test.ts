import { describe, expect, it } from "vitest";
import {
  MANAGE_OPS_PANEL_TOOL_NAME,
  MANAGE_OPS_PANEL_MASTER_ACTIONS,
  MANAGE_OPS_PANEL_WORKER_ACTIONS,
  ManageOpsPanelInputSchema,
  ManageOpsPanelOutputSchema,
  type OpsPanelRuntimePort,
  type OpsPanelPortView,
  WorkerManageOpsPanelInputSchema,
} from "@robinrun/contracts";
import {
  manageOpsPanelToolEntry,
  workerManageOpsPanelToolEntry,
  manageOpsPanelHandler,
  workerManageOpsPanelHandler,
} from "../src/tool/handlers/manage-ops-panel.js";
import { SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS } from "../src/subagent/tool-policy.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

// 需求/审批/反馈面板（2026-11-24 MVP）：handler 是身份派生 + 端口投递的薄层——
// 测试守身份派生（机制层）、动作路由（schema 判别）与端口缺席报错；权限矩阵与
// worker 可见性过滤在 host 服务层（opsPanelService.test.ts 覆盖）。

const MASTER_VIEW: OpsPanelPortView = {
  entries: [
    {
      kind: "requirement",
      id: "REQ-0001",
      title: "Fix landing page",
      body: "The hero banner overlaps the nav bar.",
      author: "user",
      status: "submitted",
      createdAt: "2026-11-24T00:00:00.000Z",
      updatedAt: "2026-11-24T00:00:00.000Z",
    },
  ],
  queue: { inFlightId: "REQ-0001", pendingIds: ["REQ-0002"] },
};

function createPort(overrides: Partial<OpsPanelRuntimePort> = {}): OpsPanelRuntimePort {
  return {
    async listEntries() {
      return MASTER_VIEW;
    },
    async getEntry() {
      return { entry: MASTER_VIEW.entries[0] };
    },
    async createEntry() {
      return { entry: MASTER_VIEW.entries[0] };
    },
    async decideRequirement() {
      return { entry: MASTER_VIEW.entries[0] };
    },
    async resolveFeedback() {
      return { entry: MASTER_VIEW.entries[0] };
    },
    async acknowledgeApproval() {
      return { entry: MASTER_VIEW.entries[0] };
    },
    async getProgressView() {
      return { entries: [] };
    },
    async appendProgress() {
      return { entry: MASTER_VIEW.entries[0] };
    },
    async updateProgress() {
      return { entry: MASTER_VIEW.entries[0] };
    },
    async deleteProgress() {
      return { id: "PRG-0001" };
    },
    ...overrides,
  };
}

function contextWith(
  workerIdentity: { workerId: string; workerName?: string } | undefined,
  port: OpsPanelRuntimePort | undefined,
): ToolExecutionContext {
  return {
    toolCallId: "tool_test",
    traceId: "trace_test",
    abortSignal: new AbortController().signal,
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
    sessionId: "sess_test",
    ...(workerIdentity !== undefined ? { workerIdentity } : {}),
    ...(port !== undefined ? { opsPanelRuntimePort: port } : {}),
  } as ToolExecutionContext;
}

describe("ManageOpsPanel tool", () => {
  it("registers master and worker variants under the same tool name", () => {
    expect(manageOpsPanelToolEntry.metadata.name).toBe(MANAGE_OPS_PANEL_TOOL_NAME);
    expect(workerManageOpsPanelToolEntry.metadata.name).toBe(MANAGE_OPS_PANEL_TOOL_NAME);
    // 双变体是两个不同对象（注册门按引用区分），schema 动作面不同。
    expect(manageOpsPanelToolEntry).not.toBe(workerManageOpsPanelToolEntry);
    const masterActions = MANAGE_OPS_PANEL_MASTER_ACTIONS;
    const workerActions = MANAGE_OPS_PANEL_WORKER_ACTIONS;
    expect(masterActions).toContain("create_requirement");
    expect(masterActions).toContain("decide_requirement");
    expect(masterActions).toContain("acknowledge_approval");
    expect(workerActions).not.toContain("create_requirement");
    expect(workerActions).not.toContain("decide_requirement");
    expect(workerActions).not.toContain("create_approval");
    // 面板工具面不进临时 subagent（只向创建者汇报，且无 workerIdentity 会被误判成 master）。
    expect(SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS).toContain(MANAGE_OPS_PANEL_TOOL_NAME);
  });

  it("rejects when the ops panel port is missing (standalone CLI)", async () => {
    await expect(
      manageOpsPanelHandler({ action: "list" }, contextWith(undefined, undefined)),
    ).rejects.toThrow(/opsPanelRuntimePort missing/);
    await expect(
      workerManageOpsPanelHandler({ action: "list" }, contextWith({ workerId: "wkr-1" }, undefined)),
    ).rejects.toThrow(/opsPanelRuntimePort missing/);
  });

  it("derives the master actor from the session identity and routes list to the port", async () => {
    const seen: Array<{ actor?: unknown; sessionId?: string }> = [];
    const port = createPort({
      async listEntries(request) {
        seen.push({ actor: request.actor, sessionId: request.sessionId });
        return MASTER_VIEW;
      },
    });
    const result = (await manageOpsPanelHandler(
      { action: "list" },
      contextWith(undefined, port),
    )) as OpsPanelPortView;
    // master 会话（无 workerIdentity）→ actor=master；sessionId 取自机制层 context。
    expect(seen[0]).toEqual({ actor: { role: "agent", agentId: "master" }, sessionId: "sess_test" });
    expect(result.queue).toEqual(MASTER_VIEW.queue);
    expect(result.entries).toHaveLength(1);
  });

  it("derives the worker actor from the worker identity on the worker variant", async () => {
    const seen: Array<{ actor?: unknown; kind?: string; title?: string }> = [];
    const port = createPort({
      async createEntry(request) {
        seen.push({ actor: request.actor, kind: request.kind, title: request.title });
        return { entry: MASTER_VIEW.entries[0] };
      },
    });
    await workerManageOpsPanelHandler(
      { action: "create_feedback", title: "Scanner misses page 2", body: "Pagination stops after page 1." },
      contextWith({ workerId: "wkr-ops" }, port),
    );
    expect(seen[0]).toEqual({
      actor: { role: "agent", agentId: "worker:wkr-ops" },
      kind: "feedback",
      title: "Scanner misses page 2",
    });
  });

  it("routes master-only actions to their port methods with action fields", async () => {
    const calls: string[] = [];
    const payload: Array<Record<string, unknown>> = [];
    const port = createPort({
      async decideRequirement(request) {
        calls.push("decideRequirement");
        payload.push({ entryId: request.entryId, outcome: request.outcome, note: request.note });
        return { entry: MASTER_VIEW.entries[0] };
      },
      async acknowledgeApproval(request) {
        calls.push("acknowledgeApproval");
        payload.push({ entryId: request.entryId, note: request.note });
        return { entry: MASTER_VIEW.entries[0] };
      },
      async resolveFeedback(request) {
        calls.push("resolveFeedback");
        payload.push({ entryId: request.entryId });
        return { entry: MASTER_VIEW.entries[0] };
      },
      async createEntry(request) {
        calls.push("createEntry");
        payload.push({ kind: request.kind, author: request.author });
        return { entry: MASTER_VIEW.entries[0] };
      },
    });
    const ctx = contextWith(undefined, port);
    await manageOpsPanelHandler(
      { action: "decide_requirement", entryId: "REQ-0001", outcome: "accepted", note: "scoped to P4" },
      ctx,
    );
    await manageOpsPanelHandler({ action: "acknowledge_approval", entryId: "APP-0001" }, ctx);
    await manageOpsPanelHandler({ action: "resolve_feedback", entryId: "FBK-0001" }, ctx);
    await manageOpsPanelHandler(
      { action: "create_approval", title: "Try new comment pipeline", body: "Draft proposal." },
      ctx,
    );
    // 对话代录（2026-11-24）：create_requirement 恒 user 来源、create_feedback 显式 author。
    await manageOpsPanelHandler(
      { action: "create_requirement", title: "Landing page rework", body: "User asked for a new hero layout." },
      ctx,
    );
    await manageOpsPanelHandler(
      {
        action: "create_feedback",
        title: "Comment spam rising",
        body: "User reported spam waves.",
        author: "user",
      },
      ctx,
    );
    expect(calls).toEqual([
      "decideRequirement",
      "acknowledgeApproval",
      "resolveFeedback",
      "createEntry",
      "createEntry",
      "createEntry",
    ]);
    expect(payload[0]).toEqual({ entryId: "REQ-0001", outcome: "accepted", note: "scoped to P4" });
    expect(payload[1]).toEqual({ entryId: "APP-0001", note: undefined });
    expect(payload[2]).toEqual({ entryId: "FBK-0001" });
    expect(payload[3]).toEqual({ kind: "approval", author: undefined });
    expect(payload[4]).toEqual({ kind: "requirement", author: undefined });
    expect(payload[5]).toEqual({ kind: "feedback", author: "user" });
  });

  it("rejects master-only actions on the worker variant schema and missing required fields", () => {
    // worker 变体 schema 收不到 master 动作（模型面上不存在，硬传也拒）。
    expect(
      WorkerManageOpsPanelInputSchema.safeParse({ action: "decide_requirement", entryId: "REQ-0001" })
        .success,
    ).toBe(false);
    // get / create_feedback 的必填字段缺省被 superRefine 拒绝。
    expect(WorkerManageOpsPanelInputSchema.safeParse({ action: "get" }).success).toBe(false);
    expect(WorkerManageOpsPanelInputSchema.safeParse({ action: "create_feedback" }).success).toBe(false);
    expect(ManageOpsPanelInputSchema.safeParse({ action: "get" }).success).toBe(false);
    expect(
      ManageOpsPanelInputSchema.safeParse({ action: "decide_requirement", entryId: "REQ-0001" }).success,
    ).toBe(false);
    expect(
      ManageOpsPanelInputSchema.safeParse({ action: "create_approval", title: "t" }).success,
    ).toBe(false);
    // 对话代录 schema 门：create_feedback 缺 author 拒；author 越界动作拒。
    expect(
      ManageOpsPanelInputSchema.safeParse({
        action: "create_feedback",
        title: "t",
        body: "b",
      }).success,
    ).toBe(false);
    expect(
      ManageOpsPanelInputSchema.safeParse({
        action: "create_feedback",
        title: "t",
        body: "b",
        author: "user",
      }).success,
    ).toBe(true);
    expect(
      ManageOpsPanelInputSchema.safeParse({
        action: "create_requirement",
        title: "t",
        body: "b",
        author: "user",
      }).success,
    ).toBe(false);
  });

  // ---- 进度账本（2026-11-25，specs/progress-ledger.md）：P1-1 回归 ----
  // 端口返回是协议形状（{entries}/{entry}/{id}，承载进度条目），handler 必须重映射到
  // 工具输出 schema 的专用字段（progressEntries/progressEntry/deletedProgressId）——
  // 输出的 entries/entry 是工作项判别 union（strict），进度条目原样挂上去会被
  // runtimeOutputSchema 拒收（实测缺陷：变更已生效但响应损坏，3/4 动作不可用）。
  const PROGRESS_ENTRY = {
    id: "PRG-0001",
    title: "项目初始化",
    createdBy: "system",
    createdAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:00:00.000Z",
  };

  it("remaps list_progress port result to progressEntries and passes the strict output schema (P1-1)", async () => {
    const port = createPort({
      async getProgressView() {
        return { entries: [PROGRESS_ENTRY] };
      },
    });
    const result = (await manageOpsPanelHandler(
      { action: "list_progress" },
      contextWith(undefined, port),
    )) as Record<string, unknown>;
    expect(result).toEqual({ progressEntries: [PROGRESS_ENTRY] });
    expect(() => ManageOpsPanelOutputSchema.parse(result)).not.toThrow();
  });

  it("remaps append/update to progressEntry and delete to deletedProgressId (P1-1)", async () => {
    const port = createPort({
      async appendProgress(request) {
        expect(request.title).toBe("里程碑");
        expect(request.links).toEqual(["a.md"]);
        return {
          entry: { ...PROGRESS_ENTRY, id: "PRG-0002", title: request.title, createdBy: "master" },
        };
      },
      async updateProgress() {
        return { entry: { ...PROGRESS_ENTRY, title: "修正" } };
      },
      async deleteProgress(request) {
        return { id: request.entryId };
      },
    });
    const appended = (await manageOpsPanelHandler(
      { action: "append_progress", title: "里程碑", body: "d", links: ["a.md"] },
      contextWith(undefined, port),
    )) as Record<string, unknown>;
    expect(() => ManageOpsPanelOutputSchema.parse(appended)).not.toThrow();
    expect(appended.progressEntry).toMatchObject({ id: "PRG-0002", createdBy: "master" });

    const updated = (await manageOpsPanelHandler(
      { action: "update_progress", entryId: "PRG-0001", body: "" },
      contextWith(undefined, port),
    )) as Record<string, unknown>;
    expect(() => ManageOpsPanelOutputSchema.parse(updated)).not.toThrow();

    const deleted = (await manageOpsPanelHandler(
      { action: "delete_progress", entryId: "PRG-0002" },
      contextWith(undefined, port),
    )) as Record<string, unknown>;
    expect(deleted).toEqual({ deletedProgressId: "PRG-0002" });
    expect(() => ManageOpsPanelOutputSchema.parse(deleted)).not.toThrow();
  });

  it("update_progress accepts empty body (clear semantics) while create/append reject it (P2-5)", () => {
    expect(
      ManageOpsPanelInputSchema.safeParse({
        action: "update_progress",
        entryId: "PRG-0001",
        body: "",
      }).success,
    ).toBe(true);
    expect(
      ManageOpsPanelInputSchema.safeParse({
        action: "create_feedback",
        title: "t",
        body: "",
        author: "user",
      }).success,
    ).toBe(false);
    expect(
      ManageOpsPanelInputSchema.safeParse({ action: "append_progress", title: "t", body: "" })
        .success,
    ).toBe(false);
  });
});
