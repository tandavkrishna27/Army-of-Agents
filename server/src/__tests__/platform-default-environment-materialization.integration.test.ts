/**
 * U1b real-DB proof: the platform-default environment is lazily MATERIALIZED
 * as a real, persisted `environments` row instead of the purely synthetic
 * `id: "platform-default-e2b"` object `resolvePlatformDefaultEnvironment`
 * used to return directly.
 *
 * THE BUG (see acquire-execution-context.integration.test.ts's original
 * GROUNDING NOTE, and platform-default-environment.ts's stale pre-fix
 * comment): `environment_leases.environment_id` is a NOT NULL FK to
 * `environments.id` (a Postgres `uuid` PK), and `environmentService(db)
 * .acquireLease()` does a `select ... from environments where id =
 * environmentId and companyId = ...` that throws "Environment not found for
 * company" when no row exists. The synthetic, non-persisted,
 * non-uuid-shaped "platform-default-e2b" id could never satisfy either
 * check, so a real cloud lease against the platform default could never be
 * acquired.
 *
 * THE FIX: `ensurePlatformDefaultEnvironmentRow` derives a DETERMINISTIC
 * uuid from companyId (RFC 4122 UUIDv5) and idempotently inserts (
 * onConflictDoNothing on the PK) a real `environments` row for it.
 * `environmentRunOrchestrator(db).resolveEnvironment({environmentId: null})`
 * now returns that persisted row instead of the synthetic object.
 *
 * Skipped on Windows by default (embedded-postgres can't start on the CI
 * runner — Issue #114); set AOA_RUN_WIN_INTEGRATION=1 on a Windows dev box
 * to force-run it (verified locally for this task, then reverted to the
 * default skip before commit).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, environments, environmentLeases, type Db } from "@armyofagents/db";
import type { SandboxRuntimeProvider } from "../services/sandbox-provider-runtime.js";
import { createFakeSandboxRuntimeProvider } from "../services/sandbox-provider-runtime.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentRunOrchestrator } from "../services/environment-run-orchestrator.js";
import { derivePlatformDefaultEnvironmentId } from "../services/platform-default-environment.js";
import { setDeploymentMode, getDeploymentMode } from "../config/deployment-mode.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

const ORG = randomUUID();
const CO = randomUUID();
const PORT = 56000 + Math.floor(Math.random() * 1000);

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-pdem-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const url = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(url);
    db = createDb(url);
    await db.execute(sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org PDEM', 'org-pdem')`);
    await db.execute(
      sql`INSERT INTO companies (id, name, issue_prefix, organization_id) VALUES (${CO}, 'Co PDEM', 'PDEM', ${ORG})`,
    );
  } catch (e) {
    setupError = e;
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

// deployment-mode is process-wide mutable state (config/deployment-mode.ts) —
// restore it after every test so this file can never leak cloud_auth into a
// sibling test running in the same worker.
const savedDeploymentMode = getDeploymentMode();
const savedE2bApiKey = process.env.E2B_API_KEY;
afterEach(() => {
  setDeploymentMode(savedDeploymentMode);
  if (savedE2bApiKey === undefined) delete process.env.E2B_API_KEY;
  else process.env.E2B_API_KEY = savedE2bApiKey;
});

/** Fake sandbox provider registered under the "e2b" key (never touches the
 *  real e2b SDK / network). */
function fakeE2bProvider(): SandboxRuntimeProvider {
  return { ...createFakeSandboxRuntimeProvider(), provider: "e2b" };
}

/** Minimal fake runtime-provider-key resolver: the real one queries
 *  `runtime_provider_keys` for a company-configured E2B key, which this test
 *  company has none of. Only `resolveCredential` is read by the real
 *  createSandboxDockerEnvironmentDriver. */
function fakeRuntimeProviderKeys() {
  return { resolveCredential: async () => "fake-e2b-key-for-test" };
}

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "platform-default environment materialization (U1b)",
  () => {
    it("resolveEnvironment(null) persists a REAL uuid environments row (not the synthetic id), idempotent across calls, with no E2B_API_KEY in config", async () => {
      if (setupError) throw new Error(String(setupError));
      setDeploymentMode("cloud_auth");
      process.env.E2B_API_KEY = "fake-key-for-materialization-test";

      const orchestrator = environmentRunOrchestrator(db);

      const first = await orchestrator.resolveEnvironment({ companyId: CO, environmentId: null });
      expect(first.id).not.toBe("platform-default-e2b");
      expect(first.id).toBe(derivePlatformDefaultEnvironmentId(CO));

      const [row] = await db
        .select()
        .from(environments)
        .where(and(eq(environments.id, first.id), eq(environments.companyId, CO)));
      expect(row).toBeTruthy();
      expect(row!.driver).toBe("sandbox");
      expect(row!.config).toMatchObject({ provider: "e2b" });
      expect(JSON.stringify(row!.config)).not.toContain("fake-key-for-materialization-test");
      expect(row!.config).not.toHaveProperty("apiKey");
      expect(row!.config).not.toHaveProperty("E2B_API_KEY");
      expect(row!.config).not.toHaveProperty("resolvedApiKey");

      // Second resolve: same company -> same id, and the row is NOT duplicated.
      const second = await orchestrator.resolveEnvironment({ companyId: CO, environmentId: null });
      expect(second.id).toBe(first.id);

      const allRows = await db
        .select({ id: environments.id })
        .from(environments)
        .where(and(eq(environments.companyId, CO), eq(environments.driver, "sandbox")));
      expect(allRows).toHaveLength(1);
    }, 60_000);

    it("an actual lease acquisition against the materialized platform default succeeds (the original break point)", async () => {
      if (setupError) throw new Error(String(setupError));
      setDeploymentMode("cloud_auth");
      process.env.E2B_API_KEY = "fake-key-for-lease-test";

      const orchestrator = environmentRunOrchestrator(db, {
        environmentRuntime: environmentRuntimeService(db, {
          // environments left REAL (no DI override) — proves a genuine DB
          // round trip through environmentService(db).acquireLease's row
          // lookup, which is exactly where the original bug threw
          // "Environment not found for company".
          sandboxProviders: [fakeE2bProvider()],
          runtimeProviderKeys: fakeRuntimeProviderKeys(),
        }),
      });

      const result = await orchestrator.acquireForRun({
        companyId: CO,
        environmentId: null,
        adapterType: "claude_local",
        issueId: null,
        heartbeatRunId: null,
        persistedExecutionWorkspace: null,
      });

      expect(result.environment.id).toBe(derivePlatformDefaultEnvironmentId(CO));
      expect(result.lease).toEqual(
        expect.objectContaining({ provider: "e2b", providerLeaseId: expect.stringMatching(/^fake-sandbox-/) }),
      );

      // Genuine DB proof: the lease row is really in environment_leases,
      // really FK'd to the materialized environments row.
      const [leaseRow] = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.id, result.lease.id));
      expect(leaseRow).toBeTruthy();
      expect(leaseRow!.environmentId).toBe(result.environment.id);
      expect(leaseRow!.status).toBe("active");
    }, 60_000);
  },
);
