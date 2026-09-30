import { describe, it, expect } from "vitest";
import { buildSandboxEnvAllowlist } from "@armyofagents/adapter-utils";
import { applyModelResolutionToConfig } from "../services/internal-agent/aoa-agents/runner-model-resolution.js";

/**
 * U5 interlock (crew half). Two independently-implemented mechanisms must
 * compose to keep the AoA server's ambient/embeddings OPENAI_API_KEY out of a
 * codex sandbox run while letting an agent's OWN configured OPENAI_API_KEY
 * through:
 *
 *  1. `applyModelResolutionToConfig` (runner-model-resolution.ts) strips the
 *     inherited/ambient OPENAI_API_KEY from `adapterConfig.env` BEFORE the run
 *     overlay is built — unless the agent itself set the key.
 *  2. `buildSandboxEnvAllowlist` (adapter-utils) only admits OPENAI_API_KEY
 *     into the VM env for an `openai`-provider run in the first place.
 *
 * This test locks the composition so a future edit to either half alone can't
 * silently reintroduce the embeddings-key leak into a sandboxed codex run.
 */
describe("U5 interlock — runner-model-resolution strip + buildSandboxEnvAllowlist", () => {
  const status = { authMode: "chatgpt" as const, defaultModelResolved: "gpt-5.5" };

  it("agent set NO own key: the ambient embeddings OPENAI_API_KEY never reaches the VM env", () => {
    const ambientEmbeddingsKey = "sk-embeddings-key";

    // Step 1 — the runner applies model resolution + the env-strip BEFORE
    // building the run overlay. The agent's own adapterConfig.env carries no
    // OPENAI_API_KEY, so the ambient key gets deleted.
    const resolvedConfig = applyModelResolutionToConfig(
      "codex_local",
      { model: "gpt-5.5", env: {} },
      status,
      { inheritedEnvOpenAiKey: ambientEmbeddingsKey },
    );
    const configEnv = (resolvedConfig.env as Record<string, string>) ?? {};
    expect(configEnv.OPENAI_API_KEY).toBeUndefined();

    // Step 2 — the overlay reaching the sandbox chokepoint is built from that
    // same (already-stripped) config.env, so it carries no OPENAI_API_KEY
    // either.
    const overlay = { ...configEnv };
    expect(overlay.OPENAI_API_KEY).toBeUndefined();

    // Step 3 — even if it HAD survived, buildSandboxEnvAllowlist is the
    // second, independent gate: assert directly that an overlay without the
    // agent's own key produces no OPENAI_API_KEY in the VM env.
    const vmEnv = buildSandboxEnvAllowlist(overlay, { provider: "openai" });
    expect(vmEnv.OPENAI_API_KEY).toBeUndefined();
  });

  it("agent DID set its own key: it survives both the strip and the allowlist", () => {
    const ambientEmbeddingsKey = "sk-embeddings-key";
    const agentOwnKey = "sk-agent-own-openai-key";

    // Step 1 — the agent's own adapterConfig.env carries OPENAI_API_KEY, so
    // applyModelResolutionToConfig must NOT strip it even though the ambient
    // embeddings key is also present in process.env.
    const resolvedConfig = applyModelResolutionToConfig(
      "codex_local",
      { model: "gpt-5.5", env: { OPENAI_API_KEY: agentOwnKey } },
      status,
      { inheritedEnvOpenAiKey: ambientEmbeddingsKey },
    );
    const configEnv = (resolvedConfig.env as Record<string, string>) ?? {};
    expect(configEnv.OPENAI_API_KEY).toBe(agentOwnKey);

    // Step 2 — the overlay carries the agent's own key through to the
    // sandbox chokepoint.
    const overlay = { ...configEnv };
    expect(overlay.OPENAI_API_KEY).toBe(agentOwnKey);

    // Step 3 — buildSandboxEnvAllowlist admits it because this IS an
    // openai-provider run and the key is the agent's own resolved key, not
    // the host-side-only embeddings key (which never appears in an overlay).
    const vmEnv = buildSandboxEnvAllowlist(overlay, { provider: "openai" });
    expect(vmEnv.OPENAI_API_KEY).toBe(agentOwnKey);
  });

  it("a claude (anthropic-provider) run never admits OPENAI_API_KEY even if somehow present in the overlay", () => {
    // Defense in depth: the embeddings key is host-side only and should never
    // appear in a claude run's overlay at all — but if it did (e.g. a future
    // regression merges process.env in), the provider gate must still block it.
    const overlay = { ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-embeddings-key" };
    const vmEnv = buildSandboxEnvAllowlist(overlay, { provider: "anthropic" });
    expect(vmEnv.ANTHROPIC_API_KEY).toBe("sk-ant");
    expect(vmEnv.OPENAI_API_KEY).toBeUndefined();
  });
});
