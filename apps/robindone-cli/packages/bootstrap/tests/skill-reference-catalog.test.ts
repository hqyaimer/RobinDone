// S08：skills/referenceCatalog 的 workspace/session authority 契约。
// session 直读 runtime 冻结目录；draft 重新扫描 workspace；未知 session fail closed。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { robindoneSkillsReferenceCatalogResultSchema } from "@robindone/shared";
import type { SkillLoadOutcome } from "@robindone/contracts";
import { getSkillReferenceCatalog } from "../src/robindone-protocol/skill-reference-catalog.js";
import type {
  RobinDoneProtocolAgentServerContext,
  RobinDoneProtocolSessionRecord,
} from "../src/robindone-protocol/server-types.js";

const SESSION_CATALOG: SkillLoadOutcome = {
  skills: [
    {
      name: "frozen",
      description: "Frozen session skill",
      path: "/workspace/.robindone/skills/frozen/SKILL.md",
      directory: "/workspace/.robindone/skills/frozen",
      rootPath: "/workspace/.robindone/skills",
      scope: "project",
      source: "robindone",
      safeToAutoLoad: true,
      frontmatterKeys: ["name", "description"],
    },
  ],
  diagnostics: [],
  totalDiscovered: 1,
};

function contextWithSession(sessionId: string): RobinDoneProtocolAgentServerContext {
  const record = {
    app: {
      getSkillCatalog: async () => SESSION_CATALOG,
    },
  } as unknown as RobinDoneProtocolSessionRecord;
  return {
    deps: { env: {} },
    sessions: new Map([[sessionId, record]]),
  } as unknown as RobinDoneProtocolAgentServerContext;
}

describe("skills/referenceCatalog protocol", () => {
  it("serves the Session runtime frozen catalog", async () => {
    const result = await getSkillReferenceCatalog(contextWithSession("session-a"), {
      workspace: { workspacePath: "/workspace", workspaceKey: "/workspace" },
      sessionId: "session-a",
    });

    expect(result).toEqual({
      authority: "session",
      skills: [
        {
          id: "glm:workspace:/workspace/.robindone/skills/frozen/SKILL.md",
          name: "frozen",
          description: "Frozen session skill",
          path: "/workspace/.robindone/skills/frozen/SKILL.md",
          scope: "workspace",
          enabled: true,
        },
      ],
    });
    expect(() => robindoneSkillsReferenceCatalogResultSchema.parse(result)).not.toThrow();
  });

  it("fails closed for an unknown Session instead of falling back to workspace discovery", async () => {
    await expect(
      getSkillReferenceCatalog(contextWithSession("session-a"), {
        workspace: { workspacePath: "/workspace", workspaceKey: "/workspace" },
        sessionId: "missing",
      }),
    ).rejects.toThrow(/Session is not active/);
  });

  it("rescans the current workspace catalog for a draft request", async () => {
    const root = await mkdtemp(join(tmpdir(), "robindone-skill-reference-workspace-"));
    const skillDirectory = join(root, ".robindone", "skills", "manual-added");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      ["---", "name: manual-added", "description: Added outside the app.", "---"].join("\n"),
    );
    try {
      const result = await getSkillReferenceCatalog(
        {
          deps: {
            env: {
              HOME: root,
              ROBINDONE_STORAGE_DIR: join(root, "cli"),
            },
          },
          sessions: new Map(),
        } as unknown as RobinDoneProtocolAgentServerContext,
        { workspace: { workspacePath: root, workspaceKey: root } },
      );

      expect(result.authority).toBe("workspace");
      expect(result.skills).toContainEqual(
        expect.objectContaining({
          name: "manual-added",
          description: "Added outside the app.",
          scope: "workspace",
          enabled: true,
        }),
      );
      expect(() => robindoneSkillsReferenceCatalogResultSchema.parse(result)).not.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
