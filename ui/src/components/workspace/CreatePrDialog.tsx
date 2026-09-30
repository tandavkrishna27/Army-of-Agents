import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ExternalLink, Github, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  ExecutionWorkspace,
  GitHubPrCreateResponse,
  GitHubPrMetadata,
  GitHubRepoCollaborator,
  GitHubRepoLabel,
  GitHubRepoMilestone,
  GitHubRepoBranch,
} from "@armyofagents/shared";
import { issuesApi } from "../../api/issues";
import { githubIntegrationApi } from "../../api/github-integration";
import {
  executionWorkspacesApi,
  type WorkspaceMutationSafety,
} from "../../api/execution-workspaces";
import { ApiError } from "../../api/client";
import { useToast } from "../../context/ToastContext";
import { queryKeys } from "../../lib/queryKeys";

interface Props {
  issueId: string;
  workspace: ExecutionWorkspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (pr: GitHubPrCreateResponse) => void;
  /** Live branch from git status API — used when workspace.branchName is null (local_fs workspaces). */
  liveBranch?: string | null;
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
              <AlertCircle className="h-4 w-4 text-amber-500" aria-hidden="true" />
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

/**
 * Create PR dialog — prefills title/body from the linked task, base from
 * `workspace.baseRef ?? "main"`, head from `workspace.branchName` (read-only).
 * On submit, calls the server which uses the company's stored GitHub PAT to
 * create the PR, persists `workspace.metadata.pr`, posts a task comment, and
 * logs activity.
 *
 * Error banners surface:
 * - 412 "GitHub not configured" with link to Settings → Integrations
 * - 401/403 auth/scope problems with hint text from the server
 * - other errors as a generic "Failed to create PR" message
 */
export function CreatePrDialog({
  issueId,
  workspace,
  open,
  onOpenChange,
  onCreated,
  liveBranch: liveBranchProp,
}: Props) {
  const qc = useQueryClient();
  const { pushToast } = useToast();

  const rawPr = (workspace.metadata as Record<string, unknown> | null)?.pr;
  const existingPr =
    typeof rawPr === "object" && rawPr !== null && "url" in rawPr && "number" in rawPr && "state" in rawPr
      ? (rawPr as GitHubPrMetadata)
      : null;

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState(workspace.baseRef ?? "main");
  const [draft, setDraft] = useState(false);
  const [checkingSafety, setCheckingSafety] = useState(false);
  const [safetyConfirmation, setSafetyConfirmation] = useState<WorkspaceMutationSafety | null>(null);
  const [selectedReviewers, setSelectedReviewers] = useState<string[]>([]);
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [selectedMilestone, setSelectedMilestone] = useState<number | null>(null);

  const issueQuery = useQuery({
    queryKey: queryKeys.issues.detail(issueId),
    queryFn: () => issuesApi.get(issueId),
    enabled: open,
  });

  const collaboratorsQuery = useQuery({
    queryKey: ["github", "collaborators", workspace.id],
    queryFn: () => githubIntegrationApi.getCollaborators(workspace.id),
    enabled: open && !!workspace.repoUrl,
    staleTime: 5 * 60 * 1000,
  });

  const labelsQuery = useQuery({
    queryKey: ["github", "labels", workspace.id],
    queryFn: () => githubIntegrationApi.getLabels(workspace.id),
    enabled: open && !!workspace.repoUrl,
    staleTime: 5 * 60 * 1000,
  });

  const milestonesQuery = useQuery({
    queryKey: ["github", "milestones", workspace.id],
    queryFn: () => githubIntegrationApi.getMilestones(workspace.id),
    enabled: open && !!workspace.repoUrl,
    staleTime: 5 * 60 * 1000,
  });

  const branchesQuery = useQuery({
    queryKey: ["github", "branches", workspace.id],
    queryFn: () => githubIntegrationApi.getBranches(workspace.id),
    enabled: open && !!workspace.repoUrl,
    staleTime: 2 * 60 * 1000,
  });

  // Prefill when dialog opens / when the issue loads.
  useEffect(() => {
    if (!open) {
      setSelectedReviewers([]);
      setSelectedLabels([]);
      setSelectedMilestone(null);
      return;
    }
    if (issueQuery.data) {
      setTitle(issueQuery.data.title ?? "");
      setBody(issueQuery.data.description ?? "");
    }
    setBase(workspace.baseRef ?? "main");
    setDraft(false);
  }, [open, issueQuery.data, workspace.baseRef]);

  const headBranch = workspace.branchName ?? liveBranchProp ?? null;

  const mutation = useMutation({
    mutationFn: () =>
      githubIntegrationApi.createPR(issueId, {
        workspaceId: workspace.id,
        title,
        body,
        base,
        draft,
        // Send head explicitly — critical for local_fs workspaces where
        // workspace.branchName is null in the DB.
        ...(headBranch ? { head: headBranch } : {}),
        ...(selectedReviewers.length > 0 ? { reviewers: selectedReviewers } : {}),
        ...(selectedLabels.length > 0 ? { labels: selectedLabels } : {}),
        ...(selectedMilestone !== null ? { milestoneNumber: selectedMilestone } : {}),
      }),
    onSuccess: (pr) => {
      pushToast({
        title: `PR #${pr.number} created`,
        tone: "success",
      });
      void githubIntegrationApi.syncWorkspacePR(workspace.id, { force: true }).catch(() => {
        // The create route already persisted the PR; sync is a best-effort
        // follow-up to refresh GitHub-derived state such as base branch.
      });
      qc.invalidateQueries({
        queryKey: queryKeys.executionWorkspaces.detail(workspace.id),
      });
      qc.invalidateQueries({
        queryKey: queryKeys.executionWorkspaces.list(workspace.companyId),
      });
      qc.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
      qc.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId) });
      onCreated?.(pr);
      onOpenChange(false);
    },
  });

  const error = mutation.error instanceof ApiError ? mutation.error : null;
  const errorHint =
    error && typeof (error.body as { hint?: unknown } | null)?.hint === "string"
      ? ((error.body as { hint: string }).hint)
      : null;

  const canSubmit =
    title.trim().length > 0 && base.trim().length > 0 && !!headBranch && !mutation.isPending && !checkingSafety && !existingPr;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    void submitWithSafety();
  }

  async function submitWithSafety() {
    setCheckingSafety(true);
    try {
      const safety = await executionWorkspacesApi.safety(workspace.id);
      if (safety.requiresConfirmation.createPr) {
        setSafetyConfirmation(safety);
        return;
      }
      mutation.mutate();
    } catch {
      mutation.mutate();
    } finally {
      setCheckingSafety(false);
    }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent data-testid="create-pr-dialog" className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Github className="h-4 w-4" aria-hidden="true" />
              Create pull request
            </DialogTitle>
            <DialogDescription>
              Open a GitHub PR using the company's saved token. The PR URL will
              be saved to this workspace and posted as a task comment.
            </DialogDescription>
          </DialogHeader>

          {existingPr ? (
            <>
              <DialogBody>
                <div
                  className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
                  data-testid="pr-already-exists"
                >
                  <AlertCircle
                    className="mt-0.5 h-4 w-4 shrink-0 text-amber-500"
                    aria-hidden="true"
                  />
                  <div className="flex-1 space-y-1">
                    <div className="font-medium">PR already created</div>
                    <a
                      href={existingPr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-foreground hover:underline"
                      data-testid="pr-already-exists-link"
                    >
                      View PR #{existingPr.number}
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  </div>
                </div>
              </DialogBody>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  Close
                </Button>
              </DialogFooter>
            </>
          ) : (
          <DialogBody>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Title */}
            <div className="space-y-1.5">
              <Label htmlFor="pr-title" className="text-sm font-medium">
                Title
              </Label>
              <Input
                id="pr-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={mutation.isPending || checkingSafety}
                data-testid="pr-title-input"
              />
            </div>

            {/* Body */}
            <div className="space-y-1.5">
              <Label htmlFor="pr-body" className="text-sm font-medium">
                Description
              </Label>
              <Textarea
                id="pr-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={6}
                disabled={mutation.isPending || checkingSafety}
                data-testid="pr-body-input"
              />
              <p className="text-xs text-muted-foreground">
                Prefilled from the linked task. Supports GitHub markdown.
              </p>
            </div>

            {/* Base / head */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="pr-base" className="text-sm font-medium">
                  Base branch
                </Label>
                <Select
                  value={base}
                  onValueChange={setBase}
                  disabled={mutation.isPending || checkingSafety}
                >
                  <SelectTrigger id="pr-base" data-testid="pr-base-input">
                    <SelectValue placeholder="Select branch…" />
                  </SelectTrigger>
                  <SelectContent>
                    {branchesQuery.isLoading ? (
                      <SelectItem value={base}>
                        <Loader2 className="h-3 w-3 animate-spin inline mr-1" aria-hidden="true" />
                        Loading branches…
                      </SelectItem>
                    ) : branchesQuery.data && branchesQuery.data.length > 0 ? (
                      <>
                        {!branchesQuery.data.some((b) => b.name === base) && (
                          <SelectItem value={base}>{base}</SelectItem>
                        )}
                        {branchesQuery.data.map((b: GitHubRepoBranch) => (
                          <SelectItem key={b.name} value={b.name}>
                            {b.name}
                          </SelectItem>
                        ))}
                      </>
                    ) : (
                      <SelectItem value={base}>{base}</SelectItem>
                    )}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  The branch to merge into.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">Head branch</Label>
                <div
                  className="rounded-md border border-input bg-muted/30 px-3 py-2 text-sm font-mono text-muted-foreground truncate"
                  data-testid="pr-head-readonly"
                  title={workspace.branchName ?? liveBranchProp ?? ""}
                >
                  {workspace.branchName ?? liveBranchProp ?? "—"}
                </div>
                <p className="text-xs text-muted-foreground">
                  From this workspace.
                </p>
              </div>
            </div>

            {/* Draft */}
            <div className="flex items-center gap-2">
              <Checkbox
                id="pr-draft"
                checked={draft}
                onCheckedChange={(checked) => setDraft(checked === true)}
                disabled={mutation.isPending || checkingSafety}
                data-testid="pr-draft-checkbox"
              />
              <Label htmlFor="pr-draft" className="text-sm">
                Open as draft
              </Label>
            </div>

            {/* Reviewers */}
            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Reviewers
              </Label>
              {collaboratorsQuery.isLoading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading collaborators…
                </div>
              ) : collaboratorsQuery.isError ? (
                <p className="text-xs text-destructive">Could not load collaborators.</p>
              ) : (collaboratorsQuery.data ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">No collaborators found.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {(collaboratorsQuery.data ?? []).map((c: GitHubRepoCollaborator) => (
                    <label
                      key={c.login}
                      className="flex items-center gap-1.5 cursor-pointer text-sm select-none"
                    >
                      <Checkbox
                        checked={selectedReviewers.includes(c.login)}
                        onCheckedChange={(checked) =>
                          setSelectedReviewers((prev) =>
                            checked ? [...prev, c.login] : prev.filter((r) => r !== c.login),
                          )
                        }
                        aria-label={c.login}
                      />
                      <img src={c.avatarUrl} alt="" className="h-4 w-4 rounded-full" />
                      <span>{c.login}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Labels */}
            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Labels
              </Label>
              {labelsQuery.isLoading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading labels…
                </div>
              ) : labelsQuery.isError ? (
                <p className="text-xs text-destructive">Could not load labels.</p>
              ) : (labelsQuery.data ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">No labels found.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {(labelsQuery.data ?? []).map((l: GitHubRepoLabel) => (
                    <label key={l.id} className="flex items-center gap-1.5 cursor-pointer text-sm select-none">
                      <Checkbox
                        checked={selectedLabels.includes(l.name)}
                        onCheckedChange={(checked) =>
                          setSelectedLabels((prev) =>
                            checked ? [...prev, l.name] : prev.filter((n) => n !== l.name),
                          )
                        }
                        aria-label={l.name}
                      />
                      <span
                        className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                        style={{ backgroundColor: `#${l.color}22`, color: `#${l.color}`, border: `1px solid #${l.color}55` }}
                      >
                        {l.name}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Milestone */}
            {(milestonesQuery.data ?? []).length > 0 && (
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Milestone
                </Label>
                <select
                  className="w-full rounded-md border border-input bg-transparent h-9 px-2.5 text-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  value={selectedMilestone ?? ""}
                  onChange={(e) =>
                    setSelectedMilestone(e.target.value ? Number(e.target.value) : null)
                  }
                >
                  <option value="">No milestone</option>
                  {(milestonesQuery.data ?? []).map((m: GitHubRepoMilestone) => (
                    <option key={m.number} value={m.number}>
                      {m.title} ({m.openIssues} open)
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Error banner */}
            {error && error.status === 412 && (
              <div
                className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
                data-testid="pr-error-412"
              >
                <AlertCircle
                  className="mt-0.5 h-4 w-4 shrink-0 text-amber-500"
                  aria-hidden="true"
                />
                <div className="flex-1 space-y-1">
                  <div className="font-medium">GitHub not connected</div>
                  <p className="text-xs text-muted-foreground">
                    Connect a personal access token before creating PRs.
                  </p>
                  <Link
                    to="/settings?tab=integrations"
                    className="inline-flex items-center gap-1 text-xs text-foreground hover:underline"
                    onClick={() => onOpenChange(false)}
                  >
                    Open Settings → Integrations
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </Link>
                </div>
              </div>
            )}

            {error && (error.status === 401 || error.status === 403) && (
              <div
                className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
                data-testid="pr-error-scope"
              >
                <AlertCircle
                  className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
                  aria-hidden="true"
                />
                <div className="flex-1 space-y-1">
                  <div className="font-medium">{error.message}</div>
                  {errorHint && (
                    <p className="text-xs text-muted-foreground">{errorHint}</p>
                  )}
                </div>
              </div>
            )}

            {error &&
              error.status !== 412 &&
              error.status !== 401 &&
              error.status !== 403 && (
                <div
                  className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
                  data-testid="pr-error-generic"
                >
                  <AlertCircle
                    className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
                    aria-hidden="true"
                  />
                  <div className="flex-1 space-y-1">
                    <div>Failed to create PR: {error.message}</div>
                    {errorHint && (
                      <p className="whitespace-pre-line text-xs text-muted-foreground">
                        {errorHint}
                      </p>
                    )}
                  </div>
                </div>
              )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={mutation.isPending || checkingSafety}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!canSubmit} data-testid="pr-submit">
                {mutation.isPending || checkingSafety ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />
                    {checkingSafety && !mutation.isPending ? "Checking..." : "Creating…"}
                  </>
                ) : (
                  "Create PR"
                )}
              </Button>
            </DialogFooter>
          </form>
          </DialogBody>
          )}
        </DialogContent>
      )}
    </Dialog>
    <SafetyConfirmationDialog
      safety={safetyConfirmation}
      onCancel={() => setSafetyConfirmation(null)}
      onContinue={() => {
        setSafetyConfirmation(null);
        mutation.mutate();
      }}
    />
    </>
  );
}
