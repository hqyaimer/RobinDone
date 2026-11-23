// ContactAgent 寻址零耦合（2026-11-21 实测裁决，docs/worker-session-model.md §2）：
// 显式 sessionId = 续聊该会话；缺省 = 一定新建会话（worker 目标带 worker 身份）；
// 不做"目标智能体最新会话"回退——触发器/协作会话的汇报曾因此静默落进 master 正在
// 聊天的最新会话（实测 bug）。显式地址失效按 failed 收口并提示省略 sessionId 新建。
import { describe, expect, it, vi } from "vitest";
import {
  dispatchAgentContactToTaskService,
  type AgentContactDispatchHostRequest,
  type AgentContactDispatchTaskService,
} from "#src/robinrun-agent/agentContactDispatch.js";

function makeTaskService(overrides?: Partial<AgentContactDispatchTaskService>) {
  const calls = {
    resumeTask: vi.fn(async () => undefined),
    createTask: vi.fn(async () => ({ taskId: "sess-new" })),
    sendPrompt: vi.fn(async () => undefined),
  };
  const service = { ...calls, ...overrides } as unknown as AgentContactDispatchTaskService;
  return { service, calls };
}

function baseRequest(
  overrides?: Partial<AgentContactDispatchHostRequest>,
): AgentContactDispatchHostRequest {
  return {
    workspacePath: "E:\\ws\\proj",
    targetAgentId: "master",
    fromSessionId: "sess-caller",
    senderKind: "master",
    senderDisplayName: "master",
    message: "hello",
    needReply: true,
    ...overrides,
  };
}

describe("ContactAgent 寻址（零耦合显式寻址）", () => {
  it("显式 sessionId：续聊该会话（resume+send），绝不新建", async () => {
    const { service, calls } = makeTaskService();
    const result = await dispatchAgentContactToTaskService(service, {
      ...baseRequest(),
      targetSessionId: "sess-target",
    });
    expect(result).toEqual({ status: "delivered", sessionId: "sess-target" });
    expect(calls.createTask).not.toHaveBeenCalled();
    expect(calls.resumeTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "sess-target" }),
    );
    expect(calls.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "sess-target", content: "hello" }),
    );
  });

  it("缺省 master 目标：一定新建会话（无 worker 身份、不查清单回退）", async () => {
    const { service, calls } = makeTaskService();
    const result = await dispatchAgentContactToTaskService(service, baseRequest());
    expect(result).toEqual({ status: "delivered", sessionId: "sess-new" });
    expect(calls.createTask).toHaveBeenCalledTimes(1);
    expect(calls.createTask.mock.calls[0]?.[0]).not.toHaveProperty("agentIdentity");
    expect(calls.sendPrompt).toHaveBeenCalledWith(expect.objectContaining({ taskId: "sess-new" }));
  });

  it("缺省 wkr-* 目标：新建带 worker 身份的会话", async () => {
    const { service, calls } = makeTaskService();
    await dispatchAgentContactToTaskService(
      service,
      baseRequest({ targetAgentId: "wkr-ops-1", senderKind: "worker", senderId: "wkr-ops-1" }),
    );
    expect(calls.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentIdentity: { kind: "worker", workerId: "wkr-ops-1" },
      }),
    );
  });

  it("新建会话解析项目归属（host 注入 resolveProjectId → createTask 带 projectId）", async () => {
    const { service, calls } = makeTaskService();
    await dispatchAgentContactToTaskService(service, baseRequest(), {
      resolveProjectId: async (workspacePath) =>
        workspacePath === "E:\\ws\\proj" ? "proj-1" : undefined,
    });
    expect(calls.createTask).toHaveBeenCalledWith(expect.objectContaining({ projectId: "proj-1" }));
  });

  it("项目解析失败不阻断投递（createTask 不带 projectId，退回未归属态）", async () => {
    const { service, calls } = makeTaskService();
    const result = await dispatchAgentContactToTaskService(service, baseRequest(), {
      resolveProjectId: async () => {
        throw new Error("project tree unavailable");
      },
    });
    expect(result).toEqual({ status: "delivered", sessionId: "sess-new" });
    expect(calls.createTask).toHaveBeenCalledTimes(1);
    expect(calls.createTask.mock.calls[0]?.[0]).not.toHaveProperty("projectId");
  });

  it("显式续聊不触发项目解析（不新建会话）", async () => {
    const { service, calls } = makeTaskService();
    let resolveCalls = 0;
    await dispatchAgentContactToTaskService(
      service,
      { ...baseRequest(), targetSessionId: "sess-target" },
      {
        resolveProjectId: async () => {
          resolveCalls++;
          return "proj-1";
        },
      },
    );
    expect(resolveCalls).toBe(0);
    expect(calls.createTask).not.toHaveBeenCalled();
  });

  it("显式地址失效：诚实失败并提示省略 sessionId 新建，不回退到新建", async () => {
    const { service, calls } = makeTaskService({
      sendPrompt: vi.fn(async () => {
        throw new Error("Session is not active");
      }),
    });
    const result = await dispatchAgentContactToTaskService(service, {
      ...baseRequest(),
      targetSessionId: "sess-gone",
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("omitting sessionId");
    expect(calls.createTask).not.toHaveBeenCalled();
  });

  it("发起方身份随 <system-status> 下发（fromSessionId/replyExpected/裸正文）", async () => {
    const { service, calls } = makeTaskService();
    await dispatchAgentContactToTaskService(
      service,
      baseRequest({
        targetAgentId: "wkr-ops-1",
        senderKind: "worker",
        senderId: "wkr-ops-1",
        senderDisplayName: "运营专员",
        message: "webhook 收到一条消息",
        needReply: false,
      }),
    );
    expect(calls.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        systemStatus: {
          sender: "worker",
          senderId: "wkr-ops-1",
          senderName: "运营专员",
          fromSessionId: "sess-caller",
          replyExpected: false,
        },
        content: "webhook 收到一条消息",
      }),
    );
  });

  it("task service 缺席：按 failed 收口，不给假成功", async () => {
    const result = await dispatchAgentContactToTaskService(undefined, baseRequest());
    expect(result.status).toBe("failed");
    expect(result.error).toBeTruthy();
  });
});
