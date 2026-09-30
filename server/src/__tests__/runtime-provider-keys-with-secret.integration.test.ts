// Real-Postgres proof for the one-step "Add E2B key" flow (createWithSecret):
//   - POST .../runtime-provider-keys/with-secret writes a company_secrets row +
//     a current company_secret_versions row + a runtime_provider_keys row
//     (is_default=true), and resolveCredential returns the pasted value.
//   - a SECOND default-with-secret demotes the first (partial-unique
//     runtime_provider_keys_default_uq is not violated).
//   - a provider-key insert failure leaves NO orphan secret (atomic rollback).
//   - auth: non-member -> 403, unauthenticated -> 401.
//   - the response body never carries the raw value.
//
// Windows-skipped unless AOA_RUN_WIN_INTEGRATION=1 (embedded-postgres cannot
// start on the CI runneradmin runner — Issue #114; Linux CI is the authority).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "@armyofagents/db";
import { DEFAULT_ORGANIZATION_ID } from "@armyofagents/shared";
import { secretRoutes } from "../routes/secrets.js";
import { runtimeProviderKeyService } from "../services/runtime-provider-keys.js";
import { errorHandler } from "../middleware/error-handler.js";
import { startMigratedDatabase, type MigratedDatabase } from "./helpers/migrated-database.js";

const ORG = DEFAULT_ORGANIZATION_ID;

let migrated: MigratedDatabase | null = null;
let db: Db;
let app: Express;
let companyId = "";
let setupError: unknown = null;
const rows = (r: unknown) => (Array.isArray(r) ? r : (r as any).rows) as any[];

// Per-request actor, swapped by each auth test. Mirrors the board actor the auth
// middleware would attach in a real local_trusted deployment.
type TestActor = Record<string, unknown>;
let currentActor: TestActor = {};

const RUN = process.platform !== "win32" || process.env.AOA_RUN_WIN_INTEGRATION === "1";

beforeAll(async () => {
  if (!RUN) return;
  process.env.AOA_SECRETS_MASTER_KEY = "0".repeat(64);
  try {
    migrated = await startMigratedDatabase({ label: "aoa-e2b-onestep-" });
    // Owner Drizzle handle: seed + service calls run as the migration owner (RLS
    // is dormant behind its default-off flag, and this mirrors the sibling
    // secret integration test's owner-db pattern).
    db = createDb(migrated.adminUrl);

    companyId = rows(
      await db.execute(
        sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('E2B Co', 'E2B', ${ORG}) RETURNING id`,
      ),
    )[0].id;

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = currentActor;
      next();
    });
    app.use(secretRoutes(db));
    app.use(errorHandler);
  } catch (e) {
    setupError = e;
    // eslint-disable-next-line no-console
    console.error("[e2b-one-step] setup failed:", e);
  }
}, 180_000);

afterAll(async () => {
  try { await migrated?.teardown(); } catch { /* ignore */ }
}, 60_000);

function boardActor(overrides: TestActor = {}): TestActor {
  return { type: "board", source: "session", userId: "u-1", companyIds: [companyId], isInstanceAdmin: false, ...overrides };
}

const systemCtx = {
  consumerType: "system" as const,
  consumerId: "runtime-provider-key:e2b",
  actorType: "system" as const,
  configPath: "runtimeProviderKeys.e2b.default",
};

describe.skipIf(!RUN)("POST /runtime-provider-keys/with-secret (real PG)", () => {
  it("creates the secret + version + default provider key and resolves the pasted value", async () => {
    if (setupError) throw new Error(String(setupError));
    currentActor = boardActor();

    const res = await request(app)
      .post(`/companies/${companyId}/runtime-provider-keys/with-secret`)
      .send({ provider: "e2b", displayName: "Default E2B", value: "e2b_live_ONE", isDefault: true, secretName: "E2B_ONE" });

    expect(res.status).toBe(201);
    expect(res.body.provider).toBe("e2b");
    expect(res.body.isDefault).toBe(true);
    // The raw value is never echoed back.
    expect(JSON.stringify(res.body)).not.toContain("e2b_live_ONE");

    const secret = rows(await db.execute(sql`SELECT id, status, created_by_user_id FROM company_secrets WHERE company_id = ${companyId} AND name = 'E2B_ONE'`))[0];
    expect(secret).toBeTruthy();
    expect(secret.status).toBe("active");
    // ★ Codex P1: the generated secret carries its creator, not NULL — the actor
    // is threaded through createWithSecret, matching the two-step secret-create.
    expect(secret.created_by_user_id).toBe("u-1");
    const version = rows(await db.execute(sql`SELECT status FROM company_secret_versions WHERE secret_id = ${secret.id} AND status = 'current'`));
    expect(version).toHaveLength(1);
    const key = rows(await db.execute(sql`SELECT is_default, secret_id FROM runtime_provider_keys WHERE company_id = ${companyId} AND provider = 'e2b' AND is_default IS TRUE`));
    expect(key).toHaveLength(1);
    expect(key[0].secret_id).toBe(secret.id);
    // ★ Codex P1: BOTH audit events are recorded — the secret's own secret.created
    // alongside runtime_provider_key.created — so a one-step credential is as
    // auditable as a normally-created one.
    const secretCreated = rows(await db.execute(sql`SELECT id FROM activity_log WHERE company_id = ${companyId} AND action = 'secret.created' AND entity_id = ${secret.id}`));
    expect(secretCreated).toHaveLength(1);
    const keyCreated = rows(await db.execute(sql`SELECT id FROM activity_log WHERE company_id = ${companyId} AND action = 'runtime_provider_key.created' AND entity_id = ${res.body.id}`));
    expect(keyCreated).toHaveLength(1);

    const resolved = await runtimeProviderKeyService(db).resolveCredential(
      companyId,
      "e2b",
      { credentialRef: "default" },
      systemCtx,
    );
    expect(resolved).toBe("e2b_live_ONE");
  }, 120_000);

  it("demotes the previous default when a second key is added as default", async () => {
    if (setupError) throw new Error(String(setupError));
    currentActor = boardActor();

    const res = await request(app)
      .post(`/companies/${companyId}/runtime-provider-keys/with-secret`)
      .send({ provider: "e2b", displayName: "Second E2B", value: "e2b_live_TWO", isDefault: true, secretName: "E2B_TWO" });

    expect(res.status).toBe(201);

    const defaults = rows(await db.execute(sql`SELECT id FROM runtime_provider_keys WHERE company_id = ${companyId} AND provider = 'e2b' AND is_default IS TRUE`));
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(res.body.id);

    // The default now resolves to the newest pasted value.
    const resolved = await runtimeProviderKeyService(db).resolveCredential(
      companyId,
      "e2b",
      { credentialRef: "default" },
      systemCtx,
    );
    expect(resolved).toBe("e2b_live_TWO");
  }, 120_000);

  it("leaves NO orphan secret when the provider-key insert fails (atomic rollback)", async () => {
    if (setupError) throw new Error(String(setupError));

    const before = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM company_secrets WHERE company_id = ${companyId} AND name = 'E2B_ORPHAN'`))[0].n;
    expect(before).toBe(0);

    await expect(
      // displayName=null trips the runtime_provider_keys.display_name NOT NULL
      // constraint on the SECOND write — after the secret was already created.
      runtimeProviderKeyService(db).createWithSecret(companyId, {
        provider: "e2b",
        displayName: null as unknown as string,
        value: "e2b_live_ORPHAN",
        isDefault: true,
        secretName: "E2B_ORPHAN",
      }),
    ).rejects.toThrow();

    const after = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM company_secrets WHERE company_id = ${companyId} AND name = 'E2B_ORPHAN'`))[0].n;
    expect(after).toBe(0);
  }, 120_000);

  it("rejects a non-member board actor with 403", async () => {
    if (setupError) throw new Error(String(setupError));
    currentActor = boardActor({ companyIds: [] });

    const res = await request(app)
      .post(`/companies/${companyId}/runtime-provider-keys/with-secret`)
      .send({ provider: "e2b", displayName: "Nope", value: "e2b_live_NOPE", isDefault: true, secretName: "E2B_NOPE" });

    expect(res.status).toBe(403);
    const count = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM company_secrets WHERE company_id = ${companyId} AND name = 'E2B_NOPE'`))[0].n;
    expect(count).toBe(0);
  }, 120_000);

  it("rejects an unauthenticated request with 401", async () => {
    if (setupError) throw new Error(String(setupError));
    currentActor = { type: "none" };

    const res = await request(app)
      .post(`/companies/${companyId}/runtime-provider-keys/with-secret`)
      .send({ provider: "e2b", displayName: "Anon", value: "e2b_live_ANON", isDefault: true, secretName: "E2B_ANON" });

    expect(res.status).toBe(401);
    const count = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM company_secrets WHERE company_id = ${companyId} AND name = 'E2B_ANON'`))[0].n;
    expect(count).toBe(0);
  }, 120_000);
});
