# E0 pre-existing-failure baseline

**Status:** ADVISORY SEED — not the authoritative gate baseline.
**Consumed by:** the E0 integration gate (Task 9) and `test-gates.md` DEC-03 / DEC-01 / D0-R01.

## What this file is

`test-gates.md` DEC-03 lets the E0 integration gate treat a REQUIRED repository-suite
failure as waivable **only** when its test id appears here **and** it touches no
E0-changed file. A failure that is new since the baseline SHA, or that lands in
E0-touched code, is a regression and is always `fail`. This is what makes the
full-suite gate satisfiable without weakening E0's "introduces no new failure"
guarantee.

## Authoritative capture is required before E0 Task 1 (this seed does not qualify)

This seed was captured on **Windows, local, from a bare `pnpm install --frozen-lockfile`
+ `pnpm test:run`** — with workspace packages NOT built and no datastore provisioned.
Per DEC-03 the authoritative baseline must be captured in the **same environment the
gate runs in**: the Linux CI lanes (`pr.yml`), with `pnpm -r build` run first and any
required datastore up. Replace this file's table with the Linux-CI capture at the
frozen Start SHA before E0 Task 1, keeping this header.

Do NOT waive any row below on the strength of this seed alone.

## Seed observation

- Observed on merged branch tip `f6b109d4` (`docs/replatform-program` after merging
  `origin/main`); the code under test equals `origin/main` `e097d2f9` because the docs
  branch adds no code, only files under `docs/`.
- Command: `pnpm install --frozen-lockfile` then `pnpm test:run` (root vitest).
- Result: **Test Files 23 failed | 1962 passed | 100 skipped (2085).** `TESTRUN_EXIT=1`.
- Every failure is a **setup artifact, not a code-logic regression** (see categories).
  On a properly set-up main (packages built, DB provisioned) the true pre-existing
  failure count is expected to be near zero.

## Failing files (Windows-local seed) — all `server/src/__tests__/`

| Test file | Category | Cause | Attribution |
|---|---|---|---|
| plugin-admin-authz.test.ts | plugin-sdk-unbuilt | `Failed to resolve entry for package "@armyofagents/plugin-sdk"` (no dist; `pnpm -r build` not run first) | setup — build packages first |
| plugin-telemetry.test.ts | plugin-sdk-unbuilt | same | setup — build packages first |
| plugin-tenant-routes.test.ts | plugin-sdk-unbuilt | same | setup — build packages first |
| sniffs-shell-command-fields.test.ts | plugin-sdk-unbuilt | same | setup — build packages first |
| tool-manifest.test.ts | plugin-sdk-unbuilt | same | setup — build packages first |
| mcp-connector-install.integration.test.ts | db-required | integration test; no DB provisioned (`db.insert is not a function` / `DB connection lost`) | setup — provision datastore |
| mcp-connector-oauth.integration.test.ts | db-required | same | setup — provision datastore |
| mt-four-actor-journey.integration.test.ts | db-required | same | setup — provision datastore |
| mt-import-authz.integration.test.ts | db-required | same | setup — provision datastore |
| output-detection-confirm-race.integration.test.ts | db-required | same | setup — provision datastore |
| plugin-broker-cloud.integration.test.ts | db-required | same (also plugin-sdk consumer) | setup — provision datastore + build packages |
| ask-founder-registry.test.ts | setup-likely | not individually confirmed; same run class (plugin-sdk/DB) | unattributed — confirm on Linux CI |
| bootstrap-ceo-cloud-auth.test.ts | setup-likely | same run class | unattributed — confirm on Linux CI |
| broker-internal-registry.test.ts | setup-likely | same run class | unattributed — confirm on Linux CI |
| cloud-auth-cutover.test.ts | setup-likely | same run class | unattributed — confirm on Linux CI |
| cloud-auth-no-instance-admin-minted.test.ts | setup-likely | same run class | unattributed — confirm on Linux CI |
| cloud-auth-promotion-paths-inert.test.ts | setup-likely | same run class | unattributed — confirm on Linux CI |
| company-plugin-upgrade-rollback.test.ts | setup-likely | same run class | unattributed — confirm on Linux CI |
| company-portability-preview-export.test.ts | setup-likely | same run class | unattributed — confirm on Linux CI |
| crew-skill-assignment-e2e.test.ts | setup-likely | same run class | unattributed — confirm on Linux CI |
| hub-autopilot-routes.test.ts | setup-likely | same run class | unattributed — confirm on Linux CI |
| onboarding-progress-route.test.ts | setup-likely | same run class | unattributed — confirm on Linux CI |
| plugin-worker-manager.test.ts | setup-likely | same run class (also an FND-006 characterization target) | unattributed — confirm on Linux CI |

## How to finalize (before E0 Task 1)

1. On Linux CI at the frozen Start SHA, run the gate order with packages built and DB up:
   `pnpm -r build` → `pnpm -r typecheck` → `pnpm test:run`.
2. Replace the table above with the real Linux-CI failure set. Expect it to be much
   smaller (or empty) once `plugin-sdk` is built and the DB is provisioned.
3. For each remaining row, set an attribution: a tracked issue id, or `unattributed`
   with a one-line cause. Unattributed rows are still waivable per DEC-03 but should be
   filed.
4. Commit as the immutable baseline; later changes use a superseding row (`Supersedes`).
