/**
 * Real-orchestrator integration proof for U4's acquireExecutionContext (S1 /
 * S5 / S6). Boots embedded-postgres + real migrations, then exercises the
 * REAL environmentRunOrchestrator (resolveEnvironment, resolveEnvironment
 * ExecutionTargetConfigPatch, resolveAdapterExecutionTarget — all real,
 * unmocked) with a fake sandbox provider registered at the DI seam so no
 * real E2B network call is required. Mirrors the AOA_E2E_FAKE_EMBEDDER
 * pattern (fake only the outermost network/DB leaf, exercise everything
 * else for real).
 *
 * GROUNDING NOTE (real-shape drift from the plan, see the U4 task report):
 * the plan's §10 assumed the fake-sandbox seam lives at `importE2b`
 * (sandbox-provider-runtime.ts). That seam exists, but a CLOSER, already-
 * committed (Wave 0/1) seam exists one level up: `environmentRuntimeService(
 * db, { sandboxProviders, runtimeProviderKeys, environments })` — all three
 * are already-shipped DI options, so registering a fake provider under the
 * "e2b" key there requires ZERO production code changes (unlike importE2b,
 * which needs mocking the "e2b" npm package). This test uses that seam.
 *
 * A SECOND, genuine finding surfaced while building this test (U4): the S1
 * "null environmentId -> platform default" path used to resolve a synthetic,
 * NEVER-PERSISTED id (PLATFORM_DEFAULT_ENVIRONMENT_ID = "platform-default-e2b").
 * `environments.id` is a Postgres `uuid` column and
 * `environment_leases.environment_id` is a NOT NULL FK to it — so a REAL
 * `environmentsSvc.acquireLease()` call against that synthetic id could NEVER
 * succeed against a real `environments` table. That gap is FIXED (U1b,
 * platform-default-environment-materialization.integration.test.ts):
 * `environmentRunOrchestrator.resolveEnvironment({environmentId: null})` now
 * calls `ensurePlatformDefaultEnvironmentRow`, which lazily materializes a
 * REAL `environments` row keyed by a deterministic uuid derived from
 * companyId (idempotent via `onConflictDoNothing` on the PK — no migration).
 * The null-env case below still fakes the `environments` lease-persistence
 * leaf (in-memory) — that remains a valid, narrower way to prove the S1
 * null-through + orchestrator wiring without depending on U1b's materialize
 * step — but it is no longer the ONLY way to exercise this path for real; see
 * the U1b integration test for the genuine end-to-end DB proof (materialize +
 * real lease acquisition, no fakes on the environments leaf). The
 * PINNED-environment-id case below (test 2) hits the real `environments`
 * table with no such fake, proving a genuine DB round trip for S5/S6.
 *
 * Skipped on Windows by default (embedded-postgres can't start on the CI
 * runner — Issue #114); set AOA_RUN_WIN_INTEGRATION=1 on a Windows dev box
 * to force-run it (verified locally for this task, then reverted to the
 * default skip before commit — see heartbeat-execution-target.test.ts /
 * crew-run-log-pointer.integration.test.ts for the established pattern).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, environments, type Db } from "@armyofagents/db";
import type { SandboxRuntimeProvider } from "../services/sandbox-provider-runtime.js";
import { createFakeSandboxRuntimeProvider } from "../services/sandbox-provider-runtime.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentRunOrchestrator } from "../services/environment-run-orchestrator.js";
import { acquireExecutionContext } from "../services/acquire-execution-context.js";
import { applyEnvironmentAcquisitionConfig } from "../services/heartbeat.js";
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
const PORT = 55000 + Math.floor(Math.random() * 1000);

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-aec-"));
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
    await db.execute(sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org AEC', 'org-aec')`);
    await db.execute(
      sql`INSERT INTO companies (id, name, issue_prefix, organization_id) VALUES (${CO}, 'Co AEC', 'AEC', ${ORG})`,
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
 *  real e2b SDK / network) — see the GROUNDING NOTE above. */
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
  "acquireExecutionContext (real orchestrator, S1/S5/S6)",
  () => {
    it("null environmentId (crew dispatch) resolves the platform default to a provider-sandbox target", async () => {
      if (setupError) throw new Error(String(setupError));
      setDeploymentMode("cloud_auth");
      process.env.E2B_API_KEY = "fake-key-for-platform-default-resolution";

      // In-memory lease store — see the GROUNDING NOTE: the platform-default
      // id is synthetic (non-uuid) and can never satisfy the real
      // environments.acquireLease() FK/row-lookup, so this leaf is faked.
      const leases = new Map<string, Record<string, unknown>>();
      const fakeEnvironments = {
        acquireLease: async (input: Record<string, unknown>) => {
          const id = randomUUID();
          const row = { id, ...input, status: "active", acquiredAt: new Date(), lastUsedAt: new Date() };
          leases.set(id, row);
          return row as never;
        },
        releaseLease: async (id: string) => {
          const row = leases.get(id);
          if (!row) return null;
          const released = { ...row, status: "released", releasedAt: new Date() };
          leases.set(id, released);
          return released as never;
        },
        releaseLeasesForRun: async () => [] as never,
      };

      const orchestrator = environmentRunOrchestrator(db, {
        environmentRuntime: environmentRuntimeService(db, {
          environments: fakeEnvironments,
          sandboxProviders: [fakeE2bProvider()],
          runtimeProviderKeys: fakeRuntimeProviderKeys(),
        }),
      });

      // Crew-style dispatch: agentId set, adapterType claude_local.
      const crewAcquired = await acquireExecutionContext(
        { orchestrator } as never,
        {
          runIdentity: { companyId: CO, agentId: randomUUID(), runId: randomUUID(), adapterType: "claude_local" },
          functionType: null,
          warmPreference: false,
          worktree: null,
          environmentId: null,
        },
      );
      expect(crewAcquired.sandbox).not.toBeNull();
      expect(crewAcquired.sandbox!.environment.driver).toBe("sandbox"); // S5
      expect(crewAcquired.lease).toEqual(
        expect.objectContaining({ provider: "e2b", providerLeaseId: expect.stringMatching(/^fake-sandbox-/) }), // S6
      );
      expect(
        applyEnvironmentAcquisitionConfig({}, crewAcquired.sandbox).executionTarget,
      ).toEqual(expect.objectContaining({ type: "provider-sandbox", provider: "e2b" }));

      // Commander-style turn: agentId null, adapterType codex_local — SAME
      // platform default resolved (S1: no default-id caching/drift between
      // callers, each call independently resolves the same synthetic env).
      const commanderAcquired = await acquireExecutionContext(
        { orchestrator } as never,
        {
          runIdentity: { companyId: CO, agentId: null, runId: randomUUID(), adapterType: "codex_local" },
          functionType: null,
          warmPreference: false,
          worktree: null,
          environmentId: null,
        },
      );
      expect(commanderAcquired.sandbox!.environment.driver).toBe("sandbox");
      expect(commanderAcquired.sandbox!.environment.id).toBe(crewAcquired.sandbox!.environment.id); // same platform default
    }, 60_000);

    it("null environmentId on desktop/local_trusted (no platform default) returns sandbox:null — real orchestrator, no fakes needed", async () => {
      if (setupError) throw new Error(String(setupError));
      // Deliberately do NOT set cloud_auth / E2B_API_KEY — this is the
      // default state. No DI at all: the real environmentRunOrchestrator(db)
      // never reaches the DB for a null environmentId outside cloud_auth
      // (resolvePlatformDefaultEnvironment is a pure, deploymentMode-gated
      // check) so this proves the local fallback without any fake provider.
      const result = await acquireExecutionContext(db, {
        runIdentity: { companyId: CO, agentId: null, runId: randomUUID(), adapterType: "claude_local" },
        functionType: null,
        warmPreference: false,
        worktree: null,
        environmentId: null,
      });
      expect(result.sandbox).toBeNull();
      expect(result.lease).toBeNull();
    }, 30_000);

    it("pinned environmentId round-trips a REAL environment_leases row (S5/S6, genuine DB proof)", async () => {
      if (setupError) throw new Error(String(setupError));
      setDeploymentMode("cloud_auth");

      const [envRow] = await db
        .insert(environments)
        .values({
          companyId: CO,
          name: "pinned e2b env",
          driver: "sandbox",
          config: { provider: "e2b", remoteCwd: "/workspace", shellCommand: "bash" },
        })
        .returning();
      expect(envRow).toBeTruthy();

      const orchestrator = environmentRunOrchestrator(db, {
        environmentRuntime: environmentRuntimeService(db, {
          // environments left REAL here — proves an actual DB round trip.
          sandboxProviders: [fakeE2bProvider()],
          runtimeProviderKeys: fakeRuntimeProviderKeys(),
        }),
      });

      const result = await acquireExecutionContext(
        { orchestrator } as never,
        {
          runIdentity: { companyId: CO, agentId: randomUUID(), runId: randomUUID(), adapterType: "claude_local" },
          functionType: "software_development",
          warmPreference: false,
          worktree: null,
          environmentId: envRow!.id,
        },
      );

      expect(result.sandbox!.environment.driver).toBe("sandbox");
      expect(result.lease).toEqual(
        expect.objectContaining({ provider: "e2b", id: expect.any(String), providerLeaseId: expect.any(String) }),
      );
      expect(
        applyEnvironmentAcquisitionConfig({}, result.sandbox).executionTarget,
      ).toEqual(expect.objectContaining({ type: "provider-sandbox", provider: "e2b" }));

      // Genuine DB proof: the lease row is really in environment_leases.
      const rows = await db.execute(
        sql`SELECT provider, provider_lease_id, status FROM environment_leases WHERE id = ${result.lease!.id}`,
      );
      const persisted = (Array.isArray(rows) ? rows[0] : (rows as { rows: unknown[] }).rows?.[0]) as
        | { provider: string; provider_lease_id: string; status: string }
        | undefined;
      expect(persisted?.provider).toBe("e2b");
      expect(persisted?.status).toBe("active");
    }, 60_000);
  },
);
