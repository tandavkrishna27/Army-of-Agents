import { Router } from "express";
import { z } from "zod";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { activityLog, type Db } from "@armyofagents/db";
import { and, desc, eq } from "drizzle-orm";
import {
  GITHUB_PAT_ACTIVITY_KINDS,
  GITHUB_PAT_SECRET_NAME,
  type GitHubPrMetadata,
  type GitHubPrSyncResponse,
  type GitHubPrActionResponse,
} from "@armyofagents/shared";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity, secretService } from "../services/index.js";
import { issueService } from "../services/issues.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import {
  createPullRequest,
  findPullRequestForBranch,
  GitHubPrError,
  resolveGitHubAuth,
  mergeWorkspacePr,
  closeWorkspacePr,
  reopenWorkspacePr,
  requestPrReview,
  parseGitHubRepoUrl,
} from "../services/github-pr.js";
import {
  getInstallUrl,
  saveInstallation,
  removeInstallation,
  getInstallation,
  listInstallationRepositories,
  signInstallState,
  verifyInstallState,
  isOnboardingReturnTarget,
  ONBOARDING_RETURN_PATHS,
} from "../services/github-app.js";
import { emitPullRequestTaskOutput } from "../services/task-output-emitters.js";
import { resolveGitRoot, runGit, push } from "../services/git.js";
import { assertLocalWorkspaceCommandAllowed } from "../services/local-workspace-command-guard.js";
const setPatSchema = z.object({ pat: z.string().min(1) });
const syncPrBodySchema = z.object({ force: z.boolean().optional().default(false) });
const createPrBodySchema = z.object({
  workspaceId: z.string().uuid(),
  title: z.string().min(1),
  body: z.string(),
  base: z.string().min(1),
  draft: z.boolean().default(false),
  /** Explicit head branch — used when workspace.branchName is null (local_fs). */
  head: z.string().min(1).optional(),
  reviewers: z.array(z.string().min(1)).optional(),
  labels: z.array(z.string().min(1)).optional(),
  milestoneNumber: z.number().int().positive().optional(),
});

const mergePrBodySchema = z.object({
  mergeMethod: z.enum(["merge", "squash", "rebase"]),
});

const requestReviewBodySchema = z.object({
  reviewers: z.array(z.string().min(1)).min(1),
});

async function resolveGithubUserFromConnectActivity(
  db: Db,
  companyId: string,
  secretId: string,
): Promise<string | null> {
  try {
    const rows = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, GITHUB_PAT_ACTIVITY_KINDS.CONNECTED),
          eq(activityLog.entityId, secretId),
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(1);
    const githubUser = rows[0]?.details?.githubUser;
    return typeof githubUser === "string" && githubUser.trim().length > 0
      ? githubUser
      : null;
  } catch {
    return null;
  }
}

function isRecentGithubSync(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && Date.now() - time < 60_000;
}

function readGitHubPrMetadata(value: unknown): GitHubPrMetadata | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<GitHubPrMetadata>;
  if (
    typeof candidate.url !== "string" ||
    typeof candidate.number !== "number" ||
    (candidate.state !== "open" && candidate.state !== "closed" && candidate.state !== "merged") ||
    typeof candidate.createdAt !== "string"
  ) {
    return null;
  }
  return {
    url: candidate.url,
    number: candidate.number,
    state: candidate.state,
    createdAt: candidate.createdAt,
    draft: candidate.draft ?? false,
  };
}

export function githubRoutes(db: Db) {
  const router = Router();
  const svc = secretService(db);

  /**
   * Save a GitHub PAT for this company. Verifies the PAT via Octokit before
   * storing. Any existing PAT row is deleted first so re-saves are idempotent.
   * The PAT itself is never echoed back — only `{configured, githubUser}`.
   */
  router.post("/companies/:companyId/github/pat", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);

    const parsed = setPatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    let githubUser: string;
    try {
      const octokit = new Octokit({ auth: parsed.data.pat });
      const { data } = await octokit.users.getAuthenticated();
      githubUser = data.login;
    } catch {
      res.status(400).json({ error: "Invalid GitHub PAT" });
      return;
    }

    // Replace any existing PAT (idempotent — `delete` returns false when none).
    await svc.delete(companyId, GITHUB_PAT_SECRET_NAME);
    const created = await svc.create(
      companyId,
      {
        name: GITHUB_PAT_SECRET_NAME,
        provider: "local_encrypted",
        value: parsed.data.pat,
        description: `GitHub PAT for ${githubUser}`,
        externalRef: githubUser,
      },
      { userId: req.actor.userId ?? "board", agentId: null },
    );

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: GITHUB_PAT_ACTIVITY_KINDS.CONNECTED,
      entityType: "secret",
      entityId: created.id,
      details: { githubUser },
    });

    res.json({ configured: true, githubUser });
  });

  /** Remove the stored GitHub PAT. Idempotent. */
  router.delete("/companies/:companyId/github/pat", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);

    const existing = await svc.getByName(companyId, GITHUB_PAT_SECRET_NAME);
    if (!existing) {
      res.json({ configured: false, removed: false });
      return;
    }

    await svc.delete(companyId, GITHUB_PAT_SECRET_NAME);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: GITHUB_PAT_ACTIVITY_KINDS.DISCONNECTED,
      entityType: "secret",
      entityId: existing.id,
      details: { githubUser: existing.externalRef ?? null },
    });

    res.json({ configured: false, removed: true });
  });

  /** Read whether a PAT is configured — never returns the PAT itself. */
  router.get("/companies/:companyId/github/pat/status", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);

    const row = await svc.getByName(companyId, GITHUB_PAT_SECRET_NAME);
    if (!row || row.status !== "active") {
      res.json({ configured: false });
      return;
    }
    const githubUser =
      row.externalRef ??
      (await resolveGithubUserFromConnectActivity(db, companyId, row.id));
    res.json({
      configured: true,
      githubUser,
      createdAt: row.createdAt,
    });
  });

  /**
   * Reconcile a workspace branch against GitHub PRs. This is used by the
   * workspace Git panel to show real PR state even when the PR was created
   * outside this app or before metadata was persisted locally.
   */
  router.post("/execution-workspaces/:id/github-pr/sync", async (req, res) => {
    assertBoard(req);

    const parsed = syncPrBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.format() });
      return;
    }

    const wsSvc = executionWorkspaceService(db);
    const ws = await wsSvc.getById(req.params.id);
    if (!ws) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    await assertCompanyAccess(db, req, ws.companyId);

    if (!ws.repoUrl) {
      res.status(400).json({ error: "Workspace missing repoUrl - cannot sync PR" });
      return;
    }
    if (!ws.branchName) {
      res.status(400).json({ error: "Workspace missing branchName - cannot sync PR" });
      return;
    }

    const existingMeta = (ws.metadata as Record<string, unknown> | null) ?? {};
    if (!parsed.data.force && isRecentGithubSync(existingMeta.githubLastSyncedAt)) {
      const response: GitHubPrSyncResponse = {
        workspaceId: ws.id,
        repoUrl: ws.repoUrl,
        branchName: ws.branchName,
        baseRef: ws.baseRef ?? null,
        pr: readGitHubPrMetadata(existingMeta.pr),
        githubLastSyncedAt: existingMeta.githubLastSyncedAt,
        githubSyncError:
          typeof existingMeta.githubSyncError === "string" ? existingMeta.githubSyncError : null,
        cached: true,
      };
      res.json(response);
      return;
    }

    const now = new Date().toISOString();
    try {
      const result = await findPullRequestForBranch(db, {
        companyId: ws.companyId,
        repoUrl: ws.repoUrl,
        branchName: ws.branchName,
      });
      const nextBaseRef = ws.baseRef ?? result.baseRef ?? null;
      // A merged/closed PR is a historical fact. If the branch head-filter
      // lookup stops matching (deleted branch, fork PR, rename), don't erase a
      // terminal-state PR just because GitHub returned no match this poll.
      // Only non-terminal (or absent) PRs get cleared.
      const existingPr = readGitHubPrMetadata(existingMeta.pr);
      const preserveTerminalPr =
        !result.pr &&
        !!existingPr &&
        (existingPr.state === "merged" || existingPr.state === "closed");
      const effectivePr = result.pr ?? (preserveTerminalPr ? existingPr : null);
      const nextMetadata: Record<string, unknown> = {
        ...existingMeta,
        githubLastSyncedAt: now,
        githubSyncError: null,
        noPrFound: effectivePr ? false : true,
      };
      if (effectivePr) {
        nextMetadata.pr = effectivePr;
      } else {
        delete nextMetadata.pr;
      }

      const update: {
        baseRef?: string;
        metadata: Record<string, unknown>;
      } = { metadata: nextMetadata };
      if (nextBaseRef && nextBaseRef !== ws.baseRef) {
        update.baseRef = nextBaseRef;
      }
      await wsSvc.update(ws.id, update);
      if (effectivePr) {
        await emitPullRequestTaskOutput(db, {
          companyId: ws.companyId,
          issueId: ws.sourceIssueId,
          executionWorkspaceId: ws.id,
          repoUrl: ws.repoUrl,
          pr: effectivePr,
        });
      }

      const response: GitHubPrSyncResponse = {
        workspaceId: ws.id,
        repoUrl: ws.repoUrl,
        branchName: ws.branchName,
        baseRef: nextBaseRef,
        pr: effectivePr,
        githubLastSyncedAt: now,
        githubSyncError: null,
        cached: false,
      };
      res.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : "GitHub sync failed";
      await wsSvc.update(ws.id, {
        metadata: {
          ...existingMeta,
          githubLastSyncedAt: now,
          githubSyncError: message,
        },
      });

      if (err instanceof GitHubPrError) {
        res.status(err.status).json({ error: err.message, hint: err.scopeHint });
        return;
      }
      res.status(502).json({ error: "GitHub sync failed", hint: message });
    }
  });

  /**
   * Create a GitHub pull request for a task using the company's stored PAT.
   * Persists the PR URL into the linked execution workspace's `metadata.pr`,
   * posts a task comment, and writes an activity log entry.
   */
  router.post("/issues/:issueId/github-pr", async (req, res) => {
    assertBoard(req);

    const parsed = createPrBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.format() });
      return;
    }

    const issueSvcInstance = issueService(db);
    const issue = await issueSvcInstance.getById(req.params.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyAccess(db, req, issue.companyId);

    const wsSvc = executionWorkspaceService(db);
    const ws = await wsSvc.getById(parsed.data.workspaceId);
    if (!ws) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    if (ws.companyId !== issue.companyId) {
      res.status(403).json({ error: "Workspace does not belong to issue's company" });
      return;
    }
    if (!ws.repoUrl) {
      res.status(400).json({ error: "Workspace missing repoUrl — cannot create PR" });
      return;
    }

    // Resolve head branch: client-provided > DB record > live git detection.
    // In cloud_auth, keep API-only PR creation available while skipping every
    // local Git subprocess unless the operator explicitly enabled the unsafe
    // process-wide override.
    let localGitAllowed = false;
    if (ws.cwd) {
      try {
        assertLocalWorkspaceCommandAllowed("GitHub PR workspace Git command");
        localGitAllowed = true;
      } catch {
        localGitAllowed = false;
      }
    }
    let headBranch = parsed.data.head ?? ws.branchName ?? null;
    if (!headBranch && ws.cwd && localGitAllowed) {
      try {
        const gitRoot = await resolveGitRoot(ws.cwd);
        if (gitRoot) {
          const detected = await runGit(["branch", "--show-current"], gitRoot, { timeout: 5_000 });
          if (detected) headBranch = detected;
        }
      } catch {
        // Fall through — headBranch stays null
      }
    }

    if (!headBranch) {
      res.status(400).json({ error: "Cannot determine head branch — no branchName in DB and git detection failed" });
      return;
    }

    // Auto-push: ensure the branch exists on the remote before creating the PR.
    // Without this, GitHub returns 422 ("head sha can't be blank").
    if (ws.cwd && localGitAllowed) {
      try {
        const gitRoot = await resolveGitRoot(ws.cwd);
        if (gitRoot) {
          try {
            await runGit(["remote", "get-url", "origin"], gitRoot, { timeout: 5_000 });
          } catch {
            await runGit(["remote", "add", "origin", ws.repoUrl], gitRoot, { timeout: 5_000 });
          }

          // Check if the branch has an upstream. If not, push it.
          try {
            await runGit(
              ["rev-parse", "--abbrev-ref", `${headBranch}@{upstream}`],
              gitRoot,
              { timeout: 5_000 },
            );
          } catch {
            // No upstream — need to push. Resolve auth (App installation token or PAT).
            const token = await resolveGitHubAuth(db, issue.companyId, "github:auto-push").catch(() => null);
            await push(gitRoot, "origin", headBranch, token ? { pat: token } : undefined);
          }
        }
      } catch (pushErr) {
        const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
        res.status(400).json({
          error: `Failed to push branch "${headBranch}" to remote before creating PR`,
          hint: msg,
        });
        return;
      }
    }

    try {
      const pr = await createPullRequest(db, {
        companyId: issue.companyId,
        repoUrl: ws.repoUrl,
        base: parsed.data.base,
        head: headBranch,
        title: parsed.data.title,
        body: parsed.data.body,
        draft: parsed.data.draft,
        reviewers: parsed.data.reviewers,
        labels: parsed.data.labels,
        milestoneNumber: parsed.data.milestoneNumber,
      });

      const now = new Date().toISOString();
      const prMetadata: GitHubPrMetadata = {
        url: pr.url,
        number: pr.number,
        state: pr.state,
        createdAt: now,
        draft: pr.draft,
      };

      const existingMeta = (ws.metadata as Record<string, unknown> | null) ?? {};
      const update: {
        baseRef?: string;
        metadata: Record<string, unknown>;
      } = {
        metadata: {
          ...existingMeta,
          pr: prMetadata,
          githubLastSyncedAt: now,
          githubSyncError: null,
          noPrFound: false,
        },
      };
      if (!ws.baseRef) {
        update.baseRef = parsed.data.base;
      }
      await wsSvc.update(ws.id, update);
      await emitPullRequestTaskOutput(db, {
        companyId: issue.companyId,
        issueId: issue.id,
        executionWorkspaceId: ws.id,
        repoUrl: ws.repoUrl,
        pr: prMetadata,
      });

      await issueSvcInstance.addComment(
        issue.id,
        `Pull request created: ${pr.url}`,
        { userId: req.actor.userId ?? "board", agentId: undefined },
      );

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: GITHUB_PAT_ACTIVITY_KINDS.PR_CREATED,
        entityType: "issue",
        entityId: issue.id,
        details: {
          prUrl: pr.url,
          prNumber: pr.number,
          workspaceId: ws.id,
          draft: pr.draft,
        },
      });

      res.json(pr);
    } catch (err) {
      if (err instanceof GitHubPrError) {
        res.status(err.status).json({ error: err.message, hint: err.scopeHint });
        return;
      }
      throw err;
    }
  });

  // ---------------------------------------------------------------------------
  // Repo metadata — feed CreatePrDialog selects
  // ---------------------------------------------------------------------------

  router.get("/execution-workspaces/:id/github/collaborators", async (req, res) => {
    assertBoard(req);
    const ws = await executionWorkspaceService(db).getById(req.params.id);
    if (!ws) { res.status(404).json({ error: "Workspace not found" }); return; }
    await assertCompanyAccess(db, req, ws.companyId);
    if (!ws.repoUrl) { res.status(400).json({ error: "Workspace missing repoUrl" }); return; }

    try {
      const pat = await resolveGitHubAuth(db, ws.companyId, "github-metadata");
      const { owner, repo } = parseGitHubRepoUrl(ws.repoUrl);
      const octokit = new Octokit({ auth: pat });
      const { data } = await octokit.repos.listCollaborators({ owner, repo, per_page: 100 });
      res.json(data.map((c) => ({ login: c.login, avatarUrl: c.avatar_url })));
    } catch (err) {
      if (err instanceof GitHubPrError) { res.status(err.status).json({ error: err.message, hint: err.scopeHint }); return; }
      const status = (err as { status?: number }).status ?? 502;
      res.status(status).json({ error: "GitHub API error fetching collaborators" });
    }
  });

  router.get("/execution-workspaces/:id/github/labels", async (req, res) => {
    assertBoard(req);
    const ws = await executionWorkspaceService(db).getById(req.params.id);
    if (!ws) { res.status(404).json({ error: "Workspace not found" }); return; }
    await assertCompanyAccess(db, req, ws.companyId);
    if (!ws.repoUrl) { res.status(400).json({ error: "Workspace missing repoUrl" }); return; }

    try {
      const pat = await resolveGitHubAuth(db, ws.companyId, "github-metadata");
      const { owner, repo } = parseGitHubRepoUrl(ws.repoUrl);
      const octokit = new Octokit({ auth: pat });
      const { data } = await octokit.issues.listLabelsForRepo({ owner, repo, per_page: 100 });
      res.json(data.map((l) => ({ id: l.id, name: l.name, color: l.color })));
    } catch (err) {
      if (err instanceof GitHubPrError) { res.status(err.status).json({ error: err.message, hint: err.scopeHint }); return; }
      const status = (err as { status?: number }).status ?? 502;
      res.status(status).json({ error: "GitHub API error fetching labels" });
    }
  });

  router.get("/execution-workspaces/:id/github/milestones", async (req, res) => {
    assertBoard(req);
    const ws = await executionWorkspaceService(db).getById(req.params.id);
    if (!ws) { res.status(404).json({ error: "Workspace not found" }); return; }
    await assertCompanyAccess(db, req, ws.companyId);
    if (!ws.repoUrl) { res.status(400).json({ error: "Workspace missing repoUrl" }); return; }

    try {
      const pat = await resolveGitHubAuth(db, ws.companyId, "github-metadata");
      const { owner, repo } = parseGitHubRepoUrl(ws.repoUrl);
      const octokit = new Octokit({ auth: pat });
      const { data } = await octokit.issues.listMilestones({ owner, repo, state: "open", per_page: 100 });
      res.json(
        data.map((m) => ({
          number: m.number,
          title: m.title,
          openIssues: m.open_issues,
          dueOn: m.due_on ?? null,
        })),
      );
    } catch (err) {
      if (err instanceof GitHubPrError) { res.status(err.status).json({ error: err.message, hint: err.scopeHint }); return; }
      const status = (err as { status?: number }).status ?? 502;
      res.status(status).json({ error: "GitHub API error fetching milestones" });
    }
  });

  router.get("/execution-workspaces/:id/github/branches", async (req, res) => {
    assertBoard(req);
    const ws = await executionWorkspaceService(db).getById(req.params.id);
    if (!ws) { res.status(404).json({ error: "Workspace not found" }); return; }
    await assertCompanyAccess(db, req, ws.companyId);
    if (!ws.repoUrl) { res.status(400).json({ error: "Workspace missing repoUrl" }); return; }

    try {
      const pat = await resolveGitHubAuth(db, ws.companyId, "github-metadata");
      const { owner, repo } = parseGitHubRepoUrl(ws.repoUrl);
      const octokit = new Octokit({ auth: pat });
      const { data } = await octokit.repos.listBranches({ owner, repo, per_page: 100 });
      res.json(data.map((b) => ({ name: b.name, sha: b.commit.sha })));
    } catch (err) {
      if (err instanceof GitHubPrError) { res.status(err.status).json({ error: err.message, hint: err.scopeHint }); return; }
      const status = (err as { status?: number }).status ?? 502;
      res.status(status).json({ error: "GitHub API error fetching branches" });
    }
  });

  // ---------------------------------------------------------------------------
  // PR actions — merge / close / reopen / request-review
  // ---------------------------------------------------------------------------

  router.post("/execution-workspaces/:id/github-pr/merge", async (req, res) => {
    assertBoard(req);
    const parsed = mergePrBodySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid body", details: parsed.error.format() }); return; }

    const wsSvc = executionWorkspaceService(db);
    const ws = await wsSvc.getById(req.params.id);
    if (!ws) { res.status(404).json({ error: "Workspace not found" }); return; }
    await assertCompanyAccess(db, req, ws.companyId);

    const meta = (ws.metadata as Record<string, unknown> | null) ?? {};
    const pr = readGitHubPrMetadata(meta.pr);
    if (!pr) { res.status(400).json({ error: "No PR linked to this workspace" }); return; }
    if (!ws.repoUrl) { res.status(400).json({ error: "Workspace missing repoUrl" }); return; }

    try {
      await mergeWorkspacePr(db, { companyId: ws.companyId, repoUrl: ws.repoUrl, prNumber: pr.number, mergeMethod: parsed.data.mergeMethod });
    } catch (err) {
      if (err instanceof GitHubPrError) { res.status(err.status).json({ error: err.message, hint: err.scopeHint }); return; }
      throw err;
    }

    const updatedPr = { ...pr, state: "merged" as const };
    await wsSvc.update(ws.id, { metadata: { ...meta, pr: updatedPr } });
    await emitPullRequestTaskOutput(db, {
      companyId: ws.companyId,
      issueId: ws.sourceIssueId,
      executionWorkspaceId: ws.id,
      repoUrl: ws.repoUrl,
      pr: updatedPr,
    });

    const response: GitHubPrActionResponse = { success: true, prState: "merged", prUrl: pr.url };
    res.json(response);
  });

  router.post("/execution-workspaces/:id/github-pr/close", async (req, res) => {
    assertBoard(req);
    const wsSvc = executionWorkspaceService(db);
    const ws = await wsSvc.getById(req.params.id);
    if (!ws) { res.status(404).json({ error: "Workspace not found" }); return; }
    await assertCompanyAccess(db, req, ws.companyId);

    const meta = (ws.metadata as Record<string, unknown> | null) ?? {};
    const pr = readGitHubPrMetadata(meta.pr);
    if (!pr) { res.status(400).json({ error: "No PR linked to this workspace" }); return; }
    if (!ws.repoUrl) { res.status(400).json({ error: "Workspace missing repoUrl" }); return; }

    try {
      await closeWorkspacePr(db, { companyId: ws.companyId, repoUrl: ws.repoUrl, prNumber: pr.number });
    } catch (err) {
      if (err instanceof GitHubPrError) { res.status(err.status).json({ error: err.message, hint: err.scopeHint }); return; }
      throw err;
    }
    const updatedPr = { ...pr, state: "closed" as const };
    await wsSvc.update(ws.id, { metadata: { ...meta, pr: updatedPr } });
    await emitPullRequestTaskOutput(db, {
      companyId: ws.companyId,
      issueId: ws.sourceIssueId,
      executionWorkspaceId: ws.id,
      repoUrl: ws.repoUrl,
      pr: updatedPr,
    });

    const response: GitHubPrActionResponse = { success: true, prState: "closed", prUrl: pr.url };
    res.json(response);
  });

  router.post("/execution-workspaces/:id/github-pr/reopen", async (req, res) => {
    assertBoard(req);
    const wsSvc = executionWorkspaceService(db);
    const ws = await wsSvc.getById(req.params.id);
    if (!ws) { res.status(404).json({ error: "Workspace not found" }); return; }
    await assertCompanyAccess(db, req, ws.companyId);

    const meta = (ws.metadata as Record<string, unknown> | null) ?? {};
    const pr = readGitHubPrMetadata(meta.pr);
    if (!pr) { res.status(400).json({ error: "No PR linked to this workspace" }); return; }
    if (!ws.repoUrl) { res.status(400).json({ error: "Workspace missing repoUrl" }); return; }

    try {
      await reopenWorkspacePr(db, { companyId: ws.companyId, repoUrl: ws.repoUrl, prNumber: pr.number });
    } catch (err) {
      if (err instanceof GitHubPrError) { res.status(err.status).json({ error: err.message, hint: err.scopeHint }); return; }
      throw err;
    }
    const updatedPr = { ...pr, state: "open" as const };
    await wsSvc.update(ws.id, { metadata: { ...meta, pr: updatedPr } });
    await emitPullRequestTaskOutput(db, {
      companyId: ws.companyId,
      issueId: ws.sourceIssueId,
      executionWorkspaceId: ws.id,
      repoUrl: ws.repoUrl,
      pr: updatedPr,
    });

    const response: GitHubPrActionResponse = { success: true, prState: "open", prUrl: pr.url };
    res.json(response);
  });

  router.post("/execution-workspaces/:id/github-pr/request-review", async (req, res) => {
    assertBoard(req);
    const parsed = requestReviewBodySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid body", details: parsed.error.format() }); return; }

    const ws = await executionWorkspaceService(db).getById(req.params.id);
    if (!ws) { res.status(404).json({ error: "Workspace not found" }); return; }
    await assertCompanyAccess(db, req, ws.companyId);

    const meta = (ws.metadata as Record<string, unknown> | null) ?? {};
    const pr = readGitHubPrMetadata(meta.pr);
    if (!pr) { res.status(400).json({ error: "No PR linked to this workspace" }); return; }
    if (!ws.repoUrl) { res.status(400).json({ error: "Workspace missing repoUrl" }); return; }

    try {
      await requestPrReview(db, { companyId: ws.companyId, repoUrl: ws.repoUrl, prNumber: pr.number, reviewers: parsed.data.reviewers });
    } catch (err) {
      if (err instanceof GitHubPrError) { res.status(err.status).json({ error: err.message, hint: err.scopeHint }); return; }
      throw err;
    }
    res.json({ success: true });
  });

  // ---------------------------------------------------------------------------
  // GitHub App auth — install URL, OAuth callback, disconnect, status
  // ---------------------------------------------------------------------------

  router.get("/companies/:companyId/github/app/install-url", async (req, res) => {
    assertBoard(req);
    await assertCompanyAccess(db, req, req.params.companyId);
    try {
      // `return` is a caller-supplied hint, but it is only ever used to pick a
      // key out of the fixed ONBOARDING_RETURN_PATHS allowlist — an
      // unrecognized value is silently dropped (falls back to no returnTo,
      // i.e. the existing Settings redirect). The actual redirect path is
      // never taken from the request; it's baked into the signed state below
      // and re-validated against the same allowlist when the callback fires.
      const rawReturn = req.query.return;
      const returnTo = isOnboardingReturnTarget(rawReturn) ? rawReturn : undefined;
      const url = getInstallUrl(signInstallState(req.params.companyId, { returnTo }));
      res.json({ url });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to build install URL";
      res.status(503).json({ error: msg });
    }
  });

  router.get("/github/callback", async (req, res) => {
    const { installation_id, setup_action: _setup_action, state: rawState } = req.query as Record<string, string>;

    if (!installation_id || typeof installation_id !== "string") {
      res.status(400).json({ error: "Missing installation_id" });
      return;
    }

    const uiBase = process.env.AOA_AUTH_PUBLIC_BASE_URL ?? "http://localhost:5173";

    if (!rawState || typeof rawState !== "string") {
      res.redirect(`${uiBase}/settings?tab=github&github=invalid_state`);
      return;
    }

    const verified = verifyInstallState(rawState);
    if (!verified) {
      res.redirect(`${uiBase}/settings?tab=github&github=invalid_state`);
      return;
    }
    const { companyId, returnTo } = verified;

    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY_PEM;
    let accountLogin = "unknown";
    let accountType = "User";

    if (appId && privateKey) {
      try {
        const auth = createAppAuth({ appId, privateKey });
        const { token: appJwt } = await auth({ type: "app" });
        const octokit = new Octokit({ auth: appJwt });
        const { data } = await octokit.apps.getInstallation({ installation_id: Number(installation_id) });
        accountLogin = (data.account as { login?: string })?.login ?? "unknown";
        accountType = (data.account as { type?: string })?.type ?? "User";
      } catch {
        // Non-fatal — save with placeholder account info
      }
    }

    await saveInstallation(db, { companyId, installationId: installation_id, accountLogin, accountType });

    // Prefer the onboarding return target ONLY when it came from the signed,
    // integrity-protected state (never a raw/unsigned query param — that
    // would be an open redirect and could detach the callback from the
    // company the install was actually initiated for).
    //
    // Onboarding returns are ROOT-relative and land on the index gate ("/"),
    // which resolves the founder's unfinished first-run company server-side
    // and resumes the /onboarding in-flight tail — the steady /home dashboard
    // has no resume consumer, so it would strand the founder mid-onboarding.
    // The default (non-onboarding) Settings path keeps the company-id URL
    // prefix (e.g. /acme/settings?tab=github) for the deep link.
    if (returnTo) {
      res.redirect(`${uiBase}${ONBOARDING_RETURN_PATHS[returnTo]}`);
      return;
    }
    res.redirect(`${uiBase}/${companyId}/settings?tab=github`);
  });

  router.delete("/companies/:companyId/github/app", async (req, res) => {
    assertBoard(req);
    await assertCompanyAccess(db, req, req.params.companyId);
    await removeInstallation(db, req.params.companyId);
    res.json({ removed: true });
  });

  router.get("/companies/:companyId/github/app/status", async (req, res) => {
    assertBoard(req);
    await assertCompanyAccess(db, req, req.params.companyId);
    const installation = await getInstallation(db, req.params.companyId);
    if (!installation) {
      res.json({ installed: false });
      return;
    }
    res.json({
      installed: true,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      createdAt: installation.createdAt,
    });
  });

  /**
   * List the repositories the GitHub App installation can access. Returns []
   * when no installation is active for the company.
   */
  router.get("/companies/:companyId/github/app/repositories", async (req, res) => {
    assertBoard(req);
    await assertCompanyAccess(db, req, req.params.companyId);
    try {
      const repos = await listInstallationRepositories(db, req.params.companyId);
      res.json(repos);
    } catch (err) {
      if (err instanceof GitHubPrError) {
        res.status(err.status).json({ error: err.message, hint: err.scopeHint });
        return;
      }
      const status = (err as { status?: number }).status ?? 502;
      res.status(status).json({ error: "GitHub API error fetching repositories" });
    }
  });

  return router;
}
