# RobinRun → RobinDone 改名与数据迁移（正身 spec）

> 状态：批 1（sweep）+ 批 2（数据迁移）已落地并验证（2026-11-27，台账见 docs/progress.md
> 第二十七批）；批 3（发布工程）部分准备就绪——v0.0.4 release notes 已预填，GitHub repo
> rename / updates 分支 / min-version 抬版 / tag 发版待用户执行；真机目验（验收场景 1/8）
> 待用户启动新版触发迁移后确认。批 3 完成前，涉及名称/路径/确定性 id 的改动仍以本文档为准。

## 0. 裁决记录（2026-11-27，与用户对齐）

> **裁决勘误（2026-11-27 晚，用户澄清）**：二次裁决的「不留」指的是 **AGENTS.md 等文档中不保留
> 旧名，原数据文件必须保留**——当日实现的「双目录并存删旧」分支属于理解错误，已按勘误修复：
> 任何情况下不删除数据，新目录改名让路（`.robindone.conflict-<ts>` 保留待人工甄别）、旧目录
> 迁移为权威。同日事故记录：dev 首启时无关进程（测试期子进程 + 主进程 crash 捕获的 import 期
> 建目录）抢先创建了 `.robindone` 占位，触发删旧分支删除了用户真实数据根（该数据为测试数据，
> 用户确认无需恢复；360 恢复件经验证为全零空壳）。修复三件：①删旧→改名让路（A1+A0）；
> ②迁移钩子提前至 `desktopEarlyDataBaseDirBootstrap`（import 期最早，先于 crash 捕获建目录）；
> ③vitest engineering 项目注入 `ROBINDONE_DATA_BASE_DIR`/`ROBINDONE_DESKTOP_HOME_DIR` 临时
> 目录隔离，测试拉起的子进程永不触碰真实数据根。

- **改名裁决**：产品更名 `RobinRun` → `RobinDone`（中文口号：知更鸟搞定了）。动机：
  "RobinRun" 名称已有在用网站，存在 SEO 压制与潜在商标摩擦；趁 v0.0.x 用户量极小、外链极少，
  现在是切换成本最低的窗口。每多发一个版本都会加重旧名在搜索引擎与外链中的存在感。
- **品牌资产不变**：知更鸟 logo / 吉祥物 / IP 故事原样保留，仅名称后缀变更。对外定位口径不变
  （通用型常驻自动化 Harness，见 AGENTS.md「对外定位 vs 内部起源」）。
- **版本衔接裁决**：v0.0.4 为首个 RobinDone 版本；存量 RobinRun 客户端（≤v0.0.3）经 GitHub
  repo rename 重定向 + min-version 强更拉到 v0.0.4，安装后首启执行本 spec 的数据迁移。
- **二次裁决（2026-11-27，用户对 §8 四项拍板：「要改就全改了，不留」；第 2 条当晚勘误，
  详见本节顶部裁决勘误）**：
  1. 三处上游账号链路参数（OAuth appId / 回调 scheme / 计费路径）**一并改净**为 robindone 值
     （推翻冻结建议；账号面仍隐藏中，功能无影响）；
  2. ~~迁移不留旧目录~~（**勘误**：「不留」仅指文档不含旧名，数据文件必须保留；双目录并存
     一律不删除、新目录改名让路）；
  3. **不做** python 薄别名模块，旧脚本 API（`robinrun.emit` 等）直接断裂；
  4. AGENTS.md / progress.md 历史正文**全文替换**为新名（用户显式推翻「追加为主」对本次的适用）。

## 1. 范围分层总表

| 层           | 内容                                                                                                                                                                   | 处理方式                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| A 代码标识符 | 包名 `@robinrun/*`、目录 `apps/robinrun-cli`、`robinrun-agent/`、`robinrun-protocol(-v4)/`、env 前缀 `ROBINRUN_*`、类型/变量名                                         | 全量机械 sweep（改名扫描 + 手工复核），编译绿为门槛                  |
| B 产品身份   | productName（含 Dev/Preview 变体）、`desktop-product-identity.mjs`、安装器身份、GitHub repo、release.yml、updates 分支、min-version.json、app-update.yml publisherName | sweep + 发布工程专项（§6）                                           |
| C 数据持久化 | 数据根 `~/.robinrun`、项目内 `.robinrun/`、Electron userData、确定性 id 前缀、`robinrun-artifact://` URI、插件 id                                                      | **数据迁移设计（本 spec 核心，§3）**                                 |
| D 对外契约   | deep link / 脚本 API `robinrun.emit`、`robinrun.login_failed`、用户可见 env（`ROBINRUN_PYTHON_RUNTIME_MIRROR` 等）                                                     | 断裂声明 + release notes（§5）                                       |
| E 文档       | AGENTS.md、progress.md、正身 docs/specs、`.agents/skills/`、dev-docs、release-notes                                                                                    | 随 sweep 更新；AGENTS.md/progress.md 为本地 gitignore 文件，手工同步 |

## 2. 不改名清单（豁免，sweep 时必须跳过）

- `wkr-<8hex>` worker id —— 中立词表，与品牌无关（AGENTS.md P2.6 裁决）。
- `trigger:<id>` / `trigger-group:<gid>` 会话 key —— 中立 id。
- 触发器本地 webhook 端口 43110。
- 上游 CDN/endpoint URL 值 —— 既有总原则「上游 URL 值有意保留」。
- `.zcode-plugin/` zip manifest 目录别名兼容 —— 既有裁决（P3 第十九批）。
- `packages/services/src/zcode-agent/` 目录名 —— 既有裁决「改名前的目录名，勿再改」。
- CLI 临时目录前缀（`robinrun-bash-` 等）—— 非持久化，随 sweep 改成 robindone 值即可，无迁移语义。
- （2026-11-27 二次裁决：三处上游账号链路参数移出豁免清单，随 sweep 改净，见 §0。）

## 3. 数据迁移设计

### 3.0 状态所有者与总体时序

| 迁移                         | 状态所有者                    | 幂等判据                          |
| ---------------------------- | ----------------------------- | --------------------------------- |
| A0 userData/sessionData 搬迁 | 目录存在性                    | 新路径存在 → skip                 |
| A1 数据根搬迁                | 目录存在性                    | 新数据根存在 → skip               |
| B 迁移 0011 前缀改写         | `tasks_schema_migration` 账本 | 迁移已应用 → skip（框架保证）     |
| A2 项目工作区目录搬迁        | 逐项目目录存在性              | 项目根下 `.robindone` 存在 → skip |

```
main 启动（desktop）
├─ A0 userData/sessionData 搬迁守卫（app.setName 之后、任何文件 IO 之前）
├─ A1 数据根搬迁 ~/.robinrun → ~/.robindone（createHostDatabaseStartup 之前）
├─ prepareHostStorage（tasks-index.sqlite）
│   ├─ 迁移链 0001…0010（既有，不动）
│   └─ 0011_brand_prefix_rename（新增，§3.2）
├─ prepareSessionStorage（各项目会话库；只验证无 robinrun- 前缀，不改写）
├─ A2 逐项目工作区 .robinrun/ → .robindone/（initializeServices 之前）
└─ initializeServices（触发器引擎扫描新路径，workers.json 自举读新路径）
```

时序安全论证：0011 在 `TaskIndexRepo.initialize` 的启动对账**之前**执行（迁移链先于对账，
见 `session/tasksDatabase/migrations.ts` 0007 注释的既有教训），因此 0011 改写完成后，
共享层派生函数（已换新前缀）的自举 `INSERT OR IGNORE` 必然命中已改写行，不会产生重复组。
数据根搬迁（A1）先于 `getTasksIndexDatabasePath()` 的任何解析使用——搬迁函数必须在这些
路径首次被调用前执行完毕（实现为 main 入口最早期的显式调用，禁止依赖模块加载顺序）。

### 3.1 挂点 A1：数据根搬迁

- **实现**：services 层导出单一幂等函数（建议名 `migrateBrandDataRoot()`，与
  `getRobinRunDataRootDir` 同文件收口于 `packages/services/src/paths.ts`），desktop main 与
  CLI 启动入口都调用（防止独立 CLI 启动时找不到目录而静默自建空数据根，造成数据分裂）。
- **规则**（作用于 `getDataBaseDir()` 解析结果）：
  1. 新数据根（`<base>/.robindone`）存在 → skip（已迁移或全新安装）；
  2. 旧数据根（`<base>/.robinrun`）存在且新不存在 → `rename`（同盘原子操作）；
     rename 失败 → **硬失败，中止启动**并呈现错误（数据不能出现双份分裂）；
  3. 两者都不存在 → 全新安装，skip。
- **双目录并存场景**（无关进程抢先创建新目录占位，或用户回滚旧版跑过一段时间再升级）：
  **任何情况下不删除**（⚠️ 2026-11-27 裁决勘误，取代本节早先的「以新为准删旧」——见 §0；
  当日删旧分支曾因占位场景误删用户真实数据根）。处理：新目录改名让路
  （`.robindone.conflict-<ts>`，保留原盘待人工甄别），旧目录（改名前的事实权威）迁移为权威
  （`conflict-old-restored`）；让路失败（目录被占用）→ 硬失败中止启动。
- **回滚语义**：迁移后回滚到旧版（≤v0.0.3），旧代码找 `~/.robinrun` 不存在 →
  当作全新安装自建空目录。数据不丢但不可见，属预期行为，写入 release notes。
- **legacy env 兼容**：`ROBINRUN_DATA_BASE_DIR` 改名 `ROBINDONE_DATA_BASE_DIR` 后，若用户
  曾设置旧 env（罕见），新代码读不到会回退 homedir 而看不见旧数据。过渡处理：迁移函数读旧
  env 名（仅此一个 env 做只读回退：旧名有值且新名无值 → 采用旧值），并 log deprecation。
- **覆盖 `ROBINRUN_DESKTOP_HOME_DIR` 的场景**（e2e/远控）：home 覆盖指向的目录下的
  `.robinrun` 同样按上述规则搬迁，无需特判（函数作用于解析后的 base dir，天然覆盖）。

### 3.2 挂点 B：迁移 0011 前缀改写

- **注册**：`session/tasksDatabase/migrations.ts` `definitions` 追加
  `0011_brand_prefix_rename`（编号顺延，checksumInput 冻结，沿用「迁移 SQL 是历史事实、
  只增不改」规约，参照 v6/v7/v8 惯例文件放在 `task-groups/migration-v11.ts` 或独立
  `brand-rename-v11.ts`）。
- **改写范围**（静态盘点，实现时以 grep 复核后勾验）：

  | 表.列                                  | 旧值模式                                     | 新值                                                                     |
  | -------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------ |
  | `task_groups.group_id`                 | `robinrun-main-agent-<projectId>`            | `robindone-main-agent-<projectId>`                                       |
  | `task_groups.group_id`                 | `robinrun-worker-<workerId>`                 | `robindone-worker-<workerId>`                                            |
  | `task_groups.group_id`                 | `robinrun-default-group-cron`（常量 id）     | `robindone-default-group-cron`                                           |
  | `task_groups.group_id`                 | `robinrun-default-group-off-peak`（常量 id） | `robindone-default-group-off-peak`                                       |
  | `task_group_members.group_id`          | 上述全部                                     | 对应新值（外键引用同步）                                                 |
  | `task_group_view_node_orders` 节点 key | group 型 key 即 groupId                      | 对应新值（task 型 key 是 `JSON([workspaceKey,taskId])`，不含前缀，不动） |
  | `task_group_admissions`                | 若含 group_id 引用则同步                     | 实现时验证                                                               |

- **改写方式**：纯 SQL `UPDATE ... WHERE group_id LIKE 'robinrun-%'` + 前缀拼接替换，天然幂等
  （改写后不再命中）；在同一迁移事务内执行，失败由迁移框架回滚并走 backup 恢复路径。
- **共享层同步**：`packages/shared/src/robinrun-task-types.ts` 的
  `MAIN_AGENT_GROUP_PREFIX` / `WORKER_GROUP_PREFIX` / `CRON_DEFAULT_GROUP_ID` /
  `OFF_PEAK_DEFAULT_GROUP_ID` 及派生函数（`mainAgentGroupId` / `workerGroupId` /
  `isMainAgentGroupId` / `isWorkerGroupId`）换新值。旧前缀常量**不保留**（读路径无需双认：
  0011 已改写全部存量；迁移先于一切消费方执行）。
- **会话库（prepareSessionStorage）**：静态盘点未发现 robinrun- 前缀确定性 id；实现时加一条
  验证（grep session DB schema/写入路径），若发现仅记录不改写（会话内容文件不做 SQL 迁移，
  见 §3.3 的读兼容策略）。

### 3.3 存量引用读兼容（不迁数据，读路径双认）

- **`robinrun-artifact://` URI**（session 文件内持久化）：sweep 后新写入
  `robindone-artifact://`；读路径加 normalize 函数双认两种 scheme（session 文件是 JSON 存储，
  不走 sqlite 迁移链，改写文件违背「数据根搬迁 = 纯 rename」的简单性，读兼容代价最小）。
- **插件 id `robinrun-cua@robinrun-plugins-official`**：官方市场规范 id sweep 为
  `robindone-plugins-official`；既有「受信任刷新处旧名归一化」机制把 `robinrun-plugins-official`
  也列入旧名别名（与 `zcode-plugins-official` 同机制叠加），已装插件状态无需迁移。
- **browser descriptor `provider: "robinrun-cli"`**：随 sweep 改 `robindone-cli`；存量 session
  metadata 中的旧值仅作展示来源标注，容错即可，不迁移。

### 3.4 挂点 A2：项目工作区目录搬迁

- **实现**：prepare 序列内、`prepareSessionStorage` 之后 `initializeServices` 之前执行；
  数据来源为 host 库 `projects`/`project_roots`（此时已就绪），对每个未删除项目的每个根目录：
  1. `<root>/.robindone` 存在 → skip；
  2. `<root>/.robinrun` 存在 → rename；
  3. 失败（目录不可写/已删除/权限）→ **软失败**：log warn + 继续（单项目失败不阻断启动；
     触发器引擎与 worker roster 对缺失注册表本就是「自建空目录」的常态容忍）。
- **路径收口**：项目内品牌目录拼接收口到单一 helper（建议
  `getProjectBrandDataDir(workspacePath)`，services 层），改造以下散落点后统一走 helper——
  避免 sweep 后仍有硬编码 join 漏网：
  - `trigger-engine/engine.ts`（注册表根）、`python-env.ts`（venv/包清单）、
    `browser-runtime.ts`（触发器浏览器运行时状态）、`browser-host.ts`
  - worker roster：`<workspace>/.robinrun/agents/`（workers.json + `<id>/` 状态目录，
    正身 `docs/worker-roster.md`）
- **A2 失败的后果边界**：rename 失败的项目会在新路径自建空注册表，表现为该项目触发器
  「消失」。MVP 先 log；后续可接通知中心提示（后置，不阻断本 spec）。

### 3.5 挂点 A0：Electron userData / sessionData

- **依据**：`desktopRuntimeEnv.ts` 中 `runtimeUserDataPath = env 覆盖 ?? join(appData,
runtimeApplicationName)`——userData 跟随应用名派生，productName 改名必然搬家（含
  `RobinRun Dev` / `RobinRun Preview` 变体）。
- **规则**：与 A1 同构的幂等 rename 守卫（新存在 → skip；旧存在 → rename；双目录并存 →
  按裁决勘误不删除、新目录改名让路；其余失败 → 硬失败中止启动——userData 含窗口状态与
  内嵌浏览器站点权限，双份分裂同样有害），作用于 userData 与 sessionData
  （`<userData>/session`）两目录；`ROBINDONE_DESKTOP_USER_DATA_DIR` /
  `ROBINDONE_DESKTOP_SESSION_DATA_DIR` 显式覆盖场景同样适用（作用于解析后的目标路径）。
- userData 内的品牌命名文件（如 `robinrun-data-size-telemetry.json`）随 sweep 改名；
  存量旧名文件丢一帧遥测计数，可接受，不做迁移。

## 4. 对外契约断裂清单（D 层，写入 v0.0.4 release notes）

| 项        | 旧                                                                                            | 新                                          | 影响                       | 缓解                                                               |
| --------- | --------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------- | ------------------------------------------------------------------ |
| 脚本 API  | `robinrun.emit` / `robinrun.login_failed`（python 触发器脚本）                                | `robindone.emit` / `robindone.login_failed` | 用户已写脚本 ImportError   | 无兼容别名（2026-11-27 裁决「不留」），release notes 明示          |
| env 前缀  | `ROBINRUN_PYTHON_RUNTIME_MIRROR`、`ROBINRUN_ENABLE_WINDOWS_SIGN`、`ROBINRUN_DATA_BASE_DIR` 等 | `ROBINDONE_*`                               | CI/用户脚本需改名          | release notes 对照表；`ROBINRUN_DATA_BASE_DIR` 见 §3.1 legacy 回退 |
| deep link | `robinrun://`（OAuth 回调）                                                                   | `robindone://`（随 sweep，二次裁决改净）    | 旧注册表项随旧版本卸载消失 | 新安装器重注册                                                     |
| 回滚      | v0.0.4 → ≤v0.0.3                                                                              | —                                           | 旧版视数据为不存在（不丢） | release notes 明示                                                 |
| 更新源    | repo rename 后 raw.githubusercontent.com 重定向                                               | —                                           | 存量客户端 feed 依赖重定向 | 发版前实测（§6）                                                   |

## 5. 发布工程衔接（B 层）

1. **GitHub repo rename**：`hqyaimer/RobinRun` → `hqyaimer/RobinDone`；旧链接（issue/PR/
   Release 附件/raw）由 GitHub 自动重定向；本地 remote URL 同步更新。
   ⚠️ 实现时**实测** raw.githubusercontent.com 在 repo rename 后的重定向有效性（存量
   v0.0.1–v0.0.3 客户端的 app-update.yml feed 指向旧 raw URL，强更链路依赖它拉到新 manifest）。
2. **updates 分支 / min-version.json**：manifest 字段随 sweep（应用名/下载 URL 指向新 Release
   附件）；`min-version` 抬到 0.0.4，把存量全部强更到首个 RobinDone 版本。
3. **release.yml / desktop-product-identity.mjs / 安装器身份**：随 sweep；Windows 签名仍未采购，
   `ROBINRUN_ENABLE_WINDOWS_SIGN`（改名后）保持关闭不变。
4. **release notes**：`docs/release-notes/v0.0.4.md` 按 P3 第二十六批体系预填，必含 §4 断裂清单。

## 6. 实施拆批建议

- **批 1（代码 sweep）**：A/E 层全量改名 + 豁免清单守护 + `architecture:check` / typecheck /
  lint 回绿 + 持久化标识符同步（§3.2 共享层常量、§3.3 读兼容）。此批落地后**运行行为与数据
  兼容性暂破**（旧数据根/旧 id 尚无迁移），不切版本。
- **批 2（数据迁移）**：A0/A1/A2 三挂点 + 0011 迁移 + 单测（旧库 fixture → 0011 → 断言四表
  前缀改写与成员引用完整；A1/A2 幂等分支用例）。
- **批 3（发布工程）**：§5 全项 + v0.0.4 发版 + 真机目验（§7）。
- 批 1/2 可合并实施（同一 PR 内无法保证中间态可用），批 3 独立。

## 7. 验收场景

1. **存量升级**：v0.0.3 有数据的机器装 v0.0.4 → 首启加载屏出现迁移进度（0011）→ 项目列表、
   智能体树、主智能体组与 worker 组投影、触发器、会话历史、设置全部保留。
2. **全新安装**：无任何迁移动作，直接可用。
3. **幂等**：二次/多次启动，A0/A1/A2/0011 全部 skip，无重复组、无重复搬迁。
4. **回滚**：v0.0.4 → v0.0.3，旧版当作新装运行（预期行为，数据仍在 `.robindone`）。
5. **触发器链路**：迁移后 scheduled 与常驻脚本正常 fire；带登录态档案的脚本正常复用
   （`.robindone/triggers/state/` 路径生效）。
6. **python 运行时缓存**：搬迁后零下载（`~/.robindone/runtimes/python/<id>` 命中 bundled→缓存链）。
7. **CLI 共存**：desktop 迁移后独立 CLI 启动 → 读到新数据根，不产生第二个数据根。
8. **强更桥接**：v0.0.3 客户端经 repo rename 重定向拉到 v0.0.4 manifest → 差分下载 →
   「重启以更新」→ 首启迁移（验收场景 1 全程）。

## 8. 裁决项（2026-11-27 已全部拍板）

用户原话：「要改就全改了，不留。」四项均按最彻底方案执行，详见 §0 二次裁决：
①账号链路参数改净；②旧目录删除不留；③不做 python 兼容别名；④AGENTS.md/progress.md
历史正文全文替换。本节保留作为裁决记录，不再有悬置事项。

## 9. 验收后的文档义务

- progress.md 追加「P3 第二十七批：RobinDone 改名与数据迁移」一节；
- AGENTS.md 概要更新（项目定位首行、数据根/env/deep link 描述、正身索引指向本 spec）；
- 本 spec 标注实现落地状态与批次。
