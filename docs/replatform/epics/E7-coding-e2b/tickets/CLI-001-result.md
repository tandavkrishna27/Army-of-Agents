# CLI-001 Result — E2B provider implementation

**Status:** `complete (no-key core) + CI-GREEN + keyed-lane authored` — the no-key core is green in the PR gate suite at landed SHA `bce3314c1` (verify builds+tests the package; distributed-contract via the provider glob; policy incl. the new boundary checker + the Dockerfile deps-stage COPY). The real-E2B cases are authored, `node --check` parse-verified, and run when the operator supplies `E2B_API_KEY` (repo secret) + a template id and dispatches `keyed-e2b-conformance.yml`. (A post-push `policy` failure — the new package missing from the Dockerfile deps stage — was fixed in `bce3314c1`; a one-off `verify` flake in the unrelated DEP-009 `job-retry-capacity-transfer.integration.test.ts` under CI-DB contention passed on re-run and locally.)
**Disposition:** `pass` (scope-honest, on in-process + static + Linux-CI evidence for the no-key core; the real-E2B rerun is runnable the moment the operator supplies the key — the DEP-008/DEP-006 precedent). **FIRST ticket of E7.**
**Date opened (UTC):** `2026-08-16`
**Epic:** `E7 — Coding/CLI workload on E2B`. **Plan task:** `CLI-001 (program-design.md:755-761)`. **Scope: FULL** (operator-directed — no-key core + keyed real-E2B lane).
**Implementer:** `Claude subagent (general-purpose) — worktree C:\e3`. **Reviewer:** `Claude adversarial-review Workflow (5 dimensions → refute-by-default verify, 24 agents) + controller re-verification + fix round`.
**Start SHA:** `738d4463c` (design-doc commit).

## Acceptance model + framing

CLI-001 is greenfield (no real E2B provider existed), but the contract it satisfies was already certified against reference doubles. Delivered:

- **`packages/sandbox-e2b-provider`** — `E2bSandboxProvider` `implements` worker-daemon's authoritative per-op `SandboxProvider` over an **injected** `e2b` transport seam (the SDK is substituted by a deterministic key-less mock for the no-key lane and dynamically imported only in the keyed lane). It throws the EXACT worker-daemon denial classes (re-exported, not mirrored — so `instanceof`/`isNamed` hold in the real supervisor), returns only `RedactedResourceProjection` (key set ⊆ `PROVIDER_PROJECTION_KEYS`), enforces TTL, and converges cleanup idempotently.
- **E6-F008 closed** — a generic `perOpToInvokeDriver` adapter (hosted in the new leaf; worker-daemon + `sandbox-provider-contract` stay untouched) exposes any per-op provider through the single-`invoke` surface both suites drive, translating the full `params` fault vocabulary into per-op context, gating optional ops on advertisement, applying authority-scoped `list` filtering + type-level cleanup-effect denial.
- **Both certified suites green against the real driver** — `runSandboxProviderContract` (8 checks; the 9th golden-corpus check is opt-in on `fixturesDir`) + `runSandboxIsolationConformance` (8 §2.1–§2.8) against `perOpToInvokeDriver(new E2bSandboxProvider(mockTransport))`, asserting exact counts + all-ok, with one destroy-ceiling threaded into both.
- **CAV-002** seam-neutrality (no `organizationId`/`region`/`template`/`credentials`/E2B field crosses the neutral seam; the `E2B_API_KEY` token + `e2b` import are confined to `real-transport.ts`), a capability-matrix disposition + a mutation-resistant no-required-case-unsupported lint, and the CI wiring (`pr.yml:102` provider glob + `verify`/`distributed-contract` build+test + `vitest.config.ts` projects + a `policy` boundary checker).
- **Keyed real-E2B lane** — `keyed-e2b-conformance.yml` (`workflow_dispatch`, `secrets.E2B_API_KEY` + `e2b_template` input) runs the applicable DEP-008 isolation/cleanup cases + the managed-secret rehearsal (tenant-probe-fails, old-key-denied-after-cutoff, kill-switch, cleanup-survives-rotation) + real TTL against real E2B; SKIPs cleanly with no key.

## Findings (adversarial review — 24 agents, 18 raw → 3 confirmed after refute-by-default; all fixed)

The core came back **clean**: denial-class fidelity (exact frozen classes re-exported), projection redaction / CAV-002 (only the 4 allowlisted keys, no raw `InspectResult` escaping, credential confined to `real-transport`), idempotent cleanup (NotFound→success / transient→reported-failed / bounded retries), the capability-matrix lint (mutation-resistant, anchored to the frozen `CORE_PROVIDER_OPERATIONS`), and the CM-010/CM-012 crosswalk (real-E2B rotation honestly keyed to CLI-004, not claimed done). The three confirmed findings were all **mock-fidelity / test-labeling** issues in the no-key layer — the exact "mock yes-machine" risk the review targeted — not live isolation holes; all fixed:

- **MEDIUM — the deadline/TTL timeout verdict was 100% mock-authored.** `execute` forwarded `ctx.deadlineMs` to the transport and trusted its `timedOut`, while the mock forced `timedOut` on `timeoutMs===0`; real E2B treats `timeoutMs=0` as "disable/default" (returns `timedOut:false`), so the load-bearing "never hangs, always bounded" checks (contract §5 / isolation §2.8) went green on a synthetic mock convention that **inverts** against real E2B. **Fixed:** the driver now OWNS the zero-budget verdict — `execute` short-circuits `deadlineMs<=0` to a deterministic `timedOut` terminal before the transport; the mock is made honest (only a genuine sandbox-TTL fire authors a timeout); a positive budget is enforced by real E2B's own command timeout (keyed lane). **Proven RED→GREEN:** with the honest mock, neutralizing the driver short-circuit turns §5, §2.8, and the adapter's timeout test RED — the guarantee is now driver-owned.
- **LOW — pagination byte-stability (contract §8) was a mock artifact.** No driver layer ordered `list`; §8's `walk()===walk()` held only because the mock sorted. **Fixed:** the driver's `list` projection now sorts by the opaque resource id, so the determinism guarantee is driver-owned.
- **LOW — a mislabeled characterization test.** An inspect-oracle test asserting a sabotaged provider is NOT caught sat inside the `non-vacuity (a sabotaged provider is caught)` describe block. **Fixed:** moved it into a `known limitation: the adapter has no independent inspect oracle` block (with a `TODO(CLI-004)` to promote it to a real guard), leaving the genuine non-vacuity guard (the destroy-leak test) in place.

**Refuted / accepted-by-design:** the contract suite runs 8 (not 9) checks because the 9th is an opt-in golden-corpus-*presence* check (runs only with a supplied `fixturesDir`), not a provider-behavior check — legitimately skipped.

## Commands (verbatim, re-run by the controller after the fixes)

| Command | Result |
|---|---|
| `pnpm --filter @armyofagents/sandbox-e2b-provider typecheck` + `build` | clean; dist emitted |
| `pnpm --filter @armyofagents/sandbox-e2b-provider test:run` | **21 pass + 9 keyed-skip** — contract 8/8 + isolation 8/8 against the real driver via `perOpToInvokeDriver` |
| MEDIUM non-vacuity: neutralize the driver deadline short-circuit (honest mock) | §5 + §2.8 + adapter timeout test go **RED**; restored → GREEN (verdict is driver-owned) |
| `node scripts/check-sandbox-e2b-provider-boundary.mjs` + `node --test …boundary.test.mjs` | **OK + 33/33** |
| `node --check` keyed-real-e2b.test + real-transport + workflow YAML | parse OK (keyed cases SKIP off `E2B_API_KEY`; `e2b` SDK dynamically imported) |
| `git status` | new leaf + scripts + workflow + `pr.yml`/`vitest`/crosswalk; NO `worker-protocol` or `DE-*` edits |

## Residual risk / scope-honesty

1. **Real-E2B validation is keyed-lane-only.** The no-key core proves the driver's *protocol behavior* against a now-honest mock transport; the real-provider isolation/cleanup rerun + managed-secret rehearsal + real-TTL enforcement + the *verified* limit/capability matrix run only when the operator supplies `E2B_API_KEY` and dispatches `keyed-e2b-conformance.yml`. Authored + parse-verified, never faked.
2. **Positive-budget command timeout** is enforced by real E2B's own `timeoutMs` (the driver owns only the zero-budget verdict); the keyed lane exercises real TTL/positive-budget termination.
3. **Not the networked worker→provider transport** (deferred, reconciled with E6-F003/DEP-002), **not CLI-004** (real-E2B cleanup reconciliation), **not CLI-006** (live tenant canary). CLI-001 co-owns CM-010/CM-012 (not sole) and owns no `DE-*`.

## Operator action to run the real-E2B lane

1. Add **`E2B_API_KEY`** to the repository's GitHub Actions **secrets** (never pasted into chat or a file).
2. Have an **E2B template id** ready (E2B `base` works absent a custom template).
3. Dispatch **`keyed-e2b-conformance.yml`** (`workflow_dispatch`), passing the template id — it runs the real-provider conformance + managed-secret rehearsal against real E2B.

## Gate recommendation

`ready for independent review` — the no-key core is green (both suites vs the honest driver, boundary 33/33, MEDIUM re-proven RED→GREEN); the real-E2B lane is authored and runnable on operator dispatch.

## Review attempt history

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
| 1 | Claude adversarial-review Workflow (24 agents) + controller | implementer working tree | `approved after fixes` | 18 raw → 3 confirmed (all mock-fidelity/labeling, none blocking): MEDIUM deadline-verdict-mock-authored (fixed, driver-owned, RED→GREEN) + 2 LOW (pagination ordering driver-owned; mislabeled characterization test relabeled); core clean (denial classes, redaction/CAV-002, credential neutrality, cleanup, lint, crosswalk); suite 21 pass + 9 keyed-skip; boundary 33/33 |
