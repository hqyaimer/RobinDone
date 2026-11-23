import { expect, it, vi } from "vitest";
import { createSessionId, createTurnId } from "@robinrun/contracts";
import { createToolRegistry } from "../src/tool/registry.js";
import { contactAgentToolEntry } from "../src/tool/handlers/contact-agent.js";
import { waitReplyToolEntry } from "../src/tool/handlers/wait-reply.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import type { AgentContactPort } from "@robinrun/contracts";

/**
 * P2.5 验收回归的平移（2026-11-19）：executor 构造期（impl.ts）与 call-runner 的
 * handler context 各漏一环转发，就会出现「注册门判端口在场、工具注册成功，但 handler
 * 永远走端口缺席错误分支」的回归。原守卫盯 workerReturnPort（ReturnToDispatcher），
 * 该工具退役后守卫平移到同列表同待遇的 agentContactPort（ContactAgent）。
 */

function fixture(options?: { withPort?: boolean }) {
  const registry = createToolRegistry();
  registry.register(contactAgentToolEntry);
  registry.register(waitReplyToolEntry);
  const submits: Array<{ target: string; needReply: boolean }> = [];
  const waits: Array<{ requestId: string; timeoutMs: number }> = [];
  const agentContactPort =
    options?.withPort === false
      ? undefined
      : ({
          submit: vi.fn(async (request: { requestId: string; target: string; needReply: boolean }) => {
            submits.push({ target: request.target, needReply: request.needReply });
            return {
              status: "delivered" as const,
              requestId: request.requestId,
              sessionId: "sess_target",
            };
          }),
          wait: vi.fn(async (requestId: string, timeoutMs: number) => {
            waits.push({ requestId, timeoutMs });
            return {
              status: "replied" as const,
              requestId,
              text: "counterpart final output",
              sessionId: "sess_target",
            };
          }),
        } satisfies AgentContactPort);
  const executor = createToolExecutor({
    registry,
    emitEvent: async () => {},
    permissionService: new PermissionService(defaultPermissionConfig),
    getMode: () => "yolo",
    sessionId: createSessionId("agent-contact-port-forwarding"),
    turnId: createTurnId("turn"),
    agentContactPort,
  });
  return { executor, submits, waits, agentContactPort };
}

it("forwards agentContactPort into the handler context so the contact delivers", async () => {
  const { executor, submits } = fixture();
  const result = await executor.execute({
    id: "call-contact",
    name: "ContactAgent",
    input: { target: "wkr-abc12345", message: "status check", needReply: false },
  });
  expect(result.success).toBe(true);
  expect(submits).toEqual([{ target: "wkr-abc12345", needReply: false }]);
  expect(result.modelContent).toContain("delivered");
});

it("blocks on the reply when waitFor is set and returns it verbatim", async () => {
  const { executor, waits } = fixture();
  const result = await executor.execute({
    id: "call-contact-wait",
    name: "ContactAgent",
    input: { target: "wkr-abc12345", message: "need the answer", waitFor: true },
  });
  expect(result.success).toBe(true);
  expect(waits).toHaveLength(1);
  expect(result.modelContent).toContain("counterpart final output");
});

it("keeps the configuration error when no port is injected", async () => {
  const { executor, agentContactPort } = fixture({ withPort: false });
  expect(agentContactPort).toBeUndefined();
  const result = await executor.execute({
    id: "call-contact-no-port",
    name: "ContactAgent",
    input: { target: "wkr-abc12345", message: "ping" },
  });
  expect(result.success).toBe(false);
  expect(result.error?.message ?? "").toContain(
    "ContactAgent is only available to master and worker sessions",
  );
});
