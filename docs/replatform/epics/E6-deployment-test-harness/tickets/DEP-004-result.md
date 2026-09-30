# DEP-004 Result — Focused + merge-train CI lanes + static ci-lanes validator

**Status:** `complete` (static/local; live merge-train run = CI-deferred)
**Disposition:** `pass` (path-class routing + the non-vacuous ci-lanes validator locally verified; the live D1 merge-train bring-up is Docker/CI-only, billing-blocked)
**Date opened (UTC):** `2026-08-13`
**Epic:** `E6-deployment-test-harness` (partial: `E6-D1-FOUNDATION`)
**Plan task:** `DEP-004 — Focused and merge-train CI lanes (E6 §2.5)`
**Implementer:** `Claude subagent (opus) — worktree C:\e3`
**Reviewer:** `Claude adversarial-review Workflow (4 dimensions → dedup → refute-by-default verify; 9 agents) + fix-round verification`
**Start SHA:** `5ed94af50` (DEP-003 commit)

## Acceptance model + CI caveat

Adversarial-review Workflow = the independent check; **3 confirmed findings (0 blocking, 3
should-fix)**, all fixed. Crucially, the review confirmed the **actual CI routing is correct**
(no live silent-skip: the `ci-required` verdict shell does gate on `$R_DC`, and no path-class
glob gap was found); all 3 findings were about hardening the *validator* against future
regressions. The live D1 merge-train bring-up is Docker/CI-only (billing-blocked).

## Scope

- **`pr.yml` `changes` job** now emits `protocol/schema/fixtures/provider/compose` path-class
  outputs (in addition to `code`); push-to-main + empty-diff emit ALL classes true (fail-safe).
- **`distributed-contract` job** gated to run only when one of protocol/schema/fixtures/provider
  changed (draft-guarded), folded into the **`ci-required`** verdict — required **only when** its
  class changed (mirrors the `code`-gated `verify`/`e2e` docs-only-skip pattern). **No
  trigger-level `paths:`/`paths-ignore:`** anywhere (the footgun the design forbids); `ci-required`
  stays the sole branch-protection-required check.
- **`d1-merge-train.yml`** (`merge_group` + push-to-main): brings up `docker-compose.d1.yml`, runs
  a bounded E6F subset, and uploads the evidence bundle on failure.
- **Static validators:** `scripts/lib/ci-lanes.mjs` (`evaluateCiLanes`) + `scripts/check-ci-lanes.mjs`;
  `scripts/lib/d1-evidence-bundle.mjs` (`buildEvidenceBundle` → logs/events/dbState/objectManifests)
  + `scripts/collect-d1-evidence.mjs`. Deliberate-failing-fixture + evidence-retention test. No new
  deps.

## Independent adversarial review + fix round (3 confirmed, all fixed; routing correct)

- **SHOULD-FIX — the ci-lanes validator ran only in the merge-train, not on PRs.** Its
  no-trigger-paths guard (the load-bearing footgun check) executed only in `d1-merge-train.yml`
  (`merge_group`/push), so the "validated on every PR" claim was false. **Fixed:** added a
  `check-ci-lanes.mjs` + unit-test step to the always-on `policy` job in `pr.yml`; corrected the
  two comments.
- **SHOULD-FIX — the verdict-folding check accepted env-capture, not use.** It scanned the whole
  `ci-required` body, so a `needs.*.result` token in the `env:` block satisfied "folded into the
  verdict" even if the verdict shell never tested it — a future refactor dropping the
  `[ "$R_DC" = success ]` gate but keeping the `R_DC:` env line would pass the validator while a
  failed `distributed-contract` silently passed. **Fixed:** `parseCiRequiredVerdict` scopes
  detection to the `run:` block, requires each consumer var in a failure-capable shell test and
  each class var in the `contract_changed` computation. **Real-file proof:** deleting the `$R_DC`
  gate (keeping the env line) now makes `check-ci-lanes.mjs` exit 1 (previously passed). Negative
  fixture added.
- **SHOULD-FIX — the evidence-upload check matched any guarded `upload-artifact`.** **Fixed:**
  `uploadsEvidenceBundleOnFailure` requires the guarded upload to reference the evidence output
  (path under the evidence dir / name containing "evidence"). Negative fixture added.

## Operator-directed Windows-local evidence (from `C:\e3`; live merge-train run = Docker/CI, billing-blocked)

| Lane | Result |
|---|---|
| `node scripts/check-ci-lanes.mjs` (real `pr.yml` + `d1-merge-train.yml`) | PASS |
| `node --test scripts/lib/__tests__/{ci-lanes,d1-evidence-bundle}.test.mjs` | PASS — **25/25** (incl. 2 new negative fixtures) |
| real-file non-vacuousness (drop `$R_DC` gate → validator exits 1; restore → PASS) | PASS |
| `node --test tests/d1/evidence-retention.test.mjs` | PASS — 3/3 + 1 Docker-gated skip |
| `check-ci-lanes` now runs in the always-on `policy` job on every PR | PASS — step wired |
| both workflows parse as YAML; `changes`/`policy`/`ci-required` intact | PASS |
| `check-distributed-execution-foundation` + frozen-worker-protocol + `--frozen-lockfile` | PASS + no-op (no new deps) |
| **DEFERRED to CI** — live `d1-merge-train.yml` bring-up + deliberate-failing-fixture artifact-retention proof | not run (Docker/CI, billing-blocked) — honestly deferred |

## Decision

DEP-004 is `complete`/`pass` for its locally-verifiable surface: the path-class routing through
`ci-required` (no trigger-level paths, no silent-skip), the now-non-vacuous ci-lanes validator
(running on every PR), and the evidence bundle. Only the live merge-train run is DEFERRED
(Docker/CI). **This completes DEP-000..004** — the constituent tickets of the E6-D1-FOUNDATION
partial gate. Next: assemble the **E6-D1-FOUNDATION gate ledger**.
