/**
 * RobinRun→RobinDone 改名数据迁移 A1：数据根目录搬迁（specs/rename-robindone-migration.md §3.1）。
 *
 * RobinRun 时代数据根是 `<base>/.robinrun`，改名后为 `<base>/.robindone`。本函数在 desktop main
 * 与独立 CLI 启动的最早时点调用（先于一切数据路径解析消费），规则：
 * 1. 新数据根存在 → 已迁移/全新安装，skip（settled/fresh）；
 * 2. 旧存在且新不存在 → 原子 rename（同盘），旧路径自然消失（migrated）；
 * 3. 双目录并存 → **任何情况下都不删除**（2026-11-27 裁决勘误：「不留」仅指文档不含旧名，
 *    数据文件必须保留；当日事故：无关进程抢先创建新目录占位后，删旧分支把用户真实数据根
 *    删掉了）。处理：把「新」改名让路（`.robindone.conflict-<ts>`，保留待人工甄别），再把
 *    「旧」迁移为权威（conflict-old-restored）。
 *
 * 放在 shared/node：desktop 主进程与 CLI 包（不依赖 services）都要调用同一实现，防漂移。
 * 只用 node:fs 同步 API——启动最早时点，尚未进入任何异步服务生命周期。
 */
import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const BRAND_DATA_DIR_NAME = ".robindone";
export const LEGACY_BRAND_DATA_DIR_NAME = ".robinrun";

/** RobinRun 时代的 base dir 覆盖 env 名（2026-11-27 改名前的用户可见变量）。 */
const LEGACY_DATA_BASE_DIR_ENV = "ROBINRUN_DATA_BASE_DIR";
const DATA_BASE_DIR_ENV = "ROBINDONE_DATA_BASE_DIR";

export type BrandDataRootMigrationStatus =
  | "fresh"
  | "migrated"
  | "settled"
  | "conflict-old-restored";

export interface BrandDataRootMigrationResult {
  status: BrandDataRootMigrationStatus;
  /** 迁移后的生效 base dir（供调用方同步自身模块级缓存，见 desktop main 的 setDataBaseDir）。 */
  baseDir: string;
  /** 是否采纳了 legacy env（true 时调用方必须把它写入新 env/setDataBaseDir，否则路径分叉）。 */
  legacyEnvAdopted: boolean;
  /** conflict-old-restored 时：被让路的原「新」目录（含时间戳），保留待人工甄别。 */
  asideRoot?: string;
}

export function migrateBrandDataRoot(
  env: NodeJS.ProcessEnv = process.env,
): BrandDataRootMigrationResult {
  const newEnv = env[DATA_BASE_DIR_ENV]?.trim() || null;
  const legacyEnv = env[LEGACY_DATA_BASE_DIR_ENV]?.trim() || null;
  let baseDir = newEnv ?? legacyEnv ?? (env.HOME?.trim() || homedir());
  let legacyEnvAdopted = false;
  if (!newEnv && legacyEnv) {
    // legacy env 兼容：老用户设过 ROBINRUN_DATA_BASE_DIR。改写为新 env 名，让本进程后续
    // 派生路径与子进程继承（services/paths.ts 的模块级 env 捕获发生在更早的 import 时，
    // desktop main 调用方随后用 setDataBaseDir 同步那一层缓存）。
    legacyEnvAdopted = true;
    baseDir = legacyEnv;
    if (env === process.env) process.env[DATA_BASE_DIR_ENV] = legacyEnv;
  }
  const newRoot = join(baseDir, BRAND_DATA_DIR_NAME);
  const oldRoot = join(baseDir, LEGACY_BRAND_DATA_DIR_NAME);
  const newExists = existsSync(newRoot);
  const oldExists = existsSync(oldRoot);
  if (newExists && oldExists) {
    // 双目录并存：新目录可能是无关进程抢先创建的空壳，也可能是回滚窗口期旧版本重建的目录，
    // 无法机器判定谁权威——**一律不删除**，新目录改名让路（保留原盘待人工甄别），旧目录
    // （改名前的事实权威）迁移为权威。若让路 rename 失败（如被进程占用），旧目录保持原样、
    // 抛错硬失败——绝不在归属不明时删任何一方。
    const asideRoot = `${newRoot}.conflict-${Date.now()}`;
    renameSync(newRoot, asideRoot);
    try {
      renameSync(oldRoot, newRoot);
    } catch (error) {
      // 极端失败（同盘 rename 几乎不会发生）：把让路目录先还原，保持原状再抛错。
      renameSync(asideRoot, newRoot);
      throw error;
    }
    return { status: "conflict-old-restored", baseDir, legacyEnvAdopted, asideRoot };
  }
  if (!newExists && oldExists) {
    renameSync(oldRoot, newRoot);
    return { status: "migrated", baseDir, legacyEnvAdopted };
  }
  return { status: newExists ? "settled" : "fresh", baseDir, legacyEnvAdopted };
}
