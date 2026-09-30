// Unit 1.5 — the wiring, proven at RUNTIME where it can be, structurally where it cannot.
//
// The defect this file exists for was measured on a live single-box fleet, not inferred: an
// HTTP-created task, assigned to an eligible `org`/`claude_local` agent, with the rollout dial
// correctly set to `mode:"canary"`, produced
//
//     heartbeat_runs = 1, execution_owner = NULL, and NO `[CLI-006]` log line at all
//
// The hook existed, the dial was right, the flag was on — and the instance that actually ran
// the task was built as a bare `heartbeatService(db)` on the wakeup path, so its
// `options?.distributedRollout` was `undefined` and the canary conjunct could never be true.
// Indistinguishable from "the canary evaluated this run and chose legacy": a silent,
// unfalsifiable no-op. `distributed-cancellation-port.ts` documents this exact hazard and
// names `distributedRollout` as its example; Unit 1.5 finally closes it.
//
// The `[CLI-006]` block has SEVEN conjuncts, so its silence does not by itself isolate the
// hook — the probe gave the symptom, the source gives the cause. See the header of
// services/distributed-rollout-port.ts for which conjuncts that probe independently
// satisfied and why a missing hook is sufficient to explain all of the rest.
//
// ★ THE FALLBACK IS ASSERTED AT RUNTIME, NOT SCANNED FOR. `??` short-circuits, so the port
// getter is invoked if and only if no explicit hook was supplied. That makes both halves of
// the contract — the fallback AND the precedence — directly observable by spying on the
// mocked port module while constructing the REAL `heartbeatService`. A source-contract test
// would pass just as happily against a call whose result is discarded.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const getPort = vi.fn((): unknown => undefined);
vi.mock("../services/distributed-rollout-port.js", () => ({
  getDistributedRolloutPort: () => getPort(),
  setDistributedRolloutPort: vi.fn(),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = () =>
    new Proxy({}, { get: (_target, prop) => (prop === "$inferSelect" || prop === "$inferInsert" ? {} : Symbol(String(prop))) });
  return {
    agents: makeTable(),
    agentRuntimeState: makeTable(),
    agentTaskSessions: makeTable(),
    agentWakeupRequests: makeTable(),
    heartbeatRunEvents: makeTable(),
    heartbeatRuns: makeTable(),
    costEvents: makeTable(),
    environments: makeTable(),
    issues: makeTable(),
    projectWorkspaces: makeTable(),
    memoryItems: makeTable(),
    companies: makeTable(),
    taskDependencies: makeTable(),
    issueAttachments: makeTable(),
    issueComments: makeTable(),
    assets: makeTable(),
    projects: makeTable(),
    companySkills: makeTable(),
    teamMembers: makeTable(),
    teamCoordinations: makeTable(),
    teams: makeTable(),
    discussions: makeTable(),
    discussionExtractedItems: makeTable(),
    embeddingQueue: makeTable(),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (..._args: unknown[]) => "and",
  asc: (..._args: unknown[]) => "asc",
  desc: (..._args: unknown[]) => "desc",
  eq: (..._args: unknown[]) => "eq",
  gt: (..._args: unknown[]) => "gt",
  inArray: (..._args: unknown[]) => "inArray",
  lte: (..._args: unknown[]) => "lte",
  ne: (..._args: unknown[]) => "ne",
  or: (..._args: unknown[]) => "or",
  sql: new Proxy(() => ({ as: () => "sql" }), {
    get: () => () => ({ as: () => "sql" }),
    apply: () => ({ as: () => "sql" }),
  }),
}));

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../services/run-log-store.js", () => ({ getRunLogStore: vi.fn() }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../adapters/index.js", () => ({ getServerAdapter: vi.fn(), runningProcesses: new Map() }));
vi.mock("../agent-auth-jwt.js", () => ({ createLocalAgentJwt: vi.fn() }));
vi.mock("../adapters/api-common.js", () => ({ setSecretResolver: vi.fn() }));
vi.mock("../services/secrets.js", () => ({ secretService: vi.fn(() => ({})) }));
vi.mock("../services/output-detection.js", () => ({ outputDetectionService: vi.fn(() => ({})) }));
vi.mock("../services/run-summary.js", () => ({ formatRunSummary: vi.fn() }));
vi.mock("../services/environment-run-orchestrator.js", () => ({
  environmentRunOrchestrator: vi.fn(() => ({
    acquireForRun: vi.fn(),
  })),
}));
vi.mock("../middleware/logger.js", () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { heartbeatService } from "../services/heartbeat.js";

const HOOK = { marker: "explicit" } as never;
const PORT_HOOK = { marker: "from-port" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  getPort.mockReturnValue(undefined);
});

describe("Unit 1.5 — the port is read LAZILY, never captured at construction", () => {
  // ★ THIS IS THE TEST THAT CATCHES THE REAL BUG, and the first draft of this change failed
  // it. `createApp` (index.ts:931) eagerly builds the route factories, and three of them hold
  // a factory-scope `const heartbeat = heartbeatService(db)` — routes/issues.ts:99,
  // routes/agents.ts, routes/approvals.ts — roughly 466 lines BEFORE index.ts:1397 registers
  // the port. A hook captured in the factory is therefore permanently `undefined` on exactly
  // the sites this port exists for.
  //
  // What made that draft dangerous rather than merely wrong: the per-call sites
  // (issue-assignee-wakeup.ts, comment-wakeup-outbox.ts, work-question-continuations.ts)
  // construct at wake time and DO pick the port up — and the probe's own `issue_assigned`
  // path runs through issue-assignee-wakeup. The canary would have started working while
  // three adjacent paths stayed silently legacy, which is a worse state than uniformly broken.
  //
  // Laziness is the property that makes boot ORDER irrelevant instead of merely correct once.

  it("does NOT touch the port during construction — boot order cannot break it", () => {
    getPort.mockReturnValue(PORT_HOOK);
    heartbeatService({} as never);
    expect(
      getPort,
      "a factory-scope read is a no-op for every instance built before index.ts:1397",
    ).not.toHaveBeenCalled();
  });

  it("does not touch the port during construction with options either", () => {
    getPort.mockReturnValue(PORT_HOOK);
    heartbeatService({} as never, {} as never);
    expect(getPort).not.toHaveBeenCalled();
  });

  it("does not touch the port during construction when an explicit hook is injected", () => {
    heartbeatService({} as never, { distributedRollout: HOOK } as never);
    expect(getPort).not.toHaveBeenCalled();
  });

  it("survives a port registered AFTER the instance exists — the index.ts ordering", () => {
    // The literal production sequence: construct (createApp), then register. Nothing here
    // may throw or latch, and the instance must remain usable.
    const svc = heartbeatService({} as never);
    getPort.mockReturnValue(PORT_HOOK);
    expect(svc).toBeTruthy();
    expect(getPort).not.toHaveBeenCalled();
  });
});

// ── the composition root, asserted structurally ──────────────────────────────
//
// index.ts is not reachable from an in-process unit test, so this mirrors the guard shape of
// distributed-shadow-port-registration.test.ts — for the same reason and against the same
// failure: a port that nothing registers is inert, and its silence reads as "no traffic"
// rather than "not wired". A CHECK THAT NOTHING RUNS IS NOT A CHECK.

const SRC = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");

describe("Unit 1.5 — the composition root registers the rollout port", () => {
  it("calls setDistributedRolloutPort exactly once", () => {
    expect(
      SRC.match(/setDistributedRolloutPort\(/g) ?? [],
      "every non-scheduler heartbeat instance is hookless without this call; a second call " +
        "would silently replace the first hook",
    ).toHaveLength(1);
  });

  it("registers the real hook, not a placeholder", () => {
    expect(SRC).toMatch(/setDistributedRolloutPort\(\s*distributedRolloutHook\s*\)/);
  });

  it("registers it OUTSIDE the heartbeat-scheduler conditional", () => {
    // The heart of the fix. The route-constructed instances that execute task runs exist
    // whether or not `config.heartbeatSchedulerEnabled` is true, so registration gated on the
    // scheduler would reproduce the original defect on any deployment that runs the API
    // without the scheduler.
    const register = SRC.indexOf("setDistributedRolloutPort(");
    const scheduler = SRC.indexOf("if (config.heartbeatSchedulerEnabled) {");
    expect(register, "expected a registration call").toBeGreaterThan(-1);
    expect(scheduler, "expected the scheduler conditional").toBeGreaterThan(-1);
    expect(register).toBeLessThan(scheduler);
  });

  it("sits inside the distributed-execution composition, not at module scope", () => {
    // Same reasoning as the shadow port: a rollout seam for a default-off platform must not
    // arm itself on deployments that never composed distributed execution. Indentation is the
    // marker that it sits inside that block.
    expect(SRC).toMatch(/^[ \t]+setDistributedRolloutPort\(/m);
    expect(SRC).not.toMatch(/^setDistributedRolloutPort\(/m);
  });

  it("still passes the explicit hook to the scheduler instance", () => {
    // The port is a fallback, not a replacement. Removing the explicit injection would make
    // the scheduler depend on registration ORDER — a worse contract than the one being fixed.
    expect(SRC).toMatch(
      /heartbeatService\(db as any, \{ distributedRollout: distributedRolloutHook \}\)/,
    );
  });
});

describe("Unit 1.5 — heartbeat.ts resolves the hook per run, preferring the explicit option", () => {
  const heartbeat = readFileSync(
    fileURLToPath(new URL("../services/heartbeat.ts", import.meta.url)),
    "utf8",
  );

  it("uses ?? so an explicitly-injected hook always wins", () => {
    // `||` behaves identically today but would silently swap precedence for any future
    // falsy-but-present hook.
    expect(heartbeat).toContain("explicitRolloutHook ?? getDistributedRolloutPort()");
  });

  it("resolves INSIDE executeRun, not at factory scope", () => {
    // The regression guard for the bug the runtime tests above catch. `executeRun` begins
    // around heartbeat.ts:3049; the resolution must sit after it, never in the factory body.
    const factory = heartbeat.indexOf("export function heartbeatService(");
    const executeRun = heartbeat.indexOf("async function executeRun(");
    const resolve = heartbeat.indexOf("const distributedRolloutHook = resolveDistributedRolloutHook();");
    expect(factory, "expected the factory").toBeGreaterThan(-1);
    expect(executeRun, "expected executeRun").toBeGreaterThan(executeRun - 1);
    expect(resolve, "expected a per-run resolution").toBeGreaterThan(-1);
    expect(resolve).toBeGreaterThan(executeRun);
  });

  it("never captures the resolved hook in a factory-scope const", () => {
    // The exact shape of the first draft's defect.
    expect(
      heartbeat,
      "a factory-scope capture is undefined forever on the eagerly-built route instances",
    ).not.toContain("const distributedRolloutHook = options?.distributedRollout");
  });
});

describe("Unit 1.5 — the rollout decision is falsifiable", () => {
  const heartbeat = readFileSync(
    fileURLToPath(new URL("../services/heartbeat.ts", import.meta.url)),
    "utf8",
  );

  it("logs the resolution unconditionally, outside the seven-conjunct canary guard", () => {
    // Both `[CLI-006] canary execution owner = ...` logs sit INSIDE that guard, so their
    // absence conflates "never wired" with "dial off", "mention wake", "null org" and "no
    // issue". An operator reading logs must be able to tell a broken canary from a
    // declining one — that ambiguity is the whole reason this unit exists.
    const marker = heartbeat.indexOf('"[CLI-006] rollout resolved"');
    expect(marker, "expected an unconditional resolution log").toBeGreaterThan(-1);

    // It must carry the discriminators, or it cannot do that job.
    const stmt = heartbeat.slice(marker - 700, marker);
    for (const field of [
      "rolloutHookPresent",
      "rolloutState",
      "rolloutOrganizationId",
      "hasIssueContext",
    ]) {
      expect(stmt, `the log must carry ${field} to distinguish the failure causes`).toContain(field);
    }
  });

  it("emits it after the resolution block closes, not inside the hook guard", () => {
    const guard = heartbeat.indexOf("if (distributedRolloutHook && issueId && issueContext) {");
    const marker = heartbeat.indexOf('"[CLI-006] rollout resolved"');
    const canaryBlock = heartbeat.indexOf("// ── CLI-006 (D3/D3a) — the canary execution-ownership decision");
    expect(guard).toBeGreaterThan(-1);
    expect(marker).toBeGreaterThan(guard);
    expect(marker, "must precede the canary decision block it exists to explain").toBeLessThan(canaryBlock);
  });
});
