// server/src/__tests__/job-submit-capacity-admission.integration.test.ts
//
// DEP-009 — submit-time Organization-capacity admission wired into submitJobWithinTenant,
// against real embedded Postgres under the aoa_app RLS role. Proves the SUBMIT SEAM (not
// the offer): the first attempt claims an Organization slot inside the same tenant
// transaction, so an over-cap submit is rejected BEFORE the job is leasable; the claim is
// idempotent on a redelivered submission; concurrent submits are serialized by the shared
// advisory lock so the cap is never exceeded across replicas; and releasing the slot frees
// capacity for a subsequent submit.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";
import { submitJobWithinTenant } from "../services/job-submission.js";
import { releaseAttemptCapacity } from "../services/org-concurrency.js";
import { runInTenant } from "../db/tenant-context.js";
import { ORG, COMPANY, setupJobControlFixture, type JobControlFixture } from "./helpers/job-control-fixture.js";

const integration = describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
);

integration("DEP-009 submit-time org-capacity admission", () => {
  let fx: JobControlFixture | null = null;
  let setupError: unknown = null;
  let priorFlag: string | undefined;

  function ctx(): JobControlFixture {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    if (!fx) throw new Error("fixture not initialized");
    return fx;
  }

  async function setCap(cap: number | null): Promise<void> {
    await ctx().admin`UPDATE organizations SET concurrency_cap = ${cap} WHERE id = ${ORG}`;
  }

  async function clearJobs(): Promise<void> {
    const { admin } = ctx();
    await admin`DELETE FROM job_outbox`;
    await admin`DELETE FROM job_attempts`;
    await admin`DELETE FROM jobs`;
  }

  async function countJobs(): Promise<number> {
    const [row] = await ctx().admin<{ n: number }[]>`SELECT count(*)::int AS n FROM jobs WHERE organization_id = ${ORG}`;
    return row?.n ?? 0;
  }

  async function heldCount(): Promise<number> {
    const [row] = await ctx().admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM job_attempts
      WHERE organization_id = ${ORG} AND capacity_claim_state = 'held'`;
    return row?.n ?? 0;
  }

  function submission(idempotencyKey: string) {
    return {
      organizationId: ORG,
      companyId: COMPANY,
      principal: { kind: "system" as const, id: "dep-009-submit-test" },
      command: {
        idempotencyKey,
        source: { kind: "one_shot" as const, operationId: randomUUID(), operationKind: "readiness_probe" as const },
        input: { value: "dep-009" },
      },
    };
  }

  const submit = (idempotencyKey: string, request = submission(idempotencyKey)) =>
    runInTenant(ctx().app.db, ORG, (repos, tx) => submitJobWithinTenant(repos, request, tx));

  beforeAll(async () => {
    // The admission claim is dormant behind the deployment flag; turn it on for this suite.
    priorFlag = process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED;
    process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED = "true";
    try {
      fx = await setupJobControlFixture("job-submit-capacity");
    } catch (error) {
      setupError = error;
    }
  }, 180_000);

  afterEach(async () => {
    if (fx) {
      await clearJobs();
      await setCap(null);
    }
  });

  afterAll(async () => {
    if (priorFlag === undefined) delete process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED;
    else process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED = priorFlag;
    await fx?.teardown();
  }, 60_000);

  it("claims a capacity slot on the first attempt at submit and rejects an over-cap submit", async () => {
    await setCap(1);
    const first = await submit(randomUUID());
    expect(first.replayed).toBe(false);
    expect(await heldCount()).toBe(1);

    // A second, distinct submission over the cap must be REJECTED (429) and fully rolled
    // back — no leasable job/attempt persists.
    await expect(submit(randomUUID())).rejects.toMatchObject({ status: 429 });
    expect(await heldCount()).toBe(1);
    expect(await countJobs()).toBe(1); // the rejected submit left nothing behind
  }, 60_000);

  it("is idempotent on a redelivered submission (never a second claim)", async () => {
    await setCap(5);
    const key = randomUUID();
    const request = submission(key);
    const first = await runInTenant(ctx().app.db, ORG, (repos, tx) => submitJobWithinTenant(repos, request, tx));
    expect(first.replayed).toBe(false);
    // Same (principal, source-identity, idempotencyKey) → replay, no new claim.
    const replay = await runInTenant(ctx().app.db, ORG, (repos, tx) => submitJobWithinTenant(repos, request, tx));
    expect(replay.replayed).toBe(true);
    expect(replay.attemptId).toBe(first.attemptId);
    expect(await heldCount()).toBe(1); // still exactly one slot held
  }, 60_000);

  it("serializes concurrent submits under the advisory lock (cap never exceeded)", async () => {
    await setCap(1);
    const results = await Promise.allSettled([submit(randomUUID()), submit(randomUUID()), submit(randomUUID())]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(HttpError);
      expect((r as PromiseRejectedResult).reason.status).toBe(429);
    }
    expect(await heldCount()).toBe(1);
  }, 60_000);

  it("frees the slot on release so a later submit is admitted", async () => {
    await setCap(1);
    const first = await submit(randomUUID());
    expect(await heldCount()).toBe(1);
    await expect(submit(randomUUID())).rejects.toMatchObject({ status: 429 });

    // Release the first attempt's slot (the terminal/revoke path) → capacity frees.
    const released = await runInTenant(ctx().app.db, ORG, (_repos, tx) =>
      releaseAttemptCapacity(tx, { attemptId: first.attemptId, organizationId: ORG }));
    expect(released.released).toBe(true);
    expect(await heldCount()).toBe(0);

    const next = await submit(randomUUID());
    expect(next.replayed).toBe(false);
    expect(await heldCount()).toBe(1);
  }, 60_000);
});
