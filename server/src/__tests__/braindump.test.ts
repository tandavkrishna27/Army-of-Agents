/**
 * braindump.test.ts — WS6 braindump ingestion service.
 *
 * Mock strategy (mirrors crew-task-service.test.ts's createSequenceDb
 * pattern): drizzle-orm + @armyofagents/db mocked with Proxy stubs;
 * db.select/.insert/.update calls consume a single ordered queue matching
 * the exact call order the service under test makes. runAoaAgent is mocked
 * so no real adapter/CLI plumbing runs.
 *
 * M1 (background dispatch): `submit`/`retry` now fire `claimAndDispatch`
 * fire-and-forget instead of awaiting it — the founder's HTTP request must
 * not block on a full Librarian CLI run. `claimAndDispatch` is exported so
 * the dispatch OUTCOME (terminal status, payload sent to the Librarian,
 * correlation, failure handling) can be tested deterministically by
 * awaiting it directly, without racing the detached promise `submit`/
 * `retry` fire off. Those two callers are tested only for what they can
 * observe synchronously: that dispatch was scheduled (the atomic claim ran)
 * and that they return promptly with a non-terminal status, never blocking
 * on the Librarian run itself.
 *
 * Ordering note for anyone editing the submit/retry-level queues below:
 * `void claimAndDispatch(...).catch(...)` still runs claimAndDispatch's
 * body SYNCHRONOUSLY up to its first `await` — so the claim's `db.update()`
 * call (and thus its queue slot) is consumed before control returns to
 * `submit`/`retry`'s own next line. Concretely, for a fresh submit: slot 1+
 * are submit's own validation selects/insert, then the NEXT slot is the
 * claim (consumed inside the fire-and-forget call), then the slot after
 * that is submit's own "latest" re-read. Everything claimAndDispatch does
 * AFTER the claim (resolveLibrarianAgentId, dept lookup, folders/assets,
 * runAoaAgent, terminal update) happens later, asynchronously, and a
 * submit/retry-level test must not assume it has completed by the time
 * submit/retry's own promise resolves.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ _tag: "eq", a, b })),
  and: vi.fn((...args: unknown[]) => ({ _tag: "and", args })),
  gte: vi.fn((a: unknown, b: unknown) => ({ _tag: "gte", a, b })),
  desc: vi.fn((a: unknown) => ({ _tag: "desc", a })),
  // QA-BUG-3: deriveEffectiveStatus now uses inArray (was a raw `sql\`= ANY(...)\``
  // that generated invalid `= ANY(($1,$2,...))` and 500'd on real Postgres).
  inArray: vi.fn((a: unknown, b: unknown) => ({ _tag: "inArray", a, b })),
  isNull: vi.fn((a: unknown) => ({ _tag: "isNull", a })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ _tag: "sql", strings, values })),
}));

vi.mock("@armyofagents/db", () => {
  const t = (n: string) => new Proxy({}, { get: (_x, p) => (typeof p === "string" ? Symbol(`${n}.${p}`) : undefined) });
  return {
    agents: t("agents"),
    aoaAgentTriggers: t("aoaAgentTriggers"),
    braindumpCaptures: t("braindumpCaptures"),
    memoryAssets: t("memoryAssets"),
    memoryFolders: t("memoryFolders"),
    memoryItems: t("memoryItems"),
    projects: t("projects"),
  };
});

// Phase 5c: dispatch now reads attached files out of storage and extracts
// their text. Both are stubbed — the default `extractTextFromBuffer` mock is
// per-test, and `getStorageService` never touches a real backend here.
const getObjectMock = vi.fn();
vi.mock("../storage/index.js", () => ({
  getStorageService: () => ({ getObject: (...args: unknown[]) => getObjectMock(...args) }),
}));

const extractTextFromBufferMock = vi.fn();
vi.mock("../services/file-import.js", () => ({
  SUPPORTED_MIME_TYPES: ["application/pdf", "text/plain", "text/markdown"],
  extractTextFromBuffer: (...args: unknown[]) => extractTextFromBufferMock(...args),
}));

const runAoaAgentMock = vi.fn();
vi.mock("../services/internal-agent/aoa-agents/runner.js", () => ({
  runAoaAgent: (...args: unknown[]) => runAoaAgentMock(...args),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) },
}));

import { braindumpService, claimAndDispatch } from "../services/braindump.js";

const CO_ID = "co-1";
const DEPT_ID = "dept-1";
const CAPTURE_ID = "capture-1";
const LIBRARIAN_ID = "librarian-1";

/** Ordered-queue DB mock. Each db.select()/.insert()/.update() call consumes
 *  the next entry — regardless of call TYPE, it's a single shared counter, so
 *  a select and an update can occupy adjacent slots interchangeably depending
 *  on call order. Update chains resolve via `.where()` directly (no
 *  `.returning()` call in the service's terminal-status writes) as well as
 *  via `.returning()` (the atomic claim). Both paths pull from the same
 *  queue slot. */
function createSequenceDb(queue: unknown[][]) {
  let idx = 0;
  const next = () => queue[idx++] ?? [];

  function selectChain() {
    const result = next();
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: (fn: (rows: unknown[]) => unknown) => Promise.resolve(fn(result)),
    };
    return chain;
  }

  function updateChain() {
    const result = next();
    const whereObj: any = {
      returning: vi.fn().mockResolvedValue(result),
      then: (fn: (rows: unknown[]) => unknown) => Promise.resolve(fn(result)),
    };
    return {
      set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue(whereObj) }),
    };
  }

  function insertChain() {
    const result = next();
    return {
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue(result),
        }),
      }),
    };
  }

  return {
    select: vi.fn(() => selectChain()),
    update: vi.fn(() => updateChain()),
    insert: vi.fn(() => insertChain()),
  } as any;
}

const DEPT_ROW = { id: DEPT_ID, type: "department", name: "Engineering" };

/** Race a promise against a short timer so a test that would otherwise hang
 *  forever (proving something DIDN'T await) fails fast with a clear signal
 *  instead of timing out the whole suite. */
async function raceTimeout<T>(p: Promise<T>, ms = 200): Promise<T | "TIMEOUT"> {
  return Promise.race([p, new Promise<"TIMEOUT">((resolve) => setTimeout(() => resolve("TIMEOUT"), ms))]);
}

describe("braindumpService.submit — validation & idempotency", () => {
  beforeEach(() => {
    runAoaAgentMock.mockReset();
  });

  it("rejects a departmentId that does not belong to the company", async () => {
    const db = createSequenceDb([
      [], // select projects -> not found
    ]);
    const svc = braindumpService(db);
    await expect(
      svc.submit(CO_ID, { departmentId: "nope", content: "x", idempotencyKey: "k1" }),
    ).rejects.toThrow(/departmentId not found/i);
    expect(runAoaAgentMock).not.toHaveBeenCalled();
  });

  it("idempotent resubmit: existing non-pending row is returned without re-dispatch", async () => {
    // No claimAndDispatch interleaving concern here: the atomic claim finds
    // the row already 'proposed' (not pending/failed/stale-running) and
    // returns false immediately — there is no background continuation to
    // race against, so this test is identical to the pre-M1 version.
    const db = createSequenceDb([
      [DEPT_ROW],                                    // 1. select projects
      [],                                             // 2. insert -> conflict (already exists)
      [{ id: CAPTURE_ID, status: "proposed", departmentId: DEPT_ID, idempotencyKey: "k1" }], // 3. select existing (conflict fallback)
      [],                                             // 4. update WHERE status IN (pending,failed) -> no rows (already proposed, not claimable)
      [{ id: CAPTURE_ID, status: "proposed", proposedMemoryItemIds: [], departmentId: DEPT_ID }], // 5. select latest
    ]);
    const svc = braindumpService(db);
    const result = await svc.submit(CO_ID, { departmentId: DEPT_ID, content: "x", idempotencyKey: "k1" });

    expect(result.status).toBe("proposed");
    expect(runAoaAgentMock).not.toHaveBeenCalled();
  });

  it("rejects assetIds that do not belong to this company (no cross-company file smuggling)", async () => {
    const db = createSequenceDb([
      [DEPT_ROW], // 1. select projects (validate dept)
      [],         // 2. select memoryAssets -> none owned by this company
    ]);
    const svc = braindumpService(db);

    await expect(
      svc.submit(CO_ID, {
        scope: "department",
        departmentId: DEPT_ID,
        content: "",
        assetIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
        idempotencyKey: "k1",
      }),
    ).rejects.toThrow(/do not belong to this braindump.s scope/i);

    expect(runAoaAgentMock).not.toHaveBeenCalled();
  });

  it("rejects an asset that belongs to a DIFFERENT scope than the capture", async () => {
    // A department asset pulled into a company capture would push its contents
    // into identity-layer memory. The scope-matched query returns no rows.
    const db = createSequenceDb([
      [], // memoryAssets scope-matched lookup -> no match
    ]);
    await expect(
      braindumpService(db).submit(CO_ID, {
        scope: "company",
        departmentId: null,
        content: "",
        assetIds: ["asset-owned-by-a-department"],
        idempotencyKey: "k1",
      }),
    ).rejects.toThrow(/scope/i);
  });

  it("dedupes duplicate assetIds before the ownership check", async () => {
    const ASSET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    // The same id twice must collapse to ONE requested id — otherwise
    // requested(2) !== owned(1) and submit would wrongly throw. We only need
    // to observe that submit resolves without throwing to prove dedup
    // worked; the dispatch OUTCOME (no-librarian -> failed) is covered by
    // the dedicated claimAndDispatch test below, not here.
    const db = createSequenceDb([
      [DEPT_ROW],        // 1. select projects
      [{ id: ASSET }],   // 2. select memoryAssets -> exactly one owned row
      [{ id: CAPTURE_ID, departmentId: DEPT_ID, status: "pending" }], // 3. insert
      [{ id: CAPTURE_ID, status: "running", departmentId: DEPT_ID }], // 4. claim (consumed inside claimAndDispatch)
      [{ id: CAPTURE_ID, status: "running", departmentId: DEPT_ID }], // 5. submit's own "latest" read
    ]);
    const svc = braindumpService(db);

    const result = await svc.submit(CO_ID, {
      scope: "department",
      departmentId: DEPT_ID,
      content: "",
      assetIds: [ASSET, ASSET],
      idempotencyKey: "k1",
    });

    // Got past the ownership check (didn't throw) — dedup worked. Submit
    // returns promptly with the just-claimed non-terminal status.
    expect(result.status).toBe("running");
  });

  it("marks the capture failed when enrichment throws, instead of stranding it in 'running' — surfaced via a direct submit call", async () => {
    // Regression coverage for the "submit's own synchronous work never
    // throws even if the background dispatch's setup throws" property.
    // (The full enrichment-throws -> failed-write behavior is covered by
    // the claimAndDispatch test of the same name below.)
    const db = createSequenceDb([
      [DEPT_ROW],
      [{ id: CAPTURE_ID, departmentId: DEPT_ID, status: "pending" }],
      [{ id: CAPTURE_ID, status: "running", departmentId: DEPT_ID, content: "x", assetIds: [] }], // claim
      [{ id: CAPTURE_ID, status: "running", departmentId: DEPT_ID }], // submit's own "latest" read
    ]);
    const result = await braindumpService(db).submit(CO_ID, {
      departmentId: DEPT_ID,
      content: "x",
      idempotencyKey: "k1",
    });
    expect(result.status).toBe("running");
  });
});

describe("braindumpService.submit — background dispatch scheduling (M1)", () => {
  beforeEach(() => {
    runAoaAgentMock.mockReset();
  });

  it("returns without awaiting the Librarian run (async dispatch)", async () => {
    runAoaAgentMock.mockReturnValue(new Promise(() => {})); // never resolves
    const db = createSequenceDb([
      [DEPT_ROW],                                                                              // 1. dept validate
      [{ id: CAPTURE_ID, departmentId: DEPT_ID, status: "pending" }],                            // 2. insert
      [{ id: CAPTURE_ID, status: "running", departmentId: DEPT_ID, content: "x", assetIds: [] }], // 3. claim (fired synchronously inside submit)
      [{ id: CAPTURE_ID, status: "running", departmentId: DEPT_ID }],                             // 4. submit's own "latest" re-read
      [{ id: LIBRARIAN_ID }],                                                                      // 5. resolveLibrarianAgentId (background, after submit returns)
      [DEPT_ROW],                                                                                  // 6. dept name (background)
      [{ path: "engineering/Decisions" }],                                                         // 7. folders (background)
    ]);
    const result = await raceTimeout(
      braindumpService(db).submit(CO_ID, { departmentId: DEPT_ID, content: "x", idempotencyKey: "k1" }),
    );
    expect(result).not.toBe("TIMEOUT");
    expect(["pending", "running"]).toContain((result as { status: string }).status);
  });

  it("a background dispatch rejection does not throw out of submit", async () => {
    runAoaAgentMock.mockRejectedValue(new Error("dispatch blew up"));
    const db = createSequenceDb([
      [DEPT_ROW],
      [{ id: CAPTURE_ID, departmentId: DEPT_ID, status: "pending" }],
      [{ id: CAPTURE_ID, status: "running", departmentId: DEPT_ID, content: "x", assetIds: [] }], // claim
      [{ id: CAPTURE_ID, status: "running", departmentId: DEPT_ID }], // submit's own "latest" re-read
      [{ id: LIBRARIAN_ID }],           // background: resolveLibrarianAgentId
      [DEPT_ROW],                       // background: dept name
      [{ path: "engineering/Decisions" }], // background: folders
      [],                                // background: update -> failed (catch branch)
    ]);
    await expect(
      braindumpService(db).submit(CO_ID, { departmentId: DEPT_ID, content: "x", idempotencyKey: "k1" }),
    ).resolves.toBeTruthy();
  });

  it("a throw from the atomic claim itself does not crash submit (the mandatory .catch)", async () => {
    // The test above (mockRejectedValue on runAoaAgent) does NOT protect the
    // `.catch` on `submit`'s fire-and-forget call: runAoaAgent's rejection is
    // caught INSIDE claimAndDispatch's own try/catch (which writes status
    // 'failed'), so claimAndDispatch itself RESOLVES — the detached `.catch`
    // never fires for that path.
    //
    // The ONLY path that rejects OUT of claimAndDispatch is a throw from the
    // atomic claim itself — the `db.update(...).set(...).where(...).returning()`
    // that runs BEFORE claimAndDispatch's internal try/catch (see braindump.ts,
    // top of claimAndDispatch). This test forces exactly that throw. Without
    // the `.catch` on `void claimAndDispatch(...).catch(...)` in submit, this
    // would be an unhandled promise rejection — and this server has no
    // uncaughtException handler, so it crashes the process (A-H11 class).
    const db = createSequenceDb([
      [DEPT_ROW],                                                     // 1. select projects (validate dept)
      [{ id: CAPTURE_ID, departmentId: DEPT_ID, status: "pending" }], // 2. insert
      [{ id: CAPTURE_ID, status: "pending", departmentId: DEPT_ID }], // 3. submit's own "latest" re-read
      // NOTE: no queue slot for the claim update — it's intercepted below and
      // never reaches createSequenceDb's own updateChain()/next().
    ]);

    // Override db.update so the FIRST call (the atomic claim) rejects at
    // `.returning()`, exactly like a real claim-statement DB error would.
    // Later update calls (none occur on this path, since the claim throws
    // before claimAndDispatch's try block is ever entered) fall through to
    // the real sequence-backed implementation.
    const realUpdate = db.update;
    let updateCalls = 0;
    db.update = vi.fn(() => {
      updateCalls += 1;
      if (updateCalls === 1) {
        return {
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockRejectedValue(new Error("claim update exploded")),
            }),
          }),
        };
      }
      return realUpdate();
    });

    await expect(
      braindumpService(db).submit(CO_ID, { departmentId: DEPT_ID, content: "x", idempotencyKey: "k1" }),
    ).resolves.toBeTruthy();

    // Give the detached rejection a microtask to surface; the .catch must
    // absorb it (asserted by this test not failing/timing out with an
    // unhandled-rejection error from vitest).
    await new Promise((r) => setTimeout(r, 10));
    expect(updateCalls).toBe(1);
  });

  it("company-wide capture: submit skips department validation and schedules dispatch without waiting", async () => {
    runAoaAgentMock.mockReturnValue(new Promise(() => {})); // never resolves
    const db = createSequenceDb([
      [{ id: CAPTURE_ID, departmentId: null, scope: "company", idempotencyKey: "k1", status: "pending" }], // 1. insert (no dept-validate select at all for company scope)
      [{ id: CAPTURE_ID, status: "running", departmentId: null, content: "We value candor." }],            // 2. claim
      [{ id: CAPTURE_ID, status: "running", departmentId: null }],                                          // 3. submit's own "latest" read
      [{ id: LIBRARIAN_ID }],           // background: resolveLibrarianAgentId
      [{ path: "Company/Decisions" }],  // background: folders (no dept-name lookup for company scope)
    ]);
    const result = await raceTimeout(
      braindumpService(db).submit(CO_ID, {
        scope: "company",
        departmentId: null,
        content: "We value candor.",
        idempotencyKey: "k1",
      }),
    );
    expect(result).not.toBe("TIMEOUT");
    expect((result as { status: string }).status).toBe("running");
    // Company scope never throws a "departmentId not found" validation error
    // (contrast with the department-scope test above, which does select+throw
    // on an invalid dept) — proving the `if (scope === "department")` guard
    // correctly skips the projects lookup for company-wide captures. We don't
    // assert an exact db.select() call count here: that number depends on how
    // far the DETACHED background claimAndDispatch continuation has
    // progressed by the time this awaited race settles, which is a timing
    // detail of the mock's microtask interleaving, not a behavior contract.
  });
});

describe("braindumpService — getById / effectiveStatus", () => {
  it("effectiveStatus becomes 'approved' once every proposed item is approved", async () => {
    const db = createSequenceDb([
      [{ id: CAPTURE_ID, status: "proposed", proposedMemoryItemIds: ["mem-1"], departmentId: DEPT_ID }],
      [{ status: "approved" }],
    ]);
    const svc = braindumpService(db);
    const result = await svc.getById(CO_ID, CAPTURE_ID);
    expect(result?.effectiveStatus).toBe("approved");
  });
});

describe("claimAndDispatch — dispatch outcomes (caller-agnostic: submit and retry both funnel here)", () => {
  beforeEach(() => {
    runAoaAgentMock.mockReset();
  });

  it("department happy path: dispatch succeeds -> status=proposed, correlated items, domain-layer payload", async () => {
    runAoaAgentMock.mockResolvedValue({ status: "succeeded", runId: "run-1" });

    const db = createSequenceDb([
      [{ id: CAPTURE_ID, status: "running", departmentId: DEPT_ID, content: "We ship on Fridays.", assetIds: [] }], // 1. claim
      [{ id: LIBRARIAN_ID }],                                 // 2. resolveLibrarianAgentId
      [DEPT_ROW],                                             // 3. dept name (for prompt)
      [{ path: "engineering/Decisions" }],                    // 4. folders
      [{ id: "mem-1" }, { id: "mem-2" }],                      // 5. correlate
      [],                                                     // 6. update -> proposed
    ]);

    const claimed = await claimAndDispatch(db, CO_ID, CAPTURE_ID);
    expect(claimed).toBe(true);

    expect(runAoaAgentMock).toHaveBeenCalledTimes(1);
    const [, agentId, payload] = runAoaAgentMock.mock.calls[0]!;
    expect(agentId).toBe(LIBRARIAN_ID);
    expect(payload).toMatchObject({
      companyId: CO_ID,
      source: "braindump.ingest",
      role: "librarian",
      departmentId: DEPT_ID,
      departmentName: "Engineering",
      braindumpContent: "We ship on Fridays.",
      memoryLayer: "domain",
      allowedFolders: ["engineering/Decisions"],
      attachedFiles: [],
    });

    // Terminal write: the SECOND update() call (index 0 was the claim).
    const setArgs = db.update.mock.results[1]?.value.set.mock.calls[0]?.[0];
    expect(setArgs.status).toBe("proposed");
    expect(setArgs.proposedMemoryItemIds).toEqual(["mem-1", "mem-2"]);
    expect(setArgs.librarianAgentId).toBe(LIBRARIAN_ID);
    expect(setArgs.runId).toBe("run-1");
  });

  it("company-wide capture: no department lookups, correlates against a NULL departmentId, seeds identity-layer memory", async () => {
    runAoaAgentMock.mockResolvedValue({ status: "succeeded", runId: "run-9" });

    const db = createSequenceDb([
      [{ id: CAPTURE_ID, status: "running", departmentId: null, content: "We value candor.", assetIds: [] }], // 1. claim
      [{ id: LIBRARIAN_ID }],                                                                                 // 2. resolveLibrarianAgentId (no dept-name lookup follows — departmentId is null)
      [{ path: "Company/Decisions" }],                                                                        // 3. folders
      [{ id: "mem-9" }],                                                                                       // 4. correlate (IS NULL dept)
      [],                                                                                                      // 5. update -> proposed
    ]);

    const claimed = await claimAndDispatch(db, CO_ID, CAPTURE_ID);
    expect(claimed).toBe(true);

    const [, , payload] = runAoaAgentMock.mock.calls[0]!;
    expect(payload).toMatchObject({ companyId: CO_ID, source: "braindump.ingest", role: "librarian" });
    expect((payload as { departmentId: string | null }).departmentId).toBeNull();
    expect((payload as { memoryLayer: string }).memoryLayer).toBe("identity");
    expect((payload as { allowedFolders: string[] }).allowedFolders).toEqual(["Company/Decisions"]);

    const setArgs = db.update.mock.results[1]?.value.set.mock.calls[0]?.[0];
    expect(setArgs.status).toBe("proposed");
    expect(setArgs.proposedMemoryItemIds).toEqual(["mem-9"]);
  });

  it("extracts text from a readable attached file and names an unreadable one", async () => {
    runAoaAgentMock.mockResolvedValue({ status: "succeeded", runId: "run-file" });
    getObjectMock.mockResolvedValue({ stream: [Buffer.from("notes")], contentLength: 5 });
    extractTextFromBufferMock.mockResolvedValue({ text: "  Runway is 14 months.  ", warnings: [] });

    const db = createSequenceDb([
      [{ id: CAPTURE_ID, status: "running", departmentId: DEPT_ID, content: "", assetIds: ["a-1", "a-2"] }], // 1. claim
      [{ id: LIBRARIAN_ID }],                                          // 2. resolveLibrarianAgentId
      [DEPT_ROW],                                                      // 3. dept name
      [{ path: "engineering/Files" }],                                 // 4. folders (loadAllowedFolders runs first in the Promise.all)
      [                                                                // 5. memoryAssets (loadAttachedFiles runs second)
        { fileName: "notes.md", mimeType: "text/markdown", storageKey: "k/1" },
        { fileName: "logo.png", mimeType: "image/png", storageKey: "k/2" },
      ],
      [],                                                              // 6. correlate
      [],                                                              // 7. update -> proposed
    ]);

    await claimAndDispatch(db, CO_ID, CAPTURE_ID);

    const [, , payload] = runAoaAgentMock.mock.calls[0]! as [unknown, unknown, Record<string, unknown>];
    expect(payload.attachedFiles).toEqual([
      { fileName: "notes.md", text: "Runway is 14 months." }, // trimmed
      { fileName: "logo.png" },                               // image: named only, never read
    ]);
    // The image must not have been fetched from storage at all.
    expect(getObjectMock).toHaveBeenCalledTimes(1);
    expect(getObjectMock).toHaveBeenCalledWith(CO_ID, "k/1");
  });

  it("a file that fails to extract degrades to name-only instead of failing the capture", async () => {
    runAoaAgentMock.mockResolvedValue({ status: "succeeded", runId: "run-badfile" });
    getObjectMock.mockRejectedValue(new Error("storage offline"));

    const db = createSequenceDb([
      [{ id: CAPTURE_ID, status: "running", departmentId: DEPT_ID, content: "x", assetIds: ["a-1"] }], // 1. claim
      [{ id: LIBRARIAN_ID }],                                          // 2. resolveLibrarianAgentId
      [DEPT_ROW],                                                      // 3. dept name
      [{ path: "engineering/Files" }],                                 // 4. folders
      [{ fileName: "spec.pdf", mimeType: "application/pdf", storageKey: "k/9" }], // 5. memoryAssets
      [],                                                              // 6. correlate
      [],                                                              // 7. update -> proposed
    ]);

    const claimed = await claimAndDispatch(db, CO_ID, CAPTURE_ID);

    // Storage was down, but the braindump still reached the Librarian.
    expect(claimed).toBe(true);
    const setArgs = db.update.mock.results[1]?.value.set.mock.calls[0]?.[0];
    expect(setArgs.status).toBe("proposed");
    const [, , payload] = runAoaAgentMock.mock.calls[0]! as [unknown, unknown, Record<string, unknown>];
    expect(payload.attachedFiles).toEqual([{ fileName: "spec.pdf" }]);
  });

  it("Librarian not provisioned -> status=failed with actionable reason, no run attempted", async () => {
    const db = createSequenceDb([
      [{ id: CAPTURE_ID, status: "running", departmentId: DEPT_ID }], // 1. claim
      [],                                                             // 2. select agents (no librarian found)
      [],                                                             // 3. update -> failed
    ]);
    const claimed = await claimAndDispatch(db, CO_ID, CAPTURE_ID);

    expect(claimed).toBe(true);
    expect(runAoaAgentMock).not.toHaveBeenCalled();
    const setArgs = db.update.mock.results[1]?.value.set.mock.calls[0]?.[0];
    expect(setArgs.status).toBe("failed");
    expect(setArgs.failureReason).toMatch(/not provisioned/i);
  });

  it("runAoaAgent reports failure -> status=failed with its errorMessage", async () => {
    runAoaAgentMock.mockResolvedValue({ status: "failed", errorMessage: "adapter exited 1", runId: "run-2" });
    const db = createSequenceDb([
      [{ id: CAPTURE_ID, status: "running", departmentId: DEPT_ID }], // 1. claim
      [{ id: LIBRARIAN_ID }],                                         // 2. resolveLibrarianAgentId
      [DEPT_ROW],                                                     // 3. dept name
      [{ path: "engineering/Decisions" }],                            // 4. folders
      [],                                                             // 5. update -> failed
    ]);
    const claimed = await claimAndDispatch(db, CO_ID, CAPTURE_ID);

    expect(claimed).toBe(true);
    const setArgs = db.update.mock.results[1]?.value.set.mock.calls[0]?.[0];
    expect(setArgs.status).toBe("failed");
    expect(setArgs.failureReason).toBe("adapter exited 1");
    expect(setArgs.runId).toBe("run-2");
  });

  it("runAoaAgent throws -> status=failed with the caught error message (never a silent hang)", async () => {
    runAoaAgentMock.mockRejectedValue(new Error("subprocess spawn ENOENT"));
    const db = createSequenceDb([
      [{ id: CAPTURE_ID, status: "running", departmentId: DEPT_ID }], // 1. claim
      [{ id: LIBRARIAN_ID }],                                         // 2. resolveLibrarianAgentId
      [DEPT_ROW],                                                     // 3. dept name
      [{ path: "engineering/Decisions" }],                            // 4. folders
      [],                                                             // 5. update -> failed (catch branch)
    ]);
    const claimed = await claimAndDispatch(db, CO_ID, CAPTURE_ID);

    expect(claimed).toBe(true);
    const setArgs = db.update.mock.results[1]?.value.set.mock.calls[0]?.[0];
    expect(setArgs.status).toBe("failed");
    expect(setArgs.failureReason).toBe("subprocess spawn ENOENT");
  });

  it("marks the capture failed when enrichment throws, instead of stranding it in 'running'", async () => {
    // The claim predicate only re-accepts pending/failed, so a throw after the
    // claim used to leave the row 'running' forever: retry refused it and the
    // UI polled it indefinitely.
    runAoaAgentMock.mockResolvedValue({ status: "succeeded", runId: "run-x" });
    const db = createSequenceDb([
      [{ id: CAPTURE_ID, status: "running", departmentId: DEPT_ID, content: "x", assetIds: [] }], // 1. claim
      [{ id: LIBRARIAN_ID }],                                         // 2. resolveLibrarianAgentId
      [DEPT_ROW],                                                     // 3. dept name
      // The folder select (select #3) throws below and consumes NO queue slot.
      [],                                                             // 4. update -> failed (catch branch)
    ]);
    const realSelect = db.select;
    let call = 0;
    db.select = vi.fn(() => {
      call += 1;
      // Select order inside claimAndDispatch alone: 1 resolveLibrarianAgentId,
      // 2 dept name, 3 = the folder lookup this test blows up.
      if (call === 3) throw new Error("folders exploded");
      return realSelect();
    });

    const claimed = await claimAndDispatch(db, CO_ID, CAPTURE_ID);

    expect(claimed).toBe(true);
    expect(runAoaAgentMock).not.toHaveBeenCalled();
    const setArgs = db.update.mock.results[1]?.value.set.mock.calls[0]?.[0];
    expect(setArgs.status).toBe("failed");
    expect(setArgs.failureReason).toBe("folders exploded");
  });

  it("no-ops (returns false) when the row is not in a claimable state", async () => {
    const db = createSequenceDb([
      [], // update WHERE status IN (pending,failed) OR stale-running -> no rows
    ]);
    const claimed = await claimAndDispatch(db, CO_ID, CAPTURE_ID);
    expect(claimed).toBe(false);
    expect(runAoaAgentMock).not.toHaveBeenCalled();
  });
});

describe("braindumpService.listAll (Phase 5e)", () => {
  it("returns captures for BOTH scopes filtered only by company", async () => {
    const db = createSequenceDb([
      [
        { id: "bd-co", departmentId: null, status: "proposed", proposedMemoryItemIds: [] },
        { id: "bd-dept", departmentId: DEPT_ID, status: "proposed", proposedMemoryItemIds: [] },
      ],
    ]);
    const rows = await braindumpService(db).listAll(CO_ID);

    expect(rows.map((r) => r.id)).toEqual(["bd-co", "bd-dept"]);
    // One query, no departmentId predicate — the company-wide row would be
    // invisible to a department-filtered sweep.
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});

describe("braindumpService.retry", () => {
  beforeEach(() => {
    runAoaAgentMock.mockReset();
  });

  it("throws notFound for an unknown capture id", async () => {
    const db = createSequenceDb([[]]);
    const svc = braindumpService(db);
    await expect(svc.retry(CO_ID, "nope")).rejects.toThrow(/not found/i);
  });

  it("the claim predicate can reclaim a STALE running row", async () => {
    // Backstop for the strand class: the catch's own terminal UPDATE can fail
    // (that's exactly when the DB is unhealthy), and a killed process reaches
    // neither branch. Without a lease those rows are permanently un-retryable.
    //
    // This test only inspects the FIRST update() call's arguments (the atomic
    // claim itself), so it is unaffected by fire-and-forget dispatch —
    // whatever queue slots the detached background continuation consumes
    // afterward don't change what predicate the claim was built with.
    const db = createSequenceDb([
      [{ id: CAPTURE_ID, status: "running", departmentId: DEPT_ID }], // select existing
      [{ id: CAPTURE_ID, status: "running", departmentId: DEPT_ID }], // claim SUCCEEDS
      [],                                                             // consumed by retry's own "latest" read
      [],
      [],
    ]);
    await braindumpService(db).retry(CO_ID, CAPTURE_ID);

    // The claim's WHERE must mention 'running' and a dispatch-age bound, not
    // just pending/failed.
    const setArgs = db.update.mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(setArgs.status).toBe("running");
    const predicate = JSON.stringify(
      (db.update.mock.results[0]?.value.set.mock.results[0]?.value.where.mock.calls[0] ?? []),
    );
    expect(predicate).toMatch(/running/);
    expect(predicate).toMatch(/INTERVAL/);
  });

  it("schedules background dispatch and returns without awaiting the Librarian run", async () => {
    runAoaAgentMock.mockReturnValue(new Promise(() => {})); // never resolves
    const db = createSequenceDb([
      [{ id: CAPTURE_ID, status: "failed", departmentId: DEPT_ID }],                              // 1. select existing
      [{ id: CAPTURE_ID, status: "running", departmentId: DEPT_ID, content: "x", assetIds: [] }], // 2. claim (fired synchronously inside retry)
      [{ id: CAPTURE_ID, status: "running", departmentId: DEPT_ID }],                              // 3. retry's own "latest" re-read
      [{ id: LIBRARIAN_ID }],           // background: resolveLibrarianAgentId
      [DEPT_ROW],                       // background: dept name
      [{ path: "engineering/Decisions" }], // background: folders
    ]);
    const result = await raceTimeout(braindumpService(db).retry(CO_ID, CAPTURE_ID));
    expect(result).not.toBe("TIMEOUT");
    expect((result as { status: string }).status).toBe("running");
  });
});
