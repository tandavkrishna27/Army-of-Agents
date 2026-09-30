# BRW-004 — Browser secrets, network, and human approval — TERRAIN

**Epic:** E8 · **Lane:** B (`C:\e8`) · **Mapped at:** `203853b3a`
**Status:** terrain complete; design written alongside ([`BRW-004-design.md`](./BRW-004-design.md)).
Two acceptance clauses are **blocked on work this ticket does not own** (§4, §12) and the design
says so rather than assuming a producer.

**Spec** (verbatim, `program-design.md:984-990` — BRW-004 has no earlier ticket file):

> - **Depends on:** BRW-002, DAT-004, DAT-005.
> - **Outcome:** Materialize scoped session or connector credentials through the control-plane broker
>   and pause risky actions for approval without leaking cookies, access tokens, or refresh tokens.
> - **Acceptance:** OAuth refresh remains control-plane-owned and live-lease/fence-bound;
>   denial/timeout fails closed; session state is destroyed at terminal state; allowed domains and
>   download/upload policy are enforced.
> - **Test:** Login fixture, connector rotation/revocation, denied domain, metadata/private IP,
>   approval allow/deny/timeout, and log-leak tests.

All three dependencies are shipped: `BRW-002-result.md`, `DAT-004-result.md`, `DAT-005-result.md`
are on disk. BRW-004 is dependency-unblocked.

> **Method note.** Every count in this document is a repo-wide grep at `203853b3a` with
> `node_modules`, `dist/` and `tests/fixtures/worker-protocol-consumers/` excluded, using `grep -a`
> throughout (BRW-002 terrain §7: a raw NUL byte in `packages/worker-daemon/src/supervisor/provider.ts`
> makes plain grep skip that file silently, which invalidated a previous lane's absence claims).
> §10 is a **measurement with a positive control**, not a read.

---

## ★ 1. THE HEADLINE: the frozen wire is COMPLETE. Every producer and every consumer is missing.

This is the opposite of the shape this ticket was expected to have. The handoff (§3) framed BRW-004
as "the ticket that owns lighting up the `fence_proxy` path", implying the wire would be the hard
part. It is not. **The v1 worker protocol already carries every message BRW-004 needs, and no
Protocol Custodian ticket is required.** What is absent is everything on either side of it.

| Frozen wire element | Where | State |
|---|---|---|
| `browser_approval_requested` event type | `events.ts:360` (in `WORKER_EVENT_TYPES`, `:353-374`) | **frozen, present** |
| its payload `{approvalId (uuid), action (≤200), summary (≤4000)}` | `browserApprovalRequestedPayloadV1Schema`, `events.ts:106-113` | **frozen, present** |
| `runtime_decision_requested` event + the strict `permission \| work_question` union | `events.ts:185-231`, variant registered `:388-400` | **frozen, present** |
| `network_denied` event + `{destinationClass, reason}` | `networkDeniedPayloadV1Schema`, `events.ts:313-317` | **frozen, present** |
| `NETWORK_DENIAL_CLASSES = ["metadata","private","control_plane","not_allowlisted"]` | `events.ts:313` | **frozen, present** |
| `PERMISSION_TIMEOUT_POLICIES = ["deny","cancel_run","park_run","continue_with_default","escalate"]` | `events.ts:175` | **frozen, present** |
| `PERMISSION_DEFAULT_DECISIONS = ["allow_once","allow_run","deny"]` (`allow_always` deliberately excluded, `:179-180`) | `events.ts:181` | **frozen, present** |
| `runtime_decision_result` + `product_approval_result` control commands | `CONTROL_COMMAND_KINDS`, `transport.ts:601-608` | **frozen, present** |
| fail-closed request↔result binding, incl. late-positive rejection | `matchRuntimeDecisionResultToRequestV1`, `transport.ts:567-594` | **frozen, present** |
| envelope carries `secretHandles` (≤64) **and** `networkPolicy: {policyId, version, digest}` | `job.ts:343-345`; `networkPolicyRefSchema`, `policy.ts:96-99` | **frozen, present** |
| the full `NetworkPolicyV1` with `allow: NetworkAllowRule[]` (≤256), `defaultAction: "deny"`, all three deny-classes pinned `true` | `policy.ts:81-93` | **frozen, present** |

Against that, the producer/consumer census:

| What is missing | Measured |
|---|---|
| Any producer of `browser_approval_requested` | **0.** Outside `packages/worker-protocol/src/` the string appears only in `packages/db/src/schema/job_events.ts:76` (the DB CHECK enum) and its own protocol test. |
| Any worker-side consumer of a control command | **0.** `commandKind` appears **zero times** in `packages/worker-daemon/src`; `decideControlReceiverV1` has **zero production call sites** (only `worker-protocol` tests and the re-export at `index.ts:500`). |
| Any control-plane hop that DELIVERS a queued control command to a worker | **0.** See §4 — this is the ticket's largest single gap. |
| Any production caller of the approval bridge | **0.** `jobApprovalBridge` is imported by four test files and nothing else. |
| Any production caller of the egress proxy | **0.** `createFenceAwareEgressProxy` (`egress-proxy.ts:146`) — 1 definition, 2 test hits, 14 doc hits, 2 in-code comments *saying it has no callers* (`worker-control.ts:159-162`, `execution-secret-resolve.ts:5-9`). |
| Any production implementation of `resolveNetworkPolicy` | **0.** One call site (`egress-proxy.ts:179`), two implementations, both in `egress-proxy.integration.test.ts` (`:349`, `:541`). |
| Any consumer of `envelope.networkPolicy` | **0.** Across `packages/worker-daemon/src`, `packages/adapter-manager/src`, `packages/browser-runtime/src` the only hit is a test fixture, `poll-fixtures.ts:212`. |
| Any store of network allow rules | **does not exist.** Full sweep of `packages/db/src/schema/` and `packages/db/src/migrations/` for `allowlist\|allow_list\|allowed_domain\|network_polic\|egress`: every hit is a comment in an unrelated file. No table, no migration, no config file. |
| Any production mint of a `fence_proxy` / `proxy` / `connector_oauth` secret handle | **0.** The sole mint path hardcodes `materialization: "env"`, `usePolicy: "sandbox_local_only"` (`execution-secret-handle-mint-runner.ts:140-141`), and the repository interface narrows `refKind` to `"provider_key" \| "company_secret"` (`packages/db/src/repositories/tenant/job-control.ts:186-188`). |
| Any pause/ask seam in the browser runtime | **0.** `packages/browser-runtime/src/` has eight source files; `runBrowserSession` accepts no broker and no approval callback. Its only refusal is `reason: "download_refused"` (`run-session.ts:202,212`), decided by pure path resolution. |
| Any upload path at all | **0.** `setInputFiles` appears nowhere in the repository. The acceptance clause says "download/**upload** policy is enforced"; there is nothing to enforce a policy against. |
| Any of the four audit actions the frozen fixtures require | **0.** `browser.approval_requested`, `browser.approval_granted`, `network.denied` appear in no `.ts` file anywhere. |

★ This is the CLI-008 §4 Unit F shape exactly, and worse: there the control-plane half was fully
shipped and only the producer was missing. Here **both** halves are missing around a complete wire.

---

## ★★ 2. The approval authority is ALREADY DECIDED in shipped code — and two documents disagree with it

`server/src/services/job-approval-bridge.ts:173-183` (JOB-011), shipped, `describeSourceGovernance`:

```ts
case "browser_request":
  return { kind: "browser_request",
    productApprovalAuthority: "none",
    runtimeDecisionAuthority: "permission_download_egress",
    completionAuthority: "none",
    disposition: "drive_in_tenant_tx",
    aggregateKind: "agent_runtime_decisions",
    projectionKind: "runtime_decision",
    mintsAggregate: true };
```

**A browser approval is a runtime PERMISSION decision on `agent_runtime_decisions`, not a product
approval on `approvals`.** That is pinned by a shipped test — `job-source-governance-matrix.test.ts:134-140`
asserts `["browser_request","crew_run","task_run"]` are exactly the aggregate-minting sources — and it is
consistent with `browser-denied-egress.json`'s `control.runtimeDecision: "egress_denied"`.

**Two authoritative documents say the opposite:**

1. **`browser-approval-download.json:205-207`** (a FROZEN golden-journey fixture) declares
   `"productApproval": "requested_granted"` and `"runtimeDecision": "none"` for a `browser_request` source.
2. **`BRW-003-terrain.md:205-208`** reads that block and concludes *"a browser approval rides the
   **product approval** authority … recording it here saves BRW-004 a needless Custodian ticket."*
   The conclusion (no Custodian ticket) is right; the authority it names is wrong.

**Nothing checks the disagreement.** `validateFixtureSourceParity`
(`scripts/check-distributed-execution-foundation.mjs:2722-2752`) validates a fixture's requester
principal, executor principal, and required/forbidden source fields against
`distributed-execution-legacy-parity.json`. It **never reads the `control` block**, so
`control.productApproval` is unconstrained by the source-governance contract that contradicts it.

The parity contract's own prose is ambiguous enough to have produced both readings —
`legacy-parity.json` `browser_request.parity.product_runtime_approval`: *"Download and egress
approval (requested_granted / requested_denied); runtime egress decisions gate outbound bytes."*
It names an approval **and** a runtime decision in one sentence. The shipped code resolved that
ambiguity; the fixture and BRW-003's terrain did not follow.

**Filed as `E8-F001`** (see `../findings.md`). It is BRW-004's to close, and the design closes it by
taking the code's side and by adding the check that would have caught it.

### 2a. ★★★ …and the designated aggregate CANNOT HOLD A ROW for a browser job

`packages/db/src/schema/agent_runtime_decisions.ts:22-23`:

```ts
agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
runId:   uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
```

Both **NOT NULL**, both foreign-keyed to legacy tables. A distributed `browser_request` job has
neither an `agents` row nor a `heartbeat_runs` row — it has a `jobs` row, an attempt, a lease and a
fence. `RuntimeDecisionOpenRequest` (`job-approval-bridge.ts:226-228`) requires `agentId: string` and
`runId: string` for the same reason.

The one place this is exercised end-to-end — `job-approval-parity.integration.test.ts:146-171`,
*"[runtime] browser_request: a permission DENY resolves to an E1 result carrying deny"* — passes
**because the test manufactures them**: a seeded `AGENT` constant and `await seedRun(runId)` before
the call, plus a synthetic `adapterType: "claude_local"` for a browser session.

So the shipped governance matrix designates an aggregate that, in production, has no legal row to
write. **This is a real blocker, it is not recorded anywhere, and it is the first thing BRW-004's
design has to resolve.** Options and their costs are in the design, §D2.

---

## ★ 3. The fail-closed timeout lever is ALIVE — and it cannot reach a sandbox

The recurring fear for a "denial/timeout fails closed" clause is a dead lever. Here it is measurably
**not** dead on the control-plane side:

- `defaultTimeoutPolicy(kind)` returns literally `"deny"` for `permission`
  (`agent-runtime-decisions.ts:48-50`).
- `fallbackPolicyOutcome` (`:677-713`): `permission` + `deny` → `{status:"answered", decision:"deny"}`.
- `expireDuePrompts` (`:1224-…`) drives it from `listDueForExpiry` (`:595-607`,
  `status IN ('created','shown') AND expires_at <= now`).
- **It has a live boot root.** `server/src/index.ts:2106-2136`: an unconditional
  `setInterval` at `RUNTIME_DECISION_TIMEOUT_SWEEP_INTERVAL_MS = 30 * 1000`, up to 10 batches of 100
  rows per tick, plus a stranded-answer sweep. Not flag-gated, not `.unref()`-ed away.
- Default TTLs: permission 1 h, work_question 24 h (`:33-34`).

**But three things break the chain for a sandboxed browser:**

1. **The sweeper's canceller is the LEGACY one.** `index.ts:2116-2118` supplies
   `runCanceller: ({runId}) => runtimeDecisionTimeoutHeartbeat.cancelRun(runId)` — `heartbeatService`.
   For a `park_run`/`cancel_run` outcome on a browser job there is no heartbeat run to cancel.
2. **The service has no coupling to job control whatsoever.** `agent-runtime-decisions.ts` contains
   **zero** occurrences of `job`, `control`, `bridge` or `fence`. The sweeper flips the aggregate to
   `deny` and stops. Queuing the `runtime_decision_result` control command is
   `jobApprovalBridge.resolveGovernedDecision`'s job (`job-approval-bridge.ts:730-733`), and the
   sweeper does not go through the bridge.
3. **Even if it did, the command would not be delivered** — §4.

★ So the honest statement is: **the fail-closed decision is produced and durably recorded; it is
never delivered.** A browser session would hang to its own envelope deadline. That is *a* closed
direction, but it is not the one the clause names, and the difference is observable.

### 3a. The nearest working analogue is in-process only

The `claude_local` PreToolUse hook bridge is the only thing in the repo that genuinely pauses a
running process, asks a human, and fails closed — `runtime-hooks.ts:9-12` states the contract
("ALWAYS returns HTTP 200 … any auth failure, timeout, or thrown error maps to a `deny`"), `:87-90`
denies on timeout, and `heartbeat.ts:670-674` deliberately leaves the row for the sweeper.

It cannot be reused. `server/src/services/runtime-hook-registry.ts:1-13` says so in its own header:

> SINGLE-PROCESS ASSUMPTION: The adapter `execute()` method runs inside the same Node.js process as
> the Express server. … Multi-process execution (e.g. a separate worker process or a remote sandbox)
> is out of scope for this milestone. … the Map must be replaced.

BRW-004's browser runs in an E2B sandbox behind a worker daemon. **That is the exact case the
registry excludes.**

### 3b. Auto-approval reach — bounded today, and the boundary is accidental

`agent_runtime_trust_rules` can mint an already-`answered` row with no human
(`agent-runtime-decisions.ts:835-838, 880-905`), and `trustRuleMatchesPrompt` (`:366-380`) is a
field-wise subset match where a null rule field is a wildcard. Today a browser action cannot be
auto-approved, but only because `extractScope` (`runtime-hook-bridge.ts:127-175`) has **no browser
branch**: an `mcp__playwright__*` prompt carries null `command`/`path`/`networkTarget` and
`riskClass: "unknown"` (`:75-80`), so `hasConcreteTrustScope` fails and both `allow_always`
(`:954-955`, `:1053-1055`) and `allow_run` (`runtimeRunGrantEligibility` requires
`riskClass === "filesystem"`) are refused as `unprocessable`.

★ **The moment BRW-004 populates `networkTarget` — which it must, to scope a domain approval — that
inertness ends and `allow_always` becomes reachable for browser egress.** A design that adds the
scope field without deciding the trust-rule policy silently widens auto-approval. The design must
state the policy; §D5 does.

---

## ★★★ 4. There is NO control-command delivery hop. Not for approvals — not even for cancel.

Traced end to end at this SHA:

- Commands are queued into `job_control_commands` (`packages/db/src/schema/job_control_commands.ts`,
  CHECK at `:91` admits `cancel, drain, graceful_stop, product_approval_result, runtime_decision_result`).
- `listPendingControlCommands` (`packages/db/src/repositories/tenant/job-control.ts:500`) has
  **exactly one non-definition reference in the repository**, and it is
  `server/src/__tests__/job-fence-surface.contract.test.ts:114`.
- `server/src/routes/worker-control.ts` registers 15 routes. The only control-related one is
  `POST /worker-control/control-acks` (`:880`) — the **worker→server ACK** direction.
- The poll response carries lease offers, not controls (`transport.ts:59` names controls as a
  separate channel; the poll response schema has no control field).
- `leaseRenewResponseV1Schema` (`job.ts:452-467`) carries exactly one control signal:
  `cancelRequested: boolean` + `cancelReason: string|null`, plus `extensions`.
- `packages/worker-daemon/src` has no control-command consumer of any kind (§1).

**Consequence.** A queued `runtime_decision_result` sits in the table forever. This is not
BRW-004-specific — cancellation has the same hole, which is why BRW-002 terrain §3 found `signal()`
is a no-op that reports `stopped`.

**And the wire cannot be widened.** `WORKER_PROTOCOL_OPERATIONS` (`transport.ts:757-768`) is the ten
frozen operations: `enrollment, poll, lease_ack, lease_renew, event_upload, artifact_transfer_grant,
artifact_commit, quarantine_grant, quarantine_finalize, control_command`. `control_command` exists
with `audience: "control_channel"` and its full descriptor (`:906-914`) — but no route implements it
on the server and no client implements it on the worker. There is **no** egress op, **no**
secret-redemption op, and **no** approval op; the local secret-resolve route is a deliberately
non-frozen local descriptor (`execution-secret-resolve.ts:79-86`).

★ **The one frozen-compatible channel that already reaches a running worker is
`leaseRenewResponseV1Schema.extensions`** — bounded, namespaced, `critical:false`-ignorable,
the exact mechanism CLI-008 Unit B used for the staged-input pointer on the job envelope. Limits
(`extensions.ts:35-44`): ≤16 extensions, ≤16,384 canonical bytes per value, ≤65,536 combined,
`KNOWN_CRITICAL_EXTENSION_NAMESPACES` is empty so every `critical:true` fails closed. A
`runtimeDecisionResultV1` fits inside 16 KiB comfortably.

Whether BRW-004 may build that hop is a **deconfliction question, not a technical one** — see §12.

---

## 5. Egress: the classifier is real and gated; the policy it classifies against does not exist

**What is solid.** `classifyEgressDestination(requestedUrl, resolvedAddrs, policy, controlPlane?)`
(`server/src/services/egress-policy.ts:228-246`) is pure, layered default-deny, and correct:
positive allowlist (https + host + port) then deny-if-ANY-resolved-address-is-unsafe (the DNS-rebind
defence), precedence `metadata > control_plane > private > not_allowlisted`
(`DENY_SEVERITY`, `:69-74`). It is **dual-driven**: an independent re-derivation
(`scripts/check-egress-policy-vectors.mjs`) and the real classifier
(`server/src/__tests__/egress-policy.test.ts:145-147`) are both bound to the same committed fixture
`tests/fixtures/egress-policy/v1/vectors.json`, and the vectors gate runs in the always-on `policy`
CI lane. DAT-005's review hardened `parseIp` against hex-mapped IPv4-in-IPv6 spellings after a real
control-plane bypass was found (DAT-005-result §2 rows 3 + 4).

**What is absent, in order of how much it costs:**

1. **No policy.** `buildJobEnvelope` (`server/src/services/job-leasing.ts:385-389`) writes a
   hardcoded literal:
   ```ts
   networkPolicy: { policyId: "job-default-deny", version: 1, digest: input.attempt.placementPolicyDigest },
   ```
   ★ `version` is the literal `1` and **`digest` is the PLACEMENT policy's digest** — it digests no
   network-policy content, because there is no content. The reference is not self-consistent and
   nothing can verify it.
2. **No resolver.** `resolveNetworkPolicy` is a required injected dep with one call site and zero
   production implementations (§1). A `null` or a throw is a fail-closed `malformed` deny
   (`egress-proxy.ts:188-190`), so with no store every egress denies.
3. **No consumer.** Nothing reads `envelope.networkPolicy` (§1). DAT-005's own residual deferral #2
   names this: *"Resolved policy never bound to the job's frozen `networkPolicyRef` … The binding
   assertion belongs where that resolver is wired."* That is BRW-004's inheritance.

**And the proxy is the wrong shape for a browser, which BRW-002 terrain §6 already flagged and
which I re-measured rather than inherited:**

- **GET only, no body.** `egress-proxy.ts:253-256` passes `method: "GET"` as a literal;
  `EgressRequestV1` (`:51-61`) carries no method, headers or body.
- **`Authorization: Bearer` is hardcoded.** Same lines. `FenceResolvedMaterial`
  (`secret-broker.ts:77-84`) has no header-name or scheme field.
- **Status only comes back.** `EgressDispatchResult` (`:81-83`) is `{ status: number }` — no body,
  no headers ever cross back to the caller.
- **Single-destination by construction.** The requested URL's origin must equal the handle's bound
  destination origin (`:226-229`), and a handle is minted per destination.
- **The live channel is inert.** `deps.dispatch` defaults to `failClosedEgressDispatcher` (`:157`),
  which throws `"egress dispatch channel not wired (E4-D12)"` (`:90`).

A browser emits raw DNS and TCP to hosts discovered at runtime, with methods and bodies, and needs
the response bytes. **This is a model mismatch, not a plumbing gap.** The design's §D3 costs the
three substrate options rather than pretending the proxy fits.

### 5a. The thing that LOOKS like an allowlist and is not one

`buildConnectorEgressHosts` (`server/src/services/mcp-connectors-env.ts:82`) derives a bare host list
from MCP connector rows and it flows into `SandboxProviderAcquireInput.egressAllowlist`
(`sandbox-provider-runtime.ts:24`), where the E2B provider writes it into **sandbox metadata as a
comma-joined string** (`:787-789`). Its own comments are explicit: *"NOT a security boundary"*
(`mcp-connectors-env.ts:61-64`), *"advisory/best-effort only (never a security boundary)"*
(`mcp-connectors-loader.ts:597-598`), and on failure it degrades to `[]` (`:653`).

It is structurally disconnected from `NetworkPolicyV1.allow`: different shape (bare host string vs
`{scheme, host, port}`), different producer, different consumer, no code path joins them. **Anyone
who greps "allowlist", lands here, and declares the clause satisfied will have secured nothing.**

### 5b. `NetworkAllowRule` is HTTPS-only and DNS-host-only — a hard constraint on a browser

`networkAllowRuleSchema` (`policy.ts:65-78`) permits `scheme: z.literal("https")` only, and rejects
IP literals and anything with a colon in the host. A browser page pulls `http://` subresources,
fonts, and beacons. Under this vocabulary every one of those is `not_allowlisted` — which is the
correct security posture but means "allowed domains are enforced" for a browser is a **stricter**
promise than it sounds, and the golden journey must be built to survive it. Note also that
`browser-denied-egress.json` navigates `http://169.254.169.254/`, which is denied twice over:
`not_allowlisted` by scheme at layer 1, and `metadata` at layer 2 had it reached there.

---

## 6. Secrets: `connector_oauth` is fail-closed BY CONSTRUCTION, and nothing mints its handle class

The taxonomy is two orthogonal enums plus a materialization kind:

- `SECRET_REF_KINDS = ["company_secret", "connector_oauth", "provider_key", "device_local"]`
  (`packages/db/src/repositories/tenant/job-fence.ts:152`).
- `SecretDeliverySeam = "fence_proxy" | "remote_server_fenced" | "sandbox_local_only"`
  (`server/src/services/secret-broker.ts:67`).
- `SECRET_MATERIALIZATION_KINDS = ["proxy", "env", "file"]` (`policy.ts:105`).

Cross-field invariants are enforced twice — on the wire by `secretHandleRefSchema.superRefine`
(`policy.ts:178-195`: `proxy ⟺ fence_proxy`) and at resolve by `authorizeSecretResolve`
(`job-fence.ts:288-350`): `connector_oauth` resolves **only** as `fence_proxy` + `proxy` (`:322-324`,
else `ref_kind_policy_conflict`) — the fix DAT-004's adversarial review landed for a real HIGH
OAuth-token-to-sandbox leak.

`createExecutionSecretBrokers` is the only production `SecretBrokerSet`. Its OAuth arm
(`execution-secret-brokers.ts:58-61`):

```ts
async resolveConnectorOAuth() {
  // Intentionally unreachable from the sandbox-local path — see the header.
  throw new Error("connector_oauth broker not wired (fence_proxy class, DAT-008 non-goal)");
},
```

**This is correct and must stay correct.** The header (`:12-18`) explains: wiring it there would make
an OAuth token reachable from the sandbox-local redemption route, which is exactly the coercion
DAT-004's review had to fix once.

Two further measured absences:

- **Nothing mints a handle of the class the proxy accepts.** The sole production mint,
  `mintExecutionSecretHandleForPlacement` (`execution-secret-handle-mint-runner.ts:96`, called once
  from `job-placement-transaction.ts:368`), hardcodes `env` + `sandbox_local_only` (`:140-141`), and
  the repo interface narrows `refKind` to `provider_key | company_secret` (`job-control.ts:186-188`).
  The proxy rejects `sandbox_local_only` at `egress-proxy.ts:221`. **The proxy could not serve a
  single handle that exists.**
- **`job_secret_handles.applied_policy_version`** (`packages/db/src/schema/job_secret_handles.ts:75`,
  added by DAT-005 migration 0251) is set by exactly one caller — `egress-proxy.ts:207`, the
  unreachable one. The live route (`worker-control.ts:739-747`) does not pass it. **The column can
  never be written in production.**
- `failClosedDeviceLocalBroker` throws `"device-local credential broker not wired (DSK-002)"`
  (`device-local-broker.ts:120-125`) — noted so BRW-004 does not mistake `device_local` for an
  available class.

---

## 7. OAuth refresh IS control-plane-owned and live — and structurally disconnected from execution

The acceptance clause reads "OAuth refresh remains control-plane-owned and live-lease/fence-bound."
Half of that is already true, and the half that is not is precisely stated.

**Live and control-plane-owned.** `server/src/services/mcp-connector-token-refresh.ts` (743 lines).
`resolveConnectorToken` (`:518`) returns an unexpired access token or de-dupes into
`coordinateOAuthRefresh` (`:538`), which spends the refresh token via `refreshOAuthToken`
(`mcp-connector-oauth.ts:477`). **One production caller**, reached at runtime:
`mcp-connectors-loader.ts:290` inside `loadEnabledConnectorRows`, called from `heartbeat.ts:134`,
`internal-agent/aoa-agents/runner.ts:11`, `internal-agent/cli-mode.ts:35`.

**Token storage.** A signed-v2 bundle in a `company_secret` named `mcp:oauth:<connectorId>`
(`secrets.ts:148`). Envelope `aoa-oauth-2` (`mcp-connector-oauth-bundle.ts:3`), HMAC-SHA256 over the
payload with an HKDF-derived key (`:36-42`), verified at `:125`; the payload binds
`{companyId, connectorId, catalogEntryId, oauthPolicyVersion, secretName}` so a bundle cannot be
replayed into another identity.

**Lease-bound — but to its OWN lease, not the job fence.**
`packages/db/src/schema/mcp_connector_oauth_refresh_leases.ts:14-31`: PK `secret_id`, `owner_token`,
`fencing_token bigint`, `expected_secret_version`, `phase` (default `acquired`), `leased_until`. Its
header (`:5-13`): *"A refresh result may be committed only while owner, fence, expected version, and
lease expiry still match. `request_started` is deliberately durable: expiry in that phase means the
provider outcome is indeterminate and the old refresh token must not be spent again."* Identity is
re-checked before the token is spent (`assertRefreshAllowed`, `mcp-connectors-loader.ts:237-270`);
permanent failure flips the connector to `needs_credentials` (`:322-335`).

**The gap.** `mcp-connector-token-refresh.ts` imports nothing from the job-fence world — no
`VerifiedWorkerOperation`, no `resolveWorkerFenceContext`, no `guardActiveFence`, no `leaseId`, no
`fenceToken`. The only contemplated bridge is `SecretBrokerSet.resolveConnectorOAuth`, documented at
`secret-broker.ts:141-142` as *"`connector_oauth` → the existing MCP-OAuth path (`mcp:oauth:<id>`
company secret)"* — and it throws in **both** implementations (§6). No implementation anywhere,
production or test, actually reads an `mcp:oauth:*` secret through the broker; the test doubles
return a marker string.

★ So the clause is **half-satisfied by inheritance and half-unbuilt**: refresh is control-plane-owned
and bound to a real fencing lease; it is not bound to the *job* fence, and nothing connects it to a
browser session. Whether "live-lease/fence-bound" means the refresh lease or the job fence is a
question the design has to answer, not assume — §D4.

---

## 8. Session state and retention: one half was fixed since the finding, the other half is still absent

`FINDING-retention-authority-and-DE-11.md` §3 says the retention authority is INVERTED — that
`artifact-commit.ts` takes the worker's declared `retention` straight from the manifest while
`browser-artifact-retention.ts` (the control-plane-owned total function) has zero callers.

**That is STALE at `203853b3a`, and I checked rather than quoted.** DAT-010 fixed it:
`artifact-commit.ts:42` imports `resolveStoredRetention`; `:166-168` calls it with the frozen `kind`
and the manifest's declaration; `:170-181` logs when the declaration is ignored; `:198-202` stores
`retentionDecision.retention`, with the comment *"retention is CONTROL-PLANE-OWNED, derived from the
frozen `kind`, and the manifest's declaration is IGNORED."* `browserArtifactRetention` maps
`browser_cookie_state` and `browser_storage_state` to `"ephemeral"`
(`browser-artifact-retention.ts:59-60`), fail-safe default `"ephemeral"` (`:45`).

**What is still absent:**

- `ARTIFACT_RETENTION_CLASSES = ["ephemeral","run","audit","checkpoint"]` (`policy.ts:200`) are four
  **names with no durations**. Nothing maps a class to a TTL.
- **Nothing purges a committed artifact.** `deleteObject` has call sites in `issues.ts` (task
  attachments), `worker-control.ts:143` (wired into the orphan sweeper, which collects *uncommitted*
  objects), and `job-input-staging.ts:408`. No lifecycle rule, no retention sweeper.
- **No encryption at rest.** `s3-provider.ts` builds `PutObjectCommand` with no `ServerSideEncryption`.
- **The browser profile is not destroyed by anything in the runtime.** `userDataDir` — the Chromium
  profile that *is* the cookie jar — is a parameter of `launchPersistentContext`
  (`playwright-driver.ts:26-27, 50`), created by nothing in production, and deleted by nothing.
  `runner.ts:18` states the model: *"host: destroys the sandbox."* So "session state is destroyed at
  terminal state" is today a claim about **sandbox teardown**, and it holds only as long as the
  profile never leaves the sandbox. A checkpoint, a retry that reuses a profile, or a trace that
  captures storage state each breaks it. BRW-005's "explicitly approved checkpoint retry" is exactly
  that risk.

---

## 9. What the ticket inherits that genuinely works

Recorded so the design does not rebuild any of it:

- **A required browser CI lane.** `pr.yml:1276-1358` runs a real Chromium with the OS sandbox
  enabled, and `ci-required` lists `browser` in `needs` (`:1361`) and evaluates `R_BROWSER`
  (`:1379`). Acceptance tests have a place to be falsifiable.
- **Containment, measured.** BRW-002 shipped `launch-guard.ts` (the `public_cdp_endpoint` enforcer,
  27 tests), `listening-ports.ts` (a `/proc/net/tcp`+`tcp6` delta with a negative control),
  `path-adapter.ts` (filesystem `realpath` confinement incl. symlink escape), 40 mutants / 39 killed.
- **Per-run secret redaction before the digest.** `packages/worker-daemon/src/supervisor/redaction.ts`
  runs inside `EventSequencer.#emit` **before** the digest and `workerEventV1Schema.parse()`, and
  `redactionCanaries` is a REQUIRED field on `EventSequencerDeps` so no sequencer can be built
  unscrubbed by omission (DAT-005 review fix #1). This is the mechanism that already satisfies the
  fixtures' `cookie_in_event_payload` forbidden effect and most of the "log-leak tests" clause.
- **`classifyEgressDestination` + its dual-driven `policy`-lane vectors gate** (§5).
- **The runtime-decision timeout machinery and its 30 s boot-rooted sweeper** (§3).
- **`jobApprovalBridge`** — receipt fast-path idempotency, fence guard, `park_run` semantics,
  flag-gated fail-closed. Unwired, but written and adversarially reviewed.

---

## 10. MEASURED: the golden-journey fixtures bind the SCENARIO, not the wire payload

BRW-002 terrain §2 says *"the frozen golden-journey fixtures ARE this ticket's spec."* True at the
step/authority/terminal-state level. **False at the payload level, and an implementer who codes to
the payloads will emit events the frozen schema rejects.**

Measured with a positive control against `packages/worker-protocol/dist`:

```
POSCTL network_denied {destinationClass:'metadata', reason:'x'} -> true
POSCTL terminal      {status:'succeeded',exitCode:0,errorCode:null,errorMessage:null} -> true

browser-denied-egress   seq=2 network_denied.payload:
  INVALID -> destinationClass: Required | (root): Unrecognized key(s): 'destination', 'code'
browser-approval-download seq=2 browser_approval_requested.payload:
  INVALID -> approvalId: Required | action: Required | summary: Required
             | (root): Unrecognized key(s): 'detail', 'approved'
```

Swept across all nine fixtures: **37 payloads checked, 0 wire-valid, 37 invalid.** Nine fixture
event types are not in `WORKER_EVENT_TYPES` at all (`artifact_transfer_rejected`, `budget_exhausted`,
`cancel_requested`, `lease_lost`, `producer_safety_rejected`, `provider_pause_observed`,
`quarantine_grant_issued`, `quarantine_receipt_finalized`, `replacement_lease_activated`).

The fixture validator never claimed otherwise:
`scripts/check-distributed-execution-foundation.mjs:1735-1782` checks org/company/job identity, the
declared attempt tuple, `eventId` uniqueness, strictly-increasing `seq`, non-decreasing `occurredAt`,
and recomputes every `eventDigest` — and **never validates `payload`**. `tests/fixtures/
distributed-execution/README.md` calls them "the behavioral contract" and never asserts wire shape.

**So this is a documented-by-omission convention, not a defect, and I am not filing it.** It is
recorded here because the concrete cost to BRW-004 is real: the denied-egress fixture's
`code: "metadata_destination_blocked"` / `reason: "link_local_metadata_range"` is **illustrative
prose**. The real vocabulary is `destinationClass: "metadata"` from `NETWORK_DENIAL_CLASSES`, and the
denial reason string is free text bounded at 1000 chars and passed through per-run redaction.

---

## 11. Per-clause readiness

| Acceptance clause | Ready to design? | Why |
|---|---|---|
| "OAuth refresh remains control-plane-owned" | **YES, mostly by inheritance** | §7 — live, single-caller, identity-rechecked. BRW-004 must not regress it and must not route it through the sandbox-local broker. |
| "…and live-lease/fence-bound" | **AMBIGUOUS — needs a decision** | §7 — bound to the *refresh* lease (`mcp_connector_oauth_refresh_leases`), not the *job* fence. Which one the clause means is §D4. |
| "denial/timeout fails closed" | **NO — the delivery hop does not exist** | §3 + §4. The decision is produced and durable; nothing carries it to the worker; the worker consumes nothing. |
| "session state is destroyed at terminal state" | **PARTLY** | §8 — retention authority is fixed (DAT-010); TTL/purge/encryption absent; the profile is destroyed only by sandbox teardown. |
| "allowed domains … enforced" | **NO — no store, no resolver, no consumer, wrong-shaped proxy** | §5. This is the largest build in the ticket. |
| "…and download/upload policy … enforced" | **DOWNLOAD partly / UPLOAD not at all** | BRW-002 shipped per-job download confinement by `realpath`. There is no upload path anywhere (§1), so there is nothing to gate. |
| Test: "log-leak tests" | **YES** | §9 — per-run canary redaction runs before the digest, with a required-field compile-time guard. |
| Test: "metadata/private IP" | **YES for the classifier, NO for the enforcement point** | §5 — the pure decision is proven by a dual-driven gate; nothing calls it. |
| Test: "connector rotation/revocation" | **PARTLY** | §7 — the refresh path has rotation/revocation semantics; there is no broker arm and no browser consumer. |
| Test: "approval allow/deny/timeout" | **NO end-to-end** | §3, §4, §2a. |
| Test: "login fixture" | **BUILDABLE** | BRW-002's `fixture-site.ts` is an in-sandbox deterministic site and the `browser` lane runs it. |

---

## 12. What I could NOT establish, and what is out of this ticket's reach

**Could not establish:**

- **Whether BRW-004 is permitted to build the control-command delivery hop (§4).** It requires
  editing `server/src/services/job-leasing.ts` and/or `server/src/routes/worker-control.ts`, both on
  `HANDOFF-lane-b-browser-service.md` §5.5's do-not-touch-without-coordination list, and both
  arguably E3/E4 (`JOB-*` / `WRK-*`) territory rather than E8's. `program-design.md` assigns no
  ticket to it that I could find. **This is an escalation, and the design raises it as one** (§D1)
  rather than quietly claiming the scope.
- **Whether the `browser_request` runtime-decision aggregate gap (§2a) is known to anyone.** It
  appears in no findings register, no result doc, and no handoff. I searched all nine `findings.md`
  files and `finding-ownership.json` (which has zero E8 entries).
- **What a `browser_request` job's `agentId` should be** when the requester is a `founder`
  (`browser-approval-download.json`) rather than an `agent`. The parity contract permits
  `founder | team_lead | team_member | agent` as requesters (`legacy-parity.json`), so the aggregate's
  NOT NULL `agent_id` has no natural value for three of the four.
- **Whether E2B can constrain a sandbox's egress at all.** BRW-002 measured that E2B *exposes* ports
  outbound-to-inbound (run `32630219279`); I found nothing that measures whether outbound traffic can
  be restricted at the sandbox boundary. §D3's option (c) rests on this and is marked unproven.

**Deliberately not surveyed:** BRW-003's evidence pipeline internals, BRW-006's read surface, and the
byte-egress transfer mechanism (under an E4-D02 Custodian STOP per
`HANDOFF-lane-b-browser-service.md` §10) — none is on BRW-004's clause list.

**Migration baseline, re-pinned.** `HANDOFF-lane-b-browser-service.md` §5.4 says "Lane A has taken
0262 and 0263." **Stale.** The tip is `packages/db/src/migrations/0271_real_frightful_four.sql`; the
next free slot is **0272**. Any BRW-004 slice that generates a migration must re-pin again at the
moment it generates, not trust this line.

---

## 13. What BRW-004's design must therefore settle

1. **The approval authority**, against a fixture and a sibling terrain that both say something else
   (§2), and the aggregate's NOT NULL `agent_id`/`run_id` that make the shipped answer
   unwritable for a browser job (§2a).
2. **The delivery hop** — build it, or escalate it and scope around it (§4, §12).
3. **The egress substrate** — the DAT-005 proxy does not fit a browser (§5). Cost the options; do not
   assume one.
4. **Where the network policy comes from** — there is no store (§5). A table is a migration, and a
   migration is a coordination event.
5. **The trust-rule policy for browser prompts**, before populating `networkTarget` re-enables
   `allow_always` for egress (§3b).
6. **What "live-lease/fence-bound" binds to** for OAuth refresh (§7).
7. **A positive control for every fail-closed clause** — the programme's standing requirement, and
   §3 is the live example of a lever that is real, boot-rooted, and still cannot reach its target.
