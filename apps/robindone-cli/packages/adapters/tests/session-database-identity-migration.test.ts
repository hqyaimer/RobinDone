import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  runSqliteSessionMigrations,
  runSqliteSessionMigrationsAsync,
  type SqliteMigrationProgress,
} from "../src/storage/session-store/migration-runner.js";
import {
  SESSION_DATABASE_IDENTITY_MIGRATION,
  runSessionDatabaseIdentityMigration,
} from "@robindone/shared/sqlite-migrations";
import { SQLITE_MIGRATIONS } from "../src/storage/session-store/migrations.js";

it.each(["source-first", "agent-first"])(
  "%s：两端共用同一 checksum，结构接管不生成业务代际",
  async (order) => {
    const db = new DatabaseSync(":memory:");
    try {
      const agent = () => runSqliteSessionMigrations(db, ":memory:");
      const source = () => runSessionDatabaseIdentityMigration(db);
      await (order === "source-first" ? source : agent)();
      const initial = db
        .prepare("SELECT * FROM schema_migration WHERE id='0024_session_database_identity'")
        .get();
      await (order === "source-first" ? agent : source)();
      expect(
        db
          .prepare("SELECT * FROM schema_migration WHERE id='0024_session_database_identity'")
          .get(),
      ).toEqual(initial);
      expect(db.prepare("SELECT * FROM robindone_database_identity").all()).toEqual([]);
      // 账本必须恰好是整条链（曾手工写死 24，链加入 0025/0026 后未同步而长期假红）。
      expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migration").get()?.n).toBe(
        SQLITE_MIGRATIONS.length,
      );
    } finally {
      db.close();
    }
  },
);

it("Source 记账失败回滚新表，Agent 与 Source 都拒绝已有 checksum 损坏", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE schema_migration (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, app_version TEXT, time_applied INTEGER NOT NULL);
      CREATE TRIGGER reject_identity BEFORE INSERT ON schema_migration
      WHEN NEW.id='0024_session_database_identity'
      BEGIN SELECT RAISE(ABORT, 'injected identity ledger failure'); END;`);
    expect(() => runSessionDatabaseIdentityMigration(db)).toThrow(
      "injected identity ledger failure",
    );
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='robindone_database_identity'").get(),
    ).toBeUndefined();
    expect(db.prepare("SELECT * FROM schema_migration").all()).toEqual([]);
    db.exec("DROP TRIGGER reject_identity");
    runSessionDatabaseIdentityMigration(db);
    db.exec("UPDATE schema_migration SET checksum='broken'");
    expect(() => runSessionDatabaseIdentityMigration(db)).toThrow(/checksum mismatch/);
    await expect(runSqliteSessionMigrations(db, ":memory:")).rejects.toThrow(/checksum mismatch/);
    // Agent 更早的迁移也在同一事务内回滚，损坏记录不会被覆盖。
    expect(db.prepare("SELECT id, checksum FROM schema_migration").all()).toEqual([
      { id: "0024_session_database_identity", checksum: "broken" },
    ]);
  } finally {
    db.close();
  }
});

it("Agent 正式迁移接管已有 Source identity，不覆盖代际且重复打开不改账本", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE robindone_database_identity (scope TEXT PRIMARY KEY, identity TEXT NOT NULL);
      INSERT INTO robindone_database_identity VALUES ('session', 'existing-generation')`);
    await runSqliteSessionMigrations(db, ":memory:");
    expect(
      db.prepare("SELECT id FROM schema_migration WHERE id='0024_session_database_identity'").get(),
    ).toEqual({
      id: "0024_session_database_identity",
    });
    const ledger = db.prepare("SELECT * FROM schema_migration ORDER BY id").all();
    await runSqliteSessionMigrations(db, ":memory:");
    expect(db.prepare("SELECT * FROM schema_migration ORDER BY id").all()).toEqual(ledger);
    expect(db.prepare("SELECT identity FROM robindone_database_identity").get()).toEqual({
      identity: "existing-generation",
    });
  } finally {
    db.close();
  }
});

it("Agent/Source 共用应用原语，identity SQL 成功但记账失败时保留真实执行数量", async () => {
  const db = new DatabaseSync(":memory:");
  const states: SqliteMigrationProgress[] = [];
  try {
    await expect(
      runSqliteSessionMigrationsAsync(db, ":memory:", {
        onProgress: async (state) => {
          states.push(state);
          if (
            state.phase === "migrating" &&
            state.migrationId === "0024_session_database_identity"
          ) {
            db.exec(`CREATE TRIGGER reject_identity BEFORE INSERT ON schema_migration
              WHEN NEW.id='0024_session_database_identity'
              BEGIN SELECT RAISE(ABORT, 'injected identity ledger failure'); END;`);
          }
        },
      }),
    ).rejects.toMatchObject({ kind: "sql_failed", migrationId: "0024_session_database_identity" });
    expect(states.at(-1)).toMatchObject({
      phase: "failed",
      migration: { kind: "initialize", executedCount: 24, committedCount: 0 },
    });
    expect(db.isTransaction).toBe(false);
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='robindone_database_identity'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migration'").get(),
    ).toBeUndefined();
  } finally {
    db.close();
  }
});

// RobinDone(2026-11-28) 改名调和回归（specs/rename-robindone-migration.md 事故追记）：
// 0024 的冻结 SQL 在改名 sweep 中被换成新表名，RobinRun 时代（≤v0.0.3）账本记的是 sweep 前
// 文本 checksum——真机曾因此卡死在 preparing_session_storage（预检 checksum_mismatch）。
// 锁定整链行为：预检放行 → 事务内 migrate() 把账本 heal 到当前文本 → identity 数据原样保留。
it("RobinRun 时代旧账本（0024 为 sweep 前文本 checksum）：整链通过并 heal，identity 保留", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    // 模拟 ≤v0.0.3：0024 以 sweep 前文本（旧表名）应用并记账，identity 已有代际值。
    const legacySql = SESSION_DATABASE_IDENTITY_MIGRATION.sql
      .split("robindone_database_identity")
      .join("robinrun_database_identity");
    const legacyChecksum = createHash("sha256").update(legacySql.trim()).digest("hex");
    db.exec(
      "CREATE TABLE schema_migration (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, app_version TEXT, time_applied INTEGER NOT NULL)",
    );
    db.prepare(
      "INSERT INTO schema_migration (id, checksum, app_version, time_applied) VALUES ('0024_session_database_identity', ?, '0.16.9', 1)",
    ).run(legacyChecksum);
    db.exec(
      "CREATE TABLE robinrun_database_identity (scope TEXT PRIMARY KEY, identity TEXT NOT NULL)",
    );
    db.prepare("INSERT INTO robinrun_database_identity VALUES ('session', 'legacy-generation')").run();

    await runSqliteSessionMigrations(db, ":memory:");

    // 预检容忍旧文本变体，事务内 heal 到当前 checksum；其余 23 条迁移正常补齐。
    expect(
      db.prepare("SELECT checksum FROM schema_migration WHERE id='0024_session_database_identity'").get(),
    ).toEqual({
      checksum: createHash("sha256")
        .update(SESSION_DATABASE_IDENTITY_MIGRATION.sql.trim())
        .digest("hex"),
    });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM schema_migration").get() as { n: number }).n,
    ).toBe(SQLITE_MIGRATIONS.length);
    // 链式迁移只调和账本不动表；identity 数据原样保留（表名收敛由接管入口负责）。
    expect(db.prepare("SELECT identity FROM robinrun_database_identity").all()).toEqual([
      { identity: "legacy-generation" },
    ]);
  } finally {
    db.close();
  }
});
