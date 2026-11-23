/**
 * robinrun-launcher 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import { sortRobinrunProjectsByRecency, upsertRobinrunProjectEntry } from "./projectRegistry.js";

export function exampleRobinrunLauncherRegistry(): void {
  // 冷启动候选：按最近使用排序后逐个校验目录存在性（失效条目跳过）。
  const candidates = sortRobinrunProjectsByRecency([]);
  // 打开入口统一 bump 最近使用：已注册则原地更新，否则追加（幂等）。
  const next = upsertRobinrunProjectEntry([], "E:/projects/demo");
  void candidates;
  void next;
}
