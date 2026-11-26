import {
  ServiceChannels,
  type OpsEntryKind,
  type OpsPanelActor,
  type OpsPanelEntry,
  type OpsPanelView,
  type OpsPanelWakeupRequest,
  type ProgressEntry,
  type ProgressView,
} from "@robinrun/shared";
import { createServiceDescriptor } from "#src/descriptors.js";

/**
 * 需求/审批/反馈面板服务（2026-11-24 MVP，RobinRunOps dev/specs 对应需求说明）。
 *
 * 三类管理原语的状态机 + 串行唤醒队列的 host 常驻服务：条目与队列状态落
 * tasks-index.sqlite（重启不丢）；唤醒经 OpsPanelDispatchPort 投到 master 主会话
 * （用户可旁观/可插话，不落隐藏触发器会话）。权限矩阵（需求 §4）在服务层强制：
 * user=UI 面（提需求/提反馈/批审批/读全部），master=工具面（起草审批/提反馈/处置/
 * 分诊/确认执行），worker=工具面（仅提反馈 + 只读自己提交的条目——数据/接口层过滤）。
 */

/** master 执行确认后的 APP 决定值（复用批准/驳回词表，执行确认不改用户可见状态）。 */
export type OpsApprovalDecision = "approved" | "rejected";

/** REQ 处置结果四选一（需求 §2）。 */
export type OpsRequirementOutcome = "accepted" | "rejected" | "suspended" | "converted_to_approval";

/** 一次串行唤醒投递的载荷（协议类型在 shared ops-panel 定义；此处 re-export 供装配面使用）。 */
export type { OpsPanelWakeupRequest } from "@robinrun/shared";

/** 服务 → host 的唤醒投递端口（host 装配注入：解析 master 主会话 + sendPrompt）。 */
export interface OpsPanelDispatchPort {
  dispatchOpsPanelWakeup(request: OpsPanelWakeupRequest): Promise<{ taskId: string }>;
}

/** 面板变更广播端口（host 装配注入：UI 订阅 state:ops-panel 即时刷新；缺席可省）。 */
export interface OpsPanelNotificationPort {
  panelChanged(params: { workspacePath: string }): void;
}

/** 系统订阅播种端口（host 装配注入：触发器引擎 ensureSystemSubscription 的窄投影）。 */
export interface OpsPanelSystemSubscriptionPort {
  ensureSystemSubscription(params: {
    workspacePath: string;
    subscription: {
      id: string;
      name: string;
      events: string[];
      /** 每事件唤醒豁免规则（2026-11-24 通用机制：随订阅配置播种，逻辑读配置不写死）。 */
      wakeRules?: Record<string, { exemptRecordedBy: string[] }>;
      readme: string;
    };
  }): Promise<unknown>;
}

/**
 * 项目元数据端口（host 装配注入）：进度锚条目的 createdAt 取项目真实创建时间——
 * 账本时间线的诚实起点，不随首触时间漂移（specs/progress-ledger.md §3）。解析不了
 * （workspacePath 不是已注册项目根/项目服务缺席）返回 null，服务层回退首触时间。
 */
export interface OpsPanelProjectMetaPort {
  resolveProjectCreatedAtMs(params: { workspacePath: string }): Promise<number | null>;
}

/** master 代录需求/反馈时的来源标记（2026-11-24 录入与来源拆分）：author=来源、recordedBy=master。 */
export type OpsEntryAuthorOverride = "user" | "master";

export interface IOpsPanelService {
  /** 面板整体视图（条目 + 待处理队列）；worker actor 只见自己提交的条目。 */
  getPanelView(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    actor: OpsPanelActor;
  }): Promise<OpsPanelView>;
  /**
   * 创建条目（权限矩阵收口，2026-11-24 用户裁决"对话代录"）：requirement 仅 agent
   * master（author 固定 user——用户对话转述，master 落账）；approval 仅 agent master
   * （author=master）；feedback：master 可代录（author=user|master 显式传入）或 worker
   * 自录（author=worker:<id>，机制层派生）；user actor 不再直接创建（UI 表单退役，
   * 用户经对话转述）。recordedBy 机制层派生；master 录入的条目不产生唤醒（录入方在
   * 场——豁免由订阅配置 wakeRules 声明，见服务实现）；APP 创建不入队。
   */
  createEntry(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    kind: OpsEntryKind;
    title: string;
    body: string;
    /** 来源标记：master 代录时必传（requirement 恒 "user"；feedback "user"|"master"）；worker 自录忽略。 */
    author?: OpsEntryAuthorOverride;
    links?: Record<string, string>;
    actor: OpsPanelActor;
  }): Promise<OpsPanelEntry>;
  /** 用户批准/驳回审批（批准/驳回后经串行队列唤醒 master 执行）。 */
  decideApproval(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    entryId: string;
    decision: OpsApprovalDecision;
    note?: string;
    actor: OpsPanelActor;
  }): Promise<OpsPanelEntry>;
  /** master 处置需求（四选一 + 备注；处置即释放队列）。 */
  decideRequirement(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    entryId: string;
    outcome: OpsRequirementOutcome;
    note?: string;
    actor: OpsPanelActor;
  }): Promise<OpsPanelEntry>;
  /** master 分诊反馈（改状态为已处理 + 可选备注；处置即释放队列）。 */
  resolveFeedback(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    entryId: string;
    note?: string;
    actor: OpsPanelActor;
  }): Promise<OpsPanelEntry>;
  /** master 确认审批已执行（队列释放点；不改用户可见状态，置 acknowledgedAt）。 */
  acknowledgeApproval(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    entryId: string;
    note?: string;
    actor: OpsPanelActor;
  }): Promise<OpsPanelEntry>;

  // ---- 进度账本（2026-11-25，specs/progress-ledger.md）：无状态机、无事件面 ----

  /**
   * 进度视图（现存条目时间正序）：user（UI 进度 tab）与 master（list_progress）可读，
   * worker 拒绝（进度是 master 的叙事，worker 不读不写）。首触幂等播种系统锚条目
   * "项目初始化"。
   */
  getProgressView(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    actor: OpsPanelActor;
  }): Promise<ProgressView>;
  /** master 追加进度里程碑（锚条目 ensure 在此链路内幂等播种；user/worker 拒绝）。 */
  appendProgress(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    title: string;
    body?: string;
    /** 关联文件路径（≤8 条）：进度与知识/状态文件的融合点，UI 可点击打开。 */
    links?: string[];
    actor: OpsPanelActor;
  }): Promise<ProgressEntry>;
  /**
   * master 原位修改（只更显式传入字段；body 传空串清空详情、links 传空数组清空链接）。
   * 账本只呈现最终态——无角标、无修订史（specs/progress-ledger.md §3 原位维护制）。
   */
  updateProgress(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    entryId: string;
    title?: string;
    body?: string;
    links?: string[];
    actor: OpsPanelActor;
  }): Promise<ProgressEntry>;
  /** master 删除（软删：读路径过滤，UI 无痕；系统锚不可删——幂等播种会复活）。 */
  deleteProgress(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    entryId: string;
    actor: OpsPanelActor;
  }): Promise<{ id: string }>;
}

export const IOpsPanelService = createServiceDescriptor<IOpsPanelService>(ServiceChannels.OpsPanel);
