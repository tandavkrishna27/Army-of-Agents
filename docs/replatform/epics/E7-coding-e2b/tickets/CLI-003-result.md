# CLI-003 Result — Logs, cancellation, usage, and result collection

**Status:** `complete (no-key core) + CI-GREEN + keyed-lane authored` — the no-key core is green in the PR gate suite at landed SHA `13f8cbaed` (verify runs the worker-daemon + sandbox-e2b-provider units; ci-required success). The real-E2B success/cancellation/forced-timeout/lost-ACK cases ride the operator-dispatched `keyed-e2b-conformance.yml`.
**Disposition:** `pass` (scope-honest: in-process/mocked evidence for the no-key core; the real-E2B rerun runs on operator key). **Third ticket of E7.**
**Date opened (UTC):** `2026-08-17`
**Epic:** `E7 — Coding/CLI workload on E2B`. **Plan task:** `CLI-003 (program-design.md:769-774)`.
**Implementer:** `Claude subagent (general-purpose) — worktree C:\e3`. **Reviewer:** `Claude adversarial-review Workflow (5 dimensions → refute-by-default verify, 24 agents) + controller re-verification + fix round`.
**Start SHA:** `bf0f03ef0` (design-doc commit).

## Acceptance model + framing

A WIRING ticket — the mechanisms existed (JOB-005 idempotent ingest, the fence gates, WRK-006 durable sink, the cancel chain, DAT-002/003 commit halves); CLI-003 added the producer + capture side, additively, without touching the frozen event schema or `SandboxProvider` port. Delivered:

- **Streaming exec seam** on `E2bTransport.runCommand` (`onStdout`/`onStderr`; real e2b SDK binding + a deterministic mock replay), so a coding run's output is capturable no-key.
- **`EventSequencer.log/.progress/.usage`** emitters consuming the FROZEN `log`/`progress`/`usage` schemas (contiguous seq + digest + canary-scrub + schema-validate).
- **Producers wired into `Supervisor.run`** around `execute`, and the **terminal event enriched** (folds `exec.signal`/`timedOut` into `errorCode`/`errorMessage`; a `usage` event precedes terminal; cancelled runs emit a durable `terminal(cancelled)`).
- **Fenced, idempotent result commit** (`patch/result-commit.ts`) — `buildWorkspacePatch` → `FenceCloseProxy.commit()` (worker gate, denies BEFORE the round-trip) → the daemon transport client's `artifactCommit`/`artifactTransferGrant` (new); idempotency keys on artifact identity, not `versionNumber`.
- **Bounded, evidentiary-only usage** (`usagePayloadV1` `.strict()` — no cost/price field; JOB-012 prices server-side).
- Four keyed real-E2B cases (success/cancel/forced-timeout/lost-ACK), SKIP-guarded.

## Findings (adversarial review — 24 agents, 18 raw → 5 defects + 3 positive verifications after refute-by-default; all fixed)

The fenced-idempotent-commit surface + client transport + CI gating came back **verified-correct**. The defects clustered in the supervisor's cancellation→terminal guarantee:

- **HIGH (acceptance-clause bypass) — the execute-error lifecycle branch emitted NO terminal event.** `supervisor.ts` execute-catch did `emitOp("execute","failed") + escalateCleanup + return` with no `events.terminal()` — the ONLY lifecycle exit without one. The common cancel/lease-loss path (cleanup tears down the sandbox → the in-flight `execute` REJECTS → catch) therefore left the attempt **non-terminal**, silently violating §2.1 (cancellation must reach terminal within policy) until the JOB-006 reaper. **Fixed:** emit a terminal (`cancelled` vs `failed`) in the catch before escalating. **Proven RED→GREEN:** a new "execute REJECTS after cancel" test goes RED without the terminal.
- **MEDIUM — no enforced/asserted time-bound governed cancel→terminal** (`cleanupDeadlineMs`/`isExpired()` was dormant; execute was never raced against a supervisor timer, only delegated to the provider). **Fixed:** generalized the proven `withCreateDeadline` into `withDeadline(op, ms)` and raced `execute` against `opDeadlineMs` — a provider that hangs now forces a `terminal(execute_timeout)` + escalate within the bound. **Fake-clock tested** (a hung execute + a fired deadline → terminal within policy).
- **LOW — the cancel test didn't exercise execute REJECTING** (it drove the resolve branch). **Fixed:** the new reject-after-cancel test covers the real HIGH path.
- **LOW — a concurrent-duplicate commit race** (check-then-act on the idempotency Map → two concurrent same-artifact commits = 2 round-trips). **Fixed:** an in-flight sentinel so concurrent commits share ONE round-trip; a `Promise.all` test asserts `roundTrips === 1`.
- **LOW — `log()` truncation could bisect a UTF-16 surrogate pair** (`slice(0, 65536)` → a lone high surrogate → the canonicalizer throws BEFORE the schema parse, dropping the log AND the run's trailing usage event). **Fixed:** a surrogate-safe `truncateUtf16Safe` for `log` + `progress`; a test truncates onto an emoji and asserts no throw.

**Verified correct (not defects):** the new `artifactCommit`/`artifactTransferGrant` client methods match the frozen descriptors + DAT-002 routes end-to-end; the new worker-daemon + sandbox-e2b-provider paths are fully CI-gated (verify + distributed-contract + always-on boundary policy).

## Commands (verbatim, re-run by the controller after the fixes)

| Command | Result |
|---|---|
| `…vitest run supervisor-producers-terminal + event-sequencer-producers + result-commit` | **20 pass** (incl. the 4 new regression tests) |
| HIGH non-vacuity: strip the execute-catch terminal | "execute REJECTS after cancel" test **RED**; restored → GREEN |
| `pnpm --filter @armyofagents/worker-daemon test:run` | **395 pass** (was 391; +4 regression) |
| `pnpm --filter @armyofagents/sandbox-e2b-provider test:run` | **29 pass + 14 keyed-skip** |
| typecheck (both packages) + `check-worker-daemon-boundary.mjs` + `check-sandbox-e2b-provider-boundary.mjs` | clean + OK |
| `node --check` keyed real-E2B cases + workflow YAML | parse OK (SKIP off `E2B_API_KEY`; `e2b` dynamically imported) |
| `git status` | worker-daemon + provider edits + tests; NO `worker-protocol` / `SandboxProvider`-port / `DE-*` edits |

## Residual risk / scope-honesty

1. **Real-E2B validation is keyed-lane-only** — success/cancel/forced-timeout/lost-ACK against a live sandbox (forced-timeout's positive-budget path is only truly exercised with the key).
2. **Live streaming population is the E4-D12 seam** — the D1 transport capture + the D3 `observeRun` producer seam (default-off) are unit-proven halves; wiring the durable sink + `observeRun` into the live poll loop + canary seeding is E4-D12.
3. **`usage`→`cost_events`/`finance_events` pricing bridge is JOB-012's** — CLI-003 emits unpriced evidence only.
4. **Leaked-sandbox reconciliation is CLI-004**; the direct presigned-upload round-trip (DAT-002 slice 7) is unproven end-to-end — CLI-003 commits an addressable patch manifest.
5. **No frozen worker-protocol event-schema or `SandboxProvider`-port edit; no `DE-*` threat edit.**

## Operator action to run the real-E2B lane

Same as CLI-001/CLI-002: add `E2B_API_KEY` to repo secrets + a template id, dispatch `keyed-e2b-conformance.yml` — it now also runs the CLI-003 real-E2B success/cancel/forced-timeout/lost-ACK cases.

## Gate recommendation

`ready for independent review` — the no-key core is green (395 worker-daemon + provider), the HIGH §2.1 fix re-proven RED→GREEN, the MEDIUM time-bound enforced + fake-clock asserted, and the real-E2B rerun runnable on operator key.

## Review attempt history

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
| 1 | Claude adversarial-review Workflow (24 agents) + controller | implementer working tree | `approved after fixes` | 18 raw → 5 defects + 3 verified-correct: HIGH execute-catch-emits-no-terminal (§2.1 bypass, fixed RED→GREEN) + MEDIUM unenforced cancel→terminal bound (fixed via `withDeadline` execute race + fake-clock test) + 3 LOW (untested reject path, concurrent-commit race, surrogate truncation); commit/client/CI verified correct; 395 worker-daemon + provider green |
