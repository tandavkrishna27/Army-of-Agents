import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  viewerPreferencesApi,
  type ViewerControlLevel,
  type ViewerControlSource,
  type ViewerPreference,
} from "../api/viewer-preferences";
import { queryKeys } from "../lib/queryKeys";

export interface UseViewerControlResult {
  /**
   * The resolved level in effect (user override, else company default).
   * `undefined` while the query is unresolved (loading OR error — react-query
   * leaves `query.data` undefined in both cases). Consumers MUST fail closed
   * (treat undefined as "manual") — do NOT coalesce to a company default here,
   * or auto-open would fail OPEN during loading/error.
   */
  effectiveLevel: ViewerControlLevel | undefined;
  /** The raw per-user override (null = inheriting the company default). */
  userLevel: ViewerControlLevel | null;
  /** Whether the effective level came from the user override or the company. */
  source: ViewerControlSource;
  /** Persist (or clear, with null) the per-user override. */
  setUserLevel: (level: ViewerControlLevel | null) => void;
  isLoading: boolean;
  isSyncing: boolean;
}

export function useViewerControl(
  companyId: string | null | undefined,
): UseViewerControlResult {
  const queryClient = useQueryClient();
  const queryKey = companyId
    ? queryKeys.viewerPreferences(companyId)
    : (["viewer-preferences", "__none__"] as const);

  const query = useQuery({
    queryKey,
    queryFn: () => viewerPreferencesApi.get(companyId!),
    enabled: !!companyId,
    staleTime: 60_000,
  });

  const mutation = useMutation({
    mutationFn: (level: ViewerControlLevel | null) =>
      viewerPreferencesApi.patch(companyId!, level),
    onSuccess: (updated) => {
      queryClient.setQueryData<ViewerPreference>(queryKey, updated);
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const prefs = query.data;

  return {
    effectiveLevel: prefs?.effectiveLevel,
    userLevel: prefs?.viewerControlLevel ?? null,
    source: prefs?.source ?? "company",
    setUserLevel: (level) => {
      if (!companyId) return;
      mutation.mutate(level);
    },
    isLoading: query.isLoading,
    isSyncing: mutation.isPending,
  };
}
