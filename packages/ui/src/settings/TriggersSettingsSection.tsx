import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input.js";
import { useRobinDoneIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import {
  useTriggerPythonRuntimeStatus,
  type TriggerPythonRuntimeStatus,
} from "@/settings/useTriggerPythonRuntimeStatus.js";

/**
 * 触发器设置分区（2026-11-25 常驻脚本并发配额可配置化，docs/trigger-system.md
 * 「资源与重入控制」）：AppSettings triggerScriptResidentPerWorkspace / triggerScriptResidentGlobalMax。
 * 引擎每轮 reconcile（≤5s）起点读取，改动无需重启；定时执行模式的运行不占配额。
 * 2026-11-26 追加 python 主运行时供给状态卡（打包内置改造：下载兜底的进度可见性）。
 */

const QUOTA_MIN = 1;
const QUOTA_MAX_PER_WORKSPACE = 200;
const QUOTA_MAX_GLOBAL = 1000;

function formatMegabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** python 运行时供给状态文案（纯展示，不含操作；下载进度按字节实时刷新）。 */
function PythonRuntimeStatusControl({ status }: { status: TriggerPythonRuntimeStatus }) {
  const { intl } = useRobinDoneIntl();
  let text: string;
  switch (status.kind) {
    case "unknown":
      text = intl.formatMessage({ id: "settings.triggers.pythonRuntime.unknown" });
      break;
    case "probing":
      text = intl.formatMessage({ id: "settings.triggers.pythonRuntime.probing" });
      break;
    case "downloading":
      text =
        status.totalBytes !== null
          ? intl.formatMessage(
              { id: "settings.triggers.pythonRuntime.downloading" },
              {
                downloaded: formatMegabytes(status.downloadedBytes),
                total: formatMegabytes(status.totalBytes),
              },
            )
          : intl.formatMessage(
              { id: "settings.triggers.pythonRuntime.downloadingNoTotal" },
              { downloaded: formatMegabytes(status.downloadedBytes) },
            );
      break;
    case "available":
      text = intl.formatMessage({
        id:
          status.source === "system"
            ? "settings.triggers.pythonRuntime.availableSystem"
            : "settings.triggers.pythonRuntime.available",
      });
      break;
    case "unavailable":
      text = intl.formatMessage(
        { id: "settings.triggers.pythonRuntime.unavailable" },
        // 状态文件口径：错误串截断展示（完整原因见引擎日志）。
        { error: status.error.length > 160 ? `${status.error.slice(0, 160)}…` : status.error },
      );
      break;
  }
  return (
    <span
      data-testid="settings-triggers-python-runtime-status"
      className="text-ui-base leading-5 text-foreground-subtle"
    >
      {text}
    </span>
  );
}

/** 数字输入：失焦/回车提交，非法输入回显当前生效值（配额是兜底参数，不做即时校验打断）。 */
function QuotaNumberInput({
  value,
  min,
  max,
  testId,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  testId: string;
  onCommit: (next: number) => void;
}) {
  const { intl } = useRobinDoneIntl();
  const [draft, setDraft] = useState(String(value));

  // 外部值变化（如另一端修改）同步进草稿；仅在无编辑中草稿差异时覆盖，避免打断输入。
  useEffect(() => {
    setDraft((current) => (current === String(value) ? current : String(value)));
  }, [value]);

  const commit = () => {
    const parsed = Number(draft.trim());
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      setDraft(String(value));
      return;
    }
    setDraft(String(parsed));
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <Input
      data-testid={testId}
      aria-label={intl.formatMessage({ id: "settings.triggers.title" })}
      inputMode="numeric"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
      className="w-24"
    />
  );
}

export function TriggersSettingsSection({
  residentPerWorkspace,
  residentGlobalMax,
  onResidentPerWorkspaceChange,
  onResidentGlobalMaxChange,
}: {
  residentPerWorkspace: number;
  residentGlobalMax: number;
  onResidentPerWorkspaceChange: (next: number) => Promise<void>;
  onResidentGlobalMaxChange: (next: number) => Promise<void>;
}) {
  const { intl } = useRobinDoneIntl();
  const pythonRuntimeStatus = useTriggerPythonRuntimeStatus();
  return (
    <SettingsGroupCard>
      <SettingsRow
        controlLayout="wide"
        label={intl.formatMessage({ id: "settings.triggers.pythonRuntime.label" })}
        description={intl.formatMessage({ id: "settings.triggers.pythonRuntime.description" })}
        control={<PythonRuntimeStatusControl status={pythonRuntimeStatus} />}
      />
      <SettingsRow
        controlLayout="wide"
        label={intl.formatMessage({ id: "settings.triggers.residentPerWorkspace" })}
        description={intl.formatMessage({
          id: "settings.triggers.residentPerWorkspaceDescription",
        })}
        control={
          <QuotaNumberInput
            value={residentPerWorkspace}
            min={QUOTA_MIN}
            max={QUOTA_MAX_PER_WORKSPACE}
            testId="settings-triggers-resident-per-workspace"
            onCommit={(next) => {
              void onResidentPerWorkspaceChange(next);
            }}
          />
        }
      />
      <SettingsRow
        controlLayout="wide"
        label={intl.formatMessage({ id: "settings.triggers.residentGlobalMax" })}
        description={intl.formatMessage({
          id: "settings.triggers.residentGlobalMaxDescription",
        })}
        control={
          <QuotaNumberInput
            value={residentGlobalMax}
            min={QUOTA_MIN}
            max={QUOTA_MAX_GLOBAL}
            testId="settings-triggers-resident-global-max"
            onCommit={(next) => {
              void onResidentGlobalMaxChange(next);
            }}
          />
        }
      />
    </SettingsGroupCard>
  );
}
