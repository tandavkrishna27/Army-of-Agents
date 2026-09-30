/**
 * U6.4 — org host commit/push/PR from the pulled in-VM diff.
 *
 * After the in-VM diff is pulled out of a crew/org sandbox (U6.3's
 * `collectSandboxDiff`), the HOST applies those files onto a host git clone,
 * commits, pushes, and opens the PR using the company's GitHub credentials
 * (`resolveGitHubAuth`/`createPullRequest`, `github-pr.ts`).
 *
 * All git here runs through the U6.1 `assertHostOrchestrationGitAllowed`
 * guard, never the tenant guard (`assertLocalWorkspaceCommandAllowed`) — this
 * is AoA's own orchestration code operating on a host clone, not
 * tenant-authored model output executing unsandboxed (spec §9 blast-radius
 * reframe), so it is permitted on cloud_auth while the tenant-command sink
 * stays refused there.
 *
 * Every git invocation runs hooks-neutralized (`-c core.hooksPath=`) — a
 * SECURITY requirement, not a convenience: the pulled diff ultimately
 * originates from tenant-directed model output, and a hook script smuggled
 * into it must never execute on the host at commit time.
 *
 * Partial-success (spec §8): if `createPullRequest` fails after the branch
 * has already been pushed, the pushed work is never discarded — the caller
 * still gets the pushed branch back.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@armyofagents/db";
import { createPullRequest, resolveGitHubAuth } from "./github-pr.js";
import { assertHostOrchestrationGitAllowed } from "./local-workspace-command-guard.js";
import { executeProcess } from "./workspace-runtime.js";

export interface PulledFile {
  path: string;
  content: Buffer;
}

/**
 * Injectable git-execution seam. Production code should never pass
 * `gitRunner` — it defaults to a runner backed by `workspace-runtime.ts`'s
 * shared `executeProcess` spawn chokepoint (`orchestration: "host"`). Tests
 * inject a recording double so the suite never shells a real `git`/network
 * push, while still exercising the real `assertHostOrchestrationGitAllowed`
 * guard call in `runHostOrchestrationGit` below (that call sits outside the
 * runner delegation, so it fires regardless of which runner is used).
 */
export type HostGitRunner = (
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface FinalizeSandboxOrgWorkspaceInput {
  db: Db;
  companyId: string;
  repoUrl: string;
  hostClonePath: string;
  branchName: string;
  baseRef: string;
  files: PulledFile[];
  prTitle: string;
  prBody: string;
  /** Test-only injection seam; production callers must never pass this. */
  gitRunner?: HostGitRunner;
}

export interface FinalizeSandboxOrgWorkspaceResult {
  branch: string;
  /** Whether the commit/push to `origin/<branch>` succeeded. */
  pushed: boolean;
  /** Null when the branch pushed but PR creation failed (partial-success). */
  prUrl: string | null;
  prNumber: number | null;
  /** Pulled-file paths rejected by the path-traversal guard (never written). */
  rejectedFiles: string[];
}

/** Guard against path traversal — mirrors `isInsideWorkspace` in output-detection.ts. */
function isInsideClone(cloneRoot: string, absPath: string): boolean {
  const resolvedRoot = path.resolve(cloneRoot);
  return absPath === resolvedRoot || absPath.startsWith(resolvedRoot + path.sep);
}

/**
 * RW4 (defense-in-depth) — reject any pulled file that resolves inside a
 * `.git/` directory anywhere under the clone. The current diff/pull path
 * (`collectSandboxDiff`, U6.3) never lists `.git/`-prefixed paths, but a
 * pulled `.git/hooks/pre-commit` or `.git/config` written into the clone
 * could execute (or alter git's own behavior, e.g. `core.hooksPath`) on the
 * HOST at commit time — a host-RCE-class footgun this closes for any future
 * source of pulled files, in addition to the existing `isInsideClone`
 * escape guard above.
 */
function targetsGitDir(cloneRoot: string, absPath: string): boolean {
  const resolvedRoot = path.resolve(cloneRoot);
  const relative = path.relative(resolvedRoot, absPath);
  return relative.split(path.sep).includes(".git");
}

/**
 * Writes each pulled `{path, content}` entry into `hostClonePath`. Any entry
 * whose resolved path escapes the clone root (e.g. `../evil.txt`, or an
 * absolute path outside the clone) is rejected — never written anywhere —
 * and reported back via `rejected` instead of aborting the whole batch.
 * (RW4: an entry that resolves inside a `.git/` directory of the clone is
 * rejected the same way — see `targetsGitDir` above.)
 */
async function writePulledFiles(
  hostClonePath: string,
  files: PulledFile[],
): Promise<{ written: string[]; rejected: string[] }> {
  const resolvedRoot = path.resolve(hostClonePath);
  const written: string[] = [];
  const rejected: string[] = [];

  for (const file of files) {
    const target = path.resolve(resolvedRoot, file.path);
    if (!isInsideClone(resolvedRoot, target) || targetsGitDir(resolvedRoot, target)) {
      rejected.push(file.path);
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content);
    written.push(file.path);
  }

  return { written, rejected };
}

/** Production default: shells `git` via the shared `executeProcess` chokepoint. */
async function defaultHostGitRunner(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = await executeProcess({ command: "git", args, cwd, orchestration: "host" });
  return { stdout: proc.stdout, stderr: proc.stderr, code: proc.code ?? -1 };
}

/**
 * Runs one hooks-neutralized git command against the host clone, wrapped in
 * the U6.1 host-orchestration guard. This guard call is intentionally OUTSIDE
 * the `runner` delegation so it fires the same way whether `runner` is the
 * production `defaultHostGitRunner` or a test double.
 */
async function runHostOrchestrationGit(
  runner: HostGitRunner,
  args: string[],
  cwd: string,
  label: string,
): Promise<string> {
  assertHostOrchestrationGitAllowed("org host commit/push");
  const result = await runner(["-c", "core.hooksPath=", ...args], cwd);
  if (result.code !== 0) {
    throw new Error(`${label} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

/**
 * Applies the pulled in-VM diff onto the host clone, commits, pushes to
 * `origin/<branchName>`, and opens a PR. On `createPullRequest` failure the
 * already-pushed branch is still reported (spec §8 partial-success) instead
 * of throwing and discarding the produced work.
 */
export async function finalizeSandboxOrgWorkspace(
  input: FinalizeSandboxOrgWorkspaceInput,
): Promise<FinalizeSandboxOrgWorkspaceResult> {
  const runner = input.gitRunner ?? defaultHostGitRunner;

  const { written, rejected } = await writePulledFiles(input.hostClonePath, input.files);

  if (written.length > 0) {
    await runHostOrchestrationGit(runner, ["add", "-A"], input.hostClonePath, "org host add");
    await runHostOrchestrationGit(
      runner,
      ["commit", "-m", input.prTitle],
      input.hostClonePath,
      "org host commit",
    );
  }

  // Push auth: inject the company's GitHub credential via http.extraheader
  // (mirrors the same PAT-injection pattern used by git.ts's founder-driven
  // workspace push) rather than relying on ambient host credential state.
  const pat = await resolveGitHubAuth(input.db, input.companyId, "sandbox-workspace-pr");
  const authToken = Buffer.from(`x-access-token:${pat}`).toString("base64");
  await runHostOrchestrationGit(
    runner,
    [
      "-c",
      `http.${input.repoUrl}.extraheader=Authorization: Basic ${authToken}`,
      "push",
      "origin",
      input.branchName,
    ],
    input.hostClonePath,
    "org host push",
  );

  let prUrl: string | null = null;
  let prNumber: number | null = null;
  try {
    const pr = await createPullRequest(input.db, {
      companyId: input.companyId,
      repoUrl: input.repoUrl,
      base: input.baseRef,
      head: input.branchName,
      title: input.prTitle,
      body: input.prBody,
      draft: false,
    });
    prUrl = pr.url;
    prNumber = pr.number;
  } catch {
    // Partial-success (§8): the branch is already pushed — never discard
    // produced work because a separate GitHub API call (PR creation) failed.
  }

  return {
    branch: input.branchName,
    pushed: true,
    prUrl,
    prNumber,
    rejectedFiles: rejected,
  };
}
