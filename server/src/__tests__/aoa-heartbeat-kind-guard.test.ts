// Milestone B2 (FX3): enqueueWakeup must REFUSE to drive a kind='aoa' (or
// kind='platform') agent through the heartbeat runtime. AoA agents run only
// via the AoA dispatcher (Decision #100). The issue-CREATE assignment path in
// routes/issues.ts calls heartbeat.wakeup() directly with no kind check, so an
// AoA assignee would get a heartbeat_runs row AND a queued
// agent_wakeup_requests row that the AoA dispatcher Phase-3 also drains =
// dual execution across two runtimes. A single defensive chokepoint inside
// enqueueWakeup writes a skipped agent_wakeup_requests row and returns null
// for kind='aoa'/'platform', covering every present and future call site.
// kind='org' is byte-unchanged (heartbeat is its only runtime).
//
// Harness: the sanctioned vi.hoisted + Proxy-table @armyofagents/db +
// no-op drizzle-orm pattern (mirrors aoa-mention-wakeup-routing.test.ts).
// We import the REAL heartbeatService factory and drive .wakeup() against a
// scripted fake DB; every heavy heartbeat.ts sibling import is stubbed inert
// (none are reached on the enqueueWakeup pre-execute path). The 5
// adapter-utils helpers parseHeartbeatPolicy depends on are faithfully
// reimplemented so policy parsing stays correct.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ and: a })),
  asc: vi.fn((c: unknown) => ({ asc: c })),
  desc: vi.fn((c: unknown) => ({ desc: c })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  gt: vi.fn((a: unknown, b: unknown) => ({ gt: [a, b] })),
  inArray: vi.fn((c: unknown, v: unknown) => ({ inArray: [c, v] })),
  lte: vi.fn((a: unknown, b: unknown) => ({ lte: [a, b] })),
  ne: vi.fn((a: unknown, b: unknown) => ({ ne: [a, b] })),
  or: vi.fn((...a: unknown[]) => ({ or: a })),
  sql: vi.fn((s: unknown, ...v: unknown[]) => {
    const o: Record<string, unknown> = { sql: s, v };
    o.as = () => o;
    return o;
  }),
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
    agentRuntimeState: makeTable("agent_runtime_state"),
    agentTaskSessions: makeTable("agent_task_sessions"),
    agentWakeupRequests: makeTable("agent_wakeup_requests"),
    heartbeatRunEvents: makeTable("heartbeat_run_events"),
    heartbeatRuns: makeTable("heartbeat_runs"),
    costEvents: makeTable("cost_events"),
    environments: makeTable("environments"),
    issues: makeTable("issues"),
    projectWorkspaces: makeTable("project_workspaces"),
    memoryItems: makeTable("memory_items"),
    companies: makeTable("companies"),
    taskDependencies: makeTable("task_dependencies"),
    issueAttachments: makeTable("issue_attachments"),
    issueComments: makeTable("issue_comments"),
    assets: makeTable("assets"),
    projects: makeTable("projects"),
    companySkills: makeTable("company_skills"),
    teamMembers: makeTable("team_members"),
    teamCoordinations: makeTable("team_coordinations"),
    teams: makeTable("teams"),
    // Required by services/embeddings.ts (B1: createEmbeddingService target map)
    discussions: makeTable("discussions"),
    discussionExtractedItems: makeTable("discussion_extracted_items"),
    embeddingQueue: makeTable("embedding_queue"),
  };
});

// Faithful tiny reimplementations of the adapter-utils helpers that
// parseHeartbeatPolicy / normalizeMaxConcurrentRuns depend on. Semantics
// copied verbatim from packages/adapter-utils/src/server-utils.ts so policy
// parsing (enabled / wakeOnDemand) behaves exactly as in production.
vi.mock("@armyofagents/adapter-utils/server-utils", () => ({
  MAX_CAPTURE_BYTES: 64 * 1024,
  MAX_EXCERPT_BYTES: 32 * 1024,
  runningProcesses: new Map(),
  parseObject: (value: unknown): Record<string, unknown> =>
    typeof value !== "object" || value === null || Array.isArray(value)
      ? {}
      : (value as Record<string, unknown>),
  asString: (value: unknown, fallback: string) =>
    typeof value === "string" && value.length > 0 ? value : fallback,
  asNumber: (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback,
  asBoolean: (value: unknown, fallback: boolean) =>
    typeof value === "boolean" ? value : fallback,
  asStringArray: (value: unknown) =>
    Array.isArray(value) ? value.filter((i): i is string => typeof i === "string") : [],
  parseJson: (value: string) => {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return null;
    }
  },
  appendWithCap: (prev: string, chunk: string, cap = 64 * 1024) => {
    const combined = prev + chunk;
    return combined.length > cap ? combined.slice(combined.length - cap) : combined;
  },
  resolvePathValue: () => undefined,
  renderTemplate: (t: string) => t,
  redactEnvForLogs: (e: unknown) => e,
  buildAoaEnv: () => ({}),
  defaultPathForPlatform: () => "",
  ensurePathInEnv: (e: unknown) => e,
  ensureAbsoluteDirectory: () => undefined,
  ensureCommandResolvable: () => undefined,
  readAoaSkillSyncPreference: () => null,
  writeAoaSkillSyncPreference: () => undefined,
  signalRunningProcess: () => undefined,
  runChildProcess: () => Promise.resolve({}),
  // Real behaviour, not a stub: claude-local compares env keys with this (the
  // same function mergeChildEnv's strip uses), and folding wrong on Windows
  // would change which CLAUDE_CONFIG_DIR spelling wins.
  foldEnvKey: (key: string) => (process.platform === "win32" ? key.toLowerCase() : key),
}));

vi.mock("@armyofagents/adapter-utils", () => ({
  buildNpmGlobalInstallIfMissingCommand: () => null,
  buildSandboxNpmInstallCommand: () => null,
  getAdapterSessionManagement: () => null,
  hasSessionCompactionThresholds: () => false,
  resolveAdapterExecutionTarget: (v: unknown) => v ?? null,
  resolveSessionCompactionPolicy: () => ({}),
}));

vi.mock("@armyofagents/shared", () => ({
  extractSkillMentionIds: () => [],
}));

// threads.ts (pulled in transitively) now imports hub-items.ts (W1a Task 10);
// mock it so the real module + its @armyofagents/shared imports never load.
vi.mock("../services/hub-items.js", () => ({
  hubItemsService: vi.fn(() => ({ emit: vi.fn(async () => ({ id: "hub-1" })) })),
}));

vi.mock("../errors.js", () => {
  class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    HttpError,
    conflict: (m: string) => new HttpError(409, m),
    notFound: (m: string) => new HttpError(404, m),
  };
});

vi.mock("../middleware/logger.js", () => {
  const makeLogger = (): Record<string, unknown> => {
    const l: Record<string, unknown> = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    l.child = () => makeLogger();
    return l;
  };
  return { logger: makeLogger() };
});

vi.mock("./live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("./run-log-store.js", () => ({ getRunLogStore: vi.fn() }));
vi.mock("./activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(),
  runningProcesses: new Map(),
}));
vi.mock("../agent-auth-jwt.js", () => ({ createLocalAgentJwt: vi.fn() }));
vi.mock("../adapters/utils.js", () => ({
  parseObject: (value: unknown): Record<string, unknown> =>
    typeof value !== "object" || value === null || Array.isArray(value)
      ? {}
      : (value as Record<string, unknown>),
  asBoolean: (value: unknown, fallback: boolean) =>
    typeof value === "boolean" ? value : fallback,
  asNumber: (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback,
  appendWithCap: (prev: string, chunk: string, cap = 64 * 1024) => {
    const combined = prev + chunk;
    return combined.length > cap ? combined.slice(combined.length - cap) : combined;
  },
  MAX_EXCERPT_BYTES: 32 * 1024,
}));
vi.mock("./company-skills.js", () => ({ companySkillService: vi.fn(() => ({})) }));
vi.mock("./memory-skill-sync.js", () => ({ buildPinnedMemorySkillEntries: vi.fn(() => []) }));
vi.mock("./memory.js", () => ({ memoryService: vi.fn(() => ({})) }));
vi.mock("./memory-retrieval-audit.js", () => ({ recordMemoryRetrievals: vi.fn() }));
vi.mock("./issues.js", () => ({ issueService: vi.fn(() => ({})) }));
vi.mock("./quota-windows.js", () => ({ quotaWindowsService: vi.fn(() => ({})) }));
vi.mock("./environment-resolver.js", () => ({ resolveEnvironmentRuntimeConfig: vi.fn() }));
vi.mock("./plugin-tool-dispatcher.js", () => ({}));
vi.mock("../adapters/api-common.js", () => ({ setSecretResolver: vi.fn() }));
vi.mock("./secrets.js", () => ({ secretService: vi.fn(() => ({})) }));
vi.mock("./heartbeat-session.js", () => ({
  resolveRuntimeSessionParamsForWorkspace: vi.fn(),
  shouldResetTaskSessionForWake: vi.fn(() => false),
}));
vi.mock("./output-detection.js", () => ({ outputDetectionService: vi.fn(() => ({})) }));
vi.mock("./run-summary.js", () => ({ formatRunSummary: vi.fn(() => "") }));
// ../home-paths.js is left UNMOCKED on purpose: it is pure (node:fs/os/path
// only) and its full export surface is consumed transitively by paths.ts /
// config.ts. A partial stub breaks that chain.
vi.mock("./workspace-runtime.js", () => ({
  buildWorkspaceReadyComment: vi.fn(),
  cleanupExecutionWorkspaceArtifacts: vi.fn(),
  ensurePersistedExecutionWorkspaceAvailable: vi.fn(),
  ensureRuntimeServicesForRun: vi.fn(),
  persistAdapterManagedRuntimeServices: vi.fn(),
  realizeExecutionWorkspace: vi.fn(),
  releaseRuntimeServicesForRun: vi.fn(),
}));
vi.mock("./runtime-service-preview-detection.js", () => ({
  buildPreviewDetectionText: vi.fn(),
  detectPreviewRuntimeServiceReports: vi.fn(),
  extractLoopbackPreviewUrls: vi.fn(() => []),
  shouldDetectAoaAppPreviews: vi.fn(() => false),
}));
vi.mock("./execution-workspaces.js", () => ({ executionWorkspaceService: vi.fn(() => ({})) }));
vi.mock("./workspace-operations.js", () => ({ workspaceOperationService: vi.fn(() => ({})) }));
vi.mock("./execution-workspace-policy.js", () => ({
  buildExecutionWorkspaceAdapterConfig: vi.fn(),
  gateProjectExecutionWorkspacePolicy: vi.fn(),
  issueExecutionWorkspaceModeForPersistedWorkspace: vi.fn(() => "none"),
  parseIssueExecutionWorkspaceSettings: vi.fn(),
  parseProjectExecutionWorkspacePolicy: vi.fn(),
  resolveExecutionWorkspaceMode: vi.fn(),
}));
vi.mock("./instance-settings.js", () => ({ instanceSettingsService: vi.fn(() => ({})) }));
vi.mock("./cheap-fallback.js", () => ({ resolveCheapFallbackModel: vi.fn() }));
vi.mock("./recovery/model-profile-hint.js", () => ({
  isCheapRecoveryWake: vi.fn(() => false),
  resolveRecoveryCheapModel: vi.fn(),
}));
vi.mock("./heartbeat-stop-metadata.js", () => ({
  buildHeartbeatRunStopMetadata: vi.fn(),
  mergeHeartbeatRunStopMetadata: vi.fn(),
  normalizeMaxTurnStopReason: vi.fn(),
}));
vi.mock("./productivity-review.js", () => ({ productivityReviewService: vi.fn(() => ({})) }));
vi.mock("./recovery/service.js", () => ({ recoveryService: vi.fn(() => ({})) }));

import { heartbeatService } from "../services/heartbeat.js";

interface InsertCall {
  table: string;
  values: Record<string, unknown>;
}

// A scripted fake DB. select/update return permissive chainables that resolve
// to []; insert records every (table,values) pair so the test can assert what
// enqueueWakeup wrote. The aoa/platform skip path only ever calls getAgent +
// db.insert(agentWakeupRequests); the org path additionally reaches
// resolveSessionBeforeForWakeup (getRuntimeState -> select) and the
// non-issue insert chain — all satisfied by the permissive chainables.
function makeDb(agentRow: Record<string, unknown>) {
  const inserts: InsertCall[] = [];

  const tableName = (tbl: unknown): string => {
    const t = tbl as { _?: { name?: string } };
    return t?._?.name ?? "unknown";
  };

  const selectChain = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {};
    for (const m of [
      "from",
      "where",
      "orderBy",
      "limit",
      "leftJoin",
      "innerJoin",
      "for",
    ]) {
      chain[m] = () => chain;
    }
    chain.then = (resolve: (v: unknown[]) => unknown) =>
      Promise.resolve(rows).then(resolve);
    return chain;
  };

  const db: Record<string, unknown> = {
    select: (proj?: unknown) => {
      // getAgent() does db.select().from(agents) (no projection) -> [agentRow].
      // countRunningRunsForAgent() does select({ count }) and destructures
      // [{ count }] -> must yield one row with a count. Any other projected
      // select (getRuntimeState, activeRuns) resolving to [] is a safe no-op.
      if (proj === undefined) return selectChain([agentRow]);
      if (proj && typeof proj === "object" && "count" in (proj as object)) {
        return selectChain([{ count: 0 }]);
      }
      return selectChain([]);
    },
    insert: (tbl: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table: tableName(tbl), values });
        const ret = {
          returning: () => ({
            then: (resolve: (v: unknown[]) => unknown) =>
              Promise.resolve([{ id: "row-1", ...values }]).then(resolve),
          }),
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve(undefined).then(resolve),
        };
        return ret;
      },
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => ({
            then: (resolve: (v: unknown[]) => unknown) =>
              Promise.resolve([]).then(resolve),
          }),
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve(undefined).then(resolve),
        }),
      }),
    }),
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };

  return { db, inserts };
}

const callOpts = {
  source: "assignment" as const,
  triggerDetail: "system" as const,
  reason: "issue_assigned",
  payload: { issueId: undefined, mutation: "create" } as Record<string, unknown>,
  requestedByActorType: "system" as const,
  requestedByActorId: "tester",
  // No issueId in contextSnapshot/payload -> non-transaction wakeup path.
  contextSnapshot: { source: "issue.create" } as Record<string, unknown>,
};

const baseAgent = {
  id: "agent-1",
  companyId: "co-1",
  name: "Worker",
  status: "idle",
  adapterType: "process",
  runtimeConfig: {},
};

describe("B2/FX3: enqueueWakeup refuses kind='aoa'/'platform' (runtime boundary)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("kind='aoa': returns null, writes ONE skipped agent_wakeup_requests row, ZERO heartbeat_runs", async () => {
    const { db, inserts } = makeDb({ ...baseAgent, kind: "aoa" });
    const svc = heartbeatService(db as never);

    const result = await svc.wakeup("agent-1", { ...callOpts });

    expect(result).toBeNull();

    const wakeupInserts = inserts.filter((i) => i.table === "agent_wakeup_requests");
    expect(wakeupInserts).toHaveLength(1);
    expect(wakeupInserts[0].values).toMatchObject({
      companyId: "co-1",
      agentId: "agent-1",
      status: "skipped",
      reason: "heartbeat.skipped.aoa_kind",
    });

    const runInserts = inserts.filter((i) => i.table === "heartbeat_runs");
    expect(runInserts).toHaveLength(0);
  });

  it("kind='platform': returns null and is skipped (no heartbeat_runs)", async () => {
    const { db, inserts } = makeDb({ ...baseAgent, kind: "platform" });
    const svc = heartbeatService(db as never);

    const result = await svc.wakeup("agent-1", { ...callOpts });

    expect(result).toBeNull();

    const wakeupInserts = inserts.filter((i) => i.table === "agent_wakeup_requests");
    expect(wakeupInserts).toHaveLength(1);
    expect(wakeupInserts[0].values).toMatchObject({
      status: "skipped",
      reason: "heartbeat.skipped.aoa_kind",
    });
    expect(inserts.filter((i) => i.table === "heartbeat_runs")).toHaveLength(0);
  });

  it("kind='org': NOT skipped — proceeds past the guard to enqueue a heartbeat run", async () => {
    const { db, inserts } = makeDb({ ...baseAgent, kind: "org" });
    const svc = heartbeatService(db as never);

    await svc.wakeup("agent-1", { ...callOpts });

    // The org path must NEVER write the aoa-kind skip row...
    const skipRows = inserts.filter(
      (i) =>
        i.table === "agent_wakeup_requests" &&
        i.values.status === "skipped" &&
        i.values.reason === "heartbeat.skipped.aoa_kind",
    );
    expect(skipRows).toHaveLength(0);

    // ...and it must reach the heartbeat_runs insert (proof it proceeded
    // past the kind guard — existing org behavior, byte-unchanged).
    expect(inserts.filter((i) => i.table === "heartbeat_runs")).toHaveLength(1);
  });
});
