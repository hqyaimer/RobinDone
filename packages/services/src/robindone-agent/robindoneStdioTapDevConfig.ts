import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RobinDoneStdioTapDevState } from "@robindone/shared";
import { getAppConfigDir } from "#src/paths.js";
import { isEffectiveDevelopmentNodeEnv } from "#src/runtime-tools/nodeEnv.js";

interface RobinDoneStdioTapStateFile {
  enabled?: boolean;
}

export function isRobinDoneStdioTapDevVisible(): boolean {
  return isEffectiveDevelopmentNodeEnv();
}

export function getRobinDoneStdioTapDevDir(): string {
  return join(getAppConfigDir(), "dev");
}

export function getRobinDoneStdioTapDevLogDir(): string {
  return join(getRobinDoneStdioTapDevDir(), "stdio-traffic");
}

export function getRobinDoneStdioTapDevStatePath(): string {
  return join(getRobinDoneStdioTapDevDir(), "robindone-stdio-tap.json");
}

function readStateFile(path: string): RobinDoneStdioTapStateFile {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as RobinDoneStdioTapStateFile) : {};
  } catch {
    return {};
  }
}

export function readRobinDoneStdioTapDevState(): RobinDoneStdioTapDevState {
  const visible = isRobinDoneStdioTapDevVisible();
  const statePath = getRobinDoneStdioTapDevStatePath();
  const fileState = readStateFile(statePath);
  return {
    enabled: visible && fileState.enabled === true,
    visible,
    logDir: getRobinDoneStdioTapDevLogDir(),
    statePath,
  };
}

export function setRobinDoneStdioTapDevEnabled(enabled: boolean): RobinDoneStdioTapDevState {
  const visible = isRobinDoneStdioTapDevVisible();
  const statePath = getRobinDoneStdioTapDevStatePath();
  mkdirSync(getRobinDoneStdioTapDevDir(), { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        // 开发态 stdio 抓包是高频原始协议帧，只能通过显式开关写旁路文件，避免误进生产日志。
        enabled: visible && enabled,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return readRobinDoneStdioTapDevState();
}
