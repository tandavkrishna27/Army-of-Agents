# adapter-manager (Tier 0) — scope: the networked provider host

**Status:** scope · **Date:** 2026-08-28 · **Worktree:** `C:\e3` · **Branch:** `docs/replatform-program`
**Purpose:** scope `adapter-manager` — the out-of-process networked host of the real `E2bSandboxProvider`,
the Tier-0 code the E7-1 cloud campaign is blocked on ([[c0-staging-deploy-scope]] v2). Grounded in a
full terrain recon (2026-08-28). Read-only; nothing here builds.

---

## 0. TL;DR

- **adapter-manager is a mini-epic, not a ticket.** It is a new **server** (hosts `E2bSandboxProvider`,
  sole holder of `E2B_API_KEY`) + a new **worker-side networked `SandboxProvider` driver** (DEP-011's
  remit) + a **net-new wire schema** (11 provider ops, a streaming `execute`, a bearer-secret crossing) +
  **mutual-auth transport** + **conformance** + **deploy**. adapter-manager itself has **no owning
  ticket**; DEP-011 owns only the worker-side wire and is a deliberately-deferred stub.
- **The seam is clean and the port needs no change.** `SandboxProvider` (`provider.ts`) is
  transport-agnostic by construction; `EffectAuthority`/`CleanupAuthority`/supervisor are provider-agnostic.
  The frozen `PROVIDER_OPERATIONS` (11) must NOT grow — the wire serves them, it does not extend them.
- **★ The one decision the human owns: where the per-run Company model key is redeemed** (§3.1). It is the
  security crux and it changes the trust model. Everything else is engineering the scope can sequence.
- **Recommended first slice:** the wire + the worker-side driver + adapter-manager's skeleton proven
  against the **fake provider** — no real E2B, no credentials, no streaming — so the transport and per-op
  round-trip are de-risked before the hard parts (credentials, streaming, real E2B) land.

---

## 1. What it is (synthesis, grounded)

In the cloud model the containerized worker runs untrusted tenant code and **must never hold the
provider-control credential** (`checkProviderControlBoundary`: `E2B_API_KEY` only on adapter-manager, the
only service on `provider-ctl-net`). So the real provider must run out-of-process. adapter-manager binds
the **authoritative per-op `SandboxProvider` port** across a network hop on `control-net`: the worker's
`deps.provider` — the same seam the **desktop lane** fills in-process via
`resolveSandboxProvider` (`worker-keystore/src/bin/sandbox-provider.ts`, which constructs
`new E2bSandboxProvider({ transport: createRealE2bTransport(), templateId })` and reads `E2B_API_KEY`
itself) — instead becomes a **networked driver** that RPCs each op to adapter-manager. adapter-manager
receives the op, dispatches to its in-process `E2bSandboxProvider` over `RealE2bTransport` → the `e2b` SDK,
and returns the port's typed result. The worker's `EffectAuthority`/`CleanupAuthority` gating, supervisor
lifecycle, secret redemption, and event outbox are **untouched** (they wrap the port, which is unchanged).
**One line: adapter-manager is the desktop in-process provider construction, moved across a process
boundary so the credential + the E2B egress live on one isolated surface.**

## 2. Components (decomposition)

| # | Component | Where | Exists? |
|---|-----------|-------|---------|
| C-wire | The provider wire schema — 11 ops (`create/execute/cancel/kill/destroy/list/inspect/reconcile_cleanup` + `checkpoint/restore/health`) + the 2 artifact methods + the 4 capability props; per-op request/response, error vocab (`UnsupportedProviderOperation`/`SandboxNotFoundError`/`SandboxEgressDeniedError`), `ProviderOpContext{deadlineMs,idempotencyKey}` | new (non-frozen; NOT in `worker-protocol`) | ✗ |
| C-srv | adapter-manager server — HTTP/RPC listener on `control-net`, hosts `E2bSandboxProvider` over `RealE2bTransport`, holds `E2B_API_KEY`, `/healthz`, mutual-auth + peer-allowlist | new service | ✗ (zero impl) |
| C-drv | The worker-side networked `SandboxProvider` driver — presents the authoritative per-op port, RPCs to adapter-manager; the container `worker-daemon` bin injects it as `deps.provider` | `packages/worker-daemon` (DEP-011) | ✗ (stub) |
| C-stream | Streaming `execute` — today stdout/stderr ride in-process `E2bStreamHandlers` callbacks below the port; over the wire `execute` becomes a long-lived streaming RPC | new | ✗ |
| C-cred | The per-run Company model-key crossing (§3.1 — the decision) | new | ✗ |
| C-conf | Conformance — the networked provider must pass `runSandboxProviderContract` (wrap the per-op driver in `perOpToInvokeDriver`) + `runSandboxIsolationConformance` (DEP-008 hostile) | `sandbox-provider-contract` (exists) | reuse |
| C-deploy | Dockerfile + image build/sign/**admit** + the staging worker's `AOA_WORKER_PROVIDER_URL` (undeclared today) | `docker/`, `docker/images/`, manifest | ✗ |

## 3. The load-bearing decisions the scope surfaces

### 3.1 ★ THE DECISION (human-owned): where is the per-run Company model key redeemed?

Two credentials split the wrong way. `E2B_API_KEY` (provider-CONTROL) stays on adapter-manager — clean.
But the **per-run Company model key** (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`) is redeemed **by the worker
today** (`secret-redemption.ts` `synthesiseRunSecrets` → `createRedeemer` → a device-proof-signed request
bound to the run fence; allowlist `PROVIDER_AUTH_ENV_TARGETS`) and folded into `CreateSandboxSpec.env`,
which the provider forwards to the sandbox. With the provider out-of-process, that env is a **bearer
secret that must cross worker→adapter-manager.** Decision #104 says the redeemed value must never be
serialized into protocol/logs — so this crossing is the crux.

- **(i) Send the redeemed env over the wire.** Worker redeems as today, then sends the bearer secret to
  adapter-manager over a **mutually-authenticated, control-net-internal** hop. Smaller change (redemption
  stays put), but the redeemed Company key now transits a wire — a new disclosure surface. Mitigations:
  mTLS, control-net is `internal:true`, per-run redaction, shortest-lived materialization.
- **(ii) Relocate redemption into adapter-manager.** The worker passes its **fence + device-proof
  context**; adapter-manager redeems the Company key itself and injects it straight into the sandbox env,
  so the key never sits on the worker→server payload. More consistent with "the untrusted worker holds no
  secrets" (the boundary's whole thesis — arguably the untrusted worker should not redeem the Company's
  model key at all), but it **relocates the redemption trust model**: the fence/device-proof authority must
  move to adapter-manager, and the resolve route's worker-identity binding changes.

**Lean: (ii)** is more faithful to the provider-control thesis (minimize secrets on the untrusted worker
and the wire), but it is the bigger change and reshapes the secret-broker trust model — so it needs the
design→review pass and a human sign-off, not a unilateral pick here. **This decision gates C-cred and
influences C-wire.**

### 3.2 Which op results cross the wire, and redacted how?

`InspectResult` deliberately carries `command`/`env`/`secrets`/`objectGrants`/`logs` so the cleanup
authority's redaction is a real projection ("`cleanup` NEVER returns this object — only
`RedactedResourceProjection`"). Serializing the full `InspectResult` over the wire **re-introduces exactly
the disclosure the in-process redaction prevents.** The wire must decide, per op, what stays
adapter-manager-local vs crosses as a redacted projection — conformance's `PROVIDER_PROJECTION_KEYS`
(`{providerId,resourceId,state,checkpoint}`) is the ceiling for management-plane rows.

### 3.3 The streaming transport (C-stream)

`execute` returns a single `ExecuteResult`; stdout/stderr stream via in-process `onStdout/onStderr` below
the port. Over the network `execute` becomes a long-lived streaming RPC (SSE / gRPC-stream / websocket) and
the driver reconstitutes the chunk callbacks. The D1 `/invoke` single-round-trip does **not** model this —
so the transport choice is load-bearing (it must carry both unary ops and one streaming op).

### 3.4 The wire must preserve in-process invariants

create-idempotency replay (`ProviderOpContext.idempotencyKey` — a lost/duplicated `create`/`destroy` must
not double-provision or strand a sandbox), the driver-owned zero-deadline verdict, `list` pagination
determinism, and the exception vocabulary mapping across the wire **without becoming existence oracles**.

## 4. Risks

1. **The credential crossing (3.1)** — the security crux; a wrong choice leaks the Company key or over-trusts the worker.
2. **Greenfield on both ends** — no worker-side networked client exists; `AOA_WORKER_PROVIDER_URL` is consumed by nothing; adapter-manager is zero-impl; the wire schema does not exist. This is a build-everything effort.
3. **Redacted-projection leakage over the wire (3.2)** — the in-process redaction guarantee must be re-expressed at the network boundary or it silently regresses.
4. **Streaming faithfulness (3.3)** — a naive request/response transport drops or reorders execution output.
5. **Conformance + isolation (DEP-008 hostile suite)** — the networked provider must still pass the full contract, including the hostile isolation reference; the network hop adds new failure modes (partition, duplicate delivery) the suite may not cover yet.

## 5. Ticket / epic structure (recommendation)

adapter-manager + its wire + the worker driver are **one seam, two ends** — they must be co-designed (you
cannot build one without the other's contract). Recommendation:
- **A new epic or a REL/DEP mini-epic "the networked provider seam"** with: `adapter-manager` (server —
  **needs a new ticket**, currently none), the shared **wire schema**, **DEP-011** (the worker-side driver
  — the existing stub, now buildable because its peer is being designed), C-cred, C-stream, C-conf,
  C-deploy. Whose epic: the manifest/DEP-006 lineage is E6, but a net-new service + credential trust model
  is closer to E7 (coding-e2b, which owns the E2B provider) or a fresh epic. **Decide at scoping.**
- adapter-manager's server ticket needs a numeric id (→ a `#### ID` program-design node + `Depends on:`
  edges, or `check-ticket-graph-coverage` reds `policy`) — unlike the recent graph-inert guard slugs, this
  is real product work that belongs in the graph.

## 6. Sequencing — the recommended first slice

Build inside-out, de-risking the wire before the hard parts:
1. **Slice 1 (the wire + round-trip, no secrets/streaming/real-E2B):** define C-wire for the **unary**
   ops (`create/cancel/kill/destroy/list/inspect/reconcile_cleanup`); build C-srv skeleton hosting the
   **fake provider** (`createFakeSandboxProvider`) and C-drv (the worker-side per-op driver) against it;
   prove the per-op round-trip + idempotency + error-vocab + redacted `inspect` over the wire. Reuse the D1
   fake-provider's **container/health/net-seg/peer-allowlist scaffolding** as the transport reference
   (§7). No credentials, no streaming, no E2B key. This is the cheap, high-value de-risk.
2. **Slice 2:** streaming `execute` (C-stream) — the one op the D1 pattern can't model.
3. **Slice 3:** host the **real** `E2bSandboxProvider` + `RealE2bTransport` in C-srv (the E2B key lands on
   adapter-manager); conformance (C-conf) + the DEP-008 isolation suite.
4. **Slice 4:** the credential crossing (C-cred) per the §3.1 decision.
5. **Slice 5:** C-deploy (Dockerfile + build/sign/admit + the staging worker `AOA_WORKER_PROVIDER_URL`).
Then Tier 1 (C0 deploy) → the E7-1 campaign → evidence-verifier A.

## 7. Open questions for adversarial review

1. **The credential decision (3.1)** — is (ii) actually feasible without breaking the device-proof/fence
   binding the resolve route enforces? Trace `resolveExecutionSecret`'s worker-identity check and whether
   adapter-manager could present it.
2. **Is the fake-provider transport truly reusable as Slice-1 scaffolding**, or does presenting the per-op
   port (vs the fake's `invoke(op,args)` shape) mean the wire shares nothing with D1 but the container
   hardening? (Recon says the latter — confirm.)
3. **Does hosting `E2bSandboxProvider` out-of-process break any assumption it makes about being in the
   worker's process** (the idempotency ledger is an in-memory `#idempotency` map — does it need to survive
   an adapter-manager restart, i.e. become durable)?
4. **Streaming transport choice** — is there an existing streaming RPC pattern in the repo (the event
   outbox? SSE from Commander?) to reuse, or is it net-new?
5. **Scale/isolation** — one adapter-manager (replicas 1-3) brokers all workers' provider ops; is that a
   bottleneck or a blast-radius concern for a multi-tenant cloud, and does the per-run credential model
   keep tenants isolated across a shared broker?

## 8. Review round — three-agent adversarial pass (2026-08-28), all verified against source

**Decisions settled + corrections:**
- **★ Credential fork RESOLVED → (i)** (worker redeems, sends the key to adapter-manager over the
  mutually-authenticated internal hop). My v1 lean (ii) was wrong: redemption is bound to the worker's own
  device identity (`secret-broker.ts` `request.workerId !== auth.workerId → unauthorized`; device-proof
  thumbprint binding) — adapter-manager cannot stand in without a new delegation that makes one shared
  broker the standing minter of every tenant's key (worse blast radius). (i) adds one mTLS control-net leg
  to a path the value already crosses (the resolve response) and is already canary-scrubbed.
- **★ MANDATORY wire rule (F2, both reviewers):** the wire's `inspect`/`list` return **redacted
  projections only**; the full `InspectResult` (env/secrets/command/logs/objectGrants) must NEVER cross —
  redact adapter-manager-local, and move the CleanupAuthority ownership check to a **label hash**
  (`resourceLabelsHash` exists) or an AM-local owned/not-owned verdict. This decision lands **inside Slice
  1**, so §1's "authorities untouched" is false for the inspect/list path — reconcile the wording.
- **★ Delete the streaming slice** (completeness A + wire F4, verified `e2b-provider.ts:248`): the port's
  `execute` is **unary and byte-free** (opaque `stdoutRef`/`stderrRef`; the stream is discarded). Streaming
  customer bytes across the provider wire would **re-introduce the E5 byte-egress the boundary forbids**.
  Live output rides the already-frozen `event_upload` outbox, not this wire. C-stream is
  adapter-manager-local (it consumes stdout locally into the ref model) — not a slice.
- **Slice 1 hosts `new E2bSandboxProvider({ transport: new MockE2bTransport() })`** — the real per-op
  provider over the key-less mock (wire F1). The D1 `createFakeSandboxProvider` is the *invoke-driver*
  shape, not the per-op port, and the per-op namesake is the WRK-009-removed "fabricates success" fake —
  hosting it resurrects what WRK-009 excised. This is strictly better: Slice 3 becomes a pure
  `MockE2bTransport → RealE2bTransport` swap of the *same* hosted provider. Only D1's
  container/health/net-seg/peer-allowlist harness is reused — **not** the `/invoke` envelope.
- **Add a durable idempotency ledger component** (wire F3): `E2bSandboxProvider.#idempotency` is an
  in-memory map; out-of-process, adapter-manager restarts independently of the worker → a replayed `create`
  double-provisions. Persist `idempotencyKey → {sandboxId,resourceLabels}`; scope with Slice 3.
- **Slice 1 is COMPONENT-LEVEL** (driver ↔ server in an integration test); nothing dispatches *through the
  daemon* until the composition seam (a `AOA_WORKER_PROVIDER_URL` consumer + `deps.provider` inject + the
  two-pass dispatch gate chain) is built — itself non-trivial, and it belongs to DEP-011/worker-daemon, not
  adapter-manager (wire F5).
- **Correctly greenfield** (completeness C): the World-1 server-side `sandbox-provider-runtime.ts` (the
  PR-#320 `cloud_auth` lease-oriented host) is the **legacy sink being migrated away**, NOT reusable. But
  the E2B SDK integration is done (`real-transport.ts`), so hosting the real provider is near-zero E2B work.
- **No routing capability** (completeness D): the 12-name capability vocabulary is frozen; `AOA_WORKER_PROVIDER_URL`
  is the lever, and a provider-less-worker placement is backstopped by `decideDispatchComposition`'s
  `no_provider` refusal at dispatch (DEP-011's remit).
- **Epic: E6, alongside DEP-011** (completeness F): adapter-manager (server) + DEP-011 (worker wire) are one
  seam, two ends; DEP-011 is fixed in E6 (`Depends on: DEP-010`, owns E6-F003). A new `#### <ID>` node in
  E6, `Depends on: DEP-010`, DEP-011 repointed onto it.

## 9. ★ THE REFRAME — adapter-manager is ONE of ~7 links (WAVE-4-RESEQUENCE), not the last blocker

> **★ SUPERSEDED (terrain only) — see [`2026-08-28-worker-dispatch-chain-reconciled.md`](./2026-08-28-worker-dispatch-chain-reconciled.md).**
> The per-link OWNERSHIP verdicts below are quoted from WAVE-4-RESEQUENCE's **2026-08-23** snapshot and
> are STALE: Sprints 2.5 / 2.75 / 3 (landed 2026-08-25/26, after that snapshot) moved **3.3 session
> acquisition, 3.4 matchable hello, 3.5 self-model read, and 3.6 loop composition** to OWNED (composed
> behind the default-off flag; `composeDispatchRuntime.start()` calls `pollLoop.run()`, so the "start
> seam missing" claim is false). The genuinely unowned/unbuilt remainder is **three** links — 3.1
> container identity (→ WRK-014), 3.2 POSIX enrolment input (→ WRK-015), and 3.7 provider transport
> (→ this ticket's server, DEP-012, + DEP-011 wire) — not four-plus. This §9 restated the snapshot
> without reconciling it against those sprints; the reconciliation doc is the record of ownership at
> tip. **§8 (the SETTLED provider-topology CONTRACT) is a decision, not a terrain claim, and is
> UNAFFECTED.**

The completeness review surfaced `docs/replatform/WAVE-4-RESEQUENCE.md` — a **pre-existing terrain doc**
(from a 27-agent probe) that already sequenced the live-worker-dispatch chain the E7-1 cloud campaign needs.
Verified against it: the chain is **seven links**, and adapter-manager (the "provider transport", §3.7 —
"the architecture is DECIDED and MACHINE-ENFORCED; the service does not exist") is only one:

`identity → enrolment input → SESSION ACQUISITION → matchable hello → self-model read → loop composition → provider transport`

**Four links have NO OWNER** (WAVE-4-RESEQUENCE §3): container identity (3.1 — the hard gate on all later
links), POSIX enrolment input (3.2), session acquisition for an already-enrolled device (3.3, a *new* link
the campaign plan never named), and a matchable worker hello (3.4 — the only producer `buildDesktopHello`
is "deliberately unmatchable" and burns a one-shot snapshot). Self-model (3.5) is half-owned (WRK-008);
loop composition (3.6) partially (the start seam — `bootstrapWorkerDaemon` never calls `.run()`). Plus a
**tracking gap**: `program-design.md` cannot see several shipped tickets, so its dependency guard is blind
and every "no owner" claim needs re-deriving.

**WAVE-4-RESEQUENCE §5's own recommended order** (still the right sequence): **(0) fix the tracking** — add
the missing tickets + re-run the dependency guard + re-derive the no-owner claims (cheapest; everything
depends on it); **(1) the provider-topology decision + the adapter-manager contract** — *this scope +
§8 IS that step*; **(2) container identity; (3) session + POSIX input; (4) matchable hello; (5) self-model
client + start seam**; then the adapter-manager BUILD (Slices 1–5 above) + DEP-011's composition seam, then
C0 deploy, then the campaign.

**Honest consequence:** the E7-1 cloud campaign is **substantially further off than "build adapter-manager"**
— it is a multi-link, mostly-unowned programme WAVE-4-RESEQUENCE recommends sequencing deliberately with an
owner per link. **Building adapter-manager Slice 1 now would be building a link deep in a chain that is not
even tracked, whose consumer (a dispatching worker) does not yet exist** — the exact "wire against an
unimplemented peer for an unbuilt caller" failure DEP-011 was deferred to avoid. **So the honest first
step is WAVE-4-RESEQUENCE step 0 (fix the tracking + reconcile the chain), not an adapter-manager build.**
This scope stands as the step-1 provider-topology contract, ready for when the chain reaches it.
