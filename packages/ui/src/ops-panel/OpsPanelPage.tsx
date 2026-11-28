import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  TID_OPS_PANEL_DETAIL,
  TID_OPS_PANEL_LIST,
  TID_OPS_PANEL_ROOT,
} from "@robindone/shared/test-ids";
import type { OpsPanelEntry, ProgressEntry } from "@robindone/shared";
import { Button } from "@/components/ui/button.js";
import { useRobinDoneIntl } from "@/i18n/IntlProvider.js";
import { buildChangeSummaryFilePreviewSource } from "@/messageChangeSummaryPreview.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { groupOpsPanelEntries, useOpsPanelView } from "./useOpsPanelView.js";

/**
 * 运营面板整页视图（2026-11-24 MVP 需求/审批/反馈 + 2026-11-25 进度账本 tab，
 * specs/progress-ledger.md）：
 * - 四个 tab 直排顶部，进度置首且默认选中（只读概览作落地页）；激活态用下划线
 *   强区分（2026-11-24 用户实测"看不出切换了"的教训，沿用 ghost+bg-selected）；
 * - 需求/审批/反馈：条目为宽度 100% 的单行，点击行内展开详情与动作；串行唤醒队列
 *   落在条目行徽标（唤醒中 / 排队中）；纯看板 + 决策面（2026-11-24 用户裁决"对话
 *   代录"）：录入走对话——用户直接告诉 master，由 master 落账；面板只剩批准/驳回；
 * - 进度：时间正序里程碑台账（顶=初始化，底=最新），master 独占维护、用户纯只读
 *   （spec §5 权限矩阵）。打开/新数据自动滚到底，滚动离底浮出"回到最新"——列表
 *   变长后"直观看到当前进度"的前提。links 可点击在右栏打开文件预览（进度与知识/
 *   状态文件的融合点）。条目无任何编辑/删除痕迹标记——账本只呈现有效记录（最终态）。
 */

type PanelTab = "progress" | "requirement" | "approval" | "feedback";

const TAB_TITLE_IDS: Record<PanelTab, string> = {
  progress: "opsPanel.tab.progress",
  requirement: "opsPanel.tab.requirement",
  approval: "opsPanel.tab.approval",
  feedback: "opsPanel.tab.feedback",
};

const STATUS_LABEL_IDS: Record<string, string> = {
  submitted: "opsPanel.status.submitted",
  in_progress: "opsPanel.status.inProgress",
  disposed: "opsPanel.status.disposed",
  pending_review: "opsPanel.status.pendingReview",
  approved: "opsPanel.status.approved",
  rejected: "opsPanel.status.rejected",
  processed: "opsPanel.status.processed",
};

const OUTCOME_LABEL_IDS: Record<string, string> = {
  accepted: "opsPanel.outcome.accepted",
  rejected: "opsPanel.outcome.rejected",
  suspended: "opsPanel.outcome.suspended",
  converted_to_approval: "opsPanel.outcome.converted",
};

/** 进度 links 打开：相对路径拼到 workspace 根（绝对/UNC 原样），右栏 code-viewer 预览。 */
function openProgressLink(
  link: string,
  workspacePath: string,
  onOpenCodeViewer: (source: CodeViewerSource) => void,
): void {
  const isAbsolute =
    /^[a-zA-Z]:[\\/]/.test(link) || link.startsWith("/") || link.startsWith("\\\\");
  onOpenCodeViewer(
    buildChangeSummaryFilePreviewSource({
      path: isAbsolute ? link : `${workspacePath.replace(/[\\/]+$/, "")}/${link}`,
      relativePath: link,
      workspacePath,
    }),
  );
}

export function OpsPanelPage(props: {
  workspacePath: string | null;
  /** 进度 links 点击 → 右栏 code-viewer 打开文件（装配面注入；缺席时链接降级为纯文本）。 */
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}) {
  const { intl } = useRobinDoneIntl();
  // hook 自含（三路合并刷新 + 写动作），装配面只传 workspacePath——避免在巨型 Shell
  // 组件里追加 hook 依赖；服务缺席（旧 wire/测试 double）渲染不可用空态。
  const { view, progress, error, available, actions } = useOpsPanelView(props.workspacePath);
  const [tab, setTab] = useState<PanelTab>("progress");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const grouped = groupOpsPanelEntries(view.entries);
  const entries = tab === "progress" ? [] : grouped[tab];
  const tabCount = (candidate: PanelTab): number =>
    candidate === "progress" ? progress.length : grouped[candidate].length;
  // 队列徽标：串行唤醒队列（需求 §3.2）不再单设消息框，按条目 id 挂徽标。
  const pendingIds = new Set(view.queue.pendingIds);
  // 进度 tab 的自动定位最新：打开 tab / 新条目到达时滚到底部；离底浮出"回到最新"。
  const listRef = useRef<HTMLDivElement | null>(null);
  const [nearBottom, setNearBottom] = useState(true);
  useEffect(() => {
    if (tab !== "progress") return;
    const el = listRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
    setNearBottom(true);
  }, [tab, progress.length]);
  const scrollToLatest = () => {
    const el = listRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
    setNearBottom(true);
  };
  const statusLabel = (entry: OpsPanelEntry): string => {
    const outcome =
      entry.kind === "requirement" && entry.outcome !== undefined
        ? OUTCOME_LABEL_IDS[entry.outcome]
        : undefined;
    const status = STATUS_LABEL_IDS[entry.status];
    const statusText = status !== undefined ? intl.formatMessage({ id: status }) : entry.status;
    return outcome !== undefined
      ? `${statusText} · ${intl.formatMessage({ id: outcome })}`
      : statusText;
  };
  // 进度条目展开详情（spec §6）：body、links（可点击）、编号与记录者；无任何编辑/
  // 删除痕迹标记。
  const renderProgressList = () =>
    progress.length === 0 ? (
      <p className="py-10 text-center text-ui-caption text-muted-foreground">
        {intl.formatMessage({ id: "opsPanel.progress.empty" })}
      </p>
    ) : (
      progress.map((entry: ProgressEntry) => {
        const expanded = entry.id === expandedId;
        return (
          <div key={entry.id} className="border-b border-border/40 last:border-b-0">
            <button
              type="button"
              onClick={() => setExpandedId(expanded ? null : entry.id)}
              className="flex w-full items-center gap-2 px-2 py-2.5 text-left hover:bg-muted/60"
              aria-expanded={expanded}
            >
              {expanded ? (
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="w-24 shrink-0 text-ui-xs text-muted-foreground">
                {entry.createdAt.slice(0, 10)}
              </span>
              <span className="flex-1 truncate text-ui-sm text-foreground">{entry.title}</span>
              {entry.createdBy === "system" ? (
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-ui-xs text-muted-foreground">
                  {intl.formatMessage({ id: "opsPanel.progress.badge.system" })}
                </span>
              ) : null}
            </button>
            {expanded ? (
              <div className="flex flex-col gap-2 px-2 pb-3 pl-8">
                {entry.body !== undefined ? (
                  <p className="whitespace-pre-wrap text-ui-sm text-foreground">{entry.body}</p>
                ) : null}
                {entry.links !== undefined && entry.links.length > 0 ? (
                  <div className="flex flex-col gap-1">
                    <span className="text-ui-xs text-muted-foreground">
                      {intl.formatMessage({ id: "opsPanel.progress.detail.links" })}
                    </span>
                    {entry.links.map((link) =>
                      props.onOpenCodeViewer !== undefined && props.workspacePath !== null ? (
                        <button
                          key={link}
                          type="button"
                          className="break-all text-left text-ui-xs text-primary hover:underline"
                          onClick={() =>
                            openProgressLink(
                              link,
                              props.workspacePath as string,
                              props.onOpenCodeViewer!,
                            )
                          }
                        >
                          {link}
                        </button>
                      ) : (
                        <span key={link} className="break-all text-ui-xs text-muted-foreground">
                          {link}
                        </span>
                      ),
                    )}
                  </div>
                ) : null}
                <p className="text-ui-xs text-muted-foreground">
                  {entry.id} · {entry.createdBy}
                </p>
              </div>
            ) : null}
          </div>
        );
      })
    );
  if (!available) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-ui-caption text-muted-foreground">
          {intl.formatMessage({ id: "opsPanel.unavailable" })}
        </p>
      </div>
    );
  }
  return (
    <div data-testid={TID_OPS_PANEL_ROOT} className="relative flex h-full min-h-0 flex-col">
      {/* 四个 tab 直排顶部（ghost 按钮样式，2026-11-24 第三轮裁决；进度 2026-11-25 置首）。 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border/50 pb-2">
        {(Object.keys(TAB_TITLE_IDS) as PanelTab[]).map((candidate) => {
          const active = candidate === tab;
          return (
            <Button
              key={candidate}
              variant="ghost"
              size="sm"
              className={`gap-1.5 ${active ? "bg-selected text-foreground" : "text-muted-foreground"}`}
              aria-pressed={active}
              onClick={() => {
                setTab(candidate);
                setExpandedId(null);
              }}
            >
              {intl.formatMessage({ id: TAB_TITLE_IDS[candidate] })}
              <span className="text-ui-xs">{tabCount(candidate)}</span>
            </Button>
          );
        })}
      </div>
      {/* 读取失败显式呈现（2026-11-24 实测教训）：失败与真空列表的渲染不可混淆——
          否则一次瞬时服务错误就表现为"条目全消失"，无法与数据问题区分。 */}
      {error !== null ? <p className="shrink-0 pt-1 text-ui-xs text-destructive">{error}</p> : null}
      {/* 条目列表：宽度 100% 的单行，点击行内展开（不做卡片分栏）。进度 tab 另有
          滚动监听（离底检测 → 回到最新按钮）。 */}
      <div
        ref={listRef}
        data-testid={TID_OPS_PANEL_LIST}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-2 [scrollbar-gutter:stable]"
        onScroll={(event) => {
          const el = event.currentTarget;
          setNearBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
        }}
      >
        {tab === "progress" ? (
          renderProgressList()
        ) : entries.length === 0 ? (
          // 空态 = 引导到正确入口（2026-11-24 用户裁决"对话代录"：表单退役，录入走
          // 对话——直接告诉 master，由它记录并维护状态）。
          <p className="py-10 text-center text-ui-caption text-muted-foreground">
            {intl.formatMessage({
              id:
                tab === "approval"
                  ? "opsPanel.list.empty"
                  : tab === "requirement"
                    ? "opsPanel.list.hintRequirement"
                    : "opsPanel.list.hintFeedback",
            })}
          </p>
        ) : (
          entries.map((entry) => {
            const expanded = entry.id === expandedId;
            const onBehalf = entry.recordedBy === "master" && entry.author === "user";
            return (
              <div key={entry.id} className="border-b border-border/40 last:border-b-0">
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : entry.id)}
                  className="flex w-full items-center gap-2 px-2 py-2.5 text-left hover:bg-muted/60"
                  aria-expanded={expanded}
                >
                  {expanded ? (
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="w-20 shrink-0 text-ui-xs text-muted-foreground">{entry.id}</span>
                  <span className="flex-1 truncate text-ui-sm text-foreground">{entry.title}</span>
                  {view.queue.inFlightId === entry.id ? (
                    <span className="shrink-0 rounded-full bg-selected px-2 py-0.5 text-ui-xs text-foreground">
                      {intl.formatMessage({ id: "opsPanel.badge.inFlight" })}
                    </span>
                  ) : pendingIds.has(entry.id) ? (
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-ui-xs text-muted-foreground">
                      {intl.formatMessage({ id: "opsPanel.badge.pending" })}
                    </span>
                  ) : null}
                  <span className="shrink-0 text-ui-xs text-muted-foreground">
                    {statusLabel(entry)}
                  </span>
                </button>
                {expanded ? (
                  <div
                    data-testid={TID_OPS_PANEL_DETAIL}
                    className="flex flex-col gap-2 px-2 pb-3 pl-8"
                  >
                    <p className="whitespace-pre-wrap text-ui-sm text-foreground">{entry.body}</p>
                    <p className="text-ui-xs text-muted-foreground">
                      {intl.formatMessage({ id: "opsPanel.detail.author" })}: {entry.author}
                      {onBehalf ? (
                        <span className="ml-2 rounded-full bg-muted px-2 py-0.5">
                          {intl.formatMessage({ id: "opsPanel.badge.onBehalf" })}
                        </span>
                      ) : null}
                    </p>
                    {entry.note !== undefined ? (
                      <p className="text-ui-xs text-muted-foreground">
                        {intl.formatMessage({ id: "opsPanel.detail.note" })}: {entry.note}
                      </p>
                    ) : null}
                    {/* 用户专属动作：批准/驳回审批（权限矩阵；处置/分诊/确认执行归 master）。 */}
                    {entry.kind === "approval" && entry.status === "pending_review" ? (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => {
                            void actions.decideApproval(entry.id, "approved");
                          }}
                        >
                          {intl.formatMessage({ id: "opsPanel.action.approve" })}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            void actions.decideApproval(entry.id, "rejected");
                          }}
                        >
                          {intl.formatMessage({ id: "opsPanel.action.reject" })}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
      {/* 回到最新（进度 tab 离底时浮出；spec §6"自动定位最新"）。 */}
      {tab === "progress" && !nearBottom && progress.length > 0 ? (
        <Button
          size="sm"
          variant="outline"
          className="absolute bottom-4 right-4 shadow-md"
          onClick={scrollToLatest}
        >
          {intl.formatMessage({ id: "opsPanel.progress.backToLatest" })}
        </Button>
      ) : null}
    </div>
  );
}
