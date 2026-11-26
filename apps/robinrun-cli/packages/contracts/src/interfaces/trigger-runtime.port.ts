import type { TraceContext } from "../tracing/tracer.js";

// ============================================================
// Trigger Runtime Port - python runtime supply for script triggers
// ============================================================
// 2026-11-22 python 主运行时改造（docs/trigger-python-runtime.md §3.3）：python 三方包
// 安装的 CLI→引擎通道。触发器引擎在桌面宿主 utility 进程，CLI 进程无法直接调用——
// bootstrap 以 CLI→Host 反向请求实现本端口（agentContact/dispatch 同款机制），请求
// 在宿主侧落到触发器引擎的 installPackages（解释器/venv ensure + pip + 台账 + 重启
// 活跃 python 脚本）。独立 CLI（无 Host）缺席：ManageTriggers install_packages 报错
// 引导，不静默失败。

export interface TriggerRuntimeInstallRequest {
  workspacePath: string;
  /** 发起方会话 id（协议反向请求的会话锚点，宿主据此解析工作区信封）。 */
  sessionId: string;
  /** pip 包 spec（如 `requests` / `playwright==1.49.0`）；schema 已限非空、单条 ≤256。 */
  packages: string[];
  trace?: TraceContext;
}

export interface TriggerRuntimeInstallResult {
  ok: boolean;
  /** 成功时回显已安装的包 spec。 */
  packages?: string[];
  error?: string;
  /** pip 输出尾部（成功摘要/失败诊断）。 */
  outputTail?: string;
  /** venv 重建重放的失败清单（安装成功但历史包缺失时在场）。 */
  replayFailures?: string[];
  /** 成功后为使新包生效而重启的活跃 python 脚本触发器 id。 */
  restartedTriggerIds?: string[];
}

export interface TriggerRuntimePort {
  installPackages(request: TriggerRuntimeInstallRequest): Promise<TriggerRuntimeInstallResult>;
  /**
   * 分发器路由标记登记（2026-11-25 分发器裁决，specs/trigger-dispatcher-routing.md §6.2）：
   * 分发器会话的 RouteEvents 工具经此把引用式标记交给引擎 RouteMarkQueue——引擎按
   * sessionId 反查分发器会话 key、按注册表 routing 门控（机制层路由边界），分发器轮次
   * 结束（空闲）后统一兑现拆批投递。unknown 事件（池中不存在：已按漏标降级或非本分发器
   * 批次）原样回显，不阻塞已接受标记。
   */
  routeEvents(request: TriggerRuntimeRouteEventsRequest): Promise<TriggerRuntimeRouteEventsResult>;
  /**
   * 有头登录会话（2026-11-25 登录闭环，specs/trigger-browser-hosting.md §3.4）：
   * ManageTriggers open_login 经此反向请求抵达引擎 openTriggerLogin——引擎拉起有头登录
   * 窗口（注入档案登录态），用户登录完成关闭窗口即落档；agent 随后 set_status 重新启用。
   */
  openLogin(request: TriggerRuntimeOpenLoginRequest): Promise<TriggerRuntimeOpenLoginResult>;
}

export interface TriggerRuntimeOpenLoginRequest {
  workspacePath: string;
  /** 发起方会话 id（协议反向请求的会话锚点，宿主据此解析工作区信封）。 */
  sessionId: string;
  triggerId: string;
  /** 登录会话落点（http/https URL）；缺省落空白新标签页由用户自行导航。 */
  url?: string;
  trace?: TraceContext;
}

export interface TriggerRuntimeOpenLoginResult {
  ok: boolean;
  profile?: string;
  error?: string;
  guidance?: string[];
}

export interface TriggerRuntimeRouteEventsRequest {
  workspacePath: string;
  /** 发起方分发器会话 id（协议反向请求的会话锚点 + 引擎绑定表反查 key）。 */
  sessionId: string;
  routes: Array<{
    eventIds: string[];
    target: { kind: "new" } | { kind: "existing"; taskId: string };
  }>;
  trace?: TraceContext;
}

export interface TriggerRuntimeRouteEventsResult {
  ok: boolean;
  acceptedEventIds: string[];
  unknownEventIds: string[];
  error?: string;
}
