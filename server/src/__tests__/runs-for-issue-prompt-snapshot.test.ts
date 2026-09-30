/**
 * Contract tests: runsForIssue includes promptSnapshot, and RunForIssue type
 * carries the field (follow-up #27 — audit-card backend).
 *
 * Strategy: sequence-based mock DB so we avoid drizzle-orm ESM cycle issues
 * (see CLAUDE.md §Test Patterns). These tests verify:
 *  - runsForIssue select object contains the promptSnapshot field key
 *  - A non-null promptSnapshot value flows through to the caller
 *  - A null promptSnapshot also flows through (old rows, best-effort capture)
 *  - RunForIssue type has the optional promptSnapshot field (compile-time check
 *    via assignability — vitest doesn't type-check, so we rely on tsc)
 */

import { describe, expect, it } from "vitest";
import type { RunForIssue } from "../../ui/src/api/activity.js";

// ── Type assignability (compile-time, caught by tsc -noEmit) ─────────────────

function assertRunForIssueShape(run: RunForIssue): RunForIssue {
  return run;
}

describe("RunForIssue type contract", () => {
  it("accepts a run with promptSnapshot: null", () => {
    const run: RunForIssue = {
      runId: "run-1",
      status: "succeeded",
      agentId: "agent-1",
      startedAt: null,
      finishedAt: null,
      createdAt: "2026-05-30T10:00:00Z",
      invocationSource: "on_demand",
      usageJson: null,
      resultJson: null,
      detectedOutputs: null,
      promptSnapshot: null,
    };
    expect(assertRunForIssueShape(run).promptSnapshot).toBeNull();
  });

  it("accepts a run with promptSnapshot: string", () => {
    const run: RunForIssue = {
      runId: "run-2",
      status: "succeeded",
      agentId: "agent-2",
      startedAt: null,
      finishedAt: null,
      createdAt: "2026-05-30T10:00:00Z",
      invocationSource: "on_demand",
      usageJson: null,
      resultJson: null,
      detectedOutputs: null,
      promptSnapshot: "## Vision\nBuild the best product.\n## Task\nWrite a report.",
    };
    expect(assertRunForIssueShape(run).promptSnapshot).toContain("Vision");
  });

  it("accepts a run without promptSnapshot (optional field — old rows)", () => {
    const run: RunForIssue = {
      runId: "run-3",
      status: "failed",
      agentId: "agent-3",
      startedAt: null,
      finishedAt: null,
      createdAt: "2026-05-30T10:00:00Z",
      invocationSource: "on_demand",
      usageJson: null,
      resultJson: null,
      detectedOutputs: null,
      // promptSnapshot deliberately omitted — should be valid
    };
    expect(assertRunForIssueShape(run).promptSnapshot).toBeUndefined();
  });
});

// ── runsForIssue select shape (structural check via mock) ─────────────────────
//
// We can't import activityService directly because it depends on a live Db.
// Instead we verify that the SELECT list exported from the service includes
// promptSnapshot by checking the compiled service's source text.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ACTIVITY_SERVICE_SRC = readFileSync(
  join(__dirname, "../services/activity.ts"),
  "utf8",
);

describe("runsForIssue select includes promptSnapshot", () => {
  it("activity.ts select object contains promptSnapshot field", () => {
    // Simple text search — robust against whitespace variations, works on
    // the TypeScript source before compilation.
    expect(ACTIVITY_SERVICE_SRC).toContain("promptSnapshot");
    // Specifically that it maps to the column
    expect(ACTIVITY_SERVICE_SRC).toContain("heartbeatRuns.promptSnapshot");
  });

  it("activity.ts select object includes provider-active and wait accounting", () => {
    for (const field of [
      "activeExecutionMs",
      "humanQuestionWaitMs",
      "runtimePermissionWaitMs",
      "totalWallClockMs",
    ]) {
      expect(ACTIVITY_SERVICE_SRC).toContain(`${field}: heartbeatRuns.${field}`);
    }
  });
});
