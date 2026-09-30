// DEP-010 (Sprint 2) — the resolver is the ONE place a sandbox provider is constructed.
//
// It pairs the REAL `E2bSandboxProvider` with a MOCK transport through the injected module
// seam, so the mock is NEVER reachable from production code (production uses the default loader,
// which imports the real package). What is proven here: the shipped default never loads the
// SDK, a bad configuration REFUSES rather than degrading, an opt-in produces a real provider,
// and the default loader really resolves the real package (non-vacuity).

import { describe, expect, it, vi } from "vitest";
import {
  resolveSandboxProvider,
  loadProviderModule,
  PROVIDER_ENV,
  TEMPLATE_ENV,
  type ProviderModule,
  type ProviderModuleLoader,
} from "../bin/sandbox-provider.js";
import { E2bSandboxProvider, createMockE2bTransport } from "@armyofagents/sandbox-e2b-provider";

// A loader that pairs the REAL provider class with a MOCK transport (or a throwing factory).
// `resolveSandboxProvider` reads only the env it is PASSED, so no case depends on process.env.
function seam(over: Partial<ProviderModule> = {}): ProviderModuleLoader {
  return async () => ({
    E2bSandboxProvider: E2bSandboxProvider as never,
    createRealE2bTransport: (() => createMockE2bTransport()) as never,
    ...over,
  });
}

describe("DEP-010 — resolveSandboxProvider: resolve or refuse, never guess", () => {
  it("gate UNSET ⇒ {kind:'none'} and the loader is NEVER called", async () => {
    // The e2b SDK must not enter the process image of a default desktop boot.
    const load = vi.fn(seam());
    const result = await resolveSandboxProvider({}, load);
    expect(result).toEqual({ kind: "none" });
    expect(load).not.toHaveBeenCalled();
  });

  it("explicit 'none' ⇒ {kind:'none'} and the loader is NEVER called", async () => {
    const load = vi.fn(seam());
    const result = await resolveSandboxProvider({ [PROVIDER_ENV]: "none" }, load);
    expect(result).toEqual({ kind: "none" });
    expect(load).not.toHaveBeenCalled();
  });

  it("an UNRECOGNISED value ⇒ refused (NOT silently off)", async () => {
    const result = await resolveSandboxProvider({ [PROVIDER_ENV]: "docker" }, seam());
    expect(result.kind).toBe("refused");
  });

  it("e2b with NO template ⇒ refused", async () => {
    const result = await resolveSandboxProvider({ [PROVIDER_ENV]: "e2b" }, seam());
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toContain(TEMPLATE_ENV);
  });

  it("opted-in with a template ⇒ a REAL E2bSandboxProvider (non-vacuous)", async () => {
    const result = await resolveSandboxProvider({ [PROVIDER_ENV]: "e2b", [TEMPLATE_ENV]: "base" }, seam());
    expect(result.kind).toBe("provider");
    if (result.kind === "provider") {
      expect(result.provider).toBeInstanceOf(E2bSandboxProvider);
      expect(result.provider.advertisedOperations.has("create")).toBe(true);
    }
  });

  it("transport THROWS ⇒ refused, and the message PROPAGATES the credential name", async () => {
    // The refusal-when-no-key path. The throwing factory stands in for the real transport's
    // synchronous no-key throw; the resolver must propagate that message (which names the
    // provider-control credential) WITHOUT the resolver's own source ever naming it — the
    // boundary checker forbids that. This is deterministic: it never reads the ambient env.
    const throwing = seam({
      createRealE2bTransport: (() => {
        throw new Error("RealE2bTransport requires E2B_API_KEY (provider-control credential)");
      }) as never,
    });
    const result = await resolveSandboxProvider({ [PROVIDER_ENV]: "e2b", [TEMPLATE_ENV]: "base" }, throwing);
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toContain("E2B_API_KEY");
  });

  it("the DEFAULT loader really resolves @armyofagents/sandbox-e2b-provider (non-vacuity)", async () => {
    // No injection: proves the seam's default is the real package and not a stub. Credential-
    // free by construction — it imports the module, it does not construct a transport. (This
    // replaces the revision-1 assertion that read the ambient E2B_API_KEY; DEP-010 design D12.)
    const mod = await loadProviderModule();
    const real = await import("@armyofagents/sandbox-e2b-provider");
    expect(mod.E2bSandboxProvider).toBe(real.E2bSandboxProvider);
  });
});
