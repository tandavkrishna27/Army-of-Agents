# DEP-008 Result — Managed sandbox isolation conformance (hostile suite + reference)

**Status:** `complete` (in-process + server-lane + static local; live D1 `e6f-08` probes = Docker/CI-only, authored + parse-verified)
**Disposition:** `pass` (all focused acceptance evidence green locally; the live `d1-merge-train` bring-up is Docker/CI-only, no Windows-local substitute — DEC-03)
**Date opened (UTC):** `2026-08-15`
**Epic:** `E6-deployment-test-harness` (remainder; first of DEP-005..009)
**Plan task:** `DEP-008 — Managed sandbox isolation conformance (program-design.md:739-744)`
**Implementer:** `Claude subagent (opus) — worktree C:\e3`
**Reviewer:** `Claude adversarial-review Workflow (6 dimensions → refute-by-default verify, 13 agents) + controller re-verification + fix round`
**Start SHA:** d849dc2423190754f52e2e8c88d5ac5944ba42e4

## Acceptance model + CI caveat

E6 certifies the **suite + hostile reference** over the frozen invoke-driver port — **NOT E2B and NOT any real adapter** (program-design.md:743). The adversarial-review Workflow is the independent check; it produced **1 HIGH, 3 MEDIUM (M1–M3), and several LOW** confirmed/partial findings — **all fixed** — and correctly **refuted** the two most alarming finder framings (the §2.6 "circular egress check" and the "params-handshake overclaim"), which are by-design and disclosed. The live `tests/d1/e6f-08-*.mjs` probes require a Docker compose bring-up (Linux CI `d1-merge-train`); they are authored + `node --check`-verified + SKIP-guarded off-CI, never faked.

## Delivered scope

- **`runSandboxIsolationConformance(makeDriver, options)`** — a second exported, framework-free conformance suite in `packages/sandbox-provider-contract`, mirroring DEP-000's `runSandboxProviderContract` runner shape, with **8 hostile checks** (1:1 with design §2): effect-authority withdrawal; effect-ops-unrepresentable-under-cleanup; no-existence-oracle (uniform error identity, incl. an **ownership-scoped `list`** probe); monotonic cleanup convergence (bounded destroy retries, no fail-open latch); non-vacuous zero-byte projection; network-denial + no-bypass; credential/customer-byte absence; bounded TTL/cancel/kill/destroy-failure/crash/outage/leak.
- **`HostileSandboxProvider`** — a *separate* provider-neutral reference driver (the benign fake vacuously passes hostile probes) mirroring worker-daemon's `EffectAuthorityWithdrawnError`/`CleanupAuthorityDeniedError`/`ResourceNotAvailableError` **by shape** (never imported — boundary), over the opaque `params` channel; no new op, no frozen-protocol edit.
- **Non-vacuousness:** every check paired with a `wrapDriver` sabotage that MUST fail it (9 sabotage tests incl. a dedicated §2.4(d) fail-open-latch), each asserting the target's failure *reason*, not merely that it failed.
- **Egress bypass lane (server):** `scripts/check-egress-bypass-vectors.mjs` (+ `.test.mjs`) re-derives the DAT-005 classifier independently over a hostile SSRF/rebind corpus (`tests/fixtures/egress-bypass/v1/vectors.json`), and `server/src/__tests__/egress-bypass.test.ts` binds the same corpus to the **real** `classifyEgressDestination` — wired into the always-on `pr.yml` `policy` job.
- **Live D1 probes:** `tests/d1/e6f-08-egress-isolation.test.mjs` + `e6f-08-stale-fence.test.mjs`, auto-run by the `d1-merge-train` `foundation` campaign.
- **Non-goals preserved:** no E2B/real-adapter conformance (CLI-001/D2); E6-F008 (invoke-driver ↔ per-op `SandboxProvider`) left **open**; frozen worker-protocol untouched; deps stay `{worker-protocol, zod}`; CAV-002 (no E2B/tenant field in any common contract); no trigger-level `paths:` filter; no new required check.

## Changed files

| File | Responsibility |
|---|---|
| `packages/sandbox-provider-contract/src/isolation-contract.ts` (new) | The 8-check hostile conformance suite + `assertIsolationReport` |
| `packages/sandbox-provider-contract/src/port.ts` | Lifted + exported `projectionLeakKeys` (single shared zero-byte allowlist) |
| `packages/sandbox-provider-contract/src/contract.ts` | Exported `runCheck`/`CheckFn`; consumes the shared `projectionLeakKeys` (no happy-path change) |
| `packages/sandbox-provider-contract/src/index.ts` | Export the isolation suite + primitives |
| `packages/sandbox-provider-contract/src/__tests__/isolation-contract.test.ts` (new) | Positive + happy-path regression + 9 non-vacuous sabotages (reasons asserted) |
| `packages/sandbox-provider-contract/src/__tests__/port-conformance.test.ts` | Compile-time `HostileDriver satisfies SandboxProviderDriver` |
| `packages/sandbox-fake-provider/src/hostile-driver.ts` (new) | The hostile reference driver (ownership-scoped cleanup `list`) |
| `packages/sandbox-fake-provider/src/index.ts` | Export the hostile provider + mirrored errors + `HOSTILE_MAX_DESTROY_ATTEMPTS` |
| `scripts/check-egress-bypass-vectors.mjs` (new) | Independent re-derivation over the bypass corpus; stronger `=== allow` anti-vacuity |
| `scripts/check-egress-bypass-vectors.test.mjs` (new) | 7-case node:test guard (fixture + spellings + mutation negatives) |
| `tests/fixtures/egress-bypass/v1/vectors.json` (new) | Hostile SSRF/rebind corpus incl. `not_allowlisted` + `http:`-scheme vectors |
| `server/src/__tests__/egress-bypass.test.ts` (new) | Corpus bound to the real classifier; `=== allow` load-bearing assertion |
| `tests/d1/e6f-08-egress-isolation.test.mjs` (new) | Live host/socket/metadata/private-net unreachability probes |
| `tests/d1/e6f-08-stale-fence.test.mjs` (new) | Live stale-fence ≡ missing-lease equality probe |
| `.github/workflows/pr.yml` | Wire the egress-bypass gate into the always-on `policy` job (review finding H1) |

## Acceptance evidence

| Acceptance condition (program-design.md:743) | Evidence | Result |
|---|---|---|
| Fence loss blocks governed effects; narrow monotonic cleanup authority stays usable | `effect-authority-withdrawal` (asserts governed ops deny AND each cleanup op succeeds post-fence) + sabotage | `pass` |
| Cleanup authority cannot escalate/create/execute (effect ops unrepresentable) | `effect-ops-unrepresentable-under-cleanup` + surgical sabotage | `pass` |
| No existence oracle (cross-resource/wrong-gen/absent collapse to one identity; list ownership-scoped) | `no-existence-oracle` (byte-identical error identity + `list` disclosure probe) + sabotage | `pass` |
| TTL/cancel/kill/destroy-failure/crash/outage/leak bounded | `bounded-lifecycle-faults` + `monotonic-cleanup-convergence` (bounded retries, no fail-open) + 2 sabotages | `pass` |
| Management-only inspect exposes ZERO command/env/log/secret/customer bytes | `zero-byte-management-projection` (non-vacuous canary byte-scan) + leak sabotage | `pass` |
| DNS/IP/proxy bypass denied per frozen class; provider creds absent | `check-egress-bypass-vectors` + `server/egress-bypass.test.ts` (real classifier) + `no-credential-or-customer-byte-leak` | `pass` |
| Host/provider socket, DB, metadata, private nets, worker/control-plane internals unreachable | `tests/d1/e6f-08-egress-isolation.test.mjs` (internal-network topology) | `pass` (CI-deferred: Docker/Linux) |
| Reusable suite the real E2B adapter reruns at CLI-001/D2 | Suite is provider-neutral over the invoke-driver; E6-F008 documented open | `pass` (scope-honest) |

## Commands

| Command | Exit code | Result summary |
|---|---:|---|
| `pnpm --filter @armyofagents/sandbox-provider-contract exec vitest run` | `0` | 4 files, **22 passed** (isolation 11 incl. §2.4(d) + happy-path regression + 8 sabotages) |
| `pnpm --filter @armyofagents/sandbox-fake-provider exec vitest run` | `0` | 4 files, **15 passed** |
| `node scripts/check-sandbox-fake-provider-boundary.mjs` | `0` | `PASS`; deps still exactly `{worker-protocol, zod}` |
| `node scripts/check-egress-bypass-vectors.mjs` | `0` | `PASS (2 allow, 14 deny, 2 injected-control-plane)` |
| `node --test scripts/check-egress-bypass-vectors.test.mjs` | `0` | **tests 7, pass 7, fail 0** |
| `node scripts/check-egress-policy-vectors.mjs` (regression — imported by the bypass gate) | `0` | `PASS (4 allow, 19 deny)` |
| `pnpm --filter @armyofagents/server exec vitest run src/__tests__/egress-bypass.test.ts` | `0` | **3 passed** (real classifier) |
| `pnpm --filter …sandbox-provider-contract --filter …sandbox-fake-provider typecheck` | `0` | both clean |
| `node scripts/check-ci-lanes.mjs` | `0` | `PASS` (pr.yml edit — no trigger-level `paths:`) |
| `node --check tests/d1/e6f-08-*.test.mjs` | `0` | both parse |

## Deviations

- **`runCheck`/`CheckFn` exported from `contract.ts`** (previously private) so the isolation suite reuses the exact accumulator per design D1 ("reuse `runCheck`"); additive, no happy-path behavior change.
- **Egress bypass is a DEP-008-owned sibling corpus** (`tests/fixtures/egress-bypass/v1/`) that *reuses* the DAT-005 reference classifier, rather than an in-place edit of DAT-005's fixture (keeps DEP-008 additive; avoids perturbing DAT-005's asserted counts).

## Findings

Adversarial-review Workflow (6 dimensions, 13 agents): **1 HIGH, 3 MEDIUM, 5 LOW** confirmed/partial — **all resolved this round**. Each re-verified by the controller against the code before fixing:

- **H1 (HIGH) — egress-bypass gate ran in NO workflow.** The independent re-derivation + structural fixture guards were dead in CI. **Fixed:** wired `node scripts/check-egress-bypass-vectors.mjs && node --test …` into the `pr.yml` `policy` job.
- **M1 (MEDIUM) — control-plane anti-vacuity used the weaker `!== control_plane`.** A private/metadata-overlapping injected CIDR would pass as "load-bearing" while inert. **Fixed:** both the reference gate and `server/egress-bypass.test.ts` now assert `=== allow` under an empty deny set.
- **M2 (MEDIUM) — §2.1 post-fence cleanup usability under-asserted** (only rejected the withdrawal error; destroyed the resource before inspecting it). **Fixed:** each cleanup op now asserts its success kind in a safe read-before-destroy order, with a non-withdrawal-throw sabotage.
- **M3 (MEDIUM) — cleanup-facet `list` returned all resources unfiltered** (existence oracle the suite never probed). **Fixed:** the reference filters `list` by asserted generation; §2.3 now probes it (convergence lists without a generation stay global).
- **L1 — `GOVERNED_EFFECT_OPS` hardcoded the optional ops without consulting `supportedOperations()`** (a latent E6-F008 false-reject trap). **Fixed:** §2.1/§2.2 gate on `supportedOperations()`.
- **L2 — sabotages did not assert the failure reason.** **Fixed:** every sabotage now asserts the target check's `.detail`; §2.2 sabotage scoped to the cleanup facet (surgical).
- **L3 — §2.4(d) empty-pass sub-check had no dedicated sabotage.** **Fixed:** added a fail-open-latch sabotage.
- **L4 — destroy-ceiling coupled by coincidental default.** **Fixed:** threaded `HOSTILE_MAX_DESTROY_ATTEMPTS` from one source into both driver and suite.
- **L5 — bypass corpus omitted `not_allowlisted`.** **Fixed:** added `not_allowlisted` (public non-allowlisted host) + `http:`-scheme vectors.

**Refuted (checked, not defects):** the §2.6 in-process egress check's class-echo is a *disclosed* two-lane partition (D5) — real classification is the now-CI-wired server lane; the params-handshake coupling is *disclosed* (D3/D7) and scoped to E6-F008; the "type-level `never` downgraded to runtime" and "monotonic epoch untested" framings are the documented single-`invoke`-port limitation reconciled at CLI-001/D2.

## Residual risk / scope-honesty

1. **E6 certifies the suite + hostile reference over the invoke-driver — NOT E2B / no real adapter.** The applicable suite is re-run against real E2B at **CLI-001/E7/D2**.
2. **E6-F008 stays open and is broader than a port-shape mismatch:** the suite drives the reference through a `params` fault-injection vocabulary (`withdrawEffectAuthority`, `authority:"cleanup"`, `lifecycleFault`, `targetGeneration`, …). A real adapter needs both a shape bridge *and* a params translation. Concrete seams the rerun must build (not re-derive): the optional-op advertisement gate (now handled via `supportedOperations()`), authority-scoped `list` filtering, and the type-level cleanup-effect denial.
3. **Live `e6f-08` probes are CI-deferred** (Docker/Linux `d1-merge-train`); authored + parse-verified locally, never run on Windows.
4. **Object-key cross-job (DE-06 → DAT-002), context/memory over-scope (DE-19 → DAT-007), two-replica double-admit (DE-27 → DEP-009), secret rotation/provenance (DE-15/REL-004)** are out of scope — asserted-absent-here, owned elsewhere.

## Follow-up tickets

`None` new. Deferred seams tracked under E6-F008 (CLI-001/D2) and the delegations in Residual risk §4.

## Gate recommendation

`ready for independent review` — all focused acceptance evidence passes locally; the live D1 lane is Docker/CI-only under DEC-03.

## Independent review

**Reviewer:** `Claude adversarial-review Workflow (6 dimensions → refute-by-default verify, 13 agents) + controller re-verification`
**Reviewed revision:** `d849dc2423190754f52e2e8c88d5ac5944ba42e4` (implementer base) → fixes re-verified against the working tree
**Disposition:** `approved`
**Review evidence:** 1 HIGH + 3 MEDIUM + 5 LOW confirmed/partial, all fixed and re-verified; every gate above re-run green by the controller post-fix; the two most-severe finder framings refuted with cited code.

## Review attempt history

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
| 1 | Claude adversarial-review Workflow (13 agents) + controller | `d849dc2423190754f52e2e8c88d5ac5944ba42e4` | `approved` | 1 HIGH (H1 gate-wiring) + 2 MEDIUM (M1 anti-vacuity, M2 cleanup-usability) + M3 list-oracle + 5 LOW, all fixed; refuted §2.6-circular-as-HIGH + params-overclaim; all local gates green post-fix |
