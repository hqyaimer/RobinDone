import { useCallback, useMemo, useState } from "react";
import type { RobinDoneProjectEntry } from "@robindone/shared";
import { useSettings } from "@/hooks/useSettingService.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useRobinDoneIntl } from "@/i18n/IntlProvider.js";
import {
  basenameOf,
  sortRobindoneProjectsByRecency,
  upsertRobindoneProjectEntry,
} from "@/robindone/projectRegistry.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { logger } from "@/logger.js";

/**
 * RobinDoneLauncher —— 项目首建页（2026-11-15 去启动台裁决后的残留职责）
 *
 * 正常冷启动由 Root 的“自动打开最近项目”effect 直接落到主界面；本组件只在
 * 注册表为零项目（或候选目录全部失效）时作为首次创建项目的入口出现。
 * 项目注册表持久化在 AppSettings.robindoneProjects（setting.json），路径同时作为
 * workspace identity 的本地键。项目打开复用 Root 的 handleSelectProject 链路。
 */

export interface RobinDoneLauncherProps {
  /** 打开已注册/新选中的项目工作空间（Root 的 handleSelectProject）。 */
  onOpenProject: (path: string) => void;
  /** 现有的"打开文件夹"入口（含远程/浏览器目录浏览等既有逻辑）。 */
  onOpenWorkspaceViaPicker: () => void;
}

export function RobinDoneLauncher({
  onOpenProject,
  onOpenWorkspaceViaPicker,
}: RobinDoneLauncherProps) {
  const { intl } = useRobinDoneIntl();
  const platform = usePlatform();
  const { settings, loading, update } = useSettings();

  const [creating, setCreating] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projects = useMemo(
    () => sortRobindoneProjectsByRecency(settings?.robindoneProjects ?? []),
    [settings?.robindoneProjects],
  );

  const registerAndOpen = useCallback(
    async (path: string, name: string) => {
      const current = settings?.robindoneProjects ?? [];
      await update({ robindoneProjects: upsertRobindoneProjectEntry(current, path, name) });
      onOpenProject(path);
    },
    [onOpenProject, settings?.robindoneProjects, update],
  );

  const handleOpenProject = useCallback(
    async (entry: RobinDoneProjectEntry) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const current = settings?.robindoneProjects ?? [];
        await update({
          robindoneProjects: current.map((p) =>
            p.id === entry.id ? { ...p, lastOpenedAt: Date.now() } : p,
          ),
        });
        onOpenProject(entry.path);
      } catch (cause) {
        logger.warn("[RobinDoneLauncher] open project failed:", cause);
        setError(intl.formatMessage({ id: "robindone.launcher.errorOpen" }));
      } finally {
        setBusy(false);
      }
    },
    [busy, intl, onOpenProject, settings?.robindoneProjects, update],
  );

  const handlePickDirectory = useCallback(async () => {
    setError(null);
    try {
      return await platform.selectDirectory();
    } catch (cause) {
      logger.warn("[RobinDoneLauncher] select directory failed:", cause);
      return null;
    }
  }, [platform]);

  const handleCreate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const path = await handlePickDirectory();
      if (!path) return;
      const name = projectName.trim() || basenameOf(path);
      await registerAndOpen(path, name);
    } catch (cause) {
      logger.warn("[RobinDoneLauncher] create project failed:", cause);
      setError(intl.formatMessage({ id: "robindone.launcher.errorCreate" }));
    } finally {
      setBusy(false);
    }
  }, [busy, handlePickDirectory, intl, projectName, registerAndOpen]);

  const handleOpenExistingFolder = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const path = await handlePickDirectory();
      if (!path) return;
      await registerAndOpen(path, basenameOf(path));
    } catch (cause) {
      logger.warn("[RobinDoneLauncher] open folder failed:", cause);
      setError(intl.formatMessage({ id: "robindone.launcher.errorOpen" }));
    } finally {
      setBusy(false);
    }
  }, [busy, handlePickDirectory, intl, registerAndOpen]);

  const handleRemoveProject = useCallback(
    async (id: string) => {
      const current = settings?.robindoneProjects ?? [];
      try {
        await update({ robindoneProjects: current.filter((p) => p.id !== id) });
      } catch (cause) {
        logger.warn("[RobinDoneLauncher] remove project failed:", cause);
      }
    },
    [settings?.robindoneProjects, update],
  );

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-2xl flex-col gap-6 rounded-xl border border-border bg-card p-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-ui-xl font-semibold text-foreground">
            {intl.formatMessage({ id: "robindone.launcher.title" })}
          </h1>
          <p className="text-ui-sm text-muted-foreground">
            {intl.formatMessage({ id: "robindone.launcher.subtitle" })}
          </p>
        </div>

        <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
          {loading ? (
            <p className="text-ui-sm text-muted-foreground">
              {intl.formatMessage({ id: "robindone.launcher.loading" })}
            </p>
          ) : projects.length === 0 ? (
            <p className="text-ui-sm text-muted-foreground">
              {intl.formatMessage({ id: "robindone.launcher.empty" })}
            </p>
          ) : (
            projects.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md text-left"
                  disabled={busy}
                  onClick={() => void handleOpenProject(entry)}
                >
                  <span className="truncate text-ui-base font-medium text-foreground">
                    {entry.name}
                  </span>
                  <span className="truncate text-ui-xs text-muted-foreground">{entry.path}</span>
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void handleOpenProject(entry)}
                >
                  {intl.formatMessage({ id: "robindone.launcher.open" })}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  title={intl.formatMessage({ id: "robindone.launcher.remove" })}
                  onClick={() => void handleRemoveProject(entry.id)}
                >
                  ✕
                </Button>
              </div>
            ))
          )}
        </div>

        {error ? <p className="text-ui-sm text-destructive">{error}</p> : null}

        {creating ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
            <label className="flex flex-col gap-1">
              <span className="text-ui-sm text-foreground">
                {intl.formatMessage({ id: "robindone.launcher.nameLabel" })}
              </span>
              <Input
                value={projectName}
                placeholder={intl.formatMessage({ id: "robindone.launcher.namePlaceholder" })}
                onChange={(event) => setProjectName(event.target.value)}
              />
              <span className="text-ui-xs text-muted-foreground">
                {intl.formatMessage({ id: "robindone.launcher.nameHint" })}
              </span>
            </label>
            <div className="flex items-center gap-2">
              <Button disabled={busy} onClick={() => void handleCreate()}>
                {intl.formatMessage({ id: "robindone.launcher.createConfirm" })}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setCreating(false);
                  setProjectName("");
                }}
              >
                {intl.formatMessage({ id: "robindone.launcher.cancel" })}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => setCreating(true)}>
              {intl.formatMessage({ id: "robindone.launcher.create" })}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void handleOpenExistingFolder()}
            >
              {intl.formatMessage({ id: "robindone.launcher.openFolder" })}
            </Button>
            <Button variant="ghost" onClick={onOpenWorkspaceViaPicker}>
              {intl.formatMessage({ id: "robindone.launcher.advancedOpen" })}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
