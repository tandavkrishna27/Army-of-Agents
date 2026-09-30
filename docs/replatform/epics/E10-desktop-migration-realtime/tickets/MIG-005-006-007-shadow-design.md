# MIG-005 / 006 / 007 — SHADOW ONLY · design

**Terrain** [`MIG-005-006-007-shadow-terrain.md`](./MIG-005-006-007-shadow-terrain.md) ·
**Branch** `docs/replatform-program` (PR #323) · **Wave 3 item 4** ·
**Predecessor** [`REL-004-lane-D-result.md`](../../E11-hardening-release/tickets/REL-004-lane-D-result.md).

Terrain established that the artifact the handoff names — `job-shadow-comparator.ts` — has a
**structurally zero divergence rate** in its production wiring (measured: 2,000 randomized
snapshots, 0 divergences). Wiring three more sinks into it would manufacture the exact evidence
gate clause 2 opens on, and that evidence would be worthless.

This design does not repair the field-diff. It **replaces what is compared.**

---

## 1. The decision: field equality is the wrong comparison; admissibility is the right one

The comparator diffs six fields between the legacy snapshot and a "distributed intent". Ask what
an *honest* independent derivation of each field would be, and the answer collapses:

| Field | Second authority | Verdict |
|---|---|---|
| `policy.effectiveCompletionPolicy` | `resolveAgentCompletionPolicy` | **Same resolver both sides.** Equality is structural. Uncomparable. |
| `policy.model` | ~~run-scoped model resolution — same resolver~~ **none at all** (revision 2, §9 R2) | The distributed side has **no** model authority: `model` appears nowhere in `job-submission.ts` or `job-placement.ts`; the model is embedded in the caller-built command. Uncomparable. |
| `policy.budgetPolicyId` | `budget_policies` | Same store. Uncomparable. |
| `provenance.executionPrincipalKind` | `taskSourceIsAdmitted` (`job-submission.ts:157`) | The distributed side can **refuse**. Not a field mismatch — a *denial*. |
| `provenance.credentialKind` | — | Inherited deferral #1: no credential exists to compare. |
| `routing.executionTargetType` | the placement registry target, via `normalizeSubmittedJobPlacementFacts` + `decideJobPlacement` candidate matching | The distributed side can find **no placeable target**. Again a denial, not a mismatch. |

Four of six fields have no second authority at all. The two that do express their disagreement
not as a different value but as **a refusal to run the thing**.

So the informative question a shadow pass can answer is not *"do the two sides agree on the
model string"*. It is:

> **Would the distributed platform have accepted this Commander turn / crew run / one-shot
> operation at all — and if not, why?**

That question has genuinely independent authorities that genuinely return no:

- **Admission** — `repos.jobControl.admission(...)` + the per-kind source checks in
  `submitJobWithinTenant` (`:141-165`): does the Organization exist, is the Company in it, is the
  principal authorized, is the requester kind permitted for this source kind.
- **Placement** — `decideJobPlacement` (`job-placement.ts:572`): is there an active, enrolled,
  non-revoked worker whose profile hash, device generation, provider constraints, capabilities,
  locality and capacity satisfy the job's requirements.

Both can say no for reasons that are precisely what Wave 4 needs to know in advance. Both are
**pure or read-only**. Neither is reachable today: `compare(..., { admissible })` has **zero**
callers that supply it, so the slot has always been `null`.

> **REVISION 2 — the three sinks do NOT have equal signal (§9 R1).** The first draft of this
> section implied source-level admission can refuse for all three. It cannot. In
> `submitJobWithinTenant`: `commander_turn` runs `commanderSourceIsAdmitted` (`:180`) and
> `crew_run` runs `internalRunSourceIsAdmitted` (`:188`) — both real DB authorities that return
> null and deny. **`one_shot` does not** — it assigns a constant
> `executionPrincipal = { kind: "worker", id: source.operationId }` (`:195-199`) with no lookup,
> so it can never refuse. For MIG-007 the only denial surfaces are the generic `admission()`
> (Organization exists / Company in Organization / principal authorized / requester kind) and
> placement. **This must be stated per sink in the evidence**, or "0 divergences across three
> sinks" reproduces the same tautology one level down — which is exactly the defect this ticket
> exists to fix.

**Decision D1.** The shadow record's headline becomes an **admissibility verdict** per sink, not
a field-equality boolean. Field capture stays — as *captured provenance*, explicitly marked
uncompared — because the record is still the only place the legacy intent is written down.

## 2. The honesty rule that makes the rest safe

**Decision D2. An uncompared field is recorded as uncompared. Never as matching.**

This is the single change that kills the tautology, and it must land before any sink is wired.
Today `match: true` means "nothing disagreed", which is indistinguishable from "nothing was
checked". The record grows an explicit accounting:

```ts
readonly comparedFields: string[];    // fields with a genuine second authority
readonly uncomparedFields: string[];  // fields captured but not checked, with a reason
readonly mismatchedFields: string[];  // ⊆ comparedFields
```

and `match` becomes `"agree" | "diverge" | "not_compared"` — a three-state, so a run in which
nothing could be compared cannot be counted in the agreement column. `comparedFields` is the
**denominator** for gate clause 2. With no independent derivation supplied, every field lands in
`uncomparedFields` and the verdict is `not_compared` — the honest description of what ships
today, and a rate of `0/0` rather than a rate of `0/N`.

**Rejected:** keeping `match: boolean` and documenting the caveat in the result doc. A boolean
that reads as agreement is read as agreement; the caveat does not travel with the log line into
the evidence rollup. This programme has been bitten by exactly that (`checks-that-nothing-runs`).

## 3. Expressing all four sinks without fabrication

**Decision D3.** `LegacyRunExecutionSnapshot`'s identity half becomes the `SubmitJobSource` union
(`packages/shared/src/types/job-control.ts`), which already carries all six variants. `runId` /
`issueId` / `assigneeAgentId` stop being required top-level fields and live inside the `task_run`
variant where they belong.

`compare()` stops hardcoding `kind: "task_run"` and echoes the supplied source. No fabrication:
`packages/worker-protocol/src/source.ts` is FROZEN and every variant is `.strict()`, so a
fabricated `runId` on a `commander_turn` is refused at the schema boundary — the design does not
need to police what the schema already refuses, but the wiring must never try.

The `organizationId` / `companyId` / `workloadType` half is unchanged — every sink has those.

## 4. Effect-freeness: keep it structural

The comparator's strongest property is that it **holds no `Db` handle, so it cannot write**
(`job-shadow-comparator.ts:9`). An admissibility probe needs reads. Two ways to get them:

- **(a) give the comparator a read-only port.** Effect-freeness becomes an argued property of
  the port's method list rather than an absence. One added method later and the guarantee is
  gone silently.
- **(b) resolve at the seam, pass the verdict in.** The seams (`heartbeat.ts`, `cli-mode.ts`,
  `runner.ts`, `one-shot-sandbox-cli.ts`) already hold a `Db`. They compute the admissibility
  verdict and hand the comparator a finished value.

**Decision D4: (b).** The comparator stays a pure diff/record function with no handle — the
structural guarantee survives untouched — and the probe lives where a `Db` is already legitimate.
This also matches the existing shape: `admissible` is already an *input* to `compare`, not
something it computes.

**Decision D5.** The probe is a single shared function, `probeDistributedAdmissibility`, not four
copies. It is best-effort: any throw yields `{ admissible: null, reason: "probe_error" }` and is
recorded, never propagated. A shadow probe must never fail a live Commander turn.

**Decision D5a (revision 2, §9 R3) — read-only is enforced by PostgreSQL, not by a test.** The
probe runs inside a new `runInTenantReadOnly` sibling of `runInTenant` (`db/tenant-context.ts:46`)
which issues `SET TRANSACTION READ ONLY` immediately after opening. Any write the probe attempts —
now or after a future edit — raises `25006 read_only_sql_transaction` instead of succeeding
quietly. The original acceptance clause (snapshot three tables' row counts across a probe) could
not see a write to a fourth table; this can. No such facility exists today — `READ ONLY` appears
nowhere in `server/src/db/` — so it is built here.

**Decision D5b (revision 2, §9 R4) — the probe is bounded, and a timeout is data.** These are
live user-visible paths; a Commander turn must not wait on candidate enumeration. Admission is a
small indexed lookup and runs per operation. Placement enumerates worker candidates and runs per
operation **behind a hard deadline**, recording `probe_timeout` as its own outcome rather than as
an error or as agreement. A bound that silently degrades to "looks fine" is the failure class
this ticket is about.

## 5. The rollout key — state the limit, do not widen it

Terrain §4: all four sinks are `workloadType: "batch"`, so one rollout switch arms them all.
Benign for shadow. **Not** benign for Wave 4, whose §5 ordering (MIG-005 → 006 → 007, "lowest
blast radius first") is not expressible today.

**Decision D6.** Do not add a per-sink axis here, and specifically do not pass a finer string as
`workloadType` — placement resolves the same policy with the job's real frozen `workloadType`, so
a shadow gated on a key active cannot use would prove nothing about active. The limit is
**stated** in the result doc and raised as a Wave-4 prerequisite owned by JOB-007 / MIG-002.

## 6. Lanes

| Lane | Content | Depends on |
|---|---|---|
| **A** | D2 (three-state + compared/uncompared accounting) + D3 (source union). Pure; unit + mutation. | — |
| **B** | D5 `probeDistributedAdmissibility` — admission + placement, read-only, best-effort. | A |
| **C** | Wire the three seams: MIG-007 (`runOneShotCliInSandbox`, covers all three operation kinds), MIG-005 (`cli-mode.ts`), MIG-006 (`runAoaAgent`). Plus the existing heartbeat seam migrated to the new shape. | A, B |
| **D** | Evidence: run the sinks under `shadow` on the D1 two-replica lane, state the divergence rate **with its denominator**, explain every divergence. | C |

Lane A is the correctness core: until an uncompared field stops reading as agreement, every
downstream number is false. It lands first and alone.

## 7. Acceptance → named executable artifact

| # | Invariant | Artifact |
|---|---|---|
| S1 | The production wiring (no independent derivation supplied) reports `not_compared`, never `agree` | `job-shadow-comparator.test.ts` — the 2,000-snapshot probe from terrain, inverted into a permanent assertion |
| S2 | `comparedFields` and `uncomparedFields` partition the six fields; `mismatchedFields ⊆ comparedFields` | same file, property test |
| S3 | All six source kinds round-trip through `compare` with their own identity fields | same file, table over `EXECUTION_SOURCE_KINDS` |
| S4 | No fabricated `runId`/`issueId` on a non-task variant survives | contract test against the FROZEN `.strict()` variants |
| S5 | The comparator holds no `Db` handle | structural: `createJobShadowComparator`'s deps type; an anti-regression test asserting the dep keys |
| S6 | A throwing admissibility probe never propagates into the caller | `mig-shadow-probe.test.ts` |
| S7 | The probe performs no write | **revision 2:** `runInTenantReadOnly` issues `SET TRANSACTION READ ONLY`; integration test on embedded PostgreSQL asserts an attempted write inside the probe's transaction raises `25006`. Row-counting a chosen few tables is not proof — it cannot see a write to a table it did not count. |
| S11 | The per-sink admissibility signal is reported per sink, and MIG-007's weaker signal is named | evidence table in the result doc + a test pinning that `one_shot` has no source-level admission authority, so a future addition is a deliberate change |
| S12 | A placement probe that exceeds its deadline records `probe_timeout`, never `agree` | probe test with an injected clock |
| S8 | Each of the three seams emits exactly one record per operation, and zero when rollout ≠ shadow | per-seam tests |
| S9 | A denied admission is recorded as a **divergence with a reason**, not as an error | probe test |
| S10 | Rollout key limit (D6) is stated, not silently widened | result doc + a test pinning `HEARTBEAT_TASK_RUN_WORKLOAD_TYPE`-equivalent constants to `"batch"` for all four sinks |

Every guard mutation-tested per §1.8 of the handoff.

## 8. What this design deliberately does not do

1. **It does not make field equality informative.** Four of six fields have one authority; no
   amount of wiring creates a second. They are captured and marked uncompared.
2. **It does not resolve inherited deferral #1** (a worker receives no provider credential).
   Shadow does not need one. It stays a stated blocker for MIG-005/006/007 **active**.
3. **It does not add a per-sink rollout axis** (D6).
4. **It does not touch `packages/worker-protocol/`** — FROZEN, source SHA
   `b7a842870ce7509d8baa75409e0ab19da375c88a`.
5. **It does not claim "real traffic" means production users.** For a pre-release programme the
   traffic source is the D1 two-replica lane's journey. Lane D states the source and the
   denominator rather than implying organic volume.

---

## 9. Plan review (step 4) — findings against revision 1

Reviewed by attacking the design, not re-reading it. Four findings; the design above is
revision 2 and carries the corrections inline so the reasoning stays visible.

**R1 — HIGH. D1 was overstated: `one_shot` admission cannot refuse.** Revision 1 said both
authorities "can genuinely say no", implying parity across the three sinks. Verified against
`job-submission.ts`: `commander_turn` and `crew_run` each run a real DB admission check that can
deny, but `one_shot` assigns a constant execution principal with no lookup. Left unstated, Lane D
would report "0 divergences across three sinks" while one of them is structurally incapable of
producing a source-level divergence — **the same tautology the ticket exists to remove, one level
down.** Fixed in §1 and pinned by acceptance S11.

**R2 — MEDIUM. A stated reason was wrong.** Revision 1 justified `policy.model` as uncomparable
because "the same resolver runs on both sides". Verified: `model` appears nowhere in
`job-submission.ts` or `job-placement.ts` — the distributed side has *no* model authority at all.
Same conclusion, different reason. A right answer reached by a wrong route is a defect, because
the route is what a successor reuses.

**R3 — MEDIUM→HIGH. The effect-freeness clause was untestable as written.** Snapshotting
`jobs`/`job_attempts`/`environment_leases` row counts cannot see a write to a table not on the
list, and the list is hand-maintained. Replaced with a PostgreSQL-enforced read-only transaction
(D5a): the database refuses the write instead of a test noticing it afterwards. This also removes
the "receives a `Db` but only selects" honour-system phrasing from D5.

**R4 — MEDIUM. Unbounded probe on live user paths.** Placement enumerates worker candidates;
doing that synchronously inside a Commander turn is a latency regression on a live path for the
sake of an observability record. Bounded by D5b, with `probe_timeout` recorded as a distinct
outcome — a bound that degrades to "looks fine" would reintroduce the false-agreement failure.

**R5 — LOW, scope note.** Lane A changes `match` from `boolean` to a three-state, which the
existing consumers read (`index.ts:1231` logs it; `heartbeat.ts:5169` supplies the old snapshot
shape). Migrating both is in Lane A's scope, not deferred — a lane that leaves the tree
uncompilable is not a lane.

### Not accepted

- *"Give the comparator a read-only `Db` and let it probe itself."* Rejected in D4 and again here:
  the comparator's one structural guarantee is that it holds no handle. Trading a structural
  property for an argued one, to save passing a value, is a bad trade — and the argued version
  degrades silently the first time someone adds a method to the port.
