import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { executionWorkspaces, issues } from "@armyofagents/db";
import type { GitHubPrMetadata } from "@armyofagents/shared";
import { emitBranchTaskOutput, emitPullRequestTaskOutput, emitRuntimeServiceTaskOutput } from "./task-output-emitters.js";
import { taskOutputService } from "./task-outputs.js";
import { listCurrentRuntimeServicesForExecutionWorkspaces } from "./workspace-runtime-read-model.js";

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

export function taskOutputBackfillService(db: Db) {
  return {
    backfillIssueIfEmpty: async (companyId: string, issueId: string) => {
      const svc = taskOutputService(db);
      const existing = await svc.listForIssue(companyId, issueId);
      if (existing.length > 0) return existing;

      const issue = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          projectId: issues.projectId,
          artifactId: issues.artifactId,
          title: issues.title,
        })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!issue) return [];

      if (issue.artifactId) {
        await svc.upsertForIssue(companyId, issueId, {
          type: "artifact",
          provider: "aoa",
          externalId: `issue:${issueId}:primary-artifact`,
          artifactId: issue.artifactId,
          title: issue.title ? `${issue.title} artifact` : "Primary artifact",
          status: "active",
          reviewState: "none",
          isPrimary: true,
          healthStatus: "unknown",
        });
      }

      const workspaces = await db
        .select()
        .from(executionWorkspaces)
        .where(and(eq(executionWorkspaces.companyId, companyId), eq(executionWorkspaces.sourceIssueId, issueId)));

      for (const workspace of workspaces) {
        await emitBranchTaskOutput(db, workspace);
        const metadata = (workspace.metadata as Record<string, unknown> | null) ?? null;
        const pr = readGitHubPrMetadata(metadata?.pr);
        if (pr) {
          await emitPullRequestTaskOutput(db, {
            companyId,
            issueId,
            executionWorkspaceId: workspace.id,
            repoUrl: workspace.repoUrl,
            pr,
          });
        }
      }

      const workspaceIds = workspaces.map((workspace) => workspace.id);
      const runtimeServicesByWorkspace = await listCurrentRuntimeServicesForExecutionWorkspaces(
        db,
        companyId,
        workspaceIds,
      );
      for (const runtimeServices of runtimeServicesByWorkspace.values()) {
        for (const runtimeService of runtimeServices) {
          await emitRuntimeServiceTaskOutput(db, runtimeService);
        }
      }

      return svc.listForIssue(companyId, issueId);
    },
  };
}
