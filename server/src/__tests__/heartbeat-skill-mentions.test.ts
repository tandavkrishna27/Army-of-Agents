/**
 * Unit tests for the run-scoped mentioned-skill pure helpers introduced in
 * Task 17 of the upstream Paperclip resync (2026-04-26).
 *
 * extractMentionedSkillIdsFromSources and applyRunScopedMentionedSkillKeys
 * are exported from heartbeat.ts as pure functions with no DB dependencies,
 * so they can be imported directly without wiring up the full service.
 */

import { vi } from "vitest";

// ── Mocks required because heartbeat.ts has top-level DB + drizzle imports ──

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
    companySkills: makeTable(),
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
    {
      get: (_t: unknown, prop: string | symbol) =>
        prop === "apply" ? () => ({ as: () => "sql" }) : () => ({ as: () => "sql" }),
      apply: () => ({ as: () => "sql" }),
    },
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
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { describe, expect, it } from "vitest";
import {
  extractMentionedSkillIdsFromSources,
  applyRunScopedMentionedSkillKeys,
} from "../services/heartbeat.js";

// ────────────────────────────────────────────────────────────────────────────

describe("auto-enable mentioned skills", () => {
  describe("extractMentionedSkillIdsFromSources", () => {
    it("extracts a single skill ID from a description", () => {
      const ids = extractMentionedSkillIdsFromSources([
        "Use [deploy-prod](skill://abc-123)",
      ]);
      expect(ids).toContain("abc-123");
    });

    it("extracts skill IDs from multiple sources and deduplicates", () => {
      const ids = extractMentionedSkillIdsFromSources([
        "Title referencing [qa](skill://abc-123)",
        "Description also mentions [qa](skill://abc-123) and [lint](skill://def-456)",
        "Comment: use [lint](skill://def-456) please",
      ]);
      expect(ids.sort()).toEqual(["abc-123", "def-456"]);
    });

    it("ignores null and undefined sources", () => {
      const ids = extractMentionedSkillIdsFromSources([null, undefined, "No skill links here"]);
      expect(ids).toEqual([]);
    });

    it("returns an empty array when no skill mentions are present", () => {
      const ids = extractMentionedSkillIdsFromSources([
        "This issue has no skill mentions",
        "Just plain text here",
      ]);
      expect(ids).toEqual([]);
    });

    it("handles an empty sources array", () => {
      expect(extractMentionedSkillIdsFromSources([])).toEqual([]);
    });
  });

  describe("applyRunScopedMentionedSkillKeys", () => {
    it("adds skill keys to an empty config", () => {
      const result = applyRunScopedMentionedSkillKeys({}, ["deploy-prod", "qa-agent"]);
      const aoa = result.aoaSkillSync as Record<string, unknown>;
      expect(aoa.desiredSkills).toEqual(["deploy-prod", "qa-agent"]);
    });

    it("merges new keys with existing aoaSkillSync.desiredSkills (deduped)", () => {
      const config = { aoaSkillSync: { desiredSkills: ["existing-skill"] } };
      const result = applyRunScopedMentionedSkillKeys(config, ["existing-skill", "new-skill"]);
      const aoa = result.aoaSkillSync as Record<string, unknown>;
      const desired = aoa.desiredSkills as string[];
      expect(desired).toContain("existing-skill");
      expect(desired).toContain("new-skill");
      expect(desired.filter((k) => k === "existing-skill")).toHaveLength(1);
    });

    it("dual-writes paperclipSkillSync equal to aoaSkillSync for back-compat", () => {
      const result = applyRunScopedMentionedSkillKeys({}, ["x", "y"]);
      expect(result.paperclipSkillSync).toBeDefined();
      expect(result.paperclipSkillSync).toEqual(result.aoaSkillSync);
    });

    it("returns the config unchanged when skillKeys is empty", () => {
      const config = { aoaSkillSync: { desiredSkills: ["keep-me"] } };
      const result = applyRunScopedMentionedSkillKeys(config, []);
      expect(result).toBe(config);
    });

    it("merges with existing paperclipSkillSync back-compat data when aoaSkillSync is absent", () => {
      const config = { paperclipSkillSync: { desiredSkills: ["legacy-skill"] } };
      const result = applyRunScopedMentionedSkillKeys(config, ["new-skill"]);
      const aoa = result.aoaSkillSync as Record<string, unknown>;
      const desired = aoa.desiredSkills as string[];
      expect(desired).toContain("legacy-skill");
      expect(desired).toContain("new-skill");
    });

    it("does not modify config when no skill mentions present (integration smoke)", async () => {
      const config = { aoaSkillSync: { desiredSkills: ["original"] } };
      const result = applyRunScopedMentionedSkillKeys(config, []);
      expect(result).toBe(config);
      const aoa = config.aoaSkillSync as Record<string, unknown>;
      expect(aoa.desiredSkills).toEqual(["original"]);
    });
  });
});
