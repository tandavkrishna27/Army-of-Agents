import { useRef, useState, useMemo, useCallback, useEffect } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import type { UnifiedOrgNode, TeamInviteSummary } from "@armyofagents/shared";
import { AgentIcon } from "../AgentIconPicker";
import { adapterLabels, roleLabels } from "../agent-config-primitives";
import { teamsApi } from "../../api/teams";
import { useCompany } from "../../context/CompanyContext";
import { queryKeys } from "../../lib/queryKeys";
import { agentStatusDotHex, agentStatusDotHexDefault } from "../../lib/status-colors";
import { getInitials } from "../../lib/initials";
import { TeamOrgOverlay } from "./TeamOrgOverlay";
import { computeTeamBoxes, type LaidOutCard } from "./teamBoundingBox";
import { Network, MoreVertical, Plus, Minus, Maximize2, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { ClickableDiv } from "../ui/clickable-div";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Layout constants
const CARD_W = 200;
const CARD_H = 100;
// Sibling gap is widened from the historical 32 to 64 so that two
// sibling subtrees that happen to lead different teams (e.g. Maya and
// Alice both reporting to TK, each leading their own team) get a
// visible margin between their overlay boxes. Math: gap between two
// adjacent team boxes = GAP_X - 2 × overlay PADDING (16) = 32 px.
const GAP_X = 64;
// Root-level gap is wider still so adjacent root subtrees get extra
// breathing room. Math: ROOT_GAP_X - 2 × overlay PADDING (16) = 48 px.
const ROOT_GAP_X = 80;
const GAP_Y = 80;
const PADDING = 60;

// ── Layout types ────────────────────────────────────────────────────────

interface LayoutNode {
  id: string;
  nodeType: "agent" | "user" | "ghost";
  name: string;
  role: string;
  status: string;
  // Agent fields
  adapterType?: string;
  icon?: string;
  pendingApproval?: boolean;
  // Hierarchy — needed by the org-tree UI to compute the apex CXO
  // (Chief of Staff badge): role==='cxo' && parentType in ('user', null).
  parentType?: "agent" | "user" | null;
  // User fields
  avatarUrl?: string;
  userRole?: string;
  departmentName?: string;
  // Ghost (pending invite) fields
  isGhost?: boolean;
  inviteId?: string;
  // Position
  x: number;
  y: number;
  children: LayoutNode[];
}

export type OrgNodeAction =
  | { type: "view-profile"; userId: string }
  | { type: "view-agent"; agentId: string }
  | { type: "change-role"; userId: string }
  | { type: "change-reports-to"; agentId: string }
  | { type: "remove"; userId: string }
  | { type: "resend-invite"; inviteId: string }
  | { type: "revoke-invite"; inviteId: string };

// ── Layout algorithm — sole owner of the org-tree rendering ──────────────

function subtreeWidth(node: UnifiedOrgNode): number {
  if (node.children.length === 0) return CARD_W;
  const childrenW = node.children.reduce((sum: number, c: UnifiedOrgNode) => sum + subtreeWidth(c), 0);
  const gaps = (node.children.length - 1) * GAP_X;
  return Math.max(CARD_W, childrenW + gaps);
}

function layoutTree(node: UnifiedOrgNode, x: number, y: number): LayoutNode {
  const totalW = subtreeWidth(node);
  const layoutChildren: LayoutNode[] = [];

  if (node.children.length > 0) {
    const childrenW = node.children.reduce((sum: number, c: UnifiedOrgNode) => sum + subtreeWidth(c), 0);
    const gaps = (node.children.length - 1) * GAP_X;
    let cx = x + (totalW - childrenW - gaps) / 2;

    for (const child of node.children) {
      const cw = subtreeWidth(child);
      layoutChildren.push(layoutTree(child, cx, y + CARD_H + GAP_Y));
      cx += cw + GAP_X;
    }
  }

  return {
    id: node.id,
    nodeType: node.nodeType,
    name: node.name,
    role: node.role,
    status: node.status,
    adapterType: node.adapterType,
    icon: node.icon,
    pendingApproval: node.pendingApproval,
    parentType: node.parentType ?? null,
    avatarUrl: node.avatarUrl,
    userRole: node.userRole,
    departmentName: node.departmentName,
    x: x + (totalW - CARD_W) / 2,
    y,
    children: layoutChildren,
  };
}

function layoutForest(roots: UnifiedOrgNode[]): LayoutNode[] {
  if (roots.length === 0) return [];
  let x = PADDING;
  const y = PADDING;
  const result: LayoutNode[] = [];
  for (const root of roots) {
    const w = subtreeWidth(root);
    result.push(layoutTree(root, x, y));
    // Use ROOT_GAP_X (not GAP_X) between root subtrees so adjacent team
    // overlay boxes have visible space between them. Siblings within a
    // subtree still use GAP_X via `subtreeWidth` / `layoutTree`.
    x += w + ROOT_GAP_X;
  }
  return result;
}

function flattenLayout(nodes: LayoutNode[]): LayoutNode[] {
  const result: LayoutNode[] = [];
  function walk(n: LayoutNode) {
    result.push(n);
    n.children.forEach(walk);
  }
  nodes.forEach(walk);
  return result;
}

function collectEdges(nodes: LayoutNode[]): Array<{ parent: LayoutNode; child: LayoutNode }> {
  const edges: Array<{ parent: LayoutNode; child: LayoutNode }> = [];
  function walk(n: LayoutNode) {
    for (const c of n.children) {
      edges.push({ parent: n, child: c });
      walk(c);
    }
  }
  nodes.forEach(walk);
  return edges;
}

// ── Status dot colors ────────────────────────────────────────────────────
// Sourced from the shared status-colors module so the canvas (inline-style)
// and the agents grid (Tailwind class) stay in sync.

// ── Team overlay colors ──────────────────────────────────────────────────
//
// Stable team-overlay color palette. Keying by hash of `team.id` (rather
// than list position) means adding/removing teams doesn't recolor the
// others — adding/removing one team would otherwise shuffle every other
// team's color, which founders find visually jarring.

const TEAM_COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];

function hashStringToInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

const ROLE_LABELS: Record<string, string> = {
  founder: "Founder",
  team_lead: "Team Lead",
  team_member: "Member",
};

// ── Component ────────────────────────────────────────────────────────────

export interface OrgTreeTabProps {
  orgTree: UnifiedOrgNode[];
  pendingInvites?: TeamInviteSummary[];
  onNodeClick: (id: string, nodeType: "agent" | "user") => void;
  onNodeAction?: (action: OrgNodeAction) => void;
}

function mergeGhostNodes(orgTree: UnifiedOrgNode[], pendingInvites: TeamInviteSummary[]): UnifiedOrgNode[] {
  if (pendingInvites.length === 0) return orgTree;

  const ghostNodes: UnifiedOrgNode[] = [];
  const parentedGhosts = new Map<string, UnifiedOrgNode[]>();

  for (const invite of pendingInvites) {
    const ghost: UnifiedOrgNode = {
      id: `ghost-${invite.id}`,
      name: invite.email ?? "Pending invite",
      role: invite.role,
      status: "pending",
      nodeType: "user",
      userRole: invite.role as "founder" | "team_lead" | "team_member",
      departmentName: invite.departmentName ?? undefined,
      children: [],
    };

    if (invite.reportsToId) {
      const existing = parentedGhosts.get(invite.reportsToId) ?? [];
      existing.push(ghost);
      parentedGhosts.set(invite.reportsToId, existing);
    } else {
      ghostNodes.push(ghost);
    }
  }

  // Deep clone and inject parented ghosts
  function injectGhosts(node: UnifiedOrgNode): UnifiedOrgNode {
    const children = node.children.map(injectGhosts);
    const ghosts = parentedGhosts.get(node.id) ?? [];
    return { ...node, children: [...children, ...ghosts] };
  }

  return [...orgTree.map(injectGhosts), ...ghostNodes];
}

export function OrgTreeTab({ orgTree, pendingInvites, onNodeClick, onNodeAction }: OrgTreeTabProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  const mergedTree = useMemo(
    () => mergeGhostNodes(orgTree, pendingInvites ?? []),
    [orgTree, pendingInvites],
  );
  const layout = useMemo(() => layoutForest(mergedTree), [mergedTree]);
  const allNodes = useMemo(() => flattenLayout(layout), [layout]);
  const edges = useMemo(() => collectEdges(layout), [layout]);

  // ── Team overlay data ────────────────────────────────────────────────
  //
  // Each team draws as a dashed bounding box around its members. We fetch
  // teams and their member rosters separately because `teamsApi.list`
  // doesn't include members. `useQueries` scales with team count; both
  // requests are cheap and read-only.
  //
  // Ghost (pending-invite) nodes use `ghost-...` ids that are never on a
  // real `team_members` row, so `computeTeamBoxes` filters them out
  // implicitly — no extra ghost handling needed here.
  const { selectedCompanyId } = useCompany();

  const teamsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.teams.list(selectedCompanyId)
      : ["teams", "none"],
    queryFn: () => teamsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const teamItems = useMemo(
    () => teamsQuery.data?.items ?? [],
    [teamsQuery.data],
  );

  const memberQueries = useQueries({
    queries: teamItems.map((t) => ({
      queryKey: selectedCompanyId
        ? queryKeys.teams.members(selectedCompanyId, t.id)
        : ["teams", "none", t.id, "members"],
      queryFn: () => teamsApi.listMembers(t.id),
      enabled: Boolean(selectedCompanyId),
    })),
  });

  // Stable signature for memberships memo: `useQueries` returns a fresh
  // array every render, so depending on it directly defeats the memo (new
  // Map built each render). Depending on each query's `dataUpdatedAt`
  // means we only rebuild the Map when underlying data actually changes.
  const memberQueriesSignature = memberQueries
    .map((q) => q.dataUpdatedAt)
    .join(",");

  const memberships = useMemo(() => {
    const m = new Map<string, string>();
    teamItems.forEach((t, idx) => {
      const members = memberQueries[idx]?.data?.items ?? [];
      for (const mem of members) m.set(mem.agentId, t.id);
    });
    return m;
    // memberQueriesSignature captures the meaningful identity of memberQueries.
    // Listing memberQueries directly would churn this memo on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamItems, memberQueriesSignature]);

  const teamMetas = useMemo(
    () =>
      teamItems.map((t) => ({
        id: t.id,
        name: t.name,
        color: TEAM_COLORS[hashStringToInt(t.id) % TEAM_COLORS.length]!,
      })),
    [teamItems],
  );

  const teamBoxes = useMemo(() => {
    const cards: LaidOutCard[] = allNodes.map((n) => ({
      agentId: n.id,
      x: n.x,
      y: n.y,
      w: CARD_W,
      h: CARD_H,
    }));
    return computeTeamBoxes(cards, memberships, teamMetas);
  }, [allNodes, memberships, teamMetas]);

  const bounds = useMemo(() => {
    if (allNodes.length === 0) return { width: 800, height: 600 };
    let maxX = 0;
    let maxY = 0;
    for (const n of allNodes) {
      maxX = Math.max(maxX, n.x + CARD_W);
      maxY = Math.max(maxY, n.y + CARD_H);
    }
    return { width: maxX + PADDING, height: maxY + PADDING };
  }, [allNodes]);

  // Center chart on first load
  const hasInitialized = useRef(false);
  useEffect(() => {
    if (hasInitialized.current || allNodes.length === 0 || !containerRef.current) return;
    hasInitialized.current = true;

    const container = containerRef.current;
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;

    const scaleX = (containerW - 40) / bounds.width;
    const scaleY = (containerH - 40) / bounds.height;
    const fitZoom = Math.min(scaleX, scaleY, 1);

    const chartW = bounds.width * fitZoom;
    const chartH = bounds.height * fitZoom;

    setZoom(fitZoom);
    setPan({
      x: (containerW - chartW) / 2,
      y: (containerH - chartH) / 2,
    });
  }, [allNodes, bounds]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest("[data-org-card]")) return;
      setDragging(true);
      dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    },
    [pan],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return;
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      setPan({ x: dragStart.current.panX + dx, y: dragStart.current.panY + dy });
    },
    [dragging],
  );

  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const newZoom = Math.min(Math.max(zoom * factor, 0.2), 2);

      const scale = newZoom / zoom;
      setPan({
        x: mouseX - scale * (mouseX - pan.x),
        y: mouseY - scale * (mouseY - pan.y),
      });
      setZoom(newZoom);
    },
    [zoom, pan],
  );

  const zoomTo = useCallback(
    (factor: number) => {
      const newZoom = Math.min(Math.max(zoom * factor, 0.2), 2);
      const container = containerRef.current;
      if (container) {
        const cx = container.clientWidth / 2;
        const cy = container.clientHeight / 2;
        const scale = newZoom / zoom;
        setPan({ x: cx - scale * (cx - pan.x), y: cy - scale * (cy - pan.y) });
      }
      setZoom(newZoom);
    },
    [zoom, pan],
  );

  const fitToScreen = useCallback(() => {
    if (!containerRef.current) return;
    const cW = containerRef.current.clientWidth;
    const cH = containerRef.current.clientHeight;
    const scaleX = (cW - 40) / bounds.width;
    const scaleY = (cH - 40) / bounds.height;
    const fitZoom = Math.min(scaleX, scaleY, 1);
    const chartW = bounds.width * fitZoom;
    const chartH = bounds.height * fitZoom;
    setZoom(fitZoom);
    setPan({ x: (cW - chartW) / 2, y: (cH - chartH) / 2 });
  }, [bounds]);

  // Empty state
  if (orgTree.length === 0) {
    return (
      <div data-testid="org-tree-empty" className="py-20">
        <EmptyState
          icon={<Network />}
          title="Build your org"
          description="Add agents and invite teammates to build your org chart"
        />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="w-full h-[calc(100vh-12rem)] overflow-hidden relative bg-muted/20 border border-border rounded-lg"
      style={{ cursor: dragging ? "grabbing" : "grab" }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      data-testid="org-tree-canvas"
    >
      {/* Zoom controls */}
      <div className="absolute top-3 right-3 z-10 flex flex-col gap-1">
        <Button variant="outline" size="icon-xs" onClick={() => zoomTo(1.2)} aria-label="Zoom in">
          <Plus />
        </Button>
        <Button variant="outline" size="icon-xs" onClick={() => zoomTo(0.8)} aria-label="Zoom out">
          <Minus />
        </Button>
        <Button
          variant="outline"
          size="icon-xs"
          onClick={fitToScreen}
          title="Fit to screen"
          aria-label="Fit chart to screen"
        >
          <Maximize2 />
        </Button>
      </div>

      {/* SVG layer for edges */}
      <svg className="absolute inset-0 pointer-events-none" style={{ width: "100%", height: "100%" }}>
        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
          {edges.map(({ parent, child }) => {
            const x1 = parent.x + CARD_W / 2;
            const y1 = parent.y + CARD_H;
            const x2 = child.x + CARD_W / 2;
            const y2 = child.y;
            const midY = (y1 + y2) / 2;

            return (
              <path
                key={`${parent.id}-${child.id}`}
                d={`M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`}
                fill="none"
                stroke="var(--border)"
                strokeWidth={1.5}
              />
            );
          })}
        </g>
      </svg>

      {/* Card layer */}
      <div
        className="absolute inset-0"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: "0 0",
        }}
      >
        {/* Team overlay — render BEFORE the cards so the cards paint on
            top of the dashed framing box rather than the box covering the
            cards (later DOM siblings paint above earlier ones in normal
            stacking flow). */}
        <TeamOrgOverlay boxes={teamBoxes} />

        {allNodes.map((node) => {
          const isGhost = node.id.startsWith("ghost-");
          if (node.nodeType === "agent") {
            return <AgentNodeCard key={node.id} node={node} onClick={onNodeClick} onNodeAction={onNodeAction} />;
          }
          if (isGhost) {
            return <GhostNodeCard key={node.id} node={node} onNodeAction={onNodeAction} />;
          }
          return <HumanNodeCard key={node.id} node={node} onClick={onNodeClick} onNodeAction={onNodeAction} />;
        })}
      </div>
    </div>
  );
}

// ── Agent node card ──────────────────────────────────────────────────────

function AgentNodeCard({
  node,
  onClick,
  onNodeAction,
}: {
  node: LayoutNode;
  onClick: (id: string, nodeType: "agent" | "user") => void;
  onNodeAction?: (action: OrgNodeAction) => void;
}) {
  const dotColor = agentStatusDotHex[node.status] ?? agentStatusDotHexDefault;
  // Apex CXO = "Chief of Staff": a CXO-tier agent reporting either to a
  // human or to no one. Computed live from the role + parentType pair —
  // not stored on the agent. See plan
  // `docs/superpowers/plans/2026-04-30-agent-role-3-tier-cleanup.md`.
  const isChiefOfStaff =
    node.role === "cxo" && (node.parentType === "user" || node.parentType === null);

  return (
    <ClickableDiv
      data-org-card
      data-testid={`org-node-${node.id}`}
      data-node-type="agent"
      className={cn(
        "absolute bg-card border rounded-lg shadow-sm hover:shadow-md hover:border-foreground/20 transition-[box-shadow,border-color] duration-150 cursor-pointer select-none border-l-[3px] border-l-blue-400 group",
        node.pendingApproval && "opacity-50",
      )}
      style={{
        left: node.x,
        top: node.y,
        width: CARD_W,
        minHeight: CARD_H,
        borderTopColor: "var(--border)",
        borderRightColor: "var(--border)",
        borderBottomColor: "var(--border)",
      }}
      onClick={() => onClick(node.id, "agent")}
      aria-label={`View agent ${node.name}`}
    >
      {isChiefOfStaff && (
        <Badge
          variant="secondary"
          className="absolute -top-2.5 left-3 bg-amber-500 text-white border-0 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide shadow-sm gap-1"
          aria-label="Chief of Staff (apex executive)"
        >
          <Star className="h-2.5 w-2.5 fill-current" />
          Chief of Staff
        </Badge>
      )}
      <div className="flex items-center px-4 py-3 gap-3">
        <div className="relative shrink-0">
          <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center">
            <AgentIcon icon={node.icon} className="h-4.5 w-4.5 text-foreground/70" />
          </div>
          <span
            className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card"
            style={{ backgroundColor: dotColor }}
          />
        </div>
        <div className="flex flex-col items-start min-w-0 flex-1">
          <span className="text-sm font-semibold text-foreground leading-tight truncate w-full">
            {node.name}
          </span>
          <span className="text-[11px] text-muted-foreground leading-tight mt-0.5">
            {roleLabels[node.role] ?? node.role}
          </span>
          {node.adapterType && (
            <span className="text-[10px] text-muted-foreground/60 font-mono leading-tight mt-1">
              {adapterLabels[node.adapterType] ?? node.adapterType}
            </span>
          )}
        </div>
      </div>
      {node.pendingApproval && (
        <div className="px-4 pb-2">
          <span className="text-[10px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 px-1.5 py-0.5 rounded">
            Pending
          </span>
        </div>
      )}
      {onNodeAction && (
        <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="h-6 w-6 flex items-center justify-center rounded hover:bg-accent"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onClick={() => onNodeAction({ type: "view-agent", agentId: node.id })}>
                View Agent
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onNodeAction({ type: "change-reports-to", agentId: node.id })}>
                Change Reports-To
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </ClickableDiv>
  );
}

// ── Human node card ──────────────────────────────────────────────────────

function HumanNodeCard({
  node,
  onClick,
  onNodeAction,
}: {
  node: LayoutNode;
  onClick: (id: string, nodeType: "agent" | "user") => void;
  onNodeAction?: (action: OrgNodeAction) => void;
}) {
  return (
    <ClickableDiv
      data-org-card
      data-testid={`org-node-${node.id}`}
      data-node-type="user"
      className="absolute bg-card border rounded-lg shadow-sm hover:shadow-md hover:border-foreground/20 transition-[box-shadow,border-color] duration-150 cursor-pointer select-none border-l-[3px] border-l-green-400 group"
      style={{
        left: node.x,
        top: node.y,
        width: CARD_W,
        minHeight: CARD_H,
        borderTopColor: "var(--border)",
        borderRightColor: "var(--border)",
        borderBottomColor: "var(--border)",
      }}
      onClick={() => onClick(node.id, "user")}
      aria-label={`View team member ${node.name}`}
    >
      <div className="flex items-center px-4 py-3 gap-3">
        <div className="shrink-0">
          {node.avatarUrl ? (
            <img
              src={node.avatarUrl}
              alt={node.name}
              className="w-9 h-9 rounded-full object-cover"
            />
          ) : (
            <div className="w-9 h-9 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
              <span className="text-xs font-semibold text-green-700 dark:text-green-300">
                {getInitials(node.name)}
              </span>
            </div>
          )}
        </div>
        <div className="flex flex-col items-start min-w-0 flex-1">
          <span className="text-sm font-semibold text-foreground leading-tight truncate w-full">
            {node.name}
          </span>
          {node.userRole && (
            <span className="text-[11px] text-muted-foreground leading-tight mt-0.5">
              {ROLE_LABELS[node.userRole] ?? node.userRole}
            </span>
          )}
          {node.departmentName && (
            <span className="text-[10px] text-muted-foreground/60 leading-tight mt-1">
              {node.departmentName}
            </span>
          )}
        </div>
      </div>
      {onNodeAction && (
        <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="h-6 w-6 flex items-center justify-center rounded hover:bg-accent"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onClick={() => onNodeAction({ type: "view-profile", userId: node.id })}>
                View Profile
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onNodeAction({ type: "change-role", userId: node.id })}>
                Change Role
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => onNodeAction({ type: "remove", userId: node.id })}
              >
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </ClickableDiv>
  );
}

// ── Ghost (pending invite) node card ──────────────────────────────────────

function GhostNodeCard({
  node,
  onNodeAction,
}: {
  node: LayoutNode;
  onNodeAction?: (action: OrgNodeAction) => void;
}) {
  const inviteId = node.id.replace("ghost-", "");

  return (
    <div
      data-org-card
      data-testid={`org-node-${node.id}`}
      data-node-type="ghost"
      className="absolute border border-dashed rounded-lg opacity-50 select-none group"
      style={{
        left: node.x,
        top: node.y,
        width: CARD_W,
        minHeight: CARD_H,
        borderColor: "var(--border)",
      }}
    >
      <div className="flex items-center px-4 py-3 gap-3">
        <div className="shrink-0">
          <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center border border-dashed border-border">
            <span className="text-xs text-muted-foreground">?</span>
          </div>
        </div>
        <div className="flex flex-col items-start min-w-0 flex-1">
          <span className="text-sm font-medium text-muted-foreground leading-tight truncate w-full">
            {node.name}
          </span>
          {node.userRole && (
            <span className="text-[11px] text-muted-foreground/60 leading-tight mt-0.5">
              {ROLE_LABELS[node.userRole] ?? node.userRole}
            </span>
          )}
          <span className="text-[10px] font-medium bg-amber-100/60 text-amber-800/80 dark:bg-amber-900/20 dark:text-amber-300/60 px-1.5 py-0.5 rounded mt-1">
            Pending
          </span>
        </div>
      </div>
      {onNodeAction && (
        <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="h-6 w-6 flex items-center justify-center rounded hover:bg-accent"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onClick={() => onNodeAction({ type: "resend-invite", inviteId })}>
                Resend Invite
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => onNodeAction({ type: "revoke-invite", inviteId })}
              >
                Revoke Invite
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}
