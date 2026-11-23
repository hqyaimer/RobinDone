# 桌面构建期可选能力

## 目标

五项能力由构建期配置决定是否启用，未配置时一律关闭：

| 能力                 | 配置项                                                     | 关闭时的行为                                                      |
| -------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| ARMS RUM 上报        | `ROBINRUN_ARMS_RUM_ENDPOINT`                               | 主进程与渲染进程的 ARMS SDK 以 `enable: false` 初始化，不产生上报 |
| 事件上报（数仓）     | `ROBINRUN_TELEMETRY_REPORT_ENDPOINT`                       | 遥测事件在发送前直接返回                                          |
| 自动更新             | `ROBINRUN_AUTO_UPDATE`（`1`、`true`、`yes` 为启用）        | 与 Preview 形态相同，不检查、不下载更新                           |
| 静态更新源           | `ROBINRUN_UPDATE_FEED_BASE`（URL，见 robinrun-release-updates.md） | 更新器保持上游 manifest API 模式（RobinRun 发布构建必须显式设置静态 base，否则指向上游 SaaS） |
| macOS 自动更新准入   | `ROBINRUN_MAC_AUTO_UPDATE`（`1`、`true`、`yes` 为启用）    | 打包态 darwin 禁用自动更新（Squirrel.Mac 要求 Developer ID 签名；未签名 mac 新版本走手动下载） |

这样同一份源码可以产出"默认不上报、不自动更新"的构建，也可以产出启用这些能力的正式构建，
不需要在源码里写死上报地址。

> 勘误（2026-11-23）：配置项此前记录为 `ZCODE_*` 旧名，fork 全量改名后代码实际读
> `ROBINRUN_*`（见 `scripts/build-time-config.mjs`），本文档已按代码修正；后两项为
> RobinRun 发布工程新增（见 `docs/desktop/robinrun-release-updates.md`）。

## 配置来源与优先级

1. 构建进程的环境变量。显式设置为空字符串表示关闭。
2. `config/private/build-defaults.json`。只存在于内部仓库，开源导出不包含。
3. 以上都没有时关闭。

## 所有者与数据流

```
环境变量 / config/private/build-defaults.json
        │ scripts/build-time-config.mjs（唯一解析入口）
        ▼
desktop tsup（main、host、preload）与 desktop vite（renderer）的 define
        │ __ROBINRUN_ARMS_RUM_ENDPOINT__ / __ROBINRUN_TELEMETRY_REPORT_ENDPOINT__ / __ROBINRUN_AUTO_UPDATE_ENABLED__
        │ __ROBINRUN_UPDATE_FEED_BASE__ / __ROBINRUN_MAC_AUTO_UPDATE_READY__
        ▼
@robinrun/shared env 常量 ── 运行时代码只读这些常量
```

- 未注入 define 的环境（测试、其他 bundle）得到关闭值；vitest 为测试注入固定的事件上报端点，以便验证上报链路。
- 自动更新在 Desktop Main 启动时判定：`ROBINRUN_PRODUCT_FLAVOR === "production" && ROBINRUN_AUTO_UPDATE_ENABLED && (!app.isPackaged || 非 darwin || ROBINRUN_MAC_AUTO_UPDATE_READY)`。
- Agent 的 OTLP 遥测沿用既有机制，由打包环境的 `ROBINRUN_PACKAGED_AGENT_OTEL_*` 注入，不在本文件范围内。

## 验收

1. 内部仓库存在私有默认配置时，构建结果与改造前一致：ARMS、事件上报、自动更新均启用，地址不变。
2. 没有私有默认配置、也没有环境变量时，五项均关闭。
3. 环境变量优先于私有默认配置，显式空字符串可以关闭单项能力。
4. 未签名的 mac 打包（未设 `ROBINRUN_MAC_AUTO_UPDATE`）启动后更新菜单 fail-closed，无任何更新请求发出。
5. 类型检查、Lint 与相关单测通过。
