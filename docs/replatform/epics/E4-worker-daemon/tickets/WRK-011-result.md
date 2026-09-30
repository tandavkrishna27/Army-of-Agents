# WRK-011 — Result: a provisioned worker can be OFFERED work and can ACCEPT it (go-book Sprint 2.75)

**Status:** LANDED. **Sprint 2.75** of the go-book. **Epic:** `E4-worker-daemon`.
**Start SHA:** `ee6816db7` (the §5.2 decision commit — go-book §8 **D-5**, taken before any code).
**Commits:** `5c10a0f32 … 785f715a1` (Step 0 → four guards → server route+txn → daemon half →
batch-journey alignment → M11 strengthening → adversarial-review fixes A8/A6/codex-M2), plus the
commit that carries this file (which also RESOLVES `E4-F010` and files the new LOW `E4-F016`).
**RESOLVES — does not merely advance — finding:** `E4-F010` (HIGH), status flipped to `resolved`
and its manifest key DELETED in the same commit. **FILES:** `E4-F016` (LOW) with its own manifest key.

---

## ★ 0. The headline

Before this sprint, every worker the programme could produce was **unmatchable on three independent
axes** and would refuse an offer on a fourth — the steady state E4-F010 named. WRK-011 gives a worker
that already holds a live session and its enrolled device key a way to present a **refreshed hello**
to a new **local** route (`POST /api/execution-targets/self/hello`); if that hello stays inside the
administrator-ratified ceiling, `profile_snapshot`, `profile_hash` and a **fresh session** move
**inside one transaction** — the mint before commit, so a mint throw rolls the UPDATE back. The daemon
builds that hello from the WRK-008 slice-1 self-model read, giving that route its **first production
caller path** (`client.selfHelloRefresh()` + `deriveHelloProvisioning`). **No migration, no new column,
no frozen-contract change.**

The §5.2 decision was taken **before Step 1** and recorded as go-book §8 **D-5**: option **(a)** — the
**target is the unit of admin intent**, plus a structured audit record (`action: "worker.hello.refreshed"`).
The shipped admission function has exactly **four** guards and `refreshWorkerProfile` writes **no
activation column**, i.e. option (a) is the decision of record; option (b)'s fifth guard + column +
migration (L→XL) was rejected.

---

## 1. What shipped

| File | What |
|---|---|
| `server/src/services/worker-hello-refresh-admission.ts` | NEW. The PURE decision: G1 identity (3 arms), G2 capability-ceiling **SUBSET** (refuse-not-clamp), G3 policy coherence, G4 idempotency; `helloRefreshRefusalWireCode` collapses every reason to `unauthorized` (exhaustive `switch`, mirrors the renewal admission). Produces the canonical digest via an injected `digestOf`. |
| `server/src/services/worker-hello-refresh.ts` | NEW. Local `selfHelloRequestSchema` (composes the FROZEN `workerHelloV1Schema`; TS2589-flattened cast, runtime validation intact), `SELF_HELLO_DESCRIPTOR` (64 KiB / 15 s), `digestHello` (= `sha256(JSON.stringify(zod-parsed hello))`, byte-identical to `worker-enrollment.ts:409`), and `createWorkerHelloRefreshService` — the atomic triple: `runInTenant` → `refreshWorkerProfile` → mint **inside** the tx, after the update. |
| `server/src/routes/execution-targets.ts` | MODIFIED. One route inside the existing `if (opts.workerSession)` region; layer-0 legacy-token refusal; size guard; ratified-profile load; D-5 structured audit line; the session on the `aoa-worker-session` response header. |
| `packages/db/src/repositories/tenant/worker-enrollment.ts` | MODIFIED. `refreshWorkerProfile` — writes **both** `profile_snapshot` + `profile_hash` (+ `updated_at`) in one UPDATE, compare-and-set on `expectedProfileHash`, touches nothing else. |
| `packages/worker-daemon/src/enrollment/desktop-hello.ts` | MODIFIED. Optional `provisioning` input + `HelloProvisioning` type; ABSENT ⇒ byte-identical to the DSK-001 unprovisioned hello; capabilities sorted for replay stability. |
| `packages/worker-daemon/src/enrollment/hello-provisioning.ts` | NEW. `deriveHelloProvisioning` folds a self-model response into `HelloProvisioning`, intersecting the ratified ceiling with what the device can provide (fail-toward-absent, D4); `SUPERVISABLE_WORKLOAD_CAPABILITIES`. |
| `packages/worker-daemon/src/transport/client.ts` | MODIFIED. `SELF_HELLO_PATH`, `SELF_HELLO_DESCRIPTOR`, `selfHelloRefresh()` (reads the response session header, like `sessionRenew`). |
| `packages/worker-daemon/src/index.ts` | MODIFIED. Exports the new symbols (Sprint 3 consumes them). |
| `scripts/check-worker-path-parity.mjs` | MODIFIED. Third `PAIRS` entry (self-hello refresh). |
| `scripts/test-inventory.json` | MODIFIED. `packages/worker-daemon` pin 136 → 137 (one new daemon test file). |
| `server/src/__tests__/desktop-disabled.negative.test.ts` | MODIFIED. Source-scan dormancy clause for the new route. |
| `tests/fixtures/worker-provisioned-target.json` | NEW. The shared ratified profile pair + a REAL captured `LeaseOffer` (Step 7 → Step 8c). |
| `server/src/__tests__/worker-hello-refresh-admission.test.ts`, `…worker-hello-refresh.test.ts`, `…worker-hello-refresh.integration.test.ts`, `packages/worker-daemon/src/__tests__/hello-provisioning.test.ts`, `…desktop-hello.test.ts` | Tests. |

## 2. Acceptance mapping

| Clause | Test | Tier |
|---|---|---|
| A provisioned worker IS OFFERED work | integration A1: `no_work` precondition → refresh → `outcome:"offer"` through the **real `poll` service** | embedded-PG |
| The daemon's self-check ADMITS that offer | `hello-provisioning.test.ts` Step 8c: `offerSatisfiesWorker` over the CAPTURED offer (true), + unprovisioned negative control (false) | unit + shared fixture |
| Both columns move together | A1 re-derives the digest the `job-placement.ts:543` way (parse-first); M9/M10 | embedded-PG |
| A refresh returns a usable session and the old one dies | A1 (session verifies, new hash) + old-hash poll `rejects target_revoked`; A8 (HTTP header verifies); M12 | embedded-PG |
| A failed mint leaves no committed refresh | A3 throwing-signer, row byte-identical; M13 | embedded-PG |
| A worker cannot claim an ungranted capability | admission G2 + A5 wire case; M5, M6 | unit + embedded-PG |
| A legacy worker token cannot refresh | A7 (401, row untouched); M1 | embedded-PG |
| A no-op refresh writes nothing and mints nothing | A2 (`updated_at` unchanged); M8 | embedded-PG |
| ★ The REAL route success path end-to-end | A8: session + signed device proof → 200 + minted-session header + row moved (added in review) | embedded-PG |
| The route is not registered when distributed execution is off | negative source scan; M18 (**weaker** than worker-control's structural non-mount — §5 below) | unit |
| The unprovisioned desktop stays unmatchable | the **unmodified** DSK-001 assertions under M15 | unit (daemon) |
| The path the proof signs matches the route | `check-worker-path-parity.mjs` (3 pairs) | repo guard |

**★ TWO clauses this ticket deliberately does NOT write** (design §9): "a composed daemon polls, ACKs
and supervises" (`createPollLoop` still has **zero** production callers — Sprint 3 gives it its first)
and "work executes end to end" (Sprint 5, real E2B). See §6.

**FIVE+ clauses have the embedded-PG suite as their only evidence**, and it is
`describe.skipIf(win32 && AOA_RUN_WIN_INTEGRATION !== "1")` — a plain Windows `pnpm test` renders it
GREEN by skipping. This run used `AOA_RUN_WIN_INTEGRATION=1`; Linux CI runs it unconditionally. A
local-verification gap, not a CI one.

## 3. Mutation sweep — 18 mutants, every one a DELETION, 0 survivors, 0 false kills

Positive control (M0) ran first; anchor-match confirmed each time; the file was restored via `git
checkout` between mutants (all work committed, so restore is clean).

| # | Mutant (DELETION) | Killed by | Tier |
|---|---|---|---|
| M1 | route legacy-token refusal `authority.kind !== "session"` | integration A7 (401, else 500) | embedded-PG |
| M2/M3/M4 | G1 workerId / targetId / deviceGeneration arm | admission G1 arm A/B/C | unit |
| M5 | G2 entirely | admission G2 + A5 | unit |
| M6 | G2's `ceiling.has` conjunct → set-equality | **Step 0 positive control** (a strict subset must ADMIT) | unit |
| M7 | G3 policy check | admission G3 | unit |
| M8 | G4 idempotency short-circuit | admission "changed:false" case | unit |
| M9/M10 | `profile_hash` / `profile_snapshot` assignment in `refreshWorkerProfile` | A1 both-columns (parse-first re-derive) | embedded-PG |
| M11 | the envelope's frozen-schema parse → passthrough | strengthened Step 3 envelope key-reorder | unit |
| M12 | the mint from the 200 path | A1 (minted session verifies) | embedded-PG |
| M13 | move the mint OUTSIDE the transaction | A3 throwing-signer (row byte-identical) | embedded-PG |
| M14 | `expectedProfileHash` from the CAS `WHERE` | A4 concurrent (refresh_conflict) | embedded-PG |
| M15 | the `provisioning` branch in `buildDesktopHello` | Step 8a provisioned case (+ DSK-001 default stays green) | unit |
| M16 | the ceiling intersection in `deriveHelloProvisioning` | Step 8b (`none` device must not report `sandbox.*`) | unit |
| M17 | the capability sort | Step 8a byte-stability across set order | unit |
| M18 | the route's `if (opts.workerSession)` registration | negative source scan | unit |

**Report line:** *18 mutants, 18 killed, 0 survivors, 0 documented equivalents, 0 false kills.* Two
honesty notes: (1) **M6** as a *pure deletion* of the `ceiling.has` conjunct collapses into M5 (an
always-false guard), so it was verified as its intended property — a REWRITE-to-equality reddens the
Step 0 strict-subset positive control — not as a distinct deletion; it is counted, but its distinctness
from M5 rests on the positive control, not on a separate deletion. (2) The **platform-physical narrow**
(`organizationId === null`) is **type-enforced**: `runInTenant` requires a non-null org, so deleting
it is a compile error — the typecheck is its artifact, and it is counted in neither numerator nor
denominator (the WRK-010 slice-2 `bootstrap` precedent).

## 4. The third blocker E4-F010 never named

E4-F010's two halves are the capabilities/policyHash worker-side and the `profile_snapshot` update
channel server-side. WRK-011 §0(d) found a **third**, firing *earlier* than either: the enrolled
all-zero `capacity` is a hard `Math.min` ceiling at `job-leasing.ts:566`, so `deriveAdmissibleWorkloadTypes`
returns `[]` and `job-control.ts:1810-1812` early-returns **zero candidates** before the static matcher
is reached. The refresh writes a **real** nameplate capacity into the snapshot, and the integration
proof drives the **real `poll` service** (not the matcher in isolation), so the capacity path is on the
tested path — A1's precondition `no_work` is caused by the zero capacity, and the post-refresh `offer`
by the real one. Two stale comments describing the old belief (`desktop-hello.ts:28`, `:145` + a
`desktop-hello.test.ts` comment) are corrected in *code* but a dated design record is not rewritten —
filed as the new LOW **E4-F016** with its own manifest key.

## 5. Dormancy is WEAKER here than under `/worker-control/` — stated, not hidden

`executionTargetRoutes` mounts OUTSIDE app.ts's distributed-execution flag block, so this route's
absence flag-off rests on **one conditional registration** (`if (opts.workerSession) router.post(…)`),
not a structural non-mount. `desktop-disabled.negative.test.ts` proves it by **source scan** (the
strongest available proof given `app.ts:588`), and the test comment says so. Risk R6.

## 6. What this does NOT claim / honest residuals

- **A composed daemon that polls, ACKs and supervises is Sprint 3.** `createPollLoop`,
  `assembleWorkerSelfModel`, and `client.selfHelloRefresh()`/`deriveHelloProvisioning` all have **zero
  production callers** after WRK-011 — by design (§6.3, §10). The boot root does NOT yet call the
  refresh route or land the new session; **WRK-008 slice 2b (Sprint 3) owns that wiring**, exactly the
  WRK-010-slice-1 pattern of a route dormant until the next slice composes it. `scripts/gate-clause-wiring.json`
  is **not touched**: `E4-1-leases-through-protocol` stays `unwired` (caller count is all the checker
  reads). Sprint 3 promotes it on evidence.
- **One real journey end to end on E2B is Sprint 5.**
- **A refresh does not re-verify the ratified profile's OWN `deviceGeneration`.** G1 binds the hello to
  the *target's current* generation (via the authenticator). If an admin's ratified profile lags a
  generation bump, a refresh can mint a session that authenticates but is **unplaceable** until
  re-ratification — the frozen matcher fail-closes at `capabilities.ts:460`, so there is **no
  misplacement**, only a bounded operational edge (same class as §10's "a policy change mid-run costs
  one restart"). Surfaced by the independent codex pass (codex-M1); accepted as bounded, not guarded.
- **A refresh does not re-check revocation in its CAS.** The CAS is on `profileHash` only. If a
  revocation commits between auth and the write, the refresh updates the (revoked) row and mints a
  session — but `refreshWorkerProfile` does **not** clear `revokedAt`/`status`, so the worker stays
  revoked and the minted session is **dead on its next authenticated use** (`worker-session-auth.ts:167`
  → `target_revoked`). A pointless write, not an escalation (codex-H2, refuted). Not hardened, to keep
  the plan's CAS design.
- **The capability-ceiling read is outside the write transaction.** If an admin narrows the ceiling
  between the read and the write, the durable snapshot can momentarily record a now-out-of-ceiling
  capability — but **placement re-intersects against the live registered-profile ceiling**
  (`capabilities.ts:481-483`), so the worker can never be placed on the removed capability; the effect
  is a briefly-stale audit record, not an escalation (codex-H1, refuted).
- **A worker that does not heartbeat still gets nothing** (`job-placement.ts:530-532`) — not this
  ticket's, but a provisioned worker still needs `POST /execution-targets/heartbeat`.

## 7. The adversarial review

**5 independent dimension reviewers + a completeness critic + a refutation skeptic + an independent
`codex` pass.** Reviewers verified claims by opening source.

**In-house dimensions: 0 HIGH/BLOCKING.** Security (G2 is a subset refuse-not-clamp; legacy + platform
-physical fail closed; refusals coarse; only `profileHash` re-derived; no frozen edit). Atomic triple
(both columns in one UPDATE; mint inside the tx rolls back on throw; digest matches placement's
parse-first re-derive; the coupling proven). Daemon/frozen boundary (zero `packages/worker-protocol`
edits; `check-frozen-worker-protocol-consumer` + `check-worker-daemon-boundary` + `check-worker-path-parity`
all green; provisioning purely additive; fail-toward-absent holds). The completeness critic confirmed
the Sprint-3 consumer contract is complete (every symbol exported; the third capacity blocker fixed and
proven on the real poll path) and that the only gaps were **Step 9 closure paperwork** (this doc, the
finding flip + key delete, the LOW) — now done.

**Integration-fidelity: 2 LOW, both FIXED.** The route's HTTP success path was never driven end-to-end
(A1–A6 drove the service) → added **A8** (session + signed device proof → 200 + minted-session header +
row moved), which also exercises the production raw-body-parse-before-digest. A6's "REAL route/401"
label overstated a service-level test → renamed + it now asserts the specific `profile_unratified` reason.

**Independent `codex` pass: 3 HIGH + 2 MED.** All adjudicated by a skeptic against source. **Refuted:**
codex-H1 (ceiling TOCTOU — frozen matcher bounds it, §6), codex-H2 (revoked-worker mutation — session
dead on arrival, worker stays revoked, §6), codex-H3 (daemon has zero callers — the *declared* non-goal
with Sprint 3 as named successor, the WRK-010-slice-1 pattern). **Applied:** codex-M2 (platform-physical
got a 204 on the no-op path before the org-null guard — reordered to refuse uniformly). **Documented:**
codex-M1 (generation staleness — §6, bounded by the placement fail-close).

## 8. Registers + CI

All five registers pass: `check-ticket-graph-coverage`, `check-finding-ownership` (E4-F010 resolved +
key deleted; E4-F016 filed + owned), `check-guard-inventory`, `check-gate-clause-wiring` (E4-1 stays
`unwired`), `check-execution-census`. Plus `check-test-inventory` (worker-daemon 136→137),
`check-worker-path-parity` (3 pairs), `check-frozen-worker-protocol-consumer`, `check-worker-daemon-boundary`.
Typecheck clean; all six WRK-011 test files green with the integration suite RUN (`AOA_RUN_WIN_INTEGRATION=1`).

**`verify` is RED on this branch for reasons that PREDATE Sprint 2.75** (go-book §2.0: the job hit its
60-minute cap on five consecutive runs, on SHAs pushed before any Sprint-0 commit). The timeout was NOT
raised. Sprint 2.75's own code is green; its definition of done inherits the pre-existing `verify` red,
stated out loud here per §2.0.

## 9. What I could not prove

- The **composed** boot sequence (poll → offer → self-check → ACK → supervise) — Sprint 3, by design.
- Real-E2B execution — Sprint 5.
- The **generation-staleness** and **revocation-window** edges (§6) are reasoned as bounded/safe from
  source, not exercised by a test; they are documented residuals, not proven-absent.
- `verify` green — it is red for pre-Sprint-0 reasons (§8).
