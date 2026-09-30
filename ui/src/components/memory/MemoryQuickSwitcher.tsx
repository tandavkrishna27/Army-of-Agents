import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { Search, FileText, File as FileIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { memoryApi } from "../../api/memory";
import { memoryAssetsApi } from "../../api/memoryAssets";
import { queryKeys } from "../../lib/queryKeys";
import { useCompany } from "../../context/CompanyContext";
import type { MemoryItem, MemoryAssetRecord } from "@armyofagents/shared";
import { cn } from "@/lib/utils";

interface ResultRow {
  kind: "memory_item" | "asset";
  id: string;
  title: string;
  subtitle: string;
  folderPath: string;
  departmentId: string | null;
}

const MAX_RESULTS = 12;

export function MemoryQuickSwitcher() {
  const navigate = useNavigate();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const companyPrefix = (selectedCompany as { issuePrefix?: string } | null)?.issuePrefix ?? "";

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);

  // Opens via the MemoryHome button dispatching `memory:open-quick-switcher`.
  // ⌘K stays with the global CommandPalette (cross-entity search) — this overlay
  // is memory-scoped and reachable from MemoryHome only.
  useEffect(() => {
    function onOpen() {
      if (!selectedCompanyId) return;
      setOpen(true);
    }
    window.addEventListener("memory:open-quick-switcher", onOpen);
    return () => window.removeEventListener("memory:open-quick-switcher", onOpen);
  }, [selectedCompanyId]);

  // Reset state when reopened
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
    }
  }, [open]);

  const _itemsQuery = useQuery({
    queryKey: queryKeys.memory.list(selectedCompanyId ?? ""),
    queryFn: () => memoryApi.list(selectedCompanyId!, {}),
    enabled: open && Boolean(selectedCompanyId),
  });
  const itemsQuery = { ..._itemsQuery, data: _itemsQuery.data?.items };
  const assetsQuery = useQuery({
    queryKey: queryKeys.memory.assets.list(selectedCompanyId ?? ""),
    queryFn: () => memoryAssetsApi.list(selectedCompanyId!),
    enabled: open && Boolean(selectedCompanyId),
  });

  const allRows: ResultRow[] = useMemo(() => {
    const items = (itemsQuery.data ?? []).map<ResultRow>((it: MemoryItem) => ({
      kind: "memory_item",
      id: it.id,
      title: it.title,
      subtitle: it.category ?? "memory item",
      folderPath: (it as MemoryItem & { folderPath?: string }).folderPath ?? "",
      departmentId: (it as MemoryItem & { departmentId?: string | null }).departmentId ?? null,
    }));
    const assets = (assetsQuery.data ?? []).map<ResultRow>((a: MemoryAssetRecord) => ({
      kind: "asset",
      id: a.id,
      title: a.fileName,
      subtitle: a.mimeType,
      folderPath: a.folderPath ?? "",
      departmentId: a.departmentId,
    }));
    return [...items, ...assets];
  }, [itemsQuery.data, assetsQuery.data]);

  const results = useMemo(() => {
    if (!query.trim()) {
      return allRows.slice(0, MAX_RESULTS);
    }
    const q = query.toLowerCase();
    return allRows
      .filter((r) => r.title.toLowerCase().includes(q) || r.subtitle.toLowerCase().includes(q))
      .slice(0, MAX_RESULTS);
  }, [allRows, query]);

  // Reset activeIdx when results change
  useEffect(() => { setActiveIdx(0); }, [query]);

  function selectRow(row: ResultRow) {
    if (!selectedCompanyId || !companyPrefix) return;
    const params = new URLSearchParams();
    if (row.folderPath) params.set("folder", row.folderPath);
    if (row.departmentId) params.set("dept", row.departmentId);
    params.set("item", row.id);
    params.set("type", row.kind);
    navigate(`/${companyPrefix}/memory/explore?${params.toString()}`);
    setOpen(false);
  }

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = results[activeIdx];
      if (row) selectRow(row);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl gap-0 p-0 overflow-hidden" aria-describedby={undefined}>
        <DialogTitle className="sr-only">Quick Switcher</DialogTitle>
        <div className="flex items-center px-3 py-2 border-b border-border gap-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Search memory items + files…"
            className="border-0 focus-visible:ring-0 px-0 h-8 text-sm"
            aria-label="Quick switcher search"
          />
        </div>
        <div className="max-h-80 overflow-auto py-1">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-xs text-muted-foreground text-center">
              {query.trim() ? "No matches" : "Start typing to search"}
            </div>
          ) : (
            results.map((row, i) => {
              const Icon = row.kind === "memory_item" ? FileText : FileIcon;
              return (
                <button
                  key={`${row.kind}-${row.id}`}
                  onClick={() => selectRow(row)}
                  onMouseEnter={() => setActiveIdx(i)}
                  className={cn(
                    "w-full text-left flex items-center gap-3 px-3 py-2 text-xs",
                    "transition-colors duration-100",
                    i === activeIdx ? "bg-primary/10 text-primary" : "hover:bg-muted/40",
                  )}
                >
                  <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{row.title}</div>
                    <div className="text-[10px] text-muted-foreground truncate">
                      {row.subtitle}
                      {row.folderPath && ` · 📁 ${row.folderPath}`}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
