import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { setDeploymentMode } from "../config/deployment-mode.js";

/**
 * U13.2 — proves the discussion-entry extractor (the launch-critical
 * discussion→task path) routes through the ephemeral sandbox on cloud
 * (`cloud_auth`) instead of the ambient host CLI login, that the pre-acquired
 * `sandboxHandle` param is threaded through end-to-end (inert until U13.3
 * supplies one from a batch acquire), and that the desktop/local path is
 * byte-identical to before (still spawns via `buildScrubbedCliEnv`'s KEEP-list,
 * never touches the sandbox helper).
 *
 * Strategy: drive the REAL `extraction.ts` + `extraction-cli.ts` modules
 * (not mocked) through `extractFromDiscussionEntry`, with:
 *   - `../services/one-shot-provider-credential.js` mocked (so credential
 *     resolution never touches a real DB / provider-resolution chain),
 *   - `../services/one-shot-sandbox-cli.js` mocked (so the cloud path never
 *     touches a real/fake E2B provider — this file only asserts *routing*,
 *     not the sandbox helper's own internals, which U13.1's
 *     one-shot-sandbox-cli.test.ts already covers),
 *   - `../services/cli-spawn-safety.js`'s `buildScrubbedCliEnv` spied (kept
 *     real) so the desktop-path assertion can prove the KEEP-list spawn still
 *     happens, and the cloud-path assertions can prove it does NOT.
 */

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  desc: vi.fn((a: unknown) => ({ desc: a })),
  sql: Object.assign(
    vi.fn((strings: any, ...values: any[]) => ({ sql: strings, values })),
    { raw: vi.fn((input: any) => input) },
  ),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) =>
    new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === "_") return { name };
        if (typeof prop === "string") return Symbol(`${name}.${prop}`);
        return undefined;
      },
    });
  return {
    discussions: makeTable("discussions"),
    discussionEntries: makeTable("discussion_entries"),
    discussionExtractedItems: makeTable("discussion_extracted_items"),
    internalAgentConfig: makeTable("internal_agent_config"),
    internalAgentRuns: makeTable("internal_agent_runs"),
    projects: makeTable("projects"),
    debriefs: makeTable("debriefs"),
    briefs: makeTable("briefs"),
    briefItems: makeTable("brief_items"),
  };
});

vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const mockPublishLiveEvent = vi.fn();
vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: (...args: unknown[]) => mockPublishLiveEvent(...args),
}));

// Force the engine to "cli" — extraction is CLI-only; these tests never probe
// a real binary.
vi.mock("../services/extraction-engine.js", () => ({
  resolveExtractionEngine: vi.fn(async () => "cli"),
  resolveCompanyCliTool: vi.fn(async () => "claude"),
}));

// U13.0 — company provider credential resolution. Mocked so the cloud tests
// never touch a real DB / provider-resolution chain; the spy proves
// extraction.ts threads companyId/cliTool into it correctly.
const mockResolveCompanyProviderCredential = vi.fn();
vi.mock("../services/one-shot-provider-credential.js", () => ({
  resolveCompanyProviderCredential: (...a: unknown[]) => mockResolveCompanyProviderCredential(...a),
}));

// U13.1 — the shared sandbox seam. Mocked so these tests assert ROUTING
// (extraction-cli.ts calls this, with what args) without exercising the real
// acquire/execute/release machinery (covered by one-shot-sandbox-cli.test.ts).
const mockRunOneShotCliInSandbox = vi.fn();
vi.mock("../services/one-shot-sandbox-cli.js", () => {
  // Defined INSIDE the (hoisted) factory — vi.mock factories may not close
  // over top-level bindings declared below the call (extraction.test.ts uses
  // the same pattern for its FakeCliExtractionError).
  class FakeOneShotSandboxError extends Error {
    readonly kind: string;
    readonly exitCode: number | null;
    readonly stderr: string;
    constructor(message: string, kind: string, exitCode: number | null = null, stderr = "") {
      super(message);
      this.name = "OneShotSandboxError";
      this.kind = kind;
      this.exitCode = exitCode;
      this.stderr = stderr;
    }
  }
  return {
    runOneShotCliInSandbox: (...a: unknown[]) => mockRunOneShotCliInSandbox(...a),
    OneShotSandboxError: FakeOneShotSandboxError,
  };
});

// Spy on buildScrubbedCliEnv (keep the REAL implementation) so the desktop
// test can prove the KEEP-list spawn still happens, and the cloud tests can
// prove it is NEVER reached (the sandbox path builds its env entirely inside
// the mocked runOneShotCliInSandbox above — this module never calls it).
const mockBuildScrubbedCliEnv = vi.fn();
vi.mock("../services/cli-spawn-safety.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/cli-spawn-safety.js")>();
  return {
    ...actual,
    buildScrubbedCliEnv: (...a: Parameters<typeof actual.buildScrubbedCliEnv>) => {
      mockBuildScrubbedCliEnv(...a);
      return actual.buildScrubbedCliEnv(...a);
    },
  };
});

// ── node:child_process spawn mock (desktop path only) ───────────────────────
// Trimmed version of extraction-cli.test.ts's harness — just enough to drive
// the claude one-shot spawn to a clean exit for the "desktop unchanged" case.
interface SpawnCall {
  command: string;
  args: string[];
  options: Record<string, unknown> | undefined;
}
let nextSpawnStdout = "[]";
const spawnCalls: SpawnCall[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args: string[], options?: Record<string, unknown>) => {
      spawnCalls.push({ command, args, options });
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: EventEmitter & { writable: boolean; write: (s: string) => void; end: () => void };
        kill: (sig?: string) => void;
        exitCode: number | null;
        signalCode: string | null;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn();
      const stdin = new EventEmitter() as EventEmitter & {
        writable: boolean;
        write: (s: string) => void;
        end: () => void;
      };
      stdin.writable = true;
      stdin.write = () => {};
      stdin.end = () => {};
      child.stdin = stdin;
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(nextSpawnStdout));
        child.exitCode = 0;
        child.emit("close", 0);
      });
      return child;
    }),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(async () => {}), rm: vi.fn(async () => {}) };
});

import { extractionService } from "../services/extraction.js";
import type { OneShotSandboxHandle } from "../services/one-shot-sandbox-cli.js";

function createMockEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry-1",
    discussionId: "disc-1",
    rawContent: "We need to build a user onboarding flow this sprint.",
    inputType: "paste",
    extractionStatus: "pending",
    extractionRunId: null,
    ...overrides,
  };
}

function createMockDiscussion() {
  return { id: "disc-1", companyId: "company-1", title: "Planning" };
}

/** Mirrors extraction-cli-path.test.ts's createMockDb — a sequence-queue DB
 *  double that drives extractFromDiscussionEntry's fixed read/write order. */
function createMockDb() {
  const selectQueue: any[][] = [];
  const capturedInserts: Array<{ table: string; values: any }> = [];
  const capturedUpdates: Array<{ table: string; set: any }> = [];

  const db = {
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: vi.fn((fn: (rows: any[]) => any) => Promise.resolve(fn(selectQueue.shift() ?? []))),
    })),
    insert: vi.fn((table: any) => ({
      values: vi.fn((values: any) => {
        capturedInserts.push({ table: table?._?.name ?? "unknown", values });
        return {
          returning: vi.fn().mockReturnThis(),
          then: vi.fn((fn: (rows: any[]) => any) =>
            Promise.resolve(
              fn(
                Array.isArray(values)
                  ? values.map((v: any, i: number) => ({ id: `gen-${i}`, ...v }))
                  : [{ id: "run-1", ...values }],
              ),
            ),
          ),
        };
      }),
    })),
    update: vi.fn((table: any) => ({
      set: vi.fn((setData: any) => {
        capturedUpdates.push({ table: table?._?.name ?? "unknown", set: setData });
        return {
          where: vi.fn().mockReturnThis(),
          catch: vi.fn().mockReturnThis(),
          returning: vi.fn(() => Promise.resolve([{ id: "claimed", extractionStatus: "processing" }])),
          then: vi.fn((fn?: (rows: any[]) => any) => Promise.resolve(fn ? fn([]) : undefined)),
        };
      }),
    })),
    transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn(db)),
  };

  return { db, selectQueue, capturedInserts, capturedUpdates };
}

function pushStandardSelectQueue(selectQueue: any[][]) {
  // Order: 1) entry, 2) discussion, 3) agentConfig, 4) previous entries, 5) departments.
  selectQueue.push(
    [createMockEntry()],
    [createMockDiscussion()],
    [{ id: "cfg-1", companyId: "company-1", cliTool: "claude", model: null }],
    [],
    [],
  );
}

const FAKE_CREDENTIAL = {
  envName: "ANTHROPIC_API_KEY",
  value: "sk-co-secret",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};

beforeEach(() => {
  vi.clearAllMocks();
  nextSpawnStdout = "[]";
  spawnCalls.length = 0;
  mockResolveCompanyProviderCredential.mockResolvedValue(FAKE_CREDENTIAL);
  mockRunOneShotCliInSandbox.mockResolvedValue({
    stdout: JSON.stringify([{ type: "task", title: "Build onboarding flow" }]),
    stderr: "",
    exitCode: 0,
    durationMs: 5,
  });
});

afterEach(() => {
  setDeploymentMode("local_trusted");
});

describe("extractFromDiscussionEntry — sandbox routing (U13.2)", () => {
  it("cloud + resolved credential: routes extractViaCli through runOneShotCliInSandbox with the company credential/companyId, never buildScrubbedCliEnv", async () => {
    setDeploymentMode("cloud_auth");
    const { db, selectQueue, capturedInserts } = createMockDb();
    pushStandardSelectQueue(selectQueue);

    await extractionService(db as any).extractFromDiscussionEntry("company-1", "entry-1");

    // Credential resolution reached with the right company + cliTool.
    expect(mockResolveCompanyProviderCredential).toHaveBeenCalledWith(db, "company-1", {
      cliTool: "claude",
    });

    // Routed through the sandbox exactly once, with the company's own
    // companyId/cliTool (env is built INSIDE runOneShotCliInSandbox from the
    // resolved credential — see one-shot-sandbox-cli.test.ts for that proof).
    expect(mockRunOneShotCliInSandbox).toHaveBeenCalledTimes(1);
    const [sandboxInput] = mockRunOneShotCliInSandbox.mock.calls[0];
    expect(sandboxInput.companyId).toBe("company-1");
    expect(sandboxInput.cliTool).toBe("claude");
    expect(sandboxInput.db).toBe(db);
    expect(sandboxInput.sandboxHandle).toBeUndefined(); // self-acquires (no batch handle yet — U13.3)

    // NEVER the desktop KEEP-list spawn — no operator/local credential
    // (CLAUDE_CODE_OAUTH_TOKEN, host-ambient ANTHROPIC_API_KEY) can leak in.
    expect(mockBuildScrubbedCliEnv).not.toHaveBeenCalled();
    expect(spawnCalls).toHaveLength(0);

    // Extraction actually completed using the sandbox's parsed output.
    const itemInserts = capturedInserts.filter((i) => i.table === "discussion_extracted_items");
    expect(itemInserts).toHaveLength(1);
    expect(itemInserts[0].values[0].title).toBe("Build onboarding flow");
  });

  it("sandboxHandle param: when supplied, is forwarded verbatim to runOneShotCliInSandbox (batch reuse, inert until U13.3 supplies one)", async () => {
    setDeploymentMode("cloud_auth");
    const { db, selectQueue } = createMockDb();
    pushStandardSelectQueue(selectQueue);

    const handle: OneShotSandboxHandle = {
      environment: { id: "env-1", companyId: "company-1", driver: "sandbox", config: {} } as any,
      lease: { id: "lease-1", provider: "e2b", providerLeaseId: "plid-1" } as any,
      providerConfig: { provider: "e2b" },
    };

    await extractionService(db as any).extractFromDiscussionEntry("company-1", "entry-1", handle);

    expect(mockRunOneShotCliInSandbox).toHaveBeenCalledTimes(1);
    const [sandboxInput] = mockRunOneShotCliInSandbox.mock.calls[0];
    expect(sandboxInput.sandboxHandle).toBe(handle);
  });

  it("desktop (tenantIsolationEnforced=false): extractViaCli still spawns locally via buildScrubbedCliEnv's KEEP-list; sandbox helper never called", async () => {
    setDeploymentMode("local_trusted");
    nextSpawnStdout = JSON.stringify([{ type: "task", title: "Build onboarding flow" }]);
    const { db, selectQueue, capturedInserts } = createMockDb();
    pushStandardSelectQueue(selectQueue);

    await extractionService(db as any).extractFromDiscussionEntry("company-1", "entry-1");

    expect(mockRunOneShotCliInSandbox).not.toHaveBeenCalled();
    expect(mockResolveCompanyProviderCredential).not.toHaveBeenCalled();

    expect(mockBuildScrubbedCliEnv).toHaveBeenCalledWith(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
    const call = spawnCalls.find((c) => c.command === "claude");
    expect(call).toBeDefined();

    const itemInserts = capturedInserts.filter((i) => i.table === "discussion_extracted_items");
    expect(itemInserts).toHaveLength(1);
  });
});
