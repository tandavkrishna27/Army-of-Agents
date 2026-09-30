import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (options: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let sql: ReturnType<typeof postgres>;
let markerUpsertSql = "";

function extractMarkerUpsert(source: string): string {
  const statement = source.match(
    /```sql\s*(INSERT INTO instance_settings[\s\S]*?updated_at = now\(\);)[\s\S]*?```/,
  )?.[1];
  if (!statement) throw new Error("Could not extract snapshot marker upsert from runbook");
  return statement;
}

function normalizeSql(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) return reject(error);
        if (!address || typeof address === "string") {
          return reject(new Error("Failed to allocate an embedded PostgreSQL port"));
        }
        resolvePort(address.port);
      });
    });
    server.on("error", reject);
  });
}

async function resetSettings(): Promise<void> {
  await sql`TRUNCATE TABLE instance_settings`;
}

async function canonicalRows() {
  return await sql<Array<{ singleton_key: string; general: Record<string, unknown> }>>`
    SELECT singleton_key, general
    FROM instance_settings
    WHERE singleton_key = 'default'
  `;
}

describe.skipIf(process.platform === "win32")(
  "migration snapshot runbook SQL",
  () => {
    beforeAll(async () => {
      const databaseDoc = await readFile(
        resolve(repoRoot, "docs/deploy/database.md"),
        "utf8",
      );
      const upgradeDoc = await readFile(
        resolve(repoRoot, "docs/deploy/upgrade-guide.md"),
        "utf8",
      );
      markerUpsertSql = extractMarkerUpsert(databaseDoc);
      expect(normalizeSql(extractMarkerUpsert(upgradeDoc))).toBe(
        normalizeSql(markerUpsertSql),
      );

      dataDir = await mkdtemp(join(tmpdir(), "aoa-snapshot-runbook-"));
      const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
        default: EmbeddedPostgresCtor;
      };
      const port = await allocatePort();
      pg = new EmbeddedPostgres({
        databaseDir: join(dataDir, "db"),
        user: "test",
        password: "test",
        port,
        persistent: false,
        initdbFlags: ["--encoding=UTF8", "--locale=C"],
      });
      await pg.initialise();
      await pg.start();
      sql = postgres(`postgres://test:test@localhost:${port}/postgres`, { max: 2 });
      await sql.unsafe(`
        CREATE TABLE instance_settings (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          singleton_key text DEFAULT 'default' NOT NULL,
          general jsonb DEFAULT '{}'::jsonb NOT NULL,
          experimental jsonb DEFAULT '{}'::jsonb NOT NULL,
          created_at timestamp with time zone DEFAULT now() NOT NULL,
          updated_at timestamp with time zone DEFAULT now() NOT NULL
        );
        CREATE UNIQUE INDEX instance_settings_singleton_key_idx
          ON instance_settings (singleton_key);
      `);
    }, 120_000);

    afterAll(async () => {
      try {
        if (sql) await sql.end();
      } catch {
        // Continue cleanup so a connection-close failure cannot leak the server.
      }
      try {
        if (pg) await pg.stop();
      } catch {
        // Continue cleanup so a server-stop failure cannot leak the data dir.
      }
      if (dataDir) {
        await rm(dataDir, { recursive: true, force: true });
      }
    }, 120_000);

    it("creates an absent canonical row with the marker", async () => {
      await resetSettings();
      await sql.unsafe(markerUpsertSql);

      const rows = await canonicalRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.general.migrationSnapshots).toEqual(["0188"]);
    });

    it("preserves settings and prior markers without duplicating 0188", async () => {
      await resetSettings();
      await sql.unsafe(`
        INSERT INTO instance_settings (singleton_key, general)
        VALUES (
          'default',
          '{"censorUsernameInLogs":true,"migrationSnapshots":["0170"]}'::jsonb
        )
      `);

      await sql.unsafe(markerUpsertSql);
      await sql.unsafe(markerUpsertSql);

      const rows = await canonicalRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.general).toMatchObject({
        censorUsernameInLogs: true,
        migrationSnapshots: ["0170", "0188"],
      });
    });

    it("repairs malformed marker metadata and serializes concurrent upserts", async () => {
      await resetSettings();
      await sql.unsafe(`
        INSERT INTO instance_settings (singleton_key, general)
        VALUES (
          'default',
          '{"migrationSnapshots":["0170",null,42,"0188"]}'::jsonb
        )
      `);
      await sql.unsafe(markerUpsertSql);
      expect((await canonicalRows())[0]?.general.migrationSnapshots).toEqual([
        "0170",
        "0188",
      ]);

      await resetSettings();
      await Promise.all([
        sql.unsafe(markerUpsertSql),
        sql.unsafe(markerUpsertSql),
      ]);
      const rows = await canonicalRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.general.migrationSnapshots).toEqual(["0188"]);
    });
  },
);
