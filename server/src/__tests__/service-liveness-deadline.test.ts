// -----------------------------------------------------------------------------
// SVC-003b — the liveness deadline's POLICY, as a pure function of two ages.
//
// EVERY CASE NAMES THE MUTANT THAT MUST RE-RED IT; `SVC-003b-result.md` §4 records which did.
//
// ★ WHAT THIS SUITE IS FOR, AND WHAT IT CANNOT SHOW. It pins the DECISION — which of the four
// verdicts a pair of ages produces, and which two of them act. It cannot show that the
// decision is reached from a real sweep, that the sweep is wired into a running tick, or that
// a terminalized instance is actually replaced. Those are the integration suite's, and
// `service-liveness-deadline.integration.test.ts` drives them against real PostgreSQL. A green
// run here with the sweep deleted would still be green, which is exactly why mutant L6 (delete
// the sweep call site in `runTick`) is measured over there.
// -----------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  SERVICE_INSTANCE_STATUSES,
  canTransitionServiceInstanceStatus,
} from "@armyofagents/worker-protocol";
// ★ The REAL tick constant, imported from the daemon that emits on it rather than copied as a
// number. P14's ratio is only meaningful if a change to SVC-008b's default is felt here.
import { SERVICE_HEALTH_TICK_MS_DEFAULT } from "@armyofagents/worker-daemon";

import {
  classifyServiceInstanceLiveness,
  livenessDeadlineAllowedFromStatuses,
  livenessVerdictTerminalizes,
  nonTerminalServiceInstanceStatuses,
  SERVICE_ADMISSION_DEADLINE_MS_DEFAULT,
  SERVICE_LIVENESS_DEADLINE_MS_DEFAULT,
  SERVICE_LIVENESS_DEADLINE_TO_STATUS,
} from "../services/service-liveness-deadline.js";

/** Deliberately far apart, and neither equal to a shipped default: a suite that used the
 *  defaults could not tell "the classifier read the policy" from "the classifier hardcoded
 *  the same number". */
const POLICY = { livenessDeadlineMs: 60_000, admissionDeadlineMs: 300_000 };

describe("SVC-003b — classifyServiceInstanceLiveness", () => {
  // ── The observed arm ──────────────────────────────────────────────────────────────────

  it("P1 — an instance observed inside the liveness window is fresh", () => {
    expect(classifyServiceInstanceLiveness(
      { observedAgeMs: 59_999, createdAgeMs: 59_999 },
      POLICY,
    )).toEqual({ verdict: "fresh", observedAgeMs: 59_999 });
  });

  it("★ P2 — an instance observed and then SILENT past the liveness window is condemned", () => {
    // The failure the whole ticket exists for: the worker WAS seen, then stopped saying
    // anything, and no event will ever arrive to move the row.
    // MUTANT L1: invert the comparison, or widen `>` to `>=` on the wrong side.
    const verdict = classifyServiceInstanceLiveness(
      { observedAgeMs: 60_001, createdAgeMs: 3_600_000 },
      POLICY,
    );
    expect(verdict).toEqual({ verdict: "silent", observedAgeMs: 60_001 });
    expect(livenessVerdictTerminalizes(verdict)).toBe(true);
  });

  it("P3 — the liveness comparison is STRICT: an age exactly equal to the window is alive", () => {
    // A deadline is the point PAST which an instance is condemned, not the point at which it
    // is. MUTANT L2: `>=` instead of `>`.
    expect(classifyServiceInstanceLiveness(
      { observedAgeMs: 60_000, createdAgeMs: 60_000 },
      POLICY,
    ).verdict).toBe("fresh");
  });

  it("★★★ P4 — a LONG-LIVED instance observed seconds ago is FRESH, not condemned by its age", () => {
    // The observed arm must not consult `createdAgeMs` at all. A service that has been up for
    // a week is arbitrarily older than any admission window; a classifier that considered its
    // creation would terminalize every healthy long-running service — the exact population E9
    // exists to keep running.
    // MUTANT L3: add `|| row.createdAgeMs > policy.admissionDeadlineMs` to the observed arm.
    const verdict = classifyServiceInstanceLiveness(
      { observedAgeMs: 1_000, createdAgeMs: 7 * 24 * 3_600_000 },
      POLICY,
    );
    expect(verdict).toEqual({ verdict: "fresh", observedAgeMs: 1_000 });
    expect(livenessVerdictTerminalizes(verdict)).toBe(false);
  });

  // ── The unreadable arm, which is where SVC-008b's lesson lives ─────────────────────────

  it("★★★ P5 — NEVER OBSERVED, older than the LIVENESS window but inside ADMISSION: STALL", () => {
    // ★ THIS IS THE CASE THAT KILLS THE COLLAPSE. `createdAgeMs` here (120 s) is well past the
    // liveness window (60 s) and well inside the admission window (300 s). Any decider that
    // substitutes creation for observation — a `COALESCE(last_observed_at, created_at)` in the
    // sweep's SQL, a `?? row.createdAgeMs` in the classifier, an `Infinity` sentinel — reports
    // `silent` here and terminalizes an instance whose worker has simply not polled yet.
    // MUTANT L4: `observedAgeMs ?? createdAgeMs` at the head of the classifier.
    const verdict = classifyServiceInstanceLiveness(
      { observedAgeMs: null, createdAgeMs: 120_000 },
      POLICY,
    );
    expect(verdict).toEqual({ verdict: "awaiting_first_observation", createdAgeMs: 120_000 });
    expect(livenessVerdictTerminalizes(verdict)).toBe(false);
  });

  it("★★★ P6 — NEVER OBSERVED and brand new is a STALL, never an immediate kill", () => {
    // The opposite collapse: treating a missing observation as infinitely stale terminalizes
    // a freshly created instance on the very first tick, before any worker could have reached
    // it. That is literally "terminalize a live instance because the observation was
    // unreadable" — worse than the stuck instance the deadline was built to fix.
    // MUTANT L5: `if (row.observedAgeMs === null) return { verdict: "never_observed", ... }`.
    const verdict = classifyServiceInstanceLiveness(
      { observedAgeMs: null, createdAgeMs: 0 },
      POLICY,
    );
    expect(verdict.verdict).toBe("awaiting_first_observation");
    expect(livenessVerdictTerminalizes(verdict)).toBe(false);
  });

  it("★ P7 — NEVER OBSERVED past the ADMISSION window is condemned, on the ROW's age", () => {
    const verdict = classifyServiceInstanceLiveness(
      { observedAgeMs: null, createdAgeMs: 300_001 },
      POLICY,
    );
    expect(verdict).toEqual({ verdict: "never_observed", createdAgeMs: 300_001 });
    expect(livenessVerdictTerminalizes(verdict)).toBe(true);
  });

  it("P8 — the admission comparison is STRICT too", () => {
    expect(classifyServiceInstanceLiveness(
      { observedAgeMs: null, createdAgeMs: 300_000 },
      POLICY,
    ).verdict).toBe("awaiting_first_observation");
  });

  it("P9 — the four verdicts are exhaustive and exactly two of them act", () => {
    // A guard against a fifth arm being added without deciding whether it terminalizes.
    const verdicts = [
      classifyServiceInstanceLiveness({ observedAgeMs: 1, createdAgeMs: 1 }, POLICY),
      classifyServiceInstanceLiveness({ observedAgeMs: 999_999, createdAgeMs: 999_999 }, POLICY),
      classifyServiceInstanceLiveness({ observedAgeMs: null, createdAgeMs: 1 }, POLICY),
      classifyServiceInstanceLiveness({ observedAgeMs: null, createdAgeMs: 999_999 }, POLICY),
    ];
    expect(verdicts.map((v) => v.verdict)).toEqual([
      "fresh", "silent", "awaiting_first_observation", "never_observed",
    ]);
    expect(verdicts.map(livenessVerdictTerminalizes)).toEqual([false, true, false, true]);
  });

  it("P10 — the policy is READ, not hardcoded: the same ages flip under a different policy", () => {
    const row = { observedAgeMs: 90_000, createdAgeMs: 90_000 };
    expect(classifyServiceInstanceLiveness(row, POLICY).verdict).toBe("silent");
    expect(classifyServiceInstanceLiveness(
      row,
      { livenessDeadlineMs: 120_000, admissionDeadlineMs: 300_000 },
    ).verdict).toBe("fresh");
  });
});

describe("SVC-003b — the deadline's target status and its frozen predecessor set", () => {
  it("★ P11 — the target is reachable from EVERY status the sweep can read", () => {
    // The sweep's population is exactly the non-terminal instances. If the predecessor set
    // failed to cover one of them, that status's stuck instances would be swept and then
    // refused as `illegal_transition` forever — the E9-F004 wedge, one door along. Both sides
    // are derived from the frozen table here; nothing is hand-listed.
    // MUTANT L7: change `SERVICE_LIVENESS_DEADLINE_TO_STATUS` to `"stopped"`, whose sole
    // frozen predecessor is `stopping` — five of the six live statuses become uncoverable and
    // the module's load-time assertion throws.
    const allowed = new Set(livenessDeadlineAllowedFromStatuses());
    for (const status of nonTerminalServiceInstanceStatuses()) {
      expect(allowed.has(status), `${status} cannot reach ${SERVICE_LIVENESS_DEADLINE_TO_STATUS}`)
        .toBe(true);
    }
  });

  it("P12 — and NO terminal status is a predecessor, so the deadline cannot resurrect", () => {
    // The split-brain refusal SVC-003a built, applied to the control plane's own verdict: an
    // instance that already reached a terminal status has left the live index and may have
    // been replaced, so nothing may move it again.
    const terminals = SERVICE_INSTANCE_STATUSES.filter((from) =>
      SERVICE_INSTANCE_STATUSES.every((to) => !canTransitionServiceInstanceStatus(from, to)));
    expect(terminals.slice().sort()).toEqual(["failed", "lost", "stopped"]);
    for (const terminal of terminals) {
      expect(livenessDeadlineAllowedFromStatuses()).not.toContain(terminal);
    }
  });

  it("P13 — `lost` is the target, and it is a frozen member", () => {
    expect(SERVICE_INSTANCE_STATUSES).toContain(SERVICE_LIVENESS_DEADLINE_TO_STATUS);
    expect(SERVICE_LIVENESS_DEADLINE_TO_STATUS).toBe("lost");
  });
});

describe("SVC-003b — the shipped defaults", () => {
  it("★ P14 — the liveness window is a MULTIPLE of SVC-008b's health tick, not a peer of it", () => {
    // The property that must survive any later ruling on SVC-008 §9.3 (the tick interval is
    // still an OPEN question, and this default does not close it). A single dropped tick — one
    // slow `processStatus` read — must not terminalize a working service.
    // MUTANT L8: set the liveness default to the tick interval itself.
    expect(SERVICE_LIVENESS_DEADLINE_MS_DEFAULT / SERVICE_HEALTH_TICK_MS_DEFAULT)
      .toBeGreaterThanOrEqual(6);
  });

  it("★ P15 — the admission window is strictly LONGER than the liveness window", () => {
    // A pending instance waits for placement, a poll, an ACK, a sandbox create and a process
    // launch — none of which is bounded by a health-tick interval. Ordering them the other way
    // round would kill starting services faster than silent ones.
    // MUTANT L9: swap the two defaults.
    expect(SERVICE_ADMISSION_DEADLINE_MS_DEFAULT)
      .toBeGreaterThan(SERVICE_LIVENESS_DEADLINE_MS_DEFAULT);
  });
});
