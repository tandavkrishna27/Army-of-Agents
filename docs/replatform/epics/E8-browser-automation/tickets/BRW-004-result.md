# BRW-004 Result — Browser secrets, network, and human approval (slices (a)–(d))

**Status:** `gate_review`
**Date (UTC):** `2026-09-04`
**Epic:** `E8-browser-automation`
**Plan task:** `program-design.md:984 — #### BRW-004`
**Implementer:** Claude Opus 5 (Track D)
**Start SHA:** 6c2fe6482b425a6a99507bdc53f49e8f94969c31

> The design records `203853b3a` as its own Start SHA. This build began at `6c2fe6482`, which is
> the branch tip after the design (`919fcd3c4`) and its seven-finding amendment (`6f3c6e893`)
> landed. Recorded as measured rather than copied from the design.

**Scope:** slices **(a)–(d)** only. Slice (e) is chartered as **JOB-015** and is not built here
(§1). Slices (f)–(h) are not attempted; (f) is now materially affected by slice (a)'s measurement.

---

## 1. The two open escalations — resolved and re-escalated

The design's header names two escalations that gate the slices below. Both are answered here, with
the evidence, and one is handed back.

### §2 D1 / §7 Q1 — "Does BRW-004 own the control-command delivery hop?" — **RESOLVED: NO.**

Three independent pieces of evidence, in order of weight:

1. **A ticket exists for it, in a different epic.**
   `docs/replatform/epics/E3-job-control/tickets/JOB-015-design.md` is on disk and its §3 slices
   (b) and (c) are precisely the server-side projection and the worker-side consumer the hop needs.
   It is E3's, not E8's.
2. **The finding register already points there.** `scripts/finding-ownership.json` binds the
   delivery-hop finding to `"ticket": "JOB-015"`, with the note that it "exists for exactly this
   defect".
3. **The orchestrator confirmed it in the build brief**, adding that JOB-015 is being built in
   parallel on `claude/job-015-control-delivery` and that this track must neither build (e) nor
   duplicate it.

**Consequence, stated plainly rather than absorbed:** BRW-004 stops at slice (d), and the
acceptance clause **"denial/timeout fails closed" is DEFERRED** — the decision is produced,
classified and durably recorded (slices (c) and (d)); nothing delivers it to a running worker.
JOB-015 §6.3 already lists BRW-004 as a consumer to notify when it lands.

### §7 Q5 — "Who authorises a v2 fixture directory, and will they?" — **RE-ESCALATED, unchanged.**

This is a fixture-owner / Protocol Custodian decision and I have no authority to take it. Nothing
in the repository names that authority: `tests/fixtures/distributed-execution/README.md` states the
rule (a breaking change, including *repurposing a field*, requires a new versioned directory
leaving v1 intact) but names no one who may create one.

It does **not** gate slice (b). Slice (b) take-2 is written to land without it — the divergence is
pinned by value and censused — and it is built and green. **`E8-F001` stays open** and its
disposition is unchanged: it must not be closed by deleting the pin, by weakening the gate, or by
making the gate permanently red (all three were tried and withdrawn in the design's own history).

### The other four §7 questions, answered by measurement

- **Q2 — "Can the sandbox constrain outbound egress at all?"** **NO.** Measured, slice (a). See §3.
- **Q3 — "What is a `browser_request` job's `agentId` when the requester is a founder?"** **NULL**,
  in an all-or-nothing pair with `runId`, enforced by a DB CHECK (slice (d)).
- **Q4 — "Does anything read `agent_runtime_decisions.agentId` unconditionally?"** **YES — TEN
  places, and the design named three of them.** See §4. The count was NINE when this doc first
  shipped; the tenth was found by adversarial review of PR #356 and is corrected in place rather
  than appended, because a corrected conclusion above an uncorrected count is the stale-status
  defect this programme keeps filing against itself. The UI half is better than feared:
  `ui/src/api/agent-runtime-decisions.ts` already typed both fields nullable and
  `RuntimeDecisionPanel` reads neither.
- **Q6 — "What component turns a broker-resolved credential into browser session state?"** Still
  **none**. Unchanged by this build; slice (g) is not attempted and the login-fixture test remains
  impossible.

---

## 2. Delivered scope

**Delivered**

- **(a)** A keyed real-provider probe that MEASURES whether the sandbox provider can constrain
  outbound egress, with a positive control and an apparatus control. Verdict taken from a real run.
  No product code.
- **(b)** A `policy`-lane check binding every golden-journey fixture's `control` block to the
  **shipped** `describeSourceGovernance` profile, plus an always-printed divergence census as a
  second verdict. Closes the blind spot behind `E8-F001`.
- **(c)** An injected approval seam on `runBrowserSession` gating navigation and downloads, D5's
  **in-guest** refusal of standing grants, and a frozen-source parity test for the mirrored
  vocabulary. ★ CORRECTED: this bullet said "D5's refusal of standing grants" without the word
  *in-guest*, and that omission was the tenth null-hazard in one word — the guest declines to ACT
  on a standing grant, but the control plane had already MINTED it. See §4.
- **(d)** Migration 0272 relaxing `agent_runtime_decisions.agent_id`/`run_id` to nullable behind an
  all-or-nothing CHECK, migration 0273 making the sibling `agent_runtime_trust_rules.agent_id`
  NOT NULL, plus closure of all TEN null-hazards the relaxation creates.

**Explicit non-goals preserved**

- No `packages/worker-protocol` edit. `check:frozen-worker-protocol-v1` is untouched by design.
- No fixture bytes edited — the README forbids it, including "corrections" in place.
- No Lane A file touched: `job-leasing.ts`, `worker-control.ts`, `execution-secret-*.ts` and
  `job_secret_handles.ts` are unchanged, exactly as design §6 says slices (a)–(d) require.
- Slice (e) not built (JOB-015). Slices (f), (g), (h) not attempted.

---

## 3. ★ Slice (a): the measurement, and what it changes

Run **`33857218680`**, success. Two sandboxes, identical except that A declares
`metadata.egressAllowlist = "example.com"` in production's exact spelling
(`sandbox-provider-runtime.ts:785-789`) and B declares none. Identical target set, run from inside
each guest.

| target | role | A (allowlist declared) | B (control) |
|---|---|---|---|
| `https://example.com/` | positive control | REACHED 200 | REACHED 200 |
| `https://api.github.com/` — **NOT allowlisted** | **the question** | **REACHED 200** | **REACHED 200** |
| `http://169.254.169.254/latest/meta-data/` | observation | **REACHED 401** | **REACHED 401** |
| `https://…invalid/` | apparatus control | FAILED (curl 6) | FAILED (curl 6) |

**VERDICT: the allowlist is INERT.** Design §D3 option (b) is unavailable. **The in-sandbox
enforcement point of D3(c) is the ONLY layer, not defence in depth** — and a browser induced to
reconfigure its own proxy is contained by nothing else. Slice (f) must be written against that
threat statement, not the optimistic one.

**The more serious half** is the observation row: the cloud instance-metadata endpoint ANSWERED
HTTP 401 from inside the guest, in both arms — a live IMDSv2 token challenge, not a dropped packet.
Filed as **`E8-F003` (HIGH, unowned)**.

### ★★ The controls did the work, twice, and both times they changed the outcome

Runs `33855470353` and `33856090430` were reported **INCONCLUSIVE** and no verdict was taken from
either: the apparatus control produced no result row while the three other targets returned
normally. Without it, "not_allowlisted REACHED in both arms" was sitting right there and would have
read as a finished measurement taken from an instrument provably dropping one of its four rows.

The cause, once every target's raw channel was printed: curl writes `-w "%{http_code}"` to stdout
and its error to stderr; `2>&1` interleaves them; on the Linux guest the failing case arrived as
**two lines**. On Windows the same command emits one line — **which is exactly why the local
dry-run passed and the real sandbox did not**. A dry-run on a different platform is not a control
for the real one.

### A reusable CI fact, measured

`workflow_dispatch` does fire from a non-default branch (CLI-008 Unit D, `c48259358`) — but only
for a workflow GitHub has already INDEXED. Dispatching this new lane by name on the branch that
introduced it returned `HTTP 404: workflow ... not found on the default branch`. **A new lane
cannot bootstrap itself with `workflow_dispatch`; its first run must come from a `push` trigger on
the branch that introduces it.** The two older keyed workflows' comments state the rule wrongly in
the other direction.

---

## 4. ★★★ Slice (d): the design named THREE null-hazards of TEN, and three of the seven it missed were lethal

> ★ COUNT CORRECTED TWICE, and the corrections are the point. An earlier draft said "one of eight";
> the first shipped version said "two of NINE". Both were wrong, and so was the second: E8-F002's
> disposition names **two** branches (the sweeper's `runCanceller` and "the bridge's request
> shape"), design §D5 names a **third** (`allow_always` becoming reachable for browser egress), and
> the true total is **TEN**. Hazard 9 surfaced because the E4-F013 successor guard forced a re-read
> of the disposition. **Hazard 10 surfaced because a reviewer read this document adversarially
> after it had already declared the ticket shipped, CI-green and "all NINE closed".**
>
> A result doc that undercounts the hazards it closed is the stale-status defect this programme
> keeps filing against itself, so the count is restated in place rather than appended, and the two
> earlier numbers are left visible so the trajectory is readable.

Design §D2 names two branches and §D5 names a third. Measuring Q3/Q4 found **seven more**. **Three
of them would have shipped an approval feature that refuses every one of its own prompts, rejects
every answer, or silently hands out a company-wide standing grant — each with a completely green
typecheck.**

| # | Hazard | Named by design? | Failure shape |
|---:|---|---|---|
| 1 | `createPrompt` zombie-run guard: `getRunStatus(null)` finds no row → "run is terminal" | **no** | **every distributed decision refused at creation** |
| 2 | `answerPrompt` liveness gate: same shape on the answer side | **no** | **every founder answer cancelled + 409'd** |
| 3 | `runCanceller` aimed at a null run | **yes** | swallowed by the catch; indistinguishable from a successful cancel |
| 4 | `sourceUniqueKey` template-interpolates `runId` → the literal string `"null"` | no | an identity that works by accident |
| 5 | connector auto-allow probe scoped to an absent agent | no | a probe against a scope that does not exist |
| 6 | two hub projections claim `relatedEntityType: "heartbeat_run"` beside a null id | no | a row that lies quietly (columns are nullable; nothing crashes) |
| 7 | `listStrandedAnswers` INNER JOIN on `run_id` | no | **silent exclusion** — no type error, no runtime error, no wrong row |
| 8 | `RuntimeDecisionDetail` is `.strict()` with `z.string().uuid()` | no | the decision exists in the DB and is unreadable through the hub |
| 9 | `RuntimeDecisionOpenRequest` — the bridge's ENTRY POINT — still `string`-only | **yes** (§D2: "the bridge's request shape") | the relaxation is unreachable through the only door that matters |
| 10 | `buildTrustRuleInsert` copies the now-null `agentId` into `agent_runtime_trust_rules`, whose own `agent_id` is nullable and unchecked | **yes** (§D5) | **a company-wide WILDCARD standing grant, minted by one founder answer** |

★★ **Hazard 9 was design-named and this build still missed it on the first pass.** It surfaced only
because the E4-F013 successor guard forced a re-read of the finding's own disposition after the
result doc made BRW-004 "shipped" — the guard did not find the defect, it made me look. **Widening
the service beneath an entry point is a silent no-op**, because a widened parameter still accepts a
narrower argument: `tsc` stays perfectly green while the bridge remains string-only and a browser
job can never reach the relaxed aggregate at all.

Fixing it exposed one more thing worth recording. The bridge's `runtimeSourceIdentity` was a SECOND
implementation of the dedupe-key rule, bound to the service's only by a comment saying the two must
be byte-identical — and making `runId` nullable would have required two independent template
literals to render null identically, by accident, forever. **A divergence there does not fail
loudly:** the receipt fast-path simply never hits, so every replay mints a duplicate aggregate. The
bridge already imported that module, so there had never been a dependency reason for the copy. It
now delegates, and mutation D8 reintroduces the copy and is caught by a source-text assertion —
source text, because the function is not exported and the property being protected is "there is only
one implementation", which no value test can see.

Hazards 1 and 2 are the ticket's own worst-case shape: *a guard that cannot pass looks exactly like
a guard that works.* Both are skipped when there is no run, because a distributed decision's
liveness is the **job fence**, checked by the bridge before either is reached.

Hazard 7 is left in place deliberately — the exclusion is correct (that sweep is about a heartbeat
run going terminal before an in-band relay, and a distributed decision has neither) — and the
absence it leaves is filed as **`E8-F004`**, successor JOB-015.

### ★★★ Hazard 10 — the refusal was landed on the WRONG SIDE OF THE SEAM, and the doc's own words hid it

This is the only one of the ten that grants too much rather than refusing too much, and it is the
one the design predicted most explicitly. §D5, written before any code: *"The moment slice (c)
populates `networkTarget` — which it must, to scope a domain approval — `allow_always` becomes
reachable for browser egress."* §3 slice (c) then instructs: *"land D5's refusal of
`allow_always`/`allow_run` in the same slice, so the widening and its closure are never separated by
a commit."*

**Slice (c) landed a D5 refusal. It landed it in the guest.**
`classifyBrowserPermissionDecision` (`packages/browser-runtime/src/approval.ts`) refuses
`allow_run` and `allow_always` by name, with their own reason code and eight tests. All of that is
real, and none of it closes the hazard, because **the guest decides whether the browser ACTS on a
decision; the control plane decides whether a trust rule is WRITTEN, and it writes it first.**
`answerPrompt` mints the rule at answer time, before the resolver ever returns a value to the
session. The guest then declines to navigate — and the standing grant is already in the database.

The chain, each link re-verified at `717475f63` rather than recalled:

1. `hasConcreteTrustScope` (`agent-runtime-decisions.ts`) is satisfied by `riskClass` **OR**
   `networkTarget` **ALONE**.
2. Slice (c) sets **both** on every navigation (`run-session.ts`: `networkTarget:
   navigationTarget(step.url)`, `riskClass: "network_egress"`).
3. So `answerPrompt` admits `allow_always` for a browser prompt — exactly what §D5 predicted.
4. `buildTrustRuleInsert` copied `agentId: row.agentId`, now **nullable**, into the rule.
5. `agent_runtime_trust_rules.agent_id` was itself **nullable with no CHECK** — the sibling table
   declared immediately below the one that received 0272's all-or-nothing CHECK.
6. And `trustRuleMatchesPrompt` read `if (rule.agentId && rule.agentId !== input.agentId)`, so a
   rule with no agent **matched every prompt in the company**.

**The consequence, with the blast radius RE-DERIVED rather than asserted.** The defect is that an
unbound rule drops the **agent dimension** entirely: the grant stops being scoped to a principal. It
does **not** follow that every agent becomes reachable, and an earlier draft of this paragraph said
exactly that. A match also needs equal `riskClass` and an **exact** `networkScope`, and the two
producers disagree on both:

| producer | `riskClass` | `networkTarget` |
|---|---|---|
| browser seam (slice (c)) | `network_egress` | URL **origin** — `navigationTarget` → `new URL(u).origin` |
| CLI hook bridge (`runtime-hook-bridge.ts`) | `network` | bare **hostname** — `new URL(url).hostname` |

So a heartbeat CLI prompt cannot match a browser-minted rule **today** — by a two-clause
coincidence nobody designed, in code neither side references. What *is* reachable is **every other
distributed browser prompt in the company** on the same adapter and origin: a different job, a
different session, a different requester, for ninety days — and for `allow_run`, whose rule carries
`expiresAt: null`, forever. **One founder's per-session answer silently becoming a cross-session
grant is the escalation**; "every org agent" would have overstated it, and the guard is written on
the binding rather than on the coincidence precisely because the coincidence can be edited away by
someone changing a `riskClass` string.

**Why the branch was unreachable before, which is why nothing caught it.** Until 0272,
`agent_runtime_decisions.agent_id` was NOT NULL, and the only production writer of
`agent_runtime_trust_rules` is `answerWithTrustRule`, reached solely from `answerPrompt`. So no
unbound rule could ever be created, and the wildcard clause in `trustRuleMatchesPrompt` was dead
code. **The relaxation did not add the wildcard; it woke it up.** That is the shape worth
remembering: *relaxing a column can promote unreachable code to reachable code somewhere the
diff never touches.* Nothing in this ticket's 549 changed lines is near
`trustRuleMatchesPrompt`, and no test could have gone red.

**The closure, in three layers, each independently falsifiable.**

| Layer | Change | Falsified by |
|---|---|---|
| Policy | `standingGrantBinding` — one call site; both builders take the narrowed `agentId: string` it returns, so a standing grant cannot be built without passing through the refusal | mutation **E1** (drop the null check) → 4 red |
| Read | `trustRuleMatchesPrompt` compares agents strictly; a null is no longer a wildcard | mutation **E2** (restore `rule.agentId &&`) → 1 red, the escalation case exactly |
| Schema | migration **0273**: `agent_runtime_trust_rules.agent_id` **SET NOT NULL** | mutation **E3** (restore `agentId: row.agentId`) → **tsc error TS2322 at the defect line**; mutation **E5** (revert `.notNull()`) → schema pin red |

★★ **The schema layer is what makes E3 a COMPILE error rather than a runtime guard**, and that is
the point of doing it in the DB rather than only in the service. The exact line the reviewer
identified — `buildTrustRuleInsert`'s `agentId: row.agentId` — can no longer be written at all:
`Type 'string | null' is not assignable to type 'string'`. Measured, not asserted: the mutation was
applied and `tsc` was run.

★★ **It is NOT the sibling's check, and copying that check would have been a worse bug than the
one being fixed.** `(agent_id IS NULL) = (run_id IS NULL)` is right for a *decision* and wrong for a
*trust rule*: a persistent grant is agent-bound and **run-less by design**
(`buildTrustRuleInsert` writes `runId: null`), so the symmetric fix would have rejected every
`allow_always` the product has ever written. The decision table's invariant is *all or nothing*;
this table's is *always bound*. Four schema tests pin both halves, including one that asserts the
trust rule does **not** carry the decision's check.

★ **The predicate is the BINDING, not the source.** §D5 words the refusal as "browser-sourced
prompts", but the decision row carries no source column — checked, not assumed:
`agent_runtime_decisions` has `sourceUniqueKey` and nothing else that names a job source. The
binding is the only discriminator the row has, and it is also the load-bearing one, since *unbound*
is precisely what makes the grant unsafe. Today the two sets coincide, because `browser_request` is
the only source that opens an agent-less decision.

★ **Also closed: a second door with zero callers.** The service's own `createTrustRule` accepted
`agentId?: string | null` and wrote `?? null`. It has **no production callers** (the routes expose
only list and revoke; `internal-agent.ts:506` reaches a different service, `internal_agent_tool_-
trust_rules`). Counting the callers is what made the 0273 narrowing provably safe *and* showed the
second door — so it is now `agentId: string`, closed before it acquires a caller.

**Proven against real Postgres, not only in mocks.**
`brw-004-decision-binding.integration.test.ts` grows three cases that run on embedded PG: an
unbound trust rule is REJECTED, an agent-bound persistent rule with `run_id IS NULL` is ACCEPTED
(the control that says the two tables need *different* invariants), and the refused insert leaves
nothing behind. Run locally on Windows with `AOA_RUN_WIN_INTEGRATION=1`: **8/8**, and the Postgres
log shows the real `23502` rejection. `migration-readiness.integration.test.ts` — the suite that
caught 0272's non-re-appliable `ADD CONSTRAINT` — passes **4/4** with 0273 as the tail, because
`ALTER COLUMN … SET NOT NULL` *is* re-appliable. That was checked rather than assumed; it is the
same distinction 0272 already made this branch pay for once.

**What this says about the process, since the count has now been wrong three times.** Hazard 9 was
found by a guard that made someone re-read a disposition. Hazard 10 was found by a human reading
this document adversarially *after* it said shipped, CI-green, sixteen checks passing. Neither was
found by CI, and CI would not have found either: hazard 10 is unreachable code becoming reachable
through a column, which no test in the repository was watching. **A green suite bounds the failures
you thought to write down.** The result doc's slice-(c) bullet, meanwhile, said "D5's refusal of
standing grants" — true as written, and it read as closure of a hazard it did not touch. One
missing word did more concealment than any missing test.

**Every case is a PAIR.** The distributed arm proves the new branch is taken; the LEGACY arm proves
the guard it skips still fires for a heartbeat run. A test that only shows the null path succeeding
cannot tell "correctly skipped" from "accidentally disabled for everyone" — and mutation D2/D4
below proves the pairs catch exactly that.

★ The design also names `job-approval-parity.integration.test.ts` as the place to add a browser case
that does NOT seed a synthetic agent or heartbeat run. That extension is **not** landed: the case it
would assert is the bridge WRITING a null-bound decision, and the bridge composition is unbuilt
(§10). What is landed instead is the layer beneath it —
`brw-004-decision-binding.integration.test.ts` proves the aggregate ACCEPTS the row the bridge would
write, and 13 unit cases prove the service builds it. Saying so rather than implying the design's
named artifact exists.

---

## 5. Changed files

| File | Responsibility |
|---|---|
| `packages/sandbox-e2b-provider/scripts/probe-e2b-egress-constraint.mjs` | (a) the differential outbound-egress probe |
| `.github/workflows/keyed-e2b-egress-constraint-probe.yml` | (a) its keyed lane; push-bootstrapped because a new lane cannot dispatch itself |
| `.github/keyed-e2b-egress-constraint-trigger` | (a) the trigger + the run-by-run record incl. the two INCONCLUSIVE runs |
| `scripts/check-distributed-execution-foundation.mjs` | (b) the control-block↔authority binding, the value-tuple pin, the census |
| `scripts/check-distributed-execution-foundation.test.mjs` | (b) 8 mutation cases + the authority copied into the fixture root |
| `packages/browser-runtime/src/approval.ts` | (c) the seam, D5's refusal, the fail-closed deadline |
| `packages/browser-runtime/src/run-session.ts` | (c) the navigation and download gates, before the action |
| `packages/browser-runtime/src/index.ts` | (c) exports, so the seam is reachable from a consumer |
| `packages/browser-runtime/src/__tests__/approval.test.ts` | (c) 24 cases, every fail-closed one paired with its positive control |
| `packages/browser-runtime/src/__tests__/approval-frozen-parity.test.ts` | (c) binds the mirrored vocabulary to the frozen source |
| `packages/db/src/schema/agent_runtime_decisions.ts` | (d) nullable pair + the all-or-nothing CHECK |
| `packages/db/src/migrations/0272_browser_request_decision_binding.sql` | (d) `db:generate` output, slot re-pinned at generation |
| `packages/shared/src/validators/hub.ts` | (d) hazard 8: the API boundary would have rejected the null |
| `server/src/services/agent-runtime-decisions.ts` | (d) hazards 1–7 |
| `server/src/services/job-approval-bridge.ts` | (d) hazard 9: the entry point, and the duplicate identity implementation removed |
| `server/src/__tests__/brw-004-distributed-decision-binding.test.ts` | (d) 13 unit cases, each a distributed/legacy pair |
| `server/src/__tests__/brw-004-decision-binding.integration.test.ts` | (d) 5 cases proving the CHECK fires against REAL Postgres |
| `packages/db/src/migrations/meta/0272_snapshot.json`, `meta/_journal.json` | (d) `db:generate` output that accompanies the migration |
| `docs/replatform/epics/E8-browser-automation/findings.md` | E8-F003, E8-F004 |
| `scripts/finding-ownership.json` | their `unowned` entries with checkable successors |

---

## 6. Acceptance evidence

| Acceptance condition | Evidence | Result |
|---|---|---|
| "allowed domains … are enforced" | **Not delivered.** Slice (f) not attempted. Slice (a) MEASURED that the provider adds no boundary, so the enforcement point is the only layer | `deferred` |
| "denial/timeout fails closed" — decision produced | (c) `awaitApprovalDecision` refuses on deadline, on denial, on a throwing resolver, on an unknown decision, and on a missing resolver; (d) the aggregate can hold the row | `pass` |
| "denial/timeout fails closed" — decision delivered | **DEFERRED to JOB-015** (§1). Nothing carries a control command to a running worker | `deferred` |
| D5: a browser prompt accepts `allow_once` only | (c) `classifyBrowserPermissionDecision` + frozen-source parity test asserting exactly one frozen decision proceeds | `pass` |
| E8-F001 is visible to a guard | (b) `node scripts/check-distributed-execution-foundation.mjs` prints the census naming E8-F001; a different fixture with the same contradiction is RED | `pass` |
| E8-F002: the aggregate can hold a distributed row, and cannot hold an unbound standing grant | (d) migrations 0272 + 0273 + the CHECK + the sibling's NOT NULL + 23 unit tests + 8 REAL-Postgres integration tests (observed `23502` / CHECK error text), 16 killed mutants — one killed by `tsc` | `pass` |
| "session state is destroyed at terminal state" | Slice (h) not attempted | `deferred` |
| "OAuth refresh remains control-plane-owned" | Unchanged by this build; no browser path touches the refresh lease | `pass (by inheritance)` |
| Test: login fixture / connector rotation / log-leak | Slice (g) not attempted; §7 Q6 still unanswered | `deferred` |

---

## 7. Commands

| Command | Exit code | Result summary |
|---|---:|---|
| `node scripts/check-distributed-execution-foundation.mjs` | `0` | PASS; census names E8-F001 + 4 unmodelled values |
| `node --test scripts/check-distributed-execution-foundation.test.mjs` | `0` | 190 pass / 0 fail (182 before, +8) |
| `npx vitest run` (packages/browser-runtime) | `0` | 129 pass / 17 skipped (93 before; +26 approval, +10 frozen-parity) |
| `npx vitest run src/__tests__/brw-004-distributed-decision-binding.test.ts` | `0` | 13 pass |
| `npx vitest run` × 4 neighbouring decision suites | `0` | 90 pass / 0 fail — no regression |
| `AOA_RUN_WIN_INTEGRATION=1 npx vitest run …brw-004-decision-binding.integration.test.ts` | `0` | 5 pass — the CHECK fires against REAL Postgres |
| `AOA_RUN_WIN_INTEGRATION=1 npx vitest run …job-approval-parity.integration.test.ts` | `0` | 13 pass with 0272 applied |
| `npx vitest run --shard=1/4` | `1` | 5762 pass / **2 fail, NOT mine** — see below |
| `npx tsc -p . --noEmit` (server) | `0` | clean (pre-existing `TS18046` noise in `routes/plugins.ts` unrelated) |
| `npx tsc -p . --noEmit` (ui) | `0` | clean |
| `npx tsc --noEmit` (packages/browser-runtime) | `0` | clean |
| `node scripts/check-finding-ownership.mjs` | `0` | OK, 30 open findings across 10 registers |
| `drizzle-kit generate` | `0` | `0272_browser_request_decision_binding.sql`, then `0273_trust_rule_agent_binding.sql` — one statement, only the intended column |
| `migration-readiness.integration.test.ts` (real PG, 0273 as tail) | `0` | 4/4 — `SET NOT NULL` is re-appliable, unlike 0272's `ADD CONSTRAINT` |
| `brw-004-decision-binding.integration.test.ts` (real PG) | `0` | 8/8, incl. the 3 new hazard-10 cases; Postgres logs the real `23502` |
| GH run `33857218680` | `0` | the slice (a) measurement, both controls satisfied |

### Mutation log — every guard shown RED, then restored

| # | Mutation | Killed by | Restored |
|---:|---|---|---|
| B1 | slice (b)'s check call replaced by an empty census | 8 tests (182/8) | 190/190 |
| C1 | `allow_always` proceeds (D5 removed) | 5, incl. the frozen-parity pair | ✔ |
| C2 | missing resolver fails OPEN | 1 | ✔ |
| C3 | the gate neutered entirely | 5, incl. the download half | ✔ |
| C4 | a throwing resolver fails OPEN | 1 | ✔ |
| C5 | the timeout returns proceed | 2 | ✔ |
| C6 | an unhandled-rejection guard removed | **SURVIVED — the guard was wrong, see below** | n/a |
| D1 | `createPrompt` guard un-skipped for a null run | 1 | ✔ |
| D2 | `createPrompt` guard removed for **everyone** | 2 (both positive controls) | ✔ |
| D3 | `answerPrompt` gate un-skipped | 1 | ✔ |
| D4 | `answerPrompt` gate removed for **everyone** | 1 (the positive control) | ✔ |
| D5 | canceller aimed at a null run | 1 | ✔ |
| D6 | sentinel replaced by template-null | 3 | ✔ |
| D7 | hub type claim restored unconditionally | 1 | ✔ |
| D8 | the bridge's duplicate identity implementation reintroduced | 1 | ✔ |
| D9 | migration 0272's predicate weakened to `CHECK (true)` | 3 (real PG) | ✔ |
| D10 | 0272's predicate weakened to the one-directional variant | 3 (real PG) | ✔ |
| D11 | 0272's `DROP CONSTRAINT IF EXISTS` guard removed | 1 (`migration-readiness`, real PG) | ✔ |
| **E1** | **hazard 10:** `standingGrantBinding`'s null check dropped | **4** | ✔ |
| **E2** | **hazard 10:** `trustRuleMatchesPrompt`'s wildcard clause restored | **1 — the escalation case exactly** | ✔ |
| **E3** | **hazard 10:** `buildTrustRuleInsert` copies `row.agentId` again | **`tsc` TS2322 at the defect line** | ✔ |
| **E4** | **hazard 10:** the binding refuses EVERYTHING (over-refusal) | **8** — 3 new positive controls **+ 5 pre-existing** | ✔ |
| **E5** | **hazard 10:** the schema `.notNull()` reverted | **1** (the new schema pin; nothing else in CI compares schema to 0273) | ✔ |

### ★★★ CI caught a real defect in migration 0272 that every local check had missed

`verify (2)` went RED on `migration-readiness.integration.test.ts` — *"recovers to READY after the
privileged migration job re-applies the pending tail idempotently"*. It is mine, and it is a real
defect, not a flake.

That test deletes the last row from `drizzle.__drizzle_migrations` and re-runs the privileged
migration job. **0272 was the tail.** `ALTER COLUMN … DROP NOT NULL` is idempotent; **`ADD
CONSTRAINT` is not** — Postgres raises 42710 `constraint … already exists`. So a re-apply failed and
the app would never have recovered to READY.

Everything local had passed: `ci-local` ×2, the CHECK's own five real-Postgres cases, the JOB-011
parity suite with 0272 applied, and all four vitest shards — **because none of them re-applies the
tail.** "Generated DDL" and "re-appliable DDL" are not the same property, and only the second is what
the migration job requires. This is the same class as the ADD COLUMN trap this programme has already
paid for once.

Fixed with the C14 class-(a) guard — one hand-appended
`ALTER TABLE … DROP CONSTRAINT IF EXISTS` line, the identical pattern and rationale as
`0264_public_patch.sql`. **Reproduced locally before the fix** (the exact 42710 error), **and re-run
green after** (9/9 across migration-readiness and the CHECK suite). The pre-fix failure is mutation
D11's red.

### ★★★ One mutant SURVIVED, and the answer was that my fix was unnecessary

C6 is recorded because a surviving mutant is a question and this one had a useful answer.

Reading `awaitApprovalDecision` end to end before calling the work done, I convinced myself of a
hazard — `Promise.race` settles once, so a resolver rejecting AFTER the deadline wins would leave a
rejected promise with nothing listening, fatal under `--unhandled-rejections=strict` in a module
that runs as the sandbox ENTRYPOINT — and added `void Promise.allSettled([...])` plus a test.

Deleting the guard did not turn the test red. Two possible answers, and I checked both:

1. **The test could not see the property.** True of the first attempt, which listened for
   `process.on("unhandledRejection")` inside vitest — vitest installs its own handler, so Node never
   reports it. That test passed identically with and without the guard: **a check that nothing runs,
   written by me, in the file whose header is about that exact failure mode.**
2. **The guard was unnecessary.** The real answer. Rewritten as a strict-mode child process the
   mutant survived again, and a direct experiment settled it: `Promise.race` calls `.then` on every
   element, so the loser's rejection is already observed.

**The guard was removed** and the belief recorded in the source as measured-and-false. Shipping a
defensive line beside a test that can never fail is a false claim of enforcement — worse than an
absent check, because every later reader takes it for a handled hazard.

### The three shard failures are NOT mine, and I checked rather than said so

`debrief-redirect.test.ts` and `discussions-routes-contract.test.ts` each failed one assertion:
`expect(performance.now() - startedAt).toBeLessThan(3000)` around a dynamic `import()`, measured at
4746ms and 4887ms. A wall-clock budget on a module import, failing while this machine was running
vitest shards, embedded Postgres and a pnpm install concurrently — the same family as E3-F034 and
E3-F036. **Verified, not assumed:** re-run alone on a quiet machine, both files pass 12/12. I touched
no route module, and the assertion that fails is the timing one, not the export check on the next line.

Shard 2's single failure is `workspace-runtime.test.ts` — a `vi.waitFor` on a spawned runtime log
sink, the same timing family. **Verified, not assumed:** re-run alone, 40 pass / 13 skipped, 0 fail.
Shards 3 and 4 were clean (5416 and 5488 pass, 0 fail). Across all four shards, every failure was a
timing assertion in a file this change does not touch, and every one passed on re-run in isolation.

★ A method note worth carrying: the first shard run was piped through `tail`, so the tool reported
`exit 0` — the pipeline's exit is `tail`'s, not vitest's. A red suite read as green. Re-run
unpiped to a file before believing any shard result.

Final restored state verified green, not assumed: 127 (browser-runtime), 190 (foundation), 77
(server decision suites; 78 after the bridge change).

---

## 7a. Gates this touches, and the one deliberate non-action

Design §5's list, each checked rather than assumed:

| Gate | State |
|---|---|
| `policy` — slice (b) extends `check-distributed-execution-foundation.mjs`; slice (d) adds a migration | green locally (`ci-local`, 210s) and in CI |
| `browser` lane — slice (c) | **pass** on PR #356 |
| `check:frozen-worker-protocol-v1` — must stay OK with ZERO `packages/worker-protocol` edits | `worker-protocol-contract-bytes` **pass** on ubuntu AND windows; no worker-protocol file is in the diff |
| `check-guard-inventory.mjs` — every new guard needs a CI invocation | slice (b)'s guard rides `check-distributed-execution-foundation.mjs`, already invoked at `pr.yml:162-163` and `:1267`. The probe is not a guard: it gates nothing |
| `check-gate-clause-wiring.mjs` — composing a previously-uncalled symbol reds `policy` | no gate-clause symbol is composed. The bridge's `openGovernedDecision`/`resolveGovernedDecision` are deliberately NOT wired (§10); the new symbols are new |
| `check-finding-ownership.mjs` | OK, 29 open across 10 registers, with E8-F001/F003/F004 declared |
| `check-ticket-graph-coverage.mjs` — `#### BRW-004` in `program-design.md:984` | present; `policy` green |

### ★ `docker/d1/campaign.env` is deliberately NOT bumped

Design §5 says to bump it if a slice alters runtime behaviour under `server/src`, "and only after
the last such change. Coordinate — the last bump wins and that trap has bitten this programme five
times." Slice (d) does touch `server/src`, and `server/src` is not on the D1 lane's push path
filter, so the rule appears to apply. **It is not bumped, on purpose, for two reasons:**

1. **The change alters no live path.** Every new branch is guarded on a null `runId`/`agentId`, and
   no production writer produces one: nothing submits a `browser_request` job, `jobApprovalBridge`
   has zero production callers and is flag-gated off. A D1 campaign would rebuild the image and
   exercise exactly the same behaviour it does today. A bump that proves nothing is not free — it
   costs a full live 2-replica campaign.
2. **Four tracks are live and the last bump wins.** Bumping for a no-op risks clobbering a
   concurrent track's bump that is not a no-op, which is the exact trap §5 warns about.

Recorded as a decision so a reviewer can overrule it, rather than as an omission. **If any reviewer
judges the `server/src` diff live, bump it — the argument above is about behaviour, not about
convenience.**

---

## 8. Deviations

1. **★★★ Slice (b)'s runtime-decision arm is narrower than the design specifies, and the design as
   written would have red-lit three innocent fixtures.** §3 slice (b) says to bind BOTH
   `control.productApproval` and `control.runtimeDecision` to the shipped profile. That is right for
   `productApproval` — a 3-value enum whose non-`none` values each assert "a product approval
   existed here", which is exactly where E8-F001 lives. It is a **category error** for
   `runtimeDecision`, a 7-value SCENARIO enum spanning unrelated mechanisms:
   `RuntimeDecisionAuthority` has four members and four of the seven scenario values name mechanisms
   it does not model at all. Taken literally, `plaintext-secret-in-argv-rejected`,
   `service-provider-pause-resume` and `service-restart-checkpoint` would each have failed a
   contract they never claimed to satisfy. The arm therefore binds only `egress_denied` and
   `budget_stop`; the other four are declared `unmodelled` **with a written reason** and printed in
   the census. Naming an omission is the `unowned`-with-reason pattern; leaving it silent would be
   the blanket exemption the whole slice exists to avoid.
2. **The design's §D2 null-branch list is incomplete by seven.** It names two branches; §D5 names a
   third, elsewhere in the document and not as a null-branch at all; there are **ten**. §4 above.
   Not a disagreement with the decision — the decision is right and is implemented as specified,
   every named branch included — but the work it implies is materially larger than "two call sites
   then need a null branch", and two of the seven it does not name would each have made the
   relaxation useless while every test and typecheck stayed green.
   ★ **The §D5 one is the sharper lesson.** The design DID name it, in a section about product
   policy rather than about nulls, and slice (c) DID land a refusal — in the guest, where it cannot
   stop the control plane from writing the rule. **A hazard named in the right document, closed on
   the wrong side of a seam, reads exactly like a closed hazard.** A design that scatters the
   closure list across sections gets counted section by section.
3. **Slice (c) does not emit a `runtime_decision_requested` event, and cannot.** The design says the
   seam emits it "through the worker's existing `EventSequencer`". The sequencer is host-side, in
   the worker daemon; `packages/browser-runtime` is staged into the guest as bare files with no
   `node_modules`. More importantly the frozen event requires a `requestDigest` (SHA-256 over
   canonical bytes) and a `sourceRevision`, and the guest has neither the canonicalizer nor the
   counter. A digest the control plane recomputes differently is **worse** than none: it fails as a
   request that never verifies, which reads as a hung session. The guest therefore produces an
   INTENT of only the fields it is the authority for, pinned field-by-field against the frozen
   schema's source. **The completion step is not built.**
4. **Slice (a)'s workflow carries a build-branch push trigger.** Required, not decorative: without
   it the lane could not run before its own PR merged, and an unrun probe measures nothing (§3).

---

## 9. Findings

- **`E8-F001`** — **still open, now `unowned`.** BRW-004 shipped its half: the divergence is
  VISIBLE to a guard for the first time, pinned by value tuple, and censused on every `policy` run.
  The residual — a v2 fixture directory — is §7 Q5's escalation, handed back (§1), and **no ticket
  in the programme owns the fixture corpus**. Moved to `unowned` with "none exists yet" rather than
  left pointing at a ticket that has now shipped, which is E4-F013's exact failure.
- **`E8-F002`** — **RESOLVED**, and the resolution was PREMATURE the first time it was written.
  Migration 0272 + the all-or-nothing CHECK + both null branches the disposition names (the bridge's
  `RuntimeDecisionOpenRequest` shape and the sweeper's `runCanceller`) + the seven further hazards
  the disposition missed — **ten**, not nine. Migration 0273 closes the tenth by making the sibling
  `agent_runtime_trust_rules.agent_id` NOT NULL. 23 unit tests + 8 real-Postgres cases, 16 killed
  mutants (D1–D11 + E1–E5), one of them a compile error.
  ★ The first version of this bullet said "the six further hazards" and "13 tests, 8 killed
  mutants" while a company-wide wildcard grant was reachable through the very path §D5 said to
  watch. It is corrected in place, and the correction is recorded rather than tidied away: **the
  claim was wrong when it was made, not merely superseded.**
  Resolved on the MECHANISM: the finding said the aggregate *cannot hold a row*, and it can now. The
  absence of a production writer is BRW-004's own unbuilt scope (§10), not this finding's residual —
  saying otherwise would leave a fixed defect open forever.
- **`E8-F003`** — **NEW, HIGH, unowned.** The sandbox's egress allowlist is inert and the cloud
  instance-metadata endpoint answers from inside the guest. ~~Successor named.~~
  **CORRECTED 2026-09-04, re-headlined 2026-09-05 by the E8-F003 disposition unit — no successor
  covers the measured path, and the finding's headline is not the measurement.** What the finding
  is *for* is a **misrepresentation**: `distributed-execution-threat-controls.json` **DE-08** is
  severity **Critical**, its `failureMode` is literally the measured event, and its sole owner
  **DAT-005 is COMPLETE** while its chartered outcome was to *enforce* default-deny — a Critical
  control whose owner column is exhausted and whose enforcement exists at no layer. Three more
  programme records assert the same constraint in the present indicative (`program-design.md:149`
  under "Security invariants"; the threat model's residual-risk list, which omits DE-08 while
  listing a sibling egress exclusion; the E5 exit-gate audit's `proven_in_d1` grade for "denied
  egress"). Enforcement is absent at ALL THREE candidate points (provider measured inert,
  in-sandbox unbuilt, proxy zero-caller). BRW-004 slice (f) is still ~~the only chartered
  candidate~~ **the only REMAINING chartered candidate (corrected 2026-09-07, W16A-FIX)**
  but is scoped to BROWSER sessions, while slice (a) measured org heartbeat runs and crew runs —
  and the metadata-reachability half is broader than E8 in any case. Severity stays HIGH. See
  `findings.md` E8-F003 §1 for the headline and §7 for the disposition.
  **On the correction:** this same bullet already says that DE-08's "sole owner **DAT-005 is
  COMPLETE** while its ***chartered*** outcome was to *enforce* default-deny", so "the only
  chartered candidate" contradicted a sentence a few lines above it. **Two** tickets were chartered over this capability and shipped without it — DAT-005
  and DSK-002 — and a third, DSK-003, was only *nominated* as DSK-002's successor and never took
  it (its charter names no egress at all). Derivation: `scripts/gate-clause-wiring.json` →
  `E5-6-denied-egress`. Nothing else in this dated result doc is restated or re-graded.
- **`E8-F004`** — **NEW, LOW, unowned.** No stranded-delivery sweep for a distributed decision;
  it cannot exist before JOB-015. Successor named; must not be closed by deleting the join.
- **`E8-F005`** — **NEW, MED, unowned.** Nothing in CI compares the Drizzle schema to the
  migrations. Found by mutation E5 while closing hazard 10: reverting a `.notNull()` while leaving
  its migration in place is GREEN across `tsc`, every test, `migrations` and `policy`. The
  undetected direction is the **relaxing** one — the one that restores a security narrowing's
  hazard while the migration that "closed" it is still in the tree. BRW-004's answer is a single
  hand-written per-column pin, which is a check that exists only where someone thought of it;
  the class needs a `policy`-lane regenerate-and-diff step. Must not be closed with more pins.

---

## 10. ★ Built but NOT wired — read this before believing anything above is live

- **Nothing submits a `browser_request` job** (terrain §12). Every slice here is exercised by tests,
  not by production traffic.
- **Slice (c)'s seam has no real resolver.** It ships `inertRefusingResolver`, and the gate defaults
  **off**, because no control-plane hop delivers a decision to a running worker. Turning the gate on
  today makes every session refuse at its first step.
- **Slice (d) adds no writer.** `jobApprovalBridge` still has zero production callers and is
  flag-gated off. The aggregate is now *able* to hold a distributed row; nothing writes one. The
  bridge's `openGovernedDecision`/`resolveGovernedDecision` composition and the timeout sweeper's
  coupling to it are **not landed** — both are only observable end-to-end once JOB-015 delivers, and
  the sweeper change is a behavioural change to a boot-rooted 30-second loop.
- **Slice (a) is a probe.** It gates nothing and enforces nothing. It answers a question.
- **Hazard 10's escalation was never LIVE, and that is not a reason to have left it.** No
  distributed decision exists (no writer), so no unbound trust rule was ever minted. What shipped
  was the *capability* to mint one from the first browser answer the moment a writer appears — a
  latent privilege escalation with a green suite over it. This ticket's whole subject is a table
  being made able to hold a row before anything writes one; "not live" is the ticket's normal
  condition, not a mitigating one, and closing latent hazards at relaxation time rather than at
  writer time is the reason §4's other nine were closed here too.

### ★★★ Capability: this work does NOT flip the E7-1 gate, and here is exactly what would

`capabilityProven` is cleared by `countProducedOutputs`
(`e7-distributed-run-verifier.ts:506`), an OR over `workspacePatchArtifacts` and `taskOutputs`. The
artifact arm filters `kind = "workspace_patch"`
(`e7-distributed-run-verifier-store.ts:205-209`).

**Nothing in slices (a)–(d) commits a `job_artifact` of any kind, let alone `workspace_patch`, and
nothing writes a `task_output`.** Slice (a) creates no job at all. Slices (b) and (d) are a CI check
and a schema relaxation. Slice (c) produces an approval intent, not an artifact.

So: **this advances the approval and governance path without moving the capability counter.** What
would still be required is unchanged from CLI-008 Unit F §1.6 — a file to export, a real
`exportArtifact`/`digestArtifact`, the worker-side consumer (DAT-009 slice 3), and (for task
projection, though not for the counter) an `artifactPrepared` announcement plus a projector. None of
that is here and none of it is claimed.

---

## 11. Follow-up tickets

- **JOB-015** — the delivery hop. Unblocks "denial/timeout fails closed" end-to-end and is the
  successor for `E8-F004`.
- **BRW-004 slices (f)/(g)/(h)** — egress enforcement, connector materialization, session-state
  destruction. Slice (f) must now be written against slice (a)'s measured threat statement: the
  in-sandbox enforcement point is the ONLY layer.
- **`E8-F003`'s metadata half needs an owner beyond E8** — every sandboxed workload shares the
  reachability, not only browser sessions.

---

## 12. Gate recommendation

**Ready for RE-review**, for slices (a)–(d) as scoped. This document previously said "ready for
independent review" and was reviewed: **refuted 2 of 3 on substance, with one defect precisely
located** — hazard 10, §4. That review is the reason this section is rewritten rather than
re-asserted.

Every fail-closed clause implemented here has a positive control that was shown to fire.
**Twenty-three mutations were run; twenty-two were killed and restored, and one (C6) SURVIVED — the
guard it deleted was unnecessary, so the guard was removed rather than kept beside a test that could
never fail.** One of the twenty-two (E3) is killed by `tsc` rather than a test, which is the
strongest form available: the defect line can no longer be written. That is stated here rather than
smoothed into "every guard was mutated red", which an earlier draft said and which was not true.
★ **This paragraph said "twelve … eleven" before hazard 10, and that was ALREADY STALE** — the log
had grown to eighteen rows while the prose stayed at the count it had when D6 was the last entry.
So the same document undercounted its hazards AND its mutations, by the same mechanism. The figures
above are COUNTED from the table rather than carried forward; a hand-maintained total beside a
growing table is the defect, not the number that happens to be in it. The deferrals are
named with their reasons rather than implied, the capability question is answered in the negative
rather than avoided, and the two escalations are reported as resolved (Q1) and handed back (Q5).

★★★ **What the review changed, stated plainly.** Two of the reviewer's three findings did not
survive re-tracing and are NOT re-opened here: §7 Q1 is resolved on evidence that predates this
branch, and Q5's divergence stays PINNED in slice (b)'s census — reported on every run, failing
nothing — which is the design's own pre-authorised interim path. The third was real, and it was the
one this document was least able to see, because the document itself had already claimed it closed.

**What a reviewer should attack first**, in order:

0. **Hazard 10's THREE layers, and whether any is redundant.** The policy guard alone would have
   closed it; I also narrowed the schema and the matcher. Attack the schema narrowing hardest: it is
   safe only because `agent_runtime_trust_rules` has exactly one production writer, which I measured
   by counting callers (`createTrustRule` has none; `internal-agent.ts:506` is a different service).
   If you can name a writer I missed, 0273 fails on a live database rather than in CI.
1. **Deviation 1** — I narrowed a design-specified binding (slice (b)'s runtime-decision arm).
   Check that the narrowing is honest rather than convenient: the test is whether the four
   `unmodelled` values genuinely have no member in `RuntimeDecisionAuthority`.
2. **§4 hazard 7** — I left an INNER JOIN in place and filed the gap as E8-F004. Check the exclusion
   really is correct rather than merely convenient.
3. **E8-F002's closure.** I marked it resolved on the mechanism with no production writer. If you
   think a finding about "the aggregate cannot hold a row" should stay open until something writes
   one, say so — but note that BRW-004 has shipped, so re-opening it needs a successor, not a
   status flip.
4. **§7a's campaign.env non-bump.** A judgement call about whether the `server/src` diff is live.

**CI verdict (pre-hazard-10): `ci-required` PASS**, all 16 checks green on `0eca473a7`
(run `33863983798`), including `verify (2)` — the shard that caught the migration defect — and
`browser`, `migrations`, `policy`, `e2e`, `e2e-pgvector` and `worker-protocol-contract-bytes` on
both platforms. ★ **That green is exactly the one the tenth null-hazard shipped underneath**, which
is why it is left in place rather than deleted: sixteen green checks bounded the failures someone
had thought to write down, and hazard 10 was not one of them.

**CI verdict (post-hazard-10):** the hazard-10 commit is the head of PR #356; read its `ci-required`
there rather than trusting this sentence. It is deliberately not restated as a number here — a
hand-copied verdict in a document is the same artifact as a hand-copied hazard count, and this
document has now been wrong about both.

### ★★★ A PR whose base has moved gets ZERO workflow runs, and that is invisible

Measured on this branch while landing hazard 10, with a positive control, because it is the
`check that nothing runs` failure wearing a new costume.

Two force-pushes (`c03506a15`, `2dc8717db`) produced **no `PR` workflow run at all** — not a red,
not a cancel, nothing. Actions was healthy throughout: another branch started a `PR` run at 12:24
while mine had none, and this branch's own `keyed-e2b` probe workflow fired on both pushes. The
cause was `gh pr view 356 --json mergeable,mergeStateStatus` → **`CONFLICTING` / `DIRTY`**: the base
`docs/replatform-program` had advanced to `3ca688776` (#355), GitHub could not compute the PR's
merge ref, and `pull_request`-triggered workflows do not run without one.

**Positive control:** the same branch content, rebased onto `3ca688776`, went `MERGEABLE` and the
`PR` workflow started within a minute. Cause established, not guessed.

**Why it matters more than the inconvenience.** The PR page shows *no checks*, which reads as
"CI has not got to it yet" and is indistinguishable from "CI will never get to it". `ci-required`
— the single required check — is not `skipped` and not `failing`; it is **absent**, so there is no
red for anyone to read. A stale-base PR therefore sits in exactly the state DEP-013 was written
about: a verdict that never arrives and nobody notices. **Fetch and compare the base before
reading a green — and before reading a silence.**

★ The first attempt at that run was CANCELLED, not red: the `policy` job hung in
`pnpm/action-setup`'s self-installer and took the run with it. That is infrastructure, and it is
recorded rather than glossed because a cancelled run and a failing one look identical in
`ci-required`, and reading the first as "my change is broken" — or the reverse — would both have
been wrong. Re-run of the failed jobs: green.

**Codex verdict: ABSENT.** No independent Codex review was obtained for this build. Recorded in
words rather than read as approval.

---

## 13. Independent review

**Reviewer:** `pending until first independent review`
**Reviewed revision:** `pending until first independent review`
**Disposition:** `pending`
**Review evidence:** `pending until first independent review`

## 14. Review attempt history

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
<!-- First independent reviewer appends attempt 1. -->
