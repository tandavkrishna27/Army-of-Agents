import { useQuery } from "@tanstack/react-query";
import { homeApi } from "@/api/dashboard";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Shared Home-summary query. Both the Dashboard page and Layout's WS9 first-run
 * full-bleed check read the SAME `queryKeys.home(companyId)` cache entry; owning
 * the key + fetcher in one hook stops the two call sites from drifting — a
 * mismatched queryFn (or an out-of-sync key) would fork the cache into two
 * entries and double-fetch. TanStack dedupes the concurrent observers, so the
 * second caller adds no network round-trip.
 *
 * `opts.enabled` ANDs with the companyId guard, letting a caller narrow further
 * (Layout only wants the summary on the Home route; Dashboard always wants it).
 */
export function useHomeSummary(companyId: string | null, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.home(companyId ?? ""),
    queryFn: () => homeApi.summary(companyId as string),
    enabled: Boolean(companyId) && (opts?.enabled ?? true),
  });
}
