# RobinRun 发布工程与自动更新（静态 feed 方案）

> 状态：2026-11-23 设计与实现落地（发布工程第一批）。本文档是 RobinRun 自有发布链的正身；
> 上游的服务端 manifest 方案见 `auto-update-service-manifest.md`（历史参考，RobinRun 不使用）。

## 背景

客户端自动更新机制完整继承上游（electron-updater + 自定义 `ManifestUpdateProvider` + 现成更新 UI
状态机），但装配层有两处不适用于 RobinRun：

1. 打包态更新源锁死为上游 SaaS 的 `GET https://zcode.z.ai/api/v1/releases/electron/manifest`——
   它返回的是 **ZCode 官方**的更新清单；RobinRun 开着它等于把 ZCode 安装包推给 RobinRun 用户。
2. 自动更新是构建期开关，默认关闭（`ROBINRUN_AUTO_UPDATE` 未注入时 fail-closed）。

RobinRun 的方案：**静态 manifest（latest\*.yml）+ GitHub Release 附件**，零后端服务：

```text
客户端启动/轮询
  → GET https://raw.githubusercontent.com/<owner>/<repo>/updates/<releasePlatform>/latest.yml
  ← version/files/sha512（files[].url 为绝对 URL）
  → 版本比较 → 从 Release 附件下载安装包（sha512 校验 + blockmap 差分）
  → 现成更新 UI（标题栏入口 + 独立更新窗口 + 进度/稍后）原样工作
```

- `latest*.yml` 只有几 KB，提交到主仓库 **updates 分支**（每平台一个目录）；
- 安装包/blockmap 作为 GitHub Release 附件（自带 CDN，单文件上限 2GB）；
- 检测请求只打 raw.githubusercontent.com（GitHub API 不参与，无 60/h 限流问题）。

## 客户端改动（2026-11-23 落地）

| 文件 | 改动 |
|---|---|
| `scripts/build-time-config.mjs` | 新增 `ROBINRUN_UPDATE_FEED_BASE`（静态 feed base）与 `ROBINRUN_MAC_AUTO_UPDATE`（mac 自动更新准入）两个构建期配置 → define |
| `packages/shared/src/env.ts` | 新增 `ROBINRUN_UPDATE_FEED_BASE`、`ROBINRUN_MAC_AUTO_UPDATE_READY` 常量（define 缺省时空/false，历史流程不受影响） |
| `packages/desktop/src/main/manifestUpdateProvider.ts` | 新增 `staticManifestBase` 选项：`buildElectronManifestUrl` 静态模式返回 `{base}/{releasePlatform}/latest.yml`（不带查询参数；`resolveStaticManifestBase` 保留路径段，不用会剥 pathname 的 `normalizeRobinRunEndpointOrigin`） |
| `packages/desktop/src/main/autoUpdater.ts` | `applyManifestUpdateProvider` 打包态读构建期 base 传入 `staticManifestBase`。origin 锁定守卫**原样保留**——静态模式根本不走 endpointOrigin，无需旁路；调试态 `--update-feed-url` 仍只在非打包态生效 |
| `packages/desktop/src/main/index.ts` | 启动门控追加：`!app.isPackaged \|\| darwin 之外 \|\| ROBINRUN_MAC_AUTO_UPDATE_READY`——未签名 mac 打包整体禁用自动更新（Squirrel.Mac 强制要求 Developer ID 签名，不关则用户点击安装必然失败）；开发态调试链路不受影响 |

信任模型：静态 base 与 `ROBINRUN_AUTO_UPDATE` 一样是**构建期钉死**的 define，随安装包发布，
运行期不可被启动参数/环境变量接管（`resolveUpdateFeedSourceFromStartupConfig` 在打包态照旧剥离
调试输入）。清单下载仍是 HTTPS + sha512 校验 + 签名校验链路不变。

## 发布流程（发布一个版本）

前置：仓库为公开（raw 与 Release 附件匿名可读）。

1. 确认 `packages/desktop/package.json` / 根 version 或以 tag 为准的构建元数据版本正确。
2. `git tag v0.x.y && git push origin v0.x.y` → 触发 `.github/workflows/release.yml`：
   - **build 矩阵**：`windows-latest`(win-x64)、`macos-latest`(mac-arm64)、`macos-15-intel`(mac-x64)、
     `ubuntu-latest`(linux-x64)；各跑 `pnpm bundle:desktop -- --os <os> --arch <arch>`。
     构建期 env：`ROBINRUN_AUTO_UPDATE=1`、`ROBINRUN_UPDATE_FEED_BASE=https://raw.githubusercontent.com/<repo>/updates`。
   - **release job**：收集产物 → `gh release create --generate-notes` 上传安装包 + blockmap +
     latest\*.yml（yml 带 artifact 目录前缀避免两台 mac 同名覆盖）→
     `scripts/release/rewrite-update-manifests.mjs` 把每平台清单改写为绝对 URL 并统一落位为
     `<releasePlatform>/latest.yml` → 推到 updates 分支。
3. 用户端已装旧版会在下个轮询窗口（15 分钟）或手动检查时看到更新提示。

平台目录命名 = 客户端 `getElectronReleasePlatform()`（`windows-x86_64` / `darwin-aarch64` /
`darwin-x86_64` / `linux-x86_64`），改名必须与代码同步。

### 自动更新启用矩阵（构建期 env）

| env | 作用 | 首版默认 |
|---|---|---|
| `ROBINRUN_AUTO_UPDATE=1` | 打开自动更新（不设 = fail-closed） | 设 |
| `ROBINRUN_UPDATE_FEED_BASE=<url>` | 静态 feed base（不设 = 上游 manifest API 模式，RobinRun 禁用） | 设 |
| `ROBINRUN_MAC_AUTO_UPDATE=1` | mac 自动更新准入（Squirrel.Mac 需 Developer ID 签名） | **不设**（未签名 mac 禁自动更新） |
| `ROBINRUN_ENABLE_MAC_SIGN=1` + `APPLE_SIGNING_IDENTITY`/`CSC_NAME` | mac 签名（公证走独立阶段） | 不设 |

首版签名状态与用户感知：mac 未签名 = Gatekeeper 需右键打开 + 新版本走"提示 + 手动下载"；
Windows 未签名 = SmartScreen"更多信息 → 仍要运行"，自动更新可用；Linux AppImage 自动更新可用，
deb/rpm 以手动下载为主（系统包更新需提权）。

### 测试闭环（不等 CI）

本地静态源演练：任意目录放 `<releasePlatform>/latest.yml`（绝对 URL 指向本地文件或任意 http 地址）
→ `python -m http.server`；dev 态 `pnpm dev:desktop` 后用
`--robinrun-update-feed-url http://127.0.0.1:8000/windows-x86_64/latest.yml`
（调试输入只在非打包态生效）把更新器指过去，把测试包版本调低一档即可完整走一遍检测 → 弹窗 →
下载 → 安装。`packages/desktop/dev-app-update.yml` 是 electron-updater dev 初始化的配套占位。

## 强制升级（最低可用版本）

启动前强更守卫（`forceUpdateGuard.ts`）与更新 feed 同源：打包态读 `updates` 分支根目录的
`min-version.json`，契约：

```json
{ "minimalVersion": "0.0.2", "downloadUrl": "https://github.com/<owner>/<repo>/releases/latest" }
```

- `minimalVersion` 缺省/空 = 不强制升级；文件 404 = 同样跳过（正常状态，不是故障）。
- `downloadUrl` 供"手动升级"按钮跳转；缺失时按钮不跳转。
- 发布流水线只在文件**不存在**时播种 `downloadUrl`（不覆盖人工策略值）；需要强制全量升级时
  人工改 `minimalVersion` 后直接提交到 updates 分支即可生效。
- 历史：2026-11-24 前守卫请求上游 SaaS 的 `/api/v1/client/configs`，会把 ZCode 的最低可用
  版本（v3.5.3）套在 RobinRun 头上（0.0.1 启动即被强更拦截）——该链路已整体退役；
  未配置 `ROBINRUN_UPDATE_FEED_BASE` 的构建整体跳过强更检查，绝不退回上游 API。

## 已知边界与后续

- **未验证项**：release.yml 全链路需首 tag 实测（尤其 fpm 产 rpm 在 runner 上的依赖、
  macos-15-intel 标签可用性、updates 分支首建路径）；Windows 未签名 NSIS 的差分更新
  （blockmap）首版实测后再下结论。
- **Gitee 加速（后置）**：同一架构把 updates 清单镜像到 Gitee 仓库（raw 形态
  `gitee.com/<user>/<repo>/raw/updates/<platform>/latest.yml`），安装包附件指 Gitee Release；
  需实测 Gitee 附件体积上限与未登录下载流控。客户端 feed base 是构建期常量，可打双 feed 包。
- **灰度/通道**：静态清单无 device_mid 灰度与 stable/preview 双通道；v1 单 stable 通道
  （客户端 channel 语义保留，preview 用户读同一份清单）。
- 首个 release 的 README/release notes 需写明：mac 右键打开步骤、deb/rpm 手动更新、
  脚本触发器三方库能力边界（见 `docs/trigger-python-runtime.md`）。
