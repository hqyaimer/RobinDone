import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  removeSourceMapFilesInDirectory,
  stripSourceMappingUrlComments,
  stripSourceMappingUrlCommentsInDirectory,
} from "../scripts/packaged-sourcemap-cleanup.mjs";

// Windows 无开发者模式时 symlinkSync 会 EPERM；能力探测失败则跳过 symlink 相关用例。
const canCreateSymlinks = (() => {
  try {
    const probe = mkdtempSync(resolve(tmpdir(), "robinrun-symlink-probe-"));
    symlinkSync("target", resolve(probe, "link"), "file");
    rmSync(probe, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

describe("packaged sourcemap cleanup", () => {
  it("应删除 JS/CSS 里的 sourceMappingURL 注释但保留普通内容", () => {
    expect(
      stripSourceMappingUrlComments(
        [
          "const answer = 42;",
          "//# sourceMappingURL=index.js.map",
          "body{color:red}",
          "/*# sourceMappingURL=index.css.map */",
        ].join("\n"),
      ),
    ).toBe(["const answer = 42;", "body{color:red}"].join("\n"));
  });

  it("应递归清理发布资源目录里的 sourcemap 文件和路径注释", () => {
    const rootDir = mkdtempSync(resolve(tmpdir(), "robinrun-sourcemap-cleanup-test-"));
    try {
      const nestedDir = resolve(rootDir, "nested");
      mkdirSync(nestedDir, { recursive: true });
      const jsFile = resolve(nestedDir, "index.js");
      const cssFile = resolve(rootDir, "style.css");
      const mapFile = resolve(nestedDir, "index.js.map");
      const jsonFile = resolve(rootDir, "package.json");

      writeFileSync(jsFile, "console.log('ok');\n//# sourceMappingURL=index.js.map\n");
      writeFileSync(cssFile, ".x{color:red}\n/*# sourceMappingURL=style.css.map */");
      writeFileSync(mapFile, "{}");
      writeFileSync(jsonFile, '{"sourceMappingURL":"keep"}');

      expect(stripSourceMappingUrlCommentsInDirectory(rootDir)).toEqual({
        filesChanged: 2,
        referencesRemoved: 2,
      });
      expect(removeSourceMapFilesInDirectory(rootDir)).toEqual({ filesRemoved: 1 });

      expect(readFileSync(jsFile, "utf8")).toBe("console.log('ok');\n");
      expect(readFileSync(cssFile, "utf8")).toBe(".x{color:red}");
      expect(readFileSync(jsonFile, "utf8")).toBe('{"sourceMappingURL":"keep"}');
      expect(existsSync(mapFile)).toBe(false);
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it.skipIf(!canCreateSymlinks)(
    "应跳过符号链接条目（不跟随/不改写，悬空链接不炸遍历）",
    () => {
      const rootDir = mkdtempSync(resolve(tmpdir(), "robinrun-sourcemap-symlink-test-"));
      try {
        // 复刻 v0.0.3 首跑 CI 现场：随包 python 的 bin/2to3 等符号链接在打包产物里
        // 目标缺失（悬空），旧实现 statSync 跟随链接直接 ENOENT 崩掉 afterPack。
        const danglingLink = resolve(rootDir, "dangling.js");
        symlinkSync("missing-target.js", danglingLink, "file");
        const realJs = resolve(rootDir, "real.js");
        writeFileSync(realJs, "console.log('ok');\n//# sourceMappingURL=real.js.map\n");
        const linkedJs = resolve(rootDir, "linked.js");
        symlinkSync(resolve(rootDir, "real.js"), linkedJs, "file");

        // 只有真实文件参与剥离；悬空/有效链接都不被跟随（linked.js 是链接、real.js
        // 是它指向的真实文件——遍历走目录树只会命中 real.js 一次）。
        expect(stripSourceMappingUrlCommentsInDirectory(rootDir)).toEqual({
          filesChanged: 1,
          referencesRemoved: 1,
        });
        expect(removeSourceMapFilesInDirectory(rootDir)).toEqual({ filesRemoved: 0 });

        // 链接本体保持原样（不被删除、不被改写成普通文件）。
        expect(lstatSync(danglingLink).isSymbolicLink()).toBe(true);
        expect(lstatSync(linkedJs).isSymbolicLink()).toBe(true);
      } finally {
        rmSync(rootDir, { force: true, recursive: true });
      }
    },
  );

  it("应跳过目录联接（junction）不越界遍历（Windows 免权限覆盖）", () => {
    const rootDir = mkdtempSync(resolve(tmpdir(), "robinrun-sourcemap-junction-test-"));
    const externalDir = mkdtempSync(resolve(tmpdir(), "robinrun-sourcemap-junction-target-"));
    try {
      // junction 在 Windows 上无需特权即可创建；lstatSync 报告为符号链接，
      // 走同一跳过分支——遍历不得进入链接目标目录改写外部文件。
      const externalJs = resolve(externalDir, "external.js");
      writeFileSync(externalJs, "console.log('external');\n//# sourceMappingURL=external.js.map\n");
      symlinkSync(externalDir, resolve(rootDir, "linked-dir"), "junction");
      writeFileSync(resolve(rootDir, "host.js"), "//# sourceMappingURL=host.js.map\n");

      expect(stripSourceMappingUrlCommentsInDirectory(rootDir)).toEqual({
        filesChanged: 1,
        referencesRemoved: 1,
      });
      // 外部目标文件原样未动。
      expect(readFileSync(externalJs, "utf8")).toContain("sourceMappingURL");
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
      rmSync(externalDir, { force: true, recursive: true });
    }
  });
});
