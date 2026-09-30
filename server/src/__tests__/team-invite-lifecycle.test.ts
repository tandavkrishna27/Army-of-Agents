import { describe, it, expect, vi } from "vitest";

// Mock @armyofagents/db to avoid drizzle-orm ESM cycle
vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(prop);
          return cols[prop];
        }
        return undefined;
      },
    });
  };

  return {
    agents: makeTable("agents"),
    authUsers: makeTable("auth_users"),
    companyMemberships: makeTable("company_memberships"),
    instanceUserRoles: makeTable("instance_user_roles"),
    invites: makeTable("invites"),
    issues: makeTable("issues"),
    principalPermissionGrants: makeTable("principal_permission_grants"),
    projects: makeTable("projects"),
    userRoles: makeTable("user_roles"),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (..._args: unknown[]) => "and",
  count: (..._args: unknown[]) => "count",
  eq: (..._args: unknown[]) => "eq",
  inArray: (..._args: unknown[]) => "inArray",
  isNull: (..._args: unknown[]) => "isNull",
  ne: (..._args: unknown[]) => "ne",
  sql: new Proxy(() => "sql", { get: () => () => "sql", apply: () => "sql" }),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

import { accessService } from "../services/access.js";

type MockRow = Record<string, unknown>;

function createSequenceDb(config: {
  selects?: MockRow[][];
  updates?: MockRow[][];
  inserts?: MockRow[][];
  deletes?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  let updateIdx = 0;
  let insertIdx = 0;
  let deleteIdx = 0;
  const selects = config.selects ?? [];
  const updates = config.updates ?? [];
  const inserts = config.inserts ?? [];
  const deletes = config.deletes ?? [];

  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "set", "values", "returning", "innerJoin", "leftJoin", "orderBy", "limit"]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  }

  const db = {
    select: (..._args: unknown[]) => makeChain(() => selects[selectIdx++] ?? []),
    update: (..._args: unknown[]) => makeChain(() => updates[updateIdx++] ?? []),
    insert: (..._args: unknown[]) => makeChain(() => inserts[insertIdx++] ?? []),
    delete: (..._args: unknown[]) => makeChain(() => deletes[deleteIdx++] ?? []),
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      await fn(db);
    },
  };

  return db;
}

const ACTIVE_INVITE = {
  id: "inv-1",
  companyId: "c1",
  inviteType: "company_join",
  tokenHash: "hashed-token",
  allowedJoinTypes: "both",
  defaultsPayload: { teamInvite: { role: "team_member", email: "test@example.com" } },
  expiresAt: new Date(Date.now() + 600_000),
  invitedByUserId: "founder-1",
  revokedAt: null,
  acceptedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("accessService.revokeInvite", () => {
  it("revokes an active invite", async () => {
    const db = createSequenceDb({
      selects: [[{ ...ACTIVE_INVITE }]],
      updates: [[]],
    });
    const svc = accessService(db as any);
    const result = await svc.revokeInvite("c1", "inv-1");
    expect(result.id).toBe("inv-1");
  });

  it("throws when invite not found", async () => {
    const db = createSequenceDb({
      selects: [[]],
    });
    const svc = accessService(db as any);
    await expect(svc.revokeInvite("c1", "nonexistent")).rejects.toThrow("Invite not found");
  });

  it("throws when invite is already accepted", async () => {
    const db = createSequenceDb({
      selects: [[{ ...ACTIVE_INVITE, acceptedAt: new Date() }]],
    });
    const svc = accessService(db as any);
    await expect(svc.revokeInvite("c1", "inv-1")).rejects.toThrow("Cannot revoke an already accepted invite");
  });

  it("throws when invite is already revoked", async () => {
    const db = createSequenceDb({
      selects: [[{ ...ACTIVE_INVITE, revokedAt: new Date() }]],
    });
    const svc = accessService(db as any);
    await expect(svc.revokeInvite("c1", "inv-1")).rejects.toThrow("Invite is already revoked");
  });
});

describe("accessService.resendInvite", () => {
  it("creates new invite after revoking old one", async () => {
    const newInvite = { ...ACTIVE_INVITE, id: "inv-2", tokenHash: "new-hash" };
    const db = createSequenceDb({
      selects: [[{ ...ACTIVE_INVITE }]],
      updates: [[]],  // revoke old
      inserts: [[newInvite]],  // create new
    });
    const svc = accessService(db as any);
    const result = await svc.resendInvite("c1", "inv-1");
    expect(result.invite).toBeDefined();
    expect(result.token).toBeDefined();
    expect(typeof result.token).toBe("string");
  });

  it("preserves defaultsPayload from old invite", async () => {
    const payload = { teamInvite: { role: "team_lead", email: "lead@example.com", projectId: "dept-1" } };
    const oldInvite = { ...ACTIVE_INVITE, defaultsPayload: payload };
    const newInvite = { ...oldInvite, id: "inv-2" };
    const db = createSequenceDb({
      selects: [[oldInvite]],
      updates: [[]],
      inserts: [[newInvite]],
    });
    const svc = accessService(db as any);
    const result = await svc.resendInvite("c1", "inv-1");
    expect(result.invite).toBeDefined();
  });

  it("throws when invite was already accepted", async () => {
    const db = createSequenceDb({
      selects: [[{ ...ACTIVE_INVITE, acceptedAt: new Date() }]],
    });
    const svc = accessService(db as any);
    await expect(svc.resendInvite("c1", "inv-1")).rejects.toThrow("Cannot resend an already accepted invite");
  });

  it("throws when invite not found", async () => {
    const db = createSequenceDb({
      selects: [[]],
    });
    const svc = accessService(db as any);
    await expect(svc.resendInvite("c1", "nonexistent")).rejects.toThrow("Invite not found");
  });

  it("gives a human-only email-bound invite a fresh 7-day expiry on resend", async () => {
    const captured: Record<string, unknown>[] = [];
    const humanInvite = { ...ACTIVE_INVITE, allowedJoinTypes: "human" };
    const newInvite = { ...humanInvite, id: "inv-2" };
    const db = createSequenceDb({
      selects: [[humanInvite]], // defaultsPayload has teamInvite.email
      updates: [[]],
      inserts: [[newInvite]],
    });
    const origInsert = db.insert;
    db.insert = (...args: unknown[]) => {
      const chain = origInsert.call(db, ...args) as Record<string, unknown>;
      const origValues = chain.values as (...a: unknown[]) => unknown;
      chain.values = (vals: Record<string, unknown>) => {
        captured.push(vals);
        return origValues.call(chain, vals);
      };
      return chain as ReturnType<typeof origInsert>;
    };
    const svc = accessService(db as any);
    const before = Date.now();
    await svc.resendInvite("c1", "inv-1");
    const after = Date.now();

    expect(captured).toHaveLength(1);
    const expiresAt = captured[0]!.expiresAt as Date;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + sevenDaysMs);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + sevenDaysMs);
  });

  it("keeps the 10-minute expiry on resend for 'both' join-type invites even with a bound email", async () => {
    const captured: Record<string, unknown>[] = [];
    // ACTIVE_INVITE is allowedJoinTypes: "both" with teamInvite.email set —
    // the agent-join half is gated only by link secrecy, so no 7-day TTL.
    const db = createSequenceDb({
      selects: [[{ ...ACTIVE_INVITE }]],
      updates: [[]],
      inserts: [[{ ...ACTIVE_INVITE, id: "inv-2" }]],
    });
    const origInsert = db.insert;
    db.insert = (...args: unknown[]) => {
      const chain = origInsert.call(db, ...args) as Record<string, unknown>;
      const origValues = chain.values as (...a: unknown[]) => unknown;
      chain.values = (vals: Record<string, unknown>) => {
        captured.push(vals);
        return origValues.call(chain, vals);
      };
      return chain as ReturnType<typeof origInsert>;
    };
    const svc = accessService(db as any);
    const before = Date.now();
    await svc.resendInvite("c1", "inv-1");
    const after = Date.now();

    expect(captured).toHaveLength(1);
    const expiresAt = captured[0]!.expiresAt as Date;
    const tenMinutesMs = 10 * 60 * 1000;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + tenMinutesMs);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + tenMinutesMs);
  });

  it("keeps the 10-minute expiry on resend for invites without a bound email", async () => {
    const captured: Record<string, unknown>[] = [];
    const openInvite = { ...ACTIVE_INVITE, defaultsPayload: { agentMessage: "hi" } };
    const newInvite = { ...openInvite, id: "inv-2" };
    const db = createSequenceDb({
      selects: [[openInvite]],
      updates: [[]],
      inserts: [[newInvite]],
    });
    const origInsert = db.insert;
    db.insert = (...args: unknown[]) => {
      const chain = origInsert.call(db, ...args) as Record<string, unknown>;
      const origValues = chain.values as (...a: unknown[]) => unknown;
      chain.values = (vals: Record<string, unknown>) => {
        captured.push(vals);
        return origValues.call(chain, vals);
      };
      return chain as ReturnType<typeof origInsert>;
    };
    const svc = accessService(db as any);
    const before = Date.now();
    await svc.resendInvite("c1", "inv-1");
    const after = Date.now();

    expect(captured).toHaveLength(1);
    const expiresAt = captured[0]!.expiresAt as Date;
    const tenMinutesMs = 10 * 60 * 1000;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + tenMinutesMs);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + tenMinutesMs);
  });

  it("skips revoking if old invite already revoked", async () => {
    const revokedInvite = { ...ACTIVE_INVITE, revokedAt: new Date() };
    const newInvite = { ...ACTIVE_INVITE, id: "inv-3" };
    const updateCalls: number[] = [];
    const db = createSequenceDb({
      selects: [[revokedInvite]],
      inserts: [[newInvite]],
    });
    const origUpdate = db.update;
    db.update = (...args: unknown[]) => {
      updateCalls.push(1);
      return origUpdate.call(db, ...args);
    };
    const svc = accessService(db as any);
    const result = await svc.resendInvite("c1", "inv-1");
    expect(result.invite).toBeDefined();
    // Should NOT have called update since already revoked
    expect(updateCalls.length).toBe(0);
  });
});
