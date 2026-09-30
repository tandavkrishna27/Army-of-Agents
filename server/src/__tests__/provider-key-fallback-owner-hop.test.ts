/**
 * Task 8 — the company-key fallback MUST resolve the credential OWNER, not the
 * borrower's own spec.
 *
 * Some providers READ a credential another provider OWNS (pi → anthropic,
 * cursor_cloud → cursor). Task 7 exported `resolveProviderKeyTarget` precisely
 * so the runtime fallback reuses that owner hop instead of reimplementing it —
 * a lookup on the borrower's own name would find nothing right after a
 * successful save.
 *
 * WHY THIS FILE IS SEPARATE: today's catalog has every borrower COPY its
 * owner's envVar and secretName, so for THOSE TWO FIELDS "hopped to the owner"
 * and "read my own spec" are indistinguishable against the real catalog.
 * Mocking the provider-key module to return a different env var makes the
 * delegation directly observable.
 *
 * CORRECTION to an earlier claim here: a real-catalog test *can* also kill this
 * regression, because `ownerId` is NOT copied — pi's owner is `anthropic`, and
 * it surfaces unmocked in the audit row's `consumerId: provider-key:<ownerId>`.
 * That stronger, mock-free test lives in provider-key-fallback.test.ts
 * ("resolves a BORROWER against the credential owner's secret and audits the
 * owner"). This file is kept as the narrow unit-level pin on the delegation
 * itself.
 */
import { describe, it, expect, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({
  companySecretBindings: makeTableProxy("company_secret_bindings"),
  companySecretProviderConfigs: makeTableProxy("company_secret_provider_configs"),
  companySecrets: makeTableProxy("company_secrets"),
  companySecretVersions: makeTableProxy("company_secret_versions"),
  runtimeProviderKeys: makeTableProxy("runtime_provider_keys"),
  secretAccessEvents: makeTableProxy("secret_access_events"),
}));
vi.mock("../secrets/provider-registry.js", () => ({
  getSecretProvider: () => ({ resolveVersion: async () => "" }),
  listSecretProviders: () => [],
}));

const OWNER_HOP_VAR = "OWNER_HOP_VAR";

/**
 * Stands in for Task 7's real resolver. It returns a target that does NOT match
 * the borrower's own catalog spec, so only an implementation that actually
 * delegates can produce it.
 */
vi.mock("../services/providers/provider-key.js", () => ({
  resolveProviderKeyTarget: (providerId: string) => {
    if (providerId === "pi" || providerId === "anthropic") {
      return { ownerId: "anthropic", secretName: "provider:anthropic", envVar: OWNER_HOP_VAR };
    }
    if (providerId === "cursor_cloud" || providerId === "cursor") {
      return { ownerId: "cursor", secretName: "provider:cursor", envVar: OWNER_HOP_VAR };
    }
    throw Object.assign(new Error(`Provider ${providerId} does not support an API key.`), {
      status: 400,
    });
  },
}));

import { applyCompanyKeyFallback } from "../services/secrets.js";

describe("company-key fallback delegates env-var resolution to provider-key's owner hop", () => {
  it.each(["pi_local", "cursor_cloud"])(
    "%s uses the target returned by resolveProviderKeyTarget",
    (adapterType) => {
      const out = applyCompanyKeyFallback({ env: {} }, adapterType, {
        [OWNER_HOP_VAR]: "owner-key",
      });
      expect(out.env).toEqual({ [OWNER_HOP_VAR]: "owner-key" });
    },
  );

  it("does NOT fall back to the borrower's own catalog env var", () => {
    const out = applyCompanyKeyFallback({ env: {} }, "pi_local", {
      ANTHROPIC_API_KEY: "borrower-spec-key",
    });
    expect(out.env).toEqual({});
  });
});
