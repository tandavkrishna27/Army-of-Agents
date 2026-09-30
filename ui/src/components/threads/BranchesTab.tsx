/**
 * BranchesTab — shows spin_off_thread extracted items and child thread stubs.
 * Data: extractedItems where type === 'spin_off_thread'
 * TODO: also fetch GET /threads/:id/children when that endpoint ships.
 */
import { GitBranch, ExternalLink } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { threadsApi } from "../../api/threads";
import { useToast } from "../../context/ToastContext";
import { relativeTime } from "@/lib/utils";
import type { ScopeItem } from "./scopeGrouping";

/* ─── Phase badge ─── */

const PHASE_BADGE: Record<string, { label: string; color: string }> = {
  discuss: { label: "Discuss",  color: "#3FA8C7" },
  scope:   { label: "Scope",    color: "#D9A938" },
  assign:  { label: "Assign",   color: "#6470DC" },
  done:    { label: "Done",     color: "#4FB67E" },
};

/* ════════════════════════════════════════════════════════════════════════
   BranchesTab
   ════════════════════════════════════════════════════════════════════════ */

export interface BranchesTabProps {
  /** All scope items — branch tab filters to spin_off_thread type. */
  items: ScopeItem[];
  companyId?: string;
  discussionId?: string;
}

export function BranchesTab({ items, companyId, discussionId }: BranchesTabProps) {
  const branches = items.filter((i) => i.type === "spin_off_thread");

  if (branches.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center px-4">
        <GitBranch className="h-6 w-6 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">
          No branch threads yet.
        </p>
        <p className="text-xs text-muted-foreground/60 max-w-xs">
          When Scribe identifies a topic that deserves its own thread, it appears here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 py-2" data-testid="branches-tab">
      <p className="text-[11px] text-muted-foreground/60 uppercase tracking-wider font-semibold px-0.5">
        {branches.length} branch{branches.length !== 1 ? "es" : ""}
      </p>
      {branches.map((item) => (
        <BranchCard
          key={item.id}
          item={item}
          companyId={companyId}
          discussionId={discussionId}
        />
      ))}
    </div>
  );
}

/* ─── BranchCard ─── */

function BranchCard({
  item,
  companyId,
  discussionId,
}: {
  item: ScopeItem;
  companyId?: string;
  discussionId?: string;
}) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const spinOffMutation = useMutation({
    mutationFn: () => {
      if (!companyId || !discussionId) throw new Error("Missing context");
      return threadsApi.spinOff(companyId, discussionId, item.id, item.title);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["threads", companyId] });
      pushToast({ title: "Branch thread created", tone: "success" });
      // TODO: navigate to new thread when route is ready — data.id
      void data;
    },
    onError: () => pushToast({ title: "Failed to create branch", tone: "warn" }),
  });

  const isSpunOff = item.status === "approved" && item.resultTaskId;
  const phase = PHASE_BADGE.discuss;

  return (
    <div
      className="rounded-lg border border-border"
      style={{ background: "var(--card-2, #1d2128)" }}
      data-testid={`branch-card-${item.id}`}
    >
      {/* Main content */}
      <div className="p-3.5 flex items-start gap-3">
        <div
          className="mt-0.5 shrink-0 w-7 h-7 rounded-full flex items-center justify-center"
          style={{ background: "rgba(100,112,220,0.15)" }}
        >
          <GitBranch className="h-3.5 w-3.5" style={{ color: "#6470DC" }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-sm font-semibold text-foreground line-clamp-2 flex-1">
              {item.title}
            </span>
            <span
              className="shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold"
              style={{ color: phase.color, background: `${phase.color}20` }}
            >
              {phase.label}
            </span>
          </div>
          {item.description && (
            <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
              {item.description}
            </p>
          )}
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground/60">
            <span>{relativeTime(item.createdAt)}</span>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div
        className="border-t border-border/60 px-3.5 py-2.5 flex items-center justify-between"
      >
        <span className="text-[11px] text-muted-foreground/50">
          {isSpunOff ? "Branch created" : "Pending spin-off"}
        </span>
        {!isSpunOff && (
          <button
            type="button"
            onClick={() => spinOffMutation.mutate()}
            disabled={spinOffMutation.isPending || !companyId || !discussionId}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium border border-border hover:bg-muted/30 transition-colors text-muted-foreground disabled:opacity-50"
          >
            <ExternalLink className="h-3 w-3" />
            Open thread →
          </button>
        )}
        {isSpunOff && (
          <span
            className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-0.5 rounded-full"
            style={{ color: "#4FB67E", background: "rgba(79,182,126,0.1)" }}
          >
            ✓ Active
          </span>
        )}
      </div>
    </div>
  );
}
