/**
 * auto-session-default-mode 标准调用示例：任务门面 createTask 在 mode 缺席时解析
 * 自动创建会话（触发器/ContactAgent 派发等宿主路径）的缺省权限。
 */
import type { ISettingService } from "../../setting/setting.js";
import { resolveAutoSessionDefaultMode, type AutoSessionDefaultMode } from "./contract.js";

export async function exampleAutoSessionDefaultMode(
  settingService: Pick<ISettingService, "get"> | undefined,
  workspacePath: string,
): Promise<AutoSessionDefaultMode | undefined> {
  if (!settingService) return undefined;
  // 读取失败按缺省处理（undefined = CLI 缺省 build），不阻断会话创建。
  const settings = await settingService.get().catch(() => undefined);
  return resolveAutoSessionDefaultMode({ settings, workspacePath });
}
