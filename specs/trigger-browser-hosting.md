# 触发器引擎托管浏览器与登录态档案（2026-11-25 裁决与设计正身）

> 状态：**本批实施**。取代 `docs/trigger-system.md`「浏览器与登录态档案」节的两处旧设计：
> ①"实例模型：浏览器实例由引擎创建并持有"的原则保留，实现细节以本文档为准；
> ②"档案建立：首次执行以有头模式启动、登录后引擎自动捕获"**已被 2026-11-25 登录闭环
> 裁决取代**（旧设计假设登录态一次性建立后长期有效；现实是登录态会过期，闭环必须可重复）。

## 1. 背景与裁决

脚本触发器 v1 由脚本自管 playwright（`install_packages(["playwright"])` + 自行下载浏览器 +
自管 storageState），这是 AGENTS.md「已知待改」明示的过渡态。痛点：登录态散落在各脚本的
临时目录（丢失/泄漏面）、无头/有头与并发引擎无感知、浏览器二进制重复下载。

**用户裁决（2026-11-25）**：

1. **引擎托管浏览器**：执行实例由 trigger-engine 创建并持有，脚本经 CDP endpoint 接入
   （env `ROBINRUN_CDP_ENDPOINT`），不自带 playwright 启动逻辑（脚本内仍可用
   `playwright` 库 `connect_over_cdp`）。
2. **登录闭环（取代旧"首次执行捕获"设计）**：登录态会过期，脚本编写时**必须自含登录检测**；
   检测失败 → 脚本调 `robinrun.login_failed(诊断)` → 引擎投递失败事件（带诊断）唤醒订阅者
   agent + 触发器自动转 `error-paused` + 停止脚本 → agent 唤醒后调 ManageTriggers 新 action
   `open_login` 以**有头**模式拉起浏览器（注入档案登录态），**用户登录完成关闭窗口视为
   登录完成**（引擎在登录期定期快照 storageState，关窗时落档）→ agent 再 `set_status`
   重新启用触发器。异常复现则再次唤醒——闭环。
3. **登录/观察面**：`open_login` 用**独立有头窗口**（不接内嵌浏览器——CDP 端口会暴露整个
   app，安全不可接受）；"实时观察脚本执行"的 screencast 面板**后置待办**（引擎执行实例的
   loopback CDP 上用 `Page.startScreencast` 只读旁观，本轮不做）。
4. **档案 = 凭据级**：storageState 文件按 AGENTS.md 凭据条款处理（加密落盘、不进日志/审计
   正文、不随项目导出）。
5. **同档案串行**（既有裁决不变）：同一 profile 同时至多一个执行实例，其余排队。

## 2. 架构

```text
~/.robinrun/runtimes/browsers/<id>/          # 托管 chromium 缓存（全局共享；@puppeteer/browsers 下载）
<workspace>/.robinrun/triggers/profiles/<name>.json   # storageState 档案（加密落盘，凭据级）
<workspace>/.robinrun/triggers/state/browser-runtime.json   # 可用性状态（引擎写，CLI 读）

脚本触发器（config.profile 声明档案）：
  startProcess → browserHost.acquire(profile)   # 档案级队列取号（同档案串行）
    → 注入登录态启动 chromium（--remote-debugging-port=0，headed 按 config.headed）
    → stderr 解析 ws endpoint → ROBINRUN_CDP_ENDPOINT 注入脚本 env
  脚本：playwright chromium.connect_over_cdp(endpoint) → 业务操作
  脚本退出 → browserHost.release → 快照最终 storageState 加密回写档案 → 关浏览器
```

纯 HTTP 抓取脚本（无 `profile`）不申请浏览器，零成本直跑——与现状一致。

## 3. 模块与数据面

### 3.1 供给：`trigger-engine/browser-runtime.ts`（镜像 python-runtime.ts 模式）

- `@puppeteer/browsers`（desktop 已有 2.13.0）下载钉死 buildId 的 chromium 到
  `~/.robinrun/runtimes/browsers/<id>/`；镜像 env `ROBINRUN_BROWSER_DOWNLOAD_BASEURL`
  （国内用 `https://cdn.npmmirror.com/binaries/chrome-for-testing`，路径布局与官方
  storage.googleapis.com/chrome-for-testing-public 一致）；失败回退系统 Chrome 探测
  （对齐 CLI adapters `executable.ts` 的探测顺序）。
  **下载可观测性与超时（2026-11-25 真机教训）**：downloadProgressCallback 每 ~16MB 打
  一条进度日志；**总超时 10 分钟**（install 无内置 timeout，慢源下载可无限悬挂——
  open_login 等 ensureBrowser，窗口永不弹出且日志死寂），超时/失败按回退收口并在日志
  附镜像 env 指引；失败后清理半截下载目录。
  **打包约束（2026-11-25 真机实锤）**：@puppeteer/browsers 内部动态 require("http")，
  内联进 host 的 ESM bundle 会报 `Dynamic require of "http" is not supported` → 下载
  永远失败静默回退系统 Chrome——必须留在 desktop tsup `desktopNodeRuntimeExternals`
  （同 node-forge/yauzl 先例）。
- 状态文件 `state/browser-runtime.json`：`{version, state: probing|available|unavailable,
executablePath?, source: managed|system, error?, updatedAt}`（schema 进 shared
  trigger-system，同 python-runtime.json 风格；ManageTriggers create/update 门控
  `profile` 字段按它执行——不可用时带 profile 创建被拒，引导 install_packages 自管过渡）。

### 3.2 实例托管：`trigger-engine/browser-host.ts` + CDP 数据面 `browser-cdp.ts`

- `acquire(workspacePath, profile, headed) → {ok, cdpEndpoint} | {ok:false, error}`：
  档案级 FIFO 队列（同 profile 串行）；有头/无头按调用参数（执行实例默认无头，
  `config.headed: true` 触发器级例外）。
- 启动：provisioned executable + `--user-data-dir=<tmp>`（独立目录保证隔离实例，不与
  日常 Chrome 进程交接）+ `--remote-debugging-port=0` + Windows 隐藏控制台（复用
  chromeLocalStorageManager 的 spawn+stderr 解析模式）；启动后注入档案 storageState
  （CDP 数据面：`context.addCookies` 立即生效 + `context.addInitScript` 按 origin 门控
  播种 localStorage——init script 是"脚本自己导航"形态下唯一可靠的 localStorage 注入位）；
  注入失败降级不阻塞启动（脚本自含登录检测兜底闭环）；档案不存在 = 全新登录态。
- `release(workspacePath, profile, handle)`：导出最终 storageState（加密回写档案）→ 关闭
  浏览器进程树（taskkill /T /F 同款）→ 出队下一个等待者。
- **CDP 数据面**（`browser-cdp.ts`，2026-11-25 真机补全——此前 exportStorageState 是
  返回 undefined 的占位、快照循环从未实现，登录闭环永远落不了档）：playwright-core
  `connectOverCDP` → 默认 context 的 `storageState()` 导出 / cookies+initScript 注入；
  services 以 devDependency 供类型、运行时动态 import，desktop tsup externals 保留
  playwright-core（体量大 + 内部 CJS require，不内联）。可注入假实现供测试。
- 登录会话：`openLoginSession(workspacePath, profile, {url?}) → Promise<LoginSessionResult>`——
  **有头**启动 + 注入现有档案（可 repairing）+ `url` 作为启动参数（窗口直接落在登录页，
  2026-11-25 增：此前落空白新标签页，用户不知道在哪登录）+ 登录期每 3s 快照保留最后
  好快照（半截登录态也不丢）+ **浏览器窗口被用户关闭即视为登录完成**（实时导出，
  失败用最后好快照兜底），落档返回 `{ok:true}`。**三路 settle 分开判定**（2026-11-25
  真机修复：exit 与超时曾共用 pending 标志，用户关窗必被误报 "timed out (10 min)"）：
  exit=关窗完成 / timeout（10min 兜底）=杀进程收口不落档 / disposed=引擎退出。
  脚本停止（stopping/dispose）同样经 release 回写。
- host 进程退出时 `dispose()` 全部实例（防孤儿 chromium）。

### 3.3 引擎接线（script-supervisor）

- `ScriptSupervisorCallbacks` 增 `acquireBrowser?` / `releaseBrowser?` / `resolveLoginProfilePath?`
  （engine.ts 从 browser-host 桥接，测试缺席 = 旧行为）。
- `startProcess`：`entry.config.profile` 在场且端口在场 → 先 acquire，失败按一次崩溃收口
  （信息进注册表 lastResult + 审计，退避重试）；成功 → `buildSpawnPlan` 注入
  `ROBINRUN_CDP_ENDPOINT` + `ROBINRUN_TRIGGER_PROFILE`（plan 已含 env，注入点在既有 env 组装后）。
- 停止/退出路径（initiateStop/handleExit/registerCrash/dispose）：有 browser handle 则 release
  （幂等，oneshot/resident 一致）。
- scheduled 模式同样适用（每趟 acquire → 跑 → release）。

### 3.4 登录闭环链路

- **桥接函数**：python `robinrun.login_failed(reason)` / node `robinrun.loginFailed(reason)`——
  POST `__robinrun/pause/<trg-id>`（新内部端点，`local-webhook-server.ts` 仿 emit 路由：
  无 token、按运行注册表路由、≤1MiB）。
- **引擎语义**（script-supervisor `handlePauseRequest`）：audit `{action:"login-failed",
reason}` → 投 `script-error` 事件（summary 带 reason，唤醒订阅者）→ 注册表 status 置
  `error-paused`（consecutiveFailures 不动——这不是崩溃是登录态过期）→ `notifyCircuitBreak`
  复用（params 加 `reason:"login-failed"`）→ initiateStop。
- **新 action `open_login`**（ManageTriggers 全链）：contracts action 枚举 + 输入
  `{action:"open_login", id, loginUrl?}`（2026-11-25 增 loginUrl：站点登录页 URL，窗口
  直接落在登录页——此前落空白新标签页是"没跳转"体验缺陷的根因；工具描述与失败指引
  双向引导必传）+ superRefine（id 必带，其余除 loginUrl 一律拒绝）→ handler 校验条目
  存在且 script 型且 profile 在场 → `trigger-runtime-port` 新方法 `openTriggerLogin` →
  engine `openLoginForEngine`（service 面）→ browserHost.openLoginSession → 结构化结果
  （成功：`{ok:true, profile, storageStatePath? 不透出}`；失败：`{ok:false, error}`）。
  结果文案指引："登录态已存档；用 set_status(id, active) 重新启用触发器"。

### 3.5 凭据安全（AGENTS.md 条款落地）

- 档案文件整文件加密：复用 `packages/services/src/credential/` 的 `CredentialCipherProvider`
  （OS 级密钥）+ `atomicWritePrivateTextFile` + `withFileLock`；engine 侧经回调访问
  （browser-host 不直接 import credential 模块内部——host 装配时注入 cipher 回调）。
- 不进日志/审计正文：审计只记档案名与动作，storageState 内容/路径不出现在任何 log/audit。
- 项目导出/打包路径确认排除 `profiles/`（既有约定，验收时复核）。

## 4. 提示词面（与批次三同五处 + README python 变体）

- README python 变体与 `buildScriptRuntimeSection` 增：声明 `profile` 即申请引擎托管浏览器
  （`ROBINRUN_CDP_ENDPOINT` 注入，`playwright.chromium.connect_over_cdp(endpoint)` 接入）；
  **脚本必须自含登录检测**（如关键请求 401/登录页跳转），失败时调
  `robinrun.login_failed("诊断摘要")` 后退出——引擎会停用触发器并唤醒你修复；
  `open_login` 拉起有头登录窗口（用户登录后关窗即存档），修复后 `set_status` 重新启用。
- 门控文案：browser runtime 不可用时 create/update 带 `profile` 拒绝，引导先
  `install_packages(["playwright"])` 自管过渡。

## 5. 验收场景

1. 无 `profile` 的脚本触发器：行为与现状完全一致（无浏览器注入）。
2. 带 `profile`：引擎自动下载 chromium（缓存复用）→ acquire → CDP env 注入 → 脚本
   connect_over_cdp 打开页面 → emit → 退出后 storageState 回写档案（加密）。
3. 同 profile 两个触发器同时 active：后者排队等前者释放（档案级串行）。
4. 脚本调 `login_failed("401")`：触发器转 error-paused + 订阅者收到 script-error（带诊断）
   - 应用内通知 + 脚本停止；audit 记 `{action:"login-failed"}`。
5. agent 调 `open_login`：有头窗口弹出（注入现有档案）→ 用户登录后关窗 → 结果 ok、档案更新
   → `set_status` 重新启用 → 下次运行无头复用登录态。
6. 档案不存在时 `open_login`：全新登录会话，关窗落档（首次建立）。
7. 引擎 dispose：全部 chromium 进程树被终止，无孤儿。
8. 门控：browser-runtime unavailable 时 create 带 profile 被拒（文案含自管过渡指引）。
9. 凭据：审计与日志全文 grep 不含 storageState 内容；档案文件非明文可读。

## 6. 明确不做（Out of scope）

- 内嵌浏览器作为脚本执行面（CDP 暴露整个 app，安全否决——2026-11-25 用户裁决）。
- screencast 观察面板（后置待办：执行实例 loopback CDP + `Page.startScreencast` 只读流）。
- 引擎侧 `PLAYWRIGHT_BROWSERS_PATH` 全局接管（脚本自管 playwright 仍可用自己的下载；
  托管实例二进制走 @puppeteer/browsers 独立缓存）。
- 多登录态档案并发去重/同档案并发数配置（v1 固定串行）。
- storageState 之外的凭据形态（cookie jar / keytar）；后续可迁独立凭据存储。
