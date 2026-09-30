import { cn } from "@/lib/utils";
import { DrawOnMap, type MapEdge } from "./motion/DrawOnMap";

/** Virtual coordinate space the node/edge positions below are authored in —
 * ported 1:1 from the mockup's `<svg viewBox="0 0 900 300">` (S6). Nodes are
 * placed by percentage of this box so the diagram stays responsive. */
export const MAP_VIEWBOX = { width: 900, height: 300 };

export type MapNodeKind = "default" | "human" | "agent" | "mem" | "task";

export type MapNodeSpec = {
  id: string;
  label: string;
  x: number;
  y: number;
  kind?: MapNodeKind;
};

/** Ported verbatim (positions + labels) from mockup screen S6's `.mnode`s. */
export const MAP_NODES: MapNodeSpec[] = [
  { id: "commander", label: "Commander", x: 80, y: 60 },
  { id: "discussion", label: "Discussion", x: 80, y: 150 },
  { id: "direct", label: "Direct", x: 80, y: 240 },
  { id: "task", label: "TASK", x: 360, y: 150, kind: "task" },
  { id: "agent", label: "⚡ Agent", x: 600, y: 90, kind: "agent" },
  { id: "human", label: "👤 Human", x: 600, y: 210, kind: "human" },
  { id: "review", label: "Review ✅", x: 720, y: 150 },
  { id: "memory", label: "Memory · shared brain", x: 470, y: 262, kind: "mem" },
];

/** Ported verbatim (paths) from mockup screen S6's `.edge` SVG paths. Depth
 * mirrors the mockup's `nth-child` stagger (source → TASK first, TASK →
 * Agent/Human next, Review then Memory last). */
export const MAP_EDGES: MapEdge[] = [
  { id: "commander-task", d: "M150,60 C240,60 240,150 320,150", depth: 0 },
  { id: "discussion-task", d: "M150,150 L320,150", depth: 1 },
  { id: "direct-task", d: "M150,240 C240,240 240,150 320,150", depth: 2 },
  { id: "task-agent", d: "M400,150 L560,90", depth: 3 },
  { id: "task-human", d: "M400,150 L560,210", depth: 3 },
  { id: "agent-review", d: "M660,150 L780,150", depth: 4 },
  { id: "task-memory", d: "M470,260 C600,300 780,240 820,180", depth: 5 },
];

const NODE_KIND_CLASS: Record<MapNodeKind, string> = {
  default: "border-border-strong bg-card text-text",
  task: "border-brand bg-card text-text",
  // Human = white/red (mockup `.mnode.human`).
  human: "border-brand bg-white text-[#1e1a16]",
  // Agent = dark/zinc (mockup `.mnode.agent`).
  agent: "border-[#3f3f46] bg-[#18181b] text-text",
  // Memory = indigo (mockup `.mnode.mem`).
  mem: "border-[var(--indigo)] text-[#cdd2f5] bg-card",
};

function MapNodeEl({ node }: { node: MapNodeSpec }) {
  const kind = node.kind ?? "default";
  return (
    <div
      data-testid={`map-node-${node.id}`}
      className={cn(
        "absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-[10px] border px-3 py-2 text-xs",
        NODE_KIND_CLASS[kind],
      )}
      style={{
        left: `${(node.x / MAP_VIEWBOX.width) * 100}%`,
        top: `${(node.y / MAP_VIEWBOX.height) * 100}%`,
      }}
    >
      {node.label}
    </div>
  );
}

/**
 * WS9 — the flow diagram shared by `Map` (with the door band, founder
 * first-run) and `MiniMap` (read-only, WS10 invited "the machine you're
 * joining"). Ports the mockup's `OrgHierarchyChart` grammar: edges draw
 * themselves (`DrawOnMap`), nodes are laid out by percentage over a virtual
 * 900x300 box so the whole thing stays responsive.
 */
export function MapDiagram({ className }: { className?: string }) {
  return (
    <div
      data-testid="map-diagram"
      className={cn("relative aspect-[3/1] w-full", className)}
    >
      <svg
        viewBox={`0 0 ${MAP_VIEWBOX.width} ${MAP_VIEWBOX.height}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        <DrawOnMap edges={MAP_EDGES} />
      </svg>
      {MAP_NODES.map((node) => (
        <MapNodeEl key={node.id} node={node} />
      ))}
    </div>
  );
}
