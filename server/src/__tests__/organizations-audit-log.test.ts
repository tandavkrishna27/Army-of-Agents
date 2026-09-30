// Round-7 finding (Fix B): self-serve organization creation is a security-sensitive
// tenant mutation and must leave an audit trail. organizations is org-scoped (no
// company_id), so — like the execution-target register + operator break-glass audits
// — it is recorded via a structured pino log line. This test mounts the real route
// with a stubbed service and asserts the audit line is emitted on a successful
// create, without changing the 201 response shape. (Durable org-scoped audit is the
// tracked M6 follow-up.)
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

// Spy on the pino logger the route emits the audit line through. `vi.hoisted`
// so the spy exists before the hoisted vi.mock factory references it.
const { infoSpy } = vi.hoisted(() => ({ infoSpy: vi.fn() }));
vi.mock("../middleware/logger.js", () => ({
  logger: { info: infoSpy, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Isolate the audit behaviour: stub the service so the route runs end to end
// without a real db, and stub the access-service factory the router constructs.
const CREATED_ORG = { id: "org-new-1", name: "Acme", slug: "acme" };
vi.mock("../services/organizations.js", () => ({
  createSelfServeOrganization: vi.fn(async () => ({ organization: CREATED_ORG, created: true })),
}));
vi.mock("../services/organization-access.js", () => ({
  organizationAccessService: () => ({ listOrgMemberships: async () => [] }),
}));

import { organizationRoutes } from "../routes/organizations.js";
import { errorHandler } from "../middleware/error-handler.js";

function makeApp(actor: unknown) {
  const db = {} as never;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api/organizations", organizationRoutes(db));
  app.use(errorHandler);
  return app;
}

const boardUser = { type: "board", source: "session", userId: "operator-9", companyIds: [] };

afterEach(() => vi.clearAllMocks());

describe("self-serve organization creation — audit trail (Fix B)", () => {
  it("emits a structured audit log line on successful creation", async () => {
    const res = await request(makeApp(boardUser))
      .post("/api/organizations")
      .send({ name: "Acme" });

    // Response shape is unchanged: 201 + the created org row.
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(CREATED_ORG.id);

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "organization.create",
        organizationId: CREATED_ORG.id,
        ownerUserId: "operator-9",
        scope: "org_scoped",
      }),
      "self-serve organization created",
    );
  });

  it("does not emit a duplicate audit line when an idempotent request is replayed", async () => {
    const { createSelfServeOrganization } = await import("../services/organizations.js");
    vi.mocked(createSelfServeOrganization).mockResolvedValueOnce({
      organization: CREATED_ORG,
      created: false,
    } as never);

    const res = await request(makeApp(boardUser))
      .post("/api/organizations")
      .send({ name: "Acme", creationRequestId: "d259a6f1-d10a-4f79-a057-d47d3ef11152" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(CREATED_ORG.id);
    expect(infoSpy).not.toHaveBeenCalled();
  });
});
