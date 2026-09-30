import type { Db } from "@armyofagents/db";
import type { MarketplaceCatalogService } from "./aoa-marketplace.js";
import {
  runMarketplaceCrewMaintenance,
  type MarketplaceMaintenanceResult,
  type RunMarketplaceMaintenanceOptions,
} from "./marketplace-reconcile.js";

export interface StartupMarketplaceMaintenanceOptions {
  db: Db;
  catalogService: MarketplaceCatalogService;
  runMaintenance?: (
    options: RunMarketplaceMaintenanceOptions,
  ) => Promise<MarketplaceMaintenanceResult>;
}

/**
 * Run the boot maintenance pass against the exact catalog resolved by the
 * service's first refresh. This joins the existing request and runs only when
 * that attempt produced fresh CDN or bundled-fallback data. A failed refresh
 * may carry the preserved pre-refresh cache for ordinary availability, but boot
 * maintenance must never mutate the fleet from that stale copy.
 */
export async function runStartupMarketplaceMaintenance(
  options: StartupMarketplaceMaintenanceOptions,
): Promise<MarketplaceMaintenanceResult | null> {
  const initial = await options.catalogService.waitForInitialRefresh();
  if (!initial.catalog || initial.outcome === "failure") return null;

  return (options.runMaintenance ?? runMarketplaceCrewMaintenance)({
    db: options.db,
    catalogItems: initial.catalog.items,
    mode: "scheduled",
  });
}
