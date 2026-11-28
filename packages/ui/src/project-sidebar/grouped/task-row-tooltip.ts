import type { RobinDoneTaskChangeSummary } from "@robindone/shared";

export function formatGroupedTaskHoverChangeParts(
  summary: RobinDoneTaskChangeSummary | null,
): string[] {
  if (!summary) {
    return [];
  }

  const parts: string[] = [];
  if (summary.added > 0) {
    parts.push(`+${summary.added}`);
  }
  if (summary.removed > 0) {
    parts.push(`-${summary.removed}`);
  }
  return parts;
}
