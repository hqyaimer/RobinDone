import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpPort } from "@robindone/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  robindoneMcpListResultSchema,
  robindoneMcpListParamsSchema,
  robindoneProtocolMethods,
  robindoneProtocolSessionMethodContracts,
} from "@robindone/shared";
import { listMcpServers } from "../src/robindone-protocol/mcp.js";
import type { RobinDoneProtocolAgentServerContext } from "../src/robindone-protocol/server-types.js";

describe("mcp protocol contracts", () => {
  it("registers mcp/list", () => {
    expect(robindoneProtocolMethods.mcpList).toBe("mcp/list");
    expect(robindoneProtocolSessionMethodContracts[robindoneProtocolMethods.mcpList]).toBeDefined();
  });

  it("parses an MCP status snapshot", () => {
    const parsed = robindoneMcpListResultSchema.parse({
      statuses: {
        filesystem: {
          status: "disconnected",
          transport: "stdio",
          toolCount: 0,
          updatedAt: "2026-06-23T00:00:00.000Z",
        },
      },
    });

    expect(parsed.statuses.filesystem?.status).toBe("disconnected");
  });

  it("defaults mcp/list mode to connect and accepts status-only mode", () => {
    expect(
      robindoneMcpListParamsSchema.parse({
        workspace: {
          workspaceKey: "/tmp/project",
          workspacePath: "/tmp/project",
        },
      }).mode,
    ).toBe("connect");

    expect(
      robindoneMcpListParamsSchema.parse({
        workspace: {
          workspaceKey: "/tmp/project",
          workspacePath: "/tmp/project",
        },
        mode: "status",
      }).mode,
    ).toBe("status");
  });

  it("rejects invalid MCP status values", () => {
    expect(() =>
      robindoneMcpListResultSchema.parse({
        statuses: {
          broken: {
            status: "unknown",
            transport: "stdio",
            toolCount: 0,
            updatedAt: "2026-06-23T00:00:00.000Z",
          },
        },
      }),
    ).toThrow();
  });

  it("parses HTTP MCP OAuth client credentials in protocol params", () => {
    const parsed = robindoneMcpListParamsSchema.parse({
      workspace: {
        workspaceKey: "/tmp/project",
        workspacePath: "/tmp/project",
      },
      mcpServers: [
        {
          name: "protected",
          type: "http",
          url: "https://mcp.example.test/mcp",
          headers: [],
          oauth: {
            type: "client_credentials",
            clientId: "robindone-client",
            clientSecret: "secret",
            scope: "mcp:tools",
          },
        },
      ],
    });

    expect(parsed.mcpServers?.[0]).toMatchObject({
      name: "protected",
      oauth: {
        type: "client_credentials",
        clientId: "robindone-client",
      },
    });
  });

  it("parses HTTP MCP OAuth authorization code in protocol params", () => {
    const parsed = robindoneMcpListParamsSchema.parse({
      workspace: {
        workspaceKey: "/tmp/project",
        workspacePath: "/tmp/project",
      },
      mcpServers: [
        {
          name: "figma",
          type: "http",
          url: "https://mcp.figma.com/mcp",
          headers: [],
          oauth: {
            type: "authorization_code",
            clientName: "RobinDone",
            redirectPath: "/oauth/callback/mcp/figma",
            scope: "mcp:connect",
          },
        },
      ],
    });

    expect(parsed.mcpServers?.[0]).toMatchObject({
      name: "figma",
      oauth: {
        type: "authorization_code",
        clientName: "RobinDone",
        redirectPath: "/oauth/callback/mcp/figma",
        scope: "mcp:connect",
      },
    });
  });
});

// Bugfix 回归：设置页刷新的 mcp/list 必须带 revalidate，否则进程级 `protocol-settings` lease
// 会命中连接池里的旧 entry 并回放陈旧快照（见 adapters/src/mcp/pool.ts revalidateEntry）。
describe("mcp/list connection revalidation", () => {
  it("asks the pool to revalidate on the default connect mode and skips it for status mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "robindone-mcp-list-revalidate-"));
    const previousStorageDir = process.env.ROBINDONE_STORAGE_DIR;
    process.env.ROBINDONE_STORAGE_DIR = join(root, "cli");
    const connectConfiguredServers = vi.fn(async () => ({ statuses: {}, tools: [] }));
    const status = vi.fn(async () => ({}));
    const mcpPort = {
      callTool: vi.fn(),
      close: vi.fn(async () => undefined),
      connectConfiguredServers,
      connectServer: vi.fn(),
      disconnectServer: vi.fn(),
      listTools: vi.fn(async () => []),
      status,
    } as unknown as McpPort;
    const context = {
      deps: { env: process.env, mcpPort },
    } as unknown as RobinDoneProtocolAgentServerContext;
    const params = {
      mcpServers: [],
      workspace: { workspaceKey: root, workspacePath: root },
    };

    try {
      await listMcpServers(context, params);
      expect(connectConfiguredServers).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ revalidate: true }),
      );

      connectConfiguredServers.mockClear();
      await listMcpServers(context, { ...params, mode: "status" });
      expect(connectConfiguredServers).not.toHaveBeenCalled();
    } finally {
      if (previousStorageDir === undefined) delete process.env.ROBINDONE_STORAGE_DIR;
      else process.env.ROBINDONE_STORAGE_DIR = previousStorageDir;
      await rm(root, { force: true, recursive: true });
    }
  });
});

import { convertToRobinDoneAgentMcpServer, robindoneProtocolMcpServerSchema } from "@robindone/shared";
import { protocolMcpServersToRuntimeMcpConfig } from "../src/robindone-protocol/protocol-mcp-config.js";

it("preserves workspace provenance and cwd from Host DTO to runtime; rejects arbitrary runtime source", () => {
  const dto = convertToRobinDoneAgentMcpServer(
    "probe",
    { type: "stdio", command: "node", cwd: "tools", args: ["server.mjs"], env: { TEST: "1" } },
    "workspace",
  );
  const parsed = robindoneProtocolMcpServerSchema.parse(dto);
  expect(protocolMcpServersToRuntimeMcpConfig([parsed])?.servers.probe).toMatchObject({
    source: { kind: "workspace" },
    cwd: "tools",
    env: { TEST: "1" },
  });
  expect(robindoneProtocolMcpServerSchema.safeParse({ ...dto, source: { kind: "user" } }).success).toBe(
    false,
  );
});
