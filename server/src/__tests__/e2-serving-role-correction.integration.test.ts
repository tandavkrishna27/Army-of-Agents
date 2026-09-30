import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import postgres, { type Sql } from "postgres";
import { sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createTenantAppDbConnection,
  type Db,
  type NonOwnerDbConnection,
} from "@armyofagents/db";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";
import { runInTenant } from "../db/tenant-context.js";
import { agentRuntimeDecisionService } from "../services/agent-runtime-decisions.js";
import { resolveExecutionTargetForRun } from "../services/execution-target-resolver.js";
import { issueService } from "../services/issues.js";
import {
  provisionTenantAppRoleLoginSql,
  TENANT_APP_ROLE,
} from "../db/rls-tenant.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const APP_PASSWORD = "app-role-test-password";
const OPERATOR_PASSWORD = "operator-role-test-password";
const ORG_A = "10000000-0000-4000-8000-000000000001";
const ORG_B = "10000000-0000-4000-8000-000000000002";
const COMPANY_A = "20000000-0000-4000-8000-000000000001";
const COMPANY_B = "20000000-0000-4000-8000-000000000002";
const FOUNDER_A = "role-correction-founder-a";
const AGENT_A = "30000000-0000-4000-8000-000000000001";
const RUN_A = "40000000-0000-4000-8000-000000000001";
const ISSUE_A = "50000000-0000-4000-8000-000000000001";
const TARGET_PLATFORM = "60000000-0000-4000-8000-000000000001";
const TARGET_A = "60000000-0000-4000-8000-000000000002";
const TARGET_B = "60000000-0000-4000-8000-000000000003";
const STALE_HUB_A = "60000000-0000-4000-8000-000000000001";

let embedded: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let adminUrl = "";
let appUrl = "";
let operatorUrl = "";
let admin: Sql | null = null;
let appDb: Db;
let appConnection: NonOwnerDbConnection | null = null;
let appSql: Sql | null = null;
let operator: Sql | null = null;
let setupError: unknown = null;
let correctionMigrationReapplyRounds = 0;
let correctionStatements: string[] = [];

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function guard(): void {
  if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
}

async function reapplyCorrectionMigration(): Promise<void> {
  await admin!.begin(async (transaction) => {
    for (const statement of correctionStatements) await transaction.unsafe(statement);
  });
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-e2-role-correction-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    const port = await allocateEmbeddedPgPort();
    embedded = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await embedded.initialise();
    await embedded.start();
    adminUrl = `postgres://test:test@127.0.0.1:${port}/postgres`;
    await applyPendingMigrations(adminUrl);
    admin = postgres(adminUrl, { max: 1 });
    const correctionMigrations = await Promise.all(
      [
        "0214_e2_serving_role_hardening.sql",
        "0215_e2_serving_role_audit_completion.sql",
      ].map((migration) =>
        readFile(
          fileURLToPath(new URL(`../../../packages/db/src/migrations/${migration}`, import.meta.url)),
          "utf8",
        ),
      ),
    );
    correctionStatements = correctionMigrations
      .join(`\n--> statement-breakpoint\n`)
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (let round = 0; round < 2; round += 1) {
      await reapplyCorrectionMigration();
      correctionMigrationReapplyRounds += 1;
    }

    await admin.unsafe(provisionTenantAppRoleLoginSql(TENANT_APP_ROLE, APP_PASSWORD));
    const operatorRole = await admin<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aoa_operator') AS exists
    `;
    if (!operatorRole[0]?.exists) {
      // RED setup only: let the pre-correction migration reach the policy/grant assertions
      // instead of failing merely because the future role does not exist yet.
      await admin.unsafe(
        `CREATE ROLE "aoa_operator" LOGIN PASSWORD '${OPERATOR_PASSWORD}' ` +
          "NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
    } else {
      await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_operator", OPERATOR_PASSWORD));
    }

    appUrl = adminUrl.replace("test:test", `aoa_app:${APP_PASSWORD}`);
    operatorUrl = adminUrl.replace("test:test", `aoa_operator:${OPERATOR_PASSWORD}`);
    appConnection = createTenantAppDbConnection(appUrl, { max: 1 });
    appDb = appConnection.db;
    appSql = postgres(appUrl, { max: 1 });
    operator = postgres(operatorUrl, { max: 1 });

    await admin`
      INSERT INTO organizations (id, name, slug)
      VALUES (${ORG_A}, 'Org A', 'role-correction-a'), (${ORG_B}, 'Org B', 'role-correction-b')
    `;
    await admin`
      INSERT INTO companies (id, name, issue_prefix, organization_id)
      VALUES
        (${COMPANY_A}, 'Company A', 'RCA', ${ORG_A}),
        (${COMPANY_B}, 'Company B', 'RCB', ${ORG_B})
    `;
    await admin`
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES (${FOUNDER_A}, 'Founder A', 'founder-a@example.test', true, now(), now())
    `;
    await admin`
      INSERT INTO company_memberships
        (company_id, principal_type, principal_id, status, membership_role)
      VALUES (${COMPANY_A}, 'user', ${FOUNDER_A}, 'active', 'owner')
    `;
    await admin`
      INSERT INTO user_roles (company_id, user_id, role)
      VALUES (${COMPANY_A}, ${FOUNDER_A}, 'founder')
    `;
    await admin`
      INSERT INTO notification_preferences
        (user_id, company_id, rules, quiet_hours, digest)
      VALUES (
        ${FOUNDER_A},
        ${COMPANY_A},
        ${admin.json([{ semanticType: "agent_runtime_decision", deliveryMode: "digest", toastEnabled: true }])},
        ${admin.json({ enabled: false, start: "18:00", end: "09:00", timezone: "UTC" })},
        ${admin.json({ enabled: true, cadence: "daily" })}
      )
    `;
    await admin`
      INSERT INTO agents (id, company_id, name, kind, status)
      VALUES (${AGENT_A}, ${COMPANY_A}, 'Role correction agent', 'org', 'idle')
    `;
    await admin`
      INSERT INTO heartbeat_runs (id, company_id, agent_id, status, started_at)
      VALUES (${RUN_A}, ${COMPANY_A}, ${AGENT_A}, 'running', now())
    `;
    await admin`
      INSERT INTO issues (id, company_id, title, status, updated_at)
      VALUES (${ISSUE_A}, ${COMPANY_A}, 'Stale checkout parity', 'todo', now() - interval '2 hours')
    `;
    await admin`
      INSERT INTO notifications
        (id, company_id, user_id, type, title, semantic_type, status, priority,
         source_type, source_id, source_unique_key, owner_user_id)
      VALUES (
        ${STALE_HUB_A}, ${COMPANY_A}, ${FOUNDER_A}, 'stale_work', 'Stale task',
        'stale_work', 'open', 'normal', 'issue', ${ISSUE_A},
        ${`${COMPANY_A}:issue:${ISSUE_A}:stale_work:`}, ${FOUNDER_A}
      )
    `;
    await admin`
      INSERT INTO execution_targets
        (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope, target_authority_key)
      VALUES
        (${TARGET_PLATFORM}, NULL, 'platform-existing', 'pooled_gvisor', 'shared_multitenant', 'active', '{}', '{}', 'platform', 'platform'),
        (${TARGET_A}, ${ORG_A}, 'tenant-a-target', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}', 'organization', ${`organization:${ORG_A}`}),
        (${TARGET_B}, ${ORG_B}, 'tenant-b-target', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}', 'organization', ${`organization:${ORG_B}`})
      ON CONFLICT DO NOTHING
    `;
    await admin`
      INSERT INTO workers
        (scope, organization_id, label, status, execution_target_id, target_authority_key,
         device_public_key, device_thumbprint, profile_hash, enrolled_at)
      VALUES
        ('platform', NULL, 'platform-existing', 'enrolled', ${TARGET_PLATFORM}, 'platform', 'fixture-key', ${"1".repeat(64)}, ${"2".repeat(64)}, now()),
        ('organization', ${ORG_A}, 'tenant-a-worker', 'enrolled', ${TARGET_A}, ${`organization:${ORG_A}`}, 'fixture-key', ${"3".repeat(64)}, ${"4".repeat(64)}, now()),
        ('organization', ${ORG_B}, 'tenant-b-worker', 'enrolled', ${TARGET_B}, ${`organization:${ORG_B}`}, 'fixture-key', ${"5".repeat(64)}, ${"6".repeat(64)}, now())
    `;
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  try { await appConnection?.close({ timeoutSeconds: 5 }); } catch { /* ignore */ }
  try { await appSql?.end(); } catch { /* ignore */ }
  try { await operator?.end(); } catch { /* ignore */ }
  try { await admin?.end(); } catch { /* ignore */ }
  try { await embedded?.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "P1 corrective E2 bounded serving/operator roles",
  () => {
    it("runs the real JOB-010 checkout service through stale hub reconciliation as aoa_app", async () => {
      guard();
      const checkedOut = await issueService(appDb).checkout(ISSUE_A, AGENT_A, ["todo"], null);
      expect(checkedOut).toMatchObject({ id: ISSUE_A, status: "in_progress", assigneeAgentId: AGENT_A });
      const [staleHub] = await admin!<{ status: string }[]>`
        SELECT status FROM notifications WHERE id = ${STALE_HUB_A}
      `;
      expect(staleHub?.status).toBe("archived");
    });

    it("creates a real JOB-011 runtime prompt and digest projection as aoa_app", async () => {
      guard();
      const result = await agentRuntimeDecisionService(appDb).createPrompt({
        companyId: COMPANY_A,
        agentId: AGENT_A,
        runId: RUN_A,
        adapterType: "claude_local",
        kind: "permission",
        nonce: "role-correction-runtime-prompt",
        title: "Allow checkout follow-up?",
        summary: "Exercise the real runtime-decision aggregate",
        promptText: "pnpm test:run",
        toolName: "shell",
        command: "pnpm test:run",
        timeoutPolicy: "deny",
      });
      expect(result.decision.status).toBe("created");
      expect(result.hubItem).toMatchObject({ semanticType: "agent_runtime_decision", ownerUserId: FOUNDER_A });
      const [digest] = await admin!<{ user_id: string; hub_item_id: string }[]>`
        SELECT user_id, hub_item_id
        FROM notification_digest_items
        WHERE company_id = ${COMPANY_A} AND hub_item_id = ${result.hubItem.id}
      `;
      expect(digest).toEqual({ user_id: FOUNDER_A, hub_item_id: result.hubItem.id });
    });

    it("still denies aoa_app an unapproved legacy secret table", async () => {
      guard();

      const [denied] = rowsOf<{ allowed: boolean }>(
        await appDb.execute(
          sql`SELECT has_table_privilege(current_user, 'public.company_secrets', 'SELECT') AS allowed`,
        ),
      );
      expect(denied?.allowed).toBe(false);
      await expect(appDb.execute(sql`SELECT id FROM company_secrets LIMIT 1`)).rejects.toSatisfy(
        (error: unknown) => errorCode(error) === "42501",
      );
    });

    it("runs the heartbeat pinned-target resolver query as aoa_app with only its required columns", async () => {
      guard();
      const [platformTarget] = await admin!<{ id: string }[]>`
        SELECT id FROM execution_targets WHERE slug = 'platform-existing'
      `;
      const resolved = await resolveExecutionTargetForRun(appDb, {
        organizationId: ORG_A,
        companyId: COMPANY_A,
        credentialKind: "company_api_key",
        pinnedTargetId: platformTarget!.id,
        executionTargetSlug: null,
      });
      expect(resolved).toMatchObject({
        id: platformTarget!.id,
        slug: "platform-existing",
        kind: "pooled_gvisor",
        status: "active",
        organizationId: null,
        config: {},
      });

      for (const column of [
        "id",
        "slug",
        "kind",
        "trust_class",
        "status",
        "organization_id",
        "config",
      ]) {
        const [row] = await appSql!<{ allowed: boolean }[]>`
          SELECT has_column_privilege(current_user, 'public.execution_targets', ${column}, 'SELECT') AS allowed
        `;
        expect(row?.allowed, `heartbeat resolver requires execution_targets.${column}`).toBe(true);
      }
      for (const column of ["worker_token_hash", "owner_user_id", "capabilities", "last_seen_at"]) {
        const [row] = await appSql!<{ allowed: boolean }[]>`
          SELECT has_column_privilege(current_user, 'public.execution_targets', ${column}, 'SELECT') AS allowed
        `;
        expect(row?.allowed, `heartbeat resolver does not require execution_targets.${column}`).toBe(false);
      }
    });

    it("keeps both accepted bounded identities non-privileged after SET ROLE NONE", async () => {
      guard();
      for (const [role, connection] of [
        ["aoa_app", appSql!],
        ["aoa_operator", operator!],
      ] as const) {
        await connection`SET ROLE NONE`;
        const [identity] = await connection<{
          session_user: string;
          current_user: string;
          rolsuper: boolean;
          secret_select: boolean;
        }[]>`
          SELECT
            session_user,
            current_user,
            role.rolsuper,
            has_table_privilege(current_user, 'public.company_secrets', 'SELECT') AS secret_select
          FROM pg_roles role
          WHERE role.rolname = current_user
        `;
        expect(identity).toEqual({
          session_user: role,
          current_user: role,
          rolsuper: false,
          secret_select: false,
        });
      }
    });

    it("re-applies the Decision #122/C14 correction migration twice", () => {
      guard();
      expect(correctionMigrationReapplyRounds).toBe(2);
    });

    it("reconciles stale grants/memberships and hardens both serving role attributes", async () => {
      guard();
      await admin!.unsafe(`CREATE ROLE "aoa_role_drift_parent" NOLOGIN`);
      await admin!.unsafe(`GRANT SELECT ON company_secrets TO aoa_app`);
      await admin!.unsafe(`GRANT "aoa_role_drift_parent" TO aoa_app`);
      await admin!.unsafe(`ALTER ROLE aoa_app INHERIT REPLICATION`);
      try {
        await reapplyCorrectionMigration();
        const [posture] = await admin!<{
          rolinherit: boolean;
          rolreplication: boolean;
          stale_grant: boolean;
          membership_count: number;
        }[]>`
          SELECT
            r.rolinherit,
            r.rolreplication,
            has_table_privilege('aoa_app', 'public.company_secrets', 'SELECT') AS stale_grant,
            (
              SELECT count(*)::int
              FROM pg_auth_members m
              WHERE m.member = r.oid
            ) AS membership_count
          FROM pg_roles r
          WHERE r.rolname = 'aoa_app'
        `;
        expect(posture).toEqual({
          rolinherit: false,
          rolreplication: false,
          stale_grant: false,
          membership_count: 0,
        });
      } finally {
        await admin!.unsafe(`REVOKE "aoa_role_drift_parent" FROM aoa_app`).catch(() => {});
        await admin!.unsafe(`REVOKE SELECT ON company_secrets FROM aoa_app`).catch(() => {});
        await admin!.unsafe(`ALTER ROLE aoa_app NOREPLICATION`).catch(() => {});
        await admin!.unsafe(`DROP ROLE IF EXISTS "aoa_role_drift_parent"`).catch(() => {});
      }
    });

    it("fails migration closed when a serving role owns an application object", async () => {
      guard();
      await admin!.unsafe(`CREATE TABLE role_owned_drift_probe (id integer)`);
      await admin!.unsafe(`ALTER TABLE role_owned_drift_probe OWNER TO aoa_operator`);
      try {
        await expect(reapplyCorrectionMigration()).rejects.toThrow(/own|owner/i);
      } finally {
        await admin!.unsafe(`DROP TABLE IF EXISTS role_owned_drift_probe`);
      }
    });

    it("keeps tenant RLS and composite-FK enforcement H-01 safe through runInTenant", async () => {
      guard();
      const own = await runInTenant(appDb, ORG_A, (repos) =>
        repos.jobs.insert({ organizationId: ORG_A, companyId: COMPANY_A }),
      );
      expect(own.organizationId).toBe(ORG_A);
      expect(await runInTenant(appDb, ORG_B, (repos) => repos.jobs.getById(own.id))).toBeNull();
      await expect(
        runInTenant(appDb, ORG_A, (repos) =>
          repos.jobs.insert({ organizationId: ORG_A, companyId: COMPANY_B }),
        ),
      ).rejects.toSatisfy((error: unknown) => errorCode(error) === "23503");
    });

    it("gives aoa_operator only safe read columns on null-Organization platform metadata", async () => {
      guard();
      const op = operator!;
      const roles = await admin!<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
        SELECT rolname, rolsuper, rolbypassrls
        FROM pg_roles
        WHERE rolname IN ('aoa_app', 'aoa_operator')
        ORDER BY rolname
      `;
      expect(roles).toEqual([
        { rolname: "aoa_app", rolsuper: false, rolbypassrls: false },
        { rolname: "aoa_operator", rolsuper: false, rolbypassrls: false },
      ]);

      const workers = await op<{ id: string; organization_id: string | null; label: string; status: string }[]>`
        SELECT id, organization_id, label, status FROM workers ORDER BY label
      `;
      expect(workers).toEqual([
        expect.objectContaining({ organization_id: null, label: "platform-existing", status: "enrolled" }),
      ]);
      const targets = await op<{ id: string; organization_id: string | null; slug: string; kind: string; trust_class: string; status: string }[]>`
        SELECT id, organization_id, slug, kind, trust_class, status
        FROM execution_targets
        ORDER BY slug
      `;
      expect(targets).toEqual([
        expect.objectContaining({
          organization_id: null,
          slug: "platform-existing",
          kind: "pooled_gvisor",
          trust_class: "shared_multitenant",
          status: "active",
        }),
      ]);

      for (const [table, column] of [
        ["workers", "label"],
        ["workers", "status"],
        ["execution_targets", "slug"],
        ["execution_targets", "capabilities"],
      ] as const) {
        const [row] = await op<{ allowed: boolean }[]>`
          SELECT has_column_privilege(current_user, ${`public.${table}`}, ${column}, 'SELECT') AS allowed
        `;
        expect(row?.allowed, `${table}.${column} safe metadata read`).toBe(true);
      }

      for (const [table, column] of [
        ["workers", "owner_user_id"],
        ["execution_targets", "owner_user_id"],
        ["execution_targets", "config"],
        ["execution_targets", "worker_token_hash"],
      ] as const) {
        const [row] = await op<{ allowed: boolean }[]>`
          SELECT has_column_privilege(current_user, ${`public.${table}`}, ${column}, 'SELECT') AS allowed
        `;
        expect(row?.allowed, `${table}.${column} is deferred/sensitive`).toBe(false);
      }

      await expect(op`SELECT worker_token_hash FROM execution_targets LIMIT 1`).rejects.toSatisfy(
        (error: unknown) => errorCode(error) === "42501",
      );
      await expect(op`SELECT config FROM execution_targets LIMIT 1`).rejects.toSatisfy(
        (error: unknown) => errorCode(error) === "42501",
      );
      await expect(op`UPDATE workers SET status = 'revoked' WHERE label = 'platform-existing'`).rejects.toSatisfy(
        (error: unknown) => errorCode(error) === "42501",
      );
      await expect(op`UPDATE execution_targets SET status = 'disabled' WHERE slug = 'platform-existing'`).rejects.toSatisfy(
        (error: unknown) => errorCode(error) === "42501",
      );
      await expect(op`DELETE FROM workers WHERE label = 'platform-existing'`).rejects.toSatisfy(
        (error: unknown) => errorCode(error) === "42501",
      );
      await expect(op`DELETE FROM execution_targets WHERE slug = 'platform-existing'`).rejects.toSatisfy(
        (error: unknown) => errorCode(error) === "42501",
      );
      await expect(
        op`INSERT INTO workers (scope, organization_id, label) VALUES ('platform', NULL, 'deferred-enrollment')`,
      ).rejects.toSatisfy((error: unknown) => errorCode(error) === "42501");
    });

    it.each([
      "jobs",
      "job_attempts",
      "leases",
      "services",
      "service_instances",
      "job_artifacts",
      "job_secret_handles",
      "heartbeat_run_events",
      "artifacts",
      "company_secrets",
    ])("denies aoa_operator any access to %s", async (table) => {
      guard();
      await expect(operator!.unsafe(`SELECT * FROM "${table}" LIMIT 1`)).rejects.toSatisfy(
        (error: unknown) => errorCode(error) === "42501",
      );
    });
  },
);
