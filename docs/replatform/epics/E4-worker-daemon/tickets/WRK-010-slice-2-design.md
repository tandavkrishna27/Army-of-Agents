# WRK-010 slice 2 — Design: the renewal route gets its first caller (go-book Sprint 2.5)

**Epic:** `E4-worker-daemon`. **Sprint:** 2.5 (go-book §3, §4). **Gate to start:** Sprints 1 and 2
green (both SHIPPED). **Gates:** Sprint 2.75 (WRK-011) and Sprint 3 (WRK-008 slice 2b).
**Resolves, in the same commits:** `E4-F007` (HIGH), `E4-F012` (HIGH).
**Predecessor:** [`WRK-010-design.md`](./WRK-010-design.md) §9.1 + §9.1.1 scope this slice and
**decide its mechanism**; [`WRK-010-result.md`](./WRK-010-result.md) records what slice 1 shipped.

> **★ The mechanism is ALREADY DECIDED — this plan IMPLEMENTS and PROVES it, it does not
> re-derive it.** WRK-010 §9.1.1 ("`E4-F012`, DECIDED", 2026-08-25) records the full decision with
> its security argument. This plan ADOPTS it verbatim (§2 below quotes it) and spends its length on
> the two things §9.1.1 explicitly left to the slice-2 author: (1) *where the first session comes
> from on every boot path the composed daemon actually takes* (§6 — the table the go-book Sprint
> 2.5 prompt demands), and (2) making "the route has a production caller" **genuinely reachable, not
> merely compile-clean** (§3.3, §7 Step 8's real-DB integration).

---

## ★ 0. Corrections verified at tip before designing around them

Every claim below was read at tip `107b56230` (the branch head when this plan was committed). Where
a predecessor doc and the disk disagree, the disk wins and the disagreement is named (go-book §2.2).

**(a) `SessionStoreDeps.renew` is zero-argument today, and `ensureFresh` is not a near-expiry
scheduler.** `packages/worker-daemon/src/identity/session.ts:55` — `readonly renew: () =>
Promise<WorkerSession>`. `ensureFresh` (`:103-107`) returns the current session while
`this.#deps.now() < this.#current.expiresAtMs` and calls `forceRefresh()` **only when the session is
absent or already expired**; its docblock at `:96-102` states *"This is NOT a near-expiry renewal
scheduler"*. `forceRefresh` binds `const prev = this.#current` at `:127` and calls
`this.#deps.renew()` at `:129`. `set()` at `:88-90` has **zero callers in the package** (grep). All
as §9.1.1 records.

**(b) The renewal route refuses a request with no live bearer, by construction.** The slice-1 route
`POST /api/worker-control/session/renew` (`server/src/routes/worker-control.ts:305`) authenticates
via `createWorkerSessionAuthenticator`, which `fail()`s on a missing/`^Bearer\s+…$`-mismatched
authorization header (`server/src/middleware/worker-session-auth.ts:125-127`) and rejects
`claims.exp <= nowSeconds` (`:100-101`). So a `renew` thunk pointed at this route has **nothing to
present on the first call** from an empty store — this is `E4-F012`, verbatim.

**(c) `enrollOnce` drops the enrolment session on purpose, and I13 is narrower than "no session may
exist".** `packages/worker-daemon/src/enrollment/enroll-once.ts:310` — the comment reads
*"`result.session` is dropped here and never returned (I13)"*, immediately before a frozen
seven-key `EnrollmentOutcome` at `:311-319` with **no** `session`/`token` key (`:146-154`). The
`EnrollmentOutcome` docblock at `:140-145` names the hazard it prevents: *"a single
`logger.info({ result })` would put a live bearer token in the logs. Nothing downstream can log what
it never receives."* — a property of the **returned aggregate**, not of the session's existence in
memory (`result` is live from the `enroller.renew(...)` await at `:273` to the freeze at `:311`).
This is exactly the invariant §9.1.1 quotes to justify that a **sink is not a re-opening of I13**.

**(d) The steady-state boot short-circuits before minting a session.** `enroll-once.ts:194-204` —
identity **and** receipt both present ⇒ `Object.freeze({… skipped: true …})` and return, **before**
the network call at `:273`. So on a re-boot of an already-enrolled device the sink cannot fire (no
session is minted) — the first session on that path must come from somewhere else (§6). §9.1.1 cost
item 6 states this; verified.

**(e) `EnrollResult.session` is a real `WorkerSession`.** `enrollment/enroll.ts:87` (`EnrollResult`)
and `:71-79` (`WorkerSession = {token, workerId, targetId, deviceGeneration, obtainedAtMs, ttlMs,
expiresAtMs}`). `Enroller.renew(input: RenewInput)` (`:232-234`) returns `EnrollResult` with a live
`.session`. So the sink's payload type is `WorkerSession`, and the bootstrap dependency (§3.1) can be
built on `Enroller.renew` — the exact code-replay body slice 2b would otherwise have wired to `renew`.

**(f) The daemon session is CONSUMED by the poll loop, which is Sprint 3.** `SessionStoreDeps.renew`
reaches production only through `store.ensureFresh()`/`forceRefresh()`, wrapped by
`createSessionProvider(store)` (`packages/worker-daemon/src/poll/poll-loop.ts:382-395`:
`get()→ensureFresh()`, `recover()→forceRefresh()`) and driven by `createPollLoop`. **`createPollLoop`
and `createSessionProvider` have zero production callers today** — the boot root
(`bin/worker-daemon.ts`) composes no loop. Sprint 3 (WRK-008 slice 2b) gives them their first. This
is the single most important fact for scoping this slice: **Sprint 2.5 builds and PROVES the session
lifecycle; Sprint 3 DRIVES it via the poll loop.** §3.3 and §11 R1 state exactly what that means for
"the route has a production caller".

**(g) `decideDispatchComposition` requires FOUR gates, and `hasSelfModelReader` is still `false`.**
`packages/worker-daemon/src/lifecycle/compose-dispatch.ts:59-67` returns `compose:true` only when
`provider && dispatchEnabled && hasSelfModelReader && selfModel`. The boot root passes
`hasSelfModelReader: false` (`bin/worker-daemon.ts:344`) — that flips to `true` only when Sprint 3
threads the self-model read through. **Consequence, load-bearing for this plan:** the session
lifecycle must compose on a WEAKER gate than full dispatch — `provider && dispatchEnabled` — because
acquiring a session is a *prerequisite* to reading the self-model, not a consequence of it (§3.2).
Gating the lifecycle on `decideDispatchComposition().compose` would construct nothing in Sprint 2.5
and leave the route compile-clean-but-unreachable — the exact defect this sprint exists to close.

**(h) The container boot root cannot inject a provider; only the desktop root can.** DEP-010 §4.3
(shipped): exactly one boot root gets a provider path, `packages/worker-keystore/src/bin/desktop-host.ts`;
the container root (`bin/worker-daemon.ts` via `docker/worker/Dockerfile`) structurally cannot
(E4-D01; its DEP-001 image closure is worker-daemon + worker-protocol + `pino`). `desktop-host.ts`
runs `os_keychain` custody and passes both identity+receipt stores on every non-control boot
(slice 2b §2; `desktop-host.ts:114-125`, `:254-260`). **So the session lifecycle composes only on the
desktop `os_keychain` root** — where the device key is available from the identity store — and the
`mounted_secret` container never composes it (no provider). This retires the custody-key complexity
§9.1.1 cost item 6 raises "on every container": within Sprint 2.5's actual composition, no container
composes (§3.2, §6).

**(i) E4-F007 and E4-F012 are both `open` and owned by WRK-010.** `findings.md:130` (E4-F007,
`Status: open`, HIGH) and `:316` (E4-F012, `Status: open`, HIGH). `scripts/finding-ownership.json`
carries both keys as `owned`/`WRK-010` (E4-F007 with an `ownerStillOpen` sequencing closure at
Sprint 2.5; E4-F012 likewise). This slice resolves both (§10).

**(j) `server` does NOT depend on `@armyofagents/worker-daemon`.** `server/package.json:51` lists
`@armyofagents/worker-protocol` only. The slice-1 integration test
(`server/src/__tests__/worker-session-renewal.integration.test.ts`) **hand-rolls** the device proof
(`node:crypto` `generateKeyPairSync`/`sign`/`createHash`) and stands the route up via
`express()` + `workerControlRoutes` + `supertest` against embedded PostgreSQL. To prove this slice's
transitions with the **real daemon lifecycle** (not a hand-rolled client), the integration test must
import the daemon package — a cross-package dependency this plan adds as a `devDependency` and
verifies against the boundary checkers at Step 0 (§3.1, §7 Step 8, §11 R4).

---

## 1. The fact this slice exists to change — the zero-caller thread

Slice 1 shipped `POST /api/worker-control/session/renew` with **zero production callers, on
purpose** (WRK-010-result §0). Sprint 3 (WRK-008 slice 2b), as originally sequenced, wired
`SessionStoreDeps.renew` to **`Enroller.renew`** — the enrolment **code replay**, whose module header
(`enroll.ts:4-15`) says in as many words that *"there is NO dedicated renew route/audience"* and that
a replay *"only succeeds while the code route is live"* (`CODE_TTL_MS = 10 min < SESSION_TTL_MS = 15
min`). So Sprints 1 + 2 + 3 would have shipped:

* a renewal route nobody calls (slice 1's product, unused), **and**
* a composed daemon that still loses authority at the 10-minute code-route boundary,

which is the exact shape of the 17 unprovable gate clauses this programme's audit exists to fix. The
completeness critic caught it; the go-book inserted **Sprint 2.5** to close it. **This slice is what
makes slice 1 worth having.**

**Net after this slice:** a worker that composes dispatch holds a live session, and — before that
session expires — exchanges it plus a fresh device proof for a new bounded one **on the renewal
route**, with no human step, no enrolment code, and no 10-minute ceiling. `E4-F007`'s defect ("a
worker near expiry has no path to a fresh session once the code route lapses") is answered by a
mechanism that is built, wired into the production boot root, and proven against a real database.

---

## 2. The mechanism — ADOPTED from WRK-010 §9.1.1, not re-derived

WRK-010 §9.1.1 records the decision (2026-08-25). This plan adopts it. Restated for the executor:

**Change 1 — `enrollOnce` gains a SINK, not a return.** Add one **optional** dependency to
`EnrollOnceDeps`:

```ts
/** Invoked with the freshly minted session, at the point it is otherwise dropped (I13-safe:
 *  a store is not a value anyone logs; EnrollmentOutcome is unchanged). */
readonly onSessionMinted?: (session: WorkerSession) => void;
```

invoked at `enroll-once.ts:310` — where `result.session` is discarded today. **`EnrollmentOutcome`
does not change**: still `Object.freeze`d, still the seven-key allowlist (`:146-154`), still no
`session`/`token`. I13's property is about the returned aggregate, and the returned aggregate does
not move (§0c). The sink is **optional** so that deleting its wiring still **compiles** and is
therefore killable by a test (mutant **S2-M1**).

**Change 2 — `SessionStoreDeps.renew` takes the session it is renewing, and first-session
acquisition becomes a SEPARATE, REQUIRED dependency.**

```ts
readonly renew: (current: WorkerSession) => Promise<WorkerSession>;   // was: () => Promise<…>
readonly bootstrap: () => Promise<WorkerSession>;                     // NEW, REQUIRED
```

`forceRefresh` already binds `const prev = this.#current` at `:127`, so the routing is a one-line
change: `prev !== null ? this.#deps.renew(prev) : this.#deps.bootstrap()`. The **required** bootstrap
dependency converts `E4-F012` from a defect a careful reader must catch into one that **does not
compile** — a type is a better reviewer than a third adversarial round. The **deliberate asymmetry**
(sink optional, bootstrap required) is the mechanism, not an accident (§8's counted/not-counted split).

**Why the two are not redundant (§9.1.1 cost item 6, verified §0d/§0h).** The sink is the
**enrolling** boot's first session only. On the steady-state boot `enrollOnce` returns `skipped`
before minting, so the sink never fires; the bootstrap dependency is the load-bearing half there. On
the shipped default and on the container, no lifecycle composes at all (§0g/§0h). The full boot-path
table is §6.

**This slice ALSO owns the production identity + `SessionStore` construction** (go-book §4 Sprint 2.5:
*"the production identity + SessionStore construction moves here"*). Slice 2b's §0.2(A)/Step 0 already
re-scopes to consume it rather than build it. §3.3 states exactly what "production caller" means given
that Sprint 3 owns the driver.

---

## 3. Architecture

### 3.1 The two acquisition paths, named with their bodies

| `SessionStoreDeps` member | Called when | Production body (this slice) | Server route it speaks |
|---|---|---|---|
| `renew(current)` | `forceRefresh` with a **live** `#current` (near-expiry, via the §4 threshold) | **NEW device-proof renewal client** (`createSessionRenewer`, §5): sign a proof over the live session + fresh proof, receive a new 15-min session | **`POST /api/worker-control/session/renew`** — slice 1's route. **This is the production caller `E4-F007`/slice 1 were missing.** |
| `bootstrap()` | `forceRefresh` with `#current === null` (steady-state boot, no session in memory) | the **enrolment code replay** — `Enroller.renew({hello, code, idempotencyKey})` (`enroll.ts:232`), the exact body slice 2b would otherwise have wired to `renew`; recovers a session **while the code route is live** | `POST /api/worker-control/enroll` (unchanged) |

The rename is deliberate and total: today's zero-arg `renew` (code replay) **becomes `bootstrap`**,
and `renew` is repurposed as the device-proof renewal route client. `recover()` (`session.ts:114`)
naturally maps to `bootstrap` (lost-response recovery *is* a code replay from an empty store). The
three docblocks that assert "no sustained renewal exists" (`session.ts:1-31`, `:52-55`, `:96-102`)
move together (§9.1.1(1)).

> **★ Correction to slice 2b §4, on the record (go-book §2.2).** Slice 2b §4:576 says *"WRK-010 slice
> 2 removes this entire subsection [the code read] … its device-proof renewal needs no code at all."*
> That is true of the **sustained renewal path** (`renew(current)`), and it is the important half:
> after bootstrap, a worker renews indefinitely via the route, re-reading the enrolment code **never
> again, at any later time**. It is **not** true of the **bootstrap path**: a steady-state cold boot
> with no live session has only one server mechanism that mints from (device key + no session) — the
> code replay — so `bootstrap` reads the code exactly once, at boot, within the code window, under the
> same lazy/inline/never-aggregated I13 discipline slice 2b §4 items 1-4 specify. The code read is
> confined to cold-boot bootstrap, not "arbitrary later times". §6 and §11 R2 carry the residual.

### 3.2 The gate — the session lifecycle composes on `provider && dispatchEnabled`

`decideDispatchComposition` gates the **poll loop** on four conditions and stays `no_self_model_reader`
until Sprint 3 (§0g). The session lifecycle is a **prerequisite** to the self-model read (the read
needs an authenticated session), so it composes on the two hard gates only:

```ts
// packages/worker-daemon/src/lifecycle/compose-dispatch.ts — NEW pure helper beside the decision.
export function shouldComposeSession(input: {
  provider: SandboxProvider | undefined;
  dispatchEnabled: boolean;
}): boolean {
  return !!input.provider && input.dispatchEnabled;
}
```

* On the **shipped default** (no provider, container or desktop): `false` → **no store, no sink, no
  session in memory**. Enrolment runs exactly as today, `result.session` is dropped, I13 fully intact,
  behaviour byte-identical to the pre-2.5 tree. (§0g; mutant **S2-M9** guards it.)
* On the **desktop root with a provider injected + `AOA_WORKER_DISPATCH_ENABLED=1`**: `true` → compose
  the lifecycle. This is `os_keychain` custody, so the identity store (device key) is present (§0h).
* On the **container**: `provider` is structurally absent (§0h) → `false`. No container composes in
  Sprint 2.5. The `bootstrap` dependency is nonetheless **required** at the type level so a *future*
  container composition cannot forget it (§8, the not-counted type property).

This is strictly weaker than `decideDispatchComposition().compose` (which additionally needs
`hasSelfModelReader && selfModel`), and it must be: the session must exist **before** the self-model
can be read. Sprint 3 composes the poll loop when the full four-gate decision passes, on top of the
store this slice constructs. Both predicates read the same `provider`/`dispatchEnabled`, so they can
never disagree about the first two gates.

### 3.3 What "the route has a production caller" means here — and why it is not compile-clean

`SessionStoreDeps.renew` reaches production only via `store.ensureFresh()`/`forceRefresh()`, driven by
`createPollLoop` — which is **Sprint 3** (§0f). So this slice cannot make a *running* daemon POST to
the renewal route on a near-expiry cadence; that is Sprint 3's poll loop. What this slice delivers,
and why it is genuinely reachable rather than compile-clean:

1. **The boot root constructs the lifecycle when `shouldComposeSession` is true** (§0h: reachable the
   day a real host injects a provider) and wires `renew → renewSession` — production code whose purpose
   is to call the route, not a type that merely lines up.
2. **The boot root eagerly acquires the FIRST session at boot** (`await store.ensureFresh()`, §3.4),
   so first-session acquisition — the sink path (enrolling) and the bootstrap path (steady-state) —
   **runs in production at boot**, not only in a test. The store has a genuine production consumer.
3. **The integration test (§7 Step 8) drives the SAME production composition against a REAL database
   and the REAL route** — enrol → sink → renew(current) → renewed session — proving the renewal
   route is exercised end-to-end through real code, never a fake. §9.1.1's warning applies: a test
   that injects a fake session proves neither transition; this test injects none.

This is one full notch stronger than slice 1 (which had *no* production construction referencing the
route). The honest residual — a running daemon POSTing to the route on a schedule — is Sprint 3's poll
loop, stated in §11 R1 and in the result doc, never hidden.

### 3.4 The boot root, re-ordered (WRK-010 §9.1.1 option (c))

§9.1.1 leaves the executor a choice of three ways to reach the sink; it recommends **(c) compute the
(pure) dispatch decision before enrolment and pass `onSessionMinted` only when the daemon will
compose.** Adopted, because it is the only one that puts **no live token in a boot-scope variable on
refusing boots** (option b's cost) and constructs **no store before enrolment on non-composing boots**
(option a's residue, the thing slice 2b §10 exists to prevent). The new shape of
`bootstrapWorkerDaemon` (`bin/worker-daemon.ts`):

```
config → logger → metrics → health server            (unchanged, :179-244)
  │
  ├─ compose = shouldComposeSession({provider, dispatchEnabled})   ← NEW, pure, BEFORE enrolment
  │
  ├─ IF compose: lifecycle = createWorkerSessionLifecycle({...})   ← NEW (§3.5). renew→renewSession,
  │                                                                  bootstrap→code-replay, initial=null.
  │              onSessionMinted = lifecycle.onSessionMinted        ← store.set, passed to enrolment.
  │  ELSE:       onSessionMinted = undefined                        ← no store, I13 byte-identical to today.
  │
  ├─ enrolment block (:267-324, os_keychain + stores)              ← now passes onSessionMinted (may be undefined)
  │       └─ enrolling boot: sink fires at enroll-once.ts:310 → store.set(session)
  │          steady-state boot: skipped:true, sink never fires (§0d)
  │
  ├─ IF compose: await lifecycle.store.ensureFresh()               ← NEW eager first-session acquisition,
  │              (log expiry; fail-soft on terminal/transient — §3.4.1)   fail-soft (§3.4.1)
  │
  ├─ dispatch = decideDispatchComposition({provider, dispatchEnabled,
  │             hasSelfModelReader:false, selfModel:null})          ← unchanged decision; still no_self_model_reader
  │  if (!dispatch.compose) log(reason)                              in Sprint 2.5. Sprint 3 threads
  │                                                                  lifecycle.store into createPollLoop.
  └─ startup steps → shutdown handler → signal wiring               (unchanged, :351-390)
```

Moving `shouldComposeSession` before enrolment is safe: it is pure over `provider`/`dispatchEnabled`,
both available pre-enrolment. `decideDispatchComposition` stays where it is (its inputs are unchanged
and its `no_self_model_reader` log is preserved). Sprint 3 re-scopes this block at its Step 0 to
thread `lifecycle.store` into the poll loop and flip `hasSelfModelReader` to `true`.

#### 3.4.1 The eager acquisition's failure policy — DECIDED, not inherited (§9.1.1 cost item 5)

`store.ensureFresh()` at boot can end three ways; each is decided here in writing rather than acquired
by proximity to the renewal policy:

* **live session acquired** (enrolling boot: sink-seeded; steady-state within code window: bootstrap)
  → log `{ expiresAt }` (never the token), continue. Sprint 3's poll loop reuses the same live store.
* **terminal** (`SessionStoppedError`/`stopAndBackoff` — code lapsed on the steady-state boot, or the
  authority row is revoked) → the store has already emitted its `reenrollment_required` metric + warn
  (`session.ts:145-155`); the boot root logs `"running idle without a session; re-enrollment
  required"` and **continues** (does not crash), mirroring the enrolment A1 fail-soft philosophy
  (`bin/worker-daemon.ts:295-299`). Sprint 3's poll loop then sees a stopped store and stops cleanly
  (`SessionTerminalError`). This is the honest surface of the residual §11 R2 gap, not a new failure.
* **transient** (network/503) → log `"first session not acquired yet (transient); will retry"`,
  continue. Sprint 3's poll loop retries on its next `provider.get()`.

`bootstrap`'s terminal is the pre-2.5 behaviour (an enroll-route 401 → `stopAndBackoff`); `renew`'s
terminal is decided identically **and for the same reason** — a renewal-route 401 and a code-replay
401 both mean the worker's authority is gone and the only recovery is re-enrolment (§5 maps the route's
coarse 401 to `stopAndBackoff` via `mapErrorStatus`). Both share `forceRefresh`'s existing catch
(`session.ts:133-140`), unchanged.

### 3.5 The lifecycle factory — what Sprint 3 consumes, by name/signature/package

```ts
// packages/worker-daemon/src/identity/worker-session-lifecycle.ts — NEW.
export interface WorkerSessionLifecycleDeps {
  readonly identityStore: DeviceRecordStore<DeviceIdentityRecord>; // os_keychain — the device key source
  readonly client: ControlPlaneClient;   // renew route + bootstrap enroll route
  readonly now: () => number;
  readonly controlPlaneBaseUrl: string;
  readonly enrollmentCodeSource: EnrollmentInputSource; // for bootstrap's lazy code read
  readonly env: Env;                                    // for readEnrollmentInput
  readonly readFileText: (p: string) => string;         // for readEnrollmentInput's {kind:"path"} arm
  readonly platform: string;
  readonly arch: string;
  readonly metrics?: Metrics;
  readonly logger?: Logger;
}
export interface WorkerSessionLifecycle {
  readonly store: SessionStore;                          // Sprint 3 threads this into createSessionProvider
  readonly onSessionMinted: (session: WorkerSession) => void; // the boot root passes this to enrollOnce
}
export function createWorkerSessionLifecycle(deps: WorkerSessionLifecycleDeps): WorkerSessionLifecycle;
```

Internals: derives the device key **lazily** from `identityStore.load()!.privateKeyPkcs8Der` via
`deviceKeyFromPkcs8Der` (lazy because on the enrolling boot the identity is not on disk until
`enroll-once.ts:232` persists it — before the network call — and neither `renew` nor `bootstrap` is
called until after enrolment, §3.4); builds `renew` from `createSessionRenewer` (§5); builds
`bootstrap` from a `frozenDeviceKeyView(key)`-backed `createEnroller(...).renew({hello, code,
idempotencyKey})` mirroring `enroll-once.ts:255-277` (same `buildDesktopHello`, same
`deriveEnrollmentIdempotencyKey`, same lazy `readEnrollmentInput`); constructs `new SessionStore({now,
renew, bootstrap, metrics, logger}, /* initial */ null)`; returns `onSessionMinted: (s) => store.set(s)`.

**Handoff to Sprint 3 (WRK-008 slice 2b), by name — the completeness-critic contract:** slice 2b's
`createWorkerIdentity` (`identity/worker-identity.ts`, its §4 diagram) **calls
`createWorkerSessionLifecycle`** to obtain `{store}`, builds the hello + self-model, and threads
`store` into `createSessionProvider(store)` → `createPollLoop`. This slice builds
`createWorkerSessionLifecycle` (store + `renew(current)` + `bootstrap` + threshold); slice 2b consumes
`.store`. The `renew(current: WorkerSession)` signature and the required `bootstrap` member are exactly
what slice 2b §0.2(A)/§4/§7 clause 20 already say they will consume. No name, signature, or package
below diverges from what slice 2b reads.

### 3.6 Files

| Action | Path | What |
|---|---|---|
| modify | `packages/worker-daemon/src/identity/session.ts` | `SessionStoreDeps.renew(current)` + required `bootstrap`; `export const RENEWAL_HEADROOM_MS`; `ensureFresh` near-expiry threshold; `forceRefresh` `prev !== null ? renew(prev) : bootstrap()`; three docblocks rewritten (§9.1.1(1)) |
| create | `packages/worker-daemon/src/identity/session-renewal.ts` | `createSessionRenewer(deps) → (current) => Promise<WorkerSession>` — the device-proof renewal client (§5) |
| create | `packages/worker-daemon/src/identity/worker-session-lifecycle.ts` | `createWorkerSessionLifecycle` (§3.5) |
| modify | `packages/worker-daemon/src/transport/client.ts` | `SESSION_RENEW_PATH`, `SESSION_RENEW_DESCRIPTOR`, `sessionRenewPath` prop, `sessionRenew(request)` method (reads the `aoa-worker-session` header, unlike `postOperation`) + `sessionRenewTimeoutMs` opt |
| modify | `packages/worker-daemon/src/enrollment/enroll-once.ts` | `EnrollOnceDeps.onSessionMinted?`; fire it at `:310` (`deps.onSessionMinted?.(result.session)`). **`EnrollmentOutcome` unchanged.** |
| modify | `packages/worker-daemon/src/lifecycle/compose-dispatch.ts` | `shouldComposeSession(input)` pure helper (§3.2) |
| modify | `packages/worker-daemon/src/bin/worker-daemon.ts` | option-(c) re-order; compose lifecycle; pass sink; eager first-session acquire (§3.4) |
| modify | `packages/worker-daemon/src/index.ts` | export `SESSION_RENEW_PATH`, `createSessionRenewer`, `createWorkerSessionLifecycle` (+ types), `shouldComposeSession`, `RENEWAL_HEADROOM_MS` |
| modify | `packages/worker-daemon/src/__tests__/session-renewal.test.ts` · `session-revocation.test.ts` · `poll-session-terminal.component.test.ts` | update the **seven** `new SessionStore(` sites for the new `SessionStoreDeps` shape (add `bootstrap`, `renew(current)`) — §9.1.1 cost item 2 |
| modify | `packages/worker-daemon/src/__tests__/enroll-once.test.ts` | keep I13 assertions green; add one sink assertion (mutant **S2-M10**) |
| create | `packages/worker-daemon/src/__tests__/session-renewal-threshold.test.ts` | §4 threshold + invariant + `forceRefresh` routing (S2-M2/M3/M4/M5) |
| create | `packages/worker-daemon/src/__tests__/session-renewer.test.ts` | §5 client with an injected `fetch`/client (S2-M6/M7/M8) |
| create | `packages/worker-daemon/src/__tests__/worker-session-lifecycle.test.ts` | factory wiring: sink→set, renew→renewer, bootstrap→code-replay |
| modify | `packages/worker-daemon/src/__tests__/worker-daemon.bootstrap.test.ts` (existing boot-root test) | option-(c) ordering; sink passed only when composing (S2-M9); eager-acquire fail-soft |
| modify | `packages/worker-daemon/src/__tests__/transport-client.test.ts` (existing) | `sessionRenew` method + header read |
| create | `server/src/__tests__/worker-session-lifecycle.integration.test.ts` | **embedded-PG, cross-package** — S2-A1..A4 against the real route (§7 Step 8) |
| modify | `server/package.json` | add `@armyofagents/worker-daemon` **devDependency** (§0j; verified safe at Step 0, §11 R4) |
| modify | `scripts/check-worker-path-parity.mjs` | add the renewal `PAIRS` entry (`SESSION_RENEW_PATH` ↔ `/worker-control/session/renew`) — the frozen-path guard (S2-M11) |
| modify | `scripts/test-inventory.json` | bump `packages/worker-daemon` **pinned** count (measured at Step 9, §7) |
| modify | `docs/replatform/epics/E4-worker-daemon/findings.md` | E4-F007 **`resolved`**; E4-F012 **`resolved`** (§10) |
| modify | `scripts/finding-ownership.json` | **DELETE** the `E4-F007` key and the `E4-F012` key (§10) — same commits as the status flips |

**No migration. No new table/column. `packages/worker-protocol` is FROZEN and untouched.** The
renewal descriptor is LOCAL (mirroring slice 1's `SESSION_RENEW_DESCRIPTOR` and DAT-008's local
descriptor pattern), so `WORKER_PROTOCOL_OPERATIONS` stays a closed ten (E4-D02).

---

## 4. The near-expiry threshold — a ≥5-minute INVARIANT, not a scheduling preference

`SessionStore.ensureFresh` today refreshes only when the session is absent or already expired
(§0a); the renewal route refuses an expired session (§0b). Pointing `renew` at the route without a
threshold fires it exactly when its credential is dead. Slice 2 adds the threshold:

```ts
// packages/worker-daemon/src/identity/session.ts
/** Renew this many ms BEFORE expiry. ≥5 min is a SECURITY INVARIANT, not a cadence choice:
 *  the authenticator writes the proof-replay row with the PRESENTED session's expiry
 *  (worker-session-auth.ts:153) while a device proof stays skew-valid ±5 min
 *  (worker-device-proof.ts:4); renewing inside 5 min of expiry lets the row lapse while the
 *  proof is still replayable — a window up to ~4.9 min (WRK-010 §3.5(i)). */
export const RENEWAL_HEADROOM_MS = 5 * 60_000; // = 300_000, at the floor deliberately.

async ensureFresh(): Promise<WorkerSession> {
  if (this.#stopped) throw new SessionStoppedError();
  if (this.#current !== null && this.#deps.now() < this.#current.expiresAtMs - RENEWAL_HEADROOM_MS) {
    return this.#current;
  }
  return this.forceRefresh();
}
```

**The invariant is guarded two ways, and only the behavioural one is a mutant** (a bare
`CONST >= 300_000` assertion falsifies nothing a value change could not trivially satisfy — the
"green means nothing" pattern this programme bans):

* **Behavioural (mutation-testable, S2-M2/M3):** a session with **exactly 5 min** of headroom
  triggers `forceRefresh` (→ `renew(prev)`); a session with **6 min** returns live without a refresh.
  Deleting the `- RENEWAL_HEADROOM_MS` term (S2-M2) reddens the first; lowering `RENEWAL_HEADROOM_MS`
  below 5 min (S2-M3) reddens it too (5 min headroom no longer clears the smaller threshold).
* **Security floor (documentation guard):** `expect(RENEWAL_HEADROOM_MS).toBeGreaterThanOrEqual(5 *
  60_000)` and `expect(RENEWAL_HEADROOM_MS).toBeLessThan(DEFAULT_SESSION_TTL_MS)` — the second because
  a headroom ≥ the TTL would renew immediately on every call. Labelled as the §3.5(i) floor.

Renewing at the ⅔-TTL cadence (10 min elapsed, 5 min remaining) sits exactly at the floor: the
replay row outlives the proof, **window zero** (§3.5(i)). The eager boot acquisition (§3.4) plus
Sprint 3's per-poll `ensureFresh` keep a worker at that cadence.

---

## 5. The daemon renewal client — `createSessionRenewer`

Mirrors the enroller (`enroll.ts:146-226`) and the transport's self-model LOCAL-op pattern
(`client.ts:63-84`), for the **renewal** route.

```ts
// packages/worker-daemon/src/identity/session-renewal.ts
export interface SessionRenewerDeps {
  readonly client: ControlPlaneClient;   // needs sessionRenewPath + sessionRenew()
  readonly key: DeviceKey;               // signs the proof (the enrolled device key)
  readonly now?: () => number;
  readonly randomProofId?: () => string; // FRESH per attempt — §11 R3
  readonly randomUuid?: () => string;    // correlationId
}
export function createSessionRenewer(deps: SessionRenewerDeps): (current: WorkerSession) => Promise<WorkerSession>;
```

Per call, it:

1. builds `bytes = Buffer.from(JSON.stringify({protocolVersion:1, audience:"device_session",
   correlationId}))` — the exact `sessionRenewRequestSchema` shape (`worker-session-renewal.ts:59-63`),
   `.strict()`-clean;
2. signs a **fresh** device proof (`signDeviceProof({method:"POST", path: client.sessionRenewPath,
   rawBody: bytes, correlationId, issuedAt: iso(now()), proofId: randomProofId(), key})`) — a fresh
   `proofId` every attempt (§11 R3);
3. POSTs via `client.sessionRenew({bytes, sessionToken: current.token, proofHeaders, requestId:
   correlationId})` — **`current.token` is the Bearer**, which is the whole point of the `(current)`
   parameter (mutant S2-M6);
4. on **200**, reads the new token from the `aoa-worker-session` header and constructs a
   `WorkerSession` with `obtainedAtMs = now()`, `ttlMs = DEFAULT_SESSION_TTL_MS`, `expiresAtMs =
   obtainedAtMs + ttlMs` — **client-clock TTL, mirroring `enroll.ts:202-211`**, so the §4 threshold
   measures now-vs-expiry on one clock (server `expiresAt` is echoed in the body for logging only);
5. maps non-200 with **`mapErrorStatus`** (reused from `enroll.ts:243`): 401 → `unauthorized`
   terminal+`stopAndBackoff`; 400 → `malformed` terminal; 429/503 → `internal_unavailable` retryable
   — exactly the route's coarse-401 contract (§0's route read; S2-M8). Transport failures surface as
   `ControlPlaneTransportError` → a retryable `EnrollmentError("transport", …, stopAndBackoff:false)`,
   as the enroller does (`enroll.ts:177-183`).

`client.sessionRenew` is a **new method** on `ControlPlaneClient`: unlike `postOperation` (which
discards response headers), it must read the `aoa-worker-session` header, so it is shaped like
`enroll` (header-reading) with the dual-auth request of `postOperation` (Bearer + proof). It signs
over `SESSION_RENEW_PATH = "/api/worker-control/session/renew"` (the `/api` mount is part of the signed
contract — `check-worker-path-parity.mjs` pins it, S2-M11).

Throwing an `EnrollmentError` (not a bespoke type) is deliberate: `SessionStore.forceRefresh`'s catch
keys off `EnrollmentError.stopAndBackoff` (`session.ts:133-138`), so both `renew` and `bootstrap`
failures flow through one unchanged policy (§3.4.1).

---

## 6. Where the FIRST session comes from — every boot path the composed daemon takes

The table the go-book Sprint 2.5 prompt demands ("state what happens on a boot that does not
re-enrol"). "Composes lifecycle?" = `shouldComposeSession(provider, dispatchEnabled)` (§3.2).

| Boot path | Composes lifecycle? | First session from | Proven by |
|---|---|---|---|
| **Shipped default** — no provider (container **or** desktop, `AOA_WORKER_SANDBOX_PROVIDER` unset per DEP-010) | **No** | none — no store, no sink, `result.session` dropped exactly as today; **I13 byte-identical to pre-2.5** | boot-root test: `shouldComposeSession=false` ⇒ no store, `onSessionMinted` undefined (**S2-M9**) |
| **Container** (`mounted_secret`), even with the flag on | **No** | none — a provider is structurally impossible in the container root (E4-D01, §0h) | structural (no provider to inject) |
| **Desktop**, provider + flag, **ENROLLING** boot (`os_keychain`, no identity on disk) | **Yes** | the **enrolment SINK** — `enrollOnce` mints, fires `onSessionMinted(session)` at `enroll-once.ts:310`, `store.set` holds it; the eager `ensureFresh` returns it (not near expiry at T0) | **S2-A1** integration + eager-acquire boot-root test |
| **Desktop**, provider + flag, **STEADY-STATE** boot **within the code window** (identity+receipt on disk ⇒ `skipped:true`; code ≤10 min old) | **Yes** | the **BOOTSTRAP** dependency — code replay, code still live; the sink is asserted **not** called | **S2-A3** integration (sink-not-called asserted) |
| **Desktop**, provider + flag, **STEADY-STATE** boot **after the code window** (identity on disk; code lapsed; no persisted session) | **Yes** | **none** — `bootstrap` 401s → `stopAndBackoff` → store stops → `reenrollment_required`; boot logs "running idle … re-enrollment required" and continues (§3.4.1) | lifecycle test: bootstrap 401 ⇒ store stopped; **named non-goal §11 R2** (no session persistence) |

The last row is the honest residual and it is **not** what E4-F007 is about: E4-F007 is "a worker
**near expiry** [holding a live session] has no path to a fresh session" (findings.md:141) — the
sustained-authority case, which `renew(current)` closes. A cold restart days later acquiring a first
session from nothing is a **different** problem (session persistence / re-enrolment), named in §11 R2
and owned by no ticket in this slice's scope. Sprint 2.5 does not claim to solve it; it surfaces it
honestly at boot.

---

## 7. Implementation — bite-sized RED/GREEN steps

Every step: write the failing test → **run it, watch it fail for the stated reason** → minimal
implementation → run it, watch it pass → commit. Each new-code test file **opens with a POSITIVE
CONTROL** (break the function outright; if the suite still passes it exercises nothing — E1-F008).
Mutation rule: **DELETE a guard, never rewrite it to an equivalent** (`return false && false` is
`return false`); print whether the anchor matched (CRLF/indentation have produced three wrong verdicts
here). On Windows the integration file needs `AOA_RUN_WIN_INTEGRATION=1` or vitest renders it green by
skipping (§0j, §11 R5).

```bash
pnpm --filter @armyofagents/worker-daemon test:run
pnpm --filter @armyofagents/worker-daemon typecheck && pnpm --filter @armyofagents/worker-daemon build
AOA_RUN_WIN_INTEGRATION=1 \
  pnpm --filter @armyofagents/server test:run -- src/__tests__/worker-session-lifecycle.integration.test.ts
node scripts/check-worker-path-parity.mjs
node scripts/check-guard-inventory.mjs && node scripts/check-test-inventory.mjs
node scripts/check-finding-ownership.mjs
```

**Step 0 — terrain + boundary check (no code).** Confirm the seven `new SessionStore(` sites (grep),
and confirm `server`→`worker-daemon` devDependency is admissible: run
`node scripts/check-worker-daemon-boundary.mjs` and any image-closure checker, and grep for a guard
asserting `server` may not depend on `worker-daemon` (the parity-checker *comment* says server does
not depend on it — a rationale, not an enforced rule). If a checker forbids the devDep, the fallback is
the top-level `tests/` package (pin-bump). Record the verdict in the result doc. **STOP if a checker
forbids it and no fallback works** (go-book §2.4).

**Step 1 — RED: `SessionStoreDeps` shape + `forceRefresh` routing.** Update the seven test call sites
to the new shape and add `session-renewal-threshold.test.ts`. Positive control first (a `renew` that
always throws ⇒ suite RED). Then: `forceRefresh` with a live `#current` calls `renew(prev)` with that
exact session; with `#current === null` calls `bootstrap()` and never `renew` (S2-M4/M5). GREEN:
change `session.ts` `SessionStoreDeps` + `forceRefresh` line. The bootstrap-required change breaks the
other test files' typecheck — fix all seven sites in this step.

**Step 2 — RED: the near-expiry threshold (§4).** 5 min headroom ⇒ `forceRefresh` fires; 6 min ⇒
live returned; the two invariant assertions. GREEN: add `RENEWAL_HEADROOM_MS` + the `ensureFresh`
subtraction. Mutation: S2-M2 (delete `- RENEWAL_HEADROOM_MS`), S2-M3 (set it to `4*60_000`) — both RED.

**Step 3 — RED: the renewal client (§5), `session-renewer.test.ts`.** With an injected fake
`ControlPlaneClient`: it presents `current.token` as Bearer (S2-M6), signs over
`SESSION_RENEW_PATH` (S2-M7), reads the header into the new session, maps 401→stopAndBackoff /
503→retryable / 400→terminal (S2-M8), and uses a **fresh** proofId per call (S2-M11-adjacent, §11 R3).
Positive control first. GREEN: `session-renewal.ts` + the `sessionRenew` method + `SESSION_RENEW_PATH`
/ `SESSION_RENEW_DESCRIPTOR` on `client.ts`.

**Step 4 — RED: the enrolment sink, `enroll-once.test.ts`.** On the enrolling path, `onSessionMinted`
is invoked once with a `WorkerSession` whose `token` equals `result.session.token`; on the
steady-state (`skipped`) path it is **not** invoked (§0d); **`Object.keys(outcome)` still equals the
`:146-154` allowlist and carries no `session`/`token`** (I13, S2-A4 unit half). GREEN: add
`onSessionMinted?` + the one call at `:310`. Mutation S2-M10: delete the call ⇒ the sink assertion RED.

**Step 5 — RED: the lifecycle factory, `worker-session-lifecycle.test.ts`.** `createWorkerSessionLifecycle`
returns a store whose `renew` reaches `createSessionRenewer` (assert via an injected client that a
near-expiry `forceRefresh` POSTs to the renewal path with the live bearer), whose `bootstrap` reaches
the code replay (assert an empty-store `forceRefresh` POSTs to the **enroll** path), and whose
`onSessionMinted` calls `store.set`. Positive control first. GREEN: write the factory (§3.5).

**Step 6 — RED: the boot root (§3.4), `worker-daemon.bootstrap.test.ts`.** (a) `shouldComposeSession`
false ⇒ no lifecycle, `onSessionMinted` not passed to `enrollOnce`, enrolment behaviour byte-identical
(S2-M9). (b) provider+flag ⇒ lifecycle composed, sink passed, eager `ensureFresh` awaited, expiry
logged, token never logged. (c) eager acquire terminal ⇒ boot logs "re-enrollment required" and does
**not** exit (§3.4.1). GREEN: re-order per §3.4; add `shouldComposeSession` to `compose-dispatch.ts`.

**Step 7 — RED: the parity guard.** Add the `PAIRS` entry to `check-worker-path-parity.mjs`; run it
and watch it PASS only once `SESSION_RENEW_PATH` equals the server route. Then mutate the constant
(S2-M11) and watch the checker go RED; restore. (This guard is the frozen-path property, §11 R3.)

**Step 8 — RED: the embedded-PG integration (the whole point),
`server/src/__tests__/worker-session-lifecycle.integration.test.ts`.** Reuse the slice-1 harness
(embedded PG + tenant setup + ratified placement profile) but stand the app on a real ephemeral HTTP
listener (`app.listen(0)`; `net`-allocated port) and drive the **real daemon lifecycle**
(`createWorkerSessionLifecycle` / `enrollOnce` / `createSessionRenewer`) against
`http://127.0.0.1:<port>`. Positive control: point the renewer at a wrong path ⇒ the renewed-session
case RED. Clauses:

* **S2-A1** — enrolling boot: run `enrollOnce({… onSessionMinted})` against the real enroll route;
  assert the sink fired, `store.current()` holds it, and a route call the authenticator **admits** —
  no fixture session anywhere.
* **S2-A2** — advance the injected daemon clock to within `RENEWAL_HEADROOM_MS` of expiry; call
  `store.ensureFresh()` ⇒ `renew(current)` ⇒ the **real renewal route** ⇒ a second token, `s1 !==
  s0`, `iat` strictly greater, admitted by the same authenticator. **The renewal route's first
  production-code round trip.**
* **A worker crosses T0+15min still authorised** — advance past the original 15-min expiry via S2-A2's
  renewal; assert the renewed session is still admitted (poll or a route call is not 401).
* **S2-A3** — persist identity+receipt, re-enrol within the code window, construct a **fresh** empty
  lifecycle, `ensureFresh()` ⇒ `bootstrap()` ⇒ a session; assert the sink was **not** called.
* **S2-A4** — on the S2-A1 path, assert no emitted log record contains the token and
  `Object.keys(outcome)` equals the allowlist (integration half).

**Step 9 — registers + docs.** Bump `packages/worker-daemon` in `test-inventory.json` to the measured
count (`node scripts/check-test-inventory.mjs` prints the delta). Add the parity `PAIRS` entry (Step
7). Resolve E4-F007 + E4-F012 and delete their manifest keys **in the same commit** (§10). Run all
five registers.

---

## 8. Mutation table

Every mutant is a **deletion or a value change**, never a rewrite-to-equivalent; a positive control
runs first per file; the anchor-match is printed before each run.

| # | Mutant | Killed by | Reachable in prod? |
|---|---|---|---|
| posctrl A | `createSessionRenewer` always throws | renewer suite RED | (control) |
| posctrl B | `ensureFresh` always returns `#current` | threshold suite RED | (control) |
| posctrl C | lifecycle factory returns a no-op store | lifecycle suite RED | (control) |
| **S2-M1** | **delete the sink wiring at the composition root** (`onSessionMinted` not passed to `enrollOnce`) | **S2-A1 RED** — store empty, first route call presents no bearer | **yes — the shipped state today** |
| S2-M2 | delete `- RENEWAL_HEADROOM_MS` in `ensureFresh` | threshold behavioural test RED (near-expiry session not renewed) | yes |
| S2-M3 | set `RENEWAL_HEADROOM_MS = 4*60_000` | threshold + invariant tests RED | yes (opens ~4.9-min replay window, §4) |
| S2-M4 | `forceRefresh` routes `null → renew(null as any)` | bootstrap routing test RED | yes |
| S2-M5 | `forceRefresh` routes `non-null → bootstrap()` | renew routing test RED | yes |
| S2-M6 | `sessionRenew` presents no/blank Bearer | renewer test RED (route 401) + S2-A2 RED | yes |
| S2-M7 | renewer signs over the wrong path | renewer test RED + S2-A2 RED (proof cannot verify) | yes |
| S2-M8 | map route 401 to retryable (not `stopAndBackoff`) | renewer error-map test RED | yes |
| S2-M9 | `shouldComposeSession` returns `true` without a provider | boot-root test RED (lifecycle on the shipped default) | yes |
| S2-M10 | `enrollOnce` omits the sink call at `:310` | `enroll-once.test.ts` sink assertion RED | yes (callee half of S2-M1) |
| S2-M11 | rename `SESSION_RENEW_PATH` off the server route | `check-worker-path-parity.mjs` RED | yes (frozen-path guard) |
| **not counted** | delete `bootstrap` from `SessionStoreDeps` | **TYPE ERROR** (`TS2741`) at every construction site | — |

**The last row is a type-level property, not a killed mutant and not a documented equivalent** — per
WRK-010 §7 Step 6's rule (*"A documented equivalent mutant that does not compile is not an equivalent
mutant"*) and slice 2b §7 row 22's positive form (the typecheck is the proving artifact for a
required-field property). It is counted in **neither** numerator nor denominator; the typecheck is its
artifact. Counting a compile error as a kill inflates the score with something no harness evaluated.

**Numbering note (the aggregation discipline WRK-010 §8 warns about):** slice 1's tally was "8/8".
This slice's mutants are numbered **S2-M1..S2-M11** and are **this slice's own** — they are not added
to slice 1's count. S2-M1 is the same mutant WRK-010 §9.1.1 pre-registered.

---

## 9. Acceptance mapping

| Clause | Test | Tier |
|---|---|---|
| S2-A1 — enrolling boot obtains its FIRST session from the sink | integration `S2-A1` | embedded-PG |
| S2-A2 — then a RENEWED one from **this ticket's route** | integration `S2-A2` (`s1 !== s0`, `iat >`) | embedded-PG |
| a worker crosses **T0+15min** still authorised | integration (renew past the 15-min expiry) | embedded-PG |
| S2-A3 — steady-state boot obtains its first session from **bootstrap**, not the sink | integration `S2-A3` (sink asserted not called) | embedded-PG |
| S2-A4 — I13 holds with the sink wired | `enroll-once.test.ts` (`Object.keys` allowlist) + integration (no token in any log record) | unit + embedded-PG |
| **the route has a production caller** | boot root wires `renew → renewSession` reachably (§3.3); integration drives the real composition against the real route | unit + embedded-PG |
| near-expiry threshold ≥ 5 min (invariant) | `session-renewal-threshold.test.ts` (behavioural + floor) | unit |
| `renew(current)` presents the **live** session as bearer | `session-renewer.test.ts` (Bearer = `current.token`) + S2-A2 | unit + embedded-PG |
| `SessionStoreDeps.renew(current)` + required `bootstrap` (compile-enforced) | `typecheck` (seven sites + the composition) | type-level |
| E4-F007 resolved · E4-F012 resolved | `findings.md` status flips + `finding-ownership.json` keys deleted; `check-finding-ownership.mjs` green | register |

**Tier honesty (WRK-010 §10 R6 applies unchanged).** S2-A1/A2/A3 and the T0+15min clause live in the
embedded-PG integration file, which `describe.skipIf(win32 && !AOA_RUN_WIN_INTEGRATION)` renders green
by skipping on a Windows-local `pnpm test`. The §7 command block carries the prefix; Linux CI runs it
unconditionally. This is a local-verification gap, not a CI one — stated where sign-off happens.

---

## 10. Registers — E4-F007 AND E4-F012 resolve here, keys deleted in the same commit

Both are `open`/`owned`/`WRK-010` at tip (§0i). `evaluateFindingOwnership` computes `openIds` from
findings whose status is exactly `open` (`scripts/lib/finding-ownership.mjs:79-80`) and pushes
`stale_declaration` for **every** manifest key not in that set (`:132-136`); `check-finding-ownership.mjs`
runs in the always-on `policy` job (not `code`-gated). **So a status flip and a key deletion must move
together, in one commit, per finding** — a `resolved` finding whose key survives reddens the required
check; a deleted key whose finding is still `open` is `undeclared_finding`. The task states this
explicitly and it is the same coupling §0e of the slice-1 design proved.

* **`findings.md`** — E4-F007: `Status: open` → `resolved`, with a dated slice-2 addendum in the house
  style (naming the renewal client, the ≥5-min threshold, and the production wiring, and pointing the
  residual cold-restart gap at §11 R2). E4-F012: `Status: open` → `resolved`, addendum naming the sink
  (Change 1) + the `renew(current)`/`bootstrap` split (Change 2) and the I13 argument that the sink is
  not a re-opening (§0c).
* **`scripts/finding-ownership.json`** — **DELETE** the `E4-F007` key and the `E4-F012` key.

After this, the register's only `unowned` entries are the pre-existing E4-F013 (a hole in the guard
itself) and E4-F014 (the DSK-001 doc inaccuracy), both `unowned` by design (go-book §6/§8). No other
finding's status moves.

**E4-F014 note:** its `reason` says the `IdentityLifecycle.acquireSession()` correction is *"already
recorded in the E4-F007 reason above"*. Deleting the E4-F007 key removes that copy. E4-F014 stays
`unowned` and self-contained (it names DSK-001-design.md:351/:431 directly and the real seam
`session.ts:55`), so its accuracy does not depend on the deleted key. Verify `check-finding-ownership.mjs`
green after the deletion — if it objects, the E4-F014 reason is edited to drop the stale cross-reference
(a one-line register edit), not the E4-F007 key restored.

---

## 11. Risks and non-goals

**R1 — the renewal route's repeated production invocation is Sprint 3's poll loop.** `SessionStoreDeps.renew`
reaches the route only via `store.ensureFresh()`, driven by `createPollLoop` (§0f), which this slice
does not compose. This slice makes the route reachable three ways (§3.3): production wiring in the boot
root, an eager first-session acquisition at boot, and a real-DB integration that drives the route end
to end. A *running* daemon renewing on a near-expiry cadence is Sprint 3. Stated in the result doc,
never hidden. This does not block E4-F007's closure: the finding is about the missing **mechanism**
(client + threshold), which this slice delivers and proves; its `ownerStillOpen` names exactly "the
worker-side client plus the near-expiry threshold" as the closure condition.

**R2 — a cold restart after the code window cannot acquire a FIRST session (no session persistence).**
§6's last row. Sessions are held in memory only; a steady-state boot after `CODE_TTL_MS` has neither a
live session (to renew) nor a live code (to bootstrap), so it surfaces `reenrollment_required` at boot
(§3.4.1). This is **not** E4-F007 (which is the near-expiry sustained case) and it is **not** in this
slice's scope; it is session persistence / re-enrolment, owned by no ticket here and named so it is a
decision rather than an omission. Do not claim §6's last row is solved.

**R3 — proof burn + the frozen path.** `recordProof` runs before any authority decision
(`worker-session-auth.ts:148`), so a refused renewal spends its `proofId`; the renewer generates a
**fresh** `proofId` per attempt (a retry with the same one dies as a replay and reads as a revocation
— WRK-010 §10 R1). The renewal path is signed over (`worker-device-proof.ts`), so `SESSION_RENEW_PATH`
is frozen at merge; `check-worker-path-parity.mjs` pins it (S2-M11) instead of a comment.

**R4 — the cross-package devDependency.** `server` gains `@armyofagents/worker-daemon` as a
**devDependency** so the integration test can import the real lifecycle (§0j). It is test-only:
worker-daemon depends on worker-protocol (+ pino), server does not depend on worker-daemon at runtime,
so there is no cycle and no production-image change (DEP-001 checks the *worker* image closure, not the
server's). Step 0 verifies no checker forbids it; the fallback (the `tests/` package) is recorded.

**R5 — guard coverage is embedded-PG, so slower and Windows-skippable.** S2-A1/A2/A3 exercise the real
authenticator through the real route; the unit tier cannot. On Windows a plain `pnpm test` renders the
file green by skipping — five of the acceptance clauses would sign off against a run that evaluated
nothing. The §7 command block carries `AOA_RUN_WIN_INTEGRATION=1`; Linux CI runs it unconditionally.
Local-verification gap, discovered after the push if the prefix is forgotten.

**R6 — the eager boot acquisition adds a boot-time network call on the composing path.** Only on the
`os_keychain` desktop root with a provider + flag (§3.2) — never on the shipped default or the
container. It is fail-soft (§3.4.1): terminal ⇒ idle + `reenrollment_required`; transient ⇒ idle +
retry-on-poll. It cannot crash the daemon or regress the shipped default (S2-M9 guards the gate).

**Non-goals, named with owners:**

| Not delivered | Owner | Why |
|---|---|---|
| The poll loop that drives `ensureFresh` on a cadence | **Sprint 3 (WRK-008 slice 2b)** | §0f, R1. This slice builds the lifecycle it consumes. |
| Session persistence across restarts (the §6 last row / R2 gap) | none in scope | A different problem from E4-F007; named so it is a decision. |
| Rate-limiting the renewal route | DEP-009 follow-up (WRK-010 §9 non-goals) | Every attempt runs a write transaction before any decision; a pre-authority admission problem shaped like poll's. |
| Renewal for a platform PHYSICAL session | slice 1 already refuses it (guard R1) | Out of scope; the route refuses it. |

---

## 12. Rollback

The unit is the composition, not a migration. Roll back by: (1) restoring the E4-F007 + E4-F012 keys
in `finding-ownership.json` and their `open` status in `findings.md` (both directions of the §10
coupling); (2) reverting the boot-root re-order and the `shouldComposeSession` gate so no lifecycle
composes (the shipped default is already that state); (3) reverting `SessionStoreDeps` to the zero-arg
`renew` and dropping `bootstrap`/`onSessionMinted`/`RENEWAL_HEADROOM_MS`; (4) deleting the new modules,
tests, the parity `PAIRS` entry, the `test-inventory` bump, and the `server` devDependency. There is no
table, column, or data to unwind. The slice-1 route remains inert without a caller — exactly its
pre-2.5 state.
