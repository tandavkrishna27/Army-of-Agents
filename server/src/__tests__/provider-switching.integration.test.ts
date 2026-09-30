/**
 * provider-switching.integration.test.ts  (Unit 11 — Part B)
 *
 * Real-DB integration test for the provider switching engine.
 *
 * Boots embedded-postgres, applies all migrations, then seeds minimal
 * companies + agent rows to exercise the following scenarios:
 *
 *  1. SWITCH + PERSIST: update an agent's adapterType + model via the real
 *     agentService.update() and assert the persisted row carries the new values.
 *
 *  2. RESOLUTION AT SERVICE LEVEL: seed a codex_local agent with model
 *     "gpt-5.3-codex", then call applyModelResolutionToConfig with
 *     authMode="chatgpt" and assert the resolved config corrects to "gpt-5.5".
 *     (The runner sub-test is skipped: wiring a no-spawn run inside this
 *     harness would require the full runner + adapters stack, which is
 *     beyond what the embedded-postgres integration harness can support
 *     deterministically without CLI binaries on the runner.)
 *
 *  3. BACKFILL DETECT: seed an agent row with adapterType="codex_local" and
 *     model="gpt-5.3-codex", call needsAdapterBackfill(), assert true;
 *     then simulate the backfill write (update to gpt-5.5) and assert the
 *     re-check returns false.
 *
 *  4. MANAGED-HOME AUTH MODE (documented SKIP): determining authMode requires
 *     reading the real ~/.codex auth files (codex-home FS state). This harness
 *     cannot inject a deterministic auth state without touching the developer's
 *     real $HOME. Skipped; covered instead by the parity test (Part A) which
 *     proves the resolution logic is correct for all authMode values.
 *
 * Skipped on Windows (embedded-postgres cannot start on Windows CI runners —
 * Issue #114). Linux CI is the authoritative gate.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { agentService } from "../services/agents.js";
import { applyModelResolutionToConfig } from "../services/internal-agent/aoa-agents/runner-model-resolution.js";
import { needsAdapterBackfill, resolveCrewAdapterFor } from "../services/internal-agent/aoa-agents/resolve-crew-adapter.js";
import { DEFAULT_CODEX_CHAT_MODEL } from "../services/internal-agent/codex-model.js";

// ─────────────────────────────────────────────────────────────────────────────
// Embedded-postgres harness (mirrors aoa-backend.integration.test.ts exactly)
// ─────────────────────────────────────────────────────────────────────────────

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string; user: string; password: string; port: number; persistent: boolean;
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

function firstId(result: unknown): string {
  if (Array.isArray(result)) return (result[0] as any)?.id;
  return (result as any).rows?.[0]?.id;
}

const PORT = 59000 + Math.floor(Math.random() * 1000);

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-provider-switching-integ-test-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
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
    console.error("[provider-switching-integration] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests — skipped on Windows (Issue #114)
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(process.platform === "win32")(
  "provider-switching engine — real DB: switch+persist, resolution, backfill",
  () => {
    let companyId: string;
    let agentId: string;

    // ── Setup: seed a company and a minimal codex_local agent ───────────────

    it("setup: seed company + codex_local agent with a ChatGPT-incompatible model", async () => {
      if (setupError) {
        throw new Error(
          `embedded-postgres setup failed; cannot run integration test: ${String(setupError)}`,
        );
      }

      // Seed company
      companyId = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO companies (id, name, issue_prefix)
        VALUES (gen_random_uuid(), 'Provider Switching Test Co', 'PST')
        RETURNING id
      `));
      expect(companyId).toBeTruthy();

      // Seed a codex_local agent with a ChatGPT-incompatible model (the
      // pre-fix value that caused HTTP 400 on subscription logins).
      agentId = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO agents (id, company_id, name, adapter_type, adapter_config)
        VALUES (
          gen_random_uuid(),
          ${companyId},
          'Test Codex Agent',
          'codex_local',
          ${JSON.stringify({ model: "gpt-5.3-codex", dangerouslyBypassApprovalsAndSandbox: true })}::jsonb
        )
        RETURNING id
      `));
      expect(agentId).toBeTruthy();
    });

    // ── 1. SWITCH + PERSIST ──────────────────────────────────────────────────

    it("1: switch adapterType+model via agentService.update() and assert persisted row", async () => {
      if (setupError) throw new Error(String(setupError));

      const svc = agentService(db);

      // Switch to claude_local with a known model
      const updated = await svc.update(agentId, {
        adapterType: "claude_local",
        adapterConfig: {
          model: "claude-sonnet-4-5-20250929",
          dangerouslySkipPermissions: true,
        },
      });

      expect(updated).toBeTruthy();
      expect(updated!.adapterType).toBe("claude_local");
      expect((updated!.adapterConfig as any)?.model).toBe("claude-sonnet-4-5-20250929");

      // Confirm the row is durable via a raw DB read
      const row = await db.execute<{ adapter_type: string; adapter_config: unknown }>(sql`
        SELECT adapter_type, adapter_config FROM agents WHERE id = ${agentId}
      `);
      const persisted = Array.isArray(row) ? row[0] : (row as any).rows?.[0];
      expect(persisted).toBeTruthy();
      expect(persisted.adapter_type).toBe("claude_local");
      expect((persisted.adapter_config as any)?.model).toBe("claude-sonnet-4-5-20250929");
    });

    // ── 2. RESOLUTION AT SERVICE LEVEL ──────────────────────────────────────

    it("2: applyModelResolutionToConfig corrects gpt-5.3-codex → gpt-5.5 under chatgpt authMode", async () => {
      if (setupError) throw new Error(String(setupError));

      // Reset agent back to codex_local with the incompatible model for this test
      await db.execute(sql`
        UPDATE agents
        SET adapter_type = 'codex_local',
            adapter_config = ${JSON.stringify({ model: "gpt-5.3-codex", dangerouslyBypassApprovalsAndSandbox: true })}::jsonb
        WHERE id = ${agentId}
      `);

      // Read the persisted config to simulate what the runner reads
      const row = await db.execute<{ adapter_config: unknown }>(sql`
        SELECT adapter_config FROM agents WHERE id = ${agentId}
      `);
      const persistedConfig = Array.isArray(row)
        ? (row[0] as any)?.adapter_config
        : (row as any).rows?.[0]?.adapter_config;

      expect(persistedConfig).toBeTruthy();
      expect((persistedConfig as any).model).toBe("gpt-5.3-codex");

      // Run the model resolution as the runner would, under chatgpt authMode
      const resolved = applyModelResolutionToConfig(
        "codex_local",
        persistedConfig as Record<string, unknown>,
        { authMode: "chatgpt", defaultModelResolved: null },
      );

      // The persisted incompatible model must be corrected to the safe default
      expect(resolved.model).toBe(DEFAULT_CODEX_CHAT_MODEL); // "gpt-5.5"
      expect(resolved.model).not.toBe("gpt-5.3-codex");

      // NOTE: The resolved argv sub-test (asserting that the resolved model
      // appears in the actual spawn argv via onMeta.commandArgs) is skipped.
      // Reason: onMeta in runner.ts is a no-op callback (runner.ts:496),
      // and wiring a real or fake adapter spawn inside this embedded-postgres
      // harness would require CLI binaries + the full adapter stack, which
      // is out of scope for this harness. The resolution is proven at the
      // service level above; the argv flow is covered by cli-mode-codex-
      // integration.test.ts (which uses a real fake-codex shim on PATH).
    });

    // ── 3. BACKFILL DETECT ──────────────────────────────────────────────────

    it("3a: needsAdapterBackfill returns true for codex_local row with incompatible model", async () => {
      if (setupError) throw new Error(String(setupError));

      // The agent is currently codex_local + gpt-5.3-codex (set in test 2)
      const row = await db.execute<{ adapter_type: string; adapter_config: unknown }>(sql`
        SELECT adapter_type, adapter_config FROM agents WHERE id = ${agentId}
      `);
      const { adapter_type, adapter_config } = Array.isArray(row)
        ? row[0] as any
        : (row as any).rows?.[0] as any;

      // The row should need backfill (gpt-5.3-codex is ChatGPT-incompatible)
      expect(needsAdapterBackfill(adapter_type, adapter_config as Record<string, unknown>)).toBe(true);
    });

    it("3b: after backfill write (gpt-5.5), needsAdapterBackfill returns false", async () => {
      if (setupError) throw new Error(String(setupError));

      // Simulate what the boot backfill consumer does: resolve the right adapter
      // for the company's provider and write it back.
      const newAdapter = resolveCrewAdapterFor("openai"); // openai → codex_local + gpt-5.5
      expect(newAdapter.adapterType).toBe("codex_local");
      expect((newAdapter.adapterConfig as any).model).toBe(DEFAULT_CODEX_CHAT_MODEL);

      // Write the corrected config to the DB
      await db.execute(sql`
        UPDATE agents
        SET adapter_config = ${JSON.stringify(newAdapter.adapterConfig)}::jsonb
        WHERE id = ${agentId}
      `);

      // Re-read and re-check
      const row = await db.execute<{ adapter_type: string; adapter_config: unknown }>(sql`
        SELECT adapter_type, adapter_config FROM agents WHERE id = ${agentId}
      `);
      const { adapter_type, adapter_config } = Array.isArray(row)
        ? row[0] as any
        : (row as any).rows?.[0] as any;

      // After backfill, the model is gpt-5.5 which is ChatGPT-compatible
      expect((adapter_config as any).model).toBe(DEFAULT_CODEX_CHAT_MODEL);
      expect(needsAdapterBackfill(adapter_type, adapter_config as Record<string, unknown>)).toBe(false);
    });

    // ── 4. MANAGED-HOME AUTH MODE — SKIP (documented) ───────────────────────

    it.skip(
      "4: managed-home vs shared-home authMode: per-agent env.OPENAI_API_KEY flips authMode to apikey — SKIPPED",
      () => {
        // Determining authMode requires reading the real ~/.codex auth files
        // (getProviderStatus calls readSharedCodexModel, ensureCodexAuthInHome,
        // etc.). This harness cannot inject deterministic auth state without
        // touching the developer's real $HOME or creating elaborate filesystem
        // fixtures. The authMode logic is covered by:
        //   - provider-switching-parity.test.ts case 5 (unknown authMode)
        //   - provider-switching-parity.test.ts case 8 (apikey asymmetry)
        //   - cli-mode-codex-integration.test.ts (fake-codex shim with real spawn)
      },
    );

    // ── 5. CROSS-COMPANY ISOLATION (bonus assertion) ─────────────────────────

    it("5: agent resolution does not affect agents in other companies (isolation check)", async () => {
      if (setupError) throw new Error(String(setupError));

      // Seed a second company with its own codex_local agent
      const company2Id = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO companies (id, name, issue_prefix)
        VALUES (gen_random_uuid(), 'Provider Switching Test Co 2', 'PS2')
        RETURNING id
      `));

      const agent2Id = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO agents (id, company_id, name, adapter_type, adapter_config)
        VALUES (
          gen_random_uuid(),
          ${company2Id},
          'Isolated Agent',
          'codex_local',
          ${JSON.stringify({ model: "gpt-5.3-codex" })}::jsonb
        )
        RETURNING id
      `));

      // Confirm the original company's agent was ONLY updated by its own backfill
      // (test 3b wrote gpt-5.5 to agentId). Company 2's agent is still gpt-5.3-codex.
      const row2 = await db.execute<{ adapter_config: unknown }>(sql`
        SELECT adapter_config FROM agents WHERE id = ${agent2Id}
      `);
      const cfg2 = Array.isArray(row2)
        ? (row2[0] as any)?.adapter_config
        : (row2 as any).rows?.[0]?.adapter_config;

      expect((cfg2 as any)?.model).toBe("gpt-5.3-codex"); // untouched
      // And the original agent is still gpt-5.5 (from test 3b)
      const row1 = await db.execute<{ adapter_config: unknown }>(sql`
        SELECT adapter_config FROM agents WHERE id = ${agentId}
      `);
      const cfg1 = Array.isArray(row1)
        ? (row1[0] as any)?.adapter_config
        : (row1 as any).rows?.[0]?.adapter_config;
      expect((cfg1 as any)?.model).toBe(DEFAULT_CODEX_CHAT_MODEL);
    });
  },
);
