import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { History, Loader2 } from "lucide-react";
import type { Routine, RoutineRevisionListItem } from "@armyofagents/shared";
import { routinesApi } from "../../api/routines";
import { useToast } from "../../context/ToastContext";
import { diffLines, isDiffEmpty } from "../../lib/line-diff";
import { queryKeys } from "../../lib/queryKeys";
import { timeAgo } from "../../lib/timeAgo";
import { EmptyState } from "../EmptyState";
import { Button } from "@/components/ui/button";

interface Props {
  routineId: string;
  getBaseRevisionId: () => string | null;
  onRestored: (routine: Routine) => void;
}

interface RoutineRevisionCardProps {
  rev: RoutineRevisionListItem;
  prevDescription: string;
  onRestore: (revisionId: string) => void;
  isRestoring: boolean;
}

function RoutineRevisionCard({ rev, prevDescription, onRestore, isRestoring }: RoutineRevisionCardProps) {
  const [open, setOpen] = useState(false);

  const authorLabel =
    rev.author?.type === "agent"
      ? rev.author.name
      : rev.author?.type === "user"
        ? rev.author.userId
        : "System";

  const currentDescription = rev.snapshot.description ?? "";
  const hunks = useMemo(
    () => diffLines(prevDescription ?? "", currentDescription ?? ""),
    [prevDescription, currentDescription]
  );
  const noDescChange = isDiffEmpty(hunks);

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      {/* Header row */}
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm text-muted-foreground shrink-0">{timeAgo(rev.createdAt)}</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground truncate">
            {authorLabel}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide diff" : "Show diff"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={isRestoring}
            onClick={() => onRestore(rev.id)}
          >
            {isRestoring ? <><Loader2 className="mr-1 h-3 w-3 animate-spin" />Restoring...</> : "Restore"}
          </Button>
        </div>
      </div>

      {/* Expandable diff body */}
      {open && (
        <div className="border-t border-border px-4 py-3">
          {noDescChange ? (
            <p className="text-xs text-muted-foreground italic">No description change.</p>
          ) : (
            <div className="font-mono text-xs space-y-0.5">
              {hunks.map((hunk, hi) =>
                hunk.lines.map((line, li) => {
                  const key = `${hi}-${li}`;
                  if (line.type === "added") {
                    return (
                      <div
                        key={key}
                        className="bg-green-50 dark:bg-green-950/30 text-green-800 dark:text-green-300 px-2 whitespace-pre-wrap"
                      >
                        +{line.text}
                      </div>
                    );
                  }
                  if (line.type === "removed") {
                    return (
                      <div
                        key={key}
                        className="bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300 px-2 whitespace-pre-wrap"
                      >
                        -{line.text}
                      </div>
                    );
                  }
                  return (
                    <div key={key} className="text-muted-foreground px-2 whitespace-pre-wrap">
                      {line.text}
                    </div>
                  );
                }),
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function RoutineRevisionHistory({ routineId, getBaseRevisionId, onRestored }: Props) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const { data: revisions, isLoading, isError } = useQuery({
    queryKey: queryKeys.routines.revisions(routineId),
    queryFn: () => routinesApi.listRevisions(routineId),
    enabled: !!routineId,
  });

  const restoreMutation = useMutation({
    mutationFn: (revisionId: string) => routinesApi.restoreRevision(
      routineId,
      revisionId,
      getBaseRevisionId(),
    ),
    onSuccess: (updated) => {
      pushToast({ title: "Revision restored", tone: "success" });
      queryClient.invalidateQueries({ queryKey: queryKeys.routines.revisions(routineId) });
      onRestored(updated);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to restore revision",
        body: error instanceof Error ? error.message : "AoA could not restore the revision.",
        tone: "error",
      });
    },
  });

  if (isError) {
    return (
      <div className="py-8 text-center text-sm text-destructive">
        Failed to load revision history. Please try again.
      </div>
    );
  }

  if (isLoading) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Loading...</p>;
  }

  if (!revisions || revisions.length === 0) {
    return <EmptyState icon={History} message="No revision history yet." />;
  }

  return (
    <div className="space-y-2">
      {revisions.map((rev, index) => {
        const prevDescription = revisions[index + 1]?.snapshot.description ?? "";
        return (
          <RoutineRevisionCard
            key={rev.id}
            rev={rev}
            prevDescription={prevDescription}
            onRestore={(revisionId) => restoreMutation.mutate(revisionId)}
            isRestoring={restoreMutation.isPending && restoreMutation.variables === rev.id}
          />
        );
      })}
    </div>
  );
}
