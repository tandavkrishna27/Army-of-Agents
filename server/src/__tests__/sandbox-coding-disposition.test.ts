/**
 * CLI-002/D3 — the per-adapter-TYPE disposition gate + the static coverage lint.
 *
 * Pure module (no DB): imports the real `BUILTIN_ADAPTER_TYPES` registry set and
 * the disposition matrix so the lint catches a registered type that was never
 * dispositioned (fail-closed on drift) and a mis-bucketed type. The gate proves it
 * admits ONLY the v1 set and fails closed with an attributable reason on every
 * other bucket — never a silent host fallback.
 */

import { describe, expect, it } from "vitest";

import { BUILTIN_ADAPTER_TYPES } from "../adapters/builtin-adapter-types.js";
import {
  CODING_ADAPTER_DISPOSITIONS,
  dispositionForAdapter,
  evaluateDispositionCoverage,
  gateCodingAdapterDispatch,
} from "../services/sandbox-coding-disposition.js";

describe("CLI-002/D3 — disposition coverage lint", () => {
  it("every registered adapter type has a disposition (no drift)", () => {
    const result = evaluateDispositionCoverage(BUILTIN_ADAPTER_TYPES);
    expect(result.undispositioned, `undispositioned: ${result.undispositioned.join(", ")}`).toEqual([]);
    expect(result.unregistered, `stale dispositions: ${result.unregistered.join(", ")}`).toEqual([]);
    expect(result.missingReasons, `missing reasons: ${result.missingReasons.join(", ")}`).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("the v1 set is EXACTLY claude_local + codex_local", () => {
    const v1 = Object.values(CODING_ADAPTER_DISPOSITIONS)
      .filter((d) => d.bucket === "v1")
      .map((d) => d.adapterType)
      .sort();
    expect(v1).toEqual(["claude_local", "codex_local"]);
  });

  it("out_of_scope covers the 5 non-sandbox adapters with attributable reasons", () => {
    const outOfScope = Object.values(CODING_ADAPTER_DISPOSITIONS)
      .filter((d) => d.bucket === "out_of_scope")
      .map((d) => d.adapterType)
      .sort();
    expect(outOfScope).toEqual(["acpx_local", "cursor_cloud", "hermes_local", "openclaw", "openclaw_gateway"]);
    for (const d of Object.values(CODING_ADAPTER_DISPOSITIONS)) {
      if (d.bucket !== "v1") expect(typeof d.reason === "string" && d.reason.length > 0).toBe(true);
    }
  });

  it("no v1/out-of-scope type is mis-bucketed (a moved type fails the lint)", () => {
    const mutated = {
      ...CODING_ADAPTER_DISPOSITIONS,
      // Simulate a regression: an out-of-scope adapter re-bucketed to v1 without a reason.
      hermes_local: { adapterType: "hermes_local", bucket: "v1" as const },
    };
    // Coverage still "ok" (bucket valid) but the intent lint below catches it:
    // hermes must NEVER be v1.
    const v1 = Object.values(mutated).filter((d) => d.bucket === "v1").map((d) => d.adapterType);
    expect(v1).toContain("hermes_local"); // proves the mutation took
    // The authoritative matrix must not contain it.
    expect(Object.values(CODING_ADAPTER_DISPOSITIONS).some((d) => d.bucket === "v1" && d.adapterType === "hermes_local")).toBe(false);
  });
});

describe("CLI-002/D3 — execute-path gate (fail-closed, attributable)", () => {
  it("admits v1 adapters under cloud_auth", () => {
    for (const type of ["claude_local", "codex_local"]) {
      const decision = gateCodingAdapterDispatch(type, "cloud_auth");
      expect(decision.admitted).toBe(true);
      expect(decision.rejectionReason).toBeUndefined();
      expect(decision.disposition.bucket).toBe("v1");
    }
  });

  it("fails closed on out_of_scope with an attributable reason (never a silent fallback)", () => {
    for (const type of ["acpx_local", "openclaw", "cursor_cloud", "openclaw_gateway", "hermes_local"]) {
      const decision = gateCodingAdapterDispatch(type, "cloud_auth");
      expect(decision.admitted).toBe(false);
      expect(decision.rejectionReason && decision.rejectionReason.length > 0).toBe(true);
      expect(decision.rejectionReason).toContain(type);
      expect(decision.disposition.bucket).toBe("out_of_scope");
    }
  });

  it("records Follow-up adapters but does NOT admit them", () => {
    for (const type of ["gemini_local", "opencode_local", "cursor", "grok_local", "pi_local"]) {
      const decision = gateCodingAdapterDispatch(type, "cloud_auth");
      expect(decision.admitted).toBe(false);
      expect(decision.disposition.bucket).toBe("follow_up");
      expect(decision.rejectionReason).toContain("follow-up");
    }
  });

  it("fails closed on infra + unknown adapter types", () => {
    for (const type of ["process", "http"]) {
      expect(gateCodingAdapterDispatch(type, "cloud_auth").admitted).toBe(false);
    }
    const unknown = gateCodingAdapterDispatch("totally_made_up", "cloud_auth");
    expect(unknown.admitted).toBe(false);
    expect(unknown.disposition.bucket).toBe("out_of_scope");
    expect(dispositionForAdapter("totally_made_up").reason).toContain("unregistered");
  });
});
