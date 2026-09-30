/**
 * ScopeProposalCard — renders entries with inputType='scope_proposal'.
 *
 * Adjutant posts a structured proposal entry whose rawContent is the JSON
 * payload defined by ScopeProposalPayloadSchema (summary + proposedTasks).
 * The "Active Proposal" badge is set by the caller — typically the most
 * recent scope_proposal entry in the thread is "active".
 */
import { useState } from "react";
import { CheckCircle2, ListChecks, XCircle, Sparkles, Pencil } from "lucide-react";
import type { ScopeProposalPayload } from "@armyofagents/shared";
import { cn } from "@/lib/utils";

interface ScopeProposalCardProps {
  proposal: ScopeProposalPayload;
  isActive: boolean;
  onApprove: (overrides?: { title: string }[]) => void;
  onReject: () => void;
  /** Optional auto-advance hint (ISO date string from proposal.autoAdvanceAt). */
  autoAdvanceAt?: string | null;
  /**
   * When true, a scope-version draft exists for this thread. The card enters
   * a "Scoped" done-state: the "Scoped" badge replaces "Active Proposal" and
   * the approve/reject/edit action row is hidden. The summary and task list
   * remain visible as an audit trail.
   *
   * NOTE: this is a thread-level signal — it cannot distinguish WHICH proposal
   * was scoped. In practice the e2e has at most one proposal per thread, so
   * this is acceptable.
   */
  scoped?: boolean;
}

export function ScopeProposalCard({
  proposal,
  isActive,
  onApprove,
  onReject,
  autoAdvanceAt,
  scoped = false,
}: ScopeProposalCardProps) {
  const [editMode, setEditMode] = useState(false);
  const [editedTasks, setEditedTasks] = useState(
    () => proposal.proposedTasks.map(t => ({ ...t })),
  );

  return (
    <div
      className={cn(
        "rounded-lg border bg-card/40 p-4 flex flex-col gap-3",
        isActive ? "border-amber-500/40" : "border-border",
      )}
      data-testid="scope-proposal-card"
      data-active={isActive ? "true" : "false"}
    >
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-amber-400" />
        <span className="text-sm font-semibold text-foreground">Scope Proposal</span>
        {scoped ? (
          <span
            className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400"
            data-testid="scope-proposal-scoped-badge"
          >
            <CheckCircle2 className="h-3 w-3" />
            Scoped
          </span>
        ) : isActive ? (
          <span
            className="ml-auto inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-300"
            data-testid="scope-proposal-active-badge"
          >
            Active Proposal
          </span>
        ) : null}
      </div>

      <p className="text-sm leading-relaxed text-foreground/90">{proposal.summary}</p>

      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <ListChecks className="h-3.5 w-3.5" />
        Proposed tasks ({proposal.proposedTasks.length})
      </div>

      {editMode ? (
        <ul className="flex flex-col gap-1.5" data-testid="scope-proposal-tasks">
          {editedTasks.map((task, i) => (
            <li
              key={i}
              className="flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-3 py-2"
              data-testid={`scope-proposal-task-${i}`}
            >
              <span className="shrink-0 inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground">
                {i + 1}
              </span>
              <input
                className="flex-1 bg-transparent text-sm font-medium outline-none border-b border-border/60 focus:border-foreground/40"
                value={task.title}
                onChange={e => {
                  const next = [...editedTasks];
                  next[i] = { ...next[i], title: e.target.value };
                  setEditedTasks(next);
                }}
                data-testid={`scope-proposal-edit-task-${i}`}
              />
            </li>
          ))}
        </ul>
      ) : (
        <ul
          className="flex flex-col gap-1.5 text-sm text-foreground/90"
          data-testid="scope-proposal-tasks"
        >
          {proposal.proposedTasks.map((task, i) => (
            <li
              key={i}
              className="flex items-start gap-2 rounded-md border border-border/60 bg-background/40 px-3 py-2"
              data-testid={`scope-proposal-task-${i}`}
            >
              <span className="shrink-0 inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground">
                {i + 1}
              </span>
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{task.title}</p>
                {task.description && (
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                    {task.description}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {autoAdvanceAt && (
        <p
          className="text-[11px] text-muted-foreground"
          data-testid="scope-proposal-auto-advance"
        >
          Auto-advances at {new Date(autoAdvanceAt).toLocaleString()}
        </p>
      )}

      {!scoped && (
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => onApprove(editMode ? editedTasks.map(t => ({ title: t.title })) : undefined)}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/15 px-3 py-1.5 text-sm font-medium text-emerald-300 hover:bg-emerald-500/25 transition-colors"
            data-testid="scope-proposal-approve"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Start Scoping
          </button>
          <button
            type="button"
            onClick={onReject}
            className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            data-testid="scope-proposal-reject"
          >
            <XCircle className="h-3.5 w-3.5" />
            Reject
          </button>
          <button
            type="button"
            onClick={() => setEditMode(m => !m)}
            className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted transition-colors"
            data-testid="scope-proposal-edit"
          >
            <Pencil className="h-3.5 w-3.5" />
            {editMode ? "Done editing" : "Edit tasks"}
          </button>
        </div>
      )}
    </div>
  );
}
