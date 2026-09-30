import { MemoryHomeDashboard } from "./MemoryHomeDashboard";
import type { MemoryTab } from "../../lib/memoryTabs";
import { Button } from "@/components/ui/button";
import { Network } from "lucide-react";

interface MemoryViewerHomeProps {
  companyId: string;
  onOpenTab?: (tab: MemoryTab) => void;
}

export function MemoryViewerHome({ companyId, onOpenTab }: MemoryViewerHomeProps) {
  return (
    <div className="h-full min-h-0 overflow-auto" data-testid="memory-viewer-home">
      <MemoryHomeDashboard
        companyId={companyId}
        variant="viewer"
        showQuickJump
        onOpenTab={onOpenTab}
      />
      <section
        data-testid="memory-home-graph-launcher"
        className="border-t border-border p-4"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Graph
            </div>
            <div className="mt-1 text-sm font-medium">Map</div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1"
            aria-label="Open company graph"
            onClick={() => onOpenTab?.({
              id: "company-graph",
              kind: "graph",
              title: "Map",
            })}
          >
            <Network className="h-3.5 w-3.5" />
            Open
          </Button>
        </div>
      </section>
    </div>
  );
}
