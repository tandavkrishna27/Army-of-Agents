import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

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

const { emitHubItemMock, buildJoinRequestHubEmitMock } = vi.hoisted(() => ({
  emitHubItemMock: vi.fn().mockResolvedValue({ id: "hub-1", version: 0 }),
  buildJoinRequestHubEmitMock: vi.fn((row: { id: string }) => ({
    sourceType: "join_request",
    sourceId: row.id,
  })),
}));

vi.mock("../services/hub-source-producers.js", () => ({
  emitHubItem: emitHubItemMock,
  buildJoinRequestHubEmit: buildJoinRequestHubEmitMock,
}));

import {
  buildJoinDefaultsPayloadForAccept,
  canReplayOpenClawInviteAccept,
  mergeJoinDefaultsPayloadForReplay,
} from "../routes/access-helpers.js";
import { accessRoutes } from "../routes/access.js";

const COMPANY_ID = "company-1";
const INVITE_ID = "invite-1";
const JOIN_REQUEST_ID = "join-1";

function makeReplayDb() {
  const invite = {
    id: INVITE_ID,
    companyId: COMPANY_ID,
    inviteType: "company",
    allowedJoinTypes: "agent",
    tokenHash: "hash",
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    acceptedAt: new Date(),
  };
  const existingJoinRequest = {
    id: JOIN_REQUEST_ID,
    inviteId: INVITE_ID,
    companyId: COMPANY_ID,
    requestType: "agent",
    status: "pending_approval",
    requestIp: "127.0.0.1",
    agentName: "Existing OpenClaw",
    adapterType: "openclaw",
    capabilities: null,
    agentDefaultsPayload: { url: "https://old.example/hooks/wake" },
    claimSecretHash: "hidden",
    claimSecretExpiresAt: null,
    createdAgentId: null,
  };
  const replayedJoinRequest = {
    ...existingJoinRequest,
    agentName: "Replayed OpenClaw",
    agentDefaultsPayload: { url: "https://new.example/hooks/wake" },
    updatedAt: new Date(),
  };
  let selectCall = 0;
  const tx: any = {
    update: () => {
      const chain: any = {};
      chain.set = () => chain;
      chain.where = () => chain;
      chain.returning = () => Promise.resolve([replayedJoinRequest]);
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
        if (selectCall === 1) return Promise.resolve([invite]).then(resolve);
        if (selectCall === 2) return Promise.resolve([existingJoinRequest]).then(resolve);
        return Promise.resolve([]).then(resolve);
      };
      return chain;
    },
    transaction: vi.fn(async (callback: (executor: unknown) => Promise<unknown>) => callback(tx)),
  };
  return { db, tx, replayedJoinRequest };
}

function makeApp(db: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "session", userId: "user-1", companyIds: [COMPANY_ID] } as any;
    next();
  });
  app.use(
    accessRoutes(db, {
      deploymentMode: "local",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: ["new.example"],
    }),
  );
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  emitHubItemMock.mockClear();
  buildJoinRequestHubEmitMock.mockClear();
});

describe("canReplayOpenClawInviteAccept", () => {
  it("allows replay only for openclaw agent joins in pending or approved state", () => {
    expect(
      canReplayOpenClawInviteAccept({
        requestType: "agent",
        adapterType: "openclaw",
        existingJoinRequest: {
          requestType: "agent",
          adapterType: "openclaw",
          status: "pending_approval",
        },
      }),
    ).toBe(true);
    expect(
      canReplayOpenClawInviteAccept({
        requestType: "agent",
        adapterType: "openclaw",
        existingJoinRequest: {
          requestType: "agent",
          adapterType: "openclaw",
          status: "approved",
        },
      }),
    ).toBe(true);
    expect(
      canReplayOpenClawInviteAccept({
        requestType: "agent",
        adapterType: "openclaw",
        existingJoinRequest: {
          requestType: "agent",
          adapterType: "openclaw",
          status: "rejected",
        },
      }),
    ).toBe(false);
    expect(
      canReplayOpenClawInviteAccept({
        requestType: "human",
        adapterType: "openclaw",
        existingJoinRequest: {
          requestType: "agent",
          adapterType: "openclaw",
          status: "pending_approval",
        },
      }),
    ).toBe(false);
    expect(
      canReplayOpenClawInviteAccept({
        requestType: "agent",
        adapterType: "process",
        existingJoinRequest: {
          requestType: "agent",
          adapterType: "openclaw",
          status: "pending_approval",
        },
      }),
    ).toBe(false);
  });
});

describe("mergeJoinDefaultsPayloadForReplay", () => {
  it("merges replay payloads and preserves existing fields while allowing auth/header overrides", () => {
    const merged = mergeJoinDefaultsPayloadForReplay(
      {
        url: "https://old.example/v1/responses",
        method: "POST",
        paperclipApiUrl: "http://host.docker.internal:3100",
        headers: {
          "x-openclaw-auth": "old-token",
          "x-custom": "keep-me",
        },
      },
      {
        paperclipApiUrl: "https://paperclip.example.com",
        headers: {
          "x-openclaw-auth": "new-token",
        },
      },
    );

    const normalized = buildJoinDefaultsPayloadForAccept({
      adapterType: "openclaw",
      defaultsPayload: merged,
      inboundOpenClawAuthHeader: null,
    }) as Record<string, unknown>;

    expect(normalized.url).toBe("https://old.example/v1/responses");
    expect(normalized.paperclipApiUrl).toBe("https://paperclip.example.com");
    expect(normalized.webhookAuthHeader).toBe("Bearer new-token");
    expect(normalized.headers).toMatchObject({
      "x-openclaw-auth": "new-token",
      "x-custom": "keep-me",
    });
  });
});

describe("OpenClaw invite accept replay route", () => {
  it("transactionally emits a hub item when replay refreshes a pending join request", async () => {
    const { db, tx, replayedJoinRequest } = makeReplayDb();

    const res = await request(makeApp(db))
      .post("/invites/aoa_invite_replay/accept")
      .set("x-openclaw-auth", "gateway-token")
      .send({
        requestType: "agent",
        adapterType: "openclaw",
        agentName: "Replayed OpenClaw",
        agentDefaultsPayload: {
          url: "https://new.example/hooks/wake",
          headers: { "x-openclaw-auth": "gateway-token" },
        },
      });

    expect(res.status).toBe(202);
    expect(buildJoinRequestHubEmitMock).toHaveBeenCalledWith(replayedJoinRequest);
    expect(emitHubItemMock).toHaveBeenCalledWith(tx, {
      sourceType: "join_request",
      sourceId: JOIN_REQUEST_ID,
    });
  });
});
