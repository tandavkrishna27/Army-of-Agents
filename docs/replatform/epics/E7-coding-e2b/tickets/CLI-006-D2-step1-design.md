# CLI-006 / D2 — Sprint 5 (post-CLI-007) Step 1: drive the COMPOSED loop through one lease + task

**Status:** `design` (Sprint 5, Step 1). This is the **post-CLI-007 continuation** of `CLI-006-D2-execution-plan.md`.
The prior session (that plan) built the keyed real-E2B artifact-commit case and **stopped at the dispatch boundary**;
it filed **E7-F001**. Sprint 5a (CLI-007) **resolved E7-F001**, so the canary now mints a Company `provider_key`
handle and the journey is **runnable**. This step does the free, no-key half the go-book now asks for.
**Maps to the existing `CLI-006` graph node** — no new `#### ID` node.
**Pre-step tip:** `511fcf4ed`. **Start SHA:** the commit that lands this file.
**Frozen, untouched:** `packages/worker-protocol`, the worker-daemon `SandboxProvider` port, the `DE-*`/threat docs.
No new hosted-API call (Rule #11).

> **The one-sentence honest state going in.** Every prior sprint COMPOSED the dispatch runtime or proved a
> HALF of the loop; **no test has ever driven the composed `createPollLoop` + `createSupervisor` through a
> single lease-and-run.** `E4-1-leases-through-protocol` and `E4-2-supervises-sandboxes` are therefore
> `unwired`, promotable **only on the evidence of a composed loop that actually took a lease and ran a task**
> (`gate-clause-wiring.json` reasons; go-book §4 Sprint 5). That evidence is what this step produces.

---

## 1. The boundary — session vs operator, Step 1 vs Step 2

Stated up front and held to (go-book §4 Sprint 5, keyed-lane header):

- **The SESSION does (this step, Step 1):** build/repair each hop's wiring; run everything that runs **without**
  a live E2B key — unit, embedded-PG, contract; produce the composed-loop lease-and-run evidence; promote
  `E4-1`/`E4-2` **iff** that evidence lands. **No real E2B, no key, no spend.**
- **Only the OPERATOR does (Step 2):** supply `E2B_API_KEY` (a provider secret — never handed to the session)
  and **trigger** the real-E2B dispatch. E7-1 is promoted **only** on a cited dispatched real-E2B run of the
  full journey. If no such run exists, `E7-1-coding-journey` STAYS `unwired` and the sprint's honest end-state
  for that clause is "runnable, journey unproven on real E2B" — **not** a failure.

**The vacuous-green line this step must hold.** `check-gate-clause-wiring.mjs` only **counts references**
(`scripts/lib/gate-clause-wiring.mjs`); `createPollLoop`/`createSupervisor` already carry their 2 references
(`composeDispatchRuntime`), so flipping either clause to `wired` passes the checker **mechanically, with or
without evidence**. Promotion is therefore a **human judgment on a test**, never on the checker going green.
This step promotes E4-1/E4-2 **only** on a cited, non-vacuous test that drives the composed loop through a real
lease; the mutation table (§5) is how "non-vacuous" is proven.

---

## 2. Terrain — verified at tip `511fcf4ed` (each fact re-read from disk)

| # | Fact | Evidence (file:symbol) |
|---|---|---|
| 2.1 | `composeDispatchRuntime` wires the poll loop, renewal driver, supervisor and durable outbox from an **injectable** `provider` + real factory defaults + a real `client`/`store`/`self`/`key`. The `make*` seams default to the **production** factories. | `packages/worker-daemon/src/lifecycle/dispatch-runtime.ts` `composeDispatchRuntime` (deps `:60-85`, defaults `:104-110`) |
| 2.2 | The composed loop's real lease chain: `pollOnce` → `offerSatisfiesWorker` self-check → `ackLease` → `trackHandoff` → the renewal **driver** (decorates the supervisor) → `createSupervisor.accept`. `ackLease` is a **real POST** to `/api/worker-control/leases/:leaseId/ack`. | `poll/poll-loop.ts` (`pollOnce`, `handleOffer` self-check, `ackLease`→`client.leaseAck`, `trackHandoff`); `transport/client.ts` `leaseAckPath` |
| 2.3 | The server ACK **route exists** (DB-backed), mounted only behind `AOA_DISTRIBUTED_EXECUTION_ENABLED`. Sprint 3's "no production ACK path" meant no *driven* path, not missing code. | `server/src/routes/worker-control.ts` `POST /worker-control/leases/:leaseId/ack`; `server/src/app.ts` (flag-gated mount) |
| 2.4 | The supervisor drives `provider.create` → `provider.execute` (tenant command **inside** the sandbox) → `provider.destroy`, over an `EffectAuthority`; the provider is **injected** (a fake per-op provider swaps in). | `supervisor/supervisor.ts` `runLifecycle`/`createSpecFor`; `supervisor/provider.ts` `SandboxProvider` |
| 2.5 | The credential chain is wired: `handoff.offer.job.secretHandles` → `createRedeemer` → `client.resolveExecutionSecret` (real POST `/api/worker-control/execution-secrets/resolve`) → `synthesiseRunSecrets` → `createSpecFor(spec.env)` → `provider.create`. Fails **closed** on any non-`resolved` outcome; seeds each redeemed value as a **per-run redaction canary** into both streams before create. | `lifecycle/dispatch-runtime.ts` `materializeRunSecrets`; `lease/secret-redemption.ts` `synthesiseRunSecrets`/`classifyResolveResponse` |
| 2.6 | The two halves exist but **were never joined**: `poll-offer-ack.component.test.ts` drives real `pollOnce`+`ackLease` against the fake plane; `supervisor-happy.component.test.ts` drives real `createSupervisor` against a per-op fake provider. Every `createPollLoop` component test injects a **no-op** `supervisor`. | `__tests__/poll-offer-ack.component.test.ts`; `__tests__/supervisor-happy.component.test.ts`; e.g. `poll-ack-failures.component.test.ts` (`supervisor: {accept: () => {}}`) |
| 2.7 | The fake control plane is a **protocol-faithful independent verifier** (re-derives the AOA-DEVICE-PROOF-V1 canonical string from scratch and `crypto.verify`s it; validates offers through the frozen `leaseOfferV1Schema`; records real ACKs; serves `/events` with cumulative-ACK + independent digest recompute). It has **NO `/execution-secrets/resolve` handler** (it predates DAT-008 slice 5). | `__tests__/support/fake-control-plane.ts` (route table; `verifyDeviceProof`; `handleEventUpload`) |
| 2.8 | The per-op fake provider `implements SandboxProvider`, imports **no `node:child_process`** (the tenant command never spawns in the worker process), and records `create/execute/destroy` ops + emitted events. The published `@armyofagents/sandbox-fake-provider` is the **driver** port (`invoke(op,args)`), NOT the per-op port; there is deliberately **no driver→per-op adapter**. | `__tests__/support/fake-provider.ts`; `packages/sandbox-fake-provider/src/fake-driver.ts` |
| 2.9 | The fixtures are self-consistent: `enrollFixtureWorker(fake, code)` drives a **real** enrollment → `{session, key, client}` at `POLL_FIXTURE_IDS.target/worker`; `makeSelfModel()` is a matchable self-model at the same target; `compatibleOffer()` is a frozen offer at `workerId=POLL_FIXTURE_IDS.worker` with `workload:{command:"codex",args:["exec","--json"]}` and `secretHandles: []`. `offerSatisfiesWorker(self, cap, compatibleOffer())` is `true`. | `__tests__/support/poll-fixtures.ts` |
| 2.10 | CLI-007 made the **canary** mint a Company `provider_key` handle; the worker redeems `materialization.kind==="env" && usePolicy==="sandbox_local_only"` handles whose `target ∈ {ANTHROPIC_API_KEY, OPENAI_API_KEY}`. This is the hop the composed test now exercises. | `lease/secret-redemption.ts` `PROVIDER_AUTH_ENV_TARGETS`/`synthesiseRunSecrets`; `epics/E7-coding-e2b/tickets/CLI-007-result.md` |
| 2.11 | `E4-1` (`createPollLoop`) / `E4-2` (`createSupervisor`) are `unwired`, promotable **on evidence**, never on caller count. `E7-1` (`E2bSandboxProvider`) stays `unwired` — promoted only on a cited dispatched real-E2B journey. | `scripts/gate-clause-wiring.json`; `scripts/lib/gate-clause-wiring.mjs` |
| 2.12 | The D1 lane (`d1-merge-train.yml`) is **not** in `ci-required`; its "journey" tests have a HARNESS impersonate the worker over HTTP (the real daemon container boots inert, `no_provider`). So the D1 green never exercised `createPollLoop`/`createSupervisor`. | `.github/workflows/d1-merge-train.yml`; `tests/d1/e6f-03-networked-smoke.test.ts` (scope note); `__tests__/shipped-binary-refuses.test.ts` |

**What this terrain settles.** The composed-loop lease-and-run has never been demonstrated; the pieces to
demonstrate it in-process (real factories, a protocol-faithful plane, a per-op fake provider, self-consistent
fixtures) all exist. The one missing test-support piece is a resolve handler on the fake plane (2.7) to
exercise the CLI-007 credential hop (2.10).

---

## 3. What this step delivers

**A. The composed-journey integration test** (`packages/worker-daemon/src/__tests__/composed-journey.component.test.ts`) —
`composeDispatchRuntime` with its **real** factories, a per-op **fake** provider, and a real `client`/`session`/
`key`/`self` from `enrollFixtureWorker` + `makeSelfModel`, driven through **one** lease cycle against the fake
control plane, proving each worker-side hop with real code:

| Hop | What the composed loop really does | Assertion (turns RED if the hop breaks) |
|---|---|---|
| **lease** (E4-1) | `createPollLoop` polls, self-checks the frozen offer, and `ackLease`s over the real ACK POST | `fake.ackCountFor(lease) === 1`; the recorded ACK carries the offered `leaseId`/`workerId`/`deviceThumbprint` |
| **credential** (CLI-007 hop) | `synthesiseRunSecrets` redeems the offer's `provider_key`/env/`sandbox_local_only` handle over the real resolve POST | the fake plane recorded exactly one resolve for the handle; the fake provider's `create` spec `env` carries `ANTHROPIC_API_KEY=<redeemed>` |
| **supervise** (E4-2) | the driver hands off to `createSupervisor`, which runs `create → execute(inside) → destroy` | fake provider ops `=== ["create","execute","destroy"]`; the tenant command ran against the created `sandboxId` |
| **stream/drain** | the supervisor emits `attempt_started`+`terminal`; the durable outbox drain POSTs them to `/events` | `fake.eventUploads()` shows the terminal batch, digest-valid |
| **no-leak** (Decision #104) | the per-run redaction canary scrubs the redeemed value from **both** streams before create | the redeemed value appears in **no** drained event body; an unseeded positive control leaks it verbatim |

**Extending the fake plane (test-support only).** Add a `/api/worker-control/execution-secrets/resolve`
handler to `__tests__/support/fake-control-plane.ts` mirroring the real route's contract (dual-auth; body
`{audience:"worker_run", …, handleId}`; `200 {outcome:"resolved", envTarget, value}` on the seeded handle,
`200 {outcome:"denied", reason}` otherwise). This is `__tests__/support/` code — outside the gate-clause
checker's `SOURCE_ROOTS` and outside the worker-daemon-boundary scan's production set — and it keeps the double
protocol-faithful (independent dual-auth, keyed on the handle). The value it returns is a **synthetic** fixture
string (never a real key); the S4 canary tripwire (below) proves it never reaches a log or event.

**B. The real embedded-PG server leg — the strongest form, attempted, honestly bounded** (§7). Drives the
composed worker (or, minimally, its real poll/ack/resolve/events client ops) against the **real** server routes
(Style A `createApp` + Style B device-proof worker client, embedded-PG) so the SERVER's minted lease reaches
the composed worker and the resolve returns a real minted handle over a **live fence** — closing DAT-008 slice 5
§8's "resolved-value proven only at unit level" residual. Whatever of this lands is cited; whatever does not is
named as owed, and folds into Step 2's staging-canary campaign either way.

**C. The Step-2 dispatch, prepared, STOP at the boundary** (§8).

### 3.1 Why the fake-plane leg is honest evidence for E4-1/E4-2 (not a per-hop mock of those clauses)

`E4-1` is *leases-**through-protocol***; `E4-2` is *supervises-**sandboxes***. Both name the **worker's composed
behaviour**. The fake control plane exercises the **real protocol** end to end — real `pollOnce`, the frozen
`leaseOfferV1Schema`, a real `ackLease` POST, an independently-verified device proof, a recorded ACK — and would
**fail the test** if the worker's protocol were broken (2.7). The per-op fake provider exercises the **real
supervisor** lifecycle. What the fake plane does NOT prove — that the *server's* leasing/placement logic mints the
right lease, and that a *real E2B* sandbox runs a coding CLI — is (a) proven elsewhere for the server side
(CLI-006 D1 40/40 + `job-leasing.integration.test.ts` + `job-placement.integration.test.ts [CLI-007]`), and
(b) exactly `E7-1`, which stays `unwired`. The completeness critic's question — "what hop is proven only by a
mock, and does the chain reach real E2B?" — is answered without evasion: the server-lease-origin hop and the
real-E2B hop are **not** claimed by E4-1/E4-2, are cited where they are proven, and E7-1 carries the real-E2B
gap. Leg **B** removes even the server-lease-origin caveat for E4-1 to the extent it lands.

---

## 4. Fail-first TDD

Every test is written to fail for a **named** reason first, then made green by the minimal change.

1. **Positive control.** Write the composed-journey test end to end. Run it **before** adding the fake-plane
   resolve handler: the credential redemption POSTs to a route the plane 404s → `synthesiseRunSecrets` fails
   closed → the supervisor emits a `secret_redemption_failed` terminal and **no `create`** → the supervise
   assertions are RED **for the stated reason** (redemption failed closed, exactly the DAT-008 fail-closed
   contract). Confirms the test drives the real redemption path, not a stub.
2. **Add the resolve handler** to the fake plane (return `resolved` for the seeded handle). Re-run: the credential
   + supervise + drain + no-leak assertions go GREEN. This is the moment the composed loop first leases, redeems,
   supervises, and drains in one run.
3. **The no-leak assertion is written with its own positive control** (a sibling case that seeds NO redaction
   canary and asserts the value LEAKS into the drained stream), so the scrub assertion cannot pass vacuously.
4. **Leg B (real server)**: write the embedded-PG journey RED first (assert a `resolved` redemption over the real
   route on a live fence — which today's `execution-secret-resolve-worker.integration.test.ts` deliberately does
   NOT prove, it asserts fail-closed on a no-such-fence), then wire it green. Guarded
   `skipIf(win32 && AOA_RUN_WIN_INTEGRATION!=="1")`, run locally with the flag and on Linux CI.

---

## 5. Mutation table — proving the composed-journey test is non-vacuous (DELETE, positive control first)

The production code under demonstration already exists, so the mutation discipline here proves **the new test would
turn RED if the composed behaviour broke** — the go-book "positive control FIRST; DELETE, never rewrite to an
equivalent; print whether the anchor matched" rules. Each mutant is a temporary edit to production, reverted after.

| # | Mutation (DELETE / break) in production | Expected RED assertion |
|---|---|---|
| M0 | **Positive control** — make `composeDispatchRuntime` compose a no-op poll loop (`makePollLoop` default → a stub) | the whole journey test fails (no ACK, no ops) — proves the test drives the REAL composition |
| M1 | delete the `ackLease` call in `poll-loop.ts` `handleOffer` (skip straight to `trackHandoff`) | `ackCountFor === 1` RED (E4-1 anchor) |
| M2 | make `trackHandoff` NOT call `supervisor.accept` | provider-ops `["create","execute","destroy"]` RED (E4-2 anchor) |
| M3 | drop `synthesiseRunSecrets(...)` from `materializeRunSecrets` (return `{env:{},canaries:[]}`) | resolve-count / `spec.env.ANTHROPIC_API_KEY` RED (credential hop) |
| M4 | delete the per-run canary seed (`runCanaries.push(...mat.canaries)` in `supervisor.ts`) | no-leak assertion RED (the value leaks into the drained stream) |
| M5 | make the drain not POST terminals (`drain.start` no-op) | `fake.eventUploads()` terminal-present RED |
| M-CTRL | (test-side) the no-leak **positive control** case: seed NO canary | asserts the value LEAKS — proves the scrub assertion is real |

**Report line to reproduce in the result doc:** *N mutants, N killed, 0 survivors, 0 false kills; every mutant
COMPILES and RUNS and is killed by an ASSERTION.* A surviving mutant is a QUESTION (go-book §2.2), resolved before
any promotion.

---

## 6. Acceptance — every clause to a test that can turn RED

| # | Clause | Test | Tier |
|---|---|---|---|
| A1 | The composed `createPollLoop` takes a real lease (ACK over the real protocol) | composed-journey `ackCountFor===1` | worker-daemon component |
| A2 | The composed `createSupervisor` supervises a sandbox lifecycle after that ACK | composed-journey provider-ops `[create,execute,destroy]` | component |
| A3 | The CLI-007-minted `env`/`sandbox_local_only` handle is redeemed into `spec.env` | composed-journey resolve-count + `spec.env.ANTHROPIC_API_KEY` | component |
| A4 | The redeemed value never reaches a drained event (Decision #104) | composed-journey no-leak + its leak positive control | component |
| A5 | A denied/absent redemption fails the attempt CLOSED (no sandbox) | composed-journey fail-first step 1 (kept as a permanent case) | component |
| A6 | The offer is validated through the FROZEN schema (a malformed fixture fails at the plane) | inherited: fake plane parses `leaseOfferV1Schema` | component |
| A7 | Frozen wire untouched | `git diff -- packages/worker-protocol` empty; `check-frozen-worker-protocol-consumer` | repo guard |
| A8 | Daemon imports only protocol + pino (no new boundary break) | `check-worker-daemon-boundary` | repo guard |
| A9 (leg B) | The SERVER's minted lease reaches the composed worker; resolve returns `resolved` on a live fence | embedded-PG journey (Style A+B), `AOA_RUN_WIN_INTEGRATION=1` + Linux CI | embedded-PG |

---

## 7. Promotion disposition

- **`E4-1-leases-through-protocol` → `wired`**, cited to A1 (the composed loop took a real lease). Reason field
  rewritten to name the test and to state the counterparty (protocol-faithful in-process plane; server-lease-origin
  proven separately / by leg B where it lands). `expectedReferences` dropped (only meaningful for `unwired`).
- **`E4-2-supervises-sandboxes` → `wired`**, cited to A2 (a real ACK reached the supervisor, which ran a sandbox
  lifecycle). Reason names the test and notes the sandbox is the per-op fake provider (real E2B is E7-1).
- **`E7-1-coding-journey` STAYS `unwired`.** No real-E2B distributed run. Promoted only by a cited dispatched run
  (Step 2). This is the programme's central vacuous-green trap; the step does not spring it.
- **`E4-3` / `E5-3` untouched** — this step wires neither `createStartupReconciler` nor `createPatchApplyService`.

**Promotion is contingent on the evidence landing and surviving the adversarial review (§9).** If the composed-loop
test cannot be made non-vacuous (a surviving M0/M1/M2), the clauses stay `unwired` and the step records "evidence
attempted, promotion withheld" — an honest state.

---

## 8. Step 2 — the real-E2B dispatch (prepared, then STOP)

`workflow_dispatch` is unavailable off `main`, so the keyed lane fires only on a **sentinel push**:

```bash
# operator, with E2B_API_KEY already in repo secrets:
printf '\nkeyed-e2b re-trigger (Sprint 5 Step 2): CLI-006/D2 real-E2B journey.\n' >> .github/keyed-e2b-trigger
git commit -am "keyed-e2b: fire Sprint 5 Step 2 real-E2B journey" && git push origin docs/replatform-program
```

Capture: the run id/URL; the keyed suite result (the artifact-commit case must PASS, not skip); confirmation no
`E2B_API_KEY`/redeemed value appears in any log. **This keyed lane proves the provider/adapter primitives, NOT the
distributed journey — it does NOT promote E7-1.** The E7-1-promoting run is the **staging/testing-instance canary
campaign** the E7 exit gate names (`docker-compose.staging.yml` / `testing.armyofagents.org`) — an operator
campaign with real spend, owed after this step. Until a dispatched run of THAT is cited, E7-1 stays `unwired`.

---

## 9. Adversarial review (before done)

Independent reviewers, one per changed dimension (composition-fidelity, credential/no-leak security,
promotion-honesty, completeness). A **skeptic** told to REFUTE each HIGH (refuted-by-default if not reproducible
from source). A **completeness critic** asked exactly: *"is the composed loop's lease REAL or hand-fed; does the
credential value provably never reach a log/event; and is the E4-1/E4-2 promotion honest or a fake-plane vacuous
green?"* Not delegated to a plan-writing or auto-fixing skill.

## 10. Registers + CI honesty

- Five registers green; `check-gate-clause-wiring` reflects the E4-1/E4-2 promotion (with cited reasons) and E7-1
  still `unwired`; `check-test-inventory` bumped for the new `.test.ts` (worker-daemon pin, read current value);
  `check-execution-census` untouched (no new `*.test.mjs`); `environment-variables.md` untouched (no new `AOA_*`).
- **`verify` inherits the §2.0 red** (pre-Sprint-0 timeout regression) and, honestly, a **second** pre-existing
  red predating this step: `job-leasing-contract.test.ts` "enforces an exhaustive authority-writer allowlist"
  fails because WRK-011's `refreshWorkerProfile` is missing from that contract's hardcoded allowlist
  (`server/src/__tests__/job-leasing-contract.test.ts` `expected`). It reproduces on the clean tree (CLI-007-result
  §7). Out of CLI-006/D2 scope; recorded in the result doc, and filed as a finding if not already owned. The
  `verify` timeout is **not** raised.

## 11. Definition of done for THIS step

1. This design committed (Start SHA).
2. The composed-journey test built fail-first (§4), non-vacuous (§5), green locally.
3. E4-1/E4-2 promoted **iff** the evidence lands and survives review; else withheld with a reason.
4. Leg B attempted; whatever lands cited, whatever does not named as owed.
5. Step-2 dispatch prepared (§8); session STOPS at the boundary (no `E2B_API_KEY`, no trigger unless a run is
   in hand).
6. `CLI-006-D2-step1-result.md` written; GO-BOOK §3.1 + §4 Sprint 5 updated to the true state.
7. Registers green; commit, push, CI reported honestly (verify inherits §2.0 red + the allowlist red).
