import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { organizationService } from "../services/organizations.js";
import { companyService } from "../services/companies.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type PG = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
let pg: PG | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-org-uniq-"));
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
    console.error("[organizations-uniqueness] setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform !== "linux")("organization uniqueness matrix — real DB", () => {
  it("rejects the SAME route prefix in DIFFERENT organizations", async () => {
    if (setupError) throw new Error(String(setupError));
    const orgs = organizationService(db);
    const a = await orgs.create({ name: "Org A" });
    const b = await orgs.create({ name: "Org B" });
    await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('CA', 'DUP', ${a.id})`);
    await expect(
      db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('CB', 'DUP', ${b.id})`),
    ).rejects.toThrow();
  });

  it("rejects the SAME issue_prefix within ONE organization", async () => {
    const org = await organizationService(db).create({ name: "Org C" });
    await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('C1', 'SME', ${org.id})`);
    await expect(
      db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('C2', 'SME', ${org.id})`),
    ).rejects.toThrow();
  });

  it("allows the SAME issue identifier string in two different companies", async () => {
    const org = await organizationService(db).create({ name: "Org D" });
    const r1 = await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('D1', 'DA', ${org.id}) RETURNING id`);
    const r2 = await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('D2', 'DB', ${org.id}) RETURNING id`);
    const id1 = (Array.isArray(r1) ? r1 : (r1 as any).rows)[0].id;
    const id2 = (Array.isArray(r2) ? r2 : (r2 as any).rows)[0].id;
    await db.execute(sql`INSERT INTO issues (company_id, title, identifier, status) VALUES (${id1}, 'x', 'DUP-1', 'backlog')`);
    await expect(
      db.execute(sql`INSERT INTO issues (company_id, title, identifier, status) VALUES (${id2}, 'y', 'DUP-1', 'backlog')`),
    ).resolves.toBeDefined();
  });

  it("rejects a duplicate organization slug (global uniqueness)", async () => {
    await db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Slug1', 'shared-slug')`);
    await expect(
      db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Slug2', 'shared-slug')`),
    ).rejects.toThrow();
  });

  it("auto-suffixes the prefix when two same-named companies are created in one org (23505 handler works)", async () => {
    const org = await organizationService(db).create({ name: "Org E" });
    const c1 = await companyService(db).create({ name: "Same Name Co", organizationId: org.id });
    const c2 = await companyService(db).create({ name: "Same Name Co", organizationId: org.id });
    expect(c1.issuePrefix).not.toBe(c2.issuePrefix);
  });

  it("auto-suffixes the prefix when same-named companies are created across orgs", async () => {
    const orgs = organizationService(db);
    const a = await orgs.create({ name: "Org F" });
    const b = await orgs.create({ name: "Org G" });
    const c1 = await companyService(db).create({ name: "Cross Org Same Name", organizationId: a.id });
    const c2 = await companyService(db).create({ name: "Cross Org Same Name", organizationId: b.id });
    expect(c1.issuePrefix).not.toBe(c2.issuePrefix);
  });
});
