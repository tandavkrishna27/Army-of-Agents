# CLI-004 Result — E2B cleanup reconciliation

**Status:** `complete (no-key core) + keyed-lane authored` — the no-key core is green (worker-daemon + sandbox-e2b-provider suites); the real-E2B tagged-resource reconciliation cases ride the operator-dispatched `keyed-e2b-conformance.yml`.
**Disposition:** `pass` (scope-honest: in-process/mocked evidence for the no-key core; the real-infra rerun runs on operator key). **Fourth ticket of E7 — a Small composition ticket.**
**Date opened (UTC):** `2026-08-17`
**Epic:** `E7 — Coding/CLI workload on E2B`. **Plan task:** `CLI-004 (program-design.md:776-782)`.
**Implementer:** `Claude subagent (general-purpose) — worktree C:\e3`. **Reviewer:** `Claude adversarial-review Workflow (4 dimensions → refute-by-default verify, 19 agents) + controller re-verification + fix round`.
**Start SHA:** `2d2d879c9` (design-doc commit).

## Acceptance model + framing

A Small COMPOSITION ticket — the entire security core already existed (WRK-004 `CleanupAuthority`, `reconcile()`, CLI-001's E2B provider, the DEP-008 cleanup conformance). CLI-004 composes them against the E2B driver + adds the one genuine gap. Delivered:

- **No-key reconcile composition** (`sandbox-e2b-provider/src/__tests__/reconcile-composition.test.ts`) — runs the EXISTING `reconcile()` against `E2bSandboxProvider(MockE2bTransport)` seeded (through the driver's own `create`/`checkpoint`(pause)/`kill` ops) with a running (live-lease), a paused, and a leaked/stopped sandbox. Asserts attribution, orphan selection (the live-lease sandbox is NEVER touched), idempotent second pass (NotFound→success), the redacted list/inspect projection, cross-label/wrong-generation → uniform `ResourceNotAvailableError`, effect-op denial (`CleanupAuthorityDeniedError`), transient-outage (`cleanupStatus:"failed"` reported-not-thrown + counted + resource intact), and final zero-orphan — reusing the exported `CleanupAuthority`/errors, re-implementing nothing.
- **Minimal reconciliation-outage alert** (`worker-daemon/src/supervisor/reconcile.ts` — the one genuine gap): when a sweep records ≥1 failed cleanup, a structured `logger.error` `"reconcile_provider_outage"` fires carrying ONLY a SHA-256 `ownershipHash` + `orphansFailed`/`scanned` counts — never a raw org/target/worker id or secret byte — reusing the existing `CLEANUP_OUTCOME_METRIC{failed}`. Read-only after the sweep (does not alter convergence). So "provider outage backs off with an alert" holds; the backoff is the existing bounded retry + resource-survives-to-next-sweep (the live periodic delay is E4-D12).
- **Keyed real-E2B `describeKeyed` block** (`keyed-real-e2b.test.ts`, 4 cases, SKIP off `E2B_API_KEY`) — real leaked/tagged-resource reconciliation → real zero-resource; the real inspect-oracle guard (closing CLI-001-result.md `TODO(CLI-004)`); lost-response replay; cleanup-survives-rotation. No workflow changes.

## Findings (adversarial review — 19 agents, 14 raw → 1 LOW defect + 3 positive anti-vacuity attestations; the pagination concern REFUTED)

The review's #1 probe — the implementer's "mock-cursor artifact" deviation (a paginated sweep skipped a resource because `reconcile()` deleted an orphan mid-page and the mock's cursor keys on that id) — was **verified as a genuine mock artifact, not a reconcile defect**: real E2B uses stable/opaque cursors and reconciliation is convergent across repeated sweeps; a **mutation experiment** (disabling the live-lease guard `reconcile.ts:91` flips `orphansDestroyed` 2→3 and fails the composition test at `:100`) confirmed the assertions are load-bearing. The three "confirmed" positive attestations verified the composition is a real distributed-contract proof (imports + instantiates the EXISTING reconcile/CleanupAuthority over a real `E2bSandboxProvider`, only the transport doubled; live-lease survival positively proven; 5-key redaction strips real secrets the provider's own `inspect` still holds; the outage path is a REAL destroy-failure directive, not a mock shortcut).

- **LOW (test-completeness, fixed) — the outage-alert test pinned the `ownershipHash` shape + no-leak but not its DERIVATION.** A constant-hash regression (e.g. `"0".repeat(64)`) would have passed. **Fixed:** the test now asserts `ownershipHash` equals the actual SHA-256 of the canonical `(org, target, worker)` scope, so a constant-hash regression fails.

**No `mustFixBeforeLand`.** No `worker-protocol` / `SandboxProvider`-port / `DE-*` edits; no re-derived denial/redaction/convergence logic.

## Commands (verbatim, re-run by the controller)

| Command | Result |
|---|---|
| `…vitest run reconcile-outage-alert.test.ts` (post-fix, derivation pinned) | **2 passed** |
| `pnpm --filter @armyofagents/sandbox-e2b-provider test:run` | **32 passed + 18 keyed-skip** (incl. the D1 composition + 4 keyed CLI-004 cases) |
| `pnpm --filter @armyofagents/worker-daemon test:run` | **397 passed** (no regression; the alert is read-only after the sweep) |
| review mutation experiment: disable the live-lease guard (`reconcile.ts:91`) | composition test **FAILS** (`orphansDestroyed` 2→3) — assertions load-bearing |
| typecheck (both packages) + `check-worker-daemon-boundary.mjs` + `check-sandbox-e2b-provider-boundary.mjs` | clean + OK |
| `node --check` keyed cases | parse OK (SKIP off `E2B_API_KEY`; `e2b` dynamically imported) |
| `git status` | worker-daemon + provider edits + 2 new tests; NO `worker-protocol` / port / `DE-*` edits |

## Residual risk / scope-honesty

1. **Real-E2B validation is keyed-lane-only** — real tagged-resource reconciliation + inspect-oracle guard + lost-response replay + cleanup-survives-rotation + real zero-resource run on operator `E2B_API_KEY` dispatch.
2. **No live periodic reconciliation LOOP** — `reconcile()` is export-only + `startup-reconcile.ts` inert until E4-D12; CLI-004 certifies the orchestration against the E2B driver, not a running loop.
3. **`reconcile against active leases` uses the provider `hasLiveLease` view** (a documented scope choice) — full server-lease-set matching + durable enumeration (DAT-006 D5 gap) are deferred; the JOB-006 reaper is the server safety net.
4. **No new alert infrastructure** (a structured logger event + the existing metric); **no dormant-deadline wiring**; **no legacy `environment_leases` reconciliation** (CM-011); **no artifact quarantine** (a different concern).
5. **No frozen worker-protocol / `SandboxProvider`-port edit; no `DE-*` threat edit.**

## Operator action to run the real-E2B lane

Same as CLI-001/002/003: with `E2B_API_KEY` in repo secrets, dispatch `keyed-e2b-conformance.yml` (or bump `.github/keyed-e2b-trigger` on the branch) — it now also runs the CLI-004 real leaked-resource reconciliation + rotation + zero-resource cases.

## Gate recommendation

`ready for independent review` — the no-key core is green (provider + 397 worker-daemon), the one LOW pinned, the pagination concern refuted via a mutation experiment, and the real-infra rerun runnable on operator key.

## Review attempt history

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
| 1 | Claude adversarial-review Workflow (19 agents) + controller | implementer working tree | `approved after fix` | 14 raw → 1 LOW (outage-alert hash-derivation unpinned, fixed) + 3 positive anti-vacuity attestations; the "mock-cursor" pagination concern REFUTED via a mutation experiment; no `mustFixBeforeLand`; provider 32 + worker-daemon 397 green |
