/**
 * @fileoverview Frontend API client for the AoA marketplace catalog.
 *
 * All functions in `marketplaceApi` map 1:1 to REST endpoints on
 * `server/src/routes/marketplace.ts`. Skeleton for M.3 frontend work.
 *
 * @see server/src/routes/marketplace.ts for endpoint implementation details.
 */

import type {
  CatalogItem,
  CatalogSyncStatus,
  MarketplaceCatalogFile,
  MarketplaceItemType,
  MarketplacePackage,
  MarketplaceSettings,
  PendingUpdate,
} from "@armyofagents/shared";

export type { PendingUpdate };

export type { MarketplaceSettings };
import { api } from "./client";

// M.3b: Install flow types — wired to backend endpoints from M.2.

export interface SingleInstallRequest {
  catalogItemId: string;
  targetDepartmentId?: string;
  idempotencyKey?: string;
  role?: "cxo" | "lead" | "general";
  adapterType?: string;
}

export interface PackageInstallRequest {
  packageId: string;
  catalogItemIds: string[];
  idempotencyKey?: string;
}

export type InstallRequest = SingleInstallRequest | PackageInstallRequest;

export interface InstallOperation {
  id: string;
  companyId: string;
  catalogItemId: string;
  itemType: "plugin" | "skill" | "agent" | "team" | "package";
  targetDepartmentId: string | null;
  status: "pending" | "running" | "success" | "failure" | "requested";
  resultEntityId: string | null;
  errorMessage: string | null;
  /** Stable policy/error code synthesized from non-2xx operation responses. */
  errorCode: string | null;
  errorDocs: string | null;
  cascadeResults: unknown[] | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}

export interface ApplyUpdateResult {
  ok: boolean;
  pluginId?: string;
  version?: string;
  status?: "ready" | "upgrade_pending";
  delta?: string[];
}

export interface InstallPlanStep {
  catalogItemId: string;
  itemType: "plugin" | "skill" | "agent" | "team";
  name: string;
  version: string;
  action: "install-new" | "skip-already-installed" | "fail-version-mismatch";
  reason?: string;
}

export interface InstallPlan {
  rootItem: { id: string; name: string; type: string; version: string };
  steps: InstallPlanStep[];
  conflicts: Array<{
    catalogItemId: string;
    kind: "name-collision" | "adapter-mismatch" | "model-unavailable";
    detail: string;
    resolution: "auto-suffix" | "fail-fast" | "warn-and-proceed";
  }>;
  agentInstall?: {
    suggestedRole: "cxo" | "lead" | "general";
    supportedRoles: Array<"cxo" | "lead" | "general">;
    suggestedAdapterType: string;
    supportedAdapterTypes: string[];
    availableAdapterTypes: string[];
    setupRequired: boolean;
    setupRequirements: Array<{
      kind: "secret" | "plugin_config";
      key: string;
      label?: string;
      required: boolean;
      reason: string;
      usedBy?: string;
    }>;
    warnings: string[];
  };
}

/** A protected agent that a team uninstall detached and kept instead of destroying. */
export interface RetainedProtectedAgent {
  id: string;
  name: string;
  /** Canonical protected-role slug, e.g. `steward`. */
  role: string;
  /** Founder-facing reason the agent was kept. */
  why: string;
}

/** Result of {@link marketplaceApi.uninstallTeam}. Mirrors the server route body. */
export interface TeamUninstallResult {
  success: boolean;
  deletedAgentIds: string[];
  retainedAgentIds: string[];
  retainedAgents: RetainedProtectedAgent[];
}

export const marketplaceApi = {
  async getCatalog(): Promise<MarketplaceCatalogFile> {
    return api.get<MarketplaceCatalogFile>("/marketplace/catalog");
  },

  async getStatus(): Promise<CatalogSyncStatus> {
    return api.get<CatalogSyncStatus>("/marketplace/catalog/status");
  },

  async getPackages(): Promise<MarketplacePackage[]> {
    const res = await api.get<{ packages: MarketplacePackage[] }>("/marketplace/packages");
    return res.packages;
  },

  async sync(): Promise<{ itemCount: number; status: CatalogSyncStatus }> {
    return api.post<{ itemCount: number; status: CatalogSyncStatus }>(
      "/marketplace/catalog/sync",
      {},
    );
  },

  async resolvePlan(
    companyId: string,
    catalogItemId: string,
  ): Promise<InstallPlan> {
    return api.get<InstallPlan>(
      `/companies/${companyId}/marketplace/resolve/${encodeURIComponent(catalogItemId)}`,
    );
  },

  async install(
    companyId: string,
    request: InstallRequest,
  ): Promise<{ operationId: string; status: string }> {
    return api.post<{ operationId: string; status: string }>(
      `/companies/${companyId}/marketplace/install`,
      request,
    );
  },

  async getOperation(
    companyId: string,
    operationId: string,
  ): Promise<InstallOperation> {
    return api.get<InstallOperation>(
      `/companies/${companyId}/marketplace/install/${operationId}`,
    );
  },

  async getSettings(companyId: string): Promise<MarketplaceSettings> {
    return api.get<MarketplaceSettings>(
      `/companies/${companyId}/marketplace/settings`,
    );
  },

  async patchSettings(
    companyId: string,
    patch: Partial<MarketplaceSettings>,
  ): Promise<MarketplaceSettings> {
    return api.patch<MarketplaceSettings>(
      `/companies/${companyId}/marketplace/settings`,
      patch,
    );
  },

  async getUpdates(companyId: string, type?: string): Promise<PendingUpdate[]> {
    const path = type
      ? `/companies/${companyId}/marketplace/updates?type=${type}`
      : `/companies/${companyId}/marketplace/updates`;
    return api.get<PendingUpdate[]>(path);
  },

  async dismissUpdate(companyId: string, updateId: string): Promise<void> {
    await api.post<{ ok: boolean }>(
      `/companies/${companyId}/marketplace/updates/${updateId}/dismiss`,
      {},
    );
  },

  async applyUpdate(companyId: string, updateId: string): Promise<ApplyUpdateResult> {
    return api.post<ApplyUpdateResult>(
      `/companies/${companyId}/marketplace/updates/${updateId}/apply`,
      {},
    );
  },

  async requestInstall(companyId: string, catalogItemId: string): Promise<void> {
    await api.post<{ queued: boolean }>(
      `/companies/${companyId}/marketplace/request-install`,
      { catalogItemId },
    );
  },

  /**
   * Uninstall a marketplace-installed team (e.g. the crew). Destroys the team's
   * member agents EXCEPT protected ones (Commander, Steward), which are detached
   * and kept — the result reports them explicitly so the caller can tell the
   * founder *which* agents survived and *why* (D23; task #33).
   */
  async uninstallTeam(companyId: string, teamId: string): Promise<TeamUninstallResult> {
    return api.delete<TeamUninstallResult>(
      `/companies/${companyId}/marketplace/teams/${teamId}`,
    );
  },
};

/** Filter catalog items by type. Pure function. */
export function filterByType(
  items: CatalogItem[],
  type: MarketplaceItemType,
): CatalogItem[] {
  return items.filter((i) => i.type === type);
}

/** The curated "standard crew" team slug(s) — the AoA crew packaged as a team. */
const AOA_CREW_TEAM_SLUGS = new Set(["default-crew", "standard-crew"]);

/**
 * True for AoA's own auto-seeded crew items — the 8 `aoa-*` crew agents
 * (`agent:aoa-curated/aoa-adjutant`, …) and the standard-crew team
 * (`team:aoa-curated/default-crew`). NOT the regular curated agents
 * (`senior-engineer`, `github-issue-triager`), which every founder should still
 * be able to pick. The onboarding agent picker hides these — the crew is seeded
 * automatically, so re-offering it in the picker is noise. Pure function.
 *
 * Note: ALL catalog agents share `source.adapter === "aoa-curated"`, so the
 * distinction is the slug, not the adapter.
 */
export function isAoaCrewItem(item: CatalogItem): boolean {
  if (item.source.adapter !== "aoa-curated") return false;
  const slug = item.id.split("/").pop() ?? "";
  if (item.type === "team") return AOA_CREW_TEAM_SLUGS.has(slug);
  return slug.startsWith("aoa-");
}

/** Filter catalog items by category. Pure function. */
export function filterByCategory(
  items: CatalogItem[],
  category: string,
): CatalogItem[] {
  return items.filter((i) => i.category === category);
}

/**
 * Substring search across name, description, tags. Case-insensitive.
 * Empty/whitespace query returns input unchanged.
 */
export function searchItems(items: CatalogItem[], query: string): CatalogItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => {
    if (item.name.toLowerCase().includes(q)) return true;
    if (item.description.toLowerCase().includes(q)) return true;
    if (item.tags.some((t) => t.toLowerCase().includes(q))) return true;
    return false;
  });
}

export type CatalogSortOption = "recent" | "name" | "trust";

/**
 * Sort catalog items. Returns new array.
 *   recent: addedAt desc (newest first)
 *   name: alphabetical asc
 *   trust: verified > community > unverified, then alphabetical
 */
export function sortItems(
  items: CatalogItem[],
  sort: CatalogSortOption,
): CatalogItem[] {
  const TIER_RANK = { verified: 0, community: 1, unverified: 2 } as const;
  const sorted = [...items];
  if (sort === "recent") {
    return sorted.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  }
  if (sort === "name") {
    return sorted.sort((a, b) => a.name.localeCompare(b.name));
  }
  return sorted.sort((a, b) => {
    const r = TIER_RANK[a.trust.tier] - TIER_RANK[b.trust.tier];
    if (r !== 0) return r;
    return a.name.localeCompare(b.name);
  });
}

/** Group items by type. Used in search results. */
export function groupByType(
  items: CatalogItem[],
): Record<MarketplaceItemType, CatalogItem[]> {
  return items.reduce(
    (acc, item) => {
      acc[item.type].push(item);
      return acc;
    },
    { skill: [], agent: [], plugin: [], team: [] } as Record<
      MarketplaceItemType,
      CatalogItem[]
    >,
  );
}

/** Top N featured items (filter by featured===true, sort recent). */
export function featuredItems(items: CatalogItem[], n = 6): CatalogItem[] {
  return sortItems(
    items.filter((i) => i.featured),
    "recent",
  ).slice(0, n);
}

/** Top N recently added items. */
export function recentlyAddedItems(items: CatalogItem[], n = 6): CatalogItem[] {
  return sortItems(items, "recent").slice(0, n);
}
