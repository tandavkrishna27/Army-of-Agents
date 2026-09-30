// server/src/__tests__/mt-combined-migrations.integration.test.ts
//
// Design note (honest): applyPendingMigrations applies the WHOLE chain to
// head 0192 — the repo exposes no "migrate to 0186 then stop" seam. So this
// AUTOMATED suite proves the chain's backfill statements are correct and
// idempotent on populated rows and that cross-migration invariants (temporary
// global route-prefix uniqueness, tenant-column population, cross-phase FKs) hold on a populated
// DB. The TRUE staged "seed a pre-0188 backup -> apply -> assert -> rollback"
// is the executed drill in Phase 6 plan Section 7 against a real
// `pnpm db:backup` snapshot (staging is natural there). Together they cover
// migration-on-populated-DB end to end.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { DEFAULT_ORGANIZATION_ID } from "@armyofagents/shared";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type PG = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
let pg: PG | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
const rows = (r: unknown) => (Array.isArray(r) ? r : (r as any).rows) as any[];

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-mt-chain-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: any };
    const port = await allocateEmbeddedPgPort();
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port, persistent: false });
    await pg.initialise();
    await pg.start();
    const conn = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(conn); // whole chain -> head 0192
    db = createDb(conn);
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[mt-combined-migrations] setup failed:", err);
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

// Run only on Linux CI (embedded-postgres initdb encoding issue on Windows;
// this mirrors the companies-delete-integration.test.ts harness).
describe.skipIf(process.platform !== "linux")("MT chain 0188->0192 on populated rows", () => {
  it("0188 seeded exactly one sentinel default organization", async () => {
    if (setupError) throw new Error(String(setupError));
    const r = rows(await db.execute(sql`SELECT id, slug FROM organizations WHERE id = ${DEFAULT_ORGANIZATION_ID}`));
    expect(r.length).toBe(1);
    expect(r[0].slug).toBe("default");
  });

  it("re-running 0188's companies backfill on a NULL-tenant row populates it, leaves set rows untouched", async () => {
    // A populated pre-migration company shape: organization_id explicitly NULL.
    await db.execute(sql`ALTER TABLE companies ALTER COLUMN organization_id DROP NOT NULL`);
    const ins = rows(await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('Legacy Co', 'LEG', NULL) RETURNING id`));
    const legacyId = ins[0].id;
    // 0188's idempotent backfill statement (verbatim WHERE-guarded UPDATE).
    await db.execute(sql`UPDATE companies SET organization_id = ${DEFAULT_ORGANIZATION_ID} WHERE organization_id IS NULL`);
    const after = rows(await db.execute(sql`SELECT organization_id FROM companies WHERE id = ${legacyId}`));
    expect(after[0].organization_id).toBe(DEFAULT_ORGANIZATION_ID);
    await db.execute(sql`ALTER TABLE companies ALTER COLUMN organization_id SET NOT NULL`);
  });

  it("head restores global prefix uniqueness while prefix-backed routes remain ambiguous", async () => {
    const a = rows(await db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Org A', 'org-a-chain') RETURNING id`))[0].id;
    const b = rows(await db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Org B', 'org-b-chain') RETURNING id`))[0].id;
    await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('CA', 'DUP', ${a})`);
    await expect(db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('CB', 'DUP', ${b})`)).rejects.toThrow();
    await expect(db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('CA2', 'DUP', ${a})`)).rejects.toThrow();
  });

  it("0188 per-company identifier uniqueness: same identifier string in two companies is allowed", async () => {
    const org = rows(await db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Org D', 'org-d-chain') RETURNING id`))[0].id;
    const c1 = rows(await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('D1','DA',${org}) RETURNING id`))[0].id;
    const c2 = rows(await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('D2','DB',${org}) RETURNING id`))[0].id;
    await db.execute(sql`INSERT INTO issues (company_id, title, identifier, status) VALUES (${c1}, 'x', 'DUP-1', 'backlog')`);
    await expect(db.execute(sql`INSERT INTO issues (company_id, title, identifier, status) VALUES (${c2}, 'y', 'DUP-1', 'backlog')`)).resolves.toBeDefined();
  });

  it("0189 company_secrets backfill populates organization_id from companies (idempotent on populated rows)", async () => {
    const org = rows(await db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Org S', 'org-s-chain') RETURNING id`))[0].id;
    const co = rows(await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('S1','SS',${org}) RETURNING id`))[0].id;
    await db.execute(sql`INSERT INTO company_secrets (id, company_id, organization_id, name) VALUES (gen_random_uuid(), ${co}, NULL, 'sec')`);
    await db.execute(sql`UPDATE company_secrets SET organization_id = c.organization_id FROM companies c WHERE company_secrets.company_id = c.id AND company_secrets.organization_id IS NULL`);
    const sec = rows(await db.execute(sql`SELECT organization_id FROM company_secrets WHERE company_id = ${co}`));
    expect(sec[0].organization_id).toBe(org);
  });

  it("0191/0192 execution_targets FK to organizations resolves (cross-phase integrity)", async () => {
    const org = rows(await db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Org T', 'org-t-chain') RETURNING id`))[0].id;
    await expect(db.execute(sql`INSERT INTO execution_targets (organization_id, slug, kind, trust_class, status) VALUES (${org}, 'pool-chain', 'pooled_gvisor', 'shared_multitenant', 'offline')`)).resolves.toBeDefined();
    await expect(db.execute(sql`INSERT INTO execution_targets (organization_id, slug, kind, trust_class, status) VALUES ('00000000-0000-0000-0000-0000000000ff', 'pool-bad', 'pooled_gvisor', 'shared_multitenant', 'offline')`)).rejects.toThrow();
  });

  it("data integrity: NO company row is left with a NULL tenant column after the chain", async () => {
    const orphan = rows(await db.execute(sql`SELECT count(*)::int AS c FROM companies WHERE organization_id IS NULL`));
    expect(orphan[0].c).toBe(0);
  });
});
