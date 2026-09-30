// FX1 / B1: a failed extraction RUN must terminalize its claimed entry —
// mirroring extraction.ts:639-659's failure branch VERBATIM (status='failed'
// + sourceInfo.extractionError + the discussion.extraction.failed LiveEvent),
// guarded on extractionRunId=runId AND extractionStatus='processing' (the
// runner is concurrent; extraction.ts guards by id only because it owns the
// lifecycle linearly). NO notification — extraction.ts writes none.
//
// Contract test (proxy-table + hoisted-mock harness, mirrors
// aoa-runner-tmpfile-cleanup.test.ts). Windows-runnable.
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  writeFileMock,
  unlinkMock,
  adapterExecute,
  createEventMock,
  buildMcpMock,
  buildBridgeSpecMock,
  publishLiveEventMock,
} = vi.hoisted(() => ({
  writeFileMock: vi.fn().mockResolvedValue(undefined),
  unlinkMock: vi.fn().mockResolvedValue(undefined),
  adapterExecute: vi.fn().mockResolvedValue(undefined),
  createEventMock: vi.fn().mockResolvedValue(undefined),
  buildMcpMock: vi.fn(() => ({})),
  buildBridgeSpecMock: vi.fn(() => ({
    command: "node",
    args: ["/bridge.js"],
    env: { AOA_SESSION_COMPANY_ID: "c" },
  })),
  publishLiveEventMock: vi.fn(),
}));

// T5: the runner now resolves an execution workspace before adapter.execute,
// which mkdir's the per-agent home and stat's candidate cwds through this same
// mocked module. `workspace-resolution.ts` imports the DEFAULT export, the
// runner the named writeFile/unlink — provide both shapes.
vi.mock("node:fs/promises", () => {
  const api = {
    writeFile: writeFileMock,
    unlink: unlinkMock,
    mkdir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  };
  return { ...api, default: api };
});

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ and: a })),
  asc: vi.fn((a: unknown) => ({ asc: a })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...vals: unknown[]) => ({
      sql: strings.join("?"),
      vals,
    }),
    {},
  ),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) =>
    new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") return Symbol(`${name}.${prop}`);
        return undefined;
      },
    });
  return {
    agents: makeTable("agents"),
    internalAgentRuns: makeTable("internal_agent_runs"),
    discussionEntries: makeTable("discussion_entries"),
    // T5: reached by the runner's execution-workspace resolution.
    issues: makeTable("issues"),
    projects: makeTable("projects"),
    projectWorkspaces: makeTable("project_workspaces"),
    memoryItems: makeTable("memory_items"),
    discussions: makeTable("discussions"),
    discussionExtractedItems: makeTable("discussion_extracted_items"),
    embeddingQueue: makeTable("embedding_queue"),
    memoryItemVersions: makeTable("memory_item_versions"),
    memoryRetrievals: makeTable("memory_retrievals"),
    suggestions: makeTable("suggestions"),
  };
});

vi.mock("../adapters/registry.js", () => ({
  getServerAdapter: vi.fn(() => ({ execute: adapterExecute })),
}));

vi.mock("../services/internal-agent/cli-mode.js", () => ({
  buildMcpConfig: buildMcpMock,
  buildMcpBridgeSpec: buildBridgeSpecMock,
  // U4b: buildCodexAoaMcpSpec is the brokered-aware selector runner.ts now
  // calls for ctx.mcpBridge. This suite exercises the desktop/non-sandbox
  // path (acquireExecutionContext mocked to sandbox:null -> brokered:false),
  // where buildCodexAoaMcpSpec falls through to plain buildMcpBridgeSpec — so
  // the SAME mock produces byte-identical output.
  buildCodexAoaMcpSpec: buildBridgeSpecMock,
}));

vi.mock("../services/heartbeat.js", () => ({
  resolveAdapterExecutionContextUnguarded: vi.fn(() => ({
    executionTarget: {},
    runtimeCommandSpec: {},
  })),
  resolveGuardedAdapterExecutionContext: vi.fn(() => ({
    executionTarget: {},
    runtimeCommandSpec: {},
  })),
  applyEnvironmentAcquisitionConfig: (config: unknown) => config,
}));

// U4: crew acquires a sandbox lease before buildMcpConfig — stub the desktop/
// local no-sandbox return shape so this suite stays on its existing byte-
// identical local path.
vi.mock("../services/acquire-execution-context.js", () => ({
  acquireExecutionContext: vi.fn().mockResolvedValue({ sandbox: null, lease: null, warmResolved: false }),
}));

vi.mock("../services/internal-agent/aoa-agents/bridge-path.js", () => ({
  resolveBridgeEntrypoint: vi.fn(() => "/bridge"),
}));

// T1: the runner opens a run transcript before adapter.execute. run-log-store
// imports `node:fs` — a DIFFERENT specifier than the `node:fs/promises` this
// file mocks — so without this an otherwise fully-mocked suite does REAL
// filesystem I/O, writing .ndjson files keyed on fixture ids that repeat across
// test files. vitest runs files in parallel workers and begin() TRUNCATES, so
// that is a latent cross-file flake, not just litter.
// T5: crew workspace resolution reads the instance experimental flags. Without
// this stub the access THROWS and the resolver's tolerant catch absorbs it —
// the suite would then only ever exercise the failure branch, and the fs/table
// stubs above would be dead.
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({
    getExperimental: vi.fn().mockResolvedValue({ enableIsolatedWorkspaces: true }),
  })),
}));

// Phase 4: the crew runner routes through the unified provider resolver before
// provider-status detection. A self-hosted miss returns host_login_fallback in
// production (never throws); the proxy-table mock db here can't serve the
// resolver's provider_connections/provider_assignments query, so stub it to a
// passthrough (agent_env_override ⇒ applyResolvedCredential is a no-op). Masks
// no real bug — it only replaces a query the mock DB cannot answer.
vi.mock("../services/provider-resolution.js", () => ({
  resolveProviderCredential: vi.fn(async () => ({ source: "agent_env_override" })),
  applyResolvedCredential: (config: unknown) => config,
  toExecutionTargetHint: () => ({ credentialKind: null, executionTargetSlug: null }),
}));

vi.mock("../services/run-log-store.js", () => ({
  getRunLogStore: () => ({
    begin: async () => ({ store: "local_file", logRef: "test-run.ndjson" }),
    append: async () => {},
    finalize: async () => ({ bytes: 0, compressed: false }),
    read: async () => ({ content: "" }),
  }),
}));

vi.mock("../services/costs.js", () => ({
  costService: vi.fn(() => ({ createEvent: createEventMock })),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: publishLiveEventMock,
  // Phase 5: runner.ts imports these too. Stubbed so they are never an
  // undefined-call (the entry-failure path here has no threadId/issueId move).
  publishIssueStatusChanged: vi.fn(),
  threadWorkingAgents: { add: vi.fn(), remove: vi.fn(() => []), list: vi.fn(() => []) },
  broadcastThreadPresence: vi.fn(),
}));

vi.mock("../middleware/logger.js", () => {
  function makeLogger(): any {
    const l: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    l.child = () => makeLogger();
    return l;
  }
  return { logger: makeLogger() };
});

import { runAoaAgent } from "../services/internal-agent/aoa-agents/runner.js";

// Db harness that records every update().set() payload + its where() arg, and
// drives the discussionEntries atomic-claim path. select() returns the agent
// row first (db.select().from(agents)...), then the discussionId resolution
// row (db.select({discussionId}).from(discussionEntries)...).
function makeDb(opts: { claim: boolean; entryStatusAfterExecute?: string }) {
  const agentRow = {
    id: "a-1",
    companyId: "co-1",
    name: "Scribe",
    adapterType: "process",
    runtimeConfig: { aoa: { role: "scribe" } },
    adapterConfig: {},
  };
  const sets: any[] = [];
  let selN = 0;

  const db: any = {
    _sets: sets,
    select: (proj?: any) => {
      const n = selN++;
      const c: any = {};
      c.from = () => c;
      c.where = () => c;
      c.then = (resolve: (v: unknown[]) => unknown) => {
        // n===0 → agent row (no projection). select({discussionId}) →
        // discussionId resolution (catch terminalizer). select({status}) →
        // the post-execute silent-failure guard's entry-status check.
        if (proj && "discussionId" in proj) {
          return Promise.resolve([{ discussionId: "disc-1" }]).then(resolve);
        }
        if (proj && "status" in proj) {
          return Promise.resolve([
            { status: opts.entryStatusAfterExecute ?? "completed" },
          ]).then(resolve);
        }
        return Promise.resolve([agentRow]).then(resolve);
      };
      return c;
    },
    insert: () => ({
      values: () => ({ returning: () => Promise.resolve([{ id: "run-1" }]) }),
    }),
    update: () => {
      const u: any = {};
      let payload: any;
      u.set = (v: any) => {
        payload = v;
        return u;
      };
      u.where = (w: any) => {
        sets.push({ set: payload, where: w });
        const p: any = Promise.resolve(
          opts.claim ? [{ id: "e-1" }] : [],
        );
        // .where(...).returning() for the atomic claim; .where(...).catch()
        // for the extraction.ts-shaped guarded terminalizer.
        p.returning = () => Promise.resolve(opts.claim ? [{ id: "e-1" }] : []);
        p.catch = (cb: any) => Promise.resolve().catch(cb);
        return p;
      };
      return u;
    },
  };
  return db;
}

describe("FX1/B1: failed extraction run terminalizes its claimed entry", () => {
  beforeEach(() => {
    writeFileMock.mockClear().mockResolvedValue(undefined);
    unlinkMock.mockClear().mockResolvedValue(undefined);
    adapterExecute.mockClear().mockResolvedValue(undefined);
    createEventMock.mockClear().mockResolvedValue(undefined);
    buildMcpMock.mockClear().mockReturnValue({});
    publishLiveEventMock.mockClear();
  });

  it("claimed entry + adapter throws → entry updated extractionStatus='failed' guarded by extractionRunId=runId AND status='processing', LiveEvent published, run row failed; NO notification", async () => {
    adapterExecute.mockRejectedValueOnce(new Error("agent boom"));
    const db = makeDb({ claim: true });

    await expect(
      runAoaAgent(db as any, "a-1", {
        companyId: "co-1",
        source: "outbox",
        entryId: "e-1",
      }),
    ).resolves.toMatchObject({ status: expect.stringMatching(/succeeded|failed/) }); // T1.0: AoaRunResult, not void

    // The run row was terminalized → failed (internalAgentRuns update).
    const runFail = db._sets.find(
      (s: any) => s.set?.status === "failed" && "errorMessage" in (s.set ?? {}),
    );
    expect(runFail).toBeDefined();

    // The claimed entry was terminalized mirroring extraction.ts: status
    // 'failed' + sourceInfo jsonb_set(extractionError).
    const entryFail = db._sets.find(
      (s: any) =>
        s.set?.extractionStatus === "failed" && "sourceInfo" in (s.set ?? {}),
    );
    expect(entryFail).toBeDefined();
    expect(entryFail.set.sourceInfo).toBeDefined();

    // FX1 concurrency guard: the where-clause for the entry terminalizer is
    // and(eq(id, claimedEntryId), eq(extractionStatus,'processing'),
    // eq(extractionRunId, runId)) — NOT id-only. The @armyofagents/db proxy
    // returns Symbol(table.col) for columns (not JSON-serializable), so assert
    // structurally: each predicate is {eq:[colSymbol, value]}; match on
    // String(colSymbol) + the literal value.
    const preds: Array<{ eq: [unknown, unknown] }> = entryFail.where.and;
    expect(Array.isArray(preds)).toBe(true);
    const pred = (colNeedle: string, val: unknown) =>
      preds.some(
        (p) =>
          p &&
          Array.isArray(p.eq) &&
          String(p.eq[0]).includes(colNeedle) &&
          p.eq[1] === val,
      );
    // id = the claimed entry id
    expect(pred("discussion_entries.id", "e-1")).toBe(true);
    // status guard = 'processing'
    expect(pred("discussion_entries.extractionStatus", "processing")).toBe(
      true,
    );
    // run guard = this run's id ("run-1" from the harness)
    expect(pred("discussion_entries.extractionRunId", "run-1")).toBe(true);

    // discussion.extraction.failed LiveEvent published with the right shape.
    expect(publishLiveEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "co-1",
        type: "discussion.extraction.failed",
        payload: expect.objectContaining({
          discussionId: "disc-1",
          entryId: "e-1",
          error: "agent boom",
        }),
      }),
    );

    // NO notification: nothing in db._sets writes a notifications row, and
    // there is no notifications insert (mirrors extraction.ts exactly).
    const anyNotif = db._sets.some((s: any) =>
      JSON.stringify(s).includes("notification"),
    );
    expect(anyNotif).toBe(false);
  });

  it("claimed entry + adapter succeeds but never submitted (entry still 'processing') → terminalized failed (silent-failure guard)", async () => {
    // adapter.execute RESOLVES (default), but the agent never called
    // submit_extracted_items, so the claimed entry is still 'processing' after
    // execute returns. The silent-failure guard must throw → the catch
    // terminalizes the entry + run 'failed' instead of leaving it stuck.
    const db = makeDb({ claim: true, entryStatusAfterExecute: "processing" });

    await expect(
      runAoaAgent(db as any, "a-1", {
        companyId: "co-1",
        // P1-C fix gate: only source="outbox" triggers the entry-claim path
        // (extraction agent's territory). Other sources (mentions, sweeps,
        // phase-advance) don't claim. This test exercises the silent-failure
        // guard which only fires post-claim, so it needs the outbox source.
        source: "outbox",
        entryId: "e-1",
      }),
    ).resolves.toMatchObject({ status: expect.stringMatching(/succeeded|failed/) }); // T1.0: AoaRunResult, not void

    // Run terminalized → failed (not 'completed' — it produced nothing).
    const runFail = db._sets.find(
      (s: any) => s.set?.status === "failed" && "errorMessage" in (s.set ?? {}),
    );
    expect(runFail).toBeDefined();
    const runCompleted = db._sets.find(
      (s: any) => s.set?.status === "completed",
    );
    expect(runCompleted).toBeUndefined();

    // Entry terminalized → failed + sourceInfo.extractionError.
    const entryFail = db._sets.find(
      (s: any) =>
        s.set?.extractionStatus === "failed" && "sourceInfo" in (s.set ?? {}),
    );
    expect(entryFail).toBeDefined();

    // LiveEvent with the silent-failure error message.
    expect(publishLiveEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "discussion.extraction.failed",
        payload: expect.objectContaining({
          entryId: "e-1",
          error: "extraction agent run completed without submitting results",
        }),
      }),
    );
  });

  it("not-claimable path (claim returns empty) → entry NOT terminalized, no failed LiveEvent", async () => {
    // claim:false → the atomic claim RETURNING is empty → early return BEFORE
    // adapter.execute; the catch terminalizer must never run for this entry.
    const db = makeDb({ claim: false });

    await expect(
      runAoaAgent(db as any, "a-1", {
        companyId: "co-1",
        source: "outbox",
        entryId: "e-1",
      }),
    ).resolves.toMatchObject({ status: expect.stringMatching(/succeeded|failed/) }); // T1.0: AoaRunResult, not void

    // No entry → 'failed' + sourceInfo write happened.
    const entryFail = db._sets.find(
      (s: any) =>
        s.set?.extractionStatus === "failed" && "sourceInfo" in (s.set ?? {}),
    );
    expect(entryFail).toBeUndefined();
    // No discussion.extraction.failed event.
    expect(publishLiveEventMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "discussion.extraction.failed" }),
    );
  });
});
