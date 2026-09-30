// CLI-006 (Task 3) — the suppression seam.
//
// This is the switch. Everything else in CLI-006 landed inert; this is the edit
// that makes a canary run's `adapter.execute` NOT happen, so it is the one place
// a double-execution defect can exist.
//
// `executeRun` is ~2,700 lines with a dependency surface that is impractical to
// unit-test — the standing CLI-003/005 limitation, recorded as Risk #2 in the
// design. So this file proves what CAN be proven in-process, at two levels:
//
//   1. The DECISION and the WRITE are pure functions, tested and mutation-checked.
//   2. The RETURN'S POSITION is asserted structurally against the source.
//
// (2) is not decoration. The `return` must sit INSIDE the inner `try`, because
// that try's `finally` is the only call site of `deregisterRuntimeHook` and of
// `heartbeatMcpDelivery.cleanup()`. Returning one line earlier — before `try {` —
// typechecks, passes every behavioural test, and silently leaks a 24-hour-valid
// runtime-permission token plus a tmpdir MCP config file that, for non-brokered
// `claude_local`, embeds DATABASE_URL. No TTL, no sweeper. A structural assertion
// is the only thing in this repo that catches that.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
  buildHandoffRunPatch,
  shouldSuppressLegacyExecution,
  type LegacyOwnerReason,
  type RunExecutionOwner,
} from "../services/run-execution-owner.js";

const JOB = "10b10b10-10b1-4b10-8b10-10b10b10b10b";
const ATTEMPT = "a77e3907-a77e-4a77-8a77-a77ea77ea77e";
const NOW = new Date("2026-08-19T10:00:00.000Z");

const distributed: RunExecutionOwner = { owner: "distributed", jobId: JOB, attemptId: ATTEMPT };

/**
 * Every member of `LegacyOwnerReason`, read out of the SOURCE the type is declared in.
 *
 * The union is a compile-time construct with no runtime residue, and this test file is never
 * compiled by CI (see the note in the exhaustiveness test). Reading the declaration is the only
 * way to make "the record covers the union" a fact a machine re-checks rather than a comment.
 * The parse is deliberately narrow — it takes the `export type LegacyOwnerReason =` block up to
 * its terminating semicolon and collects the quoted members — so a malformed match yields a
 * short list, which the anti-vacuity assertion rejects rather than silently passing.
 */
function declaredLegacyOwnerReasons(): string[] {
  const source = readFileSync(
    new URL("../services/run-execution-owner.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export type LegacyOwnerReason =");
  if (start < 0) throw new Error("LegacyOwnerReason declaration not found");
  const end = source.indexOf(";", start);
  if (end < 0) throw new Error("LegacyOwnerReason declaration is unterminated");
  const block = source.slice(start, end);
  return [...block.matchAll(/\|\s*"([a-z_]+)"/g)].map((match) => match[1]!);
}

describe("CLI-006/Task 3 — shouldSuppressLegacyExecution", () => {
  it("suppresses ONLY on a distributed owner", () => {
    expect(shouldSuppressLegacyExecution(distributed)).toBe(true);
  });

  it("does NOT suppress for any legacy reason — the fail-safe direction (Invariant 2)", () => {
    // Every short-circuit in the resolver (and, since Blocker A, the SEAM) produces one of
    // these. None may suppress: "neither executes" is a silently dropped run, which is worse
    // than a fallback.
    //
    // ★ This is a `Record<LegacyOwnerReason, true>` and NOT an `as const` array, deliberately.
    // The array form was value-level: adding a 6th reason (`workload_unavailable`) left this
    // test green while the new reason went entirely unexercised — a reason that suppressed
    // would have shipped silently. A Record is exhaustive at the TYPE level.
    //
    // ★★★ BUT THE TYPE LEVEL IS NOT CHECKED, AND THIS COMMENT USED TO CLAIM IT WAS.
    // `server/tsconfig.json` has `"exclude": ["src/__tests__"]`, and `pnpm -r typecheck` is
    // `tsc --noEmit` against exactly that config, so NOTHING in CI ever compiles this file.
    // Vitest has no `typecheck` project either. The promise that "a 7th reason is a compile
    // error here" was false the whole time — the [[checks-that-nothing-runs]] family, in the
    // guard written to prevent the value-level version of the same miss. Measured while adding
    // the 7th reason (`staging_unavailable`, CLI-008 Unit D), which is exactly the case it
    // promised to catch and would not have.
    //
    // So the exhaustiveness is checked at RUNTIME, against the SOURCE. Parsing the union out
    // of the module is not elegant; it is the only thing available to a test that is never
    // compiled, and it is the difference between a guard and a claim.
    const EVERY_LEGACY_REASON: Record<LegacyOwnerReason, true> = {
      rollout_not_canary: true,
      preflight_refused: true,
      convert_failed: true,
      placement_not_leasable: true,
      workload_unavailable: true,
      staging_unavailable: true,
      transfer_error: true,
    };
    const declared = declaredLegacyOwnerReasons();
    // Anti-vacuity: a parse that found nothing would make the comparison below trivially true.
    expect(declared.length).toBeGreaterThan(5);
    expect(Object.keys(EVERY_LEGACY_REASON).sort()).toEqual([...declared].sort());

    const reasons = Object.keys(EVERY_LEGACY_REASON) as LegacyOwnerReason[];
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      expect(shouldSuppressLegacyExecution({ owner: "legacy", reason }), reason).toBe(false);
    }
  });

  it("does NOT suppress when no decision was made at all", () => {
    // The overwhelmingly common case: a non-canary run never calls the resolver,
    // so the seam sees `undefined`. Absence must read as legacy — that is what
    // makes a partial deployment safe (D4).
    expect(shouldSuppressLegacyExecution(undefined)).toBe(false);
    expect(shouldSuppressLegacyExecution(null)).toBe(false);
  });
});

describe("CLI-006/Task 3 — buildHandoffRunPatch", () => {
  it("marks the run handed off with BOTH ids and the owner", () => {
    expect(buildHandoffRunPatch(distributed, NOW)).toEqual({
      executionOwner: "distributed",
      distributedJobId: JOB,
      distributedAttemptId: ATTEMPT,
      updatedAt: NOW,
    });
  });

  it("does NOT touch `status` — the attempt is the terminal authority now", () => {
    // Writing a terminal here would latch the run before the worker has even
    // leased it, and the projector's later terminal would be discarded.
    expect(Object.keys(buildHandoffRunPatch(distributed, NOW)).sort()).toEqual([
      "distributedAttemptId",
      "distributedJobId",
      "executionOwner",
      "updatedAt",
    ]);
  });

  it("refuses to build a handoff patch from a legacy decision", () => {
    // The marker is what every consumer — reaper, cancel writers, projector —
    // reads to learn the attempt owns this run. Writing it for a run the legacy
    // adapter is about to execute would strand that run permanently: the reaper
    // stands down, cancel routes to a job that will never terminalize, and
    // nothing ever finalizes it.
    expect(() =>
      buildHandoffRunPatch({ owner: "legacy", reason: "convert_failed" }, NOW),
    ).toThrow(/legacy/i);
  });
});

// -- the structural guard -----------------------------------------------------

const HEARTBEAT_SRC = readFileSync(
  fileURLToPath(new URL("../services/heartbeat.ts", import.meta.url)),
  "utf8",
).split(/\r?\n/);

const lineOf = (needle: string): number => {
  const idx = HEARTBEAT_SRC.findIndex((line) => line.includes(needle));
  expect(idx, `expected to find ${needle} in heartbeat.ts`).toBeGreaterThan(-1);
  return idx;
};

describe("CLI-006/Task 3 — the suppression return sits inside the adapter try", () => {
  it("returns AFTER `try {` and BEFORE `adapter.execute`", () => {
    const guard = lineOf("CLI-006-SUPPRESSION-RETURN");
    const exec = lineOf("adapterResult = await adapter.execute({");

    // The `try {` that owns the adapter call is the last one before it.
    const tryLine = HEARTBEAT_SRC.slice(0, exec)
      .map((line, i) => ({ line: line.trim(), i }))
      .filter(({ line }) => line === "try {")
      .at(-1);
    expect(tryLine, "expected a `try {` before adapter.execute").toBeDefined();

    expect(tryLine!.i).toBeLessThan(guard);
    expect(guard).toBeLessThan(exec);
  });

  it("keeps both cleanups in the finally that the suppression return still runs", () => {
    // If either of these ever moves out of that finally, the structural proof
    // above stops meaning anything — so assert their position too.
    const guard = lineOf("CLI-006-SUPPRESSION-RETURN");
    const deregister = lineOf("deregisterRuntimeHook(runtimeHookToken);");
    const cleanup = lineOf("await heartbeatMcpDelivery.cleanup();");

    const finallyLine = HEARTBEAT_SRC.slice(guard, deregister)
      .map((line, i) => ({ line: line.trim(), i: i + guard }))
      .filter(({ line }) => line.startsWith("} finally {"))
      .at(-1);
    expect(finallyLine, "expected a `} finally {` between the guard and the cleanups").toBeDefined();

    expect(guard).toBeLessThan(finallyLine!.i);
    expect(finallyLine!.i).toBeLessThan(deregister);
    expect(deregister).toBeLessThan(cleanup);
  });

  it("has exactly ONE suppression return — the decision is acted on once", () => {
    const hits = HEARTBEAT_SRC.filter((line) => line.includes("CLI-006-SUPPRESSION-RETURN"));
    expect(hits).toHaveLength(1);
  });
});

// -- Task 6: the unguarded await in the outer finally (R6) --------------------
//
// `dispatchQueuedRunsAfterAgentSignal` THROWS in the tenant-isolated branch when
// an Organization cannot be resolved (`heartbeat.ts`, the `resolveCompanyOrganizationId`
// guard). It is awaited in `executeRun`'s outer `finally`, where its three
// neighbours — the workspace run lock, the runtime services, and the environment
// leases — are all `.catch`-chained.
//
// If it throws AFTER a suppression return, `executeRun`'s promise rejects into
// the call-site `.catch`, which sees the run still `running` and writes
// `pre_spawn_failed` + releases the issue. That is exactly the legacy
// finalization the seam exists to prevent, reached through an exception rather
// than through the code path the seam guards.

describe("CLI-006/Task 6 — no bare await can reject out of the outer finally", () => {
  it("chains a catch onto dispatchQueuedRunsAfterAgentSignal in the finally", () => {
    const idx = HEARTBEAT_SRC.findIndex(
      (line) => line.includes("dispatchQueuedRunsAfterAgentSignal(agent.id)") && line.includes("await"),
    );
    expect(idx, "expected the finally's dispatch call").toBeGreaterThan(-1);
    const window = HEARTBEAT_SRC.slice(idx, idx + 4).join(" ");
    expect(window).toContain(".catch(");
  });

  it("keeps the neighbouring releases catch-chained too", () => {
    // The property is "nothing in this finally can reject", not "one call was
    // fixed" — so assert the neighbours still hold the line.
    const src = HEARTBEAT_SRC.join(" ");
    expect(src).toContain("heartbeat: failed to release environment leases in finally");
    expect(src).toContain("heartbeat: failed to release thread workspace run lock in finally");
  });
});

// -- M6: the canary guard must carry the SAME wake predicate as CLI-005 -------
//
// Found by adversarial review. CLI-005's active-convert block gates on
// `shouldAutoCheckoutForWake` and its comment says why: without it, convert mode
// checks out (flips status to in_progress, resets startedAt, re-broadcasts
// issue.status_changed) on mention / execution_* / null wakes that legacy leaves
// to the agent's own self-checkout.
//
// The canary block omitted it. On such a wake the harness checkout is skipped
// (heartbeat.ts:3212), the canary block fires anyway, the D3a bypass probe
// `taskSourceIsAdmitted` fails because `issues.checkoutRunId !== run.id`, and so
// `admitAndSubmit` drives its OWN checkout — silently flipping a backlog task the
// founder merely mentioned into `in_progress`. Exactly the parity break CLI-005's
// review closed for active mode.

describe("CLI-006/M6 — canary fires only on wakes the harness checks out for", () => {
  it("carries shouldAutoCheckoutForWake, like the active-convert block", () => {
    const canary = HEARTBEAT_SRC.findIndex((l) => l.includes('distributedRolloutState === "canary"'));
    expect(canary, "expected the canary guard").toBeGreaterThan(-1);
    const guard = HEARTBEAT_SRC.slice(canary - 3, canary + 24).join(" ");
    expect(guard).toContain("shouldAutoCheckoutForWake");
  });

  it("keeps the active-convert block's predicate too, so the two cannot diverge", () => {
    const active = HEARTBEAT_SRC.findIndex((l) => l.includes('distributedRolloutState === "active"'));
    const guard = HEARTBEAT_SRC.slice(active, active + 8).join(" ");
    expect(guard).toContain("shouldAutoCheckoutForWake");
  });
});

// -- Blocker A: the workload PUSH ---------------------------------------------
//
// `input` was plumbed end-to-end from this seam to `jobs.input` since CLI-005 and
// NOTHING pushed into it. Every canary job carried `{}`, so `createSpecFor` fell
// back to `command = workloadType` and the sandbox would have run a binary called
// "batch". That is a five-module-long pipe whose only defect is one missing
// argument — invisible to every type, every behavioural test, and every guard.
//
// So the push is asserted STRUCTURALLY, the same way the suppression return is.
// A refactor that drops `input:` here reverts Blocker A completely while leaving
// the entire suite green.

describe("Blocker A — the canary seam pushes a real workload", () => {
  const canaryResolveIdx = (): number => {
    const idx = HEARTBEAT_SRC.findIndex((l) =>
      l.includes("await distributedRolloutHook.resolveExecutionOwner({"),
    );
    expect(idx, "expected the canary resolveExecutionOwner call").toBeGreaterThan(-1);
    return idx;
  };

  it("builds the workload from the run's own adapter + command spec + task markdown", () => {
    const build = HEARTBEAT_SRC.findIndex((l) => l.includes("buildTaskRunBatchWorkload({"));
    expect(build, "expected the seam to call buildTaskRunBatchWorkload").toBeGreaterThan(-1);
    const call = HEARTBEAT_SRC.slice(build, build + 8).join(" ");
    // NEVER `agent.adapterType` as the command — that is the shadow comparator's bug.
    expect(call).toContain("runtimeCommandSpec");
    expect(call).toContain("context.currentTaskMarkdown");
    expect(call).toContain("runScopedConfig");
    // The builder runs BEFORE the placement it feeds.
    expect(build).toBeLessThan(canaryResolveIdx());
  });

  it("passes the built workload as `input` to resolveExecutionOwner", () => {
    const idx = canaryResolveIdx();
    const call = HEARTBEAT_SRC.slice(idx, idx + 9).join(" ");
    expect(call).toContain("input: canaryWorkload.workload");
  });

  it("does NOT convert when the workload cannot be built (fail closed)", () => {
    // Converting without a workload places a leasable attempt whose only possible
    // outcome is a sandbox running a nonexistent command — while the legacy
    // executor has already been suppressed. Staying legacy is the correct answer.
    //
    // ★ THE WINDOW IS ANCHORED AT BOTH ENDS, NOT SIZED BY A MAGIC NUMBER. It was
    // `build + 24`, and CLI-008 Unit D pushed `workload_unavailable` past line 24 by adding
    // comments — a RED test for a seam that had not changed. A fixed line count measures how
    // much prose sits between two statements, which is not the property being asserted. The
    // window now runs from the builder call to the log line that follows the decision, so it
    // grows with the code it brackets.
    const build = HEARTBEAT_SRC.findIndex((l) => l.includes("buildTaskRunBatchWorkload({"));
    const end = HEARTBEAT_SRC.findIndex(
      (l, i) => i > build && l.includes("canary execution owner = DISTRIBUTED"),
    );
    expect(build).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(build);
    const window = HEARTBEAT_SRC.slice(build, end).join(" ");
    expect(window).toContain("canaryWorkload.ok");
    expect(window).toContain("workload_unavailable");
  });

  it("logs the reason on EVERY outcome, not just the new one", () => {
    // A new legacy reason that is never logged is indistinguishable, in aggregate,
    // from `rollout_not_canary` — the same blindness this change exists to remove.
    // ★ Anchored at both ends for the same reason as the window above: a fixed `idx + 60`
    // measures prose, not structure, and Unit D's comments pushed the LEGACY branch past it.
    const idx = canaryResolveIdx();
    const end = HEARTBEAT_SRC.findIndex(
      (l, i) => i > idx && l.includes("shouldSuppressLegacyExecution(canaryExecutionOwner)"),
    );
    expect(end).toBeGreaterThan(idx);
    const window = HEARTBEAT_SRC.slice(idx, end).join(" ");
    expect(window).toContain("canary execution owner = DISTRIBUTED");
    expect(window).toContain("canary execution owner = LEGACY");
    expect(window).toContain("reason: canaryExecutionOwner.reason");
  });
});
