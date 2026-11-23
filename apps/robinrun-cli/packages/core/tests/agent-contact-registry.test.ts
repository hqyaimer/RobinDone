// agent 消息（2026-11-19，docs/trigger-system.md「agent 消息与会话感知系统」）：
// AgentContactRegistry 的等待/捕获/合成语义单测。
//  - wait：有等待者 → 工具结果交付；超时 → 请求保持 open（可再等）；unknown_request。
//  - 轮终态捕获：结算全部在途 needReply（按 agentId 或 sessionId 匹配），返回结算数。
//  - 合成回复解除：用户接管 / 轮次失败，无静默路径；重复调用幂等落空。
//  - 无等待者 → addUnwaitedReplySubscriber 订阅（发送方会话异步注入）。
// 2026-11-20 worker 会话同构化：master/worker 端口改经 AgentSessionDispatchPort 投递
// （Host 任务服务寻址创建/唤醒目标会话），进程共享登记表按接收方 sessionId 结算。
// 2026-11-21 裸投递：正文一律原文原样（零包装零转义），来源/回复语义走 <system-status>
// （host agentContactDispatch 随行 replyExpected）——本文件断言 dispatch 收到的 message
// 即原始正文；无等待者回复两个方向都统一走 dispatch。
import { describe, expect, it, vi } from "vitest";
import {
  AgentContactRegistry,
  agentContactRestartInterruptedReply,
  agentContactSessionClosedReply,
  createContactRequestId,
  createMasterAgentContactPort,
  createWorkerAgentContactPort,
} from "../src/subagent/agent-contact.js";
import type { AgentContactPersistedEntry } from "../src/subagent/agent-contact.js";
import type { SessionId } from "@robinrun/contracts";
import { createSessionId } from "@robinrun/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";

const MASTER = {
  kind: "master" as const,
  agentId: "sess_master",
  sessionId: "sess_master",
  agentType: "master",
  displayName: "master",
};

function workerSide(agentId: string, sessionId = `sess_${agentId}`) {
  return {
    kind: "worker" as const,
    agentId,
    sessionId,
    agentType: "wkr-abc12345",
    displayName: "测试",
  };
}

function registerPending(
  contacts: AgentContactRegistry,
  requestId: string,
  receiver = workerSide("agent_wkr_1"),
) {
  contacts.register({ requestId, sender: MASTER, receiver });
}

describe("AgentContactRegistry wait semantics", () => {
  it("delivers the reply to an active waiter and settles the entry", async () => {
    const contacts = new AgentContactRegistry();
    const requestId = createContactRequestId();
    registerPending(contacts, requestId);
    const pending = contacts.wait(requestId, 5_000);
    const settled = contacts.resolveReceiverReplies({
      receiverAgentId: "agent_wkr_1",
      reply: { text: "final output", sourceSessionId: "sess_child" },
    });
    expect(settled).toBe(1);
    await expect(pending).resolves.toEqual({
      status: "replied",
      requestId,
      text: "final output",
      sessionId: "sess_child",
    });
    // 已结算后再等待 → unknown_request（回复已交付，不会重放）。
    await expect(contacts.wait(requestId, 100)).resolves.toMatchObject({
      status: "unknown_request",
    });
  });

  it("keeps the request open on timeout so a later WaitReply can still receive it", async () => {
    const contacts = new AgentContactRegistry();
    const requestId = createContactRequestId();
    registerPending(contacts, requestId);
    await expect(contacts.wait(requestId, 20)).resolves.toMatchObject({ status: "timeout" });
    // 超时后回复才到 → 新的等待立即拿到。
    const second = contacts.wait(requestId, 5_000);
    contacts.resolveReceiverReplies({
      receiverAgentId: "agent_wkr_1",
      reply: { text: "late reply" },
    });
    await expect(second).resolves.toMatchObject({ status: "replied", text: "late reply" });
  });

  it("routes the un-waited reply through addUnwaitedReplySubscriber (async injection)", async () => {
    const contacts = new AgentContactRegistry();
    const injections: Array<{ requestId: string; text: string; senderKind: string }> = [];
    contacts.addUnwaitedReplySubscriber((entry, reply) => {
      injections.push({
        requestId: entry.requestId,
        text: reply.text,
        senderKind: entry.sender.kind,
      });
      return true;
    });
    const requestId = createContactRequestId();
    registerPending(contacts, requestId);
    const settled = contacts.resolveReceiverReplies({
      receiverAgentId: "agent_wkr_1",
      reply: { text: "no one waited" },
    });
    expect(settled).toBe(1);
    expect(injections).toEqual([{ requestId, text: "no one waited", senderKind: "master" }]);
  });

  it("stops propagating after the first subscriber claims the entry", () => {
    const contacts = new AgentContactRegistry();
    const claimed: string[] = [];
    contacts.addUnwaitedReplySubscriber(() => {
      claimed.push("first");
      return true;
    });
    contacts.addUnwaitedReplySubscriber(() => {
      claimed.push("second");
      return true;
    });
    const requestId = createContactRequestId();
    registerPending(contacts, requestId);
    contacts.resolveReceiverReplies({
      receiverAgentId: "agent_wkr_1",
      reply: { text: "claimed once" },
    });
    expect(claimed).toEqual(["first"]);
  });

  it("resolves synthetic replies for takeover and turn failure with idempotent re-entry", () => {
    const contacts = new AgentContactRegistry();
    const requestId = createContactRequestId();
    registerPending(contacts, requestId);
    const first = contacts.resolveReceiverSynthetic({
      receiverAgentId: "agent_wkr_1",
      receiverSessionId: "sess_agent_wkr_1",
      synthetic: {
        text: "taken over by the user",
        receiverDisplayName: "测试",
      },
    });
    expect(first).toBe(1);
    // 第二次解除（用户停 + 停止路径再触发）按幂等落空：条目已结算。
    const second = contacts.resolveReceiverSynthetic({
      receiverAgentId: "agent_wkr_1",
      synthetic: { text: "again", receiverDisplayName: "测试" },
    });
    expect(second).toBe(0);
  });

  it("matches receivers by session id as well as agent id", () => {
    const contacts = new AgentContactRegistry();
    const requestId = createContactRequestId();
    registerPending(contacts, requestId, workerSide("agent_wkr_2", "sess_child_2"));
    const settled = contacts.resolveReceiverReplies({
      receiverSessionId: "sess_child_2",
      reply: { text: "by session" },
    });
    expect(settled).toBe(1);
  });

  it("disposes the entry when delivery fails so later waits report unknown", async () => {
    const contacts = new AgentContactRegistry();
    const requestId = createContactRequestId();
    registerPending(contacts, requestId);
    contacts.disposeEntry(requestId);
    await expect(contacts.wait(requestId, 100)).resolves.toMatchObject({
      status: "unknown_request",
    });
  });

  it("rejects pending waits on dispose (session close)", async () => {
    const contacts = new AgentContactRegistry();
    const requestId = createContactRequestId();
    registerPending(contacts, requestId);
    const pending = contacts.wait(requestId, 5_000);
    contacts.dispose("Session runtime closed");
    await expect(pending).rejects.toThrow("Session runtime closed");
  });
});

describe("dispatch-based ports（worker 会话同构化 + 2026-11-21 裸投递）", () => {
  interface DispatchRecord {
    targetAgentId: string;
    targetSessionId?: string;
    senderKind: string;
    senderId?: string;
    senderDisplayName?: string;
    fromSessionId: string;
    needReply: boolean;
    message: string;
    trace?: unknown;
  }

  const ROOT_TRACE = { traceId: "t", spanId: "s" };

  function dispatchFixture() {
    const dispatches: DispatchRecord[] = [];
    const dispatch = vi.fn(async (request: DispatchRecord) => {
      dispatches.push({ ...request });
      return { status: "delivered" as const, sessionId: "sess_target" };
    });
    return { dispatchPort: { dispatch }, dispatch, dispatches };
  }

  it("master port delivers the bare message via the dispatch port and registers the receiver session", async () => {
    const contacts = new AgentContactRegistry();
    const { dispatchPort, dispatches } = dispatchFixture();
    const port = createMasterAgentContactPort({
      sessionId: "sess_master" as SessionId,
      rootTraceContext: { traceId: "t", spanId: "s" },
      dispatch: dispatchPort,
      contacts,
    });
    const result = await port.submit({
      requestId: createContactRequestId(),
      target: "wkr-abc12345",
      message: '<please check & report>{"text":"你好?"}</please>',
      needReply: true,
      trace: { traceId: "t", spanId: "s" },
    });
    expect(result.status).toBe("delivered");
    expect(result.sessionId).toBe("sess_target");
    // 裸投递：正文原文原样（零包装零转义，&quot; 伪影与 instruction 样板已退役）。
    expect(dispatches).toEqual([
      {
        targetAgentId: "wkr-abc12345",
        senderKind: "master",
        senderDisplayName: "master",
        fromSessionId: "sess_master",
        needReply: true,
        message: '<please check & report>{"text":"你好?"}</please>',
        trace: ROOT_TRACE,
      },
    ]);
    // needReply=true → 进程共享登记表登记接收方（sessionId = Host 回填的目标会话）。
    const entry = contacts.get(result.requestId);
    expect(entry?.receiver.sessionId).toBe("sess_target");
    // 轮终态捕获按接收方 sessionId 结算（worker 会话侧调用）；先挂等待者再结算。
    const pending = port.wait(result.requestId, 5_000);
    const settled = contacts.resolveReceiverReplies({
      receiverSessionId: "sess_target",
      reply: { text: "worker final output" },
    });
    expect(settled).toBe(1);
    await expect(pending).resolves.toMatchObject({
      status: "replied",
      text: "worker final output",
    });
  });

  it("master port registers the receiver with the roster display name (badge readability)", async () => {
    // 2026-11-22 实测修复：receiver.displayName 此前 = 裸 wkr-id，worker 回复注入 master
    // 会话时徽章渲染「工作者-wkr-xxxx」。登记时按名册解析显示名（miss 刷新快照重试一次）。
    const contacts = new AgentContactRegistry();
    const { dispatchPort } = dispatchFixture();
    const port = createMasterAgentContactPort({
      sessionId: "sess_master" as SessionId,
      rootTraceContext: { traceId: "t", spanId: "s" },
      dispatch: dispatchPort,
      contacts,
      resolveWorkerDisplayName: (workerId) =>
        workerId === "wkr-abc12345" ? "调研撰稿员" : undefined,
    });
    const result = await port.submit({
      requestId: createContactRequestId(),
      target: "wkr-abc12345",
      message: "please review the market report",
      needReply: true,
      trace: { traceId: "t", spanId: "s" },
    });
    expect(result.status).toBe("delivered");
    const entry = contacts.get(result.requestId);
    expect(entry?.receiver.displayName).toBe("调研撰稿员");
  });

  it("unwaited reply injection carries the roster display name as senderDisplayName", async () => {
    // 回投链端到端：无等待者回复经 dispatch 回投 master 会话时，senderDisplayName 必须是
    // 名册显示名（它经 Host sendPrompt 落成 <system-status>.senderName → UI 徽章）。
    const contacts = new AgentContactRegistry();
    const { dispatchPort, dispatches } = dispatchFixture();
    const port = createMasterAgentContactPort({
      sessionId: "sess_master" as SessionId,
      rootTraceContext: { traceId: "t", spanId: "s" },
      dispatch: dispatchPort,
      contacts,
      resolveWorkerDisplayName: () => "调研撰稿员",
    });
    await port.submit({
      requestId: createContactRequestId(),
      target: "wkr-abc12345",
      message: "please review",
      needReply: true,
      trace: { traceId: "t", spanId: "s" },
    });
    contacts.resolveReceiverReplies({
      receiverSessionId: "sess_target",
      reply: { text: "worker final output" },
    });
    const injection = dispatches.at(-1);
    expect(injection).toMatchObject({
      targetAgentId: "master",
      targetSessionId: "sess_master",
      senderKind: "worker",
      senderId: "wkr-abc12345",
      senderDisplayName: "调研撰稿员",
      message: "worker final output",
    });
  });

  it("reloads agent definitions once on roster miss before falling back to the raw id", async () => {
    // 建队即派工：同轮 ManageWorkers 建队后立即 ContactAgent——快照按 turn 冻结，
    // miss 时刷新一次再解析（与 Agent 工具的 reloadAgentDefinitions 同机制）。
    const contacts = new AgentContactRegistry();
    const { dispatchPort } = dispatchFixture();
    let refreshed = false;
    const reload = vi.fn(async () => {
      refreshed = true;
    });
    const port = createMasterAgentContactPort({
      sessionId: "sess_master" as SessionId,
      rootTraceContext: { traceId: "t", spanId: "s" },
      dispatch: dispatchPort,
      contacts,
      resolveWorkerDisplayName: () => (refreshed ? "运营专员" : undefined),
      reloadAgentDefinitions: reload,
    });
    const result = await port.submit({
      requestId: createContactRequestId(),
      target: "wkr-abc12345",
      message: "kick off",
      needReply: true,
      trace: { traceId: "t", spanId: "s" },
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(contacts.get(result.requestId)?.receiver.displayName).toBe("运营专员");
  });

  it("falls back to the raw wkr-id when no roster resolver is wired (legacy)", async () => {
    const contacts = new AgentContactRegistry();
    const { dispatchPort } = dispatchFixture();
    const port = createMasterAgentContactPort({
      sessionId: "sess_master" as SessionId,
      rootTraceContext: { traceId: "t", spanId: "s" },
      dispatch: dispatchPort,
      contacts,
    });
    const result = await port.submit({
      requestId: createContactRequestId(),
      target: "wkr-abc12345",
      message: "kick off",
      needReply: true,
      trace: { traceId: "t", spanId: "s" },
    });
    expect(contacts.get(result.requestId)?.receiver.displayName).toBe("wkr-abc12345");
  });

  it("master port rejects self-contact and surfaces dispatch failures", async () => {
    const contacts = new AgentContactRegistry();
    const { dispatchPort, dispatch } = dispatchFixture();
    const port = createMasterAgentContactPort({
      sessionId: "sess_master" as SessionId,
      rootTraceContext: { traceId: "t", spanId: "s" },
      dispatch: dispatchPort,
      contacts,
    });
    const self = await port.submit({
      requestId: createContactRequestId(),
      target: "master",
      message: "hi",
      needReply: true,
      trace: { traceId: "t", spanId: "s" },
    });
    expect(self.status).toBe("failed");
    dispatch.mockResolvedValueOnce({ status: "failed", error: "worker not in roster" });
    const miss = await port.submit({
      requestId: createContactRequestId(),
      target: "wkr-unknown1",
      message: "hi",
      needReply: true,
      trace: { traceId: "t", spanId: "s" },
    });
    expect(miss.status).toBe("failed");
    expect(miss.error).toContain("worker not in roster");
    // 投递失败不登记（无需清理）。
    expect(contacts.get(miss.requestId)).toBeUndefined();
  });

  it("worker port only targets master and carries the worker identity", async () => {
    const contacts = new AgentContactRegistry();
    const { dispatchPort, dispatches } = dispatchFixture();
    const port = createWorkerAgentContactPort({
      sessionId: "sess_wkr" as SessionId,
      workerId: "wkr-abc12345",
      workerName: "测试",
      dispatch: dispatchPort,
      contacts,
    });
    const result = await port.submit({
      requestId: createContactRequestId(),
      target: "master",
      message: "outside my duties",
      needReply: true,
      trace: { traceId: "t", spanId: "s" },
    });
    expect(result.status).toBe("delivered");
    expect(dispatches).toEqual([
      {
        targetAgentId: "master",
        senderKind: "worker",
        senderId: "wkr-abc12345",
        senderDisplayName: "测试",
        fromSessionId: "sess_wkr",
        needReply: true,
        message: "outside my duties",
      },
    ]);
    const workerToWorker = await port.submit({
      requestId: createContactRequestId(),
      target: "wkr-other001",
      message: "hi",
      needReply: true,
      trace: { traceId: "t", spanId: "s" },
    });
    expect(workerToWorker.status).toBe("failed");
  });

  it("routes unwaited replies through the dispatch port with the counterpart identity (bare text)", async () => {
    // master 发起方：worker 的无等待者回复投回 master 会话（sender 携带 worker 身份，
    // fromSessionId = worker 会话即回复来源）；worker 发起方：投回 worker 会话（sender=master）。
    // 两个方向都挂在 master port 订阅的同一张进程共享登记表上。
    const contacts = new AgentContactRegistry();
    const { dispatchPort, dispatches } = dispatchFixture();
    const port = createMasterAgentContactPort({
      sessionId: "sess_master" as SessionId,
      rootTraceContext: ROOT_TRACE,
      dispatch: dispatchPort,
      contacts,
    });
    void port;

    // worker 发起方向（master 侧接收 worker 的请求后无等待者回复）。
    contacts.register({
      requestId: "contact_worker_sender",
      sender: workerSide("agent_wkr_1", "sess_worker_1"),
      receiver: MASTER,
    });
    contacts.resolveReceiverReplies({
      receiverAgentId: MASTER.agentId,
      reply: { text: "master reply text" },
    });
    expect(dispatches).toEqual([
      {
        targetAgentId: "agent_wkr_1",
        targetSessionId: "sess_worker_1",
        senderKind: "master",
        senderDisplayName: "master",
        fromSessionId: "sess_master",
        needReply: false,
        message: "master reply text",
        trace: ROOT_TRACE,
      },
    ]);

    // master 发起方向：回复投回 master 自己的会话，来源身份取 receiver（worker 侧）。
    dispatches.length = 0;
    contacts.register({
      requestId: "contact_master_sender",
      sender: MASTER,
      receiver: workerSide("wkr-abc12345", "sess_worker_2"),
    });
    contacts.resolveReceiverReplies({
      receiverAgentId: "wkr-abc12345",
      reply: { text: "worker reply text" },
    });
    expect(dispatches).toEqual([
      {
        targetAgentId: "master",
        targetSessionId: "sess_master",
        senderKind: "worker",
        senderId: "wkr-abc12345",
        senderDisplayName: "测试",
        fromSessionId: "sess_worker_2",
        needReply: false,
        message: "worker reply text",
        trace: ROOT_TRACE,
      },
    ]);
  });

  it("worker port falls back to injecting unwaited replies when no master port is in process", async () => {
    const contacts = new AgentContactRegistry();
    const { dispatchPort, dispatches } = dispatchFixture();
    createWorkerAgentContactPort({
      sessionId: "sess_wkr" as SessionId,
      workerId: "wkr-abc12345",
      workerName: "测试",
      dispatch: dispatchPort,
      contacts,
    });
    contacts.register({
      requestId: "contact_fallback",
      sender: workerSide("agent_wkr_1", "sess_worker_1"),
      receiver: MASTER,
    });
    contacts.resolveReceiverReplies({
      receiverAgentId: MASTER.agentId,
      reply: { text: "fallback reply" },
    });
    expect(dispatches).toEqual([
      {
        targetAgentId: "agent_wkr_1",
        targetSessionId: "sess_worker_1",
        senderKind: "master",
        senderDisplayName: "master",
        fromSessionId: "sess_master",
        needReply: false,
        message: "fallback reply",
      },
    ]);
  });
});

// ============================================================
// 2026-11-22 needReply 回复静默丢失修复（docs/trigger-system.md 实施修订节）：
// 共享登记表归属语义——会话关闭按本会话边界结算，不得清空其他会话条目；
// 持久化钩子与进程重启的"重启中断"显式解约。
// ============================================================

describe("shared-registry session-close semantics（归属语义修订）", () => {
  it("settles receiver-side entries of the closing session with the session-closed notice, leaving other sessions' entries alive", () => {
    const contacts = new AgentContactRegistry();
    const injections: Array<{ requestId: string; text: string }> = [];
    contacts.addUnwaitedReplySubscriber((entry, reply) => {
      injections.push({ requestId: entry.requestId, text: reply.text });
      return true;
    });
    const closingId = createContactRequestId();
    const otherId = createContactRequestId();
    // 关闭会话是接收方（master 发起）+ 无关会话的条目（同样 master 发起）。
    contacts.register({
      requestId: closingId,
      sender: MASTER,
      receiver: workerSide("agent_wkr_1", "sess_closing"),
    });
    contacts.register({
      requestId: otherId,
      sender: MASTER,
      receiver: workerSide("agent_wkr_2", "sess_other"),
    });
    // 会话关闭 = 只结算本会话（作为接收方）的条目，合成"会话已关闭"解除。
    const settled = contacts.resolveReceiverSynthetic({
      receiverSessionId: "sess_closing",
      synthetic: {
        text: agentContactSessionClosedReply("测试"),
        receiverDisplayName: "测试",
      },
    });
    expect(settled).toBe(1);
    // 发送方收到显式解除通知（不再干等）。
    expect(injections).toEqual([{ requestId: closingId, text: agentContactSessionClosedReply("测试") }]);
    // 其他会话的条目原样存活——其轮终态捕获照常结算（这是被误清空 bug 杀死的场景）。
    expect(
      contacts.resolveReceiverReplies({
        receiverSessionId: "sess_other",
        reply: { text: "still alive" },
      }),
    ).toBe(1);
  });

  it("does not settle entries where the closing session is only the sender (reply stays deliverable)", () => {
    const contacts = new AgentContactRegistry();
    const dispatches: string[] = [];
    contacts.addUnwaitedReplySubscriber((_entry, reply) => {
      dispatches.push(reply.text ?? "");
      return true;
    });
    const requestId = createContactRequestId();
    // master 会话关闭时它发出的请求仍挂表：接收方（worker）稍后照常产出回复并注入
    // （Host 可冷恢复已关闭的发送方会话，回复不丢）。
    contacts.register({
      requestId,
      sender: MASTER,
      receiver: workerSide("agent_wkr_1", "sess_worker"),
    });
    // 以发送方会话 id 调"会话关闭"结算 → 不得误伤（它不是任何条目的接收方）。
    expect(
      contacts.resolveReceiverSynthetic({
        receiverSessionId: MASTER.sessionId,
        synthetic: { text: agentContactSessionClosedReply("master"), receiverDisplayName: "master" },
      }),
    ).toBe(0);
    // worker 回复照常结算并注入 master 会话。
    expect(
      contacts.resolveReceiverReplies({
        receiverSessionId: "sess_worker",
        reply: { text: "late reply" },
      }),
    ).toBe(1);
    expect(dispatches).toEqual(["late reply"]);
  });
});

describe("persistence + restart recovery（持久化与重启解约）", () => {
  function persistenceFixture() {
    const saves: AgentContactPersistedEntry[][] = [];
    const port = {
      load: vi.fn(() => undefined),
      save: vi.fn((entries: AgentContactPersistedEntry[]) => {
        saves.push(entries.map((entry) => structuredClone(entry)));
      }),
    };
    return { port, saves };
  }

  async function settleSaves() {
    // save 走串行链（fire-and-forget），让出微任务队列后断言。
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("persists unsettled entries on register and rewrites on settle", async () => {
    const contacts = new AgentContactRegistry();
    const { port, saves } = persistenceFixture();
    contacts.attachPersistence(port);
    const requestId = createContactRequestId();
    contacts.register({
      requestId,
      sender: MASTER,
      receiver: workerSide("agent_wkr_1", "sess_worker"),
    });
    const secondId = createContactRequestId();
    contacts.register({
      requestId: secondId,
      sender: MASTER,
      receiver: workerSide("agent_wkr_2", "sess_worker_2"),
    });
    contacts.resolveReceiverReplies({
      receiverSessionId: "sess_worker",
      reply: { text: "done" },
    });
    await settleSaves();
    // 挂载即空快照重写（恢复点清账）→ 登记一条 → 两条 → 结算一条后只剩未结算那条。
    expect(saves[0]).toEqual([]);
    expect(saves[1]).toHaveLength(1);
    expect(saves[2]).toHaveLength(2);
    expect(saves[saves.length - 1].map((entry) => entry.requestId)).toEqual([secondId]);
  });

  it("restoreRecovered settles recovered entries out-of-band with the restart-interrupted notice", async () => {
    const contacts = new AgentContactRegistry();
    const persisted: AgentContactPersistedEntry[] = [
      {
        requestId: "contact_recovered_1",
        createdAt: 1,
        sender: MASTER,
        receiver: workerSide("agent_wkr_1", "sess_worker"),
      },
    ];
    const settlements = contacts.restoreRecovered(persisted);
    expect(settlements).toHaveLength(1);
    expect(settlements[0].entry.requestId).toBe("contact_recovered_1");
    expect(settlements[0].text).toBe(agentContactRestartInterruptedReply("测试"));
    // 恢复条目不进活地图：不可等待、轮终态捕获不可再结算（重启即解约，新轮输出
    // 不得被误当旧请求回复）。
    expect(contacts.get("contact_recovered_1")).toBeUndefined();
    await expect(contacts.wait("contact_recovered_1", 10)).resolves.toMatchObject({
      status: "unknown_request",
    });
    expect(
      contacts.resolveReceiverReplies({
        receiverSessionId: "sess_worker",
        reply: { text: "new turn output" },
      }),
    ).toBe(0);
  });
});

describe("runtime close ownership（共享表不清空，私有表 dispose）", () => {
  const WORK_DIR = "/tmp/robinrun-agent-contact-ownership";

  function createSharedRuntime(sessionId: SessionId, registry: AgentContactRegistry) {
    return createTestAgentRuntime(
      sessionId,
      { workingDirectory: WORK_DIR },
      {
        eventStore: createTestSessionEventStore(),
        runtimeTaskRegistry: new InMemoryRuntimeTaskRegistry(),
        agentContactRegistry: registry,
      },
    );
  }

  it("closing an unrelated runtime keeps the shared registry intact; closing the receiver settles only its entries", async () => {
    const shared = new AgentContactRegistry();
    const injections: Array<{ requestId: string; text: string }> = [];
    shared.addUnwaitedReplySubscriber((entry, reply) => {
      injections.push({ requestId: entry.requestId, text: reply.text });
      return true;
    });
    const requestId = createContactRequestId();
    const receiverSessionId = createSessionId("agent-contact-ownership-receiver");
    shared.register({
      requestId,
      sender: MASTER,
      receiver: { ...workerSide("agent_wkr_1"), sessionId: receiverSessionId },
    });

    // 无关会话关闭（deps 注入共享表 → 归属=共享）：不得清空他人在途条目
    //（实测根因回归：resident 池逐出/短命子会话启停曾把全表清掉）。
    const unrelated = createSharedRuntime(
      createSessionId("agent-contact-ownership-unrelated"),
      shared,
    );
    await unrelated.closeOwnedWork();
    expect(shared.get(requestId)?.settled).toBe(false);

    // 接收方会话关闭：仅结算本会话条目，发送方收到"会话已关闭"合成通知。
    const receiver = createSharedRuntime(receiverSessionId, shared);
    await receiver.closeOwnedWork();
    expect(shared.get(requestId)?.settled).toBe(true);
    expect(injections).toEqual([
      { requestId, text: agentContactSessionClosedReply("the main agent (master)") },
    ]);
  });

  it("keeps the private-registry dispose semantics when the runtime owns its registry", async () => {
    // deps 不注入登记表 → runtime 自建私有实例 → closeOwnedWork 整体 dispose
    //（单会话/测试形态在途等待按取消收口，原语义保留）。
    const runtime = createTestAgentRuntime(
      createSessionId("agent-contact-ownership-private"),
      { workingDirectory: WORK_DIR },
      {
        eventStore: createTestSessionEventStore(),
        runtimeTaskRegistry: new InMemoryRuntimeTaskRegistry(),
      },
    );
    await expect(runtime.closeOwnedWork()).resolves.toBeUndefined();
  });
});
