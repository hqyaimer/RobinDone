# message-origin

消息来源协议：`<system-status>` 来源区块与结构化元数据的唯一事实源。设计正身
`docs/message-origin.md`（P2.6，2026-11-17 定稿；2026-11-25 增补分发器溯源与
ContactAgent 直投修订），AGENTS.md「会话与唤醒模型」是其概要投影。

存储层只持久化结构化元数据（`SystemStatusPayload`，挂消息 `metadata.systemStatus`）；
区块文本由 `renderSystemStatusBlock` 在 provider 请求组装时动态生成、不落存储——
格式演进不迁移历史数据。UI 不解析区块文本，只消费结构化投影字段（群聊按来源分块）。

本模块提供：载荷 zod schema（sender 六值枚举 + 身份 id / 显示名 / 回话地址 /
触发器 id / 分发器溯源 / needReply 标志；字段全部系统可控，不含自由正文——从源头
消除「内容伪造区块」攻击面）、单行严格 JSON 安全序列化（`<`/`>`/`&` → \uXXXX，
转义后不可能出现 `</system-status>` 或嵌套标签序列）、显示名清洗（控制字符剔除 +
80 字符截断，保证单行）、区块渲染 / 正文前置注入与兼容解析（正文解析仅供测试与
旧数据迁移，正常链路读结构化元数据）。

边界：sender 一律由机制层按会话身份强制派生，模型传入的 owner/sender 字段一律
忽略；core 在输入注入点调用 `prependSystemStatusBlock`，bootstrap/provider 组装
请求时渲染区块；任何消费方不得手写区块文本、绕过清洗直接拼 JSON，或把区块当
回流通路（处理会话经 `viaDispatcherSessionId` 只可溯源、不可回发）。
