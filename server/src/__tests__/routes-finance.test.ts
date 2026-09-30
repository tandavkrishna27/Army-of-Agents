import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { financeRoutes } from "../routes/finance.js";

const mockService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn(),
  byBiller: vi.fn(),
  byKind: vi.fn(),
  list: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/finance.js", () => ({
  financeService: () => mockService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const COMPANY_B = "55555555-5555-5555-5555-555555555555";

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", financeRoutes({} as any));
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

describe("finance routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── POST /companies/:companyId/finance-events ──────────────────────────────

  it("POST /finance-events creates event with required fields", async () => {
    mockService.createEvent.mockResolvedValue({
      id: "fe-1",
      companyId: COMPANY_A,
      biller: "anthropic",
      eventKind: "invoice",
      direction: "debit",
      amountCents: 2500,
    });

    const app = createApp(boardActor());
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/finance-events`)
      .send({
        biller: "anthropic",
        eventKind: "invoice",
        amountCents: 2500,
        occurredAt: "2026-04-21T12:00:00Z",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.id).toBe("fe-1");
    expect(mockService.createEvent).toHaveBeenCalledTimes(1);
    const [, payload] = mockService.createEvent.mock.calls[0];
    expect(payload.biller).toBe("anthropic");
    expect(payload.occurredAt).toBeInstanceOf(Date);
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
  });

  it("POST /finance-events rejects missing eventKind (400 validation)", async () => {
    const app = createApp(boardActor());
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/finance-events`)
      .send({
        biller: "anthropic",
        amountCents: 2500,
        occurredAt: "2026-04-21T12:00:00Z",
      });
    expect(res.status).toBe(400);
    expect(mockService.createEvent).not.toHaveBeenCalled();
  });

  it("POST /finance-events requires board (agent actor → 403)", async () => {
    const app = createApp({
      type: "agent" as const,
      source: "agent-key",
      agentId: "some-agent",
      companyId: COMPANY_A,
    });
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/finance-events`)
      .send({
        biller: "anthropic",
        eventKind: "invoice",
        amountCents: 2500,
        occurredAt: "2026-04-21T12:00:00Z",
      });
    expect(res.status).toBe(403);
    expect(mockService.createEvent).not.toHaveBeenCalled();
  });

  it("POST /finance-events forbids cross-company access", async () => {
    const app = createApp(boardActor({ companyIds: [COMPANY_B] }));
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/finance-events`)
      .send({
        biller: "anthropic",
        eventKind: "invoice",
        amountCents: 2500,
        occurredAt: "2026-04-21T12:00:00Z",
      });
    expect(res.status).toBe(403);
    expect(mockService.createEvent).not.toHaveBeenCalled();
  });

  // ── GET /companies/:companyId/finance/summary ──────────────────────────────

  it("GET /finance/summary returns summary aggregation", async () => {
    mockService.summary.mockResolvedValue({
      companyId: COMPANY_A,
      debitCents: 1000,
      creditCents: 300,
      netCents: 700,
      estimatedDebitCents: 50,
      eventCount: 4,
    });

    const app = createApp(boardActor());
    const res = await request(app).get(`/api/companies/${COMPANY_A}/finance/summary`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.netCents).toBe(700);
    expect(mockService.summary).toHaveBeenCalledWith(COMPANY_A, undefined);
  });

  it("GET /finance/summary with from/to passes range to service", async () => {
    mockService.summary.mockResolvedValue({
      companyId: COMPANY_A,
      debitCents: 0,
      creditCents: 0,
      netCents: 0,
      estimatedDebitCents: 0,
      eventCount: 0,
    });
    const app = createApp(boardActor());
    await request(app)
      .get(`/api/companies/${COMPANY_A}/finance/summary`)
      .query({ from: "2026-04-01T00:00:00Z", to: "2026-04-30T23:59:59Z" });
    const [companyIdArg, rangeArg] = mockService.summary.mock.calls[0];
    expect(companyIdArg).toBe(COMPANY_A);
    expect(rangeArg.from).toBeInstanceOf(Date);
    expect(rangeArg.to).toBeInstanceOf(Date);
  });

  it("GET /finance/summary rejects anonymous actor", async () => {
    const app = createApp({ type: "none", source: "none" });
    const res = await request(app).get(`/api/companies/${COMPANY_A}/finance/summary`);
    expect(res.status).toBe(401);
  });

  // ── GET /companies/:companyId/finance/by-biller ────────────────────────────

  it("GET /finance/by-biller returns aggregation rows", async () => {
    mockService.byBiller.mockResolvedValue([
      { biller: "anthropic", debitCents: 500, creditCents: 0, netCents: 500, eventCount: 2 },
    ]);
    const app = createApp(boardActor());
    const res = await request(app).get(`/api/companies/${COMPANY_A}/finance/by-biller`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].biller).toBe("anthropic");
  });

  // ── GET /companies/:companyId/finance/by-kind ──────────────────────────────

  it("GET /finance/by-kind returns aggregation rows", async () => {
    mockService.byKind.mockResolvedValue([
      { eventKind: "invoice", debitCents: 1000, creditCents: 0, netCents: 1000, eventCount: 3 },
      { eventKind: "credit", debitCents: 0, creditCents: 200, netCents: -200, eventCount: 1 },
    ]);
    const app = createApp(boardActor());
    const res = await request(app).get(`/api/companies/${COMPANY_A}/finance/by-kind`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  // ── GET /companies/:companyId/finance/list ─────────────────────────────────

  it("GET /finance/list returns events with limit/offset", async () => {
    mockService.list.mockResolvedValue([
      { id: "e1", biller: "anthropic", amountCents: 500 },
      { id: "e2", biller: "openai", amountCents: 200 },
    ]);
    const app = createApp(boardActor());
    const res = await request(app)
      .get(`/api/companies/${COMPANY_A}/finance/list`)
      .query({ limit: "25", offset: "50" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(2);
    const [companyIdArg, _rangeArg, optsArg] = mockService.list.mock.calls[0];
    expect(companyIdArg).toBe(COMPANY_A);
    expect(optsArg.limit).toBe(25);
    expect(optsArg.offset).toBe(50);
  });

  it("GET /finance/list forbids cross-company access", async () => {
    const app = createApp(boardActor({ companyIds: [COMPANY_B] }));
    const res = await request(app).get(`/api/companies/${COMPANY_A}/finance/list`);
    expect(res.status).toBe(403);
    expect(mockService.list).not.toHaveBeenCalled();
  });
});
