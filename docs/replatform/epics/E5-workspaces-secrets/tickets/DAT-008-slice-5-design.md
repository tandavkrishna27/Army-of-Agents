# DAT-008 slice 5 — Design: the worker redeems the handle, synthesises the sandbox env, and seeds per-run redaction canaries

**Epic:** `E5-workspaces-secrets`. **Parent:** [`DAT-008-design.md`](./DAT-008-design.md) §4 slice 5
(revision 1) + [`DAT-008-terrain.md`](./DAT-008-terrain.md). **Sprint:** 4 (go-book §4 / §9).
**Closes:** M2 + M7 (parent §3). **Promotes:** `E5-5-redaction` (go-book §4 "Done when").
**Owns nothing new**; consumes the shipped slices 1–4 ([`DAT-008-result.md`](./DAT-008-result.md)).

**Start SHA:** the commit that adds this file. Line references are to `docs/replatform-program`
at **`bd178603f`** (Sprint 3 tip) unless another SHA is named.

**Gate to start:** Sprints 1, 2, 2.5, 2.75 **and 3** green. Verified at Step 0: `E4-F010` is
`resolved` (findings.md §E4-F010 — WRK-011/Sprint 2.75), the five registers pass, and the
composed dispatch runtime (`composeDispatchRuntime`) exists as slice 5's wiring target.

---

## 0. What this slice is, in one paragraph

The server half of DAT-008 shipped (slices 1–4): a `job_secret_handles` row is minted at
placement, the active handles ride the lease envelope as opaque refs, and
`POST /api/worker-control/execution-secrets/resolve` will hand a **worker that presents the
run's fence** the plaintext value for an `env` / `sandbox_local_only` handle. **Nothing on the
worker walks through that door** — `packages/worker-daemon/src` has **zero** runtime references
to a secret handle (verified §1). Slice 5 builds the worker half: the supervisor reads
`handoff.offer.job.secretHandles`, redeems each `env` / `sandbox_local_only` handle through a new
LOCAL transport op (device proof + session, the E4-D03 pattern), synthesises `env[target] = value`
into the `CreateSandboxSpec` (closing M2 — today `env: {}` at `supervisor.ts:209`), and seeds every
redeemed value as a **per-run** redaction canary into both event streams **before** the sandbox is
created (closing M7). A denied or failed redemption **fails the attempt closed** — no sandbox, a
durable terminal — because a credential-redemption path that fails **open** is the worst defect
class this ticket can ship.

## ★ 0.1 WRITTEN AGAINST THE POST-SPRINT-3 TREE — five facts the parent design predates

The parent design (`373205816`, revision 1 at `60864244a`) was written before slices 1–4 landed
and before Sprint 3 composed the dispatch runtime. Five of its premises are now sharper or moved,
verified at `bd178603f`:

| # | Parent design said | Verified now |
|---|---|---|
| C1 | "the sandbox gets no environment (`supervisor.ts:199` `env:{}`)" | `env: {}` is now at **`supervisor.ts:209`** (`createSpecFor`), still a literal, still passed through at `e2b-provider.ts` (`envVars: spec.env`). Gap real. |
| C2 | redaction canaries are `supervisor.ts:283` `[]` "until wired" | They are **REQUIRED** now, at **two** construction sites, both hardcoded `[]`: the supervisor (`supervisor.ts:123`, used per-run at `:294`) **and** the per-lease `FenceCloseProxy` (`fence-close-proxy.ts:141`, fed at `lease-renewal.ts:374`). **Both are per-supervisor / per-driver-construction, NOT per-run** (§1). Slice 5 must make them per-run. `lease-renewal.ts:372-373` carries the code's own marker: *"the run's canaries must be threaded to here."* |
| C3 | slice 4 route "reused `SecretResolveRequestV1`" | The WIRE schema the route parses is `executionSecretResolveRequestSchema` (`execution-secret-resolve.ts:44-56`), a `.strict()` zod schema; `SecretResolveRequestV1` is a broker-internal TS interface. The worker mirrors the **wire** schema (§2). |
| C4 | "the route returns a value" (implied) | Confirmed AND with a trap: **success and denial are BOTH HTTP 200.** Success `{outcome:"resolved", envTarget, value, ...}`; denial `{outcome:"denied", reason, ...}` (`worker-control.ts:749-760`). The worker MUST branch on the body's `outcome`, never on the HTTP status. Treating any 200 as success is the fail-**open** defect (§4.4). |
| C5 | E5-5 tracks `createFenceAwareEgressProxy` | That symbol is the DAT-005 **egress-proxy** (Direction B), which DAT-008's Direction A never uses. Slice 5 re-points E5-5's symbol to the worker redemption path it actually wires (Step 10). |

## ★ 0.2 SLICE 7 DEFERS — read this before assuming this sprint builds two things

Sprint 4's scope is slices 5 **and** 7. Slice 7 (warm-resume re-resolution) is **DEFERRED** — see
[`DAT-008-slice-7-design.md`](./DAT-008-slice-7-design.md). In one line: the distributed
(worker-daemon) path has **no** warm-resume mechanism — `EffectAuthority.resume()` /
`SandboxProvider.restore()` have **zero** production callers after Sprint 3, there is no distributed
lease pause/resume, and the only live warm-lease lifecycle is the **legacy #320 server substrate**
that MIG-005 will *replace*, not the distributed path DAT-008 targets. Building slice 7 now would
mean inventing the mechanism, which go-book §4 forbids. Slice 5 is therefore the only code this
sprint ships.

---

## 1. Verified state — what exists at `bd178603f`, with citations

**The gap (M2).** `createSpecFor` (`packages/worker-daemon/src/supervisor/supervisor.ts:205-210`)
is **synchronous** and returns `env: {}` (`:209`). It is called once per run in `runLifecycle`
(`:296`), whose `EventSequencer` is built at `:286-295` with `redactionCanaries: deps.redactionCanaries`.

**The handles arrive but are unread.** `secretHandleRefSchema` is frozen
(`packages/worker-protocol/src/policy.ts:171-196`, `.strict()`): `{ handleId (branded uuid),
materialization (discriminated on kind ∈ proxy|env|file; env/file carry `target`), usePolicy ∈
fence_proxy|remote_server_fenced|sandbox_local_only }`. `secretHandles: secretHandleRefSchema.array().max(64)`
sits on `jobEnvelopeBaseSchema` (`job.ts:343`) — a **top-level sibling of `workload`, NOT nested
under it** — so the worker access path is **`handoff.offer.job.secretHandles`**. Duplicate handleIds
are rejected at `job.ts:384`. The worker reads none today: a grep of `worker-daemon/src` (minus
tests) for `secretHandles` returns only the fixture `__tests__/support/poll-fixtures.ts` (`[]`).

**The two per-run canary sinks (M7).** Both are built with a construction-time `[]`:
- The supervisor's per-run `EventSequencer` — `supervisor.ts:286-295`, `redactionCanaries:
  deps.redactionCanaries`; `deps.redactionCanaries` is bound ONCE at `createSupervisor` construction
  (`dispatch-runtime.ts:130` passes `[]` for the single long-lived supervisor that serves every run
  via the `runs` Map). Per-supervisor, not per-run.
- The driver's per-lease `FenceCloseProxy` — built at `lease-renewal.ts:355-375` inside
  `registerLease` (`:597`), `redactionCanaries: []` (`:374`) with the marker comment `:363-373`.
  The proxy's own `EventSequencer` (`fence-close-proxy.ts:160-166`) captures those canaries.

**The scrubber is per-run-ready.** `scrubEventStrings(event, canaries)` (`supervisor/redaction.ts:64-70`)
takes canaries explicitly per call, deep-copies, and replaces every occurrence of each canary
substring with `REDACTION_MARKER` (`:27`), and `EventSequencer.#emit` runs it BEFORE the digest +
`workerEventV1Schema.parse` (`events.ts:136-140`), so the durable outbox can only ever seal the
marker. `EventSequencer` captures `#canaries` by reference at construction (`events.ts:107`). The
missing piece is not the scrubber — it is a **per-run canary value** and its threading.

**The transport pattern for a LOCAL (non-frozen) op** is established three times — self-model read
(`transport/client.ts:73-80`), session renew (`:92-99`), self-hello refresh (`:110-117`): a vendored
`_PATH` constant + a vendored `_DESCRIPTOR` (maxRequestBytes/timeoutMs) + a client method that POSTs
signed bytes with the session as Bearer and the five `aoa-device-*` proof headers, the device proof
signed **over the exact path** (`postOperation`, `:309-364`). Path parity is pinned by
`scripts/check-worker-path-parity.mjs`, never by comment (`:88-91`).

**The E4-D01 boundary** (`scripts/lib/worker-daemon-boundary.mjs:53,79-127`; manifest
`packages/worker-daemon/package.json:27-30`) permits `worker-daemon/src` to import ONLY
`@armyofagents/worker-protocol` + `pino` (+ node builtins + relative). The redeem client therefore
**cannot import** the server's request schema; it builds the body as a plain object mirroring the
wire schema, pinned by a parity/contract test — exactly as the three existing LOCAL ops do.

**The composition target.** `composeDispatchRuntime` (`lifecycle/dispatch-runtime.ts:100-199`)
builds the single supervisor (`:126`) and the lease-renewal driver (`:136`), behind the default-OFF
`AOA_WORKER_DISPATCH_ENABLED`. This is where slice 5 injects the redeem client and the per-lease
canary coordinator.

## 2. The redemption contract — the door slices 1–4 built (verified server-side)

**Route:** `POST /api/worker-control/execution-secrets/resolve` (`server/src/routes/worker-control.ts:701`;
mounted `/api` + no subprefix, `app.ts:497,952`). **Descriptor** (LOCAL, non-frozen):
`EXECUTION_SECRET_RESOLVE_DESCRIPTOR` (`services/execution-secret-resolve.ts:78-85`) — `audience:
"worker_run"`, `idempotent:false`, `maxRequestBytes: 4096`, `timeoutMs: 10_000`.

**Auth:** device proof via `verifyWorkerOperationProof` (signs method + path + body digest) + the
session as Bearer (`worker-control.ts:714-727`). The worker already holds a live session (Sprint 2.5)
and its device key.

**Request body** (`executionSecretResolveRequestSchema`, `.strict()`, `execution-secret-resolve.ts:44-56`):
```
{ protocolVersion: 1, audience: "worker_run", correlationId: string(1..200),
  workerId: string, jobId: uuid, attempt: int>0, leaseId: uuid, fenceToken: string, handleId: uuid }
```
The worker holds every field from the handoff.

**Responses — BOTH HTTP 200** (`worker-control.ts:749-760`):
- success: `{ protocolVersion:1, outcome:"resolved", envTarget:<env-var-name>, value:<PLAINTEXT>, serverTime }`
- denial: `{ protocolVersion:1, outcome:"denied", reason, serverTime }`, `reason ∈ {stale_fence,
  attempt_terminal, target_revoked, malformed}`. Over-size / parse-fail / missing-auth also → 200
  `outcome:"denied"` (`denyMalformed`, `:702-707`, `:756-760`).

The route already refuses a non-`env`/non-`sandbox_local_only` outcome and a `device_handoff`
outcome server-side (`admitSandboxLocalResolution`, `execution-secret-resolve.ts:110-134`), and the
path is in `PAYLOAD_OMITTED_PATHS` (`http-log-policy.ts:44`). `connector_oauth` stays fail-closed by
construction (`execution-secret-brokers.ts:58-61`). Slice 5 does not weaken any of this; it consumes
it.

---

## 3. Dependencies — all HARD and all satisfied

| Dep | Kind | State at `bd178603f` |
|---|---|---|
| Slices 1–4 (mint, envelope, value store, resolve route) | HARD | Shipped, CI-green ([`DAT-008-result.md`](./DAT-008-result.md)) |
| Sprint 2.5 (production `SessionStore` + a live session) | HARD — the redeem call presents the session as Bearer | Shipped; the composed daemon holds a live session |
| Sprint 3 (`composeDispatchRuntime`, supervisor + driver composed) | HARD — the wiring target | Shipped; `E4-F010` resolved |
| `AOA_WORKER_DISPATCH_ENABLED` default-OFF | — | Unchanged; slice 5 adds no new default-on behaviour |

Slice 5 changes **no** behaviour while dispatch is off: a worker with the flag off never composes a
supervisor, so `createSpecFor` never runs and no redemption ever fires. Rollback = the flag (§10).

---

## 4. Architecture — the four decisions this slice makes

### 4.1 Redemption lives in the supervisor (R6), not the driver

R6 (parent §4 slice 5) requires the redemption budget to be **subtracted from the create budget,
not added to it**, and the create budget (`createDeadlineMs`) is the supervisor's. The
fail-closed-on-failure machinery (durable terminal + `escalateCleanup`) is also the supervisor's
(`supervisor.ts:302-317`). Putting redemption anywhere else would either double the terminal-emission
logic or leave a hanging redemption outside every deadline. **Decision: `createSpecFor` becomes async
and redeems inside `runLifecycle`, before create, under a redemption sub-budget carved from
`createDeadlineMs`.** The driver is NOT the redeemer — it decorates the supervisor and never emits a
lifecycle terminal.

### 4.2 One redemption feeds both canary sinks, via a per-lease live array

The proxy is built in the driver's `registerLease` **before** the supervisor's async run redeems, so
it cannot receive a canary *value* at construction. Re-redeeming for the proxy is forbidden (R7:
`resolveCount` must increment exactly once per handle). The resolution that redeems **once** and
feeds **both** sinks without the supervisor knowing about the driver's proxy:

- `composeDispatchRuntime` creates a **per-lease canary coordinator** — a `Map<leaseId, string[]>`
  exposing `ensure(leaseId): string[]` (idempotent, returns the SAME array) and `release(leaseId)`.
- The driver's `makeFenceProxy(fence, identity)` passes `coordinator.ensure(leaseId)` — a **live,
  initially-empty array** — as the proxy's `redactionCanaries`. Its `EventSequencer` captures that
  reference.
- The supervisor, after redeeming and **before create**, calls
  `coordinator.ensure(handoff.leaseId).push(...canaries)` and builds its **own** per-run
  `EventSequencer` from that **same** array. One push, two sinks.
- The driver's `completeLease` (`lease-renewal.ts:433-441`) calls `coordinator.release(leaseId)` so
  the map does not grow without bound.

The timing invariant that makes the live array sound: **seed strictly before any emit on either
stream.** The supervisor seeds before `create` (`supervisor.ts:301`); its first emit is
`attempt_started`/a create-fail terminal, both after seeding. The proxy's only emit is
`network_denied`, and it fires only after `close()` (lease loss/completion), i.e. at run end. So on
both streams every emit sees the seeded array. When the coordinator is absent (the supervisor built
without it — unit tests, a non-driver composition), the supervisor falls back to its own per-run
array; behaviour is identical minus the proxy sink. **This is the load-bearing structural claim the
adversarial review must attack (M14/M15).**

> **Why thread to the proxy at all, given Direction A.** In this ticket the redeemed model-provider
> value is materialised into the **sandbox env** and the sandbox reaches the provider **directly**
> (parent §9 limit 1: the DAT-005 egress proxy is not on this path). So the value provably cannot
> reach the proxy's `network_denied` stream *in this ticket's scope*. Threading it anyway is uniform
> defense-in-depth — the scrubber's stated design ("the redaction chokepoint stays uniform across
> every sink", `fence-close-proxy.ts:126-128`) and the code's own marker (`lease-renewal.ts:372-373`).
> The planted-leak test (§6 Step 5) proves the plumbing redacts, so the belt is not vacuous.

### 4.3 The env-target allowlist — the worker admits only provider-auth names

`envTargetSchema` (`policy.ts:109`) is `/^[A-Z_][A-Z0-9_]*$/` — it would accept `PATH`, `LD_PRELOAD`,
`NODE_OPTIONS`. A mint is server-authored and CLI-001 v1 mints only `provider:anthropic`/`openai`
targets, but the worker does **not** get to assume that: it enforces its **own** allowlist of
provider-auth env-var names (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` — the CLI-001 v1 scope, parent §8).
The name it materialises is the **handle's** `materialization.target` (from the frozen,
schema-validated envelope), and it **asserts the response's `envTarget` equals it** (defense in depth
against a route/handle disagreement). An **unknown** target **fails the run** — never a silent drop,
because a dropped credential surfaces later as an opaque CLI auth error (parent §4 slice 5 guard 1).
The allowlist is a worker-local `const` (E4-D01 forbids importing the server catalog); a comment
names `packages/shared/src/providers/provider-catalog.ts` as the source of truth and a contract test
pins the two values.

### 4.4 The classification — fail CLOSED on everything but a clean `resolved`

Because denial is HTTP 200, the client cannot lean on status. The worker classifies the parsed body:
- `outcome === "resolved"` **and** a non-empty string `value` **and** a non-empty string `envTarget`
  → materialise. Anything else → **redemption failure**.
- `outcome === "denied"` (any reason) → redemption failure, **never retried** (R7).
- a `ControlPlaneTransportError` (timeout/network) → retry **at most once** with the SAME
  correlationId semantics as the other ops; a second failure → redemption failure (R7).
- a malformed/unparseable body → redemption failure.

A redemption failure fails the **attempt**: the supervisor emits a durable `terminal{status:"failed",
errorCode:"secret_redemption_failed"}` and escalates cleanup — **no sandbox is created**. This is the
fail-closed core, and its guard is the one a deleted-branch mutant must turn red (M-lead, §6 Step 11).

---

## 5. Files touched

**New**
- `packages/worker-daemon/src/lease/secret-redemption.ts` — the redeem client caller + response
  classifier + env synthesiser + the provider-auth allowlist. Pure over an injected
  `ControlPlaneClient`, device key, session, and `signDeviceProof`; E4-D01-clean.
- `packages/worker-daemon/src/__tests__/secret-redemption.test.ts` — unit + mutation coverage.
- `packages/worker-daemon/src/__tests__/dispatch-secret-materialization.integration.test.ts` —
  embedded-PG lease→redeem→create round trip (`describe.skipIf` on Windows w/o `AOA_RUN_WIN_INTEGRATION`).

**Edited**
- `transport/client.ts` — `EXECUTION_SECRET_RESOLVE_PATH` + `_DESCRIPTOR` + `resolveExecutionSecret`
  method + the `postOperation` op-name union; `ControlPlaneClient` interface addition.
- `supervisor/supervisor.ts` — `createSpecFor` async; `runLifecycle` redeems + seeds before create;
  new deps: `resolveSecrets` client + optional `canaryCoordinator` + `secretRedemptionDeadlineMs`.
- `supervisor/provider.ts` — no change (the frozen `CreateSandboxSpec.env` already holds a record).
- `lease/lease-renewal.ts` — `makeFenceProxy` reads the coordinator's per-lease array;
  `completeLease` releases it; new optional `canaryCoordinator` dep.
- `lifecycle/dispatch-runtime.ts` — construct the coordinator, inject the redeem client + coordinator
  into supervisor and driver.
- `scripts/check-worker-path-parity.mjs` — add the resolve path.
- `scripts/test-inventory.json` — bump `packages/worker-daemon` pin (currently **144**).
- `scripts/test-execution-census.json` — only if a new `*.test.mjs` is added (none planned; the
  parity check is an existing `.mjs`).
- `docs/deploy/environment-variables.md` — document `AOA_WORKER_SECRET_REDEEM_TIMEOUT_MS` (§6 Step 6)
  because brand-check guard 9 is blind to the `ENV`-map convention (go-book §5).
- `scripts/gate-clause-wiring.json` — re-point + promote `E5-5-redaction` (Step 10).

---

## 6. The TDD steps — fail-first, positive control first, DELETE each guard

### ★ Step 0 — the scoping gate (NO CODE)

Confirm at tip, before writing a line: (a) `E4-F010` is `resolved` (else 2.75 is out of sequence —
STOP); (b) the five registers pass; (c) `handoff.offer.job.secretHandles` is the access path and the
worker reads none today; (d) both canary sinks are `[]` at construction; (e) the resolve route
returns `outcome`-in-body with denial-as-200. If any is false, the plan's premise moved — STOP and
say so (go-book §2.4). Commit this design; that SHA is the Start SHA.

### Step 1 — the transport client redeem op + path parity (RED: parity check fails first)

Add `EXECUTION_SECRET_RESOLVE_PATH = "/api/worker-control/execution-secrets/resolve"` and
`EXECUTION_SECRET_RESOLVE_DESCRIPTOR = { maxRequestBytes: 4096, timeoutMs: 10_000 }` (mirroring the
server descriptor), a `resolveExecutionSecret(request: WorkerOperationHttpRequest)` method routed
through `postOperation` (the value returns in the **body**, so `postOperation` is correct — unlike
`sessionRenew`/`selfHelloRefresh`, no header is read), and the op name to the `postOperation` union.
**RED first:** extend `scripts/check-worker-path-parity.mjs` to require the resolve path and run it —
it fails because the client lacks the constant. Then add the constant; it passes. A contract test
asserts the exact path string and descriptor numbers (E4-D04 parity, parent §4 slice 5 guard 6).

### Step 2 — the request builder + the classifier (RED: classifier rejects a denied-200)

Build the request body `{ protocolVersion:1, audience:"worker_run", correlationId, workerId, jobId,
attempt, leaseId, fenceToken, handleId }`; sign the device proof over `resolveExecutionSecret`'s
path + bytes; present the session Bearer. Write the classifier `classifyResolveResponse(res) →
{ kind:"resolved", envTarget, value } | { kind:"denied", reason } | { kind:"transport" } |
{ kind:"malformed" }`. **RED first:** a test feeding a `200 {outcome:"denied", reason:"stale_fence"}`
asserts `kind:"denied"`; write it before the classifier and watch it fail (the not-yet-written
function). Then implement. **Anti-vacuity:** include a `200 {outcome:"resolved", value:"", ...}` case
that must classify as NOT resolved (empty value is a failure) — the exact case a naive
`status===200` check would wave through.

### Step 3 — env synthesis + the target allowlist (RED: `PATH` target must fail the run)

`synthesiseEnv(handles, redeem)` iterates `env`/`sandbox_local_only` handles, redeems each once, and
returns `{ env, canaries }`. Guards, each with its own RED:
- an allowlisted target (`ANTHROPIC_API_KEY`) → `env` carries exactly it; **RED:** assert first that
  a fresh synthesiser returns `{}` (nothing wired), then implement.
- an **unknown** target (`PATH`) → the whole synthesis **throws** `UnknownSecretTargetError`; **RED:**
  the throw-assertion fails before the guard exists. (Positive control: with the guard deleted, a
  `PATH` target is admitted and the test goes green — proving the guard is what fails it.)
- a `materialization.target` that disagrees with the response `envTarget` → throws; RED then guard.
- a non-`env`/non-`sandbox_local_only` handle is **skipped** (out of scope; `proxy`/`file` are other
  classes), asserted so a future handle class cannot silently ride this path.

### Step 4 — wire redemption into the supervisor, fail CLOSED (RED: a denied redemption creates no sandbox)

Make `createSpecFor` async; in `runLifecycle`, before create: redeem → seed the per-run canaries →
build the `EventSequencer` with them → build the spec with `env`. On any redemption failure
(classifier `denied`/`transport`/`malformed`, or an allowlist throw), emit
`terminal{status:"failed", errorCode:"secret_redemption_failed"}` and `escalateCleanup`, and
**return before create**. **RED first:** a supervisor test with a redeem stub returning `denied`
asserts `provider.create` was **never called** and a `failed` terminal was emitted — it fails before
the wiring exists. **This is the fail-closed core.** Positive control (Step 11): delete the
`if (redemption.failed) return` branch → the run proceeds to create with a partial/empty env → the
test must go red.

### Step 5 — per-run canaries reach BOTH streams (RED: a planted leak survives, then is redacted)

Introduce the per-lease canary coordinator; inject it into supervisor + driver; seed before create;
`makeFenceProxy` reads `coordinator.ensure(leaseId)`; `completeLease` releases it. **RED first:** a
test seeds a canary, emits a lifecycle event whose message **contains** the secret, and asserts the
persisted event carries `REDACTION_MARKER` not the secret — it fails while the supervisor still uses
`deps.redactionCanaries` (`[]`). A **second** test does the same on a `network_denied` event through
the proxy. **Anti-vacuity (parent §5):** each test asserts the secret **was** present in the
pre-scrub event, so a test where the value never appears cannot pass whether or not the scrubber
runs. **Per-run isolation:** a two-run test asserts run A's canary does not redact run B's identical
plaintext — falsifies a per-supervisor registry.

### Step 6 — the redemption deadline (R6) (RED: a hanging redeem is cut, not unbounded)

Carve `AOA_WORKER_SECRET_REDEEM_TIMEOUT_MS` (default e.g. 5000, read through the `config.ts` `ENV`
map) from `createDeadlineMs`: wrap the whole redemption in `withDeadline(redeem, redeemBudget)`, and
reduce the subsequent create deadline by the elapsed redemption time so `redeem + create ≤
createDeadlineMs` (subtracted, not added). **RED first:** a redeem stub that never resolves must
produce a `failed` terminal within the budget, not hang — the test times out (RED) until the deadline
wraps redemption. Document the switch in `environment-variables.md` (brand-check guard 9 is blind to
the `ENV` map — go-book §5).

### Step 7 — bounded retry + exact-once audit (R7) (RED: a denial is retried / resolveCount≠1)

One retry, **transport error only**, never on a denial. **RED first:** a redeem stub that returns
`denied` on the first call asserts the client calls the route **once** (no retry) — fails until the
retry guard excludes `denied`. A stub that throws `transport` once then resolves asserts exactly
**two** calls and a `resolved` outcome. The integration test (Step 9) asserts `resolve_count` on the
handle row increments **exactly once** for a successful redemption.

### Step 8 — compose it (RED: composed supervisor has no redeem client → typecheck/coverage fails)

Inject the real redeem client (bound to `deps.client.resolveExecutionSecret` + `deps.key` + the
session) and the coordinator into `composeDispatchRuntime`'s `makeSupervisor`/`makeDriver` calls.
Update the "NO observeRun … `[]` safe" comment (`dispatch-runtime.ts:124-125`) — it is now false: the
supervisor holds a transient plaintext, and per-run canaries are the reason `[]` at construction is
still safe (the run's canaries are seeded per-run, not at construction).

### Step 9 — the integration proof (embedded-PG, real lease → redeem → create)

On embedded Postgres (Linux CI; `AOA_RUN_WIN_INTEGRATION=1` locally): mint a `provider_key`/`env`/
`sandbox_local_only` handle on a placed job, drive a composed daemon through a real lease, and assert:
the sandbox `create` spec's `env` carries `ANTHROPIC_API_KEY = <the stored value>`; `resolve_count`
incremented exactly once; a denied redemption (revoked handle) yields a `failed` terminal and **no**
`create`. This is the clause "a sandbox authenticates using a redeemed handle" at integration level
(real-provider auth over live E2B is Sprint 5 — parent §9 limit 3).

### Step 10 — promote `E5-5-redaction` (this fails the build if skipped)

Re-point E5-5's `symbol` from `createFenceAwareEgressProxy` to the worker redemption/seeding function
that the composed supervisor now references (e.g. `synthesiseEnv` or the supervisor's
`materializeRunSecrets`), and set `status:"wired"` with a reason: *redaction now has a real per-run
secret-value input, composed into the dispatch runtime and proven by a planted-leak integration test;
a real sandbox authenticating over live E2B remains Sprint 5.* Run
`node scripts/check-gate-clause-wiring.mjs` — a wrong symbol (still zero-caller) fails
`claimed_wired_but_no_caller`; leaving it `unwired` after the reference exists fails
`unwired_but_now_has_caller`. **Anti-vacuity:** the promotion is honest only because Step 5's
planted-leak test proves the scrubber redacts — the wiring checker reads caller count, never the
reason (go-book §6), so the proof lives in the test, not the field.

### Step 11 — mutation sweep + inventories + docs + result doc

Positive control FIRST on each guard module (break the function outright; if the suite still passes,
it exercises nothing). Then the mutation table (§ below), each by **deletion**. Bump the
worker-daemon test-inventory pin. Add any new `*.test.mjs` to the census. Write
[`DAT-008-slice-5-result.md`](./DAT-008-slice-5-result.md) and update GO-BOOK §3.1 + §4.

---

## 7. Acceptance table — every clause → a test that can turn RED

| # | Clause (go-book §4 / parent §5) | Test that fails if it regresses |
|---|---|---|
| A1 | The sandbox env carries the redeemed provider key | Step 9 integration: `create` spec `env.ANTHROPIC_API_KEY === stored value` |
| A2 | A **denied** redemption fails **closed** — no sandbox | Step 4 unit + Step 9: redeem `denied` → `failed` terminal, `provider.create` never called |
| A3 | A **failed/hanging** redemption fails closed within budget | Step 6: never-resolving redeem → `failed` terminal within `redeemBudget`, no create |
| A4 | An **unknown** env target fails the run (never dropped) | Step 3: `PATH` target → `synthesiseEnv` throws → `failed` terminal |
| A5 | Denial-as-200 is not mistaken for success | Step 2: `200 {outcome:"denied"}` → `kind:"denied"`; `200 {value:""}` → not resolved |
| A6 | Every redeemed value is redacted from the lifecycle stream | Step 5: planted leak in a lifecycle event → `REDACTION_MARKER` |
| A7 | …and from the fence-close proxy stream (uniform) | Step 5: planted leak in a `network_denied` event → `REDACTION_MARKER` |
| A8 | Canaries are **per-run**, no cross-run bleed | Step 5: run A's canary does not redact run B's identical plaintext |
| A9 | Canary seeded **before** create | Step 5: call-order assertion — seed precedes `provider.create` |
| A10 | `resolve_count` increments **exactly once** per success | Step 7 + Step 9 |
| A11 | A denial is **never** retried; a transport error retried once | Step 7: `denied` → 1 call; `transport`-then-ok → 2 calls |
| A12 | The frozen wire is untouched | `check:frozen-worker-protocol-v1` + `worker-protocol-contract-bytes` green; no `packages/worker-protocol/` edit |
| A13 | The daemon still imports only protocol+pino | `worker-daemon-boundary` green (the redeem client is E4-D01-clean) |
| A14 | Path parity holds | `check-worker-path-parity.mjs` green with the resolve path required |
| A15 | Inert while dispatch is off | Step 4/8: flag off → no supervisor → no redemption (rollback §10) |

---

## 8. The mutation table — DELETE each guard, positive control first

| M | Guard (delete it) | Test that must go RED | Positive control |
|---|---|---|---|
| M1 | the `outcome==="resolved"` branch in the classifier | A5 (`denied`-200 classified resolved) | break `classifyResolveResponse` → all A5 red |
| M2 | the non-empty-`value` check | A5 (`value:""` admitted) | — |
| M3 | the fail-closed `if (redemption.failed) return` in `runLifecycle` | A2/A3/A4 (`create` called on failure) | stub `provider.create` throws → run reaches it |
| M4 | the `failed` terminal emission on redemption failure | A2 (no durable terminal) | — |
| M5 | the target allowlist membership check | A4 (`PATH` admitted) | delete → `PATH` in `env`, test green ⇒ guard was the failer |
| M6 | the `envTarget === materialization.target` cross-check | A4 variant (mismatch admitted) | — |
| M7 | the `denied → no retry` guard | A11 (`denied` retried) | — |
| M8 | the retry cap (allow >1) | A11 (transport looped) | — |
| M9 | the redemption `withDeadline` wrap | A3 (hang not cut) | — |
| M10 | the create-budget subtraction (make it additive) | R6 wall-clock assertion (total > createDeadlineMs) | — |
| M11 | the pre-create seed ordering (seed after create) | A9 (order assertion) | — |
| M12 | the supervisor's use of the per-run array (revert to `deps.redactionCanaries`) | A6 (lifecycle leak survives) | — |
| M13 | the proxy's use of `coordinator.ensure` (revert to `[]`) | A7 (proxy leak survives) | — |
| M14 | the per-lease keying (share one array across leases) | A8 (cross-run bleed) | — |
| M15 | `coordinator.release` in `completeLease` | a leak-growth assertion (map retains released leases) | — |

Any surviving mutant is a **question**, not a pass: prove equivalence by deleting both the guard and
its backstop and showing the suite then fails (go-book §2.2). A mutant that will not COMPILE is not
an equivalent and may not be counted.

---

## 9. Findings

None expected to be filed by this slice; if the adversarial review surfaces one, file it in
`epics/E5-workspaces-secrets/findings.md` with a status and declare it in
`scripts/finding-ownership.json` in the **same commit** (go-book §2.4). A HIGH/CRITICAL may not be
quietly accepted.

## 10. Rollback — one env var

`AOA_WORKER_DISPATCH_ENABLED` off (its default): no supervisor is composed, so `createSpecFor` never
runs and no redemption fires — byte-identical to today. The narrower rollback (dispatch on, redemption
off) is the composition passing a redeem client that returns "no handles"; but the true rollback unit
is the flag, because slice 5 adds no default-on path. Mint-side rollback stays slice 1's (parent §10).

## 11. Out of scope — named

- **Slice 7 (warm-resume re-resolution)** — DEFERRED ([`DAT-008-slice-7-design.md`](./DAT-008-slice-7-design.md)).
- **`connector_oauth` / the `fence_proxy` egress class** — stays fail-closed (parent §8); its own
  redemption path and the proxy's real canary input belong to that class's ticket.
- **`file` / `remote_server_fenced` materialisation** — this slice handles `env` / `sandbox_local_only`
  only (the CM-013 model-provider class); `file` targets are skipped, asserted (Step 3).
- **Egress network-policing of the sandbox** — parent §9 limit 1; not on this path.
- **Real-provider authentication over live E2B** — Sprint 5's journey (parent §9 limit 3). Slice 5's
  evidence is integration-level.
- **Providers beyond `claude_local`/`codex_local`** — CLI-001 v1 scope (parent §8).
