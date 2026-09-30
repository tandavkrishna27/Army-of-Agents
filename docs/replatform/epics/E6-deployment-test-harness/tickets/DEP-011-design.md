# DEP-011 — The containerized worker→provider networked wire (E6-F003 successor)

**Epic:** E6 · **Plan node:** `docs/replatform/program-design.md`, `#### DEP-011`
**Depends on:** DEP-010 · **Size:** (scope only) · **Status:** scoping
**Owns:** finding **E6-F003** (`epics/E6-deployment-test-harness/findings.md`)

---

## Why this ticket exists

DEP-010 (Sprint 2) named the authoritative provider **port** (the per-op `SandboxProvider`) and
gave the **desktop/self-hosted** lane a real provider via `worker-keystore/src/bin/sandbox-provider.ts`.
It **deferred** the other half of E6-F003: the networked **wire** a *containerized* worker's provider
driver speaks to `adapter-manager`. This ticket is that successor. It is filed **now**, at DEP-010's
completion, so E6-F003 is not left `owned` by a shipped ticket — which reads as owned by nobody and
fails nothing (finding **E4-F013**). DEP-010 repoints E6-F003's manifest `ticket` to this id.

## What it must build (design written at sprint start, against the tree as it exists then)

The request/response shapes and client a container worker's provider driver speaks to
`adapter-manager` over **`control-net`** (NOT `provider-ctl-net`, which is adapter-manager-only and a
hard `PROVIDER-CONTROL VIOLATION` for a worker — and note `docker-compose.d1.yml` overloads that name
to mean the opposite; DEP-010 design §2.1). A container worker cannot use the desktop provider path,
because `E2B_API_KEY` on a worker is forbidden (§2.5), so its provider must be networked, not
key-backed.

## Precondition — when this becomes REQUIRED, not before

The moment a containerized worker under `docker-compose.staging.yml` must dispatch. Today there is no
consumer: `adapter-manager` has **zero implementation**
(`DECISION-byte-egress-and-provider-topology.md` §4 residual 4.2), and no worker dispatches (flag
default-off, no `compose:true` branch). Specifying a wire against an unimplemented peer for an unbuilt
caller is the failure this programme keeps re-learning — hence the deferral. E6-F003 stays **open**
(HIGH; a HIGH may never be `accepted`) and this ticket owns it until the wire is built.

## Status

**Design OPEN (2026-08-29).** The precondition is now SATISFIED: DEP-012 Wave β2 shipped the real
`adapter-manager` host (the fail-closed composition-root bin + the boundary guard), so the wire's peer
EXISTS and DEP-011 is unblocked. The stub above (line 30, "adapter-manager has zero implementation") is
STALE. This section is the full design, SLICED (β2's lesson: a large unit ships as small,
independently-CI-verifiable, inert slices).

---

# DEP-011 — the slice plan (2026-08-29)

DEP-011 folds in THREE coupled pieces + a deploy tail. Sliced by risk + produce-before-consume:

- **Slice 1 — the server-side MINT** (this section). Fold `signOwnedLabelsCapability` into the
  `resolveExecutionSecret` ALLOW-path reply, over the 7-field labels the server already has
  device-proof-verified (`worker-fence-context.ts` `resolveWorkerFenceContext`, already called at
  `secret-broker.ts:236`). Ships INERT — the reply carries a capability nothing consumes yet (the Unit-A
  "wire before gate" pattern). Security-critical + contained. Test CP keypair; the real one is deploy.
- **Slice 2 — the worker networked composition root + per-run provider factory + the credential
  crossing.** The biggest slice — **SUB-SLICED 2a/2b** (recon 2026-08-29):
  - **2a (the meat, security-critical, CI-verifiable inert):** an additive `makeRunProvider?` per-run
    provider FACTORY (a TYPE in worker-daemon; the impl comes from the outside root) + the worker-side
    capability threading (`classifyResolveResponse` reads the minted cap Slice 1 now puts on the reply →
    `synthesiseRunSecrets`/`materializeRunSecrets` carry + **dedup N→1** → the supervisor builds a per-run
    `NetworkedProviderDriver` + BOTH authorities **inside `runLifecycle` AFTER redemption**, because the
    capability does not exist at `buildRun`) + the credential crossing (#104) — proven on an IN-PROCESS
    loopback gated `createProviderServer` inside a worker-daemon `.test.ts`. Ships INERT (worker-daemon
    still passes nothing). Flips no gate.
  - **2b (composition root + guards):** a NEW package `packages/worker-networked-host` + bin reading
    `AOA_WORKER_PROVIDER_URL`, building the factory of `NetworkedProviderDriver`s (worker-keystore CANNOT —
    its 3-dep pin forbids importing `provider-wire`); extend `BIN_DIRS` + register in
    `boot-roots-expectation.json` (resolver-posture default-none); document the env. Depends on 2a.
  Boundary-clean throughout (worker-daemon sees only the factory TYPE; the driver + root live OUTSIDE the
  daemon's pinned 2-dep boundary). The redeemed model key crosses `create`'s `env` over the wire —
  `FORBIDDEN_WIRE_KEYS` cannot guard it (its forbidden key `env` IS the field that must cross), so #104
  rests on the per-run canary registered BEFORE the networked create + never logging the create payload;
  mTLS is Slice 5.
- **Slice 3 — the `(compose)` CleanupAuthority variant + the reconcile idempotent-inversion guard.** A
  no-op/trust cleanup variant (the worker-side `labelsEqual` is vacuous own-vs-own — the server gate owns
  the decision), plus guarding `reconcile.ts:93` against a gate-thrown `ResourceNotAvailableError` (an
  already-gone id INVERTS from a returned `CleanupResult` to a throw over the gate, aborting the sweep).
- **Slice 5 (= DEP-012 Slice 5, the user's "next")** — deploy: the AM image, the compose
  `AOA_WORKER_PROVIDER_URL` + control-plane-public-key env, amending `checkDispatchDefaultOff` at go-live,
  mTLS on the worker→AM control-net hop, and the real control-plane keypair.

---

# Slice 1 — the server-side owned-labels-capability mint (in the resolve reply)

**Status:** design (2026-08-29) — **3-agent adversarial review COMPLETE; all findings verified against source
and folded in below.** Ships INERT. The review reshaped Slice 1: it is NOT just "add a mint call" — it needs
(a) a PACKAGING extraction (the pure primitive → a leaf, or the control-plane image closure reds), (b) the mint
sited INSIDE the broker tenant-tx closure (the reply assembler can't build 2 of the 7 labels), (c) a fresh
7-field object literal (a `{...fenceIdentity}` spread leaks the FENCE TOKEN), (d) `ResolvedFenceContext` extended
to surface the lease deadline, (e) NO `DEP-011-*-result.md` (it would red `check-finding-ownership`). The review
outcome is §1.12.

## 1.1 — verified terrain (corrected against source)

- **The resolve reply** (`server/src/services/execution-secret-resolve.ts`): the ALLOW outcome is
  `{ outcome:"resolved", envTarget, value }`; every refusal is the coarse `{ outcome:"denied", reason }`
  (`:95-133`, `:27-29`). ★ But the reply ASSEMBLER `admitSandboxLocalResolution` (`:110-134`) is PURE — it
  receives only the broker `SecretResolveOutcome`, and the request schema (`:44-56`) has NO
  `targetId`/`targetGeneration`. So the fence labels are NOT in scope at the assembler (review H4).
- **The mint site is the broker tenant-tx closure, not the reply assembler.** `resolveWorkerFenceContext`
  (`worker-fence-context.ts`) returns `ResolvedFenceContext = { fenceIdentity, companyId, authorityNow }`
  (`:25-31`) — the device-proof-verified identity lives ONLY inside `createSecretBrokerService.resolve`'s
  `runInTenant` closure (`secret-broker.ts:234-258`), and the redeemed `value` materializes there too
  (after `dispatchResolvedSecret`, `:264-273`). `secret-broker.ts:236` ALREADY calls
  `resolveWorkerFenceContext`. So the mint is sited at the broker FINALIZE point; the capability rides the
  `resolved` `SecretResolveOutcome` arm out through the pure assembler untouched.
- **★ `fenceIdentity` is `ActiveFenceRequest` — it carries TWO secrets beyond the 7 labels** (review H2):
  `fence` (the live per-attempt bearer TOKEN, `job-fence.ts:447`), `targetAuthorityKey`, `profileHash`,
  `providerConstraintHash`, `companyId`, `attemptId` (`:434-448`). `labelsEqual` compares ONLY the 7 named
  fields with `===` (subset-blind, `provider.ts:131-142`); the signed canonical picks only the 7
  (`capability.ts:65-74`). So a `{...fenceIdentity}` spread would leak the fence token into `ownedLabels`
  → into the worker reply, and EVERY test in the naive suite (labelsEqual, a value-only scan) stays green.
- **★ The field NAMES differ** (review H1): `ActiveFenceRequest` has `attemptNumber` + `targetGeneration`
  (+ a decoy `attemptId: string`), NOT `attempt`/`deviceGeneration` (`job-fence.ts:438-444`). The target
  `ResourceLabels` needs `attempt`/`deviceGeneration`. The map is `attempt ← attemptNumber`,
  `deviceGeneration ← targetGeneration`.
- **★ The lease deadline is NOT surfaced** (review H3): `resolveWorkerFenceContext` checks
  `context.lease.expiresAt` (`:109`) then DISCARDS it — `ResolvedFenceContext` returns only `authorityNow`
  (a DB clock, `:30`). Bounding the expiry (§1.4) REQUIRES extending that return to carry the deadline.
- **The mint primitive** `signOwnedLabelsCapability(fields, privateKey)` (`capability.ts:84`) — Ed25519
  over the ordered tuple; REJECTS a non-integer `expiresAt` (`:92-94`). NO production caller today — Slice
  1 is the FIRST; it is NOT a gate-clause-wiring symbol. ★ It lives in `@armyofagents/provider-wire`,
  whose RUNTIME deps are `worker-daemon` + `sandbox-e2b-provider` + `worker-protocol`
  (`provider-wire/package.json:35-38`) — see §1.2.0 (the packaging problem, review H5).
- **The verify side already ships** (β2): `adapter-manager` accepts the optional injected
  `controlPlanePublicKey` + fail-closes; the create-gate (β1) enforces
  `labelsEqual(spec.resourceLabels, cap.ownedLabels)`. ★ Verify RE-canonicalizes the received `ownedLabels`
  (`capability-verify.ts:65`), so a drifted-but-self-consistent tuple still VERIFIES — a coercion/field
  drift is caught ONLY at the gate's `labelsEqual` against the WORKER's tuple, never at verify. §1.9 must
  assert BOTH.
- **The parity target** — the worker's `labelsFor(handoff)` (`supervisor.ts:205-214`, a closure-local
  inner function, NOT exported) is the EXACT tuple that becomes `spec.resourceLabels`: `organizationId:
  String(job.organizationId)`, `targetId: identity.targetId`, `workerId: String(offer.workerId)`, `jobId:
  String(job.jobId)`, `attempt: job.attempt` (a NUMBER), `leaseId: handoff.leaseId`, `deviceGeneration:
  identity.deviceGeneration` (a NUMBER). Value-parity across the two stores rests on the ack-current pins
  `worker.deviceGeneration === auth.targetGeneration === target.deviceGeneration` (`job-leasing.ts:256-268`),
  not on the mint (review E).

## 1.2.0 — ★ THE PACKAGING PROBLEM (review H5 — do this FIRST)

The server (the CONTROL-PLANE image) cannot import `signOwnedLabelsCapability` from `provider-wire`: that
edge drags `worker-daemon` + `sandbox-e2b-provider` into the control-plane runtime closure, which
`docker/control-plane/Dockerfile` deliberately excludes ("server + UI ONLY … NO worker daemon", `:3,:8`)
and `check-image-deps-stages.mjs` enforces exact ("no fewer, and NO MORE", `:6-13`). So Slice 1 FIRST
EXTRACTS the PURE primitive — the `OwnedLabelsCapability` type + the version/audience consts +
`buildOwnedLabelsCapabilityCanonical` + `signOwnedLabelsCapability` (runtime dep = `node:crypto` ONLY;
`ResourceLabels` is a TYPE-only import → `worker-daemon` a devDep, never a runtime dep) — into a NEW LEAF
package `@armyofagents/provider-capability`. `provider-wire/capability.ts` + `adapter-manager`'s
`capability-verify.ts` RE-IMPORT from the leaf (behavior-preserving — the ONE shared canonical is
preserved, so mint↔verify parity holds); the SERVER imports the leaf directly. The control-plane image
deps-stage then COPIES exactly ONE new workspace pkg (the leaf, closure = node:crypto), never
worker-daemon. This is a mechanical RE-HOME of the B1-frozen primitive (same bytes, same behavior — a
mint↔verify byte-parity test proves it), NOT a schema change. Touch-points: a new `packages/provider-capability/`
(+ `projects[]`, tsconfig refs), the two re-import edits, `server/package.json` gains the leaf as a runtime
dep + `provider-wire` stays put, the `docker/control-plane/Dockerfile` deps-stage COPY + `check-image-deps-stages`.

## 1.2 — what Slice 1 builds

INSIDE `createSecretBrokerService.resolve`'s tenant-tx closure, at the finalize point (`secret-broker.ts:264-273`)
after `dispatchResolvedSecret`, on the outcome that is EXACTLY `resolved ∧ seam === "sandbox_local_only"`
(review M2 — NOT "not denied"; `device_handoff` and the network seams carry NO capability): mint an
`OwnedLabelsCapability` over a FRESH 7-field object literal built from `ctx.fenceIdentity` (§1.3) +
`expiresAt = min(authorityNow + TTL, leaseDeadline)` (§1.4), signed with an INJECTED control-plane Ed25519
private key (on the `createSecretBrokerService` constructor, `worker-control.ts:157`; a TEST keypair for the
component, the REAL key deploy-owed). Carry the capability on the `resolved` `SecretResolveOutcome` arm →
widen `admitSandboxLocalResolution` + the route JSON to pass it through UNTOUCHED. When NO key is configured
the capability is OMITTED — NEVER fail the resolve. Ships INERT (the worker reads the reply as a plain
record and ignores unknown keys — `secret-redemption.ts:87-102`, verified; the server reply has NO response
schema — `worker-control.ts:749-755`).

## 1.3 — ★ THE MINT ≡ labelsFor PARITY INVARIANT + the fresh-literal rule (central correctness + containment)

The gate enforces `labelsEqual(spec.resourceLabels, cap.ownedLabels)`, and `spec.resourceLabels` IS
`labelsFor(handoff)`. So the minted `ownedLabels` MUST equal `labelsFor` field-for-field, or the gate
rejects EVERY networked create (silent, total dispatch failure). Build it as a **FRESH 7-field object
literal — NEVER `{...ctx.fenceIdentity}`, NEVER `as ResourceLabels`** (the cast silences excess-property
checking and leaks the fence token, review H2). The exact map + coercions:
```
{ organizationId: String(fenceIdentity.organizationId),
  targetId:       fenceIdentity.targetId,
  workerId:       String(fenceIdentity.workerId),
  jobId:          String(fenceIdentity.jobId),
  attempt:        fenceIdentity.attemptNumber,      // NUMBER — do NOT String()
  leaseId:        fenceIdentity.leaseId,
  deviceGeneration: fenceIdentity.targetGeneration } // NUMBER — do NOT String()
```
(String the same three the worker does; keep `attempt`/`deviceGeneration` numeric; `labelsEqual` is strict
`===`, `provider.ts:131-142`, so a number/string drift is fatal.) The anti-drift proof is an INTEGRATION
harness (review M1 — `labelsFor` is not importable): drive ONE real `createSupervisor` `create` against the
existing recording fake (`__tests__/support/fake-provider.ts`), CAPTURE `spec.resourceLabels` (which
`createSpecFor` passes to `provider.create`, `supervisor.ts:229-235,371`), build the server `fenceIdentity`
from the SAME job/lease/target row, and assert `labelsEqual(minted.ownedLabels, capturedSpec.resourceLabels)`.
Use DISTINCT per-field fixture values (esp. `attempt != deviceGeneration`, both numbers; org/target/worker/
job/lease all different) so a field-swap / wrong-source mutation is actually killed (the "identity map diffed
a copy of itself" trap).

## 1.4 — expiry bounding (requires extending ResolvedFenceContext)

`expiresAt = min(authorityNow.getTime() + shortTtlMs, leaseDeadline)` — finite integer (the primitive
rejects otherwise) AND clamped to the lease deadline (a token must not outlive the lease it authorizes).
`authorityNow` (a DB `currentDatabaseTime()` Date, `:76`) is the injected clock; the lease deadline is NOT
in scope today, so Slice 1 ADDS `leaseDeadline: context.lease.expiresAt` (Date→ms) to `ResolvedFenceContext`
(`worker-fence-context.ts:25-31,:135`) — a small change to a shared DAT-002 function (also used by
artifact-commit / transfer-grant; additive, no behavior change to them). Test: a lease with deadline D →
`expiresAt <= D.getTime()`; a too-long TTL is clamped to D (not `now+TTL`). Pinning to D also makes the N
per-handle mints (§1.7) byte-identical, so Slice 2's dedup is trivial (review L1/M-per-handle).

## 1.5 — the positive mint gate + no leak on the refusal paths

The mint fires on EXACTLY `outcome.outcome === "resolved" && outcome.seam === "sandbox_local_only"` (review
M2) — the SAME predicate `admitSandboxLocalResolution` admits (`execution-secret-resolve.ts:116,119`). The
THIRD outcome `device_handoff` (the desktop keystore path, `secret-broker.ts:115-118`) and the `fence_proxy`/
`remote_server_fenced` seams carry NO capability. Every `denied`/`malformed` carries none (coarse refusal
preserved). `check-secret-resolve-vectors` re-derives only the DECISION (never the reply/capability,
`:79-233`) → unperturbed, no fixture change (review F6, SOUND).

## 1.6 — Decision #104 (TWO secrets in scope, not one)

The mint site has BOTH the redeemed model `value` AND the fence bearer token (`fenceIdentity.fence`) +
`targetAuthorityKey`/`profileHash`/`providerConstraintHash` in scope. The capability is signed over the 7
LABELS ONLY (`capability.ts:65-73`); the fresh-literal rule (§1.3) keeps everything else out of
`ownedLabels`; `sig`/`value`/the token are never logged. The token authorizes; the redeemed `value` (Slice
2) rides `create`'s `env` — independent, same reply.

## 1.7 — per-handle multiplicity (resolved)

The resolve route is hit once per secret handle (`secret-redemption.ts:119-123`), so a run mints N times.
With `expiresAt` pinned to the lease deadline (§1.4) all N mints are BYTE-IDENTICAL; the worker (Slice 2)
uses any. A real coding run has ≥1 model-key handle (`PROVIDER_AUTH_ENV_TARGETS`), so N≥1 and the
zero-handle gap is out-of-scope for the E7-1 journey. Ordering is safe: `materializeRunSecrets` (step 0)
runs BEFORE `provider.create` (step 1) (`supervisor.ts:335-371`), so the capability is in hand before the
gated create (review SOUND).

## 1.8 — fences (what Slice 1 does NOT touch)

The worker/daemon (Slice 2); the `NetworkedProviderDriver` (built); the `adapter-manager` server/gates/
ledger (β1/β2); the CleanupAuthority variant + reconcile guard (Slice 3); the frozen worker-protocol +
`SandboxProvider` port; the capability SCHEMA/CANONICAL/SIGNER BEHAVIOR (`v:1`, B1 — §1.2.0 is a RE-HOME,
not a change). NO real control-plane keypair (deploy/Slice 5 — injected key, absent ⇒ inert). NO mTLS, NO
compose change. NO worker-side change. **NO `DEP-011-*-result.md`** (review H6 — it would mark DEP-011
"shipped" and red `check-finding-ownership`; the Slice-1 result is captured in this design doc + the go-book
+ memory). E6-F003 stays OPEN + owned by DEP-011.

## 1.9 — TDD + component test (inert, fail-first)

1. Packaging (§1.2.0) FIRST: extract the leaf; RED a mint↔verify byte-parity test (the leaf's canonical ≡
   the prior output); re-home the two re-imports; `check-image-deps-stages` green (control-plane closure
   grew by the leaf ONLY, no worker-daemon).
2. RED: on the resolve ALLOW path (`resolved ∧ sandbox_local_only`) with an injected test CP key, the
   `resolved` reply carries a capability that (a) VERIFIES against the test CP public key, AND (b) has
   `ownedLabels` `labelsEqual` to the CAPTURED real `spec.resourceLabels` (§1.3 harness — assert BOTH; verify
   alone is subset/self-consistent-blind), (c) `Object.keys(ownedLabels).sort()` === the exact 7-key set
   (backstops labelsEqual's subset-blindness — kills the fence-token leak), (d) finite `expiresAt <= the
   real lease deadline`, (e) ABSENT when no CP key is configured (inert), (f) ABSENT on `device_handoff` /
   `denied` / `malformed`.
3. #104 containment (SERVER-side, review M3): spy the resolve-path logger — assert it NEVER receives the
   reply/capability/`sig`/`value`; assert the audit columns exclude the capability (the audit UPDATE runs
   BEFORE the mint, `job-control.ts` mutator — verified-safe, the test locks it); assert the capability
   bytes contain NEITHER the redeemed `value` NOR the fence token / `targetAuthorityKey` / `profileHash` /
   `providerConstraintHash`. (Do NOT rely on the worker event-body scan — wrong side of the wire.)
4. Mutation sweep: `{...fenceIdentity}` spread (the 7-key + token-scan tests kill it); drop a `String()` /
   stringify `attempt` (the labelsEqual harness kills); `deviceGeneration ← attemptNumber` swap (distinct
   fixtures kill); mint on `device_handoff`/denied (the absence tests kill); `now+TTL` unclamped (the
   deadline test kills); a capability logged (the logger spy kills).

## 1.10 — guards (run the WHOLE set — β2's lesson: the design's own list missed two)

- **`check-image-deps-stages`** — the reason for §1.2.0. WITHOUT the leaf extraction, the server→provider-wire
  edge reds the control-plane closure. WITH it, green (closure grows by the node:crypto-only leaf). MUST be
  planned, not disclaimed.
- **`check-finding-ownership`** — Slice 1 ships NO `DEP-011-*-result.md` (else `successor_missing` on E6-F003,
  which has `ownerStillOpen` + no `successor`, `finding-ownership.json:9-13`). DEP-011 stays uncompleted.
- **`check-secret-resolve-vectors`** (green, decision-only, unperturbed); **`check-gate-clause-wiring`**
  (`signOwnedLabelsCapability` not a gated symbol; NO `E2bSandboxProvider` named → E7-1 stays `unwired` at 4);
  **`check-test-inventory`** (--write re-pin for the new server + leaf tests); a NEW package →
  `projects[]`/tsconfig graph coverage. NOT boot-roots (no worker boot). Run the WHOLE policy set locally.

## 1.11 — result note (BUILT 2026-08-29 — IN THIS DOC, not a -result.md; E6-F003 stays OPEN + owned)

**Slice 1 SHIPPED INERT, CI-verified.** The control plane now mints a signed Ed25519
`OwnedLabelsCapability` on the `resolved ∧ sandbox_local_only` `resolveExecutionSecret` reply,
behind an INJECTED control-plane key. No key is wired in `app.ts` today (deploy/Slice 5), so the
reply is byte-identical to pre-DEP-011 and nothing consumes the capability yet (Slice 2).

**What landed:**
- **Packaging (§1.2.0):** new leaf `@armyofagents/provider-capability` (`packages/provider-capability/`,
  runtime dep = `node:crypto` ONLY; `ResourceLabels` a TYPE-only devDep on worker-daemon). The B1
  primitive (schema + `buildOwnedLabelsCapabilityCanonical` + `signOwnedLabelsCapability` + version/
  audience consts) was moved VERBATIM; `provider-wire/src/capability.ts` now RE-EXPORTS the leaf, so
  the ONE shared canonical is preserved (a byte-parity anchor test pins the exact canonical string).
  Server gains the leaf as a RUNTIME dep + a `docker/control-plane/Dockerfile` deps-stage COPY;
  `check-image-deps-stages` GREEN (control-plane closure grew by the leaf ONLY — never worker-daemon).
- **The mint (§1.2–§1.6):** `server/src/services/owned-labels-mint.ts` — `ownedLabelsFromFenceIdentity`
  (a FRESH 7-field literal, field-name map `attempt←attemptNumber`/`deviceGeneration←targetGeneration`,
  String() the three the worker strings, numeric attempt/deviceGeneration) + `applyOwnedLabelsCapability`
  (the positive gate: mints ONLY on `resolved ∧ sandbox_local_only` with a key; never throws) +
  `mintOwnedLabelsCapability` (expiry = `min(now+TTL, leaseDeadline)`, a finite integer). Wired into the
  broker tenant-tx finalize point (`secret-broker.ts`), carried on the `resolved` `SecretResolveOutcome`
  arm, passed through `admitSandboxLocalResolution` + the route JSON UNTOUCHED (present only when minted).
- **Expiry (§1.4):** `ResolvedFenceContext` extended with `leaseDeadline: context.lease.expiresAt`
  (additive; artifact-commit / transfer-grant ignore it).
- **Key injection:** optional `controlPlaneSigningKey` threaded `workerControlRoutes` opts → broker.
  `app.ts` unchanged (key undefined ⇒ inert).

**Tests + mutation:** leaf 15 (incl. byte-parity anchor) · provider-wire 28 · adapter-manager 99 (incl. an
explicit leaf-minted→verify crossing) · server `owned-labels-mint.test.ts` 11 · worker
`supervisor-labels-parity.test.ts` 1 (captures the REAL `labelsFor` from a live `createSupervisor` create).
Mutation sweep 6/6 killed: `{...fenceIdentity}` spread (5 fail — 7-key + #104 scan + parity + verify);
stringified `attempt` (3 fail); `deviceGeneration←attemptNumber` swap (3 fail); dropped seam guard (1 fail);
unclamped `now+TTL` (1 fail); device_handoff/denied mint (absence tests). Whole `policy` set GREEN
(`check-image-deps-stages`, `check-secret-resolve-vectors` unperturbed, `check-gate-clause-wiring` untripped +
E7-1 stays `unwired` at 4, `check-finding-ownership` GREEN with NO result doc, `check-adapter-manager-boundary`,
`check-dependency-graph`, `check-test-inventory` re-pinned). Full graph typecheck GREEN.

**Parity harness — realized as TWO anchored halves (deviation from §1.3's single-test wording, see §1.13).**
The recording fake is worker-daemon test-support (NOT barrel-exported) and worker-daemon's 2-dep boundary
forbids importing the server mapping, so the single cross-package `labelsEqual(minted, capturedSpec)` test
§1.3 describes is not importable as written. Instead: a worker test CAPTURES the real `spec.resourceLabels`
from a live supervisor create and pins it to an explicit DISTINCT-valued tuple (`attempt=1 != deviceGeneration=7`,
both numbers; org/target/worker/job/lease all different); the server test proves `ownedLabelsFromFenceIdentity`
reproduces the SAME tuple from a full `ActiveFenceRequest`. A field-swap on EITHER side diverges from the
anchor. Byte-parity of the leaf re-home is separately proven (the exact-canonical-string anchor + the 99
adapter-manager verify tests + an explicit leaf-mint→AM-verify test).

## 1.13 — build deviations from the design (repo contradicted §1.2.0/§1.3; reported, not papered over)

1. **`capability-verify.ts` kept on the `@armyofagents/provider-wire/capability` SUBPATH, not re-homed to
   the leaf directly.** §1.2.0 said re-home both consumers to the leaf. But the β2 `check-adapter-manager-boundary`
   guard (shipped AFTER §1.2.0 was written) enforces adapter-manager's runtime `dependencies` as an EXACT set
   {provider-wire, sandbox-e2b-provider, worker-daemon} AND forbids any new runtime import in its source — so a
   direct leaf import RED-ed policy. The design's INTENT is nonetheless fully met: `provider-wire/capability.ts`
   now re-exports the leaf VERBATIM, so verify resolves to the ONE leaf `buildOwnedLabelsCapabilityCanonical`
   (same function object — mint↔verify parity holds), the subpath still avoids loading the codec/driver, and the
   SERVER (the packaging target) imports the leaf directly. The leaf is an adapter-manager DEVdependency for the
   component test only. Net: no security allow-list widened, boundary unchanged, one-canonical preserved.
2. **Parity harness split into two anchored halves** (see §1.11) — the fake-provider is not barrel-exported and
   worker-daemon cannot import the db-typed server mapping.

Both are STRICTLY SAFER than the literal design and preserve every security invariant (PARITY, #104,
fresh-literal, FROZEN behavior, inertness). No capability behavior changed; §1.2.0 stayed a pure re-home.

## 1.12 — review outcome (3 agents, 2026-08-29, every finding verified against source)

Three reviewers (parity/expiry; #104/no-leak; mint-site/inertness/guards). The two highest-value checks
PASSED: **inertness is genuinely sound** (no strict worker-side schema; the server reply has none) and the
**mint math** (parity, #104, injected key, ordering) is fundamentally right. But 6 HIGH + 3 MED reshaped the
build, all folded above:
- **H1 field-name trap** (`attemptNumber`/`targetGeneration`, not `attempt`/`deviceGeneration`) → §1.1/§1.3 explicit map.
- **H2 fence-token leak** (a `{...fenceIdentity}` spread leaks `fence`/`targetAuthorityKey`/hashes; labelsEqual + a value-scan miss it) → §1.3 fresh-literal rule + §1.9 exact-7-key + widened token scan.
- **H3 lease deadline not surfaced** → §1.4 extend `ResolvedFenceContext` + clamp.
- **H4 mint site** (targetId/targetGeneration absent at the pure reply assembler) → §1.2 mint in the broker tenant-tx closure; carry on the `resolved` arm.
- **H5 packaging** (server→provider-wire drags worker-daemon into the control-plane image) → §1.2.0 extract the pure primitive to a leaf.
- **H6 result-doc trap** (a `DEP-011-*-result.md` reds `check-finding-ownership`) → §1.8/§1.10 no result doc.
- **M1 anti-drift** (`labelsFor` not importable; value-collision masking) → §1.3 integration harness + distinct fixtures.
- **M2 positive gate** (`device_handoff` must carry none) → §1.5 `resolved ∧ sandbox_local_only`.
- **M3 containment surface** (server reply/logger/audit, not the worker event stream) → §1.9.3.

**Confirmed SOUND:** inertness; `materializeRunSecrets`-before-create ordering; the injected-key story;
`check-secret-resolve-vectors` unperturbed; `check-gate-clause-wiring` untripped + E7-1 stays unwired; the
single shared canonical; `labelsEqual` strict; #104 label/value separation in principle.

**Design is GO for the §9 build prompt** (with §1.2.0's leaf extraction as step 0).

---

# Slice 2a — the per-run provider factory + capability threading + the credential crossing (worker side)

**Status:** design (2026-08-29) — **3-agent adversarial review COMPLETE; all 9 findings verified against source
and folded in; the teardown fork RESOLVED → Option A (server owns reaping).** The review found the first-cut
design was NOT safe (the lease-clamped capability can't authorize teardown → a live-sandbox strand silently
reported as "success"; the "unset authorities" late-binding NPE'd; a type import of the capability tripped the
daemon boundary). The reshaped 2a below is honest-cleanup-only; the server-side reaper is the NEXT slice. Ships
INERT (worker-daemon passes nothing for the shipped binary; the loopback driver lives only in a `.test.ts`).
Review outcome + the fork rationale: §2a.12.

## 2a.0 — the teardown model (Option A) + the one structural idea

**Option A — the adapter-manager (the E2B key-holder, the sandbox OWNER) owns reclamation.** An ephemeral worker
cannot be trusted to clean up after itself (it crashes / is killed / loses its lease, after which its lease-bound
capability is — correctly — dead). So a live tenant sandbox is ALWAYS reclaimable only via a server-side
reconcile reaper. 2a's job on the worker side is HONEST cleanup: tear down promptly while the cap is VALID, and
when the cap is EXPIRED record an honest orphan (NEVER a false "success") and trust the server to reap. **The
server-side reaper is the NEXT slice** (net-new — the review confirmed the existing MIG-002 sweeper reaps DB rows
ONLY, never a provider `destroy`); until it lands the bounded E2B create-TTL is the honestly-stated interim
backstop. Re-mint-on-renewal (prompt worker teardown of LONG runs) is a deferred COST optimization, not a
correctness requirement under A.

**The structural idea.** The capability is PER-RUN (`ownedLabels` = `labelsFor(handoff)`, gate-enforced
`labelsEqual`) and a `NetworkedProviderDriver` binds its capability at CONSTRUCTION (`driver.ts:86-90`, readonly;
the `SandboxProvider` port has no per-op capability slot — frozen, E4-F002). But the capability does not exist
when the authorities are first built: `accept` → `buildRun` (builds `new EffectAuthority(deps.provider,fence)` +
`new CleanupAuthority({provider: deps.provider,…})`, `supervisor.ts:527-528`) → `runLifecycle` → step 0
`materializeRunSecrets` (yields env AND the capability) → `create`. So 2a builds the networked per-run driver +
its REAL authorities INSIDE `runLifecycle` after redemption — but `buildRun` must NOT leave the authorities unset
(§2a.3).

## 2a.1 — verified terrain

- **The wire ALREADY carries the capability from the real server; only the worker's parser drops it.**
  `execution-secret-resolve.ts:94-107,:140` returns `ownedLabelsCapability?` on the `resolved` arm;
  `classifyResolveResponse` (`secret-redemption.ts:87-102`) reads only `outcome`/`envTarget`/`value`/`reason`.
- **The per-run secret flow** `materializeRunSecrets` (`dispatch-runtime.ts:134-151`) → `synthesiseRunSecrets`
  (`secret-redemption.ts:113-132`) → `{env,canaries}`, in `runLifecycle` step 0 BEFORE `create`. The canary is
  seeded BEFORE create (`supervisor.ts:367` < `:378`); 2a preserves that on the networked branch.
- **★ The daemon boundary rejects even a TYPE import of the capability (review HIGH-1).** `check-worker-daemon-boundary`
  scans every non-`*.test.ts` file under `src/` and the extractor has NO `import type` awareness
  (`worker-protocol-boundary.mjs:355-381`), so `import type { OwnedLabelsCapability } from
  "@armyofagents/provider-capability"` in daemon runtime source is a "forbidden runtime import". And
  `isValidCapability` is module-PRIVATE (`codec.ts:210`, not exported). So worker-daemon must treat the capability
  as OPAQUE — a LOCAL structural type + a locally-vendored shape-guard (§2a.2). The `.test.ts` IS excluded, so it
  may import the real type + `provider-wire`/`adapter-manager`/`provider-capability` as DEVdeps (a first for
  worker-daemon; `evaluateManifest` pins only RUNTIME deps; no tsc project-reference cycle — neither package uses
  `references`).
- **Frozen:** worker-protocol (10-op list closed); the `SandboxProvider` port (no capability slot); the daemon
  2-dep RUNTIME pin (the daemon names only the factory TYPE; the driver + root live OUTSIDE it).

## 2a.2 — what 2a builds

1. **The additive `makeRunProvider?` factory — a LOCAL type in worker-daemon.** `makeRunProvider?: (input: {
   handoff: LeaseHandoff; capability?: OwnedLabelsCapabilityLike }) => SandboxProvider`, where
   `OwnedLabelsCapabilityLike` is a LOCAL structural interface (`{ readonly v:number; readonly audience:string;
   readonly ownedLabels: ResourceLabels; readonly expiresAt:number; readonly sig:string }`, the LOCAL
   `ResourceLabels`) — worker-daemon NEVER imports the leaf's type (review HIGH-1). The outside root (2b) supplies
   the impl; structural assignability bridges the two. Thread it additively through `SupervisorDeps` +
   `ComposeDispatchRuntimeDeps` alongside `deps.provider?`. **★ Precedence (review F4):** exactly one of
   `provider`/`makeRunProvider` may be set — `makeSupervisor`/`composeDispatchRuntime` FAIL FAST if both are
   present. **★ And `makeRunProvider` REQUIRES `materializeRunSecrets` (review F5)** — the post-redemption rebuild
   only runs inside the `if (deps.materializeRunSecrets)` block (`supervisor.ts:341`), so `makeRunProvider` without
   it would leave the no-op authorities in place forever (a silent misconfig, fail-safe but wrong) — fail fast at
   construction pairing them. The gates become `!provider && !makeRunProvider ⇒ no_provider` in BOTH `decideDispatchComposition`
   (`compose-dispatch.ts:88`) AND `shouldComposeSession` (`:115-120`); the `:112-113` "same-provider" invariant
   comment is updated; `provider` moves from required to optional in both dep shapes.
2. **The worker-side capability threading + dedup-on-labels.** `ResolveClassification.resolved` widens with
   `ownedLabelsCapability?: OwnedLabelsCapabilityLike`; `classifyResolveResponse` reads
   `body.ownedLabelsCapability` through a LOCALLY-VENDORED shape-guard (mirroring `isValidCapability`, pinned by a
   contract test — the "vendor + pin" pattern `secret-redemption.ts:17-18` already uses). `synthesiseRunSecrets`
   returns `{env,canaries,capability?}`. **★ Dedup on `ownedLabels`, NOT the whole cap (review MED-3):** the N
   per-handle caps share one fence identity so their `ownedLabels` are provably identical, but `expiresAt`/`sig`
   can differ by a few ms (`min(authorityNow+TTL, D)` with a fresh `authorityNow` per handle when the TTL — not
   the deadline — binds). Dedup + fail-closed on the `ownedLabels`/`v`/`audience` tuple ONLY; keep any one
   non-expired cap. Treat all-absent (desktop, no key) as a NO-OP so a future keyed desktop run never fails
   (§2a.8).
3. **The supervisor branch — NO-OP null-object authorities at `buildRun`, REAL authorities post-redemption (review
   HIGH-2).** `ActiveRun.effect`/`.cleanup` become MUTABLE (drop `readonly`, `supervisor.ts:172-173`), NEVER unset.
   In-process/desktop (`deps.provider`): build the real authorities at `buildRun` — BYTE-IDENTICAL. Networked
   (`deps.makeRunProvider`): `buildRun` builds NO-OP null-object `EffectAuthority`/`CleanupAuthority` (over a no-op
   provider — `withdraw()` is a safe flag, `list()`→[], effectful ops throw only if wrongly reached); then
   `runLifecycle`, after `materializeRunSecrets` yields the capability, REBUILDS `run.effect`/`run.cleanup` over
   the real per-run driver `deps.makeRunProvider({handoff, capability})`. **★ The networked `CleanupAuthority` is
   the honest TRUST variant (Option A), NOT the standard gated `converge`** (§2a.5). NO `!` non-null assertions on
   `run.effect`/`run.cleanup` (a `!` would compile green and reship the NPE).

## 2a.3 — ★ the late-binding / null-object invariant (review HIGH-2 — the first-cut "unset" design NPE'd)

The authorities are touched UNCONDITIONALLY before any post-redemption bind — the review enumerated the sites the
first cut missed: `run.effect.withdraw()` in `accept`'s `finally` (`supervisor.ts:560`, EVERY exit),
`escalateCleanup`'s first line `run.effect.withdraw()` (`:253`) + `run.cleanup.list()` (`:262`) reached from the
secret-failure paths AND from `cancel`/`onLeaseLost` (`:565-574`, which do NOT try/catch escalateCleanup) firing
during the `await materializeRunSecrets` window (default 5s). "Unset" ⇒ a bare `TypeError` (`withdraw` of
undefined) → `runs.delete` skipped (a permanent map leak) + `accept` rejects (violating its never-reject
contract). FIX: NO-OP null-object authorities from `buildRun` make every one of those sites total and safe
("nothing created ⇒ withdraw is a no-op, list is []"); the real per-run authorities REPLACE them post-redemption.
**★ The SYNCHRONOUS-SWAP invariant (review F4):** the two reassignments (`run.effect`, `run.cleanup`) MUST be
synchronous with NO `await` between them (`makeRunProvider` is typed sync), so a concurrent `cancel`/`onLeaseLost`
(which reaches `escalateCleanup` with no try/catch, `:565-574`) during the rebuild sees EITHER both no-op OR both
real — never a half-swap. A builder who inserts an `await` between the assignments opens a half-swapped window.
**★ A known, ACCEPTED divergence (review F4):** a cancel arriving during `await materializeRunSecrets` withdraws
the DISCARDED no-op effect; the freshly-rebuilt real effect (`#active=true`) then lets `create` (`:378`) proceed,
and the sandbox is promptly reclaimed by the `if (run.cancelled)` check at `:398` (with a valid just-minted cap).
So the networked branch spins up + reclaims a sandbox for a run cancelled pre-create; desktop (real effect at
`buildRun`) throws `EffectAuthorityWithdrawnError` and never creates one. No strand; acceptable (prompt reclaim) —
recorded so §2a.8's "desktop byte-identical" is not read as networked parity on this concurrent edge.

## 2a.4 — parity (unchanged hazard, on the live wire)

The driver's `create` carries exactly `labelsFor(handoff)` (`createSpecFor`, `supervisor.ts:229-235`), which must
equal the capability's `ownedLabels` — the two-sided anchor test from Slice 1 (`supervisor-labels-parity.test.ts`
+ `owned-labels-mint.test.ts`) already guards mint≡labelsFor; 2a keeps the driver honest. Same total-dispatch-
failure hazard as Slice 1, now live.

## 2a.5 — ★ the honest TRUST cleanup variant (Option A — replaces the first cut's masked strand)

**The defect (verified):** the first cut wired the STANDARD `CleanupAuthority` around the cap-gated networked
driver. On teardown with an EXPIRED cap the gate refuses with the uniform `ResourceNotAvailableError`, and
`#convergeOne` reads RNA as "already gone → `return "success"`" (`cleanup-authority.ts:281,:300`) → a LIVE,
billing tenant sandbox reported cleaned-up, metric `success`, ZERO signal. And because the cap is minted once,
clamped to the FIRST lease deadline, and never re-minted on renewal (`lease-renewal.ts` has no mint path), this
fires on the PURE HAPPY PATH for any run longer than the cap TTL — every real (>5min) coding run.

**The fix (Option A) — CLOCK-FIRST, with an RNA re-check; the orphan is a METRIC LABEL, not a new status.**
The worker HOLDS the cap and its `expiresAt`, and has the supervisor `now` clock. The decision is the worker's,
NOT the gate's ambiguous RNA:
- **Before each gated networked teardown op, check `expiresAt > now` (worker clock).** EXPIRED ⇒ skip the gate
  entirely and record an orphan (a doomed round-trip is pointless). VALID ⇒ attempt the teardown.
- **On a returned uniform RNA from an attempted (valid-at-issue) op, RE-READ the clock (review F2 — skew-safe):**
  the gate checks `expiresAt > now` on the ADAPTER-MANAGER's clock (`capability-verify.ts:85`), the worker on its
  own. If the cap expired DURING the round-trip (worker↔AM skew) ⇒ orphan (do NOT read RNA as "gone"). If still
  valid on re-read ⇒ the sandbox is genuinely gone ⇒ `success`. This is the ONLY point RNA is consulted, and only
  after the clock says the cap should still work.
- **The orphan encoding (review F1 — the frozen-type mechanism).** `CleanupStatus` is the CLOSED union
  `"success"|"failed"` (`provider.ts`) and `SupervisorRunStatus` is frozen (`supervisor.ts:155`) — so the orphan
  is NOT a new status and NOT a run terminal (the run terminal is already legitimately emitted, e.g. `succeeded`
  at `:488`, BEFORE the `:492` destroy strands the sandbox — a new "orphan terminal" would CORRUPT it). Instead
  the networked-expired branch emits a DISTINCT `CLEANUP_OUTCOME_METRIC { outcome: "orphaned" }` label (the label
  is an open string, `supervisor.ts:296`) + a distinct `escalateCleanup` log field, WITHOUT calling the
  RNA-means-gone `converge`. "Orphaned" is measurable + distinct from BOTH `success` AND `failed` — the leak-rate
  signal the deferred reaper consumes.
- **The happy-path teardown site (review F2).** `run.effect.destroy` at `supervisor.ts:492` (the EffectAuthority,
  NOT `run.cleanup`) is the happy reclaim. For a SHORT run (cap valid) it succeeds through the gate. For a LONG
  run the cap is expired: add a PROACTIVE `expiresAt > now` check at `:492` so it records an orphan directly
  (no doomed gated round-trip) rather than throwing RNA into the `:509` catch → `escalateCleanup`.

**The three timescales (review F3 — state them, don't conflate).** (1) the cap TTL = `min(now + shortTtlMs,
firstLeaseDeadline)` (`owned-labels-mint.ts:92`); (2) the SANDBOX TTL = the create op's `ctx.deadlineMs` =
`opDeadlineMs` (`e2b-provider.ts:182-184,:205,:210`), set ONCE at create, **no keepalive/refresh**; (3) the run
length. The masked-strand scenario needs the sandbox ALIVE at run-end (so `opDeadlineMs ≥ run length`), and the
"bounded orphan window" is then EXACTLY `opDeadlineMs` (finite — `#ttl` always returns a value, so no UNBOUNDED
leak). 2a states this bound honestly; a run that outlives `opDeadlineMs` via lease renewal WITHOUT a matching
sandbox-TTL refresh is a NAMED separate gap (the refresh, like re-mint-on-renewal, is the deferred optimization).

The **server-side reconcile reaper** (the adapter-manager reclaiming orphaned sandboxes) is the **NEXT slice** —
honestly net-new (the MIG-002 sweeper reaps DB rows only, never a provider `destroy`; β1.6 is the deferral MARKER,
not a mechanism). **This absorbs what the recon had penciled as a separate Slice-3 cleanup variant** (the review
proved `escalateCleanup` routes EVERY non-happy exit through `run.cleanup`, so 2a MUST wire a networked cleanup).

## 2a.6 — fail-closed on redemption failure + zero-capability (reviews F4/F5 → handled by the null-object)

On secret-redemption FAILURE (`materializeRunSecrets` throws, `supervisor.ts:341-362`) the networked branch never
rebuilt the real authorities, so the NO-OP null-object ones handle `escalateCleanup`/`accept`-finally safely
(nothing created ⇒ nothing to withdraw/list) — no `TypeError`, no strand, terminal preserved. **★ Zero-capability
(review F5):** a networked run that resolves handles but gets NO capability (redemption succeeded, N=0 or a
`sandbox_local_only` handle with no cap) must FAIL CLOSED with a diagnosable terminal — NEVER construct a driver
with `capability: undefined` (it would be refused at the gate on every op, a mis-labeled `create_failed`). On
desktop N=0 is benign (`env={}`); the networked branch treats "no capability" as an explicit fail-closed reason.

## 2a.7 — #104 on the crossing (review: SOUND)

The redeemed key (`spec.env`) + the cap `sig` cross the provider-wire `create` (`encodeOpRequest` bare
`JSON.stringify`, `codec.ts:73-78`) — that IS the crossing. `FORBIDDEN_WIRE_KEYS` (`wire-safety.ts:18-31`) is the
worker-PROTOCOL wire, a different codec — inapplicable by construction. The review CONFIRMED no new log/event
surface leaks it: `NetworkedProviderDriver.#post` never logs (`driver.ts:181-196`); the AM op handler never logs
the body on success or error (`server.ts:176-234`); `gateCreate`/the ledger record only `{sandboxId,
resourceLabels}` (`create-gate.ts:83-84`); the supervisor logs only `resourceLabelsHash`/`leaseId` and discards
`err` (`:379-384`). The canary is seeded before create (§2a.1) so the value is scrubbed from both event streams;
the `sig` is never emitted. The create carries ONLY value + labels + sig + expiry — never the fence token (Slice
1's fresh-literal). mTLS/net-seg = Slice 5. The test asserts value + sig ABSENT from worker logs + events
(present in the create REQUEST is correct).

## 2a.8 — fences

The desktop/in-process lane is BYTE-IDENTICAL (real authorities at `buildRun`; `composed-journey` unchanged; the
dedup treats all-absent as a no-op so a future keyed desktop run never fails). Frozen: worker-protocol, the
`SandboxProvider` port, the daemon 2-dep runtime pin (daemon names only the LOCAL factory type). NO container bin
/ new package / `AOA_WORKER_PROVIDER_URL` / boot-root (2b). NO `checkDispatchDefaultOff` change (Slice 5). NO real
control-plane keypair. NO server-side reaper (the NEXT slice). NO re-mint-on-renewal (deferred optimization).
Ships INERT. NO `DEP-011-*-result.md` (E6-F003 open + owned; result note in this doc).

## 2a.9 — the component test (worker-daemon `.test.ts`) + mutation sweep

Mint the capability IN THE `.test.ts` (`signOwnedLabelsCapability` over the fixture `labelsFor(handoff)`, a TEST
keypair — `support/fake-control-plane.ts` is boundary-scanned + cannot import the mint; extend its
`seedSecretResolution` + `handleExecutionSecretResolve` with an OPAQUE one-field echo). Drive a real
`composeDispatchRuntime` with `makeRunProvider = ({capability}) => new NetworkedProviderDriver({baseUrl,
capability, fetch})` → an in-process GATED `createProviderServer({ provider: E2bSandboxProvider(MockE2bTransport),
controlPlanePublicKey: TEST_PUBLIC })` (`E2bSandboxProvider` named ONLY in the `.test.ts`, which
`check-gate-clause-wiring` excludes — E7-1 stays at 4). Assert: (a) create SUCCEEDS ⇒ cap verified; (b) env
CROSSES (`provider.peek`); (c) value + `sig` ABSENT from events AND worker logs (extend the `:223-224` scan + a
LOGGER SPY) + a positive control; (d) FAIL-CLOSED: denied redeem → no cap → no driver → `create` callCount 0,
`activeRunCount()===0` (catches the map leak the swallowing wrappers hide, review F2), no `TypeError` (logger/
process spy); (e) **cancel / lease-loss delivered MID-REDEMPTION** on the networked branch → no throw, no strand
(the null-object path); (f) **expired-cap teardown → `CLEANUP_OUTCOME_METRIC { outcome:"orphaned" }`
— a label PRESENT and DISTINCT from BOTH `"success"` AND `"failed"` (review F1), the run terminal untouched, and
the RNA-means-gone `converge` NEVER called** (the strand-masking regression test); (g) a genuinely-gone sandbox
(cap still valid on re-read) → `success`, NOT a false orphan (review F2). Mutation sweep: driver at `buildRun`
(create refused → killed); the naive "unset" authorities (mid-redemption cancel → `TypeError` → killed by (e));
expired-cap teardown routed through `converge` (masked success → killed by (f)); an RNA read as orphan WITHOUT the
clock re-check (a genuinely-gone sandbox mislabeled orphan → killed by (g)); the orphan encoded as `"failed"`
(indistinguishable from a real failure → killed by (f)'s distinctness assertion); dedup on the whole cap incl.
`expiresAt` (a 2-key run's ms delta → false fail-closed → killed); log the create payload (containment → killed);
both `provider`+`makeRunProvider` set (no fail-fast → killed).

## 2a.10 — guards (review: §2a.2's list corrected)

**★ `check-worker-daemon-boundary`** — the reason the capability is a LOCAL type + vendored guard (§2a.2): a leaf
type import in daemon runtime source REDS it (no `import type` awareness). MUST pass with the opaque-local
approach. `check-test-inventory` (--write re-pin for the new `.test.ts` + the vendored-guard contract test);
`check-gate-clause-wiring` (`makeRunProvider`/`NetworkedProviderDriver` not gated symbols; `E2bSandboxProvider`
named ONLY in a `.test.ts` → excluded from the caller count → E7-1 stays `unwired` at 4); `check-finding-ownership`
(NO result doc). NOT boot-roots / image guards (2b). Run the WHOLE policy set (the combined-root-Dockerfile inline
awk is N/A — no new package in 2a; that's 2b).

## 2a.11 — result note (BUILT 2026-08-29 — IN THIS DOC, not a -result.md; E6-F003 stays OPEN + owned)

**Slice 2a SHIPPED INERT, CI-verified.** The worker now consumes the Slice-1 minted capability: a
container worker's per-run `NetworkedProviderDriver` is built INSIDE `runLifecycle` after redemption,
carrying that run's capability, and torn down HONESTLY (orphans measured, never masked). Ships INERT —
worker-daemon passes NOTHING for the shipped binary (`decideDispatchComposition` still refuses
`no_provider`); the loopback driver + gated server live ONLY in the new `.test.ts`.

**What landed (all in `packages/worker-daemon`, boundary-clean):**
- **The local capability + guard (§2a.1/§2a.2):** `src/lease/owned-labels-capability.ts` — a LOCAL
  structural `OwnedLabelsCapabilityLike` (`v:number`/`audience:string`, WIDER than the leaf's literals) +
  a VENDORED `isOwnedLabelsCapabilityShape` (a faithful mirror of `codec.ts`'s PRIVATE `isValidCapability`)
  + `ownedLabelsCapabilityIdentity` (the dedup tuple). worker-daemon runtime source NEVER imports the leaf
  type. `owned-labels-capability-guard.contract.test.ts` PINS the guard against a REAL minted cap (the
  `.test.ts` may import `@armyofagents/provider-capability` — a first devDep for worker-daemon).
- **Capability threading + dedup (§2a.2):** `ResolveClassification.resolved` widens with
  `ownedLabelsCapability?`; `classifyResolveResponse` reads it through the guard (a malformed cap ⇒ ABSENT,
  never carried); `synthesiseRunSecrets` returns `{env, canaries, capability?}` — DEDUP + fail-closed on the
  `ownedLabels`/`v`/`audience` identity ONLY (a benign `expiresAt`/`sig` ms-delta keeps the longer-lived cap;
  a divergent `ownedLabels` throws), all-absent ⇒ `undefined` (desktop no-op). `dispatch-runtime.ts`
  `materializeRunSecrets` carries `capability?`.
- **The factory type + gates (§2a.2):** `SupervisorDeps.makeRunProvider?` + `ComposeDispatchRuntimeDeps.makeRunProvider?`
  added, `provider?` now optional; the provider gate becomes `!provider && !makeRunProvider ⇒ no_provider` in
  BOTH `decideDispatchComposition` AND `shouldComposeSession`; FAIL-FAST at `createSupervisor`: both set ⇒
  throw, `makeRunProvider` without `materializeRunSecrets` ⇒ throw.
- **The supervisor structural change (§2a.3/§2a.5/§2a.6):** `ActiveRun.effect`/`.cleanup` MUTABLE (+ `fence`,
  `networked`, `capExpiresAt`); `buildRun` builds REAL authorities on the desktop branch (BYTE-IDENTICAL) and
  NO-OP null-object authorities over `src/supervisor/noop-provider.ts` on the networked branch; `runLifecycle`
  REBUILDS the real authorities over `makeRunProvider({handoff, capability})` after redemption — SYNCHRONOUSLY
  (no `await` between the two reassignments); zero-capability ⇒ explicit `no_run_capability` fail-closed
  terminal. The networked teardown is the HONEST TRUST variant: a PROACTIVE `expiresAt > now` check at the
  happy `run.effect.destroy` records an orphan directly, and `convergeNetworked` is clock-first with an RNA
  skew re-check (expired-in-flight ⇒ orphan; still-valid + RNA ⇒ genuinely gone ⇒ success), NEVER the
  gate-masking `converge`.

**The honest orphan (§2a.5) — DEVIATION from the design's "open string" wording (reported, not papered over).**
§2a.5 F1 said the orphan label rides `supervisor.ts:296`'s "open string" `outcome`. Against the repo that is
FALSE: `metrics.ts`'s `outcome` key is a CLOSED per-key value allow-list (`CLOSED_LABEL_VALUES.outcome`), so
`inc(CLEANUP_OUTCOME_METRIC, {outcome:"orphaned"})` would THROW on an unregistered value. Fix: register
`"orphaned"` in that closed set (additive, low-risk, fully preserves the design's intent — a DISTINCT
`cleanup_outcome{outcome="orphaned"}` label, distinct from BOTH `success` AND `failed`). The run terminal
(`SupervisorRunStatus`) is untouched (frozen); the orphan is a cleanup-outcome metric + a distinct
`orphaned`/`cleanupStatus:"orphaned"` log field, never a new status/terminal.

**★ BLOCKER (design vs repo) — the daemon devDep on its own consumers is a `pnpm -r build` ORDER CYCLE.** §2a.1
said the `.test.ts` "may import provider-wire/adapter-manager/provider-capability as DEVdeps … no tsc
project-reference cycle — neither package uses `references`." True for tsc `references`, but WRONG for the actual
build: CI's `pnpm build` is `pnpm -r build`, which orders by ALL package.json deps INCLUDING devDeps. Those three
(and `sandbox-e2b-provider`) all build FROM `worker-daemon`, so a worker-daemon devDep on them is a CYCLE — pnpm
then ordered `adapter-manager` before its own `sandbox-e2b-provider`/`provider-wire` deps and `pnpm build` FAILED
(`Cannot find module '@armyofagents/sandbox-e2b-provider'`). This RED the `e2e`/`verify` build step (caught on the
first push). The design under-weighted this; the fix is to NOT create the cycle.

**Test harness (the fix + the §2a.9 single-drive deviation).** The test is SPLIT across the boundary the cycle
forbids: **the worker seam stays in a worker-daemon `.test.ts` with ZERO cross-package devDeps** (fakes only —
`createSupervisor` driven directly with `makeRunProvider` → a `createFakeSandboxProvider`, injected clock +
deferred redemption): fail-fast (both-set / makeRunProvider-without-materialize), driver-built-POST-redemption
(factory-call assertions), (b) the model key CROSSES into the per-run provider's create env (`provider.peek`),
(c) value+sig ABSENT from the supervisor's events AND a logger spy (+ positive controls), (d) zero-capability
fail-closed, (e) cancel MID-REDEMPTION (null-object, no `TypeError`, `activeRunCount()===0`), (f) expired-cap
happy-destroy → `orphaned` (converge never called), (f2) expired-cap escalateCleanup → `orphaned` CLOCK-FIRST,
(g) genuinely-gone (cap valid on re-read) → `success`. **The REAL minted-cap ↔ REAL gated-server crossing (a: the
cap VERIFIES at the real create-gate; b: the model key + sig ride the real `NetworkedProviderDriver` wire into
`E2bSandboxProvider`'s env) is proven in a NEW adapter-manager `.test.ts`** (`dep-011-slice-2a-crossing.component.test.ts`),
which already depends on worker-daemon + provider-wire + sandbox-e2b-provider and dev-depends on
provider-capability — a top-level consumer with NO cycle — plus its fail-closed cases (no-cap / expired-cap /
foreign-labels each refused with the uniform `ResourceNotAvailableError`, no sandbox created). `E2bSandboxProvider`
is named ONLY in `.test.ts` files (excluded from `check-gate-clause-wiring` → E7-1 stays `unwired` at 4). The
contract test hand-builds the frozen cap SHAPE (dropping the leaf import, same cycle reason). Net: every assertion
(a)–(g) is preserved and the crossing is still proven against the REAL gate — the split is the boundary the repo's
build order requires, strictly safer than the cycle-inducing single-package drive.

**Tests + mutation.** New (worker-daemon): `owned-labels-capability-guard.contract.test.ts` (4, hand-built shape),
`dep-011-slice-2a.component.test.ts` (8, the worker seam). New (adapter-manager):
`dep-011-slice-2a-crossing.component.test.ts` (4, the real gated crossing + fail-closed). Extended:
`secret-redemption.test.ts` (+7 classify/synthesise threading+dedup), `compose-dispatch.test.ts` (+3 the
`makeRunProvider` gate). worker-daemon has NO cross-package devDeps (cycle avoided). Whole worker-daemon suite GREEN
(145 files / 896+1skip); adapter-manager GREEN (10 files / 103); `composed-journey` + `supervisor-happy` +
`supervisor-secret-materialization` UNCHANGED (desktop byte-identical). `pnpm build` (full `-r`) exits 0 (cycle
resolved). Mutation sweep 6/6 killed against source (verified by reverting each): driver-at-buildRun (factory-call
assertions), broken null-object / "unset" authorities (e→`TypeError`), escalateCleanup routed through the masking
converge (f2→false success), RNA-without-clock-re-check (g→false orphan), proactive-check removed (f), plus
dedup-on-whole-cap (synthesise fail-closed), fail-fast (both-set), and the real gate refusing a no-cap/expired/
foreign create (adapter-manager fail-closed).

**Guards (WHOLE policy set GREEN).** `check-worker-daemon-boundary` PASS (local-type + vendored guard; NO leaf
import in runtime source; worker-daemon declares NO cross-package dep at all); `check-gate-clause-wiring` OK (E7-1
stays dormant at 4 — `E2bSandboxProvider` named only in `.test.` files); `check-finding-ownership` OK (NO result
doc — E6-F003 stays open + owned by DEP-011); `check-test-inventory --write` re-pinned; `check-adapter-manager-boundary`
(the crossing test is a `.test.ts`, provider-capability is an existing devDep), `check-dependency-graph`,
`check-sandbox-e2b-provider-boundary`, `check-secret-resolve-vectors` (unperturbed), `check-execution-census`,
`check-image-deps-stages` (N/A — no new package) all GREEN. Full `pnpm build` GREEN + graph typecheck GREEN for
worker-daemon + adapter-manager + provider-wire + provider-capability + sandbox-e2b-provider.

**Fences honoured.** No container bin / new package / `AOA_WORKER_PROVIDER_URL` / boot-root (2b); no
`checkDispatchDefaultOff` change / mTLS / real keypair (Slice 5); no server-side reaper (next slice — 2a RECORDS
orphans, bounded by the E2B create-TTL `opDeadlineMs`, and does not reap); no re-mint-on-renewal (deferred); no
new run terminal; no `!` on the authorities; no create-payload log; worker-daemon still ships passing nothing.

## 2a.12 — review outcome (3 agents, 2026-08-29, every finding verified against source)

Three reviewers (ordering/late-binding; cleanup-strand/fail-closed; #104/dedup/guards). The first-cut 2a was NOT
safe; **the teardown fork was resolved → Option A (server owns reaping).** Findings, all folded above:
- **HIGH — the expired-cap strand masked as "success"** (cleanup-F1, ordering-F3): the standard `CleanupAuthority`
  reads a gate RNA as "gone → success"; the lease-clamped, never-re-minted cap dies before a real run ends → every
  long run's happy-path destroy strands a live sandbox, silently. → §2a.5 the honest TRUST variant.
- **HIGH — the "unset authorities" late-binding NPE** (ordering-F1, cleanup-F4, guards-HIGH-2): `:560`/`:253`/`:262`
  + the concurrent-cancel window deref the authorities before the bind → `TypeError` + map leak. → §2a.3 NO-OP
  null-object at `buildRun`, real authorities post-redemption (mutable fields, no `!`).
- **HIGH — the daemon boundary rejects a capability TYPE import** (guards-HIGH-1): no `import type` awareness;
  `isValidCapability` private. → §2a.2 LOCAL structural type + vendored guard; only the `.test.ts` imports the real
  type.
- **HIGH — the deferred reaper reaps DB rows, not sandboxes** (cleanup-F2): the MIG-002 sweeper never issues a
  provider `destroy`; β1.6 is the deferral marker. → §2a.0/§2a.5 the server reaper is the NEXT slice (net-new);
  the E2B TTL is the honestly-stated interim backstop.
- **MED — dedup fails-closed on a benign `expiresAt`/`sig` delta** (guards-MED-3): a 2-key run mints 2 caps
  differing by ms. → §2a.2 dedup on `ownedLabels`/`v`/`audience` only.
- **MED — both `provider`+`makeRunProvider` precedence unspecified** (ordering-F4). → §2a.2 fail-fast.
- **MED — networked zero-capability → doomed driver** (ordering-F5). → §2a.6 explicit fail-closed.
- **MED — the fail-closed test can't catch the map leak** (ordering-F2): `accept`'s rejection is swallowed. →
  §2a.9 assert `activeRunCount()===0` + a logger spy.
- **LOW — §2a.10 wording** (guards-LOW-4): 2a DOES name `E2bSandboxProvider` (in the `.test.ts`); the guard
  excludes `.test.` paths, so the count stays 4. → §2a.9/§2a.10 corrected.

**Confirmed SOUND:** #104 on the crossing (no new log/event surface; canary scrub preserved; even a create error
discards `err`); inertness (shipped bin passes nothing ⇒ `no_provider`); desktop byte-identical; the devDep
allowance + no tsc/package cycle.

### Focused re-review of the reshaped cleanup (4th agent, 2026-08-29) — the prior HIGH fixes HELD; 5 refinements folded:
- **F1 (HIGH, was design-blocking) — the honest orphan was asserted, not mechanized.** `CleanupStatus`/the run
  terminal are frozen closed unions, so the orphan is NOT a new status/terminal — it is a distinct
  `CLEANUP_OUTCOME_METRIC { outcome:"orphaned" }` label + log field on a networked-expired branch that skips
  `converge` (the run terminal stays `succeeded`/etc.). → §2a.5, §2a.9(f).
- **F2 (MED-HIGH) — clock-vs-RNA contradiction.** The rule is CLOCK-FIRST (`expiresAt > now` before each gated
  teardown) with an RNA RE-CHECK for worker↔AM skew (expired-during-round-trip → orphan; still-valid → genuinely
  gone → success); the happy `destroy` is `run.effect.destroy` (`:492`), which gets a proactive expiry check. →
  §2a.5, §2a.9(g).
- **F3 (MED) — the three timescales** (cap TTL / sandbox TTL = `opDeadlineMs` set-once / run length) stated; the
  bounded-orphan window is exactly `opDeadlineMs` (finite, no unbounded leak); the no-refresh-on-renewal gap
  named. → §2a.5.
- **F4 (LOW-MED) — the synchronous-swap invariant** (no `await` between the two reassignments) + the accepted
  mid-redemption-cancel create-then-reclaim divergence. → §2a.3.
- **F5 (LOW) — the no-op provider's full-port obligation + the `makeRunProvider`⟹`materializeRunSecrets`
  fail-fast.** → §2a.2, §2a.3.
The re-review CONFIRMED sound: the masked-strand diagnosis, the null-object NPE fix, the compose-dispatch
plumbing, zero-capability fail-closed, and the short-run happy path.

**Design is GO for the §9 build prompt** — 2a is honest-cleanup-only (orphans measured, never masked); the
server-side reaper is the next scoped slice.

---

# Slice 2b — the containerized worker composition ROOT (the outside bin that supplies `makeRunProvider`)

**Status:** design (2026-08-30, post-recon). Awaiting the 3-agent adversarial review (§2b.7). Ships INERT (the
container worker stays dispatch-off in staging; the go-live flag flip + the split-image home are Slice 5). Supplies
the `makeRunProvider` factory impl that Slice 2a's worker-daemon side already accepts through its DEEP layers.

## 2b.0 — ★ two premise corrections from the recon (load-bearing)

1. **The daemon BIN does NOT yet accept `makeRunProvider`.** Slice 2a threaded it through `SupervisorDeps`
   (`supervisor.ts:107`), `ComposeDispatchRuntimeDeps` (`dispatch-runtime.ts:73`), and the gate FUNCTIONS
   (`compose-dispatch.ts:103,:133`) — but NOT through `bootstrapWorkerDaemon`/`BootstrapDeps`. The bin passes only
   `deps.provider` at all four sites (`worker-daemon.ts:334,:454,:495,:529` — note `provider: deps.provider!` at
   `:529`). So a container injecting ONLY `makeRunProvider` is refused `no_provider` at the FIRST bin gate. 2a's
   tests drove `composeDispatchRuntime` directly, bypassing the bin, so this gap was never exercised. → 2b-i.
2. **`AOA_WORKER_PROVIDER_URL` already exists** — set (DEAD) in `docker-compose.d1.yml:304,343` +
   `d1-dispatch-expectation.json` (`present`, "read by NO code"). 2b's bin is its FIRST code reader; the d1
   `present` gate stays green (do not touch the d1 compose).

## 2b.1 — the SUB-SLICE cut (mirror 2a's inside/outside)

- **2b-i (INSIDE worker-daemon, inert, boundary-clean):** thread `makeRunProvider?` through `BootstrapDeps` + the
  four bin sites; export `runContainerHost` + `ContainerHostDeps` from the worker-daemon barrel (so the outside
  package composes custody via the existing `bootstrap` injection seam). No new package; no Dockerfile/boot-root
  churn. Prove with a bin test: a `makeRunProvider`-only boot passes the provider gate (still inert — flag off).
- **2b-ii (OUTSIDE):** the new package `packages/worker-networked-host` + bin (reads `AOA_WORKER_PROVIDER_URL`,
  builds the factory, calls `runContainerHost` with the bootstrap injector) + `BIN_DIRS` extension +
  `boot-roots-expectation.json` declaration + the combined-root `./Dockerfile` COPY + the env doc.

## 2b.2 — 2b-i: what it builds

- Add `makeRunProvider?: (input:{ handoff: LeaseHandoff; capability?: OwnedLabelsCapabilityLike }) => SandboxProvider`
  to `BootstrapDeps` (`worker-daemon.ts:174`, alongside `provider?`; thread via the existing `MakeRunProvider`
  alias, `compose-dispatch.ts:31`, not a re-inlined function type), and feed it to all four sites: `shouldComposeSession`
  (`:334`), the two `decideDispatchComposition` calls (`:454,:495`), and `composeRuntime` (`:529` — replace
  `provider: deps.provider!` with `provider: deps.provider, makeRunProvider: deps.makeRunProvider`; the `!` is a
  type-honesty removal, not a runtime fix). ★ **All four move in LOCKSTEP (review F3):** `shouldComposeSession`
  (`:334`) is coupled to the `:472` invariant — thread the two `decideDispatchComposition` + `composeRuntime` but
  SKIP `shouldComposeSession` and a container boot gets `lifecycle undefined` while the first
  `decideDispatchComposition` passes the provider gate → `readIsTheOnlyRemainingGate` true → the `:472-474`
  invariant THROWS "invariant broken". The gate FUNCTIONS already handle `!provider && !makeRunProvider ⇒
  no_provider` (2a) — 2b-i just feeds them the field.
- **Export `runContainerHost` + `ContainerHostDeps` from `worker-daemon/src/index.ts`** (grep-confirmed NOT
  exported; worker-daemon has no subpath exports). This lets the outside package reuse the container custody path
  (`FileRecordStore` + the writability probe + the re-mint guard, `container-host.ts:102-135`) via its injectable
  `bootstrap` seam — WITHOUT re-exporting `FileRecordStore`/the codecs (keep the custody internals private).
- **Boundary-clean:** all 2b-i edits use LOCAL types (`makeRunProvider`'s `OwnedLabelsCapabilityLike` is the
  worker-daemon-local type from 2a) — no cross-package import → `check-worker-daemon-boundary` stays green.

## 2b.3 — 2b-ii: the new package + bin

- **`packages/worker-networked-host`** — runtime deps EXACTLY `@armyofagents/worker-daemon` +
  `@armyofagents/provider-wire` (`provider-capability` is transitive via provider-wire, and `OwnedLabelsCapability`
  is re-exported from `provider-wire/index.ts:28` — NO direct dep needed). **No `pnpm -r build` cycle** (the
  Slice-2a lesson): the new package is a LEAF consumer (nothing depends on it), downstream of everything — the
  cycle (a package devDepping its own downstream consumers) cannot recur.
- **The bin** (the boot root): a `resolveProviderUrl(env)` returning the URL or a `none` marker when
  `AOA_WORKER_PROVIDER_URL` is unset (mirror `sandbox-provider.ts:72-104`'s `{kind:"none"|...}` shape + the
  `resolverNoneMarker` literal); when set, call `runContainerHost({ env, proc, bootstrap: (d) =>
  bootstrapWorkerDaemon({ ...d, makeRunProvider: ({ capability }) => { … } }) })`. ★ Write the factory INLINE as
  the property value (review F2) — a standalone `const makeRunProvider = …` fails `noImplicitAny` (its
  `{capability}` has no reachable named type: neither `MakeRunProvider` nor `OwnedLabelsCapabilityLike` is
  barrel-exported), while inline the property's contextual type supplies the wide param. (Alternative: 2b-i also
  `export type { MakeRunProvider }` and annotate the const.) The boot-root file MUST name `bootstrapWorkerDaemon`
  (else the scan declares-but-can't-find → stale FAIL).
- **★ The type bridge — RE-VALIDATE, do not blind-cast (review F1).** `makeRunProvider`'s wider
  `OwnedLabelsCapabilityLike` (`v:number`, `audience:string`) is NOT assignable to
  `NetworkedProviderDriverOptions.capability: OwnedLabelsCapability` (`v:1`, `audience:"adapter-manager"` literals).
  The upstream `isOwnedLabelsCapabilityShape` (2a) validated only the WIDE shape (`typeof v === "number"`), NOT the
  literals — so `capability as OwnedLabelsCapability` is an UNCHECKED down-cast (a future `v:2` — planned,
  `capability.ts:32-34` — would be silently re-labelled `v:1`, erasing the compiler's forward-compat guard). FIX:
  re-validate the literals at the factory and narrow WITHOUT a cast:
  `if (capability?.v !== OWNED_LABELS_CAPABILITY_VERSION || capability.audience !== OWNED_LABELS_CAPABILITY_AUDIENCE)
  throw/route-fail-closed; new NetworkedProviderDriver({ …, capability })` (both consts are reachable from
  `@armyofagents/provider-wire`, already a 2b dep). NOTE the failure lands in `accept`'s catch as a generic
  `lifecycle_error`, NOT the diagnosable `no_run_capability` terminal — route the mismatch to that fail-closed
  path or record the coarser terminal.

## 2b.4 — guards (the recon checklist — several are invisible to local `check-*.mjs`)

- **`check-boot-roots-provider-free`** — extend `BIN_DIRS` (`:24-27`) with `packages/worker-networked-host/src/bin`
  AND declare the new root in `boot-roots-expectation.json` (posture `"resolver"`, a `resolverFile`, a
  `resolverNoneMarker`). Declare-without-scan → stale FAIL; scan-without-declare → undeclared FAIL — do BOTH.
- **★ the combined-root `./Dockerfile` inline awk** (`pr.yml:422-460` — the Slice-1/DEP-012-Unit-A gotcha,
  INVISIBLE to local checks): add `COPY packages/worker-networked-host/package.json …` or `policy` reds.
- **★ `check-execution-census` + the root `vitest.config.ts projects[]` edit (review F1 — the MISSED guard, the
  β2/Slice-1 failure class).** A NEW package with a `.test.ts` + its own `vitest.config.ts` MUST be added to the
  hand-maintained root `vitest.config.ts` `projects[]`, or the required `policy` job reds `vitest_project_missing`
  / `vitest_config_not_in_projects` (`execution-census.mjs:116-139`; the Slice-1 precedent added
  `packages/provider-capability` at `vitest.config.ts:24`). Scaffold `packages/worker-networked-host/vitest.config.ts`
  + `tsconfig.json` AND add the package to the root `projects[]`. (`check-test-inventory --write` is a DIFFERENT
  guard — the file-count pin — and does NOT cover `projects[]` membership.)
- **`check-image-deps-stages` — do NOT touch `docker/worker/Dockerfile`.** The split worker image is EXACTLY
  worker-daemon + worker-protocol + pino (E4-D01); adding the networked host balloons the closure and breaks the
  exact-closure check. The host's IMAGE HOME is a Slice-5 decision (separate image / E4-D01 widening) — 2b ships
  inert, no image runs its bin.
- **`checkEnvDocumented`** — add `AOA_WORKER_PROVIDER_URL` to `docs/deploy/environment-variables.md`. Not firing
  yet (no staging service sets it), a HARD gate at Slice 5.
- `checkDispatchDefaultOff` — leave untouched (not a switch); do NOT flip (Slice 5). `check-d1-dispatch-declared` —
  leave the d1 compose unchanged. `check-gate-clause-wiring` — the host names `NetworkedProviderDriver`, NOT
  `E2bSandboxProvider` → E7-1 stays at 4. `check-test-inventory` — `--write` re-pin. `worker-keystore-boundary` —
  do NOT host in worker-keystore.

## 2b.5 — the component tests

- **2b-i:** a bin test that a `makeRunProvider`-only boot passes the `no_provider` gate (inert — flag off / no
  server), mirroring the existing bin tests. Assert the four sites now pass `makeRunProvider`.
- **2b-ii:** a construction test — given `AOA_WORKER_PROVIDER_URL`, the resolver yields a `makeRunProvider` whose
  product is a `NetworkedProviderDriver` with the right `baseUrl` + capability (NO real AM server — the driver's
  construction is inert; I/O only on an op call). The `none` path when the URL is unset.

## 2b.6 — fences

The split worker image (Slice 5); `checkDispatchDefaultOff` (Slice 5); the real go-live (Slice 5); the d1 compose;
worker-keystore (the 3-dep pin). Ships INERT. NO `DEP-011-*-result.md` (E6-F003 open + owned; result note in this
doc). The worker-daemon internals stay boundary-clean (2b-i uses only local types).

## 2b.7 — review outcome (2 agents, 2026-08-30, every finding verified against source)

Two reviewers (bin-threading/type-bridge; guards/cycle). The mechanism is SOUND — the bin-threading gap is real +
completely enumerated (no fifth site), the `runContainerHost` custody reuse via the `bootstrap` seam is clean, and
2b-i is inert + boundary-clean + desktop-byte-identical (all CONFIRMED). Findings folded above:
- **F-census (HIGH — the MISSED guard, β2/Slice-1 class):** a new package needs the root `vitest.config.ts
  projects[]` edit or `check-execution-census` reds `policy`. → §2b.4.
- **F-cast (MED):** `capability as OwnedLabelsCapability` is an UNCHECKED down-cast (the upstream guard validated
  only the wide shape, not the `v:1` literal — a planned `v:2` would be silently mislabelled). → §2b.3 re-validate
  the literals, no cast; route the mismatch fail-closed.
- **F-compile (MED):** the standalone-const factory fails `noImplicitAny` (no reachable named param type). → §2b.3
  write the factory INLINE (or export `MakeRunProvider`).
- **F-invariant-coupling (LOW):** `shouldComposeSession` is coupled to the `:472` invariant — all four bin sites
  in LOCKSTEP. → §2b.2.
- Nits folded: the `!` is at `:529` (not `:531`); the `!`-removal is type-honesty not a runtime fix; thread via
  the `MakeRunProvider` alias.

**Confirmed SOUND:** boot-root lockstep; the combined-root `./Dockerfile` COPY (the invisible awk); leaving the
split worker image untouched (E4-D01); the no-cycle (leaf consumer); gate-clause-wiring (E7-1 stays 4);
`checkEnvDocumented` (Slice-5-scoped); the d1 `present` gate.

**Design is GO for the §9 build prompt** — 2b-i (thread the bin + export `runContainerHost`) then 2b-ii (the new
`worker-networked-host` package + bin + boot-root + Dockerfile COPY + vitest project + env doc).

## 2b.8 — BUILD RESULT (2026-08-30, ships INERT)

Built exactly as designed; every §2b decision held against the repo (no STOP-and-report). Ships INERT — nothing
runs the new bin, no gate flipped.

**2b-i (INSIDE worker-daemon, boundary-clean).** Added `makeRunProvider?: MakeRunProvider` to `BootstrapDeps`
(via the `compose-dispatch.ts:31` alias — no re-inlined type) and threaded it at all FOUR bin sites in LOCKSTEP:
`shouldComposeSession` (`:334`), the two `decideDispatchComposition` (`:454`/`:495`), and `composeRuntime`
(`:529` — `provider: deps.provider!` → `provider: deps.provider, makeRunProvider: deps.makeRunProvider`, the `!`
gone as type-honesty). Exported `runContainerHost` + `ContainerHostDeps` from the barrel (custody internals stay
private) so the outside package composes via the existing `bootstrap` seam. Also exported the `MakeRunProvider`
TYPE (the §2b.3 sanctioned alternative) so the outside factory-builder annotates its return type cleanly.
`check-worker-daemon-boundary` PASS (only local types + the local alias crossed).

**2b-ii (OUTSIDE).** New LEAF `packages/worker-networked-host` — runtime deps EXACTLY
`{@armyofagents/worker-daemon, @armyofagents/provider-wire}` (provider-capability transitive; `OwnedLabelsCapability`
re-exported). `resolveProviderUrl(env)` mirrors `sandbox-provider.ts`'s `{kind:"none"|"url"}`; the bin
`src/bin/networked-host.ts` (names `bootstrapWorkerDaemon`) wraps `runContainerHost`'s `bootstrap` seam to inject
`makeNetworkedRunProvider(url)`. **★ The type bridge — F-cast fix, implemented as designed but with ONE correction:**
property-level narrowing (`capability.v !== OWNED_LABELS_CAPABILITY_VERSION`) does NOT re-type the whole
`OwnedLabelsCapabilityLike` object (it is a single interface, not a discriminated union), so passing `capability`
as-is still sees `v: number` (a real `tsc` error, not the design's assumed clean narrow). The cast-free bridge
that WORKS: re-validate the literals (throw/fail-closed on mismatch or absence — lands as the coarse
`lifecycle_error`), then REBUILD the leaf `OwnedLabelsCapability` from the PINNED literal consts + the validated
fields. Behaviourally a no-op (proven equal); type-wise honest, no `as`. A planned `v:2` is still rejected (the
forward-compat guard the blind down-cast would have erased).

**Guards (several invisible to local `check-*.mjs`).** `BIN_DIRS` + `boot-roots-expectation.json` extended in
LOCKSTEP (posture `resolver`, `resolverFile = resolve-provider-url.ts`, marker `return { kind: "none" };`) →
boot-roots now 4 roots, all non-unconditional. Combined-root `./Dockerfile` deps stage got the
`COPY packages/worker-networked-host/package.json …` line (the pr.yml:422-460 awk — verified locally by
simulating the awk: `missing=0`). Root `vitest.config.ts projects[]` += the package → `check-execution-census`
PASS. `AOA_WORKER_PROVIDER_URL` documented (env doc). `check-test-inventory --write` re-pinned. UNTOUCHED as
fenced: `docker/worker/Dockerfile` (E4-D01 exact closure), `checkDispatchDefaultOff`, the d1 compose,
worker-keystore. `check-gate-clause-wiring` E7-1 stays 4 (host names `NetworkedProviderDriver`, not
`E2bSandboxProvider`). Desktop path BYTE-IDENTICAL (provider-only threads `makeRunProvider: undefined` → gate
behaviour unchanged; `composeRuntime` gets the same effective args the `!` produced).

**Tests.** worker-daemon `dep-011-slice-2b-bin.test.ts` (4) — a makeRunProvider-only boot composes through all
four sites (composeDispatch args prove `provider: undefined, makeRunProvider: <fn>`), and the gate passes on the
factory alone (mounted_secret → `no_worker_identity`, flag-off → `dispatch_disabled`, both NOT `no_provider`).
worker-networked-host `make-run-provider.test.ts` (6) — resolver none/url; a URL yields a `NetworkedProviderDriver`
bound to the right baseUrl + capability (observed on the wire via an injected fetch, construction inert); the
three fail-closed edges (absent / `v:2` / wrong-audience). No new `DEP-011-*-result.md` (E6-F003) — this note IS
the record.

---

# The server-side sandbox REAPER — Slice A (the pure INERT reconcile)

**Status:** design (2026-08-30, post-recon). Awaiting the 3-agent adversarial review (§R.7). Ships INERT (flips
no gate; no loop wired; the real liveness oracle + the trigger are Slices B/C). Option-A reclamation: the
adapter-manager (the E2B key-holder, the sandbox OWNER) reclaims ORPHANED tenant sandboxes that a worker created
but could not tear down (its lease-bound cap expired — Slice 2a's honest orphan). This is what 2a's
`{outcome:"orphaned"}` hands off to. **Fork-INDEPENDENT:** Slice A takes the liveness oracle as an INJECTED
dependency, so the pull-vs-push channel decision (§R.0) is deferred to Slice B.

## R.0 — the architecture (confirmed) + the deferred fork

**The reaper reclaims DIRECTLY, server-local, inside the adapter-manager — NOT through the gated wire, NOT via a
capability.** The AM host holds the raw `provider` in-process (`server.ts:93-94`); the blessed precedent
`create-gate.ts` `teardownLoser` already calls `provider.destroy(sandboxId, ctx)` directly, server-local,
bypassing the gate, for exactly "the deploy-owed crash-orphan class" (`:108-118`); the worker `reconcile.ts`
(WRK-004) is the same shape (raw `list` + raw `reconcileCleanup`, no capability, `:75-114`). The gate is for
UNTRUSTED workers over the wire; the reaper is inside the trust boundary. Two facts also make the capability route
unavailable: the AM CANNOT mint (it holds only the control-plane PUBLIC key — verify-only), and the gated wire
CANNOT fleet-enumerate (`gateList` suppresses the cursor as a cross-tenant oracle, `owned-op-gate.ts:200-206`). So
the sweep MUST use the raw server-local `provider.list`.

**★ The deferred fork (Slice B, NOT Slice A): how the in-AM reaper learns DB terminal-lease truth.** The AM has NO
`DATABASE_URL` and `check-adapter-manager-boundary` FORBIDS a DB client (the runtime-dep set is an exact 3-package
allow-list). The control-plane has the DB but NOT the E2B key, and the DB stores no provider `sandboxId`. So the
correlation is inherently two-surface. **Pull** (the AM asks the CP a read-only "are these leases terminal?" query
over control-net — the AM's first outbound client, boundary-clean via the global `fetch`) vs **push** (persist the
sandboxId into the DB so the CP self-detects — but the CP still can't destroy, so it needs a wire-client + minted
per-orphan caps: three net-new things vs one). LEAN: **pull.** Slice A does NOT decide this — the oracle is a
function.

## R.1 — verified terrain

- **`provider.list`** (the port, frozen) returns `ResourceSummary` = `{ sandboxId, resourceLabels{org,target,
  worker,job,attempt,lease,deviceGeneration}, generation, state, hasLiveLease }` (`provider.ts:233-239`). ★
  `hasLiveLease` is a PROVIDER-state proxy (`state === "running"`, `e2b-provider.ts:308`) — NOT a DB lease check;
  it MISSES the running+terminal-lease strand (the exact orphan case). So the predicate MUST be DB-truth.
- **The reconcile precedents:** worker `reconcile.ts` (paginated `list` → `isOrphan` [default `!hasLiveLease`,
  `:73`] → `reconcileCleanup`) and `startup-reconcile.ts` (a one-shot boot pass; "INERT until wired — nothing here
  starts a loop", `:18-19`; SNAPSHOT-FIRST because the provider cursor is a sandboxId that shifts if you destroy
  mid-scan, `:341-344`; fail-closed three-way keep/kill/unknown, `:376-404`).
- **The DB truth the oracle will read (Slice B):** `leases.status` / `jobAttempts.status` vs
  `TERMINAL_ATTEMPT_STATUSES` / the `executionTargets.deviceGeneration` cutoff — exactly what `reapExpiredLeases`
  already reads (`job-control.ts:3396-3435`, generation cutoff `:1113-1119`). Slice A models this as an injected
  `isOrphan(summary) => "orphan" | "live" | "unknown"`.
- **Boundary:** `check-adapter-manager-boundary` (`adapter-manager-boundary.mjs:72-76,230`) pins the AM runtime
  deps to EXACTLY `[provider-wire, sandbox-e2b-provider, worker-daemon]`. Slice A adds NO dep (the raw provider +
  an injected oracle function + worker-daemon types/`hashResourceLabels`, all allow-listed). Stays green. NO
  metric surface exists in the AM (net-new — R.2 returns counts, defers emission to Slice C).
- **★ The invariants the correctness rests on (review F4 — state them):** (a) `provider.create` mints a FRESH
  sandboxId every time (`create-gate.ts:89`), and (b) the orphan predicate (terminal lease / superseded
  generation) is MONOTONIC (neither reverts). Together these — NOT snapshot-first — close the "destroy a re-used
  sandbox" hazard: a snapshot sandboxId is the SAME logical sandbox at reclaim (a new run has a new id), and an
  `"orphan"` verdict can never go stale into `"live"`. Snapshot-first ONLY addresses the cursor-shift. (c)
  `provider.list` ignores `ownershipSelector` → the sweep is GLOBAL (R.2). Slice B's oracle MUST PRESERVE
  monotonicity (never classify on a field that can flip back).

## R.2 — what Slice A builds (reshaped by the review — the oracle contract is the safety spine)

A PURE `reconcileReaper({ provider, resolveTruth, makeCtx, now, pageSize?, logger? }): Promise<{ reaped: number;
skipped: number; unknown: number; failed: number }>` in the adapter-manager (a new module; NOT the wire path). It
RETURNS counts + logs them — it does NOT emit a closed-label metric (review — the AM has NO metric surface, and
worker-daemon's `Metrics` `outcome` set is CLOSED and throws on `reaped`/`skipped`/`unknown`; the /metrics surface
+ any registration is Slice C). `makeCtx: () => ProviderOpContext` is the injected op-context source (both
`list(input, ctx)` and `reconcileCleanup(id, ctx)` REQUIRE it — a stable idempotencyKey per sweep; the
`reconcile.ts:50-51,:93` precedent). One pass:
1. **Snapshot the fleet FIRST** — page the raw `provider.list({ ownershipSelector: <placeholder>, pageSize },
   makeCtx())` to a full in-memory `ResourceSummary[]` BEFORE any destroy (the cursor is a sandboxId a mid-scan
   destroy would shift; `startup-reconcile.ts:341-344`). ★ `ownershipSelector` is a REQUIRED `ListInput` field
   (`provider.ts:241-245`) the reaper must supply as a placeholder — the FLEET-WIDE sweep works because
   `E2bSandboxProvider.list` IGNORES it (`e2b-provider.ts:297-299`); this is an IMPL behavior, NOT a port
   guarantee (R.1). The sweep is therefore GLOBAL across all tenants → fail-closed matters instance-wide.
2. **★ Structural pre-filter FIRST, before the oracle (review F1 — the mass-kill guard that needs no Slice B):**
   any summary with structurally-invalid labels — missing `leaseId`/`organizationId`/`jobId`, or the
   `generation === 0` sentinel (`E2bSandboxProvider.list` defaults `deviceGeneration ?? 0` and `labels = {}` on a
   parse failure, `e2b-provider.ts:118-120,:306`) — is classified `unknown`/SKIP WITHOUT calling `resolveTruth`. A
   sandbox the provider cannot coherently label must NEVER be reclaimed on inference.
3. **★ The oracle contract = POSITIVE CONFIRMATION OF DEATH (review F1/F3 — the safety spine).** Model the oracle
   as a BATCH prefetch (pull is async): `resolveTruth(summaries) => Promise<Map<sandboxId, "orphan"|"live"|
   "unknown">>` (snapshot-first, then ONE query over the snapshot's leaseIds; NOT a per-summary sync call). The
   map MUST be a POSITIVE confirmed-DEAD set — `"orphan"` ONLY on a CONFIRMED terminal lease/attempt OR a CONFIRMED
   superseded generation; **EVERY other state — row absent, leaseId unresolvable, query indeterminate, CP
   unreachable — DEFAULTS to `"unknown"`/skip.** NEVER a negative `leaseId ∉ live-set` inference (that mass-kills a
   just-created sandbox the query hasn't observed yet). This is the precedent's `state==="dead"` positive check +
   unknown-default (`startup-reconcile.ts:182,:386-393`), lifted into the CONTRACT so Slice B cannot re-open it.
4. **Reclaim + per-target containment (review F2):** for each `"orphan"`, `provider.reconcileCleanup(sandboxId,
   makeCtx())` wrapped in a PER-TARGET try/catch (like `startup-reconcile.ts:365-371`, NOT `reconcile.ts:93`'s
   unwrapped loop). READ `result.cleanupStatus`: `success` → `reaped`; `failed` (transient — the LIVE sandbox
   survives) → the `failed` bucket, RETRIED next pass, NEVER counted as reaped (`teardownLoser` SWALLOWS its error
   — the wrong accounting to copy); a caught throw → `failed`. `"live"`/`"unknown"` → `skipped`. A single failure
   never aborts the sweep. Already-gone = success (idempotent, `e2b-provider.ts:287-288`).
5. **Any-generation reclaim:** server-local (no gate owned-check), so an `"orphan"` is reclaimed keyed on DB
   terminal/superseded REGARDLESS of `generation` — the OPPOSITE of the gate's generation-equality
   (`owned-op-gate.ts:154`); safe because `provider.create` mints a FRESH id (R.1) so a superseded-gen orphan's
   distinct id can never be the live new-gen run.

## R.3 — fences

Slice A is the pure reconcile ONLY. NO liveness CHANNEL (the AM→CP query / the sandboxId persistence — Slice B, the
fork). NO trigger/loop wired (Slice C — a `setInterval` in the AM bin behind a flag, cadence < the E2B create-TTL
backstop). NO compose/deploy. NO DB dep on the AM (boundary + topology forbid). NO new wire op (the port is
frozen; `list`/`reconcileCleanup` exist). Ships INERT (nothing calls `reconcileReaper` in production yet). NO
`DEP-011-*-result.md` (E6-F003 open + owned; result note in this doc).

## R.4 — the component test + mutation sweep

Prove `reconcileReaper` against a FAKE provider (a seeded fleet — orphan/live/unknown, some already-gone, some
STRUCTURALLY-INVALID [missing leaseId / `generation:0`], some transient-`failed`) + a FAKE `resolveTruth` oracle.
Assert: (a) only `"orphan"` summaries get `reconcileCleanup`; (b) `"live"`/`"unknown"` are SKIPPED — the
fail-closed core; (c) **structurally-invalid summaries are SKIPPED WITHOUT calling `resolveTruth`** (the mass-kill
pre-filter); (d) snapshot-first — a fleet mutated during the scan doesn't skip/double-handle; (e) a transient
`cleanupStatus:"failed"` is counted `failed` (RETRIED), NEVER `reaped` (the LIVE sandbox survives); (f) a
per-target throw is contained (the sweep continues, that target → `failed`); (g) already-gone = success; (h) an
any-generation orphan (superseded `generation`) IS reclaimed. Mutation sweep: `"unknown"`→destroy (mass-kill →
killed by (b)); the oracle returns `"orphan"` for a structurally-invalid summary (→ killed by (c)'s
pre-filter-skip); reclaim-in-scan-loop not snapshot-first (cursor shift → killed by (d)); count a `failed` as
`reaped` (→ killed by (e)); an uncaught throw aborting the sweep (→ killed by (f)); a generation-equality gate on
the reaper (superseded orphan skipped → killed by (h)).

## R.5 — guards

`check-adapter-manager-boundary` (NO new runtime dep — the raw provider + injected functions + allow-listed
worker-daemon types → green); **`check-gate-clause-wiring`** — the reaper names the abstract `SandboxProvider`
port, NOT `E2bSandboxProvider` (keep the literal token out of NON-test source), and `reconcileCleanup`/`list` are
NOT declared symbols → E7-1 stays at 4 (review CONFIRMED); `check-execution-census` — GREEN unchanged (the AM is
ALREADY a vitest project and the new `.test.ts` is not a `scripts/`/`docker/` `.test.mjs`); `check-test-inventory`
(--write re-pin for the new AM `.test.ts`); `check-finding-ownership` (NO result doc). ★ NO worker-daemon change
(R.2 RETURNS counts — it does NOT touch `metrics.ts`'s closed set, so no `check-worker-daemon-boundary` / metric
registration is pulled in). NOT boot-roots / image / the combined-root Dockerfile (no new package, no bin change).
Run the WHOLE policy set.

## R.8 — review outcome (2 agents, 2026-08-30, every finding verified against source)

Two reviewers (correctness; boundary/guards). The two highest-value claims HELD: **inertness is genuinely sound**
(the AM bin never calls the reaper), and **the boundary + gate-clause + finding-ownership stories are correct**.
The authority model (direct server-local reclaim, mirroring `teardownLoser`), snapshot-first, `hasLiveLease`
rejection, and any-generation were all CONFIRMED. Findings folded above:
- **F1 (HIGH) — the oracle contract was fail-OPEN at its edges.** The mass-kill vector is absent/unparseable rows +
  negative inference (NOT a clean CP partition): `list` defaults `generation:0`/`labels:{}` on a bad record and
  ignores the selector (GLOBAL fleet). → R.2 POSITIVE-confirmation-of-death + `unknown`-default + the structural
  pre-filter (skip before the oracle).
- **F2 (MED) — partial-failure + accounting.** A thrown cleanup would abort the sweep; a transient `failed` counted
  as `reaped` masks a surviving live sandbox. → R.2 per-target containment + a `failed` bucket + read `cleanupStatus`.
- **F3 (MED) — the oracle seam.** Pull is async; a per-summary sync `isOrphan` is the wrong shape and the map
  DIRECTION is the fail-closed hinge. → R.2 batch `resolveTruth => Map` + the positive-confirmed-dead mandate.
- **F-metric (MED) — the AM has NO metric surface**, and worker-daemon's `outcome` set is CLOSED (the 2a trap). →
  R.2 returns counts + logs; emission deferred to Slice C.
- **F-ctx (LOW-MED)** — `list`/`reconcileCleanup` require a `ProviderOpContext`. → R.2 `makeCtx` (the `reconcile.ts`
  precedent).
- **F-selector (LOW-MED)** — the global-fleet sweep depends on an `E2bSandboxProvider` quirk (a required-but-ignored
  `ownershipSelector`), not a port guarantee. → R.1/R.2 stated; a true fleet-list affordance is owed.
- **F-invariants (LOW)** — fresh-ids + monotonic-predicate (the real reason the re-use TOCTOU is a non-issue). → R.1.

**Design is GO for the §9 build prompt** — Slice A is the pure, fail-closed, oracle-injected reconcile; the pull
channel (Slice B, the fork) + the trigger/metric surface (Slice C) come after.

## R.6 — what Slices B/C inherit (recorded)

**Slice B (the correlation channel — the fork):** the real `isOrphan` — pull (an AM→CP read-only lease-liveness
endpoint + the AM's global-`fetch` client, boundary-clean) or push (a DB `sandboxId` column + a CP→AM path). The
one deploy/boundary-sensitive piece. **Slice C (trigger + deploy):** the `setInterval` loop in the AM bin behind a
flag; cadence < the E2B create-TTL (`opDeadlineMs`, 60s default) so it reclaims before the interim TTL backstop,
covering the §2a.5-F3 gap (a long run refreshes the lease but NOT the set-once sandbox TTL); the compose/env; the
Slice-5 deploy-ordering.

## R.7 — open questions for the review

1. **Server-local reclaim is correct + sufficient.** Is the direct `provider.reconcileCleanup` (bypassing the
   gate, mirroring `teardownLoser`/`reconcile.ts`) the right authority model, and does it stay boundary-clean (no
   new AM dep)?
2. **The fail-closed predicate.** Is `"unknown"→skip` genuinely safe (no path mass-kills live sandboxes on a CP
   partition), and is `hasLiveLease` correctly REJECTED as insufficient (it misses the running+terminal strand)?
3. **Snapshot-first.** Is the cursor-shift hazard (destroy mid-scan) correctly handled by snapshotting the full
   fleet before any reclaim?
4. **Any-generation.** Is reclaiming a superseded-generation orphan correct (the reaper is the owner, not a gated
   worker), and does it not accidentally re-impose the gate's generation-equality?
5. **Guards + inertness.** Does the new `provider.reconcileCleanup` production caller trip `check-gate-clause-wiring`
   (β2 lesson), and does Slice A ship genuinely inert (no loop, no channel, oracle injected)?

## R.9 — BUILD RESULT (2026-08-30, ships INERT) — independently verified

Slice A SHIPPED CI-GREEN as `35ac5f29d` (run `33272818842`). `reconcileReaper`
(`packages/adapter-manager/src/reconcile-reaper.ts`) — pure; deps `{ provider, resolveTruth, makeCtx, now,
pageSize?, logger? }`; returns `{ reaped, skipped, unknown, failed }` + logs, NO metric. Verified against the
repo: **snapshot-first** fleet `list` (placeholder `FLEET_SELECTOR`, global) → **structural pre-filter**
(missing `leaseId`/`org`/`job` or `generation===0` → skip WITHOUT the oracle) → **one batch `resolveTruth`** →
reclaim ONLY a confirmed `"orphan"` via server-local `reconcileCleanup` in a **per-target try/catch** (a throw →
`failed`, sweep continues); a transient `cleanupStatus:"failed"` → `failed`, NEVER `reaped`; **positive-
confirmation-of-death** (map-absent/`unknown` → skip; no negative inference); any-generation. Injected oracle ⇒
fork-independent (Slice B) + inert (no production caller). Component test (5) + mutation sweep 6/6 (unknown→destroy,
oracle-orphan on a structurally-invalid summary, reclaim-in-scan cursor-shift, `failed`-counted-`reaped`,
uncaught-throw-aborts-sweep, generation-equality gate). Guards green: `check-adapter-manager-boundary` (no new
dep — worker-daemon-only import), `check-gate-clause-wiring` (E7-1 stays 4; `E2bSandboxProvider` never in
non-test source), `check-finding-ownership` (no result doc). **Concurrency note:** built in the shared `C:\e3`
tree alongside Slice 2b; `35ac5f29d` committed ONLY the 3 reaper files by explicit path (this §R.9 was added later
by the orchestrator, as the doc was dirty with 2b's edits at build time). **Next:** Slice B (the real
`resolveTruth` pull channel — the AM→control-plane lease-truth query; the fork) then Slice C (the trigger loop +
the AM metric surface).

---

# The server-side sandbox REAPER — Slices B + C (wire it live)

**Status:** design (2026-08-30, post-recon). **3-agent adversarial review DONE — 9 findings folded (§RBC.9).** Fork
RESOLVED → **PULL** (§R.0). One unit, sub-sliced **B1 → B2 → C**; ALL ship INERT (B1: the CP route 404s when EITHER
gate flag is off + has no caller; B2: the client has no caller; C: the loop is behind a default-off flag). This wires
the reaper LIVE: the AM asks the control-plane which leases are dead, then reclaims — but nothing runs until the
Slice-5 deploy flips the flags.

## RBC.0 — the shape + the decisions (recon-confirmed)

The reaper (Slice A) takes an injected `resolveTruth(summaries) => Promise<Map<sandboxId, "orphan"|"live"|
"unknown">>`. **B** builds the real one via PULL: the AM (which holds the fleet `list` + the E2B key, but has NO
`DATABASE_URL`) asks the control-plane (which has the DB but not the key) a READ-ONLY "which of these leases are
terminal/superseded?" query over `control-net`. **C** wires the `setInterval` loop + a metric surface. Decisions:
- **Auth = control-net membership, DOUBLE-gated, mTLS deferred to Slice 5.** The AM is NOT worker-enrolled (no
  session key / no device proof), so it cannot use `verifyWorkerOperationProof`. The precedent is DEP-005
  `_test/reap` (`worker-control.ts:926-968`) — but note EXACTLY how it gates: it is **DOUBLE-gated** on BOTH
  `readDistributedExecutionDeploymentFlag` AND a dedicated `AOA_D1_TEST_REAP_ENABLED` (`:949`), and its own comment
  (`:935-945`) states why: *"this route has NO authentication … so it must NOT become reachable merely because a
  real deployment turns AOA_DISTRIBUTED_EXECUTION_ENABLED on."* ★ **[B1-F1, HIGH — folded]** Staging MUST set
  `distributedExecutionEnabled=true` to run the distributed system, so mounting the truth route on that flag ALONE
  would expose an unauthenticated cross-tenant lease-oracle on control-net (where untrusted workers live) the instant
  staging turns distributed execution on — enforcement living as Slice-5 prose is the "false claim of enforcement"
  class. So B1 is **DOUBLE-gated like DEP-005**: an independent, default-off `AOA_ADAPTER_MANAGER_TRUTH_ROUTE_ENABLED`
  (read via `env[CONST]`), decoupled from `distributedExecutionEnabled` — with EITHER flag off the route 404s. This
  makes "enabling distributed execution can never BY ITSELF expose the endpoint" a CODE invariant, not a deploy note.
  Mount inside the `if (opts.distributedExecutionEnabled)` block (`app.ts:483`) AND check the second flag in the
  route's own pre-handler (BEFORE validation, mirroring `:948-953`). ★ **Slice 5 still MUST add mTLS / peer-allowlist
  on control-net before flipping the truth-route flag** (recorded RBC.5/RBC.7) — the double-gate makes the endpoint
  UNREACHABLE until then, but the durable auth is mTLS.
- **Tenant-scoped, NOT cross-tenant.** `runInTenant`/`runInTenantReadOnly` require a non-empty organizationId and
  the boundary FORBIDS org enumeration (`worker-control.ts:128-129`). Each summary carries `organizationId` (the
  reaper's structural pre-filter requires it, `reconcile-reaper.ts:120`). So group the batch by org and run
  `runInTenantReadOnly(appDb, orgId, …)` per group — org ids come from the REQUEST, never a `SELECT DISTINCT`.
- **Metric = a tiny AM-LOCAL counter on `/metrics`** (recon option c) — NO cross-package edit to worker-daemon's
  closed `outcome` set. The scrape wiring (a compose metrics port / Prometheus target) is Slice 5.
- **`makeCtx` = per-op-fresh** (`{ deadlineMs: now()+D, idempotencyKey: randomUUID() }`, `node:crypto` — the
  `startup-reconcile.ts:135` precedent). `reconcileCleanup` is idempotent (already-gone=success), so §R.2's
  "stable per sweep" note is moot — per-op-fresh is correct.

## RBC.1 — B1: the control-plane read-only lease-truth endpoint (net-new)

- **The query** — a PURE read-only repo method `classifyLeaseTruth(leaseIds) => Map<leaseId, "terminal"|"live"|
  "superseded"|"absent">` over `leases ⋈ jobAttempts ⋈ executionTargets` (mirroring what `reapExpiredLeases`
  reads, `job-control.ts:3385-3435`, + the generation cutoff `:1108-1119`), via `runInTenantReadOnly` per org.
  ★ **THE CORRECTNESS ANCHOR (review-CONFIRMED monotonic):** classify **superseded** = `executionTargets.
  deviceGeneration ≠ lease.targetGeneration` OR target `disabled`/absent (the MONOTONIC field, §R.1 — generation only
  ever increments, `lease.targetGeneration` is immutable-at-create); **terminal** = `leases.status ∈
  {released,expired,revoked}` OR `jobAttempts.status ∈ TERMINAL_ATTEMPT_STATUSES` (`job-fence.ts:63`). The B1
  reviewer verified against source that EVERY such column is monotonic and B1's terminal/superseded predicate is a
  strict SUBSET of the control-plane's own `isActiveFence` death definition (`job-fence.ts:467-473` + the generation
  cutoff `:1113-1119`) — it can never classify-dead anything the authority still renews. Critically: `expired`
  STATUS is terminal & irreversible (`renewLease` requires `status='active'` AND `expires_at > clock_timestamp()`,
  `:2403-2404` → an expired lease renews ZERO rows; re-leasing mints a NEW row) — but do NOT infer terminal from a
  soon-to-expire *deadline* a renewal could extend; classify ONLY on the durable status/generation columns.
  `absent` (leaseId unknown) → the client maps it to `"unknown"`, NOT orphan.
  ★ **[B1-F2, MEDIUM — folded] Superseded reads `lease.targetGeneration` from the ROW, NEVER the request.** The
  request carries only `leaseId` (RBC.4, post-fold); every generation/status value in the predicate is a DB read
  keyed by `leaseId`. A build that compared `deviceGeneration ≠ request.targetGeneration` would let a caller supply a
  stale generation to force "superseded" for a LIVE lease → a controllable mass-kill. The classifier NEVER reads a
  caller-supplied generation/attempt.
  ★ **[B1-F3, LOW — folded] Pin the explicit column projection** — SELECT only `leases.{id,status,targetGeneration,
  targetId}`, `jobAttempts.status`, `executionTargets.{deviceGeneration,status}`. NEVER `SELECT *`: `leases.fence` is
  a LIVE per-attempt bearer token (`leases.ts:38`), and the "decision never sees a secret" discipline
  (`check-secret-resolve-vectors`) must hold structurally. Add `classifyLeaseTruth` to the secret-resolve-vectors
  guard set (RBC.6) so a future added-column / `SELECT *` reds CI.
- **The route** — a NEW sibling router `adapterManagerControlRoutes` (taking `opts.tenantAppDb`; the actor is the
  AM, not a worker, so keep it out of `worker-control.ts`), path `POST /api/adapter-manager-control/lease-truth`
  ★ **[Guards-F2 — folded]** (name it explicitly; AVOID the `distributed-execution/{public-services,cloud-plugins}`
  reserved prefixes that `validateAppSourceBoundary` in `check-distributed-execution-foundation.mjs:1983` bans — our
  path does). Mounted in `app.ts`'s `distributedExecutionEnabled` block, with a **route-level pre-handler** (before
  `validate`, mirroring `worker-control.ts:948-953`) that 404s unless `env[TRUTH_ROUTE_ENABLED_ENV]?.trim() === "1"`
  — the B1-F1 double-gate. Reads ONLY identifiers/enums — the pinned projection above, NO secret column.
- **Ships INERT:** the route 404s pre-flag, and nothing calls it (the AM client is B2). **Test:** a `server/src/
  __tests__/*.integration.test.ts` on embedded-PG (mirror `job-leasing.integration.test.ts`) seeding leases/
  attempts/targets in each state (terminal-lease / terminal-attempt / superseded-gen / disabled-target / live /
  absent) in ONE tenant → assert the per-leaseId classification.

## RBC.2 — B2: the AM outbound client (the AM's FIRST outbound client)

- A NEW AM module `src/reaper-truth-client.ts` exporting `makeControlPlaneResolveTruth(url, fetchImpl?): ResolveTruth`
  (matching the injected type; `fetchImpl` defaults to global `fetch`, injectable so the test spies the hop). GLOBAL
  `fetch` — boundary-clean (`fetch` ∉ `FORBIDDEN_GLOBAL_WORDS`; the AM boundary acts only on `require(`); NO new dep
  — the manifest stays `[provider-wire, sandbox-e2b-provider, worker-daemon]`). The precedent is
  `NetworkedProviderDriver`'s global-fetch client (`driver.ts:187-196`).
- **This is now the REAL oracle** (Slice A's injected `resolveTruth` was the seam; B2 is the thing the reaper trusts
  to reclaim). So the mapping is **STRUCTURAL positive-confirmed-death, not prose** ★ **[B2C-F2, MED-HIGH — folded]**:
  (1) require `res.ok` FIRST — global `fetch` does NOT throw on non-2xx, so a naive `await res.json()` on a 500 body
  reads error fields as truth; (2) shape-guard the body (`verdicts` is a plain object); (3) INITIALIZE every
  sandbox's verdict to `"unknown"`; promote to `"live"` ONLY on exact `=== "live"`; promote to `"orphan"` ONLY on
  exact `=== "terminal"` or `=== "superseded"`; **any other string (an unrecognized 5th enum, wrong-case, protocol
  drift), a missing key, a non-2xx, a throw, or a timeout → stays `"unknown"`.** NEVER a negative default like
  `v === "live" ? … : "orphan"` (that maps any out-of-contract value to a fleet-wide mass-kill).
- **The client NEVER rejects** — every failure path RESOLVES to a Map (all-`unknown` for that batch). A throwing
  `resolveTruth` would crash C's loop (RBC.3/B2C-F1); the two interlock.
- **Bounded fetch** ★ **[B2C-F3, MED-HIGH — folded]:** each POST carries `signal: AbortSignal.timeout(D)` with D ≪
  the sweep cadence; a hung CP → the abort → `"unknown"` (fail-closed), so a stalled CP can't pile up overlapping
  sweeps (with C's self-reschedule, RBC.3).
- **The keying** ★ **[B2C-F7 / Guards-F1 — folded]:** build the result by ITERATING THE CLIENT'S OWN summaries —
  `map.set(summary.sandboxId, mapVerdict(verdicts[summary.resourceLabels.leaseId]))` — NEVER by iterating the CP's
  `verdicts`. Two sandboxes sharing a `leaseId` (a retried create) then BOTH get that lease's verdict — fail-safe
  (both reaped iff the shared lease is terminal, both skipped iff live; `leases.id` is a globally-unique UUID so
  cross-org merge is collision-free). The reaper backstops this at consumption (`truth.get(id) ?? "unknown"`,
  `reconcile-reaper.ts:173`) but the CLIENT must not emit a spurious positive `"orphan"`.
- **The flow:** group the summaries by `organizationId`; POST the per-org batch(es) to the CP URL; apply the
  structural mapping above. The CP URL = a new bin env read via `env[CONTROL_PLANE_URL_ENV]` (Guards-F3 —
  `env[CONST]` indirection, mirroring `PROVIDER_ENV`; a raw `process.env.AOA_…` literal would fire brand-check step 9
  and force docs at B/C time), injected into the client by the bin.
- **Ships INERT** (no production caller until C). **Test:** a pure AM `.test.ts` with a fake `fetch` → assert
  confirmed→orphan, live→live, and — the mutation cases — an UNRECOGNIZED enum, a non-2xx with a JSON body, a missing
  `verdicts` key, a timeout, and a shared-leaseId multi-sandbox batch ALL → `"unknown"`/fail-safe; assert per-org
  grouping (a 2-org batch → the right requests); assert the client never rejects. Load the RBC.4 fixture.

## RBC.3 — C: the trigger loop + the AM metric surface

- **The loop lives in an extracted `startReaperLoop({ scheduler, reconcile, logger, intervalMs })`** ★ **[B2C-F4 —
  folded]** where `reconcile: () => Promise<ReconcileReaperResult>` is an INJECTED THUNK the bin builds (closing over
  the raw `provider` (`:129`), `makeCtx` per-op-fresh (RBC.0), and B2's `resolveTruth`). This isolates the loop from
  the real network/E2B so the test asserts "exactly one `reconcile` call" — a `scheduler?`-only seam can't (the bin's
  callback would bind the real fetch+E2B). Called from `bootAdapterManager` (`bin/adapter-manager.ts:102`).
- **Tick containment is the loop's JOB** ★ **[B2C-F1, HIGH — folded]:** `reconcileReaper` wraps ONLY the per-target
  `reconcileCleanup` (`reconcile-reaper.ts:188-213`) — the fleet `provider.list` (`:140-147`) and the `resolveTruth`
  await (`:166`) are UNWRAPPED, so a `provider.list` throw (a 5xx/socket error from the raw E2B provider over the
  net) REJECTS the whole tick. The AM bin has NO `unhandledRejection` handler and the loop runs in the SAME process
  as the gated create/execute/teardown host (`server.listen`) — an unhandled tick rejection would crash the host
  serving LIVE workers. So: (1) every tick is `.catch()`-guarded (log at error + swallow — a failed sweep neither
  crashes the process nor stops the loop); (2) use a **self-rescheduling `setTimeout` chain with a re-entrancy guard**
  (schedule the next tick in the settled `.finally`), NOT raw `setInterval`, so a slow/hung sweep can't overlap the
  next; (3) B2's `resolveTruth` never rejects (RBC.2) — belt-and-suspenders.
- **Gated DEFAULT OFF, STRICT parse** ★ **[B2C-F5 — folded]:** read `env[REAPER_ENABLED_ENV]` (`env[CONST]`
  indirection, Guards-F3); enabled IFF `.trim() === "1"`. Unset / `""` / `"0"` / `"false"` / anything else = OFF (a
  loose `Boolean(env[X])` or `!== undefined` would enable on `"0"`/`"false"` and break inertness). Table-test the
  off-tokens.
- **Start pre-conditions are a REFUSAL, not a silent no-op** ★ **[B2C-F6 — folded]:** the loop starts ONLY when the
  flag is on AND the provider is constructed AND the CP URL is configured. Flag-on but CP-URL-missing → **refuse
  loudly** (throw/`refused`, mirroring the bin's "★ WHY A BAD PROVIDER CONFIG IS A REFUSAL" philosophy,
  `bin:110-168`) or at minimum an error-level log — NEVER fold it into the silent success path (a silently-dead
  reaper lets orphans accumulate with zero signal, the exact failure Option-A exists to prevent). Flag-OFF is the
  only clean no-op.
- **Cadence** = `env[REAPER_INTERVAL_MS_ENV]` (name it NOW — Guards-F3; e.g. `AOA_ADAPTER_MANAGER_REAPER_INTERVAL_MS`),
  DEFAULT < the E2B create-TTL (`DEFAULT_TTL_MS = 60_000`, `e2b-provider.ts:72`), so a sweep reclaims before the
  interim TTL backstop. `env[CONST]` indirection (not a raw literal).
- **The metric surface** — a tiny AM-LOCAL counter (accumulating `reaped`/`skipped`/`unknown`/`failed` across sweeps),
  created as ONE shared in-memory ref by the bin BEFORE `startServer` ★ **[B2C-F9 — folded]**, passed into BOTH a new
  `/metrics` arm of the AM `createProviderServer` (beside `/healthz`, `server.ts:176-183`) AND the loop (single event
  loop ⇒ no race). `/metrics` renders zeros when no reaper is wired (ungated servers still call
  `createProviderServer`). NO worker-daemon edit, NO closed-set constraint. The scrape target is Slice 5.
- **Ships INERT** (flag default off). **Test:** flag-off → the scheduler is never armed; flag-on → the fake scheduler
  fires → exactly ONE `reconcile` call, and a REJECTED `reconcile` is swallowed (the loop survives, locks in
  containment); the strict-parse off-token table; flag-on-but-URL-missing → refusal; `/metrics` renders the
  accumulated tally + zeros unwired.

## RBC.4 — the wire contract (freeze first, PINNED AS A FIXTURE)

Freeze the request/response JSON BEFORE B1/B2 (they meet only at the wire, so a frozen contract lets them land in
parallel). ★ **[B1-F2 — folded] Request carries `leaseId` ONLY** (drop `jobId`/`attempt`/`targetGeneration` — they
are redundant with immutable DB columns the CP already holds by `leaseId`, and a caller-supplied generation next to
the classifier is a mass-kill trap): `{ orgs: [{ organizationId, leases: [{ leaseId }] }] }`. Response:
`{ verdicts: { <leaseId>: "terminal" | "live" | "superseded" | "absent" } }`. Identifiers/enums ONLY.

★ **[Guards-F1, MEDIUM — folded] Pin the wire as a machine-checked fixture,** not prose. This repo pins EVERY other
cross-process contract as a dual-asserted fixture (`tests/fixtures/{device-proof,secret-resolve,worker-protocol-*,…}`,
12 dirs) — the lease-truth endpoint would otherwise be the sole net-new cross-process wire with no pinned contract, so
a field-name/enum divergence (`verdicts` vs `results`; `superseded` vs `stale`) would pass BOTH sides' green tests and
first surface at Slice-5 live wiring, wasting the parallel landing RBC.8 banks on. Add `tests/fixtures/
reaper-lease-truth/v1/` with a frozen request + response example — INCLUDING a multi-sandbox-per-lease case (two
summaries, one `leaseId`, verdict `superseded` → both fail-safe, per the RBC.2 keying) — loaded and asserted by BOTH
B1's integration test AND B2's unit test. The fixture IS the freeze.

## RBC.5 — fences

NO compose/deploy change (Slice 5 owns the AM image + the CP-URL/reaper-flag/CP-key compose envs + the `/metrics`
scrape target + mTLS on control-net). NO cross-package worker-daemon edit (the AM-local counter avoids the closed
set). NO new AM runtime dep. NO capability/gate on the reaper path (server-local, Slice A). Ships INERT (routes
404 pre-flag; the loop is flag-off). NO `DEP-011-*-result.md` (E6-F003 open + owned; result note in this doc).
★ **The truth route is DOUBLE-gated** (`distributedExecutionEnabled` AND `AOA_ADAPTER_MANAGER_TRUTH_ROUTE_ENABLED`,
B1-F1) — a CODE invariant that enabling distributed execution can never BY ITSELF expose the unauthenticated oracle.
★ **Slice-5 deploy-gate (recorded, hard):** mTLS/peer-allowlist on control-net BEFORE the truth-route flag is
flipped live.

## RBC.6 — guards (review-swept: register COMPLETE, no missed guard of the β2/Slice-1/2b class)

`check-adapter-manager-boundary` (the client + counter add NO new dep — global `fetch`, `node:crypto` `randomUUID`,
worker-daemon types → green; verified: the lib pushes an error ONLY for `require(`, `:188-191`, so global `fetch` is
clean and the manifest stays `[provider-wire, sandbox-e2b-provider, worker-daemon]`); `check-gate-clause-wiring` (the
client + loop must NEVER name `E2bSandboxProvider` in non-test source; `reconcileReaper`/`reconcileCleanup`/
`provider.list` are NOT tracked symbols + there is no DEP-011 clause → E7-1 pin stays 4); `check-secret-resolve-vectors`
★ **[B1-F3 — folded]** — today it scans only the DAT-004 fixture + `job-fence.ts` and does NOT walk `server/src/routes`,
so B1's route is invisible to it; ADD `classifyLeaseTruth` to its guard set + pin the explicit column projection
(RBC.1) so a future `SELECT *`/added-column reds CI (`leases.fence` is a live bearer token); `checkEnvDocumented`
(document all THREE new envs — `AOA_ADAPTER_MANAGER_CONTROL_PLANE_URL`, `AOA_ADAPTER_MANAGER_TRUTH_ROUTE_ENABLED`,
`AOA_ADAPTER_MANAGER_REAPER_ENABLED`, plus the cadence `AOA_ADAPTER_MANAGER_REAPER_INTERVAL_MS` — in
`docs/deploy/environment-variables.md`; compose-driven so it stays dormant until Slice 5, but document proactively).
★ **[Guards-F3 — folded] brand-check step 9** (`pr.yml:676`) greps `process\.env\.AOA_[A-Z_]+` over `packages` and
would force docs as a HARD `ci-required` gate at B/C time — so read EVERY new AM env via `env[CONST]` indirection (a
named string const, mirroring `PROVIDER_ENV = "AOA_ADAPTER_MANAGER_SANDBOX_PROVIDER"`), NOT a raw
`process.env.AOA_…` literal; the AM package has zero `process.env.AOA_` literals today and must stay that way.
★ **[Guards-F2 — folded] Route-drift IS guarded** (correcting "no route-drift guard exists"): `validateAppSourceBoundary`
(`check-distributed-execution-foundation.mjs:1967-1987`, a `policy` guard) scans `app.ts` and reds on reserved import
patterns + route literals matching `distributed-execution/{public-services,cloud-plugins}` (`:1983`) — our
`/api/adapter-manager-control/lease-truth` path avoids both, but name it (RBC.1) so the builder doesn't drift into a
reserved prefix. `check-execution-census`/`check-test-inventory` (--write re-pin; root `vitest.config.ts` `projects[]`
already lists BOTH `server` and `packages/adapter-manager`, `:24` → no `projects[]` change; B/C add `.test.ts` not
`.test.mjs` → census manifest untouched); NO new package (no combined-root Dockerfile / boot-roots — the 2b traps
don't recur). Run the WHOLE policy set.

## RBC.7 — what Slice 5 (deploy) inherits (recorded)

mTLS/peer-allowlist on control-net (the truth endpoint's real auth); the AM Docker image; the compose envs
(`AOA_ADAPTER_MANAGER_CONTROL_PLANE_URL` → the CP service, `AOA_ADAPTER_MANAGER_REAPER_ENABLED=1`, the cadence);
the `/metrics` scrape target; the real control-plane keypair; flipping `distributedExecutionEnabled` (mounts the
truth route). Only after all of that does the reaper actually run.

## RBC.8 — sub-slicing

**B1 → B2 → C** (each independently CI-green + inert). Freeze RBC.4's contract first; then **B1 (CP route + query)
and B2 (AM client) can land in parallel** (they meet only at the wire). **C strictly last** — it is the ONLY slice
that introduces a running loop, so isolating it behind its own flag is what makes "inert" verifiable. Do NOT fold C
into B.

## RBC.9 — review outcome (3-agent adversarial review, 2026-08-30 — all findings folded above)

Three agents reviewed against source: **B1 correctness+auth**, **B2+C client+loop**, **guards+cross-surface**. The
correctness/monotonicity anchor + tenant-scope (leak-free by RLS) + inertness×3 were all verified SOUND, and the
guard register is COMPLETE (no missed guard of the β2/Slice-1/2b class — a FIRST for this programme). Nine findings
folded (each tagged at its clause above); orchestrator-verified the two load-bearing ones against source (DEP-005
double-gate at `worker-control.ts:949`; app.ts single-flag block at `:483`):
- **B1-F1 (HIGH)** — the truth route on the `distributedExecutionEnabled` flag alone = an unauthenticated cross-tenant
  oracle the instant staging enables distributed execution; DEP-005 `_test/reap` is DOUBLE-gated precisely for this
  → added `AOA_ADAPTER_MANAGER_TRUTH_ROUTE_ENABLED` (RBC.0/.1/.5).
- **B2C-F1 (HIGH)** — a rejected sweep tick (`provider.list`/`resolveTruth` unwrapped in `reconcileReaper`) crashes
  the AM host serving live workers → C owns tick containment: `.catch` + self-rescheduling `setTimeout` + re-entrancy
  guard + `resolveTruth`-never-rejects (RBC.3/.2).
- **B2C-F2 (MED-HIGH)** — the client is the REAL oracle; make positive-confirmed-death STRUCTURAL (start-unknown,
  promote-only-on-exact, `res.ok` + shape guard) so an out-of-contract/error response can't mass-kill (RBC.2).
- **B2C-F3 (MED-HIGH)** — `AbortSignal.timeout` on the fetch; a hung CP → unknown, no overlapping sweeps (RBC.2/.3).
- **B1-F2 = B2C-F8 (MED)** — drop `jobId`/`attempt`/`targetGeneration` from the request; superseded reads the ROW
  (RBC.4/.1).
- **Guards-F1 (MED)** — pin the wire as a `tests/fixtures/reaper-lease-truth/v1/` fixture asserted by both sides,
  incl. a multi-sandbox-per-lease case (RBC.4); keying = iterate-own-summaries, fail-safe (RBC.2).
- **B2C-F4 (MED)** — extract `startReaperLoop({ scheduler, reconcile })` — the reconcile thunk is the testable seam
  (RBC.3).
- **B2C-F5 (MED)** — strict `=== "1"` flag parse (RBC.3).
- **B2C-F6 (LOW-MED)** — flag-on-but-URL-missing = a loud refusal, not a silent dead reaper (RBC.3).
- **B1-F3 (LOW)** — pin the column projection + add `classifyLeaseTruth` to `check-secret-resolve-vectors` (RBC.1/.6).
- **B2C-F9 (LOW)** — one shared `/metrics` counter ref, created before `startServer` (RBC.3).
- **Guards-F2 (LOW)** — name the route path away from the `validateAppSourceBoundary` reserved prefixes (RBC.1/.6).
- **Guards-F3 (LOW)** — `env[CONST]` indirection so brand-check step 9 doesn't force docs at B/C time; name the
  cadence env now (RBC.2/.3/.6).

## RBC.10 — build result (2026-08-30, Slices B1 + B2 + C SHIPPED INERT)

Built on branch `claude/reaper-slices-b-c-aa36f0` → PR
[#329](https://github.com/MeteoriteLabs/AoA/pull/329) (base `docs/replatform-program`). All three sub-slices
landed INERT, each independently green, in the sub-slice order STEP 0 → B1 → B2 → C.

- **STEP 0** — `tests/fixtures/reaper-lease-truth/v1/` frozen (request/response + a `summaries.json`/
  `expected-client-verdicts.json` pair carrying the multi-sandbox-per-lease case), dual-asserted by B1's
  integration test AND B2's unit test.
- **B1** — `1d8aab688`. `classifyLeaseTruth` (`packages/db/src/repositories/tenant/lease-truth.ts` pure classifier +
  the `job-control.ts` query) + `POST /api/adapter-manager-control/lease-truth` (double-gated, INERT). Pure arms
  17/17; embedded-PG integration test + fixture assertion (Linux CI is the authority — see the env note below).
- **B2** — `f7e47f335`. `packages/adapter-manager/src/reaper-truth-client.ts`. 14/14, incl. the fixture round-trip.
- **C** — `e77e7499b`. `reaper-loop.ts` + `reaper-metrics.ts` + the `server.ts` `/metrics` arm + the bin wiring.
  Full AM suite 143/143 (loop/metrics/metrics-server + bin flag-off/on/refusal). Full `pnpm -r build` clean.

Guards run locally green: `check-secret-resolve-vectors` (+ its node:test), `check-adapter-manager-boundary`
(+ self-test), `check-gate-clause-wiring` (E7-1 pin stays 4 — the new AM modules never name `E2bSandboxProvider`),
`check-distributed-execution-foundation` (`validateAppSourceBoundary` — the `adapter-manager-control` path avoids the
reserved prefixes), `check-finding-ownership` (no `DEP-011-*-result.md`), `check-test-inventory`,
`check-execution-census`, and the brand-check step-9 env-doc replica (all four new envs documented; every new AM env
read via `env[CONST]`).

**`ci-required` GREEN** on the tip (`3d2262b84`): run
<https://github.com/MeteoriteLabs/AoA/actions/runs/33293683375> — `policy`, `verify` (4 shards), `e2e`,
`e2e-pgvector`, `migrations`, `lint`, brand-check, and contract-bytes all pass; the B1 integration test ran green on
Linux embedded-PG. Two Linux-CI-only failures were caught and fixed on the first CI pass (`3d2262b84`), neither
reproducible locally (both hit the drizzle `require(esm)` cycle here): the integration test passed the
`NonOwnerDbConnection` wrapper instead of `app.db` to `runInTenantReadOnly` (→ `db.transaction is not a function`),
and adding `classifyLeaseTruth` tripped `job-fence-surface.contract.test.ts`'s CLOSED-method-surface guard (now
classified as an UNGUARDED control-plane read).

**Deviations from the brief (all recorded, none material):**
- **B1-F3 guard mechanism.** The brief said "add `classifyLeaseTruth` to `check-secret-resolve-vectors`'s guard
  set." That guard was a PURE fixture-vector verifier with no source-scanning "guard set." Honoring the finding's
  INTENT, I appended a real `verifyClassifyLeaseTruthProjection(root)` to it: a sentinel-delimited
  (`<classify-lease-truth-projection>…</…>`) source scan of the `job-control.ts` projection that reds on a bare
  `.select()` or any `fence` column (mutation-verified: injecting `fence: leases.fence` reds the guard; revert
  greens it). Same lane, same "a decision never sees a secret" seam.
- **Drizzle-orm ESM cycle.** Importing the pure classifier from `job-control.ts` dragged drizzle in (the repo's
  known `require(esm)` cycle under vitest). Resolved by extracting the verdict type + `classifyLeaseTruthRow` into a
  drizzle-free `lease-truth.ts` module — the classifier's only dependency is `job-fence.ts`'s
  `TERMINAL_ATTEMPT_STATUSES`, so the cross-platform unit test imports it with no drizzle.
- **Local build environment (not a code change).** This worktree sits at a deep OneDrive path; `pnpm install`
  aborts applying its three dependency patches (`process.chdir` past Windows MAX_PATH, unaffected by `subst`/junction
  because pnpm realpaths the store). For LOCAL validation only I installed patch-less (patches are dev tooling;
  integration tests skip on Windows regardless), then restored `package.json`/`pnpm-lock.yaml` — neither is in any
  commit. The embedded-PG B1 integration test cannot run locally (the same drizzle `require(esm)` cycle fails the
  reference `job-leasing.integration.test.ts` identically here); Linux CI is its authority.
