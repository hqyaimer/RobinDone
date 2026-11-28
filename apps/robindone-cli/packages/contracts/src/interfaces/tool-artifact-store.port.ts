// ============================================================
// Tool Artifact Store Port - large tool result storage boundary
// ============================================================

import type { SessionId, ToolCallId, TurnId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";

// ============================================================
// Artifact URI scheme 常量（含改名读兼容，specs/rename-robindone-migration.md §3.3）
// ============================================================

/** 当前写入的唯一 scheme 前缀。 */
export const ARTIFACT_URI_PREFIX = "robindone-artifact://";
/**
 * RobinDone(2026-11-27) 改名读兼容：RobinRun 时代（≤v0.0.3）落盘的会话附件 URI 用旧前缀
 * `robinrun-artifact://`。会话附件引用存于会话 JSON 与 part 表，不走 sqlite schema 迁移链，
 * 按裁决「读路径双认、只写新值」处理：所有读取持久化 URI 的入口必须用
 * {@link isArtifactUri} / {@link artifactUriBelongsToSession}，不得直接字面量 startsWith
 * （否则旧数据附件会被误判为非 artifact 引用，删除会话时误回收）。
 */
export const LEGACY_ARTIFACT_URI_PREFIX = "robinrun-artifact://";

/** 判定 uri 是否是（当前或 RobinRun 时代的）tool artifact 引用。 */
export function isArtifactUri(uri: string): boolean {
  return uri.startsWith(ARTIFACT_URI_PREFIX) || uri.startsWith(LEGACY_ARTIFACT_URI_PREFIX);
}

/** 判定 artifact 引用是否指向指定会话（两种 scheme 都认）。 */
export function artifactUriBelongsToSession(uri: string, sessionId: string): boolean {
  const encoded = encodeURIComponent(sessionId);
  return (
    uri.startsWith(`${ARTIFACT_URI_PREFIX}${encoded}/`) ||
    uri.startsWith(`${LEGACY_ARTIFACT_URI_PREFIX}${encoded}/`)
  );
}

export type ToolArtifactRetention = "session" | "project" | "temporary";

export interface ToolArtifactWriteRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  toolCallId: ToolCallId | string;
  toolName: string;
  content: string;
  contentType?: string;
  retention?: ToolArtifactRetention;
  trace?: TraceContext;
}

export interface ToolBinaryArtifactWriteRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  toolCallId: ToolCallId | string;
  toolName: string;
  content: Uint8Array;
  contentType: string;
  extension?: string;
  retention?: ToolArtifactRetention;
  trace?: TraceContext;
}

export interface ToolArtifactWriteResult {
  id: string;
  uri: string;
  path?: string;
  bytes: number;
  contentType: string;
  createdAt: Date;
}

export interface ToolArtifactReadRequest {
  uri: string;
  trace?: TraceContext;
}

export interface ToolArtifactReadResult {
  uri: string;
  content: string;
  contentType: string;
  bytes: number;
  path?: string;
}

/**
 * 二进制读回：**原始字节**，不经任何文本 / base64 编码。
 *
 * {@link ToolArtifactStorePort.readToolResultArtifact}
 * 把「按文件名再推一次 contentType → 文本走 utf8、其余走 base64」当作写入编码的逆运算，而
 * 推断表只认 txt/md/png/jpg/gif/webp/pdf/bin，`.xlsx` / `.docx` / `.pptx` 落到默认的
 * `application/json` 被当作 utf8 解码——办公文件读回即损坏且不可恢复。字节的消费者
 * （v4 分块查询、查看器）需要的是字节本身，编码是给模型面文本用的；两件事分开两个方法。
 * `contentType` 仍按文件名推断，仅供缺少更好来源的调用方兜底（dwf 用 journal 记录的那份）。
 */
export interface ToolBinaryArtifactReadResult {
  uri: string;
  bytes: Uint8Array;
  contentType: string;
  path?: string;
}

export interface ToolArtifactStatRequest {
  uri: string;
  trace?: TraceContext;
}

export interface ToolArtifactStatResult {
  uri: string;
  bytes: number;
  contentType: string;
  path?: string;
  mtimeMs?: number;
}

export interface ImageAttachmentPathPrimeRequest {
  uri: string;
  bytes: Uint8Array;
  mediaType: string;
}

export interface MediaAttachmentPathPrimeRequest {
  uri: string;
  bytes: Uint8Array;
  mediaType: string;
}

export interface MediaAttachmentPathEnsureRequest {
  uri: string;
  mediaType: string;
}

export type MediaAttachmentPathResult =
  | { status: "ready"; path: string }
  | { status: "unsupported" };

export interface ToolArtifactStorePort {
  writeToolResultArtifact(
    request: ToolArtifactWriteRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactWriteResult>;
  writeToolResultBinaryArtifact?(
    request: ToolBinaryArtifactWriteRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactWriteResult>;
  readToolResultArtifact(
    request: ToolArtifactReadRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactReadResult>;
  /**
   * 原始字节读回（见 {@link ToolBinaryArtifactReadResult}）。可选：与
   * {@link writeToolResultBinaryArtifact} 同规，不带二进制能力的 store 实现不必陪跑；
   * 消费方 `typeof` 探测，缺席即「本 store 不能提供字节」——不得退回文本读再解码。
   */
  readToolResultBinaryArtifact?(
    request: ToolArtifactReadRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolBinaryArtifactReadResult>;
  statToolResultArtifact?(
    request: ToolArtifactStatRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactStatResult>;
  primeImageAttachmentPath?(
    request: ImageAttachmentPathPrimeRequest,
  ): Promise<MediaAttachmentPathResult>;
  primeMediaAttachmentPath?(
    request: MediaAttachmentPathPrimeRequest,
  ): Promise<MediaAttachmentPathResult>;
  ensureMediaAttachmentPath?(
    request: MediaAttachmentPathEnsureRequest,
  ): Promise<MediaAttachmentPathResult>;
}
