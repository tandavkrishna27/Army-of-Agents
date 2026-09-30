# MIG-005 / 006 / 007 — SHADOW ONLY · terrain

**Status: TERRAIN ONLY. No design, no code.** Wave 3 item 4
([HANDOFF-wave-3-4.md](../../../HANDOFF-wave-3-4.md) §3): *"Commander turns, crew dispatch,
one-shot extraction run distributed beside legacy via `job-shadow-comparator.ts`, results
compared, no effect."* That instruction names an artifact which, as wired in production,
**cannot report a divergence**. Worth knowing before a design is written.

Every claim below was verified by opening the file or by measurement. Line references are to
`docs/replatform-program` at `723da5f49`.

---

## 1. The finding that reframes the ticket

**The shadow comparator's production wiring has a structurally zero divergence rate. It is not
a low rate. It is a tautology.**

Three legs, each verified:

1. `job-shadow-comparator.ts:161` — `const derive = deps.deriveDistributedIntent ?? identityDistributedIntent;`
2. `index.ts:1221-1241` — production composes `createJobShadowComparator({ sink })` and passes
   **no** `deriveDistributedIntent`. The identity default is what runs.
3. `identityDistributedIntent` (`:109-124`) returns a field-by-field **copy** of the snapshot,
   and `diffIntent` (`:126-148`) compares each of the six fields to that copy — i.e. `x !== x`.

So `mismatchedFields` is always empty and `match` is always `true`. The only reachable `false` is
`errored`, which requires `derive` to throw — and a pure field copy of a typed object does not.

**Measured, not argued.** A probe composed the comparator exactly as `index.ts` does and fed it
2,000 snapshots randomized across all six diffed fields (`executionTargetType` over 5 values,
`executionPrincipalKind` over 4, `credentialKind` over 3, `model` over 3, `budgetPolicyId` over 2,
`effectiveCompletionPolicy` over 2):

```
PROBE: 2000 comparisons, 0 divergences
```

The two comparator tests that DO observe a mismatch (`job-shadow-comparator.test.ts:94`) or an
error (`:112`) both **inject their own `deriveDistributedIntent`**. Nothing tests the shape
production runs.

### Why this matters more than it looks

The gate ([§4](../../../HANDOFF-wave-3-4.md) clause 2) requires *"a stated divergence rate and
every divergence explained"*, and warns that *"'no divergences observed' without a volume figure
is not evidence."* Wiring three more sinks into this comparator would clear that bar on its
face — **"0 divergences over N Commander turns, N crew runs, N extractions"**, with a volume
figure — and it would still be worth nothing. The handoff anticipated a missing denominator. The
actual defect is a numerator that cannot increment.

This is the programme's recurring failure class in its equivalence-checking form: a false claim
of agreement is worse than no check, because it is the thing the gate opens on.

### Why the module's own justification does not save it

The header argues (`:104-108`) that a correct mapping *"is diff-clean because … the distributed
intent is DERIVED from the same resolved config, so it must equal the legacy snapshot."* That is
circular as implemented: the intent is derived from **the snapshot**, not from the config. A
comparison is informative only if the two sides are reached by independent routes from a shared
source of truth. Here there is one route, traversed twice.

## 2. The snapshot's own fields are partly fiction

Even with an independent `derive`, four of the six diffed fields carry no real legacy value.
`heartbeat.ts:5163-5188` hardcodes them:

| Field | Fed as | Assessment |
|---|---|---|
| `provenance.executionPrincipalKind` | `"agent"` | **Sound.** `taskRunSourceSchema` requires the execution principal to be an agent, so for `task_run` this is structural, not a guess — but agreement on it is therefore not evidence either. |
| `provenance.credentialKind` | `null` | **Honest today** — inherited deferral #1: a worker receives no provider credential. |
| `policy.budgetPolicyId` | `null` | Coarse. `budget_policies` exists; not resolved here. |
| `policy.effectiveCompletionPolicy` | `"review_required"` | **Wrong for some runs.** `resolveAgentCompletionPolicy` (`agent-completion-policy.ts:83`) exists and `heartbeat.ts` never calls it — its only mention of the field is the hardcoded literal (`:5181`). Any task resolving to `agent_can_complete` is recorded as `review_required`. |

The last row is not coarseness. It is a false value in the record the gate reads.

## 3. The comparator cannot express two of the three target sinks

`compare()` hardcodes the source (`:165-170`):

```ts
const wouldBeSource: SubmitJobSource = {
  kind: "task_run", runId, issueId, assigneeAgentId,
};
```

and `LegacyRunExecutionSnapshot` (`:34-63`) makes `runId`, `issueId` and `assigneeAgentId`
**required**. The three target sinks do not have them:

| Ticket | Frozen source variant | Identity fields | Has run/issue/agent? |
|---|---|---|---|
| MIG-005 | `commanderTurnSourceSchema` | `internalAgentRunId`, `conversationId` | no |
| MIG-006 | `crewRunSourceSchema` | `crewRunId` | no |
| MIG-007 | `oneShotSourceSchema` | `operationId`, `operationKind` | no |

Fabricating them is refused at the schema boundary, not merely discouraged by prose: every
variant in `packages/worker-protocol/src/source.ts` is `.strict()`, with the module comment
*"unknown keys (including fabricated run/issue fields on non-task variants) are rejected"*
(`:61-62`). That package is **FROZEN**. The crosswalk says the same thing independently for
CM-007: *"Provenance without fabricated `runId`/`issueId`."*

The shared `SubmitJobSource` union (`packages/shared/src/types/job-control.ts:1-32`) already
carries all six variants, so the comparator's **type** is wide enough; only its construction is
narrow. This half is ordinary work.

## 4. The rollout key has no per-sink axis — and this bites Wave 4, not Wave 3

`resolveRunRolloutState` keys on `(deploymentMode, organizationId, workloadType)`
(`distributed-execution-rollout-source.ts:78-82`), and `workloadType` is the FROZEN
`WORKLOAD_TYPES = ["batch","browser_session","service"]` (`states.ts:30`). All four sinks —
org heartbeat, Commander turn, crew run, one-shot — are `batch`.

- **For Wave 3 this is benign.** Shadow is effect-free, so one switch arming all four batch sinks
  at once is acceptable and arguably the point ("exercise E3+E4 against real traffic").
- **For Wave 4 it is not.** [§5](../../../HANDOFF-wave-3-4.md) sequences the cutover MIG-005 →
  MIG-006 → MIG-007 precisely because Commander is *"lowest blast radius; start here."*
  **That progressive per-sink cutover is not expressible in the rollout source as built** —
  setting an Organization to `canary`/`active` on `batch` moves every batch sink at once,
  including the org heartbeat that CLI-006 canaried separately.

**Trap for the design:** do NOT fix this by passing a finer string (e.g. `"commander_turn"`) as
`workloadType` from the shadow seam. `resolveWorkloadPolicy` takes a bare `string`, so it would
appear to work — but placement (E3-owned, not edited) resolves the same policy using the job's
real frozen `workloadType`. Shadow gated on a key that active cannot use means the shadow
evidence does not correspond to the thing being enabled. **The shadow gate must use the same key
active uses.** A per-sink axis is a real change to the rollout source and belongs to Wave 4 /
JOB-007 / MIG-002, not here — but it must be *stated* now, because §5's ordering silently assumes
it already exists.

## 5. Where the three seams are

| Sink | Seam | Notes |
|---|---|---|
| MIG-007 one-shot | `runOneShotCliInSandbox` (`one-shot-sandbox-cli.ts`) | **One seam for all three operation kinds** — extraction (`extraction-cli.ts:364`), compaction (`internal-agent/cli-summarizer.ts:7`), readiness probe (`sandbox-readiness-probe.ts:46`). Cleanest of the three. |
| MIG-005 commander turn | `internal-agent/cli-mode.ts` (`cliModeService`, `:752`) | Turn execution; `internal_agent_runs` supplies `internalAgentRunId`, the conversation supplies `conversationId`. |
| MIG-006 crew run | `runAoaAgent` (`internal-agent/aoa-agents/runner.ts:142`) | Crew dispatch. |

**Caveat on coverage:** `runOneShotCliInSandbox` is the *cloud* branch. Self-hosted one-shot runs
host-direct and would never reach a snapshot placed there, so "real traffic" for MIG-007 means
cloud traffic. State the denominator per deployment mode or the rate is unreadable.

## 6. What is built vs. what is wired

| Symbol | Production callers |
|---|---|
| `createJobShadowComparator` | 1 — `index.ts:1221`, identity derive |
| `runShadowComparison` | 1 — `heartbeat.ts:5169`, org heartbeat only |
| a `commander_turn` / `crew_run` / `one_shot` source **construction** | **0.** `job-admission-bridge.ts:137-172` and `job-approval-bridge.ts:164-197` only *characterize* a source handed to them; neither mints one. |
| `compare(..., { admissible })` | 0 — the seam calls `compare(snapshot)`, so `admissible` is always `null`. |

## 7. The question the design has to answer first

Not *"how do we snapshot three more sinks"* but:

> **What second, independent derivation of the distributed intent exists — and if none does, what
> is the honest thing to record instead?**

Two shapes are available and they are not equivalent:

- **(a) Make `derive` independent.** Re-resolve routing/provenance/policy from config and the
  database by the route a real submission would take, and diff that against the legacy snapshot.
  This is the only shape whose divergence rate means anything. It is also strictly more work than
  the handoff's one-line framing, and it requires the four hardcoded snapshot fields to become
  real.
- **(b) Drop the pretence and record a characterization.** Keep it effect-free, record the
  would-be source / workload / placement per sink, and state plainly in the gate evidence that
  **no equivalence was checked**. Honest, much cheaper, and does not satisfy gate clause 2.

Recommendation to carry into design: **(a) for the fields that can be independently resolved,
(b) explicitly for those that cannot**, with the split named in the evidence rather than blurred.
A field compared to itself must not be counted in the denominator.

## 8. Traps

- **Do not wire three sinks into the identity comparator and report the rate.** §1. It is the
  single instruction the handoff gives for this item, and following it literally manufactures
  false gate evidence.
- **Do not fabricate `runId`/`issueId` for the non-task variants.** §3 — refused by a FROZEN
  `.strict()` schema, and independently forbidden by CM-007.
- **Do not introduce a finer `workloadType` for the shadow gate.** §4 — it decouples shadow from
  what active will actually do.
- **Do not count `provenance.executionPrincipalKind` as a checked field.** §2 — for `task_run`
  it is schema-structural; agreement there is not evidence.
- **`packages/worker-protocol/` is FROZEN** (v1, source SHA
  `b7a842870ce7509d8baa75409e0ab19da375c88a`). Every shape above is a consumer-side change.
