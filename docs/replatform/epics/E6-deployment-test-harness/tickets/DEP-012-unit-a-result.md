# DEP-012 — Slice 1 · Unit A — RESULT (the create+execute wire plumbing)

**Epic:** E6 · **Ticket:** DEP-012 (adapter-manager: the out-of-process networked provider host)
**Unit:** Slice 1 · **Unit A** (the CleanupAuthority-free wire plumbing) · **Status:** SHIPPED, CI pending
**Design of record:** [`DEP-012-design.md`](./DEP-012-design.md) §S1 · **Contract:** [`qa/2026-08-28-adapter-manager-scope.md`](../../../qa/2026-08-28-adapter-manager-scope.md) §8
**Built at tip:** `b79fe0494` (post-recon design + 4-agent review)

---

## 1. What Unit A shipped

The **create + execute WIRE PLUMBING** for the networked provider seam — the whole
serialization / network-hop / in-process-idempotency-replay / error-vocab de-risk — proven in a
**driver ↔ server component integration test over the key-less `MockE2bTransport`**. Three build
artifacts, all outside `worker-daemon` (the daemon imports nothing new):

| # | Component | Package | What it is |
|---|-----------|---------|------------|
| C-wire | The shared, non-frozen wire | **`packages/provider-wire/`** (new) | Request/response envelopes + (de)serialization + the **error-vocab codec** (`codec.ts`), and the **networked driver** (`driver.ts`) presenting the authoritative per-op `SandboxProvider` port. |
| C-srv | The provider host | **`packages/adapter-manager/`** (new) | `createProviderServer({ provider })` — a `node:http` listener routing `/op/create` + `/op/execute` (+ `GET /healthz`), provider-agnostic (injected `provider`). |
| C-test | The proof | `packages/adapter-manager/src/__tests__/component.test.ts` | Stands up `new E2bSandboxProvider({ transport: new MockE2bTransport() })` behind the server on a loopback port and drives it through `NetworkedProviderDriver` — **over the wire**, not the provider object. |

**Op-shapes: zero re-declaration, zero worker-daemon edit.** `CreateSandboxSpec` / `CreateResult` /
`ExecuteInput` / `ExecuteResult` / `ProviderOpContext` are imported `import type` from
`@armyofagents/worker-daemon` (already exported, `index.ts:380-410`). The error VALUES
(`UnsupportedProviderOperation` / `SandboxNotFoundError` / `SandboxEgressDeniedError`) are imported
from the single authoritative site `@armyofagents/sandbox-e2b-provider/errors.js` (which re-exports
worker-daemon's two + defines the neutral egress denial).

**The seam (S1.1, not redrawn).** Unit A ships `create` + `execute` **only**. `execute`'s route has
**NO ownership gate** and is **COMPONENT-TEST-ONLY / not deploy-safe** — admissible solely because
Unit A's artifact is a single-tenant loopback vitest with no deploy, no daemon, no mTLS; it stands up
no reachable oracle. The driver's other six `SandboxProvider` core methods (+ the optional trio + the
artifact pair) throw the **authoritative** `UnsupportedProviderOperation` until Unit B.

## 2. STEP 0 — premises verified against source (one enabling change, reported not silent)

| Premise | Verdict | Evidence |
|---------|---------|----------|
| (a) The five op-shapes are exported from `@armyofagents/worker-daemon` | ✅ HOLDS | `worker-daemon/src/index.ts:380-410` (types) + `:371-379` (error values). No re-declaration, no daemon edit. |
| (b·layout) `e2b-provider.js` + `mock-transport.js` + `errors.js` keep `real-transport`/`e2b` OUT of the closure | ✅ HOLDS | `grep 'from "e2b"'` under `sandbox-e2b-provider/src` → **only** `real-transport.ts`. The three imported modules import only `./directives.js`, `./transport.js`, `./errors.js`, worker-protocol, worker-daemon (types) — never `real-transport.ts`. |
| (b·resolution) the subpath specifiers resolve | ⚠️ **needed an enabling change** | The `exports` map listed only `"."`, so `@armyofagents/sandbox-e2b-provider/e2b-provider.js` did **not** resolve. **Fix:** added three explicit **dist-targeted** subpath exports (`./e2b-provider.js`, `./mock-transport.js`, `./errors.js`) to `sandbox-e2b-provider/package.json`. Additive; does **not** touch the boundary's `dependencies` list or credential confinement; deliberately does **NOT** expose `real-transport.js` (still barrel-only, governed by the existing worker-keystore boundary). `check-sandbox-e2b-provider-boundary` stays PASS. |
| (c) `vitest.config.ts` `projects[]` is an explicit array (no glob) | ✅ HOLDS | `vitest.config.ts:24`. Appended `packages/provider-wire` + `packages/adapter-manager`; each carries its own `vitest.config.ts`. |

**No design premise was invalidated.** The (b·resolution) gap is exactly the design's flagged "confirm
in Step 0 / adapter-manager need NOT declare e2b if the subpath imports keep real-transport out of the
closure" item (S1.2.1). adapter-manager declares `@armyofagents/sandbox-e2b-provider` only as a
**devDependency** (component test), and its runtime imports no provider at all — so the runtime closure
is entirely e2b-free.

## 3. Fixtures + the mutation sweep (§S1.3 step 7)

**Tests:** `packages/provider-wire/src/__tests__/codec.test.ts` (**8**) + `packages/adapter-manager/src/__tests__/component.test.ts` (**9**) = **17 green.** (7 → 9: the adversarial review added a negative unknown-payload case over the DRIVER wire and a `/op/constructor` unwired-op guard — §8.)

Component-test fixtures (all over the loopback wire):

| Behavior (S1.7) | Fixture | Proves |
|---|---|---|
| create round-trip | `driver.create(SPEC, ctx)` → `CreateResult.resourceLabels` echoes the caller's own labels | serialization + label echo end-to-end |
| idempotency replay (in-process) | two `create`s, same `idempotencyKey`, **same running server** → same `sandboxId`; a different key → a different id | the `#idempotency` map survives the hop; **no server restart** (cross-restart is Slice 3) |
| execute byte-free | `execute` → opaque `stdoutRef`/`stderrRef` = `ref:std{out,err}:<id>`, no `stdout`/`stderr` byte fields | E5 byte-freeness across the wire |
| zero-deadline verdict | `deadlineMs:0` → `timedOut:true` with **no fetch** (spy count unchanged); a positive deadline **does** fetch (+1) | the driver owns the verdict; the "always short-circuit" mutant is guarded |
| error vocab: not-found | `execute` on an unknown `sandboxId` → `SandboxNotFoundError` crosses as its class | domain error class survives |
| error vocab: egress | `execute` with `__aoa_egress_class:"private"` → `SandboxEgressDeniedError` + `destinationClass:"private"` | discriminant survives |
| no sensitive crossing | the raw response bodies (`{ok:...}`) for create + execute contain none of `env`/`secrets`/`command`/`logs`/the secret value/the command string | RESULT projections are clean |

**Mutation sweep — 6 mutations applied, 6 killed, 0 survivors:**

| # | Mutation | Killed by |
|---|----------|-----------|
| M1 | driver zero-deadline `deadlineMs <= 0` → `< 0` | component "ZERO-DEADLINE verdict is DRIVER-owned" |
| M2 | codec reconstruct `SandboxNotFoundError` arm → wrong class | codec + component not-found tests (2) |
| M3 | codec reconstruct `SandboxEgressDeniedError` → drop `destinationClass` | codec + component egress tests (2) |
| M4 | codec default arm (unknown name) → return a domain error instead of `WireProtocolError` | codec NEGATIVE case |
| M5 | codec `decodeOpResponse` "err" branch → return instead of throw (silent-success hole) | 6 tests (the "never silently to ok" property) |
| M6 | codec reconstruct `UnsupportedProviderOperation` → drop `operation` discriminant | codec operation-discriminant test |

Per the "mutate each ARM" lesson ([[wrk-015-posix-validator]]), each OR-arm of the error-class
discriminator (M2/M3/M4/M6) was mutated individually, not just the branch as a whole.

A 7th guard came out of the adversarial review (§8, server F1): the server's op dispatch uses a
**`Map`, not an object literal**, so an inherited prototype key (`/op/constructor`, `/op/__proto__`)
cannot resolve to a handler and return a spurious `{ok}`. Proven RED-then-GREEN by the "an UNWIRED op
path returns an err envelope, never a spurious ok" component test (an object-literal dispatch fails it).

## 4. Guard set — the WHOLE set run (the WRK-014 missed-guard lesson)

| Guard | Result |
|-------|--------|
| new packages' tests actually execute | ✅ `--project packages/provider-wire --project packages/adapter-manager` → **15 passed** (8 + 7). Registration is load-bearing and confirmed running. |
| `check-execution-census` | ✅ OK — 26 packages with specs, 23 owning a vitest config, all present in projects[]. |
| `check-ticket-graph-coverage` | ✅ OK — `DEP-012-unit-a-result.md` parses to `{DEP-012}` (the regex stops at `012`; "unit" is not a 3-digit slice). |
| `check-finding-ownership` | ✅ OK (unchanged — no findings filed). |
| `check-guard-inventory` | ✅ OK — 40 guards, none added. |
| `check-gate-clause-wiring` | ✅ OK (unchanged). |
| `check-worker-daemon-boundary` | ✅ PASS — worker-daemon untouched. |
| `check-boot-roots-provider-free` | ✅ OK — 3 boot roots, none constructs a provider unconditionally (adapter-manager has no bin / names no `bootstrapWorkerDaemon`). |
| `check-sandbox-e2b-provider-boundary` | ✅ PASS — the exports-map change is source-neutral; the dependency list + credential confinement are untouched. |
| `check-test-inventory` | ✅ OK — pinned the two new trees ONLY (`floor` 1 each); the `--write` over-reach into unrelated `packages/db`/`server` floors was reverted (DSK-003 no-over-reach). |
| `check-image-deps-stages` / `dockerfile-static.test` / split-image deps | ✅ still green — Unit A adds **no image**, so the split worker/control-plane images do NOT list the new packages (they are not in either image's runtime closure), and the static checks are unaffected. A green run here is **not** image coverage. |
| **Dockerfile deps-stage validator (CI-inline `policy` step)** | ⚠️ **caught a real miss — now fixed.** The design's "no Dockerfile impact" note covered `check-image-deps-stages`/`dockerfile-static` but MISSED the inline `policy` step "Validate Dockerfile deps stage", which requires **every** workspace `package.json` to be `COPY`'d in the ROOT `Dockerfile`'s `deps` stage (independent of whether the package ships an image — the monorepo installs the whole workspace there). Fixed: added the two `COPY` lines. Reproduced the exact validator locally → `missing=0`. This surfaced only on CI (`policy` red) because it is a `pr.yml` shell step, not a `check-*.mjs` script — the WRK-014 missed-guard class, in a new guise. |

## 5. The Unit-B fork left OPEN (do not read Unit A as covering it)

Unit A deliberately does **not** settle these — they are Unit B's own design→review→sign-off (S1.5):

- **The ownership fork (P server-relocate vs Q client-hash)** — must cover `execute` (option Q cannot
  gate `execute` server-side against a misbehaving worker, so `execute`'s presence argues for P).
- **`execute`'s server-side ownership gate** + the six gate-required ops (`cancel`/`kill`/`destroy`/
  `reconcileCleanup` ownership-gated; `inspect`/`list` returning `RedactedResourceProjection` ONLY).
- **The existence-oracle collapse** across the wire (owned-check first, uniform
  `ResourceNotAvailableError`) + the `cleanup-authority.ts` edit per the fork.
- **Slice-3** durable idempotency ledger namespaced by authenticated worker identity.
- **Slice-5** ordering invariant (a deploy test that ASSERTS `execute` sits behind the gate).

## 6. Claims NOT proven by Unit A (honest ledger)

- **Nothing dispatches through the daemon.** Unit A exercises the driver directly in a component test;
  the through-the-daemon path (a `deps.provider` inject + the dispatch gate + an `AOA_WORKER_*` consumer)
  is **DEP-011**, not built here.
- **No real E2B, no `E2B_API_KEY`, no `RealE2bTransport`.** Slice 3. Unit A only proves the
  `MockE2bTransport → RealE2bTransport` swap point exists; it does not exercise real E2B.
- **No credential crossing.** Slice 4 (settled (i)).
- **No conformance / no DEP-008 isolation suite.** Slice 3 (C-conf).
- **No mTLS / peer-allowlist / net-seg / deploy / image.** Slice 5.
- **The `execute` route is NOT deploy-safe** (no ownership gate) and MUST NOT face >1 label-set or any
  deploy until the Unit-B gate exists.
- **In-process idempotency only.** Cross-restart durability is Slice 3 and was deliberately NOT tested
  here (testing it would look like a bug — landmine 6).
- **CI not yet observed** at time of writing — reported honestly on push (`verify` is a 4-shard matrix;
  a red shard is a real failure to own).

## 7. Files

**New:** `packages/provider-wire/{package.json,tsconfig.json,vitest.config.ts,src/index.ts,src/codec.ts,src/driver.ts,src/__tests__/codec.test.ts}`;
`packages/adapter-manager/{package.json,tsconfig.json,vitest.config.ts,src/index.ts,src/server.ts,src/__tests__/component.test.ts}`.
**Changed:** `packages/sandbox-e2b-provider/package.json` (+3 subpath exports); `vitest.config.ts` (+2 projects);
`scripts/test-inventory.json` (+2 pins); `Dockerfile` (+2 deps-stage `COPY` lines — the inline `policy`
validator, see §4); `pnpm-lock.yaml` (the 2 new workspace packages).

## 8. Adversarial review (4 dimension reviewers + 1 skeptic) — outcome

**Skeptic: all three load-bearing claims SUPPORTED from source** — (1) no `e2b` SDK in the runtime OR
test closure (import graphs traced; `real-transport.ts` is the sole `e2b` importer and is unreachable
via the subpaths); (2) no sensitive crossing in `create`/`execute` RESULTS (`CreateResult`/`ExecuteResult`
carry no env/secrets/command/logs; `InspectResult` is not wired); (3) the tests actually run (both in
`projects[]`, each owns a `vitest.config.ts`, both pinned; real run shows nonzero counts).

**Findings applied (survived scrutiny):**

| Finding | Sev | Action |
|---|---|---|
| Server F1 — `handlers` object literal → `/op/constructor` resolves inherited `Object`, returns spurious `{ok}` for an unwired op (violates the file's own "never a silent success") | **MED** | **Fixed** — `Map` dispatch + a RED-first `/op/constructor` guard test. |
| Server F2 — response can be written twice on a concurrent stream error → unhandled rejection / process-crash class | LOW-MED | **Fixed** — `sendJson` is idempotent (`headersSent`/`writableEnded` guard + try/catch) and `res.on("error")` swallows socket errors, so the server cannot be crashed by a mid-flight abort. |
| Server info — codec imported via the barrel dragged the client DRIVER into the server closure | info | **Fixed** — server imports `@armyofagents/provider-wire/codec` (subpath), so the server closure is codec-only. |
| Component F1 — the negative unknown-payload case existed only at codec level, not over the driver wire (S1.7 phrases it as a *wire* requirement) | LOW-MED | **Fixed** — added a component case: an injected fetch returns a garbled/unknown-class body → `WireProtocolError` at the driver. |
| Component F2 — no-sensitive assertion substring-matched the whole JSON with generic tokens (brittle) | LOW | **Fixed** — assert the concrete leak values (`s3cr3t`/`run.sh`) against the raw body AND the result KEYS against `env`/`secrets`/`command`/`logs` (precise). |
| Component F3 — the egress test folded the directive into create env where it is inert (misleading) | info | **Fixed** — create plainly; the directive rides the execute env (its real trigger). |
| Codec doc — the `SerializedError` comment overclaimed "never any sensitive projection" re: an unmodelled error's `message` | info | **Fixed** — comment tightened to distinguish structured discriminants from server-authored `message`. |

**Findings killed (not fixed, with reason):**
- Codec LOW — a malformed modelled-error payload coerces a missing discriminant to `""`. Design-sanctioned
  (class preservation is primary; it still throws the RIGHT class, and the NEGATIVE case covers unknown
  *names*). Not a silent-success hole.
- Codec LOW — `encodeOkResponse(undefined)` → `"{}"` decodes to a `WireProtocolError`. Fails **loud**, never
  a false success; inert (all wired ops return objects).
- Driver info — `advertisedOperations` advertises the 8 core ops while 6 throw `UnsupportedProviderOperation`.
  Design-sanctioned (the port invariant requires the core superset); safe ONLY because Unit A is never wired
  into a real composition root before Unit B (the S1.4 fence).
- Server F3 (info) — no custom request-body timeout; Node's built-in `requestTimeout` (~300s) bounds it.
  Acceptable at loopback scope.

Post-fix: **17 tests green**, both packages typecheck, full guard set green.
