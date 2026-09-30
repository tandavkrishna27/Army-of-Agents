import { describe, it, expect } from "vitest";
import {
  PROVIDER_DESCRIPTORS,
  PROVIDER_IDS,
  KNOWN_EXTERNAL_SECRET_BINDINGS,
  getProviderById,
  getProviderByAdapterType,
  getCredentialOwner,
  isRunnableInstallCommand,
} from "../provider-catalog.js";
// Canonical builtin adapter list. Lives in shared (constants.ts) so this test can
// be registry-derived without a shared -> server dependency. The server registry's
// own BUILTIN_ADAPTER_TYPES set is pinned equal to this list in
// server/src/__tests__/adapter-registry-no-api.test.ts.
import { AGENT_ADAPTER_TYPES } from "../../constants.js";
import { CREW_PROVIDERS, providerToCrewAdapter } from "../../provider-mapping.js";

/**
 * Adapters that intentionally have NO catalog entry, with the reason. Anything
 * else appearing in the adapter registry must be triaged — this is what makes
 * the test self-enforcing instead of a hand-maintained duplicate list.
 */
const INTENTIONALLY_UNCATALOGUED: Record<string, string> = {
  process: "generic spawn, no auth",
  http: "generic webhook, no auth",
  openclaw: "per-agent endpoint token, not a shared credential",
  openclaw_gateway: "per-agent endpoint token, not a shared credential",
  hermes_local: "PAPERCLIP_API_KEY wire protocol, JWT-injected",
  acpx_local: "embedded; inherits claude/codex credentials",
};

/** envVar -> secretName, built from PRIMARY keys only. Alternatives are read-only. */
function primaryEnvToSecret(): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of PROVIDER_DESCRIPTORS) {
    const k = p.credential.apiKey;
    if (k) map.set(k.envVar, k.secretName);
  }
  return map;
}

describe("provider catalog", () => {
  // Self-enforcing: adding a credentialed adapter to the registry fails here
  // until it is either catalogued or explicitly excluded with a reason.
  it("catalogues every adapter that is not explicitly excluded", () => {
    const catalogued = new Set<string>(PROVIDER_DESCRIPTORS.map((p) => p.adapterType));
    const untriaged = AGENT_ADAPTER_TYPES.filter(
      (t) => !catalogued.has(t) && !(t in INTENTIONALLY_UNCATALOGUED),
    );
    expect(untriaged).toEqual([]);
  });

  it("does not catalogue an adapter that is also explicitly excluded", () => {
    const overlap = PROVIDER_DESCRIPTORS.map((p) => p.adapterType).filter(
      (t) => t in INTENTIONALLY_UNCATALOGUED,
    );
    expect(overlap).toEqual([]);
  });

  it("only catalogues adapter types that actually exist in the registry", () => {
    const known = new Set<string>(AGENT_ADAPTER_TYPES);
    const unknown = PROVIDER_DESCRIPTORS.map((p) => p.adapterType).filter((t) => !known.has(t));
    expect(unknown).toEqual([]);
  });

  // PROVIDER_IDS is what downstream zod enums are built from; if it drifts from
  // the catalog the routes accept ids that resolve to nothing.
  it("keeps PROVIDER_IDS in sync with the catalog", () => {
    expect([...PROVIDER_IDS]).toEqual(PROVIDER_DESCRIPTORS.map((p) => p.id));
  });

  it("gives every provider a unique adapterType", () => {
    const types = PROVIDER_DESCRIPTORS.map((p) => p.adapterType);
    expect(new Set(types).size).toBe(types.length);
  });

  it("gives every provider a unique id", () => {
    const ids = PROVIDER_DESCRIPTORS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe("credential storage", () => {
    it("shares one stored secret between providers in the same credential group", () => {
      const cursor = getProviderById("cursor")!;
      const cloud = getProviderById("cursor_cloud")!;
      expect(cursor.credential.apiKey!.envVar).toBe(cloud.credential.apiKey!.envVar);
      // Same env var MUST mean the same secret, or saving one silently fails the other.
      expect(cursor.credential.apiKey!.secretName).toBe(cloud.credential.apiKey!.secretName);
    });

    // A borrower renders as a link to the owner's card. If its env var or secret
    // drifted from the owner's, the UI would show two inputs writing one secret.
    it("makes every borrower's credential identical to its owner's", () => {
      const borrowers = PROVIDER_DESCRIPTORS.filter((p) => p.credential.credentialOwnerId);
      expect(borrowers.map((p) => p.id)).toEqual(["cursor_cloud", "pi"]);

      for (const borrower of borrowers) {
        const owner = getCredentialOwner(borrower);
        expect(owner.id, `${borrower.id} borrows from an unknown provider`).not.toBe(borrower.id);
        expect(
          owner.credential.credentialOwnerId,
          `${owner.id} is itself a borrower`,
        ).toBeUndefined();
        expect(borrower.credential.apiKey!.envVar).toBe(owner.credential.apiKey!.envVar);
        expect(borrower.credential.apiKey!.secretName).toBe(owner.credential.apiKey!.secretName);
      }
    });

    it("gives every apiKey provider an env var, reserved secret name and placeholder", () => {
      for (const p of PROVIDER_DESCRIPTORS) {
        if (!p.credential.apiKey) continue;
        expect(p.credential.apiKey.envVar).toMatch(/^[A-Z0-9_]+$/);
        // Reserved namespace, but NOT necessarily provider:<own id> — providers
        // that share a credential intentionally share one secret name.
        expect(p.credential.apiKey.secretName).toMatch(/^provider:[a-z0-9_]+$/);
        expect(p.credential.apiKey.placeholder.length).toBeGreaterThan(0);
      }
    });

    it("never maps one env var to two different secret names", () => {
      const byEnv = new Map<string, Set<string>>();
      for (const p of PROVIDER_DESCRIPTORS) {
        const k = p.credential.apiKey;
        if (!k) continue;
        if (!byEnv.has(k.envVar)) byEnv.set(k.envVar, new Set());
        byEnv.get(k.envVar)!.add(k.secretName);
      }
      for (const [envVar, names] of byEnv) {
        expect(names.size, `${envVar} maps to multiple secrets: ${[...names].join(", ")}`).toBe(1);
      }
    });

    it("never maps one secret name to two different env vars", () => {
      const bySecret = new Map<string, Set<string>>();
      for (const p of PROVIDER_DESCRIPTORS) {
        const k = p.credential.apiKey;
        if (!k) continue;
        if (!bySecret.has(k.secretName)) bySecret.set(k.secretName, new Set());
        bySecret.get(k.secretName)!.add(k.envVar);
      }
      for (const [secretName, envVars] of bySecret) {
        expect(
          envVars.size,
          `${secretName} maps to multiple env vars: ${[...envVars].join(", ")}`,
        ).toBe(1);
      }
    });

    it("never lists a provider's primary env var among its own alternatives", () => {
      for (const p of PROVIDER_DESCRIPTORS) {
        const k = p.credential.apiKey;
        if (!k?.alternativeEnvVars) continue;
        expect(k.alternativeEnvVars).not.toContain(k.envVar);
      }
    });

    // Alternatives are READ-ONLY. Folding them into the env->secret map must not
    // let a provider claim storage for an env var another provider owns —
    // otherwise two secrets back one env var and rotation leaves one stale.
    it("keeps alternative env vars read-only, never claimed as the lister's secret", () => {
      const owned = primaryEnvToSecret();
      for (const p of PROVIDER_DESCRIPTORS) {
        const k = p.credential.apiKey;
        if (!k?.alternativeEnvVars) continue;
        for (const alt of k.alternativeEnvVars) {
          expect(alt, `${p.id} alternative ${alt} is malformed`).toMatch(/^[A-Z0-9_]+$/);
          const ownerSecret = owned.get(alt);
          if (!ownerSecret) continue; // not owned by any provider — informational only
          expect(
            ownerSecret,
            `${p.id} lists ${alt} (owned by ${ownerSecret}) but stores under its own secret`,
          ).not.toBe(k.secretName);
        }
      }
    });

    it("reserves the provider: secret namespace (no collision with existing conventions)", () => {
      for (const p of PROVIDER_DESCRIPTORS) {
        const name = p.credential.apiKey?.secretName;
        if (!name) continue;
        expect(name.startsWith("llm:")).toBe(false);
        expect(name.startsWith("Commander ")).toBe(false);
      }
    });
  });

  // The provider:* namespace deliberately coexists with older bindings for the
  // same env vars. Pin them so a fourth binding is a failing test, not a
  // production surprise (a founder shown an empty input pasting a duplicate key).
  describe("known external secret bindings", () => {
    it("pins the exact set of non-catalog secret names per env var", () => {
      expect(KNOWN_EXTERNAL_SECRET_BINDINGS).toEqual({
        ANTHROPIC_API_KEY: ["llm:anthropic", "ANTHROPIC_API_KEY", "Commander anthropic API key"],
        OPENAI_API_KEY: ["llm:openai", "OPENAI_API_KEY", "Commander openai API key"],
      });
    });

    it("only records env vars the catalog actually uses", () => {
      const catalogEnvVars = new Set<string>();
      for (const p of PROVIDER_DESCRIPTORS) {
        const k = p.credential.apiKey;
        if (!k) continue;
        catalogEnvVars.add(k.envVar);
        for (const alt of k.alternativeEnvVars ?? []) catalogEnvVars.add(alt);
      }
      for (const envVar of Object.keys(KNOWN_EXTERNAL_SECRET_BINDINGS)) {
        expect(catalogEnvVars.has(envVar), `${envVar} is not read by any provider`).toBe(true);
      }
    });

    it("keeps external bindings out of the reserved provider: namespace", () => {
      for (const names of Object.values(KNOWN_EXTERNAL_SECRET_BINDINGS)) {
        for (const name of names) expect(name.startsWith("provider:")).toBe(false);
      }
    });
  });

  describe("install and login", () => {
    it("gives every local CLI provider install hints for all three platforms", () => {
      for (const p of PROVIDER_DESCRIPTORS) {
        if (p.kind !== "local_cli") continue;
        expect(p.installHint, `${p.id} has no install hint`).toBeDefined();
        expect(p.installHint!.mac.length).toBeGreaterThan(0);
        expect(p.installHint!.win.length).toBeGreaterThan(0);
        expect(p.installHint!.linux.length).toBeGreaterThan(0);
      }
    });

    // Every hint must be actionable: either a command the founder can paste, or
    // a link. Prose with neither ("Install from the vendor website.") is a dead end.
    it("makes every install hint either a runnable command or docs-backed", () => {
      // Uses the SHARED predicate the Providers card also branches on, so the
      // "is this pasteable?" rule cannot drift between the pin and the UI.
      for (const p of PROVIDER_DESCRIPTORS) {
        if (!p.installHint) continue;
        for (const platform of ["mac", "win", "linux"] as const) {
          const hint = p.installHint[platform];
          if (isRunnableInstallCommand(hint)) continue;
          expect(
            p.installHint.docsUrl,
            `${p.id}.${platform} is not a runnable command ("${hint}") and has no docsUrl`,
          ).toMatch(/^https:\/\//);
        }
      }
    });

    it("only claims selfCompletingLogin where it is actually wired", () => {
      const wired = PROVIDER_DESCRIPTORS.filter((p) => p.credential.selfCompletingLogin).map(
        (p) => p.id,
      );
      expect(wired).toEqual(["openai"]);
    });

    // Regression guard: `claude login` is a no-op that prints "Please run /login"
    // and exits. The real subcommand is `auth login` — see the spawn args in
    // packages/adapters/claude-local/src/server/login.ts.
    it("names the real Claude login subcommand", () => {
      const anthropic = getProviderById("anthropic")!;
      expect(anthropic.credential.manualLoginCommand).toBe("claude auth login");
      expect(anthropic.credential.manualLoginCommand).not.toMatch(/^claude login$/);
    });

    it("gives every manual login command a plausible CLI shape", () => {
      for (const p of PROVIDER_DESCRIPTORS) {
        const cmd = p.credential.manualLoginCommand;
        if (!cmd) continue;
        expect(cmd, `${p.id} login command looks malformed`).toMatch(/^[a-z][a-z0-9-]*( [a-z]+)+$/);
      }
    });

    // Every provider must expose at least one way to authenticate, or its card is a
    // dead end: a storable key, or a command the founder can run in a terminal.
    it("gives every provider some authentication path", () => {
      for (const p of PROVIDER_DESCRIPTORS) {
        const hasKey = Boolean(p.credential.apiKey);
        const hasLogin =
          p.credential.selfCompletingLogin || Boolean(p.credential.manualLoginCommand);
        expect(hasKey || hasLogin, `${p.id} offers no way to authenticate`).toBe(true);
      }
    });
  });

  // provider-mapping.ts encodes the same provider -> adapter relation for crew
  // agents and also calls itself a source of truth. They agree today; this keeps
  // them agreeing until one is deleted.
  it("agrees with provider-mapping on the crew provider -> adapter relation", () => {
    for (const p of CREW_PROVIDERS) {
      expect(getProviderById(p)?.adapterType, `crew provider ${p}`).toBe(providerToCrewAdapter(p));
    }
  });

  it("resolves by id and adapterType", () => {
    expect(getProviderById("anthropic")?.adapterType).toBe("claude_local");
    expect(getProviderByAdapterType("codex_local")?.id).toBe("openai");
    expect(getProviderById("nope")).toBeUndefined();
    expect(getProviderByAdapterType("nope")).toBeUndefined();
  });

  it("resolves a non-borrower to itself as its own credential owner", () => {
    const anthropic = getProviderById("anthropic")!;
    expect(getCredentialOwner(anthropic)).toBe(anthropic);
    expect(getCredentialOwner(getProviderById("pi")!).id).toBe("anthropic");
  });
});
