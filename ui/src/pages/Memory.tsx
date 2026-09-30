import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "@/lib/router";
import {
  Brain,
  Plus,
  Search,
  ChevronDown,
  ChevronRight,
  Check,
  X,
  Filter,
  Layers,
  List,
  History,
  Clock,
  AlertTriangle,
  FileEdit,
  Send,
  RotateCcw,
  Eye,
  Pencil,
  Pin,
  Sparkles,
  ChevronLeft,
  Upload,
  AlertCircle,
} from "lucide-react";
import {
  MEMORY_ITEM_CATEGORIES,
  MEMORY_ITEM_STATUSES,
  MEMORY_ITEM_LAYERS,
  MEMORY_ITEM_VISIBILITY,
  type MemoryItemCategory,
  type MemoryItemStatus,
  type MemoryItemLayer,
  type MemoryItemVisibility,
  type MemoryItem,
  type MemoryItemVersion,
  type PendingMemoryArchiveReview,
  type PendingMemoryQueue,
  type PendingMemoryVersionReview,
  type Project,
  type Goal,
  type Issue,
} from "@armyofagents/shared";
import { memoryApi } from "../api/memory";
import type { MemoryListResponse } from "../api/memory";
import { fileImportApi } from "../api/fileImport";
import { projectsApi } from "../api/projects";
import { goalsApi } from "../api/goals";
import { issuesApi } from "../api/issues";
import {
  memoryStarterTemplatesApi,
  type MemoryStarterTemplate,
} from "../api/memoryStarterTemplates";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { MemoryIndexBadge } from "../components/memory/MemoryIndexBadge";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTeamAccess } from "../hooks/useTeamAccess";

// ── Constants ──────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<MemoryItemCategory, string> = {
  decision: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  reference: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  context: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
  insight: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  preference: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  // Extended memory categories.
  procedure: "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300",
  policy: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
};

const STATUS_COLORS: Record<MemoryItemStatus, string> = {
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  archived: "bg-gray-100 text-gray-800 dark:bg-gray-900/40 dark:text-gray-300",
  rejected: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  draft: "bg-slate-100 text-slate-800 dark:bg-slate-900/40 dark:text-slate-300",
};

const LAYER_COLORS: Record<MemoryItemLayer, string> = {
  identity: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  domain: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300",
  active_context: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  working: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
};

const LAYER_LABELS: Record<MemoryItemLayer, string> = {
  identity: "Identity",
  domain: "Domain",
  active_context: "Active Context",
  working: "Working",
};

const LAYER_DESCRIPTIONS: Record<MemoryItemLayer, string> = {
  identity: "Permanent company knowledge — vision, mission, values",
  domain: "Department-scoped, semi-permanent knowledge",
  active_context: "Goal/project-scoped, temporary with expiration",
  working: "Task-chain-scoped, ephemeral (auto-archives after 7 days)",
};

const STALENESS_THRESHOLD_DAYS = 90;

function formatDate(date: Date | string) {
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function daysSince(date: Date | string) {
  const diff = Date.now() - new Date(date).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function estimateTokens(content: string) {
  return Math.ceil(content.length / 4);
}

function isStale(item: MemoryItem): boolean {
  const checkDate = item.accessedAt ?? item.updatedAt;
  return daysSince(checkDate) >= STALENESS_THRESHOLD_DAYS;
}

/** Shared hook for invalidating memory list + pending queries. */
function useInvalidateMemory(companyId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useCallback(() => {
    if (!companyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.memory.list(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.memory.pending(companyId) });
  }, [queryClient, companyId]);
}

// ── Main Component ─────────────────────────────────────────────────────

export function Memory() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs, setSubtitle, setEntityColor } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { permissions } = useTeamAccess(selectedCompanyId);
  const [searchParams] = useSearchParams();
  const { pushToast } = useToast();

  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [departmentFilter, setDepartmentFilter] = useState<string>("all");
  const [layerFilter, setLayerFilter] = useState<string>("all");
  const [viewMode, setViewMode] = useState<"layer" | "flat">("layer");
  const [activeTab, setActiveTab] = useState<string>(searchParams.get("tab") ?? "all");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(
    searchParams.get("item") ?? searchParams.get("selected"),
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importJobId, setImportJobId] = useState<string | null>(null);
  const [importingFileName, setImportingFileName] = useState<string | null>(null);

  // Poll job status while import is in flight
  const { data: importJob } = useQuery({
    queryKey: queryKeys.memory.importJob(selectedCompanyId ?? "", importJobId ?? "__none__"),
    queryFn: () => fileImportApi.getJob(selectedCompanyId!, importJobId!),
    enabled: !!importJobId && !!selectedCompanyId,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || data.status === "pending" || data.status === "processing") return 3_000;
      return false;
    },
  });

  // React to job completion/failure
  useEffect(() => {
    if (!importJob) return;
    if (importJob.status === "done") {
      pushToast({ title: `${importJob.itemCount} items added to Pending review from "${importingFileName}"`, tone: "success" });
      void queryClient.invalidateQueries({ queryKey: queryKeys.memory.pending(selectedCompanyId!) });
      setImportJobId(null);
      setImportingFileName(null);
    } else if (importJob.status === "failed") {
      pushToast({ title: `Import failed: ${importJob.errorMessage ?? "Unknown error"}`, tone: "error" });
      setImportJobId(null);
      setImportingFileName(null);
    }
  }, [importJob?.status, importJob?.itemCount, importJob?.errorMessage, pushToast, queryClient, selectedCompanyId, importingFileName]);

  async function handleFileImport(file: File) {
    if (!selectedCompanyId) return;
    setImportingFileName(file.name);
    try {
      const { jobId } = await fileImportApi.upload(selectedCompanyId, file);
      setImportJobId(jobId);
      pushToast({ title: `Importing "${file.name}"…`, tone: "info" });
    } catch (err) {
      pushToast({ title: err instanceof Error ? err.message : "Failed to start import", tone: "error" });
      setImportingFileName(null);
    }
  }

  useEffect(() => {
    setBreadcrumbs([{ label: "Memory" }]);
    setEntityColor("var(--entity-memory)");
    return () => { setSubtitle(null); setEntityColor(null); };
  }, [setBreadcrumbs, setSubtitle, setEntityColor]);

  useEffect(() => {
    setActiveTab(searchParams.get("tab") ?? "all");
    setSelectedItemId(searchParams.get("item") ?? searchParams.get("selected"));
    const searchParam = searchParams.get("q");
    if (searchParam !== null) {
      setSearch(searchParam);
    }
  }, [searchParams]);

  const filters = useMemo(() => {
    const f: Record<string, string> = {};
    if (categoryFilter !== "all") f.category = categoryFilter;
    if (statusFilter !== "all") f.status = statusFilter;
    if (departmentFilter !== "all") f.departmentId = departmentFilter;
    if (layerFilter !== "all") f.layer = layerFilter;
    if (search.trim()) f.search = search.trim();
    return f;
  }, [categoryFilter, statusFilter, departmentFilter, layerFilter, search]);

  const [semanticBannerDismissed, setSemanticBannerDismissed] = useState(false);

  const { data: listResponse, isLoading } = useQuery<MemoryListResponse>({
    queryKey: [...queryKeys.memory.list(selectedCompanyId!), filters],
    queryFn: () => memoryApi.list(selectedCompanyId!, filters),
    enabled: !!selectedCompanyId,
  });

  const items = listResponse?.items;
  const semanticAvailable = listResponse?.semanticAvailable ?? true;

  const { data: pendingQueue } = useQuery({
    queryKey: queryKeys.memory.pending(selectedCompanyId!),
    queryFn: () => memoryApi.listPending(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const departments = useMemo(
    () => (projects ?? []).filter((p: Project) => p.type === "department"),
    [projects],
  );

  // Compute subtitle counts
  useEffect(() => {
    if (!items) return;
    const total = items.length;
    const pending = items.filter((i: MemoryItem) => i.status === "pending").length;
    const parts: string[] = [];
    if (total > 0) parts.push(`${total} items`);
    if (pending > 0) parts.push(`${pending} pending`);
    setSubtitle(parts.length > 0 ? parts.join(" \u00B7 ") : null);
  }, [items, setSubtitle]);

  const invalidateMemoryQueries = useInvalidateMemory(selectedCompanyId);

  const reindexItemMutation = useMutation({
    mutationFn: (id: string) => memoryApi.reindexItem(selectedCompanyId!, id),
    onSuccess: () => {
      invalidateMemoryQueries();
      pushToast({ title: "Re-index queued", tone: "success" });
    },
    onError: () => {
      pushToast({ title: "Failed to queue re-index", tone: "error" });
    },
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => memoryApi.approve(selectedCompanyId!, id),
    onSuccess: () => {
      invalidateMemoryQueries();
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => memoryApi.reject(selectedCompanyId!, id),
    onSuccess: () => {
      invalidateMemoryQueries();
    },
  });

  const approveVersionMutation = useMutation({
    mutationFn: ({ itemId, versionId }: { itemId: string; versionId: string }) =>
      memoryApi.approveVersion(selectedCompanyId!, itemId, versionId),
    onSuccess: () => {
      invalidateMemoryQueries();
    },
  });

  const rejectVersionMutation = useMutation({
    mutationFn: ({ itemId, versionId }: { itemId: string; versionId: string }) =>
      memoryApi.rejectVersion(selectedCompanyId!, itemId, versionId),
    onSuccess: () => {
      invalidateMemoryQueries();
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Brain} message="Select a company to view memory." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const sorted = [...(items ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const pendingCount = (items ?? []).filter((i) => i.status === "pending").length;
  const agentPendingCount = pendingQueue?.totalCount ?? 0;

  // Items for the "all" tab (excluding agent pending if on suggestions tab)
  const allItems = activeTab === "suggestions" ? [] : sorted;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-[1.6rem] font-bold tracking-tight">
          Memory<span className="text-brand">.</span>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Company knowledge — decisions, preferences, context, and reference material your agents remember.
        </p>
      </div>

      {/* No-key semantic search banner — shown to founder/team_lead only */}
      {!semanticAvailable && !semanticBannerDismissed && permissions.canEditIdentityMemory && (
        <div
          data-testid="no-llm-key-banner"
          className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/[0.08] px-4 py-3 text-sm"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden />
          <div className="flex-1 text-muted-foreground">
            <span className="font-medium text-foreground">Semantic search is off</span>
            {" — "}
            add an embeddings key in{" "}
            <span className="font-medium text-foreground">Settings → Memory</span>
            {" "}to enable meaning-based memory recall.
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

      {/* Search bar + view mode toggle */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search memory..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-8 text-sm"
          />
        </div>

        {/* View mode toggle */}
        <div className="flex items-center rounded-md border border-border">
          <Button
            size="sm"
            variant={viewMode === "layer" ? "default" : "ghost"}
            className="h-7 rounded-r-none text-xs gap-1"
            onClick={() => setViewMode("layer")}
          >
            <Layers className="h-3.5 w-3.5" />
            By Layer
          </Button>
          <Button
            size="sm"
            variant={viewMode === "flat" ? "default" : "ghost"}
            className="h-7 rounded-l-none text-xs gap-1"
            onClick={() => setViewMode("flat")}
          >
            <List className="h-3.5 w-3.5" />
            Flat
          </Button>
        </div>

        {/* Hidden file input for import */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx,.txt"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFileImport(file);
            e.target.value = "";
          }}
        />

        <Button
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={!!importJobId}
        >
          <Upload className="h-4 w-4 mr-1" />
          {importJobId ? "Importing…" : "Import from file"}
        </Button>

        <Button
          size="sm"
          variant="outline"
          onClick={() => setTemplatesOpen(true)}
          className="gap-1.5"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Starter templates
        </Button>

        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setCreateOpen(true)}
                  disabled={!permissions.canEditIdentityMemory}
                >
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  Add to Memory
                </Button>
              </span>
            </TooltipTrigger>
            {!permissions.canEditIdentityMemory && (
              <TooltipContent>You don't have permission to edit identity memory</TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Tabs: All / Agent Suggestions */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList variant="line">
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="suggestions">
            Agent Suggestions
            {agentPendingCount > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0 bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                {agentPendingCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="mt-4">
          {/* Filter row */}
          <div className="flex items-center gap-2 flex-wrap mb-4">
            <Filter className="h-3.5 w-3.5 text-muted-foreground" />
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="h-7 w-[130px] text-xs">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {MEMORY_ITEM_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c} className="capitalize">
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-7 w-[120px] text-xs">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {MEMORY_ITEM_STATUSES.map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={departmentFilter} onValueChange={setDepartmentFilter}>
              <SelectTrigger className="h-7 w-[150px] text-xs">
                <SelectValue placeholder="Department" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All departments</SelectItem>
                {departments.map((d: Project) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={layerFilter} onValueChange={setLayerFilter}>
              <SelectTrigger className="h-7 w-[150px] text-xs">
                <SelectValue placeholder="Layer" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All layers</SelectItem>
                {MEMORY_ITEM_LAYERS.map((l) => (
                  <SelectItem key={l} value={l}>
                    {LAYER_LABELS[l]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {pendingCount > 0 && (
              <Button
                size="sm"
                variant={statusFilter === "pending" ? "default" : "outline"}
                className="h-7 text-xs"
                onClick={() =>
                  setStatusFilter(statusFilter === "pending" ? "all" : "pending")
                }
              >
                Pending ({pendingCount})
              </Button>
            )}
          </div>

          {/* Items list */}
          {allItems.length === 0 ? (
            <MemoryEmptyState
              hasActiveFilters={
                categoryFilter !== "all" ||
                statusFilter !== "all" ||
                departmentFilter !== "all" ||
                layerFilter !== "all" ||
                search.trim().length > 0
              }
              onAddItem={() => setCreateOpen(true)}
              onBrowseTemplates={() => setTemplatesOpen(true)}
            />
          ) : viewMode === "layer" ? (
            <LayerView
              items={allItems}
              departments={departments}
              selectedItemId={selectedItemId}
              onSelectItem={setSelectedItemId}
              onApprove={(id) => approveMutation.mutate(id)}
              onReject={(id) => rejectMutation.mutate(id)}
              onReindex={(id) => reindexItemMutation.mutate(id)}
              canEditIdentityMemory={permissions.canEditIdentityMemory}
            />
          ) : (
            <FlatView
              items={allItems}
              departments={departments}
              selectedItemId={selectedItemId}
              onSelectItem={setSelectedItemId}
              onApprove={(id) => approveMutation.mutate(id)}
              onReject={(id) => rejectMutation.mutate(id)}
              onReindex={(id) => reindexItemMutation.mutate(id)}
              canEditIdentityMemory={permissions.canEditIdentityMemory}
            />
          )}
        </TabsContent>

        <TabsContent value="suggestions" className="mt-4">
          <SuggestionQueue
            queue={pendingQueue}
            departments={departments}
            companyId={selectedCompanyId}
            onApprove={(id) => approveMutation.mutate(id)}
            onReject={(id) => rejectMutation.mutate(id)}
            onApproveVersion={(itemId, versionId) => approveVersionMutation.mutate({ itemId, versionId })}
            onRejectVersion={(itemId, versionId) => rejectVersionMutation.mutate({ itemId, versionId })}
            canEditIdentityMemory={permissions.canEditIdentityMemory}
          />
        </TabsContent>
      </Tabs>

      {/* Detail panel */}
      {selectedItemId && (
        <MemoryDetailPanel
          companyId={selectedCompanyId}
          itemId={selectedItemId}
          departments={departments}
          onClose={() => setSelectedItemId(null)}
          canEditIdentityMemory={permissions.canEditIdentityMemory}
        />
      )}

      {/* Create dialog */}
      <CreateMemoryDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        companyId={selectedCompanyId}
        departments={departments}
        canCreate={permissions.canEditIdentityMemory}
      />

      {/* Starter templates dialog */}
      <StarterTemplatesDialog
        open={templatesOpen}
        onOpenChange={setTemplatesOpen}
        companyId={selectedCompanyId}
        departments={departments}
        onApplied={() => invalidateMemoryQueries()}
      />
    </div>
  );
}

// ── Layer View ─────────────────────────────────────────────────────────

function LayerView({
  items,
  departments,
  selectedItemId,
  onSelectItem,
  onApprove,
  onReject,
  onReindex,
  canEditIdentityMemory,
}: {
  items: MemoryItem[];
  departments: Project[];
  selectedItemId: string | null;
  onSelectItem: (id: string | null) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onReindex?: (id: string) => void;
  canEditIdentityMemory: boolean;
}) {
  const grouped = useMemo(() => {
    const map: Record<string, MemoryItem[]> = {
      identity: [],
      domain: [],
      active_context: [],
      working: [],
      unassigned: [],
    };
    for (const item of items) {
      const layer = item.layer ?? "unassigned";
      if (map[layer]) {
        map[layer].push(item);
      } else {
        map.unassigned.push(item);
      }
    }
    return map;
  }, [items]);

  return (
    <div className="space-y-3">
      {MEMORY_ITEM_LAYERS.map((layer) => (
        <LayerSection
          key={layer}
          layer={layer}
          items={grouped[layer]}
          departments={departments}
          selectedItemId={selectedItemId}
          onSelectItem={onSelectItem}
          onApprove={onApprove}
          onReject={onReject}
          onReindex={onReindex}
          canEditIdentityMemory={canEditIdentityMemory}
        />
      ))}
      {grouped.unassigned.length > 0 && (
        <div className="rounded-lg border border-border">
          <div className="flex items-center justify-between px-3 py-2 bg-muted/30">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-muted-foreground">Unassigned Layer</span>
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                {grouped.unassigned.length}
              </Badge>
            </div>
          </div>
          <div className="p-2 space-y-1.5">
            {grouped.unassigned.map((item) => (
              <MemoryCard
                key={item.id}
                item={item}
                departments={departments}
                selected={selectedItemId === item.id}
                onSelect={() => onSelectItem(selectedItemId === item.id ? null : item.id)}
                onApprove={() => onApprove(item.id)}
                onReject={() => onReject(item.id)}
                canEditIdentityMemory={canEditIdentityMemory}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LayerSection({
  layer,
  items,
  departments,
  selectedItemId,
  onSelectItem,
  onApprove,
  onReject,
  onReindex,
  canEditIdentityMemory,
}: {
  layer: MemoryItemLayer;
  items: MemoryItem[];
  departments: Project[];
  selectedItemId: string | null;
  onSelectItem: (id: string | null) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onReindex?: (id: string) => void;
  canEditIdentityMemory: boolean;
}) {
  const [open, setOpen] = useState(true);
  const totalTokens = useMemo(
    () => items.reduce((sum, i) => sum + estimateTokens(i.content), 0),
    [items],
  );

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-lg border border-border">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between px-3 py-2 hover:bg-accent/30 transition-colors"
          >
            <div className="flex items-center gap-2">
              {open ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
              <Badge
                variant="secondary"
                className={cn("text-[10px] px-1.5 py-0", LAYER_COLORS[layer])}
              >
                {LAYER_LABELS[layer]}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {items.length} {items.length === 1 ? "item" : "items"}
              </span>
            </div>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    ~{totalTokens.toLocaleString()} tokens
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{LAYER_DESCRIPTIONS[layer]}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {items.length === 0 ? (
            <div className="px-3 py-4 text-center text-sm text-muted-foreground">
              No items in this layer
            </div>
          ) : (
            <div className="p-2 space-y-1.5">
              {items.map((item) => (
                <MemoryCard
                  key={item.id}
                  item={item}
                  departments={departments}
                  selected={selectedItemId === item.id}
                  onSelect={() => onSelectItem(selectedItemId === item.id ? null : item.id)}
                  onApprove={() => onApprove(item.id)}
                  onReject={() => onReject(item.id)}
                  onReindex={onReindex}
                  canEditIdentityMemory={canEditIdentityMemory}
                />
              ))}
            </div>
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

// ── Flat View ──────────────────────────────────────────────────────────

function FlatView({
  items,
  departments,
  selectedItemId,
  onSelectItem,
  onApprove,
  onReject,
  onReindex,
  canEditIdentityMemory,
}: {
  items: MemoryItem[];
  departments: Project[];
  selectedItemId: string | null;
  onSelectItem: (id: string | null) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onReindex?: (id: string) => void;
  canEditIdentityMemory: boolean;
}) {
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <MemoryCard
          key={item.id}
          item={item}
          departments={departments}
          selected={selectedItemId === item.id}
          onSelect={() => onSelectItem(selectedItemId === item.id ? null : item.id)}
          onApprove={() => onApprove(item.id)}
          onReject={() => onReject(item.id)}
          onReindex={onReindex}
          canEditIdentityMemory={canEditIdentityMemory}
          showLayer
        />
      ))}
    </div>
  );
}

// ── Memory Card ────────────────────────────────────────────────────────

function MemoryCard({
  item,
  departments,
  selected,
  onSelect,
  onApprove,
  onReject,
  onReindex,
  canEditIdentityMemory,
  showLayer,
}: {
  item: MemoryItem;
  departments: Project[];
  selected: boolean;
  onSelect: () => void;
  onApprove: () => void;
  onReject: () => void;
  onReindex?: (id: string) => void;
  canEditIdentityMemory: boolean;
  showLayer?: boolean;
}) {
  const dept = item.departmentId ? departments.find((d) => d.id === item.departmentId) : null;
  const stale = isStale(item);
  const identityLocked = item.layer === "identity" && !canEditIdentityMemory;

  return (
    <div
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-accent/30",
        selected && "ring-2 ring-primary/30 border-primary/50",
      )}
    >
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={onSelect}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium truncate">{item.title}</span>
            <Badge
              variant="secondary"
              className={cn(
                "text-[10px] px-1.5 py-0 capitalize",
                CATEGORY_COLORS[item.category],
              )}
            >
              {item.category}
            </Badge>
            <Badge
              variant="secondary"
              className={cn(
                "text-[10px] px-1.5 py-0 capitalize",
                STATUS_COLORS[item.status],
              )}
            >
              {item.status}
            </Badge>
            {showLayer && item.layer && (
              <Badge
                variant="secondary"
                className={cn("text-[10px] px-1.5 py-0", LAYER_COLORS[item.layer])}
              >
                {LAYER_LABELS[item.layer]}
              </Badge>
            )}
            {(item as MemoryItem & { pinnedToSkill?: boolean }).pinnedToSkill && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="outline"
                      className="text-[10px] px-1.5 py-0 gap-0.5 border-violet-300 text-violet-700 dark:border-violet-700 dark:text-violet-400"
                    >
                      <Pin className="h-2.5 w-2.5" />
                      pinned
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Pinned to skills — agents always receive this item in their skill context</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {item.currentVersionId && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 gap-0.5">
                <History className="h-2.5 w-2.5" />
                versioned
              </Badge>
            )}
            {stale && item.status === "approved" && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 gap-0.5">
                      <AlertTriangle className="h-2.5 w-2.5" />
                      stale
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Not accessed in {daysSince(item.accessedAt ?? item.updatedAt)} days. Still relevant?</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {item.indexStatus && (
              <MemoryIndexBadge
                status={item.indexStatus}
                onReindex={onReindex ? () => onReindex(item.id) : undefined}
              />
            )}
          </div>

          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
            <span className="capitalize">{item.source}</span>
            {dept && (
              <>
                <span>&middot;</span>
                <span>{dept.name}</span>
              </>
            )}
            <span>&middot;</span>
            <span>{formatDate(item.createdAt)}</span>
            {item.visibility === "shared" && (
              <>
                <span>&middot;</span>
                <span className="text-blue-600 dark:text-blue-400">Shared</span>
              </>
            )}
          </div>

          {item.tags && item.tags.length > 0 && (
            <div className="flex items-center gap-1 mt-1.5 flex-wrap">
              {item.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </button>

      {item.status === "pending" && !identityLocked && (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
            onClick={onApprove}
            title="Approve"
          >
            <Check className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/30"
            onClick={onReject}
            title="Reject"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Detail Panel ───────────────────────────────────────────────────────

function MemoryDetailPanel({
  companyId,
  itemId,
  departments,
  onClose,
  canEditIdentityMemory,
}: {
  companyId: string;
  itemId: string;
  departments: Project[];
  onClose: () => void;
  canEditIdentityMemory: boolean;
}) {
  const queryClient = useQueryClient();
  const invalidateMemoryQueries = useInvalidateMemory(companyId);
  const [activeDetailTab, setActiveDetailTab] = useState<string>("content");
  const [draftContent, setDraftContent] = useState("");
  const [isEditing, setIsEditing] = useState(false);

  const invalidateDetail = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.memory.detail(companyId, itemId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.memory.versions(companyId, itemId) });
  }, [queryClient, companyId, itemId]);

  const { data: item } = useQuery({
    queryKey: queryKeys.memory.detail(companyId, itemId),
    queryFn: () => memoryApi.get(companyId, itemId),
  });

  const { data: versions } = useQuery({
    queryKey: queryKeys.memory.versions(companyId, itemId),
    queryFn: () => memoryApi.getVersions(companyId, itemId),
  });

  const saveDraftMutation = useMutation({
    mutationFn: (content: string) => memoryApi.saveDraft(companyId, itemId, content),
    onSuccess: () => {
      invalidateDetail();
      setIsEditing(false);
    },
  });

  const publishMutation = useMutation({
    mutationFn: () => memoryApi.publishDraft(companyId, itemId),
    onSuccess: () => {
      invalidateDetail();
      invalidateMemoryQueries();
    },
  });

  const restoreMutation = useMutation({
    mutationFn: () => memoryApi.restore(companyId, itemId),
    onSuccess: () => {
      invalidateMemoryQueries();
      invalidateDetail();
    },
  });

  const touchMutation = useMutation({
    mutationFn: () => memoryApi.touchAccessedAt(companyId, itemId),
    onSuccess: () => {
      invalidateMemoryQueries();
      invalidateDetail();
    },
  });

  if (!item) return null;

  const dept = item.departmentId
    ? departments.find((d) => d.id === item.departmentId)
    : null;

  const stale = isStale(item);
  const hasDraft = versions?.some((v) => v.status === "draft");
  const hasPendingAgentVersion = versions?.some(
    (v) => v.status === "pending" && v.createdBy !== "founder",
  );
  const identityLocked = item.layer === "identity" && !canEditIdentityMemory;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogDescription className="sr-only">Memory item details</DialogDescription>
          <div className="flex items-center gap-2 flex-wrap">
            <DialogTitle className="text-base">{item.title}</DialogTitle>
            {item.layer && (
              <Badge
                variant="secondary"
                className={cn("text-[10px] px-1.5 py-0", LAYER_COLORS[item.layer])}
              >
                {LAYER_LABELS[item.layer]}
              </Badge>
            )}
            <Badge
              variant="secondary"
              className={cn("text-[10px] px-1.5 py-0 capitalize", STATUS_COLORS[item.status])}
            >
              {item.status}
            </Badge>
            {hasDraft && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 gap-0.5">
                <FileEdit className="h-2.5 w-2.5" />
                draft
              </Badge>
            )}
            {stale && item.status === "approved" && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 gap-0.5">
                <AlertTriangle className="h-2.5 w-2.5" />
                stale ({daysSince(item.accessedAt ?? item.updatedAt)}d)
              </Badge>
            )}
          </div>
        </DialogHeader>

        <DialogBody>
        {/* Metadata */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
          <span className="capitalize">Source: {item.source}</span>
          {dept && <span>Dept: {dept.name}</span>}
          <span>Created: {formatDate(item.createdAt)}</span>
          {item.accessedAt && <span>Last accessed: {formatDate(item.accessedAt)}</span>}
          {item.priority > 0 && <span>Priority: {item.priority}</span>}
          <span>Visibility: {item.visibility}</span>
        </div>

        {/* Staleness action */}
        {stale && item.status === "approved" && (
          <div className="flex items-center gap-2 p-2 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
            <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
            <span className="text-xs text-amber-800 dark:text-amber-300">
              Not accessed in {daysSince(item.accessedAt ?? item.updatedAt)} days.
            </span>
            <div className="flex gap-1 ml-auto">
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-xs"
                onClick={() => touchMutation.mutate()}
              >
                Still Relevant
              </Button>
            </div>
          </div>
        )}

        {/* Restore button for archived items */}
        {item.status === "archived" && (
          <div className="flex items-center gap-2 p-2 rounded-md bg-gray-50 dark:bg-gray-900/20 border border-gray-200 dark:border-gray-800">
            <RotateCcw className="h-4 w-4 text-gray-600 shrink-0" />
            <span className="text-xs text-gray-800 dark:text-gray-300">
              This item is archived.
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-xs ml-auto"
              onClick={() => restoreMutation.mutate()}
              disabled={restoreMutation.isPending}
            >
              {restoreMutation.isPending ? "Restoring..." : "Restore"}
            </Button>
          </div>
        )}

        {/* Source context */}
        {item.sourceContext && (
          <div className="text-xs text-muted-foreground p-2 rounded-md bg-muted/30 border border-border">
            <span className="font-medium">Context:</span> {item.sourceContext}
          </div>
        )}

        {/* Tabs: Content / Version History */}
        <Tabs value={activeDetailTab} onValueChange={setActiveDetailTab}>
          <TabsList variant="line">
            <TabsTrigger value="content">
              <Eye className="h-3.5 w-3.5 mr-1" />
              Content
            </TabsTrigger>
            <TabsTrigger value="versions">
              <History className="h-3.5 w-3.5 mr-1" />
              Versions
              {versions && versions.length > 0 && (
                <Badge variant="secondary" className="ml-1 text-[10px] px-1 py-0">
                  {versions.length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="content" className="mt-3">
            {isEditing ? (
              <div className="space-y-2">
                {hasPendingAgentVersion && (
                  <div className="flex items-center gap-2 p-2 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                    <span className="text-xs text-amber-800 dark:text-amber-300">
                      An agent has a pending version for this item.
                    </span>
                  </div>
                )}
                <Textarea
                  value={draftContent}
                  onChange={(e) => setDraftContent(e.target.value)}
                  rows={8}
                  className="text-sm"
                />
                <div className="flex items-center gap-2 justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setIsEditing(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => saveDraftMutation.mutate(draftContent)}
                    disabled={saveDraftMutation.isPending}
                  >
                    <FileEdit className="h-3.5 w-3.5 mr-1" />
                    {saveDraftMutation.isPending ? "Saving..." : "Save Draft"}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      saveDraftMutation.mutate(draftContent, {
                        onSuccess: () => publishMutation.mutate(),
                      });
                    }}
                    disabled={saveDraftMutation.isPending || publishMutation.isPending}
                  >
                    <Send className="h-3.5 w-3.5 mr-1" />
                    {publishMutation.isPending ? "Publishing..." : "Save & Publish"}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-foreground whitespace-pre-wrap">
                  {item.content}
                </p>
                <div className="flex items-center gap-2 justify-end">
                  {!identityLocked && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setDraftContent(item.content);
                        setIsEditing(true);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5 mr-1" />
                      Edit
                    </Button>
                  )}
                  {hasDraft && (
                    <Button
                      size="sm"
                      onClick={() => publishMutation.mutate()}
                      disabled={publishMutation.isPending}
                    >
                      <Send className="h-3.5 w-3.5 mr-1" />
                      {publishMutation.isPending ? "Publishing..." : "Publish Draft"}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="versions" className="mt-3">
            {!versions || versions.length === 0 ? (
              <div className="text-center text-sm text-muted-foreground py-4">
                No version history yet. Edit and save a draft to create versions.
              </div>
            ) : (
              <div className="space-y-2">
                {versions.map((version, idx) => (
                  <VersionCard
                    key={version.id}
                    version={version}
                    isCurrent={version.id === item.currentVersionId}
                    previousContent={idx < versions.length - 1 ? versions[idx + 1].content : null}
                  />
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

// ── Version Card ───────────────────────────────────────────────────────

function VersionCard({
  version,
  isCurrent,
  previousContent,
}: {
  version: MemoryItemVersion;
  isCurrent: boolean;
  previousContent: string | null;
}) {
  const [showDiff, setShowDiff] = useState(false);

  const statusColor =
    version.status === "approved"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
      : version.status === "draft"
        ? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
        : version.status === "pending"
          ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
          : version.status === "rejected"
            ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"
            : "bg-gray-100 text-gray-800 dark:bg-gray-900/40 dark:text-gray-300";

  return (
    <div
      className={cn(
        "rounded-md border border-border p-2.5",
        isCurrent && "border-primary/50 bg-primary/5",
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">v{version.versionNumber}</span>
          <Badge variant="secondary" className={cn("text-[10px] px-1.5 py-0", statusColor)}>
            {version.status}
          </Badge>
          {isCurrent && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              current
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            by {version.createdBy}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {formatDate(version.createdAt)}
          </span>
          {previousContent && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-xs"
              onClick={() => setShowDiff(!showDiff)}
            >
              {showDiff ? "Hide diff" : "Show diff"}
            </Button>
          )}
        </div>
      </div>
      {showDiff && previousContent && (
        <div className="mt-2 space-y-1">
          <SimpleDiff oldText={previousContent} newText={version.content} />
        </div>
      )}
    </div>
  );
}

// ── Simple Diff ────────────────────────────────────────────────────────

function SimpleDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const maxLen = Math.max(oldLines.length, newLines.length);

  const diffs: { type: "same" | "removed" | "added"; text: string }[] = [];

  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine === newLine) {
      if (oldLine !== undefined) diffs.push({ type: "same", text: oldLine });
    } else {
      if (oldLine !== undefined) diffs.push({ type: "removed", text: oldLine });
      if (newLine !== undefined) diffs.push({ type: "added", text: newLine });
    }
  }

  return (
    <div className="text-xs font-mono rounded border border-border overflow-hidden">
      {diffs.map((d, i) => (
        <div
          key={i}
          className={cn(
            "px-2 py-0.5",
            d.type === "removed" && "bg-red-50 text-red-800 dark:bg-red-900/20 dark:text-red-300",
            d.type === "added" && "bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300",
          )}
        >
          <span className="select-none mr-2 text-muted-foreground">
            {d.type === "removed" ? "-" : d.type === "added" ? "+" : " "}
          </span>
          {d.text || "\u00A0"}
        </div>
      ))}
    </div>
  );
}

// ── Suggestion Queue ───────────────────────────────────────────────────

function SuggestionQueue({
  queue,
  departments,
  companyId,
  onApprove,
  onReject,
  onApproveVersion,
  onRejectVersion,
  canEditIdentityMemory,
}: {
  queue: PendingMemoryQueue | undefined;
  departments: Project[];
  companyId: string;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onApproveVersion: (itemId: string, versionId: string) => void;
  onRejectVersion: (itemId: string, versionId: string) => void;
  canEditIdentityMemory: boolean;
}) {
  const invalidateMemoryQueries = useInvalidateMemory(companyId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const items = queue?.items ?? [];
  const versions = queue?.versions ?? [];
  const archives = queue?.archives ?? [];
  const totalCount = queue?.totalCount ?? 0;

  const updateAndApproveMutation = useMutation({
    mutationFn: async ({ id, title, content }: { id: string; title: string; content: string }) => {
      await memoryApi.update(companyId, id, { title, content });
      return memoryApi.approve(companyId, id);
    },
    onSuccess: () => {
      invalidateMemoryQueries();
      setEditingId(null);
    },
  });

  if (totalCount === 0) {
    return (
      <EmptyState
        icon={Brain}
        message="No agent suggestions"
        description="When agents suggest memory items, they'll appear here for your review."
        entityColor="var(--entity-memory)"
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {totalCount} pending {totalCount === 1 ? "suggestion" : "suggestions"} from agents
      </p>
      {items.map((item) => {
        const dept = item.departmentId
          ? departments.find((d) => d.id === item.departmentId)
          : null;

        const isEditingThis = editingId === item.id;
        const identityLocked = item.layer === "identity" && !canEditIdentityMemory;

        return (
          <div key={item.id} className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-900/10">
            <div className="p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">{item.title}</span>
                  <Badge
                    variant="secondary"
                    className={cn("text-[10px] px-1.5 py-0 capitalize", CATEGORY_COLORS[item.category])}
                  >
                    {item.category}
                  </Badge>
                  {item.layer && (
                    <Badge
                      variant="secondary"
                      className={cn("text-[10px] px-1.5 py-0", LAYER_COLORS[item.layer])}
                    >
                      {LAYER_LABELS[item.layer]}
                    </Badge>
                  )}
                </div>
                <span className="text-xs text-muted-foreground capitalize">
                  by {item.createdBy}
                </span>
              </div>

              {item.sourceContext && (
                <div className="text-xs text-muted-foreground p-2 rounded bg-white/50 dark:bg-black/10 border border-amber-100 dark:border-amber-900">
                  <span className="font-medium">Agent reasoning:</span> {item.sourceContext}
                </div>
              )}

              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="capitalize">{item.source}</span>
                {dept && (
                  <>
                    <span>&middot;</span>
                    <span>{dept.name}</span>
                  </>
                )}
                <span>&middot;</span>
                <span>{formatDate(item.createdAt)}</span>
              </div>

              {isEditingThis ? (
                <div className="space-y-2">
                  <Input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="text-sm"
                    placeholder="Title"
                  />
                  <Textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    rows={4}
                    className="text-sm"
                  />
                  <div className="flex items-center gap-2 justify-end">
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        updateAndApproveMutation.mutate({
                          id: item.id,
                          title: editTitle,
                          content: editContent,
                        })
                      }
                      disabled={updateAndApproveMutation.isPending}
                    >
                      {updateAndApproveMutation.isPending ? "Saving..." : "Save & Approve"}
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-foreground whitespace-pre-wrap">
                  {item.content}
                </p>
              )}

              {/* Actions */}
              {!isEditingThis && !identityLocked && (
                <div className="flex items-center gap-2 justify-end pt-1 border-t border-amber-100 dark:border-amber-900">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/30 h-7 text-xs"
                    onClick={() => onReject(item.id)}
                  >
                    <X className="h-3.5 w-3.5 mr-1" />
                    Reject
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => {
                      setEditingId(item.id);
                      setEditTitle(item.title);
                      setEditContent(item.content);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5 mr-1" />
                    Edit & Approve
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => onApprove(item.id)}
                  >
                    <Check className="h-3.5 w-3.5 mr-1" />
                    Approve
                  </Button>
                </div>
              )}
            </div>
          </div>
        );
      })}
      {versions.map((entry) => {
        const identityLocked = entry.itemLayer === "identity" && !canEditIdentityMemory;
        const dept = null;
        return (
          <div key={entry.version.id} className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-900/10">
            <div className="p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">{entry.itemTitle}</span>
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
                    update suggestion
                  </Badge>
                  {entry.itemLayer && (
                    <Badge
                      variant="secondary"
                      className={cn("text-[10px] px-1.5 py-0", LAYER_COLORS[entry.itemLayer as MemoryItemLayer])}
                    >
                      {LAYER_LABELS[entry.itemLayer as MemoryItemLayer]}
                    </Badge>
                  )}
                </div>
                <span className="text-xs text-muted-foreground capitalize">
                  by {entry.version.createdBy}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                Proposed version v{entry.version.versionNumber} against current memory content.
              </div>
              <SimpleDiff oldText={entry.currentContent} newText={entry.version.content} />
              {!identityLocked && (
                <div className="flex items-center gap-2 justify-end pt-1 border-t border-blue-100 dark:border-blue-900">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/30 h-7 text-xs"
                    onClick={() => onRejectVersion(entry.itemId, entry.version.id)}
                  >
                    <X className="h-3.5 w-3.5 mr-1" />
                    Reject
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => onApproveVersion(entry.itemId, entry.version.id)}
                  >
                    <Check className="h-3.5 w-3.5 mr-1" />
                    Approve
                  </Button>
                </div>
              )}
            </div>
          </div>
        );
      })}
      {archives.map((entry) => (
        <ArchiveSuggestionCard
          key={entry.suggestion.id}
          entry={entry}
          departments={departments}
        />
      ))}
    </div>
  );
}

function ArchiveSuggestionCard({
  entry,
  departments,
}: {
  entry: PendingMemoryArchiveReview;
  departments: Project[];
}) {
  const dept = entry.item.departmentId
    ? departments.find((d) => d.id === entry.item.departmentId)
    : null;
  const reason = typeof entry.suggestion.actionPayload?.reason === "string"
    ? entry.suggestion.actionPayload.reason
    : null;

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-muted/20">
      <div className="p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">{entry.item.title}</span>
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              archive suggestion
            </Badge>
          </div>
          <span className="text-xs text-muted-foreground">{formatDate(entry.suggestion.createdAt)}</span>
        </div>
        <div className="text-xs text-muted-foreground">
          {entry.suggestion.title}
        </div>
        {reason && (
          <div className="text-xs text-muted-foreground p-2 rounded bg-background/70 border border-border">
            <span className="font-medium">Reason:</span> {reason}
          </div>
        )}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="capitalize">{entry.item.category}</span>
          {dept && (
            <>
              <span>&middot;</span>
              <span>{dept.name}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Create Memory Dialog ───────────────────────────────────────────────

function CreateMemoryDialog({
  open,
  onOpenChange,
  companyId,
  departments,
  canCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  departments: Project[];
  canCreate: boolean;
}) {
  const invalidateMemoryQueries = useInvalidateMemory(companyId);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState<string>("reference");
  const [tagsInput, setTagsInput] = useState("");
  const [departmentId, setDepartmentId] = useState<string>("none");
  const [layer, setLayer] = useState<string>("domain");
  const [priority, setPriority] = useState<number>(0);
  const [visibility, setVisibility] = useState<string>("scoped");
  const [expiresAt, setExpiresAt] = useState<string>("");
  const [goalId, setGoalId] = useState<string>("none");
  const [taskId, setTaskId] = useState<string>("none");

  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(companyId),
    queryFn: () => goalsApi.list(companyId),
    enabled: open && layer === "active_context",
  });

  const { data: tasks } = useQuery({
    queryKey: queryKeys.issues.list(companyId),
    queryFn: () => issuesApi.list(companyId),
    enabled: open && layer === "working",
  });

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      memoryApi.create(companyId, data),
    onSuccess: () => {
      invalidateMemoryQueries();
      onOpenChange(false);
      resetForm();
    },
  });

  function resetForm() {
    setTitle("");
    setContent("");
    setCategory("reference");
    setTagsInput("");
    setDepartmentId("none");
    setLayer("domain");
    setPriority(0);
    setVisibility("scoped");
    setExpiresAt("");
    setGoalId("none");
    setTaskId("none");
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canCreate || !title.trim() || !content.trim()) return;

    const tags = tagsInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    createMutation.mutate({
      title: title.trim(),
      content: content.trim(),
      category,
      source: "founder",
      status: "approved",
      tags,
      departmentId: departmentId !== "none" ? departmentId : null,
      createdBy: "founder",
      layer,
      priority,
      visibility,
      expiresAt: expiresAt || null,
      goalId: goalId !== "none" ? goalId : null,
      taskId: taskId !== "none" ? taskId : null,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add to Memory</DialogTitle>
          <DialogDescription className="sr-only">Create a new memory item</DialogDescription>
        </DialogHeader>
        <DialogBody>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="mem-title">Title</Label>
            <Input
              id="mem-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Memory item title"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mem-content">Content</Label>
            <Textarea
              id="mem-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Describe the knowledge..."
              rows={4}
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEMORY_ITEM_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c} className="capitalize">
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Layer</Label>
              <Select value={layer} onValueChange={setLayer}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEMORY_ITEM_LAYERS.map((l) => (
                    <SelectItem key={l} value={l}>
                      {LAYER_LABELS[l]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Label className="cursor-help border-b border-dotted border-muted-foreground">
                      Priority
                    </Label>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Higher priority items take precedence when two items in the same layer conflict</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <Input
                type="number"
                value={priority}
                onChange={(e) => setPriority(parseInt(e.target.value) || 0)}
                className="h-8 text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Label className="cursor-help border-b border-dotted border-muted-foreground">
                      Visibility
                    </Label>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Shared items are visible to all departments</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <Select value={visibility} onValueChange={setVisibility}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEMORY_ITEM_VISIBILITY.map((v) => (
                    <SelectItem key={v} value={v} className="capitalize">
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Conditional fields based on layer */}
          {layer === "active_context" && (
            <>
              <div className="space-y-1.5">
                <Label>Expires At</Label>
                <Input
                  type="date"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Goal</Label>
                <Select value={goalId} onValueChange={setGoalId}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {(goals ?? []).map((g: Goal) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {layer === "working" && (
            <div className="space-y-1.5">
              <Label>Task</Label>
              <Select value={taskId} onValueChange={setTaskId}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {(tasks ?? []).map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="mem-tags">Tags (comma-separated)</Label>
            <Input
              id="mem-tags"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="e.g. frontend, design, api"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Department</Label>
            <Select value={departmentId} onValueChange={setDepartmentId}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None (company-wide)</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canCreate || !title.trim() || !content.trim() || createMutation.isPending}
            >
              {createMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

// ── Memory Empty State ────────────────────────────────────────────────────────

function MemoryEmptyState({
  hasActiveFilters,
  onAddItem,
  onBrowseTemplates,
}: {
  hasActiveFilters: boolean;
  onAddItem: () => void;
  onBrowseTemplates: () => void;
}) {
  if (hasActiveFilters) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
        <Brain className="h-8 w-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">No memory items match the current filters</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/20 p-6 flex flex-col items-center gap-4 text-center">
        <div className="rounded-full bg-violet-100 dark:bg-violet-900/30 p-3">
          <Brain className="h-6 w-6 text-violet-600 dark:text-violet-400" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">Your memory palace is empty</p>
          <p className="text-xs text-muted-foreground max-w-sm">
            Memory stores decisions, preferences, and standards that your agents use to produce
            consistent, on-brand work. Start from scratch or seed it with a starter template.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onAddItem}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add item
          </Button>
          <Button size="sm" onClick={onBrowseTemplates} className="gap-1.5">
            <Sparkles className="h-3.5 w-3.5" />
            Browse starter templates
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Starter Templates Dialog ──────────────────────────────────────────────────

const FUNCTION_TYPE_LABELS: Record<string, string> = {
  software_development: "Engineering",
  marketing: "Marketing",
  product_management: "Product",
  sales: "Sales",
  customer_support: "Support",
  design: "Design",
  finance: "Finance",
  operations: "Operations",
  people_ops: "People & HR",
  legal: "Legal",
  data_analytics: "Data",
  general: "General",
};

function StarterTemplatesDialog({
  open,
  onOpenChange,
  companyId,
  departments,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  departments: Project[];
  onApplied: () => void;
}) {
  const [selectedTemplate, setSelectedTemplate] = useState<MemoryStarterTemplate | null>(null);
  const [departmentId, setDepartmentId] = useState<string>("none");
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());

  const { data: templates, isLoading } = useQuery({
    queryKey: queryKeys.memory.starterTemplates(companyId),
    queryFn: () => memoryStarterTemplatesApi.list(companyId),
    enabled: open && !!companyId,
    staleTime: Infinity,
  });

  const applyMutation = useMutation({
    mutationFn: ({ templateId }: { templateId: string }) =>
      memoryStarterTemplatesApi.apply(companyId, templateId, {
        departmentId: departmentId !== "none" ? departmentId : null,
      }),
    onSuccess: (result, { templateId }) => {
      onApplied();
      setAppliedIds((prev) => new Set([...prev, templateId]));
      if (!result.alreadyApplied) {
        setSelectedTemplate(null);
      }
    },
  });

  // Reset selection when dialog closes
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setSelectedTemplate(null);
      setDepartmentId("none");
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          {selectedTemplate ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSelectedTemplate(null)}
                className="rounded-md p-1 hover:bg-muted transition-colors"
                aria-label="Back to templates"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <div>
                <DialogTitle className="text-base">{selectedTemplate.name} template</DialogTitle>
                <p className="text-xs text-muted-foreground mt-0.5">{selectedTemplate.description}</p>
              </div>
            </div>
          ) : (
            <div>
              <DialogTitle className="text-base">Memory starter templates</DialogTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                Seed your memory with opinionated defaults for your team. You can edit anything after applying.
              </p>
            </div>
          )}
          <DialogDescription className="sr-only">
            Browse and apply memory starter templates for your departments
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex-1 min-h-0 overflow-hidden">
          <div className="overflow-y-auto h-full -mx-1 px-1">
          {selectedTemplate ? (
            <TemplateDetailView
              template={selectedTemplate}
              departments={departments}
              departmentId={departmentId}
              onDepartmentChange={setDepartmentId}
              isApplying={applyMutation.isPending}
              alreadyApplied={appliedIds.has(selectedTemplate.id)}
              onApply={() => applyMutation.mutate({ templateId: selectedTemplate.id })}
            />
          ) : isLoading ? (
            <div className="grid grid-cols-2 gap-3 py-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-24 rounded-lg border border-border bg-muted/30 animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 py-2">
              {(templates ?? []).map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => setSelectedTemplate(template)}
                  className="rounded-lg border border-border bg-card p-4 text-left hover:bg-accent/40 hover:border-primary/30 transition-colors relative"
                >
                  {appliedIds.has(template.id) && (
                    <span className="absolute top-2 right-2">
                      <Badge
                        variant="secondary"
                        className="text-[10px] px-1.5 py-0 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                      >
                        <Check className="h-2.5 w-2.5 mr-0.5" />
                        applied
                      </Badge>
                    </span>
                  )}
                  <div className="text-xs font-medium text-muted-foreground mb-1">
                    {FUNCTION_TYPE_LABELS[template.functionType] ?? template.functionType}
                  </div>
                  <div className="text-sm font-semibold">{template.name}</div>
                  <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
                    {template.description}
                  </div>
                  <div className="text-xs text-muted-foreground mt-2">
                    {template.items.length} items
                  </div>
                </button>
              ))}
            </div>
          )}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function TemplateDetailView({
  template,
  departments,
  departmentId,
  onDepartmentChange,
  isApplying,
  alreadyApplied,
  onApply,
}: {
  template: MemoryStarterTemplate;
  departments: Project[];
  departmentId: string;
  onDepartmentChange: (id: string) => void;
  isApplying: boolean;
  alreadyApplied: boolean;
  onApply: () => void;
}) {
  return (
    <div className="space-y-4 py-2">
      {/* Department scope picker */}
      <div className="flex items-center gap-3">
        <Label className="shrink-0 text-sm">Scope to department</Label>
        <Select value={departmentId} onValueChange={onDepartmentChange}>
          <SelectTrigger className="h-8 text-sm flex-1">
            <SelectValue placeholder="Company-wide (no department)" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Company-wide (no department)</SelectItem>
            {departments.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          onClick={onApply}
          disabled={isApplying || alreadyApplied}
          className="shrink-0"
        >
          {isApplying ? (
            "Applying..."
          ) : alreadyApplied ? (
            <>
              <Check className="h-3.5 w-3.5 mr-1.5" />
              Applied
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              Apply template
            </>
          )}
        </Button>
      </div>

      {alreadyApplied && (
        <div className="text-xs text-muted-foreground p-2 rounded-md bg-muted/30 border border-border">
          This template has already been applied to this company. You can apply it again by choosing a different department scope.
        </div>
      )}

      {/* Items preview */}
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground font-medium">
          {template.items.length} items that will be added
        </p>
        {template.items.map((item, i) => (
          <div
            key={i}
            className="rounded-md border border-border bg-card px-3 py-2.5 space-y-1"
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{item.title}</span>
              <Badge
                variant="secondary"
                className={cn(
                  "text-[10px] px-1.5 py-0 capitalize",
                  CATEGORY_COLORS[item.category as MemoryItemCategory] ?? "",
                )}
              >
                {item.category}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground line-clamp-2">{item.content}</p>
            {item.tags && item.tags.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap">
                {item.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
