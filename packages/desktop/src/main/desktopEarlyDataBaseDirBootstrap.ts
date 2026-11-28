import { applyEarlyDataBaseDirBootstrap } from "./desktopDataBaseDirBootstrap.js";
import { setDataBaseDir } from "@robindone/services/node";
import { migrateBrandDataRoot } from "@robindone/shared/node";

/**
 * RobinRun→RobinDone 改名迁移 A1（specs/rename-robindone-migration.md §3.1）。
 * 必须先于本模块的 settings 读取与后续 crash/logger 等一切数据根写入执行——
 * 2026-11-27 事故：迁移钩子原挂在 main 主体（晚于 crash 捕获的 import 期建目录），
 * 无关进程/本进程提前创建的 `.robindone` 占位会让迁移误判双目录并存，配合当时的
 * 删旧分支曾把用户真实数据根删掉（裁决勘误后删旧已改为改名让路，但时序仍须最早）。
 * legacy env（ROBINRUN_DATA_BASE_DIR）采纳时同步 services 模块级缓存，与
 * desktopDataBaseDirBootstrap 的 setDataBaseDir 注入同机制。
 */
export const brandDataRootMigrationResult = migrateBrandDataRoot();
if (brandDataRootMigrationResult.legacyEnvAdopted) {
  setDataBaseDir(brandDataRootMigrationResult.baseDir);
}

applyEarlyDataBaseDirBootstrap();
