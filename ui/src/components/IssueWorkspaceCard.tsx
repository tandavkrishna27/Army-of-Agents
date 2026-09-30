import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderGit2, GitBranch, ChevronDown } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { issuesApi } from "../api/issues";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { instanceSettingsApi } from "../api/instanceSettings";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import { useWorkspacePermissions } from "../hooks/useWorkspacePermissions";

type Mode = "inherit" | "shared_workspace" | "isolated_workspace" | "reuse_existing";

interface IssueWorkspaceCardProps {
  issueId: string;
  companyId: string | null;
  projectId: string | null;
  issueExecutionWorkspacePreference?: string | null;
  issueExecutionWorkspaceSettings?: Record<string, unknown> | null;
}

export function IssueWorkspaceCard({
  issueId,
  companyId,
  projectId,
  issueExecutionWorkspacePreference,
  issueExecutionWorkspaceSettings,
}: IssueWorkspaceCardProps) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const { data: instance } = useQuery({
    queryKey: queryKeys.instanceSettings.experimental,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });

  const isolatedEnabled = instance?.enableIsolatedWorkspaces === true;

  const { data: project } = useQuery({
    queryKey: queryKeys.projects.detail(projectId ?? ""),
    queryFn: () => projectsApi.get(projectId ?? "", companyId ?? undefined),
    enabled: Boolean(projectId) && isolatedEnabled,
  });

  const isSoftware = project?.functionType === "software_development";
  const policyEnabled = Boolean(project?.executionWorkspacePolicy?.enabled);
  const allowTaskOverride = project?.executionWorkspacePolicy?.allowIssueOverride !== false;
  const workspacePermissions = useWorkspacePermissions(companyId, projectId);

  const { data: reuseCandidates = [] } = useQuery({
    queryKey: [
      ...queryKeys.executionWorkspaces.list(companyId ?? ""),
      "reuseCandidates",
      projectId ?? "",
    ] as const,
    queryFn: () =>
      executionWorkspacesApi.listSummaries(companyId ?? "", {
        projectId: projectId ?? undefined,
        reuseEligible: true,
      }),
    enabled: Boolean(companyId) && Boolean(projectId) && isolatedEnabled && isSoftware,
  });

  const updateMutation = useMutation({
    mutationFn: (payload: { mode: Mode; reuseWorkspaceId?: string }) => {
      const currentSettings = (issueExecutionWorkspaceSettings ?? {}) as Record<string, unknown>;
      const nextSettings: Record<string, unknown> = { ...currentSettings };
      if (payload.mode === "reuse_existing" && payload.reuseWorkspaceId) {
        nextSettings.reuseWorkspaceId = payload.reuseWorkspaceId;
      } else {
        delete nextSettings.reuseWorkspaceId;
      }
      return issuesApi.update(issueId, {
        executionWorkspacePreference: payload.mode === "inherit" ? null : payload.mode,
        executionWorkspaceSettings: Object.keys(nextSettings).length > 0 ? nextSettings : null,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
      qc.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.list(companyId ?? "") });
    },
  });

  const deduplicatedCandidates = useMemo(() => {
    const byKey = new Map<string, typeof reuseCandidates[number]>();
    for (const ws of reuseCandidates) {
      const key = ws.branchName ?? ws.id;
      const existing = byKey.get(key);
      if (!existing || new Date(ws.lastUsedAt) > new Date(existing.lastUsedAt)) {
        byKey.set(key, ws);
      }
    }
    return Array.from(byKey.values());
  }, [reuseCandidates]);

  if (!isolatedEnabled || !projectId || !isSoftware || !policyEnabled) return null;

  const currentMode: Mode =
    (issueExecutionWorkspacePreference as Mode | null | undefined) ?? "inherit";
  const currentReuseId = (issueExecutionWorkspaceSettings as { reuseWorkspaceId?: string } | null)
    ?.reuseWorkspaceId ?? "";
  const showReuseOption = deduplicatedCandidates.length > 0;

  return (
    <div
      className="rounded-lg border border-border p-3"
      data-testid="issue-workspace-card"
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className="flex items-center justify-between w-full text-sm font-medium text-muted-foreground"
          data-testid="issue-workspace-card-trigger"
        >
          <span className="flex items-center gap-1.5">
            <FolderGit2 className="h-3.5 w-3.5" />
            Execution Workspace
          </span>
          <ChevronDown
            className={cn("h-4 w-4 transition-transform", open ? "rotate-180" : "")}
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3 space-y-3">
          {(!allowTaskOverride || !workspacePermissions.canOverrideTaskWorkspace) ? (
            <div className="rounded-md border border-border/70 px-3 py-2 text-sm">
              <div className="font-medium text-foreground">Department default</div>
              <div className="text-xs text-muted-foreground">
                {!allowTaskOverride
                  ? "Task-level workspace overrides are disabled in department Settings."
                  : "You can view the department default, but your role cannot change task workspace settings."}
              </div>
            </div>
          ) : (
            <>
          <Select
            value={currentMode}
            onValueChange={(value) => {
              if (value === "reuse_existing") {
                updateMutation.mutate({
                  mode: "reuse_existing",
                  reuseWorkspaceId: currentReuseId || deduplicatedCandidates[0]?.id,
                });
              } else {
                updateMutation.mutate({ mode: value as Mode });
              }
            }}
          >
            <SelectTrigger data-testid="issue-workspace-mode-trigger">
              <SelectValue placeholder="Use department default" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">Use department default</SelectItem>
              <SelectItem value="shared_workspace">
                Shared workspace
              </SelectItem>
              <SelectItem value="isolated_workspace">
                Isolated workspace
              </SelectItem>
              {showReuseOption && (
                <SelectItem value="reuse_existing">
                  Reuse existing workspace
                </SelectItem>
              )}
            </SelectContent>
          </Select>

          {currentMode === "reuse_existing" && showReuseOption && (
            <Select
              value={currentReuseId}
              onValueChange={(value) =>
                updateMutation.mutate({ mode: "reuse_existing", reuseWorkspaceId: value })
              }
            >
              <SelectTrigger data-testid="issue-workspace-reuse-trigger">
                <SelectValue placeholder="Choose workspace to reuse" />
              </SelectTrigger>
              <SelectContent>
                {deduplicatedCandidates.map((ws) => (
                  <SelectItem key={ws.id} value={ws.id}>
                    <span className="flex items-center gap-2">
                      <GitBranch className="h-3.5 w-3.5" />
                      <span>{ws.name}</span>
                      {ws.branchName && (
                        <span className="text-muted-foreground text-xs">
                          {ws.branchName}
                        </span>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
            </>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
