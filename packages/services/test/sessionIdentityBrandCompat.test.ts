// 0024_session_database_identity 改名兼容回归（2026-11-28，specs/rename-robindone-migration.md 事故追记）：
// 0024 的冻结 SQL 在改名 sweep 中把 identity 表换成新表名，RobinRun 时代（≤v0.0.3）库里建的还是
// 旧表名 robinrun_database_identity。锁定三件事：
// ①接管入口把旧表 RENAME 收敛到新名（identity 数据原样保留、幂等、不重铸代际）；
// ②只读快路径容忍 sweep 前文本 checksum（与 runner.ts 调和同规，账本 heal 归 Agent 链）；
// ③收敛前直接读取双认旧表名，不误判「无代际」而重铸 randomUUID。
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  SESSION_DATABASE_IDENTITY_MIGRATION,
  runSessionDatabaseIdentityMigration,
} from "@robindone/shared/sqlite-migrations";
import { readSessionDatabaseIdentity } from "#src/session/sourceServerWorkspaceAliasRepo.js";

const sha = (text: string) => createHash("sha256").update(text.trim()).digest("hex");
// sweep 前发布文本（测试独立反推，防实现互相遮蔽）。
const legacySql = SESSION_DATABASE_IDENTITY_MIGRATION.sql
  .split("robindone_database_identity")
  .join("robinrun_database_identity");

function newDb() {
  return new DatabaseSync(":memory:");
}

function seedLegacyIdentityTable(db: DatabaseSync, identity: string): void {
  db.exec(
    "CREATE TABLE robinrun_database_identity (scope TEXT PRIMARY KEY, identity TEXT NOT NULL)",
  );
  db.prepare("INSERT INTO robinrun_database_identity (scope, identity) VALUES ('session', ?)").run(
    identity,
  );
}

describe("session database identity brand compat", () => {
  it("接管入口把 RobinRun 时代旧表 RENAME 收敛到新名，identity 原样保留且幂等", () => {
    const db = newDb();
    try {
      seedLegacyIdentityTable(db, "legacy-generation");
      runSessionDatabaseIdentityMigration(db);
      expect(
        db.prepare("SELECT 1 FROM sqlite_master WHERE name='robinrun_database_identity'").get(),
      ).toBeUndefined();
      expect(db.prepare("SELECT identity FROM robindone_database_identity").get()).toEqual({
        identity: "legacy-generation",
      });
      const ledger = db.prepare("SELECT * FROM schema_migration WHERE id='0024_session_database_identity'").get();
      expect(ledger).toMatchObject({ checksum: sha(SESSION_DATABASE_IDENTITY_MIGRATION.sql) });
      // 幂等：重复接管不改账本、不重铸代际。
      runSessionDatabaseIdentityMigration(db);
      expect(
        db.prepare("SELECT * FROM schema_migration WHERE id='0024_session_database_identity'").get(),
      ).toEqual(ledger);
      expect(db.prepare("SELECT identity FROM robindone_database_identity").get()).toEqual({
        identity: "legacy-generation",
      });
    } finally {
      db.close();
    }
  });

  it("只读快路径容忍 sweep 前文本 checksum（不重执行、不写账本，heal 归 Agent 链）", () => {
    const db = newDb();
    try {
      db.exec(
        "CREATE TABLE schema_migration (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, app_version TEXT, time_applied INTEGER NOT NULL)",
      );
      db.prepare(
        "INSERT INTO schema_migration (id, checksum, app_version, time_applied) VALUES ('0024_session_database_identity', ?, '0.16.9', 1)",
      ).run(sha(legacySql));
      seedLegacyIdentityTable(db, "legacy-generation");
      runSessionDatabaseIdentityMigration(db);
      // 账本保持原样（此入口只读；heal 由 runSqliteSessionMigrations 的 migrate() 在事务内完成）。
      expect(
        db.prepare("SELECT checksum FROM schema_migration WHERE id='0024_session_database_identity'").get(),
      ).toMatchObject({ checksum: sha(legacySql) });
      expect(db.prepare("SELECT identity FROM robindone_database_identity").get()).toEqual({
        identity: "legacy-generation",
      });
    } finally {
      db.close();
    }
  });

  it("垃圾 checksum（真实定义漂移）仍拒绝", () => {
    const db = newDb();
    try {
      db.exec(
        "CREATE TABLE schema_migration (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, app_version TEXT, time_applied INTEGER NOT NULL)",
      );
      db.prepare(
        "INSERT INTO schema_migration (id, checksum, app_version, time_applied) VALUES ('0024_session_database_identity', ?, '0.16.9', 1)",
      ).run("deadbeef".repeat(8));
      expect(() => runSessionDatabaseIdentityMigration(db)).toThrow(/checksum mismatch/);
    } finally {
      db.close();
    }
  });

  it("收敛前直接读取双认旧表名；新旧并存时以新表为准（首版 v0.0.4 分裂态）", () => {
    const db = newDb();
    try {
      seedLegacyIdentityTable(db, "legacy-generation");
      expect(readSessionDatabaseIdentity(db)).toBe("legacy-generation");
      db.exec(
        "CREATE TABLE robindone_database_identity (scope TEXT PRIMARY KEY, identity TEXT NOT NULL)",
      );
      db.prepare("INSERT INTO robindone_database_identity (scope, identity) VALUES ('session', ?)").run(
        "swept-era-generation",
      );
      expect(readSessionDatabaseIdentity(db)).toBe("swept-era-generation");
    } finally {
      db.close();
    }
  });

  it("全新库：接管建新名空表，读取返回 null（回归确认不误伤全新初始化）", () => {
    const db = newDb();
    try {
      runSessionDatabaseIdentityMigration(db);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM robindone_database_identity").get(),
      ).toMatchObject({ n: 0 });
      expect(readSessionDatabaseIdentity(db)).toBeNull();
    } finally {
      db.close();
    }
  });
});
