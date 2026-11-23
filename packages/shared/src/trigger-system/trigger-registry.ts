import { z } from "zod";

/**
 * RobinRun 触发器注册表（`.robinrun/triggers/triggers.json`）的协议层定义。
 *
 * 设计正身：`docs/trigger-system.md`（2026-11-19 定稿）。核心裁决：
 * - 触发器以 id 为路径锚点（`.robinrun/triggers/<id>/`），name 仅作显示名。
 * - 注册表是唯一事实源，由程序（ManageTriggers 工具）原子写入；模型不经 Write/Edit 直接改。
 * - 说明文件是 `<id>/README.md`（触发器自己的 AGENTS.md），纯正文无 frontmatter；元数据只存本注册表。
 * - 订阅上下文互斥（裁决 1）：同一触发器对同一订阅者要么直连（groupId=null）、要么属于一个组，
 *   交叉引用在注册表级 refine 校验（双向一致性）。
 * - 熔断（2026-11-21 常驻脚本修订：按崩溃计数）：`consecutiveFailures >= 阈值（引擎常量 3）`
 *   时引擎把 status 置为 error-paused；status 是注册表状态机的一部分
 *   （active/deactivated/error-paused/completed——completed 仅引擎写入）。
 * - 登录态档案（profiles）只存索引元数据，storageState 本体在 `profiles/<name>.json`
 *   （凭据级敏感文件，不进注册表内容、不进日志）。
 */

export const TRIGGER_REGISTRY_VERSION = 1 as const;

/** 触发器 id 前缀与 pattern（同 `wkr-*` 纪律：小写 slug，前缀由生成方保证，id 即文件夹名）。 */
export const TRIGGER_ID_PREFIX = "trg-" as const;
export const TRIGGER_GROUP_ID_PREFIX = "trggrp-" as const;
export const TRIGGER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const triggerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(TRIGGER_ID_PATTERN, "Trigger id must be a lowercase slug");

const triggerGroupIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(TRIGGER_ID_PATTERN, "Trigger group id must be a lowercase slug");

/** 智能体身份（第一期订阅者=创建者：master 用 `master`，worker 用 `wkr-*` id）。 */
const agentIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, "Agent id must be a slug-like identifier");

/**
 * 状态机（裁决 5 + 2026-11-21 常驻脚本修订）：active ↔ deactivated（启停）；连续崩溃
 * 达阈值由引擎置 error-paused（熔断，不再拉起/投递），修复后经 re-enable 回 active 并
 * 清零计数；completed = 常驻脚本干净退出（exit 0）的终态，仅引擎写入，"重新启用"
 * （set_status=active）即重新拉起。
 */
export const triggerStatusSchema = z.enum(["active", "deactivated", "error-paused", "completed"]);
export type TriggerStatus = z.infer<typeof triggerStatusSchema>;

/**
 * 工具层可写的状态集合：completed 是引擎写入的终态（常驻脚本 exit 0），不开放给
 * ManageTriggers set_status / UI setTriggerStatus 直接设置；从 completed 恢复一律传
 * active（重新拉起 = 一次性脚本重跑）。
 */
export const OPERABLE_TRIGGER_STATUSES = ["active", "deactivated", "error-paused"] as const;

/**
 * 宽松的 5 段 cron 结构校验（本地时区）：只拦明显垃圾（段数、字符集），
 * 真实语义解析由调度器负责——与上游 automation 的 cronExpr 分层一致。
 */
const cronScheduleSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => {
    const fields = value.trim().split(/\s+/);
    if (fields.length !== 5) return false;
    return fields.every((field) => /^[0-9A-Za-z*,\-/]+$/.test(field));
  }, "Cron schedule must be a 5-field expression (local timezone)");

const webhookPathSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9/_-]*$/, "Webhook path must be a lowercase path slug");

/** webhook 回调 token：本地 loopback 信任边界内的访问凭证，工具生成 32 hex。 */
const webhookTokenSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9]+$/, "Webhook token must be alphanumeric");

/** 脚本入口：`<id>/script/` 下的相对路径，禁绝对路径与目录穿越。 */
const scriptEntrySchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/, "Script entry must be a relative path")
  .refine((value) => !value.includes(".."), "Script entry must not contain '..'");

/** 登录态档案名（profiles/<name>.json 的键）。 */
const triggerProfileNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "Profile name must be a lowercase slug");

const isoTimestampSchema = z.string().min(1);

/** cron 调度对象（cron 型触发器的 config 本体，也被 script 型内嵌复用）。 */
const cronObjectSchema = z
  .object({
    kind: z.literal("cron"),
    /** 5 段 cron，用户本地时区。 */
    schedule: cronScheduleSchema,
  })
  .strict();

/** interval 调度对象（同上复用）。 */
const intervalObjectSchema = z
  .object({
    kind: z.literal("interval"),
    /** 间隔分钟数；最小 1（防滥用），上限一年。 */
    intervalMinutes: z.number().int().min(1).max(525600),
  })
  .strict();

/**
 * script 型触发器的运行周期（2026-11-21 起弃用：常驻模型下脚本自实现定时，引擎忽略
 * 此字段；schema 保留仅为旧注册表解析兼容）。
 */
export const triggerScheduleSchema = z.union([cronObjectSchema, intervalObjectSchema]);
export type TriggerSchedule = z.infer<typeof triggerScheduleSchema>;

/** 三类来源（裁决 2）：定时 / 本地 webhook / 脚本。config 用 discriminatedUnion 防类型与配置错位。 */
export const triggerConfigSchema = z.discriminatedUnion("kind", [
  cronObjectSchema,
  intervalObjectSchema,
  z
    .object({
      kind: z.literal("webhook"),
      /** 本地 loopback server 上的路径段（工具生成 `hooks/<trg-id>`）。 */
      path: webhookPathSchema,
      token: webhookTokenSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("script"),
      /**
       * 运行周期与超时（2026-11-21 常驻模型修订后弃用）：脚本触发器是常驻事件源进程，
       * 引擎只托管生命周期（active 即拉起、崩溃退避重启、exit 0 → completed 终态），
       * 定时/订阅由脚本自实现。两字段保留为 optional 仅为旧注册表解析兼容，引擎忽略；
       * 新创建不得写入。
       */
      schedule: triggerScheduleSchema.optional(),
      /**
       * 脚本运行时（2026-11-22 python 主运行时修订）：python=主运行时（托管解释器自动
       * 下载 + 按项目 venv，支持三方包）；node=备选降级（Electron 内嵌 Node + IPC 桥接，
       * 仅标准库）——仅当 python 运行时不可用时允许使用（ManageTriggers 按引擎状态
       * `python-runtime.json` 门控；存量 node 条目不迁移，照常运行）。
       */
      runtime: z.enum(["node", "python"]),
      entry: scriptEntrySchema,
      /** v1 批处理模型遗留（optional 兼容保留），常驻模型下引擎忽略。 */
      timeoutMs: z.number().int().min(1000).max(600000).optional(),
      /** 登录态档案名（裁决 6）：实例启动注入、关闭回写；同档案默认串行。 */
      profile: triggerProfileNameSchema.optional(),
      /** 有头例外（强反爬站），默认无头。 */
      headed: z.boolean().optional(),
    })
    .strict(),
]);
export type TriggerConfig = z.infer<typeof triggerConfigSchema>;
export type TriggerType = TriggerConfig["kind"];

/** 触发器类型视图助手（entry 不再冗余存 type，避免与 config.kind 漂移）。 */
export function triggerTypeOf(entry: Pick<TriggerEntry, "config">): TriggerType {
  return entry.config.kind;
}

/**
 * 出口契约的合理性断言（裁决 5，结构化部分）。数据突变类断言（环比等）留待后续按需扩展；
 * 至少要有一条断言，否则契约退化为纯退出码判定（允许，但不鼓励）。
 */
export const triggerContractSchema = z
  .object({
    /** data 为数组时的最小条数（爬虫防"页面改版抓空"）。 */
    minCount: z.number().int().min(0).optional(),
    /** data（对象或数组元素）必须包含的字段。 */
    requiredFields: z.array(z.string().min(1).max(64)).max(32).optional(),
    /** 数据新鲜度上限（分钟）：脚本输出内嵌时间早于此值判异常。 */
    maxAgeMinutes: z.number().int().min(1).optional(),
  })
  .strict()
  .refine(
    (contract) =>
      contract.minCount !== undefined ||
      contract.requiredFields !== undefined ||
      contract.maxAgeMinutes !== undefined,
    { message: "Contract must declare at least one assertion" },
  );
export type TriggerContract = z.infer<typeof triggerContractSchema>;

export const triggerEntrySchema = z
  .object({
    id: triggerIdSchema,
    /** 显示名，项目内允许重名（同 worker key/name 裁决）；路由与路径只用 id。 */
    name: z.string().min(1).max(64),
    /** 订阅者=第一响应者（第一期=创建者 owner，字段名保留扩展空间）。 */
    ownerAgentId: agentIdSchema,
    /**
     * 订阅上下文（裁决 1 互斥）：null=直连订阅（会话 key `trigger:<id>`）；
     * 指向组 id（会话 key `trigger-group:<组id>`）。交叉一致性在注册表级 refine。
     */
    groupId: triggerGroupIdSchema.nullable().default(null),
    config: triggerConfigSchema,
    /**
     * 状态机（裁决 5）：active ↔ deactivated（启停）；连续异常达阈值由工具置
     * error-paused（熔断，不再执行/投递），修复后经 re-enable 回 active 并清零计数。
     */
    status: triggerStatusSchema,
    /** 出口契约断言（仅 script 型消费；其余类型可留空）。 */
    contract: triggerContractSchema.optional(),
    lastFireAt: isoTimestampSchema.optional(),
    lastResult: z.enum(["ok", "error"]).optional(),
    /** 连续异常计数（熔断依据），任何一次成功执行清零。 */
    consecutiveFailures: z.number().int().min(0).default(0),
    /**
     * 伪删除标记（2026-11-21 实测裁决，与会话/智能体的伪删除一致）：true = 用户已删除。
     * 注册表条目保留（审计与历史可追溯）但对所有消费面不可见——引擎不调度/不托管/
     * 不投递/不进快照（webhook 路由同拒），ManageTriggers 列表排除，UI 不渲染。
     * 仅经 ManageTriggers delete / UI 删除项写入；不可逆（如需同语义触发器请新建）。
     */
    deleted: z.boolean().optional(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type TriggerEntry = z.infer<typeof triggerEntrySchema>;

export const triggerGroupEntrySchema = z
  .object({
    id: triggerGroupIdSchema,
    name: z.string().min(1).max(64),
    /** 成员触发器 id 列表（允许空组=建组后逐步加成员；唯一）；与 triggers[].groupId 双向一致由注册表级 refine 校验。 */
    memberTriggerIds: z
      .array(triggerIdSchema)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Group member trigger ids must be unique",
      }),
    subscriberAgentId: agentIdSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type TriggerGroupEntry = z.infer<typeof triggerGroupEntrySchema>;

/** 登录态档案索引条目：只存元数据，storageState 本体永不入注册表（凭据管理条款）。 */
export const triggerProfileEntrySchema = z
  .object({
    name: triggerProfileNameSchema,
    note: z.string().max(256).optional(),
    /** 档案适用的站点提示（纯注释性，供模型选择档案）。 */
    sites: z.array(z.string().min(1).max(128)).max(16).optional(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type TriggerProfileEntry = z.infer<typeof triggerProfileEntrySchema>;

export const triggerRegistrySchema = z
  .object({
    version: z.literal(TRIGGER_REGISTRY_VERSION),
    triggers: z.array(triggerEntrySchema),
    groups: z.array(triggerGroupEntrySchema),
    profiles: z.array(triggerProfileEntrySchema),
  })
  .strict()
  .superRefine((registry, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

    const triggerIds = registry.triggers.map((trigger) => trigger.id);
    if (new Set(triggerIds).size !== triggerIds.length) {
      issue("triggers", "Trigger ids must be unique");
    }
    const groupIds = registry.groups.map((group) => group.id);
    if (new Set(groupIds).size !== groupIds.length) {
      issue("groups", "Group ids must be unique");
    }
    const profileNames = registry.profiles.map((profile) => profile.name);
    if (new Set(profileNames).size !== profileNames.length) {
      issue("profiles", "Profile names must be unique");
    }

    // 订阅上下文互斥与交叉一致性（裁决 1）：groupId ↔ group.memberTriggerIds 双向闭合。
    const triggersById = new Map(registry.triggers.map((trigger) => [trigger.id, trigger]));
    const groupsById = new Map(registry.groups.map((group) => [group.id, group]));

    for (const trigger of registry.triggers) {
      if (trigger.groupId === null) continue;
      const group = groupsById.get(trigger.groupId);
      if (!group) {
        issue("triggers", `Trigger ${trigger.id} references missing group ${trigger.groupId}`);
        continue;
      }
      if (!group.memberTriggerIds.includes(trigger.id)) {
        issue(
          "triggers",
          `Trigger ${trigger.id} names group ${trigger.groupId} but is not in its members`,
        );
      }
    }
    for (const group of registry.groups) {
      for (const memberId of group.memberTriggerIds) {
        const member = triggersById.get(memberId);
        if (!member) {
          issue("groups", `Group ${group.id} references missing trigger ${memberId}`);
          continue;
        }
        if (member.groupId !== group.id) {
          issue(
            "groups",
            `Trigger ${memberId} does not point back to group ${group.id} (subscription must be exclusive)`,
          );
        }
      }
    }
  });
export type TriggerRegistry = z.infer<typeof triggerRegistrySchema>;

// ---------------------------------------------------------------------------
// 存储布局常量（`.robinrun/triggers/`，见 docs/trigger-system.md「对象模型与存储布局」）
// ---------------------------------------------------------------------------

export const triggerRegistryFileName = "triggers.json" as const;
/** 触发器说明文件：语义同工作区 AGENTS.md / worker 的 AGENTS.md，新会话与压缩后注入。 */
export const triggerReadmeFileName = "README.md" as const;
export const triggerDirectoryConvention = {
  script: "script",
  log: "log",
} as const;
/** 审计日志（append-only JSONL），位于 `<id>/log/` 下。 */
export const triggerAuditFileName = "audit.jsonl" as const;
/** 登录态档案目录（项目内敏感目录，不进日志/导出）。 */
export const triggerProfilesDirectoryName = "profiles" as const;
/** 项目级脚本依赖清单与平台标记（依赖本体不随项目迁移，平台不匹配时引擎自动补装）。 */
export const triggerPackageJsonFileName = "package.json" as const;
export const triggerPlatformMarkerFileName = ".platform-marker" as const;

// ---------------------------------------------------------------------------
// 脚本运行时供给（2026-11-22 python 主 + node 备选修订）
// 状态文件与台账在 `state/` 一级：CLI 侧 ManageTriggers 门控/提示词只读这些文件
// （同 readWebhookBaseUrl 读 state/webhook.json 的文件耦合先例），写方只有引擎。
// ---------------------------------------------------------------------------

export const TRIGGER_PYTHON_RUNTIME_STATE_VERSION = 1 as const;
/** python 运行时可用性状态文件（`state/python-runtime.json`，引擎写、CLI 读）。 */
export const triggerPythonRuntimeStateFileName = "python-runtime.json" as const;
/** python 三方包台账（`state/python-packages.json`；放 venv 目录外，venv 重建不丢、支撑重放）。 */
export const triggerPythonPackagesFileName = "python-packages.json" as const;
/** 按项目 venv 目录（`state/python-env/`，项目内所有 python 触发器脚本共用）。 */
export const triggerPythonEnvDirectoryName = "python-env" as const;

/** 解释器来源：managed=python-build-standalone 托管下载；system=系统 PATH 回退（env 开关）。 */
export const pythonRuntimeSourceSchema = z.enum(["managed", "system"]);
export type PythonRuntimeSource = z.infer<typeof pythonRuntimeSourceSchema>;

/**
 * 可用性状态机：probing（下载/探测进行中）→ available / unavailable。
 * 门控语义上 probing 与缺失文件都按「python 不可用」处理（node 备选），但文案区分。
 */
export const pythonRuntimeAvailabilitySchema = z.enum(["probing", "available", "unavailable"]);
export type PythonRuntimeAvailability = z.infer<typeof pythonRuntimeAvailabilitySchema>;

export const pythonRuntimeStateSchema = z
  .object({
    version: z.literal(TRIGGER_PYTHON_RUNTIME_STATE_VERSION),
    state: pythonRuntimeAvailabilitySchema,
    /** available 时给出生效解释器绝对路径（venv 解释器在 ensureVenv 后另算，此处是供给层解释器）。 */
    interpreterPath: z.string().min(1).optional(),
    source: pythonRuntimeSourceSchema.optional(),
    /** unavailable 的失败原因（直出给工具结果与提示词的文案）。 */
    error: z.string().min(1).optional(),
    updatedAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state === "available") {
      if (value.interpreterPath === undefined || value.source === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["interpreterPath"],
          message: "available state requires interpreterPath and source",
        });
      }
      return;
    }
    if (value.state === "unavailable" && value.error === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "unavailable state requires an error message",
      });
    }
  });
export type PythonRuntimeStateFile = z.infer<typeof pythonRuntimeStateSchema>;

/** 三方包台账：venv 重建后按它重放安装（追加式，对齐动作台账原则）。 */
export const pythonPackagesLedgerSchema = z
  .object({
    version: z.literal(1),
    packages: z
      .array(
        z
          .object({
            /** pip 包 spec，如 `requests` / `playwright==1.49.0`。 */
            spec: z.string().min(1).max(256),
            installedAt: isoTimestampSchema,
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
export type PythonPackagesLedger = z.infer<typeof pythonPackagesLedgerSchema>;

// ---------------------------------------------------------------------------
// 会话 key（裁决 7 路由规则）——协议级常量，引擎（host）与 CLI 两侧共用
// ---------------------------------------------------------------------------

export const TRIGGER_SESSION_KEY_PREFIX = "trigger:" as const;
export const TRIGGER_GROUP_SESSION_KEY_PREFIX = "trigger-group:" as const;

export function makeTriggerSessionKey(triggerId: string): string {
  return `${TRIGGER_SESSION_KEY_PREFIX}${triggerId}`;
}

export function makeTriggerGroupSessionKey(groupId: string): string {
  return `${TRIGGER_GROUP_SESSION_KEY_PREFIX}${groupId}`;
}

/** 触发器条目 → 其绑定的会话 key（直连看自身 id，组订阅看组 id）。 */
export function sessionKeyForTrigger(entry: Pick<TriggerEntry, "id" | "groupId">): string {
  return entry.groupId === null
    ? makeTriggerSessionKey(entry.id)
    : makeTriggerGroupSessionKey(entry.groupId);
}

export type ParsedTriggerSessionKey =
  | { kind: "trigger"; triggerId: string }
  | { kind: "group"; groupId: string };

/** 解析会话 key；非触发器会话 key 返回 null（引擎只认自己创建的 key）。 */
export function parseTriggerSessionKey(key: string): ParsedTriggerSessionKey | null {
  if (key.startsWith(TRIGGER_GROUP_SESSION_KEY_PREFIX)) {
    return { kind: "group", groupId: key.slice(TRIGGER_GROUP_SESSION_KEY_PREFIX.length) };
  }
  if (key.startsWith(TRIGGER_SESSION_KEY_PREFIX)) {
    return { kind: "trigger", triggerId: key.slice(TRIGGER_SESSION_KEY_PREFIX.length) };
  }
  return null;
}
