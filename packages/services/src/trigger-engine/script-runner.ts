import { spawn } from "node:child_process";
import type { TriggerContract } from "@robinrun/shared";

/**
 * 脚本触发器的纯助手（2026-11-21 常驻模型修订；2026-11-22 python 主运行时改造）。
 *
 * 批处理执行器（runTriggerScript：按周期 spawn、以 stdout 最后一行 JSON + 进程退出为
 * 出口契约）已由 script-supervisor.ts 的常驻进程托管取代——脚本的定时/订阅能力由脚本
 * 自实现，引擎只管生命周期。本模块保留纯助手供 supervisor 复用：
 * - resolveRuntimeCommand：node 用当前进程可执行文件（Electron utility 进程下补
 *   ELECTRON_RUN_AS_NODE=1，与 CLI 运行时同版本，零额外分发）；python 在显式解释器
 *   （venv，经 python-runtime/python-env 供给）缺席时探测系统 PATH 作为旧路径兜底
 *   （python → python3），缺失返回 undefined（supervisor 按崩溃计数走向熔断）。
 * - probeCommand：命令可用性探测（10s 超时 spawn --version）；python-runtime 的
 *   系统回退探测复用。
 * - assertContract：合理性断言（minCount/requiredFields/maxAgeMinutes），常驻模型下
 *   逐事件校验。
 */

function clip(text: string, max = 4000): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…(clipped)`;
}

/** 合理性断言（triggerContractSchema 的结构化部分；数据突变类断言后续扩展）。 */
export function assertContract(
  data: unknown,
  contract: TriggerContract | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (contract === undefined) return { ok: true };
  if (contract.minCount !== undefined) {
    const count = Array.isArray(data) ? data.length : data === undefined || data === null ? 0 : 1;
    if (count < contract.minCount) {
      return {
        ok: false,
        reason: `contract minCount=${contract.minCount} but data has ${count} item(s)`,
      };
    }
  }
  if (contract.requiredFields !== undefined) {
    const records = Array.isArray(data) ? data : [data];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (typeof record !== "object" || record === null) {
        return { ok: false, reason: `contract requiredFields: data[${index}] is not an object` };
      }
      for (const field of contract.requiredFields) {
        if (!(field in record)) {
          return {
            ok: false,
            reason: `contract requiredFields: data[${index}] missing "${field}"`,
          };
        }
      }
    }
  }
  if (contract.maxAgeMinutes !== undefined) {
    const record = Array.isArray(data) ? data[0] : data;
    const timestamp =
      typeof record === "object" && record !== null
        ? ((record as { timestamp?: unknown; fetchedAt?: unknown }).timestamp ??
          (record as { fetchedAt?: unknown }).fetchedAt)
        : undefined;
    const parsed =
      typeof timestamp === "number"
        ? timestamp
        : typeof timestamp === "string"
          ? Date.parse(timestamp)
          : Number.NaN;
    if (Number.isNaN(parsed)) {
      return {
        ok: false,
        reason: `contract maxAgeMinutes: data has no parsable timestamp/fetchedAt field`,
      };
    }
    const ageMinutes = (Date.now() - parsed) / 60_000;
    if (ageMinutes > contract.maxAgeMinutes) {
      return {
        ok: false,
        reason: `contract maxAgeMinutes=${contract.maxAgeMinutes} but data is ~${Math.round(ageMinutes)}min old`,
      };
    }
  }
  return { ok: true };
}

/** 解析脚本执行的运行时命令；python 缺失时返回 undefined（调用方按崩溃计数收口）。 */
export async function resolveRuntimeCommand(
  runtime: "node" | "python",
): Promise<{ command: string; args: string[]; electronAsNode: boolean } | undefined> {
  if (runtime === "node") {
    // Electron utility 进程：process.execPath 是 electron 二进制，补 RUN_AS_NODE 得到纯 Node 语义。
    const electronAsNode = process.versions.electron !== undefined;
    return { command: process.execPath, args: [], electronAsNode };
  }
  for (const candidate of ["python", "python3"] as const) {
    if (await probeCommand(candidate)) {
      return { command: candidate, args: [], electronAsNode: false };
    }
  }
  return undefined;
}

export async function probeCommand(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      cwd: process.cwd(),
      env: { ...process.env },
      windowsHide: true,
      shell: false,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 10_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export { clip as clipScriptOutput };
