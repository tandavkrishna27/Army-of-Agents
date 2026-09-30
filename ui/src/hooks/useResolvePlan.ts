import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { marketplaceApi, type InstallPlan } from "@/api/marketplace";

export interface UseResolvePlanOpts {
  companyId: string | null;
  catalogItemId: string | null;
}

/**
 * Fetch the install plan (cascade tree preview) for a catalog item in a company.
 *
 * Disabled when companyId or catalogItemId is null.
 * Cached per (companyId, catalogItemId) pair, 1min staleTime.
 */
export function useResolvePlan(
  opts: UseResolvePlanOpts,
): UseQueryResult<InstallPlan, Error> {
  const { companyId, catalogItemId } = opts;
  return useQuery({
    queryKey: ["marketplace", "resolve", companyId, catalogItemId] as const,
    queryFn: () => marketplaceApi.resolvePlan(companyId!, catalogItemId!),
    enabled: !!companyId && !!catalogItemId,
    staleTime: 60 * 1000,
  });
}
