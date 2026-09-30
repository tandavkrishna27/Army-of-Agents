# DEP-012 — adapter-manager: the out-of-process networked provider host

**Epic:** E6 · **Plan node:** `docs/replatform/program-design.md`, `#### DEP-012`
**Depends on:** DEP-010 · **Size:** L (sliced; Slice 1 · Unit A first) · **Status:** Slice 1 · Unit A design (2026-08-28, post-recon @ `0e4834a27`; 4-agent adversarial review applied — §S1.10)
**Contract of record:** [`qa/2026-08-28-adapter-manager-scope.md`](../../../qa/2026-08-28-adapter-manager-scope.md) §8 (the SETTLED provider-topology decision — credential=(i), out-of-process, redacted-projection wire, no streaming slice, durable idempotency ledger)
**Seam partner:** DEP-011 (the worker-side networked driver — one seam, two ends)

---

## Why this ticket exists

The chain's seventh link (`WAVE-4-RESEQUENCE.md` §3.7): the real `E2bSandboxProvider` **may not run
in the worker container**. This is not a design preference — it is machine-enforced.
`scripts/lib/staging-manifest-invariants.mjs` `checkProviderControlBoundary` (`:436`) requires
`E2B_API_KEY` (`PROVIDER_CONTROL_CRED_ENV`, `:120`) and `provider-ctl-net` membership to be EXACTLY
the `adapter-manager` service (`ADAPTER_MANAGER_SERVICE`, `:29`), and forbids that credential on
every other surface across `environment`/`env_file`/`secrets`/`configs`/mounts. So the containerized
worker's `deps.provider` must be a **networked driver** (DEP-011) that RPCs each op to a separate host
that holds the key — `adapter-manager`.

`docker-compose.staging.yml:316` DECLARES that service (image `aoa-adapter-manager:staging`, `:317`;
`E2B_API_KEY` injected, `:322`; on `provider-ctl-net`, `:345`) — but **no build produces that image.**
There is no source directory, no Dockerfile, no wire schema, and no worker-side client. It is a
manifest fiction the invariant guards but nothing implements. DEP-011 (the worker-side wire) was filed
as a stub deferred precisely because "specifying a wire against an unimplemented peer for an unbuilt
caller is the failure this programme keeps re-learning" — its peer is this ticket. **adapter-manager
had no owning ticket; this node is it.** DEP-011 is repointed onto it (`Depends on: DEP-010, DEP-012`).

## What it must build (design written at sprint start, against the tree as it exists then)

The [adapter-manager scope](../../../qa/2026-08-28-adapter-manager-scope.md) §2/§6/§8 is the contract:
a new **server** that hosts `new E2bSandboxProvider({ transport })` (the same authoritative per-op
`SandboxProvider` port DEP-010 named — this is the desktop in-process construction moved across a
process boundary), holds `E2B_API_KEY`, listens on `control-net`, and exposes `/healthz` + mutual-auth
+ peer-allowlist. Its non-frozen wire (NOT in `worker-protocol`) serves the 11 `PROVIDER_OPERATIONS`
unchanged. Settled in §8, do not relitigate: the credential crossing is **(i)** (worker redeems, sends
the bearer over the mutually-authenticated internal hop); `inspect`/`list` cross as **redacted
projections only** (the full `InspectResult` never crosses — the F2 wire rule); there is **no streaming
slice** (`execute` is unary/byte-free; live output rides the frozen `event_upload` outbox); a **durable
idempotency ledger** replaces the in-memory `#idempotency` map. Slice plan: §6 (wire+round-trip over
`MockE2bTransport` → real `E2bSandboxProvider`/`RealE2bTransport` → conformance + DEP-008 isolation →
credential crossing → deploy). Conformance reuses `sandbox-provider-contract`.

## Precondition — when this becomes REQUIRED, not before

The moment a containerized worker under `docker-compose.staging.yml` must dispatch to real E2B — i.e.
the Tier-0 BUILD step of the worker-dispatch chain, AFTER the earlier links are built (WAVE-4-RESEQUENCE
§5: container identity → session → matchable hello → self-model → loop composition, most of which are
now owned; see [`qa/2026-08-28-worker-dispatch-chain-reconciled.md`](../../../qa/2026-08-28-worker-dispatch-chain-reconciled.md)).
Building Slice 1 before a container can enrol (WRK-014) and before a worker dispatches (flag default-off,
no `compose:true` reachable on a container root) would wire against an unbuilt caller — the same failure
DEP-011 was deferred to avoid. Its per-op fidelity is component-testable earlier (driver ↔ server in an
integration test, scope §8 wire-F5), but the through-the-daemon dispatch belongs to DEP-011/worker-daemon.

---

# Slice 1 — the wire + a component round-trip

**Status:** Unit A design (2026-08-28, post-recon @ tip `0e4834a27`). 4-agent adversarial review applied
(§S1.10). Precondition satisfied: WRK-014 (container identity) + WRK-015 (POSIX enrolment input)
shipped, so a container can enrol; and this slice is the scope's explicit **component-level** exception
(driver ↔ server in an integration test, §8 wire-F5) — it does **not** dispatch through the daemon, so it
does not "wire against an unbuilt caller."

Slice 1 as scoped (§6/§8) is **L-sized and larger than its own naive read**: the F2 redaction rule touches
security-**authoritative** code (`cleanup-authority.ts`), and it turns on a decision §8 flagged but never
settled. So Slice 1 splits at a verified seam into two build-units. This section designs **Unit A** (the
CleanupAuthority-free plumbing) in full and scopes **Unit B** (the ownership fork + redaction) for its own
design→review — the same discipline the credential fork (§3.1) got.

## S1.0 Verified terrain (recon 2026-08-28 against tip `0e4834a27`; all §8 code-claims hold, 0 refuted)

- **The authoritative per-op port** is `interface SandboxProvider` — `packages/worker-daemon/src/supervisor/provider.ts:339-388`.
  NOT the conformance `SandboxProviderDriver` (`invoke(op,args)`, `sandbox-provider-contract/src/port.ts:149`),
  a demoted surface reached only via `perOpToInvokeDriver`. Do not design the wire against the invoke shape.
- **The op set.** `PROVIDER_OPERATIONS` = 11 (`worker-protocol/src/capabilities.ts:125-137`); the 8
  `CORE_PROVIDER_OPERATIONS` (`:142-151`) = `create/execute/cancel/kill/destroy/list/inspect/reconcile_cleanup`
  are Slice 1; the 3 optional (`checkpoint/restore/health`) are capability-gated, out of scope. **`execute`
  is a core op and belongs in Slice 1** — it is unary + byte-free, so it carries no streaming cost.
- **The provider + the mock.** `E2bSandboxProvider` (`sandbox-e2b-provider/src/e2b-provider.ts:136`)
  `implements SandboxProvider`; ctor takes `{transport}` (`:159`). `MockE2bTransport` EXISTS and is truly
  key-less (`sandbox-e2b-provider/src/mock-transport.ts:53-213`, factory `:226`), already the substrate of
  `conformance.test.ts:27-31` — so `new E2bSandboxProvider({ transport: new MockE2bTransport() })` is a
  proven, no-key construction. `RealE2bTransport` (the ONLY `E2B_API_KEY`/`e2b` reader — `real-transport.ts:53,:22`)
  is the Slice-3 swap; Slice 1 never touches it.
- **`execute` is byte-free** — opaque `stdoutRef`/`stderrRef` **synthesized from `sandboxId`**
  (`ref:stdout:${sandboxId}`), NOT captured-then-discarded: `execute` passes NO stream handlers to the
  transport (`e2b-provider.ts:215-259`, refs `:249-250`, no handlers at `:235`; "No customer bytes cross this
  boundary (E5)" ~`:248`). The property is airtight — the wire carries the refs, never bytes.
- **`ProviderOpContext`** = `{ deadlineMs: number; idempotencyKey: string }` (`provider.ts:180-183`, both
  non-optional). The provider short-circuits `deadlineMs <= 0` → `timedOut:true` (`e2b-provider.ts:224-233`):
  the **driver-owned zero-deadline verdict** (§3.4) the wire must preserve on the CLIENT side (short-circuit
  before the RPC), not round-trip.
- **`create`/`execute` shapes.** `create`: `CreateSandboxSpec{resourceLabels,command,args,env,workloadType}`
  (`:185`) → `CreateResult{sandboxId,providerOpId,resourceLabels}` (`:194`). `execute`:
  `ExecuteInput{sandboxId,command,args,env}` (`:200`) → `ExecuteResult{providerOpId,exitCode,signal,timedOut,stdoutRef,stderrRef}`
  (`:212`). Neither result is a sensitive projection — `create` echoes the caller's OWN labels; `execute` is
  byte-free.
- **`#idempotency` is in-memory** — `Map` keyed by `ctx.idempotencyKey` (`e2b-provider.ts:156`, read `:187`,
  write `:211`). Durability is a Slice-3 concern (§8 F3); Unit A's replay test must be **in-process only**.
- **Error vocab** (duck-typed by `.name`): `UnsupportedProviderOperation{.operation}` (`provider.ts:306`),
  `SandboxNotFoundError` (`:320`), `SandboxEgressDeniedError{.destinationClass}` (e2b-local `errors.ts:32`).
- **The worker-daemon import boundary** (`scripts/lib/worker-daemon-boundary.mjs:5-12`): `@armyofagents/worker-daemon`
  may import only `worker-protocol` + `pino` + Node built-ins + in-`src` relatives. **So the networked driver
  is injected from OUTSIDE worker-daemon** — exactly as the desktop provider is (`worker-keystore/src/bin/desktop-host.ts`
  injects `E2bSandboxProvider` via `deps.provider`) — never imported by the daemon. `AOA_WORKER_PROVIDER_URL`
  is present-but-dead (`scripts/d1-dispatch-expectation.json:17,25`); the live switch is `AOA_WORKER_SANDBOX_PROVIDER`.
- **Greenfield confirmed** — no `adapter-manager`/networked-driver/provider-client code anywhere in `packages/`.

## S1.1 The seam — the security axis is "needs a wire ownership gate," NOT "touches CleanupAuthority"

**The 3-agent review (S1.10-R1) refuted the first draft's axis.** Partitioning by "touches `CleanupAuthority`"
is a **false negative for `execute`** — the axis that matters is: *does this op need a server-side ownership
gate once it crosses the wire?* Partition the 8 core ops by THAT:

- **Gate-free — `create`.** It makes a NEW sandbox; the caller owns the result (`CreateResult` echoes the
  caller's OWN `resourceLabels`, `e2b-provider.ts:212`). Nothing to own-check.
- **Gate-REQUIRED, byte-free result — `execute`.** Its result is non-sensitive (opaque refs), but its
  ownership safety is **structural in-process and evaporates over the wire**: at the provider `execute` has
  NO ownership check — `EffectAuthority.execute` gates on the **active fence only, not the sandbox**
  (`effect-authority.ts:87-90,:78-80`), `CleanupAuthority` *denies* execute outright (`cleanup-authority.ts:130`),
  and the supervisor is today the sole caller, always on its **own** just-created id (`supervisor.ts:417`).
  Over the wire an untrusted worker crafts the `sandboxId` itself, so an ungated `execute` route is BOTH an
  existence oracle (run vs `SandboxNotFoundError`) AND a **cross-tenant code-execution** vector (run a command
  in another worker's sandbox) — strictly worse than the teardown/inspect oracle. It needs a server-side
  `#requireOwned`-equivalent before it faces >1 worker.
- **Gate-REQUIRED, sensitive result — `cancel/kill/destroy/reconcileCleanup`** (each gates through
  `#requireOwned`, `cleanup-authority.ts:219-231`) **+ `inspect`/`list`** (which return the sensitive
  `InspectResult`/`ResourceSummary` carrying raw labels + `env`, `:154-205`).

Every gate-required op forces the decision §8's F2 note offered two answers to but never settled: **where does
the ownership authority live in the networked topology?**

- **(P) Server-relocate.** The authority computes the owned/not-owned verdict AM-local (in-process, raw
  labels) and returns only a redacted projection + verdict; the untrusted worker holds no raw labels. Faithful
  to the boundary thesis, and — decisively — the **only** option that can gate `execute` server-side against a
  *misbehaving* worker. Cost: a security authority relocates, and the wire carries the authenticated worker
  identity so the server instantiates a per-worker authority.
- **(Q) Client-hash.** The authority stays on the worker; the wire returns
  `RedactedResourceProjection{…,resourceLabelsHash}` (`provider.ts:394`) and the check compares
  `hashResourceLabels(this.#resourceLabels)` (`provider.ts:158`) + generation instead of raw `labelsEqual`.
  Smaller relocation for teardown/inspect — **but it cannot gate `execute`** (a misbehaving worker would be
  checking itself). So `execute` on the gate-required side is a concrete argument for **(P)**.

All gate-required work edits security-authoritative `cleanup-authority.ts` and must preserve the
**existence-oracle collapse** (today `SandboxNotFoundError` and an owned-mismatch BOTH map to one
`ResourceNotAvailableError`, `cleanup-authority.ts:159,164`; a wire that round-trips `SandboxNotFoundError`
distinctly re-grants the "exists but not yours" oracle). This is a fork on the level of the credential
decision (§3.1) — its own design→review→sign-off.

**So the seam is PLUMBING vs the SECURITY GATE — not "CleanupAuthority-free vs gated":**

- **Unit A** builds the transport plumbing for `create` + `execute` — the whole serialization / network-hop /
  idempotency-replay / **error-vocab** de-risk (`execute` is the ONLY op that produces the domain error vocab
  over the wire, so it earns its place). Unit A's `execute` route ships **without an ownership gate** and is
  therefore **component-test-only / NOT deploy-safe** (S1.4) — admissible solely because Unit A's artifact is a
  single-tenant loopback vitest with no deploy, no daemon, no mTLS. It stands up no reachable oracle.
- **Unit B** settles the ownership fork (P/Q) and builds the server-side gate for **`execute` + the six
  gate-required ops** + redaction — its own reviewed unit, and the one that makes the server safe to face >1
  worker. It MUST land before Slice 3 (real multi-tenant) or Slice 5 (deploy).

Unit A de-risks everything Unit B builds on (does the wire work; does the error vocab survive) without gating
on the fork.

## S1.2 Unit A — components

1. **A new leaf `packages/adapter-manager/`** — the server. `createProviderServer({ provider })` mounts an
   HTTP listener; per request it routes a per-op path, deserializes `{args, ctx}`, calls
   `provider.<op>(args, ctx)`, and serializes `{ ok: result }` or `{ err: <coded> }`. Unit A wires only
   `create` + `execute` (+ `/healthz`, reuse the D1 healthcheck shape `docker-compose.d1.yml:388`). It hosts
   `new E2bSandboxProvider({ transport: new MockE2bTransport() })`. **★ Import via SUBPATHS, not the barrel**
   (review R4, landmine 7): `sandbox-e2b-provider`'s barrel (`index.ts:34`) statically re-exports
   `RealE2bTransport`, which `import`s the `e2b` SDK (`real-transport.ts:22`) — a barrel import drags `e2b`
   into Unit A's key-less closure and contradicts the S1.4 "no RealE2bTransport" fence at module scope. Import
   `E2bSandboxProvider` from `sandbox-e2b-provider/e2b-provider.js` and `MockE2bTransport` from
   `…/mock-transport.js` (the `worker-keystore/src/bin/sandbox-provider.ts:10-13` dynamic-import trap, avoided
   structurally). Each new package carries its own `package.json` with `build`/`typecheck` scripts (so `pnpm -r`
   reaches it); adapter-manager need NOT declare `e2b` if the subpath imports keep `real-transport` out of the
   closure — confirm in Step 0. **No mTLS/peer-allowlist/net-seg yet** — Slice-5 deploy hardening; NOTE in code
   that the real topology (`control-net`, mutual-auth, peer-allowlist) requires them.
2. **A shared, non-frozen wire package (`packages/provider-wire/`, NOT in `worker-protocol`)** — the
   per-op request/response envelopes + (de)serialization + the error-vocab codec, imported by BOTH the server
   and the driver. **The op-shapes are ALREADY exported** (review R3, verified): `@armyofagents/worker-daemon`
   re-exports `CreateSandboxSpec`/`CreateResult`/`ExecuteInput`/`ExecuteResult`/`ProviderOpContext` from its
   barrel (`index.ts:380-410`, deliberately so a downstream package can `implements SandboxProvider` without
   copying the shape). So the wire package just does `import type { … } from "@armyofagents/worker-daemon"` —
   zero worker-daemon edit, zero re-declaration drift. (The first-draft "add exports OR re-declare" fork is
   moot; and its "types don't count as runtime imports" rationale was imprecise — the worker-daemon boundary
   polices the specifier *target*, not type-ness. Irrelevant here because these are already-existing
   relative-inside-`src` re-exports, and the wire package is not under `worker-daemon/src` so the boundary
   never scans it.)
3. **The networked driver** — a class presenting the per-op `SandboxProvider` (Unit A implements `create`+`execute`;
   the other six throw the AUTHORITATIVE `UnsupportedProviderOperation` — the worker-daemon class at
   `provider.ts:306`, re-exported via `sandbox-e2b-provider/errors.ts`, NOT the same-named conformance-package
   copy at `sandbox-provider-contract/src/port.ts:133` — until Unit B). **`execute` (only)** applies the
   **driver-owned zero-deadline short-circuit** first (`deadlineMs <= 0` → the deterministic `timedOut`
   verdict, no RPC); **`create` does NOT** (review R2: `CreateResult` has no `timedOut` field; `create`
   substitutes `defaultTtlMs` via `#ttl`, `e2b-provider.ts:182-184` — it has no short-circuit to mirror). Each
   method then POSTs `{args, ctx}` and deserializes `{ok|err}`. Lives in `provider-wire` (outside worker-daemon),
   injected later by a container composition root (DEP-011) via `deps.provider` — so worker-daemon stays
   boundary-clean. Unit A uses Node's global `fetch`; NOTE the eventual daemon injection (DEP-011) must keep
   the daemon's import closure to Node built-ins (no `require`/`createRequire` bridge either — the boundary
   forbids it).
4. **A component integration test** (vitest, in-process, loopback HTTP): stand up the mock-backed server + the
   driver and exercise `create`/`execute` **over the wire** (not the provider directly — the novelty is the
   network hop: serialization, error mapping). Prove:
   - `create` round-trip (the spec's labels are echoed in `CreateResult`);
   - **create-idempotency replay** — two `create`s with the same `ctx.idempotencyKey` → the same `sandboxId`,
     **in-process only** (no server restart; cross-restart durability is Slice 3 — testing it here would look
     like a bug, landmine 6);
   - `execute` byte-free (opaque `stdoutRef`/`stderrRef`, no bytes on the wire);
   - the **zero-deadline verdict** (driver short-circuits, server never called);
   - the **error-vocab** — a mock-directed `create`/`execute` fault (via `mock-transport` directives) →
     the right error CLASS (`.name` + discriminant) survives the wire round-trip.

## S1.3 Unit A — TDD order (fail-first; write each RED test, confirm it fails for the right reason, then implement)

1. Wire codec: a `create` request/response serializes + round-trips (RED: no codec) → implement the envelope.
2. Server: `POST /op/create` → `provider.create` → `{ok:CreateResult}` (RED: no server) → implement the route.
3. Driver: `driver.create(spec, ctx)` posts + deserializes → `CreateResult` (RED) → implement; the
   integration test asserts the label echo end-to-end.
4. Idempotency replay (in-process): same key → same `sandboxId` (RED until create is wired through) → assert.
5. `execute`: byte-free round-trip + the zero-deadline short-circuit (assert the server is NOT hit when
   `deadlineMs<=0`, e.g. a fetch spy / a server call-counter) → implement.
6. Error-vocab: a directed transport fault → the mapped error class crosses (RED: naive JSON drops the class)
   → implement the error codec. Include a **negative** case: an unknown/garbled error payload maps to a
   generic wire error, never silently to success.
7. Mutation sweep (§5-style, per this programme): delete each codec/short-circuit guard, confirm a test
   kills it; mutate each OR-arm of the error-class discriminator individually (the "mutate each ARM"
   lesson, [[wrk-015-posix-validator]]).

## S1.4 Unit A — fences (what it is NOT)

- **★ Unit A's `execute` route has NO ownership gate and is NOT deploy-safe** (review R1). Admissible ONLY in
  the single-tenant loopback component test; it MUST NOT face >1 label-set (Slice 3) or any deploy (Slice 5)
  until the Unit-B `execute` ownership gate exists — an ungated `execute` over a reachable wire is an existence
  oracle + a cross-tenant code-execution vector (S1.1). Unit A builds `execute`'s PLUMBING, not its gate.
- **No ownership GATE, no `cleanup-authority.ts` change, none of `cancel/kill/destroy/reconcile/inspect/list`** —
  Unit B (which also adds `execute`'s gate).
- **No redaction** — `create`/`execute` results carry no sensitive projection (that is the point of the
  plumbing seam).
- **No real E2B, no `E2B_API_KEY`** — Slice 3. And **no `real-transport` in the closure** — a module-scope
  claim held by the SUBPATH imports (S1.2.1), which keep the `e2b`-loading module out of Unit A entirely.
- **No credential crossing** — Slice 4 (settled (i)).
- **No streaming** — deleted (execute byte-free; live output rides the frozen `event_upload` outbox).
- **No Docker image, no deploy, no mTLS/peer-allowlist/net-seg** — Slice 5. Unit A is a vitest component test,
  so it adds no `docker/images` `IMAGES` entry and does not trip `check-image-deps-stages`.
- **NOT through the daemon** — no `deps.provider` inject, no dispatch gate, no `AOA_WORKER_PROVIDER_URL`
  consumer, no new `AOA_WORKER_SANDBOX_PROVIDER` kind (all DEP-011).

## S1.5 Unit B — scoping (SUPERSEDED — Unit B is now fully designed at "# Slice 1 · Unit B" below; fork RESOLVED → A · signed capability)

> **Note:** the bullets below are the early Unit-A-era scoping. Unit B's real design is the `# Slice 1 · Unit B`
> section (B0–B10). In particular, "edit `cleanup-authority.ts:154-205` per the fork" is now a **B2** concern
> (under A, B1's execute gate leaves `cleanup-authority.ts` untouched — see the B1 cross-lane rule).

- **Settle the ownership fork (P server-relocate vs Q client-hash)** with a 3-agent adversarial review +
  human sign-off, as the credential fork got. **The fork must cover `execute`, not just teardown/inspect/list**
  (review R1): option (Q) cannot gate `execute` server-side against a misbehaving worker, so `execute`'s
  presence is a concrete argument for (P). It gates the wire shape and edits security-authoritative code.
- Build the server-side ownership gate for **`execute`** (resolve the authenticated caller's owned labels;
  refuse a non-matching `sandboxId` with the **uniform** `ResourceNotAvailableError`, preserving the collapse)
  **+ `cancel/kill/destroy/reconcileCleanup`** (ownership-gated) **+ `inspect`/`list`** returning
  **`RedactedResourceProjection`** ONLY (the `{sandboxId,resourceLabelsHash,generation,state,providerOpId}`
  shape at `provider.ts:394` — NOT the conformance `ProviderResourceProjection`/`PROVIDER_PROJECTION_KEYS`,
  a different surface; conflating them is a category error, landmine 2).
- **Preserve the existence-oracle collapse** across the wire for every gated op (owned-check first, uniform
  `ResourceNotAvailableError` out).
- The edit to `cleanup-authority.ts:154-205` (hash-based or AM-local) per the fork.
- **Slice-3 idempotency ledger namespaced by authenticated worker identity** (review R1 item-1) + verify the
  returned `resourceLabels` belong to the caller, so a replayed/forged `idempotencyKey` cannot echo another
  worker's `sandboxId` + raw labels.
- **Slice-5 ordering invariant** (review R1 item-4, [[checks-that-nothing-runs]]): a deploy test ASSERTS the
  `execute` route sits behind the ownership gate — a foreign-labeled `sandboxId` to `execute` yields the
  uniform not-available error — so "gate before deploy" is enforced, not assumed.

## S1.6 Guards (run the WHOLE set — the WRK-014 missed-guard lesson, [[checks-that-nothing-runs]])

- **★ Register the new package(s) in `vitest.config.ts` `projects[]`** (review R3+R4 — the HIGH catch). A new
  `packages/adapter-manager` (+ `packages/provider-wire` if it owns specs) with `*.test.ts` but absent from the
  root `projects[]` (`vitest.config.ts:24`, an explicit enumeration, NO glob) makes `check-execution-census`
  red (`vitest_project_missing` / `vitest_config_not_in_projects`, `execution-census.mjs:115-120,:135-139`) —
  and, worse, its tests **run nowhere** while a naive "tests pass" reads green (the [[checks-that-nothing-runs]]
  class). Give each new package its own `vitest.config.ts` AND append its path to root `projects[]`.
- The five registers: `check-ticket-graph-coverage` (the one `#### DEP-012` node suffices — R4 verified the
  regex parses `DEP-012-unit-a-result.md` → `{DEP-012}`), `check-finding-ownership`, `check-guard-inventory`,
  `check-gate-clause-wiring`, `check-execution-census` (see the registration above).
- `check-worker-daemon-boundary` — the new packages are OUTSIDE `worker-daemon/src`, so the guard never scans
  them, and worker-daemon gains no new import/export (the op-shapes are already exported, S1.2.2). Confirm it
  still passes (untouched).
- `check-test-inventory` — pin the new test files (bump via `--write`; do not over-reach into unrelated floor
  trees, the DSK-003 lesson).
- `check-boot-roots-provider-free` — verified NO action for Unit A: the guard scans only
  `worker-daemon/src/bin` + `worker-keystore/src/bin` for `bootstrapWorkerDaemon` (`:24-28,:44`);
  adapter-manager's server bin is in neither and names no such identifier. (DEP-011's container composition
  root WILL need a `boot-roots-expectation.json` entry — that is DEP-011, not Unit A.)
- **NOT** `check-image-deps-stages` and **NOT** the Dockerfile-static test — Unit A adds no image/Dockerfile
  (both fire at Slice 5). Note this explicitly in the result so a green run is not mistaken for coverage.

## S1.7 Acceptance (Unit A)

The driver ↔ server integration test is green: `create` round-trips with label echo; the same idempotency
key returns the same sandbox in-process; `execute` crosses byte-free; the zero-deadline verdict is
driver-owned (server not hit); and each Unit-A error class survives the wire (with a negative unknown-payload
case). No sensitive projection crosses (there is none in `create`/`execute` — assert the wire types contain
no `env`/`secrets`/`command`/`logs`). The full guard set is green. **`DEP-012-unit-a-result.md`** (unit-suffixed
so it does not collide with Unit B's future doc; the graph regex parses it to `DEP-012` — never a 3-digit
slice number after `012`) records Unit A + the mutation table + the Unit-B fork left open + every claim not
proven.

## S1.8 Status

Unit A design complete + **4-agent adversarial review applied (§S1.10)**, all verified against source: the
seam axis refolded (R1 — `execute` is gate-required), the vitest-`projects[]` registration (R3/R4), the
`e2b`-barrel subpath imports (R4), the zero-deadline `execute`-only scope (R2), and the
`DEP-012-unit-a-result.md` filename (R4) folded in. Unit B is scoped, not designed. The provider-topology
CONTRACT (§8) is settled and not re-opened; the ownership fork (P/Q) is a Unit-B decision this design
deliberately leaves open.

## S1.9 Open questions for the 3-agent adversarial review

1. **Is the A/B seam truly clean?** Does `create` returning its own `resourceLabels` count as a sensitive
   crossing (I claim no — the caller supplied them), and is `execute` genuinely CleanupAuthority-free at the
   provider level (verify no `#requireOwned` on the execute path)?
2. **Does deferring the ownership fork leave an Unit-A latent oracle?** `execute` against an unknown/foreign
   `sandboxId` → `SandboxNotFoundError`; round-tripping that distinctly — is it an existence oracle before
   ownership gating exists (Unit B), and if so must Unit A already collapse it or refuse cross-worker ids?
3. **Where do the wire schema + driver live** to keep worker-daemon boundary-clean AND avoid re-declaring the
   op shapes — does `@armyofagents/worker-daemon` export `CreateSandboxSpec`/`CreateResult`/`ExecuteInput`/`ExecuteResult`/`ProviderOpContext`
   today, or is a type-only export needed (and does it stay boundary-clean)?
4. **Is `packages/adapter-manager` the right home** for the server, or does a provider host belong elsewhere?
   Does adding it trip `check-execution-census` / `check-boot-roots-provider-free` / any register?
5. **Is the in-process idempotency-replay test honest** (no cross-restart) and does it actually exercise the
   WIRE (serialization + the network hop), not just the provider object?
6. **Does `check-ticket-graph-coverage` need a node per build-unit**, or is the one `#### DEP-012` node
   enough — and what must a `DEP-012-*-result.md` filename be so the guard parses the id correctly (the
   WRK-015 filename-id lesson)?

## S1.10 Review round — 4-agent adversarial pass (2026-08-28), all verified against source

**R1 — seam/oracle (the load-bearing catch).** The first-draft axis ("CleanupAuthority-free ⇒ safe to defer")
is a **false negative for `execute`**. `execute` is CleanupAuthority-free (`cleanup-authority.ts:130` denies
it) yet needs a server-side ownership gate — its in-process safety is purely structural (`EffectAuthority`
fence-only guard `effect-authority.ts:87-90` + the supervisor-calls-own-id invariant `supervisor.ts:417`),
which evaporates over the wire, making an ungated `execute` route an existence oracle + a cross-tenant
code-execution vector. Applied: S1.1 refolded to the wire-gate axis; S1.4 fences `execute` as
component-test-only/not-deploy-safe; S1.5 folds `execute` into the Unit-B fork (+ the Slice-5 ordering
invariant + Slice-3 ledger namespacing). Confirmed: Unit A stays safe to BUILD (loopback, single mock, no
deploy) — the gap is latent (Slice 3/5), not live in Unit A.

**R2 — terrain skeptic.** All 11 S1.0 claims re-derived from source, **0 refuted**. Caught (all applied): the
zero-deadline short-circuit is `execute`-ONLY (`create` has no `timedOut`, uses `defaultTtlMs`) — S1.2.3; name
the AUTHORITATIVE `UnsupportedProviderOperation` (worker-daemon `provider.ts:306`, not the conformance copy) —
S1.2.3; "stream discarded" tightened to the synthesized-refs wording — S1.0.

**R3 — architecture/boundary.** The injected-driver model (desktop precedent, `deps.provider`) and the
`packages/adapter-manager` home are boundary-safe. The op-shapes are **ALREADY exported** (`index.ts:380-410`)
so the export fork is moot — `import type` only (S1.2.2). HIGH: register the new package in `vitest.config.ts`
`projects[]` or its tests run nowhere (S1.6). `check-boot-roots-provider-free` confirmed NO-action for Unit A.

**R4 — completeness/tracking.** The ticket-graph regex `/^([A-Z]{2,5})-(\d{3})((?:-\d{3})*)/` parses
`DEP-012-unit-a-result.md` → `{DEP-012}` (one node suffices; avoid a 3-digit slice number) — S1.7. Landmine 7
(barrel drags `e2b`) → subpath imports (S1.2.1). The `#### DEP-012` node Acceptance ("no result doc until the
server lands") was stale → per-unit-result-doc wording (applied to `program-design.md`). **Slice-5
forward-notes** (for that author): do NOT reuse D1's `provider-ctl-net` semantics (`findings.md:36-46` — reuse
D1 hardening patterns only); adding `docker/adapter-manager/Dockerfile` needs new entries in
`check-image-deps-stages` `IMAGES` + `dockerfile-static.test`, or the image ships deps-unchecked; and the wire
SPEC lands in DEP-012 (provider-wire) while E6-F003 (worker-side consumption) stays owned by DEP-011.

---

# Slice 1 · Unit B — the ownership gate + redaction (the security unit)

**Status:** design (2026-08-28, post-recon + **fork DECIDED**). Ownership fork RESOLVED → **A · signed
capability** (founder sign-off 2026-08-28). Sub-sliced: this section designs **B1** (the capability +
`execute`'s server-side gate — the worst hole) in full and scopes **B2** (teardown + redaction). **4-agent
adversarial review applied (§B10)** — the capability reshaped hash→ordered-tuple (field-wise gate), made
mandatory/fail-closed, both collapse arms + symmetric codec, the mint-cost corrected, cross-lane framing fixed.
Precondition: Unit A shipped (the wire plumbing exists).

## B0 — the resolved fork (recon 2026-08-28, verified against source)

The first-draft "P vs Q" collapsed under recon. **Pure client-side Q is REFUTED:** it cannot gate `execute`
(fence-only at `effect-authority.ts:87-90`, denied by `cleanup-authority.ts:130`; a client-side check runs on
the worker *before* the request, so a misbehaving worker omits it and sends a foreign `sandboxId` the ungated
server runs — cross-tenant code exec), and it cannot collapse the existence oracle over the wire (the server
can't decide "found-but-not-yours" without the caller's labels). **So the gate is server-side — forced.**

The real trade was *how `adapter-manager` learns whose sandbox is whose*:
- **(A) Signed capability [CHOSEN].** The control plane mints a short-lived signed token binding the worker's
  own ordered label TUPLE; `adapter-manager` verifies ONE signature (control-plane public key) — no DB, no
  session keys. Proven-identity, unforgeable, keeps the credential host minimal, cleanly namespaces the
  idempotency ledger (Slice 3). *(The sane form of the original "P" — P-delegate.)*
- (B) Asserted owned-hash — **rejected**: authorizes on the worker *knowing* its own labels (defense-by-secrecy),
  sound only while raw labels never leak. Cheaper, fragile.
- (C) Relocate the full auth + tenant DB onto `adapter-manager` — **rejected**: imports the control-plane trust
  surface onto the isolated credential host, defeating the boundary.

**The identity crux (recon):** `adapter-manager` cannot know the caller's owned labels today — the wire is
`{args, ctx}` with zero identity (`provider-wire/src/codec.ts:41-44`), and it has no DB/session key by design.
The server CAN derive owned labels from an authenticated worker (`worker-fence-context.ts:120-134` builds an
`ActiveFenceRequest` — a SUPERSET from which the `ResourceLabels` tuple is derived) — but only inside a tenant DB
transaction behind a JWT + Ed25519 device-proof (`worker-operation-proof.ts:34-76`). A is the delegate form: the
control plane (which already holds the fence/labels) signs them into a capability; `adapter-manager` verifies
with just a public key. **The VERIFY is a cheap, DB-free ~15-line `node:crypto` check + a pure `labelsEqual`
(review R1 CONFIRMED — no auth-surface import); the MINT is the real cost — a NET-NEW control-plane Ed25519
keypair + provisioning/rotation (there is NO reusable control-plane signer; NOT "reuse"), deferred to
DEP-011/deploy. This mint delta does NOT flip A-vs-B (B saves only the keypair and keeps its secrecy weakness).**

## B0.1 — verified terrain (recon 2026-08-28)

- **`#requireOwned`** (`cleanup-authority.ts:154-167`): `inspect(sandboxId)` → `labelsEqual(detail.resourceLabels,
  #resourceLabels) && detail.generation === #targetGeneration` → full detail (never leaves the CleanupAuthority
  unredacted); `SandboxNotFoundError` OR mismatch → the **uniform** `ResourceNotAvailableError` (`:159,:164`). The per-worker
  "owned" state is the constructor's `#resourceLabels` + `#targetGeneration` (`:99-100`).
- **`ResourceLabels`** = `{organizationId, targetId, workerId, jobId, attempt, leaseId, deviceGeneration}`
  (`provider.ts:113-121`); `labelsEqual` is field-wise (`:131-141`); `hashResourceLabels` is an unsalted keyless
  SHA-256 over the tuple (`:158-169`).
- **`execute` is fence-only** (`effect-authority.ts:87-90`) — a server-side gate reuses `#requireOwned`'s
  inspect+compare AM-local (the provider exposes the target's raw labels + generation via `inspect`,
  `e2b-provider.ts:319-343`). The ONLY missing input is the caller's owned identity → the capability supplies it.
- **`RedactedResourceProjection`** = `{sandboxId, resourceLabelsHash, generation, state, providerOpId}`
  (`provider.ts:394-400`) — the shape `inspect`/`list` must cross as (B2).
- **The wire has NO identity slot** (`codec.ts:41-44`) and NO `ResourceNotAvailableError` in its vocab
  (`codec.ts:116-157`) — both are net-new in Unit B.
- **`cleanup-authority.ts` stays UNTOUCHED for B1** — under A the execute gate is NEW `adapter-manager` code. But
  `CleanupAuthority` is lane-AGNOSTIC (`supervisor.ts:528`, not just the desktop lane); B1 is clean only because
  `execute` bypasses it (fence-only `EffectAuthority`; `CleanupAuthority` denies execute, `:130`). B2's teardown
  coexistence still needs resolving — **landmine 6 DEFERS to B2, it does not dissolve** (see the cross-lane rule).

## B0.2 — sub-slice plan

Unit B is L-sized (net-new capability infra + 6 gated ops + redaction). It splits:
- **B1 (this design) — the capability + `execute`'s server-side gate.** Closes the WORST hole (cross-tenant
  code exec) and builds the shared security infra: the capability verify, the AM-local owned-check, the uniform
  wire error, the server-side oracle-collapse. Component-tested.
- **B2 (scoped, §B7) — the teardown ops + redaction.** `cancel/kill/destroy/reconcile_cleanup` gated (reuse
  B1's capability) + `inspect`/`list` redacted to `RedactedResourceProjection` server-side + `list` re-homing.

## B1 — what it builds

1. **The owned-labels capability** (a new `provider-wire` schema type). A signed token
   `{ v: 1, audience: "adapter-manager", ownedLabels: ResourceLabels, expiresAt, sig }` — it carries the caller's
   OWN ordered label TUPLE (not a hash), so the gate compares FIELD-WISE like `#requireOwned` (review R2: gating
   on the space-joined `hashResourceLabels` is a canonicalization bypass — two tuples with a space in a field
   collide; the hash was built for logging, not authz). The caller's own labels in a SIGNED token are no
   disclosure (F2 redaction concerns OTHER workers' labels via inspect/list). The `v` discriminant is MANDATORY
   forward-compat (review R4: B2 extends the capability with coarse identity for `list`; a bare canonical-struct
   signature is not additive-tolerant — version it now or every B1 token breaks at B2). Signed with a **NET-NEW
   control-plane Ed25519 keypair** (review R1: there is NO reusable control-plane signer — the session signer is
   symmetric HMAC, the device-proof signer is the WORKER's + transport-bound; author a fresh detached-Ed25519
   signer from the in-repo `node:crypto` primitives — `device-key.ts:61` `generateKeyPairSync("ed25519")`,
   `sign(null,·)`/`verify(null,·)`, the `device-proof.ts` canonicalizer pattern). **Unit B builds VERIFY + a TEST
   keypair only** — the real keypair + provisioning/rotation + the mint (in the fenced `resolveExecutionSecret`
   reply where JWT+device-proof-verified labels already exist, `secret-redemption.ts:160-187`) are DEP-011/deploy
   cost: real, deferred, and NOT "reuse."
2. **The verify path on `adapter-manager`** (a fresh ~15-line `node:crypto` fn, DB-free — review R1 CONFIRMED
   cheap + separable, no auth-surface import): load the pinned control-plane PUBLIC key once
   (`createPublicKey({format:"der",type:"spki"})`, assert `ed25519`); rebuild the canonical over ALL signed
   fields (`v`,`audience`,`ownedLabels`,`expiresAt` — an UNAMBIGUOUS serialization: length-prefixed or
   `JSON.stringify` of a fixed field order, NEVER a space-join); `verify(null, canonical, pub, sig)`; check
   `audience === "adapter-manager"` + `expiresAt > now`. Fail-closed (bad sig / expired / wrong audience →
   refuse) **BEFORE any provider call** — the ordering is load-bearing (review R2: a verify failure must be
   identical for own/foreign/not-found ids so it leaks nothing).
3. **`execute`'s server-side gate** — after verify, before dispatch: `provider.inspect(sandboxId)` AM-local (the
   server's in-process provider, NOT a wire op) → the target's raw labels + generation; then MIRROR
   `#requireOwned` FIELD-FOR-FIELD (`cleanup-authority.ts:154-167`): `labelsEqual(target.resourceLabels,
   cap.ownedLabels) && target.generation === cap.ownedLabels.deviceGeneration` → allow; **reproduce BOTH collapse
   arms** — a `SandboxNotFoundError` from `inspect` maps to the SAME uniform `ResourceNotAvailableError` as a
   label/generation mismatch (`:159` and `:164`), so a foreign-but-existing sandbox is indistinguishable from
   not-found. Collapse ALL `inspect` throws to the uniform error (review R2: `#requireOwned` rethrows non-NotFound
   at `:160`; over the wire a distinct transient-fault error is existence-orthogonal, but collapse it for
   airtightness — and keep `serializeError`'s verbatim `message` forwarding from leaking transport detail).
4. **The MANDATORY capability field + the uniform wire error.** The capability is a **first-class, REQUIRED**
   field on `OpRequestEnvelope` (`codec.ts:41-44`) validated in `decodeOpRequest` (`:65-76`); `execute` **REFUSES
   with the uniform error when it is absent or unverifiable — NEVER dispatches on absence** (review R2 the
   fall-open: today `decodeOpRequest` silently DROPS extra fields, so a gate that engages only when a capability
   is present is bypassed by a Unit-A-shaped envelope carrying none). Add `ResourceNotAvailableError`
   **SYMMETRICALLY** to `serializeError` AND `reconstructError` (`codec.ts:116-157`) — it is the authoritative
   worker-daemon class (`cleanup-authority.ts:65`) already re-exported from the codec's existing import site
   (`@armyofagents/sandbox-e2b-provider/errors.js:20`); miss the `reconstructError` case and it silently degrades
   to `WireProtocolError` on decode, breaking the uniform error.
5. **The driver carries the capability** — sourced OUT-OF-BAND (the port `execute(input, ctx)` has no capability
   slot, `provider.ts:347`; inject via the driver constructor/config, NOT the `EffectAuthority` caller). The
   capability is an **OPTIONAL** envelope field so `create`'s `{args, ctx}` stays byte-identical (Unit A's 17
   tests green): `create` omits it (gate-free), `execute` requires it. B2 attaches it to the gated ops.
6. **The component test** — mints a TEST capability (test keypair); proves: own-sandbox `execute` allowed;
   **foreign-sandbox `execute` → uniform `ResourceNotAvailableError`, byte-identical to not-found (the
   oracle-collapse), transport NOT hit** (a spy — gate before dispatch); **MISSING capability → REFUSED (the
   fall-open guard), not dispatched**; bad-sig / expired / wrong-audience → refused; the no-sensitive-crossing
   assertion extended (the capability carries the caller's OWN labels — signed, non-secret — never another's).

## B1 — where things live + the cross-lane rule (review R4 — corrected)

- The capability schema lives in `provider-wire` (shared); the verify + gate live in `adapter-manager`.
- **`cleanup-authority.ts` is UNTOUCHED FOR B1 — but this is B1-scoped, not a general claim.**
  `CleanupAuthority` is constructed LANE-AGNOSTICALLY (`supervisor.ts:528`, wrapping `deps.provider` every run) —
  the networked lane does NOT bypass it. B1 is safe because `execute` routes through the fence-only
  `EffectAuthority` (`supervisor.ts:417`, `effect-authority.ts:87-90`) and `CleanupAuthority` *denies* execute
  outright (`cleanup-authority.ts:130`) — so B1's execute gate is genuinely net-new `adapter-manager` code and
  the worker-side execute path is unchanged. **This does NOT generalize to B2:** `#requireOwned` needs a FULL
  `InspectResult` (raw labels for `labelsEqual`, `:162`) the F2 redacting wire will NOT carry — so B2/DEP-011
  must EITHER edit `cleanup-authority.ts` to hash-compare via the `resourceLabelsHash` getter (`:110-112`) OR
  change the networked supervisor composition so teardown does not re-check ownership worker-side. (This
  supersedes S1.5's bare "edit `cleanup-authority.ts:154-205` per the fork" — under A that edit is a B2 concern,
  not B1; **landmine 6 DEFERS to B2, it does not dissolve.**)
- The control-plane keypair + real mint are DEP-011/deploy — B1 is verify-only + a test mint (the
  component-level posture Unit A used).
- **Decision #104:** the capability carries owned LABELS (the caller's own identity) + expiry, never a
  provider/model key or a redeemed secret; the codec must not log the `sig`.

## B1 — TDD (fail-first)

1. Capability schema + a test signer/verifier: sign→verify round-trips over the canonical of ALL fields; a
   tampered field (any of `v`/`audience`/`ownedLabels`/`expiresAt`) fails verify (RED: no verify).
2. `adapter-manager` verify: valid → `ownedLabels`; bad-sig / expired / wrong-audience → refuse (RED).
3. Codec: `ResourceNotAvailableError` round-trips SYMMETRICALLY (encode→decode preserves the class) (RED: decode
   maps it to `WireProtocolError`); the capability is a REQUIRED envelope field (`decodeOpRequest` rejects an
   `execute` request carrying none) (RED: extras silently dropped).
4. `execute` gate — own sandbox: capability `ownedLabels` `labelsEqual` the created sandbox → allowed (RED).
5. `execute` gate — foreign sandbox: `ownedLabels` ≠ target labels → uniform `ResourceNotAvailableError`,
   transport NOT hit (spy) (RED).
6. `execute` gate — MISSING capability → refused with the uniform error, NOT dispatched (the fall-open guard)
   (RED).
7. Oracle-collapse: foreign-existing, genuinely-not-found, AND a non-NotFound inspect fault all yield the SAME
   `ResourceNotAvailableError`, byte-identical (RED: distinct errors) → the server-side collapse.
8. Mutation sweep: mutate EACH gate/verify clause individually (labelsEqual, generation, expiry, audience,
   sig-verify, the missing-capability guard, EACH collapse arm) → a test kills each ("mutate each arm",
   [[wrk-015-posix-validator]]).

## B1 — fences (what it is NOT)

- **No real control-plane mint + no real keypair** — B1 verifies + tests with a test-minted capability; the real
  keypair/provisioning/rotation + the mint are DEP-011/deploy.
- **No teardown ops, no redaction** — `cancel/kill/destroy/reconcile/inspect/list` stay throwing
  `UnsupportedProviderOperation` (Unit A's state) → B2.
- **`cleanup-authority.ts` + worker-daemon UNTOUCHED FOR B1** — the execute gate is new `adapter-manager` code
  (see the cross-lane rule; the B2 teardown coexistence is B2/DEP-011's, not B1's).
- **★ The `execute` gate is NOT atomic with dispatch (TOCTOU) — a Slice-3 must-fix, not live in B1** (review R2).
  `inspect` then `execute` is check-then-act across two round-trips. Against the mock it is safe (ids are
  monotonic, never reused — `mock-transport.ts:81-83`; labels are immutable-at-create, no relabel path; a
  re-lease mints a NEW id, orphaning the old with its original labels). The residual is real-provider `sandboxId`
  REUSE (validated-as-mine, destroyed, reassigned to a foreign tenant before dispatch): B1 STATES the
  id-non-reuse assumption; closing it (provider-atomic compare-and-execute, or a per-`sandboxId` lease/lock, or a
  proven non-reuse invariant) + the §S1.5 Slice-5 ordering assertion (foreign id → uniform error) is a Slice-3
  must-fix.
- **No mTLS/peer-allowlist/net-seg** — Slice 5. A transport peer check ≠ the application-layer capability.
- **No real E2B** — MockE2bTransport (Slice 3 swaps it).
- **NOT through the daemon** — component-level (DEP-011).

## B2 — scoping (its own design→review, at B2 sprint start)

- `cancel/kill/destroy/reconcile_cleanup` gated (reuse B1's capability + the AM-local owned-check + the uniform
  error + the collapse).
- `inspect`/`list` return `RedactedResourceProjection` ONLY, redacted server-side (the full `InspectResult` /
  raw `ResourceSummary` never cross); `list`'s `ownershipSelector` needs the caller's COARSE identity
  (`organizationId/targetId/workerId`) — so B2 EXTENDS the capability to carry those (a NEW `v:2`, additive over
  B1's ordered `ownedLabels`; the `v` discriminant B1 mandates makes this a clean bump, not a break).
- **★ Resolve the worker-side `CleanupAuthority` coexistence (review R4):** under A the networked lane's teardown
  either edits `cleanup-authority.ts:154-205` to hash-compare (`resourceLabelsHash` getter `:110-112`) OR changes
  the networked supervisor composition so teardown does not re-check ownership worker-side (the server gate is
  authoritative). B2/DEP-011's decision — its own design→review.
- Apply the uniform-`ResourceNotAvailableError` collapse to every gated op.
- Slice-3 idempotency ledger namespaced by the capability's authenticated identity.

## B8 — guards (run the WHOLE set)

- B1 extends `provider-wire` + `adapter-manager` (NO new package) → **no new `vitest.config.ts` `projects[]`
  entry and no new root-`Dockerfile` deps-stage `COPY`** (the Unit-A CI-miss lesson applies only to a NEW
  package — R4 CONFIRMED both packages already in `vitest.config.ts:24` + `Dockerfile:72-73`). The five
  registers + `check-worker-daemon-boundary` (untouched — assert) + `check-sandbox-e2b-provider-boundary` +
  `check-test-inventory` (B1 adds NEW test files → an inventory `--write` re-pin IS required; do not over-reach,
  the DSK-003 lesson) + `check-boot-roots-provider-free`. NOT `check-image-deps-stages` / `dockerfile-static`
  (no image). **But re-run the inline `policy` "Validate Dockerfile deps stage" mentally** — it only fires for a
  new package, which B1 does not add.

## B9 — open questions for the 3-agent adversarial review

1. **The capability format + the SPECIFIC signer** to reuse (the Ed25519 device-proof signer? the session-JWT
   signer?) — verifiable by `adapter-manager` with just a public key, WITHOUT importing the control-plane auth
   surface? Is a compact detached-signature-over-a-canonical-struct feasible with the existing infra?
2. **Granularity** — per-request capability (stateless server, simplest) vs per-connection handshake (fewer
   bytes, needs connection state). B1 proposes per-request; is that sound for the real transport?
3. **TOCTOU** — `inspect(sandboxId)` then `execute`: can the target's labels/generation change between the check
   and the dispatch (a re-lease / generation bump) such that a stale-but-valid capability executes in a
   now-foreign sandbox? Does the check need to be atomic with dispatch?
4. **Oracle-collapse airtightness** — does ANY error path (transport fault, egress-denied, a capability-verify
   failure) leak existence distinct from `ResourceNotAvailableError`? Enumerate every server response for a
   foreign vs not-found vs own sandbox.
5. **Regression** — does adding `ResourceNotAvailableError` to the codec + the capability field break Unit A's
   17 tests or the no-sensitive-crossing (the capability carries a HASH + generation — confirm no raw labels /
   no secret)?
6. **Is the hash-only capability strong enough** — `hashResourceLabels` is unsalted keyless SHA-256; the
   capability's unforgeability rests on the SIGNATURE (not the hash's secrecy), so a known hash is fine. Confirm
   the signature is what gates, and a replayed capability is bounded by `expiresAt` (+ audience).

## B10 — Review round — 4-agent adversarial pass (2026-08-28), all verified against source

**R1 — capability feasibility (the crux, protecting the A decision).** CONFIRMED A's core premise: the VERIFY is
a cheap, DB-free ~15-line `node:crypto` Ed25519 check + a pure label compare, importable into `adapter-manager`
with no new dep and no auth-surface/DB reach (guard-enforced). REFUTED the "reuse the existing signer" language:
there is NO reusable control-plane signer (session = symmetric HMAC; device-proof = the worker's, transport-bound)
— A needs a NET-NEW control-plane Ed25519 keypair + provisioning, deferred to DEP-011/deploy. Verdict: **A stands**
(the mint delta does not flip A-vs-B). Applied: B0 mint-cost corrected; B1 item 1 net-new-keypair language + the
in-repo primitives to author the signer.

**R2 — gate security (the hardening).** Directionally sound (forgery + replay denied, collapse achievable), with
real must-fixes, all applied: (1) the space-joined `hashResourceLabels` gate is a canonicalization BYPASS →
capability now carries the ORDERED TUPLE, gate is FIELD-WISE `labelsEqual` (B1 items 1/3); (2) missing-capability
FALL-OPEN (the codec drops extras) → capability MANDATORY, `execute` refuses on absence (B1 item 4); (3) both
collapse arms (`SandboxNotFoundError` → uniform) + collapse ALL inspect throws (B1 item 3); (4)
`ResourceNotAvailableError` SYMMETRIC in `serializeError` + `reconstructError` (B1 item 4); (5) TOCTOU — not live
in B1 (mock ids monotonic, labels immutable), the real-provider id-reuse residual stated + deferred to Slice 3
(B1 fences); (6) pin the signed struct — every field inside the sig (B1 item 2).

**R3 — terrain.** All 7 terrain claims CONFIRMED. The two-generations question resolved (`InspectResult.generation`
is derived from `deviceGeneration`, so the field-wise gate is faithful); `cleanup-authority.ts`-untouchable
verified via the export chain (`ResourceNotAvailableError`/`hashResourceLabels`/`labelsEqual` all already
exported; the error flows through the codec's existing import site). Applied the two wording tightenings
(never-leaves→unredacted; 1:1→superset). The hash-canonicalization note dissolved by R2's field-wise fix.

**R4 — scope/cross-lane.** CONFIRMED B1's sub-slice coherence (the gate uses in-process `provider.inspect`, no
B2 wire op) + the guards (both packages already registered from Unit A → no new `projects[]`/Dockerfile COPY).
Two must-fixes applied: (1) the "cleanup-authority untouched" framing over-reached — `CleanupAuthority` is
lane-AGNOSTIC (`supervisor.ts:528`), so B1's claim is B1-scoped and landmine 6 DEFERS to B2 (B0.1 + cross-lane
rule + B2 corrected; S1.5 reconciled); (2) capability VERSIONING — a `v` discriminant added now so B2's
coarse-identity extension is a clean `v:2` bump (B1 item 1). Nice-to-haves folded: out-of-band capability
injection + the optional envelope field (item 5), the `check-test-inventory` re-pin (B8).

---

# Slice 1 · Unit B2 (Wave α) — the teardown ops + redaction (the rest of the gated wire)

**Status:** design (2026-08-29, post-recon + **fork DECIDED → compose**, founder sign-off). Builds on the
SHIPPED Unit B1 (the signed-capability `execute` gate). Scope: the 6 remaining gated ops' **server-side
mechanism** — the 4 teardown ops + redacted `inspect`/`list` — component-tested (driver↔server), parallel to
B1. On `v:1`. **4-agent adversarial review applied (§B2.9)** — the gate collapse rule corrected (surface transients,
fixing a teardown sandbox-leak), exhaustive fail-closed routing, the compose rationale fixed to vacuity,
redaction/synthesis hardened. **This is the first WAVE** — one design → one review → one §9 → one build session
covering ~6 ops.

## B2.0 — the resolved fork + the recon findings (2026-08-29, verified against source)

**The CleanupAuthority-coexistence fork RESOLVED → (compose)** (founder sign-off). The recon proved (edit) —
hash-comparing in `cleanup-authority.ts` — is NOT localizable: the desktop and networked lanes feed
`#requireOwned` (`cleanup-authority.ts:154-167`) DIFFERENT shapes (desktop: raw `InspectResult.resourceLabels`,
no hash — `e2b-provider.ts:330-342`; networked: `RedactedResourceProjection` with only a hash). A literal
`resourceLabelsHash` compare **denies ALL desktop teardown** (`:162` fails → containment breaks), and making it
clean forces the authoritative port `inspect()` (`provider.ts:352`) to redacted-only — which **collides with
B1's shipped gate** (deliberately field-wise per R2, `execute-gate.ts:84`) + the conformance adapter
(`per-op-adapter.ts:216,375`). **(compose)** — the networked lane injects a `CleanupAuthority` variant that
trusts the authoritative server gate, leaving the shared authority, the port, the desktop lane, and B1 all
UNTOUCHED. **★ Why the worker-side check is redundant (review R4 — the PRECISE reason, correcting the "different
shapes" wording above):** under B2's driver `InspectResult` synthesis (B2.2 item 5) the networked lane feeds
`#requireOwned` a FULL `InspectResult` whose `resourceLabels` the driver built FROM `cap.ownedLabels` — so
`labelsEqual(detail.resourceLabels, this.#resourceLabels)` tautologically PASSES (own-vs-own), and a genuinely
foreign id is denied by the SERVER first. The worker-side check is **VACUOUS**, not shape-incompatible. **★
DEP-011 must build the compose variant as a no-op/trust — NOT a `resourceLabelsHash` compare** (the synthesis
makes that unnecessary and wrong).

**★ The fork's IMPLEMENTATION is DEP-011's, not B2's.** The coexistence is only *exercised* when the daemon
composes the networked lane (`CleanupAuthority` is constructed lane-agnostically at `supervisor.ts:528` +
`startup-reconcile.ts:418`, wrapping `deps.provider`). Wave α is component-level (driver↔server) and never runs
through the supervisor, so **B2 builds the server-side mechanism; the worker-side variant + its factory seam
(`deps.makeCleanupAuthority ?? …`, boundary-clean) land in DEP-011** — the same split B1 used for the daemon
inject.

**★ The reconcile orphan-sweep — a genuine DEP-011 decision, NOT B2's (recon landmine 1).** `reconcile.ts:85` +
`startup-reconcile.ts:349` call `deps.provider.list()` DIRECTLY (bypassing `CleanupAuthority`) and consume
`summary.hasLiveLease` + raw labels + `summary.state` — NONE of which `RedactedResourceProjection`
(`provider.ts:394-400`) carries — then `reconcileCleanup()` across a COARSE scope (multiple jobs/leases) a
single-`ownedLabels` `v:1` capability cannot authorize. So the networked `list` has TWO incompatible consumer
shapes (redacted single-resource for CleanupAuthority; raw coarse-summary for reconcile). Neither fork resolves
it — it is "does the networked worker run its own reconcile, or delegate to a server-side reaper?" **Deferred to
DEP-011.**

**★ `v:1` is SUFFICIENT for B2 (recon Q2).** `v:1`'s `ownedLabels` already carries the coarse identity
(`organizationId/targetId/workerId`, `capability.ts:43-49`) the narrow `CleanupAuthority.list` selector needs
(`cleanup-authority.ts:193-198`), and the fine `labelsEqual` filter (`:203`) derives from the same tuple. `v:2`
is forced ONLY by coarse-scope enumeration (the reconcile case above) — deferred with it.

## B2.1 — verified terrain (recon 2026-08-29)

- **The 4 teardown ops** (`cancel/kill/destroy/reconcile_cleanup`) each gate through `#requireOwned` then
  dispatch, returning NON-sensitive results (`cancel/kill`→`StopResult`, `destroy/reconcileCleanup`→`CleanupResult`,
  `provider.ts:221-229`, `cleanup-authority.ts:218-233`). Over the wire each = B1's `gateExecute` EXACTLY (verify
  → AM-local `inspect` → collapse-all-throws → field-wise owned-check → dispatch), differing only in the
  dispatched method — so B2 = **generalize `gateExecute` over the op fn + 4 thin wrappers**.
- **The redaction** — `#redact` (`cleanup-authority.ts:169-183`) = `{sandboxId, resourceLabelsHash:
  hashResourceLabels(labels), generation, state, providerOpId}`. The server hosts the provider so it has the
  full `InspectResult`/`ResourceSummary` AM-local (`e2b-provider.ts:319-343,:300-316`); it redacts server-side
  exactly as `#redact` (import `hashResourceLabels` from `@armyofagents/worker-daemon`, the B1 pattern). **No new
  codec path** — `encodeOkResponse` is result-agnostic `JSON.stringify` (`codec.ts:104-106`); a redacted
  projection serializes with zero new code.
- **The redacted `CleanupAuthority.inspect` has no production caller** (test-only); **`list`** feeds
  `escalateCleanup` (`supervisor.ts:262`, uses only `.sandboxId`). (The RAW `provider.inspect` DOES have prod
  callers — `#requireOwned`, B1's gate — so B2's AM-local-inspect-then-redact plan is already PROVEN in
  production, review R3.) No production code reads the sensitive `InspectResult` fields — they exist solely to
  make redaction non-vacuous (`provider.ts:253-258`).
- **The driver** holds `#capability` (`driver.ts:78`), attaches it via `#post` (`:151-166`, `op` typed
  `"create"|"execute"` — widen); the 6 methods currently throw `UnsupportedProviderOperation` (`:112-129`).
- **★ Port-type divergence (recon landmine 5):** `NetworkedProviderDriver implements SandboxProvider`
  (`driver.ts:67`), but the port's `inspect(): Promise<InspectResult>` / `list(): Promise<ListResult>`
  (`provider.ts:351-352`) cannot be honored over the redacting wire. B2 must decide how the driver satisfies the
  port type — see B2.2 item 4.

## B2.2 — what it builds

1. **A generalized owned-op gate** — refactor B1's `gateExecute` into `gateOwnedOp(deps, sandboxId, ctx,
   capability, dispatch)`: verify capability (fail-closed) → `provider.inspect(sandboxId)` AM-local → **the
   inspect-catch MIRRORS `#requireOwned` EXACTLY** (`cleanup-authority.ts:158-161`): `SandboxNotFoundError` → the
   uniform `ResourceNotAvailableError`; **any OTHER inspect fault (transient/non-NotFound) is RETHROWN as its own
   class, NOT collapsed.** ★ This CORRECTS B1's shipped `execute-gate.ts:78-80` collapse-ALL (review R1): for the
   IDEMPOTENT teardown ops, collapsing a TRANSIENT to `ResourceNotAvailableError` makes `CleanupAuthority.converge`
   (`cleanup-authority.ts:300-301`) read it as "vanished → success" and LEAK the sandbox; a transient is
   existence-orthogonal, so surfacing it distinctly stays oracle-safe. Then the field-wise owned-check —
   `labelsEqual(detail.resourceLabels, cap.ownedLabels) && detail.generation === cap.ownedLabels.deviceGeneration`
   (**BOTH** clauses — review R3, matching `cleanup-authority.ts:203` + B1's gate) → `dispatch()` on the allow
   path. **`dispatch()` stays OUTSIDE the inspect-collapse `try`** — a dispatch-path fault (egress-denied,
   mid-flight not-found) propagates as ITS OWN class; only the OWNERSHIP decision collapses (review R1 — B1's
   tests never asserted this; B2.4 adds it). `execute` becomes `gateOwnedOp(…, () => provider.execute(input,ctx))`;
   the collapse refinement changes execute's transient-inspect behavior (transient → surfaced, not RNA) — verified
   oracle-safe, no B1 test asserts it.
2. **The 4 teardown ops on the server** — `cancel/kill/destroy/reconcile_cleanup` via `gateOwnedOp(…, () =>
   provider.<op>(sandboxId, ctx))` (non-sensitive `StopResult`/`CleanupResult`). **`destroy` is dual-authority**
   (`EffectAuthority.destroy` happy-path + `CleanupAuthority.destroy` escalation) — uniform server gating is
   correct (the server can't tell which authority dispatched) and does NOT regress the happy path (review R1: a
   happy-path destroy is owned exactly when execute is; a refusal at `supervisor.ts:492` safely escalates). The
   ASYMMETRY — the escalation caller (`cleanup-authority.ts:300`) reads a refusal as success — is handled by item
   1's surface-transients rule + recorded for DEP-011 (B2.6).
3. **`inspect` (redacted)** — `gateOwnedOp` owns-checks by fetching the detail; the inspect route RETURNS
   `redact(that ALREADY-FETCHED detail)` — NEVER `provider.inspect` raw, NEVER the full detail (review R2: a naive
   `dispatch = () => provider.inspect` leaks on the allow path). **`list` (scoped + redacted)** — a DISTINCT
   pattern: verify → `provider.list({ownershipSelector: <coarse fields of cap.ownedLabels>})` AM-local → filter
   **`labelsEqual(r.resourceLabels, cap.ownedLabels) && r.generation === cap.ownedLabels.deviceGeneration`** (BOTH
   clauses, review R3) → `redact` each → `RedactedResourceProjection[]`. Narrow single-tuple list (own resources
   only); coarse-scope enumeration is the deferred reconcile/`v:2` case.
4. **★ EXHAUSTIVE fail-closed routing (review R1+R2 — load-bearing).** On a GATED server (a `controlPlanePublicKey`
   is pinned) EVERY gate-required op — `execute` + the 4 teardown + `inspect`/`list` — routes THROUGH the gate;
   there is **NO raw `handler` fallback reachable for any of them.** The current `op === "execute" && gated ? gate
   : handler` (`server.ts:110-118`) must widen to route ALL gated ops, else a `cancel`/`inspect` on a gated server
   falls through to a raw handler → ungated dispatch / unredacted `env`+`secrets` over the wire. The 5 NEW ops have
   **NO Map handler at all** — on an UNGATED (keyless) server they `404` ("operation not available",
   `server.ts:99-104`), NEVER a raw `provider.inspect`/`list`. Only `execute` keeps its keyless-ungated handler
   (Unit A back-compat). So `inspect`/`list` can NEVER return raw over the wire, gated or keyless.
5. **The 6 driver methods + the port-type synthesis.** Implement the 6 (attach capability, POST, deserialize).
   `inspect`/`list` satisfy the port by SYNTHESIZING a port-shaped result from the caller's OWN labels
   (`cap.ownedLabels`) + the server's redacted projection: `InspectResult{resourceLabels: cap.ownedLabels, state
   + generation FROM THE PROJECTION (never invented — review R2), sandboxId, providerOpId, EMPTY sensitive
   fields}` (F2-clean — own labels only). **`list` → `ResourceSummary[]` must ALSO synthesize `hasLiveLease`**
   (faithfully `proj.state === "running"`, matching `e2b-provider.ts:308`) + `nextPageToken` — NOT a hardcoded
   default (review R2/R4): no B2 consumer reads `hasLiveLease` (`escalateCleanup` uses only `.sandboxId`), but a
   fabricated value would mislead DEP-011's reconcile consumer — recorded in B2.6.
6. **The component test** (runs on a GATED server, like B1's gate tests) — for all 6 ops: OWNED → dispatch + the
   right result; FOREIGN → uniform error, NOT dispatched (spy); MISSING capability → refused (fail-closed);
   **`inspect`/`list` wire bytes carry NO raw labels / sensitive fields** (assert the serialized bytes); `list`
   returns only the caller's own resources (a mixed-owner mock); **★ an ALLOW-PATH dispatch fault** (owned-check
   passes, then `provider.<op>` throws egress-denied/transient) → the ORIGINAL class crosses, NOT the uniform
   error (review R1); a **transient INSPECT fault** → surfaced distinctly, NOT collapsed; and on an UNGATED server
   the 5 new ops `404`.

## B2.3 — where things live + the cross-lane rule

- All new code is `adapter-manager` (the gate generalization + the 6 op handlers + the redaction helper) +
  `provider-wire` (the 6 driver methods + widen `#post`). **`cleanup-authority.ts` + worker-daemon + the port
  UNTOUCHED** (the compose fork keeps them so; assert in the result, as B1). The redaction imports
  `hashResourceLabels` from `@armyofagents/worker-daemon` (already exported, the B1 pattern).
- The **coexistence direction is (compose)** — RECORDED here; the worker-side variant + the `deps.makeCleanupAuthority`
  factory seam are **DEP-011** (where the networked lane is composed). B2 does not touch the supervisor.
- Capability stays **`v:1`** (out-of-band injection on the driver, per B1; now attached to all 6 gated ops).

## B2.4 — TDD (fail-first; the wave builds ~6 ops in one session)

1. Refactor `gateExecute` → `gateOwnedOp`; **the inspect-catch mirrors `#requireOwned` (`SandboxNotFoundError` →
   uniform; RETHROW others)** + `dispatch()` OUTSIDE the collapse-try (RED: refactor); re-run B1's gate tests GREEN.
2. Each teardown op — own-sandbox dispatch (RED per op) → wire through `gateOwnedOp`.
3. Each teardown op — foreign-sandbox → uniform error, NOT dispatched (spy) + missing-capability refused (RED).
4. **★ Allow-path dispatch fault** (execute + each teardown): owned-check passes, then `provider.<op>` throws
   egress-denied/transient → the ORIGINAL class crosses, NOT the uniform error (RED — B1 never tested this).
5. **★ Transient INSPECT fault** → surfaced distinctly (not collapsed), so a teardown converge would retry (RED).
   (Needs the mock to direct a non-NotFound inspect fault — confirm reachable in Step 0.)
6. `inspect` — owned → redact the ALREADY-FETCHED detail; the wire bytes carry no raw labels / sensitive fields (RED).
7. `list` — scoped query with BOTH filter clauses → only the caller's own resources, each redacted; foreign
   resources excluded (mixed-owner mock) (RED).
8. Driver — the 6 methods over the wire; `inspect`/`list` return the port-satisfying synthesized shape (`state` +
   `generation` FROM the projection; `hasLiveLease = state==="running"`) (RED).
9. **★ Exhaustive routing** — GATED server + a teardown/inspect/list request with NO capability → uniform refusal,
   NOT dispatched; UNGATED server + the 5 new ops → `404` (never raw); `execute` keeps its keyless handler (RED).
10. Mutation sweep — the gate's clauses (the `SandboxNotFoundError`-vs-rethrow arm, BOTH owned-check clauses, the
    capability-required guard, the redaction — assert no sensitive field survives) → a test kills each.

## B2.5 — fences (what it is NOT)

- **The worker-side coexistence IMPLEMENTATION is DEP-011** — B2 records the (compose) direction; it does NOT
  build the `makeCleanupAuthority` seam or the networked variant, and does NOT touch `supervisor.ts` /
  `startup-reconcile.ts` / `cleanup-authority.ts`.
- **The reconcile orphan-sweep coexistence is DEP-011** (does the networked worker reconcile, or a server-side
  reaper?) — B2's `list` is the NARROW single-tuple list only; coarse-scope enumeration is deferred.
- **`v:2` is deferred** — `v:1` suffices for B2; `v:2` ships with the coarse-scope/reconcile case.
- **No real E2B** (MockE2bTransport, Slice 3), **no mTLS/deploy** (Slice 5), **no real mint** (DEP-011/deploy),
  **NOT through the daemon** (component-level), **no TOCTOU fix** (Slice 3, stated by B1).

## B2.6 — what DEP-011 inherits from B2 (the recorded decisions)

- Coexistence = **(compose)**: inject a networked `CleanupAuthority` variant (worker-side `#requireOwned` a no-op
  trusting the server gate) via a new `deps.makeCleanupAuthority` factory seam at `supervisor.ts:528` +
  `startup-reconcile.ts:418` (boundary-clean).
- The reconcile orphan-sweep shape (networked-worker reconcile vs server-side reaper) + `v:2` coarse-scope
  capability — DEP-011's call. **★ Over the networked gate `reconcile_cleanup` INVERTS its idempotent semantics
  (review R1):** in-process an already-gone teardown returns `CleanupResult{cleanupStatus}` (never throws,
  `e2b-provider.ts:282-295`), but the gate turns an already-gone id into a thrown `ResourceNotAvailableError`,
  and `reconcile.ts:93`'s un-guarded direct call would ABORT the whole sweep on such a throw. DEP-011's reconcile
  design must guard the direct calls and must NOT read a redacted `list`'s synthesized `hasLiveLease` (`=
  state==="running"`, review R2 — fabricated; no B2 consumer reads it, a reconcile consumer would) as
  authoritative.
- **★ The teardown escalation asymmetry (review R1):** the happy-path `destroy` caller (`supervisor.ts:509`)
  safely escalates on a gate refusal, but `CleanupAuthority.converge` (`cleanup-authority.ts:300`) reads the same
  refusal as "vanished → success". B2's item-1 rule (surface transients; only genuine not-found/mismatch →
  uniform) keeps this correct at the SERVER; DEP-011's compose variant must not re-introduce a
  refusal-means-success collapse.
- The driver's port-satisfying synthesized `inspect`/`list` (B2.2 item 5) is what the compose variant consumes —
  built as a **no-op/trust** (NOT a `resourceLabelsHash` compare — the synthesis makes that wrong, B2.0).

## B2.7 — guards (run the WHOLE set)

- No new package (both already registered from Unit A). The five registers + `check-worker-daemon-boundary`
  (UNTOUCHED — assert; the redaction only IMPORTS `hashResourceLabels`) + `check-sandbox-e2b-provider-boundary` +
  `check-test-inventory` (NEW test files → `--write` re-pin; no over-reach) + `check-boot-roots-provider-free`.
  NOT `check-image-deps-stages` / `dockerfile-static` (no image). No new `vitest.config.ts` `projects[]` / root
  `Dockerfile` COPY (no new package).

## B2.8 — open questions for the 3-agent adversarial review

1. **The generalized gate** — does `gateOwnedOp` byte-preserve B1's `execute` behavior (re-run B1's gate tests)?
   Any op where the AM-local inspect + field-wise owned-check is NOT the right gate (esp. `destroy`'s dual
   authority, `reconcile_cleanup`'s direct-provider callers)?
2. **The redaction airtightness** — does the server-side redact EVER let a raw label / sensitive field cross
   (inspect AND list)? Assert the serialized wire bytes. Does `list`'s filter correctly exclude foreign
   resources (a mock with mixed-owner sandboxes)?
3. **The port-type synthesis** — is reconstructing `InspectResult` from `cap.ownedLabels` + the redacted
   projection F2-clean AND port-correct? Does it ever fabricate a wrong `state`/`generation` (must come from the
   server's projection, not the capability)?
4. **`v:1` sufficiency** — is the narrow single-tuple `list` genuinely enough for B2's surface, or does any
   B2-scoped caller need the coarse-scope enumeration that forces `v:2`?
5. **Fail-closed parity** — do all 6 gated ops refuse on a missing/invalid capability exactly like execute (the
   R2 fall-open), and does the keyless-server ungated posture (Unit A) still hold for the new ops?
6. **Guards** — does generalizing `execute-gate.ts` + adding the ops trip any register, and does the
   `check-test-inventory` re-pin stay within the two packages?

## B2.9 — Review round — 4-agent adversarial pass (2026-08-29), all verified against source

**R1 — gate/ops (the load-bearing catch).** B1's collapse-ALL-inspect-throws, carried onto the IDEMPOTENT
teardown ops, is LEAK-MASKING: a transient inspect fault → uniform `ResourceNotAvailableError` →
`CleanupAuthority.converge` reads "vanished → success" → the sandbox LEAKS. Fix (applied, B2.2 item 1): make
`gateOwnedOp` a FAITHFUL `#requireOwned` mirror — `SandboxNotFoundError` → uniform; RETHROW transients
(existence-orthogonal, oracle-safe) so converge retries. Also: `dispatch()` outside the collapse-try + an
allow-path dispatch-error test (B1 never tested it). REFUTED: the happy-path `destroy` refusal (uniform gating is
correct; a refusal safely escalates) + reconcile-as-a-B2-blocker; the escalation asymmetry is recorded for
DEP-011 (B2.6).

**R2 — redaction/leak.** The gated boundary is provably safe (the projection is an explicit 5-field literal, not
a spread; the `list` filter excludes foreign resources; the port-type synthesis can't fabricate a wrong
`state`/`generation` — provably equal on the allow path). PRIMARY catch: the keyless-posture redaction bypass —
if `inspect`/`list` follow B1's keyless-ungated pattern they return raw `env`/`secrets`. Fix (applied, B2.2 item
4): the 5 new ops are GATED-ONLY (no raw handler; keyless → 404). Plus: redact the ALREADY-FETCHED detail;
synthesize `list`'s `hasLiveLease = state==="running"` (B2.6 inheritance); the generation clause in the filter.

**R3 — terrain.** 8/8 claims confirmed. Applied: the `list`/gate carry BOTH `labelsEqual` + the generation clause
(matching `cleanup-authority.ts:203` + B1); the "inspect has no prod caller" wording clarified (it's the redacted
`CleanupAuthority.inspect`; the raw `provider.inspect` is prod-proven).

**R4 — scope/wave-sizing.** Deferrals confirmed (component-level; the reconcile-sweep is F2-FORCED; `v:1`
sufficient). **Wave right-sized — keep unified** (B2's net-new security surface is smaller than B1's). Fix
(applied, B2.0): the compose rationale was wrong — the worker-side check is VACUOUS under the driver synthesis,
not shape-incompatible; DEP-011 must build the compose variant as no-op/trust, not a hash-compare.

---

# Slice 3 · Wave β1 — the durable idempotency ledger + create-gating + the TOCTOU lock

**Status:** design (2026-08-29, post-recon + **create-gating DECIDED → gate create**, founder sign-off). Builds
on the SHIPPED gated wire (A+B1+B2). Scope: the two HARD parts of Slice 3 — the durable, identity-namespaced
idempotency ledger (which forces create-gating) + the TOCTOU/`sandboxId`-reuse lock — component-tested on the
MOCK. **Wave β2 is SPLIT off** (host the real `E2bSandboxProvider` + a new adapter-manager boundary guard + keyed
conformance — mostly wiring already-built code). **4-agent adversarial review applied (§β1.9)** — 3 HIGH ledger
findings (the space-join key collision → unambiguous encoding; mandate STRIP not namespace; a concurrent
double-provision → mutex + check-after-create) + the R2 regression (gating create reds the B1/B2 setup-creates →
per-label mints) folded in.

## β1.0 — the decisions + the recon findings (2026-08-29, verified against source)

**Create-gating RESOLVED → GATE CREATE** (founder sign-off). The durable ledger MUST be namespaced by
authenticated identity (SETTLED: S1.5, B2.6, `DEP-012-unit-b1-result.md` — else worker B replaying worker A's
`idempotencyKey` learns A's `sandboxId` + raw labels: a cross-tenant/disclosure oracle). The provider's
`#idempotency` (`e2b-provider.ts:156`) sits BELOW the gate, seeing only worker-chosen `ctx.idempotencyKey` +
worker-supplied `spec.resourceLabels` — neither trusted. So identity-namespacing forces `create` to carry the
capability. Gating `create` ALSO closes the separate "arbitrary foreign labels on a new sandbox" hole (`create`
is gate-free today, `server.ts:83-86`; the B2-result skeptic note deferred it). Keyless `create` stays for Unit A
back-compat.

**Slice 3 SPLITS (recon).** β1 (this) = the ledger + create-gating + the TOCTOU lock. **β2** = a new
composition-root bin hosting `new E2bSandboxProvider({ transport: createRealE2bTransport() })` (`E2B_API_KEY` in
env, dynamic-import the SDK, refuse-not-degrade — template `worker-keystore/src/bin/sandbox-provider.ts:72-104`)
+ a **new `adapter-manager-boundary.mjs`** (none exists — hosting the real provider pulls `e2b` into the key-less
server's closure; confine it, template `worker-keystore-boundary.mjs:27-35`) + move `sandbox-e2b-provider`
devDep→dep + the keyed conformance lane (`describeKeyed` + dynamic import, `keyed-real-e2b.test.ts:31-42`).

**Conformance = HOSTED-provider, NOT wire-end-to-end (recon Q4 — a landmine).** "The networked provider must
pass `runSandboxIsolationConformance`" is structurally INFEASIBLE wire-end-to-end: the hostile suite creates
resources with FRESH, varying labels per op (`per-op-adapter.ts:135-148`), but the wire carries ONE fixed
`#capability` (`driver.ts:82-88`) + owns-checks every op against it (`owned-op-gate.ts:134`) → the suite's own
resources are refused as foreign. Target = the HOSTED `E2bSandboxProvider` over the swapped transport (already
substantially built: mock=full green `conformance.test.ts`; real=curated subset `keyed-real-e2b.test.ts` — the
fault-directive invariants are permanently mock-only). The wire's correctness is the B1/B2 component tests. [β2.]

**The TOCTOU (recon Q3).** `sandboxId` is E2B-assigned + opaque (`real-transport.ts:97-105` forwards it); the
mock never reuses (`mock-transport.ts:80-83`); real-E2B reuse is an EMPIRICAL unknown. (a) provider-atomic
compare-and-execute → grows the FROZEN port → INFEASIBLE; (b) AM-local per-`sandboxId` lock → feasible, no port
change, CI-testable, but PARTIAL (only serializes MY inspect+dispatch on THIS AM instance); (c) proven-non-reuse
invariant → cheapest IF real E2B ids don't reuse → deploy-verifiable. **Lean: (b) in β1 as CI defense-in-depth +
(c) the empirical assertion owed at the keyed lane/deploy (β2/deploy); + the §S1.5 foreign-id ordering assertion.**

## β1.1 — verified terrain (recon 2026-08-29)

- **`create` replay** (`e2b-provider.ts:186-213`): `ctx.idempotencyKey` present + in the map → return the recorded
  `{sandboxId, resourceLabels}` with a fresh `providerOpId`; else provision + `#idempotency.set(key, {sandboxId,
  resourceLabels: spec.resourceLabels})` (`:211`). The map is IN-MEMORY (`:156`).
- **adapter-manager has NO datastore** (`package.json` deps = `provider-wire` + `worker-daemon` only). The
  durable-write primitive to reuse: `worker-daemon/src/identity/file-record-store.ts` (temp → `fsync` → `link()`
  CAS → PARENT-DIR fsync `:178`) — but it is SINGLE-RECORD `saveIfAbsent`; a keyed LEDGER is a new build.
- **`create` is gate-free even on a gated server** (`server.ts:83-86` — a raw Map handler; not in the
  gate-routed path). The driver holds `#capability` (`driver.ts:82`) already attached to the other gated ops;
  `#post` (`:175-190`) already types `op: ProviderOperation`, so attaching it to `create` is a ONE-arg change
  (review R3).
- **The TOCTOU:** `gateOwnedOp` is `provider.inspect` (`owned-op-gate.ts:126`) then `dispatch(detail)` (`:139`) —
  non-atomic across two provider round-trips.

## β1.2 — what it builds

1. **Gate `create`** — `create` joins the gated ops on a KEYED server. The driver attaches the capability to
   `create`; the server routes it through a create-gate: verify the capability → **enforce
   `labelsEqual(spec.resourceLabels, cap.ownedLabels)`** (the caller creates only its OWN-labeled sandboxes —
   closes the arbitrary-labels hole; refuse with the uniform error else) → the ledger check (item 2) →
   `provider.create` → record. **Keyless server → `create` ungated** (Unit A back-compat — `create` KEEPS its raw
   Map handler, reached only when ungated, exactly like `execute`). create's gate is a DISTINCT shape from
   `gateOwnedOp`: NO `inspect` (there is no existing sandbox) — it is verify + spec-label-match + the ledger.
   **Routing (review R2):** add `create` to `GATE_REQUIRED_OPS` AND a `routeGated` `case "create"` (the create-gate,
   NOT `gateOwnedOp`) in the SAME change — the set + switch move together, else `create` falls to the `default`
   reject — and re-pin `check-gate-clause-wiring`; `create` KEEPS its raw Map handler for the keyless path. **The
   driver change is ONE arg** — `#post` already types `op: ProviderOperation` (`driver.ts:176`); `driver.create`
   just passes `this.#capability` (no widening). A legit worker matches (`labelsFor(handoff)` ≡ `cap.ownedLabels`),
   but the mint≡`labelsFor` FIELD-FOR-FIELD invariant (incl. NUMERIC `attempt`/`deviceGeneration` — `labelsEqual`
   compares with `===`) is a DEP-011 must (§β1.6), else legit creates silently refuse.
2. **The durable, identity-namespaced idempotency ledger** (a NEW adapter-manager server-layer component). Keyed
   by **(identity, idempotencyKey)** where **identity = an UNAMBIGUOUS encoding of `cap.ownedLabels`** — the raw
   ordered tuple, or a SHA over the B1 fixed-order-JSON / length-prefixed canonical (the SAME serialization B1's
   capability mandates). **★ NOT `hashResourceLabels` (review R1+R4 — the headline fix):** its `.join(" ")` is
   non-injective (`provider.ts:159-167`) — two tuples with a space across a field boundary collide
   (`org:"a",target:"b c"` ≡ `org:"a b",target:"c"`), so two tenants would SHARE one ledger namespace → tenant Y
   replaying X's key gets X's sandbox. B1 already rejected this hash for authorization (`capability.ts:9-12`); the
   ledger must not reopen it. Value = `{sandboxId, resourceLabels}`. **The store:** a per-key file reusing the
   `FileRecordStore` write-once `saveIfAbsent` CAS (temp → fsync → `link()` → **PARENT-DIR fsync** — the WRK-014
   lesson; a reimplementation MUST carry the parent-dir fsync or a "stored" entry is lost to power loss) — NOT a
   "compacting store" (different crash/concurrency properties; pick the write-once per-key file, which is
   create-then-record only, no `pending→done`).
   - On a gated `create`: verify → hold the per-`(identity,key)` MUTEX (item 3-bis below) → `ledger[(identity,key)]`
     → HIT: return the recorded result (BYPASS `provider.create`); MISS: `provider.create` → record.
   - **★ MANDATORY: STRIP `ctx.idempotencyKey` (pass `""`) before `provider.create` (review R1).** The provider's
     OWN in-memory `#idempotency` (`e2b-provider.ts:156,:188`, keyed by the key ALONE) would otherwise HIT A's
     entry when the server calls `provider.create` with B's replay of A's key → return A's `{sandboxId,
     resourceLabels}` to B (a cross-tenant leak THROUGH the provider). Stripping makes the durable ledger the SOLE
     idempotency authority with NO residual, and never breaks a legit replay (a replay is a ledger HIT that
     bypasses the provider). **Do NOT** use the "namespaced provider key" alternative (unbounded map + inherits
     the collision). Test the cross-identity replay at BOTH layers against a STRIPPED provider call.
   - **★ CONCURRENCY — a double-provision (review R1+R4):** two same-`(identity,key)` creates on ONE instance both
     MISS the ledger (Node interleaves at the awaited `provider.create`) → TWO real sandboxes; the write-once CAS
     dedupes only the RECORD → the loser is a live orphan. Fix: an **AM-local per-`(identity,key)` async mutex
     spanning the whole check → create → record**, PLUS a **check-after-create** (on `already_present`: re-read
     the winner's record, RETURN it, and TEAR DOWN the loser's just-created sandbox). Across the scope's replicas
     1-3 the in-process mutex + per-replica local ledger do NOT serialize — that cross-replica double-provision is
     deploy-owed (a shared-volume ledger + the check-after-create; §β1.6).
3. **The TOCTOU lock (b)** — `gateOwnedOp` holds an AM-local per-`sandboxId` async lock across inspect+dispatch
   (`owned-op-gate.ts:126-139`), acquired AFTER `verifyOrUniform` (verify stays OUTSIDE the lock — fail-closed, and
   an unauthenticated caller must not acquire locks) and released in a `finally`. The lock map (keyed by the
   attacker-supplied `sandboxId`) EVICTS on drain, so foreign/garbage ids don't grow it. CI-testable (a
   concurrent-op race on the mock). **Honestly PARTIAL:** it serializes only THIS AM instance's inspect+dispatch —
   NOT E2B's own TTL destroy+reassign (`e2b-provider.ts:210`), and NOT a SECOND adapter-manager replica (the scope
   allows replicas 1-3, `adapter-manager-scope.md:156`; an in-process lock has no cross-replica reach). The real
   fix is (c) proven-non-reuse (deploy-owed); the §S1.5 foreign-id ordering assertion is also deploy-owed (β1.6).
   (The create path's own concurrency uses the per-`(identity,key)` mutex of item 2 — a DIFFERENT key, since a new
   `create` has no `sandboxId` yet.)

## β1.3 — where things live + fences

- All new code is `adapter-manager` (the create-gate + the ledger + the lock) + `provider-wire` (the driver
  attaches the capability to `create`; widen the codec/driver as needed). **`cleanup-authority.ts` + worker-daemon
  + the port UNTOUCHED** (assert, as A/B1/B2). The ledger reuses the `FileRecordStore` IDIOM but is a new
  adapter-manager file — it does NOT import worker-daemon internals beyond the already-exported symbols.
- **NOT** the real transport / the boundary guard / conformance (**β2**); **NOT** the empirical non-reuse fact
  (deploy/keyed-owed); **NOT** the credential crossing (the per-run Company model key = **Slice 4**, settled (i));
  **NOT** through the daemon (component-level). Still on the MOCK.

## β1.4 — TDD (fail-first)

0. **★ Migrate the shipped B1/B2 setup helpers FIRST (review R2 — else gating `create` reds them).** `gate.test.ts`
   + `owned-op-gate.test.ts` run on a GATED server and use a capability-LESS `createSandbox` for setup — which the
   create-gate now refuses. Migrate `createSandbox` to MINT + attach a capability matching the labels it creates;
   the FOREIGN-labeled setups (`createSandbox(FOREIGN)`/`(SAME_COARSE)`) mint their OWN foreign capability (the
   foreign sandbox is created AS the foreign tenant — the correct model), NOT the owner's. Confirm A/B1/B2 green.
1. Gate `create` — keyed server: verify + `labelsEqual(spec.resourceLabels, cap.ownedLabels)` (FULL `ResourceLabels`
   specs, not Unit A's 2-field `{tenant,run}`) → allow; foreign spec-labels → uniform error; MISSING capability →
   refused (RED). Keyless server: `create` still ungated (Unit A's create tests GREEN).
2. The ledger — durability: a `create` records; a SIMULATED restart (new ledger instance over the same dir — an OS
   TEMP dir, NEVER the repo tree) replays the same `(identity,key)` → the SAME `sandboxId`, no second
   `provider.create` (RED).
3. ★ Cross-identity leak (STRIPPED): B's replay of A's `idempotencyKey` (different identity) → MISS → B gets its
   OWN sandbox; A's `{sandboxId,resourceLabels}` NEVER returned to B — at the server ledger AND through the
   provider's map (assert `provider.create` is called with an EMPTY key — proves the strip) (RED).
4. ★ Ledger-key collision: two `ownedLabels` differing only by a SPACE shift (`org:"a",target:"b c"` vs
   `org:"a b",target:"c"`) → DISTINCT ledger namespaces (B never gets A's sandbox) — FAILS under a
   `hashResourceLabels` key, proves the unambiguous encoding (RED).
5. ★ Concurrent double-provision: two same-`(identity,key)` creates racing → exactly ONE sandbox exists; the loser
   is torn down / never created (the mutex + check-after-create) (RED).
6. The TOCTOU lock — two concurrent ops on the same `sandboxId` do not interleave inspect/dispatch (a race with a
   yielding inspect); verify-before-lock; the lock map evicts on drain (RED).
7. Mutation sweep — the label-match clause; the ledger hit/miss; the STRIP (un-strip → B gets A's sandbox =
   KILLED); the identity encoding (space-join → the collision test KILLS it); the mutex (drop → double-provision);
   the durability write (drop the parent-dir fsync where reimplemented).

## β1.6 — what Wave β2 + deploy inherit (recorded)

- **β2:** the real-transport composition-root bin + the `adapter-manager-boundary.mjs` guard (confine `e2b` /
  `E2B_API_KEY` / `sandbox-e2b-provider` to that one bin) + `sandbox-e2b-provider` devDep→dep (+ declare `e2b`) +
  the keyed conformance lane (conform the HOSTED provider, curated subset — NOT the wire-end-to-end).
- **Deploy/keyed-owed:** the TOCTOU (c) empirical non-reuse assertion (assert + a keyed test that a destroyed E2B
  id is never re-minted) — if TRUE the TOCTOU is vacuous, the (b) lock is defense-in-depth; the §S1.5 foreign-id
  ordering assertion.
- **★ Cross-replica (review R4):** the scope allows adapter-manager replicas 1-3 (`adapter-manager-scope.md:156`),
  but β1's TOCTOU lock is IN-PROCESS and the ledger is a per-replica LOCAL file — neither serializes across
  replicas → a create replay routed to a different replica MISSES → double-provision. Deploy-owed: a SHARED-VOLUME
  ledger + the check-after-create teardown; the in-process lock stays defense-in-depth.
- **★ Crash-orphan (review R1):** create-then-record has a window — a crash AFTER `provider.create` but BEFORE the
  ledger commit leaves a created-but-unrecorded sandbox → a restart replay re-provisions → a SAME-tenant orphan
  (bounded by the sandbox TTL `e2b-provider.ts:210`, but a long workload's TTL is large). `record-intent-first`
  would close it but is not expressible over write-once `saveIfAbsent` — a deploy/hardening item.
- **★ The mint≡labelsFor invariant (review R2):** DEP-011's capability mint must produce `ownedLabels`
  FIELD-FOR-FIELD identical to `labelsFor(handoff)` (`supervisor.ts:205-215`) that `createSpecFor` stamps —
  including the NUMERIC `attempt`/`deviceGeneration` (`labelsEqual` uses `===`). Any type/normalization drift
  silently REFUSES legit creates under the create-gate.
- **Watch (recon landmine 6):** B2's `reconcile_cleanup` semantic inversion (already-gone → thrown
  `ResourceNotAvailableError`, not `CleanupResult{success}`) may FIRST surface under a real E2B TTL-expiry
  (`e2b-provider.ts:210`) once β2's real transport lands — DEP-011's remit, but β2 makes TTL expiry real.

## β1.7 — guards (run the WHOLE set)

No new package (adapter-manager + provider-wire). The five registers + `check-worker-daemon-boundary` (UNTOUCHED
— assert) + `check-sandbox-e2b-provider-boundary` + `check-test-inventory` (NEW test files → `--write` re-pin, no
over-reach) + `check-boot-roots-provider-free`. The ledger's file store adds NO boot root (it is a runtime store,
not a bin naming `bootstrapWorkerDaemon`) — confirm. NOT `check-image-deps-stages` / `dockerfile-static` (β1 adds
no image). NO new `vitest.config.ts` `projects[]` / Dockerfile COPY. **★ The ledger's runtime DIR must be
out-of-tree or gitignored** (review R4 — reuse the `data/`/`.aoa/` `.gitignore` precedent; `FileRecordStore` takes
a required `path`, no default), and the restart-replay test (β1.4 step 2) writes to an OS TEMP dir, NEVER the repo
tree — else ledger data files could pollute `check-test-inventory`.

## β1.8 — open questions for the 3-agent adversarial review

1. **The leak-through** — does the server's provider-key namespacing/stripping FULLY close the provider's
   in-memory `#idempotency` cross-identity leak (test both layers)? Is stripping `ctx.idempotencyKey` before
   `provider.create` cleaner + safer than passing a namespaced key?
2. **The ledger's file store** — is a keyed file-backed store crash-atomic + concurrent-safe (two AM requests
   racing the same `(identity,key)`)? Does it need the `FileRecordStore` CAS per key, and is a restart-replay
   genuinely durable (parent-dir fsync)?
3. **create-gating fences** — does gating `create` on a keyed server break ANY A/B1/B2 test, and does keyless
   `create` stay ungated (Unit A)? Is `labelsEqual(spec.resourceLabels, cap.ownedLabels)` the right
   arbitrary-labels closure (a caller must still be able to create its own sandbox)?
4. **The TOCTOU lock** — is an AM-local per-`sandboxId` lock sound (no deadlock, released on throw), and is its
   PARTIALITY (doesn't cover E2B-side reassign) honestly recorded as (c)-deploy-owed, not oversold?
5. **Identity function** — is `hashResourceLabels(cap.ownedLabels)` the right namespacing identity (stable,
   collision-resistant enough for a ledger key), or should it be the raw tuple / the capability's own fields?
6. **Guards** — does the file store trip `check-boot-roots-provider-free` or any register; does the ledger's dir
   need a `.gitignore` / a configured path (not a committed artifact)?

## β1.9 — Review round — 4-agent adversarial pass (2026-08-29), all verified against source

**R1 — ledger security (3 HIGH, all applied).** (1) The LEAK-THROUGH: the provider's in-memory `#idempotency`
(keyed by `idempotencyKey` ALONE) would echo A's sandbox to B on a cross-identity replay → MANDATE stripping
`ctx.idempotencyKey` before `provider.create` (the durable ledger is the SOLE layer; a legit replay is a HIT that
bypasses the provider); the "namespaced key" alternative DELETED (β1.2 item 2). (2) The ledger KEY collision:
`hashResourceLabels`'s `.join(" ")` is non-injective — the SAME space-join bypass B1 rejected for authorization →
key by an UNAMBIGUOUS encoding (raw ordered tuple / B1 canonical) + a collision mutation test (β1.2 item 2, β1.4
step 4). (3) A concurrent DOUBLE-PROVISION: two same-key creates both miss the ledger → two sandboxes → a
per-`(identity,key)` mutex + check-after-create teardown-the-loser (β1.2 item 2, β1.4 step 5). + the
create-then-record crash-orphan recorded (β1.6).

**R2 — create-gating (a REGRESSION, applied).** Gating `create` reds the SHIPPED B1+B2 suites (their gated-server
`createSandbox` setup is capability-LESS, and they create FOREIGN-labeled sandboxes the owner's capability can't
authorize) → β1.4 step 0 migrates the helpers to PER-LABEL mints (the foreign sandbox created AS the foreign
tenant). Confirmed sound: the `labelsEqual` closure (+ the mint≡`labelsFor` invariant recorded for DEP-011,
β1.6); the create-gate shape (no inspect); keyless `create` byte-identical. The routing coupling recorded (β1.2
item 1).

**R3 — terrain.** 8/8 confirmed. `create` genuinely gate-free; the leak-through real (the provider records the
ORIGINAL caller's labels by key alone). Favorable: `#post` already types `ProviderOperation` → attaching the
capability to `create` is a one-arg change (β1.1 cites corrected).

**R4 — TOCTOU lock + scope + guards.** The lock is soundly implementable (verify-outside-lock, `finally`, evict on
drain — β1.2 item 3); its PARTIALITY now names the MULTI-REPLICA gap (the in-process lock + per-replica local
ledger don't serialize across the scope's replicas 1-3 → cross-replica double-provision, deploy-owed, β1.6). The
β1/β2 split + the HOSTED-provider conformance read + one-wave sizing CONFIRMED; guards clean (the ledger DIR must
be gitignored/out-of-tree, β1.7). Corroborated R1's ledger-key must-fix.

---

# Slice 3 · Wave β2 — host the real provider + the adapter-manager boundary guard

**Status:** design (2026-08-29, post-recon + **3-agent adversarial review COMPLETE — all findings verified against
source and folded in below**; **NO architecture fork** — mechanical wiring + one security-critical guard). Builds
on the SHIPPED β1 (ledger + create-gating + TOCTOU lock, on the mock). A LIGHT wave — genuinely smaller than β1
(net-new security surface = the boundary guard + the bin's key/refuse handling). The review's resolved corrections
are in §β2.1–β2.6; §β2.7 is the review outcome. The two load-bearing repairs: (1) the guard must be a default-deny
ALLOW-LIST with **subpath-aware** handling (a naive exact-match template copy REDS the shipped tree), and (2) the
bin's fail-open lives in ONE optional field (`controlPlanePublicKey?`) — a missing key = an UNGATED server, so the
bin's refuse-to-boot is β2's PRIMARY security guarantee, not a Slice-5 deferral.

## β2.0 — the delta + the recon findings (2026-08-29, verified against source)

**β2's net-new is (d) a composition-root BIN + (e) an `adapter-manager-boundary.mjs` GUARD + a devDep→dep move**
(+ 2 small wiring edits: a `guard-inventory.json` entry + a `pr.yml` policy run-line). Parts (a) `RealE2bTransport`
(`real-transport.ts:77,:238`, sync key-refuse `:53-59`), (b) the mock conformance (BOTH suites via
`perOpToInvokeDriver(E2bSandboxProvider(MockE2bTransport))`, `conformance.test.ts:27-52`, green in `verify`), and
(c) the real-E2B keyed subset + its `keyed-e2b-conformance.yml` lane (`describeKeyed = HAS_KEY ? … : skip`,
`keyed-real-e2b.test.ts:31`, dynamic-imports `real-transport.js`) are ALL SHIPPED. **β2 adds ≈ZERO conformance
code** — it INHERITS the existing suites; the target is the HOSTED provider, NOT the AM wire (wire-end-to-end is
structurally infeasible — the single fixed capability vs the suite's fresh per-op labels; §DEP-012-design B1/B2).

**★ Three corrections to the earlier β2 notes (recon):**
- **OMIT `e2b` from the AM required-deps** — the design's "(+ declare `e2b`)" is WRONG. The worker-keystore
  precedent hosts the provider yet declares only `[sandbox-e2b-provider, worker-daemon, worker-protocol]`
  (`worker-keystore-boundary.mjs:71-75`); `e2b` stays TRANSITIVE (imported dynamically in the one bin). The AM
  required-deps = `[provider-wire, sandbox-e2b-provider, worker-daemon]`.
- **Ban `E2B_API_KEY` in ZERO files, not "the one bin"** — the bin does NOT read the key (`createRealE2bTransport()`
  reads `process.env.E2B_API_KEY` itself, `real-transport.ts:54`). Like worker-keystore (`:111,:235-247`), the AM
  guard forbids the token in ALL AM source.
- **The control-plane public key is NOT in the compose today** (`docker-compose.staging.yml:318-323` injects
  `E2B_API_KEY`+`E2B_DOMAIN`, no CP key). So the bin is **FAIL-CLOSED**: a production bin REQUIRES the CP-key path
  to boot GATED — it refuses to boot rather than silently run ungated (the "Slice 5 must assert the key" residual,
  enforced at the bin). The compose CP-key env is DEPLOY-OWED (Slice 5); β2 adds no compose/image change.

## β2.1 — verified terrain (recon 2026-08-29)

- **No `packages/adapter-manager/src/bin/`** exists; `createProviderServer` has ZERO production callers (only the
  `index.ts` export + test files). The bin is the first.
- **Template** `worker-keystore/src/bin/sandbox-provider.ts:72-104`: env gate + a LITERAL dynamic
  `import("@armyofagents/sandbox-e2b-provider")` (`:63-64`, deferred because the barrel pulls `e2b`) +
  refuse-not-degrade + an injectable `ProviderModuleLoader` (`:59,:74`) — the CI-testable seam (a fake loader
  drives env-parse + refuse WITHOUT the SDK/key).
- **The AM bin is a FULLER composition root** (landmine): beyond resolving the provider it must build the ed25519
  `controlPlanePublicKey: KeyObject` (`server.ts:55`; ed25519-asserted `capability-verify.ts:55`). **★ CORRECTED
  (review B4): a production ed25519-SPKI KeyObject loader + the EXACT assert the bin needs already exist** —
  `worker-device-proof.ts:78-79` does `createPublicKey({key, format, type})` then `if (asymmetricKeyType !==
  "ed25519") throw`, and `openclaw-gateway/src/server/execute.ts:567` loads a PEM. The genuinely net-new part is
  narrow: loading THIS key **from a configured file path** + the fail-closed enumeration (§β2.2.1). Point β1's
  `idempotencyLedgerDir` at a configured volume (`server.ts:58-66`); `createProviderServer({…})` + `.listen(PORT)`.
- **★ CORRECTED (review B5): the bin's listen port is NOT free** — `docker-compose.staging.yml` already pins the
  `adapter-manager` service to `PORT: "8090"` + a `curl http://127.0.0.1:8090/healthz` healthcheck (`:320,:338`),
  and `createProviderServer` returns a bare `Server` (`server.ts:92`) that already serves `/healthz` (`:180-183`)
  but does NOT listen. The bin MUST `.listen(process.env.PORT)`. Reading `PORT` now is NOT Slice-5 drift — the env
  already ships in the compose; a hardcoded/ephemeral port breaks the shipped healthcheck + DEP-011's peer reach.
- **No `adapter-manager-boundary.mjs`** (Glob `scripts/lib/*boundary*.mjs`). Template `worker-keystore-boundary.mjs`:
  confine the provider package to ONE FULL path (`:99-100,:201`, full path not basename — the `:81-86` bug) + ban the
  credential token (`:111`) — but it is an **allow-list (default-deny)**, and its `ALLOWED_BARE` is EXACT-match
  (`:134-158`). **★ CORRECTED (review G1): a faithful exact-match copy REDS the shipped tree** — `server.ts:36`
  imports `@armyofagents/provider-wire/codec` and `capability-verify.ts:28` imports `.../capability` (runtime
  SUBPATH imports the exact-match allow-list rejects). The guard must be subpath-aware (§β2.2.2). Runner + self-test
  pattern: `check-worker-keystore-boundary.mjs` + `.test.mjs`.
- **`check-guard-inventory` is DEFAULT-DENY** — a new `check-*.mjs` not declared in `guard-inventory.json` REDS the
  policy job (`pr.yml:250-251`), and it ALSO cross-checks the runner is named in a workflow (`not_in_workflows`,
  `guard-inventory.mjs:90-92`). It **filters OUT `*.test.mjs`** (`check-guard-inventory.mjs:37`) — so the self-test
  is tracked by a DIFFERENT guard: **`check-execution-census`** (§β2.2.2 / β2.6). `checkProviderControlBoundary`
  already EXPECTS the key on adapter-manager (`staging-manifest-invariants.mjs:436`, green today) — β2 lands it
  where the guard wants.
- `server.ts` today imports only `@armyofagents/worker-daemon` + `@armyofagents/provider-wire/codec` (`:29-42`, a
  provider-wire SUBPATH) — already provider-free (its static closure is e2b-free: `codec` → the provider `errors`
  subpath → `worker-daemon` only, no `e2b`); the guard FREEZES that.

## β2.2 — what it builds

### β2.2.1 — the composition-root bin `packages/adapter-manager/src/bin/adapter-manager.ts` (FAIL-CLOSED)

A FULL production composition root: env-gated (an `AOA_ADAPTER_MANAGER_*` provider/template switch mirroring the
worker set); a literal dynamic `import("@armyofagents/sandbox-e2b-provider")` of the **BARE barrel** (keep `e2b`
out of the eager closure — the guard allow-lists the bare specifier for the bin, NOT a subpath, so do NOT carry
Unit A's "subpaths-only" convention here) → `new E2bSandboxProvider({ transport: createRealE2bTransport() })`; load
the ed25519 `controlPlanePublicKey`; point the β1 `idempotencyLedgerDir` at a configured out-of-tree volume;
`createProviderServer({ provider, controlPlanePublicKey, idempotencyLedgerDir, … })` then `.listen(process.env.PORT)`.

**★ THE FAIL-OPEN LIVES IN ONE FIELD (review B1 — HIGH).** `createProviderServer`'s `provider` is a REQUIRED option
(`server.ts:45` — the type fail-CLOSES it) but `controlPlanePublicKey?` is OPTIONAL (`:55` — the type fail-OPENS
it), and the whole gate reduces to `const gated = controlPlanePublicKey !== undefined` (`:98`): **`undefined` ⇒
create+execute fall to raw, UNGATED handlers** (`:104-107,:216-222`) — the exact cross-tenant `execute` oracle B1
closed. So the bin is the SOLE guard on the key with NO compiler backstop, and:
- **INVERT the template default.** The worker-keystore template treats `unset ⇒ {kind:"none"}` (a benign skip,
  `sandbox-provider.ts:77-79`). For the CP key that is FATAL: unset/empty/missing ⇒ **REFUSE TO BOOT**, never a
  benign none. Do not copy the template's "unset is fine" shape onto the key.
- **MISSING-KEY is the load-bearing, singly-covered security property.** A missing key ⇒ `undefined` ⇒ ungated ⇒
  NO downstream protection at all. (A parsed-but-non-ed25519 key is defense-in-depth — a gated server already
  fail-closes every request at `capability-verify.ts:55`.) The mutation sweep's PRIMARY kill is "make the bin boot
  ungated on a missing key" (§β2.4).
- **β2's bin refusal is the PRIMARY guarantee delivered NOW** — reconcile the `server.ts:47-53` / S1.5 "Slice-5
  deploy-ordering assertion will enforce the key" language: that is defense-in-depth, NOT the primary. β2 must NOT
  ship a bin that can boot ungated and defer the guard to a Slice-5 deploy test β2 does not build.

**★ THE FAIL-CLOSED ENUMERATION (review B3) — every case REFUSES, `createProviderServer` NEVER called:**
env/path unset **OR empty-string** (`.trim()`-empty ⇒ unset); file missing; file unreadable; **readable-but-
UNPARSEABLE** (empty / truncated / garbage PEM — `readFileSync` succeeds but `createPublicKey` THROWS, a distinct
path from "unreadable"); parsed-but-non-ed25519. `createPublicKey` MUST sit INSIDE the refuse try/catch (a catch
that scopes only the read, or defaults to `undefined`, fail-OPENS). SHOULD also reject a private-key PEM
(`createPublicKey` silently derives the public half — a key-hygiene footgun).

**★ ENCODING PINNED = PEM SPKI (review B2 — resolves the design's own DER/PEM contradiction).** Load via the
single-arg `createPublicKey(fileBytes)` (Node defaults a string/Buffer to `format:"pem"` — no format arg), then
assert `asymmetricKeyType === "ed25519"` (reuse the `worker-device-proof.ts:78-79` pattern, swapping its DER-bytes
input for the mounted PEM file). **B1's `{format:"der",type:"spki"}` sketch (DEP-012-design §B1 ≈:459) is SUPERSEDED
for the bin loader.** Slice-5 mounts a `-----BEGIN PUBLIC KEY-----` PEM SPKI file.

**★ THE INJECTABLE SEAM CUTS AT fs-BYTES (review B3), not at a ready-made KeyObject** — inject (provider-module
loader + a file-bytes reader + the env), and run the REAL `createPublicKey` on the injected bytes. A seam that hands
in a finished `KeyObject` never exercises the parser, so the unparseable/non-ed25519 refuse paths become
checks-that-nothing-runs. A locally-generated ed25519 PEM (happy), an RSA PEM (non-ed25519), a garbage buffer
(unparseable), and an absent/empty path (unset) then cover every path with NO real E2B key and NO real CP key.

### β2.2.2 — the `adapter-manager-boundary.mjs` guard (security-critical)

A default-deny **ALLOW-LIST** reproducing the worker-keystore template's structure (`worker-keystore-boundary.mjs`)
— NOT a minimal 3-clause deny-list. Three interlocking behaviors (**★ review G1 — HIGH**):
1. **Confine the provider PREFIX-based to the bin's FULL path.** `value === PROVIDER_SPECIFIER ||
   value.startsWith(PROVIDER_SPECIFIER + "/")` ⇒ allowed ONLY from `src/bin/adapter-manager.ts` (full package-
   relative path, not basename — the `:81-86` bug), else the uniform violation. Prefix-based so a provider SUBPATH
   (`@armyofagents/sandbox-e2b-provider/real-transport.js`, which ALSO pulls `e2b`) is confined too — a bare-only
   match would let that subpath leak into a request-path file.
2. **Subpath-aware allow-list for the NON-confined deps.** Accept `@armyofagents/provider-wire` and
   `@armyofagents/worker-daemon` BARE **and** subpath (`@scope/name` and `@scope/name/…`) — else the guard REDS the
   shipped tree at `server.ts:36` (`provider-wire/codec`) and `capability-verify.ts:28` (`.../capability`). Direct
   `e2b` is NOT allow-listed ⇒ forbidden everywhere (this is what enforces "no `e2b` in the request path"
   LEXICALLY, for free — the property a minimal deny-list would miss).
3. **Ban `E2B_API_KEY` in ALL AM source** (`FORBIDDEN_CREDENTIAL_TOKENS`, template `:111`) + pin
   `REQUIRED_RUNTIME_DEPENDENCIES = [provider-wire, sandbox-e2b-provider, worker-daemon]` (NO `e2b`) with EXACT-SET
   equality (template `:263-278`; the constant pre-sorted). The scan **WALKS ALL of `src/` recursively** per the
   template — the request-path files (`server.ts`, `owned-op-gate.ts`, `create-gate.ts`, the ledger,
   **`capability-verify.ts`**, `keyed-mutex.ts`, `index.ts`) are ILLUSTRATIVE, not the scan set; `__tests__` is
   intentionally skipped (tests legitimately import provider subpaths and are out of the production closure).

**★ FIVE-part registration (review G2 + S1 — corrects the "4-part" claim), because two DIFFERENT meta-guards each
track a different artifact:**
1. `scripts/lib/adapter-manager-boundary.mjs` (pure lib)
2. `scripts/check-adapter-manager-boundary.mjs` (runner)
3. `scripts/check-adapter-manager-boundary.test.mjs` (self-test = the mutation corpus)
4. a `scripts/guard-inventory.json` entry for the **RUNNER** (default-deny; ALSO cross-checked as named-in-a-workflow)
5. a `scripts/test-execution-census.json` entry for the **SELF-TEST**: `{status:"runs", workflow:"pr.yml",
   step:"Sandbox e2b provider dependency boundary"}` — because `check-guard-inventory` filters out `*.test.mjs`
   (`:37`), the census is what proves the self-test runs. The census is STRONG: it reds `undeclared` if the
   `.test.mjs` has no entry AND `not_named_in_step` if the named step's `run:` block does not literally contain the
   path (`execution-census.mjs` ~`:108-113`). So BOTH directions are covered — but ONLY if this entry exists.
+ **pr.yml:** append BOTH commands to the EXISTING `Sandbox e2b provider dependency boundary` step (which already
  hosts the e2b-provider + worker-keystore runners/self-tests, `pr.yml:180-185`):
  `node scripts/check-adapter-manager-boundary.mjs` and `node --test scripts/check-adapter-manager-boundary.test.mjs`.
  The census entry (5) MUST name this exact step string.

### β2.2.3 — the devDep→dep move

`sandbox-e2b-provider` devDependency → dependency in `adapter-manager/package.json`; OMIT `e2b` (transitive — the
worker-keystore precedent). The move yields exactly the guard's pinned set `[provider-wire, sandbox-e2b-provider,
worker-daemon]` (already sorted). Regenerate + COMMIT `pnpm-lock.yaml` (CI `verify` is `--frozen-lockfile`,
`pr.yml:776`; the "block manual lockfile edits" policy step only rejects a lockfile change WITHOUT an accompanying
manifest change, `pr.yml:135-147` — so the manifest edit + lockfile land together).

## β2.3 — where things live + fences

- All new code is `adapter-manager` (the bin) + `scripts/` (the guard lib/runner/self-test) + the manifest +
  `guard-inventory.json` + `pr.yml`. **`server.ts` / `owned-op-gate.ts` / `create-gate.ts` / the ledger UNTOUCHED**
  (the guard freezes them provider-free); cleanup-authority + worker-daemon + the port UNTOUCHED.
- **INHERIT conformance** — β2 writes ≈no conformance code (the mock suite is green; the keyed subset exists). Do
  NOT run conformance through the AM wire (infeasible) or add an AM-hosted conformance variant.
- **NOT** a Dockerfile/image (Slice 5); **NOT** the compose CP-key env (DEPLOY-OWED — the bin fail-closes without
  it, CI-tested, not deployed); **NOT** the credential crossing (per-run Company model key = Slice 4); **NOT**
  through the daemon (DEP-011). The real `RealE2bTransport` CONNECT + the real-E2B subset run only in the keyed
  lane/deploy.

## β2.4 — TDD (fail-first)

1. **The boundary guard lib** — self-test fixtures (each RED before the lib exists), reproducing the template's
   allow-list AND the G1 subpath corrections:
   - a non-bin file (`server.ts`) importing the provider BARE (`@armyofagents/sandbox-e2b-provider`) → VIOLATION;
   - a non-bin file importing a provider SUBPATH (`.../sandbox-e2b-provider/real-transport.js`) → VIOLATION (the
     bare-only-match bypass this closes);
   - `server.ts` importing `@armyofagents/provider-wire/codec` → **GREEN** (subpath-aware allow-list — this is the
     false-positive that a faithful exact-match copy would RED on the shipped tree);
   - `E2B_API_KEY` in ANY non-bin file → VIOLATION;
   - the BIN importing the bare provider barrel → OK; a direct `e2b` import anywhere → VIOLATION;
   - required-deps mismatch (`e2b` added, or a dep dropped) → VIOLATION (exact-set).
   Then implement the lib + runner; **register all 5 artifacts** (lib + runner + self-test + `guard-inventory.json`
   runner-entry + `test-execution-census.json` self-test-entry) + the 2-command `pr.yml` step; run the runner GREEN
   against the real tree, and run `check-guard-inventory` + `check-execution-census` GREEN (they prove the guard is
   wired to actually run — the checks-that-nothing-runs backstop).
2. **The bin** (INJECTED provider-loader + file-BYTES reader + env — no SDK, no real E2B key, no real CP key; the
   seam runs the REAL `createPublicKey`):
   - a valid ed25519 PEM + provider config → constructs the provider, loads+asserts the key, and calls
     `createProviderServer` with `{ provider, controlPlanePublicKey, idempotencyLedgerDir }` then `.listen(PORT)`;
   - **each fail-closed case → REFUSE, and assert `createProviderServer` is NEVER called** (not "constructed but
     not listened"): provider env unset/`none`; CP path unset OR empty-string; CP file missing; CP file unreadable;
     CP file readable-but-UNPARSEABLE (garbage/empty/truncated buffer → real `createPublicKey` throws); CP key
     parsed-but-non-ed25519 (an RSA PEM); (SHOULD) a private-key PEM;
   - a provider-construct throw → refuse-not-degrade.
3. **The devDep→dep move** — the manifest lists `sandbox-e2b-provider` as a dep, NOT `e2b`; `pnpm-lock.yaml`
   committed; the boundary guard's required-deps set matches; `pnpm install --frozen-lockfile` stays green.
4. **Mutation sweep (numbered acceptance — this is the ONLY enforcement of the bin's fail-closed posture; there is
   no static boot-root guard for it, §β2.6/S2):**
   1. drop the guard's full-path check → a basename bypass survives ⇒ a fixture KILLS it;
   2. drop the guard's prefix-based provider match → a provider SUBPATH from a non-bin file survives ⇒ KILLED;
   3. drop the `E2B_API_KEY` ban → a planted token survives ⇒ KILLED;
   4. **make the bin boot ungated on a MISSING CP key** (the primary security kill) ⇒ KILLED;
   5. move `createPublicKey` OUTSIDE the refuse try/catch (so an unparseable key crashes-or-fail-opens) ⇒ KILLED.

## β2.5 — what deploy / Slice 5 / DEP-011 inherit (recorded)

- **Slice 5 / deploy:** inject the ed25519 control-plane PUBLIC key onto the `adapter-manager` compose service
  (the bin fail-closes without it); build + sign + admit the `aoa-adapter-manager:staging` image (`docker/
  adapter-manager/**` — does not exist); the real `E2B_API_KEY` material (already manifest-expected).
- **Keyed/deploy:** the real `RealE2bTransport` connect + the real-E2B conformance subset run only via
  `keyed-e2b-conformance.yml` (operator-dispatched); real E2B id-non-reuse (the β1 TOCTOU (c) assertion).
- **DEP-011:** the through-the-daemon consumer (`AOA_WORKER_PROVIDER_URL`) + the compose variant / reconcile / v:2
  / the mint≡labelsFor invariant.

## β2.6 — guards (run the WHOLE set)

No new PACKAGE. Run:
- **`check-guard-inventory`** — default-deny; the NEW `check-adapter-manager-boundary.mjs` RUNNER needs an entry, or
  `policy` reds (`guard-inventory.mjs:82-84`); it also cross-checks the runner is named in a workflow (`:90-92`).
- **★ `check-execution-census` (review S1 — a MISS here is a GUARANTEED `policy` red).** The new
  `check-adapter-manager-boundary.test.mjs` self-test is NOT tracked by guard-inventory (it filters `*.test.mjs`,
  `:37`) — the census is. An undeclared `*.test.mjs` under `scripts/` reds `undeclared`; the `{status:"runs", …}`
  entry's named step must literally contain the `node --test …` line or it reds `not_named_in_step`
  (`execution-census.mjs`). This is DISTINCT from `check-test-inventory` (which only COUNTS files) — the exact
  TRACK-002 counting-vs-running blind spot.
- **`check-test-inventory`** (`--write` re-pin for the bin + guard test files).
- **`check-boot-roots-provider-free`** — no-op, CONFIRM: it scans only `packages/worker-daemon|worker-keystore/
  src/bin` and keys on the `bootstrapWorkerDaemon` marker (`check-boot-roots-provider-free.mjs:24-28`); the AM bin
  is outside those dirs and names `createProviderServer`, so no `boot-roots-expectation.json` entry is needed.
  **★ (review S2) — recorded INTENTIONALLY:** this guard is semantically WRONG for the AM bin anyway (it is the
  provider HOST — it MUST construct the provider), so there is NO static guard for the bin's env-gated / fail-closed
  posture. That posture is TEST-COVERED-ONLY, by design — the §β2.4.4 mutation sweep (esp. kills #4 missing-key and
  #5 parse-outside-catch) IS the enforcement. A future reviewer must know the guard gap is deliberate, not an
  oversight.
- **`check-staging-manifest`** — already green (`E2B_API_KEY` manifest-expected on adapter-manager + confined off
  every other surface; `checkProviderControlBoundary` does NOT require the CP-key, so its absence doesn't red — the
  CP-key compose env is honestly DEPLOY-owed).
- **`check-worker-daemon-boundary` / `check-sandbox-e2b-provider-boundary`** — UNTOUCHED (regression-confirm).
- **NOT** `check-image-deps-stages` / `dockerfile-static`. **★ (review S3, precise):** adapter-manager ∉ either
  SPLIT image (`docker/control-plane`, `docker/worker` — grep confirms). The COMBINED root `Dockerfile` DOES ship
  the whole workspace closure incl. `e2b` already (present-but-unused — the `server` entrypoint runs
  `server/dist/index.js`), so the devDep→dep move adds NOTHING to any image; the deps-stage bash step only checks
  `package.json` presence, already satisfied.

**COMMIT `pnpm-lock.yaml`** (`verify` is `--frozen-lockfile`).

## β2.7 — review outcome (3 agents, 2026-08-29, every finding verified against source)

Three adversarial reviewers (boundary-guard security; bin fail-closed key handling; scope-drift/guards/conformance)
ran against this design. **No architecture fork; no scope change.** Two independent reviewers CONVERGED on the guard
allow-list defect — the highest-confidence repair. Findings + resolution (all folded into §β2.1–β2.6 above):

- **G1 (HIGH, converged) — guard must be a subpath-aware default-deny allow-list.** A faithful exact-match copy of
  the template REDS the shipped tree (`server.ts:36` / `capability-verify.ts:28` import provider-wire SUBPATHS); the
  naive root-match fix opens a provider-subpath confinement bypass. → §β2.2.2 (prefix-based provider confinement +
  subpath-aware allow-list for the non-confined deps + `e2b` forbidden everywhere) + §β2.4.1 fixtures.
- **B1 (HIGH) — the fail-open lives in one optional field.** `controlPlanePublicKey?` optional + `gated = … !==
  undefined` ⇒ a missing key is an UNGATED server; the bin is the sole guard, no compiler backstop; the template's
  "unset ⇒ benign none" shape is FATAL here. → §β2.2.1 (invert the default; missing-key is primary; β2's refusal is
  the primary guarantee, not a Slice-5 deferral) + §β2.4.4 kill #4.
- **B2 (MED-HIGH) — the design's own DER/PEM contradiction** (§B1 `{format:"der"}` vs β2 "PEM path"). → §β2.2.1 pins
  PEM SPKI via single-arg `createPublicKey`, supersedes the DER sketch for the bin.
- **B3 (MED) — fail-closed enumeration incomplete + seam mis-cut.** Missing "readable-but-unparseable" + empty-path
  cases; the injectable seam must cut at fs-BYTES so the real parser runs. → §β2.2.1 + §β2.4.2.
- **B4 (MED) — "no production loader exists" was FALSE** (`worker-device-proof.ts:78-79`, `openclaw …execute.ts:567`).
  Net-new is only "load from a file path." → §β2.1 corrected.
- **B5 / F6 (MED-LOW) — the listen port is pinned by the shipped compose** (`PORT: 8090` + healthcheck). → §β2.1 +
  §β2.2.1 (`.listen(process.env.PORT)`).
- **G2 + S1 (MED) — registration is FIVE artifacts, not four; the self-test is tracked by `check-execution-census`,
  not guard-inventory.** A missing census entry is a GUARANTEED `policy` red. → §β2.2.2 (5-part) + §β2.6.
- **S2 (LOW) — no static guard covers the bin's fail-closed posture; that gap is intentional** (boot-roots is
  semantically wrong for the provider host). → §β2.6 records it; §β2.4.4 mutation sweep is the enforcement.
- **S3 (LOW, precision) — "server ⊅ adapter-manager" narrowed** to "∉ either SPLIT image; the combined image already
  ships `e2b` present-but-unused." → §β2.6.

**Confirmed SOUND (no change needed):** full-path confinement intent; OMIT `e2b` from required-deps (worker-keystore
precedent); exact-set deps check; `e2b` out of the static request closure (`codec` → provider `errors` subpath →
`worker-daemon` only); ban `E2B_API_KEY` in zero files; `idempotencyLedgerDir` wiring; the bin is the first
production `createProviderServer` caller (nothing else can leak an ungated server); conformance genuinely INHERITED
(both suites exist, drive the per-op provider, β2 adds none; the full-stack-untested residual is already honestly
recorded, `keyed-real-e2b.test.ts:156`); NO Slice-5 drift (no `docker/adapter-manager/**`, compose unchanged,
CP-key deploy-owed); "wire-end-to-end conformance structurally infeasible" is SOUND (per-op fresh labels vs a fixed
construction-time capability); lockfile `--frozen-lockfile` + the manifest-accompanies-lockfile policy.

**Design is GO for the §9 build prompt.**

---

# Slice 4 + Slice 5 — deploy-real (combined): the AM image, the mint keypair, control-net peer-auth, and the leak-proof credential crossing

**Status:** design (2026-08-30, post 3-agent terrain map, all findings verified against source at tip `9ae2dbc7c`).
Awaiting the adversarial review (§S45.10). This is the LAST session-buildable unit before the operator C0 deploy —
it makes the already-built worker→provider path DEPLOYABLE and LEAK-PROOF. **The credential mechanism already ships
inert (DEP-011 Slice 2a); this unit is deploy-real hardening + packaging, NOT a rebuild.**

## S45.0 — the shape + the decisions (terrain-confirmed)

The staging fleet cannot execute a canary today for FOUR reasons, three of them session code. This unit closes all
four as **four pillars**:

- **P1 — the AM image** (`docker/adapter-manager/**` does not exist; the compose references an unbuilt
  `aoa-adapter-manager:staging`). Additive, lands INERT, fires zero guards by default.
- **P2 — the CP matched-pair keypair** (THE LOAD-BEARING GAP). The AM verifies signed capabilities with a mounted
  ed25519 PUBLIC key (fail-closed — the bin refuses to boot without it). But the PRIVATE **mint** half is UNWIRED:
  `app.ts:497` mounts `workerControlRoutes({…})` WITHOUT `controlPlaneSigningKey` (verified; `worker-control.ts:105`
  takes it, comment says "no real keypair until deploy/Slice 5"). ★ **If only the AM public half is wired, every
  networked worker `create` fails the gate → the entire distributed create path is DEAD.** Both terrain agents
  converged on this.
- **P3 — the AM→CP truth-route peer-auth** (the B1-F1 deferral). Control-net is FLAT (`internal:true`, but all 7
  services share it — zero peer isolation). The DEP-011 lease-truth route is unauthenticated (the AM isn't
  worker-enrolled, can't use `verifyWorkerOperationProof`).
- **P4 — the credential made leak-proof** (Slice 4 = (i)). The worker-side crossing EXISTS (Slice 2a: the redeemed
  Company model key rides `create`'s `spec.env`). But the REAL e2b transport introduces ONE live-latent leak the
  mock never exercised: the AM's unmodelled-error path.

**Decisions (terrain + the user-delegated fork):**
- **Credential = option (i)** [SETTLED, `qa/2026-08-28-adapter-manager-scope.md` §3.1/§8]: the worker redeems (as
  today, bound to its own device identity — `secret-broker.ts:258` `request.workerId !== auth.workerId`; (ii) was
  rejected because relocating the mint makes the AM a standing minter of every tenant's key), and sends the bearer
  over the mutually-authenticated control-net-internal hop.
- **★ Peer-auth = shared-secret BEARER + control-net `internal:true` for Slice 5; real mTLS = a REQUIRED, FILED
  production follow-up (NOT dropped).** Rationale (user-delegated "best case + experience"): the goal now is the
  E7-1 FIRST PROOF on a controlled staging network, not production multi-tenant hardening; settled option (i)
  EXPLICITLY lists control-net `internal:true` among its mitigations (not a corner cut); the bearer closes the
  actual B1-F1 concern (a worker without the secret can't call the truth route); real mTLS is net-new (zero repo
  precedent), trips the exact-set manifest guards, and reshapes the deploy. File the mTLS follow-up as a hard
  production gate.
- **The AM image mirrors `docker/control-plane`** (NOT `docker/worker` — the AM is the provider HOST, must include
  the e2b transport + curl + ca-certificates).
- Governed by **Decision #104** (`decisions.md:913`, the Keyless-except-embeddings one — NOT the optimistic-
  concurrency #104 at `:854`): *"The credential must not appear in the prompt, argv, protocol, events, logs,
  artifacts, or evidence, and missing Company/provider/environment context fails closed."* THAT sentence is Slice 4's
  acceptance spec.

## S45.1 — P1: the AM image (additive, INERT, session)

- **Add `docker/adapter-manager/Dockerfile`** — a 4-stage mirror of `docker/control-plane/Dockerfile` (NOT worker):
  `base` (node:lts-trixie-slim pinned by `@sha256:` + corepack + **`curl` + `ca-certificates`** — the compose
  healthcheck is `curl -fsS …/healthz` and the e2b SDK makes HTTPS calls; the worker image ships neither) → `deps`
  (COPY the **7-package runtime closure** — `adapter-manager, provider-wire, sandbox-e2b-provider, worker-daemon,
  worker-protocol, provider-capability, sandbox-provider-contract` — + `pnpm install --frozen-lockfile --filter
  "@armyofagents/adapter-manager..."`) → `build` (`COPY . .`, build the closure, `pnpm --filter
  @armyofagents/adapter-manager deploy --prod /am-app`, then **`RUN node docker/apply-workspace-publish-config.mjs
  /am-app/node_modules`** — control-plane needs this because workspace deps ship `./dist` via `publishConfig`;
  without it `ERR_MODULE_NOT_FOUND` at runtime) → `production` (**`WORKDIR /am-app`** [Img-info — the
  `deploy --prod /am-app` + `CMD` pair requires it, mirroring `/cp-app`/`/worker-app`], `USER node`, read-only-root
  label, `HEALTHCHECK`, `image.revision` label from `ARG AOA_IMAGE_REVISION`,
  `CMD ["node","dist/bin/adapter-manager.js"]` — the bin has no `bin` field/shebang, invoked like the worker's).
- ★ **[Img-1, MED] Wire the idempotency-ledger dir to a WRITABLE volume — a read-only root otherwise CRASHES the boot.**
  On a gated server the ledger dir defaults to `mkdtempSync(join(tmpdir(), "aoa-am-ledger-"))` (`server.ts:129`), and
  the bin calls `startServer` UN-try-caught (`bin:196`) — so under the `--read-only` root the design declares, `/tmp`
  is not writable → `mkdtempSync` THROWS → unhandled → the container never goes healthy → `docker compose up --wait`
  hangs. (Latent: the staging compose sets no `read_only:true` today, so bring-up survives — but a `docker run
  --read-only` smoke bites.) **Fix:** mirror control-plane's `TMPDIR=/aoa/tmp` + `mkdir -p`/`chown node:node` + a
  `VOLUME`, and point `AOA_ADAPTER_MANAGER_IDEMPOTENCY_LEDGER_DIR` (already documented) at a writable node-owned
  volume dir. Optionally guard `startServer` in the bin to `refused` on a ledger-dir failure rather than crashing.
- **[Img-info] Opt into the closure guard.** Because the AM is kept out of `check-image-deps-stages`' hardcoded
  `IMAGES`, the 7-package COPY set is UNVALIDATED and could silently drift. The opt-in COPY set equals exactly the 7
  (verified), so opting the AM into `check-image-deps-stages` + `dockerfile-static` (with the `.test.mjs` fixtures) is
  cheap least-privilege parity — recommended.
- **Add `docker/adapter-manager/entrypoint.sh`** — `exec "$@"`, no usermod/gosu/chown (required if we opt into the
  `dockerfile-static` guard).
- **To PRODUCE the image (not needed for inert landing):** add one call each to `docker/images/build.sh`
  (`build_one "adapter-manager" "docker/adapter-manager/Dockerfile"`), `sbom.sh` (`emit_sbom`), `sign.sh`
  (`sign_one`). Everything downstream (`adapter-manager.metadata.json`, the `digests.env` lines, the sbom, the
  `allowlist.json` entry, the provenance file) is AUTO-GENERATED at build time — do NOT hand-author them.
- **Do NOT add the AM to the release-admission set** — `RELEASE_ARTIFACT_CLASSES` is a FROZEN 5-set
  (`{control_plane, worker, sandbox, desktop_installer, desktop_updater}`) that default-denies unknowns; the AM image
  is deliberately OUTSIDE the release gate (staging = pre-release). Do NOT wire the dormant orphan
  `verify-image-admission.mjs`.
- **Inert:** the Dockerfile can exist unbuilt; the staging compose is never brought up in CI (render-only). Actually
  building/pushing `aoa-adapter-manager:staging` is a C0/deploy concern, not CI-green.

## S45.2 — P2: the CP matched-pair keypair (THE LOAD-BEARING GAP; session code)

The owned-labels capability is signed by a CP **private** ed25519 key and verified by the AM with the matching
**public** key. Both halves are deploy-owed; the private (mint) half needs a CODE change.

- **The mint (private) half — SESSION CODE (THREE edits, not two — [Mint-3]).** In `server/src/index.ts` (beside
  `:930` `workerSessionSigningKey: process.env.AOA_WORKER_SESSION_SIGNING_KEY`), load
  `AOA_CONTROL_PLANE_SIGNING_KEY_FILE` → pass `controlPlaneSigningKey: KeyObject` through `createApp`'s opts →
  `app.ts`'s `workerControlRoutes({…, controlPlaneSigningKey})` (the missing arg at `:497`). ★ The THIRD edit
  ([Mint-3]): add `controlPlaneSigningKey?: KeyObject` to `createApp`'s opts INTERFACE (`app.ts:~216`) + the
  `KeyObject` import — it is not there today. ★ **[Mint-4] the `:497` arg MUST be a pre-resolved LOCAL, never an
  inline `process.env` read** — `rollout-rollback-liveness.test.ts:159` negative-matches
  `workerControlRoutes[…400 chars…]process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED`; an inline env read in that window
  reds it. (Other source-shape tests to keep green: `desktop-disabled.negative.test.ts:257` [exactly one
  `workerControlRoutes(` mount — an added arg keeps it one], `job-leasing-contract.test.ts`, `tenant-app-db-startup.test.ts`.)
- **★ [Mint-2, MED] The private-key load must mirror the AM bin's `try/catch → refuse` STRUCTURE, not just its
  asserts, and PRESENT-BUT-BAD ⇒ LOUD FATAL (never silent inert).** The AM bin wraps `createPublicKey` INSIDE the
  try/catch precisely because an unparseable PEM THROWS there (a catch scoped only to the read fails OPEN,
  `bin/adapter-manager.ts:166-180`). My linear "refuse-unless-`PRIVATE KEY`" prose is unsafe: an **encrypted PEM**
  (`BEGIN ENCRYPTED PRIVATE KEY`) passes the string-guard then `createPrivateKey` THROWS with no passphrase → if
  unwrapped, an UNCAUGHT exception at the `index.ts` composition root crashes the WHOLE control plane at boot; a
  **DER** key has no ASCII `PRIVATE KEY` so the string-guard wrongly rejects a valid key. So: wrap the whole load in
  try/catch; `asymmetricKeyType === "ed25519"` assert (catches an RSA `PRIVATE KEY`). ★ **Absent env ⇒ inert; but
  PRESENT-and-unparseable/wrong-type ⇒ a LOUD refusal — SCOPED to `distributedExecutionEnabled && key-env-set`** (a
  bad-key typo must not silently fall to `undefined`/inert = the exact dead path this pillar prevents; but crashing
  the whole CP over a mint-key typo when distributed execution is OFF is disproportionate).
- **The verify (public) half — manifest + operator.** The AM already fail-closes on
  `AOA_ADAPTER_MANAGER_CONTROL_PLANE_PUBLIC_KEY_FILE` (a mounted ed25519 SPKI PEM). Slice 5 sets that env on the AM
  compose service (path `/run/secrets/adapter-manager-cp-pubkey`, mirroring the enrollment-code file pattern — there
  is NO top-level `secrets:` block; the orchestrator mounts out-of-band). Also set the two other fail-closed boot
  envs the AM demands: `AOA_ADAPTER_MANAGER_SANDBOX_PROVIDER=e2b`, `AOA_ADAPTER_MANAGER_E2B_TEMPLATE`.
- ★ **THE DEAD-PATH INVARIANT + [Mint-1, HIGH] its ENFORCEMENT (my "tests ARE the enforcement" was a false claim).**
  The AM public key and the CP private key MUST be the same pair. If Slice 5 gates the AM but the operator mounts a
  MISMATCHED pair (or leaves the mint unwired), the AM verifies capabilities that were never minted → every gated
  `create` fails. ★ **This failure is MAXIMALLY SILENT:** every verify failure collapses to the UNIFORM
  `ResourceNotAvailableError` (`capability-verify.ts` → `owned-op-gate.ts` `verifyOrUniform`), byte-INDISTINGUISHABLE
  from a legitimate ownership denial — and neither service ever sees the other's key (each only validates its OWN key
  parses), so a mismatched pair boots CLEAN on both sides. Build-time tests with a self-generated keypair prove the
  endpoints in ISOLATION but CANNOT see the deployed combination. **So the enforcement is a C0 MATCHED-PAIR SMOKE
  CHECK against the REAL mounted files** — a session-built probe tool the operator runs at C0 BEFORE the canary: the
  CP mints a probe capability with the mounted private key → the AM verifies it with the mounted public key → **fail
  LOUD on mismatch** (never the silent uniform error). This gates the canary; it is the honest enforcement the
  build-time tests cannot provide. (Build-time tests still prove: mint↔verify parity with a real keypair → create
  dispatches; AND absent-key ⇒ byte-identical inert.) The REFUTED axes — the mint↔verify canonical/signature parity
  (one shared `buildOwnedLabelsCapabilityCanonical`, cross-package tested) and the label numeric/string trap (shared
  anchor tuple) — are genuinely sound; do not re-litigate them.

## S45.3 — P3: the AM→CP truth-route peer-auth (bearer; mTLS-deferred; session code)

- **The bearer.** A NEW shared secret the AM sends on its lease-truth POST and the CP truth route checks. AM side:
  read `env[AOA_ADAPTER_MANAGER_TRUTH_SHARED_SECRET]` in the bin, pass it into `makeControlPlaneResolveTruth` → the
  client adds it as an `Authorization`/`X-…` header on the POST. CP side: `adapter-manager-control.ts`'s route
  pre-handler adds a THIRD gate arm. ★ **[Img-2, MED] Fail-closed correctly: the check is "CP secret UNSET ⇒ 404",
  NOT `header === env`** — a naive equality falls OPEN when both are `undefined` (route enabled via
  `TRUTH_ROUTE_ENABLED=1` but the operator forgot the secret), re-opening the exact B1-F1 oracle. So: unset configured
  secret ⇒ 404; else compare via `crypto.timingSafeEqual` over **fixed-length HASHES of both sides** (timingSafeEqual
  throws on unequal-length buffers — hashing first is both constant-time AND no length leak). Negative test: **route
  enabled + NO bearer configured ⇒ 404.** Absent config ⇒ inert (404 as today). Now:
  `distributedExecutionEnabled` AND `TRUTH_ROUTE_ENABLED=1` AND a matching bearer.
- ★ **[Img-3 / Cred-3, MED — calibration] "B1-F1 closed" means DIRECT-PROBE closed, NOT transit-interception.** A
  worker CANNOT obtain the bearer from config (verified: it is on the AM + CP envs only, not on any worker service,
  not derivable) — so the direct-probe vector is genuinely closed. BUT control-net is FLAT (`internal:true` blocks
  external egress only; all 7 services share it, no mTLS), so a PRIVILEGED compromised worker (CAP_NET_RAW) could
  MITM/replay the cleartext bearer — and likewise SNIFF the cleartext model key on the worker→AM credential hop (the
  provider-wire codec is a bare `JSON.stringify`, no wire-key filter). Both are deferred to the filed mTLS follow-up.
  **Acceptable for the E7-1 controlled first proof — REQUIRED mitigations: staging uses DISPOSABLE / non-production
  provider keys, and mTLS stays a HARD production gate.** The credential hop's Slice-5 protections are control-net
  `internal:true` + the owned-labels capability gate (authz) + per-run redaction + shortest-lived materialization.
- **File the mTLS follow-up** (a new E11/E6 ticket or graph-inert slug): real client-cert mTLS on both hops (a
  TLS-terminating CP listener for the truth route + AM client-cert presentation), the durable auth the B1-F1
  deferral names. A HARD production gate, out of scope for this unit.

## S45.4 — P4: the credential made leak-proof (Slice 4 = (i); session code)

- **Do NOT rebuild the crossing.** The worker-side mechanism ships inert (Slice 2a): `synthesiseRunSecrets`
  (`secret-redemption.ts:135-165`) folds the redeemed Company key into `env[PROVIDER_AUTH_ENV_TARGETS]`, pushes the
  value to the canary set, and it rides `create`'s `spec.env` opaquely; the capability rides separately (signed over
  labels only). β2's real host receives + forwards it to `provider.create`. This is all built.
- **★ [Cred-1, HIGH — review-found, orchestrator-verified] Close leak-axis #0 — the model key at rest in E2B
  METADATA.** `E2bSandboxProvider.create` writes the FULL env into E2B durable metadata:
  `e2b-provider.ts:200` — `[METADATA_KEYS.env]: JSON.stringify(spec.env)` (`__aoa_env`) — SEPARATELY from the
  necessary `envVars: spec.env` channel (`:207`). E2B stores metadata durably and returns it from
  `Sandbox.list()`/`getInfo()` → the tenant model key sits AT REST in E2B cloud metadata (queryable by anyone with
  E2B-side access — a shared account across tenants). Decision #104 forbids the value hitting a durable store. The
  copy is REDUNDANT: its ONLY reader is `inspect` (`e2b-provider.ts:337`, `parsed.env`), which the gated wire ALWAYS
  redacts (`owned-op-gate.ts` redactProjection → a 5-field literal, no env; `driver.ts` synthesizes `env:{}`); `list`
  drops it; the idempotency map rebuilds from labels, not metadata. The mock hid it (in-memory metadata). **Fix:
  strip the auth VALUES from the durable metadata write — but MIND TWO SEAMS** (verified): (a) the MOCK decodes fault/
  canary directives FROM `metadata[__aoa_env]` (`mock-transport.ts:84-85`, `decodeCreateFaults(decodeEnv(…))`) — so
  migrate the mock's fault decode to read `req.envVars` (which carries the same env), OR keep a value-free directive
  projection; (b) dropping the env empties `inspect.env` → the cleanup-authority redaction becomes VACUOUS — adjust
  the redaction-non-vacuous test accordingly. Recommended: migrate the mock to `envVars` + drop `metadata[__aoa_env]`
  entirely. Test: the metadata sent to the transport at `create` contains NO provider-auth value. (Also filed as a
  standalone chip — may land before C0; MUST land before the real transport goes live.)
- **★ [Cred-2 — HIGH/MED, review-found] Close leak-axis #1 — the unmodelled-error verbatim path (the wire crux).** The
  AM catch-all `server.ts:247` forwards ANY error via `encodeErrResponse`; and `RealE2bTransport.create` /
  `E2bSandboxProvider.create` / `gateCreate` have NO try/catch around the SDK call carrying `envVars` — so a raw SDK
  throw reaches `serializeError`, which forwards the message. ★ **`serializeError` has TWO unmodelled arms** (verified
  `codec.ts`): `err instanceof Error → {message: err.message}` AND the non-Error fallthrough `{message: String(err)}`
  — a crafted `throw "…"`/`{toString}` embedding `spec.env` uses the SECOND arm. **Fix: at the AM boundary
  (`server.ts:247` — AM-local, NOT the shared codec, so no other consumer is perturbed), map ANY error that is not a
  modelled wire class (`SandboxNotFoundError`, `SandboxEgressDeniedError`, `UnsupportedProviderOperation`,
  `ResourceNotAvailableError`, `WireProtocolError`) to a FIXED generic `WireProtocolError` BEFORE `encodeErrResponse`
  — dropping BOTH arms' raw text at once.** Modelled classes pass as-is (their messages are fixed-vocabulary — the
  provider maps SDK faults by `destinationClass`/no-arg, never `err.message`; review-confirmed). The driver's
  `reconstructError` is a pure amplifier of what the AM emits → the fix belongs on the ENCODE side. Mutation test:
  BOTH an `Error` AND a NON-Error throw whose message contains a planted secret → the wire response carries NO trace.
- **Preserve the 8 already-mitigated leak axes** (the review must re-confirm each in the REAL topology): worker event
  streams (canary), worker logs (never logs the value/err), AM logs (never logs the request body), the idempotency
  ledger (records `{sandboxId, resourceLabels}` only), the capability (labels only; never log `sig`), the resolve
  audit columns (exclude the value/capability), and the wire itself (cleartext — confidentiality is P3's job).
- **Optional belt-and-suspenders:** add `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` to
  `check-adapter-manager-boundary`'s `FORBIDDEN_CREDENTIAL_TOKENS` — ONLY if the AM genuinely never names them (it
  forwards `spec.env` opaquely, so it shouldn't). The review decides.

## S45.5 — session vs operator split (the C0 handoff)

- **SESSION CODE (this unit):** the Dockerfile + entrypoint (P1); the `index.ts`/`app.ts` mint-key load + wiring
  (P2); the bearer on the AM client + the CP truth-route pre-handler (P3); the leak-axis-#1 fence (P4); the compose
  env additions (the 3 AM boot envs + the bearer × 2, referencing operator-supplied `${AOA_STAGING_*}` values); the
  env-var docs; all tests.
- **OPERATOR (C0, NOT this unit):** generate the ed25519 keypair (private → CP `AOA_CONTROL_PLANE_SIGNING_KEY_FILE`,
  public → AM `/run/secrets/adapter-manager-cp-pubkey`); supply the `E2B_API_KEY` value + the E2B template; supply
  the bearer secret value; build/push the AM image; `docker compose up --wait` the minimal fleet.

## S45.6 — no new frozen surfaces

NO `worker-protocol` change (FROZEN). The provider-wire `create` env carries the value OPAQUELY (unchanged since
Slice 2a). The bearer is a new AM↔CP HTTP header (documented, not a frozen wire). The AM image is OUTSIDE the frozen
release-admission set. The `SandboxProvider` port (11 ops) is untouched.

## S45.7 — guards (the full terrain-mapped list; run the WHOLE `policy` AND `brand-check` set)

- **Image guards — additive, ZERO fire by default** (all hardcoded to `{control-plane, worker}`, none walk `docker/`):
  the combined-root `./Dockerfile` awk deps-stage is ALREADY paid (β2 COPYed `packages/adapter-manager/package.json`);
  `check-image-deps-stages` + `dockerfile-static` are OPT-IN (mirror-parity nicety — if we add the AM to their
  hardcoded `IMAGES`/reads, the deps stage must COPY EXACTLY the 7-package closure + we update the `.test.mjs`
  fixtures). Recommend opting in for least-privilege parity, but it is not required to land.
- **`check-staging-manifest` / `staging-manifest-invariants`** — the AM service is already fully specified;
  `checkAdmittedImageRefs` validates only the `image:` prefix (NOT that it's built); `checkProviderControlBoundary`
  stays green (name the pubkey secret `adapter-manager-cp-pubkey` — does NOT match the `/e2b|provider[-_]?c(tl|ontrol)/`
  regex; keep it AM-only; a bearer env on the CP is fine). **NO new service, NO new network** (the bearer is envs
  only) → `checkServiceSet` (exact 8) + `checkNetworkMatrix` (exact per-service nets) stay green.
- **`checkEnvDocumented` (`policy`) — EVERY new compose env KEY must be backtick-documented in
  `docs/deploy/environment-variables.md`.** The 3 AM boot keys are already documented; the NET-NEW bearer
  (`AOA_ADAPTER_MANAGER_TRUTH_SHARED_SECRET`, on both AM + CP) must be added.
- ★ **[Guard-1, HIGH] `brand-check` step 9 (a SEPARATE JOB, not `policy`) forces `AOA_CONTROL_PLANE_SIGNING_KEY_FILE`
  documentation UNCONDITIONALLY.** `pr.yml:676` greps the LITERAL `process\.env\.AOA_[A-Z_]+` over `server/src cli/src
  packages` and reds if any hit is absent from `environment-variables.md`. The mint-key load in `index.ts` adds
  exactly such a literal (mirroring `:930`'s documented `process.env.AOA_WORKER_SESSION_SIGNING_KEY`).
  `AOA_CONTROL_PLANE_SIGNING_KEY_FILE` is nowhere in code/docs today → **document it unconditionally** — this fires on
  the CODE read, NOT compose presence (my earlier "if it appears in a compose env" framing was WRONG). Document the
  CP-side bearer read too if it is a literal. ★ Run `brand-check`, not just `policy`.
- ★ **[Guard-2, LOW-MED] `check-gate-clause-wiring` — keep `E2bSandboxProvider` at EXACTLY 4.** The pin
  (`gate-clause-wiring.json`, `expectedReferences:4`) counts non-comment/non-import/non-test `\bE2bSandboxProvider\b`
  over `server/src`/`packages`/`cli`; P3 EDITS `adapter-manager.ts` (which holds 2 of the 4 refs) to thread the
  bearer — safe as written, but any 5th production naming reds `policy` silently. Do NOT name the symbol in the
  bearer/mint/fence code. (Honesty note: once Slice 5 lands the image + the CP-key compose env, the E7-1 gate's
  "no image/compose yet" REASON prose goes stale — update it for honesty; the count-based guard won't red.)
- **`check-secret-resolve-vectors`** — the model value must stay on the REPLY, NEVER in a `decideResolve` input or a
  decision-path `.select()` (as DEP-011 Slice 1 kept it). Unperturbed if we touch no decision path. The reaper
  projection guard (`verifyClassifyLeaseTruthProjection`) is untouched.
- **`check-adapter-manager-boundary`** — the `E2B_API_KEY` ban holds (scanned over RAW source incl. comments — do
  not name it); the bearer + the mint wiring live OUTSIDE the AM request-path allow-list (the bearer is in the bin +
  the CP route; the mint is in the server) → no import-boundary trip. IF we add the optional model-key token ban,
  update the guard + its test.
- **`check-guard-inventory` / `check-execution-census`** — fire ONLY if we add a new `scripts/check-*.mjs` or
  `scripts/*.test.mjs`. This unit adds neither (it edits existing guards' fixtures at most) → `--write` re-pin of
  `check-test-inventory` for the new `.test.ts` files, no census/inventory bump.
- **NO new package** → no combined-root COPY, no boot-roots. `check-boot-roots-provider-free` stays a no-op (the AM
  bin's fail-closed posture is TEST-COVERED-ONLY, by design — recorded in β2.6).
- ★ **[Guard-3] KEEP the `docker/images/{build,sbom,sign}.sh` edits OUT of the session/inert PR.** Producing/signing
  the AM image AUTO-GENERATES an `allowlist.json` entry, and the AM is deliberately OUTSIDE the frozen
  `RELEASE_ARTIFACT_CLASSES` 5-set — wiring the build scripts risks intersecting `check-release-admission`. Building
  is OPERATOR/C0 (§S45.5); the session ships only the Dockerfile + entrypoint (inert, unbuilt).

## S45.8 — fences

NO new compose service or network. NO release-admission entry (frozen set). NO `worker-protocol` change. The model
value is NEVER named/read by the AM (rides `spec.env` opaquely). mTLS is a FILED follow-up, not this unit. Ships
INERT: the image unbuilt-or-built-but-undeployed; the mint key absent ⇒ byte-identical reply; the bearer/CP config
absent ⇒ the truth route already 404s on the double-gate; the AM boot envs absent ⇒ the AM refuses (it isn't run in
CI). Result note in this doc (NO `DEP-012-*-result.md` unless the ticket's finding-ownership permits — confirm E6-F003
successor status first).

## S45.9 — sub-slicing

Five slices; **P2 + P4 are the security core**, P1 is independent, P3 couples the truth route, P5 is the deploy gate:
- **P1 (image)** — independent, inert; Dockerfile (+ WORKDIR, the ledger-volume/TMPDIR wiring) + entrypoint [+ opt-in
  closure guards]. NOT the build/sbom/sign.sh edits (Guard-3, operator/C0).
- **P2 (mint keypair)** — `index.ts` load (try/catch → loud-fatal-on-bad, scoped) + the 3 `app.ts` edits (arg + opts
  field + import). Test: mint↔verify parity (real keypair → gated create dispatches) + absent-key inert + present-but-
  bad ⇒ loud refusal.
- **P3 (bearer)** — the AM client header + the CP truth-route third arm (unset⇒404, timingSafeEqual-over-hashes) +
  the negative test + env docs.
- **P4 (leak-proofing)** — TWO items: (a) strip the model key from the E2B durable metadata write (migrate the mock's
  fault decode to `envVars`; adjust the redaction test); (b) the AM error-boundary fence (map unmodelled → generic
  BEFORE `encodeErrResponse`; mutation test with an Error AND a non-Error planted-secret throw).
- **P5 (the C0 matched-pair smoke tool)** — a session-built probe: CP mints with the mounted private key → AM verifies
  with the mounted public key → fail LOUD on mismatch. The operator RUNS it at C0 before the canary (the honest
  dead-path enforcement build-time tests cannot provide).
Freeze the bearer header name + the signing-key + metadata env/field names first (they cross the AM↔CP + compose
boundary). P4(a) may also land as the standalone chip before C0.

## S45.10 — review outcome (4-agent adversarial pass, 2026-08-30 — all findings folded above)

Four reviewers (credential-leak+#104; mint-keypair+dead-path; image+bearer deploy-blockers; missed-guard hunt+split),
each verified against source. The design's SOUND load-bearing claims were confirmed (the 7-package closure is exact;
curl/ca-certs/`apply-workspace-publish-config`/healthcheck/CMD all correct; the mint↔verify canonical/signature parity
+ label anchor are airtight; the P2 dead-path is real; the 8 wire/log/ledger mitigations hold; inert landing holds).
**3 HIGH + 5 MED + LOWs folded**; orchestrator-verified the two sharpest against source (the E2B metadata write
`e2b-provider.ts:200`, its lone `inspect` reader + the mock's `decodeCreateFaults(decodeEnv(metadata))` seam
`mock-transport.ts:84`; the `serializeError` two-arm codec):

- **[Cred-1, HIGH]** the model key at rest in E2B durable metadata — redundant, but with TWO seams (the mock fault
  decode + the redaction-non-vacuous test) → strip the values, migrate the mock to `envVars` (S45.4). Also a chip.
- **[Mint-1, HIGH]** the dead-path enforcement was a false claim (build-time tests can't see a mismatched/half-wired
  DEPLOY; the uniform error hides it) → a C0 matched-pair smoke tool, fail-loud (S45.2/P5).
- **[Guard-1, HIGH]** `brand-check` step 9 forces `AOA_CONTROL_PLANE_SIGNING_KEY_FILE` docs UNCONDITIONALLY (code-read
  gate, a separate job my "run the whole policy set" line steered past) → document it; run brand-check (S45.7).
- **[Cred-2, MED]** the error fence must cover BOTH `serializeError` arms (`err.message` + `String(err)`) at the
  AM-local `server.ts:247` (S45.4).
- **[Mint-2, MED]** the private-key load must mirror the bin's try/catch → refuse; present-but-bad ⇒ LOUD fatal scoped
  to `distributedExecutionEnabled && key-set` (S45.2).
- **[Img-1, MED]** wire the idempotency-ledger dir to a writable node-owned volume or a read-only-root boot crashes
  (S45.1).
- **[Img-2, MED]** the bearer must fail-closed on UNSET secret (not `header===env`); timingSafeEqual over hashes +
  a negative test (S45.3).
- **[Img-3/Cred-3, MED]** "B1-F1 closed" = direct-probe only; transit MITM/sniff on the flat net → staging uses
  disposable keys, mTLS stays a hard follow-up (S45.3).
- **[Mint-3/4, LOW]** three edits (opts-type field + import); the `:497` arg a pre-resolved local (source-shape
  tests) (S45.2). **[Guard-2, LOW]** keep `E2bSandboxProvider` at 4; update the E7-1 reason prose (S45.7).
  **[Guard-3, LOW]** keep build/sbom/sign.sh out of the inert PR (S45.7).

**Session/operator split confirmed clean** (secret values + live build/deploy = operator; code + compose keys + docs +
tests = session). **Design is GO for the §9 build prompt** (sub-sliced P1–P5).

## S45.11 — build result (2026-08-30, BUILT + CI-green-locally, ships INERT)

All five pillars landed on `claude/dep-012-deploy-real-build-517aa1` (branched off `docs/replatform-program` tip
`f7d25665d`). Every claim in §S45 was re-verified against source before building; all findings held. Commits:

- **P1 `6c0957353`** — `docker/adapter-manager/{Dockerfile,entrypoint.sh}` (4-stage mirror of control-plane; curl +
  ca-certs; the exact 7-package closure; `apply-workspace-publish-config`; **[Img-1]** ledger + TMPDIR on a writable
  node-owned `/am` volume so a read-only root does not crash boot). Opted into `check-image-deps-stages` (+ 3 AM
  fixture tests) — the real guard MECHANICALLY confirms the deps COPY set == the runtime closure (7, sandbox-fake-
  provider excluded). **NOT** the build/sbom/sign.sh edits (Guard-3). Ships unbuilt (CI render-only).
- **P2 `f4b03e67f`** — the CP mint half: `index.ts` loads `AOA_CONTROL_PLANE_SIGNING_KEY_FILE` (the one env literal,
  documented) → `createApp` opts → `workerControlRoutes({controlPlaneSigningKey})` (**[Mint-3]** arg + opts field +
  `KeyObject` import; **[Mint-4]** a pre-resolved local). `loadControlPlaneSigningKey`
  (`config/control-plane-signing-key.ts`, drizzle-free + injectable fs seam) mirrors the AM bin's try/catch → refuse
  (**[Mint-2]**: encrypted/DER/RSA PEM throws a SCOPED refusal; present-but-bad ⇒ LOUD FATAL only when
  `distributedExecutionEnabled`, else inert). Test proves true mint↔verify parity (a real ed25519 key mints a cap the
  AM `verifyOwnedLabelsCapability` accepts; a mismatched public key is rejected) + every refuse path.
- **P3 `6a076d9fc`** — the AM↔CP shared-secret bearer. AM: bin reads `AOA_ADAPTER_MANAGER_TRUTH_SHARED_SECRET` via
  `env[CONST]` → header on the truth POST (never-rejects contract preserved: a mismatch ⇒ CP-404 ⇒ "unknown"). CP: a
  THIRD gate arm in `adapter-manager-control.ts`, logic in a drizzle-free `adapter-manager-control-auth.ts`
  (**[Img-2]** fail-closed on UNSET secret; `timingSafeEqual` over SHA-256 hashes — no length leak/throw). Negative
  tests: route enabled + no bearer configured ⇒ 404; wrong ⇒ 404; match ⇒ pass. mTLS filed as a HARD production
  follow-up (see below).
- **P4 `04bce3daa`** — **[Cred-1]** stripped `[METADATA_KEYS.env]` from the durable E2B metadata write
  (`e2b-provider.ts`); the mock decodes create-faults from `req.envVars`; two white-box captures (the crossing test +
  the two redaction-non-vacuous tests) migrated metadata→envVars (kept non-vacuous via `command`); new `cred-at-rest`
  test. **[Cred-2]** an AM-local fence at `server.ts`'s catch maps any non-modelled error → a FIXED generic
  `WireProtocolError` before encode, via an additive `isModelledWireError` predicate in provider-wire (server.ts is
  boundary-barred from the provider error classes); mutation test (an `Error` AND a non-`Error` planted-secret throw
  leave no trace; modelled classes pass). `gate.test`'s B2-correction property (transient ≠ uniform refusal) still
  holds — the driver already reconstructed a raw `Error` to `WireProtocolError`, so no consumer behaviour changed.
- **P5 `6fc706d81`** — `pnpm verify:cp-am-keypair` (`server/src/cli/verify-cp-am-keypair.ts`): the operator's C0
  matched-pair smoke (**[Mint-1]** — build-time tests cannot see the deployed combination; a mismatch collapses to the
  uniform error). Mints a probe cap (dummy tuple, no tenant/provider/DB touch) with the mounted private key, verifies
  with the mounted public key, exits LOUD non-zero on mismatch. Smoke-tested: matched ⇒ exit 0, mismatched ⇒ exit 1.
- **Wiring `5925f5b2d`** — staging compose envs (3 AM boot + bearer×2 + CP mint key, NO new service/net), env docs
  (the mint key + bearer), the E7-1 reason-prose honesty refresh (count stays 4), and the sandbox-e2b-provider
  test-inventory pin 9→10 (floor-mode trees left untouched — a `--write` would have tightened unrelated floors).

**Verification (local):** package tests green — provider-wire 28, sandbox-e2b-provider 46 (incl. cred-at-rest +
adjusted redaction), adapter-manager 149 (incl. error-fence + fixed crossing/gate); server: control-plane-signing-key
7, adapter-manager-control-auth 10, the source-shape tests (rollout-rollback-liveness, desktop-disabled.negative,
job-leasing-contract, tenant-app-db-startup, job-fence-surface) all green. `pnpm --filter @armyofagents/server
typecheck` clean. Guards green: the whole `policy` set (adapter-manager-boundary, sandbox-e2b-provider-boundary,
gate-clause-wiring [E2bSandboxProvider = 4], staging-manifest [+31 invariant tests], image-deps-stages [+ AM fixtures],
secret-resolve-vectors, test-inventory, guard-inventory, execution-census, boot-roots, embedded-secrets on
docker/adapter-manager, …) **and** brand-check step 9 (env-doc completeness — nothing missing). The full CI run lands
when the PR opens (not run in this session).

**Ships INERT:** the AM image is unbuilt (CI render-only); an absent mint key ⇒ a byte-identical resolve reply; an
absent bearer / disabled truth route ⇒ 404; the AM boot envs are absent outside staging (the bin is not run in CI).

**Owed to the C0 operator runbook (flag for the orchestrator):**
1. Generate ONE ed25519 keypair: private → CP `/run/secrets/control-plane-signing-key`
   (`AOA_CONTROL_PLANE_SIGNING_KEY_FILE`), public → AM `/run/secrets/adapter-manager-cp-pubkey`
   (`AOA_ADAPTER_MANAGER_CONTROL_PLANE_PUBLIC_KEY_FILE`). Supply `AOA_STAGING_E2B_TEMPLATE`, the `E2B_API_KEY`, and the
   `AOA_STAGING_ADAPTER_MANAGER_TRUTH_SHARED_SECRET` bearer (same value on AM + CP).
2. **Run `pnpm verify:cp-am-keypair` against the REAL mounted files BEFORE the canary** — it fail-LOUDs on a
   mismatched/half-wired pair (the honest dead-path enforcement build-time tests cannot provide).
3. Build + push `aoa-adapter-manager:staging` (P1 image) and `docker compose up --wait` the minimal fleet.
4. **Staging MUST use DISPOSABLE / non-production provider keys**: peer-auth is a shared-secret bearer + control-net
   `internal:true` for this first proof; the flat control-net leaves a privileged compromised worker able to MITM the
   cleartext bearer / sniff the model key on the worker→AM hop. **Real client-cert mTLS on both hops is a REQUIRED,
   FILED hard production gate** (a TLS-terminating CP truth listener + AM client-cert presentation) — out of scope for
   this unit; do not flip to production keys until it lands.
