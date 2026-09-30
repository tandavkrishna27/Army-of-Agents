# Outbox Seal — Implementation Plan (TDD)

> **For agentic workers:** execute task-by-task; every task ends GREEN (tsc + the named
> suites). Design + locked decisions: `2026-06-19-prb-outbox-seal-design.md` §0 (Mechanism
> **B** / seal-by-key-set; controller seal gates on run success; revive stays `proposed`;
> GC terminalizes-run-first; relay drains `ready`). Worktree: `AoA-prb`, branch
> `feat/prb-thread-scoped-claim`. Real-DB tests run in `node:24` Docker (non-root), unit on Windows.

**Keep-green strategy:** Pass 1 adds the seal writers + a SUPERSET relay (`ready OR proposed`)
so all existing `proposed`-seeding tests still pass. Pass 2 narrows the relay to `ready`-only,
migrates the relay tests to seed `ready`/seal-first, adds the GC, and lands the P1 proof. Both
passes ship in #203, so the final state is `ready`-only (the superset is transient, not deployed).

---

## Pass 1 — seal writers + superset relay (every commit green)

### Task 1.1 — `ready` status + seal primitive
- **File:** `server/src/services/thread-agent-actions.ts`
- Add a service method `sealRunActions({ companyId, threadId, idempotencyKeys: string[] }): Promise<number>`:
  `UPDATE thread_agent_actions SET status='ready', updated_at=now() WHERE company_id, thread_id,
  status='proposed', idempotency_key = ANY(keys) RETURNING` → returns count. No-op on empty keys.
- **Unit test** (`thread-agent-actions.test.ts`, mock-db): sealRunActions issues the UPDATE with
  the keys + status='proposed' fence; returns count.

### Task 1.2 — relay SUPERSET drain (`ready OR proposed OR failed-retry`)
- **File:** `thread-agent-actions.ts` commit SELECT (~410) + claim predicate (~258).
- SELECT: `status IN ('ready','proposed') OR (failed AND attempt<max AND not non-idempotent)`.
  Claim CAS: `status IN ('ready','proposed','failed')` (superset; narrowed in Pass 2).
- Existing tests unchanged (proposed still drains). **Unit test:** a `ready` row drains.

### Task 1.3 — key-set plumbing
- **Files:** the crew tool ctx type + the 6 tools + `runner.ts`.
- Add `recordProposedKey?: (key: string) => void` to the tool ctx (`internal-agent/tools/types.ts`
  or wherever ctx is typed). In each of the 6 tools, after `proposeThreadAction`, call
  `ctx.recordProposedKey?.(idempotencyKey)`. (post-entry, advance-phase, agent-dispatch,
  create-artifact, memory-propose, propose-crew-work.)
- `runAoaAgent` (runner.ts): create `const proposedKeys = new Set<string>()`, wire
  `recordProposedKey: (k)=>proposedKeys.add(k)` into the ctx it builds, and return
  `proposedKeys: [...proposedKeys]` on the run result.
- **Unit test:** a tool call records its key into the ctx set.

### Task 1.4 — direct-run seal on success (replace cancel-on-fail idea)
- **File:** `runner.ts` self-flush block (~531).
- On `runResult.status === 'succeeded'` (direct run): `await svc.sealRunActions({companyId,
  threadId, idempotencyKeys: proposedKeys})` in the SAME tx as the run-status write (Task 1.6),
  THEN the existing self-flush commit. On non-success: do NOTHING (no seal ⇒ never committable).
- **Unit/integration test:** direct success → rows `ready` then `committed`; direct failure →
  rows stay `proposed`, never committed.

### Task 1.5 — controller seal on success (BLOCKER must-fix #1)
- **Files:** `thread-orchestration.ts` (commit at line **632**), `controller-adjutant-runner.ts:149`.
- Type `AdjutantRunResult.output` as `{ status: AoaRunStatus }` (+ carry `proposedKeys`).
- `runController`: BEFORE the line-632 commit, if `runResult.output.status === 'succeeded' &&
  runResult.error == null` → `sealRunActions(controller run's keys)`; ELSE skip seal AND skip commit.
- **Test** (`thread-controller-action-gate.test.ts`): failed controller run → no seal, no commit
  (the controller-path P1 proof); succeeded → seal + commit.

### Task 1.6 — seal in the run-status transaction (MAJOR must-fix #4)
- **File:** `runner.ts` status write (~565). Wrap the run-status UPDATE + `sealRunActions` in one
  `db.transaction` so a crash can't leave a `completed` run with `proposed` rows.

**Pass 1 gate:** tsc clean; `thread-agent-actions`, `runner`, `thread-participation-runner`,
controller suites green on Windows; Docker integration 19/19 (unchanged — superset still drains proposed).

---

## Pass 2 — narrow to `ready`-only + GC + P1 proof

### Task 2.1 — relay narrows to `ready`-only
- SELECT: `status='ready' OR (failed-retry)`. Claim: `status IN ('ready','failed')`.
- Revive (359-371) stays `proposed` (must-fix #2 — already does; confirm, don't change to ready).

### Task 2.2 — migrate relay tests to `ready`
- Every test seeding a `proposed` row that it expects to COMMIT now seeds `ready` (or seals first):
  integration (cross-run-drain, crash-recovery, poison-cap, snapshot-suppression, FIX-F1/F2/#A/#2/#3,
  reaper, two-conn race, convene) + unit. `proposed`-stays-uncommitted tests keep `proposed`.

### Task 2.3 — P1 proof test
- Integration: seed a `proposed` row whose run is `failed`; commit → NOT committed (stays proposed).
  Seed the same as `ready` → committed. This is the regression guard for Codex's P1.

### Task 2.4 — orphan GC (MAJOR must-fixes #4/#5)
- **File:** `sweep-controller.ts` (+ a `gcOrphanedProposedActions` in `thread-agent-actions.ts`).
- For `proposed` rows: if linked run `IN ('failed','cancelled')` → blocked_policy(`run_not_sealed`).
  If linked run `running AND created_at < staleCutoff` → terminalize run→`failed` FIRST (guarded on
  still-running), THEN blocked_policy the row. If linked run `completed` but rows `proposed` past
  TTL (seal-crash window) → blocked_policy. `staleCutoff >= STALE_COMMITTING_TTL_MS`.
- **Test** (`sweep-controller.test.ts` + integration): each branch.

### Task 2.5 — Decision #102 addendum (founder signed off)
- `docs/architecture/decisions.md` #102: append an addendum — the relay drains `ready` (sealed),
  not raw `proposed`; the seal (`proposed→ready` on producing-run success) is the producer-gate
  that completes the #99 outbox the original #102 mechanism omitted. Keep the #198 intent.

**Pass 2 gate:** tsc clean; full thread/controller unit green; Docker integration green (migrated +
P1 proof). Then `pnpm -C server exec tsc` + targeted suites + Docker, commit, push, reply to Codex P1.
