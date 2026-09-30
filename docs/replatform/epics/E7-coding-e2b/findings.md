# E7 — Coding/CLI on E2B — findings

> ★★ **READING NOTE ADDED 2026-09-08 (W21D) — `e7-distributed-run-verifier-store.ts:NNN`
> citations in this file are DATED MEASUREMENTS, not navigation.** W21B and W21C moved every
> anchor in that file down 180-290 lines (`countProducedOutputs` 198 → 387, arm 1's
> `workspace_patch` conjunct 207 → 473, arm 2 213-216 → 514+), so **every line pin below now
> resolves to unrelated code** — `:207`, for instance, is a `getAttemptTerminalReceipt`
> parameter today. They are deliberately left as written: they record what was measured on a
> given day, and rewriting them to the current layout would falsify the measurement rather
> than repair the citation. **To navigate, use the SYMBOL anchors** listed in that file's own
> header block ("CITE THIS FILE BY SYMBOL, NOT BY LINE") — `countProducedOutputs` arm 1 / arm
> 2, `listRunSecretScanSurfaces`, `scanColumns`. The LIVE registers
> (`scripts/gate-clause-wiring.json`, `scripts/finding-ownership.json`) and the PRODUCTION
> comments that carried the same rotted pins WERE converted, because a reader acts on those.
> No positional guard was added: `scripts/lib/gate-clause-wiring.mjs` already records why one
> would be switched off, and that reasoning was not relitigated.

## E7-F001 — The canary mints no execution-secret handle, so the canary sandbox receives no provider credential

**Status:** resolved · **Owner:** CLI-007 (`epics/E7-coding-e2b/tickets/CLI-007-design.md`, result `CLI-007-result.md`)
**Severity:** HIGH
**Filed:** Sprint 5 (CLI-006/D2 execution), 2026-08-26, by terrain re-verification of the CLI-006 ↔ DAT-008 seam.
**Correction (2026-08-26, CLI-007 adversarial review).** The original mechanism below is INCOMPLETE: it named
only guard 4 (`owner_authority_disagreement`) as the canary's block, but a real canary refuses one gate earlier,
at guard 2 (`executor_not_agent`). The mint gated the EXECUTOR on `executorPrincipalKind === "agent"`, yet NO
execution source ever stamps an `"agent"` executor — the frozen executor authority (Decision #121) makes
`task_run`/`crew_run`/`one_shot` executors `worker`/`sandbox`; `"agent"` is only ever a *requester* kind
(`job-control.ts` `taskSourceIsAdmitted` → `{kind:"worker", id: agentId}`). So the mint had never minted for
ANY real run — a pre-existing DAT-008 slice-1 gap on which this canary-specific finding sat. The original trace
reached guard 4 only because it assumed an `"agent"` executor. **Both gates are the fix.**

**Resolved:** Sprint 5a (CLI-007), 2026-08-26. The canary (and every real coding-agent run) now mints a Company
`provider_key` handle. Two corrections landed together:
1. **Guard 2 (executor gate).** `isAgentBackedExecutorKind` (`execution-secret-handle-mint.ts`) admits the real
   agent-backed execution kinds (`worker`/`sandbox`, per Decision #121); the real coding gate is guard 3 (v1
   adapter scope) plus the agent-binding lookup keyed on `executorPrincipalId`, so a `worker`/`sandbox` run whose
   principal is not a v1 coding agent (browser/service/commander/system) still refuses. The mint runner's
   binding-load gate uses the same predicate.
2. **Guard 4 (owner authority).** The MIG-008 preflight emits the Company ownership authority
   (`credentialAuthority: "company_api_key"`, only on `ok`), `resolveRunExecutionOwner` threads it as
   `mintCredentialAuthority`, and the mint sources its `credentialKind` from that out-of-band authority
   (`canary-mint-authority.ts` `mintCredentialKindFor`) — WITHOUT touching the four-null placement binding, so
   the replay digest stays byte-identical and the owner-authority gate is unchanged in strength.

Proven at embedded-PG (`job-placement.integration.test.ts` `[CLI-007]`) using the REAL executor shape
(`executor_principal_kind = 'worker'`, `executor_principal_id` = the coding agent): the canary places to the
same digest across attempts and mints exactly one `provider_key` handle; the no-authority control mints none
(fail-closed). This UNBLOCKS but does NOT promote E7-1 (that still needs a cited dispatched real-E2B run of the
full journey — go-book §4 Sprint 5).

**What.** The composed canary placement path **never mints an execution-secret handle**, so the
canary lease envelope carries `secretHandles: []`, the worker redeems nothing, and a coding CLI
inside the canary sandbox has **no provider credential to authenticate with** — on real E2B just as
on the D1 fake provider.

**The mechanism (source-traced at tip `88c6a8b66`).**
- CLI-006 wires the canary credential binding to `resolveCanaryCredentialBinding`
  (`server/src/index.ts:1182`), which returns **four explicit nulls** — `credentialKind: null`
  (`server/src/services/canary-credential-binding.ts:59-64`), deliberately, to keep the placement
  digest replay-stable and to structurally exclude `owner_desktop` routing.
- That binding flows into the placement authority (`server/src/services/job-placement.ts:455-461`)
  and thence to the DAT-008 mint as `credentialKind: authority.credentialBinding.credentialKind`
  (`server/src/services/job-placement-transaction.ts:377`), on the canary `selected/active/
  lease-eligible` path (`:363-365`).
- The mint's step 4 requires **both** owner authorities to exist and agree:
  `ownerAuthoritiesAgree(placementOwner, credentialKind)` returns `false` whenever `credentialKind
  === null` (`server/src/services/execution-secret-handle-mint.ts:122-127`), so
  `decideExecutionSecretHandle` refuses with `owner_authority_disagreement`
  (`:149-151`). No handle is written.
- `owner_authority_disagreement` is an **actionable** refusal
  (`isActionableMintRefusal`, `execution-secret-handle-mint.ts:104-106`), so every canary placement
  also emits a `job.execution_secret_mint.refused` warning
  (`job-placement-transaction.ts:385-393`) — a "should be impossible" owner-disagreement signal
  firing as the steady state of the canary.

**Consequence for the journey (hop 5 / E7-1).** The "execute" hop cannot run a real credentialed
coding task for the canary: the CLI in the sandbox has no key. This is the same bound
`CLI-006-result.md` deferral 2 records, but its stated mechanism there
(`secretHandles: []` hardcoded at `job-leasing.ts:349`; "no production writer") is **stale** — DAT-008
now advertises handles from `listActiveExecutionSecretHandles` (`job-leasing.ts:601-613`) and mints
via `mintExecutionSecretHandleForPlacement` (`job-placement-transaction.ts:367`). The delivery gap is
real; the reason moved. **E7-1 stays `unwired` for this reason too**, independent of the
provider-vs-fake and control-plane-reach reasons.

**Why it is not fixed here.** Making the canary mint a credential is architectural, not a line in the
D2 lane: enriching the four-null binding with a non-null `credentialKind` is **explicitly forbidden**
by CLI-006's design (`canary-credential-binding.ts:39-47` — it re-opens owner routing and breaks
placement-digest replay), and credential-generation freshness is stated to belong to the preflight
(`canary-preflight.ts`). The fix is a **canary-aware credential path** (a mint that can authorize a
Company-key `provider_key` handle for a canary agent run whose owner authority is established without
a personal-subscription `credentialKind`), which is a decision with a blast radius and its own ticket.

**Scope note.** This does not change any shipped behaviour and is fail-closed (no credential ⇒ the
canary coding CLI cannot authenticate ⇒ the run degrades visibly, never double-executes or leaks). It
bounds what a real-E2B canary campaign can prove until it is owned.

## E7-F002 — Blocker A: a converted `task_run` carried an EMPTY workload, so no canary attempt could ever be leased

**Status:** resolved · **Owner:** Unit 1 "the mechanism" (Blocker A+B fix, `qa/2026-08-31-blocker-ab-fix-design.md`)
**Severity:** HIGH
**Filed:** 2026-09-01, on filing Unit 1's result. FIRST FILED HERE — see "why this entry exists" below.

**Why this entry exists at all.** This defect was found during BRW-001 and recorded ONLY as prose, in
another epic's design doc, under a heading that says it is not being fixed:
`epics/E8-browser-automation/tickets/BRW-001-design.md` §F3 — *"[P1] (confidence 9/10) — CROSS-LANE.
NOT FIXED HERE, BY DECISION."* It named no ticket and no owner, so it existed in no register, and
`check-finding-ownership.mjs` — the guard whose entire purpose is that noticing has a consequence —
could not see it. It sat there while CLI-006 went green, because shadow mode does not build envelopes.
A finding with no ticket is indistinguishable from a finding nobody had; this entry ends that, and it
is filed even though the defect is now fixed, because the REGISTER is the durable record and a fix
that leaves no trace teaches nobody.

**The mechanism (as verified at `156e2b25e`, matching BRW-001's original trace).** The canary seam
called `resolveExecutionOwner({source, actor, organizationId, idempotencyKey, rolloutState})` with **no
`input` key**. The optional `input` was plumbed end to end and nothing pushed into it:

```
heartbeat.ts               (no `input:`)
  -> heartbeat-distributed-rollout.ts   jobInput: input        (undefined)
  -> run-execution-owner.ts             input: jobInput
  -> job-convert-orchestrator.ts        admitAndSubmit(..., input)
  -> job-admission-bridge.ts            admitAndSubmit(source, actor, key, input = {})
```

So a converted `task_run` got `job.input = {}`. Measured against the frozen schema, `{}` fails
`batchWorkloadV1Schema` on all four fields, `buildJobEnvelope` returns `null`, and the attempt is never
leasable — a SILENT non-lease with the failure surfacing as an absence rather than an error. And had a
lease somehow been offered, `createSpecFor` falls back to `command = workloadType`, so the sandbox would
have run a binary called `batch`.

**Resolution.** `server/src/services/task-run-batch-workload.ts` builds a real `batch` workload (the
adapter's actual binary from `runtimeCommandSpec`, a per-adapter argv shape, the real
`context.currentTaskMarkdown` as the prompt) and the seam pushes it as `input`. A workload that cannot
be built is a REFUSAL, not an empty object: the run resolves
`{owner:"legacy", reason:"workload_unavailable"}` and the legacy executor keeps it.

**What it does NOT resolve.** See E7-F003 — a leasable attempt is the MECHANISM, not the capability.

## E7-F003 — Unit 1's workload is argv-only: a green distributed run proves the mechanism, not that the agent can work

**Status:** open
**Severity:** MEDIUM
**Filed:** 2026-09-01, by Unit 1 (Blocker A+B) on landing the workload builder — filed BY the author of
the thing it limits, deliberately, so the bound is on the record before the campaign reads a green run.

**The bound.** `argv is the only channel into the sandbox`: `createSpecFor` reads only
`workload.command` + `workload.args`, `ExecuteInput` has no stdin, `stdinArtifactId` has zero consumers,
and `workspace` is hard-coded `null`. So the workload Unit 1 emits is deliberately minimal — the binary,
a per-adapter flag set, and the task markdown as one positional argument. Everything the legacy adapters
also pass is ABSENT, and each absence is a real capability gap:

| Absent | Why | Consequence in the sandbox |
|---|---|---|
| `--mcp-config` / `--strict-mcp-config` | names HOST paths that do not exist in the sandbox | no `mcp__aoa__*` tools: no memory, no task updates, no ask-human |
| `--append-system-prompt-file` / instructions bundle | same | no agent identity, role, or company context |
| `--add-dir` / workspace | `workspace` is hard-coded `null` | no repository to work in |
| `renderTemplate(promptTemplate, ...)` | rendering happens INSIDE `adapter.execute`, after the canary returns; the field is DELETED for agents migrated to the instructions bundle | the prompt is raw task markdown with no framing |
| `--model`, permission flags | config-derived fidelity deliberately deferred | provider default model; default permission posture |
| output capture (`observeRun`, `buildWorkspacePatch`) | `observeRun` is not composed; the E5 boundary returns an opaque `stdoutRef` only | NOTHING the agent produces reaches AoA |

**Why this is a finding and not just a scope note.** The acceptance verifier's clause 5 keys on
`attempt_started`, which is emitted after create succeeds. A run with a mutilated or context-free prompt
still creates a sandbox, still executes, still terminalizes, and still SATISFIES the verifier. So the
gap is invisible to the machine check that the campaign will read — which is exactly the shape of defect
this programme keeps producing, and the reason it is written down rather than left in a design doc.

**Owner: CLI-008** (`epics/E7-coding-e2b/tickets/CLI-008-design.md`, no result doc), repointed from
`unowned` on 2026-09-02 after a 39-agent scoping sweep produced the evidence a ticket could be written
from. The previous `unowned` declaration was correct at the time — Unit 2 was sketched in a qa design
with no ticket on disk, and naming a plausible-sounding existing ticket would have been a false claim
of ownership. There is now an honest thing to point at.

**★ The sweep sharpened this finding in two ways.** First, the blind spot is worse than described:
clause 3 is labelled *"Terminal-AGNOSTIC"* in its own comment, so `failed` and `timed_out` are
accepted, and **no clause anywhere reads `workload`, `args`, `exitCode`, stdout or any produced
artifact** — a run that exits 127 satisfies the verifier. Second, and better: **the verifier already
COMPUTES the signal that would catch it.** `countProducedOutputs` counts committed `workspace_patch`
artifacts plus `task_outputs` by run; the result rides on `observed.producedArtifacts` and is
**printed**. It appears at exactly four lines — type, zero-init, assignment, print — and none of the
fourteen `failures.push` calls touches it. Promoting it to an asserted clause is an **S**, and it is
the first unit of CLI-008 because every later unit is judged by this verifier.

**★ Unit A landed 2026-09-02 — the blind spot is now COMPUTED. The finding stays OPEN.** The
verifier reports two independent dimensions. `ok` is unchanged: *the distributed journey was
corroborated* — the MECHANISM — and it is still true of a context-free run. `capabilityProven`
is new and answers *did anything the agent produced reach AoA*; its clause-6 failure names what
is unbuilt (the four missing links in the return path) rather than restating that a count was
zero. The RESULT line now carries both verdicts, so neither can be quoted alone, and a
`capability:` block with both counts prints on pass and fail alike.

`capabilityProven` is **false on every real run today**, and that is the intended outcome — the
verifier started telling a truth it already had the data for. The CLI's `--require-capability`
turns an unproven capability into a non-zero exit and is **OFF by default**: `producedArtifacts`
is structurally 0 until Unit F ships a producer, so on-by-default would be a gate nobody can
pass, and `scripts/lib/gate-clause-wiring.mjs` records in its own header what happens to those.
It is the flag the campaign flips once Unit F lands.

**Nothing here is an unblock.** No tools, no instructions bundle, no workspace and no output
capture were built; the capability gap is exactly as wide as it was. What changed is that the
machine now says so, where before only prose did — which is why the finding stays open.

## E7-F004 — The canary preflight's inventory is a strict SUPERSET of any reconcile pass's, by construction

**Status:** **resolved** · **Resolved by:** MIG-010 Units 2.4a + 2.4b, 2026-09-02.
**Severity:** HIGH
**Filed:** 2026-09-01, by Blocker E-3 terrain verification at `c7ead3a73` (Units 1.6+1.7 / PR #333).

**Resolved.** The gate's lease inventory is narrowed to the DB-clock snapshot instant of the latest
COMPLETED reconciliation pass, so a lease created after the pass is no longer an unmapped key.
Mechanism, end to end:

* Migration `0269` adds `legacy_reconciliation_passes` — the durable per-Company marker of a completed
  pass, carrying the snapshot instant, the provider-control generation observed, completion, scope and
  a pass identity. `aoa_operator` holds `SELECT, INSERT` and nothing else; `aoa_app` holds nothing.
* `reconcileOrganizationLegacyResources` reads that instant from the DATABASE once, before listing
  anything, and writes the marker as its LAST write for each Company — so a crash leaves "records, no
  marker", which the gate reads as not reconciled.
* `environmentService.acquireLease` stopped stamping `created_at` from the application clock, so the
  watermark comparison is database-clock on both sides (§3.3).
* Migration `0270` DROPs `canary_preflight_evidence_leases(uuid, uuid)` and re-creates it with a
  REQUIRED, no-DEFAULT `p_watermark` returning `(lease_ids uuid[], unnarrowed_total bigint)` — ONE ROW,
  always.
* `canary-preflight.ts` refuses `reconciliation_stale` on a missing marker, on a marker past
  `RECONCILIATION_EVIDENCE_MAX_AGE_SECONDS`, on a superseded marker generation, and on churn
  (`unnarrowed_total > 0` with an empty narrowed set).

★ **The semantics decision this finding asked for, made explicitly.** A lease created *after* the
reconciliation decision is current traffic on the legacy path, not an unreconciled legacy resource, and
it is waved through without a crosswalk record. §9.1 names that residual rather than hiding it: the
freshness window bounds how much of it can accumulate; it does not eliminate it. Two guards bound the
two ways evidence goes stale — the constant bounds TIME, the churn arm bounds FLEET TURNOVER — because
a fleet can turn over completely inside the window.

★ **The Unit 2.2 repro was INVERTED IN PLACE, not deleted**, and its inversion is mutation-proven:
disabling the narrowing (a far-future watermark, nothing else changed) reds both the inverted assertion
and the anti-vacuity twin that pins a PRE-watermark lease still re-closing the gate.

**Item (2) of the mechanism below no longer exists.** Option R (Unit 2.3) removed `casClaimPaused`
entirely, so there is no lost-CAS `continue` and no unrecorded paused row.

**What this does NOT resolve.** Nothing about `unattributable` records, which still refuse
`reconciliation_incomplete` permanently with no remedy in code — design §9.2's operator resolution path
is Unit 2.5, and E7-1 remains gated on the execution substrate besides.

**What.** The gate re-derives its inventory read-only from **live rows** — every lease the Company
currently holds, whatever its status (`canary-preflight.ts:115-122`, `:141`). A reconcile pass's
inventory is fixed at its own snapshot. Two independent mechanisms make the gate's set strictly
larger, so the two can never agree:

1. **Post-pass leases.** `environmentService.acquireLease` inserts a new `environment_leases` row on
   every legacy acquisition (`environments.ts:141-165`), from three sites in `environment-runtime.ts`
   (`:219`, `:578`, `:636`). Any lease created after the pass has no record → `unmapped` → refuse.
2. **Lost-CAS paused rows.** On a lost `casClaimPaused` the pass `continue`s
   (`legacy-resource-reconciliation.ts:347-350`) recording **nothing**, while the row still exists for
   the gate to count → `unmapped` → refuse.

(1) alone makes the gate unopenable on any box taking traffic. `canary-preflight.ts:16-19` describes
this as "self-healing in the safe direction". It is safe. It is also **permanently shut**, which is
not a gate but a wall.

**★ The fix is a semantics decision, not a caller.** A lease created *after* the reconciliation
decision is not an unreconciled *legacy* resource — it is current traffic on the legacy path, and the
rollout flag steers only NEW ownership decisions. Requiring it to carry a crosswalk record is a
category error. Deciding what closure is asserted *as of* changes what this gate may answer, which is
why it is owned by a ticket rather than patched.

**Interacts with E10-F002.** That finding says nothing writes the crosswalk; this one says that even
once something does, the gate still refuses. Both must close for the canary to flip.

**Blocks.** E7-1.

## E7-F005 — A NULL `key_generation` is never "superseded", so the gate's authority check passes vacuously

**Status:** **resolved** · **Resolved by:** MIG-010 Units 2.4a + 2.4b, 2026-09-02.
**Severity:** MEDIUM
**Filed:** 2026-09-02, by the design §12 attack (three lenses converged); confirmed by reading shipped code.

**Resolved, belt and braces, exactly as §13.3 required.** The `records.filter((r) => r.keyGeneration
!== null && …)` clause is GONE: §12 moved the comparison onto the marker, so the vacuous clause no
longer exists to pass vacuously. Where the comparison now lives, the NULL is unrepresentable —
`legacy_reconciliation_passes.key_generation` is `NOT NULL` with an explicit `'ungenerationed'`
sentinel (migration 0269) — and it is still made with `IS DISTINCT FROM` semantics
(`isDistinctFrom` / `isMarkerGenerationStale`), so a future nullable input cannot silently re-open it.

All four §13.3 combinations are pinned in `cli-006-canary-preflight.test.ts`, including the second —
sentinel marker against a real current generation — which is the one every naive implementation gets
wrong, and which SQL `<>` measurably misses. `canary-preflight.ts:150` is UNCHANGED: "no current
generation at all" is a different question and remains correct.

Mutation-proven: deleting the generation arm reds exactly one test.

**What.** `canary-preflight.ts:157-158` filters superseded records as:

```ts
records.filter((r) => r.keyGeneration !== null && r.keyGeneration !== keyGeneration)
```

The `!== null` conjunct means a record whose `key_generation` is NULL is **never** counted as
superseded. `deriveE2bKeyGeneration` returns null for a company with no default e2b
`runtime_provider_keys` row (`e2b-credential-authority-wiring.ts:32`), and the column is documented
as *"Null for an operator-env-default (ungenerationed) company"*
(`legacy_resource_reconciliation.ts:61-65`) — so NULL is a normal, expected value, not a corruption.

**The reachable sequence — no race, no rotation.** Reconcile a company with no BYO e2b key (every
record gets `keyGeneration = null`), then give the company a provider key. The `:150-156` arm does
not refuse, because it fires only when the *current* generation is null. `superseded` is empty
because every record is NULL. The authority half of the acceptance clause passes vacuously — for
exactly the company whose provider-control authority moved **after** its evidence was gathered.

**Why it has not bitten.** The gate is still shut for other reasons (E7-F004), and MIG-008's pass had
no production caller until `597e77715`, so no company has records at all yet. It becomes reachable
the moment operators start running the pass.

**Fix, and why it is owned by MIG-010.** Design §13 settles it: comparisons use `IS DISTINCT FROM`
semantics, and the marker's generation column (Unit 2.4a) is `NOT NULL` with an explicit
`'ungenerationed'` sentinel so the value is unrepresentable there. MIG-010 owns it because §12 moves
this exact comparison onto the marker — fixing it separately would fix the copy that is about to stop
being read.

## E7-F006 — One `unattributable` record refuses the gate forever, and ordinary agent deletion creates one

**Status:** **resolved** · **Resolved by:** MIG-010 Unit 2.5, 2026-09-02.
**Severity:** HIGH
**Filed:** 2026-09-02, after Units 2.3 + 2.4 made the path reachable. Flagged BLOCKING by two
independent terrain sweeps and carried in design §9.2 since 2026-09-01 — **but never filed as a
finding, so nothing owned it and `check-finding-ownership.mjs` could not see it.** That is the same
gap that let BLOCKER E sit unowned for MIG-008's entire life.

**What.** `assertClosure` fails on *any* record with disposition `unattributable`
(`legacy-resource-reconciliation.ts:290`), and `resolveResourceType` returns null — producing that
disposition — for a lease that is not `ephemeral` and carries no `agentId`,
`commanderConversationId` or `executionWorkspaceId` (`:95-101`). The crosswalk is **append-only**:
`0256` grants no DELETE, `insertRecordIfAbsent` is `onConflictDoNothing`, and no application code
updates a record. So one such record refuses the canary gate **permanently**, and neither the pass
(insert-if-absent) nor the gate (read-only) can clear it.

**Reachable through ordinary operation, not corruption.** `environment_leases.agent_id` and
`execution_workspace_id` are `references(..., { onDelete: "set null" })`
(`packages/db/src/schema/environment_leases.ts:16,:21`). **Deleting an agent nulls the owner FK on
every lease it held**, turning classifiable leases into unclassifiable ones. A founder removing an
agent is enough.

**★ Why it is filed NOW.** It was latent while the pass had no caller. Unit 2.3 (`597e77715`) gave it
one and Unit 2.4 (`effa591d6`) made the gate read the result — so **we enabled the path that reaches
this trap** and must close it before operators start running passes in earnest.

**Fix.** Design §9.2 settles the shape: a narrow operator command resolving ONE record, using the
`UPDATE` grant `0256` already provisions and no application code uses. It may transition **only**
`unattributable → terminal_cleanup`, never mint `mapped` (an operator asserting "this live resource
is accounted for" is precisely the forgeable claim), requires a non-empty operator justification,
takes one `resourceKey` at a time, and asserts its connected role first. It ships with an amendment
to `legacy_resource_reconciliation.ts:31-32`, which currently states there is no update path in
application code.

**Resolved.** MIG-010 Unit 2.5, exactly as §9.2 settled it. `server/src/cli/resolve-unattributable-record.ts`
is the operator remedy — `pnpm resolve:unattributable-record --company <id> --resource-key <key>
--reason "<justification>"`. **No migration:** `aoa_operator` has held `SELECT, INSERT, UPDATE` on the
crosswalk since `0256` and the operator-write policy is `ALL` with `USING (true)`; the grant existed and
nothing used it. This is its first consumer.

* **The transition guard is in the `WHERE` clause**, not in TypeScript — `AND disposition =
  'unattributable'`. The target disposition and cleanup outcome are file constants, not arguments, so
  minting `mapped` is structurally impossible; the predicate makes a second run a no-op rather than a
  silent overwrite, and makes a mistyped `--resource-key` that hits a real row a no-op rather than a
  rewrite.
* **Both guards are mutation-checked** (`mig-010-unit-2-5-unattributable.integration.test.ts`, 12 cases
  on a real migrated database, on the real `aoa_operator` serving role). Removing the `WHERE` predicate
  reds two cases — the `mapped`-rewrite refusal and the idempotence no-op — both failing as the command
  *succeeding*. Deleting the `assertOperatorRole` call reds exactly one, and its failure is the **owner
  run succeeding**, which is the shape that matters: an owner URL bypasses every GRANT and RLS policy,
  so without the assertion the command would work identically had `0256` never granted the operator
  `UPDATE` at all.
* **The record survives its own repair.** `resource_type` stays at the `unattributable` sentinel and
  `cleanup_outcome` is stamped `operator_resolved` (a value the pass never writes), so the row says both
  what the machine could not classify and what the human decided, and a human-asserted terminal record
  stays distinguishable from a machine-derived one. Closure is satisfied because the resource is
  accounted for, not because the register was emptied.
* The `legacy_resource_reconciliation.ts` comment amendment shipped in the same unit, plus two more the
  unit falsified (the SECURITY MODEL's "only the reconciliation pass writes these rows", and the
  `cleanupOutcome` value list).

**★ A CORRECTION TO THIS FINDING'S OWN REACHABILITY CLAIM, measured rather than reasoned.** "Deleting an
agent creates one" is true only when the deletion happens **before** the company's first pass. Reproduced
on a real database (Unit 2.5 Task 1, ORG_B): delete the agent *after* a pass has already recorded the
lease as `mapped`, and `insertRecordIfAbsent`'s `onConflictDoNothing` means the newly-unattributable
record is **never written** — the row on disk stays `mapped`, byte for byte. So that ordering does not
produce the durable trap this finding describes. It produces a different failure, now filed separately as
**E7-F007**: the pass refuses forever while the gate opens, and this remedy cannot touch it because there
is no `unattributable` record to resolve.

**★ This resolves the last item in MIG-010's stated scope, and the canary still cannot flip.** E7-1 is
gated by **E7-F003** (`unowned` — the capability half: no MCP surface, no instructions bundle, no
workspace, no output capture) and by the execution substrate. Nothing here is an unblock.

## E7-F007 — After a post-pass owner deletion, the reconciliation pass refuses forever while the gate opens

**Status:** open · **Owner:** MIG-010 (`epics/E10-desktop-migration-realtime/tickets/MIG-010-design.md`, no result doc)
**Severity:** MEDIUM
**Filed:** 2026-09-02, by MIG-010 Unit 2.5 Task 1, **measured on a real migrated database** rather than
reasoned — the plan's Task 1 Step 2 said "assert what you observe, not what you expect about the second
pass", and this is what was observed.

**What.** `reconcileCompanyLegacyResources` computes closure over the records it **builds in memory**
during the pass, while `canary-preflight.ts` recomputes closure over the records **persisted** in the
crosswalk. Those two sets can disagree, because the crosswalk is append-only:

1. A lease owned by an agent reconciles as `mapped`; the record lands on disk.
2. The founder deletes the agent. `environment_leases.agent_id` is `ON DELETE SET NULL`, so the lease
   survives with no owner FK and `resolveResourceType` can no longer classify it.
3. Re-run the pass. It builds an `unattributable` record and reports `ok: false` — but
   `insertRecordIfAbsent` is `onConflictDoNothing` on `(company_id, resource_key)`, a record already
   exists, and **nothing is written**. The persisted row is still `mapped`.
4. The gate reads the persisted records, finds closure satisfied, and **opens**. The operator's own pass
   exits non-zero, and will on every future run.

**Why it is not simply E7-F006 again.** E7-F006's trap is a durable `unattributable` record: it refuses
fail-**closed** and Unit 2.5 gives it a remedy. This is the mirror — a divergence in the fail-**open**
direction, with **no** record for the Unit 2.5 command to act on. Widening that command to rewrite a
`mapped` record would be exactly the forgeable transition design §9.2 forbids, so it was deliberately not
done.

**Severity, argued.** MEDIUM, not HIGH. The gate is arguably *right*: the record was true when written,
the underlying provider resource is unchanged, and `mapped` means "left for drain" — which is still what
should happen to it. The concrete harm is operator-facing and real: `pnpm reconcile:legacy-resources`
becomes permanently red for that Organization with no command that can make it green, and a permanently
red operator tool is how this programme has historically taught people to stop reading one. It is also a
live contradiction between two computations of the same predicate, which is the class §2 of the design
exists to keep out.

**Fix — not settled, deliberately.** At least three shapes are plausible and they are not equivalent: let
the pass compare against the persisted record and report a `stale_record` outcome distinct from
`unattributable`; give the pass a reconcile-with-existing path (which reopens "a pass that can rewrite its
own verdict is not evidence", design §9.2 option 2, and is probably wrong); or accept the divergence and
make the pass's verdict read from the same persisted records the gate does, so the two cannot disagree by
construction. MIG-010 owns choosing.

**Not a blocker for E7-1.** E7-1 is gated by E7-F003 and the execution substrate.

## E7-F008 — A task whose assembled prompt exceeds 8,192 characters cannot run distributed, and the ceiling is per-ARGUMENT

**Status:** FIXED (CLI-008 Unit D) · **Owner:** CLI-008
**Severity:** MEDIUM
**Filed:** 2026-09-03, by the Unit B channel sweep, which measured it rather than inferring it.
**Closed:** 2026-09-03, by CLI-008 Unit D — not by the remedy this finding proposed.

> ### Closed by REMOVING the prompt from argv, not by chunking it
>
> The finding's own remedy was chunked argv (`sh -c '<script>' _ c1..c10`, 65,306 characters,
> 8× today's capacity, no new channel). Unit D did not do that, and the reason is worth
> recording: Unit D had to stage the instructions bundle anyway — that is its whole job — so
> once a staging channel is carrying one file it may as well carry the prompt, and then the
> per-element ceiling does not apply at all rather than applying 8× further out.
>
> **What changed.** `workload.command` is now `sh` and `args` is a fixed `-c <script>` plus the
> adapter's binary and two constant paths. The assembled markdown rides CLI-008 Unit B's
> staging channel as bytes and the script reads it with a stdin redirect — which is what the
> legacy adapters have always done (`claude --print -`, `codex exec --json -`). The bound that
> replaces `FROZEN_MAX_ARG_CHARS` is `MAX_STAGED_FILE_BYTES` (1 MiB, 128×), which is a sanity
> ceiling on what the control plane pushes into a tenant sandbox rather than a wire limit.
>
> ★ **The refusal was MOVED, not deleted.** `prompt_too_large` became
> `staged_input_too_large` at a much larger bound. Deleting the last size check on content that
> goes into a sandbox would have been the other half of the same mistake, and a reason nobody
> can trip is a false claim of enforcement.
>
> **Measured, not asserted.** The realistic workload's submission payload went from **790 bytes
> to 295** (`cli-008-unit-b-byte-source.integration.test.ts` pins both numbers and says why the
> drop is the change): the payload no longer grows with the task. Prompts at the old cliff + 1,
> at 8× it, and at 100× it now all build and still parse against the frozen schema. Mutation:
> re-applying `FROZEN_MAX_ARG_CHARS` to the prompt reds all three.

**What.** `buildTaskRunBatchWorkload` refuses with `prompt_too_large` when the assembled task markdown
exceeds `FROZEN_MAX_ARG_CHARS = 8192` (`task-run-batch-workload.ts:80, :237-241`), mirroring the
frozen schema `args: z.array(z.string().max(8192)).max(256)` (`worker-protocol/src/job.ts:290-292`).
It is a **refusal, not a truncation** — which is the right direction, but it means such a task simply
cannot run distributed.

**Measured.** Binary-searching the description length through the real
`buildCurrentTaskMarkdown` → `buildTaskRunBatchWorkload`: minimal framing accepts **7,736** description
characters and refuses 7,737; realistic framing (8-char identifier, 60-char title) accepts 7,676; plus
one wake-comment section, **7,437**. The framing overhead is a variable 450-760+ characters, which is
the whole explanation of the "~7.4 KB" figure that circulated before this was measured. The repo's own
audit cap `MAX_PROMPT_SNAPSHOT_CHARS = 16_000` is **2×** the limit, and its comment says real prompts
do exceed it.

**★ The ceiling is PER ARGUMENT, and that changes the remedy.** The protocol allows 8 KiB per element
and ~64 KiB per job. A chunked shape (`sh -c '<script>' _ c1..c10`) carries **65,306 prompt characters
across 11 arguments** at exactly the 65,536-byte submission bound — **8.0× today's usable capacity** —
and the resulting `shellJoin`'d string is 65,464 bytes, still half of Linux `MAX_ARG_STRLEN`
(131,072). So this is fixable **without** any new channel, and independently of Unit B.

**Why it is filed separately from E7-F003.** F003 is about what the sandbox *lacks* (tools, context,
workspace, output). This is a live refusal on the path that exists: a sufficiently detailed task fails
to dispatch today, and the fix is a different shape from anything in C–F.

## E7-F009 — The staged-input fit check measures the wrong set, so the front door is closed and the side door is not

**Status:** FIXED (CLI-008 Unit D) · **Owner:** CLI-008
**Severity:** MEDIUM (latent) · **Filed:** 2026-09-03, surfaced while designing the fix for a Codex P2.
**Closed:** 2026-09-03, by CLI-008 Unit D — the first unit that stages anything at all, which is
what made it worth fixing then rather than later.

> ### Fixed as the finding specified: the UNION, at the call site
>
> `pointerFitsExtension(existing, files, prefix)` now projects the attempt's POST-CONDITION set
> — everything `listForJob` will return after this stage — instead of `input.files` alone.
> `existing` was already resolved two statements above the call, exactly as the finding said.
> Already-committed PATHS are deduped against, because such a file either replays (adding no
> row) or throws `conflicting_restage`, so counting it twice would refuse a bundle that fits.
>
> **Deduping at the reader stayed rejected**, and there is now a mutation that says so: making
> the projection count duplicates — the shape a reader-side dedupe would leave behind — reds
> both lanes.
>
> **Two lanes, because one was not enough.** `cli-008-unit-d-fit-union.test.ts` measures the
> cliff at runtime and asserts the projection; `cli-008-unit-d-fit-union-callsite.test.ts`
> stubs the tenant transaction and proves `stageJobInputFiles` actually HANDS the check the
> committed rows — a correct projection called with the wrong argument being the defect itself.
> The integration lane (`job-input-staging.integration.test.ts`, embedded Postgres) is the
> third, and is CI-only.
>
> ★ **Mutation-proven both ways.** Reverting the argument to `[]` reds both lanes. The
> dedupe-removal mutant initially SURVIVED — the first draft compared two verdicts that were
> both `true` — so the fixture is now sized at the cliff, where a double-count is exactly what
> tips it.

**What.** `pointerFitsExtension` (`job-input-staging.ts:129-145`, called at `:189`) projects
**`input.files` only** — never the accumulated durable set. But the lease offer is built from **all**
committed rows for the attempt: `job-leasing.ts:628` `listForJob` → `:638`
`stagedInputPointersFromRows` → `:399` `stagedInputExtension`.

So repeated stages against one attempt inflate the **real** extension past
`WIRE_EXTENSION_LIMITS.valueMaxCanonicalBytes` (16,384) while **every individual call reports
"fits"**. Then `jobEnvelopeV1Schema.safeParse` fails, `buildJobEnvelope` returns null
(`job-leasing.ts:402-403`), and `:640` throws `JobLeasingError("internal_unavailable")` — **the job
is permanently unleaseable with nothing naming the cause.**

★ **That is verbatim the cliff the refusal was written to prevent.** Commit `21a9fc4dd` added the
check precisely so an over-large pointer set is refused *before a byte moves*, and its docstring
(`:119-124`) says so. **It closed the front door; this is the side door** — reached by the one route
the check does not measure.

**Reachability.** Latent. It needs a producer that stages more than once for an attempt. Its
consequence is strictly **worse** than the duplicate-row defect it was first spotted beside: a dead
job rather than a wrong file.

> **Reachability CORRECTED, 2026-09-03** — this paragraph originally said F009 was *downstream of*
> the duplicate-path defect (the replay probe matches on path AND sha256, so a changed-bytes restage
> minted a second committed row). **That defect is now closed** — `7d345e8b3` refuses a conflicting
> restage rather than superseding it — and F009 **survives it unchanged**.
>
> ★ The route was never the duplicate: a second stage that adds a **DIFFERENT PATH** (files A, then
> A+B, or just B) appends committed rows for the same attempt without the fit check ever seeing the
> accumulated set. Same-digest restages replay and add nothing; different-digest restages now throw;
> **new paths still accumulate.** The projection measures `input.files` no matter which route
> reaches it, which is why the fix is the union and not a dedupe.
>
> ★★ Recorded because the near-miss is the lesson. Closing the neighbouring defect made it
> tempting to read F009 as closed by consequence — and it was written into this register as a
> dependency it never had. A finding whose stated reachability names another defect must be
> re-derived when that defect closes, not retired with it.

**Fix, when built.** `pointerFitsExtension` must project the **union** of `existing` (already
resolved at `:182`) and the new files, not `input.files` alone — a one-argument change, since the
data is already in scope at the call site.

**Filed separately, deliberately.** Deduping at the reader would make this unreachable *by accident*
and leave the projection still measuring the wrong set for any future multi-stage caller — a guard
that happens to be unreachable is a false claim of enforcement. And moving the fit check into
`buildJobEnvelope` was rejected: that refuses at LEASE time, minutes later, which is exactly the
undiagnosable cliff the check exists to move earlier.

## E7-F010 — The staging metric's label was never registered, so every staged run strands non-terminal

**Status:** FIXED `2e77b300f` (CLI-008 Unit B fix wave) · **Owner:** CLI-008
**Severity:** HIGH (was latent; would have been a P0 on the first Unit C/D content) · **Filed and
closed:** 2026-09-03, surfaced while writing the deadline test for a Codex P1-b.

**What.** `supervisor.ts`'s `emitOp` stamps an `operation` label that `assertBoundedLabels` checks
against a **closed allow-list** (`metrics/metrics.ts:81-94`) whose comment names its source: *"the
frozen PROVIDER_OPERATIONS vocabulary"*. `stage_files` is deliberately **not** in that vocabulary —
growing the non-frozen supervisor port and leaving the wire alone was the Unit B decision — so it
never arrived with the eleven others and was never registered. Every `emitOp("stage_files", …)`
**threw**.

★ **And the throw is not contained by the fail-closed arms — it happens INSIDE them.** The failure
arm re-throws from its own `emitOp`, so the escape reaches `accept()`'s last-resort catch, which
emits **NO TERMINAL**. The success path at the end of a healthy stage threw just as readily.
`dispatch-runtime.ts:205` passes a real registry in production, so **every distributed run carrying
staged files would have been torn down and stranded non-terminal** — precisely the outcome the
staging arms' fail-closed handling exists to prevent, reached by the happy path.

**Why it was invisible.** No staging test composed a real metrics registry. The server-side channel
integration test passes none, so `deps.metrics?.inc` was a silent no-op everywhere the channel was
exercised. ★★★ **A metric that nothing ever emits against a real registry is not a metric; it is a
line of code that has never run** — the [[checks-that-nothing-runs]] family, in the one place the
programme keeps rediscovering it.

**Fix.** `stage_files` registered on the `operation` allow-list with a comment saying why it does not
arrive with the frozen eleven, plus a happy-path test on a REAL `createMetrics()` asserting the
success metric is emitted and a normal terminal is reached. Mutation-proven: unregistering the label
reds all four tests in `supervisor-hung-stage-input.test.ts`.

★ **The general lesson is about the OTHER direction of the Unit B decision.** Choosing the
non-frozen port over the frozen vocabulary was right and remains right — but everything keyed to
that vocabulary (allow-lists, conformance suites, registries mirroring `PROVIDER_OPERATIONS`) then
needs a deliberate entry, because nothing adds it for you. Anywhere a new port method is observed
through a structure derived from the frozen list, check the derivation.

---

## E7-F011 — Unit B's channel has no route on the networked/container lane, and the prerequisite exists only as a comment

**Status:** resolved · **Owner:** CLI-008 · **Severity:** MEDIUM (**corrected down from HIGH** — see the
correction banner) · **Filed:** 2026-09-03 immediately after CLI-008 Unit B merged as `393f7a251`,
**corrected the same day**. Filed against my own work, and then corrected against my own work.

**Resolved:** 2026-09-18 (PR #471, merge `62960bbfc`; design `tickets/E7-F011-networked-staging-route-design.md`).
The networked/container lane now has a `stage_files` wire route:
`NetworkedProviderDriver.stageFiles` POSTs `/op/stage_files` with `{sandboxId, files}` + the owned-labels
capability (`packages/provider-wire/src/driver.ts`, `#post`'s op param widened LOCALLY to
`ProviderOperation | "stage_files"` — the frozen `PROVIDER_OPERATIONS`/`CORE_PROVIDER_OPERATIONS` are
untouched, E4-D02), and `fileStagingMode` flips `"none" → "grant_download"`. The adapter-manager adds a
**GATED-only** `stage_files` route (`packages/adapter-manager/src/server.ts` — added to `GATE_REQUIRED_OPS`
+ a `routeGated` case → `gateOwnedOp(sandboxId)` → `E2bSandboxProvider.stageFiles`; an ungated server 404s
it). GRANT-not-BYTES (E4-D01): the worker ships the `ArtifactDownloadGrantV1` pointer; the AM redeems +
verifies sha256/maxBytes + `transport.writeFiles` — no payload crosses the daemon; no codec change.
**PROVEN LIVE on the E7-1 canary (2026-09-18, Hetzner staging):** the full networked journey stages the
control-plane task-context input into the sandbox and proceeds into execute. NOTE: staging alone left the
run terminal-status-only (`finished_at` null) — a distinct terminal-projection gap tracked + fixed as
[[E7-F036]]; together they made the E7-1 run durably terminal (verifier `ok=true`, run `8dc34e90`). This
does NOT flip the `E7-1-coding-journey` gate clause (that measures a shipped CI boot; the run was a manual
staging proof) and does NOT move `capabilityProven` (false by design — E7-D-CAPABILITY-DISCLOSURE).

> ### ★★★ CORRECTION — link 4 of this finding was WRONG, and its own citation did not support it
>
> **As filed, this said "the lane that actually ships" and cited `docker/worker/Dockerfile:13` for
> the claim that the shipped image boots the networked-host root. Both are false.**
>
> `docker/worker/Dockerfile:196` is `CMD ["node", "dist/bin/worker-daemon.js"]` — the **local
> daemon** root. The networked tree is copied to `/worker-net-app` under a comment at `:158-159`
> that says in terms: *"DEP-011 Slice 2b's CONTAINER boot root, in its own pruned tree. **Present
> but NOT entered**"*. Line 13, which I cited, is a comment in the header block establishing
> CONTAINMENT of that root in the image — not entry into it.
>
> Three independent sources say the same, and I checked each: `scripts/boot-roots-expectation.json`
> ("the image `CMD` is UNCHANGED and still enters the daemon bin, so no shipped service runs it"),
> `docs/deploy/environment-variables.md:196` ("**Ships inert.**"), and `DEP-010-design.md:704`
> ("reachable only from the networked-host bin, which this CMD does not enter"). Entering it needs a
> per-service `command:` override, and that override is **actively rejected** by
> `scripts/lib/d1-compose-invariants.mjs:503-523` `checkWorkersEnterTheDaemonBin` — with an
> anti-vacuity test asserting the shipped D1 compose does not enter it.
>
> ★ **A second, independent gate I had also missed:** even if the bin *were* entered,
> `worker-networked-host/src/resolve-provider-url.ts:31` returns `{kind:"none"}` when
> `AOA_WORKER_PROVIDER_URL` is unset, so `make-run-provider.ts:86` — the sole construction site —
> never builds a `NetworkedProviderDriver` at all, and dispatch refuses `no_provider`.
>
> **So there is no shipped boot on which "every container-lane run hard-fails".** The defect is
> real; its present reach is not. Severity drops HIGH → MEDIUM, and the headline no longer claims
> the shipping lane.
>
> ★★ **Why this correction is kept in place rather than edited away.** I wrote a finding warning
> that a constraint recorded only in a comment is invisible — and supported its central claim with a
> citation to a comment that says the opposite of what I used it for. The lesson is not "check
> citations"; it is that **a finding filed in a hurry against your own fresh work inherits that
> work's blind spots**, and the register is exactly where that must not stand uncorrected.

**What.** Unit B's staging channel works on the **E2B/desktop** lane and is structurally unreachable
on the **networked/container** lane — which is the one the shipped worker image boots.

The chain, verified link by link:

| # | fact | evidence |
|---|---|---|
| 1 | `stage_files` is **not** in the frozen operation vocabulary — deliberately; that WAS Unit B's decision | `worker-protocol/src/capabilities.ts:142-153` — 8 core + 3 optional, no `stage_files` |
| 2 | the wire's `#post` is typed to that vocabulary, so the driver has **no route** to a remote `stageFiles` | `provider-wire/src/driver.ts` `#post<R>(op: ProviderOperation, …)` |
| 3 | so `NetworkedProviderDriver` declares `fileStagingMode = "none"` and its `stageFiles` **throws** | `driver.ts:93`, `:193-199` — `throw new UnsupportedProviderOperation("stage_files")` |
| 4 | ~~the shipped worker image boots the networked-host root~~ **— REFUTED, see the correction banner.** The shipped `CMD` enters the LOCAL daemon bin; the networked root is present but not entered, and is gated twice over | `docker/worker/Dockerfile:196` + `:158-159`; `resolve-provider-url.ts:31` |
| 5 | the supervisor **fails closed** on a staging throw | `worker-daemon/src/supervisor/supervisor.ts:700` → `stage_input_failed` + `escalateCleanup` |

**So IF the networked lane is entered — a per-service `command:` override plus
`AOA_WORKER_PROVIDER_URL` — AND a producer supplies a staged file, that run terminates
`stage_input_failed`.** Two independent reasons keep it unreachable today: no shipped boot enters
that root (see the correction), and there is no producer anyway — `lease/staged-input.ts:230`
returns `[]` when there are no pointers, so `staged.length > 0` is false and `stageFiles` is never
called.

★ **The fail-closed behaviour in link 5 is CORRECT and must not be "fixed".** Running an agent
without the files the control plane meant it to have produces a clean terminal for mutilated work —
the one outcome nothing downstream can detect. The defect is the missing route, not the refusal.

★★ **The fix is well-scoped but LARGER than I first wrote.** `E2bSandboxProvider.stageFiles`
genuinely works (`e2b-provider.ts:189` `fileStagingMode = "grant_download"`, real implementation at
`:420-444`) and the adapter-manager host root does hold that object
(`adapter-manager/src/bin/adapter-manager.ts:141`). So the remote side can stage.

But it is **not only the driver's TypeScript type**. `adapter-manager/src/server.ts:115-120` — the
raw handler map — holds only `"create"` and `"execute"`, and `GATE_REQUIRED_OPS` at `:88-97` is the
eight core ops. The route regex `/^\/op\/([a-z_]+)$/` would *match* `stage_files`, but both the
gated branch and the handler lookup miss, so it 404s with a `WireProtocolError`. **A route must be
added to the server AND to its capability gate**, not just to the driver. Still no new provider, and
still no change to the frozen vocabulary.

★★★ **WHY THIS IS FILED AS A FINDING RATHER THAN LEFT AS A COMMENT — THE ACTUAL DEFECT.** The
builder knew. `driver.ts:84-92` says it in terms: *"this driver has no wire route to reach a remote
provider's `stageFiles`. Giving the adapter-manager wire an inbound staging route is its own piece of
work; claiming support without one would silently drop every staged file."* That comment is honest
and correct. **But it was the ONLY record.** No finding, no ticket, no gate clause — nothing any
register, any sweep, or any planning session could see. A prerequisite that exists only as prose in
the file that implements the refusal is [[checks-that-nothing-runs]] wearing its politest disguise:
not a false claim of enforcement, but a **real constraint invisible to every mechanism built to
surface constraints**. Unit B's own PR said "the canary still cannot flip" and listed what was
missing; this was not on that list.

★ **It also means one sentence in Unit B's record needs reading carefully.** The gate clause is
honest — it says `wired` means reachable from a boot root, not "runs today", and names the E2B
driver plus the mock transport as what it proved. That is true. What it does not say, and what this
finding adds, is that **the boot root it is reachable from is not the boot root that ships.**

**Sequencing consequence — survives the correction, at lower urgency.** Units C and D were both
described as "now have a channel to ride". **On the E2B/desktop lane they do, and that is the lane
everything runs on today**, so C and D are NOT blocked by this. What this finding buys is the
knowledge that the networked lane will need the route before it is ever entered — so the work
belongs *before* the container lane is switched on, not necessarily before C and D. **Any plan that
schedules C or D must state which lane it targets**; that sentence is the durable output here.

**Not to be confused with E7-F009**, which is about the fit check measuring the wrong set on a
lane where staging *does* work. Both are open; they are independent.

★★ **RELATIONSHIP TO E6-F003 (HIGH, open, owner DEP-011) — this is its residual, not a duplicate.**
E6-F003 is "the networked worker→provider driver API is unspecified"; the route this finding needs
is literally the work E6-F003 exists to cover. Read them together before building either.

★ **And E6-F003's text is now STALE in one load-bearing sentence.** It says *"`adapter-manager` has
zero implementation … and no worker dispatches"*, and concludes that specifying a wire "against an
unimplemented peer for an unbuilt caller" is why deferring is correct. That was true when filed; it
is not true at HEAD. `packages/adapter-manager/src/server.ts` exists and serves `create` and
`execute` through a gated handler map (`:88-97`, `:115-120`), and `packages/provider-wire/src/driver.ts`
is a working client binding — DEP-011/DEP-012 built them. **The deferral's own stated precondition
has therefore partly arrived**, which is exactly the kind of change a finding's reachability must be
re-derived against rather than inherited. Not corrected here because E6-F003 belongs to DEP-011, not
to CLI-008; flagged so its owner can re-derive it.


## E7-F012 — A relative `instructionsFilePath` resolves against two different directories, so the editor can show one file while the agent reads another

**Status:** open · **Owner:** unowned (see `scripts/finding-ownership.json` for the reason)
**Severity:** LOW · **Filed:** 2026-09-03, by CLI-008 Unit D, which HAD to match the shipped
behaviour rather than fix it — and got that wrong once first.

**What.** `adapterConfig.instructionsFilePath` is read by two consumers that disagree about what a
RELATIVE value means:

- **The adapters** (the path that actually runs an agent) pass the raw string to `fs.readFile`:
  `claude-local/src/server/execute.ts:629` and `codex-local/src/server/execute.ts:503`. Node
  resolves that against the **SERVER PROCESS's working directory**. Neither adapter consults
  `adapterConfig.cwd` for this read — that field is the CHILD process's cwd (`execute.ts:192` /
  `:249`), used for spawning.
- **The route-level bundle service** (`agent-instructions.ts:165-174`,
  `resolveLegacyInstructionsPath`) resolves a relative path against `adapterConfig.cwd`, and
  THROWS `unprocessable` when that is absent or itself relative.

So for any agent whose `instructionsFilePath` is relative and whose `adapterConfig.cwd` differs from
the server's working directory, **the Instructions editor reads, lists and writes one file while the
running agent reads another** — or the editor refuses outright while the agent runs fine.

**Reachability.** LOW, and honestly so: every path the product WRITES is absolute
(`syncInstructionsBundleConfigFromFilePath` stores `path.dirname(resolvedPath)` +
`path.basename`, and the managed root is absolute), so a relative value arrives only by direct
`adapterConfig` authoring — the import/export bundle path, a hand-edited config, or a marketplace
package. It is a real inconsistency with a plausible user-visible symptom, not a live incident.

★ **Why CLI-008 Unit D filed it instead of fixing it.** Unit D stages the bundle bytes into the
sandbox and its entire claim is PARITY: the distributed run must read the file the legacy run would.
An earlier draft resolved relative paths against `adapterConfig.cwd` — matching the *editor* — and
cited `agent-instructions.ts:165-174` as "the legacy contract". That citation is real and it is
about the wrong consumer. **The consequence was the sharpest failure available here: a canary could
read a different bundle from its legacy fallback, or SUCCEED where legacy would have failed — a
canary green for the wrong reason**, which is the class this ticket exists to eliminate. Codex
caught it in review; the resolver now passes the configured string through verbatim.

★★ **A unit that "fixes" the path it is measuring against destroys its own evidence.** Changing the
adapters to resolve against `cwd` may well be the right end state — but it changes the SHIPPED
legacy path for every agent, it is not CLI-008's remit, and doing it inside the unit whose claim is
"we now match legacy" would make that claim untestable. Whoever owns agent instructions should pick
ONE resolution rule and apply it at all three sites at once.

## E7-F013 — The codex bundle separator is one newline or two depending on the staged file's trailing newline, so it matches the legacy adapter only sometimes

**Status:** open · **Owner:** unowned (see `scripts/finding-ownership.json` for the reason)
**Severity:** LOW · **Filed:** 2026-09-03, by the CLI-008 Unit D LIVE verification lane —
**observed in a real Linux `/bin/sh`, not argued from source.**

**What.** `task-run-sandbox-invocation.ts` emits, for `codex_local` with a bundle:

```
{ cat "$2"; echo; cat "$1"; } | "$0" exec --json -
```

and its own comment states the reason: *"The legacy adapter joins the two with a blank line … a bare
`cat "$2" "$1"` gives at most the bundle's own trailing newline … Inserting the blank line at the
point of USE rather than baking it into the staged bytes keeps the staged file byte-identical."*

Measured (`od -c` on the bytes the pipeline actually delivered to `$0`'s stdin, Debian `/bin/sh`):

| staged bundle | delivered separator | matches legacy? |
|---|---|---|
| ends **without** `\n` | `…LAST_LINE_OF_BUNDLE\nFIRST_LINE…` — **one** newline | **no** |
| ends **with** `\n` | `…LAST_LINE_OF_BUNDLE\n\nFIRST_LINE…` — a blank line | yes |

The legacy codex adapter is **unconditional**: `codex-local/src/server/execute.ts:505` builds
`` `${instructionsContents}\n\n` `` regardless of what the file ends with. `echo` contributes exactly
one newline, so the shell shape reproduces legacy's blank line only when `cat` already supplied one.

**★ The case the comment names as the motivating risk is the case that does not match.** The comment
singles out a bundle with *no* trailing newline ("a real possibility for an operator-edited file") —
and that is precisely the branch where the distributed path and the legacy path differ.

**What is NOT wrong.** The disaster the `echo` was added to prevent **does not occur**: in both
branches the bundle's last line and the prompt's first line land on separate lines. A bare
`cat "$2" "$1"` would have fused them; this does not. The defect is a parity claim that is
conditionally true, not a fused prompt.

**Reachability.** LOW. The delta is one newline of separation inside a prompt, on the codex adapter
only, only for bundles lacking a trailing newline, and only on the distributed path — which no
production run reaches yet. It is filed because the commit that shipped it states it "addressed" a
Codex P2 "by matching the shipped adapters", and the match is conditional. A LOW that is written
down beats a LOW that is remembered.

**Why unowned.** The fix is a judgement call about the shape, not a gap in it — normalising in the
script (`{ cat "$2"; echo; echo; cat "$1"; }` would overshoot to two blank lines when the bundle DOES
end in a newline; matching legacy exactly needs a trailing-newline-aware shell idiom) changes shipped
Unit D behaviour, and CLI-008's remaining units are C/E/F. Whoever next touches the codex invocation
shape should settle it. **Both branches are now pinned by the live lane**
(`keyed-cli-008-unit-d-invocation.test.ts`), so the behaviour cannot drift while the finding is open.

## E7-F014 — Against real E2B a non-zero exit is THROWN, not returned, so every failing distributed run terminalizes with `exitCode: null` and no message

**Status:** **resolved** · **Resolved by:** the E7-F014 carrier fix, 2026-09-04 (PR #351) — see
**Resolution** at the end of this block, and the ★ carve-out for the half it did NOT fix.
**Severity:** MEDIUM · **Filed:** 2026-09-03, by the CLI-008 Unit D LIVE verification lane.
**Observed in a real E2B sandbox**, not argued: run `33789547290`, log line
`[cli-008 unit-d] non-zero exit carrier = throw, exitCode = 78`. Confirmed a second time by the
mutation run `33790235730`, whose stack trace names the SDK class and the exact line:

```
CommandExitError: exit status 2
 ❯ CommandHandle.wait  node_modules/e2b@2.30.5/src/sandbox/commands/commandHandle.ts:176:13
 ❯ RealE2bTransport.runCommand  src/real-transport.ts:116:22
```

**What.** `MockE2bTransport.runCommand` RETURNS a crashed terminal —
`{ exitCode: 1, crashed: true }` (`mock-transport.ts:130-137`). The real transport does not: the
`e2b` SDK's `commands.run` THROWS `CommandExitError` on a non-zero exit, and nothing on the way out
converts it back:

1. `RealE2bTransport.runCommand` maps **only** a timeout-named error and rethrows everything else
   (`real-transport.ts:123-131`).
2. `E2bSandboxProvider.execute` classifies **only** `E2bTransportEgressBlockedError` and
   `E2bTransportNotFoundError`, then `throw err` (`e2b-provider.ts:297-303`).
3. `supervisor.ts:742-756` catches it and writes the durable terminal:
   `status: "failed"`, **`exitCode: null`**, `errorCode: "execute_failed"`, **`errorMessage: null`**,
   then `escalateCleanup(run, "execute_error")`.

So against real E2B the `ExecuteResult`'s `exitCode` can only ever be **0**, and
`crashed: exitCode !== 0` in `real-transport.ts:122` is **dead code** — the branch cannot be taken.

**What is NOT wrong.** The run still reaches a durable terminal, and a failure is still recorded as a
failure. Nothing is stranded and nothing succeeds falsely. What is lost is **attribution**: the exit
code, the CLI's stderr, and the distinction between "the agent exited N" and "the provider faulted"
all collapse into one `execute_failed` with two nulls.

**★ It defeats CLI-008 Unit D's own acceptance criterion 5**, which reads: *"A worker that ignores the
pointer (it is `critical: false`) produces an **attributable failure**, not a context-free success:
exit 78 with a named cause on stderr."* Measured: the 78 is **not** recorded on the attempt and the
named cause is **not** recorded. The guard runs correctly inside the sandbox and its attribution is
discarded one layer up. Criterion 5 said this was "Met at the script level; the end-to-end exercise
of that path needs a real sandbox and is NOT met in CI" — the real sandbox now says the script level
was the only level at which it held.

**Reachability.** MEDIUM, and it is the COMMON case rather than an edge: a coding agent exiting
non-zero is a failed build, a failing test, a lint error, or the agent's own error exit. Every such
distributed run loses its exit code. It is not HIGH because no run succeeds falsely and none strands.

**★★ The same class as `real-transport-helpers.ts`'s own founding lesson, one layer up.** That file
exists to close *"the 'the mock never execs a shell, so the real bug hid' gap that the first keyed run
surfaced (8/18 real-E2B failures)"*. Here the mock does not merely fail to exercise the path — it
encodes the **opposite** contract, so no amount of no-key testing can surface this, and the keyed
lane had never run a command that exits non-zero. This finding exists because a lane finally did.

**Why CLI-008 / Unit F.** Unit F is output capture — the run's exit code and stderr ARE its output,
and Unit F is the unit that has to make a distributed run's results legible. The minimal remedy is at
the transport: catch the SDK's `CommandExitError` in `RealE2bTransport.runCommand` and return
`{ exitCode, signal: null, timedOut: false, crashed: true }`, restoring the shape the mock already
models and the provider already expects. That is a change to CLI-001's shipped transport and belongs
with whoever next needs the exit code, not with a verification lane.

★★★ **TRACED ONE LAYER PAST THIS FINDING, 2026-09-04 — and that layer promotes it from "a lost exit
code" to a PREREQUISITE for the entire return path.** `packages/worker-daemon/src/supervisor/supervisor.ts`
catches the throw at `:743` and then, before anything else runs:
`emitOp("execute", "failed")` (`:744`) → `events.terminal({status:"failed", exitCode:null,
errorCode:"execute_failed"})` (`:751-756`) → **`escalateCleanup(run, "execute_error")` (`:757`), which
DESTROYS THE SANDBOX** → **`return` (`:758`)**. The normal path only resumes at `:760`
(`emitOp("execute","success")`), so **every step written after `execute` is skipped on every failing
run, with its sandbox already gone.**

Consequences, both load-bearing:

- **It kills every candidate output-capture mechanism EQUALLY** — a redirected file inside the
  sandbox, a provider-side command wrap, a post-run `readFile`, anything read from the command result.
  So it cannot be used to choose between them; it must be satisfied before any of them can work.
- **The runs it destroys are exactly the runs an operator wants output from.** A non-zero exit is a
  failed build, a failing test, a lint error, or the agent's own error exit — which this finding
  measures as the common case.

★ **Therefore CLI-008 Unit F is blocked on this finding, not merely adjacent to it**
([`CLI-008-unit-f-design.md`](./tickets/CLI-008-unit-f-design.md) §3.7, §5). ★ A repair carrying this
finding's own recommended remedy is in progress on the branch `claude/e7-f014-throw-carrier`
(**MERGED 2026-09-04 as `46c27e38b`, PR #351** — see the Resolution below). It depends on nothing in Unit F's
undesigned supply path and is worth landing on its own: it also takes a branch measured **dead** today
(`crashed: exitCode !== 0`, `real-transport.ts:122`) and makes an already-shipped keyed assertion true
end to end (`keyed-cli-008-unit-d-invocation.test.ts:323-325`).


### Resolution — 2026-09-04, PR #351

`RealE2bTransport.runCommand` now narrows on **`CommandExitError`** and returns
`{ exitCode, signal: null, timedOut: false, crashed: exitCode !== 0 }`. The `crashed` expression is
reused rather than hardcoded to `true` on purpose: it was the dead branch this finding names, and
reusing it is what brings it back to life instead of leaving a second, divergent copy of the rule.
`e2b-provider.ts` and `supervisor.ts` are **unchanged** — the carrier fix alone was sufficient, and
the live lane is what establishes that rather than an argument. A converted result stops being an
exception, so the supervisor's execute-catch never sees it, the run reaches its **ordinary** terminal
(`status` computed from the exit code), and the destroy-and-return path is left for genuine faults.

**★ The distinction the fix is built around, and the reason it is not a bare try/catch.** Two things
the old code conflated are now kept apart:

- **(a) the command RAN and exited non-zero** — a normal outcome (a failed build, a failing test, the
  agent's own error exit). Converted to a result, with the status **read off the error object**, never
  defaulted. A `CommandExitError` whose `exitCode` is not a number carries no status and keeps throwing.
- **(b) the sandbox or transport FAULTED** — no exit status was ever produced. Still an exception.

The narrowing is not a guess about the SDK: `CommandExitError` `implements CommandResult` and exposes
an `exitCode: number` getter, and **e2b@2.30.5 draws this exact line itself** inside the same
`CommandHandle.wait()` that throws it — a command that produced no exit status throws `iterationError`
or a bare `SandboxError("Process exited without a result")`, neither of which is a `CommandExitError`.
`instanceof` is also the SDK's own idiom for the narrowing (`isAuthFailure`, `isMissingUpstream`), and
it fails **closed**: anything that is not that class keeps its pre-fix path. Collapsing (b) into (a)
would manufacture a plausible exit code for an infrastructure failure — strictly worse than the defect
being fixed, by this programme's standing rule that a false claim of a result beats no result only in
the wrong direction.

**Proved LIVE against a real E2B sandbox, with a positive control.** Both dispatched at
`keyed-e2b-unit-d.yml`:

| | run | verdict | the measured line |
|---|---|---|---|
| fix (`claude/e7-f014-throw-carrier`, `5fc11469f`) | `33832930572` | **success**, 5/5 | `[cli-008 unit-d] non-zero exit carrier = result, exitCode = 78` |
| ★★★ mutant control (`claude/e7-f014-mutant-control`) | `33832956461` | **failure**, 2 red / 3 green | `[cli-008 unit-d] non-zero exit carrier = throw, exitCode = 78` |

The mutant reverts **only** `real-transport.ts` to `c48259358` and keeps the cases verbatim. It reds
with `AssertionError: expected 'throw' to be 'result'` and `CommandExitError: exit status 42`. The
**same log line** that filed this finding (`carrier = throw`) now reads `carrier = result` on the fix
and reverts to `carrier = throw` on the mutant — a direct before/after on one measurement, not two
different assertions. Critically the **fault case stays GREEN on both** (`[e7-f014] fault carrier
threw = true, returned = "NOTHING_RETURNED"`), so the mutation is targeted: it moves exactly the two
assertions about (a) and does not move (b).

Three cases carry it, all against a real sandbox: a command exiting **42** arrives as a result
carrying 42 (a fabricated code — the SDK's own `1`, the seam's `null` — cannot pass, so the status was
read and not defaulted); a run against a **TERMINATED** sandbox must still throw and must not resolve
to a number; and the original exit-**78** case now **pins** `carrier === "result"`.
`packages/sandbox-e2b-provider/src/real-transport.ts` was added to the lane's `paths`, so reverting
the conversion re-fires the lane rather than passing silently.

**★ WHAT THIS DID NOT FIX — the "and no message" half of this finding's own title.** The exit code
arrives; the **stderr text still does not**, and that is by design one layer up rather than by defect
here. `ExecuteResult` carries `stdoutRef`/`stderrRef` as **opaque references** because
`e2b-provider.ts` holds the E5 rule that *no customer bytes cross this boundary*, and the frozen
terminal payload has no message field of its own. So a failing run's terminal is now
`status: "failed"`, `exitCode: 78`, `errorCode: null`, `errorMessage: null` — attributable by code,
still silent on cause. Note that `errorCode` changing from `"execute_failed"` to `null` is a
**correction**, not a regression: execute did not fail, the command ran and exited 78, and the old
value asserted the wrong thing. Carrying the cause text is **output capture — CLI-008 Unit F**, which
is unbuilt; no separate finding is filed because the silence is an enforced architectural boundary
with an owner, not an undocumented constraint. Unit D's acceptance criterion 5 is therefore **half
met**: "exit 78" is now recorded on the attempt; "with a named cause on stderr" is not.
## E7-F015 — The task-outputs endpoint is forgeable: a board POST supplies `createdByRunId` with no producer check (★ NARROWED 2026-09-11 — no longer flips `capabilityProven`)

**Status:** open · **Owner:** CLI-008 (Unit F — terrain filed, **no fix designed**)
**Severity:** MEDIUM (★ NARROWED 2026-09-11 — the `capabilityProven` flip is CLOSED, but the forged
field still feeds clause 4's leak scan, a forged false-failure path; the LOW downgrade was withdrawn per
a Codex P2 on PR #426 — see note) · **Filed:** 2026-09-03, by CLI-008
Unit F's terrain pass, before designing anything that would make an operator start trusting this gate.

★ **NARROWED 2026-09-11 — the `capabilityProven` flip is CLOSED; the forgeable endpoint is the
residual, and the finding stays OPEN on it.** E7-F020 (now closed, PR #422) shipped the W21 predicate
change: arm 2 of `countProducedOutputs` no longer reads `taskOutputs.createdByRunId`. Verified at HEAD
`db0edd932`:

- **The flip is gone.** Arm 2 now inner-joins `job_projection_receipts` on
  `target_aggregate_id = task_outputs.id` and requires `projection_kind = 'output_projection'`,
  `aggregate_kind = 'task_outputs'`, `status = 'applied'`, bound on BOTH
  `job_id = run.distributed_job_id` AND `attempt_id = run.distributed_attempt_id`
  (`server/src/services/e7-distributed-run-verifier-store.ts` — `countProducedOutputs` arm 2). The
  sole writer of that receipt is `jobOutputBridge.projectAcceptedOutput`
  (`server/src/services/job-output-bridge.ts`), which writes it in the same tenant transaction as the
  output under a live fence (`recordGovernedProjection` → `guardActiveFence`). No HTTP caller can forge
  an applied, attempt-bound receipt, so a board POST can no longer move arm 2 or flip
  `capabilityProven`. **BUT the old `created_by_run_id = run.id` predicate survives in the secret-scan
  surface enumerator `listRunSecretScanSurfaces` arm 2b (`e7-distributed-run-verifier-store.ts:390`,
  `.where(eq(taskOutputs.createdByRunId, run.id))`), and clause 4 STILL READS IT** — E7-F030
  deliberately kept it (`:386`: *"deliberately stopped counting these; clause 4 must NOT stop scanning
  them"*). So the forged field is NOT unread: it still feeds clause 4's leak scan. See "What survives"
  (a forged false-failure path, caught by a Codex P2 on PR #426, 2026-09-11).

- **What survives — the endpoint is still forgeable (finding stays OPEN).**
  `POST /api/issues/:issueId/outputs` (`server/src/routes/task-outputs.ts:45-54`, mounted
  `app.ts:566`) still forwards `req.body` to `svc.upsertForIssue`; `upsertTaskOutputSchema` still
  admits caller-supplied `createdByRunId` (`packages/shared/src/validators/task-output.ts:50`); and the
  only guard is still `assertCompanyOwnedRef(db, heartbeatRuns, input.createdByRunId, companyId, …)`
  (`server/src/services/task-outputs.ts:123`) — a company-ownership check, NOT a producer check. A
  caller can still stamp any company-owned run id onto a task-output row with no proof that run produced
  anything. ★ **And the forged field still feeds a hard gate — clause 4 (the secret scanner).** A
  company-scoped actor can POST a `task_outputs` row stamping a company-owned run's `createdByRunId`
  with hard-leak-shaped text in a scanned field; `listRunSecretScanSurfaces` arm 2b selects it
  (`e7-distributed-run-verifier-store.ts:390`) and the verifier adds a clause-4 failure
  (`e7-distributed-run-verifier.ts:613-623`), making `e7VerifyExitCode` return 1 — a **forged
  false-failure path** on another run's verify verdict. (Cross-tenant it is blocked by
  `assertCompanyOwnedRef`; within a company it is not.)

- **Severity: stays MEDIUM (the LOW downgrade is withdrawn — Codex P2, PR #426).** The `capabilityProven`
  flip IS closed by E7-F020's receipt predicate, which is a real narrowing of KIND. But the residual is
  NOT "a field no gate reads": the forged `createdByRunId` still feeds **clause 4**, where it can force a
  false leak-failure (above). Like the capability counter, clause 4 is part of the E7-1 verifier that
  certifies nothing in production today (`--require-capability` off by default, referenced by no
  workflow), so the LIVE blast radius is bounded — but a hard gate consuming a forgeable, producer-unchecked
  field is a MEDIUM integrity gap, not LOW. Any fix must add a producer check to the route OR bind clause
  4's scan surface to the same fenced receipt arm 2 uses.

Everything BELOW this note is the original 2026-09-03 terrain as filed, kept for its writer census and
its refuted-fix record. Where the original text asserts the `capabilityProven` flip as a live
consequence, it is superseded by this note — that flip no longer occurs.

**What (original filing — flip since CLOSED, see NARROWED note above).** `capabilityProven` — the programme's headline capability verdict — is an OR over two
counters (`server/src/services/e7-distributed-run-verifier.ts:506`, `:522`). One of the two arms is
writable over HTTP by any company-scoped actor, with no provenance check anywhere on the path.

The chain, verified link by link at `d0b75be19`:

1. `countProducedOutputs`'s task-output arm is **one predicate** —
   `.where(eq(taskOutputs.createdByRunId, run.id))`
   (`server/src/services/e7-distributed-run-verifier-store.ts:213-216`). It selects `id` and returns
   `.length`. There is **no** filter on `type`, `provider`, `created_by_agent_id`, `asset_id`, or any
   projection receipt.
2. `POST /api/issues/:issueId/outputs` passes `req.body` straight into `svc.upsertForIssue`
   (`server/src/routes/task-outputs.ts:45,53`), and the router is mounted unconditionally
   (`server/src/app.ts:566`) — outside the `distributedExecutionEnabled` gate.
   ★ **This route, and no other. Added 2026-09-06 (W4U3-R4) because the confusion actually
   happened.** E7-F018's fact (4) cited `server/src/routes/output-detection.ts:201` under this
   finding's label for two rounds. That is a DIFFERENT route —
   `POST /heartbeat-runs/:runId/detected-outputs/:index/confirm`, whose run id is a **path param**,
   not a body field, and which **cannot** fire for a handed-off run (its only feed is
   `heartbeat_runs.detected_outputs`, written past the CLI-006 suppression return). E7-F015 is about
   `server/src/routes/task-outputs.ts:45-53` alone.
3. `upsertTaskOutputSchema` admits `createdByRunId: z.string().uuid().nullable().optional()`
   (`packages/shared/src/validators/task-output.ts:50`). Only `type` and `title` are required;
   `assetId`, `artifactId` and `executionWorkspaceId` are all optional.
4. The **only** guard on the field is
   `assertCompanyOwnedRef(db, heartbeatRuns, input.createdByRunId, companyId, "Heartbeat run")`
   (`server/src/services/task-outputs.ts:123`) — the run must merely belong to the issue's company.
   Nothing checks that the caller *is* that run, that the run produced anything, or that the run is
   distributed at all.

So `{"type":"external_link","title":"x","createdByRunId":"<the canary run>"}` satisfies clause 6. [★
NARROWED 2026-09-11: NO LONGER TRUE at HEAD — arm 2 was moved onto the attempt-bound receipt join
(E7-F020/W21), so this body no longer flips `capabilityProven`; the forged POST still writes an
unverified `createdByRunId`, which is the residual integrity gap this finding now stands on.]

**Reachability.** MEDIUM, and stated honestly rather than inflated. `--require-capability` is OFF by
default (`server/src/cli/verify-e7-1-distributed-run.ts:65`), no workflow or script runs the
verifier, and GO-BOOK §9 currently tells the operator not to pass it — so nothing is being decided on
this signal **today**. But Unit F exists to make an operator start passing it, and both counters are
structurally 0 until then, which means the first time this gate is trusted is also the first time it
matters that it can be forged. It is filed now, and must close BEFORE the bar is made flippable —
which, as the next block records, has not happened.

★★★ **THE FIX THIS FINDING ORIGINALLY RECOMMENDED IS REFUTED. THE FINDING STANDS.** Recorded here,
in the register, because a register that carries a finding at MEDIUM must not carry its remedy at the
same confidence — and because a remedy left standing beside a live finding is what gets built.

**Why tightening the route does not close it.** Tightening `assertCompanyOwnedRef` into "the caller
must be this run" does not work: an agent can stamp its own real run id, and the board route has
legitimate non-distributed users. That part of the original reasoning survives.

**What does NOT survive is the replacement.** The finding's first draft prescribed: *take the
task-output count out of the clause-6 predicate (leaving it observed and printed) and widen the
artifact arm off its `kind = 'workspace_patch'` filter*, on the argument that *"a `job_artifacts` row
can only be written by `commitArtifactVersion` behind a live fence, a verified device proof, an
attempt-scoped object prefix, and a control-plane `headObject`"*. **That argument is false, and the
counter-example is a producer CLI-008 itself shipped in Unit B.** Measured at `611a78bfb`:

1. `buildSandboxInvocation` stages the prompt **unconditionally** on every task run
   (`server/src/services/task-run-sandbox-invocation.ts:163-164`; only the instructions entry is
   conditional, `:165-173`).
2. `stageJobInput({ …, jobId, …, files: stagedFiles })` runs between convert and placement, before
   the attempt is leasable (`server/src/services/run-execution-owner.ts:361-368`, `jobId` from
   `convert.convertRunToJob` at `:340`).
3. `stageJobInputFiles` commits `job_artifacts` rows **directly and fencelessly** —
   `jobId: input.jobId` (`server/src/services/job-input-staging.ts:374`),
   `kind: STAGED_INPUT_ARTIFACT_KIND` (`:381`, `"staged_input"` at `:64`), `status: "committed"`
   (`:382`), `leaseId: null` (`:383`), `fenceToken: null` (`:384`). Its own comment says why:
   *"NO LEASE, NO FENCE … That is the property that makes an inbound write possible at all"*
   (`:366-369`).
4. That job id is the verifier's: `buildHandoffRunPatch` sets `distributedJobId: owner.jobId`
   (`run-execution-owner.ts:237`), and the counter binds
   `eq(jobArtifacts.jobId, run.distributedJobId)` (`e7-distributed-run-verifier-store.ts:206`).
5. Dropping `eq(jobArtifacts.kind, "workspace_patch")` (`:207`) leaves `jobId` (`:206`) and
   `status = 'committed'` (`:208`) — both satisfied by step 3.

**So the widened arm would be satisfied on every converted distributed run by the run's OWN INPUT** —
the prompt bundle the control plane writes *into* the sandbox — with no export, no worker producer
and no agent output. It is **strictly worse than the arm it replaces**: this finding's forgery needs a
deliberate authenticated POST; that one needs nothing, and `capabilityProven` would be `true` by
construction before the agent starts.

★★★ **And that is the SAME CLASS as this finding itself.** The move — *drop one forgeable arm, widen
the other* — produced a differently-forgeable arm on the first attempt, because the widening was
justified by an argument about a **class of writers** while the predicate binds a **class of rows**
(`kind`, `status`, `job_id`), and the census of who writes rows of that shape was never taken. **The
defect is in the move, not in the filter that was dropped**, so narrowing the widening is not a patch
— it is a fresh attempt that needs its own census first. Full chain and consequences:
[`CLI-008-unit-f-design.md`](./tickets/CLI-008-unit-f-design.md) §4.3.

★★ **The axis this finding turns on is PROVENANCE, not probative value.** Both counters are SQL counts
over control-plane rows and neither reads a byte of an artifact, so provenance — *who can cause the row
to exist* — is the only claim clause 6 can honestly make, and it is the axis on which the two arms
genuinely differ **today** (a `task_outputs` row can be written by anyone who can reach the API; a
`kind = 'workspace_patch'` row has no writer but `commitArtifactVersion`). Naming the axis precisely
is what keeps the finding correct; the looser framing — *"the arm is non-probative"* — would disqualify
any candidate replacement too. See `CLI-008-unit-f-design.md` §0. ★ Naming the axis correctly did
**not** make the predicate change safe, which is the transferable half: getting the principle right is
not the same as getting the census right.

★★★ **Removing the arm from the predicate would not withdraw the question it stands for, and only one
pre-existing owner holds it.** `gate-clause-wiring.json`'s `E3-17-output` (`unwired`, symbol
`jobOutputBridge`, "wire at sink cutover (Sprint 6)", `scripts/gate-clause-wiring.json:21-26`, checked
by the required `policy` job) owns the general distributed-job → `task_outputs` projection. There is no
second owner: clause 6's task-output arm is the only *verify-time* enforcement, and it is the forgeable
one. Any future removal moves enforcement from *a clause a verify run prints* to unit tests — weaker in
a specific way, and it must be priced rather than rediscovered (design §1.7).

★ **A second measured consequence, which binds any future fix's release shape.** The artifact arm has
**zero producers today** — the daemon's `artifactCommit` client method
(`packages/worker-daemon/src/transport/client.ts:266,567`) has no production caller, and both shipped
providers declare `artifactExportMode: "none"`. ★ **Updated 2026-09-04 (PR #353): the E2B provider
now declares `"grant_upload"` and implements export for real. THE ZERO STILL HOLDS and the
consequence below is unchanged — producers are counted by who CALLS the export and the commit, not
by who can serve them, and `artifactCommit` still has no production caller.** So removing the
task-output arm without shipping a
producer converts a forgeable gate into an **unpassable** one, which is CLI-008 Unit A's precedent
inverted. **That pressure is exactly what drove the refuted widening**, and it remains unrelieved
(design §1.8, §6).

**Current disposition: OPEN on the residual, capability-flip consequence CLOSED (★ NARROWED
2026-09-11).** The `capabilityProven` flip this finding was filed on is closed by E7-F020's W21 receipt
predicate — arm 2 no longer reads `created_by_run_id`, so no board POST can move the bar. What keeps the
finding OPEN is narrower: the `POST /api/issues/:issueId/outputs` endpoint still accepts a
caller-supplied `createdByRunId` with only a company-ownership check and no producer check, a low-value
integrity gap. CLI-008 Unit F remains the owner; no fix is designed. The forgeability of the endpoint
is unchanged from the original filing — only its consequence shrank.

## E7-F016 — Clause 6's operator-facing text misdescribes its own subject: four blamed links (three of which flip neither counter), and a verdict named for more than it proves

**Status:** open · **Owner:** CLI-008 (Unit F — part (a) repairable, part (b) recorded)
**Severity:** LOW · **Filed:** 2026-09-03, by CLI-008 Unit F's terrain pass — which was sent to size
Unit F against this text and found the text wrong about its own subject.

**What.** The reason string at `server/src/services/e7-distributed-run-verifier.ts:509-515` is
printed to the operator beside every verdict and is the programme's standing answer to "what does
Unit F have to build". It attributes the structural zero to four links:

| the text's link | measured at `d0b75be19` |
|---|---|
| "the E2B driver passes no stream handlers" | True (`packages/sandbox-e2b-provider/src/e2b-provider.ts:261-297`) — but the transport **already implements them**: `RealE2bTransport.runCommand(req, handlers?)` binds `onStdout`/`onStderr` to the E2B SDK (`real-transport.ts:107-120`). And wiring them flips **neither** counter: a `log` event is not a `job_artifacts` row and not a `task_outputs` row |
| "`stdoutRef`/`stderrRef` are fabricated literals" | True (`e2b-provider.ts:276,293`) — but making them real IS exporting bytes to object storage, i.e. the same work as the artifact path counted twice, not an independent link |
| "`observeRun` is uncomposed" | True (`packages/worker-daemon/src/lifecycle/dispatch-runtime.ts:178-181`). `RunObservation` is `{logs?, progress?, usage?}` (`supervisor/supervisor.ts:73-77`) — flips **neither** counter |
| "`buildWorkspacePatch`/`createResultCommitter` have zero production callers" | True, and the only one of the four that touches a counter — but it is blocked behind Unit E **and** behind an in-sandbox manifest capture that does not exist: `buildWorkspaceManifest` imports `node:fs` (`snapshot/build-manifest.ts:24`) and walks the DAEMON's filesystem, which on the E2B lane is not where the agent's files are. The text names neither blocker |

Omitted, and decisive: `artifactExportMode: "none"` on **both** shipped providers
(`e2b-provider.ts:178`, `packages/provider-wire/src/driver.ts:83`) — ★ **as of PR #353 the E2B half
reads `"grant_upload"`; the finding is unaffected, since its subject is what the reason string omits,
not whether an omitted link was later built**; no `artifactPrepared` emitter on
`EventSequencer` (seven emitters at `packages/worker-daemon/src/supervisor/events.ts:147,155,162,170,178,206,220`,
while `artifact_prepared` is already frozen at `packages/worker-protocol/src/events.ts:358`); no
**upload-direction** grant consumer in the daemon (the sole `artifactTransferGrant` caller,
`lease/staged-input.ts:242`, is download-only and explicitly rejects a cross-paired
`upload_granted`); and no control-plane projector from durable evidence onto `task_outputs`.

**Reachability.** LOW: it fails no gate and fails open in no direction. It is filed because it is an
**evidence surface** — printed, quoted, and load-bearing for scheduling. It produced CLI-008's XL
sizing for Unit F. ★ The XL *correction* stands — three of the four links flip neither counter, so the
cheapest honest route is not the one the text names. The **L** that a later pass substituted is
**withdrawn**: it was the size of a slice plan since refuted at the predicate
([`CLI-008-unit-f-design.md`](./tickets/CLI-008-unit-f-design.md) §4.3), and Unit F is now UNSIZED.

★★ **The second half, added on review: the VERDICT'S NAME overclaims too.** `capabilityProven` is
computed from two SQL counts over control-plane rows. A row predicate can assert **provenance** —
*these bytes reached durable storage through an attested path* — and can never assert
**productivity** — *these bytes are the work*. Neither arm reads a byte of the artifact. So the name
promises a capability judgement the predicate structurally cannot make, and no candidate replacement
arm changes that — a captured CLI transcript would be non-empty even for a run in which the model
never spoke. Same defect class as the reason string: operator-facing text asserting more than the code
beneath it.

**Fix, and the deliberate non-fix.** Part **(a)** — rewriting the reason string to name the links that
actually gate the counters — is **independent of any predicate change** and survives the refutation of
Unit F's slice plan; it is available to whoever next edits that module. Part **(b)** is **not** fixed by
a rename: `capabilityProven` appears in 15 files across five epics (`grep -rl capabilityProven`), and a
cross-epic rename is churn Unit F has no mandate for. The name's overclaim is therefore carried HERE,
in the register — recorded rather than silently tolerated. ★ Note that rewriting the reason string is a
**text** repair; it does not make the gate honest, because the gate's defect is E7-F015 and that has no
designed fix.

★ **The transferable part.** A failure reason is a claim like any other, and this one was assembled
from symptoms rather than from the predicate directly above it. Three of its four links are true
statements about the system that are **irrelevant to the counter the clause reads** — which is what
made the list feel comprehensive while pointing at the most expensive route. When a clause explains
itself, check each link against the clause's own predicate, not against the subject area — **and
check the clause's own NAME the same way.**

---

## E7-F017 — `isTransferGrantResponsePairedV1` returns TRUE for `"rejected"`, so the staged-input resolver's refusal branch is unreachable and every server refusal is reported as a malformed grant

**Status:** open · **Owner:** DAT-009 slice 3 (found by it; the repair is a one-line reorder in CLI-008 Unit B's module)
**Severity:** LOW · **Filed:** 2026-09-04, by DAT-009 slice 3's design pass — which was reading
`lease/staged-input.ts` in order to mirror it for the upload direction, and would have mirrored this.

**What.** `isTransferGrantResponsePairedV1`
(`packages/worker-protocol/src/transport.ts:350-358`) answers *"is this response outcome paired
with that request operation"*, and its first line is:

```ts
if (responseOutcome === "rejected") return true;
```

which is correct for what it asks: a refusal is a legitimate answer to either direction. But
`lease/staged-input.ts:252-258` uses its negation as the refusal guard:

```ts
if (!isTransferGrantResponsePairedV1("download", body.outcome)) {
  // A `rejected` lands here, and so would a cross-paired `upload_granted`.
  throw new StagedInputUnavailableError(pointer.artifactId, `outcome ${body.outcome}`);
}
const parsed = artifactDownloadGrantV1Schema.safeParse(body.grant);
if (!parsed.success) {
  throw new StagedInputUnavailableError(pointer.artifactId, "malformed grant");
}
```

**A `rejected` does not land there.** `!true` is false, so it falls through to the schema parse
with `body.grant` undefined, fails, and is reported as `"malformed grant"`. The inline comment
asserts a behaviour the code does not have, and **the server's actual reason —
`stale_fence` / `attempt_terminal` / `target_revoked` / `malformed`, which the frozen `rejected`
arm carries at `transport.ts:342` — is discarded**. The operator is told the control plane sent a
malformed grant when it sent a correct, well-formed refusal.

**Reachability.** LOW, and the direction is what makes it low: it **fails closed**. The throw still
happens, the run still fails, no file is staged from a refusal. Nothing is admitted that should not
be. What is lost is **diagnosability** — and only on a path (a refused staged-input download) that
has never run in production.

★ **Why it is filed rather than shrugged at.** It is the same shape as
[`DAT-009-terrain.md`](../E5-workspaces-secrets/tickets/DAT-009-terrain.md) §9's *"a value computed,
handed to the thing that could act on it, and dropped"* — here the value is the refusal reason and
the actor is the operator. And it is **load-bearing for the sibling direction**: DAT-009 slice 3
mints an **upload** grant, whose most likely refusal is `attempt_terminal`, which means *"this ran
outside the lifecycle window"* — the single most probable defect in that new code. Reported as
"malformed grant", it would send the reader hunting a protocol bug instead.

**Fix.** Check `body.outcome === "rejected"` explicitly and FIRST, and carry `body.reason` into the
error. One reorder, no schema change, no frozen change. It is not taken here because this ticket is
E5 work and the module is CLI-008 Unit B's; changing another unit's failure text inside an E5 PR is
the kind of drive-by that makes a diff unreviewable. `packages/worker-daemon/src/lease/artifact-export.ts`
does it correctly on the upload side and pins it with a test, so the two directions now disagree
until this is closed — which is itself the cheapest possible reminder.

★ **The transferable part.** A predicate's NAME told the truth and the CALL SITE read it as
answering a different question. `isTransferGrantResponsePairedV1` answers *"is this pairing legal"*;
the call site needed *"did I get a grant"*. Those coincide for every outcome except the one that
matters. **Before negating a shared predicate as a guard, check it against the case you are actually
guarding against** — and note that the comment beside it was written from the intent, not from the
function.

## E7-F018 — Both `capabilityProven` arms are structurally unreachable in every checked-in configuration, so no producer can move either counter

**Status:** open · **Owner:** UNOWNED — the precondition is an operator/deployment decision, not a code unit
**Severity:** HIGH · **Filed:** 2026-09-06 (W4U1), measured at `472885d5e`. Established by a 20-agent
scouting workflow; every claim below survived two independent refutation rounds and was re-measured
by hand before filing.

★★★ **FOUNDER RULING 2026-09-09 — `capabilityProven` STAYS UNWIRED, AS A PRINTED DISCLOSURE.
This is a decision, not an omission; the next reader should find a ruling here rather than a
gap.** `capabilityProven` is computed on every run, printed with every verdict and carried in
`verdict-json` — and it **gates nothing**. `--require-capability` stays an operator opt-in, off
by default (`server/src/cli/verify-e7-1-distributed-run.ts:65`), and no workflow, script or gate
clause passes it.

*The reason is this repository's own precedent, not a judgement about the remaining work.* A gate
nobody can pass gets deleted, argued around, and then bypassed. This finding is the measurement
that makes that outcome certain today: **no checked-in configuration makes any run distributed**,
so both arms read 0 structurally, and arming the flag now would mint an always-red gate whose
redness says nothing about the agent under test — on the first campaign that then needs it green.
A disclosure that is always printed and never lies is worth more than a gate that is always red
and will be relaxed.

**The condition for revisiting is named, so the ruling cannot become permanent by default:** turn
`--require-capability` on by default (and wire it into a gate clause) when BOTH **(a)** this
finding, E7-F018, is CLOSED — some checked-in configuration actually makes a run distributed and a
producer exists for at least one arm — AND **(b)** the rollout dial is ARMED in a real deployment,
not merely armable. Until both hold, do not read the absent gate as an oversight and do not "fix"
it by flipping the flag. **No code was changed by this ruling** — not the computation, not either
arm, not `capabilityProven`'s separation from `ok`; the same text is recorded in the CLI header
beside the limitations block so an operator meets it where the flag lives. Nothing here moves this
finding's **status**, **severity** or **UNOWNED** ownership.

**What.** `capabilityProven` is an OR over two counters (predicate
`server/src/services/e7-distributed-run-verifier.ts:506`, verdict `:522`). **Neither counter can be
moved by any producer, however correct, in any configuration checked into this repository** — and,
★ importantly, **not for the same reason**: arm 1 is keyed on a link only a CANARY-mode distributed
run creates (measurement 2), while arm 2 is never short-circuited and has no PRODUCER able to move
it — an unwired projection, a second deployment flag and a caller-supplied run id (measurement 3).
Nothing checked in puts any Organization into canary mode. This is a **reachability** defect, not a
coverage one: it invalidates the premise under which E7-1's headline capability gate is being worked
toward.

★★★ **NARROWED 2026-09-06 (W4U3-R3) — arm 2's disposition, precisely.** This paragraph used to end
*"and arming one would not open arm 2"*, and measurement 3's fact 4 used to say no writer could fire
for a handed-off run. Both were wrong in the FAIL-OPEN direction, and the correction changes what
arm 2 IS rather than whether this finding stands:

★★★ **CROSS-NOTE 2026-09-08 (W21) — which sentences below W21 invalidated, and which stand.** W21 gave
arm 2 a provenance predicate (see E7-F020). **INVALIDATED HERE:** every sentence describing arm 2's
query as *unconditional* and as `eq(taskOutputs.createdByRunId, run.id)` — it is now a join to an
APPLIED `output_projection` receipt on the run's `distributed_job_id` **and its
`distributed_attempt_id`**, and it short-circuits to 0 with no `distributed_job_id` **or no
`distributed_attempt_id`**; and "arm 2 is REACHABLE WITHOUT PROVING ANYTHING", which described the
pre-W21 predicate. **UNCHANGED, and re-measured by hand at `360d0b0ed`:** measurement 1 (nothing
checked in arms the rollout dial — two hits today, both register `reason` strings quoting the command;
zero excluding both registers), measurement 2 (arm 1), and measurement 3 facts 1-3 — in particular
`projectAcceptedOutput` still has ZERO production callers, which is now the reason arm 2 reads 0. This
★ **W21D ADDENDUM — this cross-note, whose whole job is enumerating what went stale, went stale
itself.** W21C (`b0944397b`, E7-F031) re-predicated BOTH arms onto the run's ATTEMPT and updated two
of seven narration sites; this cross-note was one of the five it missed, and kept the job-only wording
above until W21D corrected it in place. Same class as the defect the note documents, one layer up.

finding's **status, severity and UNOWNED ownership do not move**: the shared blocker is an operator
decision and nothing in W21 touched it. What changed is that arm 2 is now 0 for an HONEST reason
instead of being satisfiable by the platform.

- **Arm 1 is unreachable.** Unchanged, and the strongest of the two: it issues no query at all.
- **Arm 2 is not "unreachable" — it is REACHABLE WITHOUT PROVING ANYTHING** *(pre-W21; see the
  cross-note above)*. No *producer* can move
  it (measurement 3, facts 1-3, all intact). But an ordinary internal path already writes
  `task_outputs.created_by_run_id = run.id` before the handoff — `ensureRuntimeServicesForRun`
  (`heartbeat.ts:4524`) — so once the dial is armed, arm 2 can read non-zero for a run whose agent
  produced nothing. That is filed as **E7-F020** and is the reason to read arm 2's counter as
  evidence of NOTHING rather than as a bar nobody has cleared.

**What is UNCHANGED by the narrowing**, and was re-verified: the SHARED blocker (no checked-in
configuration makes any run a distributed run — measurements 1 and 2), arm 1's blocker, measurement
3's facts 1-3, this finding's **status**, **severity** and **UNOWNED** ownership, and the sufficiency
conclusion. If anything the narrowing STRENGTHENS the reason not to schedule producer work off a green
arm 2: the counter can be non-zero for reasons that have nothing to do with a producer existing.

★★★ **Filed because Track A — composing the `workspace_patch` producer chain — has now been attempted
or proposed FOUR times, each dying on a different surface symptom, and the root cause has never been
written down.** It is written down here so the fifth attempt does not happen.

**Measurement 1 — nothing checked in arms the rollout dial. One command:**

```
grep -rn AOA_DISTRIBUTED_EXECUTION_ROLLOUT --include=*.yml --include=*.yaml --include=*.json --include=Dockerfile* .
```

→ At `472885d5e`, when this finding was filed: **ZERO hits, exit 1**, repo-wide.

★★★ **Re-run 2026-09-06 (W4U3-FIX): the command now returns exactly ONE hit and exit 0 — and
that hit is this finding's own register entry, quoting the command back at itself**
(`scripts/finding-ownership.json`, the E7-F018 `reason` string; `*.md` is outside the `--include`
filters, so this page does not match). That is a self-match, **not** an arming. The durable form
excludes the register:

```
grep -rn AOA_DISTRIBUTED_EXECUTION_ROLLOUT --include=*.yml --include=*.yaml --include=*.json --include=Dockerfile* . | grep -v scripts/finding-ownership.json
```

→ **ZERO hits, exit 1**, repo-wide, at this tip. Recorded rather than quietly rewritten,
because a one-command reproduction that contradicts its own text is how a live finding gets dismissed
as stale — the same failure class as a check that cannot fire, in a register instead of in CI. The
measurement itself is unchanged: no compose file, Dockerfile, workflow or manifest sets the variable.

The variable appears ONLY in `docs/`, in
`server/src/config/distributed-execution-rollout-source.ts` (`:35`, which names it and is
DEFAULT-DISABLED — an absent map resolves every Organization to `off`), in `server/src/index.ts`
(`:1223`, the malformed-config warning), and in tests (`rollout-dial-live.test.ts`,
`mig-shadow-evidence.integration.test.ts`). No compose file, no Dockerfile, no manifest sets it.

**Measurement 2 — arm 1's key is written on the canary path and nowhere else.**

- The SOLE writer of `heartbeat_runs.distributed_job_id` is `markRunHandedOffToDistributed`
  (`server/src/services/heartbeat.ts:6921`).
- Its ONLY call site is `server/src/services/heartbeat.ts:5422`, inside
  `if (shouldSuppressLegacyExecution(canaryExecutionOwner))`.
- `canaryExecutionOwner` is assigned only inside the block gated on
  `distributedRolloutState === "canary"` (`server/src/services/heartbeat.ts:5259-5274`). With
  measurement 1, that state is unreachable.
- So arm 1 never issues a query at all: `if (run.distributedJobId) {`
  (`server/src/services/e7-distributed-run-verifier-store.ts:200`) is false, and
  `workspacePatchArtifacts` stays at its initialiser `0` (`:199`).

**Measurement 3 — arm 2's blocker is NOT arm 1's, and is not the rollout dial alone.** ★ Arm 2's
query is issued **unconditionally** (`server/src/services/e7-distributed-run-verifier-store.ts:213-216`):
it sits OUTSIDE the `if (run.distributedJobId)` block that short-circuits arm 1, so measurement 2 does
NOT carry over to it. Arm 2 has to be derived on its own terms. Its predicate is
`eq(taskOutputs.createdByRunId, run.id)` (`:216`), and **four independent facts** hold it at 0:

1. **The distributed producer has no caller.** The distributed-job → `task_outputs` projection is
   `jobOutputBridge.projectAcceptedOutput`, declared `unwired` with ZERO production callers in
   `scripts/gate-clause-wiring.json` (`E3-17-output`: *"JOB-014 output projection has zero callers;
   task_outputs is still written by the legacy path. Wire at sink cutover (Sprint 6)."*). Re-measured
   by grep at this tip: `projectAcceptedOutput` occurs only in its own interface declaration and
   implementation (`server/src/services/job-output-bridge.ts:175`, `:250`) plus one module-doc line.
   **Arming the rollout dial creates no caller** — this is a wiring unit (C4 on the critical path),
   not a dial setting.
2. **A SECOND, INDEPENDENT flag refuses it fail-closed.** Every bridge entrypoint opens with
   `assertEnabled()`, which reads **`AOA_DISTRIBUTED_EXECUTION_ENABLED`** — not the rollout dial —
   via `readDistributedExecutionDeploymentFlag` (`server/src/config/distributed-execution.ts:22-24`,
   default `false`) and throws `JobOutputBridgeDisabledError`, writing nothing
   (`job-output-bridge.ts:231-235`, `:251`).
3. **`createdByRunId` is caller-supplied and never derived** (`job-output-bridge.ts:291`:
   `createdByRunId: input.output.createdByRunId ?? null`). So even a wired, flag-on caller must ALSO
   pass the heartbeat run id for `= run.id` to match; a bridge write carrying a null run id is
   invisible to arm 2.
4. **FOUR legacy writers can put a `heartbeat_runs` id in the column, and TWO of them can fire for a
   handed-off run.** ★★★ **RE-DERIVED AND CORRECTED 2026-09-06 (W4U3-R4).** Two earlier versions of
   this fact are kept visible rather than deleted, because a fail-open enumeration is precisely what
   propagates — this one reached four documents and a machine-checked register before anyone counted
   it independently. R2 said *"the two legacy writers that DO set the column cannot fire for a
   handed-off run"* (fail-open). R3 said *"three production writers … two cannot fire, the THIRD
   can"* — the right shape, the wrong count, and it cited `output-detection.ts:201` under the label
   *"the board `POST /api/issues/:issueId/outputs`"*, which are **two different routes**.

   ★★★ **THE WARRANT — how this census is closed, and how a future reader re-closes it.** R3 closed
   it with `grep -rn createdByRunId server/src --include=*.ts | grep -v __tests__`. That method
   **provably cannot find its own counterexample**: `server/src/routes/task-outputs.ts:54` forwards
   `req.body` into the service and never writes the token `createdByRunId`, so no grep for that token
   can see it. The census is closed instead **on the sole INSERT site**. There is exactly ONE insert
   into `task_outputs` in **production source** — `.insert(taskOutputs)` at
   **`server/src/services/task-outputs.ts:181`**, inside `upsertTaskOutputForIssue` (`:135`); the
   only other inserts in the tree are the three raw-SQL admin fixtures under `server/src/__tests__`
   that the reproduction below enumerates. Every row **CREATION** therefore passes through that one
   function whether or not the caller ever names the field, and **enumerating that function's
   callers closes the set of writers able to MINT a `created_by_run_id`**. Re-close it with:

   ```
   grep -rn "insert(taskOutputs" server packages --include=*.ts
   #   -> exactly 1 hit: server/src/services/task-outputs.ts:181

   grep -rniI "insert[[:space:]]\+into[[:space:]]\+\(public\.\)\?task_outputs\|copy[[:space:]]\+task_outputs" \
        . --exclude-dir=node_modules --exclude-dir=.git | grep -v '^\./docs/\|^\./scripts/'
   #   -> 3 hits, all server/src/__tests__ admin fixtures. No production raw-SQL insert.
   #   * The trailing exclusion is REQUIRED and is the durable form: without it, the prose in
   #     docs/ and E7-F018's register entry match the pattern back at you. Same self-match trap
   #     E7-F018's own rollout-dial reproduction already documents.

   grep -rn "upsertTaskOutputForIssue\|upsertForIssue" server packages ui \
        --include=*.ts --include=*.tsx | grep -v __tests__
   #   -> 17 lines. SIX are not call sites (one import, two declarations, three prose comments);
   #     the remaining ELEVEN are: the ten legacy callers censused below, plus
   #     job-output-bridge.ts:303, which is handled by facts (1)-(3) rather than here.
   ```

   ★ **What that method does NOT cover, stated so the next round does not have to guess.** It finds a
   literal `.insert(taskOutputs)` and a literal `INSERT INTO` / `COPY` on the table. It would miss a
   table name assembled at runtime and a database-side trigger or rule. Both were checked separately
   and are absent at this tip: the only `sql.raw` INSERT in the tree targets `memory_items`
   (`server/src/services/memory-projection.ts:151`), and the six migrations naming `task_outputs`
   (`0114`, `0200`, `0213`, `0214`, `0246`, `0247`) contain only DDL, one column `UPDATE`, and
   `GRANT`/RLS — no row INSERT and no trigger. If either of those becomes false, this census reopens.

   ★★★ **What the chokepoint actually warrants: row CREATION, plus the COLUMN for a SECOND reason.**
   The insert census closes creation. It closes the *column* too, but not because every writer goes
   through the chokepoint — **three UPDATE sites do not**. There are four `.update(taskOutputs)`
   sites in production source and only ONE (`task-outputs.ts:167`, the upsert-by-`(provider,
   externalId)` branch) is inside `upsertTaskOutputForIssue`. The other three bypass it entirely:
   `updateMutable` (`task-outputs.ts:237`), `clearSiblingPrimaries` (`:71`, reached from
   `updateMutable` at `:231` as well as from inside the chokepoint at `:147`), and
   `workspace-runtime.ts:2890`. None can write `created_by_run_id`: the latter two set only
   `is_primary`/`updated_at` and `status`/`health_status`/`url`/`updated_at` respectively, and
   `updateMutable` spreads a body validated by **`mutableTaskOutputSchema`, which is `.strict()` and
   omits `createdByRunId`** (`packages/shared/src/validators/task-output.ts:55-63`) — so
   `validate()` (`schema.parse`, `middleware/validate.ts:6`) THROWS on a request carrying the field
   rather than applying it.

   ★★★ **THE SEAM, named because it is the thing a future reader most needs.** The column half of
   this warrant rests entirely on that one `.strict()` omission, not on the INSERT census. **If
   `createdByRunId` were ever added to `mutableTaskOutputSchema`, `PATCH /api/task-outputs/:id`
   (`routes/task-outputs.ts:87-97`) would immediately become a writer this warrant is structurally
   unable to see** — that route never calls `upsertTaskOutputForIssue`, so no enumeration of the
   chokepoint's callers would ever list it. Re-checking the callers is not sufficient; re-check the
   schema.

   **The chokepoint's callers — eleven production call sites, ten of them legacy.** Four of the ten
   pass a value capable of being a `heartbeat_runs` id:

   | # | call site | `createdByRunId` | can it fire for a handed-off run? |
   |---|---|---|---|
   | 1 | `task-output-emitters.ts:150` (`emitSandboxPreviewTaskOutput`), sole caller `heartbeat.ts:5557` | `run.id` (`heartbeat.ts:5574`) | **No.** It sits AFTER `return; // CLI-006-SUPPRESSION-RETURN` (`heartbeat.ts:5451`), so a handed-off run returns before `adapter.execute` and never reaches it |
   | 2 | `routes/output-detection.ts:181` — `POST /heartbeat-runs/:runId/detected-outputs/:index/confirm` | `runId`, a **path param** (`:201`) | **No.** Its only feed is `heartbeat_runs.detected_outputs`, whose sole **creating** writer is `heartbeat.ts:5907` — also past the suppression return, and additionally reading `adapterResult`, which only `adapter.execute` assigns. (The column has three writers, not one: `output-detection.ts:218` and `:286` also write it, but both only rewrite an EXISTING array element — each 404s when `!outputs \|\| index >= outputs.length` — so neither can mint the array. The verdict is unchanged.) ★ This is **not** the route R3 labelled it — see below |
   | 3 | ★ `task-output-emitters.ts:113` (`emitRuntimeServiceTaskOutput`) | `row.startedByRunId` | **YES**, and it fires **before** the handoff — **E7-F020** |
   | 4 | ★ `routes/task-outputs.ts:54` — `POST /api/issues/:issueId/outputs`, mounted `app.ts:566` | **whatever the request body says** | **YES**, for any authenticated company-scoped caller — **E7-F015** |

   Six more callers reach the same insert but can never carry a run id: `crew-output-capture.ts:129`
   (hard-coded `null` — a crew run id lives in `internal_agent_runs`, the column FKs `heartbeat_runs`),
   `attach-task-artifact-tool.ts:164` (sets only `createdByAgentId`), `task-output-backfill.ts:50`,
   the two emitters that never set the field — `emitPullRequestTaskOutput` (`task-output-emitters.ts:71`)
   and `emitBranchTaskOutput` (`:162`) — and `task-outputs.ts:213`, which is the service wrapper
   delegating into the chokepoint rather than an independent writer. That is 4 + 6 = the ten legacy
   call sites.

   ★ **A fifth capable caller exists and is deliberately not counted here:**
   `job-output-bridge.ts:303` passes `input.output.createdByRunId ?? null`. It is the DISTRIBUTED
   producer, and it is exactly what facts (1)-(3) above close — zero production callers, a
   fail-closed second flag, and a caller-supplied run id. Counting it among the *legacy* writers
   would double-count facts 1-3.

   ★ **Path 3's detail, since it is the one nobody has to do anything to trigger.**
   `ensureRuntimeServicesForRun` at **`heartbeat.ts:4524`** → `startLocalRuntimeService` with
   `startedByRunId: input.runId` (`workspace-runtime.ts:2649`, defaulted at `:2340`) →
   `persistRuntimeServiceRecord` (`:1785`, called at `:2383` at status `"starting"`, before
   `waitForReadiness`) → `emitRuntimeServiceTaskOutput` (`:1821`) →
   `task_outputs.created_by_run_id = run.id`. `:4524` precedes the canary block (`:5258-5274`), the
   handoff (`:5422`) and the suppression return (`:5451`), all inside the same `executeRun`
   (`heartbeat.ts:3061`; no other inner function is declared between `3061` and `5500`, so there is no
   intervening boundary). ★ It also has a **second, HTTP-reachable caller**:
   `task-output-backfill.ts:91` re-emits every current runtime service for the issue's workspaces,
   and that backfill runs from **GET** `/api/issues/:issueId/outputs` (`routes/task-outputs.ts:40`)
   whenever the issue has zero outputs — so a plain read can mint the row from a pre-existing
   `workspace_runtime_services.started_by_run_id`.

   ★ **The R3 mis-attribution, named so it cannot recur.** R3's second bullet labelled *"the board
   `POST /api/issues/:issueId/outputs`"* but cited `server/src/routes/output-detection.ts:201`.
   Those are different routes: `output-detection.ts:201` is
   `POST /heartbeat-runs/:runId/detected-outputs/:index/confirm` (row 2, **cannot** fire), while
   E7-F015's actual subject is `server/src/routes/task-outputs.ts:45-53` (row 4, **can** fire) — the
   writer the R3 enumeration omitted entirely. So the finding that already warned about this exact
   route was cited against the wrong file while its real route went uncounted. Row 2 is kept in the
   census with its own verdict rather than deleted.

   So a handed-off run **can** write `task_outputs` under its own run id by TWO independent paths —
   one requiring an authenticated caller to pass a field (**E7-F015**), one requiring nobody to do
   anything at all (**E7-F020**), and the latter fires on the DEFAULT isolated-workspace
   configuration whenever the run declares a `workspaceRuntime.services` entry. What this changes
   HERE is only the reason arm 2 sits at 0 today, which is the shared blocker (nothing arms the
   dial), **not** an absence of writers.

**Each arm's blocker, stated separately.** They SHARE one: no run in any checked-in configuration is a
distributed run at all, because the handoff that mints `distributed_job_id` /
`execution_owner = "distributed"` runs only in the canary block (measurements 1-2). Past that point
they DIVERGE. **Arm 1** is closed by the shared blocker alone — it issues no query; arming the dial
opens the `if` but leaves arm 1 still needing a **committed `workspace_patch` `job_artifacts` row**
(`verifier-store:206-208`), and `buildWorkspacePatch` / `createResultCommitter` have zero production
callers. **Arm 2** is never short-circuited, and **no producer moves it**: the DISTRIBUTED producer
path is closed by facts 1-3 above, none of which is the rollout dial — wiring the projection bridge,
turning on `AOA_DISTRIBUTED_EXECUTION_ENABLED` and passing the run id is work disjoint from arm 1's
(ship a patch producer). So the dial is **necessary for both arms and sufficient for neither** *as a
route to a producer-backed count*.

★★★ **But arm 2 is not held at ZERO by that, and saying so was this finding's own fail-open.** An
earlier version of this paragraph read *"an operator who armed the dial and changed nothing else
would still read `task_outputs=0`"*. **That is false, and false in the dangerous direction** —
corrected 2026-09-06 (W4U3-R3) and kept on the record because it is the sentence that would have made
a green arm 2 safe to quote. What is actually true, stated so it can be checked:

- **The dial alone yields:** a run that hands off, so arm 1's `if` opens and still finds no committed
  `workspace_patch` row. On arm 2 it yields **whatever the legacy pre-handoff code already wrote for
  that run id** — which is `0` only if the run wrote nothing before `heartbeat.ts:5451`.
- **Arm 2 goes NON-ZERO with no agent output at all** when, in addition to the dial, the run is
  task-scoped and reaches `heartbeat.ts:4523` with (a) instance `enableIsolatedWorkspaces` true (the
  default; `workspace-resolution.ts:99-100`), (b) a realized workspace, and (c) at least one
  `workspaceRuntime.services[]` entry in the run-scoped config (`workspace-runtime.ts:2593-2596`)
  that is **freshly started** rather than reused. That writes
  `task_outputs.created_by_run_id = run.id` at `:4524`, ahead of the handoff. Filed as **E7-F020**.

So the honest summary is not *"the dial changes nothing on arm 2"*. It is: **the dial does not give
arm 2 a PRODUCER, and arm 2 does not need one to read non-zero.**

**Consequence, stated precisely — and it is a SUFFICIENCY claim, not a necessity one.** What this
finding refutes is the reading *"ship Unit F (output capture) and `capabilityProven` follows"*. It does
**not** establish that a producer is unnecessary: on arm 1 a committed `workspace_patch` producer stays
strictly **necessary**, and nothing here argues for skipping or descoping it. Both statements hold at
once because they answer different questions — **necessary: yes. Sufficient: measured false.** This
finding licenses neither *"a producer is pointless"* nor *"ship Unit F and we are done"*. Concretely:
shipping `buildWorkspacePatch`, `createResultCommitter`, the export sequencer's supervisor hook and a
real `exportArtifact` moves **nothing** while the dial is unarmed, because no `distributedJobId` is
ever written and arm 1's `if` never opens — and it moves nothing on arm 2 in any case, whose
blockers (measurement 3) a producer does not touch. ★ Clause 6's own operator-facing text does NOT say this —
it blames output capture alone (`e7-distributed-run-verifier.ts:509-515`), which is separately filed
as **E7-F016**. Both are true; only this one is load-bearing for the next attempt.

**Why UNOWNED, and why that is the honest status rather than a shrug.** The precondition is a
DEPLOYMENT decision that no code ticket can make. It needs two artefacts, and this repository already
declares both to be operator-owned and, on staging, forbidden:

1. **A compose diff enabling dispatch on a worker.** `scripts/d1-dispatch-expectation.json:17` already
   anticipates exactly this: `AOA_WORKER_DISPATCH_ENABLED` is declared `expect: "absent"` with the
   reason *"dispatch is OFF; enabling it is a separate attributable compose diff."*
2. **A rollout JSON naming an Organization canary.** And `scripts/lib/staging-manifest-invariants.mjs`
   (`:516-541`) FORBIDS any staging worker from declaring the dispatch switches at all —
   *"DISPATCH-DEFAULT VIOLATION: … dispatch stays OFF by default; no staging worker may set the
   switches that turn it on (DEP-010)"*.

Naming a code ticket as owner would be the false-ownership claim `check-finding-ownership.mjs` exists
to prevent: the ticket could ship in full and the finding would not move. HIGH, and therefore never
`accepted`.

**Not resolvable by relabelling.** The apparent shortcut — label arbitrary exported bytes
`kind='workspace_patch'` — is recorded and refuted as **E7-F019**.

## E7-F019 — Labelling exported bytes `kind='workspace_patch'` moves arm 1's counter without redefining its predicate; only the patch CONSUMER refuses them

**Status:** open · **Owner:** UNOWNED — recorded terrain; the refusal that makes this not-a-shortcut
already exists and needs no change
**Severity:** MEDIUM · **Filed:** 2026-09-06 (W4U1), measured at `472885d5e`. Cross-links **E7-F018**
(the unreachability this appears to route around) and **E7-F015** (the same forgeability axis, on the
other arm).

**What.** `kind` on an exported artifact is the CALLER's declaration and the export module never
substitutes a default. Its own comment names the counter it feeds
(`packages/worker-daemon/src/lease/artifact-export.ts:58-70`): *"`kind` is honoured by the control
plane AND is what the E7-1 capability counter filters on
(`e7-distributed-run-verifier-store.ts:207` matches `workspace_patch` only), so a default picked here
would silently decide someone else's gate."* The commit path validates size, sha256, object-key
prefix and tenancy, and derives `retention` control-plane-side from `kind` — but takes `kind` ITSELF
as declared (`server/src/services/artifact-commit.ts:167,177,192`; the sensitivity/retention split is
DAT-010's deliberate choice and this finding does not disturb it).

So a run that exports ANY bytes under that label commits a row satisfying arm 1's predicate exactly —
`jobId`, `kind = 'workspace_patch'`, `status = 'committed'`
(`server/src/services/e7-distributed-run-verifier-store.ts:206-208`).

**Why this is a trap rather than an option.** It passes the standing prohibition **literally**: the
predicate is untouched, the counter is untouched, no gate is redefined. What it produces is a green
`capabilityProven` for bytes that are not a workspace patch. The system's own consumer refuses them —
`server/src/services/patch-apply.ts:126-127` fetches the committed object and parses it with the
FROZEN `workspacePatchManifestV1Schema`, returning `rejected("malformed")` on any parse failure,
fail-closed, before any state change (and after the org/job/attempt prefix bind at `:111-116`, so the
fetch itself cannot be pointed at a foreign namespace).

★ **Recording this matters because the refusal is at the APPLY path — not at the commit path and not
at the counter.** The forged label would still flip the verdict; what it could never do is produce a
patch the system will apply. That gap between "the counter moved" and "the capability exists" is the
exact thing a capability gate is for, which is why the shortcut is not one.

**Severity justification — MEDIUM, argued in both directions.** Not HIGH: it is not reachable today.
Arm 1 issues no query at all in any checked-in configuration (E7-F018), and `--require-capability` is
OFF by default (`server/src/cli/verify-e7-1-distributed-run.ts:65`), so nothing is decided on this
signal now. Not LOW: the moment E7-F018's operator precondition is satisfied this becomes the
cheapest available path to a false green — and it is cheapest precisely for whoever is then under
pressure to make Track A land, which is the population least able to price it. Same rung as E7-F015,
deliberately: both are provenance defects in the same verdict, one per arm.

**Disposition — UNOWNED, because there is nothing here to FIX.** `patch-apply`'s fail-closed
validation is correct and must not be relaxed to make a producer land. Whether `artifact-commit`
should ALSO validate `workspace_patch` bytes against the frozen schema at commit time is a real
question this finding deliberately does not answer — it belongs with whoever ships the producer, and
it is recorded here so that it is asked rather than rediscovered. No code unit owns this today, and
inventing one would be a false ownership claim.

## E7-F020 — Arm 2 of `capabilityProven` can count a platform-minted `task_outputs` row through an unexercised UPSERT collision on a reused platform `external_id` (the ordinary-heartbeat-path defect was FIXED at the predicate by W21; the residual is gated on the unbuilt E7-1 producer)

**Status:** **resolved** · **Resolved by:** W21 (headline, at the predicate) + review of PR #422 (residual refuted), 2026-09-11 · **Owner (while open):** CLI-008 · **Severity (while open):** was HIGH, corrected to MEDIUM before closing · **Filed:** 2026-09-06 (W4U3-R3), measured
at `75920ef9a`. Found by an auditor re-deriving E7-F018's arm-2 analysis; every line number below was
re-read by hand in this worktree before filing.

---

### ★ RESOLVED 2026-09-11 at `3223eba74` — the headline defect is FIXED (W21 predicate) AND the residual is REFUTED (not a defect). Both halves gone → closed.

Two things had to be true for this to stay open: (1) the FILED headline defect, and (2) the UPSERT-collision residual an earlier 2026-09-10 amendment preserved. Both are gone.

**(1) Headline — CLOSED at the predicate (W21).** Arm 2 no longer reads `eq(taskOutputs.createdByRunId, run.id)`. It is an `innerJoin` from `task_outputs` to `job_projection_receipts`, keyed on
`jobProjectionReceipts.jobId = run.distributedJobId` **AND** `jobProjectionReceipts.attemptId =
run.distributedAttemptId`, `projectionKind = "output_projection"`, `aggregateKind = "task_outputs"`,
`status = "applied"`, company-scoped, short-circuiting on a null distributed id
(`server/src/services/e7-distributed-run-verifier-store.ts:579-604`). The receipt has exactly one
admissible writer — `jobOutputBridge.projectAcceptedOutput` (`server/src/services/job-output-bridge.ts:250`), fence-guarded via `recordGovernedProjection`.

**(2) Residual — REFUTED by review of PR #422 (Codex P2), confirmed at source.** The earlier amendment kept this open on "a reused-`external_id` UPSERT collision could count a platform-minted row." That is **not a false-provenance defect**: on collision `upsertTaskOutputForIssue` runs `.set({ ...values })` (`server/src/services/task-outputs.ts:172`) — it **overwrites the row's content** with the caller's `values` ("updates CONTENT but is PROMOTE-ONLY for the primary flag"). And for arm 2 to count the row, an `applied`/attempt-bound `output_projection` receipt must exist, which only the bridge writes — in the SAME transaction as an upsert whose `values` are built from the accepted event's own output (`job-output-bridge.ts:279-312`, fields from `input.output.*`; duplicate events short-circuit as `replayed`). So every row arm 2 counts necessarily holds genuine agent output that reached AoA under a live fence; the stable row id / creation timestamp do not invalidate the capability claim. There is **no field that preserves falsely-countable platform-generated evidence** in a counted row. The residual was therefore phantom debt — keeping the finding open on it was itself the "records disagreeing with code" error, one level up. Closed. (The AS-FILED "Severity — HIGH, argued both directions" paragraph below is kept verbatim as the historical measurement that sized the W21 fix.)

---

### ★★★ NARROWED 2026-09-08 (W21) — the platform-write path is CLOSED at the predicate; a residual survives, so this stays OPEN

**What changed.** Arm 2's predicate is no longer `eq(taskOutputs.createdByRunId, run.id)`. It is now a
join to `job_projection_receipts`: a `task_outputs` row counts only when an **APPLIED
`output_projection` receipt** names it (`aggregate_kind = 'task_outputs'`,
`target_aggregate_id` = the row, `job_id` = the run's `distributed_job_id` **and `attempt_id` = its
`distributed_attempt_id`**, company-scoped), and arm 2 short-circuits to 0 for a run with no
`distributed_job_id` **or no `distributed_attempt_id`**.

> **Re-predicated 2026-09-08 (W21C, E7-F031); narration corrected 2026-09-08 (W21D).** As filed at
> W21 the receipt match was `job_id` **alone**. A job carries `max_attempts` (default 3) and every
> attempt shares the job id, so a RETRY attempt's output printed `capability: PROVEN` for a run bound
> to attempt 1 that produced nothing. Both arms are attempt-bound now. This paragraph kept the
> job-only wording for one commit; W21D swept it and the four other stale sites.

**Why that predicate and not a `type`/`provider` heuristic — derived from the writer census, not from
taste.** The census below (fact (4) of E7-F018, re-verified at `360d0b0ed` before this change) closes
on the callers of `upsertTaskOutputForIssue`, the sole INSERT into the table. The receipt is the one
thing NO legacy caller can produce:

- **ADMITS exactly one writer** — `jobOutputBridge.projectAcceptedOutput`
  (`server/src/services/job-output-bridge.ts:303`), the distributed output projection. It is the only
  code in the tree that writes `projection_kind = 'output_projection'` with
  `aggregate_kind = "task_outputs"` (`:306-315`), it writes it in the SAME tenant transaction as the
  row, and `recordGovernedProjection` (`packages/db/src/repositories/tenant/job-control.ts:3794`) runs
  `guardActiveFence` FIRST, so `job_id`/`attempt_id` are the control plane's LIVE fence rather than a
  caller's assertion.
- **EXCLUDES all ten legacy callers**, including both writers that can fire for a handed-off run:
  `emitRuntimeServiceTaskOutput` (`task-output-emitters.ts:113` — **this finding**) and
  `POST /api/issues/:issueId/outputs` (`routes/task-outputs.ts:54` — E7-F015). Neither writes a
  receipt, and neither can: the receipt insert is fence-guarded on a live distributed attempt, which a
  pre-handoff heartbeat emitter and an HTTP route do not have. **The exclusion is structural, not a
  filter on caller-controlled content** — which is the bar this finding set.
- **The weaker form is closed too.** Pointing the verifier at an ordinary non-distributed heartbeat run
  no longer prints `capability: PROVEN`: no `distributed_job_id`, no query, count 0.

★★★ **THIS NARROWING SHIPPED WITH A DEFECT OF ITS OWN, AND W21 INTRODUCED IT.** The change moved
ONE consumer of "which `task_outputs` rows belong to this run" and left its sibling — clause 4's
secret-scan surface in `listRunSecretScanSurfaces` — on `created_by_run_id`. A row projected through
the bridge with a NULL run id therefore counted as capability evidence and was **never scanned for
secrets**, so the verifier could report a clean mechanism/capability verdict over a leaked key. Found
by external review (Codex P2 on PR #385), byte-verified, and filed as **E7-F030** with its own fix and
pins in the same suite. It is recorded here, in this block, because it was created by this narrowing —
not inherited. It does not change anything stated above about arm 2's predicate, which is unchanged
and remains correct for its error direction.

**Proof, both arms, observed RED before the fix.**
`server/src/__tests__/e7-f020-arm2-provenance.integration.test.ts` (embedded PG, real lease fence, real
bridge, real emitter). Against the pre-fix predicate: `[negative]` 1≠0, `[mixed]` 2≠1, `[cross-job]`
1≠0, `[no job]` 1≠0 and the **second `[positive]` arm** ("NO run id") 0≠1 all FAILED, while the first
`[positive]` arm ("on this run's job") passed. Post-fix 6/6 pass.
The **positive controls are load-bearing**: mutating the count to `return 0` reds **both `[positive]`
arms** and `[mixed]` while `[negative]` stays green — i.e. deleting the feature is
distinguishable from fixing it.

**WHAT SURVIVES — the residual, and why this stays OPEN.** `upsertTaskOutputForIssue`
(`services/task-outputs.ts:135-178`) is an UPSERT on `(company_id, issue_id, provider, external_id)`:
when a projected output collides with an existing row it **UPDATES that row in place** and the receipt
links it. So a future producer that reuses a platform-minted `external_id` (e.g.
`runtime-service:<id>`, `task-output-emitters.ts:98`) would get a **platform-minted row counted** —
E7-F020's own class, one layer down. It is bounded (it needs a real fenced accepted-output event, so
nobody-does-anything no longer reaches it) and **unexercised** (`projectAcceptedOutput` has zero
production callers), but it is the one remaining way a row the platform wrote reaches this counter,
and it belongs with whoever ships the producer.

**WHAT THIS DOES NOT BUY — verified at `360d0b0ed`, both E7-F018 claims re-measured by hand.**
1. `grep -rn AOA_DISTRIBUTED_EXECUTION_ROLLOUT --include=*.yml --include=*.yaml --include=*.json --include=Dockerfile* .`
   returns **two** hits at this tip, `scripts/finding-ownership.json` and
   `scripts/gate-clause-wiring.json` — **both register `reason` strings quoting the command back at
   the reader** (E7-F018 documents the first self-match; the second appeared later and is recorded
   here rather than quietly dropped). Excluding both registers: **zero hits, exit 1, repo-wide.** No
   compose file, Dockerfile, workflow or manifest arms the dial.
2. `grep -rn "capabilityProven\|require-capability\|verify:e7-1" .github` → **zero hits**. The flag is
   off by default (`server/src/cli/verify-e7-1-distributed-run.ts`, `requireCapability: false`) and the
   `verify:e7-1-distributed-run` package script is invoked by no workflow.

So **arm 2 now reads 0 on every real run**, and the gate is **correctly CLOSED where it was falsely
open**. That is strictly better than a false PROVEN and it is **not the capability gate working**.
What remains blocked, and by what: the campaign still needs (a) an operator arming the rollout dial —
which `scripts/lib/staging-manifest-invariants.mjs:516-541` FORBIDS on every staging worker — and (b) a
production caller for `projectAcceptedOutput` (arm 2) / a committed `workspace_patch` producer (arm 1).
Both are E7-F018's, still UNOWNED, and neither moved.

**Not widened.** E7-F015's own route hardening is untouched and its entry is not edited here; the
receipt predicate does mean that route can no longer move arm 2, which is an observation for that
finding's owner to verify, not a closure claimed by this unit. Arm 1, the `ok` computation, and
`capabilityProven`'s separation from `ok` were not touched.

**Text kept in sync.** `E7_CAPABILITY_LIMITATIONS` said arm 2 "carries NO provenance filter"; that is
now false, so the block was rewritten to state the predicate AND the residual, and its anti-drift tests
were repointed (not relaxed — the deny-list is kept verbatim and extended with "now works"/"gate
works"/"capability is proven"/"ready to gate").

**Everything below this line is the finding AS FILED, and describes the PRE-W21 predicate.** It is kept
verbatim because it is the measurement that sized the fix.

---

**What.** `countProducedOutputs` applies **no provenance filter** to arm 2: it counts every
`task_outputs` row whose `created_by_run_id` equals the run id
(`server/src/services/e7-distributed-run-verifier-store.ts:213-216`), and one such row is enough to
clear clause 6 (`e7-distributed-run-verifier.ts:506`) and set `capabilityProven: true` (`:522`).

**An ordinary internal path writes exactly such a row, before the run is even handed off.** Inside
`executeRun` (`server/src/services/heartbeat.ts:3061`; no other inner function is declared between
`3061` and `5500`, so the ordering below is straight-line):

```
heartbeat.ts:4523   if (isolatedWorkspacesEnabled && realizedWorkspace) {
heartbeat.ts:4524     await ensureRuntimeServicesForRun({ ... runId: run.id ... })
                        -> workspace-runtime.ts:2707  (control locks, activation fence)
                        -> workspace-runtime.ts:2649  startLocalRuntimeService({ startedByRunId: input.runId })
                        -> workspace-runtime.ts:2340  const startedByRunId = input.startedByRunId ?? input.runId
                        -> workspace-runtime.ts:2383  persistRuntimeServiceRecord(db, record)    // status "starting"
                        -> workspace-runtime.ts:1821  emitRuntimeServiceTaskOutput(db, values)
                        -> task-output-emitters.ts:113  createdByRunId: row.startedByRunId  ==  run.id
                        -> task-outputs.ts:47           task_outputs.created_by_run_id = run.id
heartbeat.ts:5258     let canaryExecutionOwner ...          // the canary block starts HERE
heartbeat.ts:5422     markRunHandedOffToDistributed(...)    // the handoff
heartbeat.ts:5451     return; // CLI-006-SUPPRESSION-RETURN
```

**The fail-open configuration, stated so it can be checked.** All of the following, and nothing else
— no forged request, no authenticated caller, no unusual operator action beyond the one E7-F018
already says is owed:

1. **The rollout dial names the Organization `canary`** — E7-F018's shared blocker, and the single
   operator artefact that turns a run into a distributed run at all.
2. **Instance `enableIsolatedWorkspaces` is true** — the instance-wide DEFAULT
   (`server/src/services/workspace-resolution.ts:99-100`).
3. **The run realizes an execution workspace** (`realizedWorkspace` non-null;
   `heartbeat.ts:3770` or `:3907`), so the `if` at `:4523` opens.
4. **The run-scoped config carries at least one `workspaceRuntime.services[]` entry**
   (`workspace-runtime.ts:2593-2596`) — i.e. an ordinary declared dev server.
5. **That entry is freshly STARTED for this run, not reused.** A `lifecycle: "ephemeral"` entry always
   is (no reuse key, so the reuse branch is skipped); a `shared` entry is whenever no tracked service
   matches its reuse key. ★ The reuse branch persists `existing.startedByRunId` — the ORIGINAL
   starter's run id — so a warm reuse credits a **different** run and does NOT trip this. Heartbeat
   already draws exactly this distinction one block later (`heartbeat.ts:4561`,
   `runtimeServices.some((service) => !service.reused)`).
6. **The run is task-scoped** (`issue.id` non-null) — `emitRuntimeServiceTaskOutput` returns early
   without it (`task-output-emitters.ts:92`). Canary requires `issueId` anyway (`heartbeat.ts:5272`).

★★ **The service does not have to work.** The first persist is at status `"starting"`, BEFORE
`waitForReadiness` (`workspace-runtime.ts:2383` then `:2384`), so a dev server that never comes up has
already written the row; the failure path re-persists the SAME `externalId`
(`runtime-service:<id>`, `task-output-emitters.ts:98`) and therefore updates that row rather than
removing it. A preview URL is not required either — with no URL the row is typed `runtime_service`
instead of `preview_url` (`task-output-emitters.ts:96`), and arm 2 counts rows, not types.

**So the reading is:** a canary run that armed the dial, ran in the default isolated-workspace
configuration, started one declared dev server and **produced nothing whatsoever** yields
`capability: PROVEN`. If the distributed journey also corroborates — which is exactly what E7-1's
harness is built to make happen — the verifier prints a fully green `ok: PASS / capability: PROVEN`
for a run with zero agent output.

★ **A weaker form needs no dial at all.** `verify` only early-returns on a run that does not exist
(`e7-distributed-run-verifier.ts:341-352`); capability is computed for every run that does. So
pointing the verifier at ANY ordinary heartbeat run that freshly started a runtime service already
prints `capability: PROVEN` today. That form is much less dangerous — clause 1 refuses a
non-distributed run, so the RESULT line reads `ok: FAIL / capability: PROVEN` and cannot be quoted as
a green campaign — but it means the capability counter is meaningless *on its own* right now, not
only after the dial is armed.

**Reproduction (three greps, no database):**

```
grep -n "ensureRuntimeServicesForRun({\|CLI-006-SUPPRESSION-RETURN" server/src/services/heartbeat.ts
#   4524   <- the write path
#   5451   <- the suppression return.  4524 < 5451, same function (executeRun, :3061)
grep -n "startedByRunId: input.runId" server/src/services/workspace-runtime.ts           # -> 2649
grep -n "createdByRunId: row.startedByRunId" server/src/services/task-output-emitters.ts # -> 113
```

**Why NEW rather than an extension of E7-F015 — the two are not the same defect.** They share a root
(arm 2 has no provenance filter) and a consequence, and they must be cross-linked; they are filed
apart because a fix for one can leave the other wide open:

| | **E7-F015** | **E7-F020** (this) |
|---|---|---|
| who acts | an authenticated board caller, deliberately | **nobody** |
| the path | `POST /api/issues/:issueId/outputs` (`routes/task-outputs.ts:45-53`) | `heartbeat.ts:4524` → `emitRuntimeServiceTaskOutput` |
| the run id | supplied in the request body | derived internally from `run.id` |
| trace left | an HTTP request, a board-provenance row a reviewer can question | none — indistinguishable from ordinary operation |
| triggered by | an intent to make the bar go green | the DEFAULT workspace configuration |

★★★ **The decisive reason they must not be merged: an authorization-shaped fix closes E7-F015 and
does nothing here.** Hardening the route — tightening `upsertTaskOutputSchema`, refusing a
caller-supplied `createdByRunId`, adding an authz check — is the natural remedy for a forgeable
endpoint, it would legitimately close E7-F015, and arm 2 would still read `PROVEN` off a dev server
the platform started by itself. Folded into one finding, that fix would look complete. Kept apart,
E7-F020 states the residual explicitly: **any fix must make arm 2 count only rows whose provenance is
a distributed agent's output**, not merely exclude untrusted callers.

Note also that E7-F015's register entry records that its originally recommended fix — drop the
task-output arm and widen the artifact arm off `kind='workspace_patch'` — is **REFUTED** (input
staging already commits `job_artifacts` rows on the same job id). This finding raises the bar on any
replacement: the surviving arm has to distinguish *produced by the agent* from *emitted by the
platform on the agent's behalf*, and nothing in the current schema does.

★★ **Re-examined 2026-09-06 (W4U3-R4) against a corrected writer census, and NOT merged.** The census
that fact (4) of E7-F018 now carries was re-derived on the sole `task_outputs` INSERT
(`services/task-outputs.ts:181`) rather than on a grep for the field name, and it says that **two**
legacy writers can fire for a handed-off run, not one. That is not new information for this finding —
this finding's own comparison table above already named the other one, and already cited it correctly
as `routes/task-outputs.ts:45-53` while the shared census was still citing `output-detection.ts:201`
under E7-F015's label. Three consequences, recorded so the next reader does not have to re-derive them:

- **Nothing in the statement above changes.** "no agent output, no forgery and no authenticated
  caller" describes THIS path, and a second path existing elsewhere neither weakens nor strengthens it.
- **The two findings still must not be folded together**, for the reason already argued: an
  authorization-shaped fix closes E7-F015 and leaves this untouched. The corrected census makes that
  argument checkable rather than rhetorical — the two live writers are exactly these two findings'
  subjects, one per finding.
- ★ **The census now has a closure property worth keeping.** Of the four legacy writers that can put a
  `heartbeat_runs` id in the column, the two that can fire are E7-F015 (row 4) and E7-F020 (row 3);
  the two that cannot are rows 1-2. **There is no live writer without a finding, and no finding
  without a live writer.** If a future round finds a fifth caller of `upsertTaskOutputForIssue` that
  can carry a run id, that property is the thing it breaks, and it should be re-stated rather than
  quietly widened.

★ One reachability detail this finding did not have when it was filed: `emitRuntimeServiceTaskOutput`
is reached not only from `heartbeat.ts:4524` but also from `task-output-backfill.ts:91`, which runs
from **GET** `/api/issues/:issueId/outputs` (`routes/task-outputs.ts:40`) whenever the issue has no
task outputs yet. So a plain read can also mint the row, from a `started_by_run_id` a previous run
already wrote. This does not change the fail-open configuration listed above (that path needs a
`workspace_runtime_services` row to already exist); it is recorded because it means the write is not
confined to `executeRun`.

**Severity — HIGH, and argued in both directions because the honest answer is not obvious.**

*The case for lower (this is why it is not CRITICAL, and why MEDIUM was seriously considered).*
`capabilityProven` gates NOTHING today: `--require-capability` is off by default
(`server/src/cli/verify-e7-1-distributed-run.ts:65`) and E7-F018 measured that the flag is referenced
by no workflow and no script. The strong form additionally needs the rollout dial armed, which nothing
checked in does (E7-F018 measurement 1) and which `scripts/lib/staging-manifest-invariants.mjs:516-541`
FORBIDS on every staging worker. So the blast radius **today** is zero, and E7-F015 — the same arm,
the same missing filter — is filed MEDIUM.

*The case for HIGH, which is why it is filed there.* (a) **Error direction.** E7-F015 needs an actor
doing something deliberate, so a reviewer looking at a green result has a question to ask — *did
someone POST this?* Here there is no actor and no question; the row is produced by the platform doing
its ordinary job, and nothing distinguishes it from a real one. A defect that removes the question is
worse than one that merely answers it wrongly. (b) **It fires on the DEFAULT configuration** of
exactly the runs the campaign will try first — isolated workspaces are instance-default on, and a
declared dev server is the normal shape of a software-engineering task. (c) **It fires before the
handoff**, so it is invariant to whether the distributed side works at all: the counter is non-zero
even when the distributed execution fails outright. (d) **The trigger is E7-F018's own owed step.**
The one action the programme says is owed next — arm the dial — is the action that opens this. A
document set written to stop a green canary being reported as capability must not contain the sentence
that makes that misreading safe, and until this round it did. (e) **E7-F015 already warns of exactly
this**: *"it must close BEFORE Unit F makes the bar flippable and an operator starts trusting it."*
This one is flippable **now**, without Unit F.

HIGH may never be `accepted`, and it is not being accepted: it is `owned` by **CLI-008**.

**Owner — CLI-008, on the same reasoning that put E7-F015 there.** This is a defect in the JUDGE, and
CLI-008 owns the judge: Unit A built `capabilityProven`, and Units C, E and F are unbuilt, so the
ticket is live and has no result doc. Unit F is the unit that would make this bar load-bearing, and
separating a judge defect from the only unit able to prove a future fix fired is how E7-F015's
predecessors went unnoticed. As with E7-F015, **the ticket carries the finding, not a designed fix** —
no replacement predicate is proposed here, because the two obvious candidates (filter by `type`,
filter by `provider`) are guesses that have not been measured against the corpus.

**What this finding does NOT claim.** It does not claim the row is wrong to exist — a runtime service
IS a legitimate task output and belongs in `task_outputs` with its run linkage; the defect is entirely
in the verifier reading that linkage as *proof of agent capability*. It does not propose changing
`emitRuntimeServiceTaskOutput`, and no code is changed by the round that filed it. And it does not
weaken E7-F018: the shared blocker holds, arm 1 is still unreachable, and a `workspace_patch` producer
is still necessary.

---

## E7-F021 — The distributed sandbox invocation carries NO permission posture, and the shipped product treats that flag as required for unattended runs

**Status:** **resolved** · **Resolved by:** the F021/F027 posture PR, 2026-09-11 (founder-authorized), which adds `--dangerously-skip-permissions` to BOTH claude literals in `buildSandboxInvocation` (`server/src/services/task-run-sandbox-invocation.ts`), immediately after `--print -`, on the bundle (`:183`→`:186`) and no-bundle (`:184`→`:187`) branches. The W12 differential named the absent flag as the cause (A1 exited 0 and wrote nothing at `permissionMode:"default"`; A2 wrote at `permissionMode:"bypassPermissions"`); the founder asked to see this diff before it landed and has now authorized it (2026-09-11). The security-review condition the finding held the remedy behind is discharged, and the remedy is exactly the one the finding named. Guarded RED-when-removed by `server/src/__tests__/task-run-batch-workload.test.ts` — both the exact-script assertion for the claude shape and a dedicated `skips permission prompts for unattended execution` case go red if the flag is dropped from either branch. The codex half of the same four literals is E7-F027 and stays OPEN (narrowed) — a posture-only fix would not have closed it, which is why the two were filed apart. **Owner (historical):** CLI-008 (`epics/E7-coding-e2b/tickets/CLI-008-unit-f-design.md`, no result doc)
**Severity:** HIGH
**Filed:** W6U1, 2026-09-06, by re-verification of the 26-agent output-decision wave against source at `31d33a3b0`.
**Cross-links:** E7-F003 (the run reaches the agent through argv only), E7-F018 (nothing in the distributed path runs today), E7-F027 (codex is blocked by something else entirely), E7-F028 (the probe's own codex verdict over-claims its cause).

### ★★★ MEASURED 2026-09-07 (W12) — the premise is CONFIRMED, and this is now a product defect rather than a missing measurement

**Run [`34087197668`](https://github.com/MeteoriteLabs/AoA/actions/runs/34087197668)** (2026-09-07,
commit `1c447fa8a`, template `aoa-base`, artefact `w7u1-output-probe-record`, run nonce
`W7U1-MTQT1763-OJ2WYK7K`, disposition `measured`, exit 0). Full record:
`tickets/W7U1-output-probe-result.md`. Probe A's `claude_local` verdict is
**`no / a1-did-not-write-and-the-posture-is-the-cause`**, from a four-arm single-variable
differential in one sandbox (`ij2e209cz8ijkzgrzxqeb`):

| arm | posture | exit | file | the CLI's own `permissionMode` |
|---|---|---|---|---|
| A0 harness control (plain shell) | — | `0` | **written** | — |
| A1 the exact `:184` literal | **absent** | **`0`** | **NOT written** | `"default"` |
| A2 the same prompt template, `--dangerously-skip-permissions` added inside the probe | added | `0` | **written** | `"bypassPermissions"` |
| A3 negative control, prompt forbids writing | added | `0` | **NOT written** | `"bypassPermissions"` |

**A sandboxed `claude` CAN write a file, and the absent flag is why the production argv does not.**
A0 proves the write+read path, A3 proves the file is attributable to the agent obeying the prompt
rather than to some other writer (E7-F020's class), and ★ the CLI's own `init` event reports
`permissionMode` `default` on A1 and `bypassPermissions` on A2 — the *binary's* confirmation that the
one varied thing took effect, independent of the probe's string rewrite. **A1 exited 0**: the
"silently no-op" shape (`resolve-crew-adapter.ts:150-151`) reproduced in the distributed argv, with
no MCP config involved at all.

★★★ **WHAT THE DIFFERENTIAL DOES NOT ESTABLISH — read before acting on it.**

1. **Nobody has run the PRODUCT with the posture added.** A2 rewrote the emitted script string
   **inside the probe** (`withPermissionPosture`, `scripts/lib/w7u1-agent-output-probe.mjs`);
   `task-run-sandbox-invocation.ts` is untouched and unchanged at this tip. Adding a permission flag
   to a shipped path is a **security-posture change** to the argv of an agent running with a redeemed
   Company provider key. ★ **This unit was tasked with recording rather than fixing, on the stated
   ground that the founder wants to see that diff before it lands** — a relayed instruction, marked
   as such rather than presented as a measured fact. What stands independently of it is this
   finding's own pre-existing position (at the end of this entry) that the change should not be made
   from inside the ticket. The measurement names the cause; it does not pre-approve the remedy, and
   the paragraph at the end of this finding ("the ticket carries the finding, not a fix")
   **still stands**.
2. **Only the NO-BUNDLE literals were exercised.** The pack passes `instructions: null`, so `:184`
   (claude) and `:204` (codex) ran and the **instructions-bundle** branches `:183` and `:203` did
   not. `:203` has a different failure surface — it pipes through `cat`, so its exit status is the
   pipeline's last command's.
3. **It says nothing about codex.** The codex arm returned `no` for two entirely different reasons
   (E7-F027), and its *stated* cause is unsupported (E7-F028). **A posture-only fix would close the
   claude half and leave codex broken while looking like a fix.**
4. **One template, one tier.** `aoa-base` on this account. Nothing about bare `base` (E7-F022) or the
   networked/container lane (E7-F011).

**What.** `buildSandboxInvocation` (`server/src/services/task-run-sandbox-invocation.ts:149-213`) emits
FOUR script literals — `:183`, `:184` (claude, bundle / no bundle) and `:203`, `:204` (codex, bundle /
no bundle). Measured at this tip, **none of the four carries any permission posture**: no
`--dangerously-skip-permissions`, no `--settings`, no `--allowedTools` on the claude branches, and no
`--dangerously-bypass-approvals-and-sandbox` on the codex ones. The literals are, in full:

```
:183  <guard>; exec "$0" --print - --output-format stream-json --verbose --append-system-prompt-file "$2" < "$1"
:184  <guard>; exec "$0" --print - --output-format stream-json --verbose < "$1"
:203  <guard>; { cat "$2"; echo; cat "$1"; } | "$0" exec --json -
:204  <guard>; exec "$0" exec --json - < "$1"
```

**Why that is a defect and not a deliberate hardening.** The SHIPPED product treats the flag as
REQUIRED for an unattended run, in three independent places:

- `packages/adapters/claude-local/src/server/execute.ts:735-748` builds the same
  `--print - --output-format stream-json --verbose` argv and then pushes EITHER `--settings`
  (the PreToolUse permission bridge) OR `--dangerously-skip-permissions`. The two are mutually
  exclusive by an explicit comment at `:740-742`. **Precisely measured, the construct is
  `if (hookSettingsFilePath) … else if (dangerouslySkipPermissions) …` with NO `else`** —
  `dangerouslySkipPermissions` is `asBoolean(config.dangerouslySkipPermissions, false)` (`:368`,
  defaults FALSE) and `hookSettingsFilePath` is non-null only when the caller explicitly opts in via
  `runtimeHookBridge?.enabled` (`:567`, `:571-591`) — so a `claude_local` agent whose config sets
  NEITHER gets NEITHER flag. What is always true is narrower: **crew-resolved** agents always carry a
  posture, because `resolve-crew-adapter.ts:53` sets `dangerouslySkipPermissions: true` on every
  claude crew row it mints and `:197` backfills legacy rows that lack it. It ALSO pushes
  `--allowedTools mcp__aoa` (`:756-758`) when a managed MCP config is present and skip-permissions is
  not, *"so a headless agent run would otherwise be denied every `mcp__aoa__*` call … with no human
  to grant it"*. The distributed literals choose NONE of the three.
  ★ **That fall-through is STRENGTHENING, not weakening.** The no-posture state is not a benign
  fourth option the adapter offers — it is exactly the state the crew backfill below exists to
  eliminate, met in production and remedied by rewriting founder rows on boot. The distributed
  literals put every run permanently into that state, with no resolver and no backfill above them.
- `server/src/services/internal-agent/cli-mode.ts:598` / `:601` are the Commander/crew equivalents
  (`claudeBypassArgs` / `codexBypassArgs`). These are likewise conditional, not unconditional —
  both are gated on `vendorCliBypassEnabled` (`:597-602`) and are `[]` when it is false. The point
  is the same as above: where the shipped product runs this argv shape unattended, a posture is
  resolved deliberately by a caller; the distributed literals have no such caller.
- ★★★ **A UAT-measured production defect is recorded for the flag's ABSENCE.**
  `server/src/services/internal-agent/aoa-agents/resolve-crew-adapter.ts:145-153` records backfill
  case 2 — claude_local crew agents missing `dangerouslySkipPermissions` — because the pre-fix
  resolver *"didn't set this flag, so claude crew runs silently no-op on every MCP tool call
  (permission gate hangs in `--print` mode)"* (`:150-151`). The remedy shipped was a **startup
  backfill** that upgrades existing rows, i.e. the programme judged the absence severe enough to
  rewrite founder data on boot.

**And there is no second channel that could supply it.** The frozen `batchWorkloadV1Schema`
(`packages/worker-protocol/src/job.ts:289-296`) is `.strict()` with exactly four fields —
`command`, `args`, `stdinArtifactId`, `maxRuntimeSeconds`. **There is no `env`.** So a permission
posture cannot ride the workload as an environment variable either; if it is not in these four script
literals it is not in the distributed invocation at all. (A settings FILE could in principle be
staged through CLI-008 Unit B's channel and named with `--settings`, but that is a mechanism nobody
has proposed and it would still need an argv change here.)

**WHAT THIS FINDING DID NOT CLAIM WHEN FILED — ★ SUPERSEDED 2026-09-07 (W12), kept because the
supersession is the point.** As filed, this paragraph read: *"It does **not** claim that a sandboxed
claude/codex provably cannot write a file. That has never been measured, on any lane, and the absence
of the measurement is the point."* **The measurement now exists** (the block above), and for
`claude_local` it lands on the second of the three outcomes the probe design predicted: the run exits
0 and the file does not exist. The hedge is therefore withdrawn **for claude only**. Two things in
the original paragraph still hold and are not withdrawn: the recorded UAT defect is about **MCP**
tool calls while the distributed invocation carries no MCP config at all (Unit C is unbuilt), so the
recorded symptom and the measured symptom coincide in *shape* (exit 0, no work) rather than in
mechanism; and the narrower structural claim — the shipped product never runs this argv shape
unattended without a permission decision attached, and the distributed path does — was true when
filed and is true now.

**WHY IT MATTERS BEYOND UNIT F.** It is the load-bearing premise under three of the four candidate
answers to *"what is an agent output?"* — every option that assumes the agent writes a file
(a declared path, a conventional path, a workspace patch) assumes a capability nobody has
established the sandboxed agent has. A mechanism designed on top of an unmeasured premise is the
shape all three of Unit F's refuted rounds already took (`CLI-008-unit-f-design.md` §4.4).
★ **AMENDED 2026-09-07 (W12): the premise is now measured, and it holds CONDITIONALLY.** A sandboxed
claude writes **when the posture is present**. So the three file-writing options are not dead — but
they are gated on a **product fix that has not been made**, not on a measurement that has not been
taken. `CLI-008-unit-f-design.md` §12.3 records the replacement stop condition; the difference
matters because "unmeasured" and "measured, and blocked on a diff nobody has approved" license
different next steps.

**Severity — HIGH, argued both ways, and RE-ARGUED after the measurement.**

*As filed.* **For lower:** nothing in the distributed path runs in any checked-in configuration
(E7-F018), so the blast radius TODAY is zero, and the defect might turn out to be a non-defect — a
sandboxed `--print` run might tolerate built-in tool use without the flag, which is exactly probe
(a). **For HIGH:** (a) it is not a defect whose cost is bounded by a wrong answer — it is a MISSING
MEASUREMENT under the entire remaining option space of the epic's last open question, and every hour
spent designing above it is spent on sand; (b) the error direction is silent — the recorded symptom
for this class is a run that *"silently no-op[s]"*, i.e. a green terminal with exit code 0 and no
work, which is precisely the false-PASS shape clause 6 exists to exclude; (c) the omission is
invisible at every review surface — the four literals read as complete, and the divergence from the
shipped adapters is only visible by opening a different package.

★ **DOES THE MEASUREMENT RAISE IT? Argued explicitly, and the answer is NO — it REPLACES the ground
for HIGH rather than adding to it.** What changed in each direction:

- **The strongest argument for LOWER is now REFUTED.** *"The defect might turn out to be a
  non-defect"* was a live possibility on 2026-09-06 and is dead on 2026-09-07: A1 exited 0 and wrote
  nothing while A2 wrote. There is no reading of this run on which the missing flag is benign for
  `claude_local`.
- **The strongest argument for HIGH is now SPENT.** Reason (a) was *"a MISSING MEASUREMENT under the
  entire option space"*. The measurement is taken, so that reason no longer applies — and a finding
  does not keep a severity on the strength of a reason that has been discharged. It is replaced by a
  narrower and firmer one: this is a **confirmed silent-no-op** on the only lane the epic is being
  built for, and reasons (b) and (c) — silent error direction, invisible at every review surface —
  are unchanged and now demonstrated rather than predicted.
- **Why NOT CRITICAL.** Blast radius today is still zero: E7-F018's shared blocker holds, nothing in
  the distributed path runs in any checked-in configuration, and `AOA_DISTRIBUTED_EXECUTION_ENABLED`
  is default-off. Nothing was made worse by measuring it. A severity is a statement about the risk a
  reader must weigh, and no reader is exposed today.
- **Why NOT MEDIUM either, which is the tempting move once "it's only default-off code" is said out
  loud.** The remedy is now known, small, and *blocked on a security review* rather than on more
  work — precisely the state in which a defect quietly ages out. HIGH is what keeps it on the
  unowned/owned board until the diff is seen.

**HIGH stands.** ★ It is NOT lowered on the strength of the measurement, and the measurement is not a
partial resolution: nothing in `task-run-sandbox-invocation.ts` changed, so every consequence this
finding describes is still live in the tree.

**Owner — CLI-008**, which has no result doc and whose Units C, E and F are unbuilt. The literals are
Unit D's module and the consequence is Unit F's premise; splitting them would separate the argv from
the only unit that can prove a posture change had any effect. ★ **The ticket carries the finding, not
a fix.** Adding `--dangerously-skip-permissions` to the two claude literals is the obvious remedy and
it is NOT recommended here: it is a security posture change to the argv of an agent running with a
redeemed Company provider key, and it should be made *after* probe (a) says what the real behaviour
is, not before.
★ **AMENDED 2026-09-07 (W12): probe (a) has said, and the recommendation is UNCHANGED.** The
condition in the sentence above is satisfied — the differential names the flag as the cause — and
that discharges the *"we do not know yet"* objection, not the *"this is a security posture change"*
one. W12 was tasked as a recording unit on the stated ground that the founder wants to see this diff
first — a relayed instruction, not a measurement — and it behaved as one: **the four script literals
are untouched at this tip.** Two things the remedy must additionally account for,
which did not exist when this paragraph was written: it closes **only** the claude half (**E7-F027**
— codex is refused by a different gate, and a posture-only change would leave it broken while
carrying a green measurement beside it), and the run's own codex verdict overstates what it knows
(**E7-F028**).

---

## E7-F022 — The E2B template is an unpinned operator input under three uncoordinated variable names, invisible to every protocol surface, and the evidence lanes silently default to a template with no CLIs

**Status:** open · **Owner:** unowned (see reason)
**Severity:** MEDIUM
**Filed:** W6U1, 2026-09-06. **Corrected DOWN from the HIGH stated in the tasking brief** — see
severity below — and corrected UP in SCOPE: the brief named one variable; there are three.
**Cross-links:** E7-F020 (evidence produced by something other than the agent), E7-F018 (the operator
preconditions that sit outside a code PR).

**What.** The sandbox template that determines what exists inside an agent's sandbox is named by an
environment variable, is built by an operator from a repo Dockerfile with **nothing verifying that the
registered template matches that Dockerfile**, and reaches **zero** files in either frozen-adjacent
worker package.

**Measured, four ways.**

1. **It is REQUIRED for the distributed worker and has no default.**
   `packages/worker-keystore/src/bin/sandbox-provider.ts:34` declares
   `TEMPLATE_ENV = "AOA_WORKER_E2B_TEMPLATE"`; `:88-93` refuses to boot without it
   (`` `${PROVIDER_ENV}=e2b requires ${TEMPLATE_ENV} to name a sandbox template` ``), and `:99`
   passes it as `templateId` to `E2bSandboxProvider`.
2. ★★★ **It is THREE variables, not one, and they do not agree.** Measured repo-wide:

   | variable | consumer | behaviour when unset |
   |---|---|---|
   | `AOA_WORKER_E2B_TEMPLATE` | the distributed worker's provider resolver (`sandbox-provider.ts:34`) | **refuses to boot** (fail-closed) |
   | `AOA_ADAPTER_MANAGER_E2B_TEMPLATE` | `packages/adapter-manager/src/bin/adapter-manager.ts:55`; fed from `AOA_STAGING_E2B_TEMPLATE` at `docker-compose.staging.yml:340` | — |
   | `E2B_TEMPLATE` | every keyed real-E2B test lane and probe (`keyed-real-e2b.test.ts:33`, `keyed-cli-008-unit-d-invocation.test.ts:61`, `keyed-dat-009-artifact-export.test.ts:55`, `probe-e2b-egress-constraint.mjs:48`, `probe-e2b-port-exposure.mjs:28`), `docker-compose.yml:74`, and ★ **the shipping product** (`server/src/services/platform-default-environment.ts:63`) | **silently defaults to the bare `base` template** |

   So **the lane that produces real-E2B evidence and the lane that would run a distributed agent read
   different variables with opposite defaults.** A green keyed run does not pin the production
   template, and nothing anywhere asserts the two name the same image.
3. ★★ **The evidence lane's default is a template with no agent CLIs.** `e2b/e2b.Dockerfile:1-7`
   states that the E2B `base` template is bare, that `claude` and `codex` are absent from it, and
   that a run fails with `env: 'claude': No such file or directory`; the custom `aoa-base` template
   exists to fix exactly that. Yet `keyed-e2b-conformance.yml:78` sets
   `E2B_TEMPLATE: ${{ inputs.e2b_template }}`, and its own comment at `:24` says a **push**-triggered
   run *"carries no `inputs`, so `E2B_TEMPLATE` resolves to `""` → the bare `base` template"*. The
   last recorded push trigger (`.github/keyed-e2b-trigger`, entry #4, 2026-08-26) says exactly that:
   *"Bare `base` template (coreutils only)."*
4. **It is invisible to the protocol, DELIBERATELY.** `templateId` appears in **zero** files under
   `packages/worker-daemon/src` and **zero** under `packages/worker-protocol/src` (verified by
   `grep -rn templateId` on each: 0 and 0). That is not an oversight — `capabilities.ts:36` states
   *"provider-native regions/templates never enter the wire"*, `:44-46` that
   *"Provider identity/region/template/credentials are NOT capabilities … they live in the
   control-plane registry, never in this enum or on the wire"*, and `:104-105` that the platform
   `runtime` label is *"never a provider region or template ID"*.

**The consequence for the output question.** A location-based output convention — *"the agent writes
to `/aoa/out/…` and we count what is there"* — can be satisfied **by the template itself**, because
the template is an operator-authored filesystem that no protocol surface can see and no gate
inspects. That is E7-F020's class (evidence produced by something other than the agent), with an
input that is structurally unauditable rather than merely unfiltered. Because the invisibility is a
locked design property, the remedy cannot be "put the template on the wire".

**Severity — MEDIUM, and the correction is deliberate.** The tasking brief called this HIGH.
*Against HIGH:* the production side fails **CLOSED** — no template, no boot — which is the opposite
of the fail-open shape that earns HIGH in this register (cf. E7-F020, which needs nobody to do
anything). No location-based output convention exists, so the E7-F020-class consequence is
CONDITIONAL on a mechanism that Unit F has been refuted three times for proposing. And nothing in the
distributed path runs at all (E7-F018). *For MEDIUM rather than LOW:* the evidence-lane half IS
fail-open today — a keyed run against bare `base` can be reported green while the CLIs were never
present, which is the same class as E7-F025 below — and the three-name divergence means a proof on one
lane is quoted for another. ★ **Re-derive this to HIGH the moment any candidate output mechanism
becomes location-based**; the conditional is the only thing holding it down.

**Owner — unowned, with a reason.** The template is an OPERATOR/DEPLOYMENT artefact, not a code unit:
the fix is either a boot-time or lane-time assertion that the registered template contains what the
Dockerfile promises, or a decision to collapse the three variable names — and no ticket on disk owns
either. Naming CLI-008 would be a false ownership claim in E7-F018's exact sense: that ticket could
ship in full and this would not move. Recorded as unowned so the next Track A attempt reads it before
quoting a keyed-lane result.

---

### PARTLY ADDRESSED — W16B, 2026-09-07. ONE lane now asserts the image, not just the name

★ **THE STATUS STAYS `open`.** One of the two remedies this finding names is now built, for exactly
one lane. The finding is broader than that lane, and closing it here would be a false claim.

**Built.** The W7U1 output-probe lane — the only keyed lane that spends **model tokens** — now runs a
**probe T** before anything else: one cheap sandbox from the **resolved** template, running
`command -v claude` / `command -v codex`, which is the same assertion `e2b/e2b.Dockerfile`'s final
layer makes at build time (`RUN command -v claude && command -v codex && …`). Its verdict is
**recorded beside probe A's**, and the lane reds with a message naming the template and the missing
binary. This is literally the *"lane-time assertion that the registered template contains what the
Dockerfile promises"* the paragraph above asked for.

★★ **IT IS A CAVEAT, NOT A GATE, AND THAT WAS A CORRECTION MADE THE SAME DAY.** Probe T shipped
blocking probe A. That was wrong on three counts, recorded here because they generalise: probe A
`npm install -g`s its own agent CLI unconditionally and already fails its own way when that cannot
work (`template-has-no-node-runtime` / `cli-install-failed` / `cli-binary-not-on-path`), so the CLIs
being pre-baked is a property of the image and not a precondition of probe A's validity — run
`34087197668` shows both lanes installing their own (`install: "INSTALL_PLAIN"`); the gate had never
passed anywhere, so its first execution would have been on the founder's next authorised run, turning
an unknown into a *guaranteed* zero-information outcome; and fail-closed is for answers that would be
unsupported, not for answers that are supported but want a footnote. Probe A now always runs and
carries a `CAVEAT:` naming probe T's state; an `inconclusive` probe T still reds the lane on its own
account. `scripts/lib/w7u1-agent-output-probe.mjs`
(`evaluateTemplateCliPreflight`), pinned in the required `policy` job.

★★ **A NAME IS NOT A FILESYSTEM, and that gap is what this closes for one lane.**
`resolveTemplate` already corrected an *omitted* input to `aoa-base` — but an operator may name any
alias explicitly (honoured verbatim, deliberately), and an account may hold a stale or half-built
`aoa-base`. The pack would then `npm install -g` its own CLI over the top and answer as though the
image had been the one the Dockerfile describes. ★★★ **The preflight is fail-closed on silence:** a
binary the check said *nothing* about is `template-preflight-unreadable`, never "present". Inferring
presence from the absence of a failure line is this programme's [[checks-that-nothing-runs]] class,
and the guard would have had it.

**NOT addressed, and still the bulk of the finding:**

* **the sibling lanes, re-measured at this tip rather than quoted.** Eight workflow files set
  `E2B_TEMPLATE: ${{ inputs.e2b_template }}` — `keyed-e2b-cdp-probe.yml:66`,
  `keyed-e2b-conformance.yml:78`, `keyed-e2b-dat-009-export.yml:101`,
  `keyed-e2b-egress-constraint-probe.yml:95`, `keyed-e2b-unit-d.yml:101`,
  `keyed-e2b-w10b-egress-enforcement-probe.yml:174`, `keyed-e2b-w7u1-output-probe.yml:152`, and
  `deploy-testing.yml:117`. **Only the last two of the keyed ones correct an omission**, via
  `resolveTemplate`. The other five consumers still hard-default to bare `base` at the JS line —
  `keyed-real-e2b.test.ts:33`, `keyed-cli-008-unit-d-invocation.test.ts:61`,
  `keyed-dat-009-artifact-export.test.ts:55`,
  `packages/sandbox-e2b-provider/scripts/probe-e2b-port-exposure.mjs:28` and
  `.../probe-e2b-egress-constraint.mjs:48` — the five this finding listed when it was filed,
  unchanged;
* ★★★ **A SIXTH CONSUMER, AND IT IS THE SHIPPING PRODUCT — measured W16B, 2026-09-07, and
  NOT in this finding's original list.** The five above are evidence lanes, and this finding has always
  been framed as *"the evidence lanes silently default to a template with no CLIs"*. That framing is
  incomplete. `server/src/services/platform-default-environment.ts:63` builds the `cloud_auth`
  platform-default environment with `template: read(env, "E2B_TEMPLATE") ?? "base"` — the same
  fail-open default, in product code on the run path, not in a test lane.
  **Measured, four ways:**
  1. `read` (`:15-18`) returns `null` for an absent OR empty-after-trim value, so `?? "base"` fires on
     both — and `docker-compose.yml:74` emits `E2B_TEMPLATE: ${E2B_TEMPLATE:-}`, i.e. exactly the
     empty string, whenever the operator has not set it.
  2. It is gated only on `deploymentMode === "cloud_auth"` (`:44`) and a present `E2B_API_KEY` (`:47`)
     — the posture the deployed testing stack runs in. No other precondition.
  3. It is REACHABLE, not dead: `ensurePlatformDefaultEnvironmentRow` is imported by
     `server/src/services/environment-run-orchestrator.ts:13`, and `one-shot-sandbox-cli.ts:379`
     names the same environment as the one whose config it inherits.
  4. The fallback is UNTESTED — `server/src/__tests__/platform-default-environment.test.ts` supplies
     `E2B_TEMPLATE: "aoa-base"` explicitly (`:16`, asserted `:21`) and never exercises the omitted
     case, which is why the default reads as an oversight rather than a decision.
  **Consequence:** on a `cloud_auth` instance with a key and no `E2B_TEMPLATE`, every agent run
  launches into bare `base` — the image `e2b/e2b.Dockerfile:1-7` says has no `claude` and no `codex`
  and fails with `env: 'claude': No such file or directory`. W16B's probe T records this for the W7U1
  lane only; it does NOT reach the product, which is a boot-side assertion this finding already asks
  for in the bullet below and still nobody has built. **This bullet is a scope correction, not a fix.**
  ★ How it was missed: a single-line grep for `E2B_TEMPLATE.*\|\| *"base"` finds only the two
  `.mjs` probes and this product line; the three keyed tests spell the same default as a ternary
  (`process.env.E2B_TEMPLATE && ... .length > 0 ? ... : "base"`), so neither spelling's grep finds the
  other's sites. Both spellings must be searched;
* the **three uncoordinated variable names** still disagree — `AOA_WORKER_E2B_TEMPLATE` (fail-closed),
  `AOA_ADAPTER_MANAGER_E2B_TEMPLATE`, `E2B_TEMPLATE` (fail-open) — so a proof on one lane is still
  quoted for another;
* nothing verifies that the registered template matches the Dockerfile at the **production/boot**
  side, which is the half that matters once anything distributed actually runs;
* ★ the re-derive-to-HIGH trigger above is untouched: the moment a candidate output mechanism becomes
  location-based, this goes to HIGH regardless of the W7U1 preflight.

---

## E7-F023 — Clause 4 DOES scan `job_events`, so a hard-fail gate clause reads model-influenced content; two reviewers contradicted each other and both were half right

**Status:** open · **Owner:** CLI-008 (`epics/E7-coding-e2b/tickets/CLI-008-unit-f-design.md`, no result doc)
**Severity:** MEDIUM
**Filed:** W6U1, 2026-09-06, to settle a direct contradiction between two reviewers in the 26-agent wave.
**Cross-links:** E7-F016 (clause 6's text misdescribes its subject), E7-F024 (the `log` payload).

**The contradiction, and the measurement that settles it.** One reviewer asserted that clause 4 scans
`job_events`; another asserted it does not, citing `listRunSecretScanSurfaces`
(`server/src/services/e7-distributed-run-verifier-store.ts:133-195`) building exactly THREE surfaces.
**Both statements are individually true and the second is not a rebuttal of the first**, because the
scanned set is COMPOSED at the call site rather than owned by that function:

```
e7-distributed-run-verifier.ts:463-467
  const scanSurfaces = await store.listRunSecretScanSurfaces(run);
  const allSurfaces: E7ScanSurface[] = [
    ...events.map((e) => ({ surface: "job_events", fieldOrEventId: e.eventId, text: safeStringify(e.payload) })),
    ...scanSurfaces,
  ];
```

So the scanned set is **FOUR** surfaces: `job_events` (the whole raw event `payload` jsonb,
JSON-stringified) plus `heartbeat_runs` text fields (`:139-158`), `task_outputs` summary+metadata
(`:161-169`) and `job_artifacts` identifier+objectKey (`:172-183`). The verifier's own type comment
already says so — `e7-distributed-run-verifier.ts:103`: *"The raw PRT-004 event jsonb — scanned by
clause 4 (never a dedicated key)."* `events` is `store.listJobEvents(attemptId)` fetched at `:401`
and is empty unless both distributed ids are present (`:396`), which is why a reader looking only at
the store function sees three.

**The consequence, which is the reason to file rather than just correct the record.** Clause 4 is a
**hard-fail** clause: any `hardHits` match pushes a `clause: 4` failure (`:468-474`) and the run's
`ok` verdict goes red. Its matchers (`:249-265`) are five regexes, and one of them —
`{ matchedClass: "e2b_api_key_assignment", re: /E2B_API_KEY\s*[=:]/g }` (`:258`) — fires on the bare
LITERAL `E2B_API_KEY=`, with no key value required. `connection_string` (`:261-264`) fires on any
`postgres://…` substring; `private_key` (`:266`) on the literal `-----BEGIN … PRIVATE KEY-----`.

★★★ **So routing agent stdout into `job_events` makes an attacker- and model-influenced string a
hard gate failure.** An agent that prints a `psql` connection example, echoes a `.env.example` line,
or pastes a PEM header into its transcript reds a clause whose name is *"no leaked secret"* — and the
failure text names a leak class, so the operator's first reading is a security incident, not a
false positive. This is a direct constraint on the "derive provenance from the transcript" option
family: any mechanism that puts model output into `job_events` inherits it.

**Not reachable today, and that is why it is MEDIUM and not HIGH.** Nothing emits a `log` event in
production: `SupervisorDeps.observeRun` is the only producer (`supervisor.ts:774-783`) and it is
uncomposed (E7-F016 §(a) records the same zero). And with no distributed run at all (E7-F018), the
`events` array is empty by `:396`'s `bothIds` guard. MEDIUM rather than LOW because it becomes live
on the SAME action that makes clause 6 meaningful — composing a stdout producer — so the two would
land together and the false hard-fail would be discovered by an operator rather than by a designer.

★ **A secondary observation, recorded but NOT the finding.** The `job_events` arm scans the
UNFILTERED `events` array, whereas clause 5 evaluates `tenantEvents = events.filter(e => e.companyId
=== run.companyId)` (`:412`). The two arms of the same function therefore disagree about tenancy. It
is very likely harmless — `listJobEvents` is keyed on a globally-unique attempt id — and it is
recorded here rather than filed separately because it is one line of the same code and a fix for
either should look at both.

**Owner — CLI-008.** This is a defect in the JUDGE, which CLI-008 owns (E7-F015, E7-F016, E7-F020 are
all there for the same reason), and it is a hard constraint on Unit F's remaining option space rather
than a standalone repair. ★ **No fix is proposed.** Narrowing the matchers, excluding `job_events`
from the hard arm, or moving it to the advisory `heuristicHits` set are three non-equivalent
remedies with different security postures, and choosing is the ticket work.

---

## E7-F024 — The frozen `log` payload SILENTLY TRUNCATES at 65,536 characters and caps at 480 events, so a reconstructed transcript is corrupt rather than absent

**Status:** open · **Owner:** CLI-008 (`epics/E7-coding-e2b/tickets/CLI-008-unit-f-design.md`, no result doc)
**Severity:** MEDIUM
**Filed:** W6U1, 2026-09-06. **The tasking brief's framing is CORRECTED**: the schema does not reject
an over-long frame, the emitter truncates it first.
**Cross-links:** E7-F023 (the same events are a hard-fail scan surface), E7-F016 (a transcript is
non-empty even when the model never spoke).

**What the brief said, and what is actually there.** The brief stated that
`logPayloadV1Schema` being `.strict()` with `message: z.string().max(65_536)`
(`packages/worker-protocol/src/events.ts:59-65`) means the payload **cannot carry** a `stream-json`
frame that exceeds it. The schema is exactly as stated. But the emitter never lets an over-long
message reach it:

```
packages/worker-daemon/src/supervisor/events.ts:159-165
  /** … The message is TRUNCATED to the frozen 65536-char ceiling so an
   * over-long chunk can never fail the parse; … */
  log(input) {
    const message = truncateUtf16Safe(input.message, 65_536);
    return this.#emit("log", { stream: input.stream, level: input.level, message });
  }
```

`truncateUtf16Safe` (`:82-87`) slices and drops a trailing lone high surrogate. **It adds no marker,
sets no flag, and emits no signal that truncation occurred.** So the failure mode is not "the frame
is refused" — it is "the frame is silently cut", and a cut JSONL frame is **unparseable JSON that
reads as a delivered event**.

**Three additional bounds on the same path, all measured:**

- **`MAX_LOG_EVENTS = 480`** (`supervisor.ts:82`), applied as `.slice(0, MAX_LOG_EVENTS)` at `:777`.
  Logs past the 480th are dropped, also silently.
- The ceiling is **65,536 UTF-16 code units, not bytes.** The file defines a byte-accurate helper —
  `boundedUtf8(maxBytes)` (`events.ts:43-50`) — and the `log` payload does **not** use it, while
  other fields do. So a multi-byte transcript is bounded lower in bytes than the number suggests.
- The whole producer block is **best-effort by construction**: `supervisor.ts:774-786` wraps
  `observeRun` and all three emitters in one `try` whose `catch` logs and swallows
  (*"Instrumentation must NEVER fail the run"*).

**Why this kills the "derive provenance from the transcript" family, and kills it harder than a
refusal would.** A refusal is loud: a mechanism whose events bounce is a mechanism you notice on the
first run. Silent truncation plus a silent 480-event cap means a transcript-derived provenance claim
would be computed over data that is *sometimes* complete, with nothing in the record saying which
runs those were. Combined with E7-F016 part (b) — a protocol transcript is non-empty even when the
model never spoke — a transcript-derived counter can be simultaneously **non-empty and corrupt**,
which is the worst of the two available failure directions for a capability bar.

**Severity — MEDIUM.** *For lower:* nothing emits a `log` event today (`observeRun` uncomposed), so
no data is being lost right now, and the truncation is a deliberate, commented choice that correctly
protects the run's terminal from an instrumentation parse failure — the alternative (drop the event,
and with it the run's trailing `usage` evidence, per the `truncateUtf16Safe` doc comment) is worse.
*For MEDIUM rather than LOW:* the loss is **silent on a frozen contract**, so the ceiling cannot be
raised by a later PR without a protocol change, and any future consumer inherits it without a signal.
A cheap, non-frozen mitigation exists and is deliberately NOT proposed as a fix here: recording that
truncation happened (a metric, a `system`-stream marker event) would make the loss visible without
touching `worker-protocol`. That is a design decision, not an obvious repair.

**Owner — CLI-008.** It bounds Unit F's option space and nothing else; it is not a live data-loss
defect for any shipped path.

---

## E7-F025 — No document in the repo records a GREEN real-E2B execution of the stream-capture case; the one recorded run FAILED it, and two later re-fires have no recorded outcome at all

**Status:** open · **Owner:** unowned (see reason)
**Severity:** MEDIUM
**Filed:** W6U1, 2026-09-06. **The tasking brief is CORRECTED**: it said the re-fire is "queued";
measured, at least two re-fires were pushed and their results were never written down, which is a
different and worse gap.
**Cross-links:** E7-F022 (the lane's template default), and this programme's own
"a check that nothing runs is not a check" class.

**The claim under test.** The 26-agent wave repeatedly asserted that the stream-capture primitive is
*"already live-proven against real E2B"*. Measured against the record:

1. **The only document recording a keyed-lane OUTCOME says the opposite.**
   `docs/replatform/epics/E7-coding-e2b/tickets/CLI-realE2B-hardening-result.md:3` —
   > **Status:** `driver fixes landed (no-key green) + keyed re-fire queued`. The FIRST real-E2B run
   > of the keyed lane (operator supplied `E2B_API_KEY`) executed 18 cases → **10 pass / 8 fail** …

   and its divergence table row 3 is the streaming case verbatim:

   | # | Case | Real-E2B symptom | Root cause | Fix | No-key cover |
   |---|---|---|---|---|---|
   | 3 | CLI-003 streaming | stdout `''` (expected `out-line`) | same argv collapse — the `printf` script never ran intact | (same `shellJoin`) | same |

2. **The fix was to a DIFFERENT component and is pinned only by a no-key unit test.** The root cause
   was argv collapse in `runCommand`, repaired by `shellJoin`; its regression cover is
   `real-transport-helpers.test.ts`, which the same doc's local-verification table records as
   *"7 passed"* with no key. So the stream handler itself has **zero** green real-E2B executions.
3. ★★★ **Two later re-fires WERE pushed, and nothing records what they returned.**
   `.github/keyed-e2b-trigger` carries entry #3 (2026-08-19) — *"real-E2B driver hardening — argv
   shell-quoting … Expect the 8 first-run failures resolved"* — and entry #4 (2026-08-26). Both are
   push-triggers on `docs/replatform-program` (`keyed-e2b-conformance.yml:26-30`), so the lane fired.
   **No result document in `docs/replatform` records the outcome of either.** `CLI-003-result.md:3`
   still reads *"complete (no-key core) + CI-GREEN + keyed-lane authored"* and says the real-E2B
   streaming case *"ride[s] the operator-dispatched `keyed-e2b-conformance.yml`"* — an authoring
   claim, not an outcome.

**So the honest state is not "queued" and not "proven": it is FIRED AND UNRECORDED.** The evidence may
well exist in CI logs; nothing brings it into the record, and the only written outcome is a failure.

**Why file it as a finding rather than just correcting a sentence.** A `-result.md` on disk is this
programme's own signal that a ticket shipped — `check-finding-ownership.mjs findCompletedTicketIds`
treats the suffix that way — and `CLI-realE2B-hardening-result.md` reads as a completion while its own
status line says the lane is unfinished. (It does **not** trip that guard: the id regex is
`^([A-Z]+-\d+).*-result\.md$` and `CLI-realE2B…` has no digits after `CLI-`, so it registers as no
ticket. That is luck, not design.) The practical consequence is direct: an option family gets sized
as "already proven" from a document whose own table records it failing.

**Severity — MEDIUM.** *For lower:* it is an evidence-surface defect that fails no gate; E7-F016, the
closest analogue, is LOW. *For MEDIUM:* unlike E7-F016 it is not a misleading string beside a verdict —
it is a **missing measurement presented as a completed one**, on the single primitive underneath one
of four candidate answers to the epic's last open question, and this programme has recorded the same
shape as its worst failure class. The remedy is genuinely cheap (re-dispatch the lane with a named
template and write down the result), which is another reason not to leave it implicit.

**Owner — unowned, with a reason.** What is owed is an OPERATOR ACTION — dispatch
`keyed-e2b-conformance.yml` with `e2b_template: aoa-base` and record the run id and the pass/fail
split — plus a one-paragraph amendment to `CLI-realE2B-hardening-result.md`. No code unit owns
either; naming CLI-008 or CLI-003 would be a false ownership claim, since both could ship in full and
this would not move. It is `unowned` on the record so that the next reader who wants to quote
"live-proven against real E2B" finds this first.

---

## E7-F026 — The 'agent declares its own output' option's "no test edits" claim is false against three existing pins, because its mechanism touches the staged PROMPT while its argument is about the WORKLOAD

**Status:** open · **Owner:** CLI-008 (`epics/E7-coding-e2b/tickets/CLI-008-unit-f-design.md`, no result doc)
**Severity:** LOW
**Filed:** W6U1, 2026-09-06, by re-verifying the 26-agent wave's fourth candidate answer against the
pin corpus.
**Cross-links:** `CLI-008-unit-f-design.md` §3.2 (the pin census enumerated BY SEARCH) and §4.2
(round 2 was refuted on exactly this claim, in the other direction).

**What.** One of the four candidate answers to *"what is an agent output?"* was *"the agent declares
it"* — append a directive to the agent's prompt telling it to announce the file it produced, and parse
the announcement. Its stated advantage was **completeness**: that it changes no existing test, because
it does not touch the workload.

**That is false, and the reason is a category slip.** The mechanism appends bytes to the STAGED PROMPT
FILE. The claim reasons about the WORKLOAD (`command`/`args`), which the mechanism indeed leaves
alone. But the staged prompt has its OWN pins, and three of them assert the staged bytes EXACTLY.
Verified individually in `server/src/__tests__/task-run-batch-workload.test.ts` at this tip:

| line | assertion | shape |
|---|---|---|
| `:180` | `expect(new TextDecoder().decode(staged!.bytes)).toBe(nasty)` | exact string equality on the staged prompt |
| `:415` | `expect(new TextDecoder().decode(staged!.bytes)).toBe(PROMPT)` | exact string equality (trimmed) |
| `:438` | `expect(staged!.bytes.byteLength).toBe(length)` | exact byteLength, inside `it.each` with **three** parameterized cases (`:429-433`) |

`:438`'s three cases are the E7-F008 anti-regression pins (`FROZEN_MAX_ARG_CHARS + 1`, `× 8`, `× 100`),
so appending any directive reds five assertions across three tests, not one.

**Why this is worth a register entry and not just a review note.** ★ It is the SAME slip that refuted
Unit F round 2, mirrored. Round 2 claimed *"measured against each pin, no test needs editing"* and was
false because it enumerated the wrong pin set (§4.2, §10). This option repeats the error with the
axes swapped — it reasons about the surface it does not touch and never enumerates the surface it
does. §4.4's standing instruction is exactly this census, and the option skipped it.

★★ **This finding is NOT an argument that the option is wrong.** Editing those three pins could be
entirely legitimate — §3.3 of the Unit F design already argues that "zero test edits" was never the
goal, and a pin asserting the staged bytes are byte-identical to the assembled markdown is precisely
the pin a prompt-appending mechanism SHOULD have to argue with. What is false is the **completeness
claim**, and a completeness claim is load-bearing when four options are being compared on cost.

**Severity — LOW.** It changes no shipped behaviour, fails no gate, and is bounded by the fact that no
mechanism is being built. It is filed because comparative sizing under time pressure is how the wrong
option gets chosen, and this option's stated cost was understated by exactly the measurement §4.4
already tells the next author to make first.

**Owner — CLI-008**, which owns the option space this belongs to. ★ The ticket carries the finding,
not a fix — there is nothing to fix until a mechanism is chosen, and choosing one before probe (a)
is what §12 now forbids.
★ **AMENDED 2026-09-07 (W12): probe (a) has returned and §12.3's stop condition is REPLACED, not
lifted into an open field.** The new gate is the **product fix** (the posture must be in
`task-run-sandbox-invocation.ts`, not in a probe) plus codex's blockers being characterised. **This
finding is untouched by the measurement**: §12.0.1 revives this option's *premise* and explicitly
does **not** revive its sizing claim — the three staged-prompt pins below still red, and the
completeness claim is still false.

---

## E7-F027 — The distributed codex invocation is refused by codex's own trusted-directory gate before any model call, and the frozen workload cannot supply the missing input at all

**Status:** open · **NARROWED 2026-09-11** (founder-authorized) · **Owner:** CLI-008 (`epics/E7-coding-e2b/tickets/CLI-008-unit-f-design.md`, no result doc)

> ★ **NARROWED — 2026-09-11, the F021/F027 posture PR (founder-authorized).** The **trusted-directory / argv-posture** half of this finding is now shipped: `buildSandboxInvocation` (`server/src/services/task-run-sandbox-invocation.ts`) adds BOTH `--skip-git-repo-check` and `--dangerously-bypass-approvals-and-sandbox` to the codex argv — options of the `exec` subcommand, placed after `exec --json` and before the `-` stdin positional (matching `codex-local/src/server/execute.ts:553-566`) — on the bundle (`:203`→`:203`, the `{ cat …; } | "$0" exec --json …` pipeline) and no-bundle (`:204`, the `exec "$0" exec --json …` shape) branches. That is the exact remedy the "What" section names: the argv is the only channel the frozen `.strict()` workload leaves, and the change lives in the same literals. Guarded RED-when-removed by `server/src/__tests__/task-run-batch-workload.test.ts` (the exact codex-shape assertions, a dedicated `bypasses approvals for unattended execution` case, and the anti-vacuity `stdinFromScript` control) — dropping either flag reds the suite.
>
> ★★★ **THIS FINDING IS NOT CLOSED, because it has a conjunct the source edit cannot discharge.** What stays open is the finding's own explicitly-unresolved remainder: **codex's write CAPABILITY under the production argv is UNMEASURED.** A2 in the W12 run carried `--dangerously-bypass-approvals-and-sandbox` (the same flag now shipped), cleared the trusted-directory gate (`thread.started`), and then hit **four `401 Unauthorized` reconnects** against `wss://api.openai.com/v1/responses`; the 900-char stdout cap truncated the record mid-token, so whether it ever wrote is not determinable. The two cheap arms in **WHAT WOULD IDENTIFY THE REMAINDER** are still owed, and the 401's own cause (the probe's `OPENAI_API_KEY` env delivery vs the product's redeemed execution-secret handle) is a separate measurement, deliberately not filed as a product defect. A source edit cannot answer "does codex write once past the gate" — only an authorized keyed run can — so the finding stays OPEN and its ownership key is retained. Close it when a keyed run shows codex reaching a model and producing output under the shipped argv.

**Owner (original filing):** CLI-008 (`epics/E7-coding-e2b/tickets/CLI-008-unit-f-design.md`, no result doc)
**Severity:** MEDIUM
**Filed:** W12, 2026-09-07, from workflow run
[`34087197668`](https://github.com/MeteoriteLabs/AoA/actions/runs/34087197668) at `1c447fa8a`,
template `aoa-base`, artefact `w7u1-output-probe-record`, run nonce `W7U1-MTQT1763-OJ2WYK7K`.
Full record: `tickets/W7U1-output-probe-result.md` §4.
**Cross-links:** E7-F021 (the claude half of the same four literals; a posture-only fix closes that
one and NOT this one), E7-F028 (the probe reported this arm's cause wrongly), E7-F008 (the frozen
workload's argument surface).

**What.** Probe A's `codex_local` arm ran the exact production `:204` literal
(`<guard>; exec "$0" exec --json - < "$1"`) in sandbox `i72skshv1vzdyk86rtigx`. It **exited 1 with
empty stdout**, and codex's own stderr says why, verbatim:

```
Not inside a trusted directory and --skip-git-repo-check was not specified.
```

The sandbox's working directory is `/home/user`, which is not a git repository. ★ **That directory is
not an assumption**: it is `STAGED_INPUT_DIR` itself (`task-run-sandbox-invocation.ts:56`), the same
directory the production invocation stages its prompt into, and the claude arm's own `init` event on
the sibling sandbox reports `"cwd":"/home/user"`. **A1 never reached a model.** The A0 harness control
on the same sandbox wrote and read back its file at exit 0, so this is codex refusing, not the
apparatus failing.

**Two facts make this a product finding and not a probe artefact.**

1. **The same refusal is what the production path would meet.** The literal is the shipped one, run
   unmodified; nothing in `buildSandboxInvocation`
   (`server/src/services/task-run-sandbox-invocation.ts:149-213`) sets a working directory, and it
   emits no `--skip-git-repo-check` on either codex branch (`:203`, `:204`).
2. ★★★ **The frozen workload cannot supply the missing input from anywhere else.**
   `batchWorkloadV1Schema` (`packages/worker-protocol/src/job.ts:289-296`) is `.strict()` with
   exactly four fields — `command`, `args`, `stdinArtifactId`, `maxRuntimeSeconds`. **There is no
   `cwd` and there is no `env`.** So a distributed codex run cannot be pointed at a trusted
   directory, cannot be given configuration through the environment, and cannot be told to skip the
   check by any channel except **the argv in these same four script literals**. This is the identical
   structural conclusion E7-F021 reached for the permission posture, arrived at independently and for
   a different flag.

**Why this is filed separately from E7-F021 rather than as a row in it.** ★★★ **Because the two
adapters have DIFFERENT blockers, and a single fix cannot close both.** E7-F021's remedy is a
permission posture; this one's is a directory/repo-check decision. A change that adds
`--dangerously-skip-permissions` to the two claude literals — the obvious reading of the W7U1 run —
would leave the codex path exactly as broken as it is today **while carrying a green measurement
beside it**, because the run that motivated the fix reports `no` for codex as well and a reader
skimming the verdict line sees two `no`s and infers one cause. Filing one finding for both is how
that happens.

**What is NOT established, and it is deliberately more than one thing.**

- **Whether codex can write in the sandbox at all is UNMEASURED.** A1 was refused at startup and A2
  (with `--dangerously-bypass-approvals-and-sandbox`) got past this gate — `{"type":"thread.started"}`
  — but then failed to authenticate: **FOUR** `Reconnecting… N/5` lines (numbered 2/5, 3/5, 4/5,
  5/5), all `401 Unauthorized`, the server reporting *"Missing bearer or basic authentication in
  header"* against `wss://api.openai.com/v1/responses`.
  ★ **A1 reached no model — that is established** (exit 1, empty stdout, a named refusal on stderr).
  **A2's is a statement about the RECORD:** no model-contact evidence is present in the stdout the
  run preserved — **exactly 900 characters**, which is the cap `safe(exec.stdout, 900)` **hit
  exactly**, and that is itself the proof of truncation (a stdout ending on its own would land on an
  arbitrary length, not precisely on the limit). So there **was** more, and what it said is
  **unknown**. That capture ends **mid-token** at `{"type":"i`
  while A3's parallel line shows the same position reads
  `{"type":"item.completed","item":{"id":"item_0`. So whether A2 emitted an `agent_message` after
  its reconnects is **not determinable from what was preserved**. Either way the capability question
  is open for codex.
- **The 401 is NOT filed here as a product defect, deliberately.** The pack delivers the key as a
  per-command env var (`envVars: { OPENAI_API_KEY: key }`) and the key was non-empty (an empty one
  short-circuits to `inconclusive / no-model-provider-key` before any sandbox is created, which did
  not happen). The **product** delivers a provider credential by a different route — a redeemed
  execution-secret handle — so the probe's delivery is not the product's delivery, and asserting a
  product defect from it would be exactly the inheritance this programme keeps filing findings about.
  What IS recorded: the observation, the exact error, and that `OPENAI_API_KEY` alone did not
  authenticate `codex exec` at `@openai/codex` as installed on 2026-09-07.
- **Only the no-bundle literal ran.** `:203` (the bundle branch) pipes through `cat`, so its exit
  status is the pipeline's last command's; it was not exercised.

**WHAT WOULD IDENTIFY THE REMAINDER**, named so this is a real disposition and not a shrug. Two cheap
arms on the next authorised keyed run, both inside the probe and neither touching the product:

1. **For blocker 1** — re-run A1 with `--skip-git-repo-check` added and nothing else. If it then
   reaches a model, blocker 1 is fully characterised and the argv change is specified. (A `git init`
   in the sandbox before the arm is the same experiment from the other side, and distinguishes
   "trusted directory" from "git repository", which the error message conflates.)
2. **For blocker 2** — print `codex --version` and a credential self-check inside the sandbox, and
   re-run A2 with the key ALSO delivered the way the product delivers one. That separates "codex does
   not read `OPENAI_API_KEY` for this endpoint" from "the key is not valid for the Responses
   websocket" from "the probe's env delivery does not reach the child". The 401 text — **missing**
   header, not rejected credential — points at the first, but that is a reading of an error string
   and not a measurement.

**Severity — MEDIUM, argued.** *For lower:* blast radius today is zero (E7-F018; nothing in the
distributed path runs in any checked-in configuration) and no operator can meet it. *For higher:* it
makes one of the two supported coding adapters non-functional on the distributed lane, and the
correction has to land in the same four literals a security review is already going to look at.
**MEDIUM rather than HIGH, and the reason is the error direction:** this failure is **LOUD** — exit 1
with a named cause on stderr — where E7-F021's is a **silent** exit 0. A loud failure is the strictly
better one to have; it cannot be mistaken for work. The finding is filed at MEDIUM for that asymmetry
and not because it is smaller in scope.

**Owner — CLI-008**, the same unit and the same module as E7-F021, because the fix is an edit to the
same four script literals and splitting them would let one land without the other. ★ **The ticket
carries the finding, not a fix.** No argv change is proposed here.

---

### NARROWED — W16B, 2026-09-07. What survives the classifier repair, and what does not

★★★ **This finding's own recorded conclusion partly rested on the defective classifier E7-F028
names, so it is re-derived here rather than left standing.** E7-F028 is now fixed; a finding whose
reachability came from a defect that has closed must be re-examined, not inherited.

**WHAT STANDS, unchanged — the whole of the "What" section above.** It never depended on the
classifier at all. It rests on three things the run captured directly:

1. codex's own stderr, verbatim: *"Not inside a trusted directory and `--skip-git-repo-check` was not
   specified."* — read off the arm, not inferred from a state name.
2. The production `:204` literal, run unmodified, with no `cwd` and no `--skip-git-repo-check`
   anywhere in `buildSandboxInvocation`.
3. `batchWorkloadV1Schema`'s `.strict()` four fields — no `cwd`, no `env` — so the argv is the only
   channel that could supply the missing input. A source fact, independent of any run.

**WHAT IS NARROWED.** The row that reported this arm as
`no / a1-did-not-write-and-the-posture-is-not-the-cause` was never supportable and the pack no longer
emits it here: replayed against the repaired classifier, codex A1 is
`indeterminate / cli-refused-at-startup` and probe A returns
`inconclusive / a1-cli-refused-at-startup`. So the honest statement of the codex result is:

> **Both arms exited 1, and the permission posture did not change the exit.** ★ **The CAUSE OF A1's
> REFUSAL IS NOT UNKNOWN — it is measured, and it is quoted above:** *"Not inside a trusted directory
> and `--skip-git-repo-check` was not specified."* What is unknown is **codex's CAPABILITY**, which is
> a different question. Blocker 1 (the trusted-directory gate) is measured and named; blocker 2 (the
> 401) is measured and named; and what the *apparatus* could not do at the time was tell a refusal
> from a null result, which is why the pack mis-stated the cause even though the run had captured it.
> **Neither arm was shown to reach the capability question** — A1 demonstrably did not, and A2 cannot
> be shown either way from the EXACTLY 900 characters of stdout the run preserved — so nothing is
> established about whether codex can write under the production argv.

★ **This narrowing does not shrink the finding's scope and must not be read as doing so.** The
trusted-directory refusal is still a product-shaped defect in the `:203`/`:204` literals, still
MEDIUM, still owned by CLI-008, and still unfixed. What is withdrawn is only the *pack's* over-claim
beside it — a claim this finding already flagged as unsupported. The two cheap arms named in
**WHAT WOULD IDENTIFY THE REMAINDER** above are unchanged and still owed.

★★ **The apparatus half of the remedy is now in place.** The next keyed run will report a codex
refusal as `cli-refused-at-startup` and will not exonerate anything from it, so the ambiguity that
produced this finding's mis-stated cause cannot recur silently.

---

### RE-VERIFIED AGAINST THE JOB LOG — W16B-FINAL, 2026-09-08

★★★ **The stderr above was re-read off run `34087197668`'s own job log this session, not carried
forward from the earlier write-up.** The line, verbatim and complete:

```
[w7u1/A/codex_local] A1 posture=false channel=returned exit=1 preExisted=false file=false
readErrorKind=not-found stdout="" stderr="Not inside a trusted directory and
--skip-git-repo-check was not specified.
"
```

(wrapped for width; it is one line in the log, and the trailing `
` is part of the captured stderr.)

`--skip-git-repo-check` appears **exactly once** in the whole log, in that stderr. So this finding's
headline is measured, not inferred, and **"the codex cause is unknown" is answerable and answered**:
codex refused at startup because the sandbox working directory is not a trusted git repository and
the flag that would skip that check was not passed.

**What that establishes, and what it does NOT — stated precisely because the two get merged.**

- ✅ **It explains the A1 REFUSAL.** Exit 1, empty stdout, a named cause, `/home/user` not a repo.
- ❌ **It does NOT establish what codex would do once past that gate.** A2 carried
  `--dangerously-bypass-approvals-and-sandbox`, cleared this gate, and then hit `401 Unauthorized` on
  four reconnect attempts (2/5 → 5/5) before any model contact was observable. Codex's ability to
  write under the production argv remains **UNMEASURED**, exactly as the section above says.

★★★ **THE CONSEQUENCE FOR E7-F021 (the posture fix), and it is the operative one.** The
trusted-directory refusal is a **distinct missing-argv class from the permission posture**, sitting on
**the same four script literals** (`task-run-sandbox-invocation.ts:183/184/203/204`) and reachable
through the same single channel, because `batchWorkloadV1Schema` is `.strict()` with no `cwd` and no
`env`. Therefore:

> **A posture-only diff fixes claude and does not fix codex.** Adding a permission flag alone leaves
> the codex branches refusing at the trusted-directory gate, *while a green claude measurement sits
> beside them* — the exact mis-read this finding was split from E7-F021 to prevent.

★★ **And this is what the earlier `posture-is-not-the-cause` verdict was groping at — for the wrong
reason.** That verdict was right that a posture change alone would not have made the codex arm write,
and wrong in every step it used to get there: it inferred exoneration from two non-zero exits, when
in fact the posture had *removed* A1's blocker (the opposite of exoneration) and A2 then hit a
credential failure that says nothing about postures at all. A conclusion reached that way is not
evidence for itself; it is recorded here so the correct version replaces it rather than inheriting
its credit.

★ **NO ARGV CHANGE IS PROPOSED, AND NONE IS MADE.** The flag is deliberately NOT added to the
product in this unit. Changing the permission or sandbox posture of a shipped execution path is a
security review the founder has asked to see, and this finding continues to carry the measurement
only. `--skip-git-repo-check` appears nowhere in `server/src/`.

---

## E7-F028 — Probe A's classifier collapses "the CLI refused before reaching a model" into "the agent did not write", so the durable record states a cause the run's own stderr contradicts

**Status:** **resolved** · **Resolved by:** W16B, 2026-09-07 (`replatform/w16b-probe-apparatus-repair`).
**Severity:** MEDIUM
**Filed:** W12, 2026-09-07, from workflow run
[`34087197668`](https://github.com/MeteoriteLabs/AoA/actions/runs/34087197668) and the source of
`scripts/lib/w7u1-agent-output-probe.mjs` at `1c447fa8a`.
**Cross-links:** E7-F027 (the codex arm whose cause was misreported), E7-F021 (the claude arm, whose
verdict this does NOT touch), E7-F014 (the same "a fault is not a negative result" distinction, one
layer down).

**What.** `classifyProbeAArm` (`scripts/lib/w7u1-agent-output-probe.mjs:323-393` (the catch-all is `:392`)) ends with a
catch-all:

```js
return at("did-not-write", `exited-${String(execution?.exitCode ?? "unknown")}`, "");
```

Everything that returns a non-zero exit through the normal channel — a permission refusal, a startup
gate, a missing credential, a crashed binary — becomes the single state `did-not-write`. The guards
above it are careful and thorough (`target-path-already-existed`, `read-faulted`,
`file-present-without-the-nonce`, `arm-did-not-run`, `binary-not-runnable`/exit 127, `arm-faulted`,
`stalled`), and every one of them distinguishes an apparatus problem from a capability answer. **None
of them distinguishes "the agent ran and chose not to write" from "the CLI refused before a model was
ever contacted."**

`verdictProbeA` (`:427-492`) then reads two `did-not-write` arms and emits:

> `no` / `a1-did-not-write-and-the-posture-is-not-the-cause` — *"Neither A1 (…) nor A2 (…) produced
> the file. Adding the permission posture does NOT make the agent able to write here; something else
> is in the way, and a posture-only fix would not have helped."*

**That sentence is contradicted by the same run's captured stderr, in both halves.** A1 was refused by
codex's trusted-directory gate; **A2, with the posture flag, got PAST that refusal** — it reached
`{"type":"thread.started"}` and then failed on `401 Unauthorized`. So on the evidence available the
posture **removed A1's actual blocker**, which is the opposite of "exonerated", and **neither arm was
shown to reach the capability question** (A1 demonstrably did not; A2's preserved stdout is too short
to say). The honest verdict is the one the function already has and
did not select: `a1-did-not-write-cause-unattributed` — *"the NO is sound; the CAUSE is not
established."*

**Why this is worth a register entry rather than a code comment.**

1. **It is written into the DURABLE RECORD, which outlives the log.** The uploaded
   `w7u1-output-probe-record.json` carries
   `"reason": "a1-did-not-write-and-the-posture-is-not-the-cause"` and a `detail` asserting *"a
   posture-only fix would not have helped"*. The stderr that refutes it is in the job log, which is
   not the artefact anyone will quote.
2. **The operator-facing runbook restates it as a conclusion.** `W7U1-output-probe-runbook.md` §5's
   probe-A table reads, for this verdict: *"The permission flag is **exonerated**; something else
   prevents the agent writing… Do not schedule a posture fix off this."* An operator following the
   runbook would have drawn the wrong inference from a green run. (Corrected in the same commit as
   this finding.)
3. ★★★ **The lane stayed GREEN.** `inconclusive` is the only state that reds the pack, by design and
   correctly — but the design assumed the three-state split lands on the right state. Here a
   fourth-state situation ("the experiment did not happen, for a reason we captured") was folded into
   `no`, which is a RESULT, so nothing asked anyone to look. This is this programme's
   *a check that nothing runs* class in its subtler form: the check ran, produced output, and the
   output asserted more than the check could see.

**What this does NOT touch.** The `claude_local` verdict is unaffected — A1 exited **0** with a
model-contacted `init` event and A2 wrote the file, so its cause attribution is supported by four arms
and by the CLI's self-reported `permissionMode`. This finding narrows one verdict; it does not weaken
the other.

**The shape of the fix, NOT implemented here.** The information needed is already captured — the
classifier receives `execution.exitCode`, and the arm logger already prints `stdout`/`stderr`. What is
missing is a state between "the agent did not write" and "the apparatus faulted": *the CLI terminated
with a non-zero status and no evidence it reached a model*. A cheap and honest version would treat a
non-zero exit with **empty stdout** as `indeterminate / cli-refused-at-startup`, and require
`verdictProbeA`'s exoneration branch to see at least one arm that demonstrably ran (the stream-json
`init` / `thread.started` event both CLIs emit). ★★ **THAT PROPOSAL WAS ITSELF WRONG — do not read
this paragraph as the shipped predicate.** "At least one arm" gates the wrong arm, and the head event
alone is not enough; see the RESOLVED section below for the v1→v4 cascade and what actually shipped.
★ **It is deliberately not implemented in this unit**: changing a classifier changes what the pack's next run is allowed to conclude, and this unit
records rather than alters the instrument that produced the record it is recording.

**Severity — MEDIUM.** No shipped behaviour, no gate, no counter. It is filed at MEDIUM rather than
LOW because the artefact it corrupts is the *durable record of a founder-authorised, token-spending
run* — the one thing E7-F025 exists to protect — and because the wrong inference it invites
(*"codex is broken for reasons unrelated to the posture, so ship the posture fix"*) is precisely the
inference E7-F027 exists to prevent.

**Owner — was `unowned`, deliberately.** The defect was in the W7U1 probe pack, whose unit had
shipped (that run was its result). CLI-008 owns the *product* literals, not the instrument, and
attaching an apparatus defect to it would have been false ownership of the kind the ownership guard
exists to catch. The correction was owed by whoever next fired this lane, and W16B did it before the
next keyed run rather than during it.

---

### RESOLVED — W16B, 2026-09-07. Both halves, and what each one is worth

**Both parts of the shape-of-the-fix above are implemented, and each is pinned by a mutation observed
red.** Neither touches the four arms, the three-state model, the green-on-`no`/red-on-`inconclusive`
asymmetry, the durable record or the premise pin.

1. **A refusal is no longer a result.** `classifyProbeAArm` gains a branch, ordered after every
   existing guard and before the catch-all: a `returned` channel with a **non-zero exit and empty
   stdout** is `indeterminate` / **`cli-refused-at-startup`**, never `did-not-write`. The detail line
   says the CLI "never reached the point of doing or declining the work" and sends the reader to the
   arm's stderr. ★ The test is **empty stdout**, deliberately kept separate from the "did it start"
   question below, so that a future repair to either cannot silently satisfy the other.
2. ★★★ **The exoneration branch now demands positive evidence that A2 REACHED A MODEL.** Every arm
   carries two independent progress signals: `ran`, from `detectStartupEvidence(stdout, adapterType)`
   (the CLI's **own head stream event**), and `reachedModel`, from
   `detectModelContactEvidence(stdout, adapterType)` (**model output** on that arm's stdout). The
   branch gates on `a2.reachedModel`; when it is absent the verdict is `inconclusive` /
   **`posture-exoneration-unsupported-a2-did-not-reach-a-model`** rather than an exoneration. It is
   **fail-closed**: an arm with no evidence — including one classified by a caller that never passed
   stdout — counts as *not shown to have reached a model*. The conviction branch (`a2` wrote) is
   deliberately **not** gated: a write is stronger evidence than any stream event, and gating it
   would red the run that actually answered the pack's question.

   ★★ **THIS PREDICATE WAS WRONG TWICE MORE BEFORE IT WAS RIGHT, AND THE CASCADE IS THE LESSON.** As
   first written this clause said *"at least one arm demonstrably ran"*. Two reviewers took it apart
   in sequence, each fix necessary and insufficient:

   | v | predicate | why it was still wrong |
   |---|---|---|
   | v1 | any non-zero exit ⇒ `did-not-write` | cannot tell a refusal from a result — the finding above |
   | v2 | at least one arm demonstrably ran | **wrong arm.** Only A2 carries the posture, so A1 running proves nothing about a posture-only fix |
   | v3 | `a2.ran === true` | better, and still head-event-only |
   | v4 | `a2.reachedModel === true` | `ran` is computed from the HEAD EVENT ALONE, so two arms that **start and show no model-contact evidence** exonerate a posture nothing was shown to have exercised — codex A2 in run `34087197668` emitted `thread.started` + `turn.started` and then FOUR `Reconnecting… N/5` 401 lines (2/5–5/5), with no model-contact evidence in the EXACTLY 900 chars of stdout the run preserved (a fact about the record: it ends mid-token at `{"type":"i`) |

   ★ **Assume v4 is insufficient too.** It is a proxy and says so, in the code (`EXONERATION_RESIDUAL`),
   in the verdict `detail` it emits verbatim (so the **durable record** carries it), and in the
   runbook's own verdict table, with a test pinning the runbook to the code. What it does not
   establish: that the model was given the intended prompt, understood it, or ever *attempted* a
   write; anything about A1, which this branch does not gate; anything beyond the first 8000
   characters of captured stdout; and, for `model-authored-content`, anything a CLI could synthesise
   locally on a transport failure — only `billed-usage` is a round trip that cannot be faked in-guest.

**The head-event shapes are MEASURED per CLI, twice over, not guessed** — from the adapters that
parse them in the shipped product **and** from this pack's own recorded stdout in run `34087197668`:

| adapter | head event | adapter source | run `34087197668` |
|---|---|---|---|
| `claude_local` | `{"type":"system","subtype":"init",…}` | `packages/adapters/claude-local/src/server/parse.ts:19` — `type === "system" && asString(event.subtype, "") === "init"` (same pair at `cli/format-event.ts:34`, `ui/parse-stdout.ts:44`) | `[w7u1/A/claude_local] A1 … stdout="{\"type\":\"system\",\"subtype\":\"init\",\"cwd\":\"/home/user\",…"` |
| `codex_local` | `{"type":"thread.started","thread_id":…}` | `packages/adapters/codex-local/src/server/parse.ts:64` and `:136` — `type === "thread.started"` | `[w7u1/A/codex_local] A2 … stdout="{\"type\":\"thread.started\",\"thread_id\":\"01a07a5b-…\"}
{\"type\":\"turn.started\"}…"` against `A1 … exit=1 … stdout=""` |

★ **Both claude keys are required on ONE line.** `"type":"system"` alone also heads non-`init` system
events, so matching it alone would certify a start from an event that says nothing of the kind; and
requiring the pair on one line stops two unrelated events from combining into false evidence. A test
reads both adapter files off disk, so a renamed head event fails loudly instead of silently turning
every future exoneration inconclusive.

**The MODEL-CONTACT shapes are measured the same way, and the negative direction is the load-bearing
half** — a head event is not model contact, and the events below were chosen because they are not:

| adapter | counts as model contact | adapter source | does NOT count |
|---|---|---|---|
| `claude_local` | `{"type":"assistant","message":{"content":[…]}}`; `{"type":"result",…,"usage":{"output_tokens":N>0}}` with `is_error !== true` | `claude-local/src/server/parse.ts:25-37` and `:40-64` | ★ a `result` with `is_error: true` — `parse.ts:127-128` records the real revoked-token shape `{"subtype":"success","is_error":true,"api_error_status":401,…}`, so accepting `result` unconditionally would re-open the defect one event later |
| `codex_local` | `{"type":"item.completed","item":{"type":"agent_message"\|"reasoning","text":…}}`; `{"type":"turn.completed","usage":{"output_tokens":N>0}}` | `codex-local/src/server/parse.ts:189-201` and `:229-235` | ★ `thread.started` and `turn.started` — **these two are the v4 defect in stream form** — and an `item.completed` whose item is neither a message nor reasoning |

★ **Three mutations, each observed red with real output:** reverting the gate to `a2.ran` (the v3
predicate) reds a case built from run `34087197668`'s real codex stdout through the real classifier;
reverting it to "at least one arm ran" (v2) reds a case where A1 reached a model and A2 did not;
removing the `is_error` guard reds the 401-`result` case. The named positive controls — a genuine
`did-not-write` with A2 having reached a model, and a genuine write — stay green and `measured` in
all three.

**Replayed, run `34087197668`'s codex half now returns `inconclusive` / `a1-cli-refused-at-startup`**
— it stops at the A1 gate, *earlier* than the exoneration branch, which is the more honest place. A
test drives the real classifier from that run's real captured stdout into the real verdict function
and asserts exactly that.

★★ **The lane would have gone RED for that run, and that is correct.** The claude verdict is
untouched and still `no / …-posture-is-the-cause`; the codex half now says "the apparatus did not
answer", which is what `inconclusive` means. Nothing about the green-on-`no` asymmetry changed — what
changed is which state a refusal lands in.

---

## E7-F029 — The pack's no-key self-test renders a SECOND, synthetic RESULT report — fixture details `d1`/`d2`, `DISPOSITION: inconclusive` — into the same job log as the real one, and by derivation the same step summary

**Status:** open · **Owner:** unowned (see reason)
**Severity:** LOW
**Filed:** W12, 2026-09-07, from workflow run
[`34087197668`](https://github.com/MeteoriteLabs/AoA/actions/runs/34087197668) and the source of
`packages/sandbox-e2b-provider/src/__tests__/keyed-w7u1-agent-output-probe.test.ts` at `1c447fa8a`.
**Cross-links:** E7-F025 (a verdict that does not survive is not a measurement — this is the same
concern from the opposite side: a verdict that survives *twice*, saying two different things).

**What.** The pack's no-key wiring test —
`describe("W7U1 — template resolution and the durable record (no key required)")`, the case
`"emitDurableRecord writes a retrievable record naming the template, the sha and every verdict"`
(`:898-930`) — calls the **real** `emitDurableRecord` with fixture verdicts:

```ts
await emitDurableRecord([
  { probe: "B", state: "no", reason: "template-prefills-nothing", detail: "d1" },
  { probe: "A/claude_local", state: "inconclusive", reason: "no-model-provider-key", detail: "d2" },
]);
```

`emitDurableRecord` (`:696-740`) renders `report(verdicts)` and emits it to **three** channels. The
test redirects only one: it saves and restores `W7U1_RECORD_PATH` around the call, so the uploaded
artefact is safe. It does **not** touch `console.log`, and it does **not** touch
`GITHUB_STEP_SUMMARY`.

★ **Two claims, and they are NOT equally established — separated rather than merged.**

- **OBSERVED, in the run's own step log:** the synthetic report is rendered to stdout. The table
  below is read off it.
- **DERIVED from source, NOT observed:** that the same block is also appended to the **run page's
  step summary**. `emitDurableRecord` appends unconditionally whenever `GITHUB_STEP_SUMMARY` is a
  non-empty string, Actions sets that variable for every step, and the test overrides only
  `W7U1_RECORD_PATH` — so the append must have happened. It could not be confirmed after the fact:
  a job summary's rendered text is not exposed by the API (`check-runs/101633392292` returns
  `output.text: null`), and reading it needs the run page in a browser. **A reader who needs that
  half certain should look at the run page, or fire the lane once more and look.**

**Measured in the run, not inferred.** Two blocks headed
`================ W7U1 OUTPUT PROBE PACK — RESULT ================` appear ~7 ms apart:

| | timestamp | `TEMPLATE:` line | probe lines | last line |
|---|---|---|---|---|
| the REAL report | `05:34:20.5464` | `aoa-base (default-cli-bearing)` | four, with real details | `DISPOSITION: measured — B=no C=yes A/claude_local=no A/codex_local=no` |
| the SYNTHETIC one | `05:34:20.5531` | **identical** | two, details `d1` and `d2` | `DISPOSITION: inconclusive — inconclusive probes: A/claude_local (no-model-provider-key)` |

Everything that identifies the report as authentic is **shared**: the banner, the resolved-template
line and its whole explanatory note, the commit sha, the **real run nonce**, and the full four-arm
legend. The synthetic block is second, so it is the one a reader scrolling to the end of the step
sees, and it says `inconclusive` — the pack's own word for *"run me again"* — at the bottom of a run
that measured everything it set out to.

★ **This is not hypothetical harm — though the report of it is second-hand, and is marked so.** The
session that commissioned this recording states that it nearly reported the pack's disposition as
`inconclusive` from the trailing block, and that only the artefact settled it. That is a relayed
account rather than something this unit observed; what this unit DID observe is the two blocks above,
which carry the finding on their own.

**The fix, and why it is NOT implemented here.** The smallest honest change is to make the fixture's
identity visible **inside the rendered report** rather than only in the verdict details — e.g. a
banner the renderer emits when the run nonce is a fixture, or a `fixture: true` flag threaded into
`report()`. ★ **That is not a one-line change provable with a mutation**, which is the bar this unit
set for touching anything: `report()` reads module-level constants (`TEMPLATE`, `TEMPLATE_RESOLUTION`,
`COMMIT_SHA`, `RUN_NONCE`, `ARM_SPECS`) and takes only `verdicts`, so a fixture flag has to be
threaded through `emitDurableRecord` into `report`, and the anti-regression test for it has to assert
a rendered STRING that no current test asserts. The two smaller variants are both worse: silencing
`console.log` in the test kills the very wiring assertion the test exists to make (that
`emitDurableRecord` actually emits), and asserting on log output in a second test pins the defect
without removing it.

★★ A **cheaper and strictly safer** interim, recorded so the next author does not have to rediscover
it: the test can point `GITHUB_STEP_SUMMARY` at a temp file for the duration of the call, exactly as
it already does for `W7U1_RECORD_PATH`. That removes the synthetic block from the **run page** — the
surface a human reads first — leaves the log-stream duplication (harmless once known, and still
evidence that the emitter fired), and needs no change to `report()`. It is not applied here for the
same reason: it is a change to the pack, and this unit records the pack's output rather than editing
the instrument.

**Severity — LOW.** It misleads no gate, corrupts no artefact, and changes no product behaviour; the
durable record — the channel the whole design exists to protect — is correct. It is filed rather than
noted because the confusion it causes lands on exactly the surface a founder-authorised run is read
from, and because a report byte-similar to a real one *including the real run nonce* is a provenance
problem, not a formatting one.

**Owner — `unowned`, for the same reason as E7-F028:** it is a defect in the W7U1 instrument, whose
unit has shipped, and CLI-008 owns the product literals rather than the pack. It blocks nothing —
`tickets/W7U1-output-probe-result.md` §6 and the runbook both now say *read the artefact, not the last
report block* — and it is owed by whoever next fires this lane.

---

### PARTLY FIXED — W16B, 2026-09-07. The run page is clean; the step log still shows two blocks

★ **THE STATUS STAYS `open`, DELIBERATELY.** Half the defect is gone and half is not, and marking it
resolved would be a false claim about the surface that still carries it.

**Applied — exactly the "cheaper and strictly safer interim" this finding recorded.** The no-key
wiring test now points `GITHUB_STEP_SUMMARY` at a temp file for the duration of the
`emitDurableRecord` call, precisely as it already did for `W7U1_RECORD_PATH`, and restores it in the
same `finally`. **The synthetic block no longer reaches the run page** — the surface a human reads
first, and the one whose trailing `DISPOSITION: inconclusive` the orchestrating session nearly
reported as the run's verdict.

★★ **It ADDS coverage rather than removing it, which is why it was safe to do.** The summary channel
had **no assertion at all** before: the append simply happened to land on the real summary in CI. The
redirected file is now read back and asserted to contain both the banner and the rendered
disposition, so the emitter's third channel is wired-tested for the first time.

**NOT fixed, and named so nobody has to rediscover it.** The **step log** still shows two
`W7U1 OUTPUT PROBE PACK — RESULT` blocks. Silencing `console.log` would kill the only assertion that
`emitDurableRecord` emits at all, and the structural fix — a fixture banner rendered by `report()`
itself — needs a flag threaded from `emitDurableRecord` into `report()` (which today reads
module-level constants and takes only `verdicts`) plus an assertion on a rendered STRING that no
current test makes. That remains the shape of the real repair; it was out of scope for a unit whose
job was to make the instrument safe before the next keyed run, not to redesign its renderer.

**So the operator guidance is now three lines, not two:** the uploaded **artefact** is correct, the
**run page** is correct, and the **raw step log** still shows two blocks — read the second one as the
self-test's fixture, not as a result. The runbook's warning box says exactly this.

★★★ **A SECOND SITE, FOUND BY GREP AND FIXED IN THE SAME COMMIT — the brief named one.**
`packages/sandbox-e2b-provider/src/__tests__/keyed-w10b-egress-enforcement-probe.test.ts` carries the
**identical** shape: its `emitDurableRecord` (`:521`) appends to `GITHUB_STEP_SUMMARY`
unconditionally, and its no-key wiring test saved and restored only `W10B_RECORD_PATH`. So the first
time an operator fires the W10B DE-08 lane, a synthetic
`========== W10B DE-08 EGRESS-ENFORCEMENT PROBE — RESULT ==========` block with fixture details
`d1`/`d2` and a trailing `DISPOSITION: inconclusive` would have landed on that run's page too.
★ **DERIVED FROM SOURCE, NOT OBSERVED** — that lane has not fired, so there is no run log to point
at; the claim is the code shape, and it is marked as such rather than borrowed from W7U1's
observation. Fixed identically (redirect + a new assertion on the redirected file). **Measured scope
of the class: two sites, both `emitDurableRecord`-shaped packs; no third.** No other test in the repo
calls a function that writes to `GITHUB_STEP_SUMMARY`.

## E7-F030 — W21 moved ONE consumer of run-provenance and left its sibling behind, so a counted output was never scanned for secrets

**Status:** resolved · **Owner:** CLI-008 · **Severity:** MEDIUM · **Filed:** 2026-09-08 (W21B),
measured at `f433c8391`. **Introduced by W21 (PR #385), found by external review (Codex P2), not
inherited** — the row-set gap did not exist before the arm-2 narrowing. The ROW-set half was fixed
at `f171d0dad` (W21B); the COLUMN-set residual it stayed open on is fixed in W21C — see
**Resolved** below.

---

**What.** `server/src/services/e7-distributed-run-verifier-store.ts` has **two** consumers of the
question *"which `task_outputs` rows belong to this run?"*, and W21 changed one of them:

| consumer | at `f433c8391` |
|---|---|
| `countProducedOutputs` arm 2 (clause 6 CAPABILITY) | an APPLIED `output_projection` receipt join — **does not read `created_by_run_id` at all** |
| `listRunSecretScanSurfaces` source (2) (clause 4 SECRET SCAN) | `eq(taskOutputs.createdByRunId, run.id)` — **unchanged, still the column** |

So a `task_outputs` row that counts as capability evidence *via the receipt*, but whose
`created_by_run_id` is NULL or names another run, **is never scanned for secrets**. A recognizable
provider key / E2B key / connection string / PEM header in its `summary` or `metadata` never reaches
clause 4, and the verifier prints a clean mechanism **and** capability verdict over it.

★ **THE PR ITSELF PROVED THE GAP WAS REACHABLE, WHICH IS WHY THIS IS NOT HYPOTHETICAL.** W21 shipped a
PASSING test asserting exactly the divergent row shape is supported:
`server/src/__tests__/e7-f020-arm2-provenance.integration.test.ts`, the SECOND `[positive]` arm — *"it
is counted even when the bridge caller supplied NO run id — provenance is the receipt, not the
column"* (W21D: prose elsewhere calls the two positive arms `[positive A]`/`[positive B]`; **neither
tag exists in the file** — both are literally `[positive]`, so quote the `it()` title, not the tag) — with
`SELECT count(*) FROM task_outputs WHERE created_by_run_id IS NULL` asserted to be 1.

**Reproduction, and the RED that sized it.** Three arms added to that same suite (embedded PG, real
lease fence, real bridge, real emitter). Against the store **as it stands at `f433c8391`**, with the
new tests present and nothing else changed:

```
pnpm --filter @armyofagents/server exec vitest run \
  src/__tests__/e7-f020-arm2-provenance.integration.test.ts -t "E7-F030"     # AOA_RUN_WIN_INTEGRATION=1 on Windows

  × [union]  a bridge-projected output with NO caller run id is SCANNED — its planted key reaches clause 4
      → AssertionError: expected false to be true            (the row is not in the scan surface at all)
  ✓ [legacy] a platform row linked ONLY by created_by_run_id is STILL scanned
  ✓ [dedupe] a row satisfying BOTH notions is scanned exactly once
  Tests  1 failed | 2 passed | 6 skipped (9)
```

Post-fix: **9/9 green** in that file *as it stood at `f171d0dad`*.

> **Count corrected 2026-09-08 (W21D).** That "9/9" is a snapshot, not a standing claim, and it was
> left reading as one. The file has grown since — W21C added the attempt arms, and W21D added the
> `[precision]`, `[credential]` and `[boundary]` arms — so it now has **20 `it()` blocks expanding to
> 30 runtime cases**, all green. Do not read a stale total as current coverage; run the file.

★★★ **THE FIX IS THE UNION, NOT "MAKE THE TWO PREDICATES CONSISTENT" — and that distinction is the
whole finding.** The reviewer's suggested repair (reuse arm 2's receipt predicate in the scanner)
introduces the MIRROR defect: every legacy platform writer — including
`emitRuntimeServiceTaskOutput`, the one that needs nobody to do anything — would silently stop being
scanned. **The two consumers want OPPOSITE error directions:**

- the **COUNTER** wants **PRECISION**. Over-counting = a false `capability: PROVEN`. That is E7-F020,
  and it is exactly why arm 2 was narrowed to the fenced receipt.
- the **SCANNER** wants **RECALL**. Under-scanning = a leaked secret reported clean. Over-scanning a
  row that turns out not to belong to this run costs one redundant regex pass, and if it *did* trip a
  matcher it fails CLOSED (refuse to bless) — never a false PASS.

So the scan surface is the **UNION**, de-duplicated by row id: rows named by an applied
`output_projection` receipt for this run's distributed job, **OR** rows with
`created_by_run_id = run.id`. **Two queries plus a merge into a `Map`**, deliberately, not one clever
`OR`: the single-statement form needs a LEFT JOIN with a four-conjunct `ON`, `OR r.id IS NOT NULL`, a
`DISTINCT` over a `jsonb` column, and correct degradation when the run has no `distributed_job_id`.
The reasoning is written at the call site so the next "consistency" edit trips over it.

**Both mutation directions are pinned, and the POSITIVE CONTROL is the more important one.**

| mutation | reds |
|---|---|
| drop the receipt half (i.e. the state at `f433c8391`) | `[union]` only |
| drop the column half (i.e. the same-predicate "consistency" fix) | `[legacy]` only — **observed**, by replacing the merge loop with `void columnLinked` |
| `return []` / drop both | `[union]` + `[legacy]` |

`[legacy]` is green before AND after the fix. A test that passes both before and after pins nothing
*about the defect*; it is here to pin the **error direction**, which is the thing a future edit is
most likely to get wrong. The tests live in the arm-2 file on purpose — splitting them would let the
next edit to arm 2 happen without the scanner's pins in view, which is how the drift happened.

★★ **THE CLASS, which is why this is a finding and not a line in a commit message.** Two consumers of
one provenance notion drifted apart because the notion was never written down in one place, and
nothing in CI could tell. Compare **E7-F010** — growing the non-frozen port left every
frozen-DERIVED structure behind. Same shape: a change is made at one site of a relation that has
several, the sites are not enumerated, and the untouched sites keep the old meaning silently.
**Remedy applied:** a per-consumer provenance census is now a table in the store's module header
(all ten consumers, each with its linkage, its error direction, and whether the linkage is right for
that direction), together with the explicit statement that the notion **must not** be centralised
into one predicate — the divergence between #7 and #10 is the correct state, and what was missing
was a written reason.

★ **NOT CENTRALISED, deliberately.** A shared `rowsBelongingToRun()` helper would have to take a
direction parameter and would read as one notion with a flag, which is precisely the framing that
produced the bug. Two explicit predicates with a census that names both is the safer artefact.

**WHAT SURVIVED at `f171d0dad` — a MEASURED COLUMN-set residual, reported rather than silently
widened.** The scan read only `summary` and `metadata`. On a bridge-projected row, `title` (NOT NULL)
and `url` are also caller/agent-authored (`BridgeOutputInput`,
`server/src/services/job-output-bridge.ts:68-87`) and were **not scanned**, so a recognizable secret
in either still reached a clean verdict. That is a different axis from the ROW-set gap fixed there —
widening it changes what trips clause 4 for **every** legacy row too, so it wanted its own pinning
test and its own review rather than a drive-by line in that commit.

---

**Resolved (W21C, 2026-09-08) — the column-set residual is closed, and it was WORSE than the
residual note said.** An adversarial checker measured it and the reproduction is sharper than the
original wording: with the leak in `title` and `summary`/`metadata` both NULL, the row does not merely
go under-scanned — it contributes **no scan surface at all**, because
`listRunSecretScanSurfaces` builds `summary + metadata`, gets the empty string, and the
`if (text)` guard drops the row. So the verifier printed a clean clause-4 verdict over a row it had
already fetched and already counted as capability evidence.

**The fix scans every caller-authored column, not just the two the reviewer named.** The scanned set
is now `title`, `url`, `provider`, `external_id`, `health_status`, `summary`, `metadata` — the full
free-text surface `BridgeOutputInput` passes straight through. `type`, `status`, `review_state` and
`is_primary` are deliberately excluded: they are closed enums and a boolean
(`packages/shared/src/validators/task-output.ts`) and cannot carry a value. The columns are joined
with a space so a matcher can never span two columns and manufacture a hit from two innocuous halves.

**Five arms, one per column, each planting the key in that column ALONE** (with an anti-vacuity
assertion that `summary` and `metadata` really are NULL, so the hit can only come from the column
under test) — `e7-f020-arm2-provenance.integration.test.ts`, `E7-F030 residual`. All five observed
RED at `f171d0dad` with `expected undefined to be defined` (no surface at all, per above).
**Mutation-checked:** dropping `title` from the concatenation reds exactly one arm, `[column] title`,
and nothing else — so each column is individually load-bearing rather than covered by a sibling.

**THE OTHER TWO SCAN SOURCES WERE AUDITED FOR THE SAME QUESTION — the class does NOT generalise, and
that is a measurement, not an assumption.**

| source | scanned columns | verdict |
|---|---|---|
| (1) `heartbeat_runs` | `stdout_excerpt`, `stderr_excerpt`, `error`, `prompt_snapshot`, `detected_outputs`, `result_json`, `context_snapshot`, `usage_json` | **complete.** Every remaining text column is a platform vocabulary (`invocation_source`, `status`, `error_code`, `signal`, `liveness_state`, `liveness_reason`, `last_output_stream`, `scheduled_retry_reason`), an id-suffixed literal (`next_action` — always `work_question:<id>` / `runtime_decision:<id>`), an opaque adapter session id (`session_id_before/after`), a platform storage handle (`log_store`/`log_ref`/`log_sha256`, written from `handle.logRef`), or dead (`external_run_id` has no writer in `server/src`). The one caller-supplied free-text column is `trigger_detail` (`routes/agents.ts:2009`, `req.body.triggerDetail`) — a BOARD-supplied wakeup label, not agent output, so outside the notion this scanner serves. Named here rather than left unstated. |
| (3) `job_artifacts` | `identifier`, `object_key` | **complete.** Everything else is a digest (`sha256`, `base_manifest_hash`, `result_manifest_hash`), a size, a timestamp, or a closed enum (`kind`, `sensitivity`, `retention`, `status`, `apply_status`, `orphan_disposition`, `quarantine_reason`). `fence_token` / `observed_fence_token` are deliberately NOT scanned: they are platform-minted lease secrets, and pulling them into scan text would import credential material into the verifier's own working set to no benefit. |

**Why `task_outputs` was the only one with a gap, structurally:** it is the only scan source whose
row is assembled from a **caller-supplied product record** with many free-text fields. The other two
are kernel rows whose free text is one or two worker-declared strings. So the answer to "does a recall
gap on one source suggest the class?" is: the *question* generalises and was worth asking on all
three, the *defect* did not.

**Not widened.** E7-F015 and E7-F018 are untouched. Arm 2's predicate, `ok`, the clause set, and
`capabilityProven`'s separation from `ok` are all unchanged — this changes only which rows clause 4
reads. **What a fixed scan does NOT buy:** E7-F018 still holds (nothing checked in makes any run a
distributed run; `projectAcceptedOutput` has zero production callers), so the union's receipt half
selects nothing on any real run today. It is correct rather than exercised.

---

## E7-F031 — the capability counter bound to the JOB, so a RETRY attempt's work printed `capability: PROVEN` for a run that produced nothing

**Status:** resolved · **Owner:** CLI-008 · **Severity:** MEDIUM · **Filed:** 2026-09-08 (W21C),
measured at `f171d0dad`. **Introduced by W21 (PR #385), found by external review (Codex P2), not
inherited.** Fixed in the commit that files it.

---

**What.** `countProducedOutputs` in `server/src/services/e7-distributed-run-verifier-store.ts`
filtered **both** of its arms on `job_id` alone:

| arm | predicate at `f171d0dad` |
|---|---|
| 1 (committed workspace patch) | `job_artifacts.job_id = run.distributed_job_id AND kind='workspace_patch' AND status='committed'` |
| 2 (projected task output) | an APPLIED `output_projection` receipt on `job_id` + `aggregate_kind` + two company conjuncts — **no `attempt_id`** |

`jobs.max_attempts` is NOT NULL default 3 (`packages/db/src/schema/jobs.ts:70`) and **every attempt
of a job shares its `job_id`**, while a heartbeat run is bound to exactly **one** attempt:
`heartbeat_runs.distributed_attempt_id`, written once by `buildHandoffRunPatch` and read as an exact
`(job_id, attempt_id)` pair by the projector's `findRunForAttempt` (`heartbeat.ts:7061-7068`). The
lifecycle contract says the same thing in words — *"the run is one attempt, not the source of truth"*
(`docs/architecture/distributed-execution-lifecycles.md`, legacy concept mapping).

So an `output_projection` receipt from attempt N+1, or a `workspace_patch` committed by attempt N+1,
was counted while verifying a run bound to attempt N. **An output-free run could report
`capabilityProven: true` off another attempt's work.** That is the same false-PROVEN class E7-F020
closed, one axis over: W21 replaced a column-provenance bug with a **granularity** bug.

★ **THE ASYMMETRY, AGAIN, AND FOR THE SECOND TIME THE REVIEWER'S NEXT STEP WAS WRONG.** The review
asked for the attempt predicate on *"both this counter and the receipt-linked secret-scan query"*.
**Applying it to the scanner would be a regression** — it wants RECALL, so narrowing it to one attempt
would stop scanning sibling attempts' outputs and let a secret in attempt 2's output go unseen while
verifying attempt 1. That is the mirror defect E7-F030's `[legacy]` arm already exists to catch, one
axis over. **The scanner needed no widening either: its `(2a)` half was ALREADY job-wide**, which is
the correct breadth on this axis, so the right action for the scanner was *nothing*. This is the
second time collapsing these two consumers onto one predicate has been proposed and the second time
the asymmetry is right; the "DO NOT MAKE THIS CONSISTENT" block at the scanner's call site now covers
the ATTEMPT axis explicitly, not only the row-linkage axis.

**Why attempt-binding is not an over-narrowing — measured, not asserted.** Nothing ever re-points
`distributed_attempt_id` at a retry attempt: the column has exactly ONE writer in the tree
(`buildHandoffRunPatch`, at handoff; `canary-run-projector.ts:196` writes the id into `usage_json`,
not the column). So on a retried job the control plane **itself** does not attribute attempt 2 to this
run — `findRunForAttempt` finds no run for attempt 2's terminal, the run is never finalized from it,
and clause 3 refuses it for want of a durable terminal. Counting attempt 2's work for attempt 1's run
was the anomaly; excluding it now agrees with rows 2–5 of the census. **The arm remains structurally
passable**, which was the explicit honesty check: `attempt_id` is NOT NULL on every receipt and comes
from the control plane's live fence (`recordGovernedProjection` runs `guardActiveFence` first), and
every `status='committed'` `job_artifacts` row carries the attempt NUMBER its fence stamped
(`commitArtifactVersion` is the sole writer of that status). A gate nobody can pass gets deleted; this
one is passed by the `[own arm2]` and `[own arm1]` positive controls.

**The null case is a decision, stated: FAIL CLOSED.** A run with a `distributed_job_id` and no
`distributed_attempt_id` counts 0 on both arms rather than widening back to job scope. It is reachable
only on a partially-written row, and **clause 2 already REFUSES such a row** for incomplete evidence
binding — so printing PROVEN beside that refusal, over work no attempt of this run can be shown to
have done, is exactly the false-PROVEN this closes. Pinned by `[null attempt]`, which also asserts the
anti-vacuity direction: with the attempt id restored the very same rows DO count.

**Arm 1 was found by the census, not by the review, and fixing only arm 2 would have been a false
claim of enforcement.** The two arms are ORed into one gate (`arm1 < 1 && arm2 < 1`), so leaving arm 1
job-granular would have left the gate openable by precisely the mechanism arm 2's fix closes.
`job_artifacts.attempt` is an attempt NUMBER, so arm 1 binds through `job_attempts`
(`attempt_number = job_artifacts.attempt AND job_attempts.id = run.distributed_attempt_id`), plus a
company conjunct. The thin `authorizeArtifactCommit` rows that leave `attempt` NULL also leave
`status` NULL and so were never counted here anyway.

**Fail-first, with real output at `f171d0dad`** (`e7-f020-arm2-provenance.integration.test.ts`,
`E7-F031`). The fixture gained `activateSiblingLease`, which places a **real** second attempt on an
already-seeded job and polls + ACKs it through the real leasing service, so the sibling receipt is
written under a genuine live fence rather than forged with admin SQL:

| arm | at `f171d0dad` | after |
|---|---|---|
| `[sibling arm2]` receipt on attempt 2, run bound to attempt 1 | **RED** — `expected 1 to be +0` | green |
| `[sibling arm1]` committed patch on attempt 2, run bound to attempt 1 | **RED** — `expected 1 to be +0` | green |
| `[null attempt]` job id set, attempt id NULL | **RED** — `expected 1 to be +0` | green |
| `[sibling-scan]` counter half of the asymmetry pin | **RED** — `expected 1 to be +0` | green |
| `[own arm2]` receipt on the run's OWN attempt | green | green — **positive control**, reds on an over-narrow predicate or a `return 0` |
| `[own arm1]` patch committed by the run's OWN attempt | green | green — same |
| `[sibling-scan]` **scanner** half | green | green — **the asymmetry pin.** Reds if the counter's attempt conjunct is copied into the scanner |

`[sibling-scan]` is the important one: one row, **scanned** by clause 4 and **not counted** by clause
6, asserted in a single test. The divergence is pinned rather than merely tolerated.

**THE OPERATOR-FACING CAVEAT WOULD HAVE GONE FALSE SILENTLY — for the second time.**
`E7_CAPABILITY_LIMITATIONS` is printed beside every verdict, and it stated the receipt match as
*"`job_id` = this run's `distributed_job_id`"* and declared *"arm 2 ONLY … arm 1 … was not touched"*.
E7-F031 falsified both. Its own doc comment already records that W21 had to rewrite it for the same
reason, so this is a recurring shape: **a caveat printed beside a verdict is a claim about the code
and goes stale exactly like a comment, except it is read by operators who cannot see the predicate.**
Corrected, plus a new assertion (`e7-distributed-run-verifier.test.ts`, W7U2 SECOND CONTROL) pinning
`attempt_id`, `distributed_attempt_id`, `max_attempts`, `E7-F031`, and the scanner's exemption.

★ **AND THE GUARD THAT CAUGHT IT WAS ITSELF WIDENED RATHER THAN ROUTED AROUND.** The existing
assertion was a flat `expect(text).not.toContain("both arms")` — a proxy for "do not attribute
E7-F020 to arm 1". E7-F031 made a cross-arm sentence TRUE, so the flat ban forbade an accurate
statement, and the tempting fix is to reword around the banned string: **a guard defeated by a
synonym is a guard that has stopped guarding.** It now says what it always meant — a cross-arm claim
is allowed only inside the paragraph citing the finding that licenses it, and never in a sentence
making the E7-F020 provenance claim. **Mutation-verified:** appending "covers both arms" to the
`Scope:` tail reds it (`expected 2281 to be less than 1948`), so the structural rule is not vacuous.

★★ **THE CLASS — a census can be complete on the axis it was written for and blind on another.** The
ten-row census in the store's module header is the remedy E7-F030 installed, and it MISSED this: it
reasoned about WHICH LINKAGE each consumer used and never about AT WHAT GRANULARITY. An adversarial
checker even noticed the retry axis — it flagged that attempt 2's `job_events` go unscanned on a
retried job — and filed it as a non-blocking prose nit, because it looked at the RECALL direction
while the same structural fact was a FALSE PROVEN in the counter. **The same fact reads as a nit or as
a defect depending on which consumer you are standing in**, which is precisely why the census is
per-consumer. **Remedy applied:** the census now carries a `granularity` column for all ten rows and
names its three axes (row linkage / granularity / column set) at the top, so the next reader is asked
the question on each. The pass that added it found one further mismatch — filed as **E7-F032**.

---

## E7-F032 — clause 4 does not scan a sibling attempt's `job_events`, so a retried job's leak can reach a clean verdict

**Status:** open · **Owner:** CLI-008 · **Severity:** LOW · **Filed:** 2026-09-08 (W21C), by
re-applying the provenance census to the retry/attempt axis (E7-F031's remedy). Independently noticed
by an adversarial checker during W21B review and filed there as a non-blocking prose nit; recorded
here as a finding because the census pass measured what it costs.

---

**What.** `listJobEvents(attemptId)` is row 4 of the census, and it is the ONE consumer that serves
**both** directions from a single query: clause 5 counts `attempt_started` / `terminal` events
(PRECISION), and clause 4 scans every event payload for leak classes (RECALL). Its linkage is
`job_events.attempt_id`, which is exact and is the only linkage the table has — so on the ROW axis the
old census cell was right to say the two directions do not conflict.

**On the ATTEMPT axis they do.** Clause 5 wants THIS attempt's events (a sibling attempt's
`attempt_started` must not corroborate this attempt — that would be a false PASS). Clause 4 wants the
whole job's, for the same reason source (2a) of `listRunSecretScanSurfaces` is job-wide. Because one
query serves both, clause 4 inherits clause 5's narrowness: **on a retried job, attempt 2's event
payloads are never scanned while verifying attempt 1**, so a recognizable provider key / E2B key /
connection string / PEM header in a sibling attempt's event payload reaches a clean clause-4 verdict.

**Why it is LOW rather than the severity E7-F031 carries.** The direction is the difference. A recall
gap is a MISSED hard-fail — the verifier fails to refuse something it should have refused. A precision
gap is a FALSE PROVEN — the verifier asserts something untrue. Both matter; only one manufactures a
claim. And E7-F018 still bounds the blast radius: no checked-in configuration makes any run a
distributed run, so no real run has a sibling attempt today.

**Why it is NOT fixed in W21C.** Separating the directions needs a SECOND store method
(`listJobEventsForJob`, or an added job-scoped scan source) and widens what can HARD-fail clause 4 for
every run that ever retries — a behaviour change to the refusal surface, on the same reasoning that
kept E7-F030's column-set residual out of W21B rather than smuggling it in. It wants its own pinning
test (a leak in a sibling attempt's event payload must reach clause 4 while clause 5's counts stay
attempt-scoped) and its own review.

**What WAS done here, and it is the load-bearing half.** Row 4's census cell used to assert *"attempt_id
is the only linkage the table has, and it is exact, so the two directions do not conflict here"*. That
sentence is now corrected to name the split and cite this finding. **A census that asserts a coverage
it does not have is worse than one that admits the gap** — the false claim converts an open question
into a settled one for every later reader, which is the same failure mode
`scripts/lib/finding-ownership.mjs` exists to prevent one register over.

---

## E7-F033 — the widened secret scanner's `connection_string` matcher (the scheme-only false-FAIL on a credential-free `postgres://localhost` was FIXED at the predicate by W21D) — residual: a standing precision-AND-recall suite obligation, and two still-over-matching hard matchers (`provider_key`, `e2b_api_key_assignment`)

**Status:** open · **Owner:** CLI-008 · **Severity:** MEDIUM · **Filed:** 2026-09-08 (W21D), by a blind
review panel and confirmed by writing the precision test FIRST and running it at `4c7327b33` with
production code untouched. **Fixed at the predicate in the same unit**; the entry stays open for the
standing obligation it puts on the suite, not for an outstanding repair.

---

### ★ re-measured 2026-09-10 at `3223eba74`: FALLEN — the false-FAIL is FIXED; severity corrected HIGH → MEDIUM, finding stays OPEN on the residual

The defect this finding was FILED on — the `connection_string` hard matcher failing a clean run because
it matched **any** URI of a database scheme, so a credential-free `postgres://localhost:5432/dev`
dev-service URL hard-failed clause 4 — is **FIXED at HEAD**. Re-read by hand: the `connection_string`
matcher (`server/src/services/e7-distributed-run-verifier.ts:408-411`, in `HARD_LEAK_MATCHERS` at
`:365`) is narrowed to **(a)** URI userinfo carrying a password component (`scheme://user:pass@host`,
including the password-only `scheme://:pass@host`; a bare `scheme://user@host` is deliberately not
matched) **OR (b)** a credential-bearing query parameter (`[?&](password|passwd|pwd|token|secret|
api[-_]?key|access[-_]?token|auth)=`). It is no longer scheme-only, so `postgres://localhost:5432/dev`
does not trip it; precision and recall arms are pinned in the finding's integration test.

**Why MEDIUM, not HIGH, at HEAD.** The HIGH mirror-of-F020 framing — a false FAIL landing on the runs
the campaign tries first — described the scheme-only matcher, which is gone. The LIVE residual is (1) a
standing suite obligation (precision AND recall for every scanned column) and (2) two hard matchers that
still over-match on contrived-but-plausible benign text — `provider_key` (`/\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/`,
which fires on a branch name like `sk-antenna-refactor`) and `e2b_api_key_assignment`
(`/E2B_API_KEY\s*[=:]/`, which fires on `E2B_API_KEY: (unset)`). Both residual matchers are contrived
rather than observed on a real surface, and no gate certifies off this scanner in a way that would
weaponize the false-FAIL today; a standing-obligation-plus-contrived-over-match residual is MEDIUM. The
finding stays OPEN and `owned` by CLI-008 for the obligation, not for an outstanding repair. (This
severity field is the one the ownership guard reads; the AS-FILED "Severity" reasoning below, where it
appears, is kept verbatim.)

---

**What.** W21B widened `listRunSecretScanSurfaces` to scan five more caller-authored `task_outputs`
columns. One of them is `url`. Those columns feed `HARD_LEAK_MATCHERS`, whose `connection_string` arm
was copied verbatim from `redaction.ts` `SECRET_VALUE_PATTERNS[0]` and matched **any** URI of scheme
`postgres`/`mysql`/`mongodb`/`redis`/`amqp`/`kafka`/`nats`/`mssql`/`sqlserver`. An ordinary declared
dev service is a normal `workspaceRuntime.services[]` entry, and `emitRuntimeServiceTaskOutput` copies
`row.url` straight through (`task-output-emitters.ts:100`). So a run whose service URL is
`postgres://localhost:5432/dev` — loopback host, **no credential, no secret** — hard-failed clause 4
as a leaked connection string.

**This is the mirror of E7-F020: a false FAIL, not a false PROVEN**, and it lands on exactly the runs
the campaign will try first.

**Why the suite could not see it.** All five `[column]` arms plant a key and assert a HIT. They proved
**recall five times and precision zero times**. A scanner tested only for recall drifts into a denial
of service on its own users, and nobody notices until the campaign runs.

**Measured, not argued.** The precision arms were written first and run at `4c7327b33`:

```
× [precision] a legitimate `url` value on a bridge-projected row does NOT trip clause 4
    → AssertionError: expected [ 'connection_string' ] to deeply equal []
× [precision] a wholly legitimate runtime-service row leaves clause 4 clean
    → AssertionError: expected [ 'connection_string' ] to deeply equal []
✓ [precision] title  ✓ [precision] provider  ✓ [precision] externalId  ✓ [precision] healthStatus
```

**The fix, and why this shape.** What makes a connection string a secret is the **credential** in it,
not the scheme. `postgres://localhost:5432/dev` is a hostname and a port. The matcher is narrowed to
the two shapes that carry credential material:

- **(a)** URI userinfo with a **password** component — `scheme://user:pass@host`, including the
  password-only `scheme://:pass@host`. A bare `scheme://user@host` is deliberately **not** matched: a
  username alone is not a credential. (Pinned by a `[boundary]` arm so a reader knows it was chosen.)
- **(b)** a credential-bearing **query parameter** — `?password=` / `?token=` / `?api_key=` / … libpq
  and friends accept this form, so narrowing to (a) alone **would have lost a real leak**. This is the
  recall the narrowing deliberately keeps.

It no longer mirrors `redaction.ts`, and that divergence is the point: the redactor over-matches on
purpose because a redundant `***REDACTED***` costs nothing, whereas a **hard** matcher that
over-matches refuses a clean run — and a gate that fails runs which leaked nothing gets overridden and
then deleted. The verifier's own header already says this about the broad heuristic; the
connection-string arm had been exempted from its own rule.

**Not a suppression — proved in both directions.** `[credential]` arms for `user:pass@`, `:pass@` and
`?password=` red if the narrowing drifts further (mutation run: deleting the query-param alternative
**REDS** the `?password=` arm). The `[precision]` arms red if it widens back (observed RED at
`4c7327b33`). Post-fix the file is 20 `it()` blocks / 30 runtime cases, all green.

**Standing obligation.** The suite must from now on prove **precision AND recall for every scanned
column**. Adding a column with only a recall arm re-opens this class.

**Residual, stated and NOT fixed.** Two other hard matchers can over-match on benign text:
`provider_key` (`/\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/`) would fire on a branch name like
`sk-antenna-refactor`, and `e2b_api_key_assignment` (`/E2B_API_KEY\s*[=:]/`) fires on a documentation
mention such as `E2B_API_KEY: (unset)`. Both are contrived rather than observed on a real surface, and
re-deriving every matcher's error direction was outside this unit; recorded so the next scanner change
asks the question instead of rediscovering it.

---

## E7-F034 — `RealE2bTransport.signal` is a metadata READ that always reports `delivered: true`, so the cleanup ladder's `kill` rung is structurally unreachable in production — and every double that exercises that rung is more capable than the shipping transport

**Status:** open — **NARROWED 2026-09-09 by the SVC-008a implementation; read the narrowing at the end
of this entry before acting on anything above it.** · **Owner:** unowned (see reason)
**Severity:** MEDIUM
**Filed:** 2026-09-09, on the E9 branch `replatform/e9-f002-service-dispatch`, by re-verifying at source a
mechanism established during the SVC-008 revision-2 review. That review **correctly declined to file it
into E9's register** (`epics/E9-service-agents/tickets/SVC-008-design.md` §10) — it is not E9's defect —
but the decline left a **live defect affecting the shipping batch lane recorded only inside a design
document's §10**, where `scripts/check-finding-ownership.mjs` cannot see it (it globs only
`docs/replatform/epics/*/findings.md`). This entry closes that invisibility, and **corrects four details
of the referring account** (below).

**Why THIS register, and why it is not split.** The root cause is one function in
`packages/sandbox-e2b-provider` — E7's own package, whose conformance suite header calls itself
"CLI-001/D3". E7 carries **10** references to these symbols, against E0-foundation's 7 and
E6-deployment-test-harness's 3. E0 was rejected because it holds the **DE audit crossings**: this is not
a crossing and not a security control, so filing it there would classify by importance rather than by
jurisdiction. E6 was tempting — half the finding is a test-double defect and E6 owns the harness — but
the cause is production transport code, and the three doubles involved live in *three different
packages* (§2), so no harness register covers them either; splitting cause from symptom across E6/E7 is
exactly the split this finding must not make. **DE-10** (`E0-foundation/findings.md:243`, orphan sandbox
destruction disarmed) is adjacent but distinct: DE-10 is about the reaper being **disarmed**, this is
about a rung of the ladder the armed reaper runs being **inert**. They are not the same defect and
neither subsumes the other.

---

### Half 1 — the unreachable rung (production)

`RealE2bTransport.signal` (`packages/sandbox-e2b-provider/src/real-transport.ts:177-187`) takes a
`_kind: "cancel" | "kill"` **and never reads it**. Its whole body is one `getInfo` metadata read, and it
returns `{ delivered: true }` on **both** branches — including the `catch`, i.e. it reports delivery
even when the read it performed **threw**. It stops nothing; E2B has no in-sandbox graceful-stop
primitive distinct from teardown, which the function's own comment says.

`E2bSandboxProvider.cancel` (`e2b-provider.ts:378-381`) and `.kill` (`:383-386`) are both that same
read, mapped `delivered ? "stopped" : "ignored"`. Because `delivered` is a constant `true`,
**`outcome` is `"stopped"` unconditionally and `"ignored"` is not producible by the real provider.**

Two call sites branch on exactly that value:

- `CleanupAuthority.#convergeOne` (`packages/worker-daemon/src/supervisor/cleanup-authority.ts:279-292`)
  — `cancel` at `:279`, and the escalation block `if (cancel.outcome === "ignored")` at `:284-292`.
- its deliberate mirror in `perOpToInvokeDriver` (`sandbox-e2b-provider/src/per-op-adapter.ts:265-276`),
  `if (cancel.outcome === "ignored")` at `:267-270`.

Neither `if` can be true against real E2B. The `kill` rung has never executed in production and cannot.
Two further values are dead the same way: `per-op-adapter.ts:319` and `:365` compute
`faultInjected: stop.outcome === "ignored"`, which is permanently `false` on the real transport.

**★ What is NOT true, and the referring account overstates it.** Both call sites run a **forced
`destroy` unconditionally**, outside the `if` (`cleanup-authority.ts:293-307`;
`per-op-adapter.ts:271-275`), and `destroy` → `#reclaim` (`e2b-provider.ts:399-402`) is the first and
only real termination — `this.#transport.terminate` at `:401`, reached from `destroy` (`:388-390`) and
`reconcileCleanup` (`:392-394`). The supervisor's own cancel path also routes here
(`supervisor.ts:397` → `run.cleanup.converge`). **So no sandbox is leaked today and no paid resource is
orphaned by this defect.** The framing "an orphaned paid resource" does not survive reading the ten
lines after the `if`. What is lost is the **rung**, not the sandbox.

**The realized harm, stated exactly.**

1. **There is no graceful stop on the real provider at all.** `#convergeOne`'s comment (`:275`) says
   "Graceful cancel first"; in production every cancellation is a hard teardown with no drain or flush
   window. SVC-008 §3.4/T3 is about to build a `gracefulStopSeconds` supervisor on this primitive, and
   T3's own text records that a T3 written against `cancel`/`kill` "is green on the mock and meaningless
   on E2B".
2. **A false claim of effect, which the next caller inherits.** `cancel` returns `outcome: "stopped"` —
   an affirmative claim that the workload was stopped — from a function that only read metadata, *and
   from the catch branch where even that read failed*. Today both callers destroy afterwards so nothing
   acts on the lie; the contract is nonetheless unsound, and this is the programme's "a false claim of
   enforcement is worse than a missing check" class.
3. **The escalation metric is pinned to the lowest rung.** `cleanup_escalation{escalation_stage=…}`
   (`startup-reconcile.ts:444`, `supervisor.ts:399`) can only ever report `"cancel"` in production. It
   is *accurate* about the authority and *useless* as the operator signal it looks like: a real E2B
   sandbox that resists teardown is indistinguishable from one that stopped politely. The pinning tests
   assert `escalation_stage="destroy"` (`startup-sandbox-classification.test.ts:108`,
   `supervisor-cancel-escalation.test.ts:40`) — a value production cannot emit.

---

### Half 2 — the doubles are strictly more capable than production, so the suites cannot see Half 1

`MockE2bTransport.signal` (`sandbox-e2b-provider/src/mock-transport.ts:140-147`) **does** honour `kind`,
**does** return `{ delivered: false }` under the `ignoreCancel` / `ignoreKill` fault directives
(`:143-144`), and sets `record.state = "stopped"` (`:145`) — a state transition the real transport never
performs. It is not a faithful stand-in; it is a **more capable** one, in exactly the dimension under
test.

**★ COUNT — and the referring account is wrong about the mechanism in the majority of cases.** The claim
under test was "every ladder test passes against `MockE2bTransport`". Measured on this tree: **5 vitest
cases, in 4 files, against 3 distinct doubles — and only 1 of the 5 uses `MockE2bTransport`.**

| # | Test | Ladder site | Double that supplies `"ignored"` |
|---|---|---|---|
| 1 | `worker-daemon/src/__tests__/supervisor-cancel-escalation.test.ts` › "withdraws effect authority and escalates the whole process tree to destroy" | `CleanupAuthority.#convergeOne` | `worker-daemon/src/__tests__/support/fake-provider.ts:423-425, 440-442` |
| 2 | `worker-daemon/src/__tests__/startup-sandbox-classification.test.ts` › "kills the revoked-fence sandbox (converge escalates to a forced destroy), keeps the live one, records the unknown" | same | same (via `mixedProvider()`, `:45-48`) |
| 3 | `…startup-sandbox-classification.test.ts` › "is idempotent: a second pass finds the stale sandbox already gone — no double-kill" (first pass only) | same | same |
| 4 | `sandbox-e2b-provider/src/__tests__/conformance.test.ts` › "all eight isolation invariants pass" | `per-op-adapter.ts:265-276` | **`MockE2bTransport`** |
| 5 | `sandbox-provider-contract/src/__tests__/isolation-contract.test.ts` › "the hostile reference driver passes all eight isolation invariants" | same | `sandbox-fake-provider/src/hostile-driver.ts:257-262` |

Cases 4 and 5 reach the rung through the shared suite's `monotonic-cleanup-convergence` (§2.4,
`isolation-contract.ts:273`, faults at `:278`) and `bounded-lifecycle-faults` (§2.8, `:445`, faults at
`:480-481`).

**Not counted, deliberately, in both directions:**

- `isolation-contract.test.ts`'s two §2.4 non-vacuousness cases (`:119`, `:131`) re-enter the same check
  body against *sabotaged* drivers; whether the rung executes depends on the sabotage (a "never sweeps"
  driver fails sub-case (a) before escalating), so they are excluded rather than guessed at.
- `worker-daemon/src/__tests__/cleanup-expiry-escalation.test.ts` **looks** like a ladder test and is
  not one: its three cases call `escalate()` directly (`:34-62`) and never enter `#convergeOne`. They
  test the stage machine, are unaffected by this defect, and remain sound. Counting them would have
  inflated the number to 8.

**★ "Every ladder test is vacuous" is too strong, and the precise version is more useful.** Cases 1-3
never touch E2B code at all — they are *correct* unit tests of `CleanupAuthority`, whose only fault is
that production never supplies their precondition. The overstated claim belongs to **case 4 alone**:
`conformance.test.ts`'s header calls itself "the no-key core's central proof" that the driver's
"monotonic convergence" is validated, and for the escalation rung specifically it validates
`MockE2bTransport`'s behaviour, not `RealE2bTransport`'s. **One suite makes a claim about the shipping
driver that its double cannot support.** That is the defect; the other four are collateral.

---

### Severity — MEDIUM, argued

**Not HIGH/P1.** No security control false-PASSes. Nothing is leaked: the unconditional `destroy` after
both `if`s reclaims the sandbox regardless. No gate, admission verifier or `capabilityProven` clause
reads `StopOutcome`, so no `check-gate-clause-wiring.mjs` clause is affected and no run is falsely
certified. A HIGH here would be filed on the *shape* of the defect (an unreachable branch, a
more-capable double — both shapes this programme has learned to fear) rather than on its measured
consequence, and the register already carries the cost of that.

**Not LOW/MINOR.** Three things are actually wrong today, not hypothetically: a graceful-stop stage that
does not exist on the shipping path; an operator metric that cannot distinguish a resisting sandbox from
a compliant one; and a conformance suite whose stated proof about the E2B driver exceeds what its double
can establish. And the latent half is about to become load-bearing — SVC-008 plans a `gracefulStopSeconds`
supervisor directly on this primitive, and its §6/T3 already records that building it on `cancel`/`kill`
yields a test that is "green on the mock and meaningless on E2B".

**MEDIUM** is therefore the honest rung: an inert escalation stage plus a suite that cannot see it,
with no realized leak, no false admission, and a named consumer that will make it worse if unfixed.

### Owner — `unowned`, with the reason on the record

No ticket owns `real-transport.ts`'s signal semantics. CLI-008 owns the neighbouring verifier findings
(E7-F030/F031/F032/F033) but is the capability-scoping/verifier lane, not the transport lane; declaring
it owner here would be the **false claim of ownership** `scripts/lib/finding-ownership.mjs` exists to
prevent. E9/SVC-008 is a **consumer** and explicitly refused jurisdiction. It is filed `unowned` so it is
refusable rather than lost, and it is blocked on someone taking the `packages/sandbox-e2b-provider`
transport lane.

### ★ AMENDMENT (2026-09-09) — the fix is now specified as a ticket, and it splits in two

**[SVC-008a](../E9-service-agents/tickets/SVC-008a-design.md)** turns SVC-008 §3.4 into a standalone
design and is **the specified resolution of this finding**. It records two things this entry did not:

1. **★ THE ROOT CAUSE IS THE TYPE, NOT THE FUNCTION.** `StopOutcome` (`worker-daemon/src/supervisor/provider.ts:146`)
   is `"stopped" | "ignored"` and has **no inhabitant for "I witnessed nothing"**, so an implementation
   that cannot observe anything is *forced* to pick an affirmative claim. The `catch { return
   { delivered: true } }` is what the type left available. SVC-008a §2.2 makes the honest value
   representable (`ProcessObservation`'s `"unknown"` with a `reason`) and deletes the word "stopped"
   from the new signal result entirely.
2. **★ THE HONEST ANSWER IS ALREADY FETCHED AND DISCARDED.** `signal`'s `getInfo` returns an
   `E2bSandboxRecord` whose `state` is `"running" | "paused" | "stopped"` (`transport.ts:20`, `:25-29`);
   the function throws it away. So the repair of **Half 1 costs zero additional provider calls and
   needs no new SDK capability** — it is a verdict-derivation change on a read that already happens
   (SVC-008a §4.2 Half A). Only the *process-handle* half (`startProcess`/`processStatus`/`signalProcess`)
   depends on the unverified E2B SDK question, and SVC-008a §9.1 keeps that question open rather than
   assuming it.
3. **★★★ THE ROOT CAUSE IS WIDER THAN THIS ENTRY MEASURED — added 2026-09-09 after review of
   SVC-008a.** Point 2 above is true but incomplete, and the gap is load-bearing: **the record it
   calls the honest answer is itself minted by a parser that defaults to the affirmative-stop
   value.** `mapState` (`real-transport.ts:61-66`) is `if includes("run") … if includes("paus") …
   return "stopped"`, and `toRecord:73` feeds it `info?.state ?? info?.status` — so an **absent,
   renamed or unrecognized** state field (`undefined` → `""`) yields `state: "stopped"`, and
   `E2bRecordState` (`transport.ts:20`) has **no inhabitant for "I could not classify this either"**.
   A repair that merely stops discarding the record therefore still returns an affirmative stop from
   a read that witnessed nothing about the state — **this finding, reconstructed inside its own
   fix.** SVC-008a §4.2 A-i now widens `E2bRecordState` with `"unknown"` and makes recognition
   explicit **before** deriving any verdict, §4.6 re-walks every value the design specifies against
   the same question (finding two more: an empty-string process handle, and a `gone` observation
   sourced from `isRunning`'s `catch { return false }`, `:263-268`), and T8 gains a clause driving
   four unclassifiable `getInfo` payloads. ★ **A second, live consequence in the opposite direction,
   recorded here because it is the same parser:** `list` projects `hasLiveLease: record.state ===
   "running"` (`e2b-provider.ts:425`) and `reconcile.ts:73`'s `defaultIsOrphan` is `!hasLiveLease`,
   so a **running** sandbox whose state field this parser does not recognize is classified an orphan
   and **torn down**. That half is carried as SVC-008a §9.4 with a mandatory non-destructive interim
   rule; it is not separately filed, because it is this function and this class.

**Two consequences worth recording here.** (i) `CleanupAuthority` cannot use a process-scoped signal:
it converges sandboxes discovered by reconcile/list, for which **no process handle exists** — so the
fix for the ladder is Half A, not the new trio. (ii) After Half A, `cleanup_escalation{escalation_stage}`
reports `"destroy"` on every real-E2B converge instead of `"cancel"`. **That is the metric becoming
true**: no assertion in the tree expects `"cancel"` (a grep over both test packages returns seven
`escalation_stage`/`escalationStage` assertions, all `"kill"`/`"destroy"`/`"none"`), and the two
production pins already assert `"destroy"`.

**Status and owner are UNCHANGED, deliberately.** It stays `open` because a design is not a fix, and
it stays `unowned` because the id `SVC-008a` **cannot be declared**: `findTicketIds`
(`scripts/check-finding-ownership.mjs:40-54`) extracts ticket ids with `/^([A-Z]+-\d+)/`, so
`SVC-008a-design.md` resolves to **`SVC-008`** — and SVC-008 is the ticket that explicitly refused
jurisdiction over this defect (`SVC-008-design.md` §10, §9.5 ii). Declaring it would be the false
claim of ownership `scripts/lib/finding-ownership.mjs` exists to prevent; declaring `SVC-008a` would
red `owner_ticket_missing`. The pointer is therefore **prose**, here and in the manifest reason. Same
shape as `REL-FOUNDATION-GATE`.

### Resolution test — T8, already specified

`SVC-008-design.md` §6 **T8** is the resolution test and it is already written down: a **transport-level**
conformance test asserting, for **every** `E2bTransport` implementation in the tree (by directory walk,
*not* a hand-listed pair), that a signal refusal is representable — a target configured to ignore the
signal must still report the process running on the follow-up status read. It runs against
`MockE2bTransport` **and** against `RealE2bTransport` in the keyed lane, and **the real arm must report
SKIPPED, never passed, when `E2B_API_KEY` is absent** — a keyless "green" on the arm whose entire purpose
is to disagree with the double would be this same failure class one level up. T8 is red today *because*
the two arms disagree, and that disagreement is this finding.

**★ SVC-008a §5 strengthens T8 in two ways, and the first is load-bearing.** As written above, T8
asserts only that a *refusal* is representable — **a transport hardcoded to "still running" passes it
and asserts nothing**, which is the same inversion that let `delivered: true` pass every ladder test.
SVC-008a §5 clause 4 adds a **positive control** (a target that genuinely stops must report stopped)
and clause 5 asserts the **`unknown` case is representable** on every implementation, so the honest
value cannot be decorative. Clause 2 adds anti-vacuity on the directory walk itself.

**Resolve = give the real transport a signal primitive whose refusal is representable (SVC-008 §3.4
proposes `signalProcess`/`processStatus`), land T8 as a directory walk over transport implementers, then
flip this Status and DELETE the `finding-ownership.json` key in the SAME commit.** Fixing the transport
without T8 leaves the doubles more capable than production and re-opens the class.

### Citation corrections to the referring account (SVC-008 §10 / §1.3d)

Recorded because this register cites by line and a wrong pin is worse than none.

1. `RealE2bTransport.signal` spans **`:177-187`**, not `:177-186` (`:187` closes the method).
2. `E2bSandboxProvider.cancel` is **`:378-381`** and `.kill` **`:383-386`**; `378-386` is the pair's
   span, not either method's.
3. The first real termination is **`#reclaim`'s `this.#transport.terminate` at `:401`**, reached *from*
   `destroy` (`:388-390`) and `reconcileCleanup` (`:392-394`) — not "inside `destroy` (`:388-393`)",
   which spans two methods and contains no `terminate` call.
4. `#convergeOne`'s escalation branch is **`:284-292`**; `:279` is the `cancel` call and `:279-290`
   truncates the block mid-statement.

**Cross-links:** **SVC-008a** (`epics/E9-service-agents/tickets/SVC-008a-design.md` §1.2, §2.2, §4.2,
§5, §6) — **the specified fix**: the port design, the two-half split, and the strengthened T8.
SVC-008 (`epics/E9-service-agents/tickets/SVC-008-design.md` §1.3d, §3.4, §6 T3+T8,
§10) — the consumer that will build on this primitive and the source of T8. **DE-10**
(`E0-foundation/findings.md:243`) — adjacent, not overlapping: DE-10 is a *disarmed* reaper, this is an
*inert rung* inside the armed one. **E7-F020/F030/F031** — the false-PROVEN family; this is deliberately
*not* one of them (nothing is certified that is untrue about a run), which is the argument for MEDIUM.

<a id="e7-f034-narrowing"></a>

### ★★★ NARROWING (2026-09-09) — what the SVC-008a implementation actually repaired, and what it did not

**Status stays `open`. Owner stays `unowned`.** What follows is a narrowing, not a closure, and the
reason is in the last block. Every claim below cites a test that runs in the NO-KEY core.

**Half 1 — the unreachable rung. REPAIRED and PINNED.**

- `RealE2bTransport.signal` no longer discards the record it fetched. `E2bSignalResult` is now
  `{observed: "stopped" | "still_running" | "unknown"}` (`packages/sandbox-e2b-provider/src/transport.ts`),
  and the catch branch returns `{observed: "unknown"}` — not an affirmative.
  Pinned: `packages/sandbox-e2b-provider/src/__tests__/svc-008a-witnessed-stop.test.ts:68`
  ("★ a getInfo that THROWS yields 'ignored' — the finding in one line").
- `E2bSandboxProvider.cancel`/`.kill` map `observed === "stopped" ? "stopped" : "ignored"`, so
  `"ignored"` is now producible by the real provider.
- **The `kill` rung EXECUTES.** `CleanupAuthority.converge` over the shipped provider over the shipped
  transport runs `cancel -> kill -> destroy` and `escalationStage()` reaches `"destroy"`.
  Pinned: `packages/sandbox-e2b-provider/src/__tests__/svc-008a-escalation-reachability.test.ts:108`.
  The two production-metric pins that asserted `escalation_stage="destroy"` — a value production could
  not emit — are now TRUE rather than aspirational
  (`worker-daemon/src/__tests__/startup-sandbox-classification.test.ts:108`,
  `supervisor-cancel-escalation.test.ts:40`; both were re-run green and neither needed re-pointing).
- **The wider root cause of amendment point 3 is repaired too.** `mapState` matches every recognized
  state POSITIVELY and returns `"unknown"` otherwise; `E2bRecordState` gained that inhabitant.
  Pinned against all four unclassifiable payloads, asserting the NEGATIVE explicitly:
  `svc-008a-witnessed-stop.test.ts:115 (the four-payload loop, inside the describe at :101)`. The `hasLiveLease` half is carried at
  `e2b-provider.ts` under the SVC-008a §9.4 interim rule (non-destructive), pinned at
  `svc-008a-witnessed-stop.test.ts:145`.

**Half 2 — the doubles were more capable than production. REPAIRED and PINNED.**

- `MockE2bTransport` gained the two arms no double in this tree could previously produce: a read that
  THREW (`__aoa_fault_read_fails`) and a record whose state is unclassifiable
  (`__aoa_fault_state_unknown`). The worker-daemon support double gained scriptable process
  supervision whose ACCEPTANCE is independent of its EFFECT.
- T8 is landed as a DIRECTORY WALK with anti-vacuity, a positive control, the unknown case, the four
  unclassifiable payloads, the unsupported-mode throw, the empty-handle clause, and the
  `gone`-requires-an-answer clause: `packages/provider-wire/src/__tests__/svc-008a-t8-process-conformance.test.ts`.
- ★ **Clause 11 is the one that pins THIS finding's shape**
  (`svc-008a-t8-process-conformance.test.ts:340`): no arm may claim a graceful process cancel the
  shipping transport lacks. On the pre-fix tree the mock stopped the process and the real transport
  reported a stop it never performed; that disagreement was the finding, and the clause is asserted of
  both arms so it is a red rather than a review note.

**★ WHY IT STAYS OPEN, stated so it is refusable rather than lost.**

1. **This entry's own stated resolution names the keyed arm**, and that arm has never been RUN. T8's
   real-account arm is `it.skipIf`-gated on `E2B_API_KEY` and reports SKIPPED, never passed
   (`svc-008a-t8-process-conformance.test.ts`, clause 10). The no-key real arm exercises the SHIPPING
   `real-transport.ts` with only the `e2b` SDK boundary injected. It proves nothing about what the live
   service returns.

   **★★★ AND THE CLAIM THAT USED TO STAND HERE WAS FALSE, so it is corrected rather than softened.**
   This sentence read *"it proves this file cannot manufacture an affirmative from nothing"*. It could
   not: at the moment it was written, `RealE2bTransport.processStatus` returned the affirmative
   `{state: "gone"}` — `deriveStopVerdict -> "stopped"`, the TERMINATING verdict — whenever
   `commands.list()` resolved a non-empty ARRAY whose entries carried no readable numeric `pid`.
   Measured on the shipped code with `[{processId: 4242}]` (an SDK field rename, the realistic
   producer), `[{}]`, `["4242"]`, `[{pid: "4242"}]` and `[null]`. It was self-inconsistent inside its
   own function — a NON-array payload already answered `unknown/state_unrecognized` — and it was
   E7-F034's own class rebuilt one method away from the repair for it. The suite as landed drove none
   of those shapes, so the claim was not merely optimistic: **no test could have refuted it.**
   Repaired, and T8 clause 12 now asserts the negative for all five entry shapes plus the mixed-list
   case, on the REAL arm explicitly — the mock keeps a typed in-memory store and cannot produce the
   condition at all, so folding it into the shared `describe.each` would have been a clause that passes
   by never firing.

   What the no-key real arm proves is bounded and now stated that way: **for the response shapes the
   suite actually drives**, this file's parsing and verdict derivation return an honest `unknown`
   rather than an affirmative. That is a claim about coverage, not about the file. Flipping Status on a
   skipped arm would be this programme's defining failure class.
2. **The SDK caveat is unchanged and is NOT upgraded.** The new
   `startProcess`/`processStatus`/`signalProcess` binding is written against the `e2b@2.30.5` TYPE
   DECLARATIONS (`Commands.run(cmd, {background: true}) -> CommandHandle{pid}`, `Commands.list() ->
   ProcessInfo[]`, `Commands.kill(pid) -> boolean`, documented SIGKILL-only). That is a CODE READING,
   not a provider measurement. It answers SVC-008a §9.1's STRUCTURAL half — a detached launch with a
   handle IS expressible, and so is a forced kill — and leaves its BEHAVIOURAL half open.
3. **Owner is unchanged for the unchanged reason**: `findTicketIds` resolves `SVC-008a-design.md` to
   the ticket id `SVC-008`, which explicitly refused jurisdiction. The pointer stays prose.

**What a closer must do:** run T8's keyed arm once against a real E2B account (Linux CI with a key, or
Windows with `AOA_RUN_WIN_INTEGRATION=1`), record the run id here, then flip Status and delete the
`finding-ownership.json` key in the same commit.

## E7-F035 — the W7U1 output-probe apparatus is now premised on a REFUTED question (the permission posture shipped 2026-09-11) and must be retired or reworked

**Status:** open · **Owner:** unowned (see reason)
**Severity:** MEDIUM
**Filed:** 2026-09-11, on branch `f021-f027-sandbox-posture`, by the F021/F027 posture PR.

**The refutation.** The W7U1 output-probe pack exists to answer a single differential question: *does the
distributed sandbox invocation carry a permission posture, and if not, does adding one change whether the
agent writes a file?* Its A1 arm was **production-bare**; its A2 arm was **production +
`withPermissionPosture`**. The F021/F027 posture PR (founder-authorized 2026-09-11, this branch) ships the
posture INTO production: `buildSandboxInvocation` (`server/src/services/task-run-sandbox-invocation.ts`)
now emits `--dangerously-skip-permissions` (claude, both branches) and `--skip-git-repo-check
--dangerously-bypass-approvals-and-sandbox` (codex, both branches). That answers W7U1's chartering
question at the source, and it makes the A2 transform **self-contradictory**: `withPermissionPosture`
asserts it THROWS on already-postured input (`w7u1-agent-output-probe.test.mjs` → "A2 REFUSES … an
already-postured script must refuse — the premise has collapsed and that is the finding"), so A2 can no
longer be run against the shipped literals at all. This is a genuine obsolescence, not a constants swap.

**What this PR already did (the honest guards).** In `scripts/lib/__tests__/w7u1-agent-output-probe.test.mjs`:
the former premise test ("NONE of the four production literals carries a posture") is INVERTED to a
positive assertion that the posture is now PRESENT on all four literals, with a dated refutation note; and
the "production literals still match the A2-transform shapes" test is RETIRED VISIBLY (`test.skip`, dated
retirement note) because the A2 differential is obsoleted by the shipped posture. The live red-when-removed
guard for the posture itself now lives in `server/src/__tests__/task-run-batch-workload.test.ts` (exact-
script assertions + posture cases). The A2-transform UNIT tests (which operate on local bare fixtures, not
the production module) are untouched — they document the transform's historical contract and still pass.

**The debt this finding TRACKS (not touched by this PR).** The rest of the apparatus is still premised on
the refuted question and must be retired or reworked in a follow-up:
- `scripts/lib/w7u1-agent-output-probe.mjs` — the `withPermissionPosture` A2 transform and its supporting
  A1/A2 differential machinery.
- `.github/workflows/keyed-e2b-w7u1-output-probe.yml` — the keyed probe lane, plus its wiring in `pr.yml`.
- `docs/replatform/epics/E7-coding-e2b/W7U1-output-probe-runbook.md` and `…/W7U1-output-probe-result.md`.
- `test-execution-census.json` / `workflow-verdict-manifest.json` entries that register the probe lane.
- Cross-linked **E7-F028** dependency (the probe's codex verdict over-claims its cause) — its rework is
  entangled with the same retirement.

**Why unowned.** Retiring/reworking a keyed CI lane, a runbook, a result doc, and two manifests is not a
code unit any live E7 ticket carries — CLI-008 owns the posture literals (now shipped) but not the probe
apparatus, and pointing this at CLI-008 would be E7-F018's false-ownership shape (CLI-008 could close in
full and this would not move). Recorded unowned so the next Track A / E7 pass reads it before quoting a
W7U1 lane result. If a parallel branch files the same apparatus-retirement debt under a different id,
first-filed keeps the id.

**What a closer must do:** delete or rework the debt enumerated above (retire the keyed lane + its pr.yml
wiring, the runbook, the result doc, and the manifest entries; either delete `withPermissionPosture` or
re-charter it), then flip Status and delete the `finding-ownership.json` key in the same commit.

## E7-F036 — the distributed terminal projection stamps the run's status but never its `finished_at`, so a fully-successful distributed run is not durably terminal (verifier clause 3)

**Status:** resolved · **Owner:** CLI-006 (D5 projector) · **Severity:** MEDIUM
**Filed + Resolved:** 2026-09-18 (PR #472, merge `cbb496fe7`; design `tickets/E7-F036-projector-finished-at-design.md`).
Found by the E7-1 verifier the moment E7-F011 let a distributed run reach a terminal status for the first time.

**What.** `setRunStatus` (`server/src/services/heartbeat.ts`) writes `.set({ status, ...patch })` and **never
derives `finished_at`** — every terminal caller passes it explicitly (reap, normal completion, failure,
cancel, watchdog). The CLI-006 canary run projector (`server/src/services/canary-run-projector.ts`
`projectTerminal`) was the **one** terminal `setRunStatus` caller whose patch (`{ error, usageJson }`)
omitted it. So a fully-successful distributed run landed `status=succeeded, finished_at=NULL`, and
evidence-verifier A clause 3 (`isTerminalRunStatus(status) && finishedAt !== null`,
`server/src/services/e7-distributed-run-verifier.ts`) FAILED — the run was terminal-status-only, not
*durably* terminal. Previously unreachable: no distributed run had ever reached a terminal status before
E7-F011 ([[E7-F011]]).

**The fix.** Carry `finishedAt` on the folded evidence — `foldAttemptEvidence`
(`server/src/services/canary-terminal-projection.ts`) returns `finishedAt: input.now` (`now`, not the
terminal row's `occurredAt`: the wall-clock `durationMs` fallback already measures against `now`, so
`finished_at − started_at` stays consistent with the reported duration) — and the projector includes
`finishedAt: evidence.finishedAt` in the `setRunStatus` patch, through the same shared terminal latch
(Invariant 8 preserved; no second write path). `resolveTerminalLatchFallback` is **untouched**: its existing
tests confirm the cross-terminal case (a cancel that already won the latch) still DROPS `finished_at` via
`NON_CONTRADICTORY_TERMINAL_METADATA_KEYS`, so a cancel's `finished_at` is preserved; a same-status
redelivery refreshes it with the rest of the metadata bundle, exactly like the legacy cancel-race write.

**Proven.** Two unit tests, both positive-controlled (each goes red when its fix line is removed):
`cli-006-canary-run-projector.test.ts` (terminal patch carries `finishedAt`) and
`cli-006-projector-wiring.test.ts` (`foldAttemptEvidence` stamps `now`, incl. empty-rows path). **Live:** the
E7-1 canary run `8dc34e90` (2026-09-18, Hetzner staging) landed `finished_at=2026-09-17T21:25:09.877Z` and
`verify-e7-1-distributed-run 8dc34e90` returned `RESULT: PASS (mechanism)`, `ok=true`, EXIT 0.

**Scope note.** This closes the last MECHANISM clause; it does NOT move `capabilityProven` (false by design —
E7-D-CAPABILITY-DISCLOSURE; output capture is CLI-008 Unit F, unbuilt) and does NOT flip the
`E7-1-coding-journey` register clause (which measures a shipped CI boot, not a manual staging run).
