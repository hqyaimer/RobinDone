import { DEFAULT_ROBINDONE_ENDPOINT_ORIGIN } from "./robindoneEndpoint.js";

export const ROBINDONE_SOURCE_HEADERS = {
  "User-Agent": "RobinDone/unknown",
  "HTTP-Referer": DEFAULT_ROBINDONE_ENDPOINT_ORIGIN,
  "X-Title": "RobinDone@electron",
} as const;

export interface BuildRobinDoneSourceHeadersFromContextOptions {
  appVersion?: string;
  arch?: string;
  clientLanguage?: string;
  clientTimezone?: string;
  deviceMid?: string;
  endpointOrigin?: string;
  osVersion?: string;
  platform?: string;
  releaseChannel?: string;
  sourceTitle?: string;
}

export function normalizeRobinDoneSourceHeaderValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^[\x20-\x7e]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function buildRobinDoneSourceHeadersFromContext(
  options: BuildRobinDoneSourceHeadersFromContextOptions = {},
): Record<string, string> {
  const appVersion = normalizeRobinDoneSourceHeaderValue(options.appVersion);
  const arch = normalizeRobinDoneSourceHeaderValue(options.arch);
  const clientLanguage = normalizeRobinDoneSourceHeaderValue(options.clientLanguage) ?? "unknown";
  const clientTimezone = normalizeRobinDoneSourceHeaderValue(options.clientTimezone) ?? "unknown";
  const deviceMid = normalizeRobinDoneSourceHeaderValue(options.deviceMid);
  const endpointOrigin =
    normalizeRobinDoneSourceHeaderValue(options.endpointOrigin) ??
    DEFAULT_ROBINDONE_ENDPOINT_ORIGIN;
  const osVersion = normalizeRobinDoneSourceHeaderValue(options.osVersion);
  const platform = normalizeRobinDoneSourceHeaderValue(options.platform);
  const releaseChannel = normalizeRobinDoneSourceHeaderValue(options.releaseChannel);
  const sourceTitle = normalizeRobinDoneSourceHeaderValue(options.sourceTitle) ?? "electron";

  return {
    ...ROBINDONE_SOURCE_HEADERS,
    "HTTP-Referer": endpointOrigin,
    "User-Agent": `RobinDone/${appVersion ?? "unknown"}`,
    ...(appVersion ? { "X-RobinDone-App-Version": appVersion } : {}),
    "X-Title": `RobinDone@${sourceTitle}`,
    ...(platform && arch ? { "X-Platform": `${platform}-${arch}` } : {}),
    ...(releaseChannel ? { "X-Release-Channel": releaseChannel } : {}),
    "X-Client-Language": clientLanguage,
    "X-Client-Timezone": clientTimezone,
    ...(platform ? { "X-Os-Category": normalizeOsCategory(platform) } : {}),
    ...(osVersion ? { "X-Os-Version": osVersion } : {}),
    ...(deviceMid ? { "X-Device-Mid": deviceMid } : {}),
  };
}

function normalizeOsCategory(platform: string): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}
