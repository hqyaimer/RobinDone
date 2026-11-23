// ============================================================
// Agent contact dispatch → task service（2026-11-20 worker 会话同构化）
// ============================================================
// docs/worker-session-model.md §2/§3：ContactAgent 是 master↔worker 的唯一通道。
// 本助手把 CLI 的 agentContact/dispatch 反向请求落到桌面任务服务——机制与触发器投递
// （dispatchTriggerRun）完全同构：非活跃先 resumeTask（sendPrompt 要求 active 的既有
// 不变量）→ sendPrompt（<system-status> 标注发起方身份，接收端轮终态输出即回复）。
//
// 寻址（2026-11-21 实测裁决：零耦合显式寻址，docs/worker-session-model.md §2）：
// - 显式 sessionId = 续聊该会话；
// - 缺省 = 一定新建会话（worker 目标带 worker 身份）。
// 不做"目标智能体最新会话"回退——触发器/协作会话的汇报曾因此静默落进 master 正在
// 聊天的最新会话（实测 bug）。会话 id 的唯一来源是"之前被联系过"：上次 ContactAgent
// 输出的 sessionId，或收到的 <system-status>.fromSessionId；续聊由发起方显式给地址。
//
// 依赖按用途收窄为结构化类型（resumeTask/createTask/sendPrompt 的最小形状），不
// import session 模块的类型——本模块只消费这几个入口，声明整服务依赖会把
// trigger-system 与 session 模块焊死（架构检查 module-dependency/deep-import）。

import { randomUUID } from "node:crypto";
import type { TraceId } from "@robinrun/shared";
import { sanitizeSystemStatusName } from "@robinrun/shared";

/** 投递用到的任务服务最小形状（触发器投递同款两入口；寻址不再需要清单查询）。 */
export interface AgentContactDispatchTaskService {
  resumeTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<unknown>;
  createTask(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    agentIdentity?: { kind: "worker"; workerId: string };
    deferPersistenceUntilFirstPrompt?: boolean;
  }): Promise<{ taskId: string }>;
  sendPrompt(params: {
    taskId: string;
    traceId: TraceId;
    content: string;
    clientMode: "desktop-continuous";
    systemStatus: {
      sender: "master" | "worker";
      senderId?: string;
      senderName?: string;
      fromSessionId: string;
      /** ContactAgent 投递专用（2026-11-21 裸投递）：true=回复契约 / false=仅通知。 */
      replyExpected: boolean;
    };
  }): Promise<void>;
}

export interface AgentContactDispatchHostRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  targetAgentId: string;
  targetSessionId?: string;
  fromSessionId: string;
  senderKind: "master" | "worker";
  senderId?: string;
  senderDisplayName: string;
  message: string;
  needReply: boolean;
  trace?: unknown;
}

export type AgentContactDispatchHostResult = {
  status: "delivered" | "failed";
  sessionId?: string;
  error?: string;
};

/** host 装配层注入的解析依赖（协议零改动：项目归属由 host 侧自行解析，模型无感）。 */
export interface AgentContactDispatchDeps {
  /**
   * 工作区 → 项目 id（host 项目树解析，与触发器引擎 listWorkspaces 同源）。
   * 新建会话缺 projectId 会落"未分组"且 worker 组准入被跳过（2026-11-21 实测修复）；
   * 解析失败/未匹配返回 undefined，会话退回未归属态，不阻断投递。
   */
  resolveProjectId?(workspacePath: string): Promise<string | undefined>;
}

/**
 * ContactAgent 投递执行体（host 装配层注入 robinrunAgentService）。task service 缺席
 * （极端装配）按 failed 收口——与无投递通道时不建 contact 端口一致，不给假成功。
 */
export async function dispatchAgentContactToTaskService(
  taskService: AgentContactDispatchTaskService | undefined,
  request: AgentContactDispatchHostRequest,
  deps?: AgentContactDispatchDeps,
): Promise<AgentContactDispatchHostResult> {
  if (!taskService) {
    return { status: "failed", error: "RobinRun task service is unavailable on this host." };
  }
  try {
    // 1. 寻址（2026-11-21 实测裁决）：显式 sessionId = 续聊该会话；缺省 = 一定新建
    //（worker 会话带 agentIdentity；master 缺席 = 普通 master 会话）。不给"目标最新
    // 会话"回退——续聊地址必须来自"之前被联系过"（发起方显式给出）。
    let taskId: string;
    if (request.targetSessionId) {
      taskId = request.targetSessionId;
    } else {
      // 新建会话补项目归属（2026-11-21 实测修复）：host 按工作区解析 projectId——缺失
      // 时任务行无法归入项目主智能体组（落"未分组"），worker 会话的组准入也会被跳过。
      // 解析失败不阻断投递（退回未归属态，与旧行为一致）。
      let projectId: string | undefined;
      try {
        projectId = await deps?.resolveProjectId?.(request.workspacePath);
      } catch {
        projectId = undefined;
      }
      const created = await taskService.createTask({
        workspacePath: request.workspacePath,
        ...(request.workspaceIdentity !== undefined
          ? { workspaceIdentity: request.workspaceIdentity }
          : {}),
        ...(projectId !== undefined ? { projectId } : {}),
        ...(request.targetAgentId !== "master"
          ? { agentIdentity: { kind: "worker" as const, workerId: request.targetAgentId } }
          : {}),
        deferPersistenceUntilFirstPrompt: true,
      });
      taskId = created.taskId;
    }
    // 2. 非活跃先恢复（dispatchTriggerRun 同款不变量）；失败不阻断投递尝试（active 会话
    // resume 幂等；已激活会话恢复失败仅记录——sendPrompt 会给出权威错误）。
    try {
      await taskService.resumeTask({
        taskId,
        workspacePath: request.workspacePath,
        ...(request.workspaceIdentity !== undefined
          ? { workspaceIdentity: request.workspaceIdentity }
          : {}),
      });
    } catch {
      // 与触发器投递的 defensive resume 同语义：让 sendPrompt 报权威错误而不是 resume 细节。
    }
    // 3. 投递：发起方身份随 <system-status> 下发（结构化元数据，runtime 动态渲染）。
    // 2026-11-21 裸投递：正文=裸消息原文（ContactAgentRequest XML 包装已移除），
    // replyExpected 随 systemStatus 承载回复契约（true=轮终态输出即回复 / false=仅通知）。
    const senderName = sanitizeSystemStatusName(request.senderDisplayName);
    await taskService.sendPrompt({
      taskId,
      traceId: `contact:${randomUUID()}` as TraceId,
      content: request.message,
      clientMode: "desktop-continuous",
      systemStatus: {
        sender: request.senderKind,
        ...(request.senderId ? { senderId: request.senderId } : {}),
        ...(senderName ? { senderName } : {}),
        fromSessionId: request.fromSessionId,
        replyExpected: request.needReply,
      },
    });
    return { status: "delivered", sessionId: taskId };
  } catch (error) {
    // 显式地址失效（会话已删/不可投）按 failed 收口，给发起方可动作的提示：省略
    // sessionId 重新发起即新建会话；不静默改投其他会话（寻址零耦合）。
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      ...(request.targetSessionId ? { sessionId: request.targetSessionId } : {}),
      error: request.targetSessionId
        ? `Target session ${request.targetSessionId} could not be contacted: ${detail}. Start a new conversation by omitting sessionId.`
        : `Contact delivery failed: ${detail}`,
    };
  }
}
