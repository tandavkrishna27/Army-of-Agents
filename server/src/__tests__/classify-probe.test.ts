import { describe, it, expect } from "vitest";
import { classifyProbeOutcome } from "../services/providers/classify-probe.js";
import type { AdapterEnvironmentTestResult } from "@armyofagents/shared";

function result(status: "pass" | "warn" | "fail", codes: string[]): AdapterEnvironmentTestResult {
  return {
    adapterType: "claude_local",
    status,
    testedAt: new Date().toISOString(),
    checks: codes.map((code) => ({ code, level: "warn" as const, message: code })),
  };
}

describe("classifyProbeOutcome", () => {
  it("treats a clean pass as verified", () => {
    expect(classifyProbeOutcome(result("pass", ["claude_hello_probe_passed"])).outcome).toBe("verified");
  });

  it("detects auth-required probes", () => {
    expect(classifyProbeOutcome(result("warn", ["claude_hello_probe_auth_required"])).outcome).toBe("needs_auth");
    expect(classifyProbeOutcome(result("warn", ["grok_auth_required"])).outcome).toBe("needs_auth");
  });

  it("detects a missing binary", () => {
    expect(classifyProbeOutcome(result("fail", ["claude_command_unresolvable"])).outcome).toBe("not_installed");
  });

  // Gap 1: missing-key codes previously fell through to `verified`.
  it("treats a missing API key as needs_auth", () => {
    expect(classifyProbeOutcome(result("warn", ["codex_openai_api_key_missing"])).outcome).toBe("needs_auth");
    expect(classifyProbeOutcome(result("warn", ["cursor_api_key_missing"])).outcome).toBe("needs_auth");
  });

  // Gap 2: "install" substring previously swallowed package-install failures.
  it("does not classify a package install failure as not_installed", () => {
    expect(classifyProbeOutcome(result("fail", ["pi_package_install_failed"])).outcome).toBe("failed");
  });

  // A key-absence hint is NOT proof of subscription auth. The real check only
  // says login "can be used if Claude is logged in"
  // (packages/adapters/claude-local/src/server/test.ts:162-167), so on its own
  // it must NOT read as Ready.
  it("does not treat a subscription hint alone as authenticated", () => {
    expect(classifyProbeOutcome(result("warn", ["claude_subscription_mode_possible"])).outcome).toBe("unknown");
  });

  it("falls back to failed", () => {
    expect(classifyProbeOutcome(result("fail", ["claude_hello_probe_failed"])).outcome).toBe("failed");
  });

  // Gap 3: acpx emits missing-credential checks at info level, so the probe
  // returns status "pass" while unauthenticated. With NO live success signal
  // present, the credential hint must win.
  it("detects missing credentials when nothing proved the provider works", () => {
    expect(
      classifyProbeOutcome(result("pass", ["acpx_claude_credentials_missing"])).outcome,
    ).toBe("needs_auth");
    expect(
      classifyProbeOutcome(result("pass", ["acpx_codex_credentials_missing"])).outcome,
    ).toBe("needs_auth");
  });

  // ── COMPOSITE cases (the P1-3 regression) ────────────────────────────────
  // Real probes emit a missing-key HINT alongside a live success when the
  // provider is authenticated by OAuth / CLI login / subscription instead of a
  // key. Classifying these as needs_auth would tell a working founder to sign
  // in, forever, with no way to clear it.
  it("treats OAuth-backed Gemini as verified despite the missing-key hint", () => {
    expect(
      classifyProbeOutcome(result("warn", ["gemini_api_key_missing", "gemini_hello_probe_passed"])).outcome,
    ).toBe("verified");
  });

  it("treats CLI-login-backed Cursor as verified despite the missing-key hint", () => {
    expect(
      classifyProbeOutcome(result("warn", ["cursor_api_key_missing", "cursor_hello_probe_passed"])).outcome,
    ).toBe("verified");
  });

  it("treats subscription-auth Claude as verified despite no API key", () => {
    expect(
      classifyProbeOutcome(result("warn", ["claude_subscription_mode_possible", "claude_hello_probe_passed"]))
        .outcome,
    ).toBe("verified");
  });

  it("still reports needs_auth when the live probe itself failed auth", () => {
    expect(
      classifyProbeOutcome(result("warn", ["gemini_api_key_missing", "gemini_hello_probe_auth_required"])).outcome,
    ).toBe("needs_auth");
  });

  // RULE 1 vs RULE 2 — the guard-order case that actually pins it.
  //
  // Reachable in grok-local: the models probe (`test.ts` ~196-204) and the hello
  // probe (~243+) are two INDEPENDENT `if (canRunProbe)` blocks with no early
  // return, so one result can carry a failing `grok models` (→ `grok_auth_required`)
  // alongside a working agent run (→ `grok_hello_probe_passed`). An authoritative
  // auth failure must win over an authoritative live success.
  it("prefers a real auth failure over an authoritative live success in the same result", () => {
    expect(
      classifyProbeOutcome(result("warn", ["grok_hello_probe_passed", "grok_auth_required"])).outcome,
    ).toBe("needs_auth");
  });

  // Weaker sibling of the above: pins that an auth failure also beats a
  // NON-authoritative models-only success. Deliberately kept separate — this one
  // does NOT constrain guard 1 vs guard 2, because `_models_probe_passed` is not
  // in AUTHORITATIVE_SUCCESS_SUFFIXES, so there is no live success in this input.
  it("prefers a real auth failure over a models-only success", () => {
    expect(
      classifyProbeOutcome(result("warn", ["grok_models_probe_passed", "grok_hello_probe_auth_required"])).outcome,
    ).toBe("needs_auth");
  });

  // ── Never claim Ready without proof (round-2 review) ─────────────────────
  it("does not treat a models-only success as authenticated", () => {
    // grok emits this whenever `grok models` exits 0, even unauthenticated.
    expect(classifyProbeOutcome(result("warn", ["grok_models_probe_passed"])).outcome).toBe("unknown");
  });

  it("reports a hello-probe timeout as unknown, not verified", () => {
    expect(classifyProbeOutcome(result("warn", ["claude_hello_probe_timed_out"])).outcome).toBe("unknown");
    expect(classifyProbeOutcome(result("warn", ["opencode_hello_probe_timed_out"])).outcome).toBe("unknown");
  });

  it("reports a deliberately skipped live probe as unverifiable, not unknown", () => {
    // A custom `command` makes the adapter skip the live probe entirely
    // (packages/adapters/claude-local/src/server/test.ts:173-180). We cannot
    // prove auth, but this is a valid operator choice.
    expect(
      classifyProbeOutcome(result("pass", ["claude_hello_probe_skipped_custom_command"])).outcome,
    ).toBe("unverifiable");
    expect(
      classifyProbeOutcome(result("pass", ["codex_hello_probe_skipped_custom_command"])).outcome,
    ).toBe("unverifiable");
  });

  // COMPOSITE: the realistic custom-command result. These adapters emit a
  // missing-key hint AND the skip code together; if hints were checked first
  // this would wrongly become needs_auth and block onboarding forever.
  it("prefers unverifiable over a credential hint for custom-command setups", () => {
    expect(
      classifyProbeOutcome(
        result("warn", ["codex_openai_api_key_missing", "codex_hello_probe_skipped_custom_command"]),
      ).outcome,
    ).toBe("unverifiable");
    expect(
      classifyProbeOutcome(
        result("warn", ["gemini_api_key_missing", "gemini_hello_probe_skipped_custom_command"]),
      ).outcome,
    ).toBe("unverifiable");
    expect(
      classifyProbeOutcome(
        result("warn", ["cursor_api_key_missing", "cursor_hello_probe_skipped_custom_command"]),
      ).outcome,
    ).toBe("unverifiable");
  });

  // SYNTHETIC fixture — unlike every other composite in this file, this pair
  // cannot occur in a real probe: claude's skip and hello branches are the two
  // arms of one `if (!commandLooksLike(...))` (claude-local/src/server/test.ts
  // ~173-180), so exactly one of them fires. Kept as a defensive assertion that
  // rule 1 outranks rule 4; don't go hunting for the adapter path.
  it("still reports a real auth failure even with a skipped probe present", () => {
    expect(
      classifyProbeOutcome(
        result("warn", ["claude_hello_probe_skipped_custom_command", "claude_hello_probe_auth_required"]),
      ).outcome,
    ).toBe("needs_auth");
  });

  it("reports quota exhaustion as unknown rather than Ready", () => {
    expect(classifyProbeOutcome(result("warn", ["gemini_hello_probe_quota_exhausted"])).outcome).toBe("unknown");
  });

  it("never returns verified without an authoritative success code", () => {
    const noSuccess = result("pass", ["some_adapter_info_note"]);
    expect(classifyProbeOutcome(noSuccess).outcome).not.toBe("verified");
  });

  // cursor-cloud is the one adapter whose authoritative success is not a hello
  // probe (packages/adapters/cursor-cloud/src/server/test.ts:121).
  it("treats cursor-cloud's auth_ok as an authoritative success", () => {
    expect(classifyProbeOutcome(result("pass", ["cursor_cloud_auth_ok"])).outcome).toBe("verified");
  });

  // Codex P2 (classify-probe.ts:98): `_auth_ok` proves the KEY is valid, not that
  // the agent can RUN. cursor-cloud emits `cursor_cloud_auth_ok` (info) ALONGSIDE
  // `cursor_cloud_repo_missing`/`_repo_invalid` (error, status "fail") when the
  // agent has no usable repo (cursor-cloud/src/server/test.ts:85-98). A valid key
  // on an unrunnable agent must NOT read Ready — the hard failure wins.
  it("does not verify cursor-cloud when a hard config check failed despite auth_ok", () => {
    expect(
      classifyProbeOutcome(result("fail", ["cursor_cloud_auth_ok", "cursor_cloud_repo_missing"])).outcome,
    ).toBe("failed");
    expect(
      classifyProbeOutcome(result("fail", ["cursor_cloud_auth_ok", "cursor_cloud_repo_invalid"])).outcome,
    ).toBe("failed");
  });

  // The counterpart: `_auth_ok` still reads verified when nothing hard-failed
  // (a cosmetic warn must not demote a valid, runnable cursor-cloud agent).
  it("still verifies cursor-cloud auth_ok when the probe did not hard-fail", () => {
    expect(
      classifyProbeOutcome(result("warn", ["cursor_cloud_auth_ok", "cursor_cloud_repo_present"])).outcome,
    ).toBe("verified");
  });

  // A live run outranks a hard failure (unlike `_auth_ok`): a passed hello probe
  // IS the run succeeding, so an unrelated failing check must not demote it.
  it("keeps a passed hello probe verified even if the overall status is fail", () => {
    expect(
      classifyProbeOutcome(result("fail", ["claude_hello_probe_passed", "claude_some_cosmetic_error"])).outcome,
    ).toBe("verified");
  });

  // ── Expired sessions (revoked login) ─────────────────────────────────────
  // `_auth_required` = never signed in. `_auth_expired` = signed in, but the
  // session was revoked. Both are recoverable in-app, so both are needs_auth —
  // without this, an expired session falls through to `status === "fail"` and
  // the founder is told the CLI failed, with no recovery offered.
  it("detects an expired session as needs_auth", () => {
    expect(
      classifyProbeOutcome(result("fail", ["claude_hello_probe_auth_expired"])).outcome,
    ).toBe("needs_auth");
    expect(
      classifyProbeOutcome(result("fail", ["codex_hello_probe_auth_expired"])).outcome,
    ).toBe("needs_auth");
  });

  // Same precedence as `_auth_required`: rule 1 beats rule 2. A revoked session
  // alongside a stale live-success code must still route to sign-in.
  it("prefers an expired session over an authoritative live success", () => {
    expect(
      classifyProbeOutcome(
        result("warn", ["claude_hello_probe_passed", "claude_hello_probe_auth_expired"]),
      ).outcome,
    ).toBe("needs_auth");
  });

  // We match the code SUFFIX, not a substring. A loose `includes("auth_expired")`
  // would swallow unrelated codes that merely mention an expiry and wrongly send
  // an authenticated founder to a sign-in screen. `some_adapter_auth_expired_warning`
  // is the one that actually pins suffix-vs-substring — it CONTAINS "auth_expired"
  // but does not end with "_auth_expired".
  it("does not treat a near-miss expiry code as needs_auth", () => {
    expect(
      classifyProbeOutcome(result("warn", ["some_adapter_auth_expired_warning"])).outcome,
    ).not.toBe("needs_auth");
    expect(
      classifyProbeOutcome(result("warn", ["some_adapter_token_expired_warning"])).outcome,
    ).not.toBe("needs_auth");
    expect(classifyProbeOutcome(result("warn", ["gemini_cache_expired"])).outcome).not.toBe(
      "needs_auth",
    );
  });

  it("passes the probe result straight through", () => {
    const r = result("pass", ["claude_hello_probe_passed"]);
    expect(classifyProbeOutcome(r).result).toBe(r);
  });

  // ── CROSS-LAYER CONTRACT (provider-readiness ↔ #295 adapter probes) ───────
  // This block is the single reviewable proof that MY classifier consumes the
  // codes #295's adapter `testEnvironment` probes actually EMIT. Each string is
  // the real literal at the cited source line — the two layers are otherwise
  // wired only by naming convention (no shared exported registry; that
  // consolidation is a tracked follow-up). If #295 renames an emitted code,
  // update the literal here and the assertion catches any classifier drift.
  //
  // Emitter sources (verified against the integrated branch):
  //   claude-local  packages/adapters/claude-local/src/server/test.ts
  //     :269 codes { expired: "claude_hello_probe_auth_expired",
  //                  required: "claude_hello_probe_auth_required" }
  //     :289 "claude_hello_probe_passed"  ·  :134 "claude_command_unresolvable"
  //     :177 "claude_hello_probe_skipped_custom_command"
  //     :233 "claude_hello_probe_timed_out"
  // Consumer: classifyProbeOutcome (this file's subject).
  describe("consumes every code #295's claude-local probe emits", () => {
    const CONTRACT: Array<[string, string]> = [
      ["claude_hello_probe_passed", "verified"],
      ["claude_hello_probe_auth_required", "needs_auth"],
      ["claude_hello_probe_auth_expired", "needs_auth"],
      ["claude_command_unresolvable", "not_installed"],
      ["claude_hello_probe_skipped_custom_command", "unverifiable"],
      ["claude_hello_probe_timed_out", "unknown"],
    ];
    it.each(CONTRACT)("maps emitted %s → %s", (code, outcome) => {
      const status = code.endsWith("_passed") || code.endsWith("_custom_command") ? "pass" : "warn";
      expect(classifyProbeOutcome(result(status as "pass" | "warn", [code])).outcome).toBe(outcome);
    });
  });
});
