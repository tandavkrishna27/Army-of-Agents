import type { Db } from "@armyofagents/db";
import { issueComments, issues } from "@armyofagents/db";
import { eq } from "drizzle-orm";
import { formatRunSummary } from "./run-summary.js";
import { logger } from "../middleware/logger.js";
import { parseObject, sanitizeForDb } from "../adapters/utils.js";

export interface PostRunSummaryCommentInput {
  companyId: string;
  issueId: string | null;
  agentName: string;
  /** The agent's runtimeConfig object; autoRunSummary===false opts out. */
  runtimeConfig: Record<string, unknown> | null | undefined;
  outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
  /** Optional run id for the non-fatal warn breadcrumb (ties a silent failure to a run). */
  runId?: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  errorMessage: string | null;
  detectedFiles: Array<{ path: string; type?: string }>;
}

/**
 * Post an auto run-summary comment on a task (issue_comments) + touch issues.updatedAt.
 * Shared by the heartbeat path (ORG agents) and the crew runner (kind='aoa'), so the
 * summary format, the autoRunSummary opt-out, and the comment write live in ONE place.
 * Best-effort: returns {posted:false} on opt-out / missing issueId / any DB error — NEVER throws.
 */
export async function postRunSummaryComment(
  db: Db,
  input: PostRunSummaryCommentInput,
): Promise<{ posted: boolean }> {
  if (!input.issueId) return { posted: false };

  // Opt-out parity with heartbeat: parseObject null-guards non-object configs.
  const runtimeConfig = parseObject(input.runtimeConfig);
  if (runtimeConfig.autoRunSummary === false) return { posted: false };

  const body = formatRunSummary({
    agentName: input.agentName,
    outcome: input.outcome,
    durationMs: input.durationMs,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    costUsd: input.costUsd,
    errorMessage: input.errorMessage,
    detectedFiles: input.detectedFiles,
  });

  try {
    await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      authorAgentId: null,
      authorUserId: null,
      authorType: "system",
      presentation: {
        kind: "system_notice",
        tone: input.outcome === "succeeded" ? "success" : input.outcome === "cancelled" ? "info" : "danger",
        title: "Run summary",
        detailsDefaultOpen: false,
      },
      body: sanitizeForDb(body),
    });
    await db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, input.issueId));
    return { posted: true };
  } catch (err) {
    logger.warn(
      { err, runId: input.runId, issueId: input.issueId },
      "run summary comment creation failed (non-fatal)",
    );
    return { posted: false };
  }
}
