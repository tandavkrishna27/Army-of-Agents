import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@armyofagents/db";
import { universeAttentionProjectionService } from "../services/universe-attention-projection.js";
import { universeAttentionRoutes } from "../routes/universe-attention.js";

const now = new Date("2026-09-20T10:00:00.000Z");

function hub(overrides: Record<string, unknown>) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    userId: "u1",
    type: "test",
    title: "Attention",
    message: null,
    relatedEntityType: null,
    relatedEntityId: null,
    readAt: null,
    dismissedAt: null,
    deliveryAttempts: 0,
    deliveredAt: null,
    deliveryError: null,
    createdAt: now,
    semanticType: "approval_request",
    status: "open",
    priority: "high",
    groupKey: null,
    slaAt: null,
    sourceType: "approval",
    sourceId: "22222222-2222-4222-8222-222222222222",
    scopeKey: null,
    sourceUniqueKey: "k",
    summary: "Review this",
    sourcePermissionRevision: null,
    ownerUserId: "u1",
    ownerPool: null,
    claimedByUserId: null,
    claimedAt: null,
    version: 3,
    resolvedAt: null,
    archivedAt: null,
    curationGroupLabel: null,
    curationGroupSummary: null,
    curationReason: null,
    curationPriorityReason: null,
    curationRevision: 0,
    curatedAt: null,
    curatedByAgentId: null,
    lane: "waiting_on_you",
    snoozedUntil: null,
    groupLabel: null,
    groupCount: null,
    ...overrides,
  };
}

describe("Universe attention projection", () => {
  it("uses the authorized Hub query and includes only verified ready types", async () => {
    const queryHub = vi.fn(async (_companyId: string, options: { lane?: string }) => ({
      items: options.lane === "waiting_on_you"
        ? [hub({})]
        : [
            hub({ id: "33333333-3333-4333-8333-333333333333", semanticType: "run_complete", sourceType: "heartbeat_run", sourceId: "run-1", title: "Ready" }),
            hub({ id: "44444444-4444-4444-8444-444444444444", semanticType: "run_failed", title: "Not ready" }),
          ],
      nextCursor: null,
      totalKnown: null,
    }));
    const queryRoutines = vi.fn(async () => [{
      routineId: "55555555-5555-4555-8555-555555555555",
      triggerId: "66666666-6666-4666-8666-666666666666",
      title: "Daily review",
      nextRunAt: new Date("2026-09-20T11:00:00.000Z"),
      updatedAt: now,
    }]);
    const result = await universeAttentionProjectionService({} as Db, {
      queryHub: queryHub as never,
      queryRoutines,
      now: () => now,
    }).get({ companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", actorUserId: "u1", role: "team_member" });

    expect(queryHub).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ actorUserId: "u1", role: "team_member" }));
    expect(result.needsYou).toHaveLength(1);
    expect(result.needsYou[0]?.sourceRef).toEqual({ kind: "approval", id: "22222222-2222-4222-8222-222222222222" });
    expect(result.ready.map((entry) => entry.title)).toEqual(["Ready"]);
    expect(result.comingUp[0]?.sourceRef).toEqual({ kind: "routine", id: "55555555-5555-4555-8555-555555555555" });
  });

  it("serves no-store data without invoking a mutation route", async () => {
    const get = vi.fn(async () => ({ asOf: now.toISOString(), needsYou: [], ready: [], comingUp: [], nextCursor: null }));
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    const checkpoints = {
      get: vi.fn(async () => ({ revision: 0, lastAcknowledgedAt: null })),
      issueToken: vi.fn(() => "signed-token"),
      acknowledge: vi.fn(),
    };
    app.use(universeAttentionRoutes({} as Db, { projection: { get }, checkpoints }));

    const response = await request(app).get("/companies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/universe/attention");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ role: "founder", actorUserId: "local-board" }));
    expect(response.body).toMatchObject({ checkpoint: { revision: 0 }, checkpointToken: "signed-token" });
  });

  it("advances read history only through the explicit checkpoint route", async () => {
    const projection = { get: vi.fn() };
    const checkpoints = {
      get: vi.fn(), issueToken: vi.fn(),
      acknowledge: vi.fn(async () => ({ revision: 3, lastAcknowledgedAt: now.toISOString() })),
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    app.use(universeAttentionRoutes({} as Db, { projection, checkpoints }));
    const response = await request(app)
      .post("/companies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/universe/attention/checkpoint")
      .send({ baseRevision: 2, through: "signed-token" });
    expect(response.status).toBe(200);
    expect(checkpoints.acknowledge).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "local-board",
      { baseRevision: 2, through: "signed-token" },
    );
    expect(projection.get).not.toHaveBeenCalled();
  });
});
