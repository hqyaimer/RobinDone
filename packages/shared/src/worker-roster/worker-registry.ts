import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";
import type { AgentProfile } from "../subagent-profile.js";

/**
 * RobinDone worker 编制注册表（`.robindone/agents/workers.json`）的协议层定义。
 *
 * 裁决（2026-11-15，worker 编制系统里程碑）：
 * - 常驻智能体统一叫 worker，一次性派生叫 subagent（沿用上游语义）。
 * - worker 以 id 为路径锚点（`.robindone/agents/<id>/`），name 仅作派发显示名，改名不影响路径。
 * - workers.json 是编制唯一事实源，由程序（ManageWorkers 工具）写入；模型不经 Write/Edit 直接改它。
 * - 规则文件双文件（裁决 10，2026-11-20）：`<id>/define.md`（职责定义，master 预创建并独占
 *   维护，worker 提示词约束不得修改）+ `<id>/agents.md`（worker 自维护，回小写）；均为纯
 *   prompt 正文，无 frontmatter；元数据只存本注册表，零重复。
 * - 旧的平铺 `<name>.md` project scope 格式自本里程碑起不再被加载（user scope 不受影响）。
 */

export const WORKER_REGISTRY_VERSION = 1 as const;

/** id 既是文件夹名也是稳定锚点：小写字母/数字/连字符，`wkr-` 前缀由生成方保证，避免与保留名冲突。 */
const workerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Worker id must be a lowercase slug");

export const workerStatusSchema = z.enum(["active", "deactivated"]);
export type WorkerStatus = z.infer<typeof workerStatusSchema>;

export const workerEntrySchema = z
  .object({
    id: workerIdSchema,
    /**
     * 显示名（侧栏/名册括注），项目内**允许重名但不推荐**（2026-11-17 key/name 裁决）。
     * 派发句柄是 id（Agent 工具 subagent_type），name 不再承担唯一性与路由职责。
     */
    name: z.string().min(1).max(64),
    /** 名册注入与主智能体路由决策的依据（何时派发给这个 worker）。 */
    description: z.string().min(1),
    tools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    modelSelection: modelSelectionSchema.optional(),
    status: workerStatusSchema,
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type WorkerEntry = z.infer<typeof workerEntrySchema>;

export const workerRegistrySchema = z
  .object({
    version: z.literal(WORKER_REGISTRY_VERSION),
    workers: z.array(workerEntrySchema).refine(
      (workers) => {
        // key/name 裁决（2026-11-17）：id 是唯一 key（路径锚点 + 派发句柄），name 只是
        // 显示名——重名允许（不推荐），不再做名字唯一性约束。
        const ids = workers.map((worker) => worker.id);
        return new Set(ids).size === ids.length;
      },
      { message: "Worker ids must be unique" },
    ),
  })
  .strict();
export type WorkerRegistry = z.infer<typeof workerRegistrySchema>;

export const workerRegistryFileName = "workers.json" as const;
/**
 * worker 职责定义文件（裁决 10，2026-11-20）：master 经 ManageWorkers 预创建并独占维护；
 * worker 仅受提示词约束不得修改（不做机制层 Write 限制——命令行总能绕过，无意义）。
 */
export const workerDefineMdFileName = "define.md" as const;
/**
 * worker 自维护文件（裁决 10 回小写，与 plan/knowledge/tmp 目录风格一致）：存放 worker
 * 自得的成果、说明、规则、知识库与文件索引，不含职责定义。裁决 9 的大写统一随裁决 10
 * 在 agent 侧回退；开发期项目删除重建，不做旧名迁移。
 */
export const workerAgentsMdFileName = "agents.md" as const;

/** worker 子目录约定：plan=计划与进度（一计划一文件），knowledge=知识库与经验，tmp=临时文件。 */
export const workerDirectoryConvention = {
  plan: "plan",
  knowledge: "knowledge",
  tmp: "tmp",
} as const;

export interface WorkerProfileBuildInput {
  entry: WorkerEntry;
  /** `<id>/define.md` 的完整内容（职责定义，master 维护）；undefined 表示文件缺失（调用方决定是否降级）。 */
  defineMd?: string;
  /** `<id>/agents.md` 的完整内容（worker 自维护）；undefined 表示文件缺失（调用方决定是否降级）。 */
  agentsMd?: string;
  /** `<workspace>/.robindone/agents/<id>/define.md` 绝对路径（职责定义是 worker 的锚点文件），用于 UI 定位与诊断。 */
  defineMdPath: string;
}

/** 注册表条目 + 双规则文件内容 → 运行时 AgentProfile；派发、名册注入下游全部复用既有 profile 机制。 */
export function buildWorkerProfile(input: WorkerProfileBuildInput): AgentProfile {
  const { entry, defineMd, agentsMd, defineMdPath } = input;
  return {
    // key/name 裁决（2026-11-17）：profile 管线（去重/名册 delta/派发解析）全程以 name 为键，
    // worker 的派发句柄是 id，因此 name 位放 id；显示名在 worker.workerName，名册注入时括注。
    name: entry.id,
    description: entry.description,
    // worker 双规则文件（裁决 10）：agents.md（自维护段）作 systemPrompt 主正文；define.md
    // （职责定义）随 worker 身份透传，由 core 的 worker-prompt.ts 按固定顺序拼接。
    // 工作区 AGENTS.md 的项目约定仍然注入（四段拼接的末段）。
    injectAgentsMd: true,
    ...(entry.tools ? { tools: entry.tools } : {}),
    ...(entry.disallowedTools ? { disallowedTools: entry.disallowedTools } : {}),
    ...(entry.modelSelection ? { modelSelection: entry.modelSelection } : {}),
    source: "project",
    systemPrompt: agentsMd ?? "",
    path: defineMdPath,
    // worker 会话通道隔离（2026-11-16 裁决）：派发链读到该标记即走 worker_child 通道
    // （异步派发、侧栏投影带 worker 身份），与一次性 subagent 的 subagent_child 互不沾染。
    worker: {
      workerId: entry.id,
      workerName: entry.name,
      ...(defineMd ? { defineMd } : {}),
    },
  };
}
