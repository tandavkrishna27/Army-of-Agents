// server/src/__tests__/worker-control-reap-route.integration.test.ts
//
// DEP-005 Slice A — the dormant, flag-gated reaper trigger `POST
// /api/worker-control/_test/reap`. The reaper has NO live trigger in the running
// stack (index.ts schedules only outbox.tick; worker-control uses `reconciliation`
// only for cancellation), so the D1 fault harness needs a way to cross a lease
// deadline synchronously: back-date the lease row, then fire ONE reap. This route is
// that trigger. It is dormant: gated on AOA_DISTRIBUTED_EXECUTION_ENABLED, it 404s
// with the flag off (and never even mounts in a flag-off process, since app.ts only
// wires workerControlRoutes inside the distributed-execution block). No new authority
// / table / migration — it calls the already-instantiated reconciliation service
// (proper runInTenant/RLS + a fresh DB clock).
//
// This spec proves BOTH branches over a real embedded-Postgres stack:
//   * flag OFF  → 404 (route behaves as if it does not exist)
//   * flag ON + a back-dated active lease → 200 { revoked>=1, ... } and the lease is
//     terminal 'expired' (the same back-date+reap idiom proven in
//     job-reconciliation.integration.test.ts).

import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { workerControlRoutes } from "../routes/worker-control.js";
import { errorHandler } from "../middleware/error-handler.js";
import { DISTRIBUTED_EXECUTION_ENABLED_ENV } from "../config/distributed-execution.js";
import {
  ORG,
  setupJobControlFixture,
  type JobControlFixture,
} from "./helpers/job-control-fixture.js";

const integration = describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
);

const SIGNING_KEY = "dep-005-reap-route-signing-key-at-least-32-bytes";

integration("DEP-005 reap trigger route /worker-control/_test/reap", () => {
  let fx: JobControlFixture | null = null;
  let setupError: unknown = null;
  let app: express.Express;
  let priorFlag: string | undefined;
  let priorTestFlag: string | undefined;

  function ctx(): JobControlFixture {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    if (!fx) throw new Error("fixture not initialized");
    return fx;
  }

  /** Force the active lease past its expiry so the reaper treats the worker as gone.
   * Back-date BOTH columns (keeping ack_deadline < expires_at) — the active/expired
   * case keys on expires_at, but the atomic-check requires the ordering. */
  async function expireLease(leaseId: string): Promise<void> {
    const { admin } = ctx();
    await admin`UPDATE leases SET ack_deadline = clock_timestamp() - interval '2 seconds',
      expires_at = clock_timestamp() - interval '1 second' WHERE id = ${leaseId}`;
  }

  async function leaseStatus(leaseId: string): Promise<string | undefined> {
    const { admin } = ctx();
    const [row] = await admin<{ status: string }[]>`SELECT status FROM leases WHERE id = ${leaseId}`;
    return row?.status;
  }

  beforeAll(async () => {
    priorFlag = process.env[DISTRIBUTED_EXECUTION_ENABLED_ENV];
    priorTestFlag = process.env.AOA_D1_TEST_REAP_ENABLED;
    try {
      fx = await setupJobControlFixture("dep-005-reap-route");
      const f = ctx();
      app = express();
      app.use(express.json({ verify: (req, _res, bytes) => {
        (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(bytes);
      } }));
      app.use("/api", workerControlRoutes({
        db: f.app.db,
        appDb: f.app.db,
        operatorDb: f.operator.db,
        sessionSigningKey: SIGNING_KEY,
      }));
      app.use(errorHandler);
    } catch (error) {
      setupError = error;
    }
  }, 180_000);

  afterAll(async () => {
    await fx?.teardown();
  }, 60_000);

  afterEach(() => {
    if (priorFlag === undefined) delete process.env[DISTRIBUTED_EXECUTION_ENABLED_ENV];
    else process.env[DISTRIBUTED_EXECUTION_ENABLED_ENV] = priorFlag;
    if (priorTestFlag === undefined) delete process.env.AOA_D1_TEST_REAP_ENABLED;
    else process.env.AOA_D1_TEST_REAP_ENABLED = priorTestFlag;
  });

  it("404s when the distributed-execution flag is OFF (route is dormant)", async () => {
    process.env[DISTRIBUTED_EXECUTION_ENABLED_ENV] = "false";
    const res = await request(app)
      .post("/api/worker-control/_test/reap")
      .send({ organizationId: ORG });
    expect(res.status).toBe(404);
  });

  it("404s with the flag OFF even for a malformed body (dormant precedes validation)", async () => {
    process.env[DISTRIBUTED_EXECUTION_ENABLED_ENV] = "false";
    const res = await request(app)
      .post("/api/worker-control/_test/reap")
      .send({ nonsense: true });
    expect(res.status).toBe(404);
  });

  it("404s when the distributed flag is ON but the dedicated test flag is OFF (decoupled dormancy)", async () => {
    process.env[DISTRIBUTED_EXECUTION_ENABLED_ENV] = "true";
    delete process.env.AOA_D1_TEST_REAP_ENABLED;
    const res = await request(app)
      .post("/api/worker-control/_test/reap")
      .send({ organizationId: ORG });
    expect(res.status).toBe(404);
  });

  it("with the flag ON, reaps a back-dated active lease: 200 { revoked>=1 } and the lease is expired", async () => {
    process.env[DISTRIBUTED_EXECUTION_ENABLED_ENV] = "true";
    process.env.AOA_D1_TEST_REAP_ENABLED = "1";
    const f = ctx();
    const { offer } = await f.activateLease(9_101);
    expect(await leaseStatus(offer.leaseId)).toBe("active");
    await expireLease(offer.leaseId);

    const res = await request(app)
      .post("/api/worker-control/_test/reap")
      .send({ organizationId: ORG });

    expect(res.status).toBe(200);
    expect(res.body.revoked).toBeGreaterThanOrEqual(1);
    expect(res.body.retried).toBeGreaterThanOrEqual(1);
    expect(res.body).toMatchObject({
      scanned: expect.any(Number),
      revoked: expect.any(Number),
      retried: expect.any(Number),
      deadLettered: expect.any(Number),
      cancelled: expect.any(Number),
      finalized: expect.any(Number),
    });
    expect(await leaseStatus(offer.leaseId)).toBe("expired");
  }, 60_000);

  it("with the flag ON, honors the optional limit and returns zero counters when nothing is expired", async () => {
    process.env[DISTRIBUTED_EXECUTION_ENABLED_ENV] = "true";
    process.env.AOA_D1_TEST_REAP_ENABLED = "1";
    const f = ctx();
    // A fresh active lease that is NOT back-dated — the reaper must not touch it.
    const { offer } = await f.activateLease(9_102);
    const res = await request(app)
      .post("/api/worker-control/_test/reap")
      .send({ organizationId: ORG, limit: 8 });
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(0);
    expect(res.body.retried).toBe(0);
    expect(await leaseStatus(offer.leaseId)).toBe("active");
  }, 60_000);

  it("rejects a malformed body with the flag ON (validation runs after the flag gate)", async () => {
    process.env[DISTRIBUTED_EXECUTION_ENABLED_ENV] = "true";
    process.env.AOA_D1_TEST_REAP_ENABLED = "1";
    const res = await request(app)
      .post("/api/worker-control/_test/reap")
      .send({ organizationId: "not-a-uuid" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(200);
  });
});
