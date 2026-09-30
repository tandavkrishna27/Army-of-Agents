import { useMemo, useState } from "react";
import { ExternalLink, Network } from "lucide-react";
import type {
  CompanyBrainEdge,
  CompanyBrainNeighborsResponse,
  CompanyBrainNode,
} from "@armyofagents/shared";
import { Button } from "@/components/ui/button";

interface LocalGraphPreviewProps {
  graph: CompanyBrainNeighborsResponse;
  centerId: string;
  initialVisiblePerGroup?: number;
  onOpenMemoryItem?: (item: { id: string; title: string }) => void;
}

interface NeighborEntry {
  edge: CompanyBrainEdge;
  node: CompanyBrainNode;
}

function nodeKey(node: { type: string; id: string }): string {
  return `${node.type}:${node.id}`;
}

function nodeTypeLabel(type: string): string {
  return type.replace(/_/g, " ");
}

export function LocalGraphPreview({
  graph,
  centerId,
  initialVisiblePerGroup = 4,
  onOpenMemoryItem,
}: LocalGraphPreviewProps) {
  const [expandedKinds, setExpandedKinds] = useState<Set<string>>(() => new Set());

  const grouped = useMemo(() => {
    const nodes = new Map(graph.nodes.map((node) => [nodeKey(node), node]));
    const next = new Map<string, NeighborEntry[]>();

    for (const edge of graph.edges) {
      const otherRef =
        edge.from.type === "memory_item" && edge.from.id === centerId
          ? edge.to
          : edge.to.type === "memory_item" && edge.to.id === centerId
            ? edge.from
            : null;

      if (!otherRef) continue;
      const node = nodes.get(nodeKey(otherRef));
      if (!node) continue;

      const entries = next.get(edge.kind) ?? [];
      entries.push({ edge, node });
      next.set(edge.kind, entries);
    }

    return Array.from(next.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [centerId, graph.edges, graph.nodes]);

  return (
    <section className="rounded-md border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-semibold">
          <Network className="h-3.5 w-3.5 text-muted-foreground" />
          Local graph
        </div>
        <span className="text-[11px] text-muted-foreground">
          {graph.nodes.length} nodes / {graph.edges.length} edges
        </span>
      </div>
      <div className="grid gap-3 p-3">
        {grouped.length === 0 && (
          <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            No visible graph neighbors yet
          </div>
        )}
        {grouped.map(([kind, entries]) => {
          const expanded = expandedKinds.has(kind);
          const visible = expanded ? entries : entries.slice(0, initialVisiblePerGroup);
          const hiddenCount = entries.length - visible.length;

          return (
            <div key={kind} className="grid gap-1.5">
              <div className="text-[11px] font-medium text-muted-foreground">{kind}</div>
              {visible.map(({ edge, node }) => (
                <div
                  key={edge.id}
                  className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium">{node.label}</div>
                    <div className="mt-0.5 text-[11px] capitalize text-muted-foreground">
                      {nodeTypeLabel(node.type)}
                    </div>
                  </div>
                  {node.type === "memory_item" && node.id !== centerId && onOpenMemoryItem && (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0"
                      aria-label={`Open ${node.label}`}
                      onClick={() => onOpenMemoryItem({ id: node.id, title: node.label })}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              ))}
              {hiddenCount > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 justify-start px-2 text-xs"
                  onClick={() => setExpandedKinds((current) => new Set(current).add(kind))}
                >
                  Show {hiddenCount} more {kind}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
