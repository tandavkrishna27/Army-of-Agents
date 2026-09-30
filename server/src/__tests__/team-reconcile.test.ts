import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../services/marketplace-install/fetch-resource.js", () => ({
  fetchCatalogResource: vi.fn(),
}));
vi.mock("../services/marketplace-install/agent-runtime.js", () => ({
  parseMarketplaceAgentTemplate: vi.fn().mockReturnValue({ parsed: true }),
  normalizeMarketplaceAgentTemplate: vi.fn().mockReturnValue({ normalized: true, kind: "aoa", triggers: [] }),
}));
vi.mock("../services/marketplace-install/agent-create.js", () => ({
  createMarketplaceAgent: vi.fn(),
}));
vi.mock("../services/marketplace-install/conflict-resolver.js", () => ({
  resolveAgentNameConflict: vi.fn().mockImplementation(async ({ desiredName }: { desiredName: string }) => desiredName),
}));
vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return { teams: tableProxy, teamMembers: tableProxy, agents: tableProxy };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("op:eq"),
  and: () => Symbol("op:and"),
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { reconcileTeamMembers } from "../services/marketplace-install/team-reconcile.js";
import { fetchCatalogResource } from "../services/marketplace-install/fetch-resource.js";
import { createMarketplaceAgent } from "../services/marketplace-install/agent-create.js";

const TEAM_CATALOG_ITEM = {
  id: "aoa-curated/standard-crew/team",
  type: "team" as const,
  name: "Standard Crew",
  version: "0.2.0",
  description: "test",
  source: { adapter: "aoa-curated", url: "https://example.com", locator: "team", commitSha: "abc" },
  resourceUrl: "https://example.com/team.json",
  trust: { tier: "verified" as const, source: "aoa-curated" },
  status: "active" as const,
  addedAt: "2026-01-01T00:00:00Z",
  category: "crew",
  tags: [],
  requires: [],
};

const LIBRARIAN_CATALOG_ITEM = {
  ...TEAM_CATALOG_ITEM,
  id: "aoa-curated/standard-crew/librarian",
  type: "agent" as const,
  name: "Librarian",
};

function makeDb(opts: {
  teamRows: Array<{ id: string; templateOrigin: string | null }>;
  existingMemberOrigins: string[];
  /** `kind='aoa'` rows for the duplicate-name/legacy-slug guard. */
  unmanagedAgents?: Array<{ name: string; templateOrigin: string | null }>;
  insertSpy?: ReturnType<typeof vi.fn>;
}) {
  const insertSpy = opts.insertSpy ?? vi.fn().mockResolvedValue(undefined);
  // Keyed dispatch, NOT positional. The previous `selectCall % 2` alternation
  // silently mis-fed the third query added later (the unmanaged-agents scan):
  // it handed back `teamRows`, whose objects have no `name`, so the filter
  // dropped everything and the duplicate guard could never fire. Four tests
  // still passed. Dispatching on the selected columns makes a new query fail
  // loudly instead of being answered by whatever came next in the sequence.
  const db = {
    select: vi.fn().mockImplementation((cols?: Record<string, unknown>) => {
      const keys = Object.keys(cols ?? {}).sort().join(",");
      const rowsFor = (): unknown[] => {
        if (keys === "id,templateOrigin") return opts.teamRows;
        if (keys === "templateOrigin") {
          return opts.existingMemberOrigins.map((templateOrigin) => ({ templateOrigin }));
        }
        if (keys === "name,templateOrigin") return opts.unmanagedAgents ?? [];
        throw new Error(`team-reconcile mock: unmapped select(${keys || "*"})`);
      };
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(async () => rowsFor()),
          innerJoin: vi.fn().mockReturnThis(),
        }),
      };
    }),
    insert: vi.fn().mockReturnValue({ values: insertSpy }),
  };
  return { db, insertSpy };
}

describe("reconcileTeamMembers (WS6)", () => {
  beforeEach(() => {
    vi.mocked(fetchCatalogResource).mockReset();
    vi.mocked(createMarketplaceAgent).mockReset();
  });

  it("installs a roster member missing from an already-installed team", async () => {
    vi.mocked(fetchCatalogResource).mockImplementation(async (item: any) => {
      if (item.type === "team") {
        return JSON.stringify({
          slug: "standard-crew",
          agents: [
            { templateOrigin: "aoa-curated/standard-crew/adjutant", name: "Adjutant" },
            { templateOrigin: "aoa-curated/standard-crew/librarian", name: "Librarian" },
          ],
        });
      }
      return JSON.stringify({ id: item.id, name: item.name });
    });
    vi.mocked(createMarketplaceAgent).mockResolvedValue({ agentId: "agent-librarian-1" });

    const { db, insertSpy } = makeDb({
      teamRows: [{ id: "team-1", templateOrigin: TEAM_CATALOG_ITEM.id }],
      // Adjutant already installed; Librarian is not.
      existingMemberOrigins: ["aoa-curated/standard-crew/adjutant"],
    });

    const result = await reconcileTeamMembers({
      db: db as any,
      companyId: "co-1",
      catalogItems: [TEAM_CATALOG_ITEM, LIBRARIAN_CATALOG_ITEM],
      instructionsService: { materializeManagedBundle: vi.fn() } as any,
    });

    expect(createMarketplaceAgent).toHaveBeenCalledTimes(1);
    expect(createMarketplaceAgent).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "co-1", desiredName: "Librarian" }),
    );
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team-1", agentId: "agent-librarian-1", role: "member" }),
    );
    expect(result).toEqual({ teamsReconciled: 1, membersAdded: 1 });
  });

  // A founder can rename a crew agent through PATCH /agents/:id without
  // touching templateOrigin, so a name check alone misses the very case that
  // matters: reconcile would install a brand-new Librarian beside the founder's
  // renamed one, and the original — which owns every task and run — would stay
  // `@legacy` forever, unreachable by any later repair.
  it("does not install a roster member an unmanaged RENAMED agent already covers", async () => {
    vi.mocked(fetchCatalogResource).mockImplementation(async (item: any) => {
      if (item.type === "team") {
        return JSON.stringify({
          slug: "standard-crew",
          agents: [{ templateOrigin: "aoa-curated/standard-crew/librarian", name: "Librarian" }],
        });
      }
      return JSON.stringify({ id: item.id, name: item.name });
    });

    const { db, insertSpy } = makeDb({
      teamRows: [{ id: "team-1", templateOrigin: TEAM_CATALOG_ITEM.id }],
      existingMemberOrigins: [],
      unmanagedAgents: [
        // Renamed by the founder; the boot backfill's slug survives the rename.
        { name: "Archivist", templateOrigin: "aoa-curated/standard-crew/librarian@legacy" },
      ],
    });
    const onFailure = vi.fn();

    const result = await reconcileTeamMembers({
      db: db as any,
      companyId: "co-1",
      catalogItems: [TEAM_CATALOG_ITEM, LIBRARIAN_CATALOG_ITEM],
      instructionsService: { materializeManagedBundle: vi.fn() } as any,
      onFailure,
    });

    expect(createMarketplaceAgent).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "co-1",
        teamId: "team-1",
        templateOrigin: LIBRARIAN_CATALOG_ITEM.id,
        stage: "member_install",
        error: expect.any(Error),
      }),
    );
    expect(result).toEqual({ teamsReconciled: 0, membersAdded: 0 });
  });

  it("reports a roster member missing from the catalog", async () => {
    vi.mocked(fetchCatalogResource).mockResolvedValue(
      JSON.stringify({
        slug: "standard-crew",
        agents: [{ templateOrigin: LIBRARIAN_CATALOG_ITEM.id, name: "Librarian" }],
      }),
    );
    const { db, insertSpy } = makeDb({
      teamRows: [{ id: "team-1", templateOrigin: TEAM_CATALOG_ITEM.id }],
      existingMemberOrigins: [],
    });
    const onFailure = vi.fn();

    const result = await reconcileTeamMembers({
      db: db as any,
      companyId: "co-1",
      catalogItems: [TEAM_CATALOG_ITEM],
      instructionsService: { materializeManagedBundle: vi.fn() } as any,
      onFailure,
    });

    expect(createMarketplaceAgent).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "co-1",
        teamId: "team-1",
        templateOrigin: LIBRARIAN_CATALOG_ITEM.id,
        stage: "member_install",
        error: expect.any(Error),
      }),
    );
    expect(result).toEqual({ teamsReconciled: 0, membersAdded: 0 });
  });

  it("no-ops when the installed team's roster already matches the catalog", async () => {
    vi.mocked(fetchCatalogResource).mockResolvedValue(
      JSON.stringify({
        slug: "standard-crew",
        agents: [{ templateOrigin: "aoa-curated/standard-crew/librarian", name: "Librarian" }],
      }),
    );

    const { db } = makeDb({
      teamRows: [{ id: "team-1", templateOrigin: TEAM_CATALOG_ITEM.id }],
      existingMemberOrigins: ["aoa-curated/standard-crew/librarian"],
    });

    const result = await reconcileTeamMembers({
      db: db as any,
      companyId: "co-1",
      catalogItems: [TEAM_CATALOG_ITEM, LIBRARIAN_CATALOG_ITEM],
      instructionsService: { materializeManagedBundle: vi.fn() } as any,
    });

    expect(createMarketplaceAgent).not.toHaveBeenCalled();
    expect(result).toEqual({ teamsReconciled: 0, membersAdded: 0 });
  });

  it("skips teams with no templateOrigin (not catalog-installed)", async () => {
    const { db } = makeDb({
      teamRows: [{ id: "team-1", templateOrigin: null }],
      existingMemberOrigins: [],
    });

    const result = await reconcileTeamMembers({
      db: db as any,
      companyId: "co-1",
      catalogItems: [TEAM_CATALOG_ITEM, LIBRARIAN_CATALOG_ITEM],
      instructionsService: { materializeManagedBundle: vi.fn() } as any,
    });

    expect(fetchCatalogResource).not.toHaveBeenCalled();
    expect(result).toEqual({ teamsReconciled: 0, membersAdded: 0 });
  });

  it("one missing member's install failure does not block a different missing member", async () => {
    vi.mocked(fetchCatalogResource).mockImplementation(async (item: any) => {
      if (item.type === "team") {
        return JSON.stringify({
          slug: "standard-crew",
          agents: [
            { templateOrigin: "aoa-curated/standard-crew/librarian", name: "Librarian" },
            { templateOrigin: "aoa-curated/standard-crew/chronicler", name: "Chronicler" },
          ],
        });
      }
      return JSON.stringify({ id: item.id, name: item.name });
    });
    vi.mocked(createMarketplaceAgent)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ agentId: "agent-chronicler-1" });

    const { db, insertSpy } = makeDb({
      teamRows: [{ id: "team-1", templateOrigin: TEAM_CATALOG_ITEM.id }],
      existingMemberOrigins: [],
    });

    const result = await reconcileTeamMembers({
      db: db as any,
      companyId: "co-1",
      catalogItems: [
        TEAM_CATALOG_ITEM,
        LIBRARIAN_CATALOG_ITEM,
        { ...LIBRARIAN_CATALOG_ITEM, id: "aoa-curated/standard-crew/chronicler", name: "Chronicler" },
      ],
      instructionsService: { materializeManagedBundle: vi.fn() } as any,
    });

    expect(createMarketplaceAgent).toHaveBeenCalledTimes(2);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ teamsReconciled: 1, membersAdded: 1 });
  });
});
