// DAT-010 — retention is CONTROL-PLANE-OWNED at commit.
//
// `browser-artifact-retention.ts:5-14` states retention is "control-plane-owned, and never
// caller- or worker-supplied", because "a caller or worker choosing the retention of a
// `browser_cookie_state` or `browser_storage_state` artifact is a privilege the threat
// model must not grant — those artifacts carry live session credentials."
//
// `artifact-commit.ts` granted exactly that privilege by storing `manifest.retention`,
// while the total fail-safe function that exists to own the decision had ZERO callers.
//
// These tests pin the authority, not the table (the table is tested in
// browser-artifact-retention.test.ts). If one ever starts passing while the other fails,
// the derivation has been rewired to trust the caller again.

import { describe, expect, it } from "vitest";

import { ARTIFACT_KINDS } from "@armyofagents/worker-protocol";
import { resolveStoredRetention } from "../services/artifact-retention-authority.js";

describe("DAT-010 — retention authority at commit", () => {
  it("★ IGNORES a worker-declared class for a credential-bearing artifact", () => {
    // The privilege the threat model must not grant: a worker declaring its own cookie
    // state as long-lived. `audit` is the longest class a manifest could plausibly claim.
    const r = resolveStoredRetention({ kind: "browser_cookie_state", declared: "audit" });
    expect(r.retention).toBe("ephemeral");
    expect(r.declarationIgnored).toBe(true);
  });

  it("★ ignores it for browser_storage_state too — both credential-bearing kinds", () => {
    const r = resolveStoredRetention({ kind: "browser_storage_state", declared: "checkpoint" });
    expect(r.retention).toBe("ephemeral");
    expect(r.declarationIgnored).toBe(true);
  });

  it("★ an UNRECOGNISED kind fails SAFE to the shortest class", () => {
    // Direction matters. A hostile or unknown kind must yield the shortest life, never the
    // longest — a mutation swapping the fail-safe to `audit` dies here.
    const r = resolveStoredRetention({ kind: "not-a-real-kind", declared: "audit" });
    expect(r.retention).toBe("ephemeral");
  });

  it("derives a class for every one of the frozen artifact kinds", () => {
    // Total over the closed enum: no kind may fall through to undefined/null, which is
    // what "MANDATORY means no absent path" requires.
    for (const kind of ARTIFACT_KINDS) {
      const r = resolveStoredRetention({ kind, declared: "run" });
      expect(typeof r.retention).toBe("string");
      expect(r.retention.length).toBeGreaterThan(0);
    }
  });

  it("does not flag the common path where the declaration already agrees", () => {
    // A spurious signal on every ordinary commit would train everyone to ignore it.
    const r = resolveStoredRetention({ kind: "screenshot", declared: "run" });
    expect(r.retention).toBe("run");
    expect(r.declarationIgnored).toBe(false);
  });

  it("flags a disagreement even when it is a HARMLESS one", () => {
    // A worker declaring `ephemeral` for a `run` artifact is not a downgrade attempt, but
    // it still means the worker computed something different from the control plane —
    // which is worth seeing, because it is the same bug class as a downgrade.
    const r = resolveStoredRetention({ kind: "screenshot", declared: "ephemeral" });
    expect(r.retention).toBe("run");
    expect(r.declarationIgnored).toBe(true);
  });

  it("treats an absent declaration as a disagreement rather than a match", () => {
    // The frozen schema requires the field, so absence means something upstream is
    // already wrong. It must not read as agreement.
    const r = resolveStoredRetention({ kind: "screenshot", declared: undefined });
    expect(r.retention).toBe("run");
    expect(r.declarationIgnored).toBe(true);
  });
});
