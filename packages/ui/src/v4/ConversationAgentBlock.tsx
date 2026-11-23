// P2.6 验收修复第四轮（2026-11-18）：会话区按 agent 分块的统一容器。
// 每个 agent 的发言 = 全宽块（半透明灰底 + 放大块头「组色圆 Bot 头像 + 名称」+ 全宽正文）。
// 第四轮修正（验收反馈）：块底不用组色淡底（蓝色太抢），统一半透明灰；agent 身份靠
// 块头的组色头像区分。真实用户消息不走本组件（右侧气泡不变）。
import { memo } from "react";
import { BotIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";

/** 块头头像的组色 class；缺席（组色解析不到）时头像回退中性裸 Bot 图标。 */
export interface ConversationAgentBlockSurfaces {
  avatarClass?: string;
}

export interface ConversationAgentBlockProps {
  /** 块头名称（「主智能体」/「工作者-<显示名>」/mailbox 行的 senderLabel）。 */
  label: string;
  surfaces?: ConversationAgentBlockSurfaces;
  /** 块头行是否渲染；延续块（同轮后续 agent run）可关掉只保留底色。 */
  header?: boolean;
  className?: string;
  children?: React.ReactNode;
}

// 块底：半透明灰（theme 配对的黑白 alpha，与 v4 既有 HighspeedOutputFooter 的
// dark:bg-white/5 同一约定）；边框用语义 border token 勾出块轮廓。
const BLOCK_TINT_CLASS = "bg-black/[0.035] dark:bg-white/[0.045]";
const BLOCK_BORDER_CLASS = "border-border";

export const ConversationAgentBlock = memo(function ConversationAgentBlock({
  label,
  surfaces,
  header = true,
  className,
  children,
}: ConversationAgentBlockProps) {
  return (
    <div
      data-v4-agent-block="true"
      className={cn(
        "flex w-full flex-col rounded-xl border px-4 py-3",
        BLOCK_TINT_CLASS,
        BLOCK_BORDER_CLASS,
        className,
      )}
    >
      {header ? (
        <div
          data-v4-agent-block-header="true"
          className="flex items-center gap-2 text-ui-base font-medium text-foreground"
        >
          {surfaces?.avatarClass ? (
            // 组色圆头像：与侧栏 TaskGroupColorMark 同款比例（size-5 圆 + size-3 图标）。
            <span
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full",
                surfaces.avatarClass,
              )}
            >
              <BotIcon aria-hidden="true" className="size-3" />
            </span>
          ) : (
            <BotIcon aria-hidden="true" className="size-4 shrink-0 text-foreground-subtle" />
          )}
          <span className="truncate">{label}</span>
        </div>
      ) : null}
      {children}
    </div>
  );
});
