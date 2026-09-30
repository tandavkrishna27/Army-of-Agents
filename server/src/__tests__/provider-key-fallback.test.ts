/**
 * Task 8 — company provider key fallback in runtime resolution.
 *
 * Resolution chain (design D4):
 *
 *   agent's own adapterConfig.env binding  →  company provider key  →  host CLI login
 *
 * The per-agent binding ALWAYS wins. The company key is a fallback applied only
 * when the resolved agent config carries no value for that env var.
 *
 * Two layers are proven here:
 *
 *   1. `applyCompanyKeyFallback` — the pure merge rule (agent wins, one env var
 *      only, whole config preserved, explicit "" respected).
 *   2. `resolveAdapterConfigForRuntime` end-to-end against a fake vault — proof
 *      that a STORED `provider:<id>` secret actually reaches the resolved env.
 *      A feature that stores a key but never applies it is worthless, and the
 *      pure function alone cannot catch that.
 *
 * The owner (borrower) hop is proven separately in
 * provider-key-fallback-owner-hop.test.ts, which mocks the provider-key module
 * so the delegation is observable — today's catalog has every borrower COPY its
 * owner's envVar/secretName, so a real-catalog test cannot distinguish "hopped"
 * from "read the borrower's own spec".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTableProxy } from "./helpers/drizzle-mock.js";

// A value-capturing drizzle mock (NOT the shared string stubs): the fake vault
// below has to see WHICH secret name / id / version a query asked for, so the
// cross-provider-leak test can honestly return "no such secret".
vi.mock("drizzle-orm", () => {
  const op = (name: string) => (...args: unknown[]) => ({ __op: name, args });
  const sqlFn: any = (..._a: unknown[]) => ({ __op: "sql" });
  sqlFn.raw = () => ({ __op: "sql" });
  sqlFn.join = () => ({ __op: "sql" });
  return {
    and: op("and"),
    or: op("or"),
    eq: op("eq"),
    ne: op("ne"),
    isNull: op("isNull"),
    isNotNull: op("isNotNull"),
    inArray: op("inArray"),
    notInArray: op("notInArray"),
    gt: op("gt"),
    gte: op("gte"),
    lt: op("lt"),
    lte: op("lte"),
    like: op("like"),
    ilike: op("ilike"),
    desc: op("desc"),
    asc: op("asc"),
    count: op("count"),
    sql: sqlFn,
  };
});

vi.mock("@armyofagents/db", () => ({
  companySecretBindings: makeTableProxy("company_secret_bindings"),
  companySecretProviderConfigs: makeTableProxy("company_secret_provider_configs"),
  companySecrets: makeTableProxy("company_secrets"),
  companySecretVersions: makeTableProxy("company_secret_versions"),
  runtimeProviderKeys: makeTableProxy("runtime_provider_keys"),
  secretAccessEvents: makeTableProxy("secret_access_events"),
}));

// The vault provider that decrypts a version's material. Local-encrypted in
// reality; here it just echoes the stored value.
vi.mock("../secrets/provider-registry.js", () => ({
  getSecretProvider: () => ({
    resolveVersion: async ({ material }: { material: Record<string, unknown> }) =>
      String(material.value),
  }),
  listSecretProviders: () => [],
}));

import { applyCompanyKeyFallback, secretService } from "../services/secrets.js";
import { getProviderById, getCredentialOwner } from "@armyofagents/shared";

// ── Layer 1: the pure merge rule ────────────────────────────────────────────

describe("applyCompanyKeyFallback", () => {
  it("fills the env var when the agent has no binding", () => {
    const out = applyCompanyKeyFallback({ env: {} }, "claude_local", {
      ANTHROPIC_API_KEY: "company-key",
    });
    expect((out.env as Record<string, string>).ANTHROPIC_API_KEY).toBe("company-key");
  });

  it("NEVER overrides an existing agent binding", () => {
    const out = applyCompanyKeyFallback({ env: { ANTHROPIC_API_KEY: "agent-key" } }, "claude_local", {
      ANTHROPIC_API_KEY: "company-key",
    });
    expect((out.env as Record<string, string>).ANTHROPIC_API_KEY).toBe("agent-key");
  });

  it("does not mutate the input env when it FILLS a value", () => {
    const input: { env: Record<string, string> } = { env: {} };
    applyCompanyKeyFallback(input, "claude_local", { ANTHROPIC_API_KEY: "company-key" });
    expect(input.env).toEqual({});
  });

  it("leaves the config alone when the adapter has no catalog entry", () => {
    const out = applyCompanyKeyFallback({ env: {} }, "process", { ANTHROPIC_API_KEY: "x" });
    expect(out.env).toEqual({});
  });

  it("leaves the config alone for a catalog provider that owns no API key (opencode)", () => {
    const out = applyCompanyKeyFallback({ env: {} }, "opencode_local", {
      ANTHROPIC_API_KEY: "x",
      OPENAI_API_KEY: "y",
    });
    expect(out.env).toEqual({});
  });

  // ── Security / correctness ───────────────────────────────────────────────
  it("NEVER injects another provider's key into this adapter", () => {
    const out = applyCompanyKeyFallback({ env: {} }, "claude_local", {
      OPENAI_API_KEY: "openai-key",
      CURSOR_API_KEY: "cursor-key",
    });
    expect(out.env).toEqual({});
  });

  it("injects only the descriptor's own env var when several keys exist", () => {
    const out = applyCompanyKeyFallback({ env: {} }, "claude_local", {
      ANTHROPIC_API_KEY: "anthropic-key",
      OPENAI_API_KEY: "openai-key",
    });
    expect(out.env).toEqual({ ANTHROPIC_API_KEY: "anthropic-key" });
  });

  it("does not inject an alternativeEnvVar (v1 stores/writes only the canonical one)", () => {
    // Gemini also ACCEPTS GOOGLE_API_KEY, but nothing may ever be written under
    // an alternative (provider-catalog.ts, ProviderApiKeySpec docblock).
    const out = applyCompanyKeyFallback({ env: {} }, "gemini_local", { GOOGLE_API_KEY: "g" });
    expect(out.env).toEqual({});
  });

  it("treats an explicit empty override as intentional and does not fill it", () => {
    const out = applyCompanyKeyFallback({ env: { ANTHROPIC_API_KEY: "" } }, "claude_local", {
      ANTHROPIC_API_KEY: "company-key",
    });
    expect((out.env as Record<string, string>).ANTHROPIC_API_KEY).toBe("");
  });

  it("preserves non-env adapter fields", () => {
    const out = applyCompanyKeyFallback(
      { env: {}, model: "sonnet", cwd: "/tmp", command: "claude" },
      "claude_local",
      { ANTHROPIC_API_KEY: "k" },
    );
    expect(out.model).toBe("sonnet");
    expect(out.cwd).toBe("/tmp");
    expect(out.command).toBe("claude");
  });

  it("preserves non-env adapter fields even when NOTHING is injected", () => {
    const out = applyCompanyKeyFallback(
      { env: {}, model: "sonnet", cwd: "/tmp", command: "claude" },
      "claude_local",
      {},
    );
    expect(out).toMatchObject({ model: "sonnet", cwd: "/tmp", command: "claude" });
  });

  it("synthesises env when the config has none at all", () => {
    const out = applyCompanyKeyFallback({ model: "sonnet" }, "claude_local", {
      ANTHROPIC_API_KEY: "k",
    });
    expect(out.env).toEqual({ ANTHROPIC_API_KEY: "k" });
    expect(out.model).toBe("sonnet");
  });

  it("handles an unknown adapter type without throwing", () => {
    expect(() => applyCompanyKeyFallback({ env: {} }, "totally_unknown", {})).not.toThrow();
  });

  it("returns a COPY on the no-target path too (never the caller's own object)", () => {
    const input = { env: {}, command: "pwd" };
    expect(applyCompanyKeyFallback(input, "process", {})).not.toBe(input);
  });
});

// ── Layer 2: the stored secret actually reaches the resolved env ────────────

type FakeSecret = {
  id: string;
  companyId: string;
  name: string;
  status: string;
  provider: string;
  latestVersion: number;
  deletedAt: Date | null;
  providerConfigId: string | null;
};

/** Collect every literal value referenced anywhere in a where-clause tree. */
function clauseValues(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== "object") return out;
  const args = (node as { args?: unknown[] }).args;
  if (Array.isArray(args)) {
    for (const arg of args) {
      if (arg && typeof arg === "object") clauseValues(arg, out);
      else out.push(arg);
    }
  }
  return out;
}

/**
 * Does the clause carry an `isNull(...)` predicate? `getByName` filters on
 * `isNull(deletedAt)` while `getById` does not, and the fake vault has to
 * reproduce that difference — otherwise a soft-deleted row would come back from
 * a query that, in reality, can never return it.
 */
function hasIsNull(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  if ((node as { __op?: string }).__op === "isNull") return true;
  const args = (node as { args?: unknown[] }).args;
  return Array.isArray(args) && args.some((a) => hasIsNull(a));
}

function makeVault(secrets: FakeSecret[], values: Record<string, string>) {
  const accessEvents: Record<string, unknown>[] = [];
  const select = () => ({
    from: (table: { _: { name: string } }) => {
      const tableName = table._.name;
      const build = (clause: unknown) => {
        const vals = clauseValues(clause);
        let rows: unknown[] = [];
        if (tableName === "company_secrets") {
          // Serves BOTH getByName (name + isNull(deletedAt)) and getById (id).
          rows = secrets.filter(
            (s) =>
              (vals.includes(s.name) || vals.includes(s.id)) &&
              !(hasIsNull(clause) && s.deletedAt !== null),
          );
        } else if (tableName === "company_secret_versions") {
          const secret = secrets.find((s) => vals.includes(s.id));
          rows = secret ? [{ secretId: secret.id, version: secret.latestVersion, material: { value: values[secret.id] } }] : [];
        }
        const thenable = {
          then: (res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) =>
            Promise.resolve(rows).then(res, rej),
          orderBy: async () => rows,
          limit: async () => rows,
        };
        return thenable;
      };
      return { where: build };
    },
  });
  const db = {
    select,
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    insert: (table: { _: { name: string } }) => ({
      values: async (row: Record<string, unknown>) => {
        if (table._.name === "secret_access_events") accessEvents.push(row);
      },
    }),
  } as never;
  return { db, accessEvents };
}

const AGENT_CTX = {
  consumerType: "agent" as const,
  consumerId: "agent-1",
  actorType: "agent" as const,
  actorId: "agent-1",
};

function anthropicSecret(overrides: Partial<FakeSecret> = {}): FakeSecret {
  return {
    id: "sec-anthropic",
    companyId: "co-1",
    name: "provider:anthropic",
    status: "active",
    provider: "local_encrypted",
    latestVersion: 1,
    deletedAt: null,
    providerConfigId: null,
    ...overrides,
  };
}

describe("resolveAdapterConfigForRuntime — company key reaches the runtime env", () => {
  beforeEach(() => vi.clearAllMocks());

  it("applies the stored provider:anthropic key to a claude_local agent with no binding", async () => {
    const { db } = makeVault([anthropicSecret()], { "sec-anthropic": "co-key" });
    const out = await secretService(db).resolveAdapterConfigForRuntime(
      "co-1",
      "claude_local",
      { model: "sonnet", env: {} },
      AGENT_CTX,
    );
    expect(out.env).toEqual({ ANTHROPIC_API_KEY: "co-key" });
    expect(out.model).toBe("sonnet");
  });

  it("does NOT override the agent's own plain binding", async () => {
    const { db } = makeVault([anthropicSecret()], { "sec-anthropic": "co-key" });
    const out = await secretService(db).resolveAdapterConfigForRuntime(
      "co-1",
      "claude_local",
      { env: { ANTHROPIC_API_KEY: "agent-key" } },
      AGENT_CTX,
    );
    expect(out.env).toEqual({ ANTHROPIC_API_KEY: "agent-key" });
  });

  it("does not leak another provider's stored key into this adapter", async () => {
    const openai = anthropicSecret({ id: "sec-openai", name: "provider:openai" });
    const { db } = makeVault([openai], { "sec-openai": "openai-key" });
    const out = await secretService(db).resolveAdapterConfigForRuntime(
      "co-1",
      "claude_local",
      { env: {} },
      AGENT_CTX,
    );
    expect(out.env).toEqual({});
  });

  it.each(["disabled", "archived"])(
    "skips a %s secret GRACEFULLY — resolves keyless, never rejects",
    async (status) => {
      // The distinction that matters: `resolveSecretValue` would independently
      // REJECT a non-active secret, and a rejection here kills the run for every
      // agent in the company. The service must instead return a usable config
      // with the env var simply absent, so the host CLI's own login still works.
      const { db } = makeVault([anthropicSecret({ status })], { "sec-anthropic": "co-key" });
      const out = await secretService(db).resolveAdapterConfigForRuntime(
        "co-1",
        "claude_local",
        { env: {}, model: "sonnet" },
        AGENT_CTX,
      );
      expect(out).toEqual({ env: {}, model: "sonnet" });
    },
  );

  it("does not inject an EMPTY stored key (an empty credential shadows host login)", async () => {
    const { db } = makeVault([anthropicSecret()], { "sec-anthropic": "" });
    const out = await secretService(db).resolveAdapterConfigForRuntime(
      "co-1",
      "claude_local",
      { env: {} },
      AGENT_CTX,
    );
    // Absent, NOT "" — an empty ANTHROPIC_API_KEY makes the CLI stop consulting
    // its own credentials and fail auth instead of falling through to them.
    expect(out.env).toEqual({});
  });

  it("does not touch the vault at all when the agent already has a value", async () => {
    // A vault fault must not fail an agent whose own binding is the credential.
    const { db, accessEvents } = makeVault([anthropicSecret()], { "sec-anthropic": "co-key" });
    const out = await secretService(db).resolveAdapterConfigForRuntime(
      "co-1",
      "claude_local",
      { env: { ANTHROPIC_API_KEY: "agent-key" } },
      AGENT_CTX,
    );
    expect(out.env).toEqual({ ANTHROPIC_API_KEY: "agent-key" });
    // No read happened, so no audit row claiming the key was consumed.
    expect(accessEvents).toEqual([]);
  });

  it("does not touch the vault for an explicit empty override either", async () => {
    const { db, accessEvents } = makeVault([anthropicSecret()], { "sec-anthropic": "co-key" });
    await secretService(db).resolveAdapterConfigForRuntime(
      "co-1",
      "claude_local",
      { env: { ANTHROPIC_API_KEY: "" } },
      AGENT_CTX,
    );
    expect(accessEvents).toEqual([]);
  });

  it("resolves a BORROWER against the credential owner's secret and audits the owner", async () => {
    // Pi borrows Anthropic's credential. This kills the "read my own spec
    // instead of hopping" regression WITHOUT any mocking: `ownerId` is
    // observable in the audit row, and it differs between the two behaviours
    // even though today's catalog copies the owner's envVar/secretName.
    const { db, accessEvents } = makeVault([anthropicSecret()], { "sec-anthropic": "co-key" });
    const out = await secretService(db).resolveAdapterConfigForRuntime(
      "co-1",
      "pi_local",
      { env: {} },
      AGENT_CTX,
    );
    const ownerVar = getCredentialOwner(getProviderById("pi")!).credential.apiKey!.envVar;
    expect(out.env).toEqual({ [ownerVar]: "co-key" });
    expect(accessEvents[0]).toMatchObject({ consumerId: "provider-key:anthropic" });
  });

  it("skips a soft-deleted secret", async () => {
    const { db } = makeVault([anthropicSecret({ deletedAt: new Date() })], {
      "sec-anthropic": "co-key",
    });
    const out = await secretService(db).resolveAdapterConfigForRuntime(
      "co-1",
      "claude_local",
      { env: {} },
      AGENT_CTX,
    );
    expect(out.env).toEqual({});
  });

  it("records the access through the secret audit path", async () => {
    const { db, accessEvents } = makeVault([anthropicSecret()], { "sec-anthropic": "co-key" });
    await secretService(db).resolveAdapterConfigForRuntime("co-1", "claude_local", { env: {} }, AGENT_CTX);
    expect(accessEvents).toHaveLength(1);
    expect(accessEvents[0]).toMatchObject({
      secretId: "sec-anthropic",
      outcome: "success",
      // Actor attribution is preserved from the CALLER…
      actorType: "agent",
      actorId: "agent-1",
      // …while the consumer is narrowed to `system`. That narrowing is load
      // bearing, not cosmetic: `provider-key.ts` deliberately writes no
      // `company_secret_bindings` row for a company-level key, so with
      // consumerType "agent" + a configPath, `shouldEnforceSecretBinding` would
      // demand a binding that by design never exists and every run would fail
      // with "Secret is not bound to this consumer path".
      consumerType: "system",
      consumerId: "provider-key:anthropic",
      configPath: "provider.provider:anthropic",
    });
    // The raw key must never land in the audit row.
    expect(JSON.stringify(accessEvents[0])).not.toContain("co-key");
  });

  it("is inert for an adapter outside the provider catalog", async () => {
    const { db } = makeVault([anthropicSecret()], { "sec-anthropic": "co-key" });
    const out = await secretService(db).resolveAdapterConfigForRuntime(
      "co-1",
      "process",
      { env: {}, command: "pwd" },
      AGENT_CTX,
    );
    expect(out.env).toEqual({});
    expect(out.command).toBe("pwd");
  });
});
