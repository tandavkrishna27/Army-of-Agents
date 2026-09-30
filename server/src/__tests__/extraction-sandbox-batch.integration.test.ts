/**
 * U13.3 — real-Postgres proof that `extractThreadEntriesAwait` acquires ONE
 * sandbox for the WHOLE batch (not one per entry), reuses it across every
 * entry in the pass, releases it exactly once after the loop, and that the
 * acquire happens BEFORE the per-entry deadline clock starts (acquire
 * latency is never charged against `EXTRACT_SCOPE_DEADLINE_MS`).
 *
 * REAL-SHAPE NOTE (deviation from the plan's "fake sandbox provider at the
 * importE2b seam"): that seam is `import("e2b")` inside
 * `createE2bSandboxRuntimeProvider` (sandbox-provider-runtime.ts) — faking it
 * would require reconstructing the full E2B SDK surface (Sandbox.create,
 * commands.run, files.write/remove, ...) AND still would not let this test
 * assert "acquireExecutionContext called exactly once" or control acquire
 * LATENCY (needed for the deadline proof), since nothing wraps that call in a
 * spy. `extraction.ts`'s production code calls `acquireExecutionContext(db,
 * input)` directly (no DI parameter, matching U13.1's `one-shot-sandbox-cli
 * .ts` and every other real call site — heartbeat.ts, aoa-agents/runner.ts).
 * The two integration tests the plan pointed at
 * (acquire-execution-context.integration.test.ts,
 * platform-default-environment-materialization.integration.test.ts) ALSO
 * don't use importE2b — they inject a fake sandbox provider via
 * `environmentRuntimeService(db, { sandboxProviders: [...] })` threaded
 * through a custom `environmentRunOrchestrator`, which is only reachable
 * because THEIR test code constructs `acquireExecutionContext({orchestrator},
 * ...)` directly — that DI seam isn't available from inside extraction.ts's
 * own unconditional `acquireExecutionContext(db, ...)` call either.
 *
 * This test instead mocks the sandbox-acquisition LEAF modules
 * (`acquire-execution-context.js` fully; `environment-runtime.js` and
 * `sandbox-provider-runtime.js` via `importOriginal` so every other real
 * export — used by other reachable code paths — stays intact) while leaving
 * everything else real: a real embedded-Postgres company/discussion/entries,
 * the REAL `extractThreadEntriesAwait` + `extractFromDiscussionEntry` control
 * flow, and real `discussion_extracted_items` rows. `extraction-engine.js`
 * and `one-shot-provider-credential.js` are mocked the same way U13.2's
 * extraction-cli-sandbox-env.test.ts mocks them (deterministic CLI-tool
 * resolution + credential, no PATH probing). `one-shot-sandbox-cli.js` is
 * mocked so no CLI actually spawns (canned parseable stdout) — the
 * `sandboxHandle`-forwarding/env-allowlist plumbing through that seam is
 * already unit-proven (extraction-cli-sandbox-env.test.ts, U13.2;
 * one-shot-sandbox-cli.test.ts, U13.1). This test's OWN job is the BATCH
 * acquire/release counting + acquire-before-deadline timing, which only a
 * spied `acquireExecutionContext` + an injectable clock can prove.
 *
 * Skipped on Windows by default (embedded-postgres can't start on the CI
 * runner — Issue #114); set AOA_RUN_WIN_INTEGRATION=1 on a Windows dev box to
 * force-run it (verified locally for this task, then reverted to the default
 * skip before commit).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { setDeploymentMode, getDeploymentMode } from "../config/deployment-mode.js";
import { EXTRACT_SCOPE_DEADLINE_MS } from "../services/extraction.js";

// ── leaf mocks (see REAL-SHAPE NOTE above) ──────────────────────────────────

vi.mock("../services/extraction-engine.js", () => ({
  resolveExtractionEngine: vi.fn(async () => "cli"),
  resolveCompanyCliTool: vi.fn(async () => "claude"),
}));

const FAKE_CREDENTIAL = {
  envName: "ANTHROPIC_API_KEY",
  value: "sk-co-secret",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};
vi.mock("../services/one-shot-provider-credential.js", () => ({
  resolveCompanyProviderCredential: vi.fn(async () => FAKE_CREDENTIAL),
}));

const mockRunOneShotCliInSandbox = vi.fn();
vi.mock("../services/one-shot-sandbox-cli.js", () => {
  class FakeOneShotSandboxError extends Error {
    readonly kind: string;
    constructor(message: string, kind: string) {
      super(message);
      this.name = "OneShotSandboxError";
      this.kind = kind;
    }
  }
  return {
    runOneShotCliInSandbox: (...a: unknown[]) => mockRunOneShotCliInSandbox(...a),
    OneShotSandboxError: FakeOneShotSandboxError,
  };
});

const mockAcquireExecutionContext = vi.fn();
vi.mock("../services/acquire-execution-context.js", () => ({
  acquireExecutionContext: (...a: unknown[]) => mockAcquireExecutionContext(...a),
}));

const mockResolveRuntimeProviderConfig = vi.fn(async () => ({ provider: "e2b", resolvedApiKey: "fake" }));
// Wave 3 review (FIX 1, findings 1/2/3/7): the batch teardown
// (extraction.ts's `releaseSandboxHandle`) now routes through
// `environmentRuntimeService(db).releaseRunLease` instead of calling
// `sandboxProviderRuntime().releaseLease` directly — the raw provider call
// only killed the VM, it never flipped the `environment_leases` row to
// 'released'. This test's OWN job is the batch acquire/release COUNTING +
// acquire-before-deadline TIMING (see the file header) — the DB-flip
// mechanics of `releaseRunLease` itself are proven for real against
// Postgres by crew-lease-release.integration.test.ts (same call shape).
// So `environmentRuntimeService` is mocked here the same leaf-module way as
// `resolveRuntimeProviderConfig` above: spy on `releaseRunLease` directly
// rather than reconstructing a real environment_leases row for a lease
// object that (per the REAL-SHAPE NOTE above) is entirely synthetic
// (`fakeAcquisition`'s companyId:"irrelevant", non-persisted lease id).
const mockReleaseRunLease = vi.fn(async () => null);
vi.mock("../services/environment-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/environment-runtime.js")>();
  return {
    ...actual,
    resolveRuntimeProviderConfig: (...a: unknown[]) => mockResolveRuntimeProviderConfig(...a),
    environmentRuntimeService: (...args: unknown[]) => {
      const real = (actual.environmentRuntimeService as (...a: unknown[]) => Record<string, unknown>)(...args);
      return { ...real, releaseRunLease: (...a: unknown[]) => mockReleaseRunLease(...a) };
    },
  };
});

import { companyService } from "../services/companies.js";
import { extractionService } from "../services/extraction.js";
// U13.4: NOT mocked (unlike one-shot-sandbox-cli.js above) — this test proves
// the REAL recordOneShotCliCost path against real Postgres. The fake
// runOneShotCliInSandbox below stands in for "spawn a CLI in a sandbox" but
// still performs the "record cost" side effect the real implementation would
// perform on a successful run (one-shot-sandbox-cli.ts, U13.4), since that
// whole module is mocked away for this file's sandbox-batch assertions.
import { recordOneShotCliCost } from "../services/one-shot-cli-budget.js";
// Wave 3 review (FIX 2, MEDIUM — budget bypass): the batch acquire in
// extraction.ts is now gated by `preflightOneShotCliSpend` BEFORE it boots
// a VM. Mocked the same leaf-module way as the others above (spread real +
// override), so `recordOneShotCliCost` (imported from the SAME module
// above, real/unmocked) keeps working end-to-end.
const mockPreflightOneShotCliSpend = vi.fn(async () => ({ allowed: true }) as const);
vi.mock("../services/one-shot-cli-budget.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/one-shot-cli-budget.js")>();
  return {
    ...actual,
    preflightOneShotCliSpend: (...a: unknown[]) => mockPreflightOneShotCliSpend(...a),
  };
});

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

const PORT = 61900 + Math.floor(Math.random() * 300);

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-esb-"));
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
  } catch (e) {
    setupError = e;
    // eslint-disable-next-line no-console
    console.error("[extraction-sandbox-batch] embedded-postgres setup failed:", e);
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

const savedDeploymentMode = getDeploymentMode();
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  setDeploymentMode(savedDeploymentMode);
});

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  return ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []) as Array<Record<string, unknown>>;
}

/** companyService.create() derives issue_prefix from the first 3 A-Z letters
 *  of `name` (deriveIssuePrefixBase, companies.ts) — a shared literal prefix
 *  like "ESB " swallows every label's distinguishing letters (all resolve to
 *  "ESB", colliding on companies_issue_prefix_idx across this file's 3
 *  `it` blocks, which share ONE embedded-postgres instance). Lead with a
 *  random alphabetic token instead so every seeded company gets a unique
 *  prefix regardless of label similarity. */
function randomPrefixSafeWord(): string {
  const hex = randomUUID().replace(/-/g, "");
  const letters = (hex.replace(/[^a-f]/g, "") + "XXX").toUpperCase();
  return letters.slice(0, 3);
}

/** Mirrors w2-extract-then-scope.integration.test.ts's seedCompanyAndAgent:
 *  a real company + a founder user (hub-item emission throws without one). */
async function seedCompanyWithFounder(label: string): Promise<{ companyId: string }> {
  const company = await companyService(db).create({ organizationId: "00000000-0000-0000-0000-000000000001",
    name: `${randomPrefixSafeWord()} ${label} Co`,
  } as never);
  const companyId = company.id;
  const founderUserId = `founder-${randomUUID()}`;
  await db.execute(sql`
    INSERT INTO "user" (id, name, email, created_at, updated_at)
    VALUES (${founderUserId}, ${`Founder ${label}`}, ${`${founderUserId}@example.test`}, now(), now())
  `);
  await db.execute(sql`
    INSERT INTO user_roles (id, company_id, user_id, role)
    VALUES (gen_random_uuid(), ${companyId}, ${founderUserId}, 'founder')
  `);
  return { companyId };
}

/** Seed a thread with N never-extracted, human-authored, sufficiently-long entries. */
async function seedThreadWithEntries(
  companyId: string,
  texts: string[],
): Promise<{ threadId: string; entryIds: string[] }> {
  const [thread] = rowsOf(
    await db.execute(sql`
      INSERT INTO discussions (id, company_id, status, created_by, entry_seq)
      VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test', ${texts.length})
      RETURNING id
    `),
  );
  const threadId = String(thread.id);

  const entryIds: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    const [entry] = rowsOf(
      await db.execute(sql`
        INSERT INTO discussion_entries (id, discussion_id, input_type, raw_content, created_by, seq, extraction_status)
        VALUES (gen_random_uuid(), ${threadId}, 'write', ${texts[i]}, 'human-user', ${i + 1}, 'pending')
        RETURNING id
      `),
    );
    entryIds.push(String(entry.id));
  }
  return { threadId, entryIds };
}

/** A minimal but shape-real AcquiredExecutionContext (S1/S5/S6 fields the
 *  batch-acquire code in extraction.ts actually reads). */
function fakeAcquisition(leaseId: string) {
  const environment = {
    id: `env-${leaseId}`,
    companyId: "irrelevant",
    name: "platform default",
    description: null,
    driver: "sandbox" as const,
    status: "active" as const,
    config: { provider: "e2b", template: "base" },
    metadata: null,
    envVars: {},
    connectionTarget: null,
    target: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const lease = {
    id: leaseId,
    companyId: "irrelevant",
    environmentId: environment.id,
    executionWorkspaceId: null,
    issueId: null,
    heartbeatRunId: null,
    status: "active" as const,
    leasePolicy: "ephemeral" as const,
    provider: "e2b",
    providerLeaseId: `plid-${leaseId}`,
    acquiredAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    expiresAt: null,
    releasedAt: null,
    failureReason: null,
    cleanupStatus: null,
    metadata: { providerMetadata: {} },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return {
    sandbox: { environment, lease, leaseContext: {}, adapterType: "claude_local", configPatch: {} },
    lease,
    warmResolved: false,
  };
}

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "extractThreadEntriesAwait — sandbox-per-batch (U13.3)",
  () => {
    it("acquires ONE sandbox for 3 entries, reuses the SAME handle, releases exactly once (reuseLease:false) after the loop", async () => {
      if (setupError) throw new Error(String(setupError));
      setDeploymentMode("cloud_auth");

      const { companyId } = await seedCompanyWithFounder("BatchOnce");
      const { threadId } = await seedThreadWithEntries(companyId, [
        "First entry: build the export pipeline.",
        "Second entry: ship the billing exporter next.",
        "Third entry: draft the SSO comms plan for customers.",
      ]);

      mockAcquireExecutionContext.mockResolvedValueOnce(fakeAcquisition("lease-batch-once"));
      // U13.4: the fake also performs the REAL cost-recording side effect a
      // successful runOneShotCliInSandbox call would perform, so this test
      // can prove the cost_events row lands end-to-end (real Postgres,
      // agentId:null, company rollup) once per entry (3 calls -> 3 rows) —
      // the sandbox-spawn itself is faked, but billing is not.
      mockRunOneShotCliInSandbox.mockImplementation(async (input: unknown) => {
        const { companyId: costCompanyId } = input as { companyId: string };
        await recordOneShotCliCost(db, {
          companyId: costCompanyId,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          inputTokens: 500,
          outputTokens: 120,
          source: "extraction",
        });
        return {
          stdout: JSON.stringify([{ type: "task", title: "Extracted task" }]),
          stderr: "",
          exitCode: 0,
          durationMs: 5,
        };
      });

      const result = await extractionService(db).extractThreadEntriesAwait(companyId, threadId);

      expect(result.attempted).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.deadlineHit).toBe(false);

      // (1) All 3 entries got real extracted items in real Postgres.
      const items = rowsOf(
        await db.execute(sql`
          SELECT dei.discussion_entry_id FROM discussion_extracted_items dei
          JOIN discussion_entries de ON de.id = dei.discussion_entry_id
          WHERE de.discussion_id = ${threadId}
        `),
      );
      expect(items).toHaveLength(3);
      const statuses = rowsOf(
        await db.execute(sql`
          SELECT extraction_status FROM discussion_entries WHERE discussion_id = ${threadId}
        `),
      );
      expect(statuses.every((r) => String(r.extraction_status) === "completed")).toBe(true);

      // (2) acquireExecutionContext called EXACTLY ONCE — one sandbox per
      // batch, not per entry (entries 2 and 3 ran on the reused handle).
      expect(mockAcquireExecutionContext).toHaveBeenCalledTimes(1);

      // (3) runOneShotCliInSandbox received the SAME sandboxHandle object on
      // every call (entries 2/3 reuse the exact handle from the batch
      // acquire — not a re-acquired/rebuilt one).
      expect(mockRunOneShotCliInSandbox).toHaveBeenCalledTimes(3);
      const handles = mockRunOneShotCliInSandbox.mock.calls.map(
        (call) => (call[0] as { sandboxHandle?: unknown }).sandboxHandle,
      );
      expect(handles[0]).toBeDefined();
      expect(handles[1]).toBe(handles[0]);
      expect(handles[2]).toBe(handles[0]);

      // (4) The batch lease is released EXACTLY ONCE, after the whole loop,
      // via environmentRuntimeService(db).releaseRunLease (Wave 3 review,
      // FIX 1 — the DB-flip path, not the raw provider releaseLease which
      // only killed the VM and left the environment_leases row 'active').
      expect(mockReleaseRunLease).toHaveBeenCalledTimes(1);
      const [releaseInput] = mockReleaseRunLease.mock.calls[0] as [
        { environment: { id: string }; lease: { id: string; providerLeaseId: string }; status: string },
      ];
      expect(releaseInput.status).toBe("released");
      expect(releaseInput.lease.id).toBe("lease-batch-once");
      expect(releaseInput.lease.providerLeaseId).toBe("plid-lease-batch-once");

      // (5) U13.4: a cost_events row lands per successful one-shot CLI call
      // (one per entry, 3 entries -> 3 rows) — agentId:null (nullable
      // migration), company-scoped, billingType carries the "extraction"
      // source label.
      const costRows = rowsOf(
        await db.execute(sql`
          SELECT agent_id, company_id, billing_type, cost_cents, provider, model
          FROM cost_events WHERE company_id = ${companyId}
        `),
      );
      expect(costRows).toHaveLength(3);
      for (const row of costRows) {
        expect(row.agent_id).toBeNull();
        expect(String(row.company_id)).toBe(companyId);
        expect(row.billing_type).toBe("extraction");
        expect(Number(row.cost_cents)).toBeGreaterThanOrEqual(0);
      }
    }, 120_000);

    it("the batch acquire happens BEFORE the deadline clock: a slow (250s) acquire does not eat into any entry's per-entry deadline budget", async () => {
      if (setupError) throw new Error(String(setupError));
      setDeploymentMode("cloud_auth");

      const { companyId } = await seedCompanyWithFounder("BatchDeadline");
      const { threadId } = await seedThreadWithEntries(companyId, [
        "First entry: rework the ingestion retry queue.",
        "Second entry: refit the auth flow for SSO.",
        "Third entry: stand up the churn-alert pipeline.",
      ]);

      // Simulated acquire latency EXCEEDS EXTRACT_SCOPE_DEADLINE_MS (180s) —
      // 250s. If `startedAt` were (incorrectly) captured BEFORE the acquire,
      // every entry after the first would see now() - startedAt > 250_000 >
      // EXTRACT_SCOPE_DEADLINE_MS and the pass would truncate at entry 1
      // (deadlineHit: true, attempted: 1). Because U13.3 acquires BEFORE
      // `startedAt = now()`, the clock only starts ticking AFTER acquire
      // resolves, so all 3 entries get their full per-entry budget and none
      // of this simulated latency is ever charged against the deadline.
      const ACQUIRE_SIMULATED_MS = EXTRACT_SCOPE_DEADLINE_MS + 70_000; // 250s
      let clock = 5_000_000;
      const now = () => clock;
      mockAcquireExecutionContext.mockImplementationOnce(async () => {
        clock += ACQUIRE_SIMULATED_MS;
        return fakeAcquisition("lease-batch-deadline");
      });
      mockRunOneShotCliInSandbox.mockImplementation(async () => ({
        stdout: JSON.stringify([{ type: "task", title: "Extracted task" }]),
        stderr: "",
        exitCode: 0,
        durationMs: 5,
      }));

      const result = await extractionService(db).extractThreadEntriesAwait(companyId, threadId, { now });

      expect(mockAcquireExecutionContext).toHaveBeenCalledTimes(1);
      expect(result.attempted).toBe(3);
      expect(result.deadlineHit).toBe(false);
      expect(result.failed).toBe(0);

      const items = rowsOf(
        await db.execute(sql`
          SELECT dei.discussion_entry_id FROM discussion_extracted_items dei
          JOIN discussion_entries de ON de.id = dei.discussion_entry_id
          WHERE de.discussion_id = ${threadId}
        `),
      );
      expect(items).toHaveLength(3);

      expect(mockReleaseRunLease).toHaveBeenCalledTimes(1);
    }, 120_000);

    it("acquire failure: every entry self-acquires (no batch handle) and surfaces its own failure — the pass never throws", async () => {
      if (setupError) throw new Error(String(setupError));
      setDeploymentMode("cloud_auth");

      const { companyId } = await seedCompanyWithFounder("BatchAcquireFail");
      const { threadId } = await seedThreadWithEntries(companyId, [
        "Only entry: the batch sandbox acquire will fail for this pass.",
      ]);

      mockAcquireExecutionContext.mockRejectedValueOnce(new Error("no platform default resolved"));
      // The per-entry self-acquire path (extractViaCli -> runOneShotCliInSandbox)
      // is EXERCISED here too (sandboxHandle undefined) — also made to fail,
      // proving the entry terminalizes failed rather than throwing out of
      // extractThreadEntriesAwait.
      mockRunOneShotCliInSandbox.mockRejectedValue(
        Object.assign(new Error("No isolated sandbox environment is available for this company."), {
          name: "OneShotSandboxError",
          kind: "sandbox_unavailable",
        }),
      );

      const result = await extractionService(db).extractThreadEntriesAwait(companyId, threadId);

      expect(mockAcquireExecutionContext).toHaveBeenCalledTimes(1);
      // The self-acquire fallback path is per-entry (sandboxHandle undefined) —
      // exactly one call for the one seeded entry.
      expect(mockRunOneShotCliInSandbox).toHaveBeenCalledTimes(1);
      const [selfAcquireCall] = mockRunOneShotCliInSandbox.mock.calls[0] as [{ sandboxHandle?: unknown }];
      expect(selfAcquireCall.sandboxHandle).toBeUndefined();

      expect(result.attempted).toBe(1);
      expect(result.failed).toBe(1);
      // No batch handle was ever built -> nothing to release.
      expect(mockReleaseRunLease).not.toHaveBeenCalled();
    }, 120_000);

    it("Wave 3 review (FIX 2, MEDIUM — budget bypass): an over-budget company skips the batch sandbox acquire entirely — preflightOneShotCliSpend blocks BEFORE acquireExecutionContext, no VM boots", async () => {
      if (setupError) throw new Error(String(setupError));
      setDeploymentMode("cloud_auth");

      const { companyId } = await seedCompanyWithFounder("BatchOverBudget");
      const { threadId } = await seedThreadWithEntries(companyId, [
        "Only entry: the company is over its monthly one-shot CLI budget cap.",
      ]);

      mockPreflightOneShotCliSpend.mockResolvedValueOnce({
        allowed: false,
        reason: `One-shot CLI budget reached for company ${companyId} (spend: 10500, cap: 10000)`,
        reasonCode: "budget_exhausted",
      });
      // Each entry's own self-acquire preflight (inside the REAL
      // runOneShotCliInSandbox, mocked away for this file) would ALSO
      // block on the SAME gate — surfaced here via the mocked
      // runOneShotCliInSandbox throwing the identical sandbox_unavailable
      // shape a real per-entry preflight-blocked call throws
      // (one-shot-sandbox-cli.ts).
      mockRunOneShotCliInSandbox.mockRejectedValue(
        Object.assign(
          new Error("One-shot CLI spawn blocked before any sandbox spend: over budget"),
          { name: "OneShotSandboxError", kind: "sandbox_unavailable" },
        ),
      );

      const result = await extractionService(db).extractThreadEntriesAwait(companyId, threadId);

      expect(mockPreflightOneShotCliSpend).toHaveBeenCalledTimes(1);
      expect(mockPreflightOneShotCliSpend.mock.calls[0]?.[1]).toMatchObject({ companyId });

      // FIX 2: the batch VM never boots when the company is over budget.
      expect(mockAcquireExecutionContext).not.toHaveBeenCalled();
      // Nothing was ever acquired -> nothing to release.
      expect(mockReleaseRunLease).not.toHaveBeenCalled();

      // The entry still falls through to its own self-acquire attempt
      // (sandboxHandle undefined) and fails gracefully — the pass itself
      // never throws.
      expect(mockRunOneShotCliInSandbox).toHaveBeenCalledTimes(1);
      const [selfAcquireCall] = mockRunOneShotCliInSandbox.mock.calls[0] as [{ sandboxHandle?: unknown }];
      expect(selfAcquireCall.sandboxHandle).toBeUndefined();

      expect(result.attempted).toBe(1);
      expect(result.failed).toBe(1);
    }, 120_000);
  },
);
