import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createAdminMarketplaceRouter } from "../routes/admin-marketplace.js";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const INSPECTION = {
  operationId: OPERATION_ID,
  state: "running" as const,
  startedAt: "2026-07-28T00:00:00.000Z",
  completedAt: null,
  deploymentSha: "reviewed-sha",
  targetCount: 0,
  targets: [],
  safeToRetry: false,
  retry: {
    kind: "inspect_first" as const,
    recoveryCode: "inspect_operation" as const,
    message: "Inspect the active operation before retrying.",
  },
};

function dbWithSelects(selectResults: unknown[][]) {
  const queue = [...selectResults];
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(queue.shift() ?? [])),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    })),
  } as any;
}

function makeApp(
  db: any,
  inspect: ReturnType<typeof vi.fn>,
  resolveSession?: (req: express.Request) => Promise<any>,
) {
  const app = express();
  app.use(express.json());
  app.use(
    actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession,
    }),
  );
  app.use(boardMutationGuard());
  app.use(
    "/api/admin/marketplace",
    createAdminMarketplaceRouter({
      reconcile: vi.fn(),
      inspect,
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("marketplace admin production auth stack", () => {
  it("accepts a live instance-admin board key", async () => {
    const inspect = vi.fn().mockResolvedValue(INSPECTION);
    const db = dbWithSelects([
      [
        {
          id: "board-key-1",
          userId: "admin-1",
          expiresAt: new Date(Date.now() + 60_000),
        },
      ],
      [{ id: "instance-role-1" }],
      [],
    ]);

    const response = await request(makeApp(db, inspect))
      .get(`/api/admin/marketplace/reconciliations/${OPERATION_ID}`)
      .set("Authorization", "Bearer live-board-key");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(INSPECTION);
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "expired board key",
      selects: [
        [
          {
            id: "expired-key",
            userId: "admin-1",
            expiresAt: new Date(Date.now() - 60_000),
          },
        ],
        [],
        [],
      ],
      token: "expired",
    },
    {
      name: "revoked or unknown key",
      selects: [[], [], []],
      token: "revoked",
    },
    {
      name: "empty bearer",
      selects: [],
      token: "",
    },
  ])("rejects $name", async ({ selects, token }) => {
    const inspect = vi.fn().mockResolvedValue(INSPECTION);
    const response = await request(makeApp(dbWithSelects(selects), inspect))
      .get(`/api/admin/marketplace/reconciliations/${OPERATION_ID}`)
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("authentication_required");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("rejects a valid board key without the instance-admin role", async () => {
    const inspect = vi.fn().mockResolvedValue(INSPECTION);
    const db = dbWithSelects([
      [
        {
          id: "board-key-1",
          userId: "user-1",
          expiresAt: null,
        },
      ],
      [],
      [{ companyId: "company-1" }],
    ]);

    const response = await request(makeApp(db, inspect))
      .get(`/api/admin/marketplace/reconciliations/${OPERATION_ID}`)
      .set("Authorization", "Bearer non-admin-board-key");

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("instance_admin_required");
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "agent key",
      selects: [
        [],
        [
          {
            id: "agent-key-1",
            agentId: "agent-1",
            companyId: "company-1",
          },
        ],
        [
          {
            id: "agent-1",
            companyId: "company-1",
            status: "active",
          },
        ],
      ],
    },
    {
      name: "MCP key",
      selects: [
        [],
        [],
        [
          {
            id: "mcp-key-1",
            userId: "user-1",
            companyId: "company-1",
          },
        ],
      ],
    },
  ])("rejects a $name", async ({ selects }) => {
    const inspect = vi.fn().mockResolvedValue(INSPECTION);
    const response = await request(makeApp(dbWithSelects(selects), inspect))
      .get(`/api/admin/marketplace/reconciliations/${OPERATION_ID}`)
      .set("Authorization", "Bearer non-board-key");

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("instance_admin_required");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("does not fall back to a valid session when an invalid bearer is present", async () => {
    const inspect = vi.fn().mockResolvedValue(INSPECTION);
    const resolveSession = vi.fn().mockResolvedValue({
      user: { id: "admin-1" },
    });
    const response = await request(
      makeApp(dbWithSelects([[], [], []]), inspect, resolveSession),
    )
      .get(`/api/admin/marketplace/reconciliations/${OPERATION_ID}`)
      .set("Authorization", "Bearer invalid");

    expect(response.status).toBe(401);
    expect(resolveSession).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });
});
