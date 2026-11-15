import type { KeyboardEvent, FocusEvent, RefObject } from "react";

/**
 * 智能体标题的重命名编辑器（从 GroupItem 抽出以控制文件行数）。
 * 测量节点与输入框的宽度/焦点协作规则：
 * - 测量按钮不能跟随 label 的 max-w-full，否则输入变长时会被当前宽度反向卡住；
 *   外层 label 负责视觉裁剪，测量按钮只测真实内容宽度。
 */
export function GroupTitleEditor({
  srLabel,
  titleEditorText,
  renameDraft,
  width,
  measureButtonRef,
  inputRef,
  placeholder,
  onBlur,
  onChange,
  onCompositionEnd,
  onCompositionStart,
  onFocus,
  onKeyDown,
}: {
  srLabel: string;
  titleEditorText: string;
  renameDraft: string;
  width: number | null;
  measureButtonRef: RefObject<HTMLButtonElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  placeholder: string;
  onBlur: () => void;
  onChange: (value: string) => void;
  onCompositionEnd: () => void;
  onCompositionStart: () => void;
  onFocus: (event: FocusEvent<HTMLInputElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <label
      className="relative min-w-6 max-w-full shrink overflow-hidden align-middle"
      onClick={(event) => event.stopPropagation()}
      style={width ? { width: `${width}px` } : undefined}
    >
      <span className="sr-only">{srLabel}</span>
      <button
        ref={measureButtonRef}
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 invisible overflow-hidden rounded-sm px-1 text-left text-ui-base text-foreground"
        // 测量节点不能跟随 label 的 max-w-full，否则输入变长时会被当前宽度反向卡住。
        // 外层 label 继续用 max-w-full 负责视觉裁剪，这里只测真实内容宽度。
        style={{ whiteSpace: "pre" }}
      >
        {titleEditorText}
      </button>
      <input
        data-testid="task-group-title-input"
        ref={inputRef}
        autoFocus
        className="w-full min-w-0 truncate rounded-sm border-0 bg-transparent px-1 py-0 text-left text-ui-base leading-normal text-foreground outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-input-border-focused"
        value={renameDraft}
        onBlur={onBlur}
        onChange={(event) => onChange(event.target.value)}
        onCompositionEnd={onCompositionEnd}
        onCompositionStart={onCompositionStart}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
        placeholder={placeholder}
      />
    </label>
  );
}
