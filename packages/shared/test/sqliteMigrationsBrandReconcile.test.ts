// 品牌改名 checksum 调和回归（2026-11-28，specs/rename-robindone-migration.md 事故追记）：
// 改名 sweep 曾改动冻结迁移 SQL 的品牌字面量（0006_default_workspace_tasks），三批账本状态
// 都必须正确处理——①0.0.3 旧账本（=回退后当前 checksum，直接匹配）；②0.0.4 新装账本
// （swept 文本 checksum，调和 + heal）；③真实定义漂移（垃圾 checksum，仍然拒绝）。
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MigrationChecksumError, sqliteMigrations } from "@robindone/shared/sqlite-migrations";

const SQL = `CREATE TABLE IF NOT EXISTS t (id integer);
INSERT INTO t VALUES ('*/.robinrun/workspace/default');`;
// 与 runner 内部 brandRenameVariant 同规则的四变体替换（测试独立实现，防实现互相遮蔽）。
function brandVariant(text: string): string {
  let out = text;
  for (const [from, to] of [
    ["RobinRun", "RobinDone"],
    ["Robinrun", "Robindone"],
    ["ROBINRUN", "ROBINDONE"],
    ["robinrun", "robindone"],
  ] as const)
    out = out.split(from).join(to);
  return out;
}
const sha = (text: string) => createHash("sha256").update(text.trim()).digest("hex");

const migration = {
  id: "0006_fixture",
  appVersion: "3.12.0",
  touchedTables: ["t"],
  sql: SQL,
};

function newDbWithLedger(ledgerChecksum: string | null): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE schema_migration (id text primary key, checksum text not null, app_version text, applied_at integer not null)",
  );
  if (ledgerChecksum)
    db.prepare(
      "INSERT INTO schema_migration (id, checksum, app_version, applied_at) VALUES ('0006_fixture', ?, '3.12.0', 1)",
    ).run(ledgerChecksum);
  return db;
}

function options(backupDir: string) {
  return {
    database: "fixture",
    journalTable: "schema_migration" as const,
    backupDirectories: [backupDir],
    now: () => 1,
  };
}

describe("sqliteMigrations brand-rename checksum reconciliation", () => {
  const dirs: string[] = [];
  function backupDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "brand-reconcile-"));
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("账本为品牌替换变体 checksum：调和通过并把账本 heal 到当前 checksum", async () => {
    const db = newDbWithLedger(sha(brandVariant(SQL)));
    const result = await sqliteMigrations.migrate(db, [migration], options(backupDir()));
    // 视为已应用：不重新执行
    expect(result.applied).toEqual([]);
    const row = db.prepare("SELECT checksum FROM schema_migration WHERE id='0006_fixture'").get() as {
      checksum: string;
    };
    expect(row.checksum).toBe(sha(SQL));
  });

  it("账本为当前 checksum：直接通过，账本不变", async () => {
    const db = newDbWithLedger(sha(SQL));
    const result = await sqliteMigrations.migrate(db, [migration], options(backupDir()));
    expect(result.applied).toEqual([]);
    const row = db.prepare("SELECT checksum FROM schema_migration WHERE id='0006_fixture'").get() as {
      checksum: string;
    };
    expect(row.checksum).toBe(sha(SQL));
  });

  it("垃圾 checksum（真实定义漂移）：仍然拒绝", async () => {
    const db = newDbWithLedger("deadbeef".repeat(8));
    await expect(
      sqliteMigrations.migrate(db, [migration], options(backupDir())),
    ).rejects.toThrow(MigrationChecksumError);
  });

  it("无账本行：正常应用（回归确认调和分支不影响全新初始化）", async () => {
    const db = newDbWithLedger(null);
    const result = await sqliteMigrations.migrate(db, [migration], options(backupDir()));
    expect(result.applied).toEqual(["0006_fixture"]);
    const row = db.prepare("SELECT checksum FROM schema_migration WHERE id='0006_fixture'").get() as {
      checksum: string;
    };
    expect(row.checksum).toBe(sha(SQL));
  });
});
