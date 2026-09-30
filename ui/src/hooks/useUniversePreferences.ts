import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PreferenceSection, UniversePreferenceOverrides, UniversePreferencesSnapshot } from "@armyofagents/shared";
import { ApiError } from "../api/client";
import { universePreferencesApi } from "../api/universe-preferences";
import { queryKeys } from "../lib/queryKeys";

export type UniversePreferenceStatus = "loading" | "ready" | "saving" | "unsaved" | "conflict" | "denied";

export function useUniversePreferences(companyId: string | null | undefined) {
  const client = useQueryClient();
  const key = useMemo(() => companyId ? queryKeys.universePreferences(companyId) : ["universe-preferences", "__none__"] as const, [companyId]);
  const [draft, setDraft] = useState<UniversePreferenceOverrides>({});
  const [conflict, setConflict] = useState<UniversePreferencesSnapshot | null>(null);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => universePreferencesApi.get(companyId!, signal),
    enabled: !!companyId,
  });
  const accept = (next: UniversePreferencesSnapshot) => {
    client.setQueryData(key, next);
    setDraft({});
    setConflict(null);
    return next;
  };
  const patchMutation = useMutation({
    mutationFn: (patch: UniversePreferenceOverrides) => universePreferencesApi.patch(companyId!, {
      schemaVersion: 1,
      baseRevision: query.data?.revision ?? 0,
      patch,
    }),
    onSuccess: accept,
    onError: error => {
      if (error instanceof ApiError && error.status === 409) {
        const latest = (error.body as { latest?: UniversePreferencesSnapshot } | null)?.latest;
        if (latest) setConflict(latest);
      }
    },
  });
  const resetMutation = useMutation({
    mutationFn: (section: PreferenceSection) => universePreferencesApi.reset(companyId!, {
      baseRevision: query.data?.revision ?? 0,
      section,
    }),
    onSuccess: accept,
  });
  const status: UniversePreferenceStatus = query.isLoading ? "loading" :
    query.error instanceof ApiError && query.error.status === 403 ? "denied" :
    conflict ? "conflict" : patchMutation.isPending || resetMutation.isPending ? "saving" :
    Object.keys(draft).length ? "unsaved" : "ready";
  return {
    snapshot: query.data ?? null,
    draft,
    status,
    error: query.error ?? patchMutation.error ?? resetMutation.error,
    conflict,
    edit: (patch: UniversePreferenceOverrides) => setDraft(current => ({ ...current, ...patch })),
    discard: () => { setDraft({}); setConflict(null); },
    patch: () => patchMutation.mutateAsync(draft),
    reset: (section: PreferenceSection) => resetMutation.mutateAsync(section),
    acceptLatest: () => conflict && accept(conflict),
  };
}
