> ★★★ **REFRAMED BY ADVERSARIAL REVIEW (2026-08-27) — do not execute as a "Commander cutover."**
> A 3-reviewer pass confirmed this design's *physics* (Commander is credential-blocked; the drain fix
> is sound) but refuted its *framing*: (1) Sprint 6 must lead with **extraction (MIG-007)**, not
> Commander — extraction's credential path already exists, Commander's does not (finding **E10-F001**,
> go-book §4 Sprint 6); (2) the **drain fix** here is sink-agnostic and unblocked — it becomes its own
> ticket and ships regardless of sink order; (3) the **inert `resolveCommanderExecutionOwner` seam is
> DROPPED** — unlike WRK-010 slice 1, its caller is both unscheduled and undesigned, and it mirrors the
> Company-key shape Commander does not use, so it would go stale before the real routing is designed.
> **What survives as the record:** §0.3's blocked verdict (verified) and the §4 drain analysis
> (verified). Soften §0's "Deferral #1 fully closed for task_run" — the handoff docs are not unanimous.
> The real first-cutover plan to write is the **extraction (MIG-007)** design.

---

# MIG-005 — Design: Commander execution-sink cutover, shadow → active

**Ticket node:** `docs/replatform/program-design.md` (`#### MIG-005` — the same node the shadow
slice shares; the coverage checker keys on the `MIG-005` id, so this file needs **no new node**,
and per the sprint brief this design adds none).
**Epic:** E10 (Desktop, Migration, Realtime). **Sprint:** 6, **unit 1** — the go-book rule is
*"one sink at a time, do not batch"*, and MIG-005 (Commander) is the lowest blast radius, so it
goes first (`GO-BOOK.md` §3 sequence, §4 Sprint 6).
**Predecessors (shipped):** `MIG-005-006-007-shadow-{design,result}.md` (the shadow observers),
`MIG-002-dial-*` + `MIG-002-convergence-*` (the per-sink dial + convergence),
`CLI-006-*` / `CLI-007-*` (the org-heartbeat canary + its credential mint),
`DAT-008-slice-5-*` (the worker-side credential redemption),
`GATE-clause-3-rollback-*` (the rollback path + its per-sink status table).
**Terrain reference:** `qa/2026-08-27-breadth-terrain-audit.md` (Sprint 6 section).
**Size:** M. **Verified at tip `921d6a131`** — re-verify §0 at execution time (line numbers drift).

---

## ★ BLOCKING-QUESTION BANNER — read this before anything else

**Can MIG-005 (Commander) go `active` today? NO — BLOCKED.** A Commander turn that routed to the
distributed worker path would reach a sandbox with **no model-provider credential**. The
credential path CLI-007/DAT-008 built closes Deferral #1 **only for the org-heartbeat canary**
(`task_run`, a Company `provider_key` handle); Commander's credential is a *different class* — the
operator's ambient host CLI login (self-hosted) or a per-user `provider_connection` (cloud),
neither of which the mint/redeem machinery produces. The trace is §0.3.

**Consequence for this design (a legitimate, respected outcome):** MIG-005 does **not** flip
Commander to distributed execution. It builds the **routing seam proven structurally inert**
(the credential-authority gate that fails closed, so the legacy Commander spawn is never
suppressed), lands the **credential-independent rollback substrate** (the drain fix + wiring that
GATE clause 3's in-flight strand needs), states the **parity-bridge disposition** (which the
Commander active path will need, and why none is promoted here), and names the **credential
prerequisite** the flip waits on. The Commander `active` flip is a successor ticket, gated on that
prerequisite.

---

## ★ 0. Verified state at tip, and the blocking-question trace

Every claim below was read at tip `921d6a131`. **This section MUST be re-verified at execution
time** — the house has been bitten by stale line citations, and this file cites ~30 of them.

### 0.1 Where the three sinks stand — shadow only, inert unless rollout is `shadow`

| Fact | Evidence at tip |
|---|---|
| Commander records a distributed **shadow** beside its legacy turn | `internal-agent/cli-mode.ts:1004-1017` — `recordDistributedShadow(buildCommanderTurnShadowInput({…}))`, placed after the target resolves and before any spawn |
| The Commander shadow snapshot is a pure builder | `cli-mode.ts:762-799` `buildCommanderTurnShadowInput` — `source.kind:"commander_turn"`, `principal.kind:"user"`, `effectiveCompletionPolicy:"not_applicable"` |
| The shadow port is a **no-op** unless a recorder is registered, and it **never throws** | `distributed-shadow-port.ts:62-70` `recordDistributedShadow` |
| The recorder only acts on `shadow`; **`active`/`canary` are explicitly "owned by the convert/placement path, not by an observability record"** | `distributed-shadow-port.ts:135-137` — `if (state !== "shadow" || !organizationId) return;` |
| The shadow probe is resolved **per sink** through the MIG-002 axis | `distributed-shadow-port.ts:129-134` passes `sourceKind: input.source.kind` |

**So the sinks have an observability record and nothing more.** There is no execution-transfer
path for `commander_turn`, `crew_run` or `one_shot` — only the org heartbeat has one (§0.2).

### 0.2 The execution-transfer machinery exists for `task_run` ONLY

The "convert/placement path" the shadow port defers to is **heartbeat-only**. Grep at tip for the
transfer symbols (`convertActiveRun`, `resolveExecutionOwner`, `markRunHandedOffToDistributed`)
returns `heartbeat.ts`, `heartbeat-distributed-rollout.ts`, `index.ts` — **no sink module**. The
three sinks (`cli-mode.ts`, `aoa-agents/runner.ts`, `one-shot-sandbox-cli.ts`) call **only**
`recordDistributedShadow`.

| Step of the `task_run` transfer | Evidence |
|---|---|
| Rollout resolved per-sink at the seam | `heartbeat.ts:3174-3189` — `resolveRunRolloutState({ companyId, sourceKind:"task_run" })` |
| `active` mode: durable **non-leasable** convert + the one checkout (no placement, no suppression) | `heartbeat.ts:3243-3280` `convertActiveRun` |
| `canary` mode: the **ownership decision** — convert + **placement** + `mintCredentialAuthority` | `heartbeat.ts:5202-5241` → `resolveExecutionOwner` → `run-execution-owner.ts:203-301` |
| Legacy suppression reads the ONE stored decision | `heartbeat.ts:5254` `shouldSuppressLegacyExecution` (`run-execution-owner.ts:140-144`) |
| The decision transfers **only** on `canary` | `run-execution-owner.ts:238-240` — `if (state !== "canary") return legacy("rollout_not_canary")` |

**Terminology note, load-bearing.** The go-book titles Sprint 6 *"MIG-005/006/007 ACTIVE"*, but in
the rollout vocabulary `active` is a durable non-leasable convert that **does not** suppress
legacy or execute distributed; the mode that actually transfers execution is `canary`
(`distributed-execution-rollout-source.ts:39-53`; `run-execution-owner.ts:238`). Throughout this
design, **"cut Commander over" means "make a Commander turn execute on the distributed worker
path instead of the legacy host/#320 spawn"** — i.e. the `canary`-shaped transfer, not the
`active` non-leasable convert. The distinction matters because it is the transfer, not the
convert, that needs a credential.

### 0.3 ★ THE BLOCKING QUESTION — does a distributed Commander run get a credential?

**Trace it from the credential the org-heartbeat canary receives, and ask whether Commander can
receive the same.**

**(a) How the canary (`task_run`) gets credentialed — the path CLI-007/DAT-008 built.**
The canary ownership decision threads `mintCredentialAuthority: gate.credentialAuthority` into
placement (`run-execution-owner.ts:267-276`). That authority is the constant
`CANARY_CREDENTIAL_AUTHORITY = "company_api_key"` (`canary-mint-authority.ts:41`), established by
the MIG-008 preflight, which verifies the **Company** holds provider-control authority
(`canary-preflight.ts:150-167`, `currentKeyGeneration !== null`) and enumerates **every Company
under the Organization** (`canary-preflight.ts:52-63`). Placement mints a **Company `provider_key`
handle**; the worker redeems it into the sandbox env (DAT-008 slice 5 —
`E5-5-redaction` → `wired`). The module states the class explicitly: *"a canary is NEVER an
`owner_desktop`/`personal_subscription` run"* (`canary-mint-authority.ts:1-11`). **This entire
apparatus is `task_run`- and Company-scoped.**

**(b) How Commander is credentialed today — a DIFFERENT class.**
Commander's own resolver says it in as many words: *"Commander has no company-secret key path —
it runs on the operator's ambient CLI login … Cloud (multi_tenant) resolution fails closed"*
(`cli-mode.ts:834-849`). The legacy cloud Commander-in-sandbox path (#320) confirms the shape:
`resolveCommanderSandboxContext` mints a **Commander run-JWT** for broker identity
(`commander-sandbox.ts:129-135`, → `AOA_API_KEY` in the VM) and the model-provider key rides a
**per-user `provider_connection`** env patch materialized by the control plane
(`cli-mode.ts:830-859`, `actorType:"user"`, `owner_only` sharing). The `commander_turn` admission
resolves a per-user execution principal with **no credential binding** at all
(`job-submission.ts:181-198`) — contrast `task_run`, whose canary path carries the four-null
placement binding the mint authority overrides.

**(c) The gap, stated plainly.** The distributed worker path credentials a run by redeeming a
**minted handle** (DAT-008). The only mint authority that exists is CLI-007's, and it mints a
**Company `provider_key`**. Commander does not run on the Company `provider_key` — it runs on the
operator's ambient host login or a per-user `provider_connection`. There is:

1. **no convert/placement/ownership routing for `commander_turn`** (§0.2 — it is heartbeat-only), and
2. **no credential-handle mint path for Commander's credential class** — CLI-007/DAT-008 mint the
   Company key, not Commander's per-user/ambient credential, and nothing resolves a
   `provider_connection` (or an ambient host login) into a redeemable lease handle.

Either alone blocks the flip. Together they mean a Commander turn routed to a distributed sandbox
authenticates to the model provider with **nothing** — exactly Deferral #1, and exactly the class
the sprint brief forbids designing a cutover into.

**(d) Verdict.** **MIG-005 `active` is BLOCKED.** The overlap the terrain audit flagged
(*"the same 'credential reaches the run' theme"* as E7-F001/CLI-007) is real but does **not**
resolve Commander: CLI-007 closed the credential gap for the *canary sink*, on the *Company key*.
The shadow result already recorded this — *"Deferral #1 … still blocks MIG-005/006/007 active"*
(`MIG-005-006-007-shadow-result.md` §6 limit 5). The prerequisite the flip waits on is named in
§9 as **DEFERRAL-1-commander-credential**.

### 0.4 The per-sink dial is live — "one sink at a time" is now expressible

`OrganizationRolloutPolicy.sources` is the MIG-002 per-SINK axis
(`distributed-execution-rollout-source.ts:57-72`), filtered in `workloadEnabled`
(`:261-272`, `sources` absent ⇒ all sinks, so pre-MIG-002 configs are byte-identical). The map is
re-read per resolution (`:220-255`), so an operator can arm `commander_turn` alone. This is the
favorable update the terrain audit named; it is what makes an isolated Commander cutover
*expressible* — and, because of §0.3, still not *executable*.

### 0.5 The drain is broken at two grains and has no SQL — a credential-independent gap

| Fact | Evidence |
|---|---|
| `createDistributedExecutionDrain` has **zero production callers** | `gate-clause-wiring.json` → `E10-1-drain` (`unwired`); grep confirms only `__tests__/job-distributed-drain.test.ts` constructs it |
| It calls `assertRollbackSafe(organizationId)` | `job-distributed-drain.ts:50` (dep type), `:118` (call) |
| Every bridge implementation takes a **`companyId`** | `job-budget-cost-bridge.ts:108,321`; `job-audit-bridge.ts:116,275`; `job-output-bridge.ts:177,439` — all `(string)=>Promise<void>`, so the mismatch **typechecks** |
| An Organization holds **many** Companies | `canary-preflight.ts:20-26` — the exact fail-open scope this reintroduces |
| `listActiveAttempts` has **no SQL implementation** — interface member + call site only | `job-distributed-drain.ts:40,137` |
| `DRAINED_STATUSES` counts `"cancelled"` — "the one outcome that strands a run, also the only status with no test" | `job-distributed-drain.ts:75-80`; flagged `MIG-002-convergence-result.md` §6 limit 3 |

MIG-002 explicitly **deferred** this: *"The drain is still unwired, and further away than it
looks"* (`MIG-002-convergence-result.md` §6 limit 3). GATE clause 3 carries it as a **Wave-4
blocker** owned here: *"`createDistributedExecutionDrain` … zero production callers, and the
drain's `listActiveAttempts` has no SQL implementation at all … 'wire the drain' is not a
one-line fix"* (`GATE-clause-3-rollback-result.md` §6 limit 2). The go-book assigns the fix to
Sprint 6 (`E10-1-drain` reason: *"Fix and wire during sink cutover"*). **None of this depends on
the Commander credential** — the drain cancels distributed attempts of *any* sink, and the only
sink that produces them today is the org-heartbeat canary. So it is the part of MIG-005 that
lands.

### 0.6 The parity bridges — five, not three; four are zero-caller

| Symbol | Clause | Status | Evidence |
|---|---|---|---|
| `jobApprovalBridge` | `E3-5-product-approval` | `unwired` | zero callers; `gate-clause-wiring.json` |
| `jobBudgetCostBridge` | `E3-15-budget` | `unwired` | zero callers |
| `jobOutputBridge` | `E3-17-output` | `unwired` | zero callers |
| `jobAuditBridge` | **none** | `unwired`, **tracked by NO clause** | `job-audit-bridge.ts`; terrain audit §Sprint 6 GAP |
| `createExecutionTargetRevocationFanout` | `E3-18-revocation` | `unwired`, **producer live** | Revoke writes a `pending` row nothing reads |

The terrain audit's correction stands at tip: **five parity surfaces, not three**, and
`jobAuditBridge` is invisible to `check-gate-clause-wiring.mjs` because no clause names it.

### 0.7 GATE clause 3 per-sink status — the hard requirement

`GATE-clause-3-rollback-result.md` §4: `commander_turn` is *"trivially satisfied; **RE-SATISFY at
activation**"*. Because §0.3 blocks activation, **clause 3 for `commander_turn` STAYS trivially
satisfied** — there is nothing to roll back because nothing moved. The re-satisfaction obligation
this design discharges is the **org-heartbeat** side of clause 3, whose named open blocker is the
in-flight strand — i.e. the drain (§4). This is stated so no reader mistakes "clause 3 re-satisfied"
for "Commander activated".

---

## 1. The fact this ticket exists to change — and the one it cannot

| Fact | Evidence | This ticket |
|---|---|---|
| A Commander turn records a shadow probe and executes on the **legacy** host/#320 path | `cli-mode.ts:1004-1017` | **unchanged** — Commander stays legacy |
| No routing decides whether a Commander turn *could* transfer; the credential prerequisite is invisible | §0.2, §0.3 | **builds the inert routing seam** — the fail-closed credential gate, so "Commander stays legacy" is structural + mutation-tested, and the prerequisite has a compile-visible plug-point (§3.1) |
| The rollback drain is zero-caller, wrong-grained, and has no SQL | §0.5 | **fixes + wires it** — credential-independent, promotes `E10-1-drain`, re-satisfies clause 3's in-flight strand for the movable sink (§3.2, §4) |
| A distributed Commander run gets no credential | §0.3 | **cannot change** — named as `DEFERRAL-1-commander-credential`, owner of the eventual flip (§9) |

**Net:** MIG-005 makes the Commander sink *ready to cut over the moment a credential path lands*,
and makes the rollback lever real, without moving a single Commander turn onto a path that cannot
credential it.

## 2. The shape of the fix, and what is rejected

**One sentence.** Build the Commander execution-ownership seam so it **structurally refuses to
transfer** (no `commander_turn` credential authority is composed, so the decision is always
legacy), fix and wire the rollback drain so an operator has a real teardown lever, and record the
credential prerequisite as the owner of the actual flip.

**Rejected — build the full `commander_turn` convert/placement/execution now, gated behind the
credential check.** This is the sprint brief's explicit prohibition: *"do NOT design a cutover
that would route Commander runs to a distributed path that cannot credential them."* A built
executor one gate away from firing is the E4-F011 hazard shape (a provider in the desktop root,
two env vars from live). Worse here: suppressing the legacy Commander spawn with **no** distributed
executor **strands the turn** — the WRK-011 lesson (*"its success path breaks any worker that
calls it"*). So the executor is **not built**; the transfer decision is a dead end in production,
structurally unreachable (§3.1).

**Rejected — reuse the canary credential authority for Commander (`CANARY_CREDENTIAL_AUTHORITY`).**
It is the Company `provider_key` and the module forbids the widening in as many words
(`canary-mint-authority.ts:1-11`, *"a canary is NEVER an owner_desktop/personal_subscription
run"*). Commander runs on a per-user credential; routing it through the Company key would silently
**change the identity and permission surface of the turn** — a Decision-#117 route-by-credential
call, not something a sink-cutover ticket may make.

**Rejected — skip the inert seam; just land the drain and a prose note.** The sprint brief asks
for *"the routing + rollback + bridge/drain wiring … proved inert"*. A prose note is not a
mutation-tested guarantee; the seam makes "Commander stays legacy even when the org is armed for
`commander_turn`" a falsifiable property (§7 M1), which a note cannot.

**Rejected — promote the parity bridges here.** Nothing calls them on a legacy Commander path;
promoting a zero-caller symbol to `wired` is the exact defect `check-gate-clause-wiring.mjs`
exists to make impossible (§3.3).

## 3. Architecture

### 3.1 The Commander cutover routing seam — built, and proven structurally inert

Mirror the heartbeat's two-part shape (`heartbeat-distributed-rollout.ts:44-87`: a rollout
resolver + an ownership decision), reduced to what a *blocked* sink can honestly hold: a rollout
read that is already live, and an ownership decision whose **first and only** gate is the credential
authority — which is never present in production.

```
Commander turn (cli-mode.ts, after target resolves, beside the existing shadow record)
  ├─ resolveRunRolloutState({ companyId, sourceKind:"commander_turn" })   ◄── LIVE (MIG-002 dial)
  │      off | shadow | active | canary
  ├─ resolveCommanderExecutionOwner({ rolloutState, credentialAuthority }) ◄── PURE decision
  │      credentialAuthority is resolved by an OPTIONAL resolver that PRODUCTION DOES NOT COMPOSE
  │      → returns legacy("commander_credential_unavailable") for every real turn
  └─ if shouldSuppressCommanderLegacy(decision) → (would suppress; UNREACHABLE in prod)
         else → the legacy host/#320 spawn runs exactly as today
```

**The decision function (pure), `resolveCommanderExecutionOwner`:**

- Input: the resolved `rolloutState` and an optional `credentialAuthority` (the value a future
  `commander_turn` credential resolver would produce).
- Returns `{ owner:"distributed" }` **iff** `rolloutState` is a transfer mode (`canary`) **and**
  `credentialAuthority` is present; otherwise `{ owner:"legacy", reason }` where `reason` is
  `rollout_not_canary` (not armed) or `commander_credential_unavailable` (armed, but no authority).
- **Production composes NO credential-authority resolver** — there is none (§0.3). So the second
  conjunct is always false and every real turn is `legacy("commander_credential_unavailable")`.

**Why this is honest inert, not a route-nothing-calls trap.** It is the WRK-010-slice-1 pattern
(*ship the seam, prove nothing routes through it*) with a stronger guarantee: the seam's *reason*
for staying legacy is the **named prerequisite**, and the `distributed` branch is
**structurally unreachable in production** because the only thing that could produce a
`credentialAuthority` is code that does not exist. The `distributed` branch has **no downstream** —
no convert, no placement, no executor is built — so even if it were produced, it would suppress
legacy and strand the turn, which is precisely why the gate must fail closed. That danger is the
reason the executor is deferred *with* the credential path, not before it (§2, §9).

**Wiring at the seam (`cli-mode.ts`), one guarded block beside the shadow record:** compute the
decision, and gate the legacy spawn on `shouldSuppressCommanderLegacy`. Best-effort by
construction, exactly like the shadow record: any throw in resolution resolves to legacy (the turn
must never fail because a dormant cutover decision threw). It reads the same `distributedRolloutHook`
composition style the heartbeat uses; the hook is injected only when distributed execution is
enabled, so flag-off the block is a no-op and the Commander path is byte-identical.

**Positive control / load-bearing proof (mutation M1, §7).** A unit test supplies a **stub**
`credentialAuthority` + a `canary` rollout → the decision returns `distributed`. That proves the
gate is load-bearing (the *only* thing keeping Commander legacy is the absent authority). The
production-wiring test then arms the org for `commander_turn` **with no stub** and asserts the
legacy Commander spawn **still runs**. Delete the credential-present conjunct → the decision
returns `distributed` on an armed turn with no authority → `shouldSuppressCommanderLegacy` true →
the wiring test reddens (Commander would be suppressed with no credential). One deleted guard,
one red test, no rewrite-to-equivalent.

### 3.2 The drain fix + wiring — the credential-independent deliverable

Three defects (§0.5), each fixed fail-first, then one production caller.

**(1) Grain: `assertRollbackSafe` is per-Company; the drain iterates per-Organization.** An org
holds many Companies (`canary-preflight.ts:20-26`), so `assertRollbackSafe(organizationId)` asks a
Company-keyed store about an id that is not a Company — it matches no receipts and **fails open**,
draining an org whose Company has a pending authoritative-cost receipt. Fix: reuse the
canary-preflight org→companies pattern. The drain resolves **every Company under the Organization**
(`listOrganizationCompanyIds`, the read-only slice already proven in `canary-preflight.ts:52-63`)
and asserts rollback-safety **per Company** — any pending receipt on any Company under the org
skips the whole org (the existing `rollback_pending` continue). The dep signature changes from
`assertRollbackSafe(organizationId)` to a per-Company assertion driven by the enumerator.

**(2) `listActiveAttempts` has no SQL.** Implement it: select the non-terminal `job_attempts` (and
their jobs) for the Organization, returning `{ organizationId, companyId, jobId }` — the shape
`requestCancellation` consumes (`job-distributed-drain.ts:42-48` needs `companyId` + `jobId`;
`attemptId` is not required by the fence-revoking cancel, resolving MIG-002's "row carries no
attemptId" note). Read-only, tenant-scoped, `SKIP LOCKED` to mirror the reaper's enumeration
discipline. This gives the drain a real body instead of an interface.

**(3) `DRAINED_STATUSES` counts `"cancelled"` with no test** (`job-distributed-drain.ts:75-80`;
MIG-002 §6 limit 3). Determine at Step 0 whether `"cancelled"` is a genuine drained outcome or a
strand, and cover it with a test either way — a status counted as success with no test is the
"guard that passed because it evaluated nothing" class.

**Production caller (promotes `E10-1-drain`).** The drain is the teardown lever GATE clause 3's
rollback runbook names (`GATE-clause-3-rollback-result.md` §2 — kill switch, then rollout edit +
restart; the drain covers the in-flight window §2 describes). Compose
`createDistributedExecutionDrain` in `index.ts` **behind the distributed flag** (same gate as the
sweeper — `MIG-002-convergence-result.md` §5 established flag-off allocates no `aoa_app` pool, so a
flag-off drain has nothing to open) and expose it as a **single admin-invocable teardown
operation** on the internal ops surface. Caller count is what `check-gate-clause-wiring.mjs` reads,
so one real composed caller promotes `E10-1-drain` on evidence — mutation-proven that the caller
actually reaches `drainAll` (§7 M4). **Step 0 must confirm the exact composition + invocation site
against `index.ts` at tip** (the house re-verify rule); if a clean trigger cannot land inside
MIG-005, the honest fallback is to keep `E10-1-drain` `unwired` with a reason naming the two
correctness fixes shipped and the trigger owed to REL-005 — the drain is *correct when wired* even
if the trigger slips (§10 R3).

### 3.3 The parity bridges — analysis, and why none is promoted

Which of the five (§0.6) a Commander **active** path would need, if it existed:

| Bridge | Needed by a distributed Commander run? | Reasoning |
|---|---|---|
| `jobBudgetCostBridge` (E3-15) | **Yes** | A Commander turn incurs model cost (`internal_agent_runs.costCents` / `cost_events`); a distributed run's cost must flow through the bridge, not the legacy in-process cost path |
| `jobAuditBridge` (no clause) | **Likely** | Commander turns write activity; the distributed path projects audit through this bridge. **Flag its no-clause status** (§0.6) as a wiring-register hole to close when it is genuinely wired |
| `jobApprovalBridge` (E3-5) | **No** | Commander turns do not pass task review/approval |
| `jobOutputBridge` (E3-17) | **No / minimal** | Commander turns do not produce `task_outputs`/artifacts the way agent task runs do |
| `createExecutionTargetRevocationFanout` (E3-18) | Orthogonal | A live producer with no consumer; sequence with dispatch teardown, not Commander credentialing |

**None is promoted by this ticket.** Commander does not go active, so nothing on a Commander path
calls any of them; promoting a zero-caller symbol to `wired` is the defect the register exists to
prevent (go-book §6). Each stays `unwired`; the reasons are updated only to point at the Commander
**active** successor (the credential-prerequisite ticket) rather than a bare "Sprint 6", so the
register tells the truth about *what* promotes them. The `jobAuditBridge` no-clause gap is filed as
a finding (§9) so it is visible before someone wires it green-by-absence.

## 4. Rollback evidence — re-satisfying GATE clause 3 (the hard requirement)

Clause 3 for `commander_turn` **stays trivially satisfied** because Commander does not activate
(§0.7) — the design states this rather than manufacturing a Commander rollback for a sink that
never moved (that would be the shadow ticket's own §1 tautology, one level up). What MIG-005
re-satisfies is clause 3's **rollback-path** obligation for the sink that *can* move — the
org-heartbeat canary — whose named open blocker is the in-flight strand (`GATE-clause-3-rollback-result.md`
§6 limit 2). The drain (§3.2), once correct and wired, is that path.

**The evidence, embedded-PG, end-to-end through the real drain:**

- **E1 — the grain fix closes the fail-open.** An Organization with **two** Companies, one holding
  a pending `authoritative_cost` receipt: the drain skips the whole org (`rollback_pending`) and
  cancels nothing. Positive control: with the receipt cleared, the same org drains its
  non-terminal attempts. Mutation: revert to `assertRollbackSafe(organizationId)` → the org drains
  despite the pending receipt → E1 reddens (this is the fail-open the grain bug causes).
- **E2 — `listActiveAttempts` returns real rows.** Seed non-terminal + terminal attempts across
  two Companies under one org; assert the drain cancels exactly the non-terminal ones and reports
  the counts. Positive control: an org with only terminal attempts drains zero and reports a clean
  sweep (not an error).
- **E3 — the `"cancelled"` status path is covered** (§3.2(3)) — the outcome MIG-002 flagged as
  untested.
- **E4 — the composed caller reaches `drainAll`** (the promotion evidence for `E10-1-drain`), with
  a mutation that no-ops the caller and turns E4 red.

This is unit/integration evidence, not a live rehearsal — the live "arm, roll back, confirm one
executor" rehearsal belongs to the Wave-4 cutover rehearsal (`GATE-clause-3-rollback-result.md`
§6 limit 4), and MIG-005 does not claim it.

## 5. Files

| Action | Path | Why |
|---|---|---|
| create | `server/src/services/commander-execution-owner.ts` | the pure `resolveCommanderExecutionOwner` + `shouldSuppressCommanderLegacy` (§3.1) |
| create | `server/src/__tests__/commander-execution-owner.test.ts` | the decision matrix + the positive control (stubbed authority) |
| create | `server/src/__tests__/commander-cutover-inert.test.ts` | the wiring proof: armed org, no authority, legacy spawn still runs (§3.1 M1) |
| modify | `server/src/services/internal-agent/cli-mode.ts` | one guarded block beside the shadow record, gating the legacy spawn on `shouldSuppressCommanderLegacy` |
| modify | `server/src/services/job-distributed-drain.ts` | per-Company rollback-safety grain (§3.2(1)); no interface lie |
| create | `packages/db/src/repositories/.../listActiveAttempts` SQL (follow the tenant repo pattern) | §3.2(2) — the missing SQL |
| create | `server/src/__tests__/job-distributed-drain.integration.test.ts` | embedded-PG E1–E4 (§4) |
| modify | `server/src/__tests__/job-distributed-drain.test.ts` | the `"cancelled"` status case (§3.2(3)) |
| modify | `server/src/index.ts` | compose + expose the drain caller behind the flag (§3.2), confirmed at Step 0 |
| modify | `scripts/gate-clause-wiring.json` | `E10-1-drain` → `wired` **on the caller** (or stay `unwired` with the R3 reason); bridge reasons repointed to the credential-prerequisite successor |
| modify | `epics/E10-.../findings.md` + `scripts/finding-ownership.json` | `jobAuditBridge` no-clause gap; the `commander_turn` credential prerequisite (§9), each with a manifest declaration in the same commit |

**No migration for the seam.** `listActiveAttempts` is a read, not a schema change. No frozen
`packages/worker-protocol` change (the seam and drain are server-side). No new `AOA_*` switch.

## 6. Fail-first TDD steps — one action each, RED before GREEN

Every step: write the failing test → **run it, watch it fail for the stated reason** → minimal
implementation → run it, watch it pass → commit. *A RED that does not fail for the reason written
down proved nothing; stop and find out why.* On this worktree the embedded-PG suites are
`describe.skipIf(win32 && AOA_RUN_WIN_INTEGRATION !== "1")` — **the prefix is not optional**, or
Steps 5–8 report skipped-as-green and sign off against a run that evaluated nothing.

**Step 0 — re-verify §0 at tip.** Re-read the cited lines; re-confirm the `index.ts` drain
composition site and whether a clean trigger fits inside MIG-005 (§3.2, §10 R3); decide the
`"cancelled"` status question (§3.2(3)). If §0.3's blocker has changed (a `commander_turn`
credential path has since landed), **STOP** — the premise moved and this is a different ticket.

**Step 1 — the decision skeleton + POSITIVE CONTROL first.** `resolveCommanderExecutionOwner`
returns `distributed` for `{ rolloutState:"canary", credentialAuthority: <stub> }`. RED: symbol
absent. GREEN: minimal body. This is the positive control — if the transfer path cannot be reached
even with a stubbed authority, every "stays legacy" assertion below is vacuous.

**Step 2 — the credential gate.** `{ rolloutState:"canary", credentialAuthority: undefined }` →
`legacy("commander_credential_unavailable")`; `{ rolloutState:"shadow"|"off"|"active", … }` →
`legacy("rollout_not_canary")`. Exhaustiveness: every `reason` renders. Anti-vacuity: the
`canary`+no-authority case must be distinct from the not-armed case, or M1 and M2 collapse.

**Step 3 — `shouldSuppressCommanderLegacy`.** True iff `owner==="distributed"`. RED, GREEN, commit.

**Step 4 — the seam wiring, dormancy structural.** Add the guarded block to `cli-mode.ts`. Prove
flag-off / hook-absent is a no-op by the source-scan house pattern (the `desktop-disabled.negative`
style), not by asking express — the hook is injected only under the flag.

**Step 5 — the inert wiring proof (embedded-PG or seam-level).** Arm the org for `commander_turn`
(rollout map `sources:["commander_turn"]`, mode `canary`), run a Commander turn with **no**
credential resolver composed, assert the **legacy** spawn ran (host/#320) and no suppression
occurred. This is the ticket's headline inert property.

**Step 6 — the drain grain fix (E1).** RED: an org with two Companies, one with a pending receipt,
drains despite it (the fail-open). GREEN: per-Company enumeration + assertion. Commit.

**Step 7 — `listActiveAttempts` SQL (E2).** RED: the drain cancels nothing because the enumerator
is unimplemented/returns []. GREEN: the SQL. Positive control: terminal-only org drains zero and
reports clean. Plus E3 (`"cancelled"` status).

**Step 8 — the production caller (E4).** RED: `E10-1-drain` is `unwired` and no boot root reaches
`drainAll`. GREEN: compose + expose in `index.ts`; flip the register to `wired`. Mutation: no-op
the caller → E4 red.

**Step 9 — docs + registers.** The `jobAuditBridge` no-clause finding + the credential-prerequisite
finding, each declared in `finding-ownership.json` in the same commit (a new open finding is born
undeclared and undeclared fails `policy`). Bridge `reason` fields repointed. Result doc.

```bash
pnpm --filter @armyofagents/server test:run -- src/__tests__/commander-execution-owner.test.ts
pnpm --filter @armyofagents/server test:run -- src/__tests__/commander-cutover-inert.test.ts
AOA_RUN_WIN_INTEGRATION=1 pnpm --filter @armyofagents/server test:run -- src/__tests__/job-distributed-drain.integration.test.ts
pnpm --filter @armyofagents/server typecheck && pnpm --filter @armyofagents/server build
node scripts/check-guard-inventory.mjs && node scripts/check-gate-clause-wiring.mjs && node scripts/check-finding-ownership.mjs
```

## 7. Mutation table — DELETE each guard, positive control FIRST

Rules (all from real incidents): **positive control first** (break the function outright; if the
suite still passes it exercises nothing); **DELETE a guard, never rewrite it to an equivalent**
(`return false && x` measures nothing); **a surviving mutant is a question, not a verdict**.

| # | Mutant (a DELETION) | Must redden | Why it is not equivalent |
|---|---|---|---|
| M0 | positive control — `resolveCommanderExecutionOwner` always returns `legacy` | Step 1 | if the transfer path is unreachable even with a stub authority, every "stays legacy" test is vacuous |
| M1 | delete the `credentialAuthority` present conjunct (so `canary` alone → `distributed`) | Step 5 inert wiring | proves the credential gate is the *only* thing keeping an armed Commander legacy; without it an armed turn would suppress the legacy spawn with no credential |
| M2 | delete the `rolloutState==="canary"` conjunct (so any state + stub → `distributed`) | Step 2 not-armed case | proves the rollout gate is load-bearing independently of the credential gate |
| M3 | delete `shouldSuppressCommanderLegacy`'s `owner==="distributed"` check (return true) | Step 5 | proves the seam actually reads the decision rather than always/never suppressing |
| M4 | no-op the composed drain caller in `index.ts` | E4 | proves `E10-1-drain`'s promotion is a real caller reaching `drainAll`, not a caller-count fiction |
| M5 | revert `assertRollbackSafe` to the org grain | E1 | proves the per-Company enumeration closes the fail-open; the org-keyed call matches no receipts and drains unsafely |
| M6 | drop a Company from the per-org enumeration (drain only the run's Company) | E1 variant | the sibling-Company fail-open canary-preflight §2.8 names; a receipt on Company B must still skip the org |
| M7 | `listActiveAttempts` returns `[]` | E2 | proves the SQL is load-bearing, not a still-empty interface |
| M8 | drop `"cancelled"` from `DRAINED_STATUSES` (or add it, per Step 0's finding) | E3 | pins the untested status either way |

Any survivor is investigated (delete both the guard and its backstop; if the suite then fails,
the mutant was equivalent). A documented equivalent that does not compile is **not** counted.

## 8. Acceptance mapping — every clause → a test that can turn RED; count the callers

| Acceptance clause | Test that can redden | Caller check |
|---|---|---|
| An armed Commander org (`sources:["commander_turn"]`, `canary`) with no credential resolver **still executes the legacy spawn** | `commander-cutover-inert.test.ts` (Step 5) | the seam block in `cli-mode.ts` is the real caller of the decision; M3 proves it reads it |
| The transfer decision is reachable **only** with a credential authority + `canary` | Step 1 (control) + M1/M2 | the decision function has a production caller (the seam); the `distributed` branch has **no** production producer (that is the point) |
| Flag-off / hook-absent: the Commander path is byte-identical | Step 4 source-scan | the hook is injected only under the flag |
| The drain does not fail open on a pending receipt (per-Company) | E1 + M5 + M6 | the fixed `assertRollbackSafe` grain is called per Company |
| `listActiveAttempts` returns the non-terminal attempts for an org | E2 + M7 | the SQL is called by `drainAll`; M4 proves `drainAll` is reached from a boot root |
| The `"cancelled"` status is covered | E3 + M8 | — |
| `E10-1-drain` is `wired` on a real caller (or `unwired` with the R3 reason) | E4 + M4 | **the promotion is caller-count** — M4 deletes the caller and reddens, so it is not a fiction |
| No parity bridge is claimed `wired` | `check-gate-clause-wiring.mjs` green with E3-5/15/17/18 + jobAudit all `unwired` | **counted:** each stays zero-caller; the register would redden if one were falsely promoted |

**No clause here is satisfiable by a function nothing calls.** The Commander decision has a caller
(the seam); the drain has a caller (index.ts, M4-proven); the "no bridge promoted" clause is
satisfied by the register checker itself, which reads caller count. The one deliberately
unreachable branch — the `distributed` transfer outcome — is *not* mapped to an acceptance clause
as coverage of a live condition; it is the plug-point, tested via a stub (Step 1) and labelled
unreachable-in-production, per the WRK-010 §4.2 discipline for declared-but-unreachable arms.

## 9. Non-goals, named with owners

| Not delivered | Owner | Why |
|---|---|---|
| **The Commander `active` flip** (execution actually transfers to a distributed worker) | **DEFERRAL-1-commander-credential** — a successor ticket, gated on the credential prerequisite | §0.3: no credential reaches a distributed Commander run. The flip needs a `commander_turn` credential path — a `provider_connection`/ambient-login analogue of CLI-007's canary-mint-authority + a DAT-008-style handle the worker redeems — and the convert/placement/executor that consumes it. Decision #117 (route-by-credential) territory |
| **The `commander_turn` convert / placement / executor** | same successor | Building an executor a credential-less turn could reach is the prohibited hazard (§2); it lands *with* the credential path, not before |
| **Commander warm-sandbox drain (Decision #120)** | same successor | Draining the legacy #320 warm Commander sandboxes is a cutover step; with no cutover there is nothing to drain from legacy to distributed |
| **Promoting `jobBudgetCostBridge` / `jobAuditBridge`** | the Commander `active` successor | They are what a distributed Commander run needs; nothing calls them on a legacy path, so promoting them here would be false wiring (§3.3) |
| **A `jobAuditBridge` gate clause** | filed as a finding here; owner = whoever wires the audit bridge | It is `unwired` and tracked by no clause (§0.6); the finding makes the green-by-absence visible before someone relies on it |
| **`createExecutionTargetRevocationFanout` consumer** (E3-18) | dispatch-teardown ticket | Orthogonal to Commander credentialing |
| **A live rollback rehearsal** | Wave-4 cutover rehearsal | §4 — MIG-005's rollback evidence is unit/integration, not a staged arm-and-revert |
| **MIG-006 (crew) / MIG-007 (one-shot)** | their own tickets | *One sink at a time.* Both inherit §0.3's blocker until their own credential class has a path (crew shares the org/Company key more closely than Commander — a distinct analysis) |

## 10. Risks and rollback

**R1 — the inert seam is mistaken for a live cutover.** The `distributed` branch exists and is
tested via a stub; a careless reader could think Commander can transfer. Mitigation: the branch has
**no production producer**, the reason string is `commander_credential_unavailable`, and §3.1/§8
label it unreachable-in-production. The result doc must headline "Commander did NOT go active."

**R2 — the drain grain fix touches a Wave-3 service.** `job-distributed-drain.ts` is E3/CLI-005
infrastructure. The change is additive (per-Company enumeration) and the org-heartbeat canary is
its only live producer, so the blast radius is the rollback path alone. Mutation E1/M5/M6 pins the
fix; the pre-existing `job-distributed-drain.test.ts` mocks stay valid (they inject the deps).

**R3 — the drain trigger may not fit cleanly in MIG-005.** If `index.ts` has no honest teardown
site for the drain within this ticket, keep `E10-1-drain` `unwired` with a reason naming the two
correctness fixes shipped and the trigger owed to REL-005 (the kill-switch write-path lane) — the
drain is *correct when wired* regardless. This is a stated fallback, not a failure; the register
must never claim `wired` without a caller.

**R4 — `DRAINED_STATUSES` "cancelled" semantics.** MIG-002 flagged it as possibly stranding a run.
Step 0 resolves it before the drain is wired; E3 covers it either way. Getting it wrong wires a
drain that reports a clean sweep while stranding work — the exact failure the rollback lever exists
to prevent.

**Rollback of MIG-005 itself.** The seam is dormant by absence (flag-off / hook-absent → no-op);
reverting the `cli-mode.ts` block restores byte-identical Commander behaviour. The drain caller is
flag-gated; removing the composition leaves the corrected drain callable only from tests (back to
`unwired`), which is strictly safer than the current fail-open. No migration to reverse
(`listActiveAttempts` is a read).

## 11. What this design deliberately does not do

1. It does **not** route any Commander turn to a distributed path — §0.3, §2.
2. It does **not** resolve Deferral #1 for the Commander sink — it names the prerequisite (§9).
3. It does **not** promote any parity bridge — nothing calls them on a legacy path (§3.3).
4. It does **not** claim GATE clause 3 is re-satisfied for `commander_turn` — that stays trivially
   satisfied because Commander did not move; it re-satisfies the org-heartbeat in-flight strand via
   the drain (§0.7, §4).
5. It does **not** touch `packages/worker-protocol` (FROZEN) or add a graph node / manifest entry
   (a later wiring step does — per the sprint brief).
6. It does **not** claim a live rollback rehearsal (§4).

**Open decisions for Step 0** (the house re-verify rule): the exact `index.ts` drain composition +
invocation site and whether it fits MIG-005 (R3); the `"cancelled"` status semantics (R4); and a
final confirmation that no `commander_turn` credential path has landed since tip (which would
retire the blocker and change the ticket).
