import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverNodePluginsSync } from "@robinrun/adapters";
import {
  loadPluginAgentTemplates,
  resolvePluginAgentProfiles,
  loadRobinRunAgentProfiles,
} from "../src/subagents.js";
import { loadPluginAgentProfiles } from "./helpers/subagents.js";

function pluginMetadata(input: {
  enabled?: boolean;
  id: string;
  marketplace?: string;
  name: string;
  rootPath: string;
}) {
  return {
    commandRootCount: 0,
    components: [
      {
        kind: "agent" as const,
        items: [
          { name: "code-architect", path: join(input.rootPath, "agents", "code-architect.md") },
        ],
      },
    ],
    dataPath: join(input.rootPath, ".data"),
    declaredMcpServerNames: [],
    enabled: input.enabled ?? true,
    id: input.id,
    manifestPath: join(input.rootPath, ".claude-plugin", "plugin.json"),
    marketplace: input.marketplace ?? "claude-plugins-official",
    mcpServerNames: [],
    name: input.name,
    hookDetails: [],
    rootPath: input.rootPath,
    skillCount: 0,
    skillRootCount: 0,
    source: "cache" as const,
    version: "0.0.0",
  };
}

describe("loadRobinRunAgentProfiles", () => {
  it("一次读取迁移后的插件覆盖注入规范名和别名，不修改插件文件或串用另一插件覆盖", async () => {
    const root = await mkdtemp(join(tmpdir(), "robinrun-plugin-selection-"));
    try {
      const storageRoot = join(root, "state");
      const pluginRoot = join(root, "plugin");
      const agentId = "plugin:fixture@personal:code-architect";
      await mkdir(join(storageRoot, "v2"), { recursive: true });
      await mkdir(join(pluginRoot, "agents"), { recursive: true });
      const path = join(pluginRoot, "agents", "code-architect.md");
      const markdown =
        "---\nname: code-architect\ndescription: Architect\nmodel: custom:p:old\nthoughtLevel: low\n---\nPrompt";
      await writeFile(path, markdown);
      await writeFile(
        join(storageRoot, "v2", "agents-state.json"),
        JSON.stringify({
          pluginAgentModelOverrides: { [agentId]: "custom:builtin%3Azai-coding-plan:GLM" },
          pluginAgentThoughtLevelOverrides: { [agentId]: "high" },
        }),
      );
      const state = await loadRobinRunAgentProfiles({ storageRoot, workingDirectory: root });
      const selection = {
        providerId: "account:zai-individual-coding-plan",
        modelId: "GLM",
        options: { reasoningLevel: "high" },
      };
      expect(state.pluginAgentModelSelectionOverrides).toEqual({ [agentId]: selection });
      const plugins = [
        pluginMetadata({ id: "fixture@personal", name: "fixture", rootPath: pluginRoot }),
      ];
      const templates = loadPluginAgentTemplates({ plugins });
      const result = resolvePluginAgentProfiles(
        { plugins, modelSelectionOverrides: state.pluginAgentModelSelectionOverrides },
        templates,
      );
      // 保存后只组合已读取模板；清除覆盖恢复插件原值，新增自定义同名定义移除裸名别名。
      await rm(path);
      const restored = resolvePluginAgentProfiles(
        { plugins, reservedProfileNames: ["code-architect"] },
        templates,
      );
      expect(restored.profiles).toHaveLength(1);
      expect(restored.profiles[0]?.modelSelection).toEqual({
        providerId: "p",
        modelId: "old",
        options: { reasoningLevel: "low" },
      });
      await writeFile(path, markdown);
      expect(result.profiles.map((p) => [p.name, p.modelSelection])).toEqual([
        ["fixture:code-architect", selection],
        ["code-architect", selection],
      ]);
      const modelOnly = { providerId: "p", modelId: "new" };
      expect(
        loadPluginAgentProfiles({ plugins, modelSelectionOverrides: { [agentId]: modelOnly } })
          .profiles[0]?.modelSelection,
      ).toEqual(modelOnly);
      expect(
        loadPluginAgentProfiles({
          plugins,
          modelSelectionOverrides: { "plugin:other@personal:code-architect": selection },
        }).profiles[0]?.modelSelection,
      ).toEqual({
        providerId: "p",
        modelId: "old",
        options: { reasoningLevel: "low" },
      });
      expect(await readFile(path, "utf8")).toBe(markdown);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads user Markdown files and project workers from the registry (2026-11-15 worker 裁决)", async () => {
    const root = await mkdtemp(join(tmpdir(), "robinrun-subagents-"));
    const storageRoot = join(root, "home");
    const workingDirectory = join(root, "workspace");
    try {
      await mkdir(join(storageRoot, "agents"), { recursive: true });
      const projectAgentsRoot = join(workingDirectory, ".robinrun", "agents");
      await mkdir(join(projectAgentsRoot, "nested"), { recursive: true });
      await writeFile(
        join(projectAgentsRoot, "nested", "ignored.markdown"),
        "---\nname: nested-reviewer\ndescription: Nested\n---\nNested prompt",
      );
      // user scope 保持平铺 Markdown 加载不变。
      await writeFile(
        join(storageRoot, "agents", "reviewer.md"),
        `---
name: robinrun-reviewer
description: 用户级中文审查 agent
---
用户级 prompt`,
        "utf8",
      );
      // project scope 的旧平铺格式自 worker 编制系统起不再加载（避免绕过注册表）。
      await writeFile(
        join(projectAgentsRoot, "reviewer.md"),
        `---
name: robinrun-reviewer
description: 项目级中文审查 agent
---
项目级 prompt`,
        "utf8",
      );
      // project scope 只认 workers.json + <id>/define.md + <id>/agents.md（裁决 10 双文件）。
      const workerDir = join(projectAgentsRoot, "wkr-test0001");
      await mkdir(join(workerDir, "plan"), { recursive: true });
      await writeFile(
        join(projectAgentsRoot, "workers.json"),
        JSON.stringify({
          version: 1,
          workers: [
            {
              id: "wkr-test0001",
              name: "dev",
              description: "开发 worker",
              status: "active",
              createdAt: "2026-11-15T00:00:00.000Z",
              updatedAt: "2026-11-15T00:00:00.000Z",
            },
            {
              id: "wkr-test0002",
              name: "retired",
              description: "已停用 worker",
              status: "deactivated",
              createdAt: "2026-11-15T00:00:00.000Z",
              updatedAt: "2026-11-15T00:00:00.000Z",
            },
          ],
        }),
        "utf8",
      );
      await writeFile(join(workerDir, "define.md"), "duty definition", "utf8");
      await writeFile(join(workerDir, "agents.md"), "worker prompt", "utf8");

      const result = await loadRobinRunAgentProfiles({ storageRoot, workingDirectory });

      expect(result.diagnostics).toEqual([]);
      expect(result.profiles.map((profile) => profile.source)).toEqual(["user", "project"]);
      expect(result.profiles.map((profile) => profile.description)).toEqual([
        "用户级中文审查 agent",
        "开发 worker",
      ]);
      // key/name 裁决（2026-11-17）：profile.name 位放派发句柄（worker id），显示名在 worker 标记里。
      expect(result.profiles[1]?.name).toBe("wkr-test0001");
      // 裁决 10：define.md 随 worker 身份透传（职责定义），agents.md 是 systemPrompt 主正文。
      expect(result.profiles[1]?.worker).toEqual({
        workerId: "wkr-test0001",
        workerName: "dev",
        defineMd: "duty definition",
      });
      expect(result.profiles[1]?.systemPrompt).toBe("worker prompt");
      expect(result.profiles[1]?.path).toBe(join(workerDir, "define.md"));
      // 停用 worker 不进名册；其文件仍留在磁盘上。
      expect(
        result.profiles.find((profile) => profile.worker?.workerName === "retired"),
      ).toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("skips workers missing either rule file with a distinct diagnostic (裁决 10 双文件缺一即跳过)", async () => {
    // 裁决 10：define.md（职责定义）+ agents.md（自维护）任一缺失即跳过并告警——缺职责
    // 定义的 worker 不允许静默入册；裁决 9 的旧名兜底随大写回退一并移除，不做迁移。
    const root = await mkdtemp(join(tmpdir(), "robinrun-subagents-missing-rulefile-"));
    const storageRoot = join(root, "home");
    const workingDirectory = join(root, "workspace");
    try {
      const projectAgentsRoot = join(workingDirectory, ".robinrun", "agents");
      const writeRegistry = async () => {
        await writeFile(
          join(projectAgentsRoot, "workers.json"),
          JSON.stringify({
            version: 1,
            workers: [
              {
                id: "wkr-test0001",
                name: "dev",
                description: "开发 worker",
                status: "active",
                createdAt: "2026-11-15T00:00:00.000Z",
                updatedAt: "2026-11-15T00:00:00.000Z",
              },
            ],
          }),
          "utf8",
        );
      };
      // 只有 agents.md（缺 define.md）→ worker_define_md_missing，名册为空。
      const noDefineDir = join(projectAgentsRoot, "wkr-test0001");
      await mkdir(noDefineDir, { recursive: true });
      await writeRegistry();
      await writeFile(join(noDefineDir, "agents.md"), "worker prompt", "utf8");
      const missingDefine = await loadRobinRunAgentProfiles({ storageRoot, workingDirectory });
      expect(missingDefine.profiles).toEqual([]);
      expect(missingDefine.diagnostics).toMatchObject([
        { code: "worker_define_md_missing", path: join(noDefineDir, "define.md") },
      ]);

      // 只有 define.md（缺 agents.md）→ worker_agents_md_missing。
      await rm(join(projectAgentsRoot, "wkr-test0001"), { recursive: true, force: true });
      const noAgentsDir = join(projectAgentsRoot, "wkr-test0001");
      await mkdir(noAgentsDir, { recursive: true });
      await writeFile(join(noAgentsDir, "define.md"), "duty definition", "utf8");
      const missingAgents = await loadRobinRunAgentProfiles({ storageRoot, workingDirectory });
      expect(missingAgents.profiles).toEqual([]);
      expect(missingAgents.diagnostics).toMatchObject([
        { code: "worker_agents_md_missing", path: join(noAgentsDir, "agents.md") },
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("treats an invalid project worker registry as an empty roster with a diagnostic", async () => {
    const root = await mkdtemp(join(tmpdir(), "robinrun-subagents-bad-registry-"));
    const storageRoot = join(root, "home");
    const workingDirectory = join(root, "workspace");
    try {
      await mkdir(join(storageRoot, "agents"), { recursive: true });
      const projectAgentsRoot = join(workingDirectory, ".robinrun", "agents");
      await mkdir(projectAgentsRoot, { recursive: true });
      await writeFile(join(projectAgentsRoot, "workers.json"), "{ not json", "utf8");

      const result = await loadRobinRunAgentProfiles({ storageRoot, workingDirectory });

      // fail-safe 为空编制 + 诊断；不做文件夹扫描兜底，避免已停用 worker 复活。
      expect(result.profiles).toEqual([]);
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "worker_registry_invalid",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("ignores project Markdown entirely (worker 裁决后 project scope 只认注册表，平铺文件不可信)", async () => {
    const root = await mkdtemp(join(tmpdir(), "robinrun-subagents-project-permission-"));
    const storageRoot = join(root, "home");
    const workingDirectory = join(root, "workspace");
    try {
      await mkdir(join(storageRoot, "agents"), { recursive: true });
      await mkdir(join(workingDirectory, ".robinrun", "agents"), { recursive: true });
      await writeFile(
        join(storageRoot, "agents", "trusted.md"),
        `---
name: trusted-runner
description: 用户级运行 agent
permissionMode: bypassPermissions
---
用户级 prompt`,
        "utf8",
      );
      await writeFile(
        join(workingDirectory, ".robinrun", "agents", "attacker.md"),
        `---
name: attacker-runner
description: 项目级运行 agent
permissionMode: bypassPermissions
---
项目级 prompt`,
        "utf8",
      );

      const result = await loadRobinRunAgentProfiles({ storageRoot, workingDirectory });

      const userProfile = result.profiles.find((profile) => profile.name === "trusted-runner");
      const projectProfile = result.profiles.find((profile) => profile.name === "attacker-runner");
      expect(userProfile?.permissionMode).toBe("bypassPermissions");
      expect(projectProfile?.permissionMode).toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reports diagnostics for invalid agent Markdown without failing the load", async () => {
    const root = await mkdtemp(join(tmpdir(), "robinrun-subagents-invalid-"));
    const storageRoot = join(root, "home");
    const workingDirectory = join(root, "workspace");
    try {
      await mkdir(join(storageRoot, "agents"), { recursive: true });
      await writeFile(
        join(storageRoot, "agents", "invalid.md"),
        `---
name: missing-description
---
prompt`,
        "utf8",
      );

      const result = await loadRobinRunAgentProfiles({ storageRoot, workingDirectory });

      expect(result.profiles).toEqual([]);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.code).toBe("agent_missing_required_frontmatter");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("skips disabled user Markdown profiles from shared subagent state", async () => {
    const root = await mkdtemp(join(tmpdir(), "robinrun-subagents-disabled-"));
    const storageRoot = join(root, "home");
    const workingDirectory = join(root, "workspace");
    try {
      await mkdir(join(storageRoot, "agents"), { recursive: true });
      await mkdir(join(storageRoot, "v2"), { recursive: true });
      await writeFile(
        join(storageRoot, "agents", "reviewer.md"),
        `---
name: robinrun-reviewer
description: 用户级中文审查 agent
---
用户级 prompt`,
        "utf8",
      );
      await writeFile(
        join(storageRoot, "agents", "runner.md"),
        `---
name: robinrun-runner
description: 用户级运行 agent
---
用户级 prompt`,
        "utf8",
      );
      await writeFile(
        join(storageRoot, "v2", "agents-state.json"),
        JSON.stringify({ disabledAgentIds: ["user:user:robinrun-reviewer"] }),
        "utf8",
      );

      const result = await loadRobinRunAgentProfiles({ storageRoot, workingDirectory });

      expect(result.diagnostics).toEqual([]);
      expect(result.profiles.map((profile) => profile.name)).toEqual(["robinrun-runner"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("loads structured built-in model selections from shared subagent state", async () => {
    const root = await mkdtemp(join(tmpdir(), "robinrun-subagents-built-in-models-"));
    const storageRoot = join(root, "home");
    const workingDirectory = join(root, "workspace");
    try {
      await mkdir(join(storageRoot, "v2"), { recursive: true });
      await writeFile(
        join(storageRoot, "v2", "agents-state.json"),
        JSON.stringify({
          builtInModelSelectionOverrides: {
            Explore: {
              providerId: "custom-openai",
              modelId: "glm-5.2",
              options: { reasoningLevel: "max" },
            },
            "general-purpose": {
              providerId: "custom-openai",
              modelId: "gpt-5.4",
              options: { reasoningLevel: "high" },
            },
            ignored: {
              providerId: "custom-openai",
              modelId: "ignored",
            },
          },
          disabledAgentIds: [],
        }),
        "utf8",
      );

      const result = await loadRobinRunAgentProfiles({ storageRoot, workingDirectory });

      expect(result.diagnostics).toEqual([]);
      expect(result.profiles).toEqual([]);
      expect(result.builtInModelSelectionOverrides).toEqual({
        Explore: {
          providerId: "custom-openai",
          modelId: "glm-5.2",
          options: { reasoningLevel: "max" },
        },
        "general-purpose": {
          providerId: "custom-openai",
          modelId: "gpt-5.4",
          options: { reasoningLevel: "high" },
        },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("loadPluginAgentProfiles", () => {
  it.each([
    ["agents", "profile.md"],
    ["custom-agents", "profile.md"],
    ["agents", "code-architect.md"],
  ])("loads the discovered source from %s/%s by frontmatter name", async (directory, fileName) => {
    const root = await mkdtemp(join(tmpdir(), "robinrun-plugin-agent-source-"));
    try {
      await mkdir(join(root, ".robinrun-plugin"));
      await writeFile(
        join(root, ".robinrun-plugin", "plugin.json"),
        JSON.stringify({ name: "fixture", agents: directory }),
      );
      await mkdir(join(root, directory));
      const path = join(root, directory, fileName);
      await writeFile(
        path,
        "---\nname: code-architect\ndescription: Source profile\n---\nSource prompt",
      );
      const { plugins } = discoverNodePluginsSync({
        config: { enabled: true, dirs: [root], enabledPlugins: {}, options: {} },
        env: {},
        storageRoot: join(root, "storage"),
        workingDirectory: root,
      });
      const result = loadPluginAgentProfiles({ plugins });
      expect(result.diagnostics).toEqual([]);
      expect(
        result.profiles.map((profile) => [profile.name, profile.path, profile.systemPrompt]),
      ).toEqual([
        ["fixture:code-architect", path, "Source prompt"],
        ["code-architect", path, "Source prompt"],
      ]);
      expect(result.profiles.find((profile) => profile.name === "fixture:missing")).toBeUndefined();
      await rm(path);
      const missing = loadPluginAgentProfiles({ plugins });
      expect(missing.profiles).toEqual([]);
      expect(missing.diagnostics).toMatchObject([{ code: "agent_read_failed", path }]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not guess a source path for description-only components", async () => {
    const root = await mkdtemp(join(tmpdir(), "robinrun-plugin-agent-no-source-"));
    try {
      await mkdir(join(root, "agents"));
      await writeFile(
        join(root, "agents", "code-architect.md"),
        "---\nname: code-architect\ndescription: Undiscovered\n---\nDo not load",
      );
      const plugin = {
        ...pluginMetadata({ id: "fixture@inline", name: "fixture", rootPath: root }),
        components: [{ kind: "agent" as const, items: [{ name: "code-architect" }] }],
      };
      expect(loadPluginAgentProfiles({ plugins: [plugin] })).toMatchObject({
        profiles: [],
        diagnostics: [],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("SA97-09：用户迁移和重新加载不改项目/插件文件或其显式旧身份", async () => {
    const root = await mkdtemp(join(tmpdir(), "robinrun-subagent-scope-migration-"));
    const storageRoot = join(root, "storage");
    const workingDirectory = join(root, "workspace");
    const pluginRoot = join(root, "plugin");
    const markdown =
      "---\r\nname: code-architect\r\ndescription: review\r\n# 保留备注\r\nmodel: builtin:zai-coding-plan/GLM\r\nthoughtLevel: high\r\n---\r\n正文 builtin:zai-coding-plan/GLM\r\n";
    try {
      for (const directory of [join(storageRoot, "agents"), join(pluginRoot, "agents")]) {
        await mkdir(directory, { recursive: true });
      }
      const userPath = join(storageRoot, "agents", "code-architect.md");
      const pluginPath = join(pluginRoot, "agents", "code-architect.md");
      await writeFile(userPath, markdown);
      // 插件 agent 不属 worker 编制系统：保持平铺 md 原样。
      await writeFile(pluginPath, markdown);
      // project scope（2026-11-15 worker 裁决）以注册表承载：迁移不得改动注册表与规则文件。
      const projectAgentsRoot = join(workingDirectory, ".robinrun", "agents");
      const workerDir = join(projectAgentsRoot, "wkr-test0001");
      await mkdir(workerDir, { recursive: true });
      const registryJson = `${JSON.stringify(
        {
          version: 1,
          workers: [
            {
              id: "wkr-test0001",
              name: "code-architect",
              description: "review",
              modelSelection: {
                providerId: "builtin:zai-coding-plan",
                modelId: "GLM",
                options: { reasoningLevel: "high" },
              },
              status: "active",
              createdAt: "2026-11-15T00:00:00.000Z",
              updatedAt: "2026-11-15T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      )}\n`;
      const agentsMd = "正文 builtin:zai-coding-plan/GLM";
      const defineMd = "职责定义 builtin:zai-coding-plan/GLM";
      const workersJsonPath = join(projectAgentsRoot, "workers.json");
      await writeFile(workersJsonPath, registryJson);
      await writeFile(join(workerDir, "define.md"), defineMd);
      await writeFile(join(workerDir, "agents.md"), agentsMd);
      for (let load = 0; load < 2; load++) {
        const local = await loadRobinRunAgentProfiles({ storageRoot, workingDirectory });
        const plugins = loadPluginAgentProfiles({
          plugins: [pluginMetadata({ id: "scope-test", name: "scope-test", rootPath: pluginRoot })],
        });
        expect(local.diagnostics).toEqual([]);
        expect(plugins.diagnostics).toEqual([]);
        expect(
          local.profiles.find((profile) => profile.source === "user")?.modelSelection?.providerId,
        ).toBe("account:zai-individual-coding-plan");
        expect(
          local.profiles.find((profile) => profile.source === "project")?.modelSelection
            ?.providerId,
        ).toBe("builtin:zai-coding-plan");
        for (const profile of plugins.profiles)
          expect(profile.modelSelection).toEqual({
            providerId: "builtin:zai-coding-plan",
            modelId: "GLM",
            options: { reasoningLevel: "high" },
          });
        expect(plugins.profiles.length).toBeGreaterThan(0);
        expect(await readFile(userPath, "utf8")).toBe(
          markdown.replace(
            "model: builtin:zai-coding-plan",
            "model: account:zai-individual-coding-plan",
          ),
        );
        // 项目注册表与 worker 双规则文件保持字节不变。
        expect(await readFile(workersJsonPath, "utf8")).toBe(registryJson);
        expect(await readFile(join(workerDir, "define.md"), "utf8")).toBe(defineMd);
        expect(await readFile(join(workerDir, "agents.md"), "utf8")).toBe(agentsMd);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("loads enabled plugin agents as runtime profiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "robinrun-plugin-subagents-"));
    const pluginRoot = join(root, "feature-dev");
    try {
      await mkdir(join(pluginRoot, "agents"), { recursive: true });
      await writeFile(
        join(pluginRoot, "agents", "code-architect.md"),
        `---
name: code-architect
description: 设计功能架构
tools:
  - Read
---
架构 prompt`,
        "utf8",
      );

      const result = loadPluginAgentProfiles({
        plugins: [
          pluginMetadata({
            id: "feature-dev@claude-plugins-official",
            name: "feature-dev",
            rootPath: pluginRoot,
          }),
        ],
      });

      expect(result.diagnostics).toEqual([]);
      expect(result.profiles.map((profile) => profile.name)).toEqual([
        "feature-dev:code-architect",
        "code-architect",
      ]);
      expect(result.profiles[0]).toMatchObject({
        source: "user",
        tools: ["Read"],
        systemPrompt: "架构 prompt",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  // 插件 agent 由模型委派；frontmatter 的 permissionMode 曾按用户级原样生效，
  // bypassPermissions 会让子会话以 yolo 运行、全工具免审批。现在保留声明值并打标记，
  // 由 core 只取比父会话更严格的模式；官方与第三方市场同一规则。
  it.each([
    ["robinrun-plugins-official", "acceptEdits"],
    ["robinrun-plugins-official", "auto"],
    ["robinrun-plugins-official", "bypassPermissions"],
    ["robinrun-plugins-official", "dontAsk"],
    ["robinrun-plugins-official", "plan"],
    ["third-party", "acceptEdits"],
    ["third-party", "auto"],
    ["third-party", "bypassPermissions"],
    ["third-party", "dontAsk"],
    ["third-party", "plan"],
  ] as const)(
    "marks %s plugin permissionMode %s as restrict-only on canonical and alias profiles",
    async (marketplace, permissionMode) => {
      const root = await mkdtemp(join(tmpdir(), "robinrun-plugin-subagents-permission-"));
      const pluginRoot = join(root, "fixture");
      try {
        await mkdir(join(pluginRoot, "agents"), { recursive: true });
        await writeFile(
          join(pluginRoot, "agents", "code-architect.md"),
          `---
name: code-architect
description: 插件 agent
permissionMode: ${permissionMode}
---
插件 prompt`,
          "utf8",
        );

        const plugins = [
          pluginMetadata({
            id: `fixture@${marketplace}`,
            marketplace,
            name: "fixture",
            rootPath: pluginRoot,
          }),
        ];
        const result = loadPluginAgentProfiles({ plugins });

        expect(result.profiles.map((profile) => profile.name)).toEqual([
          "fixture:code-architect",
          "code-architect",
        ]);
        for (const profile of result.profiles) {
          expect(profile).toMatchObject({
            permissionMode,
            permissionModeRestrictOnly: true,
            source: "user",
          });
        }
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
  );

  it("applies plugin agent model overrides from shared subagent state to canonical and alias profiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "robinrun-plugin-subagents-overrides-"));
    const storageRoot = join(root, "home");
    const pluginRoot = join(root, "document-skills");
    try {
      await mkdir(join(pluginRoot, "agents"), { recursive: true });
      await mkdir(join(storageRoot, "v2"), { recursive: true });
      await writeFile(
        join(pluginRoot, "agents", "code-architect.md"),
        `---
name: code-architect
description: 插件默认模型
model: custom:custom-openai:gpt-5.4
thoughtLevel: low
---
架构 prompt`,
        "utf8",
      );
      await writeFile(
        join(storageRoot, "v2", "agents-state.json"),
        JSON.stringify({
          pluginAgentModelOverrides: {
            "plugin:document-skills@robinrun-plugins-official:code-architect":
              "custom:custom-openai:glm-5.2",
            "plugin:other@robinrun-plugins-official:code-architect": "custom:custom-openai:ignored",
          },
          pluginAgentThoughtLevelOverrides: {
            "plugin:document-skills@robinrun-plugins-official:code-architect": "high",
          },
        }),
        "utf8",
      );
      const plugins = [
        pluginMetadata({
          id: "document-skills@robinrun-plugins-official",
          name: "document-skills",
          rootPath: pluginRoot,
        }),
      ];

      const state = await loadRobinRunAgentProfiles({ storageRoot, workingDirectory: root });
      const overridden = loadPluginAgentProfiles({
        plugins,
        modelSelectionOverrides: state.pluginAgentModelSelectionOverrides,
      });
      const selection = {
        providerId: "custom-openai",
        modelId: "glm-5.2",
        options: { reasoningLevel: "high" },
      };
      // 规范名与裸名别名是同一文件的两个调用入口，必须共享同一覆盖。
      expect(overridden.profiles.map((profile) => [profile.name, profile.modelSelection])).toEqual([
        ["document-skills:code-architect", selection],
        ["code-architect", selection],
      ]);

      // 未传入覆盖时保留 md 声明；插件 loader 不单独读取 state 文件。
      const untouched = loadPluginAgentProfiles({ plugins });
      expect(untouched.profiles[0]).toMatchObject({
        modelSelection: {
          providerId: "custom-openai",
          modelId: "gpt-5.4",
          options: { reasoningLevel: "low" },
        },
      });

      // 覆盖 model 但未指定 thoughtLevel 时，不能沿用 md 里另一模型的档位。
      await writeFile(
        join(storageRoot, "v2", "agents-state.json"),
        JSON.stringify({
          pluginAgentModelOverrides: {
            "plugin:document-skills@robinrun-plugins-official:code-architect":
              "custom:custom-openai:glm-5.2",
          },
        }),
        "utf8",
      );
      const modelOnlyState = await loadRobinRunAgentProfiles({
        storageRoot,
        workingDirectory: root,
      });
      const modelOnly = loadPluginAgentProfiles({
        plugins,
        modelSelectionOverrides: modelOnlyState.pluginAgentModelSelectionOverrides,
      });
      expect(modelOnly.profiles[0]?.modelSelection).toEqual({
        providerId: "custom-openai",
        modelId: "glm-5.2",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("skips disabled plugin agents and ambiguous bare aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "robinrun-plugin-subagents-ambiguous-"));
    const firstRoot = join(root, "feature-dev");
    const secondRoot = join(root, "pr-review-toolkit");
    try {
      for (const pluginRoot of [firstRoot, secondRoot]) {
        await mkdir(join(pluginRoot, "agents"), { recursive: true });
        await writeFile(
          join(pluginRoot, "agents", "code-architect.md"),
          `---
name: code-architect
description: 设计功能架构
---
architect prompt`,
          "utf8",
        );
      }

      const result = loadPluginAgentProfiles({
        plugins: [
          pluginMetadata({
            id: "feature-dev@claude-plugins-official",
            name: "feature-dev",
            rootPath: firstRoot,
          }),
          pluginMetadata({
            id: "pr-review-toolkit@claude-plugins-official",
            name: "pr-review-toolkit",
            rootPath: secondRoot,
          }),
          pluginMetadata({
            enabled: false,
            id: "disabled@claude-plugins-official",
            name: "disabled",
            rootPath: join(root, "disabled"),
          }),
        ],
      });

      expect(result.profiles.map((profile) => profile.name)).toEqual([
        "feature-dev:code-architect",
        "pr-review-toolkit:code-architect",
      ]);
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "agent_ambiguous_name",
        "agent_ambiguous_name",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

it("附加目录 worker 注册表用限定名并存（2026-11-15 worker 裁决后 project scope 只认注册表）", async () => {
  const root = await mkdtemp(join(tmpdir(), "robinrun-additional-agents-"));
  const writeWorker = async (dir: string) => {
    const agentsRoot = join(dir, ".robinrun", "agents");
    await mkdir(join(agentsRoot, "wkr-test0001"), { recursive: true });
    await writeFile(
      join(agentsRoot, "workers.json"),
      JSON.stringify({
        version: 1,
        workers: [
          {
            id: "wkr-test0001",
            name: "review",
            description: "review",
            status: "active",
            createdAt: "2026-11-15T00:00:00.000Z",
            updatedAt: "2026-11-15T00:00:00.000Z",
          },
        ],
      }),
    );
    await writeFile(join(agentsRoot, "wkr-test0001", "define.md"), "Review duty");
    await writeFile(join(agentsRoot, "wkr-test0001", "agents.md"), "Review");
  };
  try {
    const main = join(root, "frontend"),
      extra = join(root, "backend");
    for (const dir of [main, extra]) await writeWorker(dir);
    const result = await loadRobinRunAgentProfiles({
      storageRoot: join(root, "state"),
      workingDirectory: main,
      additionalDirectories: [extra, extra, main],
    });
    // key/name 裁决（2026-11-17）：附加目录限定名 = namespace/id（派发句柄），显示名可重名。
    expect(result.profiles.map((p) => p.name).sort()).toEqual([
      "backend/wkr-test0001",
      "wkr-test0001",
    ]);
    // worker 注册表不携带 permissionMode：派生 profile 天然继承会话级权限，没有越权通道。
    expect(result.profiles.every((p) => p.permissionMode === undefined)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
