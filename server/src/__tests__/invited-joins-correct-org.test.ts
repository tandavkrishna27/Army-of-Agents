// Phase 2 Task 11 (security regression suite) — an invited human must land in
// the SAME Organization (tenant) as the company they were invited into, and
// ONLY that org: never a different tenant's org, and never a hardcoded
// default. This is the anti-tenant-hop guarantee for the join-approval seam,
// symmetric with the company-create anti-tenant-hop guarantee already locked
// in by cloud-auth-cutover.test.ts ("uses the SAME org for authz and for the
// written company row").
//
// Exercises the real `approveHumanJoinRequestTx` (used by BOTH the founder
// manual-approve route and the invited-user auto-admit finalize route — see
// server/src/routes/access.ts:2593 and server/src/routes/onboarding-join.ts:212)
// with a fake tx db + hand-rolled service stubs. Mock scaffolding mirrors
// server/src/services/__tests__/join-approval.test.ts (that file owns the
// full behavioral surface of approveHumanJoinRequestTx; this file is a
// narrowly-scoped, explicitly-named regression lock for the org-tenancy
// dimension only — the cross-company "never mixes tenants" case below is not
// covered elsewhere).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => ({
  joinRequests: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
  companies: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
}));
vi.mock("drizzle-orm", () => ({ and: (...a: unknown[]) => a, eq: (...a: unknown[]) => a }));
const reconcile = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../services/hub-items.js", () => ({ hubItemsService: () => ({ reconcile }) }));
const logActivity = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../services/activity-log.js", () => ({ logActivity }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../services/access.js", () => ({ accessService: () => ({}) }));
vi.mock("../services/organization-access.js", () => ({ organizationAccessService: () => ({}) }));
vi.mock("../services/human-capabilities.js", () => ({ humanCapabilitiesService: () => ({}) }));
const materializeCompanyProfile = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../services/team.js", () => ({
  teamService: () => ({}),
  materializeCompanyProfileFromGlobal: materializeCompanyProfile,
  parseInviteRoleMetadata: () => null,
}));

import {
  approveHumanJoinRequestTx,
  autoAdmitApprovalIdentity,
  founderApprovalIdentity,
  type HumanJoinApprovalServices,
} from "../services/join-approval.js";

function makeTxDb(updatedRow: Record<string, unknown> | null) {
  const db = {
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => (updatedRow ? [updatedRow] : []) }) }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  } as never;
  return db;
}

function makeServices(overrides?: Partial<HumanJoinApprovalServices>): HumanJoinApprovalServices {
  return {
    access: { ensureMembership: vi.fn(async () => {}), setPrincipalGrants: vi.fn(async () => {}) },
    team: { applyInviteRole: vi.fn(async () => null) },
    capabilities: { ensureStandardDocuments: vi.fn(async () => {}) },
    orgAccess: { ensureOrgMembership: vi.fn(async () => "membership-id") },
    resolveCompanyOrg: vi.fn(async () => "org-T1"),
    ...overrides,
  } as HumanJoinApprovalServices;
}

const baseArgs = {
  companyId: "company-C1",
  requestId: "r1",
  invite: { id: "i1", defaultsPayload: { teamInvite: { role: "team_member", email: "a@x.com" } } },
};

describe("invited user joins the correct Organization (Task 11 anti-tenant-hop)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ensures org membership for the INVITED COMPANY's tenant, at member role, for the founder-approve path", async () => {
    const services = makeServices();
    const db = makeTxDb({ id: "r1", status: "approved" });
    await approveHumanJoinRequestTx(db, services, {
      ...baseArgs,
      requestingUserId: "u9",
      ...founderApprovalIdentity({ actorUserId: "founder1", localImplicit: false }),
    });
    expect(services.resolveCompanyOrg).toHaveBeenCalledWith("company-C1");
    expect(services.orgAccess.ensureOrgMembership).toHaveBeenCalledWith("org-T1", "u9", "member");
  });

  it("ensures org membership for the auto-admit (verified-email) path too — same seam, same guarantee", async () => {
    const services = makeServices();
    const db = makeTxDb({ id: "r1", status: "approved" });
    await approveHumanJoinRequestTx(db, services, {
      ...baseArgs,
      requestingUserId: "u9",
      ...autoAdmitApprovalIdentity(),
    });
    expect(services.orgAccess.ensureOrgMembership).toHaveBeenCalledWith("org-T1", "u9", "member");
  });

  it("grants BOTH company and org membership so an already-registered invitee passes assertCompanyAccess (Fix 1 anti-lockout)", async () => {
    // This is the positive counterpart to Fix 1's server guard: the invite
    // chokepoint writes the company membership (the piece direct-add also
    // writes) AND the org membership (the piece direct-add OMITS). Both are
    // required by assertCompanyAccess (authz.ts:71), which is why cloud
    // direct-add locks a user out while an invite does not.
    const services = makeServices();
    const db = makeTxDb({ id: "r1", status: "approved" });
    await approveHumanJoinRequestTx(db, services, {
      ...baseArgs,
      requestingUserId: "u9",
      ...autoAdmitApprovalIdentity(),
    });
    // Company membership: (companyId, "user", userId, role, "active").
    expect(services.access.ensureMembership).toHaveBeenCalledWith(
      "company-C1",
      "user",
      "u9",
      "member",
      "active",
    );
    // Org membership for the invited company's own tenant.
    expect(services.orgAccess.ensureOrgMembership).toHaveBeenCalledWith(
      "org-T1",
      "u9",
      "member",
    );
  });

  it("resolves a DIFFERENT company to its OWN org — never mixes tenants across two approvals", async () => {
    const resolveCompanyOrg = vi.fn(async (companyId: string) =>
      companyId === "company-C1" ? "org-T1" : "org-T2",
    );
    const servicesA = makeServices({ resolveCompanyOrg });
    await approveHumanJoinRequestTx(makeTxDb({ id: "r1" }), servicesA, {
      ...baseArgs,
      companyId: "company-C1",
      requestingUserId: "u9",
      ...autoAdmitApprovalIdentity(),
    });
    expect(servicesA.orgAccess.ensureOrgMembership).toHaveBeenCalledWith("org-T1", "u9", "member");

    const servicesB = makeServices({ resolveCompanyOrg });
    await approveHumanJoinRequestTx(makeTxDb({ id: "r2" }), servicesB, {
      ...baseArgs,
      companyId: "company-C2",
      requestId: "r2",
      requestingUserId: "u10",
      ...autoAdmitApprovalIdentity(),
    });
    expect(servicesB.orgAccess.ensureOrgMembership).toHaveBeenCalledWith("org-T2", "u10", "member");
    // Neither call leaked the other tenant's org id.
    expect(servicesA.orgAccess.ensureOrgMembership).not.toHaveBeenCalledWith("org-T2", "u9", "member");
    expect(servicesB.orgAccess.ensureOrgMembership).not.toHaveBeenCalledWith("org-T1", "u10", "member");
  });

  it("does NOT write org membership when the invited company has no resolvable org (no default-org fallback)", async () => {
    const services = makeServices({ resolveCompanyOrg: vi.fn(async () => null) });
    const db = makeTxDb({ id: "r1", status: "approved" });
    const row = await approveHumanJoinRequestTx(db, services, {
      ...baseArgs,
      requestingUserId: "u9",
      ...autoAdmitApprovalIdentity(),
    });
    expect(row).toEqual({ id: "r1", status: "approved" }); // approval still completes
    expect(services.orgAccess.ensureOrgMembership).not.toHaveBeenCalled();
  });

  it("does NOT write org membership when the join-request row was already resolved (race — no side effects at all)", async () => {
    const services = makeServices();
    const db = makeTxDb(null);
    const row = await approveHumanJoinRequestTx(db, services, {
      ...baseArgs,
      requestingUserId: "u9",
      ...autoAdmitApprovalIdentity(),
    });
    expect(row).toBeNull();
    expect(services.resolveCompanyOrg).not.toHaveBeenCalled();
    expect(services.orgAccess.ensureOrgMembership).not.toHaveBeenCalled();
  });
});
