import type { Browser, BrowserContext, Cookie } from "playwright-core";

/**
 * 浏览器实例 CDP 数据面（2026-11-25 真机补全，specs/trigger-browser-hosting.md §3.2）：
 * storageState 的导出与注入——此前 exportStorageState 是返回 undefined 的占位、登录期
 * 快照循环从未实现，导致登录闭环永远落不了档（真机实锤：用户登录完关窗，档案仍为空）。
 *
 * 实现走 playwright-core connectOverCDP（对引擎 spawn 的 `--remote-debugging-port=0`
 * endpoint 连接后取默认 context）：
 * - export：`context.storageState()`（cookies + origins(localStorage)）。
 * - inject：`context.addCookies`（立即生效）+ `context.addInitScript`（localStorage 以
 *   origin 门控在每个新文档导航前播种——init script 是既无导航权又要求"脚本自己导航"
 *   形态下唯一可靠的 localStorage 注入位）。
 *
 * playwright-core 在 services 是可选能力（devDependency 只供类型；运行时经 desktop
 * tsup externals 保留 require，desktop package.json 已有同款依赖）。动态 import 失败
 * （裁剪环境）→ export 返回 undefined（调用方按"无登录态"降级）、inject 抛错（调用方
 * catch 后降级，脚本自含登录检测兜底闭环）。
 */

/** storageState 档案内容（Playwright storageState JSON：cookies + origins）。 */
export type StorageStateJson = Record<string, unknown>;

/** CDP 数据面端口（browser-host 注入点；测试注入假实现）。 */
export interface TriggerCdpDataPlane {
  /** 连接 endpoint 导出 storageState；失败/无 context 返回 undefined（不抛）。 */
  export(endpoint: string): Promise<StorageStateJson | undefined>;
  /** 把 storageState 注进运行中实例（cookies + localStorage initScript）；失败抛。 */
  inject(endpoint: string, state: StorageStateJson): Promise<void>;
}

interface PlaywrightStorageStateOrigins {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

/** addCookies 只接受这三个 sameSite 枚举；越界值归一为 Lax（Chrome cookie 常态）。 */
function normalizeCookie(cookie: Record<string, unknown>): Cookie {
  const sameSite = cookie.sameSite;
  return {
    ...cookie,
    sameSite: sameSite === "Strict" || sameSite === "Lax" || sameSite === "None" ? sameSite : "Lax",
  } as Cookie;
}

export function createPlaywrightCdpDataPlane(log: (message: string) => void): TriggerCdpDataPlane {
  async function connect(
    endpoint: string,
  ): Promise<{ browser: Browser; context: BrowserContext | undefined }> {
    const playwright = await import("playwright-core");
    const browser = await playwright.chromium.connectOverCDP(endpoint);
    return { browser, context: browser.contexts()[0] };
  }

  async function closeQuietly(browser: Browser | undefined): Promise<void> {
    // connectOverCDP 的 browser.close() 只断开连接不杀浏览器（实例生命周期归 browser-host）。
    await browser?.close().catch(() => undefined);
  }

  return {
    async export(endpoint) {
      let browser: Browser | undefined;
      try {
        const connection = await connect(endpoint);
        browser = connection.browser;
        if (connection.context === undefined) return undefined;
        return (await connection.context.storageState()) as StorageStateJson;
      } catch (error) {
        log(
          `storage state export over CDP failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return undefined;
      } finally {
        await closeQuietly(browser);
      }
    },

    async inject(endpoint, state) {
      let browser: Browser | undefined;
      try {
        const connection = await connect(endpoint);
        browser = connection.browser;
        if (connection.context === undefined) {
          throw new Error("no default browser context over CDP endpoint");
        }
        const cookies = Array.isArray(state.cookies)
          ? (state.cookies as Array<Record<string, unknown>>)
          : [];
        if (cookies.length > 0) {
          await connection.context.addCookies(cookies.map(normalizeCookie));
        }
        const origins = Array.isArray(state.origins)
          ? (state.origins as PlaywrightStorageStateOrigins[])
          : [];
        if (origins.length > 0) {
          const seed: Record<string, Record<string, string>> = {};
          for (const entry of origins) {
            const bucket: Record<string, string> = {};
            for (const item of entry.localStorage ?? []) {
              bucket[item.name] = item.value;
            }
            seed[entry.origin] = bucket;
          }
          await connection.context.addInitScript(
            `(() => { try { const seed = ${JSON.stringify(seed)}; const s = seed[location.origin]; if (s) { for (const [k, v] of Object.entries(s)) { try { localStorage.setItem(k, String(v)); } catch {} } } } catch {} })();`,
          );
        }
      } finally {
        await closeQuietly(browser);
      }
    },
  };
}
