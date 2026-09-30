import { describe, expect, it } from "vitest";
import { mintRuntimeHookToken, registerRuntimeHook, resolveRuntimeHook, deregisterRuntimeHook, deregisterRuntimeHooksForRun, pruneExpiredRuntimeHooks } from "../services/runtime-hook-registry.js";

const entry = (over = {}) => ({ broker: {} as never, companyId: "c1", agentId: "a1", runId: "r1", expiresAt: new Date(Date.now() + 60_000), ...over });

describe("runtime-hook-registry", () => {
  it("mints unique >=32-byte base64url tokens", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) { const t = mintRuntimeHookToken(); expect(t).toMatch(/^[A-Za-z0-9_-]{43,}$/); seen.add(t); }
    expect(seen.size).toBe(1000);
  });
  it("register then resolve returns the entry; unknown returns null", () => {
    const t = mintRuntimeHookToken(); const e = entry(); registerRuntimeHook(t, e);
    expect(resolveRuntimeHook(t)).toEqual(e);
    expect(resolveRuntimeHook("nope-not-a-real-token-000000000000000000000")).toBeNull();
  });
  it("deregister removes the entry", () => {
    const t = mintRuntimeHookToken(); registerRuntimeHook(t, entry());
    deregisterRuntimeHook(t); expect(resolveRuntimeHook(t)).toBeNull();
  });
  it("expired entry resolves to null (lazy prune)", () => {
    const t = mintRuntimeHookToken(); registerRuntimeHook(t, entry({ expiresAt: new Date(Date.now() - 1000) }));
    expect(resolveRuntimeHook(t)).toBeNull();
  });
  it("resolve of a wrong-length token returns null without throwing", () => {
    expect(resolveRuntimeHook("short")).toBeNull();
  });
  it("pruneExpired drops only expired", () => {
    const live = mintRuntimeHookToken(); const dead = mintRuntimeHookToken();
    registerRuntimeHook(live, entry()); registerRuntimeHook(dead, entry({ expiresAt: new Date(Date.now() - 1) }));
    pruneExpiredRuntimeHooks();
    expect(resolveRuntimeHook(live)).not.toBeNull();
    expect(resolveRuntimeHook(dead)).toBeNull();
  });
  // R1 zombie-run teardown: cancelRun purges ALL hook tokens for a runId so a
  // zombie CLI whose process survived the kill can no longer resolve a broker.
  it("deregisterRuntimeHooksForRun removes every token for the run and leaves others", () => {
    const runToken1 = mintRuntimeHookToken();
    const runToken2 = mintRuntimeHookToken();
    const otherToken = mintRuntimeHookToken();
    registerRuntimeHook(runToken1, entry({ runId: "run-zombie" }));
    registerRuntimeHook(runToken2, entry({ runId: "run-zombie" }));
    registerRuntimeHook(otherToken, entry({ runId: "run-other" }));

    const removed = deregisterRuntimeHooksForRun("run-zombie");
    expect(removed).toBe(2);
    expect(resolveRuntimeHook(runToken1)).toBeNull();
    expect(resolveRuntimeHook(runToken2)).toBeNull();
    // A different run's token is untouched.
    expect(resolveRuntimeHook(otherToken)).not.toBeNull();
  });
  it("deregisterRuntimeHooksForRun is a 0-entry no-op for a run with no HTTP hook (e.g. codex_local)", () => {
    expect(deregisterRuntimeHooksForRun("run-never-registered")).toBe(0);
  });
});
