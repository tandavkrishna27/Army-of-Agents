// JOB-008 — Operator job & worker controls (routes + redacted read service).
//
// This unit test mounts the REAL `jobControlRoutes` factory and the REAL
// `createJobOperationsService` reads, faking ONLY the tenant transaction boundary
// (`runInTenant`) and the JOB-006/007 mutation delegates. The fake `tx` respects the
// service's projected column map (`tx.select({...})`): it returns ONLY the projected
// keys from each full fixture row, so a redaction assertion (asserting the ABSENCE of a
// secret/cross-tenant column) is genuine — it passes only because the service's
// projection excludes that column. The fake also applies the tenant `organization_id`
// predicate (rows whose organizationId !== the runInTenant org are excluded, exactly as
// FORCE RLS + the `eq(workers.organizationId, orgId)` predicate do), so a null-org
// platform worker never surfaces to a tenant (R5).
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  infoSpy: vi.fn(),
  reqCancelSpy: vi.fn(),
  revokeSpy: vi.fn(),
  state: {
    canOrg: true as boolean,
    byTable: {} as Record<string, Array<Record<string, unknown>>>,
    /** BRW-003d-4 — every `.limit(n)` the service asked the DB for, by table. */
    limits: {} as Record<string, number[]>,
  },
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { info: h.infoSpy, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Authority gate — toggled per test via h.state.canOrg.
vi.mock("../services/organization-access.js", () => ({
  organizationAccessService: () => ({ canOrg: async () => h.state.canOrg }),
}));

// Mutation delegates (JOB-006 cancellation / JOB-007 revocation).
vi.mock("../services/job-reconciliation.js", () => ({
  createJobReconciliationService: () => ({ requestCancellation: h.reqCancelSpy }),
}));
vi.mock("../services/execution-targets.js", () => ({
  revokeExecutionTarget: h.revokeSpy,
}));

// Keep the existing submission route's dependency out of the import graph.
vi.mock("../services/job-submission.js", () => ({
  jobSubmissionService: () => ({ submit: vi.fn() }),
}));
vi.mock("../services/tenant-admission.js", () => ({
  TenantAdmissionDeniedError: class TenantAdmissionDeniedError extends Error {},
}));

// THE tenant boundary. Real `@armyofagents/db` tables + real drizzle are used so
// `getTableName` routes `.from(table)` to the right fixtures and the projected column
// map filters real column refs by output key.
vi.mock("../db/tenant-context.js", async () => {
  const { getTableName } = await import("drizzle-orm");
  // BRW-003d-4 — `orderBy` is CHAINABLE HERE BUT DOES NOT SORT, on purpose.
  //
  // getJobDetail gained .orderBy(); without this the fake throws "orderBy is not a
  // function" and every test in this file dies. But a fake that pretended to sort
  // would make an ordering assertion in THIS tier vacuous — it would pass against
  // a service whose ORDER BY is wrong, because the fixture order would decide the
  // result. So ordering is asserted in the embedded-Postgres tier, which really
  // sorts, and this tier keeps proving what it always proved: projection, tenant
  // scoping, and the caps.
  const query = (rows: unknown[], table: string) => ({
    orderBy: () => query(rows, table),
    limit: (n: number) => {
      // RECORD the requested bound. Asserting only the RESPONSE length cannot see
      // a missing `.limit()`, because the service slices afterwards anyway — the
      // rows would still cross the wire from Postgres. A surviving mutant proved
      // exactly that, so the property under test is what we ASK THE DATABASE FOR.
      (h.state.limits[table] ??= []).push(n);
      return Promise.resolve(rows.slice(0, n));
    },
    then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  });
  const makeTx = (orgId: string) => ({
    select: (projection: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => {
          const name = getTableName(table as never);
          const src = (h.state.byTable[name] ?? []).filter(
            (r) => !("organizationId" in r) || r.organizationId === orgId,
          );
          const cols = Object.keys(projection);
          const rows = src.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
          return query(rows, name);
        },
      }),
    }),
  });
  return {
    runInTenant: async <T>(
      _appDb: unknown,
      orgId: string,
      fn: (repos: unknown, tx: unknown) => Promise<T>,
    ): Promise<T> => fn({}, makeTx(orgId)),
  };
});

import { jobControlRoutes } from "../routes/job-control.js";
import { errorHandler } from "../middleware/error-handler.js";

const ORG = "77777777-7777-4777-8777-777777777777";
const OTHER_ORG = "66666666-6666-4666-8666-666666666666";
const COMPANY = "88888888-8888-4888-8888-888888888888";
const JOB = "99999999-9999-4999-8999-999999999999";
const WORKER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const boardAdmin = {
  type: "board",
  source: "session",
  userId: "operator-9",
  companyIds: [] as string[],
  organizationIds: [] as string[],
};

function fullJob(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB,
    organizationId: ORG,
    companyId: COMPANY,
    status: "queued",
    workloadType: "batch",
    priority: 0,
    availableAt: "2026-01-01T00:00:00Z",
    maxAttempts: 3,
    deadLetterReason: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    // secrets that MUST be redacted
    input: { secret: "payload" },
    inputHash: "ih",
    commandDigest: "cd",
    sourceIdentity: "si",
    sourceKind: "sk",
    sourceIntent: { intent: 1 },
    policySnapshot: { p: 1 },
    policyHash: "ph",
    requirements: { r: 1 },
    placementRequest: { pr: 1 },
    idempotencyKey: "ik",
    ...overrides,
  };
}

function fullAttempt(overrides: Record<string, unknown> = {}) {
  return {
    id: "att-1",
    organizationId: ORG,
    companyId: COMPANY,
    jobId: JOB,
    attemptNumber: 1,
    status: "leased",
    placementDisposition: "selected",
    placementOwner: "managed_cloud",
    placementTargetClass: "managed_cloud",
    placementTargetScope: "platform",
    placementReasonCode: "ok",
    placementMode: "active",
    placementFallbackDisposition: "not_applicable",
    placementLeaseEligible: true,
    capacityClaimState: "held",
    capacityWorkloadType: "batch",
    placementDecidedAt: "2026-01-01T00:00:00Z",
    backoffUntil: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    // cross-tenant / secret sinks
    placementTargetId: TARGET,
    placementProfileHash: "pph",
    placementProviderConstraintHash: "ppch",
    placementInputDigest: "pid",
    placementPolicyDigest: "ppd",
    ...overrides,
  };
}

function fullLease(overrides: Record<string, unknown> = {}) {
  return {
    id: "lease-1",
    organizationId: ORG,
    attemptId: "att-1",
    attemptNumber: 1,
    status: "active",
    ackDeadline: "2026-01-01T00:05:00Z",
    expiresAt: "2026-01-01T00:10:00Z",
    activatedAt: "2026-01-01T00:00:30Z",
    releasedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    targetGeneration: 1,
    // secret / cross-tenant sinks
    fence: "SECRET_FENCE",
    targetId: TARGET,
    workerId: WORKER,
    profileHash: "pfh",
    providerConstraintHash: "pcih",
    targetAuthorityKey: "organization:secret",
    ...overrides,
  };
}

function fullEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "ev-1",
    organizationId: ORG,
    jobId: JOB,
    attemptId: "att-1",
    attemptNumber: 1,
    sequence: 1,
    eventType: "log",
    eventDigest: "a".repeat(64),
    occurredAt: "2026-01-01T00:00:10Z",
    createdAt: "2026-01-01T00:00:10Z",
    // secret sinks
    event: { secret: "payload" },
    fenceToken: "SECRET_FENCE_TOKEN",
    leaseId: "lease-1",
    ...overrides,
  };
}

function fullWorker(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKER,
    organizationId: ORG,
    scope: "organization",
    status: "active",
    label: "worker-1",
    lastSeenAt: "2026-01-01T00:00:00Z",
    deviceGeneration: 1,
    enrolledAt: "2026-01-01T00:00:00Z",
    revokedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    // secret / cross-tenant sinks
    devicePublicKey: "pub",
    deviceThumbprint: "thumb",
    profileHash: "wph",
    profileSnapshot: { s: 1 },
    ownerUserId: null,
    executionTargetId: TARGET,
    targetAuthorityKey: "organization:secret",
    ...overrides,
  };
}

function makeApp(actor: unknown) {
  const db = {} as never;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", jobControlRoutes({ db, appDb: db, operatorDb: db }));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  h.state.canOrg = true;
  h.state.limits = {};
  h.state.byTable = {
    jobs: [fullJob()],
    job_attempts: [fullAttempt()],
    leases: [fullLease()],
    job_events: [fullEvent()],
    workers: [fullWorker()],
  };
  h.reqCancelSpy.mockReset();
  h.reqCancelSpy.mockResolvedValue({ status: "queued", command: { commandId: "cmd-1", commandSeq: 1 } });
  h.revokeSpy.mockReset();
  h.revokeSpy.mockResolvedValue({ revoked: true, revokedGeneration: 2, targetScope: "organization" });
});

afterEach(() => vi.clearAllMocks());

describe("JOB-008 operator controls — authority", () => {
  it("401 for an unauthenticated (none) actor", async () => {
    const res = await request(makeApp({ type: "none" })).get(
      `/api/organizations/${ORG}/companies/${COMPANY}/jobs`,
    );
    expect(res.status).toBe(401);
  });

  it("403 for a non-board actor", async () => {
    const res = await request(makeApp({ type: "agent", agentId: "a1", companyId: COMPANY })).get(
      `/api/organizations/${ORG}/companies/${COMPANY}/jobs`,
    );
    expect(res.status).toBe(403);
  });

  it("403 (no audit) for a board actor lacking execution_target:manage", async () => {
    h.state.canOrg = false;
    const res = await request(makeApp(boardAdmin)).get(
      `/api/organizations/${ORG}/companies/${COMPANY}/jobs`,
    );
    expect(res.status).toBe(403);
    expect(h.infoSpy).not.toHaveBeenCalled();
  });

  it("uniform 404 (no audit) for an absent/cross-tenant job detail", async () => {
    h.state.byTable.jobs = []; // job absent under this authority
    const res = await request(makeApp(boardAdmin)).get(
      `/api/organizations/${ORG}/companies/${COMPANY}/jobs/${JOB}`,
    );
    expect(res.status).toBe(404);
    expect(h.infoSpy).not.toHaveBeenCalled();
  });
});

describe("JOB-008 operator controls — redaction by projection", () => {

  it("BRW-003d-4 asks the DATABASE for a bounded page, not just a bounded response", async () => {
    // ★ A surviving mutant is why this exists. Deleting `.limit()` from the
    // service still produced a capped RESPONSE, because the service slices
    // afterwards — but every row would have crossed the wire from Postgres.
    // Asserting the response length cannot see that; asserting the requested
    // bound can.
    await request(makeApp(boardAdmin)).get(
      `/api/organizations/${ORG}/companies/${COMPANY}/jobs/${JOB}`,
    );
    expect(h.state.limits.job_events?.[0], "job_events read must be bounded").toBeGreaterThan(0);
    expect(h.state.limits.job_artifacts?.[0], "job_artifacts read must be bounded").toBeGreaterThan(0);
  });
  it("job list exposes safe fields and drops intent/policy/command secrets", async () => {
    const res = await request(makeApp(boardAdmin)).get(
      `/api/organizations/${ORG}/companies/${COMPANY}/jobs`,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const job = res.body[0];
    expect(job.status).toBe("queued");
    expect(job.workloadType).toBe("batch");
    for (const secret of [
      "input", "inputHash", "commandDigest", "sourceIdentity", "sourceIntent",
      "policySnapshot", "policyHash", "requirements", "placementRequest", "idempotencyKey",
    ]) {
      expect(job).not.toHaveProperty(secret);
    }
  });

  it("attempt summary keeps placement class/scope but drops the cross-tenant target id + digests", async () => {
    const res = await request(makeApp(boardAdmin)).get(
      `/api/organizations/${ORG}/companies/${COMPANY}/jobs/${JOB}`,
    );
    expect(res.status).toBe(200);
    const attempt = res.body.attempts[0];
    expect(attempt.placementTargetClass).toBe("managed_cloud");
    expect(attempt.placementTargetScope).toBe("platform");
    expect(attempt.placementReasonCode).toBe("ok");
    for (const secret of [
      "placementTargetId", "placementProfileHash", "placementProviderConstraintHash",
      "placementInputDigest", "placementPolicyDigest",
    ]) {
      expect(attempt).not.toHaveProperty(secret);
    }
  });

  it("lease summary drops fence + cross-tenant target id + authority key", async () => {
    const res = await request(makeApp(boardAdmin)).get(
      `/api/organizations/${ORG}/companies/${COMPANY}/jobs/${JOB}`,
    );
    const lease = res.body.leases[0];
    expect(lease.status).toBe("active");
    expect(lease.ackDeadline).toBeTruthy();
    expect(lease.expiresAt).toBeTruthy();
    for (const secret of ["fence", "targetId", "targetAuthorityKey", "workerId", "profileHash", "providerConstraintHash"]) {
      expect(lease).not.toHaveProperty(secret);
    }
  });

  it("event summary exposes metadata/digest but drops the payload + fence token", async () => {
    const res = await request(makeApp(boardAdmin)).get(
      `/api/organizations/${ORG}/companies/${COMPANY}/jobs/${JOB}`,
    );
    const event = res.body.events[0];
    expect(event.eventType).toBe("log");
    expect(event.eventDigest).toBeTruthy();
    expect(event.sequence).toBe(1);
    for (const secret of ["event", "fenceToken", "leaseId"]) {
      expect(event).not.toHaveProperty(secret);
    }
  });

  it("worker list drops device keys + cross-tenant execution target, and excludes null-org platform workers", async () => {
    h.state.byTable.workers = [
      fullWorker(),
      fullWorker({ id: "platform-w", scope: "platform", organizationId: null, executionTargetId: "platform-target" }),
    ];
    const res = await request(makeApp(boardAdmin)).get(`/api/organizations/${ORG}/workers`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1); // null-org platform worker excluded (R5)
    const worker = res.body[0];
    expect(worker.id).toBe(WORKER);
    expect(worker.status).toBe("active");
    for (const secret of [
      "devicePublicKey", "deviceThumbprint", "profileHash", "profileSnapshot",
      "ownerUserId", "executionTargetId", "targetAuthorityKey", "organizationId",
    ]) {
      expect(worker).not.toHaveProperty(secret);
    }
  });
});

describe("JOB-008 operator controls — mutations delegate + audit", () => {
  it("drain delegates to requestCancellation with graceful:true and audits", async () => {
    const res = await request(makeApp(boardAdmin))
      .post(`/api/organizations/${ORG}/companies/${COMPANY}/jobs/${JOB}/drain`)
      .send({ reason: "operator drain" });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    expect(h.reqCancelSpy).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, companyId: COMPANY, jobId: JOB, graceful: true }),
    );
    expect(h.infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "job.drain.requested",
        organizationId: ORG,
        companyId: COMPANY,
        jobId: JOB,
        operatorUserId: "operator-9",
        outcome: "queued",
      }),
      expect.any(String),
    );
    // The audit payload must never carry fence/token/payload secrets.
    const payload = h.infoSpy.mock.calls[0]![0] as Record<string, unknown>;
    for (const secret of ["fence", "fenceToken", "workerTokenHash", "input", "event"]) {
      expect(payload).not.toHaveProperty(secret);
    }
  });

  it("drain is idempotent — a repeat cancellation returns already_requested with a stable 202", async () => {
    h.reqCancelSpy.mockResolvedValue({ status: "already_requested", command: null });
    const res = await request(makeApp(boardAdmin))
      .post(`/api/organizations/${ORG}/companies/${COMPANY}/jobs/${JOB}/drain`)
      .send({ reason: "again" });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("already_requested");
  });

  it("drain maps a not_found cancellation status to 404 with no audit", async () => {
    h.reqCancelSpy.mockResolvedValue({ status: "not_found", command: null });
    const res = await request(makeApp(boardAdmin))
      .post(`/api/organizations/${ORG}/companies/${COMPANY}/jobs/${JOB}/drain`)
      .send({ reason: "x" });
    expect(res.status).toBe(404);
    expect(h.infoSpy).not.toHaveBeenCalled();
  });

  it("worker revoke resolves the execution target server-side and delegates to revokeExecutionTarget", async () => {
    const res = await request(makeApp(boardAdmin))
      .post(`/api/organizations/${ORG}/workers/${WORKER}/revoke`)
      .send({ reason: "compromised" });
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);
    expect(h.revokeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: TARGET, organizationId: ORG, reason: "compromised" }),
    );
    // The cross-tenant target id is resolved server-side, never received from the client.
    expect(h.infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "worker.revoke.requested",
        organizationId: ORG,
        workerId: WORKER,
        operatorUserId: "operator-9",
      }),
      expect.any(String),
    );
  });

  it("worker revoke is idempotent — already_disabled returns 200 without throwing", async () => {
    h.revokeSpy.mockResolvedValue({ revoked: false, reason: "already_disabled", revokedGeneration: 3 });
    const res = await request(makeApp(boardAdmin))
      .post(`/api/organizations/${ORG}/workers/${WORKER}/revoke`)
      .send({ reason: "again" });
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(false);
    expect(res.body.reason).toBe("already_disabled");
  });

  it("worker revoke returns a uniform 404 (no audit, no delegate) for an absent/cross-tenant worker", async () => {
    h.state.byTable.workers = []; // worker not resolvable under this tenant
    const res = await request(makeApp(boardAdmin))
      .post(`/api/organizations/${ORG}/workers/${WORKER}/revoke`)
      .send({ reason: "x" });
    expect(res.status).toBe(404);
    expect(h.revokeSpy).not.toHaveBeenCalled();
    expect(h.infoSpy).not.toHaveBeenCalled();
  });

  it("does not enumerate a worker owned by another organization", async () => {
    h.state.byTable.workers = [fullWorker({ organizationId: OTHER_ORG })];
    const res = await request(makeApp(boardAdmin))
      .post(`/api/organizations/${ORG}/workers/${WORKER}/revoke`)
      .send({ reason: "x" });
    expect(res.status).toBe(404);
    expect(h.revokeSpy).not.toHaveBeenCalled();
  });
});
