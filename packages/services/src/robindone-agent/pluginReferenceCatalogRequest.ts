import {
  robindoneProtocolMethods,
  robindonePluginsReferenceCatalogResultSchema,
  type RobinDonePluginsReferenceCatalogParams,
} from "@robindone/shared";
import type { RobinDoneProtocolClient } from "#src/robindone-agent/robindoneProtocolClient.js";

/** 旧协议严格校验响应；新展示字段走独立入口，只有 -32601 能证明旧 Agent 不支持。 */
export async function requestPluginReferenceCatalog(
  client: Pick<RobinDoneProtocolClient, "request">,
  params: RobinDonePluginsReferenceCatalogParams,
) {
  try {
    return await client.request(
      robindoneProtocolMethods.pluginsReferenceCatalogWithCategory,
      params,
      robindonePluginsReferenceCatalogResultSchema,
    );
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === -32601))
      throw error;
    return client.request(
      robindoneProtocolMethods.pluginsReferenceCatalog,
      params,
      robindonePluginsReferenceCatalogResultSchema,
    );
  }
}
