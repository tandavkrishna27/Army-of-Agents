import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolveRunScopedModel } from "../services/heartbeat-provider-resolution.js";
import { applyModelResolutionToConfig } from "../services/internal-agent/aoa-agents/runner-model-resolution.js";
import { DEFAULT_CODEX_CHAT_MODEL } from "../services/internal-agent/codex-model.js";
import { applyResolvedCredential } from "../services/provider-resolution.js";

// Phase 4 (Task 12) helper contract: the org heartbeat merges the resolved
// credential onto the 3-scope resolvedEnv via applyResolvedCredential. A legacy
// company-key patch must merge WITHOUT dropping model/cwd or the other scopes.
describe("heartbeat resolver merge preserves 3-scope env", () => {
  it("legacy company-key patch merges without dropping model/cwd", () => {
    const cfg = { env: { PROJECT_KEY: "p" }, model: "opus", cwd: "/w" };
    const out = applyResolvedCredential(cfg, {
      source: "legacy",
      envPatch: { ANTHROPIC_API_KEY: "sk-co" },
    });
    expect(out).toEqual({
      env: { PROJECT_KEY: "p", ANTHROPIC_API_KEY: "sk-co" },
      model: "opus",
      cwd: "/w",
    });
  });
});

const chatgpt = { adapterType: "codex_local", installed: true, authenticated: true, authMode: "chatgpt" as const, defaultModelResolved: "gpt-5.5" };

describe("resolveRunScopedModel (heartbeat/org path)", () => {
  it("corrects an incompatible codex model on chatgpt to gpt-5.5", () => {
    const cfg = resolveRunScopedModel("codex_local", { model: "gpt-5.3-codex", env: {} }, chatgpt);
    expect(cfg.model).toBe("gpt-5.5");
  });
  it("EDGE #5: resolves the budget-SWAPPED model, not the original (operates on the passed config only)", () => {
    // The seam is config-only and pure; the ordering guarantee (resolve AFTER the
    // cheap-model swap, BEFORE resolveGuardedAdapterExecutionContext) lives in the caller
    // and is proven by the "heartbeat wiring — edge #5 source-order guard" describe
    // below.
    const swapped = { model: "gpt-5.3-codex", env: {} };
    const cfg = resolveRunScopedModel("codex_local", swapped, chatgpt);
    expect(cfg.model).toBe("gpt-5.5");
  });
  it("strips an inherited company OPENAI_API_KEY (codex) the agent didn't set", () => {
    const cfg = resolveRunScopedModel("codex_local", { model: "gpt-5.5", env: {} }, chatgpt, { inheritedEnvOpenAiKey: "sk-company" });
    expect((cfg.env as Record<string, unknown>).OPENAI_API_KEY).toBeUndefined();
  });

  // Org↔crew runtime resolution parity (incl. opts forwarding). Pure, no DB —
  // relocated here from provider-switching.integration.test.ts so it runs on
  // EVERY platform. (In the integration file it forced the embedded-postgres
  // beforeAll to run on the Windows CI runner, where Postgres cannot start —
  // Issue #114 — tainting the whole suite; here it gains real Windows-CI signal.)
  it("case-2: resolveRunScopedModel is a faithful pass-through of applyModelResolutionToConfig (org↔crew parity)", () => {
    const status = { authMode: "chatgpt", defaultModelResolved: "gpt-5.5" } as const;
    // Pass the 4th `opts` arg on BOTH sides so the parity check also covers the
    // opts-forwarding path of the wrapper. (`inheritedEnvOpenAiKey` has no
    // observable effect on the returned config when the agent did not set its
    // own env key — the deeper env-strip hardening is owned by a separate PR;
    // here we only assert the org seam is a faithful pass-through.)
    const opts = { inheritedEnvOpenAiKey: "sk-company" };
    const viaOrg = resolveRunScopedModel("codex_local", { model: "gpt-5.3-codex", env: {} }, status, opts);
    const viaCrew = applyModelResolutionToConfig("codex_local", { model: "gpt-5.3-codex", env: {} }, status, opts);

    expect(viaOrg.model).toBe(DEFAULT_CODEX_CHAT_MODEL); // incompatible model corrected
    // Full-config deep-equal — non-tautological (a `.model`-only assertion would
    // miss divergence in env or any other field). Catches a future regression
    // where the wrapper stops forwarding args or the two paths drift apart.
    expect(viaOrg).toEqual(viaCrew);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Heartbeat wiring — edge-#5 source-order guard
//
// Relocated from provider-switching.integration.test.ts (a real-DB file) so it
// runs on every platform. WHY a source-order guard (not a spawn/spy test):
//   (a) Driving the real heartbeat `executeRun` is infeasible in this harness —
//       it is a deeply-nested private closure requiring the full run lifecycle,
//       adapter registry, and CLI binaries.
//   (b) Spying on `resolveAdapterExecutionContextUnguarded` is also infeasible: it is
//       called SAME-MODULE inside heartbeat.ts, so an external `vi.spyOn` cannot
//       intercept the internal call (ES-module live binding, no proxy).
//   So we verify the critical ordering invariant structurally from source —
//   deterministic, fast, cross-platform, no CLI dependencies. If an anchor string
//   ever changes, this fails loudly, forcing a reviewer to confirm the edge-#5
//   ordering is still correct in the new code.
// ─────────────────────────────────────────────────────────────────────────────

describe("heartbeat wiring — edge #5 source-order guard", () => {
  it("resolveRunScopedModel is called AFTER cheap-model swap and BEFORE resolveGuardedAdapterExecutionContext", async () => {
    const src = await readFile(new URL("../services/heartbeat.ts", import.meta.url), "utf8");

    // Anchor 1: cheap-model swap (budget-based model override)
    const iCheapSwap = src.indexOf("runScopedConfig = { ...runScopedConfig, model: cheapModel }");
    // Anchor 2: provider-switching resolution (edge #5)
    const iResolve = src.indexOf("runScopedConfig = resolveRunScopedModel(");
    // Anchor 3: adapter execution-context build (must come AFTER resolution)
    // Use the destructure form to target the CALL SITE, not the exported function definition.
    // D1: the org-agent dispatch now routes through the guarded combinator
    // (resolveGuardedAdapterExecutionContext) which internally calls
    // resolveAdapterExecutionContextUnguarded + the unsandboxed multi-tenant gate.
    const iContext = src.indexOf("const { executionTarget, runtimeCommandSpec } = resolveGuardedAdapterExecutionContext(");

    // Each anchor must exist verbatim — fail loudly if any moved (wiring was refactored)
    expect(iCheapSwap, "anchor 'cheap-model swap' not found in heartbeat.ts — wiring may have changed; update this guard").toBeGreaterThan(-1);
    expect(iResolve, "anchor 'resolveRunScopedModel call' not found in heartbeat.ts — wiring may have changed; update this guard").toBeGreaterThan(-1);
    expect(iContext, "anchor 'resolveGuardedAdapterExecutionContext destructure call' not found in heartbeat.ts — wiring may have changed; update this guard").toBeGreaterThan(-1);

    // Edge #5 ordering: cheap-swap < resolve < context-build
    expect(iResolve).toBeGreaterThan(iCheapSwap);
    expect(iContext).toBeGreaterThan(iResolve);
  });

  // Auth detection must reflect what the run actually authenticates with: the
  // agent's OWN keys AND the company provider-key fallback (the last stop before
  // host login), but NOT project/environment keys (app/test creds, not codex
  // auth). Using agentEnvRecord alone (the pre-fallback agent env) misread a
  // codex agent on ONLY the company Providers key as ChatGPT-mode and downgraded
  // its api-key-only model (Codex P2). The detection env is therefore built from
  // the resolved runtime env minus the project/environment-sourced keys.
  it("provider-status detection uses agent + company keys, excluding project/environment", async () => {
    const src = await readFile(new URL("../services/heartbeat.ts", import.meta.url), "utf8");
    // getProviderStatus receives the purpose-built authDetectionEnv, NOT the raw
    // agent-only env (which omitted the company fallback) and NOT the full merged
    // runScopedConfig.env (which would leak project/environment keys).
    expect(
      src,
      "getProviderStatus must be passed authDetectionEnv (agent + company fallback, minus project/environment)",
    ).toContain("adapterConfig: { ...runScopedConfig, env: authDetectionEnv }");
    // The detection env excludes project/environment-sourced keys.
    expect(src).toContain('.filter(([, source]) => source === "project" || source === "environment")');
    // The merged runtime env must be preserved for the workspace: the seam must
    // NOT strip it by threading agentOwnEnv into resolveRunScopedModel.
    expect(
      src,
      "resolveRunScopedModel must NOT receive agentOwnEnv — the merged project/environment key stays in the runtime env",
    ).not.toContain("agentOwnEnv");
  });
});
