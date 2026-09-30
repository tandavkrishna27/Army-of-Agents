import { describe, expect, it, vi } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  memoryItems: makeTableProxy("memory_items"),
  agentProjects: makeTableProxy("agent_projects"),
  userRoles: makeTableProxy("user_roles"),
  goals: makeTableProxy("goals"),
  issues: makeTableProxy("issues"),
  projectGoals: makeTableProxy("project_goals"),
}));
vi.mock("drizzle-orm", () => drizzleOperatorStubs());

import { memoryAccessConditions } from "../services/memory-access-sql.js";
import type { MemoryActor } from "../services/memory-access.js";

/**
 * Minimal stub db. The scoped branch of `memoryAccessConditions` builds two
 * subqueries via `db.select({...}).from(...).where(...)`; with the drizzle
 * operator stubs collapsing every helper to a name-string, the subquery is
 * never executed — the chain only has to be callable without throwing.
 */
function makeStubDb() {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "limit"]) {
    (chain as Record<string, () => unknown>)[m] = () => chain;
  }
  return { select: () => chain } as unknown as Parameters<typeof memoryAccessConditions>[0];
}

const ACTORS: Record<string, MemoryActor> = {
  founder: { kind: "founder" },
  team_lead: { kind: "team_lead", userId: "u1", departmentIds: ["deptA"] },
  team_member: { kind: "team_member", userId: "u2", departmentIds: ["deptA", "projB"] },
  commander: { kind: "commander", userId: "u3", departmentIds: ["deptA"] },
  agent: { kind: "agent", agentId: "ag1", departmentIds: ["deptA"] },
};

/**
 * These assertions are STRUCTURAL only. The drizzle operator stubs collapse
 * `isNull`/`and`/`or`/`eq`/`inArray`/... to their name-strings, so we can prove
 * the branch shape (which top-level condition each actor kind emits) but not
 * deep SQL text. Deep row-level correctness — that these conditions admit
 * exactly the rows `canActorSee` admits — is proven by the P1-T7 embedded-pg
 * leakage test against a real Postgres.
 */
describe("memoryAccessConditions", () => {
  it("always leads with isNull(invalidatedAt) for every actor kind", () => {
    const db = makeStubDb();
    for (const actor of Object.values(ACTORS)) {
      const conds = memoryAccessConditions(db, actor);
      expect(conds.length).toBeGreaterThan(0);
      expect(conds[0]).toBe("isNull");
    }
  });

  it("founder → [isNull, and]: all non-private, non-invalidated, no scope subqueries", () => {
    const db = makeStubDb();
    // The founder branch returns early with just the private-exclusion `and`,
    // so `db.select` is never touched.
    const selectSpy = vi.fn(() => {
      throw new Error("founder must not build scope subqueries");
    });
    const founderDb = { select: selectSpy } as unknown as Parameters<
      typeof memoryAccessConditions
    >[0];
    expect(memoryAccessConditions(founderDb, ACTORS.founder)).toEqual(["isNull", "and"]);
    expect(selectSpy).not.toHaveBeenCalled();
    // Same result with the ordinary stub db.
    expect(memoryAccessConditions(db, ACTORS.founder)).toEqual(["isNull", "and"]);
  });

  it("agent with assignments → [isNull, or] (visible-non-private OR own personal memory)", () => {
    const db = makeStubDb();
    expect(memoryAccessConditions(db, ACTORS.agent)).toEqual(["isNull", "or"]);
  });

  it("team_lead with assignments → [isNull, or] (visible-non-private OR own user-owned memory)", () => {
    const db = makeStubDb();
    expect(memoryAccessConditions(db, ACTORS.team_lead)).toEqual(["isNull", "or"]);
  });

  it("team_member and commander are scoped humans → [isNull, or]", () => {
    const db = makeStubDb();
    expect(memoryAccessConditions(db, ACTORS.team_member)).toEqual(["isNull", "or"]);
    expect(memoryAccessConditions(db, ACTORS.commander)).toEqual(["isNull", "or"]);
  });

  it("an unassigned agent (no departments) builds conditions without throwing", () => {
    const db = makeStubDb();
    const unassigned: MemoryActor = { kind: "agent", agentId: "ag2", departmentIds: [] };
    // ids.length === 0 → scopeMatch is `sql\`false\``; no subqueries are built.
    expect(() => memoryAccessConditions(db, unassigned)).not.toThrow();
    expect(memoryAccessConditions(db, unassigned)).toEqual(["isNull", "or"]);
  });

  it("an unassigned human (no departments) builds conditions without throwing", () => {
    const db = makeStubDb();
    const unassigned: MemoryActor = { kind: "team_member", userId: "u9", departmentIds: [] };
    expect(() => memoryAccessConditions(db, unassigned)).not.toThrow();
    expect(memoryAccessConditions(db, unassigned)).toEqual(["isNull", "or"]);
  });

  it("emits exactly two AND-ed conditions for every actor kind", () => {
    const db = makeStubDb();
    for (const actor of Object.values(ACTORS)) {
      expect(memoryAccessConditions(db, actor)).toHaveLength(2);
    }
  });
});
