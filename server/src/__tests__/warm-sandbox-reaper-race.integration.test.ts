/**
 * REL-004 Lane D (J10) — two CONCURRENT sweeps must produce exactly ONE provider kill.
 *
 * This needs a real database. The whole safety story of the strand arm rests on
 * `claimTerminalUncleaned` being a genuine compare-and-swap, and a mocked store cannot tell a
 * CAS from an `UPDATE ... RETURNING *` that always returns the row. Sequential sweeps prove
 * nothing either: J8 already passes trivially because the first sweep changes the state the
 * second one reads.
 *
 * It is not hypothetical. Both D1 replicas run this loop against the same DATABASE_URL, on the
 * same 5-minute interval, with no re-entrancy guard anywhere — so two sweeps overlapping on one
 * row is the expected steady state, not an edge case. Killing a sandbox twice is at best a
 * duplicate provider call and at worst a destroy racing a resume.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { sweepIdleWarmSandboxes } from "../services/warm-sandbox-reaper.js";
import { environmentService } from "../services/environments.js";
import type { SandboxRuntimeProvider } from "../services/sandbox-provider-runtime.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG = randomUUID();
const CO = randomUUID();
const ENV_ID = randomUUID();
const LEASE = randomUUID();
const PORT = 55700 + Math.floor(Math.random() * 300);

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-reaper-race-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test", password: "test", port: PORT, persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const url = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(url);
    db = createDb(url);
    await db.execute(sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org Race', 'org-race')`);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix, organization_id) VALUES (${CO}, 'Co Race', 'RACE', ${ORG})`);
    await db.execute(sql`INSERT INTO environments (id, company_id, name, driver, config)
      VALUES (${ENV_ID}, ${CO}, 'warm', 'sandbox', ${JSON.stringify({ provider: "e2b", template: "base" })}::jsonb)`);
  } catch (e) {
    setupError = e;
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

/** A STRANDED row: terminal, but still holding a provider handle and never confirmed cleaned. */
async function seedStranded() {
  await db.execute(sql`DELETE FROM environment_leases`);
  await db.execute(sql`INSERT INTO environment_leases
    (id, company_id, environment_id, status, lease_policy, provider, provider_lease_id, cleanup_status, metadata, acquired_at, updated_at)
    VALUES (${LEASE}, ${CO}, ${ENV_ID}, 'expired', 'reuse_by_agent', 'e2b', 'e2b-race',
      'pending', ${JSON.stringify({ provider: "e2b", providerMetadata: {} })}::jsonb,
      clock_timestamp(), clock_timestamp())`);
}

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "REL-004 Lane D/J10 — concurrent sweeps against one real row",
  () => {
    function guard() {
      if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      return db;
    }

    it("produces exactly ONE provider kill when two sweeps race the same stranded lease", async () => {
      guard();
      await seedStranded();

      let kills = 0;
      const provider: SandboxRuntimeProvider = {
        provider: "e2b",
        acquireLease: async () => { throw new Error("not used"); },
        releaseLease: async () => { kills++; return { cleanupStatus: "success" as const }; },
        execute: async () => { throw new Error("not used"); },
      } as unknown as SandboxRuntimeProvider;

      const sweep = () => sweepIdleWarmSandboxes(db, {
        environments: environmentService(db),
        sandboxProviders: [provider],
        runtimeProviderKeys: { resolveCredential: async () => "fake-key" },
        getExperimental: async () => ({ enableWarmSandboxReaper: true, warmSandboxIdleTtlMinutes: 30 }),
        readKillSwitchDocument: async () => undefined,
        currentKeyGeneration: async () => null,
      });

      const [a, b] = await Promise.all([sweep(), sweep()]);

      // The claim is a compare-and-swap, so exactly one sweep owns the row.
      expect(kills, "two sweeps must not both kill the same sandbox").toBe(1);
      expect(a.reaped + b.reaped).toBe(1);
    }, 120_000);

    it("still produces ONE kill when both sweeps LIST before either CLAIMS", async () => {
      // The case above passes even with the CAS predicate stripped, because the two sweeps
      // serialize: the first finishes its kill before the second lists, so the second sees
      // nothing. A race test that cannot observe a double-kill proves nothing — verified by
      // mutation, which is why this second case exists.
      //
      // Here a two-party barrier holds BOTH sweeps inside `listTerminalUncleanedLeases` until
      // each has read the row, then releases them together. From that point only the
      // compare-and-swap can stop them both killing.
      guard();
      await seedStranded();

      let kills = 0;
      const provider: SandboxRuntimeProvider = {
        provider: "e2b",
        acquireLease: async () => { throw new Error("not used"); },
        releaseLease: async () => { kills++; return { cleanupStatus: "success" as const }; },
        execute: async () => { throw new Error("not used"); },
      } as unknown as SandboxRuntimeProvider;

      let arrived = 0;
      let release!: () => void;
      const bothListed = new Promise<void>((resolve) => { release = resolve; });
      const barrieredEnvironments = () => {
        const real = environmentService(db);
        return new Proxy(real, {
          get(target, prop, receiver) {
            if (prop !== "listTerminalUncleanedLeases") return Reflect.get(target, prop, receiver);
            return async (...args: unknown[]) => {
              const rows = await (target.listTerminalUncleanedLeases as (...a: unknown[]) => Promise<unknown[]>)(...args);
              arrived += 1;
              if (arrived >= 2) release();
              await bothListed;
              return rows;
            };
          },
        }) as ReturnType<typeof environmentService>;
      };

      const racedSweep = () => sweepIdleWarmSandboxes(db, {
        environments: barrieredEnvironments(),
        sandboxProviders: [provider],
        runtimeProviderKeys: { resolveCredential: async () => "fake-key" },
        getExperimental: async () => ({ enableWarmSandboxReaper: true, warmSandboxIdleTtlMinutes: 30 }),
        readKillSwitchDocument: async () => undefined,
        currentKeyGeneration: async () => null,
      });

      const [a, b] = await Promise.all([racedSweep(), racedSweep()]);

      expect(arrived, "the barrier must actually have held both sweeps").toBe(2);
      expect(kills, "both sweeps held the same row and only the CAS separates them").toBe(1);
      expect(a.reaped + b.reaped).toBe(1);
    }, 120_000);

    it("leaves a CLEANED row alone — non-vacuity for the race above", async () => {
      guard();
      await seedStranded();
      await db.execute(sql`UPDATE environment_leases SET cleanup_status = 'success' WHERE id = ${LEASE}`);

      let kills = 0;
      const provider: SandboxRuntimeProvider = {
        provider: "e2b",
        acquireLease: async () => { throw new Error("not used"); },
        releaseLease: async () => { kills++; return { cleanupStatus: "success" as const }; },
        execute: async () => { throw new Error("not used"); },
      } as unknown as SandboxRuntimeProvider;

      const result = await sweepIdleWarmSandboxes(db, {
        environments: environmentService(db),
        sandboxProviders: [provider],
        runtimeProviderKeys: { resolveCredential: async () => "fake-key" },
        getExperimental: async () => ({ enableWarmSandboxReaper: true, warmSandboxIdleTtlMinutes: 30 }),
        readKillSwitchDocument: async () => undefined,
        currentKeyGeneration: async () => null,
      });

      expect(kills).toBe(0);
      expect(result.reaped).toBe(0);
    }, 120_000);
  },
);
