# Temporary Public-Repo Cycle for CI Unblock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Temporarily flip the AoA GitHub repo to public so CI can run on the free unlimited tier (current private-repo Actions minutes are exhausted), complete the 2 pending PRs (#111, #115) that require CI verification, run an end-to-end functional check that `pnpm dev` + the deployed Porting1.1 still works after all merges, then flip the repo back to private.

**Architecture:** Six phases in strict sequence:
- **Phase 0** — Pre-flight safety scan (secret history, workflow safety, issue content). HARD HALT on any finding.
- **Phase 1** — Flip repo to public via `gh api`.
- **Phase 2** — Complete pending CI work (PRs #111 + #115) via re-run + merge.
- **Phase 3** — Functional verification (`pnpm dev` + smoke test of merged changes).
- **Phase 4** — Flip back to private.
- **Phase 5** — Prevent recurrence (disable Docker auto-trigger on main, document lesson).

**Tech Stack:** `gh api` for repo visibility flips. `git log -p` + regex for secret scanning. Normal `pnpm dev` for functional verification. No new code dependencies.

---

## Changelog

This is v1 of the plan. Created 2026-05-05 in response to GitHub Actions billing exhaustion blocking PRs #111 and #115.

## Locked decisions

1. **Pre-flight is a HARD HALT.** Any committed secret discovered → STOP. Do NOT flip public. Controller decides: clean history (BFG repo-cleaner / git filter-repo) or abort plan and pay for Actions instead.
2. **Public window must be < 4 hours.** Anyone who clones during the window keeps the code forever. Goal: minimize exposure.
3. **No new development during the window.** Only ship already-committed changes (PRs #111 + #115).
4. **Auto-flip back to private as soon as CI work + functional verification complete.** Don't leave the repo public if no work is in flight.
5. **All recent issues (#112-#116) reviewed for sensitive content** before flip — they're filed in the last 24h and may contain internal-only context.
6. **Functional verification is REQUIRED before Phase 4 flip.** "CI is green" is necessary but not sufficient. Local `pnpm dev` boot + UI load = the actual contract.
7. **No PR base ambiguity.** All future PRs in this plan use `--base Porting1.1`, with mandatory `gh pr view <PR> --json baseRefName --jq .baseRefName` verification (Incident 1 lesson from 2026-05-05).

## Controller-Only Decisions (subagent never decides these)

When a subagent reports back, the **controller** decides:
- Whether to halt at any halt criterion (subagent reports the situation; controller decides next move)
- Whether the secret-scan findings are real or false-positives
- Whether to redact/edit sensitive issue content vs. abort the plan
- Whether functional verification is conclusive or needs another pass
- The exact moment to flip public → private (no early flips, no late flips)

The subagent decides:
- How to implement what each task description says (within the locked code blocks)
- Whether commit messages match the spec
- Whether tests pass before committing
- When to ask the controller a clarifying question

**The flip-to-public step requires explicit user (human) approval.** Subagent does NOT flip without controller forwarding human approval.

---

## Recommended execution order

Strictly sequential — each phase blocks the next:

| # | Phase | Blocker for next? | Risk |
|---|---|---|---|
| 1 | Phase 0 (pre-flight safety) | YES — must pass before flip | High — irreversible if wrong |
| 2 | Phase 1 (flip public) | YES | Low — easily reverted |
| 3 | Phase 2 (complete CI work) | YES | Low — already locally validated |
| 4 | Phase 3 (functional verification) | YES | Medium — could surface new bugs |
| 5 | Phase 4 (flip private) | NO | Low — desired end state |
| 6 | Phase 5 (prevention) | NO | Low — additive |

---

## Pre-flight Checks

- [ ] **Confirm we're on `Porting1.1`, synced, working tree clean.**

```bash
git checkout Porting1.1
git fetch origin Porting1.1
git rev-list --left-right --count HEAD...origin/Porting1.1
git status --short
```

Expected: `0	0` from rev-list (in sync). Status shows only untracked dotfiles (`.claire/`, `.claude/worktree-archive/`).

- [ ] **Confirm both pending PRs exist and have valid local-validated commits.**

```bash
gh pr view 111 --json state,mergeable,baseRefName --jq '.'
gh pr view 115 --json state,mergeable,baseRefName --jq '.'
```

Expected: both `state: OPEN`, `mergeable: MERGEABLE` or `UNSTABLE`, `baseRefName: Porting1.1`.

- [ ] **Note the start time.** Used to track public-window duration.

```bash
date -u +%Y-%m-%dT%H:%M:%SZ
```

Save the output as `PLAN_START_TIME` in your notes.

---

## File Structure

This plan does not modify code files (all code changes were already committed in PRs #111 and #115). It modifies repo metadata and runs verification commands.

| Action | What | Why |
|---|---|---|
| `gh api -X PATCH /repos/{owner}/{repo} -f private=false` | Flip public | Unblock Actions |
| `gh run rerun <RUN_ID>` | Re-run blocked CI | Validate PRs |
| `gh pr merge <PR> --squash --delete-branch` | Merge | Land work |
| `gh api -X PATCH /repos/{owner}/{repo} -f private=true` | Flip private | Restore privacy |
| `.github/workflows/docker.yml` (optional, Phase 5) | Edit `on:` triggers | Conserve future minutes |

---

## Phase 0: Pre-flight Safety Scan

**Goal:** Verify nothing in the repo's current state, history, workflow files, issues, or PR descriptions is unsafe to make public.

**Halt criteria (subagent stops + reports):**

- 🛑 ANY committed secret pattern matches in git history → STOP. Report the file/commit/line. Controller decides: clean history or abort.
- 🛑 ANY workflow file uses `pull_request_target` trigger → STOP. This trigger lets PRs from forks access secrets — exploitable on public repos.
- 🛑 ANY issue or PR description (from #1 onward, focused on last 30 days) contains an API key, password, internal endpoint URL with credentials, or undisclosed-product trade secret → STOP. Controller decides whether to redact and continue or abort.
- 🛑 `.env`, `.env.local`, `secrets.json`, `*.key`, or `*.pem` is tracked in git history (even if currently `.gitignore`d) → STOP. These usually contain secrets.
- 🛑 The user does not explicitly approve the flip-to-public step at the end of Phase 0 → DO NOT proceed to Phase 1.

### Task 0.1: Scan git history for committed secrets (regex patterns)

**Files:** Read-only investigation across `git log --all`.

- [ ] **Step 1: Generic secret-keyword scan**

```bash
git log --all -p 2>/dev/null | grep -nE "(api[_-]?key|secret|password|bearer|credential|private[_-]?key)\s*[:=]\s*['\"][A-Za-z0-9/+=_-]{16,}" | head -30
```

Expected: empty. If hits, inspect each:
```bash
git log --all -S 'matched_token_value' --oneline | head -5
```

- [ ] **Step 2: Known-format token scan**

```bash
git log --all -p 2>/dev/null | grep -nE "(sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{30,}|gho_[A-Za-z0-9]{30,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{60,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|GOCSPX-[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9-]+)" | head -30
```

Detects: OpenAI (`sk-`), Anthropic (`sk-ant-`), GitHub (`gho_`, `ghp_`, `github_pat_`), Google (`AIza`), AWS (`AKIA`, `ASIA`), Google OAuth (`GOCSPX-`), Slack (`xox[baprs]-`).

Expected: empty. If hits, the token format is unmistakable — don't second-guess.

- [ ] **Step 3: JWT scan**

```bash
git log --all -p 2>/dev/null | grep -nE "eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}" | head -10
```

Expected: empty. JWTs in the codebase usually live in test fixtures (which is fine if obvious) but production secrets here are red flags.

- [ ] **Step 4: PEM key scan**

```bash
git log --all -p 2>/dev/null | grep -nE "BEGIN (RSA|EC|DSA|OPENSSH|PGP) (PRIVATE|ENCRYPTED) KEY" | head -5
```

Expected: empty. Any PEM private key is an automatic STOP.

- [ ] **Step 5: Tracked credential files**

```bash
git log --all --name-only --pretty=format:"" 2>/dev/null | sort -u | grep -E "(^|/)(\.env(\..*)?$|secrets\.json$|.*\.key$|.*\.pem$|credentials\.json$|service-account.*\.json$)" | head -20
```

Expected: empty. If `.env` or similar appears, even from a long-deleted commit, the content lives forever in git history.

- [ ] **Step 6: Report Task 0.1 outcome**

If ALL 5 steps returned empty: report `0.1 GREEN — no committed secrets detected`.
If any step had hits: report each match with file/commit/line. STOP and escalate.

### Task 0.2: Workflow safety audit

**Files:** `.github/workflows/*.yml`

**Halt criteria:**
- 🛑 Any `pull_request_target` trigger present.
- 🛑 Any workflow uses `${{ secrets.* }}` in a context that runs from a fork's PR (combined with `pull_request_target` or external-PR triggering).

- [ ] **Step 1: Search for dangerous triggers**

```bash
grep -nE "pull_request_target" .github/workflows/*.yml
```

Expected: empty. `pull_request_target` is the well-known security risk — it gives PR workflows full secret access.

- [ ] **Step 2: List all triggers in use**

```bash
for f in .github/workflows/*.yml; do
  echo "=== $f ==="
  grep -A 5 "^on:" "$f" | head -10
done
```

Document. All triggers should be safe `pull_request`, `push`, `workflow_dispatch`, `schedule`, or similar.

- [ ] **Step 3: Audit secret usage in workflows**

```bash
grep -nE "secrets\." .github/workflows/*.yml
```

Document each usage. For each: confirm the workflow's trigger is safe (not `pull_request_target` from forks). The `Refresh Lockfile` workflow uses `${{ github.token }}` only — safe. The `Release` and `Docker` workflows likely use `NPM_TOKEN` / GHCR token — these run on push to main / tag, which is safe (forks can't trigger pushes).

- [ ] **Step 4: Report Task 0.2 outcome**

`0.2 GREEN — no unsafe triggers; secret usage limited to push/release contexts` OR list issues found.

### Task 0.3: Issue and PR description content review

**Files:** Review last 30 days of issues + open PRs via GitHub API.

**Halt criteria:**
- 🛑 Any issue/PR contains a credential (API key, password, JWT)
- 🛑 Any issue/PR contains an internal-only endpoint URL with auth in the URL
- 🛑 Any issue/PR discloses a pre-launch product feature you don't want competitors to see (controller judgment call)

- [ ] **Step 1: Pull recent issues + PRs**

```bash
gh issue list --state all --limit 30 --json number,title,body,createdAt --jq '.[] | "\(.number) | \(.title)"' > /tmp/aoa-issues.txt
gh pr list --state all --limit 30 --json number,title,body,createdAt --jq '.[] | "\(.number) | \(.title)"' > /tmp/aoa-prs.txt
cat /tmp/aoa-issues.txt /tmp/aoa-prs.txt | head -60
```

- [ ] **Step 2: Scan their bodies for sensitive patterns**

```bash
gh issue list --state all --limit 30 --json number,body --jq '.[] | "ISSUE #\(.number)\n\(.body)\n---"' > /tmp/aoa-issue-bodies.txt
gh pr list --state all --limit 30 --json number,body --jq '.[] | "PR #\(.number)\n\(.body)\n---"' > /tmp/aoa-pr-bodies.txt

cat /tmp/aoa-issue-bodies.txt /tmp/aoa-pr-bodies.txt | grep -nE "(api[_-]?key|password|secret|bearer|credential|sk-[A-Za-z0-9]{20,}|gho_|ghp_|AIza|AKIA)" | head -20
```

Expected: empty.

- [ ] **Step 3: Report Task 0.3 outcome**

`0.3 GREEN — no sensitive content in issue/PR descriptions` OR list specific issue/PR numbers needing redaction.

### Task 0.4: Currently-tracked file credential check

**Files:** All currently-tracked files (HEAD).

- [ ] **Step 1: Scan current files**

```bash
git ls-files | xargs grep -nE "(sk-[A-Za-z0-9_-]{20,}|sk-ant-|gho_[A-Za-z0-9]{30,}|ghp_[A-Za-z0-9]{30,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})" 2>/dev/null | grep -v "test\|fixture\|example\|\.md:" | head -20
```

Excludes test fixtures, examples, and markdown (which often have illustrative tokens that aren't real). Expected: empty for real-looking matches in production code paths.

- [ ] **Step 2: Verify .env files are gitignored AND not currently tracked**

```bash
grep -E "^\.env" .gitignore | head -5
git ls-files | grep -E "(^|/)\.env" | head -5
```

Expected: `.env*` patterns appear in `.gitignore`. Second command empty (no .env tracked).

- [ ] **Step 3: Report Task 0.4 outcome**

`0.4 GREEN — current tree clean` OR list issues.

### Task 0.5: Final pre-flight summary + USER GATE

- [ ] **Step 1: Compile pre-flight summary**

Produce a single-page report:
```
PRE-FLIGHT REPORT (Phase 0)
- Task 0.1 (history secret scan): GREEN | YELLOW | RED [+ details]
- Task 0.2 (workflow audit):       GREEN | YELLOW | RED [+ details]
- Task 0.3 (issue/PR content):     GREEN | YELLOW | RED [+ details]
- Task 0.4 (current tree):          GREEN | YELLOW | RED [+ details]

Verdict: SAFE TO FLIP PUBLIC | UNSAFE — DO NOT FLIP
```

- [ ] **Step 2: Present to user (controller forwards to human)**

Output the report. **Wait for explicit human approval ("yes, flip" or equivalent) before proceeding to Phase 1.** The subagent does NOT flip on its own initiative.

- [ ] **Step 3: Record the decision**

If approved: proceed to Phase 1.
If not approved: STOP. Plan ends here. Document the abort reason. Consider alternative paths (BFG to clean history, or pay for Actions).

---

## Phase 1: Flip the repo to public

**Goal:** Change repo visibility from private to public via the `gh` API. Verify Actions billing is now on the free public-repo tier.

**Halt criteria:**

- 🛑 `gh api -X PATCH` returns non-2xx status → STOP. Could indicate insufficient permissions or repo settings preventing the change.
- 🛑 After flip, repo metadata still shows `private: true` → STOP. The flip didn't take effect.
- 🛑 `gh api repos/.../actions/runs?per_page=1` still shows the same exhausted-billing failure pattern after flip → controller decides whether to wait for GH propagation or escalate.

### Task 1.1: Capture pre-flip state

- [ ] **Step 1: Snapshot current state**

```bash
gh api repos/MeteoriteLabs/AoA --jq '{private, default_branch, has_issues, allow_squash_merge, allow_merge_commit, allow_rebase_merge, delete_branch_on_merge}' > /tmp/aoa-prepublic-state.json
cat /tmp/aoa-prepublic-state.json
```

Expected output (approximate):
```json
{"private":true,"default_branch":"main","has_issues":true,"allow_squash_merge":true,"allow_merge_commit":true,"allow_rebase_merge":true,"delete_branch_on_merge":false}
```

Save this — used to verify post-flip state matches and to restore in Phase 4.

### Task 1.2: Flip to public

- [ ] **Step 1: Execute the flip**

```bash
gh api -X PATCH repos/MeteoriteLabs/AoA -f private=false 2>&1 | head -5
```

Expected: API returns the updated repo object (200 OK), with `"private": false` in the response.

If non-200: STOP. Report the response body.

- [ ] **Step 2: Verify the flip via fresh API read**

```bash
gh api repos/MeteoriteLabs/AoA --jq '.private'
```

Expected: `false`.

If `true` still: STOP. Wait 30 seconds for propagation, retry. If still `true`, escalate.

### Task 1.3: Verify Actions runs no longer fail at startup

- [ ] **Step 1: Trigger a smoke-test workflow**

```bash
gh workflow run "Refresh Lockfile" --ref Porting1.1 2>&1
sleep 30
gh run list --workflow="Refresh Lockfile" --limit 1 --json databaseId,status,conclusion --jq '.[]'
```

Expected: status `queued` or `in_progress`. NOT immediately failed in <15 seconds.

- [ ] **Step 2: Wait for the smoke test to complete**

```bash
RUN_ID=$(gh run list --workflow="Refresh Lockfile" --limit 1 --json databaseId --jq '.[0].databaseId')
until gh run view $RUN_ID --json status --jq '.status' 2>&1 | grep -qE "completed"; do sleep 30; done
gh run view $RUN_ID --json conclusion,status,jobs --jq '{conclusion, status, first_job_step_count: (.jobs[0].steps | length)}'
```

Expected: `conclusion: "success"`, `first_job_step_count` > 0 (steps actually ran).

If still `conclusion: "failure"` and `step_count: 0`: STOP. The flip didn't unblock CI. Public flip didn't take effect at the billing layer. Wait 5 minutes and retry; if still broken, abort and flip back to private.

- [ ] **Step 3: Report Task 1.3 outcome**

`Phase 1 GREEN — repo is public, Actions are unblocked, smoke test passed` OR halt details.

---

## Phase 2: Complete pending CI work (PRs #111 and #115)

**Goal:** Re-run CI on both blocked PRs, confirm green, merge them.

**Halt criteria:**

- 🛑 PR #111's CI fails on a real test failure (not a billing artifact) → STOP. Report failure. Controller decides whether to fix-forward or revert the locally-validated change.
- 🛑 PR #115's CI fails likewise → same.
- 🛑 Either PR's `baseRefName` is not `Porting1.1` → STOP. Re-validate (Incident 1 lesson).
- 🛑 `migrations` job fails on either PR → STOP. The chain check has a real issue.
- 🛑 `verify-cross-platform (windows-latest)` fails on either PR's run for a NEW reason (not the documented embedded-postgres encoding issue) → report; advisory, not blocking, but worth noting.

### Task 2.1: Verify PR #111 base + re-run CI

- [ ] **Step 1: Verify PR #111 base is `Porting1.1`**

```bash
gh pr view 111 --json baseRefName --jq '.baseRefName'
```

Expected: `Porting1.1`. If `main` (Incident 1 pattern), STOP and escalate.

- [ ] **Step 2: Find the most recent failed run for PR #111**

```bash
PR_111_RUN_ID=$(gh run list --branch ci/migrations-chain-limitation-doc-v2 --limit 1 --json databaseId --jq '.[0].databaseId')
echo "PR #111 most recent run: $PR_111_RUN_ID"
```

- [ ] **Step 3: Re-run failed jobs**

```bash
gh run rerun $PR_111_RUN_ID --failed
```

Expected: command exits 0. The run transitions back to `queued`/`in_progress`.

- [ ] **Step 4: Wait for completion**

```bash
until gh run view $PR_111_RUN_ID --json status --jq '.status' 2>&1 | grep -qE "completed"; do sleep 60; done
gh pr checks 111 --watch=false
```

Expected: required gates (`policy`, `brand-check`, `verify`, `e2e`, `migrations`) all `pass`. Cross-platform may pass or fail (advisory).

- [ ] **Step 5: Verify mergeable**

```bash
gh pr view 111 --json mergeable,mergeStateStatus --jq '.'
```

Expected: `mergeable: MERGEABLE`.

### Task 2.2: Merge PR #111

- [ ] **Step 1: Squash-merge**

```bash
gh pr merge 111 --squash --delete-branch
```

Expected: success message.

- [ ] **Step 2: Sync local Porting1.1**

```bash
git checkout Porting1.1
git pull origin Porting1.1
git log --oneline -1
```

Expected: HEAD is the new squash commit `ci(migrations): document gap-then-corruption limitation in chain check (#111)`.

### Task 2.3: Verify PR #115 base + re-run CI

- [ ] **Step 1: Verify PR #115 base**

```bash
gh pr view 115 --json baseRefName --jq '.baseRefName'
```

Expected: `Porting1.1`. STOP if `main`.

- [ ] **Step 2: Update PR #115's branch onto latest Porting1.1**

PR #115 was created off Porting1.1 BEFORE #111 merged. To avoid stale-base CI, rebase via API:

```bash
gh pr update-branch 115 2>&1 || echo "(branch already up to date or update not needed)"
```

This either rebases the PR or returns "already up-to-date".

- [ ] **Step 3: Re-run + wait**

```bash
PR_115_RUN_ID=$(gh run list --branch fix/dev-watch-auto-apply-migrations --limit 1 --json databaseId --jq '.[0].databaseId')
gh run rerun $PR_115_RUN_ID --failed
until gh run view $PR_115_RUN_ID --json status --jq '.status' 2>&1 | grep -qE "completed"; do sleep 60; done
gh pr checks 115 --watch=false
```

Expected: all required gates pass.

### Task 2.4: Merge PR #115

- [ ] **Step 1: Squash-merge**

```bash
gh pr merge 115 --squash --delete-branch
```

- [ ] **Step 2: Sync local Porting1.1**

```bash
git checkout Porting1.1
git pull origin Porting1.1
git log --oneline -3
```

Expected output (top-down):
```
<sha> fix(dev): auto-apply migrations on dev:watch startup (Windows + cross-platform) (#115)
<sha> ci(migrations): document gap-then-corruption limitation in chain check (#111)
5a75331 fix(heartbeat): guard SIGKILL escalation log with runningProcesses.has() (#109)
```

### Task 2.5: Verify CI is green on the new Porting1.1 HEAD

The merge of #115 triggers a `push` workflow on Porting1.1. Wait for it.

- [ ] **Step 1: Find the push-trigger run**

```bash
sleep 30
PUSH_RUN_ID=$(gh run list --branch Porting1.1 --event push --workflow="PR" --limit 1 --json databaseId --jq '.[0].databaseId')
echo "Porting1.1 post-merge run: $PUSH_RUN_ID"
```

- [ ] **Step 2: Wait + verify**

```bash
until gh run view $PUSH_RUN_ID --json status --jq '.status' 2>&1 | grep -qE "completed"; do sleep 60; done
gh run view $PUSH_RUN_ID --json conclusion,jobs --jq '{conclusion, jobs: [.jobs[] | {name, conclusion}]}'
```

Expected: `conclusion: "success"`. Required gates green. Cross-platform advisory may fail (per Issues #112-#114).

- [ ] **Step 3: Report Task 2.5 outcome**

`Phase 2 GREEN — both PRs merged, Porting1.1 push-CI green` OR halt details.

---

## Phase 3: Functional verification

**Goal:** Confirm `pnpm dev` actually boots after the merges, the UI loads, and basic API endpoints respond. This is the contract check — CI green is necessary but not sufficient.

**Halt criteria:**

- 🛑 `pnpm dev` fails to boot → STOP. Either the merges introduced a regression or there's another latent Windows bug. Roll forward by filing a fix PR; do NOT flip private until dev works.
- 🛑 `/api/health` doesn't return 200 → STOP. Same as above.
- 🛑 The boot takes >60 seconds → flag (likely env-specific) but proceed.
- 🛑 Migration apply fails (e.g., another chain bug) → STOP. Investigate.

### Task 3.1: Confirm local Porting1.1 has the merged fixes

- [ ] **Step 1: Verify the cross-env + AUTO_APPLY fix is on local HEAD**

```bash
grep "cross-env AOA_MIGRATION_AUTO_APPLY=true" server/package.json
```

Expected: 1 hit. If absent, the merge didn't propagate; re-pull.

- [ ] **Step 2: Verify the limitation-doc comment is on local HEAD**

```bash
grep -c "KNOWN LIMITATION: gap-then-corruption" .github/workflows/pr.yml
```

Expected: 1 (matches the comment from PR #111).

### Task 3.2: Smoke-test `pnpm dev`

- [ ] **Step 1: Boot the dev server**

```bash
rm -f /tmp/aoa-dev-functional.log
pnpm dev 2>&1 | tee /tmp/aoa-dev-functional.log &
DEV_PID=$!
echo "Dev server PID: $DEV_PID"
```

- [ ] **Step 2: Wait up to 60 seconds for boot completion**

```bash
for i in $(seq 1 60); do
  if grep -q "Server listening on" /tmp/aoa-dev-functional.log 2>/dev/null; then
    echo "Boot complete in ${i}s"
    break
  fi
  sleep 1
done
```

Expected: "Boot complete in NNs" within 60 seconds.

If timeout: STOP. Capture log, report.

- [ ] **Step 3: Confirm migrations applied**

```bash
grep "applied (pending migrations)\|Migrations.*applied" /tmp/aoa-dev-functional.log | head -3
```

Expected: line containing "applied (pending migrations)" OR similar success.

If absent (e.g., "pending migrations skipped"): STOP. AUTO_APPLY isn't taking effect.

- [ ] **Step 4: Confirm server listening**

```bash
curl -sS -i http://127.0.0.1:3100/api/health | head -3
```

Expected:
```
HTTP/1.1 200 OK
content-type: application/json
...
```

- [ ] **Step 5: Confirm UI loads (basic GET)**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/
```

Expected: `200`.

### Task 3.3: Stop dev server cleanly

- [ ] **Step 1: Kill dev server**

```bash
# Find and kill the pnpm dev process group
ps -ef | grep -E "node.*dev-runner|tsx watch" | grep -v grep | awk '{print $2}' | xargs -r kill 2>&1 || true
sleep 3
ps -ef | grep -E "node.*dev-runner|tsx watch" | grep -v grep | head -3
```

Expected: empty output (no surviving processes).

- [ ] **Step 2: Report Task 3 outcome**

`Phase 3 GREEN — dev boots, migrations apply, UI + API respond` OR halt details.

---

## Phase 4: Flip back to private

**Goal:** Restore privacy as soon as Phases 2 and 3 confirm everything is good.

**Halt criteria:**

- 🛑 Phase 2 or Phase 3 hasn't fully completed yet → DO NOT flip.
- 🛑 `gh api -X PATCH` returns non-2xx → STOP. Report.
- 🛑 Verifying private state shows `private: true` after flip → success. If `private: false` still: STOP, retry once after 30s, escalate if still wrong.

### Task 4.1: Final pre-flip verification

- [ ] **Step 1: Confirm Phase 2 completed**

```bash
git log --oneline -3
```

Expected top-down:
```
<sha> fix(dev): auto-apply migrations on dev:watch startup (Windows + cross-platform) (#115)
<sha> ci(migrations): document gap-then-corruption limitation in chain check (#111)
5a75331 fix(heartbeat): guard SIGKILL escalation log with runningProcesses.has() (#109)
```

If not matching: STOP. Phase 2 incomplete.

- [ ] **Step 2: Confirm Phase 3 completed**

Look for the `Phase 3 GREEN` marker in the controller's log of this plan execution. If not present: STOP.

- [ ] **Step 3: Confirm no in-flight work**

```bash
gh pr list --state open --base Porting1.1 --json number,title,state --jq '.[]'
```

Expected: only INDEPENDENT in-flight PRs (not blocking this plan). PRs from this plan (#111, #115) should be CLOSED.

If new in-flight PRs exist that you opened during this window: pause Phase 4 until they finish, OR accept they'll have to wait until next public window.

- [ ] **Step 4: Note end time**

```bash
date -u +%Y-%m-%dT%H:%M:%SZ
```

Save as `PLAN_END_TIME`. Compare with `PLAN_START_TIME` from pre-flight to compute public-window duration.

### Task 4.2: Flip to private

- [ ] **Step 1: Execute the flip**

```bash
gh api -X PATCH repos/MeteoriteLabs/AoA -f private=true 2>&1 | head -5
```

Expected: 200 OK with the updated repo object showing `private: true`.

- [ ] **Step 2: Verify**

```bash
gh api repos/MeteoriteLabs/AoA --jq '.private'
```

Expected: `true`.

- [ ] **Step 3: Document the public window in plan notes**

```bash
echo "Public window:"
echo "  Start: <PLAN_START_TIME>"
echo "  End:   <PLAN_END_TIME>"
echo "  Duration: <duration>"
```

Add to plan-execution log. Aim is < 4 hours (per Locked decision #2).

### Task 4.3: Confirm Actions still works post-flip

The repo is private again, so Actions billing reverts to the private-tier limits. Future runs will consume free-plan minutes.

- [ ] **Step 1: Trigger a tiny smoke run**

```bash
gh workflow run "Refresh Lockfile" --ref Porting1.1 2>&1
sleep 30
RUN_ID=$(gh run list --workflow="Refresh Lockfile" --limit 1 --json databaseId --jq '.[0].databaseId')
until gh run view $RUN_ID --json status --jq '.status' 2>&1 | grep -qE "completed"; do sleep 30; done
gh run view $RUN_ID --json conclusion --jq '.conclusion'
```

Expected: `success`.

If `failure` with empty steps[]: billing exhaustion is back. The minutes consumed during the public window were free, so this should NOT happen UNLESS new minutes were consumed AFTER the flip-private. If so, log it; controller decides whether to wait for next billing cycle or upgrade plan.

- [ ] **Step 2: Report Task 4 outcome**

`Phase 4 GREEN — repo is private again, post-flip CI smoke green` OR halt details.

---

## Phase 5: Prevent recurrence

**Goal:** Reduce the chance of CI billing exhaustion happening again.

**Halt criteria:**

- 🛑 The `docker.yml` workflow file's structure differs significantly from what's expected (e.g., refactored heavily) → adjust the patch site, report deviations.

### Task 5.1: Disable Docker auto-trigger on push to main

The `.github/workflows/docker.yml` workflow currently triggers on every push to main, building multi-arch (Linux + ARM64) images. This consumed ~30 minutes per main push. Restrict to tag-only triggering — saves ~60 min per main push (Docker on push to main triggered TWICE today: once on the inadvertent #110 squash, once on the recovery).

- [ ] **Step 1: Read the current docker.yml triggers**

```bash
sed -n '1,15p' .github/workflows/docker.yml
```

Expected: an `on:` block with `push:` triggers.

- [ ] **Step 2: Branch + edit**

```bash
git checkout -b ci/docker-tags-only
```

Use the Edit tool. Find:
```yaml
on:
  push:
    branches:
      - main
```

Replace with:
```yaml
on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:
```

(If the actual current shape differs — e.g., includes `branches: [main, master]` — keep the equivalent semantics: tag-only + manual dispatch. Adjust per the actual file.)

- [ ] **Step 3: Validate YAML**

```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/docker.yml'))"
```

- [ ] **Step 4: Commit + push + open PR**

```bash
git add .github/workflows/docker.yml
git commit -m "$(cat <<'EOF'
ci(docker): trigger only on tag pushes + manual dispatch

Today's GitHub Actions billing exhaustion (private repo, free plan,
2000 Linux minutes/month) was triggered when the inadvertent PR #110
merge to main fired the Docker workflow. Multi-arch Docker builds
(linux/amd64 + linux/arm64) consume ~60 minutes per push.

Restrict Docker workflow to:
  - Tag pushes (v* pattern) — for actual releases
  - Manual workflow_dispatch — for ad-hoc rebuilds

Removes the per-push-to-main 60-minute consumption. Release-time
builds still happen via the tag trigger.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push -u origin ci/docker-tags-only
gh pr create --base Porting1.1 --head ci/docker-tags-only \
  --title "ci(docker): trigger only on tag pushes + manual dispatch" \
  --body "## Summary
- Restricts \`docker.yml\` to fire only on tag pushes (\`v*\`) + manual \`workflow_dispatch\`. Removes auto-trigger on every push to main.

## Why
2026-05-05's GitHub Actions billing exhaustion was triggered by the inadvertent PR #110 squash to main firing the Docker workflow. Multi-arch Docker (linux/amd64 + linux/arm64) consumes ~60 minutes per push. Confining Docker to actual release events saves significant CI minutes.

## Test plan
- [ ] CI: required checks green
- [ ] Verify Docker workflow does NOT trigger on the merge of this PR
- [ ] Verify Docker workflow DOES trigger when a \`v*\` tag is pushed (manual test)"
```

- [ ] **Step 5: Verify base = `Porting1.1`**

```bash
PR_NUM=$(gh pr list --head ci/docker-tags-only --state open --json number --jq '.[0].number')
gh pr view $PR_NUM --json baseRefName --jq '.baseRefName'
```

Expected: `Porting1.1`. STOP if `main`.

- [ ] **Step 6: Wait for CI + merge**

```bash
until gh pr view $PR_NUM --json statusCheckRollup --jq '[.statusCheckRollup[] | select(.status != "COMPLETED")] | length' 2>&1 | grep -q "^0$"; do sleep 30; done
gh pr checks $PR_NUM --watch=false
gh pr merge $PR_NUM --squash --delete-branch
```

### Task 5.2: Document lesson learned in AGENTS.md

- [ ] **Step 1: Find AGENTS.md's CI section**

```bash
grep -n "^## " AGENTS.md
```

Identify where to add a new "CI hygiene" subsection. Likely under §7 (Dependency Change Workflow) or as a new top-level section.

- [ ] **Step 2: Branch**

```bash
git checkout Porting1.1
git pull origin Porting1.1
git checkout -b docs/agents-md-ci-budget-lesson
```

- [ ] **Step 3: Add a new short section after AGENTS.md's last CI-related section**

Use the Edit tool. Add (after a logical CI/Dependency section):

```markdown

### CI minute budget (added 2026-05-05)

GitHub Actions on the free plan caps private-repo minutes at **2,000 Linux-equivalent
minutes per calendar month** (Windows = 2×, macOS = 10×). Heavy workflows (multi-arch
Docker, full e2e cross-platform matrix) can exhaust this budget quickly.

Today's lesson: 10× pr.yml runs (each ~30 minutes effective) + 2× Docker runs
(~60 minutes each) consumed the entire monthly budget by mid-month. All workflows
then started failing in 4-12s with empty `steps[]` — the GitHub-side billing-cutoff
signature.

To stay under budget:
- Docker workflow now fires on tag pushes only (PR #<TASK_5_1_PR>).
- Cross-platform jobs (verify-cross-platform, e2e-cross-platform) are advisory
  (`continue-on-error: true`) and don't gate merges.
- Spending alert recommended at the 50% threshold (Settings → Billing & plans).

If CI suddenly fails uniformly with empty `steps[]` and 4-12s job durations:
1. Check https://github.com/settings/billing/summary for minute-balance.
2. If exhausted: wait for next billing cycle, OR temporarily flip repo public
   (public repos = unlimited minutes), OR upgrade plan.
3. Document the cause + recovery in this section so future readers know the pattern.
```

- [ ] **Step 4: Commit + push + open PR**

Standard commit + push + `gh pr create --base Porting1.1` pattern. Title: `docs(AGENTS.md): document CI minute budget lesson + recovery`. Verify base = Porting1.1 post-creation.

- [ ] **Step 5: Wait for CI + merge**

Same as Task 5.1 Step 6.

---

## Self-Review Checklist

- [x] **Spec coverage:** Plan covers (a) safe pre-flight, (b) flip public, (c) complete blocked CI work, (d) verify functionally, (e) flip back, (f) prevent recurrence.
- [x] **No placeholders:** Every step has explicit commands, expected outputs, halt criteria. The `<TASK_5_1_PR>` placeholder in Task 5.2 Step 3 is filled in at execution time after Task 5.1 lands — that's a forward reference, not a TBD.
- [x] **Halt criteria present (v2 design):** Each phase has explicit 🛑 triggers. Pre-flight has the most because it's the irreversible step.
- [x] **Controller-vs-subagent boundaries clear:** Pre-flight USER GATE explicitly requires human approval; subagents do not flip on their own.
- [x] **Public window minimization:** Phase 2 + 3 are designed to be fast (~1-2 hours total); Phase 5 (prevention) intentionally runs AFTER private flip to not extend the window.
- [x] **Type/identifier consistency:** `gh api`, `gh pr`, `gh run`, `gh workflow run` used consistently. `Porting1.1` always referenced as the base branch (Incident 1 lesson). `gh pr view <PR> --json baseRefName --jq .baseRefName` verification done explicitly post each `gh pr create`.
- [x] **Functional verification is required:** Phase 3 doesn't get skipped — Phase 4 explicitly checks for `Phase 3 GREEN` before flipping private.

---

## Risks & Open Questions

1. **The pre-flight scan can produce false negatives.** Patterns I scan for don't catch every secret format (e.g., custom JWT-like tokens, base64-encoded credentials). The scans are best-effort; they reduce risk but don't eliminate it. If you've ever knowingly committed something sensitive, mention it BEFORE Phase 0 so we can target the scan.

2. **The public window allows clones.** Anyone who clones during the window keeps the code forever. There's no recall. Aiming for <4 hours minimizes — not eliminates — the exposure.

3. **GitHub indexing during the public window.** Code-search engines (GitHub itself, Sourcegraph, etc.) may index public repos. Once flipped private, the code drops out of search, but if a snapshot was indexed, it may persist briefly.

4. **Forks during the window.** Forks are also irreversible — they live independently. Watch [https://github.com/MeteoriteLabs/AoA/network/members](https://github.com/MeteoriteLabs/AoA/network/members) during the window.

5. **Issues #112-#116 will be public.** Their content was reviewed in Phase 0 Task 0.3. If the controller didn't redact anything, they're considered safe.

6. **Phase 3's functional verification doesn't test every code path.** It boots `pnpm dev`, hits `/api/health`, and verifies migrations applied. UI interaction (Issue #96 manual verification scenario) is NOT in scope here — that's a separate plan.

7. **Phase 5 itself consumes CI minutes.** PRs created during Phase 5 (e.g., the `ci(docker): tags-only` PR) trigger CI. Those are cheap (no Docker, just policy/verify/e2e). If billing is tight even after the public window's free runs, Phase 5 can be deferred.

8. **Possible `Phase 5 Task 5.1` workflow timing.** The `ci/docker-tags-only` PR's CI run may itself fire the `docker.yml` workflow IF the `branches: [main, master, Porting1.1]` triggers include Porting1.1. Docker would then run again, consuming minutes. The fix here ALSO removes Porting1.1 from Docker triggers, so this is a one-time concern. The Phase 5 PR's body should call this out for the maintainer to confirm.

9. **No formal rollback for "what if the flip-private fails?"** If `gh api -X PATCH ... private=true` returns 5xx persistently, the repo stays public until you manually flip via UI (Settings → General → Change repository visibility → Make private). Document this fallback explicitly in your execution log.

10. **Does NOT cover Issue #96 verification or Issues #112-#114 fixes.** Those are out of scope for this plan. Do them in a separate plan/session AFTER this one completes.

---
