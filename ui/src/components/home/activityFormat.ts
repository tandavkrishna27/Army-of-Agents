import type { RecentActivityItem } from "@armyofagents/shared";
export function formatAction(item: RecentActivityItem): string {
  return item.action.replace(/[._]/g, " ").replace(/\bissue\b/g, "task");
}
export function activityEntityName(item: RecentActivityItem): string {
  const details = item.details as Record<string, unknown> | null;
  if (details?.title && typeof details.title === "string") return details.title;
  if (details?.name && typeof details.name === "string") return details.name;
  return item.entityType === "issue" ? "task" : item.entityType;
}

/**
 * Collapse consecutive activity items that share `action`+`entityType`+
 * `entityId` into a single entry carrying a `count`, so a burst of identical
 * events (e.g. an agent re-saving the same task several times in a row)
 * renders as one de-noised row instead of N near-identical ones.
 *
 * Only ADJACENT duplicates collapse (a next-fit run, not a global group-by) —
 * an intervening different event keeps the two occurrences separate, so the
 * feed's chronological order is never reshuffled. `recentActivity` arrives
 * newest-first, so the first item of a run is already the newest; it's the
 * one kept (with its `count` bumped), so "keep the newest createdAt" falls
 * out for free without touching the field.
 */
export function collapseActivity(
  items: RecentActivityItem[],
): (RecentActivityItem & { count: number })[] {
  const result: (RecentActivityItem & { count: number })[] = [];
  for (const item of items) {
    const last = result[result.length - 1];
    if (last && last.action === item.action && last.entityType === item.entityType && last.entityId === item.entityId) {
      last.count += 1;
    } else {
      result.push({ ...item, count: 1 });
    }
  }
  return result;
}
