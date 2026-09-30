import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { inboxDismissalRoutes } from "../routes/inbox-dismissals.js";

const mockService = vi.hoisted(() => ({
  list: vi.fn(),
  dismiss: vi.fn(),
  undismiss: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  inboxDismissalService: () => mockService,
}));

const COMPANY_A = "11111111-1111-1111-1111-111111111111";

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", inboxDismissalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function boardActor(
  overrides: Partial<{
    userId: string;
    companyIds: string[];
    isInstanceAdmin: boolean;
    source: string;
  }> = {},
) {
  return {
    type: "board" as const,
    userId: overrides.userId ?? "user-1",
    source: overrides.source ?? "session",
    companyIds: overrides.companyIds ?? [COMPANY_A],
    isInstanceAdmin: overrides.isInstanceAdmin ?? false,
  };
}

function fakeDismissal(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date("2026-04-20T00:00:00Z");
  return {
    id: "d-1",
    userId: "user-1",
    companyId: COMPANY_A,
    itemKey: "run:abc",
    dismissedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("inbox dismissal routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET returns current user's dismissals for the company", async () => {
    mockService.list.mockResolvedValue([
      fakeDismissal({ itemKey: "run:a" }),
      fakeDismissal({ itemKey: "stale:b", id: "d-2" }),
    ]);
    const app = createApp(boardActor());
    const res = await request(app).get(
      `/api/companies/${COMPANY_A}/inbox-dismissals`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].itemKey).toBe("run:a");
    expect(mockService.list).toHaveBeenCalledWith("user-1", COMPANY_A);
  });

  it("GET rejects non-board actors", async () => {
    const app = createApp({ type: "none", source: "none" });
    const res = await request(app).get(
      `/api/companies/${COMPANY_A}/inbox-dismissals`,
    );
    expect(res.status).toBe(401);
  });

  it("GET forbids access to a company the user does not belong to", async () => {
    const app = createApp(
      boardActor({ companyIds: ["55555555-5555-5555-5555-555555555555"] }),
    );
    const res = await request(app).get(
      `/api/companies/${COMPANY_A}/inbox-dismissals`,
    );
    expect(res.status).toBe(403);
    expect(mockService.list).not.toHaveBeenCalled();
  });

  it("POST dismisses an item and returns 201", async () => {
    mockService.dismiss.mockResolvedValue(fakeDismissal({ itemKey: "alert:budget" }));
    const app = createApp(boardActor());
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/inbox-dismissals`)
      .send({ itemKey: "alert:budget" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.itemKey).toBe("alert:budget");
    expect(mockService.dismiss).toHaveBeenCalledWith(
      "user-1",
      COMPANY_A,
      "alert:budget",
    );
  });

  it("POST rejects malformed itemKey with 400", async () => {
    const app = createApp(boardActor());
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/inbox-dismissals`)
      .send({ itemKey: "bogus-key-without-prefix" });
    expect(res.status).toBe(400);
    expect(mockService.dismiss).not.toHaveBeenCalled();
  });

  it("POST rejects unknown fields (strict)", async () => {
    const app = createApp(boardActor());
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/inbox-dismissals`)
      .send({ itemKey: "run:x", extra: true });
    expect(res.status).toBe(400);
  });

  it("POST accepts all supported key prefixes", async () => {
    mockService.dismiss.mockImplementation(async (_u, _c, key) =>
      fakeDismissal({ itemKey: key }),
    );
    const app = createApp(boardActor());
    for (const key of [
      "approval:a",
      "join:b",
      "run:c",
      "stale:d",
      "alert:e",
      "discussion:f",
      "issue:g",
    ]) {
      const res = await request(app)
        .post(`/api/companies/${COMPANY_A}/inbox-dismissals`)
        .send({ itemKey: key });
      expect(res.status, `${key}: ${JSON.stringify(res.body)}`).toBe(201);
    }
  });

  it("DELETE undismisses an item and returns 204", async () => {
    mockService.undismiss.mockResolvedValue(undefined);
    const app = createApp(boardActor());
    const res = await request(app).delete(
      `/api/companies/${COMPANY_A}/inbox-dismissals/${encodeURIComponent("run:abc")}`,
    );
    expect(res.status).toBe(204);
    expect(mockService.undismiss).toHaveBeenCalledWith(
      "user-1",
      COMPANY_A,
      "run:abc",
    );
  });

  it("DELETE forbids access to a company the user does not belong to", async () => {
    const app = createApp(
      boardActor({ companyIds: ["55555555-5555-5555-5555-555555555555"] }),
    );
    const res = await request(app).delete(
      `/api/companies/${COMPANY_A}/inbox-dismissals/run:abc`,
    );
    expect(res.status).toBe(403);
    expect(mockService.undismiss).not.toHaveBeenCalled();
  });
});
