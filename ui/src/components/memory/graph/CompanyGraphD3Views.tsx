import { useEffect, useMemo, useRef, useState } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  hierarchy,
  pack,
  select,
  zoom,
} from "d3";
import type { HierarchyCircularNode } from "d3";
import type {
  CompanyBrainNode,
  CompanyBrainOverviewResponse,
} from "@armyofagents/shared";
import { graphEdgeColor, graphNodeColor } from "./graphTheme";

interface CompanyGraphD3ViewProps {
  graph: CompanyBrainOverviewResponse;
  onOpenGraphNode?: (node: CompanyBrainNode) => void;
}

interface LayoutNode {
  key: string;
  label: string;
  type: CompanyBrainNode["type"];
  x?: number;
  y?: number;
}

interface LayoutLink {
  source: string | LayoutNode;
  target: string | LayoutNode;
}

interface ClusterDatum {
  key: string;
  name: string;
  type?: CompanyBrainNode["type"];
  node?: CompanyBrainNode;
  children?: ClusterDatum[];
}

type ClusterCircle = HierarchyCircularNode<ClusterDatum>;

interface ClusterLabel {
  key: string;
  name: string;
  x: number;
  y: number;
  anchor: "middle" | "start";
  tone: "major" | "minor" | "tiny";
  fontSize: number;
}

const WIDTH = 720;
const HEIGHT = 420;
const ROOT_VIEW_BOX = `0 0 ${WIDTH} ${HEIGHT}`;

function nodeKey(node: Pick<CompanyBrainNode, "type" | "id">): string {
  return `${node.type}:${node.id}`;
}

function nodeTypeLabel(type: string): string {
  return type.replace(/_/g, " ");
}

function coordinates(node: LayoutNode, index: number, total: number) {
  if (Number.isFinite(node.x) && Number.isFinite(node.y)) {
    return { x: node.x as number, y: node.y as number };
  }
  const angle = (index / Math.max(total, 1)) * Math.PI * 2;
  return {
    x: WIDTH / 2 + Math.cos(angle) * 120,
    y: HEIGHT / 2 + Math.sin(angle) * 120,
  };
}

function metadataPath(node: CompanyBrainNode): string | null {
  const value = node.metadata?.path;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parentPath(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function nodeGroupLabel(type: CompanyBrainNode["type"]): string {
  switch (type) {
    case "memory_item":
      return "Memories";
    case "memory_asset":
    case "artifact":
      return "Artifacts";
    case "goal":
      return "Goals";
    case "task":
      return "Tasks";
    case "agent":
      return "Agents";
    case "human":
      return "Humans";
    default:
      return nodeTypeLabel(type);
  }
}

function buildFolderDatum(
  folder: CompanyBrainNode,
  foldersByPath: Map<string, CompanyBrainNode>,
): ClusterDatum {
  const path = metadataPath(folder) ?? folder.label;
  const children = Array.from(foldersByPath.values())
    .filter((candidate) => parentPath(metadataPath(candidate) ?? "") === path)
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((child) => buildFolderDatum(child, foldersByPath));

  return {
    key: nodeKey(folder),
    name: folder.label,
    type: folder.type,
    node: folder,
    children: children.length > 0 ? children : undefined,
  };
}

function buildClusterData(graph: CompanyBrainOverviewResponse): ClusterDatum {
  const folders = graph.nodes.filter((node) => node.type === "memory_folder");
  const foldersByPath = new Map(
    folders.flatMap((node) => {
      const path = metadataPath(node);
      return path ? [[path, node] as const] : [];
    }),
  );
  const consumedFolderPaths = new Set<string>();
  const departments = graph.nodes
    .filter((node) => node.type === "department")
    .sort((a, b) => a.label.localeCompare(b.label));

  const departmentBranches = departments.map((department) => {
    const children = Array.from(foldersByPath.entries())
      .filter(([path]) => parentPath(path) === department.label)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, folder]) => {
        consumedFolderPaths.add(path);
        return buildFolderDatum(folder, foldersByPath);
      });

    return {
      key: nodeKey(department),
      name: department.label,
      type: department.type,
      node: department,
      children: children.length > 0 ? children : undefined,
    };
  });

  const companyFolderBranches = Array.from(foldersByPath.entries())
    .filter(([path]) => !consumedFolderPaths.has(path) && parentPath(path) === "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, folder]) => buildFolderDatum(folder, foldersByPath));

  const structuralKeys = new Set<string>([
    ...folders.map((folder) => nodeKey(folder)),
    ...departments.map((department) => nodeKey(department)),
  ]);
  const groupedNodes = new Map<CompanyBrainNode["type"], CompanyBrainNode[]>();
  for (const node of graph.nodes) {
    if (structuralKeys.has(nodeKey(node))) continue;
    groupedNodes.set(node.type, [...(groupedNodes.get(node.type) ?? []), node]);
  }

  const extraBranches = Array.from(groupedNodes.entries())
    .sort(([a], [b]) => nodeGroupLabel(a).localeCompare(nodeGroupLabel(b)))
    .map(([type, nodes]) => ({
      key: `group:${type}`,
      name: nodeGroupLabel(type),
      type,
      children: nodes
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((node) => ({
          key: nodeKey(node),
          name: node.label,
          type: node.type,
          node,
        })),
    }));

  return {
    key: "root",
    name: "Company map",
    children: [
      ...companyFolderBranches,
      ...departmentBranches,
      ...extraBranches,
    ],
  };
}

function clusterNodeWeight(datum: ClusterDatum): number {
  if (!datum.node) return 0.35;
  if (datum.node.type === "department") return 2.2;
  if (datum.node.type === "memory_folder" && datum.children?.length) return 1.8;
  if (datum.node.type === "memory_folder") return 1.15;
  if (datum.node.type === "memory_item") return 0.95;
  return 0.8;
}

function clusterPadding(circle: ClusterCircle): number {
  if (circle.depth <= 1) return 16;
  if (circle.children?.length) return 12;
  return 5;
}

function truncateClusterLabel(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(1, maxChars - 1))}...`;
}

function shouldShowClusterLabel(
  circle: ClusterCircle,
  focusedCircle: ClusterCircle | null,
  viewScale: number,
): boolean {
  const hasChildren = Boolean(circle.children?.length);
  const isTopContainer = circle.depth <= 1;
  const isDirectChild = circle.depth === 2;
  const isFocusedCircle = circle.data.key === focusedCircle?.data.key;
  const isFocusedChild = Boolean(focusedCircle)
    && circle.parent?.data.key === focusedCircle?.data.key;
  const screenRadius = circle.r / viewScale;

  if (focusedCircle) {
    if (isFocusedCircle) return true;
    if (isFocusedChild) return screenRadius > 8;
    return false;
  }

  if (isTopContainer) return screenRadius > 30;
  if (hasChildren && screenRadius > 24) return true;
  if (isDirectChild && screenRadius > 12) return true;
  return false;
}

function clusterLabelFor(
  circle: ClusterCircle,
  focusedCircle: ClusterCircle | null,
  viewScale: number,
): ClusterLabel | null {
  if (!shouldShowClusterLabel(circle, focusedCircle, viewScale)) return null;
  const hasChildren = Boolean(circle.children?.length);
  const screenRadius = circle.r / viewScale;
  const maxChars = hasChildren
    ? Math.max(10, Math.floor(screenRadius / 3.1))
    : Math.max(8, Math.floor(screenRadius / 2.1));
  const tone = circle.depth <= 1 ? "major" : hasChildren ? "minor" : "tiny";
  const baseFontSize = tone === "major" ? 13 : tone === "minor" ? 11 : 10;

  return {
    key: `label:${circle.data.key}`,
    name: truncateClusterLabel(circle.data.name, maxChars),
    x: circle.x,
    y: hasChildren ? circle.y - circle.r - (7 * viewScale) : circle.y + circle.r + (11 * viewScale),
    anchor: "middle",
    tone,
    fontSize: baseFontSize * viewScale,
  };
}

function useZoomableSvg() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const contentRef = useRef<SVGGElement | null>(null);

  useEffect(() => {
    if (!svgRef.current || !contentRef.current) return;
    const svg = select(svgRef.current);
    const content = select(contentRef.current);
    const behavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.45, 4])
      .on("zoom", (event) => {
        content.attr("transform", event.transform.toString());
      });

    svg.call(behavior);
    return () => {
      svg.on(".zoom", null);
    };
  }, []);

  return { svgRef, contentRef };
}

export function CompanyGraphNetworkView({ graph, onOpenGraphNode }: CompanyGraphD3ViewProps) {
  const { svgRef, contentRef } = useZoomableSvg();
  const layout = useMemo(() => {
    const nodes: LayoutNode[] = graph.nodes.map((node) => ({
      key: nodeKey(node),
      label: node.label,
      type: node.type,
    }));
    const links: LayoutLink[] = graph.edges.map((edge) => ({
      source: nodeKey(edge.from),
      target: nodeKey(edge.to),
    }));

    const simulation = forceSimulation<LayoutNode>(nodes)
      .force("link", forceLink<LayoutNode, LayoutLink>(links).id((node) => node.key).distance(90))
      .force("charge", forceManyBody().strength(-180))
      .force("collide", forceCollide<LayoutNode>().radius(24))
      .force("center", forceCenter(WIDTH / 2, HEIGHT / 2))
      .stop();

    for (let i = 0; i < 120; i += 1) simulation.tick();
    simulation.stop();

    return { nodes, links };
  }, [graph]);

  const nodesByKey = new Map(layout.nodes.map((node) => [node.key, node]));

  return (
    <section
      className="h-full min-h-0 overflow-hidden rounded-md border border-border bg-card text-text"
      data-testid="company-graph-network-view"
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="Network graph view"
        preserveAspectRatio="xMidYMid meet"
        className="h-full min-h-0 w-full cursor-grab bg-background text-text active:cursor-grabbing"
        data-testid="company-graph-network-svg"
      >
        <g ref={contentRef}>
          {layout.links.map((link, index) => {
            const sourceKey = typeof link.source === "string" ? link.source : link.source.key;
            const targetKey = typeof link.target === "string" ? link.target : link.target.key;
            const source = nodesByKey.get(sourceKey);
            const target = nodesByKey.get(targetKey);
            if (!source || !target) return null;
            const s = coordinates(source, index, layout.nodes.length);
            const t = coordinates(target, index + 1, layout.nodes.length);
            return (
              <line
                key={`${sourceKey}-${targetKey}-${index}`}
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
                stroke={graphEdgeColor("derived")}
                strokeWidth="1.4"
                opacity="0.82"
              />
            );
          })}
          {layout.nodes.map((node, index) => {
            const point = coordinates(node, index, layout.nodes.length);
            const sourceNode = graph.nodes.find((candidate) => nodeKey(candidate) === node.key);
            return (
              <g
                key={node.key}
                transform={`translate(${point.x} ${point.y})`}
                className={sourceNode ? "cursor-pointer" : undefined}
                onClick={() => sourceNode && onOpenGraphNode?.(sourceNode)}
              >
                <circle r={node.type === "memory_item" ? 10 : 8} fill={graphNodeColor(node.type)} />
                <text
                  x="14"
                  y="4"
                  fill="currentColor"
                  className="text-[11px]"
                >
                  {node.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </section>
  );
}

export function CompanyGraphClusterView({ graph, onOpenGraphNode }: CompanyGraphD3ViewProps) {
  const { svgRef, contentRef } = useZoomableSvg();
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const circles = useMemo(() => {
    const root = pack<ClusterDatum>()
      .size([WIDTH, HEIGHT])
      .padding((circle) => clusterPadding(circle as ClusterCircle))(
        hierarchy(buildClusterData(graph))
          .sum(clusterNodeWeight)
          .sort((a, b) => (b.value ?? 0) - (a.value ?? 0)),
      );

    return root.descendants();
  }, [graph]);
  const focusedCircle = focusedKey
    ? circles.find((circle) => circle.data.key === focusedKey) ?? null
    : null;
  const selectedCircle = selectedKey
    ? circles.find((circle) => circle.data.key === selectedKey) ?? null
    : null;
  const focusedViewBoxWidth = focusedCircle ? (focusedCircle.r + 20) * 2 : WIDTH;
  const labelViewScale = focusedViewBoxWidth / WIDTH;
  const viewBox = focusedCircle
    ? `${focusedCircle.x - focusedCircle.r - 20} ${focusedCircle.y - focusedCircle.r - 20} ${focusedViewBoxWidth} ${focusedViewBoxWidth}`
    : ROOT_VIEW_BOX;
  const labeledCircles = circles
    .slice(1)
    .map((circle) => clusterLabelFor(circle, focusedCircle, labelViewScale))
    .filter((label): label is ClusterLabel => Boolean(label));

  return (
    <section
      className="relative h-full min-h-0 overflow-hidden rounded-md border border-border bg-card text-text"
      data-testid="company-graph-cluster-view"
    >
      {focusedCircle && (
        <button
          type="button"
          className="absolute left-3 top-3 z-10 rounded-md border border-border bg-card/90 px-2 py-1 text-[11px] font-medium text-text shadow-sm transition-colors hover:bg-muted"
          onClick={() => setFocusedKey(null)}
        >
          Show full cluster map
        </button>
      )}
      {selectedCircle && (
        <div
          className="absolute bottom-3 left-3 z-10 max-w-[min(260px,calc(100%-24px))] rounded-md border border-border bg-card/95 px-3 py-2 text-[11px] shadow-lg"
          data-testid="company-graph-cluster-selection"
        >
          <div className="font-medium text-text">{selectedCircle.data.name}</div>
          <div className="mt-0.5 text-dim">
            {nodeTypeLabel(selectedCircle.data.type ?? "memory_item")}
          </div>
        </div>
      )}
      <svg
        ref={svgRef}
        viewBox={viewBox}
        role="img"
        aria-label="Cluster graph view"
        preserveAspectRatio="xMidYMid meet"
        className="h-full min-h-0 w-full cursor-grab bg-background text-text active:cursor-grabbing"
        data-testid="company-graph-cluster-svg"
      >
        <g ref={contentRef}>
          {circles.slice(1).map((circle) => {
            const hasChildren = Boolean(circle.children?.length);
            const isLeaf = Boolean(circle.data.node) && !hasChildren;
            const color = graphNodeColor(circle.data.type ?? "memory_item");
            const ariaLabel = hasChildren
              ? `Zoom into ${circle.data.name}`
              : circle.data.node
                ? `Open ${circle.data.name}`
                : circle.data.name;
            return (
              <g
                key={circle.data.key}
                transform={`translate(${circle.x} ${circle.y})`}
                role={hasChildren || circle.data.node ? "button" : undefined}
                aria-label={hasChildren || circle.data.node ? ariaLabel : undefined}
                tabIndex={hasChildren || circle.data.node ? 0 : undefined}
                className={hasChildren || circle.data.node ? "cursor-pointer outline-none" : undefined}
                onMouseEnter={() => setSelectedKey(circle.data.key)}
                onFocus={() => setSelectedKey(circle.data.key)}
                onClick={() => {
                  setSelectedKey(circle.data.key);
                  if (hasChildren) {
                    setFocusedKey(circle.data.key);
                    return;
                  }
                  if (circle.data.node) onOpenGraphNode?.(circle.data.node);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  setSelectedKey(circle.data.key);
                  if (hasChildren) {
                    setFocusedKey(circle.data.key);
                    return;
                  }
                  if (circle.data.node) onOpenGraphNode?.(circle.data.node);
                }}
              >
                <circle
                  r={circle.r}
                  fill={color}
                  fillOpacity={isLeaf ? 0.9 : 0.16}
                  stroke={color}
                  strokeOpacity={isLeaf ? 0 : 0.48}
                  strokeWidth={isLeaf ? 0 : 1.2}
                />
              </g>
            );
          })}
          {labeledCircles.map((label) => (
            <text
              key={label.key}
              x={label.x}
              y={label.y}
              textAnchor={label.anchor}
              fill="currentColor"
              fontSize={label.fontSize}
              className={
                label.tone === "major"
                  ? "pointer-events-none font-semibold"
                  : label.tone === "minor"
                    ? "pointer-events-none font-medium"
                    : "pointer-events-none"
              }
            >
              {label.name}
            </text>
          ))}
        </g>
      </svg>
    </section>
  );
}
