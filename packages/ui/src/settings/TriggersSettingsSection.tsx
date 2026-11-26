import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input.js";
import { useRobinRunIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 触发器设置分区（2026-11-25 常驻脚本并发配额可配置化，docs/trigger-system.md
 * 「资源与重入控制」）：AppSettings triggerScriptResidentPerWorkspace / triggerScriptResidentGlobalMax。
 * 引擎每轮 reconcile（≤5s）起点读取，改动无需重启；定时执行模式的运行不占配额。
 */

const QUOTA_MIN = 1;
const QUOTA_MAX_PER_WORKSPACE = 200;
const QUOTA_MAX_GLOBAL = 1000;

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
  const { intl } = useRobinRunIntl();
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
  const { intl } = useRobinRunIntl();
  return (
    <SettingsGroupCard>
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
