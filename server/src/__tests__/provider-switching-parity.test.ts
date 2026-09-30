/**
 * provider-switching-parity.test.ts  (Unit 11 — Part A)
 *
 * PURE / CONTRACT TEST — no real DB, no embedded-postgres, runs on Windows.
 *
 * Proves that the crew path (applyModelResolutionToConfig) and the Commander
 * codex-chat path (resolveCodexChatModel) AGREE on the resolved model string
 * for the same (model, sharedModel) inputs when authMode is NOT "apikey"
 * (i.e. chatgpt / unknown — the subscriber flow where ChatGPT-incompatible
 * codex models must be corrected to the safe default).
 *
 * If crew and Commander diverge, a user with a ChatGPT Codex subscription
 * would get gpt-5.5 on the Commander chat but still 400 on crew runs (or
 * vice-versa). Parity here is a hard contract.
 *
 * Covered cases (all under authMode="chatgpt"):
 *  1. Compatible model  : "gpt-5.5"          → both return "gpt-5.5"
 *  2. Bad default model : "gpt-5.3-codex"     → both return "gpt-5.5"
 *  3. Empty model       : ""                  → both return "gpt-5.5"
 *  4. Another bad model : "gpt-5.2-codex"     → both return "gpt-5.5"
 *  5. authMode=unknown  : "gpt-5.3-codex"     → both return "gpt-5.5"
 *
 * The test imports the REAL functions (no mocks) so any future drift
 * between the two codepaths will fail this test immediately.
 */

import { describe, it, expect } from "vitest";
import { applyModelResolutionToConfig } from "../services/internal-agent/aoa-agents/runner-model-resolution.js";
import { resolveCodexChatModel, DEFAULT_CODEX_CHAT_MODEL } from "../services/internal-agent/codex-model.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the crew path for a codex_local agent under the given authMode.
 * Extracts the resolved model string from the returned config.
 */
function crewResolved(
  model: string,
  sharedModel: string | null,
  authMode: "chatgpt" | "subscription" | "unknown" = "chatgpt",
): string {
  const result = applyModelResolutionToConfig(
    "codex_local",
    { model },
    { authMode, defaultModelResolved: sharedModel },
  );
  // applyModelResolutionToConfig returns a Record; model is the resolved field.
  return result.model as string;
}

/**
 * Run the Commander codex-chat path.
 */
function commanderResolved(
  model: string,
  sharedModel: string | null,
): string {
  return resolveCodexChatModel(model || null, sharedModel);
}

// ─────────────────────────────────────────────────────────────────────────────
// Parity suite
// ─────────────────────────────────────────────────────────────────────────────

describe("provider-switching parity: crew (applyModelResolutionToConfig) === Commander (resolveCodexChatModel)", () => {
  const SAFE_DEFAULT = DEFAULT_CODEX_CHAT_MODEL; // "gpt-5.5"

  it("case 1 — compatible model: gpt-5.5 → both resolve to gpt-5.5 (no correction needed)", () => {
    const model = "gpt-5.5";
    const shared = null;
    const crew = crewResolved(model, shared);
    const commander = commanderResolved(model, shared);
    expect(crew).toBe(SAFE_DEFAULT);
    expect(commander).toBe(SAFE_DEFAULT);
    expect(crew).toBe(commander);
  });

  it("case 2 — bad default: gpt-5.3-codex → both correct to gpt-5.5 (codex family, not ChatGPT-safe)", () => {
    const model = "gpt-5.3-codex";
    const shared = null;
    const crew = crewResolved(model, shared);
    const commander = commanderResolved(model, shared);
    expect(crew).toBe(SAFE_DEFAULT);
    expect(commander).toBe(SAFE_DEFAULT);
    expect(crew).toBe(commander);
  });

  it("case 3 — empty model string → both fall through all sources to gpt-5.5 default", () => {
    const model = "";
    const shared = null;
    const crew = crewResolved(model, shared);
    const commander = commanderResolved(model, shared);
    expect(crew).toBe(SAFE_DEFAULT);
    expect(commander).toBe(SAFE_DEFAULT);
    expect(crew).toBe(commander);
  });

  it("case 4 — another incompatible model: gpt-5.2-codex → both correct to gpt-5.5", () => {
    const model = "gpt-5.2-codex";
    const shared = null;
    const crew = crewResolved(model, shared);
    const commander = commanderResolved(model, shared);
    expect(crew).toBe(SAFE_DEFAULT);
    expect(commander).toBe(SAFE_DEFAULT);
    expect(crew).toBe(commander);
  });

  it("case 5 — authMode=unknown: gpt-5.3-codex → both correct to gpt-5.5 (same as chatgpt branch)", () => {
    // authMode="unknown" must be treated like chatgpt (no API key = no codex models)
    const model = "gpt-5.3-codex";
    const shared = null;
    const crew = crewResolved(model, shared, "unknown");
    const commander = commanderResolved(model, shared);
    expect(crew).toBe(SAFE_DEFAULT);
    expect(commander).toBe(SAFE_DEFAULT);
    expect(crew).toBe(commander);
  });

  it("case 6 — shared model as codex-compatible fallback: bad config model + gpt-5.5 shared → both use shared", () => {
    // sharedModel = gpt-5.5 is the user's ~/.codex/config.toml value.
    // A bad config model should not shadow a valid shared model.
    const model = "gpt-5.3-codex"; // bad → rejected
    const shared = "gpt-5.5";      // valid → used
    const crew = crewResolved(model, shared);
    const commander = commanderResolved(model, shared);
    expect(crew).toBe("gpt-5.5");
    expect(commander).toBe("gpt-5.5");
    expect(crew).toBe(commander);
  });

  it("case 7 — both model and shared are incompatible → both fall back to DEFAULT_CODEX_CHAT_MODEL", () => {
    const model = "gpt-5.3-codex";
    const shared = "gpt-5.2-codex";
    const crew = crewResolved(model, shared);
    const commander = commanderResolved(model, shared);
    expect(crew).toBe(SAFE_DEFAULT);
    expect(commander).toBe(SAFE_DEFAULT);
    expect(crew).toBe(commander);
  });

  it("case 8 — apikey authMode is crew-ONLY: crew passes gpt-5.3-codex through; commander is not called in apikey mode", () => {
    // This case is NOT a divergence — in apikey mode the crew path intentionally
    // does NOT correct incompatible models (the API key makes them valid).
    // Commander's resolveCodexChatModel is only called when the CLI tool is codex
    // and NOT in apikey mode. We document the asymmetry here as expected, not a bug.
    const model = "gpt-5.3-codex";
    const crewApikey = applyModelResolutionToConfig(
      "codex_local",
      { model },
      { authMode: "apikey", defaultModelResolved: null },
    ).model as string;
    // In apikey mode the crew passes the model through unchanged (valid for API-key logins).
    expect(crewApikey).toBe("gpt-5.3-codex");
    // Commander path always validates for ChatGPT compat; this divergence is expected.
    const commanderResult = commanderResolved(model, null);
    expect(commanderResult).toBe(SAFE_DEFAULT);
    // NOTE: crewApikey !== commanderResult here. This is the designed asymmetry:
    // crew knows the authMode and trusts apikey callers; Commander doesn't receive
    // authMode signals (it always validates for subscription compat). NOT a bug.
  });

  it("confirms DEFAULT_CODEX_CHAT_MODEL constant is gpt-5.5 (regression guard)", () => {
    // If this changes, every parity case above needs re-evaluation.
    expect(SAFE_DEFAULT).toBe("gpt-5.5");
  });
});
