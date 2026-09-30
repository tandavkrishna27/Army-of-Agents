/**
 * W2 integration: extract-then-scope + kill the placeholder stub (D6).
 *
 * Real-Postgres proof that:
 *   - Case 1 (Adjutant path, real items): committing a create_scope_draft action
 *       compiles the scope draft from REAL extracted items (a seeded 'task' item
 *       becomes a task_proposal card with the item's own title), no dead-placeholder
 *       title ever appears, and the conservative extraction selection leaves an
 *       entry that already has extracted items COMPLETELY untouched (its
 *       extraction_status is unchanged — the founder-review-surface guard on real SQL).
 *   - Case 2 (Adjutant path, extraction attempted-and-failed): with zero extracted
 *       items and no usable extraction engine, the commit still succeeds but NO
 *       draft is minted (round-6 P2: a failed entry caps the range below its seq →
 *       no_entries) — the failed entry stays retryable by the next scoping pass and
 *       its content can never be consumed by an accepted range. The entry provably
 *       went through the attempt (sourceInfo.extractionError is recorded).
 *   - Case 3 (human default): createDraftFromThread called directly (no
 *       suppressFallbackTask) still synthesizes exactly ONE fallback task_proposal
 *       whose title is DERIVED from the actual entry content — the keyword stubs
 *       ("Implement real multi-message scope generation", ...) are dead.
 *
 * Each case runs in an isolated company / thread / agent triple so they are
 * fully independent despite sharing the same embedded-postgres instance.
 *
 * Determinism note (Case 1 + Case 2): dev machines often have the `claude` binary
 * on PATH (extraction would then spawn a REAL CLI — slow, non-deterministic, and
 * burning the developer's quota), while CI has none. To make the "no usable
 * engine" path deterministic on EVERY machine, the seeded company's
 * internal_agent_config.cli_tool is set to 'opencode' — a CLI that Commander chat
 * supports but extraction cannot drive (not in EXTRACTION_SUPPORTED_CLI_TOOLS),
 * so resolveExtractionEngine throws without ever probing PATH or spawning.
 *
 * Skipped on Windows (embedded-postgres / migration-chain issue — Issue #114);
 * Linux CI is the authoritative gate. Modeled on
 * w1c-inbox-dispatch-approval.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  type Db,
} from "@armyofagents/db";
import { companyService } from "../services/companies.js";
import { threadAgentActionService } from "../services/thread-agent-actions.js";
import { threadScopeVersionService } from "../services/thread-scope-versions.js";
import { captureFreshnessSnapshot } from "../services/thread-agent-action-freshness.js";

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
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

// Offset by +6 from W1c's 59603 range to avoid port collision if both run together.
const PORT = 59609 + Math.floor(Math.random() * 390);

// The dead keyword-stub titles W2 killed — plus the compiler's last-resort
// fallback string. NO scope item may ever carry one of these in these cases.
const DEAD_PLACEHOLDER_RE =
  /Implement real multi-message|Implement crew discussion|Turn discussion into|Scope work from this discussion/;

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  return ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []) as Array<
    Record<string, unknown>
  >;
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function seedCompanyAndAgent(label: string): Promise<{
  companyId: string;
  agentId: string;
}> {
  const company = await companyService(db).create({ name: `W2 ${label} Co` } as never);
  const companyId = company.id;

  // Seed a founder user + user_roles row. companyService.create() does NOT create a
  // human owner, but hub-item emission paths resolve an owner through
  // getFounderUserId() and THROW if the company has none. A real board-deployed
  // company always has a founder, so seed one here to keep the commit path's
  // best-effort emits realistic. (auth `user` table needs
  // id/name/email/created_at/updated_at; user_roles.userId FKs to it.)
  const founderUserId = `founder-${randomUUID()}`;
  await db.execute(sql`
    INSERT INTO "user" (id, name, email, created_at, updated_at)
    VALUES (${founderUserId}, ${`Founder ${label}`}, ${`${founderUserId}@example.test`}, now(), now())
  `);
  await db.execute(sql`
    INSERT INTO user_roles (id, company_id, user_id, role)
    VALUES (gen_random_uuid(), ${companyId}, ${founderUserId}, 'founder')
  `);

  // companyService.create() auto-seeds the AoA crew (incl. 'Engineer'); a second INSERT
  // would violate agents_aoa_name_per_company_idx. Reuse the seeded Engineer. Fall back
  // to an INSERT only if a future create() stops seeding crew.
  let engRows = rowsOf(
    await db.execute(sql`
      SELECT id FROM agents
      WHERE company_id = ${companyId} AND kind = 'aoa' AND name = 'Engineer' AND status <> 'terminated'
      LIMIT 1
    `),
  );
  if (engRows.length === 0) {
    engRows = rowsOf(
      await db.execute(sql`
        INSERT INTO agents (id, company_id, name, kind, status)
        VALUES (gen_random_uuid(), ${companyId}, 'Engineer', 'aoa', 'idle')
        RETURNING id
      `),
    );
  }
  return { companyId, agentId: String(engRows[0].id) };
}

/**
 * Force the company's extraction CLI to one extraction cannot drive.
 *
 * 'opencode' is recognized by detectCliTool for Commander CHAT but is NOT in
 * EXTRACTION_SUPPORTED_CLI_TOOLS, so resolveExtractionEngine treats it as
 * unavailable and throws WITHOUT probing PATH. This makes the "no usable
 * extraction engine" path deterministic on every machine — including dev
 * machines that have a real `claude` binary on PATH (which would otherwise be
 * spawned for a real, slow, non-deterministic LLM call mid-test).
 */
async function forceUnsupportedExtractionCli(companyId: string): Promise<void> {
  const updated = rowsOf(
    await db.execute(sql`
      UPDATE internal_agent_config SET cli_tool = 'opencode' WHERE company_id = ${companyId} RETURNING id
    `),
  );
  if (updated.length === 0) {
    // companyService.create() seeds internal_agent_config; this fallback only
    // fires if a future create() stops doing so.
    await db.execute(sql`
      INSERT INTO internal_agent_config (id, company_id, cli_tool)
      VALUES (gen_random_uuid(), ${companyId}, 'opencode')
    `);
  }
}

/**
 * Seed a thread + one prose discussion entry, optionally with one extracted item.
 * Modeled on W1c's seedThreadWithInsight but parameterized: W2's cases need
 * control over the entry text, its extraction_status, and whether any
 * discussion_extracted_items row exists (the conservative-selection pivot).
 */
async function seedThreadWithEntry(
  companyId: string,
  opts: {
    text: string;
    extractionStatus: string;
    item?: { type: string; title: string };
  },
): Promise<{ threadId: string; entryId: string; extractedItemId: string | null }> {
  const [thread] = rowsOf(
    await db.execute(sql`
      INSERT INTO discussions (id, company_id, status, created_by, entry_seq)
      VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test', 1)
      RETURNING id
    `),
  );
  const threadId = String(thread.id);

  const [entry] = rowsOf(
    await db.execute(sql`
      INSERT INTO discussion_entries (id, discussion_id, input_type, raw_content, created_by, seq, extraction_status)
      VALUES (gen_random_uuid(), ${threadId}, 'write', ${opts.text}, 'human-user', 1, ${opts.extractionStatus})
      RETURNING id
    `),
  );
  const entryId = String(entry.id);

  let extractedItemId: string | null = null;
  if (opts.item) {
    // Deterministic stand-in for a completed extraction. status='pending' +
    // null resultTaskId + null resultMemoryId → the scope compiler picks it up.
    const [extractedItem] = rowsOf(
      await db.execute(sql`
        INSERT INTO discussion_extracted_items
          (id, discussion_entry_id, type, title, status)
        VALUES
          (gen_random_uuid(), ${entryId}, ${opts.item.type}, ${opts.item.title}, 'pending')
        RETURNING id
      `),
    );
    extractedItemId = String(extractedItem.id);
  }

  return { threadId, entryId, extractedItemId };
}

async function seedRun(companyId: string): Promise<string> {
  const [run] = rowsOf(
    await db.execute(sql`
      INSERT INTO internal_agent_runs (id, company_id, trigger_type, trigger_source)
      VALUES (gen_random_uuid(), ${companyId}, 'event', 'integration-test')
      RETURNING id
    `),
  );
  return String(run.id);
}

/**
 * Set the thread's autonomy_level column (0=Manual, 1=Assist, 2=Drive).
 * All W2 cases run at Manual so the W1b/W1c auto-accept + approval machinery
 * stays entirely out of the way.
 */
async function setThreadAutonomy(threadId: string, level: number): Promise<void> {
  await db.execute(sql`
    UPDATE discussions SET autonomy_level = ${level} WHERE id = ${threadId}
  `);
}

/** Insert a ready create_scope_draft action and return its id. */
async function seedScopeDraftAction(input: {
  companyId: string;
  threadId: string;
  runId: string;
  agentId: string;
  payload: Record<string, unknown>;
  keyPrefix: string;
}): Promise<string> {
  const snap = await captureFreshnessSnapshot(db as never, input.threadId);
  const actionId = randomUUID();
  await db.execute(sql`
    INSERT INTO thread_agent_actions
      (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
    VALUES
      (${actionId}, ${input.companyId}, ${input.threadId}, ${input.runId}, ${input.agentId}, 'create_scope_draft', 'ready',
       ${JSON.stringify(input.payload)}::jsonb,
       ${`k:w2:${input.keyPrefix}:${actionId}`}, ${JSON.stringify(snap)}::jsonb)
  `);
  return actionId;
}

// ── embedded-postgres lifecycle ───────────────────────────────────────────────

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-w2-extract-scope-integ-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
      // Force UTF-8 so migration SQL containing non-Latin1 chars (e.g. '→' in a
      // comment) applies. Without this, initdb inherits the host locale (WIN1252 on
      // Windows) and the `postgres` DB rejects those bytes.
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[w2-extract-then-scope] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  try {
    if (pg) await pg.stop();
  } catch {
    /* ignore */
  }
  try {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}, 60_000);

// ── test suite ────────────────────────────────────────────────────────────────

// Windows-skip: CI's `runneradmin` account can't start embedded-postgres (Issue #114).
// To run locally on Windows, temporarily flip this to `describe.skipIf(false)` — the
// UTF-8 initdbFlags above make the cluster locale-safe.
describe.skipIf(process.platform === "win32")("W2 integration: extract-then-scope", () => {

  // ── Case 1: real extracted items → real cards, no placeholder (Adjutant path) ─

  it("Adjutant path: real extracted items compile into real cards; entry with items is left untouched", async () => {
    if (setupError) throw new Error(String(setupError));

    const { companyId, agentId } = await seedCompanyAndAgent("RealItems");
    // Defensive determinism: if the conservative selection guard ever regressed,
    // extraction must fail fast here rather than spawn a real CLI on a dev machine.
    await forceUnsupportedExtractionCli(companyId);
    const { threadId, entryId } = await seedThreadWithEntry(companyId, {
      text: "We need the auth token endpoint built for the mobile app.",
      extractionStatus: "pending",
      item: { type: "task", title: "Build the token endpoint" },
    });
    await setThreadAutonomy(threadId, 0); // Manual — keep W1b/W1c out of the way.

    const runId = await seedRun(companyId);
    const actionId = await seedScopeDraftAction({
      companyId,
      threadId,
      runId,
      agentId,
      payload: { summary: "Auth scope" }, // NO proposedTasks — items must come from extraction.
      keyPrefix: "real-items",
    });

    const commitResult = await threadAgentActionService(db).commitThreadAgentActions({
      companyId,
      threadId,
      runId,
    });
    expect(commitResult.committed).toBe(1);
    expect(commitResult.failed).toBe(0);

    const [actionRow] = rowsOf(
      await db.execute(sql`
        SELECT status, committed_scope_version_id FROM thread_agent_actions WHERE id = ${actionId}
      `),
    );
    expect(String(actionRow.status)).toBe("committed");
    expect(actionRow.committed_scope_version_id).toBeTruthy();
    const scopeVersionId = String(actionRow.committed_scope_version_id);

    // The REAL extracted item became the task_proposal card — its own title, verbatim.
    const items = rowsOf(
      await db.execute(sql`
        SELECT kind, title FROM thread_scope_items WHERE scope_version_id = ${scopeVersionId}
      `),
    );
    const taskItems = items.filter((item) => String(item.kind) === "task_proposal");
    expect(taskItems).toHaveLength(1);
    expect(String(taskItems[0].title)).toBe("Build the token endpoint");

    // The dead keyword stubs can never appear — on ANY item kind.
    for (const item of items) {
      expect(String(item.title)).not.toMatch(DEAD_PLACEHOLDER_RE);
    }

    // Conservative selection (founder-review-surface guard, on real SQL): the entry
    // already HAS an extracted item, so extractThreadEntriesAwait must skip it
    // entirely — extraction_status stays exactly as seeded.
    const [entryRow] = rowsOf(
      await db.execute(sql`
        SELECT extraction_status FROM discussion_entries WHERE id = ${entryId}
      `),
    );
    expect(String(entryRow.extraction_status)).toBe("pending");

    // ── Codex #270 P2 (round 5), real-SQL proof: applying the card RESOLVES its
    // source extracted item — no duplicate-approve path, no stale pending badge. ──
    await db.execute(sql`UPDATE discussions SET pending_item_count = 1 WHERE id = ${threadId}`);
    const [cardRow] = rowsOf(
      await db.execute(sql`
        SELECT id, extracted_item_id FROM thread_scope_items
        WHERE scope_version_id = ${scopeVersionId} AND kind = 'task_proposal'
      `),
    );
    expect(cardRow.extracted_item_id).toBeTruthy(); // the card carries its origin
    const applyResult = await threadScopeVersionService(db).createOutputItem(
      companyId,
      threadId,
      scopeVersionId,
      String(cardRow.id),
      { userId: "founder-user", isHuman: true },
      {},
    );
    expect(applyResult.ok).toBe(true);
    const [sourceItem] = rowsOf(
      await db.execute(sql`
        SELECT status, result_task_id FROM discussion_extracted_items WHERE id = ${String(cardRow.extracted_item_id)}
      `),
    );
    expect(String(sourceItem.status)).toBe("approved"); // no longer approve-able → no duplicate
    expect(sourceItem.result_task_id).toBeTruthy();     // linked to the created task
    const [threadRow2] = rowsOf(
      await db.execute(sql`SELECT pending_item_count FROM discussions WHERE id = ${threadId}`),
    );
    expect(Number(threadRow2.pending_item_count)).toBe(0); // badge decremented
  }, 60_000);

  // ── Case 2: Adjutant path, extraction attempted-and-failed → zero-card draft ──

  it("Adjutant path: extraction attempted with no usable engine → NO draft; entries stay retryable (round-6 P2)", async () => {
    if (setupError) throw new Error(String(setupError));

    const { companyId, agentId } = await seedCompanyAndAgent("NoEngine");
    // Force the deterministic no-engine path (see helper doc): the entry IS
    // attempted (skipped→pending flip + atomic pending→processing claim), then
    // resolveExtractionEngine throws before any CLI spawn.
    await forceUnsupportedExtractionCli(companyId);
    // Neutral text: no durable-memory/decision phrasing, so the intent-gated
    // memory-candidate synthesis must not fire either.
    const { threadId, entryId } = await seedThreadWithEntry(companyId, {
      text: "let us look at the auth work sometime",
      extractionStatus: "skipped",
      // ZERO extracted items — eligible for extract-then-scope.
    });
    // Codex #270 P2: an AGENT-authored entry (skipped, zero items) must be EXCLUDED
    // from extract-then-scope — scoping derives work from the founder's instructions,
    // not crew chatter. Seeded before the action so the freshness snapshot covers it.
    const agentEntryId = randomUUID();
    await db.execute(sql`
      INSERT INTO discussion_entries
        (id, discussion_id, input_type, raw_content, created_by, seq, extraction_status, author_agent_id)
      VALUES
        (${agentEntryId}, ${threadId}, 'agent', 'A long crew reply that must never be extracted for scoping.', 'crew', 2, 'skipped', ${agentId})
    `);
    await db.execute(sql`UPDATE discussions SET entry_seq = 2 WHERE id = ${threadId}`);
    await setThreadAutonomy(threadId, 0); // Manual

    const runId = await seedRun(companyId);
    const actionId = await seedScopeDraftAction({
      companyId,
      threadId,
      runId,
      agentId,
      payload: { summary: "Auth follow-up" }, // NO proposedTasks.
      keyPrefix: "no-engine",
    });

    const commitResult = await threadAgentActionService(db).commitThreadAgentActions({
      companyId,
      threadId,
      runId,
    });
    // Best-effort: the failed extraction attempt must never block the draft.
    expect(commitResult.committed).toBe(1);
    expect(commitResult.failed).toBe(0);

    const [actionRow] = rowsOf(
      await db.execute(sql`
        SELECT status, committed_scope_version_id FROM thread_agent_actions WHERE id = ${actionId}
      `),
    );
    expect(String(actionRow.status)).toBe("committed");

    // Round-6 P2: the FAILED entry caps the range below its own seq → the compile
    // yields no_entries → NO draft is minted at all. The failed entry's content is
    // never consumed by an acceptable range, so the next scoping pass (after the
    // founder fixes the CLI) retries it cleanly. No draft ⇒ no fake card, trivially.
    expect(actionRow.committed_scope_version_id).toBeNull();
    const versions = rowsOf(
      await db.execute(sql`
        SELECT id FROM thread_scope_versions WHERE thread_id = ${threadId}
      `),
    );
    expect(versions).toHaveLength(0);

    // The entry was ATTEMPTED. Proof: the attempt recorded an extractionError in
    // source_info (it was NULL at seed time — only extractFromDiscussionEntry's
    // failure paths write it).
    //
    // NOTE (deliberate deviation from the plan's "assert <> 'skipped'"): when NO
    // extraction engine resolves, extraction.ts re-terminalizes the entry to
    // 'skipped' BY DESIGN ('failed' is reserved for an engine that ran and
    // failed — extraction.ts:326-333 vs :433-439). On CI there is never a CLI, so
    // the engine-unavailable path is the only reachable one and the final status
    // IS 'skipped' again; the extractionError payload is what distinguishes
    // "attempted and found no engine" from "never touched".
    const [entryRow] = rowsOf(
      await db.execute(sql`
        SELECT extraction_status, source_info->>'extractionError' AS extraction_error
        FROM discussion_entries WHERE id = ${entryId}
      `),
    );
    expect(["skipped", "failed"]).toContain(String(entryRow.extraction_status));
    expect(entryRow.extraction_error).toBeTruthy();
    expect(String(entryRow.extraction_error)).toMatch(/No extraction engine available/);

    // Codex #270 P2 (real SQL proof): the agent-authored entry was NEVER attempted —
    // status untouched and no extractionError recorded (the human entry above got one).
    const [agentRow] = rowsOf(
      await db.execute(sql`
        SELECT extraction_status, source_info->>'extractionError' AS extraction_error
        FROM discussion_entries WHERE id = ${agentEntryId}
      `),
    );
    expect(String(agentRow.extraction_status)).toBe("skipped");
    expect(agentRow.extraction_error).toBeNull();
  }, 120_000);

  // ── Case 3: human default derives the fallback card from entry content ───────

  it("human default: createDraftFromThread synthesizes ONE fallback card with a content-derived title", async () => {
    if (setupError) throw new Error(String(setupError));

    const { companyId } = await seedCompanyAndAgent("HumanFallback");
    const { threadId } = await seedThreadWithEntry(companyId, {
      text: "Rework the billing retry queue.",
      extractionStatus: "skipped",
      // ZERO extracted items — the compiler must synthesize the derived fallback.
    });

    // Human route: direct call, NO suppressFallbackTask (and no extraction).
    const result = await threadScopeVersionService(db).createDraftFromThread(
      companyId,
      threadId,
      { userId: "founder-user", isHuman: true },
      { summary: "S" },
    );
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error(`expected created, got ${result.status}`);
    const scopeVersionId = result.version.id;

    const items = rowsOf(
      await db.execute(sql`
        SELECT kind, title FROM thread_scope_items WHERE scope_version_id = ${scopeVersionId}
      `),
    );
    const taskItems = items.filter((item) => String(item.kind) === "task_proposal");
    expect(taskItems).toHaveLength(1);
    // Derived title = first sentence of the longest entry (≤ 80 chars) — the
    // entry's own words, not a keyword stub.
    expect(String(taskItems[0].title)).toBe("Rework the billing retry queue.");
    for (const item of items) {
      expect(String(item.title)).not.toMatch(DEAD_PLACEHOLDER_RE);
    }
  }, 60_000);

  // ── Case 4: extraction is bounded to the UNSCOPED range (Codex #270 round-4 P1) ──
  //
  // A thread already has an ACCEPTED scope over seq 1 whose entry is still
  // 'skipped' with zero items (human-created / pre-W2 / proposedTasks-path scopes
  // all leave exactly this). The new tail (seq 2) carries a real pending item.
  // Extract-then-scope must: (1) NEVER touch the already-scoped entry 1 (no budget
  // burn, no flip, no extractionError), and (2) mint the new draft over the tail —
  // sourceStartSeq 2, with the tail's real card. Without the bound, the old prefix
  // could consume the cap and a truncated lastAttemptedSeq <= sourceEndSeq(accepted)
  // would collapse the new range into no_entries (action commits, NO draft).
  it("Adjutant path: already-scoped skipped entries are excluded; the new tail still drafts", async () => {
    if (setupError) throw new Error(String(setupError));

    const { companyId, agentId } = await seedCompanyAndAgent("ScopedPrefix");
    await forceUnsupportedExtractionCli(companyId);
    // Entry 1: skipped, zero items — but ALREADY covered by an accepted scope.
    const { threadId, entryId: oldEntryId } = await seedThreadWithEntry(companyId, {
      text: "old already-scoped instructions that were never extracted",
      extractionStatus: "skipped",
    });
    await db.execute(sql`
      INSERT INTO thread_scope_versions
        (id, company_id, thread_id, version_number, status, source_start_seq, source_end_seq, summary, created_by)
      VALUES
        (gen_random_uuid(), ${companyId}, ${threadId}, 1, 'accepted', 1, 1, 'v1 accepted scope', 'integration-test')
    `);
    // Entry 2: the new tail — human, with a real pending extracted item.
    const tailEntryId = randomUUID();
    await db.execute(sql`
      INSERT INTO discussion_entries (id, discussion_id, input_type, raw_content, created_by, seq, extraction_status)
      VALUES (${tailEntryId}, ${threadId}, 'write', 'Now build the export pipeline.', 'human-user', 2, 'completed')
    `);
    await db.execute(sql`
      INSERT INTO discussion_extracted_items (id, discussion_entry_id, type, title, status)
      VALUES (gen_random_uuid(), ${tailEntryId}, 'task', 'Build the export pipeline', 'pending')
    `);
    await db.execute(sql`UPDATE discussions SET entry_seq = 2 WHERE id = ${threadId}`);
    await setThreadAutonomy(threadId, 0);

    const runId = await seedRun(companyId);
    const actionId = await seedScopeDraftAction({
      companyId,
      threadId,
      runId,
      agentId,
      payload: { summary: "Tail scope" },
      keyPrefix: "scoped-prefix",
    });

    const commitResult = await threadAgentActionService(db).commitThreadAgentActions({
      companyId,
      threadId,
      runId,
    });
    expect(commitResult.committed).toBe(1);
    expect(commitResult.failed).toBe(0);

    // (1) The already-scoped entry was NEVER touched by extract-then-scope.
    const [oldRow] = rowsOf(
      await db.execute(sql`
        SELECT extraction_status, source_info->>'extractionError' AS extraction_error
        FROM discussion_entries WHERE id = ${oldEntryId}
      `),
    );
    expect(String(oldRow.extraction_status)).toBe("skipped");
    expect(oldRow.extraction_error).toBeNull();

    // (2) A NEW draft exists over the tail range with the tail's real card.
    const [actionRow] = rowsOf(
      await db.execute(sql`
        SELECT committed_scope_version_id FROM thread_agent_actions WHERE id = ${actionId}
      `),
    );
    expect(actionRow.committed_scope_version_id).toBeTruthy();
    const scopeVersionId = String(actionRow.committed_scope_version_id);
    const [versionRow] = rowsOf(
      await db.execute(sql`
        SELECT status, source_start_seq, source_end_seq FROM thread_scope_versions WHERE id = ${scopeVersionId}
      `),
    );
    expect(String(versionRow.status)).toBe("draft");
    expect(Number(versionRow.source_start_seq)).toBe(2);
    expect(Number(versionRow.source_end_seq)).toBe(2);
    const taskItems = rowsOf(
      await db.execute(sql`
        SELECT title FROM thread_scope_items WHERE scope_version_id = ${scopeVersionId} AND kind = 'task_proposal'
      `),
    );
    expect(taskItems).toHaveLength(1);
    expect(String(taskItems[0].title)).toBe("Build the export pipeline");
  }, 120_000);

  // ── Case 5: a trivially-short entry cannot wedge scoping (Codex #270 round-8 P2) ──
  //
  // A short greeting ("ok") at the HEAD of the unscoped range is permanently
  // non-extractable — the extractor skips it by design. Before the round-8 fix it
  // was attempted, re-skipped, and its "failure" capped rangeEndCap below the range
  // start: createDraftFromThread returned no_entries FOREVER and nothing after it
  // could ever be scoped. Now it is excluded from eligibility entirely: never
  // attempted, never capping — the later real entry drafts normally.
  it("Adjutant path: a short 'ok' entry at the range head is skipped, not a wedge — later entries still draft", async () => {
    if (setupError) throw new Error(String(setupError));

    const { companyId, agentId } = await seedCompanyAndAgent("ShortEntry");
    await forceUnsupportedExtractionCli(companyId);
    // Entry 1: trivially short, human, skipped, zero items — the would-be wedge.
    const { threadId, entryId: shortEntryId } = await seedThreadWithEntry(companyId, {
      text: "ok",
      extractionStatus: "skipped",
    });
    // Entry 2: real content with a seeded pending item (deterministic real card).
    const tailEntryId = randomUUID();
    await db.execute(sql`
      INSERT INTO discussion_entries (id, discussion_id, input_type, raw_content, created_by, seq, extraction_status)
      VALUES (${tailEntryId}, ${threadId}, 'write', 'Ship the billing exporter next.', 'human-user', 2, 'completed')
    `);
    await db.execute(sql`
      INSERT INTO discussion_extracted_items (id, discussion_entry_id, type, title, status)
      VALUES (gen_random_uuid(), ${tailEntryId}, 'task', 'Ship the billing exporter', 'pending')
    `);
    await db.execute(sql`UPDATE discussions SET entry_seq = 2 WHERE id = ${threadId}`);
    await setThreadAutonomy(threadId, 0);

    const runId = await seedRun(companyId);
    const actionId = await seedScopeDraftAction({
      companyId,
      threadId,
      runId,
      agentId,
      payload: { summary: "Exporter scope" },
      keyPrefix: "short-entry",
    });

    const commitResult = await threadAgentActionService(db).commitThreadAgentActions({
      companyId,
      threadId,
      runId,
    });
    expect(commitResult.committed).toBe(1);
    expect(commitResult.failed).toBe(0);

    // The short entry was NEVER attempted (no flip, no extractionError) …
    const [shortRow] = rowsOf(
      await db.execute(sql`
        SELECT extraction_status, source_info->>'extractionError' AS extraction_error
        FROM discussion_entries WHERE id = ${shortEntryId}
      `),
    );
    expect(String(shortRow.extraction_status)).toBe("skipped");
    expect(shortRow.extraction_error).toBeNull();

    // … and the draft EXISTS over the full range with the real card — no wedge.
    const [actionRow] = rowsOf(
      await db.execute(sql`
        SELECT committed_scope_version_id FROM thread_agent_actions WHERE id = ${actionId}
      `),
    );
    expect(actionRow.committed_scope_version_id).toBeTruthy();
    const scopeVersionId = String(actionRow.committed_scope_version_id);
    const [versionRow] = rowsOf(
      await db.execute(sql`
        SELECT source_start_seq, source_end_seq FROM thread_scope_versions WHERE id = ${scopeVersionId}
      `),
    );
    expect(Number(versionRow.source_start_seq)).toBe(1);
    expect(Number(versionRow.source_end_seq)).toBe(2);
    const taskItems = rowsOf(
      await db.execute(sql`
        SELECT title FROM thread_scope_items WHERE scope_version_id = ${scopeVersionId} AND kind = 'task_proposal'
      `),
    );
    expect(taskItems).toHaveLength(1);
    expect(String(taskItems[0].title)).toBe("Ship the billing exporter");
  }, 120_000);

  // ── Case 6: an empty draft is never minted ahead of a failed entry (Codex #270 round-9 P2) ──
  //
  // Range head = short "ok" (permanently non-extractable, round 8) + a real entry
  // whose extraction attempt finds no engine. The failure caps the range just past
  // the short prefix — before this fix that minted a ZERO-CARD draft over "ok"
  // alone, and every later scope pass bounced off existing_draft until a human
  // rejected the empty draft. Now the zero-item compile returns no_items: NO
  // draft, the real entry stays retryable, and the next successful pass drafts
  // the FULL range (both entries) with the real card.
  it("Adjutant path: short prefix + failed entry mints NO empty draft — the next pass drafts the full range", async () => {
    if (setupError) throw new Error(String(setupError));

    const { companyId, agentId } = await seedCompanyAndAgent("EmptyDraft");
    await forceUnsupportedExtractionCli(companyId);
    // Entry 1: trivially short — excluded from extraction eligibility (round 8).
    const { threadId, entryId: shortEntryId } = await seedThreadWithEntry(companyId, {
      text: "ok",
      extractionStatus: "skipped",
    });
    // Entry 2: real content, never extracted — the no-engine attempt will fail.
    const tailEntryId = randomUUID();
    await db.execute(sql`
      INSERT INTO discussion_entries (id, discussion_id, input_type, raw_content, created_by, seq, extraction_status)
      VALUES (${tailEntryId}, ${threadId}, 'write', 'Rework the ingestion retry queue.', 'human-user', 2, 'pending')
    `);
    await db.execute(sql`UPDATE discussions SET entry_seq = 2 WHERE id = ${threadId}`);
    await setThreadAutonomy(threadId, 0);

    const runId = await seedRun(companyId);
    await seedScopeDraftAction({
      companyId,
      threadId,
      runId,
      agentId,
      payload: { summary: "Ingestion scope" },
      keyPrefix: "empty-draft-1",
    });
    const first = await threadAgentActionService(db).commitThreadAgentActions({
      companyId,
      threadId,
      runId,
    });
    expect(first.committed).toBe(1);
    expect(first.failed).toBe(0);

    // NO scope version exists — the zero-card draft was refused, not minted.
    const versions = rowsOf(
      await db.execute(sql`SELECT id FROM thread_scope_versions WHERE thread_id = ${threadId}`),
    );
    expect(versions).toHaveLength(0);
    // The real entry was attempted (extractionError recorded) and stays retryable;
    // the short one was never touched.
    const [tailRow] = rowsOf(
      await db.execute(sql`
        SELECT extraction_status, source_info->>'extractionError' AS extraction_error
        FROM discussion_entries WHERE id = ${tailEntryId}
      `),
    );
    expect(["skipped", "failed"]).toContain(String(tailRow.extraction_status));
    expect(tailRow.extraction_error).toBeTruthy();
    const [shortRow] = rowsOf(
      await db.execute(sql`
        SELECT extraction_status, source_info->>'extractionError' AS extraction_error
        FROM discussion_entries WHERE id = ${shortEntryId}
      `),
    );
    expect(String(shortRow.extraction_status)).toBe("skipped");
    expect(shortRow.extraction_error).toBeNull();

    // Recovery: extraction later succeeds (simulated: entry completed + real item).
    // Before the fix this pass hit existing_draft on the stranded empty draft.
    await db.execute(sql`
      UPDATE discussion_entries SET extraction_status = 'completed' WHERE id = ${tailEntryId}
    `);
    await db.execute(sql`
      INSERT INTO discussion_extracted_items (id, discussion_entry_id, type, title, status)
      VALUES (gen_random_uuid(), ${tailEntryId}, 'task', 'Rework the ingestion retry queue', 'pending')
    `);
    const runId2 = await seedRun(companyId);
    const action2Id = await seedScopeDraftAction({
      companyId,
      threadId,
      runId: runId2,
      agentId,
      payload: { summary: "Ingestion scope" },
      keyPrefix: "empty-draft-2",
    });
    const second = await threadAgentActionService(db).commitThreadAgentActions({
      companyId,
      threadId,
      runId: runId2,
    });
    expect(second.committed).toBe(1);

    const [action2Row] = rowsOf(
      await db.execute(sql`
        SELECT committed_scope_version_id FROM thread_agent_actions WHERE id = ${action2Id}
      `),
    );
    expect(action2Row.committed_scope_version_id).toBeTruthy();
    const scopeVersionId = String(action2Row.committed_scope_version_id);
    const [versionRow] = rowsOf(
      await db.execute(sql`
        SELECT source_start_seq, source_end_seq FROM thread_scope_versions WHERE id = ${scopeVersionId}
      `),
    );
    expect(Number(versionRow.source_start_seq)).toBe(1);
    expect(Number(versionRow.source_end_seq)).toBe(2);
    const cards = rowsOf(
      await db.execute(sql`
        SELECT title FROM thread_scope_items WHERE scope_version_id = ${scopeVersionId} AND kind = 'task_proposal'
      `),
    );
    expect(cards).toHaveLength(1);
    expect(String(cards[0].title)).toBe("Rework the ingestion retry queue");
  }, 120_000);

  // ── Case 7: a no-op commit does not absorb the idempotency key forever (Codex #270 round-10 P2) ──
  //
  // Production scope-draft keys are run-INDEPENDENT and turn-anchored: the same
  // thread/agent/turn/summary always derives the SAME key. A create_scope_draft
  // that committed WITHOUT minting a draft (extraction found no CLI → no_entries/
  // no_items) used to occupy that key as a terminal committed row — a later
  // same-turn re-proposal (founder fixed the CLI, no new human entry) collided
  // with it and was silently swallowed: the draft could never be re-attempted.
  // Now the collide path REVIVES a no-op committed create_scope_draft to
  // proposed (fresh freshness, committedAt shed), and the retry drains normally.
  it("Adjutant path: same-key re-proposal after a no-op commit revives the action — retry drafts for real", async () => {
    if (setupError) throw new Error(String(setupError));

    const { companyId, agentId } = await seedCompanyAndAgent("KeyRevive");
    await forceUnsupportedExtractionCli(companyId);
    const { threadId, entryId } = await seedThreadWithEntry(companyId, {
      text: "Stand up the churn-alert pipeline this sprint.",
      extractionStatus: "pending",
    });
    await setThreadAutonomy(threadId, 0);
    const svc = threadAgentActionService(db);
    // Production-style stable key: run-independent, turn-anchored (thread-action-keys.ts).
    const stableKey = `${threadId}:create_scope_draft:${agentId}:${entryId}:samehash`;

    // Attempt 1: propose → seal (simulated, Decision #99) → commit. Extraction has
    // no engine → the failure caps the range → NO draft; the action commits as a no-op.
    const runId1 = await seedRun(companyId);
    const snap1 = await captureFreshnessSnapshot(db as never, threadId);
    const proposed1 = (await svc.proposeThreadAction({
      companyId,
      threadId,
      runId: runId1,
      agentId,
      actionType: "create_scope_draft",
      payload: { summary: "Churn-alert scope" },
      idempotencyKey: stableKey,
      freshness: snap1 as never,
    })) as { id: string };
    await db.execute(sql`
      UPDATE thread_agent_actions SET status = 'ready' WHERE id = ${proposed1.id}
    `);
    const first = await svc.commitThreadAgentActions({ companyId, threadId, runId: runId1 });
    expect(first.committed).toBe(1);
    const [afterFirst] = rowsOf(
      await db.execute(sql`
        SELECT status, committed_scope_version_id FROM thread_agent_actions WHERE id = ${proposed1.id}
      `),
    );
    expect(String(afterFirst.status)).toBe("committed");
    expect(afterFirst.committed_scope_version_id).toBeNull();

    // Founder fixes extraction; no new human entry → the SAME key is re-derived.
    await db.execute(sql`
      UPDATE discussion_entries SET extraction_status = 'completed' WHERE id = ${entryId}
    `);
    await db.execute(sql`
      INSERT INTO discussion_extracted_items (id, discussion_entry_id, type, title, status)
      VALUES (gen_random_uuid(), ${entryId}, 'task', 'Stand up the churn-alert pipeline', 'pending')
    `);

    // Attempt 2: SAME key. The collide path must revive the no-op row, not swallow it.
    const runId2 = await seedRun(companyId);
    const snap2 = await captureFreshnessSnapshot(db as never, threadId);
    const proposed2 = (await svc.proposeThreadAction({
      companyId,
      threadId,
      runId: runId2,
      agentId,
      actionType: "create_scope_draft",
      payload: { summary: "Churn-alert scope" },
      idempotencyKey: stableKey,
      freshness: snap2 as never,
    })) as { id: string; status: string };
    expect(proposed2.id).toBe(proposed1.id); // same row — revived, not duplicated
    expect(String(proposed2.status)).toBe("proposed");
    const [revivedRow] = rowsOf(
      await db.execute(sql`
        SELECT status, committed_at FROM thread_agent_actions WHERE id = ${proposed1.id}
      `),
    );
    expect(String(revivedRow.status)).toBe("proposed");
    expect(revivedRow.committed_at).toBeNull();

    // Seal + drain: this time the draft mints for real, with the real card.
    await db.execute(sql`
      UPDATE thread_agent_actions SET status = 'ready' WHERE id = ${proposed1.id}
    `);
    const second = await svc.commitThreadAgentActions({ companyId, threadId, runId: runId2 });
    expect(second.committed).toBe(1);
    const [afterSecond] = rowsOf(
      await db.execute(sql`
        SELECT status, committed_scope_version_id FROM thread_agent_actions WHERE id = ${proposed1.id}
      `),
    );
    expect(String(afterSecond.status)).toBe("committed");
    expect(afterSecond.committed_scope_version_id).toBeTruthy();
    const cards7 = rowsOf(
      await db.execute(sql`
        SELECT title FROM thread_scope_items
        WHERE scope_version_id = ${String(afterSecond.committed_scope_version_id)} AND kind = 'task_proposal'
      `),
    );
    expect(cards7).toHaveLength(1);
    expect(String(cards7[0].title)).toBe("Stand up the churn-alert pipeline");
  }, 120_000);

  // ── Case 8: an in-flight extraction caps the range — its items are never orphaned (Codex #270 round-11 P2) ──
  //
  // A background worker has CLAIMED entry 2 (`processing`, fresh
  // sourceInfo.extractionClaimedAt, zero items) when scoping runs. The draft must
  // stop at entry 1: consuming entry 2 would strand the items the worker writes
  // seconds later below the next sourceStartSeq — invisible to every future scope
  // draft. After the worker finishes, the next pass drafts entry 2's items normally.
  it("Adjutant path: a fresh in-flight entry caps the draft range; its items scope on the NEXT pass", async () => {
    if (setupError) throw new Error(String(setupError));

    const { companyId, agentId } = await seedCompanyAndAgent("InFlight");
    await forceUnsupportedExtractionCli(companyId);
    // Entry 1: captured — completed with a real pending item.
    const { threadId } = await seedThreadWithEntry(companyId, {
      text: "Refit the auth flow for the SSO rollout.",
      extractionStatus: "completed",
      item: { type: "task", title: "Refit the auth flow" },
    });
    // Entry 2: claimed by a live background worker — processing, FRESH stamp, no items.
    const inFlightEntryId = randomUUID();
    await db.execute(sql`
      INSERT INTO discussion_entries
        (id, discussion_id, input_type, raw_content, created_by, seq, extraction_status, source_info)
      VALUES
        (${inFlightEntryId}, ${threadId}, 'write', 'Also draft the SSO comms plan for customers.', 'human-user', 2, 'processing',
         jsonb_build_object('extractionClaimedAt', ${Date.now()}::bigint))
    `);
    await db.execute(sql`UPDATE discussions SET entry_seq = 2 WHERE id = ${threadId}`);
    await setThreadAutonomy(threadId, 0);

    const runId = await seedRun(companyId);
    const actionId = await seedScopeDraftAction({
      companyId,
      threadId,
      runId,
      agentId,
      payload: { summary: "SSO scope" },
      keyPrefix: "in-flight-1",
    });
    const first = await threadAgentActionService(db).commitThreadAgentActions({
      companyId,
      threadId,
      runId,
    });
    expect(first.committed).toBe(1);

    // Draft covers ONLY entry 1 — the in-flight entry stays out of the range …
    const [actionRow] = rowsOf(
      await db.execute(sql`
        SELECT committed_scope_version_id FROM thread_agent_actions WHERE id = ${actionId}
      `),
    );
    expect(actionRow.committed_scope_version_id).toBeTruthy();
    const v1Id = String(actionRow.committed_scope_version_id);
    const [v1Row] = rowsOf(
      await db.execute(sql`
        SELECT source_start_seq, source_end_seq FROM thread_scope_versions WHERE id = ${v1Id}
      `),
    );
    expect(Number(v1Row.source_start_seq)).toBe(1);
    expect(Number(v1Row.source_end_seq)).toBe(1);
    // … and its claim was NOT disturbed (the owner is alive).
    const [inFlightRow] = rowsOf(
      await db.execute(sql`
        SELECT extraction_status FROM discussion_entries WHERE id = ${inFlightEntryId}
      `),
    );
    expect(String(inFlightRow.extraction_status)).toBe("processing");

    // The worker finishes (completed + items) and the founder accepts draft v1.
    await db.execute(sql`
      UPDATE discussion_entries SET extraction_status = 'completed' WHERE id = ${inFlightEntryId}
    `);
    await db.execute(sql`
      INSERT INTO discussion_extracted_items (id, discussion_entry_id, type, title, status)
      VALUES (gen_random_uuid(), ${inFlightEntryId}, 'task', 'Draft the SSO comms plan', 'pending')
    `);
    await db.execute(sql`
      UPDATE thread_scope_versions SET status = 'accepted' WHERE id = ${v1Id}
    `);

    // Next pass: the tail drafts over exactly seq 2 with the worker's item — not orphaned.
    const runId2 = await seedRun(companyId);
    const action2Id = await seedScopeDraftAction({
      companyId,
      threadId,
      runId: runId2,
      agentId,
      payload: { summary: "SSO scope tail" },
      keyPrefix: "in-flight-2",
    });
    const second = await threadAgentActionService(db).commitThreadAgentActions({
      companyId,
      threadId,
      runId: runId2,
    });
    expect(second.committed).toBe(1);
    const [action2Row] = rowsOf(
      await db.execute(sql`
        SELECT committed_scope_version_id FROM thread_agent_actions WHERE id = ${action2Id}
      `),
    );
    expect(action2Row.committed_scope_version_id).toBeTruthy();
    const v2Id = String(action2Row.committed_scope_version_id);
    const [v2Row] = rowsOf(
      await db.execute(sql`
        SELECT source_start_seq, source_end_seq FROM thread_scope_versions WHERE id = ${v2Id}
      `),
    );
    expect(Number(v2Row.source_start_seq)).toBe(2);
    expect(Number(v2Row.source_end_seq)).toBe(2);
    const cards8 = rowsOf(
      await db.execute(sql`
        SELECT title FROM thread_scope_items WHERE scope_version_id = ${v2Id} AND kind = 'task_proposal'
      `),
    );
    expect(cards8).toHaveLength(1);
    expect(String(cards8[0].title)).toBe("Draft the SSO comms plan");
  }, 120_000);
});
