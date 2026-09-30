// -----------------------------------------------------------------------------
// github-rest — the thin, deliberately dumb REST edge for DEP-013's two CLIs.
//
// Every DECISION lives in `scripts/lib/workflow-verdict.mjs`, which is pure and unit-tested.
// This module holds only transport: build a request, fail loudly, hand back JSON. Nothing
// here may interpret a verdict, because anything that interprets a verdict needs a killable
// mutant and this file has no tests.
//
// FAIL LOUD, NEVER SOFT. A `catch { return null }` here would turn a rate limit or an expired
// token into "nothing to report" — a consumer that reports silence when it cannot see is the
// exact defect DEP-013 exists to close, reproduced one layer down.
// -----------------------------------------------------------------------------

const API = "https://api.github.com";

export function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is not set — refusing to run half-blind`);
  }
  return value.trim();
}

/** `owner/repo` from GITHUB_REPOSITORY. */
export function resolveRepo() {
  const slug = requireEnv("GITHUB_REPOSITORY");
  const [owner, repo] = slug.split("/");
  if (!owner || !repo) throw new Error(`GITHUB_REPOSITORY is not owner/repo: ${slug}`);
  return { owner, repo, slug };
}

export function createClient({ token, fetchImpl = fetch }) {
  if (typeof token !== "string" || token.trim() === "") throw new Error("createClient: no token");
  return async function request(method, pathname, { body, allow404 = false } = {}) {
    const url = pathname.startsWith("http") ? pathname : `${API}${pathname}`;
    const res = await fetchImpl(url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "aoa-dep-013-verdict-consumer",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 404 && allow404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${method} ${url} → ${res.status} ${res.statusText} ${text.slice(0, 400)}`);
    }
    if (res.status === 204) return null;
    return res.json();
  };
}

/** Newest-first runs for one (workflow file, branch) stream, normalised for the evaluator.
 *  `completedAt` uses `updated_at`: the runs API carries no `completed_at`, and for a run in
 *  a terminal state `updated_at` is the moment it reached one. */
export async function listStreamRuns(request, { owner, repo, workflowFile, branch, perPage = 50 }) {
  const qs = new URLSearchParams({ per_page: String(perPage) });
  if (branch) qs.set("branch", branch);
  const data = await request(
    "GET",
    `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?${qs}`,
    { allow404: true },
  );
  if (!data) return [];
  return (data.workflow_runs ?? []).map((r) => ({
    id: r.id,
    headSha: r.head_sha,
    headBranch: r.head_branch,
    event: r.event,
    status: r.status,
    conclusion: r.conclusion,
    url: r.html_url,
    completedAt: r.updated_at,
    createdAt: r.created_at,
  }));
}

/** How many COMPLETED runs a workflow has ever recorded. Used ONLY to refuse the
 *  never-bootstrapped excuse — never as a heartbeat. */
export async function countCompletedRuns(request, { owner, repo, workflowFile }) {
  const data = await request(
    "GET",
    `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?status=completed&per_page=1`,
    { allow404: true },
  );
  if (!data) return 0;
  return Number(data.total_count ?? 0);
}

/** Newest-first commit shas on a branch, or null when the branch does not exist. */
export async function listBranchCommits(request, { owner, repo, branch, perPage = 30 }) {
  const qs = new URLSearchParams({ sha: branch, per_page: String(perPage) });
  const data = await request("GET", `/repos/${owner}/${repo}/commits?${qs}`, { allow404: true });
  if (!data) return null;
  return data.map((c) => ({ sha: c.sha, committedAt: c.commit?.committer?.date ?? c.commit?.author?.date ?? null }));
}

/** The changed-file list for one commit. */
export async function getCommitFiles(request, { owner, repo, sha }) {
  const data = await request("GET", `/repos/${owner}/${repo}/commits/${sha}`, { allow404: true });
  if (!data) return null;
  return (data.files ?? []).map((f) => f.filename);
}

/** The single issue carrying `label`, or null. Labels are used rather than a title search
 *  because the search API is eventually consistent and this is read immediately after a
 *  write; a label query is not. */
export async function findLabelledIssue(request, { owner, repo, label }) {
  const qs = new URLSearchParams({ labels: label, state: "all", per_page: "20" });
  const data = await request("GET", `/repos/${owner}/${repo}/issues?${qs}`, { allow404: true });
  if (!data) return null;
  const issues = data.filter((i) => !i.pull_request);
  if (issues.length === 0) return null;
  issues.sort((a, b) => a.number - b.number);
  return { number: issues[0].number, title: issues[0].title, body: issues[0].body ?? "", url: issues[0].html_url };
}

/** Does the workflow FILE exist on this branch? A workflow that is not on a branch cannot
 *  run there, so a commit on that branch owes it nothing — reporting one would be an
 *  incident whose only repair is a programme decision. Measured, not assumed: the first live
 *  dry-run reported `d1-merge-train.yml@main uncovered_commit` for exactly this reason. */
export async function workflowFileExistsOnBranch(request, { owner, repo, workflowFile, branch }) {
  const qs = new URLSearchParams({ ref: branch });
  const data = await request(
    "GET",
    `/repos/${owner}/${repo}/contents/.github/workflows/${encodeURIComponent(workflowFile)}?${qs}`,
    { allow404: true },
  );
  return data != null;
}

export async function ensureLabel(request, { owner, repo, label, description }) {
  const existing = await request("GET", `/repos/${owner}/${repo}/labels/${encodeURIComponent(label)}`, { allow404: true });
  if (existing) return;
  await request("POST", `/repos/${owner}/${repo}/labels`, {
    body: { name: label, color: "0e8a16", description: description?.slice(0, 100) ?? "" },
  });
}
