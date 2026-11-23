import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import robinLogoUrl from "@/assets/brand/robin-closeup.svg";
import robinLogoAnimatedUrl from "@/assets/brand/robin-closeup-animated.svg";

interface RootStartupLoadingProps {
  label: string;
  children?: ReactNode;
  busy?: boolean;
}

export function RootStartupLoading({ label, children, busy = true }: RootStartupLoadingProps) {
  return (
    <div
      // Web 端全局 html/body/#root 为 Electron 透明背景让路，React 接管后会替换 HTML 启动壳。
      // 这里必须由阻塞态自身承接主题背景，否则远控链接会在 Root 恢复期间继续露出浏览器白底。
      className="flex h-full min-h-dvh flex-col items-center justify-center gap-6 bg-background text-foreground"
      role="status"
      aria-busy={busy}
      aria-label={label}
      data-testid="root-startup-loading"
    >
      <RobinRunStartupLogoBadge />
      {children}
    </div>
  );
}

/** 初始化与引导共用品牌图标：白底圆角瓦片 + 知更鸟特写，深浅主题通用。 */
export function RobinRunStartupLogoBadge({
  animated = true,
  size = "default",
}: {
  animated?: boolean;
  size?: "default" | "titlebar";
}) {
  return (
    <div
      data-desktop-logo-badge={size === "titlebar" ? "true" : undefined}
      className={cn(
        // 品牌图换成知更鸟特写后是多色位图性质，底座由黑渐变字标底改为白底圆角瓦片；
        // 描边用深色半透明，浅色界面下仍可辨。animated 走 SMIL 动画版资产（呼吸节奏沿用旧字标徽章）。
        "relative flex items-center justify-center overflow-hidden bg-white before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:border before:border-black/10",
        size === "titlebar"
          ? "size-5 rounded shadow-sm/20 before:border-black/15"
          : "size-24 rounded-3xl shadow-xl/20 before:border-black/10",
      )}
    >
      <img
        src={animated ? robinLogoAnimatedUrl : robinLogoUrl}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="size-full select-none"
      />
    </div>
  );
}

