# 项目进度账本（运营面板·进度 tab）— 需求说明（Spec）

- 日期：2026-11-25
- 作者：项目总管（产品职能）
- 状态：**范围已由用户确认，spec 评审中（通过后进入开发）**（设计讨论同日三轮收敛：先只做进度，不做泛化"记忆管理框架"）
- 关联：`specs/requirements-approval-feedback-panel.md`（面板宿主；工具/协议/存储/广播基建全部复用）、`docs/task-checklist.md`（定位区分）

---

## 1. 背景与定位

运营面板（需求/审批/反馈）增设第一 tab **"进度"**：一个**追加式项目里程碑台账**，从上往下按时间正序记录——顶部是项目初始化，底部是最新进度，新进度持续向下追加。

目的：让用户直观看到项目的每一步变动与进展；让 master 追溯完整历史过程、形成整体认知。进度由 **master 独立维护，不需要任何人工编写**。

三条定位边界（2026-11-25 设计讨论裁决，防走形）：

| 区分 | 进度账本 | 对照物 |
| ---- | -------- | ------ |
| vs 任务清单 | **面向过去的不可变事实**（发生了什么） | 清单是面向未来的可变状态（要做什么）；写入者、可变性、粒度三维全不同，不合并 |
| vs 知识库 | **时间线事实**：条目短（一行标题 + 展开详情） | 知识文件承载深度（怎么做/为什么）；`links` 字段是桥——深度一律进被链接文件，账本不得退化为堆料场 |
| vs 面板事件面 | **master 的叙事**：静态、无事件 | REQ/APP/FBK 是工作项状态机 + 唤醒事件面；worker 反馈是 worker 的发声通道，进度**有意不给** worker——它是 master 对项目的叙事 |

另一个有意取舍（2026-11-25 用户裁决）：进度账本**不是审计账本**——允许原位修改与删除，账本只呈现**有效记录（最终态）**，服务"直观摸清项目脉络"；审计与过程追溯由会话历史、REQ/APP/FBK 工作项、触发器审计日志、状态文件承担，不在这里重复建设。

## 2. 对象与数据模型（概念级，不指定实现）

- `id`：编号 `PRG-0001`（类型前缀 + 4 位零填充序号，per workspace 递增不复用，与 REQ/APP/FBK 同风格）
- `title`：里程碑标题（一行，必填）
- `body`：详情（可空；保持短——深度进被链接文件）
- `links`：关联文件路径数组（≤8 条；workspace 相对路径优先）——与知识经验库的融合点，UI 可点击打开
- `createdBy`：`master` | `system`（系统锚条目，见 §3）
- `createdAt` / `updatedAt`

**无状态机**：进度条目是事件事实不是工作项——没有状态流转、没有处置动作。这与 REQ/APP/FBK 的本质区别，也是"不做泛化框架"的落点：不进面板 kind 判别体系，独立词汇表、独立表。

存储：`tasks-index.sqlite` 新表 `progress_entries`（迁移 0010），`workspace_key` 隔离，删除为软删（`deleted` 标记，读路径过滤，UI 无痕）；排序沿用面板排序契约（rowid = 插入序 = 时间正序）。

## 3. 写入语义（本功能的核心）

- **master 独占，双层强制**：工具面仅 master 变体暴露进度动作（worker 变体不含）；服务面按 actor 机制层校验（`workerIdentity` 判据派生 actor、不采信模型传值，服务层 assert master）——与面板既有 `assertMasterActor` 同款纪律。
- **用户不可写**（2026-11-25 用户裁决"不需要任何人工编写"）：UI 无任何写入口，纯只读。
- **原位维护制（2026-11-25 用户裁决，取代早稿"纯追加修正制"）**：提供 update/delete——写错 → `update_progress` 原位改（`createdAt` 不变，`updatedAt` 自动）；无效或"不再需要被感知"的条目 → `delete_progress` 删除（软删：库内保留行、读路径过滤，UI 无任何痕迹，编号不复用）。账本只呈现**有效记录（最终态）**——"之前说、之后变了"这类过程反复不进账本，对"直观摸清脉络"没有贡献。软删而非硬删的理由：对齐触发器伪删除先例，LLM 写入者误删可恢复，且不给 UI 增加任何噪声。
- **系统锚条目**：每个 workspace 首次触达进度（UI 读取或 master 追加）时幂等播种 `项目初始化`（`createdBy=system`，占首号 `PRG-0001`；`createdAt` 尽量取项目真实创建时间，取不到回退首触时间）——"最顶部是项目初始化"字面成立，且不依赖 master 自觉。锚条目 master **可编辑**（充实标题/正文）、**不可删除**（服务层拒绝——否则幂等播种会复活，删除语义被破坏）。
- **粒度纪律**（工具描述承载；prompt 引导是粒度控制的主防线）：只记**已成事实的最终态**——阶段完成、方向调整、重大决策落地、重大风险出现、重要外部事件；不记计划、过程反复、单条任务、单次动作（那些属于任务清单与 REQ/APP/FBK）。master 的职责说明（init 流程 / 角色文件）同步补充此职责。

## 4. 事件与唤醒语义

**无事件面**。进度是被动叙事：不产生事件、不进订阅、不唤醒、不通知——用户想看时打开面板，是拉不是推。`append_progress` 仅广播 `state:ops-panel` 供 UI 即时刷新（复用现有广播通道，不新增）。

## 5. 权限矩阵

| 动作 | 用户（UI） | master（工具） | worker（工具） |
| ---- | ---------- | -------------- | -------------- |
| 读进度 | ✅（进度 tab） | ✅ `list_progress` | ❌（MVP 不开放） |
| 追加/修改/删除进度 | ❌ | ✅ `append_progress` / `update_progress` / `delete_progress` | ❌ |

worker 不读不写：worker 的完成汇报走 ContactAgent → master 落账；worker 直写会把粒度打碎成噪声，"不分太细"就守不住了。

## 6. UI（进度 tab）

- 页签置首（进度 / 需求 / 审批 / 反馈），**默认选中进度**；页签计数徽标沿用
- 时间正序列表（顶=初始化，底=最新）：行 = 日期 + 标题；点击行内展开：body、links（逐条可点击 → 右栏 code-viewer 打开文件预览，走既有 openCodeViewer 链路）、编号与记录者（system 条目带系统角标）。**无任何编辑/删除痕迹标记**——账本只呈现最终态
- **自动定位最新**：打开 tab / 新数据到达时自动滚到底部；滚动离底时浮出"回到最新"按钮——否则列表变长后"直观看到当前进度"失效
- 刷新三路合并沿用：挂载拉取 + `state:ops-panel` 广播 + 30s 轮询兜底
- 读取失败显式呈现（2026-11-24 面板实测教训沿用）：失败与空列表不可混淆
- 刻意朴素：无筛选/搜索/分组/导出；行样式沿用面板现有单行+展开模式，不做视觉打磨

## 7. 工具面（ManageOpsPanel 扩展）

- master 变体新增动作：`append_progress`（title 必填；body / links 可选）、`update_progress`（entryId + title / body / links）、`delete_progress`（entryId；系统锚被拒）、`list_progress`（返回现存条目正序，不含已删）；worker 变体与 worker 输入 schema **不含**进度动作
- 工具描述承载：粒度纪律（只记有效最终态）、update/delete 的自纠用法（写错就改、无效就删）、"先 list 再操作防重复/误删"提示
- master 职责钩子（可靠性靠流程不靠自觉）：init 流程与 master 角色文件补充"维护进度账本"职责说明（具体文案实现时定）
- 动作命名与 ManageOpsPanel 既有动作风格对齐，细节开发可调

## 8. MVP 验收标准

1. 打开面板进度 tab：出现系统锚条目"项目初始化"（系统角标），位于列表顶部；既有项目首次打开同样补锚
2. master 调 `append_progress` → 进度 tab 即时出现新条目（广播刷新），时间正序、追加到底部
3. `append_progress` 带 links → 展开详情里链接可点击，右栏打开文件预览
4. master `update_progress` → 条目原位更新，列表顺序不变，UI 无编辑标记
5. master `delete_progress` → 条目从列表消失且重启后不复活；对系统锚条目 delete 被服务层拒绝
6. worker 会话调用进度动作被拒（工具变体不暴露；直连服务亦被服务层拒绝）
7. 用户 UI 无写入口（面板对进度纯只读）
8. 重启软件后进度数据不丢（SQLite 持久）
9. 打开 tab 自动定位到最新条目；滚动离底出现"回到最新"，点击回底

## 9. 非目标（本轮明确不做）

- 编辑痕迹与修订历史展示（update/delete 原位生效，无角标无标记；软删仅为误删恢复安全网，不构成可查修订史）
- 导出快照（markdown 等）、统计视图
- 阶段分组、标签、筛选、搜索
- 唤醒/通知/订阅（进度不是事件源）
- worker 读取与写入
- 图片等富媒体附件（links 仅文件路径）
- **泛化"台账/记忆框架"**（2026-11-25 用户裁决：不做 kind 判别体系、不做通用记录服务；将来真实第二用例〔如动作台账〕出现时按需另行裁决。背景：人才市场规划要求 agent 能力态以文件为载体，进度账本是项目运行态、不随 agent 导出——两者不同维度互不约束）

## 10. 实现落点（供开发；实现面已探明）

- **shared 词汇表**：`packages/shared/src/ops-panel/progress.ts`（新文件：PRG 编号规则、progressEntrySchema / progressViewSchema、links 词表），经 `ops-panel/index.ts` 导出——不进 entries.ts 的 kind 判别体系
- **协议**：`packages/shared/src/robinrun-protocol/index.ts` 新增 `opsPanel/appendProgress`、`opsPanel/getProgressView` 方法名与 params/result schema
- **迁移**：`packages/services/src/ops-panel/migration-v10.ts`（冻结 SQL，`progress_entries` 表，含幂等播种所需的索引）+ `session/tasksDatabase/migrations.ts` definitions 追加 `0010_progress_entries`
- **服务**：`IOpsPanelService`（contract.ts）+ `OpsPanelService` 新增 `appendProgress` / `getProgressView`（不触碰 REQ/APP/FBK 状态机与唤醒队列）；锚条目播种在 ensure 链路内幂等完成，项目真实 createdAt 经窄端口解析（node.ts 已有 readTree 匹配 rootPath 先例）
- **工具链**：contracts `manage-ops-panel.ts`（master 动作集/输入 schema 扩展）→ core handler → `ops-panel.port.ts` 两方法 → bootstrap 协议端口 → `robinrunAgentService.ts` 分派 → `node.ts` opsPanelExecutor 两分支
- **UI**：`OpsPanelPage.tsx`（页签置首 + 进度列表分支 + 滚动定位/回到最新）、`useOpsPanelView.ts`（进度数据 + 三路刷新复用）、i18n 两语言、test-ids 沿用/按需新增；文件打开走既有 openCodeViewer 链路；既有 e2e 若断言面板页签结构需同步修订

## 11. 留给开发与用户直接沟通的事项

- 编号前缀 `PRG`、默认选中进度 tab、锚条目文案——已按建议值落 spec，用户可否决
- links 指向 workspace 外路径（绝对路径）时：MVP 直接尝试打开，失败按既有错误呈现，不做路径白名单
