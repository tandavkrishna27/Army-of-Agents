# v1-combined → main — pre-merge release evidence

**Date:** 2026-06-21
**Branch:** `feat/v1-combined`
**HEAD:** `a9046abea` (local == `origin/feat/v1-combined`, 0/0)
**Purpose:** Recorded green run substituting for CI, which is billing-blocked org-wide
(see CI status below). This is the evidence gate for a `combined → main` promotion.

## Verification gates — ALL GREEN

| Gate | Command | Result |
|------|---------|--------|
| Production build | `pnpm -r build` | ✅ exit 0 — db, shared, adapters, server, ui, cli |
| Server typecheck | `tsc --noEmit` | ✅ 0 errors |
| UI typecheck | `tsc -b` | ✅ 0 errors |
| Server suite (Windows) | `vitest run` | ✅ 726 files / **6340 passed, 0 fail** (24 files / 116 tests skipped = Windows-skipped integration + adapter) |
| UI suite | `vitest run` | ✅ 348 files / **2747 passed, 0 fail** |
| Docker-Linux integration | `vitest run integration --no-file-parallelism` (node user, embedded-postgres) | ✅ 33 files / **258 passed, 0 fail** (4 files / 8 tests self-skipped) |

Docker-Linux integration covers the real-Postgres race/lock tests Windows skips —
the gate where the historical "G4 Linux backlog" lived. Files include:
`checkout-race` (3, NEW — the atomic single-agent lock proof), `add-dependency-race` (4),
`thread-commit-idempotency` (34), `memory-version-race` (2), `quota-windows-dedup` (3),
`output-detection-confirm-race` (3), `link-entry-seq` (3), `artifact-add-version-parent` (4),
`aoa-backend` (2), `blocked-task-scan` (4), `crew-org-scope` (8), `environments` (6),
`companies-delete` (1), `agents-list-excludes-platform` (3).

## CI status — BLOCKED (infra, not code)

GitHub Actions is dark org-wide. Run `27912325848` (this HEAD) and every run since
2026-06-20 fail "not started" in <10s with the annotation:
> *"The job was not started because recent account payments have failed or your
> spending limit needs to be increased."*

Zero steps executed on any job (verify/e2e/policy/migrations/cross-platform).
**Resolution requires the MeteoriteLabs org owner** to restore billing at
github.com/organizations/MeteoriteLabs/settings/billing. Until then, this recorded
local + Docker-Linux run is the only available release gate.

## Merge topology

`combined → main` is **conflict-free**: combined is a strict content-superset of main.
main's only unique commit (`a2e24f91e`, the #166 ui-overhaul merge node) has both
parents already contained in combined and introduces zero file changes. combined is
1350 commits ahead. `feat/v1-upgrade` is a stale local-only ancestor of combined
(combined = upgrade + 503), not an intermediate stage.

## Known non-blockers (tracked for 1.1)

- **Dependency-tree audit findings:** `pnpm audit` reports ~72 prod-dep findings
  (1 critical, 26 high) — comparable to main's dependabot count, mostly transitive
  dev/build tooling (Vitest UI = the lone critical, Vite, esbuild, undici) that does
  not ship in the runtime, plus a few prod transitives (fast-xml-parser,
  path-to-regexp, picomatch, defu). A dep-bump sweep, present on both branches.
  Distinct from the application-level security issues (Workflow B), which ARE fixed.
- **Deferred test/CI quality** (gated on CI restore): actorMiddleware direct test,
  clamp-dispatch enforcement, authenticated-mode e2e, cross-platform matrix,
  CI-gate auditability (migrations job not in required set, no build-only Docker job).
- **Design/a11y:** DS-2 palette drift, onboarding-wizard a11y.

## Verdict

Code is release-ready by local + Docker-Linux evidence; the merge is technically
safe. The only gate gap is process: CI cannot run (billing) and `main` is unprotected.
Promotion decision is the founder's — either restore org billing so real CI gates the
merge, or accept this recorded run as the release evidence and merge on it.
