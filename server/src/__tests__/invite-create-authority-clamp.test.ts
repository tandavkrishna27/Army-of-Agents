import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// P1 privilege-escalation clamp (Codex round-5): POST /companies/:cid/invites
// must clamp the invite's requested role + embedded permission grants to the
// CREATOR's own authority, so a non-founder holding only `users:invite` can
// never mint a founder / privileged-grant invite and self-escalate at
// auto-admit time.

vi.mock("@armyofagents/db", () => {
  const makeTable = () =>
    new Proxy(
      {},
      { get: (_t, prop) => (prop === "$inferSelect" || prop === "$inferInsert" ? {} : Symbol(String(prop))) },
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

const { canUserMock, hasPermissionMock, getUserRoleMock, logActivityMock } = vi.hoisted(() => ({
  canUserMock: vi.fn(),
  hasPermissionMock: vi.fn(),
  getUserRoleMock: vi.fn(),
  logActivityMock: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({ canUser: canUserMock, hasPermission: hasPermissionMock }),
  agentService: () => ({}),
  deduplicateAgentName: vi.fn((name: string) => name),
  logActivity: logActivityMock,
  notifyHireApproved: vi.fn(),
  teamService: () => ({ getUserRole: getUserRoleMock }),
}));

vi.mock("../services/hub-source-producers.js", () => ({
  emitHubItem: vi.fn(),
  buildJoinRequestHubEmit: vi.fn(),
}));

import { accessRoutes } from "../routes/access.js";

const COMPANY_ID = "company-1";

// db.insert(invites).values({...}).returning().then(rows => rows[0])
function makeCreateDb(createdRow: Record<string, unknown>) {
  return {
    insert: () => {
      const chain: any = {};
      chain.values = () => chain;
      chain.returning = () => chain;
      chain.then = (resolve: (r: unknown[]) => unknown) => Promise.resolve([createdRow]).then(resolve);
      return chain;
    },
  } as any;
}

const BOARD_CREATOR: Record<string, unknown> = {
  type: "board",
  source: "session",
  userId: "creator-1",
  companyIds: [COMPANY_ID],
  isInstanceAdmin: false,
};

// Agent run actor: no userId (agents can never be founders), company-scoped so
// assertCompanyAccess (authz.ts) passes and assertCompanyPermission takes the
// agent branch (access.hasPermission).
const AGENT_ACTOR: Record<string, unknown> = {
  type: "agent",
  source: "agent_run",
  agentId: "agent-1",
  companyId: COMPANY_ID,
  companyIds: [COMPANY_ID],
};

function makeApp(db: any, actor: Record<string, unknown> = BOARD_CREATOR) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    accessRoutes(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
  return app;
}

const createdRow = {
  id: "invite-1",
  companyId: COMPANY_ID,
  inviteType: "company_join",
  allowedJoinTypes: "human",
  defaultsPayload: { teamInvite: { email: "x@x.com", role: "team_member" } },
  expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
};

/** Configure the creator's effective authority for a test. */
function asCreator(role: "founder" | "team_lead" | "team_member", heldKeys: string[]) {
  getUserRoleMock.mockResolvedValue({ role, projectId: null });
  const keys = new Set(heldKeys);
  canUserMock.mockImplementation(async (_c: string, _u: string, key: string) => keys.has(key));
}

/**
 * Configure an AGENT creator's held permission keys. Both assertCompanyPermission
 * and the round-14 non-privileged grants floor resolve an agent principal via
 * access.hasPermission(companyId, "agent", agentId, permissionKey), so the mock
 * matches on the 4th (permissionKey) argument.
 */
function asAgentHolding(...heldKeys: string[]) {
  const keys = new Set(heldKeys);
  hasPermissionMock.mockImplementation(
    async (_c: string, _pt: string, _pid: string, key: string) => keys.has(key),
  );
}

function post(db: any, body: Record<string, unknown>, actor: Record<string, unknown> = BOARD_CREATOR) {
  return request(makeApp(db, actor)).post(`/companies/${COMPANY_ID}/invites`).send(body);
}

describe("POST /invites — creator-authority clamp (P1)", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("role clamp", () => {
    it("403s when a non-founder (users:invite only) mints a role:founder invite", async () => {
      asCreator("team_member", ["users:invite"]);
      const res = await post(makeCreateDb(createdRow), {
        allowedJoinTypes: "human",
        defaultsPayload: { teamInvite: { email: "mallory@evil.com", role: "founder" } },
      });
      expect(res.status).toBe(403);
    });

    it("allows a non-founder to invite a team_member (intended delegation)", async () => {
      asCreator("team_member", ["users:invite"]);
      const res = await post(makeCreateDb(createdRow), {
        allowedJoinTypes: "human",
        defaultsPayload: { teamInvite: { email: "ada@x.com", role: "team_member" } },
      });
      expect(res.status).toBe(201);
    });

    it("allows a non-founder to invite a team_lead (intended delegation)", async () => {
      asCreator("team_lead", ["users:invite"]);
      const res = await post(makeCreateDb(createdRow), {
        allowedJoinTypes: "human",
        defaultsPayload: { teamInvite: { email: "ada@x.com", role: "team_lead" } },
      });
      expect(res.status).toBe(201);
    });

    it("allows a FOUNDER to mint a role:founder invite (full capability preserved)", async () => {
      asCreator("founder", ["users:invite", "users:manage_permissions"]);
      const res = await post(makeCreateDb(createdRow), {
        allowedJoinTypes: "human",
        defaultsPayload: { teamInvite: { email: "cofounder@x.com", role: "founder" } },
      });
      expect(res.status).toBe(201);
    });
  });

  describe("grants clamp", () => {
    it("403s when a non-founder embeds a grant without users:manage_permissions", async () => {
      asCreator("team_member", ["users:invite"]);
      const res = await post(makeCreateDb(createdRow), {
        allowedJoinTypes: "human",
        defaultsPayload: {
          teamInvite: { email: "ada@x.com", role: "team_member" },
          human: { grants: [{ permissionKey: "tasks:assign" }] },
        },
      });
      expect(res.status).toBe(403);
    });

    it("403s when a non-founder embeds a permission key they do not themselves hold", async () => {
      // Holds users:manage_permissions (may delegate) but NOT joins:approve.
      asCreator("team_member", ["users:invite", "users:manage_permissions"]);
      const res = await post(makeCreateDb(createdRow), {
        allowedJoinTypes: "human",
        defaultsPayload: {
          teamInvite: { email: "ada@x.com", role: "team_member" },
          human: { grants: [{ permissionKey: "joins:approve" }] },
        },
      });
      expect(res.status).toBe(403);
    });

    it("allows a non-founder to embed a grant they hold (with manage_permissions)", async () => {
      asCreator("team_member", ["users:invite", "users:manage_permissions", "tasks:assign"]);
      const res = await post(makeCreateDb(createdRow), {
        allowedJoinTypes: "human",
        defaultsPayload: {
          teamInvite: { email: "ada@x.com", role: "team_member" },
          human: { grants: [{ permissionKey: "tasks:assign" }] },
        },
      });
      expect(res.status).toBe(201);
    });

    it("allows a FOUNDER to embed any grants (full capability preserved)", async () => {
      asCreator("founder", ["users:invite"]); // founder short-circuits held-key checks
      const res = await post(makeCreateDb(createdRow), {
        allowedJoinTypes: "human",
        defaultsPayload: {
          teamInvite: { email: "ada@x.com", role: "team_member" },
          human: { grants: [{ permissionKey: "users:manage_permissions" }, { permissionKey: "joins:approve" }] },
        },
      });
      expect(res.status).toBe(201);
    });
  });

  // Codex round-6 P1: the round-5 clamp only ran for `req.actor.type === "board"`,
  // so an AGENT actor holding users:invite skipped it entirely and could mint a
  // founder / privileged-grant invite. Privileged conferral now requires a
  // founder for EVERY caller type; an agent is never a founder → refused.
  describe("agent-actor bypass (round-6)", () => {
    it("403s when an AGENT mints a role:founder invite (was allowed — the bypass)", async () => {
      hasPermissionMock.mockResolvedValue(true); // agent holds users:invite
      const res = await post(
        makeCreateDb(createdRow),
        {
          allowedJoinTypes: "human",
          defaultsPayload: { teamInvite: { email: "mallory@evil.com", role: "founder" } },
        },
        AGENT_ACTOR,
      );
      expect(res.status).toBe(403);
    });

    it("403s when an AGENT embeds a privileged grant (joins:approve)", async () => {
      hasPermissionMock.mockResolvedValue(true);
      const res = await post(
        makeCreateDb(createdRow),
        {
          allowedJoinTypes: "human",
          defaultsPayload: {
            teamInvite: { email: "mallory@evil.com", role: "team_member" },
            human: { grants: [{ permissionKey: "joins:approve" }] },
          },
        },
        AGENT_ACTOR,
      );
      expect(res.status).toBe(403);
    });

    it("still allows an AGENT to mint an ordinary team_member invite", async () => {
      hasPermissionMock.mockResolvedValue(true);
      const res = await post(
        makeCreateDb(createdRow),
        {
          allowedJoinTypes: "human",
          defaultsPayload: { teamInvite: { email: "ada@x.com", role: "team_member" } },
        },
        AGENT_ACTOR,
      );
      expect(res.status).toBe(201);
    });
  });

  // Codex follow-on: the round-6 predicate only inspected the HUMAN grant vector,
  // so a privileged grant hidden in `agent.grants` slipped the creation clamp — an
  // agent (or a board non-founder who legitimately holds the key) could mint an
  // invite conferring a governance key on a JOINING AGENT with no founder in the
  // loop. The predicate now unions human + agent vectors, so this route requires a
  // founder for a privileged grant in EITHER vector.
  describe("agent grant vector (Codex follow-on)", () => {
    it("403s when an AGENT mints an invite carrying a privileged AGENT grant (joins:approve)", async () => {
      hasPermissionMock.mockResolvedValue(true); // agent holds users:invite
      const res = await post(
        makeCreateDb(createdRow),
        {
          allowedJoinTypes: "both",
          defaultsPayload: {
            teamInvite: { email: "mallory@evil.com", role: "team_member" },
            agent: { grants: [{ permissionKey: "joins:approve" }] },
          },
        },
        AGENT_ACTOR,
      );
      expect(res.status).toBe(403);
    });

    it("403s when a board non-founder holding manage_permissions + joins:approve mints a privileged AGENT grant", async () => {
      // Was 201 before the fix: the non-privileged floor passed (creator holds the
      // key) and the privileged gate ignored the agent vector entirely.
      asCreator("team_lead", ["users:invite", "users:manage_permissions", "joins:approve"]);
      const res = await post(makeCreateDb(createdRow), {
        allowedJoinTypes: "both",
        defaultsPayload: {
          teamInvite: { email: "mallory@evil.com", role: "team_member" },
          agent: { grants: [{ permissionKey: "joins:approve" }] },
        },
      });
      expect(res.status).toBe(403);
    });

    it("allows a FOUNDER to mint a privileged AGENT grant (governed agent hire)", async () => {
      asCreator("founder", ["users:invite"]);
      const res = await post(makeCreateDb(createdRow), {
        allowedJoinTypes: "both",
        defaultsPayload: {
          teamInvite: { email: "cofounder@x.com", role: "team_member" },
          agent: { grants: [{ permissionKey: "joins:approve" }] },
        },
      });
      expect(res.status).toBe(201);
    });

    it("still allows an AGENT to mint an invite with a non-privileged AGENT grant", async () => {
      hasPermissionMock.mockResolvedValue(true);
      const res = await post(
        makeCreateDb(createdRow),
        {
          allowedJoinTypes: "both",
          defaultsPayload: {
            teamInvite: { email: "ada@x.com", role: "team_member" },
            agent: { grants: [{ permissionKey: "tasks:assign" }] },
          },
        },
        AGENT_ACTOR,
      );
      expect(res.status).toBe(201);
    });
  });

  // Codex round-14 P1: the non-privileged grants floor (the "hold users:manage_permissions
  // AND hold each embedded key" block) ran ONLY for `req.actor.type === "board"`, so an
  // AGENT actor was EXEMPT. An agent holding just `users:invite` could embed a NON-privileged
  // grant it does NOT itself hold (agents:create, tasks:assign, tasks:assign_scope) in a
  // HUMAN invite — the privileged gate never fires for non-privileged keys, and the floor
  // skipped agents — so the verified-email auto-admit path (approveHumanJoinRequestTx) applied
  // the grant with no founder review, conferring a capability the agent never held (and, by
  // inviting an email it controls, bootstrapping that capability into a human sockpuppet).
  // The floor now covers agents too, resolving the agent's held keys the SAME way
  // assertCompanyPermission does (access.hasPermission on the "agent" principal). The
  // users:manage_permissions prerequisite is applied to agents identically to the board rule
  // (agents create AGENTS via /api/agents, not via invite grant vectors — no legitimate
  // agent-invite flow embeds grants without manage_permissions).
  describe("agent-actor non-privileged grants floor (round-14 P1)", () => {
    it("403s when an AGENT embeds a NON-privileged grant (agents:create) it does not hold", async () => {
      // Holds users:invite (passes assertCompanyPermission) + users:manage_permissions
      // (passes the delegate prerequisite) but NOT agents:create → the hold-each-key floor
      // must refuse. RED before the fix: the board-only floor skipped agents entirely → 201.
      asAgentHolding("users:invite", "users:manage_permissions");
      const res = await post(
        makeCreateDb(createdRow),
        {
          allowedJoinTypes: "human",
          defaultsPayload: {
            teamInvite: { email: "sock@evil.com", role: "team_member" },
            human: { grants: [{ permissionKey: "agents:create" }] },
          },
        },
        AGENT_ACTOR,
      );
      expect(res.status).toBe(403);
    });

    it("403s when an AGENT embeds tasks:assign it does not hold", async () => {
      asAgentHolding("users:invite", "users:manage_permissions"); // NOT tasks:assign
      const res = await post(
        makeCreateDb(createdRow),
        {
          allowedJoinTypes: "human",
          defaultsPayload: {
            teamInvite: { email: "sock@evil.com", role: "team_member" },
            human: { grants: [{ permissionKey: "tasks:assign" }] },
          },
        },
        AGENT_ACTOR,
      );
      expect(res.status).toBe(403);
    });

    it("403s when an AGENT embeds a grant WITHOUT holding users:manage_permissions", async () => {
      // Holds the embedded key (tasks:assign) but not the manage_permissions prerequisite —
      // matches the board rule: manage_permissions is required to embed ANY grant.
      asAgentHolding("users:invite", "tasks:assign");
      const res = await post(
        makeCreateDb(createdRow),
        {
          allowedJoinTypes: "human",
          defaultsPayload: {
            teamInvite: { email: "ada@x.com", role: "team_member" },
            human: { grants: [{ permissionKey: "tasks:assign" }] },
          },
        },
        AGENT_ACTOR,
      );
      expect(res.status).toBe(403);
    });

    it("allows an AGENT holding users:manage_permissions + the embedded key to delegate it", async () => {
      asAgentHolding("users:invite", "users:manage_permissions", "tasks:assign");
      const res = await post(
        makeCreateDb(createdRow),
        {
          allowedJoinTypes: "human",
          defaultsPayload: {
            teamInvite: { email: "ada@x.com", role: "team_member" },
            human: { grants: [{ permissionKey: "tasks:assign" }] },
          },
        },
        AGENT_ACTOR,
      );
      expect(res.status).toBe(201);
    });

    it("403s when an AGENT embeds an unheld NON-privileged grant in the AGENT vector too", async () => {
      asAgentHolding("users:invite", "users:manage_permissions"); // NOT agents:create
      const res = await post(
        makeCreateDb(createdRow),
        {
          allowedJoinTypes: "both",
          defaultsPayload: {
            teamInvite: { email: "sock@evil.com", role: "team_member" },
            agent: { grants: [{ permissionKey: "agents:create" }] },
          },
        },
        AGENT_ACTOR,
      );
      expect(res.status).toBe(403);
    });
  });
});
