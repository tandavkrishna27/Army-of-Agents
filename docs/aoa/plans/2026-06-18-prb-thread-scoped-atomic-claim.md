# PR-B — Thread-Scoped Atomic-Claim Commit (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the run-scoped commit of thread agent actions (and its PR-A band-aids — the re-home block + the `eq(runId)` SELECT filter) with a **thread-scoped, status-CAS atomic claim**, so any run can drain a thread's pending actions exactly once.

**Architecture:** Mirror the codebase's own transactional-outbox / status-CAS house pattern (`inbox-router.ts`). The commit SELECT drops the per-run filter and selects by `(companyId, threadId, status∈{proposed,failed})`. The `proposed→committing` claim becomes a **fenced compare-and-swap** (`WHERE id=? AND status IN ('proposed','failed') AND attempt_count=? AND updated_at=? RETURNING *`); an empty `.returning()` = lost race = no-op. The existing `source_action_id` partial-unique indexes + convergence branches remain the duplicate-suppression backstop. **Code-only — no DB migration.**

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, Vitest 3, embedded-postgres (real-DB integration). Server package = `@armyofagents/server`.

---

## ⚠️ Critical context (read before starting)

1. **Branch / "code is truth".** The code under change (`thread-agent-actions.ts`, `thread-orchestration.ts`, `thread-action-keys.ts`, the integration test) lives on **`feat/v1-combined`** (migration head **`0146_good_sandman``), NOT on `feat/v1-upgrade` (head `0122`). **Create the worktree from `feat/v1-combined`.** An adversarial reviewer flagged a false "files don't exist" blocker precisely because it read the stale `feat/v1-upgrade` checkout — do not repeat that. **Task 0 verifies the anchors before any change.**

2. **Two slices — keep them separate.**
   - **PR-B (this plan, Tasks 0–9):** the thread-scoping core. Self-contained, code-only.
   - **PR-B2 (Tasks 10–12, ship as a SEPARATE PR):** the convene/wakeup dedup discriminator. It shares **no** code path, index, or test with the core (adversarial scope review). Bundling doubles blast radius. Land PR-B first.

3. **Deploy safety — NOT a single safe commit on multi-pod.** During a rolling deploy, OLD pods run the *unconditional* `UPDATE…SET status='committing'` claim while NEW pods run the CAS; an OLD pod can re-stamp a row a NEW pod is committing → double side-effect for the four action types without a `source_action_id` backstop (`create_scope_draft`, `convene_agent`, `advance_phase`, and partially `add_scope_item`). **Mitigation baked into task order:** Task 2 ships the **fenced CAS claim alone** (a superset-safe change: old run-scoped selection still works, but now *both* old and new pods claim atomically). Only after that is rolled out does Task 4 drop `eq(runId)`. If your deployment is single-instance (most `local_trusted` AoA installs), this ordering is a no-op safety margin; document which you are in the PR body.

4. **Reviewer must-fixes folded into tasks:** fenced CAS (Task 2), crash-recovery convergence test (Task 6 — *the* most important test), minimal `suppressed_stale→proposed` revive-on-conflict kept (Task 5), poison-row attempt-cap test (Task 7), `snapshot_unavailable` suppression proof (Task 8), genuine two-connection concurrency e2e (Task 9), stable-`sourceActionId` (not free-text `reason`) discriminator for PR-B2 (Task 11).

---

## Setup

- [ ] **Create the worktree from the right base**

```bash
cd <repo-root>
git fetch origin feat/v1-combined
git worktree add ../AoA-prb -b feat/prb-thread-scoped-claim origin/feat/v1-combined
pnpm -C ../AoA-prb install
pnpm -C ../AoA-prb -r --filter "!@armyofagents/server" --filter "!@armyofagents/ui" build   # build dep packages so server typecheck works
```

All paths below are relative to `../AoA-prb`. Single-file test command (server roots at `server/`, so paths are server-relative):
`pnpm -C ../AoA-prb/server exec vitest run src/__tests__/<file>`

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `server/src/services/thread-agent-actions.ts` | propose/commit/reaper of thread actions | core: fenced CAS claim, thread-scoped SELECT, remove re-home (keep minimal revive) |
| `server/src/services/thread-orchestration.ts` | controller sweep that calls commit; circuit-breaker | doc-only: correct the "retry by re-running the agent" rationale; add the runEpoch↔freshness equivalence note |
| `server/src/__tests__/thread-agent-actions.test.ts` | mock-DB unit tests for propose/commit | CAS unit tests; re-home-removal regression; (PR-B2) convene dedupKey assertion at the convene producer |
| `server/src/__tests__/thread-commit-idempotency.integration.test.ts` | real-DB (embedded-postgres) proofs | concurrency e2e, cross-run e2e, crash-recovery convergence, poison-row cap, snapshot_unavailable suppression |
| `server/src/services/internal-agent/tools/thread-action-keys.ts` | (PR-B2) wakeup dedupKey builder | add `buildConveneWakeupDedupKey` (stable sourceActionId); resolve the deferral docblock |

---

## Task 0: Verify the anchors against `feat/v1-combined` (no code change)

**Files:** read-only.

- [ ] **Step 1: Confirm the subsystem + migration head exist on this branch**

```bash
cd ../AoA-prb
grep -n "updateActionStatus" server/src/services/thread-agent-actions.ts        # expect the helper (~L173-201) + the claim call site
grep -n "eq(threadAgentActions.runId, input.runId)" server/src/services/thread-agent-actions.ts   # the run-scoping to remove
grep -n "REHOMABLE_STATUSES" server/src/services/thread-agent-actions.ts          # the re-home block to remove
grep -n "0146_good_sandman" packages/db/src/migrations/meta/_journal.json        # confirm migration head = 0146
grep -rn "WHERE.*status.*RETURNING\|onConflict\|claimNext\|skipLocked" server/src/services/internal-agent/aoa-agents/inbox-router.ts  # the house CAS pattern to mirror
```
Expected: all match. If the `runId` filter / re-home block are absent, **STOP** — you are on the wrong branch.

- [ ] **Step 2: Record the exact current line numbers** of: the commit SELECT `where(and(...))`, the `proposed→committing` claim call, `updateActionStatus`, the re-home block, and `reapStaleThreadAgentActions`. Use these as anchors; the line numbers below are from the investigation snapshot and may have shifted ±a few lines.

---

## Task 1: Pin current commit/claim behavior with characterization tests

Lock the *current* behavior so the refactor is provably behavior-preserving where intended.

**Files:**
- Test: `server/src/__tests__/thread-agent-actions.test.ts`

- [ ] **Step 1: Add a characterization test for the run-scoped SELECT (current behavior)**

```ts
it("(characterization) commit currently selects only rows matching input.runId", async () => {
  // Two proposed rows, different runIds; commit(runId=run-1) sees only run-1's row.
  const rowA = { ...baseAction, id: "a", runId: "run-1", status: "proposed" };
  const rowB = { ...baseAction, id: "b", runId: "run-2", status: "proposed" };
  const db = createSequenceDb({ selects: [[rowA]] }); // mock returns only the run-1 match
  const svc = threadAgentActionService(db as never, fakeDeps());
  const res = await svc.commitThreadAgentActions({ companyId: "company-1", threadId: "thread-1", runId: "run-1" });
  // Document today's contract: the SELECT is keyed on runId (mock encodes that).
  expect(res).toBeDefined();
});
```

- [ ] **Step 2: Run + commit**

Run: `pnpm -C ../AoA-prb/server exec vitest run src/__tests__/thread-agent-actions.test.ts`
Expected: PASS.
```bash
git add server/src/__tests__/thread-agent-actions.test.ts && git commit -m "test(threads): characterize current run-scoped commit selection (PR-B baseline)"
```

---

## Task 2: Fenced CAS claim (deploy-safe Release-1 — ship + roll out BEFORE Task 4)

Convert the `proposed→committing` claim into a fenced compare-and-swap. This is safe regardless of run-scoping: it only *narrows* the unconditional update.

**Files:**
- Modify: `server/src/services/thread-agent-actions.ts` (`updateActionStatus` + the claim call site)
- Test: `server/src/__tests__/thread-agent-actions.test.ts`

- [ ] **Step 1: Write the failing CAS unit test**

```ts
it("claim CAS returns empty when the row already left {proposed,failed} (lost race → no-op)", async () => {
  // updateActionStatus claim form must issue UPDATE ... WHERE id=? AND status IN (...) AND attempt_count=? AND updated_at=?
  const db = createSequenceDb({ updates: [[]] }); // CAS matched 0 rows
  const svc = threadAgentActionService(db as never, fakeDeps());
  const claimed = await svc.__claimForCommit("act-1", { status: "proposed", attemptCount: 0, updatedAt: BASE_TS });
  expect(claimed).toBeNull();               // empty returning → null → caller continues
  expect(db.__updateSets[0]).toMatchObject({ status: "committing" });
});

it("claim CAS succeeds and returns the row when preconditions still hold", async () => {
  const row = { ...baseAction, id: "act-1", status: "committing" };
  const db = createSequenceDb({ updates: [[row]] });
  const svc = threadAgentActionService(db as never, fakeDeps());
  const claimed = await svc.__claimForCommit("act-1", { status: "proposed", attemptCount: 0, updatedAt: BASE_TS });
  expect(claimed?.id).toBe("act-1");
});
```
(Expose a thin `__claimForCommit` test seam, or assert the SQL via `__updateSets` if you prefer not to widen the API — match the file's existing test style.)

- [ ] **Step 2: Run — expect FAIL** (`__claimForCommit` / fenced form not present).

Run: `pnpm -C ../AoA-prb/server exec vitest run src/__tests__/thread-agent-actions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the fenced CAS claim**

In `updateActionStatus` (or a dedicated claim helper), the `proposed→committing` transition must be:
```ts
// Fenced compare-and-swap claim. The status set + the observed (attemptCount, updatedAt)
// fence the act to the check: a concurrent reaper/failure flip changes attempt_count or
// updated_at, so a stale claimer's UPDATE matches 0 rows and we treat it as a lost race.
const [claimed] = await db
  .update(threadAgentActions)
  .set({ status: "committing", updatedAt: new Date() })
  .where(
    and(
      eq(threadAgentActions.id, actionId),
      or(eq(threadAgentActions.status, "proposed"), eq(threadAgentActions.status, "failed")),
      eq(threadAgentActions.attemptCount, observed.attemptCount),
      eq(threadAgentActions.updatedAt, observed.updatedAt),
    ),
  )
  .returning();
return claimed ?? null;
```
At the call site (the current unconditional `proposed→committing`), replace it with this claim; if it returns `null`, `continue` the loop (do not count it). **Keep the per-action freshness re-check BEFORE the claim** (unchanged).

- [ ] **Step 4: Run — expect PASS**, then commit.
```bash
git add -A && git commit -m "fix(threads): fenced CAS claim for proposed->committing (PR-B Release-1, deploy-safe)"
```

> **DEPLOY GATE:** This commit is independently shippable and should be fully rolled out before Task 4 on multi-pod deployments. On single-instance deployments it can land together; note which in the PR body.

---

## Task 3: Real-DB harness — seed two runs + a snapshot helper

The integration test currently seeds `runId=null` to avoid the FK. Thread-scoping/concurrency tests need real runs.

**Files:**
- Modify: `server/src/__tests__/thread-commit-idempotency.integration.test.ts`

- [ ] **Step 1: Add a helper that seeds an `internal_agent_runs` row and returns its id** (inside the `describe.skipIf(process.platform === "win32")` block), and a helper that captures a real freshness snapshot via the production `captureFreshnessSnapshot` for the seeded thread. Mirror the existing company/thread seeding already in the file.

- [ ] **Step 2: Run the existing suite to confirm the harness still boots.**

Run: `pnpm -C ../AoA-prb/server exec vitest run src/__tests__/thread-commit-idempotency.integration.test.ts`
Expected: PASS on Linux/Docker; SKIPPED on Windows (embedded-postgres). Commit.

---

## Task 4: Thread-scoped commit SELECT (drop `eq(runId)`) — Release-2

**Files:**
- Modify: `server/src/services/thread-agent-actions.ts` (commit SELECT)
- Test: `server/src/__tests__/thread-commit-idempotency.integration.test.ts`

- [ ] **Step 1: Write the failing cross-run e2e**

```ts
it("thread-scoped commit drains a prior run's proposed row (cross-run)", async () => {
  if (setupError) throw new Error(String(setupError));
  const runA = await seedRun(); const runB = await seedRun();
  const snap = await captureSnapshot(threadId);
  const actionId = randomUUID();
  await db.execute(sql`INSERT INTO thread_agent_actions
    (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
    VALUES (${actionId}, ${companyId}, ${threadId}, ${runA}, null, 'post_reply', 'proposed',
            ${{ rawContent: "x" }}, ${`k:${actionId}`}, ${snap})`);
  // Commit under a DIFFERENT run:
  const res = await threadAgentActionService(db).commitThreadAgentActions({ companyId, threadId, runId: runB });
  expect(res.committed).toBe(1);
  const n = rowsOf(await db.execute(sql`SELECT count(*)::int n FROM discussion_entries WHERE source_action_id=${actionId}`));
  expect(Number(n[0].n)).toBe(1);
});
```

- [ ] **Step 2: Run — expect FAIL** (today the run-B commit ignores run-A's row).

- [ ] **Step 3: Drop the run filter.** In the commit SELECT, delete `eq(threadAgentActions.runId, input.runId)` so it reads:
```ts
.where(and(
  eq(threadAgentActions.companyId, input.companyId),
  eq(threadAgentActions.threadId, input.threadId),
  or(
    eq(threadAgentActions.status, "proposed"),
    and(eq(threadAgentActions.status, "failed"), lt(threadAgentActions.attemptCount, threadAgentActions.maxAttempts)),
  ),
))
.orderBy(asc(threadAgentActions.createdAt))
```
Keep `input.runId` on the input type as an optional **audit stamp only** (no selection use; both call sites unchanged).

- [ ] **Step 4: Run — expect PASS**, then commit.
```bash
git commit -am "fix(threads): thread-scoped commit selection — drop eq(runId) (PR-B Release-2)"
```

---

## Task 5: Remove the re-home block — but KEEP a minimal `suppressed_stale→proposed` revive-on-conflict

The re-home's runId-forwarding is now dead (thread-scoped SELECT sees rows regardless of run). But a same-turn re-proposal (same `idempotencyKey`) still collides via the unique index; without a revive it lands on a terminal `suppressed_stale` row and is stranded (adversarial migration review, high).

**Files:**
- Modify: `server/src/services/thread-agent-actions.ts` (`proposeThreadAction`)
- Test: `server/src/__tests__/thread-agent-actions.test.ts`

- [ ] **Step 1: Write the failing test — same-key re-propose revives a suppressed_stale row to proposed (status flip only, no runId rewrite)**

```ts
it("re-propose of a suppressed_stale row revives it to proposed (no runId/freshness rewrite)", async () => {
  const existing = { ...baseAction, id: "ex", runId: "run-1", status: "suppressed_stale", blockedReason: "newer_scope_version" };
  const db = createSequenceDb({ selects: [[thread], [existing]], inserts: [[]], updates: [[{ ...existing, status: "proposed", blockedReason: null }]] });
  const res = (await threadAgentActionService(db as never).proposeThreadAction({
    companyId: "company-1", threadId: "thread-1", runId: "run-2", agentId: null,
    actionType: "post_reply", payload: { rawContent: "x" }, idempotencyKey: existing.idempotencyKey, freshness: {},
  })) as { id: string; status: string };
  expect(res.status).toBe("proposed");
  expect(db.__updateSets[0]).toMatchObject({ status: "proposed", blockedReason: null });
  expect(db.__updateSets[0]).not.toHaveProperty("runId"); // runId NOT forwarded anymore
});
```

- [ ] **Step 2: Run — expect FAIL** (current re-home rewrites runId + freshness too).

- [ ] **Step 3: Replace the re-home block** (`REHOMABLE_STATUSES` / runId-forward / freshness-adopt) with the minimal revive:
```ts
// (PR-B) Thread-scoped commit sees rows regardless of runId, so the runId re-home is gone.
// We keep ONE narrow case: a same-turn re-proposal (same idempotencyKey) that collides with a
// terminal `suppressed_stale` row must revive it to `proposed` so the thread-scoped SELECT can
// re-pick it — otherwise the action is stranded. Status flip ONLY (no runId/freshness rewrite:
// the row commits against its own snapshot; a genuinely-stale row simply re-suppresses).
if (existing && existing.status === "suppressed_stale") {
  const [revived] = await actionDb
    .update(threadAgentActions)
    .set({ status: "proposed", blockedReason: null, updatedAt: new Date() })
    .where(and(eq(threadAgentActions.id, existing.id), eq(threadAgentActions.status, "suppressed_stale")))
    .returning();
  if (revived) return revived;
}
return existing;
```
Also delete: the `proposed`/`failed` re-home branches, `REHOMABLE_STATUSES`, and the freshness-adoption line.

- [ ] **Step 4: Update the stale doc assertion** in `thread-agent-actions.ts` claiming "the other four action types keep run-scoped keys" — factually wrong (all six builders are run-independent). Correct it to: "all six builders produce run-independent, turn-anchored keys; commit is thread-scoped."

- [ ] **Step 5: Remove the obsolete re-home tests** (the proposed/failed re-home assertions + the freshness-adopt assertion from earlier work) and keep only the revive test above.

- [ ] **Step 6: Run unit suite — expect PASS**, then commit.
```bash
git commit -am "fix(threads): remove runId re-home; keep minimal suppressed_stale revive-on-conflict"
```

---

## Task 6: Crash-recovery convergence (THE critical test) — reaper of a torn `committing` row reaches `committed`, not a re-select loop

If a process dies after a side-effect lands but before `committing→committed`, the reaper flips it `committing→failed`; the next thread-scoped drain re-selects it; the `source_action_id` convergence branch must promote it to **committed** (with `committed_entry_id`), not loop forever.

**Files:**
- Test: `server/src/__tests__/thread-commit-idempotency.integration.test.ts`
- Possibly modify: `server/src/services/thread-agent-actions.ts` (only if the test proves a gap)

- [ ] **Step 1: Write the failing crash-recovery e2e** (post_reply — has a `source_action_id` index)

```ts
it("reaper-recovered committing row with an existing side-effect converges to committed (not re-select loop)", async () => {
  if (setupError) throw new Error(String(setupError));
  const runA = await seedRun();
  const snap = await captureSnapshot(threadId);
  const actionId = randomUUID();
  // Simulate the torn write: a `committing` row whose discussion_entry ALREADY exists (side-effect landed pre-crash).
  await db.execute(sql`INSERT INTO thread_agent_actions (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness, updated_at)
    VALUES (${actionId}, ${companyId}, ${threadId}, ${runA}, null, 'post_reply', 'committing', ${{ rawContent: "x" }}, ${`k:${actionId}`}, ${snap}, now() - interval '20 minutes')`);
  await db.execute(sql`INSERT INTO discussion_entries (id, discussion_id, ..., source_action_id) VALUES (${randomUUID()}, ${threadId}, ..., ${actionId})`); // the orphaned side-effect
  // Reaper flips committing->failed (stale > TTL); then drain re-selects + converges.
  await reapStaleThreadAgentActions(db, /* now */);
  const res = await threadAgentActionService(db).commitThreadAgentActions({ companyId, threadId, runId: await seedRun() });
  // CONVERGE, do not duplicate, do not loop:
  const entries = rowsOf(await db.execute(sql`SELECT count(*)::int n FROM discussion_entries WHERE source_action_id=${actionId}`));
  expect(Number(entries[0].n)).toBe(1);                    // no duplicate
  const row = rowsOf(await db.execute(sql`SELECT status, committed_entry_id FROM thread_agent_actions WHERE id=${actionId}`));
  expect(row[0].status).toBe("committed");                 // terminal, not stuck/looping
  expect(row[0].committed_entry_id).not.toBeNull();
});
```

- [ ] **Step 2: Run — observe.** If it converges to `committed` with one entry, the existing convergence branch already handles it → **no code change**; keep the test as a guard. If it loops or ends `failed`, fix the `post_reply` unique-violation convergence branch so it sets `status="committed"` + `committedEntryId` from the re-selected entry. Either way, the test must pass.

- [ ] **Step 3: Commit.**
```bash
git commit -am "test(threads): crash-recovery — reaper-recovered committing row converges to committed"
```

---

## Task 7: Poison-row attempt-cap (prevent thread-tick livelock)

Thread-scoped selection re-picks accumulated `failed` rows every tick; a permanently-failing row must exit the selectable set after `maxAttempts` (it must not ride mixed batches forever).

**Files:**
- Test: `server/src/__tests__/thread-commit-idempotency.integration.test.ts`
- Verify (no change expected): `attemptCount` is bumped on every failure path incl. reaper.

- [ ] **Step 1: Write the failing/guard e2e**

```ts
it("a permanently-failing action stops being selected after maxAttempts (no livelock)", async () => {
  // Seed one action whose handler always throws (e.g. convene_agent with a target not in company → blocked_policy,
  // OR a post_reply with a committer dep stubbed to throw) alongside one always-succeeding action on the same thread.
  // Drive commit maxAttempts+1 times; assert the failing row reaches attempt_count>=maxAttempts and is NOT in the
  // next commit's selected set, while the thread does not keep scheduling solely for it.
  // ... seed, loop commitThreadAgentActions maxAttempts+1 times ...
  const row = rowsOf(await db.execute(sql`SELECT attempt_count, max_attempts, status FROM thread_agent_actions WHERE id=${failingId}`));
  expect(Number(row[0].attempt_count)).toBeGreaterThanOrEqual(Number(row[0].max_attempts));
});
```

- [ ] **Step 2: Run.** If green, the SELECT's `lt(attemptCount, maxAttempts)` + the catch-block `bumpAttempt` already prevent the livelock — keep as a guard. If the reaper path does NOT bump `attemptCount`, add `bumpAttempt: true` to the reaper's `committing→failed` flip. Commit.
```bash
git commit -am "test(threads): poison-row attempt cap prevents thread-tick livelock"
```

---

## Task 8: `snapshot_unavailable` suppression — prove every action type suppresses an empty-snapshot row

With `eq(runId)` gone and no turn predicate in the SELECT, an old prior-turn `proposed` row carrying an empty freshness snapshot becomes selectable by any future run. The ONLY guard is that the per-action freshness check maps `snapshot_unavailable → suppressed_stale` for **every** type. Prove it (don't assume).

**Files:**
- Test: `server/src/__tests__/thread-commit-idempotency.integration.test.ts`
- Optional defense-in-depth: `server/src/services/thread-agent-actions.ts` (age bound)

- [ ] **Step 1: Write the failing/guard e2e — empty-snapshot rows of EACH action type are suppressed, none commit**

```ts
it("empty-freshness (snapshot_unavailable) rows are suppressed for every action type, never committed", async () => {
  for (const t of ["post_reply","advance_phase","convene_agent","add_scope_item","create_artifact_candidate","create_scope_draft"]) {
    const id = randomUUID();
    await db.execute(sql`INSERT INTO thread_agent_actions (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
      VALUES (${id}, ${companyId}, ${threadId}, null, null, ${t}, 'proposed', ${minimalPayloadFor(t)}, ${`k:${id}`}, ${{}} /* empty snapshot */)`);
  }
  const res = await threadAgentActionService(db).commitThreadAgentActions({ companyId, threadId, runId: await seedRun() });
  expect(res.committed).toBe(0);
  expect(res.suppressed).toBe(6);
  const committed = rowsOf(await db.execute(sql`SELECT count(*)::int n FROM thread_agent_actions WHERE thread_id=${threadId} AND status='committed'`));
  expect(Number(committed[0].n)).toBe(0);
});
```

- [ ] **Step 2: Run.** If all six suppress → green; keep as the correctness guard for the dropped turn-partition. If ANY type proceeds on an empty snapshot, add a defense-in-depth predicate to the SELECT — `gt(threadAgentActions.createdAt, sql\`now() - interval '1 hour'\`)` — and re-run, OR fix that handler's freshness path. Commit.
```bash
git commit -am "test(threads): prove snapshot_unavailable suppresses for all action types (unfenced-replay guard)"
```

---

## Task 9: Genuine two-connection concurrency e2e (won/lost split)

A `Promise.all` of two commits on ONE connection can serialize and false-green. Prove real contention.

**Files:**
- Test: `server/src/__tests__/thread-commit-idempotency.integration.test.ts`

- [ ] **Step 1: Write the failing/guard e2e using two distinct DB clients**

```ts
it("two concurrent commits of the same thread → exactly one claims each row (no double side-effect)", async () => {
  const runA = await seedRun();
  const snap = await captureSnapshot(threadId);
  const actionId = randomUUID();
  await db.execute(sql`INSERT INTO thread_agent_actions (...) VALUES (..., 'post_reply', 'proposed', ...)`);
  const svc1 = threadAgentActionService(db);            // client 1
  const svc2 = threadAgentActionService(makeSecondClient()); // a SEPARATE pg connection to the same DB
  const [r1, r2] = await Promise.all([
    svc1.commitThreadAgentActions({ companyId, threadId, runId: runA }),
    svc2.commitThreadAgentActions({ companyId, threadId, runId: runA }),
  ]);
  // Convergence (timing-independent): exactly one discussion_entry.
  const n = rowsOf(await db.execute(sql`SELECT count(*)::int n FROM discussion_entries WHERE source_action_id=${actionId}`));
  expect(Number(n[0].n)).toBe(1);
  // Contention proof: the two commits' committed-counts sum to exactly 1 (one won the CAS, one lost).
  expect((r1.committed + r2.committed)).toBe(1);
});
```

- [ ] **Step 2: Run on Linux/Docker — expect PASS** (the fenced CAS gives the won/lost split; `source_action_id` backstops any residual). Commit.
```bash
git commit -am "test(threads): real two-connection concurrency e2e — fenced CAS won/lost split"
```

---

## Task 9b: Doc-only — orchestration rationale + runEpoch/freshness equivalence

**Files:**
- Modify: `server/src/services/thread-orchestration.ts` (comments only)

- [ ] **Step 1:** Delete/replace the "retry by re-running the agent" rationale comment (thread-scoped commit re-selects retryable-`failed` rows directly). Add one sentence making the cross-run-drain safety auditable:
> `runEpoch` (controller staleness) and `freshness.latestHumanSeq` advance on the same event (a new human entry via `triggerOnHumanEntry`), so the per-action freshness re-check subsumes the epoch gate for the runner self-flush path that does not read `runEpoch`.

- [ ] **Step 2: Commit.**
```bash
git commit -am "docs(threads): correct commit-retry rationale; note runEpoch↔freshness equivalence"
```

---

## Task 9c: PR-B verification gate (before opening the PR)

- [ ] **Prove code-only:** `pnpm -C ../AoA-prb db:generate` → **must emit no new migration** (CLAUDE.md Critical Rule #1). If it does, you changed a schema object you shouldn't have.
- [ ] **Index selectivity sanity:** `EXPLAIN ANALYZE` the new SELECT on a thread seeded with ~5k terminal rows; confirm `thread_agent_actions_company_thread_status_idx` serves the `proposed/failed`-only filter without a heap scan over terminal rows. If it doesn't, note a **possible fast-follow** partial index `WHERE status IN ('proposed','failed')` (a `0147` `CREATE INDEX CONCURRENTLY`) in the PR body — do **not** add it speculatively.
- [ ] **Full gates:** `pnpm -C ../AoA-prb/server typecheck` (clean) + `pnpm -C ../AoA-prb/server exec vitest run` (full server suite green) + the integration suite on **Linux/Docker** (Windows skips; `pr.yml` does NOT run on `feat/v1-combined`, so this manual Linux run is REQUIRED — state it in the PR body).
- [ ] **PR body:** document the **deploy ordering** (Task 2 CAS first, then Task 4) for multi-pod, or the single-instance assumption; list removals; note the residual null-turnAnchor content-only-dedup fence to #198.

---

# PR-B2 (SEPARATE PR) — Convene/Wakeup dedup discriminator

> Land this as its own PR after PR-B. Independent surface: a different producer + a different index, no shared code path.

## Task 10: Characterize the current convene wakeup dedupKey

**Files:**
- Read `server/src/services/thread-agent-actions.ts` (convene_agent commit, the `agentWakeupRequests` insert with `dedupKey = \`${targetAgentId}:${threadId}:queued\`` + bare `onConflictDoNothing()`), and `server/src/__tests__/thread-agent-actions.test.ts:~768` (the existing assertion `dedupKey: "<target>:<thread>:queued"`).

- [ ] Confirm the convene producer is the ONLY one to change; the other producers (`thread-events.ts`, `agent-dispatch.ts`) keep `${agentId}:${threadId}:queued` and their tests (`c2-agent-dispatch.test.ts`) stay unchanged.

## Task 11: Discriminate on STABLE `sourceActionId` (NOT free-text `reason`)

Free-text/LLM-derived `reason` makes dedup hostage to byte-stability — two racing processes with byte-different reasons would double-enqueue (concurrency review, high). Discriminate on the stamped, idempotent `sourceActionId` (= the action's `id`): two *distinct* convene actions (distinct ids) both enqueue; a same-action claim race collapses to one.

**Files:**
- Modify: `server/src/services/internal-agent/tools/thread-action-keys.ts` (add `buildConveneWakeupDedupKey`)
- Modify: `server/src/services/thread-agent-actions.ts` (convene commit uses it)
- Test: `server/src/__tests__/thread-agent-actions.test.ts`

- [ ] **Step 1: Write the failing tests** in `thread-agent-actions.test.ts`:
```ts
it("convene wakeup dedupKey is discriminated by sourceActionId (distinct actions enqueue separately)", () => {
  const k1 = buildConveneWakeupDedupKey({ targetAgentId: "t", threadId: "th", sourceActionId: "act-1" });
  const k2 = buildConveneWakeupDedupKey({ targetAgentId: "t", threadId: "th", sourceActionId: "act-2" });
  expect(k1).not.toBe(k2);
  expect(k1.endsWith(":queued")).toBe(true);
  // same action → same key (claim-race collapses to one)
  expect(buildConveneWakeupDedupKey({ targetAgentId: "t", threadId: "th", sourceActionId: "act-1" })).toBe(k1);
});
```
And update the convene-commit assertion (~L768) to expect the discriminated `${targetAgentId}:${threadId}:${discriminator}:queued` shape.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**
```ts
// thread-action-keys.ts — STABLE discriminator (sourceActionId), NOT free-text reason.
export function buildConveneWakeupDedupKey(i: { targetAgentId: string; threadId: string; sourceActionId: string }): string {
  const discriminator = sha256(JSON.stringify([i.targetAgentId, i.sourceActionId])).slice(0, 16);
  return `${i.targetAgentId}:${i.threadId}:${discriminator}:queued`;
}
```
In the convene commit, replace the inline `dedupKey` with `buildConveneWakeupDedupKey({ targetAgentId, threadId: input.threadId, sourceActionId: action.id })`. Keep the bare `onConflictDoNothing()` (the partial unique index `agent_wakeup_requests_dedup_key_queued_uq` over opaque text fires unchanged). Resolve the deferral docblock in `thread-action-keys.ts`.

- [ ] **Step 4: Add the integration assertion** — two distinct convene actions (distinct ids) to the same target/thread/turn both produce a queued wakeup (`count===2`); a re-commit of the SAME action collapses to one.

- [ ] **Step 5: Run unit + integration — expect PASS.** Confirm `pnpm db:generate` emits nothing (opaque-text index, no DDL). Commit.
```bash
git commit -am "fix(threads): convene wakeup dedup discriminated by stable sourceActionId (resolves #202 P2)"
```

## Task 12: PR-B2 deploy note

- [ ] **PR body:** during a rolling deploy, old-shape (`target:thread:queued`) and new-shape keys differ → at most one transient extra queued wakeup per target/thread in the deploy window; self-heals once the fleet is uniform. Confirm the wakeup **consumer** dedups/coalesces by `(agentId, threadId)` at claim time (or that a duplicate queued wakeup is a no-op because the first claim drains the work); if not, note it as a bounded deploy-window effect.

---

## Self-Review (writing-plans checklist)

1. **Spec coverage** — thread-scoping core (CAS claim T2, drop eq(runId) T4, remove re-home T5), every adversarial must-fix (fenced CAS T2, crash-recovery T6, minimal revive T5, poison cap T7, snapshot_unavailable T8, two-connection e2e T9, deploy-ordering T2/T9c), wakeup split to PR-B2 (T10-12) with stable-sourceActionId discriminator. ✅
2. **Placeholder scan** — concrete code/SQL in every implementation step; the few `...` are in INSERT column lists the engineer fills from the live schema (flagged), not logic gaps. The crash-recovery/poison/snapshot tests show the asserts + the seeding shape. ✅
3. **Type/anchor consistency** — `__claimForCommit`/fenced-CAS form (T2) reused by T6/T9; `buildConveneWakeupDedupKey` signature (T11) matches its tests; `suppressed_stale` revive (T5) consistent with the T8 suppression invariant. Line numbers are anchors-to-verify (T0), not load-bearing. ✅
4. **Decisions locked from the adversarial review** — status-CAS over SKIP-LOCKED/claim-column (no migration, house pattern); discriminator = sourceActionId not reason; deploy sequencing; PR-B/PR-B2 split. ✅
