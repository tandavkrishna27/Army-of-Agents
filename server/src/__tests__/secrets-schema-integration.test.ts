import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  type Db,
} from "@armyofagents/db";

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
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

function firstId(result: unknown): string {
  if (Array.isArray(result)) return (result[0] as any)?.id;
  return (result as any).rows?.[0]?.id;
}

const PORT = 55000 + Math.floor(Math.random() * 1000);

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-secrets-schema-test-"));
    const { default: EmbeddedPostgres } = (await import(
      "embedded-postgres"
    )) as { default: EmbeddedPostgresCtor };

    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
    });
    await pg.initialise();
    await pg.start();

    const connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[secrets-schema-integration] embedded-postgres setup failed:", err);
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

describe.skipIf(process.platform === "win32")("secrets schema — real DB integration", () => {
  it("persists provider configs, bindings, and access audit events", async () => {
    if (setupError) {
      throw new Error(
        `embedded-postgres setup failed; cannot run integration test: ${String(setupError)}`,
      );
    }

    const companyInserted = await db.execute<{ id: string }>(sql`
      INSERT INTO companies (id, name)
      VALUES (gen_random_uuid(), 'Secrets Schema Co')
      RETURNING id
    `);
    const companyId = firstId(companyInserted);
    expect(companyId).toBeTruthy();

    const providerConfigInserted = await db.execute<{ id: string; company_id: string }>(sql`
      INSERT INTO company_secret_provider_configs (id, company_id, provider, display_name, is_default, config)
      VALUES (gen_random_uuid(), ${companyId}, 'aws_secrets_manager', 'AWS Vault', true, '{"region":"us-east-1"}')
      RETURNING id, company_id
    `);
    const providerConfigId = firstId(providerConfigInserted);
    const providerConfigCompanyId = Array.isArray(providerConfigInserted)
      ? providerConfigInserted[0]?.company_id
      : (providerConfigInserted as any).rows?.[0]?.company_id;

    expect(providerConfigId).toBeTruthy();
    expect(providerConfigCompanyId).toBe(companyId);

    const secretInserted = await db.execute<{ id: string }>(sql`
      INSERT INTO company_secrets (id, company_id, name, key, provider, provider_config_id)
      VALUES (gen_random_uuid(), ${companyId}, 'OpenAI API Key', 'OPENAI_API_KEY', 'aws_secrets_manager', ${providerConfigId})
      RETURNING id
    `);
    const secretId = firstId(secretInserted);
    expect(secretId).toBeTruthy();

    await db.execute(sql`
      INSERT INTO company_secret_bindings (id, company_id, secret_id, target_type, target_id, config_path)
      VALUES (gen_random_uuid(), ${companyId}, ${secretId}, 'agent', 'agent-1', 'env.OPENAI_API_KEY')
    `);

    const bindingResult = await db.execute<{ config_path: string }>(sql`
      SELECT config_path
      FROM company_secret_bindings
      WHERE company_id = ${companyId}
        AND secret_id = ${secretId}
    `);
    const bindingConfigPath = Array.isArray(bindingResult)
      ? bindingResult[0]?.config_path
      : (bindingResult as any).rows?.[0]?.config_path;
    expect(bindingConfigPath).toBe("env.OPENAI_API_KEY");

    await db.execute(sql`
      INSERT INTO secret_access_events (
        id,
        company_id,
        secret_id,
        version,
        provider,
        actor_type,
        actor_id,
        consumer_type,
        consumer_id,
        config_path,
        outcome
      )
      VALUES (
        gen_random_uuid(),
        ${companyId},
        ${secretId},
        1,
        'aws_secrets_manager',
        'agent',
        'agent-1',
        'agent',
        'run-1',
        'env.OPENAI_API_KEY',
        'success'
      )
    `);

    const eventResult = await db.execute<{ outcome: string }>(sql`
      SELECT outcome
      FROM secret_access_events
      WHERE company_id = ${companyId}
        AND secret_id = ${secretId}
    `);
    const outcome = Array.isArray(eventResult)
      ? eventResult[0]?.outcome
      : (eventResult as any).rows?.[0]?.outcome;
    expect(outcome).toBe("success");
  });
});
