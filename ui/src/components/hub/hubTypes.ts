import type { HubItemListRow } from "@/api/hub-items";
import type { HubGroupMode, HubLane, HubSemanticType } from "@armyofagents/shared";
import type { LucideIcon } from "lucide-react";
import type { HubTabKind } from "./hubViewerModel";

export type HubViewerKind =
  | "approval"
  | "discussion"
  | "task"
  | "notification"
  | "suggestion"
  | "reserved";

export interface HubRegistryEntry {
  semanticType: HubSemanticType;
  lane: HubLane;
  label: string;
  icon: LucideIcon;
  viewerKind: HubViewerKind;
  fullLink: (item: HubItemListRow) => string | null;
  /**
   * Which viewer-tab kind this semantic type opens when its row is clicked.
   * Static per type (per the tabbed-architecture doc §2 table); `hubTabForItem`
   * refines it where a single semantic type spans two entity kinds (e.g. a
   * `mention` on a task vs a thread).
   */
  tabKind: HubTabKind;
  /**
   * Resolve the TARGET entity id for the tab. ALWAYS prefers the
   * server-persisted `relatedEntityId`; falls back to a per-semanticType parse
   * of the composite `sourceId` (never a generic `split(":")[0]`).
   */
  resolveTabId: (item: HubItemListRow) => string;
}

export type HubListEntry =
  | { kind: "item"; item: HubItemListRow }
  | {
      kind: "group";
      key: string;
      label: string;
      summary: string | null;
      items: HubItemListRow[];
      unreadCount: number;
    };

export function buildHubListEntries(
  items: HubItemListRow[],
  groupMode: HubGroupMode,
): HubListEntry[] {
  if (groupMode === "none") return items.map((item) => ({ kind: "item", item }));

  const entries: HubListEntry[] = [];
  const grouped = new Map<string, HubItemListRow[]>();

  for (const item of items) {
    if (item.priority === "high" || item.priority === "urgent" || !item.groupKey) {
      entries.push({ kind: "item", item });
      continue;
    }
    const bucket = grouped.get(item.groupKey) ?? [];
    bucket.push(item);
    grouped.set(item.groupKey, bucket);
  }

  const emittedGroups = new Set<string>();
  for (const item of items) {
    if (item.priority === "high" || item.priority === "urgent" || !item.groupKey) continue;
    if (emittedGroups.has(item.groupKey)) continue;
    emittedGroups.add(item.groupKey);
    const groupItems = grouped.get(item.groupKey) ?? [];
    if (groupItems.length < 3) {
      entries.push(...groupItems.map((groupItem) => ({ kind: "item" as const, item: groupItem })));
      continue;
    }
    entries.push({
      kind: "group",
      key: item.groupKey,
      label: item.curationGroupLabel ?? item.groupLabel ?? item.groupKey,
      summary: groupItems.find((groupItem) => groupItem.curationGroupSummary)?.curationGroupSummary ?? null,
      items: groupItems,
      unreadCount: groupItems.filter((groupItem) => !groupItem.readAt).length,
    });
  }

  return entries;
}
