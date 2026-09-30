import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => ({
  joinRequests: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
}));
vi.mock("drizzle-orm", () => ({ and: (...a: unknown[]) => a, eq: (...a: unknown[]) => a }));
const reconcile = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../hub-items.js", () => ({ hubItemsService: () => ({ reconcile }) }));
const logActivity = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../activity-log.js", () => ({ logActivity }));
const getUserProfile = vi.hoisted(() =>
  vi.fn(async () => ({
    userId: "u1", displayName: "Ada", avatarUrl: null, title: "Engineer",
    bio: "hi", timezone: "Asia/Kolkata",
    // One valid link + one malformed item: the seeding path must parse-filter
    // through humanSocialLinkSchema instead of trusting the stored shape.
    socialLinks: [{ type: "website", label: null, url: "https://ada.dev" }, { bogus: true }],
  })),
);
vi.mock("../user-profiles.js", () => ({ getUserProfile }));
vi.mock("../../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
// buildHumanJoinApprovalServices constructs real services — not used in these tests.
vi.mock("../access.js", () => ({ accessService: () => ({}) }));
// approveHumanJoinRequestTx now delegates company-profile seeding to the shared
// materializeCompanyProfileFromGlobal helper (round-2 dedup) — mock it here and
// assert the invocation; the field copy + socialLinks parse-filter are covered
// by materialize-company-profile.test.ts.
const materializeCompanyProfile = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../team.js", () => ({
  teamService: () => ({}),
  materializeCompanyProfileFromGlobal: materializeCompanyProfile,
  // The shared inviteConfersPrivilegedAuthority predicate (now in join-approval)
  // reads the role via parseInviteRoleMetadata — pure stand-in mirroring the real
  // one (defaults to team_member when a role is absent).
  parseInviteRoleMetadata: (p: Record<string, unknown> | null) => {
    const teamInvite = p && (p as { teamInvite?: { email?: string; role?: string } }).teamInvite;
    if (!teamInvite?.email) return null;
    return { email: teamInvite.email, role: teamInvite.role ?? "team_member", projectId: null, parentId: null };
  },
}));
vi.mock("../human-capabilities.js", () => ({ humanCapabilitiesService: () => ({}) }));

import {
  approveHumanJoinRequestTx,
  autoAdmitApprovalIdentity,
  founderApprovalIdentity,
  grantsFromDefaults,
  inviteConfersPrivilegedAuthority,
} from "../join-approval.js";

function makeTxDb(updatedRow: Record<string, unknown> | null) {
  const setCalls: Array<Record<string, unknown>> = [];
  const db = {
    update: () => ({ set: (v: Record<string, unknown>) => { setCalls.push(v); return { where: () => ({ returning: async () => (updatedRow ? [updatedRow] : []) }) }; } }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  } as never;
  return { db, setCalls };
}

function makeServices() {
  return {
    access: { ensureMembership: vi.fn(async () => {}), setPrincipalGrants: vi.fn(async () => {}) },
    team: { applyInviteRole: vi.fn(async () => null) },
    capabilities: { ensureStandardDocuments: vi.fn(async () => {}) },
    orgAccess: { ensureOrgMembership: vi.fn(async () => "m1") },
    resolveCompanyOrg: vi.fn(async (): Promise<string | null> => "org-t1"),
  };
}

const args = {
  companyId: "c1", requestId: "r1", requestingUserId: "u1",
  invite: {
    id: "i1",
    defaultsPayload: {
      teamInvite: { role: "team_member", email: "ada@x.com" },
      human: { grants: [{ permissionKey: "tasks:assign", scope: null }] },
    } as Record<string, unknown>,
  },
  approvedByUserId: null,
  attributionUserId: null,
  activityActor: { actorType: "system" as const, actorId: "invite_email_match" },
  approvalSource: "invite_email_match" as const,
};

describe("approveHumanJoinRequestTx", () => {
  beforeEach(() => vi.clearAllMocks());

  it("approves: row update + membership + grants + role + seeding + hub + activity", async () => {
    const services = makeServices();
    const { db, setCalls } = makeTxDb({ id: "r1", status: "approved" });
    const row = await approveHumanJoinRequestTx(db, services as never, args);
    expect(row).toEqual({ id: "r1", status: "approved" });
    expect(setCalls[0]).toMatchObject({
      status: "approved",
      approvedByUserId: null,
      approvalSource: "invite_email_match",
    });
    expect(services.access.ensureMembership).toHaveBeenCalledWith("c1", "user", "u1", "member", "active");
    // Task 11: org membership is resolved from the invited COMPANY (c1), never
    // a hardcoded/default org, and applied at "member" role.
    expect(services.resolveCompanyOrg).toHaveBeenCalledWith("c1");
    expect(services.orgAccess.ensureOrgMembership).toHaveBeenCalledWith("org-t1", "u1", "member");
    expect(services.access.setPrincipalGrants).toHaveBeenCalledWith(
      "c1", "user", "u1",
      [{ permissionKey: "tasks:assign", scope: null }],
      null,
    );
    expect(services.team.applyInviteRole).toHaveBeenCalledWith("c1", "u1", args.invite.defaultsPayload, null);
    // seeding is delegated to the shared helper, invoked inside the savepoint with
    // the tx handle + attribution id (the field copy + socialLinks parse-filter are
    // covered by materialize-company-profile.test.ts).
    expect(materializeCompanyProfile).toHaveBeenCalledWith(expect.anything(), "c1", "u1", null);
    expect(services.capabilities.ensureStandardDocuments).toHaveBeenCalledWith("c1", "u1", null);
    expect(reconcile).toHaveBeenCalledWith("c1", { sourceType: "join_request", sourceId: "r1" });
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "join.approved",
      actorType: "system",
      actorId: "invite_email_match",
      details: { requestType: "human", approvalSource: "invite_email_match", inviteId: "i1" },
    }));
  });

  it("returns null (no side effects) when the row is no longer pending (race)", async () => {
    const services = makeServices();
    const { db } = makeTxDb(null);
    const row = await approveHumanJoinRequestTx(db, services as never, args);
    expect(row).toBeNull();
    expect(services.access.ensureMembership).not.toHaveBeenCalled();
    expect(services.resolveCompanyOrg).not.toHaveBeenCalled();
    expect(services.orgAccess.ensureOrgMembership).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("skips org membership (no-op, not a default-org fallback) when the company has no organizationId", async () => {
    const services = makeServices();
    services.resolveCompanyOrg = vi.fn(async () => null);
    const { db } = makeTxDb({ id: "r1", status: "approved" });
    const row = await approveHumanJoinRequestTx(db, services as never, args);
    expect(row).toEqual({ id: "r1", status: "approved" });
    expect(services.orgAccess.ensureOrgMembership).not.toHaveBeenCalled();
  });

  it("seeding failure is non-fatal — approval still completes", async () => {
    const services = makeServices();
    materializeCompanyProfile.mockRejectedValueOnce(new Error("boom"));
    const { db } = makeTxDb({ id: "r1" });
    const row = await approveHumanJoinRequestTx(db, services as never, args);
    expect(row).toEqual({ id: "r1" });
    expect(reconcile).toHaveBeenCalled(); // hub/activity still run
  });
});

describe("approval identity factories", () => {
  it("founderApprovalIdentity: local-implicit board actor without a userId", () => {
    expect(founderApprovalIdentity({ actorUserId: null, localImplicit: true })).toEqual({
      approvedByUserId: "local-board",
      attributionUserId: null,
      activityActor: { actorType: "user", actorId: "board" },
      approvalSource: "founder",
    });
  });

  it("autoAdmitApprovalIdentity: all-null system preset — never impersonates anyone", () => {
    expect(autoAdmitApprovalIdentity()).toEqual({
      approvedByUserId: null,
      attributionUserId: null,
      activityActor: { actorType: "system", actorId: "invite_email_match" },
      approvalSource: "invite_email_match",
    });
  });
});

describe("grantsFromDefaults", () => {
  it("extracts valid grants for the requested key", () => {
    const grants = grantsFromDefaults(
      { human: { grants: [{ permissionKey: "tasks:assign", scope: null }, { permissionKey: "nope" }] } },
      "human",
    );
    expect(grants).toEqual([{ permissionKey: "tasks:assign", scope: null }]);
  });
});

// The single shared "privileged" predicate — the source of truth for all three
// P1 seams (invite-create clamp, auto-admit sink, manual-approve clamp).
describe("inviteConfersPrivilegedAuthority", () => {
  it("true for a role:founder invite", () => {
    expect(
      inviteConfersPrivilegedAuthority({ teamInvite: { email: "a@x.com", role: "founder" } }),
    ).toBe(true);
  });

  it("true for a privileged human grant (users:manage_permissions / joins:approve / users:invite)", () => {
    for (const permissionKey of ["users:manage_permissions", "joins:approve", "users:invite"]) {
      expect(
        inviteConfersPrivilegedAuthority({
          teamInvite: { email: "a@x.com", role: "team_member" },
          human: { grants: [{ permissionKey }] },
        }),
      ).toBe(true);
    }
  });

  // Codex follow-on: the predicate must scan the AGENT grant vector too — the
  // agent-hire approve branch applies `agent.grants` VERBATIM, so a governance
  // key hidden there is just as dangerous as one in `human.grants`.
  it("true for a privileged AGENT grant (users:manage_permissions / joins:approve / users:invite)", () => {
    for (const permissionKey of ["users:manage_permissions", "joins:approve", "users:invite"]) {
      expect(
        inviteConfersPrivilegedAuthority({
          teamInvite: { email: "a@x.com", role: "team_member" },
          agent: { grants: [{ permissionKey }] },
        }),
      ).toBe(true);
    }
  });

  it("false for a team_member invite carrying only a non-privileged AGENT grant", () => {
    expect(
      inviteConfersPrivilegedAuthority({
        teamInvite: { email: "a@x.com", role: "team_member" },
        agent: { grants: [{ permissionKey: "tasks:assign" }] },
      }),
    ).toBe(false);
  });

  it("false for an ordinary team_lead invite", () => {
    expect(
      inviteConfersPrivilegedAuthority({ teamInvite: { email: "a@x.com", role: "team_lead" } }),
    ).toBe(false);
  });

  it("false for a team_member invite carrying only a non-privileged grant", () => {
    expect(
      inviteConfersPrivilegedAuthority({
        teamInvite: { email: "a@x.com", role: "team_member" },
        human: { grants: [{ permissionKey: "tasks:assign" }] },
      }),
    ).toBe(false);
  });

  it("false for a null / empty payload", () => {
    expect(inviteConfersPrivilegedAuthority(null)).toBe(false);
    expect(inviteConfersPrivilegedAuthority({})).toBe(false);
  });
});
