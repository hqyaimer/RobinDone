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
}
