/** AoA repo-only workspace sentinel contract. */

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

describe("repo-only workspace sentinel", () => {
  it("recognizes the AoA sentinel", () => {
    expect(isRepoOnlySentinel("/__aoa_repo_only__")).toBe(true);
  });

  it("ignores ordinary and missing paths", () => {
    expect(isRepoOnlySentinel("/some/other/path")).toBe(false);
    expect(isRepoOnlySentinel(null)).toBe(false);
    expect(isRepoOnlySentinel(undefined)).toBe(false);
    expect(isRepoOnlySentinel("")).toBe(false);
  });
});
