import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { MarketplaceCatalogFile } from "@armyofagents/shared";
import { marketplaceApi } from "@/api/marketplace";

const CATALOG_QUERY_KEY = ["marketplace", "catalog"] as const;
const STALE_TIME_MS = 5 * 60 * 1000;
const GC_TIME_MS = 30 * 60 * 1000;

/**
 * Fetch the marketplace catalog and cache across all marketplace pages.
 *
 * Single shared query key — repeated calls return same promise / cached result.
 * 5min staleTime is safe (CDN republishes nightly + on push).
 *
 * Source of truth is `GET /api/marketplace/catalog`. The server side
 * (`MarketplaceCatalogService` in `server/src/app.ts`) seeds itself from the
 * bundled snapshot (`ui/src/aoa-marketplace-snapshot.json`, gitignored,
 * generated at build time by `pnpm fetch-catalog`). Errors from the server
 * surface directly to the UI so a proper error state can render — we don't
 * silently swap in stale client-side data.
 */
export function useCatalog(): UseQueryResult<MarketplaceCatalogFile, Error> {
  return useQuery({
    queryKey: CATALOG_QUERY_KEY,
    queryFn: () => marketplaceApi.getCatalog(),
    staleTime: STALE_TIME_MS,
    gcTime: GC_TIME_MS,
  });
}

export const catalogQueryKey = CATALOG_QUERY_KEY;
