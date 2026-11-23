import { buildWorkerProfile, workerRegistrySchema, type WorkerRegistry } from "./contract.js";

/** worker-roster 模块边界示例：注册表 JSON 解析 + 条目到运行时 profile 的投影。 */
export const exampleWorkerRegistry: WorkerRegistry = workerRegistrySchema.parse({
  version: 1,
  workers: [
    {
      id: "wkr-example01",
      name: "dev",
      description: "Development worker",
      tools: ["*"],
      status: "active",
      createdAt: "2026-11-15T00:00:00.000Z",
      updatedAt: "2026-11-15T00:00:00.000Z",
    },
  ],
});

export const exampleWorkerProfile = buildWorkerProfile({
  entry: exampleWorkerRegistry.workers[0]!,
  defineMd: "# Duty definition — dev\nrules body",
  agentsMd: "# dev — self-maintained notes\nworker's own findings and index",
  defineMdPath: "/workspace/.robinrun/agents/wkr-example01/define.md",
});
