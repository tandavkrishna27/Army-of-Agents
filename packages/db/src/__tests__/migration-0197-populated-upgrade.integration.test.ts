import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

let pg: EmbeddedPostgresInstance | null = null;
let client: ReturnType<typeof postgres>;
let dataDir = "";
let setupError: unknown = null;
let migrationStatements: string[] = [];

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) return reject(error);
        if (!address || typeof address === "string") {
          return reject(new Error("Failed to allocate test port"));
        }
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

async function indexExists(name: string): Promise<boolean> {
  const rows = await client<{ present: boolean }[]>`
    SELECT to_regclass(${`public.${name}`}) IS NOT NULL AS present
  `;
  return rows[0]?.present === true;
}

async function apply0197(): Promise<void> {
  await client.begin(async (tx) => {
    for (const statement of migrationStatements) await tx.unsafe(statement);
  });
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-0197-upgrade-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: new (options: Record<string, unknown>) => EmbeddedPostgresInstance;
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
    client = postgres(`postgres://test:test@localhost:${port}/postgres`, { max: 1 });
    await client.unsafe(`
      CREATE TABLE companies (
        organization_id text NOT NULL,
        issue_prefix text NOT NULL
      )
    `);
    await client.unsafe(`
      CREATE UNIQUE INDEX companies_org_issue_prefix_idx
      ON companies (organization_id, issue_prefix)
    `);
    const migrationSql = await readFile(
      new URL("../migrations/0197_clever_tana_nile.sql", import.meta.url),
      "utf8",
    );
    migrationStatements = migrationSql
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  try { if (client) await client.end({ timeout: 5 }); } catch { /* ignore */ }
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform === "win32")("migration 0197 populated upgrade", () => {
  it("rolls back on an intermediate-head collision, then succeeds after explicit remediation", async () => {
    if (setupError) throw new Error(String(setupError));
    await client.unsafe(`
      INSERT INTO companies (organization_id, issue_prefix)
      VALUES ('org-a', 'DUP'), ('org-b', 'DUP')
    `);

    await expect(apply0197()).rejects.toThrow();
    expect(await indexExists("companies_org_issue_prefix_idx")).toBe(true);
    expect(await indexExists("companies_issue_prefix_idx")).toBe(false);

    await client.unsafe(`DELETE FROM companies WHERE organization_id = 'org-b'`);
    await expect(apply0197()).resolves.toBeUndefined();
    expect(await indexExists("companies_org_issue_prefix_idx")).toBe(false);
    expect(await indexExists("companies_issue_prefix_idx")).toBe(true);
  });
});
