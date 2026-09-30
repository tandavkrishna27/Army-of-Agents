import { describe, expect, it } from "vitest";
import {
  filterMemoryForActor,
  type AccessibleMemoryRow,
  type MemoryActor,
} from "../services/memory-access.js";

function row(overrides: Partial<AccessibleMemoryRow> = {}): AccessibleMemoryRow {
  return {
    layer: "domain",
    visibility: "scoped",
    departmentId: "deptA",
    projectId: null,
    ownerType: null,
    ownerId: null,
    agentId: null,
    invalidatedAt: null,
    ...overrides,
  };
}

const founder: MemoryActor = { kind: "founder" };
const agentA: MemoryActor = { kind: "agent", agentId: "ag1", departmentIds: ["deptA"] };
const agentB: MemoryActor = { kind: "agent", agentId: "ag2", departmentIds: ["deptB"] };
const leadA: MemoryActor = { kind: "team_lead", userId: "u1", departmentIds: ["deptA"] };
const memberA: MemoryActor = { kind: "team_member", userId: "u2", departmentIds: ["deptA"] };
// External MCP key: same team_member kind, but marked external → not an internal member.
const externalKey: MemoryActor = { kind: "team_member", userId: "ext", departmentIds: [], external: true };

describe("filterMemoryForActor", () => {
  it("founder sees all non-private, any department", () => {
    const items = [row({ departmentId: "deptA" }), row({ departmentId: "deptB" })];
    expect(filterMemoryForActor(items, founder)).toHaveLength(2);
  });

  it("agent sees own-department scoped memory but not another department's", () => {
    const items = [row({ departmentId: "deptA" }), row({ departmentId: "deptB" })];
    const seen = filterMemoryForActor(items, agentA);
    expect(seen).toHaveLength(1);
    expect(seen[0].departmentId).toBe("deptA");
  });

  it("identity memory: agents + team-lead+ see it; team_member humans and external MCP keys do NOT", () => {
    const items = [row({ layer: "identity", departmentId: null, visibility: "scoped" })];
    // agents (grounding) + founder + team_lead
    expect(filterMemoryForActor(items, agentB)).toHaveLength(1);
    expect(filterMemoryForActor(items, founder)).toHaveLength(1);
    expect(filterMemoryForActor(items, leadA)).toHaveLength(1);
    // NOT a team_member human, NOT an external MCP key
    expect(filterMemoryForActor(items, memberA)).toHaveLength(0);
    expect(filterMemoryForActor(items, externalKey)).toHaveLength(0);
  });

  it("company-visibility memory: every internal member sees it (incl. team_member); external MCP keys do NOT", () => {
    const items = [row({ visibility: "company", departmentId: "deptB" })];
    expect(filterMemoryForActor(items, agentA)).toHaveLength(1);
    expect(filterMemoryForActor(items, founder)).toHaveLength(1);
    expect(filterMemoryForActor(items, leadA)).toHaveLength(1);
    expect(filterMemoryForActor(items, memberA)).toHaveLength(1); // internal member
    expect(filterMemoryForActor(items, externalKey)).toHaveLength(0); // external key excluded
  });

  it("fully-unscoped non-private memory is ambient company-level — members + agents see it, external keys don't; identity is NOT re-exposed", () => {
    // No dept/project/goal/task at all (discussion-extracted memory is created this way).
    const unscoped = row({ layer: "domain", visibility: "scoped", departmentId: null, projectId: null });
    expect(filterMemoryForActor([unscoped], agentB)).toHaveLength(1); // agent (any dept) sees it
    expect(filterMemoryForActor([unscoped], memberA)).toHaveLength(1); // team_member sees it
    expect(filterMemoryForActor([unscoped], founder)).toHaveLength(1); // founder sees it
    expect(filterMemoryForActor([unscoped], externalKey)).toHaveLength(0); // external key excluded
    // Guard (Decision #118 stands): an identity row is ALSO fully-unscoped, but must
    // NOT reach a team_member via the unscoped path.
    const identity = row({ layer: "identity", visibility: "scoped", departmentId: null, projectId: null });
    expect(filterMemoryForActor([identity], memberA)).toHaveLength(0);
  });

  it("agent-private memory is visible only to the owning agent", () => {
    const items = [row({ ownerType: "agent", ownerId: "ag1", agentId: "ag1", departmentId: null })];
    expect(filterMemoryForActor(items, agentA)).toHaveLength(1);
    expect(filterMemoryForActor(items, agentB)).toHaveLength(0);
    expect(filterMemoryForActor(items, founder)).toHaveLength(0); // hidden in normal path
  });

  it("user-private memory is visible only to the owning user", () => {
    const items = [row({ ownerType: "user", ownerId: "u1", departmentId: null })];
    expect(filterMemoryForActor(items, leadA)).toHaveLength(1);
    expect(filterMemoryForActor(items, agentA)).toHaveLength(0);
    expect(filterMemoryForActor(items, founder)).toHaveLength(0);
  });

  it("invalidated memory is hidden from everyone", () => {
    const items = [row({ invalidatedAt: new Date("2026-01-01"), visibility: "company" })];
    expect(filterMemoryForActor(items, founder)).toHaveLength(0);
    expect(filterMemoryForActor(items, agentA)).toHaveLength(0);
  });

  it("matches on projectId when the actor's set includes it (project-type scope)", () => {
    const items = [row({ departmentId: null, projectId: "projX" })];
    const agentX: MemoryActor = { kind: "agent", agentId: "agX", departmentIds: ["projX"] };
    expect(filterMemoryForActor(items, agentX)).toHaveLength(1);
    expect(filterMemoryForActor(items, agentB)).toHaveLength(0);
  });

  it("passes goal-/task-only-scoped rows through the safety net (SQL gate is authoritative)", () => {
    const goalRow = row({ departmentId: null, projectId: null, goalId: "g1" });
    const taskRow = row({ departmentId: null, projectId: null, taskId: "t1" });
    expect(filterMemoryForActor([goalRow, taskRow], agentA)).toHaveLength(2);
  });
});
