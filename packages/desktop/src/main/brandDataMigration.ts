/**
 * RobinRun→RobinDone 改名数据迁移 A0：Electron userData/sessionData 搬迁
 * （specs/rename-robindone-migration.md §3.5）。
 *
 * runtimeUserDataPath = join(appData, runtimeApplicationName)（desktopRuntimeEnv.ts）——userData
 * 跟随应用名派生，productName 改名必然换址。规则与 A1 同构：新在→skip；旧在→rename；
 * 双目录并存→**不删除**，新目录改名让路后迁移旧目录（2026-11-27 裁决勘误：数据一律保留，
 * 事故教训见 shared/brand-data-root-migration.ts）。e2e 显式隔离模式（Chromedriver 临时
 * userData）不调用本函数。
 */
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

export type BrandUserDataMigrationStatus = "fresh" | "migrated" | "settled" | "conflict-old-restored";

export interface BrandUserDataMigrationResult {
  status: BrandUserDataMigrationStatus;
  /** conflict-old-restored 时：被让路的原「新」目录（含时间戳），保留待人工甄别。 */
  asideDir?: string;
}

export function migrateBrandElectronUserData(
  appDataDir: string,
  currentAppName: string,
): BrandUserDataMigrationResult {
  // 旧名只按 1:1 后缀映射（RobinDone Dev ← RobinRun Dev、RobinDone Preview ← RobinRun Preview），
  // 避免把用户另装的发行版 userData 误当本变体残留。非 RobinDone 命名（e2e 自定义名）无旧名对应。
  if (!currentAppName.includes("RobinDone")) return { status: "fresh" };
  const legacyName = currentAppName.replace("RobinDone", "RobinRun");
  const currentDir = join(appDataDir, currentAppName);
  const legacyDir = join(appDataDir, legacyName);
  const currentExists = existsSync(currentDir);
  const legacyExists = existsSync(legacyDir);
  if (currentExists && legacyExists) {
    // 双目录并存：归属不明不删除——新目录改名让路，旧目录迁移为权威（同 A1，见 shared 模块注释）。
    const asideDir = `${currentDir}.conflict-${Date.now()}`;
    renameSync(currentDir, asideDir);
    try {
      renameSync(legacyDir, currentDir);
    } catch (error) {
      renameSync(asideDir, currentDir);
      throw error;
    }
    return { status: "conflict-old-restored", asideDir };
  }
  if (!currentExists && legacyExists) {
    // sessionData（<userData>/session）随父目录一并搬走，无需单独处理。
    renameSync(legacyDir, currentDir);
    return { status: "migrated" };
  }
  return { status: currentExists ? "settled" : "fresh" };
}
