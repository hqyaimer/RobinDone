# auto-session-default-mode

自动创建的会话（触发器投递、ContactAgent 派发、cron 兜底、off-peak 等宿主路径）不经过 UI 草稿，`createTask` 的 `mode` 缺席时此前直接落 CLI 缺省 build——用户在任意会话显式选择的全局权限（P3 第六批裁决「全局统一继承」）只存在于渲染进程 localStorage，宿主读不到（实测反馈：master 设了完全访问，自动新建的 worker/触发器会话仍是"变更前确认"）。本模块是任务门面（`robindoneTaskServiceAdapter.createTask`）在 mode 缺席时的**单点缺省解析**。

不变量：

- 解析链与 UI 草稿链对齐（去掉 Recent 层）：项目确认过完全访问（`robindoneProjects[].fullAccessConfirmedAt` 按工作区根路径匹配）→ `yolo`；否则全局显式选择 `edit`/`guarded` 照用；否则 `undefined` = CLI 缺省 build。
- **yolo 门控（2026-11-22 用户裁决）**：全局选了完全访问但本项目从未确认过风险提示时，自动会话不得静默升级到完全访问——确认弹窗只在 UI 手动切档时出现，项目未确认即无背书。
- `build` 与缺席解析为 `undefined`，保持「无显式 mode」语义（CLI 缺省同为 build）；`plan` 不在值域（UI 写入侧已归一 build，设置 zod 校验兜底）。
- 只解析，不写入：显式传入的 `mode`（cron 配置、调用方指定）与 UI 手建会话（草稿总带显式 mode）不经过本解析；设置读取失败按缺省处理，不阻断会话创建。
- 全局模式的事实源是 `AppSettings.globalComposerMode`（2026-11-22 由 P3 第六批的 localStorage 键升格，UI 改档双写两处）；本模块只读该设置，不感知 localStorage。
