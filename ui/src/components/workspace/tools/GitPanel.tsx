import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Github,
  Loader2,
  RefreshCw,
  Upload,
} from "lucide-react";
import type { ExecutionWorkspace, GitHubPrMetadata, GitHubPrMergeMethod } from "@armyofagents/shared";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { OpenInIdeButton } from "../OpenInIdeButton";
import { CreatePrDialog } from "../CreatePrDialog";
import { githubIntegrationApi } from "@/api/github-integration";
import { useToast } from "../../../context/ToastContext";
import { useWorkspacePermissions } from "../../../hooks/useWorkspacePermissions";
import { queryKeys } from "../../../lib/queryKeys";
import {
  executionWorkspacesApi,
  type GitFileEntry,
  type GitStatusResponse,
  type GitLogEntry,
  type WorkspaceMutationSafety,
} from "@/api/execution-workspaces";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GitPanelProps {
  workspace: ExecutionWorkspace;
  issueId?: string | null;
  isExpanded?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_POLL_INTERVAL = 10_000; // 10s — server cache is 5s
const LOG_POLL_INTERVAL = 30_000;
const PR_POLL_MS = 30_000; // 30s background poll for PR status

const FILE_STATUS_COLORS: Record<string, string> = {
  modified: "text-yellow-400",
  added: "text-green-400",
  deleted: "text-red-400",
  renamed: "text-blue-400",
  copied: "text-blue-400",
  untracked: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

const FILE_STATUS_LABELS: Record<string, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "?",
  unknown: "?",
};

const prStateColor: Record<string, string> = {
  open: "bg-green-500/15 text-green-400",
  merged: "bg-purple-500/15 text-purple-400",
  closed: "bg-red-500/15 text-red-400",
};

type RemoteState = GitStatusResponse["remote"];

function remoteName(remote: RemoteState): string | null {
  if (!remote) return null;
  return typeof remote === "string" ? remote : remote.name;
}

function remoteBranchLabel({
  remote,
  branch,
  ahead,
  behind,
}: {
  remote: RemoteState;
  branch: string | null;
  ahead: number | null | undefined;
  behind: number | null | undefined;
}) {
  if (!branch) return "not tracked";
  if (!remote) return "not pushed";
  if (ahead == null && behind == null) return "not tracked";
  return branch;
}

function formatWorktreeMode(workspace: ExecutionWorkspace) {
  return workspace.providerType === "git_worktree" ? "Isolated workspace" : "Shared workspace";
}

function formatRemoteSync(ahead: number | null | undefined, behind: number | null | undefined) {
  if ((ahead ?? 0) > 0 && (behind ?? 0) > 0) return `diverged +${ahead} / -${behind}`;
  if ((behind ?? 0) > 0) return `behind ${behind}`;
  if ((ahead ?? 0) > 0) return `ahead ${ahead}`;
  if (ahead == null && behind == null) return "not pushed";
  return "up to date";
}

function formatLocalSync(ahead: number | null | undefined, behind: number | null | undefined) {
  if (ahead == null && behind == null) return "Tracking unknown";
  if ((ahead ?? 0) > 0 && (behind ?? 0) > 0) {
    return `${ahead} ahead, ${behind} behind`;
  }
  if ((ahead ?? 0) > 0) {
    return `${ahead} commit${ahead === 1 ? "" : "s"} ahead`;
  }
  if ((behind ?? 0) > 0) return "No unpushed commits";
  return "No unpushed commits";
}

function prSummary(pr: GitHubPrMetadata | undefined) {
  if (!pr) return "No pull request";
  return `PR #${pr.number} ${pr.state}`;
}

function gitStatusChipLabel({
  gitAvailable,
  detachedHead,
  files,
  remote,
  hasRepoUrl,
  ahead,
  behind,
  pr,
}: {
  gitAvailable: boolean;
  detachedHead: boolean;
  files: GitFileEntry[];
  remote: RemoteState;
  hasRepoUrl: boolean;
  ahead: number | null | undefined;
  behind: number | null | undefined;
  pr: GitHubPrMetadata | undefined;
}) {
  if (!gitAvailable || detachedHead || (ahead ?? 0) > 0 && (behind ?? 0) > 0 || (behind ?? 0) > 0) {
    return "attention";
  }
  if (files.length > 0) return `${files.length} change${files.length === 1 ? "" : "s"}`;
  if ((ahead ?? 0) > 0) return `ahead ${ahead}`;
  if (pr?.state === "merged") return "merged";
  if (pr) return `PR ${pr.state}`;
  if (!remote && !hasRepoUrl) return "local only";
  return "clean";
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RequestReviewInline({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (reviewers: string[]) => Promise<void>;
}) {
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);

  async function handleSubmit() {
    const reviewers = input.split(",").map((s) => s.trim()).filter(Boolean);
    if (reviewers.length === 0) return;
    setPending(true);
    try { await onSubmit(reviewers); } finally { setPending(false); }
  }

  return (
    <div className="flex items-center gap-1.5 pt-1">
      <input
        autoFocus
        aria-label="Reviewer logins, comma-separated"
        className="flex-1 rounded-md border border-input bg-transparent px-2 py-1 text-xs outline-none"
        placeholder="logins, comma-separated"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void handleSubmit(); if (e.key === "Escape") onClose(); }}
      />
      <Button size="sm" variant="default" className="h-7 text-xs" onClick={() => void handleSubmit()} disabled={pending || !input.trim()}>
        {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Send"}
      </Button>
      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onClose}>Cancel</Button>
    </div>
  );
}

function CommitLogSection({ workspaceId, isExpanded }: { workspaceId: string; isExpanded: boolean }) {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["workspace-git-log", workspaceId],
    queryFn: () => executionWorkspacesApi.getGitLog(workspaceId, 5),
    refetchInterval: LOG_POLL_INTERVAL,
    staleTime: LOG_POLL_INTERVAL - 2000,
    enabled: isExpanded && open,
  });

  const entries: GitLogEntry[] = data?.entries ?? [];

  return (
    <div className="mt-2 min-w-0 max-w-full overflow-hidden">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-1 overflow-hidden text-xs text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <GitCommit className="h-3 w-3" />
        Recent commits
      </button>
      {open && entries.length > 0 && (
        <div className="ml-4 mt-1 min-w-0 space-y-1 overflow-hidden">
          {entries.map((entry) => (
            <div key={entry.hash} className="text-xs" title={`${entry.author} · ${entry.timestamp}`}>
              <span className="font-mono text-muted-foreground mr-1.5">{entry.shortHash}</span>
              <span className="text-foreground truncate">{entry.message}</span>
            </div>
          ))}
        </div>
      )}
      {open && entries.length === 0 && (
        <div className="mt-1 ml-4 text-xs text-muted-foreground">No commits yet</div>
      )}
    </div>
  );
}

function SafetyConfirmationDialog({
  safety,
  onCancel,
  onContinue,
}: {
  safety: WorkspaceMutationSafety | null;
  onCancel: () => void;
  onContinue: () => void;
}) {
  return (
    <Dialog open={!!safety} onOpenChange={(open) => { if (!open) onCancel(); }}>
      {safety && (
        <DialogContent data-testid="workspace-safety-dialog" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden="true" />
              Workspace safety check
            </DialogTitle>
            <DialogDescription>
              This workspace may still have agent work in flight. Review the current state before continuing.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3 text-sm">
            {safety.task && (
              <div className="rounded-md border border-border px-3 py-2">
                <div className="text-xs text-muted-foreground">Task</div>
                <div className="font-medium">
                  {safety.task.identifier ? `${safety.task.identifier} · ` : ""}
                  {safety.task.title}
                </div>
                <div className="text-xs text-muted-foreground">Status: {safety.task.status}</div>
              </div>
            )}
            {safety.activeRun && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                <div className="text-xs text-muted-foreground">Active run</div>
                <div className="font-medium">Run {safety.activeRun.id}</div>
                <div className="text-xs text-muted-foreground">Status: {safety.activeRun.status}</div>
              </div>
            )}
            {safety.warnings.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                {safety.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="button" onClick={onContinue}>Continue anyway</Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function GitPanel({ workspace, issueId, isExpanded = true }: GitPanelProps) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const workspacePermissions = useWorkspacePermissions(workspace.companyId, workspace.projectId);

  // ── State ──
  const [createPrOpen, setCreatePrOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [showCommitForm, setShowCommitForm] = useState(false);
  const [safetyConfirmation, setSafetyConfirmation] = useState<{
    safety: WorkspaceMutationSafety;
    onContinue: () => void;
  } | null>(null);
  const [checkingSafetyFor, setCheckingSafetyFor] = useState<"commit" | "push" | null>(null);
  const [showRequestReviewDialog, setShowRequestReviewDialog] = useState(false);

  // ── Live git status query ──
  const {
    data: statusData,
    isLoading: statusLoading,
    error: statusError,
  } = useQuery({
    queryKey: ["workspace-git-status", workspace.id],
    queryFn: () => executionWorkspacesApi.getGitStatus(workspace.id),
    refetchInterval: STATUS_POLL_INTERVAL,
    staleTime: STATUS_POLL_INTERVAL - 2000,
    enabled: isExpanded && Boolean(workspace.cwd),
  });

  // ── Derived values from live status ──
  const gitAvailable = statusData?.gitAvailable ?? false;
  const liveBranch = statusData?.branch ?? workspace.branchName ?? null;
  const detachedHead = statusData?.detachedHead ?? false;
  const files: GitFileEntry[] = statusData?.files ?? [];
  const isClean = statusData?.clean ?? true;
  const remote = statusData?.remote ?? null;
  const ahead = statusData?.ahead;
  const behind = statusData?.behind;

  // PR metadata from workspace
  const raw = (workspace.metadata as Record<string, unknown> | null)?.pr;
  const pr =
    typeof raw === "object" && raw !== null && "url" in raw && "number" in raw && "state" in raw
      ? (raw as GitHubPrMetadata)
      : undefined;

  const syncPrMutation = useMutation({
    mutationFn: ({ force }: { force: boolean; silent?: boolean }) =>
      githubIntegrationApi.syncWorkspacePR(workspace.id, { force }),
    onSuccess: (result, { silent }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.executionWorkspaces.detail(workspace.id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.executionWorkspaces.list(workspace.companyId),
      });
      if (!silent && result.pr) {
        pushToast({
          tone: "success",
          title: "GitHub PR synced",
          body: `Found PR #${result.pr.number}`,
        });
      }
    },
    onError: (err: Error, { silent }) => {
      if (!silent) pushToast({ tone: "warn", title: "GitHub sync failed", body: err.message });
    },
  });

  useEffect(() => {
    if (!isExpanded || !workspace.repoUrl || !liveBranch) return;
    // Once the PR reaches a terminal state (merged/closed) there is nothing left
    // to poll for — stop syncing. This also avoids a recurring lookup that could
    // briefly miss the PR (deleted branch / fork) and churn the workspace.
    if (pr?.state === "merged" || pr?.state === "closed") return;
    // Silent background sync: no toast spam, just keeps workspace.metadata.pr fresh
    const silentSync = () => syncPrMutation.mutate({ force: false, silent: true });
    silentSync(); // immediate on expand / key change
    const id = setInterval(silentSync, PR_POLL_MS);
    const onFocus = () => silentSync(); // re-sync when user tabs back
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExpanded, liveBranch, workspace.id, workspace.repoUrl, pr?.state]);

  // ── File selection helpers ──
  const committableFiles = useMemo(
    () => files.filter((f) => f.status !== "unknown"),
    [files],
  );

  const toggleFile = useCallback((filePath: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedFiles(new Set(committableFiles.map((f) => f.path)));
  }, [committableFiles]);

  const selectNone = useCallback(() => {
    setSelectedFiles(new Set());
  }, []);

  // ── Commit mutation ──
  const commitMutation = useMutation({
    mutationFn: (data: { message: string; files: string[] }) =>
      executionWorkspacesApi.gitCommit(workspace.id, data),
    onSuccess: (result) => {
      pushToast({
        tone: "success",
        title: "Committed",
        body: `${result.filesCommitted.length} file(s) committed`,
      });
      if (result.activeRunWarning) {
        pushToast({
          tone: "warn",
          title: "Agent running",
          body: "An agent is currently active on this workspace. Your commit may conflict.",
        });
      }
      if (result.skippedFiles.length > 0) {
        pushToast({
          tone: "warn",
          title: "Files skipped",
          body: `${result.skippedFiles.length} file(s) excluded by security policy: ${result.skippedFiles.join(", ")}`,
        });
      }
      // Reset form
      setCommitMessage("");
      setSelectedFiles(new Set());
      setShowCommitForm(false);
      // Refresh status
      queryClient.invalidateQueries({ queryKey: ["workspace-git-status", workspace.id] });
      queryClient.invalidateQueries({ queryKey: ["workspace-git-log", workspace.id] });
    },
    onError: (err: Error) => {
      pushToast({ tone: "error", title: "Commit failed", body: err.message });
    },
  });

  // ── Push mutation ──
  const pushMutation = useMutation({
    mutationFn: () => executionWorkspacesApi.gitPush(workspace.id),
    onSuccess: (result) => {
      pushToast({
        tone: "success",
        title: "Pushed",
        body: `Pushed to ${result.remote}/${result.branch}`,
      });
      if (result.activeRunWarning) {
        pushToast({
          tone: "warn",
          title: "Agent running",
          body: "An agent is currently active on this workspace.",
        });
      }
      queryClient.invalidateQueries({ queryKey: ["workspace-git-status", workspace.id] });
      queryClient.invalidateQueries({ queryKey: ["workspace-git-log", workspace.id] });
    },
    onError: (err: Error) => {
      pushToast({ tone: "error", title: "Push failed", body: err.message });
    },
  });

  // ── PR action mutations ──
  const mergePrMutation = useMutation({
    mutationFn: (mergeMethod: GitHubPrMergeMethod) =>
      githubIntegrationApi.mergePr(workspace.id, { mergeMethod }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.detail(workspace.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.list(workspace.companyId) });
      pushToast({ title: "PR merged successfully", tone: "success" });
    },
    onError: (err: Error) =>
      pushToast({ title: err.message || "Merge failed", tone: "error" }),
  });

  const closePrMutation = useMutation({
    mutationFn: () => githubIntegrationApi.closePr(workspace.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.detail(workspace.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.list(workspace.companyId) });
      pushToast({ title: "PR closed", tone: "success" });
    },
    onError: (err: Error) =>
      pushToast({ title: err.message || "Close failed", tone: "error" }),
  });

  const reopenPrMutation = useMutation({
    mutationFn: () => githubIntegrationApi.reopenPr(workspace.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.detail(workspace.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.list(workspace.companyId) });
      pushToast({ title: "PR reopened", tone: "success" });
    },
    onError: (err: Error) =>
      pushToast({ title: err.message || "Reopen failed", tone: "error" }),
  });

  // ── Copy branch name ──
  const handleCopy = async () => {
    if (!liveBranch) return;
    let copiedBranch = false;
    try {
      await navigator.clipboard.writeText(liveBranch);
      copiedBranch = true;
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = liveBranch;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        copiedBranch = Boolean((document as Document & { execCommand?: (command: string) => boolean }).execCommand?.("copy"));
      } finally {
        document.body.removeChild(textarea);
      }
    }

    if (copiedBranch) {
      pushToast({ tone: "success", title: "Branch copied", body: liveBranch });
    } else {
      pushToast({ tone: "error", title: "Copy failed", body: "Could not copy the branch name." });
    }
  };

  const runWithSafety = async (kind: "commit" | "push", onContinue: () => void) => {
    setCheckingSafetyFor(kind);
    try {
      const safety = await executionWorkspacesApi.safety(workspace.id);
      if (safety.requiresConfirmation[kind]) {
        setSafetyConfirmation({ safety, onContinue });
        return;
      }
      onContinue();
    } catch {
      onContinue();
    } finally {
      setCheckingSafetyFor(null);
    }
  };

  // ── Commit handler ──
  const handleCommit = () => {
    if (!commitMessage.trim() || selectedFiles.size === 0) return;
    const payload = {
      message: commitMessage.trim(),
      files: Array.from(selectedFiles),
    };
    void runWithSafety("commit", () => commitMutation.mutate(payload));
  };

  // ── PR availability ──
  const hasRepoUrl = Boolean(workspace.repoUrl);
  const remoteLabel = remoteName(remote);
  const remoteBranch = remoteBranchLabel({ remote, branch: liveBranch, ahead, behind });
  const canCreatePr = workspacePermissions.canMutateGit && Boolean(issueId) && (hasRepoUrl || !!remote) && !!liveBranch;
  const statusChip = gitStatusChipLabel({
    gitAvailable,
    detachedHead,
    files,
    remote,
    hasRepoUrl,
    ahead,
    behind,
    pr,
  });
  const visibleFiles = files.slice(0, 3);
  const hiddenFileCount = Math.max(0, files.length - visibleFiles.length);

  // ── No workspace path ──
  if (!workspace.cwd) {
    return (
      <div className="text-xs text-muted-foreground" data-testid="git-panel">
        No workspace directory configured.
      </div>
    );
  }

  // ── Loading ──
  if (statusLoading && !statusData) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-2" data-testid="git-panel">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading git status...
      </div>
    );
  }

  // ── Git not available ──
  if (statusData && !gitAvailable) {
    return (
      <div className="text-xs text-muted-foreground" data-testid="git-panel">
        {statusData.reason ?? "Git is not available for this workspace."}
      </div>
    );
  }

  // ── Error ──
  if (statusError && !statusData) {
    return (
      <div className="text-xs text-red-400" data-testid="git-panel">
        Failed to load git status.
      </div>
    );
  }

  return (
    <div className="min-w-0 max-w-full space-y-2 overflow-hidden text-sm" data-testid="git-panel">
      {detachedHead && (
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden rounded bg-amber-500/10 px-2 py-1.5 text-xs text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Detached HEAD - commits and pushes are disabled.
        </div>
      )}

      <section className="min-w-0 space-y-1 overflow-hidden" data-testid="git-local-section">
        <div className="flex min-w-0 items-center justify-between gap-2 overflow-hidden">
          <span className="shrink-0 rounded border border-brand/[0.25] bg-brand/[0.08] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[hsl(15_60%_75%)]">
            Local
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{formatWorktreeMode(workspace)}</span>
        </div>
        <div className="min-w-0 rounded-md border border-border bg-background/40 px-2 py-1.5">
          {liveBranch && (
            <div className="flex min-w-0 items-center gap-2 overflow-hidden" data-testid="branch-row">
              <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate font-mono text-xs">{liveBranch}</span>
            </div>
          )}
          {workspace.baseRef && (
            <div className={cn("flex min-w-0 items-center gap-2 overflow-hidden text-xs text-muted-foreground", liveBranch && "mt-1")} data-testid="base-ref-row">
              <span className="min-w-0 truncate">
                from <span className="font-mono">{workspace.baseRef}</span>
              </span>
            </div>
          )}
          <div className="mt-1.5 min-w-0 border-t border-border/70 pt-1.5" data-testid="file-changes">
            {isClean ? (
              <div className="flex min-w-0 items-center justify-between gap-2 overflow-hidden text-xs text-muted-foreground">
                <span className="min-w-0 truncate">Working tree clean</span>
                <Check className="h-3 w-3 shrink-0 text-green-400" />
              </div>
            ) : (
              <div className="min-w-0 space-y-1 overflow-hidden">
                <div className="flex min-w-0 items-center justify-between gap-2 overflow-hidden">
                  <span className="min-w-0 truncate text-xs font-medium text-foreground">
                    {files.length} changed file{files.length !== 1 ? "s" : ""}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">uncommitted</span>
                </div>
                <div className="min-w-0 space-y-0.5 overflow-hidden">
                  {visibleFiles.map((file) => (
                    <div key={file.path} className="group flex min-w-0 items-center gap-1.5 overflow-hidden text-xs">
                      {showCommitForm && (
                        <Checkbox
                          checked={selectedFiles.has(file.path)}
                          onCheckedChange={() => toggleFile(file.path)}
                          className="h-3 w-3"
                        />
                      )}
                      <span
                        className={cn(
                          "w-3 shrink-0 text-center font-mono text-[10px]",
                          FILE_STATUS_COLORS[file.status] ?? "text-muted-foreground",
                        )}
                        title={file.status}
                      >
                        {FILE_STATUS_LABELS[file.status] ?? "?"}
                      </span>
                      <span className="min-w-0 truncate font-mono text-xs text-foreground" title={file.path}>
                        {file.path}
                      </span>
                    </div>
                  ))}
                  {hiddenFileCount > 0 && (
                    <div className="pl-5 text-[11px] text-muted-foreground">Show {hiddenFileCount} more</div>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="mt-1.5 flex min-w-0 items-center justify-between gap-2 overflow-hidden border-t border-border/70 pt-1.5 text-xs" data-testid="local-sync-row">
            <span className="shrink-0 text-muted-foreground">Sync</span>
            <span className="min-w-0 truncate text-right text-muted-foreground">{formatLocalSync(ahead, behind)}</span>
          </div>
        </div>

        {showCommitForm && !isClean && (
          <div className="min-w-0 space-y-1.5 overflow-hidden rounded-md border border-border bg-background/40 px-2 py-1.5" data-testid="commit-form">
            <div className="flex min-w-0 items-center gap-2 overflow-hidden text-[10px]">
              <button type="button" className="text-blue-400 hover:underline" onClick={selectAll}>
                All
              </button>
              <button type="button" className="text-blue-400 hover:underline" onClick={selectNone}>
                None
              </button>
              <span className="ml-auto text-muted-foreground">
                {selectedFiles.size}/{committableFiles.length} selected
              </span>
            </div>
            <textarea
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Commit message..."
              className="min-h-[52px] w-full resize-none rounded border border-border bg-muted/50 px-2 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              data-testid="commit-message-input"
            />
            <Button
              size="sm"
              variant="default"
              className="w-full"
              disabled={
                !commitMessage.trim() ||
                selectedFiles.size === 0 ||
                commitMutation.isPending ||
                checkingSafetyFor === "commit"
              }
              onClick={handleCommit}
              data-testid="commit-btn"
            >
              {commitMutation.isPending || checkingSafetyFor === "commit" ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <GitCommit className="mr-1.5 h-3.5 w-3.5" />
              )}
              Commit {selectedFiles.size} file{selectedFiles.size !== 1 ? "s" : ""}
            </Button>
          </div>
        )}
      </section>

      <section className="min-w-0 space-y-1 overflow-hidden" data-testid="git-remote-section">
        <div className="flex min-w-0 items-center justify-between gap-2 overflow-hidden">
          <span className="shrink-0 rounded border border-brand/[0.25] bg-brand/[0.08] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[hsl(15_60%_75%)]">
            Remote
          </span>
          {(remote || hasRepoUrl) && !detachedHead && (
            <span className="shrink-0 text-[10px] text-muted-foreground" data-testid="ahead-behind-row">
              {formatRemoteSync(ahead, behind)}
            </span>
          )}
        </div>
        <div className="min-w-0 space-y-1 rounded-md border border-border bg-background/40 px-2 py-1.5">
          {remote || hasRepoUrl ? (
            <>
              <div className="flex min-w-0 items-center gap-2 overflow-hidden text-xs">
                <span className="min-w-0 truncate font-medium text-foreground">
                  {remoteLabel ?? "origin"} / {remoteBranch}
                </span>
                <span className="shrink-0 text-muted-foreground">{formatRemoteSync(ahead, behind)}</span>
                {workspace.repoUrl && workspace.repoUrl.startsWith("http") && (
                  <a
                    href={workspace.repoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Open GitHub repository"
                    title={workspace.repoUrl}
                    className="ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border/70 bg-background/60 text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
                    data-testid="repo-link"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
              {workspace.repoUrl && !workspace.repoUrl.startsWith("http") && (
                <div className="min-w-0 truncate text-xs text-muted-foreground" title={workspace.repoUrl}>
                  Repository configured
                </div>
              )}
            </>
          ) : (
            <>
              <div className="text-xs font-medium text-foreground">No remote configured</div>
              <div className="text-[11px] leading-4 text-muted-foreground">Push and PR are unavailable.</div>
            </>
          )}
          <div className="flex min-w-0 items-center gap-2 overflow-hidden pt-0.5" data-testid="pr-row">
            <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {pr ? (
              <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 truncate text-xs text-blue-400 hover:underline"
                >
                  #{pr.number}
                </a>
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                    prStateColor[pr.state] ?? "bg-muted text-muted-foreground",
                  )}
                >
                  {pr.state}
                </span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">{prSummary(pr)}</span>
              </div>
            ) : (
              <span className="min-w-0 truncate text-xs text-muted-foreground">No PR created</span>
            )}
          </div>
        </div>
      </section>

      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden" data-testid="git-action-row">
        {!pr ? (
          /* ── No PR: full-width Create PR button ── */
          <Button
            size="sm"
            variant="default"
            className="min-w-0 flex-1 px-2"
            disabled={!canCreatePr}
            title={
              !workspacePermissions.canMutateGit
                ? "Your role can view Git state but cannot mutate it"
                : !issueId
                ? "Link a task to this workspace to create a PR"
                : !liveBranch
                  ? "Branch not yet provisioned"
                  : !(hasRepoUrl || remote)
                    ? "No remote configured"
                    : "Open pull request on GitHub"
            }
            onClick={() => setCreatePrOpen(true)}
            data-testid="create-pr-btn"
          >
            <Github className="h-3.5 w-3.5" />
            Create PR
          </Button>
        ) : pr.state === "open" ? (
          /* ── PR open: split Merge button ── */
          <>
            <div className="flex min-w-0 flex-1 overflow-hidden rounded-md border border-primary">
              <Button
                size="sm"
                variant="default"
                className="flex-1 rounded-none rounded-l-md border-0 gap-1 px-2"
                disabled={
                  mergePrMutation.isPending || closePrMutation.isPending || pr.draft
                }
                title={
                  pr.draft
                    ? "This PR is a draft — mark it ready for review on GitHub before merging"
                    : undefined
                }
                onClick={() => mergePrMutation.mutate("squash")}
                data-testid="pr-merge-btn"
              >
                {mergePrMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <GitPullRequest className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {pr.draft ? "Draft" : "Merge"}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="default"
                    className="shrink-0 rounded-none rounded-r-md border-0 border-l border-primary-foreground/25 px-1.5"
                    disabled={mergePrMutation.isPending || closePrMutation.isPending}
                    aria-label="More merge options"
                    data-testid="pr-merge-dropdown-trigger"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-52">
                  <DropdownMenuItem
                    disabled={pr.draft}
                    onSelect={() => mergePrMutation.mutate("merge")}
                  >
                    <GitPullRequest className="h-4 w-4" />
                    Merge commit
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={pr.draft}
                    onSelect={() => mergePrMutation.mutate("squash")}
                  >
                    <GitPullRequest className="h-4 w-4" />
                    Squash and merge
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={pr.draft}
                    onSelect={() => mergePrMutation.mutate("rebase")}
                  >
                    <GitPullRequest className="h-4 w-4" />
                    Rebase and merge
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <a href={pr.url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-4 w-4" />
                      View PR #{pr.number}
                    </a>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => closePrMutation.mutate()}
                    disabled={closePrMutation.isPending}
                  >
                    {closePrMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : null}
                    Close PR
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setShowRequestReviewDialog(true)}>
                    Request Review
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <Button size="icon-xs" variant="ghost" asChild className="shrink-0">
              <a href={pr.url} target="_blank" rel="noopener noreferrer" aria-label="View PR on GitHub" data-testid="pr-link">
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          </>
        ) : pr.state === "closed" ? (
          /* ── PR closed: Reopen button ── */
          <>
            <Button
              size="sm"
              variant="outline"
              className="min-w-0 flex-1 gap-1 px-2 border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
              onClick={() => reopenPrMutation.mutate()}
              disabled={reopenPrMutation.isPending}
              data-testid="pr-reopen-btn"
            >
              {reopenPrMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <GitPullRequest className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Reopen PR
            </Button>
            <Button size="icon-xs" variant="ghost" asChild className="shrink-0">
              <a href={pr.url} target="_blank" rel="noopener noreferrer" aria-label="View PR on GitHub" data-testid="pr-link">
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          </>
        ) : (
          /* ── PR merged: purple chip link ── */
          <Button
            size="sm"
            variant="ghost"
            className="min-w-0 flex-1 gap-1 px-2 bg-purple-500/10 text-purple-400 hover:bg-purple-500/15"
            asChild
            data-testid="pr-merged-chip"
          >
            <a href={pr.url} target="_blank" rel="noopener noreferrer" data-testid="pr-link">
              <Check className="h-3.5 w-3.5" />
              Merged #{pr.number}
            </a>
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Open Git actions"
              title="Git actions"
              className="shrink-0 border-border/70 bg-background/60 hover:bg-muted/70"
            >
              <GitBranch className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {liveBranch && (
              <DropdownMenuItem onSelect={() => void handleCopy()}>
                <Copy className="h-4 w-4" />
                Copy branch
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              disabled={!workspace.repoUrl || !liveBranch}
              onSelect={() => syncPrMutation.mutate({ force: true })}
            >
              {syncPrMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Refresh GitHub PR
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!workspacePermissions.canMutateGit || isClean || detachedHead}
              onSelect={() => {
                setShowCommitForm(true);
                if (selectedFiles.size === 0) selectAll();
              }}
            >
              <GitCommit className="h-4 w-4" />
              Commit changes
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={
                !workspacePermissions.canMutateGit ||
                !gitAvailable ||
                detachedHead ||
                !remote ||
                ahead === 0 ||
                pushMutation.isPending ||
                checkingSafetyFor === "push"
              }
              onSelect={() => void runWithSafety("push", () => pushMutation.mutate())}
            >
              {pushMutation.isPending || checkingSafetyFor === "push" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {ahead && ahead > 0 ? `Push ${ahead} commit${ahead === 1 ? "" : "s"}` : "Push branch"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {workspace.cwd && <OpenInIdeButton cwd={workspace.cwd} compact />}
      </div>

      {pr && showRequestReviewDialog && (
        <RequestReviewInline
          onClose={() => setShowRequestReviewDialog(false)}
          onSubmit={async (reviewers) => {
            await githubIntegrationApi.requestReview(workspace.id, reviewers);
            setShowRequestReviewDialog(false);
            pushToast({ title: "Review requested", tone: "success" });
          }}
        />
      )}

      {gitAvailable && (
        <CommitLogSection workspaceId={workspace.id} isExpanded={isExpanded} />
      )}

      {issueId && (
        <CreatePrDialog
          issueId={issueId}
          workspace={workspace}
          open={createPrOpen}
          onOpenChange={setCreatePrOpen}
          liveBranch={liveBranch}
        />
      )}

      <SafetyConfirmationDialog
        safety={safetyConfirmation?.safety ?? null}
        onCancel={() => setSafetyConfirmation(null)}
        onContinue={() => {
          const action = safetyConfirmation?.onContinue;
          setSafetyConfirmation(null);
          action?.();
        }}
      />
    </div>
  );
}
