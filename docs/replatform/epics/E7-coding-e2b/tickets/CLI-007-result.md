# CLI-007 — result: a canary-aware credential path (E7-F001 resolved)

**Epic:** E7 · **Sprint:** 5a · **Start SHA:** `20bf9a698` (design) · **Status:** SHIPPED
**Resolves:** finding **E7-F001** (status flipped + `finding-ownership.json` key deleted in the fix commit)

---

## 1. What shipped

A real canary placement now mints a Company `provider_key` execution-secret handle, so its lease envelope
carries a non-empty `secretHandles` and the worker redeems a real credential inside the sandbox.

**TWO blockers, both fixed** (the second was found by the adversarial review — see §6). E7-F001 as filed
named only guard 4; the review caught that a real canary refuses one gate earlier, at guard 2. The scope was
expanded (with sign-off) to fix both:

1. **Guard 2 — the executor gate (a pre-existing DAT-008 slice-1 gap).** The mint gated the EXECUTOR on
   `executorPrincipalKind === "agent"`, but NO execution source stamps an `"agent"` executor — the frozen
   authority (Decision #121) makes `task_run`/`crew_run`/`one_shot` executors `worker`/`sandbox`, and `"agent"`
   is only ever a *requester* kind. So the mint had **never minted for any real run**. Fix: a pure predicate
   `isAgentBackedExecutorKind` (`execution-secret-handle-mint.ts`) admits `worker`/`sandbox` (`"agent"` kept as a
   defensive superset), and the real coding gate is guard 3 (v1 adapter) + the agent-binding lookup keyed on
   `executorPrincipalId`. The runner's binding-load gate uses the same predicate.
2. **Guard 4 — the owner-authority gate (the canary-specific block).** The MIG-008 preflight — which already
   verifies the Company holds provider-control authority (`currentKeyGeneration !== null`) — emits
   `credentialAuthority: "company_api_key"` on its `ok` result (none on a refusal); `resolveRunExecutionOwner`
   threads that to placement as `mintCredentialAuthority`; and the mint sources its `credentialKind` from that
   **out-of-band** authority via `mintCredentialKindFor`. The four-null canary placement binding is **unchanged**,
   so the replay digest stays byte-identical and routing is untouched, and the gate function is unmodified.

| File | Change |
|---|---|
| `server/src/services/execution-secret-handle-mint.ts` | **guard 2** — new pure predicate `isAgentBackedExecutorKind`; the executor gate keys off the real coding-execution kinds (worker/sandbox) instead of the phantom `"agent"` |
| `server/src/services/execution-secret-handle-mint-runner.ts` | the agent-binding load gate uses `isAgentBackedExecutorKind` |
| `server/src/services/canary-mint-authority.ts` | **new pure module** — `CANARY_CREDENTIAL_AUTHORITY = "company_api_key"` + `mintCredentialKindFor` (out-of-band override, `?? ` semantics) |
| `server/src/services/canary-preflight.ts` | `ok` result carries `credentialAuthority`; refusal carries none (fail-closed by shape) |
| `server/src/services/run-execution-owner.ts` | step 4 threads `gate.credentialAuthority` → `place({…, mintCredentialAuthority})` |
| `server/src/services/job-placement.ts` | `PlaceJobAttemptInput.mintCredentialAuthority?` (out-of-band; default unset = legacy behaviour) |
| `server/src/services/job-placement-transaction.ts` | mint call sources `credentialKind` via `mintCredentialKindFor(input.mintCredentialAuthority, authority.credentialBinding.credentialKind)` |
| `server/src/services/canary-credential-binding.ts` | **prose only** — the four-null constant is unchanged; header updated (the old "no writer / secretHandles:[]" claim was stale) |
| tests | new `cli-007-canary-credential.test.ts` (seam + no-leak); new `[CLI-007]` cases in `job-placement.integration.test.ts` (embedded-PG round-trip); new cases in `cli-006-canary-preflight.test.ts` + `cli-006-run-execution-owner.test.ts`; prose in `cli-006-canary-credential-binding.test.ts` |

## 2. The mutation line (DELETE the guard, positive control first)

Every guard/seam mutation-tested by DELETION; positive control confirmed first each time. **All RED as
required; all restored green.**

| Guard / seam | Mutation | Result |
|---|---|---|
| positive control | force `mintCredentialKindFor` → fixed `"NOPE"` | 3 seam tests RED (the tests drive the function) |
| `mintCredentialKindFor` `?? ` override | delete the override → binding only | canary case RED |
| transaction call site (composition) | revert to `authority.credentialBinding.credentialKind` | embedded-PG `[CLI-007]` mint test RED (`expected +0 to be 1` — zero handles) |
| ownerResolver threading | delete `mintCredentialAuthority: gate.credentialAuthority` | thread test RED |
| preflight emission | drop `credentialAuthority` from the `ok` return | preflight test RED |
| preflight fail-closed shape | make the refusal ALSO carry an authority | refusal-carries-none test RED |
| **replay guard** (binding four nulls) | set `credentialKind: "company_api_key"` on the binding | 3 binding tests RED — this is the exact replay-breaking change the ticket exists to avoid |
| **gate** (`ownerAuthoritiesAgree` null arm) | delete `if (placementOwner === null \|\| credentialKind === null) return false;` | mint test RED (a null credentialKind wrongly passes the gate) |
| **guard 2** (`isAgentBackedExecutorKind` admits worker/sandbox) | positive control (predicate → false): 18 mint + 9 runner RED. Revert to `kind === "agent"` only | the real-kind tests RED (worker/sandbox no longer mint) — and the embedded-PG `[CLI-007]` real-`worker` test RED |

> One honest note: the M-GATE deletion first appeared to *survive* because a `perl -0pi -e 's/…\n//'`
> anchor did not match CRLF line endings, so the line was never removed — the go-book's exact "print
> whether your anchor matched" trap. Re-run with a CRLF-aware `\r?\n` anchor, the guard's null arm is
> load-bearing (mint test RED). Recorded because a false "survivor" is worse than a real one.

## 3. The replay-invariant proof

`CANARY_CREDENTIAL_BINDING` stays four explicit nulls — it is the **sole credential input** the placement
digest hashes (`authorityFacts.credentialBinding` → `canonicalPlacementAuthorityDigest`,
`job-placement.ts` / `job-placement-transaction.ts`). `mintCredentialAuthority` is never placed in
`authorityFacts`; it is read **only** at the mint call, which runs *after* the digest is computed and
*after* the replay early-return (`if (existing) { … return existing; }`) — so on a retry the mint code
does not even run. Proven at embedded-PG (`job-placement.integration.test.ts` `[CLI-007] mints a Company
provider_key handle …`): placing the same attempt twice yields an identical `inputDigest` and exactly one
`job_secret_handles` row. The binding suite (`cli-006-canary-credential-binding.test.ts`) is the guard: a
mutant that enriches the binding turns three of its assertions RED.

## 4. The security argument (Decision #104 — the Company key never leaves the sandbox, never logs)

The change moves only a credential *kind* enum literal through the placement path; the key *value* is
touched by no changed code.
- The mint stores a **reference**: `refKind:"provider_key"`, `refId: target.secretName` (a name like
  `provider:anthropic`), `envTarget:` an env-var name. No value column exists on the insert.
- The lease envelope ref (`toSecretHandleRefs`) carries only `handleId` (opaque UUID) + a materialization
  **target env-var name** + `usePolicy`. No value.
- The value is resolved **only inside the sandbox** (`usePolicy:"sandbox_local_only"`), and the worker
  redeems on `materialization.kind === "env" && usePolicy === "sandbox_local_only"`
  (`worker-daemon/.../lease/secret-redemption.ts`) — NOT on `refKind` — so a `provider_key`/env handle is
  redeemed and its value **seeded as a per-run redaction canary** into both the supervisor and fence-close
  streams before `provider.create` (DAT-008 slice 5). That S4 tripwire is now **armed** for the canary; a
  planted leak is caught.
- No changed server path logs a value; the fix in fact **stops** the steady-state
  `job.execution_secret_mint.refused` warning for canaries (they now mint instead of refusing).
- Fail-closed both ways: a canary whose preflight refuses goes legacy before placement (no mint); a canary
  reaching the mint with no authority sources `null` from the binding and the mint refuses — no handle,
  visible degradation, never a double-execution or a leaked key. Proven by `[CLI-007] mints NO handle when
  the canary presents no authority`.

An independent security reviewer (subagent, source-only) confirmed all four points and could not construct
a leak scenario. `packages/worker-protocol` (FROZEN) is untouched — `git diff` over it is empty; no frozen
op, no new field on a frozen schema.

## 5. The boundary: this UNBLOCKS but does NOT promote E7-1

`E7-1-coding-journey` stays **dormant** in `scripts/gate-clause-wiring.json` (untouched). CLI-007 removes the
last *code* blocker so the Sprint 5 journey is now runnable, but promotion still requires a **cited
dispatched real-E2B run** of the full journey (create → schedule → lease → stage → execute → stream →
produce → review → cancel → audit), which needs the operator's E2B key and a staging/testing-instance canary
campaign (go-book §4 Sprint 5). CLI-007 makes that run *possible*; it does not stand in for it.

## 6. Adversarial review

Five independent subagent reviewers (one per dimension changed) + a refute-first skeptic, all source-only.

- **Security (Decision #104):** 0 findings. Verified the mint stores only references (secret NAME + env-var
  NAME), the envelope carries no value, the value resolves only in-sandbox, no changed path logs a value, and
  frozen `worker-protocol` is untouched. Could not construct a leak scenario.
- **Replay invariant:** 0 findings. `mintCredentialAuthority` is absent from `authorityFacts`/the digest along
  every traced path; consumed only at the mint call, after the digest and the replay early-return; routing reads
  the binding, not the authority. The `[CLI-007]` replay assertion is non-vacuous.
- **Gate strength / fail-closed:** 0 blocking. `ownerAuthoritiesAgree`/`decideExecutionSecretHandle` textually
  unchanged (git diff empty); still refuses null/disagreement; `mintCredentialAuthority` reachable only on the
  canary branch after `state==="canary"` + preflight `ok`; non-canary passthrough byte-identical. 1 LOW (a stale
  test-file cross-reference) — fixed.
- **Completeness critic:** builds-vs-consumes lines up end to end — the worker redeems on
  `materialization.kind==="env" && usePolicy==="sandbox_local_only"` (not `refKind`), the provider mapping
  (`claude_local`→`ANTHROPIC_API_KEY`/`provider:anthropic`) matches the worker allowlist, and the S4 redaction
  tripwire is armed for the CLI-007-minted key. E7-1 correctly stays unwired; E7-F001 bookkeeping consistent.
- **Composition / correctness — the one that mattered: CONFIRMED HIGH.** It found that a real canary refuses at
  **guard 2** (`executor_not_agent`) before reaching the guard-4 fix, because no execution source stamps an
  `"agent"` executor (Decision #121). A refute-first **skeptic** could not kill it — all four refutation paths
  failed, and it noted the design doc's own inverted claim. I verified it from source (exhaustive enumeration of
  every executor-kind producer; no normalization; DAT-008's own tests manufacture `"agent"`). **This invalidated
  the "sole block is guard 4" premise; work was stopped and the scope was expanded with sign-off to fix guard 2**
  (§2b). The CLI-007 tests were switched from a manufactured `'agent'` executor to the REAL `'worker'` shape —
  the honest test the skeptic asked for — and now fail-first RED before the guard-2 fix, GREEN after.

The review functioned exactly as the programme intends: four dimensions cleared the guard-4 fix, and the fifth
caught a real, HIGH, pre-existing defect that the guard-4 fix alone would have papered over.

## 7. Registers and CI (honest)

- All six registers green: `check-ticket-graph-coverage`, `check-gate-clause-wiring` (E7-1 stays dormant),
  `check-finding-ownership` (10 open findings; E7-F001 gone), `check-guard-inventory`, `check-test-inventory`
  (`server` floor 1475 → 1476, no bump; `packages/worker-daemon` pin untouched), `check-execution-census`
  (new `.test.ts`, not `.mjs` — untouched). No test-inventory manifest change was needed.
- `verify` inherits the pre-existing **§2.0 red**; the timeout was NOT raised. While running the affected
  suites I confirmed one pre-existing failure that is **not** CLI-007's:
  `job-leasing-contract.test.ts` "enforces an exhaustive authority-writer allowlist" fails on
  `packages/db/.../worker-enrollment.ts#refreshWorkerProfile` (a WRK-011 writer missing from that contract's
  hardcoded 21-item allowlist). It reproduces identically on the clean design-only tree (before any CLI-007
  code), so it is pre-existing baggage `verify` already carries, not a regression, and it is out of this
  ticket's scope (worker-enrollment authority-writer contract, unrelated to the canary credential path).
- Local proof: unit suites run on Windows in `C:\e3`; the embedded-PG `[CLI-007]` round-trip runs with
  `AOA_RUN_WIN_INTEGRATION=1` (and on Linux CI). Full `job-placement.integration.test.ts` = 23 passed.
