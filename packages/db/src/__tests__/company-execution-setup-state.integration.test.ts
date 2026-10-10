import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import postgres from "postgres";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

let pg: EmbeddedPostgresInstance | null = null;
let client: ReturnType<typeof postgres>;
let dataDir = "";

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) return reject(error);
        if (!address || typeof address === "string") return reject(new Error("No test port"));
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

async function applyGeneratedMigration(fileName: string): Promise<void> {
  const sql = await readFile(new URL(`../migrations/${fileName}`, import.meta.url), "utf8");
  await client.begin(async (tx) => {
    for (const statement of sql.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) {
      await tx.unsafe(statement);
    }
  });
}

describe.skipIf(process.platform !== "linux")("company setup state populated upgrade (real PostgreSQL)", () => {
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-company-setup-upgrade-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;
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
  }, 180_000);

  afterAll(async () => {
    try { if (client) await client.end({ timeout: 5 }); } catch { /* ignore */ }
    try { if (pg) await pg.stop(); } catch { /* ignore */ }
    try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 60_000);

  it("backfills old companies to ready and defaults later raw inserts to pending", async () => {
    await client.unsafe('CREATE TABLE "companies" ("id" text PRIMARY KEY)');
    await client.unsafe("INSERT INTO companies (id) VALUES ('old-1'), ('old-2')");

    await applyGeneratedMigration("0208_next_beast.sql");
    const old = await client<{ agent_execution_setup_state: string }[]>`
      SELECT agent_execution_setup_state FROM companies ORDER BY id
    `;
    expect(old.map((row) => row.agent_execution_setup_state)).toEqual(["ready", "ready"]);

    await applyGeneratedMigration("0209_wet_luckman.sql");
    await client.unsafe("INSERT INTO companies (id) VALUES ('new-1')");
    const rows = await client<{ id: string; agent_execution_setup_state: string }[]>`
      SELECT id, agent_execution_setup_state FROM companies ORDER BY id
    `;
    expect(rows).toMatchObject([
      { id: "new-1", agent_execution_setup_state: "pending" },
      { id: "old-1", agent_execution_setup_state: "ready" },
      { id: "old-2", agent_execution_setup_state: "ready" },
    ]);
    await applyGeneratedMigration("0208_next_beast.sql");
    const afterReplay = await client<{ id: string; agent_execution_setup_state: string }[]>`
      SELECT id, agent_execution_setup_state FROM companies ORDER BY id
    `;
    expect(afterReplay).toMatchObject(rows);
    await expect(client.unsafe(
      "INSERT INTO companies (id, agent_execution_setup_state) VALUES ('invalid', 'unexpected')",
    )).rejects.toThrow();
  });
});
