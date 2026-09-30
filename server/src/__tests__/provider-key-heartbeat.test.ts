/**
 * Task 8 / C1 — the company provider key must reach an ORG-AGENT HEARTBEAT run.
 *
 * The heartbeat is AoA's primary agent execution path, and it does NOT go
 * through `resolveAdapterConfigForRuntime`. It assembles its runtime env itself
 * from three scope-specific `resolveEnvBindings` calls (project -> environment
 * -> agent, later winning) so it can record which scope won each key, then hands
 * the result straight to the adapter. The design doc's claim that runtime
 * resolution "already flows through the `resolveAdapterConfigForRuntime`
 * chokepoint" is simply false, and a fallback wired only into that method is
 * inert for every org agent.
 *
 * Two halves, because no end-to-end heartbeat-run harness exists in this repo
 * (every heartbeat test either drives an extracted helper or pins source):
 *
 *   1. BEHAVIOUR — drive `applyCompanyKeyFallbackForRuntime`, the exact method
 *      the heartbeat calls, against a fake vault.
 *   2. WIRING — pin that the heartbeat's `resolvedConfig` is the OUTPUT of that
 *      call and still reaches `adapter.execute`. Half 1 without half 2 would
 *      pass with the heartbeat untouched.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { vi } from "vitest";
import { makeTableProxy } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => {
  const op = (name: string) => (...args: unknown[]) => ({ __op: name, args });
  const sqlFn: any = () => ({ __op: "sql" });
  sqlFn.raw = () => ({ __op: "sql" });
  sqlFn.join = () => ({ __op: "sql" });
  return {
    and: op("and"), or: op("or"), eq: op("eq"), ne: op("ne"),
    isNull: op("isNull"), isNotNull: op("isNotNull"),
    inArray: op("inArray"), notInArray: op("notInArray"),
    gt: op("gt"), gte: op("gte"), lt: op("lt"), lte: op("lte"),
    like: op("like"), ilike: op("ilike"), desc: op("desc"), asc: op("asc"),
    count: op("count"), sql: sqlFn,
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

vi.mock("../secrets/provider-registry.js", () => ({
  getSecretProvider: () => ({
    resolveVersion: async ({ material }: { material: Record<string, unknown> }) =>
      String(material.value),
  }),
  listSecretProviders: () => [],
}));

import { secretService } from "../services/secrets.js";

// ── A minimal vault holding one active provider:anthropic secret ────────────

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

const SECRET = {
  id: "sec-1",
  companyId: "co-1",
  name: "provider:anthropic",
  status: "active",
  provider: "local_encrypted",
  latestVersion: 1,
  deletedAt: null,
  providerConfigId: null,
};

function makeVault() {
  const accessEvents: Record<string, unknown>[] = [];
  const db = {
    select: () => ({
      from: (table: { _: { name: string } }) => ({
        where: (clause: unknown) => {
          const vals = clauseValues(clause);
          let rows: unknown[] = [];
          if (table._.name === "company_secrets") {
            rows = vals.includes(SECRET.name) || vals.includes(SECRET.id) ? [SECRET] : [];
          } else if (table._.name === "company_secret_versions") {
            rows = vals.includes(SECRET.id)
              ? [{ secretId: SECRET.id, version: 1, material: { value: "company-key" } }]
              : [];
          }
          return {
            then: (res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) =>
              Promise.resolve(rows).then(res, rej),
            orderBy: async () => rows,
            limit: async () => rows,
          };
        },
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    insert: (table: { _: { name: string } }) => ({
      values: async (row: Record<string, unknown>) => {
        if (table._.name === "secret_access_events") accessEvents.push(row);
      },
    }),
  } as never;
  return { db, accessEvents };
}

/** Mirrors the heartbeat's call: an already-merged, already-resolved env. */
function heartbeatResolve(
  db: never,
  env: Record<string, string>,
  adapterType = "claude_local",
) {
  return secretService(db).applyCompanyKeyFallbackForRuntime(
    "co-1",
    adapterType,
    { command: "claude", model: "sonnet", env },
    { consumerType: "agent", consumerId: "agent-1", actorType: "agent", actorId: "agent-1" },
  );
}

describe("org-agent heartbeat: the company key reaches the run's adapter config", () => {
  it("injects the company key when no scope supplied that env var", async () => {
    const { db } = makeVault();
    const out = await heartbeatResolve(db, {});
    expect(out.env).toEqual({ ANTHROPIC_API_KEY: "company-key" });
    // The rest of the heartbeat's hand-assembled config must survive intact.
    expect(out).toMatchObject({ command: "claude", model: "sonnet" });
  });

  it("keeps other env keys the heartbeat merged from project/environment scopes", async () => {
    const { db } = makeVault();
    const out = await heartbeatResolve(db, { PROJECT_VAR: "p", ENVIRONMENT_VAR: "e" });
    expect(out.env).toEqual({
      PROJECT_VAR: "p",
      ENVIRONMENT_VAR: "e",
      ANTHROPIC_API_KEY: "company-key",
    });
  });

  it("NEVER overrides the agent's own binding", async () => {
    const { db } = makeVault();
    const out = await heartbeatResolve(db, { ANTHROPIC_API_KEY: "agent-key" });
    expect(out.env).toEqual({ ANTHROPIC_API_KEY: "agent-key" });
  });

  it("NEVER overrides a project- or environment-scoped value either", async () => {
    // Everything the heartbeat resolved outranks the company default — that is
    // what "last stop before the host CLI's own login" means.
    const { db, accessEvents } = makeVault();
    const out = await heartbeatResolve(db, { ANTHROPIC_API_KEY: "from-project-scope" });
    expect(out.env).toEqual({ ANTHROPIC_API_KEY: "from-project-scope" });
    expect(accessEvents).toEqual([]); // and the vault was never touched
  });

  it("is inert for an adapter outside the provider catalog", async () => {
    const { db, accessEvents } = makeVault();
    const out = await heartbeatResolve(db, {}, "process");
    expect(out.env).toEqual({});
    expect(accessEvents).toEqual([]);
  });
});

// ── Wiring: the heartbeat actually applies it, and the result is what runs ──

const heartbeatSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "services", "heartbeat.ts"),
  "utf8",
);

describe("heartbeat wiring", () => {
  it("builds resolvedConfig FROM the unified resolver whose legacy fallback IS the company-key fallback", () => {
    // Phase 4: the org heartbeat now routes the company-key fallback THROUGH the
    // unified provider resolver (STRANGLER). resolvedConfig is the resolver's
    // applied credential, and the company-key fallback is bound as the resolver's
    // `legacyResolveConfig` — so an unmigrated company's behaviour is byte-identical.
    // P5 Task 9 changed `const` -> `let` so the routing step can reassign
    // resolvedConfig with the credential-appropriate executionTarget; the P4 intent
    // (resolvedConfig is built FROM applyResolvedCredential) is unchanged.
    expect(heartbeatSrc).toMatch(/\b(?:const|let) resolvedConfig = applyResolvedCredential\(/);
    expect(heartbeatSrc).toMatch(
      /legacyResolveConfig:[\s\S]*?secretsSvc\.applyCompanyKeyFallbackForRuntime\(/,
    );
  });

  it("passes the agent's real adapter type, not a literal", () => {
    const i = heartbeatSrc.indexOf("applyCompanyKeyFallbackForRuntime(");
    const call = heartbeatSrc.slice(i, i + 400);
    expect(call).toMatch(/agent\.companyId,\s*\n\s*agent\.adapterType,/);
  });

  it("still feeds resolvedConfig into the adapter execution config", () => {
    // If a refactor ever detaches these, the fallback would be computed and
    // then thrown away — the exact failure mode C1 describes.
    // R3 (Wave 2 review): acquireExecutionContext + applyEnvironmentAcquisitionConfig
    // are now called unconditionally (previously gated behind a pinned-env
    // `if`, whose now-removed fallback branch used to read literally
    // `resolvedConfigWithEnvironmentAcquisition = resolvedConfig`) — the
    // invariant this test protects (resolvedConfig feeds the adapter
    // execution config, never computed-then-discarded) is unchanged; it's
    // threaded through applyEnvironmentAcquisitionConfig's first argument.
    expect(heartbeatSrc).toMatch(
      /resolvedConfigWithEnvironmentAcquisition = applyEnvironmentAcquisitionConfig\(\s*resolvedConfig,/,
    );
    expect(heartbeatSrc).toMatch(/config: resolvedConfigWithEnvironmentAcquisition/);
  });
});
