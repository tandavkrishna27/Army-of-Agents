# CLI-007 — A canary-aware credential path for the coding journey (E7-F001 successor)

**Epic:** E7 · **Plan node:** `docs/replatform/program-design.md`, `#### CLI-007`
**Depends on:** CLI-006, DAT-008 (slice 5) · **Size:** M · **Status:** design (Sprint 5a)
**Owns:** finding **E7-F001** (`epics/E7-coding-e2b/findings.md`)

> **Sprint 5a.** The one code blocker between "harness ready" and a runnable real-E2B journey.
> Pure code — no E2B key, no dispatched run, no operator step. Landing it makes the Sprint 5
> journey *runnable*; the dispatched run that finally promotes **E7-1** is a separate, operator-owned
> step (go-book §4 Sprint 5).

---

## 0. Verified state at tip `40de74865` (the finding was filed at `88c6a8b66`; the tree moved)

Every path:line below was opened and read at the worktree tip. Where a living document disagrees with
the disk, the disk wins and the disagreement is recorded (§3.3). Code is cited by path:line at tip;
living documents (go-book, findings register, manifest) are cited by section and id.

### 0.1 The mint gate chain, re-traced from the canary all the way to the refusal

A canary is an ordinary agent task run on a `canary`-flagged Organization whose ownership is transferred
by `resolveRunExecutionOwner` (`server/src/services/run-execution-owner.ts`). Its steps, in order
(`run-execution-owner.ts:224-286`):

1. rollout state must be `canary` (else legacy) — `:229-232`.
2. **MIG-008 preflight** `preflight.check({ organizationId })` — `:235-238`. The preflight
   (`canary-preflight.ts`) refuses unless every Company under the Organization has closed legacy
   reconciliation **and** has a current provider-control key generation
   (`currentKeyGeneration(companyId) !== null` → else `credential_authority_not_moved`,
   `canary-preflight.ts:138-144`). **This is where the Company's provider-control authority is
   established.** A refusal returns legacy; nothing downstream runs.
3. durable convert run→job — `:241-252`.
4. **placement — LAST**, because placement is what makes an attempt leasable — `:259-264`. It calls the
   E3 placement service, which resolves the credential binding and, on a live selection, mints the
   DAT-008 execution-secret handle.

The placement service is wired in `server/src/index.ts:1170-1183` with
`resolveCredentialBinding: resolveCanaryCredentialBinding` (`server/src/index.ts:1182`).

`resolveCanaryCredentialBinding` returns **four explicit nulls** (`canary-credential-binding.ts:63-79`;
the constant `CANARY_CREDENTIAL_BINDING` at `:63-68`, `credentialKind: null` at `:65`). That binding
flows into `resolveAuthority` (`job-placement.ts:455-461`) as `authority.credentialBinding` and thence
to the DAT-008 mint call as `credentialKind: authority.credentialBinding.credentialKind`
(`job-placement-transaction.ts:377`), on the canary `selected / active / lease-eligible` path
(`job-placement-transaction.ts:363-365`).

The mint (`execution-secret-handle-mint.ts:129-181`) decides in order:

| # | Guard | Real canary coding run | Source |
|---|---|---|---|
| 1 | `isCloudSandboxMode(deploymentMode)` | **pass** (`cloud_auth`) | `execution-secret-handle-mint.ts:134`; `sandbox-coding-disposition.ts:138-140` |
| 2 | executor gate | **REFUSE (original)** — a `task_run` is stamped executor `"worker"`, not `"agent"` | `:137`; `job-control.ts` `taskSourceIsAdmitted:1505`; Decision #121 |
| 3 | `gateCodingAdapterDispatch(adapterType).admitted` | would pass (`claude_local`/`codex_local` are `v1`) | `:142-144`; `sandbox-coding-disposition.ts:48-51,169-186` |
| 4 | `ownerAuthoritiesAgree(placementOwner, credentialKind)` | **REFUSE — `credentialKind === null`** | `:149-151`; `ownerAuthoritiesAgree :122-127` |
| 5 | `placementOwner === "owner_desktop"` | would pass (`managed_cloud`) | `:152` |
| 6 | `providerKeyTarget` non-null | would pass (`companyKeyTargetForAdapter` → `provider:anthropic`) | `:157`; `secrets.ts:254-262` |
| 7 | provider binding split | would mint **`provider_key`** (canary agent sets no per-agent key) | `:159-180`; `mint-runner.ts:104-121` |

**★ CORRECTION (CLI-007 adversarial review — the review caught a misdiagnosis in the E7-F001 filing and in
an earlier draft of this doc).** There are **TWO** blocks, not one, and guard 2 fires FIRST:

- **Guard 2 (executor gate).** The original mint refused unless `executorPrincipalKind === "agent"`, but NO
  execution source ever stamps an `"agent"` EXECUTOR: the frozen executor authority (Decision #121,
  `distributed-execution-legacy-parity.json`) makes `task_run`/`crew_run`/`one_shot` executors `worker`/`sandbox`
  (`job-control.ts` `taskSourceIsAdmitted:1505` → `{kind:"worker", id: agentId}`); `"agent"` is only ever a
  *requester* kind. So a real canary refuses at guard 2 and never reaches guard 4 — and this is a **pre-existing
  DAT-008 slice-1 gap**: the mint had never minted for ANY real run of any source. (An earlier draft of this
  table said guard 2 "passes … task_run → coding agent" and cited `job-submission.ts:284` — the very line that
  stamps `"worker"`. That was the inverted claim.)
- **Guard 4 (owner authority).** Once guard 2 admits, the four-null binding's `credentialKind: null` makes
  `ownerAuthoritiesAgree` return `false` (`:123`, the null arm) → refuse `owner_authority_disagreement`
  (`:149-151`) — the canary-specific block E7-F001 named.

**CLI-007 fixes BOTH** (§2 and §2b). Guards 3/5/6/7 are already satisfied for a canary coding run — the mint
has a complete Company-key `provider_key` path (`:173-180`); it was simply unreachable behind two gates.

`owner_authority_disagreement` is an **actionable** refusal (`isActionableMintRefusal`, `:104-106`); before the
fix a canary that got PAST guard 2 would emit `job.execution_secret_mint.refused`
(`job-placement-transaction.ts:385-393`).

`placementOwner` (guard 4's Authority A) is `decision.owner = selected.registry.targetClass`
(`job-placement.ts:653`). For a canary the four-null binding routes to the shared pool
(`chooseExecutionTargetRow` falls to `active.find(t => t.kind === "pooled_gvisor")`,
`execution-target-resolver.ts:206-208`), and a `pooled_gvisor` row can only normalize as `managed_cloud`
(`TARGET_KIND_BY_CLASS`, `execution-target-resolver.ts:52-56,150`). So **`placementOwner = "managed_cloud"`
— never null, never `owner_desktop`.** The pure mint test already proves `managed_cloud + company_api_key
+ v1 agent + no override → provider_key` (`execution-secret-handle-mint.test.ts:28-40`). The canary just
never *presents* `company_api_key`.

### 0.2 A minted handle already reaches the sandbox; the value never leaves it

If the mint writes a handle, the lease path already advertises it: `job-leasing.ts:601-604` reads the job's
active handles under the offering tenant tx and `job-leasing.ts:613` puts them on the envelope via
`toSecretHandleRefs`. That ref carries only `handleId` + a materialization **target env-var name** +
`usePolicy` — **never a value** (`execution-secret-handle-envelope.ts:39-62`). The Company key value is
resolved **only inside the sandbox** by the worker's `synthesiseRunSecrets`, which DAT-008 slice 5 seeds
as a per-run redaction canary into both the supervisor and fence-close streams **before** `provider.create`
(DAT-008 slice-5 result §1-3, §5). So the delivery machinery downstream of the mint is complete and
already leak-guarded; **the only missing piece is that the canary never mints.**

### 0.3 Registers and pins, read at tip

- `scripts/test-inventory.json`: `server` is **mode `floor`, count 1475** — adding a server test grows the
  actual and satisfies the floor with **no bump**. `packages/worker-daemon` is `pinned` (146); this ticket
  touches **no** worker-daemon test, so no pin moves. (The go-book prompt's "bump the pin" is conditional
  and does not apply here; recorded because the file, not the prompt, is the authority.)
- `scripts/check-execution-census.mjs` trips on new `*.test.mjs`; this ticket adds only `*.test.ts`, so the
  census is untouched.
- `scripts/gate-clause-wiring.json`: **`E7-1-coding-journey` stays dormant.** This ticket does **not**
  promote it — promotion needs a cited dispatched real-E2B run (go-book §4 Sprint 5). No wiring change.
- `docs/replatform/program-design.md:893` carries `#### CLI-007`, so `check-ticket-graph-coverage.mjs`
  stays green.
- All six registers are green at tip (verified before design).

---

## 1. The finding, re-confirmed

**E7-F001** (register `epics/E7-coding-e2b/findings.md`, id E7-F001): the composed canary placement path
never mints an execution-secret handle, so the lease envelope carries `secretHandles: []`, the worker
redeems nothing, and a coding CLI in the canary sandbox has no provider credential — on real E2B just as on
the D1 fake provider. Re-traced above; the mechanism is intact and the finding's citations resolve at tip
(only `canary-credential-binding.ts` line numbers shifted: the constant moved ~59-64 → 63-68 and its header
39-47 → 43-51; every other citation is exact).

---

## 2. The fix — thread a preflight-established Company authority to the mint, out of band from the binding

The mint already knows how to issue a Company-key `provider_key` handle; it refuses only because Authority B
(`credentialKind`) is null. The fix gives the canary a **legitimate, non-null Company `credentialKind`**
(`"company_api_key"`) at the mint — sourced from the authority the preflight already verifies — **without
touching the placement credential binding**, which is the sole credential input to the replay digest and to
target routing.

### 2.1 Data flow (new path in **bold**)

```
resolveRunExecutionOwner (run-execution-owner.ts)
  step 2  preflight.check(org)  ──► ok ⇒ { companyIds, credentialAuthority: "company_api_key" }   ← NEW (canary-preflight.ts)
                                    refuse ⇒ legacy (no field, nothing places)
  step 4  placement.place({ jobId, attemptId, org, company,
                            mintCredentialAuthority: gate.credentialAuthority })   ← NEW thread
                    │
                    ▼
  placeJobAttemptTransaction(input)                       (job-placement-transaction.ts)
     … resolve binding (FOUR NULLS, unchanged) → authorityFacts → digest → persist decision …
     mint call:  credentialKind: mintCredentialKindFor(                             ← NEW seam
                    input.mintCredentialAuthority,          // "company_api_key" for a canary
                    authority.credentialBinding.credentialKind)   // null (binding), the legacy source
                    │
                    ▼
  decideExecutionSecretHandle(... placementOwner:"managed_cloud", credentialKind:"company_api_key" ...)
     guard 4 AGREES (both non-desktop) → guard 7 → MINT provider_key(Company key)   (unchanged mint)
```

`mintCredentialAuthority` is consumed **only at the mint call**, which runs *after* the digest is computed
(`job-placement-transaction.ts:216`) and *after* the replay early-return
(`job-placement-transaction.ts:218-223`). It is never placed in `authorityFacts`, so it cannot enter the
digest and cannot reach routing. On a replay the mint code is not even reached (the early-return fires).

### 2.2 Why the preflight is the home of the authority

The preflight is the gate that *verifies* the Company holds provider-control authority
(`currentKeyGeneration !== null`, `canary-preflight.ts:138-144`). Emitting `credentialAuthority:
"company_api_key"` **only on its `ok` result** makes the emission causally downstream of that
verification: `resolveRunExecutionOwner` cannot reach `place()` (step 4) unless the preflight passed (step 2
returns legacy otherwise), so the mint authority is *established by* the preflight, exactly as CLI-006
scoped ("credential-generation freshness belongs to the preflight", `canary-credential-binding.ts:50-51`;
task constraint 1). A canary is a Company-authority run by construction — it structurally excludes
`owner_desktop` and always routes to `managed_cloud` (§0.1) — so the ownership *class* it rides is the
invariant `"company_api_key"`, never `"personal_subscription"`.

### 2.3 The edits

0. **New pure module** `server/src/services/canary-mint-authority.ts` — holds
   `CANARY_CREDENTIAL_AUTHORITY = "company_api_key" as const` (documented: the ownership class a canary rides
   per Decision #104) and the pure seam `mintCredentialKindFor(mintCredentialAuthority, bindingCredentialKind)
   = mintCredentialAuthority ?? bindingCredentialKind`. Deliberately pure (no `@armyofagents/db`, no drizzle),
   so the seam is directly unit- and mutation-testable on Windows without the drizzle ESM cycle. The
   preflight imports the constant; the transaction imports the seam.
1. `server/src/services/canary-preflight.ts` — add `credentialAuthority: typeof CANARY_CREDENTIAL_AUTHORITY`
   to the `ok` result variant of `CanaryPreflightResult`; emit `CANARY_CREDENTIAL_AUTHORITY` from the success
   return, only after the `currentKeyGeneration` check passes. A refusal carries no such field (fail-closed by
   shape).
2. `server/src/services/run-execution-owner.ts` — `RunExecutionPlacement.place` input gains
   `mintCredentialAuthority?: JobPlacementCredentialBinding["credentialKind"]`; step 4 threads
   `gate.credentialAuthority` into `place(...)`. (`toRunExecutionPlacement` already forwards it via its
   `{...input}` spread — the type flows through; no logic change there.)
3. `server/src/services/job-placement.ts` — `PlaceJobAttemptInput` gains
   `mintCredentialAuthority?: JobPlacementCredentialBinding["credentialKind"]` (documented as out-of-band
   from the binding/digest; `JobPlacementServiceInput` inherits it; the default `placeJobAttempt` never sets
   it → legacy/non-canary behaviour byte-identical).
4. `server/src/services/job-placement-transaction.ts` — import `mintCredentialKindFor` and use it at the mint
   call (`:377`): `credentialKind: mintCredentialKindFor(input.mintCredentialAuthority,
   authority.credentialBinding.credentialKind)`. Update the adjacent comment to explain the canary override
   and that Authority B stays independent of Authority A (`decision.owner`).
5. `server/src/services/canary-credential-binding.ts` — **the constant is unchanged (four nulls).** Update
   its stale header prose: reason #1 said "no production path mints … so a binding that named a credential
   would describe a delivery that does not happen." CLI-007 makes the canary mint via the out-of-band
   authority, so the accurate statement is: the binding stays four-null because it is the sole credential
   input to the **routing** decision and the **replay digest**, and the credential authority is delivered to
   the mint *out of band* (CLI-007) precisely so the binding need not change.
6. `server/src/__tests__/cli-006-canary-credential-binding.test.ts` — update the matching stale header prose;
   keep every assertion (they stay green because the binding is unchanged — this file is the replay/routing
   guard, see §8 M-REPLAY).

Plus the resolution bookkeeping in §10.

### 2b. The second fix — the executor gate (guard 2), added after the adversarial review

The adversarial-review composition pass (and a refute-first skeptic that could not kill it) found that a real
canary never reaches guard 4: it refuses at guard 2 (`executor_not_agent`) because the mint gated the EXECUTOR on
`executorPrincipalKind === "agent"`, a value no execution source ever produces (Decision #121). This is a
pre-existing DAT-008 slice-1 gap; the guard-4 fix alone is dead code on a real run. The scope was expanded (with
sign-off) to fix it:

- `server/src/services/execution-secret-handle-mint.ts` — new pure predicate `isAgentBackedExecutorKind(kind)` =
  `kind ∈ {"worker","sandbox","agent"}` (the real agent-backed coding execution kinds per Decision #121; `"agent"`
  kept as a defensive superset). Guard 2 becomes `if (!isAgentBackedExecutorKind(...)) return refuse("executor_not_agent")`.
- `server/src/services/execution-secret-handle-mint-runner.ts` — the agent-binding load gate uses the same
  predicate, and `executorPrincipalId` is the agent id for those kinds (`taskSourceIsAdmitted` →
  `{kind:"worker", id: agentId}`).

**Why this is safe (does not open the mint to non-coding runs):** the REAL coding gate is guard 3
(`gateCodingAdapterDispatch` admits only `claude_local`/`codex_local`) **plus** the binding lookup. A
`worker`/`sandbox` run whose `executorPrincipalId` is not a v1 coding agent — a `commander_turn` sandbox carrying a
run id, a `service`/`browser` run, a `system` job — loads no binding → adapter `""` → guard 3 refuses. Existing
mint refusals for `user`/`system`/`service`/`service_instance`/`browser_worker` are preserved. **Blast radius,
measured:** the mint only runs on a `selected/active/lease-eligible` placement inside `placeJobAttemptTransaction`,
and the ONLY production composition of that path is the canary `ownerResolver` (`index.ts:1170/1193`;
`placeJobAttempt` has no production caller). So today the widened gate takes effect **only for canary runs** — the
exact target — and generalizes correctly if/when a non-canary distributed placement is composed (the DAT-008 mint
finally firing for real coding runs is its stated purpose).

**Proof:** the embedded-PG `[CLI-007]` cases were switched from a manufactured `executor_principal_kind = 'agent'`
to the REAL `'worker'` + the coding agent id — RED before this fix (guard 2 refuses → zero handles), GREEN after.
Pure-decision tests admit `worker`/`sandbox` and refuse `browser_worker`; a runner test mints for a `worker`
executor and refuses a `worker` with no coding binding. The predicate is mutation-proven (positive control +
revert-to-`"agent"`-only turns the real-kind tests RED).

---

## 3. What this deliberately does NOT do, and one doc-vs-disk correction

### 3.1 It does not enrich the four-null binding
Setting `credentialKind` non-null on `CANARY_CREDENTIAL_BINDING` is forbidden by CLI-006's design and by
this ticket's scope. The binding stays four nulls; the credential authority reaches the mint out of band.

### 3.2 It does not weaken the mint's owner-authority gate
`ownerAuthoritiesAgree` and `decideExecutionSecretHandle` are **unchanged**. The canary now presents a
*legitimate* Authority B (`"company_api_key"`) derived from the preflight's verified provider-control
authority; a genuine disagreement — `placementOwner === "owner_desktop"` with `credentialKind ===
"company_api_key"`, or a null on either side — still refuses (guard 4). The fix changes only the **source**
of the mint's `credentialKind` at the *call site*, never the gate.

### 3.3 Doc-vs-disk: `"company_api_key"` on the binding would NOT literally break replay or routing — but out-of-band is still the correct design
CLI-006's binding header (`canary-credential-binding.ts:43-51`) and E7-F001 both compress the prohibition as
"a non-null `credentialKind` re-opens owner routing and breaks placement-digest replay." Read against the
disk, that is precise only for `credentialKind: "personal_subscription"` (which takes the owner-routing
branch, `execution-target-resolver.ts:200-204`) and for **rotating** values (a freshly-read credential row /
key generation, which would change the digest per attempt). A **constant** `"company_api_key"` routes
identically to `null` (both fall to `pooled_gvisor`, `execution-target-resolver.ts:206-208`) and is
byte-stable, so on those two axes alone it would be safe. **The design still refuses to put it on the
binding, for a reason the compressed phrasing omits:** the mint's `ownerAuthoritiesAgree` is a check between
two *independently derived* authorities (`execution-secret-handle-mint.ts:108-120`). A constant on the
binding makes Authority B a constant that always says "company", collapsing the cross-check to "is
placementOwner non-desktop?" — vacuous for a canary, and asserting Company authority *without verifying it*.
Threading a preflight-**verified** authority keeps the cross-check meaningful and keeps the digest
byte-identical (the binding never changes), which is a strictly stronger replay proof than "the constant
happened not to rotate." This correction is recorded here because the go-book instructs trusting the disk and
saying so; it does not change the fix.

### 3.4 It does not promote E7-1
`E7-1-coding-journey` stays dormant. This ticket makes the journey *runnable*; a cited dispatched real-E2B
run promotes it (go-book §4 Sprint 5).

---

## 4. The three hard constraints ↔ how the design satisfies each

| Constraint | Mechanism | Proven by (turns RED if broken) |
|---|---|---|
| **C1** Canary mints a Company-key `provider_key` handle; owner authority established in the preflight | Preflight emits `credentialAuthority` on `ok` (post `currentKeyGeneration` check); ownerResolver threads it; the mint issues `provider_key` | A2 (preflight emits), A3 (thread), A5 (seam), A8 (integration: handle minted + envelope non-empty) |
| **C2** Placement-digest replay invariant holds (same digest across attempts) | Binding unchanged (four nulls) → `authorityFacts`/digest byte-identical; mint authority consumed only after the digest + replay early-return | A6 (binding is four nulls — mutation M-REPLAY), A9 (integration: place twice → same digest, exactly one handle) |
| **C3** Mint's owner-authority gate stays fail-closed and unchanged in strength; canary presents a legitimate authority | `ownerAuthoritiesAgree`/`decideExecutionSecretHandle` untouched; only the call-site source changes; a refusal emits no authority (fail-closed) | A7 (gate still refuses null/disagreement — mutation M-GATE), A2b (refusal carries no authority), A5b (seam fail-closed default) |

---

## 5. Security argument (Decision #104 — the key never leaves the sandbox, never reaches a log)

The change is **entirely reference-side**:
- The mint stores a **reference**, never a value: `refKind:"provider_key"`, `refId: target.secretName`
  (`"provider:anthropic"` — a name, `mint-runner.ts:129-147`), `envTarget:` the env-var **name**.
- The lease envelope carries only `handleId` + materialization **target env-var name** + `usePolicy`
  (`execution-secret-handle-envelope.ts:39-62`). No value.
- The value materializes **only inside the sandbox**, resolved by the worker's `synthesiseRunSecrets`
  (`usePolicy: "sandbox_local_only"`), which DAT-008 slice 5 seeds as a per-run redaction canary into both
  streams before `provider.create` (DAT-008 slice-5 result §1-3, §5). That seeding — the **S4 tripwire** — is
  the runtime guarantee that a planted leak is caught; it stays in force and is now *activated* for canaries
  (a handle exists to redeem).
- My server changes add **no** log line carrying a value; they in fact **remove** the steady-state
  `job.execution_secret_mint.refused` warning for canaries (they mint instead of refusing).
- Fail-closed end to end: a canary whose preflight refuses gets legacy (no placement, no mint, no handle,
  `run-execution-owner.ts:235-238`); a canary that reaches the mint with no authority (`mintCredentialAuthority`
  absent) sources `null` from the binding and the mint refuses (`ownerAuthoritiesAgree` null arm) — no handle,
  visible degradation to legacy, never a double-execution or a leaked key.

Proof obligations in the acceptance table: A4 (mint row + envelope carry only references, no value) and A10
(no changed server path logs a value; the refusal warning stops firing for the minting canary).

---

## 6. Fail-first TDD steps (RED for the written reason, then implement, then GREEN)

All unit steps run on Windows in `C:\e3` (`cd server && npx vitest run <file>`). Step 8/9 are embedded-PG
(`AOA_RUN_WIN_INTEGRATION=1` locally, Linux CI otherwise).

1. **RED — preflight emits authority (A2).** In `cli-006-canary-preflight.test.ts`, assert an `ok` result
   carries `credentialAuthority: "company_api_key"` and that a refusal (e.g. `credential_authority_not_moved`)
   has no such field. RED: the field does not exist. → Implement edit #1. GREEN.
2. **RED — ownerResolver threads it (A3).** In `cli-006-run-execution-owner.test.ts`, capture
   `place.mock.calls[0][0]` and assert `mintCredentialAuthority === "company_api_key"`; assert a legacy path
   (preflight refuses) never calls `place`. RED: the field is `undefined`. (Also update the `deps()` preflight
   mock to return `credentialAuthority`.) → Implement edit #2 (+ #1 already done). GREEN.
3. **RED — the mint-authority seam (A5).** New `cli-007-canary-credential.test.ts`: import
   `mintCredentialKindFor`; assert `("company_api_key", null) → "company_api_key"` (canary),
   `(undefined, null) → null` (non-canary fail-closed), `(undefined, "company_api_key") → "company_api_key"`
   (legacy binding passthrough), `(null, "company_api_key") → "company_api_key"`. RED: symbol undefined. →
   Implement edit #4 (add the function + wire it at `:377`). GREEN.
4. **RED — no-leak references only (A4).** In `cli-007-canary-credential.test.ts`, build the mint decision for
   the canary case and the stored-handle→`toSecretHandleRefs` ref; assert neither contains a secret *value*
   (only `secretName`/env-var name/handleId), and that `refKind === "provider_key"`. RED before wiring only if
   it depends on the seam; otherwise it is a standing security assertion. GREEN.
5. **RED — integration round-trip (A8/A9/A10).** As added `[CLI-007]` cases in
   `job-placement.integration.test.ts` (embedded-PG, reusing its seeded platform target/worker + tenant
   provisioning): seed a
   canary Organization/Company (reconciliation closed + `currentKeyGeneration` set), a `pooled_gvisor` target
   + enrolled worker, a `claude_local` agent + a queued agent job, then place with
   `mintCredentialAuthority:"company_api_key"`. Assert (A8) exactly one `job_secret_handles` row
   (`refKind:"provider_key"`), (A9) a second place of the same attempt returns the existing decision with an
   identical `placementInputDigest` and still exactly one handle, (A10) the stored row holds only a reference.
   RED before edit #4: the mint refuses `owner_authority_disagreement` → zero handles. GREEN after.
   *If the fixture proves disproportionate, the composition is already proven by DAT-008 slice-5's existing
   embedded-PG round-trip (mint→envelope→worker-redeem→canary) plus steps 1-4; that fallback is stated in the
   result doc, never silently taken.*
6. Update the stale prose (edits #5, #6). Confirm the binding suite and the mint suite stay green (guards
   unchanged).

---

## 7. Mutation table (DELETE the guard, never rewrite it; positive control FIRST)

| id | Guard / seam | Positive control (must pass first) | Mutation (DELETE) | Expected |
|---|---|---|---|---|
| **M-PC** | the whole seam is exercised | A5 canary case returns `"company_api_key"` | make `mintCredentialKindFor` return a fixed `"NOPE"` | A5 RED — proves the test drives the function |
| **M-SEAM** | `mintCredentialAuthority ?? binding` | A5 | delete the `mintCredentialAuthority ??`, return `bindingCredentialKind` only | A5 canary case RED (returns null) |
| **M-THREAD** | ownerResolver passes `gate.credentialAuthority` | A3 | delete `mintCredentialAuthority: gate.credentialAuthority` from the `place(...)` call | A3 RED (`undefined`) |
| **M-PRE** | preflight emits `credentialAuthority` on `ok` | A2 | delete the field from the `ok` return | A2 RED |
| **M-PRE-FC** | refusal carries no authority | A2b | make the refusal helper also set `credentialAuthority` | A2b RED (fail-closed shape broken) |
| **M-REPLAY** | binding is four nulls (routing + digest) | A6 | set `CANARY_CREDENTIAL_BINDING.credentialKind = "company_api_key"` | A6 RED — this is the replay-breaking change the ticket exists to avoid |
| **M-GATE** | `ownerAuthoritiesAgree` null arm | A7 | delete `if (placementOwner === null \|\| credentialKind === null) return false;` | A7 RED (a null credentialKind passes the gate) |
| **M-LEAK** | envelope ref carries no value | A4 | (n/a — standing assertion) add the secret value onto the ref in a mutant | A4 RED |

A surviving mutant is a question, not a verdict: prove equivalence by deleting both the guard and its backstop
and showing the suite then fails.

---

## 8. Acceptance table (every clause → a test that could turn RED)

| id | Clause | Test |
|---|---|---|
| A1 | The mint chain's sole canary block at tip is guard 4 (`credentialKind: null`) | `execution-secret-handle-mint.test.ts` (existing: null/disagreement → `owner_authority_disagreement`; managed_cloud+company_api_key → provider_key) |
| A2 | Preflight `ok` establishes and emits `credentialAuthority: "company_api_key"` | `cli-006-canary-preflight.test.ts` (new case) |
| A2b | A preflight refusal carries **no** authority (fail-closed by shape) | `cli-006-canary-preflight.test.ts` (new case) |
| A3 | ownerResolver threads `gate.credentialAuthority` to `place`; a legacy path never threads | `cli-006-run-execution-owner.test.ts` (new cases) |
| A5 | The mint sources `credentialKind = mintCredentialAuthority ?? binding.credentialKind` | `cli-007-canary-credential.test.ts` (`mintCredentialKindFor`) |
| A5b | Absent authority → `null` → mint refuses (fail-closed default) | `cli-007-canary-credential.test.ts` |
| A4 | Minted handle + envelope carry only references, never a value | `cli-007-canary-credential.test.ts` |
| A6 | Binding stays four nulls (replay + routing) | `cli-006-canary-credential-binding.test.ts` (existing; mutation M-REPLAY) |
| A7 | Gate still refuses null/disagreement (unchanged strength) | `execution-secret-handle-mint.test.ts` (existing; mutation M-GATE) |
| A8 | A canary placement mints one `provider_key` handle; envelope `secretHandles` non-empty | `job-placement.integration.test.ts` `[CLI-007]` (embedded-PG) |
| A9 | Replay: place twice → identical `placementInputDigest`, exactly one handle | same integration test |
| A10 | No changed server path logs a value; canary `mint.refused` warning stops | integration + assertion on the refusal-warning path |

---

## 9. Registers, bookkeeping, and the boundary

- **E7-F001 resolves HERE, in one commit:** flip its `**Status:**` to `resolved` in
  `epics/E7-coding-e2b/findings.md` **and** delete its `"E7-F001"` key from `scripts/finding-ownership.json`
  (fixing the now-trailing comma on the preceding entry). Doing one without the other reddens the always-on
  `policy` job (a resolved finding with a lingering key, or an open finding with no entry).
- **No wiring change:** `E7-1-coding-journey` stays dormant.
- **No test-inventory bump:** `server` is a floor (§0.3); new `*.test.ts` files grow it and satisfy it. No
  worker-daemon test is added. New tests are `.test.ts`, so `check-execution-census` is untouched.
- Run all registers to green: `check-gate-clause-wiring`, `check-finding-ownership`,
  `check-ticket-graph-coverage`, `check-guard-inventory`, `check-test-inventory` (+ its `--test`),
  `check-execution-census`.
- **CI honesty:** `verify` inherits the pre-existing §2.0 red (a measured regression predating this ticket).
  Do **not** raise its timeout. State it in the result doc.

## 10. Non-goals

- The real-E2B journey run itself (Sprint 5's completion, operator-dispatched, with the operator's E2B key)
  and the `E7-1` promotion it earns.
- Any change to non-canary tenant credential routing (unchanged; `mintCredentialAuthority` is only ever set on
  the canary path).
- `packages/worker-protocol` is FROZEN — this ticket adds **no** frozen op and **no** field on a frozen
  schema. The mint authority is a server-internal input; the wire ref (`secretHandleRefSchema`) is unchanged.
