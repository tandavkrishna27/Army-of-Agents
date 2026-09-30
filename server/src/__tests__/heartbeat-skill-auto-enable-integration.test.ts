/**
 * Integration test for the skill auto-enable flow introduced in T17 of the
 * upstream Paperclip → AoA resync (2026-04-26).
 *
 * Phase B audit found that existing tests in heartbeat-skill-mentions.test.ts
 * and adapter-utils-skills.test.ts cover each individual function in isolation
 * but no test exercises the FULL flow: extraction → merge with pre-existing
 * skill keys → dual-write of paperclipSkillSync → back-compat read.
 *
 * Mutation-tested: dropping the existing keys in applyRunScopedMentionedSkillKeys
 * (changing merge to just skillKeys) fails test 3 — "pre-existing" goes missing.
 *
 * Refs: docs/superpowers/plans/2026-04-27-resync-verification.md (Task 3)
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
import { readAoaSkillSyncPreference } from "@armyofagents/adapter-utils/server-utils";

// ────────────────────────────────────────────────────────────────────────────

describe("Skill auto-enable — full extraction → merge integration", () => {
  it("extracts skill IDs from issue title + description + comments", () => {
    const sources = [
      "Use [deploy-prod](skill://abc-123) for the deploy",
      "Background: this depends on [data-prep](skill://def-456) too",
      null,
      "Comment: please also use [audit](skill://abc-123) (dup ID)",
    ];
    const ids = extractMentionedSkillIdsFromSources(sources);
    expect(ids.sort()).toEqual(["abc-123", "def-456"]);
  });

  it("returns empty when no skill mentions exist", () => {
    const ids = extractMentionedSkillIdsFromSources(["just a regular comment", "no links here"]);
    expect(ids).toEqual([]);
  });

  it("merges new skill keys into existing aoaSkillSync.desiredSkills", () => {
    const startingConfig = {
      aoaSkillSync: { mode: "explicit", desiredSkills: ["pre-existing"] },
    };
    const merged = applyRunScopedMentionedSkillKeys(startingConfig as any, [
      "new-skill-1",
      "new-skill-2",
    ]);
    const pref = readAoaSkillSyncPreference(merged as Record<string, unknown>);
    expect(pref.desiredSkills.sort()).toEqual(["new-skill-1", "new-skill-2", "pre-existing"]);
  });

  it("dual-writes paperclipSkillSync for back-compat", () => {
    const out = applyRunScopedMentionedSkillKeys({} as any, ["x", "y"]);
    expect((out as any).aoaSkillSync).toBeDefined();
    expect((out as any).paperclipSkillSync).toBeDefined();
    expect((out as any).paperclipSkillSync).toEqual((out as any).aoaSkillSync);
  });

  it("is a no-op when skillKeys array is empty", () => {
    const startingConfig = { aoaSkillSync: { mode: "explicit", desiredSkills: ["existing"] } };
    const merged = applyRunScopedMentionedSkillKeys(startingConfig as any, []);
    expect(merged).toEqual(startingConfig);
  });

  it("reads back compat field paperclipSkillSync when aoaSkillSync absent", () => {
    const config = { paperclipSkillSync: { mode: "explicit", desiredSkills: ["legacy"] } };
    const pref = readAoaSkillSyncPreference(config as Record<string, unknown>);
    expect(pref.desiredSkills).toContain("legacy");
  });
});
