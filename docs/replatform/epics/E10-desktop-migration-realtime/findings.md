# E10 — Desktop migration / realtime — findings

## E10-F001 — No Sprint 6 sink is buildable today; they are all blocked on shared, unbuilt prerequisites

**Status:** open · Severity: HIGH · Source: MIG-005 + MIG-007 cutover designs and their reviews,
2026-08-27 (verified against source). **★ This entry was revised after the MIG-007 design corrected an
overstatement in its first version** (which claimed extraction "rides the mint" and was "buildable
today" — both false; see below).

The go-book scoped Sprint 6 as "cut the sinks over, one at a time." Making the first two designs
(MIG-005 Commander, MIG-007 extraction) and reviewing them established that **none of the three sinks
can cut over today** — they share unbuilt prerequisites, and each adds a per-sink gap.

**Shared prerequisites, missing for all three sinks:**
1. **Distributed transfer routing exists only for `task_run`.** Convert/placement/ownership + legacy
   suppression live only in `heartbeat.ts` (`run-execution-owner.ts` is `task_run`-shaped). A cutover
   for any other source must build the routing seam for it.
2. **The mint refuses every non-agent-coding run at guard 3.** `isAgentBackedExecutorKind` admits
   `worker`/`sandbox` at guard 2, but the mint-runner loads an agent binding keyed on
   `executorPrincipalId`; a run with no v1-coding agent binding gets `adapterType = ""` and refuses at
   `adapter_not_v1_scope` (`execution-secret-handle-mint.ts` guard 3, ~:167; the runner binding at
   `execution-secret-handle-mint-runner.ts:104-116`). This is the SAME refusal gate for `commander_turn`,
   `one_shot`, `service`, `browser`, and `system` — the clean "extraction rides the mint, Commander
   doesn't" distinction the first draft of this finding drew is **false**; both refuse at guard 3.

**Per-sink gaps.** ★ Readiness order superseded 2026-08-28: **CREW is the cleanest first sink** (it
rides the mint for a v1-provider company — see the crew bullet), then extraction (mint-runner change but
a result-return blocker that drops every item — not recommended), then Commander (largest). The
"extraction smallest" framing below understated extraction's sync→async result-return blocker.
- **Extraction (`one_shot`, MIG-007):** credential fix is the SMALLEST in class — it needs the **Company**
  key, which the mint already knows how to produce; the gap is that extraction's principal is an agentless
  `operationId`, so the mint-runner needs to mint a Company key for an agentless one_shot run (a
  mint-runner change, not a new credential class). **BUT extraction adds a blocker the first draft
  missed: no synchronous result-return path.** Extraction is a blocking request/response that awaits and
  parses the sandbox stdout (`extraction-cli.ts` ~:362-375); the distributed substrate is async
  fire-and-forget and its only projection surface (`jobOutputBridge`, E3-17) is zero-caller and carries
  artifacts, not a stdout string. Suppressing the direct call with no result path yields **zero extracted
  items** — a data-loss bug, not honest dormancy. And Q2: extraction ALREADY runs in an isolated E2B
  sandbox with the Company key, so the cutover's value is thin-to-negative (fleet placement for a
  latency-sensitive, system-initiated path).
- **Crew (`crew_run`, MIG-006) — ★ CORRECTED 2026-08-28: crew RIDES the mint (it does NOT refuse at
  guard 3), and is the CLEANEST first sink.** Its principal is stamped `{kind:"worker", id: agentId}`
  (`job-shadow-admissibility.ts:136` → `internalRunSourceIsAdmitted`, `job-control.ts:1529`), so guard 2
  admits `worker` and — **iff the company's crew provider is a v1 coding adapter** — guard 3 admits and
  the mint issues a Company `provider_key` (`execution-secret-handle-mint{,-runner}.ts`). The v1 axis is
  a whole-company setting, not an edge: `resolve-crew-adapter.ts` maps `anthropic→claude_local` /
  `openai→codex_local` (RIDE) but `google→gemini_local` / `opencode→opencode_local` (REFUSE
  `adapter_not_v1_scope`). The shadow `source_not_admitted` was a **fixture artifact** — no crew runs
  were seeded (`MIG-005-006-007-shadow-result.md:107,110-112`) — NOT an admission-authority gap. So
  crew's ONLY blockers are the routing seam + the zero-caller projection bridges (`jobOutputBridge` et
  al., E3-17) ~~+ E7-1~~ — **none of them the mint.** ★ **2026-09-18: the `+ E7-1` blocker is REMOVED** —
  the E7-1 distributed E2B mechanism is proven end-to-end (Hetzner staging run `8dc34e90`, verifier
  `ok=true`; E7-F011 + E7-F036 merged), so crew's remaining blockers are the routing seam + the zero-caller
  projection bridges only. ★ **2026-09-18: those projection bridges are PRODUCER-blocked, not merely zero-caller** — the deployed worker emits no artifact/result/usage evidence for them to consume (`observeRun` uncomposed; see the E3-F037 amendment + E7-F018), so wiring them is necessary-not-sufficient. The routing seam gets crew work dispatched + executed on the distributed substrate (proven mechanism), but crew's result loopback stays gated on **CLI-008 Unit F** worker-evidence emission until that lands. Already pinned by shipped tests (no new test needed):
  `job-submission.integration.test.ts:77-99,307` (the `{worker, agentId}` stamp), `mint.test.ts:128-133`
  (worker→`provider_key`), `mint.test.ts:138` (non-v1→refuse).
- **Commander (`commander_turn`, MIG-005):** the LARGEST gap — a net-new per-user `provider_connection`
  credential class (Decision #117 territory), not the Company key; plus routing; plus it is
  interactive/sync.

**Disposition.**
- **"Cut over a sink" is premature. The real Sprint 6 work is the SHARED PREREQUISITES** — the
  distributed routing seam for non-`task_run` sources, and the mint-runner generalization to mint a
  Company key for an agentless/non-coding run — and, for extraction, a result-return path. Those are the
  tickets to scope before any sink flips.
- **The drain fix is the one genuinely unblocked, landable Sprint 6 item** (sink-agnostic; the MIG-005
  design's drain analysis is reviewer-verified and carries to its own ticket). Ship it independently.
  **★ SHIPPED 2026-08-27 (MIG-009):** the per-Company rollback grain + the real `listActiveAttempts`
  SQL landed and are proven at embedded-PG; the drain is correct when wired, and `E10-1-drain` stays
  `unwired` (its `drainAll` trigger is REL-005 scope). This does **not** change the finding: the drain
  is sink-agnostic and no sink cutover is unblocked by it — every point below still holds.
- **Extraction's cutover is NOT recommended even once unblocked** (thin value; already sandboxed with the
  Company key). Crew and Commander cutovers wait on their credential + routing work.

**Owner:** none yet. When Sprint 6 is next, scope the shared-prerequisite tickets (routing seam +
mint-runner generalization) and the drain first; the per-sink flips follow. Commander's per-user credential
shares E5's `DEFERRAL-1-credential` wiring. Filed `unowned` because no ticket in the graph fixes these and
force-fitting them onto one sink would be false ownership.

**Blocks:** every Sprint 6 sink cutover. Does NOT block the drain fix.

> ★ **AMENDED 2026-09-18 (post-E7-1) — TERRAIN RE-VERIFY OF SHARED PREREQUISITE #1: the routing seam
> is SMALLER than "`run-execution-owner.ts` is task_run-shaped" implies, and the crew slice is scoped
> here.** Re-measured at HEAD: the ownership decision is **already source-agnostic**.
> `createRunExecutionOwnerResolver` (`server/src/services/run-execution-owner.ts:278`) → `resolve`
> (`:284`) takes a generic `source: SubmitJobSource` and passes it straight through
> `convert.convertRunToJob({ source, … })`; there is **no `task_run` branch** in the file, and its own
> comment (`:162-171`) says the task_run-specific workload builder lives in the SEAM, *"not by `resolve`"*.
> `createJobConvertOrchestrator` (`job-convert-orchestrator.ts:45`) and `job-admission-bridge.ts` are
> likewise source-agnostic (the admission bridge already maps `crew_run`). So prerequisite #1's real
> task_run coupling is only **(i)** the heartbeat CALLER + **(ii)** the workload builder
> `buildTaskRunBatchWorkload` (`task-run-batch-workload.ts`, called at `heartbeat.ts:5303`) — NOT the
> ownership/convert/placement machinery, which is reusable as-is.
>
> **Crew routing seam — scoped (crew rides the mint, so prerequisite #2 is NOT on crew's path).** REUSE
> the generic resolver + convert + placement + preflight + staging + mint. BUILD two crew-specific
> pieces: **(a)** a crew workload builder producing a `BatchWorkloadV1` (analogous to
> `buildTaskRunBatchWorkload`; adapter/model via `resolve-crew-adapter.ts` — `anthropic→claude_local` /
> `openai→codex_local` ride, others refuse `adapter_not_v1_scope`); **(b)** a crew ownership+suppression
> SEAM in the crew runner `runAoaAgent` (`internal-agent/aoa-agents/runner.ts`, ~1860 lines — today it
> has NO seam, only `recordDistributedShadow`, and executes via `getServerAdapter`→`adapter.execute`):
> call `resolve()`, and on `owner:"distributed"` hand off + SUPPRESS the legacy `adapter.execute` (the
> crew analogue of `heartbeat.ts:5451` `CLI-006-SUPPRESSION-RETURN`), else run as today. **First
> buildable slice = (a)** — a pure, TDD-friendly, Unit-F-independent function. **Still Unit-F-gated:**
> crew's RESULT loopback needs `jobOutputBridge`, which is producer-blocked (see the crew bullet above),
> so the seam delivers crew work DISPATCHED + EXECUTED on the distributed substrate reaching a terminal;
> results do not flow back until Unit F emits evidence.

## E10-F002 — MIG-008's reconciler and its store have ZERO production callers, so the crosswalk is never written

**Status:** **resolved** · **Resolved by:** MIG-010 Unit 2.3, `597e77715` (PR #336), 2026-09-02.
**Severity:** HIGH
**Filed:** 2026-09-01, by Blocker E-2 terrain verification at `c7ead3a73` (Units 1.6+1.7 / PR #333).

**Resolved.** `reconcileOrganizationLegacyResources` has a production caller — the operator CLI
`server/src/cli/reconcile-legacy-resources.ts` (`pnpm reconcile:legacy-resources`) — and the pass can
now actually execute: migration `0268` adds `legacy_reconciliation_leases`, an org-bound
`SECURITY DEFINER` classification read with `EXECUTE` on `aoa_operator` alone, and Option R removed
the paused CAS, which `aoa_operator` had no grant to perform. The crosswalk is written when an
operator runs the pass — deliberately an operator action, per this table's own security model
("a SERVER-SIDE system/operator pass, NOT a per-tenant-request writer"), not an automatic one.

★ **And the recurrence class is closed, not just the instance.** The reason this survived for the
life of MIG-008 is that the symbol was never enrolled in the repo's own zero-caller register. It now
is: `gate-clause-wiring.json` carries `E10-2-legacy-reconciliation` as `wired`, and
`check-gate-clause-wiring.mjs` reds if the caller is removed or becomes unreachable. Proven by
mutation rather than asserted — renaming the CLI's call exits 1 with
`reconcileOrganizationLegacyResources has 0 production callers`; restoring it exits 0.

**What this does NOT resolve.** The canary is still gated shut. `E7-F004` is open: the gate's
inventory is still a strict superset of any pass's, so a lease created after a pass is still an
unmapped key. See MIG-010 Unit 2.4.

**What.** Both halves of MIG-008's writing path are orphaned:

| Symbol | Definition | Non-test callers |
|---|---|---|
| `reconcileCompanyLegacyResources` | `server/src/services/legacy-resource-reconciliation.ts:324` | **0** |
| `createDrizzleReconciliationStore` | `server/src/services/legacy-resource-reconciliation-store.ts:23` | **0** |

So `legacy_resource_reconciliation` is **never written in production**. CLI-006's canary preflight
reads it (`canary-preflight-store.ts:63`), `assertClosure` finds every inventory key unmapped, and
the gate answers `reconciliation_incomplete` for every organization, forever.

**★ Wiring a caller does not fix it.** The pass must first read `environment_leases`,
`environments`, and the `runtime_provider_keys`→`company_secret_versions` chain — four tables
**neither serving role holds any grant on**, which is exactly why E-1 needed owner-owned
`SECURITY DEFINER` functions. Binding the pass to `operatorDb` as it stands fails with 42501 on its
first read. It also *writes*: `casClaimPaused` → `expireLeaseIfPaused` (`environments.ts:310-327`)
flips `paused → expired`, so running the pass destroys warm snapshots as a side effect.

**Why nothing caught it.** MIG-008's tests assert the pass against injected stores. Nothing asserted
that anything drives it — the failure class in
[`checks-that-nothing-runs`](../../qa/2026-08-31-campaign-blockers-and-fleet-terrain.md): a check
that nothing runs is not a check, and here there was not even a check.

**Blocks.** E7-1. The canary cannot flip to distributed on a correctly-booted flag-on deployment.
