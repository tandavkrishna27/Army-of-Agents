# E2 pre-existing-failure baseline

**Status:** ADVISORY SEED — not the authoritative gate baseline.
**Epic:** `E2-tenant-kernel`
**Frozen Start SHA (E2 base):** `df509b946c5b5342c3aba4ae2bcab28a7aad835d`
**Observation revision:** `acf2b32fba480aa5d440e9606e20c3b542544d5d` (gate HEAD). Every failing
file below is **byte-unchanged** between the Start SHA and the observation revision
(`git log df509b946..HEAD -- <file>` = 0 commits for each), so the observations hold at the
frozen Start SHA.
**Environment:** Windows 11, local, embedded-Postgres (`embedded-postgres@18.1.0-beta.16`,
PG 18.1), `vitest@3.2.6`, `node v24.14.0`, `pnpm 9.15.4`, workspace packages built
(`pnpm -r build` run first). Per DEC-03 this Windows-local capture is an **advisory seed only**;
the **Linux CI lanes (`pr.yml`) are the formal authority**.
**References:** E0 advisory seed
[`../../E0-foundation/qa/pre-existing-failure-baseline.md`](../../E0-foundation/qa/pre-existing-failure-baseline.md);
`test-gates.md` DEC-03 / DEC-01 / D0-R01; finding
[`../findings.md` E2-F009](../findings.md).
**Consumed by:** the E2 integration gate (§4 of the E2 implementation plan) and the QA record
`2026-08-09-d0-e2-tenant-kernel-acf2b32fba48-a1.md`.

> This file is immutable/append-only. A correction or later capture creates a superseding
> attributed row/record under the `Supersedes` rule; the earlier content remains unchanged.

## What this file is

`test-gates.md` DEC-03 lets the E2 integration gate treat a REQUIRED repository-suite failure
(`pnpm -r typecheck`, `pnpm test:run`, `pnpm -r build`) as waivable **only** when its test id
appears here **and** it touches no E2-changed file. A failure that is new since the baseline SHA,
or that lands in an E2-touched file, is a regression and is always `fail`. Every E2-changed /
epic-touched file must be GREEN (NOT baseline-waivable).

## Independent gate observations at the observation revision

Full D0 rollup (Windows-local, workspace packages built first per D0-R01):

| Command | Exit | Result |
|---|---:|---|
| `pnpm -r typecheck` | `0` | Clean. Zero `error TS`. Server typecheck `Done`. |
| `pnpm -r build` | `0` | Clean. `@armyofagents/db` build `Done`; `@armyofagents/server` build clean; root `pnpm build` (= `pnpm -r build`) `0`, worktree byte-clean before/after, `git diff --check` clean. |
| `pnpm test:run` | `1` | **Test Files: 1 failed / 2004 passed / 116 skipped (2121).** **Tests: 18795 passed / 662 skipped (19457) — zero failed test bodies.** The single failed *file* is the row below. |

**Zero E2-changed file** (the 125 non-docs basenames in `df509b946..HEAD`: the `tenant_*`
schema modules, `packages/db/src/repositories/tenant/`, `client.ts`, migrations `0207-0212`,
`server/src/db/rls-tenant.ts` / `tenant-context.ts` / `with-tenant-tx.ts`, `services/companies.ts`,
`company-portability.ts`, `tenant-admission.ts`, `routes/companies.ts`, `testing/tenant-graph.ts`,
and every `tenant-*` / `sentinel-*` / `company-writer-*` test) appears in any failure or typecheck
error — grep-confirmed against the retained `typecheck.log` (0 hits) and `testrun.log` (only the
non-E2 file below).

## Baseline failing rows (Windows-local seed)

| # | Test id / file | Lane | SHA observed | Cause | Attribution |
|---|---|---|---|---|---|
| B1 | `packages/worker-protocol/src/cross-version.test.ts` | root `pnpm test:run` (and the `@armyofagents/worker-protocol` package config) | `acf2b32fba48` (byte-identical to Start SHA `df509b946`) | vitest's transform raises `SyntaxError: Invalid or unexpected token` while **collecting** the file (it imports the 239,198-byte committed frozen-consumer bundle `tests/fixtures/worker-protocol-consumers/v1/dist/index.js` and `scripts/check-frozen-worker-protocol-consumer.mjs`). Both modules parse cleanly under Node (`node --check` OK; direct `import()` OK), so the test **logic** is intact — this is a **vitest/Windows transform harness artifact**, not a product/logic failure. The other 16 worker-protocol files (490 tests) pass. | **E1 worker-protocol** frozen fixture (E1's package). Non-E2-touched (0 `packages/worker-protocol/**` files in the E2 diff; the test, fixture, script, and root `vitest.config.ts` all show 0 commits in `df509b946..HEAD`). Pre-existing at the Start SHA. `unattributed` on Linux — expected GREEN on Linux CI (E1's own gate proved cross-version `53/53`); confirm on Linux CI. |

## Note on E2-F009 (plugin-sdk) — corrected against disk

Finding E2-F009 states `@armyofagents/plugin-sdk` is **absent** on the branch (`packages/plugin-sdk`
does not exist), causing `pnpm --filter @armyofagents/server typecheck`/`build` to fail (~66 errors)
and two server test files to fail-to-collect. **Independent verification at this Start SHA / HEAD
corrects the premise:**

- `@armyofagents/plugin-sdk@1.0.0` **is present** as a workspace package at **`packages/plugins/sdk`**
  (matched by the `packages/plugins/*` workspace glob), tracked in git, **present at the Start SHA
  `df509b946`** and unchanged during E2.
- Its `dist/` is a **gitignored build artifact**. The `~66-error` isolated failure reproduces
  **only** when that dist is unbuilt: `pnpm --filter @armyofagents/server typecheck` in isolation.
  Once the dist is built — which the D0-R01 rollup guarantees ("Workspace packages are built before
  the suite") — the isolated `--filter server typecheck` also passes (independently reproduced:
  exit 0, 0 errors). So this is a **build-ordering setup artifact**, exactly the D0-R01 case, **not
  a residual gate failure**.
- The `pnpm -r typecheck` and `pnpm -r build` gate lanes build the SDK in topological order and
  **pass clean** (exit 0).
- The **two** files E2-F009 predicted would fail-to-collect —
  `server/src/__tests__/company-plugin-upgrade-rollback.test.ts` (9 tests) and
  `server/src/__tests__/company-portability-preview-export.test.ts` (22 tests) — **both PASS** at
  the observation revision.

**Net:** at this revision the plugin-sdk condition contributes **no** residual failure to the D0
rollup; the only residual `test:run` failure is row **B1** (E1 worker-protocol, non-E2-touched).
The E2-F009 finding's operative caveat (build packages before the isolated `--filter` command)
remains true; its "package absent" characterization does not.

## How to finalize (Linux CI = formal authority)

1. On the Linux CI lanes (`pr.yml`) at the Start SHA, run `pnpm -r build` → `pnpm -r typecheck`
   → `pnpm test:run` with a datastore provisioned. Expect B1 to be GREEN on Linux (Node parses
   the fixture cleanly; the transform artifact is Windows-vitest-specific) and the plugin-sdk
   condition absent (packages built).
2. Replace this seed's table with the Linux-CI failure set (expected empty or a strict subset),
   each row carrying a tracked-issue id or `unattributed` with a one-line cause.
3. Commit as the immutable Linux baseline; later changes use a superseding row (`Supersedes`).

Do NOT waive any row on the strength of this seed alone.
