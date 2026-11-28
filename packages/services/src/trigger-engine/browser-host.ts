import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@robindone/shared/node";
import { triggerProfilesDirectoryName } from "@robindone/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { TriggerBrowserRuntimePort } from "./browser-runtime.js";
import {
  createPlaywrightCdpDataPlane,
  type StorageStateJson,
  type TriggerCdpDataPlane,
} from "./browser-cdp.js";

/**
 * 引擎托管浏览器实例层（2026-11-25，specs/trigger-browser-hosting.md §3.2）：
 * 引擎创建并持有 chromium 实例（每脚本实例 + 档案级串行队列），脚本经
 * `ROBINDONE_CDP_ENDPOINT` 接入（playwright connect_over_cdp），不自带启动逻辑。
 *
 * 生命周期：
 * - acquire(profile, headed)：档案级 FIFO 取号（同 profile 同时至多一个实例——防同账号
 *   并发互踢/写冲突，既有裁决）→ ensureBrowser（缓存/下载/系统回退）→ 注入登录态启动
 *   （--remote-debugging-port=0，stderr 解析 ws endpoint）→ 返回 CDP endpoint。
 * - release(profile, handle)：导出最终 storageState → 加密回写档案 → 杀进程树 → 出队。
 * - openLoginSession(profile, {url})：有头登录会话（open_login action 的引擎侧）——
 *   注入现有档案 + 直接落在 url 登录页，登录期每 3s 快照保留最后好快照，**用户关闭
 *   窗口即视为登录完成**（exit 与超时/引擎退出三态分开，2026-11-25 真机修复：exit 曾
 *   与超时共用标志被误报 timed out），落档返回。
 *
 * 凭据安全（AGENTS.md 条款）：storageState 文件整文件加密（cipher 回调注入，实现在
 * credential 模块的 CredentialCipherProvider）+ 私有权限原子写 + 跨进程文件锁；
 * 日志/审计只出现档案名，永不出现 storageState 内容；user-data-dir 临时目录随实例
 * 释放整目录删除（Chrome 自身的 cookie 库就在其中，不额外落明文 storageState 副本）。
 *
 * storageState 导出/注入走 CDP 数据面（browser-cdp.ts，playwright-core connectOverCDP
 * 动态 import，可注入假实现）；注入失败降级不阻塞启动（脚本自含登录检测兜底闭环）。
 */

const logger = createServiceLogger("trigger-engine-browser-host");

/** 登录会话兜底超时（用户一直不关窗也不会悬挂 open_login 调用）。 */
const LOGIN_SESSION_TIMEOUT_MS = 10 * 60_000;
/** 登录期 storageState 快照间隔。 */
const LOGIN_SNAPSHOT_INTERVAL_MS = 3_000;
/** chromium 启动 endpoint 等待超时。 */
const CDP_ENDPOINT_TIMEOUT_MS = 30_000;

export interface BrowserHostCipher {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export interface BrowserHandle {
  cdpEndpoint: string;
}

export interface AcquireResult {
  ok: true;
  handle: BrowserHandle;
  /** 本次实例的临时 user-data-dir（release 时随进程树一并清理）。 */
  userDataDir: string;
}

export type AcquireOutcome = AcquireResult | { ok: false; error: string };

export interface LoginSessionResult {
  ok: boolean;
  profile: string;
  error?: string;
}

export interface BrowserHostOptions {
  log?(message: string): void;
  /** 浏览器供给（缓存/下载/系统回退；browser-runtime.ts 的 port）。 */
  browserRuntime: TriggerBrowserRuntimePort;
  /** 档案加解密（host 装配注入 credential 模块的 provider；测试注入假实现）。 */
  cipher: BrowserHostCipher;
  /** CDP 数据面（storageState 导出/注入）。缺省 = playwright-core 真实实现。 */
  cdpDataPlane?: TriggerCdpDataPlane;
  /** 登录会话兜底超时（缺省 10 分钟；测试注入短超时）。 */
  loginTimeoutMs?: number;
  /** 登录期快照间隔（缺省 3s；测试注入更短）。 */
  snapshotIntervalMs?: number;
  /**
   * 测试钩子：替换 chromium spawn 实现（假进程/假 endpoint）。缺省 = 真实 spawn。
   * 返回的 child 需表现出真实 chrome 的可观察行为（stderr 打 ws 地址 / exit 事件）。
   */
  launchBrowser?(params: {
    executablePath: string;
    args: string[];
    headed: boolean;
  }): Promise<{ child: ChildProcess; cdpEndpoint: string }>;
}

interface RunningInstance {
  profile: string;
  workspacePath: string;
  child: ChildProcess;
  userDataDir: string;
  cdpEndpoint: string;
  /** chromium 进程自行退出（崩溃/被用户关闭）→ 通知等待方并清队。 */
  exited: Promise<void>;
}

export class TriggerBrowserHost {
  private readonly instances = new Map<string, RunningInstance>();
  /** 档案级等待队列（FIFO；key = profile）。 */
  private readonly waiters = new Map<string, Array<() => void>>();
  /** 登录期快照旁路（profile → 最后好快照）；关窗落档时消费。 */
  private readonly loginSnapshots = new Map<string, StorageStateJson>();
  /** 快照导出在飞标志（防 3s 轮询堆积）。 */
  private readonly loginSnapshotInFlight = new Map<string, boolean>();
  private readonly cdpPlane: TriggerCdpDataPlane;
  private readonly loginTimeoutMs: number;
  private readonly snapshotIntervalMs: number;
  private disposed = false;

  constructor(private readonly options: BrowserHostOptions) {
    this.cdpPlane =
      options.cdpDataPlane ?? createPlaywrightCdpDataPlane((message) => this.log(message));
    this.loginTimeoutMs = options.loginTimeoutMs ?? LOGIN_SESSION_TIMEOUT_MS;
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? LOGIN_SNAPSHOT_INTERVAL_MS;
  }

  private get log(): (message: string) => void {
    return this.options.log ?? ((message: string) => void logger.info(message));
  }

  profileFile(workspacePath: string, profile: string): string {
    return join(
      workspacePath,
      ".robindone",
      "triggers",
      triggerProfilesDirectoryName,
      `${profile}.json`,
    );
  }

  /** 档案级串行取号：同 profile 已有实例 → 排队等待 release 出队。 */
  private async waitForProfileSlot(profile: string): Promise<void> {
    if (!this.instances.has(profile)) return;
    await new Promise<void>((resolve) => {
      const queue = this.waiters.get(profile) ?? [];
      queue.push(resolve);
      this.waiters.set(profile, queue);
    });
  }

  private releaseProfileSlot(profile: string): void {
    const queue = this.waiters.get(profile);
    const next = queue?.shift();
    if (queue !== undefined && queue.length === 0) this.waiters.delete(profile);
    next?.();
  }

  /** 读档案（解密）；档案不存在返回 undefined（全新登录态）。 */
  async readProfile(workspacePath: string, profile: string): Promise<StorageStateJson | undefined> {
    const file = this.profileFile(workspacePath, profile);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return undefined;
    }
    try {
      return JSON.parse(this.options.cipher.decrypt(raw.trim())) as StorageStateJson;
    } catch (error) {
      // 解密失败 = 档案损坏或密钥轮换：按全新登录态处理并留痕（不删原文件，可追溯）。
      this.log(
        `profile ${profile} unreadable (treating as fresh login state): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }

  /** 写档案（加密 + 私有权限原子写 + 文件锁；只记档案名，内容永不进日志）。 */
  async writeProfile(
    workspacePath: string,
    profile: string,
    storageState: StorageStateJson,
  ): Promise<void> {
    const file = this.profileFile(workspacePath, profile);
    await mkdir(join(file, ".."), { recursive: true });
    const payload = `${this.options.cipher.encrypt(JSON.stringify(storageState))}\n`;
    await withFileLock(file, async () => {
      await atomicWritePrivateTextFile(file, payload);
    });
  }

  /**
   * 为脚本执行取一个浏览器实例（档案级串行）。失败返回 {ok:false}（supervisor 按一次
   * 崩溃收口）；成功返回 CDP endpoint（buildSpawnPlan 注入 env）。
   */
  async acquire(workspacePath: string, profile: string, headed: boolean): Promise<AcquireOutcome> {
    if (this.disposed) return { ok: false, error: "browser host is shutting down" };
    await this.waitForProfileSlot(profile);
    if (this.disposed) return { ok: false, error: "browser host is shutting down" };
    try {
      const runtime = await this.options.browserRuntime.ensureBrowser(workspacePath);
      if (!runtime.ok) return { ok: false, error: runtime.error };

      const userDataDir = join(tmpdir(), `robindone-trigger-browser-${randomUUID()}`);
      const storageState = await this.readProfile(workspacePath, profile);
      const launched = await this.launch(runtime.executablePath, {
        headed,
        userDataDir,
        storageState,
      });
      this.instances.set(profile, {
        profile,
        workspacePath,
        child: launched.child,
        userDataDir,
        cdpEndpoint: launched.cdpEndpoint,
        exited: this.watchExit(launched.child),
      });
      this.log(
        `browser instance ready for profile ${profile} (${runtime.source}, ${headed ? "headed" : "headless"})`,
      );
      return { ok: true, handle: { cdpEndpoint: launched.cdpEndpoint }, userDataDir };
    } catch (error) {
      this.releaseProfileSlot(profile);
      return {
        ok: false,
        error: `browser acquire failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 释放实例：导出最终 storageState 加密回写档案 → 杀进程树 → 清临时目录 → 出队。
   * 幂等（profile 不在运行表即空转）；storageState 导出失败不阻塞杀进程（登录态回写
   * 尽力而为，审计语义由调用方负责）。
   */
  async release(workspacePath: string, profile: string): Promise<void> {
    const instance = this.instances.get(profile);
    if (instance === undefined) return;
    this.instances.delete(profile);
    const storageState = await this.exportStorageState(instance.cdpEndpoint).catch(() => undefined);
    await this.killBrowser(instance.child);
    await rm(instance.userDataDir, { recursive: true, force: true }).catch(() => undefined);
    if (storageState !== undefined) {
      await this.writeProfile(workspacePath, profile, storageState).catch((error: unknown) => {
        this.log(
          `profile ${profile} write-back failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
    this.releaseProfileSlot(profile);
  }

  /**
   * 有头登录会话（open_login 的引擎侧，specs §3.2）：注入现有档案 → 有头启动（options.url
   * 作为启动参数，窗口直接落在登录页而非空白新标签页）→ 登录期每 3s 快照（保留最后好
   * 快照）→ **用户关闭窗口即登录完成** → 落档返回。三路 settle 分开判定（2026-11-25
   * 真机修复：此前 exit 与超时共用 pending 标志，用户关窗必被误报 "timed out (10 min)"）。
   */
  async openLoginSession(
    workspacePath: string,
    profile: string,
    options?: { url?: string },
  ): Promise<LoginSessionResult> {
    if (this.disposed) return { ok: false, profile, error: "browser host is shutting down" };
    await this.waitForProfileSlot(profile);
    if (this.disposed) return { ok: false, profile, error: "browser host is shutting down" };
    let instance: RunningInstance | undefined;
    let snapshotTimer: NodeJS.Timeout | undefined;
    try {
      const runtime = await this.options.browserRuntime.ensureBrowser(workspacePath);
      if (!runtime.ok) return { ok: false, profile, error: runtime.error };
      const userDataDir = join(tmpdir(), `robindone-trigger-login-${randomUUID()}`);
      const storageState = await this.readProfile(workspacePath, profile);
      const launched = await this.launch(runtime.executablePath, {
        headed: true, // 登录会话永远有头（用户要在窗口里操作）
        userDataDir,
        storageState,
        url: options?.url,
      });
      instance = {
        profile,
        workspacePath,
        child: launched.child,
        userDataDir,
        cdpEndpoint: launched.cdpEndpoint,
        exited: this.watchExit(launched.child),
      };
      this.instances.set(profile, instance);
      this.log(
        `headed login session opened for profile ${profile}${
          options?.url !== undefined ? ` landing on ${options.url}` : ""
        }`,
      );
      snapshotTimer = this.startLoginSnapshotLoop(instance);

      // 三路竞速，settle 原因分开锁定（??= 先到先写，互不覆盖）：
      //   exit = 用户关窗（登录完成）；timeout = 兜底超时；disposed = 引擎退出。
      let settle: "exit" | "timeout" | "disposed" | undefined;
      const exitWinner = instance.exited.then(() => {
        settle ??= "exit";
      });
      const timeoutWinner = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          settle ??= "timeout";
          resolve();
        }, this.loginTimeoutMs);
        timer.unref?.();
      });
      const disposedWinner = new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          if (this.disposed) {
            settle ??= "disposed";
            clearInterval(poll);
            resolve();
          }
        }, 200);
        poll.unref?.();
      });
      await Promise.race([exitWinner, timeoutWinner, disposedWinner]);
      clearInterval(snapshotTimer);
      snapshotTimer = undefined;

      if (settle === "exit") {
        // 关窗 = 登录完成：实时导出最终 storageState（关窗瞬间 context 可能已销毁——
        // 失败时用登录期最后好快照兜底，快照循环每 3s 保留过一份）。
        this.instances.delete(profile);
        const finalState =
          (await this.exportStorageState(instance.cdpEndpoint).catch(() => undefined)) ??
          this.loginSnapshots.get(profile);
        this.loginSnapshots.delete(profile);
        if (finalState === undefined) {
          await rm(instance.userDataDir, { recursive: true, force: true }).catch(() => undefined);
          this.releaseProfileSlot(profile);
          return {
            ok: false,
            profile,
            error: "browser closed before any login state was captured",
          };
        }
        await this.writeProfile(workspacePath, profile, finalState);
        await rm(instance.userDataDir, { recursive: true, force: true }).catch(() => undefined);
        this.releaseProfileSlot(profile);
        this.log(`login session for profile ${profile} completed; storage state saved`);
        return { ok: true, profile };
      }

      // 超时 / 引擎退出：杀进程收口（半截登录态不落档——落档语义只归"关窗完成"）。
      await this.killBrowser(instance.child);
      this.instances.delete(profile);
      this.loginSnapshots.delete(profile);
      await rm(instance.userDataDir, { recursive: true, force: true }).catch(() => undefined);
      this.releaseProfileSlot(profile);
      return {
        ok: false,
        profile,
        error:
          settle === "disposed"
            ? "engine is shutting down; login session closed"
            : `login session timed out (${Math.round(this.loginTimeoutMs / 60_000)} min); run open_login again (pass the site url) to retry`,
      };
    } catch (error) {
      if (snapshotTimer !== undefined) clearInterval(snapshotTimer);
      if (instance !== undefined) {
        await this.killBrowser(instance.child);
        this.instances.delete(profile);
        await rm(instance.userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
      this.loginSnapshots.delete(profile);
      this.releaseProfileSlot(profile);
      return {
        ok: false,
        profile,
        error: `login session failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 登录期快照循环（每 snapshotIntervalMs 导出一次保留最后好快照）——半截登录态也不丢：
   * 用户登录中途关窗（或崩溃），最后好快照仍可落档。返回定时器供 settle 后清理。
   */
  private startLoginSnapshotLoop(instance: RunningInstance): NodeJS.Timeout {
    const timer = setInterval(() => {
      if (this.loginSnapshotInFlight.get(instance.profile) === true) return;
      this.loginSnapshotInFlight.set(instance.profile, true);
      void this.exportStorageState(instance.cdpEndpoint)
        .then((state) => {
          if (state !== undefined) this.loginSnapshots.set(instance.profile, state);
        })
        .catch(() => undefined)
        .finally(() => {
          this.loginSnapshotInFlight.set(instance.profile, false);
        });
    }, this.snapshotIntervalMs);
    timer.unref?.();
    return timer;
  }

  /** 引擎退出：全部实例杀进程 + 清目录（档案回写尽力而为），无孤儿 chromium。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    const profiles = [...this.instances.keys()];
    for (const profile of profiles) {
      const instance = this.instances.get(profile);
      if (instance === undefined) continue;
      this.instances.delete(profile);
      const storageState = await this.exportStorageState(instance.cdpEndpoint).catch(
        () => undefined,
      );
      await this.killBrowser(instance.child);
      await rm(instance.userDataDir, { recursive: true, force: true }).catch(() => undefined);
      if (storageState !== undefined) {
        await this.writeProfile(instance.workspacePath, profile, storageState).catch(
          () => undefined,
        );
      }
      this.releaseProfileSlot(profile);
    }
    for (const queue of this.waiters.values()) {
      for (const resolve of queue) resolve();
    }
    this.waiters.clear();
  }

  // -------------------------------------------------------------------------
  // 内部：启动 / endpoint 解析 / storageState 数据面 / 进程树终止
  // -------------------------------------------------------------------------

  private async launch(
    executablePath: string,
    params: {
      headed: boolean;
      userDataDir: string;
      storageState?: StorageStateJson;
      url?: string;
    },
  ): Promise<{ child: ChildProcess; cdpEndpoint: string }> {
    await mkdir(params.userDataDir, { recursive: true });
    const args = [
      `--user-data-dir=${params.userDataDir}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      ...(params.headed ? [] : ["--headless=new"]),
    ];
    if (params.url !== undefined) {
      // 登录会话落点：open_login 传入的站点 URL 作为启动参数——窗口直接落在目标页，
      // 不再停在空白新标签页（2026-11-25 真机反馈：用户不知道要在空白窗口手动导航）。
      // 独立 --user-data-dir 保证这是隔离实例，不会被交给日常 Chrome（无进程交接）。
      args.push(params.url);
    }
    let child: ChildProcess;
    let cdpEndpoint: string;
    if (this.options.launchBrowser !== undefined) {
      ({ child, cdpEndpoint } = await this.options.launchBrowser({
        executablePath,
        args,
        headed: params.headed,
      }));
    } else {
      child = spawn(executablePath, args, {
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      cdpEndpoint = await this.parseCdpEndpoint(child, params.userDataDir);
    }
    // 注入档案登录态（CDP 数据面）：cookies 立即生效，localStorage 由 initScript 在每个
    // 新文档导航前按 origin 播种。尽力而为——失败降级不阻塞启动（脚本自含登录检测兜底）。
    if (params.storageState !== undefined) {
      try {
        await this.cdpPlane.inject(cdpEndpoint, params.storageState);
      } catch (error) {
        this.log(
          `storage state injection degraded (script-side login check covers): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return { child, cdpEndpoint };
  }

  /** stderr 的 "DevTools listening on ws://..." 行解析（chromeLocalStorageManager 同款模式）。 */
  private async parseCdpEndpoint(child: ChildProcess, userDataDir: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(`chromium did not report a CDP endpoint within ${CDP_ENDPOINT_TIMEOUT_MS}ms`),
        );
      }, CDP_ENDPOINT_TIMEOUT_MS);
      timer.unref?.();
      const onLine = (chunk: Buffer): void => {
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(chunk.toString("utf8"));
        if (match?.[1] !== undefined) {
          clearTimeout(timer);
          child.stderr?.off("data", onLine);
          // endpoint 落盘（user-data-dir 内；仅供调试与测试观察，不含凭据）。
          void writeFile(join(userDataDir, "robindone-cdp-endpoint.txt"), match[1], "utf8").catch(
            () => undefined,
          );
          resolve(match[1]);
        }
      };
      child.stderr?.on("data", onLine);
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("chromium exited before reporting a CDP endpoint"));
      });
    });
  }

  /** chromium 退出观察（崩溃/用户关窗 → resolved promise 供竞速）。 */
  private watchExit(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
  }

  /** storageState 导出（CDP 数据面，browser-cdp.ts；失败由数据面内部降级为 undefined）。 */
  private async exportStorageState(cdpEndpoint: string): Promise<StorageStateJson | undefined> {
    return this.cdpPlane.export(cdpEndpoint);
  }

  /** 进程树硬终止（taskkill /T /F 同款；覆盖 chromium 的 renderer/gpu 孙进程）。 */
  private async killBrowser(child: ChildProcess): Promise<void> {
    const pid = child.pid;
    if (pid === undefined || child.exitCode !== null) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // 已退出。
        }
      }
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 5_000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
