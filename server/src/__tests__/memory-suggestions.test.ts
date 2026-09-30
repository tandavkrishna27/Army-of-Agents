import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTableProxy, drizzleOperatorStubs, mockDbCapabilities } from "./helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  memoryItems: makeTableProxy("memory_items"),
  memoryItemVersions: makeTableProxy("memory_item_versions"),
  suggestions: makeTableProxy("suggestions"),
  agents: makeTableProxy("agents"),
}));

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

// "creates agent memory items" asserts `embedding: null` in the values passed
// to buildMemoryInsert. memory.ts line 128-130 only sets embedding=null when
// hasVectorSupport is true; mock it to ensure the field is present.
vi.mock("../services/db-capabilities.js", () => mockDbCapabilities());

vi.mock("../services/embeddings.js", () => ({
  generateEmbedding: vi.fn(),
}));

vi.mock("../adapters/api-common.js", () => ({
  resolveApiKey: vi.fn(),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// Spy on buildMemoryInsert to capture the values object the service passes
// before the raw INSERT executes — needed to assert on status/embedding.
const capturedBuildInsertValues: Record<string, unknown>[] = [];
vi.mock("../services/memory-projection.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/memory-projection.js")>();
  return {
    ...orig,
    buildMemoryInsert: vi.fn(
      (db: unknown, values: Record<string, unknown>, hasVector: boolean) => {
        capturedBuildInsertValues.push({ ...values });
        return orig.buildMemoryInsert(db as any, values, hasVector);
      },
    ),
  };
});

import { memoryService } from "../services/memory.js";

type MockRow = Record<string, unknown>;

function createSequenceDb(config: {
  selects?: MockRow[][];
  updates?: MockRow[][];
  inserts?: MockRow[][];
  // A-M6 — when true, db.execute() is treated as a FOR UPDATE parent-row lock:
  // it records the call and returns [] WITHOUT draining the insert queue (the
  // real version insert goes through .insert().values()). The default (false)
  // preserves the create() path, where buildMemoryInsert calls db.execute() to
  // perform the raw INSERT and expects the next insert row back.
  lockMode?: boolean;
} = {}) {
  let selectIdx = 0;
  let updateIdx = 0;
  let insertIdx = 0;
  const captured = {
    insertValues: [] as unknown[],
    updateSets: [] as unknown[],
    // A-M6 — track FOR UPDATE parent-row locks + whether allocation ran in a tx.
    lockExecutes: [] as unknown[],
    transactionCalls: 0,
  };

  const selects = config.selects ?? [];
  const updates = config.updates ?? [];
  const inserts = config.inserts ?? [];

  const buildChain = (kind: "select" | "update" | "insert", getResult: () => MockRow[]) => {
    const chain: Record<string, any> = {};
    for (const method of ["from", "where", "set", "values", "onConflictDoNothing", "returning", "innerJoin", "leftJoin", "orderBy", "limit"]) {
      chain[method] = (...args: unknown[]) => {
        if (method === "set") captured.updateSets.push(args[0]);
        if (method === "values") captured.insertValues.push(args[0]);
        return chain;
      };
    }
    chain.then = (resolve: (value: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  };

  const db: Record<string, any> = {
    select: () => buildChain("select", () => selects[selectIdx++] ?? []),
    update: () => buildChain("update", () => updates[updateIdx++] ?? []),
    insert: () => buildChain("insert", () => inserts[insertIdx++] ?? []),
    // buildMemoryInsert in memory-projection.ts calls db.execute() for raw SQL inserts.
    // Return the next insert result (same queue as insert, since execute replaces it).
    // A-M6: in lockMode, db.execute() is the FOR UPDATE parent-row lock — record
    // it and return [] without draining the insert queue.
    execute: (...args: unknown[]) => {
      if (config.lockMode) {
        captured.lockExecutes.push(args[0]);
        return Promise.resolve([]);
      }
      return Promise.resolve(inserts[insertIdx++] ?? []);
    },
  };

  db.transaction = async (fn: (tx: typeof db) => Promise<unknown>) => {
    captured.transactionCalls++;
    return fn(db as any);
  };

  return { db: db as any, captured };
}

describe("memoryService agent suggestions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedBuildInsertValues.length = 0;
  });

  it("creates agent memory items as pending with required layer and sourceContext", async () => {
    // svc.create() now routes through buildMemoryInsert → db.execute().
    // We spy on buildMemoryInsert (mocked above) to capture the values the service
    // passes, and db.execute() returns the pre-configured insert row.
    const { db } = createSequenceDb({
      inserts: [[{ id: "mem-1", status: "pending", source: "agent", layer: "domain" }]],
    });
    const svc = memoryService(db);

    const item = await svc.create("co-1", {
      title: "API guideline",
      content: "Prefer JSON responses",
      category: "reference",
      source: "agent",
      createdBy: "agent-1",
      layer: "domain",
      sourceContext: "Observed repeated response-format fixes",
    });

    expect(item.status).toBe("pending");
    // Verify the values the service set before calling buildMemoryInsert
    expect(capturedBuildInsertValues[0]).toEqual(expect.objectContaining({
      companyId: "co-1",
      source: "agent",
      status: "pending",
      layer: "domain",
      embedding: null,
    }));
  });

  it("rejects agent create without sourceContext", async () => {
    const { db } = createSequenceDb();
    const svc = memoryService(db);

    expect(() => svc.create("co-1", {
      title: "API guideline",
      content: "Prefer JSON responses",
      category: "reference",
      source: "agent",
      createdBy: "agent-1",
      layer: "domain",
      sourceContext: "",
    })).toThrowError(expect.objectContaining({ status: 400 }));
  });

  it("creates a pending update suggestion without changing currentVersionId", async () => {
    const { db, captured } = createSequenceDb({
      lockMode: true,
      selects: [
        [{ id: "mem-1", companyId: "co-1", status: "approved", currentVersionId: "ver-1" }],
        [],
        [{ versionNumber: 2 }],
      ],
      inserts: [[{ id: "ver-3", memoryItemId: "mem-1", versionNumber: 3, status: "pending", createdBy: "agent-1" }]],
    });
    const svc = memoryService(db);

    const version = await svc.suggestUpdate(
      "co-1",
      "mem-1",
      "Updated content",
      "The founder keeps correcting this detail",
      "agent-1",
    );

    expect(version).toEqual(expect.objectContaining({
      id: "ver-3",
      status: "pending",
      createdBy: "agent-1",
    }));
    expect(captured.updateSets).toEqual([]);
    // A-M6: allocation ran inside a tx and took a FOR UPDATE parent-row lock.
    expect(captured.transactionCalls).toBe(1);
    expect(captured.lockExecutes).toHaveLength(1);
  });

  it("updates an existing pending version by the same agent instead of duplicating it", async () => {
    const { db, captured } = createSequenceDb({
      lockMode: true,
      selects: [
        [{ id: "mem-1", companyId: "co-1", status: "approved" }],
        [{ id: "ver-pending", memoryItemId: "mem-1", versionNumber: 2, status: "pending", createdBy: "agent-1" }],
      ],
      updates: [[{ id: "ver-pending", memoryItemId: "mem-1", versionNumber: 2, status: "pending", content: "Refined content", createdBy: "agent-1" }]],
    });
    const svc = memoryService(db);

    const version = await svc.suggestUpdate(
      "co-1",
      "mem-1",
      "Refined content",
      "New reasoning",
      "agent-1",
    );

    expect(version.id).toBe("ver-pending");
    expect(captured.insertValues).toHaveLength(0);
    expect(captured.updateSets[0]).toEqual({ content: "Refined content" });
    // A-M6: the dedup that early-returns the existing pending row ran INSIDE the
    // locked tx (after the FOR UPDATE), not before it.
    expect(captured.transactionCalls).toBe(1);
    expect(captured.lockExecutes).toHaveLength(1);
  });

  it("saveDraft: allocates a new draft version inside a tx behind a FOR UPDATE parent lock", async () => {
    const { db, captured } = createSequenceDb({
      lockMode: true,
      selects: [
        // item-fetch (outside tx)
        [{ id: "mem-1", companyId: "co-1", status: "approved" }],
        // existing-draft dedup (inside tx) — none
        [],
        // max-version read (inside tx)
        [{ versionNumber: 4 }],
      ],
      inserts: [[{ id: "draft-5", memoryItemId: "mem-1", versionNumber: 5, status: "draft", createdBy: "user-1" }]],
    });
    const svc = memoryService(db);

    const version = await svc.saveDraft("co-1", "mem-1", "Draft body", "user-1");

    expect(version).toEqual(expect.objectContaining({
      id: "draft-5",
      status: "draft",
      versionNumber: 5,
    }));
    // A-M6: allocation ran inside a tx and took a FOR UPDATE parent-row lock.
    expect(captured.transactionCalls).toBe(1);
    expect(captured.lockExecutes).toHaveLength(1);
    expect(captured.insertValues[0]).toEqual(expect.objectContaining({
      memoryItemId: "mem-1",
      versionNumber: 5,
      status: "draft",
      createdBy: "user-1",
    }));
  });

  it("saveDraft: updates the caller's existing draft (dedup runs inside the locked tx)", async () => {
    const { db, captured } = createSequenceDb({
      lockMode: true,
      selects: [
        [{ id: "mem-1", companyId: "co-1", status: "approved" }],
        // existing draft by this user → early-return update, no max read/insert
        [{ id: "draft-2", memoryItemId: "mem-1", versionNumber: 2, status: "draft", createdBy: "user-1" }],
      ],
      updates: [[{ id: "draft-2", memoryItemId: "mem-1", versionNumber: 2, status: "draft", content: "Updated body", createdBy: "user-1" }]],
    });
    const svc = memoryService(db);

    const version = await svc.saveDraft("co-1", "mem-1", "Updated body", "user-1");

    expect(version.id).toBe("draft-2");
    expect(captured.insertValues).toHaveLength(0);
    expect(captured.updateSets[0]).toEqual({ content: "Updated body" });
    // Dedup ran inside the locked tx (after the FOR UPDATE), not before it.
    expect(captured.transactionCalls).toBe(1);
    expect(captured.lockExecutes).toHaveLength(1);
  });

  it("saveDraft: returns null for a missing item without opening a tx", async () => {
    const { db, captured } = createSequenceDb({
      lockMode: true,
      selects: [[]],
    });
    const svc = memoryService(db);

    const result = await svc.saveDraft("co-1", "missing", "Body", "user-1");

    expect(result).toBeNull();
    // The not-found short-circuit happens before any lock/tx work.
    expect(captured.transactionCalls).toBe(0);
    expect(captured.lockExecutes).toHaveLength(0);
  });

  it("rejects update suggestions for archived items", async () => {
    const { db } = createSequenceDb({
      selects: [[{ id: "mem-1", companyId: "co-1", status: "archived" }]],
    });
    const svc = memoryService(db);

    await expect(svc.suggestUpdate(
      "co-1",
      "mem-1",
      "Updated content",
      "Reason",
      "agent-1",
    )).rejects.toMatchObject({ status: 409 });
  });

  it("returns 404 when suggesting an update for a missing item", async () => {
    const { db } = createSequenceDb({
      selects: [[]],
    });
    const svc = memoryService(db);

    await expect(svc.suggestUpdate(
      "co-1",
      "missing",
      "Updated content",
      "Reason",
      "agent-1",
    )).rejects.toMatchObject({ status: 404 });
  });

  it("creates an archive suggestion without archiving the item", async () => {
    const { db, captured } = createSequenceDb({
      selects: [
        [{ id: "mem-1", companyId: "co-1", title: "Old note", status: "approved" }],
        [{ name: "Atlas" }],
        [],
      ],
      inserts: [[{ id: "sug-1", category: "agent_proposal", actionType: "archive_memory", relatedMemoryItemId: "mem-1" }]],
    });
    const svc = memoryService(db);

    const suggestion = await svc.suggestArchive(
      "co-1",
      "mem-1",
      "This knowledge is obsolete after the workflow change",
      "agent-1",
    );

    expect(suggestion).toEqual(expect.objectContaining({
      id: "sug-1",
      category: "agent_proposal",
      actionType: "archive_memory",
    }));
    expect(captured.insertValues[0]).toEqual(expect.objectContaining({
      category: "agent_proposal",
      actionType: "archive_memory",
      dedupeKey: "agent_proposal:archive_memory:mem-1:agent-1",
      relatedMemoryItemId: "mem-1",
      title: "Agent Atlas suggests archiving 'Old note'",
    }));
    expect(captured.updateSets).toEqual([]);
  });

  it("returns the existing archive suggestion when a keyed insert loses a race", async () => {
    const existingSuggestion = {
      id: "sug-existing",
      category: "agent_proposal",
      actionType: "archive_memory",
      dedupeKey: "agent_proposal:archive_memory:mem-1:agent-1",
      relatedMemoryItemId: "mem-1",
    };
    const { db, captured } = createSequenceDb({
      selects: [
        [{ id: "mem-1", companyId: "co-1", title: "Old note", status: "approved" }],
        [{ name: "Atlas" }],
        [],
        [existingSuggestion],
      ],
      inserts: [[]],
    });
    const svc = memoryService(db);

    const suggestion = await svc.suggestArchive(
      "co-1",
      "mem-1",
      "This knowledge is obsolete after the workflow change",
      "agent-1",
    );

    expect(suggestion).toEqual(existingSuggestion);
    expect(captured.insertValues[0]).toEqual(expect.objectContaining({
      dedupeKey: "agent_proposal:archive_memory:mem-1:agent-1",
    }));
  });

  it("approves a pending version and makes it current", async () => {
    const { db, captured } = createSequenceDb({
      selects: [
        [{ id: "mem-1", companyId: "co-1", currentVersionId: "ver-1" }],
        [{ id: "ver-2", memoryItemId: "mem-1", versionNumber: 2, content: "New content", status: "pending" }],
      ],
      updates: [
        [],
        [{ id: "ver-2", memoryItemId: "mem-1", versionNumber: 2, content: "New content", status: "approved" }],
        [],
      ],
    });
    const svc = memoryService(db);

    const approved = await svc.approveSuggestedVersion("co-1", "mem-1", "ver-2");

    expect(approved.status).toBe("approved");
    expect(captured.updateSets).toContainEqual({ status: "archived" });
    expect(captured.updateSets).toContainEqual({ status: "approved" });
    expect(captured.updateSets).toContainEqual(expect.objectContaining({
      content: "New content",
      currentVersionId: "ver-2",
    }));
  });

  it("rejects a pending version without changing the item", async () => {
    const { db, captured } = createSequenceDb({
      selects: [[{ id: "mem-1" }]],
      updates: [[{ id: "ver-2", memoryItemId: "mem-1", versionNumber: 2, status: "rejected" }]],
    });
    const svc = memoryService(db);

    const rejected = await svc.rejectSuggestedVersion("co-1", "mem-1", "ver-2");

    expect(rejected.status).toBe("rejected");
    expect(captured.updateSets).toEqual([{ status: "rejected" }]);
  });
});
