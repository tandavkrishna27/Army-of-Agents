# CLI-001 Design — E2B provider implementation

**Status:** `design` (reviewable artifact; implementation via fail-first TDD + distinct adversarial review). **Scope (operator-directed 2026-08-16): FULL — the no-key-provable core AND the real-E2B cases wired into a keyed CI lane** (the operator supplies `E2B_API_KEY` via a GitHub Actions secret + a template id, and dispatches the lane; the controller never handles the key in plaintext).
**Epic:** `E7 — Coding/CLI workload on E2B` (FIRST ticket; net-new epic dir). **Authoritative source:** `program-design.md:755-761`.
**Depends on (all complete + CI-green):** WRK-004 (worker-daemon per-op `SandboxProvider` port + `CleanupAuthority` + `reconcile()`), DAT-005 (egress proxy + redaction), DEP-006 (manifest-layer provider-control credential boundary — LANDED), DEP-008 (`runSandboxIsolationConformance` hostile suite + `HostileSandboxProvider`), DEP-000 (`runSandboxProviderContract` happy-path suite + `FakeSandboxProvider`). Frozen worker-protocol v1 SHA `b7a842870ce7509d8baa75409e0ab19da375c88a` (the `PROVIDER_OPERATIONS` vocabulary — consumed, never edited).
**Grounded by:** the CLI-001 terrain-map (5 readers + synth) with the load-bearing claims **independently re-verified** in `C:\e3`: **E6-F008 is open** — the invoke-driver `SandboxProviderDriver` (single `invoke(op,args)`, `sandbox-provider-contract/src/port.ts:146`, what BOTH suites run against) and worker-daemon's per-op `SandboxProvider` (8 core + 3 optional methods, `worker-daemon/src/supervisor/provider.ts:291-311`) are structurally distinct and no adapter bridges them (`port.ts:23-25`); the domain is **fully greenfield** (the only `implements SandboxProvider` is worker-daemon's in-process fake; no real E2B provider, no admission-limits code); the denial classes the real driver must throw are `CleanupAuthorityDeniedError`/`ResourceNotAvailableError` (`cleanup-authority.ts:51,65`), `EffectAuthorityWithdrawnError` (`effect-authority.ts:45`), `SandboxEgressDeniedError` (asserted by-name `isolation-contract.ts:391`), `UnsupportedProviderOperation` (`port.ts:130`); **CLI-001 owns NO `DE-*` threat** (0 in `distributed-execution-threat-controls.json`) and is a CO-owner (not sole) of CM-010/CM-012; the `e2b` SDK `^2.30.5` is already a dependency (`server/package.json:67`); the keyed lane pattern already exists (`deploy-testing.yml`: `workflow_dispatch` + `e2b_template` input + `E2B_API_KEY` secret).

---

## 1. Scope + framing

**Outcome (program-design.md:757):** implement secure `create/execute/cancel/kill/destroy/list/inspect/reconcile-cleanup` + advertised optional `checkpoint/restore/health` behind the worker provider interface, for E2B.

**Acceptance (program-design.md:759):** secured access enabled; the provider-control credential injected only into the adapter-management boundary (DEP-006), account/audience-scoped, rotatable/revocable without tenant exposure, old-key denial does not prevent cleanup through current management authority; pinned template/image/policy + a **verified** E2B limit/capability matrix; admission rejects or attributes out-of-limit work; metadata contains no secrets; every sandbox has an enforced TTL; cleanup idempotent after lost responses; unsupported ops explicit; the common provider/protocol seam contains no E2B-specific field.

**The thesis that shapes the design.** The real E2B provider is greenfield, but the *contract* it must satisfy is already built and certified against reference doubles. CLI-001 delivers the real driver + the **E6-F008 bridge** that makes both existing suites runnable against it, and splits proof by what a live key requires:

- **No-key core (lands CI-green now):** the real E2B provider driver (implementing the authoritative per-op `SandboxProvider`), the **E6-F008 adapter** (`perOpToInvokeDriver`) exposing any per-op provider AS the invoke-driver both suites run against, BOTH suites green against a **deterministic mocked/recorded E2B transport double** (the driver code is real; only the `e2b` SDK transport is substituted), CAV-002 seam-neutrality (statically enforced), reuse of the landed DEP-006 credential boundary, the template/capability-matrix **disposition record** + the "no required case unsupported" lint, and all CI wiring.
- **Keyed real-E2B lane (operator-dispatched):** the same conformance suites + the managed-secret rehearsal run against **real E2B** in a `workflow_dispatch` lane reading `secrets.E2B_API_KEY` + an `e2b_template` input — gated on the key being present (runs when keyed, SKIPs cleanly otherwise). Authored + `node --check` parse-verified now; the operator adds the secret and dispatches.

| Workstream | Lane | Kind | Responsibility |
|---|---|---|---|
| `packages/sandbox-e2b-provider` — real E2B driver | `packages/**` | new leaf | implements the per-op `SandboxProvider` over the `e2b` SDK (injectable transport); throws the exact denial classes; enforces TTL/idempotent-cleanup/redacted-projection |
| **E6-F008** `perOpToInvokeDriver` adapter + params translation | `packages/**` | new (closes the open finding) | a tested, GENERIC per-op→invoke-driver adapter translating the opaque `params` fault-injection bag (`withdrawEffectAuthority` / `authority:'cleanup'` / `lifecycleFault` / `targetGeneration` / `egress.classification`) into per-op method context; `supportedOperations()` advertisement gate; authority-scoped `list` filtering; type-level cleanup-effect denial |
| Both conformance suites vs mocked E2B transport | `packages/**` tests | test | `runSandboxProviderContract` (9) + `runSandboxIsolationConformance` (8) green against `perOpToInvokeDriver(new E2bSandboxProvider(mockTransport))` |
| Capability-matrix disposition + no-required-unsupported lint | docs + test | additive | record template/image/policy + verified-limit matrix + each supported/unsupported optional op & fallback; lint forbids marking a required case unsupported |
| Real-E2B keyed lane (`deploy-testing.yml`-style) | CI (keyed) | additive | real-provider conformance + managed-secret rotation/revocation/kill-switch, gated on `secrets.E2B_API_KEY` + `e2b_template` |
| CI wiring | CI/static | additive | add the package to `pr.yml:102` provider glob + `vitest.config.ts:24` projects + a `policy` boundary checker |

**Additive.** New leaf package; no frozen worker-protocol edit; no `DE-*` threat-register edit (CLI-001 owns none — co-owner of CM-010/CM-012 only); reuse (never re-implement) the DEP-006 credential boundary; keep the common provider/protocol/DB/projection seam provider-neutral (CAV-002).

---

## 2. Invariants (each gets a test; real-E2B rerun is the keyed lane)

1. **The real E2B provider passes the happy-path contract.** `runSandboxProviderContract` (9 checks) green against `perOpToInvokeDriver(E2bSandboxProvider(mockTransport))`.
2. **…and the hostile isolation/cleanup suite.** `runSandboxIsolationConformance` (8 checks §2.1–§2.8) green against the same — no case marked unsupported except genuinely-optional `checkpoint/restore/health`.
3. **E6-F008 adapter is faithful + non-vacuous.** The per-op→invoke-driver adapter translates every `ProviderOperation` + the full `params` fault vocabulary; unit tests prove each op routes to its method and each fault lever reaches the provider; a sabotaged provider is caught (the DEP-008 `wrapDriver` non-vacuity pattern).
4. **Seam-neutrality (CAV-002).** No `organizationId`/`region`/`template`/`credentials`/E2B field crosses the provider-neutral seam; the redacted projection key set ⊆ `PROVIDER_PROJECTION_KEYS` (4-key allowlist). Statically + boundary-checker enforced.
5. **Credential boundary (DEP-006 reuse).** The E2B credential is read only in the adapter-management context; the U5 allowlist keeps it out of the tenant overlay; no re-implementation of the DEP-006 static boundary.
6. **Capability-matrix disposition + lint.** Every required isolation/fencing/TTL/kill/inspect/cleanup case is present and NOT marked unsupported; only optional ops may be recorded unsupported-with-fallback.
7. **Real-E2B (keyed lane).** Against a real key: the applicable DEP-008 cases + the managed-secret rehearsal (tenant-probe-fails, old-key-denied-after-cutoff, kill-switch-stops-create/execute, cleanup-survives-rotation) + real-TTL enforcement. Gated on `secrets.E2B_API_KEY`; SKIPs cleanly without it.

---

## 3. Decisions

### D1 — New leaf `packages/sandbox-e2b-provider` implementing the per-op `SandboxProvider`
Mirror the DEP-000/DEP-008 template leaves (`sandbox-fake-provider`). The provider `implements` worker-daemon's authoritative per-op `SandboxProvider` (`create/execute/cancel/kill/destroy/list/inspect/reconcileCleanup` + optional `checkpoint/restore/health`, `advertisedOperations`/`checkpointMode`/`healthMode`). Deps: the `e2b` SDK (`^2.30.5`, already in the monorepo) + `@armyofagents/worker-protocol` (frozen op vocab) + worker-daemon's exported port types + `zod`. **The SDK transport is injected** (a constructor `transport` seam) so tests substitute a deterministic mock/recorded double; the driver logic is real either way. It throws the exact denial classes (`EffectAuthorityWithdrawnError`, `CleanupAuthorityDeniedError.attemptedOperation`, `ResourceNotAvailableError`, `SandboxEgressDeniedError.destinationClass`, `UnsupportedProviderOperation.operation`) and returns only `RedactedResourceProjection` from `inspect`/`list`.

### D2 — Close E6-F008 with a tested generic `perOpToInvokeDriver` adapter (not port relocation)
`port.ts:23-25` names the two options; choose the **adapter** (lower churn, and it is the natural home for the `params`→context translation). A generic `perOpToInvokeDriver(provider: SandboxProvider): SandboxProviderDriver` exposes any per-op provider through the single `invoke(op,args)` surface both suites drive. It imports BOTH worker-daemon's port types and `sandbox-provider-contract`'s driver types (so it lives in the new e2b leaf, or a tiny dedicated leaf — settle in review; default: the e2b package, since worker-daemon and sandbox-provider-contract stay unchanged and free of a new cross-dep). It translates the opaque `params` fault vocabulary into per-op context, gates optional ops on `supportedOperations()`/advertisement (else `UnsupportedProviderOperation`), applies authority-scoped `list` filtering, and enforces type-level cleanup-effect denial. Unit-tested against both the fake AND the real (mock-transport) provider.

### D3 — Both suites green against a mocked/recorded E2B transport double
Run `runSandboxProviderContract` + `runSandboxIsolationConformance` against `perOpToInvokeDriver(new E2bSandboxProvider(mockTransport))`. The mock transport is deterministic and pure-TS (records/replays the `e2b` SDK call shapes the driver makes) — it proves the *driver's* protocol behavior (op routing, denial throws, redaction, idempotent cleanup, TTL-shape) without a key. This is the no-key core's central proof.

### D4 — Real-E2B keyed lane, reusing the `deploy-testing.yml` secret pattern
Author the real-E2B cases as tests gated on `process.env.E2B_API_KEY` (run when present, `SKIP` otherwise — never faked). Wire a `workflow_dispatch` job (extend `deploy-testing.yml` or add a sibling keyed lane) supplying `E2B_API_KEY: ${{ secrets.E2B_API_KEY }}` + `E2B_TEMPLATE: ${{ inputs.e2b_template }}`. It runs the applicable DEP-008 isolation/cleanup cases + the managed-secret rehearsal against real E2B. **Operator action (never the controller):** add `E2B_API_KEY` to repo secrets, provide a template id, dispatch the lane. The controller authors + `node --check` parse-verifies; the key never enters chat or plaintext.

### D5 — Capability-matrix disposition record + no-required-case-unsupported lint
A recorded `CLI-001-capability-matrix.md` (or a typed fixture) pins template/image/policy versions + the verified E2B limit/capability matrix + each supported case + each genuinely-unsupported optional capability with its fallback. A static test lints that no required isolation/fencing/TTL/kill/inspect/cleanup case is marked unsupported. The "verified" qualifier on the matrix is completed by the keyed lane; the no-key core pins the disposition shape.

### D6 — CI wiring (or the lane runs vacuously)
Add `^packages/sandbox-e2b-provider/` to the `pr.yml:102` provider path-glob (else `distributed-contract`/`ci-required` never gate it), add the package to `vitest.config.ts:24` `projects` (DEP-000 FIX-4: unregistered suites never run), and add a `scripts/check-sandbox-e2b-provider-boundary.mjs` (+ `.test.mjs`) to the always-on `policy` job mirroring `check-sandbox-fake-provider-boundary.mjs` (asserting the leaf's dep set + no tenant/secret field leak).

---

## 4. Non-goals / scope honesty

1. **Not the networked worker→provider transport/wire** (`provider.ts:15-21` defers it, reconciling with E6-F003/DEP-002) — CLI-001 delivers the driver + the per-op↔invoke-driver adapter, not the remote transport.
2. **Not CLI-004** (real-E2B cleanup reconciliation as its own ticket) **nor CLI-006** (the live tenant-canary journey) — downstream.
3. **Admission-limits placement:** CLI-001 pins the capability matrix + attributes/rejects out-of-limit work against it; where the runtime admission gate finally lives (worker-daemon supervisor vs DEP-009 control-plane store) is settled minimally here and may be revisited in CLI-002/CLI-006.
4. **No frozen worker-protocol edit; no `DE-*` threat-register edit** (co-owner of CM-010/CM-012 only — update those crosswalk dispositions, not the threat register).

---

## 5. CI + acceptance mapping

| Acceptance clause (L759-760) | Where satisfied | Gate |
|---|---|---|
| create/execute/cancel/kill/destroy/list/inspect/reconcile-cleanup implemented | per-op `SandboxProvider` + contract suite | `verify` + `distributed-contract` |
| every applicable DEP-008 isolation/cleanup case | isolation suite via `perOpToInvokeDriver` | no-key: mock transport; real: keyed lane |
| credential injected only at adapter-mgmt boundary, rotatable | reuse DEP-006 static boundary | `policy` (already gating) |
| metadata contains no secrets; no E2B field in seam (CAV-002) | redacted projection + boundary checker | `policy` + `verify` |
| enforced TTL; idempotent cleanup after lost responses; unsupported ops explicit | driver + contract/isolation suites | `verify` + `distributed-contract` |
| pinned template/policy + **verified** limit/capability matrix | disposition record (pin) + keyed lane (verify) | `policy` lint + keyed lane |
| account/audience scoped; rotatable/revocable without tenant exposure; old-key denial ⇏ no cleanup; secured access enabled; real-TTL | **real E2B** managed-secret rehearsal | **keyed lane** (`secrets.E2B_API_KEY`) |

**Gate recommendation for implementation:** fail-first — write the E6-F008 adapter tests + both suites against the mock-transport provider RED before the driver, then GREEN; author the keyed real-E2B cases SKIP-guarded + parse-verified; wire `pr.yml`/`vitest`/`policy`; distinct adversarial review before the result doc. Disposition = scope-honest `pass` on in-process + static + Linux-CI evidence for the no-key core, with the real-E2B rerun runnable the moment the operator supplies the key.
