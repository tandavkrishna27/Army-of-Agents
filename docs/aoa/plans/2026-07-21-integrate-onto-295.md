# Provider-Readiness → integrate onto main (#295) — Implementation Plan

> **For agentic workers:** this is a git INTEGRATION plan, not a feature-TDD plan. Execute phases in order. Every phase ends with a verification gate that must be green before the next. Steps use `- [ ]`.

**Goal:** Land the entire Provider-Readiness + Settings-UI branch on top of `origin/main` (which now contains #295's onboarding redesign + CLI-auth library), as a clean, squashed, enterprise-grade branch that is fully green (unit + integration + e2e), with #295's onboarding taken as-is and the waiver dropped.

**Architecture:** Rebuild-onto-#295, not a literal 64-commit rebase. Branch from `origin/main`; bring my 92 unique ("Bucket A") files over in ~8 logical commits; reconcile the 19 overlap files deliberately (take #295's for onboarding/classifier, union for barrels/app.ts/AgentConfigForm, regenerate migrations). This yields the same linear-on-#295 result a rebase+squash would, but each commit is built deliberately and completeness is diff-verifiable.

**Tech Stack:** pnpm workspaces, Drizzle ORM, Vitest, Playwright e2e, embedded Postgres, React/Vite UI, Express server.

**Refs:** MINE `feat/provider-readiness` @ `dff623e9d`. BASE `origin/main` @ `c433464d9` (contains #295). Merge-base `a490fc57d`. **Backup:** `backup/provider-readiness-prerebase` @ `dff623e9d` (already created).

**Decisions locked (by the user):** drop the waiver; squash to ~8–10 logical commits; everything in one branch; enterprise-grade with full test coverage proving both sides (proactive Providers surface + reactive CLI-error-swallow fix). Onboarding false-green and the waiver gap are documented follow-ups, not fixed here. Login copy: neither branch is correct — the real command is `claude` (browser opens); fix copy to that.

---

## Phase 0 — Prep

- [ ] **0.1** Confirm clean start: `git -C C:/Users/TK/.aoa/wt/providers status --porcelain` empty, on `feat/provider-readiness`, backup exists (`git rev-parse backup/provider-readiness-prerebase` == `dff623e9d`).
- [ ] **0.2** Create the integration branch off #295:
```bash
git checkout -b integrate/provider-readiness origin/main
```
- [ ] **0.3** Record the Bucket-A file list for the completeness check later:
```bash
git diff --name-only a490fc57d feat/provider-readiness | grep -v "migrations/meta" | sort -u > /tmp/mine.txt
comm -12 /tmp/mine.txt <(git diff --name-only a490fc57d origin/main | sort) | grep -v "migrations/meta" | sort > /tmp/overlap.txt
comm -23 /tmp/mine.txt /tmp/overlap.txt > /tmp/bucketA.txt   # 92 files to bring over
wc -l /tmp/bucketA.txt   # expect ~92
```

---

## Phase 1 — Bring over Bucket A (the clean, unique work) as logical commits

Each group: `git checkout feat/provider-readiness -- <files>`, then commit. These files do NOT overlap #295, so they apply cleanly. **Do NOT checkout whole directories that also contain overlap files** (schema/, server/src/services/, ui/src/onboarding/) — checkout the specific Bucket-A files.

- [ ] **1.1 — Commander runtime CLI-error-swallow fix** (the reactive side)
```bash
git checkout feat/provider-readiness -- \
  server/src/services/internal-agent/cli-mode.ts \
  server/src/services/internal-agent/parse-stream-json.ts \
  server/src/__tests__/commander-cli-mode-*.test.ts server/src/__tests__/parse-stream-json*.test.ts 2>/dev/null
git add -A && git commit -m "fix(commander): surface CLI errors instead of empty turns; terminate on close"
```
(If a test path glob matches nothing, drop it — verify with `git status` before commit.)

- [ ] **1.2 — Readiness data model + shared provider primitives**
```bash
git checkout feat/provider-readiness -- \
  packages/db/src/schema/provider_readiness_status.ts \
  packages/db/src/schema/__tests__/provider_readiness_status*.test.ts 2>/dev/null \
  packages/shared/src/probe-outcome.ts \
  packages/shared/src/adapter-probe.ts \
  packages/shared/src/providers/provider-catalog.ts \
  packages/shared/src/providers/__tests__/provider-catalog.test.ts
git add -A && git commit -m "feat(providers): readiness data model + shared provider catalog/primitives"
```

- [ ] **1.3 — Providers backend (service + routes + key layer)**
```bash
git checkout feat/provider-readiness -- \
  server/src/services/providers/ \
  server/src/routes/providers.ts \
  server/src/services/secrets.ts \
  server/src/services/commander-login-runtime.ts \
  server/src/routes/commander-verify.ts \
  server/src/__tests__/commander-verify-route.test.ts \
  server/src/__tests__/commander-login-route.test.ts \
  server/src/__tests__/commander-probe-config.test.ts \
  server/src/__tests__/providers-*.test.ts 2>/dev/null
git add -A && git commit -m "feat(providers): readiness/key/login service layer + routes"
```
NOTE: `server/src/services/providers/` here brings ONLY my new files (classify-probe, provider-key, provider-login, readiness) — `git checkout` of a dir adds files that exist on my branch; pre-existing files in that dir on #295 are unaffected unless I also changed them (I didn't). Verify: `git status` shows only the 4 new files staged, no deletions.

- [ ] **1.4 — Providers + Settings UI (two-pane, cards, sections)**
```bash
git checkout feat/provider-readiness -- \
  ui/src/components/providers/ \
  ui/src/components/settings/ \
  ui/src/api/providers.ts \
  ui/src/lib/queryKeys.ts
git add -A && git commit -m "feat(providers): Settings->Providers two-pane UI + shared SettingsCard"
```
`queryKeys.ts` is Bucket A (my `providers` key is additive; verify no conflict — if #295 also edited it, it'll be in /tmp/overlap.txt; it is NOT, so clean).

- [ ] **1.5 — Settings UI wave (GitHub cards, Inbox settings section, gear removal, Inbox panel)**
```bash
git checkout feat/provider-readiness -- \
  ui/src/components/GitHubIntegrationCard.tsx \
  ui/src/components/hub/HubShell.tsx \
  ui/src/pages/InboxHub.tsx \
  ui/src/components/inbox/ \
  ui/src/__tests__/GitHubIntegrationCard.test.tsx \
  ui/src/__tests__/SettingsPage-redesign.test.tsx
git add -A && git commit -m "feat(settings): GitHub status-strip+cards, Inbox settings section, card layouts"
```

- [ ] **1.6 — Secrets UI + remaining Bucket-A leftovers**
```bash
git checkout feat/provider-readiness -- ui/src/components/secrets/ 2>/dev/null
# Sweep any Bucket-A file not yet brought over:
comm -23 <(sort /tmp/bucketA.txt) <(git diff --name-only origin/main | sort) > /tmp/missing.txt
cat /tmp/missing.txt   # files in Bucket A not yet on the branch — inspect each
# For each remaining pure-mine file, checkout + stage. Then:
git add -A && git commit -m "feat(providers): secrets UI + remaining provider-readiness files"
```

---

## Phase 2 — Reconcile the 19 overlap files (deliberate)

For each: the exact resolution. `theirs` = #295's version already on the branch (do nothing / keep). `mine+theirs` = merge both regions.

- [ ] **2.1 — Onboarding: keep #295's entirely (drop my superseded work).** These are already #295's on the integration branch — do NOTHING (do not checkout mine):
  `ui/src/onboarding/steps/VerifyStep.tsx` (+test), `ui/src/onboarding/FlowEngine.tsx` (+test), `server/src/routes/onboarding.ts`, `server/src/services/onboarding.ts`, `ui/src/api/onboarding.ts`, `ui/src/api/__tests__/onboarding-routing.test.ts`.
- [ ] **2.2 — Classifier: keep #295's `commander-verify.ts`.** My Providers uses `classify-probe.ts` (brought in 1.3), which is independent. Keep #295's `server/src/services/commander-verify.ts` + `server/src/__tests__/commander-verify.test.ts` — do nothing.
- [ ] **2.3 — Drop the waiver residue.** `onboarding_progress.ts` is #295's (no `waivedStates`) — keep it. Confirm no `waivedStates` / `onboarding-waiver.test.ts` exist on the branch:
```bash
git grep -l "waivedStates\|onboarding-waiver" || echo "waiver fully absent — good"
```
If `server/src/__tests__/onboarding-waiver.test.ts` somehow got carried in, `git rm` it.
- [ ] **2.4 — `packages/adapters/claude-local/src/server/test.ts`: keep #295's superset, fix login copy.** Keep #295's version (it emits `claude_hello_probe_auth_expired`/`_auth_required` — the codes my classifier consumes). Then grep for wrong login copy and fix to the docs-correct form:
```bash
git grep -nE "claude auth login|claude login" -- '*.ts' '*.tsx' | cat
```
For each user-facing hint, replace the wrong command with the correct instruction: **"run `claude` in a terminal (a browser window opens to sign in)"** — NOT `claude login` and NOT `claude auth login`. Leave #295's non-interactive `CLAUDE_AUTH_STATUS_ARGS` probe machinery untouched.
- [ ] **2.5 — Barrels: add my exports (union).**
  - `packages/db/src/schema/index.ts`: ensure it exports `provider_readiness_status` (mine) AND #295's `braindumpCaptures` etc. Edit to include both.
  - `packages/shared/src/index.ts`: ensure my `probe-outcome`/`adapter-probe`/`providers/provider-catalog` re-exports are present alongside #295's.
- [ ] **2.6 — `server/src/app.ts`: union route mounts.** Keep #295's route registrations AND add my `/companies/:companyId/providers` mount (+ any commander-verify/login mounts my routes need). Verify the providers router import + `app.use(...)` line are present.
- [ ] **2.7 — `AgentConfigForm.tsx`: merge my readiness-badge region into #295's.** #295 added brain/librarian (+126); I added the agent readiness badge (+17). Open both versions; splice my `AgentReadinessBadge` import + its render block into #295's current file. Keep #295's brain/librarian additions.
- [ ] **2.8 — `commander-login.ts` service+route.** My provider-login generalization (`8348baca9`) layered on functions #295 also extended. Reconcile: keep #295's auth/login additions; re-apply my generalization (the `resolveRunnerLogin`/provider-scoping) on top. Read both, merge region-by-region. If my generalization is fully superseded by #295's `adapter-utils` login layer, drop it and note in the PR.

---

## Phase 3 — Migrations: regenerate cleanly

My `0174_clammy` (provider_readiness_status) and `0175_shallow` (waiver) collide with #295's `0174/0175/0176`. Drop both, regenerate provider_readiness_status at the next number.

- [ ] **3.1** Confirm my old migration SQL files did NOT come over (they shouldn't — not in a Bucket-A checkout group). If present, remove:
```bash
rm -f packages/db/src/migrations/0174_clammy_professor_monster.sql packages/db/src/migrations/0175_shallow_stardust.sql
```
- [ ] **3.2** The schema now has `provider_readiness_status` (from 1.2) but no migration for it. Regenerate:
```bash
pnpm --filter @armyofagents/db db:generate
```
Expect a new `0177_*.sql` creating `provider_readiness_status` (waiver column absent — good). Journal + snapshot update automatically.
- [ ] **3.3** Hand-add idempotency guards per repo convention: `CREATE TABLE IF NOT EXISTS`, and wrap any `ADD CONSTRAINT` in `DO $$ … EXCEPTION WHEN duplicate_object`. Model on an existing migration.
- [ ] **3.4 Gate:** `pnpm vitest run server/src/__tests__/migration-idempotency.test.ts` → PASS.

---

## Phase 4 — Full local verification gate (must ALL be green; iterate until so)

- [ ] **4.1** `pnpm -r typecheck` → clean. Fix any reconcile type errors (missing imports from barrels, AgentConfigForm splice, app.ts).
- [ ] **4.2** `pnpm vitest run ui` → all pass (expect ~3873 + any onboarding tests now #295's). Fix UI reconcile fallout.
- [ ] **4.3** `pnpm vitest run server` → all pass except the known pre-existing `discussions-routes-contract` load-flake (verify in isolation). Fix any provider/commander reconcile fallout.
- [ ] **4.4 Integration tests** (embedded PG): `pnpm vitest run server -t "integration"` on Windows (`initdbFlags` per repo). Confirm provider/readiness + commander integration paths pass.
- [ ] **4.5 Prove the classifier↔emitter connection (the key reconcile claim):** write/run a focused server test asserting `classifyProbeOutcome` maps #295's emitted `claude_hello_probe_auth_expired` / `_auth_required` codes to `needs_auth`. If none exists, add one. This is the load-bearing "complementary layers" proof — do NOT skip.
- [ ] **4.6** `pnpm build` → clean.
- [ ] **4.7 e2e (Windows):** `AOA_E2E_FORCE_WINDOWS=1 pnpm test:e2e -- tests/e2e/providers-readiness.spec.ts` → 9/9 executed. Then the onboarding e2e (`onboarding*.spec.ts`) → confirm #295's onboarding still passes (proves reconcile didn't break it). Report executed vs skipped honestly.
- [ ] **4.8 brand-check:** run the brand-check policy check the CI `policy` job runs (`git grep` for undocumented `AOA_*` in server/src, per repo). Clean.
- [ ] **4.9 Live boot both sides:** boot the instance (initiative runbook), click through Settings→Providers / Inbox / GitHub (proactive side), and confirm a Commander CLI error now surfaces instead of an empty turn (reactive side). Screenshot/log proof.

---

## Phase 5 — Completeness + history

- [ ] **5.1 Completeness check** — nothing from Bucket A got lost:
```bash
# Every Bucket-A file's content on the integration branch must match feat/provider-readiness:
while read f; do git diff --quiet feat/provider-readiness -- "$f" || echo "DIFFERS: $f"; done < /tmp/bucketA.txt
```
Investigate every `DIFFERS` line (some are expected — files I intentionally reconciled; a Bucket-A file differing is a RED FLAG of a missed bring-over). Resolve.
- [ ] **5.2 History** — the ~8 logical commits from Phases 1–3 already ARE the squashed history. If reconcile produced extra fixup commits, `git rebase -i origin/main` to fold them into the right logical commit. Target: ~8–10 clean commits.
- [ ] **5.3 Move the branch:** once green + verified, point `feat/provider-readiness` at the integrated result:
```bash
git branch -f feat/provider-readiness integrate/provider-readiness
git checkout feat/provider-readiness
```
Backup remains at the old state.

---

## Phase 6 — Review + PR

- [ ] **6.1** Independent code-review (code-reviewer agent) over `git diff origin/main...HEAD`, focused on the reconcile (app.ts, AgentConfigForm splice, barrels, classifier↔emitter, migration).
- [ ] **6.2** Write the PR description: what ships (feature groups), what reconciled with #295, the migration renumber, the login-copy fix, and the deferred list (onboarding false-green, waiver gap, auth-detection duplication note, multi-write race, vacuous not_installed assertion, LobbySidebar flake).
- [ ] **6.3 Handoff (user's steps, stated honestly):** push → PR → **CI is the real gate** (I run equivalents locally, not CI itself); run **Codex from your terminal** on the final diff (it 401s in-session). These two + a human reviewer are what make it truly enterprise-grade beyond the local green.

---

## Self-Review

- **Spec coverage:** provider readiness core (1.2–1.4), reactive fix (1.1), settings UI (1.5–1.6), onboarding→take #295 (2.1–2.2), waiver drop (2.3), login fix (2.4), barrels/app/AgentConfigForm reconcile (2.5–2.8), migration regen (3), full test matrix incl. integration + e2e + classifier↔emitter proof (4), completeness (5.1), squashed history (5.2), review + PR + honest handoff (6). Covered.
- **Risk hotspots:** 2.7 (AgentConfigForm splice), 2.8 (commander-login reconcile — may be superseded), 3.2 (db:generate producing the right migration), 4.5 (the emitter connection), 5.1 (missed bring-over). Each has an explicit gate.
- **No placeholders:** every phase has concrete commands; the reconcile steps name exact files + resolutions.
