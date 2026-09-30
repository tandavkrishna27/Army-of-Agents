# WRK-010 slice 2 — Result: the renewal route gets its FIRST caller (go-book Sprint 2.5)

**Status:** LANDED. **Sprint 2.5** of the go-book. **Epic:** `E4-worker-daemon`.
**Start SHA:** `9ca53a587` (the design commit). **Commits:** `16c7dc705` onward (threshold+split →
renewal client+parity → sink → lifecycle factory → boot root → integration → registers), plus the
adversarial-review-fixes commit that carries this file.
**RESOLVES — does not merely advance — findings:** `E4-F007` (HIGH) and `E4-F012` (HIGH), status flipped
to `resolved` and manifest keys DELETED in the same commit set.

---

## ★ 0. The headline

Slice 1 shipped a renewal route with **zero production callers, on purpose**. Sprint 3, as originally
sequenced, would have wired `SessionStoreDeps.renew` to the enrolment **code replay** (`Enroller.renew`),
leaving the route caller-less AND the worker still dying at the 10-minute code boundary. **This slice
is what makes slice 1 worth having.** It ships the worker-side half: the device-proof renewal CLIENT,
the near-expiry threshold, and the production session lifecycle the boot root composes — giving the
route a production caller, proven end to end against a real database with the real daemon lifecycle.

The decided mechanism (WRK-010 §9.1.1 — `E4-F012`, DECIDED 2026-08-25) was **adopted verbatim, not
re-derived**: (Change 1) `enrollOnce` gains an optional `onSessionMinted` SINK at the point
`result.session` is dropped — I13-safe because `EnrollmentOutcome` is byte-for-byte unchanged and I13
protects the returned aggregate, not the token's existence in memory; (Change 2) `SessionStoreDeps.renew`
takes `(current: WorkerSession)` and a REQUIRED `bootstrap()` supplies the first session — so `E4-F012`
is a **compile error**, not a review catch.

---

## 1. What shipped

| File | What |
|---|---|
| `identity/session.ts` | MODIFIED. `SessionStoreDeps.renew(current)` + required `bootstrap()`; `RENEWAL_HEADROOM_MS = 5min`; `ensureFresh` near-expiry threshold; `forceRefresh` routes `prev !== null ? renew(prev) : bootstrap()`; three docblocks rewritten. |
| `identity/session-renewal.ts` | NEW. `createSessionRenewer` — the device-proof renewal client. Signs a FRESH proof per attempt, presents the live session as Bearer, reuses `mapErrorStatus` so a route 401 and an enroll 401 share one stop-and-backoff policy. |
| `identity/worker-session-lifecycle.ts` | NEW. `createWorkerSessionLifecycle(deps) → { store, onSessionMinted }` — the production session wiring the go-book moved here from WRK-008 slice 2b. Lazy device-key derivation (the enrolling boot has no identity on disk at construction). |
| `transport/client.ts` | MODIFIED. `SESSION_RENEW_PATH`, `SESSION_RENEW_DESCRIPTOR`, `sessionRenew()` reading the `aoa-worker-session` response header (unlike `postOperation`). |
| `enrollment/enroll-once.ts` | MODIFIED. `EnrollOnceDeps.onSessionMinted?`; fired at `:310`. **`EnrollmentOutcome` UNCHANGED** (frozen, 7-key allowlist, no session/token). |
| `lifecycle/compose-dispatch.ts` | MODIFIED. `shouldComposeSession(provider, dispatchEnabled)` — the WEAKER session-lifecycle gate. |
| `bin/worker-daemon.ts` | MODIFIED. Option (c): decide before enrolment, construct the lifecycle when the daemon will dispatch, pass `onSessionMinted` only then (I13 byte-identical on the shipped default), eagerly acquire the first session (fail-soft). |
| `index.ts` | MODIFIED. Exports the new symbols + `RENEWAL_HEADROOM_MS`. |
| `scripts/check-worker-path-parity.mjs` | MODIFIED. The frozen renewal-path `PAIRS` entry. |
| `scripts/test-inventory.json` | MODIFIED. `packages/worker-daemon` pin 132 → 136 (4 new test files). |
| `server/package.json` | MODIFIED. `@armyofagents/worker-daemon` **devDependency** (test-only; not in the control-plane runtime closure). |
| `server/src/__tests__/worker-session-lifecycle.integration.test.ts` | NEW. Embedded-PG, real daemon lifecycle vs the real route over a real HTTP listener. |
| `packages/worker-daemon/src/__tests__/*` | NEW: `session-renewal-threshold`, `session-renewer`, `worker-session-lifecycle`, `worker-session-boot`. MODIFIED: the 7 `SessionStore` sites, `enroll-once` (sink), `compose-dispatch` (`shouldComposeSession`). |
| `findings.md` + `finding-ownership.json` | MODIFIED. E4-F007 + E4-F012 → `resolved`; both keys DELETED; E4-F014's stale cross-reference fixed. |

## 2. Acceptance mapping

| Clause | Test | Tier |
|---|---|---|
| S2-A1 — enrolling boot obtains its FIRST session from the sink | integration `S2-A1` (real enrol → sink → `store.current()`) | embedded-PG |
| S2-A2 — then a RENEWED one from **this ticket's route** | integration `S2-A2` (`store.forceRefresh()` → real route, `s1 !== s0`, `iat`/`exp >`) | embedded-PG |
| a worker crosses **T0+15min** still authorised | integration (advance past s0's expiry; renew s1 → s2) | embedded-PG |
| S2-A3 — steady-state boot obtains its first session from **bootstrap**, not the sink | integration `S2-A3` (sink asserted not called; code replay recovers) | embedded-PG |
| S2-A4 — I13 holds with the sink wired | `enroll-once.test.ts` (allowlist, no token) + integration (no token in outcome) | unit + embedded-PG |
| the route has a production caller | boot root wires `renew → renewSession`; integration drives the real composition against the real route | unit + embedded-PG |
| near-expiry threshold ≥ 5 min (invariant) | `session-renewal-threshold.test.ts` (behavioural boundary + floor) | unit |
| `renew(current)` presents the LIVE session as Bearer | `session-renewer.test.ts` + integration | unit + embedded-PG |
| `renew(current)` + required `bootstrap` (compile-enforced) | typecheck (7 sites + composition) | type-level |
| E4-F007 + E4-F012 resolved | findings.md status + keys deleted; `check-finding-ownership.mjs` green | register |

**SIX+ clauses have the embedded-PG suite as their only evidence**, and that suite is
`describe.skipIf(win32 && AOA_RUN_WIN_INTEGRATION !== "1")` — a plain Windows `pnpm test` renders it
GREEN by skipping. Run it with `AOA_RUN_WIN_INTEGRATION=1`; Linux CI runs it unconditionally. A
local-verification gap, not a CI one.

## 3. Mutation table — 12 mutants, 11 killed + 1 type-level property, 0 survivors

Every mutant a DELETION or value change (never rewrite-to-equivalent); anchor-match printed; a positive
control ran first per file.

| # | Mutant | Killed by | Reachable in prod? |
|---|---|---|---|
| posctrl A/B/C | throwing renewer / always-return-current / no-op lifecycle store | each suite RED | (control) |
| S2-M1 | delete the sink wiring at the composition root | S2-A1 RED (store empty) | yes (shipped state today) |
| S2-M2 | delete `- RENEWAL_HEADROOM_MS` in `ensureFresh` | threshold behavioural test RED | yes |
| S2-M3 | `RENEWAL_HEADROOM_MS = 4min` | invariant floor test RED | yes (opens ~4.9-min replay window) |
| S2-M4 | `forceRefresh` routes null→renew | routing test RED | yes |
| S2-M5 | `forceRefresh` routes non-null→bootstrap | routing test RED | yes |
| S2-M6 | renewer presents a blank Bearer | renewer test RED | yes |
| S2-M7 | renewer signs over the wrong path | **integration** RED (server 401) | yes |
| S2-M8 | map route 401 to retryable | renewer error-map test RED | yes |
| S2-M9 | `shouldComposeSession` true without a provider | boot-root test RED | yes |
| S2-M10 | `enrollOnce` omits the sink call | `enroll-once` sink test RED | yes |
| S2-M11 | rename `SESSION_RENEW_PATH` off the server route | `check-worker-path-parity.mjs` RED (exit 1) | yes (frozen-path guard) |
| **not counted** | delete `bootstrap` from `SessionStoreDeps` | **TYPE ERROR** at every site | — (type-level property; typecheck is the artifact) |

Deleting `bootstrap` is a compile error at every construction site — under this programme's rule (a
documented equivalent that does not compile is not an equivalent) it is counted in **neither** the
numerator nor the denominator; the typecheck is its artifact. Numbering is **this slice's own**
(S2-M1..M11) — slice 1's "8/8" does not move.

## 4. The adversarial review

**5 independent dimension reviewers + a completeness critic + a refutation skeptic + an independent
`codex` pass.** Reviewers verified claims against source by opening files.

**0 HIGH/BLOCKING.** Clean dimensions: **I13/the sink** (the outcome is unchanged; no token reaches a
log line or a returned aggregate on any path, including the eager-acquire and fail-soft catches);
**the renewal client + wire contract** (body shape, proof path, Bearer, error mapping, TTL, and
fresh-proofId all match the slice-1 route exactly — no security window); **the boot-root gate**
(shipped-default inertness byte-identical; the lifecycle is genuinely reachable when a provider is
injected; eager-acquire fail-soft is correct). The completeness critic confirmed the seam Sprint 3
consumes matches by name/signature/package and found **no hidden zero-caller defect**.

**One MED, refuted.** A reviewer read a latent production "recovery regression": that `forceRefresh`
routing a non-null-but-server-rejected session to `renew` (which 401s) would STOP where the old
code-replay recovered, and that the migrated `poll-session-terminal` test greenwashes it. A skeptic
and independent analysis **refuted the live-regression core**: with a constant clock offset the
client-live and server-expiry windows coincide (a >5-min offset breaks the device proof on EVERY
operation, so the daemon never holds a session to regress); worker sessions are stateless HMAC JWTs
with no server-side "drop" mechanism other than expiry/revocation; and — decisively — a session is
always obtained at-or-after the code is issued, so with `CODE_TTL=10min < SESSION_TTL=15min` a truly
expired session ALWAYS has an already-lapsed code, making `renew` and `bootstrap` **stop identically**.
The poll loop is **not composed in production at this tip** (Sprint 3), so nothing live exercises the
divergence. What survived is a **forward-looking test-fidelity note for Sprint 3**, addressed below.

**Applied fixes (LOW):** (1) the migrated `poll-session-terminal` / `session-renewal` tests wire
`renew` to the code-replay body — faithful to the PRE-Sprint-3 recover semantics but divergent from
the device-proof route Sprint 3 composes; a header note now flags that Sprint 3 must re-baseline those
recovery cases when it wires the real renewer (the go-book's D1 re-baselining). (2) `findings.md`'s
E4-F014 section referenced the deleted `E4-F007` manifest key — repointed to the resolution section
(the exact two-copies rot E4-F014 is about). (3) a `session.ts` docblock line cite corrected. (4) the
`bin/worker-daemon.ts` "FIRST production caller" comment softened to match the finding's Sprint-3-driver
disclosure. (5) a dedicated `shouldComposeSession` unit test added (it had only behavioural coverage).

**The independent `codex` pass** raised the same two points and no others: (i) the renewal route is
wired + integration-proven but not DRIVEN by a running Sprint-2.5 process (the disclosed Sprint-3
poll-loop driver — see §5); (ii) the expired→renew routing (refuted above). Neither survived as a
defect.

## 5. What this does NOT claim / the honest residuals

- **The route's repeated near-expiry renewal in a RUNNING process is Sprint 3's poll-loop driver.**
  `SessionStoreDeps.renew` reaches the route only via `store.ensureFresh()`, driven by `createPollLoop`
  (zero production callers until Sprint 3). This slice makes the route reachable three ways — production
  wiring in the boot root, an eager first-session acquisition at boot, and a real-DB integration that
  drives the route end to end — but a shipped Sprint-2.5 daemon's single eager `ensureFresh` hits the
  sink (enrolling) or bootstrap (steady-state), never the renewal route. This does not block E4-F007's
  closure: the finding is the missing MECHANISM (client + threshold), which is built, wired, and proven.
- **Sprint 3 must hoist `lifecycle` and re-scope its Step 0** (completeness GAP-1). `lifecycle` is a
  block-scoped `const` inside the `os_keychain` enrolment block; Sprint 3 threads `lifecycle.store` into
  `createSessionProvider` → the poll loop, which requires hoisting the declaration or moving the
  composition. The go-book already schedules this ("Sprint 3's §4 and Step 2 re-scope at Step 0"); named
  here so the Sprint 3 implementer is not surprised. Sprint 3 also re-derives the device key + hello via
  the exported `deviceKeyFromPkcs8Der` + `buildDesktopHello` (the lifecycle surfaces only `store`).
- **A cold restart AFTER the code window cannot acquire a FIRST session** (§11 R2). No live session, no
  live code, sessions not persisted → re-enrolment required; the boot logs it and runs idle (fail-soft).
  This is a session-persistence concern, DIFFERENT from E4-F007, owned by no ticket in this scope.
- **Refusals collapse to two operator log classes** (inherited from slice 1's authenticator reuse).

## 6. Registers + CI

All five registers pass, plus `check-test-inventory` (pin 132→136), `check-worker-path-parity` (2 pairs,
exit 1 on a mutated path), `check-image-deps-stages` (the server devDep is NOT in the runtime closure —
`image-deps-stage.mjs` reads `dependencies` only), and both worker-boundary checkers. `check-finding-ownership`
green with E4-F007 + E4-F012 resolved and their keys gone (10 open findings; E4-F013/F014/F015 unowned by
design). Typecheck clean; the full worker-daemon suite is green.

**`verify` is RED on this branch for reasons that PREDATE Sprint 2.5** (go-book §2.0: the job hit its
60-minute cap on five consecutive runs, on SHAs pushed before any Sprint-0 commit). The timeout was NOT
raised to make it green — that would convert a regression into a permanently slower gate and hide its
cause. Sprint 2.5's own code is green; its definition of done inherits the pre-existing `verify` red,
stated out loud here per §2.0.
