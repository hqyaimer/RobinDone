# ops-panel — 模块契约（需求/审批/反馈面板）

## 不变量

1. **编号稳定**：条目编号 = 类型前缀 + 序号（`REQ-0001`），workspace 内按 kind 递增、分配后不复用；`formatOpsEntryId` / `parseOpsEntryKind` 是唯一编解码入口。
2. **作者词表**：`user` / `master` / `worker:<id>`。智能体侧作者一律由调用会话身份**机制层派生**（`opsAuthorForAgent`），模型传值不采信（同 ManageTriggers 归属派生纪律）。
3. **状态机最小集**（MVP）：REQ `submitted→in_progress→disposed(四选一 outcome)`；APP `pending_review→approved/rejected`（执行确认走 `acknowledgedAt`，不新增用户可见状态）；FBK `submitted→processed`。disposed 的 REQ 必带 outcome（schema refine 锁定）。
4. **队列状态与条目状态分离**：`wakeupState`（none/pending/in_flight/released）只描述串行唤醒队列，不进用户可见状态机；同 workspace 同一时刻至多一条 in_flight（服务层保证）。
5. **作者豁免语义不在本层实现**：本模块只提供词表；唤醒入队判定（author=master 不入队等）收口在 services 层 OpsPanelService。
6. **不依赖 trigger-system**：系统特权订阅（`OPS_PANEL_SYSTEM_TRIGGER_ID`）由引擎侧 ensureSystemSubscription 播种与保护；本模块仅提供常量与事件名（`OPS_PANEL_EVENT_BY_KIND`）。

## 消费面

- services/ops-panel：SQLite repo + 串行队列服务 + IOpsPanelService（UI 通道）
- robinrun-protocol：CLI↔Host 反向端口（opsPanel/\* 方法）
- robinrun-cli contracts/core：ManageOpsPanel 工具（master/worker 同名双变体）
- packages/ui/src/ops-panel：用户面板（主视图页）
