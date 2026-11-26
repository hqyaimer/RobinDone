// 引擎托管浏览器实例层回归（2026-11-25，specs/trigger-browser-hosting.md）：
//  - acquire → 登录态注入（CDP 数据面）→ release → storageState 导出加密回写档案；
//  - 同档案串行（第二个 acquire 排队到第一个 release 之后）；
//  - openLoginSession 三态（2026-11-25 真机修复回归）：关窗（exit）= 登录完成落档 ok /
//    关窗但无任何登录态 → "closed before..."（不得误报 timed out）/ 兜底超时 → timed out；
//  - url 落点：open_login 传入的 url 出现在 chromium 启动参数；
//  - 快照兜底：实时导出失败（实例已死）时落档用登录期最后好快照；
//  - 凭据面：档案文件密文落盘（假 cipher 可逆），内容不进日志。
// 全链假化：launchBrowser 钩子注入假进程（可手动 emit exit），CDP 数据面注入假实现。
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TriggerBrowserHost, type BrowserHostCipher } from "../src/trigger-engine/browser-host.js";
import type { TriggerBrowserRuntimePort } from "../src/trigger-engine/browser-runtime.js";
import type { TriggerCdpDataPlane } from "../src/trigger-engine/browser-cdp.js";
import type { ChildProcess } from "node:child_process";

const PROFILE = "shop-main";
const STATE = { cookies: [{ name: "session", value: "fresh" }], origins: [] };

interface FakeLauncher {
  child: EventEmitter & Partial<ChildProcess>;
  endpoint: string;
  args: string[];
}

function makeRuntimePort(): TriggerBrowserRuntimePort {
  return {
    async ensureBrowser() {
      return { ok: true, executablePath: "fake-chrome", source: "managed" as const };
    },
  };
}

const cipher: BrowserHostCipher = {
  encrypt: (value) => `ENC:${Buffer.from(value).toString("base64")}`,
  decrypt: (value) => Buffer.from(value.replace(/^ENC:/, ""), "base64").toString("utf8"),
};

describe("TriggerBrowserHost（引擎托管浏览器）", () => {
  let workspace = "";
  const launched: FakeLauncher[] = [];

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "robinrun-trg-browser-"));
    launched.length = 0;
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  /** 假 launcher：endpoint 固定可预测，args 全量留档供断言；exit 由用例手动 emit。 */
  function makeHost(
    plane: TriggerCdpDataPlane,
    options?: { loginTimeoutMs?: number; snapshotIntervalMs?: number },
  ): TriggerBrowserHost {
    return new TriggerBrowserHost({
      browserRuntime: makeRuntimePort(),
      cipher,
      cdpDataPlane: plane,
      ...(options?.loginTimeoutMs !== undefined ? { loginTimeoutMs: options.loginTimeoutMs } : {}),
      ...(options?.snapshotIntervalMs !== undefined
        ? { snapshotIntervalMs: options.snapshotIntervalMs }
        : {}),
      launchBrowser: async ({ args, headed }) => {
        const child = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
        child.pid = 1000 + launched.length;
        child.spawnargs = args;
        child.kill = () => {
          child.emit("exit", 0, null);
          return true;
        };
        const endpoint = `ws://127.0.0.1:922${launched.length}${headed ? "-headed" : ""}`;
        launched.push({ child, endpoint, args });
        return { child: child as ChildProcess, cdpEndpoint: endpoint };
      },
    });
  }

  function makePlane(overrides?: Partial<TriggerCdpDataPlane>): TriggerCdpDataPlane & {
    injectCalls: Array<{ endpoint: string; state: unknown }>;
  } {
    const injectCalls: Array<{ endpoint: string; state: unknown }> = [];
    return {
      injectCalls,
      export: vi.fn(async () => undefined),
      inject: vi.fn(async (endpoint: string, state) => {
        injectCalls.push({ endpoint, state });
      }),
      ...overrides,
    };
  }

  it("acquire → CDP endpoint 返回 + 登录态注入；release → storageState 导出加密回写档案", async () => {
    const plane = makePlane();
    const host = makeHost(plane);
    // 预置档案（spawn 时注入路径）：acquire 应把档案登录态交给数据面注入。
    await host.writeProfile(workspace, PROFILE, STATE);
    const acquisition = await host.acquire(workspace, PROFILE, false);
    expect(acquisition.ok).toBe(true);
    if (!acquisition.ok) return;
    expect(acquisition.handle.cdpEndpoint).toContain("ws://");
    expect(plane.inject).toHaveBeenCalledTimes(1);
    expect(plane.injectCalls[0]!.state).toEqual(STATE);
    expect(launched[0]!.args.some((arg) => arg.startsWith("--user-data-dir="))).toBe(true);

    // release：实时导出 → 加密回写档案（密文，内容不落明文）。
    (plane.export as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      cookies: [{ name: "sid", value: "rotated" }],
      origins: [],
    });
    await host.release(workspace, PROFILE);
    const raw = await readFile(host.profileFile(workspace, PROFILE), "utf8");
    expect(raw.startsWith("ENC:")).toBe(true);
    expect(Buffer.from(raw.replace(/^ENC:/, ""), "base64").toString("utf8")).toContain("rotated");
    // 幂等：重复 release 不抛。
    await host.release(workspace, PROFILE);
  });

  it("同档案串行：第二个 acquire 排队，release 后出队", async () => {
    const host = makeHost(makePlane());
    const first = await host.acquire(workspace, PROFILE, false);
    expect(first.ok).toBe(true);

    let secondResolved = false;
    const second = host.acquire(workspace, PROFILE, false).then((result) => {
      secondResolved = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondResolved).toBe(false); // 仍在排队

    await host.release(workspace, PROFILE);
    const secondResult = await second;
    expect(secondResult.ok).toBe(true);
    await host.release(workspace, PROFILE);
  });

  it("openLoginSession：关窗（exit 先于超时）= 登录完成 → 实时导出落档 ok（不再误报 timed out）", async () => {
    const plane = makePlane({
      export: vi.fn(async () => STATE),
    });
    const host = makeHost(plane, { loginTimeoutMs: 60_000 });
    const pending = host.openLoginSession(workspace, PROFILE, {
      url: "https://passport.example.com",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // url 落点断言：登录窗口启动参数包含传入的登录页。
    expect(launched[launched.length - 1]!.args).toContain("https://passport.example.com");
    // 模拟用户登录完成关闭窗口：假进程 exit（早于 60s 超时）。
    (launched[launched.length - 1]!.child as EventEmitter).emit("exit", 0, null);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    // 落档内容 = 数据面实时导出。
    const raw = await readFile(host.profileFile(workspace, PROFILE), "utf8");
    expect(Buffer.from(raw.replace(/^ENC:/, ""), "base64").toString("utf8")).toContain("fresh");
  });

  it("openLoginSession：关窗但实时导出失败 → 登录期最后好快照兜底落档", async () => {
    // 快照循环 20ms 一拍；实例存活期间导出成功（快照捕获），exit 后导出失败（context 已销毁）。
    let alive = true;
    const plane = makePlane({
      export: vi.fn(async () => (alive ? STATE : undefined)),
    });
    const host = makeHost(plane, { loginTimeoutMs: 60_000, snapshotIntervalMs: 20 });
    const pending = host.openLoginSession(workspace, PROFILE);
    await new Promise((resolve) => setTimeout(resolve, 80)); // 等至少一拍快照
    alive = false;
    (launched[launched.length - 1]!.child as EventEmitter).emit("exit", 0, null);
    const result = await pending;
    expect(result.ok).toBe(true);
  });

  it("openLoginSession：关窗但从未捕获到登录态 → closed before ...（exit 不落超时文案）", async () => {
    const plane = makePlane(); // export 恒 undefined（登录期无快照、关窗后实时导出也空）
    const host = makeHost(plane, { loginTimeoutMs: 60_000, snapshotIntervalMs: 20 });
    const pending = host.openLoginSession(workspace, PROFILE);
    await new Promise((resolve) => setTimeout(resolve, 50));
    (launched[launched.length - 1]!.child as EventEmitter).emit("exit", 0, null);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("browser closed before any login state was captured");
  });

  it("openLoginSession：兜底超时（实例未关）→ timed out 文案", async () => {
    const plane = makePlane({ export: vi.fn(async () => STATE) });
    const host = makeHost(plane, { loginTimeoutMs: 150, snapshotIntervalMs: 20 });
    const pending = host.openLoginSession(workspace, PROFILE);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
    expect(result.error).not.toContain("closed before");
  });

  it("档案写入后可读回（cipher 往返），损坏档案按全新登录态处理不抛", async () => {
    const host = makeHost(makePlane());
    await host.writeProfile(workspace, PROFILE, { cookies: [] });
    const readBack = await host.readProfile(workspace, PROFILE);
    expect(readBack).toEqual({ cookies: [] });

    const { writeFile } = await import("node:fs/promises");
    await writeFile(host.profileFile(workspace, PROFILE), "not-encrypted-garbage", "utf8");
    const fresh = await host.readProfile(workspace, PROFILE);
    expect(fresh).toBeUndefined();
  });
});
