import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CircleDot,
  Loader2,
  Map as MapIcon,
  Network,
  type LucideIcon,
} from "lucide-react";
import type { CompanyBrainNode } from "@armyofagents/shared";
import { Button } from "@/components/ui/button";
import { memoryApi } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";
import { CompanyGraphCanvas } from "./graph/CompanyGraphCanvas";
import {
  CompanyGraphClusterView,
  CompanyGraphNetworkView,
} from "./graph/CompanyGraphD3Views";
import { LocalGraphPreview } from "./graph/LocalGraphPreview";
import { UsedByAgentsPanel } from "./graph/UsedByAgentsPanel";

interface MemoryGraphViewerProps {
  companyId: string;
  itemId?: string | null;
  onOpenMemoryItem?: (item: { id: string; title: string }) => void;
  onOpenGraphNode?: (node: CompanyBrainNode) => void;
}

type CompanyGraphMode = "map" | "network" | "cluster";

const COMPANY_GRAPH_MODES: Array<{
  id: CompanyGraphMode;
  label: string;
  ariaLabel: string;
  Icon: LucideIcon;
}> = [
  { id: "map", label: "Map", ariaLabel: "Map view", Icon: MapIcon },
  { id: "network", label: "Network", ariaLabel: "Network view", Icon: Network },
  { id: "cluster", label: "Clusters", ariaLabel: "Cluster view", Icon: CircleDot },
];

export function MemoryGraphViewer({
  companyId,
  itemId,
  onOpenMemoryItem,
  onOpenGraphNode,
}: MemoryGraphViewerProps) {
  const isItemGraph = Boolean(itemId);
  const [companyGraphMode, setCompanyGraphMode] = useState<CompanyGraphMode>("map");
  const companyGraphQuery = useQuery({
    queryKey: queryKeys.memory.companyGraph(companyId),
    queryFn: () => memoryApi.companyGraph(companyId, {
      includeStructural: true,
      limit: 100,
    }),
    enabled: Boolean(companyId && !isItemGraph),
  });
  const graphQuery = useQuery({
    queryKey: itemId
      ? queryKeys.memory.neighbors(companyId, itemId)
      : ["memory", companyId, "company-graph-shell"],
    queryFn: () => memoryApi.neighbors(companyId, itemId!, { depth: 1 }),
    enabled: Boolean(companyId && itemId),
  });
  const usageQuery = useQuery({
    queryKey: itemId
      ? queryKeys.memory.usage(companyId, itemId)
      : ["memory", companyId, "company-graph-usage-shell"],
    queryFn: () => memoryApi.usage(companyId, itemId!),
    enabled: Boolean(companyId && itemId),
  });

  if (!isItemGraph) {
    let graphContent: ReactNode;
    if (companyGraphQuery.isLoading) {
      graphContent = (
        <div className="flex min-h-[420px] items-center justify-center rounded-md border border-border bg-card/40 text-xs text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading company graph
        </div>
      );
    } else if (companyGraphQuery.isError || !companyGraphQuery.data) {
      graphContent = (
        <div className="flex min-h-[420px] items-center justify-center rounded-md border border-border bg-card/40 text-sm text-muted-foreground">
          Could not load company graph.
        </div>
      );
    } else {
      if (companyGraphMode === "network") {
        graphContent = (
          <CompanyGraphNetworkView
            graph={companyGraphQuery.data}
            onOpenGraphNode={onOpenGraphNode}
          />
        );
      } else if (companyGraphMode === "cluster") {
        graphContent = (
          <CompanyGraphClusterView
            graph={companyGraphQuery.data}
            onOpenGraphNode={onOpenGraphNode}
          />
        );
      } else {
        graphContent = (
          <CompanyGraphCanvas
            graph={companyGraphQuery.data}
            onOpenMemoryItem={onOpenMemoryItem}
            onOpenGraphNode={onOpenGraphNode}
          />
        );
      }
    }

    return (
      <div className="h-full flex flex-col">
        <div className="border-b border-border px-5 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <MapIcon className="h-4 w-4" />
              Map
            </div>
            <div className="flex items-center gap-1" role="group" aria-label="Map view mode">
              {COMPANY_GRAPH_MODES.map(({ id, label, ariaLabel, Icon }) => (
                <Button
                  key={id}
                  type="button"
                  size="sm"
                  variant={companyGraphMode === id ? "secondary" : "ghost"}
                  className="h-7 gap-1 px-2 text-xs"
                  aria-label={ariaLabel}
                  aria-pressed={companyGraphMode === id}
                  title={label}
                  onClick={() => setCompanyGraphMode(id)}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden />
                  <span className="hidden sm:inline">{label}</span>
                </Button>
              ))}
            </div>
          </div>
        </div>
        <div
          className="flex-1 min-h-0 overflow-hidden p-3"
          data-testid="company-graph-mode-shell"
        >
          {graphContent}
        </div>
      </div>
    );
  }

  if (graphQuery.isLoading) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading graph
      </div>
    );
  }

  if (graphQuery.isError || !graphQuery.data) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        Could not load graph.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="border-b border-border px-5 py-3">
        <div className="text-sm font-semibold">{graphQuery.data.center.label}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {graphQuery.data.nodes.length} nodes / {graphQuery.data.edges.length} edges
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-5">
        <div className="grid gap-4">
          <LocalGraphPreview
            graph={graphQuery.data}
            centerId={itemId!}
            onOpenMemoryItem={onOpenMemoryItem}
          />
          <UsedByAgentsPanel
            usage={usageQuery.data?.agents ?? []}
            isLoading={usageQuery.isLoading}
          />
        </div>
      </div>
    </div>
  );
}
