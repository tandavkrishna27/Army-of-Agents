/**
 * Git Command Centre — project-level git graph API.
 *
 * Two endpoints deliberately split by speed:
 *
 *   GET /companies/:cid/projects/:pid/git/graph
 *     Fast (~50ms): git-only branch list + commit graph. No GitHub calls.
 *     The canvas renders immediately from this data; PR badges arrive later.
 *
 *   GET /companies/:cid/projects/:pid/git/enrich
 *     Slow (~1–2s): GitHub PR + CI enrichment per branch.
 *     Batches at most 5 concurrent Octokit calls (p-limit).
 *
 * Both responses are cached 25s per (companyId, projectId) in-memory.
 * Cache is process-local — suitable for single-process deployments only.
 */

import { Router } from "express";
import { Octokit } from "@octokit/rest";
import { eq, and, desc, asc, inArray } from "drizzle-orm";
import {
  executionWorkspaces,
  issues,
  projectWorkspaces,
  type Db,
} from "@armyofagents/db";
import {
  GITHUB_PAT_SECRET_NAME,
  type GitBranchInfo,
  type GitCommitNode,
  type GitGraphData,
  type GitProjectEnrichResponse,
  type GitProjectGraphResponse,
} from "@armyofagents/shared";
import { assertCompanyAccess } from "./authz.js";
import { secretService } from "../services/secrets.js";
import { getBranches, getCommitGraph, resolveGitRoot } from "../services/git.js";
import { enrichBranchPr, GitHubPrError, parseGitHubRepoUrl, resolveGitHubAuth } from "../services/github-pr.js";
import { getInstallation } from "../services/github-app.js";
import { assertLocalWorkspaceCommandAllowed } from "../services/local-workspace-command-guard.js";
import {
  graphCache,
  enrichCache,
  GRAPH_CACHE_TTL_MS,
  ENRICH_CACHE_TTL_MS,
  projectGitCacheKey,
} from "../services/project-git-cache.js";
import pLimit from "p-limit";

// ---------------------------------------------------------------------------
// Lane color palette (matches design system)
// ---------------------------------------------------------------------------

const LANE_COLORS = [
  "#6470DC", // indigo — main/default branch
  "#4FB67E", // green
  "#D9A938", // amber
  "#C25BA8", // magenta
  "#3FA8C7", // teal
  "#7E8AA8", // slate
];

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function projectGitRoutes(db: Db) {
  const router = Router();

  // ─── GET /companies/:cid/projects/:pid/git/graph ──────────────────────────

  router.get("/companies/:companyId/projects/:projectId/git/graph", async (req, res) => {
    const { companyId, projectId } = req.params as { companyId: string; projectId: string };
    await assertCompanyAccess(db, req, companyId);

    const cacheKey = projectGitCacheKey(companyId, projectId);
    const cached = graphCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      res.json(cached.data);
      return;
    }

    try {
      // 1. Resolve git root — prefer isPrimary project workspace
      const pwRows = await db
        .select({ cwd: projectWorkspaces.cwd, repoUrl: projectWorkspaces.repoUrl })
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.projectId, projectId),
            eq(projectWorkspaces.companyId, companyId),
          ),
        )
        // Primary first, then oldest — matches services/projects.ts election.
        .orderBy(
          desc(projectWorkspaces.isPrimary),
          asc(projectWorkspaces.createdAt),
          asc(projectWorkspaces.id),
        );

      const primaryWs = pwRows.find((r) => r.cwd) ?? null;
      const repoUrl = primaryWs?.repoUrl ?? null;

      if (!primaryWs?.cwd) {
        const empty: GitProjectGraphResponse = {
          branches: [],
          graph: { commits: [], branches: [], defaultBranch: "main" },
          repoUrl: null,
          hasGitHubConnection: false,
          noWorkspaceYet: true,
        };
        res.json(empty);
        return;
      }

      assertLocalWorkspaceCommandAllowed("project Git graph command");
      const gitRoot = await resolveGitRoot(primaryWs.cwd);
      if (!gitRoot) {
        const empty: GitProjectGraphResponse = {
          branches: [],
          graph: { commits: [], branches: [], defaultBranch: "main" },
          repoUrl,
          hasGitHubConnection: false,
          noWorkspaceYet: true,
        };
        res.json(empty);
        return;
      }

      // 2. Check PAT or App installation existence (read-only — no decryption needed here)
      const sSvc = secretService(db);
      const patRow = await sSvc.getByName(companyId, GITHUB_PAT_SECRET_NAME);
      const installation = await getInstallation(db, companyId);
      const hasGitHubConnection = !!installation || (!!patRow && patRow.status === "active");

      // 3. Fetch branches + graph in parallel
      const [localBranches, commitEntries] = await Promise.all([
        getBranches(gitRoot),
        getCommitGraph(gitRoot, { limit: 200 }),
      ]);

      // 4. Fetch execution workspaces for this project (branch → task linking)
      //    JOIN key: ws.branchName === branch.name; task id: ws.sourceIssueId
      const wsRows = await db
        .select({
          id: executionWorkspaces.id,
          branchName: executionWorkspaces.branchName,
          sourceIssueId: executionWorkspaces.sourceIssueId,
        })
        .from(executionWorkspaces)
        .where(
          and(
            eq(executionWorkspaces.projectId, projectId),
            eq(executionWorkspaces.companyId, companyId),
          ),
        );

      // Fetch linked issues for task metadata
      const issueIds = wsRows
        .map((w) => w.sourceIssueId)
        .filter((id): id is string => !!id);

      const issueRows =
        issueIds.length > 0
          ? await db
              .select({
                id: issues.id,
                identifier: issues.identifier,
                title: issues.title,
                status: issues.status,
                workMode: issues.workMode,
              })
              .from(issues)
              .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)))
          : [];

      const issueById = new Map(issueRows.map((i) => [i.id, i]));
      const wsByBranch = new Map(wsRows.filter((w) => w.branchName).map((w) => [w.branchName!, w]));

      // 5. Build sorted branch list (default branch first)
      const defaultBranchName = localBranches.find((b) => b.name === "main" || b.name === "master")?.name ?? (localBranches[0]?.name ?? "main");
      const sorted = [
        ...localBranches.filter((b) => b.name === defaultBranchName),
        ...localBranches.filter((b) => b.name !== defaultBranchName),
      ];

      // 6. Map to GitBranchInfo (pr = null — enriched separately)
      const branchInfoList: GitBranchInfo[] = sorted.map((lb, idx) => {
        const ws = wsByBranch.get(lb.name);
        const issue = ws?.sourceIssueId ? issueById.get(ws.sourceIssueId) : undefined;
        return {
          name: lb.name,
          isLocal: lb.isLocal,
          isRemote: lb.isRemote,
          aheadCount: lb.aheadCount,
          behindCount: lb.behindCount,
          lastCommitSha: lb.tipSha,
          lastCommitMessage: lb.lastCommitMessage,
          lastCommitAt: lb.lastCommitAt,
          lastCommitAuthor: lb.lastCommitAuthor,
          linkedWorkspaceId: ws?.id ?? null,
          linkedIssueId: ws?.sourceIssueId ?? null,
          linkedIssueIdentifier: issue?.identifier ?? null,
          linkedIssueTitle: issue?.title ?? null,
          linkedIssueStatus: issue?.status ?? null,
          linkedIssueWorkMode: (issue?.workMode as "standard" | "planning" | null) ?? null,
          pr: null,   // populated by /git/enrich
          overlays: lb.overlays,
          tags: lb.tags,
        };
      });

      // 7. Build GitGraphData — assign lane indices + colors
      // Use first-occurrence so the default branch wins when multiple branches
      // share the same tip SHA (e.g. main, ARM-15, ARM-19 all at the same commit).
      const tipShaToName = new Map<string, string>();
      for (const b of sorted) {
        if (!tipShaToName.has(b.tipSha)) {
          tipShaToName.set(b.tipSha, b.name);
        }
      }
      const commits: GitCommitNode[] = commitEntries.map((c) => ({
        sha: c.sha,
        parentShas: c.parentShas,
        shortSha: c.sha.slice(0, 8),
        message: c.message,
        author: c.author,
        committedAt: c.committedAt,
        branchNames: c.refs.filter((r) => tipShaToName.has(c.sha) && r === tipShaToName.get(c.sha)),
        isMerge: c.parentShas.length > 1,
        tags: c.refs.filter((r) => r.startsWith("v") || r.match(/^\d/)),
      }));

      const graphBranches: GitGraphData["branches"] = sorted.map((b, idx) => ({
        name: b.name,
        laneIndex: idx,
        color: LANE_COLORS[idx % LANE_COLORS.length] ?? LANE_COLORS[0]!,
        tipSha: b.tipSha,
      }));

      const graph: GitGraphData = {
        commits,
        branches: graphBranches,
        defaultBranch: defaultBranchName,
      };

      const response: GitProjectGraphResponse = {
        branches: branchInfoList,
        graph,
        repoUrl,
        hasGitHubConnection,
        noWorkspaceYet: false,
      };

      graphCache.set(cacheKey, { data: response, expiresAt: Date.now() + GRAPH_CACHE_TTL_MS });
      res.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Git graph error";
      res.status(500).json({ error: message });
    }
  });

  // ─── GET /companies/:cid/projects/:pid/git/enrich ─────────────────────────

  router.get("/companies/:companyId/projects/:projectId/git/enrich", async (req, res) => {
    const { companyId, projectId } = req.params as { companyId: string; projectId: string };
    await assertCompanyAccess(db, req, companyId);

    const cacheKey = projectGitCacheKey(companyId, projectId);
    const cached = enrichCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      res.json(cached.data);
      return;
    }

    try {
      // 1. Resolve token ONCE — App installation first, PAT fallback
      let token: string;
      try {
        token = await resolveGitHubAuth(db, companyId, "project-git:enrich");
      } catch {
        const empty: GitProjectEnrichResponse = { hasGitHubConnection: false, enrichments: [] };
        res.json(empty);
        return;
      }

      const octokit = new Octokit({ auth: token });

      // 2. Resolve repoUrl from project workspace
      const pwRows = await db
        .select({ repoUrl: projectWorkspaces.repoUrl, cwd: projectWorkspaces.cwd })
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.projectId, projectId),
            eq(projectWorkspaces.companyId, companyId),
          ),
        )
        // Primary first, then oldest — matches services/projects.ts election.
        .orderBy(
          desc(projectWorkspaces.isPrimary),
          asc(projectWorkspaces.createdAt),
          asc(projectWorkspaces.id),
        );

      const primaryWs = pwRows.find((r) => r.repoUrl) ?? null;
      if (!primaryWs?.repoUrl) {
        const empty: GitProjectEnrichResponse = { hasGitHubConnection: true, enrichments: [] };
        res.json(empty);
        return;
      }

      let owner: string;
      let repo: string;
      try {
        const parsed = parseGitHubRepoUrl(primaryWs.repoUrl);
        owner = parsed.owner;
        repo = parsed.repo;
      } catch {
        const empty: GitProjectEnrichResponse = { hasGitHubConnection: true, enrichments: [] };
        res.json(empty);
        return;
      }

      // 3. Get branch names from git (fast call)
      let localGitAllowed = false;
      if (primaryWs.cwd) {
        try {
          assertLocalWorkspaceCommandAllowed("project Git enrichment command");
          localGitAllowed = true;
        } catch {
          localGitAllowed = false;
        }
      }
      const gitRoot = primaryWs.cwd && localGitAllowed
        ? await resolveGitRoot(primaryWs.cwd)
        : null;

      const branchNames: string[] = [];
      if (gitRoot) {
        const branches = await getBranches(gitRoot);
        branchNames.push(...branches.filter((b) => b.isLocal).map((b) => b.name));
      }

      if (branchNames.length === 0) {
        const empty: GitProjectEnrichResponse = { hasGitHubConnection: true, enrichments: [] };
        res.json(empty);
        return;
      }

      // 4. Enrich branches with rate limit cap of 5 concurrent Octokit calls
      const limit = pLimit(5);
      const results = await Promise.all(
        branchNames.map((branchName) =>
          limit(async () => {
            const pr = await enrichBranchPr(octokit, owner, repo, branchName).catch(() => null);
            return { branchName, pr };
          }),
        ),
      );

      const response: GitProjectEnrichResponse = {
        hasGitHubConnection: true,
        enrichments: results,
      };

      enrichCache.set(cacheKey, { data: response, expiresAt: Date.now() + ENRICH_CACHE_TTL_MS });
      res.json(response);
    } catch (err) {
      if (err instanceof GitHubPrError) {
        res.status(err.status).json({ error: err.message, hint: err.scopeHint });
        return;
      }
      const message = err instanceof Error ? err.message : "Enrichment error";
      res.status(500).json({ error: message });
    }
  });

  return router;
}
