// E7-1 provider-credential broker (migration 0281) — the three SECURITY DEFINER functions on a
// REAL aoa_operator connection against a REAL migrated database.
//
// The unit tests (provider-resolution-broker.test.ts) fake db.execute, so none of them can
// observe what actually matters here: that aoa_operator — the pool the broker runs on — is
// permission-denied on every owner-only credential table (each raises 42501), yet CAN call the
// three definer functions, which run with OWNER authority; and that aoa_app cannot call them at
// all. That asymmetry IS the security boundary. A table grant to either serving role would defeat
// assertExactServingRoleAuthority at boot (verified live: the CP exits on
// distributed_execution_app_authority), which is why the widening is definer functions granted to
// aoa_operator ONLY.
//
// Windows-skipped unless AOA_RUN_WIN_INTEGRATION=1 (embedded-postgres cannot start on the
// `runneradmin` CI runner — Issue #114); Linux CI is the authority.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import type { Sql } from "postgres";
import { startMigratedDatabase } from "./helpers/migrated-database.js";

const ORG = "d7000000-0000-4000-8000-000000000001";
const COMPANY = "d7000000-0000-4000-8000-000000000002";
const CONNECTION = "d7000000-0000-4000-8000-000000000003";
const SECRET = "d7000000-0000-4000-8000-000000000004";
const ASSIGNMENT = "d7000000-0000-4000-8000-000000000005";
const BINDING = "d7000000-0000-4000-8000-000000000006";

// A second organization whose org_default assignment must NEVER surface for ORG's run.
const OTHER_ORG = "d7000000-0000-4000-8000-000000000011";
const NEIGHBOUR = "d7000000-0000-4000-8000-000000000012";
const NEIGHBOUR_CONN = "d7000000-0000-4000-8000-000000000013";
const NEIGHBOUR_ASSIGN = "d7000000-0000-4000-8000-000000000014";
const NEIGHBOUR_SECRET = "d7000000-0000-4000-8000-000000000015";

const PROVIDER = "anthropic";
const CONFIG_PATH = `provider_connection.${CONNECTION}`;
const TARGET_TYPE = "agent";
const TARGET_ID = "d7000000-0000-4000-8000-0000000000a1";
const MATERIAL = { scheme: "test-aead", ciphertext: "deadbeef", iv: "cafe" };

// Owner-only: neither serving role may hold ANY grant. The broker's own pool (aoa_operator) must
// be denied a direct SELECT and reach them only through the definer functions.
const CREDENTIAL_TABLES = [
  "provider_assignments",
  "provider_connections",
  "company_secrets",
  "company_secret_versions",
  "company_secret_bindings",
  "company_secret_provider_configs",
  "secret_access_events",
] as const;

const RUN = process.platform !== "win32" || process.env.AOA_RUN_WIN_INTEGRATION === "1";

type Fixture = { appDb: Db; operatorDb: Db; admin: Sql; teardown: () => Promise<void> };

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}

async function setUp(): Promise<Fixture> {
  const database = await startMigratedDatabase({ label: "aoa-cred-broker-" });
  const { admin, appDb, operatorDb, teardown } = database;
  try {
    // Seed as ADMIN, resolve as aoa_operator — that asymmetry is the whole point.
    await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Broker org', 'broker-org')`;
    await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
      VALUES (${COMPANY}, ${ORG}, 'Broker company', 'BRK')`;

    await admin`INSERT INTO company_secrets (id, company_id, organization_id, name, provider, status, latest_version)
      VALUES (${SECRET}, ${COMPANY}, ${ORG}, 'anthropic-key', 'local_encrypted', 'active', 1)`;
    await admin`INSERT INTO company_secret_versions (id, secret_id, version, material, value_sha256, status)
      VALUES (gen_random_uuid(), ${SECRET}, 1, ${JSON.stringify(MATERIAL)}::jsonb, 'sha-1', 'current')`;
    await admin`INSERT INTO provider_connections
      (id, organization_id, company_id, provider, auth_method, secret_ref, state, sharing_policy)
      VALUES (${CONNECTION}, ${ORG}, ${COMPANY}, ${PROVIDER}, 'api_key', ${SECRET}, 'verified', 'owner_only')`;
    await admin`INSERT INTO provider_assignments
      (id, organization_id, company_id, connection_id, provider, scope_type, priority, state)
      VALUES (${ASSIGNMENT}, ${ORG}, ${COMPANY}, ${CONNECTION}, ${PROVIDER}, 'company_default', 0, 'active')`;
    await admin`INSERT INTO company_secret_bindings
      (id, company_id, secret_id, target_type, target_id, config_path, required)
      VALUES (${BINDING}, ${COMPANY}, ${SECRET}, ${TARGET_TYPE}, ${TARGET_ID}, ${CONFIG_PATH}, true)`;

    // A neighbouring tenant whose org_default assignment must not leak into ORG's candidate set.
    await admin`INSERT INTO organizations (id, name, slug) VALUES (${OTHER_ORG}, 'Neighbour org', 'nbr-org')`;
    await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
      VALUES (${NEIGHBOUR}, ${OTHER_ORG}, 'Neighbour company', 'NBR')`;
    // A secret owned by the neighbour company — Function B must refuse to bundle it for COMPANY,
    // and it backs the neighbour connection below (provider_connections_api_key_shape_check
    // requires an api_key connection to carry a secret_ref; seed it before the connection for the FK).
    await admin`INSERT INTO company_secrets (id, company_id, organization_id, name, provider, status, latest_version)
      VALUES (${NEIGHBOUR_SECRET}, ${NEIGHBOUR}, ${OTHER_ORG}, 'neighbour-key', 'local_encrypted', 'active', 1)`;
    await admin`INSERT INTO provider_connections
      (id, organization_id, company_id, provider, auth_method, secret_ref, state, sharing_policy)
      VALUES (${NEIGHBOUR_CONN}, ${OTHER_ORG}, ${NEIGHBOUR}, ${PROVIDER}, 'api_key', ${NEIGHBOUR_SECRET}, 'verified', 'owner_only')`;
    // company_id NULL + scope_type org_default: an org-wide default owned by the neighbour org.
    await admin`INSERT INTO provider_assignments
      (id, organization_id, company_id, connection_id, provider, scope_type, priority, state)
      VALUES (${NEIGHBOUR_ASSIGN}, ${OTHER_ORG}, NULL, ${NEIGHBOUR_CONN}, ${PROVIDER}, 'org_default', 0, 'active')`;

    return { appDb, operatorDb, admin, teardown };
  } catch (error) {
    await teardown();
    throw error;
  }
}

describe.skipIf(!RUN)("E7-1 provider-credential broker on a real aoa_operator connection", () => {
  let fixture: Fixture | null = null;

  beforeAll(async () => {
    fixture = await setUp();
  }, 180_000);

  afterAll(async () => {
    await fixture?.teardown();
  }, 60_000);

  // ── The boundary: the broker's own pool cannot read the credential model directly ──────────
  it.each(CREDENTIAL_TABLES)("denies aoa_operator a direct SELECT on %s (42501)", async (table) => {
    let raised: unknown;
    try {
      await fixture!.operatorDb.execute(sql.raw(`SELECT * FROM ${table} LIMIT 1`));
    } catch (error) {
      raised = error;
    }
    expect(raised, `${table} is readable by aoa_operator — a grant crept in`).toBeDefined();
    const cause = (raised as { cause?: unknown }).cause ?? raised;
    expect((cause as { code?: string }).code, table).toBe("42501");
  });

  // ── Function A — candidates, company-scoped ────────────────────────────────────────────────
  it("resolve_provider_assignment_candidates returns the seeded company_default candidate", async () => {
    const rows = rowsOf<Record<string, unknown>>(
      await fixture!.operatorDb.execute(sql`
        SELECT * FROM public.resolve_provider_assignment_candidates(
          ${ORG}::uuid, ${COMPANY}::uuid, ${PROVIDER}::text)`),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.connection_id).toBe(CONNECTION);
    expect(rows[0]!.scope_type).toBe("company_default");
    expect(rows[0]!.secret_ref).toBe(SECRET);
  });

  it("does not return another organization's org_default candidate", async () => {
    // The neighbour's org_default (company_id NULL, OTHER_ORG) must be excluded when ORG asks.
    const rows = rowsOf<Record<string, unknown>>(
      await fixture!.operatorDb.execute(sql`
        SELECT * FROM public.resolve_provider_assignment_candidates(
          ${ORG}::uuid, ${COMPANY}::uuid, ${PROVIDER}::text)`),
    );
    expect(rows.map((r) => r.connection_id)).not.toContain(NEIGHBOUR_CONN);
  });

  // ── Function B — the secret bundle, including encrypted material ────────────────────────────
  it("resolve_company_secret_bundle returns the secret meta, version material, and binding", async () => {
    const bundle = rowsOf<Record<string, unknown>>(
      await fixture!.operatorDb.execute(sql`
        SELECT * FROM public.resolve_company_secret_bundle(
          ${COMPANY}::uuid, ${SECRET}::uuid, NULL::integer,
          ${TARGET_TYPE}::text, ${TARGET_ID}::text, ${CONFIG_PATH}::text)`),
    )[0]!;
    expect(bundle.secret_found).toBe(true);
    expect(bundle.secret_company_id).toBe(COMPANY);
    expect(bundle.secret_status).toBe("active");
    expect(bundle.secret_is_deleted).toBe(false);
    expect(bundle.secret_provider).toBe("local_encrypted");
    expect(bundle.secret_provider_metadata).toBeNull(); // carried for the R3 mcp-oauth guard
    expect(Number(bundle.resolved_version)).toBe(1);
    expect(bundle.version_found).toBe(true);
    // Raw db.execute returns the jsonb `material` column as a JSON string (the broker's asJsonb
    // normalizes it); normalize here the same way so the assertion reflects what the broker sees.
    const material =
      typeof bundle.version_material === "string"
        ? JSON.parse(bundle.version_material)
        : bundle.version_material;
    expect(material).toEqual(MATERIAL);
    expect(bundle.binding_found).toBe(true);
  });

  it("resolve_company_secret_bundle refuses a secret owned by another company (DB-layer scoping)", async () => {
    // The material-bearing definer is scoped by `cs.company_id = p_company_id`, so asking for the
    // neighbour's secret under COMPANY returns zero rows rather than that tenant's metadata.
    const rows = rowsOf<Record<string, unknown>>(
      await fixture!.operatorDb.execute(sql`
        SELECT * FROM public.resolve_company_secret_bundle(
          ${COMPANY}::uuid, ${NEIGHBOUR_SECRET}::uuid, NULL::integer,
          ${TARGET_TYPE}::text, ${TARGET_ID}::text, ${CONFIG_PATH}::text)`),
    );
    expect(rows).toHaveLength(0);
  });

  it("resolve_company_secret_bundle reports binding_found=false for an unbound consumer path", async () => {
    const bundle = rowsOf<Record<string, unknown>>(
      await fixture!.operatorDb.execute(sql`
        SELECT * FROM public.resolve_company_secret_bundle(
          ${COMPANY}::uuid, ${SECRET}::uuid, NULL::integer,
          ${TARGET_TYPE}::text, ${TARGET_ID}::text, ${"provider_connection.does-not-exist"}::text)`),
    )[0]!;
    expect(bundle.secret_found).toBe(true);
    expect(bundle.binding_found).toBe(false);
  });

  // ── Function C — the audit write + last_resolved_at touch ───────────────────────────────────
  it("record_company_secret_access inserts an audit row and touches last_resolved_at on success", async () => {
    await fixture!.operatorDb.execute(sql`SELECT public.record_company_secret_access(
      ${COMPANY}::uuid, ${SECRET}::uuid, ${1}::integer, ${"local_encrypted"}::text,
      ${"system"}::text, ${null}::text, ${"agent"}::text, ${TARGET_ID}::text,
      ${null}::uuid, ${null}::uuid, ${null}::uuid, ${CONFIG_PATH}::text, ${"success"}::text, ${null}::text)`);

    // Read back as ADMIN — aoa_operator cannot SELECT the table (asserted above).
    const events = (await fixture!.admin`
      SELECT outcome, provider, version, config_path FROM secret_access_events
      WHERE secret_id = ${SECRET} ORDER BY created_at DESC`) as unknown as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.outcome).toBe("success");
    expect(events[0]!.provider).toBe("local_encrypted");
    expect(Number(events[0]!.version)).toBe(1);

    const secretRow = (await fixture!.admin`
      SELECT last_resolved_at FROM company_secrets WHERE id = ${SECRET}`) as unknown as Array<{
      last_resolved_at: Date | null;
    }>;
    expect(secretRow[0]!.last_resolved_at, "success must touch last_resolved_at").not.toBeNull();
  });

  it("record_company_secret_access records a failure WITHOUT touching last_resolved_at", async () => {
    // Baseline the touch timestamp, then record a failure and prove it did not move.
    const before = (await fixture!.admin`
      SELECT last_resolved_at FROM company_secrets WHERE id = ${SECRET}`) as unknown as Array<{
      last_resolved_at: Date | null;
    }>;
    await fixture!.operatorDb.execute(sql`SELECT public.record_company_secret_access(
      ${COMPANY}::uuid, ${SECRET}::uuid, ${null}::integer, ${"local_encrypted"}::text,
      ${"system"}::text, ${null}::text, ${"agent"}::text, ${TARGET_ID}::text,
      ${null}::uuid, ${null}::uuid, ${null}::uuid, ${CONFIG_PATH}::text, ${"failure"}::text, ${"secret_unbound"}::text)`);

    const events = (await fixture!.admin`
      SELECT outcome, error_code FROM secret_access_events
      WHERE secret_id = ${SECRET} AND outcome = 'failure'`) as unknown as Array<Record<string, unknown>>;
    expect(events.length).toBe(1);
    expect(events[0]!.error_code).toBe("secret_unbound");

    const after = (await fixture!.admin`
      SELECT last_resolved_at FROM company_secrets WHERE id = ${SECRET}`) as unknown as Array<{
      last_resolved_at: Date | null;
    }>;
    expect(after[0]!.last_resolved_at?.valueOf() ?? null).toBe(before[0]!.last_resolved_at?.valueOf() ?? null);
  });

  // ── The security assertion: aoa_app can reach NONE of the three definer functions ───────────
  const DEFINER_CALLS = [
    `public.resolve_provider_assignment_candidates('${ORG}'::uuid, '${COMPANY}'::uuid, '${PROVIDER}'::text)`,
    `public.resolve_company_secret_bundle('${COMPANY}'::uuid, '${SECRET}'::uuid, NULL::integer, ` +
      `'${TARGET_TYPE}'::text, '${TARGET_ID}'::text, '${CONFIG_PATH}'::text)`,
    `public.record_company_secret_access('${COMPANY}'::uuid, '${SECRET}'::uuid, NULL::integer, ` +
      `'local_encrypted'::text, 'system'::text, NULL::text, 'agent'::text, '${TARGET_ID}'::text, ` +
      `NULL::uuid, NULL::uuid, NULL::uuid, '${CONFIG_PATH}'::text, 'failure'::text, 'x'::text)`,
  ] as const;

  it.each(DEFINER_CALLS)("still denies aoa_app EXECUTE on %s (42501)", async (call) => {
    let raised: unknown;
    try {
      await fixture!.appDb.execute(sql.raw(`SELECT * FROM ${call}`));
    } catch (error) {
      raised = error;
    }
    expect(raised, `${call} is executable by aoa_app — a grant crept in`).toBeDefined();
    const cause = (raised as { cause?: unknown }).cause ?? raised;
    expect((cause as { code?: string }).code, call).toBe("42501");
  });
});
