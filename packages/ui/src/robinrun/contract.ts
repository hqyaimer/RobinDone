/**
 * robinrun-launcher 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 *
 * 本模块承载 RobinRun 的"项目注册表"（AppSettings.robinrunProjects）与零项目首建页：
 * - 注册表只服务启动编排（冷启动自动打开最近项目、首建页列表），不是项目权威数据；
 *   权威项目树在 Host 侧（projectService.readTree），两者不互相推导。
 * - 纯函数实现在 projectRegistry.ts（也是公开入口，root 编排 hooks 直接复用）。
 * - 所有写路径幂等（按 path upsert），失败不阻断打开流程。
 */
export type { RobinRunProjectEntry } from "@robinrun/shared";
