# Wave-3→4 gate, clause 3 — "a named rollback path per sink, tested at least once" · terrain

**Status: TERRAIN ONLY. No design, no code.** Clause 3 is the last unmet clause of
[HANDOFF-wave-3-4.md](../../../HANDOFF-wave-3-4.md) §4 (clause 1 done, clause 2 partial and
stated, clause 4 green, clause 5 scoped in §6).

Every claim below was verified by opening the file. Line references are to
`docs/replatform-program` at `cdce1ee94`.

---

## 1. The finding: "rollback is a config edit" is true and incomplete

`cli-006-canary-rollout-mode.test.ts:121` is titled *"returns the next run to legacy when the
canary key is removed"*, above a comment reading **"Invariant 9 — rollback is a config edit, with
no code change and no migration."** Both are accurate. What neither says is **"and a restart"**.

The test constructs a **fresh** rollout source from a new env bag:

```ts
const rolledBack = createDistributedExecutionRolloutSource(env({ organizations: {} }));
```

A running process cannot do that, because the source captures its inputs **once at
construction** (`distributed-execution-rollout-source.ts:159-160`):

```ts
const map = parseDistributedExecutionRolloutMap(env);
const deploymentEnabled = readDistributedExecutionDeploymentFlag(env);
```

`resolveRunRolloutState` then reads the **captured** `map` and the **captured**
`deploymentEnabled` (`:184-194`). `index.ts` builds the source exactly once at boot. So editing
`AOA_DISTRIBUTED_EXECUTION_ROLLOUT` in a live process changes nothing until restart.

The test therefore proves the DECISION FUNCTION answers `off` for an empty map. It does not, and
structurally cannot, prove that a running deployment rolls back. An operator reading the test
title and its comment would reasonably conclude the opposite.

## 2. Three rollback levers, and only two are live

| Lever | Live at runtime? | Verified |
|---|---|---|
| Unset `AOA_DISTRIBUTED_EXECUTION_ENABLED` | **YES, for new heartbeat conversions only** — the hook re-reads `process.env` on every call before touching the source | `heartbeat-distributed-rollout.ts:100-101` |
| …the same unset, for the WORKER CONTROL PLANE | **NO** — `if (opts.distributedExecutionEnabled)` gates *route registration* at app construction, so workers keep polling and leasing until restart | `app.ts:438-451` |
| …the same unset, inside `rolloutSource` itself | **NO** — `deploymentEnabled` is captured at construction | `distributed-execution-rollout-source.ts:160` |
| Remove/downgrade an Organization in the rollout map | **NO** — the map is parsed once | `:159` |
| **REL-004 kill switch** (`instance_settings.kill_switches`) | **YES** — read from the database on the poll path, per poll | REL-004 Lane C |

**The useful conclusion: REL-004 clause 3a is the real runtime rollback for the leasing half.**
The env flag stops the control plane minting *new* distributed work from the heartbeat; only the
kill switch stops workers taking more. Clause 1 turns out to answer most of clause 3, which is
worth saying out loud because the handoff treats them as unrelated.

## 3. In-flight work has no convergence path — both mechanisms are unwired

| Symbol | Production callers |
|---|---|
| `createJobDistributedDrain` (`job-distributed-drain.ts`) | **ZERO** (`grep`, excluding self + tests) |
| `createJobControlSweeper` (JOB-006) | **ZERO** — matches inherited deferral #2 |
| `assertRollbackSafe` | 3 bridge implementations, called from `job-distributed-drain.ts:118` — i.e. **only from the unwired drain** |

So `assertRollbackSafe` is a guard reachable only through a service nothing invokes. CLI-005
recorded this honestly (its deferral 1: the live enumerator + auto-trigger are MIG-002), but the
consequence for rollback has not been written down anywhere:

**A restart-based rollback strands any already-handed-off attempt.** Trace it:
`shouldSuppressLegacyExecution` returns true (`heartbeat.ts:5250`), the legacy adapter is
suppressed, the attempt is durably lease-eligible. If the process then restarts with the flag
off, the worker control routes are never registered, no worker can lease the attempt, and neither
the drain nor the sweeper exists to converge it — **the run stays `running` forever**. That is
inherited deferral #2 with a concrete trigger attached.

CLI-006 handled the *adjacent* hazard well (a marker-write failure revokes the fence so the work
returns to legacy rather than double-executing, `heartbeat.ts:5262-5300`). The rollback case is
different: nothing fails, so nothing converges.

## 4. Per-sink status

| Sink | Can execution actually move today? | Rollback surface |
|---|---|---|
| org heartbeat (`task_run`) | **YES** — CLI-006 `canary` makes an attempt lease-eligible and suppresses the legacy adapter | all of §2; the in-flight gap in §3 is real here and only here |
| Commander turn (`commander_turn`) | **NO** — shadow only; the seam emits an observation and nothing else | flag off / port unregistered; nothing has moved, so nothing to converge |
| crew dispatch (`crew_run`) | **NO** — shadow only | same |
| one-shot (`one_shot`) | **NO** — shadow only | same |

The three MIG sinks' rollback is trivially safe *because they are shadow-only*. That will stop
being true the moment Wave 4 makes any of them active, and the §3 gap applies to each of them at
that point. Clause 3 should not be ticked for those three on the strength of today's triviality.

## 5. What is already tested, honestly graded

| Test | What it actually proves | Grade |
|---|---|---|
| `cli-006-canary-rollout-mode.test.ts:121` "returns the next run to legacy when the canary key is removed" | the decision function answers `off` for an empty map, in a **freshly constructed** source | decision-level, not a live rollback |
| `:133` "returns to CLI-005 inert convert when the canary key is downgraded to `active`" | same shape | decision-level |
| `:110` "resolves `off` when the deployment flag is off" | the default, not the transition | weakest |
| `mig-shadow-evidence.integration.test.ts` "produces nothing at all when the deployment flag is off" | the three MIG sinks record nothing flag-off | default, not transition |

**Nothing tests a transition in a live process, and nothing tests in-flight convergence.**

## 6. The question the design has to answer first

> **Is clause 3 asking for a rollback path that WORKS, or one that is NAMED and whose limits are
> known?**

On the evidence the honest answer is that a working, no-restart, per-Organization rollback does
not exist today and building one is not a gate ticket — it is JOB-007/MIG-002 work (a persisted
rollout store rather than a captured env map) plus wiring the drain. What clause 3 can honestly
deliver now:

1. a **named** path per sink, with the restart requirement stated rather than implied;
2. a test that **pins the captured-map behaviour**, so the next reader cannot mistake the config
   edit for a live one — the inverse of the obvious test, and the honest one;
3. the in-flight strand (§3) recorded as a **Wave-4 blocker**, not a footnote.

## 7. Traps

- **Do not read `cli-006-canary-rollout-mode.test.ts` as a rollback test.** §1. It constructs a
  new source; a live process cannot.
- **Do not cite `assertRollbackSafe` as an active guard.** §3 — its only caller is a service with
  zero callers.
- **Do not tick clause 3 for Commander/crew/one-shot on today's evidence.** §4 — their rollback
  is trivial only because they are shadow-only, which is exactly what Wave 4 changes.
- **Do not "fix" the captured map by re-parsing per call** without checking placement: `index.ts`
  hands `resolveOrganizationPolicy`/`resolveWorkloadPolicy` to `createJobPlacementService`, so the
  seam and placement must agree about which Organizations are enabled. Making one live and not
  the other is worse than both being static.
