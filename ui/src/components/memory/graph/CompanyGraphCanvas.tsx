import { useEffect, useMemo, useRef, useState } from "react";
import Graph from "graphology";
import { ExternalLink, Info, Network, X } from "lucide-react";
import type {
  CompanyBrainEdge,
  CompanyBrainNode,
  CompanyBrainOverviewResponse,
} from "@armyofagents/shared";
import { Button } from "@/components/ui/button";
import {
  graphCssColor,
  graphEdgeCanvasColor,
  graphNodeCanvasColor,
  graphNodeColor,
} from "./graphTheme";

interface CompanyGraphCanvasProps {
  graph: CompanyBrainOverviewResponse;
  onOpenMemoryItem?: (item: { id: string; title: string }) => void;
  onOpenGraphNode?: (node: CompanyBrainNode) => void;
}

interface ConnectedEdge {
  edge: CompanyBrainEdge;
  other: CompanyBrainNode;
}

function nodeKey(node: Pick<CompanyBrainNode, "type" | "id">): string {
  return `${node.type}:${node.id}`;
}

function nodeSize(type: CompanyBrainNode["type"]): number {
  return type === "memory_item" ? 10 : 7;
}

function nodeTypeLabel(type: string): string {
  return type.replace(/_/g, " ");
}

function edgeKindLabel(kind: CompanyBrainEdge["kind"]): string {
  switch (kind) {
    case "belongs_to":
      return "Belongs to";
    case "member_of":
      return "Member of";
    case "participates_in":
      return "Participates in";
    case "owns":
      return "Owns";
    case "owned_by":
      return "Owned by";
    case "created_by":
      return "Created by";
    case "assigned_to":
      return "Assigned to";
    case "blocks":
      return "Blocks";
    case "mentioned_in":
      return "Mentioned in";
    case "extracted_from":
      return "Extracted from";
    case "derived_from":
      return "Derived from";
    case "retrieved_by":
      return "Retrieved by";
    case "used_by":
      return "Used by";
    case "applies_to":
      return "Applies to";
    case "related_to":
      return "Related to";
    case "supports":
      return "Supports";
    case "conflicts_with":
      return "Conflicts with";
    case "supersedes":
      return "Supersedes";
    case "duplicate_of":
      return "Duplicate of";
  }
}

function buildSigmaGraph(response: CompanyBrainOverviewResponse) {
  const next = new Graph();
  const total = Math.max(response.nodes.length, 1);
  response.nodes.forEach((node, index) => {
    const angle = (index / total) * Math.PI * 2;
    const radius = 1 + Math.sqrt(total) * 0.18;
    next.addNode(nodeKey(node), {
      label: node.label,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      size: nodeSize(node.type),
      color: graphNodeCanvasColor(node.type),
      nodeType: node.type,
      memoryId: node.type === "memory_item" ? node.id : null,
      href: node.href ?? null,
    });
  });

  for (const edge of response.edges) {
    const from = nodeKey(edge.from);
    const to = nodeKey(edge.to);
    if (!next.hasNode(from) || !next.hasNode(to) || next.hasEdge(edge.id)) continue;
    next.addDirectedEdgeWithKey(edge.id, from, to, {
      label: edge.kind,
      size: edge.sourceClass === "semantic" ? 2.2 : 1,
      color: graphEdgeCanvasColor(edge.sourceClass),
      edgeKind: edge.kind,
      sourceClass: edge.sourceClass,
    });
  }

  return next;
}

function connectedEdges(
  graph: CompanyBrainOverviewResponse,
  selectedKey: string,
): ConnectedEdge[] {
  const nodes = new Map(graph.nodes.map((node) => [nodeKey(node), node]));
  return graph.edges.flatMap((edge) => {
    const fromKey = nodeKey(edge.from);
    const toKey = nodeKey(edge.to);
    if (fromKey !== selectedKey && toKey !== selectedKey) return [];
    const other = nodes.get(fromKey === selectedKey ? toKey : fromKey);
    return other ? [{ edge, other }] : [];
  });
}

export function CompanyGraphCanvas({
  graph,
  onOpenMemoryItem,
  onOpenGraphNode,
}: CompanyGraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [relationshipsOpen, setRelationshipsOpen] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(
    () => graph.nodes[0] ? nodeKey(graph.nodes[0]) : null,
  );

  const nodesByKey = useMemo(
    () => new Map(graph.nodes.map((node) => [nodeKey(node), node])),
    [graph.nodes],
  );
  const selectedNode =
    (selectedKey ? nodesByKey.get(selectedKey) : null) ?? graph.nodes[0] ?? null;
  const selectedNodeKey = selectedNode ? nodeKey(selectedNode) : null;
  const selectedRelations = selectedNodeKey
    ? connectedEdges(graph, selectedNodeKey)
    : [];

  useEffect(() => {
    if (!containerRef.current || graph.nodes.length === 0) return;

    let active = true;
    let renderer: { kill: () => void; on: (event: "clickNode", handler: (event: { node: string }) => void) => void } | null = null;
    const sigmaGraph = buildSigmaGraph(graph);
    const container = containerRef.current;
    const labelColor = graphCssColor("--text", "#eeeeee");
    const edgeLabelColor = graphCssColor("--dim", "#999999");
    const defaultEdgeColor = "#6f7784";

    void import("sigma").then(({ default: Sigma }) => {
      if (!active || !container) return;
      renderer = new Sigma(sigmaGraph, container, {
        labelColor: { color: labelColor },
        edgeLabelColor: { color: edgeLabelColor },
        defaultEdgeColor,
        defaultDrawNodeHover: () => undefined,
        renderLabels: true,
        labelSize: 11,
        labelWeight: "500",
      });
      renderer.on("clickNode", (event: { node: string }) => {
        setSelectedKey(event.node);
        const node = nodesByKey.get(event.node);
        if (node) onOpenGraphNode?.(node);
      });
    });

    return () => {
      active = false;
      renderer?.kill();
    };
  }, [graph, nodesByKey, onOpenGraphNode]);

  if (graph.nodes.length === 0) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center rounded-md border border-dashed border-border bg-card/40 p-6 text-center text-text">
        <div>
          <Network className="mx-auto h-6 w-6 text-muted-foreground" aria-hidden />
          <div className="mt-3 text-sm font-medium">No visible graph relationships yet</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Approved memory links will appear here once the company brain has graph edges.
          </div>
        </div>
      </div>
    );
  }

  return (
    <section
      className="relative h-full min-h-0 overflow-hidden rounded-md border border-border bg-card text-text"
      data-testid="company-graph-map-view"
    >
      <div className="relative h-full min-h-0 bg-background">
        <div
          ref={containerRef}
          className="absolute inset-0 cursor-grab active:cursor-grabbing"
          data-testid="company-graph-sigma-canvas"
        />
        <div className="absolute left-3 top-3 rounded-md border border-border bg-card/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm">
          {graph.nodes.length} nodes / {graph.edges.length} edges
          {graph.truncated ? ` / limited to ${graph.limit}` : ""}
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="absolute right-3 top-3 h-7 w-7 p-0 shadow-sm"
          aria-label={detailsOpen ? "Hide graph details" : "Show graph details"}
          title={detailsOpen ? "Hide graph details" : "Show graph details"}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          {detailsOpen ? <X className="h-3.5 w-3.5" aria-hidden /> : <Info className="h-3.5 w-3.5" aria-hidden />}
        </Button>
      </div>

      {detailsOpen && (
      <aside
        className="absolute bottom-3 right-3 top-12 z-10 flex w-[min(320px,calc(100%-24px))] min-h-0 flex-col overflow-hidden rounded-md border border-border bg-card/95 shadow-lg backdrop-blur"
        data-testid="company-graph-details-drawer"
      >
        <div className="border-b border-border px-3 py-2">
          <div className="text-xs font-semibold">Graph details</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {graph.nodes.length} nodes / {graph.edges.length} edges
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          <div className="grid gap-1.5">
            {graph.nodes.map((node) => {
              const key = nodeKey(node);
              const selected = selectedNodeKey === key;
              return (
                <div
                  key={key}
                  className={selected
                    ? "rounded-md border border-primary/50 bg-primary/10"
                    : "rounded-md border border-border bg-background"}
                >
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-2 py-2 text-left transition-colors hover:bg-muted/50"
                    aria-label={`Select ${node.label}`}
                    onClick={() => setSelectedKey(key)}
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: graphNodeColor(node.type) }}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{node.label}</span>
                      <span className="block text-[11px] capitalize text-muted-foreground">
                        {nodeTypeLabel(node.type)}
                      </span>
                    </span>
                  </button>
                  {node.type === "memory_item" && onOpenMemoryItem && (
                    <div className="border-t border-border/70 px-2 pb-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 w-full justify-start gap-1 px-1 text-xs"
                        aria-label={`Open ${node.label}`}
                        onClick={() => onOpenMemoryItem({ id: node.id, title: node.label })}
                      >
                        <ExternalLink className="h-3 w-3" aria-hidden />
                        Open
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {selectedNode && (
          <div className="border-t border-border p-3" data-testid="company-graph-selected-node">
            <div className="text-xs font-semibold">{selectedNode.label}</div>
            <div className="mt-0.5 text-[11px] capitalize text-muted-foreground">
              {nodeTypeLabel(selectedNode.type)}
            </div>
            <div className="mt-3 overflow-hidden rounded-md border border-border bg-background">
              <button
                type="button"
                className="flex w-full items-center justify-between px-2 py-1.5 text-left text-[11px] font-semibold"
                aria-expanded={relationshipsOpen}
                aria-label="Relationships"
                onClick={() => setRelationshipsOpen((open) => !open)}
              >
                Relationships
                <span className="text-muted-foreground">{selectedRelations.length}</span>
              </button>
              {relationshipsOpen && (
                <div className="grid gap-1 border-t border-border/70 p-2">
                  {selectedRelations.length === 0 ? (
                    <div className="text-[11px] text-muted-foreground">No visible relations</div>
                  ) : (
                    selectedRelations.map(({ edge, other }) => (
                      <div
                        key={edge.id}
                        className="rounded-md border border-border/70 bg-card px-2 py-1.5 text-[11px]"
                      >
                        {edgeKindLabel(edge.kind)} {other.label}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </aside>
      )}
    </section>
  );
}
