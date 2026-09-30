# BLOCKER E-2 + E-3 — what should CLOSURE mean?

> **Status: DESIGN, revision 7 — §12 SURVIVES, with its NULL semantics pinned (§13).**
> §13 also files a defect in the SHIPPED gate that §12 would otherwise have inherited: **E7-F005**.
> Unit 2.3 SHIPPED. **Unit 2.4a is BLOCKED on §12** — its Task 4 addresses a window inside a much
> larger one. §12 supersedes §11.3.
> A second sweep (67 agents, 44 confirmed hazards) ran REAL PostgreSQL probes and broke two of
> §10.3's five points. **§11 supersedes §10.3.** Read it before building anything.
> ★ Third consecutive round where the DIAGNOSIS held and the REMEDY failed. That is now a
> property of this problem, not an accident: assume any mechanism here is wrong until measured.
> A 72-agent terrain sweep (183 cited facts, 67 hazards raised, **48 confirmed**) established that the
> optional-watermark-parameter shape §4.3 proposed would make the gate **ADMIT an unreconciled fleet**.
> §10 records what was confirmed and replaces the mechanism. Read §10 before §4.
> Now owned by **MIG-010**, with the two defects filed as **E10-F002** (E-2) and **E7-F004** (E-3).
> §9 settles the two open semantics the review left (F3 freshness, F4 unattributable).
> Revision 1 survived its own review on the *diagnosis* and failed it on the *remedy*: three of
> §4's mechanisms cannot be built as written. See §8 for the findings, which are applied inline
> below rather than silently corrected.
> Predecessor: [Units 1.6+1.7](./2026-09-01-unit-1-7-definer-grantee-plan.md) fixed **E-1** and
> merged as `c7ead3a73` (PR #333). The canary is still gated shut.
> Terrain: [§9e.2.2](./2026-08-31-campaign-blockers-and-fleet-terrain.md).

Every claim in §1 was read out of the tree at `c7ead3a73` and is cited. Nothing here is inherited
from an earlier summary — including my own, because two of the four facts below are **worse than
previously reported**.

---

## 1. Verified terrain

### 1.1 E-2 is bigger than filed: the whole WRITING HALF is orphaned

The filed defect was "`reconcileCompanyLegacyResources` has zero non-test callers". True — but
incomplete. Its **store** is orphaned too:

| Symbol | Definition | Non-test callers |
|---|---|---|
| `reconcileCompanyLegacyResources` | `legacy-resource-reconciliation.ts:324` | **0** (only `legacy-resource-reconciliation.test.ts`) |
| `createDrizzleReconciliationStore` | `legacy-resource-reconciliation-store.ts:23` | **0** (two comments + one `vi.mock`) |

So `legacy_resource_reconciliation` is **never written in production**. The gate reads it
(`canary-preflight-store.ts:63`), `assertClosure` finds every inventory key unmapped, and the answer
is `reconciliation_incomplete` forever.

★ This is the [[checks-that-nothing-runs]] class again, one layer deeper than the report said.
**Wiring a caller to the pass is not enough — the pass has no wired store to drive.**

### 1.2 E-3: the asymmetry is TWO mechanisms, not one

The gate re-derives its inventory from live rows — *every* lease the company currently holds,
whatever its status (`canary-preflight.ts:115-122`, `:141`). The pass's inventory
(`legacy-resource-reconciliation.ts:340-368`) differs in two independent ways:

1. **Post-pass leases.** `environmentService.acquireLease` inserts a new `environment_leases` row on
   every legacy acquisition (`environments.ts:141-165`), reached from three sites in
   `environment-runtime.ts` (`:219`, `:578`, `:636`). Any lease created after the pass has no record
   → `unmapped` → refuse.
2. **Lost-CAS paused rows.** On a lost `casClaimPaused` the pass `continue`s
   (`legacy-resource-reconciliation.ts:347-350`) — recording **nothing**. The row still exists, so
   the gate counts it, and it has no record → `unmapped` → refuse.

(1) alone makes the gate unopenable on any box with traffic. `canary-preflight.ts:16-19` calls this
"self-healing in the safe direction". It is safe. It is also **permanently shut**, which is not a
gate but a wall.

### 1.3 The pass cannot run as `aoa_operator` today

The crosswalk's own security model (`legacy_resource_reconciliation.ts:11-22`, migration
`0256_dizzy_bedlam.sql:69-102`) makes this an **operator** pass: `aoa_operator` holds
`SELECT, INSERT, UPDATE` (no DELETE); `aoa_app` holds `SELECT` only, behind the inverted qual
`current_setting('aoa.organization_id', true) IS NULL`.

But the pass must first *read* `environment_leases`, `environments`, and the
`runtime_provider_keys`→`company_secret_versions` chain — and **neither serving role holds any grant
on those four tables.** That is precisely why E-1 needed owner-owned `SECURITY DEFINER` functions.
None of the four appears anywhere in the authority manifest (`job-control-legacy-grants.ts`), which
is an exact allowlist, not a partial one.

★ Worse, the pass also **writes** to `environment_leases`: `casClaimPaused` →
`expireLeaseIfPaused` (`environments.ts:310-327`) flips `paused → expired` and stamps
`releasedAt`/`cleanupStatus`. So running the pass **destroys warm snapshots as a side effect**.

**Wiring the pass to `operatorDb` as it stands fails with 42501 on its first read.** This is the
E-1 defect a second time, in the writer instead of the reader.

### 1.4 One constraint that will bite the build

`JOB_CONTROL_LEGACY_GRANTS` (`job-control-legacy-grants.ts:49`) is **not a grant list** — `rls-tenant.ts`
reconstructs the bodies of already-applied migrations 0213/0214 by walking it, so adding a table
there retroactively rewrites two immutable migrations and reds a byte-identity test ~30 minutes into
`verify`. Two prior lanes hit this. **A new grant goes in its own `*_GRANTS` constant.**

### 1.5 What has NEVER run is free to change

The pass has zero production callers and has never executed against a real database. Its semantics
are asserted only by `legacy-resource-reconciliation.test.ts`. **Changing them costs test churn, not
operational risk.** That legitimately widens the design space, and §4 spends it.

---

## 2. The question

Not *"who calls the reconciler"*. That framing produces a caller, a green test, and a gate that is
still shut — because §1.2(1) is untouched by having a caller.

The real question is **what set must be closed** for the acceptance clause to be satisfied:

> "MIG-008 has reconciled legacy environment leases/resources and moved provider-control authority
> **before the rollout flag can transfer the first live execution**." (program-design.md:794)

A lease created *after* the reconciliation decision is not an unreconciled *legacy* resource. It is
ordinary current traffic on the legacy path, and it drains on the legacy path — the rollout flag
only steers **new** ownership decisions. Requiring it to carry a crosswalk record is a category
error, and it is the whole of E-3.

**Closure should mean: every legacy resource that existed as of the reconciliation decision point is
accounted for.** The decision point is the thing to pin.

---

## 3. Two answers that look right and are not

### 3.1 `max(records.created_at)` as the watermark — FAILS OPEN

Tempting, needs no schema. But the last record is written at pass *end* (T1), while the pass's
snapshot was taken at *start* (T0). A lease created in `[T0, T1]` is invisible to the pass, has no
record, and sits **below** the watermark — excluded from the gate's inventory. That is a genuine
legacy resource skipped silently. The boundary must be the snapshot instant, not the last write.

### 3.2 A stored "reconciled: true" attestation — the thing this module refuses to trust

`canary-preflight.ts:12-19` is explicit: closure is *computed, not stored*, and the gate re-derives
it "rather than trusting a flag". An attestation carrying a verdict is that flag.

**A watermark is not a verdict.** It narrows the *inventory*; the gate still recomputes closure over
it with MIG-008's own `assertClosure`. The property survives — but only if the stored value is a
boundary and never an outcome. Any reviewer will raise this; the answer is the distinction, and the
design must not blur it.

### 3.3 ★ And the clock trap underneath both

If the watermark comes from the DB and lease `created_at` comes from the app, they are two clocks.
`acquireLease` passes `createdAt: now` from JS (`environments.ts:140`, `:162`), so **today they
are**. A legacy lease on an app instance whose clock runs fast gets `created_at > W` and is
**excluded from the gate's inventory** — a real legacy resource waved through. Fail-open, in the
one direction that matters.

With both sides on the DB clock the hole closes, and closes *provably*: `now()` is transaction-start
time, so any lease committed before the pass began has `created_at < W` and is included. The
residual direction (a long transaction stamping `created_at < W` but committing after the pass) puts
an extra lease *into* the inventory → refuse → fail-closed. Acceptable.

**So the watermark is only sound if `acquireLease` stops stamping `created_at` from the app clock.**
That is not an implementation detail; it is load-bearing, and it must be tested as such.

---

## 4. The design

### 4.1 Option R — the pass becomes read-only

Drop `casClaimPaused` entirely. A paused row is recorded `mapped` (live legacy resource, hash-only,
left for drain) rather than CAS-claimed and recorded `terminal_cleanup`.

What this buys:

- **The 42501 problem shrinks to reads.** No `UPDATE` on `environment_leases` — so no definer
  function that mutates tenant data, and no table-level write grant to `aoa_operator`.
- **§1.2(2) disappears by construction.** There is no lost CAS, so there is no unrecorded row.
- **Invariant #2 gets stronger, not weaker.** The pass stops asserting terminality on a row that
  might resume, and stops destroying warm snapshots as a side effect of being consulted (§1.3).
- **It mirrors the shape that already worked.** Units 1.6+1.7 were "correct-layering, read-only
  first slice".

★ **F8 — revision 1 handed the cleanup half to "CLI-004", which is not the path it named.**
★★ *Corrected within the same round, because the review's first pass overstated this.* CLI-004 **did
ship** (E7, `CLI-004-result.md`, implemented at `packages/worker-daemon/src/supervisor/reconcile.ts`).
It is the **distributed** side's orphan sweeper: it reconciles labelled *provider resources* through
`CleanupAuthority`, and it never reads `environment_leases`. So "terminal via CLI-004 reconcile
composition" (`legacy-resource-reconciliation.ts:153`, `:169`) is a claim about a resource that has
already become a labelled distributed resource — **not** a promise to tear down a legacy lease row.

The path that actually sweeps legacy `environment_leases` rows is the **warm sandbox reaper**:
`listTerminalUncleanedLeases` → `claimTerminalUncleaned` (`warm-sandbox-reaper.ts:291`, `:157`) and
`listPausedLeasesWithKeyGeneration` (`:234`).

That correction cuts both ways, and the second half matters more:

- **Today's CAS is not decorative.** `expireLeaseIfPaused` sets `status='expired'` +
  `cleanupStatus='pending'`, which is exactly the predicate `listTerminalUncleanedLeases` selects
  on — so the pass's claim is a deliberate *handoff into a running sweeper*, not bookkeeping.
- **Option R changes which lifecycle a paused snapshot rides.** Left `paused`, it is no longer in
  the terminal sweep set; it is reaped by the warm reaper's TTL grace path instead. Defensible —
  the target is real and already wired, which is more than the CAS's stated rationale could say —
  but it is a different lifecycle with a different latency, and Option R must be argued on that,
  not on "CLI-004 will handle it".

What it costs: `skippedResumed` loses its meaning (one assertion, `legacy-resource-reconciliation.test.ts:233`),
and paused snapshots are no longer marked terminal *by the pass*. Per §1.5 that is test churn.

★ **Open:** a `mapped` record for a paused row carries `legacyStatus: 'paused'` — the status seen at
reconcile time. Honest, but a reader may take it for a live-active row. Recommend keeping the
observed status and carrying the distinction in `reason`. Flagged for review, not settled.

### 4.2 The reads move to owner authority, exactly as E-1 did

Three reads (`listLeases`, `platformDefaultEnv`, `currentKeyGeneration`) against tables neither
serving role can touch. `0267` already ships definer functions for **two** of them, org-bound and
granted to `aoa_operator`:

- `canary_preflight_evidence_leases(organizationId, companyId)` — but it projects `lease_id` only,
  and the pass needs the full `LegacyLeaseInput` to classify. **A new function is required**, not a
  reuse.
- `canary_preflight_evidence_scalars(...)` covers the default env + key generation and **is NOT
  reusable as revision 1 claimed — F1.** Every `0267` function is **organization-bound**, and
  `reconcileCompanyLegacyResources(companyId, deps)` holds no `organizationId`. `0267` ships
  org→companies (`_companies`) and **no company→org lookup**, so a company-scoped pass structurally
  cannot call any of them.

  **Fix: the pass becomes organization-scoped.** It takes an `organizationId`, enumerates via
  `canary_preflight_evidence_companies`, and reconciles each company. That is strictly better
  than adding a company→org lookup: it matches the gate's own scope (`canary-preflight.ts:21-26`),
  it matches the CLI's cutover framing ("reconcile this org before flipping it"), and it avoids
  minting a reverse-direction lookup whose only caller would be this pass.

So: one new `SECURITY DEFINER` function projecting the classification columns, manifested and
certified like the other three, `EXECUTE` to `aoa_operator` alone. The projection must be narrowed
to the fields `classifyLease` actually reads — the return type is the security boundary, and it
structurally cannot carry secret material.

★ The **grantee** is the argument, not the org parameter (Decision #122, 2026-09-01 amendment). Say
it that way; `p_organization_id` is caller-supplied and is defence in depth.

### 4.3 The watermark

- New column or marker recording the pass's **snapshot instant**, read from the DB (`now()`) *before*
  `listLeases`, written by the pass, per company.
- `acquireLease` stops passing `createdAt` so the column default (`defaultNow()`, DB clock) fires.
- The gate's inventory becomes `leases WHERE created_at <= W` for the company's latest completed
  pass; **no pass ⇒ no watermark ⇒ no inventory narrowing ⇒ refuse** (fail-closed, unchanged from
  today).

★ **F2 — that filter cannot live where revision 1 put it.** The gate does not read lease rows; it
reads `canary_preflight_evidence_leases`, which projects **`lease_id` only** (`0267`). There is no
`created_at` client-side to compare, so "the gate's inventory becomes …" is not implementable as a
predicate in TypeScript. The watermark must be pushed **into the definer function** as a parameter.
That means an arity change — which CREATES a new function rather than replacing the old one — so it
carries the full `0267` ceremony: a new migration that DROPs the old signature, a new manifest
entry with a fresh `bodySha256`, `REVOKE … FROM aoa_app`, `GRANT … TO aoa_operator`, and the boot
certificate updated in the same commit. Budget for it; it is not a one-line predicate.
- `assertClosure` is untouched. The gate still recomputes.

### 4.4 The caller (E-2)

An **operator CLI command** under `server/src/cli/`, following the two existing precedents
(`verify-cp-am-keypair.ts`, `verify-e7-1-distributed-run.ts`, exposed as `pnpm verify:*`). Not an
HTTP route and not automatic: the crosswalk's security model calls this "a SERVER-SIDE
system/operator pass, NOT a per-tenant-request writer", and a cutover reconciliation is a deliberate
operator act. It binds `operatorDb`.

---

## 5. What must be true, or this fails open

Each of these is a test, not a note.

1. A legacy lease that existed before the pass is **never** excluded by the watermark. (The §3.3
   clock argument, pinned — including a test that reds if `acquireLease` reverts to the app clock.)
2. `no pass` and `pass but no watermark` both **refuse**.
3. ★★★ **F3 — the watermark inverts the gate's failure direction, and revision 1 under-read this.**
   Today the gate gets *stricter* with traffic: every new lease adds an unmapped key. The watermark
   makes it get *looser with age*, because everything newer than the pass is out of scope. Run the
   pass, let a month go by, let the fleet churn completely: the in-scope inventory is **empty**,
   closure is **vacuous**, and the gate **opens** while fifty live unreconciled legacy leases exist.
   Calling that "the intended semantics" (revision 1) is true of one lease and false of a stale
   fleet. **A freshness bound is REQUIRED, not optional.**

   One partial bound already exists and should be named rather than relied on: a provider-key
   rotation retags the current generation, every record keeps the old one, and
   `canary-preflight.ts:157-171` refuses on `superseded`. That forces a re-pass — **but only if the
   key rotates.** It is not a clock.

4. ★ **F4 — an `unattributable` record bricks the canary permanently, with no remedy in code.**
   `assertClosure` fails on *any* unattributable disposition (`legacy-resource-reconciliation.ts:290`),
   and `resolveResourceType` returns null for a lease that is not `ephemeral` and carries no
   `agentId` / `commanderConversationId` / `executionWorkspaceId` (`:95-101`). The crosswalk is
   append-only: `0256` grants no DELETE, and the schema comment states there is no update path in
   application code. So one unclassifiable lease refuses the gate **forever**, and neither the pass
   (idempotent insert-if-absent) nor the gate (read-only) can clear it. The design must state the
   operator's remedy — or admit there isn't one, which is itself a decision.
5. A record tagged with a superseded key generation still refuses (`canary-preflight.ts:157-171`,
   unchanged) — the watermark must not become a way around the credential-authority check.
6. ★ **F5 — the operator CLI must ASSERT the role it connected as.** The precedent
   (`verify-e7-1-distributed-run.ts:58-64`) is `createDb(process.env.DATABASE_URL)`: the operator
   chooses the role. Run the pass with an owner URL and every definer function and grant argument in
   §4.2 is **decorative** — it would succeed while proving nothing about the grant model, which is
   the E-1 defect wearing a different hat. `assertNonOwnerConnection` and
   `assertExactServingRoleAuthority` already exist and are already used this way
   (`distributed-execution-databases.ts:1764-1765`). The CLI calls both before its first read, and
   exits non-zero if it is not `aoa_operator`.
7. The new definer function is manifested, certified at boot, and grants `EXECUTE` to no role
   containing `aoa_app` (the condition enforced in `security-definer-manifest.test.ts`).
8. The pass performs **no** write to `environment_leases`. Asserted structurally, by the store seam
   not exposing one.

---

## 6. Not in scope

- **Unit 2 / capability** (E7-F003): MCP surface, instructions bundle, workspace, output capture.
  Still unowned, still not started. Fixing E-2/E-3 opens the gate; it does not make an agent capable.
- Teardown of paused snapshots at cutover. Option R leaves them on the **warm reaper's** TTL path
  (`warm-sandbox-reaper.ts:234`) — not CLI-004, which sweeps labelled distributed resources and never reads `environment_leases` (F8).
- The two audit findings still open from PR #333: Decision #122 condition 3 has no checker, and a
  *new* unmanifested definer function goes undetected on flag-off boots.

---

## 7. Open questions for the review round

1. **Option R vs keeping the CAS.** R is recommended. The counter-argument is that MIG-008's design
   deliberately claimed paused rows so cutover found no ambiguous state. Is deferring that to CLI-004
   a retreat or a correction? (§1.5 says the cost is test churn; that is an argument about cost, not
   about intent.)
2. **Watermark storage shape** — a column on a new per-company pass marker, or a new table? A marker
   row per (company, pass) also gives an audit trail of *when* reconciliation was asserted.
3. **`legacyStatus` on a paused-but-mapped record** (§4.1).
4. **Does the gate need the watermark per company or per organization?** Closure is company-scoped;
   the flag is org-scoped. A per-company watermark means an org can be gated on passes taken at
   different instants. Probably fine — closure is asserted per company — but it is exactly the kind
   of scope seam that produced the org-vs-company defect in `0266`.

---

## 8. Review round 1 — findings

Eight findings, all verified against the tree at `c7ead3a73` rather than reasoned about. The
diagnosis (§1-§3) survived. **Three of §4's mechanisms did not.**

| # | Sev | Finding | Where |
|---|-----|---------|-------|
| F1 | HIGH | The pass is company-scoped; every `0267` function is org-bound, and no company→org lookup exists. §4.2's "reusable as-is" is not buildable. → make the pass org-scoped. | §4.2 |
| F2 | HIGH | The watermark filter cannot run in the gate: `_leases` projects `lease_id` only. It must be pushed into the definer function — an arity change, so a new migration + manifest entry + `bodySha256` + certificate update. | §4.3 |
| F3 | HIGH | The watermark **inverts the failure direction**: today's gate tightens with traffic, the proposed one loosens with age, and a stale pass over a churned fleet opens it vacuously. A freshness bound is required. Key rotation is a partial bound only. | §5.3 |
| F4 | MED-HIGH | An `unattributable` record refuses the gate permanently — append-only table, no DELETE grant, no application update path. One unclassifiable lease bricks the canary with no remedy in code. | §5.4 |
| F5 | MED | The CLI's role is operator-supplied via `DATABASE_URL`. Without a role assertion the entire §4.2 grant argument is decorative. | §5.6 |
| F6 | LOW | Correction, in the design's favour: `classifyLease` has **no** non-test caller but the pass, so Option R is cheaper than §4.1 claimed. Do not confuse it with `classifyLeaseTruth` (`adapter-manager-control.ts:103`), which is the reaper's and unrelated. | §4.1 |
| F7 | LOW | Correction: `environment_leases.created_at` has **no** application consumer — the single grep hit (`job-operations.ts:95`) is the *job* leases table. The `acquireLease` clock switch is lower-risk than §3.3 implies, but still needs its pinning test: the risk was never "something reads it", it was "the two clocks must agree". | §3.3 |
| F8 | MED | Revision 1 deferred cleanup to "CLI-004". It ships, but it is the **distributed** orphan sweeper over labelled provider resources and never reads `environment_leases`. (★ This row was itself corrected mid-round: the first pass claimed CLI-004 did not exist.) The path that sweeps legacy lease rows is the warm reaper — and today's CAS is a deliberate handoff *into* it, not bookkeeping, so Option R must be argued as a lifecycle change rather than a cleanup deferral. | §4.1, §6 |

**What this changes about sequencing.** F1 + F2 together mean the read surface is not "one new
definer function" but a **new org-scoped, watermark-aware definer surface** — closer in size to
`0267` itself than to a patch. F3 and F4 are semantics that must be settled *before* any of it is
built, because both change what the gate is allowed to answer.

**Still open from §7**, unchanged by this round: Option R vs keeping the CAS (F8 sharpens the
question rather than settling it); watermark storage shape; `legacyStatus` on a paused-but-mapped
record; per-company vs per-organization watermark.

---

## 9. Settled semantics (revision 3)

The review left two questions that change **what the gate is allowed to answer**, so they are settled
here before any build. Both were argued from the failure they must prevent, not from convenience.

### 9.1 F3 — the freshness bound is a policy constant, and the alternatives are worse

The bound must stop a stale watermark from opening the gate over a churned fleet. Three shapes were
considered:

1. **"No live lease may postdate the watermark."** Rejected — this is E-3 wearing a hat. Any legacy
   traffic during the decision reshuts the gate, which is the exact wall this unit exists to remove.
   It also contradicts MIG-008's own stance that an active legacy execution is `mapped` and *left for
   drain* (`legacy-resource-reconciliation.ts:130-140`).
2. **Derive staleness from fleet churn** (a ratio of post- to pre-watermark leases). Rejected — an
   invented metric with a threshold nobody can defend, and it fails differently on a quiet company
   than a busy one. An arbitrary constant honestly labelled beats a derived one that looks principled.
3. **A bounded validity window on the evidence.** ✅ **Chosen.**

**The decision.** Reconciliation evidence has a maximum age. Past it the gate refuses with a new
policy reason — `reconciliation_stale` — and the operator re-runs the pass. The constant lives in
the preflight module as an exported, documented value (**not** an `AOA_*` environment variable: a new
undocumented `AOA_*` in `server/src` reds `brand-check`, and a value this load-bearing should be
reviewed in a diff rather than set per-box).

**Why a constant is honest here.** It is a guard rail, not the mechanism. The mechanism is that the
operator runs the pass **as part of the cutover action** — same CLI session, minutes before the flip
— so a stale watermark should never occur in the intended flow. The constant exists to make the
unintended flow fail closed rather than silently open. Precedent for a chosen-and-documented policy
constant: `HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT` (CLAUDE.md, D5).

★ **Name the residual honestly.** Inside the window, a post-watermark live legacy lease IS waved
through without a crosswalk record. That is the intended semantics from §2 — it is current traffic on
the legacy path, not an unreconciled legacy resource — but it is a real widening versus today's
behaviour and must be stated wherever this is summarised. The window bounds how much of it can
accumulate; it does not eliminate it.

### 9.2 F4 — an operator resolution path, using the grant that already exists

An `unattributable` record refuses the gate permanently and nothing in code can clear it. Options:

1. **Fix the underlying lease** (give it an owner FK so `resolveResourceType` classifies). Rejected —
   the pass would be mutating tenant data to make its own assertion pass, which is the shape of every
   fail-open in this programme.
2. **Let the pass overwrite its own record.** Rejected — append-only is what makes the crosswalk
   evidence rather than state, and a pass that can rewrite its own verdict is not evidence.
3. **A narrow operator command that resolves ONE record, on the record.** ✅ **Chosen.**

**The decision.** An operator CLI subcommand resolves a single `unattributable` record by `UPDATE`ing
its `disposition` and `reason`, using the `UPDATE` grant migration `0256` **already provisions to
`aoa_operator` and which no application code currently uses**. Constraints, each a test:

- It may transition **only** `unattributable → terminal_cleanup`. It can never mint a `mapped`
  record, because `mapped` is the disposition that says "a live resource is accounted for and left
  for drain" — an operator asserting that about a resource nobody could classify is precisely the
  claim that must not be forgeable.
- It rewrites `reason` with an operator-supplied justification, and refuses an empty one.
- It resolves one `resourceKey` at a time. No bulk sweep: a bulk clear is how a register of
  unresolved problems becomes a register of nothing.
- It asserts its connected role first, like every other operator entrypoint (F5).

★ **A doc contradiction ships with it.** `legacy_resource_reconciliation.ts:31-32` states there is
"no update path in application code" and that the operator `UPDATE` grant "exists only to satisfy the
mirrored 0233 grant shape". After this there IS one. That comment is amended in the same commit —
not left to be discovered by the next reader as a lie the code tells about itself.

### 9.3 What this adds to the refusal surface

`CanaryPreflightRefusalReason` gains **`reconciliation_stale`**. It does not gain a reason for the
unattributable case: that already refuses as `reconciliation_incomplete` with `unattributable` in the
detail, which is correct — it IS incomplete. §9.2 gives it a remedy, not a new verdict.

---

## 10. Revision 4 — the terrain sweep, and why §4.3 is withdrawn

Five lenses, 72 agents, every hazard put through a citation check: **67 raised, 48 confirmed, 19
rejected**. Two confirmed BLOCKING and nine HIGH. The diagnosis in §1-§3 survived untouched. **The
remedy in §4.3 did not, and it failed in the worst possible direction.**

### 10.1 ★★★ The withdrawn mechanism: "NULL watermark means no narrowing" OPENS the gate

§4.3 says a NULL watermark means no narrowing and therefore "fails closed, unchanged from today".
**That is backwards on two independent counts, and either one alone admits an unreconciled fleet.**

**(a) SQL three-valued logic inverts it.** `l.created_at <= p_watermark` with a NULL watermark
evaluates to NULL, which `WHERE` treats as not-true. The function returns **zero rows** — not all
rows. NULL means *total* narrowing, the exact opposite of the claim.

**(b) An empty inventory SATISFIES closure.** `assertClosure` derives `unmapped` by iterating
`inventoryKeys` only (`legacy-resource-reconciliation.ts:280-283`) and returns `ok: true` when that
loop finds nothing (`:289-295`). `canary-preflight.ts` has no minimum-inventory guard; its only
emptiness check is on the company list (`:131`).

Composed: a NULL watermark zeroes the lease inventory, closure is vacuously satisfied, the key
generation is current — **the gate ADMITS and the canary transfers live execution ownership over an
entirely unreconciled fleet.** Silent: no error, no refusal reason, no log. It is one omitted
OR-arm away (`WHERE created_at <= p_wm` instead of `WHERE p_wm IS NULL OR created_at <= p_wm`), and
**no existing test would catch it** — every fake-store test supplies leases directly and never
exercises the SQL.

Worse than the wall it replaces. Withdrawn.

### 10.2 ★★★ And "optional" is unpinnable: the certificate is blind to argument DEFAULTs

Even with the OR-arm written correctly, an **optional** parameter cannot be certified. The catalog
query selects `proname`, `pg_get_function_identity_arguments`, `proowner`, `proconfig`,
`proleakproof`, `prosrc`, `proacl` — and nothing else
(`distributed-execution-databases.ts:404-431`). `pg_get_function_identity_arguments` omits default
expressions **by definition**, `bodySha256` hashes `prosrc` (the body between the `$$` delimiters
only), and `proargdefaults` appears nowhere in the repository.

**Measured, not reasoned:** a `CREATE OR REPLACE` that changes only the DEFAULT — `DEFAULT NULL`
becoming `DEFAULT '-infinity'::timestamptz` — leaves `identity_arguments`, `proconfig`, `proacl`,
`proleakproof` and `sha256(prosrc)` **byte-identical**. All eight certificate checks pass. Every
company's inventory goes empty and the gate answers `ok: true` for an unreconciled fleet.

★ **A fail-open with a passing certificate is precisely what the manifest exists to prevent, and the
one field §4 proposed to add is the field that can do it.** A second measured result compounds it: a
two-arg call against a two-arg function *and* a three-arg-with-DEFAULT overload raises **42725
`function ... is not unique`**, which `canary-preflight.ts:195-204` folds into `preflight_error` —
restoring the unfalsifiable "I could not read" that Unit 1.6 existed to remove.

### 10.3 The replacement

1. **The watermark parameter is REQUIRED, with no DEFAULT.** Unpinnable axes do not go into a
   certified surface. The old two-arg signature is DROPped in the same migration (§10.2's 42725
   result makes this mandatory, not hygienic).
2. **The body raises on a NULL watermark** rather than returning an empty set. A NULL here is a
   programming error, not a policy state, and the reachable path never produces one because…
3. **…the gate refuses BEFORE it calls.** No stored watermark ⇒ `reconciliation_stale` ⇒ refuse. The
   definer function is never reached without a value, so the loud-failure arm stays unreachable and
   `preflight_error` stays out of the reachable path.
4. **The function returns the narrowed ids AND the unnarrowed total.** `total > 0 && narrowed == 0`
   means "the pass predates the entire current fleet" — refuse `reconciliation_stale`. This closes
   §10.1(b) without touching `assertClosure`, and it is a *derived* staleness signal rather than only
   the §9.1 constant. Both are kept: the constant bounds time, this bounds churn.
5. **`identityArguments` must read `timestamp with time zone`, not `timestamptz`** — the catalog
   renders the former and the manifest is compared with exact equality. Confirmed BLOCKING: a
   `timestamptz` entry is a fatal every-boot failure.

### 10.4 Other confirmed hazards that change the plan

- **HIGH — Option R is mandatory, not preferred.** The pass cannot run as `aoa_operator` at all
  until the CAS write is removed: `OPERATOR_SERVING_RELATIONS` grants no write on
  `environment_leases`. §4.1 offered R as the better of two options; the terrain says it is the only
  one that runs.
- **BLOCKING — §9.2's unattributable remedy is not optional.** `unattributable` is reachable through
  **ordinary agent deletion**: the owner FKs are nullable, so deleting an agent turns a classifiable
  lease into an unclassifiable one and bricks the gate permanently with no remedy in code.
- **HIGH — storage must be a separate marker.** A watermark COLUMN on
  `legacy_resource_reconciliation` cannot express "latest completed pass"; a synthetic ROW silently
  enters two gate predicates; and a per-record watermark **newly bricks companies that pass the gate
  today**. All three storage shortcuts are out.
- **HIGH — an arity change on `_leases` reds call sites a `(uuid, uuid)` grep cannot find**, and the
  "lists all three" shape test is prefix-matched so a fourth function either reds it spuriously or
  slips past. The Unit 1.7 lesson repeats exactly.
- **HIGH — `bodySha256` must be recomputed from a real database.** It is
  `encode(sha256(convert_to(replace(prosrc, chr(13), ''), 'UTF8')), 'hex')` — CR-stripped because
  `packages/db/src/migrations/` carries no `eol=lf` pin. A wrong-but-well-formed hash passes every
  check runnable on the dev machine and then **bricks every boot**.
- **HIGH — nothing mechanical notices if the new caller is removed or was never reachable.**
  `gate-clause-wiring.json` is the mechanism that must be extended, or E10-F002 recurs in the fix.
- **HIGH — the Unit 2.2 repro tests must invert, and the floor guard is trivially satisfied by a
  swap.** The 1497 bump makes a bare deletion visible; it does not make a delete-plus-add visible.
  Naming those tests in a pinned inventory is the only shape that actually holds.

### 10.5 What the sweep did NOT overturn

§1 (the terrain), §2 (the question), §3.1 and §3.2 (the two rejected answers), §9.1's freshness
bound and §9.2's remedy shape. The diagnosis has now survived two adversarial rounds; every failure
has been in the *remedy*, and both times in a mechanism that looked obviously safe.

---

## 11. Revision 5 — measured, and §10.3 was still wrong twice

The second sweep did not reason about PostgreSQL; it **ran** it. Two of §10.3's five points are
withdrawn, one is right for the wrong reason, and one new BLOCKING hazard appeared that no previous
round saw.

### 11.1 ★★★ §10.3 point 4 is UNBUILDABLE in the shape it names

The churn guard — refuse when `total > 0 && narrowed == 0` — was to be served by a
`RETURNS TABLE (lease_id uuid, unnarrowed_total bigint)`.

**Measured:** with a watermark that predates every lease, that function returns **ZERO ROWS**. There
is no row to carry the total. The guard is unobservable **exactly in the case it exists to detect**,
and it fails silent, not loud.

**The fix is already in this codebase.** `canary_preflight_evidence_scalars` solved the same problem
and `0267` documents it: *"`scoped` returning no row makes BOTH scalar sub-selects NULL, so the
'exactly one row, always' contract holds."* The narrowed-lease read must adopt that contract:

```sql
RETURNS TABLE (lease_ids uuid[], unnarrowed_total bigint)
-- one row, ALWAYS: array_agg over the narrowed set (NULL when empty) + count(*) over the
-- UNNARROWED set. `narrowed == 0 && total > 0` is then observable, because the row exists.
```

★ A set-returning shape cannot carry a fact about the empty set. If a value must survive "no
matches", it belongs in a one-row contract, not a `RETURNS TABLE` of the matches.

### 11.2 ★★★ §10.3 point 1 is right, and its stated reason is WRONG — the truth is worse

§10.3 justified DROPping the old signature by the 42725 `is not unique` result. **Measured: that
result only occurs when the new parameter carries a DEFAULT.** With the REQUIRED, no-DEFAULT
parameter §10.3 itself mandates, a surviving 2-argument call **does not error at all** — it resolves
silently to the OLD, unnarrowed function and returns every lease.

So a missed call site does not fail loudly into `preflight_error`. It **fails open**, quietly, with
the gate reading an unnarrowed inventory it believes is narrowed. The DROP is mandatory for a
stronger reason than the one recorded.

Two more measured facts make the DROP unavoidable anyway:

- `CREATE OR REPLACE FUNCTION` **cannot change a return type** (42P13, *"Use DROP FUNCTION first"*),
  so adding the total forces a DROP even at unchanged arity.
- After the DROP, a stale call raises **42883 `does not exist`**, not 42501 — function resolution
  precedes the ACL check. That is the loud failure the design wanted, but it arrives only *because*
  of the DROP, never instead of it.

### 11.3 ★★★ NEW BLOCKING — a partial pass across a key rotation bricks the company, and reports OK

If the provider key rotates while a pass is running, records written before the rotation carry
generation G1 and records after carry G2. The gate refuses on **any** record whose generation differs
from the current one (`canary-preflight.ts:157-171`), the crosswalk is **append-only with no update
path**, and the pass **reports success**. The company is then permanently ungateable with no remedy
in code, and nothing says so.

This is the same permanence trap as the `unattributable` case (§9.2) reached by a different route.
The pass must therefore read the generation once, re-read it before it commits its marker, and
**abort without writing a marker** if it moved — leaving a retryable state rather than a poisoned one.

### 11.4 The other confirmed hazards that shape Unit 2.4

- **HIGH — §9.1's freshness bound is a SECOND cross-clock comparison**, and the obvious
  implementation (compare the marker to a JavaScript `Date`) reintroduces the exact two-clock bug
  §3.3 exists to close. The comparison must happen **in SQL**, against the database clock, on both
  sides.
- **HIGH — nothing would RED if `acquireLease` reverted to the application clock.** The switch is a
  one-line deletion protected by zero tests, and the whole watermark is unsound without it.
- **HIGH — "latest marker" only means "latest COMPLETED pass" if the marker records completion,
  scope and identity.** Decide the marker's columns from that sentence, not from convenience.
- **HIGH — an added output column is invisible to a caller that projects by name.** Measured:
  `SELECT lease_id FROM fn(…)` against a two-column `RETURNS TABLE` returns rows keyed only
  `["lease_id"]`, no error. A half-updated caller loses the new guard silently.
- **★ HIGH — `server/src/__tests__` is EXCLUDED from typecheck** (`server/tsconfig.json`), and vitest
  sets no `typecheck` option. Measured: `tsc --listFilesOnly` pulls exactly ONE file from that
  directory. So **every fake `CanaryPreflightStore` silently absorbs a new parameter** — a store
  interface change reds nothing in the tests that mock it. This is a general property of this
  repository worth remembering well beyond Unit 2.4.
- **HIGH — inverting the E7-F004 repro by delete-plus-add is invisible to every guard.** The Unit
  2.2 floor bump catches a bare deletion, not a swap. If those assertions must change, name them
  somewhere pinned.

### 11.5 What survives, and the pattern

§1-§3 (terrain, question, rejected answers), §9.1's bound and §9.2's remedy shape, and §10.1/§10.2
(the NULL fail-open and the DEFAULT blindness) all stand — §10.2 was independently re-measured.

★ **Three rounds, three times the remedy was wrong and the diagnosis was right.** Round 1 shipped a
company-scoped pass that could not call an org-bound function. Round 2 proposed an optional watermark
that opens the gate. Round 3 proposed a total that vanishes exactly when needed. The lesson is not
"review harder" — all three passed review. It is that **a mechanism in this area is not knowable by
reading; it has to be run.** Unit 2.4's plan must therefore lead with probes, not with code.

---

## 12. Revision 6 — the rotation trap is not a race, it is a standing condition

§11.3 described the key-rotation trap as a *mid-pass* hazard: records landing under two generations
while the pass runs. Unit 2.4a's plan then prescribed a per-company transaction with the generation
re-read before commit. **Both are aimed at a window that is not where the damage comes from.**

### 12.1 What the code actually does — measured, then read

`reconcileCompanyLegacyResources` reads `currentKeyGeneration` **exactly once per company**
(`legacy-resource-reconciliation.ts:410-414`) and threads that single value into every
`buildLeaseRecord` and `buildPlatformDefaultEnvRecord` call for that company. A subagent measured
this against a fake store with a rotation injected mid-pass and got one distinct generation per
company; I then confirmed it by reading the code.

So **records within a company never disagree.** §11.3's "records land under two generations" is
imprecise, and the mid-pass race it names is largely closed already.

### 12.2 ★★★ The real trap is unbounded in time, and a transaction cannot reach it

Every record for a company carries the generation observed **at pass start**. The gate refuses on
any record whose generation differs from the current one (`canary-preflight.ts:157-171`). The
crosswalk is append-only: the unique index is `(company_id, resource_key)`
(`legacy_resource_reconciliation.ts:73-76`) and `insertRecordIfAbsent` is `onConflictDoNothing`
(`legacy-resource-reconciliation-store.ts:89-91`), so **a re-run cannot re-tag an existing record**.

Therefore: **any provider-key rotation after a pass — by a second, a day, or a month — permanently
bricks that company.** Not a race. A standing condition, with an unbounded window, reached by a
perfectly clean pass followed by an ordinary key rotation.

A per-company transaction closes the mid-pass window and does **nothing** for this. Unit 2.4a's Task
4 Step 2, and §11.3 before it, are both scoped to the smaller problem.

### 12.3 The resolution: the generation belongs to the MARKER, not to every record

The two facts a cutover needs are different in kind, and conflating them is what creates an
unfixable state:

- **What was reconciled** — which resources were accounted for. That is what a crosswalk record is,
  and it is a fact about *resources*. It does not go stale when a key rotates.
- **Under which authority, and when** — the provider-control generation and the snapshot instant.
  That is a fact about the *pass*, and it is exactly what the marker (§9.1, Unit 2.4a Task 2) exists
  to carry.

So the gate should compare **the marker's** generation to the current one, not each record's. A
rotation then makes the marker stale — `reconciliation_stale`, re-run required — and the re-run
writes a **new marker** while the records, which are about resources, stay valid and are correctly
left alone by `onConflictDoNothing`. An unfixable brick becomes ordinary, recoverable staleness, and
the append-only crosswalk works as designed rather than against itself.

★ This is why `key_generation` on the record was load-bearing in the first place: before a marker
existed, the record was the only place to put it. The marker is the right home, and §9.1 already
required it to record one.

### 12.4 What this changes

- **Unit 2.4a Task 4 Step 2** is superseded. The per-company transaction is still *defensible*
  hygiene, but it is no longer the fix and must not be described as one. The marker must record the
  generation observed at pass start — which Task 2 Step 1 already requires.
- **Unit 2.4b** gains the change that actually closes it: `canary-preflight.ts:157-171` stops
  refusing on per-record generation and refuses on a stale **marker** instead.
- **The existing per-record `key_generation` column stays** — it is history, and rewriting shipped
  semantics is not required to fix this. It simply stops being what the gate reads.
- **A test must pin the recovery**: clean pass → rotate the key → gate refuses `reconciliation_stale`
  → re-run the pass → gate passes. That sequence is impossible today at any distance from the pass,
  which is the whole finding.

### 12.5 The pattern, again

Round 4. The diagnosis (§1-§3) has now survived four adversarial rounds untouched; the remedy has
failed four times. This one is the sharpest instance yet: §11.3 correctly identified that a rotation
bricks a company, then mis-diagnosed *when*, and the plan built a mechanism precisely fitted to the
wrong window. **A remedy aimed at a race, when the real defect is a standing condition, will always
look correct in review — it fixes something real.**

---

## 13. Revision 7 — §12 holds, and the NULL it never mentioned

An attack aimed squarely at §12 (three lenses, refute-by-default) produced **one** surviving finding
out of twenty-four. §12's core — the generation belongs to the marker, a rotation is recoverable
staleness rather than an unfixable brick — **survives**. But three of the three lenses independently
reached the same hole, and the convergence is the signal even though only one survived verification.

### 13.1 ★★★ The comparison §12 relocates has no defined NULL, and NULL is a normal value

`key_generation` is nullable on **both** sides of the comparison. `deriveE2bKeyGeneration` returns
null for a company with no default e2b `runtime_provider_keys` row
(`e2b-credential-authority-wiring.ts:32`), the definer scalar is typed `string | null`
(`canary-preflight-evidence.ts`), and the crosswalk column is documented *"Null for an
operator-env-default (ungenerationed) company"* (`legacy_resource_reconciliation.ts:61-65`).

§12.3 says the gate compares *"the marker's generation to the current one"* and never states what
happens when either is NULL. **Both natural implementations get it wrong**, measured against
PostgreSQL 18.1:

- SQL `WHERE key_generation <> current` — with current `'S2:1'`, matched **2 of 3** rows; the NULL
  marker escaped. With current NULL, matched **0 of 3**: every marker escaped.
- The same rows under `IS DISTINCT FROM` — **3 of 3** and **2 of 3**. Correct.

### 13.2 ★★★ And the SHIPPED gate already has this hole — filed as E7-F005

`canary-preflight.ts:157-158` is:

```ts
records.filter((r) => r.keyGeneration !== null && r.keyGeneration !== keyGeneration)
```

The `!== null` conjunct means **a NULL-generation record is never counted as superseded**. Verified
by reading the shipped code, not inferred.

The reachable sequence needs no race and no rotation:

1. Reconcile a company that has **no BYO e2b key**. Every record is written with
   `keyGeneration = null`.
2. Give that company a provider key.
3. Now `keyGeneration` is non-null, so the `:150-156` arm does **not** refuse — it only fires when the
   *current* generation is null — and every record is NULL, so `superseded` is empty.

The authority half of the acceptance clause passes **vacuously**, for precisely the company whose
provider-control authority demonstrably moved *after* its evidence was gathered.

★ §12 would have **inherited and concentrated** this: today it takes every record being NULL, whereas
a single NULL marker row would disable the check outright.

### 13.3 The decision

**The marker's generation column is `NOT NULL`, with an explicit `'ungenerationed'` sentinel**, and
every comparison uses `IS DISTINCT FROM` semantics regardless. Belt and braces, deliberately: the
sentinel makes the NULL unrepresentable in the new column, and `IS DISTINCT FROM` means a future
nullable input cannot silently re-open it.

`canary-preflight.ts:150` stays exactly as it is — it is the arm that refuses a company with **no
current generation at all**, which is a different question from staleness and remains correct.

**Pin all four combinations in a test**: (marker NULL/sentinel, current NULL) → not stale;
(sentinel, `'S2:1'`) → **stale**; (`'S1:1'`, `'S2:1'`) → stale; (`'S1:1'`, `'S1:1'`) → not stale.
The second is the one every naive implementation gets wrong.

### 13.4 What survived the attack, and what this round cost

Twenty-three findings were refuted, several by measurement. §12's answers to the sequences that
worried me most — rotate-then-rerun leaving mixed generations, an unrerun company, concurrent
passes — all held. The design has now survived five rounds on §1-§3 and, for the first time, a
remedy has survived too.

★ **The lesson is about convergence, not about this bug.** One finding survived verification; three
independent lenses had raised the same defect. Had I counted only survivors I would have read
"1 MEDIUM" and moved on. **When separate reviewers reach the same hole by different routes, the
convergence outranks the individual verdicts.**
