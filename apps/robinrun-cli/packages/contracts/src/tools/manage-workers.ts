// ============================================================
// ManageWorkers Tool - main-agent-only worker roster management
// ============================================================
// RobinRun worker 编制系统（2026-11-15 裁决）：常驻智能体叫 worker，一次性派生叫 subagent。
// 编制唯一事实源是 `<workspace>/.robinrun/agents/workers.json`，由本工具（程序侧）写入；
// worker 双规则文件（裁决 10，2026-11-20）：`<id>/define.md`（职责定义，master 独占维护，
// worker 提示词约束不得修改）+ `<id>/agents.md`（worker 自维护骨架）。define.md 修改走
// Write/Edit，不经本工具。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const MANAGE_WORKERS_TOOL_NAME = "ManageWorkers";

export const ManageWorkersActionSchema = z.enum(["create", "update", "set_status"]);
export type ManageWorkersAction = z.infer<typeof ManageWorkersActionSchema>;

// 与 @robinrun/shared 的 ModelSelection 结构同步（contracts 不直接组合另一份 zod 实例的
// schema，见 automation.ts 同款裁决）；模型选择只是透传字段。
const workerModelSelectionSchema = z
  .object({
    providerId: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
    options: z
      .object({
        reasoningLevel: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ManageWorkersInputSchema = z
  .object({
    action: ManageWorkersActionSchema.describe(
      "create: register a new worker (requires name, description, prompt). update: change registry metadata (requires id; at least one of name, description, tools, modelSelection). set_status: activate or deactivate a worker (requires id and status; deactivated workers stay on disk and leave the roster).",
    ),
    id: z
      .string()
      .optional()
      .describe(
        "Worker id (wkr-…). Required for update and set_status; returned by create and stable across renames.",
      ),
    name: z
      .string()
      .max(64)
      .optional()
      .describe(
        "Human-readable display name users see in the sidebar and agent pickers (natural words, Chinese welcome, e.g. 开发工程师 / 文档工程师 / Reviewer). Duplicates are allowed but discouraged — dispatch uses the immutable wkr-id, not the name. Required for create; optional for update.",
      ),
    description: z
      .string()
      .min(1)
      .optional()
      .describe(
        "One-line summary of this worker's recurring duty, shown in the agent-type roster to guide dispatch decisions. Required for create; optional for update.",
      ),
    prompt: z
      .string()
      .min(1)
      .optional()
      .describe(
        "create only: the worker's duty statement, written verbatim into its define.md — the file that defines who the worker is. State what the worker IS responsible for, what it is NOT responsible for (neighboring duties it must leave alone; describe duties, never name other workers), and that anything outside its duties goes back to the master agent. Later duty edits go through Write/Edit on define.md (you maintain it; the worker must not modify it), not this tool.",
      ),
    tools: z
      .array(z.string())
      .optional()
      .describe('Tool names this worker may use, or ["*"] for all. Omit to inherit all tools.'),
    modelSelection: workerModelSelectionSchema
      .optional()
      .describe("Optional model override for this worker's dispatches."),
    status: z
      .enum(["active", "deactivated"])
      .optional()
      .describe("Required for set_status. Deactivation keeps the worker's files and history."),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.action === "create") {
      if (input.id !== undefined)
        ctx.addIssue({
          code: "custom",
          message: "create generates the id; do not pass one",
          path: ["id"],
        });
      if (!input.name)
        ctx.addIssue({ code: "custom", message: "create requires name", path: ["name"] });
      if (!input.description)
        ctx.addIssue({
          code: "custom",
          message: "create requires description",
          path: ["description"],
        });
      if (!input.prompt)
        ctx.addIssue({ code: "custom", message: "create requires prompt", path: ["prompt"] });
      if (input.status !== undefined)
        ctx.addIssue({
          code: "custom",
          message: "new workers are always active; use set_status later",
          path: ["status"],
        });
      return;
    }
    if (input.id === undefined || input.id.trim().length === 0) {
      ctx.addIssue({
        code: "custom",
        message: `${input.action} requires the worker id`,
        path: ["id"],
      });
    }
    if (input.action === "update") {
      if (input.prompt !== undefined)
        ctx.addIssue({
          code: "custom",
          message:
            "Duty definitions live in the worker's define.md; edit that file with Write/Edit instead of update",
          path: ["prompt"],
        });
      if (input.status !== undefined)
        ctx.addIssue({
          code: "custom",
          message: "use the set_status action to change status",
          path: ["status"],
        });
      if (
        input.name === undefined &&
        input.description === undefined &&
        input.tools === undefined &&
        input.modelSelection === undefined
      )
        ctx.addIssue({
          code: "custom",
          message: "update requires at least one of name, description, tools, modelSelection",
          path: ["name"],
        });
      return;
    }
    // set_status
    if (input.status === undefined)
      ctx.addIssue({ code: "custom", message: "set_status requires status", path: ["status"] });
    if (input.name !== undefined || input.description !== undefined || input.prompt !== undefined)
      ctx.addIssue({
        code: "custom",
        message: "set_status changes status only; use update for metadata",
        path: ["status"],
      });
  });

export type ManageWorkersInput = z.infer<typeof ManageWorkersInputSchema>;

export const ManageWorkersOutputSchema = z
  .object({
    action: ManageWorkersActionSchema,
    worker: z
      .object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        tools: z.array(z.string()).optional(),
        modelSelection: workerModelSelectionSchema.optional(),
        status: z.enum(["active", "deactivated"]),
        createdAt: z.string(),
        updatedAt: z.string(),
      })
      .strict(),
    defineMdPath: z
      .string()
      .describe(
        "Absolute path of the worker's duty definition (define.md) — you (the master agent) maintain it via Write/Edit; the worker is not allowed to modify it.",
      ),
    agentsMdPath: z
      .string()
      .describe(
        "Absolute path of the worker's self-maintained agents.md skeleton — the worker's own territory; its content is maintained by the worker, not by you.",
      ),
    rosterSize: z
      .number()
      .int()
      .nonnegative()
      .describe("Number of workers currently registered (any status)."),
    warnings: z
      .array(z.string())
      .optional()
      .describe("Non-fatal notes, e.g. the display name is shared with another worker."),
  })
  .strict();
export type ManageWorkersOutput = z.infer<typeof ManageWorkersOutputSchema>;

export const ManageWorkersInputJsonSchema = toToolJsonSchema(ManageWorkersInputSchema);
export const ManageWorkersOutputJsonSchema = toToolJsonSchema(ManageWorkersOutputSchema);
