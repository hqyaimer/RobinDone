import { describe, expect, it } from "vitest";
import {
  buildWorkerProfile,
  workerRegistrySchema,
  type WorkerEntry,
} from "../src/worker-roster/worker-registry.js";

function entry(overrides: Partial<WorkerEntry> = {}): WorkerEntry {
  return {
    id: "wkr-test0001",
    name: "dev",
    description: "Development worker",
    status: "active",
    createdAt: "2026-11-15T00:00:00.000Z",
    updatedAt: "2026-11-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("workerRegistrySchema", () => {
  it("accepts a minimal active worker", () => {
    const parsed = workerRegistrySchema.parse({ version: 1, workers: [entry()] });
    expect(parsed.workers[0]?.name).toBe("dev");
  });

  // key/name 裁决（2026-11-17）：id 唯一（路径锚点 + 派发句柄），显示名允许重名（不推荐）。
  it("rejects duplicate ids but allows duplicate display names", () => {
    expect(
      workerRegistrySchema.safeParse({
        version: 1,
        workers: [entry(), entry({ id: "wkr-test0002" })],
      }).success,
    ).toBe(true);
    expect(
      workerRegistrySchema.safeParse({ version: 1, workers: [entry(), entry({ name: "ops" })] })
        .success,
    ).toBe(false);
  });

  it("rejects non-slug ids and unknown fields", () => {
    expect(
      workerRegistrySchema.safeParse({ version: 1, workers: [entry({ id: "../escape" })] }).success,
    ).toBe(false);
    expect(
      workerRegistrySchema.safeParse({
        version: 1,
        workers: [{ ...entry(), permissionMode: "bypassPermissions" }],
      }).success,
    ).toBe(false);
  });
});

describe("buildWorkerProfile", () => {
  // key/name 裁决（2026-11-17）：profile 管线以 name 为键，worker 的派发句柄是 id，
  // 因此 name 位放 id、显示名进 worker.workerName（名册注入时括注）。
  it("maps registry metadata onto an AgentProfile with id as the dispatch key", () => {
    const profile = buildWorkerProfile({
      entry: entry({
        tools: ["Read", "Bash"],
        modelSelection: { providerId: "builtin:zai-coding-plan", modelId: "glm-4.6" },
      }),
      agentsMd: "worker rules",
      defineMdPath: "/ws/.robindone/agents/wkr-test0001/define.md",
    });
    expect(profile).toMatchObject({
      name: "wkr-test0001",
      description: "Development worker",
      source: "project",
      systemPrompt: "worker rules",
      tools: ["Read", "Bash"],
      modelSelection: { providerId: "builtin:zai-coding-plan", modelId: "glm-4.6" },
      injectAgentsMd: true,
      path: "/ws/.robindone/agents/wkr-test0001/define.md",
      worker: {
        workerId: "wkr-test0001",
        workerName: "dev",
      },
    });
  });

  it("falls back to an empty systemPrompt when agents.md is missing (caller decides skip)", () => {
    const profile = buildWorkerProfile({
      entry: entry(),
      defineMdPath: "/ws/.robindone/agents/wkr-test0001/define.md",
    });
    expect(profile.systemPrompt).toBe("");
  });
});
