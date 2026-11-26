import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileSystemError,
  ManageTriggersInputSchema,
  type FileSystemPort,
  type TriggerRuntimeInstallRequest,
  type TriggerRuntimePort,
} from "@robinrun/contracts";
import {
  sessionKeyForTrigger,
  triggerPythonRuntimeStateFileName,
  triggerReadmeFileName,
  triggerRegistryFileName,
  triggerRegistrySchema,
  TRIGGER_REGISTRY_VERSION,
} from "@robinrun/shared";
import { manageTriggersHandler, manageTriggersToolEntry } from "../src/tool/handlers/manage-triggers.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "robinrun-manage-triggers-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

interface MemoryFileSystem extends FileSystemPort {
  files: Map<string, string>;
  directories: Set<string>;
}

function missingFile(path: string): Error {
  return createFileSystemError({ code: "not_found", message: `missing: ${path}`, path });
}

function createMemoryFileSystem(initial: Record<string, string> = {}): MemoryFileSystem {
  const files = new Map(Object.entries(initial));
  const directories = new Set<string>();
  return {
    files,
    directories,
    async stat(request) {
      const content = files.get(request.path);
      if (content === undefined) throw missingFile(request.path);
      return {
        kind: "file",
        path: request.path,
        mtimeMs: 1,
        revision: { id: "rev", mtimeMs: 1, sizeBytes: Buffer.byteLength(content), hash: "h" },
        sizeBytes: Buffer.byteLength(content, "utf8"),
      };
    },
    async readTextFile(request) {
      const content = files.get(request.path);
      if (content === undefined) throw missingFile(request.path);
      return {
        bytesRead: Buffer.byteLength(content, "utf8"),
        content,
        encoding: "utf8",
        lineEndings: "LF",
        path: request.path,
        revision: { id: "rev", mtimeMs: 1, sizeBytes: Buffer.byteLength(content), hash: "h" },
        sizeBytes: Buffer.byteLength(content, "utf8"),
        truncated: false,
      };
    },
    async writeTextFile(request) {
      files.set(request.path, request.content);
      return {
        path: request.path,
        bytesWritten: Buffer.byteLength(request.content, "utf8"),
        encoding: "utf8",
        lineEndings: "LF",
        revision: {
          id: "rev",
          mtimeMs: 1,
          sizeBytes: Buffer.byteLength(request.content, "utf8"),
          hash: "h",
        },
      };
    },
    async createDirectory(request) {
      directories.add(request.path);
      return { path: request.path };
    },
  } as MemoryFileSystem;
}

function contextWith(
  fileSystemPort: FileSystemPort | undefined,
  workerIdentity?: { workerId: string; workerName?: string },
  triggerRuntimePort?: TriggerRuntimePort,
): ToolExecutionContext {
  return {
    toolCallId: "tool_test",
    traceId: "trace_test",
    abortSignal: new AbortController().signal,
    fileSystemPort,
    workingDirectory: tmpDir,
    workspaceRoot: tmpDir,
    sessionId: "sess_test",
    ...(workerIdentity !== undefined ? { workerIdentity } : {}),
    ...(triggerRuntimePort !== undefined ? { triggerRuntimePort } : {}),
  } as ToolExecutionContext;
}

function registryPath(): string {
  return join(tmpDir, ".robinrun", "triggers", triggerRegistryFileName);
}

function readRegistry(fs: MemoryFileSystem) {
  return triggerRegistrySchema.parse(JSON.parse(fs.files.get(registryPath())!));
}

const VALID_CREATE_SCRIPT = {
  action: "create" as const,
  name: "comments-crawler",
  config: {
    kind: "script" as const,
    runtime: "node" as const,
    entry: "crawl.js",
  },
  contract: { minCount: 1, requiredFields: ["id", "text"] },
  readme: "Crawls post comments and reports new ones.",
};

describe("ManageTriggers tool", () => {
  it("creates a script trigger with id folder, README scaffold, script/log dirs, and registry entry", async () => {
    const fs = createMemoryFileSystem();

    const output = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse(VALID_CREATE_SCRIPT),
      contextWith(fs),
    )) as {
      trigger: { id: string; name: string; status: string; ownerAgentId: string };
      readmePath: string;
      scriptDirPath: string;
      triggerCount: number;
    };

    expect(output.trigger.name).toBe("comments-crawler");
    expect(output.trigger.status).toBe("active");
    expect(output.trigger.ownerAgentId).toBe("master");
    expect(output.trigger.id).toMatch(/^trg-[0-9a-f]{8}$/);
    expect(output.triggerCount).toBe(1);

    // README 落在 id 目录下：说明正文 + 系统参考段（含会话 key 与熔断指引）。
    const readme = fs.files.get(output.readmePath)!;
    expect(readme).toContain("# Trigger: comments-crawler");
    expect(readme).toContain("Crawls post comments");
    expect(readme).toContain(sessionKeyForTrigger({ id: output.trigger.id, groupId: null }));
    expect(readme).toContain("error-paused");
    expect(fs.directories.has(output.scriptDirPath)).toBe(true);
    expect(fs.directories.has(join(tmpDir, ".robinrun", "triggers", output.trigger.id, "log"))).toBe(
      true,
    );

    // 注册表是合法 JSON 且可被共享 schema 校验回读；常驻模型不再写 schedule/timeoutMs。
    const registry = readRegistry(fs);
    expect(registry.triggers).toHaveLength(1);
    expect(registry.triggers[0]?.config).toMatchObject({ kind: "script" });
    expect("schedule" in registry.triggers[0]!.config).toBe(false);
    expect(registry.triggers[0]?.contract).toEqual(VALID_CREATE_SCRIPT.contract);

    // 2026-11-25 定时执行模式：resident 缺省落库 runMode="resident"（零迁移）。
    expect(registry.triggers[0]?.config).toMatchObject({ runMode: "resident" });
  });

  // 2026-11-25 定时执行模式（runMode/schedule 交叉约束）：scheduled 必带 schedule，
  // resident 禁带（schedule 随 runMode 转正，杜绝"写了却不生效"的歧义）。
  it("runMode=scheduled 缺 schedule 拒绝；resident 带 schedule 拒绝；scheduled 落库携带计划", async () => {
    const fs = createMemoryFileSystem();

    expect(() =>
      ManageTriggersInputSchema.parse({
        ...VALID_CREATE_SCRIPT,
        config: { ...VALID_CREATE_SCRIPT.config, runMode: "scheduled" },
      }),
    ).toThrow(/scheduled.*requires a schedule/i);

    expect(() =>
      ManageTriggersInputSchema.parse({
        ...VALID_CREATE_SCRIPT,
        config: {
          ...VALID_CREATE_SCRIPT.config,
          schedule: { kind: "interval", intervalMinutes: 5 },
        },
      }),
    ).toThrow(/schedule is only valid with runMode/i);

    const output = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse({
        ...VALID_CREATE_SCRIPT,
        name: "periodic-check",
        config: {
          ...VALID_CREATE_SCRIPT.config,
          runMode: "scheduled",
          schedule: { kind: "interval", intervalMinutes: 30 },
        },
      }),
      contextWith(fs),
    )) as { trigger: { config: { runMode: string; schedule?: unknown } }; readmePath: string };

    expect(output.trigger.config).toMatchObject({
      runMode: "scheduled",
      schedule: { kind: "interval", intervalMinutes: 30 },
    });
    // README 脚手架钉 scheduled 生命周期语义（一趟采集即退、exit 0 不结束触发器）。
    const readme = fs.files.get(output.readmePath)!;
    expect(readme).toContain("scheduled execution mode");
    expect(readme).toContain("Do NOT loop, sleep, or wait");
  });

  it("generates webhook path and token when omitted", async () => {
    const fs = createMemoryFileSystem();
    const output = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse({
        action: "create",
        name: "build-hook",
        config: { kind: "webhook" as const },
        readme: "CI posts build events here.",
      }),
      contextWith(fs),
    )) as { trigger: { id: string }; webhookPath: string };

    expect(output.webhookPath).toBe(`hooks/${output.trigger.id}`);
    const registry = readRegistry(fs);
    const config = registry.triggers[0]?.config;
    if (config?.kind !== "webhook") throw new Error("expected webhook config");
    expect(config.path).toBe(`hooks/${output.trigger.id}`);
    expect(config.token).toMatch(/^[0-9a-f]{32}$/);
  });

  // webhook 端口暴露（2026-11-19 验收补充）：引擎基址持久化在 state/webhook.json，
  // 工具读取后拼完整回调 URL 给 agent；引擎缺席时 URL 缺席 + warning 指引。
  it("returns the full webhook url when the engine base url state exists", async () => {
    const fs = createMemoryFileSystem({
      [join(tmpDir, ".robinrun", "triggers", "state", "webhook.json")]: `${JSON.stringify(
        { version: 1, baseUrl: "http://127.0.0.1:19005", updatedAt: "2026-11-19T00:00:00.000Z" },
        null,
        2,
      )}\n`,
    });
    const output = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse({
        action: "create",
        name: "build-hook",
        config: { kind: "webhook" as const },
        readme: "CI posts build events here.",
      }),
      contextWith(fs),
    )) as { trigger: { id: string }; webhookUrl: string; webhookPath: string };

    expect(output.webhookUrl).toBe(
      `http://127.0.0.1:19005/${output.webhookPath}?token=${(readRegistry(fs).triggers[0]?.config as { token: string }).token}`,
    );
  });

  it("omits webhook url with a warning when the engine state file is missing", async () => {
    const fs = createMemoryFileSystem();
    const output = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse({
        action: "create",
        name: "build-hook",
        config: { kind: "webhook" as const },
        readme: "CI posts build events here.",
      }),
      contextWith(fs),
    )) as { webhookUrl?: string; warnings?: string[] };

    expect(output.webhookUrl).toBeUndefined();
    expect(output.warnings?.join(" ")).toContain("not running yet");
  });

  it("rejects script config referencing a missing profile", async () => {
    const fs = createMemoryFileSystem();
    await expect(
      manageTriggersHandler(
        ManageTriggersInputSchema.parse({
          ...VALID_CREATE_SCRIPT,
          config: {
            kind: "script" as const,
            runtime: "node" as const,
            entry: "crawl.js",
            profile: "main-site",
          },
        }),
        contextWith(fs),
      ),
    ).rejects.toThrow(/does not exist/);
  });

  it("creates a profile then a script trigger referencing it", async () => {
    const fs = createMemoryFileSystem();
    await manageTriggersHandler(
      ManageTriggersInputSchema.parse({
        action: "create_profile",
        profileName: "main-site",
        profileSites: ["https://example.com"],
      }),
      contextWith(fs),
    );
    await expect(
      manageTriggersHandler(
        ManageTriggersInputSchema.parse({
          ...VALID_CREATE_SCRIPT,
          config: {
            kind: "script" as const,
            runtime: "node" as const,
            entry: "crawl.js",
            profile: "main-site",
          },
        }),
        contextWith(fs),
      ),
    ).resolves.toBeDefined();
    // 重复建同名 profile 拒绝（profile 名是引用键，不允许重名）。
    await expect(
      manageTriggersHandler(
        ManageTriggersInputSchema.parse({ action: "create_profile", profileName: "main-site" }),
        contextWith(fs),
      ),
    ).rejects.toThrow(/already exists/);
    const registry = readRegistry(fs);
    expect(registry.profiles).toHaveLength(1);
    expect(registry.profiles[0]?.sites).toEqual(["https://example.com"]);
  });

  it("moves triggers into a group and back out, enforcing one-subscription-context exclusivity", async () => {
    const fs = createMemoryFileSystem();
    const first = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse(VALID_CREATE_SCRIPT),
      contextWith(fs),
    )) as { trigger: { id: string } };
    const second = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse({ ...VALID_CREATE_SCRIPT, name: "rank-crawler" }),
      contextWith(fs),
    )) as { trigger: { id: string } };

    const group = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse({
        action: "create_group",
        name: "operations-watch",
        memberTriggerIds: [first.trigger.id],
      }),
      contextWith(fs),
    )) as { group: { id: string; memberTriggerIds: string[] } };

    expect(group.group.id).toMatch(/^trggrp-[0-9a-f]{8}$/);
    expect(group.group.memberTriggerIds).toEqual([first.trigger.id]);

    let registry = readRegistry(fs);
    expect(registry.triggers[0]?.groupId).toBe(group.group.id);

    // 把第二个触发器并入组（并组后其事件投到组会话 key）。
    const updated = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse({
        action: "update_group",
        id: group.group.id,
        addMemberIds: [second.trigger.id],
      }),
      contextWith(fs),
    )) as { group: { memberTriggerIds: string[] } };
    expect(updated.group.memberTriggerIds).toHaveLength(2);

    // 订阅互斥（裁决 1）：已在组里的触发器不能被另一个组直接收编。
    const otherGroup = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse({ action: "create_group", name: "other-watch" }),
      contextWith(fs),
    )) as { group: { id: string } };
    await expect(
      manageTriggersHandler(
        ManageTriggersInputSchema.parse({
          action: "update_group",
          id: otherGroup.group.id,
          addMemberIds: [second.trigger.id],
        }),
        contextWith(fs),
      ),
    ).rejects.toThrow(/at most one group/);

    // 移出组回到直连订阅。
    await manageTriggersHandler(
      ManageTriggersInputSchema.parse({
        action: "update_group",
        id: group.group.id,
        removeMemberIds: [second.trigger.id],
      }),
      contextWith(fs),
    );
    registry = readRegistry(fs);
    const removed = registry.triggers.find((trigger) => trigger.id === second.trigger.id);
    expect(removed?.groupId).toBeNull();
  });

  it("clears the failure count when re-enabled from error-paused", async () => {
    const fs = createMemoryFileSystem();
    const created = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse(VALID_CREATE_SCRIPT),
      contextWith(fs),
    )) as { trigger: { id: string } };

    // 模拟引擎熔断后的注册表状态（连续 3 次异常 → error-paused）。
    const registry = JSON.parse(fs.files.get(registryPath())!);
    registry.triggers[0]!.status = "error-paused";
    registry.triggers[0]!.consecutiveFailures = 3;
    fs.files.set(registryPath(), `${JSON.stringify(registry, null, 2)}\n`);

    const output = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse({
        action: "set_status",
        id: created.trigger.id,
        status: "active",
      }),
      contextWith(fs),
    )) as { trigger: { status: string; consecutiveFailures: number } };
    expect(output.trigger.status).toBe("active");
    expect(output.trigger.consecutiveFailures).toBe(0);
  });

  it("delete 软删除：条目保留 deleted=true、组订阅解除，重复删除报业务错误", async () => {
    const fs = createMemoryFileSystem();
    const created = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse(VALID_CREATE_SCRIPT),
      contextWith(fs),
    )) as { trigger: { id: string } };
    await manageTriggersHandler(
      ManageTriggersInputSchema.parse({
        action: "create_group",
        name: "ops-group",
        memberTriggerIds: [created.trigger.id],
      }),
      contextWith(fs),
    );

    const output = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse({ action: "delete", id: created.trigger.id }),
      contextWith(fs),
    )) as { trigger: { id: string; deleted?: boolean; status: string; groupId: string | null } };
    expect(output.trigger).toMatchObject({
      id: created.trigger.id,
      deleted: true,
      status: "deactivated",
      groupId: null,
    });
    // 注册表条目保留（伪删除），组成员同步移除（双向闭合不变量）。
    const registry = readRegistry(fs);
    const entry = registry.triggers.find((trigger) => trigger.id === created.trigger.id);
    expect(entry?.deleted).toBe(true);
    expect(entry?.status).toBe("deactivated");
    expect(registry.groups[0]?.memberTriggerIds).toHaveLength(0);

    // 重复删除 → 业务错误（不可逆语义的显式提示）。
    await expect(
      manageTriggersHandler(
        ManageTriggersInputSchema.parse({ action: "delete", id: created.trigger.id }),
        contextWith(fs),
      ),
    ).rejects.toThrow(/already deleted/);
  });

  it("drops the contract when the config switches away from script", async () => {
    const fs = createMemoryFileSystem();
    const created = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse(VALID_CREATE_SCRIPT),
      contextWith(fs),
    )) as { trigger: { id: string } };

    const updated = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse({
        action: "update",
        id: created.trigger.id,
        config: { kind: "cron" as const, schedule: "0 9 * * *" },
      }),
      contextWith(fs),
    )) as { trigger: { config: { kind: string }; contract?: unknown } };
    expect(updated.trigger.config.kind).toBe("cron");
    expect(updated.trigger.contract).toBeUndefined();
    expect(readRegistry(fs).triggers[0]?.contract).toBeUndefined();
  });

  it("refuses to write over a corrupt registry", async () => {
    const fs = createMemoryFileSystem({
      [registryPath()]: "{ not json",
    });

    await expect(
      manageTriggersHandler(
        ManageTriggersInputSchema.parse(VALID_CREATE_SCRIPT),
        contextWith(fs),
      ),
    ).rejects.toThrow(/invalid/);
    expect(fs.files.get(registryPath())).toBe("{ not json");
  });

  it("treats a missing registry as empty for create", async () => {
    const fs = createMemoryFileSystem();
    const output = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse(VALID_CREATE_SCRIPT),
      contextWith(fs),
    )) as { triggerCount: number };
    expect(output.triggerCount).toBe(1);
  });

  it("fails with a business error for unknown trigger ids", async () => {
    const fs = createMemoryFileSystem();
    await expect(
      manageTriggersHandler(
        ManageTriggersInputSchema.parse({
          action: "set_status",
          id: "trg-00000000",
          status: "deactivated",
        }),
        contextWith(fs),
      ),
    ).rejects.toThrow(/No trigger with id/);
  });

  it("is registered with a workspace-scoped edit permission and runtime schemas", () => {
    expect(manageTriggersToolEntry.metadata.name).toBe("ManageTriggers");
    expect(manageTriggersToolEntry.permission?.permission).toBe("edit");
    expect(manageTriggersToolEntry.permission?.sideEffectScope).toBe("workspace");
    expect(manageTriggersToolEntry.runtimeOutputSchema).toBeDefined();
    expect(TRIGGER_REGISTRY_VERSION).toBe(1);
  });

  // 订阅者=创建者的机制层钉死（2026-11-22 实测修复）：worker 会话的模型不知道自己的
  // wkr-id（名册投影只进 master 会话），归属不能依赖模型传值——按执行上下文派生。
  it("derives the owner from the calling worker identity, ignoring a conflicting ownerAgentId", async () => {
    const fs = createMemoryFileSystem();
    const workerContext = contextWith(fs, { workerId: "wkr-5a67dec7", workerName: "运营专员" });

    const output = (await manageTriggersHandler(
      // 模型传了（幻觉/复述旧形状）ownerAgentId: "master" —— 必须被忽略。
      ManageTriggersInputSchema.parse({ ...VALID_CREATE_SCRIPT, ownerAgentId: "master" }),
      workerContext,
    )) as { trigger: { ownerAgentId: string }; warnings?: string[] };

    expect(output.trigger.ownerAgentId).toBe("wkr-5a67dec7");
    expect(output.warnings?.join(" ")).toContain("ignored");
    expect(readRegistry(fs).triggers[0]?.ownerAgentId).toBe("wkr-5a67dec7");

    // 组订阅者同规则：worker 会话建的组订阅该 worker。
    const group = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse({
        action: "create_group",
        name: "ops-watch",
        memberTriggerIds: [],
        ownerAgentId: "master",
      }),
      workerContext,
    )) as { group: { subscriberAgentId: string } };
    expect(group.group.subscriberAgentId).toBe("wkr-5a67dec7");
  });

  // ---- python 主运行时门控矩阵（2026-11-22，docs/trigger-python-runtime.md §4a）----

  function pythonStatePath(): string {
    return join(tmpDir, ".robinrun", "triggers", "state", triggerPythonRuntimeStateFileName);
  }

  function writePythonState(
    fs: MemoryFileSystem,
    state: "available" | "unavailable" | "probing",
    extra: { error?: string; interpreterPath?: string } = {},
  ): void {
    fs.files.set(
      pythonStatePath(),
      `${JSON.stringify(
        {
          version: 1,
          state,
          ...(state === "available"
            ? {
                interpreterPath: extra.interpreterPath ?? "C:/py/python.exe",
                source: "managed" as const,
              }
            : {}),
          ...(state === "unavailable" ? { error: extra.error ?? "download failed" } : {}),
          updatedAt: "2026-11-22T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );
  }

  const PYTHON_CREATE = {
    action: "create" as const,
    name: "py-watcher",
    config: { kind: "script" as const, runtime: "python" as const, entry: "watch.py" },
    readme: "Watches a feed with python.",
  };

  it("python 可用 → create runtime=node 拒绝（update 迁移路径在文案里）", async () => {
    const fs = createMemoryFileSystem();
    writePythonState(fs, "available");
    await expect(
      manageTriggersHandler(
        ManageTriggersInputSchema.parse(VALID_CREATE_SCRIPT),
        contextWith(fs),
      ),
    ).rejects.toThrow(/must use the python runtime[\s\S]*update action with runtime "python"/);
  });

  it("python 不可用/未探测 → create runtime=python 拒绝，node 备选放行", async () => {
    // 状态缺失（引擎未探测）。
    const missing = createMemoryFileSystem();
    await expect(
      manageTriggersHandler(
        ManageTriggersInputSchema.parse(PYTHON_CREATE),
        contextWith(missing),
      ),
    ).rejects.toThrow(/python is not available right now/);
    // unavailable（下载失败），错误原因出现在文案里。
    const unavailable = createMemoryFileSystem();
    writePythonState(unavailable, "unavailable", { error: "sha256 mismatch" });
    await expect(
      manageTriggersHandler(
        ManageTriggersInputSchema.parse(PYTHON_CREATE),
        contextWith(unavailable),
      ),
    ).rejects.toThrow(/sha256 mismatch/);
    // probing → 同样拒绝但文案区分。
    const probing = createMemoryFileSystem();
    writePythonState(probing, "probing");
    await expect(
      manageTriggersHandler(
        ManageTriggersInputSchema.parse(PYTHON_CREATE),
        contextWith(probing),
      ),
    ).rejects.toThrow(/still being provisioned/);
    // 同状态下 node 备选放行。
    const nodeOk = createMemoryFileSystem();
    writePythonState(nodeOk, "unavailable", { error: "offline" });
    const output = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse(VALID_CREATE_SCRIPT),
      contextWith(nodeOk),
    )) as { trigger: { config: { runtime: string } } };
    expect(output.trigger.config.runtime).toBe("node");
  });

  it("python 触发器 README 是 robinrun.emit 注入协议（HTTP emit，stdout 退役为日志），node 触发器 README 注明降级", async () => {
    const available = createMemoryFileSystem();
    writePythonState(available, "available");
    const pyOutput = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse(PYTHON_CREATE),
      contextWith(available),
    )) as { readmePath: string };
    const pyReadme = available.files.get(pyOutput.readmePath)!;
    // python 协议 = 注入的 robinrun.py 助手（`import robinrun` + emit()），HTTP 细节不外露。
    expect(pyReadme).toContain('robinrun.emit("short summary", data)');
    expect(pyReadme).toContain("audit logs only");
    expect(pyReadme).toContain("install_packages");
    expect(pyReadme).toContain("SIGTERM");
    expect(pyReadme).not.toContain("print ONE JSON event per stdout line");
    expect(pyReadme).not.toContain("onShutdown");

    const fallback = createMemoryFileSystem();
    writePythonState(fallback, "unavailable", { error: "offline" });
    const nodeOutput = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse(VALID_CREATE_SCRIPT),
      contextWith(fallback),
    )) as { readmePath: string };
    const nodeReadme = fallback.files.get(nodeOutput.readmePath)!;
    expect(nodeReadme).toContain("robinrun.emit");
    expect(nodeReadme).toContain("standard library only");
    expect(nodeReadme).toContain('runtime "python"');
  });

  it("update 换 runtime 受同一门控：node→python 要求可用，python 可用时传 node 配置拒绝", async () => {
    const available = createMemoryFileSystem();
    writePythonState(available, "available");
    // node 触发器先在不可用世界创建，随后 python 变为可用（模拟下载恢复）。
    const fs = createMemoryFileSystem();
    writePythonState(fs, "unavailable", { error: "offline" });
    const created = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse(VALID_CREATE_SCRIPT),
      contextWith(fs),
    )) as { trigger: { id: string } };
    // python 尚不可用：node→python 迁移被拒。
    await expect(
      manageTriggersHandler(
        ManageTriggersInputSchema.parse({
          action: "update",
          id: created.trigger.id,
          config: { kind: "script" as const, runtime: "python" as const, entry: "crawl.py" },
        }),
        contextWith(fs),
      ),
    ).rejects.toThrow(/python is not available right now/);
    // python 恢复后迁移放行；同一状态重传 node config 被拒。
    writePythonState(fs, "available");
    const migrated = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse({
        action: "update",
        id: created.trigger.id,
        config: { kind: "script" as const, runtime: "python" as const, entry: "crawl.py" },
      }),
      contextWith(fs),
    )) as { trigger: { config: { runtime: string } } };
    expect(migrated.trigger.config.runtime).toBe("python");
    await expect(
      manageTriggersHandler(
        ManageTriggersInputSchema.parse({
          action: "update",
          id: created.trigger.id,
          config: VALID_CREATE_SCRIPT.config,
        }),
        contextWith(fs),
      ),
    ).rejects.toThrow(/must use the python runtime/);
    // available 世界里新触发的存档（available 状态文件已写）与 available 世界里的 create 一致。
    void available;
  });

  it("install_packages 转发给 TriggerRuntimePort 并回填结构化结果；端口缺席报错引导", async () => {
    const calls: TriggerRuntimeInstallRequest[] = [];
    const port: TriggerRuntimePort = {
      async installPackages(request) {
        calls.push(request);
        return {
          ok: true,
          packages: request.packages,
          outputTail: "Successfully installed requests-2.32.3",
          restartedTriggerIds: ["trg-aaaaaaaa"],
        };
      },
    };
    const fs = createMemoryFileSystem();
    const output = (await manageTriggersHandler(
      ManageTriggersInputSchema.parse({
        action: "install_packages",
        packages: ["requests", "playwright==1.49.0"],
      }),
      contextWith(fs, undefined, port),
    )) as { installResult?: { ok: boolean; packages?: string[]; restartedTriggerIds?: string[] } };
    expect(output.installResult?.ok).toBe(true);
    expect(output.installResult?.packages).toEqual(["requests", "playwright==1.49.0"]);
    expect(output.installResult?.restartedTriggerIds).toEqual(["trg-aaaaaaaa"]);
    // 反向请求带会话锚点与工作区（宿主据此路由信封与定位引擎）。
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sessionId).toBe("sess_test");
    expect(calls[0]?.workspacePath).toBe(tmpDir);

    const noPort = createMemoryFileSystem();
    await expect(
      manageTriggersHandler(
        ManageTriggersInputSchema.parse({ action: "install_packages", packages: ["requests"] }),
        contextWith(noPort),
      ),
    ).rejects.toThrow(/requires the desktop trigger engine/);
  });

  // 系统特权订阅保护（2026-11-24 需求/审批/反馈面板，验收 #7 的工具侧一半）：
  // master/worker 经 ManageTriggers 停用/删除/修改 system 条目必须被拒绝，注册表不动；
  // create 侧由输入 schema 刻意不收 system config 形状兜底（模型无法伪造）。
  it("system 条目拒绝 set_status/delete/update，注册表保持原样", async () => {
    const systemEntry = {
      id: "trg-ops-panel",
      name: "运营面板订阅",
      ownerAgentId: "master",
      groupId: null,
      config: {
        kind: "system",
        events: ["requirement.created", "approval.decided", "feedback.created"],
      },
      status: "active",
      consecutiveFailures: 0,
      system: true,
      createdAt: "2026-11-24T00:00:00.000Z",
      updatedAt: "2026-11-24T00:00:00.000Z",
    };
    const fs = createMemoryFileSystem({
      [registryPath()]: `${JSON.stringify({
        version: TRIGGER_REGISTRY_VERSION,
        triggers: [systemEntry],
        groups: [],
        profiles: [],
      })}\n`,
    });

    await expect(
      manageTriggersHandler(
        ManageTriggersInputSchema.parse({
          action: "set_status",
          id: systemEntry.id,
          status: "deactivated",
        }),
        contextWith(fs, { workerId: "wkr-aaaaaaaa" }),
      ),
    ).rejects.toThrow(/system subscription/);
    await expect(
      manageTriggersHandler(
        ManageTriggersInputSchema.parse({ action: "delete", id: systemEntry.id }),
        contextWith(fs, undefined),
      ),
    ).rejects.toThrow(/system subscription/);
    await expect(
      manageTriggersHandler(
        ManageTriggersInputSchema.parse({ action: "update", id: systemEntry.id, name: "renamed" }),
        contextWith(fs, undefined),
      ),
    ).rejects.toThrow(/system subscription/);

    const registry = readRegistry(fs);
    expect(registry.triggers).toHaveLength(1);
    expect(registry.triggers[0]?.status).toBe("active");
    expect(registry.triggers[0]?.deleted).toBeUndefined();
    expect(registry.triggers[0]?.name).toBe("运营面板订阅");
  });

  it("create 输入无法伪造 system config（schema 刻意不收该形状）", () => {
    const forged = ManageTriggersInputSchema.safeParse({
      action: "create",
      name: "fake-subscription",
      config: { kind: "system", events: ["requirement.created"] },
      readme: "forge",
    });
    expect(forged.success).toBe(false);
  });

});
