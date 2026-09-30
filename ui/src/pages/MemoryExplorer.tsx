import { useEffect, useMemo, useRef, useState } from "react";
import { NewMemoryItemDialog } from "../components/memory/NewMemoryItemDialog";
import { useSearchParams, useNavigate, Link } from "@/lib/router";
import { AlertCircle, Brain, Plus, Search, X } from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { Button } from "@/components/ui/button";
import { MemoryTree } from "../components/memory/MemoryTree";
import { MemoryFileList } from "../components/memory/MemoryFileList";
import { MemoryLocalFileList } from "../components/memory/MemoryLocalFileList";
import { MemoryViewer } from "../components/memory/MemoryViewer";
import { MemoryCollapsedTabStrip } from "../components/memory/MemoryCollapsedTabStrip";
import { MemoryFolderRail } from "../components/memory/MemoryFolderRail";
import { MemoryHomeDashboard } from "../components/memory/MemoryHomeDashboard";
import { MemoryUploadButton } from "../components/memory/MemoryUploadButton";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { canUploadInScope } from "../lib/memoryUploadScope";
import { useMemoryTabs } from "../hooks/useMemoryTabs";
import { useQuery } from "@tanstack/react-query";
import type { CompanyBrainNode } from "@armyofagents/shared";
import { memoryApi } from "../api/memory";
import { queryKeys } from "../lib/queryKeys";
import { deriveMemoryCounts, activeRailKindFromUrl, railKindToParams } from "../lib/memoryRail";
import { MEMORY_BRAIN_TAB, MEMORY_OPEN_TAB } from "../lib/memoryTabs";

export function MemoryExplorer() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs, setEntityColor, setSubtitle } = useBreadcrumbs();
  const [searchParams] = useSearchParams();

  const folderPath = searchParams.get("folder") ?? "";
  const departmentId = searchParams.get("dept") ?? null;
  const layer = searchParams.get("layer");
  const goalId = searchParams.get("goal");
  const localPath = searchParams.get("localPath");

  // Legacy URL params: ?item=X&type=Y deep-link support.
  const selectedItemId = searchParams.get("item");
  const selectedItemType = (
    searchParams.get("type") ?? (selectedItemId ? "memory_item" : null)
  ) as "memory_item" | "asset" | null;

  // Tab state — owned here, passed down to viewer + list.
  const { tabs, activeKey, openOrActivate, close, setActive } = useMemoryTabs();

  // Rail counts — derived from the flat items list (same query key as MemoryTree; cache hit).
  const { data: _listResponse } = useQuery({
    queryKey: queryKeys.memory.list(selectedCompanyId ?? ""),
    queryFn: () => memoryApi.list(selectedCompanyId!, {}),
    enabled: Boolean(selectedCompanyId),
  });
  const allItems = _listResponse?.items;
  const semanticAvailable = _listResponse?.semanticAvailable ?? true;
  const [semanticBannerDismissed, setSemanticBannerDismissed] = useState(false);
  const railCounts = useMemo(() => deriveMemoryCounts(allItems ?? []), [allItems]);
  const activeRailKind = activeRailKindFromUrl({ folderPath, departmentId, layer: layer ?? null });

  const navigate = useNavigate();
  const companyPrefix = selectedCompany?.issuePrefix ?? "";

  function openGraphNode(node: CompanyBrainNode) {
    if (node.type === "memory_item") {
      openOrActivate({ id: node.id, kind: "memory_item", title: node.label });
      setViewerCollapsed(false);
      viewerPanelRef.current?.expand();
      return;
    }

    if (node.type === "memory_asset") {
      openOrActivate({ id: node.id, kind: "asset", title: node.label });
      setViewerCollapsed(false);
      viewerPanelRef.current?.expand();
      return;
    }

    const href = node.href ?? "";
    if (!href) return;

    if (href.startsWith("/memory/explore")) {
      const hrefUrl = new URL(href, window.location.origin);
      const next = new URLSearchParams(searchParams.toString());
      for (const key of ["folder", "dept", "layer", "goal", "localPath", "item", "type"]) {
        next.delete(key);
      }
      hrefUrl.searchParams.forEach((value, key) => next.set(key, value));
      const search = next.toString();
      navigate(
        search
          ? `/${companyPrefix}/memory/explore?${search}`
          : `/${companyPrefix}/memory/explore`,
      );
      return;
    }

    if (href.startsWith("/")) {
      navigate(`/${companyPrefix}${href}`);
    }
  }

  // One-shot legacy migration: if URL has ?item=X&type=Y but no tabs yet, open it.
  useEffect(() => {
    if (selectedItemId && selectedItemType && tabs.length === 0) {
      openOrActivate({
        id: selectedItemId,
        kind: selectedItemType,
        title: selectedItemId, // fallback title; replaced once the viewer loads
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItemId, selectedItemType]);

  // Phase 6.2a: synthetic Home selection — no folder, no dept, no layer, no item.
  const isHomeSelected =
    !folderPath && !departmentId && !layer && !selectedItemId && !localPath;
  const selectedFileListType =
    activeKey?.kind === "memory_item" || activeKey?.kind === "asset"
      ? activeKey.kind
      : null;

  // Codex P1 round 2: only show the upload button in scopes where the
  // resulting asset is reachable from the central pane. Layer-only views and
  // virtual shortcuts (Pinned/Pending/Recent/Archived) suppress assets, so
  // an upload there would be invisible afterwards.
  const canUpload = canUploadInScope({
    folderPath,
    departmentId,
    layer,
  });

  const [searchQuery, setSearchQuery] = useState("");
  const [newItemOpen, setNewItemOpen] = useState(false);

  const treePanelRef = useRef<PanelImperativeHandle>(null);
  const viewerPanelRef = useRef<PanelImperativeHandle>(null);
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const [viewerCollapsed, setViewerCollapsed] = useState(false);
  // Tracks whether the tree was auto-collapsed when the viewer opened, so we
  // can restore it automatically when all tabs are closed (Option B interaction).
  const treeAutoCollapsedRef = useRef(false);
  const autoOpenedBrainCompanyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedCompanyId) return;
    if (!isHomeSelected) {
      autoOpenedBrainCompanyRef.current = null;
      return;
    }
    if (tabs.length > 0) return;
    if (autoOpenedBrainCompanyRef.current === selectedCompanyId) return;

    autoOpenedBrainCompanyRef.current = selectedCompanyId;
    openOrActivate(MEMORY_BRAIN_TAB);
    setViewerCollapsed(false);
    viewerPanelRef.current?.expand();
  }, [selectedCompanyId, isHomeSelected, tabs.length, openOrActivate]);

  // Collapse viewer when all tabs are closed; restore tree if we auto-collapsed it.
  const prevTabsLengthRef = useRef(tabs.length);
  useEffect(() => {
    const prev = prevTabsLengthRef.current;
    prevTabsLengthRef.current = tabs.length;
    if (tabs.length === 0 && prev > 0) {
      setViewerCollapsed(true);
      viewerPanelRef.current?.collapse();
      if (treeAutoCollapsedRef.current) {
        treeAutoCollapsedRef.current = false;
        setTreeCollapsed(false);
        treePanelRef.current?.expand();
      }
    }
  }, [tabs.length]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Memory" }, { label: "Explorer" }]);
    setEntityColor("var(--entity-memory)");
    return () => {
      setSubtitle(null);
      setEntityColor(null);
    };
  }, [setBreadcrumbs, setEntityColor, setSubtitle]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Brain} message="Select a company to view memory." />;
  }

  return (
    <div className="h-full flex flex-col">
      {/* No-key semantic search banner — embeddings key powers meaning-based recall. */}
      {!semanticAvailable && !semanticBannerDismissed && (
        <div
          data-testid="no-llm-key-banner"
          className="mx-2 mt-2 flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/[0.08] px-4 py-3 text-sm"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden />
          <div className="flex-1 text-muted-foreground">
            <span className="font-medium text-foreground">Semantic search is off</span>
            {" — add an embeddings key in "}
            <Link
              to="/settings?tab=memory"
              className="font-medium text-foreground underline hover:no-underline"
            >
              Settings → Memory
            </Link>
            {" to enable meaning-based memory recall."}
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setSemanticBannerDismissed(true)}
            className="ml-2 shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
      <Group
        orientation="horizontal"
        id="memory-explorer-panes"
        className="flex-1 min-h-0 gap-2 overflow-hidden bg-muted/30 p-2"
      >
        <Panel
          id="memory-explorer-tree"
          defaultSize={isHomeSelected ? "18%" : "20%"}
          minSize="12%"
          maxSize="35%"
          collapsible
          collapsedSize="3%"
          panelRef={treePanelRef}
          onResize={(size) => setTreeCollapsed(size.asPercentage <= 4)}
          className="min-w-0 h-full overflow-hidden"
        >
          <div
            className="h-full overflow-hidden rounded-xl border border-border bg-background shadow-sm"
            data-testid="memory-tree-shell"
          >
            {treeCollapsed ? (
              <MemoryFolderRail
                counts={railCounts}
                activeKind={activeRailKind}
                onExpand={() => {
                  setTreeCollapsed(false);
                  treePanelRef.current?.expand();
                  treeAutoCollapsedRef.current = false;
                }}
                onSelect={(kind) => {
                  const params = railKindToParams(kind);
                  navigate(`/${companyPrefix}/memory/explore${params}`);
                  setTreeCollapsed(false);
                  treePanelRef.current?.expand();
                }}
              />
            ) : (
              <MemoryTree
                companyId={selectedCompanyId}
                selectedFolderPath={folderPath}
                selectedDepartmentId={departmentId}
                selectedLayer={layer ?? null}
                selectedGoalId={goalId ?? null}
                selectedLocalPath={localPath}
                onToggleCollapse={() => {
                  setTreeCollapsed(true);
                  treePanelRef.current?.collapse();
                  treeAutoCollapsedRef.current = false;
                }}
              />
            )}
          </div>
        </Panel>
        <Separator
          id="memory-explorer-sep-1"
          className="relative w-1 bg-transparent transition-colors hover:bg-border/70 cursor-col-resize"
        />
        <Panel
          id="memory-explorer-list"
          defaultSize={isHomeSelected ? "32%" : "28%"}
          minSize="20%"
          className="min-w-0 h-full overflow-hidden"
        >
          <div
            className="h-full overflow-hidden rounded-xl border border-border bg-background shadow-sm"
            data-testid="memory-list-shell"
          >
            {localPath ? (
              <MemoryLocalFileList localPath={localPath} />
            ) : isHomeSelected ? (
              <div className="h-full flex flex-col bg-card/30">
                <div
                  className="flex h-[42px] shrink-0 items-center gap-3 border-b border-border bg-card px-3"
                  data-testid="memory-list-header"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">Memory</div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {(allItems ?? []).length} {(allItems ?? []).length === 1 ? "item" : "items"} · 4 layers
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    title="Quick-jump to a memory item or file"
                    aria-label="Quick-jump to a memory item or file"
                    onClick={() =>
                      window.dispatchEvent(new CustomEvent("memory:open-quick-switcher"))
                    }
                    className="h-7 w-7 p-0"
                  >
                    <Search className="size-3.5" aria-hidden />
                  </Button>
                  <MemoryUploadButton
                    companyId={selectedCompanyId}
                    departmentId={null}
                    folderPath=""
                    iconOnly
                  />
                  <Button
                    type="button"
                    size="sm"
                    title="New item"
                    aria-label="New item"
                    onClick={() => setNewItemOpen(true)}
                    className="h-7 w-7 p-0"
                  >
                    <Plus className="size-3.5" aria-hidden />
                  </Button>
                </div>
                <MemoryHomeDashboard companyId={selectedCompanyId} showQuickJump={false} />
              </div>
            ) : (
              <MemoryFileList
                companyId={selectedCompanyId}
                folderPath={folderPath}
                departmentId={departmentId}
                layer={layer ?? null}
                selectedItemId={activeKey?.id ?? null}
                selectedItemType={selectedFileListType}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                onNewItem={() => setNewItemOpen(true)}
                uploadContext={canUpload ? { departmentId, folderPath } : undefined}
                onSelectRow={(id, kind, title) => {
                  openOrActivate({ id, kind, title });
                  // Option B: if viewer was closed, this is the "browse → view" transition.
                  // Collapse the tree to give the viewer maximum width.
                  if (viewerCollapsed) {
                    setTreeCollapsed(true);
                    treePanelRef.current?.collapse();
                    treeAutoCollapsedRef.current = true;
                  }
                  setViewerCollapsed(false);
                  viewerPanelRef.current?.expand();
                }}
              />
            )}
          </div>
        </Panel>
        <Separator
          id="memory-explorer-sep-2"
          className="relative w-1 bg-transparent transition-colors hover:bg-border/70 cursor-col-resize"
        />
        <Panel
          id="memory-explorer-viewer"
          defaultSize={isHomeSelected ? "50%" : "52%"}
          minSize={isHomeSelected ? "30%" : "15%"}
          collapsible
          collapsedSize="3%"
          panelRef={viewerPanelRef}
          onResize={(size) => setViewerCollapsed(size.asPercentage <= 4)}
          className="min-w-0 h-full overflow-hidden"
        >
          <div
            className="h-full overflow-hidden rounded-xl border border-border bg-background shadow-sm"
            data-testid="memory-viewer-shell"
          >
            {viewerCollapsed ? (
              <MemoryCollapsedTabStrip
                tabs={tabs}
                activeKey={activeKey}
                onExpand={() => {
                  setViewerCollapsed(false);
                  viewerPanelRef.current?.expand();
                }}
                onActivate={(id, kind) => {
                  setActive(id, kind);
                  setViewerCollapsed(false);
                  viewerPanelRef.current?.expand();
                }}
              />
            ) : (
              <MemoryViewer
                companyId={selectedCompanyId}
                tabs={tabs}
                activeKey={activeKey}
                onActivate={setActive}
                onClose={close}
                onAdd={() => openOrActivate(MEMORY_OPEN_TAB)}
                onOpenTab={(tab) => {
                  openOrActivate(tab);
                  setViewerCollapsed(false);
                  viewerPanelRef.current?.expand();
                }}
                onOpenGraphNode={openGraphNode}
                onToggleCollapse={() => {
                  setViewerCollapsed(true);
                  viewerPanelRef.current?.collapse();
                }}
                folderPath={folderPath}
              />
            )}
          </div>
        </Panel>
      </Group>

      <NewMemoryItemDialog
        open={newItemOpen}
        onOpenChange={setNewItemOpen}
        companyId={selectedCompanyId}
        defaultDepartmentId={departmentId}
        defaultFolderPath={folderPath || undefined}
      />
    </div>
  );
}
