# E10 keystone scoping — the routing seam + the mint generalization, and which sink cuts over first

**Read-only scoping pass, 2026-08-28.** Worktree `C:\e3`, branch `docs/replatform-program`
(tip `5996eb6dc`). No source edited, no skill run, nothing committed. Every claim is cited to
GROUND TRUTH by `path:line` (read at this tip — line numbers rot; re-verify at execution time) or
to a living doc by §/id.

**Task:** make E10-F001's "keystone" concrete — the SHARED prerequisites that block every Sprint-6
sink cutover: (1) a **routing seam** that generalizes distributed transfer beyond `task_run`, (2) a
**mint generalization** that credentials an agentless run, (3) extraction's result-return path — then
decompose into session-buildable units and rank the first sink.

---

## TL;DR — the four load-bearing findings

1. **The routing seam is already source-agnostic in its TYPES and its core services.** `SubmitJobSource`
   is a six-arm union (`task_run | commander_turn | crew_run | one_shot | browser_request |
   service_reconcile`), and `run-execution-owner.ts`, `job-convert-orchestrator.ts`,
   `job-admission-bridge.ts`'s `admitAndSubmit`, and the `heartbeat-distributed-rollout.ts` hook all
   accept any `SubmitJobSource`. The "`task_run`-shaped" claim is about **WIRING, not architecture**:
   only `heartbeat.ts` calls the hook (5 sites), and the hook hardcodes two `task_run`/`"batch"`
   constants. Generalizing = **a new call site + a suppression point in a sink's runner**, not a
   rearchitecture.

2. **★ CREW RIDES THE EXISTING MINT — no generalization needed.** E10-F001's headline ("MIG-005 /
   MIG-006 / MIG-007 all refuse at guard 3") is **REFUTED for crew** by source. A `crew_run`'s execution
   principal is stamped `{kind:"worker", id: agentId}` (`job-control.ts:1529`), so the mint-runner loads
   the **crew agent's** adapter (`claude_local`/`codex_local`), guard 3 **admits** (v1 bucket), and the
   mint emits a Company `provider_key` handle. Only the **agentless** sinks (extraction `one_shot` →
   `operationId`; Commander `commander_turn` → a run id) refuse at guard 3. (E10-F001's per-sink bullet
   already hedges "crew MAY pass guard 3"; the hedge is the correct reading — the headline overstates.)

3. **★ CREW is the cleanest first sink — cleaner than the finding's pick (extraction).** Crew is
   agent-backed (rides the mint), its dispatch is **async background** (no sync→async result-return
   data-loss blocker that sinks extraction), and its shadow `source_not_admitted` was a **fixture
   artifact** (no crew runs seeded), not a real admission gap. Crew is structurally the **closest sink to
   `task_run`** — the sink whose transfer is already built. This reorders the sprint away from both
   MIG-007's "lead with extraction" and MIG-005's "Commander first."

4. **★ STOP FLAG — the actual sink flip is NOT session-buildable.** "A non-`task_run` sink executes
   distributed and its result comes back" needs (a) the **result-projection parity bridges**
   (`jobOutputBridge`/`jobBudgetCostBridge`/`jobAuditBridge` — **all zero-caller/`unwired`**, which
   `task_run` itself has never wired) and (b) the **live fleet** (E7-1 `unwired` — "staging-canary
   journey owed; fleet not deployed"). Only the **inert routing seam + the mint capability + the crew
   mint-ride pin** are session-buildable. The live leg is E7-1/REL-003 class.

---

## (a) The routing seam — mechanics + buildability verdict

### What is actually `task_run`-shaped

The transfer pipeline is four services, each **already generic** over `SubmitJobSource`:

| Layer | File | Source-agnostic? |
|---|---|---|
| Ownership decision | `run-execution-owner.ts:181-197` (`resolve({source, actor, organizationId, workloadType, …})`) | **Yes** — passes `source` straight to convert; no `switch` on kind |
| Convert | `job-convert-orchestrator.ts:37-42, 51-58` (`convertRunToJob({source,…})` → `bridge.admitAndSubmit(source,…)`) | **Yes** |
| Admission bridge | `job-admission-bridge.ts:262-346` (`admitAndSubmit`) | **Yes** — a `task_run`-only checkout block (`:284-324`), then `submitJobWithinTenant` for **every** source (`:331`) |
| Rollout hook | `heartbeat-distributed-rollout.ts:44-170` (`resolveRunRolloutState`/`resolveExecutionOwner` take `sourceKind`/`source`) | **Yes** — but see the two constants below |

The `task_run` shaping is **exactly two things**:

1. **The only caller is `heartbeat.ts`.** Grep for the transfer symbols returns `heartbeat.ts`,
   `heartbeat-distributed-rollout.ts`, `index.ts` — no sink module. The five wired sites:
   - `heartbeat.ts:3176-3181` — `resolveRunRolloutState({ …, sourceKind:"task_run" })`
   - `heartbeat.ts:3260-3261` — `convertActiveRun({ source:{kind:"task_run",…} })`
   - `heartbeat.ts:5234-5235` — `resolveExecutionOwner({ source:{kind:"task_run",…} })`
   - `heartbeat.ts:5254` — `shouldSuppressLegacyExecution(canaryExecutionOwner)` **(the suppression point)**
   - `heartbeat.ts:6783` — `buildHandoffRunPatch(owner,…)` **(the durable handoff marker)**
   The three sink runners (`internal-agent/aoa-agents/runner.ts:843`, `internal-agent/cli-mode.ts`,
   `one-shot-sandbox-cli.ts:284`) import **only** `recordDistributedShadow` — no resolver, no suppression.

2. **Two hardcoded constants in the hook:** `HEARTBEAT_TASK_RUN_WORKLOAD_TYPE = "batch"`
   (`heartbeat-distributed-rollout.ts:29`), used in both `resolveRunRolloutState` (`:116`) and
   `resolveExecutionOwner` (`:146`). Harmless in practice — `submitJobSourceWorkloadType`
   (`packages/shared/src/job-control-source.ts:51-55`) maps **all four batch sinks** (task_run,
   commander_turn, crew_run, one_shot) to `"batch"` anyway — but they encode the task_run assumption.

So generalizing the seam to a non-`task_run` source needs, concretely:
- **A new call site in the sink's runner** that constructs the sink's `SubmitJobSource` + a `BridgeActor`
  and calls `resolveRunRolloutState({sourceKind})` then `resolveExecutionOwner({source,…})`.
- **A suppression point** in the runner: skip the in-process legacy execution when
  `shouldSuppressLegacyExecution(owner)` is true.
- **A per-source `admitAndSubmit` path** — already present (`submitJobWithinTenant` admits every source
  via `SOURCE_REQUESTER_KINDS` + the per-kind `*IsAdmitted` checks, `job-submission.ts:159-231`). Crew's
  is `internalRunSourceIsAdmitted` (`:200-207`); it returns a real principal — **no new admission code**.
- **A result-projection path** — the hard part; see the STOP flag.

**No new "source-kind branch" in the resolver, no new principal-resolution, no new placement path** are
required: those are generic. The work is the *edges* (a runner call site + a suppression + result
projection), not the *core*.

### Buildability verdict — routing seam

**The routing DECISION for a non-`task_run` source is session-buildable and embedded-PG-provable.**
`resolveExecutionOwner({source:{kind:"crew_run",…}})` → convert → placement → mint fires today against a
fake worker + embedded-PG, exactly as CLI-005/CLI-006 proved for `task_run` (the D1 two-replica lane, the
`composed-journey` component test). Unit- and mutation-testable.

**The suppression + live execution + result projection are NOT fully session-buildable.** Suppressing the
in-process crew spawn with no distributed result-projection **strands the run** (no loopback comment, task
never completes) — the WRK-011 hazard the prior designs name. The projection depends on
`jobOutputBridge` (zero-caller) and the live fleet (E7-1). So the seam ships **inert-until-fleet**, proven
at embedded-PG, with the live rehearsal owed to E7-1 — the program's standard "build + embedded-PG prove;
live leg owed" pattern (Sprint-5b, REL-003).

---

## (b) The mint generalization — mechanics + buildability verdict

### Guard 3, precisely

`decideExecutionSecretHandle` (`execution-secret-handle-mint.ts:152-206`) is a **pure** six-guard chain:

1. `not_cloud_deployment` (`:157`)
2. `executor_not_agent` (`:162`) — `isAgentBackedExecutorKind` admits `agent`/`worker`/`sandbox`
3. **`adapter_not_v1_scope` (`:167`)** — `gateCodingAdapterDispatch(adapterType,…).admitted`; the v1
   bucket is `claude_local` (anthropic) + `codex_local` (openai) only (`sandbox-coding-disposition.ts:49-51`)
4. `owner_authority_disagreement` (`:174`) / `owner_desktop_target` (`:177`)
5. `adapter_has_no_company_key` (`:182`)
6. the three-way per-agent split (`:185-205`): `plain` → refuse; `secret_ref` → `company_secret` handle;
   **absent → Company `provider_key` handle**

Guard 3 is fed by the **impure runner** (`execution-secret-handle-mint-runner.ts:108-125`): it loads the
adapter from `loadAgentAdapterBinding({companyId, agentId: executorPrincipalId})`. For an **agentless**
run `executorPrincipalId` matches no agent row → `agent = null` → `adapterType = ""` →
`gateCodingAdapterDispatch("").admitted === false` → **guard 3 refuses**. The mint invocation is at
`job-placement-transaction.ts:368` (inside placement, reading the stamped job row).

### Which sinks are agent-backed vs agentless — per source, from the principal stamp

| Sink | Execution principal (from `job-submission.ts`) | `executorPrincipalId` | Mint verdict |
|---|---|---|---|
| `task_run` | `taskSourceIsAdmitted` → agent | agent id | **rides mint** (baseline) |
| **`crew_run`** | `internalRunSourceIsAdmitted` → `{kind:"worker", id: row.agentId ?? row.id}` (`job-control.ts:1529`) | **agent id** (bound agent) | **★ RIDES MINT** — loads crew agent's `claude_local`, guard 3 admits |
| `one_shot` (extraction) | constant `{kind:"worker", id: operationId}` (`job-submission.ts:212`) | **operationId** (no agent row) | **refuses** guard 3 (agentless) |
| `commander_turn` | `commanderSourceIsAdmitted` → `{kind:"sandbox", id: runId}` (`job-control.ts:1551`) | **run id** (no agent row) | **refuses** guard 3 (agentless) |

**Crew's mint-ride is contingent on** a **bound agent** (`agentId` non-null; a user-owned crew source with
no assigned agent falls back to `row.id` and refuses) and the agent using a v1 coding adapter (crew's
standard adapters — `runner.ts:589-594`). Discussion/braindump crew dispatches assign a `kind='aoa'`
agent, so the common case rides. **NEVER serialize the resolved key** — the mint emits a *handle*
(`refKind:"provider_key"`, `refId: target.secretName`), redeemed only inside the sandbox (DAT-008 slice 5;
CLI-007; Decision #104).

### What "generalize the mint to mint a Company key for an agentless run" means concretely

Only needed for **extraction / Commander** (crew doesn't need it). For an agentless `one_shot`, the pure
decision **already** mints a Company `provider_key` in its absent-binding arm (`:198-205`) — the *only*
thing blocking it is guard 3, which fails because the **runner** hands it `adapterType:""`. The
generalization is a **bounded mint-runner change**: give an agentless workload that legitimately uses a
Company key a way to present its v1-scope adapter (extraction already runs `claude_local`/`codex_local`,
`one-shot-sandbox-cli.ts:210`) + an absent binding, without an agent row — e.g. source the adapter from the
operation's resolved provider instead of `loadAgentAdapterBinding`. It is **net-new but small** (Company
key = the class the mint already produces), and it does **not** touch the pure decision's structure.

### Buildability verdict — mint generalization

**Fully session-buildable and mutation-testable.** `decideExecutionSecretHandle` is pure (no db/clock/rng)
and `mintExecutionSecretHandleForPlacement` takes a two-method repo stub — the existing
`execution-secret-handle-mint{,-runner}.test.ts` prove the pattern with no database. This is the **most
unambiguously buildable unit** in the keystone. **Caveat (MIG-007 §2, verified):** shipping it wired into
a suppression is *worse than not shipping* — a credential delivered to an execution that cannot return its
result (extraction) or does not exist (Commander) strands or drops work. Ship it as a **capability + a
falsifiable pin**, not as a half-cutover.

---

## (c) Ranked first-sink recommendation

| Rank | Sink | Credential | Result-return | Routing | Net |
|---|---|---|---|---|---|
| **1 — CLEANEST** | **crew (`crew_run`, MIG-006)** | **rides existing mint** (agent-id principal + `claude_local`) — no work | **async background** dispatch (`dispatcher.ts:1060` polls a wakeup queue) — **no sync blocker**; loopback via side-effects | new seam only (shared) | **Only novel prereq = the shared routing seam + shared result-projection.** Closest sink to `task_run`. |
| 2 | extraction (`one_shot`, MIG-007) | needs mint generalization (bounded, Company key) | **SYNC request/response** — `extractViaCli` awaits + parses `result.stdout` (`extraction-cli.ts:362-375`); suppressing the direct call = **zero extracted items (data loss)** | new seam | **Not recommended even once unblocked** (thin value — already E2B-sandboxed with Company key; latency regression on a founder-waiting path). Verified in MIG-007. |
| 3 — LARGEST | Commander (`commander_turn`, MIG-005) | **net-new per-user `provider_connection` credential class** the mint cannot produce at all (Decision #117 territory); `aoa_app` can't even `claimTurn` in-tx (`job-admission-bridge.ts:24-27`) | interactive/sync | new seam | Blocked on a whole new credential class. Verified in MIG-005. |

**Recommendation: crew is the genuinely cleanest first cutover target**, and the source refutes the two
prior orderings. Crew rides the mint (no credential work), is async (no result-return data-loss), and its
"shadow admission gap" is a fixture artifact (`MIG-005-006-007-shadow-result.md` §4: *"no Commander or crew
runs exist in the fixture, so the real per-source authority denies them"* — `internalRunSourceIsAdmitted`
returns a real principal for a real crew run). Crew's ONLY novel prerequisite is the shared routing seam;
everything else it needs (mint, async execution model, admission authority) is already there.

The one honest asymmetry vs. Commander/extraction: because crew **does** get a credential, an inert crew
seam **cannot** rely on "the credential authority is structurally absent in prod" (MIG-005's inert trick).
Crew's seam is inert only by the **rollout flag / no live fleet** — so flipping it live before
result-projection is wired would strand crew runs. Gate crew's suppression behind result-projection, not a
missing credential.

---

## (d) Dependency-ordered decomposition into session-buildable units

### Unit 1 — RECOMMENDED FIRST · MIG-006 crew terrain + mint-ride pin + E10-F001 correction · fully session-buildable

**Shape.** The crew analog of MIG-007's landable deliverable, but with a **positive** result that reorders
the sprint. A pure/embedded-PG characterization that pins, as falsifiable tests:
- `decideExecutionSecretHandle` + `mintExecutionSecretHandleForPlacement` on a **crew-shaped** input
  (`executorPrincipalKind:"worker"`, `executorPrincipalId`=an agent id, `loadAgentAdapterBinding` returns a
  `claude_local` binding, absent provider binding) **MINTS a Company `provider_key`** — positive control
  first (a `task_run` mints), then the crew case. This is the falsifiable statement "crew rides the mint."
- The agentless negative twin (operationId → `adapterType:""` → `adapter_not_v1_scope`) so the mint-ride is
  attributed to the **agent-id principal**, not luck.
- A contract test that the crew source's admission authority (`internalRunSourceIsAdmitted`) returns a real
  principal for a seeded crew run (refuting the shadow-fixture artifact).
- **Correct E10-F001** in place (headline "all three refuse at guard 3" → "crew rides the mint; only the
  two agentless sinks refuse"), declared in `finding-ownership.json` in the same commit.

**Buildable?** **Yes, entirely** — pure functions + embedded-PG fixtures (`setupJobControlFixture`), no
live infra, no spend. Mutation-testable by deletion (delete guard 3 → crew still mints, proving the ride is
not guard-3-gated; delete the agent-id lookup → crew refuses, proving the ride is the principal). **Risk:
LOW** — it is analysis + pins + a finding correction, the same non-stale shape MIG-007 shipped. It commits
nothing to an execution path.

**Why first.** It establishes crew as the cutover target **on evidence**, corrects the record the whole
sprint leans on, and de-risks Unit 2's design (the seam is designed knowing its downstream mint is
satisfied). Small, safe, high-leverage.

### Unit 2 — the source-agnostic routing seam, crew as first consumer · session-buildable INERT, live leg owed

**Shape.** A seam module mirroring `heartbeat-distributed-rollout.ts`, wired into the crew runner at the
existing shadow-record attach point (`runner.ts:833-861`, between target-resolve and `adapter.execute`):
construct `{kind:"crew_run", crewRunId}` + a `BridgeActor`; call `resolveRunRolloutState({sourceKind:"crew_run"})`
then `resolveExecutionOwner({source,…})`; **suppress the in-process `runAoaAgent` sandbox spawn** when
`shouldSuppressLegacyExecution(owner)`; emit the handoff marker. Drop the two hardcoded hook constants in
favor of `submitJobSourceWorkloadType(source)`.

**Buildable?** **The routing decision + convert + placement + mint-fire for crew: yes, at embedded-PG**
against a fake worker (the CLI-006 harness pattern). **The suppression + live execution + result projection:
NO** — suppressing without projection strands the crew run; projection needs `jobOutputBridge` (unwired) and
the live fleet (E7-1). Ships **inert** (rollout-gated / fake-worker-proven), live rehearsal owed to E7-1.
**Risk: MEDIUM-HIGH** — the suppression is the sharp edge (must be gated behind result-projection, or it
strands work); the result-projection (loopback comments re-emitted from distributed terminal events) is
shared, unbuilt substrate. This unit is where the "keystone" mostly lives, and where most of it hits the
STOP flag.

### Unit 3 — the mint-runner generalization (agentless one_shot → Company key) · fully session-buildable, do NOT force-fit

**Shape.** Teach the mint-runner to credential an agentless `one_shot` with the Company key (source the v1
adapter from the operation's provider, not an agent binding). Pure decision largely reused; runner
input-gathering changes. Ship as a **capability + pin**, unwired to any suppression.

**Buildable?** **Yes** (pure + fake repo). **Risk: LOW to build, but MEDIUM to sequence** — per MIG-007 it
is half-work for extraction until `MIG-007-async-result` exists, and it is **not on crew's path at all**. So
it is genuinely buildable but **lower priority** than Units 1-2; it serves extraction/Commander later.

### Unit 4+ — the actual live sink flips · BLOCKED, not session-buildable

Crew live, then (if ever) extraction/Commander. Gated on: the result-projection parity bridges wired
(shared with `task_run`), the live fleet (**E7-1**), plus — for extraction — the sync-result mechanism
(`MIG-007-async-result`), and — for Commander — the per-user credential class (`DEFERRAL-1-commander-credential`).
**E7-1/REL-003 class; not a coding-session deliverable.**

---

## (e) Coordination + STOP flags

**STOP — the keystone's payoff is not session-buildable.** "A non-`task_run` sink executes distributed and
its result comes back" needs the result-projection bridges (`jobOutputBridge`/`jobBudgetCostBridge`/`jobAuditBridge`,
**all zero-caller** — `task_run` itself has not wired them) **and** the live fleet (E7-1 `unwired`). What IS
session-buildable: Unit 1 (crew mint-ride pin + finding correction — fully), Unit 2's routing decision
(embedded-PG, inert), and Unit 3 (the mint capability). The live sink flip is E7-1/REL-003 class. Say this
plainly to whoever picks up Sprint 6: **you can land the seam and the pins; you cannot land a working
cutover this session.**

**Ownership — no conflict.** E10-F001 is deliberately `status:"unowned"` (`finding-ownership.json:45-48`) —
no active owner to coordinate with. The go-book already names this keystone (§ line 75: *"E10 routing-seam +
mint-generalization — the honest Sprint-6 keystone that UNBLOCKS the sinks"*; § Sprint 6, lines 784-785).

**Coordination — Lane B (`C:\e8`, branch `lane-b`, tip `30861d0be`) shares the routing seam.** Lane B is
cutting over the **net-new** sinks `browser_request` / `service_reconcile` (E8/E9) — **different** workload
types (`browser_session` / `service`, not `batch`), so **no sink overlap**. **But** those sinks face the
**same task_run-only routing prerequisite**: `BRW-001-design.md:363-365` already studies
`resolveExecutionOwner`/`run-execution-owner.ts`. So the routing-seam generalization (Unit 2) is **shared
infrastructure across E8/E9/E10 cutovers.** Recommendation: whoever builds it first must build it
**source-agnostic** (the interfaces already are) so both lanes consume one seam, not two. Flag this to Lane B
before Unit 2 starts, to avoid a duplicate `resolveExecutionOwner` call-site pattern.

**Nothing here is already-built or already-blocked-on-something-else** beyond what's stated: the drain
(MIG-009) shipped and is sink-agnostic (does **not** unblock any sink — E10-F001 confirmed); the shadow
observers (MIG-005/006/007-shadow) shipped; the per-sink dial (MIG-002) shipped (so "arm crew alone" is
expressible — `distributed-execution-rollout-source.ts` `sources` axis). The credential machinery (DAT-008
mint, CLI-007 canary authority) is built and crew rides it. The only genuinely missing, buildable pieces are
Units 1-3; the rest is E7-1.

---

## Appendix — files read (ground truth)

- `server/src/services/run-execution-owner.ts` (the ownership decision — generic over `SubmitJobSource`)
- `server/src/services/execution-secret-handle-mint.ts` (the pure six-guard mint decision; guard 3 `:167`)
- `server/src/services/execution-secret-handle-mint-runner.ts` (the impure mint-runner; agent-binding lookup `:108-125`)
- `server/src/services/heartbeat-distributed-rollout.ts` (the seam hook — the two `task_run`/`"batch"` constants)
- `server/src/services/job-convert-orchestrator.ts`, `job-admission-bridge.ts`, `job-shadow-admissibility.ts`
- `server/src/services/job-submission.ts:155-297` (per-source principal stamping)
- `packages/db/src/repositories/tenant/job-control.ts:1508-1566` (`internalRunSourceIsAdmitted`, `commanderSourceIsAdmitted`)
- `packages/shared/src/types/job-control.ts`, `packages/shared/src/job-control-source.ts` (the source union + workload map)
- `server/src/services/internal-agent/aoa-agents/runner.ts` (crew runner — shadow-only at `:843`, adapters at `:589`)
- `server/src/services/internal-agent/aoa-agents/dispatcher.ts:1060` (crew async background dispatch)
- `server/src/services/sandbox-coding-disposition.ts:49-51` (guard-3 v1 bucket), `secrets.ts:254-262` (`companyKeyTargetForAdapter`)
- `server/src/services/heartbeat.ts` (the 5 task_run wiring sites), `job-placement-transaction.ts:368` (mint invocation)
- Living docs: `E10-.../findings.md` (E10-F001), `MIG-005-cutover-design.md`, `MIG-007-cutover-design.md`,
  `MIG-005-006-007-shadow-result.md`, `GO-BOOK.md` §4/§ Sprint 6, `scripts/finding-ownership.json`,
  `E8-.../BRW-001-design.md`
