import { describe, expect, it } from "vitest";
import {
  SupersededKeyGenerationError,
  assertKeyGenerationCurrent,
  resolveE2bCredentialAuthority,
  type E2bCredentialResolverDeps,
} from "../services/e2b-credential-authority.js";

describe("MIG-008 D3 — old-key denial (AoA-side, SECRET-AWARE)", () => {
  it("accepts the current key generation (same secret + version)", () => {
    expect(() => assertKeyGenerationCurrent("secret-a:5", "secret-a:5")).not.toThrow();
  });

  it("refuses a strictly-older version of the SAME secret", () => {
    expect(() => assertKeyGenerationCurrent("secret-a:4", "secret-a:5")).toThrow(SupersededKeyGenerationError);
  });

  it("never treats a newer version of the same secret as superseded", () => {
    expect(() => assertKeyGenerationCurrent("secret-a:6", "secret-a:5")).not.toThrow();
  });

  it("refuses a key from a REPOINTED-AWAY secret even when its bare version looks newer (the rotation bug)", () => {
    // The ordinary "replace my E2B key" rotation: old secret at version 5 is repointed to
    // a fresh secret whose versions restart at 1. A bare-version compare (5 < 1 === false)
    // would ACCEPT the rotated-away key — the secret-aware identity refuses it.
    expect(() => assertKeyGenerationCurrent("secret-old:5", "secret-new:1")).toThrow(
      SupersededKeyGenerationError,
    );
  });

  it("fails CLOSED on an unparseable generation string", () => {
    expect(() => assertKeyGenerationCurrent("garbage", "secret-a:5")).toThrow(SupersededKeyGenerationError);
  });
});

describe("MIG-008 D3 — credential authority at the boundary", () => {
  const baseDeps = (over: Partial<E2bCredentialResolverDeps> = {}): E2bCredentialResolverDeps => ({
    env: { E2B_API_KEY: "confined-default-key" },
    resolvePerCompanyConfig: async () => ({}),
    currentKeyGeneration: async () => "secret-a:1",
    ...over,
  });

  it("resolves the default key from the confined env (no per-company BYO)", async () => {
    const res = await resolveE2bCredentialAuthority({ companyId: "co-1" }, baseDeps());
    expect(res.apiKey).toBe("confined-default-key");
    expect(res.keyGeneration).toBe("secret-a:1");
  });

  it("injects a per-company BYO key resolved via resolveRuntimeProviderConfig", async () => {
    const res = await resolveE2bCredentialAuthority(
      { companyId: "co-2" },
      baseDeps({
        resolvePerCompanyConfig: async () => ({ resolvedApiKey: "byo-company-key" }),
        currentKeyGeneration: async () => "secret-b:7",
      }),
    );
    expect(res.apiKey).toBe("byo-company-key");
    expect(res.keyGeneration).toBe("secret-b:7");
  });

  it("never returns/persists key material beyond the apiKey it injects", async () => {
    const res = await resolveE2bCredentialAuthority(
      { companyId: "co-3" },
      baseDeps({ resolvePerCompanyConfig: async () => ({ resolvedApiKey: "byo" }) }),
    );
    // The result carries ONLY the apiKey to inject + the attribution tag — no config blob.
    expect(Object.keys(res).sort()).toEqual(["apiKey", "keyGeneration"]);
  });

  it("refuses to resolve/inject when a superseded generation is requested (old-key denial)", async () => {
    await expect(
      resolveE2bCredentialAuthority(
        { companyId: "co-4", requestedKeyGeneration: "secret-old:2" },
        baseDeps({ currentKeyGeneration: async () => "secret-new:9" }),
      ),
    ).rejects.toBeInstanceOf(SupersededKeyGenerationError);
  });

  it("throws when neither a per-company BYO key nor a confined env default is available", async () => {
    await expect(
      resolveE2bCredentialAuthority(
        { companyId: "co-5" },
        baseDeps({ env: {}, resolvePerCompanyConfig: async () => ({}) }),
      ),
    ).rejects.toThrow();
  });
});
