import { useState } from "react";
import { Link } from "@/lib/router";
import { api } from "../../api/client";
import type { ThreadListItem } from "../../api/threads";
import { useCompany } from "../../context/CompanyContext";
import { cn } from "../../lib/utils";
import type { InboxCardItem } from "./ThreadBoard";
import { RoutingDialControl } from "./RoutingDialControl";
import {
  Building2,
  CheckCircle2,
  Clock,
  FileText,
  GitBranch,
  Headphones,
  Inbox,
  Loader2,
  MessageSquare,
  Mic,
  PenLine,
  Plus,
  Plug,
  Sparkles,
  Target,
  UserPlus,
  X,
} from "lucide-react";

const PHASE_META: Record<ThreadListItem["phase"], { label: string; icon: typeof MessageSquare }> = {
  discuss: { label: "Discuss", icon: MessageSquare },
  scope: { label: "Scope", icon: Target },
  assign: { label: "Assign", icon: UserPlus },
  done: { label: "Done", icon: CheckCircle2 },
};

function relativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(dateStr).toLocaleDateString();
}

interface ThreadsHomeOverviewProps {
  threads: ThreadListItem[];
  inboxItems: InboxCardItem[];
  onInboxUpdate: () => void;
  companyId?: string | null;
  canEditRouting: boolean;
}

export function ThreadsHomeOverview({
  threads,
  inboxItems,
  onInboxUpdate,
  companyId,
  canEditRouting,
}: ThreadsHomeOverviewProps) {
  const attentionThreads = threads.filter((thread) => thread.pendingItemCount > 0).slice(0, 6);
  const recentThreads = [...threads]
    .sort((a, b) => new Date(b.lastEntryAt ?? b.createdAt).getTime() - new Date(a.lastEntryAt ?? a.createdAt).getTime())
    .slice(0, 8);

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="threads-home-overview">
      <header
        className="flex h-[42px] shrink-0 items-center justify-between gap-3 border-b border-border px-4"
        data-testid="threads-home-header"
      >
        <h1 className="min-w-0 truncate text-sm font-semibold">Discussions</h1>
        {companyId && (
          <RoutingDialControl companyId={companyId} canEdit={canEditRouting} variant="icon" />
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="space-y-4">
          <section
            className="grid gap-2 sm:grid-cols-3"
            aria-label="Discussion home summary"
            data-testid="threads-home-summary-strip"
          >
            <SummaryMetric icon={Inbox} label="Unlisted" value={inboxItems.length} attention={inboxItems.length > 0} />
            <SummaryMetric
              icon={MessageSquare}
              label="Needs attention"
              value={attentionThreads.length}
              attention={attentionThreads.length > 0}
            />
            <SummaryMetric icon={Clock} label="Recently active" value={recentThreads.length} />
          </section>

          <section className="space-y-2.5" data-testid="threads-home-unlisted-section">
            <SectionHeading
              icon={Inbox}
              title="Unlisted"
              count={inboxItems.length}
              countTestId="threads-home-unlisted-count"
              description="Inbound items waiting to become or join a thread."
            />
            <div className="space-y-1.5">
              {inboxItems.length > 0 ? (
                inboxItems
                  .slice(0, 5)
                  .map((item) => <InboxHomeRow key={item.id} item={item} onInboxUpdate={onInboxUpdate} />)
              ) : (
                <EmptyLane label="No unlisted items are waiting." />
              )}
            </div>
          </section>

          <div className="grid min-h-0 gap-4 xl:grid-cols-2">
            <section className="min-w-0 space-y-2.5">
              <SectionHeading
                icon={MessageSquare}
                title="Needs attention"
                count={attentionThreads.length}
                description="Threads with pending human review or follow-up."
              />
              <div className="space-y-1.5">
                {attentionThreads.length > 0 ? (
                  attentionThreads.map((thread) => <OverviewThreadRow key={thread.id} thread={thread} attention />)
                ) : (
                  <EmptyLane label="No threads need attention right now." />
                )}
              </div>
            </section>

            <section className="min-w-0 space-y-2.5">
              <SectionHeading
                icon={Clock}
                title="Recently active"
                count={recentThreads.length}
                description="Latest threads touched by people or agents."
              />
              <div className="space-y-1.5">
                {recentThreads.map((thread) => (
                  <OverviewThreadRow key={thread.id} thread={thread} />
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryMetric({
  icon: Icon,
  label,
  value,
  attention = false,
}: {
  icon: typeof MessageSquare;
  label: string;
  value: number;
  attention?: boolean;
}) {
  return (
    <div className="flex h-12 items-center gap-2.5 rounded-md border border-border bg-background px-3">
      <Icon className={cn("size-3.5 shrink-0", attention ? "text-amber-500" : "text-muted-foreground")} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function SectionHeading({
  icon: Icon,
  title,
  count,
  description,
  countTestId,
}: {
  icon: typeof MessageSquare;
  title: string;
  count: number;
  description: string;
  countTestId?: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{title}</h2>
          <span className="text-xs tabular-nums text-muted-foreground" data-testid={countTestId}>
            {count}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function EmptyLane({ label }: { label: string }) {
  return (
    <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
      {label}
    </p>
  );
}

function OverviewThreadRow({ thread, attention = false }: { thread: ThreadListItem; attention?: boolean }) {
  const phase = PHASE_META[thread.phase];
  const PhaseIcon = phase.icon;
  const time = relativeTime(thread.lastEntryAt ?? thread.createdAt);
  const participants = thread.participantPreview ?? thread.participants ?? [];
  const scopeLabel =
    thread.scopeName && thread.scopeType === "department"
      ? `Department: ${thread.scopeName}`
      : thread.scopeName
        ? `Scope: ${thread.scopeName}`
        : null;
  const source = getSourceMeta(thread.lastEntryInputType ?? thread.originSource);
  const SourceIcon = source?.icon;

  return (
    <Link
      to={`/discussions/${thread.id}`}
      className="group flex min-h-11 min-w-0 items-center gap-2.5 rounded-md border border-border bg-background px-3 py-2 text-sm transition-colors hover:bg-muted/35"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{thread.title}</span>
        <span className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex min-w-0 items-center gap-1">
            <PhaseIcon className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{phase.label}</span>
          </span>
          {scopeLabel && (
            <span className="inline-flex min-w-0 items-center gap-1 truncate">
              <Building2 className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{scopeLabel}</span>
            </span>
          )}
          {source && (
            <span className="inline-flex min-w-0 items-center gap-1 truncate">
              {SourceIcon && <SourceIcon className="size-3 shrink-0" aria-hidden />}
              <span className="truncate">{source.label}</span>
            </span>
          )}
          {participants.length > 0 && <ParticipantStack threadId={thread.id} participants={participants} />}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {attention || thread.pendingItemCount > 0 ? (
          <span className="size-2 rounded-full bg-amber-400" data-testid="home-thread-attention-marker" />
        ) : null}
        {time && <span className="text-xs tabular-nums text-muted-foreground">{time}</span>}
      </span>
    </Link>
  );
}

function ParticipantStack({
  threadId,
  participants,
}: {
  threadId: string;
  participants: Array<{ name: string; principalType?: string; role?: string }>;
}) {
  const visible = participants.slice(0, 3);
  const hidden = participants.length - visible.length;
  return (
    <span
      className="ml-0.5 inline-flex shrink-0 items-center"
      title={participants.map((participant) => participant.name).join(", ")}
      data-testid={`home-participant-stack-${threadId}`}
    >
      {visible.map((participant, index) => (
        <span
          key={`${participant.name}-${index}`}
          className={cn(
            "inline-flex size-5 items-center justify-center rounded-full border border-background bg-muted text-[9px] font-semibold text-muted-foreground",
            index > 0 && "-ml-1.5",
          )}
          aria-label={participant.name}
        >
          {initials(participant.name)}
        </span>
      ))}
      {hidden > 0 && (
        <span className="-ml-1.5 inline-flex h-5 items-center rounded-full border border-background bg-muted px-1.5 text-[9px] font-semibold text-muted-foreground">
          +{hidden}
        </span>
      )}
    </span>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function getSourceMeta(inputType: string | null | undefined): { label: string; icon: typeof MessageSquare } | null {
  if (!inputType) return null;
  const normalized = inputType.toLowerCase();
  if (normalized.includes("transcript")) return { label: "Transcript", icon: Headphones };
  if (normalized.includes("voice")) return { label: "Voice", icon: Mic };
  if (normalized.includes("mcp")) return { label: "MCP", icon: Plug };
  if (normalized.includes("write")) return { label: "Write", icon: PenLine };
  if (normalized.includes("paste")) return { label: "Paste", icon: FileText };
  return { label: inputType.charAt(0).toUpperCase() + inputType.slice(1), icon: FileText };
}

function InboxHomeRow({ item, onInboxUpdate }: { item: InboxCardItem; onInboxUpdate: () => void }) {
  const { selectedCompanyId } = useCompany();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggestedLabel =
    item.routerDecision === "suggest_new"
      ? item.suggestedThreadTitle ?? "New thread"
      : item.suggestedThreadTitle ?? item.suggestedThreadId;

  async function triage(action: "make_thread" | "dismiss") {
    if (!selectedCompanyId) return;
    setIsPending(true);
    setError(null);
    try {
      await api.post(`/companies/${selectedCompanyId}/discussions/inbox/${item.id}/triage`, { action });
      onInboxUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Triage failed");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="group rounded-md border border-border bg-background px-3 py-2 text-sm transition-colors hover:bg-muted/35">
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-sm font-medium leading-snug">{item.rawContent}</span>
          <span className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Inbox className="size-3 shrink-0" aria-hidden />
              <span>{item.originSource ?? "Unknown source"}</span>
            </span>
            {suggestedLabel && (
              <span className="inline-flex min-w-0 items-center gap-1 truncate">
                <GitBranch className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{suggestedLabel}</span>
              </span>
            )}
          </span>
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{relativeTime(item.createdAt)}</span>
      </div>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      <div className="mt-2 flex items-center gap-1.5 opacity-80 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          onClick={() => triage("make_thread")}
          disabled={isPending}
          className="inline-flex h-6 items-center gap-1 rounded-md border border-border px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
        >
          {isPending ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
          Make thread
        </button>
        <button
          type="button"
          onClick={() => triage("dismiss")}
          disabled={isPending}
          className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <X className="size-3" />
          Dismiss
        </button>
        {item.routerDecision === "suggest_new" && (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Plus className="size-3" aria-hidden />
            Suggested new
          </span>
        )}
      </div>
    </div>
  );
}
