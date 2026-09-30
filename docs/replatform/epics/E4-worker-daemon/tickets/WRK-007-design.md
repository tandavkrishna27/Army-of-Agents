# WRK-007 Design — Restart recovery and orphan cleanup

**Status:** `design` (reviewable artifact; implementation follows via per-slice TDD + distinct adversarial review)
**Epic:** `E4-worker-daemon` (the LAST E4 ticket)
**Authoritative source:** `docs/replatform/program-design.md:615-620`.
**Depends on (all verified `pass`/complete):** WRK-004 (`supervisor/reconcile.ts` + `cleanup-authority.ts` + provider/fake-provider), WRK-006 (`d0954f8fc`, durable outbox), JOB-006 (`pass`, server-side cancellation/expiry/retry/reconciliation), WRK-005 (`lease/quarantine.ts`). Frozen worker-protocol v1 source SHA `b7a842870ce7509d8baa75409e0ab19da375c88a`.
**Grounded by:** the WRK-007 terrain-map (5 readers + synthesis); every load-bearing claim below re-verified against source.

---

## 1. Scope + one-line framing

**Outcome (program-design.md):** on startup, reconcile local sandboxes + outbox rows with control-plane lease state — resume live-owned work only when policy permits, kill stale sandboxes, quarantine unknown artifacts; cleanup is observable and retryable. **Tested against the FAKE provider + fake control-plane** ("crash at each lifecycle checkpoint").

WRK-007 adds a **one-shot startup reconciliation pass** that classifies every locally-known sandbox and outbox stream against control-plane lease authority and drives the correct cleanup, extending WRK-004's `reconcile.ts` from "leaked-resource sweep against the in-process fake" to "startup reconciliation against inferred control-plane authority." It is **worker-daemon-only, fake-tested, inert-until-wired (E4-D12), and makes ZERO worker-protocol changes** (E4-D02).

**Critical framing (JOB-006):** the server `reapExpiredLeases` reaper permanently revokes any expired lease the worker forgets — **orphan safety does not depend on the worker.** WRK-007 is a **cleanliness / fast-path convergence pass**, not a correctness-critical one. That bounds its risk and shapes every conservative default below.

---

## 2. GAP-1 — There is NO control-plane lease-state query op (the defining constraint)

The frozen protocol exposes exactly ten ops (`transport.ts:757-767`): `enrollment, poll, lease_ack, lease_renew, event_upload, artifact_transfer_grant, artifact_commit, quarantine_grant, quarantine_finalize, control_command`. **No `list_leases` / `lease_state` / `reconcile`.** `poll` returns `offer|no_work|drain`, never a restatement of owned leases; `ControlPlaneClient` has no state method. Adding one is forbidden (E4-D02 frozen surface).

**Therefore authority is INFERRED per-lease.** The restarting worker:
1. **Enumerates candidate leases from its OWN durable local state** — WRK-006 outbox stream keys embed `leaseId`+`fenceToken` (`events/event-outbox-store.ts:34-42`), and WRK-004 provider sandbox `ResourceLabels` carry `leaseId`+`deviceGeneration` (`supervisor/provider.ts:72-80`). The worker is never told what it owns.
2. **Probes each via `lease_renew`** and classifies the response, reusing `renewLeaseOnce` + `classifyRenewResponse` (`lease/lease-renewal.ts:152-220`): `renewed` (live/owned) vs `rejected`/`terminal{stale_fence|target_revoked}`/`attempt_terminal` (dead). `event_upload` is a second liveness signal per stream.
3. Offline/partition → probe unreachable → **fail closed** (no governed resume; leave to the server reaper).

This replaces `reconcile.ts`'s trust of the LOCAL `hasLiveLease` boolean (`reconcile.ts:53` `defaultIsOrphan = !summary.hasLiveLease`) with a **control-plane-derived** `isOrphan` via the already-present injectable seam (`reconcile.ts:33`, verified).

---

## 3. The startup reconcile algorithm

**Inputs.** (A) Local sandbox inventory — `provider.list(OwnershipSelector{org,target,worker})` → `ResourceSummary{sandboxId, resourceLabels(7-tuple), generation, state, hasLiveLease}` (`provider.ts:190-204`). (B) Outbox streams — `listActiveStreams()` (non-stopped, ≥1 unacked row; each cursor carries `identity.leaseId/fenceToken`, `event-outbox-store.ts:394-404`). (C) Control-plane lease authority — the per-lease `lease_renew` verdict (§2).

**Ordering (invariant, D8):**
1. Open the outbox store; `drain.recover()` → `recoverStalledUploading()` (uploading→pending, **no attempts bump**).
2. Establish the live-owned lease set (probe each locally-referenced lease).
3. **Reconcile outbox streams** (drain-to-convergence for owned; eager `stopStream` for dead) — BEFORE sandbox kill, so terminal events land before their sandbox is destroyed.
4. **Reconcile sandboxes** (three-way classification + teardown).
5. **Quarantine sweep** for staged output artifacts under dead fences.
6. **Only then** `drain.start()` begins ticking (live wiring; inert today).

A poison outbox row (WRK-006 durable-gap stop) MUST NOT block the sandbox pass (D8).

**Sandbox three-way classification** (extends today's binary orphan/keep):
- **keep / resume-eligible** — probe `renewed` + matching `deviceGeneration` + attempt non-terminal + `hasLiveLease`. `reconcile()` skips it (`reconcile.ts:71`). *Actual* re-attach is gated by §4 (default: never).
- **kill-stale** — probe dead, or full labels/`generation` mismatch the current lease, or `hasLiveLease=false` → teardown (§5).
- **unknown_sandbox** (new bucket, D4) — matches the coarse selector but the full labels/generation can't resolve to a known live lease; the existence-oracle (`cleanup-authority.ts:60-70`) forbids probing the authority to distinguish "not mine" from "gone." Recorded as an observable outcome; **not killed** (conservative default), left to the server reaper.

**Outbox-stream classification** — cross-reference each cursor's `identity.leaseId/fenceToken` against the probe set:
- **owned lease → resume-drain** — `recover()` + start the drain; `acceptedThroughSeq` is durable dedup (server dedups by seq).
- **dead lease → eager `stopStream(streamKey, reason)`** rather than waiting for the drain's lazy `stale_fence` self-stop — events under a dead fence can never be accepted (D7: streams are ABANDONED via `stopStream`, never quarantined; quarantine is for artifacts only).

Aggregate a `StartupReconcileResult` across sandbox + stream (stopped count) + quarantine outcomes, extending `ReconcileResult`/`ReconcileOutcomeRecord` (`reconcile.ts:39-50`).

---

## 4. Resume policy (D2) — "resume live-owned work only when policy permits"

Not a single flag: it is the intersection of the server `isActiveFence` gate (the real authority), the invariant that a stale/replaced lease cannot perform new governed effects, the rule that provider create/execute/**resume** is a governed effect needing live revalidation immediately before forwarding (fail closed if unavailable), and CAV-003 (restart ALWAYS mints a new attempt/fence; JOB-006 never revives an expired fence).

**Decision (conservative default — CORE ships this): NEVER re-attach to in-flight execution.** On boot, for every surviving sandbox: probe `lease_renew`; **regardless of `renewed`, do NOT re-attach to a running/partial `execute`.** Treat the sandbox as terminal-for-this-worker — drain its buffered outbox events (WRK-006 replay), kill it via the cleanup authority, and let JOB-006 mint a fresh fenced attempt N+1. Output not committed under a live fence → quarantine. Rationale: replaying a partial `execute` without checkpoint/restore risks duplicate side-effects — the exact hazard the JOB-006 winner rule bounds; CAV-001 forbids relying on one uninterrupted process.

**Narrow permitted-resume seam (provided, unimplemented — deferred to a real provider E6/E7):** true resume allowed ONLY at the intersection of (i) `renewed` at the SAME `deviceGeneration`, (ii) attempt non-terminal, (iii) provider advertises `checkpoint`/`restore` + a valid checkpoint exists, (iv) `offlinePolicy = continue_until_lease_expiry`. Absent any → the never-resume default. WRK-007-CORE ships the default against the fake and merely exposes the seam, so the fake-provider version is shippable now.

---

## 5. Kill / quarantine / observability / retry (acceptance-clause mapping)

- **Stale sandboxes KILLED.** Enumeration = `reconcile()` (list by selector, apply the control-plane `isOrphan`). **Teardown decision (D3, verified divergence):** `reconcile.ts:73` today calls `provider.reconcileCleanup` **directly, not** `CleanupAuthority`. **Design:** route still-live-process stale sandboxes through `CleanupAuthority.converge(sandboxIds, makeCtx, maxDestroyAttempts=3)` — the distinct monotonic redacted authority that survives lease loss and escalates cancel→kill→forced-destroy (`cleanup-authority.ts:257-309`); the fake models `ignoreCancel`/`ignoreKill` so a bare `destroy` on a live tree is ignored and escalation is required. Keep `reconcile()` as the enumeration/outcome shell; empty-tree/terminal sandboxes may use the direct idempotent `reconcileCleanup`. `ResourceNotAvailableError` mid-converge = "already gone" success.
- **Unknown ARTIFACTS QUARANTINED.** Reuse WRK-005 `lease/quarantine.ts` `runOrphanQuarantine` with `reason = classifyOrphanOutput({unknownArtifact:true}) → "unknown_artifact"`. Authenticated by `targetId + deviceGeneration` (device session, NOT a live lease) → survives lease loss; distinct `quarantine/…` prefix; ≤5-min non-promotable grant (CAV-004, no apply/promote/select field); returns `quarantined|rejected|dropped|failed`, never throws; terminal session → `dropped` + redacted log (F007). One grant+finalize round-trip per artifact (enumerate + loop). **Scope (D5):** staged *output* artifacts (artifactId/sha/size/objectSuffix) whose fence is dead — NOT arbitrary workspace file-tree scanning (that is DAT-006). CORE quarantines only artifacts enumerable from durable worker state / test-injected candidates; the full enumeration source is a gap — wire the mechanism + seam, defer full enumeration.
- **Cleanup OBSERVABLE.** Extend `ReconcileOutcomeRecord`/`ReconcileResult` + metrics (`RECONCILE_ORPHANS_METRIC`, `CLEANUP_OUTCOME_METRIC`, add `cleanup_escalation{stage}`). **Hashed-labels-only** logging; `CleanupAuthority` returns only `RedactedResourceProjection{sandboxId, resourceLabelsHash, generation, state, providerOpId}` — never command/env/logs/secrets/bytes.
- **Cleanup RETRYABLE.** `reconcileCleanup`/`destroy` return a status, never throw — a failed cleanup is counted + left durable-retryable. Convergent by construction (destroyed rows drop out of `list`; `recoverStalledUploading` idempotent; `stopStream` one-way; quarantine idempotent per distinct prefix). "Crash then re-run reconciliation converges without double-kill" is the core testable property.

---

## 6. Lifecycle hook + inertness (GAP-3)

`bootstrapWorkerDaemon` (`bin/worker-daemon.ts:86-140`) is linear — logger → fail-closed config → metrics → `startHealth` → compose **shutdown** steps → register signals → return; it starts NO loops. The three optional lifecycles (`leasing`/`renewal`/`eventOutbox`) are shutdown-only + inert. **There is no `createStartupHandler`.**

**WRK-007 adds the startup seam:** an optional `reconciler?: StartupReconciler` on `BootstrapDeps` + a small `createStartupSteps(...)` runner mirroring `createShutdownHandler`, invoked ONCE between `startHealth` and signal registration, gated on presence (undefined → empty step list, exactly how `leaseSteps`/`outboxSteps` degrade to `[]`). Absent (current default) → nothing runs; present (future live wiring) → runs once; rollback = omit. Precedent shape: `EventOutboxDrain.recover()` — a one-shot boot pass, not a loop.

**Gates preserved:** E4-D01 boundary (`@armyofagents/worker-protocol` + `pino` + `node:*` only), E4-D02 frozen protocol (zero worker-protocol changes; reuses `lease_renew`/`event_upload`/`quarantine_*`), E4-D09 no worker DB/migration, in-process fakes only, 0 dist test doubles.

---

## 7. Crash-at-checkpoint test matrix (fake provider + fake control-plane)

| # | Checkpoint | Correct reconciliation on boot |
|---|---|---|
| 1 | Mid-create, response lost (`createGate`) | `list` by ownership; no live-lease backing → idempotent destroy (lost-response replay, stable idem key). `createGate` models the E2B leak (listable only when create RESOLVES). |
| 2 | Post-create, pre-execute (`running`, no output) | Probe. Live → default kill + JOB-006 retry. Dead → kill, no quarantine (no bytes). |
| 3 | Mid-execute, partial output (`executeGate`) | Default: do NOT re-attach; drain outbox; kill; quarantine staged output under dead fence. Never double-run. |
| 4 | Post-execute, pre-cleanup (terminal event unacked) | Replay outbox (server dedups by seq); destroy sandbox; dead fence → output quarantine, stale terminal event rejected. |
| 5 | Mid-outbox-upload, ACK lost (`uploading` rows) | `recover` uploading→pending (no attempts bump); resume at `acceptedThroughSeq+1`; at-least-once → server dedups. Drain interleaved with sandbox pass so terminal events land. |
| 6 | Mid-cleanup, response lost (`destroyFailures`) | Idempotent: `list` again; gone → skip; present → destroy; `failed` → durable-retryable next pass. |
| 7 | Fence flip during downtime (server minted attempt N+1) | Probe → `stale_fence`/`target_revoked` → kill; buffered output → quarantine (device-session survives lease loss). **Requires the per-`leaseId` fake authority table (Slice 0).** |
| 8 | Mid-quarantine (`quarantine_grant`/`_finalize` interrupted) | Retry idempotently (distinct prefix); session terminal → drop + redacted log. |
| 9 | Corrupt/poison outbox row on boot | WRK-006 durable-gap stop: quarantine poison row, stop stream `corrupt_row`; MUST NOT strand post-poison terminal events; MUST NOT block sandbox reconciliation. |

Every case asserts: convergence on re-run (no double-kill); `processTreeAlive(id)===false` after kill (the leak oracle); cleanup call counts; outcome records + metrics; redaction (raw only via `peek`, hash-only in outcomes/logs).

---

## 8. Decisions

- **D1 — lease-state query GAP:** infer via `lease_renew`; enumerate from outbox stream keys + sandbox labels; worker reconciliation best-effort (server reaper authoritative); no protocol change.
- **D2 — resume-in-flight:** NEVER re-attach; kill + JOB-006 new attempt (CAV-003). Provide the narrow resume seam, unimplemented until a real provider (E6/E7).
- **D3 — teardown path:** live-process stale sandboxes → `CleanupAuthority.converge` (escalation); `reconcile()` stays the enumeration/outcome shell; empty-tree/terminal → direct `reconcileCleanup`.
- **D4 — unknown_sandbox:** conservative — do NOT kill; record an observable `unknown_sandbox` outcome; leave to the server reaper. (Alternative to weigh in review: unresolvable-under-own-selector ⇒ stale-kill.)
- **D5 — unknown-artifact enumeration:** CORE quarantines only artifacts enumerable from durable worker state / test-injected; full workspace scanning is DAT-006. Wire the mechanism + seam; defer full enumeration.
- **D6 — fake per-`leaseId` authority table:** add a `leaseId → {live, fence, expiry, cancelRequested}` table to the fake's renew/ack handlers (global FIFO stays as fallback for un-seeded leases). Explicit Slice 0.
- **D7 — outbox vs quarantine:** dead-lease outbox streams are ABANDONED via `stopStream`, NOT quarantined; only artifacts quarantine. Keep the two stores distinct.
- **D8 — ordering invariant:** a poison outbox row must not block sandbox reconciliation; outbox drain-to-convergence precedes/interleaves sandbox kill so terminal events land before destroy.
- **D9 — inherited live-wiring debt (surfaced, not CORE-blocking):** D2 producer unification (shared `EventSequencer` per lease/attempt), the concrete `EventOutboxLifecycle` adapter, E4-F008 rotated-provider-constraint-digest reconciliation — all E4-D12 live-dispatch concerns.

---

## 9. Slice plan (TDD, dependency order)

Every slice holds: E4-D01 boundary, E4-D02 frozen protocol (zero worker-protocol edits), 0 distributed test doubles (in-process fakes only), inert-until-wired.

- **Slice 0 — fake control-plane per-`leaseId` authority table (harness prerequisite, D6).** *Fail-first:* seed "lease L renewed / lease M target_revoked", probe both concurrently, assert deterministic per-lease verdicts (impossible with today's global FIFO). Keyed table in `handleRenew`/`handleAck`; global FIFO fallback. Unblocks all subsequent slices.
- **Slice 1 — control-plane-derived `isOrphan` predicate.** *Fail-first:* `reconcile()` with an injected `isOrphan` that probes `lease_renew` classifies a sandbox whose local `hasLiveLease=true` but whose probe returns `stale_fence` as an ORPHAN. Reuse `renewLeaseOnce`/`classifyRenewResponse`; enumerate leases from sandbox labels. WRK-004 tests stay green.
- **Slice 2 — sandbox three-way classification + `CleanupAuthority` teardown (D3, D4).** *Fail-first:* (a) a stale sandbox with a live tree + `ignoreCancel`/`ignoreKill` escalates cancel→kill→destroy to `processTreeAlive=false`; (b) a live-owned sandbox is skipped; (c) an unresolvable selector-matching sandbox records `unknown_sandbox` and is NOT killed. Route teardown through `converge`; add `cleanup_escalation{stage}`; redaction + idempotent re-run.
- **Slice 3 — outbox stream reconciliation.** *Fail-first:* post-crash an owned-lease stream resume-drains (recover→resend from `acceptedThroughSeq+1`, server dedups) while a dead-lease stream is eagerly `stopStream`'d; a poison row (checkpoint 9) neither strands post-poison terminal events nor blocks the sandbox pass. WRK-006 durable-gap semantics preserved; no attempts bump on recover.
- **Slice 4 — unknown-artifact quarantine sweep + startup lifecycle wiring (D5, inertness).** *Fail-first:* (a) an injected staged artifact under a dead fence routes through `runOrphanQuarantine` with `unknown_artifact`, lands under `quarantine/`, idempotent on re-run, `dropped` when session terminal; (b) bootstrap with no reconciler runs nothing (inert default); with one, the startup runner fires exactly once between `startHealth` and signal registration; rollback = omit. E4-D01 boundary; no `artifact_commit`/server route touched.
- *(Optional Slice 5 — full 9-checkpoint convergence suite)* asserting zero orphans + re-run convergence; may fold into slices 2–4.

---

## 10. Non-goals

Live provider integration (real E2B/sandbox — E6/E7); the implemented resume path (seam only); arbitrary workspace file-tree artifact reconciliation (DAT-006); rewiring the composition root to actually run at boot (E4-D12); any worker-protocol change; the server-side reaper (JOB-006, done). WRK-007 is additive, fake-tested, and inert-until-wired.

## 11. Residual risks

- **Inference model (D1):** worker reconciliation is best-effort; a partitioned worker cannot reconcile and falls back to the server reaper — acceptable by design, but means WRK-007 alone does not guarantee zero orphans without the server side.
- **Fake fidelity (D6):** the per-`leaseId` authority table is a test double of the server's per-lease authority; its fidelity to JOB-006's real `isActiveFence` is a review focus.
- **Unknown-sandbox conservatism (D4):** the never-kill default leaves selector-matching-but-unresolvable sandboxes for the reaper; review must confirm this doesn't leak under the coarse selector.
- **Artifact enumeration (D5):** CORE only quarantines enumerable/injected artifacts; the durable staged-artifact index is a gap deferred to DAT-006.
- **Distinct review pending:** an independent adversarial reviewer reruns the crash-at-checkpoint matrix (convergence/no-double-kill, redaction, the per-lease authority proof, the poison-row-doesn't-block invariant) and alone marks the ticket `complete`.
