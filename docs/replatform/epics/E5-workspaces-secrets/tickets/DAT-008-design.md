# DAT-008 — Design: materialize the tenant model-provider credential into a distributed sandbox

**Epic:** `E5-workspaces-secrets`. **Terrain:** [`DAT-008-terrain.md`](./DAT-008-terrain.md)
(read revision 1 first). **Owns:** inherited deferral #1, and inherited deferral #3 (§7).
**Implements:** the CM-013 target state (`current-main-crosswalk.md:29`).
**Blocks:** MIG-005 / MIG-006 / MIG-007 going ACTIVE.

**Start SHA:** the commit that adds this file.
Line references are to `docs/replatform-program` at `373205816`.

---

> ## ★ REVISION 1 — plan-eng-review findings, folded in
>
> Seven findings, all verified against source before promotion. Two were scope decisions taken by
> the Integration Gate Owner; five were corrections with no real alternative. §11 carries the
> full list; the affected sections below are amended in place.
>
> **The two decided ones:**
>
> **R1 — warm-resume re-resolution is IN SCOPE (new slice 7).** `program-design.md:36` keeps
> Decision #120's Commander warm-E2B lifecycle authoritative *"until MIG-005 cuts it over"*, and
> MIG-005 is both the first sink and the warm-lease one. Deferring re-resolution would have
> satisfied CM-013 for cold leases only, in front of the one sink that is not cold. Decided: build
> it now rather than reorder the sinks or accept staleness.
>
> **R2 — the per-agent override splits three ways, and the data already makes the split.** The
> original design bound the company key unconditionally, which would silently override an agent's
> own key — a behavioural regression introduced by the cutover. The first fix considered was
> fail-closed for every override; that was too coarse and rested on an unchecked assumption that a
> per-agent key is a plaintext literal. It usually is not: `normalizeEnvConfig`
> (`secrets.ts:500-526`) persists env entries as `{type:"secret_ref", secretId, version}` or
> `{type:"plain", value}`, and strict secret mode (`:514`) **rejects** a non-empty plain value for
> a sensitive key outright. A `secret_ref` therefore maps directly onto an existing handle kind
> with **no data migration** — `dispatchResolvedSecret` (`secret-broker.ts:181-188`) already routes
> `company_secret` to `resolveProviderOrCompanySecret`.
>
> | Agent env state for the provider var | Handle minted | Override preserved |
> |---|---|---|
> | `secret_ref` | `refKind:"company_secret"`, `refId: secretId`, pinned `version` | yes, exactly |
> | `plain` literal (only reachable outside strict mode) | **none** — refuse to mint; job stays on legacy | yes, by not moving it |
> | absent | `refKind:"provider_key"` (the company key) | n/a — matches `needsCompanyKeyFallback` |
>
> The third row **calls `needsCompanyKeyFallback`** (`secrets.ts:291-298`) rather than restating
> its logic, so the mint and the legacy merge cannot drift on "when does the company key apply?"
> — the same argument that function's own doc comment makes for its two existing callers.
>
> **Named residual:** an agent with a plain-literal provider key outside strict secret mode cannot
> be cut over. **Measure how many exist before MIG-005**; do not assume zero.

---

## 1. The one-sentence goal

A distributed job's sandbox can authenticate its CLI with the Company's model-provider key,
where the key **never crosses the frozen wire** — only an opaque handle does — and every
resolution is authorized per-attempt behind an active fence.

## 2. The architecture is decided; this ticket implements it

Not restated here — see terrain revision 1. In one line: **`materialization: env` +
`usePolicy: sandbox_local_only`**, per CM-013, `program-design.md:35`, `program-design.md:765`
and CLAUDE.md Rule #11. The `proxy` + `fence_proxy` path that DAT-005 built serves the
**connector-OAuth** class and is not on this ticket's path.

### 2.1 The redemption channel — settled by E4's own non-goals, not invented here

The terrain's one genuinely open item was: *how does the worker obtain the value it must
materialize, given the frozen op list has no secret op?* Three pieces of in-tree evidence settle
it, and none of them requires a protocol change:

1. **E4 explicitly assigned this to E5/DAT.** `E4-worker-daemon/implementation-plan.md:830-833`,
   WRK-005's non-goals: *"the **live** artifact-commit / **secret-materialization** / completion /
   governed-egress **transport ops and their server routes** (no … egress-proxy … server route
   exists — **E5/DAT owns them**)."* A secret-materialization route + its worker transport op is
   *planned* work, deferred to this epic. It is not a frozen-protocol violation.
2. **DAT-004 and DAT-005 already declared these shapes non-frozen by design.**
   `SecretResolveRequestV1` — *"Not a frozen wire op — the caller presents the same complete
   active fence as a commit plus the opaque handle id"* (`secret-broker.ts:48-50`);
   `EgressRequestV1` — *"Not a frozen wire op"* (`egress-proxy.ts:49-50`). The request shapes live
   control-plane-side on purpose. `packages/worker-protocol/` is not touched by this ticket.
3. **DAT-005 pre-built the worker-side scrubber for values the worker holds.**
   `packages/worker-daemon/src/supervisor/redaction.ts` is *"the NET-NEW **worker-daemon** in-place
   secret-redaction scrubber"* with **per-run secret canaries**, and `supervisor.ts:283` records
   *"E4-D12 seeds the canaries; `[]` until then."* A per-run canary registry inside the worker
   only exists because the worker was always expected to hold per-run secret values transiently.

> **Therefore: the worker holds the plaintext transiently, between redemption and
> `provider.create`.** That is the decided design, not a compromise. §6 states the mitigations and
> §9 states the residual honestly.

## 3. What exists, what is missing

Built and **not** to be rebuilt: `resolveExecutionSecret` (fence-first, owner re-derived from the
LOCKED job row, membership re-checked in-tx, audit-as-columns, returns a non-secret binding),
`createSecretBrokerService.resolve()`, `dispatchResolvedSecret`, the frozen
`secretHandleRefSchema`, and the worker redaction scrubber.

Missing (terrain §2, plus one more this design surfaces):

| # | Missing | Slice |
|---|---|---|
| M1 | Nothing writes `job_secret_handles`; `job-leasing.ts:362` sends `secretHandles: []` | 1, 2 |
| M2 | `supervisor.ts:199` — `env: {}`; the sandbox gets no environment | 5 |
| M3 | The broker chain has no boot root | 4 |
| M6 | `failClosedSecretBrokers` is still the default value store | 3 |
| **M7** | **Nothing seeds the redaction canaries** — `supervisor.ts:283`, `[]` until wired | 5 |

M4 (the proxy cannot carry an LLM call) and M5 (no network-policy store) belong to the
connector/`fence_proxy` class. **Out of scope here** — see §9 limit 1.

---

## 4. The slices

Each slice is independently testable and lands fail-first. Slices 1–4 are control-plane only and
change no runtime behaviour while `secretHandles` is empty; slice 5 is the first behavioural
change on the worker.

### Slice 1 — mint the handle (control plane)

**Inputs (R3, R4, amended).** The mint is keyed on the agent's **adapter type**, not a provider
id: `companyKeyTargetForAdapter(adapterType)` (`secrets.ts:251`) returns `{ownerId, secretName,
envVar}` or **`null`** when that adapter has no company key — and that `null` is the "mint
nothing" signal, so no separate disposition list is needed. Two gates precede it:

- **Deployment mode.** Self-hosted has no hosted key (Rule #11 / Decision #104); the CLI uses its
  local login. Reuse the existing `gateCodingAdapterDispatch(adapterType, deploymentMode)` +
  `CLOUD_SANDBOX_MODES` (`sandbox-coding-disposition.ts:155-163`) rather than a second mode gate.
- **Per-agent override.** The three-way split in revision 1 R2, branching on
  `needsCompanyKeyFallback`.

Then write one `job_secret_handles` row inside the existing placement transaction:

| Column | Value | Why |
|---|---|---|
| `handle` | **`crypto.randomUUID()`** | The wire demands a branded uuid (`ids.ts:44`) while the column is `text` (`job_secret_handles.ts:26`). A slug here mints an envelope that fails validation — terrain trap. |
| `refKind` | `"provider_key"` | Selects `resolveProviderOrCompanySecret` in `dispatchResolvedSecret`. |
| `refId` | `resolveProviderKeyTarget(providerId).secretName` (`provider:anthropic`) | The existing non-secret pointer (`provider-key.ts:79`). |
| `materialization` | `"env"` | Decided (§2). |
| `usePolicy` | `"sandbox_local_only"` | The only pairing the frozen schema permits with `env` for a non-network handle. |
| `destination` | `null` | A `sandbox_local_only` handle may never bind a network destination. |
| `boundTargetGeneration` | the placement target generation | D5 pin, defense in depth over the lease-level cutoff. |
| `status` | `"active"` | |

The **env-var name** (`ANTHROPIC_API_KEY`) comes from `resolveProviderKeyTarget(...).envVar` and
travels in the wire ref's `materialization.target`, **not** in the DB row's `materialization`
column (which stores only the kind). Consequence worth stating: **the worker never learns which
provider it is running** — it sets the name it is told. That is a property to preserve, not an
accident.

*Re-resolve on every new lease* (CM-013) falls out for free: the handle is a reference, and
resolution happens per redemption, never at mint.

### Slice 2 — populate the envelope

`buildJobEnvelope` (`job-leasing.ts:362`) reads the job's active handles and emits
`secretHandles: [{handleId, materialization: {kind:"env", target}, usePolicy:"sandbox_local_only"}]`.
The existing `jobEnvelopeV1Schema.safeParse` at `:374` is the gate — a malformed handle yields a
`null` envelope and no lease, which is the correct fail-closed direction.

### Slice 3 — wire the real value store

Replace `failClosedSecretBrokers` for the `provider_key` / `company_secret` arms with the
existing `resolveSecretValue` chokepoint. `connector_oauth` **stays fail-closed** in this ticket —
that arm belongs to the `fence_proxy` class and wiring it here would widen the blast radius past
the acceptance.

### Slice 4 — the redemption route

`POST /api/worker-control/execution-secrets/resolve`, mounted beside the existing ten in
`worker-control.ts`, authenticated by the **same** device proof + worker session as every other
worker route (E4-D03). The body is `SecretResolveRequestV1` (`secret-broker.ts:50`) **reused
verbatim** — not a third request shape. It calls `createSecretBrokerService.resolve()`.

> **★ R5 — the route needs its own descriptor, or it silently loses four protections.**
> Every existing worker route derives them from the frozen op: `worker-control.ts:487` parses with
> `artifactCommitOperationRequestV1Schema`, which pins `audience: z.literal("worker_run")`
> (`transport.ts:263`), and bounds the body with `OPERATION_DESCRIPTORS.artifact_commit.maxRequestBytes`.
> `verifyWorkerOperationProof` (`middleware/worker-operation-proof.ts:34-50`) checks only
> `claims.organizationId` and `claims.scope` — **it never checks the op audience.** A route with no
> descriptor therefore has no audience binding (a `worker_poll` session could redeem secrets), no
> request-size ceiling, no timeout, and cannot emit a typed protocol error, because
> `sendWorkerOperationProtocolError` is keyed on an op name.
>
> **Fix:** define a local, non-frozen descriptor beside the route — audience pinned to
> `worker_run` (the fence-bearing audience every other fence op uses), an explicit
> `maxRequestBytes` and `timeoutMs`, and an explicit audience check against the session claims,
> since no frozen schema will do it for us. `packages/worker-protocol/` is still not touched.
> **Mutation-tested**, and the audience check gets a negative test with a genuinely valid
> `worker_poll` session — a test using an invalid session would pass either way.

**This route is the boot root that closes M3** for the `sandbox_local_only` class.

Two refusals are load-bearing and both are mutation-tested:

- **A non-`env` / non-`sandbox_local_only` outcome is refused on this route.** A `fence_proxy`
  handle must never yield its value over a channel that hands it to a worker. This is the guard
  that keeps the two credential classes apart at the transport, not merely at mint.
- **A `device_handoff` outcome is refused.** `device_local` returns a descriptor, never a value;
  the route must not silently treat a missing value as an empty one.

Denials keep the broker's coarse, non-disclosing vocabulary (`stale_fence`, `attempt_terminal`,
`target_revoked`, `malformed`) — no new disclosure surface.

### Slice 5 — worker redemption, env synthesis, canary seeding

`createSpecFor` becomes async and, for each `secretHandles[]` entry, redeems and builds
`env[target] = value`. Three guards:

1. **A target-name allowlist.** `envTargetSchema` (`policy.ts:109`) is *any* uppercase POSIX name
   — it would accept `PATH` or `LD_PRELOAD`. The worker admits only the provider-auth names, and
   an unknown target **fails the run** rather than being dropped silently (a dropped credential
   surfaces as an opaque CLI auth error much later).
2. **Every redeemed value is seeded as a redaction canary** before the sandbox is created —
   closing M7. This is ordered *before* create so no lifecycle event can precede the canary.
3. **A redemption failure fails the attempt.** It never proceeds with a partial env — a CLI
   started without its key burns a provider round-trip and reports a misleading error.
4. **★ R6 — redemption gets its own deadline, inside the create budget.** `createSpecFor`
   (`supervisor.ts:195`) is currently synchronous and `withDeadline` wraps only `create`
   (`:291`). Making spec-building async without a deadline puts a hanging redemption **outside
   every timeout the supervisor has**. The redemption budget is subtracted from the create budget,
   not added to it, so a slow control plane cannot extend a run's wall clock.
5. **★ R7 — retry is bounded and explicit, because resolution is NOT a safe read.**
   `resolveExecutionSecret` writes `last_resolved_at` / `resolve_count` in the same audit UPDATE
   (`job_secret_handles.ts:56-64`). A blind retry inflates the audit and makes `resolveCount`
   useless as a signal. One retry at most, only on a transport error (never on a denial), and the
   test asserts `resolveCount` increments **exactly once** for a successful redemption.
6. **E4-D04 parity.** The daemon vendors the route path and any constants in
   `transport/client.ts` with a contract test asserting the exact strings, exactly as it does for
   the other ten paths — it may not import them.

### Slice 6 — deferral #3, the tautological owner check

See §7.

### ★ Slice 7 — warm-resume re-resolution (revision 1 R1)

A handle is a reference, so cold-lease re-resolution is free (§4 slice 1). A **warm** sandbox is
not: it holds the value baked into its env at create, so a rotated or revoked key never reaches
it. That is the gap CM-013's *"re-resolve on every new lease and warm resume"* names, and MIG-005
is the sink that has warm leases.

On warm resume, before the sandbox is handed any further work: redeem again, and if the value
differs from the one the sandbox was created with, the sandbox is **not reused** — it is torn down
and recreated. Comparing without ever re-materializing keeps the decision cheap and avoids a
second injection path into a live sandbox.

- A *denied* re-resolution (revoked handle, replaced fence) tears down and does **not** recreate:
  the credential is gone, so there is nothing to run with.
- The comparison is over the redeemed value, so the test must make the two values **actually
  differ** — a test that rotates nothing proves only that equal values compare equal.

---

## 5. Tests — fail-first, per the process

| Area | Test |
|---|---|
| Mint | uuid not slug; correct `refId`/`target`; `destination` null; generation pinned |
| **Mint — three-way split (R2)** | `secret_ref` → `company_secret` handle with the pinned `secretId`/`version`; `plain` literal → **no handle minted** and the job is not routed distributed; absent → `provider_key`. The `secret_ref` case asserts the agent's own secret is used, not the company's |
| **Mint — mode gate (R4)** | self-hosted mints nothing; `cloud_auth` mints. Asserted through `gateCodingAdapterDispatch`, not a re-implemented mode check |
| **Route — audience (R5)** | a **valid** `worker_poll` session is refused; a `worker_run` session is admitted. Over-size body refused; timeout enforced |
| **Retry / audit (R7)** | `resolveCount` increments **exactly once** on success; a denial is never retried |
| **Warm resume (R1)** | an unchanged value reuses the sandbox; a **genuinely rotated** value tears down and recreates; a denied re-resolution tears down and does not recreate |
| **Deadline (R6)** | a hanging redemption is cut off by the create budget, not left unbounded |
| Envelope | handles appear; a malformed handle yields `null` envelope and **no lease** (fail-closed direction asserted, not just parse failure) |
| Route authz | wrong tenant / wrong job / stale fence / terminal attempt / revoked target — each denied with the exact frozen reason and **no disclosure difference** between "foreign handle exists" and "does not exist" |
| **Class separation** | a `fence_proxy` handle presented to the resolve route is refused **even though the broker would resolve it** — the guard is at the route, so the test must prove the broker succeeded and the route still refused |
| **device_local** | a `device_handoff` outcome is refused, not coerced to an empty value |
| Worker | env contains exactly the declared targets; an unknown target fails the run; a redemption failure fails the attempt with no sandbox created |
| **Redaction** | a redeemed value appearing in an emitted event is scrubbed — and the canary is seeded **before** `provider.create`, asserted by call ordering |
| Wire | no `packages/worker-protocol/` edit; `check:frozen-worker-protocol-v1` + boundary checks green |
| Integration | full lease → redeem → create round trip on embedded Postgres (Linux CI; `AOA_RUN_WIN_INTEGRATION=1` locally) |
| Mutation | every guard in slices 4, 5, 6 |

**Anti-vacuity, stated up front** — this programme's recurring defect is a check that cannot
fail. Two specific traps here:

- The class-separation test must present a handle the broker **really would** resolve. Asserting
  refusal of a handle that fails anyway proves nothing.
- The redaction test must assert the value **was** in the pre-scrub event. A test where the value
  never appears passes whether or not the scrubber runs.

---

## 6. Security posture — what this does and does not change

**Unchanged from what already ships.** PR #320's live `cloud_auth` path already resolves the
Company key on the host and materializes it into the tenant E2B VM. This ticket reproduces that
exposure on the new substrate. It is a cutover, and a cutover minimizes behavioural delta.

**Improved.** The value no longer sits in a host process for the run's duration; it is resolved
per-attempt behind a fence, bound to `(org, job, attempt, lease, fence, target generation)`, and
audited as columns on every resolve.

**New surface.** The worker holds the plaintext transiently. Mitigations: values are seeded as
redaction canaries before any event can be emitted; nothing persists them; a new lease re-resolves;
and — structurally — a Company key can never route to a customer-owned machine, because
`owner_desktop` targets resolve `credentialKind: "personal_subscription"`, not `company_api_key`
(`job-leasing.ts:182-196`). §7 stops that from resting on a tautology.

---

## 7. Deferral #3 — the owner check is tautological, and this ticket is where it bites

Inherited deferral #3: *"`credentialOwnerId` and `requiredOwnerPrincipalId` both read from the
routed target's profile. Safety currently rests on the structural exclusion of `owner_desktop`
routing, not on that check."* Its own ledger row says **"re-derive before enriching credential
binding (interacts with #1)"** — that is this ticket.

The design's §6 argument leans on exactly that structural exclusion. Leaning on it without fixing
it would repeat the programme's signature failure: an acceptance clause that is vacuously true.

**Fix:** at mint, assert from a **second, independent** authority — the job row, not the target
profile — that a `provider_key` handle is never minted for a placement whose owner is
`owner_desktop`, and fail closed if the two authorities disagree. Mutation-tested, with a test
that makes the two sources **actually disagree** rather than asserting agreement between a value
and a copy of itself (the MIG-005/006/007 comparator lesson).

---

## 8. Out of scope — named, with owners

- **The `fence_proxy` / connector-OAuth path** (M4, M5): the streaming reverse proxy and the
  network-policy store. Not needed for `sandbox_local_only`.
- ~~**Warm-resume re-resolution**~~ — **pulled INTO scope as slice 7** (revision 1 R1).
- **Proactive rotation/revocation push to a running sandbox.** Slice 7 re-resolves at resume
  boundaries, not mid-run. A key rotated while a sandbox is actively executing is picked up at the
  next resume, not immediately. Handle revocation is already representable (`status`/`revokedAt`
  are read by `authorizeSecretResolve`), so the *next* redemption fails closed.
- **Agents with a plain-literal provider key outside strict secret mode** (revision 1 R2 residual).
  They stay on the legacy executor. Measure the count before MIG-005.
- **`gemini_local` / `opencode_local` / `cursor` / `grok_local` / `pi_local`** — CLI-001's v1
  scope is `claude_local` + `codex_local` only.

## 9. Limits this design does not remove

1. **Egress from the sandbox is not network-policed on this path.** With the key in the sandbox,
   the CLI reaches the provider directly and the DAT-005 proxy is not on the path. DAT-005's
   acceptance clause *"bypassing the proxy is denied"* is therefore **unmet for the distributed
   path**, exactly as it is unmet for #320's live path today. Whatever network confinement exists
   is the E2B sandbox's own. Stated, not papered over; it belongs to the `fence_proxy` class.
2. **The worker holds the plaintext transiently.** §6. Not removable while the worker is the
   party that creates the sandbox.
3. **No live traffic proves this.** Same shortfall as gate clause 2 — the evidence will be
   integration-level until a deployment drives a real Commander turn.

## 10. Rollback

Mint nothing. With slice 1 disabled the job has no handles, slice 2 emits `secretHandles: []`, and
slices 4–5 are unreachable — byte-identical to today's behaviour. The rollback unit is the mint,
which is why it is slice 1 and not slice 5.

---

## 11. Review ledger — plan-eng-review, all seven findings

Run against this design before any code. Every finding was verified by quoting the motivating
source line before promotion; none is a pattern-match.

| # | Sev | Conf | Finding | Disposition |
|---|---|---|---|---|
| R1 | P1 | 8/10 | Warm-resume re-resolution deferred, but MIG-005 is both the first sink and the warm-lease one (`program-design.md:36`) | **In scope** — new slice 7 |
| R2 | P1 | 9/10 | Mint bound the company key unconditionally, silently overriding an agent's own key (`secrets.ts:269-289`) | **Fixed** — three-way split, revision 1 |
| R5 | P0 | 9/10 | The new route inherits no audience binding, size ceiling, timeout, or typed error emitter; `verifyWorkerOperationProof` never checks op audience (`middleware/worker-operation-proof.ts:34-50`) | **Fixed** — local descriptor + explicit audience check, slice 4 |
| R3 | P2 | 8/10 | The mint's input was unnamed; `companyKeyTargetForAdapter` (`secrets.ts:251`) already keys on adapter type and returns `null` as the mint-nothing signal | **Fixed** — slice 1 inputs |
| R4 | P2 | 8/10 | No deployment-mode gate; self-hosted has no hosted key (Rule #11) | **Fixed** — reuse `gateCodingAdapterDispatch`, slice 1 |
| R6 | P2 | 7/10 | `createSpecFor` goes async while `withDeadline` wraps only `create` (`supervisor.ts:291`) | **Fixed** — redemption budget subtracted from create, slice 5 |
| R7 | P2 | 7/10 | Resolution is not a safe read — it writes `last_resolved_at`/`resolve_count` (`job_secret_handles.ts:56-64`), so blind retry inflates the audit | **Fixed** — bounded retry + exact-once assertion, slice 5 |

Code-quality findings folded in without a row: reuse `SecretResolveRequestV1` rather than a third
request shape (slice 4); E4-D04 path vendoring with a parity contract test (slice 5).

**What the review changed about the shape of the ticket:** two of the seven (R1, R2) were scope,
not correctness — the design was internally consistent and still wrong about what it had to
cover. R5 was the one true defect: a new route that looked like the other ten and silently was
not. R2 is worth remembering for its own reason — the first fix considered was fail-closed for
every override, which was too coarse, and the correction came from reading how the value is
actually persisted rather than defending the recommendation.
