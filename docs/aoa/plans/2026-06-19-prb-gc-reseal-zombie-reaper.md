# PR-B Seal Follow-up: GC Re-seal + Conservative Zombie Reaper

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. TDD throughout; the GC is real-DB only, so its proofs live in the Docker integration suite (`thread-commit-idempotency.integration.test.ts`).

**Goal:** Fix Codex's two real seal follow-ups — (#2) the GC force-failing long-but-LIVE runs, and (#3) the GC dropping a succeeded run's actions when the in-band seal fails — by making `gcOrphanedProposedActions` status-driven: re-seal completed runs' proposed rows (recover), terminalize only failed/cancelled runs' rows (drop), and only force-fail genuinely-dead running runs (a conservative wall-clock TTL, not the seal-window cutoff). Push back on #1 (verified false positive).

**Architecture:** The sweep GC becomes the **idempotent-retry relay** for the producer seal. The seal's safety invariant — *never commit a failed run's action* — already holds; these fixes add the matching **liveness** invariant: *never drop a succeeded run's action, never mistake a slow run for a crashed one, and never leave a row stuck forever.* Four status-driven steps run each 2-min sweep:

1. **Zombie reaper** — a `running` run whose `created_at` is past a conservative TTL (`ZOMBIE_RUN_TTL_MS = 2h`, ≫ the 30-min CLI idle timeout; there is no hard run cap) and that still has `proposed` rows has hard-crashed → force `failed`. A long-but-live run is *never* touched.
2. **Re-seal** — `proposed` rows whose `idempotency_key` is in some **completed** run's durable `proposed_action_keys` (same company) → `ready`. This mirrors the in-band runner seal (`sealRunActions`, by key-set) exactly, so a transient in-band seal failure self-heals next sweep, and a *collided* row (re-proposed by a completed run but owned by an earlier run) is recovered too.
3. **Terminalize (failed)** — remaining `proposed` rows whose run is `failed`/`cancelled` (incl. just-failed zombies) → `blocked_policy`/`run_not_sealed`. Non-zombie `running` runs' rows are left alone.
4. **Terminalize (orphan)** — `proposed` rows past a modest age (`STALE_COMMITTING_TTL_MS = 10m`) whose producer is **terminal-but-unrecoverable**: `run_id IS NULL`, or a `completed` run that did **not** re-seal it in Step 2 (its key never landed in the run's key-set — the `proposeThreadAction` append no-op'd / run was absent). Restores the cleanup net the old GC provided via its age-based completed-branch; only ever touches null/`completed` producers, so it cannot false-crash a live run. **This is the adversarial-review fix (orphan-stuck-forever).**

> **Zombie TTL caveat (for the Codex reply, not a code change):** the 30-min idle timeout (`cli-mode.ts:283`, refreshed per message) bounds *idle*, not *wall-clock*. So 2h is "2h of continuous activity," not "2h elapsed." A run busy >2h would be false-crashed — but it fails *safe* (drops only its unsealed rows; `sealRunActions`' `status='proposed'` guard prevents any double-commit) and is a strict improvement over the current 10-min cutoff.

**Tech Stack:** Drizzle ORM (no raw migrations — no schema change here), embedded-postgres integration tests in Docker (Windows skips real-DB; Linux container is the gate), Vitest.

---

## Why #1 is a false positive (pushback, no code)

Codex P1 (3442809584): "seal rows from failed runs by key alone." Verified false: **all six** idempotency-key builders in `thread-action-keys.ts` are content-determined —
`post_reply`→`sha256(content)`, `create_artifact_candidate`→`sha256([title,content,fileRef])`, `convene_agent`→`sha256([target,reason])`, `create_scope_draft`→`sha256([summary,tasks])`, `add_scope_item`→`sha256([title,content,layer,category])`, `advance_phase`→`toPhase`.
So **same key ⇒ identical content/intent**, and the seal fires only for keys in the run's *own* `proposed_action_keys` — keys a **successful** run actually proposed. When a completed run re-proposes a failed run's key and seals it, it commits exactly the content that successful run produced: the intended crash/failure recovery, not a leak. The GC re-seal in this plan uses the *same* by-key-set rule, so the semantics are identical and consistent end-to-end.

---

## File Structure

- **Modify** `server/src/services/thread-agent-actions.ts` — add `ZOMBIE_RUN_TTL_MS`; add `resealed` to `GcOrphanedProposedActionsResult`; rewrite `gcOrphanedProposedActions` (opts `staleMs`→`zombieRunMs`); update the docblock (lines ~1150–1218).
- **Modify** `server/src/services/internal-agent/aoa-agents/runner.ts` — correct the best-effort-seal comment only (lines ~541–565); the swallow is now *safe* because the GC re-seals. No logic change.
- **Modify** `server/src/__tests__/thread-commit-idempotency.integration.test.ts` — rename `staleMs`→`zombieRunMs` in the existing GC test; add 3 new GC cases (re-seal completed, collided-under-failed re-seal, long-but-live not crashed).
- **Modify** `server/src/__tests__/sweep-controller.test.ts` — extend the GC mock return shape with `resealed: 0`.

No schema/migration change: `proposed_action_keys` (migration 0147) already exists.

---

## Task 1: Re-seal a completed run's proposed rows (Codex #3 — the common case)

**Files:**
- Test: `server/src/__tests__/thread-commit-idempotency.integration.test.ts`
- Modify: `server/src/services/thread-agent-actions.ts:1150-1218`

- [ ] **Step 1: Write the failing integration test** (add after the existing GC test, before the closing `});` at line ~1397)

```ts
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
    expect(status).toBe("ready");        // re-sealed, NOT blocked_policy
    expect(res.resealed).toBeGreaterThanOrEqual(1);
  });
```

- [ ] **Step 2: Run it in Docker, verify it FAILS**

Run (from repo root, via the project's Docker integration harness used this session):
```bash
docker compose -f docker-compose.test.yml run --rm server \
  npx vitest run src/__tests__/thread-commit-idempotency.integration.test.ts -t "re-seals a COMPLETED"
```
Expected: FAIL — `res.resealed` is undefined (field doesn't exist) and the row is still `proposed` (current GC only terminalizes completed rows past the cutoff).

- [ ] **Step 3: Implement — add constant + result field + Step 2 re-seal**

In `server/src/services/thread-agent-actions.ts`, replace the constant/interface/function block (lines 1150–1218). Add near `STALE_COMMITTING_TTL_MS` (line 1082):

```ts
/**
 * Conservative wall-clock age past which a still-`running` run that left unsealed `proposed`
 * actions is treated as hard-CRASHED. Must stay ≫ the longest legitimate run: the CLI idle
 * timeout is 30 min (`cli-mode.ts`) and there is no hard run cap, so a `running` run older than
 * 2h with unsealed actions has crashed. NOT the seal-window cutoff — a long-but-live run must
 * never be force-failed (Codex P1: false-crash drops a succeeding run's actions). (#99 staleMs rule.)
 */
export const ZOMBIE_RUN_TTL_MS = 2 * 60 * 60 * 1000;
```

Replace the interface (lines 1150–1153):
```ts
export interface GcOrphanedProposedActionsResult {
  /** Completed (succeeded) runs' proposed rows recovered: proposed → ready (Codex #3 backstop). */
  resealed: number;
  /** Failed/cancelled runs' proposed rows dropped: proposed → blocked_policy. */
  reaped: number;
  /** Genuinely-crashed (zombie) running runs force-failed (#99 rule 3). */
  runsTerminalized: number;
}
```

Replace the function body (lines 1173–1218) — note opts param `staleMs`→`zombieRunMs`, and the three steps in order **zombie → re-seal → terminalize**:
```ts
export async function gcOrphanedProposedActions(
  db: Db | DbLike,
  opts: { zombieRunMs?: number; now?: Date } = {},
): Promise<GcOrphanedProposedActionsResult> {
  const gcDb = db as unknown as DbLike;
  const zombieMs = opts.zombieRunMs ?? ZOMBIE_RUN_TTL_MS;
  const now = opts.now ?? new Date();
  const zombieCutoff = new Date(now.getTime() - zombieMs);

  // Step 1 (#99 rule 3): force-fail a genuinely-CRASHED running run BEFORE touching its rows.
  // Crash = `running` past the conservative zombie TTL (≫ longest legitimate run) with unsealed
  // proposed rows — a long-but-LIVE run is never reaped (Codex P1 #2).
  const terminalized = (await gcDb
    .update(internalAgentRuns)
    .set({
      status: "failed",
      errorMessage: "reaped: running run past zombie TTL left unsealed thread actions",
      completedAt: now,
    })
    .where(
      and(
        eq(internalAgentRuns.status, "running"),
        lt(internalAgentRuns.createdAt, zombieCutoff),
        sql`${internalAgentRuns.id} IN (SELECT run_id FROM thread_agent_actions WHERE status = 'proposed' AND run_id IS NOT NULL)`,
      ),
    )
    .returning()) as unknown[];

  // Step 2 (Codex P2 #3 — the seal is RETRYABLE): re-seal proposed rows that a COMPLETED (succeeded)
  // run is entitled to seal — whose idempotency_key is in some completed run's durable key-set (same
  // company). This mirrors the in-band runner seal (sealRunActions, by company+key-set) so a transient
  // in-band seal failure self-heals on the next sweep, and a collided row (re-proposed by a completed
  // run but still owned by an earlier run) is recovered too. A completed run SUCCEEDED → its actions
  // belong committed. Runs BEFORE Steps 3/4 so a recoverable row is re-sealed, not terminalized.
  const resealed = (await gcDb
    .update(threadAgentActions)
    .set({ status: "ready", updatedAt: now })
    .where(
      and(
        eq(threadAgentActions.status, "proposed"),
        sql`${threadAgentActions.idempotencyKey} IN (
          SELECT jsonb_array_elements_text(r.proposed_action_keys)
          FROM internal_agent_runs r
          WHERE r.status = 'completed'
            AND jsonb_array_length(r.proposed_action_keys) > 0
            AND r.company_id = ${threadAgentActions.companyId}
        )`,
      ),
    )
    .returning()) as unknown[];

  // Step 3: terminalize the remaining unsealed `proposed` rows whose run FAILED/cancelled (incl. the
  // zombies just failed in Step 1) and which no completed run re-sealed — these must never commit.
  // Non-zombie `running` runs' rows are left alone (they may still seal in-band).
  const reaped = (await gcDb
    .update(threadAgentActions)
    .set({ status: "blocked_policy", blockedReason: "run_not_sealed", updatedAt: now })
    .where(
      and(
        eq(threadAgentActions.status, "proposed"),
        sql`${threadAgentActions.runId} IN (SELECT id FROM internal_agent_runs WHERE status IN ('failed','cancelled'))`,
      ),
    )
    .returning()) as unknown[];

  // Step 4 (adversarial-review fix): terminalize ORPHANED proposed rows past a modest age whose
  // producer is terminal-but-unrecoverable — null run_id (no producer), or a `completed` run that did
  // NOT re-seal them in Step 2 (the key never reached the run's key-set: the proposeThreadAction append
  // no-op'd / the run was absent). Restores the cleanup net the old age-based completed-branch gave.
  // Only ever touches null/`completed` producers (Step 2 already promoted the recoverable ones), so it
  // cannot false-crash a live `running` run.
  const orphanCutoff = new Date(now.getTime() - STALE_COMMITTING_TTL_MS);
  const orphaned = (await gcDb
    .update(threadAgentActions)
    .set({ status: "blocked_policy", blockedReason: "run_not_sealed", updatedAt: now })
    .where(
      and(
        eq(threadAgentActions.status, "proposed"),
        lt(threadAgentActions.updatedAt, orphanCutoff),
        sql`(${threadAgentActions.runId} IS NULL OR ${threadAgentActions.runId} IN (SELECT id FROM internal_agent_runs WHERE status = 'completed'))`,
      ),
    )
    .returning()) as unknown[];

  return {
    resealed: resealed.length,
    reaped: reaped.length + orphaned.length,
    runsTerminalized: terminalized.length,
  };
}
```

Also update the docblock above the function (lines 1155–1172) to describe the three steps (zombie / re-seal / terminalize) — replace the stale "Step 1/Step 2" prose.

> Verify the Drizzle field name is `threadAgentActions.idempotencyKey` (grep the schema/usages — the in-band seal already references it). Adjust if the actual export differs.

- [ ] **Step 4: Run the test in Docker, verify it PASSES**

Run the same command as Step 2. Expected: PASS (`status === "ready"`, `res.resealed >= 1`).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/thread-agent-actions.ts server/src/__tests__/thread-commit-idempotency.integration.test.ts
git commit -m "fix(seal): GC re-seals completed runs' proposed rows by key-set (Codex #3)"
```

---

## Task 2: Collided-under-failed re-seal (by-key-set completeness)

**Files:**
- Test: `server/src/__tests__/thread-commit-idempotency.integration.test.ts`
- (Implementation already done in Task 1 — Step 2 is by key-set, so this test should pass once written.)

- [ ] **Step 1: Write the test** (proves by-key-set beats a naive by-runId re-seal)

```ts
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
    expect(status).toBe("ready");        // recovered by the completed run's key-set, NOT blocked_policy
    expect(res.resealed).toBeGreaterThanOrEqual(1);
  });
```

- [ ] **Step 2: Write the orphan-terminalize test** (Step 4 — a `completed` run's row whose key is NOT in its key-set, and a null-runId row, must not get stuck forever)

```ts
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
    expect(await stat(orphanId)).toBe("blocked_policy");   // completed-run orphan cleaned (not stuck)
    expect(await stat(nullRunRowId)).toBe("blocked_policy"); // null-producer orphan cleaned
    expect(res.reaped).toBeGreaterThanOrEqual(2);
  });
```

- [ ] **Step 3: Run both in Docker, verify PASS** (Task 1's Step 2 + Step 4 cover them)

```bash
docker compose -f docker-compose.test.yml run --rm server \
  npx vitest run src/__tests__/thread-commit-idempotency.integration.test.ts -t "collided row|orphaned proposed"
```
Expected: PASS. (Collided-row FAIL with `blocked_policy` ⇒ re-seal written by-runId not by-key-set. Orphan FAIL with `proposed` ⇒ Step 4 missing/mis-gated.)

- [ ] **Step 4: Commit**

```bash
git add server/src/__tests__/thread-commit-idempotency.integration.test.ts
git commit -m "test(seal): GC re-seals collided row by key-set; terminalizes completed/null orphans"
```

---

## Task 3: Long-but-live run not crashed; zombie past TTL still reaped (Codex #2)

**Files:**
- Test: `server/src/__tests__/thread-commit-idempotency.integration.test.ts:1344-1396` (existing GC test)

- [ ] **Step 1: Update the existing GC test** — rename `staleMs`→`zombieRunMs`, and add a long-but-live case

In the existing test (line ~1386) change:
```ts
    const res = await gcOrphanedProposedActions(db, { staleMs: 60_000 });
```
to:
```ts
    const res = await gcOrphanedProposedActions(db, { zombieRunMs: 60_000 });
```
(The 1-hour-old stale run is still past the 60s zombie cutoff → force-failed; the fresh run is within → left alone. Assertions at 1390–1395 unchanged.)

- [ ] **Step 2: Add the explicit long-but-live proof** (default opts — a 40-min run must NOT be crashed)

```ts
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
    expect(runStatus).toBe("running");   // not force-failed
    expect(rowStatus).toBe("proposed");  // left alone (may still seal in-band)
  });
```

- [ ] **Step 3: Run both in Docker, verify PASS**

```bash
docker compose -f docker-compose.test.yml run --rm server \
  npx vitest run src/__tests__/thread-commit-idempotency.integration.test.ts -t "GC"
```
Expected: all GC cases PASS — including the renamed existing test and the 40-min-live proof.

- [ ] **Step 4: Commit**

```bash
git add server/src/__tests__/thread-commit-idempotency.integration.test.ts
git commit -m "test(seal): GC keeps long-but-live runs; zombie TTL reaps only crashed runs (Codex #2)"
```

---

## Task 4: Correct the runner's best-effort-seal comment + sweep mock shape

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/runner.ts:541-565`
- Modify: `server/src/__tests__/sweep-controller.test.ts:78,132`

- [ ] **Step 1: Update the runner comment** (logic unchanged — the swallow is now *safe*)

Replace the comment at lines 541–544 (the "next run can re-do the work" claim, which Codex #3 correctly called out as false):
```ts
      // Best-effort: a transient seal read/write failure must NOT fail a run that already succeeded
      // (the agent did its work). On failure the rows stay `proposed`; the sweep GC then RE-SEALS this
      // completed run's key-set (gcOrphanedProposedActions Step 2, ~2-min cadence), so the actions are
      // recovered and committed — NOT lost. Mirrors the freshness-capture best-effort guard above.
```
And the warn message at lines 561–564:
```ts
        log.warn(
          { err: sealErr, runId, threadId: bridgeThreadId },
          "aoa-runner: outbox seal failed — actions left unsealed; GC will re-seal this completed run on the next sweep",
        );
```

- [ ] **Step 2: Update the sweep-controller GC mock return shape** (add `resealed`)

In `server/src/__tests__/sweep-controller.test.ts`, both the default mock (line ~78) and the `beforeEach` reset (line ~132):
```ts
  mockGcOrphanedProposedActions: vi.fn().mockResolvedValue({ reaped: 0, runsTerminalized: 0, resealed: 0 }),
```
```ts
    mockGcOrphanedProposedActions.mockResolvedValue({ reaped: 0, runsTerminalized: 0, resealed: 0 });
```
If `runControllerSweep` logs GC counts, add `resealed` to that log line for parity (grep the call site; if it only awaits best-effort, no further change).

- [ ] **Step 3: Run the unit suite (Windows, no Docker needed)**

```bash
npx vitest run src/__tests__/sweep-controller.test.ts src/__tests__/thread-agent-actions.test.ts
```
Expected: PASS (GC mock shape updated; no GC-internal unit test exists — internals are integration-only).

- [ ] **Step 4: Commit**

```bash
git add server/src/services/internal-agent/aoa-agents/runner.ts server/src/__tests__/sweep-controller.test.ts
git commit -m "docs(seal): runner seal-failure recovers via GC re-seal; sweep mock adds resealed"
```

---

## Task 5: Full Docker gate + tsc, then reply to Codex

- [ ] **Step 1: Full integration + type gate in Docker**

```bash
docker compose -f docker-compose.test.yml run --rm server \
  sh -c "npx tsc --noEmit && npx vitest run src/__tests__/thread-commit-idempotency.integration.test.ts src/__tests__/thread-agent-actions.test.ts src/__tests__/sweep-controller.test.ts src/__tests__/thread-controller-action-gate.test.ts"
```
Expected: tsc clean; all listed suites green. (Treat the 3 known-environmental reds — `cli-mode-codex-integration`, `workspace-runtime`, `skill-bundle-materializer` — as out of scope; they touch no file in this plan.)

- [ ] **Step 2: Push**

```bash
git push origin HEAD
```

- [ ] **Step 3: Reply in-thread to each Codex comment** (no top-level, no thanks; `gh api .../comments/{id}/replies`)
  - `3442809584` (#1): push back — false positive; cite the six content-hashed key builders + seal-by-own-key-set; the GC re-seal uses the same rule.
  - `3442809588` (#2): fixed — zombie TTL raised to 2h (≫ 30-min idle timeout); long-but-live runs never force-failed; cite the new 40-min-live test.
  - `3442809591` (#3): fixed — GC re-seals completed runs' proposed rows by key-set, making the in-band seal retryable; cite the re-seal + collided-row tests.

- [ ] **Step 4: Re-trigger review** — top-level `@codex review` comment on the PR.

---

## Self-Review

- **Spec coverage:** #2 → Task 3 (zombie TTL + 40-min-live proof). #3 → Task 1 (re-seal Step 2) + Task 4 (runner comment, swallow now safe). #1 → pushback section + Task 5 reply. Collided-row completeness → Task 2 Step 1. Orphan-stuck-forever (adversarial review) → Task 1 Step 4 + Task 2 Step 2 test.
- **Type consistency:** `GcOrphanedProposedActionsResult` gains `resealed`; `reaped` now sums Step 3 + Step 4 terminalizations. Opts param renamed `staleMs`→`zombieRunMs` at the only two callers: the integration test (Task 3) and the default sweep call `gcOrphanedProposedActions(db)` (uses defaults — unaffected). Mock return shape updated in Task 4.
- **No schema change:** `proposed_action_keys` already shipped (0147); Step 2 reads it via `jsonb_array_elements_text`/`jsonb_array_length` (embedded-pg supports both). `STALE_COMMITTING_TTL_MS` survives (reused by Step 4 orphan cutoff + the separate `reapStaleThreadAgentActions`). Verify `lt` is imported (current GC already uses it).
- **Ordering invariant:** Step 2 (re-seal) precedes Steps 3/4 (terminalize) so a recoverable row becomes `ready` first; the terminalize passes only match `status='proposed'`, so they never clobber a re-sealed row.
- **No false-crash, no permanent-stuck (adversarial review verdicts):** Step 1 only touches `running` runs past the 2h TTL; Steps 3/4 only touch `failed`/`cancelled`/`completed`/null producers — never a live `running` run. Every `proposed` row reaches a terminal state (re-sealed, committed, terminalized) within bounded time. Re-sealed rows still pass the live freshness re-check at commit (`commitThreadAgentActions` → `compareFreshnessSnapshot`), so re-seal grants *eligibility*, not *exemption*.
- **Tenant isolation:** Step 2's subquery is correlated `r.company_id = thread_agent_actions.company_id` (defense-in-depth beyond the threadId-in-key contract), matching the in-band seal's company scoping.
- **Open perf note (follow-up, not this PR):** Step 2's subquery scans `completed` runs with non-empty `proposed_action_keys` (crew runs only). Fine at founding-team scale; add a partial index `(company_id, status) WHERE jsonb_array_length(proposed_action_keys) > 0` if run volume grows.
