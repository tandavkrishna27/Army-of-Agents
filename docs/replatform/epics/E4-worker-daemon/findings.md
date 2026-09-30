# E4 Worker daemon — findings

Scoped discoveries and plan-review deltas for E4. Each finding names the ticket
that must resolve it. Source: Batch A adversarial plan-review (2026-08-12).

## E4-F001 — Device-proof vectors must be a shared JOB-002 (E3) deliverable — RESOLVED

**Status:** `resolved` (2026-08-12) · unblocks **WRK-002** · Severity: HIGH (H-04/H-05 device-binding proof).

**Resolution:** `tests/fixtures/device-proof/v1/vectors.json` now holds the neutral shared
canonicalization vectors (4 positive + 4 reject), derived from and verified against the SERVER
canonicalizer (`server/src/services/worker-device-proof.ts`). The server test
(`server/src/__tests__/worker-device-proof.test.ts`) was refactored to consume the fixture, and
`scripts/check-device-proof-vectors.mjs` is an independent THIRD reference implementation wired
into CI (`policy`/verify) that fails if the fixture drifts from the algorithm. WRK-002's
sign-side test consumes the SAME file — a worker-local copy is no longer possible, so server
compatibility (not just self-consistency) is proven. The original open text is retained below
for provenance.

---

**Status (original):** `open` · blocks **WRK-002** · Severity: HIGH (H-04/H-05 device-binding proof).

`server/src/services/worker-device-proof.ts` defines the `AOA-DEVICE-PROOF-V1`
canonical tuple, but **no shared vector fixture exists in the repo** — the server
proves its canonicalizer only via a hardcoded inline array in
`server/src/__tests__/worker-device-proof.test.ts`. A worker-local fixture the
server never reads proves only worker self-consistency, not server compatibility.

**Resolution (do at WRK-002 assignment):**
1. Publish canonical vectors to a **neutral shared path**
   `tests/fixtures/device-proof/v1/vectors.json`. Minting/owning that file is a
   **JOB-002 (E3) deliverable**, not a WRK-002 task — WRK-002 cannot unilaterally
   author a trustworthy fixture.
2. BOTH the server device-proof test AND WRK-002's signer test consume that one
   file, plus a `policy`-job checker that fails if the two consumers diverge.
3. **Hard STOP:** WRK-002 may not be closed by self-authoring a worker-local copy.

## E4-F002 — Networked worker→provider driver + wire is OUT of WRK-004 CORE — RESOLVED

**Status:** `resolved` (WRK-004, 2026-08-13) · Severity: HIGH (cross-plan seam; E6F-03 depends on it).

**Resolution:** the `SandboxProvider` port (`packages/worker-daemon/src/supervisor/provider.ts`)
is transport-agnostic — a plain async method surface with no wire assumptions. WRK-004 CORE binds
ONLY the in-process `createFakeSandboxProvider`; the networked worker→provider driver + wire is a
named NON-GOAL owned by a later ticket (reconcile with E6-F003), documented at `provider.ts:24-33`.
Original text below.

---

**Status (original):** `open` · resolve at **WRK-004** · Severity: HIGH (cross-plan seam; E6F-03 depends on it).

WRK-004 CORE builds only an in-process fake provider. E1 froze only the
worker↔control-plane transport; the worker↔provider networked path is unowned,
yet E6/DEP-002 puts workers on `provider-ctl-net` and E6F-03 requires a networked
worker→provider smoke.

**Resolution:** WRK-004's `SandboxProvider` interface gets a **pluggable-transport
seam** (in-process binding in CORE; network binding deferred). WRK-004 Non-goals
must name the owning ticket for the networked driver + wire. Reconcile with E6-F003.

## E4-F003 — `SandboxProvider` port must be importable by DEP-000 — RESOLVED

**Status:** `resolved` (WRK-004, 2026-08-13) · Severity: MED-HIGH.

**Resolution:** the `SandboxProvider` port type + all result/label/authority types DEP-000 needs
are exported from `@armyofagents/worker-daemon`'s public API (`src/index.ts`); the port stays
authoritative in worker-daemon and a future `@armyofagents/sandbox-fake-provider` (DEP-000)
imports + implements it (documented `provider.ts:15-22`). Mirror in E6-F004.
Original text below.

---

**Status (original):** `open` · resolve at **WRK-004** · Severity: MED-HIGH.

DEP-000 (fake provider) must implement WRK-004's provider-driver port, but the
port is planned as internal to `packages/worker-daemon/src/supervisor/provider.ts`.

**Resolution:** export the port type from `@armyofagents/worker-daemon` (and have
`@armyofagents/sandbox-fake-provider` depend on it), OR relocate the port to a
shared leaf both consume. State the choice in WRK-004 Files/Interfaces. Mirror in E6-F004.

## E4-F004 — WRK-004 slice B (cleanup authority) may exceed the 3-day bound — RESOLVED (no split)

**Status:** `resolved` (WRK-004, 2026-08-13) · Severity: MED (sizing).

**Resolution:** slice B fit within the ticket bound — full monotonic-epoch + redaction +
cross-resource-denial + idempotency + escalation + expiry coverage landed in one ticket; **no
split was triggered**. Original watch note below.

---

**Status (original):** `open` · watch at **WRK-004** · Severity: MED (sizing).

The monotonic redacted cleanup authority (epoch, redacted projection, cross-resource
denial, idempotency replay, escalation, expiry) is ~1.5–2 days alone.

**Resolution:** pre-authorize splitting slice B into a follow-on ticket if it slips;
record the split trigger so it is not an improvised scope change.

## E4-F005 — WRK-001 dependency-boundary gate was blind to `require()` — RESOLVED

**Status:** `resolved` (WRK-001 fix round) · Severity: HIGH (supply-chain bypass).

To permit Node runtime globals (`process`/`Buffer`) for a daemon, the initial
`worker-daemon-boundary.mjs` dropped the shared `findForbiddenGlobals` scan, which
also silently removed CommonJS-`require` detection. A runtime source could
`require("child_process")` or `createRequire` via `node:module` and pass the gate —
defeating the static import allow-list the gate exists to enforce.

**Resolution:** re-imported `findForbiddenGlobals`; the gate rejects any `require(`
token and the `module`/`node:module` bridge builtins while still allowing Node
globals. REDs B1a/B1b/B1c in `check-worker-daemon-boundary.test.mjs` lock it.

## E4-F006 — WRK-001 boundary/config/metrics hardening — RESOLVED

**Status:** `resolved` (WRK-001 fix round) · Severity: MED (defense-in-depth + one leak).

Adversarial review of the WRK-001 bootstrap found four should-fix + three nit issues,
all resolved except one deferred defense-in-depth nit:
- **S1** manifest union now covers optional/peer/bundled/bundle dependencies (REDs added).
- **S2** config error no longer echoes the raw control-plane URL (names the var + protocol only).
- **S3** invented custody↔scope coupling removed; orthogonality ratified as **E4-D10**.
- **S4** bare-import allow-list rejects any `..` traversal (`pino/..` RED added).
- **N2** loopback set is numeric-only; the remappable name `localhost` is rejected.
- **N3** metric labels validate VALUES against a bounded token, not just keys.
- **N1 (deferred)** logger passes `Error` through untouched — a blanket message scrub is
  deferred to WRK-002+; the one reachable instance (S2) is fixed. Tracked, not lost.

## E4-F007 — JOB-002 provides no sustained worker-session renewal (10-min code route < 15-min session) — ESCALATION to E3/JOB-002

**Status:** `resolved` (WRK-010 slice 2, go-book Sprint 2.5) · was HIGH · Source: WRK-002 adversarial review (CONFIRMED blocking, reframed per [[E4-D11]]).

The as-built JOB-002 enroll/session contract cannot sustain a worker session beyond the
enrollment code-route window:
- `CODE_TTL_MS = 10 min` (never extended) gates **all** enroll replays (`worker-enrollment.ts:295`),
  and is shorter than `SESSION_TTL_MS = 15 min`.
- `/worker-control/poll` + `/leases/:id/ack` do not re-issue the session (no sliding renewal).
- Enroll always requires the one-time code header; there is no device-proof-only reauth.

Therefore a worker whose 15-min session nears expiry has **no path** to a fresh session: replay
is dead (code route expired at 10 min), poll won't slide it, and it has no live code. A
job-execution platform needs workers to run longer than 10–15 min, so this is a real gap.

**Resolution (E3/JOB-002 follow-up ticket, server-side — NOT WRK-002, which consumes JOB-002 as
an immutable input):** pick one — (a) do NOT gate an already-consumed **replay** on the
code-route TTL (bind it to the enrollment record's own lifetime + a device-proof reauth window
instead); (b) slide/re-issue the session on authenticated `poll`; or (c) add a device-proof-only
reauth endpoint. Each needs its own RED coverage + independent review. Until then, WRK-002 ships
enroll + identity + lost-response recovery + revocation only, and downstream poll (WRK-003) will
observe session expiry as a 401 requiring re-enrollment.

**Does NOT block:** WRK-002 CORE acceptance (per [[E4-D11]]). **Blocks:** any claim that workers
run sustained/long jobs (relevant to WRK-005 lease renewal, DEP journeys, E7+ coding runs).

**WRK-005 addendum (2026-08-14 — resolved-for-now as the session-bound dependency).** WRK-005 built
the client-side lease-renewal driver **bounded by session lifetime** (the E4-F007-recommended scope):
a lease cannot outlive its session, so a `session.get()`/`recover()` that surfaces `SessionTerminalError`
(the lapsed 10-min code route / cap-tripped recovery) is treated as a **lease loss → fence close →
`onLeaseLost` → orphan-output quarantine**, NEVER a session extension. The renewal client behavior is
CORRECT regardless of the server fix. **This finding remains OPEN as the dependency for sustained/long
jobs:** until the E3/JOB-002 fix lands (slide-on-poll / device-proof-only reauth / unbind replay from
the code TTL), a worker whose 15-min session nears expiry has no path to renew a lease beyond it, so
any job longer than the session window will lose its lease and quarantine late output rather than run
to completion. WRK-005 did NOT design around F007 client-side (per the finding's directive).

**WRK-010 slice-1 addendum (2026-08-25 — the SERVER route lands; the finding stays open).** Slice 1
ships a device-proof-bound renewal route, `POST /api/worker-control/session/renew`, that never
touches the enrollment code table: a worker presenting a **live** session plus a fresh device-key
proof receives a **new** 15-minute-bounded session. It reuses the shipped
`createWorkerSessionAuthenticator` for nine of the ten authority guards and adds one of its own — a
platform-physical denial (R1) the authenticator no longer performs for free. The option taken is the
finding's **(c), AMENDED — proof PLUS a live session**, not its literal "device-proof-**only**"
wording (`:148-149`): a proof-only endpoint would turn the device key into a bearer credential and
force a thumbprint→organization routing table the tenant boundary forbids, so it was rejected; (a)
unbinding the code-route TTL makes the one-time bootstrap code live forever, and (b) sliding the
session on `poll` couples authority lifetime to work availability — both rejected. **What slice 1 does
NOT change:** *nothing calls this route.* No sprint before Sprint 2.5 points `SessionStoreDeps.renew`
(`identity/session.ts:55`) at it, so a worker still loses its path to a fresh session at the
ten-minute code-route boundary — which is this finding's own statement of the defect. Marking it
`resolved` here would convert a live problem into a settled one. **Closure owner: WRK-010 slice 2**,
go-book §4 *"★ Sprint 2.5 — WRK-010 slice 2: the renewal route gets its first caller"*, which ships
the worker-side client, the near-expiry threshold in `SessionStore.ensureFresh`, and the first-session
acquisition (E4-F012). Slice 1 is the rollback unit: delete the route registration and the services
are inert.

**WRK-010 slice-2 resolution (2026-08-25 — the finding closes here, not at slice 1).** Slice 2 shipped
the worker-side half slice 1 lacked: the device-proof renewal CLIENT
(`packages/worker-daemon/src/identity/session-renewal.ts` `createSessionRenewer`, wired to
`ControlPlaneClient.sessionRenew` → the slice-1 route), a near-expiry threshold in
`SessionStore.ensureFresh` (`identity/session.ts` `RENEWAL_HEADROOM_MS = 5 min`, the ≥5-min
proof-replay-window invariant §3.5(i) requires), and the production session lifecycle
(`identity/worker-session-lifecycle.ts` `createWorkerSessionLifecycle`) that the boot root composes
when a provider + `AOA_WORKER_DISPATCH_ENABLED` are present — giving the route its FIRST production
caller. Proven against a real database with the real daemon lifecycle
(`server/src/__tests__/worker-session-lifecycle.integration.test.ts`, embedded-PG): a composed daemon
obtains its FIRST session (from the enrolment sink, or from the bootstrap code replay on a
steady-state boot), then a RENEWED one from THIS route (`s1 !== s0`, `iat`/`exp` strictly greater),
and authority sustains past the original T0+15min expiry. The near-expiry renewal in a RUNNING process
is driven by Sprint 3's poll loop (`createPollLoop`), which this slice does not compose; the mechanism
is built, wired, and proven here. A residual, DIFFERENT gap remains and is NOT this finding: a cold
restart AFTER the code window (no live session, no live code, sessions not persisted) still needs
re-enrolment — a session-persistence concern owned by no ticket in this sprint's scope
(WRK-010-slice-2-design.md §11 R2). `E4-F012` closes in the same commit set.

## E4-F008 — WRK-005 inherits the E4-D12 provisioning-refresh concern (loop-toward-live-dispatch)

**Status:** `open` · owned by **WRK-012** (repointed from WRK-008 at slice-2b completion) · Severity: LOW
(inert today) · Source: WRK-005.

A rotated provider-constraint digest can go stale on a long-lived worker. **WRK-008 slice 2b composed
the loop** — the seam this finding named — but reads the self-model **once at boot** and never re-reads
it (`composeDispatchRuntime` clamps capacity to `resourceCeiling` at composition time;
`PollLoopDeps.self` is a plain value), so a mid-life provider-constraint rotation cannot be observed or
reconciled against in-flight leases. **★ REPOINTED to WRK-012 at slice-2b completion** (2026-08-26):
leaving it `owned` by shipped WRK-008 would read as owned by nobody (E4-F013). WRK-012 (a filed scoping
stub) adds the self-model **refresh channel** + a lease-in-flight policy. LOW because the direction of
failure is closed: a stale digest makes the worker **unmatchable**, not wrongly matched
(`capabilities.ts:466-467`) — a reason independent of E4-F010 (which WRK-011 closed).

## E4-F009 — `createStartupReconciler` is not composable at boot — one blocker, not two

**Status:** `open` · owned by **WRK-013** (repointed from WRK-008 at slice-2b completion) · Severity: MED · Source: WRK-008 slice 2b planning pass (2026-08-25), adversarial review round 2.

**★ REPOINTED to WRK-013 at slice-2b completion** (2026-08-26): slice 2b DEFERRED
`createStartupReconciler` for the one real blocker below and shipped, so leaving E4-F009 `owned` by
WRK-008 would read as owned by nobody (E4-F013). WRK-013 (a filed scoping stub) adds the durable
lease-candidate source and composes the reconciler.

`leaseCandidates` (`supervisor/startup-reconcile.ts:256-257`) has no durable local source: the
event outbox persists **events**, not offers, so the lease-authority probe would run over `[]` on
every boot — a reconciler that reconciles nothing, which is worse than an absent one because the
gate clause it backs would read as satisfied.

**Recorded because the draft deferral gave TWO reasons and one of them is false.**
`ownershipSelector.organizationId` is **not** a blocker: it is carried on the self-model this slice
already reads, and the frozen schema guarantees it non-null for organization- and owner-scoped
targets (`worker-protocol/src/capabilities.ts:307-321`; D1's `worker-b` is
`AOA_WORKER_TARGET_SCOPE: "organization"`). Wiring is **conditional on scope**, not impossible. A
deferral standing on a false reason is a deferral nobody will re-examine.

**Blocks:** E4 gate clause 3 (`E4-3-survives-restart`) staying `dormant` in the wiring register
until a durable lease-candidate source exists.

## E4-F010 — A composed worker cannot be OFFERED work — and would refuse it if it were

**Status:** `resolved` (WRK-011, go-book Sprint 2.75, 2026-08-25) · Severity: HIGH · Source: WRK-008 slice 2b planning pass (2026-08-25).

> **★ RESOLUTION — WRK-011 closure, 2026-08-25** (`tickets/WRK-011-result.md`). All three blockers
> are removed and the finding's own statement of the defect — *"a worker can enrol correctly, assemble
> a valid self-model, self-check correctly, and dispatch nothing, forever"* — is now **false** on every
> half.
> - **The three §0 corrections stand:** the shipped hello emits **no** capabilities (not `sandbox.*`),
>   which made the conclusion stronger; `profile_snapshot`'s one update channel was enrolment rotation,
>   which a daemon can never travel twice; and "false for 100% of offers" was true of the code but
>   **vacuous in production** (`createPollLoop` has zero production callers).
> - **The THIRD blocker this entry never named** — the enrolled all-zero `capacity` as a hard
>   `Math.min` ceiling at `job-leasing.ts:566` that empties the admissible-workload list *before* the
>   matcher — is the one that fires first, and the refresh writes a **real** capacity into the snapshot.
> - **What closes it:** the atomic triple (`profile_snapshot` + `profile_hash` + a fresh session move
>   together in one transaction, mint before commit) on the new `POST /api/execution-targets/self/hello`
>   route, plus the provisioned `buildDesktopHello`/`deriveHelloProvisioning`. Proven at embedded-PG
>   through the **real `poll` service**: `no_work` precondition → refresh → `offer`; the daemon self-check
>   admits that same captured offer.
> - **What it does NOT claim** (WRK-011 §6.3): a composed daemon that polls/ACKs/supervises is Sprint 3
>   (`createPollLoop` still has zero production callers), and one real journey on E2B is Sprint 5.
>   `gate-clause-wiring.json E4-1-leases-through-protocol` stays `unwired`; Sprint 3 promotes it.

Two independent halves, either of which alone is sufficient to make dispatch produce nothing:

- **Server side.** `workers.profile_snapshot` has no update channel. Its only writers are
  `worker-enrollment.ts:444` and `:470`, both on the enrolment path.
- **Worker side.** `poll-loop.ts:538` runs `offerSatisfiesWorker` against the worker's **own**
  `self.report`, and the only production hello builder emits `sandbox.*` capabilities with a
  64-zero `policyHash` (`enrollment/desktop-hello.ts:144`, `:154`). The self-check therefore
  returns `false` for **100% of offers**, independently of anything the server does.

So a worker can enrol correctly, assemble a valid self-model, self-check correctly, and dispatch
nothing, forever. **This is the finding that separates "dispatch composed" from "dispatch
working".** The fixture hello (`poll-fixtures.ts:88-93`, `:134`) *does* include `workload.batch`,
which is why a suite written against the fixture goes green over a hello production never builds —
the trap is named in WRK-008 slice 2b §1.1(c).

**Blocks:** any claim that a distributed worker executes real work; Sprint 5's single-journey
proof; MIG-005/006/007 ACTIVE, which inherit it on top of [[E4-F007]].

**Owner: WRK-011 (go-book Sprint 2.75).** `tickets/WRK-011-design.md` — *a provisioned worker can be
OFFERED work and can ACCEPT it*. **One** ticket owns **both** halves: the server route is not inert on
success (it replaces `profile_hash`, which kills the calling worker's own session at
`worker-session-auth.ts:167`), so shipping the route without its first caller would leave a worker
worse off than not calling it. **Status stays `open` — WRK-011 has a design doc and no result doc.**
★ Read that design's §0 before citing this entry: it corrects three of the claims above against the
code (the shipped hello emits **no** capabilities rather than `sandbox.*`, which makes the conclusion
*stronger*; `profile_snapshot`'s one update channel is enrolment rotation, which a daemon can never
travel twice; and "false for 100% of offers" is true of the code but **vacuous in production today**,
since `createPollLoop` has zero production callers) and adds a **third** blocker this entry never
named, firing earlier than either half above: the enrolled all-zero capacity is a hard `Math.min`
ceiling at `job-leasing.ts:566`, so the admissible workload list is empty and
`repositories/tenant/job-control.ts:1810-1812` returns zero candidates before the static matcher is reached.

## E4-F011 — One of the container's four landable gates is ALREADY SATISFIED on the desktop boot root

**Status:** `resolved` (DEP-010, Sprint 2) · Severity: HIGH · Source: WRK-008 slice 2b adversarial review (2026-08-25) — the review falsified the plan's own four-gate claim.

`packages/worker-keystore/src/bin/desktop-host.ts:114-125` builds **both** OS-custody stores and
`:254-260` passes them on every non-control, non-reset boot. `resolveCustody`
(`worker-daemon/src/identity/device-identity-store.ts:128-133`) makes `mounted_secret`-plus-a-store
a **fatal** refusal, so any desktop host that boots at all is running `os_keychain` with custody
present, and `bin/worker-daemon.ts:267` is entered. Gate 3 (`no_worker_identity`) is therefore
**already satisfied there**, and gate 5 (`no_session`) is reachable within ten minutes of a code.

**Of the four gates somebody has to LAND, the container stands on all four and the desktop on
three: `no_provider`, the flag, and `no_event_outbox_path`.** The full gate list is **six** — a live
session and an admin-set placement profile gate dispatch just as hard, they are simply not fixed by
landing a change. Six outstanding on the container, five on the desktop.

> **★ CORRECTED 2026-08-25.** This entry was filed saying **two**, copying the number from WRK-008
> slice 2b before its own round-2 review caught the contradiction: that plan's gate table marks the
> desktop as gated on `AOA_WORKER_EVENT_OUTBOX_PATH` (`runDesktopHost` forwards `env` verbatim into
> the same bootstrap, so both roots hit that gate identically) and then counted the desktop at two
> in the sentence below the table. The table was right. The finding's *substance* is unchanged — one
> of the container's four gates is already satisfied on the desktop — only the count moved. **And it
> moved again:** the title said THREE while the body said the full list is SIX, and the sentence
> below said *one environment variable* — three numbers for one quantity inside a single register
> entry. The title now states the invariant instead of a count, because the invariant is what does
> not change. **Say which enumeration you mean, every time.**

DSK-003 ships that root as a signed installer, so the day a provider lands in it, an installed
desktop running the build is **two environment variables** — `AOA_WORKER_DISPATCH_ENABLED` and
`AOA_WORKER_EVENT_OUTBOX_PATH` — plus a live session and an admin-set placement profile away from
taking real leases, where the container additionally has a structural gate no env edit can open.

**Consequence for DEP-010:** it may not put a provider in that composition root without an explicit,
written decision about the flag's default on desktops. Its acceptance must prove the shipped desktop
default constructs **no provider at all** — not merely that the flag is off.

**Resolution (DEP-010, Sprint 2).** DEP-010 supplied the written decision this finding demanded and
the guards its acceptance required. The decision (DEP-010 design §4.3): exactly one boot root gets a
provider *path*, and it is `desktop-host.ts`; the container root (`bin/worker-daemon.ts`, the
`docker/worker/Dockerfile` `CMD`) structurally **cannot** have one — its DEP-001 image closure is
worker-daemon + worker-protocol + `pino` only, and the daemon boundary checker pins its runtime deps
so it may not name a provider package at all (E4-D01). On the desktop root the provider switch
`AOA_WORKER_SANDBOX_PROVIDER` defaults **UNSET** and the resolver returns `{kind:"none"}` **before
calling the loader**, so the shipped default constructs **no provider at all** — not merely that the
flag is off (`resolveSandboxProvider`, DEP-010 Step 6; proven by the loader-never-called case and the
structural-lock guard, DEP-010 Steps 4/6/7/8/10). `AOA_WORKER_DISPATCH_ENABLED` defaults **OFF**
through the daemon's own parser (`config.ts` `parseDispatchEnabled`) because `runDesktopHost` forwards
`deps.env` verbatim; DEP-010 ships no per-root default for it.

This resolves the **decision** the finding forced on DEP-010; it does not close the underlying
exposure, and DEP-010 design **§4.2** hands that forward in writing. The invariant in this entry's
title is unchanged: one of the container's landable gates is already satisfied on the desktop
(custody). The **structural** gate — that nothing consumes `compose === true` because
`bin/worker-daemon.ts` has no `else` — is DEP-010's primary proof of inertness, and it **expires**
when WRK-008 slice 2b (Sprint 3) writes that `else`. After Sprint 3 the desktop's inertness rests on
the remaining gates — unset environment switches plus runtime conditions (an absent live session, an
absent admin-set placement profile) — and there is no deployment-surface guard on the desktop lane
for those switches (§4.2 item 2), which becomes the whole exposure once the structural gate is gone.
**Say which enumeration you mean, every time:** this resolution records the invariant and the handoff,
deliberately not a gate count, because the counts filed against this finding were retracted and the
invariant is what does not move.

## E4-F012 — The renewal route cannot mint a FIRST session, and nothing in the plan set acquires one

**Status:** `resolved` (WRK-010 slice 2, go-book Sprint 2.5) · was HIGH · Source: independent codex review, 2026-08-25 — found after two adversarial review rounds had passed over the same seam.

WRK-008 slice 2b composes `new SessionStore(..., initial = null)` and says the first session is
"minted lazily, on first `ensureFresh()`". Trace it:

1. `enroll-once.ts:310` — **`result.session` is dropped here and never returned (I13)**, in those
   words. So after enrolment the composed daemon holds no session.
2. `SessionStore.ensureFresh` (`identity/session.ts:100-106`) returns the current session if live,
   otherwise calls `forceRefresh()` → `this.#deps.renew()`. With `initial = null` the **first** call
   goes straight to `renew()`.
3. `SessionStoreDeps.renew` (`identity/session.ts:50-55`) takes **zero arguments** by contract.
4. The WRK-010 route's authenticator requires a live bearer: `createWorkerSessionAuthenticator`
   matches `^Bearer\s+…$` and `fail()`s when absent (`worker-session-auth.ts:125-127`), then
   `verifyWorkerSessionToken` rejects `exp <= now` (`:98-101`).

**So a `renew` thunk pointed at the renewal route has nothing to present on the call that matters
most — the first one.** The route renews a session by construction; it cannot create one. Slice 2b's
positive control passes only because it injects a fake that ignores that precondition.

**This is not a plumbing bug, it is a decision.** I13 discards the enrolment session deliberately so
a bearer token can never reach a log line. Acquiring a first session means one of:

* **(a)** `enrollOnce` gains a narrow, deliberate way to hand the session to the store — not to a
  logger, not to a return value that flows anywhere else. This is a **re-opening of I13** and needs
  its own security argument, not a refactor.
* **(b)** a separate bootstrap acquisition path, distinct from `renew`, with `SessionStoreDeps`
  changed accordingly. Note this falsifies slice 2b's claim that the seam is "ONE injected thunk —
  swapping it changes nothing else".
* **(c)** the route learns to mint, which re-opens the enrolment-code problem WRK-010 exists to
  close. Recorded for completeness; not recommended.

**Owner: WRK-010 slice 2 (go-book Sprint 2.5).** It is the sprint that owns session lifecycle, and it
cannot meet its own "the route has a production caller" acceptance clause without answering this.

**Blocks:** WRK-010 slice 2's acceptance; WRK-008 slice 2b's self-model read and every runtime
composition downstream of it, all of which sit behind a session the composed daemon cannot obtain.

**WRK-010 slice-2 resolution (2026-08-25).** Both halves of the decided mechanism (WRK-010 §9.1.1)
shipped. **Change 1 — the SINK, option (a) without re-opening I13:** `enrollOnce` gained an OPTIONAL
`onSessionMinted?(session)` fired at `enroll-once.ts:310` where `result.session` is otherwise dropped;
`EnrollmentOutcome` is byte-for-byte unchanged (still frozen, still the seven-key allowlist, no
`session`/`token`), so the invariant I13 protects — the returned aggregate — does not move. **Change 2
— option (b), the SEPARATE bootstrap dependency:** `SessionStoreDeps.renew` now takes `(current:
WorkerSession)` and a REQUIRED `bootstrap()` supplies the first session; `forceRefresh` routes
`prev !== null ? renew(prev) : bootstrap()`, so "no first session" is a COMPILE error at every
construction site, not a review catch (proven: the daemon typecheck fails without `bootstrap`). The
first session's origin on every boot path is tabled in WRK-010-slice-2-design.md §6 and proven at
embedded-PG: the ENROLLING boot's sink and the STEADY-STATE boot's bootstrap code replay. Resolved in
the same commit set as `E4-F007`.

## E4-F013 — `ownerStillOpen` is unvalidated free text, so a finding can stay falsely owned by a shipped ticket

**Status:** `resolved` (E4-F013 ownership-successor ticket, 2026-08-27) · was MED · Source: independent codex review, 2026-08-25.

**Resolution (`epics/E4-worker-daemon/tickets/E4-F013-ownership-successor-design.md`).** The
`ownerStillOpen`-only escape hatch in `finding-ownership.mjs` is replaced by a **five-arm chain** that
runs when `entry.status === "owned"` **and** `completed.has(entry.ticket)`, each arm a RED test in
`finding-ownership.test.mjs` plus a DELETE mutation:
`!hasReason(ownerStillOpen)` → `owner_ticket_already_complete` (**kept verbatim** — the V2 calibration
"has a result doc ≠ finished" is intact); `!hasReason(successor)` → `successor_missing`;
`successor === entry.ticket` → `successor_is_self` (a shipped owner naming ITSELF re-opens the exact
hole, mirroring `dependency-graph.mjs`'s `dep === id` self-check); `!tickets.has(successor)` →
`successor_not_on_disk` (reuses the `owner_ticket_missing` existence set); `completed.has(successor)` →
`successor_already_complete` (a shipped successor is the same hole one level down). The one owned entry
the new branch reaches at rest — **E11-F002 → REL-003**, the only owned entry whose ticket has a result
doc — gains `successor: "DBR-001"`, a filed on-disk scoping stub
(`epics/E11-hardening-release/tickets/DBR-001-design.md` + a `#### DBR-001` program node depending on
REL-003, invisible to the REL-keyed release gate) for the owed `aoa db:restore` entrypoint + live DR
rehearsal; E11-F002 stays **open** — the migration makes its survival-past-a-shipped-owner *checkable*,
it does not resolve it. The successor check is **existence-only**: it machine-forces a real ticket
node + dep skeleton (the graph guards do the rest) but cannot verify the named ticket is the *correct*
inheritor — that stays author/review responsibility. E4-F013's own resolution is the standard two-step
flip-and-delete (Status → `resolved` **and** its `finding-ownership.json` key removed in the same
commit). Original text below.

---

**Status (original):** `open` · Severity: MED · Source: independent codex review, 2026-08-25.

`scripts/lib/finding-ownership.mjs:118-120` fails an entry whose owning ticket already has a
`-result.md` **unless** `ownerStillOpen` is a non-empty string. Non-emptiness is the entire test.
So the escape hatch that exists for "the ticket shipped but the finding legitimately survives it"
also silently covers "nobody moved this and nobody noticed".

**Three live instances, all of which go false the moment their owner ships:**

* `E4-F008` and `E4-F009` are `owned` by **WRK-008**. Slice 2b's own text says F008 *survives* the
  slice and should be re-pointed at a future refresh ticket, and F009 waits on an unnamed durable
  lease-candidate source. Neither plan step transfers ownership.
* `E6-F003` is `owned` by **DEP-010** while DEP-010 §2 marks it **explicitly deferred**; the planned
  manifest edit rewrites only its `reason`, leaving `status: "owned"`.

**Proposed fix, checkable:** when the owning ticket has a result doc, require a `successor` field
naming a ticket that exists on disk — the same existence check `owner_ticket_missing` already does.
Then "it survives its owner" must name who inherits it, and a shipped-and-forgotten finding fails.
Needs its own RED test and a deleted-guard mutation before it lands.

**Blocks:** nothing today. Recorded because this guard is the programme's backstop against exactly
this failure, and it has a hole in it.

## E4-F014 — DSK-001 documents `IdentityLifecycle.acquireSession()` as a landed seam, but no such symbol exists

**Status:** `open` · Severity: LOW · Source: WRK-010 slice-1 terrain verification, 2026-08-25.

DSK-001's design doc asserts a symbol that has no code behind it — the **fourth** time this programme
has found a documented fact with nothing under it. `grep -rn "acquireSession" --include=*.ts` over
`packages/` and `server/` returns **nothing**; `IdentityLifecycle` appears only in design documents.
Two copies make the claim, and BOTH must be named because a remediation aimed at one would leave the
other standing in the very document the finding is about:

* `epics/E10-desktop/tickets/DSK-001-design.md:351` — *"`IdentityLifecycle.acquireSession()` is landed
  as the seam the renewal successor implements without reshaping callers."*
* `epics/E10-desktop/tickets/DSK-001-design.md:431` — *"`IdentityLifecycle.acquireSession()` is the
  drop-in seam; the fix is a device-proof-bound renewal endpoint."*

The real seam the renewal successor targets is **`SessionStoreDeps.renew`**
(`packages/worker-daemon/src/identity/session.ts`), which WRK-010 slice 1 designed against and slice 2
shipped the device-proof renewal client against (see the E4-F007 resolution above). This finding
tracks the phantom symbol **discretely** so the `:351`/`:431` claims are cross-referenced rather than
only corrected inside another finding's prose. *(Its earlier text pointed at the `E4-F007` key in
`scripts/finding-ownership.json`; that key was deleted when E4-F007 resolved, so the pointer now names
the E4-F007 finding section here instead — the same two-copies rot this finding is about.)*

**DSK-001's design doc is NOT rewritten** — it is a dated record of a shipped ticket; the finding is
the correction, and the document keeps its history.

**Blocks:** nothing. It is a documentation inaccuracy in a shipped ticket's design doc, not a code
defect. `unowned` because no product ticket is its natural owner — a remediation is a one-line
cross-reference, not work any sprint carries.

## E4-F015 — The gate count is prose with no single source of truth, and the obvious checker is unsound

**Status:** `resolved` (obviated 2026-08-28) · Severity: MED · Source: readiness-audit follow-up, 2026-08-25.

The readiness audit named "nothing counts gates" as the riskiest unwritten risk and proposed a
~20-line checker: read the `DispatchRefusalReason` union from source and fail when a document states
a different total. **That checker is unsound as specified**, for two reasons found by reading the
source:

1. **The shipped union has FOUR members** (`no_provider`, `dispatch_disabled`,
   `no_self_model_reader`, `no_self_model` — `packages/worker-daemon/src/lifecycle/compose-dispatch.ts:22-26`).
   The "six gates" every doc discusses is the **post-slice-2b** model; the three extra tokens
   (`no_worker_identity`, `no_event_outbox_path`, `no_session`) **do not exist in source yet**. A
   checker reading the union would fail on *correct* docs that discuss the future six.

2. **No single source enumerates the six.** The six-gate model conflates the composition-refusal
   union with *runtime* conditions — a live session and an admin-set placement profile — that are
   not composition refusals at all. There is nothing to read.

So "count the gates" is genuinely prose, which is *why* it keeps being miscounted (four instances
this programme, one of them three different numbers inside a single register entry — the E4-F011
history above).

**What IS sound, and worth its own ticket:** a declaration-based guard that pins the *shipped*
union to an exact declared set, so the person who adds `no_session` et al. in slice 2b must update
the declaration — at which point every doc that described "the shipped union" becomes reviewable.
The existing unit test (`packages/worker-daemon/src/__tests__/compose-dispatch.test.ts:103-108`)
does NOT do this: it iterates a hand-listed array, so a fifth member added to the union but not the
array still passes. Wiring a new `check-*.mjs` also touches `guard-inventory`, `execution-census`
and `pr.yml`, so it is not a drive-by edit.

**Interim rule (no checker):** any document stating a gate count MUST label which enumeration it
means — *shipped union* (four), *landable* (four), or *total including runtime* (six). A bare number
is the defect. This finding is the reason that rule exists.

**Blocks:** nothing today. Recorded so the miscounting has a home instead of recurring.

**★ RESOLVED — obviated 2026-08-28.** The "sound alternative worth its own ticket" already exists in
source: `DISPATCH_REFUSAL_MESSAGES: Readonly<Record<DispatchRefusalReason, string>>`
(`compose-dispatch.ts:124`) is a TOTAL `Record` over the shipped union (`compose-dispatch.ts:36`), so a
new union member with no message is a `tsc` error — a declaration-based pin of the shipped union, and
strictly stronger than the hand-listed array test this finding criticized (which passes on an un-added
member). No `check-*.mjs` is warranted; wiring one would only duplicate the compiler. The interim label
rule (state which enumeration a gate count means) stands as documentation guidance. Verified against
source + human-decided (not on prose alone); ownership key deleted in the same commit (C4).

## E4-F016 — `desktop-hello`'s "capacity is not a safety property" comments are false on the poll path

**Status:** `open` · Severity: LOW · Source: WRK-011 §0(d) + closure, 2026-08-25.

Three comments assert the enrolled all-zero `capacity` is byte-stability decoration the matcher
overwrites, so it is not a safety property:
- `packages/worker-daemon/src/enrollment/desktop-hello.ts:28` — *"The all-zero capacity is kept for
  byte-stability, not for safety."*
- `desktop-hello.ts:145` — *"Kept for byte-stability. NOT a safety property — the matcher overwrites it."*
- `packages/worker-daemon/src/__tests__/desktop-hello.test.ts` — the comment repeating the belief
  (*"the matcher overwrites this, so the assertion above is documentation, NOT the guarantee"*).

All three are **true of `evaluateStaticLeaseEligibility`** (which substitutes `NEUTRAL_LEASE_MATCHER_CAPACITY`,
`job-lease-eligibility.ts:213`) and **false of the poll path**: WRK-011 §0(d) proved the stored capacity
is a hard `Math.min` clamp at `job-leasing.ts:566`, so zero stored capacity empties the admissible
workload list and returns zero candidates *before* the static matcher is reached. Capacity IS
load-bearing on the live lease path — a third, earlier axis of unmatchability the comments deny.

WRK-011 corrects the **code** they describe (a provisioned refresh now writes a real capacity) but a
dated design/comment record is not silently rewritten mid-file — this finding is the correction.

**Blocks:** nothing. A documentation inaccuracy inside shipped comments, not a code defect. Filed
declared (a new open finding is born undeclared, and undeclared fails the ownership guard); it is
`accepted` (LOW), the remediation being a three-line comment fix no sprint carries on its own.

## E4-F017 — WRK-011's `refreshWorkerProfile` is an authority writer that skips the mandated target→worker→exclusive lock

**Status:** `resolved` (Sprint 5 Step 1 follow-up, 2026-08-26) · Severity: MED · Source: CLI-006/D2 Step 1 CI diagnosis — the `job-leasing-contract.test.ts` "exhaustive authority-writer allowlist" is a REAL, deterministic red on `docs/replatform-program`, independent of the §2.0 `verify` timeout.

WRK-011 landed `refreshWorkerProfile` (`packages/db/src/repositories/tenant/worker-enrollment.ts`) as an
authority write to `workers` (`profileHash`, `profileSnapshot`, `updatedAt`), but it acquired **only** a
`runInTenant` (RLS) context + a compare-and-set on `expectedProfileHash` — **not** the
`target → worker → exclusive` platform-target-authority lock that `job-leasing-contract.test.ts` mandates for
every authority writer (via `directOrder`/`delegatedOrder`). Its caller
(`server/src/services/worker-hello-refresh.ts` `createWorkerHelloRefreshService.refresh`) does **not** acquire
the lock either. The contract test flagged it two ways: (a) missing from the reviewed `expected` allowlist, and
(b) `refreshWorkerProfile must prove target → worker → named exclusive authority before every mutation`.

**Concurrency shape.** The CAS serializes two concurrent refreshes (the loser gets `refresh_conflict`), but
NOT a refresh racing a concurrent target revocation/rotation/ratification — the exact defense-in-depth the
per-target exclusive lock provides. WRK-011 §6 documented a bounded revoke-vs-refresh edge (codex-H2, refuted
as *session dead-on-arrival*); the contract does not accept "bounded by CAS" for an authority writer.

**Resolved** by adding the lock INLINE in `refreshWorkerProfile` (the `directOrder` path), in the same
`target row FOR UPDATE → worker row FOR UPDATE → acquirePlatformTargetAuthorityExclusive` order the reviewed
`lockPlatformAuthorityForMutation` helper uses (so no deadlock vs the other authority writers), plus the
reviewed `expected`-allowlist entry. **Not weakened** (no exemption added). Proven: the contract test goes
green with the lock and RED under M-lock (delete the exclusive acquire → the exact `must prove … exclusive`
violation returns); WRK-011's 8 embedded-PG integration tests (incl. the concurrent `refresh_conflict` and the
throwing-signer rollback) stay green with the lock; `packages/db` typechecks. Out of CLI-006/D2's own scope,
fixed opportunistically because it reddens `verify` on its own — the ONE `verify` red besides the deferred
§2.0 timeout.

## E4-F018 — `countProductionCallers` counted STRING LITERALS, so a sentence saying a symbol has zero callers was itself counted as that symbol's caller

**Status:** resolved (2026-09-06, W5U1 — fixed in the same change that filed it; see "Fix" below)
**Severity:** MEDIUM (a guard defect that manufactured phantom non-zero counts; it could not
manufacture a phantom zero, and no declared clause verdict was ever wrong because of it)
**Filed:** 2026-09-06 (W5U1), measured at `e1f723df2`.

**What.** `countProductionCallers` (`scripts/check-gate-clause-wiring.mjs`) excluded test paths,
comments, the definition line, imports and re-export blocks — but not string literals. Its sibling
`stripComments` carries the docstring *"This repo has mistaken a comment for a call site more than
once — including a comment whose entire content was 'this function has zero callers'."* The same
sentence in double quotes was still being counted.

**The two instances, measured before the fix:**

1. `createResultCommitter` measured **1**. Its only non-test, non-comment, non-re-export reference
   in the entire tree is the STRING at `server/src/services/e7-distributed-run-verifier.ts:513`:
   `"uncomposed, and buildWorkspacePatch/createResultCommitter have zero production callers. So this run "`.
   The guard read E7-1's own diagnostic message — a sentence asserting the symbol has no callers —
   as the caller. `buildWorkspacePatch` was inflated by the same string (2 → 1).
2. `createSupervisor` measured **4**, of which **2** are its own error messages:
   `packages/worker-daemon/src/supervisor/supervisor.ts:267` and `:270`, both
   `throw new Error("createSupervisor: …")`. Its real references are `dispatch-runtime.ts:95`
   (`typeof createSupervisor`) and `:121` (the `?? createSupervisor` fallback). True count: 2.

**Why it matters, at its real size.** The guard's own docstring states the asymmetry it depends on:
*"A count of 0 is DEFINITIVE … A count > 0 is NECESSARY BUT NOT SUFFICIENT."* Everything the guard
can PROVE rests on the zero. String counting attacks exactly that: it manufactures non-zero from
prose, and prose that says "zero callers" is the most likely prose to name a zero-caller symbol —
so the error correlates with the case the guard exists for. It cannot manufacture a phantom zero,
which is why this is MEDIUM and not HIGH, and why **no declared clause's verdict was ever wrong**:
`createSupervisor` (E4-2) had 2 real callers either way, and `createResultCommitter` is not declared
at all (that omission is E3-F038).

**Fix (W5U1).** `stripStringLiterals` in `scripts/check-gate-clause-wiring.mjs`, applied inside
`countProductionCallers` AFTER the import/re-export blanking (order is load-bearing: both blanking
expressions match `from "…"`, so stripping first would un-blank every import in the tree). Quoted
contents are dropped and delimiters kept; a quote with no closer on its line is abandoned at the
newline so a mis-detection costs one line rather than the file; template literals drop their literal
text and copy `${…}` interpolations verbatim, so a real call inside an interpolation still counts.

**Mutation evidence.** `scripts/check-gate-clause-wiring.test.mjs` (new; wired into `pr.yml`'s
existing gate-clause-wiring step). Reverting the fix — dropping the `stripStringLiterals` call —
reds exactly the two tests labelled `THE MUTATION` (`1 !== 0`, `3 !== 1`) and leaves the other eight
green, including the real-call, template-interpolation, blanked-import and excluded-test-path
controls. `node scripts/check-gate-clause-wiring.mjs` exits 0 on the real register in BOTH states.

**Effect on the register, measured with `--counts` before and after.** Exactly ONE declared symbol
moved: `createSupervisor` 4 → 2. Every other declared count is byte-identical, and **no clause's
verdict changed** — `wiredCount` 9, dormant 11, exit 0 in both states.
