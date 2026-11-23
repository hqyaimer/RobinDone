# worker-roster

RobinRun worker 编制（常驻智能体名册）的协议与加载边界。`.robinrun/agents/workers.json`
是编制唯一事实源，由 ManageWorkers 工具（程序侧）原子写入；worker 规则文件为
`.robinrun/agents/<id>/agents.md`（纯 prompt 正文 + 固定脚手架，含概览与索引目录，
`plan/`、`knowledge/`、`tmp/` 三个子目录约定）。id（`wkr-<8hex>`）是路径锚点，name 仅作
派发显示名（项目内唯一、大小写不敏感）。`status: deactivated` 为软停用：文件保留，仅退出名册。

本模块提供：注册表 zod schema（strict + name/id 唯一性 refine）、`buildWorkerProfile`
（条目 + agents.md 内容 → 运行时 `AgentProfile`，注入名册 reminder 与 Agent 派发）、
host 侧 project scope 注册表加载器与文件监听（fail-safe 空编制；写路径由工具拒绝损坏
注册表覆盖）。worker 与一次性 subagent 的路由判据、提示词文案见 `docs/worker-roster.md`
与 AGENTS.md「智能体体系」。
