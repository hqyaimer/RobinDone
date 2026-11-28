const ROBINDONE_PROCESS_PREFIX = "robindone";
const MAX_PROCESS_NAME_SEGMENT_LENGTH = 24;

function sanitizeProcessNameSegment(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, MAX_PROCESS_NAME_SEGMENT_LENGTH);
}

function joinRobinDoneProcessName(...segments: Array<string | null | undefined>): string {
  const sanitizedSegments = segments
    .map((segment) => sanitizeProcessNameSegment(segment))
    .filter((segment): segment is string => Boolean(segment));
  return [ROBINDONE_PROCESS_PREFIX, ...sanitizedSegments].join("-");
}

function pickWorkspaceTag(workspacePath: string | null | undefined): string | undefined {
  const trimmedPath = workspacePath?.trim();
  if (!trimmedPath) {
    return undefined;
  }

  const parts = trimmedPath.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? trimmedPath;
}

export function formatRobinDoneMainProcessName(): string {
  return joinRobinDoneProcessName("main");
}

export function formatRobinDoneGpuProcessName(): string {
  return joinRobinDoneProcessName("gpu");
}

export function formatRobinDoneHostProcessName(label?: string): string {
  return joinRobinDoneProcessName("host", label);
}

export function formatRobinDoneRendererProcessName(windowTitle?: string): string {
  const normalizedTitle = windowTitle?.trim();
  if (!normalizedTitle || normalizedTitle === "RobinDone") {
    return joinRobinDoneProcessName("renderer", "main");
  }

  if (normalizedTitle === "Resource Manager") {
    return joinRobinDoneProcessName("renderer", "resource-manager");
  }

  const remoteWindowPrefix = "RobinDone - ";
  if (normalizedTitle.startsWith(remoteWindowPrefix)) {
    return joinRobinDoneProcessName(
      "renderer",
      "remote",
      normalizedTitle.slice(remoteWindowPrefix.length),
    );
  }

  return joinRobinDoneProcessName("renderer", normalizedTitle);
}

export function formatRobinDoneAgentProcessName(provider: string, workspacePath?: string): string {
  return joinRobinDoneProcessName("agent", provider, pickWorkspaceTag(workspacePath));
}

export function formatRobinDoneUtilityProcessName(name?: string, type = "utility"): string {
  return joinRobinDoneProcessName(type, name);
}
