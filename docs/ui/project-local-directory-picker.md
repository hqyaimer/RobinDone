# 本地项目源文件夹选择（单选收口）

## 行为与归属（2026-11-26 修订，取代 2026-09-15 多选版）

产品裁决：项目只允许绑定一个源文件夹，项目名称在未手改时自动跟随所选文件夹名。桌面创建/编辑本地项目的「选择文件夹/更换文件夹」使用操作系统原生目录选择框，**单选**：Electron main 使用 `openDirectory`、`createDirectory`（不再带 `multiSelections`，走既有 `IPlatformService.selectDirectory(): Promise<string | null>`），取消返回 null。`selectDirectories` 多选平台接口保留但 ProjectEditor 不再调用（远端/Web/手机不受影响）。

ProjectEditor 仍是名称、roots、primary 的唯一草稿 owner；选择结果**整体替换** roots 为所选单目录（与远端单根策略同规），primary 恒为该根。名称自动填充只在 UI 草稿层：用户未手输过名称（或仍停留在上一次自动填充值）时，名称框跟随 `getPathLeaf(所选目录)`；手改过则不覆盖，保存时按既有 `nameEdited` 语义显式提交。预填充不置 nameEdited，未改名保存仍由服务端 `basename(roots[0])` 兜底，所见即所得。选择操作不创建项目、不打开 workspace 或启动 Agent，仅显式保存才调用 `saveProject`。

存储与协议保持多根能力（legacy 多根项目照常读取/展示，moveTask 缺根追加不变，创建仍允许 0 根）；单选只是 UI 入口策略。正身记录见 `packages/services/src/project-storage/CONTRACT.md` 2026-11-26 节。

```text
桌面 + 本地 Host → 平台 selectDirectory（单选）→ preload IPC → main 原生选择
                                                        ↓ 路径 / null
                                               ProjectEditor 草稿（替换 roots + 名称自动填充）
                                                        ↓ 显式保存
                                                  Host saveProject
远端 / Web / 手机 → 原 projectService.readDirectory(hostId) → 同一草稿
```

## 边界与失败语义

- 仅 `hostId` 未指定或为 `local`，且平台提供 `selectDirectory` 时使用系统选择器；判定不依赖当前 tab/cwd。远端项目继续浏览所属 Host（远端单根不可变策略不变），Web/手机未提供该能力，不能选择浏览器所在设备的目录作为 Host root。
- 编辑对话框内已有 1 个目录时，末行入口文案为「更换文件夹」，再次选择即整体替换；legacy 多根项目编辑时不提供添加入口，只能逐行移除收敛。零目录时展示空态选择卡片。
- 原生选择在途期间禁用编辑、保存、删除和关闭，避免异步返回与草稿修改交错；组件卸载后的结果不能触发持久化或重新打开编辑器。
- 取消选择不修改草稿；调用失败显示原错误区域、保留草稿并允许重试，不自动切换到另一选择方式。
- 目录选择不改变 Host 组织态、workspaceIdentity、owner/lease、桌面 continuous 或手机 replayable 语义；无数据库/CLI 协议迁移。
- 「设为主要/主要徽标」随多根入口一并移除；`project.addSourceFolder/setPrimary/primaryBadge` i18n 键废弃，新增 `project.changeFolder`，`project.browseHint` 改单数。

## 验收用例（accepted / pending）

| 用例  | 操作与断言                                                                                                                                                 |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NDP01 | 桌面本地点击选择，选一个真实目录；原生参数为单选（无 multiSelections），不出现应用内目录浏览器；再次选择整体替换；取消选择不变更；保存后重新编辑仍是该目录 |
| NDP02 | 信任确认取消/关闭/Escape/点外均不落库、不改草稿；保存后项目排首位，刷新与重开保留                                                                          |
| NDP03 | 名称自动填充：未手输时跟随所选文件夹名，更换文件夹继续跟随；手改后更换不被覆盖                                                                             |

Electron 交互候选：`packages/desktop/test/e2e/ui-shell/manual-review/pending/project-native-directory-picker.test.ts`。mock 仅替代系统弹窗的用户返回值，真实执行 UI → preload → main、保存与重新编辑；不声称覆盖操作系统原生窗口内的鼠标操作。既有本地目录浏览 E2E 同步改用原生弹窗 mock。真实手机连接与 Windows/Linux GUI 需另行验证。

## 验证记录

- 2026-09-15（多选版，已被上节取代）：单测 5 文件 21 项、Electron `desktop-e2e-20260915125744659-p84856-08e67d2dd0407c35` 2/2。
- 2026-11-26（单选收口）：`pnpm typecheck`、desktop `typecheck:e2e`、`pnpm lint`（0 errors）、`architecture:check --changed` 通过；VP20/VP22/VP11 用例按新语义改写。真实手机、SSH/WSL Host、Windows/Linux GUI 未重验，维持 pending。
