import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { FileText, Loader2 } from "lucide-react";
import { memoryApi } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";
import { useCompany } from "../../context/CompanyContext";
import type { MemoryItem } from "@armyofagents/shared";
import { cn } from "@/lib/utils";

interface ExtractsSidebarProps {
  companyId: string;
  importJobId: string;
}

const STATUS_COLOR: Record<string, string> = {
  approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  archived: "bg-gray-100 text-gray-800 dark:bg-gray-900/40 dark:text-gray-300",
  rejected: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

export function ExtractsSidebar({ companyId, importJobId }: ExtractsSidebarProps) {
  const navigate = useNavigate();
  const { selectedCompany } = useCompany();
  const companyPrefix = (selectedCompany as { issuePrefix?: string } | null)?.issuePrefix ?? "";

  const { data: _listResponse, isLoading } = useQuery({
    queryKey: [...queryKeys.memory.list(companyId), { importJobId }],
    queryFn: () => memoryApi.list(companyId, {}),
    enabled: Boolean(companyId && importJobId),
  });
  const data = _listResponse?.items;

  const extracts = ((data ?? []) as MemoryItem[]).filter(
    (it) => (it as MemoryItem & { importJobId?: string }).importJobId === importJobId,
  );

  function openItem(itemId: string) {
    const params = new URLSearchParams(window.location.search);
    params.set("item", itemId);
    params.set("type", "memory_item");
    navigate(`/${companyPrefix}/memory/explore?${params.toString()}`);
  }

  return (
    <div className="w-72 border-l border-border bg-card/30 flex flex-col">
      <div className="px-3 py-2 border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-2">
        <FileText className="h-3 w-3" />
        <span>Extracts</span>
        <span className="flex-1" />
        <span className="tabular-nums">{extracts.length}</span>
      </div>
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-3 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        ) : extracts.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground text-center">
            No memory items have been extracted from this file yet.
          </div>
        ) : (
          extracts.map((it) => {
            const i = it as MemoryItem & { folderPath?: string };
            return (
              <div
                key={it.id}
                onClick={() => openItem(it.id)}
                className="px-3 py-2 border-b border-border cursor-pointer hover:bg-muted/40"
              >
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-medium truncate flex-1">{it.title}</span>
                  {it.status && (
                    <span
                      className={cn(
                        "text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-[0.06em]",
                        STATUS_COLOR[it.status] ?? "bg-muted text-muted-foreground",
                      )}
                    >
                      {it.status}
                    </span>
                  )}
                </div>
                {i.folderPath && (
                  <div className="text-[10px] text-muted-foreground mt-1 truncate">
                    📁 {i.folderPath}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
