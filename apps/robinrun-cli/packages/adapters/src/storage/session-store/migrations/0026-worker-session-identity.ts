// 0026：worker 会话身份持久化（2026-11-20 worker 会话模型同构化的补漏）。
// 契约层 SessionInfo/CreateSessionInput 早有 workerIdentity，但 sqlite 实现从未落列——
// 身份只活在创建时的内存里，CLI 进程重启后的冷恢复读不到，worker 会话会退化成 master
// 装配（实测 bug 类别：触发器会话冒领主智能体身份）。本迁移补 session.worker_identity
// JSON 列；读写编解码见 codecs.decodeSessionRow 与 sessions 仓储的 insert/update。
// 取值：JSON 对象 {workerId, workerName?}；master 会话为 NULL。
export const WORKER_SESSION_IDENTITY_MIGRATION_SQL = `
      alter table session add column worker_identity text;
    `;
