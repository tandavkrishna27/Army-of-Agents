// U12: mapCloudProviderKeyError re-shapes the resolver's REAL cloud failure
// mode into founder-facing guidance. resolveProviderCredential THROWS
// ProviderUnavailableError on cloud when no company key is configured — it
// never returns source:"host_login_fallback" there (that branch is
// self-hosted-only). So the mechanism under test is a catch-mapper over a
// thrown error, not an assertion on a returned credential shape.
import { describe, it, expect } from "vitest";
import { mapCloudProviderKeyError, CloudProviderKeyMissingError } from "../services/internal-agent/require-cloud-provider-key.js";
import { ProviderUnavailableError } from "../services/provider-resolution.js";

describe("mapCloudProviderKeyError", () => {
  it("maps a thrown ProviderUnavailableError to founder guidance on cloud (the REAL no-key outcome — resolveProviderCredential THROWS, never returns host_login_fallback)", () => {
    const mapped = mapCloudProviderKeyError(
      new ProviderUnavailableError("anthropic", "no_assignment", null),
      { tenantIsolationEnforced: true, provider: "anthropic", sink: "crew agent" },
    );
    expect(mapped).toBeInstanceOf(CloudProviderKeyMissingError);
  });

  it("also maps a duck-typed { code: 'provider_unavailable' } (belt-and-suspenders across a module boundary)", () => {
    const mapped = mapCloudProviderKeyError(
      { code: "provider_unavailable" },
      { tenantIsolationEnforced: true, provider: "anthropic", sink: "crew agent" },
    );
    expect(mapped).toBeInstanceOf(CloudProviderKeyMissingError);
  });

  it("returns null on desktop / local_trusted (host login is legitimate; the resolver returns host_login_fallback and never throws)", () => {
    expect(mapCloudProviderKeyError(
      new ProviderUnavailableError("anthropic", "x", null),
      { tenantIsolationEnforced: false, provider: "anthropic", sink: "crew agent" },
    )).toBeNull();
  });

  it("returns null for an unrelated error (a real infra fault must NOT be reshaped into a key-missing message)", () => {
    expect(mapCloudProviderKeyError(
      new Error("ECONNRESET"),
      { tenantIsolationEnforced: true, provider: "anthropic", sink: "crew agent" },
    )).toBeNull();
  });

  it("guidance points at the provider key, never at 'install the CLI'", () => {
    const mapped = mapCloudProviderKeyError(
      new ProviderUnavailableError("anthropic", "x", null),
      { tenantIsolationEnforced: true, provider: "anthropic", sink: "crew agent" },
    )!;
    expect(mapped.message).toMatch(/provider (API )?key/i);
    expect(mapped.message).not.toMatch(/install/i);
  });
});
