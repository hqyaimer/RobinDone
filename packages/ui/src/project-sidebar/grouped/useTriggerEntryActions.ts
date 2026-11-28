import { mainAgentGroupId, makeTriggerSessionKey, workerGroupId } from "@robindone/shared";
import { useRobinDoneIntl } from "@/i18n/IntlProvider.js";
import { TRIGGER_MASTER_OWNER_ID } from "@/project-sidebar/useTriggerSnapshots.js";

/**
 * 触发器条目的破坏性操作（2026-11-21 从 TaskGroupedView 提取，文件行数上限拆分）：
 * 清空绑定会话 + 伪删除触发器。两者共用同一收口——操作命中的是当前打开的会话时，
 * 关闭失效视图并切到订阅者的"新建会话"草稿态（同智能体行"+"链路）。
 */

interface TriggerEntryActionDeps {
  /** 破坏性操作确认框（TaskGroupedView 同款 useConfirmDialog 实例）。 */
  confirm: (options: { title: string; description: string }) => Promise<boolean>;
  /** TaskGroupedView 的统一错误收口包装（toast + 日志）。 */
  action: (run: () => Promise<unknown>, failureMessageId?: string) => void;
  /** 触发器快照操作面（useTriggerSnapshots 返回值的相关切片，结构化投影）。 */
  triggers: {
    snapshot: {
      triggers: Array<{ id: string; ownerAgentId: string }>;
      sessionBindings: Record<string, string>;
    };
    deleteTrigger: (triggerId: string) => Promise<void>;
    resetTriggerSession: (sessionKey: string) => Promise<void>;
  };
  activeTaskId: string | null;
  /** 当前进入的项目 id（树模式为 undefined → master 订阅者不收口）。 */
  enteredProjectId: string | undefined;
  groups: Array<{ id: string; projectId: string | null | undefined }>;
  projects: Array<{ id: string; hostId: string }>;
  onCreate: (groupId: string, projectId: string | null | undefined, hostId?: string) => void;
}

/** 关闭失效会话视图并切到订阅者草稿态；无组归属（未进项目/订阅者缺失）时不动作。 */
function reopenSubscriberDraft(deps: TriggerEntryActionDeps, ownerId: string | undefined): void {
  const groupId =
    ownerId === TRIGGER_MASTER_OWNER_ID
      ? deps.enteredProjectId
        ? mainAgentGroupId(deps.enteredProjectId)
        : null
      : ownerId !== undefined
        ? workerGroupId(ownerId)
        : null;
  if (!groupId) return;
  const ownerGroup = deps.groups.find((group) => group.id === groupId);
  if (!ownerGroup) return;
  const owner = deps.projects.find((project) => project.id === ownerGroup.projectId);
  deps.onCreate(
    groupId,
    ownerGroup.projectId,
    owner && owner.hostId !== "local" ? owner.hostId : undefined,
  );
}

export function useTriggerEntryActions(deps: TriggerEntryActionDeps): {
  handleTriggerSessionReset: (ownerId: string, sessionKey: string) => void;
  handleTriggerDelete: (triggerId: string) => void;
} {
  const { intl } = useRobinDoneIntl();
  const { action, confirm, triggers } = deps;
  return {
    // UI"清空会话"（2026-11-20）：会话保留、消息归零、身份按当前订阅者重置；绑定不动。
    handleTriggerSessionReset: (ownerId, sessionKey) =>
      action(async () => {
        const confirmed = await confirm({
          title: intl.formatMessage({ id: "triggerSidebar.resetSessionTitle" }),
          description: intl.formatMessage({ id: "triggerSidebar.resetSessionDescription" }),
        });
        if (!confirmed) return;
        await triggers.resetTriggerSession(sessionKey);
        // 清空的正是当前打开的会话：右侧上下文已失效，切订阅者草稿态。
        const boundTaskId = triggers.snapshot.sessionBindings[sessionKey];
        if (activeTaskIs(boundTaskId, deps.activeTaskId)) {
          reopenSubscriberDraft(deps, ownerId);
        }
      }, "triggerSidebar.resetSessionFailed"),
    // 伪删除（2026-11-21 实测裁决，与会话/智能体一致）：条目从触发器文件夹消失
    // （数据保留、不可逆），常驻脚本由引擎随下一次轮询停止。删除项只对直连触发器出现。
    handleTriggerDelete: (triggerId) =>
      action(async () => {
        // 删除前先取快照上下文：确认后的 refresh 会让条目从快照消失（订阅者/绑定要
        // 在删除前读取）。删除项只对直连触发器出现，会话 key = trigger:<id>。
        const boundTaskId = triggers.snapshot.sessionBindings[makeTriggerSessionKey(triggerId)];
        const ownerId = triggers.snapshot.triggers.find(
          (candidate) => candidate.id === triggerId,
        )?.ownerAgentId;
        const confirmed = await confirm({
          title: intl.formatMessage({ id: "triggerSidebar.deleteTriggerTitle" }),
          description: intl.formatMessage({ id: "triggerSidebar.deleteTriggerDescription" }),
        });
        if (!confirmed) return;
        await triggers.deleteTrigger(triggerId);
        if (activeTaskIs(boundTaskId, deps.activeTaskId)) {
          reopenSubscriberDraft(deps, ownerId);
        }
      }, "triggerSidebar.deleteTriggerFailed"),
  };
}

function activeTaskIs(boundTaskId: string | undefined, activeTaskId: string | null): boolean {
  return activeTaskId !== null && boundTaskId !== undefined && activeTaskId === boundTaskId;
}
