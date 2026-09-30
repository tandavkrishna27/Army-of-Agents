// Real-Postgres proof that secretService.create stamps organization_id from the
// owning company (multi-tenant cloud, C3). Pre-fix, the create path omitted the
// column and every new secret was org-NULL. Linux-only; Windows flip + revert.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { DEFAULT_ORGANIZATION_ID } from "@armyofagents/shared";
import { secretService } from "../services/secrets.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

// SF-1 (punch-list): raw-insert a company (mirroring C2/C4) instead of driving
// the whole companyService.create provisioning path (root-folder seeding,
// internal_agent_config, Commander agent seeding) — faster, less flaky, and
// consistent with the other C integration tests. The sentinel org is seeded by
// 0188 (0188_organizations.sql:87), so DEFAULT_ORGANIZATION_ID is reachable.
const ORG = DEFAULT_ORGANIZATION_ID;

type PG = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
let pg: PG | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
const rows = (r: unknown) => (Array.isArray(r) ? r : (r as any).rows) as any[];

beforeAll(async () => {
  // Fixed master key -> deterministic, no data/secrets/master.key fs write.
  process.env.AOA_SECRETS_MASTER_KEY = "0".repeat(64);
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-secret-orgid-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: any };
    const port = await allocateEmbeddedPgPort();
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port, persistent: false });
    await pg.initialise();
    await pg.start();
    const url = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(url);
    db = createDb(url);
  } catch (e) {
    setupError = e;
    // eslint-disable-next-line no-console
    console.error("[secret-create-org-id] setup failed:", e);
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform !== "linux")("secretService.create stamps organization_id", () => {
  it("a newly created secret carries the company's organization_id", async () => {
    if (setupError) throw new Error(String(setupError));
    // Raw-insert the company on the sentinel org (SF-1) — no companyService.create.
    const companyId = rows(
      await db.execute(
        sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('Secret Co', 'SEC', ${ORG}) RETURNING id`,
      ),
    )[0].id;

    const secret = await secretService(db).create(companyId, {
      name: "MY_SECRET",
      value: "hunter2",
      provider: "local_encrypted",
    });

    const stored = rows(await db.execute(sql`SELECT organization_id FROM company_secrets WHERE id = ${secret.id}`))[0];
    expect(stored.organization_id).toBe(ORG);
    expect(stored.organization_id).not.toBeNull();
  }, 90_000);
});
