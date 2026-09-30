import type { MemoryItem } from "@armyofagents/shared";
import type { ActiveRailKind, MemoryFolderRailCounts } from "../components/memory/MemoryFolderRail";

type ItemLike = MemoryItem & {
  layer?: string | null;
  status?: string;
  founderPinnedToTop?: boolean;
  updatedAt: string | Date;
};

/**
 * Derive flat shortcut + layer counts from the flat items list.
 * Mirrors MemoryTree's internal counts memo — kept here so MemoryExplorer
 * can read them without importing MemoryTree internals.
 */
export function deriveMemoryCounts(items: MemoryItem[]): MemoryFolderRailCounts {
  const recentCutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  let pinned = 0, pending = 0, recent = 0, archived = 0;
  let identity = 0, domain = 0, active_context = 0, working = 0;

  for (const raw of items) {
    const it = raw as ItemLike;
    const isArchived = it.status === "archived";

    if (isArchived) {
      archived += 1;
      continue;
    }

    if (it.layer === "identity") identity += 1;
    else if (it.layer === "domain") domain += 1;
    else if (it.layer === "active_context") active_context += 1;
    else if (it.layer === "working") working += 1;

    if (it.founderPinnedToTop) pinned += 1;
    if (it.status === "pending") pending += 1;

    const ms = new Date(it.updatedAt).getTime();
    if (Number.isFinite(ms) && ms >= recentCutoff) recent += 1;
  }

  return { pinned, pending, recent, archived, identity, domain, active_context, working };
}

/**
 * Derive the active rail kind from the current URL state.
 */
export function activeRailKindFromUrl({
  folderPath,
  departmentId,
  layer,
}: {
  folderPath: string;
  departmentId: string | null;
  layer: string | null;
}): ActiveRailKind {
  if (!folderPath && !departmentId && !layer) return "home";
  if (folderPath === "__pinned") return "pinned";
  if (folderPath === "__pending") return "pending";
  if (folderPath === "__recent") return "recent";
  if (folderPath === "__archived") return "archived";
  if (!folderPath && !departmentId && layer) {
    const valid = ["identity", "domain", "active_context", "working"] as const;
    if (valid.includes(layer as (typeof valid)[number])) {
      return layer as ActiveRailKind;
    }
  }
  return null;
}

/**
 * Build the URL search-params string to navigate to a given rail kind.
 * Returns a relative query string like "?folder=__pinned".
 */
export function railKindToParams(kind: Exclude<ActiveRailKind, null>): string {
  if (kind === "home") return "";
  if (kind === "pinned") return "?folder=__pinned";
  if (kind === "pending") return "?folder=__pending";
  if (kind === "recent") return "?folder=__recent";
  if (kind === "archived") return "?folder=__archived";
  // Layer kinds
  return `?layer=${kind}`;
}
