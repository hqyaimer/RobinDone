import { useCallback, useLayoutEffect, useRef } from "react";
import type { IServiceAccessor } from "@robindone/services";
import { basenameOf, upsertRobindoneProjectEntry } from "@/robindone/projectRegistry.js";
import { updateSettingsAndRefreshSnapshot } from "@/hooks/useSettingService.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useRobinDoneIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";

export function useConfirmDialog() {
  return useConfirmDialogStore((state) => state.requestConfirmation);
}

/** 项目级完全访问上下文：presence 即启用「每项目只确认一次」语义。 */
export interface YoloConfirmationProjectContext {
  workspacePath: string;
  workspaceIdentity?: string;
}

/** 本项目是否已确认过一次完全访问风险提示（settings 注册表条目标记）。 */
async function isProjectFullAccessConfirmed(
  services: IServiceAccessor,
  workspacePath: string,
): Promise<boolean> {
  const settings = await services.settingService.get();
  return (settings.robindoneProjects ?? []).some(
    (entry) => entry.path === workspacePath && entry.fullAccessConfirmedAt !== undefined,
  );
}

/**
 * 确认落地：写项目标记（去重依据），并把项目内仍在运行的会话实时切到完全访问。
 * 同步失败不阻塞切换本身——会话可能已终态/未物化（Host 侧按 taskId 寻址失败即跳过），
 * 后续派发的 worker 经权限继承链拿到父会话模式，无需在此兜底。
 */
async function markProjectFullAccessConfirmed(
  services: IServiceAccessor,
  project: YoloConfirmationProjectContext,
): Promise<void> {
  const now = Date.now();
  const settings = await services.settingService.get();
  const nextProjects = upsertRobindoneProjectEntry(
    settings.robindoneProjects ?? [],
    project.workspacePath,
    basenameOf(project.workspacePath),
  ).map((entry) =>
    entry.path === project.workspacePath ? { ...entry, fullAccessConfirmedAt: now } : entry,
  );
  await updateSettingsAndRefreshSnapshot({
    settingService: services.settingService,
    patch: { robindoneProjects: nextProjects },
  });
  try {
    const activeTaskIds = await services.robindoneTaskService.listActiveTaskIds({
      workspacePath: project.workspacePath,
      ...(project.workspaceIdentity ? { workspaceIdentity: project.workspaceIdentity } : {}),
    });
    await Promise.allSettled(
      activeTaskIds.map((taskId) =>
        services.robindoneTaskService.setMode({ taskId, mode: "yolo" }),
      ),
    );
  } catch {
    // 运行中会话枚举失败只影响实时同步面，不回滚确认标记。
  }
}

/** 只包装显式入口；scope 必须稳定，并随原状态 owner 的目标换代而改变。 */
export function useYoloModeConfirmation(
  scope: unknown,
  currentMode: string | undefined,
  project?: YoloConfirmationProjectContext | null,
) {
  const { intl } = useRobinDoneIntl();
  const requestConfirmation = useConfirmDialog();
  const services = useOptionalServices();
  const pending = useRef<AbortController | null>(null);
  useLayoutEffect(
    () => () => {
      // 不能只在弹窗关闭时检查 mounted：确认结算与微任务提交之间也可能发生导航。
      pending.current?.abort();
      pending.current = null;
    },
    [scope, currentMode],
  );

  return useCallback(
    (nextMode: string, apply: () => void) => {
      if (
        pending.current ||
        useConfirmDialogStore.getState().pendingRequest?.presentation === "yolo-confirmation"
      )
        return;
      if (nextMode !== "yolo" || currentMode === "yolo") {
        apply();
        return;
      }
      // 项目权限全量同步（2026-11-18）：本项目确认过一次即不再弹窗；首次确认后写回
      // 项目标记并同步运行中会话。services 缺席（测试/极端宿主）退回逐次弹窗。
      if (project && services) {
        void isProjectFullAccessConfirmed(services, project.workspacePath).then((confirmed) => {
          if (confirmed) {
            apply();
            return;
          }
          const controller = new AbortController();
          pending.current = controller;
          void requestConfirmation(
            {
              title: intl.formatMessage({ id: "mode.yoloConfirmation.title" }),
              presentation: "yolo-confirmation",
            },
            controller.signal,
          ).then((result) => {
            if (pending.current === controller) pending.current = null;
            if (result && !controller.signal.aborted) {
              void markProjectFullAccessConfirmed(services, project);
              apply();
            }
          });
        });
        return;
      }
      const controller = new AbortController();
      pending.current = controller;
      void requestConfirmation(
        {
          title: intl.formatMessage({ id: "mode.yoloConfirmation.title" }),
          presentation: "yolo-confirmation",
        },
        controller.signal,
      ).then((confirmed) => {
        if (pending.current === controller) pending.current = null;
        if (confirmed && !controller.signal.aborted) apply();
      });
    },
    [currentMode, intl, project, requestConfirmation, scope, services],
  );
}
