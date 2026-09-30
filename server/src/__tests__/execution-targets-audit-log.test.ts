// Round-3 finding ②: registering a security-sensitive execution target must
// leave an audit trail. activity_log is company-scoped (company_id NOT NULL), so
// this org-scoped mutation is recorded via a structured pino log line instead
// (the same class as the operator break-glass org-wide audit fix). This test
// mounts the real route with a fake db and asserts the audit line is emitted on
// a successful registration, without changing the 201 response shape.
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

// Spy on the pino logger the route emits the audit line through. `vi.hoisted`
// so the spy exists before the hoisted vi.mock factory references it.
const { infoSpy } = vi.hoisted(() => ({ infoSpy: vi.fn() }));
vi.mock("../middleware/logger.js", () => ({
  logger: { info: infoSpy, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// Authz passes: the org-admin check is exercised elsewhere; here we isolate the
// audit behaviour.
vi.mock("../services/organization-access.js", () => ({
  organizationAccessService: () => ({ canOrg: async () => true }),
}));
// Deterministic token/serialization helpers so the route runs end to end.
vi.mock("../services/execution-targets.js", () => ({
  createWorkerToken: () => "aoa_wtk_test",
  hashWorkerToken: () => "hash-of-token",
  stripWorkerSecret: (row: Record<string, unknown>) => {
    const { workerTokenHash: _omit, ...rest } = row;
    return rest;
  },
  listExecutionTargets: async () => [],
  registerWorkerHeartbeat: async () => ({ updated: 1 }),
  rotateExecutionTargetWorkerToken: async (_db: unknown, input: { organizationId: string; targetId: string }) =>
    input.organizationId === "77777777-7777-4777-8777-777777777777" &&
    input.targetId === "88888888-8888-4888-8888-888888888888"
      ? {
          target: {
            id: input.targetId,
            organizationId: input.organizationId,
            slug: "et-1",
            status: "active",
          },
          workerToken: "aoa_wtk_rotated",
        }
      : null,
  revokeExecutionTargetWorkerToken: async (_db: unknown, input: { organizationId: string; targetId: string }) =>
    input.organizationId === "77777777-7777-4777-8777-777777777777" &&
    input.targetId === "88888888-8888-4888-8888-888888888888"
      ? {
          id: input.targetId,
          organizationId: input.organizationId,
          slug: "et-1",
          status: "disabled",
        }
      : null,
  resolveWorkerHeartbeatAuthority: async (_db: unknown, token: string) =>
    token === "aoa_wtk_valid"
      ? { targetId: "et-abc-123", organizationId: "77777777-7777-4777-8777-777777777777" }
      : null,
}));
vi.mock("@armyofagents/db", () => ({ executionTargets: {} }));

import { executionTargetRoutes } from "../routes/execution-targets.js";
import { errorHandler } from "../middleware/error-handler.js";

const ORG = "77777777-7777-4777-8777-777777777777";
const TARGET = "88888888-8888-4888-8888-888888888888";
const INSERTED = {
  id: "et-abc-123",
  organizationId: ORG,
  slug: "et-1",
  kind: "local_host",
  trustClass: "local_trusted",
  workerTokenHash: "hash-of-token",
};

function makeApp(actor: unknown, insertError?: unknown) {
  // Fake db: insert(...).values(...).returning() → the persisted row.
  const db = {
    insert: () => ({
      values: () => ({
        returning: async () => {
          if (insertError) throw insertError;
          return [INSERTED];
        },
      }),
    }),
  } as never;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", executionTargetRoutes({ db }));
  app.use(errorHandler);
  return app;
}

const boardAdmin = { type: "board", source: "session", userId: "operator-9", companyIds: [] };

afterEach(() => vi.clearAllMocks());

describe("execution-target registration — audit trail (finding ②)", () => {
  it("emits a structured audit log line on successful registration", async () => {
    const res = await request(makeApp(boardAdmin))
      .post(`/api/organizations/${ORG}/execution-targets`)
      .send({ slug: "et-1", kind: "local_host", trustClass: "local_trusted" });

    // Response shape is unchanged: 201 + row (minus secret) + one-time token.
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(INSERTED.id);
    expect(res.body.workerToken).toBe("aoa_wtk_test");
    expect(res.body.workerTokenHash).toBeUndefined();

    // The audit line was emitted with the security-relevant fields.
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "execution_target.register",
        organizationId: ORG,
        executionTargetId: INSERTED.id,
        operatorUserId: "operator-9",
        scope: "org_scoped",
      }),
      "execution target registered",
    );

    // The audit line must NOT leak the worker credential (plaintext or hash).
    const payload = infoSpy.mock.calls[0]![0];
    expect(payload).not.toHaveProperty("workerToken");
    expect(payload).not.toHaveProperty("workerTokenHash");
  });

  it("rotates a same-org worker token, returns it once, and audits without secrets", async () => {
    const res = await request(makeApp(boardAdmin)).post(
      `/api/organizations/${ORG}/execution-targets/${TARGET}/rotate-token`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({ id: TARGET, organizationId: ORG, workerToken: "aoa_wtk_rotated" }),
    );
    expect(res.body.workerTokenHash).toBeUndefined();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "execution_target.worker_token.rotated",
        organizationId: ORG,
        executionTargetId: TARGET,
        operatorUserId: "operator-9",
        scope: "org_scoped",
      }),
      "execution target worker token rotated",
    );
    const payload = infoSpy.mock.calls[0]![0];
    expect(payload).not.toHaveProperty("workerToken");
    expect(payload).not.toHaveProperty("workerTokenHash");
  });

  it("revokes and disables a same-org target, and audits without secrets", async () => {
    const res = await request(makeApp(boardAdmin)).post(
      `/api/organizations/${ORG}/execution-targets/${TARGET}/revoke`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ id: TARGET, organizationId: ORG, status: "disabled" }));
    expect(res.body.workerToken).toBeUndefined();
    expect(res.body.workerTokenHash).toBeUndefined();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "execution_target.worker_token.revoked",
        organizationId: ORG,
        executionTargetId: TARGET,
        operatorUserId: "operator-9",
        scope: "org_scoped",
      }),
      "execution target worker token revoked",
    );
    const payload = infoSpy.mock.calls[0]![0];
    expect(payload).not.toHaveProperty("workerToken");
    expect(payload).not.toHaveProperty("workerTokenHash");
  });

  it("returns 404 without an audit line when the target is outside the organization", async () => {
    const otherOrg = "99999999-9999-4999-8999-999999999999";
    const rotate = await request(makeApp(boardAdmin)).post(
      `/api/organizations/${otherOrg}/execution-targets/${TARGET}/rotate-token`,
    );
    const revoke = await request(makeApp(boardAdmin)).post(
      `/api/organizations/${otherOrg}/execution-targets/${TARGET}/revoke`,
    );

    expect(rotate.status).toBe(404);
    expect(revoke.status).toBe(404);
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("uses the standard 400 response for malformed registration input", async () => {
    const res = await request(makeApp(boardAdmin))
      .post(`/api/organizations/${ORG}/execution-targets`)
      .send({ slug: "Not Valid", kind: "local_host", trustClass: "local_trusted" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("returns 409 for a duplicate organization slug", async () => {
    const duplicate = {
      cause: { code: "23505", constraint_name: "execution_targets_org_slug_uq" },
    };
    const res = await request(makeApp(boardAdmin, duplicate))
      .post(`/api/organizations/${ORG}/execution-targets`)
      .send({ slug: "et-1", kind: "local_host", trustClass: "local_trusted" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it("rejects malformed organization ids before access or database work", async () => {
    const res = await request(makeApp(boardAdmin))
      .post("/api/organizations/not-a-uuid/execution-targets")
      .send({ slug: "et-1", kind: "local_host", trustClass: "local_trusted" });

    expect(res.status).toBe(400);
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("strictly validates worker heartbeat status, capabilities, and fields", async () => {
    const invalidStatus = await request(makeApp(boardAdmin))
      .post("/api/execution-targets/heartbeat")
      .set("authorization", "Bearer aoa_wtk_valid")
      .send({ status: "compromised" });
    const invalidCapabilities = await request(makeApp(boardAdmin))
      .post("/api/execution-targets/heartbeat")
      .set("authorization", "Bearer aoa_wtk_valid")
      .send({ capabilities: ["runsc"] });
    const unknownField = await request(makeApp(boardAdmin))
      .post("/api/execution-targets/heartbeat")
      .set("authorization", "Bearer aoa_wtk_valid")
      .send({ status: "active", targetId: "another-tenant" });

    expect(invalidStatus.status).toBe(400);
    expect(invalidCapabilities.status).toBe(400);
    expect(unknownField.status).toBe(400);
  });
});
