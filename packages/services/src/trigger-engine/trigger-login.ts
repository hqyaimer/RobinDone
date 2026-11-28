import { appendAudit, type RegistryWritableState } from "./registry-io.js";
import type { TriggerEntry } from "@robindone/shared";
import type { TriggerBrowserHost } from "./browser-host.js";

/**
 * 有头登录会话的引擎服务面（P3 第二十三批自 engine.ts 拆出，文件行数上限；
 * 正身 specs/trigger-browser-hosting.md §3.4）：ManageTriggers `open_login` 反向请求
 * 抵达引擎的入口——校验条目形状（script 型 + profile 在场 + 浏览器端口在场）后委托
 * browserHost.openLoginSession（有头窗口 + 档案登录态注入 + 关窗落档），并审计
 * `{action:"open-login"}`。结果文案指引 agent 用 set_status 重新启用触发器（登录闭环
 * 的最后一腿）。
 */

export interface OpenTriggerLoginDeps {
  /** 工作区状态解析（engine 的 ensureWorkspace 投影；登录会话需要注册表与档案路径）。 */
  resolveState(workspacePath: string): Promise<RegistryWritableState>;
  browserHost?: TriggerBrowserHost;
  log(message: string): void;
}

export async function openTriggerLoginForEngine(
  deps: OpenTriggerLoginDeps,
  params: {
    workspacePath: string;
    triggerId: string;
    /** 登录会话落点（http/https URL）；透传给有头窗口作为启动导航页。 */
    url?: string;
  },
): Promise<{ ok: boolean; profile?: string; error?: string; guidance?: string[] }> {
  const guidance = [
    'After the login window closes and the profile is saved, re-enable the trigger with ManageTriggers set_status (status "active").',
    "Next time, pass the site login page as `url` so the window lands directly on it (e.g. https://passport.bilibili.com).",
  ];
  if (deps.browserHost === undefined) {
    return {
      ok: false,
      error:
        "engine-hosted browser is not wired in this host (open_login requires the desktop engine)",
    };
  }
  const state = await deps.resolveState(params.workspacePath);
  const trigger: TriggerEntry | undefined = state.registry?.triggers.find(
    (candidate) => candidate.id === params.triggerId,
  );
  if (trigger === undefined || trigger.deleted === true) {
    return { ok: false, error: `trigger ${params.triggerId} not found` };
  }
  if (trigger.config.kind !== "script") {
    return { ok: false, error: "open_login applies to script triggers only" };
  }
  if (trigger.config.profile === undefined) {
    return {
      ok: false,
      error: "this script trigger declares no login profile (config.profile is unset)",
      guidance,
    };
  }
  const result = await deps.browserHost.openLoginSession(
    params.workspacePath,
    trigger.config.profile,
    {
      url: params.url,
    },
  );
  void appendAudit(params.workspacePath, trigger.id, {
    action: "open-login",
    ok: result.ok,
    profile: trigger.config.profile,
    ...(params.url !== undefined ? { url: params.url } : {}),
    ...(result.ok ? {} : { error: result.error }),
  });
  deps.log(
    `open_login for ${trigger.id} (profile ${trigger.config.profile}${params.url !== undefined ? `, url ${params.url}` : ""}): ${
      result.ok ? "completed" : `failed — ${result.error ?? "unknown"}`
    }`,
  );
  return {
    ok: result.ok,
    profile: trigger.config.profile,
    ...(result.ok ? {} : { error: result.error }),
    guidance,
  };
}
