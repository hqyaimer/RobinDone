# trigger-engine（trigger-system 的 services 侧）

触发器引擎：desktop host utility 进程常驻服务。轮询挂载全部项目工作区的
`.robindone/triggers/triggers.json`（5s 内容比对，规避原子写换 inode 的 watcher 失效问题），
调度 cron/interval（croner，本地时区），执行 script 型触发器（出口契约 + 连续异常熔断
error-paused），接收本地 loopback webhook（path + token 双重校验），事件按会话 key
（`trigger:<id>` / `trigger-group:<gid>`）聚合去抖后经 `TriggerDispatchPort` 投递给
订阅智能体的会话（host 装配，克隆 dispatchCronRun 的 createTask/resumeTask/sendPrompt 链；
会话绑定持久化在 `.robindone/triggers/state/sessions.json`）。

引擎对注册表只写运行时字段（lastFireAt/lastResult/consecutiveFailures/status 熔断），
结构变更归 ManageTriggers 工具；损坏注册表拒绝引擎写（fail-safe，同 worker-roster 裁决）。
设计正身 `docs/trigger-system.md`。
