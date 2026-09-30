import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  MemoryFolderRecord,
  MemoryFolderCreateInput,
  MemoryFolderUpdateInput,
} from "@armyofagents/shared";
import { memoryFoldersApi } from "../api/memoryFolders";
import { memoryApi } from "../api/memory";
import { queryKeys } from "./queryKeys";

/**
 * React Query mutations for user-folder CRUD. Each invalidates the folder
 * list query so the tree re-renders. Memory items list is also invalidated
 * for delete (because reparenting may change folderPath of items).
 */

export function useCreateFolderMutation(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MemoryFolderCreateInput) =>
      memoryFoldersApi.create(companyId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.memory.folders.list(companyId) });
    },
  });
}

export function useUpdateFolderMutation(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: MemoryFolderUpdateInput }) =>
      memoryFoldersApi.update(companyId, id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.memory.folders.list(companyId) });
    },
  });
}

export function useDeleteFolderMutation(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => memoryFoldersApi.remove(companyId, id),
    onSuccess: () => {
      // Folder list changed (deleted + reparented sub-folders).
      qc.invalidateQueries({ queryKey: queryKeys.memory.folders.list(companyId) });
      // Items' folderPath changed for reparented items — invalidate the company-wide
      // memory list (consumed by tree counts, file list, home dashboard).
      qc.invalidateQueries({ queryKey: queryKeys.memory.list(companyId) });
    },
  });
}

export function useChangeLayerMutation(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: Parameters<typeof memoryApi.changeLayer>[2];
    }) => memoryApi.changeLayer(companyId, id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.memory.list(companyId) });
    },
  });
}

