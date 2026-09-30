import { describe, it, expect } from "vitest";
import { parseCodexAuthMode, getProviderStatus, type ProviderAuthMode } from "../provider-status.js";

describe("parseCodexAuthMode", () => {
  it("returns 'apikey' when a per-agent OPENAI_API_KEY is present", () => {
    expect(parseCodexAuthMode({ agentEnvApiKey: "sk-xyz", authJson: { auth_mode: "chatgpt" } }))
      .toBe("apikey");
  });
  it("returns 'chatgpt' from the managed auth.json when no per-agent key", () => {
    expect(parseCodexAuthMode({ agentEnvApiKey: null, authJson: { auth_mode: "chatgpt" } }))
      .toBe("chatgpt");
  });
  it("returns 'apikey' from auth.json OPENAI_API_KEY field with no agent key", () => {
    expect(parseCodexAuthMode({ agentEnvApiKey: null, authJson: { OPENAI_API_KEY: "sk-x" } }))
      .toBe("apikey");
  });
  it("returns 'unknown' when auth.json OPENAI_API_KEY is blank/whitespace (no usable key) — Codex P3", () => {
    // A stale/malformed shared auth.json with a blank key has nothing to copy
    // into the managed home; reporting apikey would preserve api-key-only codex
    // models and fail the run instead of falling back to the ChatGPT-safe default.
    expect(parseCodexAuthMode({ agentEnvApiKey: null, authJson: { OPENAI_API_KEY: "" } })).toBe("unknown");
    expect(parseCodexAuthMode({ agentEnvApiKey: null, authJson: { OPENAI_API_KEY: "   " } })).toBe("unknown");
  });
  it("returns 'unknown' for an empty/missing auth.json", () => {
    expect(parseCodexAuthMode({ agentEnvApiKey: null, authJson: null })).toBe("unknown");
  });
  it("IGNORES the company/server process.env.OPENAI_API_KEY entirely", () => {
    // Even if the server env has a key, detection must not treat it as the agent's auth.
    expect(parseCodexAuthMode({ agentEnvApiKey: null, authJson: { auth_mode: "chatgpt" }, serverEnvApiKey: "sk-company" }))
      .toBe("chatgpt");
  });
  it("returns 'apikey' from auth.json auth_mode field set to 'apikey'", () => {
    expect(parseCodexAuthMode({ agentEnvApiKey: null, authJson: { auth_mode: "apikey" } }))
      .toBe("apikey");
  });
});

// Type-level assertion: ProviderAuthMode must be importable and include these literals
const _typeCheck: ProviderAuthMode[] = ["subscription", "chatgpt", "apikey", "unknown"];
void _typeCheck;

describe("getProviderStatus (codex)", () => {
  const deps = {
    resolveSharedCodexHomeDir: () => "/shared/home",
    readAuthJson: async () => ({ auth_mode: "chatgpt" } as Record<string, unknown>),
    readSharedCodexModel: async () => "gpt-5.5",
    isInstalled: async () => true,
  };
  it("reports chatgpt + defaultModelResolved from the SHARED config, shared home for auth", async () => {
    const s = await getProviderStatus("codex_local",
      { companyId: "c1", adapterConfig: { env: {} } }, deps);
    expect(s.authMode).toBe("chatgpt");
    expect(s.defaultModelResolved).toBe("gpt-5.5");
    expect(s.installed).toBe(true);
    expect(s.authenticated).toBe(true);
  });
  it("a per-agent OPENAI_API_KEY flips to apikey", async () => {
    const s = await getProviderStatus("codex_local",
      { companyId: "c1", adapterConfig: { env: { OPENAI_API_KEY: "sk-agent" } } }, deps);
    expect(s.authMode).toBe("apikey");
  });
  it("a per-agent OPENAI_API_KEY stored as a normalized plain binding flips to apikey (Codex P2)", async () => {
    // Saved adapter env entries are normalized to binding objects, so a raw-string
    // check misses a UI-configured per-agent key → false managed-auth fallback.
    const s = await getProviderStatus("codex_local",
      { companyId: "c1", adapterConfig: { env: { OPENAI_API_KEY: { type: "plain", value: "sk-agent" } } } }, deps);
    expect(s.authMode).toBe("apikey");
  });
  it("a per-agent OPENAI_API_KEY stored as a secret_ref binding flips to apikey (Codex P2)", async () => {
    const s = await getProviderStatus("codex_local",
      { companyId: "c1", adapterConfig: { env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" } } } }, deps);
    expect(s.authMode).toBe("apikey");
  });
  it("a blank plain-binding OPENAI_API_KEY does NOT flip to apikey", async () => {
    const s = await getProviderStatus("codex_local",
      { companyId: "c1", adapterConfig: { env: { OPENAI_API_KEY: { type: "plain", value: "" } } } }, deps);
    expect(s.authMode).toBe("chatgpt");
  });
  it("reads the SHARED codex home (run auth source), not an empty per-company managed home (Codex P2)", async () => {
    // First crew run of a company with shared API-key auth: the per-company
    // managed home doesn't exist yet (the run will copy the shared auth.json
    // into it). Status must reflect the shared source — else apikey-only models
    // get wrongly rewritten to gpt-5.5 on the first run.
    const sharedDeps = {
      resolveSharedCodexHomeDir: () => "/shared/home",
      readAuthJson: async (home: string) =>
        home === "/shared/home" ? ({ auth_mode: "apikey" } as Record<string, unknown>) : null,
      readSharedCodexModel: async () => "gpt-5.5",
      isInstalled: async () => true,
    };
    const s = await getProviderStatus("codex_local",
      { companyId: "first-run-co", adapterConfig: { env: {} } }, sharedDeps);
    expect(s.authMode).toBe("apikey");
  });
  it("a blank shared auth.json OPENAI_API_KEY does NOT report apikey (Codex P3)", async () => {
    const blankKeyDeps = { ...deps, readAuthJson: async () => ({ OPENAI_API_KEY: "  " } as Record<string, unknown>) };
    const s = await getProviderStatus("codex_local",
      { companyId: "c1", adapterConfig: { env: {} } }, blankKeyDeps);
    expect(s.authMode).toBe("unknown");
    expect(s.authenticated).toBe(false);
  });
  it("propagates apikey auth_mode from the managed auth.json through to authenticated", async () => {
    const apikeyDeps = { ...deps, readAuthJson: async () => ({ auth_mode: "apikey" } as Record<string, unknown>) };
    const s = await getProviderStatus("codex_local",
      { companyId: "c1", adapterConfig: { env: {} } }, apikeyDeps);
    expect(s.authMode).toBe("apikey");
    expect(s.authenticated).toBe(true);
  });
});
