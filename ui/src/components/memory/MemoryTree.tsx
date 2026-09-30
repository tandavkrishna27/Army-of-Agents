import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import {
  IdCard,
  Building2,
  Target,
  Zap,
  Home,
  Pin,
  Clock,
  Inbox,
  Archive,
  Folder,
  HardDrive,
  PanelLeftClose,
  type LucideIcon,
} from "lucide-react";
import type {
  MemoryFolderRecord,
  MemoryItem,
  Project,
  Goal,
} from "@armyofagents/shared";
import { memoryFoldersApi } from "../../api/memoryFolders";
import { memoryApi } from "../../api/memory";
import { projectsApi } from "../../api/projects";
import { goalsApi } from "../../api/goals";
import { filesystemApi, type FsBrowseEntry } from "../../api/filesystem";
import { queryKeys } from "../../lib/queryKeys";
import { LAYER_LABELS } from "../../lib/memoryItemView";
import { useCompany } from "../../context/CompanyContext";
import { FolderTreeNode } from "./FolderTreeNode";
import { Skeleton } from "@/components/ui/skeleton";
import { CreateFolderDialog } from "./CreateFolderDialog";
import { RenameFolderDialog } from "./RenameFolderDialog";
import { DeleteFolderDialog } from "./DeleteFolderDialog";
import { MemoryFolderActionsMenu, type MemoryFolderNodeKind } from "./MemoryFolderActionsMenu";

interface MemoryTreeProps {
  companyId: string;
  selectedFolderPath: string;
  selectedDepartmentId: string | null;
  selectedLayer: string | null;
  selectedGoalId: string | null;
  selectedLocalPath?: string | null;
  onToggleCollapse?: () => void;
}

interface TreeNode {
  key: string;
  label: string;
  Icon?: LucideIcon;       // Lucide component reference (layer headers + shortcuts)
  icon?: string;           // Emoji/string icon (folder nodes — user data, not migrated here)
  iconTone?: string;       // Inline color for the icon span (e.g. "var(--data-indigo)")
  count?: number;
  /** Count badge tone. "brand" wraps the count in a brand-red pill (used for Pending Review). */
  countTone?: "default" | "brand";
  /** Rolled-up count of pending (unapproved) items destined for this folder, incl. descendants. */
  pending?: number;
  depth: number;
  hasChildren: boolean;
  /** When set, click navigates here. When null, clicking only toggles expand. */
  target: { folder: string; dept: string | null; layer?: string; goal?: string; localPath?: string } | null;
  children?: TreeNode[];
  /** Optional soft-warn shown as a native browser tooltip on hover (e.g. deep-nesting). */
  tooltip?: string;
}

type LayerKey = "identity" | "domain" | "active_context" | "working";

// Icon + tone metadata for layer headers. Labels come from the canonical
// LAYER_LABELS map in `lib/memoryItemView.ts` so the tree, dashboard tiles,
// dialogs, and viewer all read the same string.
const LAYER_META: Record<LayerKey, { Icon: LucideIcon; tone: string }> = {
  identity: { Icon: IdCard, tone: "var(--data-indigo)" },
  domain: { Icon: Building2, tone: "var(--data-teal)" },
  active_context: { Icon: Target, tone: "var(--data-amber)" },
  working: { Icon: Zap, tone: "var(--data-magenta)" },
};

const DEFAULT_EXPANDED = new Set<string>([
  "__layer-identity",
  "__layer-domain",
  "__local",
]);

export function MemoryTree({
  companyId,
  selectedFolderPath,
  selectedDepartmentId,
  selectedLayer,
  selectedGoalId,
  selectedLocalPath,
  onToggleCollapse,
}: MemoryTreeProps) {
  const navigate = useNavigate();
  const { selectedCompany } = useCompany();
  const companyPrefix = selectedCompany?.issuePrefix ?? "";

  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(DEFAULT_EXPANDED),
  );

  // Phase 6.2b dialog state.
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createDialogParent, setCreateDialogParent] = useState<TreeNode | null>(null);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameDialogFolder, setRenameDialogFolder] = useState<MemoryFolderRecord | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteDialogFolder, setDeleteDialogFolder] = useState<MemoryFolderRecord | null>(null);

  const { data: folders, isLoading: foldersLoading } = useQuery({
    queryKey: queryKeys.memory.folders.list(companyId),
    queryFn: () => memoryFoldersApi.list(companyId),
  });

  const { data: projects, isLoading: projectsLoading } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });

  const { data: _listResponse } = useQuery({
    queryKey: queryKeys.memory.list(companyId),
    queryFn: () => memoryApi.list(companyId, {}),
    enabled: Boolean(companyId),
  });
  const items = _listResponse?.items;

  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(companyId),
    queryFn: () => goalsApi.list(companyId),
    enabled: Boolean(companyId),
  });

  const { data: localHome } = useQuery({
    queryKey: ["filesystem", "memory-local-home"],
    queryFn: () => filesystemApi.home(),
  });

  const companyRootFolder = selectedCompany?.rootFolder?.trim() ?? "";
  const defaultLocalPath = companyRootFolder || localHome?.homePath || "";
  const localBrowsePath = selectedLocalPath ?? defaultLocalPath;
  const { data: localBrowse } = useQuery({
    queryKey: ["filesystem", "memory-local-tree", localBrowsePath],
    queryFn: () => filesystemApi.browse(localBrowsePath, {
      gitAware: true,
      includeFiles: false,
    }),
    enabled: Boolean(localBrowsePath),
  });

  const departments = useMemo<Project[]>(
    () =>
      (projects ?? []).filter(
        (p: Project) => p.type === "department" && !p.archivedAt,
      ),
    [projects],
  );

  const counts = useMemo(() => {
    const all = (items ?? []) as Array<
      MemoryItem & {
        founderPinnedToTop?: boolean;
        layer?: LayerKey | null;
        departmentId?: string | null;
        goalId?: string | null;
      }
    >;
    const byLayer: Record<LayerKey, number> = {
      identity: 0,
      domain: 0,
      active_context: 0,
      working: 0,
    };
    const byDeptDomain = new Map<string, number>();
    const byGoalActive = new Map<string, number>();
    let pinned = 0;
    let pending = 0;
    let recent = 0;
    let archived = 0;
    const recentCutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    for (const it of all) {
      const isArchived = it.status === "archived";
      // Counts that drive the tree's "live" visibility — exclude archived items.
      if (!isArchived) {
        if (it.layer && it.layer in byLayer) byLayer[it.layer] += 1;
        if (it.layer === "domain" && it.departmentId) {
          byDeptDomain.set(it.departmentId, (byDeptDomain.get(it.departmentId) ?? 0) + 1);
        }
        if (it.layer === "active_context" && it.goalId) {
          byGoalActive.set(it.goalId, (byGoalActive.get(it.goalId) ?? 0) + 1);
        }
        if (it.founderPinnedToTop) pinned += 1;
        if (it.status === "pending") pending += 1;
      }
      // Archived shortcut count — unchanged (counts archived items intentionally).
      if (isArchived) archived += 1;
      // Recent count — already excludes archived in the filter.
      const updatedAtMs = new Date(it.updatedAt).getTime();
      if (Number.isFinite(updatedAtMs) && updatedAtMs >= recentCutoff && !isArchived) {
        recent += 1;
      }
    }
    return { byLayer, byDeptDomain, byGoalActive, pinned, pending, recent, archived };
  }, [items]);

  // Per-folder pending tally (rolled up across descendants), so a folder
  // accumulating agent-proposed knowledge shows a "N pending" badge even
  // before the founder drills into it. Same `items` the counts above iterate.
  const folderPendingCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const it of (items ?? []) as Array<MemoryItem & { folderPath?: string; status?: string }>) {
      if (it.status !== "pending") continue;
      const p = it.folderPath ?? "";
      if (!p) continue;
      map.set(p, (map.get(p) ?? 0) + 1);
    }
    return (path: string) => {
      let total = 0;
      for (const [itemPath, count] of map.entries()) {
        if (itemPath === path || itemPath.startsWith(path + "/")) {
          total += count;
        }
      }
      return total;
    };
  }, [items]);

  const activeGoals = useMemo<Goal[]>(
    () => (goals ?? []).filter((g) => g.status === "active"),
    [goals],
  );

  const tree = useMemo(
    () =>
      buildTree({
        folders: folders ?? [],
        departments,
        activeGoals,
        counts,
        folderPendingCounts,
        local: localBrowse
          ? {
              currentPath: localBrowse.currentPath,
              homePath: localHome?.homePath ?? localBrowse.homePath,
              rootPath: defaultLocalPath,
              entries: localBrowse.entries,
              selectedPath: selectedLocalPath ?? localBrowse.currentPath,
            }
          : defaultLocalPath
            ? {
                currentPath: defaultLocalPath,
                homePath: localHome?.homePath ?? "",
                rootPath: defaultLocalPath,
                entries: [],
                selectedPath: selectedLocalPath ?? defaultLocalPath,
              }
            : null,
      }),
    [
      folders,
      departments,
      activeGoals,
      counts,
      folderPendingCounts,
      localBrowse,
      localHome,
      selectedLocalPath,
      defaultLocalPath,
    ],
  );

  // Auto-expand the ancestor chain of the selected scope.
  useEffect(() => {
    if (!selectedFolderPath && !selectedDepartmentId && !selectedLocalPath) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (selectedLocalPath) {
        next.add("__local");
        next.add("__local-current");
      }
      // Domain dept selection -> expand Domain layer.
      if (selectedDepartmentId) {
        next.add("__layer-domain");
        next.add(`dept-${selectedDepartmentId}`);
      }
      // Active goal selection -> expand Active Context layer + that goal.
      // Goal selection shape: folder = "__goal-<goalId>".
      if (selectedFolderPath.startsWith("__goal-")) {
        next.add("__layer-active_context");
        next.add(selectedFolderPath);
      }
      // Layer selection -> expand that layer.
      if (selectedFolderPath.startsWith("__layer-")) {
        next.add(selectedFolderPath);
      }
      return next;
    });
  }, [selectedFolderPath, selectedDepartmentId, selectedLayer, selectedGoalId, selectedLocalPath]);

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectNode(node: TreeNode) {
    if (!node.target) {
      // No navigation; just toggle expansion (used for layer headers, etc.)
      toggleExpand(node.key);
      return;
    }
    // For nodes with children (layer headers), also toggle expansion on click.
    if (node.hasChildren) {
      toggleExpand(node.key);
    }
    const t = node.target;
    const params = new URLSearchParams();
    if (t.layer) params.set("layer", t.layer);
    if (t.folder) params.set("folder", t.folder);
    if (t.dept) params.set("dept", t.dept);
    if (t.goal) params.set("goal", t.goal);
    if (t.localPath) params.set("localPath", t.localPath);
    const search = params.toString();
    navigate(
      search
        ? `/${companyPrefix}/memory/explore?${search}`
        : `/${companyPrefix}/memory/explore`,
    );
  }

  function isSelected(target: TreeNode["target"]): boolean {
    if (!target) return false;
    return (
      (target.localPath ?? null) === (selectedLocalPath ?? null) &&
      (target.folder ?? "") === selectedFolderPath &&
      (target.dept ?? null) === selectedDepartmentId &&
      (target.layer ?? null) === selectedLayer &&
      (target.goal ?? null) === selectedGoalId
    );
  }

  // Phase 6.2b helpers — folder CRUD dialog open/close.

  function nodeToFolder(node: TreeNode): MemoryFolderRecord | null {
    if (!node.key.startsWith("folder-")) return null;
    const id = node.key.slice("folder-".length);
    return (folders ?? []).find((f) => f.id === id) ?? null;
  }

  function openCreate(node: TreeNode) {
    setCreateDialogParent(node);
    setCreateDialogOpen(true);
  }

  function openRename(node: TreeNode) {
    const f = nodeToFolder(node);
    if (!f) return;
    setRenameDialogFolder(f);
    setRenameDialogOpen(true);
  }

  function openDelete(node: TreeNode) {
    const f = nodeToFolder(node);
    if (!f) return;
    setDeleteDialogFolder(f);
    setDeleteDialogOpen(true);
  }

  function getParentPathForCreate(node: TreeNode | null): {
    path: string;
    departmentId: string | null;
    displayPath: string;
  } | null {
    if (!node) return null;
    // Folder node: use its own path as parent for the new subfolder.
    if (node.key.startsWith("folder-")) {
      const f = nodeToFolder(node);
      if (!f) return null;
      return {
        path: f.path,
        departmentId: f.departmentId,
        displayPath: f.path,
      };
    }
    // Department: parent path = dept slug, departmentId = node's dept id.
    if (node.key.startsWith("dept-") && !node.key.includes("-folder-")) {
      const deptId = node.key.slice("dept-".length);
      const dept = departments.find((d) => d.id === deptId);
      if (!dept) return null;
      return {
        path: dept.urlKey ?? "",
        departmentId: dept.id,
        displayPath: `Domain / ${dept.name}`,
      };
    }
    // Company root: parent path = "Company", departmentId = null.
    if (node.key === "__company") {
      return { path: "Company", departmentId: null, displayPath: "Identity / Company" };
    }
    // Goal: not yet supported for folder creation in v1.
    return null;
  }

  function getNodeKind(node: TreeNode): MemoryFolderNodeKind | null {
    // Layer headers: no kebab.
    if (node.key.startsWith("__layer-")) return null;
    // Cross-cutting shortcuts: no kebab.
    if (
      ["__home", "__pinned", "__pending", "__recent", "__archived"].includes(node.key)
    ) {
      return null;
    }
    // Active Context goal scope allows a new subfolder.
    // For v1 scope: show no kebab on goals (folders under goals not supported yet).
    if (node.key.startsWith("__goal-")) return null;
    // Department: scope
    if (node.key.startsWith("dept-") && !node.key.match(/^folder-/)) return "scope";
    // Company root: scope
    if (node.key === "__company") return "scope";
    // Folder rows (key starts with "folder-"): determine seeded vs user from the matching record.
    if (node.key.startsWith("folder-")) {
      const folderId = node.key.slice("folder-".length);
      const f = (folders ?? []).find((x) => x.id === folderId);
      if (!f) return null;
      return f.seedKey !== null ? "seededFolder" : "userFolder";
    }
    return null;
  }

  function renderNode(node: TreeNode): ReactNode {
    const isExpanded = expanded.has(node.key);
    const kind = getNodeKind(node);
    const actions =
      kind === null ? null : (
        <MemoryFolderActionsMenu
          nodeKind={kind}
          onCreate={() => openCreate(node)}
          onRename={() => openRename(node)}
          onChangeIcon={() => openRename(node)}
          onDelete={() => openDelete(node)}
        />
      );
    return (
      <div key={node.key} data-memory-tree-row={node.depth === 0 ? "top" : undefined}>
        <FolderTreeNode
          label={node.label}
          icon={node.Icon ?? node.icon}
          iconTone={node.iconTone}
          count={node.count}
          countTone={node.countTone}
          pendingCount={node.pending}
          depth={node.depth}
          expanded={isExpanded}
          selected={isSelected(node.target)}
          hasChildren={node.hasChildren}
          onToggleExpand={() => toggleExpand(node.key)}
          onSelect={() => selectNode(node)}
          actions={actions}
          tooltip={node.tooltip}
        />
        {isExpanded &&
          node.children &&
          node.children.map((child) => renderNode(child))}
      </div>
    );
  }

  const isLoading = foldersLoading || projectsLoading;

  return (
    <div className="h-full flex flex-col bg-card/50">
      <div
        className="flex h-[42px] shrink-0 items-center gap-2 border-b border-border px-3 text-[10px] uppercase tracking-wider text-muted-foreground"
        data-testid="memory-tree-header"
      >
        <span>Folders</span>
        {onToggleCollapse && (
          <button
            type="button"
            title="Collapse folders"
            aria-label="Collapse folders"
            onClick={onToggleCollapse}
            className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <PanelLeftClose className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-auto py-1">
        {isLoading ? (
          <div className="space-y-1 px-2 py-1">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-3/5" />
          </div>
        ) : (
          tree.map((node) => renderNode(node))
        )}
      </div>
      {/* Phase 6.2b dialogs */}
      {createDialogOpen && createDialogParent && (() => {
        const p = getParentPathForCreate(createDialogParent);
        if (!p) return null;
        return (
          <CreateFolderDialog
            companyId={companyId}
            open={createDialogOpen}
            onOpenChange={setCreateDialogOpen}
            parentPath={p.path}
            parentDisplayPath={p.displayPath}
            parentDepartmentId={p.departmentId}
          />
        );
      })()}
      {renameDialogFolder && (
        <RenameFolderDialog
          companyId={companyId}
          open={renameDialogOpen}
          onOpenChange={setRenameDialogOpen}
          folder={renameDialogFolder}
        />
      )}
      {deleteDialogFolder && (() => {
        const f = deleteDialogFolder;
        const parentPath = f.path.includes("/")
          ? f.path.slice(0, f.path.lastIndexOf("/"))
          : "";
        // Compute child counts for the confirmation message.
        const childItemCount = ((items ?? []) as Array<{ folderPath?: string }>)
          .filter(
            (it) =>
              it.folderPath === f.path ||
              (it.folderPath ?? "").startsWith(f.path + "/"),
          ).length;
        const childFolderCount = (folders ?? [])
          .filter((g) => g.path !== f.path && g.path.startsWith(f.path + "/"))
          .length;
        return (
          <DeleteFolderDialog
            companyId={companyId}
            open={deleteDialogOpen}
            onOpenChange={setDeleteDialogOpen}
            folder={f}
            parentDisplayPath={parentPath || "(root)"}
            childItemCount={childItemCount}
            childFolderCount={childFolderCount}
          />
        );
      })()}
    </div>
  );
}

interface BuildTreeArgs {
  folders: MemoryFolderRecord[];
  departments: Project[];
  activeGoals: Goal[];
  local: {
    currentPath: string;
    homePath: string;
    rootPath: string;
    selectedPath: string;
    entries: FsBrowseEntry[];
  } | null;
  counts: {
    byLayer: Record<LayerKey, number>;
    byDeptDomain: Map<string, number>;
    byGoalActive: Map<string, number>;
    pinned: number;
    pending: number;
    recent: number;
    archived: number;
  };
  /** Rolled-up pending-item tally for an arbitrary folder path (incl. descendants). */
  folderPendingCounts: (path: string) => number;
}

function buildTree({
  folders,
  departments,
  activeGoals,
  local,
  counts,
  folderPendingCounts,
}: BuildTreeArgs): TreeNode[] {
  const top: TreeNode[] = [];

  // Cross-cutting shortcuts at the top.
  top.push({
    key: "__home",
    label: "Home",
    Icon: Home,
    depth: 0,
    hasChildren: false,
    target: { folder: "", dept: null }, // empty params = home
  });
  top.push({
    key: "__pinned",
    label: "Pinned",
    Icon: Pin,
    count: counts.pinned > 0 ? counts.pinned : undefined,
    depth: 0,
    hasChildren: false,
    target: { folder: "__pinned", dept: null },
  });
  top.push({
    key: "__pending",
    label: "Pending Review",
    Icon: Inbox,
    iconTone: "var(--data-amber)",
    count: counts.pending > 0 ? counts.pending : undefined,
    countTone: "brand",
    depth: 0,
    hasChildren: false,
    target: { folder: "__pending", dept: null },
  });
  top.push({
    key: "__recent",
    label: "Recent",
    Icon: Clock,
    count: counts.recent > 0 ? counts.recent : undefined,
    depth: 0,
    hasChildren: false,
    target: { folder: "__recent", dept: null },
  });
  top.push({
    key: "__archived",
    label: "Archived",
    Icon: Archive,
    count: counts.archived > 0 ? counts.archived : undefined,
    depth: 0,
    hasChildren: false,
    target: { folder: "__archived", dept: null },
  });

  // Identity layer.
  const companyFolders = folders.filter((f) => f.departmentId === null);
  const companyRoot = companyFolders.find((f) => f.path === "Company");
  const identityChildren: TreeNode[] = [];
  if (companyRoot) {
    const companyChildren = buildFolderChildren({
      parentPath: "Company",
      allFolders: companyFolders,
      depth: 2,
      departmentId: null,
      folderPendingCounts,
    });
    identityChildren.push({
      key: "__company",
      label: companyRoot.displayName,
      icon: companyRoot.icon ?? "🏛️",
      depth: 1,
      hasChildren: companyChildren.length > 0,
      target: { folder: "Company", dept: null },
      children: companyChildren,
    });
  }
  top.push({
    key: "__layer-identity",
    label: LAYER_LABELS.identity,
    Icon: LAYER_META.identity.Icon,
    iconTone: LAYER_META.identity.tone,
    count: counts.byLayer.identity, // always show, even 0 — spec §3 "predictable structure"
    depth: 0,
    hasChildren: identityChildren.length > 0,
    target: { folder: "", dept: null, layer: "identity" },
    children: identityChildren,
  });

  // Domain layer (departments + their seeded subfolders + user folders).
  const deptFolderGroups = new Map<string, MemoryFolderRecord[]>();
  for (const f of folders) {
    if (f.departmentId !== null) {
      const arr = deptFolderGroups.get(f.departmentId) ?? [];
      arr.push(f);
      deptFolderGroups.set(f.departmentId, arr);
    }
  }
  const domainChildren: TreeNode[] = [];
  for (const dept of departments) {
    const slug = dept.urlKey ?? "";
    const deptCount = counts.byDeptDomain.get(dept.id) ?? 0;
    const deptFolders = deptFolderGroups.get(dept.id) ?? [];
    const children = buildFolderChildren({
      parentPath: slug,
      allFolders: deptFolders,
      depth: 2,
      departmentId: dept.id,
      folderPendingCounts,
    });

    domainChildren.push({
      key: `dept-${dept.id}`,
      label: dept.name,
      icon: "📁",
      count: deptCount, // always show, even 0
      depth: 1,
      hasChildren: children.length > 0,
      target: { folder: "", dept: dept.id },
      children,
    });
  }
  top.push({
    key: "__layer-domain",
    label: LAYER_LABELS.domain,
    Icon: LAYER_META.domain.Icon,
    iconTone: LAYER_META.domain.tone,
    count: counts.byLayer.domain, // always show, even 0
    depth: 0,
    hasChildren: domainChildren.length > 0,
    target: { folder: "", dept: null, layer: "domain" },
    children: domainChildren,
  });

  // Active Context layer (active goals only).
  const activeChildren: TreeNode[] = activeGoals.map<TreeNode>((g) => ({
    key: `__goal-${g.id}`,
    label: g.title,
    icon: "🎯",
    count: counts.byGoalActive.get(g.id) ?? 0, // always show, even 0
    depth: 1,
    hasChildren: false,
    target: { folder: `__goal-${g.id}`, dept: null, goal: g.id },
  }));
  top.push({
    key: "__layer-active_context",
    label: LAYER_LABELS.active_context,
    Icon: LAYER_META.active_context.Icon,
    iconTone: LAYER_META.active_context.tone,
    count: counts.byLayer.active_context, // always show, even 0
    depth: 0,
    hasChildren: activeChildren.length > 0,
    target: { folder: "", dept: null, layer: "active_context" },
    children: activeChildren,
  });

  // Working layer (flat — no children even when expanded).
  top.push({
    key: "__layer-working",
    label: LAYER_LABELS.working,
    Icon: LAYER_META.working.Icon,
    iconTone: LAYER_META.working.tone,
    count: counts.byLayer.working, // always show, even 0
    depth: 0,
    hasChildren: false,
    target: { folder: "", dept: null, layer: "working" },
  });

  top.push(buildLocalTreeNode(local));

  return top;
}

function localBaseName(value: string): string {
  const normalized = value.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? value;
}

function buildLocalTreeNode(local: BuildTreeArgs["local"]): TreeNode {
  const currentPath = local?.currentPath ?? "";
  const homePath = local?.homePath ?? "";
  const rootPath = local?.rootPath ?? "";
  const hasCompanyRoot = Boolean(rootPath && rootPath !== homePath);
  const directoryChildren: TreeNode[] = (local?.entries ?? [])
    .filter((entry) => entry.isDirectory)
    .slice(0, 30)
    .map((entry) => ({
      key: `__local-dir-${entry.path}`,
      label: entry.name,
      Icon: Folder,
      depth: 2,
      hasChildren: false,
      target: {
        folder: "",
        dept: null,
        localPath: entry.path,
      },
      tooltip: entry.path,
    }));

  const currentLabel = currentPath ? localBaseName(currentPath) : "Local files";
  const children: TreeNode[] = currentPath
    ? [
        {
          key: "__local-current",
          label: currentLabel,
          Icon: Folder,
          count: local?.entries.length,
          depth: 1,
          hasChildren: directoryChildren.length > 0,
          target: { folder: "", dept: null, localPath: currentPath },
          children: directoryChildren,
          tooltip: currentPath,
        },
      ]
    : [];

  if (!hasCompanyRoot && homePath && homePath !== currentPath) {
    children.unshift({
      key: "__local-home",
      label: "Home",
      Icon: Folder,
      depth: 1,
      hasChildren: false,
      target: { folder: "", dept: null, localPath: homePath },
      tooltip: homePath,
    });
  }

  return {
    key: "__local",
    label: "Local",
    Icon: HardDrive,
    depth: 0,
    hasChildren: children.length > 0,
    target: null,
    children,
    tooltip: hasCompanyRoot ? rootPath : undefined,
  };
}

function buildFolderChildren({
  parentPath,
  allFolders,
  depth,
  departmentId,
  folderPendingCounts,
}: {
  parentPath: string;
  allFolders: MemoryFolderRecord[];
  depth: number;
  departmentId: string | null;
  folderPendingCounts: (path: string) => number;
}): TreeNode[] {
  // Direct children: folders whose path is exactly `<parentPath>/<one-segment>`.
  const directChildren = allFolders.filter((f) => {
    if (!f.path.startsWith(parentPath + "/")) return false;
    const remainder = f.path.slice(parentPath.length + 1);
    return !remainder.includes("/");
  });

  return directChildren
    .sort((a, b) => {
      // Seeded folders first (preserves natural ordering), then user folders alphabetically.
      const aSeed = a.seedKey !== null;
      const bSeed = b.seedKey !== null;
      if (aSeed !== bSeed) return aSeed ? -1 : 1;
      if (aSeed) return a.sortOrder - b.sortOrder;
      return a.displayName.localeCompare(b.displayName);
    })
    .map<TreeNode>((f) => {
      const pendingCount = folderPendingCounts(f.path);
      return {
        key: `folder-${f.id}`,
        label: f.displayName,
        icon: f.icon ?? "📂",
        pending: pendingCount > 0 ? pendingCount : undefined,
        depth,
        hasChildren: false, // Filled in recursively below.
        target: { folder: f.path, dept: departmentId },
        tooltip:
          depth > 6 && f.seedKey === null
            ? "Deep nesting can make items hard to find — consider tags or splitting into a sibling folder"
            : undefined,
        children: buildFolderChildren({
          parentPath: f.path,
          allFolders,
          depth: depth + 1,
          departmentId,
          folderPendingCounts,
        }),
      };
    })
    .map((node) => ({
      ...node,
      hasChildren: (node.children?.length ?? 0) > 0,
    }));
}
