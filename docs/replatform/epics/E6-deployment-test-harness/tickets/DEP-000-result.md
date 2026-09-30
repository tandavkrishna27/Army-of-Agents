# DEP-000 Result — Provider-neutral fake sandbox provider + conformance suite

**Status:** `complete`
**Disposition:** `pass` (with E6-F008 reconciliation escalated to CLI-001/D2; does not block E6-D1-FOUNDATION)
**Date opened (UTC):** `2026-08-13`
**Epic:** `E6-deployment-test-harness` (partial: `E6-D1-FOUNDATION`)
**Plan task:** `DEP-000 — Provider-neutral fake sandbox provider (E6 §2.1)`
**Implementer:** `Claude subagent (opus) — worktree C:\e3`
**Reviewer:** `Claude adversarial-review Workflow (4 dimensions → dedup → refute-by-default verify; 16 agents) + fix-round verification`
**Start SHA:** `3d8719faf` (WRK-004 commit)

## Acceptance model

The multi-agent adversarial-review Workflow is the independent check. It returned **7 confirmed
findings (0 blocking, 4 should-fix, 3 nit)**; all are resolved below (one via escalation).
Note: the E6-D1-FOUNDATION Docker/compose CI evidence (E6F-00..08) is Linux-only and is currently
**blocked by a GitHub Actions billing/spending-limit outage on the org** (PR #322 has the gate
queued; jobs cannot start). DEP-000 itself is pure TypeScript and fully Windows-local-verified.

## Dependency and scope state

- Two new leaf packages `@armyofagents/sandbox-fake-provider` (fake driver + fixture runtime +
  invocation ledger + loopback control server) and `@armyofagents/sandbox-provider-contract`
  (parameterized provider-neutral conformance suite). Runtime deps of both = EXACTLY
  `@armyofagents/worker-protocol` + `zod` + Node built-ins. A boundary checker
  (`scripts/check-sandbox-fake-provider-boundary.mjs` + lib + 47-test corpus, wired into the
  `policy` job) statically rejects `@armyofagents/server|db`, `drizzle-orm`, tenant modules,
  `@armyofagents/worker-daemon`, and the sibling sandbox package.
- Provider-neutral over the frozen `PROVIDER_OPERATIONS` vocabulary (no invented op). Consumes the
  FND-004 golden-journey fixtures + `scripts/check-distributed-execution-foundation.mjs` (kept
  green); frozen `packages/worker-protocol` untouched.
- The fake: loopback HTTP control plane (`POST /script` loads+validates a fixture by providerId,
  `POST /reset`, `GET /invocations` append-only ledger) + a driver addressed by providerId;
  fixture-driven scripting with fault injection at each lifecycle checkpoint; events emit a
  recomputed `eventDigest` (byte-identical replays); `reset`/`reconcile_cleanup` yield zero live
  resources (E6F-02).

## Independent adversarial review + fix round (7 confirmed, all resolved)

- **[1] SHOULD-FIX — contract port is provider-neutral, NOT WRK-004's authoritative
  `SandboxProvider`.** The `SandboxProviderDriver` (single `invoke(op,args)`) is structurally
  distinct from worker-daemon's per-op `SandboxProvider`; the boundary forbids linking them. This
  improvised past the plan §0 STOP. **Resolved (proportionate):** corrected the misleading
  "satisfies this shape" comment in `port.ts`; escalated the reconciliation (shared-leaf
  relocation or a tested adapter) as **E6-F008**, to resolve before **CLI-001/D2** real-provider
  conformance (explicitly out of E6-D1-FOUNDATION scope; the harness is self-consistent for
  deterministic fixture replay against the fake).
- **[2]/[3]/[6] SHOULD-FIX/NIT — hardcoded golden-journey corpus, no anti-drift guard.** An added
  fixture would silently escape coverage. **Fixed:** `corpus-drift.test.ts` `readdir`s the fixtures
  dir (minus `schema-v1.json`) and asserts set-equality with `GOLDEN_JOURNEY_FIXTURES` — fails
  closed on addition/rename/removal (proven RED via a probe fixture + a rename).
- **[4] SHOULD-FIX — DEP-000 + worker-daemon suites not in root vitest `projects`, so CI `verify`
  never ran them.** A latent gap across all E4 work. **Fixed:** added `packages/worker-daemon`,
  `packages/sandbox-fake-provider`, `packages/sandbox-provider-contract` to `vitest.config.ts`;
  the multi-project run now discovers all three (**53 files / 214 tests**).
- **[5] NIT — `UnsupportedProviderOperation` field mismatch** (`.op` vs worker-daemon's
  `.operation`). **Fixed:** aligned the DEP-000 error class + duck-type check to `.operation`
  (legacy `.op` still accepted on read).
- **[7] NIT — fake→port structural conformance not mechanically enforced** (test files excluded
  from tsc). **Fixed:** a type-only `port-conformance.test.ts` force-included via tsconfig `files`
  makes `tsc --noEmit` fail on any fake/port drift (proven: an injected mismatch reddened tsc).

## Operator-directed Windows-local evidence (from `C:\e3`; Linux CI = DEC-03 authority, billing-blocked)

| Lane | Result |
|---|---|
| root vitest `--project` worker-daemon + sandbox-fake-provider + sandbox-provider-contract | PASS — **53 files, 214/214** (wd 188 + fake 15 + contract 11) |
| `node scripts/check-sandbox-fake-provider-boundary.mjs` + `node --test …boundary.test.mjs` | PASS + 47/47 |
| `node scripts/check-distributed-execution-foundation.mjs` | PASS (stays green) |
| `tsc --noEmit` both DEP-000 packages (FIX 7 conformance enforced) | PASS — exit 0 |
| `pnpm check:frozen-worker-protocol-v1 -- --source-sha b7a842870…` | PASS — zero changed worker-protocol files |
| `pnpm install --frozen-lockfile` | PASS — no-op |

## Decision

DEP-000 is `complete` / `pass` for its E6-D1-FOUNDATION role (a deterministic, provider-neutral
fake + conformance suite for fixture-driven harness replay). The real-provider port reconciliation
is escalated as **E6-F008** (CLI-001/D2). Minor residual: the FIX-7 type-only conformance file
emits an inert near-empty `dist/__tests__/*.js` on `pnpm build` (type imports elided, no runtime
leak) — harmless for a `private` test-infra package. Next: **DEP-001** (separate signed
least-privilege images) — its Docker build/contents/startup smokes are **Linux/CI-only and blocked
on the GitHub Actions billing outage**; the pure image-admission logic is locally verifiable.
