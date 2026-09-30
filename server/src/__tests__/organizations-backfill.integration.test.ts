import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { DEFAULT_ORGANIZATION_ID } from "@armyofagents/shared";
import { companyService } from "../services/companies.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type PG = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
let pg: PG | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-org-backfill-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: any };
    const port = await allocateEmbeddedPgPort();
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port, persistent: false });
    await pg.initialise();
    await pg.start();
    const conn = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(conn);
    db = createDb(conn);
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[organizations-backfill] setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform !== "linux")("0188 backfill — real DB", () => {
  it("creates exactly one sentinel default organization", async () => {
    if (setupError) throw new Error(String(setupError));
    const rows = await db.execute(sql`SELECT id, slug FROM organizations WHERE id = ${DEFAULT_ORGANIZATION_ID}`);
    const arr = Array.isArray(rows) ? rows : (rows as any).rows;
    expect(arr.length).toBe(1);
    expect(arr[0].slug).toBe("default");
  });

  it("attaches every created company to the default org and enforces NOT NULL", async () => {
    const company = await companyService(db).create({ name: "Backfill Co" });
    const rows = await db.execute(sql`SELECT organization_id FROM companies WHERE id = ${company.id}`);
    const arr = Array.isArray(rows) ? rows : (rows as any).rows;
    expect(arr[0].organization_id).toBe(DEFAULT_ORGANIZATION_ID);

    // The DB-level DEFAULT (sentinel org, migration 0188) makes an OMITTED
    // organization_id succeed, so to genuinely exercise the NOT NULL constraint
    // we must insert an EXPLICIT NULL — that bypasses the default and raises a
    // 23502 not-null violation. (Drizzle wraps the driver error, so we assert on
    // the pg error CODE reachable through the cause chain, not the message.)
    const err = await db
      .execute(
        sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('NoOrg', 'NUL', NULL)`,
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).not.toBeNull();
    let pgCode: string | undefined;
    for (let cur: any = err; cur; cur = cur.cause) {
      if (cur.code) {
        pgCode = cur.code;
        break;
      }
    }
    expect(pgCode).toBe("23502"); // not-null violation on organization_id
  });
});
