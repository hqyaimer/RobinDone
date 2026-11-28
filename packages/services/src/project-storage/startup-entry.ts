export { prepareTasksIndexStorage } from "#src/project-storage/startup.js";
// RobinRun→RobinDone 改名迁移 A2（specs/rename-robindone-migration.md §3.4）：与 tasks-index
// 项目清单同域，host 启动序列在库就绪后、服务初始化前调用。
export { migrateBrandProjectDirs } from "#src/project-storage/brand-project-dirs.js";
export { markTasksStoragePrepared } from "#src/session/tasksDatabase/prepared.js";
export { getTasksIndexDatabasePath } from "#src/paths.js";
export { resolveDefaultRobinDoneAgentCommand } from "#src/robindone-agent/robindoneAgentProcessManager.js";
export { resolveRobinDoneAgentSpawnCwd } from "#src/robindone-agent/robindoneAgentSpawnCwd.js";

export { createSettingService } from "#src/setting/settingService.js";
