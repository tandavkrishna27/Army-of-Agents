import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import type {
  MemoryItem,
  MemoryAssetRecord,
  MemoryFolderRecord,
  MemoryIndexStatus,
} from "@armyofagents/shared";
import { Plus, Search, X } from "lucide-react";
import { memoryApi } from "../../api/memory";
import { memoryAssetsApi } from "../../api/memoryAssets";
import { memoryFoldersApi } from "../../api/memoryFolders";
import { projectsApi } from "../../api/projects";
import { queryKeys } from "../../lib/queryKeys";
import { useCompany } from "../../context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useMemoryViewMode } from "../../hooks/useMemoryViewMode";
import { MemoryViewToggle } from "./MemoryViewToggle";
import { MemoryItemRow, type MemoryItemRowData } from "./MemoryItemRow";
import { MemoryItemTable, type MemoryItemTableRowData, type MemoryTableSortColumn } from "./MemoryItemTable";
import { MemoryItemCardGrid } from "./MemoryItemCardGrid";
import { MemoryUploadButton } from "./MemoryUploadButton";
import type { MemoryItemCardData } from "./MemoryItemCard";

interface UploadContext {
  departmentId: string | null;
  folderPath: string;
}

interface MemoryFileListProps {
  companyId: string;
  folderPath: string;
  departmentId: string | null;
  layer?: string | null;
  selectedItemId: string | null;
  selectedItemType: "memory_item" | "asset" | null;
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
  onNewItem?: () => void;
  uploadContext?: UploadContext;
  totalItems?: number;
  onSelectRow: (id: string, kind: "memory_item" | "asset", title: string) => void;
}

interface ListRow {
  kind: "memory_item" | "asset";
  id: string;
  name: string;
  category?: string | null;
  status?: string | null;
  indexStatus?: MemoryIndexStatus | null;
  mimeType?: string | null;
  modifiedAt: string;
  raw: MemoryItem | MemoryAssetRecord;
}


function scopeTitle(folderPath: string, layer?: string | null, deptOnly?: boolean, deptName?: string): string {
  if (folderPath === "__pinned") return "Pinned";
  if (folderPath === "__pending") return "Pending Review";
  if (folderPath === "__recent") return "Recent";
  if (folderPath === "__archived") return "Archived";
  if (!folderPath && layer) {
    const labels: Record<string, string> = {
      identity: "Identity",
      domain: "Domain",
      active_context: "Active Context",
      working: "Working",
    };
    return labels[layer] ?? layer;
  }
  if (deptOnly && deptName) return deptName;
  if (deptOnly) return "Department";
  return folderPath || "Memory";
}

function toRowData(row: ListRow): MemoryItemRowData & MemoryItemTableRowData & MemoryItemCardData {
  const raw = row.raw as {
    layer?: string | null;
    runUsageCount?: number | null;
    tokenCount?: number | null;
    sizeBytes?: number | null;
    pageCount?: number | null;
    chunkCount?: number | null;
    content?: string | null;
    extractedText?: string | null;
    folderPath?: string | null;
  };
  return {
    kind: row.kind,
    id: row.id,
    title: row.name,
    category: row.category ?? null,
    status: row.status ?? null,
    indexStatus: row.indexStatus ?? null,
    mimeType: row.mimeType ?? null,
    modifiedAt: row.modifiedAt,
    folderPath: raw.folderPath ?? null,
    layer: raw.layer ?? null,
    content: raw.content ?? null,
    extractedText: raw.extractedText ?? null,
    usedCount: raw.runUsageCount ?? undefined,
    tokenEstimate: raw.tokenCount ?? undefined,
    sizeBytes: raw.sizeBytes ?? undefined,
    pageCount: raw.pageCount ?? null,
    chunkCount: raw.chunkCount ?? null,
  };
}

export function MemoryFileList({
  companyId,
  folderPath,
  departmentId,
  layer,
  selectedItemId,
  selectedItemType,
  searchQuery,
  onSearchChange,
  onNewItem,
  uploadContext,
  totalItems,
  onSelectRow,
}: MemoryFileListProps) {
  const navigate = useNavigate();
  const { selectedCompany } = useCompany();
  const companyPrefix = selectedCompany?.issuePrefix ?? "";

  const { mode, setMode } = useMemoryViewMode();
  const queryClient = useQueryClient();

  // Re-index action for the primary Memory explorer rows (P2, Codex): the
  // pending/failed/not-indexed badges + retry were previously only wired on the
  // legacy /memory page. Thread the same reindex-single-item flow here.
  const reindexMutation = useMutation({
    mutationFn: (id: string) => memoryApi.reindexItem(companyId, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.memory.list(companyId) });
    },
  });
  const handleReindex = (id: string) => reindexMutation.mutate(id);

  const [sortBy, setSortBy] = useState<MemoryTableSortColumn>("modifiedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [searchOpen, setSearchOpen] = useState(Boolean(searchQuery?.trim()));
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  function handleSortChange(col: MemoryTableSortColumn) {
    if (col === sortBy) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(col);
      setSortDir("desc");
    }
  }

  const isVirtualFolder =
    folderPath === "__pinned" ||
    folderPath === "__pending" ||
    folderPath === "__recent" ||
    folderPath === "__archived";

  const isLayerOnly = !folderPath && !departmentId && Boolean(layer);

  const isDeptOnly =
    !folderPath && Boolean(departmentId) && !isVirtualFolder;

  // Hoist projects + deptSlug above the items/assets queries so we can pass
  // a strict folderPath filter into the assetsQuery for dept-only mode.
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: Boolean(companyId) && Boolean(departmentId),
  });

  const deptName = projects?.find((p) => p.id === departmentId)?.name;

  const deptSlug = useMemo(() => {
    if (!departmentId) return null;
    return projects?.find((p) => p.id === departmentId)?.urlKey ?? null;
  }, [projects, departmentId]);

  const _itemsQuery = useQuery({
    queryKey: [...queryKeys.memory.list(companyId), { folderPath, departmentId }],
    queryFn: () =>
      memoryApi.list(companyId, departmentId ? { departmentId } : {}),
    enabled: Boolean(folderPath) || isLayerOnly || isDeptOnly,
  });
  const itemsQuery = { ..._itemsQuery, data: _itemsQuery.data?.items };

  // Phase 6.2f follow-up: in dept-only mode, the items list filters strictly
  // by `folderPath === deptSlug`. Match the same filter for assets so the
  // central pane doesn't show assets from sub-paths alongside the strict-
  // filtered items section.
  const assetsFolderPath = isDeptOnly ? (deptSlug ?? "") : folderPath;
  const assetsQuery = useQuery({
    queryKey: queryKeys.memory.assets.list(companyId, {
      departmentId: departmentId ?? undefined,
      folderPath: assetsFolderPath,
    }),
    queryFn: () =>
      memoryAssetsApi.list(companyId, {
        departmentId: departmentId ?? undefined,
        folderPath: assetsFolderPath,
      }),
    enabled:
      (Boolean(folderPath) && !isVirtualFolder && !isLayerOnly) ||
      (isDeptOnly && Boolean(deptSlug)),
  });

  const { data: folders } = useQuery({
    queryKey: queryKeys.memory.folders.list(companyId),
    queryFn: () => memoryFoldersApi.list(companyId),
    enabled: Boolean(companyId),
  });

  const rows = useMemo<ListRow[]>(() => {
    const allItems = (itemsQuery.data ?? []) as Array<
      MemoryItem & {
        folderPath?: string;
        founderPinnedToTop?: boolean;
        layer?: string | null;
        status?: string;
        indexStatus?: MemoryIndexStatus | null;
      }
    >;

    const recentCutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const items = allItems
      .filter((it) => {
        if (folderPath === "__pinned") return it.founderPinnedToTop === true;
        if (folderPath === "__pending") return it.status === "pending";
        if (folderPath === "__recent") {
          if (it.status === "archived") return false;
          const t = new Date(it.updatedAt).getTime();
          return Number.isFinite(t) && t >= recentCutoff;
        }
        if (folderPath === "__archived") return it.status === "archived";
        if (isLayerOnly) return it.layer === layer && it.status !== "archived";
        // Phase 6.2f: strict path. Dept-only mode shows items where folderPath === dept slug.
        if (isDeptOnly) {
          if (!deptSlug) return false;
          return it.folderPath === deptSlug && it.status !== "archived";
        }
        return it.folderPath === folderPath && it.status !== "archived";
      })
      .map<ListRow>((it) => ({
        kind: "memory_item",
        id: it.id,
        name: it.title,
        category: it.category,
        status: it.status,
        indexStatus: it.indexStatus ?? null,
        modifiedAt:
          typeof it.updatedAt === "string"
            ? it.updatedAt
            : new Date(it.updatedAt).toISOString(),
        raw: it,
      }));

    // Virtual folders and layer-only views show items only — assets don't have pin/approval state.
    const assets = isVirtualFolder || isLayerOnly
      ? []
      : (assetsQuery.data ?? []).map<ListRow>((a: MemoryAssetRecord) => ({
          kind: "asset",
          id: a.id,
          name: a.fileName,
          mimeType: a.mimeType,
          status: undefined,
          modifiedAt: a.updatedAt,
          raw: a,
        }));

    return [...items, ...assets].sort(
      (a, b) =>
        new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime(),
    );
  }, [itemsQuery.data, assetsQuery.data, folderPath, isVirtualFolder, isLayerOnly, isDeptOnly, layer, deptSlug]);

  const filteredRows = useMemo(() => {
    if (!searchQuery?.trim()) return rows;
    const q = searchQuery.toLowerCase();
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.category ?? "").toLowerCase().includes(q) ||
        (r.mimeType ?? "").toLowerCase().includes(q),
    );
  }, [rows, searchQuery]);

  // Apply table-mode sort to a derived copy; list + cards keep the natural
  // modifiedAt-desc order that comes out of the rows memo.
  const displayRows = useMemo(() => {
    if (mode !== "table") return filteredRows;
    const copy = [...filteredRows];
    copy.sort((a, b) => {
      if (sortBy === "title") return a.name.localeCompare(b.name);
      if (sortBy === "usedCount") {
        const av = (a.raw as { runUsageCount?: number }).runUsageCount ?? 0;
        const bv = (b.raw as { runUsageCount?: number }).runUsageCount ?? 0;
        return av - bv;
      }
      return new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime();
    });
    if (sortDir === "desc") copy.reverse();
    return copy;
  }, [filteredRows, mode, sortBy, sortDir]);

  // Phase 6.2f: compute direct subfolders for folder/dept modes.
  const subfolders = useMemo<MemoryFolderRecord[]>(() => {
    if (isVirtualFolder || isLayerOnly) return [];
    // Dept-only mode: subfolders of "<deptSlug>/...".
    const parentPath = isDeptOnly ? deptSlug : folderPath;
    if (!parentPath) return [];
    return (folders ?? [])
      .filter((f) => {
        if (!f.path.startsWith(parentPath + "/")) return false;
        const remainder = f.path.slice(parentPath.length + 1);
        return remainder.length > 0 && !remainder.includes("/");
      })
      .sort((a, b) => {
        const aSeed = a.seedKey !== null;
        const bSeed = b.seedKey !== null;
        if (aSeed !== bSeed) return aSeed ? -1 : 1;
        if (aSeed) return a.sortOrder - b.sortOrder;
        return a.displayName.localeCompare(b.displayName);
      });
  }, [folders, folderPath, isVirtualFolder, isLayerOnly, isDeptOnly, deptSlug]);

  // Per-folder item count (rolled up across descendants, excluding archived).
  const folderItemCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const it of (itemsQuery.data ?? []) as Array<MemoryItem & { folderPath?: string; status?: string }>) {
      if (it.status === "archived") continue;
      const p = it.folderPath ?? "";
      map.set(p, (map.get(p) ?? 0) + 1);
    }
    return (path: string) => {
      let total = 0;
      for (const [itemPath, count] of map.entries()) {
        if (itemPath === path || itemPath.startsWith(path + "/")) {
          total += count;
        }
      }
      return total;
    };
  }, [itemsQuery.data]);

  function navigateToFolder(folder: MemoryFolderRecord) {
    const params = new URLSearchParams();
    params.set("folder", folder.path);
    if (folder.departmentId) params.set("dept", folder.departmentId);
    navigate(`/${companyPrefix}/memory/explore?${params.toString()}`);
  }

  function selectRow(row: ListRow) {
    onSelectRow(row.id, row.kind, row.name);
  }

  const isLoading = itemsQuery.isLoading || assetsQuery.isLoading;
  const title = scopeTitle(folderPath, layer, isDeptOnly, deptName);
  const countLabel = [
    subfolders.length > 0
      ? `${subfolders.length} ${subfolders.length === 1 ? "folder" : "folders"}`
      : null,
    `${filteredRows.length} ${filteredRows.length === 1 ? "item" : "items"}`,
    totalItems !== undefined ? `${totalItems} total` : null,
  ].filter(Boolean).join(" · ");

  function closeSearch() {
    onSearchChange?.("");
    setSearchOpen(false);
  }

  if (!folderPath && !isLayerOnly && !isDeptOnly) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
        Select a folder to see its contents
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-card/30">
      <div
        className="flex h-[42px] shrink-0 items-center gap-3 border-b border-border bg-card px-3"
        data-testid="memory-list-header"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{title}</div>
          <div className="truncate text-[11px] text-muted-foreground">{countLabel}</div>
        </div>
        {searchOpen ? (
          <div className="relative w-[min(260px,36vw)] shrink-0">
            <Search
              aria-hidden
              className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-very-dim"
            />
            <Input
              ref={searchInputRef}
              type="search"
              value={searchQuery ?? ""}
              onChange={(e) => onSearchChange?.(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") closeSearch();
              }}
              placeholder="Search this scope"
              aria-label="Search this scope"
              className="h-7 pl-8 pr-7 text-xs"
            />
            <button
              type="button"
              title="Close search"
              aria-label="Close search"
              onClick={closeSearch}
              className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
            >
              <X className="size-3" aria-hidden />
            </button>
          </div>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            title="Search this scope"
            aria-label="Search this scope"
            onClick={() => setSearchOpen(true)}
            className="h-7 w-7 p-0"
          >
            <Search className="size-3.5" aria-hidden />
          </Button>
        )}
        {uploadContext && (
          <MemoryUploadButton
            companyId={companyId}
            departmentId={uploadContext.departmentId}
            folderPath={uploadContext.folderPath}
            iconOnly
          />
        )}
        {onNewItem && (
          <Button
            type="button"
            size="sm"
            title="New item"
            aria-label="New item"
            onClick={onNewItem}
            className="h-7 w-7 p-0"
          >
            <Plus className="size-3.5" aria-hidden />
          </Button>
        )}
        <MemoryViewToggle mode={mode} onChange={setMode} />
        <span className="hidden text-[10px] text-muted-foreground">
          {subfolders.length > 0 && `${subfolders.length} ${subfolders.length === 1 ? "folder" : "folders"} · `}
          {filteredRows.length} {filteredRows.length === 1 ? "item" : "items"}
        </span>
      </div>
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : (
          <>
            {subfolders.length > 0 && (
              <div className="border-b border-border">
                <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Folders ({subfolders.length})
                </div>
                {subfolders.map((f) => {
                  const count = folderItemCounts(f.path);
                  return (
                    <button
                      key={`folder-${f.id}`}
                      onClick={() => navigateToFolder(f)}
                      className={cn(
                        "w-full text-left flex items-center gap-2 px-3 py-2 text-xs",
                        "hover:bg-muted/40 transition-colors duration-100",
                      )}
                    >
                      <span className="text-base leading-none">
                        {f.icon ?? "📂"}
                      </span>
                      <span className="flex-1 truncate font-medium">{f.displayName}</span>
                      <span className="text-muted-foreground tabular-nums text-[10px]">
                        {count} {count === 1 ? "item" : "items"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {filteredRows.length > 0 ? (
              <div>
                <div className="px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Items at this level ({filteredRows.length})
                </div>
                {mode === "list" && displayRows.map((r) => (
                  <MemoryItemRow
                    key={`${r.kind}-${r.id}`}
                    row={toRowData(r)}
                    active={r.id === selectedItemId && r.kind === selectedItemType}
                    onSelect={(id, kind) => {
                      const row = displayRows.find((x) => x.id === id && x.kind === kind);
                      if (row) selectRow(row);
                    }}
                    onReindex={handleReindex}
                  />
                ))}
                {mode === "table" && (
                  <MemoryItemTable
                    rows={displayRows.map(toRowData)}
                    activeId={selectedItemId}
                    onSelect={(id, kind) => {
                      const row = displayRows.find((x) => x.id === id && x.kind === kind);
                      if (row) selectRow(row);
                    }}
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSortChange={handleSortChange}
                    onReindex={handleReindex}
                  />
                )}
                {mode === "cards" && (
                  <MemoryItemCardGrid
                    rows={displayRows.map(toRowData)}
                    activeId={selectedItemId}
                    onSelect={(id, kind) => {
                      const row = displayRows.find((x) => x.id === id && x.kind === kind);
                      if (row) selectRow(row);
                    }}
                    onReindex={handleReindex}
                  />
                )}
              </div>
            ) : subfolders.length === 0 ? (
              <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                No items in this folder
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
