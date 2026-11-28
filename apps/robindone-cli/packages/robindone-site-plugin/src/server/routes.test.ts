import { describe, expect, it } from "vitest";
import { resourcePath } from "./routes.ts";

const SITE = "1978123456789012480";
const DEP = "1978123456789012481";

describe("resourcePath", () => {
  it.each([
    ["robindone-site://usage", "/api/v1/sites/usage"],
    ["robindone-site://plans", "/api/v1/sites/plans"],
    ["robindone-site://sites", "/api/v1/sites"],
    ["robindone-site://sites?cursor=", "/api/v1/sites"],
    ["robindone-site://sites?cursor=a%2Fb&limit=20", "/api/v1/sites?cursor=a%2Fb&limit=20"],
    [`robindone-site://sites/${SITE}`, `/api/v1/sites/${SITE}`],
    [
      `robindone-site://sites/${SITE}/deployments?cursor=x`,
      `/api/v1/sites/${SITE}/deployments?cursor=x`,
    ],
    [`robindone-site://sites/${SITE}/deployments/${DEP}`, `/api/v1/sites/${SITE}/deployments/${DEP}`],
    [`robindone-site://sites/${SITE}/cover`, `/api/v1/sites/${SITE}/cover`],
    [
      `robindone-site://sites/${SITE}/deployments/${DEP}/logs?offset=12`,
      `/api/v1/sites/${SITE}/deployments/${DEP}/logs?offset=12`,
    ],
  ])("maps %s", (uri, path) => {
    expect(resourcePath(uri)).toBe(path);
  });

  it.each([
    "robindone-site://other",
    "https://sites/1",
    "robindone-site://usage?cursor=1",
    "robindone-site://plans?limit=1",
    "robindone-site://plans/free",
    "robindone-site://sites/abc",
    "robindone-site://sites/0123",
    "robindone-site://sites/1/deployments/2/logs/extra",
    "robindone-site://sites/1/cover/2",
    "robindone-site://sites/1/cover?offset=1",
    "robindone-site://sites/1/settings",
    "robindone-site://sites/1/deployments/2/logs?offset=-1",
    "robindone-site://sites?limit=1e3",
    "robindone-site://sites?cursor=a&cursor=b",
    "robindone-site://sites/1/deployments/2?offset=1",
    "robindone-site://user@sites",
    "robindone-site://sites/..%2Fusage",
    "not a uri",
  ])("rejects %s", (uri) => {
    expect(resourcePath(uri)).toBeUndefined();
  });
});
