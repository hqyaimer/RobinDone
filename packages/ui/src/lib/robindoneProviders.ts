import {
  ROBINDONE_AGENT_PROVIDER,
  ROBINDONE_AGENT_PROVIDER_LABEL,
  type RobinDoneProvider,
} from "@robindone/shared";

export const ROBINDONE_AGENT_PROVIDERS: RobinDoneProvider[] = [ROBINDONE_AGENT_PROVIDER];

export const ROBINDONE_AGENT_PROVIDER_LABELS: Record<RobinDoneProvider, string> = {
  glm: ROBINDONE_AGENT_PROVIDER_LABEL,
};

export function supportsRobinDoneSessionFork(provider: RobinDoneProvider): boolean {
  void provider;
  // 功能开关：fork 入口恢复对所有 RobinDone provider 开放；实际可操作性仍由 task 状态、
  // assistant 目标和运行中保护 guard 控制，避免把 active/failed 分支暴露为可 fork。
  return true;
}

export function shouldHideRobinDoneSessionForkAction(provider: RobinDoneProvider): boolean {
  return !supportsRobinDoneSessionFork(provider);
}
