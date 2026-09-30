// MIG-009 — the flag-disable drain, proven at embedded Postgres (Linux CI is the formal
// authority, SKIPPED locally on Windows unless AOA_RUN_WIN_INTEGRATION=1).
//
// Two things this ticket fixes, proven against real SQL / a real bridge:
//   * Step 4 — the missing `listActiveAttempts` store returns exactly the non-terminal
//     attempts for an org, deduped by job, shaped {organizationId, companyId, jobId}.
//   * Step 5 — grain + SQL end-to-end: with the REAL per-Company budget-cost bridge
//     `assertRollbackSafe`, a pending authoritative-cost receipt on ANY Company under the
//     org (including a SIBLING of an attempt's own Company) skips the WHOLE org and
//     cancels nothing; clearing the receipt lets the SAME org drain its non-terminal
//     attempts (the positive control that reddens the M-grain revert — an org-keyed gate
//     throws at Company->Org resolution against the real bridge, so the clean org would
//     stop draining); a terminal-only org drains zero and reports a clean sweep, not an error.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setupJobControlFixture,
  COMPANY,
  ORG,
  type JobControlFixture,
} from "./helpers/job-control-fixture.js";
import { createDistributedExecutionDrainStore } from "../services/job-distributed-drain-store.js";
import { createDistributedExecutionDrain } from "../services/job-distributed-drain.js";
import { jobBudgetCostBridge } from "../services/job-budget-cost-bridge.js";

const ENABLED_ENV = { AOA_DISTRIBUTED_EXECUTION_ENABLED: "true" } as const;
// A SECOND Company under the same Organization — the whole point of the per-Company grain.
const COMPANY_B = "a6000000-0000-4000-8000-0000000000b2";

let fixture: JobControlFixture | null = null;
let setupError: unknown = null;

function guard(): void {
  if (setupError) throw new Error(`fixture setup failed: ${String(setupError)}`);
  if (!fixture) throw new Error("fixture not initialised");
}

/** Seed a minimal job + one attempt (all-NULL placement satisfies placement_atomic) with
 * the given attempt status, under (ORG, company). Returns the ids. */
async function seedAttempt(
  company: string,
  status: string,
  attemptNumber = 1,
  jobId: string = randomUUID(),
): Promise<{ jobId: string; attemptId: string }> {
  const attemptId = randomUUID();
  await fixture!.admin`INSERT INTO jobs (id, organization_id, company_id)
    VALUES (${jobId}, ${ORG}, ${company})
    ON CONFLICT (id) DO NOTHING`;
  await fixture!.admin`INSERT INTO job_attempts
      (id, organization_id, company_id, job_id, attempt_number, status)
    VALUES (${attemptId}, ${ORG}, ${company}, ${jobId}, ${attemptNumber}, ${status})`;
  return { jobId, attemptId };
}

/** Seed a PENDING authoritative-cost receipt bound to a real seeded attempt of `company`. */
async function seedPendingReceipt(company: string, seeded: { jobId: string; attemptId: string }): Promise<void> {
  await fixture!.admin`INSERT INTO job_projection_receipts
      (organization_id, company_id, projection_kind, source_identity, source_digest,
       job_id, attempt_id, source_fence, status, target_aggregate_id)
    VALUES (${ORG}, ${company}, 'authoritative_cost', ${randomUUID()}, ${"a".repeat(64)},
      ${seeded.jobId}, ${seeded.attemptId}, 'fence', 'pending', ${seeded.jobId})`;
}

function makeDrain(requestCancellation: ReturnType<typeof vi.fn>) {
  const store = createDistributedExecutionDrainStore(fixture!.app.db, fixture!.operator.db);
  const bridge = jobBudgetCostBridge(fixture!.app.db, { env: ENABLED_ENV });
  return createDistributedExecutionDrain({
    listAdmittedOrganizationIds: async ({ afterOrganizationId }) =>
      afterOrganizationId === null ? [ORG] : [],
    listOrganizationCompanyIds: (organizationId) => store.listOrganizationCompanyIds(organizationId),
    listActiveAttempts: (organizationId) => store.listActiveAttempts(organizationId),
    requestCancellation,
    // THE REAL per-Company bridge gate.
    assertRollbackSafe: (companyId) => bridge.assertRollbackSafe(companyId),
  });
}

beforeAll(async () => {
  try {
    fixture = await setupJobControlFixture("mig009-drain");
    // A sibling Company under the same Organization.
    await fixture.admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
      VALUES (${COMPANY_B}, ${ORG}, 'MIG-009 sibling', 'M9B')`;
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  await fixture?.teardown().catch(() => {});
}, 60_000);

beforeEach(async () => {
  if (!fixture) return;
  await fixture.resetRuntimeRows();
});

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "MIG-009 distributed-execution drain (embedded PG)",
  () => {
    it("[Step 4] listActiveAttempts returns exactly the non-terminal attempts, deduped by job, {org,company,job}", async () => {
      guard();
      const store = createDistributedExecutionDrainStore(fixture!.app.db, fixture!.operator.db);

      const co1NonTerminal = await seedAttempt(COMPANY, "running");
      await seedAttempt(COMPANY, "succeeded"); // terminal → excluded
      const coBNonTerminal = await seedAttempt(COMPANY_B, "leased");
      await seedAttempt(COMPANY_B, "cancelled"); // terminal → excluded
      // A job with TWO simultaneously non-terminal attempts → deduped to ONE row.
      const dupJob = await seedAttempt(COMPANY, "running", 1);
      await seedAttempt(COMPANY, "pending", 2, dupJob.jobId);

      const rows = await store.listActiveAttempts(ORG);

      // Exactly three distinct jobs; the terminal attempts are excluded; the dup job once.
      expect(rows).toHaveLength(3);
      const jobIds = new Set(rows.map((r) => r.jobId));
      expect(jobIds).toEqual(new Set([co1NonTerminal.jobId, coBNonTerminal.jobId, dupJob.jobId]));
      for (const row of rows) {
        expect(row.organizationId).toBe(ORG);
        expect([COMPANY, COMPANY_B]).toContain(row.companyId);
        expect(typeof row.jobId).toBe("string");
      }
    });

    it("[Step 4] returns an empty list for an org whose attempts are ALL terminal", async () => {
      guard();
      const store = createDistributedExecutionDrainStore(fixture!.app.db, fixture!.operator.db);
      await seedAttempt(COMPANY, "succeeded");
      await seedAttempt(COMPANY_B, "expired");
      expect(await store.listActiveAttempts(ORG)).toEqual([]);
    });

    it("[Step 5 / E1] a pending receipt on a SIBLING Company skips the WHOLE org — cancels nothing", async () => {
      guard();
      // Non-terminal attempts in BOTH companies.
      await seedAttempt(COMPANY, "running");
      const siblingAttempt = await seedAttempt(COMPANY_B, "leased");
      // The pending authoritative-cost receipt is on the SIBLING Company only.
      await seedPendingReceipt(COMPANY_B, siblingAttempt);

      const requestCancellation = vi.fn(async () => ({ status: "queued" as const, command: null }));
      const result = await makeDrain(requestCancellation).drainAll();

      // The real per-Company bridge threw for COMPANY_B → whole org skipped, nothing cancelled.
      expect(requestCancellation).not.toHaveBeenCalled();
      expect(result.cancelled).toBe(0);
      expect(result.skippedOrganizations).toEqual([ORG]);
      expect(result.perOrganization).toContainEqual({
        organizationId: ORG,
        skipped: true,
        reason: "rollback_pending",
        cancelled: 0,
      });
    });

    it("[Step 5 / positive control] with NO pending receipt the SAME org drains its non-terminal attempts", async () => {
      guard();
      // Two non-terminal attempts across both Companies, NO pending receipt anywhere.
      await seedAttempt(COMPANY, "running");
      await seedAttempt(COMPANY_B, "leased");

      const requestCancellation = vi.fn(async () => ({ status: "queued" as const, command: null }));
      const result = await makeDrain(requestCancellation).drainAll();

      // The clean org drains BOTH attempts. (M-grain — reverting to a single per-org
      // assertRollbackSafe(organizationId) — reddens HERE: against the real bridge an org
      // id resolves no Company->Org edge and throws, so this clean org would cancel 0.)
      expect(requestCancellation).toHaveBeenCalledTimes(2);
      expect(result.cancelled).toBe(2);
      expect(result.skippedOrganizations).toEqual([]);
    });

    it("[Step 5] a terminal-only org drains zero and reports a clean sweep (not an error, not skipped)", async () => {
      guard();
      await seedAttempt(COMPANY, "succeeded");
      await seedAttempt(COMPANY_B, "cancelled");

      const requestCancellation = vi.fn(async () => ({ status: "queued" as const, command: null }));
      const result = await makeDrain(requestCancellation).drainAll();

      expect(requestCancellation).not.toHaveBeenCalled();
      expect(result.cancelled).toBe(0);
      expect(result.skippedOrganizations).toEqual([]);
      expect(result.perOrganization).toContainEqual({
        organizationId: ORG,
        skipped: false,
        cancelled: 0,
      });
    });
  },
);
