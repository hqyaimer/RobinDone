import { buildRuntimeRobinDoneApiUrl, resolveZaiBusinessBaseUrl } from "@robindone/shared";

export const ROBINDONE_CLIENT_SCENES_URL = buildRuntimeRobinDoneApiUrl(
  process.env,
  "/api/v1/client/scenes",
);

export const ZAI_API_HOST = resolveZaiBusinessBaseUrl(process.env);
