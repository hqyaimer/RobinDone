import { createContext, useContext } from "react";
import type { ReactNode } from "react";
// RobinRun(2026-11-22): [hide-upstream-account] 隐藏「Web 远程控制/手机配对」——依赖上游 relay
// （wss://zcode.z.ai/api/v1/remote/ws2）+ 登录 JWT 强门禁，恢复时改回 true
const DEFAULT_WEB_REMOTE_CONTROL_FEATURE_ENABLED = false;

const WebRemoteControlFeatureContext = createContext(DEFAULT_WEB_REMOTE_CONTROL_FEATURE_ENABLED);

export function WebRemoteControlFeatureProvider({
  enabled = DEFAULT_WEB_REMOTE_CONTROL_FEATURE_ENABLED,
  children,
}: {
  enabled?: boolean;
  children: ReactNode;
}) {
  return (
    <WebRemoteControlFeatureContext.Provider value={enabled}>
      {children}
    </WebRemoteControlFeatureContext.Provider>
  );
}

export function useWebRemoteControlFeatureEnabled(): boolean {
  return useContext(WebRemoteControlFeatureContext);
}
