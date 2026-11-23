import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileSystemError,
  ManageWorkersInputSchema,
  type FileSystemPort,
} from "@robinrun/contracts";
import {
  workerAgentsMdFileName,
  workerDefineMdFileName,
  workerRegistryFileName,
  workerRegistrySchema,
  WORKER_REGISTRY_VERSION,
} from "@robinrun/shared";
import { manageWorkersHandler, manageWorkersToolEntry } from "../src/tool/handlers/manage-workers.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "robinrun-manage-workers-"));
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

function contextWith(fileSystemPort: FileSystemPort | undefined): ToolExecutionContext {
  return {
    toolCallId: "tool_test",
    traceId: "trace_test",
    abortSignal: new AbortController().signal,
    fileSystemPort,
    workingDirectory: tmpDir,
    workspaceRoot: tmpDir,
    sessionId: "sess_test",
  } as ToolExecutionContext;
}

function registryPath(): string {
  return join(tmpDir, ".robinrun", "agents", workerRegistryFileName);
}

const VALID_CREATE = {
  action: "create" as const,
  name: "dev",
  description: "Development worker",
  prompt: "Handle coding tasks",
};

describe("ManageWorkers tool", () => {
  it("creates a worker with id folder, define.md duty definition, agents.md skeleton, and registry entry", async () => {
    const fs = createMemoryFileSystem();

    const output = (await manageWorkersHandler(
      ManageWorkersInputSchema.parse(VALID_CREATE),
      contextWith(fs),
    )) as {
      worker: { id: string; name: string; status: string };
      defineMdPath: string;
      agentsMdPath: string;
    };

    expect(output.worker.name).toBe("dev");
    expect(output.worker.status).toBe("active");
    expect(output.worker.id).toMatch(/^wkr-[0-9a-f]{8}$/);
    expect(output.rosterSize).toBe(1);

    // 裁决 10 双文件：define.md 承载职责定义（prompt 即正文，master 独占维护）。
    expect(output.defineMdPath).toBe(
      join(tmpDir, ".robinrun", "agents", output.worker.id, workerDefineMdFileName),
    );
    const defineMd = fs.files.get(output.defineMdPath);
    expect(defineMd).toContain("# Duty definition — dev");
    expect(defineMd).toContain("Handle coding tasks");

    // agents.md 只落自维护骨架（索引起点 + 职责边界声明），不携带职责正文。
    expect(output.agentsMdPath).toBe(
      join(tmpDir, ".robinrun", "agents", output.worker.id, workerAgentsMdFileName),
    );
    const agentsMd = fs.files.get(output.agentsMdPath);
    expect(agentsMd).toContain("## Index");
    expect(agentsMd).toContain("define.md");
    expect(agentsMd).not.toContain("Handle coding tasks");
    expect(fs.directories.has(join(tmpDir, ".robinrun", "agents", output.worker.id, "plan"))).toBe(
      true,
    );

    // 注册表是合法 JSON 且可被共享 schema 校验回读。
    const registry = workerRegistrySchema.parse(JSON.parse(fs.files.get(registryPath())!));
    expect(registry.workers).toHaveLength(1);
    expect(registry.workers[0]?.name).toBe("dev");
  });

  // 裁决 12（2026-11-17）：重名从拒绝改为 warnings 附注——name 只是显示名，重名允许但不推荐；
  // key/name 拆分后派发用 id，不再需要「改名让位再重建」。
  it("allows duplicate display names with a warning instead of rejecting", async () => {
    const fs = createMemoryFileSystem();
    const first = (await manageWorkersHandler(
      ManageWorkersInputSchema.parse(VALID_CREATE),
      contextWith(fs),
    )) as { worker: { id: string } };

    const second = (await manageWorkersHandler(
      ManageWorkersInputSchema.parse({ ...VALID_CREATE, name: "DEV" }),
      contextWith(fs),
    )) as { worker: { id: string }; warnings?: string[] };

    expect(second.worker.id).not.toBe(first.worker.id);
    expect(second.warnings?.join("\n")).toMatch(/DEV/);
    const registry = workerRegistrySchema.parse(JSON.parse(fs.files.get(registryPath())!));
    expect(registry.workers).toHaveLength(2);
  });

  it("renames by stable id without touching file paths", async () => {
    const fs = createMemoryFileSystem();
    const created = (await manageWorkersHandler(
      ManageWorkersInputSchema.parse(VALID_CREATE),
      contextWith(fs),
    )) as { worker: { id: string }; defineMdPath: string };

    const updated = (await manageWorkersHandler(
      ManageWorkersInputSchema.parse({
        action: "update",
        id: created.worker.id,
        name: "frontend",
      }),
      contextWith(fs),
    )) as { worker: { name: string }; defineMdPath: string };

    expect(updated.worker.name).toBe("frontend");
    // id 是路径锚点：改名后 define.md 路径不变。
    expect(updated.defineMdPath).toBe(created.defineMdPath);
    expect(fs.files.get(updated.defineMdPath)).toContain("# Duty definition — dev");
  });

  it("deactivates without deleting files, then reactivates", async () => {
    const fs = createMemoryFileSystem();
    const created = (await manageWorkersHandler(
      ManageWorkersInputSchema.parse(VALID_CREATE),
      contextWith(fs),
    )) as { worker: { id: string } };

    const off = (await manageWorkersHandler(
      ManageWorkersInputSchema.parse({
        action: "set_status",
        id: created.worker.id,
        status: "deactivated",
      }),
      contextWith(fs),
    )) as { worker: { status: string } };
    expect(off.worker.status).toBe("deactivated");
    // 停用是软状态：define.md/agents.md 与注册表条目都还在盘上。
    expect(
      fs.files.get(join(tmpDir, ".robinrun", "agents", created.worker.id, workerAgentsMdFileName)),
    ).toBeDefined();
    expect(
      fs.files.get(join(tmpDir, ".robinrun", "agents", created.worker.id, workerDefineMdFileName)),
    ).toBeDefined();
    const registry = workerRegistrySchema.parse(JSON.parse(fs.files.get(registryPath())!));
    expect(registry.workers[0]?.status).toBe("deactivated");

    const on = (await manageWorkersHandler(
      ManageWorkersInputSchema.parse({
        action: "set_status",
        id: created.worker.id,
        status: "active",
      }),
      contextWith(fs),
    )) as { worker: { status: string } };
    expect(on.worker.status).toBe("active");
  });

  it("refuses to write over a corrupt registry", async () => {
    const fs = createMemoryFileSystem({
      [registryPath()]: "{ not json",
    });

    await expect(
      manageWorkersHandler(ManageWorkersInputSchema.parse(VALID_CREATE), contextWith(fs)),
    ).rejects.toThrow(/invalid/);
    // 拒绝写入：损坏的注册表不被空表覆盖。
    expect(fs.files.get(registryPath())).toBe("{ not json");
  });

  it("treats a missing registry as an empty roster for create", async () => {
    const fs = createMemoryFileSystem();
    const output = (await manageWorkersHandler(
      ManageWorkersInputSchema.parse(VALID_CREATE),
      contextWith(fs),
    )) as { rosterSize: number };
    expect(output.rosterSize).toBe(1);
  });

  it("fails with a business error for unknown ids", async () => {
    const fs = createMemoryFileSystem();
    await expect(
      manageWorkersHandler(
        ManageWorkersInputSchema.parse({
          action: "set_status",
          id: "wkr-00000000",
          status: "deactivated",
        }),
        contextWith(fs),
      ),
    ).rejects.toThrow(/No worker with id/);
  });

  it("is registered with a workspace-scoped edit permission and child-forced exclusion", () => {
    expect(manageWorkersToolEntry.metadata.name).toBe("ManageWorkers");
    expect(manageWorkersToolEntry.permission?.permission).toBe("edit");
    expect(manageWorkersToolEntry.permission?.sideEffectScope).toBe("workspace");
    expect(manageWorkersToolEntry.runtimeOutputSchema).toBeDefined();
    expect(WORKER_REGISTRY_VERSION).toBe(1);
  });
});
