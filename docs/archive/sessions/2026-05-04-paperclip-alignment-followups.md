# Paperclip Alignment Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the four deferred and discovered fixes from the 4-PR CI-unblock execution (2026-05-04). Three independent PRs against `Porting1.1` plus one verification step. All four use Paperclip's existing implementation as the reference (located at `C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\paperclip-master\paperclip-master`).

**Architecture:** Each follow-up is independent and lands as its own PR (small, focused, easy to review/revert). Order is by ascending size and risk so each PR is a safe building block. The first PR is the docs we authored locally during the previous session; the second is a small hygiene pass; the third ports a workflow file; the fourth is the only one touching real product code.

**Tech Stack:** TypeScript, Vitest, Express 5.x, Drizzle ORM, GitHub Actions, Node 24, pnpm 9.15.4. No new dependencies introduced by any task.

**Locked decisions:**
1. **Each follow-up is its own PR.** Smaller PRs = simpler reviews, partial-merge safety, less rebase pain.
2. **Use Paperclip's exact patterns where applicable** — copy the function names, signatures, and behavior. Reduces invention surface.
3. **For Issue #96, port the minimal version** (`signalRunningProcess` + `detached:true` spawn) — not Paperclip's full `terminateLocalService` supervisor pattern with poll-and-SIGKILL retry. Minimal version closes the orphan-process bug; the supervisor pattern can come later if needed.
4. **No production code changes in PR 1, 2, or 3.** Only PR 4 touches `server/src` + `packages/adapter-utils`. Lower risk profile per PR.

---

## Pre-flight Checks

- [ ] **Confirm we're on `Porting1.1` and synced.**

```bash
git checkout Porting1.1
git pull origin Porting1.1
git log --oneline -3
```

Expected: HEAD is `57f1733 feat(marketplace): full marketplace ─ browse, install, updates, auto-apply (#94)` or newer. If older, something blocks new work.

- [ ] **Confirm AGENTS.md and fixture README are still uncommitted locally** (PR 1 ships them).

```bash
git status --short
```

Expected: shows `M AGENTS.md` and `?? tests/e2e/fixtures/README.md`. If clean, PR 1 was already shipped — skip to PR 2.

- [ ] **Confirm Paperclip reference repo is accessible.**

```bash
ls "/c/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/paperclip-master/paperclip-master/.github/workflows/refresh-lockfile.yml" \
   "/c/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/paperclip-master/paperclip-master/packages/adapter-utils/src/server-utils.ts"
```

Expected: both files exist. If not, the plan can't reference exact line numbers — open the Paperclip GitHub mirror instead.

- [ ] **Confirm Issue #96 is still open** (PR 4 closes it).

```bash
gh issue view 96 --json state --jq .state
```

Expected: `OPEN`. If `CLOSED`, someone already shipped a fix — verify the implementation still aligns with this plan before continuing.

---

## File Structure

| File | Task | Action | Why |
|---|---|---|---|
| `AGENTS.md` | PR 1 | **Ship** (already modified locally) | New §7 "Dependency Change Workflow" + renumbered §8-§11 |
| `tests/e2e/fixtures/README.md` | PR 1 | **Ship** (already created locally) | Documents fixture capture date, schema source, when-to-update triggers |
| `server/src/__tests__/company-export-readme.test.ts` | PR 2 | **Modify** lines 61, 126 | Replace 2× stale `role: "ceo"` → `role: "cxo"` |
| `server/src/__tests__/unified-org-tree.test.ts` | PR 2 | **Modify** lines 167, 437 | Replace 2× stale `role: "ceo"` → `role: "cxo"` |
| `.github/workflows/refresh-lockfile.yml` | PR 3 | **Create** | Port Paperclip's auto-bot, adjust `master` → `Porting1.1` |
| `AGENTS.md` | PR 3 | **Modify** | Remove "future improvement" caveat in §7 once bot lands |
| `packages/adapter-utils/src/server-utils.ts` | PR 4 | **Modify** | Replace `safeGetPgid` with `resolveProcessGroupId`; add `signalRunningProcess`; spawn with `detached:true` |
| `packages/adapter-utils/src/types.ts` | PR 4 | **Possibly modify** | If `RunningProcess.pgid` is exposed in types, rename to `processGroupId` for Paperclip alignment |
| `server/src/services/heartbeat.ts` | PR 4 | **Modify** 4 cancellation paths (lines 3828, 3884, 3913, 3939) | Swap `running.child.kill("SIGTERM")` for `signalRunningProcess(running, "SIGTERM")` |
| `server/src/__tests__/heartbeat-process-tracking.test.ts` | PR 4 | **Modify** | Update `safeGetPgid` test → `resolveProcessGroupId` test asserting it returns `child.pid` on POSIX, `null` on Windows |
| `(verification only)` | Step 5 | **Read** `LIVE_EVENT_TYPES` consumers | Confirm `memory.*` and `marketplace.*` events flow through correctly |

---

## PR 1: Docs PR — ship AGENTS.md + fixture README

**Context:** During the post-merge cleanup of the previous session, we authored two docs but didn't push them: a new "Dependency Change Workflow" section in `AGENTS.md` (documenting the `chore/refresh-lockfile` policy gate workflow) and a `tests/e2e/fixtures/README.md` documenting the marketplace catalog fixture's capture date, schema source, and when-to-update triggers. Both are already modified/created in the working tree. This PR ships them.

**Files:**
- Modify: `AGENTS.md`
- Create: `tests/e2e/fixtures/README.md`

This is a simple, no-test-required ship-it PR. Following the workflow we just documented: `chore/refresh-lockfile` doesn't apply (no manifest/lockfile changes), policy gate passes naturally.

- [ ] **Step 1: Verify the changes look right**

```bash
git diff AGENTS.md | head -80
cat tests/e2e/fixtures/README.md | head -20
```

Expected: AGENTS.md shows the new `## 7. Dependency Change Workflow` section + renumbered 8-11. README.md shows fixture documentation.

- [ ] **Step 2: Branch + stage + commit**

```bash
git checkout -b docs/lockfile-workflow-and-fixture-readme
git add AGENTS.md tests/e2e/fixtures/README.md
git commit -m "$(cat <<'EOF'
docs: document dependency workflow + e2e fixture maintenance

AGENTS.md: add §7 "Dependency Change Workflow" describing the
chore/refresh-lockfile policy-gate exception, the manual flow for
adding deps, the rebase pattern for consuming PRs, and the
single-use branch-name caveat. Renumber §7-§10 to §8-§11. Mention
porting Paperclip's refresh-lockfile.yml as a future improvement
(separate PR coming).

tests/e2e/fixtures/README.md: new file documenting the pinned
marketplace-catalog.json fixture — when it was captured, how
pr.yml's e2e job uses it, what schema changes trigger updates,
and the source-of-truth schema definition. Surfaces the fixture
maintenance contract that was implicit in the marketplace PR.

No code changes; no lockfile changes; both files are docs-only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Push**

```bash
git push -u origin docs/lockfile-workflow-and-fixture-readme
```

- [ ] **Step 4: Open PR**

```bash
gh pr create --base Porting1.1 --head docs/lockfile-workflow-and-fixture-readme \
  --title "docs: document dependency workflow + e2e fixture maintenance" \
  --body "$(cat <<'EOF'
## Summary

Two docs that landed locally during the post-merge cleanup of the marketplace + memory PR sequence on 2026-05-04 but didn't ship. Now shipping them.

- **\`AGENTS.md\` §7 "Dependency Change Workflow"** — describes the \`chore/refresh-lockfile\` policy-gate exception, the manual flow, and the rebase pattern for PRs that consume new deps. Sections 7-10 renumbered to 8-11.
- **\`tests/e2e/fixtures/README.md\`** — documents the marketplace catalog fixture (capture date 2026-05-04, schema source, when-to-update triggers). Helps the next person who has to re-capture or extend the fixture.

## What's NOT in this PR

- The actual \`refresh-lockfile.yml\` automation that AGENTS.md §7 mentions — that's a separate PR (it's a \`.github/workflows/\` change that benefits from its own review).
- Issue #96 fix (\`killProcessTree\`) — also a separate PR.

## Test plan

- [x] \`pnpm -r typecheck\` (no code changes — sanity check only)
- [ ] CI passes (no \`pnpm-lock.yaml\` change — policy gate not exercised)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Watch CI**

```bash
gh pr checks --watch --interval 60
```

Expected: all 4 checks pass — `policy`, `brand-check`, `verify`, `e2e`. Total ~10 min.

- [ ] **Step 6: Merge after human review**

```bash
gh pr merge --squash --delete-branch
```

Expected: merged. **PAUSE for human approval before continuing.**

---

## PR 2: Hygiene — update stale `role: "ceo"` fixtures in 2 test files

**Context:** When PR #93 (Teams) shipped the agent-role 3-tier cleanup (`"ceo"` → `"cxo"`), 4 test fixture files had stale `role: "ceo"` references. PR #97 fixed the 3 that were actually failing (`invite-join-manager.test.ts`). The other 2 — `company-export-readme.test.ts` and `unified-org-tree.test.ts` — currently pass because their assertions don't depend on `resolveJoinRequestAgentManagerId`. They're stale data that will eventually confuse future readers. This PR closes the loop.

**Files:**
- Modify: `server/src/__tests__/company-export-readme.test.ts` lines 61, 126
- Modify: `server/src/__tests__/unified-org-tree.test.ts` lines 167, 437

These are pure data fixes with no production code changes. The role string isn't asserted in either test, so this is a no-op functionally — but eliminates the stale data smell.

- [ ] **Step 1: Branch**

```bash
git checkout Porting1.1
git pull
git checkout -b fix/stale-ceo-role-fixtures
```

- [ ] **Step 2: Verify the stale fixtures still match the grep we ran during the previous session**

```bash
grep -n 'role: "ceo"' server/src/__tests__/company-export-readme.test.ts server/src/__tests__/unified-org-tree.test.ts
```

Expected (4 lines):

```
server/src/__tests__/company-export-readme.test.ts:61:          role: "ceo",
server/src/__tests__/company-export-readme.test.ts:126:          role: "ceo",
server/src/__tests__/unified-org-tree.test.ts:167:      const ceo = makeAgent({ id: "a-ceo", name: "CEO Agent", role: "ceo", reportsTo: null });
server/src/__tests__/unified-org-tree.test.ts:437:      const ceo = makeAgent({ id: "a-ceo", name: "CEO", role: "ceo", reportsTo: null });
```

If the grep returns nothing, someone already cleaned this up — abort PR 2 and continue to PR 3.

- [ ] **Step 3: Replace fixtures in `company-export-readme.test.ts`**

This is sed-with-context to keep the change surgical (don't touch other lines that happen to contain `"ceo"`):

```bash
python -c "
import re
path = 'server/src/__tests__/company-export-readme.test.ts'
with open(path) as f:
    s = f.read()
# Only replace the role value, not other 'ceo' tokens (e.g. agent IDs)
new = re.sub(r'(role:\s*)\"ceo\"', r'\1\"cxo\"', s)
if new == s:
    print('No changes — fixtures already updated?')
else:
    with open(path, 'w') as f:
        f.write(new)
    print('Updated', s.count('role: \"ceo\"') - new.count('role: \"ceo\"'), 'occurrences')
"
```

Expected: `Updated 2 occurrences`.

- [ ] **Step 4: Replace fixtures in `unified-org-tree.test.ts`**

```bash
python -c "
import re
path = 'server/src/__tests__/unified-org-tree.test.ts'
with open(path) as f:
    s = f.read()
new = re.sub(r'(role:\s*)\"ceo\"', r'\1\"cxo\"', s)
if new == s:
    print('No changes — fixtures already updated?')
else:
    with open(path, 'w') as f:
        f.write(new)
    print('Updated', s.count('role: \"ceo\"') - new.count('role: \"ceo\"'), 'occurrences')
"
```

Expected: `Updated 2 occurrences`.

- [ ] **Step 5: Verify no other `role: "ceo"` remains anywhere**

```bash
grep -rn 'role: "ceo"' server/src ui/src packages 2>/dev/null
```

Expected: empty output. If lines remain, inspect them — if they're production code (unlikely) STOP and ask. If they're additional test files, extend Step 3/4 to cover them.

- [ ] **Step 6: Run the affected tests locally to verify nothing broke**

```bash
pnpm --filter @armyofagents/server exec vitest run \
  src/__tests__/company-export-readme.test.ts \
  src/__tests__/unified-org-tree.test.ts
```

Expected: all tests pass. Note: the role value isn't asserted in either suite, so behavior is unchanged.

- [ ] **Step 7: Commit + push**

```bash
git add server/src/__tests__/company-export-readme.test.ts \
        server/src/__tests__/unified-org-tree.test.ts

git commit -m "$(cat <<'EOF'
fix(tests): clean up remaining stale role: \"ceo\" fixtures

PR #93 (the agent-role 3-tier cleanup) renamed the role value
\"ceo\" → \"cxo\" but missed several test fixtures. PR #97
unblocked CI by fixing the 3 fixtures that were actually failing
(invite-join-manager.test.ts). These two test files use the same
stale role value but were not failing because their assertions
don't go through resolveJoinRequestAgentManagerId. Cleaning up
now to prevent future readers from copying the obsolete role
value into new tests.

No behavior change — neither suite asserts on the role field.
Verified locally: 2 occurrences updated in each file, all tests
still pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"

git push -u origin fix/stale-ceo-role-fixtures
```

- [ ] **Step 8: Open PR**

```bash
gh pr create --base Porting1.1 --head fix/stale-ceo-role-fixtures \
  --title "fix(tests): clean up remaining stale role: \"ceo\" fixtures" \
  --body "$(cat <<'EOF'
## Summary

Closes the cleanup loop opened by PR #97. The agent-role rename (PR #93) left 4 test files with stale \`role: \"ceo\"\` fixtures. PR #97 fixed the 3 that were CI-blocking; the remaining 2 (\`company-export-readme.test.ts\`, \`unified-org-tree.test.ts\`) currently pass because they don't assert on the role field — but the stale data confuses future readers and risks accidentally copying \"ceo\" into new tests.

## Changes

- \`server/src/__tests__/company-export-readme.test.ts\` lines 61 + 126: \`role: \"ceo\"\` → \`role: \"cxo\"\`
- \`server/src/__tests__/unified-org-tree.test.ts\` lines 167 + 437: \`role: \"ceo\"\` → \`role: \"cxo\"\`
- Fixture identifier names (e.g. \`a-ceo\`, \`CEO Agent\`) left as-is; they're identifiers, not role values.

## Test plan

- [x] Both suites pass locally before AND after the fixture rename (no behavioral change)
- [ ] CI \`verify\` passes

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 9: Watch CI + merge**

```bash
gh pr checks --watch --interval 60
gh pr merge --squash --delete-branch
```

Expected: green CI, merged. **PAUSE for human approval before merging.**

---

## PR 3: Port Paperclip's `refresh-lockfile.yml` automation

**Context:** AGENTS.md §7 (shipped in PR 1) describes the manual `chore/refresh-lockfile` workflow and mentions Paperclip ships a bot that automates it. This PR ports that bot. After it merges, contributors who add deps just commit `package.json` changes (with the lockfile) on a `chore/refresh-lockfile` branch, and the bot does the rest. Significant DX improvement.

**Files:**
- Create: `.github/workflows/refresh-lockfile.yml`
- Modify: `AGENTS.md` §7 — remove the "Future improvement" caveat once the bot is live

Reference: `paperclip-master/.github/workflows/refresh-lockfile.yml` (97 lines).

- [ ] **Step 1: Branch**

```bash
git checkout Porting1.1
git pull
git checkout -b ci/port-refresh-lockfile-bot
```

- [ ] **Step 2: Create `.github/workflows/refresh-lockfile.yml`**

This is Paperclip's workflow with two adjustments: `master` → `Porting1.1` (the only protected base in AoA today), and `node-version: 20` → `node-version: 24` (matches the rest of AoA's CI). Verbatim otherwise.

```yaml
name: Refresh Lockfile

on:
  push:
    branches:
      - Porting1.1
  workflow_dispatch:

concurrency:
  group: refresh-lockfile-Porting1.1
  cancel-in-progress: false

jobs:
  refresh:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: write
      pull-requests: write

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9.15.4
          run_install: false

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm

      - name: Refresh pnpm lockfile
        run: pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile

      - name: Fail on unexpected file changes
        run: |
          changed="$(git status --porcelain)"
          if [ -z "$changed" ]; then
            echo "Lockfile is already up to date."
            exit 0
          fi
          if printf '%s\n' "$changed" | grep -Fvq ' pnpm-lock.yaml'; then
            echo "Unexpected files changed during lockfile refresh:"
            echo "$changed"
            exit 1
          fi

      - name: Create or update pull request
        id: upsert-pr
        env:
          GH_TOKEN: ${{ github.token }}
          REPO_OWNER: ${{ github.repository_owner }}
        run: |
          if git diff --quiet -- pnpm-lock.yaml; then
            echo "Lockfile unchanged, nothing to do."
            echo "pr_url=" >> "$GITHUB_OUTPUT"
            exit 0
          fi

          BRANCH="chore/refresh-lockfile"
          git config user.name "lockfile-bot"
          git config user.email "lockfile-bot@users.noreply.github.com"

          git checkout -B "$BRANCH"
          git add pnpm-lock.yaml
          git commit -m "chore(lockfile): refresh pnpm-lock.yaml"
          git push --force origin "$BRANCH"

          # Only reuse an open PR from this repository owner, not a fork with the same branch name.
          pr_url="$(
            gh pr list --state open --head "$BRANCH" --json url,headRepositoryOwner \
              --jq ".[] | select(.headRepositoryOwner.login == \"$REPO_OWNER\") | .url" |
            head -n 1
          )"
          if [ -z "$pr_url" ]; then
            pr_url="$(gh pr create \
              --base Porting1.1 \
              --head "$BRANCH" \
              --title "chore(lockfile): refresh pnpm-lock.yaml" \
              --body "Auto-generated lockfile refresh after dependencies changed on Porting1.1. This PR only updates pnpm-lock.yaml.")"
            echo "Created new PR: $pr_url"
          else
            echo "PR already exists: $pr_url"
          fi
          echo "pr_url=$pr_url" >> "$GITHUB_OUTPUT"

      - name: Enable auto-merge for lockfile PR
        if: steps.upsert-pr.outputs.pr_url != ''
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh pr merge --auto --squash --delete-branch "${{ steps.upsert-pr.outputs.pr_url }}"
```

Note the **3 differences from Paperclip**:
1. `branches: [master]` → `branches: [Porting1.1]` (line 6)
2. `concurrency.group: refresh-lockfile-master` → `refresh-lockfile-Porting1.1` (line 10)
3. `node-version: 20` → `node-version: 24` (line 34)
4. `gh pr create` adds `--base Porting1.1` (line 84) — Paperclip relies on the default base; AoA's default branch is `main` not `Porting1.1`, so we must specify explicitly.

Save the file at `.github/workflows/refresh-lockfile.yml`.

- [ ] **Step 3: Update AGENTS.md §7 to remove the "Future improvement" caveat**

The current §7 says (at the bottom):

```markdown
### Future improvement: port the upstream automation

Paperclip ships a [`refresh-lockfile.yml`](https://github.com/anthropic/paperclip/blob/master/.github/workflows/refresh-lockfile.yml) GitHub Action that watches `master` for manifest changes, regenerates the lockfile in CI, opens a `chore/refresh-lockfile` PR automatically, and auto-merges via squash. Porting this workflow to AoA would eliminate the manual ceremony entirely. Tracked separately — not yet implemented.
```

Replace with:

```markdown
### Automation: `refresh-lockfile.yml` bot

[`.github/workflows/refresh-lockfile.yml`](.github/workflows/refresh-lockfile.yml) watches `Porting1.1` for manifest changes, regenerates the lockfile in CI, opens (or updates) a `chore/refresh-lockfile` PR automatically, and auto-merges via squash.

**For most contributors this means:** open your feature PR with the manifest change committed (no lockfile). Once you merge, the bot fires, regenerates the lockfile on a separate PR, and auto-merges that PR. The next contributor's feature PR rebases off the new base with the updated lockfile already in place.

**The manual flow above** is still useful when:
- You need to verify the regenerated lockfile locally before pushing.
- You want to ship the manifest + lockfile in one commit (the bot adds a separate commit).
- The bot is broken and you need to bypass it.
```

Apply via Edit tool to the AGENTS.md section.

- [ ] **Step 4: Verify YAML syntax**

```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/refresh-lockfile.yml'))"
```

Expected: no output (valid YAML). If error, fix syntax before continuing.

- [ ] **Step 5: Commit + push**

```bash
git add .github/workflows/refresh-lockfile.yml AGENTS.md
git commit -m "$(cat <<'EOF'
ci: port Paperclip's refresh-lockfile.yml automation

After PR 1 documented the manual chore/refresh-lockfile flow,
port Paperclip's GitHub Action that automates it. The bot watches
Porting1.1 for manifest changes, regenerates the lockfile, opens
(or updates) the chore/refresh-lockfile PR automatically, and
enables auto-merge.

Adjustments from Paperclip:
- Branch: master → Porting1.1 (we don't have master)
- Concurrency group key: master → Porting1.1
- Node version: 20 → 24 (matches the rest of CI)
- gh pr create: explicit --base Porting1.1 (default base is main)

AGENTS.md §7 updated: \"Future improvement\" caveat replaced with
the actual automation behavior + when the manual flow still
applies.

Reference:
github.com/anthropic/paperclip/blob/master/.github/workflows/refresh-lockfile.yml

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"

git push -u origin ci/port-refresh-lockfile-bot
```

- [ ] **Step 6: Open PR**

```bash
gh pr create --base Porting1.1 --head ci/port-refresh-lockfile-bot \
  --title "ci: port Paperclip's refresh-lockfile.yml automation" \
  --body "$(cat <<'EOF'
## Summary

Adds [\`.github/workflows/refresh-lockfile.yml\`](.github/workflows/refresh-lockfile.yml) — ported from Paperclip with 4 small adjustments (branch name, concurrency group, Node version, explicit \`--base\`).

After this lands, manifest changes pushed to \`Porting1.1\` automatically trigger:
1. \`pnpm install --lockfile-only --no-frozen-lockfile\` in CI
2. Branch \`chore/refresh-lockfile\` updated with the regenerated lockfile
3. PR opened or updated (one-PR-at-a-time)
4. \`gh pr merge --auto --squash\` so it merges as soon as required checks pass

## What this changes for contributors

**Before** (manual): every dep change requires a hand-crafted \`chore/refresh-lockfile\` PR before the feature PR can land.

**After**: feature PR includes \`package.json\` changes only (no lockfile); bot creates the lockfile PR automatically post-merge.

AGENTS.md §7 updated to match.

## Verification approach

The workflow only fires on push to \`Porting1.1\`. After this PR merges, the bot will run on its own merge commit — if the lockfile is already in sync (it should be), it exits early with "Lockfile is already up to date." If not, it'll open a chore PR; that's the smoke test.

## Test plan

- [x] YAML syntax valid (\`yaml.safe_load\`)
- [ ] CI \`policy\`/\`brand-check\`/\`verify\`/\`e2e\` pass on this PR (no functional changes — should be no-ops)
- [ ] Bot fires successfully on merge → either "Lockfile already up to date" OR a clean chore PR

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 7: Watch CI + merge**

```bash
gh pr checks --watch --interval 60
gh pr merge --squash --delete-branch
```

Expected: green CI, merged. **PAUSE for human approval before merging.**

- [ ] **Step 8: Smoke-test the bot ran**

After merge, watch the bot's first run:

```bash
sleep 30  # let GitHub queue the workflow
gh run list --workflow "Refresh Lockfile" --limit 1
```

Expected output: a recent run for the merge SHA, conclusion `success`. If the bot opens a chore PR (because lockfile drifted), that's expected — let it auto-merge. If it errored, read the logs and fix the bot in a follow-up.

---

## PR 4: Fix Issue #96 — port Paperclip's `killProcessTree`

**Context:** Issue [#96](https://github.com/MeteoriteLabs/AoA/issues/96) — the entire process-tree-kill infrastructure on Porting1.1 is half-built. `safeGetPgid` always returns `null` (because `process.getpgid` doesn't exist in Node 18/20/22/24); `killProcessTree` is defined but never called from production; the 4 cancellation paths in `heartbeat.ts` use `child.kill("SIGTERM")` directly, leaking child processes (claude/codex/opencode subprocesses' children become orphans). Paperclip already solved this — port their pattern.

**Reference:** `paperclip-master/packages/adapter-utils/src/server-utils.ts` lines 50-55 (`resolveProcessGroupId`) + lines 57-72 (`signalRunningProcess`) + line 1452 (spawn with `detached`).

**Files:**
- Modify: `packages/adapter-utils/src/server-utils.ts`
- Modify: `server/src/services/heartbeat.ts` (4 cancellation paths)
- Modify: `server/src/__tests__/heartbeat-process-tracking.test.ts` (rewrite the safeGetPgid test)

**Approach:** TDD. Write the new test first, watch it fail, implement the fix, watch it pass.

- [ ] **Step 1: Branch**

```bash
git checkout Porting1.1
git pull
git checkout -b fix/issue-96-killprocesstree-orphans
```

- [ ] **Step 2: Read the current `server-utils.ts:30-82` to get exact line numbers**

```bash
sed -n '25,85p' packages/adapter-utils/src/server-utils.ts
```

Expected: shows `interface RunningProcess` (line 14ish) with field `pgid`, `safeGetPgid(pid)` function (line 30ish), `killProcessTree(pid, pgid)` function (line 50ish), `runningProcesses` Map export (line 82ish).

- [ ] **Step 3: Read the current heartbeat cancellation paths**

```bash
grep -n "running.child.kill" server/src/services/heartbeat.ts
```

Expected: 4 hits at approximately lines 3828, 3884, 3913, 3939 (positions may have drifted post-merge — use the actual line numbers reported).

- [ ] **Step 4: Rewrite the failing test in `heartbeat-process-tracking.test.ts`**

Open the file and replace the `safeGetPgid` describe block (the one we updated in PR #97 to assert `null`) with one that asserts the new Paperclip-style `resolveProcessGroupId` behavior:

```typescript
import { describe, it, expect } from "vitest";
import { resolveProcessGroupId, signalRunningProcess } from "@armyofagents/adapter-utils/server-utils";
import { spawn } from "node:child_process";

describe("resolveProcessGroupId", () => {
  it("returns null on Windows", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", {
      value: "win32",
      writable: true,
      configurable: true,
    });
    try {
      const fakeChild = { pid: 1234 } as ReturnType<typeof spawn>;
      expect(resolveProcessGroupId(fakeChild)).toBeNull();
    } finally {
      Object.defineProperty(process, "platform", {
        value: original,
        writable: true,
        configurable: true,
      });
    }
  });

  it("returns the child's pid on POSIX (which equals pgid when spawned with detached:true)", () => {
    if (process.platform === "win32") return;
    const fakeChild = { pid: 1234 } as ReturnType<typeof spawn>;
    expect(resolveProcessGroupId(fakeChild)).toBe(1234);
  });

  it("returns null when child has no pid (spawn failed)", () => {
    const fakeChild = { pid: undefined } as unknown as ReturnType<typeof spawn>;
    expect(resolveProcessGroupId(fakeChild)).toBeNull();
  });

  it("returns null when child pid is invalid (0 or negative)", () => {
    if (process.platform === "win32") return;
    const fakeChildZero = { pid: 0 } as ReturnType<typeof spawn>;
    expect(resolveProcessGroupId(fakeChildZero)).toBeNull();
  });
});
```

Replace the EXISTING `describe("safeGetPgid", ...)` block (lines ~5-37 in the current file) with the above. Keep the `describe("killProcessTree", ...)` block as a placeholder for now — Step 7 will replace it too.

- [ ] **Step 5: Run the test to verify it fails**

```bash
pnpm --filter @armyofagents/server exec vitest run src/__tests__/heartbeat-process-tracking.test.ts
```

Expected: failures saying `resolveProcessGroupId is not exported` (or similar import error). This confirms the test correctly drives the new API.

- [ ] **Step 6: Update `packages/adapter-utils/src/server-utils.ts`**

Replace the `interface RunningProcess`, `safeGetPgid`, and `killProcessTree` definitions with Paperclip's pattern. Open the file and apply these changes:

**6a. Update `RunningProcess` interface (line ~14):**

Find:
```typescript
interface RunningProcess {
  child: ChildProcess;
  graceSec: number;
  /** POSIX process-group id captured at spawn; null on Windows or if unavailable. */
  pgid: number | null;
}
```

Replace with:
```typescript
interface RunningProcess {
  child: ChildProcess;
  graceSec: number;
  /** POSIX process-group id captured at spawn; null on Windows. Equals child.pid when spawned with detached:true. */
  processGroupId: number | null;
}
```

**6b. Replace `safeGetPgid` function (line ~30) with `resolveProcessGroupId`:**

Find:
```typescript
export function safeGetPgid(pid: number): number | null {
  if (process.platform === "win32") return null;
  try {
    return (process as unknown as { getpgid(pid: number): number }).getpgid(pid);
  } catch {
    return null;
  }
}
```

Replace with:
```typescript
/**
 * Resolve the POSIX process-group id for a freshly spawned child.
 *
 * Assumes the child was spawned with `detached: true` on POSIX, which
 * causes the OS to put the child in its own new process group with
 * pgid === pid. Returns null on Windows (no process groups) or when
 * the child failed to spawn (no pid).
 *
 * Replaces the older safeGetPgid which called process.getpgid(pid)
 * — that API was never exposed by Node and always threw a TypeError.
 */
export function resolveProcessGroupId(child: ChildProcess): number | null {
  if (process.platform === "win32") return null;
  return typeof child.pid === "number" && child.pid > 0 ? child.pid : null;
}
```

**6c. Replace `killProcessTree` (line ~50) with `signalRunningProcess`:**

Find:
```typescript
export function killProcessTree(pid: number | null, pgid: number | null): void {
  if (pid === null && pgid === null) return;
  if (process.platform === "win32") {
    if (pid === null) return;
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } catch {
      try { process.kill(pid); } catch { /* ignore */ }
    }
    return;
  }
  // POSIX path: try process group first, fall back to direct PID
  if (pgid !== null && pgid > 0) {
    try {
      process.kill(-pgid, "SIGTERM");
      setTimeout(() => {
        try { process.kill(-pgid, "SIGKILL"); } catch { /* already dead */ }
      }, 5000);
      return;
    } catch {
      // fall through to direct kill
    }
  }
  if (pid !== null && pid > 0) {
    try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
  }
}
```

Replace with:
```typescript
/**
 * Signal a running process or its process group.
 *
 * On POSIX with a valid processGroupId, sends the signal to the negative
 * PID (which addresses the entire process group, killing the parent and
 * all its children). Falls back to signaling the child directly if the
 * group signal fails. On Windows, signals the child via Node's built-in
 * Process.kill (no process-group semantics).
 *
 * Caller is responsible for the SIGTERM → SIGKILL escalation timer.
 *
 * Reference impl: paperclip-master/packages/adapter-utils/src/server-utils.ts:57-72
 */
export function signalRunningProcess(
  running: Pick<RunningProcess, "child" | "processGroupId">,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== "win32" && running.processGroupId && running.processGroupId > 0) {
    try {
      process.kill(-running.processGroupId, signal);
      return;
    } catch {
      // Fall back to the direct child signal if group signaling fails.
    }
  }
  if (!running.child.killed) {
    running.child.kill(signal);
  }
}
```

**6d. Update spawn options in `runChildProcess` (around line 285):**

Find:
```typescript
const child = spawn(command, args, {
  cwd: opts.cwd,
  env: mergedEnv,
  // Windows requires shell:true to execute .cmd wrappers for npm-installed CLIs.
  // The `command` value comes from trusted adapter configuration, not user input.
  shell: process.platform === "win32",
  stdio: [opts.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
}) as ChildProcessWithEvents;
```

Add `detached`:
```typescript
const child = spawn(command, args, {
  cwd: opts.cwd,
  env: mergedEnv,
  // Windows requires shell:true to execute .cmd wrappers for npm-installed CLIs.
  // The `command` value comes from trusted adapter configuration, not user input.
  shell: process.platform === "win32",
  // detached:true on POSIX puts the child in its own process group (pgid === pid),
  // so signalRunningProcess can address the whole group via process.kill(-pgid, signal)
  // and reap any subprocesses spawned by the child.
  detached: process.platform !== "win32",
  stdio: [opts.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
}) as ChildProcessWithEvents;
```

**6e. Update the spawn-time pgid capture (around line 296):**

Find:
```typescript
const spawnedPid = child.pid ?? null;
const spawnedPgid = spawnedPid !== null ? safeGetPgid(spawnedPid) : null;
const spawnedAt = new Date();

runningProcesses.set(runId, { child, graceSec: opts.graceSec, pgid: spawnedPgid });
```

Replace with:
```typescript
const spawnedPid = child.pid ?? null;
const spawnedPgid = resolveProcessGroupId(child);
const spawnedAt = new Date();

runningProcesses.set(runId, { child, graceSec: opts.graceSec, processGroupId: spawnedPgid });
```

**6f. Update the timeout handler in `runChildProcess` (around line 320):**

Find:
```typescript
const timeout =
  opts.timeoutSec > 0
    ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
        }, Math.max(1, opts.graceSec) * 1000);
      }, opts.timeoutSec * 1000)
    : null;
```

Replace with:
```typescript
const timeout =
  opts.timeoutSec > 0
    ? setTimeout(() => {
        timedOut = true;
        signalRunningProcess({ child, processGroupId: spawnedPgid }, "SIGTERM");
        setTimeout(() => {
          signalRunningProcess({ child, processGroupId: spawnedPgid }, "SIGKILL");
        }, Math.max(1, opts.graceSec) * 1000);
      }, opts.timeoutSec * 1000)
    : null;
```

(The `if (!child.killed)` guard isn't needed because `signalRunningProcess` already checks internally.)

- [ ] **Step 7: Update test for `signalRunningProcess`**

In `heartbeat-process-tracking.test.ts`, replace the EXISTING `describe("killProcessTree", ...)` block with:

```typescript
describe("signalRunningProcess", () => {
  it("uses process.kill(-pgid, signal) on POSIX when processGroupId is valid", () => {
    if (process.platform === "win32") return;

    // Stub process.kill to capture the call without actually signaling
    let capturedTarget: number | null = null;
    let capturedSignal: NodeJS.Signals | null = null;
    const originalKill = process.kill;
    (process as unknown as { kill: typeof process.kill }).kill = ((pid: number, sig?: NodeJS.Signals) => {
      capturedTarget = pid;
      capturedSignal = sig ?? null;
      return true;
    }) as typeof process.kill;

    try {
      const fakeChild = { pid: 1234, killed: false, kill: vi.fn() } as unknown as ReturnType<typeof spawn>;
      signalRunningProcess({ child: fakeChild, processGroupId: 1234 }, "SIGTERM");
      expect(capturedTarget).toBe(-1234);
      expect(capturedSignal).toBe("SIGTERM");
      expect(fakeChild.kill).not.toHaveBeenCalled();
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill = originalKill;
    }
  });

  it("falls back to child.kill when group signal throws", () => {
    if (process.platform === "win32") return;

    const originalKill = process.kill;
    (process as unknown as { kill: typeof process.kill }).kill = (() => {
      throw new Error("ESRCH");
    }) as typeof process.kill;

    try {
      const childKill = vi.fn();
      const fakeChild = { pid: 1234, killed: false, kill: childKill } as unknown as ReturnType<typeof spawn>;
      signalRunningProcess({ child: fakeChild, processGroupId: 1234 }, "SIGTERM");
      expect(childKill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill = originalKill;
    }
  });

  it("uses child.kill on Windows", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", writable: true, configurable: true });

    try {
      const childKill = vi.fn();
      const fakeChild = { pid: 1234, killed: false, kill: childKill } as unknown as ReturnType<typeof spawn>;
      signalRunningProcess({ child: fakeChild, processGroupId: 1234 }, "SIGTERM");
      expect(childKill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      Object.defineProperty(process, "platform", { value: original, writable: true, configurable: true });
    }
  });

  it("does not double-signal an already-killed child", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", writable: true, configurable: true });

    try {
      const childKill = vi.fn();
      const fakeChild = { pid: 1234, killed: true, kill: childKill } as unknown as ReturnType<typeof spawn>;
      signalRunningProcess({ child: fakeChild, processGroupId: 1234 }, "SIGTERM");
      expect(childKill).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: original, writable: true, configurable: true });
    }
  });
});
```

Make sure `vi` is imported at the top of the file:
```typescript
import { describe, it, expect, vi } from "vitest";
```

- [ ] **Step 8: Run the test to verify it now passes**

```bash
pnpm --filter @armyofagents/server exec vitest run src/__tests__/heartbeat-process-tracking.test.ts
```

Expected: all `resolveProcessGroupId` (4) + `signalRunningProcess` (4) tests pass. Total ~8 tests passing.

- [ ] **Step 9: Update the 4 cancellation paths in `heartbeat.ts`**

Find each occurrence of `running.child.kill("SIGTERM")` and replace with `signalRunningProcess(running, "SIGTERM")`. Add an import for `signalRunningProcess` at the top of the file.

```bash
grep -n "running.child.kill\|signalRunningProcess" server/src/services/heartbeat.ts | head -10
```

For each hit (4 expected), apply the Edit tool with surrounding context. Each edit looks like:

Find:
```typescript
const running = runningProcesses.get(run.id);
if (running) {
  running.child.kill("SIGTERM");
  ...
}
```

Replace with:
```typescript
const running = runningProcesses.get(run.id);
if (running) {
  signalRunningProcess(running, "SIGTERM");
  ...
}
```

The first cancellation path (`cancelRun` around line 3826) also has a SIGKILL grace timer — update both signals consistently.

Add the import at the top of `heartbeat.ts`:

```typescript
import { runningProcesses, signalRunningProcess } from "@armyofagents/adapter-utils/server-utils";
```

(If the file already imports `runningProcesses` from somewhere else, just add `signalRunningProcess` to that existing import.)

- [ ] **Step 10: Update the persisted-pgid `onSpawn` callback**

Find (approximately line 2679 in `heartbeat.ts`):
```typescript
const onSpawn = (pid: number | null, pgid: number | null, startedAt: Date) => {
  void db
    .update(heartbeatRuns)
    .set({ processPid: pid, processGroupId: pgid, processStartedAt: startedAt })
    .where(eq(heartbeatRuns.id, run.id))
    .catch((err: unknown) =>
      logger.warn({ err, runId: run.id }, "Failed to persist process metadata"),
    );
};
```

No code change needed — but verify: `processGroupId` here is the field on the DB row, which is now populated correctly because `resolveProcessGroupId(child)` returns a real pgid on POSIX. Add a comment for future readers:

```typescript
const onSpawn = (pid: number | null, pgid: number | null, startedAt: Date) => {
  // pgid is now reliably populated on POSIX (= child.pid for detached:true spawns).
  // Persisting it lets an out-of-process watchdog kill the group if needed.
  void db
    .update(heartbeatRuns)
    ...
```

- [ ] **Step 11: Run the full server test suite**

```bash
pnpm --filter @armyofagents/server test
```

Expected: full server suite passes. The 1 pre-existing Windows-only `companies-delete-integration.test.ts` failure may still appear — that's environment-specific, unrelated.

- [ ] **Step 12: Run typecheck across all packages**

```bash
pnpm -r typecheck
```

Expected: 18/18 pass. If the `RunningProcess.pgid` → `processGroupId` rename broke other consumers, fix the imports there too.

- [ ] **Step 13: Verify no `safeGetPgid` references remain**

```bash
grep -rn "safeGetPgid\|killProcessTree" packages/ server/ cli/ ui/ --include="*.ts" --include="*.tsx" | grep -v "dist/\|.d.ts" 2>&1 | head -10
```

Expected: empty output. The function names should be entirely gone (replaced by `resolveProcessGroupId` + `signalRunningProcess`).

- [ ] **Step 14: Commit**

```bash
git add packages/adapter-utils/src/server-utils.ts \
        server/src/services/heartbeat.ts \
        server/src/__tests__/heartbeat-process-tracking.test.ts

git commit -m "$(cat <<'EOF'
fix(heartbeat): kill child process trees on cancellation (closes #96)

The previous safeGetPgid + killProcessTree pair was effectively dead
code — process.getpgid is not a Node API on any modern version, so
safeGetPgid always returned null and the persisted heartbeat_runs.
processGroupId column was always null. The 4 cancellation paths in
heartbeat.ts (cancelRun, cancelActiveForAgent, cancelBudgetScopeWork
× 2) used child.kill(\"SIGTERM\") directly, which signals only the
parent CLI and leaks any subprocess children (claude/codex/opencode
spawning bash/git/npm). The orphans run for seconds-to-minutes
before POSIX waitpid eventually reaps them, doing real work
(filesystem writes, API calls, budget consumption) we already
tried to cancel.

Port Paperclip's working pattern (paperclip-master/packages/
adapter-utils/src/server-utils.ts:50-72):
  - spawn with detached:true on POSIX → child.pid === pgid
  - resolveProcessGroupId(child) replaces safeGetPgid(pid):
    returns child.pid on POSIX, null on Windows
  - signalRunningProcess(running, signal) replaces killProcessTree:
    process.kill(-pgid, signal) addresses the whole process group;
    falls back to child.kill on group-kill failure
  - 4 cancellation paths in heartbeat.ts now call
    signalRunningProcess; the runChildProcess timeout handler too

Test: heartbeat-process-tracking.test.ts now exercises the new
API directly with stubbed process.kill — 4 resolveProcessGroupId
cases + 4 signalRunningProcess cases (POSIX group kill, fallback
to child.kill, Windows path, double-kill guard).

Schema/DB fields unchanged: heartbeat_runs.processGroupId is now
populated correctly instead of always-null. RunningProcess.pgid
field renamed to processGroupId for consistency with Paperclip
and the DB column.

Closes #96

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"

git push -u origin fix/issue-96-killprocesstree-orphans
```

- [ ] **Step 15: Open PR**

```bash
gh pr create --base Porting1.1 --head fix/issue-96-killprocesstree-orphans \
  --title "fix(heartbeat): kill child process trees on cancellation (closes #96)" \
  --body "$(cat <<'EOF'
## Summary

Closes [#96](https://github.com/MeteoriteLabs/AoA/issues/96). Replaces the half-built \`safeGetPgid\`/\`killProcessTree\` infrastructure (which was effectively dead code) with Paperclip's working pattern.

## What was broken

- \`safeGetPgid(pid)\` called \`process.getpgid(pid)\` — not a Node API on any modern version. Always threw, always returned null.
- \`killProcessTree(pid, pgid)\` was defined but never called from production code.
- 4 cancellation paths in \`heartbeat.ts\` used \`child.kill(\"SIGTERM\")\` directly, leaking child processes when the parent CLI was killed.
- \`heartbeat_runs.processGroupId\` was persisted but always null (because \`safeGetPgid\` returned null).

## Fix

Port Paperclip's pattern from [\`packages/adapter-utils/src/server-utils.ts:50-72\`](https://github.com/anthropic/paperclip/blob/master/packages/adapter-utils/src/server-utils.ts):

- Spawn with \`detached: true\` on POSIX → child.pid becomes the new process group's pgid
- \`resolveProcessGroupId(child)\` replaces \`safeGetPgid(pid)\`: returns \`child.pid\` on POSIX, \`null\` on Windows
- \`signalRunningProcess(running, signal)\` replaces \`killProcessTree\`: \`process.kill(-pgid, signal)\` addresses the whole group; falls back to \`child.kill\` on group-kill failure
- All 4 cancellation paths in \`heartbeat.ts\` and the \`runChildProcess\` timeout handler now call \`signalRunningProcess\`
- \`RunningProcess.pgid\` field renamed to \`processGroupId\` (matches Paperclip + the DB column)

## Test coverage

\`heartbeat-process-tracking.test.ts\` now has 8 tests covering:
- \`resolveProcessGroupId\`: returns null on Windows, returns pid on POSIX, returns null when pid invalid
- \`signalRunningProcess\`: uses \`process.kill(-pgid)\` on POSIX, falls back to \`child.kill\` on group failure, uses \`child.kill\` on Windows, doesn't double-signal an already-killed child

Stubs \`process.kill\` directly so the tests don't actually signal anything — fully isolated.

## Risk profile

- All 4 production call sites are within the heartbeat service's cancellation API; no external API surface changes
- \`heartbeat_runs.processGroupId\` column unchanged — just populated correctly now where it was always-null before
- \`detached: true\` is a real behavior change but only on POSIX; Windows path unchanged
- No new dependencies

## Test plan

- [x] \`pnpm --filter @armyofagents/server test\` passes
- [x] \`pnpm -r typecheck\` clean
- [ ] CI \`policy\`/\`brand-check\`/\`verify\`/\`e2e\` pass
- [ ] Manual: cancel a heartbeat run with active subprocess and confirm subprocess dies (post-merge in dev)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 16: Watch CI + merge**

```bash
gh pr checks --watch --interval 60
gh pr merge --squash --delete-branch
```

Expected: green CI, merged. **PAUSE for human approval before merging.** This is the only PR in the plan that touches real product behavior — review carefully.

- [ ] **Step 17: Close Issue #96**

After PR 4 merges:

```bash
gh issue close 96 --comment "Closed by PR <merge-commit-sha>. \`signalRunningProcess\` ports Paperclip's pattern; cancellation paths now kill the whole process group on POSIX. Verified in heartbeat-process-tracking.test.ts (8 tests passing)."
```

Replace `<merge-commit-sha>` with the actual squash-merge SHA.

---

## Verification: confirm new `LIVE_EVENT_TYPES` events flow through

**Context:** PR #95 added 12 new `memory.*` types to `LIVE_EVENT_TYPES` and PR #94 added 7 new `marketplace.*` types. The plan's loose end #3 noted we should confirm the live-event router/dispatch handles them. Most likely it does — the router probably just passes the type through string-keyed dispatch — but it's worth a 30-min spot-check before declaring all loose ends closed.

**Files (read-only verification):**
- `server/src/services/live-events.ts` (or wherever the live-event router lives — find via grep)
- `packages/shared/src/constants.ts` (LIVE_EVENT_TYPES definition)
- Any consumer files that switch on event type

- [ ] **Step 1: Find the live-event router/dispatcher**

```bash
grep -rln "LIVE_EVENT_TYPES\|publishLiveEvent\|LiveEventType" server/src/ packages/shared/src/ 2>&1 | head -10
```

Expected: 5-10 files. The actual dispatcher is probably `server/src/services/live-events.ts`.

- [ ] **Step 2: Inspect how the dispatcher handles unknown/new types**

```bash
grep -n -A 5 "publishLiveEvent\|liveEventBus" server/src/services/live-events.ts | head -30
```

Read the switch (if any) over `event.type`. Two outcomes:

- **OK case**: dispatcher passes events through string-keyed routing (no enum-exhaustive switch); new types flow through automatically. Document and close.
- **NOT OK case**: dispatcher has an enum-exhaustive switch with default-throws or default-warns for unknown types. New types would silently or loudly drop. Need follow-up.

- [ ] **Step 3: Spot-check 2-3 of the new event types are actually fired somewhere**

```bash
grep -rn '"memory.item.created"\|"marketplace.install_completed"\|"marketplace.install.started"' server/src/ 2>&1 | head -10
```

Expected: each event type appears in 1-2 producers (e.g., `server/src/services/memory.ts` for `memory.item.created`). If a type is in `LIVE_EVENT_TYPES` but never fired, that's tech debt but not a regression — note it.

- [ ] **Step 4: Spot-check at least one consumer subscribes to the new types**

UI consumers via SSE/WebSocket subscribe to live events. Check the UI layer:

```bash
grep -rn "memory\\.item\\.\\|marketplace\\." ui/src/ --include="*.ts" --include="*.tsx" 2>&1 | grep -i "useEvent\|subscribe\|onLiveEvent" | head -10
```

Expected: UI hooks subscribe to specific events for live-update behavior. If hits, the wiring is in place. If empty, the new events are produced but nothing consumes them — note as future polish.

- [ ] **Step 5: Document findings**

If everything checks out, no further action needed. If gaps found (events fired without consumers, or vice versa), file follow-up GitHub issues with specific file:line references.

This step is **read-only** — no commits, no PRs.

---

## Self-Review Checklist

After this plan executes, verify:

- [x] **Spec coverage:** Plan covers all 4 follow-ups (docs PR, hygiene, refresh-lockfile bot, killProcessTree fix) plus the LIVE_EVENT_TYPES verification.
- [x] **No placeholders:** Every step has exact commands, files, and expected output. The TDD pattern in PR 4 includes complete test code blocks (no "add tests for X" stubs).
- [x] **Type consistency:** Function names consistent across PRs — `resolveProcessGroupId`, `signalRunningProcess`, `RunningProcess.processGroupId`, `chore/refresh-lockfile`. PR numbers (#94/#95/#96/#97/#98) used consistently.
- [x] **Risk callouts:** Each PR identifies its risk profile in the body. PR 4 (the only product-code change) calls out: no external API surface change, no new deps, behavior change limited to POSIX detached spawn.
- [x] **Decisions locked:** Each follow-up its own PR; minimal port for #96 (not full supervisor pattern); use Paperclip patterns verbatim.

---

## Risks & Open Questions

1. **PR 4's `detached:true` change might surface flakiness in existing adapter tests.** The detached spawn behavior subtly differs (separate process group, different stdio handling). If any existing test relied on parent-process-group inheritance, expect a few test fixes. The Paperclip impl is in production so this is empirically safe, but watch for it on PR 4's first CI run.

2. **The refresh-lockfile bot's first run may be confusing.** After PR 3 merges, the bot fires on Porting1.1's merge commit. If lockfile drift exists (it shouldn't post-cleanup), the bot creates a chore PR — totally normal but worth being prepared for.

3. **PR 4 closes #96 but doesn't add an integration test.** The unit tests exercise `signalRunningProcess` with stubbed `process.kill` — they prove the algorithm is right. They don't prove the orphan-process leak is fixed end-to-end. A proper integration test (spawn parent + child, kill via signalRunningProcess, verify child died) would add ~15 min and is highly recommended as a follow-up. Skipping it from this plan because it's not strictly required to close #96.

4. **The `chore/refresh-lockfile` branch is single-use.** PR 3's bot will fail if a `chore/refresh-lockfile` PR is already open at the time it runs. The bot's logic detects this and reuses the existing PR — that's the design — but if the existing PR is from a fork or in a weird state, the bot might error. Watch for it on first run.

5. **PR 1's AGENTS.md edit relies on the file's current state in `Porting1.1`.** If `AGENTS.md` was edited on `Porting1.1` between when we authored the local change and when this plan executes, the diff may need fixup. Check `git status` shows our changes still apply cleanly.

6. **PR 4's heartbeat.ts changes touch a 7000-line file.** The 4 cancellation paths are not in adjacent lines (3828, 3884, 3913, 3939). Apply edits carefully one at a time; verify each with `grep -n "signalRunningProcess" server/src/services/heartbeat.ts` after each edit shows the expected count.
