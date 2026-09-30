import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  MarketplaceReconcileErrorResponseSchema,
  type MarketplaceReconciliationInspection,
} from "@armyofagents/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { createAdminMarketplaceRouter } from "../routes/admin-marketplace.js";
import {
  MarketplaceCatalogRefreshError,
  MarketplaceReconcileExecutionError,
  MarketplaceReconciliationInFlightError,
  MarketplaceReconciliationNotFoundError,
  MarketplaceReconciliationRetryRequiredError,
  type MarketplaceReconcileResult,
} from "../services/marketplace-reconcile.js";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_OPERATION_ID = "22222222-2222-4222-8222-222222222222";

const RESULT: MarketplaceReconcileResult = {
  operationId: OPERATION_ID,
  status: "success",
  repairs: {
    crewCompaniesRepaired: 0,
    legacyStewardsAdopted: 0,
    teamsReconciled: 0,
    teamMembersAdded: 0,
  },
  catalog: {
    generatedAt: "2026-07-28T00:00:00.000Z",
    canonicalDigestSha256: "a".repeat(64),
    schemaVersion: "1.0.0",
    itemCount: 0,
    source: "cdn",
  },
  companiesExamined: 1,
  crewRepair: {
    catalogReady: true,
    inspected: 1,
    repaired: 0,
    skippedFailClosed: 0,
    skippedCooldown: 0,
    skippedOverBudget: 0,
    failed: 0,
  },
  legacySteward: {
    disabled: false,
    catalogReady: true,
    inspected: 0,
    adopted: 0,
    skippedOverBudget: 0,
    failed: 0,
  },
  crewUpdates: { succeeded: 1, failed: 0 },
  teamReconcile: { teamsReconciled: 0, membersAdded: 0 },
  skips: [],
  diagnostics: [],
  failures: [],
};

const INSPECTION: MarketplaceReconciliationInspection = {
  operationId: OPERATION_ID,
  state: "success",
  startedAt: "2026-07-28T00:00:00.000Z",
  completedAt: "2026-07-28T00:00:01.000Z",
  deploymentSha: "reviewed-sha",
  targetCount: 1,
  targets: [
    {
      companyId: "company-1",
      crewState: "unknown",
      diagnosticCode: null,
    },
  ],
  safeToRetry: false,
  retry: {
    kind: "never",
    recoveryCode: "do_not_retry",
    message:
      "This operation completed; use a new operation ID only for a new recovery decision.",
  },
};

function makeApp(
  actor: object,
  reconcile: () => Promise<MarketplaceReconcileResult>,
  onRequest?: () => void,
  inspect: (
    operationId: string,
    isActive: boolean,
  ) => Promise<MarketplaceReconciliationInspection> = async (operationId) => {
    throw new MarketplaceReconciliationNotFoundError(operationId);
  },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Mirror actorMiddleware: a genuine operator carries operator=true alongside
    // isInstanceAdmin. The operator-plane gate (canManageInstanceSettings) reads it.
    const a: any = actor;
    (req as any).actor =
      a && a.type === "board" && a.operator === undefined
        ? { ...a, operator: a.isInstanceAdmin === true }
        : a;
    onRequest?.();
    next();
  });
  app.use(
    "/api/admin/marketplace",
    createAdminMarketplaceRouter({
      reconcile,
      inspect,
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("POST /api/admin/marketplace/reconcile", () => {
  it("rejects an unauthenticated request", async () => {
    const reconcile = vi.fn().mockResolvedValue(RESULT);
    const response = await request(
      makeApp({ type: "none", source: "none" }, reconcile),
    )
      .post("/api/admin/marketplace/reconcile")
      .send({ scope: "fleet", mode: "repair", operationId: OPERATION_ID });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("authentication_required");
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("rejects a board user who is not an instance admin", async () => {
    const reconcile = vi.fn().mockResolvedValue(RESULT);
    const response = await request(
      makeApp(
        {
          type: "board",
          source: "session",
          isInstanceAdmin: false,
          companyIds: ["company-1"],
        },
        reconcile,
      ),
    )
      .post("/api/admin/marketplace/reconcile")
      .send({ scope: "fleet", mode: "repair", operationId: OPERATION_ID });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("instance_admin_required");
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("allows an instance admin and returns the operation artifact", async () => {
    const reconcile = vi.fn().mockResolvedValue(RESULT);
    const response = await request(
      makeApp(
        {
          type: "board",
          source: "session",
          userId: "admin-1",
          isInstanceAdmin: true,
          companyIds: [],
        },
        reconcile,
      ),
    )
      .post("/api/admin/marketplace/reconcile")
      .send({ scope: "fleet", mode: "repair", operationId: OPERATION_ID });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      operationId: OPERATION_ID,
      replayed: false,
      executionDisposition: "started",
      status: "success",
      catalog: {
        canonicalDigestSha256: "a".repeat(64),
      },
    });
    expect(reconcile).toHaveBeenCalledWith(
      { actorType: "user", actorId: "admin-1" },
      OPERATION_ID,
      null,
    );
  });

  it("permits a retry only after re-inspecting the referenced predecessor as safe", async () => {
    const safeInspection: MarketplaceReconciliationInspection = {
      ...INSPECTION,
      state: "outcome_unknown_after_mutation",
      safeToRetry: true,
      retry: {
        kind: "immediate",
        recoveryCode: "retry_now",
        message: "The inspected state is safe to retry.",
      },
    };
    const inspect = vi.fn(async (operationId: string) => {
      if (operationId === OTHER_OPERATION_ID) {
        throw new MarketplaceReconciliationNotFoundError(operationId);
      }
      return safeInspection;
    });
    const reconcile = vi.fn().mockResolvedValue({
      ...RESULT,
      operationId: OTHER_OPERATION_ID,
    });
    const app = makeApp(
      {
        type: "board",
        source: "board_key",
        userId: "admin-1",
        isInstanceAdmin: true,
        companyIds: [],
      },
      reconcile,
      undefined,
      inspect,
    );

    const response = await request(app)
      .post("/api/admin/marketplace/reconcile")
      .send({
        scope: "fleet",
        mode: "repair",
        operationId: OTHER_OPERATION_ID,
        retryOfOperationId: OPERATION_ID,
      });

    expect(response.status).toBe(200);
    expect(inspect).toHaveBeenNthCalledWith(
      1,
      OTHER_OPERATION_ID,
      false,
    );
    expect(inspect).toHaveBeenNthCalledWith(2, OPERATION_ID, false);
    expect(reconcile).toHaveBeenCalledWith(
      { actorType: "user", actorId: "admin-1" },
      OTHER_OPERATION_ID,
      OPERATION_ID,
    );
  });

  it("rejects an unsafe predecessor and an omitted required predecessor", async () => {
    const inspect = vi.fn(async (operationId: string) => {
      if (operationId === OTHER_OPERATION_ID) {
        throw new MarketplaceReconciliationNotFoundError(operationId);
      }
      return {
        ...INSPECTION,
        state: "outcome_unknown_after_mutation" as const,
        safeToRetry: false,
      };
    });
    const reconcile = vi.fn().mockResolvedValue({
      ...RESULT,
      operationId: OTHER_OPERATION_ID,
    });
    const actor = {
      type: "board",
      source: "board_key",
      userId: "admin-1",
      isInstanceAdmin: true,
      companyIds: [],
    };
    const unsafe = await request(
      makeApp(actor, reconcile, undefined, inspect),
    )
      .post("/api/admin/marketplace/reconcile")
      .send({
        scope: "fleet",
        mode: "repair",
        operationId: OTHER_OPERATION_ID,
        retryOfOperationId: OPERATION_ID,
      });

    expect(unsafe.status).toBe(409);
    expect(unsafe.body).toMatchObject({
      error: { code: "outcome_unknown_after_mutation" },
      operationId: OPERATION_ID,
      retry: { kind: "inspect_first" },
    });
    expect(reconcile).not.toHaveBeenCalled();

    const retryRequired = vi
      .fn()
      .mockRejectedValue(
        new MarketplaceReconciliationRetryRequiredError(OPERATION_ID),
      );
    const omitted = await request(makeApp(actor, retryRequired))
      .post("/api/admin/marketplace/reconcile")
      .send({
        scope: "fleet",
        mode: "repair",
        operationId: OTHER_OPERATION_ID,
      });

    expect(omitted.status).toBe(409);
    expect(omitted.body).toMatchObject({
      error: { code: "outcome_unknown_after_mutation" },
      operationId: OPERATION_ID,
    });
  });

  it("joins a concurrent replay to the same operation", async () => {
    let resolveOperation!: (result: MarketplaceReconcileResult) => void;
    const pending = new Promise<MarketplaceReconcileResult>((resolve) => {
      resolveOperation = resolve;
    });
    const reconcile = vi.fn(() => pending);
    let requestsEntered = 0;
    let resolveBothEntered!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      resolveBothEntered = resolve;
    });
    const app = makeApp(
      {
        type: "board",
        source: "session",
        isInstanceAdmin: true,
        companyIds: [],
      },
      reconcile,
      () => {
        requestsEntered += 1;
        if (requestsEntered === 2) resolveBothEntered();
      },
    );

    const first = request(app)
      .post("/api/admin/marketplace/reconcile")
      .send({ scope: "fleet", mode: "repair", operationId: OPERATION_ID });
    const firstResponse = first.then((response) => response);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    const secondResponse = request(app)
      .post("/api/admin/marketplace/reconcile")
      .send({ scope: "fleet", mode: "repair", operationId: OPERATION_ID })
      .then((response) => response);
    await bothEntered;
    expect(reconcile).toHaveBeenCalledTimes(1);

    resolveOperation(RESULT);
    const [firstResult, secondResult] = await Promise.all([
      firstResponse,
      secondResponse,
    ]);

    expect(firstResult.status).toBe(200);
    expect(secondResult.status).toBe(200);
    expect(firstResult.body.operationId).toBe(OPERATION_ID);
    expect(secondResult.body.operationId).toBe(OPERATION_ID);
    expect(
      [firstResult.body.replayed, secondResult.body.replayed].sort(),
    ).toEqual([false, true]);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("rejects a different operation ID while a pass is active", async () => {
    let resolveOperation!: (result: MarketplaceReconcileResult) => void;
    const pending = new Promise<MarketplaceReconcileResult>((resolve) => {
      resolveOperation = resolve;
    });
    const reconcile = vi.fn(() => pending);
    const app = makeApp(
      {
        type: "board",
        source: "board_key",
        userId: "admin-1",
        isInstanceAdmin: true,
        companyIds: [],
      },
      reconcile,
    );
    const first = request(app)
      .post("/api/admin/marketplace/reconcile")
      .send({ scope: "fleet", mode: "repair", operationId: OPERATION_ID });
    const firstResponse = first.then((response) => response);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));

    const conflict = await request(app)
      .post("/api/admin/marketplace/reconcile")
      .send({
        scope: "fleet",
        mode: "repair",
        operationId: OTHER_OPERATION_ID,
      });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      ok: false,
      error: { code: "operation_in_flight" },
      operationId: OPERATION_ID,
    });

    resolveOperation(RESULT);
    expect((await firstResponse).status).toBe(200);
  });

  it("claims the operation before the durable inspection yields", async () => {
    let releaseInspection!: () => void;
    const inspectionPending = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    const inspect = vi.fn(async (operationId: string) => {
      await inspectionPending;
      throw new MarketplaceReconciliationNotFoundError(operationId);
    });
    const reconcile = vi.fn().mockResolvedValue(RESULT);
    const app = makeApp(
      {
        type: "board",
        source: "board_key",
        userId: "admin-1",
        isInstanceAdmin: true,
        companyIds: [],
      },
      reconcile,
      undefined,
      inspect,
    );

    const firstResponse = request(app)
      .post("/api/admin/marketplace/reconcile")
      .send({ scope: "fleet", mode: "repair", operationId: OPERATION_ID })
      .then((response) => response);
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    expect(reconcile).not.toHaveBeenCalled();

    const conflict = await request(app)
      .post("/api/admin/marketplace/reconcile")
      .send({
        scope: "fleet",
        mode: "repair",
        operationId: OTHER_OPERATION_ID,
      });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      error: { code: "operation_in_flight" },
      operationId: OPERATION_ID,
    });
    expect(inspect).toHaveBeenCalledTimes(1);

    releaseInspection();
    expect((await firstResponse).status).toBe(200);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("rejects a completed operation ID on the same router", async () => {
    const reconcile = vi.fn().mockResolvedValue(RESULT);
    const inspect = vi.fn(async (operationId: string) => {
      if (reconcile.mock.calls.length === 0) {
        throw new MarketplaceReconciliationNotFoundError(operationId);
      }
      return INSPECTION;
    });
    const app = makeApp(
      {
        type: "board",
        source: "board_key",
        userId: "admin-1",
        isInstanceAdmin: true,
        companyIds: [],
      },
      reconcile,
      undefined,
      inspect,
    );

    const first = await request(app)
      .post("/api/admin/marketplace/reconcile")
      .send({ scope: "fleet", mode: "repair", operationId: OPERATION_ID });
    const reused = await request(app)
      .post("/api/admin/marketplace/reconcile")
      .send({ scope: "fleet", mode: "repair", operationId: OPERATION_ID });

    expect(first.status).toBe(200);
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({
      error: { code: "invalid_request" },
      operationId: OPERATION_ID,
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("rejects a durably recorded operation ID on a fresh router", async () => {
    const reconcile = vi.fn().mockResolvedValue(RESULT);
    const app = makeApp(
      {
        type: "board",
        source: "board_key",
        userId: "admin-1",
        isInstanceAdmin: true,
        companyIds: [],
      },
      reconcile,
      undefined,
      vi.fn().mockResolvedValue(INSPECTION),
    );

    const response = await request(app)
      .post("/api/admin/marketplace/reconcile")
      .send({ scope: "fleet", mode: "repair", operationId: OPERATION_ID });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("invalid_request");
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("returns the durable active operation ID from another replica", async () => {
    const reconcile = vi.fn().mockRejectedValue(
      new MarketplaceReconciliationInFlightError(OTHER_OPERATION_ID),
    );
    const response = await request(
      makeApp(
        {
          type: "board",
          source: "board_key",
          userId: "admin-1",
          isInstanceAdmin: true,
          companyIds: [],
        },
        reconcile,
      ),
    )
      .post("/api/admin/marketplace/reconcile")
      .send({ scope: "fleet", mode: "repair", operationId: OPERATION_ID });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: { code: "operation_in_flight" },
      operationId: OTHER_OPERATION_ID,
    });
  });

  it("returns the operation ID when maintenance fails", async () => {
    const response = await request(
      makeApp(
        {
          type: "board",
          source: "session",
          isInstanceAdmin: true,
          companyIds: [],
        },
        vi.fn().mockRejectedValue(
          new MarketplaceReconcileExecutionError(
            OPERATION_ID,
            "outcome_unknown_after_mutation",
          ),
        ),
      ),
    )
      .post("/api/admin/marketplace/reconcile")
      .send({ scope: "fleet", mode: "repair", operationId: OPERATION_ID });

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: "outcome_unknown_after_mutation" },
      operationId: OPERATION_ID,
      retry: { kind: "inspect_first" },
    });
  });

  it("returns 502 without running maintenance when catalog refresh fails", async () => {
    const response = await request(
      makeApp(
        {
          type: "board",
          source: "session",
          isInstanceAdmin: true,
          companyIds: [],
        },
        vi.fn().mockRejectedValue(
          new MarketplaceCatalogRefreshError(
            OTHER_OPERATION_ID,
            {
              lastSyncedAt: "2026-07-28T00:00:00.000Z",
              lastSyncStatus: "failure",
              lastSyncError: "network down",
              source: "cdn",
              schemaVersion: "1.0.0",
              itemCount: 0,
            },
            "failure",
            "network down",
          ),
        ),
      ),
    )
      .post("/api/admin/marketplace/reconcile")
      .send({
        scope: "fleet",
        mode: "repair",
        operationId: OTHER_OPERATION_ID,
      });

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: "catalog_temporarily_unavailable" },
      operationId: OTHER_OPERATION_ID,
    });
  });

  it("rejects empty and unknown-field request bodies", async () => {
    const actor = {
      type: "board",
      source: "board_key",
      userId: "admin-1",
      isInstanceAdmin: true,
      companyIds: [],
    };
    const reconcile = vi.fn().mockResolvedValue(RESULT);
    const app = makeApp(actor, reconcile);

    const empty = await request(app)
      .post("/api/admin/marketplace/reconcile")
      .send({});
    const unknown = await request(app)
      .post("/api/admin/marketplace/reconcile")
      .send({
        scope: "fleet",
        mode: "repair",
        operationId: OPERATION_ID,
        force: true,
      });

    expect(empty.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(empty.body.error.code).toBe("invalid_request");
    expect(reconcile).not.toHaveBeenCalled();
  });

  it.each([
    { type: "agent", source: "api_key", companyId: "company-1" },
    { type: "mcp", source: "mcp_token", companyId: "company-1" },
  ])("rejects a $type actor before reconciliation", async (actor) => {
    const reconcile = vi.fn().mockResolvedValue(RESULT);
    const response = await request(makeApp(actor, reconcile))
      .post("/api/admin/marketplace/reconcile")
      .send({ scope: "fleet", mode: "repair", operationId: OPERATION_ID });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("instance_admin_required");
    expect(reconcile).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "malformed JSON",
      body: '{"scope":',
      status: 400,
    },
    {
      name: "an oversized body",
      body: JSON.stringify({ padding: "x".repeat(110_000) }),
      status: 413,
    },
  ])("returns the strict error contract for $name", async ({ body, status }) => {
    const reconcile = vi.fn().mockResolvedValue(RESULT);
    const response = await request(
      makeApp(
        {
          type: "board",
          source: "board_key",
          userId: "admin-1",
          isInstanceAdmin: true,
          companyIds: [],
        },
        reconcile,
      ),
    )
      .post("/api/admin/marketplace/reconcile")
      .set("Content-Type", "application/json")
      .send(body);

    expect(response.status).toBe(status);
    expect(() =>
      MarketplaceReconcileErrorResponseSchema.parse(response.body),
    ).not.toThrow();
    expect(response.body.error.code).toBe("invalid_request");
    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/marketplace/reconciliations/:operationId", () => {
  it("returns a strict read-only inspection for an instance admin", async () => {
    const inspection: MarketplaceReconciliationInspection = {
      operationId: OPERATION_ID,
      state: "partial",
      startedAt: "2026-07-28T00:00:00.000Z",
      completedAt: "2026-07-28T00:00:01.000Z",
      deploymentSha: "reviewed-sha",
      targetCount: 1,
      targets: [
        {
          companyId: "company-1",
          crewState: "blocked",
          diagnosticCode: "unaccounted_crew_rows",
        },
      ],
      safeToRetry: false,
      retry: {
        kind: "inspect_first",
        recoveryCode: "inspect_operation",
        message: "Inspect the operation before retrying.",
      },
    };
    const inspect = vi.fn().mockResolvedValue(inspection);
    const app = makeApp(
      {
        type: "board",
        source: "board_key",
        userId: "admin-1",
        isInstanceAdmin: true,
        companyIds: [],
      },
      vi.fn().mockResolvedValue(RESULT),
      undefined,
      inspect,
    );

    const response = await request(app).get(
      `/api/admin/marketplace/reconciliations/${OPERATION_ID}`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual(inspection);
    expect(inspect).toHaveBeenCalledWith(OPERATION_ID, false);
  });

  it("returns the strict not-found contract", async () => {
    const app = makeApp(
      {
        type: "board",
        source: "board_key",
        userId: "admin-1",
        isInstanceAdmin: true,
        companyIds: [],
      },
      vi.fn().mockResolvedValue(RESULT),
    );
    const response = await request(app).get(
      `/api/admin/marketplace/reconciliations/${OTHER_OPERATION_ID}`,
    );
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: "operation_not_found" },
      operationId: OTHER_OPERATION_ID,
    });
  });

  it.each([
    {
      actor: { type: "none", source: "none" },
      status: 401,
      code: "authentication_required",
    },
    {
      actor: {
        type: "board",
        source: "session",
        isInstanceAdmin: false,
        companyIds: ["company-1"],
      },
      status: 403,
      code: "instance_admin_required",
    },
  ])(
    "protects inspection with the instance-admin boundary",
    async ({ actor, status, code }) => {
      const inspect = vi.fn().mockResolvedValue(INSPECTION);
      const response = await request(
        makeApp(
          actor,
          vi.fn().mockResolvedValue(RESULT),
          undefined,
          inspect,
        ),
      ).get(`/api/admin/marketplace/reconciliations/${OPERATION_ID}`);

      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe(code);
      expect(inspect).not.toHaveBeenCalled();
    },
  );
});
