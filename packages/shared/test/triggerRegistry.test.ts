import { describe, expect, it } from "vitest";
import {
  makeTriggerGroupSessionKey,
  makeTriggerSessionKey,
  parseTriggerSessionKey,
  sessionKeyForTrigger,
  triggerRegistrySchema,
  type TriggerEntry,
} from "../src/trigger-system/trigger-registry.js";

function triggerEntry(overrides: Partial<TriggerEntry> = {}): TriggerEntry {
  return {
    id: "trg-test0001",
    name: "daily-stats",
    ownerAgentId: "master",
    groupId: null,
    config: { kind: "cron", schedule: "0 9 * * *" },
    status: "active",
    consecutiveFailures: 0,
    createdAt: "2026-11-19T00:00:00.000Z",
    updatedAt: "2026-11-19T00:00:00.000Z",
    ...overrides,
  };
}

function registryWith(...triggers: TriggerEntry[]) {
  return { version: 1, triggers, groups: [], profiles: [] };
}

describe("triggerRegistrySchema", () => {
  it("accepts a minimal direct-subscribed cron trigger", () => {
    const parsed = triggerRegistrySchema.parse(registryWith(triggerEntry()));
    expect(parsed.triggers[0]?.config.kind).toBe("cron");
    expect(parsed.triggers[0]?.groupId).toBeNull();
  });

  // 伪删除（2026-11-21 实测裁决，与会话/智能体一致）：条目保留、消费面不可见。
  // deleted 是可选布尔（缺省 undefined = 未删除）；状态/组闭合由写入方保证。
  it("accepts the soft-delete flag (optional boolean)", () => {
    const parsed = triggerRegistrySchema.parse(
      registryWith(triggerEntry({ deleted: true, status: "deactivated" })),
    );
    expect(parsed.triggers[0]?.deleted).toBe(true);
    const withoutFlag = triggerRegistrySchema.parse(registryWith(triggerEntry()));
    expect(withoutFlag.triggers[0]?.deleted).toBeUndefined();
    expect(
      triggerRegistrySchema.safeParse(registryWith(triggerEntry({ deleted: "yes" as never })))
        .success,
    ).toBe(false);
  });

  it("rejects duplicate trigger ids", () => {
    const result = triggerRegistrySchema.safeParse(
      registryWith(triggerEntry(), triggerEntry({ name: "another-stats" })),
    );
    expect(result.success).toBe(false);
  });

  it("rejects bad trigger id slugs", () => {
    const result = triggerRegistrySchema.safeParse(registryWith(triggerEntry({ id: "TRG X" })));
    expect(result.success).toBe(false);
  });

  it("rejects invalid cron schedules (wrong field count / bad chars)", () => {
    const bad = triggerRegistrySchema.safeParse(
      registryWith(triggerEntry({ config: { kind: "cron", schedule: "0 9 * *" } })),
    );
    expect(bad.success).toBe(false);
    const worse = triggerRegistrySchema.safeParse(
      registryWith(triggerEntry({ config: { kind: "cron", schedule: "0 9 ; * *" } })),
    );
    expect(worse.success).toBe(false);
  });

  it("accepts interval config within bounds and rejects zero", () => {
    expect(
      triggerRegistrySchema.safeParse(
        registryWith(triggerEntry({ config: { kind: "interval", intervalMinutes: 5 } })),
      ).success,
    ).toBe(true);
    expect(
      triggerRegistrySchema.safeParse(
        registryWith(triggerEntry({ config: { kind: "interval", intervalMinutes: 0 } })),
      ).success,
    ).toBe(false);
  });

  it("rejects script entry with directory traversal or absolute path", () => {
    const traversal = triggerRegistrySchema.safeParse(
      registryWith(
        triggerEntry({
          config: {
            kind: "script",
            runtime: "node",
            entry: "../evil.js",
          },
        }),
      ),
    );
    expect(traversal.success).toBe(false);
    const absolute = triggerRegistrySchema.safeParse(
      registryWith(
        triggerEntry({
          config: {
            kind: "script",
            runtime: "node",
            entry: "/etc/evil.js",
          },
        }),
      ),
    );
    expect(absolute.success).toBe(false);
  });

  it("accepts a resident script trigger without schedule (2026-11-21 常驻模型)", () => {
    const parsed = triggerRegistrySchema.parse(
      registryWith(
        triggerEntry({
          config: { kind: "script", runtime: "node", entry: "index.mjs" },
        }),
      ),
    );
    const script = parsed.triggers[0]?.config;
    expect(script.kind).toBe("script");
    expect("schedule" in script).toBe(false);
  });

  it("tolerates legacy script schedule/timeoutMs (deprecated, engine-ignored)", () => {
    const parsed = triggerRegistrySchema.parse(
      registryWith(
        triggerEntry({
          config: {
            kind: "script",
            schedule: { kind: "cron", schedule: "14 13 20 11 *" },
            runtime: "node",
            entry: "index.mjs",
            timeoutMs: 15000,
          },
        }),
      ),
    );
    expect(parsed.triggers[0]?.config.kind).toBe("script");
  });

  it("accepts the engine-written completed status and rejects unknown ones", () => {
    expect(
      triggerRegistrySchema.safeParse(registryWith(triggerEntry({ status: "completed" }))).success,
    ).toBe(true);
  });

  it("rejects a contract with no assertions", () => {
    const result = triggerRegistrySchema.safeParse(registryWith(triggerEntry({ contract: {} })));
    expect(result.success).toBe(false);
  });

  it("enforces subscription cross-references bidirectionally", () => {
    // trigger 指向不存在的组
    const dangling = triggerRegistrySchema.safeParse(
      registryWith(triggerEntry({ groupId: "trggrp-missing" })),
    );
    expect(dangling.success).toBe(false);

    // 双向闭合的组订阅合法
    const valid = triggerRegistrySchema.safeParse({
      version: 1,
      triggers: [triggerEntry({ groupId: "trggrp-test001" })],
      groups: [
        {
          id: "trggrp-test001",
          name: "watch",
          memberTriggerIds: ["trg-test0001"],
          subscriberAgentId: "master",
          createdAt: "2026-11-19T00:00:00.000Z",
          updatedAt: "2026-11-19T00:00:00.000Z",
        },
      ],
      profiles: [],
    });
    expect(valid.success).toBe(true);

    // 组列了成员但成员没指回组（互斥被破坏）
    const asymmetric = triggerRegistrySchema.safeParse({
      version: 1,
      triggers: [triggerEntry()],
      groups: [
        {
          id: "trggrp-test001",
          name: "watch",
          memberTriggerIds: ["trg-test0001"],
          subscriberAgentId: "master",
          createdAt: "2026-11-19T00:00:00.000Z",
          updatedAt: "2026-11-19T00:00:00.000Z",
        },
      ],
      profiles: [],
    });
    expect(asymmetric.success).toBe(false);

    // 组引用不存在的触发器
    const missingMember = triggerRegistrySchema.safeParse({
      version: 1,
      triggers: [],
      groups: [
        {
          id: "trggrp-test001",
          name: "watch",
          memberTriggerIds: ["trg-missing01"],
          subscriberAgentId: "master",
          createdAt: "2026-11-19T00:00:00.000Z",
          updatedAt: "2026-11-19T00:00:00.000Z",
        },
      ],
      profiles: [],
    });
    expect(missingMember.success).toBe(false);
  });

  it("rejects unknown keys (strict) and bad statuses", () => {
    expect(
      triggerRegistrySchema.safeParse({ ...registryWith(triggerEntry()), extra: true }).success,
    ).toBe(false);
    expect(
      triggerRegistrySchema.safeParse(registryWith(triggerEntry({ status: "paused" } as never)))
        .success,
    ).toBe(false);
  });
});

describe("session key protocol", () => {
  it("maps direct subscription to trigger:<id>", () => {
    expect(sessionKeyForTrigger(triggerEntry())).toBe("trigger:trg-test0001");
    expect(parseTriggerSessionKey("trigger:trg-test0001")).toEqual({
      kind: "trigger",
      triggerId: "trg-test0001",
    });
  });

  it("maps group subscription to trigger-group:<gid>", () => {
    const key = sessionKeyForTrigger(triggerEntry({ groupId: "trggrp-test001" }));
    expect(key).toBe("trigger-group:trggrp-test001");
    expect(parseTriggerSessionKey(key)).toEqual({
      kind: "group",
      groupId: "trggrp-test001",
    });
  });

  it("returns null for foreign keys", () => {
    expect(parseTriggerSessionKey("session:abc")).toBeNull();
    expect(parseTriggerSessionKey("")).toBeNull();
  });

  it("make* helpers agree with the parser round-trip", () => {
    expect(parseTriggerSessionKey(makeTriggerSessionKey("trg-x"))).toEqual({
      kind: "trigger",
      triggerId: "trg-x",
    });
    expect(parseTriggerSessionKey(makeTriggerGroupSessionKey("trggrp-x"))).toEqual({
      kind: "group",
      groupId: "trggrp-x",
    });
  });
});
