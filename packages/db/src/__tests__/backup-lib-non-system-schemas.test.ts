import { afterAll, beforeAll, describe, expect, it } from "vitest";
import EmbeddedPostgres from "embedded-postgres";
import postgres from "postgres";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import { runDatabaseBackup, runDatabaseRestore } from "../backup-lib.js";

const describeBackupLib = process.platform === "win32" ? describe.skip : describe;

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        if (!address || typeof address === "string") {
          reject(new Error("Failed to allocate test port"));
          return;
        }
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

// embedded-postgres starts under a different Windows user in this environment;
// its taskkill-based shutdown path can hang or fail with access denied.
describeBackupLib("backup-lib non-system schemas", () => {
  let pg: EmbeddedPostgres;
  let backupDir: string;
  let connectionString: string;
  let pgStarted = false;

  beforeAll(async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-backup-test-"));
    backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-backup-files-"));
    const port = await allocatePort();
    pg = new EmbeddedPostgres({ databaseDir: dataDir, port, password: "postgres" });
    await pg.initialise();
    await pg.start();
    pgStarted = true;
    await pg.createDatabase("aoa_test");
    connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/aoa_test`;
    const sql = postgres(connectionString);
    await sql`CREATE SCHEMA drizzle`;
    await sql`CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text, created_at bigint)`;
    await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('test_hash', 1234567890)`;
    await sql`CREATE TABLE public.test_users (id serial PRIMARY KEY, name text)`;
    await sql`INSERT INTO public.test_users (name) VALUES ('alice wonderland')`;
    await sql.end();
  });

  afterAll(async () => {
    if (!pgStarted) return;
    await pg.stop();
  }, 30_000);

  it("backs up and restores the drizzle migration journal", async () => {
    await runDatabaseBackup({
      connectionString,
      backupDir,
      retention: { mode: "count", count: 1 },
      filenamePrefix: "aoa-test",
      backupEngine: "javascript",
    });
    const files = await fs.readdir(backupDir);
    const backupFile = files.find((f) => f.startsWith("aoa-test"));
    expect(backupFile).toBeDefined();
    const sql = postgres(connectionString);
    await sql`DROP TABLE drizzle.__drizzle_migrations`;
    await sql`DROP TABLE public.test_users`;
    await sql.end();
    await runDatabaseRestore({
      connectionString,
      backupFile: path.join(backupDir, backupFile!),
    });
    const sql2 = postgres(connectionString);
    const migrations = await sql2`SELECT hash FROM drizzle.__drizzle_migrations`;
    const users = await sql2`SELECT name FROM public.test_users`;
    expect(migrations[0].hash).toBe("test_hash");
    expect(users[0].name).toBe("alice wonderland");
    await sql2.end();
  });

  it("restores legacy public-only backups without migration history", async () => {
    // Simulate a legacy AoA JS-format backup that only covered public schema
    // (no drizzle.__drizzle_migrations). The restore must succeed even
    // though the drizzle schema is absent from the backup.
    const BREAKPOINT = "-- aoa statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900";
    const legacySql = [
      "BEGIN;",
      BREAKPOINT,
      "SET LOCAL session_replication_role = replica;",
      BREAKPOINT,
      "CREATE TABLE \"public\".\"legacy_table\" (\"id\" serial PRIMARY KEY, \"value\" text);",
      BREAKPOINT,
      "INSERT INTO \"public\".\"legacy_table\" (\"id\", \"value\") VALUES (1, $aoa$legacy$aoa$);",
      BREAKPOINT,
      "COMMIT;",
      BREAKPOINT,
    ].join("\n");
    const legacyFile = path.join(backupDir, "legacy.sql");
    await fs.writeFile(legacyFile, legacySql);
    await runDatabaseRestore({ connectionString, backupFile: legacyFile });
    const sql = postgres(connectionString);
    const rows = await sql`SELECT value FROM public.legacy_table`;
    expect(rows[0].value).toBe("legacy");
    await sql.end();
  });
});
