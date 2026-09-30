import { describe, expect, it } from "vitest";

import {
  TERMINAL_RUN_STATUSES,
  isTerminalRunStatus,
  resolveTerminalLatchFallback,
} from "../services/heartbeat.js";

/**
 * R1 zombie-run teardown — terminal-status latch (setRunStatus).
 *
 * When a run is already terminal, the guarded conditional UPDATE in setRunStatus
 * matches no row and falls back to resolveTerminalLatchFallback, which decides
 * what write to apply WITHOUT ever touching status. These tests pin the two
 * load-bearing behaviors:
 *   1. A zombie markRunWaiting/clearRunWaiting write (requested 'running') on a
 *      cancelled run does NOT flip status — the run stays terminal (block).
 *   2. The legitimate cancelled→cancelled metadata writes at the completion
 *      (:4307) and error (:4513) paths STILL persist usageJson / log excerpts
 *      (P2-1) — the fallback strips only `status`, keeping every other field.
 */
describe("terminal-run status constants", () => {
  it("marks exactly the four heartbeat terminal statuses as terminal", () => {
    expect([...TERMINAL_RUN_STATUSES].sort()).toEqual(
      ["cancelled", "failed", "succeeded", "timed_out"],
    );
    for (const s of TERMINAL_RUN_STATUSES) expect(isTerminalRunStatus(s)).toBe(true);
    for (const s of ["running", "queued", "waiting", "pending"]) {
      expect(isTerminalRunStatus(s)).toBe(false);
    }
  });
});

describe("resolveTerminalLatchFallback (setRunStatus latch)", () => {
  it("blocks a zombie cancelled→running write: strips status, keeps only metadata (no publish)", () => {
    // This is exactly the markRunWaiting shape (setRunStatus(runId,'running',{...}))
    // hitting an already-cancelled run via a zombie hook POST.
    const result = resolveTerminalLatchFallback({
      status: "running",
      livenessState: "waiting_on_human",
      livenessReason: "runtime_decision",
      nextAction: "runtime_decision:dec-1",
    });

    expect(result.action).toBe("metadata");
    if (result.action !== "metadata") throw new Error("unreachable");
    // status is NEVER written back on a terminal row → no resurrection.
    expect(result.metadataPatch).not.toHaveProperty("status");
    // The non-status fields are preserved (harmless writes on a dead run); the
    // KEY guarantee is that status is not among them.
    expect(result.metadataPatch).toMatchObject({
      livenessState: "waiting_on_human",
      livenessReason: "runtime_decision",
    });
  });

  it("P2-1: preserves the cancelled→cancelled completion metadata (usageJson + excerpts + log fields)", () => {
    // Mirrors the completion write at heartbeat.ts:4307 in the cancel race —
    // status equals the current terminal status, but usageJson/excerpts MUST
    // still land on the row.
    const usageJson = { costUsd: 0.42, inputTokens: 1200, billingType: "subscription" };
    const result = resolveTerminalLatchFallback({
      status: "cancelled",
      finishedAt: new Date("2026-07-04T00:00:00.000Z"),
      usageJson,
      stdoutExcerpt: "partial stdout before cancel",
      stderrExcerpt: "partial stderr before cancel",
      logBytes: 4096,
      logSha256: "abc123",
      logCompressed: false,
    });

    expect(result.action).toBe("metadata");
    if (result.action !== "metadata") throw new Error("unreachable");
    expect(result.metadataPatch).not.toHaveProperty("status");
    expect(result.metadataPatch.usageJson).toEqual(usageJson);
    expect(result.metadataPatch.stdoutExcerpt).toBe("partial stdout before cancel");
    expect(result.metadataPatch.stderrExcerpt).toBe("partial stderr before cancel");
    expect(result.metadataPatch.logBytes).toBe(4096);
    expect(result.metadataPatch.logSha256).toBe("abc123");
  });

  it("P2-1: preserves the cancelled→cancelled error-path metadata (error + excerpts)", () => {
    // Mirrors the error/catch write at heartbeat.ts:4513 (RuntimeDecisionCancelled
    // → terminalStatus 'cancelled') during the race.
    const result = resolveTerminalLatchFallback({
      status: "cancelled",
      error: "run ended",
      errorCode: "cancelled",
      finishedAt: new Date(),
      stdoutExcerpt: "stdout",
      stderrExcerpt: "stderr",
      logBytes: 10,
    });

    expect(result.action).toBe("metadata");
    if (result.action !== "metadata") throw new Error("unreachable");
    expect(result.metadataPatch).not.toHaveProperty("status");
    expect(result.metadataPatch.error).toBe("run ended");
    expect(result.metadataPatch.errorCode).toBe("cancelled");
    expect(result.metadataPatch.stdoutExcerpt).toBe("stdout");
  });

  it("drops contradictory terminal metadata while preserving neutral run artifacts", () => {
    const result = resolveTerminalLatchFallback(
      {
        status: "cancelled",
        error: "cancelled after success",
        errorCode: "cancelled",
        finishedAt: new Date("2026-07-05T00:00:00.000Z"),
        usageJson: { costUsd: 0.12 },
        stdoutExcerpt: "final stdout",
        stderrExcerpt: "final stderr",
        logBytes: 123,
      },
      { requestedStatus: "cancelled", currentStatus: "succeeded" },
    );

    expect(result.action).toBe("metadata");
    if (result.action !== "metadata") throw new Error("unreachable");
    expect(result.metadataPatch).toEqual({
      usageJson: { costUsd: 0.12 },
      stdoutExcerpt: "final stdout",
      stderrExcerpt: "final stderr",
      logBytes: 123,
    });
  });

  it("is a no-op for a pure status flip against a terminal row (no metadata to persist)", () => {
    // clearRunWaiting on a live run passes the guard normally; but a bare status
    // flip with no other fields that reaches a terminal row has nothing to write.
    expect(resolveTerminalLatchFallback({ status: "running" }).action).toBe("noop");
    expect(resolveTerminalLatchFallback({ status: "cancelled" }).action).toBe("noop");
    expect(resolveTerminalLatchFallback(undefined).action).toBe("noop");
    expect(resolveTerminalLatchFallback({}).action).toBe("noop");
  });
});
