/**
 * Contract tests for the Settings -> Providers HTTP surface (Task 9).
 *
 * The invariants under test are the ones that make the feature honest rather
 * than merely present:
 *
 *   1. SCOPED READS WITH NO FALLBACK. An agent-scoped read that finds no cached
 *      row must report `unknown` — never the company_default row. That fallback
 *      IS the false-green this whole feature exists to remove.
 *   2. REDACTION ON THE WAY OUT, not just on the way in.
 *   3. CREDENTIAL-GROUP INVALIDATION. Cursor / Cursor Cloud share one secret;
 *      Pi / Claude share another. Saving one must not leave the sibling card
 *      rendering a status derived from the old key.
 *   4. FOUNDER GATING ON CREDENTIAL MUTATIONS ONLY. `/test` is guarded as a
 *      configuration READ (team leads need the agent-page badge); `/key` is a
 *      credential mutation and is founder-gated.
 */
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

// notInArray is recorded so we can assert the in-use query filters dead agent
// statuses — the mock db ignores WHERE, so the operator call is the only seam.
const mockNotInArray = vi.hoisted(() => vi.fn((..._args: unknown[]) => "notInArray"));
vi.mock("drizzle-orm", () => ({ ...drizzleOperatorStubs(), notInArray: mockNotInArray }));

vi.mock("@armyofagents/db", () => ({
  agents: makeTableProxy("agents"),
  companySecrets: makeTableProxy("company_secrets"),
  providerReadinessStatus: makeTableProxy("provider_readiness_status"),
}));

const mockCanUser = vi.hoisted(() => vi.fn(async () => true));
const mockHasPermission = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../services/access.js", () => ({
  accessService: () => ({ canUser: mockCanUser, hasPermission: mockHasPermission }),
}));

const mockResolveAdapterConfigForRuntime = vi.hoisted(() =>
  vi.fn(async (_companyId: string, _adapterType: string, config: Record<string, unknown>) => ({
    ...config,
    env: { RESOLVED: "1" },
  })),
);
vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    resolveAdapterConfigForRuntime: mockResolveAdapterConfigForRuntime,
  }),
}));

vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));

const mockReadReadiness = vi.hoisted(() => vi.fn());
const mockReadReadinessForScope = vi.hoisted(() => vi.fn());
const mockRecordReadiness = vi.hoisted(() => vi.fn());
const mockDeleteReadinessForScope = vi.hoisted(() => vi.fn());
const mockDeleteAgentReadinessForProvider = vi.hoisted(() => vi.fn());
vi.mock("../services/providers/readiness.js", async (importOriginal) => {
  // `redactChecks` stays REAL — the response-redaction assertions below are
  // meaningless against a stub.
  const actual = await importOriginal<typeof import("../services/providers/readiness.js")>();
  return {
    ...actual,
    readReadiness: mockReadReadiness,
    readReadinessForScope: mockReadReadinessForScope,
    recordReadiness: mockRecordReadiness,
    deleteReadinessForScope: mockDeleteReadinessForScope,
    deleteAgentReadinessForProvider: mockDeleteAgentReadinessForProvider,
  };
});

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));

const mockSaveProviderKey = vi.hoisted(() => vi.fn());
vi.mock("../services/providers/provider-key.js", async (importOriginal) => {
  // `resolveProviderKeyTarget` stays REAL — it is the credential-owner hop the
  // group-invalidation test depends on.
  const actual = await importOriginal<typeof import("../services/providers/provider-key.js")>();
  return { ...actual, saveProviderKey: mockSaveProviderKey };
});

const mockFindServerAdapter = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", () => ({
  findServerAdapter: mockFindServerAdapter,
  findActiveServerAdapter: vi.fn(),
  listAdapterModels: vi.fn(),
}));

const mockAssertRole = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../middleware/rbac.js", () => ({ assertRole: mockAssertRole }));

import { providerRoutes } from "../routes/providers.js";
import { errorHandler } from "../middleware/index.js";
import { tryAcquireAdapterProbeSlot } from "../services/adapter-probe-concurrency.js";
import { forbidden } from "../errors.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

/** Results handed to successive `db.select()` chains, in call order. */
let selectResults: unknown[][] = [];

function makeDb() {
  return {
    select: () => {
      const rows = selectResults.shift() ?? [];
      const builder: Record<string, unknown> = {};
      for (const m of ["from", "where", "limit", "orderBy", "for"]) {
        builder[m] = () => builder;
      }
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
      return builder;
    },
  } as never;
}

function makeApp(actorOverride?: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = (actorOverride ?? {
      type: "board",
      source: "session",
      userId: "user-1",
      companyIds: [COMPANY_ID],
      isInstanceAdmin: false,
    }) as never;
    next();
  });
  app.use("/api/companies/:companyId/providers", providerRoutes(makeDb()));
  app.use(errorHandler);
  return app;
}

/** Default GET wiring: no agents, no secrets, no cached readiness rows. */
function seedGet(opts: { agents?: unknown[]; secrets?: unknown[]; readiness?: unknown[] } = {}) {
  selectResults = [opts.agents ?? [], opts.secrets ?? []];
  mockReadReadiness.mockResolvedValue(opts.readiness ?? []);
}

/** One cached `provider_readiness_status` row, as the bulk reader returns it. */
function cachedRow(
  providerId: string,
  scope: { scopeType: "company_default" | "agent"; scopeId?: string },
  outcome: string,
  checks: unknown[] = [],
) {
  return {
    providerId,
    scopeType: scope.scopeType,
    scopeId: scope.scopeId ?? null,
    outcome,
    checks,
    testedAt: new Date("2026-07-20T09:00:00.000Z"),
  };
}

function passingProbe(checks?: unknown[]) {
  return {
    adapterType: "claude_local",
    status: "pass",
    checks: checks ?? [{ code: "claude_local_hello_probe_passed", level: "info", message: "ok" }],
    testedAt: "2026-07-20T00:00:00.000Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectResults = [];
  mockCanUser.mockResolvedValue(true);
  mockHasPermission.mockResolvedValue(true);
  mockAssertRole.mockResolvedValue(undefined);
  mockReadReadiness.mockResolvedValue([]);
  mockReadReadinessForScope.mockResolvedValue(undefined);
  mockDeleteReadinessForScope.mockResolvedValue(undefined);
  mockRecordReadiness.mockImplementation(async (_db: unknown, input: Record<string, unknown>) => ({
    ...input,
    testedAt: new Date("2026-07-20T12:00:00.000Z"),
  }));
  mockSaveProviderKey.mockResolvedValue({
    secretId: "secret-1",
    providerId: "cursor",
    credentialOwnerId: "cursor",
    envVar: "CURSOR_API_KEY",
    operation: "created",
  });
  mockFindServerAdapter.mockReturnValue({
    type: "claude_local",
    testEnvironment: vi.fn(async () => passingProbe()),
  });
  mockResolveAdapterConfigForRuntime.mockImplementation(
    async (_c: string, _t: string, config: Record<string, unknown>) => ({
      ...config,
      env: { RESOLVED: "1" },
    }),
  );
});

afterEach(() => {
  // The probe slot is module-level process state; a leaked slot 429s every
  // later test in this file.
  tryAcquireAdapterProbeSlot(COMPANY_ID)?.();
});

/* ── GET / ─────────────────────────────────────────────────────────────── */

describe("GET /api/companies/:companyId/providers", () => {
  it("returns every catalog provider with a company_default scope", async () => {
    seedGet();
    const res = await request(makeApp()).get(`/api/companies/${COMPANY_ID}/providers`);
    expect(res.status).toBe(200);
    expect(res.body.providers).toHaveLength(8);
    const claude = res.body.providers.find(
      (p: { descriptor: { id: string } }) => p.descriptor.id === "anthropic",
    );
    expect(claude.descriptor.label).toBe("Claude");
    expect(claude.companyDefault).toMatchObject({
      scopeType: "company_default",
      scopeId: null,
      outcome: "unknown",
      testedAt: null,
    });
    expect(claude.agents).toEqual([]);
  });

  it("includes an agent-scoped entry for each in-use agent", async () => {
    seedGet({
      agents: [{ id: AGENT_ID, name: "Scout", adapterType: "claude_local" }],
      readiness: [cachedRow("anthropic", { scopeType: "agent", scopeId: AGENT_ID }, "needs_auth")],
    });
    const res = await request(makeApp()).get(`/api/companies/${COMPANY_ID}/providers`);
    const claude = res.body.providers.find(
      (p: { descriptor: { id: string } }) => p.descriptor.id === "anthropic",
    );
    expect(claude.agents).toHaveLength(1);
    expect(claude.agents[0]).toMatchObject({
      scopeType: "agent",
      scopeId: AGENT_ID,
      agentName: "Scout",
      outcome: "needs_auth",
    });
  });

  it("excludes archived AND terminated agents from the in-use rows", async () => {
    // `terminated` is a distinct dead status from `archived`; a terminated agent
    // cannot run, so it must not be probed or qualify a provider. The mock db
    // ignores WHERE, so assert the query filters BOTH dead states at the operator.
    seedGet({ agents: [] });
    await request(makeApp()).get(`/api/companies/${COMPANY_ID}/providers`);
    expect(mockNotInArray).toHaveBeenCalledWith(expect.anything(), ["archived", "terminated"]);
  });

  it("NEVER falls back to the company default for an unprobed agent scope", async () => {
    // Company default is verified; the agent scope has NEVER been probed, so
    // there is no agent-scoped row in the cache at all.
    seedGet({
      agents: [{ id: AGENT_ID, name: "Scout", adapterType: "claude_local" }],
      readiness: [cachedRow("anthropic", { scopeType: "company_default" }, "verified")],
    });
    const res = await request(makeApp()).get(`/api/companies/${COMPANY_ID}/providers`);
    const claude = res.body.providers.find(
      (p: { descriptor: { id: string } }) => p.descriptor.id === "anthropic",
    );
    expect(claude.companyDefault.outcome).toBe("verified");
    // The whole point: unprobed is unknown, not the company default's green.
    expect(claude.agents[0].outcome).toBe("unknown");
    expect(claude.agents[0].testedAt).toBeNull();
  });

  it("redacts credential material out of cached checks before transmitting", async () => {
    seedGet({
      readiness: [
        cachedRow("anthropic", { scopeType: "company_default" }, "failed", [
          {
            code: "claude_local_auth_required",
            level: "error",
            message: "rejected key sk-ant-api03-LEAKEDLEAKEDLEAKED",
            hint: "retry with sk-ant-api03-LEAKEDLEAKEDLEAKED",
          },
        ]),
      ],
    });
    const res = await request(makeApp()).get(`/api/companies/${COMPANY_ID}/providers`);
    expect(JSON.stringify(res.body)).not.toContain("sk-ant-api03-LEAKEDLEAKEDLEAKED");
    const claude = res.body.providers.find(
      (p: { descriptor: { id: string } }) => p.descriptor.id === "anthropic",
    );
    expect(claude.companyDefault.checks[0].message).toContain("***REDACTED***");
    expect(claude.companyDefault.checks[0].hint).toContain("***REDACTED***");
  });

  it("reports a pre-existing key stored under an external binding, never its value", async () => {
    seedGet({
      secrets: [{ name: "Commander anthropic API key", status: "active", key: "ANTHROPIC_API_KEY" }],
    });
    const res = await request(makeApp()).get(`/api/companies/${COMPANY_ID}/providers`);
    const claude = res.body.providers.find(
      (p: { descriptor: { id: string } }) => p.descriptor.id === "anthropic",
    );
    // toEqual pins the shape exactly: there is no field carrying the key.
    expect(claude.existingKey).toEqual({
      configured: true,
      source: "external",
      secretName: "Commander anthropic API key",
      envVar: "ANTHROPIC_API_KEY",
    });
  });

  it("does NOT treat a key under an alternativeEnvVar as configuring the borrower", async () => {
    // Cursor lists OPENAI_API_KEY in `alternativeEnvVars`. `llm:openai` is a
    // KNOWN_EXTERNAL_SECRET_BINDING for that env var — but it is CODEX's key.
    // Reporting Cursor as configured because a Codex key exists is exactly the
    // false-green this feature removes. `alternativeEnvVars` are read-only and
    // shared, so they must never drive detection.
    seedGet({ secrets: [{ name: "llm:openai", status: "active" }] });
    const res = await request(makeApp()).get(`/api/companies/${COMPANY_ID}/providers`);
    const byId = (id: string) =>
      res.body.providers.find((p: { descriptor: { id: string } }) => p.descriptor.id === id);
    // Discrimination, not blanket-false: the OWNER of that env var IS configured.
    expect(byId("openai").existingKey).toEqual({
      configured: true,
      source: "external",
      secretName: "llm:openai",
      envVar: "OPENAI_API_KEY",
    });
    expect(byId("cursor").existingKey.configured).toBe(false);
    expect(byId("cursor_cloud").existingKey.configured).toBe(false);
  });

  it("reports the shared cursor secret as configured for BOTH cursor and cursor_cloud", async () => {
    seedGet({ secrets: [{ name: "provider:cursor", status: "active", key: "CURSOR_API_KEY" }] });
    const res = await request(makeApp()).get(`/api/companies/${COMPANY_ID}/providers`);
    const byId = (id: string) =>
      res.body.providers.find((p: { descriptor: { id: string } }) => p.descriptor.id === id);
    expect(byId("cursor").existingKey).toMatchObject({ configured: true, source: "provider" });
    expect(byId("cursor_cloud").existingKey).toMatchObject({
      configured: true,
      source: "provider",
      secretName: "provider:cursor",
    });
    // OpenCode brokers its own credentials — no key input at all.
    expect(byId("opencode").existingKey).toMatchObject({ configured: false, envVar: null });
  });

  it("ignores a non-active secret when reporting pre-existing keys", async () => {
    seedGet({ secrets: [{ name: "provider:anthropic", status: "archived" }] });
    const res = await request(makeApp()).get(`/api/companies/${COMPANY_ID}/providers`);
    const claude = res.body.providers.find(
      (p: { descriptor: { id: string } }) => p.descriptor.id === "anthropic",
    );
    expect(claude.existingKey.configured).toBe(false);
  });

  it("403s a board user without agents:create", async () => {
    seedGet();
    mockCanUser.mockResolvedValue(false);
    const res = await request(makeApp()).get(`/api/companies/${COMPANY_ID}/providers`);
    expect(res.status).toBe(403);
  });

  it("allows an agent actor with the legacy canCreateAgents flag but no grant", async () => {
    // The established config-read gate (routes/agents.ts) accepts a grant OR the
    // legacy permissions.canCreateAgents flag; this route must not disagree.
    mockHasPermission.mockResolvedValue(false); // no principal_permission_grants row
    // 1) actor agent's permissions (legacy flag), then GET's in-use agents + secrets.
    selectResults = [[{ permissions: { canCreateAgents: true } }], [], []];
    mockReadReadiness.mockResolvedValue([]);
    const res = await request(
      makeApp({ type: "agent", agentId: AGENT_ID, companyId: COMPANY_ID }),
    ).get(`/api/companies/${COMPANY_ID}/providers`);
    expect(res.status).toBe(200);
  });

  it("403s an agent actor lacking both the grant and the legacy flag", async () => {
    mockHasPermission.mockResolvedValue(false);
    selectResults = [[{ permissions: {} }]];
    const res = await request(
      makeApp({ type: "agent", agentId: AGENT_ID, companyId: COMPANY_ID }),
    ).get(`/api/companies/${COMPANY_ID}/providers`);
    expect(res.status).toBe(403);
  });
});

/* ── POST /:providerId/test ────────────────────────────────────────────── */

describe("POST /api/companies/:companyId/providers/:providerId/test", () => {
  it("probes the company default with an empty config and records company_default scope", async () => {
    const testEnvironment = vi.fn(async () => passingProbe());
    mockFindServerAdapter.mockReturnValue({ type: "claude_local", testEnvironment });
    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/providers/anthropic/test`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "verified" });
    expect(res.body.testedAt).toBeTruthy();
    expect(res.body.checks[0].code).toBe("claude_local_hello_probe_passed");
    // Company default = company key / host login only, no agent config. The
    // consumer is `system`: the empty config binds no agent secret, and the
    // company key resolves under a system context by design (resolveCompanyProviderKeys).
    expect(mockResolveAdapterConfigForRuntime).toHaveBeenCalledWith(
      COMPANY_ID,
      "claude_local",
      {},
      expect.objectContaining({ consumerType: "system" }),
    );
    expect(mockRecordReadiness).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: COMPANY_ID,
        providerId: "anthropic",
        scope: { type: "company_default" },
        outcome: "verified",
      }),
    );
  });

  it("probes an agent scope with that agent's persisted adapterConfig", async () => {
    const agentConfig = { model: "opus", env: { ANTHROPIC_API_KEY: { type: "secret_ref" } } };
    selectResults = [[{ id: AGENT_ID, companyId: COMPANY_ID, adapterType: "claude_local", adapterConfig: agentConfig }]];
    const testEnvironment = vi.fn(async () => passingProbe());
    mockFindServerAdapter.mockReturnValue({ type: "claude_local", testEnvironment });
    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/providers/anthropic/test?scope=agent&agentId=${AGENT_ID}`)
      .send({});
    expect(res.status).toBe(200);
    // adapterType is the SECOND parameter. The 4th (consumer context) MUST be an
    // `agent` consumer bound to this agent's id — so binding enforcement
    // (shouldEnforceSecretBinding) hits the SAME path a real run uses. A `system`
    // consumer here would skip the binding check and cache `verified` for a
    // secret the runner would reject as unbound (Codex P2, false-green).
    expect(mockResolveAdapterConfigForRuntime).toHaveBeenCalledWith(
      COMPANY_ID,
      "claude_local",
      agentConfig,
      expect.objectContaining({ consumerType: "agent", consumerId: AGENT_ID }),
    );
    expect(mockRecordReadiness).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: { type: "agent", agentId: AGENT_ID } }),
    );
  });

  it("overwrites a stale readiness row with failed when config resolution throws", async () => {
    // A revoked/unbound agent secret_ref makes resolveAdapterConfigForRuntime
    // throw BEFORE the CLI runs. Without overwriting, a previously-`verified` row
    // would survive and keep rendering the agent as Ready. The route must record
    // `failed` for THIS scope, then still surface the error.
    const agentConfig = { env: { ANTHROPIC_API_KEY: { type: "secret_ref" } } };
    selectResults = [
      [{ id: AGENT_ID, companyId: COMPANY_ID, adapterType: "claude_local", adapterConfig: agentConfig }],
    ];
    mockFindServerAdapter.mockReturnValue({ type: "claude_local", testEnvironment: vi.fn() });
    mockResolveAdapterConfigForRuntime.mockRejectedValueOnce(
      new Error("Secret is not bound to this consumer path"),
    );
    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/providers/anthropic/test?scope=agent&agentId=${AGENT_ID}`)
      .send({});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockRecordReadiness).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scope: { type: "agent", agentId: AGENT_ID },
        outcome: "failed",
      }),
    );
  });

  it("overwrites a stale readiness row with failed when the adapter probe THROWS", async () => {
    // Config resolves, but testEnvironment itself throws (e.g. an unexpected spawn
    // error) instead of returning status:"fail". Symmetric with the resolution
    // throw: a prior `verified` row must not survive the crash.
    selectResults = [
      [
        {
          id: AGENT_ID,
          companyId: COMPANY_ID,
          adapterType: "claude_local",
          adapterConfig: {},
          status: "idle",
        },
      ],
    ];
    mockFindServerAdapter.mockReturnValue({
      type: "claude_local",
      testEnvironment: vi.fn().mockRejectedValue(new Error("spawn EPERM")),
    });
    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/providers/anthropic/test?scope=agent&agentId=${AGENT_ID}`)
      .send({});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockRecordReadiness).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: { type: "agent", agentId: AGENT_ID }, outcome: "failed" }),
    );
  });

  it("404s a probe for a terminated agent (never mints an orphan scope row)", async () => {
    selectResults = [
      [
        {
          id: AGENT_ID,
          companyId: COMPANY_ID,
          adapterType: "claude_local",
          adapterConfig: {},
          status: "terminated",
        },
      ],
    ];
    mockFindServerAdapter.mockReturnValue({
      type: "claude_local",
      testEnvironment: vi.fn(async () => passingProbe()),
    });
    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/providers/anthropic/test?scope=agent&agentId=${AGENT_ID}`)
      .send({});
    expect(res.status).toBe(404);
    expect(mockRecordReadiness).not.toHaveBeenCalled();
  });

  it("redacts probe checks in the HTTP response", async () => {
    mockFindServerAdapter.mockReturnValue({
      type: "claude_local",
      testEnvironment: vi.fn(async () =>
        passingProbe([
          {
            code: "claude_local_auth_required",
            level: "error",
            message: "bad key sk-ant-api03-LEAKEDLEAKEDLEAKED",
          },
        ]),
      ),
    });
    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/providers/anthropic/test`)
      .send({});
    expect(JSON.stringify(res.body)).not.toContain("sk-ant-api03-LEAKEDLEAKEDLEAKED");
    expect(res.body.checks[0].message).toContain("***REDACTED***");
  });

  it("404s an unknown provider", async () => {
    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/providers/not-a-provider/test`)
      .send({});
    expect(res.status).toBe(404);
    expect(mockRecordReadiness).not.toHaveBeenCalled();
  });

  it("429s when a probe is already running for the company", async () => {
    const release = tryAcquireAdapterProbeSlot(COMPANY_ID);
    expect(release).toBeTruthy();
    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/providers/anthropic/test`)
      .send({});
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeTruthy();
    release?.();
  });

  it("is guarded as a configuration READ, not founder-gated", async () => {
    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/providers/anthropic/test`)
      .send({});
    expect(res.status).toBe(200);
    // A team lead with agents:create must be able to refresh the badge.
    expect(mockAssertRole).not.toHaveBeenCalled();
    expect(mockCanUser).toHaveBeenCalledWith(COMPANY_ID, "user-1", "agents:create");
  });

  it("403s a caller without configuration read access", async () => {
    mockCanUser.mockResolvedValue(false);
    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/providers/anthropic/test`)
      .send({});
    expect(res.status).toBe(403);
  });
});

/* ── POST /:providerId/key ─────────────────────────────────────────────── */

describe("POST /api/companies/:companyId/providers/:providerId/key", () => {
  it("saves the key and returns only ok + secretId", async () => {
    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/providers/cursor/key`)
      .send({ value: "key_SUPERSECRETVALUE123456" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.secretId).toBe("secret-1");
    expect(JSON.stringify(res.body)).not.toContain("key_SUPERSECRETVALUE123456");
    expect(mockSaveProviderKey).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ companyId: COMPANY_ID, providerId: "cursor", value: "key_SUPERSECRETVALUE123456" }),
    );
    // The key changed, so agent scopes that resolve through the company fallback
    // are cleared (→ unknown) — a rotated/bad key must not leave a stale
    // `verified` agent badge.
    expect(mockDeleteAgentReadinessForProvider).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      "cursor",
    );
    // Credential-grade mutation → the Activity feed records WHO did it (the same
    // bar commander-key/secrets meet). The raw value is never in the details.
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: COMPANY_ID,
        action: "provider.key.saved",
        entityType: "provider",
        entityId: "cursor",
      }),
    );
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("key_SUPERSECRETVALUE123456");
  });

  it("is founder-gated via an explicit board-actor check", async () => {
    mockAssertRole.mockRejectedValue(forbidden("Requires role: founder"));
    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/providers/cursor/key`)
      .send({ value: "key_abc" });
    expect(res.status).toBe(403);
    expect(mockSaveProviderKey).not.toHaveBeenCalled();
  });

  it("401s a non-board actor (assertRole is a no-op for agents)", async () => {
    const res = await request(makeApp({ type: "agent", agentId: AGENT_ID, companyId: COMPANY_ID }))
      .post(`/api/companies/${COMPANY_ID}/providers/cursor/key`)
      .send({ value: "key_abc" });
    expect(res.status).toBe(401);
    expect(mockSaveProviderKey).not.toHaveBeenCalled();
  });

  it("re-probes EVERY provider in the credential group, not just the one saved", async () => {
    // cursor + cursor_cloud share `provider:cursor`.
    mockFindServerAdapter.mockReturnValue({
      type: "cursor",
      testEnvironment: vi.fn(async () => passingProbe()),
    });
    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/providers/cursor/key`)
      .send({ value: "key_abc" });
    expect(res.status).toBe(200);
    const probed = mockRecordReadiness.mock.calls.map((c) => (c[1] as { providerId: string }).providerId);
    expect(probed).toContain("cursor");
    expect(probed).toContain("cursor_cloud");
  });

  it("re-probes the anthropic credential group (claude + pi share provider:anthropic)", async () => {
    mockSaveProviderKey.mockResolvedValue({
      secretId: "secret-2",
      providerId: "pi",
      credentialOwnerId: "anthropic",
      envVar: "ANTHROPIC_API_KEY",
      operation: "created",
    });
    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/providers/pi/key`)
      .send({ value: "sk-ant-abc" });
    expect(res.status).toBe(200);
    const probed = mockRecordReadiness.mock.calls.map((c) => (c[1] as { providerId: string }).providerId);
    expect(probed).toContain("anthropic");
    expect(probed).toContain("pi");
  });

  it("re-probes ONLY company_default scopes — an agent's own revoked binding stays red", async () => {
    await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/providers/cursor/key`)
      .send({ value: "key_abc" });
    const scopes = mockRecordReadiness.mock.calls.map((c) => (c[1] as { scope: { type: string } }).scope);
    expect(scopes.length).toBeGreaterThan(0);
    for (const scope of scopes) expect(scope).toEqual({ type: "company_default" });
  });

  it("404s an unknown provider and 400s a keyless one", async () => {
    const unknown = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/providers/nope/key`)
      .send({ value: "x" });
    expect(unknown.status).toBe(404);

    // opencode is in the catalog but brokers its own credentials — the REAL
    // `resolveProviderKeyTarget` raises badRequest, which must surface as 400.
    const keyless = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/providers/opencode/key`)
      .send({ value: "x" });
    expect(keyless.status).toBe(400);
  });

  it("invalidates the whole group when the re-probe cannot start (busy slot)", async () => {
    // The shared probe slot is held by a concurrent agent/Commander probe, so
    // no fresh verdict can be minted. The cached rows now describe a credential
    // that no longer exists — they must be DROPPED, not left rendering green.
    const release = tryAcquireAdapterProbeSlot(COMPANY_ID);
    expect(release).toBeTruthy();
    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/providers/cursor/key`)
      .send({ value: "key_abc" });
    release?.();

    expect(res.status).toBe(200);
    expect(res.body.reprobed).toEqual([]);
    expect(res.body.invalidated).toEqual(expect.arrayContaining(["cursor", "cursor_cloud"]));
    expect(mockRecordReadiness).not.toHaveBeenCalled();
    const dropped = mockDeleteReadinessForScope.mock.calls.map((c) => c[2]);
    expect(dropped).toContain("cursor");
    expect(dropped).toContain("cursor_cloud");
    // Only the company default is dropped — an agent's own binding is untouched.
    for (const call of mockDeleteReadinessForScope.mock.calls) {
      expect(call[3]).toEqual({ type: "company_default" });
    }
  });

  it("invalidates when the re-probe starts and then throws", async () => {
    mockFindServerAdapter.mockReturnValue({
      type: "cursor",
      testEnvironment: vi.fn(async () => {
        throw new Error("CLI exploded");
      }),
    });
    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/providers/cursor/key`)
      .send({ value: "key_abc" });
    expect(res.status).toBe(200);
    expect(res.body.invalidated).toEqual(expect.arrayContaining(["cursor", "cursor_cloud"]));
  });

  it("maps a concurrent unique violation to 409, not 500", async () => {
    const uniqueViolation = Object.assign(
      new Error('duplicate key value violates unique constraint "company_secrets_company_name_uq"'),
      { code: "23505", constraint: "company_secrets_company_name_uq" },
    );
    mockSaveProviderKey.mockRejectedValue(uniqueViolation);
    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/providers/cursor/key`)
      .send({ value: "key_abc" });
    expect(res.status).toBe(409);
  });

  it("does NOT map a 23505 from another constraint to 409", async () => {
    // A unique violation raised elsewhere in the save transaction is a genuine
    // 500; answering it with a 409 would name the wrong cause.
    mockSaveProviderKey.mockRejectedValue(
      Object.assign(new Error('duplicate key value violates unique constraint "activity_log_uq"'), {
        code: "23505",
        constraint: "activity_log_uq",
      }),
    );
    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/providers/cursor/key`)
      .send({ value: "key_abc" });
    expect(res.status).toBe(500);
  });

  it("400s an empty value without touching the vault", async () => {
    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/providers/cursor/key`)
      .send({ value: "   " });
    expect(res.status).toBe(400);
    expect(mockSaveProviderKey).not.toHaveBeenCalled();
  });

  it("still returns 200 when the post-save re-probe fails", async () => {
    mockFindServerAdapter.mockReturnValue({
      type: "cursor",
      testEnvironment: vi.fn(async () => {
        throw new Error("CLI exploded");
      }),
    });
    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/providers/cursor/key`)
      .send({ value: "key_abc" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
