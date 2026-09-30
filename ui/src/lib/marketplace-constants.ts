import { Bot, Puzzle, Sparkles, type LucideIcon } from "lucide-react";
import type {
  MarketplaceCatalogItem,
  MarketplaceItemType,
  MarketplacePackage,
} from "@armyofagents/shared";

/**
 * Type-default icons. `team` uses `Bot` (not `Users`) per design-system §10.1
 * — visually a team is an "agent group," and a stacked `Bot` ×3 is the
 * canonical hero treatment for team cards (see `StackedIcon` in §9.14).
 * The flat `Bot` here is the fallback used in compact rows (e.g., the
 * marketplace package detail's included-items grid) where the StackedIcon
 * variant is too heavy.
 */
export const TYPE_ICONS: Record<MarketplaceItemType, LucideIcon> = {
  skill: Sparkles,
  agent: Bot,
  plugin: Puzzle,
  team: Bot,
};

/** Human-readable singular labels. */
export const TYPE_LABELS: Record<MarketplaceItemType, string> = {
  skill: "Skill",
  agent: "Agent",
  plugin: "Plugin",
  team: "Team",
};

/** Human-readable plural labels (used in URL paths and section headers). */
export const TYPE_LABELS_PLURAL: Record<MarketplaceItemType, string> = {
  skill: "Skills",
  agent: "Agents",
  plugin: "Plugins",
  team: "Teams",
};

/** Trust tier display config. */
export const TRUST_TIER_CONFIG = {
  verified: {
    label: "Verified",
    description: "Reviewed and signed off by AoA team",
    colorClass: "text-green-700 bg-green-50 ring-green-600/20",
    starCount: 3,
  },
  community: {
    label: "Community",
    description: "Published by community member; no AoA review",
    colorClass: "text-blue-700 bg-blue-50 ring-blue-600/20",
    starCount: 2,
  },
  unverified: {
    label: "Unverified",
    description: "No trust signals available",
    colorClass: "text-gray-700 bg-gray-50 ring-gray-600/20",
    starCount: 1,
  },
} as const;

/** Category → lucide icon name (string lookup). Extend as new categories appear. */
export const CATEGORY_ICONS: Record<string, string> = {
  engineering: "Wrench",
  integrations: "Plug",
  research: "Search",
  writing: "PenTool",
  sales: "TrendingUp",
  support: "MessageCircle",
  analytics: "BarChart3",
  design: "Palette",
  operations: "Settings",
  commander: "Compass",
  general: "Box",
};

/** Human-readable labels for runtimeRequires strings emitted by the github-skills adapter. */
export const RUNTIME_REQUIRES_LABELS: Record<string, string> = {
  "gstack-bin": "gstack CLI binaries",
  "gstack-browse-daemon": "gstack browse daemon ($B)",
  "gbrain": "gbrain module",
  "gstack-extension": "gstack Chrome extension",
};

/** Convert a runtimeRequires array to a comma-separated human-readable string. */
export function renderRuntimeRequires(reqs: string[]): string {
  return reqs.map((r) => RUNTIME_REQUIRES_LABELS[r] ?? r).join(", ");
}

/**
 * URL-path slug → MarketplaceItemType. Accepts both "Skills"/"skills"/"skill".
 * Returns null for unrecognized types (caller renders 404).
 */
export function pathToItemType(slug: string): MarketplaceItemType | null {
  const normalized = slug.toLowerCase().replace(/s$/, "");
  if (
    normalized === "skill" ||
    normalized === "agent" ||
    normalized === "plugin" ||
    normalized === "team"
  ) {
    return normalized as MarketplaceItemType;
  }
  return null;
}

/**
 * Tailwind classes for the small "single-item" tile used inside CatalogCard
 * (hero icon for skill/plugin/agent items) and MarketplacePackageDetail
 * (compact row icons in the included-items grid). Excludes "team" because
 * team items use the StackedIcon component instead — render the team branch
 * with TEAM_ICON_TONE.
 */
export const SINGLE_ICON_TONES: Record<Exclude<MarketplaceItemType, "team">, string> = {
  skill: "bg-amber-500/15 border-amber-500/30 text-amber-500",
  plugin: "bg-blue-500/15 border-blue-500/30 text-blue-500",
  agent: "bg-purple-500/15 border-purple-500/30 text-purple-500",
};

/**
 * Tailwind classes for the small "team" tile (parallel to SINGLE_ICON_TONES,
 * harmonized to the same opacity convention).
 */
export const TEAM_ICON_TONE = "bg-teal-500/15 border-teal-500/30 text-teal-500";

/**
 * Short repo label like "owner/repo" extracted from a github URL. Falls back
 * to the host + path of any other URL, then to the supplied fallback string
 * if the URL is unparseable.
 */
export function shortSource(url: string, fallback: string): string {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (m) return `${m[1]}/${m[2]!.replace(/\.git$/, "")}`;
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/^\/+|\/+$/g, "");
  } catch {
    return fallback;
  }
}

/**
 * Owner portion of a github URL (the "by-line" name on cards). Falls back to
 * "community" if the URL is not a github URL.
 */
export function authorFromSource(url: string): string {
  const m = url.match(/github\.com\/([^/]+)/i);
  return m?.[1] ?? "community";
}

/** GitHub orgs (lowercased) whose marketplace items/packages are AoA first-party. */
export const AOA_OWNERS = new Set(["aoa-curated", "meteoritelabs", "armyofagents"]);
export const AOA_DEFAULT_CREW_ITEM_ID = "team:aoa-curated/default-crew";
export const AOA_DEFAULT_CREW_MARKETPLACE_ROUTE =
  "marketplace/team/aoa-curated/default-crew";
export const AOA_DEFAULT_CREW_MARKETPLACE_PATH =
  `/${AOA_DEFAULT_CREW_MARKETPLACE_ROUTE}`;
export const AOA_DEFAULT_CREW_ROSTER_PATH = "/team?tab=aoa&aoaTab=roster";
export const MARKETPLACE_TEAM_DETAIL_ROUTE = "marketplace/team/:slug/*";

export function isAoaOwner(owner: string | null | undefined): boolean {
  return owner != null && AOA_OWNERS.has(owner.toLowerCase());
}

/** Strict github owner from a source URL; null if not a github.com URL. */
function githubOwner(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)github\.com$/i.test(u.hostname)) return null;
    return u.pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/**
 * AoA first-party identity. This is deliberately not the shelf-placement rule:
 * first-party plugins and standalone agents still belong in Plugins/Agents.
 */
export function isAoaItem(item: MarketplaceCatalogItem): boolean {
  return isAoaOwner(githubOwner(item.source.url)) || isAoaOwner(item.provider?.id);
}

/** AoA's own derived package. `id` is `owner/repo` for synthesized packages. */
export function isAoaPackage(pkg: MarketplacePackage): boolean {
  return isAoaOwner(pkg.id.split("/")[0]) || isAoaOwner(pkg.provider?.id);
}

export interface MarketplacePlacement {
  /** Default Crew plus the first-party agents required by its catalog relationship. */
  aoaItems: MarketplaceCatalogItem[];
  /** Items shown in the ordinary type shelves and global search. */
  mainItems: MarketplaceCatalogItem[];
  /** First-party skill packages shown only on the AoA shelf. */
  aoaPackages: MarketplacePackage[];
  /** Packages shown on Home and Skills. */
  mainPackages: MarketplacePackage[];
  /** Items whose detail breadcrumb belongs to AoA, including packaged skill members. */
  aoaRepresentedItemIds: ReadonlySet<string>;
}

/**
 * Build the marketplace's no-duplication placement policy from catalog
 * relationships. The Default Crew manifest is the source of truth for crew
 * membership; the UI does not carry a second list of agent slugs.
 */
export function deriveMarketplacePlacement(
  items: readonly MarketplaceCatalogItem[],
  packages: readonly MarketplacePackage[] = [],
): MarketplacePlacement {
  const defaultCrew = items.find((item) => item.id === AOA_DEFAULT_CREW_ITEM_ID);
  const crewAgentIds = new Set(
    (defaultCrew?.requires ?? [])
      .filter((requirement) => requirement.type === "agent")
      .map((requirement) => requirement.id),
  );

  const aoaItems = items.filter(
    (item) =>
      item.id === AOA_DEFAULT_CREW_ITEM_ID ||
      (item.type === "agent" && crewAgentIds.has(item.id) && isAoaItem(item)),
  );
  const aoaItemIds = new Set(aoaItems.map((item) => item.id));

  const aoaPackages = packages.filter(isAoaPackage);
  const aoaPackageMemberIds = new Set(
    aoaPackages.flatMap((pkg) => pkg.memberItemIds),
  );
  const aoaRepresentedItemIds = new Set([
    ...aoaItemIds,
    ...aoaPackageMemberIds,
  ]);

  return {
    aoaItems,
    mainItems: items.filter((item) => !aoaRepresentedItemIds.has(item.id)),
    aoaPackages,
    mainPackages: packages.filter((pkg) => !isAoaPackage(pkg)),
    aoaRepresentedItemIds,
  };
}
