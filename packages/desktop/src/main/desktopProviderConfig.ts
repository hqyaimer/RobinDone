import { app } from "electron";
import { join } from "node:path";
import { ROBINDONE_ENV } from "@robindone/shared";

export function resolveRobinDoneBuiltinProviderConfigFilePath(options?: {
  readonly appPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isPackaged?: boolean;
  readonly resourcesPath?: string;
}): string {
  const explicitPath = (options?.env ?? process.env)[
    "ROBINDONE_BUILTIN_PROVIDER_CONFIG_FILE"
  ]?.trim();
  if (explicitPath) return explicitPath;
  if (options?.isPackaged ?? app.isPackaged) {
    return join(
      options?.resourcesPath ?? process.resourcesPath,
      "config/provider/robindone-builtin.json",
    );
  }
  // 开发态没有 resources 复制步骤，必须与构建注入的产品环境读取同一份源文件。
  const filename =
    ROBINDONE_ENV === "production" ? "robindone-builtin.json" : "robindone-builtin.test.json";
  return join(options?.appPath ?? app.getAppPath(), "../../config/provider", filename);
}
