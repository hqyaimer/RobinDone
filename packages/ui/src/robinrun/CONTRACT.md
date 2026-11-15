# robinrun-launcher

RobinRun 的项目注册表（`AppSettings.robinrunProjects`）与零项目首建页（RobinRunLauncher）。

2026-11-15 去启动台裁决：正常冷启动由 Root 的"自动打开最近项目"effect 直接落到主界面，
本模块的启动台只在注册表为零项目（或候选目录全部失效）时作为首次创建项目的入口出现。

不变量：

- 注册表只服务启动编排（最近使用语义），不是项目权威数据；权威项目树在 Host 侧
  （projectService.readTree），两者不互相推导、不互相同步。
- 注册表写路径幂等：按 path upsert（`upsertRobinrunProjectEntry`），任何打开入口
  （首建页/深链/Dock/侧栏项目列表经 handleSelectProject）都统一 bump `lastOpenedAt`。
- 注册表写入失败只记日志，不阻断打开流程（最近使用语义允许丢失一次 bump）。

与其它模块的交集：

- `ui`（root 编排 hooks）：`useRootPlatformEffects` 冷启动按 `lastOpenedAt` 自动打开最近项目，
  目录失效条目用 fileService 校验后跳过；`useRootWorkspaceActions.handleSelectProject`
  在项目接纳成功后统一维护注册表。
- `project-sidebar`：侧栏项目列表的行点击经 `ProjectSidebarProps.onOpenProject` 走同一
  `handleSelectProject` 链路，不直接读写注册表。
