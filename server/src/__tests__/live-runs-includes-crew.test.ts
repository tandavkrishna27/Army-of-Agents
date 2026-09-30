// server/src/__tests__/live-runs-includes-crew.test.ts
//
// Thread chat experience Phase 5 — Task 5.5 (kanban "Live" pill sees crew).
//
// liveRunsForCompany / liveRunsForIssue used to query heartbeat_runs ONLY, so a
// CREW (internal_agent) run executing a task never lit the board. These tests
// assert the UNION: a `running` internal_agent_runs row with
// related_entity_type='task' now appears (with { issueId, agentId, agentName }),
// a `completed` crew run does NOT, and the existing heartbeat rows still appear.
//
// The db is mocked + DISCRIMINATED BY THE `.from()` TABLE so the two parallel
// selects (heartbeat + crew) each get their own result set. drizzle-orm ops are
// stubbed (the helper builds query objects but never executes real SQL).

import { describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  inArray: (c: unknown, v: unknown) => ({ inArray: [c, v] }),
  not: (c: unknown) => ({ not: c }),
  desc: (c: unknown) => ({ desc: c }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...vals: unknown[]) => ({ sql: strings.join("?"), vals }),
    { raw: (s: unknown) => s },
  ),
}));

// Each table is a tagged symbol so the db mock can tell which query is running.
vi.mock("@armyofagents/db", () => {
  const tag = (name: string) => {
    const t: any = new Proxy(
      {},
      { get: (_x, p) => (p === "__table" ? name : typeof p === "string" ? `${name}.${String(p)}` : undefined) },
    );
    return t;
  };
  return {
    agents: tag("agents"),
    heartbeatRuns: tag("heartbeat_runs"),
    internalAgentRuns: tag("internal_agent_runs"),
  };
});

import { liveRunsForCompany, liveRunsForIssue, crewLiveRunsForCompany } from "../routes/agents-live-runs.js";

// A select() chain that resolves to `rows`. Captures the `.from()` table tag so
// makeDb can route the right rows to the right query.
function makeDb(byTable: Record<string, unknown[]>) {
  const db: any = {
    select: (_cols: unknown) => {
      let table = "";
      const chain: any = {};
      chain.from = (t: any) => {
        table = t?.__table ?? "";
        return chain;
      };
      chain.innerJoin = () => chain;
      chain.leftJoin = () => chain;
      chain.where = () => chain;
      chain.orderBy = () => chain;
      chain.limit = () => chain;
      chain.then = (resolve: (v: unknown[]) => unknown) =>
        Promise.resolve(byTable[table] ?? []).then(resolve);
      return chain;
    },
  };
  return db;
}

const COMPANY = "co-1";
const ISSUE = "issue-1";

describe("Task 5.5 — liveRuns UNION includes crew (internal_agent) runs", () => {
  it("crewLiveRunsForCompany surfaces { issueId, agentId, agentName, startedAt } for a running task run", async () => {
    const db = makeDb({
      internal_agent_runs: [
        { id: "iar-1", status: "running", agentId: "agent-9", agentName: "Engineer", issueId: ISSUE, startedAt: new Date("2026-06-02T10:00:00Z"), createdAt: new Date("2026-06-02T10:00:00Z") },
      ],
    });

    const crew = await crewLiveRunsForCompany(db, COMPANY);

    expect(crew).toHaveLength(1);
    expect(crew[0]).toMatchObject({
      issueId: ISSUE,
      agentId: "agent-9",
      agentName: "Engineer",
      source: "internal_agent",
    });
    // R5: createdAt is the elapsed anchor, surfaced as startedAt.
    expect(crew[0].startedAt).toEqual(crew[0].createdAt);
  });

  it("liveRunsForCompany merges heartbeat rows AND crew rows", async () => {
    const db = makeDb({
      heartbeat_runs: [
        { id: "hb-1", status: "running", agentId: "agent-1", agentName: "Heartbeat Bot", adapterType: "claude_local", issueId: "issue-hb" },
      ],
      internal_agent_runs: [
        { id: "iar-1", status: "running", agentId: "agent-9", agentName: "Engineer", issueId: ISSUE, startedAt: new Date(), createdAt: new Date() },
      ],
    });

    const rows = (await liveRunsForCompany(db, COMPANY)) as Array<Record<string, unknown>>;

    // Heartbeat row still present.
    expect(rows.some((r) => r.id === "hb-1")).toBe(true);
    // Crew row now present too — with the crew shape.
    const crewRow = rows.find((r) => r.id === "iar-1");
    expect(crewRow).toBeDefined();
    expect(crewRow).toMatchObject({ issueId: ISSUE, agentId: "agent-9", agentName: "Engineer", source: "internal_agent" });
  });

  it("a COMPLETED crew run does NOT appear (the WHERE filters status='running')", async () => {
    // The helper's WHERE pins status='running'; a completed row would never be
    // returned by the real query. We model that by returning [] for the crew
    // table (the DB applied the filter), and assert only the heartbeat row shows.
    const db = makeDb({
      heartbeat_runs: [
        { id: "hb-1", status: "running", agentId: "agent-1", agentName: "Heartbeat Bot", adapterType: "claude_local", issueId: "issue-hb" },
      ],
      internal_agent_runs: [], // completed run filtered out by status='running'
    });

    const rows = (await liveRunsForCompany(db, COMPANY)) as Array<Record<string, unknown>>;

    expect(rows.some((r) => r.id === "hb-1")).toBe(true);
    expect(rows.every((r) => r.source !== "internal_agent")).toBe(true);
  });

  it("liveRunsForIssue merges heartbeat + crew rows scoped to the issue", async () => {
    const db = makeDb({
      heartbeat_runs: [
        { id: "hb-2", status: "running", agentId: "agent-1", agentName: "Heartbeat Bot", adapterType: "claude_local" },
      ],
      internal_agent_runs: [
        { id: "iar-2", status: "running", agentId: "agent-9", agentName: "Engineer", issueId: ISSUE, startedAt: new Date(), createdAt: new Date() },
      ],
    });

    const rows = (await liveRunsForIssue(db, COMPANY, ISSUE)) as Array<Record<string, unknown>>;

    expect(rows.some((r) => r.id === "hb-2")).toBe(true);
    const crewRow = rows.find((r) => r.id === "iar-2");
    expect(crewRow).toMatchObject({ issueId: ISSUE, agentId: "agent-9", agentName: "Engineer" });
  });

  it("with no crew runs, liveRunsForCompany returns just the heartbeat rows (back-compat)", async () => {
    const db = makeDb({
      heartbeat_runs: [
        { id: "hb-1", status: "queued", agentId: "agent-1", agentName: "Heartbeat Bot", adapterType: "claude_local", issueId: "issue-hb" },
      ],
      internal_agent_runs: [],
    });

    const rows = (await liveRunsForCompany(db, COMPANY)) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("hb-1");
  });
});
