import { z } from "zod";

/**
 * 消息来源区块协议（P2.6，2026-11-17，裁决见 docs/message-origin.md）。
 *
 * 每条进入 agent 上下文的输入（user-role 条目）在最前注入：
 *   <system-status>{"sender":"user"}</system-status>
 * XML 标签只定界，载荷是单行严格 JSON；字段全部系统可控（枚举 + id + 清洗过的显示名），
 * 不含自由正文——从源头消除「内容伪造区块」攻击面。
 *
 * 分层约定：存储层持久化的是元数据（SystemStatusPayload，挂在消息 metadata.systemStatus），
 * 区块文本在 provider 请求组装时由 renderSystemStatusBlock 动态生成——agent 每轮可见，
 * 格式演进不迁移历史数据。UI 不解析区块文本，消费结构化投影字段。
 */
export const SYSTEM_STATUS_TAG = "system-status";

/** 词表（裁决 13）：master = 主智能体；worker = 工作者；subagent = 上游一次性子智能体。 */
export const SYSTEM_STATUS_SENDERS = [
  "user",
  "master",
  "worker",
  "subagent",
  "trigger",
  "system",
] as const;

export type SystemStatusSender = (typeof SYSTEM_STATUS_SENDERS)[number];

/**
 * senderName 显示名清洗上限。显示名（worker 注册表名、automation 标题）是自由文本，
 * 进区块前必须清洗：控制字符与换行剔除、首尾空白收敛、超长截断——保证单行 JSON。
 */
export const SYSTEM_STATUS_NAME_MAX_CHARS = 80;

export const systemStatusPayloadSchema = z.object({
  sender: z.enum(SYSTEM_STATUS_SENDERS),
  /** 发送方身份 id：worker = wkr-id；subagent = 类型名。 */
  senderId: z.string().min(1).max(200).optional(),
  /** 发送方显示名（已清洗）。 */
  senderName: z.string().min(1).max(SYSTEM_STATUS_NAME_MAX_CHARS).optional(),
  /** 来源会话 id = 回话地址；user 消息没有（用户不是会话）。 */
  fromSessionId: z.string().min(1).max(200).optional(),
  /** 触发器来源 = automationId（sender = "trigger" 专用）。 */
  triggerId: z.string().min(1).max(200).optional(),
  /**
   * ContactAgent 投递专用（2026-11-21 裸投递裁决，docs/message-origin.md）：true =
   * 本轮最终输出将逐字作为回复回投给请求方（收尾面向请求方，勿再补发 ContactAgent）；
   * false = 仅通知。仅 sender=master/worker 的 Contact 投递携带；trigger/user/system
   * 恒不带。布尔字段缺席时模型按"非 Contact 投递"理解，无需默认值。
   */
  replyExpected: z.boolean().optional(),
});

export type SystemStatusPayload = z.infer<typeof systemStatusPayloadSchema>;

/** 剔除控制字符/换行并收敛空白，保证显示名能安全进单行 JSON。 */
export function sanitizeSystemStatusName(name: string): string {
  // \p{Cc} 覆盖 C0（U+0000-001F）与 C1（U+007F-009F）控制字符；\u2028/\u2029 是 JSON.stringify
  // 不转义的行/段分隔符，同样会破坏单行约定。不用显式 \u0000 区间写法（no-control-regex
  // 会命中且架构 disable-count 禁止 lint disable 注释），Unicode 属性类语义等价且更全。
  const cleaned = name
    .replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > SYSTEM_STATUS_NAME_MAX_CHARS
    ? cleaned.slice(0, SYSTEM_STATUS_NAME_MAX_CHARS)
    : cleaned;
}

/**
 * 序列化为区块载荷：严格 JSON 单行 + 安全转义（`<`/`>`/`&` → \uXXXX）。
 * 转义后载荷内不可能出现 `</system-status>` 或任何嵌套标签序列。
 */
export function serializeSystemStatusPayload(payload: SystemStatusPayload): string {
  const parsed = systemStatusPayloadSchema.parse(payload);
  return JSON.stringify(parsed)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

/** 渲染完整区块（含定界标签），置于消息正文最前。 */
export function renderSystemStatusBlock(payload: SystemStatusPayload): string {
  return `<${SYSTEM_STATUS_TAG}>${serializeSystemStatusPayload(payload)}</${SYSTEM_STATUS_TAG}>`;
}

/** 区块 + 正文分隔（空行），供注入方拼接。 */
export function prependSystemStatusBlock(body: string, payload: SystemStatusPayload): string {
  return `${renderSystemStatusBlock(payload)}\n\n${body}`;
}

/**
 * 兼容解析（测试/旧数据迁移用；正常链路读结构化元数据，不解析正文）。
 * 仅接受「整条消息就是一个区块」或「区块在正文最前」的形态，其余返回 null。
 */
export function parseLeadingSystemStatusBlock(text: string): SystemStatusPayload | null {
  const match = new RegExp(`^<${SYSTEM_STATUS_TAG}>([\\s\\S]*?)</${SYSTEM_STATUS_TAG}>`).exec(text);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1] ?? "");
    const result = systemStatusPayloadSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** 从任意字符串值构造区块安全显示名（越界值清洗为安全形态）。 */
export function systemStatusNameValue(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const cleaned = sanitizeSystemStatusName(name);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** 宽松解析持久 metadata.systemStatus（冷恢复/hydrator 用）；不合法返回 null，不抛错。 */
export function parseSystemStatusPayload(value: unknown): SystemStatusPayload | null {
  const result = systemStatusPayloadSchema.safeParse(value);
  return result.success ? result.data : null;
}
