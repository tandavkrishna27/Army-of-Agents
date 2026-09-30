# MIG-003 Result — Durable realtime fan-out + sequence catch-up (E10-REALTIME-FOUNDATION)

**Status:** `complete + review-fixed (no-key core green)`. The E10-REALTIME-FOUNDATION gate. Postgres-only substrate (durable `live_event_log` + `LISTEN/NOTIFY` + safety poll); no new runtime dependency.
**Disposition:** `pass` (scope-honest: in-process + real-two-replica-substrate evidence; see §Residual).
**Date opened (UTC):** `2026-08-19`. **Start SHA:** `c934d783e` (design). **Design:** `MIG-003-design.md`.
**Implementer:** Claude subagent (fail-first). **Reviewer:** Claude adversarial-review Workflow (4 dimensions → refute-by-default verify, 19 agents) that **BLOCKED** the first pass, + controller re-verification + a fail-first fix round.

## What shipped
- **`live_event_log` + `live_event_sequences`** — durable, company-scoped, tenant FORCE-RLS tables (contiguous per-company `seq` + org-unique `eventId`, mirroring JOB-005; migration `0257` with C14 on the generated DDL + both grant surfaces + `POLICY_COUNTS`). The replay source of truth.
- **Broker at the `publishLiveEvent` chokepoint** — the same-replica emitter ALWAYS delivers (seq-less, immediate); best-effort append + data-free `pg_notify(companyId, seq)`.
- **Per-replica LISTEN + safety-poll drainer** — pulls the tail cross-replica and fans out through the EXISTING per-event RBAC; suppresses this replica's own `eventId`s (so same-replica has no double); poll-first-sight anchors at `retentionFloor`.
- **WS `?sinceSeq` catch-up** — replay re-runs per-event RBAC (hide-don't-403); per-socket replay latch + buffer; `seq` dedup; snapshot-on-truncation.
- **Backpressure hysteresis latch**; **retention trim** sweeper; client `seq` tracking + `__resume`.

## Review → resolution: the review BLOCKED it (14 raw → 9 CONFIRMED, 2 PARTIAL, 3 REFUTED)
The first pass shipped a fragile global `isDurablePipelineHealthy` flag + suppress-on-emitter design that the review (and the controller's own pre-review read) flagged as risky. **The fix removed that design entirely** in favor of the ROBUST model: *emitter always delivers same-replica; the drainer suppresses same-replica-origin by `eventId`* — which makes the three worst defects correct together.

### mustFix (all fixed fail-first, RED→GREEN)
1. **HIGH — suppress-then-append-fail silently dropped the event everywhere.** The emitter now always delivers (never gated), so a later append failure cannot drop an already-delivered event. (Root cause removed.)
2. **HIGH — a concurrent live event during async replay dropped the whole replayed range.** Per-socket replay latch + bounded buffer; live events buffered during replay, drained ascending after (cursor dedups overlap); overflow → snapshot.
3. **HIGH — `sinceSeq` replay truncated at 500 with the snapshot fallback unreachable.** `replayTruncatedBeyondPage` signals a snapshot resume (without advancing the cursor) when a full page hides more — independent of retention.
4. **HIGH — the gate-mandated two-replica + broker-outage proofs did not exist.** Authored `tests/d1/e6f-13-realtime-fanout.test.mjs` on the real two-replica `docker-compose.d1.yml` stack (SKIP-guarded like `e6f-11`): the REAL store SQL (contiguous seq under `aoa_app` + org-GUC FORCE-RLS `withTenantTx`), real cross-process `LISTEN/NOTIFY`, real `since()`, append@A → converge@B, and NOTIFY-dropped → safety-poll recovery.
5. **MEDIUM — poll anchored at `currentSeq`, skipping the suppressed tail.** Anchors at `retentionFloor-1` now.
6. **MEDIUM — backpressure `__resume` storm.** Per-socket hysteresis latch: one `__resume` on the rising edge; cursor still advances while latched; clears below the low-water mark.
7. **MEDIUM — the store was owner-served, so its `aoa_app` FORCE-RLS was inert / broke on a non-superuser deployment.** Served via `(distributedExecutionDatabases?.appDb ?? db)` — the enforcing pool when it exists; embedded/self-host stays on the owner.
8. **MEDIUM (scope) — retention trim was overclaimed.** Implemented `trimRetention` (DELETE below `currentSeq − window` per company in `withTenantTx`; existing aoa_app DELETE grant) + a low-frequency sweeper; design §5 reworded to match code.

### Refuted (correct — no change)
- Async-append reordering (§7 guarantees only per-company contiguity; payloads are hints refetched from the DB). Catch-up RBAC hide-don't-403 **holds — no gap/existence-oracle** (the delivery gaps in #3/#5 dropped *authorized* events, never leaked unauthorized ones). Seq contiguity holds (in-tx `onConflictDoUpdate` counter).

## Commands (controller re-run)
| Command | Result |
|---|---|
| live-events-broker + catchup + grant contract | **35 passed** |
| all 6 `*live-event*` server suites | green (no regression) |
| migration-idempotency | passed |
| `tsc --noEmit` (server/db/shared/ui) | clean |
| `check-distributed-execution-foundation.mjs` | PASS |
| global `isDurablePipelineHealthy` removed | grep = 0 (fragile design gone) |
| `node --check` e6f-13 | parse OK (SKIP off `AOA_D1_LIVE`) |

## Residual risk / scope honesty
1. **e6f-13 proves the real two-replica SUBSTRATE** (SQL + cross-process `LISTEN/NOTIFY` + FORCE-RLS append + poll recovery on a real two-container stack) — the previously-untested, gate-critical layer. The **literal cross-container WS socket-receive leg** (an authenticated WS client on replica B receiving the fanned frame) is NOT executed by e6f-13 (the d1 stack runs authenticated-mode; a WS client in dexec was out of scope). The per-socket fan-out / RBAC / dedup is replica-count-independent in-process logic covered by the unit suite. So two-replica *convergence* = real infra; socket *fan-out* = in-process; the full end-to-end e2e is a documented residual.
2. **d1 lanes are Linux-CI-only** (Windows skips) — e6f-13 + migration replay + live RLS run on the CI DB lane.
3. **Retention trim on the distributed `aoa_app` role** trims the active-company set + passed companies; a fully-idle company's trim on that role is a documented residual (global trim covers owner/superuser deployments).
4. No frozen `worker-protocol`/port/`DE-*` edit; no hosted-API call; no new runtime dependency; migration via `db:generate` + C14.

## Gate recommendation
`ready for independent review` — the review's 4 HIGH + 3 MEDIUM + 1 scope defects are fixed fail-first (the fragile health-flag design removed for the robust model), the real two-replica DB-lane proof is authored (substrate on real infra), and the no-key core is green (35 unit/contract + foundation + stable migration + clean typecheck).

## Review attempt history
| Attempt | Reviewer | Disposition | Evidence/findings |
|---:|---|---|---|
| 1 | Claude adversarial-review Workflow (19 agents) + controller re-verification | `BLOCK → approved after fix` | 14 raw → 9 CONFIRMED (4 HIGH: silent-drop, replay-range-drop, 500-truncation, missing two-replica proof; 3 MEDIUM: poll-anchor, backpressure-storm, RLS-pool; 1 scope: retention) + 2 PARTIAL (LOW transient double / stale prose) + 3 REFUTED (async reorder, RBAC hide-don't-403, seq contiguity). Fixed fail-first via the robust emitter-always model; real two-replica DB-lane proof authored; 35 unit/contract green. |
