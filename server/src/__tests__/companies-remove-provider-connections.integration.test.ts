// server/src/__tests__/companies-remove-provider-connections.integration.test.ts
//
// Real-DB regression for companies.remove() vs. the two RESTRICT FKs into
// company_secrets: provider_connections.secret_ref (migration 0190) and
// runtime_provider_keys.secret_id — both ON DELETE restrict. A company whose
// legacy provider key was backfilled into a connection, or that has a stored
// runtime provider key, PINS its company_secrets rows. remove() deletes
// companySecrets explicitly BEFORE the final company-row cascade would clear
// those referrers, so without deleting provider_assignments + provider_connections
// + runtime_provider_keys first the companySecrets delete aborts the whole
// transaction on the RESTRICT FK.
//
// This needs a real DB (the FK is only enforced by Postgres), so it boots
// embedded-postgres inline — mirroring provider-connections-backfill.integration
// .test.ts — and seeds via SQL. Runs on Linux CI, SKIPPED on Windows CI per the
// platform matrix (Issue #114). `initdbFlags` are committed so the win32 skip can
// be flipped for a local Windows run.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import {
  companies,
  companySecrets,
  providerAssignments,
  providerConnections,
  runtimeProviderKeys,
} from "@armyofagents/db";
import { companyService } from "../services/companies.js";
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
  initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

function firstId(result: unknown): string {
  if (Array.isArray(result)) return (result[0] as { id: string })?.id;
  return (result as { rows?: Array<{ id: string }> }).rows?.[0]?.id ?? "";
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-companies-remove-provider-"));
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
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
  } catch (err) {
    setupError = err;
  }
}, 180_000);

afterAll(async () => {
  try {
    if (pg) await pg.stop();
  } catch {
    /* ignore cleanup failures */
  }
  try {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore cleanup failures */
  }
}, 60_000);

/** Insert a company (organization_id defaults to the 0188 sentinel org). */
async function seedCompany(name: string, prefix: string): Promise<string> {
  return firstId(
    await db.execute<{ id: string }>(sql`
      INSERT INTO companies (id, name, issue_prefix)
      VALUES (gen_random_uuid(), ${name}, ${prefix})
      RETURNING id
    `),
  );
}

describe.skipIf(process.platform === "win32")(
  "companies.remove() vs provider_connections RESTRICT FK (real DB)",
  () => {
    it("removes a company whose secrets are pinned by a provider connection and a runtime provider key", async () => {
      if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);

      const companyId = await seedCompany("Provider Pin Co", "PPC");
      expect(companyId).toBeTruthy();

      // A vault secret for the (backfilled) provider key.
      const secretId = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO company_secrets (id, company_id, name)
          VALUES (gen_random_uuid(), ${companyId}, 'provider:anthropic')
          RETURNING id
        `),
      );
      expect(secretId).toBeTruthy();

      // provider_connections.secret_ref → company_secrets is ON DELETE restrict:
      // this row is what makes remove()'s companySecrets delete abort pre-fix.
      const connectionId = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO provider_connections (id, company_id, provider, auth_method, secret_ref, state)
          VALUES (gen_random_uuid(), ${companyId}, 'anthropic', 'api_key', ${secretId}, 'verified')
          RETURNING id
        `),
      );
      expect(connectionId).toBeTruthy();

      // A routing assignment pointing at that connection.
      await db.execute(sql`
        INSERT INTO provider_assignments (id, company_id, connection_id, provider, scope_type)
        VALUES (gen_random_uuid(), ${companyId}, ${connectionId}, 'anthropic', 'company_default')
      `);

      // The SECOND RESTRICT referrer into company_secrets: runtime_provider_keys
      // .secret_id → company_secrets(id) is ON DELETE restrict, so this row pins
      // its (distinct) secret exactly like the connection above. Uses its own
      // secret so a RED here is unambiguously the runtime_provider_keys FK, not
      // the already-handled connection secret.
      const runtimeSecretId = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO company_secrets (id, company_id, name)
          VALUES (gen_random_uuid(), ${companyId}, 'provider:openai')
          RETURNING id
        `),
      );
      expect(runtimeSecretId).toBeTruthy();

      await db.execute(sql`
        INSERT INTO runtime_provider_keys (id, company_id, provider, display_name, secret_id)
        VALUES (gen_random_uuid(), ${companyId}, 'openai', 'OpenAI Key', ${runtimeSecretId})
      `);

      // remove() must RESOLVE (no FK abort) …
      const removed = await companyService(db).remove(companyId);
      expect(removed).toBeDefined();
      expect(removed?.id).toBe(companyId);

      // … and every dependent + the company itself must be gone.
      const secretsLeft = await db
        .select({ id: companySecrets.id })
        .from(companySecrets)
        .where(eq(companySecrets.companyId, companyId));
      expect(secretsLeft).toHaveLength(0);

      const connsLeft = await db
        .select({ id: providerConnections.id })
        .from(providerConnections)
        .where(eq(providerConnections.companyId, companyId));
      expect(connsLeft).toHaveLength(0);

      const asnsLeft = await db
        .select({ id: providerAssignments.id })
        .from(providerAssignments)
        .where(eq(providerAssignments.companyId, companyId));
      expect(asnsLeft).toHaveLength(0);

      const runtimeKeysLeft = await db
        .select({ id: runtimeProviderKeys.id })
        .from(runtimeProviderKeys)
        .where(eq(runtimeProviderKeys.companyId, companyId));
      expect(runtimeKeysLeft).toHaveLength(0);

      const companyLeft = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, companyId));
      expect(companyLeft).toHaveLength(0);
    }, 90_000);
  },
);
