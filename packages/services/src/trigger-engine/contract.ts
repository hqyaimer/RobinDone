import { ServiceChannels } from "@robinrun/shared";
import { createServiceDescriptor } from "#src/descriptors.js";
import type { PythonPackageInstallResult } from "./python-runtime-contract.js";
import type {
  TriggerEntry,
  TriggerGroupEntry,
  TriggerProfileEntry,
  TriggerRouting,
  TriggerStatus,
} from "@robinrun/shared";

/**
 * RobinRun 触发器引擎（2026-11-19 设计定稿，docs/trigger-system.md）。
 *
 * 引擎是 desktop host utility 进程里的常驻服务：轮询监听各项目 `.robinrun/triggers/`
 * 注册表，调度 cron/interval，执行脚本（出口契约 + 熔断），接收本地 webhook，把事件按
 * 会话 key（`trigger:<id>` / `trigger-group:<gid>`）聚合后经 dispatch 端口投递给订阅
 * 智能体的会话。引擎常驻、LLM 不常驻。
 *
 * 引擎对注册表的写仅限运行时状态（lastFireAt/lastResult/consecutiveFailures/status 熔断），
 * 结构变更（增删改触发器/组/档案）仍归 ManageTriggers 工具；引擎轮询拾取外部变更。
 */

/** 单条触发器事件（合并投递前的最小单元）。 */
export interface TriggerEvent {
  kind: "schedule" | "webhook" | "script-result" | "script-error";
  /**
   * 事件稳定 id（2026-11-25 分发器裁决：`evt-*`，聚合器 enqueue 时兜底生成）——分发器
   * 的 RouteEvents 标记按 id 引用事件，事件内容不经分发器的手转述。生产方可不填。
   */
  id?: string;
  /** 事件时间（ISO）。 */
  at: string;
  /** schedule/webhook：触发元信息；script-*：执行产物或错误摘要。 */
  summary: string;
  /** 结构化载荷（脚本 stdout data / webhook body / cron 元数据）。 */
  data?: unknown;
  /** script-error：stderr 摘要与诊断信息（进会话供修复）。 */
  error?: string;
  /**
   * script-error：连续异常计数（预留字段，当前无生产方填充）——熔断计数实际由
   * supervisor 的 registerCrash 记入注册表（consecutiveFailures 列），不经事件载荷携带。
   */
  consecutiveFailures?: number;
}

/** 一次合并投递（同一会话 key 的若干事件合并为一条输入）。 */
export interface TriggerEventBatch {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 所属项目 id（host createTask 需要项目归属）。 */
  projectId?: string;
  /** 会话 key：`trigger:<id>` 或 `trigger-group:<gid>`（shared parseTriggerSessionKey）。 */
  sessionKey: string;
  /** 主触发器（组投递时为命中组内任一触发器，用于溯源与创建 origin）。 */
  triggerId: string;
  triggerName: string;
  /** 订阅者（创建者）身份：master 或 wkr-id，决定投给哪个智能体的会话。 */
  subscriberAgentId: string;
  /** 该会话 key 已绑定的 taskId（host 对其 resume + sendPrompt；缺失则 createTask 新建）。 */
  existingTaskId?: string;
  /**
   * 有效路由策略（2026-11-25 分发器裁决，shared resolveRoutingForSessionKey）：
   * direct = 绑定会话就地处理（旧行为）；fixed = 每批次直投创建者新会话（host 跳过
   * 绑定解析，零 LLM）；dispatcher = 投进分发器会话做话题聚类（host 按分发器变体渲染
   * 正文，模型以 RouteEvents 标记路由）。host 按本字段分流投递行为。
   */
  routing: TriggerRouting;
  /**
   * 投递正文覆盖（2026-11-24 系统订阅唤醒）：面板事件的正文由面板服务按条目渲染好，
   * 经引擎绑定解析后原样带给 host；在场时 dispatchTriggerRun 不做事件聚合渲染
   * （events 为空数组）。普通触发器投递不携带。
   */
  promptOverride?: string;
  /**
   * 上一轮路由结果附录（2026-11-25 分发器裁决的 taskId 回显闭环）：dispatcher 档专属——
   * RouteMarkQueue 兑现完成后记录的 `evt-* → 会话` 映射摘要，host 渲染分发器正文时附在
   * 尾部。分发器据此获得新建/续用处理会话的真实 id（否则它拿不到 taskId，无法构造
   * existing 续用标记，只能永远保守新建）。随批次进分发器上下文，即"路由表活在
   * 上下文"设计的增量行。
   */
  routeOutcomeNote?: string;
  events: TriggerEvent[];
}

/**
 * 路由投递批次（2026-11-25 分发器裁决）：处理会话的投递单元——分发器标记兑现
 * （RouteMarkQueue）与 fixed 档直投共用。事件原文由引擎直传（不经分发器转述），
 * host 按 target 完成创建/续用 + 身份校验与降级。
 */
export interface RoutedEventBatch {
  workspacePath: string;
  workspaceIdentity?: string;
  projectId?: string;
  /** 来源会话 key（触发器/组 key；审计与追踪用）。 */
  dispatcherSessionKey: string;
  triggerId: string;
  triggerName: string;
  /** 订阅者（创建者）身份：处理会话的归属（机制层路由边界——host 按此校验 target）。 */
  subscriberAgentId: string;
  target: { kind: "new" } | { kind: "existing"; taskId: string };
  /** 事件原文（带 evt id；host 渲染进处理会话正文）。 */
  events: TriggerEvent[];
  /** 途经分发器会话 taskId（<system-status>.viaDispatcherSessionId 溯源；fixed 直投无）。 */
  dispatcherTaskId?: string;
}

/**
 * 引擎 → host 的会话投递端口（host 装配时注入；克隆 dispatchCronRun 的
 * createTask/resumeTask/sendPrompt 链）。返回 taskId 供引擎持久化会话绑定
 * （`.robinrun/triggers/state/sessions.json`，冷恢复重建路由）。
 */
export interface TriggerDispatchPort {
  dispatchTriggerEvent(batch: TriggerEventBatch): Promise<{ taskId: string }>;
  /**
   * 路由投递（2026-11-25 分发器裁决）：处理会话投递——分发器标记兑现与 fixed 档直投
   * 共用。target=existing 时 host 校验会话存在且归属订阅者（worker 会话 workerId 比对，
   * 同 dispatchTriggerRun 的陈旧绑定校验），不符即降级新建（degraded=true，引擎据此记
   * route.degraded 审计）——降级是"话题静默淘汰"语义的运行时另一半，不是错误。
   */
  dispatchRoutedEvent(batch: RoutedEventBatch): Promise<{ taskId: string; degraded: boolean }>;
}

/** 熔断通知端口（host 装配时注入；应用内通知 + UI 徽章，邮件/待办系统落地后接入）。 */
export interface TriggerNotificationPort {
  notifyCircuitBreak(params: {
    workspacePath: string;
    triggerId: string;
    triggerName: string;
    consecutiveFailures: number;
    lastError?: string;
  }): void;
}

/**
 * 清空会话端口（host 装配时注入；UI"清空会话"用）。清空走 agent 服务的 CLI 往返：
 * 会话与标题保留、消息与 todo 归零，身份按订阅者重置（subscriberAgentId："master"
 * → 清除 worker 身份；wkr-* → 落库该 worker 身份）。会话 id 与触发器绑定不变——
 * 清空是「会话保留、内容归零」，不是删除。
 */
export interface TriggerTaskPort {
  clearTask(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    /** 触发器当前订阅者（注册表 owner/subscriber），身份重置目标。 */
    subscriberAgentId: string;
  }): Promise<void>;
}

/** UI 投影快照（只读；注册表条目 + 引擎运行时状态）。 */
export interface TriggerRuntimeView {
  triggers: TriggerEntry[];
  groups: TriggerGroupEntry[];
  profiles: TriggerProfileEntry[];
  /** 会话 key → 绑定 taskId（触发器文件夹点击切换会话用；无绑定 = 尚未 fire 过）。 */
  sessionBindings: Record<string, string>;
  /** 本地 webhook 基址（loopback，端口应用启动期分配）；未启停用 webhook 时为 undefined。 */
  webhookBaseUrl?: string;
}

// ---------------------------------------------------------------------------
// python 主运行时（2026-11-22 改造；实现收敛在 python-runtime.ts，引擎只依赖本接口）。
// 2026-11-24：契约类型拆到 python-runtime-contract.ts（本文件公开方法数上限 12，
// 系统订阅唤醒方法入列后本节挪家），此处原样再导出，消费面不变。
// ---------------------------------------------------------------------------

export type {
  PythonPackageInstallResult,
  PythonRuntimeResolution,
  TriggerPythonRuntimePort,
} from "./python-runtime-contract.js";

export interface ITriggerEngineService {
  /** 读取一个项目工作区的触发器投影（UI 触发器文件夹/详情数据源）。 */
  getSnapshot(params: { workspacePath: string }): Promise<TriggerRuntimeView>;
  /**
   * UI 启停（与 ManageTriggers set_status 同一状态机；写注册表，引擎下一次轮询拾取）。
   * active 清零连续异常计数；error-paused 只能转 active（重新启用）或 deactivated；
   * completed 转 active = 重新拉起常驻脚本（一次性脚本的重跑入口）。completed 本身
   * 是引擎写入的终态，不开放给 UI 直接设置。
   */
  setTriggerStatus(params: {
    workspacePath: string;
    triggerId: string;
    status: Exclude<TriggerStatus, "completed">;
  }): Promise<TriggerEntry>;
  /**
   * UI 伪删除（2026-11-21 实测裁决，与会话/智能体的伪删除一致）：注册表条目保留
   * （deleted=true、status 停用、组订阅解除）但对所有消费面不可见——引擎不调度/不托管/
   * 不投递/不路由 webhook，快照排除（UI 不渲染）。不可逆；常驻脚本随下一次 pollTick
   * reconcile 停止（≤5s）。幂等：重复删除按首次结果收口。
   */
  deleteTrigger(params: { workspacePath: string; triggerId: string }): Promise<TriggerEntry>;
  /**
   * UI"清空会话"（2026-11-20）：清空该会话 key 绑定会话的全部消息并按当前订阅者
   * 重置身份；会话 id、标题与绑定都保留，下次 fire 在同一会话继续（以重置后的身份
   * 装配）。这是身份纠偏的正道——只清消息不改持久化身份，历史会话仍按旧身份装配。
   * 无绑定时返回 {reset:false}（幂等）。
   */
  resetTriggerSession(params: {
    workspacePath: string;
    sessionKey: string;
  }): Promise<{ reset: boolean; taskId?: string }>;
  /**
   * python 三方包安装（2026-11-22，ManageTriggers install_packages 经反向请求抵达；
   * 唯一的三方包入口，引擎不做任何隐式安装）。含完整 ensure 链（解释器 → venv →
   * pip）；成功后请求重启本项目活跃 python 脚本使新包生效（重启在结果里回显）。
   */
  installPackages(params: {
    workspacePath: string;
    packages: string[];
  }): Promise<PythonPackageInstallResult>;
  /**
   * 有头登录会话（2026-11-25 登录闭环，specs/trigger-browser-hosting.md §3.4；
   * ManageTriggers open_login 经反向请求抵达）：为声明 profile 的脚本触发器拉起有头
   * 登录窗口——注入现有档案登录态，用户登录完成关闭窗口即视为登录完成（引擎落档），
   * 结果返回后 agent 用 set_status 重新启用触发器。要求：条目存在、script 型、profile
   * 在场、引擎托管浏览器端口在场；任一不满足即结构化失败（含原因与指引）。
   */
  openTriggerLogin(params: {
    workspacePath: string;
    triggerId: string;
    /** 登录会话落点（http/https URL）；缺省落空白新标签页由用户自行导航。 */
    url?: string;
  }): Promise<{ ok: boolean; profile?: string; error?: string; guidance?: string[] }>;
  /**
   * 幂等播种系统特权订阅（2026-11-24 需求/审批/反馈面板引入的平台能力）：把
   * `system` 型条目写进注册表（缺失/被删/被破坏时重建，已存在且完好时原样返回），
   * 并写 `<id>/README.md` 说明。系统订阅不可被任何智能体或用户停用/删除/修改
   * （引擎与 ManageTriggers 双层拒绝）；事件不经调度器，由播种方服务直接驱动投递。
   * 幂等安全：可重复调用，无副作用时不动注册表。
   */
  ensureSystemSubscription(params: {
    workspacePath: string;
    subscription: {
      id: string;
      name: string;
      /** 订阅的事件名（播种方定义语义；触发器系统不解释）。 */
      events: string[];
      /** 每事件唤醒豁免规则（2026-11-24 通用机制；随配置播种，幂等比对含本字段）。 */
      wakeRules?: Record<string, { exemptRecordedBy: string[] }>;
      /** 订阅说明（写 `<id>/README.md`，触发器文件夹详情可读）。 */
      readme: string;
    };
  }): Promise<TriggerEntry>;
  /**
   * 系统订阅唤醒投递（2026-11-24 用户裁决：面板 = 数据面，主智能体 = 处理方，订阅是
   * 两者唯一通道）：面板服务的串行唤醒经此进入标准触发器会话模型——`trigger:<id>`
   * 一 key 一绑定会话（绑定解析/写回/sessions.json 持久化与聚合器投递链同一套），
   * 但不经聚合器（无去抖合并；串行与不合并由面板服务的唤醒队列保证）。prompt 是
   * 面板服务按条目渲染好的投递正文（promptOverride 直通 host）。要求订阅已在注册表
   * （播种方先 ensureSystemSubscription）；缺失即拒绝，不凭空造会话。
   */
  dispatchSystemSubscriptionWakeup(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    triggerId: string;
    prompt: string;
  }): Promise<{ taskId: string }>;
  /**
   * 分发器路由标记登记（2026-11-25 分发器裁决）：ManageTriggers 会话的 RouteEvents
   * 工具经反向请求抵达。引擎按 sessionId 反查分发器会话 key（sessionBindings 反向
   * 索引），校验该会话确为 dispatcher 档的绑定分发器（机制层路由边界——非分发器会话
   * 调用一律拒绝），登记标记进 RouteMarkQueue（分发器轮次结束后统一兑现拆批投递）。
   * 事件按 id 从分发器事件池取（池 = 聚合器 dispatcher 档投递成功后暂存的本批事件）；
   * 池中不存在的事件记入 unknownEventIds 原样返回（可能已按漏标降级直投）。
   */
  routeEvents(params: {
    workspacePath: string;
    /** 发起方分发器会话 id（协议反向请求的会话锚点）。 */
    sessionId: string;
    routes: Array<{
      eventIds: string[];
      target: { kind: "new" } | { kind: "existing"; taskId: string };
    }>;
  }): Promise<{
    ok: boolean;
    acceptedEventIds: string[];
    unknownEventIds: string[];
    error?: string;
  }>;
}

export const ITriggerEngineService = createServiceDescriptor<ITriggerEngineService>(
  ServiceChannels.TriggerEngine,
);
