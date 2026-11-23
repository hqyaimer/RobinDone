import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CRON_DEFAULT_GROUP_ID,
  OFF_PEAK_DEFAULT_GROUP_ID,
  MAIN_AGENT_GROUP_COLOR,
  MAIN_AGENT_GROUP_PREFIX,
  MAIN_AGENT_GROUP_TITLE,
  TRIGGER_ID_PREFIX,
  WORKER_ID_PATTERN,
  isMainAgentGroupId,
  isWorkerGroupId,
  mainAgentGroupId,
  resolveWorkspaceKey,
  workerGroupId,
} from "@robinrun/shared";
import type {
  GroupNode,
  GroupTaskFact,
  GroupTaskRef,
  ITaskGroupService,
  MoveGroupNode,
  TaskGroup,
  TaskGroupStructure,
} from "#src/task-groups/contract.js";

type OrderedNode = { type: "task" | "group"; key: string };
type Admission = { system_kind: string | null; user_organized: number; creation_id: string | null };
// worker 组创建时随机取色（2026-11-16 验收反馈：默认全灰没有辨识度）。灰色语义保留给
// "未设置"，随机池不含它；用户仍可在侧栏改色（改色存组行，名册同步不覆盖）。
const WORKER_GROUP_RANDOM_COLORS: TaskGroup["color"][] = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
];
export function groupTaskKey(
  task: Pick<GroupTaskRef, "workspacePath" | "workspaceIdentity" | "taskId">,
) {
  return JSON.stringify([resolveWorkspaceKey(task), task.taskId]);
}
function nodeKey(node: GroupNode): OrderedNode {
  return node.type === "group"
    ? { type: "group", key: node.groupId }
    : { type: "task", key: groupTaskKey(node.task) };
}
function equalNode(a: OrderedNode, b: OrderedNode) {
  return a.type === b.type && a.key === b.key;
}

/** 复用旧表的控制端组织仓库；同步 SQLite 事务内没有 await，不跨进程改写任务事实。 */
export class TaskGroupRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}
  private transaction<T>(run: () => T): T {
    const own = !this.db.isTransaction;
    if (own) this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      if (own) this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (own && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  read(): TaskGroupStructure {
    const own = !this.db.isTransaction;
    if (own) this.db.exec("BEGIN");
    try {
      const result = {
        groups: this.db
          .prepare(
            "SELECT group_id AS id,title,coalesce(color,'gray') AS color,project_id AS projectId,created_at AS createdAt,updated_at AS updatedAt FROM task_groups ORDER BY created_at,group_id",
          )
          .all() as unknown as TaskGroup[],
        members: this.db
          .prepare(
            "SELECT group_id AS groupId,workspace_key AS workspaceKey,task_id AS taskId,coalesce(sort_order,-added_at) AS sortOrder FROM task_group_members ORDER BY sortOrder,workspace_key,task_id",
          )
          .all() as unknown as TaskGroupStructure["members"],
        order: this.db
          .prepare(
            "SELECT node_type AS type,node_key AS key,sort_order AS sortOrder FROM task_group_view_node_orders ORDER BY sort_order,node_type,node_key",
          )
          .all() as unknown as TaskGroupStructure["order"],
      };
      if (own) this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (own && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private hasGroup(id: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM task_groups WHERE group_id=?").get(id));
  }
  private parent(task: GroupTaskRef): string | null {
    return (
      (this.db
        .prepare("SELECT group_id FROM task_group_members WHERE workspace_key=? AND task_id=?")
        .get(resolveWorkspaceKey(task), task.taskId)?.group_id as string | undefined) ?? null
    );
  }
  private children(groupId: string | null): OrderedNode[] {
    const structure = this.read();
    if (groupId)
      return structure.members
        .filter((member) => member.groupId === groupId)
        .map((member) => ({
          type: "task",
          key: JSON.stringify([member.workspaceKey, member.taskId]),
        }));
    const members = new Set(
      structure.members.map((member) => JSON.stringify([member.workspaceKey, member.taskId])),
    );
    const groups = new Set(structure.groups.map((group) => group.id));
    const nodes = structure.order.filter((node) =>
      node.type === "group" ? groups.has(node.key) : !members.has(node.key),
    );
    const ordered = new Set(nodes.filter((node) => node.type === "group").map((node) => node.key));
    return [
      ...nodes,
      ...structure.groups
        .filter((group) => !ordered.has(group.id))
        .map((group) => ({ type: "group" as const, key: group.id })),
    ];
  }
  private writeOrder(nodes: OrderedNode[], groupId: string | null) {
    const now = this.now();
    nodes.forEach((node, position) => {
      if (groupId) {
        const [workspaceKey, taskId] = JSON.parse(node.key) as [string, string];
        this.db
          .prepare(
            "UPDATE task_group_members SET sort_order=?,updated_at=? WHERE group_id=? AND workspace_key=? AND task_id=?",
          )
          .run(position, now, groupId, workspaceKey, taskId);
      } else {
        this.db
          .prepare(`INSERT INTO task_group_view_node_orders(node_type,node_key,sort_order,created_at,updated_at)
          VALUES(?,?,?,?,?) ON CONFLICT(node_type,node_key) DO UPDATE SET sort_order=excluded.sort_order,updated_at=excluded.updated_at`)
          .run(node.type, node.key, position, now, now);
      }
    });
  }
  save(input: {
    id?: string;
    title?: string;
    color?: TaskGroup["color"];
    projectId?: string | null;
  }): TaskGroup {
    return this.transaction(() => {
      const previous = input.id
        ? this.read().groups.find((group) => group.id === input.id)
        : undefined;
      if (input.id && !previous) throw new Error("task-group.not-found");
      // 主智能体组的归属由项目 id 派生，save 不允许改绑（id 前缀即权威）；
      // worker 组的归属在 ensureWorkerGroup 创建时锁定，同样不接受改绑。
      const projectId =
        input.id && isMainAgentGroupId(input.id)
          ? mainAgentGroupId(input.id.slice(MAIN_AGENT_GROUP_PREFIX.length))
          : input.id && previous && isWorkerGroupId(input.id)
            ? (previous.projectId ?? null)
            : input.projectId !== undefined
              ? input.projectId
              : (previous?.projectId ?? null);
      const group: TaskGroup = {
        id: previous?.id ?? randomUUID(),
        title: input.title?.trim() ?? previous?.title ?? "New group",
        color: input.color ?? previous?.color ?? "gray",
        projectId,
        createdAt: previous?.createdAt ?? this.now(),
        updatedAt: this.now(),
      };
      if (!group.title) throw new Error("task-group.title-required");
      this.db
        .prepare(`INSERT INTO task_groups(group_id,title,color,project_id,created_at,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(group_id) DO UPDATE SET title=excluded.title,color=excluded.color,project_id=excluded.project_id,updated_at=excluded.updated_at`)
        .run(group.id, group.title, group.color, group.projectId, group.createdAt, group.updatedAt);
      if (!previous)
        this.writeOrder(
          [
            { type: "group", key: group.id },
            ...this.children(null).filter((node) => node.key !== group.id),
          ],
          null,
        );
      return group;
    });
  }
  /**
   * 项目标配主智能体：确定性 id 幂等自举，重开项目（saveProject reuseExistingRoot）重复调用安全。
   * 新建时置顶根层排序；展示顺序在 UI 内按项目归拢后再将主智能体排最前。
   */
  ensureMainAgentGroup(projectId: string): TaskGroup {
    return this.transaction(() => {
      const id = mainAgentGroupId(projectId);
      const existing = this.read().groups.find((group) => group.id === id);
      if (existing) return existing;
      const now = this.now();
      const group: TaskGroup = {
        id,
        title: MAIN_AGENT_GROUP_TITLE,
        color: MAIN_AGENT_GROUP_COLOR,
        projectId,
        createdAt: now,
        updatedAt: now,
      };
      this.db
        .prepare(
          "INSERT INTO task_groups(group_id,title,color,project_id,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        )
        .run(group.id, group.title, group.color, group.projectId, group.createdAt, group.updatedAt);
      this.writeOrder(
        [
          { type: "group", key: group.id },
          ...this.children(null).filter((node) => node.key !== group.id),
        ],
        null,
      );
      return group;
    });
  }
  /**
   * worker 会话组织组（2026-11-16 物化裁决）：确定性 id（robinrun-worker-<workerId>）幂等。
   * 不存在则以随机非灰色新建并置顶根层排序（展示顺序由 UI 排在主智能体之后、用户组之前）；
   * 已存在且 title 不同则同步标题——workers.json 注册表是身份事实源，注册表赢，用户的
   * 改色与归属不被覆盖。workerId 形状在此兜底校验（facade 已有 zod 同款校验）。
   */
  ensureWorkerGroup(input: { projectId: string; workerId: string; title?: string }): TaskGroup {
    return this.transaction(() => {
      if (!WORKER_ID_PATTERN.test(input.workerId) || input.workerId.length > 64)
        throw new Error("task-group.worker-id-invalid");
      const id = workerGroupId(input.workerId);
      const existing = this.read().groups.find((group) => group.id === id);
      const title = input.title?.trim();
      if (existing) {
        if (title && title !== existing.title) {
          const updatedAt = this.now();
          this.db
            .prepare("UPDATE task_groups SET title=?,updated_at=? WHERE group_id=?")
            .run(title, updatedAt, id);
          return { ...existing, title, updatedAt };
        }
        return existing;
      }
      const now = this.now();
      const group: TaskGroup = {
        id,
        title: title || input.workerId,
        // 随机池非空，?? 只是 noUncheckedIndexedAccess 的类型兜底。
        color:
          WORKER_GROUP_RANDOM_COLORS[
            Math.floor(Math.random() * WORKER_GROUP_RANDOM_COLORS.length)
          ] ?? "gray",
        projectId: input.projectId,
        createdAt: now,
        updatedAt: now,
      };
      this.db
        .prepare(
          "INSERT INTO task_groups(group_id,title,color,project_id,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        )
        .run(group.id, group.title, group.color, group.projectId, group.createdAt, group.updatedAt);
      this.writeOrder(
        [
          { type: "group", key: group.id },
          ...this.children(null).filter((node) => node.key !== group.id),
        ],
        null,
      );
      return group;
    });
  }
  ungroup(id: string): void {
    this.transaction(() => {
      // 主智能体是项目标配（ACD 裁决：禁止删除），服务层/UI 均不提供入口，仓储兜底拒绝。
      if (isMainAgentGroupId(id)) throw new Error("task-group.protected");
      // worker 组是编制投影（2026-11-16 裁决）：身份归 workers.json，禁止从 UI 解散，
      // 否则下一次名册同步会重建空组、历史会话脱管。
      if (isWorkerGroupId(id)) throw new Error("task-group.protected");
      if (!this.hasGroup(id)) return;
      const members = this.children(id);
      const root = this.children(null).flatMap((node) =>
        node.type === "group" && node.key === id ? members : [node],
      );
      for (const member of members) {
        const [workspaceKey, taskId] = JSON.parse(member.key) as [string, string];
        this.markOrganized(workspaceKey, taskId);
      }
      this.db.prepare("DELETE FROM task_group_members WHERE group_id=?").run(id);
      this.db.prepare("DELETE FROM task_groups WHERE group_id=?").run(id);
      this.db
        .prepare("DELETE FROM task_group_view_node_orders WHERE node_type='group' AND node_key=?")
        .run(id);
      this.writeOrder(root, null);
    });
  }
  private markOrganized(workspaceKey: string, taskId: string) {
    this.db
      .prepare(`INSERT INTO task_group_admissions(workspace_key,task_id,user_organized) VALUES(?,?,1)
      ON CONFLICT(workspace_key,task_id) DO UPDATE SET user_organized=1`)
      .run(workspaceKey, taskId);
  }
  move(input: MoveGroupNode): void {
    this.transaction(() => this.moveInside(input, true));
  }
  private moveInside(input: MoveGroupNode, manual: boolean) {
    const node = nodeKey(input.node);
    const parent = input.node.type === "task" ? this.parent(input.node.task) : null;
    if (parent !== input.sourceGroupId) throw new Error("task-group.stale-source");
    if (input.node.type === "group" && (input.groupId || !this.hasGroup(input.node.groupId)))
      throw new Error("task-group.invalid-group");
    if (input.groupId && !this.hasGroup(input.groupId)) throw new Error("task-group.not-found");
    const destination = this.children(input.groupId).filter(
      (candidate) => !equalNode(candidate, node),
    );
    const anchor = input.anchor && nodeKey(input.anchor.node);
    const index = anchor ? destination.findIndex((candidate) => equalNode(candidate, anchor)) : 0;
    if (index < 0) throw new Error("task-group.stale-anchor");
    destination.splice(index + (input.anchor?.side === "after" ? 1 : 0), 0, node);
    if (input.node.type === "task") {
      const task = input.node.task;
      const workspaceKey = resolveWorkspaceKey(task);
      if (manual) this.markOrganized(workspaceKey, task.taskId);
      this.db
        .prepare("DELETE FROM task_group_members WHERE workspace_key=? AND task_id=?")
        .run(workspaceKey, task.taskId);
      if (input.groupId) {
        const now = this.now();
        this.db
          .prepare(`INSERT INTO task_group_members(group_id,workspace_key,workspace_path,workspace_identity,task_id,sort_order,added_at,created_at,updated_at)
          VALUES(?,?,?,?,?,0,?,?,?)`)
          .run(
            input.groupId,
            workspaceKey,
            task.workspacePath,
            task.workspaceIdentity ?? null,
            task.taskId,
            now,
            now,
            now,
          );
      }
    }
    this.writeOrder(destination, input.groupId);
  }
  admit(
    tasks: GroupTaskFact[],
    placement?: Parameters<ITaskGroupService["admit"]>[0]["placement"],
  ): void {
    this.transaction(() => {
      // 批量首次发现按创建时间从旧到新写入顶部；以后活动更新不重排已登记节点。
      for (const task of [...tasks].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) {
        const workspaceKey = resolveWorkspaceKey(task),
          key = groupTaskKey(task);
        if (task.deleted) {
          this.db
            .prepare("DELETE FROM task_group_members WHERE workspace_key=? AND task_id=?")
            .run(workspaceKey, task.taskId);
          this.db
            .prepare(
              "DELETE FROM task_group_view_node_orders WHERE node_type='task' AND node_key=?",
            )
            .run(key);
          // 删除事实可能晚到；保留登记墓碑，后续缺少 deleted 的投影不能重新入组。
          this.markOrganized(workspaceKey, task.taskId);
          continue;
        }
        let admission = this.db
          .prepare("SELECT * FROM task_group_admissions WHERE workspace_key=? AND task_id=?")
          .get(workspaceKey, task.taskId) as unknown as Admission | undefined;
        if (!admission) {
          const legacy =
            this.parent(task) !== null ||
            Boolean(
              this.db
                .prepare(
                  "SELECT 1 FROM task_group_view_node_orders WHERE node_type='task' AND node_key=?",
                )
                .get(key),
            );
          this.db
            .prepare(
              "INSERT INTO task_group_admissions(workspace_key,task_id,user_organized) VALUES(?,?,?)",
            )
            .run(workspaceKey, task.taskId, legacy ? 1 : 0);
          admission = { system_kind: null, creation_id: null, user_organized: legacy ? 1 : 0 };
          if (!legacy) {
            // 首次发现只写一个顶层位置，避免大库启动时逐条重排造成平方级写放大。
            const order = Number(
              this.db
                .prepare(
                  "SELECT coalesce(min(sort_order),0)-1 AS n FROM task_group_view_node_orders",
                )
                .get()?.n,
            );
            const now = this.now();
            this.db
              .prepare(
                "INSERT INTO task_group_view_node_orders(node_type,node_key,sort_order,created_at,updated_at) VALUES('task',?,?,?,?)",
              )
              .run(key, order, now, now);
          }
        }
        // 触发器投递复用了 automationId 参数位（P3 dispatchTriggerRun），值落在
        // cronAutomationId 列；后续 meta 刷新可能清列，此时 creationOrigin{kind:"trigger",
        // ref} 是 sticky 权威（P2.5 起落盘）。触发器（trg- 前缀）不是上游 cron automation
        // （id 形状 automation-<uuid>，前缀互斥）——其会话入口是触发器文件夹，任务组视图
        // 归入订阅智能体组，不得进"定时任务"组（双重呈现）也不留顶层（会渲染成"未分组"）
        // （2026-11-19 验收 bug）。订阅者归属（2026-11-20 worker 会话同构化）：行带
        // workerId（worker 订阅者的触发器会话）归该 worker 的确定性组（ensure 幂等），
        // master 订阅者仍归主智能体组。
        const triggerRef =
          task.cronAutomationId ??
          (task.creationOrigin?.kind === "trigger" ? task.creationOrigin.ref : undefined);
        const isTriggerRef = triggerRef?.startsWith(TRIGGER_ID_PREFIX) ?? false;
        const systemKind =
          task.cronAutomationId && !isTriggerRef ? "cron" : task.offPeakTaskId ? "off-peak" : null;
        if (
          isTriggerRef &&
          !admission.user_organized &&
          // 旧版本误归 cron 组的行（清 cron 标记改归智能体组）或从未归组的顶层行（首次
          // 确认；首次发现刚写顶层 order 时 parent 也是 null，两个情形合一）。
          (admission.system_kind === "cron" || this.parent(task) === null)
        ) {
          const projectId = task.projectId ?? null;
          // 订阅者归属：worker 订阅者 → 其确定性组（幂等 ensure；标题用派发时显示名），
          // master 订阅者 → 主智能体组。
          const ownerGroupId =
            task.workerId && projectId !== null
              ? this.ensureWorkerGroup({
                  projectId,
                  workerId: task.workerId,
                  ...(task.workerName ? { title: task.workerName } : {}),
                }).id
              : projectId !== null
                ? mainAgentGroupId(projectId)
                : null;
          if (ownerGroupId !== null && this.hasGroup(ownerGroupId)) {
            this.moveInside(
              {
                node: { type: "task", task },
                sourceGroupId: this.parent(task),
                groupId: ownerGroupId,
              },
              false,
            );
            this.db
              .prepare(
                "UPDATE task_group_admissions SET system_kind='trigger' WHERE workspace_key=? AND task_id=?",
              )
              .run(workspaceKey, task.taskId);
          }
        }
        // 普通 master 会话首次发现归组（2026-11-21 实测修复）：ContactAgent 等 host 派发
        // 路径没有 placement（UI 草稿流才带），首次发现只写顶层 order → 渲染进"未分组"
        // 伪组。与触发器分支同模式自愈：事实带 projectId、非 worker（worker 会话由
        // syncer ensureWorkerGroup 准入）、非系统组类型、用户未整理且尚无父组 → 归入
        // 项目主智能体组（组未自举时跳过，下次活动准入重试；用户移出后 user_organized
        // 拦截，不回吸）。
        if (
          !isTriggerRef &&
          systemKind === null &&
          !task.workerId &&
          task.projectId != null &&
          !admission.user_organized &&
          !task.archived &&
          this.parent(task) === null
        ) {
          const ownerGroupId = mainAgentGroupId(task.projectId);
          if (this.hasGroup(ownerGroupId)) {
            this.moveInside(
              { node: { type: "task", task }, sourceGroupId: null, groupId: ownerGroupId },
              false,
            );
          }
        }
        if (systemKind && admission.system_kind === null) {
          this.db
            .prepare(
              "UPDATE task_group_admissions SET system_kind=? WHERE workspace_key=? AND task_id=?",
            )
            .run(systemKind, workspaceKey, task.taskId);
          // 首次类型确认才入组；不能把读列表变成重复覆盖用户整理的“自愈”。
          if (!admission.user_organized && !task.archived && !this.parent(task)) {
            const id = systemKind === "cron" ? CRON_DEFAULT_GROUP_ID : OFF_PEAK_DEFAULT_GROUP_ID;
            if (!this.hasGroup(id)) {
              const now = this.now();
              // 修复（2026-11-19）：v7 加 project_id 列时本处裸 INSERT 漏改——
              // "table task_groups has 6 columns but 5 values were supplied"，
              // cron/触发器默认组首次落库即炸（既有机器组已存在而不触发）。
              // 显式列名 + project_id 传 null（系统默认组跨项目，与迁移 v7 的可空语义一致）。
              this.db
                .prepare(
                  "INSERT INTO task_groups(group_id,title,color,project_id,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                )
                .run(id, systemKind, systemKind === "cron" ? "blue" : "purple", null, now, now);
              this.writeOrder(
                [
                  { type: "group", key: id },
                  ...this.children(null).filter((node) => node.key !== id),
                ],
                null,
              );
            }
            this.moveInside(
              { node: { type: "task", task }, sourceGroupId: null, groupId: id },
              false,
            );
          }
        }
        if (placement && groupTaskKey(placement.task) === key && admission.creation_id === null) {
          if (!admission.user_organized)
            this.moveInside(
              {
                node: { type: "task", task },
                sourceGroupId: this.parent(task),
                groupId:
                  placement.groupId && this.hasGroup(placement.groupId) ? placement.groupId : null,
              },
              true,
            );
          this.db
            .prepare(
              "UPDATE task_group_admissions SET creation_id=? WHERE workspace_key=? AND task_id=?",
            )
            .run(placement.creationId, workspaceKey, task.taskId);
        }
      }
    });
  }
}
