> ★★★ **REVIEW-VERIFIED (2026-08-27): extraction is NOT buildable today, and NOT recommended even once
> unblocked.** This design's blocked verdict was checked against source and holds: `one_shot` refuses at
> the mint's guard 3 (agentless principal, same gate as `commander_turn`), extraction is a sync
> request/response with no async result-return path (suppressing the direct call = zero extracted items),
> and it already runs in an isolated E2B sandbox with the Company key (thin cutover value). It also
> corrected finding **E10-F001**, which had overstated extraction's readiness. **What this establishes for
> Sprint 6:** no sink cuts over today; the real work is the shared prerequisites (routing seam +
> mint-runner generalization) + the drain. See E10-F001 and go-book §4 Sprint 6.

---

> ★★★ **READ THE VERDICT BANNER FIRST.** This is Sprint 6's *first* real cutover by the corrected
> order (E10-F001: lead with extraction, not Commander). It was written expecting a buildable
> cutover. Reading the code changed that: **extraction's cutover is NOT buildable end-to-end today,
> and it is not clearly worth doing.** Two hard gaps sit beyond the credential — a synchronous↔
> asynchronous execution mismatch and an agentless-`one_shot` credential-mint refusal — and the
> value is thin because extraction *already* sandbox-executes with the Company key. So this design
> does **not** flip extraction. It reframes the sink, pins both blockers as **falsifiable** tests,
> names the prerequisites with owners, and hands the real flip to successors. That is a legitimate,
> respected outcome — the same shape as MIG-005 (Commander, blocked) and Sprint 5b (harness ready,
> run owed). Where E10-F001 and the go-book are wrong against the code, §0.9 says so.

---

# MIG-007 — Design: extraction (`one_shot`) execution-sink cutover, shadow → canary

**Ticket node:** `docs/replatform/program-design.md` (`#### MIG-007 — Cut one-shot CLI operations
over`, program-design.md:1072). The coverage checker keys on the `MIG-007` id, so this file needs
**no new node**, and per the sprint brief this design adds none.
**Epic:** E10 (Desktop, Migration, Realtime). **Sprint:** 6, **unit 1** — the go-book rule is
*"one sink at a time, do not batch"*, and per **E10-F001** the corrected order leads with
**extraction (MIG-007)** because it is the *credential-closest* sink, not the lowest blast radius
(`GO-BOOK.md` §4 Sprint 6, reordered 2026-08-27).
**Predecessors (shipped):** `MIG-005-006-007-shadow-{design,result}.md` (the shadow observers —
extraction was the sole shadow-admissible sink), `MIG-002-dial-*` + `MIG-002-convergence-*` (the
per-sink dial), `CLI-006-*` / `CLI-007-*` (the org-heartbeat canary transfer + its Company-key
mint), `DAT-008-slice-5-*` (the worker-side handle redemption), `GATE-clause-3-rollback-*` (the
rollback path + per-sink status table), `MIG-005-cutover-design.md` (the Commander design whose
review reordered this sprint and whose §4 drain analysis is sink-agnostic).
**Terrain reference:** `qa/2026-08-27-breadth-terrain-audit.md` (Sprint 6 section).
**Size:** M (analysis + falsifiable pins; **not** the XL a real flip would be — §0.4).
**Verified at tip `2346e5bf4`** — re-verify §0 at execution time (line numbers drift; the house
has been bitten by stale citations, and this file cites ~30).

---

## ★ VERDICT BANNER — read this before anything else

**Can MIG-007 (extraction) go `canary` today — i.e. make an extraction run execute on the
distributed worker path instead of the direct server-acquired E2B sandbox? NO — NOT BUILDABLE
END TO END.** Three findings, each traced in §0:

1. **The execution model is incompatible (the primary blocker, §0.3).** Extraction is a
   **synchronous request/response**: `extractViaCli` `await`s `runOneShotCliInSandbox` and parses
   the returned `stdout` into extracted items (`extraction-cli.ts:364`). The distributed substrate
   is **asynchronous fire-and-forget**: the server submits a job, a *separate* worker leases it
   *later*, executes, and reports terminal events. **No wired path returns a `one_shot`'s stdout to
   a blocking server caller** — the output bridge that would carry it is zero-caller
   (`jobOutputBridge`, `E3-17-output` `unwired`) and projects `task_outputs`/artifacts, not a
   captured stdout string. Cutting extraction over therefore requires either a synchronous
   run-and-await-result mechanism over the distributed path (absent) or an async re-architecture of
   the discussion pipeline (out of a sink-cutover's scope). MIG-007's **own** node acceptance
   demands the operation *"preserves its … result … contract"* (program-design.md:1076) — which the
   async substrate cannot satisfy today.

2. **The credential does NOT ride CLI-007's mint as built (§0.2).** A distributed `one_shot` run
   *reaches* the mint and *passes* the executor gate (`isAgentBackedExecutorKind` admits `"worker"`,
   which `one_shot` is — `job-submission.ts:212`), but **refuses at the very next gate**,
   `adapter_not_v1_scope` (`execution-secret-handle-mint.ts:167`). The mint runner sources the
   adapter type from an **agent binding keyed on `executorPrincipalId`**
   (`execution-secret-handle-mint-runner.ts:108-116`), and extraction's principal id is an
   **ephemeral `operationId`** (`job-submission.ts:212`) with no agent row — so `adapterType` falls
   to `""` and guard 3 refuses. Result: **no handle minted → the worker redeems nothing → the
   sandbox authenticates to the model provider with nothing.** Exactly Deferral #1, exactly the
   class the sprint brief forbids designing a cutover into. This gap is *bounded* (the Company key
   **is** the class the mint produces — closing it is a mint-runner change, not a new credential
   class like Commander's per-user need), but it is **not closed today**.

3. **The value is thin-to-negative (§0.4).** Extraction **already** runs in an isolated E2B
   sandbox, **already** resolves the **Company** model-provider key, and **already** tears the
   sandbox down after — directly from the server (`one-shot-sandbox-cli.ts:1-19`, :189, :205-235).
   It is *already sandbox-isolated and Company-credentialed*. Moving it onto the worker-leased path
   buys fleet placement + unified observability, at the cost of the sync→async re-architecture, the
   mint change, and a **latency regression on a user-facing path** (a founder waits for extracted
   items; queueing that behind a worker winning a lease is worse, not better). "Already distributed
   enough" is the honest reading.

**Consequence for this design.** MIG-007 does **not** transfer any extraction run. It builds no
executor and — deliberately, unlike WRK-010 slice 1 and unlike MIG-005's first draft — **no inert
routing seam** (§2 rejects it: the suppress-legacy shape is *wrong* for a synchronous caller and
would go stale as misleading cutover-shaped scaffolding). What it **lands** is credential-independent
and non-stale: a **falsifiable characterization** that pins both blockers as tests a successor
cannot silently pass (§3), the two **findings** with owners (§9), the **GATE clause 3** disposition
(one_shot stays trivially satisfied — nothing moves, §4), the **parity-bridge** disposition (§3.3),
and the **corrections** to E10-F001 / the go-book (§0.9). The real flip is a successor epic slice,
gated on the two prerequisites named in §9.

---

## ★ 0. Verified state at tip, and the three answers

Every claim below was read at tip `2346e5bf4`. The two commits since MIG-005's `921d6a131` are
docs-only, so code line numbers are stable — but **re-verify at execution time** regardless (§6
Step 0).

### 0.1 Where extraction stands — shadow only, inert unless rollout is `shadow`

| Fact | Evidence at tip |
|---|---|
| Extraction records a distributed **shadow** beside its direct sandbox call | `one-shot-sandbox-cli.ts:284` — `recordDistributedShadow({source:{kind:"one_shot", operationId, operationKind}, …})`, placed after the provider resolves and **before** `execute` |
| ONE seam covers **three** operation kinds | `one-shot-sandbox-cli.ts:126-133`, :289 — extraction / compaction / readiness_probe all route through `runOneShotCliInSandbox`; the shadow record's `operationKind` distinguishes them |
| The shadow record is a no-op unless a recorder is registered, and it never throws | `distributed-shadow-port.ts:62-70` |
| The recorder acts on `shadow` only; `active`/`canary` are owned by the convert/placement path, not by an observability record | `distributed-shadow-port.ts:137` — `if (state !== "shadow" \|\| !organizationId) return;` |
| The three extraction callers | `extraction-cli.ts:364` (discussion/debrief/file-import extraction), `internal-agent/cli-summarizer.ts:154` (Commander **compaction**, U13.6), `sandbox-readiness-probe.ts:108` (readiness probes, U13.7) |
| **Extraction has no owning agent** — stated in the code | `one-shot-cli-budget.ts:5` — *"none of which have an owning agent"*; the acquire uses `agentId: null` (`one-shot-sandbox-cli.ts:207`) |

**So extraction has an observability record and nothing more.** There is no execution-transfer
path for `one_shot` — only the org heartbeat (`task_run`) has one (§0.2 in MIG-005; unchanged).

**Terminology note, load-bearing (carried verbatim from MIG-005 §0.2).** The go-book titles Sprint 6
*"MIG-005/006/007 ACTIVE"*, but in the rollout vocabulary `active` is a durable **non-leasable**
convert that does **not** suppress the legacy path or execute distributed; the mode that actually
transfers execution is `canary` (`distributed-execution-rollout-source.ts:39-53`;
`run-execution-owner.ts:238` — `if (state !== "canary") return legacy("rollout_not_canary")`).
Throughout this design, **"cut extraction over" means "make an extraction run execute on the
distributed worker path instead of the direct `one-shot-sandbox-cli` E2B spawn"** — the
`canary`-shaped transfer, not the `active` convert. The distinction matters because it is the
transfer, not the convert, that needs a credential *and* a way to return a result.

### 0.2 ★ ANSWER 1b — the credential: does a distributed `one_shot` run ride CLI-007's mint? **NO.**

Trace it from the credential the org-heartbeat canary receives (`task_run`), then ask whether an
extraction `one_shot` can receive the same, gate by gate.

**(a) How the canary (`task_run`) is credentialed — the CLI-007/DAT-008 path.** The canary ownership
decision threads `mintCredentialAuthority: gate.credentialAuthority` into placement
(`run-execution-owner.ts:267-276`). `gate.credentialAuthority` is the constant
`CANARY_CREDENTIAL_AUTHORITY = "company_api_key"` (`canary-mint-authority.ts:41`), emitted **only**
on the `ok` result of the MIG-008 preflight, which verifies the **Company** holds provider-control
authority and enumerates **every Company under the Organization**
(`canary-preflight.ts:130`, :150, :190). Placement then runs the mint
(`job-placement-transaction.ts:384` → `mintCredentialKindFor` → `mintExecutionSecretHandleForPlacement`),
which for a `task_run` mints a Company `provider_key` handle the worker redeems (DAT-008 slice 5).

**Crucially, the preflight and the credential authority are Company/Organization-scoped, NOT
`task_run`-scoped.** Nothing in `canary-preflight.ts` or `canary-mint-authority.ts` inspects the
source kind. So the *authority* is available to any source that rides the same ownership decision.

**(b) Now walk a `one_shot` extraction run through the mint gates** (`execution-secret-handle-mint.ts`),
using what `submitJobWithinTenant` stamps for `one_shot`:

| Gate | `execution-secret-handle-mint.ts` | `one_shot` extraction | Verdict |
|---|---|---|---|
| 1 `not_cloud_deployment` | :157 `isCloudSandboxMode` | extraction only sandbox-executes on `cloud_auth`/`authenticated` (`sandbox-coding-disposition.ts:124`) | **passes** on cloud |
| 2 `executor_not_agent` | :162 `isAgentBackedExecutorKind` (admits `agent`/`worker`/`sandbox`) | `one_shot` executor principal is `{kind:"worker", id: operationId}` (`job-submission.ts:212`) → `"worker"` | **passes** |
| 3 `adapter_not_v1_scope` | :167 `gateCodingAdapterDispatch(adapterType, …).admitted` | the mint runner loads the adapter from an **agent binding keyed on `executorPrincipalId`** (`…mint-runner.ts:108-116`); `executorPrincipalId` = the **ephemeral `operationId`**, which matches no agent row → `agent = null` → `adapterType = ""` → not `v1` | **REFUSES** |

The refusal is `adapter_not_v1_scope`. **The mint mints nothing for an agentless `one_shot`.** The
worker would redeem no handle; the sandbox would have no Company key. This is the *same gate* that
refuses `commander_turn` (whose sandbox carries a run id that likewise resolves to no v1 coding-agent
binding — the mint's own comment names it, :118-126). Extraction and Commander are the **same refusal
class at the mint**, contrary to E10-F001's framing (§0.9).

**(c) Why the gap is nonetheless *smaller* than Commander's, and *bounded*.** The credential
extraction needs is the **Company** model-provider key (`resolveCompanyProviderCredential`,
`one-shot-sandbox-cli.ts:189`) — precisely the class the mint already produces as a `provider_key`
handle (guard 3's `absent`-binding arm, :198-205). Commander needs a **per-user** `provider_connection`
credential the mint cannot produce at all (Decision #117 territory, MIG-005 §0.3). So closing
extraction's gap is a **mint-runner change** — give an agentless `one_shot` a way to present a
v1-scope adapter (`claude_local`/`codex_local`, which extraction already uses at
`one-shot-sandbox-cli.ts:210`) and an `absent` provider binding so the mint emits the Company
`provider_key` — **not a new credential class**. That is the DEFERRAL-1-oneshot-credential
prerequisite (§9). It is net-new, but bounded.

**Verdict 1b: `one_shot` does not ride CLI-007's mint today. It reaches the mint and passes the
executor gate, then refuses at `adapter_not_v1_scope` because extraction is agentless.**

### 0.3 ★ ANSWER 1a — the routing/execution: is the distributed path *reachable and returnable*? **NO.**

Two sub-parts: routing (does the transfer machinery exist for `one_shot`?) and result (can a
distributed `one_shot`'s output reach its synchronous caller?).

**(a) Routing.** The convert/placement/ownership machinery is generic over `SubmitJobSource`
(`run-execution-owner.ts:181-197`, `job-convert-orchestrator.ts:37-42`), and `submitJobWithinTenant`
already has a `one_shot` admission branch (`job-submission.ts:208-212`). So a seam *could* call
`resolveExecutionOwner({source:{kind:"one_shot", …}})`. But that machinery is **wired only at the
heartbeat seam** for `task_run` (`heartbeat.ts:3174-3189` resolves rollout with
`sourceKind:"task_run"`; :5216-5241 resolves ownership; :5254 suppresses legacy). The one-shot seam
(`one-shot-sandbox-cli.ts`) imports **only** `recordDistributedShadow` — no rollout hook, no
resolver, no suppression. **Extraction needs NEW routing built** (rollout read for `one_shot`,
ownership resolution, and legacy-suppression), analogous to the ~2,000-line-apart heartbeat wiring.
That alone is real work — but it is *inert scaffolding* until (b) is solved.

**(b) Result return — the blocker (b) cannot cross.** Even with routing + credential in place, the
transfer's shape is fatally wrong for extraction:

| | Extraction today (`one_shot`) | The distributed `task_run` transfer |
|---|---|---|
| Caller shape | **synchronous** — `await runOneShotCliInSandbox(…)` returns `OneShotCliResult`, and `extractViaCli` parses `result.stdout` (`extraction-cli.ts:362-375`) | **asynchronous** — the heartbeat *suppresses* `adapter.execute` and returns; a worker leases the attempt later and executes; results project back via terminal events |
| Result delivery | the stdout string, in-process, right now | terminal events → the output bridge (`jobOutputBridge`, **zero-caller**, `E3-17-output` `unwired`) → `task_outputs`/artifacts — **never a stdout string to a blocking caller** |
| What the caller does with "no result yet" | impossible — it blocks on the value | the task is inherently deferred; the founder observes the issue later |

There is **no wired synchronous "run this command on a worker and give me its stdout" path**, and
the async substrate does not carry a `one_shot`'s stdout back to a blocking server call at all. So a
canary that suppressed the direct `runOneShotCliInSandbox` call would leave `extractViaCli` with
**nothing to parse** — the extraction would silently produce zero items. That is not a cutover; it is
a data-loss bug. Building the missing path is either (i) a new synchronous result-over-distributed
mechanism (a job-control primitive that does not exist) or (ii) an async re-architecture of the
discussion-extraction pipeline (a product change well outside a sink-cutover mechanic).

**Verdict 1a: extraction's cutover is not buildable end-to-end. Routing must be built AND a
result-return path that does not exist must be built AND the credential gap (§0.2) must be closed —
three prerequisites, two of them net-new mechanisms.**

### 0.4 ★ ANSWER 2 — is the cutover worth it? **Thin-to-negative value; extraction is already distributed enough.**

Extraction's *current* path is not the legacy in-process host spawn the other sinks run — it is
**already** an E2B sandbox with the Company key:

- `resolveCompanyProviderCredential(db, companyId, …)` — the **Company's** own key, never the host's
  (`one-shot-sandbox-cli.ts:188-191`).
- `acquireExecutionContext(…)` → a fresh sandbox lease; `driver === "sandbox"` required, else fail
  closed (`:205-235`).
- ephemeral by construction — `releaseRunLease` KILLs the VM after (`:367-393`).

So the properties a cutover usually *delivers* — isolation, Company-scoped credentialing,
ephemerality — extraction **already has**. What the worker-leased path would add:

| Adds | Worth it for extraction? |
|---|---|
| Placement onto the worker **fleet** (desktop / any connected device) | **Poor fit.** Extraction is system-initiated, Company-scoped, and latency-sensitive (a founder waits for extracted items). Depending on a founder's desktop being online and winning a lease is a *regression* in reliability and latency, not a gain. |
| Unified job-control observability (one attempt row, fences, terminal events) | Marginal — extraction already records cost (`recordOneShotCliCost`) and a shadow probe. |
| The distributed drain / kill-switch rollback lever | Already covered for the sandbox by the environment-lease reaper; the kill switch is instance-wide per provider regardless (GATE clause 3 §2, C2). |

**Cost:** the sync→async re-architecture (§0.3b), the mint change (§0.2c), the new routing (§0.3a),
plus a **latency regression** on a user-facing path. **Net: the build is large and the value is thin
or negative.** The honest reading is that extraction is *already sandbox-isolated and
Company-credentialed*, and the distributed path's marquee benefit (fleet mobility for long-running
work) does not apply to a short, synchronous, latency-sensitive extraction call.

### 0.5 ★ ANSWER 3 — what "canary" means for extraction, and the clause-3 rollback

**What canary *would* mean** (if buildable): one Organization's extraction runs (`sources:["one_shot"]`,
`mode:"canary"`) route through submit→convert→place→worker-lease→execute→return, while every other
Organization's extraction stays on the direct `one-shot-sandbox-cli` path. The per-sink dial makes
this **expressible** — `OrganizationRolloutPolicy.sources` filters by source kind
(`distributed-execution-rollout-source.ts:72`, :270-271), so an operator can arm `one_shot` alone
without arming `task_run`. **Expressible is not executable:** §0.2/§0.3 block execution.

**What rollback re-satisfies for GATE clause 3.** Clause 3 for `one_shot` is *"no — shadow only …
trivially satisfied; RE-SATISFY at activation"* (`GATE-clause-3-rollback-result.md` §4, :121).
**Because MIG-007 does not activate, clause 3 for `one_shot` STAYS trivially satisfied — there is
nothing to roll back because nothing moved.** The design states this rather than manufacturing a
rollback for a sink that never transferred (that would be the shadow ticket's own tautology, one
level up). The re-satisfaction obligation is deferred to the successor that actually flips extraction
(§9), which owes the arm→roll-back→confirm-one-executor evidence then. The rollback *mechanism* that
successor will use is the two-step lever clause 3 already names (kill switch, then rollout-map edit +
restart with the deployment flag ON — `GATE-clause-3-rollback-result.md` §2) plus the drain (a
separate ticket, §9), none of which MIG-007 builds.

### 0.6 The parity bridges — five, not three; four are zero-caller (carried from the terrain audit)

| Symbol | Clause | Status | Evidence |
|---|---|---|---|
| `jobApprovalBridge` | `E3-5-product-approval` | `unwired` | zero callers |
| `jobBudgetCostBridge` | `E3-15-budget` | `unwired` | zero callers |
| `jobOutputBridge` | `E3-17-output` | `unwired` | zero callers — **the very bridge extraction's result would need (§0.3b)** |
| `jobAuditBridge` | **none** | `unwired`, **tracked by NO clause** | terrain audit §Sprint 6 GAP; `job-audit-bridge.ts` |
| `createExecutionTargetRevocationFanout` | `E3-18-revocation` | `unwired`, **producer live** | Revoke writes a `pending` row nothing reads |

The terrain audit's correction stands at tip: **five parity surfaces**, and `jobAuditBridge` is
invisible to `check-gate-clause-wiring.mjs` because no clause names it.

### 0.7 The drain is a separate, sink-agnostic ticket — NOT MIG-007's

`createDistributedExecutionDrain` is zero-caller, calls `assertRollbackSafe(organizationId)` where
every implementation takes a `companyId`, and its `listActiveAttempts` has no SQL
(`E10-1-drain` `unwired`; MIG-005 §0.5; terrain audit §Sprint 6). **E10-F001 and the go-book both
say the drain fix ships on its own regardless of sink order** (*"The drain fix is a separate,
sink-agnostic, unblocked item"* — findings.md:28-30; `GO-BOOK.md` §4 Sprint 6). MIG-005's design
claimed the drain; its review then re-assigned it to *"its own ticket"*. **MIG-007 does not claim it
either** — it is named as a non-goal with that owner (§9). MIG-007 has no credential-independent
correctness fix to ship in its place (Commander's design had the drain; extraction's does not),
which is *why* MIG-007's landable deliverable is the falsifiable characterization (§3), not a code
fix.

### 0.8 The per-sink dial is live — "arm `one_shot` alone" is expressible

`OrganizationRolloutPolicy.sources` is the MIG-002 per-sink axis, filtered in `workloadEnabled`
(`distributed-execution-rollout-source.ts:261-272`; `sources` absent ⇒ all sinks, so pre-MIG-002
configs are byte-identical). Re-read per resolution (:231-255), so an operator could arm `one_shot`
alone with no restart. This is what makes an isolated extraction cutover *expressible* — and, because
of §0.2/§0.3, still not *executable*.

### 0.9 ★ Where E10-F001, the terrain audit, and the go-book are WRONG against the code

The sprint brief asks for this explicitly. Three corrections, in decreasing severity:

1. **E10-F001 (and `GO-BOOK.md` §4 Sprint 6) overstate extraction's readiness.** They say extraction
   is *"the only sink whose cutover is buildable today"* and rides *"the same `company_api_key` class
   CLI-007's mint produces"* (findings.md:12-16; GO-BOOK §4 Sprint 6). **The mint would REFUSE an
   agentless `one_shot` at guard 3** (`adapter_not_v1_scope`, §0.2) — extraction does **not** ride
   CLI-007's mint as built. It is *closer* than Commander (Company-key class; executor gate passes),
   but "buildable today" is false: the credential gap is open **and** the async result-return blocker
   (§0.3b) is real. **Neither E10-F001, the terrain audit, nor the go-book names the async
   result-return blocker at all** — arguably the bigger obstacle, and the one that makes this not a
   single-ticket cutover.

2. **E10-F001's mint citation is imprecise, and the imprecision matters.** It cites
   *"the mint actively refuses a `commander_turn` (execution-secret-handle-mint.ts:122)"* (findings.md,
   and `finding-ownership.json` E10-F001). Line 122 is inside the **comment block** of
   `isAgentBackedExecutorKind`; `commander_turn` is not refused at the executor gate (guard 2, which
   admits `worker`/`sandbox`) but at **guard 3** (`adapter_not_v1_scope`, :167) — the *same* gate that
   refuses extraction. So Commander and `one_shot` are the **same refusal class** at the mint, which
   removes the clean "extraction rides the mint, Commander doesn't" distinction E10-F001 draws. The
   real distinction is the credential *class* the workload needs (Company vs per-user), not whether
   the current mint fires — it fires for neither.

3. **Minor — the go-book's Sprint 6 note conflates "already sandbox-executes" with "cutover-ready."**
   Extraction *does* already sandbox-execute with the Company key (true, §0.4) — but that is the
   argument that the cutover is *low-value* (already distributed enough), not that it is *ready*. The
   two are used interchangeably in the note; §0.4 separates them.

**Nothing else in E10-F001, the terrain audit, or the go-book was found wrong** — the shadow-only
status, the per-sink dial shipping, the five-bridge count, the drain being separate, and clause 3
staying trivially satisfied all hold at tip.

---

## 1. The facts this ticket exists to change — and the ones it cannot

| Fact | Evidence | This ticket |
|---|---|---|
| An extraction run records a shadow probe and executes on the **direct** server-acquired E2B sandbox | `one-shot-sandbox-cli.ts:284`, :205-235 | **unchanged** — extraction stays on the direct path |
| No routing decides whether an extraction run *could* transfer | §0.3a | **does not build it** — an inert routing seam is rejected (§2): the suppress-legacy shape is wrong for a synchronous caller and would go stale as misleading scaffolding |
| A distributed `one_shot` run gets no credential (mint refuses agentless `one_shot`) | §0.2 | **cannot change** — named `DEFERRAL-1-oneshot-credential` (§9); pinned falsifiable (§3.1) |
| A distributed `one_shot` run has no way to return its stdout to the synchronous caller | §0.3b | **cannot change** — named `MIG-007-async-result` prerequisite (§9); pinned falsifiable (§3.2) |
| The rollback drain is zero-caller, wrong-grained, no SQL | §0.7 | **not MIG-007's** — a separate sink-agnostic ticket (§9) |

**Net:** MIG-007 makes the two blockers to an extraction cutover **falsifiable and owned**, corrects
the record that said the cutover was buildable, and hands the flip to a successor — without moving a
single extraction run onto a path that cannot credential it *or* return its result.

## 2. The shape of what lands, and what is rejected

**One sentence.** Do not flip extraction; instead pin the two blockers (agentless-`one_shot` mint
refusal; absent synchronous result-return) as **mutation-tested characterization guards** so a
successor cannot build a false cutover, file both as findings with owners, and record the clause-3
and parity-bridge dispositions.

**Rejected — build the full `one_shot` convert/placement/execution + suppression now.** The sprint
brief's explicit prohibition (*"do NOT design a cutover that would route \[the sink] to a distributed
path that cannot credential \[or execute] it"*). Worse than Commander's case: suppressing the direct
`runOneShotCliInSandbox` call with no result-return path **silently produces zero extracted items** —
a data-loss bug, not honest dormancy. So no executor and no suppression are built.

**Rejected — build an inert routing seam (the WRK-010-slice-1 / MIG-005-first-draft pattern).**
MIG-005's review dropped its inert `resolveCommanderExecutionOwner` seam because *"its caller is both
unscheduled and undesigned … it would go stale before the real routing is designed"* (MIG-005 banner).
That reasoning is **stronger here**: a `resolveOneShotExecutionOwner` seam would mirror the heartbeat's
*suppress-legacy-and-let-a-worker-take-it* shape — which is **fundamentally wrong** for a synchronous
extraction (the caller needs the stdout back, §0.3b). Shipping cutover-shaped scaffolding that encodes
the wrong execution model is the exact stale-bait the house guards against. Dropped.

**Rejected — reuse the canary credential authority for `one_shot` by force-fitting an adapter.** One
*could* make the mint fire by having the `one_shot` job carry a `claude_local` adapter so guard 3
passes. But that mints a Company `provider_key` for a run that **still cannot return its result**
(§0.3b) — a credential delivered to an execution that must not happen. Credential without a viable
execution is worse than neither; the two prerequisites must land together, in a successor, not
half-here.

**Rejected — claim the drain here.** It is a separate sink-agnostic ticket (§0.7); promoting a
zero-caller drain on a sink that never transfers is false wiring.

**Rejected — a prose-only "extraction is blocked" note with no test.** *"A prose note is not a
mutation-tested guarantee"* (MIG-005 §2; `checks-that-nothing-runs`). The falsifiable pins (§3) make
"the mint refuses an agentless `one_shot`" and "extraction consumes stdout synchronously" properties
a successor's change must visibly break, not sentences it can overlook.

## 3. Architecture — the falsifiable characterization that lands

Two pure/near-pure guard suites and one wiring-register assertion. Each turns a §0 blocker into a
test that **reddens** if the blocker is (accidentally or deliberately) removed — so a successor who
closes a gap must update the guard in the same change, making the closure visible.

### 3.1 The credential-gap guard — the mint refuses an agentless `one_shot` (pins §0.2)

`decideExecutionSecretHandle` is pure (`execution-secret-handle-mint.ts:152`), so this is a direct
unit test with no database:

- **Positive control (first).** A `task_run`-shaped input — `executorPrincipalKind:"worker"`,
  `adapterType:"claude_local"`, a `provider_key` target, `placementOwner:"managed_cloud"`,
  `credentialKind:"company_api_key"` — **mints** a `provider_key` handle. If this does *not* mint, the
  guard proves nothing (the mint is broken for reasons unrelated to `one_shot`).
- **The pin.** A `one_shot`-shaped input — identical **except** `adapterType:""` (the value the
  runner produces for an agentless operationId principal, §0.2b) — **refuses with
  `adapter_not_v1_scope`**, *even when* `credentialKind:"company_api_key"` is supplied (proving the
  refusal is the adapter gate, not the owner-authority gate). This is the falsifiable statement of
  "`one_shot` does not ride the mint."
- **The runner half.** `mintExecutionSecretHandleForPlacement` with `executorPrincipalKind:"worker"`
  and `executorPrincipalId` = a non-agent `operationId`, backed by a `loadAgentAdapterBinding` stub
  that returns `null` for that id (the real behaviour — no agent row), **refuses**
  (`adapter_not_v1_scope`), and **inserts no handle**. This pins the *whole* runner path, not just the
  pure decision.

**Why it is load-bearing, not decorative.** Deleting guard 3's refusal (`execution-secret-handle-mint.ts:167`)
turns the `one_shot`-shaped input into a **mint** (M1, §7). If a successor closes the gap by teaching
the runner to supply a v1 adapter for an agentless `one_shot`, this guard **must** change — which is
exactly the visible-closure property.

### 3.2 The result-gap guard — extraction is synchronous and no distributed return exists (pins §0.3b)

Two assertions, because the gap is "a synchronous consumer + an absent async return":

- **Synchronous consumer (structural).** A test that `runOneShotCliInSandbox` returns a resolved
  `OneShotCliResult` carrying `stdout`, and that `extractViaCli` reads `result.stdout`
  (`extraction-cli.ts:362-375`) — the return value is *consumed in-process*, not projected. A
  source-scan/contract assertion in the `extraction-cli` test file, so a refactor that makes
  extraction fire-and-forget must update it.
- **Absent async return (wiring register).** `jobOutputBridge` (`E3-17-output`) stays `unwired`
  (zero callers) — asserted by `check-gate-clause-wiring.mjs`, which reads caller count. The design
  states in prose (§0.3b) that this is the bridge a distributed `one_shot` result would need, so the
  register's own green is the pin: the day someone wires an output path for a distributed `one_shot`,
  the register flips and the successor is forced to reconcile the clause. **No new symbol is
  promoted; nothing is claimed `wired`.**

### 3.3 The parity bridges — analysis, and why none is promoted

Which of the five (§0.6) a distributed extraction run would need, if it existed:

| Bridge | Needed by a distributed `one_shot` extraction? | Reasoning |
|---|---|---|
| `jobOutputBridge` (E3-17) | **Yes — and it is the §0.3b blocker** | Extraction's *result* is its whole point; a distributed run's stdout must reach the caller, and this is the only projection surface — currently zero-caller |
| `jobBudgetCostBridge` (E3-15) | **Yes** | Extraction incurs model cost (`recordOneShotCliCost`); a distributed run's cost must flow through the bridge, not the in-process cost path |
| `jobAuditBridge` (no clause) | **Likely** | Extraction writes activity; the distributed path projects audit through this bridge. Its **no-clause status** (§0.6) is filed as a finding (§9) so it is visible before someone wires it green-by-absence |
| `jobApprovalBridge` (E3-5) | **No** | Extraction passes no task review/approval |
| `createExecutionTargetRevocationFanout` (E3-18) | Orthogonal | A live producer with no consumer; sequence with dispatch teardown |

**None is promoted by this ticket.** Extraction does not go canary, so nothing on a distributed
`one_shot` path calls any of them; promoting a zero-caller symbol to `wired` is the defect the
register exists to prevent (go-book §6). Each stays `unwired`; the reasons are repointed to name the
extraction-cutover successor rather than a bare "Sprint 6", so the register tells the truth about
*what* would promote them. The `jobAuditBridge` no-clause gap is filed (§9).

## 4. Rollback evidence — GATE clause 3 for `one_shot` stays trivially satisfied

Clause 3 for `one_shot` **stays trivially satisfied** because extraction does not transfer (§0.5) —
the design states this rather than manufacturing a rollback for a sink that never moved (that is the
shadow ticket's own §1 tautology, one level up). There is nothing in flight to drain, nothing
handed off to strand, no fence to revoke.

**The evidence is the falsifiable "nothing transfers" property itself:**

- **E1 — no execution-transfer path is composed at the one-shot seam.** A source-scan/contract test
  that `one-shot-sandbox-cli.ts` imports **only** `recordDistributedShadow` and no ownership
  resolver / suppression predicate — so no `one_shot` run can be suppressed onto a distributed
  attempt. (The heartbeat's `shouldSuppressLegacyExecution` is reachable *only* from
  `heartbeat.ts:5254`, never from the one-shot seam.)
- **E2 — the mint would refuse the run even if routing existed** — §3.1's pin, which *is* the clause-3
  safety argument: a would-be transferred `one_shot` gets no credential, so even a bug that composed
  routing cannot silently strand a credentialed distributed extraction.

This is unit/contract evidence that nothing moved, not a live rehearsal — because there is nothing to
rehearse. The successor that flips extraction owes the arm→roll-back→confirm-one-executor rehearsal
then (§9), against the two-step lever clause 3 names.

## 5. Files

| Action | Path | Why |
|---|---|---|
| create | `server/src/__tests__/oneshot-mint-refusal.test.ts` | §3.1 — the credential-gap pin: `decideExecutionSecretHandle` + `mintExecutionSecretHandleForPlacement` refuse an agentless `one_shot`; positive control mints a `task_run` |
| create | `server/src/__tests__/oneshot-cutover-blocked.test.ts` | §3.2 E1 + §4 — the one-shot seam composes no ownership resolver / suppression (source-scan contract); extraction consumes stdout synchronously |
| modify | `scripts/gate-clause-wiring.json` | repoint the `E3-15/17/18` + `jobAudit` **reasons** to name the extraction-cutover successor (no status change — all stay `unwired`); leave `E10-1-drain` untouched (separate ticket) |
| modify | `docs/replatform/epics/E10-desktop-migration-realtime/findings.md` + `scripts/finding-ownership.json` | the two prerequisites (§9) + the `jobAuditBridge` no-clause gap, each declared in the same commit (an undeclared open finding fails `policy`); **update E10-F001** with §0.9's corrections (or file a superseding finding) |
| create | `docs/replatform/epics/E10-desktop-migration-realtime/tickets/MIG-007-cutover-result.md` | the result doc |

**No production code changes.** No routing seam, no mint change, no drain (§2, §0.7). No migration.
No `packages/worker-protocol` change (FROZEN, source SHA
`b7a842870ce7509d8baa75409e0ab19da375c88a`). No new `AOA_*` switch. No graph node (`#### MIG-007`
already exists, program-design.md:1072) and no manifest wiring edit (a later step wires those, per
the sprint brief).

## 6. Fail-first TDD steps — one action each, RED before GREEN

Every step: write the failing test → **run it, watch it fail for the stated reason** → minimal
implementation (here, the test *is* the deliverable, so "implementation" is the assertion body) →
run it, watch it pass → commit. *A RED that does not fail for the reason written down proved
nothing; stop and find out why.* These suites are pure/contract (no embedded-PG), so the
`AOA_RUN_WIN_INTEGRATION` prefix is **not** required — but confirm that at Step 0.

**Step 0 — re-verify §0 at tip.** Re-read every cited line. Re-confirm: (a) `one_shot`'s executor
principal is still `{kind:"worker", id: operationId}` (`job-submission.ts:212`); (b) the mint runner
still sources `adapterType` from `loadAgentAdapterBinding(executorPrincipalId)`
(`…mint-runner.ts:108-116`); (c) `extractViaCli` still consumes `result.stdout` synchronously
(`extraction-cli.ts:362-375`); (d) `jobOutputBridge` is still zero-caller. **If any blocker has
since been closed** (a synchronous distributed-result path landed, or the mint now credentials an
agentless `one_shot`), **STOP** — the premise moved and this is a different ticket.

**Step 1 — the mint positive control FIRST.** `decideExecutionSecretHandle` on a `task_run`-shaped
input mints a `provider_key`. RED: assert-first before the expectation is written correctly; GREEN:
lock the expected decision. This is the positive control — if the mint cannot fire even for a
`task_run`, every "refuses `one_shot`" assertion below is vacuous.

**Step 2 — the `one_shot` refusal (pure).** The same input with `adapterType:""` and
`credentialKind:"company_api_key"` refuses `adapter_not_v1_scope`. Anti-vacuity: it must refuse for
the *adapter* reason, not the owner-authority reason — assert the exact refusal string.

**Step 3 — the runner refusal (with the agentless lookup).**
`mintExecutionSecretHandleForPlacement` with `executorPrincipalId` = an operationId and a
`loadAgentAdapterBinding` stub returning `null` refuses and inserts **no** handle (assert the insert
stub was never called).

**Step 4 — the seam-composition contract (E1).** A source-scan of `one-shot-sandbox-cli.ts` asserts
its distributed imports are exactly `{recordDistributedShadow}` — no ownership resolver, no
suppression predicate. RED first by asserting a symbol that *is* present, watch it pass, then invert
to the real (absent-symbol) assertion so the RED is meaningful.

**Step 5 — the synchronous-consumer contract (§3.2).** Assert `extractViaCli` reads `result.stdout`
from the resolved `OneShotCliResult` (structural/source-scan), so a fire-and-forget refactor must
update it.

**Step 6 — registers + findings.** Repoint the four bridge reasons; file
`DEFERRAL-1-oneshot-credential`, `MIG-007-async-result`, and the `jobAuditBridge` no-clause finding,
each declared in `finding-ownership.json` in the same commit; apply §0.9's corrections to E10-F001.
Result doc.

```bash
pnpm --filter @armyofagents/server test:run -- src/__tests__/oneshot-mint-refusal.test.ts
pnpm --filter @armyofagents/server test:run -- src/__tests__/oneshot-cutover-blocked.test.ts
pnpm --filter @armyofagents/server typecheck
node scripts/check-guard-inventory.mjs && node scripts/check-gate-clause-wiring.mjs && node scripts/check-finding-ownership.mjs
```

## 7. Mutation table — DELETE each guard, positive control FIRST

Rules (all from real incidents): **positive control first**; **DELETE a guard, never rewrite it to
an equivalent** (`return false && x` measures nothing); **a surviving mutant is a question, not a
verdict**.

| # | Mutant (a DELETION) | Must redden | Why it is not equivalent |
|---|---|---|---|
| M0 | positive control — make `decideExecutionSecretHandle` always refuse | Step 1 | if the mint cannot fire even for a `task_run`, every "refuses `one_shot`" test is vacuous |
| M1 | delete guard 3 (`adapter_not_v1_scope`, `execution-secret-handle-mint.ts:167`) | Step 2 | the `one_shot`/`adapterType:""` input would MINT — proving guard 3 is the *only* thing refusing an agentless `one_shot`, i.e. the credential gap is exactly here |
| M2 | in the runner, make `loadAgentAdapterBinding` return a real `claude_local` binding for the operationId | Step 3 | proves the refusal is driven by the **agentless** lookup (no agent row), not by some unrelated default — with a binding present the mint would fire, which is the successor's fix shape |
| M3 | delete the `executor_not_agent` gate (guard 2, :162) | (no new redness) — **documented equivalent** | `one_shot` already passes guard 2 (`worker`); deleting it changes nothing for `one_shot`. Recorded so a reviewer does not read the survival as a hole — the refusal is guard 3, proven by M1 |
| M4 | in the seam contract (E1), remove the "no ownership resolver imported" assertion | Step 4 | proves the contract actually reads the seam's import set, not a constant |
| M5 | in Step 5, drop the `result.stdout` consumption assertion | Step 5 | proves the synchronous-consumer pin is load-bearing |

Any survivor is investigated (delete both the guard and its backstop; if the suite then fails, the
mutant was equivalent). M3 is a **documented equivalent** by construction — `one_shot` is admitted
by guard 2, so guard 2 is not the gate that blocks it; M1 proves guard 3 is. A documented equivalent
that does not compile is not counted.

## 8. Acceptance mapping — every clause → a test that can turn RED; count the callers

The MIG-007 node's acceptance (program-design.md:1076) is written for a *shipped* cutover. Because
MIG-007 does not flip, each clause maps to a test proving the **blocked** state honestly, not a
shipped behaviour it cannot deliver.

| MIG-007 node clause | MIG-007's honest disposition | Test that can redden |
|---|---|---|
| *"preserves its … credential audience … contract"* | **blocked** — the mint refuses an agentless `one_shot`, so no distributed run gets the Company key | `oneshot-mint-refusal.test.ts` (Steps 2-3) + M1/M2 |
| *"preserves its … result … contract"* | **blocked** — extraction is synchronous; no distributed result-return path exists | `oneshot-cutover-blocked.test.ts` (Step 5) + M5; `jobOutputBridge` stays `unwired` (register) |
| *"shadow mode invokes no model/provider effect"* | **already true** (shadow only) — inherited from the shadow ticket, unchanged | shadow ticket's S6/S7 (`distributed-shadow-port.test.ts`, `tenant-read-only.integration.test.ts`) |
| *"active operations drain/cancel"* | **N/A — nothing transfers** (clause 3 trivially satisfied, §4) | `oneshot-cutover-blocked.test.ts` E1 (Step 4) + M4 — no suppression is composed at the seam |
| *"`cloud_auth` has no host fallback"* | **already true** — extraction fails closed to `sandbox_unavailable` off cloud (`one-shot-sandbox-cli.ts:228-233`); Rule #11 | existing `one-shot-sandbox-cli` tests (unchanged) |
| *"self-hosted modes retain their documented path"* | **unchanged** — extraction uses the local CLI login on self-hosted; MIG-007 touches no path | no code change (§5) |
| No parity bridge is claimed `wired` | **held** — all five stay zero-caller | `check-gate-clause-wiring.mjs` green with `E3-5/15/17/18` + `jobAudit` all `unwired` |

**No clause here is satisfied by a function nothing calls.** The credential-blocked and
result-blocked clauses are pinned by the mint refusal (which has a real caller — the runner) and the
synchronous-consumer contract; the "nothing transfers" clauses are pinned by the seam-composition
contract; the "no bridge promoted" clause is satisfied by the register checker, which reads caller
count. **The one thing this ticket deliberately does NOT do is claim any node clause as *shipped* —
each is mapped to its honest blocked/N/A/already-true state**, per the WRK-010 §4.2 discipline for
declared-but-unreachable outcomes.

## 9. Non-goals, named with owners

| Not delivered | Owner | Why |
|---|---|---|
| **The extraction `canary` flip** (execution transfers to a distributed worker and returns its result) | **a successor extraction-cutover epic slice** (net-new; gated on the two prerequisites below) | §0.2 + §0.3: no credential and no result-return path. Not a single ticket — it spans a mint change, a routing seam, a worker-side `one_shot` execution + result capture, and a synchronous-result mechanism |
| **`DEFERRAL-1-oneshot-credential`** — the mint credentials an agentless `one_shot` with the Company key | filed here as a finding; owner = the extraction-cutover successor | §0.2c: teach the mint runner to supply a v1 adapter (`claude_local`/`codex_local`) + an `absent` binding for an agentless `one_shot`, so it emits a Company `provider_key`. Bounded (Company key, the class the mint already produces) — smaller than Commander's per-user need, but net-new |
| **`MIG-007-async-result`** — a synchronous run-a-command-on-a-worker-and-return-stdout path (or an async extraction re-architecture) | filed here as a finding; owner = the extraction-cutover successor | §0.3b: the primary blocker. `jobOutputBridge` is zero-caller and projects artifacts, not a stdout string; extraction blocks on the value |
| **The rollback drain fix** (`createDistributedExecutionDrain` grain + `listActiveAttempts` SQL + a caller) | **a separate sink-agnostic drain ticket** (E10-F001; go-book §4 Sprint 6; MIG-005 review) | §0.7 — the drain ships on its own regardless of sink order; MIG-007 has no credential-independent fix to attach to it |
| **A `jobAuditBridge` gate clause** | filed as a finding here; owner = whoever wires the audit bridge | §0.6 — `unwired` and tracked by no clause; the finding makes the green-by-absence visible |
| **Promoting `jobOutputBridge` / `jobBudgetCostBridge` / `jobAuditBridge`** | the extraction-cutover successor | §3.3 — nothing calls them on the direct extraction path; promoting here is false wiring |
| **`createExecutionTargetRevocationFanout` consumer** (E3-18) | dispatch-teardown ticket | Orthogonal to extraction credentialing |
| **A live rollback rehearsal for `one_shot`** | the extraction-cutover successor | §4 — clause 3 stays trivially satisfied; there is nothing to rehearse until extraction actually transfers |
| **MIG-006 (crew) / MIG-005 (Commander)** | their own tickets | *One sink at a time.* Crew rides the Company-key ladder more closely (`runner.ts:554-577`, per E10-F001) — a distinct analysis; Commander is credential-blocked (MIG-005) |

## 10. Risks and rollback

**R1 — the falsifiable pins are mistaken for a partial cutover.** They are anti-regression guards
that *nothing transfers*, not a half-built transfer. Mitigation: §2 rejects the seam explicitly; the
result doc must headline "extraction did NOT go canary; both blockers are pinned, not fixed."

**R2 — a reviewer reads M3's survival as a hole.** M3 (deleting guard 2) does not redden because
`one_shot` passes guard 2 already. It is a **documented equivalent**, and M1 proves the real gate is
guard 3. The mutation table says so; the result doc repeats it.

**R3 — E10-F001's correction is contentious.** §0.9 corrects a HIGH finding the go-book leans on. The
correction *narrows* the claim (extraction is closer than Commander but not buildable-today) rather
than reversing the sprint order — extraction remains the right *first* sink to analyze, because it is
the closest. Apply the correction to E10-F001 in the same commit as the finding declarations (an open
finding whose text is now known-wrong is itself a defect), or file a superseding finding if the
reviewer prefers append-only.

**R4 — a successor closes one blocker and thinks the cutover is done.** The two prerequisites are
**coupled** (§2: credential without result-return is worse than neither). The findings state the
coupling; the pins in §3.1 and §3.2 are separate tests so closing one leaves the other RED, which is
the intended forcing function.

**Rollback of MIG-007 itself.** MIG-007 ships only tests + register-reason edits + findings. Reverting
the test files and the reason edits restores the tree byte-identically; no production behaviour
changed (§5), so there is nothing to roll back at runtime. No migration to reverse.

## 11. What this design deliberately does not do

1. It does **not** route any extraction run to a distributed path — §0.2, §0.3, §2.
2. It does **not** resolve Deferral #1 for `one_shot` — it names the prerequisite
   (`DEFERRAL-1-oneshot-credential`, §9) and pins the mint refusal (§3.1).
3. It does **not** build a synchronous result-return path — it names the prerequisite
   (`MIG-007-async-result`, §9) and pins the synchronous-consumer contract (§3.2).
4. It does **not** build or claim an inert routing seam — rejected as stale-bait with the wrong
   execution model (§2).
5. It does **not** fix or wire the drain — a separate sink-agnostic ticket (§0.7, §9).
6. It does **not** promote any parity bridge — nothing calls them on the direct extraction path
   (§3.3).
7. It does **not** claim GATE clause 3 is *re-satisfied* for `one_shot` — it stays *trivially*
   satisfied because extraction did not move (§0.5, §4).
8. It does **not** touch `packages/worker-protocol` (FROZEN) or add a graph node / manifest entry (a
   later wiring step does — per the sprint brief).

**Open decisions for Step 0** (the house re-verify rule): a final confirmation that neither blocker
(the agentless-`one_shot` mint refusal; the absent synchronous result-return) has been closed since
tip — either would retire the block and change the ticket; and whether E10-F001 is corrected in place
or by a superseding finding (R3).
