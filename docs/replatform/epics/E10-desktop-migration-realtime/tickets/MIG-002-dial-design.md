# MIG-002 — the routing dial · design (first slice)

**Terrain** [`MIG-002-dial-terrain.md`](./MIG-002-dial-terrain.md) ·
**Branch** `docs/replatform-program` (PR #323) · **Wave 4 item 1.**

Scope: make the dial a dial — **live without a restart**, and **expressible per sink**. Nothing
else. Convergence (drain/sweeper) and a kill-switch write path are separate lanes (terrain §4).

---

## 1. Two changes, one place

**Decision D1 — the source re-reads where it reads, and BOTH values move together.**
`createDistributedExecutionRolloutSource` currently captures the parsed map and the deployment
flag on two adjacent lines (`:159-160`). The re-read goes inside the shared helper closures, so
`resolveOrganizationPolicy`, `resolveWorkloadPolicy` and `resolveRunRolloutState` all become live
in the same instant.

This is what makes consistency **structural rather than engineered** (terrain §2): `index.ts`
passes two of those closures by reference into placement and holds the same object for the seam,
so there is exactly one source of truth and one moment of reading it. Migrating one value and not
the other — or adding a second live source alongside the captured one — would manufacture the
divergence this exists to remove.

**Decision D2 — the per-sink axis is honouring a contract that already exists.**
`resolveWorkloadPolicy`'s declared input already carries `sourceKind` and `companyId`
(`job-placement.ts:392-397`), and placement passes the whole input (`:445`). The implementation
discards them. It will stop discarding `sourceKind`. **No plumbing, no migration, and
`packages/worker-protocol` is untouched.**

**Decision D3 —** `resolveRunRolloutState` takes an **optional** `sourceKind`, so the seam and
the shadow recorder can use the same axis. Optional keeps every existing caller correct.

## 2. Config shape — additive, and silent on absence

```jsonc
{ "organizations": { "<id>": {
    "mode": "shadow" | "active" | "canary",
    "workloads": ["batch", "*"],
    "sources": ["commander_turn", "crew_run"]   // NEW, optional
} } }
```

**Decision D4 — an absent `sources` means ALL sinks**, exactly as today. An existing config keeps
its current behaviour byte for byte, which matters because CLI-006's canary was validated live
against that behaviour. Per-sink control is opt-in; it does not change what any deployment does
until someone writes the key.

An unknown source kind in `sources` is a **startup parse error**, matching how an unknown `mode`
already behaves (`parseDistributedExecutionRolloutMap` throws) — an old binary reading a new
config must fail loudly, not silently route.

## 3. A live config can be edited badly. Fail closed, and say so.

Today a malformed `AOA_DISTRIBUTED_EXECUTION_ROLLOUT` fails at **startup**, loudly. Once the
value is re-read per call, a bad edit lands on a **running** process, and the current behaviour
would be a throw on a live path.

**Decision D5 — a parse failure at runtime resolves to `off` (legacy), and logs.** Legacy is the
safe executor, so failing closed degrades to the pre-distributed behaviour rather than throwing
into a run. Two properties this must have, and both are easy to get wrong:

- **It must never throw.** The resolvers are called from the heartbeat seam, the shadow recorder
  and placement; a throw would surface as a failed run.
- **It must not flood the log.** The value is re-read per call, so an unchanged bad value must
  log **once**, not once per run. Keyed on the raw string, like the memo.

**Rejected: keep the last good value.** It silently ignores an operator's edit, and the operator
has no feedback that their change did not take. Failing closed is visible in behaviour (work
returns to legacy) and in the log.

## 4. Cost: memoize on the raw string

**Decision D6.** Re-reading means `JSON.parse` per call. Memoize on the raw env string so the
steady state is a string comparison and the parse happens only when the value actually changes.

These are per-run and per-placement-decision calls, **not** the worker poll — so this is a
strictly lighter path than the kill switch's per-poll database read that already ships. Stated
because the terrain flagged the comparison as load-bearing and unverified: it is now verified,
and it runs the *favourable* way.

## 5. Every interleaving of a live flip must land on legacy

The new hazard a live dial introduces: the value can change **between** the seam's decision and
placement's. Both directions must be safe.

| Flip | Seam sees | Placement sees | Outcome |
|---|---|---|---|
| enabled → disabled mid-run | `canary` | not enabled | placement returns legacy → owner legacy → **the adapter is not suppressed** → one executor (legacy) |
| disabled → enabled mid-run | `off` | (never consulted — the seam never converts) | legacy → one executor |

**Decision D7 — this is an invariant, not a hope, and it gets a test.** A live dial whose worst
interleaving produced two executors would be strictly worse than the restart it replaces.

## 6. The clause-3 pins change in this commit, deliberately

`rollout-rollback-liveness.test.ts` G1 asserts that a live source **ignores** an env edit, and
its failure message says: *"If this assertion now fails, the map has been made live — which is an
improvement, but the rollback runbook … says a restart is required and must be corrected in the
same change."*

**Decision D8 — that is exactly what happens here.** G1 inverts (a live source now DOES observe
the edit), and in the same commit:
- `docs/deploy/environment-variables.md` § "Rolling distributed execution back" drops the restart
  requirement from step 2;
- `CLI-006-result.md`'s correction block is updated;
- the clause-3 result doc records that its limit 1 is closed.

A pin that fires and gets edited without its runbook is how the original defect happened. The
pin worked; honouring it is the point.

## 7. Acceptance → named executable artifact

| # | Invariant | Artifact |
|---|---|---|
| M1 | A live source observes a map edit — removal, downgrade, and re-enable — with no restart | `rollout-dial-live.test.ts` |
| M2 | The deployment flag is live in the source too, not only at the hook | same |
| M3 | `sources` filters by sourceKind; **absent = all sinks**, byte-identical to today | same |
| M4 | An unknown source kind fails the parse loudly, like an unknown mode | same |
| M5 | A malformed value at runtime resolves to `off`, never throws, and logs once per distinct value | same |
| M6 | Repeated calls with an unchanged value do not re-parse (memo) | same |
| M7 | Placement and the seam read ONE source — a flip is observed by both at the same instant | source contract on `index.ts` + the shared-closure structure |
| M8 | Every live-flip interleaving lands on legacy, never two executors | `rollout-dial-live.test.ts` (D7 table) |
| M9 | The clause-3 pins and both runbooks are updated in the same commit | G1 inverted; docs diff |

Every guard mutation-tested per handoff §1.8. D1 nonce bumped — this changes runtime behaviour
on the `server/src` routing path that the live lane exercises.

## 8. Out of scope, stated

1. **Convergence** — the drain, the sweeper, `listActiveAttempts`' missing SQL. A live dial
   removes the *restart* that strands work; it does not converge work already handed off.
2. **A kill-switch write path** — REL-001/005. Until it exists, step 1 of the rollback runbook is
   still hand-SQL, and "reversible in seconds" is still not fully true.
3. **Moving rollout state to the database.** Deliberately left open (terrain §3); it belongs with
   (2), solved once.
4. **`packages/worker-protocol`** — FROZEN, and untouched by this slice.
