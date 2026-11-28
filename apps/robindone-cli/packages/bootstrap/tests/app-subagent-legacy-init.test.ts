import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteSessionStore } from "@robindone/adapters/storage";
import { describe, expect, it, vi } from "vitest";
import { createRegistryBackedTestApp } from "./helpers/registry-backed-test-app.js";
import type { RobinDoneApp } from "../src/app/types.js";

const { resolveRuntimeConfig } = vi.hoisted(() => ({ resolveRuntimeConfig: vi.fn() }));
vi.mock("../src/app/runtime-config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/app/runtime-config.js")>();
  return {
    ...original,
    resolveAppRuntimeConfig: (...args: Parameters<typeof original.resolveAppRuntimeConfig>) => {
      resolveRuntimeConfig(...args);
      return original.resolveAppRuntimeConfig(...args);
    },
  };
});

describe("App 初始化旧 Subagent 身份", () => {
  // 真实文件迁移与 App 初始化在高负载下可能超过默认 5 秒，保留全部迁移顺序断言。
  it("用户目录完成原地迁移再构造 Runtime；项目旧平铺文件不迁移不加载，worker 注册表原样透传（2026-11-15 worker 裁决）", async () => {
    const root = await mkdtemp(join(tmpdir(), "robindone-subagent-init-"));
    const directory = join(root, ".robindone", "agents");
    const file = join(directory, "legacy.md");
    const markdown =
      "---\nname: legacy\ndescription: legacy profile\nmodel: builtin:zai-coding-plan/glm-4.6\nthoughtLevel: high\n---\nreview";
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    let app: RobinDoneApp | undefined;
    let creation: Promise<RobinDoneApp> | undefined;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(file, markdown);
      // worker 注册表：project scope 的正身。modelSelection 原样透传，不再做别名/大小写改写。
      const workerDir = join(directory, "wkr-test0001");
      await mkdir(workerDir, { recursive: true });
      await writeFile(
        join(directory, "workers.json"),
        JSON.stringify({
          version: 1,
          workers: [
            {
              id: "wkr-test0001",
              name: "legacy",
              description: "legacy profile",
              modelSelection: {
                providerId: "builtin:zai-coding-plan",
                modelId: "glm-4.6",
                options: { reasoningLevel: "high" },
              },
              status: "active",
              createdAt: "2026-11-15T00:00:00.000Z",
              updatedAt: "2026-11-15T00:00:00.000Z",
            },
          ],
        }),
      );
      // 裁决 10（2026-11-20）双文件：define.md（职责定义，加载器必需）+ agents.md（自维护）。
      // 2026-11-19 大写统一裁决后固定文件名为 AGENTS.md；这里故意写旧小写名，顺带锁住读侧兜底。
      await writeFile(join(workerDir, "define.md"), "duty definition");
      await writeFile(join(workerDir, "agents.md"), "review");
      const userRoot = join(root, "storage", "agents");
      await mkdir(userRoot, { recursive: true });
      await writeFile(
        join(userRoot, "user.md"),
        markdown.replace("name: legacy", "name: user-legacy"),
      );
      await mkdir(join(root, "storage", "v2"), { recursive: true });
      const stateFile = join(root, "storage", "v2", "agents-state.json");
      await writeFile(
        stateFile,
        JSON.stringify({
          builtInModelOverrides: { Explore: "builtin:zai-coding-plan/glm-4.6" },
          builtInThoughtLevelOverrides: { Explore: "high" },
        }),
      );
      resolveRuntimeConfig.mockClear();
      creation = Promise.resolve(
        createRegistryBackedTestApp({
          env: { ROBINDONE_STORAGE_DIR: join(root, "storage") },
          skipUserConfig: true,
          sessionStore: store,
          runtimeConfig: { workingDirectory: root, mcp: { enabled: false } },
        }),
      );
      app = await creation;
      // 用户配置迁移同时规范账户模型 ID 的大小写；worker 注册表条目原样透传。
      expect(resolveRuntimeConfig.mock.calls[0]?.[0].subagentProfiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "user-legacy",
            modelSelection: {
              providerId: "account:zai-individual-coding-plan",
              modelId: "GLM-4.6",
              options: { reasoningLevel: "high" },
            },
          }),
          expect.objectContaining({
            // key/name 裁决（2026-11-17）：profile.name 位放派发句柄（worker id）。
            name: "wkr-test0001",
            systemPrompt: "review",
            modelSelection: {
              providerId: "builtin:zai-coding-plan",
              modelId: "glm-4.6",
              options: { reasoningLevel: "high" },
            },
          }),
        ]),
      );
      expect(await readFile(join(userRoot, "user.md"), "utf8")).toBe(
        markdown
          .replace("name: legacy", "name: user-legacy")
          .replace(
            "model: builtin:zai-coding-plan/glm-4.6",
            "model: account:zai-individual-coding-plan/GLM-4.6",
          ),
      );
      // 项目旧平铺文件不迁移也不加载（project scope 只认注册表），字节保持原样。
      expect(await readFile(file, "utf8")).toBe(markdown);
      expect(
        JSON.parse(await readFile(stateFile, "utf8")).builtInModelSelectionOverrides.Explore,
      ).toEqual({
        providerId: "account:zai-individual-coding-plan",
        modelId: "GLM-4.6",
        options: { reasoningLevel: "high" },
      });
    } finally {
      app ??= await creation;
      await app?.close?.();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
