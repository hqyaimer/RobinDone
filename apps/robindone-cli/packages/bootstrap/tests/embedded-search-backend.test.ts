import { describe, expect, it } from "vitest";
import { resolveDefaultEmbeddedSearchBackend } from "../src/app/embedded-search-backend.js";

describe("resolveDefaultEmbeddedSearchBackend", () => {
  it("uses bundled bfs, ugrep, and ripgrep paths by default", () => {
    expect(
      resolveDefaultEmbeddedSearchBackend({
        env: {
          ROBINDONE_BFS_BINARY: "/opt/robindone/tools/bfs/bfs",
          ROBINDONE_RG_BINARY: "/opt/robindone/tools/ripgrep/rg",
          ROBINDONE_UGREP_BINARY: "/opt/robindone/tools/ugrep/ugrep",
        },
      }),
    ).toEqual({
      kind: "native-binaries",
      findCommand: "/opt/robindone/tools/bfs/bfs",
      grepCommand: "/opt/robindone/tools/ugrep/ugrep",
      rgCommand: "/opt/robindone/tools/ripgrep/rg",
    });
  });

  it("falls back to bfs, ugrep, and rg command names when bundled paths are unavailable", () => {
    expect(resolveDefaultEmbeddedSearchBackend({ env: {} })).toEqual({
      kind: "native-binaries",
      findCommand: "bfs",
      grepCommand: "ugrep",
      rgCommand: "rg",
    });
  });

  it("preserves the explicit internal CLI compatibility override", () => {
    expect(
      resolveDefaultEmbeddedSearchBackend({
        env: { ROBINDONE_EMBEDDED_SEARCH_COMMAND: "/tmp/robindone-test" },
      }),
    ).toEqual({
      kind: "internal-cli",
      command: "/tmp/robindone-test",
      args: ["__internal-search"],
    });
  });
});
