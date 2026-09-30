// T1.0 — runner-dispatcher failure contract. Pure-function tests for
// buildAoaRunResultFromAdapter, which translates AdapterExecutionResult
// (what CLI adapters return) into AoaRunResult (what the dispatcher
// needs to set wakeup status + persist cost/usage).
//
// Codex outside-voice (findings #1, #2, #3) caught that runner.ts was
// returning void and the dispatcher was inferring success from the
// absence of a thrown exception — silently marking every wakeup
// 'succeeded' even when the adapter reported a non-zero exitCode or
// errorMessage. These tests pin the result-building decision so a future
// edit can't quietly revert that.

import { describe, expect, it } from "vitest";
import { buildAoaRunResultFromAdapter } from "../services/internal-agent/aoa-agents/aoa-run-result.js";

describe("buildAoaRunResultFromAdapter (T1.0)", () => {
  it("succeeds when exitCode=0, no errorMessage, no cost", () => {
    expect(buildAoaRunResultFromAdapter({ exitCode: 0 })).toEqual({
      status: "succeeded",
      errorMessage: undefined,
      costCents: null,
      usage: undefined,
    });
  });

  it("succeeds and captures usage + costCents (USD → cents conversion)", () => {
    const result = buildAoaRunResultFromAdapter({
      exitCode: 0,
      costUsd: 0.0512,
      usage: { inputTokens: 1500, outputTokens: 800, cachedInputTokens: 200 },
    });
    expect(result.status).toBe("succeeded");
    expect(result.costCents).toBe(5); // 0.0512 USD → 5 cents (rounded)
    expect(result.usage).toEqual({ inputTokens: 1500, outputTokens: 800, cachedInputTokens: 200 });
    expect(result.errorMessage).toBeUndefined();
  });

  it("rounds costUsd correctly at floating-point edge cases", () => {
    // 0.005 USD is exactly half a cent; Math.round rounds half to even
    // in some impls but JS's Math.round always rounds half up (0.5 → 1).
    expect(buildAoaRunResultFromAdapter({ exitCode: 0, costUsd: 0.005 }).costCents).toBe(1);
    // 0.014 should round down to 1 cent
    expect(buildAoaRunResultFromAdapter({ exitCode: 0, costUsd: 0.014 }).costCents).toBe(1);
    // 0.016 should round up to 2 cents
    expect(buildAoaRunResultFromAdapter({ exitCode: 0, costUsd: 0.016 }).costCents).toBe(2);
    // null/undefined cost → null costCents (graceful, not 0)
    expect(buildAoaRunResultFromAdapter({ exitCode: 0 }).costCents).toBeNull();
    expect(buildAoaRunResultFromAdapter({ exitCode: 0, costUsd: null }).costCents).toBeNull();
  });

  it("fails when exitCode is non-zero (e.g. CLI crashed)", () => {
    const result = buildAoaRunResultFromAdapter({ exitCode: 1 });
    expect(result.status).toBe("failed");
    // No errorMessage from adapter → synthesize one from exit code so the
    // dispatcher / operator have SOMETHING to display
    expect(result.errorMessage).toBe("exit 1");
  });

  it("fails when adapter reports errorMessage (even with exitCode=0)", () => {
    // Adapters can surface a recoverable-looking exit with errorMessage,
    // e.g. claude CLI returning {exitCode:0, errorMessage:'rate limited'}.
    // The error string is the source of truth; status='failed'.
    const result = buildAoaRunResultFromAdapter({
      exitCode: 0,
      errorMessage: "rate limited",
    });
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("rate limited");
  });

  it("fails with non-zero exit AND errorMessage — prefers errorMessage", () => {
    const result = buildAoaRunResultFromAdapter({
      exitCode: 1,
      errorMessage: "API key invalid",
    });
    expect(result.status).toBe("failed");
    // errorMessage is more informative than synthesized "exit 1"
    expect(result.errorMessage).toBe("API key invalid");
  });

  it("treats exitCode=null as succeeded (some adapters never set exitCode)", () => {
    // adapter-utils types allow exitCode: null. Process didn't exit normally
    // OR adapter doesn't model it (e.g. in-process providers). Without an
    // errorMessage we have no signal to call this failed — default to success.
    const result = buildAoaRunResultFromAdapter({ exitCode: null });
    expect(result.status).toBe("succeeded");
  });

  it("captures cost even when adapter reports failure (run still cost money)", () => {
    // Failing claude run that DID consume tokens before failing — we still
    // need to record the cost so cost_events + rate-brake see it.
    const result = buildAoaRunResultFromAdapter({
      exitCode: 1,
      errorMessage: "context length exceeded",
      costUsd: 0.12,
      usage: { inputTokens: 5000, outputTokens: 0 },
    });
    expect(result.status).toBe("failed");
    expect(result.costCents).toBe(12);
    expect(result.usage?.inputTokens).toBe(5000);
  });
});
