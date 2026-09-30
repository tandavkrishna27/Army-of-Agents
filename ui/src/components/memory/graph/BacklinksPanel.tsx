import { Link2 } from "lucide-react";
import type { CompanyBrainNeighborsResponse } from "@armyofagents/shared";

interface BacklinksPanelProps {
  itemId: string;
  graph: CompanyBrainNeighborsResponse | undefined;
  isLoading: boolean;
}

export function BacklinksPanel({ itemId, graph, isLoading }: BacklinksPanelProps) {
  const linked = (graph?.edges ?? [])
    .map((edge) => {
      const otherRef = edge.from.type === "memory_item" && edge.from.id === itemId
        ? edge.to
        : edge.to.type === "memory_item" && edge.to.id === itemId
          ? edge.from
          : null;
      if (!otherRef || otherRef.type !== "memory_item") return null;
      const node = graph?.nodes.find((candidate) => (
        candidate.type === otherRef.type && candidate.id === otherRef.id
      ));
      if (!node) return null;
      return { edge, node };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return (
    <aside className="border-t border-border bg-card/20 px-6 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium">
          <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
          Backlinks
        </div>
        <span className="text-[11px] text-muted-foreground">
          {isLoading ? "Loading" : `${linked.length} linked`}
        </span>
      </div>
      {linked.length > 0 && (
        <div className="mt-2 grid gap-1.5">
          {linked.slice(0, 4).map(({ edge, node }) => (
            <div
              key={edge.id}
              className="rounded-md border border-border bg-background px-3 py-2"
            >
              <div className="truncate text-xs font-medium">{node.label}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">{edge.kind}</div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
