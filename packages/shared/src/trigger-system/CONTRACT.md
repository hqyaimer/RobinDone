# trigger-system

RobinDone 触发器系统（含 agent 消息与会话感知）的协议与引擎边界。设计正身
`docs/trigger-system.md`（2026-11-19 定稿），AGENTS.md「触发器与决策闭环」是其概要投影。

`.robindone/triggers/triggers.json` 是触发器/组/登录态档案索引的唯一事实源，由
ManageTriggers 工具（程序侧）原子写入；触发器说明为 `.robindone/triggers/<id>/README.md`
（纯正文，新会话与压缩后注入），脚本本体在 `<id>/script/`，审计日志在 `<id>/log/audit.jsonl`
（append-only）。id（`trg-<8hex>` / `trggrp-<8hex>`）是路径锚点；`groupId` 与组的
`memberTriggerIds` 双向闭合表达"一触发器对一订阅者只属一个订阅上下文"（裁决 1）。

本模块提供：注册表 zod schema（strict + id 唯一 + 订阅交叉一致性 superRefine）、
会话 key 协议常量与解析（`trigger:<id>` / `trigger-group:<gid>`，裁决 7 路由规则）、
存储布局常量。引擎（host 常驻服务）、ManageTriggers 工具面与 UI 投影全部经本模块的
协议层通信；模型不得用 Write/Edit 直接改注册表。
