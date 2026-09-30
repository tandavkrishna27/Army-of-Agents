/**
 * A CHECK THAT NOTHING RUNS IS NOT A CHECK.
 *
 * REL-004's terrain map found three fail-closed admission verifiers that nothing called,
 * and two documents asserting an enforcement that never happened. This guard generalizes
 * the fix from functions to executables: every `scripts/check-*` and `scripts/verify-*`
 * must declare whether anything runs it, and the declaration is verified.
 *
 * DECLARATION-BASED, DELIBERATELY. Inferring "is this script invoked" from the tree is
 * harder than it looks — five successive greps during the reconnaissance each produced a
 * wrong answer, in BOTH directions: a comment in a shell script that merely echoed a
 * script's name read as an invocation, and real invocations written as
 * `node /app/scripts/x.mjs` or `node ../../../../scripts/x.mjs` read as absent. A detector
 * that is subtly wrong is the same disease as the documentation that started this.
 *
 * So the hard direction is not inferred. A human DECLARES the status, and this verifies
 * only the easy direction: that the declaration still matches the tree. That catches the
 * case that actually bites — a script quietly dropped from CI while its entry, and
 * everyone's belief, stays behind.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GUARD_STATUSES, evaluateGuardInventory } from "../guard-inventory.mjs";

const base = {
  scripts: ["scripts/check-alpha.mjs", "scripts/verify-beta.mjs"],
  declared: {
    "scripts/check-alpha.mjs": { status: "ci", reason: "policy job" },
    "scripts/verify-beta.mjs": {
      status: "ci_logic_only",
      reason: "awaiting an artifact",
      provenTest: "scripts/lib/__tests__/beta.test.mjs",
    },
  },
  invocationText: "node scripts/check-alpha.mjs\nnode --test scripts/lib/__tests__/beta.test.mjs\n",
  testFiles: ["scripts/lib/__tests__/beta.test.mjs"],
};

describe("guard inventory — a clean tree passes", () => {
  it("accepts declarations that match the tree", () => {
    // Non-vacuity for every refusal below.
    assert.deepEqual(evaluateGuardInventory(base), { ok: true, problems: [] });
  });

  it("knows exactly three statuses, and no others", () => {
    assert.deepEqual([...GUARD_STATUSES], ["ci", "ci_logic_only", "dormant"]);
  });
});

describe("guard inventory — coverage is default-deny", () => {
  it("FAILS on a script with no declaration", () => {
    // A new check must be classified. Otherwise it is born unclassified and nobody ever
    // asks whether anything runs it — which is precisely how three verifiers were built
    // and forgotten.
    const r = evaluateGuardInventory({ ...base, scripts: [...base.scripts, "scripts/check-new.mjs"] });
    assert.equal(r.ok, false);
    assert.equal(r.problems[0].kind, "undeclared_script");
    assert.equal(r.problems[0].script, "scripts/check-new.mjs");
  });

  it("FAILS on a declaration whose script no longer exists", () => {
    // A stale entry is a claim about a file that is gone, and claims about absent things
    // are what this guard exists to stop.
    const r = evaluateGuardInventory({ ...base, scripts: ["scripts/check-alpha.mjs"] });
    assert.equal(r.ok, false);
    assert.equal(r.problems[0].kind, "stale_declaration");
    assert.equal(r.problems[0].script, "scripts/verify-beta.mjs");
  });

  it("reports EVERY problem, not just the first", () => {
    const r = evaluateGuardInventory({
      ...base,
      scripts: ["scripts/check-gamma.mjs", "scripts/check-delta.mjs"],
    });
    assert.equal(r.problems.length, 4); // two undeclared, two stale
  });
});

describe("guard inventory — a 'ci' claim is verified against the workflows", () => {
  it("FAILS when a script declared 'ci' appears on no invocation surface", () => {
    // The case that actually bites: a script quietly dropped from CI while its entry, and
    // everyone's belief about it, stays behind.
    const r = evaluateGuardInventory({ ...base, invocationText: "node --test scripts/lib/__tests__/beta.test.mjs\n" });
    assert.equal(r.ok, false);
    assert.equal(r.problems[0].kind, "not_in_workflows");
    assert.equal(r.problems[0].script, "scripts/check-alpha.mjs");
  });

  it("does NOT accept a mention inside a YAML comment as an invocation", () => {
    // The exact false positive from the reconnaissance: `docker/images/sign.sh` echoed
    // `verify-image-admission.mjs` in a help string, and a substring sweep read that as
    // proof the check ran. It had never run.
    const r = evaluateGuardInventory({
      ...base,
      invocationText: "  # node scripts/check-alpha.mjs — see REL-004\nnode --test scripts/lib/__tests__/beta.test.mjs\n",
    });
    assert.equal(r.ok, false);
    assert.equal(r.problems[0].kind, "not_in_workflows");
  });
});

describe("guard inventory — 'ci_logic_only' must name a test that CI really runs", () => {
  it("FAILS when the named test is absent from the workflows", () => {
    const r = evaluateGuardInventory({ ...base, invocationText: "node scripts/check-alpha.mjs\n" });
    assert.equal(r.ok, false);
    assert.equal(r.problems[0].kind, "proven_test_not_in_workflows");
  });

  it("FAILS when the named test does not exist on disk", () => {
    const r = evaluateGuardInventory({ ...base, testFiles: [] });
    assert.equal(r.ok, false);
    assert.equal(r.problems[0].kind, "proven_test_missing");
  });

  it("FAILS when no test is named at all", () => {
    // "The logic is proven elsewhere" is a claim, and a claim with no referent is the
    // thing this guard exists to refuse.
    const declared = { ...base.declared };
    declared["scripts/verify-beta.mjs"] = { status: "ci_logic_only", reason: "x" };
    const r = evaluateGuardInventory({ ...base, declared });
    assert.equal(r.ok, false);
    assert.equal(r.problems[0].kind, "malformed_declaration");
  });
});

describe("guard inventory — 'dormant' is allowed but must be justified", () => {
  const dormant = (reason) => ({
    ...base,
    declared: { ...base.declared, "scripts/verify-beta.mjs": { status: "dormant", reason } },
  });

  it("accepts a dormant script with a stated reason", () => {
    assert.equal(evaluateGuardInventory(dormant("superseded by check-release-admission")).ok, true);
  });

  it("FAILS a dormant script with no reason", () => {
    for (const reason of [undefined, "", "   ", 7]) {
      const r = evaluateGuardInventory(dormant(reason));
      assert.equal(r.ok, false, JSON.stringify(reason) ?? "undefined");
      assert.equal(r.problems[0].kind, "malformed_declaration");
    }
  });
});

describe("guard inventory — malformed input is refused, never guessed", () => {
  it("FAILS an unknown status rather than treating it as satisfied", () => {
    const declared = { ...base.declared };
    declared["scripts/check-alpha.mjs"] = { status: "probably-fine", reason: "x" };
    const r = evaluateGuardInventory({ ...base, declared });
    assert.equal(r.ok, false);
    assert.equal(r.problems[0].kind, "malformed_declaration");
  });

  it("never throws on caller-supplied garbage", () => {
    for (const bad of [undefined, null, 0, "", [], { scripts: 7 }, { declared: 7 }]) {
      assert.equal(evaluateGuardInventory(bad).ok, false, JSON.stringify(bad) ?? "undefined");
    }
  });
});
