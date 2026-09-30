# DAT-008 slice 5 — Result: the worker redeems the handle, synthesises the sandbox env, seeds per-run canaries

**Status:** LANDED. **Epic:** `E5-workspaces-secrets`. **Sprint:** 4.
**Design:** [`DAT-008-slice-5-design.md`](./DAT-008-slice-5-design.md) (Start SHA `bc288f004`).
**Implementation:** `644e40e91`. Line references are to `docs/replatform-program` at that SHA.
**Closes:** M2 + M7 (parent §3). **Promotes:** `E5-5-redaction` → `wired`.

---

## 1. What landed

| Piece | Where |
|---|---|
| The LOCAL resolve op on the daemon client (`EXECUTION_SECRET_RESOLVE_PATH`, descriptor, `resolveExecutionSecret`) | `transport/client.ts`; path pinned by `check-worker-path-parity.mjs` (4 pairs) |
| Response classifier + provider-auth allowlist + `synthesiseRunSecrets` + bounded redeemer | `lease/secret-redemption.ts` (new) |
| The supervisor redeems under a deadline, seeds per-run canaries before create, fails CLOSED | `supervisor/supervisor.ts` (`createSpecFor` env-fed; `runLifecycle`) |
| The per-lease canary coordinator | `supervisor/run-canaries.ts` (new) + `lease/lease-renewal.ts` (proxy shares it) |
| Composition behind the default-OFF flag | `lifecycle/dispatch-runtime.ts` |
| `E5-5-redaction` promoted to `wired` (symbol re-pointed) | `scripts/gate-clause-wiring.json` |

**M2 closed:** `createSpecFor` no longer returns `env: {}` — it returns the redeemed provider-key
map. **M7 closed:** every redeemed value is a per-run redaction canary, seeded before `provider.create`
into an array both the supervisor's lifecycle `EventSequencer` and the per-lease `FenceCloseProxy`
capture, so redaction is uniform across both streams.

## 2. Acceptance — every clause to a test that can turn RED

| # | Clause | Test | State |
|---|---|---|---|
| A1 | The sandbox env carries the redeemed key | `supervisor-secret-materialization.test.ts` "reaches the create spec env" | ✅ |
| A2 | A denied redemption fails CLOSED (no sandbox, failed terminal) | same file, "DENIED redemption fails CLOSED" | ✅ |
| A3 | A hanging redemption is cut by the budget, fails closed | "HANGING redemption is cut by the budget" | ✅ |
| A4 | An unknown env target fails the run (never dropped) | `secret-redemption.test.ts` "UNKNOWN target fails the run" | ✅ |
| A5 | Denial-as-200 is never mistaken for success | "the 200-for-denial gotcha" (5 cases incl. empty value/envTarget) | ✅ |
| A6 | Redeemed value redacted from the lifecycle stream | "REDACTED from the lifecycle stream" + anti-vacuity control | ✅ |
| A7 | …and from the fence-close proxy stream | "proxy redaction via the shared coordinator array" + driver-wiring test + controls | ✅ |
| A8 | Canaries are per-run, no cross-lease bleed | "canaries are PER-RUN, no cross-lease bleed" | ✅ |
| A9 | Canary seeded before create | "seeds the canary BEFORE create" (in-flight assertion) | ✅ |
| A10 | resolve happens once per handle | "each exactly once" + createRedeemer "exactly ONE call" | ✅ |
| A11 | Denial never retried; transport retried once | createRedeemer denied/transport tests | ✅ |
| A12 | Frozen wire untouched | no `packages/worker-protocol/` edit | ✅ |
| A13 | Daemon imports only protocol+pino | `worker-daemon-boundary` (E4-D01) | ✅ (see §7 CI) |
| A14 | Path parity holds | `check-worker-path-parity.mjs` OK (4 pairs) | ✅ |
| A15 | Inert while dispatch off | flag off ⇒ no supervisor ⇒ no redemption | ✅ |
| A(int) | Worker redeem client round-trips the REAL route; fails closed on the fence-first denial | `server/src/__tests__/execution-secret-resolve-worker.integration.test.ts` (embedded-PG, 2 tests, Windows-run w/ `AOA_RUN_WIN_INTEGRATION=1`) | ✅ |

## 3. The mutation line

**Every guard mutation-proven by DELETION; a positive control ran first on each module.** Killed:

| Mutant | Guard deleted | Test turned RED |
|---|---|---|
| fail-open | BOTH fail-closed throws in `synthesiseRunSecrets` (the WORST defect class) | A2 denied + transport synthesise |
| M5 | the provider-auth allowlist throw | A4 |
| M2 | the non-empty value/envTarget checks | A5 empty-value cases |
| M12 | the supervisor's per-run seed (`runCanaries.push`) | A6 lifecycle redaction |
| M4 | the durable terminal on redemption failure | A2 terminal assertion |
| M14 | the coordinator's per-lease keying (shared one array) | A8 cross-run bleed |
| M13 | the driver's use of the coordinator in `makeProxy` | A7 driver-wiring |
| M8b | the retry bound (loop cap + `attempt===0` guard, as a PAIR) | A11 "exactly TWO calls" |

**One documented equivalent, proven equivalent by the pair rule (go-book §2.2):** raising the retry
loop cap ALONE (`< 2` → `< 3`) survived, because the `if (attempt === 0) continue` guard still
returns `transport` on the second attempt. Breaking BOTH the cap and the guard killed A11 — the two
are mutually backstopping, and the retry-once bound is real.

## 4. Corrections to the design, made while building

1. **`createSpecFor` stays SYNCHRONOUS; redemption moved to `runLifecycle`.** The plan (from the
   parent's R6) said "`createSpecFor` becomes async." Making the redemption a separate step in
   `runLifecycle` (before building the `EventSequencer`, feeding `createSpecFor(handoff, labels,
   env)`) is cleaner: the fail-closed terminal + `escalateCleanup` machinery already lives there, so
   a redemption failure reuses the create-failure path with no duplicated terminal logic. The R6
   PROPERTY holds — redemption is bounded by `secretRedeemDeadlineMs` (clamped to `createDeadlineMs`)
   and the create budget is reduced by the elapsed redemption time.
2. **No `AOA_WORKER_SECRET_REDEEM_TIMEOUT_MS` switch was added (design Step 6 said it would be).**
   The redemption deadline is a fixed 5s supervisor default, carved from the create budget. Making it
   an operator-tunable `AOA_WORKER_*` switch adds an env-map path and a brand-check-doc obligation for
   marginal value; the fixed default is sensible and the seam (`secretRedeemDeadlineMs` dep) is
   trivially wired to config later if an operator needs it. **No new `AOA_*` switch ⇒ no
   `environment-variables.md` change and no brand-check exposure.** Recorded here per go-book §2.2
   (trust the disk and say so).
3. **The fail-closed is TWO-LAYER** in `synthesiseRunSecrets` (the `kind !== "resolved"` throw AND
   the `envTarget !== target` throw). A denied outcome carries no `envTarget`, so even without the
   kind-check the mismatch check throws — good defense in depth, and the reason the fail-open mutant
   had to delete BOTH throws to redden a test.

## 5. `E5-5-redaction` promotion — the evidence

Re-pointed the clause's symbol from `createFenceAwareEgressProxy` (the DAT-005 **egress** proxy of
Direction B, which DAT-008's Direction A never uses — it had zero callers and always would on this
path) to **`synthesiseRunSecrets`**, the worker function that redeems the handle and returns the
values that become per-run canaries. `check-gate-clause-wiring.mjs --counts` reports **1** production
caller (`composeDispatchRuntime`, behind the default-OFF flag) — the first the redaction input has
ever had. Promoted to `wired` on that reference PLUS a planted-leak proof on BOTH streams (a seeded
secret in a lifecycle log and in a fence-close `network_denied` is scrubbed to the marker; an unseeded
control leaks it verbatim). The wiring checker reads caller count, not the reason field (go-book §6),
so the honest residual lives in the tests, not the field: **a real sandbox authenticating over live
E2B is Sprint 5** (parent §9 limit 3).

## 6. Slice 7

DEFERRED. See [`DAT-008-slice-7-result.md`](./DAT-008-slice-7-result.md) — the distributed path has
no warm-resume mechanism to attach to, and the one live warm-lease lifecycle is the legacy #320
server substrate, not the distributed path DAT-008 targets.

## 7. Adversarial review — four independent reviewers + a completeness critic

Each reviewer opened source and reported only what it verified. **No HIGH or BLOCKING finding on any
dimension**, so no refutation skeptic was needed. Everything below was fixed in the review-fixes
commit; the fixes are themselves tested.

- **Security / fail-closed / redaction — 0 HIGH/MED.** Traced every classifier branch, the
  fail-closed throws, the supervisor no-create-on-failure, seed-before-emit, and confirmed no
  redeemed value reaches a log or event. **1 LOW (fixed):** the `supervisor.ts` per-run-array comment
  claimed `deps.redactionCanaries` was a "prefix" on the coordinator path, which it is not (the
  coordinator's array is used by reference; a merge would break the sharing). Comment corrected to
  say so and to direct a future maintainer to pre-seed the coordinator array instead. Inert today
  (production passes `[]`).
- **Composition / wiring / R6 / concurrency — 0 HIGH/MED.** Confirmed ONE shared coordinator reaches
  both consumers; the fence fields are correct (`offer.workerId` is top-level, `job.jobId/attempt/
  secretHandles` nested — the `offer.workerId` vs `job.workerId` trap is avoided); R6 is genuinely
  *subtracted* from the create budget, never added, with no negative/unbounded budget; per-run
  `env`/`runCanaries`/`secretElapsedMs` are function-local so **concurrent runs cannot bleed**; and
  the whole thing is byte-identical when `materializeRunSecrets` is absent. One pre-existing/inert
  context note (the dual-`EventSequencer` `seq` numbering, a WRK-008-2b artifact, unreachable until
  the egress seam is wired) — not a slice-5 finding.
- **Completeness critic — 0 HIGH/MED.** Verified the seam **matches what Sprint 5 consumes, by name,
  signature and package**: `job.secretHandles` (server `job-leasing.ts` ↔ worker `dispatch-runtime.ts`)
  → `synthesiseRunSecrets` → `createSpecFor(spec.env)` → `E2bSandboxProvider.create(envVars)` →
  `RealE2bTransport.create(envs)`, under the SAME env-var names (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`
  == the catalog `apiKey.envVar`). Confirmed `E5-5` promotion is honest (composition + planted-leak,
  residual disclosed) and the slice-7 defer is real (zero `resume`/`restore` production callers).
  Notes: the disclosed missing-env-var (§4.2), and that the worker allowlist tracks the catalog by
  an **assertion** (`secret-redemption.test.ts`), not a live import (E4-D01 forbids importing the
  catalog into the daemon) — acceptable, worth knowing if those two catalog vars are ever renamed.
- **Contract / boundary / parity — production contract SOUND** (path, request schema, descriptor,
  E4-D01 boundary, frozen wire all verified clean). **1 MED (fixed):** the embedded-PG integration
  test *over-advertised* — it asserted a `denied` outcome, but the route collapses an auth failure and
  a fence failure into the SAME `200 denied/malformed` (a no-oracle property), so the assertion could
  not tell "proof verified, fence denied" from "proof failed" (the E1-F008 refusal-without-a-positive-
  control trap). **Fixed** by adding a positive + negative control that verifies the captured request
  server-side: the worker's device proof VERIFIES over the resolve path and is **path-bound** (the
  same proof over a different path is refused), and by pinning the redeemer's clock so the round-trip
  genuinely exercises a *verified* proof. **2 LOW (fixed):** the request-body unit test used
  `toMatchObject` (an extra field would 400 the `.strict()` server while staying green) → added an
  exact-keys assertion; and only the path was cross-checked → extended `check-worker-path-parity.mjs`
  to numerically cross-check the descriptor (`maxRequestBytes`/`timeoutMs`) too (drift detection
  self-verified: daemon 8192 vs server 4096 → FAIL).

## 8. Claims I could not prove

- **A real sandbox authenticating to the model provider over live E2B.** Slice 5 delivers the value
  into `CreateSandboxSpec.env` and the real E2B transport forwards it as `envs`; whether the
  in-sandbox `claude`/`codex` process actually authenticates with it is an E2B-runtime property no
  mock can prove. This is the residual the `E5-5` reason and parent §9 limit 3 already name — **it is
  Sprint 5's journey (E7 / CLI-006)**. The `resolved`-path value return itself is proven only at unit
  level (the classifier + `admitSandboxLocalResolution` returning the value + the supervisor threading
  it to `create`), because a full lease→resolved fixture needs an active fence + secret store; the
  integration test proves the wire + the fail-closed denial + the proof-over-path binding, not a live
  `resolved`.
- **The env-var name stays in sync with the provider catalog by ASSERTION, not by type.** E4-D01
  forbids the daemon importing `provider-catalog.ts`, so `PROVIDER_AUTH_ENV_TARGETS` is vendored and
  pinned by a membership test. If the catalog ever renames `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, the
  daemon allowlist would not auto-follow.

## 9. Verification (local) & CI

**Local:** `tsc -p packages/worker-daemon` + `tsc -p server` clean. Full worker-daemon vitest suite
**824 passed** (139 files); the two new unit files (33 tests) + the server embedded-PG integration
(3 tests, run on Windows with `AOA_RUN_WIN_INTEGRATION=1`) green. All five registers + worker
path-parity (4 pairs, now incl. the descriptor cross-check) + test-inventory (146) green.

**CI — PR run `32942379969`, SHA `39dc8c293`.** Every job green **except `verify`**, which inherits
the pre-Sprint-4 red documented in §2.0 (a `verify`-timeout regression that predates Sprint 0 — the
bisect is not this sprint's work, and its timeout was NOT raised to mask it):

| Job | | Job | |
|---|---|---|---|
| `changes` | ✅ | `e2e` | ✅ |
| `policy` | ✅ | `e2e-pgvector` | ✅ |
| `brand-check` | ✅ (no undocumented `AOA_*`) | `migrations` | ✅ |
| `lint` | ✅ | `browser` | ✅ |
| `distributed-contract` | ✅ | `worker-protocol-contract-bytes` (ubuntu + windows) | ✅ (frozen wire untouched) |
| `verify` | ⏱ inherits the §2.0 red | `ci-required` | red *because* `verify` is required |

`worker-protocol-contract-bytes` green on both platforms confirms "no protocol change" is verified,
not asserted. The two new unit files run inside `verify` on Linux; because `verify` times out
(§2.0), their Linux CI pass is not observable there — they are proven locally (Windows + embedded-PG
integration with `AOA_RUN_WIN_INTEGRATION=1`), and the `policy` green proves every register + the
path/descriptor parity guard pass in CI.

