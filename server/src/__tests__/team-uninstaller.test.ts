import { describe, it, expect, vi } from "vitest";

// Each table is DISTINGUISHABLE (`__table`) rather than one shared proxy, so the
// mock below can dispatch on which table a query reads. A positional/shared mock
// answers the wrong query with the right fixture — the exact failure that let a
// guard silently never execute in team-reconcile.test.ts (T2.3b F6).
vi.mock("@armyofagents/db", () => {
  const table = (name: string) =>
    new Proxy({}, { get: (_t, prop) => (prop === "__table" ? name : Symbol("col")) });
  return {
    teams: table("teams"),
    teamMembers: table("team_members"),
    agents: table("agents"),
    aoaAgentTriggers: table("aoa_agent_triggers"),
    marketplaceInstallOperations: table("marketplace_install_operations"),
  };
});
// Operators build INSPECTABLE nodes rather than opaque symbols, so a test can
// read back exactly which agent ids each DELETE was scoped to. Without this the
// mock would have to decide what a delete returns, and "the protected agent
// survived" would be an artefact of the fixture rather than of the code.
vi.mock("drizzle-orm", () => ({
  eq: () => ({ __op: "eq" }),
  and: (...args: unknown[]) => ({ __op: "and", args }),
  inArray: (_col: unknown, ids: string[]) => ({ __op: "inArray", ids }),
}));
vi.mock("../../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { uninstallTeam } from "../services/marketplace-install/team-uninstaller.js";

/** Pull the id list out of whatever `where(...)` predicate tree it appears in. */
function idsIn(pred: unknown): string[] | null {
  const node = pred as { __op?: string; ids?: string[]; args?: unknown[] };
  if (!node || typeof node !== "object") return null;
  if (node.__op === "inArray") return node.ids ?? [];
  if (node.__op === "and") {
    for (const arg of node.args ?? []) {
      const found = idsIn(arg);
      if (found) return found;
    }
  }
  return null;
}

// ── helpers ────────────────────────────────────────────────────────────────

interface MemberRow {
  agentId: string;
  name: string;
  templateOrigin: string | null;
}

/**
 * Build a mock DB for uninstallTeam tests, dispatching on the table each
 * `select().from(...)` reads rather than on call order:
 *   - `teams`        → `[teamRow]` (or `[]`), awaited through `.limit(1)`
 *   - `team_members` → `memberRows`, awaited through `.where()` after an
 *                      `innerJoin` onto `agents`
 */
function makeDb(teamRow: Record<string, unknown> | null, memberRows: MemberRow[]) {
  /** Every DELETE the code issued: which table, and which ids it scoped to. */
  const deletes: { table: string; ids: string[] | null }[] = [];

  const mockDelete = vi.fn().mockImplementation((table: { __table?: string }) => ({
    where: vi.fn().mockImplementation((pred: unknown) => {
      const ids = idsIn(pred);
      deletes.push({ table: table?.__table ?? "?", ids });
      // `returning()` echoes back exactly what the code ASKED to delete, so a
      // retained agent can only be absent because the code excluded it.
      return { returning: vi.fn().mockResolvedValue((ids ?? []).map((id) => ({ id }))) };
    }),
  }));
  const mockInsert = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: "op-1" }]),
    }),
  });

  const fromDispatch = (table: { __table?: string }) => {
    if (table?.__table === "teams") {
      return {
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(teamRow ? [teamRow] : []),
        }),
      };
    }
    if (table?.__table === "team_members") {
      return {
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(memberRows),
        }),
        where: vi.fn().mockResolvedValue(memberRows),
      };
    }
    throw new Error(`unexpected select().from(${table?.__table ?? "?"})`);
  };

  const db: any = {
    select: vi.fn().mockReturnValue({ from: vi.fn().mockImplementation(fromDispatch) }),
    delete: mockDelete,
    insert: mockInsert,
    transaction: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        delete: mockDelete,
        insert: mockInsert,
        select: db.select,
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };
      return fn(tx);
    }),
  };

  return { db, mockDelete, mockInsert, deletes };
}

const member = (
  agentId: string,
  name: string,
  templateOrigin: string | null = null,
): MemberRow => ({ agentId, name, templateOrigin });

const SCOUT = member("a-scout", "Scout", "agent:aoa-curated/aoa-scout");
const ENGINEER = member("a-eng", "Engineer", "agent:aoa-curated/aoa-engineer");

// ── tests ──────────────────────────────────────────────────────────────────

describe("uninstallTeam", () => {
  it("throws 'Team not found' when team row does not exist", async () => {
    const { db } = makeDb(null, []);
    await expect(
      uninstallTeam({ db, companyId: "co-1", teamId: "t-missing" }),
    ).rejects.toThrow(/Team not found/);
  });

  it("deletes triggers, agents, and team row in a transaction (3 DELETE calls)", async () => {
    const teamRow = {
      id: "t-1",
      companyId: "co-1",
      templateOrigin: "aoa-curated/standard-crew",
    };
    const { db, mockDelete } = makeDb(teamRow, [SCOUT, ENGINEER]);

    await uninstallTeam({ db, companyId: "co-1", teamId: "t-1" });

    // 1 delete for triggers, 1 for agents, 1 for team
    expect(mockDelete).toHaveBeenCalledTimes(3);
  });

  it("returns the deleted agent IDs", async () => {
    const teamRow = { id: "t-2", companyId: "co-1", templateOrigin: "aoa-curated/crew" };
    const { db } = makeDb(teamRow, [SCOUT, ENGINEER]);

    const result = await uninstallTeam({ db, companyId: "co-1", teamId: "t-2" });

    expect(result.deletedAgentIds).toEqual(["a-scout", "a-eng"]);
  });

  it("skips trigger/agent deletes when team has no members (empty crew)", async () => {
    const teamRow = { id: "t-3", companyId: "co-1", templateOrigin: "aoa-curated/crew" };
    const { db, mockDelete } = makeDb(teamRow, []);

    await uninstallTeam({ db, companyId: "co-1", teamId: "t-3" });

    // Only team row deleted (no triggers or agents)
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it("logs the operation to marketplace_install_operations", async () => {
    const teamRow = { id: "t-4", companyId: "co-1", templateOrigin: "aoa-curated/crew" };
    const { db, mockInsert } = makeDb(teamRow, [SCOUT]);

    await uninstallTeam({ db, companyId: "co-1", teamId: "t-4" });

    // At least one INSERT call (the operation log)
    expect(mockInsert).toHaveBeenCalled();
    const insertValues = mockInsert.mock.results[0]?.value?.values?.mock?.calls?.[0]?.[0];
    expect(insertValues?.operationType ?? insertValues?.itemType).toBeDefined();
  });
});

// ── T2.5 (D23): protected agents are DETACHED, not destroyed ───────────────
//
// Team uninstall deletes member agents with raw SQL, so it bypasses
// `DELETE /agents/:id` entirely — a per-agent route guard cannot see it.
//
// Refusing the whole uninstall (the first implementation) was a dead end: the
// crew team is created company-wide, and `loadTeamForRosterEdit` refuses BOTH
// addMember and removeMember when `parentProjectId` is null, so the founder
// could neither detach the agent nor remove the team.

const TEAM = (id: string) => ({
  id,
  companyId: "co-1",
  templateOrigin: "team:aoa-curated/default-crew",
});

describe("uninstallTeam — protected agents (D23)", () => {
  it("keeps Steward (NULL templateOrigin) alive and deletes the rest", async () => {
    const { db } = makeDb(TEAM("t-5"), [SCOUT, member("a-steward", "Steward", null)]);

    const result = await uninstallTeam({ db, companyId: "co-1", teamId: "t-5" });

    expect(result.deletedAgentIds).toEqual(["a-scout"]);
    expect(result.retainedAgents.map((a) => a.id)).toEqual(["a-steward"]);
    expect(result.retainedAgents[0]?.role).toBe("steward");
    expect(result.retainedAgents[0]?.why).toMatch(/Inbox Hub/);
  });

  // F3's harm, at this layer: a surviving row with no triggers is a dead agent.
  // `sweep-steward.ts` selects on kind='sweep' + enabled, and `seedCrewAgent`
  // only seeds triggers for a NEWLY inserted row, so the wipe is permanent.
  it("excludes retained agents from the TRIGGER delete, not just the agent delete", async () => {
    const { db, deletes } = makeDb(TEAM("t-5b"), [
      SCOUT,
      member("a-steward", "Steward", null),
    ]);

    await uninstallTeam({ db, companyId: "co-1", teamId: "t-5b" });

    const triggerDelete = deletes.find((d) => d.table === "aoa_agent_triggers");
    expect(triggerDelete?.ids).toEqual(["a-scout"]);
    const agentDelete = deletes.find((d) => d.table === "agents");
    expect(agentDelete?.ids).toEqual(["a-scout"]);
  });

  it("still deletes the team row, which detaches the retained agent", async () => {
    const { db, deletes } = makeDb(TEAM("t-6"), [member("a-steward", "Steward", null)]);

    const result = await uninstallTeam({ db, companyId: "co-1", teamId: "t-6" });

    expect(deletes.some((d) => d.table === "teams")).toBe(true);
    // Nothing to destroy, so neither agent-scoped delete should have run at all.
    expect(deletes.map((d) => d.table)).toEqual(["teams"]);
    expect(result.deletedAgentIds).toEqual([]);
    expect(result.retainedAgents.map((a) => a.name)).toEqual(["Steward"]);
  });

  it("reports every protected agent it kept, with its reason", async () => {
    const { db } = makeDb(TEAM("t-7"), [
      SCOUT,
      member("a-cmd", "Commander", "aoa-curated/standard-crew/commander@legacy"),
      member("a-steward", "Steward", null),
    ]);

    const result = await uninstallTeam({ db, companyId: "co-1", teamId: "t-7" });

    expect(result.retainedAgents.map((a) => a.name)).toEqual(["Commander", "Steward"]);
    expect(result.retainedAgents.map((a) => a.role)).toEqual(["commander", "steward"]);
    for (const agent of result.retainedAgents) expect(agent.why.length).toBeGreaterThan(0);
    expect(result.deletedAgentIds).toEqual(["a-scout"]);
  });

  it("retains a RENAMED Commander (matched on its origin slug, not its name)", async () => {
    const { db } = makeDb(TEAM("t-8"), [
      SCOUT,
      member("a-cmd", "Ops Lead", "aoa-curated/standard-crew/commander@legacy"),
    ]);

    const result = await uninstallTeam({ db, companyId: "co-1", teamId: "t-8" });

    expect(result.retainedAgents.map((a) => a.id)).toEqual(["a-cmd"]);
    expect(result.deletedAgentIds).toEqual(["a-scout"]);
  });

  // THE DISCRIMINATOR. A blanket guard — "retain every kind='aoa' member", or
  // "retain the whole crew team" — passes every test above and fails this one.
  it("still destroys a team of unprotected crew agents, every one of them", async () => {
    const { db, deletes } = makeDb(TEAM("t-9"), [
      SCOUT,
      ENGINEER,
      // Chronicler shares Steward's NULL origin exactly; only identity separates them.
      member("a-chron", "Chronicler", null),
    ]);

    const result = await uninstallTeam({ db, companyId: "co-1", teamId: "t-9" });

    expect(result.deletedAgentIds).toEqual(["a-scout", "a-eng", "a-chron"]);
    expect(result.retainedAgents).toEqual([]);
    expect(deletes.find((d) => d.table === "aoa_agent_triggers")?.ids).toEqual([
      "a-scout",
      "a-eng",
      "a-chron",
    ]);
  });

  // F5: the docblock claims the partition happens BEFORE any write. Assert the
  // invariant directly rather than its consequence — "no protected agent was
  // deleted" would also hold for an implementation that opened a transaction,
  // discovered the problem inside it, and rolled back.
  it("has already read both rows, and issued no DELETE, when the transaction opens", async () => {
    const { db, deletes } = makeDb(TEAM("t-10"), [SCOUT, member("a-steward", "Steward", null)]);
    const realTransaction = db.transaction;
    let stateAtTxOpen: { selects: number; deletes: number } | null = null;
    db.transaction = vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      stateAtTxOpen = { selects: db.select.mock.calls.length, deletes: deletes.length };
      return realTransaction(fn);
    });

    await uninstallTeam({ db, companyId: "co-1", teamId: "t-10" });

    // Team row + joined member rows are both read; nothing is written yet.
    expect(stateAtTxOpen).toEqual({ selects: 2, deletes: 0 });
  });
});
