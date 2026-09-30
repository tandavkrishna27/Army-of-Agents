import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { MarketplacePackage } from "@armyofagents/shared";
import { marketplaceApi } from "@/api/marketplace";

const PACKAGES_QUERY_KEY = ["marketplace", "packages"] as const;
const STALE_TIME_MS = 5 * 60 * 1000;
const GC_TIME_MS = 30 * 60 * 1000;

/**
 * Fetch the marketplace package list. Packages are derived server-side from
 * the cached catalog (group by github owner/repo, threshold ≥ 2, with
 * explicit `packageId` override). See server/src/services/derivePackages.ts.
 *
 * Returns 503 from the server (surfaces here as a query error) if no catalog
 * has been cached yet.
 */
export function usePackages(): UseQueryResult<MarketplacePackage[], Error> {
  return useQuery({
    queryKey: PACKAGES_QUERY_KEY,
    queryFn: () => marketplaceApi.getPackages(),
    staleTime: STALE_TIME_MS,
    gcTime: GC_TIME_MS,
  });
}

export const packagesQueryKey = PACKAGES_QUERY_KEY;
