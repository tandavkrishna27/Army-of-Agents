# WRK-005 Result — Lease renewal, local fence-close proxy, and orphan-output quarantine

**Status:** `complete` (distinct adversarial review ran; 2 findings fixed + fail-first-proven; full acceptance matrix re-green)
**Disposition:** `accepted` (2 fail-closed defects found by the distinct reviewer, both fixed with fail-first regression tests; see "Distinct adversarial review")
**Date opened (UTC):** `2026-08-14`
**Epic:** `E4-worker-daemon`
**Plan task:** `WRK-005 — Lease renewal / local fence-close proxy / governed egress (M; three slices)`
**Implementer:** `Claude subagent (opus) — worktree C:\e3`
**Start SHA:** 63c99267d (job-control tip: "feat(job-control): project outputs and run summaries")
**Consumed reviewed SHAs:** WRK-004 (`8b8fc013b` lineage, E4 CORE complete); frozen worker-protocol v1 source SHA `b7a842870ce7509d8baa75409e0ab19da375c88a`.

## Outcome

WRK-005 lands three additive, INERT-until-wired worker-daemon modules plus their wiring:

1. **Per-lease renewal driver** (`src/lease/lease-renewal.ts`) — a `SupervisorSeam` DECORATOR that
   captures `offer.expiresAt` at handoff, schedules a renewal at `expiresAt − leadMs`, renews the
   lease through the frozen `lease_renew` op under a FRESH `idempotencyKey`, and — on lease loss —
   closes the fence-close proxy FIRST, then escalates through the existing `Supervisor.onLeaseLost`.
   `poll-loop.ts` is UNTOUCHED (WRK-003/WRK-004 suites stay green).
2. **Local fence-close proxy** (`src/lease/fence-close-proxy.ts`) — a `GovernedEffectAuthority`
   cloned from `EffectAuthority`, bound to the run's `EffectFence`, that permits the four exit-gate
   governed effects (`commit`/`readSecret`/`complete`/`openEgress`) only while the fence is live and
   denies them with `FenceClosedError` after `close()` (terminal + idempotent). A post-close egress
   attempt also emits a `network_denied` worker event.
3. **Orphan-output quarantine** (`src/lease/quarantine.ts`) — routes post-close output ONLY through
   the device-session `quarantine_grant`/`quarantine_finalize` path (survives lease loss; distinct
   `quarantine/` prefix; ≤5-min non-promotable grant), never the disabled ordinary-commit path.

## Deliverables

**New runtime modules:** `src/lease/lease-renewal.ts`, `src/lease/fence-close-proxy.ts`,
`src/lease/quarantine.ts`.
**Modified runtime:** `src/transport/client.ts` (`leaseRenew`/`leaseRenewPath` +
`quarantineGrant`/`quarantineFinalize` + paths; widened `postOperation` union),
`src/metrics/metrics.ts` (five metric names + the closed `effect` label + new closed `outcome`
values), `src/supervisor/events.ts` (a `networkDenied` emitter on `EventSequencer` + the
`NetworkDenialClass` type), `src/lifecycle/shutdown.ts` (`renewal-stop` step between `lease-stop` and
`lease-drain`), `src/bin/worker-daemon.ts` (compose the renewal shutdown seam; document the wrapped
`SupervisorSeam`), `src/index.ts` (barrel the new public surface).
**Test-only extension:** `src/__tests__/support/fake-control-plane.ts` (renew route + device_session
quarantine routes) and `src/__tests__/support/renewal-fixtures.ts` (fake clock/scheduler, handoff,
session providers, recording supervisor, spy proxy, event-sink spy, quarantine fixtures). Both are
boundary-clean and excluded from `dist`.
**16 hermetic test files (27 cases):** the 9 renewal suites, the 4 fence-close/egress suites, and the
3 quarantine suites in the focused-command row.

## Fence-close-proxy design (defense-in-depth; the server `isActiveFence` is the real gate)

`FenceCloseProxy` mirrors `EffectAuthority` one-for-one: a private `#active` latch fronts each seam
with a guard, `close(reason)` sets it false (idempotent — the `fence_close{reason}` metric fires once
on the transition), and every seam then rejects `FenceClosedError` carrying the denied effect +
leaseId. It mirrors the server `GOVERNED_FENCE_SURFACE` / `GUARDED_JOB_MUTATORS` as a READ-ONLY spec
(`GOVERNED_EFFECTS = [artifact_commit, secret_materialization, task_completion, governed_egress]`) —
NEVER importing server code (E4-D01). `openEgress()` after close is the positive counterpart of
`CleanupAuthority.openEgress()`'s hard denial: it emits a schema-valid `network_denied` worker event
(via a dedicated `EventSequencer` over the injected sink) and meters `governed_effect_denied{effect}`.
The four methods are the named seams E5/DAT will route the live commit/secret/completion/egress
round-trips through; enforcing that routing is a downstream integration concern.

## Quarantine design + the non-promotion (CAV-004) proof

`buildQuarantineGrantRequest`/`buildQuarantineFinalizeRequest` construct the frozen
`quarantineGrantPayloadV1`/`quarantineFinalizePayloadV1` at audience `device_session`, authenticated
by `targetId` + `deviceGeneration` (a DEVICE, not a live lease); the observed lease/fence are recorded
non-authoritatively. The object key is pinned under the DISTINCT
`quarantine/organizations/<org>/jobs/<job>/attempts/<n>/` prefix (never the ordinary attempt prefix),
and the finalize's manifest records the ordinary key it WOULD have gone to. **Non-promotion (CAV-004)
is enforced by the frozen schemas themselves — no apply/promote/select/checkpoint-selection field
exists on the grant, the finalize, or the receipt (whose only disposition is `quarantined`).**
`quarantine-routing-decision.test.ts` asserts the built envelopes contain no `promote`/`apply`/`select`
key; `quarantine-grant-finalize.component.test.ts` asserts the receipt disposition is exactly
`quarantined` with no promote field. `runOrphanQuarantine` first requires a LIVE device session, then
posts grant → finalize; a terminal session DROPS the output (redacted log), never the disabled commit
path.

## Renewal design

The driver holds one `LeaseState` per lease (offer, fence proxy, `expiresAtMs`, `leadMs`, timer). A
renewal timer at `expiresAt − leadMs` runs `driveRenewal`, which: (1) does a pre-POST monotonic expiry
check (a late-firing timer past `expiresAt` fails closed locally — no renew posted); (2) mints ONE
fresh `idempotencyKey` per interval; (3) posts the renew with a transient-retry loop that reuses the
SAME key (idempotent_retry), recovers a `401` via `session.recover()` under
`MAX_CONSECUTIVE_RECOVERIES`, and is capped by the lease deadline (no busy-spin). A `renewed`
reschedules to the server expiry (a past expiry = clock-skew loss; `cancelRequested` = cooperative
`supervisor.cancel`). A `rejected`/`stale_fence`/`target_revoked`/`attempt_terminal`/deadline-lapse is
a **lease loss**: close the proxy FIRST (`fence_close`), meter `lease_loss{reason}`, then
`supervisor.onLeaseLost`. The `renewLeaseOnce` single-op is exported and mirrors `ackLease`.

## Resolved design decisions

- **E4-F007 (session-renewal bound):** renewal is built BOUNDED-BY-SESSION — a `SessionTerminalError`
  is a lease loss (→ fence close → orphan-output quarantine), NEVER a session extension. F007 is
  recorded in `findings.md` (WRK-005 addendum) as the OPEN dependency for sustained/long jobs; WRK-005
  did NOT design around it client-side.
- **E5/DAT routes do not exist:** WRK-005 = local authority + renewal + FAKE-control-plane-tested
  quarantine (parallels WRK-004 building against the fake provider). The live commit/secret/completion/
  egress/quarantine round-trips are E5/DAT — out of scope; the four proxy methods are the named seams.
- **device_session auth binding is PROVISIONAL** (pending E5/DAT): the client method + the fake plane
  reuse the worker-session Bearer + device proof binding; the concrete server contract (route strings +
  header binding) is E5/DAT-owned. Marked provisional in `transport/client.ts` and the quarantine
  module.
- **Config/tuning:** the renewal `leadMs` derives from the offered window (`leadFraction` default 0.5,
  `leadMinMs` floor 1000, `skewMarginMs` 1000, `leadMaxMs` 300000), overridable; the quarantine grant
  budget is the frozen ≤5-min ceiling enforced by the response schema.
- **Wrap, not edit:** the driver decorates the `SupervisorSeam` at composition, so `poll-loop.ts` is
  untouched.

## Verification-surface results (operator-directed windows-local from `C:\e3`; Linux CI = DEC-03 authority)

Re-run in full AFTER the 2 distinct-review fixes (+2 regression test files / +2 cases):

| Lane | Result |
|---|---|
| Focused WRK-005 suite (18 files) | PASS — **18 files, 29/29** (added `lease-renewal-per-lease-cap` + `lease-renewal-unexpected-throw`) |
| Full worker-daemon suite (regression) | PASS — **64 files, 216/216** (WRK-001..004 green; +2 review-regression files) |
| Fail-first proof (both fixes) | PASS — each regression test FAILS against the reverted pre-fix code (global counter → spurious `onLeaseLost:<B>`; no-wrapper → uncaught throw) and PASSES against the fix |
| `pnpm check:worker-daemon-boundary` | PASS |
| `pnpm check:frozen-worker-protocol-v1 -- --source-sha b7a842870…` | PASS — zero changed worker-protocol files (sourceSha match) |
| `npx tsc -p …/tsconfig.json --listFilesOnly` | PASS — **0** emitted paths under `src/__tests__` |
| `pnpm --filter @armyofagents/worker-daemon typecheck` (production graph) | PASS — exit 0 (build tsconfig excludes `src/__tests__`; the two new test files + the `makeRenewalHandoff` edit are individually type-clean — verified via a temp test-inclusive tsconfig — and the residual branded-string fixture "errors" are the pre-existing test-tier convention, CI-excluded) |
| `pnpm --filter @armyofagents/worker-daemon build` | PASS — `dist/lease/*` emitted; **0** test artifacts in `dist` |
| `pnpm check:distributed-foundation` (keystone) | PASS — no grant/policy/DDL drift (WRK-005 adds none) |
| `pnpm install --frozen-lockfile` | PASS — no lockfile change; runtime deps stay exactly `@armyofagents/worker-protocol` + `pino` |

## Distinct adversarial review (VERDICT: accept after 2 fixes)

An independent adversarial-review pass (finders → refute-by-default verifiers) reran the acceptance
matrix and surfaced **two CONFIRMED fail-closed defects** in the renewal driver, both in the
loss-escalation path (exactly where a silent failure would leave the fence-close proxy OPEN and defeat
the WRK-005 defense-in-depth guarantee). Both are fixed, each with a fail-first regression test that was
proven to FAIL against the pre-fix code and PASS against the fix.

1. **Per-lease recovery cap was driver-global (cross-lease contamination) — CONFIRMED.**
   The `MAX_CONSECUTIVE_RECOVERIES` 401-recovery bound lived in a driver-scoped `consecutiveRecoveries`
   counter. But the driver fans out into N concurrent per-lease renewal loops sharing ONE
   `SessionProvider`, so a token rotation that 401s several leases at once (or one already-capped +
   lost lease) corrupts every other lease's count: a HEALTHY lease that 401s once is spuriously
   declared lost (global already at the cap), or a stuck lease never caps. **Fix:** moved the counter
   into `LeaseState.recoveries` (per-lease), incremented/reset/cap-checked per lease.
   **Regression:** `lease-renewal-per-lease-cap.test.ts` drives lease A to the cap (persistent 401 →
   loss, leaving a global counter at 3) then lease B with exactly ONE 401 — B must recover once and
   stay alive. Fail-first proof: against the reverted global counter B is spuriously lost
   (`expected […] to not include 'onLeaseLost:<B>'`) while the single-lease `lease-renewal-401-recovery`
   suite stays green (confirming the bug is cross-lease-specific).

2. **`driveRenewal` had no try/catch around the renew flow → silent hang, proxy left OPEN — CONFIRMED.**
   The renewal timer is fire-and-forget (`void fn()`). `renewLeaseOnce` maps ONLY
   `ControlPlaneTransportError` to a transient outcome and RE-THROWS everything else (a mid-body-stream
   read error surfaced by the transport, a `signDeviceProof` fault, a Zod parse throw). Such a throw
   became an unhandled rejection: the lease was neither renewed nor declared lost, the fence-close
   proxy stayed OPEN (defense-in-depth defeated), and the supervisor was never escalated. **Fix:** split
   into `driveRenewalInner` (the flow) wrapped by `driveRenewal`, whose try/catch treats any
   unclassified throw as a **fail-closed lease loss** (`declareLoss` → close proxy → `onLeaseLost`),
   logging the cause. **Regression:** `lease-renewal-unexpected-throw.test.ts` injects a client whose
   `leaseRenew` throws a non-transport `Error` and asserts the proxy closes (`close:<lease>:lease_lost`)
   BEFORE `onLeaseLost` and the lease goes inactive. Fail-first proof: against the reverted
   (no-wrapper) code the throw escapes uncaught into the test — the exact silent-hang the fix prevents.

Both fixes are internal to `src/lease/lease-renewal.ts`; the public surface, the frozen protocol, the
dependency boundary, and the keystone foundation are unchanged. The reviewer confirmed the JOB-014-style
concern (a governed projection re-guarding an already-terminal attempt) does NOT apply here — the
renewal loss path has no projection receipt.

## Non-goals (unchanged from the ticket)

Live E5/DAT transport ops + server routes (artifact_commit / transfer_grant / completion / egress-proxy
/ quarantine_*); the durable event outbox (WRK-006); live-control-plane reconciliation (WRK-007); any
server-side session-renewal fix (E4-F007 / E3-JOB-002); starting the loop for real dispatch (E4-D12).
WRK-005 is additive and inert-until-wired.

## Residual risks

- **F007 (session bound):** until the E3/JOB-002 server fix lands, any job longer than the ~15-min
  session window loses its lease and quarantines late output rather than running to completion. The
  client behavior is correct; the platform capability is gated on F007. (findings.md E4-F007 addendum.)
- **E5/DAT deferred:** the live commit/secret/completion/egress/quarantine round-trips and the concrete
  `device_session` header binding + route strings are unbuilt; the client methods are shaped to the
  frozen schemas and proven only against the fake plane's chosen binding (marked provisional).
- **E4-D12 provisioning refresh (E4-F008):** the renewal driver is the first module composed at the
  live-dispatch seam; a rotated provider-constraint digest reconciliation is owed by the wiring ticket.
- **Distinct review pending:** an independent adversarial reviewer must rerun the full acceptance
  matrix (every fence-close denial, the non-promotion proof, the F007-bound quarantine proof) and alone
  mark the ticket `complete`.
