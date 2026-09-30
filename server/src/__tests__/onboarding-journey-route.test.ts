import express from "express";
import request from "supertest";
import { describe, it, expect } from "vitest";
import {
  getJourneyForUser as getJourneyForUserImpl,
  onboardingJourneyRoutes,
} from "../routes/onboarding-journey.js";

type JourneyArgs = Parameters<typeof getJourneyForUserImpl>[1];
type TestJourneyArgs = Omit<JourneyArgs, "authorizedCompanyIds"> & {
  authorizedCompanyIds?: readonly string[];
};

function getJourneyForUser(db: any, args: TestJourneyArgs) {
  const {
    authorizedCompanyIds = ["c1", "member-company"],
    ...rest
  } = args;
  return getJourneyForUserImpl(db, { ...rest, authorizedCompanyIds });
}

// Sequence mock: each awaited query resolves the next canned result set.
// `_whereCalls` / `_orderByCalls` capture each where()/orderBy() argument list
// (REAL drizzle-orm SQL objects — this file does not mock drizzle) so tests
// can regression-lock query gates and ordering.
//
// Call order inside getJourneyForUser (Phase 2 Task 9 — org-first): user row,
// THEN company memberships + organization memberships together (a
// Promise.all — company memberships resolves first, org memberships
// second, matching array-literal evaluation order), THEN filed
// join_requests ("pendingRows"), THEN (if emailVerified) open invites, THEN
// (if returningCompanyIds is empty and the caller is instance-admin) the
// admin-visible-companies fallback, THEN (if journey === "returning" with a
// company id) the first-run resume query.
function seqDb(results: unknown[][]) {
  let i = 0;
  const whereCalls: unknown[] = [];
  const orderByCalls: unknown[][] = [];
  const builder = (): any =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => void) => resolve(results[i++] ?? []);
          }
          if (prop === "where") {
            return (cond: unknown) => {
              whereCalls.push(cond);
              return builder();
            };
          }
          if (prop === "orderBy") {
            return (...args: unknown[]) => {
              orderByCalls.push(args);
              return builder();
            };
          }
          return () => builder();
        },
      },
    );
  return { select: () => builder(), _whereCalls: whereCalls, _orderByCalls: orderByCalls } as any;
}

/**
 * Recursively collect the DB column names bound in a real drizzle-orm SQL
 * condition (Columns carry `name` + `table`; SQL nodes carry `queryChunks`).
 */
function conditionColumns(cond: unknown): string[] {
  const out: string[] = [];
  const walk = (c: unknown) => {
    if (!c || typeof c !== "object") return;
    const rec = c as Record<string, unknown>;
    if (typeof rec.name === "string" && rec.table) out.push(rec.name);
    if (Array.isArray(rec.queryChunks)) rec.queryChunks.forEach(walk);
  };
  walk(cond);
  return out;
}

/**
 * Recursively collect the literal SQL text chunks of a real drizzle-orm SQL
 * node (StringChunks carry `value: string[]`) — regression-locks raw SQL like
 * `btrim(...)` and `desc` without stringifying circular Column/Table refs.
 */
function sqlText(node: unknown): string {
  const out: string[] = [];
  const walk = (c: unknown) => {
    if (!c) return;
    if (Array.isArray(c)) {
      c.forEach(walk);
      return;
    }
    if (typeof c !== "object") return;
    const rec = c as Record<string, unknown>;
    if (Array.isArray(rec.value) && rec.value.every((v) => typeof v === "string")) {
      out.push((rec.value as string[]).join(""));
    }
    if (Array.isArray(rec.queryChunks)) rec.queryChunks.forEach(walk);
  };
  walk(node);
  return out.join(" ");
}

describe("getJourneyForUser (A5 + RB7/RB9 wiring)", () => {
  it("returning when memberships exist (invitations still surfaced)", async () => {
    const db = seqDb([
      [{ email: "u@x.com", emailVerified: true }],
      [{ companyId: "c1" }],
      [], // organization memberships (Task 9)
      [
        {
          inviteId: "i2",
          companyId: "c2",
          companyName: "Beta",
          createdAt: new Date("2026-07-12T00:00:00Z"),
          defaults: { teamInvite: { role: "team_lead" } },
        },
      ],
    ]);
    const r = await getJourneyForUser(db, { userId: "u1" });
    expect(r.journey).toBe("returning");
    expect(r.targetCompanyId).toBe("c1");
    expect(r.pendingInvitations).toEqual([
      {
        companyId: "c2",
        companyName: "Beta",
        inviteId: "i2",
        role: "team_lead",
        createdAt: "2026-07-12T00:00:00.000Z",
        filed: true,
      },
    ]);
  });

  it("excludes a stale company membership outside the actor-authorized tenant set", async () => {
    const db = seqDb([
      [{ email: "u@x.com", emailVerified: true }],
      [{ companyId: "stale-company" }],
      [], // no active Organization memberships
      [], // pending requests
      [], // open invites
    ]);

    const r = await getJourneyForUser(db, {
      userId: "u1",
      authorizedCompanyIds: [],
    });

    expect(r).toEqual({
      journey: "founder",
      targetCompanyId: null,
      pendingInvitations: [],
      inviteToken: null,
    });
    expect(
      (db._whereCalls as unknown[]).some((condition) =>
        conditionColumns(condition).includes("first_run_completed_at"),
      ),
    ).toBe(false);
  });

  it("lets a valid invitation win after excluding a stale company membership", async () => {
    const db = seqDb([
      [{ email: "u@x.com", emailVerified: true }],
      [{ companyId: "stale-company" }],
      [], // no active Organization memberships
      [
        {
          inviteId: "invite-1",
          companyId: "invited-company",
          companyName: "Invited Company",
          createdAt: new Date("2026-08-03T00:00:00Z"),
          defaults: null,
        },
      ],
      [], // open invites
    ]);

    const r = await getJourneyForUser(db, {
      userId: "u1",
      authorizedCompanyIds: [],
    });

    expect(r.journey).toBe("invited");
    expect(r.targetCompanyId).toBe("invited-company");
    expect(r.resumeFirstRunCompanyId ?? null).toBeNull();
  });

  it("uses only the authorized company for returning and first-run resume", async () => {
    const db = seqDb([
      [{ email: "u@x.com", emailVerified: true }],
      [{ companyId: "stale-company" }, { companyId: "allowed-company" }],
      [{ organizationId: "allowed-org", role: "owner" }],
      [], // pending requests
      [], // open invites
      [{ companyId: "allowed-company" }], // authorized first-run resume
    ]);

    const r = await getJourneyForUser(db, {
      userId: "u1",
      authorizedCompanyIds: ["allowed-company"],
    });

    expect(r.journey).toBe("returning");
    expect(r.targetCompanyId).toBe("allowed-company");
    expect(r.resumeFirstRunCompanyId).toBe("allowed-company");
  });

  it("returning via ORGANIZATION membership alone — zero company memberships (Phase 2 Task 9, org-first)", async () => {
    const db = seqDb([
      [{ email: "u@x.com", emailVerified: true }], // user
      [], // company memberships — none yet
      [{ organizationId: "org1" }], // organization memberships — owner of a fresh tenant
      [], // pending requests
      [], // open invites
    ]);
    const r = await getJourneyForUser(db, { userId: "u1" });
    expect(r.journey).toBe("returning");
    expect(r.targetCompanyId).toBeNull();
  });

  it("returning ORG-OWNER with ZERO companies → resumeCompanyCreationOrgId set (strand resume)", async () => {
    const db = seqDb([
      [{ email: "u@x.com", emailVerified: true }], // user
      [], // company memberships — none yet
      [{ organizationId: "org1", role: "owner" }], // org memberships — owns a fresh tenant
      [], // pending requests
      [], // open invites
      // NOTE: no resume-first-run query runs (returningCompanyIds is empty).
    ]);
    const r = await getJourneyForUser(db, { userId: "u1" });
    expect(r.journey).toBe("returning");
    expect(r.targetCompanyId).toBeNull();
    expect(r.resumeCompanyCreationOrgId).toBe("org1");
  });

  it("multiple create-capable zero-company orgs → deterministic pick by earliest createdAt", async () => {
    // Array order is deliberately NOT createdAt order: a naive `.find()` would
    // return "org-a" (first row); the deterministic tiebreak must pick the org
    // whose membership was created EARLIEST ("org-b", 2026-07-01) regardless of
    // array position. createdAt disagrees with id-lexicographic here (id order
    // would pick "org-a"), so this pins createdAt as the PRIMARY key.
    const db = seqDb([
      [{ email: "u@x.com", emailVerified: true }], // user
      [], // company memberships — none
      [
        { organizationId: "org-a", role: "owner", createdAt: new Date("2026-07-20T00:00:00Z") },
        { organizationId: "org-b", role: "owner", createdAt: new Date("2026-07-01T00:00:00Z") },
      ],
      [], // pending requests
      [], // open invites
    ]);
    const r = await getJourneyForUser(db, { userId: "u1" });
    expect(r.journey).toBe("returning");
    expect(r.resumeCompanyCreationOrgId).toBe("org-b");
  });

  it("multiple create-capable orgs with equal/absent createdAt → deterministic pick by smallest organizationId", async () => {
    // No createdAt (mirrors the seqDb mocks elsewhere): the createdAt tier ties,
    // so the final tiebreak is the lexicographically smallest organizationId
    // ("org-a") — again independent of array order ("org-z" is first).
    const db = seqDb([
      [{ email: "u@x.com", emailVerified: true }], // user
      [], // company memberships — none
      [
        { organizationId: "org-z", role: "owner" },
        { organizationId: "org-a", role: "admin" },
      ],
      [], // pending requests
      [], // open invites
    ]);
    const r = await getJourneyForUser(db, { userId: "u1" });
    expect(r.journey).toBe("returning");
    expect(r.resumeCompanyCreationOrgId).toBe("org-a");
  });

  it("returning MEMBER (not create-capable) with zero companies → no company-creation resume", async () => {
    const db = seqDb([
      [{ email: "u@x.com", emailVerified: true }], // user
      [], // company memberships — none
      [{ organizationId: "org1", role: "member" }], // cross-invited member, not owner/admin
      [], // pending requests
      [], // open invites
    ]);
    const r = await getJourneyForUser(db, { userId: "u1" });
    expect(r.journey).toBe("returning");
    expect(r.resumeCompanyCreationOrgId ?? null).toBeNull();
  });

  it("returning founder with an UNFINISHED first-run tail → resumeFirstRunCompanyId set (resume into /onboarding)", async () => {
    const db = seqDb([
      [{ email: "u@x.com", emailVerified: true }], // user
      [{ companyId: "c1" }], // memberships → returning
      [], // organization memberships (Task 9)
      [], // pending requests
      [], // open invites
      [{ companyId: "c1" }], // resume query: c1's own first-run isn't complete
    ]);
    const r = await getJourneyForUser(db, { userId: "u1" });
    expect(r.journey).toBe("returning");
    expect(r.resumeFirstRunCompanyId).toBe("c1");
    // Codex P3: the resume query must exclude archived companies (join companies,
    // status != "archived"), so an archived unfinished company can't keep
    // redirecting its founder into onboarding. Drizzle SQL conditions are
    // circular objects (JSON.stringify throws), so assert structurally via the
    // file's conditionColumns helper (same pattern as the open-invite tests
    // below). The resume query is the ONLY one binding
    // onboarding_progress.first_run_completed_at, and it binds companies.status
    // in the same clause — status is referenced solely for the archived guard.
    const resumeWhere = (db._whereCalls as unknown[]).find((c) =>
      conditionColumns(c).includes("first_run_completed_at"),
    );
    expect(resumeWhere).toBeDefined();
    expect(conditionColumns(resumeWhere)).toContain("status");
  });

  it("returning founder whose first-run is COMPLETE → resumeFirstRunCompanyId null (stays on the Lobby)", async () => {
    const db = seqDb([
      [{ email: "u@x.com", emailVerified: true }], // user
      [{ companyId: "c1" }], // memberships → returning
      [], // organization memberships (Task 9)
      [], // pending requests
      [], // open invites
      [], // resume query: no incomplete first-run row
    ]);
    const r = await getJourneyForUser(db, { userId: "u1" });
    expect(r.journey).toBe("returning");
    expect(r.resumeFirstRunCompanyId ?? null).toBeNull();
  });

  it("invited when a pending human request exists and no membership", async () => {
    const db = seqDb([
      [{ email: "u@x.com", emailVerified: true }],
      [],
      [], // organization memberships (Task 9)
      [
        {
          inviteId: "i2",
          companyId: "c2",
          companyName: "Beta",
          createdAt: new Date("2026-07-12T00:00:00Z"),
          defaults: null,
        },
      ],
    ]);
    const r = await getJourneyForUser(db, { userId: "u1" });
    expect(r.journey).toBe("invited");
    expect(r.targetCompanyId).toBe("c2");
    expect(r.pendingInvitations[0].role).toBe("team_member"); // default when defaults absent
  });

  it("founder when no membership and no pending request", async () => {
    const db = seqDb([[{ email: "u@x.com", emailVerified: true }], [], [], []]);
    const r = await getJourneyForUser(db, { userId: "u1" });
    expect(r).toEqual({
      journey: "founder",
      targetCompanyId: null,
      pendingInvitations: [],
      inviteToken: null,
    });
  });

  it("returns an instance admin to an existing company without creating a membership", async () => {
    const db = seqDb([
      [{ email: "admin@x.com", emailVerified: true }],
      [],
      [], // organization memberships (Task 9)
      [
        {
          inviteId: "i2",
          companyId: "c2",
          companyName: "Beta",
          createdAt: new Date("2026-07-12T00:00:00Z"),
          defaults: null,
        },
      ],
      [], // open invites (tokenless detection)
      [{ companyId: "c1" }],
    ]);

    const r = await getJourneyForUser(db, {
      userId: "admin-1",
      isInstanceAdmin: true,
    });

    expect(r.journey).toBe("returning");
    expect(r.targetCompanyId).toBe("c1");
    expect(r.pendingInvitations.map((invite) => invite.companyId)).toEqual(["c2"]);
  });

  it("prefers an instance admin's active membership over the global fallback", async () => {
    const db = seqDb([
      [{ email: "admin@x.com", emailVerified: true }],
      [{ companyId: "member-company" }],
      [], // organization memberships (Task 9)
      [],
    ]);

    const r = await getJourneyForUser(db, {
      userId: "admin-1",
      isInstanceAdmin: true,
    });

    expect(r.journey).toBe("returning");
    expect(r.targetCompanyId).toBe("member-company");
  });

  it("keeps an instance admin on the founder journey when the instance is empty", async () => {
    const db = seqDb([[{ email: "admin@x.com", emailVerified: true }], [], [], [], []]);

    const r = await getJourneyForUser(db, {
      userId: "admin-1",
      isInstanceAdmin: true,
    });

    expect(r).toEqual({
      journey: "founder",
      targetCompanyId: null,
      pendingInvitations: [],
      inviteToken: null,
    });
  });
});

describe("getJourneyForUser — open-invite detection (tokenless invited entry)", () => {
  it("surfaces an OPEN verified-email invite as an invitation → journey invited", async () => {
    const db = seqDb([
      [{ email: "u@x.com", emailVerified: true }],
      [], // memberships
      [], // organization memberships (Task 9)
      [], // filed join_requests
      [
        {
          inviteId: "i9",
          companyId: "c2",
          companyName: "Beta",
          createdAt: new Date("2026-07-12T00:00:00Z"),
          defaults: { teamInvite: { email: "u@x.com", role: "team_lead" } },
        },
      ],
    ]);
    const r = await getJourneyForUser(db, { userId: "u1" });
    expect(r.journey).toBe("invited");
    expect(r.targetCompanyId).toBe("c2");
    // inviteId here is the INVITE id (no join_request exists yet) — and
    // `filed: false` marks it as consent-gated (no join_request was filed;
    // the terminal must not auto-finalize).
    expect(r.pendingInvitations).toEqual([
      {
        companyId: "c2",
        companyName: "Beta",
        inviteId: "i9",
        role: "team_lead",
        createdAt: "2026-07-12T00:00:00.000Z",
        filed: false,
      },
    ]);
  });

  it("marks FILED join_request invitations filed: true (auto-finalize allowed)", async () => {
    const db = seqDb([
      [{ email: "u@x.com", emailVerified: true }],
      [], // memberships
      [], // organization memberships (Task 9)
      [
        {
          inviteId: "jr-invite",
          companyId: "c2",
          companyName: "Beta",
          createdAt: new Date("2026-07-12T00:00:00Z"),
          defaults: null,
        },
      ],
      [], // open invites
    ]);
    const r = await getJourneyForUser(db, { userId: "u1" });
    expect(r.pendingInvitations).toHaveLength(1);
    expect(r.pendingInvitations[0].filed).toBe(true);
  });

  it("newest open invite per company wins (parity with finalize's desc(createdAt) claim)", async () => {
    const db = seqDb([
      [{ email: "u@x.com", emailVerified: true }],
      [], // memberships
      [], // organization memberships (Task 9)
      [], // filed join_requests
      [
        // SQL returns newest-first (desc(createdAt)); the merge keeps the first
        // row per company.
        {
          inviteId: "i-new",
          companyId: "c2",
          companyName: "Beta",
          createdAt: new Date("2026-07-14T00:00:00Z"),
          defaults: { teamInvite: { role: "team_lead" } },
        },
        {
          inviteId: "i-old",
          companyId: "c2",
          companyName: "Beta",
          createdAt: new Date("2026-07-10T00:00:00Z"),
          defaults: null,
        },
      ],
    ]);
    const r = await getJourneyForUser(db, { userId: "u1" });
    expect(r.pendingInvitations).toHaveLength(1);
    expect(r.pendingInvitations[0].inviteId).toBe("i-new");
    expect(r.pendingInvitations[0].role).toBe("team_lead");
    // Structural lock: the open-invite query itself orders desc(createdAt) —
    // the merge's first-row-wins only picks the newest if SQL sorts it first.
    const openInviteOrderBy = (db._orderByCalls as unknown[][]).find((args) =>
      args.some((a) => conditionColumns(a).includes("created_at")),
    );
    expect(openInviteOrderBy).toBeDefined();
    expect(sqlText(openInviteOrderBy)).toContain("desc");
  });

  it("trims the invite email in SQL (btrim) — padded invite emails match like the admit gate", async () => {
    const db = seqDb([
      [{ email: "u@x.com", emailVerified: true }],
      [], // memberships
      [], // organization memberships (Task 9)
      [], // filed join_requests
      [], // open invites
    ]);
    await getJourneyForUser(db, { userId: "u1" });
    const openInviteWhere = (db._whereCalls as unknown[]).find((c) =>
      conditionColumns(c).includes("expires_at"),
    );
    expect(openInviteWhere).toBeDefined();
    const text = sqlText(openInviteWhere);
    expect(text).toContain("lower(btrim(");
    // Both sides trimmed: the jsonb-extracted invite email AND the caller email.
    expect(text.match(/btrim/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT run open-invite detection for an unverified email", async () => {
    const db = seqDb([
      [{ email: "u@x.com", emailVerified: false }],
      [], // memberships
      [], // organization memberships (Task 9)
      [], // filed join_requests
      // Would-be open invite: MUST NOT be consumed — detection is gated on a
      // verified email. If the query ran, this row would flip the journey.
      [{ inviteId: "i9", companyId: "c2", companyName: "Beta", createdAt: new Date(), defaults: null }],
    ]);
    const r = await getJourneyForUser(db, { userId: "u1" });
    expect(r.journey).toBe("founder");
    expect(r.pendingInvitations).toEqual([]);
  });

  it("gates detection on acceptedAt/revokedAt/expiresAt/inviteType/allowedJoinTypes in SQL", async () => {
    // The sequence db can't evaluate SQL, so expired/revoked/accepted exclusion
    // is regression-locked structurally: the open-invite WHERE must bind every
    // gate column (expiry MUST gate detection — nothing was accepted yet).
    const db = seqDb([
      [{ email: "u@x.com", emailVerified: true }],
      [], // memberships
      [], // organization memberships (Task 9)
      [], // filed join_requests
      [], // open invites — an expired/revoked/accepted invite comes back empty
    ]);
    const r = await getJourneyForUser(db, { userId: "u1" });
    expect(r.journey).toBe("founder");
    const openInviteWhere = (db._whereCalls as unknown[]).find((c) =>
      conditionColumns(c).includes("expires_at"),
    );
    expect(openInviteWhere).toBeDefined();
    expect(conditionColumns(openInviteWhere)).toEqual(
      expect.arrayContaining([
        "accepted_at",
        "revoked_at",
        "expires_at",
        "invite_type",
        "allowed_join_types",
        "defaults_payload",
      ]),
    );
  });

  it("dedupes by company — a FILED join_request wins over an open invite", async () => {
    const db = seqDb([
      [{ email: "u@x.com", emailVerified: true }],
      [], // memberships
      [], // organization memberships (Task 9)
      [
        {
          inviteId: "jr-invite",
          companyId: "c2",
          companyName: "Beta",
          createdAt: new Date("2026-07-12T00:00:00Z"),
          defaults: null,
        },
      ],
      [
        {
          inviteId: "i9",
          companyId: "c2",
          companyName: "Beta",
          createdAt: new Date("2026-07-11T00:00:00Z"),
          defaults: null,
        },
      ],
    ]);
    const r = await getJourneyForUser(db, { userId: "u1" });
    expect(r.journey).toBe("invited");
    expect(r.pendingInvitations).toHaveLength(1);
    expect(r.pendingInvitations[0].inviteId).toBe("jr-invite");
  });
});

describe("GET /api/onboarding/journey", () => {
  function makeApp(db: any, actor: Record<string, unknown>) {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", onboardingJourneyRoutes(db));
    return app;
  }

  it("uses the authenticated actor's instance-admin visibility", async () => {
    const db = seqDb([
      [{ email: "admin@x.com", emailVerified: true }],
      [],
      [], // organization memberships (Task 9)
      [],
      [], // open invites (tokenless detection)
      [{ companyId: "c1" }],
    ]);
    const app = makeApp(db, {
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    });

    const res = await request(app).get("/api/onboarding/journey");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      journey: "returning",
      targetCompanyId: "c1",
    });
  });

  it("preserves every real membership for an unscoped local implicit admin", async () => {
    const db = seqDb([
      [{ email: "local@x.com", emailVerified: true }],
      [{ companyId: "c1" }, { companyId: "c2" }],
      [], // Organization membership is not required in local_trusted mode
      [], // pending requests
      [], // open invites
      [{ companyId: "c2" }], // unfinished first-run company is not the first membership
    ]);
    const app = makeApp(db, {
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
      // No companyIds by design: accessibleCompanyIdsForActor returns the
      // unscoped `undefined` sentinel for this self-hosted actor.
    });

    const res = await request(app).get("/api/onboarding/journey");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      journey: "returning",
      targetCompanyId: "c1",
      resumeFirstRunCompanyId: "c2",
    });
  });

  it("does not expose an existing company to a non-admin without membership", async () => {
    const db = seqDb([
      [{ email: "member@x.com", emailVerified: true }],
      [],
      [], // organization memberships (Task 9)
      [],
      [], // open invites (tokenless detection)
      [{ companyId: "c1" }],
    ]);
    const app = makeApp(db, {
      type: "board",
      userId: "member-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [],
    });

    const res = await request(app).get("/api/onboarding/journey");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      journey: "founder",
      targetCompanyId: null,
    });
  });

  it("does not route a suspended Organization member through a stale company membership", async () => {
    const db = seqDb([
      [{ email: "member@x.com", emailVerified: true }],
      [{ companyId: "stale-company" }],
      [], // listOrgMemberships returns active rows only: suspended means empty
      [], // pending requests
      [], // open invites
    ]);
    const app = makeApp(db, {
      type: "board",
      userId: "member-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [], // actorMiddleware's active-org intersection
    });

    const res = await request(app).get("/api/onboarding/journey");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      journey: "founder",
      targetCompanyId: null,
    });
    expect(res.body.resumeFirstRunCompanyId ?? null).toBeNull();
  });

  it("rejects callers without a board identity before querying", async () => {
    const db = { select: () => { throw new Error("database should not be queried"); } };
    const app = makeApp(db, { type: "none", source: "none" });

    const res = await request(app).get("/api/onboarding/journey");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "authentication required" });
  });
});
