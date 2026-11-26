import { mkdir, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";

/**
 * 本地 loopback webhook server（2026-11-19 设计，docs/trigger-engine.md「触发器类型 →
 * 本地 webhook」）。仅绑 127.0.0.1；每个 webhook 触发器一条路由（path 段 + token 双重
 * 校验），请求体作为事件载荷投递。
 *
 * 端口策略（2026-11-20 用户裁决）：首选固定端口（TRIGGER_WEBHOOK_DEFAULT_PORT），地址
 * 对用户稳定、不用每次重启重新配置；被占用（EADDRINUSE）时回退动态分配，实际地址以
 * 快照 webhookBaseUrl / webhook.json 为准。脚本/webhook 触发器的配置URL 拼接见 UI。
 *
 * 信任边界：本机进程可探测端口但拿不到 per-trigger token（只注册表里有），token 错误
 * 返回 401。外部平台 webhook（公网入口）依赖后端，不在本服务范围。
 *
 * python 脚本 emit 端点（2026-11-22 python 主运行时改造，docs/trigger-python-runtime.md
 * §3.4）：`POST __robinrun/emit/<trg-id>`，python 脚本经注入的 robinrun.py 助手上报事件。
 * 无 token（用户裁决）：路由只解析到 supervisor 运行注册表里**正在运行**的引擎托管脚本，
 * 本地进程既难知存活触发器 id、也无法给未运行触发器投事件；响应统一 200 + `{ok, error?}`
 * （契约校验同步完成后才响应，python 获得与 node IPC 对等的 ack 语义）。
 */

/** 本地 webhook 服务首选端口：固定默认值，用户侧地址跨重启稳定。 */
export const TRIGGER_WEBHOOK_DEFAULT_PORT = 43110;

/** python 脚本 emit 端点路径前缀（`__robinrun/emit/<trg-id>`；内部保留段，webhook
 * 触发器的 path schema 不允许下划线开头，不会与用户路由冲突）。 */
export const TRIGGER_EMIT_ROUTE_PREFIX = "__robinrun/emit/" as const;

/** 脚本暂停/登录失败端点路径前缀（`__robinrun/pause/<trg-id>`；2026-11-25 登录闭环，
 * specs/trigger-browser-hosting.md §3.4：脚本自含登录检测失败时上报，引擎停用触发器 +
 * 唤醒订阅者。同一保留段约定，不与用户路由冲突）。 */
export const TRIGGER_PAUSE_ROUTE_PREFIX = "__robinrun/pause/" as const;

/**
 * 把 webhook 服务的 loopback 基址持久化到工作区 `state/webhook.json`（2026-11-19
 * 验收补充；2026-11-25 从 engine.ts 挪入本文件——webhook 主题聚合 + 引擎行数上限）：
 * 端口由 host 进程动态分配，CLI 进程的 ManageTriggers 无法从内存得知，agent 建触发器
 * 时拿不到可回调的完整 URL。工具侧读这份文件拼 URL；引擎重启换端口后下次挂载自动
 * 覆盖为新值。写失败只记日志（投递不受影响，URL 可后补查询）。
 */
export async function persistWebhookBaseUrlFile(
  triggersRootPath: string,
  baseUrl: string | undefined,
  log: (message: string) => void,
): Promise<void> {
  if (baseUrl === undefined) return;
  try {
    const target = join(triggersRootPath, "state", "webhook.json");
    await mkdir(dirname(target), { recursive: true });
    const payload = `${JSON.stringify({ version: 1, baseUrl, updatedAt: new Date().toISOString() }, null, 2)}\n`;
    const temp = `${target}.tmp.${process.pid}`;
    await writeFile(temp, payload, "utf8");
    await rename(temp, target);
  } catch (error) {
    log(
      `failed to persist webhook base url: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface WebhookRouteResolution {
  workspacePath: string;
  triggerId: string;
}

/** emit 处理结果：ok=已受理/已投递；rejected=校验未过（error 带原因，脚本可感知）。 */
export interface ScriptEmitResult {
  ok: boolean;
  error?: string;
}

export interface LocalWebhookServerOptions {
  /** 按 path+token 解析路由（引擎注入：遍历当前注册表的 webhook 触发器）。 */
  resolveRoute(path: string, token: string | undefined): WebhookRouteResolution | undefined;
  onEvent(resolution: WebhookRouteResolution, body: unknown): void;
  /**
   * python 脚本 emit（2026-11-22）：按触发器 id 处理 POST 事件（形状/契约校验 + 投递，
   * 与 node IPC 同一条路径）；返回 undefined = 无此运行中脚本（404）。
   */
  onScriptEmit?(
    triggerId: string,
    event: Record<string, unknown>,
  ): Promise<ScriptEmitResult | undefined>;
  /**
   * 脚本暂停上报（2026-11-25 登录闭环）：body `{reason}`；引擎停用触发器（error-paused）
   * + 唤醒订阅者 + 停脚本。返回 undefined = 无此运行中脚本（404）。
   */
  onScriptPause?(triggerId: string, reason: string): Promise<ScriptEmitResult | undefined>;
  log(message: string): void;
  /** 首选固定端口；缺席用 TRIGGER_WEBHOOK_DEFAULT_PORT。 */
  preferredPort?: number;
}

const MAX_BODY_BYTES = 1024 * 1024;

function isPortInUseError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  // EADDRINUSE = 端口被占用；EACCES = Windows 保留端口段（Hyper-V 排除范围）——
  // 两者都回退动态分配，不能让首选端口不可用阻断引擎启动。
  return code === "EADDRINUSE" || code === "EACCES";
}

export class LocalWebhookServer {
  private server: Server | undefined;
  private baseUrlValue: string | undefined;

  constructor(private readonly options: LocalWebhookServerOptions) {}

  get baseUrl(): string | undefined {
    return this.baseUrlValue;
  }

  async start(): Promise<void> {
    if (this.server !== undefined) return;
    const preferredPort = this.options.preferredPort ?? TRIGGER_WEBHOOK_DEFAULT_PORT;
    try {
      await this.listenOn(preferredPort);
    } catch (error) {
      if (!isPortInUseError(error)) throw error;
      // 固定端口被占用（其他进程/多实例）：回退动态分配，不阻断启动；实际地址以
      // 快照 webhookBaseUrl 为准（展示与复制都读它，不假设端口）。
      this.options.log(
        `preferred webhook port ${preferredPort} is in use; falling back to a random port`,
      );
      await this.listenOn(0);
    }
  }

  private listenOn(port: number): Promise<void> {
    const server = createServer((request, response) => {
      // 修复（2026-11-23）：handle 已内置整体兜底（见其注释），此处 .catch 仅作第二道
      // 保险——兜底本身抛错（如响应流已坏时 log 之外的操作）不再进 unhandledRejection。
      this.handle(request, response).catch((error: unknown) =>
        this.options.log(
          `webhook handler crashed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });
    // 只有成功绑定才接管 this.server；失败（如首选端口被占用）当场关闭，避免泄漏。
    return new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.close();
        reject(error);
      };
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        const address = server.address();
        if (address === null || typeof address === "string") {
          server.close();
          reject(new Error("webhook server failed to bind a loopback port"));
          return;
        }
        this.server = server;
        this.baseUrlValue = `http://127.0.0.1:${address.port}`;
        this.options.log(`local webhook server listening on ${this.baseUrlValue}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    this.baseUrlValue = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  /**
   * 请求处理入口（2026-11-23 加固）：整体兜底。此前 handle 直接暴露给 createServer 的
   * `void` 调用且无 catch——decodeURIComponent 对畸形百分号序列（如 %zz）抛 URIError、
   * 客户端中途断开令 readBody 的 for-await 抛错、响应流损坏时 respondJson 抛错，全部变成
   * unhandledRejection 崩掉 host 常驻进程；一个格式非法的 loopback 请求（触发器脚本 bug
   * 即可发出）不该有这个杀伤力。兜底统一回 400，响应已发出则只记日志。
   */
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      await this.handleRequest(request, response);
    } catch (error) {
      this.options.log(
        `webhook request handling failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!response.writableEnded) {
        try {
          respondJson(response, 400, { ok: false, error: "malformed request" });
        } catch {
          /* 响应流已坏（客户端断开），无法也无需再响应。 */
        }
      }
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", this.baseUrlValue ?? "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname.replace(/^\//, ""));
    // python 脚本 emit 端点（2026-11-22）：内部保留段，优先于 webhook 路由解析。
    if (pathname.startsWith(TRIGGER_EMIT_ROUTE_PREFIX)) {
      await this.handleScriptEmit(
        pathname.slice(TRIGGER_EMIT_ROUTE_PREFIX.length),
        request,
        response,
      );
      return;
    }
    // 脚本暂停/登录失败端点（2026-11-25 登录闭环）：同一保留段约定。
    if (pathname.startsWith(TRIGGER_PAUSE_ROUTE_PREFIX)) {
      await this.handleScriptPause(
        pathname.slice(TRIGGER_PAUSE_ROUTE_PREFIX.length),
        request,
        response,
      );
      return;
    }
    const token = request.headers["x-robinrun-token"] ?? url.searchParams.get("token") ?? undefined;
    const resolution = this.options.resolveRoute(
      pathname,
      typeof token === "string" ? token : undefined,
    );
    if (resolution === undefined) {
      // 401 与 404 不区分文案：不向探测者泄露路由存在性。
      response.statusCode = token === undefined ? 401 : 404;
      response.end();
      return;
    }

    const raw = await this.readBody(request, response);
    if (raw === undefined) return;
    let body: unknown = raw;
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      // 非 JSON 文本原样作为字符串载荷投递。
    }
    this.options.onEvent(resolution, body);
    // 202：事件已受理，异步处理（合并投递语义在引擎侧）。
    response.statusCode = 202;
    response.end();
  }

  /** python 脚本 emit：同步校验 + 投递 + ack 响应（与 node IPC 同一条校验路径）。 */
  private async handleScriptEmit(
    triggerId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (this.options.onScriptEmit === undefined) {
      respondJson(response, 404, { ok: false, error: "emit endpoint is not wired" });
      return;
    }
    const raw = await this.readBody(request, response);
    if (raw === undefined) return;
    let event: unknown;
    try {
      event = JSON.parse(raw) as unknown;
    } catch {
      respondJson(response, 400, { ok: false, error: "request body must be one JSON object" });
      return;
    }
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      respondJson(response, 400, {
        ok: false,
        error: "event must be a JSON object like { summary, data }",
      });
      return;
    }
    const result = await this.options.onScriptEmit(triggerId, event as Record<string, unknown>);
    if (result === undefined) {
      // 无此运行中脚本（未运行/已退出/不存在）：404 不区分原因，不向探测者泄露细节。
      respondJson(response, 404, { ok: false, error: "no running script for this trigger" });
      return;
    }
    // 统一 200 + {ok, error?}：契约违例对脚本是业务结果（robinrun.py 会 raise），不是 HTTP 错误。
    respondJson(response, 200, result);
  }

  /** 脚本暂停上报（2026-11-25 登录闭环；与 emit 同款信任面：仅引擎拉起的活脚本可达）。 */
  private async handleScriptPause(
    triggerId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (this.options.onScriptPause === undefined) {
      respondJson(response, 404, { ok: false, error: "pause endpoint is not wired" });
      return;
    }
    const raw = await this.readBody(request, response);
    if (raw === undefined) return;
    let reason = "";
    try {
      const parsed = JSON.parse(raw) as { reason?: unknown };
      reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 2_000) : "";
    } catch {
      reason = raw.slice(0, 2_000);
    }
    const result = await this.options.onScriptPause(triggerId, reason);
    if (result === undefined) {
      respondJson(response, 404, { ok: false, error: "no running script for this trigger" });
      return;
    }
    respondJson(response, 200, result);
  }

  /** 请求体读取（1MiB 上限；超限 413 并终止读取）。返回 undefined = 已响应。 */
  private async readBody(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<string | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        respondJson(response, 413, {
          ok: false,
          error: `request body exceeds ${MAX_BODY_BYTES} bytes`,
        });
        return undefined;
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}

function respondJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}
