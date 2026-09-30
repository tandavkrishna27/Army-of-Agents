import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { executionWorkspacesApi } from "../../api/execution-workspaces";
import { ApiError } from "../../api/client";
import { queryKeys } from "../../lib/queryKeys";

interface Props {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onArchived?: () => void;
}

export function ExecutionWorkspaceCloseDialog({
  workspaceId,
  open,
  onOpenChange,
  onArchived,
}: Props) {
  const qc = useQueryClient();

  const readinessQuery = useQuery({
    queryKey: ["close-readiness", workspaceId],
    queryFn: () => executionWorkspacesApi.getCloseReadiness(workspaceId),
    enabled: open,
  });

  const archiveMutation = useMutation({
    mutationFn: () => executionWorkspacesApi.update(workspaceId, { status: "archived" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.detail(workspaceId) });
      onOpenChange(false);
      onArchived?.();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        void readinessQuery.refetch();
      }
    },
  });

  const readiness = readinessQuery.data ?? null;
  const isLoading = readinessQuery.isLoading;
  const isBlocked = readiness?.state === "blocked";
  const hasWarnings = readiness?.state === "ready_with_warnings";
  const isShared = readiness?.isSharedWorkspace ?? false;

  const titleIcon = isBlocked ? (
    <XCircle className="h-5 w-5 text-destructive" />
  ) : hasWarnings ? (
    <AlertTriangle className="h-5 w-5 text-amber-500" />
  ) : (
    <CheckCircle2 className="h-5 w-5 text-green-500" />
  );

  const titleText = isBlocked
    ? isShared
      ? "Cannot close workspace session"
      : "Cannot archive workspace"
    : hasWarnings
      ? isShared
        ? "Review before closing session"
        : "Review before archiving"
      : isShared
        ? "Close workspace session"
        : "Archive workspace";

  const descriptionText = isLoading
    ? "Checking readiness..."
    : isBlocked
      ? "Blockers must be resolved first."
      : isShared
        ? "This shared workspace session will be closed. The underlying project workspace stays put."
        : "The following actions will run. Review before confirming.";

  const actionLabel = archiveMutation.isPending
    ? isShared
      ? "Closing..."
      : "Archiving..."
    : isBlocked
      ? isShared
        ? "Cannot close"
        : "Cannot archive"
      : isShared
        ? "Detach and close"
        : "Archive workspace";

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-2xl" data-testid="workspace-close-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {titleIcon}
            {titleText}
          </AlertDialogTitle>
          <AlertDialogDescription>{descriptionText}</AlertDialogDescription>
        </AlertDialogHeader>

        {isLoading && (
          <div
            className="flex items-center gap-2 text-sm text-muted-foreground py-6"
            data-testid="workspace-close-loading"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking readiness...
          </div>
        )}

        {readiness && !isLoading && (
          <div className="space-y-4 my-2 max-h-[60vh] overflow-y-auto">
            {readiness.blockingReasons.length > 0 && (
              <section
                className="rounded-lg border border-destructive/30 bg-destructive/5 p-3"
                data-testid="workspace-close-blockers"
              >
                <div className="text-sm font-medium text-destructive mb-2">Blockers</div>
                <ul className="text-sm space-y-1">
                  {readiness.blockingReasons.map((reason, i) => (
                    <li key={i}>• {reason}</li>
                  ))}
                </ul>
              </section>
            )}

            {readiness.warnings.length > 0 && (
              <section
                className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 p-3"
                data-testid="workspace-close-warnings"
              >
                <div className="text-sm font-medium text-amber-900 dark:text-amber-300 mb-2">
                  Warnings
                </div>
                <ul className="text-sm space-y-1 text-amber-900 dark:text-amber-200">
                  {readiness.warnings.map((warning, i) => (
                    <li key={i}>• {warning}</li>
                  ))}
                </ul>
              </section>
            )}

            {readiness.linkedIssues.length > 0 && (
              <section data-testid="workspace-close-linked-issues">
                <div className="text-sm font-medium mb-2">
                  Linked tasks ({readiness.linkedIssues.length})
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {readiness.linkedIssues.map((issue) => (
                    <Badge
                      key={issue.id}
                      variant={issue.isTerminal ? "secondary" : "outline"}
                      className={cn(
                        !issue.isTerminal &&
                          "border-amber-300 text-amber-900 dark:border-amber-800 dark:text-amber-200",
                      )}
                      data-testid={`workspace-close-linked-issue-${issue.id}`}
                    >
                      {issue.identifier ? `${issue.identifier}: ${issue.title}` : issue.title}
                    </Badge>
                  ))}
                </div>
              </section>
            )}

            {readiness.runtimeServices.length > 0 && (
              <section data-testid="workspace-close-services">
                <div className="text-sm font-medium mb-2">
                  Runtime services ({readiness.runtimeServices.length})
                </div>
                <ul className="text-sm space-y-1">
                  {readiness.runtimeServices.map((svc) => (
                    <li key={svc.id} className="flex items-center gap-2">
                      <span className="font-mono text-xs">{svc.serviceName}</span>
                      <Badge
                        variant={svc.status === "stopped" ? "secondary" : "outline"}
                        className="text-[10px]"
                      >
                        {svc.status}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {readiness.plannedActions.length > 0 && (
              <section data-testid="workspace-close-planned-actions">
                <div className="text-sm font-medium mb-2">
                  Planned actions ({readiness.plannedActions.length})
                </div>
                <ol className="space-y-2 list-decimal ml-4">
                  {readiness.plannedActions.map((action, i) => (
                    <li key={i} data-testid={`workspace-close-action-${action.kind}`}>
                      <div className="text-sm font-medium">{action.label}</div>
                      <div className="text-xs text-muted-foreground">{action.description}</div>
                      {action.command && (
                        <code className="mt-1 block px-2 py-1 bg-muted rounded text-xs font-mono break-all">
                          {action.command}
                        </code>
                      )}
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={archiveMutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/40"
            disabled={isLoading || isBlocked || archiveMutation.isPending}
            data-testid="confirm-archive-workspace"
            onClick={(e) => {
              e.preventDefault();
              archiveMutation.mutate();
            }}
          >
            {actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
