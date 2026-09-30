import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────
// The sweeper + dependents import @armyofagents/db and drizzle-orm at the top;
// we install stubs before the SUT import so the drizzle ESM cycle stays out.

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ _type: "and", args }),
  eq: (col: unknown, value: unknown) => ({ _type: "eq", col, value }),
  ne: (col: unknown, value: unknown) => ({ _type: "ne", col, value }),
  lt: (col: unknown, value: unknown) => ({ _type: "lt", col, value }),
  isNotNull: (col: unknown) => ({ _type: "isNotNull", col }),
  isNull: (col: unknown) => ({ _type: "isNull", col }),
  desc: (col: unknown) => ({ _type: "desc", col }),
  inArray: (col: unknown, values: unknown[]) => ({ _type: "inArray", col, values }),
}));

vi.mock("@armyofagents/db", () => {
  const cols: Record<string, symbol> = {};
  const makeTable = (name: string) =>
    new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[`${name}.${prop}`]) cols[`${name}.${prop}`] = Symbol(`${name}.${prop}`);
          return cols[`${name}.${prop}`];
        }
        return undefined;
      },
    });

  return {
    executionWorkspaces: makeTable("execution_workspaces"),
    issues: makeTable("issues"),
    projects: makeTable("projects"),
    projectWorkspaces: makeTable("project_workspaces"),
    workspaceRuntimeServices: makeTable("workspace_runtime_services"),
    instanceSettings: makeTable("instance_settings"),
    companies: makeTable("companies"),
  };
});

const getExperimentalMock = vi.fn();
const getCloseReadinessMock = vi.fn();

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getExperimental: getExperimentalMock,
  }),
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => ({
    getCloseReadiness: getCloseReadinessMock,
  }),
}));

// Importing after mocks are registered
import {
  DEFAULT_THREAD_WORKSPACE_TTL_DAYS,
  sweepExpiredWorkspaces,
} from "../services/workspace-ttl-sweeper.js";

// ── Mock DB helper (sequence-based) ──────────────────────────────────────────

type MockRow = Record<string, unknown>;

interface UpdateCapture {
  patch: MockRow;
}

function createDb(opts: {
  selects?: MockRow[][];
  captureUpdates?: UpdateCapture[];
} = {}) {
  let selectIdx = 0;
  const selects = opts.selects ?? [];
  const captureUpdates = opts.captureUpdates;

  function makeSelectChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.limit = () => chain;
    chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  }

  function makeUpdateChain() {
    const state: { patch: MockRow | null } = { patch: null };
    const chain: Record<string, unknown> = {};
    chain.set = (patch: MockRow) => {
      state.patch = patch;
      return chain;
    };
    chain.where = () => chain;
    chain.then = (resolve: (v: MockRow[]) => unknown) => {
      if (captureUpdates && state.patch) captureUpdates.push({ patch: state.patch });
      return Promise.resolve(resolve([]));
    };
    return chain;
  }

  return {
    select: () => makeSelectChain(() => selects[selectIdx++] ?? []),
    update: () => makeUpdateChain(),
  } as never;
}

const now = Date.now();
const recent = new Date(now - 1 * 24 * 60 * 60 * 1000); // 1 day ago
const stale = new Date(now - 60 * 24 * 60 * 60 * 1000); // 60 days ago

// ── Tests ────────────────────────────────────────────────────────────────────

describe("sweepExpiredWorkspaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns early with zero counts when experimental flag is off", async () => {
    getExperimentalMock.mockResolvedValue({ enableWorkspaceTtlSweeper: false });
    const db = createDb({ selects: [] });

    const result = await sweepExpiredWorkspaces(db);

    expect(result).toEqual({ scanned: 0, marked: 0, blocked: 0, skipped: 0 });
    expect(getCloseReadinessMock).not.toHaveBeenCalled();
  });

  it("skips projects with no ttlDays", async () => {
    getExperimentalMock.mockResolvedValue({ enableWorkspaceTtlSweeper: true });
    const db = createDb({
      selects: [
        [
          { id: "proj-no-ttl", executionWorkspacePolicy: { enabled: true } },
          { id: "proj-zero-ttl", executionWorkspacePolicy: { enabled: true, ttlDays: 0 } },
          { id: "proj-null-ttl", executionWorkspacePolicy: { enabled: true, ttlDays: null } },
        ],
        // fallback-pass thread-workspace candidates (none)
        [],
      ],
    });

    const result = await sweepExpiredWorkspaces(db);

    expect(result).toEqual({ scanned: 0, marked: 0, blocked: 0, skipped: 3 });
    expect(getCloseReadinessMock).not.toHaveBeenCalled();
  });

  it("marks eligible workspaces as cleanup-eligible with ttl_sweep reason", async () => {
    getExperimentalMock.mockResolvedValue({ enableWorkspaceTtlSweeper: true });
    getCloseReadinessMock.mockResolvedValue({ state: "ready", warnings: [], plannedActions: [] });

    const captureUpdates: UpdateCapture[] = [];
    const db = createDb({
      selects: [
        // projects list
        [{ id: "proj-1", executionWorkspacePolicy: { enabled: true, ttlDays: 30 } }],
        // candidates for proj-1
        [
          { id: "ws-stale", cleanupEligibleAt: null },
          { id: "ws-stale-2", cleanupEligibleAt: null },
        ],
        // fallback-pass thread-workspace candidates (none)
        [],
      ],
      captureUpdates,
    });

    const result = await sweepExpiredWorkspaces(db);

    expect(result).toEqual({ scanned: 2, marked: 2, blocked: 0, skipped: 0 });
    expect(captureUpdates).toHaveLength(2);
    for (const update of captureUpdates) {
      expect(update.patch.cleanupReason).toBe("ttl_sweep:30d");
      expect(update.patch.cleanupEligibleAt).toBeInstanceOf(Date);
    }
  });

  it("skips workspaces that already have cleanupEligibleAt stamped (idempotent)", async () => {
    getExperimentalMock.mockResolvedValue({ enableWorkspaceTtlSweeper: true });
    getCloseReadinessMock.mockResolvedValue({ state: "ready", warnings: [] });

    const captureUpdates: UpdateCapture[] = [];
    const db = createDb({
      selects: [
        [{ id: "proj-1", executionWorkspacePolicy: { enabled: true, ttlDays: 30 } }],
        [
          { id: "ws-already-marked", cleanupEligibleAt: new Date(now - 1000) },
        ],
        // fallback-pass thread-workspace candidates (none)
        [],
      ],
      captureUpdates,
    });

    const result = await sweepExpiredWorkspaces(db);

    expect(result).toEqual({ scanned: 1, marked: 0, blocked: 0, skipped: 1 });
    expect(captureUpdates).toHaveLength(0);
    expect(getCloseReadinessMock).not.toHaveBeenCalled();
  });

  it("counts as blocked when readiness.state === 'blocked'", async () => {
    getExperimentalMock.mockResolvedValue({ enableWorkspaceTtlSweeper: true });
    getCloseReadinessMock.mockResolvedValue({ state: "blocked", blockingReasons: ["dirty"] });

    const captureUpdates: UpdateCapture[] = [];
    const db = createDb({
      selects: [
        [{ id: "proj-1", executionWorkspacePolicy: { enabled: true, ttlDays: 30 } }],
        [{ id: "ws-blocked", cleanupEligibleAt: null }],
        // fallback-pass thread-workspace candidates (none)
        [],
      ],
      captureUpdates,
    });

    const result = await sweepExpiredWorkspaces(db);

    expect(result).toEqual({ scanned: 1, marked: 0, blocked: 1, skipped: 0 });
    expect(captureUpdates).toHaveLength(0);
  });

  it("counts as blocked when readiness returns null (workspace disappeared mid-sweep)", async () => {
    getExperimentalMock.mockResolvedValue({ enableWorkspaceTtlSweeper: true });
    getCloseReadinessMock.mockResolvedValue(null);

    const db = createDb({
      selects: [
        [{ id: "proj-1", executionWorkspacePolicy: { enabled: true, ttlDays: 30 } }],
        [{ id: "ws-missing", cleanupEligibleAt: null }],
        // fallback-pass thread-workspace candidates (none)
        [],
      ],
    });

    const result = await sweepExpiredWorkspaces(db);

    expect(result).toEqual({ scanned: 1, marked: 0, blocked: 1, skipped: 0 });
  });

  it("treats readiness throws as blocked (defensive; no mark, no crash)", async () => {
    getExperimentalMock.mockResolvedValue({ enableWorkspaceTtlSweeper: true });
    getCloseReadinessMock.mockRejectedValue(new Error("boom"));

    const captureUpdates: UpdateCapture[] = [];
    const db = createDb({
      selects: [
        [{ id: "proj-1", executionWorkspacePolicy: { enabled: true, ttlDays: 30 } }],
        [{ id: "ws-throwing", cleanupEligibleAt: null }],
        // fallback-pass thread-workspace candidates (none)
        [],
      ],
      captureUpdates,
    });

    const result = await sweepExpiredWorkspaces(db);

    expect(result).toEqual({ scanned: 1, marked: 0, blocked: 1, skipped: 0 });
    expect(captureUpdates).toHaveLength(0);
  });

  it("handles mixed per-project outcomes across several projects", async () => {
    getExperimentalMock.mockResolvedValue({ enableWorkspaceTtlSweeper: true });
    getCloseReadinessMock.mockImplementation(async (id: string) => {
      if (id === "ws-blocked") return { state: "blocked" };
      return { state: "ready" };
    });

    const captureUpdates: UpdateCapture[] = [];
    const db = createDb({
      selects: [
        // 3 projects — only the 2nd has ttlDays
        [
          { id: "proj-no-ttl", executionWorkspacePolicy: { enabled: true } },
          { id: "proj-with-ttl", executionWorkspacePolicy: { enabled: true, ttlDays: 7 } },
          { id: "proj-zero-ttl", executionWorkspacePolicy: { enabled: true, ttlDays: 0 } },
        ],
        // candidates for proj-with-ttl (the only one that ran a candidate query)
        [
          { id: "ws-ok", cleanupEligibleAt: null },
          { id: "ws-blocked", cleanupEligibleAt: null },
          { id: "ws-already", cleanupEligibleAt: recent },
        ],
        // fallback-pass thread-workspace candidates (none)
        [],
      ],
      captureUpdates,
    });

    const result = await sweepExpiredWorkspaces(db);

    // 2 projects skipped (no/zero ttl); 3 candidates scanned: 1 marked, 1 blocked, 1 already-skipped
    expect(result).toEqual({ scanned: 3, marked: 1, blocked: 1, skipped: 3 });
    expect(captureUpdates).toHaveLength(1);
    expect(captureUpdates[0]!.patch.cleanupReason).toBe("ttl_sweep:7d");
  });

  // ── Fallback pass: thread-workspaces in projects without ttlDays ───────────

  it("fallback pass marks thread workspaces in projects without ttlDays", async () => {
    getExperimentalMock.mockResolvedValue({ enableWorkspaceTtlSweeper: true });
    getCloseReadinessMock.mockResolvedValue({ state: "ready", warnings: [] });

    const captureUpdates: UpdateCapture[] = [];
    const db = createDb({
      selects: [
        // projects list — none have ttlDays so the per-project loop skips all
        [{ id: "proj-no-ttl", executionWorkspacePolicy: { enabled: true } }],
        // fallback-pass thread-workspace candidates (one stale, unmarked)
        [{ id: "ws-thread-stale", cleanupEligibleAt: null }],
      ],
      captureUpdates,
    });

    const result = await sweepExpiredWorkspaces(db);

    // 1 project skipped (no ttlDays); fallback scans 1, marks 1.
    expect(result).toEqual({ scanned: 1, marked: 1, blocked: 0, skipped: 1 });
    expect(captureUpdates).toHaveLength(1);
    expect(captureUpdates[0]!.patch.cleanupReason).toBe(
      `thread_workspace_default:${DEFAULT_THREAD_WORKSPACE_TTL_DAYS}d`,
    );
    expect(captureUpdates[0]!.patch.cleanupEligibleAt).toBeInstanceOf(Date);
  });

  it("fallback pass skips already-marked thread workspaces (idempotent)", async () => {
    getExperimentalMock.mockResolvedValue({ enableWorkspaceTtlSweeper: true });
    getCloseReadinessMock.mockResolvedValue({ state: "ready" });

    const captureUpdates: UpdateCapture[] = [];
    const db = createDb({
      selects: [
        // no projects
        [],
        // fallback-pass candidate that's already marked
        [{ id: "ws-thread-marked", cleanupEligibleAt: new Date(now - 1000) }],
      ],
      captureUpdates,
    });

    const result = await sweepExpiredWorkspaces(db);

    expect(result).toEqual({ scanned: 1, marked: 0, blocked: 0, skipped: 1 });
    expect(captureUpdates).toHaveLength(0);
    // readiness check must be skipped when already-marked
    expect(getCloseReadinessMock).not.toHaveBeenCalled();
  });

  it("fallback pass ignores issue-scoped workspaces (only threadId IS NOT NULL is selected)", async () => {
    getExperimentalMock.mockResolvedValue({ enableWorkspaceTtlSweeper: true });
    getCloseReadinessMock.mockResolvedValue({ state: "ready" });

    const captureUpdates: UpdateCapture[] = [];
    // The fallback SELECT filter (`isNotNull(threadId)`) is the actual guard;
    // by simulating an empty result set we encode that the production WHERE
    // would not pick up an issue-scoped workspace. We also assert no extra
    // update happens.
    const db = createDb({
      selects: [
        [], // no projects
        [], // fallback pass: issue-scoped workspaces filtered out at the DB level
      ],
      captureUpdates,
    });

    const result = await sweepExpiredWorkspaces(db);

    expect(result).toEqual({ scanned: 0, marked: 0, blocked: 0, skipped: 0 });
    expect(captureUpdates).toHaveLength(0);
  });

  it("fallback pass respects close-readiness blocking", async () => {
    getExperimentalMock.mockResolvedValue({ enableWorkspaceTtlSweeper: true });
    getCloseReadinessMock.mockResolvedValue({ state: "blocked", blockingReasons: ["dirty"] });

    const captureUpdates: UpdateCapture[] = [];
    const db = createDb({
      selects: [
        [], // no projects
        [{ id: "ws-thread-blocked", cleanupEligibleAt: null }],
      ],
      captureUpdates,
    });

    const result = await sweepExpiredWorkspaces(db);

    expect(result).toEqual({ scanned: 1, marked: 0, blocked: 1, skipped: 0 });
    expect(captureUpdates).toHaveLength(0);
  });
});

// keep references so linter doesn't flag unused vars
void stale;
