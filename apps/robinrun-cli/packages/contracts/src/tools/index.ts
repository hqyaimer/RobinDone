// ============================================================
// Tools Index - Core tool definitions
// ============================================================

// Re-export all tool types
export * from "./contract.js";
export * from "./json-schema.js";
export * from "./read.js";
export * from "./write.js";
export * from "./edit.js";
export * from "./apply-patch.js";
export * from "./bash.js";
export * from "./node-repl.js";
export * from "./glob.js";
export * from "./grep.js";
export * from "./webfetch.js";
export * from "./agent.js";
export * from "./skill.js";
export * from "./todo.js";
export * from "./automation.js";
export * from "./off-peak.js";
export * from "./target.js";
export * from "./plan-mode.js";
export * from "./ask-user-question.js";
export * from "./send-message.js";
export * from "./respond-to-coordinator.js";
// agent 消息与会话感知（2026-11-19，docs/trigger-system.md）：ContactAgent 唯一请求入口
// + WaitReply 主动等待；ReturnToDispatcher 已移除（退出路径并入 ContactAgent needReply=false）。
export * from "./contact-agent.js";
export * from "./wait-reply.js";
export * from "./task-output.js";
export * from "./task-stop.js";
export * from "./read-session-context.js";
export * from "./submit-result.js";
export * from "./websearch.js";
export * from "./workflow.js";
export * from "./create-workflow.js";
// 修订入口：名字常量被 core 的
// 分派、权限服务的 owner 规则、bootstrap 的 actor 禁用名单与 TUI/headless 旁路读走。
export * from "./amend-workflow.js";
export * from "./workflow-settings.js";
export * from "./saved-workflow.js";
export * from "./save-workflow.js";
export * from "./list-saved-workflows.js";
// dwf 选型的发现面：名字常量被 core 的工具注册与
// bootstrap 的 actor 禁用名单读走，漏掉这行消费方拿不到 schema 与 LIST_MODELS_TOOL_NAME。
export * from "./list-models.js";
export * from "./eval-workflow-snippet.js";
export * from "./list-workflow-runs.js";
export * from "./get-workflow-run.js";
// 恢复入口与两个内省工具同族（run_id 键、端口探测失败同款）；漏掉这行消费方拿不到
// schema 与 RESUME_WORKFLOW_RUN_TOOL_NAME 常量，core 的扩名分派会静默失效。
export * from "./resume-workflow-run.js";
// 升级问答的两个工具面：actor 侧的 escalate 与主代理侧的
// ResolveWorkflowQuestion。名字常量被 core 的 allowlist 补回逻辑与 bootstrap 的 actor 禁用
// 名单读走，漏掉这两行会让那两处静默失效（照 resume-workflow-run 的同款注释）。
export * from "./escalate.js";
export * from "./resolve-workflow-question.js";
// 留白补全（docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」）：名字常量被 core 的注册、
// 权限服务的 owner 规则、workflow child 的禁用名单与 display 分派读走。
export * from "./fill-workflow-hole.js";
export * from "./workflow-observation-display.js";
export * from "./tool-result-metadata.js";
export * from "./performance.js";

// RobinRun worker 编制系统：主智能体专属的 worker 名册管理（2026-11-15 裁决）。
export * from "./manage-workers.js";

// worker 派发专用工具（P2.6 词表/工具分离裁决）：与一次性 subagent 的 Agent 工具强制分开。


// RobinRun 触发器系统：触发器/组/登录态档案注册表管理（2026-11-19 设计定稿，
// docs/trigger-system.md）。任意智能体（master/worker）可创建，订阅者=创建者。
export * from "./manage-triggers.js";

// 分发器路由标记（2026-11-25 分发器裁决，specs/trigger-dispatcher-routing.md）：
// dispatcher 档触发器会话的话题聚类工具——引用式标记，事件原文机制层直传。
export * from "./route-events.js";

// 需求/审批/反馈面板（2026-11-24 MVP，RobinRunOps dev/specs）：智能体操作面板的
// 唯一工具面。同名双变体（master/worker）按会话身份二选一，权限矩阵在 host 服务层
// 强制；worker 只见自己提交的条目（数据/接口层过滤）。
export * from "./manage-ops-panel.js";

// Shared types (only once to avoid duplicates)
export type { DiffHunk, GitDiff } from "./write.js";
export * from "./tool-search.js";
export * from "./deferred-tool-call.js";
