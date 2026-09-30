# DEP-012 — Slice 1 · Unit B2 (Wave α) — RESULT

**Epic:** E6 · **Ticket:** DEP-012 · **Unit:** Slice 1 · Unit B2 (Wave α)
**Status:** SHIPPED, component-tested, CI-pending. Design of record: [`DEP-012-design.md`](./DEP-012-design.md) `# Slice 1 · Unit B2 (Wave α)`.
**Builds on:** Unit A (create+execute wire plumbing) + Unit B1 (signed-capability `execute` gate). **On `v:1`.**
**Precondition:** Unit B1 shipped (`ef582ed08`). Component-level (driver↔server); NOT through the daemon.

---

## What shipped

The SERVER-side mechanism for the **6 remaining gated ops** — the 4 teardown ops
(`cancel/kill/destroy/reconcile_cleanup`) + redacted `inspect`/`list` — gated over the wire on a
GATED adapter-manager server, driven through the networked driver with a test-minted capability.
Only `packages/adapter-manager` + `packages/provider-wire` changed; **worker-daemon, `cleanup-authority.ts`,
`supervisor.ts`, `startup-reconcile.ts`, and the authoritative port are UNTOUCHED** (asserted — see Boundary).

1. **A generalized owned-op gate** — B1's `gateExecute` refactored into
   `gateOwnedOp(deps, sandboxId, ctx, capability, dispatch)` (`packages/adapter-manager/src/owned-op-gate.ts`).
   verify (fail-closed) → `provider.inspect` AM-local → **the inspect-catch MIRRORS `#requireOwned` EXACTLY**
   (`cleanup-authority.ts:158-161`): `SandboxNotFoundError` → the uniform `ResourceNotAvailableError`; **any
   OTHER (transient/non-NotFound) inspect fault is RETHROWN as its own class.** Field-wise owned-check (BOTH
   clauses: `labelsEqual` AND `generation === deviceGeneration`) → `dispatch()` **OUTSIDE the inspect-collapse
   try** (a dispatch fault propagates as its own class). `execute` is now `gateOwnedOp(…, () =>
   provider.execute(input,ctx))`.
   - **★ This CORRECTS B1's shipped `execute-gate.ts:78-80` collapse-ALL.** Collapsing a transient to
     `ResourceNotAvailableError` on the IDEMPOTENT teardown ops makes `CleanupAuthority.converge`
     (`cleanup-authority.ts:300-301`) read it as "vanished → success" and LEAK the sandbox. A transient is
     existence-orthogonal, so surfacing it distinctly stays oracle-safe.
2. **The 4 teardown ops** on the server via `gateOwnedOp(…, () => provider.<op>(sandboxId, ctx))`
   (`StopResult`/`CleanupResult`, non-sensitive, byte-identical to Unit A/B1).
3. **`inspect` (redacted)** — the route returns `redactProjection(the ALREADY-FETCHED detail)` — never
   `provider.inspect` raw, never the full `InspectResult`. `redactProjection` is the server-side `#redact`
   shape: an **explicit 5-field literal** `{sandboxId, resourceLabelsHash: hashResourceLabels(labels),
   generation, state, providerOpId}` (no spread). `hashResourceLabels` imported from `@armyofagents/worker-daemon`.
4. **`list` (scoped + redacted)** — `gateList` verifies → `provider.list({ownershipSelector: <coarse fields of
   cap.ownedLabels>})` → filters BOTH clauses → redacts each → `RedactedResourceProjection[]`. Narrow
   single-tuple own-resource list only.
5. **★ EXHAUSTIVE fail-closed routing** (`server.ts`). On a GATED server EVERY gate-required op
   (execute + 4 teardown + inspect/list, in `GATE_REQUIRED_OPS`) routes THROUGH the gate; NO raw handler is
   reachable. The 5 NEW ops have NO Map handler at all → on an UNGATED (keyless) server they `404`, NEVER a raw
   `provider.inspect`/`list` (which would leak env/secrets). Only `execute` keeps its keyless-ungated handler
   (Unit A back-compat); `create` stays gate-free.
6. **The 6 driver methods + port-type synthesis** (`packages/provider-wire/src/driver.ts`). `#post`'s op type
   widened to `ProviderOperation`. `inspect`/`list` satisfy the port by SYNTHESIZING from `cap.ownedLabels` +
   the server's redacted projection: `InspectResult{resourceLabels: cap.ownedLabels, state + generation FROM
   THE PROJECTION, sandboxId, providerOpId, EMPTY sensitive fields}`; `list → ResourceSummary[]` synthesizes
   `hasLiveLease = (proj.state === "running")`. A new shared wire type `RedactedListResult`
   (`packages/provider-wire/src/projection.ts`) carries the redacted rows + `providerOpId` (+ `nextPageToken`,
   always `null` — see F1 below).

### Test evidence
- **`packages/adapter-manager/src/__tests__/owned-op-gate.test.ts`** — NEW, **29 tests**: teardown allow-path
  (owned → dispatched), teardown/inspect/list refusals (foreign → uniform, NOT dispatched; missing-cap
  fail-closed parity; byte-identical oracle collapse); allow-path dispatch faults surface their own class
  (execute + 4 teardowns); a transient inspect fault surfaced distinctly (not collapsed, dispatch not run) for
  cancel+destroy; inspect redacted + no sensitive crossing (wire-byte assertions); list scoped + redacted +
  mixed-owner filtering (both clauses); exhaustive routing (ungated 404s the 5 new ops, keyless execute still
  works; gated capability-less refuses with RNA not 404); **the F1 regression** (no foreign-id cursor).
- **`gate.test.ts`** — B1's 8 gate tests stay green; ONE was UPDATED (see Discrepancy below).
- **Total: 83 green** across `adapter-manager` (55) + `provider-wire` (28). Typecheck clean.

---

## Mutation table (TDD step 10 — each clause mutated individually, a test kills each)

| # | Mutation | Killed by |
|---|----------|-----------|
| M1 | inspect-catch collapses ALL throws (the B1 bug) | 3 — gate transient + 2 owned-op transient (cancel/destroy) |
| M2 | rethrow `SandboxNotFoundError` (break the collapse) | 2 — byte-identical oracle-collapse (execute + teardown) |
| M3 | drop `labelsEqual` from the owned-check | 8 — every foreign refusal (execute + 4 teardown + inspect + …) |
| M4 | drop the `generation` clause | 1 — the generation-skew test (gate.test) |
| M5 | verify-failure propagates (no uniform collapse) | 1 — bad-sig / expired / wrong-audience refusal |
| M6 | `dispatch()` moved INSIDE the inspect-collapse try | 5 — allow-path dispatch faults (execute + 4 teardown) |
| M7 | redaction leaks via `{...detail}` spread | 2 — inspect + list wire-byte assertions |
| M8 | drop `inspect` from `GATE_REQUIRED_OPS` | 4 — inspect allow-path / wire-bytes / foreign / gated-refuse |
| M9 | drop the `labelsEqual` fine filter in `list` | 2 — mixed-owner list + list wire-bytes |
| M10 | `hasLiveLease` hardcoded `false` | 1 — list synthesis |
| M11 | inspect `state` invented (`"stopped"`) not from projection | 1 — inspect synthesis |
| F1 | `list` returns the provider's real `nextPageToken` (cursor passthrough) | 1 — the F1 regression |

All 12 mutants killed. No surviving mutant.

**Note (not a defect):** the MISSING-capability path is defended by THREE independent backstops (the explicit
`capability === undefined` throw, the verify try/catch collapse, and the owned-check mismatch), so no single-line
mutation isolates it — that is robustness, not vacuity; the "NOT dispatched" transport-counter assertions prove
the security property (a missing capability never reaches `provider.<op>`).

---

## Adversarial review (4 dimension reviewers + 1 skeptic, refute-from-source, default-refuted)

- **Routing** — 5/5 charges REFUTED (no gated-op reaches a raw handler; ungated inspect/list 404; Map (not
  object) blocks prototype keys; op-name strings match driver↔server incl. `reconcile_cleanup`; single decode).
- **Gate-collapse** — 5/5 REFUTED (transient rethrown; not-found/mismatch byte-identical; dispatch outside the
  try; both owned-check clauses on the right fields; verify strictly before inspect).
- **Redaction** — no leak; all charges REFUTED (explicit literal; `encodeOkResponse` result-agnostic;
  `hashResourceLabels` one-way; list filter excludes foreign + same-coarse-different-fine; selector from the
  capability not the client).
- **Port-synthesis** — 6/6 REFUTED (state/generation from the projection; sensitive fields empty; `hasLiveLease`
  faithful; `nextPageToken` passthrough; `#ownedLabels` fail-closed; port shapes conform; typecheck passes).
- **SKEPTIC** — 1 CONFIRMED (F1, LOW) → **FIXED**; everything else REFUTED (ungated raw leak; spread/extra-field
  leak; client-selector cross-tenant rows; forged/expired/wrong-audience/`v:2` capability; transient→cleanup-leak
  — a non-NotFound inspect fault crosses as `WireProtocolError`, NOT `ResourceNotAvailableError`, so converge
  retries rather than leaks).

### What survived and was fixed — F1 (the one CONFIRMED finding)
`gateList` originally passed the provider's real `nextPageToken` through. `E2bSandboxProvider.list`
(`e2b-provider.ts:297-317`) does NOT push the ownership selector into pagination — it forwards only
`{pageSize, pageToken}`, so the cursor walks the GLOBAL resource set and a real `nextPageToken` **IS a foreign
resource's `sandboxId`** — a cross-tenant enumeration oracle (foreign ids + counts + ordering), even though the
`resources` ROWS are correctly filtered. LOW severity (a sandbox id is non-credential; teardown/inspect on a
foreign id → uniform RNA), but it is within B2's own redaction remit and absent from the authoritative
`CleanupAuthority.list` (which exposes no cursor).

**Fix:** `gateList` now mirrors `CleanupAuthority.list` (`cleanup-authority.ts:190-205`) exactly — a single
scoped page (fixed `pageSize: 100`), own rows only, and **`nextPageToken: null` always** (the client
pageSize/pageToken/selector are ignored). The `RedactedListResult.nextPageToken` field stays for port-shape
completeness. Regression test added; verified non-vacuous (RED under cursor-passthrough).

### Skeptic notes recorded (NOT fixed — with reasons)
- **`provider.inspect` throwing `ResourceNotAvailableError` *directly* would collapse** (the catch special-cases
  only `SandboxNotFoundError`). **Theoretical only** — no real provider does this (`E2bSandboxProvider.inspect`
  throws only `SandboxNotFoundError` or rethrows `E2bTransport*`), not reproducible → default-REFUTED as a live
  defect. A belt-and-suspenders assertion is a possible future hardening, not required here.
- **`create` is gate-free even on a GATED server**, so a caller can stamp arbitrary/foreign `resourceLabels` on
  a new sandbox (polluting a victim's list/reconcile view). Consistent with the DOCUMENTED "no
  mTLS/peer-allowlist yet — Slice-5" boundary (`server.ts` header) and Unit A's gate-free-create design (the
  caller owns the result). **Adjacent to known deferred deploy hardening — NOT a new break;** recorded for
  Slice-5/DEP-011.

---

## Discrepancy found mid-build (design recon miss — resolved, not a premise invalidation)

The design states twice (B2.2 item 1; B2.9 R1) that **"no B1 test asserts"** the transient-inspect behavior on
`execute`. **It does:** `gate.test.ts:192` (`"a NON-NotFound inspect fault ALSO collapses to the uniform
error"`) asserted the collapse-ALL behavior B2 corrects. This is a recon miss, not a broken premise — the
security mechanism (surface transients) is sound. **Resolution:** that ONE B1 test case was UPDATED to assert
the corrected behavior (transient surfaces distinctly, not collapsed). Every other B1 collapse arm
(foreign/not-found/missing-cap/bad-sig/expired/generation-skew) stays green unchanged, so the security-critical
"foreign indistinguishable from not-found" oracle-collapse is preserved.

**Step-0 finding (also resolved):** the mock CANNOT direct a non-NotFound inspect fault (`getInfo` only throws
`E2bTransportNotFoundError` via `#requireRecord`). Covered — as B1 already does — by subclassing
`E2bSandboxProvider` and overriding `inspect()` to throw a directed transient (`InspectTransientProvider`),
which exercises the full server path.

---

## Boundary assertion (as B1)

Changed: `packages/adapter-manager/src/{owned-op-gate.ts (was execute-gate.ts), server.ts, index.ts,
__tests__/{gate.test.ts, owned-op-gate.test.ts}}`, `packages/provider-wire/src/{driver.ts, projection.ts (new),
index.ts}`, `scripts/test-inventory.json` (adapter-manager floor 3→4 only). **worker-daemon +
`cleanup-authority.ts` + `supervisor.ts` + `startup-reconcile.ts` + the authoritative port: UNTOUCHED** (git
status confirmed; `check-worker-daemon-boundary` + `check-sandbox-e2b-provider-boundary` PASS). The redaction
only IMPORTS `hashResourceLabels`.

## Guards (whole set — all green)
`check-ticket-graph-coverage` (this doc → `{DEP-012}`), `check-finding-ownership`, `check-guard-inventory`,
`check-gate-clause-wiring`, `check-execution-census`, `check-worker-daemon-boundary` (untouched),
`check-sandbox-e2b-provider-boundary`, `check-boot-roots-provider-free`, `check-test-inventory` (re-pinned
adapter-manager 3→4 only; NOT over-reaching into db/server). **NOT** `check-image-deps-stages` /
`dockerfile-static` — no new package, no image (both fire at Slice 5). No new `vitest.config.ts` `projects[]`
entry / root `Dockerfile` COPY (both packages already registered from Unit A).

---

## What DEP-011 inherits from B2 (the recorded decisions)

- **Coexistence = (compose).** The networked lane injects a `CleanupAuthority` variant that trusts the
  authoritative server gate — built as a **no-op/trust**, **NOT a `resourceLabelsHash` compare** (the driver's
  `InspectResult` synthesis builds `resourceLabels` FROM `cap.ownedLabels`, so the worker-side
  `labelsEqual(detail.resourceLabels, this.#resourceLabels)` is own-vs-own and **VACUOUS**; a genuinely foreign
  id is denied by the SERVER first). Land the worker-side variant + the `deps.makeCleanupAuthority` factory seam
  at `supervisor.ts:528` + `startup-reconcile.ts:418` (boundary-clean). B2 does NOT touch the supervisor.
- **★ `reconcile_cleanup` INVERTS its idempotent semantics over the gate.** In-process an already-gone teardown
  returns `CleanupResult{cleanupStatus}` (never throws, `e2b-provider.ts:282-295`); the gate turns an
  already-gone id into a thrown `ResourceNotAvailableError`, and `reconcile.ts:93`'s UN-GUARDED direct
  `provider.reconcileCleanup` call would ABORT the whole sweep on such a throw. DEP-011's reconcile design MUST
  guard the direct calls.
- **★ The synthesized `hasLiveLease` (`= state === "running"`) is not authoritative.** No B2 consumer reads it
  (`escalateCleanup` uses only `.sandboxId`), but a DEP-011 reconcile consumer would — it must NOT treat the
  driver's synthesized `hasLiveLease` as ground truth.
- **★ The reconcile orphan-sweep coexistence** (networked-worker reconcile vs a server-side reaper) + the
  `v:2` coarse-scope capability — DEP-011's call. B2's `list` is the NARROW single-tuple list only (and now
  exposes NO cursor — F1); coarse-scope enumeration is the deferred case.
- **The teardown escalation asymmetry** (happy-path `destroy` safely escalates on a gate refusal, but
  `CleanupAuthority.converge` reads a refusal as "vanished → success"): B2's surface-transients rule keeps this
  correct at the SERVER; DEP-011's compose variant must not re-introduce a refusal-means-success collapse.

---

## Claims NOT proven here (deferred, by design)

- **No real E2B** — `MockE2bTransport` only; `RealE2bTransport` untouched (Slice 3).
- **No real control-plane keypair / mint** — verify + a TEST keypair only; the real keypair + provisioning +
  the fenced mint are DEP-011/deploy.
- **No `v:2`** — `v:1` suffices for B2 (its `ownedLabels` carries the coarse identity `list` needs); `v:2` ships
  with the coarse-scope/reconcile case.
- **No mTLS / peer-allowlist / net-seg / deploy** — Slice 5. (F1 + the `create` arbitrary-labels note both bite
  only once adapter-manager is shared across tenants — the Slice-5 posture; F1 is closed here, `create` is
  Slice-5's.)
- **No TOCTOU fix** — the `inspect`-then-dispatch check-then-act across two round-trips is a Slice-3 must-fix
  (stated by B1; safe against the mock: monotonic non-reused ids, immutable-at-create labels).
- **NOT through the daemon** — component-level (driver↔server). The daemon inject + dispatch gate are DEP-011.
- **The `v:1` list's single-page limitation** — inherited from `CleanupAuthority.list` (a caller owning >100
  same-tuple resources, or own resources sorted beyond the first global page, would be under-listed). Complete
  own-resource enumeration is the deferred coarse-scope/reconcile case.
