# E7-F036 — the canary run projector never stamps `finished_at` (design + plan)

**Epic:** E7 — Coding/CLI workload on E2B · **Closes:** **E7-F036** · **Plan node:** `#### CLI-006 (D5)`
**Status:** `design` — approved, buildable · **Size:** XS (one field on one patch + two tests; no
schema, no wire, no frozen-vocabulary change) · Authored 2026-09-18 against `docs/replatform-program`.

> **For agentic workers:** implement with TDD. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make a distributed (canary-projected) run **durably terminal** — `status ∈ TERMINAL` **AND**
`finished_at` set — so evidence-verifier A's clause 3 passes and the run carries an honest completion
time for duration/analytics. Today the projector writes the terminal *status* but not `finished_at`,
so a fully-successful distributed E2B run lands `status=succeeded, finished_at=NULL`.

---

## 1. Background — proven live, one field short

The E7-1 canary now runs the full networked journey end to end (E7-F011 landed the last wire hop):
dispatch → distributed owner → lease → `attempt_started` → E2B create → **`stage_files`** → execute →
terminal event → attempt-terminal projection receipt `applied`. Run `0518bbc7-…` reached
`status=succeeded` with every clause-5 corroboration present (`leases=1`, `attempt_started=1`,
`terminal_events=1`, `terminal_receipt_applied=true`).

`pnpm verify:e7-1-distributed-run` still returns **FAIL (mechanism)** on exactly one clause:

```
clause 3: not durably terminal (status=succeeded, finished_at=null)
```

Clause 3's predicate (`e7-distributed-run-verifier.ts:531`) is
`isTerminalRunStatus(status) && finishedAt !== null`. The status is terminal; `finished_at` is null.
This gap was previously **unreachable** — no distributed run had ever reached a terminal status before
E7-F011; the two prior canary runs died at `stage_input`.

## 2. Root cause — the one terminal writer that omits the field

`setRunStatus` (`heartbeat.ts:1882`) is the single shared run-status writer. It does
`.set({ status, ...patch, updatedAt })` and **does not derive `finished_at`** — every caller passes it
explicitly. Grep confirms every legacy terminal caller does: reap (`:2521`), normal completion
(`:5791`), failure (`:6042`), cancel (`:7400`, `:7455`, `:7509`), watchdog (`:2797`, `:2860`, `:3081`).

The distributed path's terminal writer is `createCanaryRunProjector.projectTerminal`
(`canary-run-projector.ts:188`). Its patch is `{ error, usageJson }` — **no `finishedAt`**. The wiring
closure (`heartbeat.ts:7175`) forwards the projector's patch to `setRunStatus` verbatim. So the projector
is the ONE terminal `setRunStatus` caller that never stamps `finished_at`, and a successfully projected
distributed run is left non-durably-terminal.

No existing test caught it: `cli-006-canary-run-projector.test.ts:117` asserts `setRunStatus` was called
with `(RUN, status, expect.anything())` — the patch shape is unpinned.

## 3. Design

The projector is a PURE module over `deps`; it has no clock. Its input evidence is built by the pure
`foldAttemptEvidence` (`canary-terminal-projection.ts:166`), which already receives `now` and computes
the wall-clock duration against it. Carry `finished_at` on the evidence, computed there, and include it
in the projector's terminal patch. No new dependency, no new authority — the terminal still flows through
the one shared `setRunStatus` latch (Invariant 8 preserved).

### 3.1 `packages`/server — `canary-run-projector.ts`
- Add `readonly finishedAt: Date;` to `CanaryAttemptEvidence`.
- In `projectTerminal`, add `finishedAt: evidence.finishedAt` to the `setRunStatus` patch (alongside
  `error`/`usageJson`).

### 3.2 `canary-terminal-projection.ts`
- In `foldAttemptEvidence`, return `finishedAt: input.now`.
  - **`now`, not the terminal row's `occurredAt`, deliberately:** the run's wall-clock `durationMs`
    already uses `input.now` as the finish reference (`:227`), and the legacy path stamps `new Date()` at
    finalization. Using `now` keeps `finished_at − started_at` consistent with the reported duration; the
    after-commit hook fires within ms of the terminal, so `now` is that instant.

### 3.3 Why not stamp it inside `setRunStatus`
`setRunStatus` is terminal-agnostic and shared; auto-deriving `finished_at` there would silently rewrite
the field for every caller (each of which already passes its own, sometimes deliberately different, value
— e.g. the reap path's `now`). The convention in this file is caller-supplied `finished_at`; the fix
restores the projector to that convention rather than changing the shared writer.

## 4. Non-goals
- No change to clause 6 / capability (`producedArtifacts` stays structurally 0 — CLI-008 Unit F).
- No change to the frozen worker-protocol vocabulary, the wire, or any schema.
- `errorCode` on the run patch is out of scope (the projector already carries `terminalErrorCode` inside
  `usageJson`; clause 3 does not read it).

## 5. Implementation plan (TDD)
- [ ] **Task 1 — fold stamps `finished_at`.** Failing unit in `cli-006-projector-wiring.test.ts`:
  `fold().finishedAt` equals `NOW`. Then add `finishedAt: input.now` to `foldAttemptEvidence`'s return
  and `readonly finishedAt: Date` to `CanaryAttemptEvidence`.
- [ ] **Task 2 — projector puts it on the terminal patch.** Failing unit in
  `cli-006-canary-run-projector.test.ts`: `setRunStatus` is called with a patch
  `expect.objectContaining({ finishedAt: <evidence.finishedAt> })`. Update the `evidence()` helper to
  carry `finishedAt`. Then add `finishedAt: evidence.finishedAt` to the patch.
- [ ] **Task 3 — guards.** `check-frozen-worker-protocol-v1` (untouched), `check-worker-daemon-boundary`
  (no new import), test-inventory. No threat-register citation touches these files (verified).

## 6. Acceptance criteria
- A distributed run projected terminal writes `finished_at`; `pnpm verify:e7-1-distributed-run <runId>`
  passes clause 3 and returns **PASS (mechanism)** / exit 0 (capability remains a separate, off-by-default
  dimension).
- Legacy completion/cancel/reap paths are unchanged (they already pass `finished_at`).
- Frozen-protocol and worker-daemon-boundary guards green.
