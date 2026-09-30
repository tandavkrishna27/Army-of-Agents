/**
 * CLI-002/D2 — the actor-gated, pre-staged memory bundle.
 *
 * The RBAC gate (`memoryAccessConditions`) + the post-fetch safety net
 * (`filterMemoryForActor` = `canActorSee`) enforce Decisions #118/#119. This suite
 * mocks the DB + the actor resolver but uses the REAL `filterMemoryForActor`, so the
 * #118/#119 TIERS are genuinely exercised against a crafted row set: identity→agents,
 * company-visibility, ambient fully-unscoped, scope-matched domain, agent's own
 * private; and EXCLUDES invalidated + others' private + out-of-scope. It also proves
 * the fail-closed contract: no actor ⇒ ZERO memory (the resolver is never even
 * queried when there is no agentId).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── drizzle-orm mock (no-op operators) ────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  isNull: vi.fn((a: unknown) => ({ isNull: a })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  gt: vi.fn((a: unknown, b: unknown) => ({ gt: [a, b] })),
  desc: vi.fn((a: unknown) => ({ desc: a })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
  notInArray: vi.fn((a: unknown, b: unknown) => ({ notInArray: [a, b] })),
  sql: Object.assign(vi.fn(() => ({ sql: true })), { raw: vi.fn() }),
}));

// ── @armyofagents/db mock (memoryItems proxy) ─────────────────────────────────
function tableProxy(name: string) {
  return new Proxy({}, { get(_t, prop) { return `${name}.${String(prop)}`; } });
}
vi.mock("@armyofagents/db", () => ({
  memoryItems: tableProxy("memoryItems"),
}));

// ── actor resolver mock (memory-access-sql). filterMemoryForActor stays REAL. ──
const { mockActorForAgentRun } = vi.hoisted(() => ({ mockActorForAgentRun: vi.fn() }));
// memoryAccessConditions returns a SENTINEL (not []) so the test can assert the RBAC
// SQL gate is actually spread into the WHERE — dropping the spread would fail the
// query-shape assertion below.
const RBAC_SENTINEL = { sentinel: "rbac-access-conditions" };
vi.mock("../services/memory-access-sql.js", () => ({
  actorForAgentRun: mockActorForAgentRun,
  memoryAccessConditions: vi.fn(() => [RBAC_SENTINEL]),
}));

import { buildActorGatedMemoryBundle } from "../services/sandbox-coding-memory-bundle.js";

// A DB whose select().from().where().orderBy().limit() resolves to a fixed row set,
// CAPTURING the WHERE argument so the SQL gate's shape (status='approved' + expiry +
// the RBAC conditions) can be asserted — a mock cannot execute the predicate, so the
// query SHAPE is the unit-level proof of the SQL gate (Postgres enforces the filter).
function makeSelectDb(rows: Array<Record<string, unknown>>) {
  const captured: { where?: unknown } = {};
  const chain: any = {};
  chain.from = () => chain;
  chain.where = (arg: unknown) => { captured.where = arg; return chain; };
  chain.orderBy = () => chain;
  chain.limit = () => Promise.resolve(rows);
  return { select: vi.fn(() => chain), captured };
}

/** Recursively flatten the mocked drizzle predicate tree to a JSON string for substring
 *  assertions (the drizzle-orm mock encodes eq/or/isNull as plain nested objects). */
function whereJson(captured: { where?: unknown }): string {
  return JSON.stringify(captured.where ?? null);
}

const AGENT_ACTOR = { kind: "agent", agentId: "crew-1", departmentIds: ["dept-1"] };

// A row set spanning every #118/#119 tier the agent actor must / must-not see.
const ROWS = [
  { id: "identity", title: "Vision", content: "Be the best", layer: "identity", visibility: "private", departmentId: null, projectId: null, goalId: null, taskId: null, ownerType: null, ownerId: null, agentId: null, invalidatedAt: null },
  { id: "company", title: "Company norm", content: "We ship weekly", layer: "domain", visibility: "company", departmentId: null, projectId: null, goalId: null, taskId: null, ownerType: null, ownerId: null, agentId: null, invalidatedAt: null },
  { id: "ambient", title: "Ambient", content: "Discussion-extracted fact", layer: "working", visibility: "private", departmentId: null, projectId: null, goalId: null, taskId: null, ownerType: null, ownerId: null, agentId: null, invalidatedAt: null },
  { id: "scoped", title: "Dept how-to", content: "How we do X in dept-1", layer: "domain", visibility: "private", departmentId: "dept-1", projectId: null, goalId: null, taskId: null, ownerType: null, ownerId: null, agentId: null, invalidatedAt: null },
  { id: "own-private", title: "My scratch", content: "agent-personal", layer: "working", visibility: "private", departmentId: null, projectId: null, goalId: null, taskId: null, ownerType: "agent", ownerId: null, agentId: "crew-1", invalidatedAt: null },
  // EXCLUDED:
  { id: "invalidated", title: "Retracted", content: "should be hidden", layer: "domain", visibility: "company", departmentId: null, projectId: null, goalId: null, taskId: null, ownerType: null, ownerId: null, agentId: null, invalidatedAt: new Date("2026-01-01") },
  { id: "other-private", title: "Not mine", content: "another agent's private", layer: "working", visibility: "private", departmentId: null, projectId: null, goalId: null, taskId: null, ownerType: "agent", ownerId: null, agentId: "other-agent", invalidatedAt: null },
  { id: "out-of-scope", title: "Other dept", content: "dept-9 only", layer: "domain", visibility: "private", departmentId: "dept-9", projectId: null, goalId: null, taskId: null, ownerType: null, ownerId: null, agentId: null, invalidatedAt: null },
];

describe("CLI-002/D2 — actor-gated memory bundle (#118/#119 tiers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActorForAgentRun.mockResolvedValue(AGENT_ACTOR);
  });

  it("serves exactly the #118/#119-visible tiers for an agent actor", async () => {
    const db = makeSelectDb(ROWS);
    const bundle = await buildActorGatedMemoryBundle(db as any, { companyId: "co-1", agentId: "crew-1" });

    expect(bundle.actorResolved).toBe(true);
    expect(bundle.actorKind).toBe("agent");
    // identity, company, ambient-unscoped, scope-matched, own-private → served.
    expect(bundle.itemCount).toBe(5);
    const joined = bundle.lines.join("\n");
    expect(joined).toContain("Vision");            // identity → agents
    expect(joined).toContain("Company norm");      // visibility=company
    expect(joined).toContain("Ambient");           // fully-unscoped ambient
    expect(joined).toContain("Dept how-to");       // scope-matched domain
    expect(joined).toContain("My scratch");        // agent's own private
    // EXCLUDED tiers:
    expect(joined).not.toContain("Retracted");        // invalidated
    expect(joined).not.toContain("another agent");    // others' private
    expect(joined).not.toContain("dept-9 only");      // out-of-scope
  });

  it("the SQL gate carries the founder-approval + expiry + RBAC conditions (never stages pending/rejected/expired)", async () => {
    const db = makeSelectDb(ROWS);
    await buildActorGatedMemoryBundle(db as any, { companyId: "co-1", agentId: "crew-1" });
    const w = whereJson(db.captured);
    // status='approved' — the founder approval gate (Rule #6 / Decision #15): a
    // pending/rejected row can never clear this predicate, so it is never staged.
    expect(w).toContain('"eq":["memoryItems.status","approved"]');
    // A-M5 expiry guard: expired active_context is excluded (DB clock via now()).
    expect(w).toContain('"isNull":"memoryItems.expiresAt"');
    expect(w).toContain('"gt":["memoryItems.expiresAt"');
    // The RBAC access conditions (memoryAccessConditions) are spread into the WHERE.
    expect(w).toContain("rbac-access-conditions");
    // company scoping is present.
    expect(w).toContain('"eq":["memoryItems.companyId","co-1"]');
  });

  it("narrows by department/project/goal scope (= scope OR IS NULL) when filters are supplied", async () => {
    const db = makeSelectDb(ROWS);
    await buildActorGatedMemoryBundle(db as any, {
      companyId: "co-1",
      agentId: "crew-1",
      filters: { departmentId: "dept-1", projectId: "proj-1", goalId: "goal-1" },
    });
    const w = whereJson(db.captured);
    expect(w).toContain('"eq":["memoryItems.departmentId","dept-1"]');
    expect(w).toContain('"eq":["memoryItems.projectId","proj-1"]');
    expect(w).toContain('"eq":["memoryItems.goalId","goal-1"]');
    // each is an OR with IS NULL so a null-scoped ambient/company row is never dropped.
    expect(w).toContain('"isNull":"memoryItems.departmentId"');
  });

  it("fails closed to ZERO memory when no actor resolves (no agentId)", async () => {
    const db = makeSelectDb(ROWS);
    const bundle = await buildActorGatedMemoryBundle(db as any, { companyId: "co-1", agentId: "" });
    expect(bundle.actorResolved).toBe(false);
    expect(bundle.itemCount).toBe(0);
    expect(bundle.lines).toEqual([]);
    // The resolver + the DB are never even queried without an agent.
    expect(mockActorForAgentRun).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("fails closed to ZERO memory when the actor resolver throws", async () => {
    mockActorForAgentRun.mockRejectedValue(new Error("agent_projects lookup failed"));
    const db = makeSelectDb(ROWS);
    const bundle = await buildActorGatedMemoryBundle(db as any, { companyId: "co-1", agentId: "crew-1" });
    expect(bundle.actorResolved).toBe(false);
    expect(bundle.itemCount).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });
});
