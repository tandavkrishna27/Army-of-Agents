import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("@armyofagents/db", () => {
  const makeTable = () =>
    new Proxy({}, { get: (_target, prop) => (prop === "$inferSelect" || prop === "$inferInsert" ? {} : Symbol(String(prop))) });
  return {
    agentApiKeys: makeTable(),
    authUsers: makeTable(),
    companies: makeTable(),
    companyMemberships: makeTable(),
    invites: makeTable(),
    joinRequests: makeTable(),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (..._args: unknown[]) => "and",
  desc: (..._args: unknown[]) => "desc",
  eq: (..._args: unknown[]) => "eq",
  inArray: (..._args: unknown[]) => "inArray",
  isNull: (..._args: unknown[]) => "isNull",
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  agentService: () => ({}),
  deduplicateAgentName: vi.fn(),
  logActivity: vi.fn(),
  notifyHireApproved: vi.fn(),
  teamService: () => ({}),
}));

vi.mock("../services/hub-source-producers.js", () => ({
  emitHubItem: vi.fn(),
  buildJoinRequestHubEmit: vi.fn(),
}));

import { accessRoutes } from "../routes/access.js";

const COMPANY_ID = "company-1";

/**
 * GET /invites/:token resolves the company name via a leftJoin in the invite
 * lookup — the mock db returns joined { invite, companyName } rows.
 */
function makeSummaryDb(rows: unknown[]) {
  const db: any = {
    select: () => {
      const chain: any = {};
      chain.from = () => chain;
      chain.leftJoin = () => chain;
      chain.where = () => chain;
      chain.then = (resolve: (r: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
      return chain;
    },
  };
  return db;
}

function makeApp(db: any) {
  const app = express();
  app.use(express.json());
  app.use(
    accessRoutes(db, {
      deploymentMode: "local",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
  return app;
}

const baseInvite = {
  id: "invite-1",
  companyId: COMPANY_ID,
  inviteType: "company_join",
  allowedJoinTypes: "human",
  defaultsPayload: null,
  tokenHash: "hash",
  revokedAt: null,
  acceptedAt: null,
  expiresAt: new Date(Date.now() + 60_000),
};

describe("GET /invites/:token (public invite summary)", () => {
  it("carries the joined company name so the landing page can name the company", async () => {
    const db = makeSummaryDb([{ invite: baseInvite, companyName: "Acme Rockets" }]);
    const res = await request(makeApp(db)).get("/invites/aoa_invite_x");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "invite-1",
      companyId: COMPANY_ID,
      companyName: "Acme Rockets",
      inviteType: "company_join",
      allowedJoinTypes: "human",
    });
    expect(res.body.onboardingTextPath).toBe("/api/invites/aoa_invite_x/onboarding.txt");
  });

  it("companyName is null when no company row joins (bootstrap invites)", async () => {
    const db = makeSummaryDb([
      { invite: { ...baseInvite, companyId: null, inviteType: "bootstrap_ceo" }, companyName: null },
    ]);
    const res = await request(makeApp(db)).get("/invites/aoa_invite_x");
    expect(res.status).toBe(200);
    expect(res.body.companyName).toBeNull();
  });

  it("404s for expired invites (guard unchanged by the join)", async () => {
    const db = makeSummaryDb([
      { invite: { ...baseInvite, expiresAt: new Date(Date.now() - 60_000) }, companyName: "Acme" },
    ]);
    const res = await request(makeApp(db)).get("/invites/aoa_invite_x");
    expect(res.status).toBe(404);
  });
});
