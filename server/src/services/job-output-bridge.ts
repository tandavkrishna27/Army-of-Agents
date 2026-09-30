// server/src/services/job-output-bridge.ts
//
// JOB-014 — Preserve task outputs and run summaries (parity bridge).
//
// An ACCEPTED artifact/result event AND the terminal WINNER of a distributed attempt must
// project into the EXISTING task-output, review/primary, run-summary, and task-terminal
// contracts EXACTLY ONCE. The projection is TWO independent mutations with independent
// idempotency, so this bridge has TWO entrypoints and TWO JOB-005 receipt kinds:
//
//   * projectAcceptedOutput → writes ONE `task_outputs` row (the EXISTING output projection)
//     + an `output_projection` receipt in ONE tenant tx. The attempt stays RUNNING (an
//     output event is not a terminal event). Replay is guarded by the receipt fast-path.
//   * projectTerminalWinner → the terminal-winner-once guard: `completeAttempt` + (optional)
//     ONE run-summary `issue_comments` row + a `task_terminal` receipt in ONE tenant tx.
//
// THE load-bearing correctness (projectTerminalWinner): the receipt fast-path runs FIRST,
// BEFORE completeAttempt. `completeAttempt` makes the attempt terminal, so a legitimate
// winner-RETRY can no longer pass the active-fence guard (it throws `attempt_terminal`) —
// the `task_terminal` receipt is therefore the replay guard, not the fence. `completeAttempt`
// is wrapped in a catch-to-replay latch: an `attempt_terminal` throw re-reads the receipt —
// present ⇒ a concurrent winner committed (replay); absent ⇒ a GENUINE LOSER (rethrow — a
// loser cannot change terminal state). Any other fence error (stale_fence/target_revoked)
// rethrows, writing nothing.
//
// Structural invariants:
//   * `issueId` is a CALLER-SUPPLIED `string | null`, NEVER derived. This is the mechanical
//     "no fabricated task IDs" guarantee — the bridge cannot invent an issue for a source
//     (commander/one-shot/browser/service) that has none. A null issue writes no task_output
//     and no comment (still replay-guards the winner via a `job_attempts` receipt).
//   * The bridge NEVER elects primary: every output write forces `isPrimary: false`, so a
//     stale/losing output can never demote an existing primary or become one. `reviewState`
//     is caller-supplied (default `"none"`). The review/primary contract is untouched.
//   * The bridge NEVER calls `authorizeArtifactCommit` — an ordinary fenced artifact commit
//     (`job_artifacts`) stays DISTINCT from an accepted output projection (`task_outputs`).
//   * A stale/losing output supplies a `quarantine` block → `metadata.quarantined` only;
//     it never touches terminal/summary state.
//
// Flag gate: when distributed execution is OFF, every entrypoint refuses fail-closed and
// touches NOTHING, so every current task-output/comment path stays byte-for-byte unchanged.
// The rollback gate (`assertRollbackSafe`) fails closed while an `output_projection` or
// `task_terminal` receipt is pending.

import { randomUUID, createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { jobProjectionReceipts } from "@armyofagents/db";
import { JobFenceError } from "@armyofagents/db";
import type {
  ActiveFenceRequest,
  Db,
  TerminalCompletionStatus,
} from "@armyofagents/db";
import type { SubmitJobSource, UpsertTaskOutput } from "@armyofagents/shared";
import { runInTenant } from "../db/tenant-context.js";
import { drainFenceGuardDenial } from "./fence-denial-audit.js";
import { logger } from "../middleware/logger.js";
import { readDistributedExecutionDeploymentFlag } from "../config/distributed-execution.js";
import { resolveCompanyOrganizationId } from "./org-concurrency.js";
import { assertAdmissibleMappedOrganization } from "./tenant-admission.js";
import { upsertTaskOutputForIssue } from "./task-outputs.js";
import { insertRunSummaryComment } from "./run-summary-comment.js";
import { formatRunSummary } from "./run-summary.js";
import { parseObject } from "../adapters/utils.js";
import type { BridgeActor } from "./job-audit-bridge.js";

export type { BridgeActor } from "./job-audit-bridge.js";

/** The caller-owned task-output content for an accepted output event. Maps to the EXISTING
 * `UpsertTaskOutput` contract, MINUS `isPrimary` (the bridge always forces it false). */
export interface BridgeOutputInput {
  type: UpsertTaskOutput["type"];
  provider?: string;
  externalId?: string | null;
  title: string;
  url?: string | null;
  status?: UpsertTaskOutput["status"];
  reviewState?: UpsertTaskOutput["reviewState"];
  healthStatus?: string;
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
  createdByRunId?: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  artifactId?: string | null;
  artifactVersionId?: string | null;
  assetId?: string | null;
  executionWorkspaceId?: string | null;
  runtimeServiceId?: string | null;
}

export interface ProjectAcceptedOutputInput {
  /** Typed, server-owned provenance of the accepted output event. */
  source: SubmitJobSource;
  actor: BridgeActor;
  /** The LIVE distributed attempt to bind the output to (composite FK + fence). Still
   * RUNNING — an output event is not a terminal event. */
  fence: ActiveFenceRequest;
  /** The accepted-output-event id — the stable per-event receipt source identity. */
  acceptedEventId: string;
  /** The accepted event's digest (64-hex reused, else sha256-normalized). */
  eventDigest: string;
  /** CALLER-SUPPLIED. `null` for a source with no task (commander/one-shot/browser/service)
   * → the bridge writes NOTHING (no fabricated task IDs). NEVER derived by the bridge. */
  issueId: string | null;
  output: BridgeOutputInput;
  /** Present for a stale/losing output → `metadata.quarantined` only; never primary/terminal. */
  quarantine?: { reason: string };
}

export interface ProjectAcceptedOutputOutcome {
  status: "recorded" | "replayed" | "skipped";
  outputId: string | null;
}

/** The run-summary inputs (present iff `issueId != null`). Mirrors the shared run-summary
 * shape; the bridge does the `autoRunSummary` opt-out check itself. */
export interface TerminalSummaryInput {
  agentName: string;
  runtimeConfig: Record<string, unknown> | null | undefined;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  errorMessage: string | null;
  detectedFiles: Array<{ path: string; type?: string }>;
}

export interface ProjectTerminalWinnerInput {
  source: SubmitJobSource;
  actor: BridgeActor;
  fence: ActiveFenceRequest;
  /** The terminal-event id — the stable per-event `task_terminal` receipt source identity. */
  terminalEventId: string;
  eventDigest: string;
  /** Drives the ATTEMPT terminal via `completeAttempt` (JOB-004 set). Caller-owned mapping —
   * the bridge NEVER guesses (e.g. dead_letter → the caller passes `failed`). */
  attemptTerminalStatus: TerminalCompletionStatus;
  /** The run-summary outcome label (caller-mapped: e.g. expired → timed_out). */
  summaryOutcome: "succeeded" | "failed" | "cancelled" | "timed_out";
  /** CALLER-SUPPLIED. `null` (or `autoRunSummary===false`) → skip the comment but STILL write
   * the `task_terminal` receipt (job_attempts) so the winner is replay-guarded. */
  issueId: string | null;
  /** Present iff `issueId != null`. */
  summary?: TerminalSummaryInput;
}

export interface ProjectTerminalWinnerOutcome {
  status: "recorded" | "replayed";
  /** True only when THIS call drove `completeAttempt` (a fresh winner). */
  attemptTerminated: boolean;
  /** The run-summary comment id when one was posted, else null. */
  commentId: string | null;
}

/** Thrown when any bridge entrypoint is called while distributed execution is off.
 * Fail-closed: the bridge does nothing, so the legacy output/summary path is untouched. */
export class JobOutputBridgeDisabledError extends Error {
  readonly code = "JOB_OUTPUT_BRIDGE_DISABLED";
  constructor() {
    super("Job output bridge is disabled while distributed execution is off");
    this.name = "JobOutputBridgeDisabledError";
  }
}

/** Thrown by the rollback gate while an `output_projection` or `task_terminal` receipt is
 * still pending — disabling the bridge must never lose or skip an in-flight projection. */
export class JobOutputBridgeRollbackPendingError extends Error {
  readonly code = "JOB_OUTPUT_BRIDGE_ROLLBACK_PENDING";
  constructor() {
    super("Cannot disable the output bridge while an output/terminal receipt is pending");
    this.name = "JobOutputBridgeRollbackPendingError";
  }
}

export interface JobOutputBridge {
  isEnabled(): boolean;
  projectAcceptedOutput(input: ProjectAcceptedOutputInput): Promise<ProjectAcceptedOutputOutcome>;
  projectTerminalWinner(input: ProjectTerminalWinnerInput): Promise<ProjectTerminalWinnerOutcome>;
  assertRollbackSafe(companyId: string): Promise<void>;
}

const OUTPUT_PROJECTION_KIND = "output_projection" as const;
const TASK_TERMINAL_KIND = "task_terminal" as const;

/** The output-projection receipt source identity — keyed on the accepted output event id. */
function outputSourceIdentity(companyId: string, acceptedEventId: string): string {
  return `output:${companyId}:${acceptedEventId}`;
}

/** The terminal-winner receipt source identity — keyed on the terminal event id. It is the
 * replay guard consulted BEFORE completeAttempt (which makes the fence un-passable). */
function terminalSourceIdentity(companyId: string, terminalEventId: string): string {
  return `task_terminal:${companyId}:${terminalEventId}`;
}

/** Normalize the caller's event digest to the 64-hex the receipt CHECK requires. */
function normalizeDigest(eventDigest: string): string {
  return /^[0-9a-f]{64}$/.test(eventDigest)
    ? eventDigest
    : createHash("sha256").update(eventDigest).digest("hex");
}

/** Read a projection receipt for this identity (the replay fast-path). */
async function findReceipt(
  tx: Db,
  organizationId: string,
  companyId: string,
  projectionKind: string,
  sourceIdentity: string,
): Promise<{ id: string; targetAggregateId: string; status: string; aggregateKind: string | null } | null> {
  const [row] = await tx
    .select({
      id: jobProjectionReceipts.id,
      targetAggregateId: jobProjectionReceipts.targetAggregateId,
      status: jobProjectionReceipts.status,
      aggregateKind: jobProjectionReceipts.aggregateKind,
    })
    .from(jobProjectionReceipts)
    .where(and(
      eq(jobProjectionReceipts.organizationId, organizationId),
      eq(jobProjectionReceipts.companyId, companyId),
      eq(jobProjectionReceipts.projectionKind, projectionKind),
      eq(jobProjectionReceipts.sourceIdentity, sourceIdentity),
    ))
    .limit(1);
  return row ?? null;
}

export function jobOutputBridge(
  appDb: Db,
  options?: { env?: Record<string, string | undefined> },
): JobOutputBridge {
  const env = options?.env ?? process.env;

  function assertEnabled(): void {
    if (!readDistributedExecutionDeploymentFlag(env)) {
      throw new JobOutputBridgeDisabledError();
    }
  }

  async function resolveAdmissibleOrganization(companyId: string): Promise<string> {
    const organizationId = await resolveCompanyOrganizationId(appDb, companyId);
    assertAdmissibleMappedOrganization(organizationId);
    return organizationId as string;
  }

  return {
    isEnabled(): boolean {
      return readDistributedExecutionDeploymentFlag(env);
    },

    async projectAcceptedOutput(input) {
      assertEnabled();
      // NO fabricated task IDs: a source with no task writes nothing at all.
      if (input.issueId === null) {
        return { status: "skipped", outputId: null };
      }
      const issueId = input.issueId;
      const companyId = input.actor.companyId;
      const organizationId = await resolveAdmissibleOrganization(companyId);

      return runInTenant(appDb, organizationId, async (repos, tx) => {
        // (a) TOCTOU lock — the attempt is still RUNNING for an output event; a
        // stale/terminal/old-generation fence throws here → nothing written.
        await repos.jobControl.lockActiveFence(input.fence);

        // (b) RECEIPT FAST-PATH — a replay returns the already-linked task_outputs row
        // WITHOUT a second upsert.
        const sourceIdentity = outputSourceIdentity(companyId, input.acceptedEventId);
        const existing = await findReceipt(tx, organizationId, companyId, OUTPUT_PROJECTION_KIND, sourceIdentity);
        if (existing) {
          return { status: "replayed" as const, outputId: existing.targetAggregateId };
        }

        // (c) Build the UpsertTaskOutput. isPrimary is ALWAYS false (never elect primary);
        // a quarantine block records `metadata.quarantined` only.
        const baseMetadata = input.output.metadata ?? null;
        const metadata = input.quarantine
          ? { ...(baseMetadata ?? {}), quarantined: true, quarantineReason: input.quarantine.reason }
          : baseMetadata;
        const upsert: UpsertTaskOutput = {
          type: input.output.type,
          provider: input.output.provider ?? "aoa",
          externalId: input.output.externalId ?? null,
          title: input.output.title,
          url: input.output.url ?? null,
          status: input.output.status ?? "active",
          reviewState: input.output.reviewState ?? "none",
          isPrimary: false,
          healthStatus: input.output.healthStatus ?? "unknown",
          summary: input.output.summary ?? null,
          metadata,
          createdByRunId: input.output.createdByRunId ?? null,
          createdByAgentId: input.output.createdByAgentId ?? null,
          createdByUserId: input.output.createdByUserId ?? null,
          artifactId: input.output.artifactId ?? null,
          artifactVersionId: input.output.artifactVersionId ?? null,
          assetId: input.output.assetId ?? null,
          executionWorkspaceId: input.output.executionWorkspaceId ?? null,
          runtimeServiceId: input.output.runtimeServiceId ?? null,
        };

        // (d) MUTATION — the EXISTING task-output write, callback-local on the tenant tx
        // (no nested transaction). Throws (e.g. bad ref) roll back the whole tx.
        const output = await upsertTaskOutputForIssue(tx as Db, companyId, issueId, upsert);

        // (e) RECEIPT applied in the SAME tenant tx, fence-guarded, linking the output row.
        await repos.jobControl.recordGovernedProjection({
          ...input.fence,
          projection: {
            projectionKind: OUTPUT_PROJECTION_KIND,
            aggregateKind: "task_outputs",
            sourceIdentity,
            sourceDigest: normalizeDigest(input.eventDigest),
            targetAggregateId: output.id,
            status: "applied",
          },
        });

        return { status: "recorded" as const, outputId: output.id };
      });
    },

    async projectTerminalWinner(input) {
      assertEnabled();
      const companyId = input.actor.companyId;
      const organizationId = await resolveAdmissibleOrganization(companyId);
      const sourceIdentity = terminalSourceIdentity(companyId, input.terminalEventId);

      return runInTenant(appDb, organizationId, async (repos, tx) => {
        // (a) RECEIPT FAST-PATH FIRST — BEFORE any fence guard / completeAttempt. Once the
        // attempt is terminal, a winner-retry can no longer pass guardActiveFence, so the
        // receipt (not the fence) is the winner's replay guard.
        const replay = async (r: { targetAggregateId: string; aggregateKind: string | null }) =>
          ({
            status: "replayed" as const,
            attemptTerminated: false,
            commentId: r.aggregateKind === "issue_comments" ? r.targetAggregateId : null,
          });
        const existing = await findReceipt(tx, organizationId, companyId, TASK_TERMINAL_KIND, sourceIdentity);
        if (existing) return replay(existing);

        // (b) WINNER LATCH with catch-to-replay. completeAttempt guardActiveFence-locks the
        // attempt, then conditionally flips it terminal (JOB-007 releases the capacity slot).
        try {
          await repos.jobControl.completeAttempt({ ...input.fence, terminalStatus: input.attemptTerminalStatus });
        } catch (e) {
          if (e instanceof JobFenceError && e.code === "attempt_terminal") {
            // The attempt is already terminal. Re-read the receipt: present ⇒ a concurrent
            // winner committed (replay); absent ⇒ a GENUINE LOSER (a loser cannot change
            // terminal state → rethrow).
            const r = await findReceipt(tx, organizationId, companyId, TASK_TERMINAL_KIND, sourceIdentity);
            if (r) return replay(r);
            throw e;
          }
          throw e; // stale_fence / target_revoked → nothing written
        }

        // (c) SUMMARY + RECEIPT in the SAME tx. We are now the confirmed winner (completeAttempt
        // succeeded), so the attempt is TERMINAL — the active-fence guard would now REJECT any
        // governed mutator. The `task_terminal` receipt is therefore inserted DIRECTLY (NOT via
        // recordGovernedProjection, whose guardActiveFence would throw attempt_terminal against
        // the now-terminal attempt we just completed): the fence was already validated by
        // completeAttempt, and the receipt's composite FK still enforces tenant integrity.
        // Post the comment only for a real task whose agent has not opted out; otherwise skip
        // the comment but STILL replay-guard the winner via a job_attempts receipt.
        const optedOut =
          input.summary != null && parseObject(input.summary.runtimeConfig).autoRunSummary === false;
        const shouldPost = input.issueId !== null && input.summary != null && !optedOut;

        let commentId: string | null = null;
        if (shouldPost) {
          const id = randomUUID();
          const body = formatRunSummary({
            agentName: input.summary!.agentName,
            outcome: input.summaryOutcome,
            durationMs: input.summary!.durationMs,
            inputTokens: input.summary!.inputTokens,
            outputTokens: input.summary!.outputTokens,
            costUsd: input.summary!.costUsd,
            errorMessage: input.summary!.errorMessage,
            detectedFiles: input.summary!.detectedFiles,
          });
          // The summary comment is OPTIONAL and best-effort: isolate it in a SAVEPOINT so
          // a failure (e.g. the task was hard-deleted mid-run → issue_comments.issue_id FK
          // violation, which would otherwise poison the whole tenant tx) rolls back ONLY the
          // comment, never the MANDATORY completeAttempt above. A failed comment falls back
          // to the job_attempts receipt below — the winner is still recorded + replay-guarded
          // — mirroring the legacy best-effort postRunSummaryComment. (`tx.transaction` on a
          // postgres-js tx handle opens a SAVEPOINT within the same tenant GUC context.)
          try {
            await tx.transaction(async (sp) => {
              await insertRunSummaryComment(sp as unknown as Db, {
                id,
                companyId,
                issueId: input.issueId!,
                outcome: input.summaryOutcome,
                body,
              });
            });
            commentId = id;
          } catch (err) {
            logger.warn(
              { err, issueId: input.issueId, attemptId: input.fence.attemptId },
              "JOB-014: run summary comment insert failed; recording terminal winner without a summary",
            );
          }
        }

        // The receipt links the comment when one was posted, else the attempt itself (the
        // winner is always replay-guarded). onConflictDoNothing is pure defense — the sole
        // winner is serialized by completeAttempt's FOR UPDATE lock, so only one call reaches
        // this insert per terminal event.
        await tx.insert(jobProjectionReceipts).values({
          organizationId,
          companyId,
          projectionKind: TASK_TERMINAL_KIND,
          sourceIdentity,
          sourceDigest: normalizeDigest(input.eventDigest),
          jobId: input.fence.jobId,
          attemptId: input.fence.attemptId,
          sourceFence: input.fence.fence,
          status: "applied",
          targetAggregateId: commentId != null ? commentId : input.fence.attemptId,
          aggregateKind: commentId != null ? "issue_comments" : "job_attempts",
          appliedAt: sql`clock_timestamp()`,
          createdAt: sql`clock_timestamp()`,
        }).onConflictDoNothing({
          target: [
            jobProjectionReceipts.organizationId,
            jobProjectionReceipts.companyId,
            jobProjectionReceipts.projectionKind,
            jobProjectionReceipts.sourceIdentity,
          ],
        });

        return { status: "recorded" as const, attemptTerminated: true, commentId };
      })
        // ★ DE-04 / DE-18 — completeAttempt's guardActiveFence rethrows the ORIGINAL
        // `JobFenceError` (a genuine loser's attempt_terminal, or a stale_fence /
        // target_revoked worker), so it reaches this pool-handle drain after the tenant
        // transaction has unwound. The benign winner-replay above RETURNS rather than
        // throwing, so it is never recorded; non-fence rejections pass through unrecorded.
        // `input.fence` is the identity the mutator was handed. Never alters the outcome.
        .catch(async (err: unknown) => {
          await drainFenceGuardDenial(appDb, input.fence, err, {
            control: "server/src/services/job-output-bridge.ts:completeAttempt",
            operation: "attempt_complete",
          });
          throw err;
        });
    },

    async assertRollbackSafe(companyId) {
      // Deliberately NOT flag-gated: consulted DURING the disable transition (the flag may
      // already be off). Fails closed while EITHER projection kind has a pending receipt so
      // an accepted output/terminal event can never be lost.
      const organizationId = await resolveAdmissibleOrganization(companyId);
      await runInTenant(appDb, organizationId, async (_repos, tx) => {
        const [row] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(jobProjectionReceipts)
          .where(and(
            eq(jobProjectionReceipts.organizationId, organizationId),
            eq(jobProjectionReceipts.companyId, companyId),
            inArray(jobProjectionReceipts.projectionKind, [OUTPUT_PROJECTION_KIND, TASK_TERMINAL_KIND]),
            eq(jobProjectionReceipts.status, "pending"),
          ));
        if ((row?.n ?? 0) > 0) throw new JobOutputBridgeRollbackPendingError();
      });
    },
  };
}
