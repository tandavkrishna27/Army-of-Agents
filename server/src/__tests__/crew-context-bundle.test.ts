/**
 * crew-context-bundle — unit tests (Phase 4 / Tasks 4.1 + 4.2).
 *
 * `buildCrewContextBundle(db, { companyId, threadId?, issueId?, agentId, tokenBudget? })`
 * assembles the dynamic context a crew agent arrives with so it never "starts
 * blind". It produces ONE markdown string with three sub-sections:
 *
 *   - THREAD (threadId set): the Chronicler summary (if any) + routingTerms,
 *     then the last N=20 entries rendered "<author>: <rawContent>".
 *   - TASK   (issueId set): the task title/description/status/priority, plus
 *     the upstream artifact's current-version body (truncated) when linked.
 *   - MEMORY (both): memoryService(db).searchMultiPath(companyId, queryText,
 *     { limit: 5 }) rendered as a list. MUST degrade gracefully — when the
 *     search throws (embeddings/pgvector absent on this instance) OR returns
 *     [], the memory section is simply omitted and the bundle never crashes.
 *
 * Mirrors the project's service-test conventions (Proxy table stubs, no-op
 * drizzle operators, a sequence-based stub db; memoryService module-mocked).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── drizzle-orm mock (no-op operators) ────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  desc: vi.fn((a: unknown) => ({ desc: a })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
}));

// ── @armyofagents/db mock (table proxies) ─────────────────────────────────────
function tableProxy(name: string) {
  return new Proxy({}, { get(_t, prop) { return `${name}.${String(prop)}`; } });
}
vi.mock("@armyofagents/db", () => ({
  discussionEntries: tableProxy("discussionEntries"),
  discussions: tableProxy("discussions"),
  agents: tableProxy("agents"),
  issues: tableProxy("issues"),
  projects: tableProxy("projects"),
  artifacts: tableProxy("artifacts"),
  artifactVersions: tableProxy("artifactVersions"),
  issueContextBundles: tableProxy("issueContextBundles"),
  issueContextBundleItems: tableProxy("issueContextBundleItems"),
}));

// ── Logger mock ───────────────────────────────────────────────────────────────
vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(() => ({
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    })),
  },
}));

// ── memoryService module mock ─────────────────────────────────────────────────
const { mockSearchMultiPath } = vi.hoisted(() => ({ mockSearchMultiPath: vi.fn() }));
vi.mock("../services/memory.js", () => ({
  memoryService: vi.fn(() => ({ searchMultiPath: mockSearchMultiPath })),
}));

// ── memory-access mocks (RBAC actor resolver + post-filter — unit-isolated) ───
// buildCrewContextBundle resolves the crew agent's actor via actorForAgentRun (a
// real agent_projects DB query in prod) and post-filters served rows via
// filterMemoryForActor. This unit test isolates the BUNDLE ASSEMBLY logic; the
// RBAC gate itself is covered by memory-access.test.ts + the real-pg
// memory-rbac-leakage.integration.test.ts crew-bundle case. Give a fixed agent
// actor and a passthrough filter so the memory branch runs deterministically
// without the DB round-trip (otherwise the actor resolves null and the code
// correctly fail-closes before searchMultiPath).
vi.mock("../services/memory-access-sql.js", () => ({
  actorForAgentRun: vi.fn(async () => ({ kind: "agent", agentId: "crew-1", departmentIds: ["dept-1"] })),
  memoryAccessConditions: vi.fn(() => []),
  actorForMcp: vi.fn(),
  actorForUser: vi.fn(),
}));
vi.mock("../services/memory-access.js", () => ({
  filterMemoryForActor: vi.fn((items: unknown[]) => items),
}));

// ── Import AFTER mocks ────────────────────────────────────────────────────────
import { buildCrewContextBundle } from "../services/internal-agent/aoa-agents/crew-context-bundle.js";

// ── Sequence-db helper ────────────────────────────────────────────────────────
// Each terminal await (.then / awaiting the builder) shifts the next queued
// result array. The builder chains .from().where().orderBy().limit() and may
// `await` the chain directly (thenable) — so every chain object is a thenable
// that resolves to the next queued result and also returns itself for the
// intermediate chain methods.
function makeSeqDb(queue: Array<Array<Record<string, unknown>>>) {
  let idx = 0;
  const nextResult = () => {
    const r = queue[idx] ?? [];
    idx += 1;
    return r;
  };
  const makeChain = () => {
    const chain: any = {};
    const ret = () => chain;
    chain.from = ret;
    chain.where = ret;
    chain.orderBy = ret;
    chain.leftJoin = ret;
    chain.innerJoin = ret;
    chain.limit = () => Promise.resolve(nextResult());
    chain.then = (onF: (v: unknown[]) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(nextResult()).then(onF, onR);
    return chain;
  };
  return {
    _consumed: () => idx,
    select: vi.fn(() => makeChain()),
  };
}

// ── WHERE-aware db (for the cross-tenant scoping tests) ───────────────────────
// Unlike makeSeqDb (which ignores the WHERE clause), this stub HONORS the
// company filter so a cross-company read is actually denied — the whole point
// of the fix. The drizzle mock renders `eq(a,b)` → { eq:[a,b] } and
// `and(...c)` → { and:[...] }; we walk that structure to read the requested
// companyId. Tables are identified by the column strings the proxy yields.
function collectEqs(node: unknown, acc: Array<[unknown, unknown]> = []): Array<[unknown, unknown]> {
  if (!node || typeof node !== "object") return acc;
  const n = node as { eq?: unknown[]; and?: unknown[] };
  if (Array.isArray(n.eq)) acc.push([n.eq[0], n.eq[1]]);
  if (Array.isArray(n.and)) for (const c of n.and) collectEqs(c, acc);
  return acc;
}
function requestedValue(where: unknown, column: string): unknown {
  const pair = collectEqs(where).find(([col]) => col === column);
  return pair ? pair[1] : undefined;
}

/**
 * A db that models REAL cross-tenant semantics: the discussion/issue row
 * genuinely EXISTS (owned by `ownerCompanyId`) and is matched by its id. It is
 * returned UNLESS the WHERE clause carries a companyId conjunct scoping it to a
 * DIFFERENT company. Crucially, an UNSCOPED read (id only, no companyId — i.e.
 * the pre-fix vulnerable query) still returns the row — so a regression that
 * drops the companyId conjunct surfaces the foreign row and FAILS the tests.
 * `discussion_entries` (no companyId column) and `agents` reads return their
 * rows whenever the code reaches them — the gate's job is to make them
 * unreachable for a foreign caller in the first place.
 */
function makeTenantScopedDb(opts: {
  ownerCompanyId: string;
  discussionId?: string;
  discussionRow?: Record<string, unknown>;
  entryRows?: Array<Record<string, unknown>>;
  issueId?: string;
  issueRow?: Record<string, unknown>;
  agentRows?: Array<Record<string, unknown>>;
}) {
  const makeChain = () => {
    const state: { table?: string; where?: unknown } = {};
    const chain: any = {};
    chain.from = (t: any) => { state.table = String(t.id).split(".")[0]; return chain; };
    chain.where = (c: unknown) => { state.where = c; return chain; };
    chain.orderBy = () => chain;
    chain.leftJoin = () => chain;
    chain.innerJoin = () => chain;
    const resolve = (): Array<Record<string, unknown>> => {
      if (state.table === "discussions") {
        if (!opts.discussionRow) return [];
        if (requestedValue(state.where, "discussions.id") !== opts.discussionId) return [];
        const reqCompany = requestedValue(state.where, "discussions.companyId");
        // Row exists; only a mismatched companyId conjunct hides it.
        if (reqCompany !== undefined && reqCompany !== opts.ownerCompanyId) return [];
        return [opts.discussionRow];
      }
      if (state.table === "issues") {
        if (!opts.issueRow) return [];
        if (requestedValue(state.where, "issues.id") !== opts.issueId) return [];
        const reqCompany = requestedValue(state.where, "issues.companyId");
        if (reqCompany !== undefined && reqCompany !== opts.ownerCompanyId) return [];
        return [opts.issueRow];
      }
      if (state.table === "discussionEntries") return opts.entryRows ?? [];
      if (state.table === "agents") return opts.agentRows ?? [];
      return [];
    };
    chain.limit = () => Promise.resolve(resolve());
    chain.then = (onF: (v: unknown[]) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onF, onR);
    return chain;
  };
  return { select: vi.fn(() => makeChain()) };
}

describe("buildCrewContextBundle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchMultiPath.mockReset();
    mockSearchMultiPath.mockResolvedValue([]); // default: no memory
  });

  // (a) THREAD branch renders the last entries (author: text) + the summary.
  it("(a) thread branch: renders the Chronicler summary + the last entries as '<author>: <text>'", async () => {
    const db = makeSeqDb([
      // 1) company-scoped thread (discussions) row — read FIRST as the tenant gate
      [{ summaryText: "Thread about enterprise authentication strategy.", routingTerms: ["SSO", "SAML"] }],
      // 2) entries (desc; the builder reverses to chronological)
      [
        { id: "e2", rawContent: "I think we should ship SSO first", authorAgentId: null, createdBy: "user-founder", createdAt: new Date("2026-06-01T10:01:00Z") },
        { id: "e1", rawContent: "We need a precedent for enterprise auth", authorAgentId: "agent-scout", createdBy: "agent", createdAt: new Date("2026-06-01T10:00:00Z") },
      ],
      // 3) agent-name lookup (one entry had authorAgentId)
      [{ id: "agent-scout", name: "Scout" }],
    ]);

    const out = await buildCrewContextBundle(db as any, {
      companyId: "co-1",
      threadId: "thread-1",
      agentId: "agent-eng",
    });

    // Summary present (prepended as a "Thread summary:" line).
    expect(out).toContain("Thread summary:");
    expect(out).toContain("Thread about enterprise authentication strategy.");
    // routingTerms surfaced.
    expect(out).toContain("SSO");
    // Entries rendered chronologically as "<author>: <text>".
    expect(out).toContain("Scout: We need a precedent for enterprise auth");
    // Founder fallback label for an entry with no authorAgentId.
    expect(out).toMatch(/founder: I think we should ship SSO first/i);
    // Scout's (older) line comes before the founder's (newer) line (chronological).
    expect(out.indexOf("Scout: We need a precedent")).toBeLessThan(
      out.indexOf("I think we should ship SSO first"),
    );
  });

  // (b) TASK branch renders title/description + the upstream artifact body.
  it("(b) task branch: renders the task title/description + the upstream artifact body", async () => {
    const db = makeSeqDb([
      // 1) issue row (has artifactId)
      [{ id: "task-9", title: "Build the SSO login form", description: "Implement SAML SSO per the approved spec.", status: "todo", priority: "high", artifactId: "art-1" }],
      // 2) artifact current-version body
      [{ content: "# SSO Spec\nUse SAML 2.0 with the IdP-initiated flow." }],
    ]);

    const out = await buildCrewContextBundle(db as any, {
      companyId: "co-1",
      issueId: "task-9",
      agentId: "agent-eng",
    });

    expect(out).toContain("Build the SSO login form");
    expect(out).toContain("Implement SAML SSO per the approved spec.");
    // Upstream deliverable rendered.
    expect(out).toContain("Upstream deliverable:");
    expect(out).toContain("Use SAML 2.0 with the IdP-initiated flow.");
  });

  it("(b2) task branch: scopes memory search to the task's project and goal", async () => {
    mockSearchMultiPath.mockResolvedValue([]);
    const db = makeSeqDb([
      [{
        id: "task-9",
        title: "Build the SSO login form",
        description: "Implement SAML SSO per the approved spec.",
        status: "todo",
        priority: "high",
        artifactId: null,
        projectId: "project-auth",
        projectType: "project",
        goalId: "goal-enterprise",
      }],
    ]);

    await buildCrewContextBundle(db as any, {
      companyId: "co-1",
      issueId: "task-9",
      agentId: "agent-eng",
    });

    expect(mockSearchMultiPath).toHaveBeenCalledWith(
      "co-1",
      expect.stringContaining("Build the SSO login form"),
      expect.objectContaining({
        limit: 5,
        projectId: "project-auth",
        goalId: "goal-enterprise",
      }),
    );
  });

  it("(b2a) task branch: scopes memory search to departmentId when the task project is a department", async () => {
    mockSearchMultiPath.mockResolvedValue([]);
    const db = makeSeqDb([
      [{
        id: "task-10",
        title: "Use discussion scope memory",
        description: "The task should retrieve approved department memory.",
        status: "todo",
        priority: "high",
        artifactId: null,
        projectId: "dept-software",
        projectType: "department",
        goalId: null,
      }],
    ]);

    await buildCrewContextBundle(db as any, {
      companyId: "co-1",
      issueId: "task-10",
      agentId: "agent-eng",
    });

    expect(mockSearchMultiPath).toHaveBeenCalledWith(
      "co-1",
      expect.stringContaining("Use discussion scope memory"),
      expect.objectContaining({
        limit: 5,
        departmentId: "dept-software",
      }),
    );
    expect(mockSearchMultiPath.mock.calls[0][2]).not.toHaveProperty("projectId");
  });

  it("(b3) task branch: includes discussion-origin scope handoff context", async () => {
    const db = makeSeqDb([
      [{
        id: "task-9",
        title: "Build guided checklist",
        description: "Use the accepted scope evidence.",
        status: "todo",
        priority: "high",
        artifactId: null,
        projectId: "project-onboarding",
        goalId: "goal-activation",
      }],
      [{
        id: "bundle-1",
        sourceKind: "discussion_scope",
        brief: "Use selected scope evidence.",
      }],
      [
        {
          itemType: "discussion_entry",
          label: "Founder requirement",
          metadata: { excerpt: "Need guided checklist" },
        },
        {
          itemType: "artifact",
          label: "Checklist mockup",
          metadata: { artifactType: "design" },
        },
        {
          itemType: "url",
          label: "Reference URL",
          metadata: { url: "https://example.com/ref" },
        },
      ],
    ]);

    const out = await buildCrewContextBundle(db as any, {
      companyId: "co-1",
      issueId: "task-9",
      agentId: "agent-eng",
    });

    expect(out).toContain("Scope handoff:");
    expect(out).toContain("Use selected scope evidence.");
    expect(out).toContain("Founder requirement");
    expect(out).toContain("Need guided checklist");
    expect(out).toContain("Checklist mockup");
    expect(out).toContain("design");
    expect(out).toContain("https://example.com/ref");
  });

  // (c) MEMORY section populated when searchMultiPath returns items.
  it("(c) memory: lists relevant items when searchMultiPath returns results", async () => {
    mockSearchMultiPath.mockResolvedValue([
      { id: "m1", title: "Auth standard", content: "We standardize on SAML for enterprise.", layer: "domain" },
      { id: "m2", title: "Brand voice", content: "Terse, factual.", layer: "identity" },
    ]);
    const db = makeSeqDb([
      // company-scoped thread row (found, no Chronicler summary yet)
      [{ summaryText: null, routingTerms: null }],
      // thread entries
      [{ id: "e1", rawContent: "how do we do auth?", authorAgentId: null, createdBy: "user-1", createdAt: new Date("2026-06-01T10:00:00Z") }],
    ]);

    const out = await buildCrewContextBundle(db as any, {
      companyId: "co-1",
      threadId: "thread-1",
      agentId: "agent-eng",
    });

    expect(mockSearchMultiPath).toHaveBeenCalledTimes(1);
    // queryText derived from the thread (latest entry text or summary).
    const [calledCompanyId, calledQuery, calledOpts] = mockSearchMultiPath.mock.calls[0];
    expect(calledCompanyId).toBe("co-1");
    expect(typeof calledQuery).toBe("string");
    expect(calledQuery.length).toBeGreaterThan(0);
    expect(calledOpts).toMatchObject({ limit: 5 });
    // Items rendered.
    expect(out).toContain("Relevant memory:");
    expect(out).toContain("Auth standard");
    expect(out).toContain("We standardize on SAML for enterprise.");
  });

  // (d) MEMORY degrades to empty (no crash) when searchMultiPath throws OR returns [].
  it("(d) memory degrades gracefully: search throwing (embeddings absent) never crashes the bundle", async () => {
    mockSearchMultiPath.mockRejectedValue(new Error("pgvector unavailable: column embedding does not exist"));
    const db = makeSeqDb([
      [{ summaryText: null, routingTerms: null }],
      [{ id: "e1", rawContent: "ambient chatter", authorAgentId: null, createdBy: "user-1", createdAt: new Date("2026-06-01T10:00:00Z") }],
    ]);

    const out = await buildCrewContextBundle(db as any, {
      companyId: "co-1",
      threadId: "thread-1",
      agentId: "agent-eng",
    });

    // No throw; the thread context still rendered; no memory section.
    expect(out).toContain("ambient chatter");
    expect(out).not.toContain("Relevant memory:");
  });

  it("(d2) memory empty array → no memory section, thread context preserved", async () => {
    mockSearchMultiPath.mockResolvedValue([]);
    const db = makeSeqDb([
      [{ summaryText: null, routingTerms: null }],
      [{ id: "e1", rawContent: "ambient chatter two", authorAgentId: null, createdBy: "user-1", createdAt: new Date("2026-06-01T10:00:00Z") }],
    ]);

    const out = await buildCrewContextBundle(db as any, {
      companyId: "co-1",
      threadId: "thread-1",
      agentId: "agent-eng",
    });

    expect(out).toContain("ambient chatter two");
    expect(out).not.toContain("Relevant memory:");
  });

  // (e) tokenBudget trims oldest thread entries first.
  it("(e) tokenBudget: drops the OLDEST thread entries first to fit the budget", async () => {
    // Build 6 chunky entries. With a tiny budget only the most recent survive.
    const big = (n: number) => "X".repeat(400) + ` #${n}`;
    const rowsDesc = [6, 5, 4, 3, 2, 1].map((n) => ({
      id: `e${n}`,
      rawContent: big(n),
      authorAgentId: null,
      createdBy: "user-1",
      createdAt: new Date(2026, 5, 1, 10, n, 0),
    }));
    const db = makeSeqDb([
      [{ summaryText: null, routingTerms: null }], // company-scoped thread row (found)
      rowsDesc,                                    // entries (desc)
    ]);

    // ~120 tokens ≈ 480 chars: enough for ~1 entry, not all 6.
    const out = await buildCrewContextBundle(db as any, {
      companyId: "co-1",
      threadId: "thread-1",
      agentId: "agent-eng",
      tokenBudget: 120,
    });

    // The newest entry (#6) must survive; the oldest (#1) must be dropped first.
    expect(out).toContain("#6");
    expect(out).not.toContain("#1");
    // Budget respected (ceil(len/4) <= budget, with a little slack for headers).
    expect(Math.ceil(out.length / 4)).toBeLessThanOrEqual(120 + 40);
  });

  // ── Cross-tenant scoping (security) ────────────────────────────────────────
  // The thread + task reads MUST be company-scoped. A caller-supplied threadId/
  // issueId can arrive via a wakeup payload (dispatcher → agent.dispatch), so a
  // company-A run passing a company-B id must read NOTHING of company B's data,
  // even though that thread/task genuinely EXISTS in company B (the denial is
  // the company scope, not a generic not-found).

  it("(sec-thread) a foreign company's thread is NOT readable — no summary, no entries leak", async () => {
    mockSearchMultiPath.mockResolvedValue([]);
    const db = makeTenantScopedDb({
      ownerCompanyId: "company-B",
      discussionId: "thread-owned-by-B",
      // This thread + these entries genuinely exist, owned by company-B.
      discussionRow: { summaryText: "Company B secret strategy", routingTerms: ["acquisition", "layoffs"] },
      entryRows: [
        { id: "b1", rawContent: "Company B confidential board note", authorAgentId: "agent-b", createdBy: "agent", createdAt: new Date("2026-06-01T10:00:00Z") },
      ],
      agentRows: [{ id: "agent-b", name: "CompanyB-Agent" }],
    });

    // Attacker: company-A run, but pointing at company-B's thread id.
    const out = await buildCrewContextBundle(db as any, {
      companyId: "company-A",
      threadId: "thread-owned-by-B",
      agentId: "agent-a",
    });

    // Nothing of company B crosses the boundary.
    expect(out).toBe("");
    expect(out).not.toContain("Company B secret strategy");
    expect(out).not.toContain("Company B confidential board note");
    expect(out).not.toContain("acquisition");
    expect(out).not.toContain("CompanyB-Agent");
    // And the foreign thread's entries/memory were never queried against B.
    expect(mockSearchMultiPath).not.toHaveBeenCalled();
  });

  it("(sec-thread) the SAME thread IS readable by its owning company (denial is company scope, not not-found)", async () => {
    mockSearchMultiPath.mockResolvedValue([]);
    const db = makeTenantScopedDb({
      ownerCompanyId: "company-B",
      discussionId: "thread-owned-by-B",
      discussionRow: { summaryText: "Company B secret strategy", routingTerms: ["acquisition"] },
      entryRows: [
        { id: "b1", rawContent: "Company B confidential board note", authorAgentId: null, createdBy: "user-b", createdAt: new Date("2026-06-01T10:00:00Z") },
      ],
    });

    const out = await buildCrewContextBundle(db as any, {
      companyId: "company-B", // the rightful owner
      threadId: "thread-owned-by-B",
      agentId: "agent-b",
    });

    // Owner sees the content — proves the foreign-company denial above is the
    // company scope, not the thread simply being absent.
    expect(out).toContain("Company B secret strategy");
    expect(out).toContain("Company B confidential board note");
  });

  it("(sec-task) a foreign company's task is NOT readable through the task branch", async () => {
    mockSearchMultiPath.mockResolvedValue([]);
    const db = makeTenantScopedDb({
      ownerCompanyId: "company-B",
      issueId: "task-owned-by-B",
      issueRow: {
        id: "task-owned-by-B",
        companyId: "company-B",
        title: "Company B private task title",
        description: "Company B private task body",
        status: "todo",
        priority: "high",
        artifactId: null,
        projectId: null,
        projectType: null,
        goalId: null,
      },
    });

    const out = await buildCrewContextBundle(db as any, {
      companyId: "company-A",
      issueId: "task-owned-by-B",
      agentId: "agent-a",
    });

    expect(out).toBe("");
    expect(out).not.toContain("Company B private task title");
    expect(out).not.toContain("Company B private task body");
  });

  it("returns empty string when there is genuinely no context (no thread/task, no memory)", async () => {
    mockSearchMultiPath.mockResolvedValue([]);
    const db = makeSeqDb([]);
    const out = await buildCrewContextBundle(db as any, {
      companyId: "co-1",
      agentId: "agent-eng",
    });
    expect(out).toBe("");
    // No thread/task → no searchMultiPath call (no queryText to search on).
    expect(mockSearchMultiPath).not.toHaveBeenCalled();
  });
});
