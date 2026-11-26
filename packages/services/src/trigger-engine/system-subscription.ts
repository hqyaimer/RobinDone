/* 系统特权订阅播种（2026-11-24 需求/审批/反馈面板引入的平台能力）。从 engine.ts 拆出
   （文件行数上限）：幂等播种 `system` 型条目 + `<id>/README.md` 说明——缺失/被删/被破坏
   时重建，已存在且完好（事件与豁免规则一致）时原样返回。系统订阅不可被任何智能体或
   用户停用/删除/修改（引擎与 ManageTriggers 双层拒绝）；事件不经调度器，由播种方服务
   直接驱动投递（面板唤醒链见 system-wakeup.ts）。 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isSystemTriggerEntry, triggerReadmeFileName, type TriggerEntry } from "@robinrun/shared";
import { appendAudit, mutateRegistry, type RegistryWritableState } from "./registry-io.js";

/** 触发器根目录（engine/registry-io 各留一份私有定义的同款；本地私有避免跨文件引私有物）。 */
function triggersRoot(workspacePath: string): string {
  return join(workspacePath, ".robinrun", "triggers");
}

export interface SystemSubscriptionDeps {
  /** 按需取工作区状态（引擎闭包：workspaces.get ?? ensureWorkspace）。 */
  resolveState(workspacePath: string): Promise<RegistryWritableState>;
  log(message: string): void;
}

export async function ensureSystemSubscriptionEntry(
  deps: SystemSubscriptionDeps,
  params: {
    workspacePath: string;
    subscription: {
      id: string;
      name: string;
      events: string[];
      /** 每事件唤醒豁免规则（2026-11-24 通用机制；随配置播种，幂等比对含本字段）。 */
      wakeRules?: Record<string, { exemptRecordedBy: string[] }>;
      readme: string;
    };
  },
): Promise<TriggerEntry> {
  const state = await deps.resolveState(params.workspacePath);
  let result: TriggerEntry | undefined;
  let seeded = false;
  const wakeRules = params.subscription.wakeRules;
  await mutateRegistry(state, (registry) => {
    const now = new Date().toISOString();
    const existing = registry.triggers.find((candidate) => candidate.id === params.subscription.id);
    const events = [...params.subscription.events];
    const canonical: TriggerEntry = {
      id: params.subscription.id,
      name: params.subscription.name,
      // owner 仅作展示归组（面板订阅归 master 触发器文件夹）；真正的平台保证由
      // system 标记承载（引擎与 ManageTriggers 双层拒改，见 setTriggerStatus/deleteTrigger）。
      ownerAgentId: "master",
      groupId: null,
      // 系统订阅恒 direct（2026-11-25 分发器裁决：面板 = 数据面，主智能体 = 处理方，
      // 不经分发器；幂等比对沿用下方逐字段比对，routing 不参与）。
      routing: "direct",
      config: {
        kind: "system",
        events,
        ...(wakeRules !== undefined ? { wakeRules } : {}),
      },
      status: "active",
      consecutiveFailures: 0,
      system: true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    // 幂等：已存在且完好（未删、system、active、名称/事件与豁免规则一致）时原样返回，
    // 不扰动注册表——规则修订（如 wakeRules 调整、平台侧改名）经不一致比对自动重播种
    // （2026-11-25 订阅名"运营面板订阅"→"运营面板"即靠 name 比对落到存量工作区）。
    const existingConfig =
      existing !== undefined && existing.config.kind === "system" ? existing.config : undefined;
    if (
      existing !== undefined &&
      existing.deleted !== true &&
      isSystemTriggerEntry(existing) &&
      existing.status === "active" &&
      existing.groupId === null &&
      existing.ownerAgentId === canonical.ownerAgentId &&
      existing.name === canonical.name &&
      existingConfig !== undefined &&
      JSON.stringify(existingConfig.events) === JSON.stringify(events) &&
      JSON.stringify(existingConfig.wakeRules) === JSON.stringify(wakeRules)
    ) {
      result = existing;
      return;
    }
    const index = registry.triggers.findIndex(
      (candidate) => candidate.id === params.subscription.id,
    );
    if (index >= 0) {
      registry.triggers[index] = canonical;
    } else {
      registry.triggers.push(canonical);
    }
    result = canonical;
    seeded = true;
  });
  if (result === undefined) {
    throw new Error(
      state.corrupt
        ? "Trigger registry is corrupt; fix it before seeding the system subscription"
        : "Failed to seed the system subscription",
    );
  }
  if (seeded) {
    // 说明文件随播种写/覆盖（平台维护的订阅说明；幂等命中时不重写）。
    const readmePath = join(
      triggersRoot(params.workspacePath),
      params.subscription.id,
      triggerReadmeFileName,
    );
    await mkdir(dirname(readmePath), { recursive: true });
    await writeFile(readmePath, `${params.subscription.readme.trim()}\n`, "utf8");
    void appendAudit(params.workspacePath, params.subscription.id, {
      action: "system_subscription_seeded",
      actor: "platform",
      events: params.subscription.events,
    });
    deps.log(`system subscription ${params.subscription.id} seeded for ${params.workspacePath}`);
  }
  return result;
}
