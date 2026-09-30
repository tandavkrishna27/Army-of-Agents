/**
 * REL-004 Lane C (D6) — the closed placement-provider vocabulary.
 *
 * A kill switch names a provider by `execution_targets.kind`. `evaluateKillSwitches` refuses a
 * switch whose value is outside this set, because a mistyped value ("E2B", "e2b-prod") would
 * otherwise match nothing and silently permit — the same hazard the module already refuses for
 * a mistyped `dimension`.
 *
 * The set is DERIVED from `TARGET_KIND_BY_CLASS` rather than restated, so it cannot drift from
 * the kinds `normalizePlacementRegistryTarget` will actually accept.
 */

import { describe, expect, it } from "vitest";

import { EXECUTION_TARGET_KINDS } from "../services/execution-target-resolver.js";

describe("REL-004 Lane C/D6 — EXECUTION_TARGET_KINDS", () => {
  it("is the closed placement-provider vocabulary, sorted and deduped", () => {
    expect([...EXECUTION_TARGET_KINDS]).toEqual(
      ["desktop", "dedicated_worker", "e2b", "local_host", "pooled_gvisor"].sort(),
    );
  });

  it("carries no empty or duplicated entry", () => {
    // Non-vacuity for the refusals in execution-kill-switches: the vocabulary itself must be
    // well-formed, or every switch would be refused for the wrong reason.
    for (const kind of EXECUTION_TARGET_KINDS) {
      expect(typeof kind).toBe("string");
      expect(kind.length).toBeGreaterThan(0);
    }
    expect(new Set(EXECUTION_TARGET_KINDS).size).toBe(EXECUTION_TARGET_KINDS.length);
  });

  it("is a frozen array, so a caller cannot widen the vocabulary at runtime", () => {
    // Array.isArray first: `Object.isFrozen(undefined)` is `true`, so the freeze assertion
    // alone would pass vacuously against a missing export.
    expect(Array.isArray(EXECUTION_TARGET_KINDS)).toBe(true);
    expect(Object.isFrozen(EXECUTION_TARGET_KINDS)).toBe(true);
  });
});
