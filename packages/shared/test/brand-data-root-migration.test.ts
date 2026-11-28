// 改名迁移 A1 回归（2026-11-27，specs/rename-robindone-migration.md §3.1）：
// 核心安全语义——双目录并存时**永不删除**（当日事故：无关进程抢先创建新目录占位后，
// 旧版「删旧」分支把用户真实数据根删掉了）。裁决勘误后：新目录改名让路、旧目录迁移为权威。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRAND_DATA_DIR_NAME,
  LEGACY_BRAND_DATA_DIR_NAME,
  migrateBrandDataRoot,
} from "@robindone/shared/node";

function makeBase(): { base: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "brand-migration-"));
  return { base, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function envFor(base: string): NodeJS.ProcessEnv {
  // 自定义 env 对象：HOME 指向临时目录，且不触碰真实 process.env。
  return { HOME: base } as NodeJS.ProcessEnv;
}

describe("migrateBrandDataRoot", () => {
  it("旧存在且新不存在：rename 迁移", () => {
    const { base, cleanup } = makeBase();
    try {
      const marker = join(base, LEGACY_BRAND_DATA_DIR_NAME, "v2", "setting.json");
      mkdirSync(join(base, LEGACY_BRAND_DATA_DIR_NAME, "v2"), { recursive: true });
      writeFileSync(marker, "real-data");
      const result = migrateBrandDataRoot(envFor(base));
      expect(result.status).toBe("migrated");
      expect(existsSync(join(base, BRAND_DATA_DIR_NAME, "v2", "setting.json"))).toBe(true);
      expect(existsSync(join(base, LEGACY_BRAND_DATA_DIR_NAME))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("仅新存在：settled；都不存在：fresh", () => {
    const a = makeBase();
    try {
      mkdirSync(join(a.base, BRAND_DATA_DIR_NAME));
      expect(migrateBrandDataRoot(envFor(a.base)).status).toBe("settled");
    } finally {
      a.cleanup();
    }
    const b = makeBase();
    try {
      expect(migrateBrandDataRoot(envFor(b.base)).status).toBe("fresh");
    } finally {
      b.cleanup();
    }
  });

  it("双目录并存：绝不删除——新目录改名让路、旧目录迁移为权威", () => {
    const { base, cleanup } = makeBase();
    try {
      // 旧目录 = 用户真实数据；新目录 = 抢先占位的空壳
      const oldMarker = join(base, LEGACY_BRAND_DATA_DIR_NAME, "v2", "setting.json");
      mkdirSync(join(base, LEGACY_BRAND_DATA_DIR_NAME, "v2"), { recursive: true });
      writeFileSync(oldMarker, "real-user-data");
      mkdirSync(join(base, BRAND_DATA_DIR_NAME));
      writeFileSync(join(base, BRAND_DATA_DIR_NAME, "junk.txt"), "placeholder");

      const result = migrateBrandDataRoot(envFor(base));
      expect(result.status).toBe("conflict-old-restored");
      expect(result.asideRoot).toBeDefined();

      // 权威 = 旧数据
      expect(
        existsSync(join(base, BRAND_DATA_DIR_NAME, "v2", "setting.json")),
      ).toBe(true);
      // 让路目录保留原内容，且落在 .robindone 同级（不删除）
      expect(result.asideRoot && existsSync(result.asideRoot)).toBe(true);
      expect(
        result.asideRoot && existsSync(join(result.asideRoot, "junk.txt")),
      ).toBe(true);
      expect(existsSync(join(base, LEGACY_BRAND_DATA_DIR_NAME))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("legacy env 采纳：不修改调用方传入的 env 对象", () => {
    const { base, cleanup } = makeBase();
    try {
      const env = { HOME: base, ROBINRUN_DATA_BASE_DIR: base } as NodeJS.ProcessEnv;
      const result = migrateBrandDataRoot(env);
      expect(result.legacyEnvAdopted).toBe(true);
      expect(result.baseDir).toBe(base);
      // 传入的是自定义对象（非 process.env），不得产生写透副作用
      expect(env.ROBINDONE_DATA_BASE_DIR).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
