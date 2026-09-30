# MIG-005 / 006 / 007 — SHADOW ONLY · result

**Start SHA** `aade5a915` (the design commit) · **Design**
[`MIG-005-006-007-shadow-design.md`](./MIG-005-006-007-shadow-design.md) (revision 2) ·
**Terrain** [`MIG-005-006-007-shadow-terrain.md`](./MIG-005-006-007-shadow-terrain.md) ·
**Branch** `docs/replatform-program` (PR #323) · **Wave 3 item 4** ·
**Predecessor** [`REL-004-lane-D-result.md`](../../E11-hardening-release/tickets/REL-004-lane-D-result.md).

**Status: Lanes A–D COMPLETE. Gate clause 2 is PARTIALLY met and the shortfall is named
in §6 — the rate is produced over a seeded corpus, not organic traffic.**

| # | Commit | Scope |
|---|---|---|
| 1 | `0d00e07d1` | terrain — the comparator cannot diverge |
| 2 | `aade5a915` | design — compare admissibility, not field equality |
| 3 | `88efc0d57` | plan review, revision 2 |
| 4 | `48d5113c8` | Lane A — an uncompared field is never agreement |
| 5 | `26428fb94` | Lane B foundation — PostgreSQL enforces the probe cannot write |
| 6 | `4a8ddc017` | Lane B — the read-only admissibility probe |
| 7 | `59db7b799` | Lane C — the one-shot seam + the port |
| 8 | `55ef0265b` | Lane C — the Commander and crew seams |
| 9 | `19ad7b45e` | Lane D — the evidence harness, and the gap it found |

**52 mutants across the ticket: 50 killed, 2 documented equivalent.**

| Lane | Killed | Equivalent |
|---|---|---|
| A — the honesty fix + source union | 14 | 1 (the `not_compared` arm is unreachable in `buildComparison` once `workloadType` is compared unconditionally; that state is reached via `erroredComparison`, which A7b covers) |
| B — read-only tenant transaction | 4 | 1 (statement order: PostgreSQL restricts only ISOLATION LEVEL to before the first query, so the swap is genuinely equivalent — measured, see §5) |
| B — the admissibility probe | 9 | 0 |
| C — the port + the one-shot seam | 11 | 0 |
| C — the Commander and crew seams | 9 | 0 |
| D — the evidence threading | 3 | 0 |

---

## 1. What the ticket turned out to be

The handoff's instruction was one line: run the three sinks *"distributed beside legacy via
`job-shadow-comparator.ts`, results compared, no effect."* The terrain pass found that the
named artifact **cannot report a divergence**.

`createJobShadowComparator` defaulted its derivation to an identity function that copied the
snapshot, then diffed the snapshot against that copy; production supplied no replacement. Every
field compared equal to itself. **Measured before touching anything: 2,000 randomized snapshots
across all six diffed fields, 0 divergences.**

That is not a low rate. It is a numerator that cannot increment — and gate clause 2 opens on
exactly that number. Wiring three more sinks into it would have cleared the gate on its face,
with a volume figure, and meant nothing. The handoff anticipated a missing denominator; the real
defect was worse.

So the ticket became: **replace what is compared, then wire the sinks to that.**

## 2. The decisions that mattered

**Field equality was the wrong comparison.** Asking what an honest independent derivation of each
of the six fields would be collapses four of them: completion policy, model and budget policy
resolve through the same code on both sides (or, for `model`, through *no* distributed authority
at all), and `credentialKind` has nothing to compare while inherited deferral #1 stands. The two
that do have a second authority — the execution principal and the placement target — express
disagreement not as a different value but as **a refusal to run the thing**.

**So the shadow pass answers admissibility.** Would the distributed platform have accepted this
Commander turn / crew dispatch / one-shot operation, and if not, why? Those authorities
(`repos.jobControl.admission` and the per-kind `*SourceIsAdmitted` checks) genuinely return no.
The comparator already had an `admissible` slot for exactly this and it had **never had a caller
supply it**.

**An uncompared field is recorded as uncompared, never as matching.** `match` is now
`agree | diverge | not_compared`, and the record carries `comparedFields` (the gate's
denominator) and `uncomparedFields`. Today that reads **1 of 7 compared**, not 7 of 7 by
default — the honest description of what ships.

**Effect-freeness stayed structural.** The comparator still holds no `Db` and therefore still
cannot write; the probe runs at the seams, where a `Db` already lives. And the probe's
read-only-ness is enforced by PostgreSQL (`runInTenantReadOnly` → any write raises 25006), not by
a test counting rows in tables somebody remembered to list.

## 3. Acceptance → named executable artifact

| # | Invariant | Artifact | Result |
|---|---|---|---|
| S1 | The production wiring never reports agreement on a field it did not compare | `job-shadow-comparator.test.ts` — the 2,000-snapshot probe, inverted into a permanent assertion | pass |
| S2 | compared/uncompared partition exactly; `mismatchedFields ⊆ comparedFields` | same file | pass |
| S3 | All six source kinds round-trip with their own identity, literal ids | same file | pass |
| S4 | No fabricated `runId`/`issueId` on a non-task variant | same file + the FROZEN `.strict()` variants | pass |
| S5 | The comparator holds no `Db` handle | structural; asserted on the factory's dep keys | pass |
| S6 | A throwing probe never propagates into the caller | `distributed-shadow-port.test.ts` | pass |
| S7 | The probe performs no write | `tenant-read-only.integration.test.ts` — PostgreSQL raises 25006 | pass |
| S8 | Each seam emits one record, and none when rollout ≠ shadow | `one-shot-sandbox-cli.test.ts`, `aoa-runner-task-execution.test.ts`, `commander-shadow-seam.test.ts`, `distributed-shadow-port.test.ts` | pass |
| S9 | A denied admission is a divergence with a reason, not an error | `job-shadow-admissibility.test.ts` + the evidence harness | pass |
| S10 | All four cutover sinks share one rollout key (`batch`) | `job-shadow-comparator.test.ts` | pass |
| S11 | The per-sink signal asymmetry is reported, not implied | `job-shadow-admissibility.test.ts` + **the aggregate table** in `mig-shadow-evidence.integration.test.ts` | pass |
| S12 | A probe past its deadline records `probe_timeout`, never agreement | `distributed-shadow-port.test.ts` (injected clock) | pass |
| — | The port is actually registered | `distributed-shadow-port-registration.test.ts` | pass |
| — | The probe reads real rows through RLS | `job-shadow-admissibility.integration.test.ts` | pass |

## 4. The evidence (Lane D)

Produced by `mig-shadow-evidence.integration.test.ts`, end to end through the real rollout
source, the real probe against a real database, and the real comparator:

| Sink | Records | Compared | Diverged | Refused | Reason | Authorities that ran |
|---|---|---|---|---|---|---|
| `commander_turn` | 5 | 1 of 7 | 0 | 5 | `source_not_admitted` | admission + requester_kind + **source** |
| `crew_run` | 5 | 1 of 7 | 0 | 5 | `source_not_admitted` | admission + requester_kind + **source** |
| `one_shot` | 3 | 1 of 7 | 0 | 0 (3 admissible) | — | admission + requester_kind (**no source authority exists**) |

Read it as: **0 divergences over 13 records on ONE compared field**, and the refusals are the
seeded corpus behaving correctly (no Commander or crew runs exist in the fixture, so the real
per-source authority denies them — which is the finding a cutover needs). The last row is S11
appearing in the aggregate rather than as prose.

## 5. Findings, in the order they cost something

**§1's tautology** — the ticket's reason to exist. Found by terrain, measured before any change.

★★★ **CLI-005 HAD ALREADY SAID SO, and the handoff did not carry it.** `CLI-005-result.md`
records three scope-honesty deferrals in plain words: shadow "is diff-clean by construction
(identity mapping)", its provenance/policy fields "are placeholders", and "the read-only
admissibility probe is not wired (`admissible` is always the safe `null`)" — all deferred to
MIG-002. That document was honest. The Wave-3/4 handoff then wrote a gate clause requiring a
"stated divergence rate" from that comparator and instructed the next agent to wire three more
sinks into it, without rechecking those deferrals.

**So the failure is not a wrongly refuted finding — it is that a documented deferral does not
travel to the document that later depends on it.** Each document was true in isolation; the pair
would have manufactured the evidence a gate opens on. Worth carrying forward as its own hazard:
when a gate clause consumes a number, go and read what the thing producing that number said
about itself.

**R1, from the plan review (HIGH).** Revision 1 implied all three sinks have a real source-level
admission authority. `commander_turn` and `crew_run` do; **`one_shot` does not** —
`submitJobWithinTenant` assigns it a constant execution principal with no lookup. Left unstated,
Lane D would have reported "0 divergences across three sinks" with one sink structurally unable
to produce a source-level divergence: **the same tautology one level down.**

**R2.** The reason given for `policy.model` being uncomparable was wrong — not "same resolver
both sides", but no distributed model authority at all. A right answer by a wrong route is still
a defect, because the route is what a successor reuses.

**R3.** The effect-freeness clause was untestable as written (row-counting chosen tables).
Replaced with database enforcement.

**Lane B, mutation refuted my own explanation** — for the second time in this programme. The
comment claimed `SET TRANSACTION READ ONLY` "must precede the first statement"; the swap mutant
survives, because PostgreSQL restricts only ISOLATION LEVEL that way. Corrected to the true,
smaller reason.

**Lane D found what unit tests could not.** The probe computed `reason` and `authoritiesChecked`
— the S11 field whose whole purpose is to expose the asymmetry — and the recorder **dropped
both**. The record could say "would have been refused" without saying why, making "every
divergence explained" unmeetable from the evidence. Only assembling the aggregate table surfaced
it. Writing the evidence is part of building the thing, not a write-up afterwards.

**Four mutants survived first, and every one was a defect in my own tests:**
- a missing explicit-null case for `budgetPolicyId` (the `credentialKind` twin was covered);
- **`expect(result.sourceId).toBe(submitJobSourceIdentity(source))`** — comparing the
  implementation to itself, in the ticket about tautologies. Expected ids are now literal;
- the Commander seam could have fed its (correct) builder a constant instead of the resolved
  target, and nothing checked the argument;
- `workloadType` had no second authority in the comparable set at all until an adversarial pass
  put it there.

**Three more "survivors" were my harness matching `carries` against a test named `carrying`.** A
survival for the wrong reason proves as little as a kill for the wrong reason.

## 6. Limits, stated

1. **The evidence is a SEEDED corpus, not organic traffic — gate clause 2 is only partially
   met.** The D1 two-replica lane exercises the worker/job-control platform (leases, tenancy,
   MinIO, fences, fan-out) and contains **nothing** that drives a Commander turn, a crew dispatch
   or an extraction, so no existing live lane's volume can be cited. A real-traffic run needs: a
   deployment with `AOA_DISTRIBUTED_EXECUTION_ENABLED=1`, an Organization set to `mode:"shadow"`
   in `AOA_DISTRIBUTED_EXECUTION_ROLLOUT`, and actual user traffic through the three sinks. The
   harness is the instrument; the traffic is not this ticket's to manufacture.
2. **Only 1 of 7 fields is compared.** `workloadType` alone has a second authority needing no
   caller. Four fields have no second authority at all (§2), and `credentialKind` waits on
   inherited deferral #1. This is reported per record rather than hidden.
3. **`one_shot` has no per-source authority** (R1). Its admissibility signal is generic admission
   plus the requester-kind gate. Pinned by S11 and visible in §4.
4. **No per-sink rollout axis.** All four cutover sinks are `workloadType: "batch"`, so one
   switch arms them all. Harmless for effect-free shadow; **it means Wave 4's MIG-005 → 006 → 007
   ordering is not expressible today.** Do not fake one by passing a finer string — placement
   resolves the same policy with the job's real frozen `workloadType`, so a shadow gated on a key
   `active` cannot use would prove nothing about `active`. A real axis belongs to JOB-007 /
   MIG-002 and is a **Wave 4 prerequisite**.
5. **Deferral #1 (a worker receives no provider credential) is untouched.** Shadow does not need
   one; it still blocks MIG-005/006/007 **active**.
6. **The Commander seam is tested in two halves** — pure content plus a source contract test for
   placement — because driving the real generator needs the whole spawn surface mocked. The
   placement half is textual, so an index.ts-style refactor of `cli-mode.ts` must carry it along.
7. **A one-shot `operationId` is minted per call.** One-shot operations have no durable id, so
   records cannot be correlated back to a specific extraction. That is the operation's own
   identity, not a fabricated run/issue.

8. **Three new integration suites, three embedded-PostgreSQL boots.** `tenant-read-only`,
   `job-shadow-admissibility.integration` and `mig-shadow-evidence.integration` each call
   `setupJobControlFixture`, so each boots its own cluster and adds a few minutes to `verify`.
   They are kept separate because they answer unrelated questions (database-enforced
   read-only-ness; can the probe see real rows through RLS; the aggregate evidence table), and
   sharing one fixture would couple them. Stated because it is a cost I introduced, not a free
   addition.

## 7. Process note

`job-shadow-admissibility.ts` was written before its tests — a real deviation from the fail-first
discipline §1 makes binding. The mutation pass that followed is a strictly stronger check than
watching a test fail once, and it was run (9 killed, 0 survived), but the deviation is recorded
rather than tidied away.
