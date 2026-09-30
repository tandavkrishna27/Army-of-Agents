import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => ({
  joinRequests: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
  invites: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
  authUsers: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
}));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a, eq: (...a: unknown[]) => a, desc: (a: unknown) => a,
  gt: (...a: unknown[]) => a, isNull: (...a: unknown[]) => a, inArray: (...a: unknown[]) => a,
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({ sql: strings.join("?"), bindings: vals }),
}));
const claim = vi.hoisted(() =>
  vi.fn(async (): Promise<{ id: string; status: string }> => ({ id: "r9", status: "pending_approval" })),
);
vi.mock("../services/invite-claim.js", () => ({ claimInviteAndFileJoinRequest: claim }));
const approveTx = vi.hoisted(() =>
  vi.fn(async (): Promise<{ id: string; status: string } | null> => ({ id: "r1", status: "approved" })),
);
vi.mock("../services/join-approval.js", () => ({
  approveHumanJoinRequestTx: approveTx,
  buildHumanJoinApprovalServices: () => ({}),
  autoAdmitApprovalIdentity: () => ({
    approvedByUserId: null,
    attributionUserId: null,
    activityActor: { actorType: "system", actorId: "invite_email_match" },
    approvalSource: "invite_email_match",
  }),
  // Faithful-enough stand-in for the real grantsFromDefaults: reads
  // defaultsPayload[key].grants and keeps well-formed { permissionKey } entries.
  grantsFromDefaults: (p: Record<string, unknown> | null, key: "human" | "agent") => {
    const scoped = p && (p as Record<string, unknown>)[key];
    const grants =
      scoped && typeof scoped === "object" && Array.isArray((scoped as { grants?: unknown }).grants)
        ? (scoped as { grants: Array<Record<string, unknown>> }).grants
        : [];
    return grants
      .filter((g) => g && typeof g.permissionKey === "string")
      .map((g) => ({ permissionKey: g.permissionKey as string, scope: null }));
  },
  // Faithful stand-in for the real (shared) predicate: role above team_lead
  // (i.e. founder) OR any privileged human grant. Mirrors the module the finalize
  // route now imports it from.
  inviteConfersPrivilegedAuthority: (p: Record<string, unknown> | null) => {
    const teamInvite = p && (p as { teamInvite?: { role?: string } }).teamInvite;
    const role = teamInvite?.role ?? null;
    if (role === "founder") return true;
    const human = p && (p as { human?: { grants?: unknown } }).human;
    const grants =
      human && typeof human === "object" && Array.isArray((human as { grants?: unknown }).grants)
        ? (human as { grants: Array<Record<string, unknown>> }).grants
        : [];
    const privileged = new Set(["users:manage_permissions", "joins:approve", "users:invite"]);
    return grants.some((g) => typeof g?.permissionKey === "string" && privileged.has(g.permissionKey as string));
  },
}));
vi.mock("../services/team.js", () => ({
  // Reads the role straight from the payload (defaults to team_member) so the
  // privileged-auto-admit sink guard can be exercised for founder-tier roles.
  parseInviteRoleMetadata: (p: Record<string, unknown> | null) => {
    const teamInvite = p && (p as { teamInvite?: { email?: string; role?: string } }).teamInvite;
    if (!teamInvite?.email) return null;
    return { email: teamInvite.email, role: teamInvite.role ?? "team_member", projectId: null, parentId: null };
  },
}));

import { onboardingJoinRoutes } from "../routes/onboarding-join.js";

type Row = Record<string, unknown>;
/**
 * Sequence db: each select() returns the next configured result set. Captures
 * each select's where() condition (in select order) so tests can regression-lock
 * the WHERE bindings — with the mocked `eq`/`and` returning their args, a
 * condition is a nested array of `[{name: column}, value]` pairs.
 */
function createSequenceDb(selects: Row[][]) {
  let i = 0;
  const whereCalls: unknown[] = [];
  const chain = () => {
    const result = selects[i++] ?? [];
    const q = {
      from: () => q,
      where: (cond: unknown) => { whereCalls.push(cond); return q; },
      orderBy: () => q, limit: () => q,
      then: (resolve: (rows: Row[]) => unknown) => resolve(result),
    };
    return q;
  };
  const db = {
    select: chain,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  } as never;
  return { db, whereCalls };
}

function handler(db: never) {
  const router = onboardingJoinRoutes(db);
  const layer = (router as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ handle: unknown }> } }> }).stack
    .find((l) => l.route?.path === "/onboarding/join/finalize");
  if (!layer?.route) throw new Error("route not found");
  return layer.route.stack[0]!.handle as (req: unknown, res: unknown) => Promise<void>;
}

function call(db: never, body: Record<string, unknown>, actor: Record<string, unknown> = { type: "board", userId: "u1" }) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  // header/ip back the requestIp() helper on the tokenless claim path.
  const req = { actor, body, header: () => undefined, ip: "203.0.113.7" };
  return handler(db)(req, { json, status }).then(() => ({ json, status }));
}

const pendingRequest = { id: "r1", inviteId: "i1", status: "pending_approval" };
const validInvite = { id: "i1", revokedAt: null, expiresAt: null, defaultsPayload: { teamInvite: { email: "ada@x.com", role: "team_member" } } };

describe("POST /onboarding/join/finalize", () => {
  beforeEach(() => vi.clearAllMocks());

  it("admits on a verified case-insensitive email match", async () => {
    const { db, whereCalls } = createSequenceDb([
      [pendingRequest],
      [validInvite],
      [{ email: "ADA@X.COM", emailVerified: true }],
    ]);
    const { json } = await call(db, { companyId: "c1" });
    expect(approveTx).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      approvedByUserId: null,
      approvalSource: "invite_email_match",
    }));
    expect(json).toHaveBeenCalledWith({ admitted: true, status: "approved" });
    // Regression-lock the self-scoping WHERE: the request lookup must bind
    // requestingUserId to the acting user ("u1") — never finalize someone
    // else's request.
    const requestLookup = JSON.stringify(whereCalls[0]);
    expect(requestLookup).toContain('"requestingUserId"');
    expect(requestLookup).toContain('"u1"');
  });

  it("does NOT admit when the email is unverified", async () => {
    const { db } = createSequenceDb([
      [pendingRequest],
      [validInvite],
      [{ email: "ada@x.com", emailVerified: false }],
    ]);
    const { json } = await call(db, { companyId: "c1" });
    expect(approveTx).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ admitted: false, status: "pending" });
  });

  it("does NOT admit on an email mismatch", async () => {
    const { db } = createSequenceDb([
      [pendingRequest],
      [validInvite],
      [{ email: "mallory@evil.com", emailVerified: true }],
    ]);
    const { json } = await call(db, { companyId: "c1" });
    expect(approveTx).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ admitted: false, status: "pending" });
  });

  it("refuses a revoked invite", async () => {
    const { db } = createSequenceDb([
      [pendingRequest],
      [{ ...validInvite, revokedAt: new Date() }],
    ]);
    const { json } = await call(db, { companyId: "c1" });
    expect(json).toHaveBeenCalledWith({ admitted: false, status: "invite_invalid" });
  });

  it("admits even when expiresAt has passed — validity was established at accept (payload-aware TTL)", async () => {
    const { db } = createSequenceDb([
      [pendingRequest],
      [{ ...validInvite, expiresAt: new Date(Date.now() - 60_000) }],
      [{ email: "ada@x.com", emailVerified: true }],
    ]);
    const { json } = await call(db, { companyId: "c1" });
    expect(json).toHaveBeenCalledWith({ admitted: true, status: "approved" });
  });

  it("is idempotent — an already-approved request reports admitted", async () => {
    const { db } = createSequenceDb([[{ ...pendingRequest, status: "approved" }]]);
    const { json } = await call(db, { companyId: "c1" });
    expect(json).toHaveBeenCalledWith({ admitted: true, status: "approved" });
    expect(approveTx).not.toHaveBeenCalled();
  });

  it("reports a rejected request", async () => {
    const { db } = createSequenceDb([[{ ...pendingRequest, status: "rejected" }]]);
    const { json } = await call(db, { companyId: "c1" });
    expect(json).toHaveBeenCalledWith({ admitted: false, status: "rejected" });
  });

  it("401s without a board session", async () => {
    const { db } = createSequenceDb([]);
    const { status } = await call(db, { companyId: "c1" }, { type: "none" });
    expect(status).toHaveBeenCalledWith(401);
  });

  it("404s when the caller has no join request for the company", async () => {
    const { db } = createSequenceDb([[]]);
    const { status } = await call(db, { companyId: "c1" });
    expect(status).toHaveBeenCalledWith(404);
  });

  it("400s when companyId is missing", async () => {
    const { db } = createSequenceDb([]);
    const { status } = await call(db, {});
    expect(status).toHaveBeenCalledWith(400);
  });

  describe("tokenless entry (no filed join_request)", () => {
    const openInvite = {
      id: "i9",
      companyId: "c1",
      revokedAt: null,
      defaultsPayload: { teamInvite: { email: "ada@x.com", role: "team_member" } },
    };

    it("claims a matching open invite, files the request, then admits", async () => {
      const { db } = createSequenceDb([
        [], // no join_request for the company
        [{ email: "ada@x.com", emailVerified: true }], // caller (tokenless lookup)
        [openInvite], // open invite matched by verified email
        [{ ...validInvite, id: "i9" }], // invite re-select (existing finalize flow)
        [{ email: "ADA@X.COM", emailVerified: true }], // caller re-select (existing flow)
      ]);
      const { json } = await call(db, { companyId: "c1", acceptOpenInvite: true });
      expect(claim).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          inviteId: "i9",
          companyId: "c1",
          userId: "u1",
          email: "ada@x.com",
          requestIp: "203.0.113.7",
        }),
      );
      expect(approveTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ requestId: "r9" }),
      );
      expect(json).toHaveBeenCalledWith({ admitted: true, status: "approved" });
    });

    it("short-circuits admitted when the claim's race winner is already approved", async () => {
      claim.mockResolvedValueOnce({ id: "r9", status: "approved" });
      const { db } = createSequenceDb([
        [],
        [{ email: "ada@x.com", emailVerified: true }],
        [openInvite],
      ]);
      const { json } = await call(db, { companyId: "c1", acceptOpenInvite: true });
      expect(json).toHaveBeenCalledWith({ admitted: true, status: "approved" });
      expect(approveTx).not.toHaveBeenCalled();
    });

    it("404s when no open invite matches either", async () => {
      const { db } = createSequenceDb([
        [], // no join_request
        [{ email: "ada@x.com", emailVerified: true }],
        [], // no open invite
      ]);
      const { status } = await call(db, { companyId: "c1", acceptOpenInvite: true });
      expect(status).toHaveBeenCalledWith(404);
      expect(claim).not.toHaveBeenCalled();
    });

    it("never claims for an unverified email (invite lookup skipped)", async () => {
      const { db } = createSequenceDb([
        [], // no join_request
        [{ email: "ada@x.com", emailVerified: false }],
        // Would-be open invite: MUST NOT be consumed — the lookup is gated on a
        // verified email.
        [openInvite],
      ]);
      const { status } = await call(db, { companyId: "c1", acceptOpenInvite: true });
      expect(status).toHaveBeenCalledWith(404);
      expect(claim).not.toHaveBeenCalled();
    });

    it("refuses the claim without acceptOpenInvite — 404, no leak, no lookup", async () => {
      // Same shape as the successful case above (a matching open invite DOES
      // exist), but the flag is absent. Only one select is configured — a
      // caller/openInvite lookup would exhaust it and fail the test, proving
      // the gate short-circuits before any query.
      const { db } = createSequenceDb([
        [], // no join_request
      ]);
      const { status, json } = await call(db, { companyId: "c1" });
      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ error: "no join request or open invitation for this company" });
      expect(claim).not.toHaveBeenCalled();
    });

    it("expiry gates the tokenless path — the open-invite lookup binds expiresAt (an expired invite → 404)", async () => {
      // The sequence db can't evaluate SQL: an EXPIRED invite comes back as an
      // empty result set. Regression-lock the WHERE bindings instead — unlike
      // the filed-request path above (validity established at token accept),
      // the tokenless lookup must re-check expiry at claim time.
      const { db, whereCalls } = createSequenceDb([
        [], // no join_request
        [{ email: "ada@x.com", emailVerified: true }],
        [], // the expired invite is excluded by SQL
      ]);
      const { status } = await call(db, { companyId: "c1", acceptOpenInvite: true });
      expect(status).toHaveBeenCalledWith(404);
      expect(claim).not.toHaveBeenCalled();
      const inviteLookup = JSON.stringify(whereCalls[2]);
      expect(inviteLookup).toContain('"expiresAt"');
      expect(inviteLookup).toContain('"acceptedAt"');
      expect(inviteLookup).toContain('"revokedAt"');
      expect(inviteLookup).toContain('"inviteType"');
      expect(inviteLookup).toContain('"allowedJoinTypes"');
      // Trim parity with the admit gate: both sides of the email match are
      // btrim()ed in SQL, so a padded invite email still matches.
      expect(inviteLookup).toContain("btrim");
    });
  });

  describe("rejected-then-reinvited (newest request rejected, fresh open invite)", () => {
    const freshInvite = {
      id: "i9",
      companyId: "c1",
      revokedAt: null,
      defaultsPayload: { teamInvite: { email: "ada@x.com", role: "team_member" } },
    };

    it("claims the fresh invite and continues (admits on a verified match)", async () => {
      const { db } = createSequenceDb([
        [{ ...pendingRequest, status: "rejected" }], // newest request = rejected
        [{ email: "ada@x.com", emailVerified: true }], // caller (open-invite lookup)
        [freshInvite], // fresh open invite (the rejected one was consumed at accept)
        [{ ...validInvite, id: "i9" }], // invite re-select (existing finalize flow)
        [{ email: "ADA@X.COM", emailVerified: true }], // caller re-select (existing flow)
      ]);
      const { json } = await call(db, { companyId: "c1", acceptOpenInvite: true });
      expect(claim).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ inviteId: "i9", companyId: "c1", userId: "u1" }),
      );
      expect(approveTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ requestId: "r9" }),
      );
      expect(json).toHaveBeenCalledWith({ admitted: true, status: "approved" });
    });

    it("stays rejected when NO open invite exists (no dead-end escape without a re-invite)", async () => {
      const { db } = createSequenceDb([
        [{ ...pendingRequest, status: "rejected" }],
        [{ email: "ada@x.com", emailVerified: true }],
        [], // no open invite
      ]);
      const { json } = await call(db, { companyId: "c1", acceptOpenInvite: true });
      expect(json).toHaveBeenCalledWith({ admitted: false, status: "rejected" });
      expect(claim).not.toHaveBeenCalled();
      expect(approveTx).not.toHaveBeenCalled();
    });

    it("refuses the claim without acceptOpenInvite — plain rejected passthrough, no lookup", async () => {
      // A fresh open invite DOES exist (same shape as the successful case
      // above), but the flag is absent. Only the rejected request is
      // configured — a caller/open-invite lookup would exhaust the sequence
      // and fail the test, proving the gate short-circuits before any query.
      const { db } = createSequenceDb([[{ ...pendingRequest, status: "rejected" }]]);
      const { json } = await call(db, { companyId: "c1" });
      expect(json).toHaveBeenCalledWith({ admitted: false, status: "rejected" });
      expect(claim).not.toHaveBeenCalled();
      expect(approveTx).not.toHaveBeenCalled();
    });
  });

  describe("privileged auto-admit refusal (P1 defense-in-depth sink)", () => {
    const callerVerified = { email: "ada@x.com", emailVerified: true };

    it("does NOT auto-admit a founder-role invite even on a verified email match", async () => {
      const founderInvite = {
        id: "i1",
        revokedAt: null,
        expiresAt: null,
        defaultsPayload: { teamInvite: { email: "ada@x.com", role: "founder" } },
      };
      const { db } = createSequenceDb([[pendingRequest], [founderInvite], [callerVerified]]);
      const { json } = await call(db, { companyId: "c1" });
      expect(approveTx).not.toHaveBeenCalled();
      expect(json).toHaveBeenCalledWith({ admitted: false, status: "pending" });
    });

    it("does NOT auto-admit an invite carrying a privileged grant (users:manage_permissions)", async () => {
      const privilegedGrantInvite = {
        id: "i1",
        revokedAt: null,
        expiresAt: null,
        defaultsPayload: {
          teamInvite: { email: "ada@x.com", role: "team_member" },
          human: { grants: [{ permissionKey: "users:manage_permissions" }] },
        },
      };
      const { db } = createSequenceDb([[pendingRequest], [privilegedGrantInvite], [callerVerified]]);
      const { json } = await call(db, { companyId: "c1" });
      expect(approveTx).not.toHaveBeenCalled();
      expect(json).toHaveBeenCalledWith({ admitted: false, status: "pending" });
    });

    it("REGRESSION: still auto-admits an ordinary team_lead invite on a verified match", async () => {
      const leadInvite = {
        id: "i1",
        revokedAt: null,
        expiresAt: null,
        defaultsPayload: { teamInvite: { email: "ada@x.com", role: "team_lead" } },
      };
      const { db } = createSequenceDb([[pendingRequest], [leadInvite], [callerVerified]]);
      const { json } = await call(db, { companyId: "c1" });
      expect(approveTx).toHaveBeenCalled();
      expect(json).toHaveBeenCalledWith({ admitted: true, status: "approved" });
    });

    it("REGRESSION: still auto-admits a non-privileged grant (tasks:assign) on a verified match", async () => {
      const okGrantInvite = {
        id: "i1",
        revokedAt: null,
        expiresAt: null,
        defaultsPayload: {
          teamInvite: { email: "ada@x.com", role: "team_member" },
          human: { grants: [{ permissionKey: "tasks:assign" }] },
        },
      };
      const { db } = createSequenceDb([[pendingRequest], [okGrantInvite], [callerVerified]]);
      const { json } = await call(db, { companyId: "c1" });
      expect(approveTx).toHaveBeenCalled();
      expect(json).toHaveBeenCalledWith({ admitted: true, status: "approved" });
    });
  });

  it("reports pending when the approval races to null", async () => {
    // approveHumanJoinRequestTx resolves null when the request was concurrently
    // consumed — the endpoint must report the honest non-admitted state.
    approveTx.mockResolvedValueOnce(null);
    const { db } = createSequenceDb([
      [pendingRequest],
      [validInvite],
      [{ email: "ada@x.com", emailVerified: true }],
    ]);
    const { json } = await call(db, { companyId: "c1" });
    expect(json).toHaveBeenCalledWith({ admitted: false, status: "pending" });
  });
});
