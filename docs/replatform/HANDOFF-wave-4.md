# Re-platform — Wave 4 handoff (cut the sinks over)

> **SUPERSEDED — 2026-09-18 by [`HANDOFF-2026-09-18-post-e7-1-sink-cutover.md`](./HANDOFF-2026-09-18-post-e7-1-sink-cutover.md).**
> The E7-1 real-E2B distributed run was PROVEN end-to-end on staging (run `8dc34e90`, verifier `ok=true`;
> E7-F011 + E7-F036 merged). The sink-cutover wave described here is still the next wave — the new handoff
> restates it with the E7-1 blocker removed, the E3-F037 billing bridge sequenced first, and the current
> box/runbook/deploy state. Kept for detail (§3-4 forward work, §1 per-ticket process); read the new file first.

**As of:** branch `docs/replatform-program` tip `a089d1383` (ONE PR #323, worktree `C:\e3`).
Worktree clean, nothing unpushed, PR CI green.
**Last code SHA verified on BOTH lanes:** `c341cf680` (PR gate + D1 Merge Train). Everything
after it is documentation.

This supersedes [`HANDOFF-wave-3-4.md`](./HANDOFF-wave-3-4.md) for forward work. That document
remains the record of Wave 3 and of the gate; **its §1 process and §6 deferral ledger are still
authoritative and are referenced, not duplicated, below.**

---

## 0. How to start the session

**Worktree:** `C:\e3` — a dedicated checkout, NOT the OneDrive worktree.
**Branch:** `docs/replatform-program` — the same single long-lived integration branch (PR #323).
**Do NOT create a new branch, and do NOT merge PR #323.** No per-epic merges to `main` is a
locked decision (`program-design.md` §"Integration branch and PR strategy (LOCKED)").

**Preflight — run this first; it FAILS rather than printing something to eyeball:**

```bash
cd /c/e3 \
  && [ "$(git rev-parse --abbrev-ref HEAD)" = "docs/replatform-program" ] \
  && git merge-base --is-ancestor a089d1383 HEAD \
  && [ -z "$(git status --porcelain)" ] \
  && [ -f docs/replatform/HANDOFF-wave-4.md ] \
  && echo "PREFLIGHT OK" \
  || echo "PREFLIGHT FAILED - wrong worktree, wrong branch, behind, or dirty"
```

`PREFLIGHT FAILED` means stop and fix the environment. Do not proceed on the assumption that it
is probably fine.

**Then:**

1. Read this document end to end.
2. Read [`HANDOFF-wave-3-4.md`](./HANDOFF-wave-3-4.md) **§1 (the process)** and **§6 (the
   deferral ledger)**. §1 is binding and unchanged. §6's rows #2 and #5 are now closed; #1 has a
   re-scope note that matters.
3. Read [`DEFERRAL-1-credential-terrain.md`](./epics/E5-workspaces-secrets/tickets/DEFERRAL-1-credential-terrain.md)
   **including revision 2** before touching item 1 below. It is the whole map for the critical
   path and it corrects two things a first read of the code will get wrong.
4. **Do not re-verify §2 of this document.** Those are landed, CI-green facts.

---

## 1. The process is unchanged and still binding

[`HANDOFF-wave-3-4.md` §1](./HANDOFF-wave-3-4.md) in full: terrain-map → re-verify → **commit the
design before any code** (its SHA is the ticket's Start SHA) → review the plan → fail-first TDD →
**adversarial review (attack it, do not re-read it)** → re-verify and fix → **mutation-test every
guard** → result doc + fast-forward push + watch CI to green.

It has now been run on ~25 tickets and caught a real, often-HIGH defect on essentially every one.
It did so on all four tickets in this session, including the ones that looked like pure wiring.

**Two additions earned this session. Both cost real defects; please keep them.**

> ### A caller is not a caller until you trace it to a BOOT ROOT
>
> Counting one hop is not counting callers. In this session I wrote that DAT-004's
> `resolveExecutionSecret` "has a production caller" — true at `secret-broker.ts:234`, and false
> at the root, because the broker's only constructor is `egress-proxy.ts:150` and
> `createFenceAwareEgressProxy` has **zero** callers. I made that error *inside a terrain document
> warning about unreachable mechanisms*.
>
> Count hops until you reach `index.ts`, a route registration, or a scheduler — not until you
> find one caller.

> ### Before designing a new mechanism, check what the existing one already computes and discards
>
> This paid out **three times** in one ticket. `resolveWorkloadPolicy`'s contract already declared
> `sourceKind` and the rollout source discarded it. `reapExpiredLeases` already SELECTed the
> attempt identities and returned counts. DAT-004/DAT-005 were already built, hardened and
> shipped when a deferral implied they were missing.

**The two rules from §1 that produced every defect still hold:** never trust a subagent's green,
never trust your own first read; and *a check that nothing runs is not a check*. The second grew
new variants this session — a check that RUNS but cannot fail (a comparator diffing a value
against a copy of itself), and the same tautology one level down (a per-sink denominator where
one sink structurally cannot diverge).

---

## 2. What landed — do NOT redo any of this

33 commits from `723da5f49` to `a089d1383`. Every code push green on the PR gate **and** the D1
two-replica lane.

| Ticket | State | Docs |
|---|---|---|
| **REL-004 clause 3** (kill switch + reclaim) | **DONE.** 3a stops new leases on the real poll path; 3b reconciles reclaimable resources. Inherited deferral **#5 CLOSED**. | `E11/tickets/REL-004-lane-{C,D}-result.md` |
| **MIG-005/006/007 SHADOW** (Wave 3 item 4) | **DONE.** The named artifact could not report a divergence — an identity mapping diffed each field against a copy of itself (measured: 2,000 snapshots, 0 divergences). Replaced field-equality with **admissibility**; wired all three sinks. | `E10/tickets/MIG-005-006-007-shadow-*.md` |
| **Gate clause 3** (rollback path per sink) | **DONE** for the org heartbeat; explicitly **NOT** ticked for the three shadow-only sinks. | `E11/tickets/GATE-clause-3-rollback-*.md` |
| **MIG-002 slice 1** — the routing dial | **DONE.** Live per-resolution (no restart) and **per-sink** via a new optional `sources` allow-list. | `E10/tickets/MIG-002-dial-*.md` |
| **MIG-002 slice 2** — convergence | **DONE.** The lease reaper is started and a reaped attempt now converges its run. Inherited deferral **#2 CLOSED**. | `E10/tickets/MIG-002-convergence-*.md` |
| **Deferral #1 terrain** | **DONE** (terrain only). No architectural question remains. | `E5/tickets/DEFERRAL-1-credential-terrain.md` |

**Live defects found and fixed on the way** (each has a result-doc section and mutants):

1. **A capacity leak that throttled LEGACY runs.** A converted-but-unplaced attempt kept its org
   concurrency slot forever, and legacy shares that budget — so arming a canary before enrolling
   a worker leaked a slot per run. *Fail-safe for execution is not fail-safe for state.*
2. **The fifth cancel writer never reached the handling built for it.** `if (!port) return;` made
   its own convergence block dead in the one state it was written for.
3. **The comparator tautology** (above), plus the same tautology one level down.
4. **`nextDelayMs` had zero callers anywhere**, including its own tests.

**Gate status** (`HANDOFF-wave-3-4.md` §4): clauses **1, 3, 4, 5 satisfied**; **clause 2 PARTIAL**
— the divergence rate is real and end-to-end but over a **seeded corpus**, because no live lane
drives a Commander turn, crew dispatch or extraction. Stated, not papered over.

---

## 3. Wave 4 — the work, in priority order

| # | Work | Why here |
|---|---|---|
| 1 | **Deferral #1 — wire the credential path** → **DAT-008, slices 1–4 LANDED + CI-green (`4840c04e1`)**. Slices 5–7 remain (worker redemption, warm-resume re-resolution). See [`DAT-008-result.md`](./epics/E5-workspaces-secrets/tickets/DAT-008-result.md). | **THE critical path.** MIG-005/006/007 ACTIVE are all blocked on it and nothing else unblocks them. |
| 2 | **MIG-005** Commander turns → `commander_turn` | Lowest blast radius; start here once (1) lands. |
| 3 | **MIG-006** crew dispatch → `crew_run` | |
| 4 | **MIG-007** extraction / compaction / readiness → `one_shot` | |
| 5 | **MIG-001** Decision #117 target/credential routing | |

**One sink at a time, each with its own soak.** That ordering is now *expressible* — slice 1 of
MIG-002 added the per-sink `sources` axis, which did not exist when the Wave-3/4 handoff
prescribed it.

### 3.1 ~~A DECISION ONLY A HUMAN CAN MAKE~~ — TAKEN. Ticket = **DAT-008**.

> **RESOLVED.** The Integration Gate Owner chose a new ticket in E5: **DAT-008**, with its own
> terrain, design and result docs. Slices 1–4 have landed and are CI-green on `4840c04e1` (PR gate
> incl. `ci-required`, and the D1 two-replica lane, both on that exact SHA).
>
> **Half the premise below was wrong, and the correction matters more than the decision.**
> *"No ticket in the Wave-4 list owns it"* is true of the epic ticket list and **FALSE of the
> plan**: **CM-013** (`current-main-crosswalk.md:29`) owns this seam and names MIG-005/006/007 in
> its own dependency list. The *ownership* question was real; the *architecture* question was not —
> CM-013, `program-design.md:35` and `:765` all already fixed the answer as `materialization: env`
> + `usePolicy: sandbox_local_only`. §3.2's implication that the proxy is "the only path" is a
> statement about the **connector-OAuth** credential class, not the model-provider key.
> See [`DAT-008-terrain.md`](./epics/E5-workspaces-secrets/tickets/DAT-008-terrain.md) revision 1.
>
> **Lesson for the next reader of this document: check the crosswalk, not just the epic list.**

**What remains on DAT-008** — slice 5 (worker redemption, env synthesis, redaction-canary seeding),
slice 6 (deferral #3 is closed on the MINT side only), slice 7 (warm-resume re-resolution, which is
required *before* MIG-005 because MIG-005 is both the first sink and the warm-lease one).

**One thing to measure, not assume, before MIG-005:** how many agents carry a *plain-literal*
provider key outside strict secret mode. Those cannot be cut over — DAT-008 refuses to mint for
them and leaves them on the legacy executor — and the residual is only acceptable if the number is
small.

### 3.1b The original text, kept for the record

**Deferral #1 has no owner in the plan.** DAT-004 owns it by its outcome sentence
(`program-design.md:648`), **DAT-004 has SHIPPED**, and no ticket in the list above owns the
remaining seam. The plan sequences three cutovers whose blocker it does not schedule.

Someone must choose: reopen DAT-004, add a ticket, or fold the seam explicitly into MIG-005.
**Do not silently absorb it into another ticket** — that is how the programme previously ended up
with work assigned to a ticket that then did not do it.

### 3.2 What item 1 actually requires

Read the terrain's **revision 2** first. In short:

- The FROZEN protocol **carries** a handle fine, but there is **no wire verb to REDEEM one** —
  `WORKER_PROTOCOL_OPERATIONS` is a closed list of ten and none is a secret op. So
  `env`/`file` materialization is **not implementable**; the **fence proxy is the only path**.
- **DAT-004 and DAT-005 are built and correct.** Do not rebuild them — that is the expensive
  mistake here. They are, however, **entirely unwired** (§1 of the process, boot-root rule).
- The plumbing for the proxy path already exists: both v1 adapters (`claude_local`,
  `codex_local`) have `*_BASE_URL` in the sandbox env allowlist, and the sandbox already carries
  `AOA_API_URL` + the run-JWT.

The wiring, in order: compose the egress-proxy/broker chain at boot; populate `secretHandles` in
the lease envelope (`job-leasing.ts:362` is a literal `[]`); write `job_secret_handles`; replace
the inert `failClosedEgressDispatcher`; point each CLI's base URL at the proxy.

**One experiment, not a fork:** most CLIs want *some* value in `*_API_KEY` before they will
attempt a request. Establish what bearer they accept (run-JWT? per-run placeholder the proxy
swaps?) early — it is cheap and it shapes the staging code.

**Traps** (all evidenced in the terrain): do not add a value field to the wire — the package is
FROZEN and its strictness is deliberate; do not assume `env` materialization because it matches
the legacy path — DAT-004's own review already fixed a HIGH where an OAuth handle could be
coerced into a sandbox env; and note the wire demands a **UUID** `handleId` while the DB column
is untyped `text`, so a minter that writes a slug produces an envelope that fails validation.

---

## 4. Independent items — safe to pick up in any order

| Item | Note |
|---|---|
| **The drain** | Unwired, and **it has a real bug**: it calls `assertRollbackSafe(organizationId)` while all three implementations take a **companyId**. Both are `(string) => Promise<void>` so it typechecks, and the drain's catch is bare — a naively wired drain marks **every** Organization `rollback_pending` and cancels nothing **while reporting a clean sweep**. Also: `listActiveAttempts` has **no SQL at all** and its row shape carries no `attemptId`; `DRAINED_STATUSES` counts `"cancelled"`, the one outcome that strands a run, and it is the only status with no test. |
| **The dead Revoke control** | `revokeExecutionTarget` writes a `status:"pending"` row that nothing reads — `createExecutionTargetRevocationFanout` has zero callers while its producer is live. Either wire it or disable the control; a button that silently does nothing is worse than an absent one. |
| **Suspended-org blind spot** | `listAdmittedOrganizationIds` requires `status = 'active'`, so an Organization suspended while holding live leases is never swept and never reported skipped — a convergence blind spot exactly where an operator just suspended a misbehaving tenant. |
| **Gate clause 2's shortfall** | Needs a deployment with the flag on, an Organization in `shadow`, and real traffic. The instrument exists (`mig-shadow-evidence.integration.test.ts`); the traffic is not this branch's to manufacture. |

---

## 5. Limits that are structural, not oversights

1. **Convergence flag-off is impossible.** Flag-off allocates no `aoa_app` pool, and
   `reapOrganization` runs through `runInTenant` on it. This is why the rollback runbook says to
   keep `AOA_DISTRIBUTED_EXECUTION_ENABLED` set across a restart.
2. **The kill switch has no write path.** Throwing it means hand-executed SQL, and it is
   instance-wide per provider — no Organization and no sink dimension. REL-001/005 own that. So
   "reversible in seconds" is still only half true.
3. **Only 1 of 7 shadow fields is compared.** Four have no second authority at all. Reported per
   record rather than hidden, and the denominator travels with the number.
4. **`one_shot` has no per-source admission authority**, so its shadow signal is weaker than the
   other two sinks'. Stated per sink in the evidence.

---

## 6. Operational notes

- **D1 nonce.** Bump `docker/d1/campaign.env` **if the change alters runtime behaviour on the
  `server/src` path** — that lane's push filter excludes it. Bump **after the last** `server/src`
  change, not once per ticket. Do **not** bump for code with no runtime caller. Note the lane
  *does* drive `reapOrganization` through the dormant `/worker-control/_test/reap` route
  (`tests/d1/lib/e6f-harness.mjs:1703`), so reaper changes are not "unwired".
- **Windows integration tests** need `AOA_RUN_WIN_INTEGRATION=1`; without it they silently skip
  and a mutation harness will report false survivors.
- **`verify` takes ~30–40 minutes.** Let the previous run finish before pushing again, so a red
  stays attributable to the last push.
- **Frozen and never to be edited:** `packages/worker-protocol/` (v1, source SHA
  `b7a842870ce7509d8baa75409e0ab19da375c88a`), the worker-daemon `SandboxProvider` port, and
  `docs/architecture/distributed-execution-threat-*`.
- **Schema is Drizzle-only**, with C14 as the sole hand-edit exception (idempotency guards and
  data backfills, always commented, always idempotent).
