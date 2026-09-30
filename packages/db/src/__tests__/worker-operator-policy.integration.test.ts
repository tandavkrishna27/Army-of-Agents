import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import postgres, { type Sql } from "postgres";
import { applyPendingMigrations } from "../client.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG = "81000000-0000-4000-8000-000000000001";
const TARGET = "82000000-0000-4000-8000-000000000001";
const PLATFORM_TARGET = "82000000-0000-4000-8000-000000000002";
const PASSWORD = "job-002-operator-policy";
let embedded: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let admin: Sql | null = null;
let app: Sql | null = null;
let operator: Sql | null = null;
let setupError: unknown = null;

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) :
        !address || typeof address === "string" ? reject(new Error("port allocation failed")) : resolve(address.port));
    });
    server.on("error", reject);
  });
}

function clients() {
  if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
  if (!admin || !app || !operator) throw new Error("database clients unavailable");
  return { admin, app, operator };
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-worker-operator-policy-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
    const port = await allocatePort();
    embedded = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"), user: "test", password: "test", port,
      persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await embedded.initialise();
    await embedded.start();
    const url = `postgres://test:test@127.0.0.1:${port}/postgres`;
    await applyPendingMigrations(url);
    admin = postgres(url, { max: 1 });
    await admin.unsafe(`ALTER ROLE aoa_app LOGIN PASSWORD '${PASSWORD}'`);
    await admin.unsafe(`ALTER ROLE aoa_operator LOGIN PASSWORD '${PASSWORD}'`);
    app = postgres(url.replace("test:test", `aoa_app:${PASSWORD}`), { max: 1 });
    operator = postgres(url.replace("test:test", `aoa_operator:${PASSWORD}`), { max: 1 });
    await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Policy Org', 'policy-org')`;
    await admin`INSERT INTO execution_targets
      (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope, target_authority_key)
      VALUES
      (${TARGET}, ${ORG}, 'tenant', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}', 'organization', ${`organization:${ORG}`}),
      (${PLATFORM_TARGET}, NULL, 'platform', 'pooled_gvisor', 'shared_multitenant', 'active', '{}', '{}', 'platform', 'platform')`;
    await admin`INSERT INTO worker_enrollment_code_routes (locator_hash, candidate_organization_id, expires_at)
      VALUES (${'a'.repeat(64)}, ${ORG}, now() + interval '1 hour'), (${'b'.repeat(64)}, NULL, now() + interval '1 hour')`;
    await admin`INSERT INTO worker_enrollment_codes
      (organization_id, scope, execution_target_id, target_authority_key, locator_hash, secret_hash,
       expires_at, created_by_principal_kind, created_by_principal_id)
      VALUES
      (${ORG}, 'organization', ${TARGET}, ${`organization:${ORG}`}, ${'a'.repeat(64)}, ${'c'.repeat(64)}, now() + interval '1 hour', 'user', 'u1'),
      (NULL, 'platform', ${PLATFORM_TARGET}, 'platform', ${'b'.repeat(64)}, ${'d'.repeat(64)}, now() + interval '1 hour', 'operator', 'op1')`;
    await admin`INSERT INTO workers
      (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
       device_thumbprint, device_generation, profile_hash, enrolled_at, label, status)
      VALUES ('83000000-0000-4000-8000-000000000001', 'platform', NULL, ${PLATFORM_TARGET}, 'platform',
        'public-key', ${'e'.repeat(64)}, 1, ${'f'.repeat(64)}, now(), 'platform worker', 'enrolled')`;
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  try { await operator?.end(); } catch { /* ignore */ }
  try { await app?.end(); } catch { /* ignore */ }
  try { await admin?.end(); } catch { /* ignore */ }
  try { await embedded?.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "JOB-002 bounded operator enrollment policy",
  () => {
    it("discovers only opaque routes while tenant code hashes/results remain invisible", async () => {
      const { operator } = clients();
      const routes = await operator`SELECT locator_hash, candidate_organization_id FROM worker_enrollment_code_routes`;
      expect(routes).toHaveLength(2);
      const codes = await operator`SELECT organization_id FROM worker_enrollment_codes`;
      expect(codes).toEqual([{ organization_id: null }]);
      await expect(operator`SELECT id FROM jobs`).rejects.toThrow(/permission denied/i);
    });

    it("allows null-Org platform facts, denies tenant writes, and keeps platform workers invisible to aoa_app", async () => {
      const { app, operator } = clients();
      await expect(operator`INSERT INTO worker_proof_replays
        (organization_id, device_thumbprint, proof_id, issued_at, expires_at)
        VALUES (${ORG}, ${'1'.repeat(64)}, 'operator-tenant-denied', now(), now() + interval '1 hour')`)
        .rejects.toThrow(/row-level security|policy/i);
      const platform = await operator`SELECT id FROM workers`;
      expect(platform).toHaveLength(1);
      const visible = await app.begin(async (tx) => {
        await tx.unsafe("SELECT set_config('aoa.organization_id', $1, true)", [ORG]);
        return tx.unsafe("SELECT id FROM workers WHERE organization_id IS NULL");
      });
      expect(visible).toHaveLength(0);
    });
  },
);
