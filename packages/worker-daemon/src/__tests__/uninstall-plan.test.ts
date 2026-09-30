/**
 * DSK-003 Lane B / I6 + I7 — uninstall stops work before touching identity, and the
 * identity disposition is ALWAYS explicit.
 *
 * I7 is the one with teeth. There is no default, and neither candidate default is safe:
 * silently retaining leaves a working credential on a machine being decommissioned, and
 * silently revoking destroys an identity the operator may still need — and DSK-001
 * established that a destroyed device identity is unrecoverable, because
 * `findWorkerForBinding` has no status predicate and a revoked row keeps matching
 * forever. So "the operator did not say" is a REFUSAL, the same discipline
 * `--reset-identity` already uses with its acknowledgement flag.
 *
 * I6 is expressed as an ordered PLAN rather than as execution order buried in a
 * function, so the ordering is a property of a value a test can read — the same shape as
 * `createLeaseLifecycleSteps`.
 */

import { describe, expect, it } from "vitest";

import {
  UNINSTALL_IDENTITY_POLICIES,
  UNINSTALL_REFUSALS,
  planUninstall,
} from "../control/uninstall-plan.js";

describe("DSK-003/I7 — the identity disposition is never defaulted", () => {
  it("refuses when no policy is given", () => {
    for (const policy of [undefined, null, ""]) {
      expect(planUninstall({ identityPolicy: policy as never }))
        .toEqual({ ok: false, reason: "no_identity_policy" });
    }
  });

  it("refuses an unrecognised policy rather than falling back", () => {
    // "keep", "delete", "yes" are all plausible things an operator might type. None of
    // them may be interpreted — a near-miss must not become a destructive action.
    for (const policy of ["keep", "delete", "yes", "RETAIN"]) {
      expect(planUninstall({ identityPolicy: policy as never }))
        .toEqual({ ok: false, reason: "unknown_identity_policy" });
    }
  });

  it("accepts exactly two policies, and they are opposites", () => {
    expect([...UNINSTALL_IDENTITY_POLICIES].sort()).toEqual(["retain", "revoke"]);
  });

  it("plans both policies successfully — non-vacuity for the refusals above", () => {
    for (const identityPolicy of UNINSTALL_IDENTITY_POLICIES) {
      expect(planUninstall({ identityPolicy }).ok, identityPolicy).toBe(true);
    }
  });
});

describe("DSK-003/I6 — work stops before identity is touched", () => {
  const stepsFor = (identityPolicy: "retain" | "revoke") => {
    const plan = planUninstall({ identityPolicy });
    if (!plan.ok) throw new Error("expected a plan");
    return plan.steps.map((s) => s.name);
  };

  it("puts every work-stopping step before the identity step, for BOTH policies", () => {
    for (const policy of UNINSTALL_IDENTITY_POLICIES) {
      const names = stepsFor(policy);
      const identityAt = names.findIndex((n) => n.startsWith("identity-"));
      const lastWorkAt = Math.max(names.indexOf("stop-leasing"), names.indexOf("drain"));
      expect(identityAt, `${policy}: no identity step`).toBeGreaterThan(-1);
      expect(lastWorkAt, `${policy}: no work step`).toBeGreaterThan(-1);
      expect(identityAt, `${policy}: identity touched before work stopped`)
        .toBeGreaterThan(lastWorkAt);
    }
  });

  it("stops NEW leasing before draining in-flight work", () => {
    // The same lease-stop-before-drain rule the shutdown handler already encodes. An
    // uninstall that drained first would let a new lease arrive mid-teardown.
    for (const policy of UNINSTALL_IDENTITY_POLICIES) {
      const names = stepsFor(policy);
      expect(names.indexOf("stop-leasing")).toBeLessThan(names.indexOf("drain"));
    }
  });

  it("names the identity step for what it actually does", () => {
    // A plan whose steps were both called "identity" would let a reader — or a UI —
    // present a destructive uninstall as a benign one.
    expect(stepsFor("retain")).toContain("identity-retain");
    expect(stepsFor("revoke")).toContain("identity-destroy");
    expect(stepsFor("retain")).not.toContain("identity-destroy");
  });

  it("marks the destructive plan as destructive, and the other as not", () => {
    const retain = planUninstall({ identityPolicy: "retain" });
    const revoke = planUninstall({ identityPolicy: "revoke" });
    expect(retain.ok && retain.destroysIdentity).toBe(false);
    expect(revoke.ok && revoke.destroysIdentity).toBe(true);
  });

  it("ends with the process actually stopping, under both policies", () => {
    for (const policy of UNINSTALL_IDENTITY_POLICIES) {
      expect(stepsFor(policy).at(-1)).toBe("stop-host");
    }
  });
});

describe("DSK-003 Lane B — the refusal vocabulary is closed", () => {
  it("every refusal a plan can produce is declared", () => {
    const produced = [
      planUninstall({ identityPolicy: undefined as never }),
      planUninstall({ identityPolicy: "nonsense" as never }),
    ];
    for (const r of produced) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(UNINSTALL_REFUSALS).toContain(r.reason);
    }
    expect(new Set(produced.map((r) => (r.ok ? "" : r.reason))).size).toBe(2);
  });
});
