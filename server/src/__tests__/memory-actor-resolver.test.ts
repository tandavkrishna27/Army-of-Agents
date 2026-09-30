import { describe, expect, it, vi } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  agentProjects: makeTableProxy("agent_projects"),
  userRoles: makeTableProxy("user_roles"),
}));
vi.mock("drizzle-orm", () => drizzleOperatorStubs());

import { actorForAgentRun, actorForMcp, actorForUser } from "../services/memory-access-sql.js";

type Row = Record<string, unknown>;

/** Sequence-based mock db — each `select()` consumes the next result array. */
function makeMockDb(selects: Row[][]) {
  let i = 0;
  const chain = (rows: () => Row[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy", "limit"]) {
      (c as Record<string, () => unknown>)[m] = () => c;
    }
    (c as { then: (r: (rows: Row[]) => unknown) => Promise<unknown> }).then = (resolve) =>
      Promise.resolve(resolve(rows()));
    return c;
  };
  return { select: () => chain(() => selects[i++] ?? []) } as unknown as Parameters<
    typeof actorForAgentRun
  >[0];
}

describe("actorForAgentRun", () => {
  it("builds an agent actor with departmentIds from agent_projects", async () => {
    const db = makeMockDb([[{ projectId: "deptA" }, { projectId: "deptB" }]]);
    const actor = await actorForAgentRun(db, "co-1", "ag1");
    expect(actor).toEqual({ kind: "agent", agentId: "ag1", departmentIds: ["deptA", "deptB"] });
  });

  it("returns empty departmentIds when the agent is assigned nowhere", async () => {
    const db = makeMockDb([[]]);
    const actor = await actorForAgentRun(db, "co-1", "ag1");
    expect(actor).toEqual({ kind: "agent", agentId: "ag1", departmentIds: [] });
  });
});

describe("actorForUser", () => {
  it("a founder role wins regardless of department rows", async () => {
    const db = makeMockDb([[{ role: "team_lead", projectId: "deptA" }, { role: "founder", projectId: null }]]);
    expect(await actorForUser(db, "co-1", "u1")).toEqual({ kind: "founder" });
  });

  it("a team_lead role yields a scoped team_lead actor", async () => {
    const db = makeMockDb([[{ role: "team_lead", projectId: "deptA" }]]);
    expect(await actorForUser(db, "co-1", "u1")).toEqual({
      kind: "team_lead",
      userId: "u1",
      departmentIds: ["deptA"],
    });
  });

  it("zero roles fails closed to team_member with no departments", async () => {
    const db = makeMockDb([[]]);
    expect(await actorForUser(db, "co-1", "u1")).toEqual({
      kind: "team_member",
      userId: "u1",
      departmentIds: [],
    });
  });
});

describe("actorForMcp", () => {
  it("does not inherit a founder role for an external MCP key, and marks it external", async () => {
    const db = makeMockDb([[{ role: "founder", projectId: null }]]);
    expect(
      await actorForMcp(
        db,
        "co-1",
        { source: "mcp", userId: "founder-owner" },
        { kind: "scoped", userId: "founder-owner", projectIds: new Set() },
      ),
    ).toEqual({ kind: "team_member", userId: "founder-owner", departmentIds: [], external: true });
  });

  it("marks a board team_member as internal (external: false) so it retains company grounding", async () => {
    const db = makeMockDb([]);
    expect(
      await actorForMcp(
        db,
        "co-1",
        { source: "board", userId: "member-1" },
        { kind: "scoped", userId: "member-1", projectIds: new Set(["deptA"]) },
      ),
    ).toEqual({ kind: "team_member", userId: "member-1", departmentIds: ["deptA"], external: false });
  });

  it("preserves founder scope for a board caller", async () => {
    const db = makeMockDb([]);
    expect(
      await actorForMcp(
        db,
        "co-1",
        { source: "board", userId: "board-user" },
        { kind: "founder", userId: "board-user" },
      ),
    ).toEqual({ kind: "founder" });
  });
});
