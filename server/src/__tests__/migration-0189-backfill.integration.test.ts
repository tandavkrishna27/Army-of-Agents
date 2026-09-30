// Real-Postgres backfill proof for migration 0189 (Phase 3, Task 12 / M8).
//
// The static shape of 0189 (nullable add + backfill UPDATE + break-glass table)
// is covered cross-platform by migration-0189-contract.test.ts. This test proves
// the BEHAVIOR of the backfill against real SQL: a company_secrets row whose
// organization_id is explicitly NULL (the pre-0189 shape) is populated from its
// owning company's organization_id by the (idempotent) backfill UPDATE.
//
// Linux-only (skipIf): embedded-postgres Windows initdb encoding issue + macOS
// runner flake, consistent with the other *.integration.test.ts suites.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
}) => EmbeddedPostgresInstance;

const ORG = "00000000-0000-0000-0000-0000000000a1";
const CO = "00000000-0000-0000-0000-0000000000c1";

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-0189-backfill-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
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
    const url = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(url);
    db = createDb(url);
  } catch (e) {
    setupError = e;
    // eslint-disable-next-line no-console
    console.error("[migration-0189-backfill] embedded-postgres setup failed:", e);
  }
}, 180_000);

afterAll(async () => {
  try {
    if (pg) await pg.stop();
  } catch {
    // ignore
  }
  try {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}, 60_000);

describe.skipIf(process.platform !== "linux")("0189 backfill populates company_secrets.organization_id from companies", () => {
  it("a company_secrets row with NULL organization_id is populated by the backfill UPDATE", async () => {
    if (setupError) throw new Error(String(setupError));

    await db.execute(sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org A', 'org-a')`);
    await db.execute(
      sql`INSERT INTO companies (id, name, issue_prefix, organization_id) VALUES (${CO}, 'Co A', 'PPA', ${ORG})`,
    );
    // Pre-0189 shape: organization_id explicitly NULL (NOT pre-populated).
    await db.execute(
      sql`INSERT INTO company_secrets (id, company_id, organization_id, name) VALUES (gen_random_uuid(), ${CO}, NULL, 'sec')`,
    );

    // Sanity: the column is genuinely NULL before the backfill runs.
    const before = await db.execute<{ organization_id: string | null }>(
      sql`SELECT organization_id FROM company_secrets WHERE company_id = ${CO}`,
    );
    const beforeRow = (Array.isArray(before) ? before[0] : (before as { rows: { organization_id: string | null }[] }).rows[0]);
    expect(beforeRow.organization_id).toBeNull();

    // Re-run the migration's backfill statement (idempotent — WHERE organization_id IS NULL).
    await db.execute(
      sql`UPDATE company_secrets SET organization_id = c.organization_id FROM companies c WHERE company_secrets.company_id = c.id AND company_secrets.organization_id IS NULL`,
    );

    const after = await db.execute<{ organization_id: string | null }>(
      sql`SELECT organization_id FROM company_secrets WHERE company_id = ${CO}`,
    );
    const afterRow = (Array.isArray(after) ? after[0] : (after as { rows: { organization_id: string | null }[] }).rows[0]);
    expect(afterRow.organization_id).toBe(ORG);
  }, 90_000);
});
