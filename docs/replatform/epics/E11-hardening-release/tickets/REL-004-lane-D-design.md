# REL-004 Lane D — reconcile active provider resources on kill (clause 3b) · design

**Ticket** REL-004 · **Clause** 3b · **Epic** E11 · **Branch** `docs/replatform-program` (PR #323)
**Terrain** [`REL-004-lane-D-terrain.md`](./REL-004-lane-D-terrain.md) ·
**Predecessor** [`REL-004-lane-C-result.md`](./REL-004-lane-C-result.md), landed and CI-green.

> **REVISION 2, after the plan review.** Revision 1 was reviewed by four independent lenses; it
> produced 43 findings, 8 confirmed HIGH after an independent refutation pass. **Three of its six
> decisions did not survive contact with source, and its central premise was false.** What changed
> and why is §7 — kept in the document rather than quietly overwritten, because the false premise
> was about to be written into a durable result doc, which is precisely the failure Lane C §2.4
> was written about.

**Goal:** when a provider is killed, the resources the control plane can reclaim *are* reclaimed,
the ones it must not touch are left to drain, and every limit is stated as a choice with a reason
rather than as an impossibility.

---

## 1. Corrected premise: the control plane CAN reach these sandboxes

Revision 1 claimed the control plane "holds no handle, by construction". **That is false**, and the
check that produced it was badly aimed — a grep of `server/package.json` dependency *names* for
`sandbox|worker`, which structurally cannot find a package called `e2b`.

| Claim in revision 1 | Truth | Evidence |
|---|---|---|
| server has no provider package | **False** | `server/package.json:67` `"e2b": "^2.30.5"`; `sandbox-provider-runtime.ts:585` `return import("e2b")` |
| the control plane cannot call the provider API | **False** | `sandbox-provider-runtime.ts:823-827` `const sandbox = await connect(config, input.providerLeaseId); … await sandbox.kill?.()` — on a schedule, today |
| no distributed sandbox id is held | **False** | `attemptStartedPayloadV1Schema = z.object({ sandboxId })` (`worker-protocol/src/events.ts:55`) → `payload: event` (`job-events.ts:75`) → `event: jsonb("event")` on an append-only ledger (`job_events.ts:54`) |
| `leases` carries no sandbox id | **True** | `packages/db/src/schema/leases.ts` — the only accurate half |

So the scope question is not "what is possible" but "what should we do with authority we already
have". The answers below are choices, each with a reason.

## 2. What clause 3b will and will not do

| Family | Action | Reason |
|---|---|---|
| Legacy E2B, **paused**, killed provider | **Reclaim, promptly** | The reaper already force-kills these; a killed provider should not wait out the idle TTL. |
| Legacy E2B, **stranded** (terminal, handle present, never confirmed cleaned) | **Reclaim, switch-independently** | Includes MIG-008's orphan (§4) and the crash-window orphan (§4.1). Pure waste in every case. |
| Legacy E2B, **live/active** | **Leave to drain** | Lane C I12; MIG-008 Invariant #2. |
| Distributed, **live attempt** | **Leave to drain — a CHOICE, not a limit** | We hold the id via `job_events`. Destroying it contradicts I12 and the JOB-007 precedent, which flips leases to `revoked` and cancels non-gracefully. |
| Distributed, **orphaned attempt** (lease gone, no terminal event) | **Deferred, with an owner** | This is inherited deferral **#2** (`createJobControlSweeper` has no live trigger), assigned by the Wave-3 handoff to **MIG-002**, not here. Absorbing it would take another ticket's scope. |
| **Superseded-key sandboxes** (inherited deferral #5) | **Prerequisite missing — see §5** | |

## 3. Decisions

**D1 — The warm-sandbox reaper is the owner, and its registration moves.**
It is the only scheduled force-kill, already owns the claim→kill sequence, and runs on the **owner**
`db` handle — so no `aoa_app` grant (terrain §2.3 verified `environment_leases` has none).

*Correction:* revision 1 called it "flag-independent". It is independent of
`AOA_DISTRIBUTED_EXECUTION_ENABLED`, but it is registered **inside**
`if (config.heartbeatSchedulerEnabled)` (`index.ts:1245`, call at `:1292`), a documented,
operator-facing knob (`docs/guides/board-operator/routines.md:23`) that advertises itself as
governing *schedule ticks* and says nothing about disabling the only force-kill — while minting is
**not** gated (`commander-sandbox.ts:96`; `routes/issues.ts:99`). An incident-response reclaim must
not vanish because an operator turned off routines. The registration moves out of that block,
following the precedent the repo already set and pinned:
`index.ts:1752-1761` ("deliberately NOT inside the `config.heartbeatSchedulerEnabled` block"),
guarded by `claude-config-dir-sweeper.test.ts:88-109`.

**D2 — A killed provider gets a SEPARATE provider-scoped pass, not a global cutoff of zero.**
`listPausedLeasesOlderThan(cutoff)` takes one cutoff for the whole result set, so the naive
`cutoff = killed.size > 0 ? now : ttl` would zero-grace **every** paused external-provider lease on
the instance the moment *any* switch exists — including a `desktop` switch that names no legacy
lease at all. Composition instead: the existing TTL sweep, unchanged, **plus** one provider-scoped
pass per killed value.

**D2a — DECIDED: reclaim always for waste, opt-in for user-visible state.**
Two arms, deliberately different, because they destroy different things:

- **Arm 1 — stranded rows (§4): reclaim ALWAYS, switch-independent.** A terminal row holding an
  unreleased provider handle has no user-visible state and no owner; leaving it costs money and
  buys nothing. This arm is what makes "reconciles active provider resources" true on every sweep
  rather than only when an operator opts in, and it is what closes the MIG-008 orphan.
- **Arm 2 — healthy paused snapshots on a killed provider: requires explicit `"reclaim": true`
  on the switch entry.** Irreversible, and it hits in-use state.

Rationale for arm 2 being opt-in:
Verified: warm leases are paused at the end of **every** Commander turn
(`commander-sandbox.ts:157-175`), warm is default-on (`warm-sandbox-policy.ts:41-42`), and
`findResumablePausedLease` has **no age bound** (`environments.ts:225-245`) — so the paused
population is the *in-use* population, and a zero cutoff kills the snapshots of conversations a
human is mid-way through, in that tenant's own BYO E2B account, unrecoverably
(`environment-runtime.ts:531-536` retires the row and creates fresh). That inverts the module's own
first line — *"A KILL SWITCH IS A DENY-LIST OVER A PLACEMENT DIMENSION, not an identity
revocation"* — and Lane C's "reversible in seconds".

So the deny-list alone must **not** destroy. Reclamation is a distinct, explicitly-thrown intent:
`{"dimension":"provider","value":"e2b","reason":"…","reclaim":true}`. Absent `reclaim`, a switch
stops placement and nothing else. The codebase already refuses zero as an operator intent —
`normalizeWarmIdleTtlMinutes` clamps to `[1,1440]` (`warm-sandbox-constants.ts:19-23`) — so even
with `reclaim` the pass honours a one-minute floor.

**D3 — The strand fix is a SECOND CLAIM PRIMITIVE, not a wider SELECT.**
Revision 1 proposed widening the reaper's query to `expired` + `cleanup_status='pending'`. **That
is inert.** `destroyPausedLease`'s first statement is `expireLeaseIfPaused(lease.id)`
(`warm-sandbox-reaper.ts:70`), whose CAS is `WHERE status='paused'` (`environments.ts:324`). Every
row the wider SELECT adds fails that CAS, returns `{destroyed:false}`, and the sandbox lives. It
would have shipped a fix that does nothing — the failure class this programme is named for, in the
fix for an instance of it.

Add one store primitive (no migration: `cleanup_status` is plain `text`,
`environment_leases.ts:42`, over `["pending","success","failed"]`):

```
claimTerminalUncleaned(id):
  UPDATE environment_leases SET cleanup_status='failed', updated_at=now()
  WHERE id=$1 AND provider_lease_id IS NOT NULL
    AND status IN ('expired','failed') AND cleanup_status IS DISTINCT FROM 'success'
  RETURNING *
```

and branch `destroyPausedLease` on the row's status instead of calling the paused CAS
unconditionally. Claiming to `'failed'` first is the latch **and** the retry bound: the kill
promotes it to the real outcome, so a permanently-failing kill is attempted once, not every five
minutes forever.

**D4 — Two readings of one document, ONE parse.**
A reaper must be fail-**open** where leasing is fail-closed: `evaluateKillSwitches` returns
`killed:true` on a transient database error, and force-killing VMs on a database hiccup is the
worst outcome available. But a second, independent accessor would diverge destructively: for
`{"dimension":"provider","value":"gvisor"}` — a real lease-provider value outside
`EXECUTION_TARGET_KINDS` — leasing returns `policy_unreadable` while a vocabulary-free accessor
would return a non-empty destroy set. So factor **one** parse:

```
parseKillSwitchDocument(document, knownProviders): "unreadable" | readonly ValidatedSwitch[]
```

with `evaluateKillSwitches` and `killedProviders(document, knownProviders)` as its two consumers.
`killedProviders` maps `"unreadable" → ∅`.

**D5 — The reader is constructed inside the sweep, from the owner `db`.**
Lane C §2.2's lesson, with the hazard *inverted*: there, a permissive injected reader disabled the
stop button; here an **aggressive** one force-kills. Build it in `sweepIdleWarmSandboxes`, not
through the existing four-key DI bag (`warm-sandbox-reaper.ts:27-35`). Also update
`execution-kill-switch-policy.ts:20-22`, whose DORMANCY comment ("imported only by
`job-leasing.ts` … under AOA_DISTRIBUTED_EXECUTION_ENABLED") becomes false the moment this lands.

**D6 — State the vocabulary join to the OPERATOR, not just to engineers.**
`EXECUTION_TARGET_KINDS` ∩ legacy lease providers = **`{"e2b"}`**. `pooled_gvisor` never equals
`gvisor`, and `gvisor` is excluded by `NON_SANDBOX_LEASE_PROVIDERS` anyway (`environments.ts:20`).
Throwing `pooled_gvisor` stops placement and reclaims nothing; the runbook must say so.

## 4. The two strands D3 must cover

1. **MIG-008's** — `casClaimPaused` sets `expired` + `cleanup_status='pending'` and does not kill
   (`legacy-resource-reconciliation-store.ts:57-64`).
2. **The crash window** — the reaper's own CAS calls `expireLeaseIfPaused(lease.id)` with **no**
   `cleanupStatus`, so a process death between claim and kill leaves `expired` with the field
   *unchanged*. Revision 1's `='pending'` predicate missed this entirely. Hence
   `IS DISTINCT FROM 'success'`.

Note the exception path sets status **`failed`**, not `expired`
(`environment-runtime.ts:689-691`) — hence `status IN ('expired','failed')`.

## 5. Inherited deferral #5 — and why it cannot be built as written

The Wave-3 handoff assigns "old-key kill-switch enforcement" to REL-004 clause 3, and
`e2b-credential-authority.ts:21-23` points here by name: *"The LIVE force-kill of sandboxes tagged
with a superseded generation is REL-004's kill-switch primitive."* Revision 1 never mentioned it.

**The prerequisite does not exist.** `deriveE2bKeyGeneration` (`e2b-credential-authority-wiring.ts:20`)
returns the company's *current* key version from `runtime_provider_keys → company_secret_versions`.
**Nothing tags a live sandbox or lease with the generation it was created under** — verified: zero
matches for `keyGeneration` on the live acquire path (`sandbox-provider-runtime.ts`,
`environment-runtime.ts`). "Superseded" is therefore not computable for an existing sandbox.

Options, to be decided in review rather than assumed:
- **(a)** Record the generation into `environment_leases.metadata` (jsonb — no migration) at acquire,
  then superseded = `metadata.keyGeneration !== deriveE2bKeyGeneration(company)`. Reclaim only
  **paused** superseded snapshots: a snapshot that can never be resumed with the current key is
  pure waste, and killing it touches no live work.
- **(b)** Defer with the limit stated, and correct `e2b-credential-authority.ts`'s pointer so two
  documents stop disagreeing.

**DECIDED: (a), scoped to PAUSED snapshots only.** It closes a deferral the handoff assigns here
rather than pushing it to a third wave; it resolves a promise `e2b-credential-authority.ts` makes
about this ticket, and leaving that dangling is the same "two documents assert contradictory
things" pattern REL-004 Lane A exists to eliminate; and it is small — `metadata` is jsonb, so no
migration. Scoped to paused it cannot touch live work: a snapshot that can never be resumed under
the current key is waste by definition.

The cost, stated: it adds one recorded field to a LIVE legacy acquire path. That is the only
change this lane makes to a running code path, and it is kept to exactly one field.

## 6. Invariants

J1–J8 from revision 1, amended, plus J9–J14 from the review.

| # | Invariant | Non-vacuity it needs |
|---|---|---|
| J1 | A killed provider's paused legacy leases are reclaimed promptly **when `reclaim` is set** | a same-fixture case with `reclaim` absent that reclaims nothing |
| J2 | A live/active lease is never killed by this path | both directions |
| J3 | Unreadable/malformed/absent document reclaims NOTHING | incl. the read-failure sentinel |
| J4 | Both strands (§4) are reclaimed | a test that reproduces each strand, not a hand-built row |
| J5 | An unkilled provider's **paused-path** behaviour is unchanged; the strand arm is switch-independent **by design** | (restated — revision 1's J5 contradicted D3) |
| J6 | No new grant, no new migration, no new scheduled loop; **one** new store primitive | the diff |
| J7 | The reaper enumerates no provider-side sandbox list and reads no `job_events` sandbox id; the reader is built from the owner `db` | (replaces revision 1's unfalsifiable import assertion) |
| J8 | Idempotent across consecutive sweeps | |
| J9 | The two readers never disagree about readability | ONE shared fixture table fed to both |
| J10 | Two **concurrent** sweeps produce exactly ONE provider kill | race two sweeps on one row; both D1 replicas run this loop |
| J11 | Registration sits outside the heartbeat gate | source assertion in the `claude-config-dir-sweeper.test.ts:103-109` shape |
| J12 | With `enableWarmSandboxReaper` OFF and a switch thrown, the decided behaviour holds | every existing reaper test stubs it true |
| J13 | A switch reaps EVERY company's leases of that provider | two companies, one switch — pins the real cross-tenant semantics |
| J14 | The switch and lease-provider vocabularies still intersect on `e2b` | plus a `pooled_gvisor` case reaping zero |

## 7. What revision 1 got wrong

| # | Revision 1 | Reality |
|---|---|---|
| 1 | "no handle, by construction" | `server` depends on `e2b` directly and kills by id today; the distributed id is in `job_events` (§1) |
| 2 | D3 widens the reaper's SELECT | **Inert** — the paused-only CAS rejects every added row (§D3) |
| 3 | D3's predicate `= 'pending'` | Misses the crash-window strand (§4.1) |
| 4 | D2 zero grace | Destroys in-use Commander snapshots irreversibly (§D2a) |
| 5 | D1 "flag-independent" | Subordinate to `heartbeatSchedulerEnabled` (§D1) |
| 6 | D6 `killedProviders(document)` | One-arg cannot reproduce the vocabulary refusal; diverges destructively (§D4) |
| 7 | J5, J7 | Self-contradictory / unfalsifiable (§6) |
| 8 | silent on deferral #5 | The handoff and MIG-008 both assign it here (§5) |
