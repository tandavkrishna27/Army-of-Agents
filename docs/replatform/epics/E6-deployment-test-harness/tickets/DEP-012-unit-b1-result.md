# DEP-012 — Slice 1 · Unit B1 result — the signed-capability `execute` ownership gate

**Epic:** E6 · **Ticket:** DEP-012 (Slice 1 · Unit B1) · **Status:** SHIPPED (component-tested, CI pending)
**Depends on:** DEP-012 Unit A (the wire plumbing) · **Design:** [`DEP-012-design.md`](./DEP-012-design.md) "# Slice 1 · Unit B" (fork RESOLVED → **A · signed capability**)
**Built:** 2026-08-28, TDD (fail-first), against tip `bb364e71e`. 4-reviewer + 1-skeptic adversarial pass applied (§Review).

---

## What shipped

B1 closes the **worst hole** the Unit-A wire left open: an ungated `execute` route over the wire is both an
existence oracle AND a **cross-tenant code-execution** vector (an untrusted worker crafts the `sandboxId`
itself). B1 makes `execute` prove ownership server-side before dispatch, proven in a driver↔server component
test. It does **not** build the teardown ops, redaction, the real control-plane keypair, or the production mint.

1. **The owned-labels capability** — a new `provider-wire` schema
   ([`capability.ts`](../../../../../packages/provider-wire/src/capability.ts)):
   `{ v:1, audience:"adapter-manager", ownedLabels: ResourceLabels, expiresAt, sig }`. It carries the caller's
   OWN **ordered label TUPLE** (NOT `hashResourceLabels` — the space-join hash is a canonicalization bypass,
   R2), so the gate compares FIELD-WISE. Signed over an UNAMBIGUOUS canonical: a fixed-order JSON array of ALL
   signed fields with `ownedLabels` itself flattened to a fixed-order array (never the object — key order is not
   an attacker-independent property; never a space-join — field boundaries are preserved). Detached **Ed25519**
   (`sign(null,·)`), a NET-NEW signer authored from the in-repo `node:crypto` primitives (`generateKeyPairSync("ed25519")`,
   `device-proof.ts` canonicalizer pattern) — NOT the symmetric session HMAC, NOT the worker's transport-bound
   device-proof signer. `signOwnedLabelsCapability` is the shared mint PRIMITIVE (B1 uses it with a TEST keypair
   only).
2. **The verify** ([`capability-verify.ts`](../../../../../packages/adapter-manager/src/capability-verify.ts)) —
   a fresh, DB-free `node:crypto` check: assert the pinned public key is Ed25519, check version + audience,
   rebuild the SHARED canonical, `verify(null,·)`, then strict expiry (`expiresAt > now`, `now` injected).
   Fail-CLOSED — every failure throws `CapabilityVerificationError`; the gate collapses it to the uniform error.
   Imports only `node:crypto` + the `provider-wire/capability` subpath (no auth-surface / DB / session key; R1
   CONFIRMED).
3. **The gate** ([`execute-gate.ts`](../../../../../packages/adapter-manager/src/execute-gate.ts)) — after verify,
   `provider.inspect(sandboxId)` **AM-local** (the in-process provider, NOT a wire op) → the target's raw labels
   + generation; then MIRROR `#requireOwned` FIELD-FOR-FIELD
   (`cleanup-authority.ts:154-167`): `labelsEqual(target.resourceLabels, cap.ownedLabels) &&
   target.generation === cap.ownedLabels.deviceGeneration` → allow; else the UNIFORM `ResourceNotAvailableError`.
   **Both collapse arms + all inspect throws** reproduced: `SandboxNotFoundError`, a label/generation mismatch,
   AND any other inspect fault all yield the SAME uniform error, byte-identical — a foreign-but-existing sandbox
   is indistinguishable from not-found. `provider.execute` is reached ONLY on the allow path (a refusal never
   runs a command).
4. **Mandatory / fail-closed field + symmetric error**
   ([`codec.ts`](../../../../../packages/provider-wire/src/codec.ts)): `capability` is an **OPTIONAL** field on
   `OpRequestEnvelope` (so `create`'s `{args, ctx}` stays byte-identical — Unit A green), but `decodeOpRequest`
   now CARRIES a present capability THROUGH (it no longer silently drops extras — the R2 fall-open) and REJECTS a
   malformed one; the gated `execute` route REFUSES on absence (never dispatches). `ResourceNotAvailableError` is
   added SYMMETRICALLY to `serializeError` AND `reconstructError` — miss the reconstruct case and it degrades to
   `WireProtocolError`, breaking the uniform error.
5. **The driver carries the capability OUT-OF-BAND**
   ([`driver.ts`](../../../../../packages/provider-wire/src/driver.ts)) — the port `execute(input, ctx)` has no
   capability slot, so it is injected via the driver constructor (`NetworkedProviderDriverOptions.capability`).
   `create` omits it; `execute` attaches it.
6. **The gate is opt-in via the pinned public key**
   ([`server.ts`](../../../../../packages/adapter-manager/src/server.ts)): `createProviderServer({ provider,
   controlPlanePublicKey?, now? })`. When the key is present, `execute` is gated. When absent, the server is
   Unit-A's ungated / **NOT deploy-safe** posture (S1.4) — admissible solely for the single-tenant loopback test.
   This keeps Unit A's 17 tests green (they construct a keyless server) while satisfying "execute refuses on
   absent/unverifiable capability" in gated mode (in gated mode, absence is REFUSED — never engage-only-when-present,
   so it is NOT the R2 fall-open). **The Slice-5 deploy ordering assertion (deferred) enforces that a real
   deployment configures the key** — this is stated, not assumed.

### Tests (all fail-first RED → GREEN; real counts verified)

| Suite | File | Count |
|-------|------|------:|
| capability schema + canonical + mint + tamper (per-field) | `provider-wire/.../capability.test.ts` | 14 |
| codec: RNA symmetric + capability carry/validate + create byte-identity | `provider-wire/.../codec-capability.test.ts` | 6 |
| Unit A codec (UNMODIFIED) | `provider-wire/.../codec.test.ts` | 8 |
| verify: valid + fail-closed (sig/expiry/audience/version/key/non-finite) | `adapter-manager/.../capability-verify.test.ts` | 9 |
| gate: allow / foreign / missing-cap / bad-cap / oracle-collapse (4 arms) / generation-skew / no-crossing | `adapter-manager/.../gate.test.ts` | 8 |
| Unit A component (UNMODIFIED) | `adapter-manager/.../component.test.ts` | 9 |

`provider-wire` 28/28, `adapter-manager` 26/26. **Unit A's 17 (codec 8 + component 9) unmodified and green.**

### Mutation table (TDD step 8 — mutate each arm; a test kills each)

| # | Clause (file) | Mutation | Result |
|---|---------------|----------|--------|
| M1 | verify Ed25519 key-type guard | `!== "ed25519"` → `"ed25519_X"` | killed (RSA test) |
| M2 | verify version | `v !== VERSION` → `false` | killed (v:2 test) |
| M3 | verify audience | `audience !== AUDIENCE` → `false` | killed (wrong-audience) |
| M4 | verify signature | `if (!signatureOk)` → `if (false)` | killed (foreign-key/tamper) |
| M5 | verify expiry-strict | `expiresAt > now` → `>= now` | killed (boundary test) |
| M10 | verify expiresAt-finite | delete `!Number.isInteger` guard | killed (non-finite test) |
| M11 | mint expiresAt-finite | delete `!Number.isInteger` guard | killed (mint-refuses test) |
| M6 | gate inspect-collapse | `catch { throw RNA }` → rethrow | killed (oracle-collapse + fault) |
| M7 | gate labelsEqual arm | `!labelsEqual(...)` → `false` | killed (foreign test) |
| M8 | gate generation arm | `generation !== deviceGeneration` → `false` | killed (generation-skew) |
| M9 | gate verify-collapse | `catch { throw RNA }` → rethrow | killed (bad-sig test) |
| MC1 | codec reconstruct RNA case | delete the `case` | killed (RNA-reconstruct) |
| MC3 | codec capability carry | drop `capability` from decode return | killed (carry-through) |
| MC4 | codec malformed-reject | `if (!isValidCapability)` → `if (false)` | killed (malformed test) |
| MC2 | codec serialize RNA branch | delete the explicit branch | **SURVIVED — equivalent mutant** |

**MC2 is an honest equivalent mutant:** the generic `err instanceof Error` branch of `serializeError` produces
the byte-identical `{name, message}` for `ResourceNotAvailableError`, so deleting the explicit branch changes no
behavior. The explicit branch is kept anyway per the design's symmetry mandate (serialize + reconstruct paired)
and for mutation-visibility — it is not a "check that nothing runs," it is a redundant-but-correct branch.

### Guards (whole set, per the WRK-014 missed-guard lesson)

All green: `check-ticket-graph-coverage` (this doc → `{DEP-012}`), `check-finding-ownership`,
`check-guard-inventory`, `check-gate-clause-wiring`, `check-execution-census`, **`check-worker-daemon-boundary`
(PASS — worker-daemon untouched)**, `check-sandbox-e2b-provider-boundary` (PASS), `check-boot-roots-provider-free`,
`check-test-inventory` (re-pinned ONLY `packages/adapter-manager` 1→3 + `packages/provider-wire` 1→3 floors — the
new-test-files bump; NOT over-reached into `db`/`server`, the DSK-003 lesson). **B1 adds NO new package** → no new
`vitest.config.ts` `projects[]` entry and no new `Dockerfile` deps-stage `COPY` (both packages already registered
from Unit A — confirmed `vitest.config.ts:24` + `Dockerfile:72-73`). NOT `check-image-deps-stages` /
`dockerfile-static` (no image — Slice 5). The inline `policy` "Validate Dockerfile deps stage" step fires only for
a new package, which B1 does not add.

---

## Adversarial review (4 reviewers + 1 skeptic, 2026-08-28)

- **Gate** — 0 findings. Confirmed the field-wise `#requireOwned` mirror (all 7 labels + generation, no coercion),
  fail-closed-before-dispatch, and the byte-identical oracle collapse across foreign / not-found / inspect-fault /
  missing-cap / bad-cap. Both ownership OR-arms independently mutation-killed.
- **Codec** — 0 findings. `__proto__` / extra `ownedLabels` keys are carried but provably harmless (not signed,
  not in the canonical, not in `labelsEqual`); every wrong-typed field is rejected at decode; no sig/secret log.
- **Skeptic (bypass)** — 0 reproduced bypass. Missing-cap fall-open, foreign-sandbox exec (forged / own-cap /
  replay-against-foreign-id), existence oracle, and prototype-pollution smuggle ALL refused with the transport
  never hit. CONFIRMED-SAFE: no sensitive projection crosses (the refusal body carries no victim env/labels/command;
  `inspect`'s full detail is consumed for the compare and never serialized); worker-daemon + `cleanup-authority.ts`
  UNTOUCHED (git-verified; only exported `ResourceNotAvailableError` + `labelsEqual` imported).
- **Signer/verify** — 1 real finding **FIXED** (F1, below); 5 refuted.
- **Component-test rigor** — 0 false-pass; 2 LOW nits, (a) FIXED, (b) noted.

### Fixed from review
- **F1 (LOW, fail-closed hardening) — FIXED.** `verifyOwnedLabelsCapability` trusted the `expiresAt` TS type; a
  non-finite value (`Infinity`/`NaN`) canonicalizes to `null` via `JSON.stringify` and `!(Infinity > now)` never
  expires → an immortal token if a future mint ever emitted one. Not wire-exploitable (an attacker cannot forge
  the signature), but a fail-open at a security boundary. Now BOTH the mint (`signOwnedLabelsCapability`) and the
  verify reject `!Number.isInteger(expiresAt)` (defense in depth; mutants M10/M11 kill both). A `1e999` wire
  value (which JSON-parses to `Infinity`) is caught at verify → uniform error.
- **Rigor (a) — FIXED.** The fourth oracle-collapse arm (non-NotFound inspect fault) now byte-`===` compares to
  a shared `UNIFORM_ERR_BODY` constant (was a structural `toEqual`).
- **Hygiene — FIXED.** `capability-verify.ts` imports from the `@armyofagents/provider-wire/capability` subpath
  (not the barrel) so the verifier's runtime closure stays minimal — the same subpath discipline as Unit A.

### Noted, not fixed (by design / out of scope)
- **Rigor (b):** the `s3cr3t` leak-trap in the execute-path test is near-vacuous (that secret lives only in the
  create spec, never in execute scope). Kept as harmless defense-in-depth; the load-bearing assertions in that
  test (`seen.length === 1`, `capability.ownedLabels === OWNED`, capability has no `env`/`secrets`) are sound.
- **Bearer-token replay (informational):** the capability is a bearer token bounded SOLELY by `expiresAt` — no
  nonce/jti anti-replay. A genuine, still-valid capability replays within its window. This matches the documented
  short-lived design (B9 item 6). **DEP-011/deploy must set a short expiry TTL** and may add per-`sandboxId`
  namespacing to the idempotency ledger (Slice 3). Not a B1 defect.

---

## TOCTOU / id-reuse assumption (STATED, not fixed — Slice-3 must-fix)

The gate is `inspect` then `execute` across two round-trips — check-then-act, **not atomic**. Against the mock it
is safe: sandbox ids are monotonic and never reused (`mock-transport.ts:81-83`, zero-padded counter), labels are
immutable-at-create (no relabel path), and a re-lease mints a NEW id (orphaning the old with its original labels).
The residual is **real-provider `sandboxId` REUSE** — an id validated-as-mine, destroyed, and reassigned to a
foreign tenant before dispatch. B1 STATES the id-non-reuse assumption; closing it (provider-atomic
compare-and-execute, a per-`sandboxId` lease/lock, or a proven non-reuse invariant) + the §S1.5 Slice-5 ordering
assertion (a foreign-labeled id to `execute` yields the uniform error) is a **Slice-3 must-fix**, not live in B1.

## Left open (every claim not proven here)

- **The real control-plane keypair + provisioning/rotation + the production mint** (in the fenced
  `resolveExecutionSecret` reply, where JWT+device-proof-verified labels already exist) — **DEP-011/deploy**. B1
  ships VERIFY + a TEST keypair only. There is NO reusable control-plane signer (R1): the net-new keypair is real
  deferred cost, and it does NOT flip the A-vs-B fork.
- **Unit B2** (its own design→review): `cancel/kill/destroy/reconcile_cleanup` gated (reuse B1's capability +
  AM-local owned-check + uniform error + collapse); `inspect`/`list` return `RedactedResourceProjection` ONLY,
  redacted server-side; `list`'s `ownershipSelector` needs the caller's COARSE identity → B2 EXTENDS the
  capability to a `v:2` (additive over B1's `ownedLabels`; the `v` discriminant B1 mandates makes this a clean
  bump). **Cross-lane rule (landmine 6 DEFERS to B2, does not dissolve):** `CleanupAuthority` is lane-AGNOSTIC
  (`supervisor.ts:528`); `#requireOwned` needs a FULL `InspectResult` the F2 redacting wire will NOT carry, so B2
  must EITHER edit `cleanup-authority.ts` to hash-compare via the `resourceLabelsHash` getter OR change the
  networked supervisor composition so teardown does not re-check ownership worker-side. B1 is clean only because
  `execute` bypasses `CleanupAuthority` (fence-only `EffectAuthority`; cleanup DENIES execute).
- **Slices 3–5:** real E2B (`RealE2bTransport`), the durable idempotency ledger namespaced by the capability's
  authenticated identity, conformance + DEP-008 isolation, the credential crossing (settled (i)), and the deploy
  (mTLS / peer-allowlist / net-seg / the ordering assertion). A transport peer check ≠ the application-layer
  capability.
- **NOT through the daemon** — component-level (DEP-011's `deps.provider` inject).
