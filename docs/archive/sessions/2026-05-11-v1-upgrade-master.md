# v1.0 Upgrade — Master Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each sub-plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land every decision from the 2026-05-11 Paperclip→AoA gap analysis (11 verified-real-bug fixes + 10 product decisions) on a single integration branch `v1-upgrade`, ship as v1.0.0 final.

**Architecture:** Long-lived integration branch off `workspace-fixes`. Each decision area gets its own sub-branch + PR merged into the integration branch. Final whole-suite regression on the integration branch before merging to mainline + tagging v1.0.0. Two cross-cutting subsystems (recovery service in v1.3 slot, execution-target abstraction + Tauri desktop in v2.0 slot) are foundational dependencies for several smaller features and must land before their dependents.

**Tech Stack:** Drizzle ORM (no raw SQL) | Vitest (server/UI/cli/packages projects) | Playwright (e2e + release-smoke) | Changesets (release) | embedded-postgres@18.1.0-beta.16 (test DB) | Tauri 2.x (desktop, v2.0 slice) | @aws-sdk/client-secrets-manager (D10) | pnpm 9.15.4 workspaces

**Reference docs:**
- Paperclip→AoA gap analysis output (this session, both pulls)
- `memory/project_v1_to_v2_roadmap.md` — locked decisions D1-D10
- `memory/feedback_aoa_user_model.md` — founding-team lens
- `CLAUDE.md` Critical Rules 1-10 (Drizzle ORM, naming, V2.5 spec)
- `AGENTS.md` §5-§11 (control plane invariants, lockfile rules, definition of done)
- `docs/architecture/decisions.md` (90+ locked architectural decisions)

---

## Scope

Everything in the 2026-05-11 v1→v2 roadmap collapses into one integration branch. Listed in merge-order (later items can depend on earlier ones; siblings in same row are parallel-safe).

### Phase A — Foundation (must land first)

1. **fix/v1-bug-batch** — 11 verified-real-bug fixes + 4 opportunistic cherry-picks. Self-contained. Detailed plan: `2026-05-11-v1-bug-batch.md`.

### Phase B — Team-grade governance & safety (parallel-safe)

2. **feat/v1-defaults** — D5 concurrency clamp 10→50 + D6 hire-approval mode split. Plan: `2026-05-11-v1-defaults.md` (TBW).
3. **feat/v1-planning-mode** — D8 `issues.work_mode` + UI + dispatch gate. Plan: `2026-05-11-v1-planning-mode.md` (TBW).
4. **feat/v1-routine-revisions** — D9 append-only revisions + 409-on-stale-base + line-diff + Restore + webhook secret rotation. Plan: `2026-05-11-v1-routine-revisions.md` (TBW).
5. **feat/v1-cheap-fallback** — D4 lightweight cheap-profile fallback (auto-Haiku at 80% budget). Plan: `2026-05-11-v1-cheap-fallback.md` (TBW).

### Phase C — Multi-human infrastructure (parallel-safe with each other; independent from Phase B)

6. **feat/v1-environments-lite** — D3 lightweight environments (env vars + connection target, local execution). Plan: `2026-05-11-v1-environments-lite.md` (TBW).
7. **feat/v1-secrets-vaults** — D10 AWS Secrets Manager + audit trail + UI. Plan: `2026-05-11-v1-secrets-vaults.md` (TBW).

### Phase D — Recovery automation (parallel-safe with Phase B/C; large port)

8. **feat/v1-recovery-service** — D1 recovery skeleton + D7 productivity reviews + max-turn retry (15eac43b) + handoff substrate (454edfe8) + monitors (57229d0f) + stale-queue cancellation (82e257c7 heartbeat half) + assigned-backlog liveness (e400315c recovery arm). Plan: `2026-05-11-v1-recovery-service.md` (TBW).

### Phase E — Cross-platform (depends on Phase A merge; sequential within)

9. **feat/v1-execution-target** — D2 abstraction. Port: `a4ac6ff1` sandbox-callback-bridge, `90631b09` adapter runtime command spec, `856c6cb1` workspace env shaping, `07606786` SSH bridge migration, `f6bad8f6` env sanitization, `a7b45938` shell defaults, `4cf612a9` parts 3+4, `12cb7b40` workspace-restore-merge, `50db8c01` POSIX mutex, `36eaf977` allowlist expansion. Plan: `2026-05-11-v1-execution-target.md` (TBW).
10. **feat/v1-environments-target-aware** — Make environments target-aware (D2 + D3 integration). Plan: `2026-05-11-v1-environments-upgrade.md` (TBW).
11. **feat/v1-tauri-desktop** — Tauri shell + Mac/Windows builds + auto-update. Plan: `2026-05-11-v1-tauri-desktop.md` (TBW).

### Phase F — Release

12. **chore/v1-regression-pass** — Final whole-suite regression on integration branch + Changesets release + tag v1.0.0.

---

## Branch topology

```
workspace-fixes  ◄── current
       │
       └── v1-upgrade  ◄── INTEGRATION BRANCH (NEW)
              ▲
              │ (sub-branch PRs merge UP into v1-upgrade)
              │
        ┌─────┼──────┬──────┬──────┬──────┬───────┬────────┬─────────┐
        │     │      │      │      │      │       │        │         │
   fix/  feat/  feat/  feat/  feat/  feat/   feat/   feat/    chore/
   v1-   v1-    v1-    v1-    v1-    v1-     v1-     v1-      v1-
   bug-  defaults plan-  rout- cheap- envs-  secrets recovery execution-target ...
   batch        mode   rev-   fall-  lite   -vaults service  + tauri-desktop
                       isions back
```

Each sub-branch:
- Branches from `v1-upgrade` (NOT from `workspace-fixes`) once `fix/v1-bug-batch` is merged.
- Self-contained with its own TDD plan doc in `docs/archive/sessions/`.
- Opens PR → `v1-upgrade` (NOT mainline).
- Required reviewer: `superpowers:requesting-code-review` subagent + green CI gate.
- Sub-branch is deleted after merge.

When all sub-branches are merged into `v1-upgrade`:
- Run the regression-pass plan (`2026-05-11-v1-regression-pass.md`).
- Open PR `v1-upgrade` → mainline.
- Tag `v1.0.0` from the merge commit.
- Cut a Changeset minor bump (`@armyofagents/*` major across the fixed-version family, but semver-wise this is a v1.0 first release).

---

## Cross-cutting concerns

### Lockfile policy (AGENTS.md §7)

Strict: `pnpm-lock.yaml` cannot be committed unless either:
- (a) The branch name is exactly `chore/refresh-lockfile`, OR
- (b) The PR also changes `package.json`, `pnpm-workspace.yaml`, `.npmrc`, or `pnpmfile.*`.

**Plan implication:** sub-branches that bump dependencies (`fix/v1-bug-batch` for drizzle-orm bump, `feat/v1-secrets-vaults` for `@aws-sdk/client-secrets-manager`, `feat/v1-tauri-desktop` for Tauri deps) MUST include the manifest changes in the same PR. The `refresh-lockfile.yml` bot will regenerate the lockfile on the `Porting1.1` branch — for `v1-upgrade`, manifest+lockfile changes ship together in the dep-bumping PR.

### Brand-check policy (pr.yml `brand-check` job)

9 grep-based guards. The 9 guards:
1. No `pcp_(invite|mcp|claim)_` token prefixes
2. No `paperclip.*-example` plugin keys
3. No `PAPERCLIP` ASCII banner
4. No user-visible "Paperclip <Word>" prose in shipping code (with allow-list)
5. `paperclip:` localStorage keys (allow-list: `lib/storage-migrations.ts`, migration tests, `ui/index.html`)
6. `[paperclip]` log prefix (allow-list: `normalize-transcript.ts` only)
7. No `paperclip-*` CSS classes (no allow-list — full rename required)
8. No quoted "Paperclip <Word>" prose in shipping code (allow-list documented in pr.yml)
9. `AOA_*` env-var doc completeness (catches docs drift)

**Plan implication:** every sub-branch that introduces new code must use AoA-prefixed names:
- New env vars: `AOA_WORKSPACE_*`, `AOA_FEEDBACK_*`, `AOA_TAURI_*`, etc.
- New log prefixes: `[aoa]` (NEVER `[paperclip]`)
- New CSS classes: `aoa-*` (NEVER `paperclip-*`)
- New localStorage keys: `aoa.*`
- New plugin keys: `aoa.*` or `aoa-*`
- New telemetry: extend `AOA_*` env-var doc allow-list as needed

### Migration policy (CLAUDE.md Critical Rule 1)

- Drizzle ORM only — `pnpm db:generate` is the ONLY way to author migrations.
- NEVER hand-edit migration SQL files. NEVER write raw SQL migrations.
- Schema definitions live in `packages/db/src/schema/<entity>.ts`.
- Migration numbering: latest is `0087_exotic_ogun.sql`. New migrations land sequentially starting at `0088`.

**Migration allocation across sub-branches:**
- `fix/v1-bug-batch` — no new migrations.
- `feat/v1-defaults` — no new migrations (config flag is in instance settings JSONB).
- `feat/v1-planning-mode` — 1 migration: `0088_*` add `issues.work_mode` enum.
- `feat/v1-routine-revisions` — 1 migration: `0089_*` add `routine_revisions` + `routines.latest_revision_id`.
- `feat/v1-cheap-fallback` — 1 migration: `0090_*` add `internal_agent_configs.cheap_model`.
- `feat/v1-environments-lite` — 1 migration: `0091_*` add `environments` table + agent/issue FK columns.
- `feat/v1-secrets-vaults` — 2 migrations: `0092_*` add `company_secret_provider_configs`, `0093_*` add `company_secret_bindings` + `secret_access_events`.
- `feat/v1-recovery-service` — 2 migrations: `0094_*` add `issue_monitors` (from `57229d0f`), `0095_*` add `issue_comments.author_type/presentation/metadata` (from `454edfe8`).
- `feat/v1-execution-target` — 0 migrations (foundational primitives only; storage stays in adapter config JSONB until v2.0 environments-target-aware).
- `feat/v1-environments-target-aware` — 1 migration: `0096_*` add `environments.target` column.
- `feat/v1-tauri-desktop` — 0 migrations.

**Sequencing constraint:** if a sub-branch ships with a migration, all earlier-numbered migrations must already be in `v1-upgrade`. Sub-branches with migrations are strictly ordered by migration number. Sub-branches without migrations can interleave freely.

**Parallel-development implication for migration-bearing sub-branches:** sub-branches that DO carry migrations must serialize at PR-merge time even if their implementation work proceeds in parallel:
- `feat/v1-planning-mode` (0088) merges before `feat/v1-routine-revisions` (0089) merges, which merges before `feat/v1-cheap-fallback` (0090), and so on.
- If a sub-branch's implementation is done but it's gated on an earlier-numbered migration that hasn't merged yet, run `pnpm db:generate` AGAIN against the latest `v1-upgrade` state to regenerate the migration with the correct sequential number before opening the PR. The drizzle snapshot diff will reconcile automatically.
- Non-migration-bearing sub-branches (bug-batch, defaults, execution-target, tauri-desktop, regression-pass) can merge in any order independent of the above.
- A practical sequence that maximizes parallelism while preserving migration order:
  1. `fix/v1-bug-batch` merges first (no migration; foundation).
  2. Five sub-branches start implementation in parallel: defaults, planning-mode, routine-revisions, cheap-fallback, recovery-service. Their PRs merge in migration order: planning-mode (0088) → routine-revisions (0089) → cheap-fallback (0090) → recovery-service (0094+0095). `defaults` (no migration) can merge anywhere.
  3. Phase C (`environments-lite` 0091, `secrets-vaults` 0092+0093) starts after Phase B's 0088-0090 are merged so that `pnpm db:generate` produces the right numbers.
  4. Phase E (`execution-target` 0-migration, `environments-target-aware` 0096, `tauri-desktop` 0-migration) starts after Phase C lands.
  5. `chore/v1-regression-pass` merges last.

### Test policy

Every sub-branch must pass before merging into `v1-upgrade`:
- `pnpm -r typecheck` (0 errors required)
- `pnpm test:run` (0 new failures vs. baseline; baseline-flake tests permitted to retry)
- `pnpm build` (0 errors required)

Per-sub-branch test coverage requirements:
- **New schema → at least 1 integration test using `embedded-postgres`**, using the standalone-test pattern from `server/src/__tests__/companies-delete-integration.test.ts`. AoA has **no shared TestServer harness** — each integration test inlines its own `beforeAll(ad-hoc embedded-pg boot + applyPendingMigrations + createDb)` setup (~50 LOC of boilerplate per test file). This is by-design for now; a shared harness is a Phase B candidate, not a v1.0 dependency.
- New service → at least 1 unit test (mock executor via Proxy stubs + `createSequenceDb`) AND 1 integration test (real embedded-pg).
- New route → at least 1 route test in `server/src/__tests__/<feature>-routes.test.ts` using the integration pattern above + supertest (or AoA's actual express-test pattern — verify against the existing routes test files).
- New UI component → at least 1 vitest test in `ui/src/__tests__/<Component>.test.tsx`. **No Storybook** (AoA dropped Storybook in `workspace-fixes`).
- New e2e flow → if user-facing flow changes, add 1 Playwright spec in `tests/e2e/` (8 specs currently; release-smoke is separate in `tests/release-smoke/`).
- New adapter capability → adapter test in `packages/adapters/<adapter>/src/server/__tests__/`.
- Migration → migration journal validation runs in CI (`migrations` job in pr.yml); no extra test needed.

**Release-smoke coverage:** the v1.0.0 release-smoke spec (`tests/release-smoke/docker-auth-onboarding.spec.ts`) currently exercises auth + onboarding step 1. v1.0 expands this to cover:
- Full 6-step onboarding wizard
- Discussions inbound + Workspace timeline render
- Routine manual-trigger → inbox visibility (Bug 9 + D8 sanity check)
- Secrets vault provider config (D10 sanity check)
- Planning mode badge render (D8 sanity check)

This expansion is part of `chore/v1-regression-pass`, not blocking individual sub-branches.

### Code review policy

Every sub-branch PR:
- Dispatches `superpowers:requesting-code-review` after implementation completes (per AGENTS.md §11 Definition of Done).
- Reviewer evaluates: spec coverage, no placeholders, no new brand-check regressions, drizzle-only migrations, no raw SQL, type consistency across db/shared/server/ui contracts.
- Reviewer findings either land as fixup commits in the sub-branch OR are deferred to a follow-up plan with explicit user sign-off.

### External setup (blocking-status per sub-branch)

Confirmed via Paperclip + AoA infrastructure investigation (2026-05-11):

**Not blocking v1.0 (Phases A–D):**
- **AWS Secrets Manager testing** — Paperclip has no AWS in CI; tests via mocks. D10 plan follows the same approach. **No external setup needed.**
- **GHCR signing (cosign)** — neither repo has setup. v1.0 ships unsigned GHCR images per current Phase H state. **Optional for v1.0.** Recommend as separate Phase I security follow-up.

**Blocking for v2.0 Tauri sub-branch (Phase E #11) — start procurement NOW if you want signed installers in v1.0:**
- **Apple Developer account** — required for macOS notarization (lead time ~1 week for Apple Developer enrollment + identity verification). Without this, Mac installers can ship UNSIGNED but users will see "unidentified developer" warnings and need to right-click → Open.
- **Apple notarization credentials** (app-specific password or App Store Connect API key) — required to call `notarytool`. Setup time ~1 day once Apple Developer account is active.
- **Windows EV code-signing certificate** — required for signed `.msi` installers. Lead time ~3-5 business days from a CA (DigiCert, Sectigo). Without this, MSIs ship unsigned and users see SmartScreen warnings.

**Decision:** if procurement isn't started during Phase A, Phase E #11's Tauri sub-branch can still ship UNSIGNED installers for v1.0, with a v1.1 follow-up to add signing once credentials are available. The sub-plan for `feat/v1-tauri-desktop` should document this as a switch (`SIGN_INSTALLERS=false` in the Tauri build config).

### Definition of done (v1.0.0)

Per AGENTS.md §11, expanded for v1.0:

1. All 12 sub-branches merged into `v1-upgrade`.
2. `pnpm install --frozen-lockfile` clean on `v1-upgrade`.
3. `pnpm -r typecheck` — 0 errors across all 18 workspaces.
4. `pnpm test:run` — 0 new failures vs. v1.0.0-rc.4 baseline. Flake retries permitted on the documented baseline-flake set (routines-service drizzle-ESM, parallel-test flakes per memory).
5. `pnpm build` — 0 errors (server + ui + cli + plugin SDK + 5 adapters).
6. `pnpm test:e2e` — full e2e suite passes (8+ specs, ≥1 new spec from each Phase B/C/D sub-branch).
7. `pnpm test:release-smoke` — passes against a freshly-published Docker image.
8. Brand-check job — 0 violations.
9. Migrations job — journal/snapshot chain valid `0001..0096`.
10. Cross-platform matrix (macOS + Windows advisory) — green (or Issue #114 remains the only documented red).
11. Changeset minor-bump file present at `.changeset/v1-0-0.md` summarizing the release.
12. `docs/archive/sessions/2026-05-11-v1-upgrade-master.md` updated with closure notes.
13. CLAUDE.md version-status banner updated to `v1.0.0 (general availability)`.
14. PR `v1-upgrade → mainline` approved + merged.
15. Tag `v1.0.0` pushed to origin.

---

## Sequencing & timeline (subagent-driven velocity)

Calendar estimates assume subagent-driven-development with parallel sub-branches in flight. Multipliers reflect that AoA's Phase H, Phase I, Marketplace M.2/M.3a/M.3b each shipped in one session with implementer + reviewer + spec-reviewer subagents.

| Sub-branch | Sessions | Sequential or parallel | Notes |
|---|---|---|---|
| fix/v1-bug-batch | 3-5 | sequential (foundation) | Must land first. |
| feat/v1-defaults | 1 | parallel with 3-5 | Tiny — 2 days. |
| feat/v1-planning-mode | 3-5 | parallel with 4,5,6,7 | Migration + UI + dispatch gate. |
| feat/v1-routine-revisions | 4-6 | parallel with 3,5,6,7 | Schema + UI + line-diff lib + 409 logic. |
| feat/v1-cheap-fallback | 2-3 | parallel with 3,4,6,7 | Migration + fallback service. |
| feat/v1-environments-lite | 3-5 | parallel with 7 (after 3-5 land) | Migration + service + UI. |
| feat/v1-secrets-vaults | 6-10 | parallel with 6 (after 3-5 land) | Largest: AWS SigV4 + UI + audit + 2 migrations. |
| feat/v1-recovery-service | 8-12 | parallel with all Phase B/C | Massive: recovery/ subsystem + monitors + handoff substrate. |
| feat/v1-execution-target | 6-10 | sequential after Phase A | Foundational primitives + sandbox-docker target. |
| feat/v1-environments-target-aware | 2-3 | sequential after 9 | Bridge two prior. |
| feat/v1-tauri-desktop | 5-8 | sequential after 9 | Mac + Windows builds + installer. |
| chore/v1-regression-pass | 2-3 | sequential after all | Final regression + tag + ship. |

**Total session estimate:** ~46-72 sessions (parallel where possible compresses calendar time to ~3-5 weeks).

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Drizzle 0.38→0.45 surfaces breaking API drift | medium | high | Bug 2 lands FIRST after bug-batch core; full test suite must pass before any sub-branch with new schema starts. |
| Brand-check regressions block PRs | medium | medium | Each sub-branch's plan includes a brand-check pre-flight (grep the 9 patterns before opening PR). |
| Migration ordering conflicts when parallel sub-branches both add migrations | high | medium | Strict numbering allocation above (B sub-branches get 0088-0090; C gets 0091-0093; D gets 0094-0095). Sub-branches merge in numerical order — last sub-branch with a migration may need to `pnpm db:generate` against the most-current state. |
| `inboxDismissals` vs `issueInboxArchives` schema divergence breaks Bug 9 port | confirmed | medium | Bug 9 plan uses AoA's `inboxDismissals` with `itemKey="issue:<id>"` format (not paperclip's `issueInboxArchives`). Plan documents this explicitly. |
| Windows e2e remains skipped (Issue #114, embedded-postgres) | confirmed | low | Documented in v1.0 release notes; not a v1.0 blocker. Fix planned as separate Issue. |
| Recovery service port introduces cost-runaway via auto-retry | medium | high | D1 plan includes per-recovery-action budget check; productivity-review LLM calls use the cheap profile from D4 (lands first). |
| Tauri Mac/Windows builds need code-signing certs not yet acquired | medium | medium | v2.0 Tauri sub-branch can ship unsigned for v1.0; signed installers in v1.1 if cert acquisition slips. |
| `pnpm test:run` 5,094 cases on single worker exceeds 20-min CI timeout as suite grows | medium | low | Phase E plan adds vitest sharding (paperclip pattern: 4-shard matrix). |
| AoA's `deriveAuthTrustedOrigins` is stricter than Paperclip (no http variant in authenticated mode) | confirmed | low | Bug 4 plan explicitly documents this as a decision point. Default: preserve AoA's stricter behavior. |
| `create-paperclip-plugin/` package directory not yet renamed | confirmed | low | Add to `fix/v1-bug-batch` cherry-pick set as a separate commit. |
| Paperclip ships drizzle-orm 0.46+ while AoA's v1-upgrade is mid-flight on 0.45.2 | low | medium | Pin AoA at 0.45.2 for v1.0 final. Defer further drizzle bumps to v1.1 polish batch. Watch Paperclip pulls but don't cherry-pick a 0.46 bump until v1.0 is shipped. |
| Recovery service port (Phase D) needs schema columns `livenessState`, `livenessReason`, `continuationAttempt`, `nextAction` on `heartbeat_runs` — pre-flight check that those columns exist | medium | medium | At the START of `feat/v1-recovery-service` work, `grep -n "livenessState\|livenessReason\|continuationAttempt\|nextAction" packages/db/src/schema/heartbeat_runs.ts`. If any are missing, add as Migration 0094 PRE-step (rename the planned monitors migration to 0095, system-notices to 0096, and target-aware envs slot to 0097). Document the cascade in the recovery sub-plan. |
| Subagent-driven development on long sub-branches accumulates merge debt vs. workspace-fixes | medium | low | Periodically rebase `v1-upgrade` against `workspace-fixes` (or whatever becomes mainline). When rebasing, only fast-forward sub-branches; if a sub-branch needs conflict resolution, halt and have a human review the conflict. |

---

## Self-review checklist

Before tagging v1.0.0, run this checklist:

**1. Spec coverage:** Each of the 10 decisions (D1-D10) + 11 bug fixes + cherries has a corresponding sub-branch merged. Listed and verified in this document.

**2. Brand-check pre-flight (run on `v1-upgrade` HEAD):**
```bash
cd $REPO && bash -c 'grep -rnE "\"pcp_(invite|mcp|claim)_|'\''pcp_(invite|mcp|claim)_" --include="*.ts" --include="*.tsx" --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build .'
```
Expected: 0 hits.

**3. Migration journal validation:**
```bash
cd $REPO && python scripts/verify-migration-journal.py
```
Expected: continuous chain `0001..0096`, no gaps, all SHA-256 hashes match.

**4. Verification triple (AGENTS.md §8):**
```bash
cd $REPO && pnpm -r typecheck && pnpm test:run && pnpm build
```
Expected: 0 errors. Test failures only on documented baseline-flake set.

**5. e2e (full):**
```bash
cd $REPO && pnpm test:e2e
```
Expected: all 8+ specs pass.

**6. Release-smoke (against fresh Docker image):**
```bash
cd $REPO && pnpm release:rollback --self-test && pnpm test:release-smoke
```
Expected: container boots, full wizard transition, all 5 expanded smoke flows pass.

---

## Execution handoff

This is the umbrella plan. The first sub-plan is `2026-05-11-v1-bug-batch.md`. Subsequent sub-plans (`2026-05-11-v1-defaults.md` … `2026-05-11-v1-regression-pass.md`) are written just-in-time before each sub-branch starts.

Execution choice for `fix/v1-bug-batch`:

**1. Subagent-Driven (recommended)** — Dispatch fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Confirm approach in the next session.
