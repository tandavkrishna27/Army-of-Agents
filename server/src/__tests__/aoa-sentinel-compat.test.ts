/**
 * Phase 5a compatibility tests: dual-read of legacy paperclip-named
 * DB sentinels alongside the new AoA-named ones.
 *
 * isRepoOnlySentinel is imported directly from heartbeat.ts (it is
 * exported as a pure function with no DB dependencies).
 *
 * The DEFERRED_WAKE_CONTEXT_KEY dual-read pattern is tested via an
 * inline lambda that replicates the read expression used in
 * heartbeat.ts (`ctx[NEW] ?? ctx[LEGACY]`).  This avoids pulling in
 * the full heartbeat service mock chain while still verifying the
 * correctness of the dual-read logic.
 */

import { describe, expect, it } from "vitest";

// --- isRepoOnlySentinel ---
// Vitest resolves .ts/.js imports; the mock chain is not needed here
// because isRepoOnlySentinel has no DB dependencies.
vi.mock("@armyofagents/db", () => {
  const makeTable = () =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "$inferSelect" || prop === "$inferInsert" ? {} : Symbol(String(prop)),
      },
    );
  return {
    agents: makeTable(),
    agentRuntimeState: makeTable(),
    agentTaskSessions: makeTable(),
    agentWakeupRequests: makeTable(),
    heartbeatRunEvents: makeTable(),
    heartbeatRuns: makeTable(),
    costEvents: makeTable(),
    issues: makeTable(),
    projectWorkspaces: makeTable(),
    memoryItems: makeTable(),
    companies: makeTable(),
    taskDependencies: makeTable(),
    issueAttachments: makeTable(),
    issueComments: makeTable(),
    assets: makeTable(),
    projects: makeTable(),
    // Required by services/embeddings.ts (B1: createEmbeddingService target map)
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
  or: (..._args: unknown[]) => "or",
  sql: new Proxy(
    Object.assign(() => ({ as: () => "sql" }), { raw: () => ({ as: () => "sql" }) }),
    { get: (_t: unknown, prop: string | symbol) => prop === "apply" ? (() => ({ as: () => "sql" })) : () => ({ as: () => "sql" }), apply: () => ({ as: () => "sql" }) },
  ),
}));

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../services/run-log-store.js", () => ({ getRunLogStore: vi.fn() }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(),
  runningProcesses: new Map(),
}));
vi.mock("../agent-auth-jwt.js", () => ({ createLocalAgentJwt: vi.fn() }));
vi.mock("../adapters/utils.js", () => ({
  parseObject: vi.fn((v: unknown) => (v != null && typeof v === "object" ? v : {})),
  asBoolean: vi.fn(),
  asNumber: vi.fn(),
  appendWithCap: vi.fn(),
  MAX_EXCERPT_BYTES: 1024,
}));
vi.mock("../adapters/api-common.js", () => ({ setSecretResolver: vi.fn() }));
vi.mock("../services/secrets.js", () => ({ secretService: vi.fn(() => ({})) }));
vi.mock("../services/output-detection.js", () => ({
  outputDetectionService: vi.fn(() => ({})),
}));
vi.mock("../services/run-summary.js", () => ({ formatRunSummary: vi.fn() }));
vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

import { vi } from "vitest";
import { isRepoOnlySentinel } from "../services/heartbeat.js";

// ────────────────────────────────────────────────────────────────────────────
// Inline dual-read helper that mirrors the pattern used in heartbeat.ts:
//   ctx?.[DEFERRED_WAKE_CONTEXT_KEY] ?? ctx?.[LEGACY_DEFERRED_WAKE_CONTEXT_KEY]
// ────────────────────────────────────────────────────────────────────────────
const NEW_KEY = "_aoaWakeContext";
const LEGACY_KEY = "_paperclipWakeContext";

function readDeferredWakeContext(ctx: Record<string, unknown> | null | undefined): unknown {
  return ctx?.[NEW_KEY] ?? ctx?.[LEGACY_KEY];
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("aoa-sentinel-compat", () => {
  describe("deferred wake context dual-read", () => {
    it("reads legacy _paperclipWakeContext key", () => {
      const payload = { data: "from-paperclip" };
      const ctx = { [LEGACY_KEY]: payload };
      expect(readDeferredWakeContext(ctx)).toBe(payload);
    });

    it("reads AoA _aoaWakeContext key", () => {
      const payload = { data: "from-aoa" };
      const ctx = { [NEW_KEY]: payload };
      expect(readDeferredWakeContext(ctx)).toBe(payload);
    });

    it("prefers AoA key when both keys are present", () => {
      const ctx = { [NEW_KEY]: "new", [LEGACY_KEY]: "old" };
      expect(readDeferredWakeContext(ctx)).toBe("new");
    });
  });

  describe("isRepoOnlySentinel", () => {
    it("returns true for the legacy /__paperclip_repo_only__ sentinel", () => {
      expect(isRepoOnlySentinel("/__paperclip_repo_only__")).toBe(true);
    });

    it("returns true for the new /__aoa_repo_only__ sentinel", () => {
      expect(isRepoOnlySentinel("/__aoa_repo_only__")).toBe(true);
    });

    it("returns false for arbitrary paths", () => {
      expect(isRepoOnlySentinel("/some/other/path")).toBe(false);
    });

    it("returns false for null", () => {
      expect(isRepoOnlySentinel(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isRepoOnlySentinel(undefined)).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isRepoOnlySentinel("")).toBe(false);
    });
  });
});
