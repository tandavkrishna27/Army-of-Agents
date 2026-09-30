import { useQuery } from "@tanstack/react-query";
import { Folder } from "lucide-react";
import type { MemoryItem } from "@armyofagents/shared";
import { memoryApi } from "../../api/memory";
import { memoryAssetsApi } from "../../api/memoryAssets";
import { queryKeys } from "../../lib/queryKeys";

interface MemoryFolderSummaryProps {
  companyId: string;
  folderPath: string;
  departmentId: string | null;
}

export function MemoryFolderSummary({
  companyId,
  folderPath,
  departmentId,
}: MemoryFolderSummaryProps) {
  const _itemsQuery = useQuery({
    queryKey: [...queryKeys.memory.list(companyId), { folderPath, departmentId }],
    queryFn: () =>
      memoryApi.list(companyId, departmentId ? { departmentId } : {}),
    enabled: Boolean(folderPath),
  });
  const itemsQuery = { ..._itemsQuery, data: _itemsQuery.data?.items };

  const assetsQuery = useQuery({
    queryKey: queryKeys.memory.assets.list(companyId, {
      departmentId: departmentId ?? undefined,
      folderPath,
    }),
    queryFn: () =>
      memoryAssetsApi.list(companyId, {
        departmentId: departmentId ?? undefined,
        folderPath,
      }),
    enabled: Boolean(folderPath),
  });

  const itemsInFolder = (itemsQuery.data ?? []).filter(
    (it) => (it as MemoryItem & { folderPath?: string }).folderPath === folderPath,
  );
  const assetsInFolder = assetsQuery.data ?? [];

  return (
    <div className="h-full p-8">
      <div className="flex items-center gap-3 mb-6">
        <Folder className="h-6 w-6 text-muted-foreground" />
        <div>
          <div className="text-xl font-semibold">{folderPath}</div>
          <div className="text-xs text-muted-foreground mt-1">
            {itemsInFolder.length} memory items · {assetsInFolder.length} files
          </div>
        </div>
      </div>
      <div className="text-xs text-muted-foreground">
        Pick an item from the list to view it. Folder summary with recent
        activity and stats arrives in a later slice.
      </div>
    </div>
  );
}
