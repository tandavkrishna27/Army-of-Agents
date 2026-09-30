import { afterAll, beforeAll, describe, expect, it } from "vitest";
import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import postgres, { type Sql } from "postgres";

const suite = process.platform === "win32" ? describe.skip : describe;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function splitMigration(sql: string): string[] {
  return sql.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
}

async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No test port available"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function runStatements(sql: Sql, statements: string[]): Promise<void> {
  for (const statement of statements) await sql.unsafe(statement);
}

suite("MCP OAuth migration replay", () => {
  let pg: EmbeddedPostgres;
  let sql: Sql;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-oauth-migrations-"));
    const port = await allocatePort();
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), port, password: "postgres" });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("aoa_oauth_migrations");
    sql = postgres(`postgresql://postgres:postgres@127.0.0.1:${port}/aoa_oauth_migrations`);
    await sql.unsafe('CREATE TABLE "companies" ("id" uuid PRIMARY KEY)');
    await sql.unsafe('CREATE TABLE "company_mcp_connectors" ("id" uuid PRIMARY KEY, "company_id" uuid NOT NULL)');
    await sql.unsafe('CREATE TABLE "company_secrets" ("id" uuid PRIMARY KEY)');
  }, 180_000);

  afterAll(async () => {
    await sql?.end().catch(() => {});
    await pg?.stop().catch(() => {});
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }, 30_000);

  // The three broker migrations (originally 0188/0189/0190) were collapsed into
  // one 0202 during the #316 merge. These tests prove that single migration is
  // idempotent under partial apply + full replay — the reason the R12 guards
  // (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / DO $$ ... duplicate_object) exist.
  const MIGRATION_FILE = "0202_lethal_vance_astro.sql";

  it("0202 recovers from partial state (tables + first column already applied), then replays fully twice", async () => {
    const statements = splitMigration(
      await readFile(join(migrationsDir, MIGRATION_FILE), "utf8")
    );
    // Simulate an interrupted apply: the two CREATE TABLEs + the first ADD COLUMN
    // already ran. The guards must let the full migration re-run cleanly on top.
    await runStatements(sql, statements.slice(0, 3));
    await runStatements(sql, statements);
    await runStatements(sql, statements); // fully idempotent second replay

    // Postgres truncates identifiers to 63 chars, so the connector_id / secret_id
    // FK names are STORED truncated (…_company_mcp_connectors_id_fk exceeds 63).
    // Assert the FK COUNT per table — both present after replay proves the
    // DO $$ … duplicate_object guards make re-application idempotent — rather
    // than brittle, truncated exact names.
    const flowFks = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'mcp_connector_oauth_flows'::regclass AND contype = 'f'
    `;
    expect(flowFks).toHaveLength(2);

    const leaseFks = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'mcp_connector_oauth_refresh_leases'::regclass AND contype = 'f'
    `;
    expect(leaseFks).toHaveLength(2);

    const columns = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'company_mcp_connectors'
        AND column_name IN ('catalog_entry_id', 'oauth_policy_version')
      ORDER BY column_name
    `;
    expect(columns.map((row) => row.column_name)).toEqual([
      "catalog_entry_id",
      "oauth_policy_version",
    ]);
  });

  it("0202 indexes (incl. the partial unique index) replay safely", async () => {
    const statements = splitMigration(
      await readFile(join(migrationsDir, MIGRATION_FILE), "utf8")
    );
    await runStatements(sql, statements);
    await runStatements(sql, statements);
    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN (
        'company_mcp_connectors_company_catalog_entry_uq',
        'mcp_connector_oauth_flows_status_expires_idx',
        'mcp_connector_oauth_flows_status_updated_idx'
      ) ORDER BY indexname
    `;
    expect(indexes).toHaveLength(3);
  });
});
