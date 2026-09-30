import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HomeBoardLayoutItem } from "@armyofagents/shared";
import { HOME_BOARD_LAYOUT_SCHEMA_VERSION } from "@armyofagents/shared";
import { homeBoardLayoutApi, type HomeBoardLayoutResponse } from "../api/home-board-layout";
import { queryKeys } from "../lib/queryKeys";

/**
 * Query + save/reset primitive for the Home widget-board's persisted layout.
 * Mirrors the SessionsSidebar mutation shape (onMutate cancel+snapshot+set,
 * onError rollback, onSettled invalidate). This is the low-level persistence
 * hook — the draft/dirty/save-on-exit editing discipline lives in
 * useBoardEdit (Phase C), built on top of this.
 */
export function useHomeBoardLayout(companyId: string | null | undefined) {
  const qc = useQueryClient();

  const queryKey = useMemo(
    () => (companyId ? queryKeys.homeBoardLayout(companyId) : (["home-board-layout", "__none__"] as const)),
    [companyId],
  );

  const query = useQuery({
    queryKey,
    queryFn: () => homeBoardLayoutApi.get(companyId!),
    enabled: !!companyId,
  });

  const saveMutation = useMutation({
    mutationFn: (layout: HomeBoardLayoutItem[]) => homeBoardLayoutApi.save(companyId!, layout),
    onMutate: async (layout) => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<HomeBoardLayoutResponse | null>(queryKey);
      qc.setQueryData<HomeBoardLayoutResponse | null>(queryKey, {
        layout,
        schemaVersion: previous?.schemaVersion ?? HOME_BOARD_LAYOUT_SCHEMA_VERSION,
      });
      return { previous };
    },
    onError: (_err, _layout, ctx) => {
      if (ctx && "previous" in ctx) {
        qc.setQueryData(queryKey, ctx.previous);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey });
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => homeBoardLayoutApi.reset(companyId!),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<HomeBoardLayoutResponse | null>(queryKey);
      qc.setQueryData<HomeBoardLayoutResponse | null>(queryKey, null);
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx && "previous" in ctx) {
        qc.setQueryData(queryKey, ctx.previous);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey });
    },
  });

  return {
    /** The saved lg layout, or null when the user has no saved board (role default applies). */
    layout: query.data?.layout ?? null,
    schemaVersion: query.data?.schemaVersion ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    refetch: query.refetch,

    save: saveMutation.mutate,
    saveAsync: saveMutation.mutateAsync,
    isSaving: saveMutation.isPending,
    saveError: saveMutation.error,

    reset: resetMutation.mutate,
    resetAsync: resetMutation.mutateAsync,
    isResetting: resetMutation.isPending,
    resetError: resetMutation.error,
  };
}
