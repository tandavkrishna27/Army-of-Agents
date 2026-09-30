// server/src/mcp/distributed-run-currency-resolver.ts
//
// DAT-007 item #1, slice 2 — the DB reader that resolves a signed run id to the
// row snapshot the PURE `classifyRunCurrency` decision (./distributed-run-currency.ts)
// consumes. Kept in its OWN module so the classifier stays drizzle-free and its
// cross-platform Tier-1 unit test never drags drizzle-orm into the vitest ESM cycle
// (the isolation pattern `lease-truth.ts` establishes; see CLAUDE.md Test Patterns).
//
// The query is the `guardActiveFence` join (job-control.ts:1920-1967) with a
// `heartbeat_runs` hop on top: keyed on the SIGNED run id (a PRIMARY KEY probe), it
// LEFT-JOINs the distributed attempt, its offered/active lease, and the lease's
// execution target, computing lease freshness against the DB `clock_timestamp()` in
// SQL. Every hop is a unique-index probe, so the read is bounded and never scans.
//
// FAIL-CLOSED: any thrown DB/exec error propagates. The `/mcp` mount runs this inside
// the route's try/catch (server.ts), so a throw becomes a 500 that DENIES access — the
// reader must NEVER catch-and-return "admit".

import type { Db } from "@armyofagents/db";
import { executionTargets, heartbeatRuns, jobAttempts, leases } from "@armyofagents/db";
import { and, eq, inArray, sql } from "drizzle-orm";

import { classifyRunCurrency, type RunCurrencyVerdict } from "./distributed-run-currency.js";

export interface DistributedRunCurrencyResolver {
  /** Resolve the currency verdict for a distributed run-JWT actor. `signedRunId` is the
   *  SIGNED `run_id` claim (never the header-overridable `req.actor.runId`). */
  resolve(input: {
    signedRunId: string;
    companyId: string;
    agentId: string | null;
  }): Promise<RunCurrencyVerdict>;
}

export function createDistributedRunCurrencyResolver(db: Db): DistributedRunCurrencyResolver {
  return {
    async resolve({ signedRunId, companyId }): Promise<RunCurrencyVerdict> {
      const [row] = await db
        .select({
          runCompanyId: heartbeatRuns.companyId,
          executionOwner: heartbeatRuns.executionOwner,
          attemptStatus: jobAttempts.status,
          leaseStatus: leases.status,
          // Freshness against a FRESH database clock, in SQL — matching renewLease's strict
          // `>` with no grace (job-control.ts:4041-4062). NULL expiry compares NULL → not fresh.
          expiresFresh: sql<boolean>`(${leases.expiresAt} > clock_timestamp())`,
          leaseTargetGeneration: leases.targetGeneration,
          targetDeviceGeneration: executionTargets.deviceGeneration,
          targetStatus: executionTargets.status,
        })
        .from(heartbeatRuns)
        // The distributed attempt — joined ONLY for a run actually handed off to a worker.
        // A local run (execution_owner NULL) or one with no distributed attempt yields a null
        // attempt row, and the classifier admits it on `execution_owner !== "distributed"`.
        .leftJoin(
          jobAttempts,
          and(
            eq(heartbeatRuns.executionOwner, "distributed"),
            eq(jobAttempts.id, heartbeatRuns.distributedAttemptId),
            eq(jobAttempts.companyId, heartbeatRuns.companyId),
          ),
        )
        // The attempt's current offered/active lease (leases_active_per_attempt_idx → ≤1 row).
        .leftJoin(
          leases,
          and(eq(leases.attemptId, jobAttempts.id), inArray(leases.status, ["offered", "active"])),
        )
        // The lease's execution target (for the generation/disabled supersede cutoff).
        .leftJoin(
          executionTargets,
          and(
            eq(executionTargets.targetAuthorityKey, leases.targetAuthorityKey),
            eq(executionTargets.id, leases.targetId),
          ),
        )
        .where(eq(heartbeatRuns.id, signedRunId))
        .limit(1);

      // No run row for this signed run id → not an org distributed run this gate covers.
      if (!row) {
        return classifyRunCurrency(
          {
            runFound: false,
            runCompanyId: null,
            executionOwner: null,
            attemptStatus: null,
            leaseStatus: null,
            expiresFresh: false,
            targetSuperseded: true,
          },
          companyId,
        );
      }

      // The generation-only half of guardActiveFence's target_revoked cutoff, fail-CLOSED:
      // an absent target (left-join miss → null generation), a null lease generation, a
      // generation that moved past the lease's stored one, or a disabled target → superseded.
      const targetSuperseded =
        row.targetDeviceGeneration === null ||
        row.leaseTargetGeneration === null ||
        row.targetDeviceGeneration !== row.leaseTargetGeneration ||
        row.targetStatus === "disabled";

      return classifyRunCurrency(
        {
          runFound: true,
          runCompanyId: row.runCompanyId,
          executionOwner: row.executionOwner,
          attemptStatus: row.attemptStatus,
          leaseStatus: row.leaseStatus,
          expiresFresh: row.expiresFresh === true,
          targetSuperseded,
        },
        companyId,
      );
    },
  };
}
