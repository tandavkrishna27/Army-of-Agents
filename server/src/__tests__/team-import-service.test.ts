import { beforeEach, describe, expect, it, vi } from "vitest";

// -- Mocks --------------------------------------------------------------------

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  inArray: vi.fn((c: any, v: any) => ({ inArray: [c, v] })),
  sql: vi.fn(() => ({ sql: true })),
}));

vi.mock("@armyofagents/db", () => ({
  agents: {
    id: "agents_id",
    companyId: "agents_company_id",
    name: "agents_name",
  },
  companySkills: {
    id: "company_skills_id",
    companyId: "company_skills_company_id",
    key: "company_skills_key",
  },
  teams: {
    id: "teams_id",
    companyId: "teams_company_id",
    name: "teams_name",
    slug: "teams_slug",
  },
  teamMembers: {
    id: "team_members_id",
    teamId: "team_members_team_id",
    agentId: "team_members_agent_id",
    role: "team_members_role",
  },
  teamCoordinations: {
    id: "team_coordinations_id",
    teamId: "team_coordinations_team_id",
  },
  agentProjects: {
    agentId: "agent_projects_agent_id",
    projectId: "agent_projects_project_id",
    companyId: "agent_projects_company_id",
  },
  projects: {
    id: "projects_id",
    companyId: "projects_company_id",
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

// Stub the scaffolder so install tests don't need to mock the deeper
// scaffolder query chain; we only care that install reaches step 4.
vi.mock("../services/team-scaffolder.js", () => ({
  teamScaffolderService: () => ({
    scaffoldInitial: vi.fn().mockResolvedValue("# scaffolded coordination\n"),
  }),
}));

import { teamImportService } from "../services/team-import.js";
import { createAgentDb } from "./helpers/mock-db.js";

// -- Fixtures -----------------------------------------------------------------

const VALID_YAML = `
schemaVersion: 1
name: frontend-team
version: 1.0.0
agents:
  - name: alice
    role: lead
    skillKeys: [react]
routing:
  rules: []
skillDeps: ["@aoa/react@1.0.0"]
`;

// -- Tests --------------------------------------------------------------------

describe("teamImportService.preview()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns parsed manifest + missing dependencies", async () => {
    // No existing agents, no installed skills.
    const db = createAgentDb({
      selects: [
        [], // agents collision lookup
        [], // companySkills lookup
      ],
    });

    const result = await teamImportService(db as any).preview(
      "co-1",
      VALID_YAML,
    );

    expect(result.manifest.name).toBe("frontend-team");
    expect(result.collisions).toEqual([]);
    expect(result.skillsToInstall).toContain("@aoa/react@1.0.0");
  });

  it("flags collision when an agent name already exists", async () => {
    const db = createAgentDb({
      selects: [
        [{ id: "a1", name: "alice" }], // existing agent collides
        [], // no skills installed
      ],
    });

    const result = await teamImportService(db as any).preview(
      "co-1",
      VALID_YAML,
    );

    expect(result.collisions).toContainEqual({
      kind: "agent",
      name: "alice",
      existingId: "a1",
    });
  });

  it("rejects malformed YAML", async () => {
    const db = createAgentDb({});

    await expect(
      teamImportService(db as any).preview("co-1", ":::not yaml:::"),
    ).rejects.toThrow();
  });

  it("does not list skills that are already installed", async () => {
    const db = createAgentDb({
      selects: [
        [], // no agent collisions
        [{ key: "@aoa/react@1.0.0" }], // skill already installed
      ],
    });

    const result = await teamImportService(db as any).preview(
      "co-1",
      VALID_YAML,
    );

    expect(result.skillsToInstall).toEqual([]);
  });

  it("rejects manifest with duplicate agent names (P2)", async () => {
    // Two inline agents both named "alice" -- the install path's
    // agentIdByLocalName map would silently collapse them. Preview must
    // reject the bad input with a 400-shaped error before hitting DB.
    const DUPLICATE_NAMES_YAML = `
schemaVersion: 1
name: dup-team
version: 1.0.0
agents:
  - name: alice
    role: lead
    skillKeys: []
  - name: alice
    role: member
    skillKeys: []
routing:
  rules: []
`;

    const db = createAgentDb({});
    await expect(
      teamImportService(db as any).preview("co-1", DUPLICATE_NAMES_YAML),
    ).rejects.toThrow(/duplicate agent names.*alice/);
  });
});

// -- Install tests ------------------------------------------------------------
//
// Strategy: tests #1-#3 exercise the pre-transaction guards exhaustively
// (skills missing, >1 lead, slug already taken). Test #4 is a smoke test
// that confirms `install()` reaches `db.transaction(...)` on the happy path
// and produces the expected return shape -- we don't try to recreate the
// full insert sequence inside the mock because the chain (insert agents,
// insert agent_projects, insert team, insert team_members, insert
// coordination) would make the test more about the mock than the code.
// Slice 9's QA suite covers the live cascade end-to-end against a real DB.

const TWO_LEADS_YAML = `
schemaVersion: 1
name: dual-lead-team
version: 1.0.0
agents:
  - name: alice
    role: lead
    skillKeys: []
  - name: bob
    role: lead
    skillKeys: []
routing:
  rules: []
`;

const HAPPY_PATH_YAML = `
schemaVersion: 1
name: happy-team
version: 1.0.0
displayName: Happy Team
description: A test team
agents:
  - name: alice
    role: lead
    skillKeys: []
routing:
  rules: []
`;

describe("teamImportService.install()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses install when manifest requires uninstalled skills", async () => {
    // Preview: no agent collisions, no installed skills -> skill is missing.
    const db = createAgentDb({
      selects: [
        [], // agents collision lookup
        [], // companySkills lookup -> none installed
      ],
    });

    await expect(
      teamImportService(db as any).install("co-1", VALID_YAML, {
        collisions: {},
        parentProjectId: "proj-1",
      }),
    ).rejects.toThrow(/requires skills not installed/);
  });

  it("refuses install when manifest declares more than one lead", async () => {
    // Preview returns no missing skills (no skillDeps in this manifest).
    const db = createAgentDb({
      selects: [
        [], // agents collision lookup
      ],
    });

    await expect(
      teamImportService(db as any).install("co-1", TWO_LEADS_YAML, {
        collisions: {},
        parentProjectId: "proj-1",
      }),
    ).rejects.toThrow(/at most one lead per team/);
  });

  it("refuses install when a team with the same slug already exists", async () => {
    // Preview clean -> then the slug-existence probe finds a row -> throw.
    const db = createAgentDb({
      selects: [
        [], // preview: agents collision lookup
        [{ id: "existing-team-1" }], // slug already taken
      ],
    });

    await expect(
      teamImportService(db as any).install("co-1", HAPPY_PATH_YAML, {
        collisions: {},
        parentProjectId: "proj-1",
      }),
    ).rejects.toThrow(/already exists in this company/);
  });

  it("happy path: returns team id/slug/name/parentProjectId after cascade", async () => {
    // Sequence:
    //   1. preview -> agents collision lookup -> []
    //   2. slug-existence probe -> []
    //   3. P1 parent-project company check -> [{id: "proj-1"}]
    //   4. tx.insert(agents).returning -> [{id: "new-agent-1"}]
    //   5. tx.insert(agentProjects) -> no return
    //   6. helper: SELECT existing-slugs (inside tx) -> []
    //   7. helper: tx.insert(teams).returning -> [{...}]
    //   8. tx.insert(teamMembers) -> no return
    //   9. (scaffolder is stubbed at the module level, so it never queries)
    //  10. tx.insert(teamCoordinations) -> no return
    const db = createAgentDb({
      selects: [
        [], // 1: preview agents collision
        [], // 2: slug existence pre-flight
        [{ id: "proj-1" }], // 3: P1 parent-project company check
        [], // 6: helper's existing-slugs probe (inside tx)
      ],
      inserts: [
        [{ id: "new-agent-1" }], // 4: agents.returning
        [], // 5: agentProjects
        [
          {
            id: "new-team-1",
            slug: "happy-team",
            name: "Happy Team",
            parentProjectId: "proj-1",
          },
        ], // 7: teams.returning (via helper)
        [], // 8: teamMembers
        [], // 10: teamCoordinations
      ],
    });

    const result = await teamImportService(db as any).install(
      "co-1",
      HAPPY_PATH_YAML,
      { collisions: {}, parentProjectId: "proj-1" },
    );

    expect(result).toEqual({
      id: "new-team-1",
      slug: "happy-team",
      name: "Happy Team",
      parentProjectId: "proj-1",
      warnings: [],
    });
  });

  it("refuses install when parentProjectId belongs to another company (P1)", async () => {
    // Pre-tx sequence:
    //   1. preview agents collision lookup -> []
    //   2. slug existence probe -> []
    //   3. P1 parent-project company check -> [] (cross-tenant guard fails)
    const db = createAgentDb({
      selects: [
        [], // 1: preview agents collision
        [], // 2: slug existence
        [], // 3: P1 parent-project company check returns empty
      ],
    });

    await expect(
      teamImportService(db as any).install("co-1", HAPPY_PATH_YAML, {
        collisions: {},
        parentProjectId: "from-other-company",
      }),
    ).rejects.toThrow(/parent project.*not found in company/);
  });

  it("emits a warning when 'replace' silently grants dept membership (P3-D)", async () => {
    // Task 11 / P3-D (upgraded to P2 by review): when the founder picks
    // 'replace' for an existing-agent collision and that agent is NOT in
    // the parent department, the install path silently inserts an
    // agent_projects row to satisfy the dept-membership invariant. The
    // founder doesn't expect 'replace' to mutate dept membership -- it
    // sounds like an in-place reuse. Surface a warning string so the UI
    // can show what happened.
    //
    // Sequence:
    //   Pre-tx
    //     1. preview agents collision lookup -> [{id, name: "alice"}]
    //     2. slug-existence probe -> []
    //     3. P1 parent-project company check -> [{id: "proj-1"}]
    //   In-tx
    //     4. deptCheck for replace agent -> []  (NOT in parent dept)
    //     5. helper's existing-slugs probe -> []
    //   Inserts (in-tx)
    //     1. agentProjects (silent grant) -> []
    //     2. teams.returning (via helper) -> [{...}]
    //     3. teamMembers -> []
    //     4. teamCoordinations -> []
    const db = createAgentDb({
      selects: [
        [{ id: "agent-existing-1", name: "alice" }], // 1: preview collision
        [], // 2: slug existence
        [{ id: "proj-1" }], // 3: P1 project check
        [], // 4: deptCheck -> empty (agent NOT in dept, triggers grant)
        [], // 5: helper's existing-slugs probe
      ],
      inserts: [
        [], // 1: agentProjects (silent grant)
        [
          {
            id: "new-team-1",
            slug: "happy-team",
            name: "Happy Team",
            parentProjectId: "proj-1",
          },
        ], // 2: teams.returning
        [], // 3: teamMembers
        [], // 4: teamCoordinations
      ],
    });

    const result = await teamImportService(db as any).install(
      "co-1",
      HAPPY_PATH_YAML,
      {
        collisions: { alice: "replace" },
        parentProjectId: "proj-1",
      },
    );

    expect(result.warnings).toBeDefined();
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/alice.*department/i),
      ]),
    );
    // The agent id should also appear in the warning so the message is
    // debuggable, not just human-readable.
    expect(result.warnings.some((w: string) => w.includes("agent-existing-1"))).toBe(
      true,
    );
  });

  it("does NOT emit a warning when 'replace' agent is already in parent dept", async () => {
    // Counter-test for the warning above: when the existing agent IS
    // already in the parent department, the install path skips the
    // agent_projects insert and emits no warning.
    //
    // Sequence:
    //   Pre-tx
    //     1. preview agents collision lookup -> [{id, name: "alice"}]
    //     2. slug-existence probe -> []
    //     3. P1 parent-project company check -> [{id: "proj-1"}]
    //   In-tx
    //     4. deptCheck for replace agent -> [{...}] (already in dept)
    //     5. helper's existing-slugs probe -> []
    const db = createAgentDb({
      selects: [
        [{ id: "agent-existing-1", name: "alice" }], // 1: preview collision
        [], // 2: slug existence
        [{ id: "proj-1" }], // 3: P1 project check
        [
          {
            agentId: "agent-existing-1",
            projectId: "proj-1",
            companyId: "co-1",
          },
        ], // 4: deptCheck -> agent already in dept (no grant needed)
        [], // 5: helper's existing-slugs probe
      ],
      inserts: [
        [
          {
            id: "new-team-1",
            slug: "happy-team",
            name: "Happy Team",
            parentProjectId: "proj-1",
          },
        ], // 1: teams.returning (no agentProjects insert this time)
        [], // 2: teamMembers
        [], // 3: teamCoordinations
      ],
    });

    const result = await teamImportService(db as any).install(
      "co-1",
      HAPPY_PATH_YAML,
      {
        collisions: { alice: "replace" },
        parentProjectId: "proj-1",
      },
    );

    expect(result.warnings).toEqual([]);
  });

  it("converts PG 23505 on slug race during install to 409 (P1-C)", async () => {
    // P1-C: the pre-flight slug-existence probe at install() narrows but
    // does not eliminate the TOCTOU window -- between the probe and the
    // tx.insert(teams) inside the transaction, a concurrent install can
    // win the slug. The shared insertTeamWithUniqueSlug helper retries up
    // to 5 times; if all retries fail (slug space saturated), the helper
    // throws conflict() and the service surfaces a 409.
    //
    // This test forces the helper to throw 23505 on every team-insert
    // attempt: existing-slugs probe always returns empty (helper picks
    // the same base slug each time), and the team insert always rejects
    // with 23505. After maxRetries the helper throws conflict().
    let selectCalls = 0;
    let txInsertCalls = 0;
    const db: any = {
      select: () => ({
        from: () => ({
          where: () => {
            const idx = selectCalls++;
            // Pre-tx order (no skillDeps in HAPPY_PATH_YAML so no
            // companySkills probe):
            //   0: preview agents collision lookup -> []
            //   1: slug existence pre-flight -> [] (clean)
            //   2: P1 parent-project company check -> [{id: proj-1}]
            //   3+: helper's existing-slugs probe inside tx (always [])
            if (idx === 0) return Promise.resolve([]);
            if (idx === 1) return Promise.resolve([]);
            if (idx === 2) return Promise.resolve([{ id: "proj-1" }]);
            // Helper's existing-slugs probe -- empty so helper keeps
            // picking the colliding base slug.
            return Promise.resolve([]);
          },
        }),
      }),
      transaction: async (cb: (tx: any) => Promise<unknown>) => {
        // Step 1 of install inserts agents (with .returning()) and
        // agent_projects (no .returning() -- awaited directly off
        // .values()). The helper's team insert uses .returning().
        const tx: any = {
          select: db.select,
          insert: () => {
            const valuesChain: any = {
              returning: () => {
                txInsertCalls++;
                // 1st .returning() call: agents insert (Step 1) -- succeed
                if (txInsertCalls === 1) {
                  return Promise.resolve([{ id: "new-agent-1" }]);
                }
                // From the 2nd .returning() onward (helper's team
                // insert), every attempt throws 23505. Helper retries up
                // to maxRetries before throwing conflict().
                const err = Object.assign(new Error("dup slug"), {
                  code: "23505",
                });
                throw err;
              },
              // agent_projects insert is `await tx.insert(agentProjects).values(...)`
              // -- no .returning(). The chain itself is the awaited value.
              then: (resolve: (v: unknown) => unknown) =>
                Promise.resolve(resolve(undefined)),
            };
            return { values: () => valuesChain };
          },
        };
        return cb(tx);
      },
    };

    await expect(
      teamImportService(db).install("co-1", HAPPY_PATH_YAML, {
        collisions: {},
        parentProjectId: "proj-1",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
