import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  triggerAuditFileName,
  triggerDirectoryConvention,
  triggerRegistryFileName,
  triggerRegistrySchema,
  TRIGGER_REGISTRY_VERSION,
  type TriggerRegistry,
} from "@robinrun/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

/**
 * 触发器注册表 IO（2026-11-21 从 engine.ts 抽出，文件行数上限拆分）：读盘-改-原子写、
 * 会话绑定持久化与审计追加。fail-safe 纪律与 worker-roster 同款——损坏保留旧缓存、
 * 拒绝写覆盖（见 engine.ts 头注）。
 */

/** 引擎工作区状态里注册表 IO 依赖的最小投影（engine.WorkspaceState 结构兼容）。 */
export interface RegistryWritableState {
  workspacePath: string;
  /** 最近一次读到的注册表原文（变更检测 + 损坏恢复基线）。 */
  raw: string;
  registry: TriggerRegistry | null;
  corrupt: boolean;
  /** 会话 key → 绑定 taskId（`.robinrun/triggers/state/sessions.json`）。 */
  sessionBindings: Record<string, string>;
  /** 注册表写串行链（poll 写与 UI set_status 写互不交叠）。 */
  writeChain: Promise<void>;
}

export const emptyRegistry = (): TriggerRegistry => ({
  version: TRIGGER_REGISTRY_VERSION,
  triggers: [],
  groups: [],
  profiles: [],
});

export async function readRawRegistry(workspacePath: string): Promise<string> {
  try {
    return await readFile(join(triggersRoot(workspacePath), triggerRegistryFileName), "utf8");
  } catch {
    // 缺失/不可读 = 空注册表（首个 create 前的合法状态）。
    return "";
  }
}

export function parseRegistry(raw: string): TriggerRegistry | null {
  if (raw.trim().length === 0) return emptyRegistry();
  try {
    const parsed = triggerRegistrySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function loadSessionBindings(workspacePath: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(triggersRoot(workspacePath), "state", "sessions.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const bindings = (parsed as { bindings?: unknown }).bindings;
      if (typeof bindings === "object" && bindings !== null) {
        return { ...(bindings as Record<string, string>) };
      }
    }
  } catch {
    // 无状态文件 = 无绑定（全部首次投递）。
  }
  return {};
}

export async function saveSessionBindings(state: RegistryWritableState): Promise<void> {
  const target = join(triggersRoot(state.workspacePath), "state", "sessions.json");
  await mkdir(dirname(target), { recursive: true });
  const payload = `${JSON.stringify({ version: 1, bindings: state.sessionBindings }, null, 2)}\n`;
  const temp = `${target}.tmp.${process.pid}`;
  await writeFile(temp, payload, "utf8");
  await rename(temp, target);
}

/** 读盘-改-原子写：mutator 抛错则不落盘。写前整表校验（交叉不变量兜底）。 */
export async function mutateRegistry(
  state: RegistryWritableState,
  mutator: (registry: TriggerRegistry) => void | Promise<void>,
): Promise<TriggerRegistry | null> {
  const run = async (): Promise<TriggerRegistry | null> => {
    if (state.corrupt) {
      serviceLog.info(`registry for ${state.workspacePath} is corrupt; skipping engine write`);
      return null;
    }
    const raw = await readRawRegistry(state.workspacePath);
    const registry = parseRegistry(raw);
    if (registry === null) {
      state.corrupt = true;
      serviceLog.info(
        `registry for ${state.workspacePath} failed to parse; refusing engine writes`,
      );
      return null;
    }
    await mutator(registry);
    const validated = triggerRegistrySchema.safeParse(registry);
    if (!validated.success) {
      serviceLog.info(
        `mutated registry invalid for ${state.workspacePath}: ${validated.error.message}`,
      );
      return null;
    }
    const target = join(triggersRoot(state.workspacePath), triggerRegistryFileName);
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.tmp.${process.pid}`;
    await writeFile(temp, `${JSON.stringify(validated.data, null, 2)}\n`, "utf8");
    await rename(temp, target);
    state.raw = JSON.stringify(validated.data);
    state.registry = validated.data;
    return validated.data;
  };
  const next = state.writeChain.then(run, run);
  state.writeChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export async function appendAudit(
  workspacePath: string,
  triggerId: string,
  record: Record<string, unknown>,
): Promise<void> {
  try {
    const target = join(
      triggersRoot(workspacePath),
      triggerId,
      triggerDirectoryConvention.log,
      triggerAuditFileName,
    );
    await mkdir(dirname(target), { recursive: true });
    await appendFile(
      target,
      `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
      "utf8",
    );
  } catch (error) {
    serviceLog.info(
      `audit append failed for ${triggerId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const serviceLog = createServiceLogger("trigger-engine");

function triggersRoot(workspacePath: string): string {
  return join(workspacePath, ".robinrun", "triggers");
}
