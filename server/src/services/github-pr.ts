import { Octokit } from "@octokit/rest";
import type { Db } from "@armyofagents/db";
import {
  GITHUB_PAT_SECRET_NAME,
  type GitHubPrCreateResponse,
  type GitHubPrMetadata,
  type GitPrReviewState,
  type GitCIStatus,
  type GitBranchInfo,
} from "@armyofagents/shared";
import { secretService } from "./secrets.js";
import { getInstallation, mintInstallationToken } from "./github-app.js";

/**
 * Error thrown by the GitHub PR service when we want to surface a specific
 * HTTP-ish status to the route handler. The route maps this straight into
 * `res.status(err.status).json({ error, hint })`.
 */
export class GitHubPrError extends Error {
  public readonly status: number;
  public readonly scopeHint?: string;

  constructor(message: string, status: number, scopeHint?: string) {
    super(message);
    this.name = "GitHubPrError";
    this.status = status;
    this.scopeHint = scopeHint;
  }
}

/**
 * Parse an `owner` + `repo` pair out of a GitHub repo URL. Supports both HTTPS
 * and SSH forms, with or without a trailing `.git` and/or trailing slash.
 */
export function parseGitHubRepoUrl(repoUrl: string): { owner: string; repo: string } {
  const match = repoUrl.match(/github\.com[:/]([^/]+)\/([^/.\s]+?)(?:\.git)?\/?$/);
  if (!match) {
    throw new GitHubPrError(`Invalid GitHub repo URL: ${repoUrl}`, 400);
  }
  return { owner: match[1]!, repo: match[2]! };
}

async function resolveGitHubPat(
  db: Db,
  companyId: string,
  consumerId: string,
): Promise<string> {
  const svc = secretService(db);
  const secretRow = await svc.getByName(companyId, GITHUB_PAT_SECRET_NAME);
  if (!secretRow) {
    throw new GitHubPrError(
      "GitHub PAT not configured",
      412,
      "Go to Settings -> Integrations -> GitHub and connect a personal access token",
    );
  }

  let pat: string;
  try {
    pat = await svc.resolveSecretValue(companyId, secretRow.id, "latest", {
      consumerType: "system",
      consumerId,
      configPath: "github.pat",
      actorType: "system",
    });
  } catch {
    throw new GitHubPrError("GitHub PAT could not be decrypted", 500);
  }
  if (!pat) {
    throw new GitHubPrError("GitHub PAT could not be decrypted", 500);
  }
  return pat;
}

/**
 * Resolve a GitHub access token for the given company.
 *
 * Resolution order:
 *   1. GitHub App installation token (auto-rotating, org-wide)
 *   2. Company PAT (manual, per-token scope)
 *
 * Throws GitHubPrError(412) if neither is configured.
 */
export async function resolveGitHubAuth(
  db: Db,
  companyId: string,
  consumerId: string,
): Promise<string> {
  // 1. Try a GitHub App installation token. If minting fails (missing/invalid
  //    app credentials, or a transient error), fall through to the PAT so a
  //    broken App install can't take down GitHub features for a company that
  //    also has a working PAT.
  const installation = await getInstallation(db, companyId);
  if (installation) {
    try {
      return await mintInstallationToken(installation.installationId);
    } catch {
      // fall through to PAT resolution below
    }
  }

  // 2. Fall back to PAT
  return resolveGitHubPat(db, companyId, consumerId);
}

function mapGitHubApiError(err: unknown, owner: string, repo: string): never {
  if (err instanceof GitHubPrError) throw err;
  const status = (err as { status?: number }).status ?? 500;
  if (status === 401) {
    throw new GitHubPrError(
      "GitHub PAT is invalid or expired. Reconnect in Settings -> Integrations.",
      401,
      "Disconnect + reconnect GitHub in Settings -> Integrations",
    );
  }
  if (status === 403) {
    throw new GitHubPrError(
      "PAT lacks required permissions. Reconnect with 'repo' + 'pull_requests: write' scopes.",
      403,
      "Disconnect + reconnect GitHub in Settings -> Integrations with a PAT that has repo + pull_requests:write scope",
    );
  }
  if (status === 404) {
    throw new GitHubPrError(`Repository not found: ${owner}/${repo}`, 404);
  }
  if (status === 422) {
    const msg =
      (err as { response?: { data?: { message?: string } } }).response?.data?.message ??
      "PR creation failed";
    throw new GitHubPrError(msg, 422);
  }
  throw new GitHubPrError("GitHub API error", status);
}

export async function findPullRequestForBranch(
  db: Db,
  args: {
    companyId: string;
    repoUrl: string;
    branchName: string;
  },
): Promise<{ pr: GitHubPrMetadata | null; baseRef: string | null }> {
  const pat = await resolveGitHubAuth(db, args.companyId, "github-pr-sync");
  const { owner, repo } = parseGitHubRepoUrl(args.repoUrl);
  const octokit = new Octokit({ auth: pat });

  try {
    const { data } = await octokit.pulls.list({
      owner,
      repo,
      state: "all",
      head: `${owner}:${args.branchName}`,
      per_page: 10,
      sort: "updated",
      direction: "desc",
    });
    const match = data.find((item) => item.head?.ref === args.branchName) ?? null;
    if (!match) {
      return { pr: null, baseRef: null };
    }

    return {
      pr: {
        url: match.html_url,
        number: match.number,
        state: match.merged_at ? "merged" : match.state === "closed" ? "closed" : "open",
        createdAt: new Date().toISOString(),
        draft: match.draft ?? false,
      },
      baseRef: match.base?.ref ?? null,
    };
  } catch (err) {
    mapGitHubApiError(err, owner, repo);
  }
}

/**
 * Create a pull request on GitHub using the company's stored PAT.
 *
 * Throws `GitHubPrError` with a surfaced HTTP status on:
 * - 412 no PAT configured
 * - 401 invalid / expired PAT
 * - 403 PAT lacks required scope
 * - 404 repo not found
 * - 422 PR creation validation failure (surfaces Octokit's message)
 *
 * The happy-path response always reports `state` as `"open"` for newly-created
 * PRs. `"closed"` is included defensively only if GitHub ever returns it.
 */
export async function createPullRequest(
  db: Db,
  args: {
    companyId: string;
    repoUrl: string;
    base: string;
    head: string;
    title: string;
    body: string;
    draft: boolean;
    reviewers?: string[];
    labels?: string[];
    milestoneNumber?: number;
  },
): Promise<GitHubPrCreateResponse> {
  const pat = await resolveGitHubAuth(db, args.companyId, "github-pr");
  const { owner, repo } = parseGitHubRepoUrl(args.repoUrl);
  const octokit = new Octokit({ auth: pat });

  try {
    const { data } = await octokit.pulls.create({
      owner,
      repo,
      base: args.base,
      head: args.head,
      title: args.title,
      body: args.body,
      draft: args.draft,
    });
    const prNumber = data.number;

    // Post-creation: reviewers, labels, milestone (separate GitHub API calls)
    const postCalls: Promise<unknown>[] = [];

    if (args.reviewers && args.reviewers.length > 0) {
      postCalls.push(
        octokit.pulls.requestReviewers({ owner, repo, pull_number: prNumber, reviewers: args.reviewers }),
      );
    }
    if (args.labels && args.labels.length > 0) {
      postCalls.push(
        octokit.issues.addLabels({ owner, repo, issue_number: prNumber, labels: args.labels }),
      );
    }
    if (args.milestoneNumber != null) {
      postCalls.push(
        octokit.issues.update({ owner, repo, issue_number: prNumber, milestone: args.milestoneNumber }),
      );
    }

    // Best-effort — PR is created even if post-calls fail
    await Promise.allSettled(postCalls);

    return {
      url: data.html_url,
      number: prNumber,
      state: data.state === "closed" ? "closed" : "open",
      draft: data.draft ?? false,
    };
  } catch (err: unknown) {
    mapGitHubApiError(err, owner, repo);
  }
}

// ---------------------------------------------------------------------------
// Git Command Centre enrichment helpers
// ---------------------------------------------------------------------------

/**
 * Resolve PR review state using per-reviewer latest review logic.
 *
 * Why not "newest-overall"? If reviewer A left CHANGES_REQUESTED and reviewer
 * B later left APPROVED, the PR still has outstanding change requests from A.
 * GitHub's own merge check uses per-reviewer latest — we match that behaviour.
 */
export async function getPrReviewState(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  isDraft: boolean,
  prState: "open" | "closed" | "merged",
): Promise<GitPrReviewState> {
  if (prState === "merged") return "merged";
  if (prState === "closed") return "closed";
  if (isDraft) return "draft";

  const { data: reviews } = await octokit.pulls.listReviews({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  // GitHub returns reviews OLDEST-first, so iterate forward and let each
  // reviewer's latest DECISION win. COMMENTED/PENDING reviews don't change a
  // standing decision (a trailing comment must not erase an approval);
  // DISMISSED clears the reviewer's prior decision.
  const latestByReviewer = new Map<string, string>();
  for (const review of reviews) {
    const login = review.user?.login;
    if (!login) continue;
    if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED") {
      latestByReviewer.set(login, review.state);
    } else if (review.state === "DISMISSED") {
      latestByReviewer.delete(login);
    }
  }

  const states = [...latestByReviewer.values()];
  if (states.some((s) => s === "CHANGES_REQUESTED")) return "changes_requested";
  if (states.length > 0 && states.every((s) => s === "APPROVED")) return "approved";
  return "open";
}

/**
 * Fetch the combined CI/check status for a git ref.
 * Maps GitHub combined status to our 3-value enum.
 */
export async function getCIStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<{ status: GitCIStatus; ciUrl: string | null }> {
  try {
    const { data } = await octokit.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref,
    });
    const { state, statuses } = data;
    let status: GitCIStatus = null;
    if (state === "success") status = "passing";
    else if (state === "failure" || state === "error") status = "failing";
    else if (state === "pending") status = "pending";

    // Link to first failed check's target URL, or overall combined_url
    const failedStatus = statuses.find((s) => s.state === "failure" || s.state === "error");
    const ciUrl: string | null =
      failedStatus?.target_url ?? data.repository?.html_url ?? null;

    return { status, ciUrl };
  } catch {
    return { status: null, ciUrl: null };
  }
}

/**
 * Fully enrich a single branch with PR metadata, review state, CI status,
 * and comment count. Returns null when no PAT is configured.
 *
 * The caller is responsible for creating the Octokit instance (so the PAT
 * is decrypted once per request, not once per branch).
 */
export async function enrichBranchPr(
  octokit: Octokit,
  owner: string,
  repo: string,
  branchName: string,
): Promise<GitBranchInfo["pr"] | null> {
  try {
    const { data: prs } = await octokit.pulls.list({
      owner,
      repo,
      state: "all",
      head: `${owner}:${branchName}`,
      per_page: 5,
      sort: "updated",
      direction: "desc",
    });

    const match = prs.find((pr) => pr.head?.ref === branchName);
    if (!match) return null;

    const prState: "open" | "closed" | "merged" = match.merged_at
      ? "merged"
      : match.state === "closed"
        ? "closed"
        : "open";

    const [reviewState, ciResult, commentData] = await Promise.all([
      getPrReviewState(octokit, owner, repo, match.number, match.draft ?? false, prState),
      prState === "open"
        ? getCIStatus(octokit, owner, repo, match.head.sha)
        : Promise.resolve({ status: null as GitCIStatus, ciUrl: null }),
      octokit.pulls.get({ owner, repo, pull_number: match.number }),
    ]);

    return {
      number: match.number,
      url: match.html_url,
      reviewState,
      ciStatus: ciResult.status,
      ciUrl: ciResult.ciUrl,
      commentCount: commentData.data.comments + commentData.data.review_comments,
      labels: (match.labels ?? []).map((l) => ({
        name: l.name,
        color: l.color.startsWith("#") ? l.color : `#${l.color}`,
      })),
    };
  } catch (err) {
    if (err instanceof GitHubPrError) throw err;
    // Swallow per-branch errors — don't fail the whole enrichment batch
    return null;
  }
}

// ---------------------------------------------------------------------------
// PR action helpers
// ---------------------------------------------------------------------------

export async function mergeWorkspacePr(
  db: Db,
  args: {
    companyId: string;
    repoUrl: string;
    prNumber: number;
    mergeMethod: "merge" | "squash" | "rebase";
  },
): Promise<{ sha: string }> {
  const pat = await resolveGitHubAuth(db, args.companyId, "github-pr");
  const { owner, repo } = parseGitHubRepoUrl(args.repoUrl);
  const octokit = new Octokit({ auth: pat });
  try {
    const { data } = await octokit.pulls.merge({
      owner,
      repo,
      pull_number: args.prNumber,
      merge_method: args.mergeMethod,
    });
    return { sha: data.sha ?? "" };
  } catch (err) {
    mapGitHubApiError(err, owner, repo);
  }
}

export async function closeWorkspacePr(
  db: Db,
  args: { companyId: string; repoUrl: string; prNumber: number },
): Promise<void> {
  const pat = await resolveGitHubAuth(db, args.companyId, "github-pr");
  const { owner, repo } = parseGitHubRepoUrl(args.repoUrl);
  const octokit = new Octokit({ auth: pat });
  try {
    await octokit.pulls.update({ owner, repo, pull_number: args.prNumber, state: "closed" });
  } catch (err) {
    mapGitHubApiError(err, owner, repo);
  }
}

export async function reopenWorkspacePr(
  db: Db,
  args: { companyId: string; repoUrl: string; prNumber: number },
): Promise<void> {
  const pat = await resolveGitHubAuth(db, args.companyId, "github-pr");
  const { owner, repo } = parseGitHubRepoUrl(args.repoUrl);
  const octokit = new Octokit({ auth: pat });
  try {
    await octokit.pulls.update({ owner, repo, pull_number: args.prNumber, state: "open" });
  } catch (err) {
    mapGitHubApiError(err, owner, repo);
  }
}

export async function requestPrReview(
  db: Db,
  args: { companyId: string; repoUrl: string; prNumber: number; reviewers: string[] },
): Promise<void> {
  const pat = await resolveGitHubAuth(db, args.companyId, "github-pr");
  const { owner, repo } = parseGitHubRepoUrl(args.repoUrl);
  const octokit = new Octokit({ auth: pat });
  try {
    await octokit.pulls.requestReviewers({
      owner,
      repo,
      pull_number: args.prNumber,
      reviewers: args.reviewers,
    });
  } catch (err) {
    mapGitHubApiError(err, owner, repo);
  }
}
