/* python 主运行时端口契约（2026-11-22 改造；实现收敛在 python-runtime.ts）。从
   contract.ts 拆出（2026-11-24：契约文件公开方法数上限 12，面板系统订阅唤醒
   dispatchSystemSubscriptionWakeup 入列后把本节挪家——类型经 contract.ts 原样
   再导出，消费面不变）。 */
import type { PythonRuntimeSource } from "@robinrun/shared";

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
  ensureInterpreter(
    workspacePath: string,
  ): Promise<
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
