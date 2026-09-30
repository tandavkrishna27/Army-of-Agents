import { describe, it, expect, vi, beforeEach } from "vitest";
import { persistCommanderApiKey, type PersistCommanderKeyDeps } from "../services/commander-key.js";

function makeDeps() {
  const calls = { write: [] as unknown[], update: [] as unknown[], sync: [] as unknown[] };
  const deps: PersistCommanderKeyDeps = {
    writeSecret: vi.fn(async (a) => { calls.write.push(a); return { secretId: "sec-1" }; }),
    updateAgentAdapterConfig: vi.fn(async (a) => { calls.update.push(a); }),
    syncEnvBindings: vi.fn(async (a) => { calls.sync.push(a); }),
  };
  return { deps, calls };
}

describe("persistCommanderApiKey (Plan 3 T2)", () => {
  let d: ReturnType<typeof makeDeps>;
  beforeEach(() => (d = makeDeps()));

  it("writes the key to the vault and binds a secret_ref into the agent env (no plaintext)", async () => {
    const r = await persistCommanderApiKey(d.deps, {
      companyId: "c1",
      agentId: "cmd-agent",
      provider: "anthropic",
      apiKey: "sk-ant-SUPERSECRET",
      adapterConfig: { model: "x", env: { KEEP: "v" } },
    });
    expect(r).toEqual({ secretId: "sec-1" });

    // raw key → the encrypted vault
    expect(JSON.stringify(d.calls.write[0])).toContain("sk-ant-SUPERSECRET");

    // agent env gets a secret_ref for ANTHROPIC_API_KEY, preserving other env; NO plaintext
    const update = d.calls.update[0] as { adapterConfig: { env: Record<string, unknown> } };
    expect(update.adapterConfig.env.ANTHROPIC_API_KEY).toEqual({
      type: "secret_ref",
      secretId: "sec-1",
      version: "latest",
    });
    expect(update.adapterConfig.env.KEEP).toBe("v");
    expect(JSON.stringify(d.calls.update)).not.toContain("sk-ant-SUPERSECRET");

    // binding sync runs for the agent target with the merged env
    expect(d.calls.sync[0]).toMatchObject({ targetId: "cmd-agent" });
  });

  it("maps openai → OPENAI_API_KEY", async () => {
    await persistCommanderApiKey(d.deps, {
      companyId: "c1",
      agentId: "a",
      provider: "openai",
      apiKey: "sk-oai",
      adapterConfig: {},
    });
    const update = d.calls.update[0] as { adapterConfig: { env: Record<string, unknown> } };
    expect(update.adapterConfig.env.OPENAI_API_KEY).toMatchObject({ type: "secret_ref" });
  });
});
