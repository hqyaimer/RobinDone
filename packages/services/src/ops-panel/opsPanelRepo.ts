/* 需求/审批/反馈面板仓库（2026-11-24 MVP）：ops_panel_entries 的行映射、编号分配与
   串行唤醒队列状态机。与 automation/off-peak 共用 tasks-index.sqlite 与 Repo 模式，
   表与状态机独立，禁止往 tasks/automations 等表加字段。
   排序契约：全部列表/队列按 rowid（插入序 = 创建序）排序——created_at 只有毫秒精度，
   同毫秒创建的跨 kind 条目用它排序不确定（实测 flaky），seq 又是 per-kind 的不能混排。
   队列纪律（需求 §3.2）：同一 workspace 同一时刻至多一条 in_flight；处置（状态决定）
   即释放并唤醒队头，不合并、排期不占队列。 */
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  formatProgressEntryId,
  opsPanelEntrySchema,
  progressEntrySchema,
  resolveWorkspaceKey,
  type OpsAuthor,
  type OpsEntryKind,
  type OpsPanelEntry,
  type OpsWakeupState,
  type ProgressCreatedBy,
  type ProgressEntry,
} from "@robinrun/shared";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import { OPS_PANEL_SCHEMA_SQL } from "./migration-v8.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

interface OpsPanelEntryRow {
  workspace_key: string;
  id: string;
  kind: OpsEntryKind;
  seq: number;
  title: string;
  body: string;
  author: string;
  recorded_by: string;
  status: string;
  outcome: string | null;
  note: string | null;
  wakeup_state: OpsWakeupState;
  links: string | null;
  acknowledged_at: number | null;
  decided_at: number | null;
  created_at: number;
  updated_at: number;
}

function isoOf(epochMs: number | null | undefined): string | undefined {
  if (epochMs === null || epochMs === undefined) return undefined;
  return new Date(epochMs).toISOString();
}

function parseLinks(raw: string | null): Record<string, string> | undefined {
  if (raw === null || raw.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const links: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") links[key] = value;
    }
    return Object.keys(links).length > 0 ? links : undefined;
  } catch {
    // links 是预留字段：损坏不炸整行（fail-safe 置空）。
    return undefined;
  }
}

function rowToEntry(row: OpsPanelEntryRow): OpsPanelEntry {
  const base = {
    id: row.id,
    title: row.title,
    body: row.body,
    author: row.author as OpsAuthor,
    // 0009 回填前 default ''——防御存量库未跑迁移的读路径（正常链路迁移先行）。
    recordedBy: (row.recorded_by.length > 0 ? row.recorded_by : row.author) as OpsAuthor,
    ...(row.note !== null ? { note: row.note } : {}),
    ...parseLinks(row.links),
    ...(row.decided_at !== null ? { decidedAt: isoOf(row.decided_at) } : {}),
    ...(row.acknowledged_at !== null ? { acknowledgedAt: isoOf(row.acknowledged_at) } : {}),
    createdAt: isoOf(row.created_at) ?? "",
    updatedAt: isoOf(row.updated_at) ?? "",
  };
  // 判别 union 一次校验 per-kind 状态词表与 disposed⇒outcome 不变量（损坏行 fail-fast）。
  return opsPanelEntrySchema.parse({
    ...base,
    kind: row.kind,
    status: row.status,
    ...(row.outcome !== null ? { outcome: row.outcome } : {}),
  });
}

// ---- 进度账本行映射（2026-11-25，specs/progress-ledger.md；表见 migration-v10）----

interface ProgressEntryRow {
  workspace_key: string;
  id: string;
  seq: number;
  title: string;
  body: string;
  links: string | null;
  created_by: string;
  deleted: number;
  created_at: number;
  updated_at: number;
}

function parseProgressLinks(raw: string | null): { links?: string[] } {
  if (raw === null || raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return {};
    const links = parsed.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
    return links.length > 0 ? { links } : {};
  } catch {
    // links 损坏不炸整行（fail-safe 置空，同 ops_panel_entries.links 的处理）。
    return {};
  }
}

function rowToProgressEntry(row: ProgressEntryRow): ProgressEntry {
  // schema 一次校验词表（created_by/deleted 由 DB CHECK 与读路径过滤兜底；损坏行 fail-fast）。
  return progressEntrySchema.parse({
    id: row.id,
    title: row.title,
    ...(row.body.length > 0 ? { body: row.body } : {}),
    ...parseProgressLinks(row.links),
    createdBy: row.created_by,
    createdAt: isoOf(row.created_at) ?? "",
    updatedAt: isoOf(row.updated_at) ?? "",
  });
}

export interface OpsPanelInsertParams {
  workspacePath: string;
  workspaceIdentity?: string;
  kind: OpsEntryKind;
  title: string;
  body: string;
  author: OpsAuthor;
  /** 录入者（2026-11-24 录入与来源拆分）：master 代录时 author=user、recordedBy=master。 */
  recordedBy: OpsAuthor;
  /** 入队意图由服务层决定（唤醒豁免规则在此层之上）：pending 或 none。 */
  wakeupState: Exclude<OpsWakeupState, "in_flight" | "released">;
  links?: Record<string, string>;
  now?: number;
}

export interface OpsPanelQueueHead {
  id: string;
  kind: OpsEntryKind;
}

/** 队列快照（面板待处理列表投影）：in_flight 至多一条，pending 按创建先后排序。 */
export interface OpsPanelQueueSnapshot {
  inFlightId: string | null;
  pendingIds: string[];
}

export class OpsPanelRepo {
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly resolvedDbPath: string | null;
  private migrationBackupSkipped = false;
  /** 测试观测：最近一次迁移是否跳过了备份。 */
  get backupSkippedForTest(): boolean {
    return this.migrationBackupSkipped;
  }

  constructor(
    dbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {
    this.resolvedDbPath = dbPath?.trim() || null;
  }

  private resolveDbPath(): string {
    return this.resolvedDbPath ?? getTasksIndexDatabasePath();
  }

  async ensureReady(): Promise<void> {
    const path = this.resolveDbPath();
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(options?: { throwOnError?: boolean }): void {
    let closeError: unknown;
    try {
      this.db?.close();
    } catch (error) {
      closeError = error;
      // ignore
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    if (options?.throwOnError && closeError) throw closeError;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    if (isTasksStoragePrepared(path, this.db)) return;
    if (!isTasksStorageMigrated(path, this.db)) {
      this.migrationBackupSkipped = (await runTasksDatabaseMigrations(this.db, path)).backupSkipped;
    }
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("OpsPanelRepo 未初始化：请先 await ensureReady()");
    }
    return this.db;
  }

  // ---- 读取 ----

  /** 面板列表（created_at ASC = 编号序）；authorFilter 非空时只返回该作者条目（worker 可见性）。 */
  async listEntries(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    authorFilter?: string;
  }): Promise<OpsPanelEntry[]> {
    await this.ensureReady();
    const workspaceKey = resolveWorkspaceKey(params);
    const rows = (params.authorFilter === undefined
      ? this.getDatabase()
          .prepare("SELECT * FROM ops_panel_entries WHERE workspace_key = ? ORDER BY rowid ASC")
          .all(workspaceKey)
      : this.getDatabase()
          .prepare(
            "SELECT * FROM ops_panel_entries WHERE workspace_key = ? AND author = ? ORDER BY rowid ASC",
          )
          .all(workspaceKey, params.authorFilter)) as unknown as OpsPanelEntryRow[];
    return rows.map(rowToEntry);
  }

  async getEntry(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    entryId: string;
    authorFilter?: string;
  }): Promise<OpsPanelEntry | null> {
    await this.ensureReady();
    const workspaceKey = resolveWorkspaceKey(params);
    const row = (params.authorFilter === undefined
      ? this.getDatabase()
          .prepare("SELECT * FROM ops_panel_entries WHERE workspace_key = ? AND id = ?")
          .get(workspaceKey, params.entryId)
      : this.getDatabase()
          .prepare(
            "SELECT * FROM ops_panel_entries WHERE workspace_key = ? AND id = ? AND author = ?",
          )
          .get(workspaceKey, params.entryId, params.authorFilter)) as unknown as
      | OpsPanelEntryRow
      | undefined;
    return row === undefined ? null : rowToEntry(row);
  }

  async getQueueSnapshot(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<OpsPanelQueueSnapshot> {
    await this.ensureReady();
    const workspaceKey = resolveWorkspaceKey(params);
    const db = this.getDatabase();
    const inFlight = db
      .prepare(
        "SELECT id FROM ops_panel_entries WHERE workspace_key = ? AND wakeup_state = 'in_flight' ORDER BY rowid ASC LIMIT 1",
      )
      .get(workspaceKey) as { id: string } | undefined;
    const pending = db
      .prepare(
        "SELECT id FROM ops_panel_entries WHERE workspace_key = ? AND wakeup_state = 'pending' ORDER BY rowid ASC",
      )
      .all(workspaceKey) as Array<{ id: string }>;
    return {
      inFlightId: inFlight?.id ?? null,
      pendingIds: pending.map((row) => row.id),
    };
  }

  // ---- 写入 ----

  /**
   * 创建条目（编号在事务内分配：per workspace per kind 递增，不复用）。
   * DatabaseSync 事务属于整个连接：BEGIN 到提交之间不能 await。
   */
  async insertEntry(params: OpsPanelInsertParams): Promise<OpsPanelEntry> {
    await this.ensureReady();
    const workspaceKey = resolveWorkspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    const now = params.now ?? Date.now();
    const db = this.getDatabase();
    const initialStatus =
      params.kind === "requirement"
        ? "submitted"
        : params.kind === "approval"
          ? "pending_review"
          : "submitted";
    let entry: OpsPanelEntry | null = null;
    db.exec("BEGIN IMMEDIATE");
    try {
      const seqRow = db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM ops_panel_entries WHERE workspace_key = ? AND kind = ?",
        )
        .get(workspaceKey, params.kind) as { next: number };
      const seq = seqRow.next;
      const prefix =
        params.kind === "requirement" ? "REQ" : params.kind === "approval" ? "APP" : "FBK";
      const id = `${prefix}-${String(seq).padStart(4, "0")}`;
      db.prepare(
        `INSERT INTO ops_panel_entries (
          workspace_key, id, kind, seq, title, body, author, recorded_by, status,
          outcome, note, wakeup_state, links, acknowledged_at, decided_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, ?, ?)`,
      ).run(
        workspaceKey,
        id,
        params.kind,
        seq,
        params.title,
        params.body,
        params.author,
        params.recordedBy,
        initialStatus,
        params.wakeupState,
        params.links === undefined ? null : JSON.stringify(params.links),
        now,
        now,
      );
      const row = db
        .prepare("SELECT * FROM ops_panel_entries WHERE workspace_key = ? AND id = ?")
        .get(workspaceKey, id) as unknown as OpsPanelEntryRow;
      entry = rowToEntry(row);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return entry;
  }

  /**
   * 串行队列的"释放 + 认领队头"原子操作：
   * - justReleasedId 非空 → 先把它置 released（处置即释放）；
   * - 若仍存在 in_flight（说明释放的不是在途条目，或另有在途）→ 不认领，返回 null；
   * - 否则取最老 pending 置 in_flight（REQ 同时 submitted → in_progress）并返回之。
   * 返回 null 表示当前没有可唤醒的队头（或队列被在途条目占用）。
   */
  claimNextQueueHead(
    workspaceKey: string,
    options?: { justReleasedId?: string; now?: number },
  ): OpsPanelQueueHead | null {
    const db = this.getDatabase();
    const now = options?.now ?? Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (options?.justReleasedId !== undefined) {
        db.prepare(
          "UPDATE ops_panel_entries SET wakeup_state = 'released', updated_at = ? WHERE workspace_key = ? AND id = ?",
        ).run(now, workspaceKey, options.justReleasedId);
      }
      const inFlight = db
        .prepare(
          "SELECT id FROM ops_panel_entries WHERE workspace_key = ? AND wakeup_state = 'in_flight' LIMIT 1",
        )
        .get(workspaceKey) as { id: string } | undefined;
      if (inFlight !== undefined) {
        db.exec("COMMIT");
        return null;
      }
      const head = db
        .prepare(
          "SELECT id, kind FROM ops_panel_entries WHERE workspace_key = ? AND wakeup_state = 'pending' ORDER BY rowid ASC LIMIT 1",
        )
        .get(workspaceKey) as { id: string; kind: OpsEntryKind } | undefined;
      if (head === undefined) {
        db.exec("COMMIT");
        return null;
      }
      db.prepare(
        "UPDATE ops_panel_entries SET wakeup_state = 'in_flight', updated_at = ? WHERE workspace_key = ? AND id = ?",
      ).run(now, workspaceKey, head.id);
      // REQ 的"处理中"= 被唤醒处置中（与用户可见状态机联动；FBK/APP 无此映射）。
      if (head.kind === "requirement") {
        db.prepare(
          "UPDATE ops_panel_entries SET status = 'in_progress', updated_at = ? WHERE workspace_key = ? AND id = ? AND status = 'submitted'",
        ).run(now, workspaceKey, head.id);
      }
      db.exec("COMMIT");
      return { id: head.id, kind: head.kind };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 投递失败回退：in_flight → pending（下一次处置/挂载 pump 重试）。 */
  requeueEntry(workspaceKey: string, entryId: string, options?: { now?: number }): void {
    const now = options?.now ?? Date.now();
    this.getDatabase()
      .prepare(
        "UPDATE ops_panel_entries SET wakeup_state = 'pending', updated_at = ? WHERE workspace_key = ? AND id = ? AND wakeup_state = 'in_flight'",
      )
      .run(now, workspaceKey, entryId);
  }

  /** 静默释放（处置的是未在途条目：出队但不触发唤醒级联——串行门的释放点只在在途条目）。 */
  releaseQuietly(workspaceKey: string, entryId: string, options?: { now?: number }): void {
    const now = options?.now ?? Date.now();
    this.getDatabase()
      .prepare(
        "UPDATE ops_panel_entries SET wakeup_state = 'released', updated_at = ? WHERE workspace_key = ? AND id = ? AND wakeup_state = 'pending'",
      )
      .run(now, workspaceKey, entryId);
  }

  /** 挂载恢复（重启不丢队列）：in_flight 全部回 pending（原轮次已被进程重启打断）。 */
  resetInFlightToPending(workspaceKey: string, options?: { now?: number }): number {
    const now = options?.now ?? Date.now();
    const result = this.getDatabase()
      .prepare(
        "UPDATE ops_panel_entries SET wakeup_state = 'pending', updated_at = ? WHERE workspace_key = ? AND wakeup_state = 'in_flight'",
      )
      .run(now, workspaceKey);
    return Number(result.changes);
  }

  /** 当前状态查询（0 变更报错时用；行不存在返回 "missing"）。 */
  private opsPanelEntryStatus(workspaceKey: string, entryId: string): string {
    const row = this.getDatabase()
      .prepare("SELECT status FROM ops_panel_entries WHERE workspace_key = ? AND id = ?")
      .get(workspaceKey, entryId) as { status: string } | undefined;
    return row?.status ?? "missing";
  }

  /** REQ 处置（四选一）：status → disposed + outcome/note/decided_at；wakeup 交由 claimNextQueueHead 释放。 */
  disposeRequirement(
    workspaceKey: string,
    entryId: string,
    params: { outcome: string; note?: string; now?: number },
  ): void {
    const now = params.now ?? Date.now();
    const result = this.getDatabase()
      .prepare(
        `UPDATE ops_panel_entries
         SET status = 'disposed', outcome = ?, note = COALESCE(?, note), decided_at = ?, updated_at = ?
         WHERE workspace_key = ? AND id = ? AND kind = 'requirement' AND status IN ('submitted','in_progress')`,
      )
      .run(params.outcome, params.note ?? null, now, now, workspaceKey, entryId);
    if (Number(result.changes) === 0) {
      // 带当前状态报错（2026-11-25 实测缺陷 P2-3 教训：原文案的括号是"要求状态"，
      // 被误读成当前状态/身份问题——身份限制在服务层 assert 已单独报错，到这里必已过）。
      throw new Error(
        `Requirement ${entryId} is not disposable: current status is '${this.opsPanelEntryStatus(workspaceKey, entryId)}', requires submitted/in_progress.`,
      );
    }
  }

  /** FBK 分诊：status → processed + note/decided_at。 */
  resolveFeedback(
    workspaceKey: string,
    entryId: string,
    params: { note?: string; now?: number },
  ): void {
    const now = params.now ?? Date.now();
    const result = this.getDatabase()
      .prepare(
        `UPDATE ops_panel_entries
         SET status = 'processed', note = COALESCE(?, note), decided_at = ?, updated_at = ?
         WHERE workspace_key = ? AND id = ? AND kind = 'feedback' AND status = 'submitted'`,
      )
      .run(params.note ?? null, now, now, workspaceKey, entryId);
    if (Number(result.changes) === 0) {
      throw new Error(
        `Feedback ${entryId} is not resolvable: current status is '${this.opsPanelEntryStatus(workspaceKey, entryId)}', requires submitted.`,
      );
    }
  }

  /** APP 用户决定：pending_review → approved/rejected + note/decided_at；wakeup 入队（唤醒 master 执行）。 */
  decideApproval(
    workspaceKey: string,
    entryId: string,
    params: { decision: "approved" | "rejected"; note?: string; now?: number },
  ): void {
    const now = params.now ?? Date.now();
    const result = this.getDatabase()
      .prepare(
        `UPDATE ops_panel_entries
         SET status = ?, note = COALESCE(?, note), decided_at = ?, updated_at = ?, wakeup_state = 'pending'
         WHERE workspace_key = ? AND id = ? AND kind = 'approval' AND status = 'pending_review'`,
      )
      .run(params.decision, params.note ?? null, now, now, workspaceKey, entryId);
    if (Number(result.changes) === 0) {
      throw new Error(
        `Approval ${entryId} is not decidable: current status is '${this.opsPanelEntryStatus(workspaceKey, entryId)}', requires pending_review.`,
      );
    }
  }

  /** APP 执行确认（master ack）：置 acknowledged_at + 释放队列（不改用户可见状态）。 */
  acknowledgeApproval(
    workspaceKey: string,
    entryId: string,
    params: { note?: string; now?: number },
  ): void {
    const now = params.now ?? Date.now();
    const result = this.getDatabase()
      .prepare(
        `UPDATE ops_panel_entries
         SET acknowledged_at = ?, note = COALESCE(?, note), updated_at = ?
         WHERE workspace_key = ? AND id = ? AND kind = 'approval'
           AND status IN ('approved','rejected') AND acknowledged_at IS NULL`,
      )
      .run(now, params.note ?? null, now, workspaceKey, entryId);
    if (Number(result.changes) === 0) {
      throw new Error(
        `Approval ${entryId} is not awaiting acknowledgment: current status is '${this.opsPanelEntryStatus(workspaceKey, entryId)}', requires approved/rejected without a prior ack (decide it first; double ack is rejected).`,
      );
    }
  }

  /** 读取一行原始记录（wakeup_state 用于处置后判断是否触发了释放级联）。 */
  async getWakeupState(workspaceKey: string, entryId: string): Promise<OpsWakeupState> {
    await this.ensureReady();
    const row = this.getDatabase()
      .prepare("SELECT wakeup_state FROM ops_panel_entries WHERE workspace_key = ? AND id = ?")
      .get(workspaceKey, entryId) as { wakeup_state: OpsWakeupState } | undefined;
    return row?.wakeup_state ?? "none";
  }

  // ---- 进度账本（2026-11-25，specs/progress-ledger.md）----
  // 与面板工作项（ops_panel_entries）的本质区别：无状态机、无唤醒队列——master 原位
  // 维护（update/delete），账本只呈现有效记录（最终态）；删除为软删，读路径过滤。

  /** 进度列表（现存条目，rowid ASC = 插入序 = 时间正序）；软删行不可见。 */
  async listProgressEntries(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ProgressEntry[]> {
    await this.ensureReady();
    const workspaceKey = resolveWorkspaceKey(params);
    const rows = this.getDatabase()
      .prepare(
        "SELECT * FROM progress_entries WHERE workspace_key = ? AND deleted = 0 ORDER BY rowid ASC",
      )
      .all(workspaceKey) as unknown as ProgressEntryRow[];
    return rows.map(rowToProgressEntry);
  }

  /** 单读现存条目（软删/不存在返回 null）。 */
  async getProgressEntry(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    entryId: string;
  }): Promise<ProgressEntry | null> {
    await this.ensureReady();
    const workspaceKey = resolveWorkspaceKey(params);
    const row = this.getDatabase()
      .prepare("SELECT * FROM progress_entries WHERE workspace_key = ? AND id = ? AND deleted = 0")
      .get(workspaceKey, params.entryId) as unknown as ProgressEntryRow | undefined;
    return row === undefined ? null : rowToProgressEntry(row);
  }

  /**
   * 追加条目（编号在事务内分配：per workspace 递增不复用——MAX 扫全部行含软删，
   * 保证"软删不释放编号"）。DatabaseSync 事务属于整个连接：BEGIN 到提交之间不能 await。
   */
  async insertProgressEntry(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    title: string;
    body?: string;
    links?: string[];
    createdBy: ProgressCreatedBy;
    now?: number;
  }): Promise<ProgressEntry> {
    await this.ensureReady();
    const workspaceKey = resolveWorkspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    const now = params.now ?? Date.now();
    const db = this.getDatabase();
    let entry: ProgressEntry | null = null;
    db.exec("BEGIN IMMEDIATE");
    try {
      const seqRow = db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM progress_entries WHERE workspace_key = ?",
        )
        .get(workspaceKey) as { next: number };
      const seq = seqRow.next;
      const id = formatProgressEntryId(seq);
      db.prepare(
        `INSERT INTO progress_entries (
          workspace_key, id, seq, title, body, links, created_by, deleted, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(
        workspaceKey,
        id,
        seq,
        params.title,
        params.body ?? "",
        params.links === undefined || params.links.length === 0
          ? null
          : JSON.stringify(params.links),
        params.createdBy,
        now,
        now,
      );
      const row = db
        .prepare("SELECT * FROM progress_entries WHERE workspace_key = ? AND id = ?")
        .get(workspaceKey, id) as unknown as ProgressEntryRow;
      entry = rowToProgressEntry(row);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return entry;
  }

  /**
   * 系统锚条目幂等播种：存在性检查在事务内（同连接串行），并发首触不会重复播种；
   * 已存在返回 null。createdAtMs 尽量取项目真实创建时间（服务层解析）——锚的
   * createdAt 是账本时间线的诚实起点，不随首触时间漂移。
   */
  async ensureProgressAnchor(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    title: string;
    body: string;
    createdAtMs: number;
  }): Promise<ProgressEntry | null> {
    await this.ensureReady();
    const workspaceKey = resolveWorkspaceKey(params);
    const db = this.getDatabase();
    let entry: ProgressEntry | null = null;
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db
        .prepare(
          "SELECT 1 FROM progress_entries WHERE workspace_key = ? AND created_by = 'system' AND deleted = 0 LIMIT 1",
        )
        .get(workspaceKey);
      if (existing === undefined) {
        const seqRow = db
          .prepare(
            "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM progress_entries WHERE workspace_key = ?",
          )
          .get(workspaceKey) as { next: number };
        const id = formatProgressEntryId(seqRow.next);
        db.prepare(
          `INSERT INTO progress_entries (
            workspace_key, id, seq, title, body, links, created_by, deleted, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, NULL, 'system', 0, ?, ?)`,
        ).run(
          workspaceKey,
          id,
          seqRow.next,
          params.title,
          params.body,
          params.createdAtMs,
          params.createdAtMs,
        );
        const row = db
          .prepare("SELECT * FROM progress_entries WHERE workspace_key = ? AND id = ?")
          .get(workspaceKey, id) as unknown as ProgressEntryRow;
        entry = rowToProgressEntry(row);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return entry;
  }

  /**
   * 原位修改（只更显式传入字段；createdAt 不变，updatedAt 刷新）。body 传空串 =
   * 清空详情，links 传空数组 = 清空链接（COALESCE 只回退 null，空值语义直达）。
   * 目标必须现存：软删/不存在皆拒绝（变更数 0 抛错，与面板 dispose 同款纪律）。
   */
  updateProgressEntry(
    workspaceKey: string,
    entryId: string,
    params: { title?: string; body?: string; links?: string[]; now?: number },
  ): void {
    const now = params.now ?? Date.now();
    const result = this.getDatabase()
      .prepare(
        `UPDATE progress_entries
         SET title = COALESCE(?, title), body = COALESCE(?, body), links = COALESCE(?, links), updated_at = ?
         WHERE workspace_key = ? AND id = ? AND deleted = 0`,
      )
      .run(
        params.title ?? null,
        params.body ?? null,
        params.links === undefined ? null : JSON.stringify(params.links),
        now,
        workspaceKey,
        entryId,
      );
    if (Number(result.changes) === 0) {
      throw new Error(`Progress entry ${entryId} not found (or already deleted).`);
    }
  }

  /**
   * 软删（读路径过滤，UI 无痕；行保留作误删恢复安全网，不构成可查修订史）。
   * 编号不复用（MAX 扫全表含软删）；目标必须现存，重复删拒绝。
   */
  softDeleteProgressEntry(workspaceKey: string, entryId: string, options?: { now?: number }): void {
    const now = options?.now ?? Date.now();
    const result = this.getDatabase()
      .prepare(
        "UPDATE progress_entries SET deleted = 1, updated_at = ? WHERE workspace_key = ? AND id = ? AND deleted = 0",
      )
      .run(now, workspaceKey, entryId);
    if (Number(result.changes) === 0) {
      throw new Error(`Progress entry ${entryId} not found (or already deleted).`);
    }
  }
}

/** 迁移 SQL 的引用保持（供 db:schema:check 与单测核对冻结来源）。 */
export const OPS_PANEL_MIGRATION_SQL = OPS_PANEL_SCHEMA_SQL;
