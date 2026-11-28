import { parseSystemStatusPayload, renderSystemStatusBlock, type SystemStatusPayload } from "@robindone/shared";
import {
  isRuntimeAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import type { ProviderEntryOrigins } from "./provider-entry-origins.js";

/**
 * P2.6 消息来源区块投影（docs/message-origin.md）：
 * 在 provider 请求组装边界，为每条输入条目的正文最前注入
 * `<system-status>{…}</system-status>`。存储层只有元数据（entry/metadata.systemStatus），
 * 区块文本每次请求现渲染——首轮/恢复/压缩后一致，格式演进不迁移历史数据。
 *
 * 兜底：真实用户输入（无 metadata 或 source === "real_user"）缺省标注
 * `{"sender":"user"}`——每条消息都标（含用户消息），模型零歧义、伪造面最小。
 * agent 自己的输出与系统提醒/工具结果一律不标。
 */
export function prependSystemStatusBlocks(
  entries: readonly RuntimeMessageEntry[],
  origins: ProviderEntryOrigins,
): RuntimeMessageEntry[] {
  return entries.map((entry) => {
    const payload = resolveSystemStatusPayload(entry);
    if (!payload) return entry;
    const projected = isRuntimeAttachmentEntry(entry)
      ? {
          ...entry,
          content: `${renderSystemStatusBlock(payload)}\n\n${entry.content}`,
        }
      : {
          ...entry,
          message: {
            ...entry.message,
            content: prependBlockToUserContent(entry.message.content, payload),
          },
        };
    // 投影生成了新对象：登记来源映射，canonical 归属（媒体预算/缓存定位）不丢。
    origins.set(projected, [entry]);
    return projected;
  });
}

function resolveSystemStatusPayload(entry: RuntimeMessageEntry): SystemStatusPayload | null {
  const explicit = parseSystemStatusPayload(entry.metadata?.systemStatus);
  if (explicit) return explicit;
  // 真实用户输入兜底：只认 canonical 的 real_user 元数据（准入/水合/冷恢复都盖章）。
  // provider 渲染产物没有 metadata，重投影时这里不命中——区块注入保持幂等
  //（provider-request-messages 的确定性/幂等契约测试锁定这一行为）。
  if (
    !isRuntimeAttachmentEntry(entry) &&
    entry.message.role === "user" &&
    !entry.message.toolCallId &&
    !entry.message.toolName &&
    entry.metadata?.source === "real_user"
  ) {
    return { sender: "user" };
  }
  return null;
}

function prependBlockToUserContent(
  content: import("@robindone/contracts").ModelMessageContent,
  payload: SystemStatusPayload,
): import("@robindone/contracts").ModelMessageContent {
  const block = renderSystemStatusBlock(payload);
  if (typeof content === "string") {
    return `${block}\n\n${content}`;
  }
  const first = content[0];
  if (first?.type === "text") {
    return [{ ...first, text: `${block}\n\n${first.text}` }, ...content.slice(1)];
  }
  return [{ type: "text", text: block }, ...content];
}
