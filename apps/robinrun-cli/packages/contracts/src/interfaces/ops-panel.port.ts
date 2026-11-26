import type { TraceContext } from "../tracing/tracer.js";

// ============================================================
// Ops Panel Runtime Port - 需求/审批/反馈面板的 CLI→Host 反向通道
// ============================================================
// 2026-11-24 MVP（RobinRunOps dev/specs 需求说明）：面板服务的唯一智能体入口。
// 面板服务（IOpsPanelService）在桌面宿主 utility 进程，CLI 进程无法直接调用——
// bootstrap 以 CLI→Host 反向请求实现本端口（TriggerRuntimePort/agentContactDispatch
// 同款机制），请求在宿主侧落到面板服务（权限矩阵 + worker 可见性在服务层强制）。
// 独立 CLI（无 Host）缺席：ManageOpsPanel 报错引导，不静默失败。

/** 调用者身份（权限矩阵载体）：由 handler 按会话身份机制层派生，不采信模型传值。 */
export type OpsPanelPortActor =
  | { role: "agent"; agentId: "master" }
  | { role: "agent"; agentId: `worker:${string}` };

export interface OpsPanelPortRequestBase {
  /** 发起方会话 id（协议反向请求的会话锚点，宿主据此解析工作区信封）。 */
  sessionId: string;
  actor: OpsPanelPortActor;
  trace?: TraceContext;
}

export interface OpsPanelListEntriesRequest extends OpsPanelPortRequestBase {}

export interface OpsPanelGetEntryRequest extends OpsPanelPortRequestBase {
  entryId: string;
}

export interface OpsPanelCreateEntryRequest extends OpsPanelPortRequestBase {
  kind: "requirement" | "approval" | "feedback";
  title: string;
  body: string;
  /** 来源标记（2026-11-24 录入与来源拆分）：master 代录反馈时必传 user|master；其余动作服务层派生。 */
  author?: "user" | "master";
}

export interface OpsPanelDecideRequirementRequest extends OpsPanelPortRequestBase {
  entryId: string;
  outcome: "accepted" | "rejected" | "suspended" | "converted_to_approval";
  note?: string;
}

export interface OpsPanelResolveFeedbackRequest extends OpsPanelPortRequestBase {
  entryId: string;
  note?: string;
}

export interface OpsPanelAcknowledgeApprovalRequest extends OpsPanelPortRequestBase {
  entryId: string;
  note?: string;
}

// ---- 进度账本（2026-11-25，specs/progress-ledger.md）：master 独占维护，worker 拒绝 ----

export interface OpsPanelAppendProgressRequest extends OpsPanelPortRequestBase {
  title: string;
  body?: string;
  /** 关联文件路径（≤8 条）：深度进文件，账本一行一里程碑；UI 可点击打开右栏预览。 */
  links?: string[];
}

export interface OpsPanelUpdateProgressRequest extends OpsPanelPortRequestBase {
  entryId: string;
  title?: string;
  body?: string;
  /** 空数组 = 清空链接。 */
  links?: string[];
}

export interface OpsPanelDeleteProgressRequest extends OpsPanelPortRequestBase {
  entryId: string;
}

/** 面板视图（条目 + 待处理唤醒队列）；worker actor 只见自己提交的条目。 */
export interface OpsPanelPortView {
  entries: unknown[];
  queue: { inFlightId: string | null; pendingIds: string[] };
}

export interface OpsPanelPortEntryResult {
  entry: unknown;
}

export interface OpsPanelPortProgressView {
  entries: unknown[];
}

export interface OpsPanelPortProgressEntryResult {
  entry: unknown;
}

export interface OpsPanelPortProgressDeleteResult {
  id: string;
}

export interface OpsPanelRuntimePort {
  listEntries(request: OpsPanelListEntriesRequest): Promise<OpsPanelPortView>;
  getEntry(request: OpsPanelGetEntryRequest): Promise<OpsPanelPortEntryResult>;
  createEntry(request: OpsPanelCreateEntryRequest): Promise<OpsPanelPortEntryResult>;
  decideRequirement(request: OpsPanelDecideRequirementRequest): Promise<OpsPanelPortEntryResult>;
  resolveFeedback(request: OpsPanelResolveFeedbackRequest): Promise<OpsPanelPortEntryResult>;
  acknowledgeApproval(request: OpsPanelAcknowledgeApprovalRequest): Promise<OpsPanelPortEntryResult>;
  getProgressView(request: OpsPanelListEntriesRequest): Promise<OpsPanelPortProgressView>;
  appendProgress(request: OpsPanelAppendProgressRequest): Promise<OpsPanelPortProgressEntryResult>;
  updateProgress(request: OpsPanelUpdateProgressRequest): Promise<OpsPanelPortProgressEntryResult>;
  deleteProgress(request: OpsPanelDeleteProgressRequest): Promise<OpsPanelPortProgressDeleteResult>;
}
