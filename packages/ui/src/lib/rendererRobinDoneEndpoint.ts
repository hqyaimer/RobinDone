import {
  buildRuntimeRobinDoneEndpointUrls,
  ROBINDONE_ENV,
  type RuntimeRobinDoneEndpointEnv,
} from "@robindone/shared";

interface RendererImportMetaEnv {
  VITE_ROBINDONE_BASE_URL?: string;
  VITE_ROBINDONE_ENDPOINT_ORIGIN?: string;
}

function readRendererImportMetaEnv(): RendererImportMetaEnv {
  return ((import.meta as ImportMeta & { env?: RendererImportMetaEnv }).env ??
    {}) as RendererImportMetaEnv;
}

export function createRendererRobinDoneEndpointEnv(
  env: RendererImportMetaEnv = readRendererImportMetaEnv(),
): RuntimeRobinDoneEndpointEnv {
  return {
    ROBINDONE_ENV,
    // UI 侧的 robindone-plan 占位 provider 以前只看 ROBINDONE_ENV，
    // 没有消费 Vite 注入的 base url，导致自定义测试域名时 renderer 和 host/service 可能不一致。
    ROBINDONE_BASE_URL: env.VITE_ROBINDONE_BASE_URL,
    ROBINDONE_ENDPOINT_ORIGIN: env.VITE_ROBINDONE_ENDPOINT_ORIGIN,
  };
}

export const RENDERER_ROBINDONE_ENDPOINT_URLS = buildRuntimeRobinDoneEndpointUrls(
  createRendererRobinDoneEndpointEnv(),
);
