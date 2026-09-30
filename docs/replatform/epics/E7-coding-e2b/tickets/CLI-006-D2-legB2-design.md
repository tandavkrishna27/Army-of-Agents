# CLI-006 / D2 — Sprint 5b: Leg B Part 2 (the credential resolve over a LIVE fence) + the staging-canary runbook

**Status:** `design` (Sprint 5b, the E7-1-promoter campaign). This is the **continuation** of
`CLI-006-D2-step1-{design,result}.md`: Step 1 promoted `E4-1`/`E4-2` on evidence and left **Leg B
Part 2** (the credential resolve over a live fence — DAT-008 slice 5 §8's residual) and the operator
staging-canary campaign owed. **Maps to the existing `CLI-006` graph node** — no new `#### ID` node.
**Pre-step tip:** `07f80a165`. **Start SHA:** the commit that lands this file + the runbook.
**Frozen, untouched:** `packages/worker-protocol`, the worker-daemon `SandboxProvider` port, the
`DE-*`/threat docs. No new hosted-API call (Rule #11). No new `AOA_*` switch.

> **The one-sentence honest state going in.** Every prior sprint proved a HALF of the credential
> resolve: DAT-008 slice 5 proved *the wire + fail-closed denial + proof-over-path binding* against the
> real route but **deliberately never a live `resolved` value** (`no-such-fence`); CLI-007 proved *the
> mint writes exactly one handle* but never resolved it; the unit tests proved *`admitSandboxLocalResolution`
> returns the value* and *`synthesiseRunSecrets` threads it* — but with a fabricated broker. **No test has
> ever aligned a real active fence + a minted handle + a Company provider-key store so the worker's real
> redeemer gets a genuine decrypted value back.** That alignment is Leg B Part 2, and it is what this
> step builds. It does **not** reach real E2B, and it does **not** promote E7-1.

---

## 1. The boundary — session vs operator (go-book §4 Sprint 5 / Sprint 5b)

Stated up front and held to:

- **The SESSION does (this step):** verify every hop's wiring against source; build/repair the missing
  journey harness (Leg B Part 2) fail-first; run everything that runs **without** live staging or a real
  key (unit, embedded-PG); write the operator **runbook** for arming a canary Organization on the
  staging substrate. **No real E2B, no key, no spend.**
- **Only the OPERATOR does:** stand up / reach the staging substrate (`docker-compose.staging.yml` —
  which has **no live bring-up pipeline today**; see the runbook §0), arm the canary Organization,
  supply the `E2B_API_KEY` (a provider secret — never handed to the session), and run the campaign.
- **E7-1 promotion (the programme's central vacuous-green trap).** `E7-1-coding-journey` is `unwired`
  with `expectedReferences: 2`. Promote to `wired` **ONLY** on a cited dispatched real-E2B run that
  completed the DISTRIBUTED journey (create/schedule/lease/review) end to end — **never** on the keyed
  provider lane, a D1 fake-provider run, or a local harness. **This step reaches no real E2B, so E7-1
  STAYS `unwired`** and the honest end-state is "campaign harness + runbook ready, staging run owed" —
  a legitimate, respected outcome (go-book §4 Sprint 5, Sprint 5b).

**The vacuous-green line Leg B Part 2 must hold.** This step wires **no** gate-clause symbol — it
promotes nothing. `E5-5-redaction` is already `wired` (DAT-008 slice 5) and `E4-1`/`E4-2` are already
`wired` (Step 1); Leg B Part 2 is **additional evidence** for the existing `E5-5` residual, not a new
promotion. So there is no checker to satisfy mechanically; the deliverable is a **non-vacuous test**
proving a genuine `resolved`, and the mutation table (§5) is how "non-vacuous" is proven.

---

## 2. Terrain — verified at tip `07f80a165` (each fact re-read from disk)

| # | Fact | Evidence (file:symbol) |
|---|---|---|
| 2.1 | The resolve route delegates to the REAL broker, not the fail-closed default. `workerControlRoutes` constructs `createSecretBrokerService({ appDb: opts.db, brokers: createExecutionSecretBrokers(opts.db) })` — the real value store. | `server/src/routes/worker-control.ts` (`executionSecrets` construction, resolve route `POST /worker-control/execution-secrets/resolve`) |
| 2.2 | `resolve()` runs ONE `runInTenant` tx: `resolveWorkerFenceContext` (fence identity first) → `repos.jobControl.resolveExecutionSecret` (`guardActiveFence` FIRST, then `authorizeSecretResolve`, audit-as-columns, returns the authorized NON-secret binding) → `dispatchResolvedSecret` (obtains the VALUE from the broker). Every failure collapses to HTTP **200** `{outcome:"denied"}`. | `server/src/services/secret-broker.ts` `createSecretBrokerService.resolve`; `packages/db/.../tenant/job-control.ts` `resolveExecutionSecret`/`guardActiveFence`; `server/src/routes/worker-control.ts` resolve route (`denyMalformed`, `admitSandboxLocalResolution`) |
| 2.3 | The **fence IS the active lease.** `guardActiveFence` `SELECT … FOR UPDATE` locks the `leases`+`job_attempts` rows matching the full fence tuple (org/company/job/attempt/leaseId/workerId/targetId/authorityKey/**generation**/profileHash/constraintHash) **and** `leases.fence === request.fenceToken`; no row → `stale_fence`; a target-generation cutoff → `target_revoked`. "Over a live fence" means this guard admitted the request. | `packages/db/.../tenant/job-control.ts` `guardActiveFence`; `server/src/services/worker-fence-context.ts` `resolveWorkerFenceContext` |
| 2.4 | For a `provider_key` handle the VALUE comes from `secrets.resolveByName(companyId, "provider:<id>", {consumerType:"system"})` → `resolveSecretValue` → `local-encrypted-provider.resolveVersion` (AES-256-GCM, master key from `AOA_SECRETS_MASTER_KEY`). A `company_secrets` row named `provider:anthropic` (provider `local_encrypted`, active) with a `current` version is all it needs — **fully embedded-PG seedable**, no adapter-manager, no live E2B. | `server/src/services/execution-secret-brokers.ts` `resolveProviderOrCompanySecret`; `server/src/services/secrets.ts` `resolveByName`/`resolveSecretValue`; `server/src/secrets/local-encrypted-provider.ts` |
| 2.5 | The offer ADVERTISES stored handles: the leasing path emits `secretHandles: toSecretHandleRefs(storedHandles)`, so a `job_secret_handles` row on the job reaches the composed loop's `handoff.offer.job.secretHandles`. | `server/src/services/job-leasing.ts` (`toSecretHandleRefs(storedHandles)`) |
| 2.6 | The worker-side redemption the composed runtime runs: `materializeRunSecrets` builds `createRedeemer({client, key, session, fence:{workerId, jobId, attempt, leaseId, fenceToken}})` from `handoff` and calls `synthesiseRunSecrets(handoff.offer.job.secretHandles ?? [], redeem)`. `synthesiseRunSecrets` redeems only `env`+`sandbox_local_only` handles whose target ∈ `{ANTHROPIC_API_KEY, OPENAI_API_KEY}`, returns `{env, canaries}`, and throws `SecretMaterializationError` on any non-`resolved` outcome. | `packages/worker-daemon/src/lifecycle/dispatch-runtime.ts:134-151`; `packages/worker-daemon/src/lease/secret-redemption.ts` `synthesiseRunSecrets`/`createRedeemer`/`classifyResolveResponse` |
| 2.7 | The DAT-008 slice 5 embedded-PG test stops SHORT of a live `resolved` on purpose: it constructs the redeemer with `fenceToken:"no-such-fence"`, seeds **no** handle and **no** company key, and asserts `denied`. Its header names the gap: "The RESOLVED-path value return over a live fence … is Sprint 5's journey." | `server/src/__tests__/execution-secret-resolve-worker.integration.test.ts` (header §40-58; `no-such-fence`) |
| 2.8 | Leg B Part 1 already stands up embedded-PG + the real `workerControlRoutes`, seeds a ratified target + a PROVISIONED worker + a lease-eligible attempt, mints a real session, and drives `createPollLoop` to a REAL server-minted **active lease** (attempt→`leased`, lease→`active`, `lease_ack` receipt). The handoff it collects carries `.fenceToken` + `.offer.job.secretHandles`. | `server/src/__tests__/composed-loop-real-server.integration.test.ts` (`seed`, `mintSession`, the poll-loop drive) |
| 2.9 | A Company model-provider key is written by `secretService(db).create(companyId, {name:"provider:<id>", provider:"local_encrypted", managedMode:"aoa_managed", value})` → `company_secrets` (active, latestVersion 1) + `company_secret_versions` (version 1, current, encrypted material). This is the real encryption chokepoint. | `server/src/services/secrets.ts` `create`; `server/src/services/providers/provider-key.ts` `saveProviderKey` (the production caller) |
| 2.10 | `E5-5-redaction` is `wired` (DAT-008 slice 5) on `synthesiseRunSecrets`; `E4-1`/`E4-2` are `wired` (Step 1). **Leg B Part 2 promotes nothing** — it is additional evidence for the `E5-5` "resolved-value proven only at unit level" residual. `E7-1` stays `unwired`. | `scripts/gate-clause-wiring.json` |
| 2.11 | The distributed-journey substrate has **no live bring-up pipeline**: `docker-compose.staging.yml` is deploy-intent only (render-checked), `staging.md` defers real multi-host/external-store bring-up to "the deploy pipeline / a REL ticket", and `deploy-testing.yml` stands up the single-node `cloud_auth` **app**, NOT the two-CP/four-worker/adapter-manager fleet. Arming the canary is therefore an operator INFRASTRUCTURE step, not merely a config flip. | `docker-compose.staging.yml`; `docs/deploy/staging.md`; `.github/workflows/deploy-testing.yml` |

**What this terrain settles.** The live-fence resolve has never been demonstrated end-to-end; the
pieces to demonstrate it in-process (real routes + real broker + real fence via Leg B Part 1 +
real encryption via `secretService.create`) all exist. The one missing thing is a test that
**aligns them in one harness** so the worker's real redeemer gets a genuine value.

---

## 3. What this step delivers

**A. Leg B Part 2 — the live-fence resolve harness**
(`server/src/__tests__/composed-loop-secret-resolve.integration.test.ts`, new; `server` is a test-inventory
**floor**, so no pin bump). It fuses Leg B Part 1's real-server poll→ack harness with a seeded Company
provider-key store and a minted `provider_key` handle, then drives the worker's REAL redemption over the
REAL resolve route on the SERVER-MINTED fence:

| Hop | What the harness really does | Assertion (turns RED if the hop breaks) |
|---|---|---|
| **lease + fence** | `createPollLoop` (real clock) polls the real server, is offered the seeded attempt, ACKs it → a real active lease; the collected handoff carries `.fenceToken` + `.offer.job.secretHandles` | the offer advertises exactly the minted `provider_key`/env/`ANTHROPIC_API_KEY` handle; the DB shows the lease `active` (Leg B Part 1's proven ACK-specific facts) |
| **credential resolve (LIVE fence)** | replicate `dispatch-runtime.ts:138-150`'s `materializeRunSecrets` VERBATIM (real `createRedeemer` + `synthesiseRunSecrets`) against the real route, using the handoff's real fence tuple | `env.ANTHROPIC_API_KEY === <the exact plaintext seeded into company_secrets>`; exactly one resolve; the value is returned as a `canary` — a genuine `outcome:"resolved"` over the live fence |
| **fail-closed (negative control)** | redeem the SAME handle with a STALE `fenceToken` while the handle+key are present | `synthesiseRunSecrets` throws `SecretMaterializationError`; the resolve returned `denied` — isolating the LIVE FENCE as the discriminator (the DAT-008 property, re-proven with a real handle+key present) |
| **no-leak (Decision #104)** | the redeemed value is returned ONLY in `env` + the `canary` array; the audit is columns-only | `job_secret_handles.resolve_count` incremented (audit-as-columns); the handle table has NO `value`/`secret_value` column; the value is registered only as a redaction canary. **Scope:** this is a CONTAINMENT check, not a log-redaction proof — the harness captures no logs (the routes are built with no logger, and the redaction *mechanism* that scrubs a value from a stream is DAT-008's, not re-proven here) |

**B. The operator runbook** (`CLI-006-staging-canary-runbook.md`) — exactly what arming a canary
Organization on the staging substrate requires (the rollout dial, the preflight's per-Company
provider-key generation, the enrolled worker, the E2B key), the exact commands, where the evidence
lands, and the honest note that the distributed substrate has no live bring-up today.

**C. The campaign result** (`CLI-006-campaign-result.md`) — which hops are proven on real E2B (none
through the distributed journey yet), which locally, E7-1 held `unwired`, and the exact operator steps
still owed.

### 3.1 Why the harness is honest evidence for the residual (not a mock of the resolve)

Every element the resolve depends on is REAL: the route (`workerControlRoutes`), the fence
(`guardActiveFence` over a server-minted active lease), the broker (`createExecutionSecretBrokers` → the
real `company_secrets` store), the decryption (`local-encrypted-provider`, real AES-256-GCM), and the
worker's redeemer (`createRedeemer`/`synthesiseRunSecrets`, replicated line-for-line from
`dispatch-runtime.ts`). What is NOT real is the **provider key value** (a synthetic random string, never
a real Anthropic key — the whole point of Decision #104's containment) and the **sandbox** (there is
none — the value is asserted in `env`, not forwarded to E2B; that forwarding is E7-1). Those two gaps
are named, not hidden: the value is deliberately synthetic, and real E2B is E7-1, which stays `unwired`.

---

## 4. Fail-first TDD

Every step is written to fail for a **named** reason first, then made green by the minimal change.

1. **Positive control on the value store.** Write the full happy-path case end to end, but run it
   **before** seeding the `company_secrets` `provider:anthropic` row. The lease + fence + handle are
   real, so the resolve reaches the broker — which throws `secret_not_found` → `dispatchResolvedSecret`
   catch → `{denied, malformed}` → route returns 200 `denied` → `synthesiseRunSecrets` throws
   `SecretMaterializationError`. **RED for the stated reason** (no Company key ⇒ fail-closed, the
   DAT-008 contract on a real handle+fence). Confirms the test drives the real value store, not a stub.
2. **Seed the Company key** (`secretService.create`, real encryption). Re-run: the credential +
   no-leak assertions go GREEN — `env.ANTHROPIC_API_KEY` equals the exact seeded plaintext, one
   resolve, the canary present. **This is the first time a worker redeems a real credential over a live
   fence in this programme.**
3. **The fail-closed negative control** (a permanent case): redeem the SAME real handle+key with a
   STALE `fenceToken`. Asserts `denied` → throws — proving the resolve is not rubber-stamping and the
   live fence is the discriminator. (Mirrors DAT-008's `no-such-fence`, but now with the value present,
   so the ONLY difference from the happy case is the fence.)

---

## 5. Mutation table — proving the harness is non-vacuous (DELETE / break, positive control first)

The production code under demonstration already exists (resolve route + broker + `guardActiveFence` +
`synthesiseRunSecrets`), so — exactly as Step 1 and Leg B Part 1 — the mutation discipline proves **the
new test would turn RED if the resolve behaviour broke**. Each mutant is a temporary edit, reverted
after; a worker-daemon mutation needs `pnpm --filter worker-daemon build` because the server test
imports the **built** package (Leg B Part 1's documented dist-rebuild gotcha).

| # | Mutation (DELETE / break) | Rebuild? | Expected RED assertion |
|---|---|---|---|
| M0 | **Positive control** — `synthesiseRunSecrets` returns `{env:{},canaries:[]}` (drop the redemption) | worker-daemon | happy `env.ANTHROPIC_API_KEY` + canary RED — proves the test drives the REAL redemption |
| M1 | `execution-secret-brokers.resolveProviderOrCompanySecret` returns a fixed non-key string | no (server-src) | happy `env.ANTHROPIC_API_KEY === <seeded plaintext>` RED — proves the REAL decrypted value flows end to end, not any constant |
| M2 | the resolve route returns `value:"x"` on the `resolved` branch (`admitted.value` → `"x"`) | no (server-src) | happy value-equality RED — proves the route returns the resolved value, not a placeholder |
| M-neg | (built-in, not a mutation) the negative-control case redeems with a STALE `fenceToken` | — | asserts `denied`/throws — proves the LIVE FENCE discriminates (a fence-guard mutation without touching the frozen-adjacent db package) |

**Report line to reproduce in the result doc:** *N mutants, N killed, 0 survivors, 0 false kills; every
mutant COMPILES and RUNS and is killed by an ASSERTION; every production mutation reverted (and the
worker-daemon dist rebuilt back).* A surviving mutant is a QUESTION (go-book §2.2), resolved before any
claim. **No new production guard is added, so there is no delete-the-guard obligation** — the mutation
table's job here is non-vacuity of the demonstration, per the Step 1 precedent.

---

## 6. Acceptance — every clause to a test that can turn RED

| # | Clause | Test | Tier |
|---|---|---|---|
| A1 | The composed loop leases a real server-minted attempt whose offer advertises the minted `provider_key` handle | Leg B Part 2 happy case — offer `secretHandles` carries the env/ANTHROPIC handle; lease `active` in DB | embedded-PG |
| A2 | The worker's real redeemer resolves that handle over the real route on the LIVE fence and gets the real value | happy case `env.ANTHROPIC_API_KEY === <seeded plaintext>`; one resolve | embedded-PG |
| A3 | A stale/absent fence fails the resolve CLOSED (no value) | negative-control case (stale fence → `denied` → throws) + fail-first step 1 (no key → `denied`) | embedded-PG |
| A4 | The value is contained (Decision #104) — audit-as-columns only, no value at rest | `resolve_count` incremented; the `job_secret_handles` table has no `value`/`secret_value` column; the value is registered only as a redaction canary (a CONTAINMENT check, not a log-capture assertion — see §3 no-leak row) | embedded-PG |
| A5 | Frozen wire untouched | `git diff -- packages/worker-protocol` empty; `check-frozen-worker-protocol-consumer` | repo guard |
| A6 | No new operator switch shipped undocumented | `AOA_SECRETS_MASTER_KEY`/`AOA_RUN_WIN_INTEGRATION` already documented; no new `AOA_*` | repo guard |

---

## 7. Promotion disposition

- **No gate-clause promotion.** Leg B Part 2 is additional evidence for the already-`wired`
  `E5-5-redaction` residual; it wires no new symbol.
- **`E7-1-coding-journey` STAYS `unwired`.** No real-E2B distributed run. Promoted only by a cited
  dispatched staging-canary run (the operator campaign). This is the programme's central vacuous-green
  trap; the step does not spring it.
- **`E4-1`/`E4-2` untouched** (already `wired`, Step 1). `E4-3`/`E5-3` untouched.

---

## 8. Adversarial review (before done)

Independent reviewers, one per changed dimension (harness-fidelity: is the fence server-minted and the
value real; credential/no-leak security: Decision #104 containment on the live-resolved path;
completeness critic: "does the evidence chain reach real E2B through the distributed journey, or does it
stop at embedded-PG — and is that boundary stated honestly?"). A **skeptic** told to REFUTE each HIGH
(refuted-by-default if not reproducible from source). Not delegated to a plan-writing or auto-fixing
skill.

## 9. Registers + CI honesty

- Five registers green; `check-gate-clause-wiring` unchanged (E7-1 still `unwired`); `check-test-inventory`
  — `server` is a **floor**, one new file leaves it ≥ floor, no bump; `packages/worker-daemon` pin
  untouched (no new worker-daemon test); `check-execution-census` untouched (no new `*.test.mjs`);
  `environment-variables.md` untouched (no new `AOA_*`).
- **`verify` inherits the §2.0 red** (pre-Sprint-0 timeout regression — NOT raised, NOT masked).

## 10. Definition of done for THIS step

1. This design + the runbook committed (Start SHA).
2. The Leg B Part 2 harness built fail-first (§4), non-vacuous (§5), green locally
   (`AOA_RUN_WIN_INTEGRATION=1` on Windows; Linux CI).
3. No gate-clause promotion; E7-1 stays `unwired`.
4. `CLI-006-campaign-result.md` written with the operator boundary + the exact owed staging steps.
5. GO-BOOK §3.1 + §4 Sprint 5 updated to the true state.
6. Registers green; commit, push, CI reported honestly (verify inherits §2.0 red).

If anything mid-step invalidates the premise, STOP and say so.
