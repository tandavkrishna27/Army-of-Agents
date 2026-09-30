# DEP-008 Design — Managed sandbox isolation conformance

**Status:** `design` (reviewable artifact; implementation follows via per-slice fail-first TDD + distinct adversarial review)
**Epic:** `E6-deployment-test-harness` (remainder; first of DEP-005..009). **Authoritative source:** `program-design.md:739-744`.
**Depends on (complete):** DAT-005 (egress policy + redaction — `server/src/services/egress-policy.ts` `classifyEgressDestination`, `packages/worker-daemon/src/supervisor/redaction.ts` `scrubEventStrings`), DEP-004 (`changes`/`distributed-contract`/`ci-required` lanes + `d1-merge-train.yml`), E6-D1-FOUNDATION (DEP-000..004). Frozen worker-protocol v1 SHA `b7a842870ce7509d8baa75409e0ab19da375c88a` (consumed, never edited).
**Grounded by:** the DEP-008 terrain-map (6 parallel readers + synthesis) with all 8 load-bearing claims **independently re-verified** in `C:\e3`: `projectionLeakKeys` is un-exported (`contract.ts:80`); the fake's `reconcile_cleanup` unconditionally clears + returns `success` (`fake-driver.ts:269-271`) and `destroy` just deletes (`:260-262`); the invoke-driver port carries only `{providerId,resourceId?,idempotencyKey?,deadlineMs?,page?,params?}` (`port.ts:58-65`); **E6-F008** (the invoke-driver port vs worker-daemon's per-op `SandboxProvider` are unreconciled) is documented open at `port.ts:14-27`; `check-d1-compose.mjs` runs only in `d1-merge-train.yml:76`, not `pr.yml`; `NETWORK_DENIAL_CLASSES` is exactly the frozen 4 (`events.ts:313`); the boundary allows deps EXACTLY `{@armyofagents/worker-protocol, zod}` (`sandbox-fake-provider-boundary.mjs:45`); root `vitest.config.ts:24` already lists both DEP-000 packages.

---

## 1. Scope + framing

**Outcome (program-design.md:742):** create the **provider-neutral, HOSTILE isolation/cleanup conformance suite** every managed sandbox adapter must pass before tenant canary, plus a **hostile local/reference implementation** the suite is certified against. **E6 certifies the suite + the reference — NOT E2B**; CLI-001/E7/D2 reruns the SAME applicable suite against real E2B (program-design.md:743). Per the Decision #121 threat register, DEP-008 is the named owner of exactly two controls: **DE-17** (post-fence cleanup authority) and **DE-26** (managed sandbox isolation conformance).

**Structural framing.** DEP-008 is the adversarial sibling of DEP-000's happy-path suite `runSandboxProviderContract(makeDriver, options): ContractReport` (`packages/sandbox-provider-contract/src/contract.ts:100`), which today runs 9 benign checks over the opaque `SandboxProviderDriver.invoke(op, args)` port (`port.ts:130-138`). We mirror its framework-free runner shape exactly — `runCheck(name, fn)` accumulating `ContractCheckResult[]`, a FRESH driver per check, `assertReport` (`contract.ts:86-94,335`) — as a **second exported suite** `runSandboxIsolationConformance` in the SAME leaf package.

**The one architectural fact that decides the design (verified).** The invoke-driver port (`SandboxProviderDriver.invoke`) is **structurally distinct** from worker-daemon's per-op `SandboxProvider` (`packages/worker-daemon/src/supervisor/provider.ts`), and the sandbox leaf boundary **forbids importing worker-daemon** (deps EXACTLY `{worker-protocol, zod}`, `sandbox-fake-provider-boundary.mjs:45,130`). The hostile authority semantics DEP-008 must assert — `EffectAuthority`/`EffectAuthorityWithdrawnError` (`effect-authority.ts:45-52`) and the DE-17 security core `CleanupAuthority`/`CleanupAuthorityDeniedError`/`ResourceNotAvailableError`/monotonic `CLEANUP_STAGES` (`cleanup-authority.ts:47-70,127-144,241-247`) — **already exist and are unit-tested in worker-daemon over the per-op port**. DEP-008 therefore does NOT re-implement production authority and does NOT import it; it **mirrors those invariants provider-neutrally over the invoke-driver** in a new hostile reference driver, and asserts them via the conformance suite. Reconciling the two ports (a shared-leaf relocation or a tested per-op→invoke adapter) is **E6-F008 — explicitly deferred to CLI-001/D2** (`port.ts:23-26`); DEP-008 does not close it and makes no real-supervisor conformance claim.

| Component | Runs / lane | Holds sensitive bytes? | Responsibility |
|---|---|---|---|
| **Isolation conformance suite** `runSandboxIsolationConformance` | in-process leaf (`sandbox-provider-contract`), **local + CI** | no | provider-neutral hostile checks over ANY `SandboxProviderDriver`; each check paired with a `wrapDriver` sabotage that MUST fail it |
| **Hostile reference driver** | in-process leaf (`sandbox-fake-provider`) | yes (synthetic canaries, inside the double only) | models fence/effect-authority withdrawal, cleanup-authority denials, no-existence-oracle, monotonic cleanup, sensitive full-inspect + redacted projection, bounded TTL/crash/outage/destroy-failure/leak — over the invoke-driver via the opaque `params` channel |
| **Egress bypass vectors gate** (server-lane) | `server/src` test, always-on **`policy`** job | no | reuse DAT-005 `classifyEgressDestination` with the hostile bypass corpus (hex-mapped/first-word-zero metadata, `[public,private]` rebind, injected control-plane CIDR) |
| **Live D1 hostile probes** `tests/d1/e6f-08-*.mjs` | **Linux/CI only**, `d1-merge-train` `foundation` campaign | no | host/provider-socket/metadata/private-net/control-plane-internals unreachability + cross-job + stale-fence, reusing `tests/d1/lib/e6f-harness.mjs` |

**Inert-until-wired, additive, dormant** — like DEP-000..004 and the E5 tickets, everything here is additive and gated behind `AOA_DISTRIBUTED_EXECUTION_ENABLED=false`; it adds no authority, no route, no wire op, no migration.

---

## 2. Isolation/cleanup invariants (every one gets a fail-first test + a `wrapDriver` sabotage)

1. **Effect-authority withdrawal (DE-17).** After fence loss/replacement/expiry, governed effects (`create`/`execute`/`checkpoint`/`restore`/`health`) are DENIED, while the narrow cleanup authority (`cancel`/`kill`/`destroy`/`reconcile_cleanup`/`list`/`inspect`) stays usable. Withdrawal is terminal + idempotent (never resurrected). Mirror `EffectAuthorityWithdrawnError`.
2. **Effect ops unrepresentable under cleanup authority (DE-17).** This is a TYPE/authority-shape requirement, not merely a runtime reject: the cleanup surface must have no create/execute/resume/checkpoint/health/openEgress path that can succeed. The reference exposes them only to throw `CleanupAuthorityDeniedError`; the suite asserts every one denies.
3. **No existence oracle (DE-17).** A cross-resource, wrong-generation, or truly-absent target all collapse to the SAME error identity (`ResourceNotAvailableError`, fixed message). Probes assert error IDENTITY, not merely "it threw" — a caller must not distinguish "exists but not yours" from "gone".
4. **Monotonic cleanup convergence (DE-17).** The escalation ladder `none→cancel→kill→destroy` never regresses; an ignored cancel escalates to kill, an ignored kill to a forced destroy; a forced destroy is retried idempotently up to a bounded `maxDestroyAttempts`; convergence leaves zero live resources. An empty cleanup pass (create in-flight, provider not listable) must NOT fail-open / consume the terminal latch.
5. **Zero-byte management projection, NON-VACUOUS (DE-17/DE-26).** The reference resource holds SENSITIVE detail (synthetic `command`/`env`/`logs`/`secret` canaries); `list`/`inspect` return ONLY the provider-neutral `ProviderResourceProjection` (`PROVIDER_PROJECTION_KEYS` allowlist, `port.ts:70-75`). A probe asserts NONE of the sensitive canary bytes appear in any projection — non-vacuous precisely because the double holds bytes to leak.
6. **Network denial + no bypass (DE-08, DE-26).** Egress to metadata/private/control-plane/not-allowlisted destinations is denied with the exact frozen `NETWORK_DENIAL_CLASS`, including the hostile bypass spellings (`::ffff:a9fe:a9fe`, `::10`, `[public,private]` rebind, control-plane CIDR). No direct socket path exists; `openEgress` under cleanup is denied.
7. **Provider-credential + customer-byte absence (DE-26).** No provider credential, tenant identifier, or customer byte appears in any envelope/event/projection returned by the driver (redaction canary via `scrubEventStrings`).
8. **Bounded lifecycle faults (DE-10, H-09).** TTL expiry, ignored cancel, forced kill, destroy-failure, worker-crash, and provider-outage all reach a bounded terminal outcome (no unbounded hang, no orphan); leaked-resource reconciliation converges to zero. Where D1 defines numeric bounds (cancel ≤ 30 s, cleanup ≤ 5 min) the live lane asserts them; the in-process lane asserts structural bounded-ness (terminal reached, retry ceiling honored, zero orphans).

---

## 3. Decisions

### D1 — Home: a second exported suite inside `packages/sandbox-provider-contract` (NOT a new leaf)
`runSandboxIsolationConformance` + `assertIsolationReport` live in `packages/sandbox-provider-contract/src/isolation-contract.ts`, exported from `index.ts` alongside the happy-path suite. **Rationale (all verified):** the package is already in root `vitest.config.ts:24` `projects` (a new leaf would repeat the DEP-000 "never runs" review FIX), already boundary-registered in `SANDBOX_BOUNDARY_PACKAGES` (`check-sandbox-fake-provider-boundary.mjs:38`), already the `provider` path-class consumer wired into `distributed-contract` + `ci-required` (`pr.yml:895,1009`), and CAV-002 provider-neutrality argues for one neutral home. Reuse `ContractCheckResult`/`ContractReport`/`ContractOptions`/`runCheck` verbatim. **Lift + export `projectionLeakKeys`** from `port.ts` (currently un-exported at `contract.ts:80`) as the single source both suites share — no forked allowlist that can drift.

### D2 — A SEPARATE hostile reference driver (NOT extending the benign fake)
Author `packages/sandbox-fake-provider/src/hostile-driver.ts` (a distinct `SandboxProviderDriver`), NOT hostile-scripting the benign `FakeSandboxDriver`. **Rationale (verified):** the benign fake vacuously passes hostile probes — `reconcile_cleanup` always clears + succeeds (`fake-driver.ts:269-271`), `destroy` always acknowledges (`:260-262`), no fence/governed-effect model, projection already neutral with nothing sensitive to redact. A benign double run through hostile checks manufactures false assurance before tenant canary. The hostile driver is provider-neutral (opaque `providerId`), keeps deps `{worker-protocol, zod}`, imports NO worker-daemon (boundary), and is exercised through the SAME `invoke(op, args)` port so it also passes the DEP-000 happy-path suite (a regression guard).

### D3 — Hostile inputs ride the opaque `params` map; denials are typed errors matched by name
No new `ProviderOpArgs` required field, no new `PROVIDER_OPERATION`, no frozen edit. The hostile driver reads fence identity, target generation, injected fault labels, and the sensitive payload from the opaque `params: Readonly<Record<string, unknown>>` bag (`port.ts:64`) the port already treats as a black box. Denials surface as thrown errors whose identity the suite matches **duck-typed** (`name` + a discriminant field), mirroring the existing `isUnsupportedProviderOperation` pattern (`contract.ts:56-62`) so a real adapter throwing its own cross-package `EffectAuthorityWithdrawnError`/`CleanupAuthorityDeniedError`/`ResourceNotAvailableError` conforms without importing this module.

### D4 — Non-vacuous zero-byte projection via a synthetic sensitive full-inspect
The hostile resource carries synthetic sensitive fields (`command`/`env`/`logs`/`secret`, seeded with unique canary tokens) held ONLY inside the reference double. `list`/`inspect` return the 4-key `ProviderResourceProjection` and nothing else; the probe scans the projection (and the whole `ProviderOpResult`) for any canary substring. **CAV-002 reconciliation:** the sensitive bytes are opaque synthetic test canaries, never tenant/E2B fields (`organizationId`/`companyId`/`region`/`template`/`credentials`), and never cross the common contract or projection — they exist to be proven absent.

### D5 — Egress bypass = a server-lane vectors gate reusing DAT-005 (boundary-clean)
`classifyEgressDestination` lives in `server/src/services/egress-policy.ts` — boundary-forbidden to the leaf. So the DNS/IP/proxy-bypass corpus is a **server-lane** test (mirroring DAT-005's server/daemon/in-process split), extending the DAT-005 vectors with the hostile spellings (hex-mapped `::ffff:a9fe:a9fe`, first-word-zero `::10`, `[public,private]` rebind — deny-if-any, and an INJECTED `AOA_CONTROL_PLANE_DENY_CIDRS` fixture so a control-plane probe with an empty deny set can't vacuously pass). The in-process suite asserts the DRIVER-level property (post-fence `openEgress` denied; egress to a non-allowlisted destination refused) via the reference driver, taking the classification as injected fixture data — keeping the neutral leaf free of any server import.

### D6 — Lane wiring through existing routes only (no new required check, no trigger `paths:`)
- In-process isolation suite → runs in the existing **`distributed-contract`** consumer (already gated on the `provider` path-class + folded into `ci-required`, `pr.yml:964-1009`). Verified: never add a trigger-level `paths:`/`paths-ignore:` (a skipped required check passes silently, `ci-lanes.mjs` HARD RULE 1).
- Egress vectors gate → the always-on **`policy`** job (like DAT-005's `check-egress-policy-vectors.mjs`), so it is cross-platform-honest and PR-gating.
- Live hostile probes → `tests/d1/e6f-08-*.mjs`, auto-run by the `d1-merge-train` `foundation` campaign (`d1-merge-train.yml:152`), `--test-concurrency=1` serial, Linux/CI only (`SKIP` off-CI, never faked). Any new `scripts/lib/*.mjs` helper is added to the `d1-merge-train` path filter (`:36-47`) or the lane won't re-trigger.
- Compose invariants: reuse the existing 9-service topology + app-layer probes; add a new `check*` to `scripts/lib/d1-compose-invariants.mjs` ONLY if a topology assertion is genuinely needed, each with a matching broken-clone rejection in `scripts/check-d1-compose.test.mjs`.

### D7 — E6-F008 stays open; no overclaim
DEP-008 certifies the suite + hostile reference over the invoke-driver ONLY. It ships NO per-op `SandboxProvider`→`SandboxProviderDriver` adapter and asserts NO real-supervisor conformance. The result doc records E6-F008 as the outstanding reconciliation CLI-001/D2 must close before the first E2B canary.

---

## 4. Slice plan (fail-first TDD; one ticket, one distinct final reviewer)

**Slice A — suite skeleton + neutral primitives + minimal-conforming reference.**
Lift/export `projectionLeakKeys`; author `runSandboxIsolationConformance` skeleton + `assertIsolationReport`; a MINIMAL conforming hostile driver (fence-active happy path); `isolation-contract.test.ts` wiring the driver as factory; the first `wrapDriver` non-vacuous sabotage. RED: checks fail before the runner/driver exist. GREEN: skeleton + minimal driver; both leaf typecheck/build gates + the DEP-000 happy-path suite stay green (regression).

**Slice B — the hostile authority core (the security build).**
Effect-authority withdrawal (§2.1) + effect-unrepresentable-under-cleanup (§2.2) + no-existence-oracle identity (§2.3) + monotonic convergence with bounded destroy retries + empty-pass-no-fail-open (§2.4) + bounded TTL/cancel/kill/destroy-failure/crash/outage/leak (§2.8). Each check paired with a `wrapDriver` sabotage (leaking/escalating/regressing/oracle-exposing driver) that MUST fail it. RED first per invariant.

**Slice C — zero-byte non-vacuity + egress vectors + live probes + CI wiring.**
Sensitive full-inspect + zero-byte projection probe (§2.5, §2.7) + its leak sabotage; the server-lane egress bypass vectors gate (§2.6, D5) bound to the REAL `classifyEgressDestination` (DAT-004 #D lesson); `tests/d1/e6f-08-*.mjs` live host/socket/metadata/private-net/cross-job/stale-fence probes; wire the `policy` + `distributed-contract` + `d1-merge-train` path filters. One distinct reviewer reruns the combined suite and alone flips `Status → complete`.

---

## 5. Gate + verification profile

| Lane | Command | Where |
|---|---|---|
| In-process suite (pure leaf) | `pnpm --filter @armyofagents/sandbox-provider-contract exec vitest run` + `pnpm --filter @armyofagents/sandbox-fake-provider exec vitest run` | **local + CI** |
| Boundary + neutrality | `node scripts/check-sandbox-fake-provider-boundary.mjs` (deps still EXACTLY `{worker-protocol, zod}`) | **local + CI** (`policy`) |
| Egress bypass vectors | `node scripts/check-<egress-bypass>-vectors.mjs && node --test scripts/lib/__tests__/<…>.test.mjs` (+ the server suite binding the fixture to the real classifier) | **local + CI** (`policy`) |
| Compose invariants (if touched) | `node --test scripts/check-d1-compose.test.mjs` | **local + CI** |
| Live D1 hostile probes | `node --test tests/d1/e6f-08-*.mjs` (compose up) | **Linux/CI only** (`d1-merge-train`) — DEC-03 authority; no Windows-local substitute |

Leaf typecheck/build through the shared `Invoke-NativeGate` per `implementation-plan.md:321-347`. Tests hermetic: fake clock, deterministic ids, no live provider/network/credential. Windows-local integration only via `Invoke-E3Integration` (`AOA_RUN_WIN_INTEGRATION=1`); Docker/compose lanes are Linux-CI authoritative.

---

## 6. Forward-wiring debt + explicit non-goals (do not improvise)

- **E6-F008** — invoke-driver ↔ per-op `SandboxProvider` reconciliation: **deferred to CLI-001/D2** (`port.ts:23-26`). DEP-008 certifies against the fake/hostile reference only.
- **Real E2B / managed provider** conformance: **CLI-001/E7/D2**, not here (program-design.md:743, CAV-002/CAV-001).
- **Live egress request channel** (how a sandbox reaches the egress path) + canary-seeding channel: **E4-D12 inert seam** inherited from DAT-005; the reference drives the pure decision directly.
- **Object-key cross-job** (DE-06 → DAT-002), **context/memory over-scope** (DE-19 → DAT-007), **two-replica double-admit** (DE-27 → DEP-009), **secret rotation/provenance/pinned-template** (DE-15/REL-004): out of scope — asserted-absent-here, owned elsewhere. The result doc lists each as a delegation, not a gap.
- **No** frozen worker-protocol edit, **no** new `PROVIDER_OPERATION` or `NETWORK_DENIAL_CLASS`, **no** second authority/registry, **no** trigger-level `paths:` filter, **no** new independently-required check, **no** E2B/tenant field in any common contract (CAV-002).

---

## 7. Load-bearing claims (re-verified) the implementer must not re-derive

1. Suite framework-free runner shape to mirror — `contract.ts:86-94,100,335`.
2. `projectionLeakKeys` un-exported; `PROVIDER_PROJECTION_KEYS` exported — `contract.ts:80`, `port.ts:70`, `index.ts:9`.
3. Benign fake vacuously passes hostile probes — `fake-driver.ts:252,260-262,269-271`.
4. Authority invariants to mirror (do NOT import) — `effect-authority.ts:34-52,74-79`; `cleanup-authority.ts:47-70,127-167,241-247`.
5. Only extension hook on the port is opaque `params` — `port.ts:58-65`.
6. Frozen vocabulary is exactly 8 core + 3 optional ops and 4 denial classes — `capabilities.ts:125-159`, `events.ts:313`.
7. Boundary deps EXACTLY `{worker-protocol, zod}`; both DEP-000 pkgs already in `vitest.config.ts:24` — `sandbox-fake-provider-boundary.mjs:45`.
8. `distributed-contract`+`ci-required` gate the `provider` class; `check-d1-compose.mjs` runs only in `d1-merge-train`, not `pr.yml` — `pr.yml:895,964-1009`, `d1-merge-train.yml:76`.
