import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialog } from "../context/DialogContext";
import { useToast } from "../context/ToastContext";
import { discussionsApi, type DiscussionEntry, type ExtractedItem, type Annotation } from "../api/discussions";
import { agentsApi } from "../api/agents";
import { healthApi } from "../api/health";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertTriangle,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  ClipboardPen,
  ExternalLink,
  Loader2,
  MessageCirclePlus,
  MessageSquare,
  Mic,
  Pencil,
  PenLine,
  Plus,
  Plug,
  RefreshCw,
  X,
  XCircle,
} from "lucide-react";
import { cn, relativeTime } from "../lib/utils";

/* ─── Constants ─── */

const SOURCE_ICONS: Record<string, typeof ClipboardPen> = {
  paste: ClipboardPen,
  write: PenLine,
  voice: Mic,
  mcp: Plug,
};

const SOURCE_LABELS: Record<string, string> = {
  paste: "Paste",
  write: "Write",
  voice: "Voice",
  mcp: "MCP",
};

const TYPE_COLORS: Record<string, string> = {
  decision: "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300",
  task: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  insight: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  context: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  reference: "bg-stone-200 text-stone-800 dark:bg-stone-800/30 dark:text-stone-300",
  preference: "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300",
};

const PRIORITY_COLORS: Record<string, string> = {
  urgent: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  high: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  medium: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  low: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-300",
};

const MEMORY_TYPES = new Set(["decision", "insight", "context", "reference", "preference"]);

type FilterChip = "all" | "tasks" | "decisions" | "memory" | "approved" | "rejected";

/** Map extracted item across all entries, keeping entryId for mutations */
interface FlatItem {
  item: ExtractedItem;
  entryId: string;
}

function humanLayer(layer: string | null | undefined) {
  return (layer ?? "domain").replaceAll("_", " ");
}

/** CLI error kinds written by the server's CLI extraction path. */
type CliExtractionErrorKind =
  | "not_installed"
  | "not_authed"
  | "timeout"
  | "nonzero_exit"
  | "unparseable"
  /** U13.3: no isolated sandbox was available for a cloud (`cloud_auth`)
   *  extraction spawn — a provider-key/config problem, never a "missing
   *  local CLI" problem. See extraction-cli.ts's CliErrorKind. */
  | "sandbox_unavailable";

const CLI_ERROR_KINDS = new Set<string>([
  "not_installed",
  "not_authed",
  "timeout",
  "nonzero_exit",
  "unparseable",
  "sandbox_unavailable",
]);

/**
 * Extract the human-readable error message from a discussion entry's sourceInfo.
 * The server stores extractionError as either:
 *   - a plain string (legacy API/provider path)
 *   - an object { kind, message } (CLI path, T7a)
 */
function getExtractionError(sourceInfo: Record<string, unknown> | null): string | null {
  if (!sourceInfo) return null;
  const raw = sourceInfo.extractionError;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && "message" in raw && typeof (raw as Record<string, unknown>).message === "string") {
    return (raw as Record<string, unknown>).message as string;
  }
  return null;
}

/**
 * Extract the error kind from sourceInfo, if the server wrote a CLI-path
 * structured error ({ kind, message }). Returns null for legacy string errors.
 */
function getExtractionErrorKind(sourceInfo: Record<string, unknown> | null): CliExtractionErrorKind | null {
  if (!sourceInfo) return null;
  const raw = sourceInfo.extractionError;
  if (raw && typeof raw === "object" && "kind" in raw) {
    const kind = (raw as Record<string, unknown>).kind;
    if (typeof kind === "string" && CLI_ERROR_KINDS.has(kind)) {
      return kind as CliExtractionErrorKind;
    }
  }
  return null;
}

/**
 * Pure helper: returns actionable copy for an extraction failure.
 * CLI kinds get specific guidance; legacy/unknown kinds fall through.
 * Exported for unit testing.
 */
export function extractionFailureMessage(
  kind: CliExtractionErrorKind | null,
  message: string | null,
  opts: { multiTenant?: boolean } = {},
): { primary: string; showSettings: boolean } {
  switch (kind) {
    case "not_installed":
      // Prefer the server's CLI-specific message (e.g. "codex CLI not found")
      // so codex-configured companies aren't told to fix Claude (P3, Codex).
      return {
        primary:
          message ?? "Extraction CLI not detected. Install your configured CLI and sign in.",
        showSettings: false,
      };
    case "not_authed":
      return {
        primary:
          message ?? "Extraction CLI is not logged in. Run its login flow.",
        showSettings: false,
      };
    case "timeout":
      return {
        primary: "Extraction timed out. Try Reprocess.",
        showSettings: false,
      };
    case "nonzero_exit":
    case "unparseable":
      return {
        primary: `Extraction failed — try Reprocess.${message ? ` ${message}` : ""}`,
        showSettings: false,
      };
    case "sandbox_unavailable":
      // U13.3: sandbox_unavailable IS actionable on cloud: extraction there runs
      // inside an ephemeral sandbox authenticated with the company's own provider
      // key, so a missing/invalid key or execution-environment config is exactly
      // what Settings → Providers fixes. This is the ONLY credential-shaped
      // extraction failure surfaced on cloud — not_authed/not_installed (a
      // missing LOCAL CLI login) are unreachable when extraction runs in-sandbox.
      // Never "install a CLI" copy — there is no local CLI on a sandboxed spawn.
      return {
        primary:
          message ??
          "Extraction could not run: no isolated sandbox was available. Check your provider key and execution environment in Settings.",
        showSettings: true,
      };
    default: {
      // Legacy/unknown kind. Extraction is CLI-only (Decision #104, amended
      // 2026-06-27) — it never reads a hosted key, so failures never point at
      // a provider key / Settings. Surface the raw message with no Settings
      // escape hatch; the CLI kinds above carry the actionable guidance.
      return {
        primary: message ?? "Extraction failed.",
        showSettings: false,
      };
    }
  }
}


/* ════════════════════════════════════════════════════════════════════════
   Main Page Component
   ════════════════════════════════════════════════════════════════════════ */

export function DiscussionDetail() {
  const { discussionId } = useParams<{ discussionId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs, setSubtitle, setEntityColor } = useBreadcrumbs();
  const { openDiscussionCapture } = useDialog();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  // ── State ──
  const [activeFilter, setActiveFilter] = useState<FilterChip>("all");
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [slideOverItem, setSlideOverItem] = useState<FlatItem | null>(null);

  // ── Queries ──
  const { data: discussion, isLoading } = useQuery({
    queryKey: queryKeys.discussions.detail(selectedCompanyId!, discussionId!),
    queryFn: () => discussionsApi.get(selectedCompanyId!, discussionId!),
    enabled: !!selectedCompanyId && !!discussionId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // ── Breadcrumbs ──
  useEffect(() => {
    setBreadcrumbs([
      { label: "Discussions", href: "/discussions" },
      { label: discussion?.title ?? "Discussion" },
    ]);
    setEntityColor("var(--entity-brief)");
    return () => { setSubtitle(null); setEntityColor(null); };
  }, [discussion?.title, setBreadcrumbs, setSubtitle, setEntityColor]);

  useEffect(() => {
    if (!discussion) return;
    setSubtitle(
      discussion.pendingItemCount > 0
        ? `${discussion.pendingItemCount} items pending`
        : null,
    );
  }, [discussion, setSubtitle]);

  // ── Flatten all items from all entries ──
  const flatItems = useMemo<FlatItem[]>(() => {
    if (!discussion) return [];
    return discussion.entries.flatMap((entry) =>
      entry.extractedItems.map((item) => ({ item, entryId: entry.id })),
    );
  }, [discussion]);

  // ── Filter counts ──
  const filterCounts = useMemo(() => {
    const counts = { all: 0, tasks: 0, decisions: 0, memory: 0, approved: 0, rejected: 0 };
    for (const { item } of flatItems) {
      counts.all++;
      if (item.status === "approved" || item.status === "edited") { counts.approved++; continue; }
      if (item.status === "rejected") { counts.rejected++; continue; }
      // pending items — count by type
      if (item.type === "task") counts.tasks++;
      else if (item.type === "decision") counts.decisions++;
      else if (MEMORY_TYPES.has(item.type)) counts.memory++;
    }
    return counts;
  }, [flatItems]);

  // ── Filtered items ──
  const filteredItems = useMemo(() => {
    return flatItems.filter(({ item }) => {
      switch (activeFilter) {
        case "tasks": return item.type === "task" && item.status === "pending";
        case "decisions": return item.type === "decision" && item.status === "pending";
        case "memory": return MEMORY_TYPES.has(item.type) && item.status === "pending";
        case "approved": return item.status === "approved" || item.status === "edited";
        case "rejected": return item.status === "rejected";
        default: return true;
      }
    });
  }, [flatItems, activeFilter]);

  // ── Pending items for batch actions ──
  const pendingItemIds = useMemo(() => {
    return flatItems
      .filter(({ item }) => item.status === "pending")
      .map(({ item }) => item.id);
  }, [flatItems]);

  // ── Reprocessable count ──
  const reprocessableCount = useMemo(() => {
    if (!discussion) return 0;
    return discussion.entries.filter(
      (e) => e.extractionStatus === "failed" || e.extractionStatus === "pending" || e.extractionStatus === "skipped",
    ).length;
  }, [discussion]);

  // ── Mutations ──
  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.discussions.detail(selectedCompanyId!, discussionId!),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.discussions.list(selectedCompanyId!),
    });
  }, [queryClient, selectedCompanyId, discussionId]);

  const approveMutation = useMutation({
    mutationFn: (itemIds: string[]) =>
      discussionsApi.approveItems(selectedCompanyId!, discussionId!, {
        items: itemIds.map((id) => ({ itemId: id, action: "approved" as const })),
      }),
    onSuccess: (result) => {
      invalidate();
      setSelectedItemIds(new Set());
      pushToast({
        title: "Items approved",
        body: `${result.tasksCreated.length} tasks, ${result.memoryItemsCreated.length} memory items created`,
        tone: "success",
      });
    },
    onError: () => {
      pushToast({ title: "Failed to approve items", tone: "warn" });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (itemIds: string[]) =>
      discussionsApi.rejectItems(selectedCompanyId!, discussionId!, itemIds),
    onSuccess: () => {
      invalidate();
      setSelectedItemIds(new Set());
    },
    onError: () => {
      pushToast({ title: "Failed to reject items", tone: "warn" });
    },
  });

  const reprocessMutation = useMutation({
    mutationFn: (entryId: string) =>
      discussionsApi.reprocessEntry(selectedCompanyId!, discussionId!, entryId),
    onSuccess: () => {
      invalidate();
      pushToast({ title: "Reprocessing entry...", tone: "success" });
    },
    onError: () => {
      pushToast({ title: "Failed to reprocess entry", tone: "warn" });
    },
  });

  const reprocessAllMutation = useMutation({
    mutationFn: () =>
      discussionsApi.reprocessAll(selectedCompanyId!, discussionId!),
    onSuccess: (result) => {
      invalidate();
      pushToast({
        title: "Reprocessing entries...",
        body: `${result.reprocessedCount} entries queued${result.skippedCount > 0 ? `, ${result.skippedCount} skipped` : ""}`,
        tone: "success",
      });
    },
    onError: () => {
      pushToast({ title: "Failed to reprocess entries", tone: "warn" });
    },
  });

  const updateItemMutation = useMutation({
    mutationFn: ({
      entryId,
      itemId,
      data,
    }: {
      entryId: string;
      itemId: string;
      data: Record<string, unknown>;
    }) => discussionsApi.updateItem(selectedCompanyId!, discussionId!, entryId, itemId, data),
    onSuccess: () => {
      invalidate();
      pushToast({ title: "Item updated", tone: "success" });
    },
    onError: () => {
      pushToast({ title: "Failed to update item", tone: "warn" });
    },
  });

  const addAnnotationMutation = useMutation({
    mutationFn: ({
      entryId,
      data,
    }: {
      entryId: string;
      data: { content: string; anchorStart: number | null; anchorEnd: number | null };
    }) => discussionsApi.addAnnotation(selectedCompanyId!, discussionId!, entryId, data),
    onSuccess: () => {
      invalidate();
      pushToast({ title: "Annotation added", tone: "success" });
    },
    onError: () => {
      pushToast({ title: "Failed to add annotation", tone: "warn" });
    },
  });

  // ── Selection helpers ──
  const toggleSelect = useCallback((id: string) => {
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllVisible = useCallback(() => {
    const pendingVisible = filteredItems
      .filter(({ item }) => item.status === "pending")
      .map(({ item }) => item.id);
    setSelectedItemIds(new Set(pendingVisible));
  }, [filteredItems]);

  // ── Loading / not found ──
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!discussion) {
    return (
      <div className="flex flex-col items-center gap-3 py-20">
        <p className="text-sm text-muted-foreground">Discussion not found</p>
        <Link to="/discussions" className="text-sm text-blue-600 hover:underline">
          Back to Discussions
        </Link>
      </div>
    );
  }

  const selectedPendingIds = [...selectedItemIds].filter((id) =>
    flatItems.some(({ item }) => item.id === id && item.status === "pending"),
  );

  return (
    <div className="space-y-6">
      {/* ═══ HEADER ═══ */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">{discussion.title}</h1>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className="text-xs text-muted-foreground">
              {discussion.entryCount} {discussion.entryCount === 1 ? "entry" : "entries"}
            </span>
            {discussion.scopeName && (
              <Badge variant="outline" className="text-[10px]">
                {discussion.scopeName}
              </Badge>
            )}
            {discussion.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="text-[10px]">
                {tag}
              </Badge>
            ))}
            <Badge
              variant="outline"
              className={cn(
                "text-[10px]",
                discussion.status === "archived" && "opacity-60",
              )}
            >
              {discussion.status}
            </Badge>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            openDiscussionCapture({
              existingDiscussionId: discussionId,
              scopeType: discussion.scopeType ?? undefined,
              scopeId: discussion.scopeId ?? undefined,
            })
          }
        >
          <Plus className="h-4 w-4 mr-1.5" />
          Add Entry
        </Button>
      </div>

      {/* ═══ THREAD ZONE ═══ */}
      <section>
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Thread
        </h2>
        <div className="space-y-1.5">
          {discussion.entries.map((entry) => (
            <ThreadEntryRow
              key={entry.id}
              entry={entry}
              onReprocess={() => reprocessMutation.mutate(entry.id)}
              onAddAnnotation={(content, start, end) =>
                addAnnotationMutation.mutate({
                  entryId: entry.id,
                  data: { content, anchorStart: start, anchorEnd: end },
                })
              }
              isReprocessing={reprocessMutation.isPending && reprocessMutation.variables === entry.id}
            />
          ))}
        </div>
      </section>

      {/* ═══ ITEMS ZONE ═══ */}
      <section>
        {/* Section header with Reprocess All */}
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Items to Review
          </h2>
          <div className="flex items-center gap-2">
            {reprocessableCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => reprocessAllMutation.mutate()}
                disabled={reprocessAllMutation.isPending}
              >
                {reprocessAllMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                )}
                Reprocess All ({reprocessableCount})
              </Button>
            )}
          </div>
        </div>

        {/* Filter chips */}
        <div className="flex items-center gap-1.5 mb-4 flex-wrap" role="group" aria-label="Filter items">
          {(
            [
              ["all", `All (${filterCounts.all})`],
              ["tasks", `Tasks (${filterCounts.tasks})`],
              ["decisions", `Decisions (${filterCounts.decisions})`],
              ["memory", `Memory (${filterCounts.memory})`],
              ["approved", `Approved (${filterCounts.approved})`],
              ["rejected", `Rejected (${filterCounts.rejected})`],
            ] as [FilterChip, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              aria-pressed={activeFilter === key}
              onClick={() => { setActiveFilter(key); setSelectedItemIds(new Set()); }}
              className={cn(
                "inline-flex items-center rounded-full px-3 py-1 text-xs font-medium transition-colors",
                activeFilter === key
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:bg-muted/80",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Batch action bar */}
        {selectedPendingIds.length > 0 && (
          <div className="flex items-center gap-2 mb-3 p-2 rounded-md bg-muted/50 border border-border">
            <span className="text-xs text-muted-foreground">
              {selectedPendingIds.length} selected
            </span>
            <Button
              size="sm"
              variant="default"
              onClick={() => approveMutation.mutate(selectedPendingIds)}
              disabled={approveMutation.isPending}
            >
              {approveMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              ) : (
                <CheckCheck className="h-3.5 w-3.5 mr-1" />
              )}
              Approve Selected
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => rejectMutation.mutate(selectedPendingIds)}
              disabled={rejectMutation.isPending}
            >
              <X className="h-3.5 w-3.5 mr-1" />
              Reject Selected
            </Button>
            <button
              onClick={() => setSelectedItemIds(new Set())}
              className="text-xs text-muted-foreground hover:text-foreground ml-auto"
            >
              Clear
            </button>
          </div>
        )}

        {/* Select all helper */}
        {activeFilter !== "approved" && activeFilter !== "rejected" && pendingItemIds.length > 0 && selectedPendingIds.length === 0 && (
          <div className="flex items-center gap-2 mb-3">
            <button
              onClick={selectAllVisible}
              className="text-xs text-blue-600 hover:underline"
            >
              Select all visible pending items
            </button>
          </div>
        )}

        {/* Item cards */}
        <div className="space-y-2">
          {filteredItems.length === 0 && (
            <div className="text-center py-8">
              <p className="text-sm text-muted-foreground">
                {flatItems.length === 0
                  ? "No items extracted yet. Click Reprocess to extract items from your entries."
                  : "No items match this filter."}
              </p>
            </div>
          )}
          {filteredItems.map(({ item, entryId }) => (
            <ItemCard
              key={item.id}
              item={item}
              selected={selectedItemIds.has(item.id)}
              onToggleSelect={() => toggleSelect(item.id)}
              onClick={() => setSlideOverItem({ item, entryId })}
            />
          ))}
        </div>
      </section>

      {/* ═══ RELATED DISCUSSIONS ═══ */}
      {discussion.scopeType && discussion.scopeId && (
        <RelatedDiscussions
          companyId={selectedCompanyId!}
          scopeType={discussion.scopeType}
          scopeId={discussion.scopeId}
          currentDiscussionId={discussion.id}
        />
      )}

      {/* ═══ ITEM MODAL ═══ */}
      <ItemModal
        flatItem={slideOverItem}
        open={!!slideOverItem}
        onClose={() => setSlideOverItem(null)}
        agents={agents}
        onApprove={(id) => {
          approveMutation.mutate([id]);
          setSlideOverItem(null);
        }}
        onReject={(id) => {
          rejectMutation.mutate([id]);
          setSlideOverItem(null);
        }}
        onUpdate={(entryId, itemId, data) => {
          updateItemMutation.mutate({ entryId, itemId, data });
        }}
        isUpdating={updateItemMutation.isPending}
      />
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Thread Entry Row — compact, collapsible
   ════════════════════════════════════════════════════════════════════════ */

function ThreadEntryRow({
  entry,
  onReprocess,
  onAddAnnotation,
  isReprocessing,
}: {
  entry: DiscussionEntry;
  onReprocess: () => void;
  onAddAnnotation: (content: string, anchorStart: number | null, anchorEnd: number | null) => void;
  isReprocessing: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showAnnotationInput, setShowAnnotationInput] = useState(false);
  const [annotationText, setAnnotationText] = useState("");
  const [selectedRange, setSelectedRange] = useState<{ start: number; end: number } | null>(null);
  const contentRef = useRef<HTMLParagraphElement>(null);

  const SourceIcon = SOURCE_ICONS[entry.inputType] ?? MessageSquare;
  const sourceLabel = SOURCE_LABELS[entry.inputType] ?? entry.inputType;
  const itemCount = entry.extractedItems.length;
  const pendingCount = entry.extractedItems.filter((i) => i.status === "pending").length;

  const handleTextSelect = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !contentRef.current) return;
    if (!contentRef.current.contains(selection.anchorNode)) return;
    const range = selection.getRangeAt(0);
    const preRange = document.createRange();
    preRange.setStart(contentRef.current, 0);
    preRange.setEnd(range.startContainer, range.startOffset);
    const start = preRange.toString().length;
    const end = start + range.toString().length;
    if (end > start) {
      setSelectedRange({ start, end });
      setShowAnnotationInput(true);
    }
  }, []);

  function submitAnnotation() {
    if (!annotationText.trim()) return;
    onAddAnnotation(
      annotationText.trim(),
      selectedRange?.start ?? null,
      selectedRange?.end ?? null,
    );
    setAnnotationText("");
    setShowAnnotationInput(false);
    setSelectedRange(null);
  }

  // Rendered content with annotation highlights
  const renderedContent = useMemo(() => {
    if (!entry.annotations || entry.annotations.length === 0) return null;
    const anchored = entry.annotations.filter(
      (a) => a.anchorStart != null && a.anchorEnd != null,
    );
    if (anchored.length === 0) return null;

    const text = entry.rawContent;
    const charMap: Annotation[][] = new Array(text.length);
    for (let i = 0; i < text.length; i++) charMap[i] = [];
    for (const ann of anchored) {
      const start = Math.max(0, ann.anchorStart!);
      const end = Math.min(text.length, ann.anchorEnd!);
      for (let i = start; i < end; i++) charMap[i].push(ann);
    }

    const segments: { text: string; annotations: Annotation[] }[] = [];
    let segStart = 0;
    for (let i = 1; i <= text.length; i++) {
      const prevAnns = charMap[i - 1];
      const currAnns = i < text.length ? charMap[i] : [];
      const same =
        prevAnns.length === currAnns.length &&
        prevAnns.every((a, idx) => a.id === currAnns[idx]?.id);
      if (!same || i === text.length) {
        segments.push({ text: text.slice(segStart, i), annotations: prevAnns });
        segStart = i;
      }
    }
    return segments;
  }, [entry.rawContent, entry.annotations]);

  const generalAnnotations = useMemo(
    () => (entry.annotations ?? []).filter((a) => a.anchorStart == null),
    [entry.annotations],
  );

  const extractionError = getExtractionError(entry.sourceInfo);
  const extractionErrorKind = getExtractionErrorKind(entry.sourceInfo);
  const { data: health } = useQuery({ queryKey: queryKeys.health, queryFn: () => healthApi.get() });
  const failureCopy = extractionFailureMessage(extractionErrorKind, extractionError, {
    multiTenant: health?.deploymentMode === "cloud_auth",
  });

  return (
    <div className="rounded-lg border border-border bg-card">
      {/* Compact header row */}
      <button
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="flex items-center gap-2 w-full px-3 py-2.5 text-left hover:bg-muted/30 transition-colors rounded-lg"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
        <SourceIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">{sourceLabel}</span>
        <span className="text-xs text-muted-foreground">{relativeTime(entry.createdAt)}</span>
        <ExtractionStatusBadge status={entry.extractionStatus} />
        {itemCount > 0 && (
          <span className="text-[10px] text-muted-foreground ml-auto">
            {pendingCount > 0 ? `${pendingCount} pending / ` : ""}{itemCount} items
          </span>
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-border pt-3">
          {/* Raw content */}
          <div className="rounded-md bg-muted/30 p-3">
            <p
              ref={contentRef}
              onMouseUp={handleTextSelect}
              className="text-sm whitespace-pre-wrap text-muted-foreground leading-relaxed select-text cursor-text"
            >
              {renderedContent
                ? renderedContent.map((seg, i) =>
                    seg.annotations.length > 0 ? (
                      <span
                        key={i}
                        className="bg-yellow-200/60 dark:bg-yellow-800/40 border-b border-yellow-400 dark:border-yellow-600 cursor-help"
                        title={seg.annotations.map((a) => a.content).join("\n---\n")}
                      >
                        {seg.text}
                      </span>
                    ) : (
                      <span key={i}>{seg.text}</span>
                    ),
                  )
                : entry.rawContent}
            </p>
          </div>

          {/* General annotations */}
          {generalAnnotations.length > 0 && (
            <div className="space-y-1">
              {generalAnnotations.map((ann) => (
                <div
                  key={ann.id}
                  className="flex items-start gap-2 rounded-md bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 p-2"
                >
                  <MessageCirclePlus className="h-3.5 w-3.5 text-yellow-600 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-xs text-yellow-800 dark:text-yellow-300">{ann.content}</p>
                    <span className="text-[10px] text-yellow-600/80">
                      {new Date(ann.createdAt).toLocaleString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Annotation input */}
          {showAnnotationInput && (
            <div className="flex items-start gap-2 rounded-md border border-yellow-300 dark:border-yellow-700 bg-yellow-50/50 dark:bg-yellow-950/20 p-3">
              <MessageCirclePlus className="h-4 w-4 text-yellow-600 shrink-0 mt-1" />
              <div className="flex-1 space-y-2">
                {selectedRange && (
                  <p className="text-[10px] text-yellow-700 dark:text-yellow-400">
                    Annotating: &ldquo;{entry.rawContent.slice(selectedRange.start, Math.min(selectedRange.end, selectedRange.start + 80))}
                    {selectedRange.end - selectedRange.start > 80 ? "..." : ""}&rdquo;
                  </p>
                )}
                <Textarea
                  value={annotationText}
                  onChange={(e) => setAnnotationText(e.target.value)}
                  placeholder={selectedRange ? "Add a note about this selection..." : "Add a general note to this entry..."}
                  className="min-h-[60px] text-sm resize-y bg-white dark:bg-background"
                  autoFocus
                />
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setShowAnnotationInput(false);
                      setAnnotationText("");
                      setSelectedRange(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button size="sm" onClick={submitAnnotation} disabled={!annotationText.trim()}>
                    Add Note
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Processing / failed / skipped status messages */}
          {entry.extractionStatus === "processing" && (
            <div className="flex items-center gap-2 rounded-md bg-muted/50 p-3">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Extracting items...</span>
            </div>
          )}

          {entry.extractionStatus === "failed" && (
            <div
              data-testid="extraction-failure-banner"
              className="flex flex-col gap-1 rounded-md bg-red-50 dark:bg-red-950/30 p-3"
            >
              <div className="flex items-center gap-2">
                <XCircle className="h-4 w-4 text-red-600 shrink-0" />
                <span className="text-sm text-red-700 dark:text-red-400">
                  Extraction failed
                </span>
              </div>
              <p className="text-xs text-red-600/80 dark:text-red-400/80 ml-6">
                {failureCopy.primary}
              </p>
              {failureCopy.showSettings && (
                <Link
                  to="/settings?tab=providers"
                  className="ml-6 text-xs text-red-700 dark:text-red-400 underline underline-offset-2"
                >
                  Open Settings → Providers
                </Link>
              )}
            </div>
          )}

          {entry.extractionStatus === "skipped" && (
            <div className="flex flex-col gap-1 rounded-md bg-amber-50 dark:bg-amber-950/30 p-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
                <span className="text-sm text-amber-700 dark:text-amber-400">
                  Extraction skipped
                </span>
              </div>
              {(extractionError || extractionErrorKind) && (
                <p className="text-xs text-amber-600/80 dark:text-amber-400/80 ml-6">
                  {failureCopy.primary}
                </p>
              )}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelectedRange(null);
                setShowAnnotationInput((p) => !p);
              }}
              className={cn("text-xs", showAnnotationInput && "bg-accent")}
            >
              <MessageCirclePlus className="h-3.5 w-3.5 mr-1" />
              Annotate
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onReprocess}
              disabled={isReprocessing || entry.extractionStatus === "processing"}
              className="text-xs"
            >
              <RefreshCw className={cn("h-3.5 w-3.5 mr-1", isReprocessing && "animate-spin")} />
              Reprocess
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Extraction Status Badge
   ════════════════════════════════════════════════════════════════════════ */

function ExtractionStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: "bg-muted text-muted-foreground",
    processing: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    completed: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    failed: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
    skipped: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium capitalize",
        styles[status] ?? styles.pending,
      )}
    >
      {status === "processing" && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
      {status}
    </span>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Item Card — task-card-like in the Items zone
   ════════════════════════════════════════════════════════════════════════ */

function ItemCard({
  item,
  selected,
  onToggleSelect,
  onClick,
}: {
  item: ExtractedItem;
  selected: boolean;
  onToggleSelect: () => void;
  onClick: () => void;
}) {
  const isPending = item.status === "pending";
  const isApproved = item.status === "approved" || item.status === "edited";
  const isRejected = item.status === "rejected";
  const isMemory = MEMORY_TYPES.has(item.type);
  const effectiveLayer = item.layer ?? item.suggestedLayer ?? "domain";

  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-lg border p-3 transition-colors cursor-pointer",
        isApproved && "border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-950/20",
        isRejected && "border-border bg-card opacity-50",
        isPending && "border-border bg-card hover:bg-muted/30",
      )}
      onClick={onClick}
    >
      {/* Checkbox — only for pending items */}
      {isPending && (
        <div onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggleSelect()}
            aria-label={`Select item: ${item.title}`}
          />
        </div>
      )}

      {/* Status icon for non-pending */}
      {isApproved && <Check className="h-4 w-4 text-green-600 shrink-0" />}
      {isRejected && <XCircle className="h-4 w-4 text-muted-foreground shrink-0" />}

      {/* Title + badges */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn("text-sm font-medium truncate", isRejected && "line-through text-muted-foreground")}>
            {item.title}
          </span>
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase shrink-0",
              TYPE_COLORS[item.type] ?? "bg-muted text-muted-foreground",
            )}
          >
            {item.type}
          </span>
          {item.type === "task" && item.suggestedPriority && (
            <span
              className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0",
                PRIORITY_COLORS[item.suggestedPriority] ?? "bg-muted text-muted-foreground",
              )}
            >
              {item.suggestedPriority}
            </span>
          )}
          {isMemory && (
            <Badge variant="outline" className="text-[10px] shrink-0">
              {humanLayer(effectiveLayer)}
            </Badge>
          )}
          {item.conflictsWith && (
            <Badge variant="destructive" className="text-[10px] shrink-0">
              Conflict
            </Badge>
          )}
        </div>
        {item.description && (
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{item.description}</p>
        )}
      </div>

      {/* Links for approved items */}
      {isApproved && (
        <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
          {item.resultTaskId && (
            <Link
              to={`/issues?selected=${item.resultTaskId}`}
              className="text-xs text-blue-600 hover:underline flex items-center gap-1"
            >
              <ExternalLink className="h-3 w-3" />
              View Task
            </Link>
          )}
          {item.resultMemoryId && (
            <Link
              to="/memory"
              className="text-xs text-blue-600 hover:underline flex items-center gap-1"
            >
              <ExternalLink className="h-3 w-3" />
              View Memory
            </Link>
          )}
        </div>
      )}

      {/* Chevron hint for pending */}
      {isPending && (
        <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Item Modal — centered dialog, adapts by type (task vs memory)
   ════════════════════════════════════════════════════════════════════════ */

function ItemModal({
  flatItem,
  open,
  onClose,
  agents,
  onApprove,
  onReject,
  onUpdate,
  isUpdating,
}: {
  flatItem: FlatItem | null;
  open: boolean;
  onClose: () => void;
  agents?: Array<{ id: string; name: string; status: string }>;
  onApprove: (itemId: string) => void;
  onReject: (itemId: string) => void;
  onUpdate: (entryId: string, itemId: string, data: Record<string, unknown>) => void;
  isUpdating: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPriority, setEditPriority] = useState("medium");
  const [editAssigneeId, setEditAssigneeId] = useState("");
  const [editLayer, setEditLayer] = useState("domain");

  // Sync edit state when a new item is opened
  useEffect(() => {
    if (flatItem) {
      setEditTitle(flatItem.item.title);
      setEditDescription(flatItem.item.description ?? "");
      setEditPriority(flatItem.item.suggestedPriority ?? "medium");
      setEditAssigneeId(flatItem.item.suggestedAssigneeId ?? "");
      setEditLayer(flatItem.item.layer ?? flatItem.item.suggestedLayer ?? "domain");
      setEditing(false);
    }
  }, [flatItem]);

  if (!flatItem) return null;

  const { item, entryId } = flatItem;
  const isPending = item.status === "pending";
  const isApproved = item.status === "approved" || item.status === "edited";
  const isRejected = item.status === "rejected";
  const isTask = item.type === "task";
  const isMemory = MEMORY_TYPES.has(item.type);

  function handleSave() {
    const data: Record<string, unknown> = {
      status: "edited",
      title: editTitle,
      description: editDescription,
    };
    if (isTask) {
      data.suggestedPriority = editPriority;
      data.suggestedAssigneeId = editAssigneeId || null;
    }
    if (isMemory) {
      data.layer = editLayer;
    }
    onUpdate(entryId, item.id, data);
    setEditing(false);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-lg gap-0 flex flex-col max-h-[85vh]">
        <DialogHeader className="px-6 pt-6 pb-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={cn(
                "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase",
                TYPE_COLORS[item.type] ?? "bg-muted text-muted-foreground",
              )}
            >
              {item.type}
            </span>
            {isPending && <Badge variant="outline" className="text-[10px]">Pending</Badge>}
            {isApproved && <Badge className="bg-green-100 text-green-800 text-[10px]">Approved</Badge>}
            {isRejected && <Badge variant="secondary" className="text-[10px] opacity-60">Rejected</Badge>}
          </div>
          <DialogTitle className="text-base mt-2">
            {editing ? (
              <Input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="text-base font-semibold"
              />
            ) : (
              item.title
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">Item details</DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6">
          <div className="space-y-4 pb-4">
            {/* Description */}
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Description
              </label>
              {editing ? (
                <Textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className="mt-1 min-h-[100px] text-sm resize-y"
                />
              ) : (
                <p className="text-sm text-muted-foreground mt-1">
                  {item.description || "No description"}
                </p>
              )}
            </div>

            {/* Task-specific fields */}
            {isTask && (
              <>
                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Priority
                  </label>
                  {editing ? (
                    <select
                      value={editPriority}
                      onChange={(e) => setEditPriority(e.target.value)}
                      className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                    >
                      <option value="urgent">Urgent</option>
                      <option value="high">High</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                    </select>
                  ) : (
                    <div className="mt-1">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize",
                          PRIORITY_COLORS[item.suggestedPriority ?? "medium"] ?? "bg-muted text-muted-foreground",
                        )}
                      >
                        {item.suggestedPriority ?? "medium"}
                      </span>
                    </div>
                  )}
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Assign To
                  </label>
                  {editing ? (
                    <select
                      value={editAssigneeId}
                      onChange={(e) => setEditAssigneeId(e.target.value)}
                      className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                    >
                      <option value="">Unassigned (backlog)</option>
                      {(agents ?? [])
                        .filter((a) => a.status !== "disabled")
                        .map((a) => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                    </select>
                  ) : (
                    <p className="text-sm text-muted-foreground mt-1">
                      {item.suggestedAssigneeId
                        ? (agents ?? []).find((a) => a.id === item.suggestedAssigneeId)?.name ?? "Assigned"
                        : "Unassigned (will go to backlog)"}
                    </p>
                  )}
                </div>
              </>
            )}

            {/* Memory-specific fields */}
            {isMemory && (
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Memory Layer
                </label>
                {editing ? (
                  <select
                    value={editLayer}
                    onChange={(e) => setEditLayer(e.target.value)}
                    className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                  >
                    <option value="identity">Identity</option>
                    <option value="domain">Domain</option>
                    <option value="active_context">Active Context</option>
                    <option value="working">Working</option>
                  </select>
                ) : (
                  <div className="mt-1">
                    <Badge variant="outline" className="text-xs capitalize">
                      {humanLayer(item.layer ?? item.suggestedLayer ?? "domain")}
                    </Badge>
                  </div>
                )}
              </div>
            )}

            {/* Conflict warning */}
            {item.conflictsWith && (
              <div className="rounded-md bg-red-50 dark:bg-red-950/30 p-3">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-red-600 shrink-0" />
                  <span className="text-sm text-red-700 dark:text-red-400">
                    Conflicts with existing item
                  </span>
                </div>
                <p className="text-xs text-red-600/80 mt-1 ml-6">{item.conflictsWith}</p>
              </div>
            )}

            {/* Result links for approved items */}
            {isApproved && (item.resultTaskId || item.resultMemoryId) && (
              <div className="rounded-md bg-green-50 dark:bg-green-950/30 p-3 space-y-2">
                <p className="text-xs font-medium text-green-800 dark:text-green-300 uppercase">
                  Created
                </p>
                {item.resultTaskId && (
                  <Link
                    to={`/issues?selected=${item.resultTaskId}`}
                    className="flex items-center gap-1.5 text-sm text-blue-600 hover:underline"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    View Task
                  </Link>
                )}
                {item.resultMemoryId && (
                  <Link
                    to="/memory"
                    className="flex items-center gap-1.5 text-sm text-blue-600 hover:underline"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    View Memory Item
                  </Link>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer actions */}
        <div className="border-t border-border px-6 py-4 space-y-2">
          {isPending && !editing && (
            <div className="flex items-center gap-2">
              <Button className="flex-1" onClick={() => onApprove(item.id)}>
                <Check className="h-4 w-4 mr-1.5" />
                Approve
              </Button>
              <Button variant="outline" className="flex-1" onClick={() => onReject(item.id)}>
                <X className="h-4 w-4 mr-1.5" />
                Reject
              </Button>
            </div>
          )}
          {isPending && !editing && (
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => setEditing(true)}
            >
              <Pencil className="h-4 w-4 mr-1.5" />
              Edit Before Approving
            </Button>
          )}
          {editing && (
            <div className="flex items-center gap-2">
              <Button className="flex-1" onClick={handleSave} disabled={isUpdating}>
                {isUpdating ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
                Save Changes
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          )}
          {isRejected && (
            <p className="text-xs text-center text-muted-foreground">
              This item was rejected.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Related Discussions
   ════════════════════════════════════════════════════════════════════════ */

function RelatedDiscussions({
  companyId,
  scopeType,
  scopeId,
  currentDiscussionId,
}: {
  companyId: string;
  scopeType: string;
  scopeId: string;
  currentDiscussionId: string;
}) {
  const { data } = useQuery({
    queryKey: [...queryKeys.discussions.list(companyId), "related", scopeType, scopeId],
    queryFn: () => discussionsApi.list(companyId, { scopeType, scopeId }),
    enabled: !!companyId && !!scopeId,
  });

  const related = useMemo(() => {
    if (!data?.discussions) return [];
    return data.discussions
      .filter((d) => d.id !== currentDiscussionId)
      .slice(0, 5);
  }, [data, currentDiscussionId]);

  if (related.length === 0) return null;

  return (
    <section className="mt-2 rounded-lg border border-border p-4">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
        Related Discussions
      </h3>
      <div className="space-y-1.5">
        {related.map((d) => (
          <Link
            key={d.id}
            to={`/discussions/${d.id}`}
            className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-muted/50 transition-colors text-sm"
          >
            <span className="truncate">{d.title || "Untitled"}</span>
            <span className="text-xs text-muted-foreground shrink-0 ml-2">
              {d.entryCount} {d.entryCount === 1 ? "entry" : "entries"}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
