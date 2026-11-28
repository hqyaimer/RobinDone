import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

import engineeringTestFiles from "./scripts/engineering-test-files.json";

export default defineConfig({
  // 测试固定注入事件上报端点，使遥测上报链路在单测中可验证；真实构建由 scripts/build-time-config.mjs 决定。
  define: {
    __ROBINDONE_TELEMETRY_REPORT_ENDPOINT__: JSON.stringify(
      "https://zcode.z.ai/api/v1/event/report",
    ),
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "packages/ui/src"),
      "@desktop": resolve(__dirname, "packages/desktop/src"),
      "@web": resolve(__dirname, "packages/web/src"),
      // 间接 import desktopNetworkTelemetry 等的单测无需真实 ARMS；需 vi.fn 的用例在文件内 vi.mock 覆盖
      // Bugfix: 具体的 /browser 子路径必须排在包根别名前，否则会被根别名拼成不存在的 stub.ts/browser。
      "@arms/rum-electron/browser": resolve(
        __dirname,
        "packages/desktop/test/mocks/armsRumElectronStub.ts",
      ),
      "@arms/rum-electron": resolve(
        __dirname,
        "packages/desktop/test/mocks/armsRumElectronStub.ts",
      ),
    },
  },
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // 官方依赖图不追踪 setupFiles；公共配置变化必须明确选中整个工程套件并报告跳过。
    forceRerunTriggers: [
      ...configDefaults.forceRerunTriggers,
      "**/{vitest,vite}.config.*",
      "**/vitest.setup.ts",
      // managed worktree 路径含 .codex，globstar 默认不匹配隐藏目录；关键入口用精确绝对路径。
      ...[
        "package.json",
        "vitest.config.ts",
        "vitest.setup.ts",
        "scripts/engineering-test-files.json",
      ].map((file) => resolve(__dirname, file)),
    ],
    // 修复原因：全量 run 的 stdout 会把**通过**测试里的 console 输出一并转发——services 层
    // 用 createServiceLogger 的用例在绿态下也要刷几千行多行日志，全量输出因此膨胀到
    // ~3.3MB，超过 CI/工作流门禁对单条命令 256KB 的 stdout 上限，导致门禁整条命令被判
    // 「无法执行」而非测试失败。passed-only 只隐藏通过测试的 console，失败用例的日志与
    // 断言 diff 原样保留（诊断能力不降级）；全绿时输出收敛到 ~140KB。
    silent: "passed-only",
    // 修复原因：全量单测并发跑 Git、zip、Electron 模块导入时，默认 5s 超时在低配或高负载机器上
    // 容易被提前打穿（spawn git 子进程、模块 import 变慢 → flaky 超时）；中断后的文件句柄清理在
    // Windows 上还会触发 EPERM/ENOTEMPTY。此前只给 Windows 放宽，但 macOS/Linux 低配机同样会因
    // 内存抖动（swap thrashing）拖慢 spawn，故统一降低并发并放宽超时。
    hookTimeout: 30_000,
    maxWorkers: 4,
    testTimeout: 30_000,
    // 工程测试使用明确清单；不再发现 App 业务单测。真实子进程测试串行运行。
    projects: [
      {
        extends: true,
        test: {
          name: "engineering",
          include: engineeringTestFiles,
          pool: "forks",
          fileParallelism: false,
          maxWorkers: 1,
          // 数据目录隔离（2026-11-27 事故防线）：个别测试会拉起真实 electron/CLI/host 子进程，
          // 这些进程的品牌迁移与存储启动代码会读写真实 `~/.robindone`（当日 `.robindone` 的
          // 首次诞生即源于此）。给整个 engineering 项目注入临时数据根/HOME，子进程经
          // process.env 继承，从根上保证测试永不触碰真实用户数据。个别需要真实路径语义的
          // 测试可在用例内显式覆盖回自己的临时目录。
          env: {
            ROBINDONE_DATA_BASE_DIR: join(tmpdir(), "robindone-vitest-isolation"),
            ROBINDONE_DESKTOP_HOME_DIR: join(tmpdir(), "robindone-vitest-isolation"),
          },
        },
      },
      "packages/robindone-cua/vitest.config.ts",
    ],
  },
});
