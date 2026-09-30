# CLI-006 / D2 — Sprint 5 (post-CLI-007) Step 1: result

**Status:** **Step 1 GREEN — the composed loop takes a real lease and runs a task; E4-1 + E4-2 promoted ON EVIDENCE.**
E7-1 stays `unwired` (real E2B is Step 2, operator-owned). The honest end-state: the WORKER's composed
dispatch runtime is now demonstrated end-to-end on the D1 fake substrate; the full DISTRIBUTED journey on
**real E2B** is still owed to an operator-dispatched run.
**Epic:** E7 (exit gate). **Design / Start SHA:** `CLI-006-D2-step1-design.md`, `9c54700f1`.
**Frozen, untouched:** `packages/worker-protocol` (git diff empty), the worker-daemon `SandboxProvider` port,
the `DE-*`/threat docs. No new hosted-API call (Rule #11). No new `AOA_*` switch.

| Commit | What |
|---|---|
| `9c54700f1` | Step 1 design (Start SHA) |
| `f6d2b9408` | Tier 1 — composed-journey component test (lease + supervise) |
| `c53bfc142` | Tier 2 — credential hop (CLI-007 redemption) + fake-plane resolve route + pin bump |
| *(this commit)* | Adversarial-review fixes (split cases, non-vacuous no-leak, label reconcile) + **E4-1/E4-2 → `wired`** + this result + go-book update |

---

## 1. What shipped

**`packages/worker-daemon/src/__tests__/composed-journey.component.test.ts`** — the join no prior test made.
It composes `composeDispatchRuntime` with its **real** production factories (`createPollLoop` +
`createSupervisor` + `createLeaseRenewalDriver` + `createEventOutboxDrain` + the durable sink/store — the
`make*` seams are left to default, verified against `dispatch-runtime.ts` §104-110), a per-op **fake**
`SandboxProvider`, and a real `client`/`session`/`key`/`self` obtained from a **real enrollment** against the
protocol-faithful in-process control-plane double. One offer is enqueued; the composed loop drives it to a
supervised, credentialed run. Five cases:

1. **E4-1** — the composed loop polls, self-checks the frozen offer, and ACKs over the real lease-ack POST
   (`fake.ackCountFor(lease)===1`, dual-authenticated).
2. **E4-2** — that real ACK reaches `createSupervisor`, which runs `create → execute` (tenant command INSIDE
   the sandbox) `→ destroy` (`ops===[create,execute,destroy]`).
3. **stream** — the supervisor's `attempt_started`+`terminal` are drained to `/events`, digest-valid.
4. **credential (CLI-007)** — the composed loop redeems the CLI-007-shaped `provider_key`/env/`sandbox_local_only`
   handle over the real resolve op into `spec.env` (`peek(sandbox).env.ANTHROPIC_API_KEY===<redeemed>`), one resolve.
5. **fail-closed** — a DENIED redemption fails the run before create (no sandbox), the DAT-008 invariant on the
   composed path.

**Test-support (not production):** extended the control-plane double
(`__tests__/support/fake-control-plane.ts`) with the DAT-008 `/execution-secrets/resolve` route (dual-auth;
`200 {outcome:"resolved"|"denied"}`, the 200-for-denial trap modelled) + `seedSecretResolution` /
`resolveCountFor` / `eventBodies` accessors. Boundary-clean (`check-worker-daemon-boundary` PASS), outside the
gate-clause checker's `SOURCE_ROOTS`.

**Register/CI bookkeeping:** worker-daemon test pin `146→147` (the one new `.test.ts`; server floor left at
1475, unchanged); `check-execution-census` untouched (no new `.test.mjs`); `environment-variables.md` untouched.

---

## 2. The journey, hop by hop — where each is proven (the completeness ledger)

The milestone journey is create → schedule → lease → stage → execute → stream → produce → review → cancel →
audit. Step 1 proves the **worker-composed** hops on the D1 fake substrate; the server-side hops are proven by
CLI-006's existing evidence (cited, not re-run); the **real-E2B** leg is E7-1 (Step 2).

| # | Hop | Proven in Step 1? | Where the evidence lives |
|---|---|---|---|
| 1 | create (task→job convert) | No (server-side) | CLI-006 D1 40/40 + PR owner-decision matrix; `cli-006-run-execution-owner.test.ts` |
| 2 | schedule (placement + mint) | No (server-side) | `job-placement.integration.test.ts [CLI-007]` (mints one handle, replay-stable) |
| 3 | **lease** | **YES — composed loop** | composed-journey `ackCountFor===1` (E4-1). Server-side offer origin: CLI-006 D1 + `job-leasing.integration.test.ts` |
| 4 | **stage** (env into sandbox) | **YES — composed loop, fake provider** | composed-journey credential case (`spec.env.ANTHROPIC_API_KEY`) |
| 5 | **execute** (run inside sandbox) | **YES — composed loop, fake provider** | composed-journey E4-2 (`executionsOf`, inside the sandbox) |
| 6 | **stream** | **YES — composed loop → real drain** | composed-journey stream case (`/events` upload, digest-valid) |
| 7 | produce (artifact/patch) | No (this step) | keyed real-E2B artifact-commit case (prior session, `88c6a8b66`); server apply guard tests |
| 8 | review (projector) | No (server-side) | CLI-006 D1 + `cli-006-canary-run-projector.test.ts` |
| 9 | cancel | No (this step) | CLI-006 D1 + sibling supervisor cancel/escalation tests; keyed `terminate` on real E2B |
| 10 | audit (JOB-008) | No (server-side) | CLI-006 PR (JOB-008 assertions) + keyed inspect redacted/zero-leak |

**The honest answer to the go-book's question — "what hop is proven only by a mock, and does the evidence
chain reach real E2B?"** In Step 1: hops 4/5 (stage/execute) are proven by the **per-op fake provider**; hops
3/6 (lease/stream) are proven against the **fake in-process control plane**. **The Step-1 chain does NOT reach
real E2B anywhere — by design.** Real E2B is E7-1 (Step 2). The server-side hops (1/2/8/10) are proven by
CLI-006's D1 lane (a REAL distributed control plane with a fake provider — the sanctioned D1 substrate) +
embedded-PG service tests, cited above.

---

## 3. Mutation ledger — every mutant a DELETION, positive control first, all reverted

The production code under demonstration already exists (WRK-008/2b + WRK-011 + DAT-008/5 + CLI-007), so the
mutation discipline PROVES THE TEST IS NON-VACUOUS: it would redden if the composed behaviour broke. Each
mutant is a temporary edit to production, run RED, then `git checkout` (poll-loop.ts confirmed clean after each).

| # | Mutation (DELETION) | Result | Anchors |
|---|---|---|---|
| M0 | `handleOffer` returns `{kind:"continue"}` before processing | ALL 5 cases RED | positive control — the test drives the REAL loop |
| M1 | skip the `ackLease` POST (fabricate the acknowledged body) | **E4-1 RED, E4-2 GREEN** | E4-1 lease anchors the real ACK POST |
| M2 | remove `trackHandoff(offer, workloadClass)` (poll-loop.ts) | **E4-2 RED, E4-1 GREEN** | E4-2 supervise anchors the ACK→supervisor handoff |
| M3 | `materializeRunSecrets` returns `{env:{},canaries:[]}` (drop `synthesiseRunSecrets`) | credential + fail-closed RED; lease/supervise/stream GREEN | the CLI-007 redemption hop |
| M5 | `drainOnce` returns an empty summary (no upload) | stream RED; others GREEN | the durable event drain |

**M1 and M2 are mirrors** — each reddens exactly ONE of the two promoted clauses at the CASE level and leaves
the other green. That is the isolation the two clauses need, and the reason it is real: the cases are split
(one `it()` per clause).

**M4 (delete the per-run canary seed) is N/A on the composed path, DELIBERATELY.** The composed happy path
never STREAMS the redeemed value (no `observeRun`/stdout wired yet; `terminal.errorMessage` is `null`), so
there is no leak for redaction to scrub here — deleting the seed changes nothing observable in this test. The
redaction MECHANISM (scrubbing an emitted value from BOTH streams) is proven with a planted-leak positive
control by DAT-008 slice 5 (`supervisor-secret-materialization.test.ts`), cited — not re-proven here. This is
recorded honestly rather than counted as a killed mutant.

**Report line:** *5 mutants run, 5 killed by ASSERTIONS, 0 survivors, 0 false kills, 1 documented N/A (M4);
every production mutation reverted, poll-loop.ts confirmed clean after each.*

---

## 4. The promotion — E4-1 and E4-2 → `wired`, and why it is honest (not a vacuous green)

`scripts/gate-clause-wiring.json`: `E4-1-leases-through-protocol` (createPollLoop) and
`E4-2-supervises-sandboxes` (createSupervisor) flip `unwired → wired`.

**The vacuous-green line, held.** `check-gate-clause-wiring.mjs` only COUNTS references; both symbols already
carry their 2 references (`composeDispatchRuntime`), so the flip passes the checker MECHANICALLY with or
without evidence. The promotion therefore rests on the TEST, documented here, not on the checker going green —
that is the whole point of §3's mutation ledger.

**Why the fake-plane evidence is a legitimate basis for THESE clauses.** E4-1 is *leases-**through-protocol***;
E4-2 is *supervises-**sandboxes***. Both name the WORKER's composed behaviour, which the test exercises with
REAL code: real `pollOnce`, the frozen `leaseOfferV1Schema`, a real `ackLease` POST, a device proof the
counterparty verifies INDEPENDENTLY (`crypto.verify`, a 4th implementation — a broken signer fails the test),
and the real `createSupervisor` lifecycle. What the fake plane does NOT prove — that the SERVER's real
placement mints the offer, and that a REAL E2B sandbox runs a coding CLI — is (a) proven separately for the
server side (CLI-006 D1 40/40 + `job-leasing.integration.test.ts` + `job-placement.integration.test.ts
[CLI-007]`), and (b) exactly E7-1, which stays `unwired`. The completeness critic verdict on this sprint:
*"the E4-1/E4-2 promotion is DEFENSIBLE, not a vacuous-green trap … a real embedded-PG server leg is not
strictly required to make the worker-scoped promotion honest."*

**The counterparty caveat — now closed for the lease by Leg B Part 1.** In the composed-journey test the
offer is a hand-enqueued, schema-valid fixture (`fake.enqueuePoll`), not a lease minted by the real server.
**Leg B Part 1 closes that** (`server/src/__tests__/composed-loop-real-server.integration.test.ts`, §4a): the
SAME `createPollLoop` leases a **real server-minted attempt** over the **real embedded-PG worker-control
routes** — a real device proof + session against real placement. What remains owed is **Leg B Part 2** (the
credential resolve over a **live fence** → a real `resolved` value), the DAT-008 slice 5 §8 residual, which
folds into Step 2's staging-canary substrate (§6). Neither Part is required for the worker-scoped E4-1/E4-2
promotion, and neither is sufficient for E7-1 (which needs real E2B).

`E4-3` (survives-restart) and `E5-3` (patch-quarantine) are untouched — this step wires neither.

### 4a. Leg B Part 1 — the composed loop leases from the REAL server (E4-1 evidence upgraded)

`server/src/__tests__/composed-loop-real-server.integration.test.ts` (embedded-PostgreSQL, run with
`AOA_RUN_WIN_INTEGRATION=1` + on Linux CI) drives the SAME `createPollLoop` against the **real** server:
embedded-PG + the real `workerControlRoutes`, a real device proof + a minted session, and a seeded
lease-eligible attempt (the WRK-011 seed recipe, provisioned; the shared `worker-provisioned-target.json`
fixture is the contract on both sides). One cycle: the composed loop polls the real `/api/worker-control/poll`,
is OFFERED the seeded attempt, self-checks the frozen offer, and ACKs over the real
`/api/worker-control/leases/:id/ack`, handing off to a collecting seam.

- **The ACK is proven server-specific, not merely the offer.** `offerLease` leaves the attempt/lease
  `'offered'`; only `activateLeaseAck` (on a real, fully-authenticated ACK) flips the attempt to `'leased'` +
  the lease to `'active'` + writes a `lease_ack` receipt — which the test asserts.
- **Non-vacuous:** a **negative control** (no lease-eligible attempt ⇒ no offer ⇒ no handoff, no lease row)
  proves the offer is real; and a **dist-rebuilt M1** (skip the ACK POST, then `pnpm --filter worker-daemon
  build` — because the server test imports the **built** package, so a src edit alone has NO effect: a real
  go-book anchor-match gotcha, recorded) reddens the happy case with `expected 'offered' to be 'leased'`,
  proving the ACK assertions anchor the real ACK. Src reverted + dist rebuilt + verified green.

This upgrades E4-1's evidence from a protocol-faithful in-process double to a **real control plane**: the
server's minted lease genuinely reaches the composed worker. **Leg B Part 2** (the credential resolve over a
live fence) is NOT built — it is DAT-008 slice 5 §8's explicitly-deferred residual (§9).

---

## 5. Decision #104 — the credential value stays contained

A dedicated adversarial security reviewer (source-only) traced every hop and could not construct a leak:
- The redemption path stores/moves only REFERENCES; the value is resolved ONLY inside the sandbox
  (`usePolicy:"sandbox_local_only"`) and reaches ONLY `spec.env → provider.create/execute` (the sandbox).
- **No changed or production path logs or serialises the value.** `secret-redemption.ts` has no logger; the
  supervisor's redemption-failure `logger.warn` carries only `{leaseId, resourceLabelsHash}`; the fake plane's
  request ledger stores method/url/status/proofId/thumbprint — never request/response BODIES.
- The per-run redaction canary tripwire is ARMED here (`synthesiseRunSecrets` returns the value as BOTH `env`
  and a `canary` from one call; the supervisor seeds `runCanaries` before any emit) — confirmed from source by
  the reviewer.
- The composed-path no-leak assertion scans the DECRYPTED event BODIES the drain uploaded (not just metadata),
  with a POSITIVE CONTROL (the emitted `sandboxId` IS present, so the bodies carry real content) — and the
  redeemed value is absent. **Honest scope:** this is a CONTAINMENT check on the composed path (which never
  streams the value), NOT a redaction proof; the redaction mechanism is DAT-008's (§3, M4).

---

## 6. E7-1 disposition + the Step-2 dispatch (prepared, session STOPS at the boundary)

`E7-1-coding-journey` stays **`unwired`** (untouched). Promotion requires a **cited dispatched real-E2B run
that completes the DISTRIBUTED journey** — never the composed loop, the fake provider, the keyed
provider-primitive lane, or a green-by-skip lane. Step 1 does not spring the trap.

**The keyed provider lane — DISPATCHED and GREEN on real E2B (2026-08-26).** The operator's `E2B_API_KEY` was
in repo secrets, so this session fired the sentinel push (`.github/keyed-e2b-trigger` re-trigger #4 →
`keyed-e2b-conformance.yml`; `workflow_dispatch` is unavailable off `main`). **Cited dispatched run
[32995765059](https://github.com/MeteoriteLabs/AoA/actions/runs/32995765059) — `keyed-e2b: completed/success`,
19 tests PASSED / 0 skipped** (the cases RAN — `E2B_API_KEY: ***` present + masked, so the go-book "must PASS,
not skip" bar is met). The **CLI-006/D2 artifact-commit / patch-integrity case PASSED** on real E2B (*"stages a
base, produces a real patch, and its declared result hash reproduces"*), alongside CLI-001 (create→execute→
inspect-redacted→destroy→reconcile + TTL), CLI-002 (stage/mutate/read), CLI-003 (stream/cancel/timeout/
lost-ACK), CLI-004 (cleanup reconciliation), and the managed-secret rehearsal incl. *"tenant-probe-fails: the
provider-control credential never crosses the neutral seam"*. **No `E2B_API_KEY`/redeemed value appears in any
log** (GitHub masks the secret; the tenant-probe case asserts the seam). This proves the **provider/adapter
PRIMITIVES on real E2B** — the provider legs of stage/execute/stream/produce/cancel/audit.

**It does NOT promote E7-1.** `E7-1-coding-journey` stays **`unwired`**: the keyed lane proves provider
primitives, NOT the DISTRIBUTED journey (create/schedule/lease/review through the control plane). The
E7-1-promoting run is the **staging/testing-instance canary campaign** the E7 exit gate names
(`docker-compose.staging.yml` / `testing.armyofagents.org`) — an operator campaign with real spend, which also
needs **Leg B Part 2** (the live-fence credential resolve). **Until a dispatched run of THAT distributed
journey on real E2B is cited, E7-1 stays `unwired`.** Honest end-state: the **provider hops are now proven on
real E2B (run 32995765059); the full distributed journey on real E2B remains owed.**

---

## 7. The adversarial review — what it caught (and the fixes)

Three independent source-only reviewers (composition-fidelity/promotion-honesty, credential/no-leak security,
completeness critic).

- **Composition-fidelity — 0 defects on substance.** Confirmed the test drives the REAL production factories
  (not the all-fake `dispatch-runtime.test.ts` seams), the lease is a genuinely dual-authenticated ACK (not a
  rubber stamp), the supervise is real, and the mutation points are load-bearing. **Two process items, fixed:**
  the mutation-label drift (`M-E42`/`M-stream` → reconciled to the design's `M1/M2/M3/M5` here and in the gate
  reasons); the E4-1 reason now cites `M1` (the direct ACK anchor). **One transient HIGH — a RACE ARTIFACT,
  not a real leftover:** the reviewer read the working tree while the completeness-critic subagent (running
  concurrently, with write access) had an `M2` mutation briefly applied to `poll-loop.ts` before reverting it.
  Verified clean now (`git status` shows only the intended files; no `MUTANT`/`MUTATION` marker in production
  src). Lesson: write-capable review subagents can transiently mutate shared files — verify the tree after.
- **Credential/no-leak security — CONFIRMED real + fail-closed + no leak constructible.** **One MED, fixed:**
  the original no-leak assertion inspected `eventUploads()` — which retains only upload METADATA, not event
  bodies — so it could not fail even if the secret leaked verbatim (a vacuous check, the exact class this
  programme exists to catch). Fixed: the fake plane now retains the decrypted event bodies (`eventBodies()`),
  the assertion scans them, and a positive control (`sandboxId` present) makes it non-vacuous; the comment is
  honest that this is containment, not a redaction proof (§5).
- **Completeness critic — promotion DEFENSIBLE, E7-1 correctly held, chain does not reach real E2B.** **One
  MED (process):** commit the gate flip WITH this result doc (not alone) so the server-lease-origin citation +
  the Leg-B-owed note are on the record — done here. **LOWs, fixed:** the E4-1/E4-2 cases split so mutation
  isolation is observable at the case level (§3 M1/M2); the hop-by-hop ledger written (§2); the hand-enqueued
  (not server-minted) offer named as the Leg-B gap (§4).

No HIGH survived against the deliverable. Not delegated to a plan-writing or auto-fixing skill.

---

## 8. Registers + CI (honest)

- **Five registers green:** `check-gate-clause-wiring` (5 wired incl. the E4-1/E4-2 promotion; E7-1 dormant),
  `check-finding-ownership` (10 open; unchanged), `check-ticket-graph-coverage`, `check-guard-inventory`,
  `check-execution-census`. Plus `check-test-inventory` (worker-daemon 147), `check-worker-daemon-boundary`
  PASS, frozen `worker-protocol` git-diff empty.
- **Local proof:** `tsc -p packages/worker-daemon` clean; full worker-daemon suite **829 passed** (140 files),
  the 5 composed-journey cases green (`AOA_RUN_WIN_INTEGRATION=1` for the integration siblings; the
  composed-journey test itself is a pure component test needing no flag).
- **`verify` inherits the §2.0 red** (the pre-Sprint-0 timeout regression — NOT raised, NOT masked). It also
  carried a **second, pre-existing red** — `server/src/__tests__/job-leasing-contract.test.ts` "enforces an
  exhaustive authority-writer allowlist" — which this session **FIXED** (finding **E4-F017**, `resolved`).
  WRK-011's `refreshWorkerProfile` was an authority writer to `workers` that skipped the mandated
  target→worker→exclusive lock (not just the allowlist entry); it now proves the lock order inline (the same
  order `lockPlatformAuthorityForMutation` uses), the reviewed allowlist entry is added, and the guard is NOT
  weakened. Mutation-proven (M-lock: delete the exclusive acquire → the exact "must prove … exclusive"
  violation returns); WRK-011's 8 embedded-PG integration tests stay green with the lock. After this, the ONLY
  remaining `verify` red is the deferred §2.0 timeout. **★ Gotcha re-learned:** committing the fix BEFORE
  mutation-testing — a `git checkout` to revert a mutant eats an uncommitted fix in the same file.

---

## 9. What I could not prove / owed

1. **Leg B Part 1 — DONE (§4a).** The composed loop leases a real server-minted attempt over the real
   embedded-PG control plane. **Leg B Part 2 — the credential resolve over a LIVE fence** (a real `resolved`
   value) is NOT built: it is DAT-008 slice 5 §8's explicitly-deferred residual (needs an active fence + a
   minted `job_secret_handles` row + a Company provider-key secret store aligned in one harness). Owed, and
   folded into Step 2's staging-canary substrate. Not required for the worker-scoped E4-1/E4-2 promotion.
2. **The full DISTRIBUTED journey on REAL E2B (E7-1).** Owed to the operator-dispatched staging-canary campaign
   (§6). Until a dispatched run is cited, E7-1 stays `unwired`.
3. **A redaction TRIPWIRE on the composed path.** The composed path has no leak source, so redaction cannot be
   non-vacuously proven here; it is DAT-008's (§3, M4).
