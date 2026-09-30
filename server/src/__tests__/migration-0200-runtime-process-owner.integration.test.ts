import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";
import { createDb } from "@armyofagents/db";
import { reconcileLegacyAdapterRuntimeIdentitiesOnStartup } from "../services/workspace-runtime.js";

const migrationPath = fileURLToPath(new URL(
  "../../../packages/db/src/migrations/0200_nostalgic_khan.sql",
  import.meta.url,
));
const migrationSql = await readFile(migrationPath, "utf8");
const identityMigrationSql = await readFile(fileURLToPath(new URL(
  "../../../packages/db/src/migrations/0201_messy_titanium_man.sql",
  import.meta.url,
)), "utf8");

describe("migration 0200 contract", () => {
  it("adds the process-owner fence and retires legacy adapter-managed identities", () => {
    expect(migrationSql).toMatch(/ADD COLUMN "process_owner_id" text/);
    expect(migrationSql).toMatch(/provider_owner_status_idx/);
    expect(migrationSql).toMatch(/UPDATE "task_outputs"[\s\S]*"provider" = 'adapter_managed'/);
    expect(migrationSql).toMatch(/DELETE FROM "workspace_runtime_services"[\s\S]*"provider" = 'adapter_managed'/);
    expect(identityMigrationSql).toMatch(/ADD COLUMN "identity_version" integer/);
  });
});

type EmbeddedPg = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

describe.skipIf(process.platform !== "linux")("migration 0200 adapter identity cutover", () => {
  let pg: EmbeddedPg | null = null;
  let dataDir = "";
  let client: {
    unsafe(sql: string): Promise<unknown[]>;
    end(): Promise<void>;
  } | null = null;
  let setupError: unknown = null;
  let connectionString = "";

  beforeAll(async () => {
    try {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-0200-runtime-owner-"));
      const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: any };
      const { default: postgres } = (await import("postgres")) as { default: any };
      const port = await allocateEmbeddedPgPort();
      pg = new EmbeddedPostgres({
        databaseDir: join(dataDir, "db"),
        user: "test",
        password: "test",
        port,
        persistent: false,
      });
      await pg.initialise();
      await pg.start();
      connectionString = `postgres://test:test@localhost:${port}/postgres`;
      client = postgres(connectionString, { max: 1 });

      await client.unsafe(`
        CREATE TABLE workspace_runtime_services (
          id uuid PRIMARY KEY,
          provider text NOT NULL,
          status text NOT NULL,
          health_status text NOT NULL DEFAULT 'unknown',
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE task_outputs (
          id uuid PRIMARY KEY,
          runtime_service_id uuid REFERENCES workspace_runtime_services(id) ON DELETE SET NULL,
          status text NOT NULL,
          health_status text NOT NULL,
          url text,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO workspace_runtime_services (id, provider, status, health_status) VALUES
          ('11111111-1111-4111-8111-111111111111', 'adapter_managed', 'running', 'healthy'),
          ('22222222-2222-4222-8222-222222222222', 'local_process', 'running', 'healthy');
        INSERT INTO task_outputs (id, runtime_service_id, status, health_status, url) VALUES
          ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'running', 'healthy', 'https://stale.example'),
          ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'running', 'healthy', 'https://local.example');
      `);

      for (const statement of migrationSql.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.unsafe(statement);
      }
      for (const statement of identityMigrationSql.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.unsafe(statement);
      }
    } catch (err) {
      setupError = err;
    }
  }, 180_000);

  afterAll(async () => {
    try { await client?.end(); } catch { /* ignore */ }
    try { await pg?.stop(); } catch { /* ignore */ }
    try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 60_000);

  it("deletes old adapter rows, stops their outputs, and preserves local rows", async () => {
    if (setupError) throw setupError;
    const runtimeRows = await client!.unsafe(
      "SELECT id::text, provider, process_owner_id FROM workspace_runtime_services ORDER BY id",
    ) as Array<{ id: string; provider: string; process_owner_id: string | null }>;
    expect(runtimeRows).toEqual([{
      id: "22222222-2222-4222-8222-222222222222",
      provider: "local_process",
      process_owner_id: null,
    }]);

    const outputs = await client!.unsafe(
      "SELECT id::text, runtime_service_id::text, status, health_status, url FROM task_outputs ORDER BY id",
    ) as Array<{
      id: string;
      runtime_service_id: string | null;
      status: string;
      health_status: string;
      url: string | null;
    }>;
    expect(outputs).toEqual([
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        runtime_service_id: null,
        status: "stopped",
        health_status: "unknown",
        url: null,
      },
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        runtime_service_id: "22222222-2222-4222-8222-222222222222",
        status: "running",
        health_status: "healthy",
        url: "https://local.example",
      },
    ]);
  });

  it("retires legacy rows recreated by an old binary after the migration already ran", async () => {
    if (setupError) throw setupError;
    await client!.unsafe(`
      INSERT INTO workspace_runtime_services (id, provider, status, health_status, identity_version) VALUES
        ('33333333-3333-4333-8333-333333333333', 'adapter_managed', 'running', 'healthy', NULL),
        ('44444444-4444-4444-8444-444444444444', 'adapter_managed', 'running', 'healthy', 1);
      INSERT INTO task_outputs (id, runtime_service_id, status, health_status, url) VALUES
        ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '33333333-3333-4333-8333-333333333333', 'running', 'healthy', 'https://legacy.example'),
        ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '44444444-4444-4444-8444-444444444444', 'running', 'healthy', 'https://current.example');
    `);

    const db = createDb(connectionString);
    try {
      await expect(reconcileLegacyAdapterRuntimeIdentitiesOnStartup(db)).resolves.toEqual({ reconciled: 1 });
    } finally {
      await db.$client.end();
    }

    const rows = await client!.unsafe(
      "SELECT id::text, identity_version FROM workspace_runtime_services WHERE provider = 'adapter_managed' ORDER BY id",
    ) as Array<{ id: string; identity_version: number | null }>;
    expect(rows).toEqual([{ id: "44444444-4444-4444-8444-444444444444", identity_version: 1 }]);
    const outputs = await client!.unsafe(
      "SELECT id::text, runtime_service_id::text, status, health_status, url FROM task_outputs WHERE id IN ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd') ORDER BY id",
    ) as Array<Record<string, unknown>>;
    expect(outputs).toEqual([
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        runtime_service_id: null,
        status: "stopped",
        health_status: "unknown",
        url: null,
      },
      {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        runtime_service_id: "44444444-4444-4444-8444-444444444444",
        status: "running",
        health_status: "healthy",
        url: "https://current.example",
      },
    ]);
  });
});
