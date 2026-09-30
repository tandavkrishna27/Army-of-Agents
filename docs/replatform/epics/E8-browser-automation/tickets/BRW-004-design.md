# BRW-004 — Browser secrets, network, and human approval — DESIGN

**Epic:** E8 · **Lane:** B (`C:\e8`) · **Start SHA:** `203853b3a`
**Terrain:** [`BRW-004-terrain.md`](./BRW-004-terrain.md) — read it first; every claim below is
sourced there.
**Status:** design for review. **Two decisions are ESCALATIONS, not choices this design may take
alone** (§2 D1, §7 Q1). The work plan below is written so slices (a)–(d) land regardless of how they
are answered.

---

## 0. ★ The size correction: BRW-004 is not an M

`program-design.md:984` sizes BRW-004 **M**. That size is only defensible if the wire work is the
work. Terrain §1 measured the opposite: the frozen v1 protocol already carries every message this
ticket needs — `browser_approval_requested`, the `permission` runtime-decision request, its
`runtime_decision_result` control command, `network_denied` with a closed denial vocabulary, and both
`secretHandles` and `networkPolicy` on the job envelope. **No Protocol Custodian ticket is required
and none should be opened.**

What is missing is every producer and every consumer around that wire, across four independent
builds:

| Build | Clause | Terrain |
|---|---|---|
| **A — approval loop** | "denial/timeout fails closed" | §2, §2a, §3, §4 |
| **B — egress enforcement** | "allowed domains … enforced" | §5 |
| **C — connector credential materialization** | "materialize scoped session or connector credentials through the control-plane broker" | §6, §7 |
| **D — session-state destruction** | "session state is destroyed at terminal state" | §8 |

Realistic size: **L**, and build A contains a piece (§2 D1) that may not be E8's to build at all.
Recording the correction rather than silently absorbing it, per `E4-F013`'s lesson that an
unacknowledged owner is no owner.

---

## 1. What this ticket is NOT

Scope fences, so no slice quietly claims a neighbour's clause:

- **Not the byte-egress transfer mechanism.** Under an E4-D02 Custodian STOP
  (`HANDOFF-lane-b-browser-service.md` §10). BRW-003's.
- **Not the evidence pipeline or the control-plane read surface.** BRW-003 / BRW-005 / BRW-006
  (`program-design.md:831, 837`).
- **Not per-workload template selection, browser capacity advertisement, or the `aoa-browser`
  image.** Explicitly deferred by `BRW-002-result.md` §6 to BRW-005/D3.
- **Not the agent-facing browser-request tool.** BRW-007 — and note terrain §12: **nothing in
  production submits a `browser_request` job today**, so BRW-004's own end-to-end proof must
  construct one in a test rather than assume a producer.
- **Not retiring Commander's ungoverned `browser_use`.** BRW-008 (`BRW-003-terrain.md:209-212`).
- **Not artifact TTL/purge/encryption.** Terrain §8 — real, absent, and owned by nobody in the
  94-ticket programme. BRW-004 must not claim it; it should be raised separately.

---

## 2. Decisions

### D1 — The control-command delivery hop. **ESCALATION, with a recommendation.**

**The problem** (terrain §4). `job_control_commands` is written by the bridge and read by nothing:
`listPendingControlCommands` has exactly one non-definition reference and it is a contract test. No
route serves a control command to a worker; `packages/worker-daemon/src` contains zero occurrences of
`commandKind`. The only control signal that reaches a running worker is `cancelRequested` on the
lease-renew response. **Without this hop, "denial/timeout fails closed" cannot be built by anyone.**

**Recommended shape** — the frozen-compatible one, and it needs no protocol change:

> Deliver pending control commands as a **non-critical bounded extension on the lease-renew
> response** (`leaseRenewResponseV1Schema.extensions`, `job.ts:463`), namespace
> `dev.aoa.job/control-v1`, `critical: false`. The worker ACKs through the existing
> `POST /worker-control/control-acks` route (`worker-control.ts:880`) using the already-frozen
> `controlCommandAckV1Schema`.

Why this and not the alternatives:

- It reuses the **exact precedent CLI-008 Unit B set** — a pointer riding `extensions[]` on a frozen
  envelope rather than a wire change. Limits are ample: ≤16 extensions, ≤16,384 canonical bytes per
  value, ≤65,536 combined (`extensions.ts:35-44`); a `runtimeDecisionResultV1` is far under.
- `critical: false` means a worker that does not understand the namespace **ignores it and keeps
  working**, so the change is byte-safe for every existing worker.
- Renew is the only channel that already reaches a *running* attempt on a heartbeat, which is
  precisely the delivery cadence an approval needs. Poll only reaches idle workers.
- The `control_command` operation exists in `WORKER_PROTOCOL_OPERATIONS` (`transport.ts:757-768`)
  with a full descriptor, so a *dedicated* op is also frozen-legal — but implementing it means a new
  worker→server polling loop, i.e. strictly more surface for the same result.

**Why this is an escalation and not a decision.** It requires editing
`server/src/services/job-leasing.ts` and `server/src/routes/worker-control.ts` — both on
`HANDOFF-lane-b-browser-service.md` §5.5's do-not-touch-without-coordination list, both actively
Lane A's, and both arguably `JOB-*`/`WRK-*` territory. `program-design.md` assigns the hop to no
ticket that I could find. **The orchestrator decides: BRW-004 builds it as slice (e), or a `JOB-*`
ticket is filed and BRW-004 stops at slice (d) with the clause explicitly deferred.** Slices (a)–(d)
are written to be worth landing either way.

### D2 — The approval authority: **runtime PERMISSION decision, and the aggregate must be relaxed**

Take the shipped code's side (terrain §2): `browser_request` →
`runtimeDecisionAuthority: "permission_download_egress"`, `aggregateKind: "agent_runtime_decisions"`,
`projectionKind: "runtime_decision"` (`job-approval-bridge.ts:173-183`), pinned by
`job-source-governance-matrix.test.ts:134-140`.

**Rejected: the product-approval arm** (`approvals` table), which `browser-approval-download.json`'s
`control.productApproval: "requested_granted"` and `BRW-003-terrain.md:205-208` both point at.
Three reasons, in order of weight:

1. `approvals` has **no `expiresAt`, no TTL, and no timeout of any kind** (terrain, agent survey B).
   "Timeout fails closed" has nothing to attach to. That alone is decisive.
2. `permission` decisions carry exactly the scope fields a browser approval needs — `networkTarget`,
   `path`, `command`, `riskClass` (`events.ts:185-199`) — and a frozen timeout vocabulary whose
   permission default is literally `"deny"` (`agent-runtime-decisions.ts:48-50`).
3. `productApprovalAuthority` for `browser_request` is `"none"` in shipped code. Building on the
   product arm would contradict a shipped, test-pinned matrix.

**The fixture is not edited.** `tests/fixtures/distributed-execution/README.md` says fixtures are
immutable behavioural inputs. The contradiction is filed as **`E8-F001`** and closed by making the
existing checker able to see it (slice (b)), not by rewriting frozen bytes.

**The aggregate gap (terrain §2a) and its fix.** `agent_runtime_decisions.agent_id` and `.run_id` are
`NOT NULL` with FKs to `agents` and `heartbeat_runs`. A browser job has neither.

- **Rejected — mint a synthetic agent + heartbeat run per session.** It writes rows into two tables
  whose own machinery would then act on them: trust-score computation, heartbeat sweeps, run-summary
  comments, the concurrency clamp. A row that is not an agent must not appear in `agents`.
- **Rejected — a new parallel decision table for browser.** That is the "never a new engine"
  prohibition `job-approval-bridge.ts:5-6` exists to enforce, and it would fork the timeout sweeper.
- **CHOSEN — relax the two columns to nullable and let the existing receipt carry the distributed
  binding.** `job_projection_receipts` already links an aggregate to a job + attempt + fence
  (`jobId`, `attemptId`, `sourceFence`, `targetAggregateId`, `aggregateKind`,
  `packages/db/src/schema/job_projection_receipts.ts:39-57`) and the bridge already writes it
  fence-guarded. Add a CHECK that the legacy pair stays all-or-nothing —
  `(agent_id IS NULL) = (run_id IS NULL)` — so no row can be half-bound. Two call sites then need a
  null branch: `RuntimeDecisionOpenRequest.agentId/runId` become nullable
  (`job-approval-bridge.ts:226-228`), and the sweeper's `runCanceller`
  (`server/src/index.ts:2116-2118`) must not call `heartbeatService.cancelRun` on a null `runId`.
  **Migration slot 0272** (tip is `0271_real_frightful_four.sql` — re-pin at generation time, do not
  trust this line; `HANDOFF-lane-b-browser-service.md` §5.4's "0262 and 0263" is stale).

### D3 — The egress substrate: **in-sandbox enforcement, policy-driven from the envelope**

The DAT-005 proxy cannot serve a browser (terrain §5): GET-only, `Authorization: Bearer` hardcoded,
status-only return, single pre-bound destination, and its dispatcher throws. Three options, costed:

| Option | What it is | Verdict |
|---|---|---|
| **(a) Widen `createFenceAwareEgressProxy`** to arbitrary methods, bodies, response bytes and runtime-discovered destinations | Would make every browser request a control-plane round-trip carrying response bodies | **Reject.** It inverts the module's stated invariant (`egress-proxy.ts:15-17`, "a handle bound to destination X can never be used to reach host Y"), and there is no frozen wire op for a worker to reach it (terrain §4) — it would need a new operation, i.e. a Custodian STOP for a design that also does not fit. |
| **(b) Sandbox-boundary network policy** — have the provider constrain outbound traffic at acquire time | Cleanest if it exists | **Unproven, and terrain §12 says so.** Nothing in the repo measures whether E2B can restrict outbound egress. `SandboxProviderAcquireInput.egressAllowlist` exists but is written into sandbox *metadata* as a comma-joined string and its own comments say "NOT a security boundary" (`mcp-connectors-env.ts:61-64`). **Slice (a) must MEASURE this before anything depends on it.** |
| **(c) In-sandbox enforcement in the browser runtime** — Chromium routed through a loopback proxy inside the sandbox, which classifies with the same pure `classifyEgressDestination` | Adds one process inside a boundary BRW-002 already proved containing | **CHOSEN**, subject to (b)'s measurement. |

Why (c):

- `classifyEgressDestination` is pure, has no I/O, and is already dual-driven against a committed
  vectors fixture in the always-on `policy` lane. Running it in a second place is exactly the
  "ONE shared helper with one test" discipline `BRW-003-terrain.md`'s corrections demand — the
  alternative is a second implementation and a divergence waiting to happen.
- BRW-002 proved the sandbox contains what runs inside it: no CDP port, an OS-sandboxed Chromium, a
  measured listening-socket delta with a negative control. A loopback proxy inherits that.
- It survives the frozen-wire constraint **only in one direction**:
  `networkPolicyRefSchema` (`policy.ts:97-101`) is `.strict()` `{policyId, version, digest}` — a
  REFERENCE. The `allow` rules live in `networkPolicyV1Schema` (`:81-93`, `allow:
  z.array(networkAllowRuleSchema).max(256)`), which is **not on the envelope and does not cross the
  wire at all**.

> ★★ **CORRECTION (Codex review, verified in source).** An earlier draft of this section said "the
> policy travels on the envelope." **That is factually wrong** and it hid a missing hop: with only a
> `{policyId, version, digest}` ref in hand, the in-sandbox enforcement point **cannot know which
> destinations are allowed**, so D3(c) as drafted could not classify anything. A resolver on the
> server (slice (f) part 2) does not fix this — it resolves the policy *server-side*, and nothing
> carries the result to the guest.
>
> **The design must therefore specify a delivery hop for the effective policy BYTES**, and it is
> subject to the same constraint as every other guest-bound payload: it must be authenticated and
> digest-checked against the envelope's `networkPolicy.digest`, so a substituted or stale policy
> fails closed rather than widening the allowlist.
>
> ★★ **CORRECTION (Codex re-review): that digest check is self-referential as written, and would
> never match.** `networkPolicyV1Schema` (`policy.ts:81-93`) carries **`digest` as one of its own
> fields**. Hashing the staged policy bytes verbatim therefore hashes the digest into itself, and no
> canonical-digest helper for policies exists anywhere in the repo (the `policyDigest` symbols in
> `job-placement-transaction.ts` are the unrelated *placement* policy).
>
> **The canonical form must be specified, and the house already has the pattern.** The
> `eventDigest` contract is *"SHA-256 over the UTF-8 canonical bytes (RFC 8785 JCS, v1 subset) of the
> same object **with `eventDigest` omitted**"* (`tests/fixtures/distributed-execution/README.md:44-49`),
> computed through `canonicalizeJsonV1` (`packages/worker-protocol/src/canonical-json.ts:87`).
> **Network-policy digest = the same algorithm over the strict policy with `digest` omitted**, via
> that same helper — not a second implementation.
>
> ★ Producer and enforcement point must share **one** helper with one test, or cross-check each
> other's output on a committed vector. `BRW-003-terrain.md`'s corrections record the cost of the
> alternative: a second implementation of a digest rule is "a divergence waiting to happen". A
> mismatch here does not fail loudly — it fails as a policy that never verifies, which the enforcement
> point is required to treat as refuse-to-start, so a divergence would look like a total outage. The natural carrier is the staged-config channel
> BRW-002 already uses for the runner's config (`BRW-002-result.md` §6: "the runner reads its config
> from a staged file"), because the seven frozen browser workload fields cannot carry it either. The
> enforcement point must **refuse to start** when the staged policy's digest does not equal the
> envelope ref's, and must never fall back to an empty allowlist — an empty allowlist denies
> everything and would read as working enforcement.
- **It is defence-in-depth, not sole defence.** If (b) turns out to be available, (c) stays as the
  inner layer. If (b) is unavailable, (c) is the only layer, and the design must say so plainly in
  the result doc rather than implying a boundary that does not exist.

★ **Constraint the implementer must not discover late** (terrain §5b): `networkAllowRuleSchema`
permits `scheme: "https"` only and rejects IP-literal hosts. Every `http://` subresource a page
pulls is `not_allowlisted`. The login fixture and the golden journey must be built HTTPS-only, or
the "deterministic local site" will fail the very policy it is meant to demonstrate.

★ **And `browserWorkloadV1Schema` has seven fields, none of them proxy or args** (`job.ts:299-310`),
and `createSpecFor` drops args anyway (`BRW-002-result.md` §6). The proxy address therefore reaches
Chromium the way BRW-002's config already does — **through the staged config file the runner reads**,
not through launch arguments. `launch-guard.ts`'s allow-list must be extended to admit
`--proxy-server` deliberately, with its own mutation-tested case; it is currently a refusal surface
and must not be widened by accident.

### D4 — "live-lease/fence-bound" for OAuth refresh: **the refresh lease, and the job fence at redemption**

Terrain §7 measured the ambiguity. The clause resolves in two halves:

- **Refresh** stays bound to `mcp_connector_oauth_refresh_leases` — owner token, `fencing_token`,
  `expected_secret_version`, and the durable `request_started` phase that prevents double-spending a
  refresh token. That machinery is live, correct, and BRW-004 changes none of it. **The only
  invariant BRW-004 adds is that no browser path may spend a refresh token**; the token never leaves
  the control plane.
- **Redemption** is bound to the job fence, through `resolveExecutionSecret`'s existing
  `guardActiveFence`-first discipline (DAT-004). A browser session materializes an **access token**
  for a bounded destination, never a refresh token, and never into the sandbox.

### D5 — Trust rules for browser prompts: **explicitly out of scope, and explicitly closed**

Terrain §3b: browser prompts are un-auto-approvable today only because `extractScope`
(`runtime-hook-bridge.ts:127-175`) has no browser branch, so `networkTarget` and `riskClass` are
null and `hasConcreteTrustScope` fails. **The moment slice (c) populates `networkTarget` — which it
must, to scope a domain approval — `allow_always` becomes reachable for browser egress.**

**Decision: BRW-004 refuses `allow_always` and `allow_run` for browser-sourced permission prompts,
and lands the refusal as a guard with its own mutation test.** A standing, non-expiring grant to
navigate a domain is a different product decision from a one-shot approval, and it must not arrive as
a side effect of adding a scope field. `allow_once` is the only decision a browser prompt accepts.

### D6 — Denial vocabulary: the frozen enum, not the fixture's prose

Terrain §10. Emit `network_denied` with `destinationClass` from `NETWORK_DENIAL_CLASSES` and a
free-text `reason` (≤1000 chars) that passes through the existing per-run canary redaction. The
fixture's `code: "metadata_destination_blocked"` / `reason: "link_local_metadata_range"` are
illustrative and are **not** the wire shape.

---

## 3. The work plan — slices (a)–(h)

Each slice is separately landable and separately falsifiable. Sizes are relative.

### (a) — Measure the sandbox egress boundary, and pin the answer. **S. No product code.**

Before anything depends on D3(b): determine whether the sandbox provider can constrain outbound
traffic at all. Extend the existing keyed real-provider probe pattern
(`packages/sandbox-e2b-provider/scripts/probe-e2b-port-exposure.mjs` + `keyed-e2b-cdp-probe.yml`,
which is how BRW-002 measured inbound exposure) with an **outbound** probe: from inside a sandbox,
attempt a connection to a host that is not in `egressAllowlist`, and record whether it succeeds.

- **Artifact:** a committed probe script + a workflow run id recorded in the result doc.
- **Why first:** every later slice's threat statement depends on whether (c) is the inner layer or
  the only layer. Discovering that after building is the "costed against a topology whose constraint
  lives in a file E8 does not own" error from `HANDOFF-lane-b-browser-service.md` §10.
- ★ **Positive control:** the same probe against a host that IS in the allowlist must succeed. A
  probe where everything fails proves nothing about the allowlist.

### (b) — Close `E8-F001`: make the fixture↔code authority disagreement visible. **S.**

`validateFixtureSourceParity` (`scripts/check-distributed-execution-foundation.mjs:2722-2752`) reads
requester, executor and source fields, and never reads the `control` block.

**Build this** (the design below is the FINAL one; the two correction blocks that follow record the
two shapes it was NOT, because both were wrong in instructive ways):

1. A check binding each fixture's `control.productApproval` / `control.runtimeDecision` to the
   **shipped** `describeSourceGovernance` profile for that source kind. A fixture claiming an
   authority the code does not implement fails the `policy` lane — **unless it is on the pinned
   historical-divergence list**.
2. A **pinned-divergence list** keyed by the VALUE tuple `(fixtureId, control.productApproval,
   control.runtimeDecision, expected profile authority)`, seeded with the one known entry
   (`browser-approval-download`, carrying `E8-F001`).
3. A **second always-printed verdict** — the divergence census — naming every pinned divergence and
   its finding id. It never fails the gate.

- **Artifact:** the new check + `scripts/check-distributed-execution-foundation.test.mjs` cases.
- ★ **Positive control (mandatory):** a synthetic fixture carrying a *different* contradiction must
  turn the gate RED, while the pinned one does not. Without it, "green because pinned" and "green
  because it checks nothing" are indistinguishable.
- ★ **Anti-drift control:** mutating the pinned fixture's `control` block must ALSO turn the gate
  RED — that is what makes the pin a record of a specific known divergence rather than a blanket
  exemption for that filename.

> ★★★ **CORRECTION (Codex review — and it overturns a clearance I was given).** This slice previously
> said the guard goes GREEN "once the expectation is expressed as: the fixture's `productApproval`
> spelling maps to the profile's runtime-decision authority." **That mapping is not allowed, and it
> would not have resolved E8-F001 anyway.**
>
> Two separate defects in one sentence:
>
> 1. **It is forbidden.** `tests/fixtures/distributed-execution/README.md` — the fixtures' own
>    governing document — says: *"Any breaking change (removing or **repurposing a field**, changing
>    an event sequence or a computed digest, tightening an existing constraint) requires a **new
>    versioned directory** and a new `schemaVersion`, leaving v1 intact."* Reading
>    `control.productApproval` as a runtime-decision authority is repurposing a field, by that
>    document's own words. ★ I was told earlier that fixtures are not frozen under
>    `artifact-policy.md`. That is true and irrelevant — `artifact-policy.md` governs result docs and
>    QA/gate records; the fixtures are governed by this README, which is stricter. **The clearance was
>    too broad and this design was wrong to rely on it.**
> 2. **It would not have worked.** `control.productApproval` and `control.runtimeDecision` are two
>    separate enum fields. Mapping the first onto runtime-decision authority leaves the second still
>    reading `"none"` against shipped code that says `permission_download_egress`. The guard would
>    have **blessed the contradiction it was built to detect** — the `checks-that-nothing-runs`
>    failure mode, in the very slice that cites it.
>
> **Revised slice (b) — SUPERSEDED by the block below. Kept because the error is instructive.** The
> first revision said the check "**stays RED for `browser-approval-download.json`**". That is a
> required `policy`-lane check that can never go green: the README keeps v1 present even after a v2
> directory exists, so the contradictory input never disappears and slice (b) could never land.

> ★★★ **CORRECTION 2 (Codex re-review) — the first remedy built a gate nobody can pass.** A
> permanently-red required check is not a strict guard; it is a guard that gets deleted, and in the
> meantime it trains everyone to ignore the lane it runs in. **This programme has already resolved
> exactly this once:** in CLI-008 Unit A the obvious fix was to fold the new clause into `ok`, and it
> was rejected for this precise reason — the remedy was a **second verdict** (`capabilityProven`)
> computed *beside* `ok`, not a permanently-red `ok`. That is the template here.
>
> **Revised slice (b), take 2 — two verdicts, one lane.**
>
> 1. **The production gate (`ok`)** binds `control.productApproval` / `control.runtimeDecision` to the
>    shipped `describeSourceGovernance` profile for every fixture, **except** those on a pinned
>    historical-divergence list. It is GREEN today.
> 2. **The divergence census** is a second, always-reported verdict that names every pinned
>    divergence, its fixture, and the finding it carries (`E8-F001`). It is printed on every run and
>    never fails the gate — a divergence that is *named and tracked*, not one that reds CI forever.
>
> ★ **The pin is by VALUE, not by name**, or the fix is worse than the problem. The entry records the
> tuple `(fixtureId, control.productApproval, control.runtimeDecision, expected profile authority)`.
> Consequences, and these are the point:
>
> - a **new** fixture with the same contradiction → **RED** (it is not pinned);
> - the pinned fixture's `control` block **changing** → **RED** (the values no longer match the pin),
>   which is also how the README's "no in-place repurposing" rule gets mechanically enforced;
> - a **v2 directory** with `control` corrected → **GREEN**, and the pin is deleted with v1's
>   retirement.
>
> ★ **Positive control (mandatory, and it replaces the withdrawn "must go RED on the real fixture"
> one):** a synthetic fixture carrying a *different* contradiction must turn the gate RED, and the
> pinned one must not. A gate that is green because it is pinned and green because it checks nothing
> are indistinguishable without that test — which is the failure mode this whole slice exists inside.
>
> The real resolution is still the README's own escape hatch — **a new versioned fixture directory**
> with `control` corrected, leaving v1 intact — and it remains a fixture-owner / Protocol Custodian
> decision, raised in §7 Q5. `E8-F001` stays open until it is taken; BRW-004 builds against the
> CODE's authority (D2) meanwhile. **`E8-F001` must not be closed by deleting the pin, nor by
> weakening the gate.**

- **Note:** the fixture bytes are NOT edited, and under the README they cannot be — not even to
  "correct" them in place. Only an additive field, or a new versioned directory, is permitted.

### (c) — The browser-side approval producer. **M. Self-contained.**

In `packages/browser-runtime`: a `requestApproval(action, summary, target)` seam on
`runBrowserSession` that (i) emits a **`runtime_decision_requested`** event through the worker's existing
`EventSequencer` (which already redacts before digesting) and (ii) **blocks the action** until a
decision arrives or the deadline passes. Default decision on deadline: refuse.

> ★★ **CORRECTION (Codex review, verified in source).** An earlier draft of this slice emitted
> `browser_approval_requested` as the REQUEST. It cannot be one.
> `browserApprovalRequestedPayloadV1Schema` (`events.ts:106-113`) is `.strict()` with exactly three
> fields — `approvalId`, `action`, `summary`. It cannot carry the `nonce`, `requestDigest`,
> `expiresAt`, `sourceRevision`, `timeoutPolicy`, `defaultDecision`, `networkTarget` or `riskClass`
> that `openGovernedDecision` requires and that `matchRuntimeDecisionResultToRequestV1`
> (`transport.ts:567-594`) later matches the result against. **Slice (d) would have had no valid
> input.** The frozen event that carries all of them is `runtime_decision_requested` with
> `permissionRuntimeDecisionRequestV1Schema` (`events.ts:185-199`) over
> `runtimeDecisionCommonShape` (`:164-173`: `requestId`, `nonce`, `requestDigest`, `schemaVersion`,
> `sourceRevision`, `expiresAt`, `title`, `summary`).
>
> `browser_approval_requested` keeps a real but *secondary* role: it carries `approvalId` and is the
> human-readable **observability** record for BRW-006's session view. Emit it in addition, never
> instead — and never as the thing slice (d) reads.

- The seam is injected, exactly like `playwright-driver`. Slice (c) ships it with an
  **inert** resolver that always refuses; slice (f) supplies the real one.
- Populate `networkTarget` on the prompt (the destination origin) and `riskClass` for downloads —
  and land D5's refusal of `allow_always`/`allow_run` in the same slice, so the widening and its
  closure are never separated by a commit.
- **Artifacts:** `run-session` tests in the existing `browser` CI lane; a mutation test on the
  refusal predicate.
- ★ **Positive control:** a test where the injected resolver GRANTS must let the same action through.
  Without it, "refused" is indistinguishable from "the action never ran" — the single most common
  way a fail-closed test proves nothing.

### (d) — The control-plane approval producer. **M.**

Wire `jobApprovalBridge.openGovernedDecision` to the **`runtime_decision_requested`** event on
ingest — that event, and only that event, carries the `nonce`, `requestDigest`, `expiresAt`,
`sourceRevision`, `timeoutPolicy` and `defaultDecision` the bridge and later result-matching need
(slice (c) correction). A `browser_approval_requested` on the same session is an observability
record and is **not** a valid input here. Then wire `resolveGovernedDecision` to the founder's answer
route. Land D2's migration **0272** (re-pin the slot at generation time) plus the two null branches.

- The bridge is written and adversarially reviewed; this slice **composes** it, and composition is
  where the receipt fast-path idempotency and the fence guard actually start running.
- Make the timeout sweeper reach the bridge: when `expireDuePrompts` resolves a decision that has a
  `job_projection_receipts` row, the `runtime_decision_result` must be queued. Today the sweeper has
  **zero** coupling to job control (terrain §3).
- **Artifacts:** extend `job-approval-parity.integration.test.ts` with a browser case that does
  **not** seed a synthetic agent or heartbeat run — the current one does, which is why the gap was
  invisible.
- ★ **Positive controls, three:** (1) a granted decision queues a result carrying `allow_once`;
  (2) an expired decision queues a result carrying `deny` **and** a not-yet-expired decision is left
  untouched by the same sweep tick (otherwise the sweep is flipping everything); (3) a late positive
  is rejected by `matchRuntimeDecisionResultToRequestV1` (`transport.ts:588-591`) — assert the
  rejection, since that is the frozen guard the whole timeout story rests on.

### (e) — The delivery hop. **M. GATED ON §2 D1 / §7 Q1 — now chartered as JOB-015.**

Only if the orchestrator assigns it to BRW-004. Ship the `dev.aoa.job/control-v1` non-critical
extension on the lease-renew response, plus the worker-daemon consumer that applies a
`runtime_decision_result` and ACKs through the existing route.

- **Artifacts:** a worker-daemon component test proving a queued command reaches a running attempt
  and is applied exactly once (`decideControlReceiverV1` classifies replay/gap/conflict/stale and has
  never been called in production — this slice is its first caller).
- ★ **Positive control:** a worker that does **not** understand the namespace must complete the run
  normally, proving `critical:false` is honoured and the change is byte-safe for existing workers.
- ★ **Negative control:** a command bound to a stale fence must be refused — and a command bound to
  the live fence must be applied in the same test.

### (f) — Egress enforcement. **L. The largest slice.**

Three parts, in order:

1. **A network-policy store.** There is none (terrain §5). A company-scoped table of allow rules
   plus a resolver that returns a real `NetworkPolicyV1` whose `digest` digests the policy's own
   canonical bytes — not, as today, the placement policy's digest
   (`job-leasing.ts:385-389`). Migration slot: after (d)'s. **Requires coordination:
   `job-leasing.ts` is a Lane A file (§6).**
2. **The resolver implementation** — the first production implementation of `resolveNetworkPolicy`,
   and the discharge of DAT-005's residual deferral #2 (bind the resolved policy to the envelope's
   `networkPolicyRef` and assert it).
3. **The policy-bytes delivery hop** (D3 correction). Resolving the policy server-side is not
   enough — the ref on the envelope carries no `allow` rules. Stage the effective policy into the
   sandbox alongside the runner config, and have the enforcement point verify its SHA-256 against
   the envelope's `networkPolicy.digest` before it starts — where the digest is taken over the
   **canonical bytes of the strict policy with its own `digest` field omitted** (D3 correction),
   through the shared `canonicalizeJsonV1` helper, never a second implementation. **Digest mismatch,
   missing policy, or an
   unparseable one must refuse to start** — never fall back to an empty allowlist, which denies
   everything and is indistinguishable from working enforcement.
4. **The in-sandbox enforcement point** (D3(c)) calling the shared `classifyEgressDestination`,
   emitting `network_denied` with the frozen `destinationClass` on refusal.

- **Artifacts:** the denied-domain, metadata and private-IP cases from the spec's Test line, run in
  the required `browser` lane against BRW-002's fixture site.
- ★ **Positive control:** an ALLOWED https destination must succeed **through the same enforcement
  point, in the same test**. A denial suite with no allow case cannot distinguish enforcement from a
  browser that never made a request — this is terrain §5's whole warning about
  `buildConnectorEgressHosts`, one layer down.
- ★ **Second positive control:** with the policy store returning a policy, requests allow; with it
  returning null, the same request denies `not_allowlisted`. That proves the *store* is load-bearing
  and not decorative.

### (g) — Connector credential materialization. **M. Depends on (f).**

Only once an enforcement point exists:

- Mint `fence_proxy` + `proxy` handles for browser sessions. The sole mint path today hardcodes
  `env` + `sandbox_local_only` and the repository interface narrows `refKind` to
  `provider_key | company_secret` (terrain §6) — both need widening, carefully.
- Implement `resolveConnectorOAuth` **on the proxy path only**. `execution-secret-brokers.ts:58-61`
  must keep throwing for the sandbox-local route; the implementation belongs where
  `authorizeSecretResolve` has already proven `fence_proxy` + `proxy`.
- Write `applied_policy_version` (a column DAT-005 added that can never be written today).

> ★★ **CORRECTION (Codex review, verified in source): resolving a credential is not delivering one.**
> `createFenceAwareEgressProxy` performs a hard-coded `method: "GET"` with a hard-coded
> `Authorization: Bearer ${material.value}` and returns `{outcome, status, appliedPolicyVersion,
> destination}` — **a status, never a body and never a cookie** (`egress-proxy.ts:242-264`). D3
> rejects widening it, and routes Chromium through an unrelated in-sandbox loopback proxy. So as
> drafted, **no planned component ever turns a resolved credential into browser session state**, and
> both the Outcome's "materialize scoped session or connector credentials" and the spec's "login
> fixture" test stay impossible.
>
> Slice (g) must therefore name the session-establishment component explicitly: the thing that takes
> a broker-resolved credential and produces an authenticated browser context (a scoped cookie or
> storage-state injection performed **inside** the sandbox, never a token handed to page script).
> Until that component is named and built, slice (g) delivers the broker arm only — and the result
> doc must say the login fixture is unmet rather than implying otherwise.

- ★ **Positive control:** the same `connector_oauth` handle presented on the **sandbox-local**
  redemption route must still be refused `ref_kind_policy_conflict`. Otherwise the implementation has
  re-opened the exact HIGH leak DAT-004's review closed, and a passing proxy test would hide it.
- ★ **Log-leak assertion:** a per-run canary planted as the resolved token value must appear as
  `«redacted»` in every emitted event, exercised through the real
  `makeProxy`/coordinator array wiring (the pattern
  `supervisor-secret-materialization.test.ts:227` already establishes).

### (h) — Session-state destruction. **S–M.**

- Assert the Chromium profile (`userDataDir`) is inside the per-job root and is destroyed with the
  sandbox; assert no `browser_cookie_state` / `browser_storage_state` bytes exist after teardown.
- Do **not** claim artifact TTL/purge/encryption (§1). State in the result doc that the clause holds
  *by sandbox teardown*, that DAT-010 fixed the retention authority
  (`artifact-commit.ts:166-202`), and that class→duration mapping and purge remain unowned.
- ★ **Positive control (negative-control pattern, from BRW-002's socket delta):** the destruction
  check must be shown to FAIL against a deliberately-preserved profile. A cleanup assertion that
  cannot observe an uncleaned profile is not an assertion.

---

## 4. Every fail-closed clause and the control that proves it can fire

The programme's standing requirement, gathered in one place.

| Fail-closed clause | Where it fires | ★ Positive control that proves the lever is live |
|---|---|---|
| Approval **denied** → action refused | (c) `run-session` refusal | a GRANTED decision lets the same action through, same test |
| Approval **timeout** → `deny` | (d) `fallbackPolicyOutcome` via the 30 s sweeper | a not-yet-expired row survives the same sweep tick **and** an expired one flips |
| Late positive decision → rejected | (d) `matchRuntimeDecisionResultToRequestV1` | an in-window positive is accepted by the same call |
| Unknown/critical extension → ignored, run completes | (e) `critical:false` | a worker that DOES understand it applies the command |
| Stale-fence command → refused | (e) fence guard | a live-fence command is applied, same test |
| Destination not allowlisted → `not_allowlisted` | (f) `classifyEgressDestination` | an allowlisted https destination succeeds through the same point |
| Policy store returns null → deny | (f) resolver | with a policy present, the same request allows |
| `connector_oauth` via sandbox-local → `ref_kind_policy_conflict` | (g) `authorizeSecretResolve` | the same handle via the proxy path resolves |
| Secret value in an event → `«redacted»` | (g) per-run canaries | a non-canary string in the same field survives verbatim |
| Session state destroyed at terminal | (h) teardown assertion | the check FAILS against a deliberately-preserved profile |
| Staged policy digest ≠ envelope `networkPolicy.digest` → refuse to start | (f) enforcement point | a matching digest starts and classifies normally |
| Digest computed over the WRONG canonical form (e.g. `digest` field not omitted) → never verifies | (f) shared helper | ★ a committed vector both producer and enforcement point reproduce — otherwise a divergence looks like a total outage, not a bug |
| Missing/unparseable staged policy → refuse to start, never empty-allowlist | (f) | a present policy starts; ★ an empty allowlist must be shown to be DISTINGUISHABLE from a refusal, since both deny everything |
| Sandbox egress boundary (if any) | (a) probe | an allowlisted host succeeds in the same probe run |

Each row's guard is mutation-tested; survivors are questions, not verdicts, and the harness is
checked for having run the right thing before a kill is believed.

---

## 5. Guards and gates this touches

- **`policy` lane:** slice (b) extends `check-distributed-execution-foundation.mjs`; slices (d) and
  (f) add migrations, so `artifact-lifecycle-schema-contract` / migration-snapshot contiguity apply.
- **`browser` lane** (`pr.yml:1276`, required via `ci-required`'s `needs` at `:1361` and `R_BROWSER`
  at `:1379`): slices (c), (f), (h).
- **`check:frozen-worker-protocol-v1`:** must stay OK with **zero** `packages/worker-protocol` edits.
  If any slice appears to need one, that is a design error — go back to §2 D1.
- **`check-guard-inventory.mjs`:** every new guard needs a CI invocation, or it is a check that
  nothing runs.
- **`check-finding-ownership.mjs`:** `E8-F001` ships with its `scripts/finding-ownership.json` entry
  in the same commit, or `policy` goes red.
- **`check-ticket-graph-coverage.mjs`:** `#### BRW-004` already exists in `program-design.md:984` —
  verified, not assumed.
- **`docker/d1/campaign.env`:** bump only if a slice alters runtime behaviour under `server/src`, and
  only after the last such change. Coordinate — the last bump wins and that trap has bitten this
  programme five times.

---

## 6. Deconfliction and migrations

**Lane A files this design touches, none without coordination:**

| File | Slice | Why |
|---|---|---|
| `server/src/services/job-leasing.ts` | (e), (f) | renew-response extension; real `networkPolicy` |
| `server/src/routes/worker-control.ts` | (e), (g) | control delivery; broker widening |
| `server/src/services/execution-secret-*.ts` | (g) | the `fence_proxy` arm |
| `packages/db/src/schema/job_secret_handles.ts` | (g) | `applied_policy_version` writes |

Slices (a)–(d) touch **none** of them and can proceed immediately.

**Migrations.** Tip is `0271_real_frightful_four.sql`; next free is **0272**. Slice (d) takes one
(nullable relaxation + CHECK), slice (f) takes one (policy store). **Re-pin the number at generation
time** — pull first, generate second, verify the slot is free. Drizzle-only; C14 permits appending
an idempotency guard beneath generated DDL, nothing more.

---

## 7. Open questions — answer before slice (e), not during

1. **★ Does BRW-004 own the control-command delivery hop (§2 D1)?** If no, file the `JOB-*` ticket
   and BRW-004 defers "denial/timeout fails closed" with this design as the reason. **This is the
   single question that determines whether the ticket can satisfy its own acceptance.**
2. **Can the sandbox constrain outbound egress at all (slice (a))?** If yes, D3(c) is defence in
   depth and the threat statement is strong. If no, (c) is the only layer and the result doc must say
   so — a browser that can be made to reconfigure its own proxy is not contained by an in-sandbox
   proxy alone.
3. **What is a `browser_request` job's `agentId` when the requester is a founder?** The parity
   contract permits `founder | team_lead | team_member | agent` as requesters; three of the four have
   no agent. D2's nullable relaxation makes this answerable as "null", but the *hub* surface and the
   founder-authority answer route (`routes/agent-runtime-decisions.ts:55-59, 122`) must be checked
   for an agent-shaped assumption.
4. **Does anything in the hub/UI read `agent_runtime_decisions.agentId` unconditionally?** A nullable
   column with a non-null reader is a runtime error waiting for the first browser prompt.
5. **★ Who authorises a v2 fixture directory, and will they?** Resolving `E8-F001` properly means a
   new versioned fixture directory with `control` corrected for `browser_request`, per
   `tests/fixtures/distributed-execution/README.md`'s own rule. That is a fixture-owner / Protocol
   Custodian call. Until it is taken, the divergence stays PINNED in slice (b)'s census — reported on
   every run, failing nothing — and `E8-F001` stays open. **Do not resolve it by deleting the pin or
   by weakening the gate**, and do not resolve it by making the gate permanently red either: that
   was the first remedy and it was withdrawn (slice (b), correction 2).
6. **What component turns a broker-resolved credential into browser session state?** None is named
   anywhere today (slice (g) correction). Until one exists the spec's "login fixture" test cannot
   pass, and the Outcome's "materialize scoped session credentials" is unmet.

---

## 8. Definition of done

Per `HANDOFF-wave-3-4.md` §1, unchanged:

- This design's SHA (`203853b3a`) recorded as the Start SHA in `BRW-004-result.md`.
- **Every acceptance clause maps to a named executable artifact or is explicitly deferred with its
  reason.** §3 names one per slice; §4 names the control that proves each fail-closed lever can fire.
  Clauses gated on Q1 are deferred **in writing**, with the escalation as the reason.
- Every guard mutation-tested; survivors fixed or documented as equivalent.
- The result doc states deferrals honestly, **including anything built but not wired** — and given
  terrain §1, that section will be long. A slice that lands a producer with no consumer must say so.
- CI watched to green. `ci-required` is the verdict; a pushed sha cannot be assumed to have one.
