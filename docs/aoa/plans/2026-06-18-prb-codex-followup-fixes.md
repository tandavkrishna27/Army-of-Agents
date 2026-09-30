# PR #203 Codex Follow-up Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix the two verified regressions PR-B introduced (revive drops fresh snapshot; artifact attaches across runs), close the adjacent reaper liveness gap, and push back on the one false-positive — all on PR #203's branch.

**Architecture:** Three small, atomic code fixes in `thread-agent-actions.ts` (each its own commit), each TDD'd with a mock-DB unit test (Windows-runnable) AND a real-DB integration test (Linux/Docker-only — the authoritative gate). Finding 3 is a reply-only push-back, not a code change.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, Vitest 3, embedded-postgres (Docker for real-DB).

---

## Context — what we're fixing (verified, not guessed)

A confirm+refute verification pass over the 3 Codex P2 comments on [#203](https://github.com/MeteoriteLabs/AoA/pull/203) found:
- **F1 (revive freshness):** REAL regression, PR-B introduced. Low-risk (one stranded action; narrow trigger).
- **F2 (artifact cross-run):** REAL regression, PR-B introduced. Low-risk (one wrong attachment; no dup, no tenant crossing).
- **F3 (all-lost-CAS advances):** FALSE POSITIVE — unreachable because cursor-advancing commits use disjoint idempotency keys + `pendingRun` serialization. **Reply, don't fix.**
- **Adjacent (reaper):** REAL, separable — the reaper flips `committing→failed` without re-arming `pendingRun`, so a recovered row on a then-quiet thread waits for the next human entry. Bounded (deferred, not lost).

## Worktree + commands

Work in `C:/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/AoA-prb` (branch `feat/prb-thread-scoped-claim`). Mock unit + typecheck run on Windows; the real-DB integration tests **skip on Windows** and are verified in a `node:24` Docker container (`pr.yml` does not run on `feat/v1-combined`):
- Unit: `pnpm -C "<wt>/server" exec vitest run src/__tests__/<file>`
- Typecheck: `pnpm -C "<wt>/server" typecheck`
- Docker integration (controller runs this): `git archive HEAD | docker run -i node:24 bash -lc '… pnpm install … build deps … su node -c "vitest run src/__tests__/thread-commit-idempotency.integration.test.ts"'`

## File Structure

| File | Change |
|------|--------|
| `server/src/services/thread-agent-action-freshness.ts` | **export** `isSnapshotUnavailable` (currently module-private, line ~120) |
| `server/src/services/thread-agent-actions.ts` | F1 revive (`~333-339`), F2 artifact state+attach (`~394-395`, `~527-532`, `~829-835`), reaper (`reapStaleThreadAgentActions`) |
| `server/src/__tests__/thread-agent-actions.test.ts` | F1 + F2 + reaper mock unit tests |
| `server/src/__tests__/thread-commit-idempotency.integration.test.ts` | F1 + F2 + reaper real-DB proofs |

---

## Task 1 — F1: revive adopts the re-proposing run's fresh snapshot (guarded)

**Files:** `thread-agent-action-freshness.ts`, `thread-agent-actions.ts`, both test files.

- [ ] **Step 1: Export the guard.** In `server/src/services/thread-agent-action-freshness.ts`, change `function isSnapshotUnavailable(` (~line 120) to `export function isSnapshotUnavailable(`. In `thread-agent-actions.ts`, add `isSnapshotUnavailable` to the existing import from `"./thread-agent-action-freshness.js"` (it already imports `compareFreshnessSnapshot`, `type ThreadFreshnessSnapshot`).

- [ ] **Step 2: Write the failing unit test** (`thread-agent-actions.test.ts`, beside the existing revive test ~line 129):
```ts
it("revive of a suppressed_stale row ADOPTS the re-proposing run's fresh snapshot (Codex #203 F1)", async () => {
  const existing = { ...baseAction, id: "ex", runId: "run-1", status: "suppressed_stale", blockedReason: "newer_scope_version" };
  const fresh = { threadId: "thread-1", latestHumanSeq: 4, latestScopeVersionId: "sv-2" };
  const db = createSequenceDb({ selects: [[thread], [existing]], inserts: [[]], updates: [[{ ...existing, status: "proposed" }]] });
  await threadAgentActionService(db as never).proposeThreadAction({
    companyId: "company-1", threadId: "thread-1", runId: "run-2", agentId: null,
    actionType: "post_reply", payload: { rawContent: "x" }, idempotencyKey: existing.idempotencyKey, freshness: fresh,
  });
  // A REAL snapshot must be persisted so the next commit re-checks against current state, not the frozen stale one.
  expect(db.__updateSets[0]).toMatchObject({ status: "proposed", blockedReason: null, freshness: fresh });
});
```
The existing test at ~line 129 (passes `freshness: {}` and asserts freshness is NOT rewritten) stays valid — an empty snapshot must NOT clobber the stored one. Keep it.

- [ ] **Step 3: Run — expect FAIL** (current revive never sets `freshness`).
Run: `pnpm -C "<wt>/server" exec vitest run src/__tests__/thread-agent-actions.test.ts`

- [ ] **Step 4: Implement.** Replace the revive `.set({...})` (~lines 334-338):
```ts
          .set({
            status: "proposed",
            blockedReason: null,
            // (Codex #203 F1) Adopt the re-proposing run's CURRENT snapshot so a genuinely-
            // fresh same-turn re-proposal commits instead of re-suppressing against the frozen
            // pre-bump snapshot. Guard: an empty/unavailable snapshot must NOT clobber the real
            // stored one (keep the stored snapshot in that case). This restores what PR-A's
            // re-home did and PR-B over-removed.
            ...(isSnapshotUnavailable(input.freshness as ThreadFreshnessSnapshot)
              ? {}
              : { freshness: input.freshness ?? {} }),
            updatedAt: new Date(),
          })
```
Update the comment above the `if (existing && existing.status === "suppressed_stale")` block: change "Status flip ONLY (no runId/freshness rewrite…)" to "Status flip + adopt the current run's freshness (guarded); no runId rewrite (commit is thread-scoped)."

- [ ] **Step 5: Run — expect PASS** (new test green; existing empty-snapshot test still green). Typecheck clean.

- [ ] **Step 6: Add the real-DB proof** (`thread-commit-idempotency.integration.test.ts`, inside the skipIf block):
```ts
it("a suppressed_stale row re-proposed with a fresh snapshot commits (Codex #203 F1)", async () => {
  if (setupError) throw new Error(String(setupError));
  const runA = await seedRun();
  const actionId = randomUUID();
  // Seed a terminal suppressed_stale post_reply with a STALE snapshot (old scope version).
  const stale = { threadId, latestHumanSeq: 1, latestScopeVersionId: "sv-old" };
  await db.execute(sql`INSERT INTO thread_agent_actions (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness, blocked_reason)
    VALUES (${actionId}, ${companyId}, ${threadId}, ${runA}, ${agentId}, 'post_reply', 'suppressed_stale', ${JSON.stringify({ rawContent: "x" })}::jsonb, ${`k:${actionId}`}, ${JSON.stringify(stale)}::jsonb, 'newer_scope_version')`);
  // Re-propose same key with a FRESH snapshot (current scope version), then commit.
  const fresh = await captureSnapshot(threadId);
  await threadAgentActionService(db).proposeThreadAction({
    companyId, threadId, runId: await seedRun(), agentId, actionType: "post_reply",
    payload: { rawContent: "x" }, idempotencyKey: `k:${actionId}`, freshness: fresh,
  });
  const res = await threadAgentActionService(db).commitThreadAgentActions({ companyId, threadId, runId: await seedRun() });
  expect(res.committed).toBe(1);
  const row = rowsOf(await db.execute(sql`SELECT status FROM thread_agent_actions WHERE id=${actionId}`));
  expect(row[0].status).toBe("committed"); // NOT re-suppressed
});
```
(Controller Docker-verifies; adjust INSERT columns/`captureSnapshot` to the harness.)

- [ ] **Step 7: Commit.**
```bash
git commit -am "fix(threads): revive adopts the re-proposing run's fresh snapshot, guarded (Codex #203 F1)"
```

---

## Task 2 — F2: run-scope the implicit artifact→reply attachment

The thread-scoped batch can span runs; `sameRunReplyEntryId` has no run identity, so a targetless artifact from run B attaches to run A's reply. Tag the buffered artifacts + the reply pointer with `runId` and only attach within the same run.

**Files:** `thread-agent-actions.ts`, both test files.

- [ ] **Step 1: Write the failing unit test** (`thread-agent-actions.test.ts`): a batch with a `post_reply` under `runId:"run-A"` and a targetless `create_artifact_candidate` under `runId:"run-B"` → the artifact must NOT attach to run-A's reply. Assert via the deps' `attachArtifactToEntry`/`discussionEntryAttachments` insert spy (mirror the existing same-run attach test at ~line 1062, but with two runIds). Concretely, assert the artifact's attach is NOT called with run-A's entry id (it falls to the buffer and stays unattached).

- [ ] **Step 2: Run — expect FAIL** (today it cross-attaches).

- [ ] **Step 3: Implement — tag state with runId + guard the attach.**

(a) Declarations (~lines 394-395):
```ts
      const sameRunArtifacts: Array<{ artifactId: string; attachedEntryId: string | null; runId: string | null }> = [];
      let sameRunReplyEntryId: string | null = null;
      let sameRunReplyRunId: string | null = null;
```
(b) post_reply set + drain (~lines 527-532):
```ts
            sameRunReplyEntryId = entry.id;
            sameRunReplyRunId = action.runId;
            for (const artifactRef of sameRunArtifacts) {
              if (artifactRef.attachedEntryId) continue;
              // (Codex #203 F2) Thread-scoped batches span runs — only implicitly attach an
              // artifact to a reply from the SAME run; cross-run attaches link the wrong reply.
              if (artifactRef.runId == null || action.runId == null || artifactRef.runId !== action.runId) continue;
              await attachArtifactToEntry(artifactRef.artifactId, entry.id);
              artifactRef.attachedEntryId = entry.id;
            }
```
(c) create_artifact_candidate attach branch (~lines 829-835):
```ts
                if (explicitEntryId) {
                  await attachArtifactToEntry(artifact.id, explicitEntryId, tx);
                } else if (
                  sameRunReplyEntryId &&
                  sameRunReplyRunId != null &&
                  action.runId != null &&
                  sameRunReplyRunId === action.runId
                ) {
                  await attachArtifactToEntry(artifact.id, sameRunReplyEntryId, tx);
                } else {
                  sameRunArtifacts.push({ artifactId: artifact.id, attachedEntryId: null, runId: action.runId });
                }
```

- [ ] **Step 4: Run — expect PASS** (cross-run no longer attaches; the existing same-run test at ~1062, where both actions share `run-1`, still passes). Typecheck clean.

- [ ] **Step 5: Add the real-DB proof** (`thread-commit-idempotency.integration.test.ts`): seed a `post_reply` under `runA` and a targetless `create_artifact_candidate` under `runB` (same thread, same turn), commit, assert there is **NO** `discussion_entry_attachments` row linking run-B's artifact to run-A's reply entry (the artifact ends unattached, buffered). Mirror the harness; controller Docker-verifies.

- [ ] **Step 6: Commit.**
```bash
git commit -am "fix(threads): run-scope implicit artifact->reply attachment for cross-run batches (Codex #203 F2)"
```

---

## Task 3 — Reaper re-arms `pendingRun` for retryable recovered rows

So a recovered row is re-driven by the controller sweep (which only drains `pendingRun=true`) instead of waiting for an unrelated future trigger. (Own commit; split to a follow-up PR if you want #203 strictly the two regressions.)

**Files:** `thread-agent-actions.ts`, both test files.

- [ ] **Step 1: Import the table.** In `thread-agent-actions.ts`, add `threadOrchestrationState` to the existing `@armyofagents/db` import block.

- [ ] **Step 2a: Extend the reaper mock first.** The existing `createReaperDb` (`thread-agent-actions.test.ts` ~line 1358) returns a single `update()` stream and cannot distinguish the reap UPDATE from the new `threadOrchestrationState` re-arm UPDATE. Extend it so each `update(table)` call records `(table, setPayload)` into an array (e.g. `__updates: Array<{ table: unknown; set: unknown }>`), the FIRST update's `.returning()` yields the reaped rows, and subsequent updates' `.returning()` yield `[]`. (Mirror how `createSequenceDb` already pushes every `.set()` arg.) Without this the assertion below cannot be written.

- [ ] **Step 2b: Write the failing unit test** (`thread-agent-actions.test.ts`): call `reapStaleThreadAgentActions` with the extended mock whose reap `.returning()` yields one reaped row `{ threadId: "t1", attemptCount: 1, maxAttempts: 3 }`; assert a SECOND `update` targeting `threadOrchestrationState` is issued with `set` containing `pendingRun: true` (via `__updates`). Also a guard test: a reaped row at `attemptCount: 3, maxAttempts: 3` (poison) → NO second update (no `pendingRun` re-arm).

- [ ] **Step 3: Run — expect FAIL** (reaper does not touch `threadOrchestrationState`).

- [ ] **Step 4: Implement.** In `reapStaleThreadAgentActions`, type the `.returning()` and add the re-arm after it:
```ts
  const reaped = (await reaperDb
    .update(threadAgentActions)
    .set({
      status: "failed",
      blockedReason: "reaped_stale_committing",
      attemptCount: sql`${threadAgentActions.attemptCount} + 1`,
      updatedAt: now,
    })
    .where(and(inArray(threadAgentActions.status, ["committing"]), lt(threadAgentActions.updatedAt, cutoff)))
    .returning()) as Array<{ threadId: string; attemptCount: number; maxAttempts: number }>;

  // (Codex #203, adjacent) Re-arm pendingRun for threads whose reaped rows are still
  // retryable (attemptCount < maxAttempts) so the controller sweep re-drives them; the
  // sweep only selects pendingRun=true threads. Poison rows (at the cap) are NOT re-armed.
  const retryableThreadIds = [
    ...new Set(reaped.filter((r) => (r.attemptCount ?? 0) < (r.maxAttempts ?? 3)).map((r) => r.threadId)),
  ];
  if (retryableThreadIds.length > 0) {
    await reaperDb
      .update(threadOrchestrationState)
      .set({ pendingRun: true })
      .where(inArray(threadOrchestrationState.threadId, retryableThreadIds));
  }

  return { reaped: reaped.length };
```

- [ ] **Step 5: Run — expect PASS** (re-arm fires for the retryable row; not for the poison row). Typecheck clean.

- [ ] **Step 6: Add the real-DB proof** (`thread-commit-idempotency.integration.test.ts`): seed a stale `committing` `post_reply` (>TTL, retryable), run `reapStaleThreadAgentActions`, then assert `thread_orchestration_state.pending_run = true` for that thread (seed the orchestration-state row first if the harness doesn't already).

- [ ] **Step 7: Commit.**
```bash
git commit -am "fix(threads): reaper re-arms pendingRun for retryable recovered rows (re-drive liveness)"
```

---

## Task 4 — Replies + verification gate + re-nudge

- [ ] **Step 1: Full gate on the final HEAD.** Mock unit suite green (`vitest run src/__tests__/thread-agent-actions.test.ts`), full server suite green (`vitest run`), typecheck clean, `db:generate` emits NO migration, and the **Docker integration run** green (all integration tests incl. the 3 new proofs).

- [ ] **Step 2: Push** the branch.

- [ ] **Step 3: Reply in each Codex thread** (thread-reply, no performative thanks):
  - F1 (`:337`): fixed in `<sha>` — revive now adopts `input.freshness` (guarded by `isSnapshotUnavailable`); restored what PR-A did. Test added.
  - F2 (`:378`): fixed in `<sha>` — implicit artifact attach is now run-scoped (`runId`-tagged buffer + same-run guard). Cross-run regression test added.
  - F3 (`:467`): **push back.** Not reachable: the only cursor-advancing committer is the controller's Adjutant commit (`thread-orchestration.ts` runController; `runner.ts:539` self-flush advances no cursor); every other run proposes under a different `agentId`+`turnAnchor` → disjoint idempotency keys → disjoint rows (can't lose a CAS to each other), and the `pendingRun` atomic claim serializes Adjutant drivers. The common all-zero case (Adjutant proposed nothing) advances correctly (the cursor tracks human entries, not actions). Separately, we re-armed `pendingRun` in the reaper (`<sha>`) to close the adjacent re-drive liveness gap.

- [ ] **Step 5: PR-body coverage note.** State that the reaper `pendingRun` re-arm only re-drives threads that already have a `threadOrchestrationState` row (controller-driven threads). The `runner.ts:539` self-flush path can leave a `committing` row on a thread without an orchestration row; for those, the re-arm no-ops and recovery still waits for an external trigger — pre-existing (not introduced here), but noted so the fix isn't mistaken for full coverage.

- [ ] **Step 4: Re-nudge** `@codex review`.

---

## Self-Review (writing-plans checklist)

1. **Spec coverage:** F1 (Task 1), F2 (Task 2), reaper-adjacent (Task 3), F3 push-back + gate + replies (Task 4). ✅
2. **Placeholder scan:** complete before/after code for all three fixes; the `…` in INSERT column lists / `captureSnapshot` are flagged "match the harness" (real-DB seeding the engineer fills from the live schema), consistent with the existing integration tests. ✅
3. **Type/anchor consistency:** `isSnapshotUnavailable` exported then imported+used (Task 1); `ThreadFreshnessSnapshot` already imported; `sameRunReplyRunId`/`runId`-tagged `sameRunArtifacts` defined and used consistently (Task 2); `threadOrchestrationState` imported then used (Task 3); the freshness guard semantics (empty → keep stored) match the existing-test invariant. ✅
4. **Risk/scope:** F3 is correctly a reply-only (no speculative code, YAGNI); each fix is its own atomic commit; mock unit (Windows) + Docker integration (real-DB) per fix; reaper split-able to a follow-up if #203 is kept minimal. ✅
