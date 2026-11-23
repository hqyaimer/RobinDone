// ============================================================
// 触发器绑定会话身份校验（2026-11-22 第十一批）
// ============================================================
// 会话 key 路由的"已有则续用"（docs/trigger-system.md 裁决）只保证同 key，不保证
// 订阅者身份一致：注册表归属修正（P3 第十批）/清绑后引擎未重启（绑定表仅挂载时
// 加载）时，事件会继续投进旧 master 材料的绑定会话——旧会话按 master 协作契约把
// 事件 ContactAgent 派回订阅者本人（寻址零耦合下新建其普通会话），表现为
// "触发器 contact 自己"（实测：trg-93c0abac）。派发边界按绑定行 workerId 校验：
// 同构化后 worker 订阅者的触发器会话创建必带 agentIdentity（worker_identity 列），
// 行上缺失或不符 = 旧 master/legacy 会话，绑定视为陈旧（按新建处理，旧会话保留
// 为历史）；master 订阅者不做校验（其绑定会话本就无 workerId）。

/** 订阅者是 worker 且绑定行身份不符（含缺失）→ 绑定陈旧，应忽略并新建订阅者身份会话。 */
export function isStaleWorkerTriggerBinding(
  subscriberWorkerId: string | undefined,
  boundTaskWorkerId: string | null | undefined,
): boolean {
  // master 订阅者：绑定会话无 workerId 属正常形态，无从校验也不需要。
  if (subscriberWorkerId === undefined) return false;
  return boundTaskWorkerId !== subscriberWorkerId;
}
