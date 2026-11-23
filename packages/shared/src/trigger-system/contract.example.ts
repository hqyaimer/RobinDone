import {
  parseTriggerSessionKey,
  sessionKeyForTrigger,
  triggerRegistrySchema,
  type TriggerRegistry,
} from "./contract.js";

/** trigger-system 模块边界示例：注册表 JSON 解析 + 会话 key 投影。 */
export const exampleTriggerRegistry: TriggerRegistry = triggerRegistrySchema.parse({
  version: 1,
  triggers: [
    {
      id: "trg-example01",
      name: "daily-stats",
      ownerAgentId: "master",
      groupId: null,
      config: { kind: "cron", schedule: "0 9 * * *" },
      consecutiveFailures: 0,
      createdAt: "2026-11-19T00:00:00.000Z",
      updatedAt: "2026-11-19T00:00:00.000Z",
    },
    {
      id: "trg-example02",
      name: "comments-crawler",
      ownerAgentId: "master",
      groupId: "trggrp-examp01",
      config: {
        kind: "script",
        schedule: { kind: "interval", intervalMinutes: 30 },
        runtime: "node",
        entry: "crawl.js",
        timeoutMs: 60000,
        profile: "main-site",
      },
      contract: { minCount: 1, requiredFields: ["id", "text"] },
      consecutiveFailures: 0,
      createdAt: "2026-11-19T00:00:00.000Z",
      updatedAt: "2026-11-19T00:00:00.000Z",
    },
  ],
  groups: [
    {
      id: "trggrp-examp01",
      name: "operations-watch",
      memberTriggerIds: ["trg-example02"],
      subscriberAgentId: "master",
      createdAt: "2026-11-19T00:00:00.000Z",
      updatedAt: "2026-11-19T00:00:00.000Z",
    },
  ],
  profiles: [
    {
      name: "main-site",
      sites: ["https://example.com"],
      createdAt: "2026-11-19T00:00:00.000Z",
      updatedAt: "2026-11-19T00:00:00.000Z",
    },
  ],
});

// 直连触发器 → `trigger:<id>`；组内触发器 → `trigger-group:<gid>`（裁决 7）。
export const exampleDirectSessionKey = sessionKeyForTrigger(exampleTriggerRegistry.triggers[0]!);
export const exampleGroupSessionKey = sessionKeyForTrigger(exampleTriggerRegistry.triggers[1]!);
export const exampleParsedKey = parseTriggerSessionKey(exampleGroupSessionKey);
