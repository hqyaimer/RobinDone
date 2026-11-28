/**
 * RobinRun→RobinDone 改名数据迁移 A2：项目工作区内品牌目录搬迁
 * （specs/rename-robindone-migration.md §3.4）。
 *
 * 各项目根下的 `.robinrun/`（触发器注册表、worker 编制与状态目录等）改名为 `.robindone/`。
 * 调用时序：host 库（tasks-index.sqlite）已就绪之后、initializeServices（触发器引擎扫描
 * 注册表）之前——此时项目清单可读，而引擎还没开始按新路径自建。
 *
 * 失败语义（与 A1 不同）：单项目失败软失败——log 后继续（项目根可能已删除/只读盘；
 * 引擎与 roster 对缺失注册表本就是自建空目录的常态容忍）。双目录并存按「不留」裁决删旧。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const logger = createServiceLogger("brand-project-dirs");

export interface BrandProjectDirsMigrationResult {
  migrated: number;
  staleRemoved: number;
  failed: number;
}

export function migrateBrandProjectDirs(tasksIndexPath: string): BrandProjectDirsMigrationResult {
  const result: BrandProjectDirsMigrationResult = { migrated: 0, staleRemoved: 0, failed: 0 };
  let db: DatabaseSync;
  try {
    // 只读打开：库刚由 prepareHostStorage 关闭（迁移全部应用），这里仅取项目根清单。
    db = new DatabaseSync(tasksIndexPath, { readOnly: true });
  } catch (error) {
    logger.warn("无法打开任务索引读取项目清单，跳过项目目录迁移", { error: String(error) });
    return result;
  }
  let roots: string[];
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT r.root_path AS rootPath FROM project_roots r
         JOIN projects p ON p.project_id = r.project_id AND p.deleted = 0
         WHERE p.host_id = 'local'`,
      )
      .all() as Array<{ rootPath: string | null }>;
    roots = rows.map((row) => row.rootPath).filter((p): p is string => Boolean(p));
  } catch (error) {
    // 表不存在（全新库）或 schema 尚不可读：无事可迁。
    logger.warn("项目清单查询失败，跳过项目目录迁移", { error: String(error) });
    return result;
  } finally {
    db.close();
  }
  for (const root of roots) {
    const newPath = join(root, ".robindone");
    const oldPath = join(root, ".robinrun");
    const newExists = existsSync(newPath);
    const oldExists = existsSync(oldPath);
    if (newExists && oldExists) {
      try {
        rmSync(oldPath, { recursive: true, force: true });
        result.staleRemoved++;
      } catch (error) {
        result.failed++;
        logger.warn("项目旧品牌目录删除失败（以新目录为准继续）", {
          root,
          error: String(error),
        });
      }
      continue;
    }
    if (!newExists && oldExists) {
      try {
        renameSync(oldPath, newPath);
        result.migrated++;
      } catch (error) {
        // 软失败：引擎在新路径自建空注册表，表现为该项目触发器需重建；不阻断启动。
        result.failed++;
        logger.warn("项目品牌目录搬迁失败，触发器/编制将按空目录自建", {
          root,
          error: String(error),
        });
      }
    }
  }
  if (result.migrated || result.staleRemoved || result.failed) {
    logger.info("项目品牌目录迁移完成", { ...result });
  }
  return result;
}
