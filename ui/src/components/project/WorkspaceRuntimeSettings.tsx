import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@armyofagents/shared";
import { projectsApi } from "../../api/projects";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";
import { FolderBrowserDialog } from "../FolderBrowserDialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { ExternalLink, FolderOpen, Github, Trash2 } from "lucide-react";

const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";

interface WorkspaceRuntimeSettingsProps {
  project: Project;
  onUpdate?: (data: Record<string, unknown>) => void;
}

function formatGitHubRepo(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
  } catch {
    return url;
  }
}

export function WorkspaceRuntimeSettings({ project, onUpdate }: WorkspaceRuntimeSettingsProps) {
  const queryClient = useQueryClient();
  const [folderBrowserOpen, setFolderBrowserOpen] = useState(false);
  const [repoDialogOpen, setRepoDialogOpen] = useState(false);
  const [workspaceRepoUrl, setWorkspaceRepoUrl] = useState("");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const workspaces = project.workspaces ?? [];
  const policy = project.executionWorkspacePolicy;

  const invalidateProject = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(project.companyId) });
  };

  const createWorkspace = useMutation({
    mutationFn: (data: { cwd?: string | null; repoUrl?: string | null }) =>
      projectsApi.createWorkspace(project.id, data),
    onSuccess: invalidateProject,
  });

  const removeWorkspace = useMutation({
    mutationFn: (workspaceId: string) => projectsApi.removeWorkspace(project.id, workspaceId),
    onSuccess: invalidateProject,
  });

  const updateWorkspace = useMutation({
    mutationFn: ({ workspaceId, data }: { workspaceId: string; data: Record<string, unknown> }) =>
      projectsApi.updateWorkspace(project.id, workspaceId, data),
    onSuccess: invalidateProject,
  });

  const updatePolicy = (patch: Record<string, unknown>) => {
    if (!onUpdate || !policy) return;
    onUpdate({
      executionWorkspacePolicy: {
        ...policy,
        enabled: true,
        ...patch,
      },
    });
  };

  const updatePolicyStrategy = (patch: Record<string, unknown>) => {
    if (!policy) return;
    updatePolicy({
      workspaceStrategy: {
        type: project.functionType === "software_development" ? "git_worktree" : "project_primary",
        ...((policy.workspaceStrategy as Record<string, unknown> | null) ?? {}),
        ...patch,
      },
    });
  };

  const removeWorkspaceSource = (
    workspace: Project["workspaces"][number],
    source: "cwd" | "repoUrl",
  ) => {
    const hasUsableCwd = Boolean(workspace.cwd && workspace.cwd !== REPO_ONLY_CWD_SENTINEL);
    const hasRepoUrl = Boolean(workspace.repoUrl);
    if (source === "cwd" && hasRepoUrl) {
      updateWorkspace.mutate({ workspaceId: workspace.id, data: { cwd: null } });
      return;
    }
    if (source === "repoUrl" && hasUsableCwd) {
      updateWorkspace.mutate({ workspaceId: workspace.id, data: { repoUrl: null } });
      return;
    }
    removeWorkspace.mutate(workspace.id);
  };

  const submitLocalWorkspace = (selectedPath: string) => {
    const cwd = selectedPath.trim();
    if (!cwd) return;
    createWorkspace.mutate(
      { cwd },
      {
        onSuccess: () => {
          setFolderBrowserOpen(false);
          setWorkspaceError(null);
        },
        onError: () => setWorkspaceError("Failed to save workspace local folder."),
      },
    );
  };

  const submitRepoWorkspace = () => {
    const repoUrl = workspaceRepoUrl.trim();
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(repoUrl)) {
      setWorkspaceError("Repo workspace must use a valid GitHub repo URL.");
      return;
    }
    createWorkspace.mutate(
      { cwd: REPO_ONLY_CWD_SENTINEL, repoUrl },
      {
        onSuccess: () => {
          setRepoDialogOpen(false);
          setWorkspaceRepoUrl("");
          setWorkspaceError(null);
        },
        onError: () => setWorkspaceError("Failed to save workspace repo."),
      },
    );
  };

  return (
    <div className="space-y-5">
      <div className="space-y-3 rounded-md border border-border/70 p-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-foreground">Workspace sources</h3>
          <p className="text-xs text-muted-foreground">
            Hints agents use to choose the right local folder or repository for new work.
          </p>
        </div>

        {workspaces.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
            No workspace source configured.
          </p>
        ) : (
          <div className="space-y-1">
            {workspaces.map((workspace) => (
              <div key={workspace.id} className="rounded-md border border-border/60 px-3 py-2">
                {workspace.cwd && workspace.cwd !== REPO_ONLY_CWD_SENTINEL ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{workspace.cwd}</span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => removeWorkspaceSource(workspace, "cwd")}
                      aria-label="Delete local folder"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ) : null}
                {workspace.repoUrl ? (
                  <div className="flex items-center justify-between gap-2">
                    <a
                      href={workspace.repoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
                    >
                      <Github className="h-3 w-3 shrink-0" />
                      <span className="truncate">{formatGitHubRepo(workspace.repoUrl)}</span>
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => removeWorkspaceSource(workspace, "repoUrl")}
                      aria-label="Delete workspace repo"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="h-7 px-2.5"
            onClick={() => {
              setWorkspaceError(null);
              setFolderBrowserOpen(true);
            }}
          >
            <FolderOpen className="mr-1.5 h-3 w-3" />
            Add local folder
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="h-7 px-2.5"
            onClick={() => {
              setWorkspaceError(null);
              setRepoDialogOpen(true);
            }}
          >
            <Github className="mr-1.5 h-3 w-3" />
            Add GitHub repo
          </Button>
        </div>

        <FolderBrowserDialog
          open={folderBrowserOpen}
          onClose={() => setFolderBrowserOpen(false)}
          onSelect={submitLocalWorkspace}
          title="Add local folder"
          description="Choose a folder this department can use as a workspace source."
          gitAware={project.functionType === "software_development"}
          initialPath={workspaces.find((workspace) => workspace.cwd && workspace.cwd !== REPO_ONLY_CWD_SENTINEL)?.cwd ?? undefined}
        />

        <Dialog
          open={repoDialogOpen}
          onOpenChange={(open) => {
            setRepoDialogOpen(open);
            if (!open) {
              setWorkspaceRepoUrl("");
              setWorkspaceError(null);
            }
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Add GitHub repo</DialogTitle>
              <DialogDescription>
                Add a repository URL agents can use when creating isolated or shared workspaces.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-2">
              <label htmlFor="project-workspace-repo-url" className="text-xs font-medium text-muted-foreground">
                Repository URL
              </label>
              <input
                id="project-workspace-repo-url"
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/50 focus:border-foreground"
                value={workspaceRepoUrl}
                onChange={(event) => setWorkspaceRepoUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && workspaceRepoUrl.trim()) {
                    submitRepoWorkspace();
                  }
                }}
                placeholder="https://github.com/org/repo"
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                Use the canonical GitHub repository URL. Private repos require the company GitHub PAT to be configured.
              </p>
              {workspaceError && <p className="text-xs text-destructive">{workspaceError}</p>}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRepoDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={!workspaceRepoUrl.trim() || createWorkspace.isPending}
                onClick={submitRepoWorkspace}
              >
                Save repo
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {workspaceError && <p className="text-xs text-destructive">{workspaceError}</p>}
      </div>

      <div className="space-y-3 rounded-md border border-border/70 p-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-foreground">Workspace policy</h3>
          <p className="text-xs text-muted-foreground">
            These defaults affect new tasks and future runs only.
          </p>
        </div>

        {!policy ? (
          <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
            This department does not have a workspace policy yet.
          </p>
        ) : (
          <>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Default mode</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-xs transition-colors",
                    policy.defaultMode === "isolated_workspace" || !policy.defaultMode
                      ? "border-foreground bg-accent/40 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent/30",
                  )}
                  onClick={() => updatePolicy({ defaultMode: "isolated_workspace" })}
                  disabled={!onUpdate}
                >
                  Isolated
                </button>
                <button
                  type="button"
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-xs transition-colors",
                    policy.defaultMode === "shared_workspace"
                      ? "border-foreground bg-accent/40 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent/30",
                  )}
                  onClick={() => updatePolicy({ defaultMode: "shared_workspace" })}
                  disabled={!onUpdate}
                >
                  Shared
                </button>
              </div>
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={policy.allowIssueOverride ?? false}
                onChange={(event) => updatePolicy({ allowIssueOverride: event.target.checked })}
                disabled={!onUpdate}
                className="h-3.5 w-3.5"
              />
              Allow tasks to override workspace mode
            </label>

            <div className="space-y-1">
              <label htmlFor="workspace-runtime-ttl" className="text-xs text-muted-foreground">
                Workspace TTL (days)
              </label>
              <input
                id="workspace-runtime-ttl"
                data-testid="project-ttl-days-input"
                type="number"
                min={0}
                placeholder="Never expires"
                defaultValue={policy.ttlDays ?? ""}
                onBlur={(event) => {
                  const raw = event.target.value.trim();
                  const next = raw === "" ? null : Number(raw);
                  const current = policy.ttlDays ?? null;
                  if (Number.isNaN(next as number) || next === current) return;
                  updatePolicy({ ttlDays: next });
                }}
                disabled={!onUpdate}
                className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
              />
              <p className="text-[10px] text-muted-foreground">
                Leave blank for no expiry. Cleanup eligibility is handled by the workspace TTL sweeper.
              </p>
            </div>

            {project.functionType === "software_development" && (
              <>
                <Separator />
                <div className="space-y-2">
                  <button
                    type="button"
                    className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() => setAdvancedOpen((open) => !open)}
                  >
                    {advancedOpen ? "Hide advanced runtime strategy" : "Advanced runtime strategy"}
                  </button>
                  {advancedOpen && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {[
                        { key: "baseRef", label: "Base ref", placeholder: "main" },
                        { key: "branchTemplate", label: "Branch template", placeholder: "{{issue.identifier}}-{{slug}}" },
                        { key: "provisionCommand", label: "Provision command", placeholder: "pnpm install" },
                        { key: "teardownCommand", label: "Teardown command", placeholder: "" },
                      ].map(({ key, label, placeholder }) => (
                        <label key={key} className="space-y-1">
                          <span className="text-xs text-muted-foreground">{label}</span>
                          <input
                            className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                            defaultValue={(policy.workspaceStrategy as Record<string, unknown> | null)?.[key] as string ?? ""}
                            onBlur={(event) => updatePolicyStrategy({ [key]: event.target.value || null })}
                            placeholder={placeholder}
                            disabled={!onUpdate}
                          />
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
