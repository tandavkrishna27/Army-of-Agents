// server/src/__tests__/memory-review-hub.test.ts
//
// Mem T4 — memory_review Inbox signpost: producer + reconciler + emit.
//
// Coverage:
//   1. buildMemoryReviewHubEmit — one company-level emit, singular/plural noun.
//   2. reconcileMemoryReview (via hubItemsService.reconcile "memory") — terminal
//      close when zero founder-gated pending remain; non-terminal count-in-title
//      heal when rows remain.
//   3. writeMemoryAndIndex emit guard — signposts only for founder-gated pending
//      memory (source != founder, layer != working, status == pending).
//
// ESM cycle workaround (CLAUDE.md Test Patterns): mock @armyofagents/db +
// drizzle-orm with Proxy table stubs + no-op operators so importing the real
// hub-items / hub-source-producers modules never pulls drizzle's require(esm)
// cycle. Sequence-based db doubles drive the reconcile/count queries.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted spies ────────────────────────────────────────────────────────────
const { mockEmitHubItem } = vi.hoisted(() => ({ mockEmitHubItem: vi.fn() }));
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
const { mockReconcile } = vi.hoisted(() => ({ mockReconcile: vi.fn() }));

// ── Module mocks ─────────────────────────────────────────────────────────────
vi.mock("@armyofagents/db", () => {
  const makeTable = () =>
    new Proxy(
      {},
      {
        get(_t, p) {
          if (p === "$inferSelect" || p === "$inferInsert") return {};
          return Symbol(String(p));
        },
      },
    );
  // Enumerate the tables the imported graph binds (vitest's named-export interop
  // only exposes OWN properties of the factory return — a bare Proxy namespace
  // leaves every named import undefined).
  const TABLE_NAMES = [
    "hubItems", "hubItemUserState", "hubAudit", "activityLog", "agentRuntimeDecisions",
    "companyMemberships", "approvals", "heartbeatRuns", "joinRequests", "discussions",
    "discussionEntries", "suggestions", "issues", "companies", "costEvents",
    "workQuestions", "memoryItems", "memoryItemVersions", "memoryRetrievals",
    "memoryFolders", "embeddingQueue", "agents", "projects", "goals", "userRoles",
    // Additional tables bound by the real memory.js import graph (embeddings.js,
    // internal-agent/providers) — needed once changeLayer is imported via
    // importActual for the Fix-1 reconcile-hook tests below.
    "discussionExtractedItems",
  ];
  const mod: Record<string, unknown> = {};
  for (const name of TABLE_NAMES) mod[name] = makeTable();
  return mod;
});

vi.mock("drizzle-orm", () => {
  const op = (name: string) => (..._a: unknown[]) => name;
  // Reconstruct tagged-template content so emit-level tests can assert on the
  // setWhere sql string (e.g. the `<> 'open'` reopen branch). A tagged template
  // call passes (stringsArray, ...substitutions); a plain call falls back to
  // "sql". Column stubs stringify to `Symbol(<col>)` — fine for substring checks.
  const sql: ((...a: unknown[]) => string) & { raw?: unknown; join?: unknown } = (
    strings: unknown,
    ...values: unknown[]
  ) => {
    if (Array.isArray(strings)) {
      return (strings as unknown[]).reduce<string>(
        (acc, part, i) => acc + String(part) + (i < values.length ? String(values[i]) : ""),
        "",
      );
    }
    return "sql";
  };
  sql.raw = (s: unknown) => s;
  sql.join = (..._a: unknown[]) => "sqljoin";
  return {
    and: op("and"),
    or: op("or"),
    eq: op("eq"),
    ne: op("ne"),
    isNull: op("isNull"),
    isNotNull: op("isNotNull"),
    inArray: op("inArray"),
    desc: op("desc"),
    asc: op("asc"),
    gt: op("gt"),
    gte: op("gte"),
    lt: op("lt"),
    lte: op("lte"),
    sql,
  };
});

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));

vi.mock("../services/org-hierarchy.js", () => ({
  orgHierarchyService: () => ({
    getFounderUserId: async () => "founder-1",
    getFirstHumanAncestor: async () => null,
  }),
}));

vi.mock("../services/db-capabilities.js", () => ({
  getDbCapabilities: () => ({ hasVectorSupport: false }),
}));

vi.mock("../services/memory.js", () => ({
  memoryService: () => ({ create: mockCreate }),
}));

// Keep the REAL buildMemoryReviewHubEmit (pure) but spy on emitHubItem so the
// write path's signpost is observable without a full hub emit.
vi.mock("../services/hub-source-producers.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/hub-source-producers.js")>();
  return { ...actual, emitHubItem: mockEmitHubItem };
});

// Keep the REAL hubItemsService (the reconcile describe-block below exercises it
// directly) but wrap `reconcile` with a spy so memory.ts's private
// signpostMemoryReview → hubItemsService(db).reconcile call is observable. The
// wrapper records the call THEN delegates to the real reconcile, so the direct
// reconcile tests keep their real behavior.
vi.mock("../services/hub-items.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/hub-items.js")>();
  return {
    ...actual,
    hubItemsService: (db: never) => {
      const real = actual.hubItemsService(db);
      return {
        ...real,
        reconcile: (...args: unknown[]) => {
          mockReconcile(...args);
          return (real.reconcile as (...a: unknown[]) => unknown)(...args);
        },
      };
    },
  };
});

// ── Imports (after mocks) ────────────────────────────────────────────────────
import { buildApprovalHubEmit, buildMemoryReviewHubEmit } from "../services/hub-source-producers.js";
import { hubItemsService } from "../services/hub-items.js";
import { writeMemoryAndIndex } from "../services/memory-write.js";

// ── Helpers ──────────────────────────────────────────────────────────────────
function thenableRows<T>(rows: T[]) {
  return { then: (resolve: (value: T[]) => unknown) => Promise.resolve(resolve(rows)) };
}

const openMemoryItem = () => ({
  id: "hub-mem-1",
  companyId: "co-1",
  sourceId: "co-1", // sourceId IS the companyId for memory_review
  sourceType: "memory",
  semanticType: "memory_review",
  status: "open",
  title: "Review 1 memory item",
  summary: "1 memory item is ready for your approval.",
  message: "1 memory item is ready for your approval.",
  sourcePermissionRevision: "2026-07-19T00:00:00.000Z",
  ownerUserId: "founder-1",
  ownerPool: null,
  scopeKey: null,
  version: 0,
  resolvedAt: null,
  archivedAt: null,
});

// reconcile() select order: #1 = open-items scan; #2 = reconcileMemoryReview count.
function makeReconcileDb(count: number, opts: { close?: boolean } = {}) {
  const item = openMemoryItem();
  const archivedRow = {
    ...item,
    status: "archived",
    version: item.version + 1,
    archivedAt: new Date("2026-07-20T00:00:00.000Z"),
  };
  let selectCount = 0;
  const updateReturning = vi.fn(async () => [archivedRow]);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const healWhere = vi.fn(async () => []);
  const set = vi.fn(() => (opts.close ? { where: updateWhere } : { where: healWhere }));
  const insertValues = vi.fn(async () => []);
  const db = {
    select: vi.fn(() => {
      selectCount += 1;
      if (selectCount === 1) {
        return { from: () => ({ where: () => thenableRows([item]) }) };
      }
      return { from: () => ({ where: () => thenableRows([{ count }]) }) };
    }),
    update: vi.fn(() => ({ set })),
    insert: vi.fn(() => ({ values: insertValues })),
  } as never;
  return { db, set, insertValues };
}

// Emit-path db double: only countPendingMemory touches the db (create +
// enqueue are mocked / no-op). select().from().where() → [{ count }].
function makeEmitDb(count = 3) {
  return {
    select: vi.fn(() => ({ from: () => ({ where: () => Promise.resolve([{ count }]) }) })),
  } as never;
}

// ============================================================================
// 1. Producer
// ============================================================================
describe("buildMemoryReviewHubEmit", () => {
  it("builds one company-level memory_review emit", () => {
    const emit = buildMemoryReviewHubEmit({
      companyId: "co-1",
      count: 4,
      ownerUserId: "founder-1",
      updatedAt: new Date("2026-07-20T00:00:00Z"),
    });
    expect(emit.semanticType).toBe("memory_review");
    expect(emit.sourceType).toBe("memory");
    expect(emit.sourceId).toBe("co-1");
    expect(emit.companyId).toBe("co-1");
    expect(emit.ownerUserId).toBe("founder-1");
    expect(emit.title).toMatch(/4 memory items/i);
  });

  it("uses the singular noun for a single item", () => {
    const emit = buildMemoryReviewHubEmit({
      companyId: "co-1",
      count: 1,
      ownerUserId: "founder-1",
    });
    expect(emit.title).toMatch(/1 memory item\b/i);
  });

  // Fix 2: the aggregate signpost has no single source row, so it must carry a
  // NULL sourcePermissionRevision — matching reconcileMemoryReview
  // (permissionRevision: null). A fresh `new Date()` here would make the storm
  // guard's `sourcePermissionRevision IS DISTINCT FROM` check always-true and
  // disagree with the reconciler.
  it("emits a null sourcePermissionRevision (aggregate has no single source revision)", () => {
    const emit = buildMemoryReviewHubEmit({
      companyId: "co-1",
      count: 2,
      ownerUserId: "founder-1",
    });
    expect(emit.sourcePermissionRevision).toBeNull();
  });

  // Fix 1: only the memory_review aggregate opts into reopen-on-re-emit.
  it("opts into reopenWhenArchived (aggregate signpost must re-signpost after a clear cycle)", () => {
    const emit = buildMemoryReviewHubEmit({
      companyId: "co-1",
      count: 2,
      ownerUserId: "founder-1",
    });
    expect(emit.reopenWhenArchived).toBe(true);
  });
});

// The approval producer (a mirror-model source) must NEVER opt into reopen — a
// decided/archived approval must stay closed.
describe("buildApprovalHubEmit — no reopen opt-in", () => {
  it("does not set reopenWhenArchived", () => {
    const emit = buildApprovalHubEmit({
      id: "appr-1",
      companyId: "co-1",
      type: "agent_hire",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      payload: {},
      updatedAt: new Date("2026-07-20T00:00:00Z"),
    });
    expect(emit.reopenWhenArchived).toBeUndefined();
  });
});

// ============================================================================
// 2. Reconciler (via hubItemsService.reconcile "memory")
// ============================================================================
describe("reconcileMemoryReview", () => {
  beforeEach(() => vi.clearAllMocks());

  it("closes the memory_review row when zero founder-gated pending remain", async () => {
    const { db, set, insertValues } = makeReconcileDb(0, { close: true });
    const result = await hubItemsService(db).reconcile("co-1", { sourceType: "memory" });
    expect(result).toEqual({ healed: 1, closed: 1, refreshed: 0 });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: "archived" }));
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ action: "reconcile_close", actorType: "system", actorId: "reconciler" }),
    );
  });

  it("heals the count in the title while rows remain (non-terminal)", async () => {
    const { db, set } = makeReconcileDb(3);
    const result = await hubItemsService(db).reconcile("co-1", { sourceType: "memory" });
    expect(result).toEqual({ healed: 1, closed: 0, refreshed: 1 });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ title: "Review 3 memory items" }));
  });
});

// ============================================================================
// 2b. emit() upsert shape — reopen opt-in (Fix 1)
// ============================================================================
//
// These tests run the REAL emit() and capture the onConflictDoUpdate argument so
// they assert on the ACTUAL upsert `set`/`setWhere` shape (not a proxy). The
// reconstructed `sql` mock (above) makes the setWhere string observable, and the
// `set` object is a plain JS object whose keys are directly inspectable.
//
// `.returning()` resolves to [] so `changed` is false → no counter/digest/publish
// side effects fire; emit re-selects the existing row and returns it. That keeps
// these tests focused purely on the upsert query the caller built.
describe("emit — reopen opt-in for aggregate signposts (Fix 1)", () => {
  beforeEach(() => vi.clearAllMocks());

  function makeUpsertCaptureDb(existingRow: Record<string, unknown>) {
    const captured: { arg?: { set: Record<string, unknown>; setWhere: unknown; target: unknown } } = {};
    const returning = vi.fn(async () => [] as unknown[]); // empty → changed=false
    const onConflictDoUpdate = vi.fn((arg: typeof captured.arg) => {
      captured.arg = arg;
      return { returning };
    });
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    // Re-select after empty RETURNING: select().from().where().limit().then(cb)
    const select = vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: () => ({ then: (cb: (r: unknown[]) => unknown) => Promise.resolve(cb([existingRow])) }),
        }),
      }),
    }));
    const db = { insert, select } as never;
    return { db, captured };
  }

  const anyRow = (over: Record<string, unknown> = {}) => ({
    id: "hub-x",
    companyId: "co-1",
    semanticType: "memory_review",
    status: "archived",
    version: 1,
    ...over,
  });

  it("reopen branch: memory_review upsert set includes status/version/archivedAt/resolvedAt and setWhere allows a non-open row", async () => {
    const { db, captured } = makeUpsertCaptureDb(anyRow());
    await hubItemsService(db).emit(
      buildMemoryReviewHubEmit({ companyId: "co-1", count: 3, ownerUserId: "founder-1" }),
    );
    const arg = captured.arg!;
    // (a) set reopens the row.
    expect("status" in arg.set).toBe(true);
    expect("version" in arg.set).toBe(true);
    expect("archivedAt" in arg.set).toBe(true);
    expect("resolvedAt" in arg.set).toBe(true);
    // Existing denormalized set keys survive.
    expect("title" in arg.set).toBe(true);
    expect("ownerUserId" in arg.set).toBe(true);
    expect("deliveredAt" in arg.set).toBe(true);
    // (b) setWhere permits a non-open row (reopen branch present).
    expect(String(arg.setWhere)).toContain("<> 'open'");
  });

  it("non-reopen branch (regression): approval upsert set has NO status/version key and setWhere is the original open-only gate", async () => {
    const { db, captured } = makeUpsertCaptureDb(anyRow({ semanticType: "approval_request" }));
    await hubItemsService(db).emit(
      buildApprovalHubEmit({
        id: "appr-1",
        companyId: "co-1",
        type: "agent_hire",
        requestedByAgentId: "agent-1",
        requestedByUserId: null,
        payload: {},
        updatedAt: new Date("2026-07-20T00:00:00Z"),
      }),
    );
    const arg = captured.arg!;
    // A mirror-model item must NEVER be resurrected: no status/version/archivedAt/
    // resolvedAt keys in the set.
    expect("status" in arg.set).toBe(false);
    expect("version" in arg.set).toBe(false);
    expect("archivedAt" in arg.set).toBe(false);
    expect("resolvedAt" in arg.set).toBe(false);
    // Existing set keys still present (path otherwise unchanged).
    expect("title" in arg.set).toBe(true);
    expect("ownerUserId" in arg.set).toBe(true);
    // setWhere is the original status='open' AND (...) gate — no reopen branch.
    const where = String(arg.setWhere);
    expect(where).toContain("= 'open'");
    expect(where).not.toContain("<> 'open'");
  });
});

// ============================================================================
// 3. Emit at the memory-write chokepoint
// ============================================================================
describe("writeMemoryAndIndex — memory_review emit guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("signposts founder-gated pending agent memory (source=agent, layer=domain)", async () => {
    mockCreate.mockResolvedValue({
      id: "mem-1",
      companyId: "co-1",
      source: "agent",
      status: "pending",
      layer: "domain",
      title: "T",
      content: "c",
    });
    await writeMemoryAndIndex(makeEmitDb(3), "co-1", {
      title: "T",
      content: "c",
      source: "agent",
      status: "pending",
      layer: "domain",
    } as never);
    expect(mockEmitHubItem).toHaveBeenCalledTimes(1);
    const emitArgs = mockEmitHubItem.mock.calls[0][1] as {
      sourceType: string;
      semanticType: string;
      sourceId: string;
      title: string;
    };
    expect(emitArgs.sourceType).toBe("memory");
    expect(emitArgs.semanticType).toBe("memory_review");
    expect(emitArgs.sourceId).toBe("co-1");
    expect(emitArgs.title).toMatch(/3 memory items/i);
  });

  it("does NOT signpost a founder-authored write (source=founder)", async () => {
    mockCreate.mockResolvedValue({
      id: "mem-2",
      companyId: "co-1",
      source: "founder",
      status: "pending",
      layer: "identity",
      title: "T",
      content: "c",
    });
    await writeMemoryAndIndex(makeEmitDb(1), "co-1", {
      title: "T",
      content: "c",
      source: "founder",
      layer: "identity",
    } as never);
    expect(mockEmitHubItem).not.toHaveBeenCalled();
  });

  it("does NOT signpost ephemeral working memory (layer=working)", async () => {
    mockCreate.mockResolvedValue({
      id: "mem-3",
      companyId: "co-1",
      source: "agent",
      status: "pending",
      layer: "working",
      title: "T",
      content: "c",
    });
    await writeMemoryAndIndex(makeEmitDb(1), "co-1", {
      title: "T",
      content: "c",
      source: "agent",
      status: "pending",
      layer: "working",
    } as never);
    expect(mockEmitHubItem).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 4. changeLayer — reconcile hook (Fix 1)
// ============================================================================
//
// changeLayer is a DISTINCT memoryService method that does NOT funnel through
// update/approve/reject/remove, so it must fire signpostMemoryReview itself.
// Moving a PENDING, non-founder item across the working↔non-working boundary
// changes the founder-gated pending count (the predicate excludes layer=working),
// so the memory_review row must be reconciled. changeLayer never mutates status,
// so the PRE-IMAGE status (the loaded `target`) drives the guard.
//
// We import the REAL memoryService via importActual (memory.js is otherwise
// mocked for the write-path tests above) and observe the private
// signpostMemoryReview → hubItemsService(db).reconcile call via mockReconcile.
describe("changeLayer — memory_review reconcile hook", () => {
  beforeEach(() => vi.clearAllMocks());

  // changeLayer db double: select #1 = the pre-image target fetch; the
  // transaction runs the layer mutation + version-row insert. Any later select
  // (from the real reconcile pass that signpostMemoryReview delegates to)
  // resolves to [] so the reconciler exits cleanly without touching state.
  function makeChangeLayerDb(target: Record<string, unknown>) {
    let selectCount = 0;
    const txHandle = {
      execute: vi.fn(async () => []),
      update: vi.fn(() => ({
        set: () => ({
          where: () => ({ returning: async () => [{ ...target, layer: "working" }] }),
        }),
      })),
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: async () => [{ versionNumber: 1 }] }) }),
        }),
      })),
      insert: vi.fn(() => ({ values: async () => [] })),
    };
    const db = {
      select: vi.fn(() => {
        selectCount += 1;
        const rows = selectCount === 1 ? [target] : [];
        return { from: () => ({ where: () => thenableRows(rows) }) };
      }),
      transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(txHandle)),
      update: vi.fn(() => ({
        set: () => ({ where: () => ({ returning: async () => [] }) }),
      })),
      insert: vi.fn(() => ({ values: async () => [] })),
    } as never;
    return db;
  }

  it("reconciles the signpost when the pre-image item is pending", async () => {
    const memoryMod =
      await vi.importActual<typeof import("../services/memory.js")>("../services/memory.js");
    const target = {
      id: "mem-cl-1",
      companyId: "co-1",
      status: "pending",
      source: "agent",
      layer: "domain",
    };
    await memoryMod.memoryService(makeChangeLayerDb(target)).changeLayer("mem-cl-1", "co-1", {
      newLayer: "working",
      taskId: "task-1",
    });
    expect(mockReconcile).toHaveBeenCalledWith("co-1", { sourceType: "memory" });
  });

  it("does NOT reconcile when the pre-image item is not pending (approved)", async () => {
    const memoryMod =
      await vi.importActual<typeof import("../services/memory.js")>("../services/memory.js");
    const target = {
      id: "mem-cl-2",
      companyId: "co-1",
      status: "approved",
      source: "agent",
      layer: "domain",
    };
    await memoryMod.memoryService(makeChangeLayerDb(target)).changeLayer("mem-cl-2", "co-1", {
      newLayer: "working",
      taskId: "task-1",
    });
    expect(mockReconcile).not.toHaveBeenCalled();
  });
});
