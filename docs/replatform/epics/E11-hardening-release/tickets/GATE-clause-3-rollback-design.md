# Wave-3→4 gate, clause 3 — design

**Terrain** [`GATE-clause-3-rollback-terrain.md`](./GATE-clause-3-rollback-terrain.md) ·
**Branch** `docs/replatform-program` (PR #323) ·
**Clause** *"A named rollback path exists per sink, tested at least once."*

Terrain established that the rollback path a successor would follow — CLI-006's *"removing the
Organization's key … a config edit, with no code change and no migration"* — **omits that a live
process never sees the edit**, and that the test which appears to cover it constructs a fresh
source a running process cannot.

---

## 1. What clause 3 is actually asking for

Two readings:

- **(a) a rollback that works** — per-Organization, no restart, in-flight work converged;
- **(b) a rollback that is NAMED, and whose limits are known and tested.**

(a) does not exist today and is not a gate ticket: it needs a persisted rollout store instead of
a captured env map (JOB-007 / MIG-002) and the drain wired (CLI-005 deferral 1 + inherited
deferral #2). Building either at a gate, unvalidated on a live lane, would be the opposite of
what a gate is for.

**Decision D1: clause 3 delivers (b).** A named path per sink, its limits stated where an
operator reads them, and a test that pins each limit so the naming cannot silently drift back.

## 2. The path is two levers, and naming only one is the current defect

**Decision D2. The named rollback path is an ORDERED PAIR, not a config edit.**

| Step | Lever | Effect | Latency |
|---|---|---|---|
| 1 | **Throw the REL-004 kill switch** for the provider/target (`instance_settings.kill_switches`) | workers stop being offered new leases; in-flight work finishes | **immediate** — read from the database on every poll |
| 2 | Edit `AOA_DISTRIBUTED_EXECUTION_ROLLOUT` (remove the Organization, or downgrade the mode) **and restart** | the control plane stops minting new distributed work for that Organization | **next restart** |

Step 1 exists because of REL-004 clause 3a and is the only genuinely live lever for the leasing
half. Step 2 is the durable state change. Naming step 2 alone — which every current document
does — hands an operator a lever that appears to have fired and has not.

**Rejected: unsetting `AOA_DISTRIBUTED_EXECUTION_ENABLED` as the headline path.** It is live for
new heartbeat conversions (the hook re-reads `process.env`) but does **not** unregister the worker
control routes (`app.ts:438`, a boot-time `if`), so workers keep polling and leasing. A lever
that stops half the system while reading as a master switch is worse than one honestly labelled
restart-required.

## 3. Pin the limits, do not merely write them down

**Decision D3.** Each limit gets a test, because a documented limit that nothing enforces drifts
back into a false claim — this programme's most expensive recurring failure.

- **G1** — a live rollout source does **not** observe a mutation of its env bag. The inverse of
  the obvious test, and the honest one. It fails the day someone makes the map live without
  updating the runbook, which is exactly when the runbook would otherwise become wrong.
- **G2** — the deployment flag **is** live at the hook. Asserting both G1 and G2 is what keeps
  the two levers distinguishable; today they are conflated in prose.
- **G3** — the worker control routes are gated at construction, so the flag cannot unregister
  them at runtime.

## 4. Per-sink status, and what must NOT be ticked

**Decision D4.** Clause 3 is satisfied **for the org heartbeat only**. For the three MIG sinks it
is recorded as *trivially satisfied because they are shadow-only*, which is not the same thing
and must be re-satisfied at activation.

| Sink | Execution can move today? | Clause 3 |
|---|---|---|
| org heartbeat (`task_run`) | yes (CLI-006 canary) | **satisfied**: path named (§2), limits pinned (§3), in-flight gap stated (§5) |
| `commander_turn` / `crew_run` / `one_shot` | no — shadow only | **trivially satisfied today; RE-SATISFY at activation.** Nothing has moved, so nothing can be rolled back. Ticking these on today's evidence would be a claim about a state Wave 4 changes. |

## 5. The in-flight strand is a Wave-4 blocker, not a footnote

**Decision D5.** Terrain §3 — a restart-based rollback strands an already-handed-off attempt,
because the legacy adapter was suppressed, the attempt is durably lease-eligible, and after the
restart no worker can lease it while `job-distributed-drain` and `createJobControlSweeper` both
have **zero** production callers. The run stays `running` forever.

This is recorded as a **Wave-4 blocker** with a named owner (MIG-002), not as a limit. Step 1 of
§2 mitigates it in practice — throwing the kill switch first lets in-flight work finish before
the restart — so the ordered pair is not merely tidier, it is the difference between a clean
rollback and a stranded run. That is why D2 makes the order part of the path.

## 6. What this deliberately does not build

1. **A live, per-Organization rollback.** Recommended as a follow-up with a constraint attached:
   `index.ts:1162-1163` hands `resolveOrganizationPolicy` / `resolveWorkloadPolicy` to
   `createJobPlacementService`, so the seam and placement share one source. Making the map live
   must make **all** resolvers live together — a version where the seam is live and placement is
   not is worse than both being static. Parsing per call also needs a cache keyed on the raw
   string. It changes the behaviour of the canary path CLI-006 validated on the live lane, so it
   deserves its own ticket and its own D1 bring-up, not a paragraph in a gate clause.
2. **Wiring the drain or the sweeper** — MIG-002, and each needs live validation.
3. **Any change to `packages/worker-protocol/`** — FROZEN.

## 7. Acceptance → named executable artifact

| # | Invariant | Artifact |
|---|---|---|
| G1 | A constructed rollout source ignores later env mutation (restart required) | `rollout-rollback-liveness.test.ts` |
| G2 | The deployment flag IS live at the heartbeat hook | same file |
| G3 | Worker control routes are gated at construction, not per request | same file (source contract) |
| G4 | The operator-facing rollback instruction names both steps and the restart | `docs/deploy/environment-variables.md` + `CLI-006-result.md` closure note |
| G5 | Clause 3 status is recorded per sink, with the three shadow sinks explicitly NOT ticked on triviality | the result doc + handoff §4 |

Every guard mutation-tested per handoff §1.8.
