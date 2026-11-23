import { z } from "zod";
import { WORKER_ID_PATTERN, remoteHostIdFromWorkspaceIdentity } from "@robinrun/shared";
import type { DatabaseSync } from "node:sqlite";
import type { GroupTaskFact, GroupTaskRef, ITaskGroupService } from "#src/task-groups/contract.js";
import { TaskGroupRepository, groupTaskKey } from "#src/task-groups/repository.js";
export { TaskGroupRepository, groupTaskKey } from "#src/task-groups/repository.js";
export { ITaskGroupService } from "#src/task-groups/contract.js";
export type {
  TaskGroup,
  TaskGroupColor,
  TaskGroupStructure,
  GroupTaskRef,
  GroupNode,
  MoveGroupNode,
  GroupTaskFact,
} from "#src/task-groups/contract.js";

const taskSchema = z
  .object({
    hostId: z.string().min(1),
    workspacePath: z.string().min(1),
    workspaceIdentity: z.string().trim().min(1).optional(),
    taskId: z.string().min(1),
  })
  .strict()
  .refine(
    (task) =>
      (remoteHostIdFromWorkspaceIdentity(task.workspaceIdentity ?? "") ?? "local") === task.hostId,
    "task-group.host-identity-mismatch",
  );
const nodeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("group"), groupId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("task"), task: taskSchema }).strict(),
]);
export function createTaskGroupService(options: {
  database(): Promise<DatabaseSync>;
  resolveTasks(tasks: GroupTaskRef[]): Promise<GroupTaskFact[]>;
  afterChange(): Promise<void>;
}): ITaskGroupService {
  const repository = async () => new TaskGroupRepository(await options.database());
  const changed = async (run: (repo: TaskGroupRepository) => void) => {
    const repo = await repository();
    run(repo);
    await options.afterChange();
  };
  return {
    read: async () => (await repository()).read(),
    async save(input) {
      const parsed = z
        .object({
          id: z.string().min(1).optional(),
          title: z.string().trim().min(1).max(200).optional(),
          color: z.enum(["gray", "red", "orange", "yellow", "green", "blue", "purple"]).optional(),
          projectId: z.string().min(1).nullable().optional(),
        })
        .strict()
        .parse(input);
      const result = (await repository()).save(parsed);
      await options.afterChange();
      return result;
    },
    async ungroup(id) {
      await changed((repo) => repo.ungroup(z.string().min(1).parse(id)));
    },
    async ensureMainAgentGroup(input) {
      const parsed = z
        .object({ projectId: z.string().min(1) })
        .strict()
        .parse(input);
      const result = (await repository()).ensureMainAgentGroup(parsed.projectId);
      // 已存在时是幂等空操作；广播无副作用，UI 侧刷新一遍结构即可。
      await options.afterChange();
      return result;
    },
    async ensureWorkerGroup(input) {
      const parsed = z
        .object({
          projectId: z.string().min(1),
          // 形状与 worker-roster workerIdSchema 一致（小写 slug，1-64）；task-groups 不反向
          // import worker-roster（受管模块单向依赖），正则取自 shared 的 WORKER_ID_PATTERN。
          workerId: z.string().regex(WORKER_ID_PATTERN).max(64),
          title: z.string().trim().min(1).max(200).optional(),
        })
        .strict()
        .parse(input);
      const result = (await repository()).ensureWorkerGroup(parsed);
      // 幂等（含标题同步路径）；广播无副作用，UI 侧刷新一遍结构即可。
      await options.afterChange();
      return result;
    },
    async move(input) {
      const parsed = z
        .object({
          node: nodeSchema,
          sourceGroupId: z.string().min(1).nullable(),
          groupId: z.string().min(1).nullable(),
          anchor: z
            .object({ node: nodeSchema, side: z.enum(["before", "after"]) })
            .strict()
            .optional(),
        })
        .strict()
        .parse(input);
      const refs = [parsed.node, parsed.anchor?.node].flatMap((node) =>
        node?.type === "task" ? [node.task] : [],
      );
      const facts = await options.resolveTasks(refs);
      if (
        facts.length !== refs.length ||
        refs.some(
          (ref) =>
            !facts.some(
              (task) =>
                groupTaskKey(task) === groupTaskKey(ref) &&
                task.hostId === ref.hostId &&
                task.workspacePath === ref.workspacePath &&
                !task.deleted &&
                !task.archived,
            ),
        )
      )
        throw new Error("task-group.task-unavailable");
      await changed((repo) => repo.move(parsed));
    },
    async admit(input) {
      const parsed = z
        .object({
          tasks: z.array(taskSchema).max(10000),
          placement: z
            .object({
              task: taskSchema,
              groupId: z.string().min(1).nullable(),
              creationId: z.string().min(1),
            })
            .strict()
            .optional(),
        })
        .strict()
        .parse(input);
      const facts = await options.resolveTasks(parsed.tasks);
      if (
        parsed.placement &&
        !facts.some(
          (task) =>
            groupTaskKey(task) === groupTaskKey(parsed.placement!.task) &&
            task.hostId === parsed.placement!.task.hostId &&
            task.workspacePath === parsed.placement!.task.workspacePath &&
            !task.deleted,
        )
      )
        throw new Error("task-group.created-task-unavailable");
      const db = await options.database();
      const before = db.prepare("SELECT total_changes() AS n").get()?.n;
      new TaskGroupRepository(db).admit(facts, parsed.placement);
      if (db.prepare("SELECT total_changes() AS n").get()?.n !== before)
        await options.afterChange();
    },
  };
}
