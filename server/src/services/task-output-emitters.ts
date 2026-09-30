import type { Db } from "@armyofagents/db";
import type { GitHubPrMetadata, TaskOutputStatus } from "@armyofagents/shared";
import { taskOutputService } from "./task-outputs.js";
import { resolveSandboxPreviewUrl, type SandboxFileMovementRunner } from "./sandbox-file-movement.js";

type PullRequestInput = {
  companyId: string;
  issueId: string | null | undefined;
  executionWorkspaceId: string | null;
  repoUrl: string | null;
  pr: GitHubPrMetadata;
};

type RuntimeServiceInput = {
  id: string;
  companyId: string;
  projectId?: string | null;
  issueId?: string | null;
  executionWorkspaceId?: string | null;
  serviceName: string;
  provider: string;
  status: string;
  healthStatus?: string | null;
  url?: string | null;
  port?: number | null;
  lifecycle?: string | null;
  scopeType?: string | null;
  providerRef?: string | null;
  startedByRunId?: string | null;
  ownerAgentId?: string | null;
};

type SandboxPreviewInput = {
  companyId: string;
  issueId: string | null | undefined;
  executionWorkspaceId?: string | null;
  runner: SandboxFileMovementRunner;
  port: number;
  createdByRunId?: string | null;
  createdByAgentId?: string | null;
};

type BranchWorkspaceInput = {
  id: string;
  companyId: string;
  projectId?: string | null;
  sourceIssueId?: string | null;
  providerType: string;
  branchName?: string | null;
  repoUrl?: string | null;
  baseRef?: string | null;
  strategyType: string;
  status: string;
};

export function prTaskOutputStatus(state: GitHubPrMetadata["state"]): TaskOutputStatus {
  if (state === "merged") return "merged";
  if (state === "closed") return "closed";
  return "active";
}

function runtimeTaskOutputStatus(status: string): TaskOutputStatus {
  if (status === "running" || status === "starting") return "running";
  if (status === "failed") return "failed";
  return "stopped";
}

export async function emitPullRequestTaskOutput(db: Db, input: PullRequestInput) {
  if (!input.issueId) return null;
  try {
    return await taskOutputService(db).upsertForIssue(input.companyId, input.issueId, {
      type: "pull_request",
      provider: "github",
      externalId: input.repoUrl
        ? `${input.repoUrl}#${input.pr.number}`
        : `github-pr:${input.pr.url}`,
      executionWorkspaceId: input.executionWorkspaceId,
      url: input.pr.url,
      title: `PR #${input.pr.number}`,
      status: prTaskOutputStatus(input.pr.state),
      reviewState: input.pr.draft ? "needs_review" : "none",
      isPrimary: false,
      healthStatus: "unknown",
      metadata: input.pr as unknown as Record<string, unknown>,
    });
  } catch {
    return null;
  }
}

export async function emitRuntimeServiceTaskOutput(db: Db, row: RuntimeServiceInput) {
  if (!row.issueId) return null;
  try {
    const active = row.status === "running" || row.status === "starting";
    return await taskOutputService(db).upsertForIssue(row.companyId, row.issueId, {
      type: active && row.url ? "preview_url" : "runtime_service",
      provider: row.provider,
      externalId: `runtime-service:${row.id}`,
      executionWorkspaceId: row.executionWorkspaceId ?? null,
      runtimeServiceId: row.id,
      url: active ? row.url ?? null : null,
      title: row.serviceName,
      status: runtimeTaskOutputStatus(row.status),
      reviewState: "none",
      isPrimary: false,
      healthStatus: row.healthStatus ?? "unknown",
      metadata: {
        port: row.port ?? null,
        lifecycle: row.lifecycle ?? null,
        scopeType: row.scopeType ?? null,
        providerRef: row.providerRef ?? null,
      },
      createdByRunId: row.startedByRunId ?? null,
      createdByAgentId: row.ownerAgentId ?? null,
    });
  } catch {
    return null;
  }
}

/**
 * U6.6 — expose an in-VM dev server as a `preview_url` task_output via the
 * provider's `getHost(port)` mapping (`resolveSandboxPreviewUrl`,
 * sandbox-file-movement.ts). Unlike `emitRuntimeServiceTaskOutput` above
 * (host-loopback `url`, the existing desktop/local runtime-service path,
 * left unchanged), this NEVER touches a host-reachable URL —
 * `resolveSandboxPreviewUrl` derives the URL solely from
 * `runner.resolveHost`.
 *
 * Best-effort like every other emitter here: returns `null` on any failure
 * (missing `resolveHost`, an unresolvable host, a DB error) instead of
 * throwing, so a caller can call this from a run's hot path without risking
 * the run's outcome.
 */
export async function emitSandboxPreviewTaskOutput(db: Db, input: SandboxPreviewInput) {
  if (!input.issueId) return null;
  try {
    const url = await resolveSandboxPreviewUrl({ runner: input.runner, port: input.port });
    return await taskOutputService(db).upsertForIssue(input.companyId, input.issueId, {
      type: "preview_url",
      provider: "aoa",
      externalId: `sandbox-preview:${input.port}`,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      url,
      title: "Preview",
      status: "active",
      reviewState: "none",
      isPrimary: false,
      healthStatus: "unknown",
      createdByRunId: input.createdByRunId ?? null,
      createdByAgentId: input.createdByAgentId ?? null,
      metadata: { port: input.port },
    });
  } catch {
    return null;
  }
}

export async function emitBranchTaskOutput(db: Db, workspace: BranchWorkspaceInput) {
  if (!workspace.sourceIssueId || !workspace.branchName) return null;
  try {
    return await taskOutputService(db).upsertForIssue(workspace.companyId, workspace.sourceIssueId, {
      type: "branch",
      provider: workspace.providerType,
      externalId: `workspace:${workspace.id}:branch:${workspace.branchName}`,
      executionWorkspaceId: workspace.id,
      url: workspace.repoUrl ?? null,
      title: workspace.branchName,
      status: workspace.status === "archived" ? "closed" : "active",
      reviewState: "none",
      isPrimary: false,
      healthStatus: "unknown",
      metadata: {
        repoUrl: workspace.repoUrl ?? null,
        baseRef: workspace.baseRef ?? null,
        strategyType: workspace.strategyType,
      },
    });
  } catch {
    return null;
  }
}
