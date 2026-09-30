import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { X, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { memoryAssetsApi } from "../../api/memoryAssets";
import { queryKeys } from "../../lib/queryKeys";
import { useNavigate } from "@/lib/router";
import { useCompany } from "../../context/CompanyContext";
import { cn } from "@/lib/utils";
import { formatBytes } from "../../lib/format";

interface SourceTextDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  importJobId: string;
}

export function SourceTextDrawer({
  open,
  onOpenChange,
  companyId,
  importJobId,
}: SourceTextDrawerProps) {
  const navigate = useNavigate();
  const { selectedCompany } = useCompany();
  const companyPrefix = (selectedCompany as { issuePrefix?: string } | null)?.issuePrefix ?? "";

  const { data: assets, isLoading } = useQuery({
    queryKey: queryKeys.memory.assets.list(companyId),
    queryFn: () => memoryAssetsApi.list(companyId),
    enabled: open,
  });
  const asset = (assets ?? []).find((a) => a.importJobId === importJobId);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onOpenChange(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  function openInViewer() {
    if (!asset) return;
    const params = new URLSearchParams(window.location.search);
    params.set("item", asset.id);
    params.set("type", "asset");
    navigate(`/${companyPrefix}/memory/explore?${params.toString()}`);
    onOpenChange(false);
  }

  return (
    <div
      className={cn(
        "absolute inset-y-0 right-0 w-[420px] bg-card border-l border-border shadow-2xl",
        "transition-transform duration-200 ease-out z-30",
        open ? "translate-x-0" : "translate-x-full",
      )}
      role="complementary"
      aria-label="Source text drawer"
      aria-hidden={!open}
    >
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground flex-1">
          Source
        </span>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => onOpenChange(false)}
          className="h-7 w-7"
          aria-label="Close source drawer"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="px-4 py-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        ) : !asset ? (
          <div className="text-xs text-muted-foreground">
            The source file for this item is no longer available. It may have
            been deleted or archived.
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <div className="text-sm font-medium">{asset.fileName}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                {asset.mimeType} · {formatBytes(asset.fileSize)}
              </div>
            </div>
            <div className="text-xs text-muted-foreground leading-relaxed">
              This memory item was extracted from the file above. Inline
              passage rendering with the originating text highlighted is
              coming in a follow-up slice.
            </div>
            <Button
              size="sm"
              onClick={openInViewer}
              className="w-full gap-2"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open source in viewer
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
