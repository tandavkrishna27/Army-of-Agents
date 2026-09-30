import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  sidebarPreferencesApi,
  type SidebarPreferences,
  type SidebarPreferencesPatch,
} from "../api/sidebar-preferences";
import { queryKeys } from "../lib/queryKeys";

export type SidebarOrderType = "department" | "project";

const DEBOUNCE_MS = 400;
const EMPTY_PREFS: SidebarPreferences = {
  departmentOrder: [],
  projectOrder: [],
  updatedAt: null,
};

function fieldFor(type: SidebarOrderType): keyof Pick<SidebarPreferences, "departmentOrder" | "projectOrder"> {
  return type === "department" ? "departmentOrder" : "projectOrder";
}

export interface UseSidebarOrderOptions {
  debounceMs?: number;
}

export function useSidebarOrder(
  companyId: string | null | undefined,
  { debounceMs = DEBOUNCE_MS }: UseSidebarOrderOptions = {},
) {
  const queryClient = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPatchRef = useRef<SidebarPreferencesPatch>({});

  const queryKey = useMemo(
    () =>
      companyId
        ? queryKeys.sidebarPreferences(companyId)
        : (["sidebar-preferences", "__none__"] as const),
    [companyId],
  );

  const query = useQuery({
    queryKey,
    queryFn: () => sidebarPreferencesApi.get(companyId!),
    enabled: !!companyId,
    staleTime: 60_000,
  });

  const prefs: SidebarPreferences = query.data ?? EMPTY_PREFS;

  const persistMutation = useMutation({
    mutationFn: (patch: SidebarPreferencesPatch) => sidebarPreferencesApi.patch(companyId!, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKey, updated);
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => sidebarPreferencesApi.reset(companyId!),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKey, updated);
    },
  });

  // Clear the debounce timer when the hook unmounts so we don't persist
  // against a stale companyId.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, []);

  const flushPending = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const patch = pendingPatchRef.current;
    pendingPatchRef.current = {};
    if (!companyId) return;
    if (patch.departmentOrder === undefined && patch.projectOrder === undefined) return;
    persistMutation.mutate(patch);
  }, [companyId, persistMutation]);

  const setOrder = useCallback(
    (type: SidebarOrderType, orderedIds: string[]) => {
      if (!companyId) return;

      // Optimistic local update — the UI reflects the new order immediately.
      queryClient.setQueryData<SidebarPreferences>(queryKey, (prev) => ({
        departmentOrder: prev?.departmentOrder ?? [],
        projectOrder: prev?.projectOrder ?? [],
        updatedAt: prev?.updatedAt ?? null,
        [fieldFor(type)]: orderedIds,
      }));

      pendingPatchRef.current = {
        ...pendingPatchRef.current,
        [fieldFor(type)]: orderedIds,
      };

      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const patch = pendingPatchRef.current;
        pendingPatchRef.current = {};
        persistMutation.mutate(patch);
      }, debounceMs);
    },
    [companyId, queryClient, queryKey, persistMutation, debounceMs],
  );

  const resetToDefault = useCallback(() => {
    if (!companyId) return;
    // Cancel any pending debounced persist — reset supersedes it.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingPatchRef.current = {};
    // Optimistic clear.
    queryClient.setQueryData<SidebarPreferences>(queryKey, {
      departmentOrder: [],
      projectOrder: [],
      updatedAt: null,
    });
    resetMutation.mutate();
  }, [companyId, queryClient, queryKey, resetMutation]);

  return {
    departmentOrder: prefs.departmentOrder,
    projectOrder: prefs.projectOrder,
    orderFor: (type: SidebarOrderType) => prefs[fieldFor(type)],
    setOrder,
    flushPending,
    resetToDefault,
    isSyncing: persistMutation.isPending || resetMutation.isPending,
    isLoading: query.isLoading,
  };
}
