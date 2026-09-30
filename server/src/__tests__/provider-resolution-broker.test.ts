// server/src/__tests__/provider-resolution-broker.test.ts
//
// E7-1 provider-credential broker (migration 0281) — the buildResolveDeps broker path over the
// operator pool. These are UNIT tests: drizzle's `sql` template and the operator db.execute are
// faked so the assertions are about the Node policy layer — candidateMatchesScope's defense-in-
// depth re-filter (Function A), the resolveSecretValue check SEQUENCE, and the audit-after-decrypt
// timing / error-code fidelity (Function B + C). The real SQL functions and role grants are
// exercised by provider-credential-broker-real-role.integration.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@armyofagents/db", () => ({
  providerConnections: {},
  providerAssignments: {},
  companyMemberships: {},
}));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  or: (...a: unknown[]) => ({ or: a }),
  isNull: (a: unknown) => ({ isNull: a }),
  // Capture the raw template so the fake execute can route by the function named in the query,
  // and so a test can read the interpolated audit parameters.
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ __strings: strings, __values: values }),
}));

// vi.hoisted so the vi.mock factory (hoisted above imports) can reference the spy safely.
const { mockResolveVersion } = vi.hoisted(() => ({
  mockResolveVersion: vi.fn(async () => "sk-decrypted-value"),
}));
vi.mock("../secrets/provider-registry.js", () => ({
  getSecretProvider: vi.fn(() => ({ resolveVersion: mockResolveVersion })),
  listSecretProviders: vi.fn(() => []),
  checkSecretProviders: vi.fn(async () => []),
}));

import { buildResolveDeps, setProviderCredentialBrokerDb } from "../services/provider-resolution-deps.js";
import type { CandidateRow, ResolveArgs } from "../services/provider-resolution.js";

const MULTI = { trustBoundary: "multi_tenant" } as never;
const ORG = "org-1";
const COMPANY = "company-1";

type FakeQuery = { __strings: TemplateStringsArray; __values: unknown[] };
function fnName(arg: unknown): string {
  return ((arg as FakeQuery).__strings ?? []).join(" ");
}

/** A fake operator db that routes execute() by the SECURITY DEFINER function named in the query. */
function fakeOperatorDb(responders: { candidates?: () => unknown[]; bundle?: () => unknown[] }) {
  const auditCalls: FakeQuery[] = [];
  const execute = vi.fn(async (arg: FakeQuery) => {
    const q = fnName(arg);
    if (q.includes("resolve_provider_assignment_candidates")) return { rows: responders.candidates?.() ?? [] };
    if (q.includes("resolve_company_secret_bundle")) return { rows: responders.bundle?.() ?? [] };
    if (q.includes("record_company_secret_access")) {
      auditCalls.push(arg);
      return { rows: [] };
    }
    throw new Error(`unexpected broker query: ${q}`);
  });
  return { db: { execute } as never, auditCalls };
}

function makeArgs(overrides: Partial<ResolveArgs> = {}): ResolveArgs {
  return {
    organizationId: ORG,
    companyId: COMPANY,
    agentId: "agent-1",
    actorKind: "org",
    adapterType: "claude_local",
    provider: "anthropic",
    executionTargetId: "target-1",
    currentEnv: {},
    context: { consumerType: "system", consumerId: "conn-1", actorType: "system" },
    ...overrides,
  };
}

// audit __values order (see resolveSecretValueViaBroker's `audit` closure): [companyId, secretId,
// resolvedVersion, secretProvider, actorType, actorId, consumerType, consumerId, issueId,
// heartbeatRunId, pluginId, configPath, outcome, errorCode].
function auditOutcome(call: FakeQuery) {
  return {
    version: call.__values[2],
    provider: call.__values[3],
    outcome: call.__values[12],
    errorCode: call.__values[13],
  };
}

function bundleRow(overrides: Record<string, unknown> = {}) {
  return {
    secret_found: true,
    secret_company_id: COMPANY,
    secret_status: "active",
    secret_is_deleted: false,
    secret_provider: "local_encrypted",
    secret_external_ref: null,
    secret_provider_metadata: null,
    secret_latest_version: 1,
    secret_provider_config_id: null,
    resolved_version: 1,
    version_found: true,
    version_material: { ciphertext: "x" },
    provider_config_found: false,
    provider_config_company_id: null,
    provider_config_provider: null,
    provider_config_status: null,
    provider_config_disabled: false,
    provider_config_config: null,
    binding_found: false,
    ...overrides,
  };
}

const ROW = {
  connectionId: "conn-1",
  authMethod: "api_key",
  scopeType: "company_default",
  scopeId: null,
  priority: 0,
  connectionUpdatedAt: 0,
  state: "verified",
  termsAttestedAt: null,
  sharingPolicy: "owner_only",
  connectionCompanyId: COMPANY,
  connectionOrganizationId: ORG,
  connectionOwnerUserId: null,
  executionTargetId: null,
  config: {},
  secretRef: "secret-1",
} as CandidateRow;

afterEach(() => {
  vi.clearAllMocks();
  mockResolveVersion.mockResolvedValue("sk-decrypted-value");
});

describe("broker loadCandidateRows (Function A path)", () => {
  it("maps a raw company_default candidate row (coercing priority/updatedAt/config) and keeps it", async () => {
    const { db } = fakeOperatorDb({
      candidates: () => [
        {
          connection_id: "conn-9",
          auth_method: "api_key",
          scope_type: "company_default",
          scope_id: null,
          priority: "5",
          connection_updated_at: "2026-01-01T00:00:00Z",
          state: "verified",
          terms_attested_at: null,
          sharing_policy: "owner_only",
          connection_company_id: COMPANY,
          connection_organization_id: ORG,
          connection_owner_user_id: null,
          execution_target_id: null,
          config: null,
          secret_ref: "secret-9",
        },
      ],
    });
    setProviderCredentialBrokerDb(db);
    const deps = buildResolveDeps({} as never, MULTI);
    const rows = await deps.loadCandidateRows({} as never, makeArgs());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connectionId: "conn-9",
      scopeType: "company_default",
      priority: 5, // "5" -> 5
      secretRef: "secret-9",
      config: {}, // null -> {}
    });
    expect(rows[0]!.connectionUpdatedAt).toBeGreaterThan(0); // parsed to epoch ms
  });

  it("re-filters an org-mismatched org_default row OUT (defense in depth over the SQL scope)", async () => {
    // The SQL already scopes org_default by organization, but the Node candidateMatchesScope
    // re-check is the boundary this asserts: a row that somehow arrived for a DIFFERENT org must
    // not survive.
    const { db } = fakeOperatorDb({
      candidates: () => [
        {
          connection_id: "conn-x",
          auth_method: "api_key",
          scope_type: "org_default",
          scope_id: null,
          priority: 0,
          connection_updated_at: null,
          state: "verified",
          terms_attested_at: null,
          sharing_policy: "owner_only",
          connection_company_id: null,
          connection_organization_id: "other-org",
          connection_owner_user_id: null,
          execution_target_id: null,
          config: {},
          secret_ref: "secret-x",
        },
      ],
    });
    setProviderCredentialBrokerDb(db);
    const deps = buildResolveDeps({} as never, MULTI);
    const rows = await deps.loadCandidateRows({} as never, makeArgs({ organizationId: ORG }));
    expect(rows).toEqual([]);
  });
});

describe("broker resolveSecretValueForConnection (Function B + C path)", () => {
  it("returns the decrypted value and fires a success audit", async () => {
    const { db, auditCalls } = fakeOperatorDb({ bundle: () => [bundleRow()] });
    setProviderCredentialBrokerDb(db);
    const deps = buildResolveDeps({} as never, MULTI);
    const value = await deps.resolveSecretValueForConnection({} as never, ROW, makeArgs());
    expect(value).toBe("sk-decrypted-value");
    expect(auditCalls).toHaveLength(1);
    expect(auditOutcome(auditCalls[0]!)).toMatchObject({
      outcome: "success",
      errorCode: null,
      provider: "local_encrypted",
      version: 1,
    });
  });

  it("throws secret_unbound and fires a failure audit when a required binding is missing", async () => {
    const { db, auditCalls } = fakeOperatorDb({ bundle: () => [bundleRow({ binding_found: false })] });
    setProviderCredentialBrokerDb(db);
    const deps = buildResolveDeps({} as never, MULTI);
    // consumerType "agent" => shouldEnforceSecretBinding is true (configPath is always set here).
    const args = makeArgs({
      context: { consumerType: "agent", consumerId: "agent-1", actorType: "agent", actorId: "agent-1" },
    });
    await expect(deps.resolveSecretValueForConnection({} as never, ROW, args)).rejects.toMatchObject({
      code: "secret_unbound",
    });
    expect(auditCalls).toHaveLength(1);
    expect(auditOutcome(auditCalls[0]!)).toMatchObject({ outcome: "failure", errorCode: "secret_unbound" });
  });

  it("throws provider_config_disabled and fires a failure audit", async () => {
    const { db, auditCalls } = fakeOperatorDb({
      bundle: () => [
        bundleRow({
          secret_provider_config_id: "cfg-1",
          provider_config_found: true,
          provider_config_company_id: COMPANY,
          provider_config_provider: "local_encrypted",
          provider_config_status: "disabled",
          provider_config_disabled: true,
        }),
      ],
    });
    setProviderCredentialBrokerDb(db);
    const deps = buildResolveDeps({} as never, MULTI);
    await expect(deps.resolveSecretValueForConnection({} as never, ROW, makeArgs())).rejects.toMatchObject({
      code: "provider_config_disabled",
    });
    expect(auditCalls).toHaveLength(1);
    expect(auditOutcome(auditCalls[0]!)).toMatchObject({
      outcome: "failure",
      errorCode: "provider_config_disabled",
    });
  });

  it("audits an INACTIVE-secret failure (fidelity: the direct path audits once the secret row exists)", async () => {
    // Regression guard for the audit-timing fix: secretProvider is captured as soon as the secret
    // row exists, so inactive/deleted/company-mismatch failures write the secret_access_events
    // tamper row the direct resolveSecretValue path always writes.
    const { db, auditCalls } = fakeOperatorDb({ bundle: () => [bundleRow({ secret_status: "revoked" })] });
    setProviderCredentialBrokerDb(db);
    const deps = buildResolveDeps({} as never, MULTI);
    await expect(deps.resolveSecretValueForConnection({} as never, ROW, makeArgs())).rejects.toMatchObject({
      code: "secret_inactive",
    });
    expect(auditCalls, "an inactive secret must still write the failure audit row").toHaveLength(1);
    expect(auditOutcome(auditCalls[0]!)).toMatchObject({
      outcome: "failure",
      errorCode: "secret_inactive",
      provider: "local_encrypted",
    });
  });

  it("refuses an mcp-oauth-managed secret for a generic consumer (R3 guard parity)", async () => {
    // Broker parity with resolveSecretValue's assertMcpOAuthResolutionAllowed: an mcp:* OAuth
    // bundle must not be resolvable by a generic (non-broker) consumer, even on the broker path.
    const { db, auditCalls } = fakeOperatorDb({
      bundle: () => [bundleRow({ secret_provider_metadata: { purpose: "mcp_oauth" } })],
    });
    setProviderCredentialBrokerDb(db);
    const deps = buildResolveDeps({} as never, MULTI);
    const args = makeArgs({
      context: { consumerType: "agent", consumerId: "agent-1", actorType: "agent", actorId: "agent-1" },
    });
    await expect(deps.resolveSecretValueForConnection({} as never, ROW, args)).rejects.toMatchObject({
      status: 422,
    });
    // secretProvider is captured, so the refusal still writes a failure audit (http_422).
    expect(auditCalls).toHaveLength(1);
    expect(auditOutcome(auditCalls[0]!)).toMatchObject({ outcome: "failure", errorCode: "http_422" });
  });

  it("parses string-encoded jsonb material from raw db.execute before decrypting", async () => {
    // Regression guard: raw db.execute returns a RETURNS TABLE jsonb column as a JSON string;
    // asJsonb must parse it so resolveVersion receives the material OBJECT, not the string.
    const { db } = fakeOperatorDb({
      bundle: () => [bundleRow({ version_material: JSON.stringify({ ciphertext: "zz" }) })],
    });
    setProviderCredentialBrokerDb(db);
    const deps = buildResolveDeps({} as never, MULTI);
    await deps.resolveSecretValueForConnection({} as never, ROW, makeArgs());
    expect(mockResolveVersion).toHaveBeenCalledWith(
      expect.objectContaining({ material: { ciphertext: "zz" } }),
    );
  });

  it("still refuses a STRING-encoded mcp-oauth metadata (asJsonb before the R3 guard)", async () => {
    // If secret_provider_metadata arrives as a JSON string, asRecord() inside the guard would see
    // a string and skip — so asJsonb must run first or the R3 refusal is silently defeated.
    const { db, auditCalls } = fakeOperatorDb({
      bundle: () => [bundleRow({ secret_provider_metadata: JSON.stringify({ purpose: "mcp_oauth" }) })],
    });
    setProviderCredentialBrokerDb(db);
    const deps = buildResolveDeps({} as never, MULTI);
    const args = makeArgs({
      context: { consumerType: "agent", consumerId: "agent-1", actorType: "agent", actorId: "agent-1" },
    });
    await expect(deps.resolveSecretValueForConnection({} as never, ROW, args)).rejects.toMatchObject({
      status: 422,
    });
    expect(auditCalls).toHaveLength(1);
  });

  it("the Node company backstop throws http_422 and audits it (matches the direct path's code)", async () => {
    // Function B scopes by company in SQL, so this backstop is unreachable in practice; when it
    // does fire it must audit http_422, not secret_resolve_failed — hence unprocessable().
    const { db, auditCalls } = fakeOperatorDb({
      bundle: () => [bundleRow({ secret_company_id: "other-company" })],
    });
    setProviderCredentialBrokerDb(db);
    const deps = buildResolveDeps({} as never, MULTI);
    await expect(deps.resolveSecretValueForConnection({} as never, ROW, makeArgs())).rejects.toMatchObject({
      status: 422,
    });
    expect(auditOutcome(auditCalls[0]!)).toMatchObject({ outcome: "failure", errorCode: "http_422" });
  });

  it("does NOT audit when the secret row is absent (mirrors getById returning null)", async () => {
    const { db, auditCalls } = fakeOperatorDb({ bundle: () => [] });
    setProviderCredentialBrokerDb(db);
    const deps = buildResolveDeps({} as never, MULTI);
    await expect(deps.resolveSecretValueForConnection({} as never, ROW, makeArgs())).rejects.toMatchObject({
      code: "secret_missing",
    });
    expect(auditCalls, "a truly-missing secret has no row to attribute an audit event to").toHaveLength(0);
  });

  it("returns null without touching the broker when the candidate has no secretRef", async () => {
    const { db, auditCalls } = fakeOperatorDb({});
    setProviderCredentialBrokerDb(db);
    const deps = buildResolveDeps({} as never, MULTI);
    const noSecret = { ...ROW, secretRef: null } as CandidateRow;
    const value = await deps.resolveSecretValueForConnection({} as never, noSecret, makeArgs());
    expect(value).toBeNull();
    expect(auditCalls).toHaveLength(0);
  });
});
