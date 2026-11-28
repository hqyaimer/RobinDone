// P2.5 会话创建来源标识：session 表 creation_origin 列读写 + upsert 首写优先。
// 回归背景：加列时 INSERT 列清单与 VALUES 占位符失配（"24 values for 25 columns"），
// prepare 直接抛错导致所有会话创建失败（用户侧表现为发送失败）。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProjectId, createSessionId } from "@robindone/contracts";
import { createSqliteSessionStore } from "../src/storage/index.js";

describe("session creation_origin", () => {
  it("persists creation origin and keeps first write on upsert", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "robindone-session-creation-origin-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });

    try {
      const sessionID = createSessionId("origin-persist");
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("origin-project"),
        slug: "origin-persist",
        directory: tempRoot,
        title: "origin",
        version: "0.1.0",
        creationOrigin: { kind: "agent", ref: "sess_parent_1" },
      });

      const loaded = await store.getSession(sessionID);
      expect(loaded?.creationOrigin).toEqual({ kind: "agent", ref: "sess_parent_1" });

      // 幂等重建（冲突路径）：已带来源的行不被后续缺省/不同来源覆盖。
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("origin-project"),
        slug: "origin-persist",
        directory: tempRoot,
        title: "origin-2",
        version: "0.1.0",
        creationOrigin: { kind: "user" },
      });
      const afterUpsert = await store.getSession(sessionID);
      expect(afterUpsert?.creationOrigin).toEqual({ kind: "agent", ref: "sess_parent_1" });
      expect(afterUpsert?.title).toBe("origin-2");
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("defaults to no origin when unspecified", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "robindone-session-creation-origin-default-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });

    try {
      const sessionID = createSessionId("origin-absent");
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("origin-project"),
        slug: "origin-absent",
        directory: tempRoot,
        title: "no-origin",
        version: "0.1.0",
      });
      const loaded = await store.getSession(sessionID);
      expect(loaded?.creationOrigin).toBeUndefined();
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
