import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { universeLayoutRoutes } from "../routes/universe-layout.js";
import { conflict } from "../errors.js";

const mockService = vi.hoisted(() => ({
  get: vi.fn(),
  apply: vi.fn(),
  getReceipt: vi.fn(),
  getCheckpoint: vi.fn(),
  saveCheckpoint: vi.fn(),
}));

vi.mock("../services/universe-layout.js", () => ({
  universeLayoutService: () => mockService,
}));

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const COMPANY_B = "55555555-5555-5555-5555-555555555555";
const CONV = "conv-1";
const layoutPath = (company = COMPANY_A) =>
  `/api/companies/${company}/universe/conversations/${CONV}/layout`;
const validPatch = {
  schemaVersion: 1,
  operationId: "op-1",
  expectedRevision: 0,
  operations: [{ type: "viewport", x: 0, y: 0, zoom: 1 }],
};
const scope = { companyId: COMPANY_A, conversationId: CONV, userId: "user-1" };

function createApp(actor: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor?: unknown }).actor = actor;
    next();
  });
  app.use("/api", universeLayoutRoutes({} as never));
  app.use(errorHandler);
  return app;
}

function boardActor(
  overrides: Partial<{ userId: string | undefined; companyIds: string[] }> = {},
) {
  return {
    type: "board" as const,
    userId: "userId" in overrides ? overrides.userId : "user-1",
    source: "session",
    companyIds: overrides.companyIds ?? [COMPANY_A],
    isInstanceAdmin: false,
  };
}

const agentActor = (companyId: string) => ({
  type: "agent" as const,
  source: "agent-key",
  companyId,
  agentId: "agent-1",
});

describe("universe layout routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET returns the snapshot for the scope", async () => {
    const snapshot = {
      schemaVersion: 1,
      revision: 3,
      document: {
        panels: [],
        order: [],
        selected: null,
        maximized: null,
        viewport: { x: 0, y: 0, zoom: 1 },
        nextOpenedOrdinal: 1,
      },
    };
    mockService.get.mockResolvedValue(snapshot);
    const res = await request(createApp(boardActor())).get(layoutPath());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual(snapshot);
    expect(mockService.get).toHaveBeenCalledWith(scope);
  });

  it("GET rejects none (401), a userless board (401), cross-company and agents (403)", async () => {
    for (const [actor, status] of [
      [{ type: "none", source: "none" }, 401],
      [boardActor({ userId: undefined }), 401],
      [boardActor({ companyIds: [COMPANY_B] }), 403],
      [agentActor(COMPANY_A), 403],
    ] as const) {
      const res = await request(createApp(actor)).get(layoutPath());
      expect(res.status, JSON.stringify(res.body)).toBe(status);
    }
    expect(mockService.get).not.toHaveBeenCalled();
  });

  it("PATCH applies a valid patch and returns the ack", async () => {
    mockService.apply.mockResolvedValue({
      operationId: "op-1",
      revision: 1,
      schemaVersion: 1,
    });
    const res = await request(createApp(boardActor()))
      .patch(layoutPath())
      .send(validPatch);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ operationId: "op-1", revision: 1, schemaVersion: 1 });
    expect(mockService.apply).toHaveBeenCalledWith(scope, validPatch);
  });

  it("PATCH rejects a malformed patch with 400 before touching the service", async () => {
    const res = await request(createApp(boardActor()))
      .patch(layoutPath())
      .send({
        schemaVersion: 1,
        operationId: "op",
        expectedRevision: 0,
        operations: [{ type: "nope" }],
      });
    expect(res.status).toBe(400);
    expect(mockService.apply).not.toHaveBeenCalled();
  });

  it("PATCH surfaces a service conflict as 409", async () => {
    mockService.apply.mockRejectedValue(conflict("Stale revision"));
    const res = await request(createApp(boardActor()))
      .patch(layoutPath())
      .send(validPatch);
    expect(res.status).toBe(409);
  });

  it("GET receipt returns 404 when unknown and the ack when present", async () => {
    mockService.getReceipt.mockResolvedValue(null);
    const miss = await request(createApp(boardActor())).get(
      `${layoutPath()}/operations/op-x`,
    );
    expect(miss.status).toBe(404);
    mockService.getReceipt.mockResolvedValue({
      operationId: "op-1",
      revision: 2,
      schemaVersion: 1,
    });
    const hit = await request(createApp(boardActor())).get(
      `${layoutPath()}/operations/op-1`,
    );
    expect(hit.status, JSON.stringify(hit.body)).toBe(200);
    expect(hit.body).toEqual({ operationId: "op-1", revision: 2, schemaVersion: 1 });
  });
});

it("decodes checkpoint key once and derives owner from actor", async () => {
  const key = JSON.stringify([COMPANY_A, "user-1", CONV, "artifact", "id%20literal", "version"]);
  mockService.getCheckpoint.mockResolvedValue(null);
  const response = await request(createApp(boardActor())).get(`/api/companies/${COMPANY_A}/universe/conversations/${CONV}/panels/${encodeURIComponent(key)}/checkpoint?sourceVersionId=version`);
  expect(response.status).toBe(200);
  expect(mockService.getCheckpoint).toHaveBeenCalledWith(scope, key, "version");
});


describe("checkpoint PATCH boundary", () => {
  beforeEach(() => vi.clearAllMocks());
  const version = "22222222-2222-4222-8222-222222222222";
  const key = JSON.stringify([COMPANY_A, "user-1", CONV, "artifact", "id%20literal", version]);
  const path = `/api/companies/${COMPANY_A}/universe/conversations/${CONV}/panels/${encodeURIComponent(key)}/checkpoint`;
  const patch = {sourceVersionId: version, schemaVersion: 1, expectedRevision: 0,
    data: {inputs: {}, selectedRows: [], filters: {}}};

  it("uses the authenticated owner and decoded key for a valid save", async () => {
    const ack = {revision: 1, schemaVersion: 1, data: patch.data};
    mockService.saveCheckpoint.mockResolvedValue(ack);
    const response = await request(createApp(boardActor())).patch(path).send(patch);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(ack);
    expect(mockService.saveCheckpoint).toHaveBeenCalledWith(scope, key, patch);
  });

  it("rejects anonymous, userless, foreign-company, and agent writers before service access", async () => {
    for (const [actor, status] of [
      [{type: "none", source: "none"}, 401],
      [boardActor({userId: undefined}), 401],
      [boardActor({companyIds: [COMPANY_B]}), 403],
      [agentActor(COMPANY_A), 403],
    ] as const) {
      const response = await request(createApp(actor)).patch(path).send(patch);
      expect(response.status).toBe(status);
    }
    expect(mockService.saveCheckpoint).not.toHaveBeenCalled();
  });

  it("rejects unsupported schema and executable/unknown fields before service access", async () => {
    for (const invalid of [
      {...patch, schemaVersion: 2},
      {...patch, data: {...patch.data, execute: "code"}},
      {...patch, userId: "another-user"},
    ]) {
      const response = await request(createApp(boardActor())).patch(path).send(invalid);
      expect(response.status).toBe(400);
    }
    expect(mockService.saveCheckpoint).not.toHaveBeenCalled();
  });
});
