# CI Trigger Redesign (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CI gate suite run on **every** pull request (not just PRs targeting a hardcoded porting-era branch list), gate draft PRs so they don't burn CI until marked ready, prune dead branch triggers, retire dead automation, and close a policy bypass left behind — without changing any required check or branch protection.

**Architecture:** Pure CI-trigger/guard config change in `.github/workflows/`. The root problem is that `pr.yml` (and the Release/Docker workflows) trigger only on an allow-list of base branches (`master`, `main`, `Porting1.1`, `feat/v1-combined`). Because `on: pull_request: branches:` filters on the PR's **base** branch, any PR into a branch outside that list gets **zero checks, silently** — which is why stacked/feature PRs appear to "have no CI" and agents conclude CI is broken. The fix: drop the `branches:` filter on `pull_request` so all PRs are gated, add a per-job draft guard + `ready_for_review` trigger so drafts skip until ready, scope `push` to `main` (+ tags for Docker), remove the three dead branches, and delete the now-orphaned `chore/refresh-lockfile` policy exemption. Job names are untouched, so the required-check set (`verify, e2e, migrations, policy, brand-check`) keeps working.

**Tech Stack:** GitHub Actions YAML, `gh` CLI for verification, `rg` for assertions.

**Out of scope (deferred — do NOT do here):**
- The Release lane red (GitHub App token / npm OIDC / publish environment) → **Phase 2**, separate plan.
- `paths-ignore` for docs-only PRs → deferred. **Trap (Codex-confirmed):** `pr.yml` produces the *required* checks; if a `paths`/`branches` filter causes a whole workflow to be skipped, those required checks never report and the PR hangs forever on "Expected — Waiting for status." Note this is distinct from the **draft guard** below, which uses a per-job `if:` (the workflow still runs, jobs report `skipped`, and `ready_for_review` re-runs them) and so does NOT hang.
- Draft-gating `llm-evals.yml` → possible follow-up; it is already path-filtered to agent/extraction files and rarely runs. Not Phase 1.
- Deleting the ~130 stale remote branches → housekeeping, separate task.

---

## Pre-flight facts (verified 2026-06-24)

- `master` branch: **deleted** (dead trigger).
- `Porting1.1`: last commit 2026-05-05; **0 commits not in `main`**; `main` is 1624 commits ahead → fully merged, dead.
- `feat/v1-combined`: **0 commits not in `main`** → fully merged, dead.
- `main` required checks: `verify, e2e, migrations, policy, brand-check` (unchanged by this plan).
- `package.json:57` pins `"packageManager": "pnpm@9.15.4"` (relevant to Task 5).
- `pr.yml:36` "Block manual lockfile edits" step is skipped when `github.head_ref == 'chore/refresh-lockfile'`. The bot that used that branch is being deleted (Task 4), so the exemption becomes an open bypass (P1, see Task 4).

---

## File Structure

- Modify `.github/workflows/pr.yml`: (a) replace the 4-branch trigger with unfiltered `pull_request` (+ `ready_for_review` type) and `push: [main]`; (b) add a per-job draft guard to all 7 jobs; (c) delete the orphaned `chore/refresh-lockfile` exemption in the `policy` job's "Block manual lockfile edits" step.
- Modify `.github/workflows/release.yml`: scope `push` to `main`; fix stale header prose.
- Modify `.github/workflows/docker.yml`: scope `push` to `main` + `v*` tags.
- Delete `.github/workflows/refresh-lockfile.yml`: Porting1.1-only automation, now dead.
- Modify `.github/workflows/llm-evals.yml`: align to Node 24 + SHA-pinned actions.
- Modify `CLAUDE.md`: document the new trigger model (all PRs gated, drafts gated, main-scoped push/release/docker).

All work happens on one branch and lands via one PR **into `main`** (whose current `pr.yml` still has `main` in its allow-list, so the gate PR itself runs normally — no chicken-and-egg for landing).

---

## Task 1: Make `pr.yml` run on every (non-draft) PR

**Files:**
- Modify: `.github/workflows/pr.yml:6-18` (the `on:` block)
- Modify: `.github/workflows/pr.yml` (add a job-level `if:` to each of the 7 jobs: `policy`, `brand-check`, `verify`, `verify-cross-platform`, `e2e`, `e2e-cross-platform`, `migrations`)

- [ ] **Step 1: Replace the trigger block**

Current (`.github/workflows/pr.yml` lines 6-18):

```yaml
on:
  pull_request:
    branches:
      - master
      - main
      - Porting1.1
      - feat/v1-combined
  push:
    branches:
      - master
      - main
      - Porting1.1
      - feat/v1-combined
```

Replace with:

```yaml
on:
  # No branches: filter — every PR into ANY base branch is gated. This is the
  # fix for the porting-era allow-list that silently ran zero checks on
  # stacked / feature-to-feature PRs. `ready_for_review` is listed so that
  # marking a draft PR ready re-fires the workflow and the draft-guarded jobs
  # (see each job's `if:`) run for real before merge.
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  # push only on main: post-merge signal + warms the pnpm cache. Feature
  # branches get their signal from the PR run, not a duplicate push run.
  push:
    branches:
      - main
```

- [ ] **Step 2: Add the draft guard to every job**

Add this exact line as a job-level key (sibling of `runs-on:`) to **each** of the 7 jobs. On a `push` event `github.event.pull_request` is null, so the first clause keeps `push: main` runs working; on a draft PR the job is skipped (reports `skipped`, which branch protection treats as neutral — and GitHub blocks merging drafts anyway); on a ready PR (or when a draft is marked ready) it runs.

```yaml
    if: ${{ github.event_name != 'pull_request' || !github.event.pull_request.draft }}
```

Apply to each job header. Example for `policy` (`pr.yml:25-27`):

```yaml
  policy:
    runs-on: ubuntu-latest
    if: ${{ github.event_name != 'pull_request' || !github.event.pull_request.draft }}
    timeout-minutes: 5
```

Repeat for `brand-check`, `verify`, `verify-cross-platform`, `e2e`, `e2e-cross-platform`, `migrations`. (For matrix jobs like `verify-cross-platform`/`e2e-cross-platform`, the `if:` goes at the job level, above/below `strategy:`, not inside the matrix.)

- [ ] **Step 3: Verify the dead branches are gone and the guard is present**

Run:

```sh
rg -n "master|Porting1.1|feat/v1-combined" .github/workflows/pr.yml
```

Expected: **no matches**.

Run:

```sh
rg -n -A8 "^on:" .github/workflows/pr.yml
```

Expected: `pull_request:` with `types:` including `ready_for_review` and **no** `branches:` sub-key; `push:` scoped to `main`.

Run:

```sh
rg -c "github.event.pull_request.draft" .github/workflows/pr.yml
```

Expected: `7` (one guard per job).

- [ ] **Step 4: Confirm YAML still parses**

Run:

```sh
python -c "import yaml; yaml.safe_load(open('.github/workflows/pr.yml')); print('pr.yml OK')"
```

Expected: `pr.yml OK` (no traceback).

- [ ] **Step 5: Commit**

```sh
git add .github/workflows/pr.yml
git commit -m "ci(pr): gate all PRs (drafts excluded); scope push to main"
```

## Task 2: Scope `release.yml` to `main` + fix stale prose

**Files:**
- Modify: `.github/workflows/release.yml:5` (header comment) and `.github/workflows/release.yml:23-29` (the `on:` block)

- [ ] **Step 1: Fix the stale header comment**

In the top comment block, find the line (around `release.yml:5`):

```
#   2. On push to main (or current porting branch), this workflow runs.
```

Replace with:

```
#   2. On push to main, this workflow runs.
```

- [ ] **Step 2: Replace the trigger block**

Current (`.github/workflows/release.yml` lines 23-29):

```yaml
on:
  push:
    branches:
      - master
      - main
      - Porting1.1
  workflow_dispatch:
```

Replace with:

```yaml
on:
  push:
    branches:
      - main
  workflow_dispatch:
```

- [ ] **Step 3: Verify**

Run:

```sh
rg -n "master|Porting1.1|current porting branch" .github/workflows/release.yml
```

Expected: **no matches**.

Run:

```sh
python -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('release.yml OK')"
```

Expected: `release.yml OK`.

- [ ] **Step 4: Commit**

```sh
git add .github/workflows/release.yml
git commit -m "ci(release): scope push trigger to main; fix stale prose"
```

## Task 3: Scope `docker.yml` to `main` + tags

**Files:**
- Modify: `.github/workflows/docker.yml:3-11` (the `on:` block)

- [ ] **Step 1: Replace the trigger block**

Current (`.github/workflows/docker.yml` lines 3-11):

```yaml
on:
  push:
    branches:
      - "master"
      - "main"
      - "Porting1.1"
    tags:
      - "v*"
  workflow_dispatch:
```

Replace with:

```yaml
on:
  push:
    branches:
      - "main"
    tags:
      - "v*"
  workflow_dispatch:
```

- [ ] **Step 2: Verify**

Run:

```sh
rg -n "master|Porting1.1" .github/workflows/docker.yml
```

Expected: **no matches**.

Run:

```sh
python -c "import yaml; yaml.safe_load(open('.github/workflows/docker.yml')); print('docker.yml OK')"
```

Expected: `docker.yml OK`.

- [ ] **Step 3: Commit**

```sh
git add .github/workflows/docker.yml
git commit -m "ci(docker): scope push trigger to main + tags"
```

## Task 4: Retire `refresh-lockfile.yml` AND close its policy bypass (P1)

**Files:**
- Delete: `.github/workflows/refresh-lockfile.yml`
- Modify: `.github/workflows/pr.yml:35-36` (the `policy` job's "Block manual lockfile edits" step)

`refresh-lockfile.yml` triggers only on `push` to `Porting1.1` (dead) and does a `gh pr create` (same block as the Release lane) — dead automation. **Critical:** deleting it without touching `pr.yml` leaves an open bypass — the lockfile-edit guard is skipped for any branch named `chore/refresh-lockfile`, and with the bot gone, any PR can use that name to slip a lockfile-only change past the policy. Both changes ship together. (If lockfile auto-refresh on `main` is wanted later, it returns in Phase 2 with the GitHub App token and a re-added, tightly-scoped exemption.)

- [ ] **Step 1: Delete the workflow**

```sh
git rm .github/workflows/refresh-lockfile.yml
```

- [ ] **Step 2: Remove the orphaned exemption in `pr.yml`**

Current (`.github/workflows/pr.yml` lines 35-36):

```yaml
      - name: Block manual lockfile edits
        if: github.event_name == 'pull_request' && github.head_ref != 'chore/refresh-lockfile'
```

Replace with (drop the `chore/refresh-lockfile` carve-out entirely):

```yaml
      - name: Block manual lockfile edits
        if: github.event_name == 'pull_request'
```

- [ ] **Step 3: Verify no dangling references and the bypass is gone**

Run:

```sh
rg -n "refresh-lockfile|chore/refresh-lockfile" .github/
```

Expected: **no matches** anywhere under `.github/` (workflow deleted, exemption removed).

Run:

```sh
python -c "import yaml; yaml.safe_load(open('.github/workflows/pr.yml')); print('pr.yml OK')"
```

Expected: `pr.yml OK`.

- [ ] **Step 4: Commit**

```sh
git add .github/workflows/pr.yml
git commit -m "ci(lockfile): retire refresh-lockfile workflow + close head_ref bypass"
```

## Task 5: Align `llm-evals.yml` to Node 24 + pinned actions

**Files:**
- Modify: `.github/workflows/llm-evals.yml:28-38`

`llm-evals` is path-filtered (runs only on agent/extraction PRs) and is **not** a required check, so the blast radius is small. Pinning the unpinned `@v4`/`@v3` actions to the SHAs used everywhere else is a supply-chain hygiene win.

Note: `pnpm/action-setup` v4 auto-detects the pnpm version from `package.json`'s `packageManager` field (`pnpm@9.15.4`, already present), so a `version:` input is **not required**. We pass `version: 9.15.4` anyway purely for consistency with the sibling workflows (`pr.yml`, `release.yml`, etc.) that all set it explicitly; it matches `packageManager` so there is no conflict.

- [ ] **Step 1: Replace the setup steps**

Current (`.github/workflows/llm-evals.yml` lines 28-38):

```yaml
      - name: Checkout
        uses: actions/checkout@v4

      - name: Install pnpm
        uses: pnpm/action-setup@v3

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
```

Replace with (SHAs/version copied verbatim from `pr.yml`):

```yaml
      - name: Checkout
        uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1

      - name: Install pnpm
        uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0
        with:
          version: 9.15.4
          run_install: false

      - name: Setup Node.js
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: 24
          cache: pnpm
```

- [ ] **Step 2: Verify no unpinned actions remain**

Run:

```sh
rg -n "uses: .*@v[0-9]" .github/workflows/llm-evals.yml
```

Expected: **no matches** (all actions SHA-pinned).

Run:

```sh
python -c "import yaml; yaml.safe_load(open('.github/workflows/llm-evals.yml')); print('llm-evals.yml OK')"
```

Expected: `llm-evals.yml OK`.

- [ ] **Step 3: Commit**

```sh
git add .github/workflows/llm-evals.yml
git commit -m "ci(evals): pin actions to SHAs + align to Node 24"
```

## Task 6: Document the new trigger model

**Files:**
- Modify: `CLAUDE.md` (the "CI Platform Status" section)

- [ ] **Step 1: Update the CI section in `CLAUDE.md`**

Find the `### CI Platform Status` section. Immediately under its heading (before the platform table), add:

```markdown
**Triggers (2026-06-24 redesign):**

- `pr.yml` (the gate suite) runs on **every** pull request — no base-branch
  filter — plus `push` to `main`. Required checks: `verify`, `e2e`,
  `migrations`, `policy`, `brand-check`. Cross-platform lanes stay advisory.
- **Draft PRs are gated:** each `pr.yml` job carries
  `if: ${{ github.event_name != 'pull_request' || !github.event.pull_request.draft }}`,
  and the `pull_request` trigger lists `ready_for_review`. Draft PRs show the
  gate jobs as `skipped`; marking a PR ready re-runs them for real before merge.
- `release.yml` / `docker.yml` run on `push` to `main` (Docker also on `v*`
  tags). The porting-era branch allow-list is gone.
- Do NOT re-introduce a `branches:` filter on `pr.yml`'s `pull_request` trigger
  (it silently ran zero checks on stacked/feature PRs), and do NOT add a
  `paths:`/`paths-ignore:` filter to `pr.yml` (a skipped required check leaves
  PRs stuck on "Expected — Waiting for status").
```

- [ ] **Step 2: Verify**

Run:

```sh
rg -n "every. pull request|Draft PRs are gated|porting-era branch allow-list" CLAUDE.md
```

Expected: the new Triggers subsection is present.

- [ ] **Step 3: Commit**

```sh
git add CLAUDE.md
git commit -m "docs(ci): document all-PR + draft-gated trigger model"
```

## Task 7: Land and verify live

**Files:** none (CI/GitHub operations).

The change must be on `main` to take effect for future PRs. For `pull_request` events GitHub reads the workflow config from the **base** branch, so once `main` has the new `pr.yml`, any PR into `main` — and any branch freshly cut from updated `main` — is gated. (Caveat: branches created **before** this lands still carry the old filtered `pr.yml`; rebasing them onto updated `main` picks up the fix. Forward-looking, not retroactive.)

- [ ] **Step 1: Open the PR into `main`**

```sh
git push -u origin HEAD
gh pr create --base main --title "ci: gate all PRs (drafts excluded) + prune dead branch triggers (Phase 1)" \
  --body "Phase 1 of CI redesign. Removes the porting-era base-branch allow-list so every non-draft PR is gated; gates drafts via per-job if + ready_for_review; scopes push/release/docker to main; retires dead refresh-lockfile AND closes its head_ref policy bypass; pins llm-evals. See docs/aoa/plans/2026-06-24-ci-trigger-redesign-plan.md."
```

- [ ] **Step 2: Confirm the gate PR itself ran the required checks**

Run (replace `<PR#>`):

```sh
gh pr checks <PR#> --watch
```

Expected: `verify`, `e2e`, `migrations`, `policy`, `brand-check` all present and passing (this PR's base is `main`, in the current allow-list, so it runs normally; it is not a draft, so the new guard lets it run).

- [ ] **Step 3: Merge to `main`**

After approval + green checks:

```sh
gh pr merge <PR#> --squash --delete-branch
```

- [ ] **Step 4: Prove the fix — a PR into a non-`main` base now gets CI**

The regression test for the filter removal. Cut two branches from the **updated** `main`:

```sh
git fetch origin main
git switch -c ci-smoke-base origin/main
git push -u origin ci-smoke-base

git switch -c ci-smoke-head origin/main
echo "" >> README.md
git commit -am "test: ci trigger smoke (no-op)"
git push -u origin ci-smoke-head

gh pr create --base ci-smoke-base --head ci-smoke-head \
  --title "test: CI trigger smoke (delete me)" --body "Verifies pr.yml runs on a non-main base."
```

Run (replace `<smokePR#>`):

```sh
gh pr checks <smokePR#>
```

Expected: the gate jobs (`verify`, `e2e`, `migrations`, `policy`, `brand-check`) **appear and run.** Before this plan, a PR into a non-`main` base showed **no checks at all** — their presence here is the proof.

- [ ] **Step 5: Prove draft-gating — convert to draft, confirm jobs skip, then ready**

```sh
gh pr ready --undo <smokePR#>     # convert to draft
git -C . commit --allow-empty -m "test: poke draft" && git push   # trigger a synchronize on the draft
gh pr checks <smokePR#>
```

Expected: gate jobs report `skipped` (or no new run) while draft.

```sh
gh pr ready <smokePR#>            # mark ready_for_review
gh pr checks <smokePR#>
```

Expected: `ready_for_review` re-fires the workflow and the gate jobs run for real.

- [ ] **Step 6: Clean up the smoke test**

```sh
gh pr close <smokePR#> --delete-branch
git push origin --delete ci-smoke-base
```

Confirm the no-op `README.md` line never reached `main` (the smoke PR is closed, not merged).

- [ ] **Step 7: Report**

Summarize:
- Workflows changed: `pr.yml`, `release.yml`, `docker.yml`, `llm-evals.yml`; deleted `refresh-lockfile.yml`; closed the `chore/refresh-lockfile` bypass.
- Proof: smoke PR into a non-`main` base ran the gate suite; draft-gating skipped then ran on ready (paste `gh pr checks` output).
- Required checks unchanged and still green on `main`.
- Phase 2 (Release hardening + GitHub App) still pending.

## Task 8: Update AGENTS.md §7 for the retired lockfile bot/bypass

**Files:**
- Modify: `AGENTS.md` (§7 "Dependency Change Workflow")

Added after Codex's cloud review of PR #228 flagged (P2) that `AGENTS.md §7` still documents the `chore/refresh-lockfile` escape-hatch branch and the `refresh-lockfile.yml` bot — both removed by Task 4. A contributor following those docs would now have a lockfile PR rejected. The policy change and its contributor docs must ship together. (Archived session logs under `docs/archive/` also mention the bot; they are historical/non-authoritative per CLAUDE.md and are left untouched.)

- [ ] **Step 1: Rewrite the intro + add a retirement note**

Replace the "escape hatch" framing with the current rule: a PR committing `pnpm-lock.yaml` is blocked unless it also changes a manifest. Add a dated note that the `chore/refresh-lockfile` carve-out and the `refresh-lockfile.yml` bot were retired 2026-06-24, with the Phase 2 re-introduction pointer.

- [ ] **Step 2: Replace the workflow subsections**

Drop "Manual flow (current)" (the `chore/refresh-lockfile` ceremony), "Automation: refresh-lockfile.yml bot", and the layered "Inline lockfile updates (added 2026-05-05)" history. Replace with three current subsections: "Standard flow: change a dependency" (manifest + lockfile together, any branch), "Lockfile-only refresh (no manifest change)" (blocked, no automated path, workaround), and "Two dependency PRs racing" (regenerate-on-rebase).

- [ ] **Step 3: Verify**

```sh
rg -n "chore/refresh-lockfile|refresh-lockfile\.yml|Porting1.1" AGENTS.md
```

Expected: no matches (no stale branch/bot/Porting1.1 references in AGENTS.md).

```sh
rg -n "Block manual lockfile edits|together, on any branch|Retired 2026-06-24" AGENTS.md
```

Expected: the new gate reference + standard-flow + retirement note are present.

- [ ] **Step 4: Commit**

```sh
git add AGENTS.md
git commit -m "docs(deps): rewrite AGENTS.md dependency workflow for retired lockfile bot/bypass"
```

## Task 9: ~~Re-run gates on PR base-branch retarget (`edited` activity)~~ — REVERTED

> **REVERTED (Codex P1 on #228).** This task added `edited` to the `pull_request` types + a `changes.base` guard. Codex's third pass flagged a **P1**: on a *mergeable* PR, a title/body edit fires `edited`, the guard skips all 7 required jobs, and GitHub treats skipped required checks as **passing** — so a title edit could satisfy branch protection (main has no required reviews) without real CI, and `cancel-in-progress` would also kill any running real gate. The fix was a net-negative (a merge-bypass to close a narrow gap), so it was reverted. The retarget gap is re-classified as a **Phase 1.1 follow-up**. The steps below are retained as a record of the reverted attempt.
>
> **Best-practice forward plan (Phase 1.1) — aggregator gate:** introduce one always-running required job `ci-required` (`needs:` all heavy jobs, `if: always()`, verdict computed from `needs.*.result`); make branch protection require only `ci-required`; demote the heavy jobs to non-required + conditional. That single refactor makes draft-gating, retarget re-runs (`edited` + `changes.base`), and the docs `paths-ignore` optimization all safe, because the required check's conclusion is computed explicitly instead of relying on GitHub's skip=success default. Most repos also handle retarget simply via "push to re-trigger" or `strict` branch protection.

**Files (reverted attempt):**
- Modify: `.github/workflows/pr.yml` (trigger `types` + the 7 job guards)
- Modify: `CLAUDE.md` (trigger-model doc)

Originally added after Codex's re-review flagged (P2) that retargeting a PR fires `pull_request.edited`, omitted from `types`, so a retargeted PR would not re-validate against its new base (stale false-green). Implemented, then reverted per the P1 above.

- [ ] **Step 1: Add `edited` to the trigger types**

In `pr.yml`, change `types: [opened, synchronize, reopened, ready_for_review]` to `types: [opened, synchronize, reopened, ready_for_review, edited]`, and extend the trigger comment to explain `edited` re-runs CI on base retarget.

- [ ] **Step 2: Extend the per-job guard (all 7 jobs)**

Replace the guard on every job with:

```yaml
    if: ${{ github.event_name != 'pull_request' || (!github.event.pull_request.draft && (github.event.action != 'edited' || github.event.changes.base != null)) }}
```

Keeps push-to-main + non-draft PR behavior, runs on a base-change `edited`, and skips title/body-only `edited` events so they don't burn CI.

- [ ] **Step 3: Update CLAUDE.md**

Update the draft-guard bullet to the new expression and note that retargets re-run CI against the new base.

- [ ] **Step 4: Verify (static)**

```sh
rg -c "github.event.changes.base" .github/workflows/pr.yml
```

Expected: `7` (base-change clause on each job).

```sh
rg -n "ready_for_review, edited" .github/workflows/pr.yml
python -c "import yaml; yaml.safe_load(open('.github/workflows/pr.yml')); print('pr.yml OK')"
```

Expected: `edited` present in `types`; `pr.yml OK`.

- [ ] **Step 5: Commit**

```sh
git add .github/workflows/pr.yml CLAUDE.md
git commit -m "ci(pr): re-run gates on base retarget (edited); skip title/body edits"
```

- [ ] **Step 6: Verify live (with the Task 7 smoke PR, post-merge)**

After the smoke PR exists (Task 7 Step 4, base `ci-smoke-base`), retarget it and confirm a fresh gate run fires:

```sh
gh pr edit <smokePR#> --base main
gh pr checks <smokePR#>
```

Expected: a new gate run starts for the retargeted base (the `edited`/`changes.base` path). Before this task, retargeting produced no new run. (Then restore/close per Task 7 Step 6.)

---

## Codex review (2026-06-24)

Independent review via `/codex review` (gpt, read-only). Verdicts and resolutions:

- Core GitHub Actions semantics **confirmed correct**: unfiltered `pull_request` gates all PRs; required checks still report (no hang); deferring `paths-ignore` is right; scoping push to `main` is fine; the base-branch/forward-looking caveat is accurate.
- **[P1] resolved** — the `chore/refresh-lockfile` exemption is an open policy bypass once the bot is deleted. Was wrongly called "harmless"; now removed entirely in **Task 4 Step 2** (user decision: delete the exemption).
- **Factual error fixed** — `package.json:57` already pins `packageManager: pnpm@9.15.4`, so the v4 `version:` input is not required. Task 5 rationale corrected (kept for sibling-workflow consistency, not necessity).
- **[P2] fixed** — Task 1 verify command `-A3` → `-A8`; stale `release.yml` "current porting branch" prose cleaned in Task 2.
- **Decision resolved** — draft PRs are now gated (Task 1 Step 2 + `ready_for_review`), per user choice.
- **PR-time Codex P2 (cloud reviewer on #228) resolved** — `AGENTS.md §7` documented the now-removed `chore/refresh-lockfile` escape hatch + `refresh-lockfile.yml` bot; rewritten in **Task 8** so the contributor docs match the closed-bypass policy.
- **PR-time Codex P2 #2 (retarget gap) → fix REVERTED.** Added `edited` + a `changes.base` clause (Task 9), but Codex's **P1 #3** showed it introduced a worse problem (next bullet). Reverted; retarget deferred to Phase 1.1 (aggregator gate).
- **PR-time Codex P1 #3 (skip-success bypass) resolved by revert.** Including `edited` made title/body edits skip the 7 required jobs into skipped-success, which GitHub treats as passing — a branch-protection bypass on a repo with no required reviews. Reverted the `edited` change; **Task 9** kept as a record. Best practice = aggregator gate (Phase 1.1).

## Self-Review

- **Spec coverage:** All-PR triggers = Task 1 Step 1. Draft-gating = Task 1 Step 2 + `ready_for_review` type. Stale-branch pruning = Tasks 1-3. Dead automation retirement + P1 bypass close = Task 4. Hygiene rider = Task 5. Documentation = Task 6. Live verification (filter fix + draft-gating) = Task 7. Release hardening + GitHub App deferred to Phase 2. Docs `paths-ignore` deferred with the required-check-trap rationale.
- **Placeholder scan:** No TBD/TODO. Every edit shows exact before/after YAML and exact verify commands with expected output. Only runtime substitutions are PR numbers (`<PR#>`, `<smokePR#>`).
- **Consistency:** Action SHAs in Task 5 match `pr.yml` (`actions/checkout@34e1148…` v4.3.1, `pnpm/action-setup@b906aff…` v4.3.0 + `version: 9.15.4`, `actions/setup-node@49933ea…` v4.4.0). Draft guard expression identical across all 7 jobs and in the CLAUDE.md doc. Required-check names (`verify, e2e, migrations, policy, brand-check`) match the live branch-protection set. `main` is the single retained branch across all trigger blocks.
- **Risk:** Tasks 1-4 + 6 change triggers/guards/docs only (no job logic). The draft guard uses a per-job `if:` (workflow still runs, jobs report `skipped`, `ready_for_review` re-runs) so it does NOT cause the pending-forever trap that `paths-ignore` would. Task 5 is the only environment-touching change, isolated to a non-required, path-filtered job. All reversible by restoring the original `on:` blocks and removing the `if:` guards.
