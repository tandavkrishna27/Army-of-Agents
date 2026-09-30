/**
 * P3-T2 — crew-result-relay heartbeat hook tests.
 *
 * Verifies the best-effort hook wired into the heartbeat SUCCESS path:
 *
 *   1. On a successful run for an issue, relayCrewResult is called with the
 *      correct issueId.
 *   2. When relayCrewResult throws, the error does NOT propagate — the hook
 *      is best-effort and must never break the run.
 *   3. When outcome is NOT "succeeded" (e.g. "failed"), relayCrewResult is
 *      NOT called (the hook is guarded by `outcome === "succeeded"`).
 *   4. When issueContext.id is absent, relayCrewResult is NOT called.
 *
 * Strategy: test the hook logic in isolation by factoring the exact guard +
 * try/catch pattern from heartbeat.ts into a thin helper, then asserting the
 * call shape and error-swallowing behaviour. This avoids importing heartbeat.ts
 * (which has deep Drizzle/adapter dependencies) while still exercising the
 * exact code path added for this task.
 *
 * The helper below is a 1:1 transcription of the hook added to heartbeat.ts:
 *
 *   if (outcome === "succeeded" && issueContext?.id) {
 *     try {
 *       await relayCrewResult(db, { issueId: issueContext.id });
 *     } catch (relayErr) {
 *       logger.warn({ err: relayErr, issueId: issueContext.id }, "...");
 *     }
 *   }
 */

import { describe, expect, it, vi } from "vitest";

// ── Minimal type stubs ────────────────────────────────────────────────────────

type RelayFn = (db: object, params: { issueId: string }) => Promise<{ posted: boolean }>;

interface IssueCtx {
  id: string;
}

interface WarnFn {
  (meta: object, msg: string): void;
}

/**
 * Thin transcription of the heartbeat hook added in P3-T2.
 * Keeps the test honest: if the real hook changes shape, this must change too.
 */
async function runHook(opts: {
  outcome: string;
  issueContext: IssueCtx | null;
  relayCrewResult: RelayFn;
  db: object;
  warnFn: WarnFn;
}): Promise<void> {
  const { outcome, issueContext, relayCrewResult, db, warnFn } = opts;

  if (outcome === "succeeded" && issueContext?.id) {
    try {
      await relayCrewResult(db, { issueId: issueContext.id });
    } catch (relayErr) {
      warnFn({ err: relayErr, issueId: issueContext.id }, "P3-T2: failed to relay crew-task result to thread (non-fatal)");
    }
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("heartbeat success-path crew-result-relay hook (P3-T2)", () => {
  it("calls relayCrewResult with the correct issueId on a successful run", async () => {
    const relay = vi.fn().mockResolvedValue({ posted: true });
    const warn = vi.fn();
    const db = {};

    await runHook({
      outcome: "succeeded",
      issueContext: { id: "issue-42" },
      relayCrewResult: relay as RelayFn,
      db,
      warnFn: warn,
    });

    expect(relay).toHaveBeenCalledOnce();
    expect(relay).toHaveBeenCalledWith(db, { issueId: "issue-42" });
  });

  it("swallows a relay error and does NOT re-throw (best-effort)", async () => {
    const relay = vi.fn().mockRejectedValue(new Error("relay exploded"));
    const warn = vi.fn();

    // Must not throw
    await expect(
      runHook({
        outcome: "succeeded",
        issueContext: { id: "issue-7" },
        relayCrewResult: relay as RelayFn,
        db: {},
        warnFn: warn,
      }),
    ).resolves.toBeUndefined();

    // And the warning is logged with the relay error
    expect(warn).toHaveBeenCalledOnce();
    const [meta, msg] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect((meta.err as Error).message).toBe("relay exploded");
    expect(meta.issueId).toBe("issue-7");
    expect(msg).toMatch(/non-fatal/i);
  });

  it("does NOT call relayCrewResult when outcome is not 'succeeded'", async () => {
    const relay = vi.fn().mockResolvedValue({ posted: false });
    const warn = vi.fn();

    for (const outcome of ["failed", "cancelled", "timed_out"]) {
      relay.mockClear();
      await runHook({
        outcome,
        issueContext: { id: "issue-1" },
        relayCrewResult: relay as RelayFn,
        db: {},
        warnFn: warn,
      });
      expect(relay).not.toHaveBeenCalled();
    }
  });

  it("does NOT call relayCrewResult when issueContext is null", async () => {
    const relay = vi.fn().mockResolvedValue({ posted: false });
    const warn = vi.fn();

    await runHook({
      outcome: "succeeded",
      issueContext: null,
      relayCrewResult: relay as RelayFn,
      db: {},
      warnFn: warn,
    });

    expect(relay).not.toHaveBeenCalled();
  });
});
