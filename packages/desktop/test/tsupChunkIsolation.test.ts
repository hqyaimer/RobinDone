import { describe, expect, it } from "vitest";
import tsupConfig, {
  resolveBuildPackagedAgentTelemetryEnv,
  resolveBuildRemoteCdnReleaseRoots,
  resolveDesktopTsupBundleSecurityOptions,
} from "../tsup.config";

type EsbuildLikeOptions = {
  chunkNames?: string;
  legalComments?: string;
};

function getChunkNames(configName: string): string | undefined {
  const configs = Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig];
  const target = configs.find((config) => config.name === configName);
  expect(target).toBeDefined();

  const esbuildOptions: EsbuildLikeOptions = {};
  target?.esbuildOptions?.(esbuildOptions);
  return esbuildOptions.chunkNames;
}

function getExternal(configName: string): string[] {
  const configs = Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig];
  const target = configs.find((config) => config.name === configName);
  expect(target).toBeDefined();
  expect(Array.isArray(target?.external)).toBe(true);
  return target?.external as string[];
}

function getNoExternal(configName: string): string[] {
  const configs = Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig];
  const target = configs.find((config) => config.name === configName);
  expect(target).toBeDefined();
  expect(Array.isArray(target?.noExternal)).toBe(true);
  return target?.noExternal as string[];
}

function getDefines(configName: string): Record<string, string> {
  const configs = Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig];
  const target = configs.find((config) => config.name === configName);
  expect(target).toBeDefined();
  return target?.define ?? {};
}

describe("desktop tsup chunk isolation", () => {
  it("ZIP 解包器应外置，避免 Electron ESM 启动时动态 require fs 崩溃", () => {
    for (const name of ["main", "host", "scheduler"]) expect(getExternal(name)).toContain("yauzl");
  });
  it("main 构建应将 chunk 输出到 main 子目录，避免覆盖 host 构建产物", () => {
    expect(getChunkNames("main")).toBe("main/chunk-[hash]");
  });

  it("host 构建应将 chunk 输出到 host 子目录，避免覆盖 main 构建产物", () => {
    expect(getChunkNames("host")).toBe("host/chunk-[hash]");
  });

  it("main/host 构建应外置飞书 SDK，避免 Electron ESM 动态 require 崩溃", () => {
    expect(getExternal("main")).toContain("@larksuiteoapi/node-sdk");
    expect(getExternal("host")).toContain("@larksuiteoapi/node-sdk");
  });

  it("main/host 构建应外置 yaml，避免 Electron ESM 动态 require 崩溃", () => {
    expect(getExternal("main")).toContain("yaml");
    expect(getExternal("host")).toContain("yaml");
  });

  it("main/host/scheduler 应内联 CUA producer，安装包不能依赖被排除的 @robindone node_modules", () => {
    for (const configName of ["main", "host", "scheduler"]) {
      expect(getNoExternal(configName)).toContain("@robindone/robindone-cua");
    }
  });

  it("main/host/scheduler 应内联 Provider workspace 包，Electron 不能直接加载 TypeScript 源码", () => {
    for (const configName of ["main", "host", "scheduler"]) {
      expect(getNoExternal(configName)).toContain("@robindone/provider");
      expect(getNoExternal(configName)).toContain("@robindone/provider-node");
    }
  });

  it("生产构建应压缩 main/host/preload 且不生成 sourcemap", () => {
    expect(resolveDesktopTsupBundleSecurityOptions({ NODE_ENV: "production" })).toEqual({
      keepNames: true,
      minify: true,
      sourcemap: false,
    });
  });

  it("开发构建应保留 sourcemap 方便本地调试", () => {
    expect(resolveDesktopTsupBundleSecurityOptions({ NODE_ENV: "development" })).toEqual({
      keepNames: false,
      minify: false,
      sourcemap: true,
    });
  });

  it("E2E coverage 构建应关闭压缩并保留 sourcemap", () => {
    expect(
      resolveDesktopTsupBundleSecurityOptions({
        NODE_ENV: "production",
        ROBINDONE_E2E_COVERAGE: "1",
      }),
    ).toEqual({
      keepNames: false,
      minify: false,
      sourcemap: true,
    });
  });

  it("remote runtime CDN 根应可由 CI 的 CDN_DOMAIN/OSS_PATH_PREFIX 多值注入", () => {
    expect(
      resolveBuildRemoteCdnReleaseRoots({
        CDN_DOMAIN: "cdn-robindone.z.ai,cdn.robindone-ai.com",
        OSS_PATH_PREFIX: "robindone/electron/releases",
      }),
    ).toEqual([
      // 改名跟进（specs/rename-robindone-migration.md）：注入域名/路径前缀的派生结果跟随
      // 当前产品名，期望值不再是上游 zcode 时代的 CDN 值。
      "https://cdn-robindone.z.ai/robindone/electron/releases",
      "https://cdn.robindone-ai.com/robindone/electron/releases",
    ]);
  });

  it("remote runtime CDN 根的路径前缀数量不匹配时应失败", () => {
    expect(() =>
      resolveBuildRemoteCdnReleaseRoots({
        CDN_DOMAIN: "cdn-robindone.z.ai,cdn.robindone-ai.com",
        OSS_PATH_PREFIX: "new-prefix,old-prefix,extra-prefix",
      }),
    ).toThrow("OSS_PATH_PREFIX must contain one value or match CDN_DOMAIN count");
  });

  it("正式安装包 Agent OTLP 配置应映射为 Main 使用的标准环境字段", () => {
    expect(
      resolveBuildPackagedAgentTelemetryEnv({
        ROBINDONE_ENV: "production",
        ROBINDONE_PACKAGED_AGENT_OTEL_ENDPOINT: "https://arms.example.com/otlp",
        ROBINDONE_PACKAGED_AGENT_OTEL_HEADERS: "x-arms-license-key=write-only",
        ROBINDONE_PACKAGED_AGENT_OTEL_SERVICE_NAME: "robindone-cli-agent",
      }),
    ).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://arms.example.com/otlp",
      OTEL_EXPORTER_OTLP_HEADERS: "x-arms-license-key=write-only",
      OTEL_SERVICE_NAME: "robindone-cli-agent",
      ROBINDONE_TELEMETRY_RUNTIME_DISTRIBUTION: "packaged",
    });
  });

  it("正式安装包 Agent OTLP 配置不完整或生产环境使用 HTTP 时应阻止构建", () => {
    expect(() =>
      resolveBuildPackagedAgentTelemetryEnv({
        ROBINDONE_ENV: "production",
        ROBINDONE_PACKAGED_AGENT_OTEL_ENDPOINT: "https://arms.example.com/otlp",
      }),
    ).toThrow("must be configured together");
    expect(() =>
      resolveBuildPackagedAgentTelemetryEnv({
        ROBINDONE_ENV: "production",
        ROBINDONE_PACKAGED_AGENT_OTEL_ENDPOINT: "http://arms.example.com/otlp",
        ROBINDONE_PACKAGED_AGENT_OTEL_HEADERS: "x-arms-license-key=write-only",
      }),
    ).toThrow("must use HTTPS in production");
  });

  it("release/current 与 Tag 构建缺少 Agent OTLP 配置时应失败，普通开发构建保持 Noop", () => {
    expect(resolveBuildPackagedAgentTelemetryEnv({})).toEqual({});
    expect(() =>
      resolveBuildPackagedAgentTelemetryEnv({
        CI: "true",
        CI_COMMIT_BRANCH: "release/current",
      }),
    ).toThrow("required for release builds");
    expect(() =>
      resolveBuildPackagedAgentTelemetryEnv({
        CI: "true",
        CI_COMMIT_TAG: "v3.6.0",
      }),
    ).toThrow("required for release builds");
  });

  it("安装包身份与后端环境作为两个编译期常量注入每个 bundle", () => {
    // 打包后的应用不能依赖机器环境变量：ROBINDONE_PREVIEW_IDENTITY 在构建时折叠成 __ROBINDONE_PRODUCT_FLAVOR__。
    for (const entry of ["main", "host", "preload"] as const) {
      const defines = getDefines(entry);
      expect(defines).toHaveProperty("__ROBINDONE_ENV__");
      expect(defines).toHaveProperty("__ROBINDONE_PRODUCT_FLAVOR__");
      expect(['"production"', '"preview"']).toContain(defines.__ROBINDONE_PRODUCT_FLAVOR__);
    }
  });

  it("Agent OTLP 部署默认值只应编译进 Main bundle", () => {
    expect(getDefines("main")).toHaveProperty("__ROBINDONE_PACKAGED_AGENT_TELEMETRY_ENV__");
    expect(getDefines("host")).not.toHaveProperty("__ROBINDONE_PACKAGED_AGENT_TELEMETRY_ENV__");
    expect(getDefines("preload")).not.toHaveProperty("__ROBINDONE_PACKAGED_AGENT_TELEMETRY_ENV__");
  });

  it("所有 tsup 子构建都应关闭 esbuild legal comments 输出", () => {
    for (const configName of ["main", "host", "preload"]) {
      const configs = Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig];
      const target = configs.find((config) => config.name === configName);
      expect(target).toBeDefined();

      const esbuildOptions: EsbuildLikeOptions = {};
      target?.esbuildOptions?.(esbuildOptions);
      expect(esbuildOptions.legalComments).toBe("none");
    }
  });
});
