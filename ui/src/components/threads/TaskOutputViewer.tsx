/**
 * TaskOutputViewer — displays task outputs in the right panel viewer.
 * Uses the same detail surface structure as TaskSlideOver/TaskDetailPanel.
 */
import { useQuery } from "@tanstack/react-query";
import { FileCode, FileBox, GitBranch, ExternalLink, MonitorPlay, Link as LinkIcon } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { cn, relativeTime } from "@/lib/utils";
import { issuesApi } from "../../api/issues";
import { artifactsApi } from "../../api/artifacts";
import { queryKeys } from "../../lib/queryKeys";
import { StatusIcon } from "../StatusIcon";
import { PriorityIcon } from "../PriorityIcon";

export interface TaskOutputViewerProps {
  issueId: string;
  onNavigateToTask?: () => void;
  embedded?: boolean;
}

export function TaskOutputViewer({
  issueId,
  onNavigateToTask,
  embedded = true,
}: TaskOutputViewerProps) {
  const { data: issue, isLoading: issueLoading } = useQuery({
    queryKey: queryKeys.issues.detail(issueId),
    queryFn: () => issuesApi.get(issueId),
    enabled: !!issueId,
  });

  const { data: artifact, isLoading: artifactLoading } = useQuery({
    queryKey: queryKeys.artifacts.byIssue(issueId),
    queryFn: () => artifactsApi.getByIssueId(issueId),
    enabled: !!issueId,
  });

  const isLoading = issueLoading || artifactLoading;

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden bg-background",
        embedded ? "rounded-none" : "rounded-md",
      )}
      data-testid="task-output-viewer"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {issue && (
            <>
              <StatusIcon status={issue.status} />
              <PriorityIcon priority={issue.priority} />
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {issue.identifier ?? issue.id.slice(0, 8)}
              </span>
            </>
          )}
        </div>
        {onNavigateToTask && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onNavigateToTask}
            className="shrink-0"
            data-testid="navigate-to-task-button"
          >
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            Open Task
          </Button>
        )}
      </div>

      <ScrollArea className="flex-1 overflow-y-auto">
        <div className="space-y-5 p-4">
          {isLoading && <p className="text-sm text-muted-foreground">Loading outputs...</p>}

          {!isLoading && !issue && (
            <p className="text-sm text-muted-foreground">Task not found.</p>
          )}

          {issue && (
            <>
              {/* Task Title */}
              <div className="space-y-1">
                <h2 className="text-xl font-bold">{issue.title}</h2>
                {issue.description && (
                  <p className="text-sm text-muted-foreground">{issue.description}</p>
                )}
              </div>

              {/* Outputs Section */}
              <div className="space-y-3">
                <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <FileBox className="h-4 w-4" />
                  Task Outputs
                </h3>

                {artifact ? (
                  <div className="space-y-3">
                    {/* Primary Artifact */}
                    <div className="rounded-lg border border-border p-3">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <FileCode className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium text-sm">{artifact.title}</span>
                          {artifact.versions.length > 0 && (
                            <span className="text-xs font-mono text-muted-foreground">
                              v{artifact.versions[0].versionNumber}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                            {artifact.type}
                          </span>
                          <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                            {artifact.status}
                          </span>
                          {artifact.versions.length > 0 && (
                            <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                              {artifact.versions[0].source}
                            </span>
                          )}
                        </div>
                        {artifact.versions[0]?.changelog && (
                          <p className="text-xs text-muted-foreground italic">
                            &ldquo;{artifact.versions[0].changelog}&rdquo;
                          </p>
                        )}
                        {artifact.versions[0]?.content && (
                          <div className="mt-2 rounded border border-border bg-muted/20 p-2">
                            <pre className="text-xs overflow-auto max-h-32">
                              {artifact.versions[0].content.slice(0, 500)}
                              {artifact.versions[0].content.length > 500 && "..."}
                            </pre>
                          </div>
                        )}
                        {artifact.versions.length > 1 && (
                          <p className="text-xs text-muted-foreground">
                            {artifact.versions.length - 1} more version{artifact.versions.length > 2 ? "s" : ""}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Version History */}
                    {artifact.versions.length > 1 && (
                      <div className="space-y-1">
                        <h4 className="text-xs font-medium text-muted-foreground">Version History</h4>
                        <div className="border border-border rounded-lg divide-y divide-border">
                          {artifact.versions.slice(0, 5).map((v) => (
                            <div key={v.id} className="flex items-center justify-between px-3 py-2 text-xs">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="font-mono font-medium shrink-0">v{v.versionNumber}</span>
                                <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">
                                  {v.source}
                                </span>
                                {v.changelog && (
                                  <span className="text-muted-foreground truncate">{v.changelog}</span>
                                )}
                              </div>
                              <span className="text-muted-foreground shrink-0 ml-2">
                                {relativeTime(v.createdAt)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="rounded-lg border border-border p-4 text-center">
                    <FileBox className="mx-auto h-8 w-8 text-muted-foreground/50 mb-2" />
                    <p className="text-sm text-muted-foreground">No outputs yet</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Outputs will appear here when the task is completed
                    </p>
                  </div>
                )}
              </div>

              {/* Workspace Output Placeholder */}
              {issue.executionWorkspaceId && (
                <div className="space-y-2">
                  <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    <GitBranch className="h-4 w-4" />
                    Workspace
                  </h3>
                  <div className="rounded-lg border border-border p-3">
                    <div className="flex items-center gap-2 text-sm">
                      <MonitorPlay className="h-4 w-4 text-muted-foreground" />
                      <span className="text-muted-foreground">
                        Workspace linked to this task
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Additional Output Types Placeholder */}
              <div className="space-y-2">
                <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <LinkIcon className="h-4 w-4" />
                  Additional Outputs
                </h3>
                <div className="rounded-lg border border-border p-3">
                  <p className="text-xs text-muted-foreground">
                    Preview URLs, branches, and runtime services will appear here
                  </p>
                </div>
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
