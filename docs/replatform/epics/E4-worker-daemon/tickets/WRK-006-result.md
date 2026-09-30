# WRK-006 Result — Durable, encrypted event outbox + `event_upload` wiring

**Status:** `complete` (implemented + distinct adversarial review; 3 confirmed defects fixed + fail-first-proven; full acceptance matrix re-green)
**Disposition:** `accepted` (2 confirmed drain defects — 1 HIGH poison-stranding, 1 MEDIUM shutdown-flush — + 1 LOW hardening, all fixed with regression tests; 3 findings refuted)
**Date (UTC):** `2026-08-14`
**Epic:** `E4-worker-daemon`
**Design:** `tickets/WRK-006-design.md` (committed `bfa299bf7` — the reviewable design-first artifact).
**Start SHA:** `bfa299bf7` (WRK-006 design commit, atop WRK-005 `eabfc3c72`).
**Upstreams (verified):** WRK-004 (event sink + sequencer + frozen event schemas), WRK-005 (`eabfc3c72`, the fence-close proxy is a `network_denied` producer), **JOB-005 (`pass`) — the server-side idempotent event/terminal ingestion this outbox uploads into**. Frozen worker-protocol v1 source SHA `b7a842870ce7509d8baa75409e0ab19da375c88a`.

## Outcome

WRK-006 replaces the inert `WorkerEventSink` seam with a durable, encrypted event outbox that persists
stamped `WorkerEventV1` events VERBATIM and uploads them in strict `seq` order through a NEW
`ControlPlaneClient.eventUpload` method, advancing a durable cumulative `acceptedThroughSeq` cursor. It
is a **pure consumer of the already-frozen `event_upload` wire op** — zero `packages/worker-protocol/`
changes. Additive + inert-until-wired (E4-D12), mirroring the WRK-005 renewal seam.

## Deliverables

**New runtime modules** (`packages/worker-daemon/src/events/`):
- `event-row-codec.ts` — per-row `aes-256-gcm` (the daemon's first symmetric cipher): per-row random salt→HKDF DEK (so each row keys distinctly — no GCM IV reuse), fresh 12-byte IV, tag verified in `final()`, fail-closed opaque `RowDecryptError`.
- `event-outbox-kek.ts` — KEK custody: `MountedSecretKekStore` (0600, fail-closed, Windows-ACL-aware, never regenerates over a corrupt key) + deterministic `deriveKekFromDeviceKey` (stable across restart) + `StaticKek`.
- `event-outbox-store.ts` — `DurableEventStore` port + `SqliteEventOutboxStore` (`node:sqlite`, `synchronous=FULL` fsync-durable, `UNIQUE(stream_key,seq)` D2 backstop, parameterized SQL, backpressure caps → `OutboxFullError`).
- `durable-event-sink.ts` — `DurableWorkerEventSink`: serialize event verbatim → seal → fsync-append before `emit()` returns; `seq`/`eventDigest` copied, never recomputed.
- `event-upload.ts` — `uploadEventBatchOnce` + `classifyEventUploadResponse`, modeled 1:1 on `renewLeaseOnce`/`classifyRenewResponse` over the frozen request/response schemas.
- `event-outbox-drain.ts` — the seq-ordered drain loop: cumulative-cursor advance, gap resend, hash_mismatch/stale_fence/target_revoked/terminal stop, per-stream 401 cap, persisted capped-jitter backoff, crash recovery, poison-row quarantine.
- `sqlite-experimental-warning.ts` — narrow, idempotent filter (drops only the SQLite `ExperimentalWarning`, delegates all others).

**Modified runtime:** `transport/client.ts` (`EVENT_UPLOAD_PATH` + `eventUpload` + `postOperation` union widen + `eventUploadTimeoutMs`), `lifecycle/shutdown.ts` (`EventOutboxLifecycle` + `createEventOutboxShutdownSteps`), `bin/worker-daemon.ts` (inert optional `eventOutbox?` shutdown seam), `index.ts` (barrel).

**Test-only:** `__tests__/support/fake-control-plane.ts` (`event_upload` route + directives) + `support/event-fixtures.ts`; **9 hermetic suites** (codec, store, kek, durable-sink, upload-client, upload-classify, drain.component, recovery.component, shutdown).

## Distinct adversarial review (5 finders → refute-by-default verifiers)

6 findings; **3 CONFIRMED** (all fixed + fail-first-proven), **3 refuted**. The crypto and upload-classify
dimensions returned zero findings; my own independent read of all 7 modules agreed.

**CONFIRMED + FIXED:**

1. **HIGH — poison-row mid-batch strands post-poison events on non-`accepted` prefix responses.**
   `assembleBatch` durably quarantines the first undecryptable row and sets an in-memory `poisonAfter`
   flag, but the stream was stopped-at-poison ONLY on the `accepted` upload branch. On `gap`/`transient`/
   `401-recovered`, the flag is dropped on requeue; since the quarantined row is excluded from
   `peekContiguous`, it becomes a permanent contiguity gap and the stream lingers `stopped=0` with
   post-poison events (including terminal-class) stranded forever, no `stop_reason` — a silent zombie,
   violating design §5/§8. **Fix:** durable-state gap detection — when `peekContiguous` returns empty, if
   `firstUnackedSeq(stream) > acceptedThroughSeq + 1` (the next expected seq is absent because it was
   quarantined; emission is contiguous+durable so no other cause exists) the stream is stopped
   `corrupt_row`. Fires regardless of how the prefix upload resolved; a merely backed-off head
   (`head === cursor+1`) is not a gap → waits. Added `DurableEventStore.firstUnackedSeq`. **Regression:**
   `event-outbox-recovery.component.test.ts` "corrupt-row is fail-closed even when the prefix upload is
   … transient" — poison + transient prefix → stream ends `stopped/corrupt_row`, not re-listed. Fail-first:
   against the reverted bare `return`, the stream is a silent zombie (`stopped=false`), while the existing
   poison-then-`accepted` test stays green.

2. **MEDIUM — graceful-shutdown final flush is a no-op.** `stop()` latches `stopped`, which
   `drainOnce()`/`drainStream()` short-circuit on; `flush()` was `drainOnce()`. The shutdown order is
   `stop → flush → close`, so the documented "final flush attempt" processed zero streams (durability
   held via fsync-on-emit + boot recovery, but a decommissioned ephemeral sandbox would never deliver the
   last events). The mock-based shutdown test only asserted step ordering. **Fix:** thread a `final` flag —
   `flush()` calls `drainOnce(true)`, which bypasses the cooperative-cancel guard (`if (stopped && !final)`)
   so the final pass runs to completion; `tick()` stays `final=false` (respects `stopped`). **Regression:**
   `event-outbox-drain.component.test.ts` "graceful-shutdown flush() delivers pending events EVEN AFTER
   stop()". Fail-first: against `drainOnce()`, the flush uploads nothing (`acceptedThroughSeq` stays 0).

3. **LOW — `SqliteEventOutboxStore` constructor leaked the open handle + file lock** if a post-open
   PRAGMA/schema step threw (a leaked lock can wedge the outbox across restarts). **Fix:** close-then-rethrow
   around the PRAGMA/schema/harden block. (Verifier refuted as "not load-bearing"; fixed anyway as a cheap
   correct hardening.)

**REFUTED (no code change):**
- Fake `event_upload` route is more lenient than real JOB-005 (omits the batch-identity auth check +
  replay-region integrity). The sub-claims are TRUE but the drain never produces the violating cases (it
  stamps identity from the stream's own event fields and resends byte-verbatim), so no live drain bug is
  masked. Recorded as a residual test-fidelity gap (§ Residual risks), not a defect in shipped code.
- The shutdown-flush finding raised a second time from the boundary-lifecycle dimension (dup of #2).
- The constructor-leak severity (kept the fix; downgraded rationale accepted).

## Verification-surface results (windows-local from `C:\e3`; Linux CI = DEC-03 authority)

Re-run in full AFTER the 3 fixes (+2 regression cases):

| Lane | Result |
|---|---|
| Full worker-daemon suite | PASS — **73 files, 270/270** (baseline 64/216; WRK-006 adds +9 files / +54 tests, incl. the 2 review-regression cases) |
| Fail-first proof (both drain fixes) | PASS — each regression FAILS against the reverted pre-fix code (poison→silent zombie; flush→no-op) and PASSES against the fix; sibling tests stay green |
| `pnpm check:worker-daemon-boundary` | PASS (`node:sqlite`/`node:crypto`/`node:fs` only; no npm driver; no `require`) |
| `pnpm check:frozen-worker-protocol-v1 -- --source-sha b7a842870…` | OK — **zero** `packages/worker-protocol/` source changes |
| `pnpm --filter @armyofagents/worker-daemon typecheck` (prod graph) | exit 0 (build tsconfig excludes `src/__tests__`; new production modules are strictly type-clean; residual fixture branded-string looseness is the pre-existing CI-excluded test-tier convention) |
| `npx tsc -p …/tsconfig.json --listFilesOnly` | **0** paths under `src/__tests__` |
| `pnpm --filter @armyofagents/worker-daemon build` | exit 0; **0** test artifacts in `dist`; all 7 events modules emitted |
| `pnpm check:distributed-foundation` (keystone) | PASS — no grant/policy/DDL drift |
| `pnpm install --frozen-lockfile` | PASS — runtime deps stay exactly `@armyofagents/worker-protocol` + `pino` |

## Decisions (from the design, as-built)

- **D1 store = `node:sqlite`** behind `DurableEventStore` (file-log fallback documented, not built). Warning suppressed via a narrow persistent filter installed before a **dynamic** `import("node:sqlite")` (a static value import links the builtin before the filter runs; the async factory `openEventOutboxStore` is the ordering fix). `DatabaseSync` type kept via erased `import type`.
- **D3 crypto** = per-row aes-256-gcm, HKDF DEK per random salt, KEK from device key / mounted secret, `0600` custody.
- **D2** = `UNIQUE(stream_key,seq)` fail-closed backstop + the new durable-gap stop; producer unification flagged to E4-D12.
- **D4** = backpressure fails `emit()` closed (`OutboxFullError`), never drops terminal-class events.
- **D6** = fresh idempotency key per flush, same key on transient retry, not persisted across restart (server dedups by cumulative `seq`).
- **D7** = zero worker-protocol changes.
- **No metrics** added (would edit the closed `metrics.ts` label sets + risk the metrics contract test); observability via the injected logger. Flagged for follow-up if an `event_upload{outcome}` metric is wanted.

## Non-goals

Live E5/DAT producers for the other 16 event kinds; WRK-007 restart/orphan reconciliation against server
truth; rewiring the inert composition root / E4-D12 live dispatch (incl. the D2 producer unification and
the `EventOutboxLifecycle`↔`EventOutboxDrain` adapter); any worker-protocol change; blob-by-reference
large payloads. WRK-006 is additive and inert-until-wired.

## Residual risks

- **`node:sqlite` experimental (D1):** binding-API churn across Node minors; mitigated by the
  `DurableEventStore` seam (file-log fallback) + Node-24-pinned CI/runtime. The effective Node-24 floor
  should be recorded (root `engines.node` currently `>=20.3`).
- **D2 producer unification (E4-D12):** the `UNIQUE(stream_key,seq)` backstop makes a two-sequencer
  collision loud/tested, but a wired-live daemon would hit `SeqCollisionError` until the supervisor +
  fence-close proxy share one `EventSequencer` per lease/attempt.
- **`EventOutboxLifecycle` adapter (E4-D12):** the shutdown interface is satisfied only by the test mock
  today; the real drain now supports post-stop flush (fixed), but the concrete `stopDrain→stop`,
  `flush→flush`, `closeStore→store.close` adapter is E4-D12's to wire.
- **Fake-route fidelity:** the `event_upload` fake omits the server's batch-identity auth + replay-region
  integrity checks; faithful for what the drain produces, but not a strict acceptance gate for a future
  identity-stamping / seq-integrity regression. Hardening the fake is a cheap follow-up.
- **D4 backpressure policy** ships fail-closed by default; the block-vs-fail-run choice is owed a
  product/eng confirmation before live dispatch.
