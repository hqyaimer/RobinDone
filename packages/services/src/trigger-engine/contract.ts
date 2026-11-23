import { ServiceChannels } from "@robinrun/shared";
import { createServiceDescriptor } from "#src/descriptors.js";
import type {
  PythonRuntimeSource,
  TriggerEntry,
  TriggerGroupEntry,
  TriggerProfileEntry,
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
  events: TriggerEvent[];
}

/**
 * 引擎 → host 的会话投递端口（host 装配时注入；克隆 dispatchCronRun 的
 * createTask/resumeTask/sendPrompt 链）。返回 taskId 供引擎持久化会话绑定
 * （`.robinrun/triggers/state/sessions.json`，冷恢复重建路由）。
 */
export interface TriggerDispatchPort {
  dispatchTriggerEvent(batch: TriggerEventBatch): Promise<{ taskId: string }>;
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
// python 主运行时（2026-11-22 改造；实现收敛在 python-runtime.ts，引擎只依赖本接口）
// ---------------------------------------------------------------------------

/** python 供给解析结果：ok 分支带生效解释器（venv 就绪后的解释器绝对路径）。 */
export type PythonRuntimeResolution =
  | { ok: true; interpreterPath: string; venvDir: string; replayFailures: string[] }
  | { ok: false; error: string };

/** install_packages 结果（结构化：成功摘要 / 失败 stderr 尾部诊断）。 */
export interface PythonPackageInstallResult {
  ok: boolean;
  /** 成功时回显已安装的包 spec。 */
  packages?: string[];
  error?: string;
  /** pip 输出尾部（成功摘要/失败诊断，已截取）。 */
  outputTail?: string;
  /** venv 重建重放的失败清单（安装本身成功但历史包缺失时在场）。 */
  replayFailures?: string[];
  /** 成功后为使新包生效而请求重启的活跃 python 脚本触发器 id。 */
  restartedTriggerIds?: string[];
}

/**
 * python 运行时端口（宿主装配注入；缺席 = python 主运行时未接线，引擎退化为旧行为：
 * python 触发器按系统 PATH 探测、install_packages 大声失败）。实现负责：解释器供给
 * （托管下载/系统回退）、可用性状态文件（`state/python-runtime.json`，CLI 门控与提示词
 * 双模式的事实源）、venv 生命周期与 pip 安装。
 */
export interface TriggerPythonRuntimePort {
  /** 解析生效解释器并落可用性状态（挂载 fire-and-forget / spawn 与安装前按需）。 */
  ensureInterpreter(workspacePath: string): Promise<
    | { ok: true; interpreterPath: string; source: PythonRuntimeSource }
    | { ok: false; error: string }
  >;
  /** venv 就绪（含解释器 ensure；指纹失配自动重建 + 台账重放）。 */
  ensureVenv(
    workspacePath: string,
  ): Promise<
    | { ok: true; interpreterPath: string; venvDir: string; replayFailures: string[] }
    | { ok: false; error: string }
  >;
  /** pip 安装（含完整 ensure 链；实现内部按工作区串行）。 */
  installPackages(workspacePath: string, packages: string[]): Promise<PythonPackageInstallResult>;
}

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
}

export const ITriggerEngineService = createServiceDescriptor<ITriggerEngineService>(
  ServiceChannels.TriggerEngine,
);
