# E8 — Browser automation — findings

## E8-F001 — A frozen fixture and shipped code name DIFFERENT approval authorities for `browser_request`, and nothing can see the disagreement

**Status:** open · **Owner:** `unowned` (BRW-004 shipped its half; see the disposition)
**Severity:** MED
**Filed:** 2026-09-03, by BRW-004 terrain mapping at `203853b3a`.

**What.** For a `browser_request` source, the frozen golden-journey fixture says the approval rides
the **product-approval** authority; shipped JOB-011 code says that authority is `"none"` and the
approval is a **runtime permission decision**. No guard compares the two.

**The two claims, verbatim.**

`tests/fixtures/distributed-execution/browser-approval-download.json:205-207` (frozen; `source.kind`
is `browser_request`):

```json
"control": { "cancellation": "none", "productApproval": "requested_granted", "runtimeDecision": "none" }
```

`server/src/services/job-approval-bridge.ts:173-183`, shipped and test-pinned:

```ts
case "browser_request":
  return { kind: "browser_request",
    productApprovalAuthority: "none",
    runtimeDecisionAuthority: "permission_download_egress",
    aggregateKind: "agent_runtime_decisions",
    projectionKind: "runtime_decision",
    mintsAggregate: true };
```

`job-source-governance-matrix.test.ts:134-140` pins the code side. The sibling fixture
`browser-denied-egress.json` agrees with the *code* (`"runtimeDecision": "egress_denied"`), so the two
browser fixtures do not even agree with each other.

**Why nothing catches it.** `validateFixtureSourceParity`
(`scripts/check-distributed-execution-foundation.mjs:2722-2752`) validates a fixture's requester
principal, executor principal, and required/forbidden `source` fields against
`docs/architecture/distributed-execution-legacy-parity.json`. It **never reads the `control` block**.
The parity contract's own prose for `browser_request` is ambiguous enough to license both readings —
*"Download and egress approval (requested_granted / requested_denied); runtime egress decisions gate
outbound bytes"* — naming an approval and a runtime decision in one sentence.

**Propagation, which is the actual harm.** `BRW-003-terrain.md:205-208` read the fixture and recorded
for BRW-004's benefit that *"a browser approval rides the **product approval** authority, which
already has a command and a bridge. That is BRW-004's, and recording it here saves BRW-004 a needless
Custodian ticket."* The Custodian conclusion is right; the authority is wrong. Acting on it would
have built BRW-004's approval half on the `approvals` table, which has **no `expiresAt`, no TTL and no
timeout of any kind** — making the acceptance clause "denial/**timeout** fails closed" unbuildable.
A false terrain claim propagating into a dependent ticket's design is the failure mode
`BRW-003-terrain.md`'s own CORRECTIONS section exists to prevent.

**Not live.** Nothing in production submits a `browser_request` job, so no wrong approval has been
raised. This is a design-time defect.

**Disposition (REVISED 2026-09-03, Codex review).** BRW-004 takes the code's side (design §2 D2).
The original disposition said slice (b) would express the guard's expectation as "the fixture's
`productApproval` spelling maps to the profile's runtime-decision authority." **That was wrong twice
over and is withdrawn.** (1) `tests/fixtures/distributed-execution/README.md` names *repurposing a
field* as a breaking change requiring a **new versioned directory**, so the mapping is not permitted.
(2) `control.productApproval` and `control.runtimeDecision` are separate enum fields, so mapping the
first would leave the second still reading `"none"` — the guard would have blessed the contradiction
it exists to detect.

The revised disposition: slice (b)'s guard binds both `control` fields to the shipped
`describeSourceGovernance` profile for every fixture **except a pinned historical-divergence list**,
and reports the pinned divergences as a SECOND always-printed verdict that never fails the gate.
(An earlier revision made the gate stay RED on `browser-approval-download.json`; that was withdrawn
on Codex re-review — a permanently-red required check is a check that gets deleted, and the CLI-008
Unit A precedent is a second verdict computed beside `ok`, not a red `ok`.) The pin records the
VALUE tuple, so a new contradicting fixture, or any change to the pinned one's `control` block,
turns the gate red. The real resolution is a **v2 fixture directory** with
`control` corrected, leaving v1 intact — a fixture-owner / Protocol Custodian decision, raised as
BRW-004 design §7 Q5 and **not** BRW-004's to take. This finding therefore stays open until that
decision is made, and **must not be closed by weakening the guard**.

**UPDATE 2026-09-04 — BRW-004 SHIPPED its half; the residual is UNOWNED.** Slice (b) landed the
guard (`scripts/check-distributed-execution-foundation.mjs`): every fixture's `control` block is now
bound to the shipped `describeSourceGovernance` profile, this divergence is pinned by VALUE TUPLE,
and an always-printed census names it and this finding on every `policy` run. A NEW fixture with the
same contradiction is RED; any change to the pinned fixture's `control` block is RED. Eight mutation
cases prove the gate can fire, and an anti-vacuity mutation — replacing the check with an empty
census — turns exactly those eight red and nothing else.

★ One correction to the design, made while building it: the guard's runtime-decision arm is narrower
than §3 slice (b) specifies. `control.runtimeDecision` is a 7-value SCENARIO enum spanning unrelated
mechanisms, while `RuntimeDecisionAuthority` has four members, so binding all seven is a category
error that would have red-lit three innocent fixtures on the first run. The arm binds `egress_denied`
and `budget_stop`; the other four are declared `unmodelled` with a written reason and censused.

What remains is not buildable by any E8 ticket. The resolution is a **new versioned fixture
directory** with `control` corrected, and no ticket in the programme owns the fixture corpus — the
README states the rule but names no authority who may create a v2. BRW-004 design §7 Q5 raised it;
BRW-004's result doc §1 re-escalated it unanswered. Ownership therefore moves to `unowned` with the
successor recorded as "none exists yet", rather than left pointing at a ticket that has shipped —
which is E4-F013's exact failure. Repoint when a fixture owner is named.

---

## E8-F002 — `agent_runtime_decisions` is the designated aggregate for `browser_request` and cannot hold a row for one

**Status:** resolved · **Owner:** BRW-004 (`epics/E8-browser-automation/tickets/BRW-004-result.md` §4, slice (d))
**Severity:** MED
**Filed:** 2026-09-03, by BRW-004 terrain mapping at `203853b3a`.

**What.** `describeSourceGovernance("browser_request")` designates
`aggregateKind: "agent_runtime_decisions"` (`job-approval-bridge.ts:176-182`). That table cannot
store a row for a distributed browser job.

`packages/db/src/schema/agent_runtime_decisions.ts:22-23`:

```ts
agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
runId:   uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
```

Both NOT NULL, both foreign-keyed to legacy tables. A `browser_request` job has no `agents` row and
no `heartbeat_runs` row — it has a `jobs` row, an attempt, a lease and a fence.
`RuntimeDecisionOpenRequest` (`job-approval-bridge.ts:226-228`) requires `agentId: string` and
`runId: string` for the same reason. The parity contract additionally permits
`founder | team_lead | team_member | agent` as a browser requester, so for three of the four there is
no agent to name even in principle.

**Why it looks fine.** The one end-to-end exercise —
`server/src/__tests__/job-approval-parity.integration.test.ts:146-171`, *"[runtime] browser_request:
a permission DENY resolves to an E1 result carrying deny"* — passes because it **manufactures** the
missing rows: a seeded `AGENT` constant, `await seedRun(runId)` before the call, and a synthetic
`adapterType: "claude_local"` for a browser session. The test proves the bridge's logic; it does not
prove a browser job can mint the aggregate, and nothing else tries.

**Not live.** `jobApprovalBridge` has zero production callers and is flag-gated off
(`AOA_DISTRIBUTED_EXECUTION_ENABLED` defaults false), and nothing submits a browser job. The failure
would surface on the first real browser approval.

**Disposition.** BRW-004 design §2 D2 relaxes both columns to nullable behind a
`(agent_id IS NULL) = (run_id IS NULL)` CHECK so the legacy pair stays all-or-nothing, and relies on
`job_projection_receipts` — which already carries `jobId`, `attemptId`, `sourceFence`,
`targetAggregateId` and is written fence-guarded by the bridge — for the distributed binding. Two
null branches follow: the bridge's request shape, and the timeout sweeper's `runCanceller`
(`server/src/index.ts:2116-2118`), which today would call `heartbeatService.cancelRun` on a null
`runId`. Rejected alternatives (minting synthetic `agents`/`heartbeat_runs` rows; a parallel browser
decision table) are costed in the design.

**RESOLVED, 2026-09-04, by BRW-004 slice (d)** — `packages/db/src/migrations/0272_browser_request_decision_binding.sql`
and `0273_trust_rule_agent_binding.sql`.

The named defect is fixed: both columns are nullable, `db:generate` emitted the DDL (nothing
hand-authored), and the all-or-nothing CHECK `(agent_id IS NULL) = (run_id IS NULL)` means no row
can be half-bound. Both null branches the disposition names are landed — the bridge's
`RuntimeDecisionOpenRequest` shape and the timeout sweeper's `runCanceller`.

★★★ The disposition named TWO null branches — the sweeper's `runCanceller` and "the bridge's
request shape". There were **TEN**, and three of the eight it missed were lethal: `createPrompt`'s
zombie-run guard and `answerPrompt`'s liveness gate both call `getRunStatus(...)`, which with a null
finds no row and reads that as "the run is terminal" — so the relaxation would have shipped an
approval feature that refuses every one of its own prompts at creation and rejects every answer,
with a completely green typecheck. The third granted too much instead of too little: see below. All
ten are closed and mutation-tested, each as a distributed/legacy PAIR so "correctly skipped" cannot
be confused with "accidentally disabled for everyone"; the full table is in the result doc §4.

★★★ **THIS RESOLUTION WAS PREMATURE WHEN FIRST WRITTEN, and said NINE.** The tenth was found by
adversarial review of PR #356 after this finding had already been marked resolved and the branch was
CI-green on 16 checks. It is the one hazard design §D5 predicted by name — *"the moment slice (c)
populates `networkTarget` … `allow_always` becomes reachable for browser egress"* — and slice (c)
DID land a §D5 refusal, in the GUEST (`classifyBrowserPermissionDecision`), which decides whether
the browser acts on a decision and not whether the control plane writes a trust rule. `answerPrompt`
mints the rule first. So `buildTrustRuleInsert` copied the newly-nullable `agentId` into
`agent_runtime_trust_rules` — whose own `agent_id` was nullable and, unlike its sibling declared
directly above it, carried NO check — and `trustRuleMatchesPrompt` read `rule.agentId && …`, making
an unbound rule a **wildcard in the AGENT dimension**: one founder answering "always allow this
browser session to reach example.com" would have authorised sessions they never saw.

★ Blast radius RE-DERIVED, not asserted. A match also needs equal `riskClass` and an exact
`networkScope`, and the browser seam emits `network_egress` + a URL ORIGIN while the CLI hook bridge
emits `network` + a bare HOSTNAME — so heartbeat prompts are out of reach TODAY by a two-clause
coincidence nobody designed, not by any guard. In reach: every other distributed browser prompt in
the company on the same adapter and origin, for 90 days, and forever for `allow_run` (`expiresAt:
null`). The fix is written on the BINDING rather than on the coincidence, because the coincidence is
one edited string away from disappearing.

★★ **The relaxation did not add the wildcard; it woke it up.** That clause was dead code while
`agent_runtime_decisions.agent_id` was NOT NULL, because the only production writer of the trust
table copies from it. Nothing in the ticket's diff is near `trustRuleMatchesPrompt`, and no test
could have gone red — *relaxing a column can promote unreachable code to reachable code somewhere
the diff never touches.*

Closed in three layers: `standingGrantBinding` refuses a standing grant for an unbound decision
(one call site; both builders take the narrowed `string` it returns, so the guard cannot be
bypassed), the matcher compares agents strictly, and migration **0273** makes
`agent_runtime_trust_rules.agent_id` NOT NULL — which turns the exact defect line into a `tsc`
error. **Not the sibling's check:** `(agent_id IS NULL) = (run_id IS NULL)` would reject every
persistent grant, because such a grant is agent-bound and run-less by design. Proven against real
Postgres (8/8, including the `23502` rejection) and re-appliable
(`migration-readiness.integration.test.ts` 4/4, the suite that caught 0272).

★ The second design-named branch (`RuntimeDecisionOpenRequest`, the bridge's entry point) was
initially MISSED BY THIS BUILD and surfaced only because the E4-F013 successor guard forced a
re-read of this disposition. Widening the service beneath an entry point is a silent no-op — a
widened parameter still accepts a narrower argument — so `tsc` stayed green while the relaxation was
unreachable through the only door that matters.

One of them is left in place deliberately and filed separately: `listStrandedAnswers`' INNER JOIN
excludes distributed decisions from the R2 sweep. The exclusion is correct; the sweep that should
replace it cannot exist before JOB-015. That is `E8-F004`.

★ Resolved on the MECHANISM, not on a writer. Nothing submits a `browser_request` job and
`jobApprovalBridge` still has zero production callers, so no distributed decision exists yet. The
finding said the aggregate *cannot hold a row*; it can now, and that is proven by 23 unit tests, 8
real-Postgres cases and 16 killed mutants (D1–D11 + E1–E5, counted from the result doc's log rather
than carried forward — this sentence said "13 tests and 8 killed mutants" while the log had grown
past it). The absence of a writer is BRW-004's own unbuilt scope (result doc §10), not this
finding's residual.

---

## E8-F003 — A Critical threat control is recorded as owned-and-delivered while its enforcement does not exist anywhere: sandbox egress is filtered at none of the three candidate points, and the cloud metadata endpoint answers from inside the guest

**Status:** open · **Owner:** `unowned`
**Severity:** HIGH
**Filed:** 2026-09-04, by BRW-004 slice (a), MEASURED against real E2B sandboxes in workflow run
`33857218680` (`.github/workflows/keyed-e2b-egress-constraint-probe.yml`).
**Re-verified 2026-09-04** at `da1a90597` by the E8-F003 disposition unit; **re-headlined, and the
machine-readable register entry repaired, 2026-09-05** after review. Every claim below was
re-measured rather than inherited. §7 states what changed on review — including a correction to
this unit's own first commit, which took a downgrade it said it had not taken.

### 0. CORRECTION, 2026-09-07 (W10A) — one of this finding's stated REASONS is unsupported. Its CONCLUSION is unchanged.

**Status, severity and ownership are NOT touched by this note**, and nothing below is a downgrade.
What changes is a premise, not a verdict.

§2 concludes *"§D3 option (b) — constrain egress at the provider — is **unavailable**, so the
in-sandbox enforcement point D3(c) is the ONLY layer rather than defence in depth."* The stated
ground for "unavailable" was the 2026-08-05 spec's §12 bullet, quoted approvingly in §5 below:
*"Managed-E2B egress is not fully lockable."* **That bullet is refuted as a CAPABILITY claim.**
Finding **`E8-F007`** measured the installed, lockfile-pinned `e2b@2.30.5` and found
`SandboxOpts.network` reaching the create body, `updateNetwork` for a running sandbox, and a
`getInfo()` read-back of the applied configuration. The provider layer therefore has a real,
shipped configuration surface that this finding recorded as absent.

**Three things this note does NOT say, stated so it is not over-read:**

1. **It does not close, weaken or reduce this finding.** §3's conclusion — *enforcement exists at
   NO layer* — is untouched and was measured independently at each of the three points. A
   capability that exists and is not called changes nothing about what runs.
2. **It does not say egress can be locked.** Whether the operator's E2B tier honours a `network`
   body is UNMEASURED. Nothing validates the body client-side (`buildNetworkEgress` is a
   passthrough; the only error path is HTTP status) and the API target is per-company configurable,
   so a tolerant or self-hosted server can return `200` and leave the sandbox unpoliced with
   identical code and identical logs. A read-back is mandatory before anyone relies on it.
   **★ SUPERSEDED 2026-09-07 (W11) — both halves of this item are now measured, and BOTH ARE
   WORSE than they read here. The tier does NOT honour a DENY-SPECIFIC `network` body — a
   `denyOut` list of CIDRs with no `allowOut` — (`E8-F008`, run
   `34085130892`): it accepts, validates and echoes the deny set and routes the denied traffic
   anyway. ★ NARROWED 2026-09-09 (W10B-B): this sentence read "does NOT honour a `network` body",
   which is a claim about ALL network bodies generalised from the one shape that was tested. The
   default-deny-plus-`allowOut` construction E2B documents as the fine-grained control is
   UNMEASURED — the arm is built. **★★ ATTEMPTED TWICE 2026-09-09 (runs `34328502574`,
   `34328780645`) AND STILL UNMEASURED:** both dispatches returned `UNRUN — arm-was-never-created`
   because `Sandbox.create` failed to place that body (`500: Failed to place sandbox … please
   retry`) while the policy and anti-vacuity arms placed seconds apart on the same template. **The
   sandbox never existed, so nothing about the allowlist shape's enforcement was observed —
   `UNRUN` is not `INERT`.** The honest statement of the new fact is that *the documented shape
   reproducibly fails to place at this tier, cause unknown*; it is not a refusal (contrast the IPv6
   arm's `400: invalid denied CIDR`, which is) and not transient (it reproduced, with successful
   siblings). `E8-F008` §8 and `W10B-egress-enforcement-result.md` §14 are the record.
   **Unmeasured is not "probably works":
   `DE-08` stays `not-delivered` and no production path passes a `network` body.**
   And the read-back this item calls mandatory PASSES on that sandbox — it was specified
   against a tolerant server that IGNORES the field, and this tier does the opposite. Do not
   cite "a read-back is mandatory" as a safeguard without reading `E8-F008` §3. The conclusion
   of the item — that this note does not say egress can be locked — stands more firmly than
   when it was written.**
3. **It does not move §2's measurement.** The probe measured `metadata.egressAllowlist`, which is
   what AoA actually sends. That result stands exactly as recorded: a `metadata` string is inert,
   and the SDK never claimed otherwise.

**What it does change for the disposition.** "Option (b) is unavailable" must now be read as
*"option (b) is UNADOPTED, and whether the operator's tier honours it is unmeasured"*
**— CORRECTED AGAIN 2026-09-07 (W11): it is now MEASURED for the deny-only shape, and the tier
does not honour that one
(`E8-F008`; the full census is §8). "Back on the table" below is therefore withdrawn: the
provider layer is available to DECLARE and, in the shape that was measured, unavailable to
ENFORCE at the tier AoA's key reaches. ★ NARROWED 2026-09-09 (W10B-B) — "does not honour it"
generalised one measured shape to the whole surface. The measured shape is `denyOut` with no
`allowOut`; the default-deny-plus-allowlist shape E2B documents is UNMEASURED, and that is a gap
in the record rather than a reason for hope: nothing is adopted, `DE-08` stays `not-delivered`.
★ **The gap has since been ATTEMPTED and is still a gap** — two dispatches on 2026-09-09
(`34328502574`, `34328780645`) both failed to place that arm's sandbox and returned `UNRUN`, no
verdict. Reading that as "unavailable to ENFORCE" would be exactly the error this narrowing exists
to correct: **UNRUN is not INERT**. `E8-F008` §8.
AND THE SENTENCE BELOW IS ALSO NARROWED: D3(c) (= BRW-004 slice (f)) is still the only REMAINING
CHARTERED enforcement point — "REMAINING" inserted 2026-09-07 (W16A-FIX): DAT-005 and DSK-002 were
also chartered over this capability and shipped without it, which **§1 of this same finding already
says of DAT-005** ("whose chartered outcome … was to *Enforce* default-deny … and whose result doc
reads `Status: COMPLETE`"), so an absolute "only" contradicted this finding's own headline
(derivation: `scripts/gate-clause-wiring.json` → `E5-6-denied-egress`) — but
§8 measures that it is not a BOUNDARY — every in-guest mechanism is agent-writable, and Node's
global `fetch` ignores every proxy variable on the `node:22` image AoA runs. "The only layer that
exists today" must not be read as "a layer that would work". Nothing is left standing; read §8.**
D3(c) is
still the only layer that exists **today**, but the reason is a build gap, not a missing capability
— and defence in depth at the provider is back on the table for whoever takes ownership. Do not
cite the §12 bullet as a reason for anything without reading `E8-F007` first.

### 1. ★★★ The headline: four programme records state this control as fact, and one is a Critical crossing whose sole owner has already shipped

This is what the finding is *for*. The measurement (§2–§4) is the evidence; **the misrepresentation
is the defect**, and it outranks the disposition question this unit was opened to answer.

**1. `docs/architecture/distributed-execution-threat-controls.json`, `DE-08`, severity `Critical`.**
Its `failureMode` is *"a workload reaches cloud metadata or the control plane"* — **which is
literally what §2 measured happening**. Its clauses are written as statements of fact:
`confidentiality` = *"internal metadata and control-plane ranges are unreachable"*; `authorization`
= *"default-deny; only allowlisted destinations are permitted"*; `integrity` = *"blocked IP/DNS
ranges cannot be reached via rebinding"*; `trustedSide` = *"filtered egress and a
credential-injecting proxy"*. Its **sole** `ownerTickets` entry is **DAT-005**, whose chartered
outcome (`program-design.md:726`) was to *"**Enforce** default-deny destination policy through the
fence-aware egress path, block private/metadata/control-plane ranges and direct bypass"* — and
whose result doc (`DAT-005-result.md:3`) reads **`Status: COMPLETE`**.

> **A Critical control whose owner column is exhausted, whose enforcement does not exist at any
> layer, and whose record carries no field able to distinguish *required* from *delivered*, is a
> live misrepresentation of this programme's security posture.** Nothing in the JSON is marked
> pending, deferred, or planned; a reader — human, or the `REL-001` release gate the record itself
> names as its `releaseTest` — has no way to tell it apart from a control that is genuinely
> enforced.

**2. `docs/replatform/program-design.md:149`, under a heading reading "Security invariants":**
*"Sandbox egress is default deny. Metadata endpoints, RFC1918 destinations, worker-host control
ports, and the AoA data plane are denied unless explicitly required."* `:146` adds *"Every governed
or metered external effect uses a fence-aware egress proxy…"*. It sits in a list beside invariants
that **do** hold (non-owner role plus forced RLS; secret handles, not plaintext secrets, in job
envelopes). Nothing in the section distinguishes an invariant that is enforced from one that must
still be built.

**3. `docs/architecture/distributed-execution-threat-model.md:121`, "Residual risks and release
exclusions"** — the one place in the programme where an unmitigated Critical would be disclosed —
**omits DE-08, while listing a sibling egress exclusion** (*"Unvalidated gVisor bridge egress"*,
`:129`). A reader is entitled to infer from that asymmetry that this one is covered. The section's
own preamble says the items it lists *"are not mitigated by the controls above"*, which places
everything absent from it on the mitigated side.

**4. `epics/E5-workspaces-secrets/qa/2026-08-24-d0-e5-exit-gate-audit-a1.md:36`** grades the E5
exit-gate clause **"denied egress"** as one of only **two** clauses `proven_in_d1` — the strongest
grade the audit issues, in an audit whose own thesis is that most clauses are graded too generously.
Its basis is `tests/d1/e6f-08-egress-isolation.test.mjs`, which proves unreachability of *the
identical targets* — `169.254.169.254`, ECS metadata, private ranges, an arbitrary public address —
by **docker-compose `internal: true` network segmentation around a container analog** (`worker-a`
plus `fake-provider`). It never touches `createFenceAwareEgressProxy`, `classifyEgressDestination`,
or the real provider. **The same words name two different subjects, and on the real one the result
is the opposite.**

**The line is sharp, and it is worth stating precisely:** the layer that *runs today* never claimed
this — the deployed `cloud_auth` spec discloses the gap in writing, and every producer comment and
ticket-level doc is honest (§5), and the measurement CONFIRMS them. The layer that *claims* it is
the distributed programme, four times. **Confirms at the layer that runs; contradicts at the layer
that claims.** That the claiming path is default-off is why this is a finding and not an incident —
a reason with an expiry date, because it holds only while distributed execution stays off, and the
record's own `releaseTest` is chartered to turn it on.

### 2. What was measured, and how

BRW-004 design §D3 option (b) and §7 Q2 both rest on a question terrain §12 recorded as
unestablished: can the sandbox provider constrain a sandbox's outbound egress at all? The probe
answers it differentially — sandbox **A** created with `metadata.egressAllowlist = "example.com"`
(production's exact spelling, `sandbox-provider-runtime.ts:785-789`), sandbox **B** with none — and
runs the identical target set from inside each guest.

| target | role | A (allowlist declared) | B (control) |
|---|---|---|---|
| `https://example.com/` | positive control | REACHED 200 | REACHED 200 |
| `https://api.github.com/` — **NOT allowlisted** | **the question** | **REACHED 200** | **REACHED 200** |
| `http://169.254.169.254/latest/meta-data/` | observation | **REACHED 401** | **REACHED 401** |
| `https://…invalid/` | apparatus control | FAILED (curl 6) | FAILED (curl 6) |

Both controls held: the allowlisted host succeeded (so the run is not a total-failure artefact) and
the RFC-2606 `.invalid` host failed (so the instrument can observe a failure). This is the third
run; runs `33855470353` and `33856090430` were reported INCONCLUSIVE by the apparatus control and
no verdict was taken from either. The per-run record, including both inconclusive runs and what
each fixed, is `.github/keyed-e2b-egress-constraint-trigger`.

**The metadata row is a second measured finding in its own right, not a footnote to the first, and
the status code is the whole point.** `169.254.169.254` returned **HTTP 401** — not a timeout and
not a connection error. That is an IMDSv2 token challenge: a **live metadata service answering**,
not a dropped packet. It answered in **both** arms. So only IMDSv2's token requirement stands
between sandboxed, agent-authored code and that endpoint. **This half is broader than E8**: every
workload in a sandbox shares the reachability, not only browser sessions — which is why a successor
scoped to browser sessions alone would not close it.

**Consequence for BRW-004's design.** §D3 option (b) — constrain egress at the provider — is
**unavailable**, so the in-sandbox enforcement point D3(c) is the ONLY layer rather than defence in
depth. A browser induced to reconfigure its own proxy is contained by nothing else.
**★ CORRECTED 2026-09-07 — read §0 first: "unavailable" was grounded in a capability claim that
`E8-F007` refutes. The correct reading is UNADOPTED-and-unmeasured, not absent. D3(c) being the
only layer today is unchanged; the reason for it is not.**

### 3. There is no enforcement layer at ANY of the three candidate points

Each point was measured separately, at this SHA.

1. **Provider level — MEASURED INERT.** §2. A host absent from the declared allowlist was reached
   from inside the sandbox that declared it, identically to a control sandbox that declared none.
2. **In-sandbox — UNBUILT.** BRW-004 §D3 option (c) is the chosen enforcement point and is slice
   (f). `BRW-004-result.md:15` and `:99` record slices (f)–(h) as not attempted, and `:366` books
   the acceptance condition *"allowed domains … are enforced"* as `deferred`.
3. **Proxy — ZERO PRODUCTION CALLERS.** `classifyEgressDestination` (`egress-policy.ts:228`) is
   correct, ranks `metadata` as the highest-precedence deny class (`NETWORK_DENIAL_CLASSES`,
   `:69-74`), and is dual-driven in the always-on `policy` lane against two committed fixture
   corpora. Its **only** non-test consumer is `createFenceAwareEgressProxy`
   (`egress-proxy.ts:146,239`) — and `egress-proxy.ts` is imported by exactly one file in the
   repository, the integration test `server/src/__tests__/egress-proxy.integration.test.ts:29`. Two
   production comments assert the same independently (`routes/worker-control.ts:160`,
   `services/execution-secret-resolve.ts:7`). The chain is unreachable from boot: the classifier's
   only route into production is a module nothing imports.

**So the classification exists and the enforcement does not — at any layer.** What that blocks is
therefore not a build task. It is THE CLAIM (§1) that sandbox egress is constrained.

### 4. The producer seam, traced end to end

Both production sites compute the allowlist and pass it into a real acquire — verified at this SHA,
not quoted: `heartbeat.ts:4448` (org runs) and `internal-agent/aoa-agents/runner.ts:714` (crew runs)
call `loadConnectorEgressHosts` and hand the result to `acquireExecutionContext` as
`egressAllowlist` (`:4490` and `:724`). It is forwarded verbatim through
`acquire-execution-context.ts:76` → `environment-runtime.ts:575` →
`environment-run-orchestrator.ts:331` and lands in exactly three places, **all of which record and
none of which enforce**: the E2B `Sandbox.create` call's `metadata` as a comma-joined string
(`:787-789`), our own lease-metadata row (`buildE2bLeaseMetadata`, `:621`), and the fake provider's
metadata (`:385`). There is no fourth consumer. The comment at the E2B site says so itself —
*"S4 — best-effort managed recording only"*.

### 5. The other side of the line — where the gap IS disclosed, honestly

The measurement **confirms** every one of these; none is contradicted, and none is the defect in §1.

- **The producer comments.** `mcp-connectors-env.ts:59-66`: the allowlist is *"NOT a security
  boundary … advisory, managed-E2B-best-effort"*. The probe measures that they are right, rather
  than quoting them.
- **The deployed system's own spec.** `docs/aoa/plans/2026-08-05-cloud-execution-isolation-e2b-spec.md`
  §12, first bullet: *"Managed-E2B egress is not fully lockable. On managed E2B, sandboxes get
  fairly open egress; the 'allowlist' (Q2) may be closer to open in practice there."*
  **★ The first sentence of that quotation is REFUTED as a capability claim — `E8-F007`, and §0
  above. The rest of the bullet, and this section's point that the deployed layer is honest about
  what it enforces, are unaffected: what is inert is `metadata`, which is what AoA sends.** Its §9
  **Security invariants** list contains **no egress invariant at all**, and Q2's rationale (§3)
  calls the choice *"not a cross-tenant control (data plane owns that)"*. Nothing at the deployed
  `cloud_auth` layer represents egress as a security boundary, so the measurement breaks no promise
  there.
- **Every ticket-level document.** `DAT-005-result.md:14` records its own outbound channel as the
  inert E4-D12 seam; `DSK-001-lane-B-design.md:20-31` states the zero-caller fact up front and calls
  it the plan rather than an oversight; `DSK-002-result.md:161-163` explicitly refuses to report
  `sandbox.filtered_egress` because *"neither Docker's default bridge nor a bare OS sandbox filters
  egress"*.

### 6. A correction to the record — the guard that should have kept this visible had gone silent

The triage that opened this unit stated that the zero-caller status is evidenced in part by the
symbol's *"presence in the repo's own unprovable-clause inventory"*. At `da1a90597` that was **not
true of the live register**: `scripts/gate-clause-wiring.json` had stopped tracking the egress path
entirely, because DAT-008 slice 5 re-pointed clause `E5-5`'s symbol from `createFenceAwareEgressProxy`
to `synthesiseRunSecrets` — correctly for its own purpose, since Direction A never uses the egress
proxy, but the clause it was standing in for went with it. Only the library **header**
(`scripts/lib/gate-clause-wiring.mjs:9`) still named the symbol, as prose. So between that re-point
and this finding, the guard whose entire purpose is to make "declared working, nothing calls it"
impossible reported nothing about the one capability that was in exactly that state.
Fixed in the same branch: re-enrolled as `E5-6-denied-egress` → `unwired`, mutation-proven to go red
if it is ever flipped to `wired`, and now printed in the DORMANT line on every green run.

### 7. Disposition — HIGH is unchanged; and a correction to this unit's own first commit

**The severity does not move, and the reason is positive rather than an absence of evidence.**
Everything found since filing **raises** the case: three enforcement points instead of one measured
absent (§3); four programme records asserting the control (§1), one of them rating the exact
measured event `Critical` with an exhausted owner; and the mechanism that would have kept the gap
visible had itself gone silent (§6). The nearest thing to an argument for a downgrade — "the
claiming system is default-off" — is a statement about the *reachability of the claim*, not about
its truth, and it is already the reason this is filed rather than escalated.

**★ A downgrade was nevertheless taken, and this corrects it.** Commit `2e548fdae` on this branch
rewrote `scripts/finding-ownership.json`'s `E8-F003` entry and, in doing so, **dropped the entire
second measured half** — the metadata endpoint answering `401` from inside the guest, IMDSv2 as the
only remaining barrier, and the "broader than E8, every sandboxed workload" scope — from both
`reason` and `successor`, while that commit's own message asserted *"Nothing supports a downgrade,
so none is taken."* The `Severity` field never moved, so no guard could see it: **the register entry
had silently become weaker than the prose it indexes, which is a downgrade by subtraction.** Both
halves are restored, and the entry now leads with the §1 misrepresentation. The rule this cost:
*a machine-readable entry must never be weaker than the prose beside it, and a claim about a diff is
part of the deliverable and is reviewed like the diff.*

**Scope, stated so it is not over-read.** This measures the seam AoA production actually uses. It
says nothing about an E2B capability AoA does not call; it does not establish that the metadata
endpoint is **exploitable**, only that it is reachable and answering; and the `169.254.169.254`
service belongs to the **provider's** infrastructure, so what it would yield to a token-bearing
caller is unmeasured. Nothing here asserts a cross-tenant breach: the deployed blast-radius reframe
(spec §9) is untouched.

**Why `unowned`, and what it blocks.** No ticket in the roster is chartered to wire egress
enforcement for the path that was measured. BRW-004 slice (f) is real, open (`gate_review`) and the
only **remaining** chartered candidate (word inserted 2026-09-07, W16A-FIX — this same paragraph
names the two earlier charters, DAT-005 and DSK-002, below, so "only" was never meant absolutely)
— but it is scoped to browser sessions, and the measurement is of org
heartbeat runs and crew runs, neither of which is a browser session; and the metadata half (§2) is
broader still, since every sandboxed workload shares the reachability. The two tickets that *were*
chartered to reach this path have both shipped without it and said so: DAT-005 (COMPLETE) and
DSK-002 (`…mediate device-local handles through the DAT-004 broker plus fence-aware egress path`).
Naming either as the successor would be filing against a closed ticket; naming a new one would be
inventing an owner. So this stays `unowned` **with a reason saying what it blocks**: until an
enforcement point exists, `program-design.md:149`, DE-08's `confidentiality`/`authorization`/
`integrity` clauses, and the E5 gate's "denied egress" clause **cannot be asserted of the real
provider**, and DE-08's own record cannot distinguish that from delivery. **Repoint it when a ticket
takes egress enforcement for the sandbox path — not for the browser path alone, and not for the
egress half alone. Do NOT close it by citing `classifyEgressDestination`, the `policy`-lane vectors
gates, or `e6f-08`: the first two exercise a pure function no production path reaches, and the third
measures a docker network, not a sandbox.**

### 8. 2026-09-07 (W11) — THE CANDIDATE-LAYER CENSUS IS NOW CLOSED: every enumerated layer is refuted, and each row says on what

**Nothing above changes.** Status, severity, ownership and §3's conclusion are untouched. This section
extends §3's three-point census to the two candidates raised since — the provider `network` surface
(§0, still an open question when §0 was written) and the fail-closed-on-no-policy design — and states
an evidence class for every row. **The heading says "refuted", not "measured": rows 1 and 2 are
measurements against real infrastructure, row 3 is mixed, row 4 is structural and row 5 is derived.**
Collapsing those into one word is how a census stops being trustworthy. It proposes and builds nothing.

`E8-F008` (HIGH, open, `unowned`) records workflow run
[`34085130892`](https://github.com/MeteoriteLabs/AoA/actions/runs/34085130892) at `ab23eabdc`: a
sandbox declaring `denyOut: ["169.254.0.0/16", …]` **reached `169.254.169.254` (401)** identically to
an anti-vacuity sandbox that denied a different range, while `getInfo()` returned the declared deny set
**exactly**. All four controls held and the ABANDON condition did **not** fire, so the failure is
genuine inertness rather than an experiment that broke itself.

**The census, with the evidence class for each row stated so the strong and the weak are not mixed.**
★ **AMENDED 2026-09-09 (W10B-B): row 2 was SPLIT.** As written it named the provider `network`
surface as one candidate and refuted it on run `34085130892` — but that run measured a `denyOut`
CIDR list with **no `allowOut`**, and E2B documents a different construction (default-deny plus an
allowlist) as the fine-grained control. One shape was measured; the row spoke for both. The
measured half keeps its verdict unchanged; the unmeasured half is now its own row, marked
**UNMEASURED**, which is neither a refutation nor a candidate anyone is pursuing.

| candidate layer | verdict | how it was established |
|---|---|---|
| **1. Provider — `metadata.egressAllowlist`** (what AoA actually sends) | INERT | §2. MEASURED, real E2B, run `33857218680`, both controls held. |
| **2. Provider — `network.denyOut` / `updateNetwork`, DENY-ONLY** (a `denyOut` CIDR list with no `allowOut`; the surface `E8-F007` found and AoA has never called) | ACCEPTED, VALIDATED, ECHOED, **INERT** | MEASURED, real E2B, run `34085130892`. `E8-F008`. |
| **2b. Provider — default-deny + `allowOut` allowlist** (`denyOut: ({allTraffic}) => [allTraffic]` plus an allow list — the construction E2B's own docs present as the fine-grained control, and the only one that supports domains) | **INERT — MEASURED 2026-09-11** (FULLY inert: metadata `169.254.169.254` REACHED 401, and `9.9.9.9`/`registry.npmjs.org` were reached-then-broke — no egress blocked) | ★★★ MEASURED 2026-09-11, run [`34528397309`](https://github.com/MeteoriteLabs/AoA/actions/runs/34528397309) (ref `e2b-cidr-only-probe` @ `8f2c2b7d8`, template `aoa-base`), CIDR-only body `allowOut: ["8.8.8.0/24","1.1.1.1"]`. The arm PLACED (sandbox `ipm63v4ubgmzbik13v653`) — dropping the hostname routed it down the plain-iptables path, per §7's `validateEgressRules` insight. `getInfo()` echoed the policy back exactly (probe b=YES). The shape blocked NO real destination's egress: `9.9.9.9` and `registry.npmjs.org` both returned `curl 35`, which per the probe's own `CURL_EXIT_MEANINGS`/`classifyReachEvidence` is **post-connect = reached-then-broke** (the connection was MADE and broke after → reached, not refused — a Codex P2 on PR #425 caught this being misread as "blocked"); the only non-reach was the `.invalid` apparatus control (DNS name-resolution, not an egress block). **The metadata endpoint `169.254.169.254` LEAKED (REACHED 401)**, and `updateNetwork` on a warm resume left it reachable (d=no). Verdict INERT — denied-destinations-still-reachable. **The provider `network` surface is now closed on BOTH constructions** (deny-only, row 2, and this allowlist), on measurement rather than inference. `DE-08` stays `not-delivered`; nothing here is evidence of delivery. `E8-F008` §9, `W10B-egress-enforcement-result.md` §15. **History, preserved:** ★ ADDED 2026-09-09 (W10B-B). Row 2 was being read as covering this, which it does not: it tests the opposite construction. The arm is BUILT (`keyed-w10b-egress-enforcement-probe.test.ts`, arm `A/allowlist`; runbook §13). ★★ **UPDATED same day: DISPATCHED TWICE** — runs `34328502574` and `34328780645`, three minutes apart, both `UNRUN — arm-was-never-created`. `Sandbox.create` failed to place the body (`500: Failed to place sandbox … please retry`) while the policy and anti-vacuity arms placed seconds apart on the same template, so **the documented shape reproducibly fails to place at this tier** (cause unknown; not a validation refusal — contrast the IPv6 arm's `400: invalid denied CIDR` — and not transient). **The sandbox never existed, so this row is still UNMEASURED and must NEVER be read as INERT.** `E8-F008` §8. **This row does not soften the census.** An unmeasured candidate is not a promising one — nothing in the product passes a `network` body, `DE-08` reads `not-delivered`, and E8-F008 §6.2 already recorded that reasoning from the deny result to the allow shape is "an argument, **not a measurement**". |
| **3. In-guest** — a proxy, or anything the login shell can reach | NOT A BOUNDARY against this workload | **MIXED, and the weakest row here — read the note below it.** Proxy half: REPRODUCED locally (see ★). Shell half: STRUCTURAL — `buildE2bLoginShellScript` (`sandbox-provider-runtime.ts:647-655`) sources `/etc/profile`, `$HOME/.profile` and `$HOME/.bashrc` from an **agent-writable** home before `exec env … claude`, so anything the guest can edit, the agent can edit. |
| **4. Control-plane deny** — `classifyEgressDestination` / `createFenceAwareEgressProxy` | INSPECTS ZERO PACKETS | STRUCTURAL, by caller count: §3 point 3 — `egress-proxy.ts` is imported by exactly one file in the tree, an integration test. A classifier the sandbox's traffic never traverses cannot deny anything, whatever it computes. Tracked as `E5-6-denied-egress` → `unwired` in `scripts/gate-clause-wiring.json`, printed on every green run. |
| **5. Fail-closed on "no policy applied"** — refuse to run a sandbox whose egress policy could not be applied | **DISSOLVED** | DERIVED from row 2, and marked as derivation rather than measurement: the discriminator such a design would branch on is the read-back, and the read-back **passes** on an unpoliced sandbox (`E8-F008` §3). There is no observable that separates "policy applied" from "policy stored and ignored", so there is nothing for a fail-closed branch to test. |

> **★ THE PROXY HALF'S PROVENANCE, STATED RATHER THAN INHERITED — and this row is the reason the
> census labels every row by evidence class.** `W10B-egress-enforcement-runbook.md` §8 and the keyed
> pack's header both assert that Node's global `fetch` *"ignores every proxy environment variable —
> measured, with the proxy port never contacted and the request returning 200"*. **Neither cites a run
> id, an artefact or a test**, and a grep of the tree finds no other record of it. Writing this census
> is what surfaced that: it was about to be booked as MEASURED on an assertion, which is the exact
> move `E8-F007` exists to record the cost of.
>
> **What I did instead of inheriting it.** Reproduced the mechanism directly, W11, 2026-09-07: two
> loopback HTTP servers, `HTTP_PROXY` + `http_proxy` + `ALL_PROXY` all pointed at the first, one
> `fetch()` to the second. Result: **status 200 from the origin, proxy contacted 0 times.** So global
> `fetch` does not consult those variables — which is expected (undici honours a proxy only through an
> explicit `ProxyAgent`/`setGlobalDispatcher`), and is now recorded rather than assumed.
>
> **The honest limit:** that reproduction ran on **Node v24.14.0 on Windows**, not on the `node:22`
> guest of the `aoa-base` image. It establishes the MECHANISM; the guest-side claim is still
> inherited, and the row is labelled MIXED for that reason and not promoted. It would not change the
> census either way — the shell half alone already makes an in-guest mechanism agent-editable — but a
> reader is entitled to know which half is which.
**★ Read this before proposing another.** Rows 1, 2 and 3 are measurements against real infrastructure;
rows 4 and 5 are structural and derived respectively, row 2b is UNMEASURED, and each is labelled that
way on purpose. The
programme has now spent four units arriving here, and the recurring error each time was to propose the
next layer without measuring the last one. **If another candidate is proposed, the first question is
what packet would demonstrate it, and the second is what the positive control is** — not what the API
accepts, not what a read-back returns, and not what a classifier computes.

★★ **And row 2b is the same error in its OTHER direction, caught in this census rather than in a
build.** Row 2 was written as a refutation of "the provider `network` surface" and was cited that way,
when what was measured was one construction of it. Widening a measurement to the surface it was taken
on is how a census stops being trustworthy — the same move, one level up, as calling a structural
argument a measurement. **The correction is a narrowing of the CLAIM, not a softening of the
CONCLUSION:** nothing is enforced anywhere today, no production path passes a `network` body, and
`DE-08` reads `not-delivered`.

**What this does NOT do.** It does not close or downgrade this finding; it does not change `DE-08`'s
`deliveryStatus`, clause text or scope — that record still reads `not-delivered`, which remains
correct and is now supported by one more measurement. **What to do about a `Critical` control that
cannot be enforced at any available layer is a founder decision that has not been taken.** Recording
the facts that inform it is this section; taking it is not, and no successor here pre-empts it.

### ★★★ MEASURED 2026-09-11 (CIDR-only probe) — census row 2b is no longer a gap; the provider layer is closed on BOTH constructions

The one UNMEASURED row in the §8 census has been measured. Run
[`34528397309`](https://github.com/MeteoriteLabs/AoA/actions/runs/34528397309) (ref
`e2b-cidr-only-probe` @ `8f2c2b7d8`, template `aoa-base`, 2026-09-10) dispatched the allowlist arm
with the CIDR-only body `allowOut: ["8.8.8.0/24", "1.1.1.1"]` — the one-thing-at-a-time fix (drop
the hostname) prescribed after the two 2026-09-09 `UNRUN` dispatches. **It PLACED** (sandbox
`ipm63v4ubgmzbik13v653`; the hostname-free body routes down the plain iptables path rather than the
tcpproxy L7 path that `500`d before), `getInfo()` echoed the policy back exactly, and the arm's
verdict is **INERT — denied-destinations-still-reachable**: `9.9.9.9` and `registry.npmjs.org` both
returned `curl 35`, which per the probe's own `CURL_EXIT_MEANINGS`/`classifyReachEvidence` is
**post-connect** (the connection was MADE and broke after) → **reached-then-broke = reached, not
blocked**, and the metadata endpoint `169.254.169.254` **LEAKED (REACHED 401)**, with `updateNetwork`
on a warm resume leaving it reachable. The arm blocked no real destination's egress at the
connection layer; the only non-reach was the `.invalid` apparatus control, a DNS name-resolution
failure, not an egress block.

**The honest reading is FULLY INERT.** An earlier draft read `curl 35` as "blocked ordinary public
egress" — a misinterpretation a Codex P2 on PR #425 caught: post-connect exits cannot support a
"blocked egress" claim. There is **no** real partial capability here. The shape does **not** deliver
`DE-08`, whose confidentiality clause is specifically about the internal
metadata/control-plane range, and that range is exactly what leaked. **The consequence for this
census:** the provider `network` option is now closed on **both** the deny-only shape (row 2,
measured `34085130892`) **and** the documented default-deny + `allowOut` allowlist shape (row 2b,
measured `34528397309`) — on measurement, not on the inference §6.2/§8 were careful never to claim.

**This does NOT close or downgrade E8-F003, and does not move `DE-08`.** `deliveryStatus` stays
`not-delivered`; the clause text, scope and severity are untouched; this is one more measurement
supporting the same conclusion. The enforcement gap stands, and it now stands with **no available
provider-level control at this tier** on either construction. `E8-F008` §9,
`W10B-egress-enforcement-result.md` §15, runbook §13.8.

**See also (does not move this finding):** the measured enforcement question is now written up as a
founder decision-request — `docs/replatform/DECISION-REQUEST-de08-sandbox-egress.md`. That paper
proposes options and a recommendation and takes no ruling; it moves no `deliveryStatus` and edits no
clause here.

**★ RULED 2026-09-11 (founder) — the disposition question this finding raised is now settled; the
finding is NARROWED, not closed.** The founder ruled options **1 + 3 + 4** of
`DECISION-REQUEST-de08-sandbox-egress.md`: DE-08's confidentiality/authorization/integrity/control
clauses are amended so confidentiality at the **managed-shared** tier is carried by the **credential
taxonomy** (host/operator/cross-tenant secrets never enter the VM; blast radius = one company's own
data and own provider key), NOT by provider egress denial; and the existing threat-model residual
entry (`distributed-execution-threat-model.md`, "Residual risks and release exclusions") is RATIFIED
as the terminal, disclosed exclusion at that tier, so `REL-001` gates on it as an accepted residual
rather than an absent control. **What the ruling SETTLES:** the standing "what to do about a Critical
control that cannot be enforced at any available layer" question (§8) — at the managed-shared tier the
answer is a disclosed, scoped release exclusion. **What STAYS OPEN, and why this finding is not
closed:** (1) egress denial is still **required at the self-hosted/tenant-hosted boundary**, and no
owner ticket names that enforcement test; (2) the confidentiality guarantee now **RESTS ON** the
credential taxonomy's airtightness, which is load-bearing and unverified — filed as follow-up
`E8-F012`; (3) the enforcement gap itself is **conceded, not fixed** — `deliveryStatus` stays
`not-delivered`, severity stays HIGH here and Critical on the crossing. The census (§8), the clause
`deliveryStatus`, and every measurement are untouched; this note records a disposition, not a new
measurement.

---

## E8-F004 — A distributed runtime decision has no stranded-answer sweep, and the exclusion is invisible

**Status:** open · **Owner:** `unowned`
**Severity:** LOW
**Filed:** 2026-09-04, by BRW-004 slice (d) while closing E8-F002.

**What.** `listStrandedAnswers` (`server/src/services/agent-runtime-decisions.ts`) is an INNER JOIN
on `run_id`. Now that `run_id` is nullable, every distributed decision is silently excluded from the
R2 stranded-answer sweep wired at `server/src/index.ts`. There is no type error, no runtime error and
no wrong row — a hole, not a crash, which is why it needed measuring rather than typechecking.

**The exclusion is correct; the absence it leaves is not recorded anywhere else.** That sweep exists
to catch an answer whose HEARTBEAT RUN went terminal before the in-band relay could deliver it. A
distributed decision has no heartbeat run and no in-band relay, so the sweep has nothing to say about
it. The join is therefore left as a join.

**But the equivalent does not exist.** Noticing that a job/attempt went terminal before its queued
`runtime_decision_result` was delivered has no implementation. It cannot have one yet: no
control-plane hop delivers a control command to a running worker at all (BRW-004 terrain §4), so
there is no delivery to be stranded from. The sweep belongs beside **JOB-015**'s delivery hop, not in
front of it.

**Not live.** Nothing submits a `browser_request` job and the bridge has no production callers, so no
distributed decision exists to be stranded.

**Disposition.** Repoint to JOB-015, or to whichever ticket lands the distributed delivery path, once
one exists. Do not close it by deleting the join — the join is right; the missing sweep is the gap.

---

## E8-F005 — Nothing in CI compares the Drizzle schema to the migrations, so a narrowing can be silently reverted

**Status:** open (NARROWED) · **Owner:** unowned (see `finding-ownership.json`)
**Severity:** MED

> ★ **NARROWED 2026-09-11 — the gate landed and covers ONE of the two directions.** The
> schema↔migration drift gate (`scripts/check-schema-migration-drift.mjs`) ships in the `migrations`
> job and now catches the **schema-vs-snapshot** direction: the measured BRW-004 mutation E5 (reverting
> `agentRuntimeTrustRules.agentId`'s `.notNull()`) is caught red-when-removed (proven: with the source
> mutation the gate compiles the schema first and emits
> `ALTER TABLE "agent_runtime_trust_rules" ALTER COLUMN "agent_id" DROP NOT NULL`, exit 1). But
> `drizzle-kit generate` diffs the compiled schema against the meta **snapshot**, not against the
> committed SQL, so the **SQL-file-tampering** direction is STILL UNDETECTED: an edited or gutted
> committed migration file, while the schema and the meta snapshot both stay unchanged, produces no
> delta and passes the gate (measured: emptying a committed `0279_*.sql` → exit 0). Catching that
> requires APPLYING the SQL to a real database and introspecting the result — a DB-backed check, a
> distinct and heavier class that would break this gate's deliberate DB-free / policy-lane property.
> **E8-F005 stays OPEN on that residual** (the SQL-tampering direction), narrowed to it; the
> schema-ahead half is done. Original resolution note preserved below for the covered half.
>
> ★ **Covered half — the schema↔migration drift gate.** `scripts/check-schema-migration-drift.mjs`
> is now a step in the `migrations` job of `.github/workflows/pr.yml` ("Schema↔migration drift gate
> (E8-F005)"), with its decision logic + wiring proven by `scripts/check-schema-migration-drift.test.mjs`
> ("… self-test"). The check is the class-wide regenerate-and-diff the Disposition demanded, NOT a
> per-column pin: it copies the committed `src/migrations` (SQL + meta) into a throwaway scratch dir,
> runs `drizzle-kit generate` against it (DB-free — no database is contacted), and FAILS on any new
> migration file, because `generate` emits one only when the compiled schema diverges from the latest
> meta snapshot.
>
> **C14-safe by construction (CLAUDE.md rule 1 / Decision #122).** The assertion is schema-vs-SNAPSHOT
> emptiness. Hand-appended idempotency guards + data backfills (0189, 0195) and delta-free `--custom`
> cluster/security DDL (0211, 0213, 0214, 0261, 0267, 0279) do not change the snapshot, so they produce
> NO delta and cannot false-fail — proven GREEN on the unmodified HEAD tree.
>
> **Red-when-broken, both directions measured.** GREEN on HEAD (`generate` produced no delta). RED on
> the exact BRW-004 mutation E5: reverting `agentRuntimeTrustRules.agentId`'s `.notNull()` in
> `packages/db/src/schema/agent_runtime_decisions.ts` while leaving migration `0273` in place made the
> gate emit `ALTER TABLE "agent_runtime_trust_rules" ALTER COLUMN "agent_id" DROP NOT NULL` and exit 1 —
> the precise drift E8-F005 was filed against. Restoring the token returns the gate to GREEN.
>
> **Branch state, not landed.** True on `f005-schema-drift-gate`. The resolution is carried by the commit
> that lands the gate; if the PR does not merge, this reverts to `open`.
**Filed:** 2026-09-04, by BRW-004 while closing E8-F002's tenth null-hazard. MEASURED by mutation,
not inferred.

**What.** `packages/db/src/schema/*.ts` and `packages/db/src/migrations/*.sql` are two independent
statements of the same truth, and no check compares them. The `migrations` CI job validates the
JOURNAL (idx contiguity, a SQL file per entry, the committed-snapshot `prevId` chain) — all of which
stay perfectly valid when the schema and the DDL disagree. `drizzle-kit generate` is run by a human
and its output is committed; nothing re-runs it in check mode.

**How it was measured.** Mutation E5 of BRW-004: revert `agentRuntimeTrustRules.agentId`'s
`.notNull()` in the schema while leaving migration `0273` in place. Before a pin was hand-written
for that one column, **the mutation was GREEN** — `tsc` passes (`string` is assignable to
`string | null`), every service test passes, `migrations` passes, `policy` passes. The drift is
invisible, and the next `db:generate` would silently emit a re-narrowing migration as if it were a
new intent.

**Why it matters more than tidiness.** The direction that goes undetected is the RELAXING one. A
narrowing is usually load-bearing — `0273`'s NOT NULL is what makes a company-wide wildcard trust
rule unrepresentable, and what turns the defect line into a compile error. A revert of that one
token restores the hazard while the migration that "closed" it is still sitting in the tree, still
applied on every existing database, still cited in a result doc. **The artifact that proves the fix
and the artifact that enforces it are different files, and only one of them is checked.**

**Scope, stated so it is not over-read.** This is a DETECTION gap, not a live defect: the schema and
the migrations agree at this SHA (verified against real Postgres by
`brw-004-decision-binding.integration.test.ts`, 8/8). It says nothing about whether any existing
migration has already drifted — that is exactly what nothing can currently answer.

**What BRW-004 did about it, which is not a fix.** One hand-written assertion in
`packages/db/src/__tests__/agent-runtime-decisions-schema.test.ts` pins `agent_id`'s `notNull` and
`run_id`'s nullability for this one table. A per-column pin written by whoever remembers to write
it is the "check that only exists where someone thought of it" pattern, not a guard over the class.

**Disposition.** The real closure is a CI step that regenerates and fails on a non-empty delta
(`drizzle-kit generate` into a scratch dir, then diff), which is a `policy`-lane change with a
blast radius across every schema file — larger than any E8 ticket and unrelated to browser
automation. **Do not close it by adding more per-column pins.**


## E8-F006 — E8-1's promotion check cannot detect E8-1's promotion: the live route stages and execs `runBrowserSession`, it never references it

**Status:** open
**Severity:** MEDIUM — the auditor rated this HIGH; the downgrade is argued below and is the only
point on which this filing departs from the report.
**Filed:** 2026-09-06 (W5U1), measured at `e1f723df2`.

**What.** `E8-1-sandbox-local-browser` is declared `unwired` with `expectedReferences: 1`
(`scripts/gate-clause-wiring.json`). For an `unwired` entry the evaluator gives exactly ONE
mechanical signal, `scripts/lib/gate-clause-wiring.mjs:105-106`:

```js
const expected = typeof entry.expectedReferences === "number" ? entry.expectedReferences : 0;
if (count > expected) { …unwired_but_now_has_caller… }
```

and the library's own comment states the intent: acknowledging a known count "keeps the
promote-check sharp — it still fires the moment a NEW reference appears".

**Measured: the promotion this clause exists to watch for adds no reference.** The route to live is
written down in the code itself. `packages/browser-runtime/src/runner.ts:3-17` — "BRW-002 — THE
IN-GUEST ENTRYPOINT. This is the boot root." — describes the host side as:

```
host: writeFiles(runner + session.json) -> exec(node runner.js session.json)
```

The host **stages a file and execs it**. Nothing on the host imports `browser-runtime`, calls
`runFromConfig`, or names `runBrowserSession`; the package has no importer and is in no dependency
list (the clause's own reason says so, and `grep -rn runBrowserSession --include=*.ts .` confirms
the only non-test references are inside the package: the definition at `run-session.ts:139`, the
`index.ts:35` re-export, the `runner.ts:43` import and the `runner.ts:65` call). Wiring BRW-004
slice (f)+ — or any stage-and-exec delivery — leaves `countProductionCallers(runBrowserSession)` at
exactly **1**, which is `expectedReferences`, which is not `> expected`. The check stays silent
through the promotion.

**This is the [[checks-that-nothing-runs]] shape, one field over from the one the register already
guards.** `claimed_wired_but_no_caller` catches a clause claiming MORE than the code delivers.
`unwired_but_now_has_caller` is the mirror, and for this clause the mirror is blind — not because
the count is wrong, but because caller count is the wrong observable for a capability delivered by
process exec rather than by import.

**Why MEDIUM and not HIGH.** The error direction is PESSIMISTIC. If E8-1 goes live, the register
keeps printing `DORMANT, on the record: … E8-1-sandbox-local-browser` on every green `policy` run —
a false statement, but one that under-claims. Nothing ships on the strength of it; no gate opens
that should have stayed shut. The programme's stated calibration is that a FALSE CLAIM OF
ENFORCEMENT is the intolerable direction, and this is its opposite. A reviewer could argue HIGH on
the ground that the register's comment asserts an enforcement ("it still fires the moment a NEW
reference appears") that is untrue for this entry, and that argument is not silly — it is recorded
here rather than settled, so the next reader sees both.

**Scope, honestly — and this is wider than the report said.** `expectedReferences` is carried by
exactly two clauses. The other, `E7-1-coding-journey` (`E2bSandboxProvider`, `expectedReferences: 4`),
states its own promotion conditions as "the operator builds+deploys the adapter-manager image and
DEP-011 wires the daemon consumer". The FIRST of those is a deploy action and adds no reference to
anything, so at least half of E7-1's promotion is invisible to the same signal. I have not traced
whether DEP-011's daemon consumer would add a fifth `E2bSandboxProvider` reference — that is a claim
about unbuilt code and I will not guess it. What is measured is that the register's only
promote-detector is reference count, and that BOTH clauses relying on it have promotion routes at
least one of whose steps is invisible to it.

**What would close it.** Something other than a reference count as E8-1's promotion signal — e.g. a
declared assertion that no file outside `packages/browser-runtime` names `runner.js`/`run-session`,
or an entry in the existing `browser-spawn-expectation.json` / boot-root guards, which already
reason about spawn sites rather than imports. Deliberately not built here: choosing E8-1's
promotion observable is an E8 gate decision, and W5U1's charter is filing plus the one checker fix
(E4-F018).

---

## E8-F007 — The programme booked "managed-E2B egress is not fully lockable" as fact for a year; the installed SDK exposes the surface, and that false premise is what wrote off the only enforcement layer outside the guest

**Status:** open · **Owner:** `unowned`
**Severity:** HIGH — argued in §4, with the counter-argument for MEDIUM recorded rather than
settled.
**Filed:** 2026-09-07 (W10A), by reading the installed dependency rather than the record.

### 1. What was measured, and on what artifact

**Resolved package inspected: `e2b@2.30.5`** — the version `pnpm-lock.yaml` resolves (`e2b@2.30.5:`
in both the packages and snapshots sections) and the version installed on disk at
`node_modules/.pnpm/e2b@2.30.5/node_modules/e2b/package.json` (`"version": "2.30.5"`). It resolves
from both workspace packages that declare it — `server/package.json` and
`packages/sandbox-e2b-provider/package.json`, both `"e2b": "^2.30.5"`. Line numbers below are from
that build's `dist/`; they are given for a reader's convenience, and the literal strings — not the
line numbers — are what `scripts/w10a-sdk-capability-premise.json` pins.

**Types (`dist/index.d.ts`).** The option type exists, is carried by `Sandbox.create`'s own
options, is returned by the info endpoint, and can be replaced on a running sandbox:

```ts
type SandboxNetworkOpts = {                    // :7168
    allowOut?: SandboxNetworkSelector;         // "Allow outbound traffic … to the specified addresses"
    denyOut?: SandboxNetworkSelector;          // "Block all egress: ({ allTraffic }) => [allTraffic]"
    rules?: SandboxNetworkRules;
    allowPublicTraffic?: boolean;
    maskRequestHost?: string;
};
network?: SandboxNetworkOpts;                  // :7340 — on SandboxOpts, i.e. Sandbox.create
network?: SandboxNetworkInfo;                  // :7507 — on SandboxInfo, i.e. READ BACK
static updateNetwork(sandboxId: string, network: SandboxNetworkUpdate, opts?): Promise<void>; // :7622
```

**Runtime (`dist/index.js`).** The option is serialised and reaches the wire, and the read-back is
mapped — this is not a type-only stub:

```js
function buildNetworkBody(network) { … }                        // :4221
network: buildNetworkBody(opts?.network),                       // :4579, inside the POST /sandboxes body
client.api.PUT("/sandboxes/{sandboxID}/network", { … body: buildNetworkUpdateBody(network) }) // :4429
network: res.data.network ? { allowOut: …, denyOut: …, rules: … } : void 0  // :4307-4312, in getInfo
```

`SandboxOpts` additionally carries `allowInternetAccess`, documented as *"When set to false, it
behaves the same as specifying denyOut to 0.0.0.0/0 in the network config"* (`:2010`, `:7327`).

### 2. What the record says instead, in six tracked files

The claim is stated as fact, in the present indicative, with no hedge and no citation to any
measurement, in every one of these. The list came from scanning tracked files rather than from
trusting a hand-list — the site list has been incomplete in every prior round of this programme.
Every row below is a QUOTATION being corrected by this finding, `E8-F007`, not an assertion.

| file | what it says |
|---|---|
| `docs/aoa/plans/2026-08-05-cloud-execution-isolation-e2b-spec.md:180` | *"Managed-E2B egress is not fully lockable."* — §12, the deployed system's own spec |
| `docs/aoa/plans/2026-08-06-e2b-plan-wave4-files.md:16` | *"§11 documents managed egress is not fully lockable"* |
| `docs/aoa/plans/2026-08-06-e2b-plan-wave4-files.md:105` | *"do not throw if managed E2B cannot enforce it (§11 — managed egress is not fully lockable; enforcement is a self-hosted concern)"* |
| `server/src/services/sandbox-provider-runtime.ts:783-786` | a production comment, on the create call itself: *"§11/§12: managed E2B egress is not fully lockable"* |
| `server/src/__tests__/sandbox-egress-allowlist.test.ts:5, :88` | the same sentence, twice, as the stated reason the provider records rather than enforces (both now annotated with `E8-F007`) |
| `E8-F003` §5 above, and its `scripts/finding-ownership.json` entry | quotes the spec bullet approvingly, and §2's *"option (b) is unavailable"* rests on it |

**The last row is the consequence, and it is why this is filed at HIGH rather than as a docs fix.**
`E8-F003` is a HIGH finding about a `Critical` control (`DE-08`) that is enforced at no layer. Its
own reasoning concludes that constraining egress **at the provider** — the one enforcement point
outside the guest — is *unavailable*, leaving the in-guest point as the only layer. And every
in-guest mechanism is agent-writable by construction: `buildE2bLoginShellScript`
(`sandbox-provider-runtime.ts:647-655`) sources `/etc/profile`, `$HOME/.profile` and
`$HOME/.bashrc` from an agent-writable home before `exec env … claude`. So the false premise did
not merely sit in a document — **it wrote off the only layer the agent cannot edit.**

### 3. What `E8-F007` claims, and three things it explicitly does NOT claim

**Claims:** the capability EXISTS IN THE INSTALLED ARTIFACT, and the "not lockable" premise is
unsupported by anything in the record. No measurement was ever written down behind it; it
propagated by citation.

**Does NOT claim:**

1. **That the control works.** Nobody has run it. No AoA code path passes `network` to
   `Sandbox.create` today — the allowlist crosses as `metadata`, which `E8-F003` measured inert.
   Reading this finding as *"we can lock egress"* would be the same error in the opposite
   direction, and would be worse, because it would be a false claim of enforcement.
2. **That the operator's tier honours it.** UNMEASURED, and it is the open question.
   **★ ANSWERED 2026-09-07 (W11) — see §7: it is MEASURED and the tier does NOT honour it
   (`E8-F008`). Read the rest of this item as the reasoning that was correct to demand a
   read-back and wrong about what a read-back can prove: the measured tier is NOT the tolerant
   server described below, and the read-back PASSES on an unpoliced sandbox.** Two facts make
   a read-back mandatory rather than optional: `buildNetworkEgress` (`dist/index.js:4214-4219`) is a
   pure passthrough — nothing is validated client-side, and the only error path is HTTP status — and
   the API target is per-company configurable (`resolveE2bDomain = config.domain ?? env.E2B_DOMAIN`,
   `sandbox-provider-runtime.ts:577-578`, with a self-hosted branch at `:545`). **A tolerant or
   self-hosted server that ignores an unknown field returns 200 and yields an UNPOLICED sandbox with
   identical code and identical logs.** A probe unit is being built separately; its result belongs
   here when it lands. **It landed: §7.**
3. **That `E8-F003` is closed, downgraded, or wrong in its conclusion.** It is none of those. Its
   conclusion — enforcement exists at no layer — is untouched, and was measured independently at
   each of the three candidate points. `E8-F003` §0 records the correction and says exactly this.

### 4. Why HIGH

Two reasons, neither of which is "a document was wrong".

**(a) It is a false NEGATIVE capability claim, and those suppress work rather than merely
misinform.** This programme's stated calibration is that a false claim of enforcement is the
intolerable direction and a pessimistic error is the tolerable one. That calibration does not cover
this case. A false claim that something is IMPOSSIBLE is pessimistic about capability and
*permissive* about consequence: it closes the remedy rather than over-promising a protection. Here
it closed the only out-of-guest remedy for a `Critical` control whose owner column is already
exhausted. The under-claim was load-bearing.

**(b) Nothing could have caught it, and that is the reusable half.** Every guard in this repository
checks a claim about THIS repository — a clause against its symbol's caller count, a `reason`
against the source file it cites. A sentence about what a THIRD-PARTY ARTIFACT cannot do had no
checker of any kind, and it is exactly the sentence that rots on its own: the artifact ships a new
version, nobody re-reads its types, and the claim keeps being cited forward. Six files, one year,
zero red.

**The argument for MEDIUM, recorded rather than settled.** No live system is less safe because of
this: the `metadata` string is inert either way, distributed execution is default-off, and `DE-08`
was already open at `Critical` with `E8-F003` filed at HIGH. On that reading this is a
documentation defect whose only cost is a foreclosed design option. A reviewer could reasonably
land there. I do not, for reason (a) — a foreclosed design option on a Critical control with no
owner is one of the things keeping it un-owned — but the next reader should see both.

### 5. What was done here, and what was deliberately not

**Done (record + guard only; NO enforcement behaviour changed):**

- The code comment at `sandbox-provider-runtime.ts` no longer asserts the premise. It states that
  the capability exists in the installed SDK, that whether the operator's tier honours it is
  unmeasured, and why the call still passes `metadata` — citing this finding. **No predicate, no
  call, no argument changed.**
- Every other site in §2 carries a dated correction adjacent to the claim. The historical documents
  keep their original sentences: a record that silently rewrites what it used to believe is worse
  than one that shows the correction next to it.
- `E8-F003` gained §0 — a dated note that one of its stated reasons is unsupported, with its status,
  severity, ownership and conclusion untouched.
- `scripts/check-w10a-sdk-capability-premise.mjs` + `scripts/w10a-sdk-capability-premise.json`: the
  premise cannot be reintroduced silently while the SDK exposes the surface. It pins the measured
  version against the lockfile (a bump forces re-measurement), checks the declared surface markers
  against the resolved package in the lane that installs dependencies, requires a correction marker
  beside any quotation of the refuted sentence, and fails if its own ban pattern ever stops matching
  anything — a ban that matches nothing is a check that nothing runs.

**Deliberately not done:** passing `network` to `Sandbox.create`. That is an enforcement change; it
needs the tier measurement, a mandatory `getInfo()` read-back (§3.2), a decision about what a failed
read-back should do to a run, and an owner. Shipping it on the strength of a type declaration would
be the false-enforcement error this finding exists to avoid.

**Known limit of the guard, stated rather than implied.** It bans the sentence family that actually
occurred, not the idea. A rewording evades it. Pretending otherwise would be a false claim of
enforcement in a new place; the guard's own header says so.

### 6. Disposition — why `unowned`

No ticket in the roster is chartered to measure whether the E2B tier honours a `network` body, or to
adopt the surface with a read-back. `E8-F003` remains the right home for the *enforcement gap*; this
finding owns the *premise*, and its remaining half is a measurement nobody is assigned. Repoint it
when a ticket takes provider-level egress adoption for the sandbox path — the same bar `E8-F003`
sets, and for the same reason.

**Do not close this by citing the type declarations.** A type is not a measurement, and this finding
is the record of what happens when a capability claim is taken on citation. Close it when a probe
records what the operator's tier does with a `network` body — in both directions, honoured and
ignored — or when the surface is adopted with a read-back that fails closed.
**★ AMENDED 2026-09-07 (W11) — a read-back that fails closed is no longer a sufficient bar; see
§7 and `E8-F008` §3.**

### 7. 2026-09-07 (W11) — THE OPEN QUESTION IS NOW CLOSED BY MEASUREMENT. The finding stays open; here is exactly what moved and what did not

§3.2 named one thing as *"UNMEASURED, and it is the open question"* — whether the operator's E2B tier
honours a `network` body. **It is measured. The tier does not honour it.** Workflow run
[`34085130892`](https://github.com/MeteoriteLabs/AoA/actions/runs/34085130892) at `ab23eabdc`,
template `aoa-base`, artefact `w10b-egress-enforcement-record`; all four controls held and the probe's
ABANDON condition did not fire. `E8-F008` (HIGH, open, `unowned`) is the finding that owns the result.

**Be precise in BOTH directions, because the two halves of this finding move in opposite ways.**

**(a) The CAPABILITY claim STANDS, and is not weakened by the measurement.** The surface really is in
the installed, lockfile-pinned artifact — `SandboxOpts.network`, `updateNetwork`, the `getInfo()`
read-back — exactly as §1 records, and the run **exercised all three of them successfully as API
calls**. The old premise this finding refuted was not "the tier ignores the body"; it asserted that the
API **did not exist**, and that assertion was, and remains, false. Anyone tempted to read the new
result as "the old sentence was right after all" should read this paragraph twice: the old sentence's
CONCLUSION happened to land near the truth while its REASON was wrong, which is the least useful kind
of correct and is precisely why it was load-bearing for a year without anyone testing it. The guard
`scripts/check-w10a-sdk-capability-premise.mjs` therefore stays exactly as it is.

**(b) What is now established is NARROWER AND WORSE than either the old premise or this finding's own
§3.2 anticipated.** The API exists, accepts, validates server-side (a sibling arm was refused with
`400: invalid denied CIDR ::ffff:0:0/96`), persists, echoes the policy back **verbatim** — and routes
the denied traffic anyway, through both the create body and `updateNetwork`. §3.2's stated failure
mode was *"a tolerant or self-hosted server that ignores an unknown field"*; the measured tier is the
**opposite** of that, which is why the read-back this finding calls mandatory **passes** on an
unpoliced sandbox. `E8-F008` §3 is the record of that, and it is the more important half of the result.

**What this section does NOT do.** It does not resolve this finding, and it does not change its status,
severity or ownership. Two things stay open, both real and both checkable:

1. **The tier question is closed for ONE tier only.** `resolveE2bDomain = config.domain ?? env.E2B_DOMAIN`
   (`sandbox-provider-runtime.ts:577-578`, self-hosted branch `:545`) makes the API target per-company
   configurable, and only the tier behind this repository's own `E2B_API_KEY` was measured. §3.2 named
   that configurability as half of its reason; the measurement did not remove it.
2. **The ADOPTION half has no owner and is now contraindicated rather than pending.** §5's
   "deliberately not done" list is unchanged in substance and stronger in reason: passing `network` to
   `Sandbox.create` at the measured tier would produce a control that verifies green and enforces
   nothing. That is a change in the reason not to do it, not a closure of the question of who owns it.

**Consequently `E8-F003` §0's reading of it — "defence in depth at the provider is back on the table"
— is withdrawn** by that finding's own §8 census, which this run completes. Do not cite it.

**How to close this finding.** §6's bar said *"in both directions, honoured and ignored"*. Only the
ignored direction has ever been observed, on one tier. Close this when the premise correction is no
longer load-bearing anywhere — i.e. when no record cites provider capability as a reason for anything
— or when a tier is measured to honour the body. **Do not close it on `E8-F008`**: that finding
inherits the enforcement result, not this one's premise.

### 8. 2026-09-11 (CIDR-only probe) — the sub-question is settled in the SAME direction for the second construction: the capability materializes, the tier does not enforce it

§7 answered "does the measured tier honour a `network` body?" for the deny-only shape — it does not.
The remaining doubt was whether the *other* documented construction (default-deny + `allowOut`
allowlist) might behave differently, since it had never placed (§8 of `E8-F008`). It has now placed
and been measured. Run
[`34528397309`](https://github.com/MeteoriteLabs/AoA/actions/runs/34528397309) (ref
`e2b-cidr-only-probe` @ `8f2c2b7d8`, template `aoa-base`, 2026-09-10), CIDR-only body: the sandbox
created (`ipm63v4ubgmzbik13v653`), `getInfo()` returned the declared policy verbatim, and the
metadata endpoint `169.254.169.254` was **REACHED (401)** under it — so the allowlist shape **also
materializes as a capability and fails to enforce the destination that matters**. Unlike an earlier
draft, it does **not** differ from the deny-only shape by blocking arbitrary public egress: `9.9.9.9`
and `registry.npmjs.org` returned `curl 35`, which is **post-connect = reached-then-broke** (reached,
not refused) per the probe's `classifyReachEvidence` — a Codex P2 on PR #425 caught the misread. The
shape is **wholly inert**, and the capability-vs-enforcement gap this finding names holds on both
constructions.

**What moves and what does not.** This settles the last open sub-question in §7's item (2) *for the
tier this key reaches*: adoption remains contraindicated, now on two measured constructions rather
than one measured plus an unplaced arm. Nothing else moves. **(a)** The capability claim STANDS and
is if anything reinforced — all three surfaces (`SandboxOpts.network`, the `getInfo()` read-back,
`updateNetwork`) were exercised as successful API calls a second time, on a shape that placed. The
guard `scripts/check-w10a-sdk-capability-premise.mjs` stays as it is. **(b)** §7 item (1) — the tier
question is closed for ONE tier only — is untouched; only the tier behind this repo's `E2B_API_KEY`
has been measured, on either shape. Status (`open`), severity (HIGH) and ownership (`unowned`) are
unchanged. The premise correction is still load-bearing somewhere, so §6's close bar is not met.
`E8-F008` §9, `W10B-egress-enforcement-result.md` §15.

---

## E8-F008 — The provider ACCEPTS a deny set, VALIDATES it, STORES it and READS IT BACK VERBATIM, and routes the denied traffic anyway; the `getInfo()` read-back that six records name as the mandatory safeguard PASSES on that unpoliced sandbox

**Status:** open · **Owner:** `unowned`
**Severity:** HIGH — argued in §5, with the counter-argument for MEDIUM recorded rather than settled.
**Filed:** 2026-09-07 (W11), from workflow run
[`34085130892`](https://github.com/MeteoriteLabs/AoA/actions/runs/34085130892)
(`.github/workflows/keyed-e2b-w10b-egress-enforcement-probe.yml`) at `ab23eabdc`, template
`aoa-base`, artefact `w10b-egress-enforcement-record` (schema `aoa.w10b.egress-enforcement-record/1`,
run nonce `W10B-MTQRVDJP-2FEX4EOA`). Every row below was read from that run's own step log and durable
record. This unit **built and proposed no enforcement of any kind**, and nothing in it should be read
as one.

### 1. The conjunction — which is the finding, not any one row of it

Sandbox `iqxqyb6z125jm2el8fw11` was created with
`network.denyOut = ["169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]`. The
anti-vacuity sandbox `ia4rtdajfwq487odec059` was created with the identical shape and a deny set that
names a *different* range (`198.51.100.0/24`, RFC 5737 TEST-NET-2), so the two arms differ in **which**
addresses are denied and in nothing else.

| step | what the API did | evidence |
|---|---|---|
| `Sandbox.create` accepts | HTTP 200, sandbox created | `[w10b/P/policy] sandboxId = iqxqyb6z125jm2el8fw11` |
| it **validates** the set server-side | a **sibling arm was REFUSED**: `SandboxError: 400: invalid denied CIDR ::ffff:0:0/96` | `[w10b/P6/ipv6-deny] ARM FAILED` |
| it **stores and echoes** the set | `getInfo().network` = `{"denyOut":["169.254.0.0/16","10.0.0.0/8","172.16.0.0/12","192.168.0.0/16"],"allowPublicTraffic":true}` — the declared set exactly | probe **b** = `yes / policy-materialized-exactly` |
| it **enforces nothing** | `169.254.169.254` **REACHED, HTTP 401**, from inside the sandbox that declared `169.254.0.0/16` — byte-identically to the arm that did not deny it | probe **a** = `no / denied-target-still-reachable` |
| the **update** endpoint behaves the same | `updateNetwork` returned success on a paused-and-resumed sandbox; the target was **REACHED (401) both before and after** | probe **d** = `no / update-did-not-take-effect` |

**That is two API surfaces — the `POST /sandboxes` create body and `PUT /sandboxes/{sandboxID}/network`
— each of which accepts, persists and reports a policy neither of them applies.** The 400 on the IPv6
arm matters precisely because it proves the server is *not* a tolerant endpoint discarding an unknown
field: it PARSES and RANGE-CHECKS the deny set, and **refuses the whole `create` call** over one entry
it will not accept (the arm was never created — no sandbox, no partial policy). It is not ignoring the
policy. It is validating it, storing it, reporting it, and not using it.

### 2. The controls, all four of which held

Read from the run log rather than from the pack's own summary line:

| control | policy arm | anti-vacuity arm |
|---|---|---|
| POSITIVE `allowed_public` | `exit 0 / 200` | `exit 0 / 200` |
| APPARATUS `…must-not-resolve.invalid` | `curl (6) Could not resolve host` | `curl (6) Could not resolve host` |
| ANTI-VACUITY `metadata_v4` | `exit 0 / 401` | `exit 0 / 401` |
| COMPLETENESS | every row `parsed=yes` | every row `parsed=yes` |

The record's own `observations.controls` is `{"ok":true,"problems":[]}`. **The ABANDON condition did
NOT fire** — probe **c** came back `no / resolver-outside-the-deny-set` (`/etc/resolv.conf` is
`nameserver 8.8.8.8` in both arms, contained by no declared range, and name resolution worked under
the policy). So this is not a misconfiguration that broke its own experiment: the policy arm's DNS,
package registry and model API were all reachable under the deny set, and the denied destination was
reachable too. **The deny set is genuinely inert; this is not "the apparatus took itself down".**

### 3. ★★★ The lesson, and it is the reason this is filed rather than noted: the safeguard PASSES here

The `getInfo()` read-back is named as the **mandatory** precondition for adopting this surface in six
tracked places. This list was gathered by scanning tracked files rather than by trusting a hand-list,
and every row is a sentence this finding is correcting.

> ★ **CORRECTED 2026-09-07 (W12) — every quotation in the table below is now VERBATIM, and all six
> rows were re-checked against source, not only the one that was flagged.** Two were not: row 1
> attributed to `E8-F007` §3.2 the string *"a read-back is therefore mandatory"*, which appears
> nowhere in that section — a **paraphrase inside quotation marks**, in a table headed "what it
> says", in a finding whose whole thesis is that a claim must be re-derived rather than inherited.
> Row 6's second quotation silently dropped the word *here* from *"even if (a) is yes here"*, which
> is a truncation in the direction of a broader claim than the source makes. **Rows 2, 3, 4 and 5
> were verified verbatim and are unchanged.** ★ Precisely, because "verbatim" needs saying exactly:
> row 3 is a whole sentence; rows 2, 4, 5 and 6a quote **fragments**, each byte-identical to its
> source as a fragment, and row 2 is the only one that additionally elides a tail (marked with its
> own ellipsis). Fragments were left as fragments — the defect being corrected is invented wording,
> not partial quotation.

| file | what it says |
|---|---|
| `docs/replatform/epics/E8-browser-automation/findings.md` (`E8-F007` §3.2) | *"Two facts make a read-back mandatory rather than optional"* |
| the same file (`E8-F007` §5, "Deliberately not done") | adoption *"needs the tier measurement, a mandatory `getInfo()` read-back (§3.2)…"* |
| the same file (`E8-F003` §0.2) | *"A read-back is mandatory before anyone relies on it."* |
| `docs/aoa/plans/2026-08-05-cloud-execution-isolation-e2b-spec.md:181` | *"a read-back is mandatory before anyone relies on it"* |
| `server/src/services/sandbox-provider-runtime.ts` (the `acquireLease` metadata comment) | *"adopting the real surface requires the probe plus a mandatory read-back"* — **quoted as it stood at `ab23eabdc`; this finding's own change replaced that sentence, because it is the one site where leaving the refuted safeguard standing in PRODUCTION CODE would invite the adoption it warns against. The other five keep their original wording with a dated correction beside it.** |
| `docs/replatform/epics/E8-browser-automation/tickets/W10B-egress-enforcement-runbook.md` §3 | the read-back is *"a first-class question rather than a footnote"*, and *"a `no` on (b) makes the approach unshippable **even if (a) is yes here**"* |

**Probe (b) came back `YES`.** Every one of those safeguards passes on a sandbox that reaches the
metadata endpoint it declared denied. Had an adoption unit shipped with the read-back as its
safeguard — which is exactly the shape all six records prescribe — AoA would have had a control that
looks correct **in the code, in the logs, and in its own verification step**, and enforces nothing.
That is `E8-F003` again, one API surface over, and this time with a passing verification beside it.

**Why it fails, stated precisely, because the precise version is the reusable half.** The read-back
was specified against ONE failure mode, named in the same breath every time it is required: *"a
tolerant or self-hosted server that ignores an unknown field returns 200 and yields an UNPOLICED
sandbox with identical code and identical logs"* (`E8-F007` §3.2). Against **that** server the
read-back works — the field would come back absent, and `no / network-not-materialized` is a verdict
the pack can and does issue. The measured tier is the opposite of that server: it validates, persists
and returns the policy faithfully. So the safeguard's trigger never fires, and it certifies the
sandbox.

> **A read-back verifies WHAT WAS DECLARED. It cannot verify WHAT IS ENFORCED, and no amount of
> fidelity in the echo brings it closer.** The only instrument that answers the enforcement question
> is a packet that tries to cross — which is what this run did, and is why the probe's question (a)
> is a differential reachability test rather than a configuration assertion. Any future safeguard on
> any provider surface has to be read against this: *"the API confirmed our policy"* is a statement
> about the API's bookkeeping.

### 4. The IPv6 flank, which an otherwise-working IPv4 deny set would still have

Three spellings of the **same destination**, in the **same sandbox**, under the **same policy**:

| spelling | result |
|---|---|
| `169.254.169.254` | REACHED 401 |
| `[::ffff:169.254.169.254]` (v4-mapped, dotted) | **REACHED 401** |
| `[::ffff:a9fe:a9fe]` (v4-mapped, hex — what URL parsers canonicalise to) | **REACHED 401** |
| `[fd00:ec2::254]` (IMDS over IPv6) | `curl (7)`, but it failed in the anti-vacuity arm too, so **not attributable to the policy** |

Two of them reached. On this tier the point is moot **for the deny-only shape**, because nothing that
shape declares is enforced at all — but it is recorded because it is a property of the **surface**,
not of this tier: the SDK's only sentinel is
`ALL_TRAFFIC = "0.0.0.0/0"` (`node_modules/.pnpm/e2b@2.30.5/node_modules/e2b/dist/index.d.ts:7749`,
read directly), and `::/0` occurs **zero** times in that file. And the one attempt to declare an IPv6
deny set was **refused at create** (`400: invalid denied CIDR ::ffff:0:0/96`). So an IPv4 deny set
that *did* work would still be routed around by the second and third spellings in this table, and the
API declined the arm that would have closed them.

> ★★★ **This is a DESIGN GAP in the surface, and it outranks the inertness result in durability.**
> Inertness is a property of **this tier** and could be fixed by E2B tomorrow, or be absent on
> another. **The gap is a property of the API:** an IPv6 deny entry is *inexpressible* — the only
> sentinel is `ALL_TRAFFIC = 0.0.0.0/0`, there is no `::/0`, and the one concrete IPv6 CIDR anyone
> tried was rejected at create with a `400`. So a `denyOut` that **worked perfectly** would still be
> walkable by rewriting the destination in IPv6 — `[::ffff:169.254.169.254]` and
> `[::ffff:a9fe:a9fe]`, the second being what URL parsers canonicalise to — and **the API offers no
> way to close it**. Any future design that reaches for `denyOut` as a boundary has to answer this
> first; a deny list that cannot express half the address space is not a boundary.
>
> **What is measured and what is not, kept apart.** The two v4-mapped spellings **REACHED** — that is
> a measurement, taken under a policy that named `169.254.0.0/16`, and reproduced in all three
> keyed runs (`34085130892`, `34328502574`, `34328780645`). The `400` on `::ffff:0:0/96` is a
> measurement. That an IPv6-reachable destination would *still* be reached under a **working** deny
> set is an **inference** from those two, not an observation — no working deny set exists to test it
> against. It is labelled here so nobody cites it as a measurement.
>
> **This is not a separate finding.** It lives here because it is a property of the same surface this
> finding measures, and splitting it would put half the evidence in each. Nothing about it moves
> `DE-08` (`not-delivered`), and no enforcement is proposed.

### 5. Why HIGH, and the argument for MEDIUM recorded rather than settled

**(a) It refutes the safeguard, not just the control.** `E8-F003` established that a Critical control
(`DE-08`) is enforced nowhere. This establishes something narrower and worse about the layer that was
left: adopting it would have produced a **false claim of enforcement carrying its own passing
verification**. This programme's stated calibration is that a false claim of enforcement is the
intolerable direction; a safeguard that certifies an unpoliced sandbox is the mechanism by which one
gets made in good faith.

**(b) It retires the last candidate outside the guest.** With this measured, every enumerated
enforcement layer for `DE-08` is refuted — see `E8-F003` §8, which this finding writes. What to do
about a `Critical` control with no available layer is a **founder decision that has not been taken**;
this finding records the facts that inform it and takes none of it.

**The argument for MEDIUM, recorded rather than settled.** No live system is worse off. AoA passes
`metadata`, never `network`; no adoption unit was ever built; distributed execution is default-off;
and `DE-08` already reads `not-delivered`. On that reading this is a design-time result that
*prevented* a defect rather than describing one, and the prevention is exactly what the probe was
built for — which is an argument that the process worked, not that the finding is small. A reviewer
could reasonably land on MEDIUM. I do not, for (a): the defect this would have produced is the one
this programme rates intolerable, and it would have shipped with a green verification beside it.

### 6. What this measurement does NOT establish

Stated so none of it is over-read. Each is a limit of the run, not a hedge on the verdict.

1. **It measures one tier.** `resolveE2bDomain = config.domain ?? env.E2B_DOMAIN`
   (`server/src/services/sandbox-provider-runtime.ts:577-578`, self-hosted branch at `:545`) makes the
   API target per-company configurable. What some other tier or a self-hosted server does with a
   `network` body is unmeasured, and this finding claims nothing about it.
2. **It measures `denyOut`.** `allowOut` (the default-deny allowlist half) and
   `allowInternetAccess: false` (documented as *"the same as specifying denyOut to 0.0.0.0/0"*,
   `dist/index.d.ts:2010`) were not exercised. That a range-scoped `denyOut` is not applied is an
   argument, **not a measurement**, about the other two, and is labelled as such here so nobody cites
   it as one. Note also that total egress denial is not the `DE-08` control in any case: the
   product-regression rows in this very run show the sandbox needs DNS, the package registry and the
   model API.
   **★ FOLLOWED UP 2026-09-09 (W10B-B), and this clause turned out to be the one other records
   overrode.** Several of them generalised this finding to "the tier does not honour a `network`
   body"; this clause always said otherwise, and it is now the authority — every one of those
   sentences has been narrowed to the deny-only shape (`E8-F003` §8 rows 2 and 2b,
   `sandbox-provider-runtime.ts`, the `DE-08` register row, the W10B runbook and result docs, and
   this file). E2B's documentation presents default-deny + `allowOut` as **the** fine-grained control
   and states that domains are unsupported in deny lists, so the allowlist form is the shape a real
   control would take — and the one nobody has run. An arm for it is **built** (runbook §13).
   **★★★ THE ARM HAS SINCE BEEN DISPATCHED TWICE AND THIS CLAUSE STILL STANDS UNCHANGED.** Runs
   `34328502574` and `34328780645` (2026-09-09) both returned `UNRUN — arm-was-never-created`: the
   allowlist body **failed to place** (`500 … please retry`) while sibling arms placed seconds
   apart. `allowOut` is still **not exercised**, so this clause's "an argument, not a measurement"
   remains the correct reading — and the new fact must not be over-read either: **`UNRUN` is not
   `INERT`**, and *fails to place* is not *refused* (§8). **Nothing about that changes this
   finding's severity, status or
   conclusion**, and "unmeasured" must not be read as "promising": it is a hole in the record.
3. **Two denied-range rows are unattributable.** `rfc1918_10` timed out in **both** arms and
   `metadata_v6` failed to connect in **both**, so neither says anything about the policy. The
   verdict rests on `169.254.169.254`, which is reachable in both arms and inside a declared denied
   range in one of them.
4. **The product-regression check is PARTIAL.** No AoA control-plane URL was supplied on the push
   route, so the `aoa_api_url` row was **not exercised**; the record names it. `dns_dependent` and
   `model_api` were reached.
5. **It says nothing about exploitability.** `169.254.169.254` answered `401` — an IMDSv2 token
   challenge from a service the run's raw-socket row identifies as `Server: Firecracker API`. That it
   is reachable and answering is measured; what it would yield to a token-bearing caller is not, and
   the endpoint belongs to the provider's infrastructure.
6. **It is E2B only.** Like every keyed lane here, this says nothing about the networked/container
   lane (`E7-F011`).

### 7. Disposition — why `unowned`, what it blocks, and how not to close it

**`unowned`.** No ticket in the roster is chartered to own provider-level egress for the sandbox path
— the same bar `E8-F003` and `E8-F007` set, and for the same reason. `BRW-004` slice (f) is the
only **remaining** chartered enforcement candidate and is scoped to browser sessions, while what was measured is the
sandbox path every workload shares. Naming it, or DAT-005/DSK-002 (both shipped), would be filing
against work that cannot take this. *(Word "remaining" inserted 2026-09-07, W16A-FIX: DAT-005 and
DSK-002 were also chartered over this capability and shipped without it — see `E5-6-denied-egress`'s
`reason` — so an unqualified "the only chartered candidate" reads as a claim source refutes. The
substance of this paragraph, which already named both shipped charters, is unchanged.)*

**What it blocks.** The provider layer can no longer be described as an unadopted-but-available option
for `DE-08`: at the tier AoA's own key reaches, it is available to *declare* and unavailable to
*enforce*. `DE-08` stays `not-delivered`, its clause text is untouched, and the decision about a
Critical control with no available layer is not this finding's to take.

**Do not close this** by adopting `network` with a read-back — §3 is the record of why that is
precisely the move that would produce a false claim of enforcement here. Do not close it by citing
probe (b)'s `yes`: that is the defect, not the remedy. Close it when an enforcement point exists that
was measured by traffic which tried to cross, or when the provider surface is measured to enforce on
a tier AoA actually uses.

### 8. ★★ The allowlist arm was DISPATCHED TWICE on 2026-09-09 and returned `UNRUN` — the documented shape reproducibly fails to place

§6.2 named `allowOut` as the thing this run did not measure. An arm for it was built (runbook §13),
and on 2026-09-09 it was dispatched **twice**, with the founder's authorisation, on
`replatform/w10b-allowlist-arm` @ `899aceeec`, template `aoa-base`:

| | `34328502574` (08:19:42Z) | `34328780645` (08:22:47Z) |
|---|---|---|
| allowlist arm | `UNRUN — NO VERDICT — arm-was-never-created` | `UNRUN — NO VERDICT — arm-was-never-created` |
| `Sandbox.create` returned | `SandboxError: 500: Failed to place sandbox: sandbox creation failed on 3 node(s), please retry; if the problem persists, contact us` | identical |
| policy arm | `i531or2zgvmdlt18e2u2s` **created** | `im9ge2ldwohsitqrtx5rc` **created** |
| anti-vacuity arm | `i13yih10trv4512eugjmz` **created** | `i0xsmm4fzyhr3ep736ge9` **created** |

The body was `denyOut: ["0.0.0.0/0"]` + `allowOut: ["8.8.8.0/24", "1.1.1.1", "example.com"]`. Not one
row ran: every allow/deny/apparatus row reads `no-result/unknown`, `dns` reads `unknown`, and the
guest's `/etc/resolv.conf` was never read.

★ **What makes it evidence rather than noise:** in the **same** run, **seconds** apart, on the **same**
template and key, the sibling arms placed successfully. Only the default-deny + `allowOut` body failed
to place, on both attempts.

★★ **At the strength the evidence supports:** *the shape E2B documents as the fine-grained control
reproducibly **fails to place** at this tier; the cause is unknown and is E2B's to explain.* Three
readings it does not license:

* **Not "the tier refuses the shape."** A `500 … please retry; if the problem persists, contact us` is
  a placement failure with a retry hint, not a validation rejection. The contrast sits in the same
  run: the IPv6 deny arm was refused `400: invalid denied CIDR ::ffff:0:0/96` (§4) — *that* is a
  refusal, and this does not look like it.
* **Not "transient."** It reproduced three minutes apart with successful siblings each time.
* **Not a measurement of enforcement. `UNRUN` is not `INERT`.** §2's inertness verdict is about the
  deny-only shape and **does not extend** to this one, which has never been observed at all.

**Two attempts is the evidence, and this section says two attempts** — it is not a sample from which a
failure rate can be quoted.

**What moves:** nothing in this finding's severity, status, ownership or conclusion, and nothing for
`DE-08`, which keeps `deliveryStatus: not-delivered`; no production path passes a `network` body.
Census row 2b (`E8-F003` §8) stays **UNMEASURED**, now annotated *attempted twice, `UNRUN`*. What
moves is the support ticket, which gains a second, independently checkable item. The full record,
including what would have to change before a third dispatch is worth an authorisation, is
`W10B-egress-enforcement-result.md` §14 and runbook §13.7.

★ **The arm's design is what makes this readable at all.** `UNRUN` carries an `outcome` and never a
`state`, so it took no part in `packDisposition`: both lanes concluded `success`, a non-verdict did
not red a lane that answered every question it was dispatched for, and — the direction that matters
more — a sandbox that never existed did not report as enforcement.

### 9. ★★★ MEASURED 2026-09-11 — the allowlist arm PLACED at last (CIDR-only), and it is FULLY INERT: no destination's egress was blocked (curl-35 is post-connect = reached-then-broke, corrected per Codex P2 on PR #425)

§8 recorded the allowlist arm as `UNRUN` after two dispatches: the domain-bearing body
(`allowOut: [… , "example.com"]`) reproducibly failed to place with a `500`. Runbook §13.7 item 2
prescribed the one-thing-at-a-time fix — drop the hostname — and it was implemented on branch
`e2b-cidr-only-probe` (`ALLOWLIST_ALLOW_SET` narrowed to `["8.8.8.0/24", "1.1.1.1"]`, CIDRs/IPs
only). **That body has now been dispatched and it PLACED.** Workflow run
[`34528397309`](https://github.com/MeteoriteLabs/AoA/actions/runs/34528397309)
(`.github/workflows/keyed-e2b-w10b-egress-enforcement-probe.yml`, ref `e2b-cidr-only-probe`, commit
`8f2c2b7d8`, template `aoa-base`, 2026-09-10). The job succeeded and the probe emitted a durable
record. **Row 2b of the census (`E8-F003` §8) moves from UNMEASURED to MEASURED.**

**The placement itself confirms §7's `validateEgressRules` insight.** The two 2026-09-09 dispatches
carried a hostname in `allowOut`, which forces E2B's `validateEgressRules` to require `0.0.0.0/0` in
`denyOut` **and** routes the sandbox through the tcpproxy (L7) path — which `500`s at create on this
tier. Dropping the hostname routes the sandbox down the plain iptables path, and it created:
sandbox `ipm63v4ubgmzbik13v653`. The arm's prior `UNRUN` status is resolved.

**The read-back materialized (probe question b = YES, verifiable).**
`getInfo().network = {"allowOut":["8.8.8.0/24","1.1.1.1"],"denyOut":["0.0.0.0/0"],"allowPublicTraffic":true}`
— the declared policy, echoed back exactly.

**The rows, read from the run's own record:**

| row | destination | result |
|---|---|---|
| `allow_ip` (positive control) | `1.1.1.1` | **REACHED 301** — the control held |
| `deny_public_ip` | `9.9.9.9` | **REACHED-THEN-BROKE** (`curl (35)`, post-connect) |
| `deny_public_host` | `registry.npmjs.org` | **REACHED-THEN-BROKE** (`curl (35)`, post-connect) |
| `apparatus` | `…must-not-resolve.invalid` | **name-resolution failure** (DNS; not an egress block) |
| **`deny_metadata`** | **`169.254.169.254`** | **REACHED 401** |

**★ THE READING, corrected — the arm blocked NO real destination's egress.** Per the probe's own
`CURL_EXIT_MEANINGS` / `classifyReachEvidence` (`scripts/lib/w10b-egress-enforcement-probe.mjs`),
`curl 35` and `curl 56` are **post-connect**: the TCP connection was MADE and then broke at TLS, so
the destination was **REACHED-THEN-BROKE = reached, not refused** — the classifier admits such rows
*against* enforcement, never for it. `9.9.9.9` and `registry.npmjs.org` were therefore **reached**,
not blocked; the shape demonstrated **no egress blocking at the connection layer**. The only
non-reach was the `.invalid` apparatus control, and that was a DNS **name-resolution** failure — not
an egress block. Reading `curl 35` as "blocked public egress" was the misinterpretation a Codex P2
on PR #425 caught; there is no "real partial capability" here. **The confidentiality-critical
metadata endpoint `169.254.169.254` was also REACHED (401)** — the denied destination that matters
for `DE-08`. So the shape is **FULLY INERT**, verdict **INERT — denied-destinations-still-reachable**:
every denied destination the arm could reach was reached. `updateNetwork` on a warm resume returned
success and the target was **still REACHED** (probe question d = no). This is the same result as the `metadata.egressAllowlist`
seam (`E8-F003` row 1), one API surface over.

**Overall disposition of the run:** `measured — a=no b=yes c=no d=no e=no regression=no`;
`DECISION: abandon (denyout-is-inert-at-this-tier)`. Deny-only arm P re-confirmed: metadata REACHED
under a deny set naming its range (INERT).

**What this MOVES, and what it does not.** It resolves §8's UNMEASURED gap: the documented allowlist
construction is now MEASURED, and it is INERT for the metadata endpoint. This **strengthens** the
finding — the provider layer is now closed on BOTH the deny-only and the documented-allowlist
constructions, on evidence rather than inference — and it does **not** close it. Severity (HIGH),
status (`open`), ownership (`unowned`) and §5's argument are all unchanged. §7's close condition is
**not** met: no enforcement point has been measured by traffic that tried to cross and was stopped
at the destination that matters; the allowlist arm was measured and found NOT to stop it. Two
conjuncts of this finding stay open regardless of this run: **(i)** the refuted-safeguard result
(§3) — the `getInfo()` read-back PASSES on this INERT sandbox exactly as it did on the deny-only one,
so the read-back still certifies an unpoliced-for-metadata sandbox; and **(ii)** the tier question is
closed for ONE tier only (§6.1). Do not close E8-F008 on this run. Record:
`W10B-egress-enforcement-result.md` §15, runbook §13.8.

---

## E8-F009 — The LIVE OAuth SSRF deny table is a hand-written subset of the repo's own private-IP predicate: one IPv4 /24 and EIGHT IPv6 classes are missing, on a path whose next hop is chosen by the remote server

**Status:** resolved_by_w13 · **Owner:** — (closed; the ownership entry is deleted in this commit)
**Successor:** **W13 — PR `replatform/w13-ssrf-parser-consolidation`**, which implements §7's
remedy in §7's order (parser first, then derive the table). See §8 for what it does, what it
proves, and the one class it changes that has a conditional legitimate use.

> ★★★ **THE RESOLUTION IS CARRIED BY THE COMMIT THAT LANDS THE FIX, AND IT IS BRANCH STATE
> UNTIL THAT BRANCH MERGES.** An earlier revision of this entry left it `open` on the reasoning
> that merging is the founder's call, so the finding should not pre-announce its own closure.
> External review (Codex, on `86f2a8644`) argued the mechanics run the other way and **it was
> right**: this PR *is* the commit that satisfies §7's stated resolution condition, so if the
> register still says `open` at the moment it merges, the register is wrong from that instant and
> `finding-ownership.json` reports a live defect that no longer exists. The manifest entry's own
> closing sentence prescribed the same move — *"Resolve = flip findings.md Status + DELETE this key
> in the SAME commit"* — and `check-finding-ownership.mjs` enforces it: a non-open finding that
> keeps a manifest entry is a `stale_declaration` failure.
>
> **Read this as a branch state, not a landed one.** This line is true on
> `replatform/w13-ssrf-parser-consolidation`. **If the founder declines to merge that PR, this
> resolution is discarded with the branch and the finding is `open` again** — there is no separate
> revert to remember, because the register and the fix travel in the same commit history.
> Nothing about the CODE is contingent: the parser fix and the derived table are measured below.
> What is contingent is whether they reach `main`.

**Severity:** MEDIUM — argued in §6, with the case for HIGH recorded rather than dismissed.
**Filed:** W12, 2026-09-07, by **re-deriving from source** the two facts
`server/src/services/w10c-internal-range-deny-set.ts`'s module header records about SHIPPED code.
Both hold. The IPv4 half is exactly as recorded; **the divergence is materially wider than the header
states**, and the widening is this finding.
**Cross-links:** `E8-F003` (sandbox egress is filtered nowhere — a *different* boundary; do not merge
them), `E8-F008` (the W10C module's intended consumer, measured out of existence), the W10C module
itself (a mechanically DERIVED cover, kept partly because it records these two facts).

> ★★★ **NOTHING WAS FIXED BY THE COMMIT THAT FILED THIS ENTRY, DELIBERATELY.**
> `mcp-connector-oauth.ts` is a live SSRF filter on a shipped path and `outbound-url-guard.ts` is
> imported by several production callers. Editing either is a behaviour change to security-relevant
> code, and the FILING unit was tasked to record rather than fix on the stated ground that the
> founder wants to see that diff first — a relayed instruction, marked as such. That filing commit
> touched no file under `server/` or `packages/`. **§8 is a separate, later commit and it does
> change those files.** §1–§7 below are the original diagnosis, left exactly as filed so the
> measurement can still be repeated against the pre-fix tree; §8 records the fix.

### 1. What was re-derived, and how — so it can be repeated rather than believed

`isPrivateIP` (`server/src/services/outbound-url-guard.ts:71`) is this repo's reference predicate for
*"is this address internal"*. `mcp-connector-oauth.ts:11-22` holds two `node:net` `BlockList` tables,
`blockedIpv4` / `blockedIpv6`, transcribed by hand. The two were compared directly: the real
`BlockList` (not a reimplementation of it) against the real `isPrivateIP` (imported from source), by

- **IPv4: a full sweep of all 2^24 /24 blocks.** Both predicates are /24-uniform — every rule on
  either side is stated at /24 granularity or coarser — so one address per block is exhaustive.
- **IPv6: one representative per rule** in `isPrivateIP`'s v6 branch, read off the source rather than
  guessed, plus a public-address control (`2606:4700::1111`, correctly allowed by both).

### 2. IPv4 — the header's claim holds EXACTLY, and there is nothing else

| direction | result |
|---|---|
| `isPrivateIP` rejects, `BlockList` **allows** | **exactly one /24: `192.88.99.0/24`** (deprecated 6to4 relay anycast) |
| `BlockList` rejects, `isPrivateIP` allows | **none** |

So the W10C header's *"Exactly one /24 of disagreement across the whole IPv4 space"* is **true and
precisely stated**, and re-derivation found no second IPv4 hole. ★ The word doing load-bearing work
in that sentence is **IPv4**, and §3 is why that matters.

### 3. ★★★ IPv6 — EIGHT classes are missing, and this is NOT in any existing record

Each row: `isPrivateIP` rejects it, the OAuth `BlockList` **does not**.

| what `isPrivateIP` rejects | the OAuth table's coverage | example that passes the filter |
|---|---|---|
| **any address with a zero leading word** (`::/16`) | only `::/128`, `::1/128`, `::ffff:0:0/96` | `::a9fe:a9fe` — the IPv4-compatible hex spelling of `169.254.169.254` |
| `64:ff9b::/48` — contains the **NAT64 well-known prefix** `64:ff9b::/96` | absent | `64:ff9b::a9fe:a9fe` — carries `169.254.169.254` |
| `64:ff9b:1::/48` — NAT64 local-use | absent | `64:ff9b:1::1` |
| `2001:2::/32` benchmarking | absent (`2001::/32` and `2001:db8::/32` only) | `2001:2::1` |
| `2001:` with second word `0x0010`–`0x002f` (ORCHID) | absent | `2001:10::1`, `2001:2f::1` |
| **`2002::/16` — 6to4** | absent | `2002:a9fe:a9fe::1` — embeds `169.254.169.254` |
| `3ff0::/12` — the predicate rejects the whole `0x3ff0`–`0x3fff` span, wider than RFC 9637's `3fff::/20` | absent | `3ff0::1`, `3fff::1` |
| `fec0::/10` deprecated site-local | absent | `fec0::1` |

★★★ **The 6to4 row is the one that reframes the whole entry.** The already-noticed IPv4 gap
(`192.88.99.0/24`) is the **relay anycast end** of the 6to4 tunnel; `2002::/16` is the **address end**
of the same tunnel. The W10C module says of its own `2002::/16` entry, verbatim: *"The v6 side of the
192.88.99.0/24 tunnel; denying only one end of a tunnel WOULD be denying neither."* The OAuth table
denies **neither** end. Reporting the divergence as "exactly one /24" is therefore true of IPv4 and
misleading as a summary of the table's coverage, which is the reason this is filed as its own finding
rather than left as a line in a module comment.

**Two of these are translation vectors, not merely reserved ranges.** `64:ff9b::/96` (NAT64) and
`2002::/16` (6to4) both *embed an IPv4 address* and both exist to be translated to it by a gateway.
In a deployment with DNS64/NAT64 — an ordinary IPv6-only cluster configuration — an AAAA answer of
`64:ff9b::a9fe:a9fe` passes this filter and lands on the IPv4 cloud-metadata endpoint. Whether AoA
runs in such a deployment is **not** established here (§5).

### 4. The parser defect, re-derived — and it is not confined to the deny-set module

**`isPrivateIP('::169.254.169.254') === false`. Confirmed.** The mechanism, read off the source:

- The IPv4-mapped unwrap at `outbound-url-guard.ts:75-76` matches `^::ffff:(dotted quad)$` **only**.
- `parseIpv6Words` is then asked to parse `::169.254.169.254`; its per-token regex **forbids dots**,
  so the address never becomes words and never reaches the v6 range checks.
- The IPv4 branch then splits on `.` and gets `["::169","254","169","254"]`; `Number("::169")` is
  `NaN`, so the octet guard rejects it and every `startsWith` check misses.

Three things follow, and the second is the one the tasking brief asked to be checked:

1. **The OAuth table allows it too.** `isIP("::169.254.169.254")` returns `6`, and
   `blockedIpv6.check` finds no match — `::/128` and `::1/128` are single addresses and the value is
   `::a9fe:a9fe`. So **both** the reference predicate and the live table let that literal through.
2. ★★ **`isPrivateIP` is a production import with several callers, so the parser defect is not
   confined to the deny-set module.** Measured by grep at this tip, the production call sites are:
   `outbound-url-guard.ts:205` and `:239` (inside `validateAndResolveFetchUrl` — the shared outbound
   SSRF defense used by the plugin HTTP service and the `http` adapter, per its own header) and
   `egress-policy.ts:202` (`classifyAddress`, which returns `"private"`). The W10C module is a
   **fourth** consumer and the only one that compensates: its `::/16` entry covers the address the
   predicate misparses, which is why its header calls itself a strict superset that *"fails CLOSED"*.
   The three production callers have no such compensation.
3. **`egress-policy.ts`'s own `parseIp` DOES accept an embedded dotted quad** — so the tree already
   contains a parser that handles this spelling correctly, one module away from the one that does
   not. That is the divergence class the W10C module was built to make visible.

### 5. The trust boundary — why this is a filter with a hole and not a hardening nice-to-have

`assertSafeOAuthUrl` and `assertPublicResolvedAddress` are the **sole** address filter on this path,
and they share these two tables. Both the literal-IP check and the DNS-resolved-address check go
through them (`safeLookup` → `resolvePublicOAuthHost` → `assertPublicResolvedAddress`, wired into
`https.request` as its `lookup` at `:141`, so the production path pins the resolved address rather
than merely validating the URL).

★★★ **What the filter is holding back is not an operator typo. It is a REMOTE party choosing the next
hop.** Measured against `mcp-connector-oauth.ts` at this tip:

| hop | who supplies the host | validated by |
|---|---|---|
| the connector URL | an AoA operator registering an MCP connector | `assertSafeOAuthUrl` (`:329`) |
| `authorization_servers[0]` from the remote protected-resource metadata | **the remote server** | `assertSafeOAuthUrl` (`:341`) — and the server then fetches `{as.origin}/.well-known/oauth-authorization-server` |
| `issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint` from the remote AS metadata | **the remote server** | `assertSafeOAuthUrl` (`:353-357`) |
| `registrationEndpoint`, which is then **POSTed to** | **the remote server** | `assertSafeOAuthUrl` (`:382`) |
| a redirect `Location` on any metadata fetch | **the remote server** | `assertSafeOAuthUrl` (`:245`), plus a same-origin constraint |

Only the first row is operator-chosen. Rows two through five are attacker-influenceable by whoever
controls the connector the operator registered, and the deny table is what stands between that party
and an internal address. **A hole in it is a hole in the only control on that hop.**

**What is NOT established, stated so none of it is over-read.**

- **No exploit was run.** Nothing was fetched, no request was issued, and no deployment was probed.
  This is a source-derived coverage diff plus a reading of the call graph.
- **Routing is deployment-dependent.** Whether `64:ff9b::/96` or `2002::/16` actually reaches an
  internal address depends on whether the host's network translates them. IPv4-compatible
  (`::a.b.c.d`) is deprecated and most stacks do not translate it at all. **Unmeasured here.**
- **The IPv4-MAPPED range is fully covered** (`::ffff:0:0/96`), so the most common bypass spelling —
  `::ffff:169.254.169.254` — is blocked. That is the table doing its job, and it is recorded because
  the finding would be dishonest without it.
- **`E8-F008` §4's IPv6 flank is a DIFFERENT boundary.** That one is about a provider deny set on
  sandbox egress. This one is about an in-process filter on control-plane HTTP. They share a lesson
  (an IPv4-only table is routed around in IPv6 spellings) and nothing else; merging them would blur
  two boundaries with different owners.

### 6. Severity — MEDIUM, argued, with the case for HIGH recorded

**For HIGH.** It is a live defect in shipped code, not a design-time result: the filter runs wherever
an OAuth-bearing MCP connector is configured (**which deployment modes reach it was not checked here
and is not claimed**), it is the *sole* address control on a hop whose host a remote party chooses,
and two of the eight missing classes are translation prefixes that exist precisely to carry an IPv4
destination. The failure direction is also silent — a request that should be refused is simply made.

**For LOW.** Every missing range is deprecated, documentation, or special-use; the mapped range (the
spelling a URL parser actually canonicalises to) IS covered; the first hop is operator-registered;
and no exploit path has been demonstrated end to end.

**MEDIUM is where it lands, and the reason is that the deciding fact is UNMEASURED rather than
absent.** If AoA is deployed anywhere with DNS64/NAT64 — an ordinary IPv6-only cluster setup — the
`64:ff9b::/96` row is a working metadata-SSRF vector and this is HIGH. If it is not, the entry is a
coverage gap in ranges nobody routes and MEDIUM is generous. ★ **The measurement that would settle it
is a deployment question, not a code question**, which is precisely why it is filed at MEDIUM with the
condition named rather than argued to a number from the source alone.

### 7. What would close it, and the trap in the obvious fix

The obvious fix — hand-adding `192.88.99.0/24` and eight IPv6 rows to the two `BlockList` tables — is
**how this defect was born**. A hand-transcribed table diverged from the predicate once and will
again; the tree already carries four representations of "internal range" for exactly this reason (the
W10C module's DIVERGENCE LEDGER). The durable close is to make the OAuth tables **derived** from the
one predicate — which is what `INTERNAL_RANGE_DENY_CIDRS` already is, mechanically, and re-derived
against `isPrivateIP` in CI on every run — or to have `assertSafeOAuthUrl` call `isPrivateIP`
directly. ★ **Either move requires the parser defect in §4 to be fixed first**, or the OAuth path
would *lose* coverage it has today: `isPrivateIP` returns `false` for `::169.254.169.254`, so
delegating to it naively would be a regression on a v6 spelling. That ordering is the reusable half
of this finding and is the reason it is filed with a remedy sketch rather than a patch.

### 8. The successor — what W13 does, and the one thing it changes that is not free

Filed as an addendum on 2026-09-07 by the unit that built it, so this register carries the
outcome rather than only the diagnosis. **This section IS the resolution**, on the terms set out
under **Status** above: it is true on the successor's branch, and it goes with that branch if the
branch does not merge.

**WHAT IS CLOSED, CLAIM BY CLAIM, so "resolved" is checkable rather than asserted.** This finding
made two independent claims and both are closed by the successor:

| claim | where filed | closed by | measured at the successor's tip |
|---|---|---|---|
| **A — range divergence**: the OAuth table misses one IPv4 /24 and EIGHT IPv6 classes that `isPrivateIP` rejects | §2, §3 | the derived table (item 2 below) | the full 2^24 IPv4 sweep reports **zero** addresses where `isPrivateIP` rejects and the table allows; the IPv6 difference is computed exactly over 2^128 and `OLD \ NEW` is empty — `w13-oauth-deny-table-divergence.test.ts` §1–§2 |
| **B — parser defect**: `isPrivateIP('::169.254.169.254') === false`, **and** it is not confined to the deny-set module because `isPrivateIP` has three production callers with no compensation | §4 | the single leaf parser (item 1 below) | `isPrivateIP('::169.254.169.254')` is now `true`. The three call sites are the same three, re-grepped: `outbound-url-guard.ts:188` and `:222` (was `:205`/`:239` — the lines moved because the local parser was deleted) and `egress-policy.ts:119` (was `:202`). All three read the FIXED predicate, so there is nothing left for them to compensate for |

★ **ONE THING §5 RECORDED IS DELIBERATELY *NOT* CHANGED, AND IT IS NOT PART OF EITHER CLAIM.**
§5 noted — correctly — that the IPv4-mapped range `::ffff:0:0/96` is *fully covered* by the table.
It still is. External review (Codex) then observed that `isPrivateIP` **allows**
`::ffff:<public v4>` while the table **denies** it, in either table, and that the divergence suite's
probes never generated that case. That is a **DENY-MORE** divergence in the opposite direction to
this finding, it is **pre-existing and identical before and after W13**, and it is now exercised and
pinned as an intentional superset exception rather than described in prose — see the two
`IPv4-MAPPED:` tests. **It does not hold this finding open**: E8-F009 is about the table denying too
LITTLE, and nothing here denies too little any more.

**It follows §7's ORDER, because §7's ordering was the reusable half of this finding.**

1. **The parser first.** `outbound-url-guard.ts`'s local `parseIpv6Words` and
   `egress-policy.ts`'s `parseIpv4`/`parseIpv6Value`/`parseIp` are both deleted and replaced
   by ONE leaf module, `server/src/services/ip-literal.ts`, which both import.
   `egress-policy.ts` already imports `isPrivateIP` from `outbound-url-guard.ts`, so reusing
   its `parseIp` in the other direction would close an import cycle — the grammar is lifted
   BELOW both instead. Parser count goes 2 → 1, not 2 → 3.
   `isPrivateIP('::169.254.169.254')` is now `true`.
2. **Then the table.** `mcp-connector-oauth.ts` builds its two `BlockList`s from
   `INTERNAL_RANGE_DENY_CIDRS` — the mechanically derived, CI-re-derived cover of
   `isPrivateIP` — instead of a hand-typed list. `scripts/gate-clause-wiring.json` moves
   `E8-w10c-internal-range-deny-set` from `unwired` to `wired`; that entry had already named
   this exact promotion condition.

**What was proven, and how.** IPv4: a full 2^24 sweep of the old table against the new one —
**zero** addresses move denied → allowed, and the allowed → denied set is **exactly**
`192.88.99.0/24`. IPv6: both tables are CIDR lists, so their difference is computed by exact
interval arithmetic over the **whole 2^128 space** — `OLD \ NEW` is empty, and `NEW \ OLD` is
exactly the eight classes §3 lists. The superset property is therefore proven, not sampled.

★★★ **THE ONE CLASS THAT IS NOT FREE, AND IT IS NAMED HERE RATHER THAN BURIED.**
`64:ff9b::/96` is a **translation** prefix, not a host range. Nothing *lives* there — but in an
IPv6-only deployment running DNS64/NAT64, a perfectly legitimate IPv4-only destination (an
OAuth issuer with only an A record, say) is presented to the host *as* `64:ff9b::<v4>`. Denying
the prefix would refuse it. Two facts bound that risk and neither is an argument that the risk
is zero: (a) `isPrivateIP` **already** denies `64:ff9b::/48`, so the shared outbound guard —
the plugin HTTP service and the `http` adapter — already takes this posture on every other
outbound path, and an IPv6-only AoA deployment would already be failing there; (b) this is the
same deployment question §6 says is the deciding fact for severity, and it remains
**unmeasured**. The successor makes the OAuth path consistent with the rest of the product; it
does not settle (b). **A founder who knows AoA runs anywhere IPv6-only should say so before
this merges.**

### 9. Ownership — historical, and why the manifest entry is now GONE

**This section records why the finding was `unowned` while it was open. It is kept because the
reasoning is reusable, not because anything still needs an owner** — the finding is resolved above
and `scripts/finding-ownership.json` no longer carries an `E8-F009` key. `check-finding-ownership.mjs`
requires exactly that pairing: it reports `stale_declaration` for any manifest entry whose finding is
no longer open, so leaving the entry behind would have converted a closed defect into a permanent
phantom on the open-findings list.

**Owner — was `unowned`, and it was a real disposition rather than a shrug.** No ticket in the re-platform
tree owns `mcp-connector-oauth.ts`: it is main-line product from the OAuth connector broker work
(Decision #110), not re-platform surface, and E8's open tickets are about sandbox egress — a
different boundary with a different threat model (`E8-F003`, `E8-F008`). Attaching it to one of them
would be false ownership of the kind the ownership guard exists to catch. It is filed in E8's register
because that is where the deny-set family and the derivation machinery already live, and because
`w10c-internal-range-deny-set.ts` — the module that first recorded these two facts — is enrolled in
`scripts/gate-clause-wiring.json` as `E8-w10c-internal-range-deny-set` and names *"fixing the measured
`mcp-connector-oauth.ts` divergence against a derived source of truth"* as one of the four things that
would promote it — **which W13 has now done, so that clause reads `wired` on this PR's branch.**
**It blocks nothing in the re-platform programme.** It needs a founder decision about a live
security path, and W13's PR is the shape that decision can take.

---

## E8-F010 — The differential oracle for the egress-policy gate denied a STRICT SUBSET of production on IPv6, and the fixture exercised no divergent range, so the lane could not have failed on any of it

**Status:** resolved_by_w17 · **Owner:** — (closed; no ownership entry is created)
**Successor:** **W17 — PR `replatform/w17-ipv6-closeout`**, the same commit that files this entry.
See §5 for what it changes and what it proves.

**Severity:** MEDIUM — the divergence never produced a wrong ALLOW in production (the oracle is a
test-lane reference, not an enforcement point). What it produced is a **guard that could not fail**,
which is this programme's most-repeated defect class and the reason the severity is not LOW.

**Filed:** W17, 2026-09-08, by re-deriving both implementations from source and computing their exact
difference over the whole 2^128 IPv6 space.
**Cross-links:** `E8-F009` (the same predicate family; its §4 spelling `::169.254.169.254` is the
address this oracle got RIGHT and production got WRONG), `E8-F003`/`E8-F008` (sandbox egress — a
different boundary; do not merge them).

### 1. What

`scripts/check-egress-policy-vectors.mjs` is the independent reference verifier for the DAT-005
egress-policy vectors gate. It carries its own from-scratch `isPrivateIp`, deliberately NOT importing
`server/src/services/outbound-url-guard.ts`'s `isPrivateIP`, so that two implementations pinned to one
fixture cannot silently diverge.

**MEASURED, before W17.** Its IPv6 half denied exactly seven ranges: `::/16`, `fc00::/7`,
`fe80::/10`, `fec0::/10`, `ff00::/8`, `2001:db8::/32`, `2002::/16`. Production denied all seven AND
`64:ff9b::/47`, `100::/64`, `2001::/32`, `2001:2::/32`, `2001:10::/28`, `2001:20::/28` and the
`3ff0::/12` band. The oracle was therefore a **strict subset** of the thing it was checking, in one
direction only — it could never disagree by denying more, and it silently agreed by allowing more.

**And the fixture could not expose it.** `tests/fixtures/egress-policy/v1/vectors.json` carried seven
IPv6 addresses across its allow and deny vectors, and **not one of them was inside any divergent
range**: they were `2606:4700::6812:2007`, `2606:1234:5::10`, `::10`, and four `::ffff:` mapped forms.
So the `policy` lane passed regardless of how far the two implementations drifted apart.

### 2. Why this is worse than a missing range

The oracle was **RIGHT where production was WRONG**. Its `::/16` clause covers `::169.254.169.254` —
the exact spelling `E8-F009` §4 measured `isPrivateIP` returning `false` for, on a live SSRF path. A
real defect sat in shipped code with a correct independent answer already in the tree, and there was
no test comparing the two. The mechanism that would have caught it existed and was never pointed at
the question.

### 3. Why the obvious repair is wrong

The tempting fix is to have the oracle call `isPrivateIP`. That deletes the only independent answer
this tree has ever had to "is this address internal", and an oracle that calls the thing it checks
cannot disagree with it — it would convert a guard that was merely un-exercised into one that is
structurally incapable of firing. Under `E8-F009` the repaired-that-way oracle would have agreed with
the defect.

### 4. Scope note — the OTHER three private-range representations were checked

`w10c-internal-range-deny-set.ts` (a mechanically derived cover, CI-re-derived),
`mcp-connector-oauth.ts` (built FROM that cover since W13) and `egress-policy.ts`'s
`METADATA_DENY_CIDRS` (three host routes, not a private-range table). A tree-wide grep for
`169.254` / `fc00` / `fe80::` / `2001:db8` over `.ts`/`.mjs`/`.js`/`.json` found no fifth predicate.
`scripts/lib/w10b-egress-enforcement-probe.mjs` carries deny CIDRs for the E2B probe but is not a
predicate over an address.

### 5. Resolution

W17 widens the oracle's IPv6 half **from the IANA IPv6 Special-Purpose registry** (retrieved
2026-09-08, sha256 `775feea0621dec8735a44fbf30f762e721e8f0a1b3ab7eb341961a88cfce2139`) rather than
from production's source, so it stays an independent implementation. It then:

1. adds **eleven** IPv6 deny vectors to the fixture, one in every previously-divergent range, so the
   lane now exercises what it could not see;
2. adds `server/src/__tests__/w17-ipv6-range-closeout.test.ts`, which re-derives production's exact
   IPv6 prefix cover from the live predicate and computes the **exact symmetric difference** against
   the oracle's CIDR list by interval arithmetic over the whole 2^128 space. The oracle-only direction
   is pinned **empty**; the production-only direction is pinned to **exactly four intervals** — the
   three bands where production deliberately over-blocks relative to the registry (`64:ff9b::/47` vs
   RFC 6052's `/96`, `2001:2::/32` vs RFC 5180's `/48`, `3ff0::/12` vs RFC 9637's `3fff::/20`). The
   set is STATED, not asserted to be empty;
3. adds a source-text guard asserting the oracle imports nothing but `node:` builtins, so the
   "just import production" repair reds by name.

**Mutation-tested.** Deleting production's `2002::/16` clause reds three cases in the new file naming
`2002:0:0:0:0:0:0:0 .. 2002:ffff:…` — including the oracle-only assertion — **and** reds the
fixture-bound production classifier on `ipv6_6to4_carrying_imds`. Narrowing the `3ff0..3fff`
leading-word band to `3ffe..3fff` reds naming the vacated `3ff0:: .. 3ffd:ffff:…` span. Making the oracle import production reds the independence
guard naming the specifier. The positive control is the shipped state: the oracle remains independent
and diverges from production by four intervals, and every lane is green.

## E8-F011 — DE-11 asserts four controls over sensitive browser artifacts and all four are absent, one of them structurally excluded rather than merely missing, and the hand audit that measured them has lived outside every register since it was written

**Status:** open · **Owner:** `unowned` (see the disposition — BRW-003c is design-only and REL-001 is unwritten)
**Severity:** HIGH
**Filed:** 2026-09-08, by W20 (the DE-audit landing unit), which re-verified every claim below
at tip `360d0b0ed` before filing.

**Why this is filed as a finding and not just a register edit.** `docs/architecture/distributed-execution-threat-controls.json`
recorded DE-11 (*"Browser cookie/trace leakage"*, High) as `deliveryStatus: "unaudited"` with the
evidence prose *"no delivery audit has been performed for this crossing"* — while
`docs/replatform/FINDING-retention-authority-and-DE-11.md`, committed and unmodified in the tree,
is a hand audit of exactly that crossing concluding that **none of its four controls exist**. Two
committed records of the same crossing said opposite things, and nothing could see the
contradiction, because `check-finding-ownership.mjs` globs only
`docs/replatform/epics/*/findings.md` (`findRegisters`, `scripts/check-finding-ownership.mjs:29-37`)
and a top-level `FINDING-*.md` is outside that glob. This entry is the register home that document
never had; the document itself remains the home of the mechanism, so the measurement lives in
exactly one place.

**The four controls, each re-measured at tip (not inherited from the source document).**

| DE-11 clause, verbatim | Measured state at `360d0b0ed` |
|---|---|
| `trustedSide`: "a job-scoped sensitive-artifact store **with a TTL**" | ★ *Superseded in part — see the CORRECTIONs below; this row is sound about the application, `UNKNOWN` about the bucket.* **No TTL exists in the application.** `ARTIFACT_RETENTION_CLASSES` is four bare names — `["ephemeral","run","audit","checkpoint"]` — with no durations (`packages/worker-protocol/src/policy.ts:201`). Every duration-bearing "retention" in the tree belongs to an unrelated subsystem (`packages/db/src/backup-lib.ts`, `packages/db/src/schema/memory_settings.ts:40`, `packages/adapters/acpx-local/src/server/execute.ts:61`). |
| `confidentiality`: "sensitive browser artifacts are **encrypted** and TTL-bounded" | ★ *Superseded in part — see the CORRECTIONs below; `UNKNOWN` pending `get-bucket-encryption`.* **The application never asks for encryption.** The single upload path builds `PutObjectCommand` with `Bucket / Key / Body / ContentType / ContentLength` and nothing else (`server/src/storage/s3-provider.ts:159-165`). A grep for `ServerSideEncryption\|SSEKMS\|BucketEncryption\|aws:kms` across `server/`, `packages/`, `ui/` and `scripts/` returns **zero** hits. |
| `revocation`: "TTL expiry and job completion **purge** sensitive artifacts" | ★ *Split by the CORRECTIONs below: TTL-expiry half `UNKNOWN` pending `get-bucket-lifecycle-configuration`; **purge-on-job-completion half stays MEASURED ABSENT**, since a lifecycle rule cannot observe job completion.* **Nothing in the application purges, and the refusal is structural rather than merely missing.** `isSweepEligible` refuses `status === "committed"` outright (`server/src/services/artifact-orphan-sweep.ts:79`) and refuses any row with a committed sibling (`:83`); the candidate query selects `status = 'granted'` only (`packages/db/src/repositories/tenant/index.ts:328`); and `markSwept`'s UPDATE is WHERE-guarded to `'granted'` (`:345-348`). No `PutBucketLifecycle` / `LifecycleConfiguration` exists anywhere. A committed sensitive artifact can never be collected by any shipped path. |
| `audit`: "sensitive-artifact access and **retention are audited**" | **Nothing audits either.** The only observation of a retention decision is a `logger.warn` (`server/src/services/artifact-commit.ts:174`), and the code's own comment three lines above says so in these words: *"This is a LOG LINE, not an audit record — DE-11 claims retention is audited and nothing audits it; this ticket does not pretend to close that"* (`:172-173`). The download-grant branch records nothing durable at all (`server/src/services/artifact-transfer-grant.ts:186-206`). |

★ **CORRECTION 2026-09-09 (W22), on external review: parts of those four rows overstate what
source can establish, and the register has been amended accordingly.** The TTL, encryption and
purge rows above are all sound about **the application** and, in part, unsound about **the
system**. Encryption and TTL can be delivered entirely by artifact-bucket configuration that the
application never expresses and that a repository checkout cannot see: a bucket with default
server-side encryption encrypts the bytes though `PutObjectCommand` never asks, and an expiration
lifecycle rule TTL-bounds the objects though no `PutBucketLifecycle` call exists. **The absence
of `ServerSideEncryption` in source therefore proves nothing about encryption at rest** — proving a
control ABSENT needs strictly more evidence than proving it present, and a grep is not that
evidence. Those sub-properties now read `UNKNOWN` pending bucket inspection in
`docs/architecture/distributed-execution-threat-controls.json`, not "measured absent".
★ **The same commit that filed the absence claim already contained its refutation**:
`docs/replatform/DE-AUDIT-live-experiments.md` DE-11 (a) and (b) name
`get-bucket-encryption` and `get-bucket-lifecycle-configuration` as the reads that settle exactly
these clauses.

★★ **CORRECTION 2026-09-09 (W22B), on the review of that correction: W22 over-corrected, and the
rule it violated is the one this entry now leads with — THE UNIT OF CORRECTION IS THE CLAUSE AND
THE CONJUNCT, NOT THE ROW.** W22 downgraded the **whole** `revocation` row because one of its two
conjuncts had become unknown. `revocation` reads *"**TTL expiry and job completion** purge
sensitive artifacts"*, and only the first conjunct is bucket-settable:

- **TTL expiry → `UNKNOWN`** pending (b). An expiration lifecycle rule deletes on object age with
  no application code at all.
- **Purge on job completion → MEASURED ABSENT, and it stays absent whatever (b) returns.** An S3
  expiration rule fires on object age plus prefix/tag; **it cannot observe job completion**.
  Nothing in the commit path writes a completion-derived tag or key, and no code calls
  `PutBucketLifecycle` to install a rule at all. The application-side refusal in the row above is
  structural and stands. Downgrading this to `UNKNOWN` discarded a measured revocation gap.

**The `audit` row is likewise unaffected and stays a measured absence** — the record it names is an
application artefact and no bucket setting can supply it. **The finding's own verdict does not
move**: DE-11 stays `partial`, and this stays open, because two-and-a-half `UNKNOWN`s over a
measured missing purge-on-completion and a measured missing audit record is not a controlled
crossing either. What changes is that the register neither claims to know something it did not
measure, **nor forgets something it did**. *(These paragraphs are why the heading's "all four are
absent" is retained rather than rewritten: the heading records what was filed on 2026-09-08, and
these record what it was corrected to. Every **present-tense** assertion below has been brought
into line with them; the dated measurement table has not, because it is a record of what was read
at `360d0b0ed` — see the ★ markers in its three affected cells.)*

**What is NO LONGER true, and must not be re-cited.** The source document's §3 — *"the commit path
takes the worker's word ... the module that exists to deny this privilege has zero production
callers"* — was **closed by DAT-010** and is stale. Retention is now derived control-plane-side
before the mutator call and the manifest's declaration is explicitly ignored:
`resolveStoredRetention` (`server/src/services/artifact-retention-authority.ts:49-53`) is called at
`server/src/services/artifact-commit.ts:166` and its result stored at `:202`. `browserArtifactRetention`
now has a production caller chain two hops deep. `DAT-010-result.md:4` records the closure.

**§1 of that document — the four absent controls — DOES NOT hold in full** (amended by W22B; it
said "still holds in full" until the corrections above were written and that sentence then
contradicted them). What §1 establishes, and what this finding carries forward, is narrower and
exact: **the application implements none of the four**, which is a measured fact; **two of them
and half of a third are `UNKNOWN` at the system level** pending the bucket reads; and **two
sub-properties remain measured absences that no bucket setting can supply — purge on job
completion, and the retention audit record.**

**Blast radius today.** Nothing in production uploads `browser_cookie_state` /
`browser_storage_state`: BRW-003 is unbuilt. There is no live leak. What is live and wrong is the
**record** — a High-severity crossing was documented as controlled by four mechanisms, **none of
which the application builds, two of which are known-missing outright (purge on job completion,
the retention audit record), and the rest of which nobody has checked the deployed bucket for**
(amended by W22B; this sentence read "none of which are built", a present-tense absence claim the
corrections above retract). That is worse than an uncontrolled crossing because a reader of the
register stops looking. That is the same defect class as DE-08 (`E8-F003`), one severity down.

**Disposition — `unowned`, with the reason stated rather than implied.** DE-11's owner tickets are
BRW-003, BRW-004 and REL-001. BRW-004 shipped (`BRW-004-result.md`) and covers browser
secrets/network/human-approval, not retention. BRW-003's retention slice — **BRW-003c** — is
**design-only**: `docs/replatform/epics/E8-browser-automation/tickets/BRW-003c-design.md` exists
with **no result file**, and its own §1 already states that `job_artifacts.expiresAt` has zero
readers and zero writers. REL-001 has **zero files on disk** and is declared deferred in
`docs/architecture/distributed-execution-release-tests.json` behind two unshipped epics (BRW-006,
SVC-007). So no ticket that exists on disk owns closing any of the four clauses. NOT `accepted`:
HIGH may never be accepted.

**Resolution condition.** Either (a) BRW-003c ships and delivers TTL + purge + audit, and an
encryption decision is taken for the artifact bucket, at which point DE-11's `deliveryStatus`
moves off `partial` on a recorded measurement; or (b) the DE-11 clauses are AMENDED to state what
the programme actually intends to build, which is a founder decision and is not taken here.
Resolve = flip this Status **and** delete the `E8-F011` key in `scripts/finding-ownership.json` in
the SAME commit.

## E8-F012 — DE-08's confidentiality guarantee was relocated onto the credential taxonomy by the 2026-09-11 founder ruling, and the taxonomy's airtightness — that no host or cross-tenant secret ever reaches a sandbox — is now load-bearing for a Critical control and is not verified as an enforced, CI-run invariant across every sandbox stage-in path

**Status:** open · **Owner:** `unowned` (no owner ticket names the taxonomy-airtightness verification; the follow-up the decision paper flagged as its own strongest counter-argument)
**Severity:** HIGH
**Filed:** 2026-09-11, as the recorded consequence of the founder ruling on `DE-08` / `E8-F003`
(options 1 + 3 + 4 of `docs/replatform/DECISION-REQUEST-de08-sandbox-egress.md`).

**Why this is filed.** The 2026-09-11 founder ruling amended `DE-08`'s
`confidentiality`/`authorization`/`integrity`/`control` clauses so that, at the managed-shared E2B
tier, the confidentiality of a **Critical** SSRF control is no longer carried by provider egress
denial (measured absent on all three constructions — `E8-F003`, `E8-F007`, `E8-F008`) but by the
**credential taxonomy**: `docs/aoa/plans/2026-08-05-cloud-execution-isolation-e2b-spec.md:149-155`
(§9) states that host/operator/cross-tenant secrets (`DATABASE_URL`, the secrets master key,
`GITHUB_PAT`, `BETTER_AUTH_SECRET`/`AOA_AGENT_JWT_SECRET`, `REDIS_URL`, the embeddings key, the
operator `~/.claude` login and its env forms, and any host-ambient provider key that is not the
tenant company's own) **never enter the VM**, only the company's own runtime credentials do, and the
compromised-VM blast radius is that one company's own data and own provider key. That relocation is
sound only if the taxonomy actually holds for **every** sandbox stage-in path.

**What is load-bearing and unverified.** The taxonomy's enforcement is the spec's §10 env-allowlist
unit test — "asserts the never-in-VM set is **absent**". This finding does **not** claim that test is
missing or failing; it records that **nobody has verified**, as an enforced and CI-run invariant, that
the from-scratch allowlist (U5) is applied on every VM run (org heartbeat, crew, Commander, U13
extraction, warm resume) and that the never-in-VM set is absent from each — the spec's own §5/U5 audit
notes that the scrub was **opt-in** ("fires only for connector runs and crew") before the flip, which
is exactly the kind of per-path gap that would leave a host secret in a VM that can reach the metadata
endpoint. Until that is a single, exhaustive, CI-gated assertion over all stage-in paths, the
confidentiality of a Critical control rests on an assumption, not a measurement.

**The residual this sits on, stated so it is not read away.** `169.254.169.254` is **reachable** from
inside the guest on every measured construction (`E8-F003`, `E8-F008`), and what a token-bearing caller
would extract from the provider metadata service is **unmeasured** (`E8-F003` §2 scope). The taxonomy
bounds the blast radius only to the extent that the VM holds nothing worth exfiltrating; a single host
or cross-tenant secret leaking into VM env on any path turns a conceded metadata reachability into a
cross-boundary exposure with no other layer to catch it, because — per the ruling — none exists at this
tier.

**Resolution condition.** Either (a) an enforced, CI-run invariant is built that asserts BOTH: (a-i)
across **every** sandbox stage-in path, that the §9 never-in-VM set is absent from VM env (the §10
env-absence test generalised from opt-in to exhaustive and gated); **AND (a-ii) that the reachable
metadata service (`169.254.169.254`) yields no infrastructure or cross-tenant credential a token-bearing
guest could use to cross a boundary** — because env-absence alone is INSUFFICIENT (Codex P1, PR #432):
a clean VM env still leaves the measured-reachable metadata endpoint as a second credential-egress
path, so an env-only invariant can pass while an IMDS token returns a usable infra/cross-tenant secret.
Only when BOTH hold does DE-08's amended `confidentiality` clause rest on a measurement rather than a
design assertion; or (b) the founder amends DE-08 again to state a narrower guarantee. Not `accepted`: HIGH may never be accepted, and this
carries the confidentiality of a Critical control. Resolve = flip this Status **and** delete the
`E8-F012` key in `scripts/finding-ownership.json` in the SAME commit.
