/**
 * ScopeTab — decision board with grouped type accordions.
 * Structure: Plan → Needs Decision (pending items by type) → Approved (by type).
 * All groups collapsed by default.
 */
import { useState, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Check, X, Pencil, RefreshCw, Link2, GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { discussionsApi } from "../../api/discussions";
import { threadsApi } from "../../api/threads";
import { useToast } from "../../context/ToastContext";
import type { ScopeItem } from "./scopeGrouping";
import type { ApproveItems } from "@armyofagents/shared";
import type {
  ThreadScopeItem,
  ThreadScopeVersionDetail,
  ThreadScopeVersionSummary,
  UpdateScopeItemRequest,
} from "../../api/discussions";

/* ─── Type → display config ─── */

const TYPE_CONFIG: Record<string, { label: string; color: string }> = {
  task:            { label: "Tasks",        color: "#4FB67E" },
  decision:        { label: "Decisions",    color: "#6470DC" },
  preference:      { label: "Preferences",  color: "#D9A938" },
  insight:         { label: "Insights",     color: "#3FA8C7" },
  reference:       { label: "References",   color: "#7E8AA8" },
  context:         { label: "Context",      color: "rgba(126,138,168,0.6)" },
  artifact:        { label: "Artifacts",    color: "#5AA87E" },
  spin_off_thread: { label: "Branches",     color: "#6470DC" },
};

const SCOPE_ITEM_LABELS: Record<string, string> = {
  task_proposal: "Task proposal",
  task_change: "Task change",
  memory_candidate: "Memory candidate",
  artifact_link: "Artifact link",
  decision: "Decision",
  assumption: "Assumption",
  open_question: "Open question",
  source_signal: "Signal",
};

const SCOPE_ITEM_GROUPS: Array<{ kinds: string[]; label: string }> = [
  { kinds: ["task_proposal", "task_change"], label: "Task proposals" },
  { kinds: ["memory_candidate"], label: "Memory candidates" },
  { kinds: ["decision"], label: "Decisions" },
  { kinds: ["open_question"], label: "Open questions" },
  { kinds: ["artifact_link"], label: "Artifacts and references" },
  { kinds: ["assumption", "source_signal"], label: "Source notes" },
];

const SCOPE_CARD_COLORS = {
  task: { border: 'rgba(90, 191, 140, .45)', dot: '#5abf8c' },
  taskDraft: { border: 'rgba(216, 172, 79, .45)', dot: '#d8ac4f' },
  memory: { border: 'rgba(154, 140, 255, .45)', dot: '#9a8cff' },
  artifact: { border: 'rgba(100, 169, 232, .45)', dot: '#64a9e8' },
  rejected: { border: 'rgba(228, 111, 99, .3)', dot: '#e46f63' },
};

function typeColor(type: string): string {
  return TYPE_CONFIG[type]?.color ?? "#7E8AA8";
}

function typeLabel(type: string): string {
  return TYPE_CONFIG[type]?.label ?? type;
}

function scopeItemKindLabel(kind: string): string {
  return SCOPE_ITEM_LABELS[kind] ?? kind.replace(/_/g, " ");
}

function acceptedScopeItemKindLabel(item: ThreadScopeItem): string {
  if ((item.kind === "task_proposal" || item.kind === "task_change") && item.resultIssueId) {
    return "Task";
  }
  if (item.kind === "memory_candidate" && item.resultMemoryId) {
    return "Memory";
  }
  if (item.kind === "artifact_link" && item.artifactId) {
    return "Artifact";
  }
  return scopeItemKindLabel(item.kind);
}

function getScopeCardColors(item: ThreadScopeItem, isDraft: boolean) {
  if (item.status === 'rejected') {
    return SCOPE_CARD_COLORS.rejected;
  }

  if ((item.kind === 'task_proposal' || item.kind === 'task_change') && item.resultIssueId) {
    return SCOPE_CARD_COLORS.task;
  }
  if ((item.kind === 'task_proposal' || item.kind === 'task_change') && isDraft) {
    return SCOPE_CARD_COLORS.taskDraft;
  }
  if (item.kind === 'memory_candidate') {
    return SCOPE_CARD_COLORS.memory;
  }
  if (item.kind === 'artifact_link') {
    return SCOPE_CARD_COLORS.artifact;
  }

  return { border: 'rgba(126, 138, 168, 0.4)', dot: '#7E8AA8' };
}

function textFromUnknown(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in value) {
    const text = (value as { text?: unknown }).text;
    return typeof text === "string" ? text : null;
  }
  return null;
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function payloadString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function titleCase(value: string | null): string | null {
  if (!value) return null;
  return value
    .replace(/_/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function memoryCardMeta(item: ThreadScopeItem): string[] {
  if (item.kind !== "memory_candidate") return [];
  const payload = payloadRecord(item.payload);
  return [
    item.resultMemoryId ? "Saved memory" : "Draft memory",
    titleCase(payloadString(payload.category)),
    titleCase(payloadString(payload.layer)),
    payloadString(payload.folderPath),
  ].filter((value): value is string => Boolean(value));
}

function artifactPreview(item: ThreadScopeItem): string | null {
  if (item.kind !== "artifact_link") return null;
  const payload = payloadRecord(item.payload);
  const content = payloadString(payload.content);
  if (!content) return null;
  const cleaned = content
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 180 ? `${cleaned.slice(0, 177)}...` : cleaned;
}

function slugForLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function isGroupOpenByDefault(label: string): boolean {
  return label !== "Source notes" && label !== "Other scope items";
}

function scopeGroupStatusSummary(items: ThreadScopeItem[]): string {
  const counts = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {});
  const undecided = (counts.draft ?? 0) + (counts.edited ?? 0);

  return [
    counts.accepted ? `${counts.accepted} accepted` : null,
    counts.rejected ? `${counts.rejected} rejected` : null,
    counts.applied ? `${counts.applied} applied` : null,
    undecided ? `${undecided} undecided` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/* ─── Priority label ─── */

const PRIORITY_COLORS: Record<string, string> = {
  urgent: "#e87070",
  high:   "#D9A938",
  medium: "#3FA8C7",
  low:    "#7E8AA8",
};

/* ════════════════════════════════════════════════════════════════════════
   ScopeTab
   ════════════════════════════════════════════════════════════════════════ */

export interface Department {
  id: string;
  name: string;
}

export interface ScopeTabProps {
  summaryText: string | null;
  summaryNext: string | null;
  items: ScopeItem[];
  planSteps: string[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onItemClick: (item: ScopeItem) => void;
  companyId?: string;
  discussionId?: string;
  isFounder?: boolean;
  departments?: Department[];
  showAllTypes?: boolean;
  recommendation?: { departmentId: string; departmentName: string; itemCount: number } | null;
  activeScopeVersion?: ThreadScopeVersionDetail | null;
  scopeVersions?: ThreadScopeVersionSummary[];
  isScopeVersionLoading?: boolean;
  onCreateScopeDraft?: () => void;
  createScopeDraftLabel?: string;
  createScopeDraftDisabled?: boolean;
  showCreateScopeDraftCta?: boolean;
  onAcceptScopeVersion?: (scopeVersionId: string, itemIds: string[]) => void;
  onRejectScopeVersion?: (scopeVersionId: string) => void;
  onCompleteScopeVersion?: (scopeVersionId: string) => void;
  onScopeVersionSelect?: (scopeVersionId: string) => void;
  onScopeVersionItemClick?: (item: ThreadScopeItem) => void;
  onReviewScopeItems?: (
    scopeVersionId: string,
    items: Array<{ itemId: string; status: "draft" | "accepted" | "rejected" }>,
  ) => void;
  onUpdateScopeItem?: (
    scopeVersionId: string,
    itemId: string,
    patch: UpdateScopeItemRequest,
  ) => void;
  onCreateScopeOutputItem?: (
    scopeVersionId: string,
    itemId: string,
    options?: { memoryStatus?: "approved" | "pending" },
  ) => void;
  onApplyScopeVersion?: (scopeVersionId: string) => void;
}

export function ScopeTab({
  summaryText,
  summaryNext,
  items,
  planSteps,
  isLoading,
  isError,
  onRetry,
  onItemClick,
  companyId,
  discussionId,
  activeScopeVersion,
  scopeVersions = [],
  isScopeVersionLoading = false,
  onCreateScopeDraft,
  createScopeDraftLabel = "Create scope draft",
  createScopeDraftDisabled = false,
  showCreateScopeDraftCta = false,
  onAcceptScopeVersion,
  onRejectScopeVersion,
  onCompleteScopeVersion,
  onScopeVersionSelect,
  onScopeVersionItemClick,
  onReviewScopeItems,
  onUpdateScopeItem,
  onCreateScopeOutputItem,
  onApplyScopeVersion,
}: ScopeTabProps) {
  if (isLoading) {
    return (
      <div className="space-y-4 py-4" data-testid="scope-tab-skeleton">
        <div className="h-4 rounded bg-muted animate-pulse w-3/4" />
        <div className="h-4 rounded bg-muted animate-pulse w-1/2" />
        <div className="h-24 rounded-lg bg-muted animate-pulse" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-8" data-testid="scope-tab-error">
        <p className="text-sm text-muted-foreground">Couldn&apos;t load scope.</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="h-4 w-4 mr-1.5" />
          Retry
        </Button>
      </div>
    );
  }

  const pendingItems = items.filter((i) => i.status === "pending" || i.status === "edited");
  const approvedItems = items.filter((i) => i.status === "approved");
  const isPreScopeWorkspace = !activeScopeVersion && !!onCreateScopeDraft;
  void planSteps;

  return (
    <div className="py-2" data-testid="scope-tab">
      <div className="mx-auto w-full max-w-[560px] space-y-5" data-testid="scope-workspace">
        {isScopeVersionLoading && (
          <div className="rounded-lg border border-border/60 p-3" data-testid="scope-version-loading">
            <div className="h-3 w-24 rounded bg-muted animate-pulse" />
            <div className="mt-3 h-4 w-3/4 rounded bg-muted animate-pulse" />
          </div>
        )}

        {!isScopeVersionLoading && scopeVersions.length > 0 && (
          <ScopeVersionRail
            versions={scopeVersions}
            activeVersionId={activeScopeVersion?.id ?? null}
            onVersionSelect={onScopeVersionSelect}
          />
        )}

        {!isScopeVersionLoading && activeScopeVersion && (
          <ScopeVersionPackage
            version={activeScopeVersion}
            onAccept={onAcceptScopeVersion}
            onReject={onRejectScopeVersion}
            onComplete={onCompleteScopeVersion}
            onItemClick={onScopeVersionItemClick}
            onReviewScopeItems={onReviewScopeItems}
            onUpdateScopeItem={onUpdateScopeItem}
            onCreateScopeOutputItem={onCreateScopeOutputItem}
            onApplyScopeVersion={onApplyScopeVersion}
            showNextVersionHint={showCreateScopeDraftCta}
          />
        )}

        {!isScopeVersionLoading && isPreScopeWorkspace && (
          <ScopeBand
            title={summaryText ? "Conversation summary" : "Scope"}
            chipLabel="No draft"
            dataTestId="scope-draft-cta"
            actions={
              <Button
                size="sm"
                onClick={onCreateScopeDraft}
                disabled={createScopeDraftDisabled}
              >
                {createScopeDraftLabel}
              </Button>
            }
          >
            {summaryText ?? "Nothing has been scoped yet. Create a draft when the conversation is ready to become an executable handoff."}
          </ScopeBand>
        )}

        {!isScopeVersionLoading && onCreateScopeDraft && activeScopeVersion && showCreateScopeDraftCta && (
          <ScopeBand
            title="New conversation"
            chipLabel="After accepted scope"
            dataTestId="scope-draft-cta"
            actions={
              <Button
                size="sm"
                onClick={onCreateScopeDraft}
                disabled={createScopeDraftDisabled}
              >
                {createScopeDraftLabel}
              </Button>
            }
          >
            Create the next versioned handoff from new messages.
          </ScopeBand>
        )}

        {isPreScopeWorkspace ? (
          pendingItems.length > 0 ? (
            <RawSourceSignalsSection items={pendingItems} onItemClick={onItemClick} />
          ) : null
        ) : (
          <NeedsDecisionSection
            items={pendingItems}
            companyId={companyId}
            discussionId={discussionId}
            onItemClick={onItemClick}
            heading={activeScopeVersion ? "Source signals" : "Needs Decision"}
            emptyText={activeScopeVersion ? "No raw source signals outside this scope." : undefined}
          />
        )}

        {approvedItems.length > 0 && (
          <ApprovedSection items={approvedItems} onItemClick={onItemClick} />
        )}
      </div>
    </div>
  );
}

function ScopeVersionRail({
  versions,
  activeVersionId,
  onVersionSelect,
}: {
  versions: ThreadScopeVersionSummary[];
  activeVersionId: string | null;
  onVersionSelect?: (scopeVersionId: string) => void;
}) {
  return (
    <section
      className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 bg-muted/15 p-2"
      data-testid="scope-version-rail"
      aria-label="Scope versions"
    >
      {versions
        .slice()
        .sort((a, b) => a.versionNumber - b.versionNumber)
        .map((version) => {
          const isActive = version.id === activeVersionId;
          const statusLabel = version.status.charAt(0).toUpperCase() + version.status.slice(1);
          return (
            <button
              key={version.id}
              type="button"
              data-testid={`scope-version-tab-${version.id}`}
              aria-pressed={isActive}
              onClick={() => onVersionSelect?.(version.id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-left text-[11px] font-semibold transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isActive
                  ? "border-amber-500/45 bg-amber-500/10 text-amber-300"
                  : version.status === "accepted"
                    ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-300"
                    : "border-border/45 bg-background/35 text-muted-foreground",
              )}
            >
              <span>v{version.versionNumber}</span>
              <span>{statusLabel}</span>
              <span className="font-normal opacity-75">
                Messages {version.sourceStartSeq}-{version.sourceEndSeq}
              </span>
            </button>
          );
        })}
    </section>
  );
}

function ScopeBand({
  title,
  chipLabel,
  children,
  actions,
  dataTestId,
}: {
  title: string;
  chipLabel?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  dataTestId?: string;
}) {
  return (
    <section
      className="rounded-lg border border-border/60 p-3.5"
      style={{ background: "var(--card, #161a20)" }}
      data-testid={dataTestId}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {chipLabel && (
            <span className="rounded-full bg-muted/40 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
              {chipLabel}
            </span>
          )}
        </div>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{children}</p>
      {actions && <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div>}
    </section>
  );
}

function RawSourceSignalsSection({
  items,
  onItemClick,
}: {
  items: ScopeItem[];
  onItemClick: (item: ScopeItem) => void;
}) {
  return (
    <section className="space-y-2.5" data-testid="scope-raw-source-signals">
      <div className="flex items-center justify-between gap-3 px-0.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Raw source signals
        </h3>
        <span className="text-[11px] font-medium text-muted-foreground">
          Waiting outside scope
        </span>
      </div>
      {items.length === 0 ? (
        <p className="px-0.5 text-sm italic text-muted-foreground">
          No raw source signals yet.
        </p>
      ) : (
        <div className="grid gap-2">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className="rounded-lg border border-border/55 bg-card/45 px-3.5 py-3 text-left transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid={`raw-source-signal-${item.id}`}
              onClick={() => onItemClick(item)}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border/35 bg-muted/30 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: typeColor(item.type) }}
                    aria-hidden
                  />
                  Signal
                </span>
              </div>
              <h4 className="mt-2 text-[13px] font-semibold leading-snug text-foreground">
                {item.title}
              </h4>
              {item.description && (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {item.description}
                </p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="rounded-full border border-border/35 bg-muted/30 px-2 py-0.5 text-[10px] text-muted-foreground">
                  source: #{item.id.slice(0, 4)}
                </span>
                <span className="rounded-full border border-border/35 bg-muted/30 px-2 py-0.5 text-[10px] text-muted-foreground">
                  unscoped
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function scopeVersionOutputSummary(items: ThreadScopeItem[]) {
  const appliedCount = items.filter((item) => item.status === "applied").length;
  const draftCount = items.filter((item) => item.status === "draft").length;
  if (appliedCount > 0 && draftCount > 0) {
    return {
      label: "Partially applied",
      detail: `${appliedCount} created output${appliedCount === 1 ? "" : "s"}, ${draftCount} draft item${draftCount === 1 ? "" : "s"}`,
    };
  }
  return null;
}

function ScopeVersionPackage({
  version,
  onAccept,
  onReject,
  onComplete,
  onItemClick,
  onReviewScopeItems,
  onUpdateScopeItem,
  onCreateScopeOutputItem,
  onApplyScopeVersion,
  showNextVersionHint = false,
}: {
  version: ThreadScopeVersionDetail;
  onAccept?: (scopeVersionId: string, itemIds: string[]) => void;
  onReject?: (scopeVersionId: string) => void;
  onComplete?: (scopeVersionId: string) => void;
  onItemClick?: (item: ThreadScopeItem) => void;
  onReviewScopeItems?: (
    scopeVersionId: string,
    items: Array<{ itemId: string; status: "draft" | "accepted" | "rejected" }>,
  ) => void;
  onUpdateScopeItem?: (
    scopeVersionId: string,
    itemId: string,
    patch: UpdateScopeItemRequest,
  ) => void;
  onCreateScopeOutputItem?: (scopeVersionId: string, itemId: string) => void;
  onApplyScopeVersion?: (scopeVersionId: string) => void;
  showNextVersionHint?: boolean;
}) {
  const statusLabel = version.status.charAt(0).toUpperCase() + version.status.slice(1);
  const hasAcceptedItems = version.items.some((item) => item.status === "accepted");
  const draftItems = version.items.filter((item) => item.status === "draft");
  const draftSignals = draftItems.filter((item) => item.kind === "source_signal");
  const decisions = version.decisions.map(textFromUnknown).filter(Boolean) as string[];
  const openQuestions = version.openQuestions.map(textFromUnknown).filter(Boolean) as string[];
  const isAcceptedVersion = version.status === "accepted";
  const outputSummary = scopeVersionOutputSummary(version.items);

  return (
    <section
      className="rounded-lg border border-border/60 overflow-hidden"
      style={{ background: "var(--card, #161a20)" }}
      data-testid="scope-version-package"
    >
      <div className="flex flex-col gap-3 border-b border-border/60 px-3.5 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              Scope v{version.versionNumber} {version.status}
            </h3>
            <span className="rounded-full bg-muted/50 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
              {statusLabel}
            </span>
            {outputSummary && (
              <>
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                  {outputSummary.label}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {outputSummary.detail}
                </span>
              </>
            )}
            <span className="text-[11px] text-muted-foreground">
              Messages {version.sourceStartSeq}-{version.sourceEndSeq}
            </span>
          </div>
          <p className="mt-2 overflow-hidden text-sm leading-relaxed text-foreground/85 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:1]">
            {version.summary}
          </p>
        </div>

        {version.status === "draft" && (
          <div className="flex flex-wrap items-center gap-1.5">
            {onReviewScopeItems && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    onReviewScopeItems(
                      version.id,
                      draftItems.map((item) => ({ itemId: item.id, status: "accepted" })),
                    )
                  }
                  disabled={draftItems.length === 0}
                >
                  Accept all
                </Button>
                {draftSignals.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      onReviewScopeItems(
                        version.id,
                        draftSignals.map((item) => ({ itemId: item.id, status: "rejected" })),
                      )
                    }
                  >
                    Reject signals
                  </Button>
                )}
              </>
            )}
            <Button
              variant={hasAcceptedItems ? "default" : "outline"}
              size="sm"
              onClick={() => {
                if (onApplyScopeVersion) {
                  onApplyScopeVersion(version.id);
                } else if (onAccept) {
                  const acceptedItemIds = version.items
                    .filter((item) => item.status === "accepted")
                    .map((item) => item.id);
                  onAccept(version.id, acceptedItemIds);
                }
              }}
              disabled={(!onApplyScopeVersion && !onAccept) || !hasAcceptedItems}
            >
              <Check className="mr-1.5 h-3.5 w-3.5" />
              Apply accepted
            </Button>
            {onReject && (
              <Button variant="outline" size="sm" onClick={() => onReject(version.id)}>
                Reject draft
              </Button>
            )}
            {!onReject && (
              <Button variant="outline" size="sm" disabled>
                Reject draft
              </Button>
            )}
          </div>
        )}

        {version.status === "accepted" && onComplete && (
          <Button variant="outline" size="sm" onClick={() => onComplete(version.id)}>
            Mark complete
          </Button>
        )}
      </div>

      {isAcceptedVersion && (
        <div
          className="flex flex-wrap items-center gap-2 border-b border-border/50 px-3.5 py-2.5"
          data-testid="scope-version-history"
        >
          <span className="rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-300">
            v{version.versionNumber} Assigned
          </span>
          {showNextVersionHint && (
            <span className="rounded-full border border-border/45 bg-muted/25 px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
              v{version.versionNumber + 1} New messages
            </span>
          )}
        </div>
      )}

      {(decisions.length > 0 || openQuestions.length > 0) && (
        <div className="grid gap-3 border-b border-border/50 px-3.5 py-3 md:grid-cols-2">
          {decisions.length > 0 && <ScopeTextList title="Decisions" items={decisions} />}
          {openQuestions.length > 0 && <ScopeTextList title="Open questions" items={openQuestions} />}
        </div>
      )}

      <div className="grid gap-3 px-3.5 py-3" data-testid="scope-version-card-lane">
        {version.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No scope items have been added yet.
          </p>
        ) : (
          groupScopeItems(version.items, isAcceptedVersion).map(({ label, items }) => (
            <ScopeVersionItemGroup
              key={label}
              label={label}
              items={items}
              onItemClick={onItemClick}
              scopeVersionId={version.id}
              isDraftVersion={version.status === "draft"}
              isAcceptedVersion={isAcceptedVersion}
              onReviewScopeItems={onReviewScopeItems}
              onCreateScopeOutputItem={onCreateScopeOutputItem}
            />
          ))
        )}
      </div>
    </section>
  );
}

function ScopeTextList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h4>
      <ul className="mt-1.5 space-y-1.5">
        {items.map((item, index) => (
          <li key={`${item}-${index}`} className="text-xs leading-relaxed text-foreground/80">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function groupScopeItems(
  items: ThreadScopeItem[],
  isAcceptedVersion = false,
): Array<{ label: string; items: ThreadScopeItem[] }> {
  if (isAcceptedVersion) {
    const createdTasks = items.filter((item) =>
      (item.kind === "task_proposal" || item.kind === "task_change") && item.resultIssueId,
    );
    const memoryAndArtifacts = items.filter((item) =>
      (item.kind === "memory_candidate" && item.resultMemoryId)
      || (item.kind === "artifact_link" && item.artifactId),
    );
    const remaining = items.filter(
      (item) => !createdTasks.includes(item) && !memoryAndArtifacts.includes(item),
    );

    return [
      createdTasks.length > 0 ? { label: "Created tasks", items: createdTasks } : null,
      memoryAndArtifacts.length > 0 ? { label: "Memory and artifacts", items: memoryAndArtifacts } : null,
      remaining.length > 0 ? { label: "Other scope items", items: remaining } : null,
    ].filter(Boolean) as Array<{ label: string; items: ThreadScopeItem[] }>;
  }

  const remaining = [...items];
  const groups: Array<{ label: string; items: ThreadScopeItem[] }> = [];

  for (const group of SCOPE_ITEM_GROUPS) {
    const groupItems = remaining.filter((item) => group.kinds.includes(item.kind));
    if (groupItems.length === 0) continue;
    groups.push({ label: group.label, items: groupItems });
    for (const item of groupItems) {
      const index = remaining.findIndex((candidate) => candidate.id === item.id);
      if (index >= 0) remaining.splice(index, 1);
    }
  }

  if (remaining.length > 0) {
    groups.push({ label: "Other scope items", items: remaining });
  }

  return groups;
}

function ScopeVersionItemGroup({
  label,
  items,
  onItemClick,
  scopeVersionId,
  isDraftVersion,
  isAcceptedVersion,
  onReviewScopeItems,
  onCreateScopeOutputItem,
}: {
  label: string;
  items: ThreadScopeItem[];
  onItemClick?: (item: ThreadScopeItem) => void;
  scopeVersionId: string;
  isDraftVersion: boolean;
  isAcceptedVersion: boolean;
  onReviewScopeItems?: (
    scopeVersionId: string,
    items: Array<{ itemId: string; status: "draft" | "accepted" | "rejected" }>,
  ) => void;
  onCreateScopeOutputItem?: (
    scopeVersionId: string,
    itemId: string,
    options?: { memoryStatus?: "approved" | "pending" },
  ) => void;
}) {
  const [isOpen, setIsOpen] = useState(() => isGroupOpenByDefault(label));
  const groupSlug = slugForLabel(label);
  const statusSummary = scopeGroupStatusSummary(items);

  return (
    <section
      className="space-y-2"
      data-testid={`scope-version-group-${groupSlug}`}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-0.5 py-0.5 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={isOpen}
        data-testid={`scope-version-accordion-${groupSlug}`}
        onClick={() => setIsOpen((value) => !value)}
      >
        {isOpen ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span className="rounded-full bg-muted/35 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
          {items.length}
        </span>
        {statusSummary && (
          <span className="ml-auto truncate text-[11px] text-muted-foreground/80">
            {statusSummary}
          </span>
        )}
      </button>
      {isOpen && (
        <div className="grid gap-2">
          {items.map((item) => (
            <ScopeVersionItemCard
              key={item.id}
              item={item}
              onClick={onItemClick}
              scopeVersionId={scopeVersionId}
              isDraftVersion={isDraftVersion}
              isAcceptedVersion={isAcceptedVersion}
              onReviewScopeItems={onReviewScopeItems}
              onCreateScopeOutputItem={onCreateScopeOutputItem}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ScopeVersionItemCard({
  item,
  onClick,
  scopeVersionId,
  isDraftVersion,
  isAcceptedVersion,
  onReviewScopeItems,
  onCreateScopeOutputItem,
}: {
  item: ThreadScopeItem;
  onClick?: (item: ThreadScopeItem) => void;
  scopeVersionId: string;
  isDraftVersion: boolean;
  isAcceptedVersion: boolean;
  onReviewScopeItems?: (
    scopeVersionId: string,
    items: Array<{ itemId: string; status: "draft" | "accepted" | "rejected" }>,
  ) => void;
  onCreateScopeOutputItem?: (scopeVersionId: string, itemId: string) => void;
}) {
  const resultKind = item.resultIssueId
    ? "Task"
    : item.resultMemoryId
      ? "Memory"
      : item.artifactId
        ? "Artifact"
        : null;
  const resultId = item.resultIssueId ?? item.resultMemoryId ?? item.artifactId ?? null;
  const resultLabel = resultKind ? `${resultKind} linked` : null;
  const resultIdLabel = resultKind && resultId ? `${resultKind} ${resultId}` : null;
  const sourceCount = Array.isArray(item.sourceEntryIds) ? item.sourceEntryIds.length : 0;
  const canReview = isDraftVersion && item.status !== "applied";
  const isAccepted = item.status === "accepted";
  const isRejected = item.status === "rejected";
  const hasLinkableArtifact = item.kind === "artifact_link" && Boolean(item.artifactId);
  const hasCreatedOutput = Boolean(
    item.resultIssueId ||
    item.resultMemoryId ||
    (item.status === "applied" && item.kind === "artifact_link" && item.artifactId),
  );
  const reviewStatusLabel =
    item.status === "accepted"
      ? "Accepted"
      : item.status === "rejected"
        ? "Rejected"
        : item.status;
  const kindLabel = isAcceptedVersion ? acceptedScopeItemKindLabel(item) : scopeItemKindLabel(item.kind);
  const colors = getScopeCardColors(item, isDraftVersion);
  const memoryMeta = memoryCardMeta(item);
  const preview = artifactPreview(item);

  const openItem = () => onClick?.(item);

  const handleCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openItem();
  };

  const handleReview = (status: "accepted" | "rejected") => {
    onReviewScopeItems?.(scopeVersionId, [{ itemId: item.id, status }]);
  };
  const handlePrimaryAction = () => {
    if (hasLinkableArtifact && !hasCreatedOutput) {
      if (onCreateScopeOutputItem) {
        onCreateScopeOutputItem(scopeVersionId, item.id);
        return;
      }
      openItem();
      return;
    }
    if (isRejected) {
      onReviewScopeItems?.(scopeVersionId, [{ itemId: item.id, status: "draft" }]);
      return;
    }
    if (hasCreatedOutput) {
      openItem();
      return;
    }
    if (item.kind === "task_proposal" || item.kind === "memory_candidate") {
      openItem();
      return;
    }
    if (item.kind === "artifact_link") {
      if (item.artifactId && onCreateScopeOutputItem) {
        onCreateScopeOutputItem(scopeVersionId, item.id);
        return;
      }
      openItem();
      return;
    }
    handleReview("accepted");
  };

  const primaryActionDisabled =
    hasLinkableArtifact && !hasCreatedOutput
      ? item.artifactId
        ? !onCreateScopeOutputItem
        : !onClick
      : isRejected
      ? !onReviewScopeItems
      : hasCreatedOutput
        ? !onClick
        : item.kind === "task_proposal" || item.kind === "memory_candidate"
      ? !onClick
      : item.kind === "artifact_link"
        ? item.artifactId
          ? !onCreateScopeOutputItem
          : !onClick
        : !onReviewScopeItems;

  const primaryActionLabel =
    hasLinkableArtifact && !hasCreatedOutput
      ? "Link artifact"
      : isRejected
      ? "Restore"
      : item.resultIssueId
        ? "Open task"
        : item.resultMemoryId
          ? "Open memory"
          : item.status === "applied" && item.kind === "artifact_link" && item.artifactId
            ? "Open artifact"
            : item.kind === "task_proposal"
      ? "Review task"
      : item.kind === "memory_candidate"
        ? "Review memory"
        : item.kind === "artifact_link" && item.artifactId
          ? "Link artifact"
          : item.kind === "artifact_link"
            ? "Review artifact"
            : "Accept";

  return (
    <div
      className={cn(
        "w-full cursor-pointer rounded-lg border px-3.5 py-3 text-left shadow-sm transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        isRejected ? "bg-red-500/5 opacity-80" : "bg-card/45",
      )}
      style={{ borderColor: colors.border }}
      data-testid={`scope-version-card-${item.id}`}
      data-review-status={item.status}
      role="button"
      tabIndex={0}
      aria-label={`View details for ${item.title}`}
      onClick={openItem}
      onKeyDown={handleCardKeyDown}
    >
      <div className="min-w-0">
        <div className="flex items-start gap-2">
          <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: colors.dot }}
              aria-hidden
            />
            {kindLabel}
          </span>
          <span
            className={cn(
              "ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize",
              isAccepted
                ? "bg-emerald-500/10 text-emerald-300"
                : isRejected
                  ? "bg-red-500/10 text-red-300"
                  : "bg-muted/35 text-muted-foreground",
            )}
          >
            {reviewStatusLabel}
          </span>
          {canReview && (
            <span className="flex shrink-0 items-center gap-1" aria-label="quick card actions">
              <button
                type="button"
                aria-label={`Edit in viewer: ${item.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  openItem();
                }}
                className="flex h-6 w-6 items-center justify-center rounded border border-border/50 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              </button>
              <button
                type="button"
                aria-label={`Remove from draft: ${item.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  handleReview("rejected");
                }}
                disabled={!onReviewScopeItems || item.status === "rejected"}
                className="flex h-6 w-6 items-center justify-center rounded border border-border/50 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:opacity-40"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </span>
          )}
        </div>
        <p className="mt-2 text-[13px] font-semibold leading-snug text-foreground">
          {item.title}
        </p>
        {item.description && (
          <p className="mt-1 overflow-hidden text-xs leading-relaxed text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
            {item.description}
          </p>
        )}
        {preview && (
          <p className="mt-1 overflow-hidden rounded-md border border-border/50 bg-background/60 px-2 py-1.5 text-xs leading-relaxed text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3]">
            {preview}
          </p>
        )}
          {resultLabel && (
            <p className="mt-1 text-[11px] font-medium text-foreground/75">
              {resultLabel}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full border border-border/35 bg-muted/30 px-2 py-0.5 text-[10px] text-muted-foreground">
              {sourceCount} {sourceCount === 1 ? "source" : "sources"}
            </span>
            {resultIdLabel && (
              <span className="rounded-full border border-border/35 bg-muted/30 px-2 py-0.5 text-[10px] text-muted-foreground">
                {resultIdLabel}
              </span>
            )}
            {typeof item.payload?.priority === "string" && (
              <span className="rounded-full border border-border/35 bg-muted/30 px-2 py-0.5 text-[10px] text-muted-foreground">
                {item.payload.priority}
              </span>
            )}
            {typeof item.payload?.layer === "string" && (
              <span className="rounded-full border border-border/35 bg-muted/30 px-2 py-0.5 text-[10px] text-muted-foreground">
                {item.payload.layer}
              </span>
            )}
            {memoryMeta.map((label) => (
              <span
                key={label}
                className="rounded-full border border-border/35 bg-muted/30 px-2 py-0.5 text-[10px] text-muted-foreground"
              >
                {label}
              </span>
            ))}
            {isAcceptedVersion && resultLabel && (
              <span className="rounded-full border border-border/35 bg-muted/30 px-2 py-0.5 text-[10px] text-muted-foreground">
                scope item linked
              </span>
            )}
          </div>
          {(canReview || hasCreatedOutput) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {hasCreatedOutput || item.status !== "accepted" ? (
                <button
                  type="button"
                  className="rounded border border-emerald-500/45 bg-emerald-500/10 px-2 py-1 text-[11px] font-semibold text-emerald-300 disabled:opacity-40"
                  onClick={(event) => {
                    event.stopPropagation();
                    handlePrimaryAction();
                  }}
                  disabled={primaryActionDisabled}
                >
                  {primaryActionLabel}
                </button>
              ) : (
                <span className="rounded border border-emerald-500/45 bg-emerald-500/10 px-2 py-1 text-[11px] font-semibold text-emerald-300">
                  Accepted
                </span>
              )}
              {canReview && item.status !== "rejected" ? (
                <button
                  type="button"
                  className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] font-semibold text-red-300 disabled:opacity-40"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleReview("rejected");
                  }}
                  disabled={!onReviewScopeItems}
                >
                  Reject
                </button>
              ) : (
                canReview && <span className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] font-semibold text-red-300">
                  Rejected
                </span>
              )}
            </div>
          )}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   NeedsDecisionSection
   ════════════════════════════════════════════════════════════════════════ */

function NeedsDecisionSection({
  items,
  companyId,
  discussionId,
  onItemClick,
  heading = "Needs Decision",
  emptyText = "Nothing to decide yet - Scribe surfaces items as the discussion grows.",
}: {
  items: ScopeItem[];
  companyId?: string;
  discussionId?: string;
  onItemClick: (item: ScopeItem) => void;
  heading?: string;
  emptyText?: string;
}) {
  // Group by type
  const byType = new Map<string, ScopeItem[]>();
  for (const item of items) {
    const list = byType.get(item.type) ?? [];
    list.push(item);
    byType.set(item.type, list);
  }

  const typeKeys = [...byType.keys()];

  // All groups collapsed by default
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  const toggle = useCallback((type: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  return (
    <section data-testid="scope-needs-decision">
      <div className="flex items-center gap-2 mb-2.5 px-0.5">
        <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
          {heading}
        </h3>
        {items.length > 0 && (
          <span
            className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums"
            style={{ background: "rgba(59,130,246,0.15)", color: "#60a5fa" }}
          >
            {items.length}
          </span>
        )}
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground italic px-0.5">
          {emptyText}
        </p>
      ) : (
        <div className="space-y-2">
          {typeKeys.map((type) => {
            const typeItems = byType.get(type) ?? [];
            const isOpen = openGroups.has(type);
            const color = typeColor(type);
            return (
              <TypeAccordion
                key={type}
                type={type}
                color={color}
                items={typeItems}
                isOpen={isOpen}
                onToggle={() => toggle(type)}
                companyId={companyId}
                discussionId={discussionId}
                onItemClick={onItemClick}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   TypeAccordion
   ──────────────────────────────────────────────────────────────────────── */

function TypeAccordion({
  type,
  color,
  items,
  isOpen,
  onToggle,
  companyId,
  discussionId,
  onItemClick,
}: {
  type: string;
  color: string;
  items: ScopeItem[];
  isOpen: boolean;
  onToggle: () => void;
  companyId?: string;
  discussionId?: string;
  onItemClick: (item: ScopeItem) => void;
}) {
  return (
    <div
      className="rounded-lg border border-border/60 overflow-hidden"
      data-testid={`s-type-group-${type}`}
    >
      {/* Header */}
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-2.5 w-full px-3.5 py-2.5 text-left hover:bg-muted/20 transition-colors"
        style={{ background: "var(--card-2, #1d2128)" }}
        aria-expanded={isOpen}
      >
        <span
          className="shrink-0 w-2 h-2 rounded-full"
          style={{ background: color }}
          aria-hidden="true"
        />
        <span className="flex-1 text-sm font-medium text-foreground">
          {typeLabel(type)}
        </span>
        <span
          className="text-[11px] font-semibold tabular-nums rounded-full px-2 py-0.5"
          style={{ background: "hsl(0 0% 18%)", color: "hsl(0 0% 60%)" }}
        >
          {items.length}
        </span>
        {isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
      </button>

      {/* Items */}
      {isOpen && (
        <div
          className="border-t border-border/60 divide-y divide-border/40"
          style={{ background: "var(--card, #161a20)" }}
        >
          {items.map((item) => (
            <ScopeItemCard
              key={item.id}
              item={item}
              companyId={companyId}
              discussionId={discussionId}
              onItemClick={onItemClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   ScopeItemCard
   ──────────────────────────────────────────────────────────────────────── */

function ScopeItemCard({
  item,
  companyId,
  discussionId,
  onItemClick,
}: {
  item: ScopeItem;
  companyId?: string;
  discussionId?: string;
  onItemClick: (item: ScopeItem) => void;
}) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const hasConflict = !!item.conflictsWith;
  const depCount = (item.dependsOn ?? []).length;

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["threads", companyId] });

  const approveMutation = useMutation({
    mutationFn: () => {
      if (!companyId || !discussionId) throw new Error("Missing context");
      return discussionsApi.approveItems(companyId, discussionId, {
        items: [{ itemId: item.id, action: "approved" }],
      } as ApproveItems);
    },
    onSuccess: () => {
      invalidate();
      pushToast({ title: "Item approved", tone: "success" });
    },
    onError: () => pushToast({ title: "Failed to approve", tone: "warn" }),
  });

  const rejectMutation = useMutation({
    mutationFn: () => {
      if (!companyId || !discussionId) throw new Error("Missing context");
      return discussionsApi.rejectItems(companyId, discussionId, [item.id]);
    },
    onSuccess: () => {
      invalidate();
      pushToast({ title: "Item rejected", tone: "success" });
    },
    onError: () => pushToast({ title: "Failed to reject", tone: "warn" }),
  });

  const spinOffMutation = useMutation({
    mutationFn: () => {
      if (!companyId || !discussionId) throw new Error("Missing context");
      return threadsApi.spinOff(companyId, discussionId, item.id, item.title);
    },
    onSuccess: () => {
      invalidate();
      pushToast({ title: "Branch thread created", tone: "success" });
    },
    onError: () => pushToast({ title: "Failed to spin off", tone: "warn" }),
  });

  const isBusy = approveMutation.isPending || rejectMutation.isPending;

  return (
    <div
      className={cn(
        "px-3.5 py-3 group",
        hasConflict && "border-l-2 border-amber-500/70",
      )}
      style={hasConflict ? { background: "hsl(38 20% 10%)" } : undefined}
      data-testid={`scope-item-${item.id}`}
    >
      {/* Row 1: short ID + title + actions */}
      <div className="flex items-start gap-2">
        <span
          className="shrink-0 text-[10px] font-mono text-muted-foreground/50 mt-0.5 pt-[1px]"
        >
          #{item.id.slice(0, 4)}
        </span>
        <button
          type="button"
          onClick={() => onItemClick(item)}
          className="flex-1 text-left min-w-0"
        >
          <span className="text-[13px] font-semibold leading-snug text-foreground line-clamp-2 hover:text-foreground/80 transition-colors">
            {item.title}
          </span>
        </button>

        {/* Action buttons */}
        <div className="flex items-center gap-1 shrink-0 ml-1">
          <button
            type="button"
            onClick={() => approveMutation.mutate()}
            disabled={isBusy || !companyId || !discussionId}
            title="Approve"
            className="w-6 h-6 rounded flex items-center justify-center transition-colors text-muted-foreground hover:text-emerald-400 hover:bg-emerald-400/10 disabled:opacity-40"
            aria-label="Approve"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => rejectMutation.mutate()}
            disabled={isBusy || !companyId || !discussionId}
            title="Reject"
            className="w-6 h-6 rounded flex items-center justify-center transition-colors text-muted-foreground disabled:opacity-40"
            style={{ ["--hover-color" as string]: "hsl(10 70% 62%)" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "hsl(10 70% 62%)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "")}
            aria-label="Reject"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onItemClick(item)}
            title="Edit"
            className="w-6 h-6 rounded flex items-center justify-center transition-colors text-muted-foreground hover:text-foreground hover:bg-muted/30"
            aria-label="Edit"
          >
            <Pencil className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Row 2: description */}
      {item.description && (
        <p className="text-xs text-muted-foreground leading-relaxed mt-1.5 ml-7 line-clamp-2">
          {item.description}
        </p>
      )}

      {/* Row 3: meta pills */}
      <div className="flex flex-wrap items-center gap-1.5 mt-2 ml-7">
        {item.suggestedPriority && (
          <span
            className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize"
            style={{
              color: PRIORITY_COLORS[item.suggestedPriority] ?? "#7E8AA8",
              background: `${PRIORITY_COLORS[item.suggestedPriority] ?? "#7E8AA8"}20`,
            }}
          >
            {item.suggestedPriority}
          </span>
        )}
        {item.suggestedLayer && (
          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium text-muted-foreground bg-muted/40 capitalize">
            {item.suggestedLayer}
          </span>
        )}
        {hasConflict && (
          <span
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
            style={{ color: "#D9A938", background: "rgba(217,169,56,0.15)" }}
          >
            ⚠ Conflict
          </span>
        )}
        {depCount > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] text-muted-foreground"
            style={{ background: "hsl(0 0% 18%)" }}
            data-testid={`dep-badge-${item.id}`}
          >
            <Link2 className="h-2.5 w-2.5" />
            blocked by {depCount}
          </span>
        )}
        {item.type === "spin_off_thread" && (
          <button
            type="button"
            onClick={() => spinOffMutation.mutate()}
            disabled={spinOffMutation.isPending || !companyId || !discussionId}
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            style={{ background: "hsl(0 0% 18%)" }}
            data-testid={`spin-off-${item.id}`}
          >
            <GitBranch className="h-2.5 w-2.5" />
            Spin off →
          </button>
        )}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   ApprovedSection
   ════════════════════════════════════════════════════════════════════════ */

function ApprovedSection({
  items,
  onItemClick,
}: {
  items: ScopeItem[];
  onItemClick: (item: ScopeItem) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);

  // Sub-group by type
  const byType = new Map<string, ScopeItem[]>();
  for (const item of items) {
    const list = byType.get(item.type) ?? [];
    list.push(item);
    byType.set(item.type, list);
  }

  return (
    <section data-testid="scope-approved">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="flex items-center gap-2 w-full px-0.5 mb-2"
        aria-expanded={isOpen}
      >
        <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
          Approved
        </h3>
        <span
          className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums"
          style={{ background: "rgba(79,182,126,0.12)", color: "#4FB67E" }}
        >
          {items.length}
        </span>
        {isOpen ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground/60 ml-auto" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground/60 ml-auto" />
        )}
      </button>

      {isOpen && (
        <div className="space-y-2">
          {[...byType.entries()].map(([type, typeItems]) => (
            <div
              key={type}
              className="rounded-lg border border-border/40 overflow-hidden"
              style={{ background: "var(--card-2, #1d2128)" }}
            >
              <div className="flex items-center gap-2 px-3.5 py-2 border-b border-border/40">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: typeColor(type) }}
                />
                <span className="text-xs font-medium text-muted-foreground">
                  {typeLabel(type)}
                </span>
                <span className="text-[11px] text-muted-foreground/50 ml-auto tabular-nums">
                  {typeItems.length}
                </span>
              </div>
              <div className="divide-y divide-border/30">
                {typeItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onItemClick(item)}
                    className="w-full text-left px-3.5 py-2.5 hover:bg-muted/20 transition-colors"
                  >
                    <div className="flex items-start gap-2">
                      <span
                        className="shrink-0 text-[10px] font-mono text-muted-foreground/40 mt-0.5"
                      >
                        #{item.id.slice(0, 4)}
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className="text-[13px] text-foreground/80 line-clamp-1">
                          {item.title}
                        </span>
                        {(item.resultTaskId || item.resultMemoryId) && (
                          <span className="block text-[11px] text-muted-foreground/50 mt-0.5">
                            {item.resultTaskId && `→ Task #${item.resultTaskId.slice(0, 8)}`}
                            {item.resultMemoryId && "→ Memory"}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
