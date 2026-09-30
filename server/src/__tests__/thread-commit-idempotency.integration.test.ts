/**
 * #197 / #198 — Real-DB proof of the action-commit idempotency substrate.
 *
 * Boots embedded-postgres, applies all migrations (incl. 0145 + 0146), then
 * verifies what the sequence-mock suites structurally cannot:
 *   1. the three partial unique indexes actually build in Postgres;
 *   2. the discussion_entries partial unique index ENFORCES a duplicate
 *      source_action_id — AND the real postgres-js error matches
 *      `isUniqueViolation(err, "..._source_action_uq")` (the exact C1 failure
 *      mode: postgres-js puts the index name on `cause.constraint_name`, not
 *      `constraint`). NULL source_action_id is exempt (partial predicate).
 *   3. the artifacts partial unique index enforces + matches the helper.
 *   4. proposeThreadAction dedups a re-proposed run-independent key cross-run
 *      via onConflictDoNothing against the real (companyId, idempotencyKey)
 *      unique index, returning the same row (same action.id).
 *   5. (#198) the thread_scope_items partial unique index ENFORCES a duplicate
 *      source_action_id (the add_scope_item commit guarantee) + NULL exemption.
 *   6. (#198) a key-only action type (advance_phase) dedups end-to-end at the
 *      (companyId, idempotencyKey) unique index — the cross-run guarantee for
 *      the types with no source_action_id side-effect.
 *
 * Skipped on Windows (embedded-postgres / migration-chain issue — Issue #114);
 * Linux CI is the authoritative gate. Modeled on aoa-backend.integration.test.ts.
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
  threadScopeItems,
  type Db,
} from "@armyofagents/db";
import { companyService } from "../services/companies.js";
import { discussionService } from "../services/discussions.js";
import { artifactService } from "../services/artifacts.js";
import {
  threadAgentActionService,
  reapStaleThreadAgentActions,
  gcOrphanedProposedActions,
} from "../services/thread-agent-actions.js";
import {
  captureFreshnessSnapshot,
  type ThreadFreshnessSnapshot,
} from "../services/thread-agent-action-freshness.js";
import { isUniqueViolation } from "../services/db-errors.js";
import {
  buildAdvancePhaseIdempotencyKey,
  buildConveneWakeupDedupKey,
  buildPostReplyIdempotencyKey,
} from "../services/internal-agent/tools/thread-action-keys.js";

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
// Module-scoped so the two-connection concurrency proof (Test 9) can spin up a
// SECOND independent postgres pool against the SAME embedded-postgres instance via
// createDb(connectionString). createDb() opens a fresh postgres() pool per call, so
// this yields genuine cross-connection contention (not two handles sharing a socket).
let connectionString = "";
let setupError: unknown = null;
let companyId = "";
let threadId = "";
// A real agent row — the post_reply commit handler blocks on a null agentId and
// discussion_entries.author_agent_id is an FK, so the cross-run e2e needs one.
let agentId = "";

const PORT = 59000 + Math.floor(Math.random() * 1000);

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  return ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []) as Array<
    Record<string, unknown>
  >;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-thread-idem-integ-"));
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
      // comment) applies. Without this, initdb inherits the host locale (WIN1252
      // on Windows) and the `postgres` DB rejects those bytes. Matches the newer
      // integration suites (w1c/w2); no-op on Linux CI, which is UTF-8 already.
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);

    // Seed a company (eager Commander/config) + a thread.
    const company = await companyService(db).create({ name: "Idempotency Co" } as never);
    companyId = company.id;
    const [thread] = rowsOf(
      await db.execute(sql`
        INSERT INTO discussions (id, company_id, status, created_by)
        VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test')
        RETURNING id
      `),
    );
    threadId = String(thread.id);

    // Seed an agent for the post_reply commit path (author_agent_id FK + the
    // handler's non-null agentId guard). Only company_id + name are NOT NULL.
    const [agent] = rowsOf(
      await db.execute(sql`
        INSERT INTO agents (id, company_id, name)
        VALUES (gen_random_uuid(), ${companyId}, 'Cross-Run Agent')
        RETURNING id
      `),
    );
    agentId = String(agent.id);
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[thread-commit-idempotency] embedded-postgres setup failed:", err);
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

describe.skipIf(process.platform === "win32")("thread-commit idempotency (real DB)", () => {
  // ── Harness helpers (PR-B) ─────────────────────────────────────────────────
  // thread_agent_actions.run_id is an FK to internal_agent_runs, so the cross-run
  // e2e needs real run rows. internal_agent_runs requires company_id (FK) +
  // trigger_type + trigger_source (both NOT NULL, no default); status defaults to
  // 'running' and id/created_at are auto-filled.
  async function seedRun(): Promise<string> {
    const [run] = rowsOf(
      await db.execute(sql`
        INSERT INTO internal_agent_runs (id, company_id, trigger_type, trigger_source)
        VALUES (gen_random_uuid(), ${companyId}, 'event', 'integration-test')
        RETURNING id
      `),
    );
    return String(run.id);
  }

  // Capture a REAL freshness snapshot via the production primitive so seeded
  // action rows carry a snapshot the commit path's compareFreshnessSnapshot
  // recognizes as fresh (matching the live thread state). A hand-rolled `{}`
  // would be detected as `snapshot_unavailable` and the action suppressed.
  async function captureSnapshot(tid: string): Promise<ThreadFreshnessSnapshot> {
    return captureFreshnessSnapshot(db as never, tid);
  }

  it("builds the three partial unique indexes", async () => {
    if (setupError) throw new Error(String(setupError));
    const names = new Set(
      rowsOf(
        await db.execute(sql`
          SELECT indexname FROM pg_indexes
          WHERE indexname IN (
            'discussion_entries_source_action_uq',
            'artifacts_source_action_uq',
            'thread_scope_items_source_action_uq'
          )
        `),
      ).map((r) => String(r.indexname)),
    );
    expect(names.has("discussion_entries_source_action_uq")).toBe(true);
    expect(names.has("artifacts_source_action_uq")).toBe(true);
    expect(names.has("thread_scope_items_source_action_uq")).toBe(true);
  });

  it("enforces discussion_entries source_action_id; the real driver error matches isUniqueViolation; NULLs exempt", async () => {
    if (setupError) throw new Error(String(setupError));
    const actionId = randomUUID();
    const svc = discussionService(db);

    // First write succeeds.
    await svc.addEntry(
      companyId,
      threadId,
      { inputType: "write", rawContent: "first", sourceActionId: actionId },
      "integration-test",
    );

    // Second write with the SAME source_action_id is rejected by the partial index.
    let caught: unknown;
    try {
      await svc.addEntry(
        companyId,
        threadId,
        { inputType: "write", rawContent: "dup", sourceActionId: actionId },
        "integration-test",
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    // The C1 proof: the REAL postgres-js error (cause.constraint_name) matches.
    expect(isUniqueViolation(caught, "discussion_entries_source_action_uq")).toBe(true);

    // Two NULL-source_action_id entries both succeed (partial predicate exempts them).
    await svc.addEntry(companyId, threadId, { inputType: "write", rawContent: "n1" }, "integration-test");
    await svc.addEntry(companyId, threadId, { inputType: "write", rawContent: "n2" }, "integration-test");
  });

  it("enforces artifacts source_action_id; the real driver error matches isUniqueViolation", async () => {
    if (setupError) throw new Error(String(setupError));
    const actionId = randomUUID();
    const svc = artifactService(db);

    await svc.create(companyId, "integration-test", {
      title: "Spec",
      type: "document",
      source: "agent",
      content: "# Plan",
      sourceActionId: actionId,
    });

    let caught: unknown;
    try {
      await svc.create(companyId, "integration-test", {
        title: "Spec (dup)",
        type: "document",
        source: "agent",
        content: "# Plan",
        sourceActionId: actionId,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(isUniqueViolation(caught, "artifacts_source_action_uq")).toBe(true);
  });

  it("enforces thread_scope_items source_action_id; the real driver error matches isUniqueViolation; NULLs exempt", async () => {
    if (setupError) throw new Error(String(setupError));

    // The partial unique index lives on (company_id, source_action_id); the scope
    // item only needs a valid scope_version_id FK to satisfy NOT NULL. Seed one
    // scope version directly (non-'draft' status so it never collides with the
    // thread_scope_versions_one_draft_uq partial index that the add_scope_item
    // commit path relies on). The scope_version_id supplies the FK target; the
    // index under test is wholly independent of which version the item belongs to.
    const [scopeVersion] = rowsOf(
      await db.execute(sql`
        INSERT INTO thread_scope_versions
          (id, company_id, thread_id, version_number, status,
           source_start_seq, source_end_seq, summary, created_by)
        VALUES
          (gen_random_uuid(), ${companyId}, ${threadId}, 1, 'accepted',
           0, 0, 'idempotency probe version', 'integration-test')
        RETURNING id
      `),
    );
    const scopeVersionId = String(scopeVersion.id);
    const actionId = randomUUID();

    // First gated scope item succeeds.
    await db.insert(threadScopeItems).values({
      companyId,
      scopeVersionId,
      kind: "decision",
      status: "draft",
      title: "x",
      sourceActionId: actionId,
    });

    // Second with the SAME (company_id, source_action_id) is rejected by the
    // partial index — and the REAL postgres-js error matches the helper.
    let caught: unknown;
    try {
      await db.insert(threadScopeItems).values({
        companyId,
        scopeVersionId,
        kind: "decision",
        status: "draft",
        title: "x (dup)",
        sourceActionId: actionId,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(isUniqueViolation(caught, "thread_scope_items_source_action_uq")).toBe(true);

    // Two NULL-source_action_id items both succeed (partial predicate exempts them).
    await db.insert(threadScopeItems).values({
      companyId,
      scopeVersionId,
      kind: "decision",
      status: "draft",
      title: "n1",
      sourceActionId: null,
    });
    await db.insert(threadScopeItems).values({
      companyId,
      scopeVersionId,
      kind: "decision",
      status: "draft",
      title: "n2",
      sourceActionId: null,
    });
  });

  it("dedups a re-proposed post_reply stable key cross-run (one action row)", async () => {
    if (setupError) throw new Error(String(setupError));
    const svc = threadAgentActionService(db);
    const key = buildPostReplyIdempotencyKey({
      threadId,
      agentId: null,
      parentEntryId: null,
      content: "Status: green.",
      turnAnchor: "1",
    });
    // Dedup is on (companyId, idempotencyKey), independent of runId. Pass runId=null
    // (run_id is a nullable FK to internal_agent_runs) so the test doesn't need a
    // seeded run row — the point is that the SAME stable key dedups across proposes.
    const a = (await svc.proposeThreadAction({
      companyId,
      threadId,
      runId: null,
      agentId: null,
      actionType: "post_reply",
      payload: { rawContent: "Status: green." },
      idempotencyKey: key,
    })) as { id: string };
    // A re-propose of the identical reply → same stable key → the real unique index
    // rejects the insert (onConflictDoNothing) → the existing row is returned, NOT a
    // new one.
    const b = (await svc.proposeThreadAction({
      companyId,
      threadId,
      runId: null,
      agentId: null,
      actionType: "post_reply",
      payload: { rawContent: "Status: green." },
      idempotencyKey: key,
    })) as { id: string };

    expect(b.id).toBe(a.id);
    const count = rowsOf(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM thread_agent_actions
        WHERE company_id = ${companyId} AND idempotency_key = ${key}
      `),
    );
    expect(Number(count[0].n)).toBe(1);
  });

  it("dedups a re-proposed key-only action (advance_phase) cross-run (one action row)", async () => {
    if (setupError) throw new Error(String(setupError));
    // The three key-only action types (advance_phase / convene_agent /
    // create_scope_draft) have NO source_action_id side-effect index — their
    // sole cross-run idempotency guarantee is the proposeThreadAction
    // onConflictDoNothing against (company_id, idempotency_key). By contrast
    // add_scope_item DOES carry a side-effect index (thread_scope_items_source_action_uq,
    // exercised by the thread_scope_items case above), as do post_reply and
    // create_artifact_candidate. post_reply (case 4 above) is a stable-key type
    // that ALSO carries a side-effect index; this case proves the same dedup
    // holds for a key-only type whose only protection is the action-row index.
    const svc = threadAgentActionService(db);
    const key = buildAdvancePhaseIdempotencyKey({
      threadId,
      agentId: null,
      toPhase: "scope",
      turnAnchor: "1",
    });
    const a = (await svc.proposeThreadAction({
      companyId,
      threadId,
      runId: null,
      agentId: null,
      actionType: "advance_phase",
      payload: { toPhase: "scope" },
      idempotencyKey: key,
    })) as { id: string };
    // Re-propose the identical transition from a different (null) run → same
    // stable key → onConflictDoNothing suppresses the insert and the canonical
    // row is re-selected and returned.
    const b = (await svc.proposeThreadAction({
      companyId,
      threadId,
      runId: null,
      agentId: null,
      actionType: "advance_phase",
      payload: { toPhase: "scope" },
      idempotencyKey: key,
    })) as { id: string };

    expect(b.id).toBe(a.id);
    const count = rowsOf(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM thread_agent_actions
        WHERE company_id = ${companyId} AND idempotency_key = ${key}
      `),
    );
    expect(Number(count[0].n)).toBe(1);
  });

  it("thread-scoped commit drains a prior run's proposed row (cross-run)", async () => {
    if (setupError) throw new Error(String(setupError));
    // A proposed post_reply belongs to runA. The commit is invoked under runB —
    // a DIFFERENT run. Pre-PR-B the SELECT filtered `eq(runId, input.runId)`, so
    // runB would never see runA's row and `committed` would be 0. Thread-scoped
    // selection drains it: any run flushes the thread's pending actions.
    const runA = await seedRun();
    const snap = await captureSnapshot(threadId);
    const actionId = randomUUID();
    // Seed the proposed row directly. agent_id is the real seeded agent (the
    // handler blocks null agentId; author_agent_id is an FK). The freshness column
    // carries the real snapshot so the per-action freshness re-check passes.
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES
        (${actionId}, ${companyId}, ${threadId}, ${runA}, ${agentId}, 'post_reply', 'ready',
         ${JSON.stringify({ rawContent: "cross-run reply" })}::jsonb, ${`k:${actionId}`},
         ${JSON.stringify(snap)}::jsonb)
    `);

    const runB = await seedRun();
    const res = await threadAgentActionService(db).commitThreadAgentActions({
      companyId,
      threadId,
      runId: runB,
    });
    expect(res.committed).toBe(1);

    // Exactly one discussion_entries row was produced for this action (the
    // source_action_id is stamped by the post_reply commit handler).
    const n = rowsOf(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM discussion_entries WHERE source_action_id = ${actionId}
      `),
    );
    expect(Number(n[0].n)).toBe(1);

    // The action row itself is now committed and stamped with the entry it created.
    const committedRow = rowsOf(
      await db.execute(sql`
        SELECT status, committed_entry_id FROM thread_agent_actions WHERE id = ${actionId}
      `),
    );
    expect(String(committedRow[0].status)).toBe("committed");
    expect(committedRow[0].committed_entry_id).toBeTruthy();
  });

  // ── PR-B real-DB proofs (#198) ─────────────────────────────────────────────

  // Test 6 — crash-recovery convergence (THE most important).
  //
  // Reconstruct the exact torn-write a crash leaves behind: a `post_reply` action
  // stranded in `committing` PAST the reaper TTL, with its side-effect entry
  // (the discussion_entries row stamped with source_action_id) ALREADY landed
  // pre-crash. The reaper flips the stranded row committing→failed (+attempt), then
  // a fresh commit re-selects it, re-attempts the entry write, hits the partial
  // unique index (discussion_entries_source_action_uq), and converges via the
  // inner unique-violation branch — re-selecting the existing entry and stamping
  // the action `committed` WITHOUT producing a duplicate. This is the property the
  // whole #197/#198 substrate exists to guarantee: a side effect that landed once
  // can never land twice, even across a crash + reaper + re-commit.
  it("converges a crash-stranded committing row: reaper→failed, re-commit dedups via unique index (no duplicate, ends committed)", async () => {
    if (setupError) throw new Error(String(setupError));
    const svc = threadAgentActionService(db);
    const snap = await captureSnapshot(threadId);
    const actionId = randomUUID();

    // The pre-crash side effect: a discussion_entries row already stamped with
    // this action's id (input_type='agent' + the real seeded agent, matching what
    // the post_reply commit handler writes). discussion_id + source_action_id are
    // what the handler's convergence re-select keys on.
    await db.execute(sql`
      INSERT INTO discussion_entries
        (id, discussion_id, input_type, raw_content, author_agent_id, source_action_id, created_by)
      VALUES
        (gen_random_uuid(), ${threadId}, 'agent', 'pre-crash reply', ${agentId}, ${actionId}, ${`agent:${agentId}`})
    `);

    // The torn action: stuck in 'committing', last touched 20 minutes ago (well
    // past STALE_COMMITTING_TTL_MS = 10m). Carries the real freshness snapshot and
    // a valid post_reply payload so the post-reap re-commit reaches the entry write.
    const runA = await seedRun();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness, updated_at)
      VALUES
        (${actionId}, ${companyId}, ${threadId}, ${runA}, ${agentId}, 'post_reply', 'committing',
         ${JSON.stringify({ rawContent: "pre-crash reply" })}::jsonb, ${`k:${actionId}`},
         ${JSON.stringify(snap)}::jsonb, now() - interval '20 minutes')
    `);

    // Reaper flips the stranded committing row → failed (+ bumps attempt_count to 1).
    const reap = await reapStaleThreadAgentActions(db, { now: new Date() });
    expect(reap.reaped).toBeGreaterThanOrEqual(1);

    const afterReap = rowsOf(
      await db.execute(sql`
        SELECT status, attempt_count FROM thread_agent_actions WHERE id = ${actionId}
      `),
    );
    expect(String(afterReap[0].status)).toBe("failed");
    expect(Number(afterReap[0].attempt_count)).toBe(1);

    // Re-commit under a DIFFERENT run. The failed row (attempt 1 < max 3) is
    // re-selected, claimed (fence on attempt_count=1), and the entry re-write hits
    // the unique index → convergence branch.
    const runB = await seedRun();
    const res = await svc.commitThreadAgentActions({ companyId, threadId, runId: runB });
    expect(res.committed).toBe(1);
    expect(res.failed).toBe(0);

    // No duplicate: exactly ONE discussion_entries row carries this source_action_id.
    const entryCount = rowsOf(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM discussion_entries WHERE source_action_id = ${actionId}
      `),
    );
    expect(Number(entryCount[0].n)).toBe(1);

    // The action converged to committed and is stamped with the PRE-EXISTING entry
    // (not stuck/looping in failed/committing).
    const finalRow = rowsOf(
      await db.execute(sql`
        SELECT status, committed_entry_id FROM thread_agent_actions WHERE id = ${actionId}
      `),
    );
    expect(String(finalRow[0].status)).toBe("committed");
    expect(finalRow[0].committed_entry_id).toBeTruthy();
  });

  // Test 7 — poison-row attempt cap (no livelock).
  //
  // A permanently-failing action must NOT be retried forever. We seed a post_reply
  // whose payload.parentEntryId points at a non-existent entry: discussionService
  // .addEntry validates the parent belongs to the thread and throws badRequest. That
  // throw is NOT a unique violation, so the inner catch re-throws → the outer commit
  // catch sets status='failed' + bumps attempt_count (the genuine failed-retry loop,
  // not a terminal blocked_policy first-try). Driven maxAttempts+1 times, the failing
  // row climbs to attempt_count >= max_attempts and the commit SELECT
  // (status='failed' AND attempt_count < max_attempts) stops re-selecting it — while
  // a sibling always-succeeding post_reply on the SAME thread commits normally. This
  // proves the poison pill self-limits without starving healthy work.
  it("caps a permanently-failing action at max_attempts and stops re-selecting it (no livelock); a healthy sibling still commits", async () => {
    if (setupError) throw new Error(String(setupError));
    const svc = threadAgentActionService(db);

    // The healthy action: a valid post_reply that commits on the first tick.
    const goodSnap = await captureSnapshot(threadId);
    const goodId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES
        (${goodId}, ${companyId}, ${threadId}, NULL, ${agentId}, 'post_reply', 'ready',
         ${JSON.stringify({ rawContent: "healthy reply" })}::jsonb, ${`k:good:${goodId}`},
         ${JSON.stringify(goodSnap)}::jsonb)
    `);

    // The poison action: a post_reply pointing at a bogus parentEntryId. addEntry
    // throws badRequest("parentEntryId must reference an entry in the same
    // discussion") on EVERY attempt → the commit catch marks it failed + bumps.
    const poisonSnap = await captureSnapshot(threadId);
    const poisonId = randomUUID();
    const bogusParent = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES
        (${poisonId}, ${companyId}, ${threadId}, NULL, ${agentId}, 'post_reply', 'ready',
         ${JSON.stringify({ rawContent: "poison reply", parentEntryId: bogusParent })}::jsonb,
         ${`k:poison:${poisonId}`}, ${JSON.stringify(poisonSnap)}::jsonb)
    `);

    // Drive commit maxAttempts+1 (=4) times. Each tick the poison row is re-picked
    // while attempt_count < max_attempts (3), fails, and bumps; once it reaches 3 it
    // is no longer re-selected.
    for (let i = 0; i < 4; i++) {
      await svc.commitThreadAgentActions({ companyId, threadId, runId: await seedRun() });
    }

    // Poison row: failed and at/over the cap.
    const poisonRow = rowsOf(
      await db.execute(sql`
        SELECT status, attempt_count, max_attempts FROM thread_agent_actions WHERE id = ${poisonId}
      `),
    );
    expect(String(poisonRow[0].status)).toBe("failed");
    expect(Number(poisonRow[0].attempt_count)).toBeGreaterThanOrEqual(
      Number(poisonRow[0].max_attempts),
    );

    // Direct proof it is NOT in the commit's selected set anymore: the SELECT
    // predicate is (status='ready') OR (status='failed' AND attempt_count <
    // max_attempts). The poison row matches neither.
    const selectable = rowsOf(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM thread_agent_actions
        WHERE id = ${poisonId}
          AND (status = 'ready'
               OR (status = 'failed' AND attempt_count < max_attempts))
      `),
    );
    expect(Number(selectable[0].n)).toBe(0);

    // The healthy sibling committed (proving the poison row never starved it).
    const goodRow = rowsOf(
      await db.execute(sql`
        SELECT status, committed_entry_id FROM thread_agent_actions WHERE id = ${goodId}
      `),
    );
    expect(String(goodRow[0].status)).toBe("committed");
    expect(goodRow[0].committed_entry_id).toBeTruthy();
  });

  // Test 8 — snapshot_unavailable suppresses for EVERY action type.
  //
  // The per-action freshness re-check runs FIRST in the commit loop — before the
  // claim CAS and before any per-type payload validation. An empty freshness ('{}')
  // is detected by isSnapshotUnavailable (it carries neither the always-present
  // string threadId nor numeric entrySeq) → compareFreshnessSnapshot returns
  // { fresh:false, reason:"snapshot_unavailable" } → the action is marked
  // suppressed_stale and counted in result.suppressed, REGARDLESS of action type or
  // payload validity. This is what prevents a dropped run/turn from replaying an old
  // empty-snapshot row out of turn. We seed one proposed row of each of the six
  // types (minimal valid payloads, but they're never reached) and assert all six
  // suppress and none commit.
  it("suppresses an empty-snapshot row (snapshot_unavailable) for all six action types; none commit", async () => {
    if (setupError) throw new Error(String(setupError));
    const svc = threadAgentActionService(db);

    // One isolated thread so this test's six rows are the only pending actions the
    // thread-scoped commit drains (no interference from rows left by other tests).
    const [t8] = rowsOf(
      await db.execute(sql`
        INSERT INTO discussions (id, company_id, status, created_by)
        VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test')
        RETURNING id
      `),
    );
    const t8Id = String(t8.id);

    // Minimal valid payload per type (read off each handler's required keys). These
    // are intentionally well-formed so a FAILURE here can only come from the
    // snapshot gate, not a payload-validation block — but the freshness gate fires
    // before any of them is inspected.
    const seeds: Array<{ type: string; payload: Record<string, unknown> }> = [
      { type: "post_reply", payload: { rawContent: "x" } },
      { type: "advance_phase", payload: { toPhase: "scope", effectiveAutonomy: 2 } },
      { type: "convene_agent", payload: { targetAgentId: agentId } },
      { type: "add_scope_item", payload: { kind: "decision", title: "x" } },
      { type: "create_artifact_candidate", payload: { title: "x" } },
      { type: "create_scope_draft", payload: { summary: "x" } },
    ];

    for (const seed of seeds) {
      const id = randomUUID();
      // freshness = '{}'::jsonb → snapshot_unavailable.
      await db.execute(sql`
        INSERT INTO thread_agent_actions
          (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
        VALUES
          (${id}, ${companyId}, ${t8Id}, NULL, ${agentId}, ${seed.type}, 'ready',
           ${JSON.stringify(seed.payload)}::jsonb, ${`k:t8:${seed.type}:${id}`}, '{}'::jsonb)
      `);
    }

    const res = await svc.commitThreadAgentActions({ companyId, threadId: t8Id, runId: await seedRun() });
    expect(res.committed).toBe(0);
    expect(res.suppressed).toBe(6);

    // Zero rows on this thread reached 'committed'; all six are suppressed_stale.
    const committedCount = rowsOf(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM thread_agent_actions
        WHERE thread_id = ${t8Id} AND status = 'committed'
      `),
    );
    expect(Number(committedCount[0].n)).toBe(0);

    const suppressedCount = rowsOf(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM thread_agent_actions
        WHERE thread_id = ${t8Id} AND status = 'suppressed_stale'
      `),
    );
    expect(Number(suppressedCount[0].n)).toBe(6);
  });

  // Test 9 — two-connection concurrency (won/lost split).
  //
  // Two independent postgres connections (db / db2, each its own pool against the
  // same embedded-postgres DB) race to commit the SAME proposed post_reply. The
  // fenced CAS claim (claimActionForCommit: UPDATE … WHERE status IN
  // ('ready','failed') AND attempt_count = observed) lets exactly ONE committer
  // win the row; the loser's UPDATE touches 0 rows and it skips the action. Plus the
  // discussion_entries_source_action_uq partial index is the side-effect backstop.
  // Timing-independent assertions: exactly one discussion_entries row for the action,
  // and committed counts sum to exactly 1 across the two results.
  it("two real connections racing the same proposed action: exactly one wins the fenced claim, one entry total", async () => {
    if (setupError) throw new Error(String(setupError));

    // A genuine SECOND pool against the same DB. createDb() opens a fresh
    // postgres() connection per call → real cross-connection contention.
    const db2 = createDb(connectionString) as Db;

    const snap = await captureSnapshot(threadId);
    const actionId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES
        (${actionId}, ${companyId}, ${threadId}, NULL, ${agentId}, 'post_reply', 'ready',
         ${JSON.stringify({ rawContent: "raced reply" })}::jsonb, ${`k:race:${actionId}`},
         ${JSON.stringify(snap)}::jsonb)
    `);

    const svc1 = threadAgentActionService(db);
    const svc2 = threadAgentActionService(db2);
    const runA = await seedRun();
    const runB = await seedRun();

    const [r1, r2] = await Promise.all([
      svc1.commitThreadAgentActions({ companyId, threadId, runId: runA }),
      svc2.commitThreadAgentActions({ companyId, threadId, runId: runB }),
    ]);

    // Exactly one committer claimed + committed the row.
    expect(r1.committed + r2.committed).toBe(1);

    // Exactly one discussion_entries row was produced (the unique-index + fenced-CAS
    // backstop held under genuine two-connection contention).
    const entryCount = rowsOf(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM discussion_entries WHERE source_action_id = ${actionId}
      `),
    );
    expect(Number(entryCount[0].n)).toBe(1);

    // The action row converged to committed exactly once.
    const finalRow = rowsOf(
      await db.execute(sql`
        SELECT status, committed_entry_id FROM thread_agent_actions WHERE id = ${actionId}
      `),
    );
    expect(String(finalRow[0].status)).toBe("committed");
    expect(finalRow[0].committed_entry_id).toBeTruthy();
  });

  // Test 9b — same-key composer sends must not drift the denormalized counters
  // (PR #291 review). Two independent connections race addEntry with the SAME
  // clientSubmissionId: both can miss the replay pre-check; the loser's insert
  // no-ops via the (discussion_id, client_submission_id) partial unique index,
  // and its transaction must ABORT so its entrySeq/entryCount/lastEntryAt bump
  // rolls back. Timing-independent: whatever the interleaving (pre-check catch
  // vs conflict path), the end state is exactly ONE entry per key, and
  // entry_count == entry_seq == number of durable entries. Five raced pairs on
  // one thread widen the window so at least some pairs hit the conflict path.
  it("racing the same clientSubmissionId on two connections never drifts entryCount/entrySeq", async () => {
    if (setupError) throw new Error(String(setupError));
    const [t9b] = rowsOf(
      await db.execute(sql`
        INSERT INTO discussions (id, company_id, status, created_by)
        VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test')
        RETURNING id
      `),
    );
    const t9bId = String(t9b.id);
    const db2 = createDb(connectionString) as Db;
    const svc1 = discussionService(db);
    const svc2 = discussionService(db2);

    const PAIRS = 5;
    for (let i = 0; i < PAIRS; i++) {
      const key = `race:${i}:${randomUUID()}`;
      const [a, b] = await Promise.all([
        svc1.addEntry(
          companyId,
          t9bId,
          { inputType: "write", rawContent: `raced entry ${i}`, clientSubmissionId: key },
          "integration-test",
        ),
        svc2.addEntry(
          companyId,
          t9bId,
          { inputType: "write", rawContent: `raced entry ${i}`, clientSubmissionId: key },
          "integration-test",
        ),
      ]);
      // Both callers converge on the same durable row.
      expect(a?.id).toBeTruthy();
      expect(b?.id).toBe(a?.id);
    }

    // Exactly one entry per key, and the denormalized counters match reality —
    // no +1-with-no-row drift, no burned seq from a rolled-back loser.
    const [entries] = rowsOf(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM discussion_entries WHERE discussion_id = ${t9bId}
      `),
    );
    expect(Number(entries.n)).toBe(PAIRS);
    const [counters] = rowsOf(
      await db.execute(sql`
        SELECT entry_count::int AS c, entry_seq::int AS s FROM discussions WHERE id = ${t9bId}
      `),
    );
    expect(Number(counters.c)).toBe(PAIRS);
    expect(Number(counters.s)).toBe(PAIRS);
  });

  // Test 10 — convene wakeup dedup discriminated by stable sourceActionId (PR-B2 / #202 P2).
  //
  // Two genuinely-DISTINCT convene_agent actions to the SAME target on the SAME thread
  // (distinct action ids, distinct payloads) must BOTH enqueue a queued
  // agent_wakeup_requests row — the old `${target}:${thread}:queued` key collapsed them
  // to one (the swallowed-second-dispatch bug). Because the new dedupKey is discriminated
  // by the committing action.id, their dedupKeys differ → the partial unique index
  // (agent_wakeup_requests_dedup_key_queued_uq) lets both insert. Then a re-commit of the
  // SAME action id (idempotent re-run) collapses to one: the still-queued row blocks the
  // duplicate via onConflictDoNothing. The seeded target reuses the integration agent (a
  // valid in-company targetAgentId — the handler blocks targets outside the company).
  it("two distinct convene_agent actions both enqueue a queued wakeup (discriminated dedupKey); a same-action re-commit collapses to one", async () => {
    if (setupError) throw new Error(String(setupError));

    // Isolated thread so this test's wakeup rows + actions are the only pending work
    // the thread-scoped commit drains (no interference from other tests' rows).
    const [t10] = rowsOf(
      await db.execute(sql`
        INSERT INTO discussions (id, company_id, status, created_by)
        VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test')
        RETURNING id
      `),
    );
    const t10Id = String(t10.id);

    const svc = threadAgentActionService(db);
    const snap = await captureSnapshot(t10Id);
    const runA = await seedRun();
    const actionId1 = randomUUID();
    const actionId2 = randomUUID();

    // Two distinct proposed convene_agent actions: same target (the seeded agent), same
    // thread, DISTINCT ids + DISTINCT payloads (different reason/context). Real freshness
    // snapshot so the per-action freshness re-check passes (an empty snapshot would
    // suppress them as snapshot_unavailable). agent_id is the seeded agent (the handler
    // does not gate convene on a null agentId, but seeding a real one matches the harness).
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES
        (${actionId1}, ${companyId}, ${t10Id}, ${runA}, ${agentId}, 'convene_agent', 'ready',
         ${JSON.stringify({ targetAgentId: agentId, reason: "review pass", context: { hop: 1 } })}::jsonb,
         ${`k:convene:${actionId1}`}, ${JSON.stringify(snap)}::jsonb)
    `);
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES
        (${actionId2}, ${companyId}, ${t10Id}, ${runA}, ${agentId}, 'convene_agent', 'ready',
         ${JSON.stringify({ targetAgentId: agentId, reason: "second pass", context: { hop: 2 } })}::jsonb,
         ${`k:convene:${actionId2}`}, ${JSON.stringify(snap)}::jsonb)
    `);

    const res = await svc.commitThreadAgentActions({ companyId, threadId: t10Id, runId: await seedRun() });
    expect(res.committed).toBe(2);

    // BOTH distinct actions enqueued a queued wakeup for the target — the discriminated
    // dedupKey (keyed on the stable sourceActionId) kept them apart.
    const queuedCount = rowsOf(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM agent_wakeup_requests
        WHERE company_id = ${companyId}
          AND agent_id = ${agentId}
          AND status = 'queued'
          AND source = 'agent.dispatch'
          AND dedup_key LIKE ${`${agentId}:${t10Id}:%:queued`}
      `),
    );
    expect(Number(queuedCount[0].n)).toBe(2);

    // SAME-action collapse: a second wakeup carrying the SAME committing action id (a
    // claim race / idempotent re-fire of actionId1) must NOT double-enqueue. Recompute
    // actionId1's exact dedupKey and attempt the duplicate insert through the same path
    // the handler uses (bare onConflictDoNothing). The still-queued first row blocks it
    // via the partial unique index → no row returned, queued count unchanged at 2.
    const dupKey = buildConveneWakeupDedupKey({
      targetAgentId: agentId,
      threadId: t10Id,
      sourceActionId: actionId1,
    });
    const dupInsert = rowsOf(
      await db.execute(sql`
        INSERT INTO agent_wakeup_requests (id, company_id, agent_id, source, reason, status, dedup_key)
        VALUES (gen_random_uuid(), ${companyId}, ${agentId}, 'agent.dispatch', 'review pass', 'queued', ${dupKey})
        ON CONFLICT DO NOTHING
        RETURNING id
      `),
    );
    expect(dupInsert.length).toBe(0); // collapsed — the queued row blocked the duplicate.

    const queuedCountAfter = rowsOf(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM agent_wakeup_requests
        WHERE company_id = ${companyId}
          AND agent_id = ${agentId}
          AND status = 'queued'
          AND source = 'agent.dispatch'
          AND dedup_key LIKE ${`${agentId}:${t10Id}:%:queued`}
      `),
    );
    expect(Number(queuedCountAfter[0].n)).toBe(2); // still 2 — same-action re-fire collapsed.
  });

  // ── F1 / F2 fix verification (post-sweep) ──────────────────────────────────
  // The cross-run sweep flagged two regressions; both were REPRODUCED against this
  // real commit path (a fresh post_reply terminally dropped by an unrelated scope
  // bump; a stale advance_phase applied as a backward jump that regressed the phase).
  // The freshness gate is now action-type-aware: newer_scope_version no longer
  // suppresses scope-INDEPENDENT actions (F1), and a new phase_changed reason
  // suppresses a stale PHASE-coupled advance (F2). These tests verify the fix AND
  // guard the still-correct cases (scope-coupled action still suppressed; a fresh
  // same-run advance still commits forward) so the fix stays targeted.

  // REPRO F1 — a fresh, scope-independent post_reply is terminally suppressed merely
  // because the thread's scope version advanced between snapshot capture and commit.
  //
  // newer_scope_version (thread-agent-action-freshness.ts:158-162) is action-type
  // AGNOSTIC: it fires on ANY change to latestScopeVersionId regardless of whether the
  // committing action depends on scope. A post_reply only adds a comment — a scope bump
  // does not invalidate it — yet it is marked suppressed_stale (terminal: never
  // re-selected by the thread-scoped SELECT; revived only on an explicit re-propose,
  // which a one-shot crew run does not do; the participation runner accepts the
  // suppression as "benign" with no retry — thread-participation-runner.ts:213-245).
  it("FIX F1: a fresh post_reply is NOT suppressed by an unrelated scope-version bump — it commits", async () => {
    if (setupError) throw new Error(String(setupError));
    const svc = threadAgentActionService(db);

    const [tF1] = rowsOf(
      await db.execute(sql`
        INSERT INTO discussions (id, company_id, status, created_by)
        VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test')
        RETURNING id
      `),
    );
    const tF1Id = String(tF1.id);

    // v1 exists at snapshot capture time.
    await db.execute(sql`
      INSERT INTO thread_scope_versions
        (id, company_id, thread_id, version_number, status, source_start_seq, source_end_seq, summary, created_by)
      VALUES
        (gen_random_uuid(), ${companyId}, ${tF1Id}, 1, 'accepted', 0, 0, 'v1', 'integration-test')
    `);

    const snap = await captureSnapshot(tF1Id); // latestScopeVersionId = v1

    const replyId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES
        (${replyId}, ${companyId}, ${tF1Id}, NULL, ${agentId}, 'post_reply', 'ready',
         ${JSON.stringify({ rawContent: "a fresh, scope-independent reply" })}::jsonb,
         ${`k:f1:${replyId}`}, ${JSON.stringify(snap)}::jsonb)
    `);

    // A sibling/concurrent scope action mints v2 BEFORE this reply is committed.
    await db.execute(sql`
      INSERT INTO thread_scope_versions
        (id, company_id, thread_id, version_number, status, source_start_seq, source_end_seq, summary, created_by)
      VALUES
        (gen_random_uuid(), ${companyId}, ${tF1Id}, 2, 'draft', 0, 0, 'v2', 'integration-test')
    `);

    const res = await svc.commitThreadAgentActions({ companyId, threadId: tF1Id, runId: await seedRun() });

    const [row] = rowsOf(
      await db.execute(sql`SELECT status, blocked_reason FROM thread_agent_actions WHERE id = ${replyId}`),
    );
    const entryCount = rowsOf(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM discussion_entries
        WHERE discussion_id = ${tF1Id} AND source_action_id = ${replyId}
      `),
    );
    // eslint-disable-next-line no-console
    console.log("[FIX F1] reply:", row.status, row.blocked_reason, "entries:", entryCount[0].n, "result:", JSON.stringify(res));

    // FIX (F1): post_reply is scope-INDEPENDENT, so the unrelated scope bump no longer
    // suppresses it — the reply COMMITS and its entry is written.
    expect(String(row.status)).toBe("committed");
    expect(row.blocked_reason == null).toBe(true);
    expect(Number(entryCount[0].n)).toBe(1); // the reply landed
    expect(res.committed).toBe(1);
    expect(res.suppressed).toBe(0);
  });

  // REPRO F2 — a stale advance_phase, drained by a later thread-scoped commit, is NOT
  // guarded by freshness on the PHASE axis and is applied as a BACKWARD jump, regressing
  // the thread's phase.
  //
  // compareFreshnessSnapshot suppresses on phase ONLY when current.threadPhase === 'done'
  // (freshness.ts:150) — it captures snapshot.threadPhase (freshness.ts:95) but never
  // compares it. canAdvancePhase (threads.ts:66-73) permits ANY backward jump with no
  // actor/human gate, and the commit handler (thread-agent-actions.ts:907-945) calls
  // advancePhase with isHuman:false and never re-validates toPhase against the live phase.
  //
  // Re-cycle precondition: a scope version (v1) ALREADY exists when the snapshot is
  // captured, and the thread then progresses forward WITHOUT minting a new scope version
  // or adding a human entry — so newer_scope_version / newer_human_entry do NOT
  // incidentally catch the stale advance. (The common no-pre-existing-version path IS
  // incidentally guarded: reaching scope mints v1 ≠ snapshot null → newer_scope_version.)
  it("FIX F2: a stale advance_phase is suppressed (phase_changed) and does NOT regress the thread phase", async () => {
    if (setupError) throw new Error(String(setupError));
    const svc = threadAgentActionService(db);

    // The thread is CLAIMED (owner_user_id set to a human). This matters: the
    // commit applies advance_phase with a hardcoded team_member agent actor, and
    // canViewThread (threads.ts:120-126) blocks a team_member from viewing an
    // UNCLAIMED thread (ownerUserId null → only a scoped team_lead may view) — so
    // an unclaimed thread is incidentally guarded (assertCanView throws "Thread not
    // found"). A claimed, company-visible, unscoped thread (the common case when a
    // founder is in the loop) IS viewable (hasScopeAccess || isParticipant), so the
    // agent advance passes authz and the freshness/phase mechanism is exercised.
    const [tF2] = rowsOf(
      await db.execute(sql`
        INSERT INTO discussions (id, company_id, status, created_by, owner_user_id)
        VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test', 'founder-user-1')
        RETURNING id
      `),
    );
    const tF2Id = String(tF2.id);

    // Re-cycle precondition: v1 exists BEFORE the snapshot; thread phase defaults to 'discuss'.
    await db.execute(sql`
      INSERT INTO thread_scope_versions
        (id, company_id, thread_id, version_number, status, source_start_seq, source_end_seq, summary, created_by)
      VALUES
        (gen_random_uuid(), ${companyId}, ${tF2Id}, 1, 'accepted', 0, 0, 'v1', 'integration-test')
    `);

    const snap = await captureSnapshot(tF2Id); // threadPhase = 'discuss', latestScopeVersionId = v1

    // Run A's once-valid forward advance (discuss→scope), now stranded as a proposed row.
    const advId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES
        (${advId}, ${companyId}, ${tF2Id}, NULL, ${agentId}, 'advance_phase', 'ready',
         ${JSON.stringify({ toPhase: "scope", effectiveAutonomy: 2 })}::jsonb,
         ${`k:f2:${advId}`}, ${JSON.stringify(snap)}::jsonb)
    `);

    // The thread progressed forward to 'assign' REUSING v1 (no new scope version, no human
    // entry) — so the stale advance's snapshot still matches live scope/human state.
    await db.execute(sql`UPDATE discussions SET phase = 'assign' WHERE id = ${tF2Id}`);

    const res = await svc.commitThreadAgentActions({ companyId, threadId: tF2Id, runId: await seedRun() });

    const [thread] = rowsOf(await db.execute(sql`SELECT phase FROM discussions WHERE id = ${tF2Id}`));
    const [row] = rowsOf(
      await db.execute(sql`SELECT status, blocked_reason FROM thread_agent_actions WHERE id = ${advId}`),
    );
    // eslint-disable-next-line no-console
    console.log("[FIX F2] final phase:", thread.phase, "action:", row.status, row.blocked_reason, "result:", JSON.stringify(res));

    // FIX (F2): the stale advance is suppressed on the phase axis — phase stays 'assign'.
    expect(String(thread.phase)).toBe("assign"); // NO regression
    expect(String(row.status)).toBe("suppressed_stale");
    expect(String(row.blocked_reason)).toBe("phase_changed");
  });

  // GUARD F1 — the scope-version exemption is NARROW: a SCOPE-COUPLED action
  // (add_scope_item) is still suppressed by a scope-version bump. Proves the F1 fix
  // only exempts scope-INDEPENDENT actions (post_reply/convene), not scope actions.
  it("GUARD F1: a scope-coupled add_scope_item IS still suppressed by a scope-version bump", async () => {
    if (setupError) throw new Error(String(setupError));
    const svc = threadAgentActionService(db);

    const [tG1] = rowsOf(
      await db.execute(sql`
        INSERT INTO discussions (id, company_id, status, created_by)
        VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test')
        RETURNING id
      `),
    );
    const tG1Id = String(tG1.id);

    await db.execute(sql`
      INSERT INTO thread_scope_versions
        (id, company_id, thread_id, version_number, status, source_start_seq, source_end_seq, summary, created_by)
      VALUES
        (gen_random_uuid(), ${companyId}, ${tG1Id}, 1, 'accepted', 0, 0, 'v1', 'integration-test')
    `);

    const snap = await captureSnapshot(tG1Id); // latestScopeVersionId = v1

    const itemId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES
        (${itemId}, ${companyId}, ${tG1Id}, NULL, ${agentId}, 'add_scope_item', 'ready',
         ${JSON.stringify({ kind: "decision", title: "x" })}::jsonb,
         ${`k:g1:${itemId}`}, ${JSON.stringify(snap)}::jsonb)
    `);

    // Scope bump v2 before commit — a scope-coupled action MUST still be suppressed.
    await db.execute(sql`
      INSERT INTO thread_scope_versions
        (id, company_id, thread_id, version_number, status, source_start_seq, source_end_seq, summary, created_by)
      VALUES
        (gen_random_uuid(), ${companyId}, ${tG1Id}, 2, 'draft', 0, 0, 'v2', 'integration-test')
    `);

    const res = await svc.commitThreadAgentActions({ companyId, threadId: tG1Id, runId: await seedRun() });
    const [row] = rowsOf(
      await db.execute(sql`SELECT status, blocked_reason FROM thread_agent_actions WHERE id = ${itemId}`),
    );
    expect(String(row.status)).toBe("suppressed_stale");
    expect(String(row.blocked_reason)).toBe("newer_scope_version");
    expect(res.committed).toBe(0);
  });

  // A-M7 — a scope-coupled action must NOT be falsely suppressed by its OWN batch's draft.
  // Two actions drain in ONE thread-scoped batch, both carrying the SAME pre-batch snapshot
  // (latestScopeVersionId = null, no draft exists yet): create_scope_draft (ordered first) +
  // add_scope_item. The first commit mints draft v1 → the live latestScopeVersionId advances
  // past the shared snapshot. Before the A-M7 fix the sibling add_scope_item was suppressed as
  // newer_scope_version even though its commit REUSES that very draft (createDraftFromThread
  // early-returns the existing draft). With the batch-produced version id threaded into the
  // freshness check, the sibling must commit (and reuse the same draft), not be suppressed.
  it("A-M7: a sibling add_scope_item is NOT suppressed behind its OWN batch's create_scope_draft", async () => {
    if (setupError) throw new Error(String(setupError));
    const svc = threadAgentActionService(db);

    // Thread with one entry at seq=1 so createDraftFromThread has source rows to compile a draft.
    // autonomy_level=0 (Manual) keeps this thread below the W1b auto-accept gate:
    // the D18 split made crewAutonomyLevel default to Assist/1, which would
    // auto-accept the freshly-minted draft during commit and flip the version to
    // 'accepted' — the sibling add_scope_item would then hit blocked_policy instead
    // of reusing the still-'draft' version. This test asserts freshness-gate
    // sibling-suppression mechanics, not autonomy, so Manual is the correct fixture.
    const [tM7] = rowsOf(
      await db.execute(sql`
        INSERT INTO discussions (id, company_id, status, created_by, entry_seq, autonomy_level)
        VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test', 1, 0)
        RETURNING id
      `),
    );
    const tM7Id = String(tM7.id);
    // W2 (extract-then-scope): create_scope_draft now runs CLI extraction over
    // never-extracted entries first. On a CLI-less box (CI) that attempt FAILS,
    // the failure caps the draft range below its start, and no draft is minted —
    // which would break this test's real assertion (freshness-gate mechanics,
    // not extraction). Seed the entry already-captured: extraction completed +
    // a pending extracted item, so the compile has a real card and extraction
    // finds nothing eligible to attempt.
    const [m7Entry] = rowsOf(
      await db.execute(sql`
        INSERT INTO discussion_entries (id, discussion_id, input_type, raw_content, author_agent_id, created_by, seq, extraction_status)
        VALUES (gen_random_uuid(), ${tM7Id}, 'write', 'we should ship X', NULL, 'human-user', 1, 'completed')
        RETURNING id
      `),
    );
    await db.execute(sql`
      INSERT INTO discussion_extracted_items (id, discussion_entry_id, type, title, status)
      VALUES (gen_random_uuid(), ${String(m7Entry.id)}, 'task', 'ship X', 'pending')
    `);

    // Shared snapshot captured at run start: NO scope version exists yet → latestScopeVersionId = null.
    const snap = await captureSnapshot(tM7Id);
    const runId = await seedRun();

    // create_scope_draft ordered FIRST (earlier created_at), add_scope_item SECOND, same batch + snapshot.
    const draftActionId = randomUUID();
    const itemActionId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness, created_at)
      VALUES
        (${draftActionId}, ${companyId}, ${tM7Id}, ${runId}, ${agentId}, 'create_scope_draft', 'ready',
         ${JSON.stringify({ summary: "draft from batch" })}::jsonb,
         ${`k:m7d:${draftActionId}`}, ${JSON.stringify(snap)}::jsonb, now() - interval '2 seconds'),
        (${itemActionId}, ${companyId}, ${tM7Id}, ${runId}, ${agentId}, 'add_scope_item', 'ready',
         ${JSON.stringify({ kind: "decision", title: "ship X" })}::jsonb,
         ${`k:m7i:${itemActionId}`}, ${JSON.stringify(snap)}::jsonb, now() - interval '1 second')
    `);

    const res = await svc.commitThreadAgentActions({ companyId, threadId: tM7Id, runId });

    const [draftRow] = rowsOf(
      await db.execute(sql`SELECT status FROM thread_agent_actions WHERE id = ${draftActionId}`),
    );
    const [itemRow] = rowsOf(
      await db.execute(
        sql`SELECT status, blocked_reason, committed_scope_version_id FROM thread_agent_actions WHERE id = ${itemActionId}`,
      ),
    );

    // The sibling add_scope_item must NOT be suppressed_stale — it commits, reusing the draft.
    expect(String(draftRow.status)).toBe("committed");
    expect(String(itemRow.status)).toBe("committed");
    expect(itemRow.blocked_reason).toBeNull();
    expect(res.committed).toBe(2);
    expect(res.suppressed).toBe(0);

    // Both committed against the SAME draft (createDraftFromThread early-returned the existing draft).
    const [draftCommitted] = rowsOf(
      await db.execute(sql`SELECT committed_scope_version_id FROM thread_agent_actions WHERE id = ${draftActionId}`),
    );
    expect(String(itemRow.committed_scope_version_id)).toBe(String(draftCommitted.committed_scope_version_id));

    // Exactly ONE draft scope version exists for the thread (no duplicate draft was minted).
    const draftCount = rowsOf(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM thread_scope_versions
        WHERE thread_id = ${tM7Id} AND status = 'draft'
      `),
    );
    expect(Number(draftCount[0].n)).toBe(1);
  });

  // GUARD F2 — the phase guard does NOT break a legitimate advance: when the snapshot
  // phase matches the live phase (the normal same-run case), advance_phase still
  // commits and moves the thread forward (discuss→scope).
  it("GUARD F2: a non-stale advance_phase still commits and advances the phase forward", async () => {
    if (setupError) throw new Error(String(setupError));
    const svc = threadAgentActionService(db);

    // Claimed thread so the agent advance passes assertCanView; phase defaults to 'discuss'.
    const [tG2] = rowsOf(
      await db.execute(sql`
        INSERT INTO discussions (id, company_id, status, created_by, owner_user_id)
        VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test', 'founder-user-1')
        RETURNING id
      `),
    );
    const tG2Id = String(tG2.id);

    const snap = await captureSnapshot(tG2Id); // threadPhase = 'discuss'

    // A fresh advance discuss→scope; the live phase is NOT moved (snapshot == live).
    const advId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES
        (${advId}, ${companyId}, ${tG2Id}, NULL, ${agentId}, 'advance_phase', 'ready',
         ${JSON.stringify({ toPhase: "scope", effectiveAutonomy: 2 })}::jsonb,
         ${`k:g2:${advId}`}, ${JSON.stringify(snap)}::jsonb)
    `);

    const res = await svc.commitThreadAgentActions({ companyId, threadId: tG2Id, runId: await seedRun() });
    const [thread] = rowsOf(await db.execute(sql`SELECT phase FROM discussions WHERE id = ${tG2Id}`));
    const [row] = rowsOf(
      await db.execute(sql`SELECT status, blocked_reason FROM thread_agent_actions WHERE id = ${advId}`),
    );
    expect(String(thread.phase)).toBe("scope"); // advanced forward
    expect(String(row.status)).toBe("committed");
    expect(res.committed).toBe(1);
  });

  // FIX #3 (reaper re-arm) — Codex P2: the reaper flips a crash-stranded committing row to
  // failed AND re-arms the controller (pendingRun=true) so the next sweep re-drives it,
  // instead of leaving the now-retryable row until an unrelated future trigger.
  it("FIX #3 reaper: flips a stale committing row to failed AND sets pendingRun on its thread", async () => {
    if (setupError) throw new Error(String(setupError));

    const [tR] = rowsOf(
      await db.execute(sql`
        INSERT INTO discussions (id, company_id, status, created_by)
        VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test')
        RETURNING id
      `),
    );
    const tRId = String(tR.id);

    // Controller currently NOT scheduled (pendingRun=false).
    await db.execute(sql`
      INSERT INTO thread_orchestration_state (thread_id, pending_run) VALUES (${tRId}, false)
    `);

    // A crash-stranded committing row, last touched well before the TTL cutoff.
    const stuckId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness, updated_at)
      VALUES
        (${stuckId}, ${companyId}, ${tRId}, NULL, ${agentId}, 'post_reply', 'committing',
         ${JSON.stringify({ rawContent: "stranded" })}::jsonb, ${`k:reap:${stuckId}`}, '{}'::jsonb,
         now() - interval '1 hour')
    `);

    const res = await reapStaleThreadAgentActions(db, { ttlMs: 1000 });
    expect(res.reaped).toBeGreaterThanOrEqual(1);

    const [row] = rowsOf(await db.execute(sql`SELECT status FROM thread_agent_actions WHERE id = ${stuckId}`));
    const [ctrl] = rowsOf(
      await db.execute(sql`SELECT pending_run FROM thread_orchestration_state WHERE thread_id = ${tRId}`),
    );
    expect(String(row.status)).toBe("failed");
    expect(ctrl.pending_run).toBe(true); // controller re-armed so the next sweep re-drives
  });

  // FIX #2 (run-scoped fallback attach) — Codex P2: with the thread-scoped SELECT draining
  // rows from multiple runs, a stranded run-A artifact candidate (no explicit entry) must
  // NOT be auto-attached to a run-B reply. Run-keyed attach state keeps them apart.
  it("FIX #2: a run-A artifact candidate is NOT auto-attached to a run-B reply (cross-run drain)", async () => {
    if (setupError) throw new Error(String(setupError));

    const [tA] = rowsOf(
      await db.execute(sql`
        INSERT INTO discussions (id, company_id, status, created_by)
        VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test')
        RETURNING id
      `),
    );
    const tAId = String(tA.id);

    // The artifact commit calls createDraftFromThread, which returns `no_entries`
    // (and the artifact would block) on a thread with zero entries — seed one so the
    // artifact actually commits and the cross-run attach guard is genuinely exercised.
    await discussionService(db).addEntry(
      companyId,
      tAId,
      { inputType: "write", rawContent: "scope me" },
      "integration-test",
    );

    const runA = await seedRun();
    const runB = await seedRun();
    const snap = await captureSnapshot(tAId);

    // Artifact candidate from run-A, no explicit attach target, ordered FIRST (so when it
    // commits there is no reply yet → it accumulates under run-A's fallback bucket).
    const artId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness, created_at)
      VALUES
        (${artId}, ${companyId}, ${tAId}, ${runA}, ${agentId}, 'create_artifact_candidate', 'ready',
         ${JSON.stringify({ title: "Spec", artifactType: "document", content: "# Spec" })}::jsonb,
         ${`k:art:${artId}`}, ${JSON.stringify(snap)}::jsonb, now() - interval '2 seconds')
    `);
    // Reply from run-B, ordered SECOND.
    const replyId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness, created_at)
      VALUES
        (${replyId}, ${companyId}, ${tAId}, ${runB}, ${agentId}, 'post_reply', 'ready',
         ${JSON.stringify({ rawContent: "run B reply" })}::jsonb,
         ${`k:rep:${replyId}`}, ${JSON.stringify(snap)}::jsonb, now() - interval '1 second')
    `);

    await threadAgentActionService(db).commitThreadAgentActions({
      companyId,
      threadId: tAId,
      runId: await seedRun(),
    });

    // The artifact path actually ran (guard is exercised, not vacuous) ...
    const [artRow] = rowsOf(await db.execute(sql`SELECT status FROM thread_agent_actions WHERE id = ${artId}`));
    expect(String(artRow.status)).toBe("committed");
    // ... the run-B reply entry exists ...
    const [replyEntry] = rowsOf(
      await db.execute(
        sql`SELECT id FROM discussion_entries WHERE discussion_id = ${tAId} AND source_action_id = ${replyId}`,
      ),
    );
    expect(replyEntry?.id).toBeTruthy();
    // ... but the run-A artifact was NOT auto-attached to it (cross-run guard).
    const attachCount = rowsOf(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM discussion_entry_attachments
        WHERE discussion_entry_id = ${String(replyEntry.id)}
      `),
    );
    expect(Number(attachCount[0].n)).toBe(0);
  });

  // FIX #A (non-idempotent retry exclusion) — Codex P2: a reaped/failed convene_agent or
  // create_scope_draft must NOT be re-selected for retry (re-running would duplicate the
  // wakeup / scope version), while idempotent types (post_reply) still retry.
  it("FIX #A: a failed convene_agent is NOT retried (terminal), but a failed post_reply IS re-selected", async () => {
    if (setupError) throw new Error(String(setupError));
    const svc = threadAgentActionService(db);

    const [tN] = rowsOf(
      await db.execute(sql`
        INSERT INTO discussions (id, company_id, status, created_by)
        VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test')
        RETURNING id
      `),
    );
    const tNId = String(tN.id);
    const snap = await captureSnapshot(tNId);

    // A 'failed' convene_agent under the attempt cap — non-idempotent → must NOT retry.
    const conveneId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness, attempt_count)
      VALUES
        (${conveneId}, ${companyId}, ${tNId}, NULL, ${agentId}, 'convene_agent', 'failed',
         ${JSON.stringify({ targetAgentId: agentId })}::jsonb, ${`k:cv:${conveneId}`}, ${JSON.stringify(snap)}::jsonb, 0)
    `);
    // A 'failed' post_reply under the attempt cap (control) — idempotent → MUST re-select.
    const replyId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness, attempt_count)
      VALUES
        (${replyId}, ${companyId}, ${tNId}, NULL, ${agentId}, 'post_reply', 'failed',
         ${JSON.stringify({ rawContent: "retry me" })}::jsonb, ${`k:rp:${replyId}`}, ${JSON.stringify(snap)}::jsonb, 0)
    `);

    await svc.commitThreadAgentActions({ companyId, threadId: tNId });

    const [convene] = rowsOf(await db.execute(sql`SELECT status FROM thread_agent_actions WHERE id = ${conveneId}`));
    const [reply] = rowsOf(await db.execute(sql`SELECT status FROM thread_agent_actions WHERE id = ${replyId}`));
    expect(String(convene.status)).toBe("failed"); // NOT re-selected — terminal
    expect(String(reply.status)).toBe("committed"); // re-selected and committed (idempotent)
  });

  // P1 PROOF (outbox seal) — the STRUCTURAL fix for the failed-run leak (Codex P1). The relay
  // drains only SEALED `ready` rows (a producing run promoted them on success, Decision #99
  // producer-gate). An unsealed `proposed` row — a run that failed, crashed, or is still in
  // flight — is NEVER committed, no matter how fresh. This is the regression guard for the
  // whole class of cross-run holes this branch produced.
  it("P1: an unsealed `proposed` row is NEVER committed; only a sealed `ready` row commits", async () => {
    if (setupError) throw new Error(String(setupError));
    const svc = threadAgentActionService(db);

    const [tP] = rowsOf(
      await db.execute(sql`
        INSERT INTO discussions (id, company_id, status, created_by)
        VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test')
        RETURNING id
      `),
    );
    const tPId = String(tP.id);
    const snap = await captureSnapshot(tPId);

    // (a) UNSEALED `proposed` post_reply — fresh + valid, but its producing run never sealed it
    // (it failed / crashed). Must NOT commit.
    const unsealedId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES
        (${unsealedId}, ${companyId}, ${tPId}, NULL, ${agentId}, 'post_reply', 'proposed',
         ${JSON.stringify({ rawContent: "from a run that never sealed" })}::jsonb, ${`k:p1u:${unsealedId}`}, ${JSON.stringify(snap)}::jsonb)
    `);
    // (b) SEALED `ready` post_reply — its run succeeded and sealed it. MUST commit.
    const sealedId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES
        (${sealedId}, ${companyId}, ${tPId}, NULL, ${agentId}, 'post_reply', 'ready',
         ${JSON.stringify({ rawContent: "from a run that sealed" })}::jsonb, ${`k:p1s:${sealedId}`}, ${JSON.stringify(snap)}::jsonb)
    `);

    const res = await svc.commitThreadAgentActions({ companyId, threadId: tPId, runId: await seedRun() });

    const [unsealed] = rowsOf(await db.execute(sql`SELECT status FROM thread_agent_actions WHERE id = ${unsealedId}`));
    const [sealed] = rowsOf(await db.execute(sql`SELECT status FROM thread_agent_actions WHERE id = ${sealedId}`));
    expect(String(unsealed.status)).toBe("proposed"); // never drained — the seal is the gate
    expect(String(sealed.status)).toBe("committed"); // sealed → committed
    expect(res.committed).toBe(1); // exactly the sealed one
  });

  // GC (outbox seal, must-fix #5) — orphaned unsealed `proposed` rows from a failed/crashed run
  // are terminalized so they don't accumulate (they are never committable under ready-only); a
  // FRESH running run's rows are left alone (it may still seal). Mirrors Decision #99 rule 3.
  it("GC: terminalizes proposed rows of a FAILED run + a stale RUNNING run (run failed first); leaves a fresh run alone", async () => {
    if (setupError) throw new Error(String(setupError));

    const [tG] = rowsOf(
      await db.execute(sql`
        INSERT INTO discussions (id, company_id, status, created_by)
        VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test')
        RETURNING id
      `),
    );
    const tGId = String(tG.id);

    const insertRow = async (runId: string, key: string) => {
      const id = randomUUID();
      await db.execute(sql`
        INSERT INTO thread_agent_actions
          (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
        VALUES
          (${id}, ${companyId}, ${tGId}, ${runId}, ${agentId}, 'post_reply', 'proposed',
           ${JSON.stringify({ rawContent: "x" })}::jsonb, ${key}, '{}'::jsonb)
      `);
      return id;
    };

    // (a) FAILED run → its proposed row must be terminalized.
    const [failedRun] = rowsOf(await db.execute(sql`
      INSERT INTO internal_agent_runs (id, company_id, trigger_type, trigger_source, status)
      VALUES (gen_random_uuid(), ${companyId}, 'event', 'integration-test', 'failed') RETURNING id
    `));
    const failedRowId = await insertRow(String(failedRun.id), `k:gcf:${randomUUID()}`);

    // (b) STALE RUNNING run (crashed) → run force-failed first, then row terminalized.
    const [staleRun] = rowsOf(await db.execute(sql`
      INSERT INTO internal_agent_runs (id, company_id, trigger_type, trigger_source, status, created_at)
      VALUES (gen_random_uuid(), ${companyId}, 'event', 'integration-test', 'running', now() - interval '1 hour') RETURNING id
    `));
    const staleRowId = await insertRow(String(staleRun.id), `k:gcs:${randomUUID()}`);

    // (c) FRESH running run → left alone (might still seal).
    const freshRun = await seedRun(); // status 'running', created now
    const freshRowId = await insertRow(freshRun, `k:gcr:${randomUUID()}`);

    const res = await gcOrphanedProposedActions(db, { zombieRunMs: 60_000 });

    const stat = async (id: string) =>
      String(rowsOf(await db.execute(sql`SELECT status FROM thread_agent_actions WHERE id = ${id}`))[0].status);
    expect(await stat(failedRowId)).toBe("blocked_policy"); // failed-run orphan reaped
    expect(await stat(staleRowId)).toBe("blocked_policy"); // crashed-run orphan reaped
    expect(await stat(freshRowId)).toBe("proposed"); // fresh running run left alone
    const [staleRunRow] = rowsOf(await db.execute(sql`SELECT status FROM internal_agent_runs WHERE id = ${String(staleRun.id)}`));
    expect(String(staleRunRow.status)).toBe("failed"); // crashed run force-failed (#99 rule 3)
    expect(res.runsTerminalized).toBeGreaterThanOrEqual(1);
  });

  // Codex #3: a COMPLETED run's still-`proposed` rows (in-band seal failed transiently) must be
  // RE-SEALED by the GC (proposed → ready), never terminalized — the run succeeded.
  it("GC: re-seals a COMPLETED run's unsealed proposed rows by key-set (does not drop them)", async () => {
    if (setupError) throw new Error(String(setupError));

    const [tR] = rowsOf(await db.execute(sql`
      INSERT INTO discussions (id, company_id, status, created_by)
      VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test') RETURNING id`));
    const tRId = String(tR.id);

    const key = `k:reseal:${randomUUID()}`;
    // completed run that DID record the key on its durable key-set (in-band seal then failed).
    const [doneRun] = rowsOf(await db.execute(sql`
      INSERT INTO internal_agent_runs (id, company_id, trigger_type, trigger_source, status, proposed_action_keys)
      VALUES (gen_random_uuid(), ${companyId}, 'event', 'integration-test', 'completed', ${JSON.stringify([key])}::jsonb)
      RETURNING id`));
    const rowId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES (${rowId}, ${companyId}, ${tRId}, ${String(doneRun.id)}, ${agentId}, 'post_reply', 'proposed',
              ${JSON.stringify({ rawContent: "x" })}::jsonb, ${key}, '{}'::jsonb)`);

    const res = await gcOrphanedProposedActions(db, { zombieRunMs: 60_000 });

    const status = String(rowsOf(await db.execute(sql`SELECT status FROM thread_agent_actions WHERE id = ${rowId}`))[0].status);
    expect(status).toBe("ready"); // re-sealed, NOT blocked_policy
    expect(res.resealed).toBeGreaterThanOrEqual(1);
  });

  // A COMPLETED run re-proposed a key whose row is still owned by an earlier FAILED run (collision).
  // The completed run's key-set must re-seal that row — recovery follows the SUCCESSFUL re-proposer,
  // not the row's runId. (This is exactly why #1 is a false positive, applied to the GC backstop.)
  it("GC: re-seals a collided row a COMPLETED run re-proposed even though it is owned by a FAILED run", async () => {
    if (setupError) throw new Error(String(setupError));

    const [tC] = rowsOf(await db.execute(sql`
      INSERT INTO discussions (id, company_id, status, created_by)
      VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test') RETURNING id`));
    const tCId = String(tC.id);
    const key = `k:collide:${randomUUID()}`;

    // earlier FAILED run owns the row...
    const [failedRun] = rowsOf(await db.execute(sql`
      INSERT INTO internal_agent_runs (id, company_id, trigger_type, trigger_source, status)
      VALUES (gen_random_uuid(), ${companyId}, 'event', 'integration-test', 'failed') RETURNING id`));
    const rowId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES (${rowId}, ${companyId}, ${tCId}, ${String(failedRun.id)}, ${agentId}, 'post_reply', 'proposed',
              ${JSON.stringify({ rawContent: "x" })}::jsonb, ${key}, '{}'::jsonb)`);

    // ...but a COMPLETED run re-proposed the same key (recorded on its durable key-set).
    await db.execute(sql`
      INSERT INTO internal_agent_runs (id, company_id, trigger_type, trigger_source, status, proposed_action_keys)
      VALUES (gen_random_uuid(), ${companyId}, 'event', 'integration-test', 'completed', ${JSON.stringify([key])}::jsonb)`);

    const res = await gcOrphanedProposedActions(db, { zombieRunMs: 60_000 });

    const status = String(rowsOf(await db.execute(sql`SELECT status FROM thread_agent_actions WHERE id = ${rowId}`))[0].status);
    expect(status).toBe("ready"); // recovered by the completed run's key-set, NOT blocked_policy
    expect(res.resealed).toBeGreaterThanOrEqual(1);
  });

  // Adversarial-review fix: a row a COMPLETED run did NOT seal (key never reached its key-set — the
  // append no-op'd) and a NULL-runId row are both terminal-but-unrecoverable. Past the modest age
  // cutoff they must be terminalized, not stuck in `proposed` forever. Step 4 only touches null/
  // completed producers, never a live running run.
  it("GC: terminalizes orphaned proposed rows under a completed/null producer (Step 4 cleanup net)", async () => {
    if (setupError) throw new Error(String(setupError));

    const [tO] = rowsOf(await db.execute(sql`
      INSERT INTO discussions (id, company_id, status, created_by)
      VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test') RETURNING id`));
    const tOId = String(tO.id);

    // (a) completed run, but the row's key is NOT in its (empty) key-set → orphan.
    const [doneRun] = rowsOf(await db.execute(sql`
      INSERT INTO internal_agent_runs (id, company_id, trigger_type, trigger_source, status, proposed_action_keys)
      VALUES (gen_random_uuid(), ${companyId}, 'event', 'integration-test', 'completed', '[]'::jsonb) RETURNING id`));
    const orphanId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness, updated_at)
      VALUES (${orphanId}, ${companyId}, ${tOId}, ${String(doneRun.id)}, ${agentId}, 'post_reply', 'proposed',
              ${JSON.stringify({ rawContent: "x" })}::jsonb, ${`k:orphan:${randomUUID()}`}, '{}'::jsonb, now() - interval '1 hour')`);

    // (b) null-runId row (no producer at all) → also an orphan.
    const nullRunRowId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness, updated_at)
      VALUES (${nullRunRowId}, ${companyId}, ${tOId}, NULL, ${agentId}, 'post_reply', 'proposed',
              ${JSON.stringify({ rawContent: "y" })}::jsonb, ${`k:nullrun:${randomUUID()}`}, '{}'::jsonb, now() - interval '1 hour')`);

    const res = await gcOrphanedProposedActions(db, { zombieRunMs: 60_000 });

    const stat = async (id: string) =>
      String(rowsOf(await db.execute(sql`SELECT status FROM thread_agent_actions WHERE id = ${id}`))[0].status);
    expect(await stat(orphanId)).toBe("blocked_policy"); // completed-run orphan cleaned (not stuck)
    expect(await stat(nullRunRowId)).toBe("blocked_policy"); // null-producer orphan cleaned
    expect(res.reaped).toBeGreaterThanOrEqual(2);
  });

  // Codex #2: a long-but-LIVE run (past the OLD 10-min seal cutoff, well within the 2h zombie TTL)
  // must NOT be force-failed by the default sweep — its actions would otherwise be lost on success.
  it("GC (default TTL): leaves a 40-minute-old RUNNING run and its proposed row untouched", async () => {
    if (setupError) throw new Error(String(setupError));

    const [tL] = rowsOf(await db.execute(sql`
      INSERT INTO discussions (id, company_id, status, created_by)
      VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test') RETURNING id`));
    const tLId = String(tL.id);

    const [liveRun] = rowsOf(await db.execute(sql`
      INSERT INTO internal_agent_runs (id, company_id, trigger_type, trigger_source, status, created_at)
      VALUES (gen_random_uuid(), ${companyId}, 'event', 'integration-test', 'running', now() - interval '40 minutes')
      RETURNING id`));
    const rowId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES (${rowId}, ${companyId}, ${tLId}, ${String(liveRun.id)}, ${agentId}, 'post_reply', 'proposed',
              ${JSON.stringify({ rawContent: "x" })}::jsonb, ${`k:live:${randomUUID()}`}, '{}'::jsonb)`);

    await gcOrphanedProposedActions(db); // DEFAULT zombie TTL = 2h

    const runStatus = String(rowsOf(await db.execute(sql`SELECT status FROM internal_agent_runs WHERE id = ${String(liveRun.id)}`))[0].status);
    const rowStatus = String(rowsOf(await db.execute(sql`SELECT status FROM thread_agent_actions WHERE id = ${rowId}`))[0].status);
    expect(runStatus).toBe("running"); // not force-failed
    expect(rowStatus).toBe("proposed"); // left alone (may still seal in-band)
  });

  // Step 2 company-correlation is load-bearing: a COMPLETED run in a DIFFERENT company holding the
  // same key must NOT re-seal this company's row (no cross-tenant bleed). Locks in the r.company_id
  // predicate so deleting it would fail a test.
  it("GC: does NOT re-seal a row when only a DIFFERENT company's completed run holds the key", async () => {
    if (setupError) throw new Error(String(setupError));

    const [tX] = rowsOf(await db.execute(sql`
      INSERT INTO discussions (id, company_id, status, created_by)
      VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test') RETURNING id`));
    const tXId = String(tX.id);
    const key = `k:xco:${randomUUID()}`;

    // our row: company A, under a FRESH running run (so Steps 3/4 never touch it).
    const liveRun = await seedRun();
    const rowId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES (${rowId}, ${companyId}, ${tXId}, ${liveRun}, ${agentId}, 'post_reply', 'proposed',
              ${JSON.stringify({ rawContent: "x" })}::jsonb, ${key}, '{}'::jsonb)`);

    // a DIFFERENT company with a COMPLETED run that holds the same key.
    const otherCo = await companyService(db).create({ name: "Other Co" } as never);
    await db.execute(sql`
      INSERT INTO internal_agent_runs (id, company_id, trigger_type, trigger_source, status, proposed_action_keys)
      VALUES (gen_random_uuid(), ${otherCo.id}, 'event', 'integration-test', 'completed', ${JSON.stringify([key])}::jsonb)`);

    await gcOrphanedProposedActions(db, { zombieRunMs: 60_000 });

    const status = String(rowsOf(await db.execute(sql`SELECT status FROM thread_agent_actions WHERE id = ${rowId}`))[0].status);
    expect(status).toBe("proposed"); // company-correlation excluded the other company's key-set
  });

  // Codex #2 (positive direction): under the DEFAULT 2h TTL, a >2h-old running run IS force-failed —
  // guards against an over-large-TTL / NaN-cutoff regression the 40-min liveness test cannot catch.
  it("GC (default TTL): force-fails a >2h-old RUNNING run and terminalizes its row", async () => {
    if (setupError) throw new Error(String(setupError));

    const [tD] = rowsOf(await db.execute(sql`
      INSERT INTO discussions (id, company_id, status, created_by)
      VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test') RETURNING id`));
    const tDId = String(tD.id);

    const [deadRun] = rowsOf(await db.execute(sql`
      INSERT INTO internal_agent_runs (id, company_id, trigger_type, trigger_source, status, created_at)
      VALUES (gen_random_uuid(), ${companyId}, 'event', 'integration-test', 'running', now() - interval '3 hours')
      RETURNING id`));
    const rowId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness, updated_at)
      VALUES (${rowId}, ${companyId}, ${tDId}, ${String(deadRun.id)}, ${agentId}, 'post_reply', 'proposed',
              ${JSON.stringify({ rawContent: "x" })}::jsonb, ${`k:dead:${randomUUID()}`}, '{}'::jsonb, now() - interval '3 hours')`);

    await gcOrphanedProposedActions(db); // DEFAULT 2h zombie TTL

    const runStatus = String(rowsOf(await db.execute(sql`SELECT status FROM internal_agent_runs WHERE id = ${String(deadRun.id)}`))[0].status);
    const rowStatus = String(rowsOf(await db.execute(sql`SELECT status FROM thread_agent_actions WHERE id = ${rowId}`))[0].status);
    expect(runStatus).toBe("failed"); // past 2h default → zombie reaped
    expect(rowStatus).toBe("blocked_policy"); // its orphan row terminalized (failed-run branch)
  });

  // Step 2 beats Step 4: a STALE recoverable row (past the 10m orphan cutoff, but its key IS in a
  // completed run's key-set) must be RE-SEALED, not terminalized — proves the re-seal-before-orphan order.
  it("GC: re-seals a STALE recoverable row instead of terminalizing it (Step 2 precedes Step 4)", async () => {
    if (setupError) throw new Error(String(setupError));

    const [tS] = rowsOf(await db.execute(sql`
      INSERT INTO discussions (id, company_id, status, created_by)
      VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test') RETURNING id`));
    const tSId = String(tS.id);
    const key = `k:stale:${randomUUID()}`;

    const [doneRun] = rowsOf(await db.execute(sql`
      INSERT INTO internal_agent_runs (id, company_id, trigger_type, trigger_source, status, proposed_action_keys)
      VALUES (gen_random_uuid(), ${companyId}, 'event', 'integration-test', 'completed', ${JSON.stringify([key])}::jsonb) RETURNING id`));
    const rowId = randomUUID();
    // updated_at 1h ago → past the 10m orphan cutoff, so Step 4 WOULD terminalize it if Step 2 didn't run first.
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness, updated_at)
      VALUES (${rowId}, ${companyId}, ${tSId}, ${String(doneRun.id)}, ${agentId}, 'post_reply', 'proposed',
              ${JSON.stringify({ rawContent: "x" })}::jsonb, ${key}, '{}'::jsonb, now() - interval '1 hour')`);

    const res = await gcOrphanedProposedActions(db, { zombieRunMs: 60_000 });

    const status = String(rowsOf(await db.execute(sql`SELECT status FROM thread_agent_actions WHERE id = ${rowId}`))[0].status);
    expect(status).toBe("ready"); // re-sealed by Step 2 despite being past the Step 4 orphan cutoff
    expect(res.resealed).toBeGreaterThanOrEqual(1);
  });

  // Codex round-7 #1: Step 2 flips rows proposed→ready but must ALSO re-arm pendingRun, else the
  // ready row sits undrained (runControllerSweep only drives pendingRun=true threads). Mirrors the reaper.
  it("GC: re-arms pendingRun on a thread whose rows Step 2 re-sealed", async () => {
    if (setupError) throw new Error(String(setupError));

    const [tA] = rowsOf(await db.execute(sql`
      INSERT INTO discussions (id, company_id, status, created_by)
      VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test') RETURNING id`));
    const tAId = String(tA.id);
    await db.execute(sql`INSERT INTO thread_orchestration_state (thread_id, pending_run) VALUES (${tAId}, false)`);

    const key = `k:rearm:${randomUUID()}`;
    const [doneRun] = rowsOf(await db.execute(sql`
      INSERT INTO internal_agent_runs (id, company_id, trigger_type, trigger_source, status, proposed_action_keys)
      VALUES (gen_random_uuid(), ${companyId}, 'event', 'integration-test', 'completed', ${JSON.stringify([key])}::jsonb) RETURNING id`));
    const rowId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES (${rowId}, ${companyId}, ${tAId}, ${String(doneRun.id)}, ${agentId}, 'post_reply', 'proposed',
              ${JSON.stringify({ rawContent: "x" })}::jsonb, ${key}, '{}'::jsonb)`);

    await gcOrphanedProposedActions(db, { zombieRunMs: 60_000 });

    const [row] = rowsOf(await db.execute(sql`SELECT status FROM thread_agent_actions WHERE id = ${rowId}`));
    const [ctrl] = rowsOf(await db.execute(sql`SELECT pending_run FROM thread_orchestration_state WHERE thread_id = ${tAId}`));
    expect(String(row.status)).toBe("ready"); // re-sealed
    expect(ctrl.pending_run).toBe(true); // controller re-armed so the ready row actually drains
  });

  // Codex round-7 #3: a Step-1 false-reap of a >2h-but-still-LIVE run terminalizes its rows to
  // blocked_policy/run_not_sealed (Step 3); once the run actually COMPLETES (the runner overwrites the
  // GC's false `failed` on success), Step 2 must recover them by its key-set — so the false-reap is
  // NON-LOSSY. (Schema-free; a true idle-lease that avoids the false-reap is a tracked follow-up.)
  it("GC: self-heals blocked_policy/run_not_sealed rows once their run completes (false-reap non-lossy)", async () => {
    if (setupError) throw new Error(String(setupError));

    const [tH] = rowsOf(await db.execute(sql`
      INSERT INTO discussions (id, company_id, status, created_by)
      VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test') RETURNING id`));
    const tHId = String(tH.id);

    const key = `k:selfheal:${randomUUID()}`;
    const [doneRun] = rowsOf(await db.execute(sql`
      INSERT INTO internal_agent_runs (id, company_id, trigger_type, trigger_source, status, proposed_action_keys)
      VALUES (gen_random_uuid(), ${companyId}, 'event', 'integration-test', 'completed', ${JSON.stringify([key])}::jsonb) RETURNING id`));
    const rowId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, blocked_reason, payload, idempotency_key, freshness)
      VALUES (${rowId}, ${companyId}, ${tHId}, ${String(doneRun.id)}, ${agentId}, 'post_reply', 'blocked_policy', 'run_not_sealed',
              ${JSON.stringify({ rawContent: "x" })}::jsonb, ${key}, '{}'::jsonb)`);

    const res = await gcOrphanedProposedActions(db, { zombieRunMs: 60_000 });

    const [row] = rowsOf(await db.execute(sql`SELECT status, blocked_reason FROM thread_agent_actions WHERE id = ${rowId}`));
    expect(String(row.status)).toBe("ready"); // recovered from blocked_policy
    expect(row.blocked_reason).toBeNull(); // reason cleared on recovery
    expect(res.resealed).toBeGreaterThanOrEqual(1);
  });

  // Codex round-7 #2: the per-action freshness re-check + suppressed_stale write must run AFTER the
  // fenced claim, so a stale committer can only suppress a row it OWNS — never clobber a concurrent
  // committer's committed row (which, for convene_agent, would revive into a duplicate wakeup). Proof:
  // at the moment the freshness re-check runs, the row is already 'committing' (claimed by THIS committer).
  it("commit: claims a ready row BEFORE the freshness re-check (suppress only touches an owned row)", async () => {
    if (setupError) throw new Error(String(setupError));

    const [tF] = rowsOf(await db.execute(sql`
      INSERT INTO discussions (id, company_id, status, created_by)
      VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test') RETURNING id`));
    const tFId = String(tF.id);

    const rowId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES (${rowId}, ${companyId}, ${tFId}, ${await seedRun()}, ${agentId}, 'post_reply', 'ready',
              ${JSON.stringify({ rawContent: "x" })}::jsonb, ${`k:reorder:${randomUUID()}`}, '{}'::jsonb)`);

    let statusAtFreshnessCheck: string | null = null;
    const compareFreshnessSnapshot = (async () => {
      const [r] = rowsOf(await db.execute(sql`SELECT status FROM thread_agent_actions WHERE id = ${rowId}`));
      statusAtFreshnessCheck = String(r.status);
      return { fresh: false, reason: "newer_human_entry" };
    }) as never;

    const res = await threadAgentActionService(db, { compareFreshnessSnapshot }).commitThreadAgentActions({
      companyId,
      threadId: tFId,
      runId: await seedRun(),
    });

    expect(statusAtFreshnessCheck).toBe("committing"); // claimed BEFORE the freshness check (the fix); OLD = 'ready'
    expect(res.suppressed).toBe(1);
    const [row] = rowsOf(await db.execute(sql`SELECT status FROM thread_agent_actions WHERE id = ${rowId}`));
    expect(String(row.status)).toBe("suppressed_stale"); // suppressed on the row this committer owns
  });

  // KEYSTONE INVARIANT (the load-bearing safety claim for the whole thread-scoped drain): the runner
  // self-flush path (runner.ts:574-606) commits a participation/mention run's own actions in-band and
  // NEVER reads the controller runEpoch turn-gate — it relies SOLELY on the per-row freshness snapshot
  // to catch a human entry that arrived between snapshot-capture (at run start) and the in-band commit.
  // This proves that subsumption: a human entry after the snapshot suppresses via newer_human_entry,
  // not commits stale. Asserted-only until now (thread-orchestration.ts:656-661, "prove before deleting").
  it("self-flush path: a human entry after snapshot-capture suppresses the in-band commit (freshness subsumes runEpoch)", async () => {
    if (setupError) throw new Error(String(setupError));

    // Isolated thread so other tests' entries can't perturb the latest-human seq.
    const [tK] = rowsOf(await db.execute(sql`
      INSERT INTO discussions (id, company_id, status, created_by)
      VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test') RETURNING id`));
    const tKId = String(tK.id);

    // H0 — a human entry (author_agent_id NULL = human) is the snapshot baseline. `seq` is assigned by
    // the app layer (addEntry), not a DB trigger, so we set it explicitly: H0=1, H1=2 below, so the
    // live latest-human seq advances past the snapshot's.
    await db.execute(sql`
      INSERT INTO discussion_entries (id, discussion_id, input_type, raw_content, author_agent_id, created_by, seq)
      VALUES (gen_random_uuid(), ${tKId}, 'write', 'first human msg', NULL, 'human-user', 1)`);

    // Snapshot captured at run start (latestHumanSeq = H0's seq = 1) — what proposeThreadAction stamps.
    const snap = await captureSnapshot(tKId);

    // The participation run proposed a post_reply (sealed → ready), carrying that snapshot.
    const actionId = randomUUID();
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES (${actionId}, ${companyId}, ${tKId}, ${await seedRun()}, ${agentId}, 'post_reply', 'ready',
              ${JSON.stringify({ rawContent: "reply to a thread the human has since moved past" })}::jsonb,
              ${`k:keystone:${actionId}`}, ${JSON.stringify(snap)}::jsonb)`);

    // H1 — a NEWER human entry arrives mid-run, AFTER the snapshot (seq=2 > snap.latestHumanSeq=1).
    await db.execute(sql`
      INSERT INTO discussion_entries (id, discussion_id, input_type, raw_content, author_agent_id, created_by, seq)
      VALUES (gen_random_uuid(), ${tKId}, 'write', 'human spoke mid-run', NULL, 'human-user', 2)`);

    // The runner self-flush IS commitThreadAgentActions (it never re-checks runEpoch). The per-row
    // freshness snapshot must catch H1 and SUPPRESS — never post a reply against the stale context.
    const res = await threadAgentActionService(db).commitThreadAgentActions({
      companyId,
      threadId: tKId,
      runId: await seedRun(),
    });

    expect(res.committed).toBe(0);
    expect(res.suppressed).toBe(1);
    const [row] = rowsOf(await db.execute(sql`SELECT status, blocked_reason FROM thread_agent_actions WHERE id = ${actionId}`));
    expect(String(row.status)).toBe("suppressed_stale");
    expect(String(row.blocked_reason)).toBe("newer_human_entry");
    // And no reply entry was produced for the stale action.
    const n = rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM discussion_entries WHERE source_action_id = ${actionId}`));
    expect(Number(n[0].n)).toBe(0);
  });

  // Codex round-8: a run that sealed its rows (→ready) IN-BAND then crashed before its commit leaves
  // them ready on a pendingRun=false thread — nothing drains them (the sweep visits only pending
  // threads). The GC re-arms threads holding STALE ready rows (past the commit window); FRESH ready
  // rows are left for the normal in-band/controller commit so this never fights the happy path.
  it("GC: re-arms a thread with crash-stranded stale ready rows, but not one with fresh ready rows", async () => {
    if (setupError) throw new Error(String(setupError));

    // (a) crash-stranded — ready row last touched 1h ago, thread not pending → must re-arm.
    const [tStale] = rowsOf(await db.execute(sql`
      INSERT INTO discussions (id, company_id, status, created_by)
      VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test') RETURNING id`));
    const tStaleId = String(tStale.id);
    await db.execute(sql`INSERT INTO thread_orchestration_state (thread_id, pending_run) VALUES (${tStaleId}, false)`);
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness, updated_at)
      VALUES (${randomUUID()}, ${companyId}, ${tStaleId}, ${await seedRun()}, ${agentId}, 'post_reply', 'ready',
              ${JSON.stringify({ rawContent: "stranded" })}::jsonb, ${`k:cw:${randomUUID()}`}, '{}'::jsonb, now() - interval '1 hour')`);

    // (b) fresh — ready row touched now, thread not pending → must NOT re-arm (the normal commit drains it).
    const [tFresh] = rowsOf(await db.execute(sql`
      INSERT INTO discussions (id, company_id, status, created_by)
      VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test') RETURNING id`));
    const tFreshId = String(tFresh.id);
    await db.execute(sql`INSERT INTO thread_orchestration_state (thread_id, pending_run) VALUES (${tFreshId}, false)`);
    await db.execute(sql`
      INSERT INTO thread_agent_actions
        (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES (${randomUUID()}, ${companyId}, ${tFreshId}, ${await seedRun()}, ${agentId}, 'post_reply', 'ready',
              ${JSON.stringify({ rawContent: "fresh" })}::jsonb, ${`k:cwf:${randomUUID()}`}, '{}'::jsonb)`);

    await gcOrphanedProposedActions(db, { zombieRunMs: 60_000 });

    const stale = rowsOf(await db.execute(sql`SELECT pending_run FROM thread_orchestration_state WHERE thread_id = ${tStaleId}`))[0];
    const fresh = rowsOf(await db.execute(sql`SELECT pending_run FROM thread_orchestration_state WHERE thread_id = ${tFreshId}`))[0];
    expect(stale.pending_run).toBe(true); // crash-stranded ready rows → re-armed for the sweep
    expect(fresh.pending_run).toBe(false); // fresh ready rows → left for the normal commit path
  });
});
