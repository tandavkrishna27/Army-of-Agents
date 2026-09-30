import { useQuery } from "@tanstack/react-query";

/** Matches the 4 layers defined in MemoryFolderRail: identity / domain / active_context / working */
const LAYER_COUNT = 4 as const;
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { memoryApi } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";
import { PendingReviewPill } from "./PendingReviewPill";
import { MemoryUploadButton } from "./MemoryUploadButton";

interface UploadContext {
  departmentId: string | null;
  folderPath: string;
}

interface Props {
  companyId: string;
  searchValue: string;
  onSearchChange: (v: string) => void;
  onNewItem: () => void;
  /** Provided when the current scope allows asset upload; otherwise the Upload button hides. */
  uploadContext?: UploadContext;
  /**
   * When true, the search input is hidden — the Home dashboard center pane
   * doesn't render a list to filter. The toolbar's count + +New still apply.
   */
  searchEnabled?: boolean;
}

export function MemoryToolbar({
  companyId,
  searchValue,
  onSearchChange,
  onNewItem,
  uploadContext,
  searchEnabled = true,
}: Props) {
  const { data: listResponse } = useQuery({
    queryKey: queryKeys.memory.list(companyId),
    queryFn: () => memoryApi.list(companyId, {}),
    enabled: Boolean(companyId),
  });
  const total = listResponse?.items?.length ?? 0;

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
      <h1 className="text-sm font-semibold">Memory</h1>
      <span className="text-xs text-very-dim">
        · {total} {total === 1 ? "item" : "items"} · {LAYER_COUNT} layers
      </span>
      <span className="flex-1" />

      <PendingReviewPill companyId={companyId} />

      {searchEnabled && (
        <div className="relative w-56">
          <Search
            aria-hidden
            className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-very-dim"
          />
          <Input
            type="search"
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Quick-jump…  ⌘K"
            aria-label="Search this folder"
            className="h-7 pl-8 pr-2 text-xs"
          />
        </div>
      )}

      {uploadContext && (
        <MemoryUploadButton
          companyId={companyId}
          departmentId={uploadContext.departmentId}
          folderPath={uploadContext.folderPath}
        />
      )}

      <Button
        size="sm"
        className="h-7 gap-1.5 px-3 text-xs"
        onClick={onNewItem}
      >
        <Plus className="size-3.5" aria-hidden />
        New item
      </Button>
    </header>
  );
}
