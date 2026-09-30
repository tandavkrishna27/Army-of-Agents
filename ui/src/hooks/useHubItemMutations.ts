import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  hubItemsApi,
  type HubBulkActionPayload,
  type HubLifecycleActionPayload,
  type HubPersonalState,
  type HubUndoPayload,
} from "@/api/hub-items";
import { queryKeys } from "@/lib/queryKeys";

type PersonalUndoState = Extract<
  HubPersonalState,
  { kind: "unread" | "unsnooze" | "undismiss" }
>;

function isConflict(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 409
  );
}

export function useHubItemMutations(companyId: string | null | undefined) {
  const queryClient = useQueryClient();

  const invalidateHub = async () => {
    if (!companyId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["hub-items", companyId] }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.hubItems.counts(companyId),
      }),
    ]);
  };

  const invalidateOnConflict = async (error: unknown) => {
    if (isConflict(error)) await invalidateHub();
  };

  const markRead = useMutation({
    mutationFn: (itemId: string) => hubItemsApi.markRead(companyId!, itemId),
    onSuccess: invalidateHub,
    onError: invalidateOnConflict,
  });

  const markUnread = useMutation({
    mutationFn: (itemId: string) => hubItemsApi.markUnread(companyId!, itemId),
    onSuccess: invalidateHub,
    onError: invalidateOnConflict,
  });

  const snooze = useMutation({
    mutationFn: ({ itemId, until }: { itemId: string; until: string }) =>
      hubItemsApi.snooze(companyId!, itemId, until),
    onSuccess: invalidateHub,
    onError: invalidateOnConflict,
  });

  const unsnooze = useMutation({
    mutationFn: (itemId: string) => hubItemsApi.unsnooze(companyId!, itemId),
    onSuccess: invalidateHub,
    onError: invalidateOnConflict,
  });

  const dismiss = useMutation({
    mutationFn: (itemId: string) => hubItemsApi.dismiss(companyId!, itemId),
    onSuccess: invalidateHub,
    onError: invalidateOnConflict,
  });

  const undismiss = useMutation({
    mutationFn: (itemId: string) => hubItemsApi.undismiss(companyId!, itemId),
    onSuccess: invalidateHub,
    onError: invalidateOnConflict,
  });

  const act = useMutation({
    mutationFn: ({
      itemId,
      payload,
    }: {
      itemId: string;
      payload: HubLifecycleActionPayload;
    }) => hubItemsApi.act(companyId!, itemId, payload),
    onSuccess: invalidateHub,
    onError: invalidateOnConflict,
  });

  const undo = useMutation({
    mutationFn: ({ itemId, payload }: { itemId: string; payload: HubUndoPayload }) =>
      hubItemsApi.undo(companyId!, itemId, payload),
    onSuccess: invalidateHub,
    onError: invalidateOnConflict,
  });

  const bulkAction = useMutation({
    mutationFn: (payload: HubBulkActionPayload) =>
      hubItemsApi.bulkAction(companyId!, payload),
    onSuccess: invalidateHub,
    onError: invalidateOnConflict,
  });

  const undoPersonalState = async ({
    itemId,
    restore,
  }: {
    itemId: string;
    restore: PersonalUndoState;
  }) => {
    if (restore.kind === "unread") {
      await hubItemsApi.markUnread(companyId!, itemId);
    } else if (restore.kind === "unsnooze") {
      await hubItemsApi.unsnooze(companyId!, itemId);
    } else {
      await hubItemsApi.undismiss(companyId!, itemId);
    }
    await invalidateHub();
  };

  return {
    markRead,
    markUnread,
    snooze,
    unsnooze,
    dismiss,
    undismiss,
    act,
    undo,
    bulkAction,
    undoPersonalState,
  };
}
