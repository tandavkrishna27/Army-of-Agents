import { useQuery } from "@tanstack/react-query";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";

/**
 * Shared hook for live agent count.
 * Reuses the same React Query cache key as Sidebar, so both
 * components share the same cached data and 10s polling interval.
 */
export function useLiveAgentCount() {
  const { selectedCompanyId } = useCompany();

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  return liveRuns?.length ?? 0;
}
