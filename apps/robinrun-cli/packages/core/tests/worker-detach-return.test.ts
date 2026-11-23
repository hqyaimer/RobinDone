// P2.5 用户协同 worker 会话：脱钩（detached）与延迟返回的 runner 语义——**legacy 兼容路径**。
// 2026-11-20 worker 会话模型同构化（docs/worker-session-model.md §2/§6）：新 worker 会话
// 走主会话路径，完成语义收敛进 ContactAgent 请求-响应（不再有延迟返回/积压通知）；本文件
// 仅保留历史 worker_child 会话冷恢复路径的机械行为回归（脱钩暂缓通知、合成快照恢复）。
// 原「return tool delivers the deferred notification with handoff」用例随 return_scheduled
// 语义退役删除（worker ContactAgent 现为普通投递，见 agent-contact-registry.test.ts 的
// dispatch-based ports 用例）。
import { describe, expect, it } from "vitest";
import { createSessionId, createTurnId, type SessionId } from "@robinrun/contracts";
import { createExploreSubagentPort } from "../src/subagent/runner.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";

const WORKER_PROFILE = {
  name: "测试",
  description: "worker",
  source: "user" as const,
  systemPrompt: "worker rules",
  worker: { workerId: "wkr-abc12345", workerName: "测试" },
};

interface DeferredGate {
  promise: Promise<void>;
  resolve(): void;
}

function createGate(): DeferredGate {
  let resolveFn: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: () => resolveFn?.() };
}

async function waitForCondition(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

function createWorkerPortHarness() {
  const notifications: Array<{ taskId?: string; text: string }> = [];
  const detachStates: Array<{ childSessionId: string | undefined; detached: boolean }> = [];
  const runtimeRequests: Array<{ sessionId: SessionId; initiator?: string }> = [];
  const registry = new InMemoryRuntimeTaskRegistry();
  // 每轮 run 一个闸门：start 与后续 resume 分别挂闸，测试按序放行。
  const gates: DeferredGate[] = [];
  const port = createExploreSubagentPort({
    createAgentId: (() => {
      let sequence = 0;
      return () => `agent_wkr_test_${(sequence += 1)}`;
    })(),
    emitParentEvent: async () => {},
    profiles: [WORKER_PROFILE],
    runtimeTaskRegistry: registry,
    enqueueParentTaskNotification: (notification) => {
      notifications.push({ taskId: notification.taskId, text: notification.text });
    },
    persistWorkerDetachState: (childSessionId, detached) => {
      detachStates.push({ childSessionId, detached });
    },
    runExploreAgent: async (request) => {
      runtimeRequests.push({ sessionId: request.sessionId, initiator: request.initiator });
      // readiness 必须先于业务闸门：port.start 等 onSessionReady 才返回（persist 闸门后）。
      await request.onSessionReady?.();
      const gate = createGate();
      gates.push(gate);
      await gate.promise;
      return { events: [], response: "worker cycle done", traceId: "trace_worker_test" };
    },
  });
  return {
    port,
    registry,
    notifications,
    detachStates,
    runtimeRequests,
    gates,
    latestGate: () => gates[gates.length - 1],
  };
}

function createDispatchRequest(parentSessionId: string) {
  const sessionId = createSessionId(parentSessionId);
  const turnId = createTurnId(`${parentSessionId}-turn`);
  return {
    agentType: WORKER_PROFILE.name,
    description: "复核用户更新的代码",
    parentToolCallId: "call_worker_test",
    prompt: "Do the review",
    sessionId,
    trace: {
      traceId: `trace_${parentSessionId}`,
      spanId: `span_${parentSessionId}`,
      sessionId,
      turnId,
    },
    turnId,
    workingDirectory: "/tmp/robinrun-worker-detach",
    workspaceRoot: "/tmp/robinrun-worker-detach",
  };
}

describe("worker detach / deferred return (P2.5)", () => {
  it("user stop detaches a worker task and defers the killed notification", async () => {
    const harness = createWorkerPortHarness();
    const request = createDispatchRequest("sess_worker_detach_parent");
    const launched = await harness.port.start(request);
    if (launched.status !== "async_launched") throw new Error("expected async launch");
    expect(launched.childSessionId).toBeDefined();

    await harness.port.stopTask(launched.backgroundTaskId, { initiator: "user" });
    expect(harness.notifications).toEqual([]);
    expect(harness.detachStates).toEqual([
      { childSessionId: launched.childSessionId, detached: true },
    ]);
    const task = await harness.port.getTask(launched.backgroundTaskId);
    expect(task?.detached).toBe(true);
    expect(task?.workerChild).toBe(true);

    // 放行被中止的 run：终态已提交，failure finalize 不得重复入队通知。
    harness.latestGate().resolve();
    await waitForCondition(() => harness.gates[0] !== undefined);
    expect(harness.notifications).toEqual([]);
  });

  it("model-initiated TaskStop does not detach and still notifies", async () => {
    const harness = createWorkerPortHarness();
    const request = createDispatchRequest("sess_worker_model_stop");
    const launched = await harness.port.start(request);
    if (launched.status !== "async_launched") throw new Error("expected async launch");

    await harness.port.stopTask(launched.backgroundTaskId, { initiator: "model" });
    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]?.text).toContain("<status>killed</status>");
    expect(harness.detachStates).toEqual([]);
    const task = await harness.port.getTask(launched.backgroundTaskId);
    expect(task?.detached ?? false).toBe(false);
  });

  it("resumes from a persisted worker identity when the registry misses after restart", async () => {
    const harness = createWorkerPortHarness();
    const request = createDispatchRequest("sess_worker_identity");
    const childSessionId = createSessionId("sess_worker_identity_child");

    // registry 为空（CLI 重启），to 无意义；路由层凭持久化身份合成快照恢复。
    const sent = await harness.port.sendMessage({
      sessionId: request.sessionId,
      parentToolCallId: "user-direct",
      to: WORKER_PROFILE.name,
      message: "继续上次的复核",
      workingDirectory: request.workingDirectory,
      workspaceRoot: request.workspaceRoot,
      trace: request.trace,
      initiator: "user",
      identity: {
        childSessionId,
        agentType: WORKER_PROFILE.name,
        workerId: WORKER_PROFILE.worker.workerId,
        workerName: WORKER_PROFILE.worker.workerName,
      },
    });
    expect(sent.status).toBe("success");
    expect(sent.delivery).toBe("resumed_background");
    await waitForCondition(() => harness.gates.length >= 1);
    expect(harness.runtimeRequests[0]?.sessionId).toBe(childSessionId);
    // 合成快照即脱钩（用户介入路径），该轮完成通知暂缓。
    harness.latestGate().resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.notifications).toEqual([]);
  });
});
