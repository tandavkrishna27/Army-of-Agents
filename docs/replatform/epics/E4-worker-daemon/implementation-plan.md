# E4 — Worker Daemon (CORE: WRK-001..004) — Implementation Plan

**Plan status:** `draft` — not approvable until (a) the operator approves the read-back,
(b) the upstream control-plane tickets this epic consumes are `complete` at a recorded
reviewed revision — `JOB-002` for WRK-002 and `JOB-003` for WRK-003 — and (c) the four
shared decisions below (E4-D01..E4-D09) are ratified. This document covers only the four
CORE tickets (WRK-001, WRK-002, WRK-003, WRK-004). WRK-005, WRK-006, and WRK-007 depend on
`E6-D1-FOUNDATION` and are planned separately; nothing here may be treated as satisfying the
full E4 exit gate.

> **For agentic workers:** REQUIRED SUB-SKILL: use
> `superpowers:subagent-driven-development` to execute this plan ticket by ticket
> **only after operator approval**. Every ticket uses a fresh implementer subagent
> (strict RED → GREEN) and a DISTINCT independent reviewer subagent. A separate
> Integration Gate Owner, who implemented/reviewed no E4 ticket, owns the CORE checkpoint.
> No WRK ticket may be assigned until its upstream dependency's committed passing handoff
> exists. WRK-002 additionally waits for `JOB-002` `complete`; WRK-003 waits for `JOB-003`
> `complete`. The ticket-by-ticket subagent/reviewer protocol then applies unchanged.

**Goal:** Build the separately deployable worker daemon as a genuinely isolated leaf package
that (1) boots with strict config, structured logs, graceful shutdown, and a local-only
health/metrics surface and imports no server/database code; (2) generates a device-bound
Ed25519 identity, enrolls against the frozen worker protocol, and maintains short-lived
sessions with rotation/revocation; (3) long-polls for work, advertises measured
capacity/capabilities, ACKs promptly, and enforces bounded local concurrency; and (4)
supervises provider-neutral sandboxes with process-tree cancellation and a distinct,
monotonic cleanup authority — while never executing a tenant command inside the worker
process itself.

**Approved architecture:** The worker is a **frozen consumer** of E1
`@armyofagents/worker-protocol` v1 and a **network client** of the E3 control plane. It owns
no PostgreSQL schema, runs no Drizzle migration, mounts no Express route, and holds no
database credential. All wire shapes are the frozen v1 schemas; device possession travels in
versioned HTTP headers exactly as ratified for `JOB-002` (E3-F005). The worker can only
narrow eligibility: WorkerHello reports dynamic version/health/capacity/capabilities and
cannot assert trust, owner, provider, credential, locality, or fallback policy. Lease/fence
loss withdraws ordinary effect authority; a distinct cleanup authority may then cancel/kill/
destroy/reconcile matching provider resources but can never create, execute, resume, reveal
other resources, or open egress. The tenant command runs **inside the provider sandbox**, not
in the worker process. The whole daemon is dormant in every current deployment: it exists only
as the DEP-001 image and is exercised in CORE solely against in-process fakes (fake
control-plane server, fake sandbox provider).

**Tech stack:** TypeScript (ES2023 / NodeNext), Node ≥ 20.3, `@armyofagents/worker-protocol`
(the only workspace runtime dependency), `zod` (transitive via the protocol), `pino` for
structured logs, Node built-ins (`node:crypto`, `node:http`, `node:fs`, `node:timers`),
and Vitest. No `embedded-postgres` — the worker has no database, so CORE focused suites are
hermetic in-process component tests that run on this Windows host without a real database.

---

## 0. Planning record, freeze, dependency gates, and shared decisions

| Item | Recorded value |
|---|---|
| Frozen `origin/main` | `003492988269a91eadfadb352bff7f413fa61adb` — the crosswalk execution freeze; present locally and an ancestor of the current tip. |
| E4 Start SHA | `d24dd68a755f49019833112af1bc248e17f8a193` — `C:\e3` `codex/epic-e3-job-control` tip at planning time. WRK-001's `tickets/WRK-001-result.md` records this exact bare 40-hex value; later tickets use their actual assignment SHA. |
| E0 completion | `pass` — `docs/replatform/epics/E0-foundation/handoffs/2026-08-08-epic-completion-3a469b6bec68-a1.md`. FND-005 (rollout/config foundation) is `complete`. |
| E1 completion | `pass` at reviewed revision `01ad1ab554fe25c5178c7552ec047d4df45b7dcf`. PRT-001 (protocol scaffold) and PRT-003 (job envelope + provider-operation vocabulary) are `complete`; frozen v1 recorded source SHA is `b7a842870ce7509d8baa75409e0ab19da375c88a`. |
| JOB-002 (WRK-002 dependency) | E3 pre-D1, approved and assignable; **not yet `complete`.** WRK-002 consumes its as-built enrollment/session HTTP contract and may not be assigned until JOB-002's passing reviewer handoff exists at a recorded revision. |
| JOB-003 (WRK-003 dependency) | E3 pre-D1, `needs_changes` at planning time. WRK-003 consumes its as-built poll/lease/ACK HTTP contract and may not be assigned until JOB-003 is `complete` at a recorded revision. |
| `E6-D1-FOUNDATION` | **Not required for CORE.** WRK-001..004 are pre-D1-foundation; only WRK-005..007 and the full E4 exit gate require it. It is a named partial gate, never a ticket-result substitute. |
| Planning worktree | `C:\e3`, branch `codex/epic-e3-job-control` (E4 execution branches a fresh `codex/epic-e4-worker-daemon`); dependencies installed with `pnpm install --frozen-lockfile`. |
| Formal test authority | Linux CI under DEC-03. Windows short-path evidence is operator-directed local evidence and must be labeled `operator-directed windows-local`. |
| Planning baseline smoke | `pnpm build` passed at the Start SHA. `pnpm test:run` reaches the suite but exits on Windows with the already-recorded worker-protocol cross-version transform `ERR_IPC_CHANNEL_CLOSED` artifact; this is planning context only, never E4 gate evidence or a waiver. |

Planning findings are retained in [`findings.md`](findings.md) and locked decisions in
[`decisions.md`](decisions.md) (both created with the first executed ticket; result files are
created only when real execution exists). Finding IDs are `E4-F001…`; decision IDs are
`E4-D01…`. This plan does not override higher items in the `README.md` source-of-truth
hierarchy: locked product decisions, the approved re-platform architecture, the frozen
crosswalk, or accepted-caveats/test-gates all win until an explicit decision updates them.

### Sequence + gates (epic-level preamble)

```text
COMPLETE upstream (record reviewed SHA in each ticket result):
  E1 PRT-001 (protocol) ✔    E1 PRT-003 (envelope + provider vocab) ✔    E0 FND-005 ✔
  E3 JOB-002 (enroll/session) → gate WRK-002    E3 JOB-003 (poll/lease/ACK) → gate WRK-003

CORE build order (single worktree, serialized to avoid package/CI churn):

  WRK-001  ──▶  WRK-002  ──▶  WRK-003  ──▶  WRK-004
  (scaffold)    (identity)    (poll/ACK)    (supervisor + cleanup authority)
     │              │             │              │
     │              └─ needs JOB-002 complete    └─ needs PRT-003 (already frozen)
     └─ needs PRT-001 + FND-005 (already complete)
                    (WRK-003 needs JOB-003 complete)

  all four reviewer-completed ledgers ──▶ CORE integration checkpoint (independent owner)
                                          ──▶ enables WRK-005..007 planning against E6-D1-FOUNDATION
```

The CORE checkpoint is **not** the E4 exit gate. It proves: the worker builds and passes the
dependency-boundary check; it enrolls, refreshes sessions, and rotates against a fake
control-plane implementing the JOB-002 contract; it long-polls/ACKs against a fake
implementing the JOB-003 contract with bounded jittered backoff and drain-before-lease-stop;
and it supervises a fake provider with full cleanup-authority separation. Real distributed
D1 behavior (lease-loss partitions, encrypted outbox durability, restart reconciliation
against a live control plane) is WRK-005..007 + E6/D1 and is explicitly downstream.

### Shared decisions and locked contracts (E4-D01…E4-D09)

These are the epic-wide invariants every CORE ticket obeys. Behavior-changing edits after a
ticket begins require a `decisions.md` entry and a plan amendment reviewed by the Integration
Gate Owner.

- **E4-D01 — Isolated leaf package, zero server/db surface.** The worker lives at
  `packages/worker-daemon` (`@armyofagents/worker-daemon`, `"private": true`, ESM), auto-
  included by the `packages/*` workspace glob. Its **only** workspace runtime dependency is
  `@armyofagents/worker-protocol: workspace:*`; additional runtime deps are limited to `pino`
  and Node built-ins (`zod` arrives transitively through the protocol). It must NOT import
  `@armyofagents/db`, `@armyofagents/server`, `@armyofagents/shared`, `@armyofagents/adapters`,
  `drizzle-orm`, `pg`, or any Express/database module — statically enforced by
  `scripts/check-worker-daemon-boundary.mjs` (WRK-001), wired into the CI `policy` job beside
  the existing `check-worker-protocol-boundary.mjs` step. Any new runtime dependency is a STOP
  for controller approval.

- **E4-D02 — Frozen v1 protocol is consumed, never edited.** All wire shapes are the frozen
  E1 schemas (`transport.ts`, `job.ts`, `capabilities.ts`, `events.ts`, `errors.ts`,
  `policy.ts`, `artifacts.ts`, `canonical-json.ts`, `states.ts`, `ids.ts`, `version.ts`). The
  worker obeys `OPERATION_DESCRIPTORS` per-operation (`audience`, `idempotent`, `retry`,
  `maxRequestBytes`, `timeoutMs`, `successOutcomes`, `errors`). An unavoidable wire change is a
  STOP requiring the Protocol/Schema Custodian's approval plus D0-T04 evidence; it never
  happens inside E4.

- **E4-D03 — Device proof at the HTTP transport boundary (consume JOB-002 / E3-F005).** The
  worker generates a Node-native Ed25519 key, exports SPKI DER → base64url, and for every
  request computes `bodyDigest = sha256hex(rawBody)`, builds the canonical newline-joined tuple
  `["AOA-DEVICE-PROOF-V1", METHOD(upper), normalizedPath, bodyDigest, correlationId, issuedAt,
  proofId]`, signs it (`crypto.sign(null, canonical, key)`), and sends the versioned headers
  `aoa-device-proof-version:"1"`, `aoa-device-public-key`, `aoa-device-signature`,
  `aoa-device-issued-at` (ISO, ≤5 min skew), `aoa-device-proof-id` (`[A-Za-z0-9_-]{8,128}`),
  plus `aoa-enrollment-code` on enroll and `authorization: Bearer <session>` on poll/ACK. The
  request-body `correlationId` MUST equal the tuple's `correlationId`. The worker cannot import
  the server's `worker-device-proof.ts` (boundary), so it re-implements the canonicalizer and
  proves byte-parity against **shared canonical test vectors** — the same vectors JOB-002's
  server-side verifier consumes (E4-F001 pins the vector fixture).

- **E4-D04 — Header/constant vendoring with a parity contract test.** Because the
  `aoa-device-*` / `aoa-worker-session` / `aoa-enrollment-code` header names live in
  `@armyofagents/shared` (which the worker may not import), the worker vendors them in
  `src/transport/headers.ts` with a comment citing the JOB-002 contract, and a contract test
  asserts the exact lowercase strings. Any drift from the documented worker-control header set
  fails that test. The same rule applies to any other constant the worker must mirror rather
  than import.

- **E4-D05 — Session lifecycle consumes JOB-002's enrollment-replay session mint.** Sessions
  are 15-minute TTL, minted only by enroll; there is no separate session-renew audience in the
  CORE enroll/poll/ACK surface. Renewal = re-invoke enroll with a **fresh** device proof, the
  **retained** E1 `idempotencyKey`, and the **unchanged** semantic digest → the server replays
  the stored `enrolled` identity and returns a new proof-bound session for the same identity,
  without rotating or consuming twice. Rotation = a new Ed25519 key + new device generation.
  Revocation/replaced generation = uniform `unauthorized`/`target_revoked`. If JOB-002's
  as-built session lifecycle instead exposes a dedicated renew audience/route, WRK-002 adopts
  it and this decision is amended (E4-F002 tracks the confirmation-at-assignment STOP).

- **E4-D06 — Private key never leaves an OS-protected store; never logged or written to
  config.** WRK-002 defines a `DeviceKeyStore` interface with two CORE bindings: a
  container-mode `MountedSecretKeyStore` (reads/writes the key from a mounted path with strict
  permissions) and a desktop-mode `OsKeychainKeyStore` **interface** (CORE ships the interface
  plus an in-memory stub used only by tests; concrete OS-keychain bindings are DSK-001/002 in
  E10). A corrupt/unreadable key store fails closed (the worker refuses to enroll/poll and
  exits non-zero). No log line, metric label, health payload, or config echo may contain
  private-key bytes, the raw enrollment code, or the session token.

- **E4-D07 — Provider-neutral supervisor with a redacted, monotonic cleanup authority.** WRK-004
  defines the worker's own `SandboxProvider` driver interface (mirroring the shape of the
  server-side `SandboxRuntimeProvider` seam without importing it) over the frozen
  `PROVIDER_OPERATIONS` vocabulary: the 8 core ops `create, execute, cancel, kill, destroy,
  list, inspect, reconcile_cleanup` plus the 3 optional `checkpoint, restore, health`. Two
  distinct authority objects gate driver access: an `EffectAuthority` (full lifecycle, valid
  only while the lease/fence is active) and a `CleanupAuthority` (a monotonically increasing
  cleanup epoch bound to provider resource/ownership labels, target generation, job/attempt/
  lease/observed fence, and a deadline). Cleanup may only `list`/`inspect` through a
  management-only projection (redacted: never command, env, logs, secrets, workspace/customer
  bytes, or object grants) or `cancel`/`kill`/`destroy`/`reconcile_cleanup`; it can never
  `create`/`execute`/`resume`/`checkpoint`, reveal other resources, or open egress. Provider
  ops carry deadlines + stable idempotency keys; unsupported optional ops fail **explicitly**
  (never guessed). Sandbox identity + provider op IDs attach to every log line and cleanup
  record. `destroy`/cleanup return a **status** (`success | failed`), never throw — a failed
  cleanup is a durable-retryable outcome, mirroring `SandboxProviderReleaseResult`.

- **E4-D08 — Tenant commands execute inside the sandbox, never in the worker process.** The
  worker process never spawns a tenant command locally: `execute` dispatches the command into
  the provider sandbox and streams stdout/stderr/exit through the driver. This is the H-05
  sandbox-boundary invariant for E4 and is asserted by a dedicated no-local-spawn test.

- **E4-D09 — No worker-owned database, schema, or migration.** The worker persists nothing to
  PostgreSQL and generates no Drizzle migration. The only worker-local persistence in the whole
  epic is the encrypted SQLite event outbox, which is **WRK-006** (post-D1) and out of CORE
  scope. CORE tickets therefore have **no** `packages/db` files, no `drizzle-kit generate`
  step, and no `Invoke-E3Integration`/`AOA_RUN_WIN_INTEGRATION` embedded-PG lane.

### NOT in scope (epic-CORE non-goals)

- No E1 v1 redesign; no additive protocol field (that is a custodian STOP + D0-T04 corpus).
- No lease renewal / local fence-close proxy (WRK-005), no encrypted SQLite outbox (WRK-006),
  and no restart/orphan reconciliation against a live control plane (WRK-007). CORE supervises
  and reconciles only against the in-process fake provider.
- No real sandbox provider (E2B/gVisor), no object-byte upload, no secret materialization, no
  egress proxy, no DNS/network policy enforcement — E5/DAT and E6 own those.
- No image build. WRK-001 scaffolds the container entrypoint; **DEP-001** builds the distinct
  signed worker image and owns its Dockerfile/SBOM/provenance.
- No wiring of the worker into any running deployment; no flip of
  `AOA_DISTRIBUTED_EXECUTION_ENABLED` (that gate is server-side and owned by E3/E10).
- No desktop OS-keychain implementation, mobility, or realtime durability claim.

---

## 1. Consumed as-built interfaces / what already exists and is reused

### Frozen E1 protocol — consume, do not edit (`@armyofagents/worker-protocol`)

| Interface | E4 use |
|---|---|
| `transport.ts` — `WORKER_PROTOCOL_OPERATIONS`, `OPERATION_DESCRIPTORS`, `AUTH_AUDIENCES`, request/response envelopes | Build enroll/poll/lease_ack request envelopes (`protocolVersion:1`, `correlationId`, `issuedAt`, `nonce`, bound `audience`, `idempotencyKey` on mutations); obey each op's `maxRequestBytes`/`timeoutMs`/`retry`/`successOutcomes`. |
| `transport.ts` — `enrollmentRequestV1Schema` / `enrollmentResponseV1Schema` | Serialize the enroll request (audience `target_enrollment`, nests `workerHelloV1Schema`); parse `enrolled`(`workerId,targetId,deviceGeneration,providerConstraints`) vs `rejected`. |
| `transport.ts` — `pollRequestV1Schema` / `pollResponseV1Schema` (`POLL_RESPONSE_OUTCOMES`) | Serialize poll (audience `worker_poll`, carries `capacity`); parse `offer`(nests `leaseOfferV1Schema`) / `no_work`(`retryAfterMs`) / `drain`. |
| `transport.ts` — `leaseAckOperationRequestV1Schema` / response | Serialize lease ACK (audience `worker_run`, body `leaseAckV1Schema`); parse `acknowledged`(`leaseId,expiresAt`) / `rejected`. |
| `transport.ts` — `controlCommandV1Schema`, `controlCommandAckV1Schema`, `decideControlReceiverV1` (`CONTROL_RECEIVER_DECISIONS`) | WRK-004 classifies inbound control (`cancel`/`graceful_stop`/`drain`/…) with the pure receiver decision and ACKs (`accepted`/`completed`/`rejected`/`stale`). CORE handles the cancel/graceful-stop kinds; the transport wiring of the control channel is exercised via the fake. |
| `capabilities.ts` — `workerHelloV1Schema`, `workerCapacitySchema`, `workerPlatformSchema`, `KNOWN_WORKER_CAPABILITIES` | Build the enroll hello and poll capacity. `.strict()` forbids self-asserting trust/owner/provider/credential/locality — the worker only narrows. |
| `capabilities.ts` — `PROVIDER_OPERATIONS`, `CORE_PROVIDER_OPERATIONS`, `OPTIONAL_PROVIDER_OPERATIONS`, `CHECKPOINT_MODES`, `HEALTH_MODES` | The exact op vocabulary WRK-004's `SandboxProvider` interface implements; optional ops are gated on advertisement. |
| `capabilities.ts` — `providerConstraintProfileV1Schema`, `verifyAndBrandProviderConstraintProfileV1`, `workerSatisfiesRequirements` | WRK-003 validates an offered job's `requiredCapabilities` against the branded server profile ∩ worker report as defense-in-depth before ACK; SHA-256 is injected from `node:crypto`. |
| `job.ts` — `jobEnvelopeV1Schema` (union on `workloadType`), `leaseOfferV1Schema`, `leaseAckV1Schema`, `leaseRenewRequestV1Schema`/response, `fenceTokenSchema` | Parse the offered immutable job + lease/fence; carry `workerId/leaseId/fenceToken/jobId/attempt` verbatim on every follow-up. WRK-004 binds the supervisor + cleanup authority to `fenceToken`, `deviceGeneration`, and `jobId/attempt/leaseId`. |
| `events.ts` — `workerEventV1Schema`, `workerEventBatchV1Schema`, `workerEventAckV1Schema`, `terminalEventPayloadV1Schema` | WRK-004 produces sequenced events (contiguous `seq`, per-event `eventDigest`) into an **injected event sink**; durable outbox + `event_upload` wiring is WRK-006 (not CORE). |
| `canonical-json.ts` — `canonicalizeJsonV1`, `canonicalEventDigestInputV1`, `verifyWorkerEventDigestV1` | Compute `eventDigest` bytes with the single RFC-8785-subset canonicalizer; SHA-256 injected from `node:crypto`. |
| `errors.ts` — `PROTOCOL_ERROR_CODES`, `RETRYABLE_PROTOCOL_ERROR_CODES`, `protocolErrorV1Schema` | Classify control-plane rejections; `throttled`/`internal_unavailable` are retryable (bounded jittered backoff), the rest are terminal for the request. |
| `policy.ts`, `artifacts.ts`, `source.ts`, `wire-safety.ts` | Read `resourceLimits`/`networkPolicy`/`offlinePolicy`/`secretHandles` off the job (opaque handles only — never resolved in CORE); honor `FORBIDDEN_WIRE_KEYS`. |
| `version.ts` — `PROTOCOL_VERSION`, `negotiateProtocolVersion` | Populate `supportedProtocol:{min,max}` in the hello and negotiate at enroll. |

### E3 control-plane HTTP surface — network client, do not import

| Endpoint (consumed) | Contract source | E4 use |
|---|---|---|
| `POST /api/worker-control/enroll` | `server/src/routes/worker-control.ts` + `worker-enrollment.ts` (JOB-002) | Enroll/rotate; send `aoa-enrollment-code` + device-proof headers; read the `aoa-worker-session` response header. |
| `POST /api/worker-control/poll` | `worker-control.ts` + `job-leasing.ts` (JOB-003) | Long-poll with `authorization: Bearer <session>` + device proof; receive `offer`/`no_work`/`drain`. |
| `POST /api/worker-control/leases/:leaseId/ack` | `worker-control.ts` + `job-leasing.ts` (JOB-003) | ACK a lease; the body `leaseId` must equal the URL param. |
| Device-proof + session model | `worker-device-proof.ts`, `middleware/worker-session-auth.ts`, `worker-operation-proof.ts`, `worker-proof-headers.ts` | Reproduced client-side per E4-D03/E4-D05: canonical signing string, 5-min skew, fresh `proofId` per request, 15-min session TTL, opaque bearer token. |

The worker consumes these **by URL + wire schema only**. It never links server code. In CORE
every endpoint is a fake in-process HTTP server that replays the documented contract, so the
suites are hermetic and Windows-runnable; a live-server integration is a WRK-005+/E6 concern.

### E0/E1 exemplars mirrored (patterns, not imports)

| Exemplar | File | What the worker reimplements |
|---|---|---|
| Strict env parse that throws | `server/src/config/distributed-execution.ts` (`parseBooleanEnv`, `assertHostedExecutionStartupSafe`) | WRK-001 strict config parse + "exit on invalid endpoint/trust configuration". |
| Enum-narrowing config load | `server/src/config.ts` (`loadConfig`) | WRK-001 endpoint/mode/scope validation. |
| Structured pino logger | `server/src/middleware/logger.ts` | WRK-001 minimal pino logger (`logger.info({bindings}, msg)`), reimplemented (no server import). |
| Idempotent one-shot shutdown | `server/src/services/server-shutdown.ts` (`createProcessShutdownHandler`) wired at `server/src/index.ts:1743` | WRK-001 graceful shutdown; ordered stop, always `exit(0)` on step failure, `process.once("SIGINT"/"SIGTERM")`. |
| Stop-leasing-before-draining | E3 durable runtime `server/src/index.ts:609` (bounded 5s race) | WRK-003 "shutdown stops leasing before draining work". |
| Payload-free metrics surface | `server/src/services/job-control-metrics.ts` (`createPinoJobControlMetrics`) | WRK-001/003 bounded-label metrics (no tenant/secret content). |
| Provider-neutral runtime seam | `server/src/services/sandbox-provider-runtime.ts` (`SandboxRuntimeProvider`, fake/e2b/gvisor; release returns `cleanupStatus`) | WRK-004 driver interface shape + fake double + "cleanup returns status, never throws". |
| Boundary checker | `scripts/check-worker-protocol-boundary.mjs` + `scripts/lib/worker-protocol-boundary.mjs` (`evaluateManifest`, `evaluateRuntimeSourceImports`, `findForbiddenGlobals`) | WRK-001 `check-worker-daemon-boundary.mjs` + lib, wired into the CI `policy` job. |
| Container entrypoint | `Dockerfile`, `scripts/docker-entrypoint.sh` | WRK-001 `scripts/worker-daemon-entrypoint.sh` (image itself is DEP-001). |
| Leaf-package template | `packages/worker-protocol/{package.json,tsconfig.json,vitest.config.ts}` | WRK-001 package scaffold (deps = protocol + pino; `bin` field for the entrypoint). |

---

## 2. Worker-daemon shape and runtime rules

### Source of truth and direction of authority

| Fact | Authority | Worker rule |
|---|---|---|
| Job/attempt/lease/fence/placement | PostgreSQL control-plane tables (E2/E3) | The worker holds no authority; a lease + fence is a **grant** it can lose at any time. It never persists a durable claim of its own beyond the CORE in-memory supervisor state (durable outbox is WRK-006). |
| Registered target profile / provider constraints | Server `execution_targets` + branded `providerConstraintProfileV1` | The worker's hello can only **narrow** eligibility; it never widens trust/provider/locality. |
| Capacity / capability report | Worker (dynamic) | Measured at poll time; advertised, never authoritative. A false privileged advertisement is a server-side placement rejection, and WRK-003 additionally self-checks offers via `workerSatisfiesRequirements`. |
| Device identity + generation | Server-owned generation on the registered target; worker holds the private key | Rotation/revocation increments generation server-side; the worker follows (re-enroll/back off), never resurrects an old generation. |
| Event acceptance | Server, after digest/identity/fence/sequence/state checks | Worker events are observations until cumulatively ACKed. |
| Sandbox provider resource | The provider, labeled by ownership | The worker create/execute under effect authority and cleanup/reconcile under cleanup authority; a failed cleanup is durable-retryable, not an exception. |

### Package layout (WRK-001 creates the package; later tickets add modules)

```text
packages/worker-daemon/
  package.json          # @armyofagents/worker-daemon, private, ESM, bin, deps: worker-protocol + pino
  tsconfig.json         # extends ../../tsconfig.json; outDir dist, rootDir src, declaration
  vitest.config.ts      # { test: { environment: "node", name: "packages/worker-daemon" } }
  src/
    index.ts            # public barrel (composition root exports)
    bin/worker-daemon.ts# container/desktop entrypoint (bin target)
    config/config.ts    # strict parse + WorkerConfig type; throws on invalid endpoint/trust
    config/env.ts        # parseBooleanEnv/parseEnumEnv helpers (reimplemented, throwing)
    logging/logger.ts   # minimal pino logger; bounded bindings; redaction guard
    lifecycle/shutdown.ts# idempotent one-shot ordered shutdown; SIGINT/SIGTERM
    health/health-server.ts # local-only http health + payload-free metrics
    metrics/metrics.ts  # bounded-label counters (poll outcomes, active leases, cleanup outcomes)
    transport/headers.ts# vendored aoa-* header names (+ parity contract test)
    transport/envelope.ts# request-envelope builders per OPERATION_DESCRIPTORS
    transport/client.ts # enroll/poll/ack HTTP client; timeouts, size ceilings, error mapping
    identity/device-key.ts    # Ed25519 keygen + SPKI DER export
    identity/device-proof.ts  # canonical signing string + signer (E4-D03)
    identity/key-store.ts     # DeviceKeyStore iface + MountedSecretKeyStore + OsKeychainKeyStore iface/stub
    identity/session.ts       # session store + refresh scheduler (E4-D05)
    enrollment/enroll.ts      # enroll/rotate flow; hello assembly
    poll/poll-loop.ts   # long-poll loop; drain-before-stop
    poll/backoff.ts     # bounded jittered backoff honoring retryAfterMs
    poll/capacity.ts    # measured free cpu/mem/disk + slot accounting
    poll/concurrency.ts # local concurrency limiter
    supervisor/provider.ts        # SandboxProvider driver interface + op result types
    supervisor/fake-provider.ts   # in-memory deterministic test double
    supervisor/effect-authority.ts# active-lease/fence-gated lifecycle authority
    supervisor/cleanup-authority.ts# monotonic redacted destructive-only authority (E4-D07)
    supervisor/supervisor.ts      # orchestrates create/execute/cancel/kill/destroy; process-tree cancel
    supervisor/reconcile.ts       # idempotent leaked-resource reconciliation
    supervisor/events.ts          # sequenced event production + eventDigest (canonicalizeJsonV1 + node:crypto)
  src/__tests__/…       # hermetic vitest component/unit suites
```

Repo-root additions: `scripts/check-worker-daemon-boundary.mjs`,
`scripts/check-worker-daemon-boundary.test.mjs`, `scripts/lib/worker-daemon-boundary.mjs`,
root `package.json` script `check:worker-daemon-boundary`, a new CI `policy`-job step, and
`scripts/worker-daemon-entrypoint.sh` (image assembly is DEP-001).

### Config, health, and shutdown contract

- **Strict config (WRK-001).** `config/config.ts` parses env into a frozen `WorkerConfig`:
  control-plane base URL (must be a valid absolute `http(s)` origin), enrollment code source
  (path or env — never inline-logged), device-key-store mode (`mounted_secret | os_keychain`),
  target scope (`platform | organization | owner`), local concurrency limits, poll timeout,
  backoff bounds, health/metrics bind address (loopback only). Any invalid endpoint,
  unparseable boolean/enum, or non-loopback health host **throws before any I/O**,
  and the entrypoint exits non-zero. (Per **E4-D10** custody and scope are
  orthogonal — there is no config-load trust/scope coupling to enforce.)
  It **never reads a database URL**; a present
  `*_DATABASE_URL` env is ignored (and a test asserts it is neither required nor used).
- **Local health/metrics only (WRK-001).** `health/health-server.ts` binds a tiny HTTP server
  to loopback, exposing `GET /healthz` (liveness) and `GET /metrics` (payload-free bounded
  counters). It exposes no tenant data and no remote-reachable interface; binding a non-loopback
  address is rejected.
- **Graceful shutdown (WRK-001).** `lifecycle/shutdown.ts` returns an idempotent one-shot
  handler (`inFlight` guard) wired via `process.once("SIGINT"/"SIGTERM")`. It stops subsystems
  in order — stop leasing → drain in-flight (bounded) → stop health server → flush logs — and
  always exits, even if a step fails. Timers use `.unref()`.

### Metrics / logging redaction

Stable metrics use bounded labels only: `operation`, `outcome`/`reason` (closed
`PROTOCOL_ERROR_CODES` + local reasons), `workload`, `provider`, and a cleanup
`escalation_stage`. Never `organizationId`, `companyId`, `jobId`, event content, secret,
private-key, or session bytes. Structured logs may carry opaque IDs (`workerId`, `targetId`,
`deviceGeneration`, `correlationId`, `leaseId`, `sandboxId`, provider op IDs) under a
redaction guard that drops any field matching the key/token/secret canary set.

### No migrations, no routes

Per E4-D09 there is **no** `packages/db` change, **no** `drizzle-kit generate`, and **no**
Express route composition anywhere in CORE. The E3 migration recipe and
`Invoke-E3Integration` embedded-PG lane do **not** apply. The only repo-root wiring is the
boundary check + CI step + entrypoint script.

---

## 3. TDD, evidence, and commit protocol for every ticket

1. The controller creates `tickets/WRK-00X-result.md` with the exact bare 40-hex Start SHA
   (`Status` and `Disposition` backtick-wrapped), named implementer/reviewer, acceptance
   checklist, and command ledger. WRK-001 uses the E4 Start SHA above; later tickets use their
   actual assignment SHA (and record the consumed upstream JOB-002/JOB-003 reviewed SHA).
2. A fresh implementer writes focused tests first and commits/records a genuine RED on
   unchanged behavior. The controller rejects false REDs caused by imports, build order, or
   environment setup.
3. The implementer makes the smallest GREEN change, runs the focused acceptance suite plus the
   worker-daemon typecheck/build (and the boundary check on WRK-001), updates `findings.md` for
   non-obvious discoveries, and commits.
4. A DISTINCT reviewer checks the reviewed 40-hex revision (an ancestor of HEAD), reruns the
   focused command on that revision, appends review attempt 1 with plain `git commit`, and is
   the only one who changes ticket `Status` to `complete`.
5. Any H-04/H-05/H-08 failure is a non-waivable `fail`; stop downstream assignment. A
   dependency, protocol, canonical-scope, or frozen-main contradiction is a STOP and plan
   amendment, never an improvised implementation.

Tests are hermetic: fake clock, deterministic UUID/digest/key fixtures, in-process fake
control-plane HTTP server, in-memory fake sandbox provider, no live provider/network/customer
data/credential. Every focused result records command, exit code, test count, duration,
platform, and exact revision. Because the worker owns no database, CORE suites need **no**
`embedded-postgres` and run directly on this Windows host; there is no `AOA_RUN_WIN_INTEGRATION`
gate.

```powershell
function Invoke-NativeGate([string]$Label, [scriptblock]$Command) {
  $priorErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Stop'
  try {
    $global:LASTEXITCODE = 0
    & $Command
    $invocationSucceeded = $?
    $code = $global:LASTEXITCODE
  }
  catch { throw "$Label failed before a valid native exit: $($_.Exception.Message)" }
  finally { $ErrorActionPreference = $priorErrorAction }
  if (-not $invocationSucceeded -or $code -ne 0) {
    throw "$Label failed with native exit $code"
  }
}

# The worker-protocol dependency must be built before the worker typechecks/tests.
Invoke-NativeGate 'protocol build' { pnpm --filter @armyofagents/worker-protocol build }
Invoke-NativeGate 'worker typecheck' { pnpm --filter @armyofagents/worker-daemon typecheck }
Invoke-NativeGate 'worker build'     { pnpm --filter @armyofagents/worker-daemon build }
```

Every ledger runs each native process through `Invoke-NativeGate`; cleanup lives only in
`finally`. A later successful PowerShell cmdlet may never mask a failed test. RED and GREEN use
the identical helper invocation and record the failing/passing native exit code.

Focused commands (implementer records the expected assertion failure first, then reruns the
identical command GREEN; append the protocol build + worker typecheck/build above):

| Ticket | Exact focused command from `C:\e3` |
|---|---|
| WRK-001 | `Invoke-NativeGate 'WRK-001 boundary' { pnpm check:worker-daemon-boundary }; Invoke-NativeGate 'WRK-001 boundary self-test' { node --test scripts/check-worker-daemon-boundary.test.mjs }; Invoke-NativeGate 'WRK-001 worker' { pnpm --filter @armyofagents/worker-daemon exec vitest run src/__tests__/config.test.ts src/__tests__/config-matrix.test.ts src/__tests__/logger-redaction.test.ts src/__tests__/shutdown.test.ts src/__tests__/health-server.test.ts src/__tests__/entrypoint-signals.test.ts src/__tests__/dependency-boundary.test.ts }; Invoke-NativeGate 'WRK-001 frozen consumer' { pnpm check:frozen-worker-protocol-v1 -- --source-sha b7a842870ce7509d8baa75409e0ab19da375c88a }` |
| WRK-002 | `Invoke-NativeGate 'WRK-002 worker' { pnpm --filter @armyofagents/worker-daemon exec vitest run src/__tests__/transport-headers.contract.test.ts src/__tests__/device-key.test.ts src/__tests__/device-proof-vectors.test.ts src/__tests__/key-store.test.ts src/__tests__/key-store-corrupt.test.ts src/__tests__/enrollment.component.test.ts src/__tests__/session-renewal.test.ts src/__tests__/session-revocation.test.ts }` |
| WRK-003 | `Invoke-NativeGate 'WRK-003 worker' { pnpm --filter @armyofagents/worker-daemon exec vitest run src/__tests__/capacity.test.ts src/__tests__/backoff.test.ts src/__tests__/concurrency.test.ts src/__tests__/poll-empty.component.test.ts src/__tests__/poll-offer-ack.component.test.ts src/__tests__/poll-incompatible.test.ts src/__tests__/poll-backpressure.test.ts src/__tests__/poll-outage.component.test.ts src/__tests__/poll-drain.component.test.ts } ` |
| WRK-004 | `Invoke-NativeGate 'WRK-004 worker' { pnpm --filter @armyofagents/worker-daemon exec vitest run src/__tests__/provider-contract.test.ts src/__tests__/supervisor-happy.component.test.ts src/__tests__/capability-negotiation.test.ts src/__tests__/optional-ops-unsupported.test.ts src/__tests__/supervisor-hung-create.test.ts src/__tests__/supervisor-cancel-escalation.test.ts src/__tests__/cleanup-authority-denial.test.ts src/__tests__/cleanup-cross-resource-denial.test.ts src/__tests__/cleanup-redaction.test.ts src/__tests__/provider-idempotency-replay.test.ts src/__tests__/list-inspect-pagination.test.ts src/__tests__/cleanup-idempotent.test.ts src/__tests__/cleanup-expiry-escalation.test.ts src/__tests__/destroy-failure.test.ts src/__tests__/checkpoint-restore-health.test.ts src/__tests__/reconcile-leaked.test.ts src/__tests__/no-local-tenant-spawn.test.ts src/__tests__/supervisor-shutdown.test.ts }` |
| WRK-005 | `Invoke-NativeGate 'WRK-005 worker' { pnpm --filter @armyofagents/worker-daemon exec vitest run src/__tests__/lease-renewal-schedule.test.ts src/__tests__/lease-renewal-happy.component.test.ts src/__tests__/lease-renewal-cancel-requested.test.ts src/__tests__/lease-renewal-rejected.test.ts src/__tests__/lease-renewal-deadline-lapse.test.ts src/__tests__/lease-renewal-401-recovery.test.ts src/__tests__/lease-renewal-idempotent-replay.test.ts src/__tests__/lease-renewal-clock-bounds.test.ts src/__tests__/lease-renewal-shutdown.test.ts src/__tests__/fence-close-proxy-permit.test.ts src/__tests__/fence-close-proxy-deny.test.ts src/__tests__/fence-close-idempotent-terminal.test.ts src/__tests__/governed-egress-denied-emits-event.test.ts src/__tests__/quarantine-routing-decision.test.ts src/__tests__/quarantine-grant-finalize.component.test.ts src/__tests__/quarantine-requires-device-session.test.ts }` |

---

## 4. Ticket implementation tasks

### WRK-001 — Scaffold the separately deployable worker (S, ≤3 agent-days, PRE-D1)

**Depends on:** PRT-001, FND-005 — both `complete`.
**Outcome:** A new `@armyofagents/worker-daemon` leaf package with a container/desktop
entrypoint, strict config parsing, structured logs, an idempotent graceful shutdown, and a
loopback-only health/metrics surface — importing no server/database/shared/drizzle code, proven
by a dependency-boundary checker wired into CI.

**Ticket non-goals:** enrollment, device identity, polling, sandbox supervision, the DEP-001
image build, and any database/route/migration.

**Files:**
- Create `packages/worker-daemon/package.json`, `tsconfig.json`, `vitest.config.ts`.
- Create `packages/worker-daemon/src/index.ts`, `src/bin/worker-daemon.ts`,
  `src/config/config.ts`, `src/config/env.ts`, `src/logging/logger.ts`,
  `src/lifecycle/shutdown.ts`, `src/health/health-server.ts`, `src/metrics/metrics.ts`.
- Create `scripts/check-worker-daemon-boundary.mjs`,
  `scripts/check-worker-daemon-boundary.test.mjs`, `scripts/lib/worker-daemon-boundary.mjs`;
  add root `package.json` script `check:worker-daemon-boundary`; add a `policy`-job step to
  `.github/workflows/pr.yml` beside the existing worker-protocol boundary step.
- Create `scripts/worker-daemon-entrypoint.sh` (referenced by DEP-001 later).
- Modify `packages/worker-daemon/package.json` and the regenerated `pnpm-lock.yaml` together to
  declare `@armyofagents/worker-protocol: workspace:*` and `pino`.
- Create tests `src/__tests__/config.test.ts`, `config-matrix.test.ts`,
  `logger-redaction.test.ts`, `shutdown.test.ts`, `health-server.test.ts`,
  `entrypoint-signals.test.ts`, `dependency-boundary.test.ts`.

**Inputs/outputs:** `loadWorkerConfig(env): WorkerConfig` — a pure, throwing parser producing a
frozen config `{controlPlaneBaseUrl, enrollmentCodeSource, keyStoreMode, targetScope,
concurrency:{batch,browser,service}, pollTimeoutMs, backoff:{baseMs,maxMs,jitter}, health:{host
(loopback-checked),port}}`. `createWorkerLogger(opts): Logger` (minimal pino, redaction guard).
`createShutdownHandler(subsystems): () => Promise<void>` (idempotent one-shot). `startHealthServer
(config, metrics): {close()}`. The entrypoint composes config → logger → health → shutdown and
blocks; it dispatches no work in CORE (poll loop lands in WRK-003).

**Failure behavior:** invalid/absent control-plane URL, unparseable boolean/enum, non-loopback
health host, or an inconsistent trust/scope combination throws in `loadWorkerConfig` and the
entrypoint exits non-zero **before** opening the health server or any socket. A present
`*_DATABASE_URL` is neither required nor read. The boundary checker exits non-zero (failing CI
`policy`) if any runtime source imports a forbidden module or the manifest declares a forbidden
dependency. No secret/endpoint credential is ever logged.

**Compatibility / rollback:** purely additive — a brand-new package, root script, one CI step,
and one entrypoint script. Nothing is wired into a running deployment; the worker is dormant
until DEP-001 builds its image and E10 deploys it. Rollback = do not build/run the package.
Declaring the frozen-protocol dependency is validated by `check:frozen-worker-protocol-v1`
against E1's recorded source SHA (the E1 checker was corrected to compare recorded source-SHA
Git blobs, not the mutable lockfile), and by proving `pnpm install --frozen-lockfile` no-ops
after regeneration.

**Observable signals:** startup log with `{workerVersion, protocolMin, protocolMax,
keyStoreMode, targetScope}` (no secrets); `GET /healthz` liveness; `GET /metrics` payload-free
counters (`worker_up`, `config_load_failures_total` is impossible-by-construction but the
process exit code carries the failure); shutdown log with ordered-step outcomes.

**RED → GREEN:**
- RED `config.test.ts` / `config-matrix.test.ts`: a matrix of valid + invalid endpoints,
  booleans, enums, trust/scope combinations, and a set `DATABASE_URL` that must be ignored;
  invalid rows must throw with a bounded reason and no secret echo.
- RED `logger-redaction.test.ts`: a log call carrying a fake private key / session token / raw
  code must have those fields dropped.
- RED `shutdown.test.ts`: two concurrent signals run the ordered steps exactly once; a failing
  step still reaches process exit.
- RED `health-server.test.ts`: binds loopback only; a non-loopback host is rejected; `/metrics`
  emits no tenant/secret content.
- RED `entrypoint-signals.test.ts`: SIGINT/SIGTERM invoke the one-shot handler.
- RED `dependency-boundary.test.ts` + `check-worker-daemon-boundary.test.mjs`: a fixture source
  importing `@armyofagents/db`/`@armyofagents/server`/`drizzle-orm` is rejected; the real
  package sources pass.
- GREEN: scaffold the package + modules; add the boundary checker/lib/CI step; regenerate the
  lockfile; run the focused command and the protocol build + worker typecheck/build.

**Evidence / commit:** `tickets/WRK-001-result.md`; one scaffold commit
`feat(worker-daemon): scaffold isolated worker package`. Maps D0-T01/T05, H-05, H-07.

**Internal TDD/commit slices (one ticket, one final reviewer):** A—package scaffold + config +
logger; B—shutdown + loopback health/metrics + entrypoint; C—boundary checker/lib + CI step +
frozen-consumer proof. Each slice is independently green and ≤1 agent-day; the reviewer reviews
the combined revision and alone completes WRK-001.

### WRK-002 — Device identity and session renewal (M, ≤3 agent-days, PRE-D1)

**Depends on:** WRK-001; **JOB-002 must be `complete`** at a recorded reviewed revision (its
as-built enroll/session HTTP contract is the interface consumed here).
**Outcome:** Generate/store a device-bound Ed25519 key, enroll against the frozen
`target_enrollment` operation with a transport-boundary device proof, recover a lost enroll
response via replay within the code-route window, and handle rotation/revocation/terminal-401 —
with the private key never entering logs or config. **(Amended per E4-D11: replay is
lost-response recovery, NOT sustained session renewal; sustained renewal past the 10-min
code-route window is unsupported by the as-built JOB-002 server and is escalated as E4-F007.)**

**Ticket non-goals:** polling/leasing/execution, sandbox supervision, recovering a lost private
key, real OS-keychain bindings (DSK-001/002), and changing registered trust via worker report.

**Files:** create `packages/worker-daemon/src/transport/headers.ts`,
`transport/envelope.ts`, `transport/client.ts`, `identity/device-key.ts`,
`identity/device-proof.ts`, `identity/key-store.ts`, `identity/session.ts`,
`enrollment/enroll.ts`; create the shared fixture
`src/__tests__/fixtures/device-proof-vectors.json`; tests
`src/__tests__/transport-headers.contract.test.ts`, `device-key.test.ts`,
`device-proof-vectors.test.ts`, `key-store.test.ts`, `key-store-corrupt.test.ts`,
`enrollment.component.test.ts`, `session-renewal.test.ts`, `session-revocation.test.ts`; create
a fake control-plane server helper `src/__tests__/support/fake-control-plane.ts`.

**Blocking contract decision (E4-D03/E4-D05, consumes E3-F005):** JOB-002 puts device
possession at the HTTP transport boundary — frozen E1 enrollment JSON carries no key/proof/
session field. The worker reproduces the canonical signing tuple
`["AOA-DEVICE-PROOF-V1", METHOD, normalizedPath, sha256hex(rawBody), correlationId, issuedAt,
proofId]`, signs with Ed25519, and sends `aoa-device-*` headers + `aoa-enrollment-code`. Because
the worker cannot import the server signer, **byte-parity is enforced by a shared vector
fixture** — the exact vectors JOB-002's server-side `worker-device-proof.ts` verifies. If
JOB-002's as-built session lifecycle diverges from E4-D05 (e.g., exposes a dedicated renew
audience/route), that is a STOP: amend E4-D05 and this ticket before assignment (E4-F002).

**Interfaces:** `generateDeviceKey(): DeviceKey` (Ed25519, SPKI DER base64url public).
`signDeviceProof({method, path, rawBody, correlationId, issuedAt, proofId, key}): {signature,
headers}` — the canonicalizer + signer. `DeviceKeyStore` interface `{load(): DeviceKey|null,
save(k), clear()}` with `MountedSecretKeyStore(path, perms)` and the `OsKeychainKeyStore`
interface (+ in-memory stub for tests). `enroll({config, keyStore, hello, code}): EnrollResult`
— assembles `workerHelloV1Schema` (dynamic version/protocol/platform/capabilities/capacity/
policyHash only), posts `enrollmentRequestV1Schema`, verifies `enrolled`/`rejected`, stores the
`aoa-worker-session` header, and returns `{workerId, targetId, deviceGeneration,
providerConstraints, session}`. `SessionStore` holds the session and uses the
replay path (fresh proof + retained `idempotencyKey` + unchanged digest) for **lost-response
recovery within the code-route window**; it does NOT schedule sustained periodic renewal (the
as-built server rejects replays past the 10-min code route — E4-D11/E4-F007). It rotates on key
change and, on any enroll-path 401, stops and signals `reenrollment_required`. The client obeys
`OPERATION_DESCRIPTORS.enrollment` (audience `target_enrollment`, 256 KiB, 15s, `idempotent`).

**Failure behavior:** reused proof ID/signature, expired code/session, key mismatch, replaced
generation, or revocation returns the closed `unauthorized`/`target_revoked` protocol error;
the worker treats these as terminal-for-request and (for revocation/expired generation) stops
and backs off rather than retrying with the old identity. A lost-response retry with the same
code + retained `idempotencyKey` + unchanged digest + a **fresh** proof replays the stored
`enrolled` identity and returns a new session without double-consuming; a changed digest is
generic `malformed`. A corrupt/unreadable key store fails closed (refuse to enroll, exit
non-zero). No log/metric/config carries private-key, raw-code, or session bytes.

**Compatibility / rollback:** additive worker-only modules; no server/db/migration change.
Rollback = do not run WRK-002 code paths. A revoked generation is never re-enabled by the
worker.

**Observable signals:** enroll/rotate/refresh/revoke logs carrying opaque
`{workerId, targetId, deviceGeneration, correlationId, proofId}` only; metrics
`enroll_outcome{outcome}`, `session_refresh_total`, `session_revoked_total`; a
`device_key_load_failed` process-exit path.

**RED → GREEN:**
- RED `transport-headers.contract.test.ts`: the vendored header names equal the documented
  lowercase `aoa-*` worker-control set exactly.
- RED `device-proof-vectors.test.ts`: the worker's canonicalizer + signer reproduce every
  fixture vector's canonical string and signature byte-for-byte (the JOB-002 cross-checked
  vectors).
- RED `device-key.test.ts` / `key-store.test.ts` / `key-store-corrupt.test.ts`: keygen exports
  valid SPKI DER; mounted-secret store round-trips with strict perms; a corrupt store fails
  closed; the private key never appears in any serialized output.
- RED `enrollment.component.test.ts`: against the fake control-plane, a valid enroll yields a
  session; a consumed code with an unrelated key, an invalid/missing signature, a tampered
  body/path/method, a copied session without the key, and a wrong audience/target/generation
  are all rejected.
- RED `session-renewal.test.ts` (**amended per E4-D11 — replay is lost-response RECOVERY, not
  sustained renewal**): against a fake that models the enrollment code-route TTL, a lost enroll
  response is recovered by a replay (same code + retained idempotency key + unchanged digest +
  a **fresh** proof) WITHIN the code window → same identity + a new session, no double-consume;
  after the code route expires, a replay returns 401 `unauthorized` and the worker stops and
  signals `reenrollment_required`. No assertion that a replay succeeds past the code-route window
  (the as-built server rejects it; sustained renewal is escalated as E4-F007).
- RED `session-revocation.test.ts`: a revoked/replaced generation on the **enroll/renew path**
  returns 401 `unauthorized` (NOT `target_revoked`/409, which is a poll/ack-only signal — E4-D11)
  and the worker treats it as terminal: stops using the old identity and backs off.
- GREEN: implement identity/transport/enrollment/session; run the focused command + protocol
  build + worker typecheck/build.

**Evidence / commit:** `tickets/WRK-002-result.md`; one commit
`feat(worker-daemon): device-bound enrollment and session renewal`. Maps D0-T03/T05, H-04, H-05.

**Internal TDD/commit slices (one ticket, one final reviewer):** A—vendored headers + Ed25519
key + canonical proof with cross-checked vectors; B—key stores (mounted + keychain iface/stub)
and enroll flow; C—session refresh/rotation/revocation. Each slice ≤1 agent-day and
independently green; the distinct reviewer reruns the combined acceptance matrix and alone
marks the ticket `complete`.

### WRK-003 — Poll, ACK, and capability advertisement (M, ≤3 agent-days, PRE-D1)

**Depends on:** WRK-002; **JOB-003 must be `complete`** at a recorded reviewed revision (its
as-built poll/lease/ACK HTTP contract is consumed here).
**Outcome:** A long-poll loop that advertises measured capacity/capabilities, receives at most
one lease offer, ACKs promptly, enforces bounded local concurrency, backs off with bounded
jitter, and — on shutdown — stops leasing before draining in-flight work.

**Ticket non-goals:** executing the job (WRK-004 supervises), lease renewal / fence-close proxy
(WRK-005), the durable event outbox (WRK-006), and secret resolution.

**Files:** create `packages/worker-daemon/src/poll/poll-loop.ts`, `poll/backoff.ts`,
`poll/capacity.ts`, `poll/concurrency.ts`; modify `transport/client.ts` (add poll + lease_ack),
`metrics/metrics.ts`, `lifecycle/shutdown.ts` (register lease-stop-before-drain), and the
entrypoint composition; tests `src/__tests__/capacity.test.ts`, `backoff.test.ts`,
`concurrency.test.ts`, `poll-empty.component.test.ts`, `poll-offer-ack.component.test.ts`,
`poll-incompatible.test.ts`, `poll-backpressure.test.ts`, `poll-outage.component.test.ts`,
`poll-drain.component.test.ts`; extend `support/fake-control-plane.ts` with poll/ACK.

**Interfaces:** `measureCapacity(): WorkerCapacity` — real free CPU/mem/disk (`node:os`) minus
in-flight reservations, plus per-workload slot counts; validated against `workerCapacitySchema`.
`pollOnce({client, session, capacity}): PollOutcome` — posts `pollRequestV1Schema` (audience
`worker_poll`, obeys the 64 KiB / 30s descriptor) and returns `offer(leaseOffer) | no_work
(retryAfterMs) | drain`. On `offer`, the loop validates the offered job's `requiredCapabilities`
against the branded `providerConstraintProfile ∩ worker report` via `workerSatisfiesRequirements`
(defense in depth), then ACKs with `leaseAckOperationRequestV1Schema` (audience `worker_run`,
body `leaseAckV1Schema`; body `leaseId` == URL param) and hands the lease/fence to the WRK-004
supervisor seam (a stub in this ticket). `nextBackoff(state, retryAfterMs)` — bounded jittered
delay that honors an explicit `retryAfterMs` and otherwise grows within `[baseMs, maxMs]`. The
`ConcurrencyLimiter` refuses to poll for a workload class whose local slots are exhausted (it
advertises zero free slots rather than fetching work it cannot run).

**Failure behavior:** an empty poll (`no_work`) waits `retryAfterMs` (or the bounded backoff);
a `drain` outcome stops new leasing and lets in-flight work finish; an API outage
(timeout/`throttled`/`internal_unavailable`/socket error) triggers bounded jittered backoff and
never crashes the loop or busy-spins; a non-retryable protocol error is surfaced and the loop
continues after backoff without leaking the offer. The worker never prefetches secrets and
never scans a broad queue — it holds only the single offered lease. An offer that fails the
local capability self-check is not ACKed. At the concurrency ceiling the worker exerts
backpressure by advertising zero free slots.

**Compatibility / rollback:** additive worker-only modules; no server/db/migration change. The
loop is inert until composed by the entrypoint; rollback = disable the loop.

**Observable signals:** metrics `poll_outcome{outcome}`, `lease_ack{outcome}`,
`active_leases`, `backoff_sleep_ms` (bucketed), `capacity_free_slots{workload}`; logs carry
`{correlationId, leaseId, workloadType}` opaque IDs; a shutdown log showing lease-stop preceded
drain.

**RED → GREEN:**
- RED `capacity.test.ts`: measured capacity subtracts in-flight reservations and validates
  against `workerCapacitySchema`; exhausted slots report zero free.
- RED `backoff.test.ts`: honors explicit `retryAfterMs`; otherwise stays within `[baseMs,
  maxMs]` with jitter; never zero-spins.
- RED `concurrency.test.ts`: the limiter blocks polling for a saturated workload class and
  releases on completion.
- RED `poll-empty.component.test.ts`: `no_work` → wait `retryAfterMs` and re-poll.
- RED `poll-offer-ack.component.test.ts`: a compatible offer is validated, ACKed with matching
  `leaseId`, and handed to the supervisor stub; the fake records exactly one ACK.
- RED `poll-incompatible.test.ts`: an offer whose `requiredCapabilities` exceed the worker's
  branded intersection is not ACKed.
- RED `poll-backpressure.test.ts`: at the concurrency ceiling the worker advertises zero free
  slots and does not accept more work.
- RED `poll-outage.component.test.ts`: timeouts / `throttled` / `internal_unavailable` / socket
  errors drive bounded jittered backoff with no crash or busy-loop.
- RED `poll-drain.component.test.ts`: a `drain` outcome (and a shutdown signal) stops new
  leasing before in-flight work drains.
- GREEN: implement the loop/backoff/capacity/concurrency and shutdown registration; run the
  focused command + protocol build + worker typecheck/build.

**Evidence / commit:** `tickets/WRK-003-result.md`; one commit
`feat(worker-daemon): long-poll, ACK, and capacity advertisement`. Maps D0-T01/T02/T05, H-04,
H-05, H-06.

**Internal TDD/commit slices (one ticket, one final reviewer):** A—capacity + backoff +
concurrency primitives; B—poll/ACK client + capability self-check; C—loop composition, outage
backoff, and drain-before-lease-stop. Each slice ≤1 agent-day and independently green; the
distinct reviewer reruns the combined matrix and alone marks the ticket `complete`.

### WRK-004 — Sandbox supervisor and process-tree cancellation (M, ≤3 agent-days, PRE-D1)

**Depends on:** WRK-003, PRT-003 (frozen).
**Outcome:** A provider-neutral sandbox supervisor implementing create/execute/cancel/kill/
destroy + list/inspect + idempotent reconcile/cleanup, with negotiated checkpoint/restore/
health, process-tree cancellation, and a **distinct monotonic cleanup authority** — while
running the tenant command inside the sandbox, never in the worker process.

**Ticket non-goals:** any real provider (E2B/gVisor is E6/E7), the durable event outbox
(WRK-006), the fence-close egress proxy (WRK-005), object-byte upload/secret materialization
(E5), and live-control-plane reconciliation (WRK-007). CORE supervises and reconciles against
the in-process fake provider only.

**Files:** create `packages/worker-daemon/src/supervisor/provider.ts`,
`supervisor/fake-provider.ts`, `supervisor/effect-authority.ts`,
`supervisor/cleanup-authority.ts`, `supervisor/supervisor.ts`, `supervisor/reconcile.ts`,
`supervisor/events.ts`; modify the WRK-003 supervisor seam to hand real leases to the
supervisor and `metrics/metrics.ts`; tests `src/__tests__/provider-contract.test.ts`,
`supervisor-happy.component.test.ts`, `capability-negotiation.test.ts`,
`optional-ops-unsupported.test.ts`, `supervisor-hung-create.test.ts`,
`supervisor-cancel-escalation.test.ts`, `cleanup-authority-denial.test.ts`,
`cleanup-cross-resource-denial.test.ts`, `cleanup-redaction.test.ts`,
`provider-idempotency-replay.test.ts`, `list-inspect-pagination.test.ts`,
`cleanup-idempotent.test.ts`, `cleanup-expiry-escalation.test.ts`, `destroy-failure.test.ts`,
`checkpoint-restore-health.test.ts`, `reconcile-leaked.test.ts`, `no-local-tenant-spawn.test.ts`,
`supervisor-shutdown.test.ts`.

**Interfaces:** `SandboxProvider` driver interface over `PROVIDER_OPERATIONS` — the 8 core
`create/execute/cancel/kill/destroy/list/inspect/reconcile_cleanup` returning typed results
(`create → {sandboxId, providerOpId, resourceLabels}`; `execute → {exitCode, signal, timedOut,
stdoutRef, stderrRef}` running inside the sandbox; `destroy/reconcile_cleanup → {cleanupStatus:
"success"|"failed", providerOpId}`), plus the 3 optional `checkpoint/restore/health` that throw
an explicit `UnsupportedProviderOperation` unless advertised. Every op takes a `deadlineMs` and a
stable `idempotencyKey`; a repeated key returns the recorded result (lost-response replay).
`createFakeSandboxProvider(script)` — a deterministic in-memory double (mirroring
`createFakeSandboxRuntimeProvider`) addressable by provider ID, inspectable, and injectable with
a hang/ignore-cancel/destroy-failure at each checkpoint. `EffectAuthority` — issued while the
lease/fence is active; the only path that may `create/execute/resume/checkpoint`.
`CleanupAuthority({resourceLabels, targetGeneration, fence:{jobId,attempt,leaseId,observedSeq},
deadline, epoch})` — a monotonically increasing epoch that, once effect authority is withdrawn,
may only (a) `list`/`inspect` through a **management-only redacted projection** — never command,
env, logs, secrets, workspace/customer bytes, or object grants — or (b) `cancel/kill/destroy/
reconcile_cleanup`; it can never `create/execute/resume/checkpoint`, reveal a non-matching
resource, or open egress. `Supervisor.cancel()` cancels the whole process tree; escalation on
deadline/ignore is `cancel → kill → destroy`. `reconcile()` lists provider resources by
ownership label and idempotently destroys orphans not backed by a live lease. `events.ts`
produces contiguous-`seq` `workerEventV1` with `eventDigest` computed via `canonicalEventDigestInputV1`
+ `node:crypto` into an **injected sink** (durable upload is WRK-006).

**Acceptance (verbatim, honored fully):** lease loss withdraws effect authority but triggers
cancellation and eventual kill through a distinct monotonic cleanup authority bound to provider
resource/ownership labels, target generation, job/attempt/lease/observed fence, and deadline.
Cleanup can only list/inspect matching resources through a management-only projection (redacted:
no command, env, logs, secrets, workspace/customer bytes, or object grants) or cancel/kill/
destroy/reconcile; it cannot create/execute/resume/checkpoint/reveal-other-resources/open-egress.
Provider ops have deadlines + stable idempotency keys; unsupported checkpoint/restore/health
fail explicitly rather than being guessed; sandbox identity + provider op IDs attach to all logs
and cleanup records.

**Failure behavior:** a hung `create` hits its deadline → cancel/kill and record a failed
create; an ignored `cancel` escalates to `kill`; after lease expiry/replacement the effect path
is denied and only the cleanup authority may act; every effectful op attempted under cleanup
authority is denied; a cross-resource or wrong-target-generation label is denied and cannot
become an existence oracle; even same-resource inspection returns only the redacted projection;
a `destroy` failure returns `cleanupStatus:"failed"` (durable-retryable, never thrown) and is
re-attempted idempotently; an unsupported optional op fails explicitly. The tenant command is
never spawned in the worker process — a dedicated test asserts no local child process runs the
tenant command.

**Compatibility / rollback:** additive worker-only modules; no server/db/migration change. The
supervisor is inert until WRK-003 hands it a lease; rollback = disable the supervisor seam.

**Observable signals:** every log/cleanup record carries `{sandboxId, providerOpId,
resourceLabels(hashed), leaseId, deviceGeneration, cleanupEpoch, escalationStage}`; metrics
`sandbox_op{op,outcome}`, `cleanup_outcome{status}`, `cleanup_escalation{stage}`,
`reconcile_orphans_total`; no command/env/secret/byte content appears anywhere.

**RED → GREEN:**
- RED `provider-contract.test.ts`: the fake satisfies the 8 core ops and throws
  `UnsupportedProviderOperation` for unadvertised optional ops.
- RED `supervisor-happy.component.test.ts`: create → execute (inside sandbox) → terminal event
  → destroy under effect authority, with sandbox identity + op IDs on every record.
- RED `capability-negotiation.test.ts`: advertised vs unadvertised optional ops gate
  checkpoint/restore/health.
- RED `optional-ops-unsupported.test.ts`: unsupported checkpoint/restore/health fail explicitly,
  never guessed.
- RED `supervisor-hung-create.test.ts`: a create past its deadline escalates to cancel/kill.
- RED `supervisor-cancel-escalation.test.ts`: an ignored cancel escalates cancel → kill →
  destroy across the process tree.
- RED `cleanup-authority-denial.test.ts`: under cleanup authority, every effectful op
  (create/execute/resume/checkpoint/reveal-other/open-egress) is denied.
- RED `cleanup-cross-resource-denial.test.ts`: a resource/target-generation label mismatch is
  denied with no existence disclosure.
- RED `cleanup-redaction.test.ts`: same-resource inspect returns only the redacted management
  projection (no command/env/logs/secrets/bytes/grants).
- RED `provider-idempotency-replay.test.ts`: a lost-response replay with the same idempotency
  key returns the recorded result and does not double-apply.
- RED `list-inspect-pagination.test.ts`: list/inspect paginate deterministically.
- RED `cleanup-idempotent.test.ts`: repeated cleanup converges and never resurrects effect
  authority.
- RED `cleanup-expiry-escalation.test.ts`: past the cleanup deadline the authority escalates
  monotonically and cannot regress.
- RED `destroy-failure.test.ts`: a destroy failure returns `failed` status (durable-retryable),
  never throws.
- RED `checkpoint-restore-health.test.ts`: when advertised, checkpoint/restore/health behave per
  the negotiated modes.
- RED `reconcile-leaked.test.ts`: reconcile lists by ownership label and idempotently destroys
  orphans with no live lease.
- RED `no-local-tenant-spawn.test.ts`: the tenant command runs inside the sandbox; the worker
  process spawns no local child for it.
- RED `supervisor-shutdown.test.ts`: shutdown cancels the tree and lets cleanup converge.
- GREEN: implement provider/fake/effect/cleanup/supervisor/reconcile/events; run the focused
  command + protocol build + worker typecheck/build.

**Evidence / commit:** `tickets/WRK-004-result.md`; one commit
`feat(worker-daemon): sandbox supervisor with monotonic cleanup authority`. Maps D0-T01/T02/T05,
H-05, H-09.

**Internal TDD/commit slices (one ticket, one final reviewer):** A—provider interface + fake
double + core lifecycle under effect authority; B—cleanup authority (monotonic epoch, redacted
projection, cross-resource denial, idempotency-key replay) and escalation; C—reconcile,
optional-op negotiation, no-local-spawn, and shutdown. Each slice ≤1 agent-day and independently
green; the distinct reviewer reruns the full acceptance matrix — including every H-05 denial and
the redaction/no-spawn proofs — and alone marks the ticket `complete`.

### WRK-005 — Lease renewal / local fence-close proxy / governed egress (M, ≤3 agent-days, POST-D1)

**Depends on:** WRK-003, WRK-004; **PRT-003/PRT-004 frozen** (the `lease_renew` + `quarantine_*` v1
schemas are consumed unmodified); **E6-D1-FOUNDATION `complete`** (first post-D1 worker ticket —
it wires the loop toward live dispatch). Records the consumed WRK-004 reviewed SHA and the
frozen-protocol source SHA `b7a842870ce7509d8baa75409e0ab19da375c88a`.

**Outcome:** A per-lease **renewal driver** that captures `offer.expiresAt` at handoff and renews
the lease before expiry through the frozen `lease_renew` op; a **local fence-close proxy** — a
governed-effect authority bound to the same `EffectFence` and the driver's tracked lease-liveness —
that permits the four exit-gate governed effects (ordinary artifact commit, secret materialization,
task completion, governed network egress) ONLY while the fence is live and denies them the instant
the lease is lost / a renew is rejected / the server orders a cooperative cancel; and an
**orphan-output quarantine** module that, after fence close, routes any output ONLY through the
device-session `quarantine_grant`/`quarantine_finalize` path (which survives lease loss) and never
through the disabled ordinary-commit path. On loss the driver closes the proxy, then escalates
through the existing `Supervisor.onLeaseLost`. The worker holds no authority: the lease + fence is a
revocable grant, the server `isActiveFence` predicate is the real gate, and this proxy is
defense-in-depth.

**Ticket non-goals:** the **live** artifact-commit / secret-materialization / completion /
governed-egress **transport ops and their server routes** (no `artifact_commit`,
`artifact_transfer_grant`, `completeAttempt`, egress-proxy, or `quarantine_*` server route exists —
E5/DAT owns them); the **live** quarantine upload round-trip (built against the extended fake
control-plane only, exactly as WRK-004 supervised against the fake provider); the durable event
outbox (WRK-006); live-control-plane reconciliation (WRK-007); **any server-side session-renewal fix
(E4-F007 / E3-JOB-002)** — WRK-005 renewal is bounded by session lifetime and MUST NOT attempt to
extend a session; and starting the loop for real dispatch (the provisioning self-model is still
absent — E4-D12). WRK-005 stays **additive and inert-until-wired**.

**Files:** create `packages/worker-daemon/src/lease/lease-renewal.ts` (renewal scheduler +
fence-loss classifier + per-lease liveness registry + the single-op `renewLeaseOnce`),
`lease/fence-close-proxy.ts` (governed-effect authority + governed-egress `network_denied`; the
`FenceClosedError`), `lease/quarantine.ts` (orphan-output routing decision + quarantine grant/finalize
request builders + reason classifier + `runOrphanQuarantine`); modify `transport/client.ts` (add
`leaseRenew` + `leaseRenewPath`, and `quarantineGrant`/`quarantineFinalize` + their paths — a NEW
`device_session` posting mode; widen the `postOperation` operation union), `metrics/metrics.ts`
(bounded counters + the closed `effect` label), `supervisor/events.ts` (a `networkDenied` emitter on
`EventSequencer`), `lifecycle/shutdown.ts` (`createLeaseLifecycleSteps` inserts `renewal-stop`
between `lease-stop` and `lease-drain`), `bin/worker-daemon.ts` (compose the driver's shutdown seam +
document the wrapped `SupervisorSeam`), and `index.ts` (barrel the new public types); extend
`src/__tests__/support/fake-control-plane.ts` with a `/worker-control/leases/:id/renew` handler
(worker_run) and `/worker-control/quarantine/*` handlers (device_session). Tests as in the focused
row above (16 files).

**Interfaces:** `createLeaseRenewalDriver({client, session, key, identity, supervisor, schedule,
tuning, metrics, eventSink, makeFenceProxy})` — returns a `SupervisorSeam` decorator over the WRK-004
supervisor plus `stop()`. On `accept(handoff)` it registers the lease from `handoff.offer.expiresAt`,
starts a renewal timer at `expiresAt − leadMs`, delegates to the real `supervisor.accept`, and stops
that lease's renewal when the delegate settles. Each real renewal builds a `leaseRenewOperationRequestV1`
under a **fresh `idempotencyKey`**, signs the device proof over `client.leaseRenewPath(leaseId)`, and
POSTs it. On `renewed` it reschedules to the server-selected `expiresAt` and, if `cancelRequested`,
does a cooperative cancel; on `rejected`/`stale_fence`/`target_revoked`/`attempt_terminal`, a renew
whose deadline lapses past `expiresAt`, or a clock-skewed past expiry, it declares **lease loss**.
`FenceCloseProxy` (a `GovernedEffectAuthority`) bound to an `EffectFence`, cloned from `EffectAuthority`:
`commit()`/`readSecret()`/`complete()`/`openEgress()` pass through a `#guard` while active; `close()`
is terminal + idempotent; after close every seam rejects `FenceClosedError`, and `openEgress()`
additionally emits a `network_denied` worker event into the injected sink — the positive counterpart
of `CleanupAuthority.openEgress()`. `classifyOrphanOutput(...) → QuarantineReason` +
`buildQuarantineGrantRequest`/`buildQuarantineFinalizeRequest` construct the frozen
`quarantineGrantPayloadV1`/`quarantineFinalizePayloadV1` authenticated by `targetId` +
`deviceGeneration` (NOT a live lease), under the distinct `quarantine/…` prefix, with a ≤5-minute
grant ceiling and **no apply/promote/select field** (CAV-004). `ControlPlaneClient` additions:
`leaseRenewPath(leaseId)` + `leaseRenew` (worker_run) and `quarantineGrant`/`quarantineFinalize`
(device_session, PROVISIONAL binding pending E5/DAT), all reusing the shared `postOperation`.

**Acceptance (verbatim, honored fully):** lease loss disables ordinary commit, secrets, completion,
and governed egress; only the explicit quarantine operation may carry orphan output. Renewal
re-asserts a revocable grant, never extends the worker's own authority; the worker follows
generation/revocation and never resurrects a lost grant. A renewed lease with `cancelRequested` still
stops cooperatively. A replayed renewal never double-extends (fresh key per real renewal). Renewal is
bounded by session lifetime; a session-terminal condition forces re-enrollment + orphan-output
quarantine, not renewal (E4-F007). The quarantine path uses `device_session` auth, a distinct prefix,
a ≤5-minute non-promotable grant, and never carries lease authority.

**Failure behavior:** a renew transport timeout retries with the SAME `idempotencyKey` and never
busy-spins; a renew `401` routes through `session.recover()` under `MAX_CONSECUTIVE_RECOVERIES` and,
if the code route has lapsed, surfaces `SessionTerminalError` → lease loss; a
`rejected`/`stale_fence`/`target_revoked`/`attempt_terminal` is terminal lease loss; a renew deadline
lapsing past `expiresAt` fails **closed locally** (the proxy closes without trusting any later renew);
a clock-skewed `expiresAt` already past is a loss; a **late-firing timer** (sleep/resume) is caught by
a pre-POST monotonic expiry check; a governed effect attempted after fence close is refused
(`FenceClosedError`; egress additionally emits `network_denied`); orphan output produced after close
is diverted to quarantine (device_session), never the disabled `artifact_commit` — but if the session
is already terminal, even quarantine cannot run and the output is dropped with a redacted terminal log
(the F007 bound). On loss the driver closes the proxy FIRST, then calls `supervisor.onLeaseLost`.

**Compatibility / rollback:** additive worker-only modules; runtime deps stay EXACTLY
`@armyofagents/worker-protocol` + `pino`; no server/db/migration/route change (E4-D09). The driver
wraps the `SupervisorSeam` at composition and is inert until the loop is wired for live dispatch
(E4-D12); rollback = compose the bare supervisor without the renewal wrapper (poll-loop.ts is not
edited, so WRK-003/WRK-004 stay green).

**Observable signals:** metrics `lease_renew{outcome}`, `lease_loss{reason}`, `fence_close{reason}`,
`governed_effect_denied{effect}`, `quarantine{outcome}` — bounded labels only (the `effect` label is a
new CLOSED four-value set); logs carry only opaque IDs; no DB URL is ever read.

**Evidence / commit:** `tickets/WRK-005-result.md`; one commit `feat(worker-daemon): lease renewal,
fence-close proxy, and orphan-output quarantine`. Maps D0-T01/T02, H-05, **H-06** (the fence-close
egress proxy), CAV-004.

**Internal TDD/commit slices (one ticket, one final reviewer):** A—renewal driver (schedule,
fresh-key renewal, reschedule, cancelRequested, rejected/loss, 401-recovery, idempotent replay, clock
bounds, shutdown) + client `leaseRenew`; B—fence-close proxy (permit/deny/terminal/idempotent,
governed-egress `network_denied`); C—quarantine routing + `quarantineGrant/Finalize` client +
device_session fake-plane routes. Each slice ≤1 agent-day and independently green; the distinct
reviewer reruns the full acceptance matrix — including every fence-close denial, the non-promotion
(CAV-004) proof, and the F007-bound quarantine proof — and alone marks the ticket `complete`.

---

## 5. Legacy parity mapping (FND-007 / frozen-main crosswalk)

The worker daemon is a **net-new** artifact; there is no legacy in-repo worker to preserve
parity with, so no FND-007 parity dimension is bridged by CORE. The relevant legacy analogue is
the current in-process heartbeat/adapter execution path (`server/src/services/heartbeat.ts`,
adapter registry), which stays fully authoritative and untouched: the worker daemon does not
replace, wrap, or disable it. Cutover of any Organization/workload from in-process execution to
the distributed worker is an **E10 MIG** concern, explicitly out of E4-CORE scope. Absence of a
crosswalk row for a worker capability is recorded as net-new, never as "parity passed."

---

## 6. Failure-mode coverage and observability

| Code path | Realistic production failure | Test | Handling / signal |
|---|---|---|---|
| Config load | Invalid endpoint / trust / DB URL present | WRK-001 config-matrix | Throws before I/O; exits non-zero; DB URL ignored. |
| Boundary | A source imports server/db/drizzle | WRK-001 boundary | CI `policy` fails; forbidden import rejected. |
| Shutdown | Two signals race; a step fails | WRK-001 shutdown | One-shot ordered stop; always exits. |
| Device proof | Signature/body/path/method tamper or copied session | WRK-002 enrollment | Server `unauthorized`; worker does not reuse a bad proof. |
| Session | 15-min TTL expiry / lost enroll response | WRK-002 session-renewal | Replay-path refresh; no double consume. |
| Revocation | Stolen old generation | WRK-002 revocation | Uniform `target_revoked`; worker stops old identity, backs off. |
| Key store | Corrupt/unreadable key file | WRK-002 key-store-corrupt | Fail closed; refuse to enroll; exit non-zero. |
| Poll outage | Timeout / throttled / socket error | WRK-003 poll-outage | Bounded jittered backoff; no crash/busy-spin. |
| Backpressure | Local slots saturated | WRK-003 backpressure | Advertise zero free slots; no prefetch. |
| Drain | Control plane drains / shutdown | WRK-003 poll-drain | Stop leasing before draining in-flight. |
| Incompatible offer | Job exceeds worker capability | WRK-003 poll-incompatible | Self-check via `workerSatisfiesRequirements`; not ACKed. |
| Hung create | Provider create never returns | WRK-004 hung-create | Deadline → cancel/kill; record failed create. |
| Ignored cancel | Sandbox ignores cancel | WRK-004 cancel-escalation | Escalate cancel → kill → destroy (process tree). |
| Lease loss | Fence expired/replaced mid-run | WRK-004 cleanup-denial | Effect authority withdrawn; only cleanup authority acts. |
| Cross-resource | Wrong label/generation under cleanup | WRK-004 cross-resource-denial | Denied; no existence oracle. |
| Same-resource inspect | Attempt to read command/secret/bytes | WRK-004 cleanup-redaction | Redacted management projection only. |
| Lost provider response | Retried op after a dropped reply | WRK-004 idempotency-replay | Stable idempotency key returns recorded result. |
| Destroy failure | Provider destroy fails | WRK-004 destroy-failure | `cleanupStatus:"failed"`; durable-retryable, never thrown. |
| Leaked resource | Orphan sandbox with no lease | WRK-004 reconcile-leaked | Idempotent label-scoped destroy. |
| Local spawn | Tenant command run in worker process | WRK-004 no-local-spawn | Denied; command runs inside sandbox only. |

No listed path is silent without both a test and handling. Stable metrics use bounded labels
(operation, outcome/reason, workload, provider, escalation stage) — never Organization, Company,
actor, job, event content, key, or secret. Structured logs carry only opaque IDs under the
redaction guard.

---

## 7. Gate traceability

### D0 REQUIRED / HARD / INITIAL map (CORE contribution)

| Requirement | Owning evidence |
|---|---|
| D0-T01 focused acceptance | Every WRK ticket's result ledger and reviewer rerun. |
| D0-T02 lifecycle ownership | WRK-003 poll-outcome handling and WRK-004 sandbox/cleanup state machine against the frozen vocabularies; no invented combined machine. |
| D0-T03 validators | WRK-002 device-proof vector fixture and any new auth/idempotency validator run deterministic vectors; frozen E1 schemas remain unchanged. |
| D0-T04 protocol ownership | Expected N/A (zero E1 diff). Any additive protocol need triggers custodian review + full cross-version corpus. |
| D0-T05 hermetic inputs | All CORE suites use fake clock/fixtures, in-process fake control-plane + fake provider; no live provider/network/customer data/credential; no database. |
| D0-R01 | Through `Invoke-NativeGate`: build workspace packages, then `pnpm -r typecheck`, `pnpm test:run`, `pnpm -r build`; classify only committed DEC-03 baseline failures as pre-existing/not-E4-touched. |
| D0-R02 | Root `pnpm build` through `Invoke-NativeGate`, with no tracked-byte mutation. |
| H-04 secret containment | WRK-002 private-key/raw-code/session redaction + canary; WRK-004 cleanup-redaction; no secret resolution in CORE. Zero tolerance. |
| H-05 sandbox boundary | The E4 headline invariant: the worker sends only protocol control, holds no DB credential, imports no server/db (WRK-001 boundary check), and runs tenant commands only inside the sandbox (WRK-004 no-local-spawn). Zero tolerance. |
| H-06 network boundary | WRK-001 loopback-only health/metrics; WRK-003 exposes no ingress and opens no egress; the fence-close egress proxy is WRK-005. |
| H-07 hosted exclusions | The worker is dormant; it does not flip `AOA_DISTRIBUTED_EXECUTION_ENABLED` and adds no hosted-API path. |
| H-08 supply chain | WRK-001 declares one frozen workspace dependency + pino; `check:frozen-worker-protocol-v1` proves the new consumer does not invalidate frozen v1; the signed image is DEP-001. |
| H-09 cleanup | WRK-004 monotonic cleanup authority + idempotent reconcile; provider-resource kill/cleanup against a real provider is E6/E7. |
| H-10 evidence integrity | Append-only WRK ticket results and reviewer attempts. |

### `E6-D1-FOUNDATION` consumption

**None for CORE.** WRK-001..004 do not consume the D1 foundation; they are validated entirely
against in-process fakes. WRK-005, WRK-006, and WRK-007 (planned separately) consume
`E6-D1-FOUNDATION` and own the real distributed-topology proofs (lease-loss partitions,
encrypted outbox durability, restart reconciliation, provider-resource cleanup). A CORE ticket
marked complete is not any distributed gate.

### E4-CORE integration checkpoint (independent owner)

1. Freeze one implementation candidate after all four reviewer-completed ledgers (WRK-001..004),
   each recording its consumed upstream reviewed SHA (JOB-002 for WRK-002, JOB-003 for WRK-003).
2. An Integration Gate Owner who implemented/reviewed no E4 ticket builds workspace packages,
   then runs each ticket's focused command 3× on the frozen revision, plus the
   dependency-boundary check, `check:frozen-worker-protocol-v1`, D0-R01/R02, and a byte-clean
   worktree check. Any H-04/H-05/H-08 failure is `fail`, never conditional/waived.
3. On Windows local, run from the short path `C:\e3` and label the result
   `operator-directed windows-local`. Linux CI is the formal DEC-03 authority.
4. The owner writes an immutable `qa/<date>-core-e4-worker-daemon-<sha12>-aN.md` and a distinct
   `handoffs/<date>-core-checkpoint-<sha12>-aN.md`, pinning every ticket-result blob SHA and the
   reviewed revision. This checkpoint **enables WRK-005..007 planning**; it is not the E4 exit
   gate, which additionally requires WRK-005..007 complete and `E6-D1-FOUNDATION`.

---

## 8. Controller sequence and parallelization

```text
WRK-001 -> WRK-002 -> WRK-003 -> WRK-004 -> CORE checkpoint (independent owner)
   |          |           |
   |          |           +-- gated on JOB-003 complete
   |          +-- gated on JOB-002 complete
   +-- gated on PRT-001 + FND-005 (already complete)
```

All four CORE tickets touch the one new `packages/worker-daemon` package, so this worktree
serializes them to avoid package-scaffold, CI-step, and lockfile conflicts. WRK-001 is
genuinely independent of E3 and can start immediately; WRK-002/WRK-003 wait on their JOB-002/
JOB-003 upstream completions but their non-server-facing primitives (key/proof, backoff,
capacity, concurrency) can be written and RED-tested against fakes before the upstream lands.
WRK-004 depends only on the already-frozen PRT-003 vocabulary and WRK-003's supervisor seam.

| Step | Modules touched | Depends on |
|---|---|---|
| Scaffold | package, config, logger, shutdown, health, boundary check, CI step | PRT-001, FND-005 |
| Identity | transport headers/client, device key/proof, key store, enroll, session | WRK-001, JOB-002 complete |
| Poll/ACK | poll loop, backoff, capacity, concurrency, client poll/ack | WRK-002, JOB-003 complete |
| Supervisor | provider interface, fake, effect/cleanup authority, reconcile, events | WRK-003, PRT-003 |

### Commit/evidence boundaries

- One implementer code commit per ticket (`feat(worker-daemon): …`); the reviewer's separate
  append-only result commit is the only commit that completes the ticket.
- If a ticket needs a short commit series, every commit is scoped and the result ledger
  identifies the reviewed tip; no drive-by cleanup.
- Reviewers use plain `git commit` (never `--no-verify`).
- `findings.md` records discovered behavior, rejected hypotheses, STOP conditions, and
  resolution; a behavior-changing choice also updates `decisions.md` and this plan before
  implementation resumes.

---

## 9. Planner self-review

- WRK-001..004 canonical outcomes/dependencies/acceptance (including the verbatim WRK-004
  cleanup-authority contract) are represented; all four stay ≤3 agent-days (WRK-001 is S).
- The worker is a genuinely isolated leaf: E4-D01 forbids server/db/shared/drizzle imports and
  is enforced by a boundary checker wired into CI `policy`, plus a per-package
  `dependency-boundary.test.ts`.
- Frozen E1 v1 is consumed without edits (E4-D02); the custodian STOP is explicit; the
  frozen-consumer checker proves the new dependency declaration does not invalidate v1.
- Device possession is at the HTTP transport boundary (E4-D03), reproduced client-side with a
  cross-checked vector fixture so worker signatures verify against JOB-002's server signer;
  the session-renewal contract (E4-D05) is a named confirm-at-assignment STOP against JOB-002's
  as-built.
- The private key never enters logs/config; container mounted-secret and desktop keychain-
  interface stores are separated (E4-D06), with real keychains deferred to DSK-001/002.
- H-05 is the epic headline and is proven three ways: the import boundary, loopback-only health,
  and the no-local-tenant-spawn test; tenant commands run only inside the sandbox (E4-D08).
- The cleanup authority is distinct, monotonic, redacted, label/generation/fence/deadline-bound,
  and destructive-only — with cross-resource denial, idempotency-key replay, escalation, and
  status-not-throw destroy semantics (E4-D07) — matching the verbatim acceptance.
- No worker-owned database/schema/migration (E4-D09); CORE suites are hermetic and Windows-
  runnable with no embedded-PG lane; upstream JOB-002/JOB-003 completions are hard assignment
  boundaries; WRK-005..007 + `E6-D1-FOUNDATION` (not CORE) own the real distributed gate.

---

## 10. Implementation Tasks

Synthesized from the ticket contracts above. Checkbox only after the named outcome is committed
and independently reviewed; these tasks do not authorize implementation.

- [ ] **T1 (P1 STOP, human: ~2h / agent: ~1h)** — upstream gates — record JOB-002 and JOB-003
  `complete` reviewed SHAs before assigning WRK-002 / WRK-003.
  - Surfaced by: Dependencies — WRK-002/003 consume as-built E3 HTTP contracts still in flight.
  - Files: `tickets/WRK-002-result.md`, `tickets/WRK-003-result.md` dependency-state sections.
  - Verify: each result pins the consumed upstream reviewed 40-hex SHA and its passing handoff.
- [ ] **T2 (P1, human: ~1 day / agent: ~2h)** — isolation boundary — build the worker-daemon
  boundary checker and wire it into CI `policy`.
  - Surfaced by: Architecture — E4-D01 is only real if statically enforced like worker-protocol.
  - Files: `scripts/check-worker-daemon-boundary.mjs` + `.test.mjs` + `lib/`, root script, CI step.
  - Verify: forbidden import fixtures fail; real sources pass; CI `policy` runs the step.
- [ ] **T3 (P1 STOP, human: ~2 days / agent: ~4h)** — device proof/binding — reproduce the
  JOB-002 canonical proof and ratify shared test vectors.
  - Surfaced by: Security/Architecture — worker signatures must verify against the server signer
    across a package boundary that forbids code sharing.
  - Files: `identity/device-proof.ts`, `__tests__/fixtures/device-proof-vectors.json`, headers.
  - Verify: byte-parity vectors match JOB-002's server-side verifier; tamper/skew/copied-session
    fail closed.
- [ ] **T4 (P1, human: ~1 day / agent: ~2h)** — session lifecycle — confirm JOB-002's as-built
  renewal path and implement refresh/rotation/revocation.
  - Surfaced by: Architecture — E4-D05 assumes replay-based session mint; a dedicated renew
    audience would change it.
  - Files: `identity/session.ts`, `enrollment/enroll.ts`, fake control-plane support.
  - Verify: near-expiry refresh, lost-response replay, rotation, and revocation all pass; STOP if
    JOB-002 diverges.
- [ ] **T5 (P1, human: ~4h / agent: ~1h)** — key custody — mounted-secret store now, keychain
  interface stub for desktop.
  - Surfaced by: Security — private key must never be logged/configured; desktop keychain is DSK.
  - Files: `identity/key-store.ts`, key-store + corrupt tests, logger redaction guard.
  - Verify: round-trip with strict perms; corrupt store fails closed; no key bytes in any output.
- [ ] **T6 (P1, human: ~1 day / agent: ~2h)** — poll discipline — bounded jittered backoff,
  local concurrency, and drain-before-lease-stop.
  - Surfaced by: Reliability — an unbounded/busy-spinning loop or prefetch would break H-06.
  - Files: `poll/poll-loop.ts`, `backoff.ts`, `capacity.ts`, `concurrency.ts`, shutdown reg.
  - Verify: empty/offer/incompatible/backpressure/outage/drain component tests pass.
- [ ] **T7 (P1 STOP, human: ~2 days / agent: ~4h)** — cleanup authority — distinct monotonic,
  redacted, destructive-only authority with every denial proven.
  - Surfaced by: Security/Architecture — the verbatim WRK-004 acceptance is the epic's hardest
    contract.
  - Files: `supervisor/effect-authority.ts`, `cleanup-authority.ts`, `supervisor.ts`,
    `reconcile.ts`, denial/redaction/idempotency/escalation tests.
  - Verify: every effectful op denied under cleanup; cross-resource/target-label denial;
    same-resource redaction; lost-response replay; destroy-failure status; leaked reconcile.
- [ ] **T8 (P1, human: ~4h / agent: ~1h)** — sandbox boundary — tenant command runs inside the
  sandbox only.
  - Surfaced by: Security — H-05 is the E4 headline invariant.
  - Files: `supervisor/supervisor.ts`, `no-local-tenant-spawn.test.ts`.
  - Verify: no local child process runs the tenant command; execute dispatches into the provider.
- [ ] **T9 (P2, human: ~4h / agent: ~1h)** — optional-op negotiation — checkpoint/restore/health
  fail explicitly unless advertised.
  - Surfaced by: Tests — guessing an unsupported op is a correctness/security hazard.
  - Files: `supervisor/provider.ts`, `fake-provider.ts`, capability/optional-op tests.
  - Verify: unadvertised optional ops throw `UnsupportedProviderOperation`; advertised behave per
    negotiated mode.
- [ ] **T10 (P2, human: ~4h / agent: ~1h)** — CORE checkpoint — independent owner runs the four
  focused suites 3× plus boundary/frozen/byte-clean, then writes QA + handoff.
  - Surfaced by: Evidence integrity — the checkpoint enables WRK-005..007 but is not the exit gate.
  - Files: `qa/…-core-e4-worker-daemon-…`, `handoffs/…-core-checkpoint-…`.
  - Verify: all suites green 3×; H-04/H-05/H-08 zero-tolerance; result blobs pinned.
