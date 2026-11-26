// ============================================================
// ManageTriggers Tool Handler - trigger registry (any agent)
// ============================================================
// RobinRun 触发器系统（2026-11-19 设计定稿，docs/trigger-system.md）：注册表唯一事实源是
// `<workspace>/.robinrun/triggers/triggers.json`，只经本工具（程序侧）写入——模型不得用
// Write/Edit 直接改注册表（无校验、可绕过订阅互斥与熔断状态机）。触发器说明是
// `<id>/README.md`（触发器自己的 AGENTS.md），说明与脚本本体走 Write/Edit，不经本工具。
// 与 ManageWorkers 的差异：触发器允许任意智能体（master/worker）创建（订阅者=创建者），
// 因此本工具不设主会话专属门，也不进子 runtime 强制禁用名单。
// 2026-11-22 python 主运行时改造（docs/trigger-python-runtime.md §4a）：create/update 的
// script config 按引擎状态文件 `state/python-runtime.json` 门控（python 可用 → 必须 python；
// 不可用/probing/缺失 → node 备选），README 模板与结果文本按 runtime 双变体；install_packages
// 经 TriggerRuntimePort 反向请求到引擎执行。

import { join } from "node:path";
import {
  MANAGE_TRIGGERS_TOOL_NAME,
  ManageTriggersInputJsonSchema,
  ManageTriggersInputSchema,
  ManageTriggersOutputJsonSchema,
  ManageTriggersOutputSchema,
  CoreErrorType,
  createCoreError,
  type ManageTriggersInput,
  type ManageTriggersOutput,
} from "@robinrun/contracts";
import {
  isSystemTriggerEntry,
  triggerAuditFileName,
  triggerDirectoryConvention,
  triggerProfilesDirectoryName,
  triggerReadmeFileName,
  triggerRegistryFileName,
  TRIGGER_GROUP_ID_PREFIX,
  TRIGGER_GROUP_SESSION_KEY_PREFIX,
  TRIGGER_ID_PREFIX,
  type TriggerEntry,
  type TriggerGroupEntry,
  type TriggerProfileEntry,
} from "@robinrun/shared";
import type { ToolEntry, ToolHandler } from "../types.js";
// 纯辅助（注册表 IO / config 归一 / 门控 / README 脚手架）在 manage-triggers-support.ts
//（2026-11-25 拆分，架构检查 max-file-lines；分发器 routing 的写点仍在 handler 主流程）。
import {
  assertScriptRuntimeAllowed,
  buildReadmeContent,
  createTrace,
  ensureRegistryUnchanged,
  generateId,
  normalizeConfig,
  nowIso,
  parseRegistryContent,
  readRegistryRaw,
  readWebhookBaseUrl,
  resolveOwnerAgentId,
  resolveScriptRuntimeGate,
  writeRegistry,
} from "./manage-triggers-support.js";

/**
 * 系统特权订阅保护（2026-11-24 平台级保证，需求/审批/反馈面板）：system 条目不可经
 * 本工具修改（update/set_status/delete 一律拒绝）。这是保护的工具侧一半——引擎侧
 * （setTriggerStatus/deleteTrigger）与 UI 同样拒绝；create 侧由输入 schema 刻意不收
 * system config 形状兜底（模型无法伪造 system 条目）。
 */
function assertNotSystemTrigger(entry: TriggerEntry, action: string): void {
  if (!isSystemTriggerEntry(entry)) return;
  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    `Trigger ${entry.id} is a system subscription (owner: the platform itself). It cannot be ${action} by any agent or user; the platform guarantees this subscription for the ops panel loop.`,
    { context: { toolName: MANAGE_TRIGGERS_TOOL_NAME, id: entry.id, action }, recoverable: true },
  );
}



function formatModelWarnings(warnings: readonly string[]): { warnings: string[] } | undefined {
  return warnings.length > 0 ? { warnings: [...warnings] } : undefined;
}


export const manageTriggersHandler: ToolHandler = async (input, context) => {
  const parsed = ManageTriggersInputSchema.parse(input) as ManageTriggersInput;
  const fileSystemPort = context.fileSystemPort;

  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for ManageTriggers tool",
      {
        context: { toolCallId: context.toolCallId, toolName: MANAGE_TRIGGERS_TOOL_NAME },
        recoverable: false,
      },
    );
  }

  // triggers.json 锚定 workspaceRoot（项目独占工作区语义），不是会话 cwd。
  const triggersRoot = join(context.workspaceRoot, ".robinrun", "triggers");
  const registryPath = join(triggersRoot, triggerRegistryFileName);
  // 读一次原文作冲突基线（写前 ensureRegistryUnchanged 比对；install_packages 不回写）。
  const baselineRaw = await readRegistryRaw(fileSystemPort, registryPath, context);
  const registry = parseRegistryContent(baselineRaw, registryPath);
  const triggers = [...registry.triggers];
  const groups = [...registry.groups];
  const profiles = [...registry.profiles];
  const warnings: string[] = [];

  let trigger: TriggerEntry | undefined;
  let group: TriggerGroupEntry | undefined;
  let profile: Pick<TriggerProfileEntry, "name" | "note" | "sites"> | undefined;
  let readmePath: string | undefined;
  let scriptDirPath: string | undefined;
  let webhookPath: string | undefined;
  let installResult: ManageTriggersOutput["installResult"];
  let loginResult: ManageTriggersOutput["loginResult"];
  const timestamp = nowIso();

  const findTrigger = (id: string): TriggerEntry => {
    const found = triggers.find((candidate) => candidate.id === id);
    if (!found) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        `No trigger with id ${id}. Ids are stable; use the id returned by create.`,
        { context: { toolName: MANAGE_TRIGGERS_TOOL_NAME, id }, recoverable: true },
      );
    }
    return found;
  };

  const assertProfileExists = (profileName: string): void => {
    if (!profiles.some((candidate) => candidate.name === profileName)) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        `Profile "${profileName}" does not exist. Create it first with the create_profile action.`,
        {
          context: { toolName: MANAGE_TRIGGERS_TOOL_NAME, profile: profileName },
          recoverable: true,
        },
      );
    }
  };

  switch (parsed.action) {
    case "create": {
      const name = parsed.name!.trim();
      // 订阅者=创建者机制层钉死：归属按调用会话身份派生，不取模型传入值（见
      // resolveOwnerAgentId 注释；传入值被忽略并在输出 warnings 里告知）。
      const ownership = resolveOwnerAgentId(context, parsed.ownerAgentId);
      const ownerAgentId = ownership.ownerAgentId;
      if (ownership.ignoredSupplied) {
        warnings.push(
          `ownerAgentId was ignored; the trigger is owned by the calling agent (${ownerAgentId}) — ownership always follows the creator, it cannot be assigned.`,
        );
      }
      const id = generateId(TRIGGER_ID_PREFIX, new Set(triggers.map((item) => item.id)));
      const config = normalizeConfig(parsed.config!, id, undefined);
      // 路由策略（2026-11-25 分发器裁决）：新建缺省 dispatcher（目的形态——绑定会话
      // 升格为分发器，话题聚类 + RouteEvents 路由）；存量条目不受影响（注册表 schema
      // 缺省 direct = 零迁移）。要旧行为的触发器由模型显式传 routing="direct"。
      const routing = parsed.routing ?? "dispatcher";
      if (config.kind === "script") {
        // 运行时门控（2026-11-22）：python 可用必须 python、不可用才允许 node 备选。
        const gate = await resolveScriptRuntimeGate(fileSystemPort, triggersRoot, context);
        assertScriptRuntimeAllowed(gate, config.runtime);
        if (config.profile !== undefined) {
          assertProfileExists(config.profile);
        }
      }
      if (config.kind !== "script" && parsed.contract !== undefined) {
        warnings.push(
          "contract applies to script triggers only; it is stored but ignored for this trigger type.",
        );
      }
      const entry: TriggerEntry = {
        id,
        name,
        ownerAgentId,
        groupId: null,
        routing,
        config,
        ...(parsed.contract !== undefined ? { contract: parsed.contract } : {}),
        status: "active",
        consecutiveFailures: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      triggers.push(entry);

      // 先落文件后写注册表：注册表在场的瞬间说明/目录必须已就绪。
      scriptDirPath = join(triggersRoot, id, triggerDirectoryConvention.script);
      readmePath = join(triggersRoot, id, triggerReadmeFileName);
      for (const directory of Object.values(triggerDirectoryConvention)) {
        await fileSystemPort.createDirectory(
          { path: join(triggersRoot, id, directory), trace: createTrace(context) },
          { signal: context.abortSignal },
        );
      }
      await fileSystemPort.writeTextFile(
        {
          path: readmePath,
          content: buildReadmeContent({
            name,
            ownerAgentId,
            readme: parsed.readme!,
            entry,
            scriptDirPath,
          }),
          atomic: true,
          createParents: true,
          trace: createTrace(context),
        },
        { signal: context.abortSignal },
      );
      if (config.kind === "webhook") webhookPath = config.path;
      trigger = entry;
      break;
    }
    case "update": {
      const existing = findTrigger(parsed.id!.trim());
      assertNotSystemTrigger(existing, "updated");
      if (parsed.name !== undefined) existing.name = parsed.name.trim();
      // 路由策略切换（2026-11-25 分发器裁决）：显式传入才改（缺省不动）。切到
      // dispatcher/fixed 后下一次投递即按新策略分流（引擎轮询拾取注册表变更）；
      // direct → dispatcher 的既有绑定会话自然升格为分发器（绑定表不变）。
      if (parsed.routing !== undefined && existing.routing !== parsed.routing) {
        existing.routing = parsed.routing;
        warnings.push(
          `routing switched to "${parsed.routing}": ${
            parsed.routing === "dispatcher"
              ? "the bound session becomes a dispatcher (events are classified and routed via RouteEvents instead of handled in place)"
              : parsed.routing === "fixed"
                ? "each delivery starts a new session directly (the previous bound session is kept as history)"
                : "events are handled in the bound session again (legacy behavior)"
          }`,
        );
      }
      if (parsed.config !== undefined) {
        existing.config = normalizeConfig(parsed.config, existing.id, existing);
        if (existing.config.kind === "script") {
          // 运行时门控（2026-11-22，同 create）：config 是全量替换，改 runtime 也在此校验
          // （node→python 迁移要求 python 可用；python 可用时 update 传 node config 一并拒绝）。
          const gate = await resolveScriptRuntimeGate(fileSystemPort, triggersRoot, context);
          assertScriptRuntimeAllowed(gate, existing.config.runtime);
          if (existing.config.profile !== undefined) {
            assertProfileExists(existing.config.profile);
          }
        }
        // 换成非 script 型时契约失去意义，一并清除（契约属于脚本语义）。
        if (existing.config.kind !== "script") {
          delete existing.contract;
        }
      }
      if (parsed.contract !== undefined) {
        if (existing.config.kind !== "script") {
          warnings.push("contract applies to script triggers only; it will be ignored.");
        }
        existing.contract = parsed.contract;
      }
      existing.updatedAt = timestamp;
      trigger = existing;
      readmePath = join(triggersRoot, existing.id, triggerReadmeFileName);
      break;
    }
    case "set_status": {
      const existing = findTrigger(parsed.id!.trim());
      assertNotSystemTrigger(existing, "disabled or re-enabled");
      existing.status = parsed.status!;
      // 重新启用（含从 error-paused 恢复）即修复确认：清零连续异常计数（裁决 5）。
      if (existing.status === "active") existing.consecutiveFailures = 0;
      existing.updatedAt = timestamp;
      trigger = existing;
      readmePath = join(triggersRoot, existing.id, triggerReadmeFileName);
      break;
    }
    case "delete": {
      const existing = findTrigger(parsed.id!.trim());
      assertNotSystemTrigger(existing, "deleted");
      if (existing.deleted === true) {
        throw createCoreError(
          CoreErrorType.ToolExecutionFailed,
          `Trigger ${existing.id} is already deleted. Deleted triggers are kept in the registry for audit only and invisible everywhere; create a new trigger if you need the same semantics.`,
          { context: { toolName: MANAGE_TRIGGERS_TOOL_NAME, id: existing.id }, recoverable: true },
        );
      }
      // 伪删除（2026-11-21 实测裁决，与会话/智能体的伪删除一致）：条目与文件保留（审计
      // 可追溯），所有消费面不可见——引擎轮询拾取后停调度/停常驻脚本/断 webhook/断投递，
      // 列表与侧栏不再渲染。不可逆（重建请走 create）。
      existing.deleted = true;
      // 状态一并停用：任何未感知 deleted 的读者（旧版本/缓存投影）也不会再执行它。
      existing.status = "deactivated";
      // 组订阅解除（保持 groupId ↔ memberTriggerIds 双向闭合的注册表不变量）。
      if (existing.groupId !== null) {
        const group = groups.find((candidate) => candidate.id === existing.groupId);
        if (group) {
          group.memberTriggerIds = group.memberTriggerIds.filter(
            (candidate) => candidate !== existing.id,
          );
          group.updatedAt = timestamp;
        }
        existing.groupId = null;
      }
      existing.updatedAt = timestamp;
      trigger = existing;
      break;
    }
    case "create_group": {
      const name = parsed.name!.trim();
      // 组订阅者同 create：按调用会话身份派生（订阅者=创建者，机制层钉死）。
      const ownership = resolveOwnerAgentId(context, parsed.ownerAgentId);
      const subscriberAgentId = ownership.ownerAgentId;
      if (ownership.ignoredSupplied) {
        warnings.push(
          `ownerAgentId was ignored; the group is subscribed by the calling agent (${subscriberAgentId}) — ownership always follows the creator, it cannot be assigned.`,
        );
      }
      const id = generateId(TRIGGER_GROUP_ID_PREFIX, new Set(groups.map((item) => item.id)));
      const memberIds = parsed.memberTriggerIds ?? [];
      for (const memberId of memberIds) {
        findTrigger(memberId).groupId = id;
      }
      group = {
        id,
        name,
        memberTriggerIds: [...memberIds],
        subscriberAgentId,
        // 组路由策略（2026-11-25 分发器裁决）：新建缺省 dispatcher（与触发器 create 同
        // 款目的形态——组是多源混批拆流的主场景）；成员条目 routing 被组值覆盖（忽略）。
        routing: parsed.routing ?? "dispatcher",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      groups.push(group);
      break;
    }
    case "update_group": {
      const groupId = (parsed.groupId ?? parsed.id!).trim();
      const existingGroup = groups.find((candidate) => candidate.id === groupId);
      if (!existingGroup) {
        throw createCoreError(
          CoreErrorType.ToolExecutionFailed,
          `No trigger group with id ${groupId}. Ids are stable; use the id returned by create_group.`,
          { context: { toolName: MANAGE_TRIGGERS_TOOL_NAME, id: groupId }, recoverable: true },
        );
      }
      if (parsed.name !== undefined) existingGroup.name = parsed.name.trim();
      // 组路由策略切换（2026-11-25 分发器裁决）：显式传入才改；下次投递按新策略分流。
      if (parsed.routing !== undefined && existingGroup.routing !== parsed.routing) {
        existingGroup.routing = parsed.routing;
        warnings.push(`group routing switched to "${parsed.routing}".`);
      }
      for (const memberId of parsed.addMemberIds ?? []) {
        const member = findTrigger(memberId);
        // 归属校验（2026-11-23，用户裁决 B6）：组不许混别的智能体的触发器——一个触发器
        // （或组）只有一个订阅者，组成员必须与组订阅者同主。此前无校验，A 可把 B 的
        // 触发器拉进自己的组（事件唤醒 B、清空会话却按组订阅者 A 重置，两套口径错乱）。
        if (member.ownerAgentId !== existingGroup.subscriberAgentId) {
          throw createCoreError(
            CoreErrorType.ToolExecutionFailed,
            `Trigger ${memberId} belongs to agent ${member.ownerAgentId}, but group ${existingGroup.id} is subscribed by ${existingGroup.subscriberAgentId}; a group and its members must share one subscriber. ${member.ownerAgentId} must create their own group.`,
            {
              context: { toolName: MANAGE_TRIGGERS_TOOL_NAME, id: memberId },
              recoverable: true,
            },
          );
        }
        if (member.groupId !== null && member.groupId !== existingGroup.id) {
          // 订阅上下文互斥（裁决 1）：先从旧组移除再入新组由调用方分两步做，这里硬拒绝防止静默改绑。
          throw createCoreError(
            CoreErrorType.ToolExecutionFailed,
            `Trigger ${memberId} already belongs to group ${member.groupId}; remove it from that group first (a trigger can belong to at most one group).`,
            {
              context: { toolName: MANAGE_TRIGGERS_TOOL_NAME, id: memberId },
              recoverable: true,
            },
          );
        }
        member.groupId = existingGroup.id;
        if (!existingGroup.memberTriggerIds.includes(memberId)) {
          existingGroup.memberTriggerIds.push(memberId);
        }
      }
      for (const memberId of parsed.removeMemberIds ?? []) {
        const member = findTrigger(memberId);
        if (member.groupId === existingGroup.id) {
          member.groupId = null;
        }
        existingGroup.memberTriggerIds = existingGroup.memberTriggerIds.filter(
          (candidate) => candidate !== memberId,
        );
      }
      existingGroup.updatedAt = timestamp;
      group = existingGroup;
      break;
    }
    case "create_profile": {
      const profileName = parsed.profileName!.trim();
      if (profiles.some((candidate) => candidate.name === profileName)) {
        throw createCoreError(
          CoreErrorType.ToolExecutionFailed,
          `Profile "${profileName}" already exists. Profiles are referenced by name from script configs.`,
          {
            context: { toolName: MANAGE_TRIGGERS_TOOL_NAME, profile: profileName },
            recoverable: true,
          },
        );
      }
      const entry: TriggerProfileEntry = {
        name: profileName,
        ...(parsed.profileNote !== undefined ? { note: parsed.profileNote } : {}),
        ...(parsed.profileSites !== undefined ? { sites: parsed.profileSites } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      profiles.push(entry);
      profile = { name: entry.name, note: entry.note, sites: entry.sites };
      break;
    }
    case "install_packages": {
      // 反向请求到宿主引擎执行（2026-11-22）：引擎持解释器/venv 生命周期，CLI 只转发。
      // 端口缺席（独立 CLI / 桌面端未运行）= 诚实拒绝，不静默。
      const triggerRuntimePort = context.triggerRuntimePort;
      if (triggerRuntimePort === undefined) {
        throw createCoreError(
          CoreErrorType.ConfigurationError,
          "install_packages requires the desktop trigger engine (TriggerRuntimePort is not wired in this host) — start the desktop app and retry",
          {
            context: { toolCallId: context.toolCallId, toolName: MANAGE_TRIGGERS_TOOL_NAME },
            recoverable: false,
          },
        );
      }
      const install = await triggerRuntimePort.installPackages({
        workspacePath: context.workspaceRoot,
        sessionId: context.sessionId,
        packages: parsed.packages!,
        trace: createTrace(context),
      });
      installResult = install;
      break;
    }
    case "open_login": {
      // 反向请求到宿主引擎执行（2026-11-25 登录闭环，specs/trigger-browser-hosting.md
      // §3.4）：引擎持有浏览器实例与登录会话生命周期，CLI 只转发。端口缺席 = 诚实拒绝。
      const 条目 = findTrigger(parsed.id!);
      assertNotSystemTrigger(条目, "opened for login");
      if (条目.config.kind !== "script") {
        throw createCoreError(
          CoreErrorType.ToolExecutionFailed,
          "open_login applies to script triggers only",
          { context: { toolName: MANAGE_TRIGGERS_TOOL_NAME, id: 条目.id }, recoverable: true },
        );
      }
      if (条目.config.profile === undefined) {
        throw createCoreError(
          CoreErrorType.ToolExecutionFailed,
          'this script trigger declares no login profile (config.profile is unset) — declare a profile to use engine-hosted browsers',
          { context: { toolName: MANAGE_TRIGGERS_TOOL_NAME, id: 条目.id }, recoverable: true },
        );
      }
      const triggerRuntimePort = context.triggerRuntimePort;
      if (triggerRuntimePort === undefined) {
        throw createCoreError(
          CoreErrorType.ConfigurationError,
          "open_login requires the desktop trigger engine (TriggerRuntimePort is not wired in this host) — start the desktop app and retry",
          {
            context: { toolCallId: context.toolCallId, toolName: MANAGE_TRIGGERS_TOOL_NAME },
            recoverable: false,
          },
        );
      }
      const result = await triggerRuntimePort.openLogin({
        workspacePath: context.workspaceRoot,
        sessionId: context.sessionId,
        triggerId: 条目.id,
        ...(parsed.loginUrl !== undefined ? { url: parsed.loginUrl } : {}),
        trace: createTrace(context),
      });
      loginResult = result;
      trigger = 条目;
      break;
    }
  }

  // webhook 触发器（create/update/set_status 命中时）：读引擎基址拼完整回调 URL。
  // 引擎未运行（CLI headless / 桌面端未启动）时 URL 缺席，文案指引稍后再查。
  let webhookUrl: string | undefined;
  if (trigger !== undefined && trigger.config.kind === "webhook") {
    const baseUrl = await readWebhookBaseUrl(fileSystemPort, triggersRoot, context);
    if (baseUrl !== undefined) {
      webhookUrl = `${baseUrl.replace(/\/$/, "")}/${trigger.config.path}?token=${trigger.config.token}`;
    } else {
      warnings.push(
        "Webhook endpoint URL is unavailable because the trigger engine (desktop app) is not running yet; the URL is delivered by ManageTriggers once the engine is up.",
      );
    }
  }

  const output = ManageTriggersOutputSchema.parse({
    action: parsed.action,
    ...(trigger !== undefined ? { trigger: serializeTrigger(trigger) } : {}),
    ...(group !== undefined ? { group } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(readmePath !== undefined ? { readmePath } : {}),
    ...(scriptDirPath !== undefined ? { scriptDirPath } : {}),
    ...(webhookPath !== undefined ? { webhookPath } : {}),
    ...(webhookUrl !== undefined ? { webhookUrl } : {}),
    ...(installResult !== undefined ? { installResult } : {}),
    ...(loginResult !== undefined ? { loginResult } : {}),
    triggerCount: triggers.length,
    groupCount: groups.length,
    ...formatModelWarnings(warnings),
  } satisfies ManageTriggersOutput);
  // install_packages / open_login 不改注册表（引擎侧写状态/落档案），跳过回写——否则
  // 分钟级窗口内引擎的写入会被本动作的陈旧快照整体回滚（见 ensureRegistryUnchanged 注释）。
  if (parsed.action !== "install_packages" && parsed.action !== "open_login") {
    await ensureRegistryUnchanged(fileSystemPort, registryPath, context, baselineRaw);
    await writeRegistry(fileSystemPort, registryPath, { ...registry, triggers, groups, profiles }, context);
  }
  return output;
}

/** 注册表条目 → 输出镜像（strict 输出 schema 只认 contracts 侧的 config 形状）。 */
function serializeTrigger(entry: TriggerEntry): ManageTriggersOutput["trigger"] {
  return {
    id: entry.id,
    name: entry.name,
    ownerAgentId: entry.ownerAgentId,
    groupId: entry.groupId,
    config: entry.config,
    ...(entry.contract !== undefined ? { contract: entry.contract } : {}),
    status: entry.status,
    ...(entry.deleted !== undefined ? { deleted: entry.deleted } : {}),
    ...(entry.lastFireAt !== undefined ? { lastFireAt: entry.lastFireAt } : {}),
    ...(entry.lastResult !== undefined ? { lastResult: entry.lastResult } : {}),
    consecutiveFailures: entry.consecutiveFailures,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function formatManageTriggersModelContent(output: unknown): string {
  const parsed = ManageTriggersOutputSchema.safeParse(output);
  if (!parsed.success) {
    return typeof output === "string" ? output : (JSON.stringify(output) ?? String(output));
  }
  const data = parsed.data;
  const lines: string[] = [];
  switch (data.action) {
    case "create":
      lines.push(
        `Trigger "${data.trigger?.name}" created (id: ${data.trigger?.id}). Its events will be delivered into one dedicated session of the subscriber.`,
      );
      if (data.scriptDirPath && data.trigger?.config.kind === "script") {
        lines.push(
          `Write the script to ${data.scriptDirPath} (entry path as configured) with Write/Edit.`,
        );
        // 运行模式差异在工具输出钉死（2026-11-25 定时执行模式）：scheduled 趟 = 一趟采集
        // 即退，写循环/睡眠的脚本会在下一趟重入跳过。"runMode" in 守卫：输出镜像的 config
        // 联合里还有无 runMode 的遗留 script 变体（旧注册表）。
        if ("runMode" in data.trigger.config && data.trigger.config.runMode === "scheduled") {
          lines.push(
            'Run mode: scheduled — the engine runs the script ONCE per schedule fire; each run does one pass (collect data, emit event(s) via robinrun.emit, exit 0). Do NOT loop, sleep, or wait inside the script. exit 0 does NOT complete the trigger — it stays active for the next fire.',
          );
        }
        // 出口契约在工具输出同样钉死（与 README 脚手架双保险，2026-11-19 验收 bug），
        // 文案按 runtime 双变体（2026-11-22 python 主 + node 备选；旧版"stdout 最后
        // 一行 JSON"批处理契约文案已随常驻模型退役）。
        if (data.trigger.config.runtime === "python") {
          lines.push(
            'Script runtime: python (managed interpreter, per-project venv). Output contract: the engine injects a helper module — `import robinrun` then call `robinrun.emit("short summary", data)` for each event. The call blocks until the engine accepts it and raises on contract violation (the assertions run against data; 3 consecutive failures circuit-break the trigger). Do NOT print events to stdout — stdout/stderr are audit logs only, so subprocess/library output cannot corrupt events.',
            "Third-party packages: request ManageTriggers install_packages — the project venv is shared by all python script triggers, and active python scripts restart automatically after an install.",
          );
        } else {
          lines.push(
            'Script runtime: node (fallback — python is currently unavailable). Output contract: report events with the injected global robinrun.emit({summary, data}) — AWAIT it (it resolves when the engine accepts the event); register robinrun.onShutdown(fn) for graceful cleanup. Standard library only — no third-party packages. Once python becomes available, migrate via the update action with runtime "python".',
          );
        }
      }
      if (data.readmePath) {
        lines.push(`Description file: ${data.readmePath} (edit with Write/Edit).`);
      }
      if (data.webhookUrl) {
        lines.push(
          `Webhook endpoint: POST events to ${data.webhookUrl} (Content-Type: application/json; or send the token via the x-robinrun-token header). The port is engine-assigned and may change after the desktop app restarts — re-run the change action to refresh it.`,
        );
      }
      break;
    case "update":
      lines.push(`Trigger ${data.trigger?.id} updated.`);
      if (data.webhookUrl) {
        lines.push(`Webhook endpoint: ${data.webhookUrl}`);
      }
      break;
    case "set_status":
      lines.push(
        `Trigger ${data.trigger?.id} is now ${data.trigger?.status}${data.trigger?.status === "active" ? " (failure count reset to 0)" : ""}.`,
      );
      break;
    case "create_group":
      lines.push(
        `Trigger group "${data.group?.name}" created (id: ${data.group?.id}). Member events share the group session (key: ${TRIGGER_GROUP_SESSION_KEY_PREFIX}${data.group?.id}).`,
      );
      break;
    case "update_group":
      lines.push(`Trigger group ${data.group?.id} updated (members: ${data.group?.memberTriggerIds.length ?? 0}).`);
      break;
    case "create_profile":
      lines.push(
        `Login-state profile "${data.profile?.name}" registered. The storageState file is created on the script's first logged-in run.`,
      );
      break;
    case "open_login": {
      const login = data.loginResult;
      if (login === undefined) break;
      if (login.ok) {
        lines.push(
          `Login session completed for profile "${login.profile ?? data.trigger?.id}" — the storage state was saved. Re-enable the trigger with ManageTriggers set_status (status "active"); the next run resumes headless with the refreshed login state.`,
        );
      } else {
        lines.push(`open_login failed: ${login.error ?? "unknown error"}`);
        for (const line of login.guidance ?? []) lines.push(line);
      }
      break;
    }
    case "install_packages": {
      const install = data.installResult;
      if (install === undefined) break;
      if (install.ok) {
        lines.push(
          `Installed ${install.packages?.join(", ") ?? "packages"} into the project's python venv.`,
        );
        if (install.restartedTriggerIds !== undefined && install.restartedTriggerIds.length > 0) {
          lines.push(
            `Active python script triggers restart automatically so the new packages take effect: ${install.restartedTriggerIds.join(", ")}.`,
          );
        }
        if (install.replayFailures !== undefined && install.replayFailures.length > 0) {
          lines.push(
            `Note: the venv was rebuilt before this install and replaying previously installed packages failed for: ${install.replayFailures.join(" | ")}`,
          );
        }
        if (install.outputTail !== undefined && install.outputTail.trim().length > 0) {
          lines.push(`pip output tail:\n${install.outputTail.slice(-1_500)}`);
        }
      } else {
        lines.push(`install_packages failed: ${install.error ?? "unknown error"}`);
        if (install.outputTail !== undefined && install.outputTail.trim().length > 0) {
          lines.push(`pip output tail:\n${install.outputTail.slice(-1_500)}`);
        }
        lines.push(
          "The engine re-probes python at app start and on every install_packages; if the network path is the problem, ask the user to check ROBINRUN_PYTHON_RUNTIME_MIRROR (interpreter download) or ROBINRUN_PIP_INDEX_URL (pip index) configuration.",
        );
      }
      break;
    }
  }
  if (data.webhookPath) {
    lines.push(
      `Webhook endpoint path: ${data.webhookPath} — POST events to the engine's local loopback URL (full URL with port is shown in the app trigger detail); token is stored in the registry.`,
    );
  }
  lines.push(`Registry: ${data.triggerCount} trigger(s), ${data.groupCount} group(s).`);
  lines.push(
    `Engine note: the desktop trigger engine picks up registry changes automatically (session keys trigger:<id> / ${TRIGGER_GROUP_SESSION_KEY_PREFIX}<gid>); ${triggerAuditFileName} under the trigger's log/ dir records every fire.`,
    `Profiles dir: .robinrun/triggers/${triggerProfilesDirectoryName} (credential-level sensitive; never log its contents).`,
  );
  return [...lines, ...(data.warnings ?? [])].join("\n");
}

export const manageTriggersToolEntry: ToolEntry = {
  capability: "Manage the project trigger registry (create/update triggers, groups, login profiles)",
  metadata: {
    name: MANAGE_TRIGGERS_TOOL_NAME,
    description: [
      "Manage this project's trigger registry — scheduled checks (cron/interval), local webhooks, and script triggers that wake agents with events. Any agent (main or worker) can create triggers; ownership always follows the creator and is derived by the system from the calling session (a worker session owns the trigger with its wkr-id; a main session owns it as master) — you cannot create a trigger or group for another agent, and an ownerAgentId input is ignored. A trigger's events are delivered into ONE dedicated session keyed by the trigger (or its group). Boundary: only create and manage triggers that are yours or that you were explicitly instructed to handle — never touch or report on unrelated triggers.",
      "",
      "Actions:",
      "- create: register a trigger. Requires name, config (cron | interval | webhook | script), and readme (purpose, data source, output contract, failure handling) — every trigger MUST have a description. For script triggers, write the script into the returned script/ directory afterwards with Write/Edit.",
      "- update: change name, config (full replacement), or contract of an existing trigger.",
      "- set_status: active (enable; resets the failure count; restarting a resident script or rerunning a completed one), deactivated (disable; files kept), error-paused (normally set by the engine after 3 consecutive script crashes; re-enable after fixing). completed is an engine-written terminal state — re-enable from it to rerun.",
      "- create_group / update_group: bundle triggers into a subscription group so their events share one session (dedup context by design). A trigger belongs to at most one group.",
      "- create_profile: register a login-state profile name that script configs can reference (storageState is captured on first logged-in run).",
      "- install_packages: pip-install third-party packages into this project's python venv for python script triggers (requires the desktop engine; active python scripts restart automatically on success).",
      "- open_login: open a HEADED login window for a script trigger's login profile (requires the desktop engine). Always pass loginUrl (the site's login page) so the window lands on it instead of a blank tab. The user logs in and closes the window — closing it saves the refreshed storage state; then re-enable the trigger with set_status. Use it when a script reported a login failure (the trigger is error-paused and the subscriber was woken with diagnostics).",
      "",
      "Rules: never edit triggers.json directly; descriptions and scripts are edited via Write/Edit on README.md / script files, not through this tool. Script runtimes are gated by the engine: python is the primary script runtime (third-party packages via install_packages), and the node fallback (standard library only) is accepted only while python is unavailable — create/update enforce this, and the create result plus the README scaffold tell you which event protocol to write. Script triggers run unattended — keep them read-only where possible and declare sanity assertions in the contract so failures are detected instead of silently returning wrong data. Sizing by responsibility boundary, never one-script-per-topic: one responsibility domain (e.g. a platform's comments + traffic + operations data) = ONE script emitting its several event types with routing \"dispatcher\"; unrelated domains stay in separate scripts; periodic checks without a persistent subscription use runMode \"scheduled\" (one pass per fire, no resident process).",
    ].join("\n"),
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: manageTriggersHandler,
  formatModelContent: formatManageTriggersModelContent,
  inputSchema: ManageTriggersInputJsonSchema,
  outputSchema: ManageTriggersOutputJsonSchema,
  runtimeInputSchema: ManageTriggersInputSchema,
  runtimeOutputSchema: ManageTriggersOutputSchema,
  permission: {
    permission: "edit",
    reason: "ManageTriggers changes the project trigger registry under .robinrun/triggers",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["input"],
    alwaysAllowPatternSources: ["input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 16_000,
    maxModelBytes: 16_000,
    strategy: "inline",
  },
  timeout: { kind: "none" },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage: "ManageTriggers was cancelled; the trigger registry is unchanged",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
