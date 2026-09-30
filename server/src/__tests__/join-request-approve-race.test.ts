import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@armyofagents/db", () => {
  const makeTable = () =>
    new Proxy(
      {},
      {
        get: (_target, prop) =>
          prop === "$inferSelect" || prop === "$inferInsert"
            ? {}
            : Symbol(String(prop)),
      },
    );
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

const {
  ensureMembershipMock,
  setPrincipalGrantsMock,
  applyInviteRoleMock,
  listAgentsMock,
  createAgentMock,
  logActivityMock,
  notifyHireApprovedMock,
  reconcileMock,
} = vi.hoisted(() => ({
  ensureMembershipMock: vi.fn(),
  setPrincipalGrantsMock: vi.fn(),
  applyInviteRoleMock: vi.fn(),
  listAgentsMock: vi.fn(),
  createAgentMock: vi.fn(),
  logActivityMock: vi.fn(),
  notifyHireApprovedMock: vi.fn(),
  reconcileMock: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    ensureMembership: ensureMembershipMock,
    setPrincipalGrants: setPrincipalGrantsMock,
  }),
  agentService: () => ({
    list: listAgentsMock,
    create: createAgentMock,
  }),
  deduplicateAgentName: vi.fn((name: string) => name),
  logActivity: logActivityMock,
  notifyHireApproved: notifyHireApprovedMock,
  teamService: () => ({
    applyInviteRole: applyInviteRoleMock,
  }),
}));

vi.mock("../services/hub-source-producers.js", () => ({
  emitHubItem: vi.fn(),
  buildJoinRequestHubEmit: vi.fn(),
}));

vi.mock("../services/hub-items.js", () => ({
  hubItemsService: () => ({
    reconcile: reconcileMock,
  }),
}));

import { accessRoutes } from "../routes/access.js";

const COMPANY_ID = "company-1";
const REQUEST_ID = "join-1";
const INVITE_ID = "invite-1";

function makeStaleApproveDb() {
  const joinRequest = {
    id: REQUEST_ID,
    inviteId: INVITE_ID,
    companyId: COMPANY_ID,
    requestType: "human",
    status: "pending_approval",
    requestingUserId: "user-joiner",
    createdAgentId: null,
  };
  const invite = {
    id: INVITE_ID,
    companyId: COMPANY_ID,
    defaultsPayload: null,
  };
  let selectCall = 0;
  const tx: any = {
    update: () => {
      const chain: any = {};
      chain.set = () => chain;
      chain.where = () => chain;
      chain.returning = () => Promise.resolve([]);
      return chain;
    },
  };
  const db: any = {
    select: () => {
      const chain: any = {};
      chain.from = () => chain;
      chain.where = () => chain;
      chain.then = (resolve: (rows: unknown[]) => unknown) => {
        selectCall += 1;
        if (selectCall === 1) return Promise.resolve([joinRequest]).then(resolve);
        if (selectCall === 2) return Promise.resolve([invite]).then(resolve);
        return Promise.resolve([]).then(resolve);
      };
      return chain;
    },
    transaction: vi.fn(async (callback: (executor: unknown) => Promise<unknown>) =>
      callback(tx),
    ),
  };
  return db;
}

function makeApp(db: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "local_implicit",
      userId: "approver-1",
      companyIds: [COMPANY_ID],
    } as any;
    next();
  });
  app.use(
    accessRoutes(db, {
      deploymentMode: "local",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(err.status ?? 500).json({ error: err.message });
    },
  );
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("join request approval race handling", () => {
  it("does not run approval side effects when the guarded pending claim loses", async () => {
    const db = makeStaleApproveDb();

    const res = await request(makeApp(db))
      .post(`/companies/${COMPANY_ID}/join-requests/${REQUEST_ID}/approve`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Join request is not pending");
    expect(ensureMembershipMock).not.toHaveBeenCalled();
    expect(setPrincipalGrantsMock).not.toHaveBeenCalled();
    expect(applyInviteRoleMock).not.toHaveBeenCalled();
    expect(listAgentsMock).not.toHaveBeenCalled();
    expect(createAgentMock).not.toHaveBeenCalled();
    expect(reconcileMock).not.toHaveBeenCalled();
    expect(logActivityMock).not.toHaveBeenCalled();
    expect(notifyHireApprovedMock).not.toHaveBeenCalled();
  });
});
