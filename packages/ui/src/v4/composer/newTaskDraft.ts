import type { ComposerInitialConfig } from "@/store/robindoneSessionStoreTypes.js";
import type { ModelSelectionView } from "@robindone/services";
import type { SubmissionMode } from "@robindone/shared/robindone-protocol-v4";
import {
  readComposerRecent,
  readGlobalComposerMode,
  resolveDraftInitialModelSelection,
} from "@/lib/composerRecent.js";
import {
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
  type ComposerScope,
  resolveComposerScope,
  readComposerWorkspaceScope,
} from "@/v4/composer/composerDraftStore.js";

/** 普通新任务与首次分享导入共用初始化；保留 Recent 原意图，由公共 View 解析有效选择。 */
export function initializeNewTaskDraft(
  draft: V4ComposerDraft,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  view: ModelSelectionView,
  scope?: ComposerScope,
  /** 项目权限默认（2026-11-18）：项目确认过完全访问后新会话默认完全访问。 */
  projectDefaultMode?: SubmissionMode,
  /**
   * 全局权限模式（2026-11-22 升格为 AppSettings）：宿主可读的跨工作区缺省，自动创建的
   * 会话（触发器/ContactAgent 派发）经同一设置继承；调用方传 settings 快照值。
   * localStorage 全局键降为渲染层回退（写入侧双写，同窗口始终不落后于快照）。
   */
  settingsGlobalMode?: SubmissionMode,
): V4ComposerDraft {
  const recent = readComposerRecent(workspacePath, workspaceIdentity, undefined, scope);
  // Recent 显式意图优先于项目默认；plan 是独立开关位，归一为 build 后再看项目默认。
  const recentMode: SubmissionMode | undefined = recent?.mode === "plan" ? "build" : recent?.mode;
  // 全局权限模式兜底（2026-11-21 实测裁决；2026-11-22 升格设置项）：用户在任意会话显式
  // 选过的权限全局统一继承，免去每个新会话手动重选；Recent/项目默认仍按既有语义优先。
  const storedGlobalMode = readGlobalComposerMode();
  const globalMode =
    settingsGlobalMode ?? (storedGlobalMode === "plan" ? "build" : storedGlobalMode) ?? undefined;
  return {
    ...draft,
    mode: recentMode ?? projectDefaultMode ?? globalMode ?? "build",
    planEnabled: false,
    modelSelection:
      recent?.modelSelection ??
      resolveDraftInitialModelSelection(view, null).selection ??
      undefined,
  };
}

/** 首次导入由导航动作显式传参；复用历史或已有文字草稿不覆盖。 */
export function resolveImportedComposerConfig(
  result: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
    reused: boolean;
  },
  clientNamespace = "desktop",
): ComposerInitialConfig | undefined {
  const { workspacePath, workspaceIdentity, sessionId, reused } = result;
  if (reused || readV4ComposerDraft(workspacePath, workspaceIdentity, sessionId)) return undefined;
  const scope =
    readComposerWorkspaceScope(workspacePath, workspaceIdentity, clientNamespace) ??
    resolveComposerScope(null, workspaceIdentity, clientNamespace);
  const root = readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, scope);
  return root?.mode
    ? {
        mode: root.mode,
        planEnabled: root.planEnabled ?? false,
        modelSelection: root.modelSelection,
      }
    : {};
}
