import { Link } from "@/lib/router";
import { THREAD_PHASES, type ThreadPhase } from "@armyofagents/shared";
import type { ThreadListItem } from "../../api/threads";
import { cn } from "../../lib/utils";
import { Plus, Archive, ArchiveRestore } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UnlistedLane } from "./UnlistedLane";
import { groupThreadsForBoard } from "./boardModel";
import { AttentionCount, IconChip, LiveMarker, ParticipantStack } from "./ThreadCardIcons";
import {
  getAttentionCount,
  getBranchMeta,
  getInputSourceMeta,
  getScopeMeta,
  getVisibilityMeta,
} from "./threadCardMeta";

const PHASE_COLUMNS: Array<{ phase: ThreadPhase; label: string; headerClass: string }> = [
  { phase: "discuss", label: "Discuss", headerClass: "text-blue-700 dark:text-blue-400" },
  { phase: "scope", label: "Scope", headerClass: "text-amber-700 dark:text-amber-400" },
  { phase: "assign", label: "Assign", headerClass: "text-violet-700 dark:text-violet-400" },
  { phase: "done", label: "Done", headerClass: "text-green-700 dark:text-green-400" },
];

function relativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

interface ThreadBoardProps {
  threads: ThreadListItem[];
  archivedThreads?: ThreadListItem[];
  inboxItems?: InboxCardItem[];
  onNewThread: () => void;
  onInboxUpdate?: () => void;
  onUnarchiveThread?: (threadId: string) => void;
}

export interface InboxCardItem {
  id: string;
  rawContent: string;
  originSource: string | null;
  createdAt: string;
  routerDecision?: string | null;
  suggestedThreadId?: string | null;
  suggestedThreadTitle?: string | null;
  routerConfidence?: number | null;
  routingStatus?: string | null;
}

export function ThreadBoard({
  threads,
  archivedThreads = [],
  inboxItems = [],
  onNewThread,
  onInboxUpdate,
  onUnarchiveThread,
}: ThreadBoardProps) {
  const byPhase = groupThreadsForBoard(threads);
  const threadsById = new Map<string, string>();
  for (const t of threads) threadsById.set(t.id, t.title);
  for (const t of archivedThreads) threadsById.set(t.id, t.title);

  return (
    <div
      className="flex gap-3 overflow-x-auto pb-4 min-h-[400px]"
      data-testid="thread-board"
    >
      <UnlistedLane
        inboxItems={inboxItems}
        threadsById={threadsById}
        onTriaged={(_itemId, _action) => {
          onInboxUpdate?.();
        }}
      />

      {PHASE_COLUMNS.map(({ phase, label, headerClass }) => (
        <PhaseColumn
          key={phase}
          phase={phase}
          label={label}
          headerClass={headerClass}
          threads={byPhase[phase] ?? []}
          onNewThread={onNewThread}
        />
      ))}

      <ArchivedColumn threads={archivedThreads} onUnarchiveThread={onUnarchiveThread} />
    </div>
  );
}

interface PhaseColumnProps {
  phase: ThreadPhase;
  label: string;
  headerClass: string;
  threads: ThreadListItem[];
  onNewThread: () => void;
}

function PhaseColumn({ phase, label, headerClass, threads, onNewThread }: PhaseColumnProps) {
  return (
    <div
      role="region"
      aria-label={label}
      className="flex-none w-[240px] rounded-lg border border-border bg-muted/30 flex flex-col"
      data-testid={`phase-column-${phase}`}
    >
      <div className="px-3 py-2.5 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <p className={cn("text-xs font-semibold uppercase tracking-wider", headerClass)}>
            {label}
          </p>
          <span className="text-[10px] text-muted-foreground font-medium">
            {threads.length}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onNewThread}
          className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
          aria-label={`New thread in ${label}`}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex-1 p-2 space-y-2 overflow-y-auto">
        {threads.length === 0 ? (
          <p className="text-[11px] text-muted-foreground text-center py-4 opacity-60">
            No threads
          </p>
        ) : (
          threads.map((thread) => (
            <BoardCard key={thread.id} thread={thread} phase={phase} />
          ))
        )}
      </div>
    </div>
  );
}

function ArchivedColumn({
  threads,
  onUnarchiveThread,
}: {
  threads: ThreadListItem[];
  onUnarchiveThread?: (threadId: string) => void;
}) {
  return (
    <div
      role="region"
      aria-label="Archived"
      className="flex-none w-[240px] rounded-lg border border-border bg-muted/20 flex flex-col opacity-70"
      data-testid="archived-column"
    >
      <div className="px-3 py-2.5 border-b border-border flex items-center gap-2">
        <Archive className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" aria-hidden />
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
          Archived
        </p>
        <span className="text-[10px] text-muted-foreground font-medium">
          {threads.length}
        </span>
      </div>

      <div className="flex-1 p-2 space-y-2 overflow-y-auto">
        {threads.length === 0 ? (
          <p className="text-[11px] text-muted-foreground text-center py-4 opacity-60">
            No archived threads
          </p>
        ) : (
          threads.map((thread) => (
            <BoardCard
              key={thread.id}
              thread={thread}
              phase={"done" as ThreadPhase}
              archived
              onUnarchiveThread={onUnarchiveThread}
            />
          ))
        )}
      </div>
    </div>
  );
}

function BoardCard({
  thread,
  phase: _phase,
  archived = false,
  onUnarchiveThread,
}: {
  thread: ThreadListItem;
  phase: ThreadPhase;
  archived?: boolean;
  onUnarchiveThread?: (threadId: string) => void;
}) {
  const source = getInputSourceMeta(thread.lastEntryInputType);
  const scope = getScopeMeta(thread);
  const visibility = getVisibilityMeta(thread.visibility);
  const branch = getBranchMeta(thread);
  const attention = getAttentionCount(thread);
  const participants = thread.participantPreview ?? [];
  const participantFallback = participants.length
    ? participants
    : [{ name: thread.ownerUserId ?? "Unclaimed" }];

  return (
    <div
      className={cn(
        "relative rounded-md border transition-colors",
        archived
          ? "border-border bg-muted/30 opacity-70 hover:bg-muted/50"
          : "border-border bg-background hover:bg-accent/40",
      )}
    >
      <Link
        to={`/discussions/${thread.id}`}
        className="block p-2.5 pr-9 text-left"
      >
        {attention && <AttentionCount count={attention.count} />}
        {thread.subtype === "live" && !attention && <LiveMarker />}

        <p className="line-clamp-2 text-xs font-medium leading-snug">{thread.title}</p>
        {thread.summaryNext && (
          <p className="mt-1 line-clamp-1 text-[11px] text-muted-foreground">
            {thread.summaryNext}
          </p>
        )}

        <div className="mt-2 flex items-center gap-1">
          <IconChip Icon={source.Icon} label={`Source: ${source.label}`} tone="source" />
          {scope && <IconChip Icon={scope.Icon} label={scope.title} tone="scope" />}
          <IconChip Icon={visibility.Icon} label={visibility.label} tone="visibility" />
          {branch && <IconChip Icon={branch.Icon} label={branch.title} tone="branch" />}
        </div>

        <div className="mt-2 flex items-center justify-between gap-2">
          <ParticipantStack
            participants={participantFallback}
            total={thread.participantCount ?? participants.length}
          />
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {relativeTime(thread.lastEntryAt)}
          </span>
        </div>
      </Link>
      {archived && onUnarchiveThread && (
        <button
          type="button"
          aria-label={`Unarchive ${thread.title}`}
          onClick={() => onUnarchiveThread(thread.id)}
          className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
        >
          <ArchiveRestore className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
