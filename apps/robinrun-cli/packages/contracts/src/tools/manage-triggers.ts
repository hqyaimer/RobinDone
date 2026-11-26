// ============================================================
// ManageTriggers Tool - trigger registry management (any agent)
// ============================================================
// RobinRun 触发器系统（2026-11-19 设计定稿，docs/trigger-system.md）：触发器/组/登录态
// 档案索引的唯一事实源是 `<workspace>/.robinrun/triggers/triggers.json`，由本工具（程序侧）
// 原子写入；触发器说明为 `<id>/README.md`（触发器自己的 AGENTS.md），说明与脚本本体走
// Write/Edit，不经本工具。任意智能体（master/worker）都可创建触发器——订阅者=创建者。
// 2026-11-22 python 主运行时改造（docs/trigger-python-runtime.md）：runtime 描述改运行时
// 中性（python 主 / node 备选，按引擎状态文件门控，见 core handler）；新增 install_packages
// （经 TriggerRuntimePort 反向请求到引擎执行 pip 安装）。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const MANAGE_TRIGGERS_TOOL_NAME = "ManageTriggers";

export const ManageTriggersActionSchema = z.enum([
  "create",
  "update",
  "set_status",
  "delete",
  "create_group",
  "update_group",
  "create_profile",
  "install_packages",
  "open_login",
]);
export type ManageTriggersAction = z.infer<typeof ManageTriggersActionSchema>;

export const TRIGGER_STATUS_VALUES = ["active", "deactivated", "error-paused"] as const;

/**
 * script 型 scheduled 模式的执行计划（2026-11-25 定时执行模式裁决）：与 cron/interval
 * 触发器的计划形状同构（contracts 不组合 shared 的 zod 实例，见文件头同款裁决）。
 */
const triggerScheduleInputSchema = z.union([
  z
    .object({
      kind: z.literal("cron"),
      schedule: z
        .string()
        .min(1)
        .max(128)
        .describe('5-field cron expression in the user\'s local timezone, e.g. "0 9 * * *".'),
    })
    .strict(),
  z
    .object({
      kind: z.literal("interval"),
      intervalMinutes: z
        .number()
        .int()
        .min(1)
        .max(525600)
        .describe("Interval in whole minutes (minimum 1)."),
    })
    .strict(),
]);

/**
 * 触发器配置的输入镜像（与 @robinrun/shared triggerConfigSchema 同构；contracts 不组合
 * 另一份 zod 实例的 schema，见 automation.ts 同款裁决）。create 时的宽松点：
 * webhook 的 path/token 省略时由工具生成。
 * 2026-11-21 常驻模型：script 型不再接受 schedule/timeoutMs（引擎托管生命周期、脚本
 * 自实现定时）；遗留注册表条目里的 schedule/timeoutMs 由 normalizeConfig 在下次
 * update 时自然清除（引擎本就忽略）。
 * 2026-11-25 定时执行模式：schedule 随 runMode="scheduled" 转正（superRefine 强约束：
 * scheduled 必带 schedule、resident 禁带）；timeoutMs 维持遗留清除。
 */
const triggerConfigInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("cron").describe("Fire on a 5-field cron schedule (local timezone)."),
      schedule: z
        .string()
        .min(1)
        .max(128)
        .describe('5-field cron expression in the user\'s local timezone, e.g. "0 9 * * *".'),
    })
    .strict(),
  z
    .object({
      kind: z.literal("interval").describe("Fire every N minutes."),
      intervalMinutes: z
        .number()
        .int()
        .min(1)
        .max(525600)
        .describe("Interval in whole minutes (minimum 1)."),
    })
    .strict(),
  z
    .object({
      kind: z
        .literal("webhook")
        .describe("Local loopback webhook: fire when an HTTP POST hits the generated URL."),
      path: z
        .string()
        .max(128)
        .regex(/^[a-z0-9][a-z0-9/_-]*$/)
        .optional()
        .describe("Optional path segment; generated as hooks/<trigger-id> when omitted."),
      token: z
        .string()
        .max(128)
        .regex(/^[A-Za-z0-9]+$/)
        .optional()
        .describe("Optional shared token; a random 32-hex token is generated when omitted."),
    })
    .strict(),
  z
    .object({
      kind: z
        .literal("script")
        .describe(
          "Script trigger managed by the engine. Two run modes: resident (default) = a resident event-source process that starts automatically whenever the trigger is active (including at app launch), is restarted with backoff when it crashes, and completes when it exits 0 - implement any timing or subscription inside the script itself (timers, websockets, self-hosted webhooks); scheduled = the engine runs the script once per scheduled fire (fetch -> emit -> exit 0) and the trigger stays active for the next fire - use this for periodic checks that do not need a persistent subscription, it does not keep a resident process alive. Size resident scripts by responsibility boundary: one responsibility domain (e.g. one platform's comments + traffic + operations data) = ONE script emitting its several event types (declare routing \"dispatcher\" so the bound session routes them into per-topic sessions); do not merge unrelated domains into one script and do not split one domain into several resident scripts. The script runtime is decided by python availability in this environment and enforced by the tool - follow the runtime guidance in the create/update result and the README scaffold (protocol details live there). stdout/stderr are logs (audit only, never delivered).",
        ),
      runMode: z
        .enum(["resident", "scheduled"])
        .default("resident")
        .describe(
          "resident (default): the script is a long-lived event-source process. scheduled: the engine spawns the script once per schedule fire; each run does one pass (collect data, emit events, exit 0) and must not loop or sleep - scheduled runs do not count against the resident concurrency quota.",
        ),
      schedule: triggerScheduleInputSchema
        .optional()
        .describe(
          "Required for runMode \"scheduled\" (must be omitted otherwise): when to run each pass, same shapes as cron/interval triggers (5-field cron string, or intervalMinutes >= 1).",
        ),
      runtime: z
        .enum(["node", "python"])
        .describe(
          "python is the primary script runtime (managed interpreter, third-party packages via install_packages); node is a fallback with standard library only and is only valid while python is unavailable. The engine reports which one is currently required - follow it.",
        ),
      entry: z
        .string()
        .min(1)
        .max(256)
        .describe(
          "Script entry file, relative to the trigger's script/ directory (no '..' / absolute paths).",
        ),
      profile: z
        .string()
        .max(64)
        .optional()
        .describe(
          "Login-state profile name (storageState shared across scripts). Must exist — create it with create_profile first.",
        ),
      headed: z
        .boolean()
        .optional()
        .describe("Run the browser headed instead of headless (only for strong anti-bot sites)."),
    })
    .strict(),
]);
export type TriggerConfigInput = z.infer<typeof triggerConfigInputSchema>;

const triggerContractInputSchema = z
  .object({
    minCount: z.number().int().min(0).optional(),
    requiredFields: z.array(z.string().min(1).max(64)).max(32).optional(),
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
export type TriggerContractInput = z.infer<typeof triggerContractInputSchema>;

const triggerStatusInputSchema = z.enum(TRIGGER_STATUS_VALUES);

/**
 * 路由策略（2026-11-25 分发器裁决，specs/trigger-dispatcher-routing.md）：direct = 绑定
 * 会话就地处理（旧行为）；fixed = 每事件批次直投创建者新会话（零 LLM）；dispatcher =
 * 绑定会话升格为分发器（话题聚类 + RouteEvents 标记路由）。create 缺省 dispatcher
 * （新建的目的形态）；存量条目注册表缺省 direct（零迁移），update 显式切换。
 */
export const TRIGGER_ROUTING_VALUES = ["direct", "fixed", "dispatcher"] as const;
const triggerRoutingInputSchema = z.enum(TRIGGER_ROUTING_VALUES);

export const ManageTriggersInputSchema = z
  .object({
    action: ManageTriggersActionSchema.describe(
      "create: register a trigger (requires name, config, readme). update: change name, config, or contract of an existing trigger (requires id). set_status: enable / disable / re-enable after a circuit-break or from completed (requires id and status; re-enabling clears the failure count and restarts a resident script). delete: soft-delete a trigger (requires id) - the entry is kept in the registry for audit but becomes invisible everywhere: no scheduling, no resident process, no delivery, no webhook route, gone from lists and the sidebar. Soft-deleted triggers cannot be restored; create a new one if needed. create_group: bundle triggers into one subscription group so their events share a single session (requires name). update_group: rename a group or move triggers in/out of it (requires groupId). create_profile: register a login-state profile for script triggers (requires name). install_packages: pip-install third-party packages into the project's python venv for script triggers (requires packages; requires the desktop engine and the python runtime). open_login: open a headed login window for a script trigger's login profile (requires the trigger id and the desktop engine; pass loginUrl so the window lands on the site's login page; the user logs in and closes the window to save the refreshed login state - then set_status back to active). Boundary: only create and manage triggers that are yours or that you were explicitly instructed to handle - never touch or report on unrelated triggers.",
    ),
    /** 触发器/组 id（trg-… / trggrp-…）。create 禁传（工具生成）。 */
    id: z
      .string()
      .optional()
      .describe(
        "Trigger or group id returned by create/create_group. Required for update, set_status, and update_group; stable across renames.",
      ),
    name: z
      .string()
      .max(64)
      .optional()
      .describe(
        "Display name (sidebar trigger folder). Required for create and create_group; optional for update/update_group.",
      ),
    /**
     * 订阅者=创建者（2026-11-22 机制层钉死）：归属由执行上下文按调用会话身份派生
     * （worker 会话=该 worker 的 wkr-id，master 会话=master），本字段仅保留接收兼容
     * （strict schema 不拒收幻觉参数），handler 忽略并在冲突时回 warnings。不删字段：
     * 历史会话里模型见过这个入参形状，删了会在模型复述旧调用形状时被 strict 校验拒收。
     */
    ownerAgentId: z
      .string()
      .max(128)
      .optional()
      .describe(
        "Deprecated and ignored: ownership always follows the calling agent, derived by the system (worker session -> that worker's wkr-id; main session -> master). Do not pass this field.",
      ),
    config: triggerConfigInputSchema
      .optional()
      .describe(
        "create/update of triggers: when and how the trigger fires. Full replacement on update — pass the complete config every time.",
      ),
    routing: triggerRoutingInputSchema
      .optional()
      .describe(
        "create/update (also create_group/update_group): how events are delivered. dispatcher (default for new triggers and groups): the dedicated session is a DISPATCHER - it only classifies events into topics and routes them via RouteEvents to per-topic sessions it creates/continues (best for multi-topic or mixed event streams). direct: all events are handled in the one dedicated session itself (legacy behavior; fine for single-topic triggers). fixed: every delivery starts a NEW session directly with zero LLM routing (notification-style triggers without topic continuity). update omits this field to keep the current routing. Group subscriptions take the GROUP's routing; member routing is ignored.",
      ),
    contract: triggerContractInputSchema
      .optional()
      .describe(
        "Data sanity assertions for script triggers (checked against each emitted event's data; a violation is delivered to the trigger session as an error event). Full replacement on update; omit to remove.",
      ),
    readme: z
      .string()
      .min(1)
      .optional()
      .describe(
        "create only: the trigger description body (purpose, data source, output contract, failure handling). Written to README.md verbatim below a fixed scaffold; later edits go through Write/Edit.",
      ),
    status: triggerStatusInputSchema
      .optional()
      .describe(
        "set_status only: active (enable; clears the failure count and restarts a resident script - also how to rerun a completed one-shot script), deactivated (disable, files kept), error-paused (circuit-break state; normally set by the engine, not by you). completed is an engine-written terminal state and not settable here.",
      ),
    groupId: z
      .string()
      .optional()
      .describe("update_group only: the group being updated (alias of id)."),
    memberTriggerIds: z
      .array(z.string())
      .optional()
      .describe(
        "create_group: initial member trigger ids (each must currently be direct-subscribed or will be moved into this group).",
      ),
    addMemberIds: z
      .array(z.string())
      .optional()
      .describe("update_group only: trigger ids to move into this group."),
    removeMemberIds: z
      .array(z.string())
      .optional()
      .describe("update_group only: trigger ids to remove (they revert to direct subscription)."),
    profileName: z
      .string()
      .max(64)
      .optional()
      .describe("create_profile only: profile name used by script config (profile field)."),
    profileNote: z
      .string()
      .max(256)
      .optional()
      .describe("create_profile only: what this login is for, e.g. which site and account role."),
    profileSites: z
      .array(z.string().min(1).max(128))
      .max(16)
      .optional()
      .describe("create_profile only: site URLs this login state applies to."),
    packages: z
      .array(z.string().min(1).max(256))
      .max(32)
      .optional()
      .describe(
        'install_packages only: pip package specs to install into the project\'s python venv, e.g. ["requests", "playwright==1.49.0"]. Project-level (shared by all python script triggers of this project); active python scripts restart automatically on success.',
      ),
    loginUrl: z
      .string()
      .max(2048)
      .refine((value) => /^https?:\/\//i.test(value), {
        message: "loginUrl must be an http(s) URL",
      })
      .optional()
      .describe(
        "open_login only: URL the headed login window lands on (the site's login page, e.g. https://passport.bilibili.com). Always pass it - without it the window opens on a blank new tab.",
      ),
  })
  .strict()
  .superRefine((input, ctx) => {
    const require = (field: "id" | "name", message: string) => {
      const value = input[field];
      if (value === undefined || (typeof value === "string" && value.trim().length === 0)) {
        ctx.addIssue({ code: "custom", message, path: [field] });
      }
    };
    // script 型 runMode/schedule 交叉约束（2026-11-25 定时执行模式）：scheduled 必带
    // schedule；resident 禁带（schedule 随 runMode 转正，resident 传它一律拒绝，避免
    // "写了却不生效"的歧义——此前常驻模型下该字段被静默剥离）。
    if (input.config?.kind === "script") {
      if (input.config.runMode === "scheduled" && input.config.schedule === undefined) {
        ctx.addIssue({
          code: "custom",
          message: 'runMode "scheduled" requires a schedule (cron or interval)',
          path: ["config"],
        });
      }
      if (input.config.runMode !== "scheduled" && input.config.schedule !== undefined) {
        ctx.addIssue({
          code: "custom",
          message:
            'schedule is only valid with runMode "scheduled"; resident scripts implement any timing internally',
          path: ["config"],
        });
      }
    }
    if (input.action === "create") {
      if (input.id !== undefined)
        ctx.addIssue({
          code: "custom",
          message: "create generates the id; do not pass one",
          path: ["id"],
        });
      require("name", "create requires name");
      if (!input.config)
        ctx.addIssue({ code: "custom", message: "create requires config", path: ["config"] });
      if (!input.readme)
        ctx.addIssue({
          code: "custom",
          message: "create requires readme — every trigger must have a description",
          path: ["readme"],
        });
      if (input.status !== undefined)
        ctx.addIssue({
          code: "custom",
          message: "new triggers are always active; use set_status later",
          path: ["status"],
        });
      return;
    }
    if (input.action === "update") {
      require("id", "update requires the trigger id");
      if (input.readme !== undefined)
        ctx.addIssue({
          code: "custom",
          message: "The description lives in the trigger's README.md; edit that file with Write/Edit",
          path: ["readme"],
        });
      if (input.status !== undefined)
        ctx.addIssue({
          code: "custom",
          message: "use the set_status action to change status",
          path: ["status"],
        });
      if (
        input.name === undefined &&
        input.config === undefined &&
        input.contract === undefined &&
        input.routing === undefined
      )
        ctx.addIssue({
          code: "custom",
          message: "update requires at least one of name, config, contract, routing",
          path: ["name"],
        });
      return;
    }
    if (input.action === "set_status") {
      require("id", "set_status requires the trigger id");
      if (input.status === undefined)
        ctx.addIssue({ code: "custom", message: "set_status requires status", path: ["status"] });
      if (input.name !== undefined || input.config !== undefined || input.contract !== undefined)
        ctx.addIssue({
          code: "custom",
          message: "set_status changes status only; use update for metadata",
          path: ["status"],
        });
      return;
    }
    if (input.action === "delete") {
      require("id", "delete requires the trigger id");
      if (input.name !== undefined || input.config !== undefined || input.status !== undefined)
        ctx.addIssue({
          code: "custom",
          message: "delete takes the trigger id only",
          path: ["id"],
        });
      return;
    }
    if (input.action === "create_group") {
      require("name", "create_group requires name");
      if (input.id !== undefined)
        ctx.addIssue({
          code: "custom",
          message: "create_group generates the id; do not pass one",
          path: ["id"],
        });
      if (input.config !== undefined || input.readme !== undefined || input.status !== undefined)
        ctx.addIssue({
          code: "custom",
          message: "create_group takes name and memberTriggerIds only",
          path: ["name"],
        });
      return;
    }
    if (input.action === "update_group") {
      require("id", "update_group requires the group id");
      if (
        input.name === undefined &&
        input.addMemberIds === undefined &&
        input.removeMemberIds === undefined &&
        input.routing === undefined
      )
        ctx.addIssue({
          code: "custom",
          message:
            "update_group requires at least one of name, addMemberIds, removeMemberIds, routing",
          path: ["name"],
        });
      if (input.config !== undefined || input.readme !== undefined || input.status !== undefined)
        ctx.addIssue({
          code: "custom",
          message: "update_group changes group name/members/routing only",
          path: ["name"],
        });
      return;
    }
    if (input.action === "install_packages") {
      if (input.packages === undefined || input.packages.length === 0)
        ctx.addIssue({
          code: "custom",
          message: "install_packages requires a non-empty packages list",
          path: ["packages"],
        });
      if (
        input.id !== undefined ||
        input.name !== undefined ||
        input.config !== undefined ||
        input.status !== undefined ||
        input.readme !== undefined
      )
        ctx.addIssue({
          code: "custom",
          message: "install_packages takes packages only (installation is project-level)",
          path: ["packages"],
        });
      return;
    }
    // create_profile
    if (input.action === "create_profile") {
      if (input.id !== undefined)
        ctx.addIssue({
          code: "custom",
          message: "create_profile generates nothing to pass; do not pass id",
          path: ["id"],
        });
      if (!input.profileName)
        ctx.addIssue({
          code: "custom",
          message: "create_profile requires profileName",
          path: ["profileName"],
        });
      if (input.config !== undefined || input.readme !== undefined || input.status !== undefined)
        ctx.addIssue({
          code: "custom",
          message: "create_profile takes profileName/profileNote/profileSites only",
          path: ["profileName"],
        });
      return;
    }
    // open_login（2026-11-25 登录闭环，specs/trigger-browser-hosting.md §3.4）：取触发器
    // id + 可选 loginUrl（窗口落点，强烈建议传）；其余字段一律拒绝（与 set_status 同风格）。
    if (input.action === "open_login") {
      require("id", "open_login requires the trigger id");
      if (
        input.name !== undefined ||
        input.config !== undefined ||
        input.status !== undefined ||
        input.readme !== undefined ||
        input.packages !== undefined
      )
        ctx.addIssue({
          code: "custom",
          message: "open_login takes the trigger id and optional loginUrl only",
          path: ["id"],
        });
      return;
    }
  });

/**
 * script 型输出 config 的遗留兼容变体（2026-11-21 常驻模型弃用 schedule/timeoutMs 后，
 * 旧注册表条目仍带这两个字段——输出镜像必须能原样透出，否则 get/set_status 输出校验
 * 会拒掉历史条目）。
 */
const legacyScriptOutputConfigSchema = z
  .object({
    kind: z.literal("script"),
    schedule: z.unknown().optional(),
    timeoutMs: z.unknown().optional(),
    runtime: z.enum(["node", "python"]),
    entry: z.string(),
    profile: z.string().optional(),
    headed: z.boolean().optional(),
  })
  .strict();

/**
 * system 型输出 config（2026-11-24 系统特权订阅）：平台播种的订阅条目（如运营面板），
 * 输出可见（列表/详情可读）但不可经本工具创建或修改——输入镜像刻意不含此形状，
 * set_status/delete/update 在 handler 层对 system 条目拒绝。
 */
const systemConfigOutputSchema = z
  .object({
    kind: z.literal("system"),
    events: z.array(z.string()),
  })
  .strict();

/** 注册表条目的输出镜像（strict，形状对齐 @robinrun/shared triggerEntrySchema）。 */
const triggerEntryOutputSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    ownerAgentId: z.string(),
    groupId: z.string().nullable(),
    // 路由策略（2026-11-25 分发器裁决）：输出可见；system 条目恒 direct（平台订阅不经
    // 分发器），输出镜像用宽松枚举兼容旧注册表（缺字段 = direct）。
    routing: z.enum([...TRIGGER_ROUTING_VALUES]).optional(),
    config: z.union([
      triggerConfigInputSchema,
      legacyScriptOutputConfigSchema,
      systemConfigOutputSchema,
    ]),
    contract: triggerContractInputSchema.optional(),
    // completed = 引擎写入的常驻脚本终态（exit 0），输出可见但不开放给 set_status。
    status: z.enum([...TRIGGER_STATUS_VALUES, "completed"]),
    // 伪删除标记（2026-11-21）：delete 输出原样透出（列表输出会排除已删条目）。
    deleted: z.boolean().optional(),
    // 系统特权订阅标记（2026-11-24）：输出可见；任何修改动作被 handler/引擎拒绝。
    system: z.boolean().optional(),
    lastFireAt: z.string().optional(),
    lastResult: z.enum(["ok", "error"]).optional(),
    consecutiveFailures: z.number().int().nonnegative(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

const triggerGroupOutputSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    memberTriggerIds: z.array(z.string()),
    subscriberAgentId: z.string(),
    // 组路由策略（2026-11-25 分发器裁决）输出可见；optional 兼容旧注册表（缺字段 = direct）。
    routing: z.enum([...TRIGGER_ROUTING_VALUES]).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const ManageTriggersOutputSchema = z
  .object({
    action: ManageTriggersActionSchema,
    trigger: triggerEntryOutputSchema.optional(),
    group: triggerGroupOutputSchema.optional(),
    profile: z
      .object({
        name: z.string(),
        note: z.string().optional(),
        sites: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    readmePath: z.string().optional().describe("Absolute path of the trigger's README.md."),
    scriptDirPath: z
      .string()
      .optional()
      .describe("Absolute path of the trigger's script/ directory (write your script here)."),
    webhookPath: z
      .string()
      .optional()
      .describe("webhook triggers: local path segment to POST events to."),
    webhookUrl: z
      .string()
      .optional()
      .describe(
        "webhook triggers: the full local loopback URL to POST events to (engine base URL + path + token). Present only while the desktop engine's webhook server is running; query again with get if absent.",
      ),
    triggerCount: z.number().int().nonnegative(),
    groupCount: z.number().int().nonnegative(),
    /** open_login only：登录会话结果（结构化；关窗落档成功 / 失败原因 + 指引）。 */
    loginResult: z
      .object({
        ok: z.boolean(),
        profile: z.string().optional(),
        error: z.string().optional(),
        guidance: z.array(z.string()).optional(),
      })
      .optional(),
    warnings: z.array(z.string()).optional(),
    /** install_packages only：安装结果（结构化；失败诊断在 error/outputTail）。 */
    installResult: z
      .object({
        ok: z.boolean(),
        packages: z.array(z.string()).optional(),
        error: z.string().optional(),
        outputTail: z.string().optional(),
        replayFailures: z.array(z.string()).optional(),
        restartedTriggerIds: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ManageTriggersOutput = z.infer<typeof ManageTriggersOutputSchema>;

/**
 * 输入类型别名（2026-11-25 补导出）：handler 消费 parse 结果需要它；此前缺失，core 侧
 * 曾用本地 `z.infer` 推导——但 contracts 的 zod（^3.24 私有 hoisted 3.25）与 core 解析
 * 到的根 zod（4.6.5）是两个类体系，跨包 `z.infer` 推断失败成 unknown。类型别名是纯
 * 结构展开（.d.ts 里不再引用 zod 命名空间），跨版本安全。
 */
export type ManageTriggersInput = z.infer<typeof ManageTriggersInputSchema>;

export const ManageTriggersInputJsonSchema = toToolJsonSchema(ManageTriggersInputSchema);
export const ManageTriggersOutputJsonSchema = toToolJsonSchema(ManageTriggersOutputSchema);
