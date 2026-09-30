# WRK-003 Result — Poll, ACK, and capability advertisement

**Status:** `complete`
**Disposition:** `pass`
**Date opened (UTC):** `2026-08-13`
**Epic:** `E4-worker-daemon`
**Plan task:** `WRK-003 — Poll, ACK, and capability advertisement (M; three slices)`
**Implementer:** `Claude subagent (opus) — worktree C:\e3`
**Reviewer:** `Claude adversarial-review Workflow (4 dimensions → dedup → refute-by-default verify; 11 agents) + fix-round verification`
**Start SHA:** `a60ca2154` (WRK-002 commit)

## Acceptance model

The multi-agent adversarial-review Workflow is the independent check. It returned **7 confirmed
findings (7 raw → 7 unique → 7 CONFIRMED, 0 refuted)**; contract-fidelity and metrics/boundary
dimensions returned **empty** (the dual-auth contract and payload-free metrics are sound). All 7
are resolved below.

## Dependency and scope state

- Consumes JOB-003 (`pass`) as-built poll/lease/ACK contract + the committed WRK-002
  identity/session/transport. Additive worker-only modules; **no server/db/migration change**;
  frozen `packages/worker-protocol` untouched; runtime deps stay exactly
  `@armyofagents/worker-protocol` + `pino`.
- **Dual auth (verified):** poll (`worker_poll`, 64 KiB/30s) and ACK (`worker_run`) both send the
  stored `aoa-worker-session` as `authorization: Bearer …` PLUS an `AOA-DEVICE-PROOF-V1` device
  proof; the server binds `proof.deviceThumbprint === session.deviceThumbprint`. ACK body
  `leaseId` == URL param. The worker reuses the WRK-002 signer (no second canonicalizer).
- **Provisioning (E4-D12):** the capability self-check consumes the worker's registered target
  profile + branded provider constraints as a **provisioning input**, digest-verified against the
  enroll ref (enroll delivers only `{profileId,version,digest}`). The poll loop is **composed but
  not started at runtime** (dispatch inert, matching WRK-001) until provisioning + the WRK-004
  supervisor land. Profile refresh on digest rotation is a forward JOB-002-family concern.
- Scope stops at poll/ACK + capability self-check + concurrency/backoff + drain. The WRK-004
  supervisor is a typed **stub seam**; lease renewal/fence-close is WRK-005; the durable event
  outbox is WRK-006.

## Implementation (3 slices, subagent TDD)

- Slice A — `capacity`/`backoff`/`concurrency` primitives.
- Slice B — poll/ACK client (dual auth) + `workerSatisfiesRequirements` self-check + fake
  poll/ACK extension. Non-vacuousness proven: forcing the self-check → `true` reddened
  `poll-incompatible`; signing the ACK proof over a wrong path reddened `poll-offer-ack` (the fake
  independently returned 401).
- Slice C — loop composition, outage backoff, terminal-vs-transient, drain-before-lease-stop.

## Terminal vs transient (E4-D11/E4-F007)

- Poll/ACK **401** → attempt a within-code-window recovery (WRK-002 SessionStore); if it fails
  (or repeats — see fix 3) the session is **terminal**: emit `session_reenrollment_required_total`
  and stop, no busy-spin. **409 `target_revoked`** → terminal. **timeout/429/503/socket** →
  bounded jittered backoff (floored, never zero-spin) + continue. **malformed** → surfaced, no
  offer leak. An offer failing the capability self-check or a saturated slot is never ACKed.

## Independent adversarial review + fix round (7 confirmed, all fixed)

- **[1] BLOCKING** — a server-supplied `retryAfterMs:0` (permitted by the frozen schema on
  `no_work`/`throttled`/`internal_unavailable`) drove a zero-delay hot poll loop: the explicit
  branch clamped to `maxMs` with no `baseMs` floor. A 429 "slow down" would be answered at max
  rate — a self-inflicted retry storm. **Fixed:** `nextBackoff` and `cadenceSleep` now floor every
  honored delay at `min(baseMs,maxMs)` while still honoring larger hints; every path stays within
  `[min(baseMs,maxMs), maxMs]`. RED (`expected 0 to be ≥ 1000`) → GREEN.
- **[6]** (same root, transient path) — folded into fix 1 + a transient-`retryAfterMs:0` test.
- **[2] SHOULD-FIX** — no `stopLeasing` re-check between poll-returns-offer and ACK: an offer
  arriving during shutdown could be ACKed after `drain()` snapshotted the in-flight set →
  abandoned ACKed lease. **Fixed:** the offer branch drops the offer un-ACKed (`offer_dropped`) +
  breaks when stop/drain is requested. RED (`expected 1 to be 0`) → GREEN.
- **[3] SHOULD-FIX** — a recovered-but-still-401'd session re-polled with reset backoff + no
  sleep → unbounded recover/poll cycle. **Fixed:** `MAX_CONSECUTIVE_RECOVERIES=3` (reset on any
  successful poll); on exceed → terminal `reenrollment_required`. RED (flood: 11 calls) → GREEN
  (terminates at 3).
- **[4] SHOULD-FIX** — no LOOP-level incompatible/backpressure test (the self-check could be
  deleted, suite stays green). **Fixed:** composed-loop `poll-incompatible` + `poll-backpressure`
  tests (`poll_outcome{outcome="incompatible"|"backpressure"}`, no ACK).
- **[5] SHOULD-FIX** — `target_revoked` (409) terminal path uncovered. **Fixed:**
  `poll-revoked.component.test.ts` (poll-path 409 → `target_revoked`, `pollCount===1`; ACK-path
  409 → slot released).
- **[7] NIT** — ACK-failure branches uncovered + un-injectable. **Fixed:** fake gained an
  `enqueueAck` directive queue; `poll-ack-failures.component.test.ts` covers ack
  401→recover / 429→backoff / 200-rejected(stale_fence)→backoff / socket→backoff, each asserting
  slot release + correct `lease_ack{outcome}` routing.

New metric value token: `offer_dropped` (bounded closed-set); no new label keys.

## Operator-directed Windows-local evidence (from `C:\e3`; Linux CI = DEC-03 authority)

| Lane | Result |
|---|---|
| `pnpm --filter @armyofagents/worker-daemon exec vitest run` | PASS — **27 files, 146/146** (WRK-001 45 + WRK-002 45 + WRK-003 56) |
| `pnpm check:worker-daemon-boundary` + self-test | PASS + 46/46 |
| `pnpm --filter @armyofagents/worker-daemon exec tsc --noEmit` | PASS — exit 0 |
| `npx tsc --listFilesOnly` (packages/worker-daemon) | PASS — 0 files under `src/__tests__` |
| `pnpm check:frozen-worker-protocol-v1 -- --source-sha b7a842870…` | PASS — zero changed worker-protocol files |
| `pnpm install --frozen-lockfile` | PASS — no-op |
| runtime `dependencies` purity | PASS — exactly `@armyofagents/worker-protocol` + `pino` |

## Decision

WRK-003 is `complete` / `pass`. The poll loop is fully implemented + resilience-hardened
(bounded backoff on every path, drain-safe lease-stop, bounded recovery, capability self-check,
backpressure) but composed-inert per E4-D12 pending provisioning + the WRK-004 supervisor. Not
the E4 integration gate; carried on the cumulative Wave-3 branch. Next: **WRK-004** (sandbox
supervisor + `SandboxProvider` port — resolve E4-F002/F003/F004).
