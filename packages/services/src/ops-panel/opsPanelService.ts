/* 需求/审批/反馈面板服务主体（2026-11-24 MVP；同日两次裁决修订）：
   - 权限矩阵与 worker 可见性过滤的唯一收口（数据/接口层，不是 UI 隐藏）；
   - 录入与来源拆分（用户裁决）：用户经对话向 master 转述需求/反馈，master 代录
     （author=来源 user、recordedBy=master），UI 表单退役（user actor 不再直接创建）；
   - 串行唤醒队列：订阅配置 wakeRules 声明每事件的录入者豁免（通用机制，规则随订阅
     播种进触发器注册表，逻辑读配置不写死）——master 在场录入一律免唤醒；
   - 系统特权订阅播种（需求 §3.1）：经引擎 ensureSystemSubscription 幂等播种；
   - 挂载恢复：in_flight → pending（重启后重派发），队列与条目状态全在 SQLite。
   项目进度账本（2026-11-25，specs/progress-ledger.md）同挂本服务：无状态机、无事件
   面（不唤醒不通知）——master 原位维护（update/delete，只呈现有效最终态），user 纯
   只读，worker 不读不写；系统锚条目"项目初始化"首触幂等播种。 */
import {
  OPS_PANEL_CREATION_EVENT_BY_KIND,
  OPS_PANEL_EVENT_BY_KIND,
  OPS_PANEL_SYSTEM_TRIGGER_ID,
  OPS_PANEL_SYSTEM_TRIGGER_NAME,
  PROGRESS_ANCHOR_BODY,
  PROGRESS_ANCHOR_TITLE,
  opsAuthorOfActor,
  type OpsAuthor,
  type OpsEntryKind,
  type OpsPanelActor,
  type OpsPanelEntry,
  type OpsPanelEventName,
  type OpsPanelView,
  type ProgressEntry,
  type ProgressView,
} from "@robindone/shared";
import type {
  IOpsPanelService,
  OpsApprovalDecision,
  OpsEntryAuthorOverride,
  OpsPanelDispatchPort,
  OpsPanelNotificationPort,
  OpsPanelProjectMetaPort,
  OpsPanelSystemSubscriptionPort,
  OpsRequirementOutcome,
} from "./contract.js";
import type { OpsPanelQueueHead } from "./opsPanelRepo.js";
import { OpsPanelRepo } from "./opsPanelRepo.js";

interface WorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

interface OpsPanelServiceOptions {
  repo: OpsPanelRepo;
  dispatch: OpsPanelDispatchPort;
  ensureSystemSubscription?: OpsPanelSystemSubscriptionPort;
  notify?: OpsPanelNotificationPort;
  /** 项目元数据端口（host 装配注入：锚条目 createdAt 取项目真实创建时间；缺席回退首触时间）。 */
  progressProjectMeta?: OpsPanelProjectMetaPort;
  /** 系统订阅 README（宿主可覆盖文案；缺省内置说明）。 */
  subscriptionReadme?: string;
  log?(message: string): void;
}

/**
 * 系统订阅定义（面板平台的声明式数据：同时供播种与唤醒判定，改规则只改这里，注册表
 * 内的配置随幂等播种自动跟进）。2026-11-24 用户裁决：需求/反馈由 master 对话代录，
 * requirement.created 退出订阅面（录入方在场免唤醒）；唤醒面只剩用户决策
 * （approval.decided）与 worker 反馈（feedback.created，master 代录经豁免规则免唤醒）。
 */
const OPS_PANEL_SUBSCRIPTION: {
  events: string[];
  wakeRules: Record<string, { exemptRecordedBy: string[] }>;
} = {
  events: ["approval.decided", "feedback.created"],
  wakeRules: {
    "feedback.created": { exemptRecordedBy: ["master"] },
  },
};

const DEFAULT_SUBSCRIPTION_README = [
  "# 运营面板（系统特权订阅）",
  "",
  "本条目是平台播种的系统级订阅（需求/审批/反馈面板的唤醒通道），订阅事件：",
  "approval.decided（用户批准/驳回审批）、feedback.created（worker 反馈）。",
  "",
  "- 任何智能体与用户都不可停用、删除或修改本条目（ManageTriggers 与引擎双层拒绝）。",
  "- 需求/反馈的录入走对话：用户直接告诉 master，由 master 代录（recordedBy=master，",
  "  免唤醒）；worker 反馈与用户决策仍然唤醒 master。",
  "- 面板事件不经调度器：由 ops-panel 服务按串行队列直接投递到订阅绑定会话",
  "  （上一条处置完成后才唤醒下一条，不合并）。",
  "- 处置入口：ManageOpsPanel 工具（处置 ≠ 开发交付；受理后的开发排期不占队列）。",
].join("\n");

function isWorkerActor(
  actor: OpsPanelActor,
): actor is Extract<OpsPanelActor, { role: "agent" }> & { agentId: `worker:${string}` } {
  return actor.role === "agent" && actor.agentId.startsWith("worker:");
}

/** worker 可见性过滤：仅自己提交的条目（完整生命周期可见，需求 §4）。 */
function workerAuthorFilter(actor: OpsPanelActor): string | undefined {
  if (!isWorkerActor(actor)) return undefined;
  return actor.agentId;
}

export class OpsPanelService implements IOpsPanelService {
  private readonly log: (message: string) => void;
  private readonly seededWorkspaces = new Set<string>();
  /** 锚播种完成标记（锚不可删，播种成功即终态；失败不标记，下次触达重试）。 */
  private readonly progressAnchorSeeded = new Set<string>();

  constructor(private readonly options: OpsPanelServiceOptions) {
    this.log = options.log ?? (() => {});
  }

  /** 首次触达 workspace 的懒初始化：迁移 + 订阅播种 + 挂载恢复 + 队列 pump。幂等。 */
  async ensureWorkspacePanel(scope: WorkspaceScope): Promise<void> {
    await this.options.repo.ensureReady();
    const key = this.workspaceKey(scope);
    if (this.seededWorkspaces.has(key)) return;
    this.seededWorkspaces.add(key);
    if (this.options.ensureSystemSubscription !== undefined) {
      try {
        await this.options.ensureSystemSubscription.ensureSystemSubscription({
          workspacePath: scope.workspacePath,
          subscription: {
            id: OPS_PANEL_SYSTEM_TRIGGER_ID,
            name: OPS_PANEL_SYSTEM_TRIGGER_NAME,
            events: [...OPS_PANEL_SUBSCRIPTION.events],
            wakeRules: OPS_PANEL_SUBSCRIPTION.wakeRules,
            readme: this.options.subscriptionReadme ?? DEFAULT_SUBSCRIPTION_README,
          },
        });
      } catch (error) {
        // 播种失败不阻塞面板使用（下一次进程启动重试）；唤醒仍可工作，只是注册表暂缺条目。
        this.log(
          `ensureSystemSubscription failed for ${scope.workspacePath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const restored = this.options.repo.resetInFlightToPending(key);
    if (restored > 0) {
      this.log(`ops-panel mount recovery: ${restored} in-flight item(s) back to pending`);
    }
    this.pumpQueue(scope);
  }

  // ---- 读取 ----

  async getPanelView(params: WorkspaceScope & { actor: OpsPanelActor }): Promise<OpsPanelView> {
    await this.ensureWorkspacePanel(params);
    const entries = await this.options.repo.listEntries({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      authorFilter: workerAuthorFilter(params.actor),
    });
    const queue = await this.options.repo.getQueueSnapshot({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    // worker 只见自己条目时，队列投影同样收窄到自己的在途/待唤醒条目。
    const visibleIds = new Set(entries.map((entry) => entry.id));
    return {
      entries,
      queue: {
        inFlightId:
          queue.inFlightId !== null && visibleIds.has(queue.inFlightId) ? queue.inFlightId : null,
        pendingIds: queue.pendingIds.filter((id) => visibleIds.has(id)),
      },
    };
  }

  async getEntry(
    params: WorkspaceScope & { entryId: string; actor: OpsPanelActor },
  ): Promise<OpsPanelEntry | null> {
    await this.ensureWorkspacePanel(params);
    return this.options.repo.getEntry({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      entryId: params.entryId,
      authorFilter: workerAuthorFilter(params.actor),
    });
  }

  // ---- 创建（权限矩阵 + 录入豁免） ----

  async createEntry(
    params: WorkspaceScope & {
      kind: OpsEntryKind;
      title: string;
      body: string;
      /** 来源标记：master 代录时必传（requirement 恒 user；feedback "user"|"master"）。 */
      author?: OpsEntryAuthorOverride;
      links?: Record<string, string>;
      actor: OpsPanelActor;
    },
  ): Promise<OpsPanelEntry> {
    const recordedBy = this.assertCreateAllowed(params.kind, params.actor);
    const author = this.resolveEntryAuthor(params.kind, params.actor, params.author);
    await this.ensureWorkspacePanel(params);
    const wakeupState = this.initialWakeupState(params.kind, recordedBy);
    const entry = await this.options.repo.insertEntry({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      kind: params.kind,
      title: params.title,
      body: params.body,
      author,
      recordedBy,
      wakeupState,
      ...(params.links !== undefined ? { links: params.links } : {}),
    });
    this.options.notify?.panelChanged({ workspacePath: params.workspacePath });
    if (wakeupState === "pending") {
      // 认领可能已把 REQ 置 in_progress（处理中）；返回认领后的最新快照而非插入时快照。
      this.pumpQueue(params);
      const latest = await this.options.repo.getEntry({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        entryId: entry.id,
      });
      return latest ?? entry;
    }
    return entry;
  }

  // ---- 用户决定审批 ----

  async decideApproval(
    params: WorkspaceScope & {
      entryId: string;
      decision: OpsApprovalDecision;
      note?: string;
      actor: OpsPanelActor;
    },
  ): Promise<OpsPanelEntry> {
    // 批准/驳回是用户的决策门动作（需求 §4：master/worker 均不可）。
    if (params.actor.role !== "user") {
      throw new Error("Only the user can approve or reject an approval (decide via the panel UI).");
    }
    await this.ensureWorkspacePanel(params);
    const key = this.workspaceKey(params);
    const entry = await this.options.repo.getEntry({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      entryId: params.entryId,
    });
    if (entry === null || entry.kind !== "approval") {
      throw new Error(`Approval ${params.entryId} not found.`);
    }
    this.options.repo.decideApproval(key, params.entryId, {
      decision: params.decision,
      ...(params.note !== undefined ? { note: params.note } : {}),
    });
    this.options.notify?.panelChanged({ workspacePath: params.workspacePath });
    // approval.decided 经串行队列唤醒 master 执行（需求 §3.2）。
    this.pumpQueue(params);
    return (await this.options.repo.getEntry({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      entryId: params.entryId,
    })) as OpsPanelEntry;
  }

  // ---- master 处置（处置即释放） ----

  async decideRequirement(
    params: WorkspaceScope & {
      entryId: string;
      outcome: OpsRequirementOutcome;
      note?: string;
      actor: OpsPanelActor;
    },
  ): Promise<OpsPanelEntry> {
    this.assertMasterActor(params.actor, "dispose a requirement");
    return this.disposeEntry(params, (key, entryId) =>
      this.options.repo.disposeRequirement(key, entryId, {
        outcome: params.outcome,
        ...(params.note !== undefined ? { note: params.note } : {}),
      }),
    );
  }

  async resolveFeedback(
    params: WorkspaceScope & { entryId: string; note?: string; actor: OpsPanelActor },
  ): Promise<OpsPanelEntry> {
    this.assertMasterActor(params.actor, "resolve feedback");
    return this.disposeEntry(params, (key, entryId) =>
      this.options.repo.resolveFeedback(
        key,
        entryId,
        params.note !== undefined ? { note: params.note } : {},
      ),
    );
  }

  async acknowledgeApproval(
    params: WorkspaceScope & { entryId: string; note?: string; actor: OpsPanelActor },
  ): Promise<OpsPanelEntry> {
    this.assertMasterActor(params.actor, "acknowledge an approval");
    return this.disposeEntry(params, (key, entryId) =>
      this.options.repo.acknowledgeApproval(
        key,
        entryId,
        params.note !== undefined ? { note: params.note } : {},
      ),
    );
  }

  // ---- 内部 ----

  private workspaceKey(scope: WorkspaceScope): string {
    // 与 tasks/automations 同一派生规则（workspaceIdentity 优先）。
    return (scope.workspaceIdentity?.trim() || scope.workspacePath).trim();
  }

  /**
   * 创建权限矩阵（2026-11-24 用户裁决"对话代录"）+ 录入者机制层派生。
   * user actor 不再直接创建（UI 表单退役，用户经对话向 master 转述）；requirement/
   * approval 仅 master；feedback master 代录或 worker 自录。返回 recordedBy。
   */
  private assertCreateAllowed(kind: OpsEntryKind, actor: OpsPanelActor): OpsAuthor {
    if (actor.role === "user") {
      throw new Error(
        "Entries are recorded by master now - tell master your requirement or feedback in conversation.",
      );
    }
    if (kind === "requirement" && actor.agentId !== "master") {
      throw new Error(
        "Only master can record requirements (author=user on behalf of the reporter); workers raise feedback instead.",
      );
    }
    if (kind === "approval" && actor.agentId !== "master") {
      throw new Error("Only master can draft approvals.");
    }
    return actor.agentId;
  }

  private assertMasterActor(actor: OpsPanelActor, action: string): void {
    if (actor.role !== "agent" || actor.agentId !== "master") {
      throw new Error(`Only master can ${action} (workers and the UI cannot change entry states).`);
    }
  }

  /** 来源标记派生（author=来源，recordedBy=经手录入者）：机制层收口，不采信模型传值。 */
  private resolveEntryAuthor(
    kind: OpsEntryKind,
    actor: OpsPanelActor,
    override: OpsEntryAuthorOverride | undefined,
  ): OpsAuthor {
    if (actor.role === "user") return "user";
    if (actor.agentId === "master") {
      // master 代录：requirement 恒 user（需求来自用户的对话转述）；approval 恒 master
      // （master 自己起草）；feedback 按显式标记（user=用户转述 / master=master 自见）。
      if (kind === "requirement") return "user";
      if (kind === "approval") return "master";
      if (override === undefined) {
        throw new Error(
          'Feedback author is required when master records it ("user" for user-reported, "master" for master\'s own).',
        );
      }
      return override;
    }
    // worker 自录：author=worker:<id>，override 不采信（机制层派生赢）。
    return opsAuthorOfActor(actor);
  }

  /**
   * 唤醒判定（2026-11-24 通用机制，规则读订阅配置 OPS_PANEL_SUBSCRIPTION，不按 kind
   * 写死）：创建事件未订阅（requirement.created 已退出订阅面）或无创建事件（approval
   * 创建）→ 不唤醒；已订阅且录入者在 exemptRecordedBy（master 在场录入）→ 免唤醒；
   * 否则入队唤醒。
   */
  private initialWakeupState(kind: OpsEntryKind, recordedBy: OpsAuthor): "pending" | "none" {
    const eventName: OpsPanelEventName | undefined = OPS_PANEL_CREATION_EVENT_BY_KIND[kind];
    if (eventName === undefined) return "none";
    if (!(OPS_PANEL_SUBSCRIPTION.events as readonly string[]).includes(eventName)) return "none";
    const exempt = OPS_PANEL_SUBSCRIPTION.wakeRules[eventName]?.exemptRecordedBy ?? [];
    return exempt.includes(recordedBy) ? "none" : "pending";
  }

  /**
   * 处置统一收口：改状态 → 按"处置前是否在途"决定释放级联 → 返回最新条目。
   * - 在途（in_flight）：claimNextQueueHead 原子释放 + 认领队头，认领即投递；
   * - 待唤醒（pending，master 提前处置）：静默出队，不触发唤醒；
   * - 不在队列（none/released）：无队列动作。
   */
  private async disposeEntry(
    params: WorkspaceScope & { entryId: string; actor: OpsPanelActor },
    mutate: (key: string, entryId: string) => void,
  ): Promise<OpsPanelEntry> {
    await this.ensureWorkspacePanel(params);
    const key = this.workspaceKey(params);
    const entry = await this.options.repo.getEntry({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      entryId: params.entryId,
    });
    if (entry === null) {
      throw new Error(`Entry ${params.entryId} not found.`);
    }
    const priorWakeupState = await this.options.repo.getWakeupState(key, params.entryId);
    mutate(key, params.entryId);
    if (priorWakeupState === "in_flight") {
      const head = this.options.repo.claimNextQueueHead(key, { justReleasedId: params.entryId });
      if (head !== null) {
        this.dispatchQueueHead(params, head);
      }
    } else if (priorWakeupState === "pending") {
      this.options.repo.releaseQuietly(key, params.entryId);
    }
    this.options.notify?.panelChanged({ workspacePath: params.workspacePath });
    const updated = await this.options.repo.getEntry({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      entryId: params.entryId,
    });
    if (updated === null) {
      throw new Error(`Entry ${params.entryId} disappeared during disposal.`);
    }
    return updated;
  }

  /** 泵队列：队列空闲则认领队头并投递（串行的唯一入队口）。 */
  private pumpQueue(scope: WorkspaceScope): void {
    const key = this.workspaceKey(scope);
    const head = this.options.repo.claimNextQueueHead(key);
    if (head !== null) {
      this.dispatchQueueHead(scope, head);
    }
  }

  /** 投递认领的队头（异步 fire；失败回退 pending，由下一次处置/挂载重试）。 */
  private dispatchQueueHead(scope: WorkspaceScope, head: OpsPanelQueueHead): void {
    const key = this.workspaceKey(scope);
    void (async () => {
      try {
        const entry = await this.options.repo.getEntry({
          workspacePath: scope.workspacePath,
          workspaceIdentity: scope.workspaceIdentity,
          entryId: head.id,
        });
        if (entry === null) {
          this.options.repo.requeueEntry(key, head.id);
          return;
        }
        await this.options.dispatch.dispatchOpsPanelWakeup({
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity !== undefined
            ? { workspaceIdentity: scope.workspaceIdentity }
            : {}),
          triggerId: OPS_PANEL_SYSTEM_TRIGGER_ID,
          triggerName: OPS_PANEL_SYSTEM_TRIGGER_NAME,
          eventName: OPS_PANEL_EVENT_BY_KIND[entry.kind],
          entry,
        });
        this.log(`ops-panel wakeup dispatched: ${entry.id} (${entry.kind})`);
      } catch (error) {
        this.options.repo.requeueEntry(key, head.id);
        this.log(
          `ops-panel wakeup dispatch failed for ${head.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    })();
  }

  // ---- 进度账本（2026-11-25，specs/progress-ledger.md）----
  // 无状态机、无事件面：进度是被动叙事，不产生事件、不订阅、不唤醒、不通知——
  // 写动作只广播 panelChanged 供 UI 即时刷新。

  async getProgressView(params: WorkspaceScope & { actor: OpsPanelActor }): Promise<ProgressView> {
    // worker 先拒（进度是 master 的叙事，worker 不读不写；spec §5）——拒绝路径不做
    // 任何播种副作用。
    this.assertProgressReader(params.actor);
    await this.ensureWorkspacePanel(params);
    await this.ensureProgressAnchor(params);
    const entries = await this.options.repo.listProgressEntries({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    return { entries };
  }

  async appendProgress(
    params: WorkspaceScope & {
      title: string;
      body?: string;
      links?: string[];
      actor: OpsPanelActor;
    },
  ): Promise<ProgressEntry> {
    this.assertMasterActor(params.actor, "append progress");
    await this.ensureWorkspacePanel(params);
    await this.ensureProgressAnchor(params);
    const entry = await this.options.repo.insertProgressEntry({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      title: params.title,
      ...(params.body !== undefined ? { body: params.body } : {}),
      ...(params.links !== undefined ? { links: params.links } : {}),
      createdBy: "master",
    });
    this.options.notify?.panelChanged({ workspacePath: params.workspacePath });
    return entry;
  }

  async updateProgress(
    params: WorkspaceScope & {
      entryId: string;
      title?: string;
      body?: string;
      links?: string[];
      actor: OpsPanelActor;
    },
  ): Promise<ProgressEntry> {
    this.assertMasterActor(params.actor, "update progress");
    await this.ensureWorkspacePanel(params);
    const key = this.workspaceKey(params);
    // 原位维护制（spec §3）：直改不留痕；目标不存在/已软删由 repo 变更数 0 抛错。
    this.options.repo.updateProgressEntry(key, params.entryId, {
      ...(params.title !== undefined ? { title: params.title } : {}),
      ...(params.body !== undefined ? { body: params.body } : {}),
      ...(params.links !== undefined ? { links: params.links } : {}),
    });
    this.options.notify?.panelChanged({ workspacePath: params.workspacePath });
    const updated = await this.options.repo.getProgressEntry({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      entryId: params.entryId,
    });
    if (updated === null) {
      throw new Error(`Progress entry ${params.entryId} disappeared during update.`);
    }
    return updated;
  }

  async deleteProgress(
    params: WorkspaceScope & { entryId: string; actor: OpsPanelActor },
  ): Promise<{ id: string }> {
    this.assertMasterActor(params.actor, "delete progress");
    await this.ensureWorkspacePanel(params);
    const key = this.workspaceKey(params);
    const entry = await this.options.repo.getProgressEntry({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      entryId: params.entryId,
    });
    if (entry === null) {
      throw new Error(`Progress entry ${params.entryId} not found (or already deleted).`);
    }
    // 系统锚不可删（spec §3）：锚是幂等播种的（没有 system 行就自动补种），允许删
    // 会出现"删了又复活"的破坏语义；master 可编辑锚。
    if (entry.createdBy === "system") {
      throw new Error(
        `Progress entry ${params.entryId} is the system anchor ("项目初始化") and cannot be deleted.`,
      );
    }
    this.options.repo.softDeleteProgressEntry(key, params.entryId);
    this.options.notify?.panelChanged({ workspacePath: params.workspacePath });
    return { id: params.entryId };
  }

  /** 进度读取面：user（UI 进度 tab）与 master 可读，worker 拒绝。 */
  private assertProgressReader(actor: OpsPanelActor): void {
    if (isWorkerActor(actor)) {
      throw new Error("Workers cannot read the progress ledger (master's project narrative only).");
    }
  }

  /**
   * 系统锚幂等播种（每个 workspace 首次触达进度时）：repo 事务内检查防并发重播种；
   * createdAt 尽量取项目真实创建时间（progressProjectMeta 端口），缺席/解析失败
   * 回退首触时间——锚保证存在，起点时间可能略漂移但不阻塞功能。
   */
  private async ensureProgressAnchor(scope: WorkspaceScope): Promise<void> {
    const key = this.workspaceKey(scope);
    if (this.progressAnchorSeeded.has(key)) return;
    const anchor = await this.options.repo.ensureProgressAnchor({
      workspacePath: scope.workspacePath,
      workspaceIdentity: scope.workspaceIdentity,
      title: PROGRESS_ANCHOR_TITLE,
      body: PROGRESS_ANCHOR_BODY,
      createdAtMs: await this.resolveProjectCreatedAtMs(scope),
    });
    this.progressAnchorSeeded.add(key);
    if (anchor !== null) {
      this.log(`progress anchor seeded for ${key}`);
    }
  }

  private async resolveProjectCreatedAtMs(scope: WorkspaceScope): Promise<number> {
    if (this.options.progressProjectMeta !== undefined) {
      try {
        const createdAtMs = await this.options.progressProjectMeta.resolveProjectCreatedAtMs({
          workspacePath: scope.workspacePath,
        });
        if (createdAtMs !== null) return createdAtMs;
      } catch (error) {
        this.log(
          `resolveProjectCreatedAtMs failed for ${scope.workspacePath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return Date.now();
  }
}
