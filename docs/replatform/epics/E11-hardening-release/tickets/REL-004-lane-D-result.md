# REL-004 Lane D — reconcile active provider resources on kill (clause 3b) · result

**Start SHA** `89f5c6d13` (the design commit) · **Design**
[`REL-004-lane-D-design.md`](./REL-004-lane-D-design.md) (revision 2) · **Terrain**
[`REL-004-lane-D-terrain.md`](./REL-004-lane-D-terrain.md) · **Branch** `docs/replatform-program`
(PR #323) · **Predecessor** [`REL-004-lane-C-result.md`](./REL-004-lane-C-result.md).

**Status: clause 3b COMPLETE, and inherited deferral #5 CLOSED.** Clause 3 is now whole: 3a stops
new leases (Lane C), 3b reconciles what the control plane can actually reclaim.

| # | Commit | Scope |
|---|---|---|
| 1 | `58ea8925a` | one parse of the kill-switch document, two readers (D4) |
| 2 | `6c322edea` | the STRAND arm + `claimTerminalUncleaned` (D3, arm 1) |
| 3 | `adaebe6bc` | registration moved out of the heartbeat gate (D1, J11) |
| 4 | `97d0129e6` | the RECLAIM arm — opt-in, provider-scoped, fail-open (D2, arm 2) |
| 5 | `db6b801b8` | an explicit reclaim outranks the warm-economy toggle (J12, J14) |
| 6 | `99f90d106` | superseded-key snapshots — deferral #5 (§5) |
| 7 | `573376d13` | J13, this doc |
| 8 | `0963cf0b0` | J10, and the CAS defect it exposed |

**28 mutants across the lane: 28 killed.** Three survived first — two were gaps in my own
tests, and the third exposed a real defect in the implementation (§5.1).

---

## 1. What clause 3b turned out to be

Not "build a reconciler". The terrain pass established that the parent design's single
instruction — *"build on MIG-008's `legacy-resource-reconciliation` seam"* — would, followed
literally, have made things **worse**: `casClaimPaused` flips a paused lease to `expired` without
killing the sandbox, and the warm-sandbox reaper (the only scheduled force-kill) selects
exclusively `status='paused'`, so a claimed row leaves the only reclaim path forever while the VM
keeps running and billing.

So the lane is: **stop a kill from breaking the one reclaim path that exists, make that path act
on an operator's explicit intent, and state every limit as a choice.** Three arms on the existing
reaper, no new scheduled loop, no new grant, no new migration.

| Arm | Trigger | Destroys |
|---|---|---|
| Idle (pre-existing) | the instance idle TTL | paused snapshots past their TTL |
| **Strand** (new) | none — always runs | terminal rows still holding a provider handle |
| **Reclaim** (new) | a switch entry with `reclaim: true` | that provider's paused snapshots, after a floor grace |
| **Superseded** (new) | a key rotation | paused snapshots stamped with a superseded generation |

## 2. The decisions that mattered

**Reclaim is OPT-IN; waste collection is not.** Warm leases are paused at the end of *every*
Commander turn, warm is default-on, and `findResumablePausedLease` has no age bound — so the
paused population **is the in-use population**. A plain deny-list that destroyed it would
irreversibly delete the snapshot of a conversation a human is mid-way through, inside that
tenant's own BYO E2B account, with no notification anywhere on the destroy path. That would also
invert the module's own first line: *"a deny-list over a placement dimension, NOT an identity
revocation."* So a plain switch stops placement and touches nothing; `reclaim: true` is an
operator explicitly asking for the destructive act. The strand arm needs no such gate — a terminal
row with an unreleased handle has no user-visible state.

**Two readings of one document, and they cannot disagree.** A reaper must fail **open** where
leasing fails **closed**: `evaluateKillSwitches` returns `killed: true` on a transient database
error, and force-killing virtual machines on a database hiccup is the worst outcome available. But
a second, independent accessor would have diverged *destructively* — handed
`{dimension:"provider", value:"gvisor"}`, a real legacy lease-provider value outside
`EXECUTION_TARGET_KINDS`, a vocabulary-free reader returns a non-empty **destroy** set while
leasing refuses the same document as unreadable. One `parseKillSwitchDocument`, two consumers, and
a 14-shape table asserting they agree on readability.

**An explicit reclaim outranks the warm-economy toggle.** `enableWarmSandboxReaper` means "do not
bother reaping idle snapshots". An operator who threw a switch with `reclaim: true` has expressed a
stronger, far more specific intent, and an incident-response reclaim must not be silently disabled
by a background toggle with no UI. The reclaim and superseded arms run above the flag gate; the two
routine arms stay under it.

**The only force-kill in the system is no longer gated on routines.** `scheduleWarmSandboxReaper`
was registered inside `if (config.heartbeatSchedulerEnabled)` — an operator-facing knob that
advertises itself as governing schedule ticks — while what *mints* these sandboxes is not gated on
it at all. Moved to module scope, following the precedent the repo already set and pinned for
`scheduleClaudeConfigDirSweeper`.

## 3. Inherited deferral #5, closed

The handoff assigns "old-key kill-switch enforcement" here, and `e2b-credential-authority.ts`
pointed at this ticket by name. **The prerequisite did not exist:** `deriveE2bKeyGeneration`
returns a company's *current* key version, and nothing recorded the generation a sandbox was
created under, so "superseded" was not computable.

The acquire path now stamps `metadata.keyGeneration` (e2b only, best-effort — a bookkeeping lookup
must never fail a sandbox creation), and the reaper reclaims paused snapshots whose recorded
generation is no longer current. Scoped to paused: a superseded snapshot is dead weight because
AoA's own credential authority refuses to resolve the old generation, so AoA will never resume it.
**That justification rests on our code, not on E2B's semantics** — whether E2B would still honour
the old key is untestable without the operator-dispatched keyed lane, and is irrelevant given the
refusal. `e2b-credential-authority.ts`'s comment now says built rather than deferred.

## 4. Acceptance → named executable artifact

| Invariant | Artifact | Result |
|---|---|---|
| J1 reclaim happens on explicit intent, scoped to that provider | `warm-sandbox-reaper-reclaim.test.ts` | pass |
| J2 live/active leases untouched | inherited: the reaper only ever scans paused/terminal | pass |
| J3 unreadable/absent document reclaims nothing | same file, incl. a **throwing reader** | pass |
| J4 both strands reclaimed, with a real provider kill | `warm-sandbox-reaper-strand.test.ts` | pass |
| J5 unkilled provider's paused path unchanged; strand arm switch-independent | both files | pass |
| J6 no new grant/migration/loop; one new store surface | the diff (three read queries + one claim) | pass |
| J7 reader built from the owner `db` inside the sweep | `warm-sandbox-reaper.ts`; DI seam is test-only | pass |
| J11 registration outside the heartbeat gate | `warm-sandbox-reaper-registration.test.ts` | pass |
| J12 explicit reclaim outranks the flag, routine arms do not | `warm-sandbox-reaper-reclaim.test.ts` | pass |
| J13 instance-wide semantics pinned (every company's leases) | same file | pass |
| J10 two CONCURRENT sweeps produce exactly ONE kill | `warm-sandbox-reaper-race.integration.test.ts` (embedded PostgreSQL, two-party barrier) | pass |
| J14 vocabularies still intersect on `e2b`; `pooled_gvisor` reclaims nothing | same file | pass |
| J9 the two readers never disagree | `execution-kill-switches.test.ts` 14-shape table | pass |
| §5 superseded reclaim, four safety directions | `warm-sandbox-reaper-superseded.test.ts` | pass |

## 5. Mutation ledger

| Group | Mutants | Killed |
|---|---|---|
| One parse / two readers (N1–N8) | 8 | 8 |
| Strand arm (S1–S4) | 4 | 4 |
| Reclaim arm (R1–R5) | 5 | 5 |
| Flag ordering (J12a–b) | 2 | 2 |
| Superseded arm (K1–K5) | 5 | 5 |
| Registration guard | 1 | 1 |
| CAS predicate (J10, both directions) | 2 | 2 |
| **Total** | **28** | **28** |

**S1 is the one worth naming**: it reverts D3 to the design's revision-1 shape (widen the reaper's
SELECT, reuse the paused CAS) and dies — which is the proof that the second claim primitive is
load-bearing rather than decorative. Revision 1 would have shipped a fix that did nothing.

### 5.1 The third survivor was a real defect, and it took two attempts to see

J10 was listed as an open limit in the first draft of this doc. Closing it produced the most
valuable finding in the lane.

The first race test — two `sweepIdleWarmSandboxes` calls under `Promise.all` — **passed, and kept
passing with the claim predicate stripped entirely.** It proved nothing: the two sweeps serialize,
so the second lists after the first has finished its kill and sees no row. A race test that cannot
observe a double-kill is a check that nothing runs.

Replaced with a two-party barrier that holds BOTH sweeps inside `listTerminalUncleanedLeases`
until each has read the row, then releases them together. **That version failed with 2 kills.**

The defect: `claimTerminalUncleaned` wrote `cleanup_status='failed'` while its predicate accepted
anything `IS DISTINCT FROM 'success'` — so the second concurrent claimer matched the row the first
had just claimed. **A claim whose predicate does not exclude the state it writes is not a
compare-and-swap.** Claimable is now `{NULL, 'pending'}` (unattempted), the scan mirrors it, and
the retry bound becomes structural instead of aspirational.

It also corrected a test that asserted the opposite: an earlier strand case required
`cleanup_status='failed'` to be reclaimed, which contradicted the design's own retry bound *and*
was what forced the non-CAS predicate. The terminal STATUS never told you whether a teardown had
been attempted; `cleanup_status` does.

**Two more survived first, both defects in my own tests:**
- **N1** — I documented that `"reclaim": "true"` must refuse and never tested it. Without the
  check it coerces to `false`, so an operator's explicit destructive intent silently becomes a
  no-op while they believe it is armed. Under-destroying is the safe direction and is still the
  "a switch they just threw does nothing" hazard the module refuses everywhere else.
- **R2** — the single most dangerous path in the lane. I had tested an unreadable *document* but
  never a *throwing reader*, so nothing proved that a database blip cannot force-kill a fleet.

## 6. Limits, stated

1. **Distributed sandboxes are not reclaimed — a CHOICE, not an impossibility.** Revision 1 of the
   design claimed the control plane holds no handle; that was false (`server` depends on `e2b`
   directly, and the sandbox id is durably held via `job_events`). Live distributed work is left to
   drain because Lane C's I12 says so and the JOB-007 precedent shows what forcing it costs;
   orphaned-attempt convergence is inherited deferral **#2**, owned by **MIG-002**.
2. **The switch is instance-wide and reaches every tenant** — pinned by J13, not merely documented.
   The document has no tenant axis, each lease is killed inside that company's own BYO E2B account,
   and nothing on the destroy path notifies anyone. An operator throwing `reclaim` should know it.
3. **`pooled_gvisor` reclaims nothing.** The kill-switch vocabulary and `environment_leases.provider`
   intersect on `e2b` **alone** — `pooled_gvisor` never equals `gvisor`, and `gvisor` is excluded
   from the reaper's scans. Throwing it stops placement only. Pinned by J14.
4. **No write path or UI for throwing a switch** — still REL-001/005, unchanged from Lane C. The
   runbook SQL in Lane C's result now needs a `"reclaim": true` variant for the destructive form.
5. **A teardown that was attempted and did not confirm is never retried.** That is the retry
   bound, and it is a real trade: a sandbox whose kill fails once is not reclaimed again by this
   sweep. The alternative — retrying every five minutes forever against a provider that is
   refusing — is worse. Such rows remain visible in `environment_leases` with
   `cleanup_status='failed'` for an operator or a future sweep with its own policy.
6. **Whether CLI-004's provider-side sweep can see a legacy-created sandbox** remains unverified
   (terrain §1). It does not block this lane, which no longer depends on that sweep.
