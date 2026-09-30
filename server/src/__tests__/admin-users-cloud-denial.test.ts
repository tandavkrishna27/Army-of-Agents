import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("@armyofagents/db", () => {
  const makeTable = () =>
    new Proxy({}, { get: (_target, prop) => Symbol(String(prop)) });
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
  and: vi.fn(),
  desc: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
}));

const mockIsInstanceAdmin = vi.hoisted(() => vi.fn());
vi.mock("../services/index.js", () => ({
  accessService: () => ({ isInstanceAdmin: mockIsInstanceAdmin }),
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

function makeApp(db: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "operator-1",
      source: "session",
      operator: true,
      isInstanceAdmin: true,
      companyIds: [],
    };
    next();
  });
  app.use(
    accessRoutes(db, {
      deploymentMode: "cloud_auth",
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

describe("cloud admin-user routes", () => {
  it.each([
    ["get", "/admin/users"],
    ["post", "/admin/users/user-1/promote-instance-admin"],
    ["post", "/admin/users/user-1/demote-instance-admin"],
    ["get", "/admin/users/user-1/company-access"],
    ["put", "/admin/users/user-1/company-access"],
  ] as const)("rejects %s %s before authorization or data reads", async (method, path) => {
    const db = { select: vi.fn() };
    const app = makeApp(db);

    const res = await request(app)[method](path).send(
      method === "put" ? { companyIds: [] } : undefined,
    );

    expect(res.status).toBe(403);
    expect(mockIsInstanceAdmin).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });
});
