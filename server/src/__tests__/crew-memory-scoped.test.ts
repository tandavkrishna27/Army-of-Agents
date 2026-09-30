/**
 * crew-memory-scoped — P1-T4 seam test.
 *
 * Drives the exported `loadScopedMemoryLines` seam directly (the RBAC + audit
 * core of the CREW memory pathway) in isolation from the DB-heavy bundle
 * assembly, proving that:
 *   (a) the post-fetch safety net drops rows the actor can't see, and
 *   (b) the SERVED rows are AUDITED — CREW was unaudited before P1-T4 (scenario
 *       O4) — mirroring the ORG heartbeat (one row per served item,
 *       triggeredBy:"auto", shownToAgent:true), and
 *   (c) with no resolved actor the fetch stays unfiltered AND unaudited
 *       (retain today's behavior).
 *
 * memoryService + recordMemoryRetrievals are module-mocked; the real (pure)
 * filterMemoryForActor runs so the cross-department drop is genuine.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted: the mock factories below are hoisted above normal top-level
// consts, so the spy fns they reference must be hoisted too (else TDZ error).
const { searchMultiPath, recordMemoryRetrievals } = vi.hoisted(() => ({
  searchMultiPath: vi.fn(),
  recordMemoryRetrievals: vi.fn(async () => {}),
}));

vi.mock("../services/memory.js", () => ({
  memoryService: () => ({ searchMultiPath }),
}));
vi.mock("../services/memory-retrieval-audit.js", () => ({ recordMemoryRetrievals }));
// Real filterMemoryForActor (pure P0) — not mocked, so the drop is genuine.

import { loadScopedMemoryLines } from "../services/internal-agent/aoa-agents/crew-context-bundle.js";
import type { MemoryActor } from "../services/memory-access.js";

const agentA: MemoryActor = { kind: "agent", agentId: "ag1", departmentIds: ["deptA"] };

function memRow(over: Record<string, unknown>) {
  return {
    id: "m",
    title: "T",
    content: "C",
    layer: "domain",
    visibility: "scoped",
    departmentId: null,
    projectId: null,
    goalId: null,
    taskId: null,
    ownerType: null,
    ownerId: null,
    agentId: null,
    invalidatedAt: null,
    similarity: null,
    ...over,
  };
}

describe("loadScopedMemoryLines", () => {
  beforeEach(() => {
    searchMultiPath.mockReset();
    recordMemoryRetrievals.mockClear();
  });

  it("drops out-of-scope rows and audits the served rows (O4)", async () => {
    searchMultiPath.mockResolvedValueOnce([
      memRow({ id: "in", title: "In scope", departmentId: "deptA" }),
      memRow({ id: "out", title: "Out of scope", departmentId: "deptB" }),
    ]);
    const db = {} as never;
    const lines = await loadScopedMemoryLines(db, "co-1", "query", {}, agentA, [], {
      agentId: "ag1",
      runId: "run-1",
      taskId: "task-1",
    });

    // In-scope row rendered; other department's row dropped by the safety net.
    const rendered = lines.join("\n");
    expect(rendered).toContain("In scope");
    expect(rendered).not.toContain("Out of scope");

    // Audit: served rows recorded once, shownToAgent=true (mirror ORG heartbeat).
    expect(recordMemoryRetrievals).toHaveBeenCalledTimes(1);
    const [auditDb, arg] = recordMemoryRetrievals.mock.calls[0] as [unknown, Record<string, any>];
    expect(auditDb).toBe(db);
    expect(arg.companyId).toBe("co-1");
    expect(arg.agentId).toBe("ag1");
    expect(arg.runId).toBe("run-1");
    expect(arg.taskId).toBe("task-1");
    expect(arg.triggeredBy).toBe("auto");
    expect(arg.query).toBe("query");
    expect(arg.items).toHaveLength(1);
    expect(arg.items[0]).toMatchObject({ id: "in", rank: 1, shownToAgent: true });
  });

  it("does not fetch or audit memory when no actor is resolved", async () => {
    searchMultiPath.mockResolvedValueOnce([
      memRow({ id: "in", title: "In scope", departmentId: "deptA" }),
      memRow({ id: "out", title: "Out of scope", departmentId: "deptB" }),
    ]);
    const lines = await loadScopedMemoryLines({} as never, "co-1", "query", {}, null, [], {});
    // No actor ⇒ unfiltered: both rows rendered.
    expect(lines).toEqual([]);
    expect(searchMultiPath).not.toHaveBeenCalled();
    // No actor ⇒ unaudited.
    expect(recordMemoryRetrievals).not.toHaveBeenCalled();
  });

  it("passes accessConditions into searchMultiPath when present", async () => {
    searchMultiPath.mockResolvedValueOnce([]);
    const cond = { sqlCond: true } as never;
    await loadScopedMemoryLines(
      {} as never,
      "co-1",
      "query",
      { departmentId: "deptA" },
      agentA,
      [cond],
      { agentId: "ag1" },
    );
    expect(searchMultiPath).toHaveBeenCalledWith(
      "co-1",
      "query",
      expect.objectContaining({ limit: 5, departmentId: "deptA", accessConditions: [cond] }),
    );
  });

  it("is a no-op returning [] for an empty query (no search, no audit)", async () => {
    const lines = await loadScopedMemoryLines({} as never, "co-1", "  ", {}, agentA, [], {});
    expect(lines).toEqual([]);
    expect(searchMultiPath).not.toHaveBeenCalled();
    expect(recordMemoryRetrievals).not.toHaveBeenCalled();
  });
});
