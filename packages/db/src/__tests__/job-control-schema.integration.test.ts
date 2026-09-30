import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import postgres, { type Sql } from "postgres";
import { applyPendingMigrations } from "../client.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

let embedded: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Sql | null = null;
let setupError: unknown = null;

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else if (!address || typeof address === "string") reject(new Error("port allocation failed"));
        else resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

function database(): Sql {
  if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
  if (!db) throw new Error("database was not initialized");
  return db;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-job-control-schema-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    const port = await allocatePort();
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
    const url = `postgres://test:test@127.0.0.1:${port}/postgres`;
    await applyPendingMigrations(url);
    db = postgres(url, { max: 1 });
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  try { await db?.end(); } catch { /* ignore */ }
  try { await embedded?.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "JOB-001 immutable submission schema",
  () => {
    it("stores the server-owned immutable job facts and an attempt-aware outbox", async () => {
      const client = database();
      const columns = await client<{ table_name: string; column_name: string; is_nullable: string }[]>`
        SELECT table_name, column_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('jobs', 'job_attempts', 'job_outbox')
      `;
      const names = new Set(columns.map((row) => `${row.table_name}.${row.column_name}`));
      for (const name of [
        "jobs.authenticated_principal_kind",
        "jobs.authenticated_principal_id",
        "jobs.authenticated_source_kind",
        "jobs.authenticated_source_identity",
        "jobs.idempotency_key",
        "jobs.command_digest",
        "jobs.input_hash",
        "jobs.policy_snapshot",
        "jobs.policy_hash",
        "jobs.requirements",
        "jobs.placement_request",
        "jobs.priority",
        "jobs.available_at",
        "job_attempts.company_id",
        "job_outbox.attempt_id",
        "job_outbox.kind",
        "job_outbox.payload",
      ]) expect(names, name).toContain(name);
      expect(columns.filter((row) => row.table_name === "job_outbox")).not.toHaveLength(0);
      expect(columns.filter((row) => row.table_name === "job_outbox").every((row) => row.is_nullable === "NO" || ["claim_token", "claimed_at", "last_error_code"].includes(row.column_name))).toBe(true);
    });

    it("pins the exact principal-scoped idempotency key and attempt-ready uniqueness", async () => {
      const client = database();
      const constraints = await client<{ table_name: string; definition: string }[]>`
        SELECT rel.relname AS table_name, pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname IN ('jobs', 'job_attempts', 'job_outbox')
      `;
      expect(constraints).toContainEqual(expect.objectContaining({
        table_name: "jobs",
        definition: "UNIQUE (organization_id, company_id, authenticated_principal_kind, authenticated_principal_id, authenticated_source_kind, authenticated_source_identity, idempotency_key)",
      }));
      expect(constraints).toContainEqual(expect.objectContaining({
        table_name: "job_outbox",
        definition: "UNIQUE (organization_id, attempt_id, kind)",
      }));
    });

    it("uses only composite tenant parent FKs so cross-tenant IDs are not existence oracles", async () => {
      const client = database();
      const fks = await client<{ table_name: string; definition: string }[]>`
        SELECT rel.relname AS table_name, pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE con.contype = 'f' AND rel.relname IN ('jobs', 'job_attempts', 'job_outbox')
      `;
      expect(fks.filter((row) => row.table_name === "job_attempts").map((row) => row.definition)).toContain(
        "FOREIGN KEY (organization_id, company_id, job_id) REFERENCES jobs(organization_id, company_id, id) ON DELETE CASCADE",
      );
      expect(fks.filter((row) => row.table_name === "job_outbox").map((row) => row.definition)).toContain(
        "FOREIGN KEY (organization_id, company_id, job_id, attempt_id) REFERENCES job_attempts(organization_id, company_id, job_id, id) ON DELETE CASCADE",
      );
      expect(fks.some((row) => /FOREIGN KEY \((company_id|job_id|attempt_id)\)/.test(row.definition))).toBe(false);
    });

    it("reports the same composite FK denial for foreign and absent parent IDs", async () => {
      const client = database();
      const orgA = "10000000-0000-4000-8000-000000000011";
      const orgB = "10000000-0000-4000-8000-000000000012";
      const companyA = "20000000-0000-4000-8000-000000000011";
      const companyB = "20000000-0000-4000-8000-000000000012";
      const jobA = "30000000-0000-4000-8000-000000000011";
      const jobB = "30000000-0000-4000-8000-000000000012";
      const absentJob = "30000000-0000-4000-8000-000000000099";
      await client`INSERT INTO organizations (id, name, slug) VALUES
        (${orgA}, 'H01 A', 'job-h01-a'), (${orgB}, 'H01 B', 'job-h01-b')`;
      await client`INSERT INTO companies (id, name, issue_prefix, organization_id) VALUES
        (${companyA}, 'H01 A', 'H1A', ${orgA}), (${companyB}, 'H01 B', 'H1B', ${orgB})`;
      await client`INSERT INTO jobs (id, organization_id, company_id) VALUES
        (${jobA}, ${orgA}, ${companyA}), (${jobB}, ${orgB}, ${companyB})`;

      async function deniedConstraint(jobId: string): Promise<string | undefined> {
        try {
          await client`INSERT INTO job_attempts (organization_id, company_id, job_id)
            VALUES (${orgA}, ${companyA}, ${jobId})`;
          throw new Error("expected the composite parent FK to deny the insert");
        } catch (error) {
          return (error as { constraint_name?: string }).constraint_name;
        }
      }

      expect(await deniedConstraint(jobB)).toBe("job_attempts_org_job_fk");
      expect(await deniedConstraint(absentJob)).toBe("job_attempts_org_job_fk");
    });

    it("forces tenant RLS on the outbox with the aoa_app-scoped policy", async () => {
      const client = database();
      const [row] = await client<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'job_outbox'
      `;
      expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const policies = await client<{ policyname: string; roles: string[] }[]>`
        SELECT policyname, roles FROM pg_policies WHERE tablename = 'job_outbox'
      `;
      expect(policies).toContainEqual({ policyname: "job_outbox_tenant_isolation", roles: ["aoa_app"] });
    });
  },
);

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "JOB-006 control command + retry schema",
  () => {
    it("stores the durable control-command channel columns and the additive retry columns", async () => {
      const client = database();
      const columns = await client<{ table_name: string; column_name: string; is_nullable: string }[]>`
        SELECT table_name, column_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('job_control_commands', 'jobs', 'job_attempts')
      `;
      const names = new Set(columns.map((row) => `${row.table_name}.${row.column_name}`));
      for (const name of [
        "job_control_commands.command_id",
        "job_control_commands.command_seq",
        "job_control_commands.command_kind",
        "job_control_commands.fence_token",
        "job_control_commands.command",
        "job_control_commands.ack_status",
        "job_control_commands.acked_at",
        "jobs.max_attempts",
        "jobs.dead_letter_reason",
        "job_attempts.backoff_until",
      ]) expect(names, name).toContain(name);
      // ack columns + dead_letter_reason + backoff are nullable; command identity is NOT NULL.
      const cmd = columns.filter((row) => row.table_name === "job_control_commands");
      const nullableCmd = new Set(
        cmd.filter((row) => row.is_nullable === "YES").map((row) => row.column_name),
      );
      expect(nullableCmd).toContain("ack_status");
      expect(nullableCmd).not.toContain("command_seq");
      expect(nullableCmd).not.toContain("command_id");
    });

    it("pins the per-lease command uniqueness (command id and monotonic sequence)", async () => {
      const client = database();
      const constraints = await client<{ definition: string }[]>`
        SELECT pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname = 'job_control_commands' AND con.contype = 'u'
      `;
      const defs = constraints.map((row) => row.definition);
      expect(defs).toContain("UNIQUE (organization_id, lease_id, command_id)");
      expect(defs).toContain("UNIQUE (organization_id, lease_id, command_seq)");
    });

    it("uses only composite tenant parent FKs (no single-column existence oracle)", async () => {
      const client = database();
      const fks = await client<{ definition: string }[]>`
        SELECT pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE con.contype = 'f' AND rel.relname = 'job_control_commands'
      `;
      const defs = fks.map((row) => row.definition);
      expect(defs).toContain(
        "FOREIGN KEY (organization_id, company_id, job_id, attempt_id) REFERENCES job_attempts(organization_id, company_id, job_id, id) ON DELETE CASCADE",
      );
      expect(defs).toContain(
        "FOREIGN KEY (organization_id, company_id, job_id, attempt_id, lease_id) REFERENCES leases(organization_id, company_id, job_id, attempt_id, id) ON DELETE CASCADE",
      );
      expect(defs.some((def) => /FOREIGN KEY \((company_id|job_id|attempt_id|lease_id)\)/.test(def))).toBe(false);
    });

    it("forces tenant RLS on the control-command table with the aoa_app-scoped policy", async () => {
      const client = database();
      const [row] = await client<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'job_control_commands'
      `;
      expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const policies = await client<{ policyname: string; roles: string[] }[]>`
        SELECT policyname, roles FROM pg_policies WHERE tablename = 'job_control_commands'
      `;
      expect(policies).toContainEqual({
        policyname: "job_control_commands_tenant_isolation",
        roles: ["aoa_app"],
      });
    });
  },
);
