import {
  parseLeadingSystemStatusBlock,
  parseSystemStatusPayload,
  prependSystemStatusBlock,
  renderSystemStatusBlock,
  systemStatusPayloadSchema,
  type SystemStatusPayload,
} from "./contract.js";

/** message-origin 模块边界示例：worker 投递输入的区块渲染 → 正文前置 → 解析闭环。 */
export const exampleWorkerDeliveryPayload: SystemStatusPayload = systemStatusPayloadSchema.parse({
  sender: "worker",
  senderId: "wkr-1a2b3c4d",
  senderName: "运营专员",
  fromSessionId: "sess_example01",
  replyExpected: true,
});

// 区块动态渲染（含定界标签，单行严格 JSON），置于正文最前；存储层只持久化 payload 本身。
export const exampleRenderedBlock = renderSystemStatusBlock(exampleWorkerDeliveryPayload);
export const exampleComposedInput = prependSystemStatusBlock(
  "登录检测失败，已按闭环暂停脚本并唤醒订阅者。",
  exampleWorkerDeliveryPayload,
);

// 正文解析仅供测试/旧数据迁移；正常链路经 parseSystemStatusPayload 读结构化元数据。
export const exampleParsedFromText = parseLeadingSystemStatusBlock(exampleComposedInput);
export const exampleParsedMetadata = parseSystemStatusPayload({
  sender: "trigger",
  triggerId: "trg-example01",
  viaDispatcherSessionId: "sess_dispatcher01",
});
