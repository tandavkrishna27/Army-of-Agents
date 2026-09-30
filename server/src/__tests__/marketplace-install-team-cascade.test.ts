import { describe, it, expect, vi, beforeEach } from "vitest";

// Each table is DISTINGUISHABLE (`__table`) rather than one shared proxy, so the
// mock below can dispatch on which table a query reads. A positional/shared mock
// answers the wrong query with the right fixture — the exact failure that let a
// guard silently never execute in team-reconcile.test.ts (T2.3b F6).
vi.mock("@armyofagents/db", () => {
  const table = (name: string) =>
    new Proxy({}, { get: (_t, prop) => (prop === "__table" ? name : Symbol("col")) });
  return {
    agents: table("agents"), teams: table("teams"), teamMembers: table("team_members"),
    companySkills: table("company_skills"), projects: table("projects"), plugins: table("plugins"),
  };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("op:eq"),
  and: () => Symbol("op:and"),
  like: () => Symbol("op:like"),
  inArray: () => Symbol("op:inArray"),
}));
vi.mock(
  "../services/outbound-url-guard.js",
  () => import("./helpers/outbound-url-guard.mock.js"),
);

import { installTeam } from "../services/marketplace-install/team-installer.js";
import type { CatalogItem, MarketplaceCatalogFile } from "@armyofagents/shared";

const PINNED_RESOURCE_BASE =
  `https://raw.githubusercontent.com/MeteoriteLabs/aoa-marketplace/${"f".repeat(40)}`;
const PLUGIN: CatalogItem = {
  id: "plugin:aoa-curated/aoa-plugin-github-issues",
  type: "plugin", name: "GitHub Issues", description: "...", version: "1.0.0",
  source: { adapter: "aoa-curated", url: "...", locator: "...", commitSha: "abc" },
  npm: { packageName: "aoa-plugin-github-issues", version: "1.0.0" },
  trust: { tier: "verified", source: "aoa-curated" }, status: "active",
  addedAt: "2026-04-30T00:00:00Z", capabilities: [], category: "integrations", tags: [],
};
const SKILL: CatalogItem = {
  id: "skill:aoa-curated/code-review", type: "skill", name: "Code Review", description: "...", version: "1.0.0",
  source: { adapter: "aoa-curated", url: "...", locator: "...", commitSha: "abc" },
  resourceUrl: `${PINNED_RESOURCE_BASE}/content/skills/code-review/SKILL.md`,
  content: { inline: "# Code Review" },
  trust: { tier: "verified", source: "aoa-curated" }, status: "active",
  addedAt: "2026-04-30T00:00:00Z", category: "engineering", tags: [],
};
const AGENT: CatalogItem = {
  id: "agent:aoa-curated/engineer", type: "agent", name: "Engineer", description: "...", version: "1.0.0",
  source: { adapter: "aoa-curated", url: "...", locator: "...", commitSha: "abc" },
  resourceUrl: `${PINNED_RESOURCE_BASE}/content/agents/engineer/agent.json`,
  trust: { tier: "verified", source: "aoa-curated" }, status: "active",
  addedAt: "2026-04-30T00:00:00Z", category: "engineering", tags: [],
  requires: [{ type: "skill", id: "skill:aoa-curated/code-review" }],
};
const TEAM: CatalogItem = {
  id: "team:aoa-curated/engineering", type: "team", name: "Engineering Team", description: "...", version: "1.0.0",
  source: { adapter: "aoa-curated", url: "...", locator: "...", commitSha: "abc" },
  resourceUrl: `${PINNED_RESOURCE_BASE}/content/teams/engineering/team.json`,
  trust: { tier: "verified", source: "aoa-curated" }, status: "active",
  addedAt: "2026-04-30T00:00:00Z", category: "engineering", tags: [],
  requires: [
    { type: "plugin", id: PLUGIN.id },
    { type: "skill", id: SKILL.id },
    { type: "agent", id: AGENT.id },
  ],
};
const STEWARD: CatalogItem = {
  ...AGENT,
  id: "agent:aoa-curated/aoa-steward",
  name: "Steward",
  resourceUrl: `${PINNED_RESOURCE_BASE}/content/agents/aoa-steward/agent.json`,
  requires: [],
};
const DEFAULT_CREW_WITH_STEWARD: CatalogItem = {
  ...TEAM,
  id: "team:aoa-curated/default-crew",
  name: "AoA Default Crew",
  requires: [
    { type: "agent", id: AGENT.id },
    { type: "agent", id: STEWARD.id },
  ],
};

const CATALOG: MarketplaceCatalogFile = {
  schemaVersion: "1.0.0", generatedAt: "2026-04-30T00:00:00Z", itemCount: 4, items: [PLUGIN, SKILL, AGENT, TEAM],
};

const TEAM_JSON_BODY = JSON.stringify({
  slug: "engineering",
  description: "Engineering team",
  manifest: { defaultProjectFunctionType: "software_development" },
  agents: [
    { templateOrigin: AGENT.id, name: "Engineer-1" },
    { templateOrigin: AGENT.id, name: "Engineer-2" },
  ],
});

describe("installTeam — Saga cascade", () => {
  let pluginInstalls: any[] = [];
  let skillInserts: any[] = [];
  let agentInserts: any[] = [];
  let teamInserts: any[] = [];
  let teamMemberInserts: any[] = [];

  const mockPluginInstaller = vi.fn(async (opts: any) => {
    pluginInstalls.push(opts);
    return { pluginId: `plug-${pluginInstalls.length}`, alreadyInstalled: false };
  });

  /** A `.where()` that is both awaitable and `.limit()`-able. */
  const answer = (rows: any[]) =>
    Object.assign(Promise.resolve(rows), { limit: (_n?: number) => Promise.resolve(rows) });

  /**
   * @param onProjectsRead - fires when the department pre-flight actually runs.
   * @param existingSkills - rows the company_skills lookups should return.
   */
  function makeSelect(opts: {
    departmentRows?: any[];
    onProjectsRead?: () => void;
    existingSkills?: any[];
  }) {
    return (_fields?: any) => ({
      from: (table: any) => {
        const name = (table as { __table?: string }).__table;
        if (name === "projects") {
          opts.onProjectsRead?.();
          return { where: () => answer(opts.departmentRows ?? []) };
        }
        if (name === "company_skills") {
          return { where: () => answer(opts.existingSkills ?? []) };
        }
        // agents / teams — the conflict resolvers; [] = no conflict.
        return { where: () => answer([]) };
      },
    });
  }

  /**
   * T2.3c: skills are inserted OUTSIDE the txn, through the real installSkill.
   * Dispatched on the table rather than accepting whatever arrives — a mock that
   * answers for every table is how the wrong query gets the right fixture.
   */
  const topLevelInsert = (table: any) => {
    const name = (table as { __table?: string }).__table;
    if (name !== "company_skills") {
      throw new Error(`unexpected top-level insert into ${name}`);
    }
    return {
      values: (row: any) => {
        skillInserts.push(row);
        return {
          returning: () => Promise.resolve([{ ...row, id: `skill-${skillInserts.length}-uuid` }]),
        };
      },
    };
  };

  const mockDb = {
    transaction: async (cb: (tx: any) => Promise<any>) => {
      const tx = {
        insert: (_table: any) => ({
          values: (row: any) => {
            if (row.adapterType !== undefined || row.skillKeys !== undefined) {
              agentInserts.push(row);
            } else if (row.parentProjectId !== undefined || row.manifest !== undefined) {
              teamInserts.push(row);
            } else if (row.teamId !== undefined && row.agentId !== undefined && row.role !== undefined) {
              teamMemberInserts.push(row);
            }
            const insertId = `${agentInserts.length + teamInserts.length + teamMemberInserts.length}-uuid`;
            return {
              onConflictDoNothing: () => ({
                returning: (_cols?: any) => Promise.resolve([{ id: insertId }]),
              }),
              returning: () => Promise.resolve([{ ...row, id: insertId }]),
            };
          },
        }),
        // Used by the conflict-resolvers (returns [] = no conflict).
        select: makeSelect({}),
        // T3.0.5: createMarketplaceAgent calls db.transaction() from inside the outer
        // transaction. Pass the same tx so the inner savepoint path stays in scope and
        // agent inserts still flow through the same insert tracker above.
        transaction: async (cb: (innerTx: any) => Promise<any>) => cb(tx),
      };
      return cb(tx);
    },
    insert: topLevelInsert,
    select: makeSelect({
      departmentRows: [{ id: "dept-uuid-1", type: "department", companyId: "c1" }],
    }),
  };

  beforeEach(() => {
    pluginInstalls = []; skillInserts = []; agentInserts = []; teamInserts = []; teamMemberInserts = [];
    global.fetch = vi.fn(async (url: string) => {
      if (String(url).includes("team.json")) {
        return { ok: true, status: 200, text: async () => TEAM_JSON_BODY };
      }
      if (String(url).includes("agent.json")) {
        // T3.0.5: team-installer now routes through normalizeMarketplaceAgentTemplate,
        // which requires valid agent.v1 JSON (legacy format requires promptTemplate).
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({
            schemaVersion: "agent.v1",
            id: "aoa-curated/engineer",
            name: "Engineer",
            description: "Senior software engineer",
            instructions: { type: "inline", content: "Build carefully." },
            aoa: {
              adapterType: "claude_local",
              install: { defaultRole: "engineer" },
              skillKeys: [SKILL.id],
            },
          }),
        };
      }
      return { ok: false, status: 404 };
    }) as any;
  });

  it("phase 1: pre-flight validates department exists", async () => {
    const dbNoDept = { ...mockDb, select: makeSelect({ departmentRows: [] }) };

    await expect(
      installTeam({
        catalogItem: TEAM, catalog: CATALOG, companyId: "c1",
        targetDepartmentId: "missing-dept", db: dbNoDept as any, installPlugin: mockPluginInstaller,
      }),
    ).rejects.toThrow(/department.*not found/i);
  });

  it("rejects a default-crew body that omits Steward before any install writes", async () => {
    await expect(
      installTeam({
        catalogItem: DEFAULT_CREW_WITH_STEWARD,
        catalog: {
          ...CATALOG,
          itemCount: 3,
          items: [AGENT, STEWARD, DEFAULT_CREW_WITH_STEWARD],
        },
        companyId: "c1",
        targetDepartmentId: null,
        db: dbNoSelectAllowed as any,
        installPlugin: mockPluginInstaller,
      }),
    ).rejects.toThrow(/default crew.*Steward/i);

    expect(pluginInstalls).toHaveLength(0);
    expect(skillInserts).toHaveLength(0);
    expect(agentInserts).toHaveLength(0);
    expect(teamInserts).toHaveLength(0);
  });

  // ── D21: company-wide teams (no parent department) ────────────────────────
  //
  // AoA crew are company-wide singletons — Adjutant serves every department —
  // and nothing creates a department at company-create time, so the crew must
  // be installable before any department exists. `targetDepartmentId: null`
  // means "company-wide": the department pre-flight is skipped entirely and
  // `teams.parent_project_id` is written NULL.

  // Rejects any read of `projects` so the assertion is "pre-flight never ran",
  // not merely "a lookup happened to succeed". Narrowed to that table rather
  // than to "any select" because `installTeam` legitimately reads
  // `company_skills` on every install (T2.3c) — a blanket throw would make these
  // two tests fail for a reason that has nothing to do with D21.
  const dbNoSelectAllowed = {
    ...mockDb,
    select: makeSelect({
      onProjectsRead: () => {
        throw new Error("department pre-flight must not run for a company-wide install");
      },
    }),
  };

  it("D21: installs a company-wide team when targetDepartmentId is null", async () => {
    const result = await installTeam({
      catalogItem: TEAM, catalog: CATALOG, companyId: "c1",
      targetDepartmentId: null, db: dbNoSelectAllowed as any, installPlugin: mockPluginInstaller,
    });

    expect(teamInserts).toHaveLength(1);
    expect(teamInserts[0].parentProjectId).toBeNull();
    expect(result.teamId).toBeDefined();
  });

  it("D21: installs a company-wide team when targetDepartmentId is omitted", async () => {
    const result = await installTeam({
      catalogItem: TEAM, catalog: CATALOG, companyId: "c1",
      db: dbNoSelectAllowed as any, installPlugin: mockPluginInstaller,
    });

    expect(teamInserts).toHaveLength(1);
    expect(teamInserts[0].parentProjectId).toBeNull();
    expect(result.teamId).toBeDefined();
  });

  it("D21: a supplied-but-wrong-type project is still rejected (never silently nulled)", async () => {
    // A `type: "project"` row is not a department. Relaxing the precondition
    // for null must not degrade validation of a supplied id into a fallback.
    const dbProjectNotDept = {
      ...mockDb,
      select: makeSelect({
        departmentRows: [{ id: "proj-uuid-1", type: "project", companyId: "c1" }],
      }),
    };

    await expect(
      installTeam({
        catalogItem: TEAM, catalog: CATALOG, companyId: "c1",
        targetDepartmentId: "proj-uuid-1", db: dbProjectNotDept as any, installPlugin: mockPluginInstaller,
      }),
    ).rejects.toThrow(/department.*not found/i);
    expect(teamInserts).toHaveLength(0);
  });

  it("phase 2: installs all required plugins (idempotent preconditions)", async () => {
    await installTeam({
      catalogItem: TEAM, catalog: CATALOG, companyId: "c1",
      targetDepartmentId: "dept-uuid-1", db: mockDb as any, installPlugin: mockPluginInstaller,
    });

    expect(pluginInstalls).toHaveLength(1);
    expect(pluginInstalls[0].catalogItem.id).toBe(PLUGIN.id);
  });

  it("installs team + skills + agents + team_members", async () => {
    const result = await installTeam({
      catalogItem: TEAM, catalog: CATALOG, companyId: "c1",
      targetDepartmentId: "dept-uuid-1", db: mockDb as any, installPlugin: mockPluginInstaller,
    });

    expect(skillInserts.length).toBeGreaterThanOrEqual(1);
    expect(skillInserts[0].sourceType).toBe("catalog");
    expect(skillInserts[0].metadata.catalogTrustTier).toBe("verified");
    // T2.3c: the row is written by the REAL installSkill, not a hand-rolled
    // copy. `catalogProvider` is a field only that installer sets, so it is the
    // cheap discriminator here; field parity against a real installer row is
    // asserted properly against a real DB in
    // crew-marketplace-bootstrap.integration.test.ts.
    expect(skillInserts[0].metadata).toHaveProperty("catalogProvider");
    // No bundle on this fixture → the derivation legitimately lands on
    // markdown_only. The bundle-carrying case is the integration test's job.
    expect(skillInserts[0].trustLevel).toBe("markdown_only");

    expect(agentInserts.length).toBe(2);
    expect(teamInserts).toHaveLength(1);
    expect(teamInserts[0].templateOrigin).toBe(TEAM.id);
    expect(teamInserts[0].templateVersion).toBe("1.0.0");
    expect(teamInserts[0].parentProjectId).toBe("dept-uuid-1");
    expect(result.teamId).toBeDefined();
    expect(result.cascadeResults.length).toBeGreaterThanOrEqual(4);

    // team_members link rows: one per agent, first is lead
    expect(teamMemberInserts).toHaveLength(2);
    expect(teamMemberInserts[0].role).toBe("lead");
    expect(teamMemberInserts[1].role).toBe("member");
    for (const tm of teamMemberInserts) {
      expect(tm.teamId).toBeDefined();
      expect(tm.agentId).toBeDefined();
    }
  });

  it("if the team-body txn fails, plugin from phase 2 remains (Saga semantics)", async () => {
    const dbThatFailsTxn = {
      ...mockDb,
      transaction: async (_cb: any) => { throw new Error("DB error during team insert"); },
    };

    await expect(
      installTeam({
        catalogItem: TEAM, catalog: CATALOG, companyId: "c1",
        targetDepartmentId: "dept-uuid-1", db: dbThatFailsTxn as any, installPlugin: mockPluginInstaller,
      }),
    ).rejects.toThrow(/DB error/);

    // Plugin install was called BEFORE the txn failed — it stays
    expect(pluginInstalls).toHaveLength(1);
  });

  // An already-present key is SKIPPED, never re-installed and never upgraded.
  // Two things ride on this: `installSkill` THROWS on a version mismatch ("use
  // the update flow"), so a founder installing a team must not fail because one
  // required skill is pinned at an older version; and re-materializing a bundle
  // over a company's existing skill is an update decision, not an install one.
  it("skips a skill the company already has, and completes the rest of the install", async () => {
    const mockDbSkillExists = {
      ...mockDb,
      select: makeSelect({
        departmentRows: [{ id: "dept-uuid-1", type: "department", companyId: "c1" }],
        existingSkills: [{ id: "existing-skill-uuid", key: SKILL.id }],
      }),
      insert: () => {
        throw new Error("an already-installed skill must not be re-inserted");
      },
    };

    const result = await installTeam({
      catalogItem: TEAM,
      catalog: CATALOG,
      companyId: "c1",
      targetDepartmentId: "dept-uuid-1",
      db: mockDbSkillExists as any,
      installPlugin: mockPluginInstaller,
    });

    // Nothing was written for the skill…
    expect(skillInserts).toHaveLength(0);
    // …and the cascade record points at the row that was already there.
    const skillResult = result.cascadeResults.find((r) => r.step === "skill-install");
    expect(skillResult).toBeDefined();
    expect(skillResult?.status).toBe("skipped");
    expect(skillResult?.resultEntityId).toBe("existing-skill-uuid");

    // Team was still created despite the skipped skill
    expect(result.teamId).toBeDefined();
  });

  // T2.3c moved skill installs OUT of the team-body transaction because
  // `installSkill` git-clones bundles. The consequence has to be deliberate:
  // a later failure leaves the skill rows in place. That is safe (additive,
  // idempotent, version-scoped new-file writes — `uninstallTeam` already leaves
  // company_skills alone) and it is what lets a retry re-use them.
  it("skills are written before the team-body txn and survive its failure", async () => {
    const dbThatFailsTxn = {
      ...mockDb,
      transaction: async (_cb: any) => { throw new Error("DB error during team insert"); },
    };

    await expect(
      installTeam({
        catalogItem: TEAM, catalog: CATALOG, companyId: "c1",
        targetDepartmentId: "dept-uuid-1", db: dbThatFailsTxn as any, installPlugin: mockPluginInstaller,
      }),
    ).rejects.toThrow(/DB error/);

    expect(skillInserts).toHaveLength(1);
    expect(skillInserts[0].key).toBe(SKILL.id);
  });

  // ── The deadline must reach phase 3 ───────────────────────────────────────
  // Company create's 30s budget would otherwise be silently uncapped across N
  // bundle clones. Both of these abort AFTER phase 1: a pre-aborted signal is
  // caught by the phase-1c check (`…before the team template fetch`), whose
  // message also matches a loose /deadline/i — so that test would keep passing
  // with BOTH phase-3 checks deleted. These assert the phase-3 messages
  // specifically, which no earlier check can produce.

  it("re-checks the deadline on ENTRY to phase 3, after pre-flight and plugins", async () => {
    const controller = new AbortController();
    const inner = global.fetch;
    global.fetch = (async (url: any, init?: any) => {
      const res = await (inner as any)(url, init);
      // Fires once pre-flight's last fetch is done — i.e. strictly after phase 1.
      if (String(url).includes("agent.json")) controller.abort();
      return res;
    }) as any;

    await expect(
      installTeam({
        catalogItem: TEAM, catalog: CATALOG, companyId: "c1",
        targetDepartmentId: "dept-uuid-1", db: mockDb as any,
        installPlugin: mockPluginInstaller, signal: controller.signal,
      }),
    ).rejects.toThrow("Team install exceeded its deadline before the skill installs");

    // Pre-flight and the plugin precondition both completed…
    expect(pluginInstalls).toHaveLength(1);
    // …and nothing past the phase-3 gate ran.
    expect(skillInserts).toHaveLength(0);
    expect(teamInserts).toHaveLength(0);
  });

  it("re-checks the deadline BETWEEN skill installs, not just on entry", async () => {
    const SKILL_FETCHED: CatalogItem = {
      ...SKILL,
      id: "skill:aoa-curated/web-search",
      name: "Web Search",
      content: undefined, // forces installSkill down the HTTP path
      resourceUrl: `${PINNED_RESOURCE_BASE}/content/skills/web-search/SKILL.md`,
    };
    // The fetched skill is FIRST, so the abort lands while the loop is running.
    const TEAM_TWO_SKILLS: CatalogItem = {
      ...TEAM,
      requires: [
        { type: "plugin", id: PLUGIN.id },
        { type: "skill", id: SKILL_FETCHED.id },
        { type: "skill", id: SKILL.id },
        { type: "agent", id: AGENT.id },
      ],
    };
    const controller = new AbortController();
    const inner = global.fetch;
    global.fetch = (async (url: any, init?: any) => {
      if (String(url).includes("web-search")) {
        // Abort, then answer: skill #1's install completes, skill #2 must not start.
        controller.abort();
        return { ok: true, status: 200, text: async () => "# Web Search" };
      }
      return (inner as any)(url, init);
    }) as any;

    await expect(
      installTeam({
        catalogItem: TEAM_TWO_SKILLS,
        catalog: { ...CATALOG, items: [PLUGIN, SKILL, SKILL_FETCHED, AGENT, TEAM_TWO_SKILLS] },
        companyId: "c1", targetDepartmentId: "dept-uuid-1", db: mockDb as any,
        installPlugin: mockPluginInstaller, signal: controller.signal,
      }),
    ).rejects.toThrow(`Team install exceeded its deadline before the skill install for ${SKILL.id}`);

    // The discriminator against the entry-check test above: the loop DID run,
    // and stopped between items rather than before any of them.
    expect(skillInserts.map((r) => r.key)).toEqual([SKILL_FETCHED.id]);
    expect(teamInserts).toHaveLength(0);
  });
});
