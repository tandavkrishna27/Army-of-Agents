import { beforeEach, describe, expect, it, vi } from "vitest";

// -- Mocks --------------------------------------------------------------------

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  inArray: vi.fn((c: any, v: any) => ({ inArray: [c, v] })),
  count: vi.fn(() => ({ count: true })),
  sql: vi.fn(() => ({ sql: true })),
}));

vi.mock("@armyofagents/db", () => ({
  teams: {
    id: "teams_id",
    companyId: "teams_company_id",
    parentProjectId: "teams_parent_project_id",
    name: "teams_name",
    slug: "teams_slug",
    description: "teams_description",
    manifest: "teams_manifest",
    templateOrigin: "teams_template_origin",
    templateVersion: "teams_template_version",
    status: "teams_status",
    archivedAt: "teams_archived_at",
    createdAt: "teams_created_at",
    updatedAt: "teams_updated_at",
  },
  teamMembers: {
    id: "tm_id",
    teamId: "tm_team_id",
    agentId: "tm_agent_id",
    role: "tm_role",
    createdAt: "tm_created_at",
  },
  agentProjects: {
    agentId: "ap_agent_id",
    projectId: "ap_project_id",
    companyId: "ap_company_id",
  },
  agents: {
    id: "agents_id",
    companyId: "agents_company_id",
    name: "agents_name",
    adapterType: "agents_adapter_type",
    role: "agents_role",
    title: "agents_title",
    icon: "agents_icon",
    status: "agents_status",
    permissions: "agents_permissions",
    runtimeConfig: "agents_runtime_config",
    adapterConfig: "agents_adapter_config",
    spentMonthlyCents: "agents_spent_monthly_cents",
    budgetMonthlyCents: "agents_budget_monthly_cents",
    lastHeartbeatAt: "agents_last_heartbeat_at",
    metadata: "agents_metadata",
    createdAt: "agents_created_at",
    updatedAt: "agents_updated_at",
  },
  projects: {
    id: "projects_id",
    companyId: "projects_company_id",
  },
  teamCoordinations: {
    id: "team_coordinations_id",
    teamId: "team_coordinations_team_id",
    status: "team_coordinations_status",
    updatedAt: "team_coordinations_updated_at",
  },
}));

vi.mock("../errors.js", () => ({
  badRequest: (msg: string) => {
    const err = new Error(msg);
    (err as any).status = 400;
    return err;
  },
  conflict: (msg: string) => {
    const err = new Error(msg);
    (err as any).status = 409;
    return err;
  },
  notFound: (msg: string) => {
    const err = new Error(msg);
    (err as any).status = 404;
    return err;
  },
}));

import { teamsService } from "../services/teams.js";
import { createAgentDb } from "./helpers/mock-db.js";

// -- Tests --------------------------------------------------------------------

describe("teamsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("list()", () => {
    it("returns rows for company with member summary", async () => {
      const teamsRows = [
        { id: "t1", companyId: "co-1", name: "Frontend", slug: "frontend" },
        { id: "t2", companyId: "co-1", name: "Backend", slug: "backend" },
      ];
      const memberRows = [
        { teamId: "t1", agentId: "a1", role: "lead" },
        { teamId: "t1", agentId: "a2", role: "member" },
        { teamId: "t2", agentId: "a3", role: "member" },
      ];
      // Two selects: teams list, then batch member query
      const db = createAgentDb({ selects: [teamsRows, memberRows] });

      const result = await teamsService(db as any).list("co-1");

      expect(result).toEqual([
        { ...teamsRows[0], memberCount: 2, leadAgentId: "a1", memberAgentIds: ["a1", "a2"] },
        { ...teamsRows[1], memberCount: 1, leadAgentId: null, memberAgentIds: ["a3"] },
      ]);
    });

    it("returns empty array with member summary shape when no teams", async () => {
      const db = createAgentDb({ selects: [[]] });
      const result = await teamsService(db as any).list("co-1");
      expect(result).toEqual([]);
    });

    it("filters by projectId", async () => {
      const teamsRows = [
        {
          id: "t1",
          companyId: "co-1",
          parentProjectId: "p1",
          name: "Frontend",
          slug: "frontend",
        },
      ];
      // Two selects: filtered teams list, then batch member query (no members)
      const db = createAgentDb({ selects: [teamsRows, []] });

      const result = await teamsService(db as any).list("co-1", "p1");

      expect(result).toEqual([
        { ...teamsRows[0], memberCount: 0, leadAgentId: null, memberAgentIds: [] },
      ]);
    });
  });

  describe("getById()", () => {
    it("returns the team", async () => {
      const team = { id: "t1", companyId: "co-1", name: "Frontend" };
      const db = createAgentDb({ selects: [[team]] });

      const result = await teamsService(db as any).getById("t1");

      expect(result).toEqual(team);
    });

    it("throws notFound when team missing", async () => {
      const db = createAgentDb({ selects: [[]] });

      await expect(teamsService(db as any).getById("missing")).rejects.toThrow(
        /not found/i,
      );
    });
  });

  describe("getBySlug()", () => {
    it("returns the team", async () => {
      const team = {
        id: "t1",
        companyId: "co-1",
        name: "Frontend",
        slug: "frontend",
      };
      const db = createAgentDb({ selects: [[team]] });

      const result = await teamsService(db as any).getBySlug("co-1", "frontend");

      expect(result).toEqual(team);
    });

    it("throws notFound when slug missing", async () => {
      const db = createAgentDb({ selects: [[]] });

      await expect(
        teamsService(db as any).getBySlug("co-1", "missing"),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe("create()", () => {
    it("inserts team with derived slug from name", async () => {
      const inserted = {
        id: "t1",
        companyId: "co-1",
        parentProjectId: "p1",
        name: "Frontend Team",
        slug: "frontend-team",
        description: "Owns the UI",
        manifest: {},
      };
      const db = createAgentDb({
        selects: [
          [{ id: "p1" }], // P1: parent-project company check
          [], // existing slug query: empty (no collisions)
        ],
        inserts: [[inserted]],
      });

      const result = await teamsService(db as any).create("co-1", {
        name: "Frontend Team",
        parentProjectId: "p1",
        description: "Owns the UI",
      });

      expect(result).toEqual(inserted);
      expect(result.slug).toBe("frontend-team");
    });

    it("appends -2 when slug collides", async () => {
      const inserted = {
        id: "t2",
        companyId: "co-1",
        parentProjectId: "p1",
        name: "Frontend Team",
        slug: "frontend-team-2",
        manifest: {},
      };
      const db = createAgentDb({
        selects: [
          [{ id: "p1" }], // P1: parent-project company check
          [{ slug: "frontend-team" }], // existing slug: matches base
        ],
        inserts: [[inserted]],
      });

      const result = await teamsService(db as any).create("co-1", {
        name: "Frontend Team",
        parentProjectId: "p1",
      });

      expect(result.slug).toBe("frontend-team-2");
    });

    it("retries slug generation on PG 23505 collision", async () => {
      // Simulates a TOCTOU race: between our SELECT-existing-slugs probe and
      // the INSERT, a concurrent transaction wins the unique-slug lock. The
      // first INSERT throws 23505; the retry re-fetches (now sees the
      // colliding row) and picks a different suffix.
      //
      // The first SELECT in this sequence is the P1 parent-project company
      // check (always returns one row); subsequent SELECTs are the slug
      // probes inside the retry loop.
      //
      // P1-4: the team insert now runs inside `db.transaction(...)`, so the
      // mock provides a `transaction` field that delegates to the same proxy.
      let attempt = 0;
      let selectCalls = 0;
      const dbProxy: any = {
        select: () => ({
          from: () => ({
            where: () => {
              const callIdx = selectCalls++;
              if (callIdx === 0) {
                // P1: parent project lookup -- always present.
                return Promise.resolve([{ id: "p1" }]);
              }
              const slugProbeIdx = callIdx - 1;
              const result =
                slugProbeIdx === 0
                  ? [] // first slug probe: no existing slugs yet
                  : [{ slug: "qa-team" }]; // second slug probe: collider visible
              return Promise.resolve(result);
            },
          }),
        }),
        insert: () => ({
          values: (vals: { slug: string }) => ({
            returning: () => {
              if (attempt === 0) {
                attempt++;
                const err = Object.assign(new Error("duplicate key"), {
                  code: "23505",
                });
                throw err;
              }
              return Promise.resolve([
                { id: "t1", slug: vals.slug, name: "QA Team" },
              ]);
            },
          }),
        }),
      };
      dbProxy.transaction = async (cb: (tx: any) => Promise<any>) => cb(dbProxy);

      const team = await teamsService(dbProxy).create("c1", {
        name: "QA Team",
        parentProjectId: "p1",
      });
      expect(team.slug).not.toBe("qa-team"); // collision -> suffix added
      expect(attempt).toBe(1); // verified we retried exactly once
    });

    it("rejects when parentProjectId belongs to another company (P1)", async () => {
      // P1: cross-tenant guard. Caller specifies a project UUID that exists
      // in some company but NOT in `companyId`. The project-check returns
      // empty, so create() must throw badRequest before any insert runs.
      const db = createAgentDb({
        selects: [
          [], // P1: parent-project company check returns empty
        ],
      });

      await expect(
        teamsService(db as any).create("c1", {
          name: "Sneaky Team",
          parentProjectId: "from-other-company",
        }),
      ).rejects.toThrow(/parent project.*not found in company/);
    });

    it("inserts team + member rows atomically when members provided (P1-4)", async () => {
      // Sequence:
      //   1. select projects (P1 cross-tenant guard) -> 1 row
      //   2. select agentProjects (dept-membership check for both members) -> both present
      //   3. select existing slugs (slug collision check) -> []
      //   4. tx.insert(teams).returning -> [team]
      //   5. tx.insert(teamMembers) -> [member1, member2] (single batched insert)
      const insertedTeam = {
        id: "team-1",
        companyId: "co-1",
        parentProjectId: "p1",
        name: "Frontend Team",
        slug: "frontend-team",
        manifest: {},
      };
      const db = createAgentDb({
        selects: [
          [{ id: "p1" }], // 1: P1 project check
          [{ agentId: "a1" }, { agentId: "a2" }], // 2: both agents in dept
          [], // 3: no slug collision
        ],
        inserts: [
          [insertedTeam], // 4: team insert
          [
            { id: "tm1", teamId: "team-1", agentId: "a1", role: "lead" },
            { id: "tm2", teamId: "team-1", agentId: "a2", role: "member" },
          ], // 5: team_members batched insert
        ],
      });

      const result = await teamsService(db as any).create("co-1", {
        name: "Frontend Team",
        parentProjectId: "p1",
        members: [
          { agentId: "a1", role: "lead" },
          { agentId: "a2", role: "member" },
        ],
      });

      expect(result).toEqual(insertedTeam);
    });

    it("rejects when a member is not in the parent department (P1-4)", async () => {
      // Sequence:
      //   1. select projects (P1) -> 1 row
      //   2. select agentProjects (dept check) -> only a1 present, a2 missing
      const db = createAgentDb({
        selects: [
          [{ id: "p1" }], // 1: P1 project check
          [{ agentId: "a1" }], // 2: only a1 is in dept (a2 missing)
        ],
      });

      await expect(
        teamsService(db as any).create("co-1", {
          name: "Frontend Team",
          parentProjectId: "p1",
          members: [
            { agentId: "a1", role: "lead" },
            { agentId: "a2", role: "member" },
          ],
        }),
      ).rejects.toThrow(/agents not in parent department.*a2/);
    });

    it("rejects when more than one lead is provided (P1-4)", async () => {
      // Sequence:
      //   1. select projects (P1) -> 1 row
      //   2. select agentProjects -> both present
      //   (slug probe + insert never run; lead-count check throws first)
      const db = createAgentDb({
        selects: [
          [{ id: "p1" }], // 1: P1 project check
          [{ agentId: "a1" }, { agentId: "a2" }], // 2: both in dept
        ],
      });

      await expect(
        teamsService(db as any).create("co-1", {
          name: "Frontend Team",
          parentProjectId: "p1",
          members: [
            { agentId: "a1", role: "lead" },
            { agentId: "a2", role: "lead" },
          ],
        }),
      ).rejects.toThrow(/at most one lead per team, got 2/);
    });
  });

  describe("update()", () => {
    it("returns updated team", async () => {
      const updated = {
        id: "t1",
        companyId: "co-1",
        name: "New Name",
        description: "Updated desc",
      };
      const db = createAgentDb({ updates: [[updated]] });

      const result = await teamsService(db as any).update("t1", {
        name: "New Name",
        description: "Updated desc",
      });

      expect(result).toEqual(updated);
    });

    it("throws notFound when team missing", async () => {
      const db = createAgentDb({ updates: [[]] });

      await expect(
        teamsService(db as any).update("missing", { name: "X" }),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe("archive()", () => {
    it("sets status archived and returns row", async () => {
      const archived = {
        id: "t1",
        companyId: "co-1",
        status: "archived",
        archivedAt: new Date(),
      };
      const db = createAgentDb({ updates: [[archived]] });

      const result = await teamsService(db as any).archive("t1");

      expect(result.status).toBe("archived");
    });

    it("throws notFound when team missing", async () => {
      const db = createAgentDb({ updates: [[]] });

      await expect(teamsService(db as any).archive("missing")).rejects.toThrow(
        /not found/i,
      );
    });

    it("cascades to coordination archive (P1-D)", async () => {
      // P1-D: archiving the team must also flip the team's published
      // coordination row to status='archived'. Without this cascade, the
      // heartbeat injection (status='published' filter) would keep the
      // coord live after archive and continue feeding it into every
      // member agent's run. Test isolates the cascade by counting which
      // table received the second UPDATE in the transaction.
      let coordUpdateCalled = false;
      const db: any = {
        transaction: async (cb: (tx: any) => Promise<any>) => {
          const tx: any = {
            update: (table: any) => ({
              set: () => ({
                where: () => ({
                  returning: () => {
                    if (table?.id === "teams_id") {
                      return Promise.resolve([
                        { id: "t1", status: "archived" },
                      ]);
                    }
                    if (table?.id === "team_coordinations_id") {
                      coordUpdateCalled = true;
                      return Promise.resolve([
                        { id: "c1", status: "archived" },
                      ]);
                    }
                    return Promise.resolve([]);
                  },
                  // The cascade UPDATE doesn't call `.returning()` -- it's
                  // best-effort. Resolve directly off `.where()` for that
                  // path while still allowing `.returning()` for the
                  // primary teams UPDATE.
                  then: (resolve: (v: any[]) => unknown) => {
                    if (table?.id === "team_coordinations_id") {
                      coordUpdateCalled = true;
                    }
                    return Promise.resolve(resolve([]));
                  },
                }),
              }),
            }),
          };
          return cb(tx);
        },
      };

      await teamsService(db).archive("t1");

      expect(coordUpdateCalled).toBe(true);
    });
  });

  describe("dismantle()", () => {
    it("hard-deletes the team and returns the deleted teamId", async () => {
      // Sequence: 1x select (existence probe) -> 1x delete (hard-delete).
      // Schema cascades handle team_members + team_coordinations; the
      // service does NOT issue an explicit delete on those tables.
      const db = createAgentDb({
        selects: [[{ id: "t1" }]],
        deletes: [[]],
      });

      const result = await teamsService(db as any).dismantle("t1");

      expect(result).toEqual({ dismantledTeamId: "t1" });
    });

    it("throws notFound when team doesn't exist", async () => {
      // Existence probe returns empty -- service throws BEFORE issuing delete.
      const db = createAgentDb({
        selects: [[]],
      });

      await expect(
        teamsService(db as any).dismantle("missing"),
      ).rejects.toThrow(/not found/i);
    });

    it("issues exactly ONE delete (cascade contract -- no explicit team_members or team_coordinations delete)", async () => {
      // Verify the cascade contract: dismantle should rely on the schema's
      // `onDelete: "cascade"` to remove team_members + team_coordinations,
      // not a manual delete chain. Counting delete invocations protects
      // against a regression where someone "helpfully" adds explicit
      // deletes -- those would race the cascade and could partially fail.
      let deleteCalls = 0;
      const db: any = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([{ id: "t1" }]),
          }),
        }),
        delete: () => {
          deleteCalls++;
          return {
            where: () => Promise.resolve([]),
          };
        },
      };

      const result = await teamsService(db).dismantle("t1");

      expect(result).toEqual({ dismantledTeamId: "t1" });
      expect(deleteCalls).toBe(1);
    });
  });

  describe("listMembers()", () => {
    it("returns members for team", async () => {
      const members = [
        { id: "tm1", teamId: "t1", agentId: "a1", role: "lead" },
        { id: "tm2", teamId: "t1", agentId: "a2", role: "member" },
      ];
      const db = createAgentDb({ selects: [members] });

      const result = await teamsService(db as any).listMembers("t1");

      expect(result).toEqual(members);
    });
  });

  describe("addMember()", () => {
    it("rejects when agent is not in parent department", async () => {
      const db = createAgentDb({
        selects: [
          [{ id: "t1", parentProjectId: "p1" }], // team lookup
          [], // dept membership lookup: empty
        ],
      });

      await expect(
        teamsService(db as any).addMember("t1", "a1", "member"),
      ).rejects.toThrow(/parent department/i);
    });

    it("rejects when adding a second lead", async () => {
      const db = createAgentDb({
        selects: [
          [{ id: "t1", parentProjectId: "p1" }], // team lookup
          [{ agentId: "a1", projectId: "p1" }], // dept membership: present
          [{ id: "tm-existing", role: "lead", agentId: "a-other" }], // existing lead present
        ],
      });

      await expect(
        teamsService(db as any).addMember("t1", "a1", "lead"),
      ).rejects.toThrow(/already has a lead/i);
    });

    it("succeeds with valid lead", async () => {
      const inserted = {
        id: "tm-new",
        teamId: "t1",
        agentId: "a1",
        role: "lead",
      };
      const db = createAgentDb({
        selects: [
          [{ id: "t1", parentProjectId: "p1" }], // team lookup
          [{ agentId: "a1", projectId: "p1" }], // dept membership: present
          [], // no existing lead
        ],
        inserts: [[inserted]],
      });

      const result = await teamsService(db as any).addMember("t1", "a1", "lead");

      expect(result).toEqual(inserted);
    });

    it("succeeds with valid member", async () => {
      const inserted = {
        id: "tm-new",
        teamId: "t1",
        agentId: "a1",
        role: "member",
      };
      const db = createAgentDb({
        selects: [
          [{ id: "t1", parentProjectId: "p1" }], // team lookup
          [{ agentId: "a1", projectId: "p1" }], // dept membership: present
        ],
        inserts: [[inserted]],
      });

      const result = await teamsService(db as any).addMember(
        "t1",
        "a1",
        "member",
      );

      expect(result).toEqual(inserted);
    });

    it("throws notFound when team missing", async () => {
      const db = createAgentDb({
        selects: [[]], // team lookup: empty
      });

      await expect(
        teamsService(db as any).addMember("missing", "a1", "member"),
      ).rejects.toThrow(/not found/i);
    });

    it("converts PG 23505 unique-violation to a 409 Conflict (P2)", async () => {
      // Custom proxy: returns the team + dept-membership rows on selects, but
      // throws a 23505 from the team_members insert. The service should
      // catch that and rethrow a conflict() Error (status: 409).
      let selectCalls = 0;
      const db: any = {
        select: () => ({
          from: () => ({
            where: () => {
              const idx = selectCalls++;
              if (idx === 0) {
                // team lookup
                return Promise.resolve([
                  { id: "t1", parentProjectId: "p1" },
                ]);
              }
              if (idx === 1) {
                // dept-membership lookup: present
                return Promise.resolve([
                  { agentId: "a1", projectId: "p1" },
                ]);
              }
              // (lead pre-check is skipped because we add as member)
              return Promise.resolve([]);
            },
          }),
        }),
        insert: () => ({
          values: () => ({
            returning: () => {
              const err = Object.assign(new Error("dup"), { code: "23505" });
              throw err;
            },
          }),
        }),
      };

      await expect(
        teamsService(db).addMember("t1", "a1", "member"),
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  describe("removeMember()", () => {
    it("rejects when removing the last lead", async () => {
      const db = createAgentDb({
        selects: [
          [{ id: "t1", parentProjectId: "p1" }], // team lookup (roster-edit guard)
          [{ id: "tm1", teamId: "t1", agentId: "a1", role: "lead" }], // membership
          [{ id: "tm1", teamId: "t1", agentId: "a1", role: "lead" }], // single lead
        ],
      });

      await expect(
        teamsService(db as any).removeMember("t1", "a1"),
      ).rejects.toThrow(/only lead/i);
    });

    it("removes a regular member", async () => {
      const db = createAgentDb({
        selects: [
          [{ id: "t1", parentProjectId: "p1" }], // team lookup (roster-edit guard)
          [{ id: "tm2", teamId: "t1", agentId: "a2", role: "member" }], // membership
        ],
      });

      const result = await teamsService(db as any).removeMember("t1", "a2");

      expect(result).toEqual({ ok: true });
    });

    it("removes a non-last lead", async () => {
      const db = createAgentDb({
        selects: [
          [{ id: "t1", parentProjectId: "p1" }], // team lookup (roster-edit guard)
          [{ id: "tm1", teamId: "t1", agentId: "a1", role: "lead" }], // membership
          [
            { id: "tm1", teamId: "t1", agentId: "a1", role: "lead" },
            { id: "tm3", teamId: "t1", agentId: "a3", role: "lead" },
          ], // multiple leads
        ],
      });

      const result = await teamsService(db as any).removeMember("t1", "a1");

      expect(result).toEqual({ ok: true });
    });

    it("throws notFound when membership missing", async () => {
      const db = createAgentDb({
        selects: [
          [{ id: "t1", parentProjectId: "p1" }], // team lookup (roster-edit guard)
          [], // membership: empty
        ],
      });

      await expect(
        teamsService(db as any).removeMember("t1", "a-missing"),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe("updateMemberRole()", () => {
    it("promotes to lead and demotes existing lead transactionally", async () => {
      const updated = {
        id: "tm2",
        teamId: "t1",
        agentId: "a2",
        role: "lead",
      };
      const existingLead = [
        { id: "tm1", teamId: "t1", agentId: "a1", role: "lead" },
      ];
      const db = createAgentDb({
        selects: [
          [{ id: "t1", parentProjectId: "p1" }], // team lookup (roster-edit guard)
          existingLead, // existing lead lookup inside tx
        ],
        updates: [
          [{ id: "tm1", role: "member" }], // demote existing lead
          [updated], // promote target
        ],
      });

      const result = await teamsService(db as any).updateMemberRole(
        "t1",
        "a2",
        "lead",
      );

      expect(result).toEqual(updated);
    });

    it("demotes a lead to member without touching other leads", async () => {
      const updated = {
        id: "tm1",
        teamId: "t1",
        agentId: "a1",
        role: "member",
      };
      const db = createAgentDb({
        selects: [[{ id: "t1", parentProjectId: "p1" }]], // team lookup (roster-edit guard)
        updates: [[updated]],
      });

      const result = await teamsService(db as any).updateMemberRole(
        "t1",
        "a1",
        "member",
      );

      expect(result).toEqual(updated);
    });

    it("throws notFound when membership missing", async () => {
      const db = createAgentDb({
        selects: [[{ id: "t1", parentProjectId: "p1" }]], // team lookup (roster-edit guard)
        updates: [[]], // update returns no rows
      });

      await expect(
        teamsService(db as any).updateMemberRole("t1", "a-missing", "member"),
      ).rejects.toThrow(/not found/i);
    });

    it("converts PG 23505 on concurrent lead promotion to 409", async () => {
      // P1-B: updateMemberRole(role: "lead") -- the partial unique index
      // team_members_one_lead_uq guarantees at most one lead per team. If
      // two concurrent transactions both demote then promote, the second
      // one's UPDATE-to-lead loses the race and throws 23505. The service
      // should map that to 409 (matching addMember's pattern).
      const db: any = {
        // Top-level select = the roster-edit guard's team lookup (departmental).
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([{ id: "t1", parentProjectId: "p1" }]),
          }),
        }),
        transaction: async (cb: (tx: any) => Promise<unknown>) => {
          const tx: any = {
            select: () => ({
              from: () => ({
                where: () => Promise.resolve([]), // no existing leads to demote
              }),
            }),
            update: () => ({
              set: () => ({
                where: () => ({
                  returning: () => {
                    const err = Object.assign(new Error("dup lead"), {
                      code: "23505",
                    });
                    throw err;
                  },
                }),
              }),
            }),
          };
          return cb(tx);
        },
      };

      await expect(
        teamsService(db).updateMemberRole("t1", "a1", "lead"),
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  // D21: a company-wide team (parentProjectId === null) has an installer-owned
  // roster. The refusal must cover the WHOLE membership surface — closing only
  // `addMember` would let a founder strip the crew one agent at a time with no
  // supported way to put anyone back (write-out open, write-in shut).
  describe("company-wide team roster is installer-owned (D21)", () => {
    /** One select: the team lookup, returning a null-parent (company-wide) team. */
    const companyWideDb = () =>
      createAgentDb({ selects: [[{ id: "t1", parentProjectId: null }]] });

    it("addMember refuses", async () => {
      await expect(
        teamsService(companyWideDb() as any).addMember("t1", "a1", "member"),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("removeMember refuses", async () => {
      await expect(
        teamsService(companyWideDb() as any).removeMember("t1", "a1"),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("updateMemberRole refuses", async () => {
      await expect(
        teamsService(companyWideDb() as any).updateMemberRole("t1", "a1", "lead"),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("all three name the company-wide reason (not a generic not-found)", async () => {
      for (const call of [
        (s: ReturnType<typeof teamsService>) => s.addMember("t1", "a1", "member"),
        (s: ReturnType<typeof teamsService>) => s.removeMember("t1", "a1"),
        (s: ReturnType<typeof teamsService>) => s.updateMemberRole("t1", "a1", "lead"),
      ]) {
        await expect(call(teamsService(companyWideDb() as any))).rejects.toThrow(
          /company-wide/i,
        );
      }
    });

    it("refuses BEFORE any write — no delete/update/insert is issued", async () => {
      // The guard has to run first, not merely report afterwards: a removeMember
      // that deleted the row and *then* threw would still degrade the roster.
      let writes = 0;
      const db: any = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([{ id: "t1", parentProjectId: null }]),
          }),
        }),
        insert: () => {
          writes++;
          throw new Error("insert must not run");
        },
        delete: () => {
          writes++;
          throw new Error("delete must not run");
        },
        update: () => {
          writes++;
          throw new Error("update must not run");
        },
        transaction: async () => {
          writes++;
          throw new Error("transaction must not run");
        },
      };

      await expect(teamsService(db).addMember("t1", "a1", "member")).rejects.toThrow(
        /company-wide/i,
      );
      await expect(teamsService(db).removeMember("t1", "a1")).rejects.toThrow(
        /company-wide/i,
      );
      await expect(
        teamsService(db).updateMemberRole("t1", "a1", "lead"),
      ).rejects.toThrow(/company-wide/i);
      expect(writes).toBe(0);
    });
  });
});
