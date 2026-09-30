import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { activityApi } from "../../../api/activity";
import { queryKeys } from "../../../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FileTree } from "../FileTree";
import type { DetectedOutput } from "@armyofagents/shared";

interface ChangesContextSectionProps {
  issueId: string;
  workspaceId?: string;
  selectedFile?: string | null;
  onSelectFile?: (path: string) => void;
}

export function ChangesContextSection({
  issueId,
  workspaceId,
  selectedFile,
  onSelectFile,
}: ChangesContextSectionProps) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const { data: runs, isLoading } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
  });

  if (isLoading) {
    return (
      <div className="space-y-1.5 px-3" data-testid="changes-context-skeleton">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
      </div>
    );
  }

  if (!runs || runs.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground" data-testid="changes-context-empty">
        No runs with file changes yet
      </div>
    );
  }

  const activeRunId = selectedRunId ?? runs[0].runId;
  const activeRun = runs.find((r) => r.runId === activeRunId);
  const outputs: DetectedOutput[] = activeRun?.detectedOutputs ?? [];

  return (
    <div className="space-y-1" data-testid="changes-context-section">
      {/* Run selector */}
      {runs.length > 1 && (
        <div className="flex items-center gap-1 px-3 py-1 overflow-x-auto">
          {runs.slice(0, 8).map((r) => (
            <Button
              key={r.runId}
              variant={activeRunId === r.runId ? "secondary" : "ghost"}
              size="sm"
              className="h-5 px-1.5 text-[10px] shrink-0"
              onClick={() => setSelectedRunId(r.runId)}
            >
              {r.runId.slice(0, 6)}
            </Button>
          ))}
        </div>
      )}

      {/* File tree */}
      <FileTree
        outputs={outputs}
        selectedFile={selectedFile}
        onSelectFile={onSelectFile}
        workspaceId={workspaceId}
      />
    </div>
  );
}
