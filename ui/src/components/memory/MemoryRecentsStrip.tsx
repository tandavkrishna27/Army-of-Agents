import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { memoryApi } from "../../api/memory";
import { memoryAssetsApi } from "../../api/memoryAssets";
import { queryKeys } from "../../lib/queryKeys";
import { useCompany } from "../../context/CompanyContext";
import type { MemoryItem, MemoryAssetRecord } from "@armyofagents/shared";
import { MemoryItemRow, type MemoryItemRowData } from "./MemoryItemRow";

interface MemoryRecentsStripProps {
  companyId: string;
  onOpenTab?: (tab: { id: string; kind: "memory_item" | "asset"; title: string }) => void;
}

/** Returns a fallback ISO string if `value` can't be parsed to a finite timestamp. */
function toSafeIso(value: string | Date | null | undefined): string {
  if (value == null) return new Date(0).toISOString();
  const t = typeof value === "string" ? new Date(value).getTime() : (value as Date).getTime();
  return Number.isFinite(t)
    ? (typeof value === "string" ? value : (value as Date).toISOString())
    : new Date(0).toISOString();
}

interface RecentSource {
  kind: "memory_item" | "asset";
  id: string;
  rowData: MemoryItemRowData;
  folderPath?: string;
  departmentId?: string | null;
}

export function MemoryRecentsStrip({ companyId, onOpenTab }: MemoryRecentsStripProps) {
  const navigate = useNavigate();
  const { selectedCompany } = useCompany();
  const companyPrefix = (selectedCompany as { issuePrefix?: string } | null)?.issuePrefix ?? "";

  const _itemsQuery = useQuery({
    queryKey: queryKeys.memory.list(companyId),
    queryFn: () => memoryApi.list(companyId, {}),
  });
  const itemsQuery = { ..._itemsQuery, data: _itemsQuery.data?.items };
  const assetsQuery = useQuery({
    queryKey: queryKeys.memory.assets.list(companyId),
    queryFn: () => memoryAssetsApi.list(companyId),
  });

  const rows: RecentSource[] = useMemo(() => {
    const items = ((itemsQuery.data ?? []) as Array<MemoryItem & { folderPath?: string; departmentId?: string | null; content?: string }>)
      .map<RecentSource>((it) => ({
        kind: "memory_item",
        id: it.id,
        rowData: {
          kind: "memory_item",
          id: it.id,
          title: it.title,
          category: (it as MemoryItem & { category?: string | null }).category ?? null,
          status: (it as MemoryItem & { status?: string | null }).status ?? null,
          modifiedAt: toSafeIso(it.updatedAt as string | Date | null | undefined),
          content: it.content ?? null,
        },
        folderPath: it.folderPath,
        departmentId: it.departmentId,
      }));

    const assets = ((assetsQuery.data ?? []) as MemoryAssetRecord[]).map<RecentSource>((a) => ({
      kind: "asset",
      id: a.id,
      rowData: {
        kind: "asset",
        id: a.id,
        title: a.fileName,
        mimeType: a.mimeType,
        modifiedAt: toSafeIso(a.updatedAt),
      },
      folderPath: a.folderPath,
      departmentId: a.departmentId,
    }));

    return [...items, ...assets]
      .sort(
        (a, b) =>
          new Date(b.rowData.modifiedAt).getTime() -
          new Date(a.rowData.modifiedAt).getTime(),
      )
      .slice(0, 10);
  }, [itemsQuery.data, assetsQuery.data]);

  function openRow(source: RecentSource) {
    if (onOpenTab) {
      onOpenTab({
        id: source.id,
        kind: source.kind,
        title: source.rowData.title,
      });
      return;
    }

    const params = new URLSearchParams();
    if (source.folderPath) params.set("folder", source.folderPath);
    if (source.departmentId) params.set("dept", source.departmentId);
    params.set("item", source.id);
    params.set("type", source.kind);
    navigate(`/${companyPrefix}/memory/explore?${params.toString()}`);
  }

  if (itemsQuery.isLoading || assetsQuery.isLoading) {
    return <div className="text-xs text-muted-foreground">Loading recents…</div>;
  }
  if (rows.length === 0) {
    return <div className="text-xs text-muted-foreground">No recent activity yet.</div>;
  }

  return (
    <div className="overflow-hidden rounded-md border border-border">
      {rows.map((source, i) => (
        <div
          key={`${source.kind}-${source.id}`}
          className={i > 0 ? "border-t border-border-soft" : undefined}
        >
          <MemoryItemRow
            row={source.rowData}
            active={false}
            onSelect={() => openRow(source)}
          />
        </div>
      ))}
    </div>
  );
}
